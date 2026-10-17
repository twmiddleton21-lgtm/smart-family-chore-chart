import path from 'node:path';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { safeEqual } from './auth/crypto';
import { AuthService, publicSessionId, type AuthContext, type AuthError } from './auth/service';
import type { ServerConfig } from './config';
import { createBackup } from './db/backup';
import type { SqlDatabase } from './db/database';
import { currentSchemaVersion, LATEST_SCHEMA_VERSION } from './db/migrations';
import { COMMAND_TYPES, type Command, type CommandType } from './family/commands';
import { buildExportFile, parseImport } from './family/importer';
import type { FamilyStore } from './family/store';

// HTTP API.
//
// NORMAL MODE (default): every family-data route requires a signed-in parent
// or a paired household device (session cookies, see server/auth). Paired
// devices may only view and run DEVICE_COMMANDS; everything else needs a
// parent. State-changing requests must not come from another site (Origin /
// Sec-Fetch-Site check, plus SameSite=Strict cookies and JSON-only bodies).
//
// DEVELOPMENT MODE (explicit, see config.ts): no authentication at all, only
// for loopback clients with a loopback Host header (anti DNS-rebinding) and
// loopback Origin. Refused outside development and on non-loopback hosts.

export interface AppDeps {
  config: Pick<ServerConfig, 'devUnauthenticatedApi' | 'bodyLimit' | 'timeZone' | 'port' | 'dataDir'> &
    Partial<Pick<ServerConfig, 'cookieSecure' | 'trustProxy'>>;
  db: SqlDatabase;
  store: FamilyStore;
  /** Required in normal mode (fails closed without it). */
  auth?: AuthService;
  logger?: FastifyServerOptions['logger'];
}

/** What a paired device may do without a parent signed in. */
export const DEVICE_COMMANDS: ReadonlySet<CommandType> = new Set(['toggleChore', 'redeemReward', 'dismissMealReminder']);

export const PARENT_COOKIE = 'sfcc_parent';
export const DEVICE_COOKIE = 'sfcc_device';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopbackClient(request: FastifyRequest): boolean {
  return LOOPBACK_ADDRESSES.has(request.socket.remoteAddress ?? '');
}

/** Host headers accepted in development mode: loopback names on our port only. */
export function loopbackHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

/** No Origin (non-browser client) is fine; otherwise it must be a loopback origin. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  return origin === undefined || LOOPBACK_ORIGIN.test(origin.toLowerCase());
}

/**
 * True if a request was sent by a page on another site. Browsers send
 * Origin (and Sec-Fetch-Site) on POSTs; non-browser clients may send
 * neither, which is fine (they can't ride on a victim's cookies).
 */
export function isCrossSite(request: FastifyRequest): boolean {
  const site = request.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return true;
  const origin = request.headers.origin;
  if (origin === undefined) return false;
  try {
    const o = new URL(origin);
    // Parse Host with the Origin's scheme so default ports compare equal
    // ("localhost:80" vs "http://localhost").
    return o.host !== new URL(`${o.protocol}//${request.headers.host ?? ''}`).host;
  } catch {
    return true; // "null" or malformed
  }
}

const commandBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'payload'],
  properties: {
    type: { type: 'string', enum: [...COMMAND_TYPES] },
    payload: { type: 'object' },
    expectedVersion: { type: 'integer', minimum: 0 },
  },
} as const;

/** Imports can be larger than ordinary commands (a year of history). */
export const IMPORT_BODY_LIMIT = 5 * 1024 * 1024;

const importPreviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: { data: { type: 'object' } },
} as const;

const importApplySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'checksum', 'expectedStateVersion', 'replace'],
  properties: {
    data: { type: 'object' },
    checksum: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    expectedStateVersion: { type: 'integer', minimum: 1 },
    replace: { type: 'boolean' },
  },
} as const;

const str = (max: number) => ({ type: 'string', maxLength: max }) as const;
const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' } },
} as const;
const body = (required: string[], properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required, properties }) as const;

