# Shared family data, authentication and production readiness: plan

Status: **PLAN ONLY. Nothing here is implemented.** Written 2026-10-13 during
containerisation and CI work. Decisions marked *proposed* need approval.

## 1. Why the current app cannot be the production system yet

Findings from inspecting v0.3.0 (verified against the code):

- **All family data is browser-local.** `src/lib/storage.ts` is the only
  persistence layer. It reads and writes one JSON document (format version 3)
  in `localStorage` under `smart-family-chore-chart:data`, plus
  `…:unreadable-backup` for corrupt data. There is **no backend and no network
  call** anywhere in `src/`.
- **Data does not move between devices.** A kiosk device, each phone
  and each browser profile has its own separate copy. Even the same device
  keeps separate data per origin, so `http://localhost:4174` and
  a public hostname would hold different data. The Docker image
  only serves static files; it cannot share or persist family data.
- **No real authentication.** The parent PIN is stored as plain text in
  localStorage and checked in the browser. Anyone with developer tools can
  read or bypass it. The PIN screen also shows the demo PIN until changed.
- **Children's data stays local today.** Names or nicknames, avatars,
  routines, points and meals never reach a server now. A backend changes that
  and must be protected from day one.

**Gate:** do not point real family use at the public hostname until sections
2–9 are implemented, reviewed (run `/security-review`) and tested, including
the browser-data migration in section 6.

## 2. Target architecture (proposed)

```
Kiosk device       ─┐
Phones / tablets  ──┼─ HTTPS ─ Tunnel / proxy ─ Access control ────┐
                    │                                                 │
                    └──────────────── (LAN, optional) ────────────────┤
                                                                      ▼
                         Home server: Docker Compose (separate project)
                         ┌──────────────┐    ┌────────────────────┐
                         │ web (nginx)  │──▶ │ api (Node, /api/*) │──▶ SQLite file on a
                         │ static files │    │ auth, validation   │    named volume / bind
                         └──────────────┘    └────────────────────┘    mount + backups
```

- **API service:** a small Node/TypeScript service (same language as the app,
  reusing `src/lib` business rules: points, rewards, meals, validation, so
  rules are enforced on the server, not only in the browser).
- **Storage:** SQLite (single file, WAL mode) on a host bind mount or named
  volume **outside the container image**. It is enough for one family and easy
  to back up. Postgres only if real needs appear (*proposed*; decide in a
  decision record).
- **Same origin:** nginx serves the app and proxies `/api/` to the API, so the
  CSP `connect-src 'self'` stays strict and cookies are first-party.
- The browser keeps a local cache for display and short offline periods, but
  **the server is the source of truth**.

## 3. Authentication and authorisation (proposed)

Two layers:

1. **Perimeter:** an access-control layer in front of the public hostname
   (for example Cloudflare Access), allowing only
   family members' identities (email OTP or an identity provider). This blocks
   the public internet before anything reaches the server. The kiosk device
   uses a **service token** (or equivalent), or LAN-only access to the
   origin, so it doesn't need an interactive login.
2. **In-app roles:**
   - *Kiosk / child* session: may read the dashboard, today's chores, meals and
     rewards; may tick or untick chores and redeem rewards (the same rules as
     today, enforced server-side).
   - *Parent* session: required for every parent-area operation (children,
     chores, rewards, food options, meal planning, settings, reset, delete
     child). The server issues it after a parent PIN or passphrase check. The
     PIN is stored **only as a slow salted hash on the server** (e.g. scrypt or
     argon2id), never in the browser. Sessions are short-lived, HttpOnly,
     Secure, SameSite=Strict cookies, with rate limiting and lockout on failed
     attempts.
   - Every API route checks the role server-side. The browser hiding a button
     is not protection.
3. Remove the "Demo PIN" hint in production builds, and force a PIN to be set
   on first run.

## 4. Protecting children's data

- Keep the existing data minimisation: nickname, emoji avatar, colour; no ages,
  photos, emails or locations.
- No analytics, ads, trackers or third-party scripts (unchanged).
- Strict input validation on the server (reuse `validation.ts` and the
  `storage.ts` record validators), with size limits on every field and request.
- Security headers (already in the nginx config), HTTPS only (at the edge proxy),
  HSTS at the edge.
- Logs: no request bodies; no names in logs.
- Backups are encrypted at rest if they leave the home server.

## 5. Concurrent edits from several devices

