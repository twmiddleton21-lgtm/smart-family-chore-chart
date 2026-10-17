# Smart Family Chore Chart Server v0.4.0

The first release of the **self-hosted shared family server**. One Docker container serves the app and its API, with the family's data in SQLite on your own machine. It provides:
- parent accounts with passwords;
- kiosks paired with one-time codes;
- shared chores, points, rewards and school meals across devices.

**For private networks.** It isn't meant for public internet access, and it has the known limitations listed below. The existing browser-only app and its `ghcr.io/twmiddleton21-lgtm/smart-family-chore-chart` image (`latest`) are unchanged. This server image is a separate package.

## Changes since 0.4.0-rc.1

None in the application. This release has the same application code as release candidate [`server-v0.4.0-rc.1`](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/releases/tag/server-v0.4.0-rc.1) (commit `dc93250`). It only changes the version number, the documentation and the release workflow. The image is rebuilt and tested by the release workflow, so its digest differs from the release candidate's. The release candidate and its image remain available.

## Install (Ubuntu, Docker Compose)

Full step-by-step guide: [docs/INSTALL-UBUNTU.md](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.4.0/docs/INSTALL-UBUNTU.md)

```bash
uname -m                                   # must be x86_64
mkdir -p ~/sfcc-server && cd ~/sfcc-server
BASE=https://raw.githubusercontent.com/twmiddleton21-lgtm/smart-family-chore-chart/server-v0.4.0
curl -fsSLO "$BASE/compose.server.yaml"
curl -fsSL "$BASE/.env.example" -o .env
nano .env    # set SFCC_BIND_ADDRESS=<LAN-IP>, SFCC_HOST_PORT=<PORT>, SFCC_ALLOWED_HOSTS=<LAN-IP>
docker pull "$(grep ^SFCC_SERVER_IMAGE= .env | cut -d= -f2)"
docker compose -p sfcc -f compose.server.yaml up -d
docker compose -p sfcc -f compose.server.yaml ps                       # wait for "healthy"
docker compose -p sfcc -f compose.server.yaml logs app | grep -A1 'FIRST-RUN'
```

Then, from another computer on the same network, open `http://<LAN-IP>:<PORT>` and create the first parent account with the setup code.
- Find the LAN IP with `hostname -I`.
- Choose a free port with `ss -ltn`.
- No registry access? Download the image archive attached below and `docker load` it.

## Updating from 0.4.0-rc.1

Take a backup first (see the guide), then in the folder with `compose.server.yaml` and `.env`:

```bash
sed -i 's|^SFCC_SERVER_IMAGE=.*|SFCC_SERVER_IMAGE=ghcr.io/twmiddleton21-lgtm/smart-family-chore-chart-server:0.4.0|' .env
docker pull "$(grep ^SFCC_SERVER_IMAGE= .env | cut -d= -f2)"
docker compose -p sfcc -f compose.server.yaml up -d
docker compose -p sfcc -f compose.server.yaml ps                       # wait for "healthy"
```

The data volume is kept.

## Important

- **Plain HTTP:** passwords and cookies aren't encrypted on your LAN. Use a private, trusted network.
- **The setup code** is in the container log until the first parent exists, so set up straight away.
- **Backups** contain family data and password hashes; keep them private. **A restore signs everyone out.**
- **`docker compose … down` keeps the data;** deleting the volume deletes it (see the guide).
- **Host names:** the server only answers to `localhost`/`127.0.0.1`/`[::1]` and the names in `SFCC_ALLOWED_HOSTS`. Others get 421.
- **Architecture:** linux/amd64 only.

## Known limitations

- **Not tested:** behind a reverse proxy or Cloudflare Tunnel, or on ARM or Raspberry Pi.
- **Rate limits** are kept in memory: a restart resets them. Anyone who can reach the sign-in page can keep a username locked out.
- **Sessions:**
  - An unconfirmed sign-out leaves the session active until a retry succeeds or it expires.
  - Two tabs signing in at the same moment can orphan one session until it expires.
- **Sensitive actions:** adding a parent and creating a pairing code don't ask for the password again.
- **Not yet available:** scheduled backups and live updates between devices.
- **Experimental dependency:** Node.js's built-in SQLite module is still marked experimental.
- **No licence** has been chosen for this project yet.

Documentation: [README](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.4.0/README.md), [Docker guide](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.4.0/docs/DOCKER-SERVER.md), [server details](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.4.0/docs/SERVER-DEVELOPMENT.md).
