import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { ServerConfig } from './config';
import type { SqlDatabase } from './db/database';
import { currentSchemaVersion, LATEST_SCHEMA_VERSION } from './db/migrations';
import { COMMAND_TYPES, type Command } from './family/commands';
import type { FamilyStore } from './family/store';

// HTTP API. Stage A has NO authentication yet, so family-data routes exist
// only in the explicit development mode (config.devUnauthenticatedApi),
// which config.ts allows only outside production and only on a loopback
// address, and which additionally rejects any non-loopback client here.
// Otherwise every /api route answers 503 and no family data is reachable.

export interface AppDeps {
  config: Pick<ServerConfig, 'devUnauthenticatedApi' | 'bodyLimit' | 'timeZone'>;
  db: SqlDatabase;
  store: FamilyStore;
  logger?: boolean;
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopbackClient(request: FastifyRequest): boolean {
  return LOOPBACK_ADDRESSES.has(request.socket.remoteAddress ?? '');
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

  // DEVELOPMENT ONLY: unauthenticated, loopback clients only.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    reply.header('X-SFCC-Dev-Mode', 'unauthenticated-loopback-only');
    if (!isLoopbackClient(request)) {
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

  return app;
}