- Every stored record keeps its own `id` (already true). Each mutable record
  gains a `version` (or `updatedAt`) field.
- Writes use **optimistic concurrency**: the client sends the version it saw,
  and the server rejects a stale write (HTTP 409). The UI then reloads and asks
  the user to retry.
- Chore completion is naturally idempotent: one completion per (chore, child,
  date), enforced by a **unique constraint** in the database. That way two
  devices ticking the same chore can never award points twice.
- Reward redemption runs **in a transaction** that re-checks the balance, so two
  devices cannot overspend.
- Meal week saves replace one child's five days in a transaction. The existing
  "prune entries older than 28 days on save" rule moves to the server (or to a
  scheduled job), and its *all-children* effect is documented and tested.
- Clients refresh on focus and on a modest polling interval. Server push is
  optional later.

## 6. Safe migration of existing browser-local data (REQUIRED before production)

Existing data lives only in the browsers that have used the app (currently
any computer that ran it at `localhost:4174`, plus any device that has opened it). It must be
moved **deliberately, once, without loss**:

1. **Export first, non-destructively.** Add a parent-only "Export family data"
   button that downloads the current localStorage JSON (format v3). It never
   modifies or clears local data. Export from **every** device that holds data
   you want to keep, and keep the files as backups.
2. **Choose one source of truth.** Normally the device with the real history
   (for example the kiosk or a main computer). Data from different devices **cannot be
   merged automatically**: each has independent IDs, points and completions.
   A merge would need a manual, reviewed import.
3. **Import on the server.** A parent-only import endpoint:
   - runs the **same `parseFamilyData` validation and v1/v2→v3 upgrade** used
     today, so older exports still work;
   - shows a **dry-run summary** first (children, chores, points per child,
     meals, food options, rejected records) and requires confirmation;
   - refuses to overwrite non-empty server data unless the parent explicitly
     chooses "replace", after an automatic server backup;
   - is atomic: all or nothing.
4. **Verify.** Compare per-child point balances, chore counts and planned meals
   between the export summary and the server. Then open the app on a second
   device and confirm the same data appears.
5. **Only then switch clients to the server.** Local data is not deleted
   automatically. After a successful import, the app marks the local copy as
   migrated (read-only) and keeps it until a parent removes it.
6. Keep the localStorage code path working until migration is complete, so
   nothing is stranded.

## 7. Persistence, backups and container updates

- Data lives on a **named volume or bind mount**, never in the image or a
  container's writable layer. Updating or recreating containers must not touch
  it.
- **Schema migrations** are versioned (like today's v1→v2→v3), run at API
  start-up inside a transaction, and **take a backup first**. The API refuses
  to start against a database with a newer schema than it understands, so a
  rollback can never corrupt newer data.
- **Backups:** nightly SQLite online backup (`.backup` or `VACUUM INTO`) to a
  separate disk or location, plus before every migration and import. Keep for
  example 14 daily and 8 weekly copies. **Test a restore** before going live,
  then periodically.
- **Deploy by immutable image tag** (`sha-<full commit sha>` from CI), never by
  `latest`/`main`, so the running version is always known and reproducible.
- Health checks: `/healthz` (web, already present) and an API readiness check
  that verifies database access.

## 8. Recovery and rollback

- **App rollback:** redeploy the previous `sha-…` tag. Because schema
  migrations are additive and versioned, the previous app either works or
  refuses to start (it never silently corrupts data).
- **Data rollback:** stop the API, restore the last good backup file, start
  the API. Document and rehearse this.
- **Lost or broken device:** no data is lost, because devices are only clients.
- **Forgotten parent PIN:** a documented offline reset procedure on the
  home server (a command run inside the API container), not a web feature.

## 9. Testing required before production

- API unit and integration tests (auth on every route, role checks, validation,
  concurrency conflicts, unique completion, transactional redemption, meal
  saves and pruning).
- Migration tests: v1/v2/v3 exports → server, dry run, replace with backup,
  rejection of malformed files.
- Backup and restore rehearsal.
- End-to-end checks on the **real kiosk device** (currently UNVERIFIED)
  and at least one phone, through the access-control layer.
- `/security-review` of the backend and of the deployment configuration.

## 10. Out of scope for now

Implementing any of the above; creating the GitHub repository; publishing
images; deploying; changing any server Compose stack, tunnel or access-control
configuration.
