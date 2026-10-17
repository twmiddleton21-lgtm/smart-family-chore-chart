# Shared family server in Docker (release candidate)

One Node.js container runs the Fastify server, which serves both the app and the API. The family data, parent accounts and paired devices live in one SQLite database under `/data`, on a named volume.

This is a **local release candidate**: build it yourself with a unique tag and test it with made-up data. It is separate from the published `ghcr.io/…/smart-family-chore-chart` image, which is the browser-only app (built from `Dockerfile`/`compose.yaml`) and is not changed by any of this.

Files: `Dockerfile.server`, `compose.server.yaml`. Server details: [SERVER-DEVELOPMENT.md](SERVER-DEVELOPMENT.md).

## Build

```bash
# From the repository root, with Docker running. Use a unique tag (never "latest").
TAG=rc-$(git rev-parse --short HEAD)
docker build -f Dockerfile.server -t smart-family-chore-chart-server:$TAG .
```

The build installs the exact locked dependencies, builds the app (`npm run build:app`) and the server (`npm run build:server`), and keeps only runtime dependencies in the final image. The base image is pinned by tag and digest (the same as `Dockerfile`).

## Run

```bash
SFCC_SERVER_IMAGE=smart-family-chore-chart-server:$TAG \
SFCC_TIMEZONE=Europe/London \
  docker compose -f compose.server.yaml up -d

docker compose -f compose.server.yaml ps      # wait for "healthy"
docker compose -f compose.server.yaml logs app # the first-run setup code is here
```

Then open **http://localhost:3000** on the same computer.

To test next to another installation, give it its own project name (and so its own volume) and port:

```bash
SFCC_SERVER_IMAGE=smart-family-chore-chart-server:$TAG SFCC_HOST_PORT=3195 \
  docker compose -p sfcc-test -f compose.server.yaml up -d
```

### Settings

Compose file variables (read by `compose.server.yaml` only):

| Variable | Default | Meaning |
|---|---|---|
| `SFCC_SERVER_IMAGE` | required | The local image tag to run. There is deliberately no default, so `latest` is never picked by accident. |
| `SFCC_HOST_PORT` | `3000` | Port on this computer. It is published on `127.0.0.1` only. To open it to your network, change the `ports:` line to `0.0.0.0:…` on purpose. |

Server settings, passed through to the container:

| Variable | Default | Meaning |
|---|---|---|
| `SFCC_TIMEZONE` | `UTC` | Household time zone (IANA name), used for "today". An invalid value stops the server. |
| `SFCC_COOKIE_SECURE` | `auto` | `auto` marks the session cookies `Secure` when the request arrived over HTTPS; `always` / `never` force it. |
| `SFCC_TRUST_PROXY` | empty | IP addresses / CIDR ranges of trusted reverse proxies (see below). Empty means none. |

Fixed in the image (`Dockerfile.server`): `NODE_ENV=production`, `SFCC_HOST=0.0.0.0` (inside the container), `SFCC_PORT=3000`, `SFCC_DATA_DIR=/data`, `SFCC_STATIC_DIR=/app/dist-app`. `SFCC_SETUP_CODE` can also be set (12–64 letters/digits), but normally leave it unset so a random code is printed.

### Production mode

The image always runs with `NODE_ENV=production`, which makes the server refuse to start in the development-only unauthenticated mode (`SFCC_DEV_UNAUTHENTICATED_API` or `--dev-unauthenticated-api`). Every family-data route needs a signed-in parent or a paired device.

### Cookies: plain HTTP versus HTTPS behind a proxy

