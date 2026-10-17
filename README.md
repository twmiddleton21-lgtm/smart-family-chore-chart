# Smart Family Chore Chart

A cheerful family chore chart designed for a large portrait touchscreen (built and tested for 27-inch portrait), and it also works on desktops, tablets and phones. Children tap their profile, tick off Morning, Afternoon and Evening chores, earn points and redeem rewards. The home screen shows each child's school lunch for the day. Parents manage everything from the screen through a PIN-gated parent area.

> **Status: v0.3.0, a single-device, browser-local app.**
> All family data is stored in the **browser's localStorage on one device**. There is **no backend, no shared multi-device data and no server-side authentication**: a kiosk and a phone each keep their own separate data. The parent PIN is a **client-side convenience lock, not security**. The Docker image serves the static app only. See [Known limitations](#known-limitations) and [`docs/SHARED-DATA-PLAN.md`](docs/SHARED-DATA-PLAN.md).

## Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Local development](#local-development)
- [Docker image](#docker-image)
- [Continuous integration](#continuous-integration)
- [Architecture](#architecture)
- [Data, persistence and resetting](#data-persistence-and-resetting)
- [Security and privacy](#security-and-privacy)
- [Known limitations](#known-limitations)

## Features

- **Dashboard:** a large live clock, the date and weekday, a time-of-day greeting, a "Today's school lunch" card, and big profile cards showing each child's avatar, colour, progress today and points balance.
- **Chore chart per child:** Morning, Afternoon and Evening sections with large touch toggles. Done chores show a checkmark, a "Done!" label, a colour change and a strikethrough, so state is never shown by colour alone. Progress and points update instantly.
- **Recurring chores:** every day, or selected weekdays. Completions are keyed by local calendar date, so chores reset on their next scheduled day with no background scheduler.
- **Points and rewards:** points are awarded once per chore per day and reversed if unticked. Balances are always derived from the records, never stored. Rewards can be redeemed with a confirmation and a correct deduction, and are refused when the balance is too low.
- **School meals:** plan each child's **main** and **pudding** up to **6 weeks** ahead (Monday to Friday) using large dropdowns.
  - **Manage Food Options** keeps shared lists of main meals and puddings. Empty names and case-insensitive duplicates are rejected, and an option can't be removed while it's planned.
  - "Copy previous week" and "Clear week" helpers, plus a warning before unsaved changes are discarded.
  - A reminder pops up on the home screen when a child's plan ends within 7 days.
- **Parent area (PIN-gated):**
  - Add, edit and delete children (deleting a child removes all of their records, after confirmation).
  - Add, edit and delete chores, with assigned child, time of day, points and schedule.
  - Add, edit and delete rewards.
  - Change the family name and PIN, and reset the demo data.
  - All forms validate input with clear messages.
- **Persistence:** one validated storage module with automatic, non-destructive upgrades of older saved data. Unreadable data is backed up before recovery.
- **Accessibility:** semantic HTML, labelled controls, keyboard-operable dialogs and tabs, visible focus rings, 48px+ touch targets, live-region feedback and `prefers-reduced-motion` support.
- **Privacy:** no accounts, analytics, ads, trackers, CDNs or external requests. Only a first name or nickname, an emoji avatar and a colour are stored per child.

The app starts with a **fictional demo family** (sample data only). The demo parent PIN is **1234**; change it in Parent area → Settings.

## Prerequisites

- **Node.js 22.12+ or 24** (see `.nvmrc`; CI uses Node 24) and **npm**.
- **Docker** (optional), to build or run the container image.

## Local development

```bash
npm ci                 # install exact versions from package-lock.json
npm run dev            # http://localhost:4174
```

To open the dev server from other devices on your network, run `npm run dev -- --host 0.0.0.0` and browse to `http://<your-computer's-LAN-IP>:4174`. Only do this on a trusted network.

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on port **4174** (`strictPort`: fails instead of switching ports if 4174 is busy). |
| `npm run build` | Type check (`tsc --noEmit`), then production build into `dist/`. |
| `npm run preview` | Serve the built `dist/` on port 4174. |
| `npm test` | Run the Vitest unit tests once. |
| `npm run test:watch` | Tests in watch mode. |
| `npm run typecheck` | TypeScript check (frontend and server). |

**Server (in development):** a backend with a SQLite database is being built for shared multi-device data. The default build doesn't use it. A separate server build (`npm run dev:server:auth` plus `npm run dev:api`) does. The server has parent accounts, device pairing and server-side authorisation (a one-time setup code is printed on first start), but it isn't packaged for installation yet, so it's **not for real family data**. A loopback-only development mode without sign-in also exists (`npm run dev:server`). Export works in both builds. See [`docs/SERVER-DEVELOPMENT.md`](docs/SERVER-DEVELOPMENT.md).

To change the dev port, edit `PORT` in `vite.config.ts` and the `--port` values in `package.json`.

## Docker image

The image is published to GitHub Container Registry:

```
ghcr.io/twmiddleton21-lgtm/smart-family-chore-chart
```

| Tag | Meaning |
|---|---|
| `latest` | The most recent successful build of `main`. Moves with every push. |
| `sha-<full 40-character commit SHA>` | Immutable. Identifies exactly one commit; use it to pin or roll back. |

The image is a static web app served by **nginx (unprivileged, non-root)** on **port 8080**. It includes a health check at `GET /healthz`, strict security headers (same-origin Content-Security-Policy and more), gzip, and long-term caching for hashed assets. It holds **no family data**: data lives in each visitor's browser.

### Pull and run

```bash
docker pull ghcr.io/twmiddleton21-lgtm/smart-family-chore-chart:latest

# Run on this machine only (loopback), then open http://127.0.0.1:8080
docker run -d --name smart-family-chore-chart \
  -p 127.0.0.1:8080:8080 \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  --restart unless-stopped \
  ghcr.io/twmiddleton21-lgtm/smart-family-chore-chart:latest
```

Change `127.0.0.1:8080` to choose where the app is reachable. Publish it beyond the local machine only behind a reverse proxy or tunnel that you trust.

### Docker Compose

`compose.yaml` defines a hardened `web` service: read-only filesystem, all capabilities dropped, `no-new-privileges`, and **no published host port and no volumes** (a static app has nothing to persist). Use it as a starting point:

```bash
docker compose pull
docker compose up -d
```

To reach it, either attach the service to your reverse proxy's network, or publish a port in a local `compose.override.yaml` (not committed), for example:

```yaml
services:
  web:
    ports:
      - "127.0.0.1:8080:8080"
```

Set `SFCC_IMAGE` to pin a specific build, e.g. `SFCC_IMAGE=ghcr.io/twmiddleton21-lgtm/smart-family-chore-chart:sha-<commit> docker compose up -d`.

### Updating

```bash
docker pull ghcr.io/twmiddleton21-lgtm/smart-family-chore-chart:latest
docker compose up -d          # recreates the container only if the image changed
# or, with plain docker run: stop and remove the old container, then run it again with the new image
docker image prune            # optional: remove old, unused images
```

To roll back, run a previous `sha-…` tag. Because family data is stored in browsers, not in the container, updating or recreating the container does not touch it.

### Build locally

```bash
docker build -t smart-family-chore-chart:local .
```

Multi-stage build: `node:24.21.0-alpine3.24` runs `npm ci` and `npm run build`, then `nginxinc/nginx-unprivileged:1.30.5-alpine3.24` serves `dist/`. Both base images are pinned by tag **and** digest.

## Continuous integration

`.github/workflows/ci.yml`:

- **Pull requests to `main`:** `npm ci`, type check, unit tests, production build, and a Docker image build (not published).
- **Pushes to `main`:** the same checks, then build and **publish** the image to GHCR with the `latest` and `sha-<commit>` tags.
- **Least privilege:** `contents: read` everywhere, and `packages: write` only on the publish job, using the built-in `GITHUB_TOKEN` (no stored credentials). Third-party actions are pinned to full commit SHAs.
- **No deployment step.** Pulling and running the image is up to you.

## Architecture

```
src/
  types.ts                 Data model (FamilyData, Child, Chore, Completion, Redemption, MealEntry, FoodOptions…)
  lib/                     Pure, framework-free business logic (unit tested)
    dates.ts               Local date keys, weekdays, schedule checks
    chores.ts              Complete / uncomplete / toggle, progress
    points.ts              Derived balances (earned − spent)
    rewards.ts             Redemption with balance checks
    meals.ts               School-meal planning window, week saving, reminders, editor helpers
    foodOptions.ts         Main/pudding catalog: add, duplicate checks, safe removal
    manage.ts              Parent-area create/edit/delete operations
    validation.ts          Form validation and limits
    storage.ts             The ONLY localStorage access: load, validate, migrate, save, reset
    sampleData.ts          Fictional demo family
    ids.ts                 ID generation (also works outside secure contexts)
  state/                   React hooks: store, time (clock and date rollover), toasts
  components/              Reusable UI (Avatar, ChoreItem, Modal, pickers, lunch card…)
  screens/                 Dashboard, ChildChart, RewardsScreen, ParentGate, parent/*
  styles/                  base.css (tokens), components.css, screens.css
docker/nginx/              nginx site config and security headers for the image
```

**Data flow:** UI event → store action → a pure `lib` function returns new data (or an error) → React state updates → `storage.saveData()` writes to localStorage.

**Stack:** React 19, TypeScript 6, Vite 8, Vitest 5 and plain CSS. No router, UI library, web fonts or CDNs.

## Data, persistence and resetting

- Stored in localStorage under `smart-family-chore-chart:data` as one JSON document (format `version: 3`). Older formats (v1, v2) are upgraded automatically on load without changing existing records.
- Everything is validated on load. Invalid records are dropped (a "repaired" banner is shown). Unreadable data is copied to `smart-family-chore-chart:unreadable-backup` before sample data is loaded.
- Data belongs to one **browser profile and site address**: a different device, browser, private window or URL starts with its own data.

**Reset the demo data:** Parent area → Settings → **Reset to sample data**, or run `localStorage.removeItem('smart-family-chore-chart:data')` in the browser console and reload.

## Security and privacy

- No backend, accounts, analytics, ads, tracking or external requests; family data never leaves the browser.
- All user text is rendered through React (auto-escaped); no `dangerouslySetInnerHTML`.
- Stored data is treated as untrusted and validated field by field.
- **The parent PIN is not real security.** It is stored in plain text in localStorage and checked in the browser, so anyone with developer tools can read or bypass it. It only keeps children out of the settings. After 5 wrong tries there is a 30-second cooldown. The demo PIN hint is shown until the PIN is changed.
- If you expose the app beyond your home network, anyone who can reach it can use it on their own device (with their own separate, browser-local data). Put it behind access control you trust.

## Known limitations

- **Single device per data set:** no sync or shared data between devices; clearing site data erases everything. A shared backend with real authentication is **planned, not implemented** (see [`docs/SHARED-DATA-PLAN.md`](docs/SHARED-DATA-PLAN.md)).
- **No real authentication:** the parent PIN is client-side only.
- No parent approval step for reward redemptions.
- Rewards are shared by all children.
- School meals: no rotating-menu import or option renaming yet. Meals older than 4 weeks are pruned (for all children) when a week is saved.
- Native dropdowns can't wrap long names on narrow screens.
- The meal reminder shows on the shared home screen.
- Automated tests cover business logic plus static rendering checks. There are no browser end-to-end tests yet.
- Only a `linux/amd64` image is published.
