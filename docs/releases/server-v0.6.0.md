# Smart Family Chore Chart Server v0.6.0

Kiosks now return to the home screen after 2 minutes without input, and parents can look back through 42 days of chore history. **Existing installations update in place and keep all their data.** There are no database changes, so updating from 0.5.0 is just an image change.

**For private networks**, as before. The browser-only app and its `ghcr.io/twmiddleton21-lgtm/smart-family-chore-chart` image (`latest`) are unchanged by this release.

## What's new

- **Kiosks return home after 2 minutes without input** (taps, keys, scrolling), from a chore chart, the rewards page, the Family Calendar or the parent area.
  - **Parent area:** leaving it this way is the same as "Done – lock & exit": it locks, and the parent is signed out. Any open sign-in prompt closes.
  - **Busy screens wait:** text being typed, an open add/edit dialog, unsaved meal changes or a save still on its way. They wait at most 10 minutes without input, so an abandoned form never keeps the kiosk on a parent screen.
  - **Only on shared screens:** paired kiosks (and the browser-only build). A parent's own signed-in device keeps the 30-minute parent idle lock.
  - **Display dimming** is set up on the kiosk device, not by the app. The app uses the same 2-minute time, so both happen together; see [docs/KIOSK-TOUCHSCREEN.md](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.6.0/docs/KIOSK-TOUCHSCREEN.md#returning-home-after-2-minutes-without-input).
- **Chore history** in the parent area: each child's ticked and unticked chores for any day in the last **42 days**.
  - Rounded day and week controls (like the school-meal week picker), Today and Yesterday labels, a per-child filter, and "Back to today".
  - Shows the points each chore actually earned and when it was ticked.
  - **It only reads.** Every completion is kept, including those older than 42 days, so points balances and reward history never change.

## Updating (keeps your data)

Your data stays in the Docker volume `sfcc_chorechart-data`. In `~/sfcc-server` (the folder with `compose.server.yaml` and `.env`), add the same `-f compose.calendar.yaml` (and `-f compose.google-calendar.yaml`) to every command if you use the Family Calendar:

```bash
# 1. Back up and copy the backup off the volume
docker compose -p sfcc -f compose.server.yaml exec app node dist-server/cli.js backup before-update
docker compose -p sfcc -f compose.server.yaml exec app node dist-server/cli.js status     # shows the backup file name
docker compose -p sfcc -f compose.server.yaml cp app:/data/backups/<file> ./

# 2. Switch to 0.6.0 and start it
sed -i 's|^SFCC_SERVER_IMAGE=.*|SFCC_SERVER_IMAGE=ghcr.io/twmiddleton21-lgtm/smart-family-chore-chart-server:0.6.0|' .env
docker pull "$(grep ^SFCC_SERVER_IMAGE= .env | cut -d= -f2)"
docker compose -p sfcc -f compose.server.yaml up -d

# 3. Check it
docker compose -p sfcc -f compose.server.yaml ps                       # wait for "healthy"
docker compose -p sfcc -f compose.server.yaml exec app node dist-server/cli.js status   # "schemaVersion": 4
```

Then open the app and check the children and their points. The [guide](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.6.0/docs/INSTALL-UBUNTU.md#update-to-a-newer-release) has a command that prints every child's points before and after, so you can compare them.

- **From 0.5.0:** nothing in the database changes (schema 4 before and after). Parents and paired kiosks stay signed in. Your `.env`, the calendar key in `secrets/` and the calendar connection are untouched.
- **From 0.4.0:** the database is upgraded once from schema 2 to 4, exactly as described in the [0.5.0 release](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/releases/tag/server-v0.5.0), after an automatic, verified backup.
- **Never run `docker compose … down -v` or delete the volume** while updating: that deletes the family's data.
- **Always use `-p sfcc`:** without it, Compose would start a second, empty installation.

**Going back to 0.5.0:** set the image line back to `:0.5.0` and run `up -d` again (with the same `-f` files). Same database, nothing else to do. Going back to 0.4.0 is in the [guide](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.6.0/docs/INSTALL-UBUNTU.md#going-back-to-the-previous-version).

## New install (Ubuntu, Docker Compose)

Full guide: [docs/INSTALL-UBUNTU.md](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.6.0/docs/INSTALL-UBUNTU.md)

```bash
uname -m                                   # must be x86_64
mkdir -p ~/sfcc-server && cd ~/sfcc-server
BASE=https://raw.githubusercontent.com/twmiddleton21-lgtm/smart-family-chore-chart/server-v0.6.0
curl -fsSLO "$BASE/compose.server.yaml"
curl -fsSL "$BASE/.env.example" -o .env
nano .env    # set SFCC_BIND_ADDRESS=<LAN-IP>, SFCC_HOST_PORT=<PORT>, SFCC_ALLOWED_HOSTS=<LAN-IP>
docker pull "$(grep ^SFCC_SERVER_IMAGE= .env | cut -d= -f2)"
docker compose -p sfcc -f compose.server.yaml up -d
docker compose -p sfcc -f compose.server.yaml logs app | grep -A1 'FIRST-RUN'
```

## Important

- **Plain HTTP:** passwords, cookies and a calendar address typed into Settings aren't encrypted on your LAN. Use a private, trusted network.
- **Backups** contain family data, password hashes and the encrypted calendar connection; keep them private. **A restore signs everyone out.**
- **Keep the calendar key file** (`secrets/sfcc-secret-key.txt`) safe and unchanged.
- **`docker compose … down` keeps the data;** `down -v` or deleting the volume deletes it.
- **Architecture:** linux/amd64 only.

## Known limitations

- **Kiosk device:** the return home and the device's own display dimming use the same time but separate timers. Together they have been checked only in a desktop browser, not yet on a Raspberry Pi kiosk.
- **"Not done" in Chore history** is worked out from today's chore list and schedules, because the app records ticks, not which chores were due each day. A chore added or rescheduled since can show as not done on days before it existed. Deleted chores still show where they were ticked.
- **Stored history keeps growing slowly** (every completion is kept), by a few KB per child per year.
- **The 0.5.0 limitations remain:** calendar providers tested only with synthetic calendars and a mocked Google; not tested behind a reverse proxy or Cloudflare Tunnel; rate limits in memory only; the 0.4.0 session limitations; Node.js's built-in SQLite is still experimental; no licence chosen yet.

Documentation: [README](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.6.0/README.md), [Kiosk touchscreens](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.6.0/docs/KIOSK-TOUCHSCREEN.md), [Family Calendar](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.6.0/docs/GOOGLE-CALENDAR.md).