- **Direct local testing over plain HTTP** (`http://localhost:3000`): keep `SFCC_COOKIE_SECURE=auto`. The cookies aren't marked `Secure`, because the browser wouldn't send them over plain HTTP. Only use plain HTTP on your own computer or a network you trust.
- **Behind an HTTPS reverse proxy** (for example a tunnel or Caddy/nginx in front of the container), choose one:
  - `SFCC_COOKIE_SECURE=always`. Cookies are always `Secure`; the site must then only be used over HTTPS.
  - Or list the proxy in `SFCC_TRUST_PROXY` (its address as the container sees it, e.g. the Compose network range `172.18.0.0/16`) and keep `auto`. The proxy's `X-Forwarded-Proto` then decides, and the rate limits apply per real client address, from its `X-Forwarded-For`.
  - Without `SFCC_TRUST_PROXY`, every visitor appears to come from the proxy's address. The per-address sign-in limits are then shared by everyone, so one person's wrong guesses can block sign-in for all, for 15 minutes.
  - The proxy must pass the original `Host` header through. State-changing requests whose `Origin` doesn't match `Host` are refused as cross-site.
- HSTS and TLS are the proxy's job.

## First-run setup

1. Start the container and read the code: `docker compose -f compose.server.yaml logs app` shows `FIRST-RUN SETUP … setup code: XXXX-XXXX-XXXX`. A new code is printed at each start until setup is done.
2. Open the app, enter the code, and create the first parent account (username and a password of at least 10 characters).
3. Add more parents and pair family devices (kiosks) in **Parent area → Family access**. A pairing code works once, for 10 minutes; enter it on the device under **Connect this device**.

## Parent account recovery

There is no e-mail reset. Use the server command line (while the server runs):

```bash
docker compose -f compose.server.yaml exec app node dist-server/cli.js list-parents
docker compose -f compose.server.yaml exec app node dist-server/cli.js reset-password <username>
```

`reset-password` prints a temporary password and signs that parent out everywhere. Sign in with it and change it straight away (Family access). It doesn't clear the sign-in rate limit: a locked-out account waits up to 15 minutes, or the container is restarted.

## Backups and restore

Backups are written to `/data/backups` inside the volume.

```bash
# Online backup (safe while running): consistent, single-file, verified
docker compose -f compose.server.yaml exec app node dist-server/cli.js backup manual
docker compose -f compose.server.yaml exec app node dist-server/cli.js status   # lists backups

# Copy a backup off the volume (keep it as private as the database):
docker compose -f compose.server.yaml cp app:/data/backups/<file> ./
```

Restore is **offline**: stop the server first.

```bash
docker compose -f compose.server.yaml stop app
docker compose -f compose.server.yaml run --rm app node dist-server/cli.js restore /data/backups/<file> --yes
docker compose -f compose.server.yaml start app
```

- The current database is moved to `/data/backups/replaced-<time>.db`, not deleted.
- **A restore signs everyone out.** All sessions, paired devices and pairing codes in the restored copy are removed, so a backup can't bring back a session that was signed out, or a device that was unpaired, after it was taken.
  - Parents sign in again, and kiosks are paired again with new codes.
  - Parent accounts are kept, with the passwords they had when the backup was taken. If a password was changed since, run `reset-password` straight after restoring.
- An import of family data also takes an automatic `pre-import` backup first.
- Backups contain password hashes (never passwords) and the household's data. Store them privately.

## Shutdown and upgrades

- `docker compose -f compose.server.yaml stop` (or `down`) sends `SIGTERM`. The server stops taking requests and closes the database cleanly; Compose allows 30 seconds.
- `down` keeps the named volume. `down -v` **deletes the volume and all family data**: don't use it unless you mean it.
- **To upgrade:**
  1. Take a backup.
  2. Build the new image with a new tag.
  3. Run `up -d` with the new `SFCC_SERVER_IMAGE`.

  On start, a newer version migrates the database after taking an automatic `pre-migration-…` backup. An older image refuses to open a database written by a newer one.

## Hardening in the Compose file

- **Container restrictions:** a read-only root filesystem (only `/data` and a `/tmp` tmpfs are writable), all Linux capabilities dropped, and `no-new-privileges`.
- **Unprivileged user:** the server runs as the `node` user (uid 1000).
- **Port:** published on `127.0.0.1` only by default.
- **Health check:** `/readyz` (database reachable, schema current) every 30 seconds. Health checks aren't written to the request log.
