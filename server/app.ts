import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { ServerConfig } from './config';
import type { SqlDatabase } from './db/database';
import { currentSchemaVersion, LATEST_SCHEMA_VERSION } from './db/migrations';
import path from 'node:path';
import { createBackup } from './db/backup';
import { COMMAND_TYPES, type Command } from './family/commands';
import { buildExportFile, parseImport } from './family/importer';
import type { FamilyStore } from './family/store';

// HTTP API. Stage A has NO authentication yet, so family-data routes exist
// only in the explicit development mode (config.devUnauthenticatedApi),
// which config.ts allows only outside production and only on a loopback
// address. In that mode every request must also come from a loopback
// client, carry a loopback Host header for the configured port (defeats DNS
// rebinding: a malicious site resolving its own name to 127.0.0.1) and, if
// it has an Origin header, a loopback Origin (blocks cross-site browsers).
// Otherwise every /api route answers 503 and no family data is reachable.

export interface AppDeps {
  config: Pick<ServerConfig, 'devUnauthenticatedApi' | 'bodyLimit' | 'timeZone' | 'port' | 'dataDir'>;
  db: SqlDatabase;
  store: FamilyStore;
  logger?: boolean;
}

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

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, db, store } = deps;
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: config.bodyLimit,
    trustProxy: false,
    // Generic request ids; never derived from client input.
    requestIdHeader: false,
    // Strict validation: reject unknown fields and wrong types instead of
    // Fastify's defaults (silently removing extras / coercing "3" -> 3).
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });

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

  // ---------- family data API ----------

  if (!config.devUnauthenticatedApi) {
    app.all('/api/*', async (_request, reply) =>
      reply.status(503).send({
        error: 'api_unavailable',
        message: 'The family data API is disabled until authentication is implemented.',
      }),
    );
    return app;
  }

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

  app.get('/api/state', async () => {
    const state = store.read();
    return {
      stateVersion: state.stateVersion,
      recordVersions: state.recordVersions,
      family: state.family,
      today: store.today(),
      timeZone: config.timeZone,
    };
  });

  app.post<{ Body: Command }>('/api/commands', { schema: { body: commandBodySchema } }, async (request, reply) => {
    const result = store.apply(request.body, 'dev-unauthenticated');
    if (!result.ok) {
      const { ok: _ok, status, ...body } = result;
      return reply.status(status).send(body);
    }
    return { stateVersion: result.stateVersion, changed: result.changed, noChange: result.noChange };
  });

  // ---------- export / import (development mode only for now) ----------

  app.get('/api/export', async (_request, reply) => {
    const state = store.read();
    const file = buildExportFile(state.family, 'server');
    reply.header('Content-Disposition', `attachment; filename="chore-chart-export-${store.today()}.json"`);
    return { ...file, stateVersion: state.stateVersion };
  });

  app.post<{ Body: { data: unknown } }>(
    '/api/import/preview',
    { bodyLimit: IMPORT_BODY_LIMIT, schema: { body: importPreviewSchema } },
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
    { bodyLimit: IMPORT_BODY_LIMIT, schema: { body: importApplySchema } },
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
      const result = store.importDocument(parsed.doc, { expectedStateVersion, replace }, 'dev-unauthenticated');
      if (!result.ok) return reply.status(result.status).send({ error: result.error, message: result.message, backup: path.basename(backup) });
      return { stateVersion: result.stateVersion, backup: path.basename(backup) };
    },
  );

  return app;
}
