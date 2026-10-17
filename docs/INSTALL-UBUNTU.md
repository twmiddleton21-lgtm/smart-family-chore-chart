# Install the shared family server on Ubuntu (Docker Compose)

Step-by-step commands for an Ubuntu machine with Docker, for **private testing on your own network** (LAN). Run them in a terminal on that machine (or over SSH).

This is release **0.4.0**: try it with made-up data first. It uses plain HTTP on your LAN, so read [Before you start](#before-you-start).

Placeholders used below (replace them with your own values):

| Placeholder | Meaning | Example |
|---|---|---|
| `<LAN-IP>` | The Ubuntu machine's private network address | `192.168.1.20` |
| `<PORT>` | A free port on that machine for the app | `3080` |
| `<user>` | Your Ubuntu username (only for SSH) | `alex` |

The release used here is **0.4.0**. The image is `ghcr.io/twmiddleton21-lgtm/smart-family-chore-chart-server:0.4.0`, built for **linux/amd64 (x86_64)** only. The release page lists its exact digest: https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/releases/tag/server-v0.4.0

## Before you start

- **Plain HTTP on your LAN.** Passwords and session cookies travel unencrypted between the browser and the server. Anyone on the same network can reach the sign-in page. Only do this on a private network you trust, with test data. HTTPS comes with a reverse proxy or tunnel later.
- **The first-run setup code** is printed in the container log until the first parent account exists. Anyone with that code could create the first account, so do the setup straight away, and don't share the log.
- **Backups** contain the family's data and password hashes. Keep them private.
- **Don't publish it on `0.0.0.0` or to the internet.** Bind it to the machine's LAN address only (below). Don't forward a port on your router.

## 1. Check the machine

```bash
uname -m                      # must print x86_64 (the image is amd64-only)
docker version --format '{{.Server.Version}}'
docker compose version        # Docker Compose v2 plugin
```

If `docker` needs `sudo` on your machine, put `sudo` in front of every `docker` command below (or follow Docker's guide for using it without sudo).

## 2. Find the LAN address and choose a free port

```bash
hostname -I                   # first address is usually the LAN IP, e.g. 192.168.1.20
ip -4 addr show               # more detail: look for your Ethernet/Wi-Fi adapter (eth0, enp…, wlan0)
```

Use the private address (usually `192.168.x.x`, `10.x.x.x` or `172.16–31.x.x`) of the adapter on your home network. Don't use `127.0.0.1`, a Docker address (`172.17.x.x`/`172.18.x.x` on `docker0`/`br-…`), or a VPN address (for example Tailscale's `100.x.x.x`). An address reserved in your router (DHCP reservation) won't change later.

Choose a port that nothing else uses:

```bash
ss -ltn | grep -E ':3080\b' || echo "3080 is free"
docker ps --format '{{.Names}}\t{{.Ports}}'   # ports used by other containers
```

## 3. Get the files

```bash
mkdir -p ~/sfcc-server && cd ~/sfcc-server
BASE=https://raw.githubusercontent.com/twmiddleton21-lgtm/smart-family-chore-chart/server-v0.4.0
curl -fsSLO "$BASE/compose.server.yaml"
curl -fsSL "$BASE/.env.example" -o .env
```

## 4. Configure

Edit `.env` (for example `nano .env`) and set at least:

```ini
SFCC_SERVER_IMAGE=ghcr.io/twmiddleton21-lgtm/smart-family-chore-chart-server:0.4.0
SFCC_BIND_ADDRESS=<LAN-IP>
SFCC_HOST_PORT=<PORT>
SFCC_ALLOWED_HOSTS=<LAN-IP>
SFCC_TIMEZONE=Europe/London
```

- `SFCC_BIND_ADDRESS` publishes the app on that one address, rather than on every network. Leave it as `127.0.0.1` to keep it on this machine only.
- `SFCC_ALLOWED_HOSTS` must contain the address you type in the browser. Requests for any other name are refused with **421**, which protects against DNS-rebinding attacks.
- No secrets are needed: leave `SFCC_TRUST_PROXY` empty, and `SFCC_COOKIE_SECURE=auto` for plain-HTTP LAN testing. Normally leave `SFCC_SETUP_CODE` out, so a random setup code is generated.
- Optional, strongest pinning: use the `…@sha256:<digest>` reference from the release page as `SFCC_SERVER_IMAGE`.

## 5. Get the image and start

```bash
docker pull "$(grep ^SFCC_SERVER_IMAGE= .env | cut -d= -f2)"
docker compose -f compose.server.yaml config --quiet && echo "configuration OK"
docker compose -p sfcc -f compose.server.yaml up -d
```

- The `-p sfcc` project name keeps this installation, and its volume `sfcc_chorechart-data`, separate from your other Compose projects. Use the same `-p sfcc` in every command below.
- The Compose file never pulls or builds by itself (`pull_policy: never`), so it always runs exactly the image you pulled.
- If the machine can't reach `ghcr.io`, use the image archive instead ([below](#no-registry-access-load-the-image-archive)).

## 6. Check it's running

```bash
docker compose -p sfcc -f compose.server.yaml ps                # STATUS should become "healthy"
curl -s http://<LAN-IP>:<PORT>/readyz; echo                     # {"status":"ready",...}
docker compose -p sfcc -f compose.server.yaml logs --tail 50 app
ss -ltn | grep ':<PORT>'                                        # should show <LAN-IP>:<PORT> only
```

## 7. First-run setup

```bash
docker compose -p sfcc -f compose.server.yaml logs app | grep -A1 'FIRST-RUN'
```

1. On your other computer (Windows PC, laptop, tablet) on the same network, open **`http://<LAN-IP>:<PORT>`**.
2. Enter the setup code and create the first parent account. The username is 3–32 letters, numbers, dots, dashes or underscores. The password needs 10 or more characters, mustn't be a very common password, and mustn't contain the username.
3. The setup code then stops working.

From there:
- **Add family members:** add other parents, and pair family devices (kiosks), under **Parent area → Family access**. **Create pairing code** gives a code that works once within 10 minutes; enter it on the device under **Connect this device**.
- **Try it with demo data:** the household starts empty. Parent area → Settings can load a fictional demo family to try things.

## Testing from your Windows PC

- **Address:** use `http://<LAN-IP>:<PORT>`, exactly the address in `SFCC_ALLOWED_HOSTS`. `http://localhost:<PORT>` only works on the Ubuntu machine itself.
- **Can't connect?** In PowerShell on the PC:
  ```powershell
  Test-NetConnection <LAN-IP> -Port <PORT>
  ```
  If `TcpTestSucceeded` is `False`, see [Troubleshooting](#troubleshooting).
- **No LAN exposure:** to test without publishing on the LAN at all, keep `SFCC_BIND_ADDRESS=127.0.0.1` and use an SSH tunnel from the PC, then open `http://localhost:<PORT>` on the PC:
  ```powershell
  ssh -N -L <PORT>:127.0.0.1:<PORT> <user>@<LAN-IP>
  ```

## Backup and restore

```bash
# Online backup (safe while running), written inside the volume to /data/backups
docker compose -p sfcc -f compose.server.yaml exec app node dist-server/cli.js backup manual
docker compose -p sfcc -f compose.server.yaml exec app node dist-server/cli.js status     # lists backups

# Copy a backup out of the volume (keep it private)
docker compose -p sfcc -f compose.server.yaml cp app:/data/backups/<file> ./

# Restore (offline: stop the app first)
docker compose -p sfcc -f compose.server.yaml stop app
docker compose -p sfcc -f compose.server.yaml run --rm app node dist-server/cli.js restore /data/backups/<file> --yes
docker compose -p sfcc -f compose.server.yaml start app
```

- **A restore signs everyone out:** parents sign in again and devices are paired again.
- **Passwords:** they're as they were when the backup was taken.
- **The previous database is kept** at `/data/backups/replaced-<time>.db`.
- **Where data lives:** in the Docker volume `sfcc_chorechart-data`. `docker volume inspect sfcc_chorechart-data` shows its location on disk.
- **No scheduled backups:** run the backup command yourself or from cron.

**Forgotten password:** `docker compose -p sfcc -f compose.server.yaml exec app node dist-server/cli.js reset-password <username>` prints a temporary password. That parent is signed out everywhere; sign in and change it in Family access.

## Update to a newer release

1. Take a backup (above).
2. Set `SFCC_SERVER_IMAGE` in `.env` to the new version.
3. Run:
   ```bash
   docker pull "$(grep ^SFCC_SERVER_IMAGE= .env | cut -d= -f2)"
   docker compose -p sfcc -f compose.server.yaml up -d
   ```

A newer version migrates the database at start-up, after an automatic backup. Keep the old version's tag in case you need to roll back: an older image refuses to open a database written by a newer one, so roll back by restoring the backup.

## Stop, start and uninstall

```bash
docker compose -p sfcc -f compose.server.yaml stop        # stop (keeps everything)
docker compose -p sfcc -f compose.server.yaml start       # start again
docker compose -p sfcc -f compose.server.yaml down        # remove the container; KEEPS the data volume
docker image rm ghcr.io/twmiddleton21-lgtm/smart-family-chore-chart-server:0.4.0   # optional
```

`down` (without `-v`) never deletes the database. Starting it again with `up -d` brings the same data back.

**Deleting all data on purpose:** this permanently deletes the family data and backups in the volume. Take and copy out a backup first if you might want it.

```bash
docker compose -p sfcc -f compose.server.yaml down
docker volume rm sfcc_chorechart-data
```

## No registry access: load the image archive

The release page has `smart-family-chore-chart-server-0.4.0-linux-amd64.tar.gz` and its `.sha256`.

```bash
cd ~/sfcc-server
REL=https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/releases/download/server-v0.4.0
curl -fLO "$REL/smart-family-chore-chart-server-0.4.0-linux-amd64.tar.gz"
curl -fLO "$REL/smart-family-chore-chart-server-0.4.0-linux-amd64.tar.gz.sha256"
sha256sum -c smart-family-chore-chart-server-0.4.0-linux-amd64.tar.gz.sha256
docker load -i smart-family-chore-chart-server-0.4.0-linux-amd64.tar.gz
```

Then continue with step 5, skipping `docker pull`. You can also copy the archive to the machine any other way, for example with `scp` from another computer. [DOCKER-TRANSFER.md](DOCKER-TRANSFER.md) describes moving a locally built image.

## Troubleshooting

| Problem | What to do |
|---|---|
| `bind: address already in use` / port conflict | Choose another `SFCC_HOST_PORT` (see step 2) and run `up -d` again. |
| `cannot assign requested address` | `SFCC_BIND_ADDRESS` isn't an address of this machine. Check it with `hostname -I`. It may have changed; reserve it in your router. |
| Browser shows "This server doesn't answer to this address" (421) | Add exactly the address you typed (for example `<LAN-IP>`) to `SFCC_ALLOWED_HOSTS` in `.env`, then run `docker compose -p sfcc -f compose.server.yaml up -d`. |
| The PC can't connect at all | Check the container is healthy and `ss -ltn` shows `<LAN-IP>:<PORT>`. Check both devices are on the same network (guest Wi-Fi often isolates devices). If a host firewall (for example `ufw`) blocks the port, allowing it is a firewall change for you to decide on. Docker-published ports often bypass `ufw`, but not with every configuration. |
| `exec format error`, or the container restarts immediately | The machine isn't x86_64 (`uname -m`). This release is amd64-only; ARM, such as a Raspberry Pi, isn't supported yet. |
| `required variable SFCC_SERVER_IMAGE is missing` | Run the commands in the folder with `.env`, or set the variable. |
| `No such image` | Run `docker pull …` (step 5), or `docker load` the archive. Compose never pulls this image itself. |
| `permission denied` on the Docker socket | Use `sudo docker …`, or add your user to the `docker` group (that grants root-equivalent access). |
| Database permission errors in the log | Use the named volume from the Compose file, owned by the app's user (uid 1000). If you switch to a bind-mounted folder, it must be writable by uid 1000 (`sudo chown 1000:1000 <folder>`). |
| No setup code in the log | It's only printed while no parent account exists. Restart with `docker compose -p sfcc -f compose.server.yaml restart app` to print a fresh one. If an account exists, sign in, or use `reset-password`. |
| "Too many sign-in attempts" (429) | Wait up to 15 minutes, or restart the container. |
| Sign-in doesn't stick | Keep `SFCC_COOKIE_SECURE=auto` for plain HTTP. `always` only works over HTTPS. |

## What isn't covered yet

- **HTTPS and remote access:** a reverse proxy or Cloudflare Tunnel, with `SFCC_COOKIE_SECURE`, `SFCC_TRUST_PROXY` and `SFCC_ALLOWED_HOSTS` set for it. See [DOCKER-SERVER.md](DOCKER-SERVER.md#trusted-reverse-proxy-exact-requirements).
- **Not yet supported:** ARM images, scheduled backups and live updates between devices.
- **Security limitations:** see the [README](../README.md#security-limitations-of-the-shared-server).
