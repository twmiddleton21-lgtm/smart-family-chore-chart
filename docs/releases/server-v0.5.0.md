# Smart Family Chore Chart Server v0.5.0

Adds the read-only **Family Calendar**, kiosk touch improvements and layout fixes to the self-hosted shared family server. **Existing installations update in place and keep all their data**: no reinstall, no new setup.

**For private networks**, as before. The browser-only app and its `ghcr.io/twmiddleton21-lgtm/smart-family-chore-chart` image (`latest`) are unchanged by this release.

## What's new

- **Family Calendar** (optional, read-only), opened from a button on the home screen.
  - **The view:** a whole month, like a wall calendar. Events sit in their days; all-day and multi-day events are coloured bars. "N more" opens a full day, and you can move between months, with **Today** to come back.
  - **Connecting:** one connection for the whole family, made once by a parent in **Parent area → Settings → Integrations**. Use either:
    - **Google Calendar sign-in**, with your own Google OAuth client (no central service involved); or
    - **a private calendar address (iCal)** from Google Calendar, Outlook/Microsoft 365 or iCloud.
  - **Security:**
    - The token or address is encrypted at rest with your own key and never sent back to a browser.
    - Calendar addresses are fetched only from known providers, over HTTPS, with strict network-safety checks.
    - Calendar files are read in a separate worker thread with time and memory limits.
  - **Opt-in:** it's off until you add `compose.calendar.yaml` and a key file. See [docs/GOOGLE-CALENDAR.md](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.5.0/docs/GOOGLE-CALENDAR.md).
- **Kiosk touchscreens:** smoother touch scrolling, with hidden scrollbars and an optional `?dragscroll=1` fallback for kiosk browsers that send touch as mouse input ([docs/KIOSK-TOUCHSCREEN.md](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.5.0/docs/KIOSK-TOUCHSCREEN.md)).
- **Layout:** chore titles are never covered by their points; home-screen cards are more compact.
- **The pre-release strip is gone** from every page. The development-mode (no sign-in) warning is unchanged.

## Updating from 0.4.0 (keeps your data)

Your data stays in the Docker volume `sfcc_chorechart-data`. In `~/sfcc-server` (the folder with `compose.server.yaml` and `.env`):

```bash
# 1. Back up and copy the backup off the volume
docker compose -p sfcc -f compose.server.yaml exec app node dist-server/cli.js backup before-update
docker compose -p sfcc -f compose.server.yaml exec app node dist-server/cli.js status     # shows the backup file name
docker compose -p sfcc -f compose.server.yaml cp app:/data/backups/<file> ./

# 2. Switch to 0.5.0 and start it
sed -i 's|^SFCC_SERVER_IMAGE=.*|SFCC_SERVER_IMAGE=ghcr.io/twmiddleton21-lgtm/smart-family-chore-chart-server:0.5.0|' .env
docker pull "$(grep ^SFCC_SERVER_IMAGE= .env | cut -d= -f2)"
docker compose -p sfcc -f compose.server.yaml up -d

# 3. Check it
docker compose -p sfcc -f compose.server.yaml ps                       # wait for "healthy"
docker compose -p sfcc -f compose.server.yaml exec app node dist-server/cli.js status   # "schemaVersion": 4
```

Then open the app and check the children and their points. The [guide](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.5.0/docs/INSTALL-UBUNTU.md#update-to-a-newer-release) has a command that prints every child's points before and after, so you can compare them.

- **Never run `docker compose … down -v` or delete the volume** while updating: that deletes the family's data.
- **Always use `-p sfcc`:** without it, Compose would start a second, empty installation.
- **What happens at start-up:** the database is upgraded once, from schema 2 to 4. It only adds two calendar tables, after an automatic, verified backup (`/data/backups/chorechart-<time>-pre-migration-v2-to-v4.db`). If the upgrade can't finish, the database stays as it was.
- **Everything is kept:**
  - children, chores, completion history and points, rewards and redemptions, meals, food lists and settings;
  - parent accounts and passwords;
  - sign-ins: parents and paired kiosks stay signed in.
- **No new settings are needed.** The Family Calendar stays off until you set it up.

**Going back to 0.4.0:** 0.4.0 refuses to open an upgraded database rather than risk it. Either:
- restore the automatic pre-migration backup (loses changes made since the update; everyone signs in again); or
- remove only the calendar tables (keeps everything else).

Both are in the guide: [Update to a newer release](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.5.0/docs/INSTALL-UBUNTU.md#update-to-a-newer-release).

## New install (Ubuntu, Docker Compose)

Full guide: [docs/INSTALL-UBUNTU.md](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.5.0/docs/INSTALL-UBUNTU.md)

```bash
uname -m                                   # must be x86_64
mkdir -p ~/sfcc-server && cd ~/sfcc-server
BASE=https://raw.githubusercontent.com/twmiddleton21-lgtm/smart-family-chore-chart/server-v0.5.0
curl -fsSLO "$BASE/compose.server.yaml"
curl -fsSL "$BASE/.env.example" -o .env
nano .env    # set SFCC_BIND_ADDRESS=<LAN-IP>, SFCC_HOST_PORT=<PORT>, SFCC_ALLOWED_HOSTS=<LAN-IP>
docker pull "$(grep ^SFCC_SERVER_IMAGE= .env | cut -d= -f2)"
docker compose -p sfcc -f compose.server.yaml up -d
docker compose -p sfcc -f compose.server.yaml logs app | grep -A1 'FIRST-RUN'
```

## Important

- **Plain HTTP:** passwords, cookies and a calendar address typed into Settings aren't encrypted on your LAN. Use a private, trusted network, or HTTPS or `localhost` when entering a calendar address.
- **Backups** contain family data, password hashes and the encrypted calendar connection; keep them private. **A restore signs everyone out.**
- **Keep the calendar key file** (`secrets/sfcc-secret-key.txt`) safe and unchanged. Without it, the calendar must be connected again (no family data is lost).
- **`docker compose … down` keeps the data;** `down -v` or deleting the volume deletes it.
- **Architecture:** linux/amd64 only.

## Known limitations

- **The update path:**
  - **Verified:** upgrading a database made by 0.4.0 (also with a failure or an interruption part-way), the built server starting on it, and both ways back. All on copies, with made-up data.
  - **Not yet verified:** updating a real Docker volume with the published image. Take the backup and keep a copy outside the volume.
- **Calendar providers:** tested with synthetic calendars and a mocked Google only. Real Google OAuth, real Outlook.com addresses (including links with a `cid-` segment) and iCloud addresses haven't been verified yet.
- **Not tested:** behind a reverse proxy or Cloudflare Tunnel; on ARM or a Raspberry Pi (the touch improvements were checked in desktop Chrome only).
- **In memory only:** rate limits and short-lived checks; a restart resets them.
- **Sessions:** the 0.4.0 limitations remain: an unconfirmed sign-out, and two tabs signing in at once.
- **Experimental dependency:** Node.js's built-in SQLite module is still marked experimental.
- **No licence** has been chosen for this project yet.

Documentation: [README](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.5.0/README.md), [Family Calendar](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.5.0/docs/GOOGLE-CALENDAR.md), [Docker guide](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.5.0/docs/DOCKER-SERVER.md).
