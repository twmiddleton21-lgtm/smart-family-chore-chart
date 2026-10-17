# Shared family server in Docker (release candidate)

One Node.js container runs the Fastify server, which serves both the app and the API. The family data, parent accounts and paired devices live in one SQLite database under `/data`, on a named volume.

This is a **local release candidate**: build it yourself with a unique tag and test it with made-up data. It is separate from the published `ghcr.io/…/smart-family-chore-chart` image, which is the browser-only app (built from `Dockerfile`/`compose.yaml`) and is not changed by any of this.

Files: `Dockerfile.server`, `compose.server.yaml`, `scripts/verify-docker-rc.mjs`. Moving the image to another host: [DOCKER-TRANSFER.md](DOCKER-TRANSFER.md). Server details: [SERVER-DEVELOPMENT.md](SERVER-DEVELOPMENT.md).

## Build

```bash
# From the repository root, with Docker running. Use a unique tag (never "latest").
TAG=rc-$(git rev-parse --short HEAD)
docker build -f Dockerfile.server -t smart-family-chore-chart-server:$TAG .
```

The build installs the exact locked dependencies, builds the app (`npm run build:app`) and the server (`npm run build:server`), and keeps only runtime dependencies in the final image. The base image is pinned by tag and digest (the same as `Dockerfile`).

`compose.server.yaml` never builds or pulls (`pull_policy: never`). It runs exactly the local tag in `SFCC_SERVER_IMAGE`, and refuses to start without one. To move the image to another Docker host, see [DOCKER-TRANSFER.md](DOCKER-TRANSFER.md).

## Verify an image

```bash
npm run verify:docker -- --image smart-family-chore-chart-server:$TAG [--port 3194]
```

This runs the image in a disposable Compose project (`sfcc-verify-<id>`, with its own volume) using made-up data, and checks:
- start-up and health;
- that development mode can't be enabled;
- first-run setup, parent sign-in, pairing and shared data;
- persistence across a restart;
- kiosk reload, the idle lock and sign-out;
- backup and restore, including that old sessions are refused afterwards;
- `reset-password`.

At the end it removes only what it created. It refuses ports 4173, 4174 and any port already in use, and never pulls or builds an image. It needs Docker and Google Chrome, as the browser tests do. Exit code 0 means every check passed.

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
- **Behind an HTTPS reverse proxy**: either set `SFCC_COOKIE_SECURE=always` (cookies always `Secure`; the site must then only be used over HTTPS), or configure `SFCC_TRUST_PROXY` as below and keep `auto`.
- Without `SFCC_TRUST_PROXY`, every visitor appears to come from the proxy's address. The per-address sign-in, setup and pairing limits are then shared by everyone, so one person's wrong guesses can block sign-in for all, for 15 minutes. The per-account limit applies either way.

### Trusted reverse proxy: exact requirements

This hasn't been tested with a real proxy or tunnel. The behaviour below is what the code does, covered by unit tests with simulated proxy requests.

`SFCC_TRUST_PROXY` takes a comma-separated list of **IP addresses or CIDR ranges**, such as `172.30.0.10` or `172.30.0.0/24`. Anything else stops the server: a host name, `*`, `true`, `all`, or an out-of-range prefix. When a request's **direct connection** comes from a listed address, the server believes:
- **`X-Forwarded-For`**: the client address used by the rate limits (sign-in, setup codes, pairing codes). It's read from the right, skipping listed proxies; the first address that isn't listed counts as the client.
- **`X-Forwarded-Proto`** (its last value): `https` makes `SFCC_COOKIE_SECURE=auto` mark cookies `Secure`.

Nothing else changes:
- `X-Forwarded-Host` is ignored.
- The cross-site check still compares the browser's `Origin` with the request's own `Host` header.
- Authentication and session rules don't depend on the proxy.

Requirements:
1. **List every proxy hop the container sees, and only those.** List the proxy's address as seen from inside the container: its container IP on a shared Docker network, or that network's range if it holds nothing but the proxy and this app. If a request passes through two proxies, list both. Any listed address can set these headers, so a listed address must not be shared with anything else.
2. **Don't trust the Docker host gateway** (for example `172.17.0.1`/`172.18.0.1`). Traffic through a published port appears to come from there, so trusting it would let any program that can reach the port choose its own client address.
3. **The proxy must append the real client address to `X-Forwarded-For`** (most proxies do), **and send `X-Forwarded-Proto: https`.** Entries a client adds itself are on the left and are skipped, as long as the proxy appends the address it saw.
4. **The proxy must pass the original `Host` header through.** If it rewrites `Host` (to `app:3000`, for example), every sign-in, change and sign-out is refused as cross-site (403).
5. **Don't publish the app's port to your network when using a proxy.** Keep the `127.0.0.1` port, or remove `ports:` if the proxy reaches the container over a shared Docker network.
6. With the proxy trusted, keep `SFCC_COOKIE_SECURE=auto`, or use `always` to require HTTPS no matter what. Over plain HTTP, `Secure` cookies aren't sent back, so sign-in won't work. That's intended.
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

**Git Bash on Windows** rewrites arguments that look like Unix paths (such as `/data/backups/…`) before Docker sees them, so the restore fails with "File not found". Run it as `MSYS_NO_PATHCONV=1 docker compose … restore /data/backups/<file> --yes`, or use PowerShell, where it works as shown.

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
