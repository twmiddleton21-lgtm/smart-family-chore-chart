# Shared family server 0.4.0-rc.1 (release candidate)

The first installable release candidate of the **self-hosted shared family server**. One Docker container serves the app and its API, with the family's data in SQLite on your own machine. It provides:
- parent accounts with passwords;
- kiosks paired with one-time codes;
- shared chores, points, rewards and school meals across devices.

**For private testing on your own network, with made-up data.** It is not production-ready, and it isn't meant for public internet access yet. The existing browser-only app and its `ghcr.io/twmiddleton21-lgtm/smart-family-chore-chart` image (`latest`) are unchanged. This server image is a separate package.

## Install (Ubuntu, Docker Compose)

Full step-by-step guide: [docs/INSTALL-UBUNTU.md](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.4.0-rc.1/docs/INSTALL-UBUNTU.md)

```bash
uname -m                                   # must be x86_64
mkdir -p ~/sfcc-server && cd ~/sfcc-server
BASE=https://raw.githubusercontent.com/twmiddleton21-lgtm/smart-family-chore-chart/server-v0.4.0-rc.1
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

Documentation: [README](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.4.0-rc.1/README.md), [Docker guide](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.4.0-rc.1/docs/DOCKER-SERVER.md), [server details](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.4.0-rc.1/docs/SERVER-DEVELOPMENT.md).
