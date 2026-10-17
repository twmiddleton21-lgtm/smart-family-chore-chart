import { existsSync } from 'node:fs';
import { createBackup, listBackups, pruneBackups, restoreBackup, verifyBackup } from './db/backup';
import { openDatabase } from './db/database';
import { currentSchemaVersion, LATEST_SCHEMA_VERSION } from './db/migrations';
import { loadConfig } from './config';
import { databasePath } from './open';

// Maintenance commands (run with the same SFCC_DATA_DIR as the server):
//   status                      schema/state versions and backups
//   backup [label]              online, verified backup (safe while running)
//   prune <keep> [label]        keep only the newest <keep> backups
//   verify <file>               check a backup file
//   restore <file> --yes        OFFLINE restore: stop the server first!

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  const config = loadConfig({ ...process.env, SFCC_DEV_UNAUTHENTICATED_API: undefined });
  const dbFile = databasePath(config.dataDir);

  switch (command) {
    case 'status': {
      if (!existsSync(dbFile)) {
        console.log(JSON.stringify({ database: dbFile, exists: false, backups: listBackups(config.dataDir) }, null, 2));
        return 0;
      }
      const db = openDatabase(dbFile);
      try {
        const schema = currentSchemaVersion(db);
        const state = schema > 0 ? db.get<{ version: number; updated_at: string }>('SELECT version, updated_at FROM family_state WHERE id = 1') : undefined;
        console.log(JSON.stringify({ database: dbFile, schemaVersion: schema, supportedSchema: LATEST_SCHEMA_VERSION, stateVersion: state?.version ?? null, updatedAt: state?.updated_at ?? null, backups: listBackups(config.dataDir) }, null, 2));
      } finally {
        db.close();
      }
      return 0;
    }
    case 'backup': {
      // Read-only use of the live database: no migrations are run here.
      if (!existsSync(dbFile)) throw new Error(`No database found at ${dbFile}.`);
      const db = openDatabase(dbFile);
      try {
        if (currentSchemaVersion(db) === 0) throw new Error(`No database found at ${dbFile}.`);
        const file = await createBackup(db, config.dataDir, args[0] ?? 'manual');
        console.log(`Backup written and verified: ${file}`);
      } finally {
        db.close();
      }
      return 0;
    }
    case 'prune': {
      const keep = Number(args[0]);
      const removed = pruneBackups(config.dataDir, keep, args[1]);
      console.log(`Removed ${removed.length} old backup(s).`);
      return 0;
    }
    case 'verify': {
      if (!args[0]) throw new Error('Usage: verify <file>');
      const check = verifyBackup(args[0]);
      console.log(JSON.stringify(check, null, 2));
      return check.ok ? 0 : 2;
    }
    case 'restore': {
      if (!args[0] || !args.includes('--yes')) {
        console.error('Usage: restore <backup-file> --yes\nSTOP THE SERVER FIRST. The current database is moved aside, not deleted.');
        return 1;
      }
      const result = restoreBackup(args[0], dbFile);
      console.log(`Restored ${args[0]} -> ${dbFile}` + (result.movedAside ? `\nPrevious database kept at ${result.movedAside}` : ''));
      return 0;
    }
    default:
      console.error('Commands: status | backup [label] | prune <keep> [label] | verify <file> | restore <file> --yes');
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  },
);
