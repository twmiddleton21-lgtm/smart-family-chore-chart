import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildApp } from './app';
import { AuthService } from './auth/service';
import { CalendarService, fixtureCalendarSource } from './calendar/calendar';
import { FamilyCalendar } from './calendar/familyCalendar';
import { SecretBox } from './calendar/secretBox';
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
  if (config.staticDir && !existsSync(path.join(config.staticDir, 'index.html'))) {
    throw new ConfigError(`SFCC_STATIC_DIR has no index.html: ${config.staticDir}. Build the app with "npm run build:app".`);
  }

  const opened = await openData(config.dataDir, config.timeZone);
  const auth = config.devUnauthenticatedApi ? undefined : new AuthService(opened.db, { setupCode: config.setupCode });
  // Family calendar: the household's one connection, Google OAuth or a
  // private iCal address (Settings → Family calendar), or, in development
  // only, events from a fixture file.
  const familyCalendar = new FamilyCalendar({
    db: opened.db,
    google: config.google ?? null,
    secretBox: config.secretKey ? new SecretBox(config.secretKey) : null,
    missing: config.googleMissing,
    timeZone: config.timeZone,
    // Built server: the iCal parser's worker is bundled beside this file
    // (vite.server.config.ts). From source, icalFeed.ts finds its own.
    feeds: { extraHosts: config.calendarFeedHosts, parser: import.meta.url.endsWith('.js') ? { url: new URL('./icalWorker.js', import.meta.url) } : undefined },
  });
  const calendar = config.devCalendarFixture ? CalendarService.fixed(fixtureCalendarSource(config.devCalendarFixture), config.timeZone) : undefined;
  const app = buildApp({ config, db: opened.db, store: opened.store, auth, familyCalendar, calendar, logger: true });
  if (config.devCalendarFixture) app.log.warn({ file: config.devCalendarFixture }, 'DEVELOPMENT: family calendar shows events from a local fixture file');
  if (familyCalendar.configured) app.log.info({ redirectUri: config.google!.redirectUri }, 'Google Calendar integration available (read-only)');
  // The secret key alone is a complete setup for calendar addresses; only warn about half-done Google settings.
  else if (config.googleMissing.filter((m) => m !== 'SFCC_SECRET_KEY_FILE').length < 3) {
    app.log.warn({ missing: config.googleMissing }, 'Google Calendar is partly configured; it stays off until these are set');
  }
  if (familyCalendar.feedsAvailable) app.log.info({ extraHosts: config.calendarFeedHosts }, 'Calendar addresses (iCal) available (read-only)');

  app.log.info({ database: databasePath(config.dataDir), timeZone: config.timeZone, today: opened.store.today() }, 'data opened');
  if (opened.created) app.log.info('created a new, empty household');
  if (opened.migrated.length) app.log.info({ migrations: opened.migrated, backup: opened.preMigrationBackup }, 'schema migrated');
  if (config.devUnauthenticatedApi) {
    app.log.warn(
      'DEVELOPMENT MODE: the family data API has NO authentication and is limited to loopback clients. Never use this for real families or expose it on a network.',
    );
  } else if (auth) {
    auth.purgeExpired();
    const generated = auth.prepareSetup();
    if (auth.isSetupRequired()) {
      // The one place a credential is shown: printed once to the console
      // (not the request log) so the person running the server can set up
      // the first parent account. Valid until that account exists.
      console.log(
        generated
          ? [
              '',
              '  FIRST-RUN SETUP: no parent account exists yet.',
              `  Open the app and enter this setup code: ${generated}`,
              '  (A new code is generated each time the server starts until setup is done.)',
              '',
            ].join('\n')
          : '\n  FIRST-RUN SETUP: no parent account exists yet. Use the setup code from SFCC_SETUP_CODE.\n',
      );
    } else {
      app.log.info('authentication enabled; family data requires a signed-in parent or a paired device');
    }
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