const UNAUTHENTICATED = { error: 'unauthenticated', message: 'Please sign in or pair this device.' };
const PARENT_REQUIRED = { error: 'parent_required', message: 'A parent needs to sign in for this.' };

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook in normal mode; null in development mode. */
    authCtx: AuthContext | null;
  }
  interface FastifyInstance {
    /** Every registered route ("METHOD /path"), so tests can check access rules cover them all. */
    sfccRoutes: string[];
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, db, store } = deps;
  const dev = config.devUnauthenticatedApi;
  if (!dev && !deps.auth) throw new Error('Authentication is required in normal mode (refusing to start without it).');
  const auth = deps.auth;

  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: config.bodyLimit,
    // Only the configured reverse proxies (SFCC_TRUST_PROXY) are believed
    // about the client address and protocol; nobody by default.
    trustProxy: config.trustProxy?.length ? config.trustProxy : false,
    // Generic request ids; never derived from client input.
    requestIdHeader: false,
    // Strict validation: reject unknown fields and wrong types instead of
    // Fastify's defaults (silently removing extras / coercing "3" -> 3).
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });

  const routes: string[] = [];
  app.decorate('sfccRoutes', routes);
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) if (method !== 'HEAD') routes.push(`${method} ${route.url}`);
  });

  void app.register(cookie);
  app.decorateRequest('authCtx', null);

  // JSON only: drop the default text/plain parser so other content types get
  // 415. (This also means cross-site "simple" form posts cannot reach us.)
  app.removeContentTypeParser('text/plain');

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation) {
      return reply.status(400).send({ error: 'invalid_request', message: error.message });
    }
    if (error.statusCode === 413) return reply.status(413).send({ error: 'payload_too_large', message: 'Request body is too large.' });
    if (error.statusCode === 415) return reply.status(415).send({ error: 'unsupported_media_type', message: 'Use application/json.' });
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.status(error.statusCode).send({ error: 'bad_request', message: 'The request could not be processed.' });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'Something went wrong. Please try again.' });
  });

  app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: 'not_found', message: 'Not found.' }));

  // ---------- health (no family data) ----------

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (request, reply) => {
    try {
      db.get('SELECT 1 AS ok');
      const schemaVersion = currentSchemaVersion(db);
      if (schemaVersion !== LATEST_SCHEMA_VERSION) {
        return reply.status(503).send({ status: 'not_ready', reason: 'schema_mismatch' });
      }
      store.stateVersion();
      return { status: 'ready', schemaVersion };
    } catch (error) {
      request.log.error({ err: error }, 'readiness check failed');
      return reply.status(503).send({ status: 'not_ready', reason: 'database_unavailable' });
    }
  });

  // ---------- access control ----------

  if (dev) {
    // DEVELOPMENT ONLY: unauthenticated, loopback clients only. Applied to
    // EVERY request (not a URL-prefix check, so encoded paths cannot bypass it).
    const allowedHosts = loopbackHosts(config.port);
    app.addHook('onRequest', async (request, reply) => {
      reply.header('X-SFCC-Dev-Mode', 'unauthenticated-loopback-only');
      const host = (request.headers.host ?? '').toLowerCase();
      const origin = request.headers.origin;
      if (!isLoopbackClient(request) || !allowedHosts.has(host) || !isAllowedOrigin(origin)) {
        return reply.status(403).send({ error: 'forbidden', message: 'Development API is only available from this computer.' });
      }
    });
    app.get('/api/auth/status', async () => ({ devMode: true, setupRequired: false, parent: null, device: null, sessionId: null }));
  } else {
    // Cross-site check on EVERY state-changing request (not just /api paths,
    // so encoded paths cannot slip past a prefix check).
    app.addHook('onRequest', async (request, reply) => {
      if (request.method !== 'GET' && request.method !== 'HEAD' && isCrossSite(request)) {
        return reply.status(403).send({ error: 'cross_site_request', message: 'Requests from other websites are not allowed.' });
      }
    });
    // Cookies are parsed in onRequest (plugin), so authenticate in preParsing:
    // BEFORE the body is parsed or validated. Route guards below also run in
    // preParsing, so unauthenticated callers never get their body parsed and
    // never see validation errors that would describe the API.
    app.addHook('preParsing', async (request, _reply, payload) => {
      request.authCtx = auth!.authenticate(request.cookies[PARENT_COOKIE], request.cookies[DEVICE_COOKIE]);
      return payload;
    });
  }

  const ctxOf = (request: FastifyRequest): AuthContext => request.authCtx ?? { parent: null, device: null, parentSessionHash: null };

  // Route guards (preParsing: before the body is read; see above).
  type PreParsing = (request: FastifyRequest, reply: FastifyReply, payload: NodeJS.ReadableStream) => Promise<NodeJS.ReadableStream>;
  /** Paired device or signed-in parent. */
  const requireHousehold: PreParsing = async (request, reply, payload) => {
    if (dev) return payload;
    const c = ctxOf(request);
    if (!c.parent && !c.device) await reply.status(401).send(UNAUTHENTICATED);
    return payload;
  };
  /** Signed-in parent only. */
  const requireParent: PreParsing = async (request, reply, payload) => {
    if (dev) return payload;
    const c = ctxOf(request);
    if (!c.parent) await reply.status(c.device ? 403 : 401).send(c.device ? PARENT_REQUIRED : UNAUTHENTICATED);
    return payload;
  };
  const actorOf = (request: FastifyRequest): string => {
    if (dev) return 'dev-unauthenticated';
    const c = ctxOf(request);
    return c.parent ? `parent:${c.parent.id}` : `device:${c.device!.id}`;
  };

  const secureCookie = (request: FastifyRequest) =>
    config.cookieSecure === 'always' ? true : config.cookieSecure === 'never' ? false : request.protocol === 'https';
  const setSessionCookie = (request: FastifyRequest, reply: FastifyReply, name: string, token: string, maxAge: number | undefined) => {
    void reply.setCookie(name, token, { httpOnly: true, sameSite: 'strict', path: '/', secure: secureCookie(request), ...(maxAge ? { maxAge } : {}) });
  };
  const clearSessionCookie = (request: FastifyRequest, reply: FastifyReply, name: string) => {
    void reply.clearCookie(name, { httpOnly: true, sameSite: 'strict', path: '/', secure: secureCookie(request) });
  };
  const sendAuthError = (reply: FastifyReply, e: AuthError) => {
    if (e.retryAfter) void reply.header('Retry-After', String(e.retryAfter));
    return reply.status(e.status).send({ error: e.error, message: e.message, ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}) });
  };

  // ---------- authentication, accounts and devices (normal mode) ----------

  if (!dev && auth) {
    app.get('/api/auth/status', async (request) => {
      const c = ctxOf(request);
      const sessionId = c.parent && c.parentSessionHash ? publicSessionId(c.parentSessionHash) : null;
      return { devMode: false, setupRequired: auth.isSetupRequired(), parent: c.parent, device: c.device, sessionId };
    });

    app.post<{ Body: { setupCode: string; username: string; displayName: string; password: string } }>(
      '/api/auth/setup',
      { schema: { body: body(['setupCode', 'username', 'displayName', 'password'], { setupCode: str(64), username: str(64), displayName: str(80), password: str(256) }) } },
      async (request, reply) => {
        const r = await auth.completeSetup(request.body, request.ip);
        if (!r.ok) return sendAuthError(reply, r);
        setSessionCookie(request, reply, PARENT_COOKIE, r.token, AuthService.cookieMaxAge('parent', false));
        request.log.info({ parentId: r.parent.id }, 'first parent account created');
        return { parent: r.parent };
      },
    );

    app.post<{ Body: { username: string; password: string; remember?: boolean } }>(
      '/api/auth/login',
      { schema: { body: body(['username', 'password'], { username: str(64), password: str(256), remember: { type: 'boolean' } }) } },
      async (request, reply) => {
        const remember = request.body.remember === true;
        const r = await auth.login(request.body.username, request.body.password, remember, request.ip);
        if (!r.ok) return sendAuthError(reply, r);
        // Replace any older parent session held by this browser.
        auth.logout(request.cookies[PARENT_COOKIE]);
        setSessionCookie(request, reply, PARENT_COOKIE, r.token, AuthService.cookieMaxAge('parent', remember));
        return { parent: r.parent };
      },
    );

    // With `sessionId` (what the app sends): end that session only if it is
    // the one this request's cookie names, and never send a Set-Cookie. A
    // Set-Cookie applies to whatever cookie the browser holds when the answer
    // ARRIVES, which may by then be a newer session from signing in again in
    // another tab; clearing it would sign that tab out. Ending the session
    // here is what removes access; the browser keeps a dead token that is
    // ignored, and replaced at the next sign-in.
    //   ended          - it was this browser's session; now ended
    //   not_signed_in  - this browser holds no valid parent session (already ended or expired)
    //   replaced       - this browser now holds a different session (left alone)
    // Without `sessionId`: end whatever session the cookie names and clear the
    // cookie (plain API use; not used by the app).
    app.post<{ Body: unknown }>('/api/auth/logout', async (request, reply) => {
      // The body is optional, so it is checked here rather than by a schema.
      const raw = request.body;
      if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((k) => k !== 'sessionId'))) {
        return reply.status(400).send({ error: 'invalid_request', message: 'Unexpected sign-out request.' });
      }
      const target = (raw as { sessionId?: unknown } | null | undefined)?.sessionId;
      if (target !== undefined && (typeof target !== 'string' || !/^[0-9a-f]{64}$/.test(target))) {
        return reply.status(400).send({ error: 'invalid_request', message: 'Unexpected sign-out request.' });
      }
      if (target === undefined) {
        auth.logout(request.cookies[PARENT_COOKIE]);
        clearSessionCookie(request, reply, PARENT_COOKIE);
        return { ok: true };
      }
      const current = ctxOf(request).parentSessionHash;
      if (!current) return { ok: true, result: 'not_signed_in' };
      if (!safeEqual(publicSessionId(current), target)) return { ok: true, result: 'replaced' };
      auth.logout(request.cookies[PARENT_COOKIE]);
      return { ok: true, result: 'ended' };
    });

    app.get('/api/parents', { preParsing: requireParent }, async (request) => {
      const me = ctxOf(request).parent!.id;
      return { parents: auth.listParents().map((p) => ({ ...p, isYou: p.id === me })) };
    });

    app.post<{ Body: { username: string; displayName: string; password: string } }>(
      '/api/parents',
      { preParsing: requireParent, schema: { body: body(['username', 'displayName', 'password'], { username: str(64), displayName: str(80), password: str(256) }) } },
      async (request, reply) => {
        const r = await auth.createParent(request.body);
        if (!r.ok) return sendAuthError(reply, r);
        return { parent: r.parent };
      },
    );

    app.post<{ Params: { id: string }; Body: { password: string } }>(
      '/api/parents/:id/remove',
      { preParsing: requireParent, schema: { params: idParams, body: body(['password'], { password: str(256) }) } },
      async (request, reply) => {
        const r = await auth.removeParent(ctxOf(request).parent!.id, request.params.id, request.body.password);
        if (!r.ok) return sendAuthError(reply, r);
        // Removing yourself ends your sessions (they go with the account). No
        // Set-Cookie, as with a targeted sign-out: this answer could arrive
        // after another parent signed in on this browser, and clearing the
        // cookie then would sign them out. The dead token is refused.
        return { ok: true, removedSelf: r.removedSelf };
      },
    );

    app.post<{ Body: { currentPassword: string; newPassword: string } }>(
      '/api/account/password',
      { preParsing: requireParent, schema: { body: body(['currentPassword', 'newPassword'], { currentPassword: str(256), newPassword: str(256) }) } },
      async (request, reply) => {
        const c = ctxOf(request);
        const r = await auth.changeOwnPassword(c.parent!.id, request.body.currentPassword, request.body.newPassword, c.parentSessionHash);
        if (!r.ok) return sendAuthError(reply, r);
        return { ok: true };
      },
    );

    app.get('/api/devices', { preParsing: requireParent }, async (request) => {
      const current = ctxOf(request).device?.id ?? null;
      return { devices: auth.listDevices().map((d) => ({ ...d, isThisDevice: d.id === current })) };
    });

    app.post<{ Body: { name: string } }>(
      '/api/devices/pairing-codes',
      { preParsing: requireParent, schema: { body: body(['name'], { name: str(80) }) } },
      async (request, reply) => {
        const r = auth.createPairingCode(ctxOf(request).parent!.id, request.body.name);
        if (!r.ok) return sendAuthError(reply, r);
        return { code: r.code, expiresAt: r.expiresAt };
      },
    );

    app.post<{ Params: { id: string } }>('/api/devices/:id/revoke', { preParsing: requireParent, schema: { params: idParams } }, async (request, reply) => {
      const r = auth.revokeDevice(request.params.id);
      if (!r.ok) return sendAuthError(reply, r);
      return { ok: true };
    });

    app.post<{ Body: { code: string } }>(
      '/api/devices/pair',
      { schema: { body: body(['code'], { code: str(32) }) } },
      async (request, reply) => {
        const r = auth.pairDevice(request.body.code, request.ip);
        if (!r.ok) return sendAuthError(reply, r);
        auth.forgetDeviceSession(request.cookies[DEVICE_COOKIE]);
        setSessionCookie(request, reply, DEVICE_COOKIE, r.token, AuthService.cookieMaxAge('device', false));
        request.log.info({ deviceId: r.device.id }, 'device paired');
        return { device: r.device };
      },
    );
  }

  // ---------- family data ----------

  app.get('/api/state', { preParsing: requireHousehold }, async () => {
    const state = store.read();
    return {
      stateVersion: state.stateVersion,
      recordVersions: state.recordVersions,
      family: state.family,
      today: store.today(),
      timeZone: config.timeZone,
    };
  });

  app.post<{ Body: Command }>('/api/commands', { preParsing: requireHousehold, schema: { body: commandBodySchema } }, async (request, reply) => {
    if (!dev && !DEVICE_COMMANDS.has(request.body.type) && !ctxOf(request).parent) {
      return reply.status(403).send(PARENT_REQUIRED);
    }
    const result = store.apply(request.body, actorOf(request));
    if (!result.ok) {
      const { ok: _ok, status, ...rest } = result;
      return reply.status(status).send(rest);
    }
    return { stateVersion: result.stateVersion, changed: result.changed, noChange: result.noChange };
  });

  app.get('/api/export', { preParsing: requireParent }, async (_request, reply) => {
    const state = store.read();
    const file = buildExportFile(state.family, 'server');
    reply.header('Content-Disposition', `attachment; filename="chore-chart-export-${store.today()}.json"`);
    return { ...file, stateVersion: state.stateVersion };
  });

  app.post<{ Body: { data: unknown } }>(
    '/api/import/preview',
    { preParsing: requireParent, bodyLimit: IMPORT_BODY_LIMIT, schema: { body: importPreviewSchema } },
    async (request, reply) => {
      const parsed = parseImport(request.body.data);
      if (!parsed.ok) return reply.status(422).send({ error: parsed.error, message: parsed.message });
      return {
        summary: parsed.summary,
        checksum: parsed.checksum,
        server: { stateVersion: store.stateVersion(), empty: store.isEmpty() },
      };
    },
  );

  app.post<{ Body: { data: unknown; checksum: string; expectedStateVersion: number; replace: boolean } }>(
    '/api/import/apply',
    { preParsing: requireParent, bodyLimit: IMPORT_BODY_LIMIT, schema: { body: importApplySchema } },
    async (request, reply) => {
      const { data, checksum, expectedStateVersion, replace } = request.body;
      const parsed = parseImport(data);
      if (!parsed.ok) return reply.status(422).send({ error: parsed.error, message: parsed.message });
      if (parsed.checksum !== checksum) {
        return reply.status(400).send({ error: 'checksum_mismatch', message: 'The data differs from what was previewed. Please preview it again.' });
      }
      // Cheap pre-checks so a refused import does not create a backup.
      if (store.stateVersion() !== expectedStateVersion) {
        return reply.status(409).send({ error: 'changed_since_preview', message: 'The family data changed since the preview. Please check the preview again.' });
      }
      if (!store.isEmpty() && !replace) {
        return reply.status(409).send({ error: 'server_not_empty', message: 'This server already has family data. Confirm that you want to replace it.' });
      }
      const backup = await createBackup(db, config.dataDir, 'pre-import');
      const result = store.importDocument(parsed.doc, { expectedStateVersion, replace }, actorOf(request));
      if (!result.ok) return reply.status(result.status).send({ error: result.error, message: result.message, backup: path.basename(backup) });
      return { stateVersion: result.stateVersion, backup: path.basename(backup) };
    },
  );

  return app;
}
