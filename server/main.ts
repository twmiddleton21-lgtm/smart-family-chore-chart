import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';
import { SchemaTooNewError } from './db/migrations';
import { databasePath, openData } from './open';

// Server entry point.
//   Development (Stage A):  npm run dev:server
//   Flag --dev-unauthenticated-api (or SFCC_DEV_UNAUTHENTICATED_API=1)
//   enables the UNAUTHENTICATED family API for loopback clients only.

async function main(): Promise<void> {
  const env = { ...process.env };
  if (process.argv.includes('--dev-unauthenticated-api')) env.SFCC_DEV_UNAUTHENTICATED_API = '1';
  const config = loadConfig(env);

  const opened = await openData(config.dataDir, config.timeZone);
  const app = buildApp({ config, db: opened.db, store: opened.store, logger: true });

  app.log.info({ database: databasePath(config.dataDir), timeZone: config.timeZone, today: opened.store.today() }, 'data opened');
  if (opened.created) app.log.info('created a new, empty household');
  if (opened.migrated.length) app.log.info({ migrations: opened.migrated, backup: opened.preMigrationBackup }, 'schema migrated');
  if (config.devUnauthenticatedApi) {
    app.log.warn(
      'DEVELOPMENT MODE: the family data API has NO authentication and is limited to loopback clients. Never use this for real families or expose it on a network.',
    );
  } else {
    app.log.info('family data API disabled (authentication not implemented yet); only /healthz and /readyz are served');
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    opened.db.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof SchemaTooNewError) {
    console.error(`Refusing to start: ${error.message}`);
  } else {
    console.error('Failed to start:', error);
  }
  process.exit(1);
});
