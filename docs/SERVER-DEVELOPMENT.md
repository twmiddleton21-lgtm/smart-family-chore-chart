# Server (Stage A): development notes

> **Status: development foundation only. Not for real families yet.**
> The server has **no authentication** so far. The released app still stores data in each browser's localStorage, and the frontend does **not** use this server yet. Do not expose this server on a network or use it for real family data until parent login, device pairing and authorisation exist (later stages).

## What exists

- **Fastify** HTTP server (`server/`) with a **SQLite** database (built-in `node:sqlite`; the only file that uses it is `server/db/database.ts`).
- **One family document** per installation (the browser's data format v3, **without** the old client-side PIN), with a version number. Every change is a *command* applied by the existing business-rule functions in `src/lib` inside one write transaction.
- **Numbered, transactional schema migrations** (`server/db/migrations.ts`). A verified backup is taken automatically before an existing database is upgraded. The server refuses to open a database from a newer release.
- **Online, WAL-safe backups** and an **offline restore** (`server/db/backup.ts`, `server/cli.ts`).
- **Household time zone** for "today" (`SFCC_TIMEZONE`, or `TZ`).
- A new database starts with an **empty household**. Demo data only appears through the explicit `loadDemoFamily` command, which only works on an empty household.

## Access restrictions (Stage A)

| Mode | How to enable | Family data API |
|---|---|---|
| **Default** | nothing | **Disabled.** `/api/*` returns 503. Only `/healthz` and `/readyz` work, and they contain no family data. |
| **Development (unauthenticated)** | `--dev-unauthenticated-api` flag or `SFCC_DEV_UNAUTHENTICATED_API=1` | Enabled **without authentication**, only for **loopback clients**. The server **refuses to start** in this mode if `SFCC_HOST` isn't loopback or if `NODE_ENV=production`. Responses carry `X-SFCC-Dev-Mode: unauthenticated-loopback-only`. |

## Running it locally

```bash
npm run dev:server          # tsx watch, development API, http://127.0.0.1:3000, data in ./data (gitignored)
npm run build:server        # bundle to dist-server/
npm run start:server        # run the bundle (default mode: API disabled)
npm run server:cli -- status
```

Configuration (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `SFCC_DATA_DIR` | `./data` | Folder for `chorechart.db` and `backups/` |
| `SFCC_HOST` | `127.0.0.1` | Listen address |
| `SFCC_PORT` | `3000` | Listen port |
| `SFCC_TIMEZONE` (or `TZ`) | `UTC` | Household time zone (IANA name, e.g. `Europe/London`). Invalid values stop the server. |
| `SFCC_DEV_UNAUTHENTICATED_API` | unset | `1` enables the development API (see above) |

## API (development mode)

- `GET /healthz`: `{status:"ok"}` (process is alive).
- `GET /readyz`: `{status:"ready", schemaVersion}`, or 503 if the database or schema isn't usable.
- `GET /api/state`: `{stateVersion, recordVersions, family, today, timeZone}`.
- `POST /api/commands` with `{type, payload, expectedVersion?}` (JSON only, body limit 64 KB, strict validation):
  - `200 {stateVersion, changed, noChange}`
  - `400` malformed request
  - `404` record not found
  - `409` conflict (`record`, `currentVersion`)
  - `413` body too large
  - `415` content type not JSON
  - `422` rejected by business rules (`fields` for form errors)

Commands: `toggleChore`, `redeemReward`, `dismissMealReminder`, `saveChild`, `deleteChild`, `saveChore`, `deleteChore`, `saveReward`, `deleteReward`, `saveMealWeek`, `addFoodOption`, `removeFoodOption`, `updateSettings`, `loadDemoFamily`.

**Conflicts:** edits that replace or delete an existing record (child, chore, reward, meal week, settings) must send `expectedVersion`, the record version the device last saw (from `recordVersions`; 0 for a meal week that doesn't exist yet). If another device changed that record since, the server answers **409** and changes nothing.

## Backups and restore

```bash
npm run server:cli -- backup manual        # safe while the server runs
npm run server:cli -- verify <file>
npm run server:cli -- prune 14 daily
npm run server:cli -- restore <file> --yes # STOP THE SERVER FIRST
```

- Backups use SQLite's online backup API, so they include changes still in the `-wal` file. They're converted to a single self-contained file and verified with an integrity check before being reported as written.
- Restore verifies the backup first, moves the current database (with its `-wal` and `-shm`) to `backups/replaced-<time>.db`, and never deletes it.
- **Never copy a live `chorechart.db` by hand.** Use the backup command.
- Scheduled daily backups aren't implemented yet (planned for the Compose stage).

## Not done yet (later stages)

Frontend integration and import from the browser (B); parent accounts, device pairing, sessions, CSRF and rate limiting (C); live updates (D); Docker Compose installation and serving the frontend from this server (E).
