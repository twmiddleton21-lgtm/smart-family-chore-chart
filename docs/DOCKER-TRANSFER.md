# Moving the release-candidate image to another Docker host

A short guide for trying a locally built server image (see [DOCKER-SERVER.md](DOCKER-SERVER.md)) on a separate Docker host, using **test data only**. Nothing is pushed to a registry. The example tag is `rc-41c1169`; use the tag you built and verified.

## 1. On the build computer

```bash
TAG=rc-41c1169
IMAGE=smart-family-chore-chart-server:$TAG

# The image must exist here, and its architecture must match the target host.
docker image inspect $IMAGE --format '{{.Id}} {{.Os}}/{{.Architecture}}'   # e.g. linux/amd64

# Save it to an archive, and note its checksum.
docker save $IMAGE -o sfcc-server-$TAG.tar
sha256sum sfcc-server-$TAG.tar          # PowerShell: Get-FileHash sfcc-server-$TAG.tar
```

## 2. Copy two files to the target host

Copy `sfcc-server-<tag>.tar` and `compose.server.yaml` into a new, empty folder on the target. Any private copy method works, for example:

```bash
ssh user@target-host 'mkdir -p ~/sfcc-rc'
scp sfcc-server-$TAG.tar compose.server.yaml user@target-host:~/sfcc-rc/
```

## 3. On the target host: load and start on localhost

```bash
cd ~/sfcc-rc
TAG=rc-41c1169
sha256sum sfcc-server-$TAG.tar               # must match step 1
docker info --format '{{.Architecture}}'     # must match the image (x86_64 = amd64)
docker load -i sfcc-server-$TAG.tar
docker image inspect smart-family-chore-chart-server:$TAG --format '{{.Id}} {{.Os}}/{{.Architecture}}'

export SFCC_SERVER_IMAGE=smart-family-chore-chart-server:$TAG
export SFCC_TIMEZONE=Europe/London
export SFCC_HOST_PORT=3000                   # pick a free port on that host
docker compose -p sfcc-rc -f compose.server.yaml up -d --pull never
docker compose -p sfcc-rc -f compose.server.yaml ps    # wait until "healthy"
```

- The `-p sfcc-rc` project name keeps this test instance, and its volume `sfcc-rc_chorechart-data`, separate from anything else on the host.
- The Compose file never pulls or builds. It runs exactly `$SFCC_SERVER_IMAGE`, and refuses to start without it.
- The port is published on `127.0.0.1` only. Open **http://localhost:3000** on the target host itself. From another computer, use an SSH tunnel rather than opening the port:

  ```bash
  ssh -L 3000:127.0.0.1:3000 user@target-host   # then open http://localhost:3000 locally
  ```

## 4. Get the first-run setup code

```bash
docker compose -p sfcc-rc -f compose.server.yaml logs app | grep -A1 'FIRST-RUN'
```

Enter it in the app to create the first parent account. A new code is printed at each start until setup is done.

## 5. Shut the test instance down safely

```bash
# Stop (keeps the container and the data):
docker compose -p sfcc-rc -f compose.server.yaml stop

# Remove the container, keep the data volume for later:
docker compose -p sfcc-rc -f compose.server.yaml down

# Finished testing: remove the container AND this instance's test data.
# Only use -v on this test project: it deletes the sfcc-rc_chorechart-data volume.
docker compose -p sfcc-rc -f compose.server.yaml down -v
docker image rm smart-family-chore-chart-server:$TAG   # optional: remove the image too
```

`stop` and `down` send `SIGTERM`. The server closes the database cleanly and Compose allows 30 seconds. Backup, restore and password recovery commands are in [DOCKER-SERVER.md](DOCKER-SERVER.md); add `-p sfcc-rc` to each.

This is a test installation. Try it with made-up data first; see the security limitations in the README before using real family data.
