# Shared family server: development notes (Stages A and B)

> **Status: development build only. Not for real families yet.**
> The server has **no authentication** so far. The **default** app build still stores data in each browser's localStorage, exactly like the released v0.3.0. Only the explicit development build (`npm run dev:api`) uses the server. Do not expose the server on a network or use it for real family data until parent login, device pairing and authorisation exist (Stage C).

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
| **Development (unauthenticated)** | `--dev-unauthenticated-api` flag or `SFCC_DEV_UNAUTHENTICATED_API=1` | Enabled **without authentication**. The server **refuses to start** in this mode if `SFCC_HOST` isn't loopback or if `NODE_ENV=production`. **Every** request must (1) come from a loopback client, (2) carry a loopback `Host` header for the configured port (`127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`), which blocks DNS-rebinding attacks from malicious websites, and (3) have no `Origin` or a loopback `Origin`. Otherwise it gets 403. Responses carry `X-SFCC-Dev-Mode: unauthenticated-loopback-only`. |

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

## Frontend with the server (Stage B, development only)

The data source is chosen at **build time** and never auto-detected:

| Build | Data source | How |
|---|---|---|
| Default (`npm run dev`, `npm run build`, the published image) | Browser localStorage (released behaviour) | nothing |
| Development | The shared family server | `npm run dev:server` (API on 127.0.0.1:3000) **and** `npm run dev:api` (app on http://localhost:4175, `/api` forwarded to the server) |

In the development build:
- All data is read from and saved to the server. After every change the app re-reads the server state, so all devices end up showing what the server stored after a reload (live updates come in Stage D).
- A persistent banner says it's a development build with **no sign-in**. The parent area shows a plain "no parent sign-in yet" notice instead of the old PIN, so nothing looks like authentication.
- If the server can't be reached, the first load shows a "Can't reach the family server" screen with **Try again**. Later failures show a banner, keep the last data visible and refuse changes; there's no offline queue.
- Edit and delete dialogs remember the record version from when they opened. If another device changed it meanwhile, the save is refused: "This was changed on another device, so your change was not saved. The latest version has been loaded."

## Export and import

- **Export** (both builds): Parent area → Settings → Family data → *Export family data* downloads `chore-chart-export-<date>.json` (`{app, exportFormat: 1, exportedAt, source, data}`). The old client-side PIN is never included.
- **Import** (development build only): *Import from a file* (an export file, or raw v0.1.0-v0.3.0 browser data), or *Import from this browser* (offered only when this site address holds old browser data).
  1. **Preview:** the server validates and, if needed, upgrades the data (format 1, 2 or 3) and shows a summary. Nothing changes.
  2. **Confirm:** if the server already has family data, the parent must tick *"Yes, replace all family data on this server"*.
  3. **Apply:** the server re-validates; refuses if the data differs from the preview (checksum) or the server changed since the preview; makes a verified backup (`backups/…-pre-import.db`); then replaces everything in **one transaction** (all or nothing).
- Files that aren't family data, come from a newer version, or contain **any** invalid record are **rejected** (nothing is silently dropped). The old PIN in imported data is ignored and never stored.
- Import is never automatic. Importing from this browser leaves the browser's own data in place and only records when it was imported.
- **v0.3.0 users** (no Export button): open the old app at its usual address, open the browser console and run `copy(localStorage.getItem('smart-family-chore-chart:data'))`, paste into a file such as `family.json`, then use *Import from a file*.

Server routes (development mode only; 503 in default mode): `GET /api/export`, `POST /api/import/preview {data}`, `POST /api/import/apply {data, checksum, expectedStateVersion, replace}` (5 MB limit for imports).

## Browser tests

`npm run test:e2e` runs Playwright with the installed Google Chrome (no browser download). It starts its own throwaway server (dev mode, temporary data) and Vite instances on ports 3199, 4176 and 4177.

## Not done yet (later stages)

Parent accounts, device pairing, sessions, CSRF and rate limiting (C); live updates (D); Docker Compose installation and serving the frontend from this server (E).
