# Shared family server: development notes (Stages A–C)

> **Status: pre-release. Not for real families yet.**
> The **default** app build still stores data in each browser's localStorage, exactly like the released v0.3.0. Only the explicit server build (`npm run dev:api`) uses the server. Parent accounts, device pairing and server-side authorisation now exist (Stage C), but the server isn't packaged for installation yet (no HTTPS setup, no Compose file, frontend not served by the server). Don't expose it on a network or use it for real family data yet.

## What exists

- **Fastify** HTTP server (`server/`) with a **SQLite** database (built-in `node:sqlite`; the only file that uses it is `server/db/database.ts`).
- **One family document** per installation (the browser's data format v3, **without** the old client-side PIN), with a version number. Every change is a *command* applied by the existing business-rule functions in `src/lib` inside one write transaction.
- **Numbered, transactional schema migrations** (`server/db/migrations.ts`). A verified backup is taken automatically before an existing database is upgraded. The server refuses to open a database from a newer release. Migration 2 (Stage C) adds the `parents`, `devices`, `sessions` and `pairing_codes` tables and leaves family data untouched.
- **Online, WAL-safe backups** and an **offline restore** (`server/db/backup.ts`, `server/cli.ts`).
- **Household time zone** for "today" (`SFCC_TIMEZONE`, or `TZ`).
- A new database starts with an **empty household** and **no parent account**. Demo data only appears through the explicit `loadDemoFamily` command, which only works on an empty household.
- **Parent accounts, sessions and device pairing** (`server/auth/`), described below.

## Modes

| Mode | How to enable | Family data API |
|---|---|---|
| **Normal** (default) | nothing | **Sign-in required.** Family data is only served to a signed-in parent or a paired device; see *Who may do what*. The server **refuses to start** without its authentication service. |
| **Development (unauthenticated)** | `--dev-unauthenticated-api` flag or exactly `SFCC_DEV_UNAUTHENTICATED_API=1` | Enabled **without authentication**, for local development only. The server **refuses to start** in this mode if `SFCC_HOST` isn't loopback or if `NODE_ENV=production`. **Every** request must (1) come from a loopback client, (2) carry a loopback `Host` header for the configured port (`127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`), which blocks DNS-rebinding attacks, and (3) have no `Origin` or a loopback `Origin`. Otherwise it gets 403. Responses carry `X-SFCC-Dev-Mode: unauthenticated-loopback-only`, and the app shows a "Development mode … no sign-in" banner. The account routes don't exist in this mode. |

## Running it locally

```bash
npm run dev:server          # development mode (NO sign-in), http://127.0.0.1:3000, data in ./data (gitignored)
npm run dev:server:auth     # normal mode (sign-in on), same address and data folder
npm run dev:api             # the server build of the app on http://localhost:4175, /api forwarded to :3000
npm run build:server        # bundle to dist-server/
npm run start:server        # run the bundle (normal mode)
npm run server:cli -- status
```

Configuration (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `SFCC_DATA_DIR` | `./data` | Folder for `chorechart.db` and `backups/` |
| `SFCC_HOST` | `127.0.0.1` | Listen address |
| `SFCC_PORT` | `3000` | Listen port |
| `SFCC_TIMEZONE` (or `TZ`) | `UTC` | Household time zone (IANA name, e.g. `Europe/London`). Invalid values stop the server. |
| `SFCC_DEV_UNAUTHENTICATED_API` | unset | `1` enables development mode (see above) |
| `SFCC_COOKIE_SECURE` | `auto` | `auto` marks session cookies `Secure` when the request arrived over HTTPS; `always` / `never` force it. Any other value stops the server. Use `always` behind an HTTPS reverse proxy. |
| `SFCC_SETUP_CODE` | unset | Optional fixed first-run setup code (12–64 letters or digits; dashes and spaces are ignored). Normally leave it unset so a random code is printed. Invalid values stop the server. |

## Parent accounts, devices and sessions (Stage C)

### First run

A fresh server has no parent account. On start it prints a **one-time setup code** to the console (not the request log), for example:

```
  FIRST-RUN SETUP: no parent account exists yet.
  Open the app and enter this setup code: ABCD-EFGH-JKLM
```

Opening the app shows *Set up your family server*: enter the code and create the first parent account. Setup closes for good once a parent exists. Until then a **new code is generated on each start**; it's held only in memory as a hash. Wrong codes are rate-limited.

### Who may do what

| Caller | May |
|---|---|
| Nobody signed in, device not paired | Only `/healthz`, `/readyz`, `GET /api/auth/status`, first-run setup, sign-in, sign-out and pairing with a code. Everything else answers **401** without reading the request body. The app shows *Connect this device*. |
| **Paired device** (e.g. the kitchen tablet) | View the family chart, tick chores, redeem rewards and dismiss the meal reminder (`toggleChore`, `redeemReward`, `dismissMealReminder`). Anything else answers **403 `parent_required`**. |
| **Signed-in parent** | Everything: all commands, export/import, parents, devices, own password. |

Parents are **equal**: any parent can add or remove parents and pair or unpair devices. Each parent changes only **their own** password. The **last parent can't be removed**, and removing a parent needs the remover's own password. The command log records who made each change (`parent:<id>` or `device:<id>`).

### Pairing a device

1. A parent signs in (on any device) → Parent area → **Family access** → *Pair a device* → enter a name → *Create pairing code*.
2. On the new device, open the app and enter the code on *Connect this device*.

Codes are 8 characters from an unambiguous alphabet, **work once** and **expire after 10 minutes**; wrong guesses are rate-limited. If a parent is signed in on an unpaired device, *Make this a family device* pairs it directly. Unpairing a device (Family access → *Unpair*) stops it immediately.

### Sessions

| Session | Idle timeout | Maximum | Cookie |
|---|---|---|---|
| Parent (default) | 30 minutes | 12 hours | browser-session cookie |
| Parent, "Keep me signed in on this device" | 30 days | 30 days | persistent, 30 days |
| Paired device | 90 days | 365 days | persistent, 365 days |

- Cookies `sfcc_parent` and `sfcc_device` are **HttpOnly** and **SameSite=Strict**, with `Path=/`, and `Secure` per `SFCC_COOKIE_SECURE`. Tokens are 256-bit random values; the database stores only their **SHA-256 hash**. Tokens never appear in response bodies or logs.
- **Sign-out** deletes the session on the server. Changing your password signs out your **other** sessions; removing a parent or resetting their password signs them out everywhere; unpairing a device ends its session.
- On a **paired (shared) device**, *Done – lock & exit* in the parent area signs the parent out again. On a parent's own unpaired device the button just says *Done* and keeps them signed in; use Family access → *Sign out*.

### Security measures

- **Passwords:** scrypt (N=2¹⁵, r=8, p=1, random 16-byte salt); at least 10 characters, not a very common password, not containing the username. Unknown usernames are checked against a dummy hash so timing doesn't reveal which accounts exist, and all sign-in failures get the same message.
- **Rate limits:** sign-in locks for 15 minutes after 5 failures (per account and per address); re-entering your own password (password change, removing a parent) locks for 15 minutes after 5 wrong tries per parent, so a stolen session can't be used to guess the password; setup and pairing codes allow 10 wrong tries per 15 minutes per address. Limits are in memory and reset when the server restarts.
- **CSRF:** every non-GET request is refused (**403 `cross_site_request`**) if `Sec-Fetch-Site` is anything other than `same-origin`/`none`, or if `Origin` doesn't match `Host`. Together with SameSite=Strict cookies and JSON-only bodies, this blocks forged requests from other websites, including sign-in CSRF.
- **Order of checks:** cross-site check → authentication → route permission → body parsing and validation → handler. Unauthenticated callers never get their body parsed, so they can't see validation errors or make the server read large bodies.
- **Fail closed:** normal mode can't start without the authentication service; invalid `SFCC_COOKIE_SECURE` or `SFCC_SETUP_CODE` stops the server; expired or unknown sessions are treated as signed out (and expired ones deleted).
- The Vite dev proxy rewrites `Origin` to the server's address **only** when it equals the dev server's own address, so the app works through the proxy while foreign origins are still refused.

### Forgotten passwords (server command line)

```bash
npm run server:cli -- list-parents
npm run server:cli -- reset-password <username>   # prints a temporary password once
```

`reset-password` sets a random temporary password and signs that parent out everywhere. Tell them in person; they can change it under Family access. If every parent is locked out, this is the recovery route; there's no e-mail reset.

## API

- `GET /healthz`: `{status:"ok"}` (process is alive).
- `GET /readyz`: `{status:"ready", schemaVersion}`, or 503 if the database or schema isn't usable.
- `GET /api/auth/status`: `{devMode, setupRequired, parent, device}` (`parent`/`device` are `{id, username, displayName}` / `{id, name}` or null).
- `POST /api/auth/setup {setupCode, username, displayName, password}`, `POST /api/auth/login {username, password, remember?}`, `POST /api/auth/logout`.
- `GET /api/parents`, `POST /api/parents {username, displayName, password}`, `POST /api/parents/:id/remove {password}` (your own password), `POST /api/account/password {currentPassword, newPassword}`. Parent only.
- `GET /api/devices`, `POST /api/devices/pairing-codes {name}` → `{code, expiresAt}`, `POST /api/devices/:id/revoke`. Parent only. `POST /api/devices/pair {code}` is public (that's how a device gets in).
- `GET /api/state`: `{stateVersion, recordVersions, family, today, timeZone}`. Parent or paired device.
- `POST /api/commands` with `{type, payload, expectedVersion?}` (JSON only, body limit 64 KB, strict validation). Parent, or paired device for the three device commands:
  - `200 {stateVersion, changed, noChange}`
  - `400` malformed request
  - `401` not signed in / not paired
  - `403` `parent_required` or `cross_site_request`
  - `404` record not found
  - `409` conflict (`record`, `currentVersion`)
  - `413` body too large
  - `415` content type not JSON
  - `422` rejected by business rules (`fields` for form errors)
  - `429` too many attempts (sign-in and code routes; `Retry-After` header)

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
- Backups contain the account tables too (password **hashes** and session **hashes**, never plaintext). Keep them as private as the database.
- Restore verifies the backup first, moves the current database (with its `-wal` and `-shm`) to `backups/replaced-<time>.db`, and never deletes it.
- **Never copy a live `chorechart.db` by hand.** Use the backup command.
- Scheduled daily backups aren't implemented yet (planned for the Compose stage).

## Frontend with the server

The data source is chosen at **build time** and never auto-detected:

| Build | Data source | How |
|---|---|---|
| Default (`npm run dev`, `npm run build`, the published image) | Browser localStorage (released behaviour) | nothing |
| Server build | The shared family server | `npm run dev:server:auth` (or `dev:server` for development mode) **and** `npm run dev:api` (app on http://localhost:4175, `/api` forwarded to the server) |

In the server build:
- Before anything else the app asks the server who is using this browser: first-run setup, *Connect this device* (pair with a code, or parent sign-in), or the chart. In development mode it skips this and shows the "no sign-in" banner and notice instead.
- The parent area asks a parent to sign in (with *Keep me signed in on this device*) instead of the old PIN; a signed-in parent goes straight in. **Family access** manages parents, own password, devices and pairing codes, and has *Sign out*.
- If the parent session ends (timeout, signed out elsewhere, removed), the parent area closes with a message. After 30 minutes without input the app re-checks with the server.
- All data is read from and saved to the server. After every change the app re-reads the server state, so all devices end up showing what the server stored after a reload (live updates come in Stage D).
- If the server can't be reached, the first load shows a "Can't reach the family server" screen with **Try again**. Later failures show a banner, keep the last data visible and refuse changes; there's no offline queue.
- Edit and delete dialogs remember the record version from when they opened. If another device changed it meanwhile, the save is refused: "This was changed on another device, so your change was not saved. The latest version has been loaded."

## Export and import

- **Export** (both builds; parent only on the server): Parent area → Settings → Family data → *Export family data* downloads `chore-chart-export-<date>.json` (`{app, exportFormat: 1, exportedAt, source, data}`). The old client-side PIN is never included, and neither are accounts or devices.
- **Import** (server build only; parent only): *Import from a file* (an export file, or raw v0.1.0-v0.3.0 browser data), or *Import from this browser* (offered only when this site address holds old browser data).
  1. **Preview:** the server validates and, if needed, upgrades the data (format 1, 2 or 3) and shows a summary. Nothing changes.
  2. **Confirm:** if the server already has family data, the parent must tick *"Yes, replace all family data on this server"*.
  3. **Apply:** the server re-validates; refuses if the data differs from the preview (checksum) or the server changed since the preview; makes a verified backup (`backups/…-pre-import.db`); then replaces everything in **one transaction** (all or nothing). Accounts and paired devices are kept.
- Files that aren't family data, come from a newer version, or contain **any** invalid record are **rejected** (nothing is silently dropped). The old PIN in imported data is ignored and never stored.
- Import is never automatic. Importing from this browser leaves the browser's own data in place and only records when it was imported.
- **v0.3.0 users** (no Export button): open the old app at its usual address, open the browser console and run `copy(localStorage.getItem('smart-family-chore-chart:data'))`, paste into a file such as `family.json`, then use *Import from a file*.

Server routes (parent only): `GET /api/export`, `POST /api/import/preview {data}`, `POST /api/import/apply {data, checksum, expectedStateVersion, replace}` (5 MB limit for imports).

## Browser tests

`npm run test:e2e` runs Playwright with the installed Google Chrome (no browser download). It starts its own throwaway servers with temporary data: development mode on port 3199 (app on 4176), normal mode on 3198 with a fixed test-only setup code (app on 4178), and the default browser-local build on 4177.

## Not done yet (later stages)

Live updates (D); Docker Compose installation, HTTPS guidance and serving the frontend from this server (E). Rate-limit counters are in memory only (reset on restart). There's no e-mail password reset (by design; use the server command line).
