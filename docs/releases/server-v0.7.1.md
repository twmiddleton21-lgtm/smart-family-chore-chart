# Smart Family Chore Chart Server v0.7.1

Fixes to the seasonal animations from 0.7.0: **snow now falls in front of the cards**, and **Santa's sleigh flies by while someone is actually using the kiosk**. There are no server, data-format or database changes, so **updating from 0.7.0 is just an image change** (and so is going back). Coming from 0.6.0 or earlier, the one-time data upgrade from 0.7.0 still applies; read [Updating](#updating-keeps-your-data).

**For private networks**, as before. The browser-only app and its `ghcr.io/twmiddleton21-lgtm/smart-family-chore-chart` image (`latest`) are unchanged by this release.

## What's changed

- **Snow falls over the content.** In 0.7.0 the snow was drawn behind the page, so the cards and panels covered most of it. It now has its own layer in front of ordinary content (the clock, the lunch card, children's profile cards and chore cards, the parent area's panel), so it's clearly visible.
  - Each flake has a faint cool rim, so it shows on white cards as well as on the night sky. On the parent area and calendar it's a little fainter, as the flying pieces already were.
  - **Essential controls stay on top:** navigation and action buttons, tabs, switches and form fields, the preview bar, messages and every dialog (PIN, sign-in, confirmations) are drawn above the snow and above the flying pieces.
  - Snow never takes a tap, swipe or scroll: taps on a card under the snow reach the card.
- **Santa's fly-bys are timed around someone using the kiosk.** In 0.7.0 the first fly-by came 45–150 seconds after the screen woke, then every 4–10 minutes, while a kiosk display typically dims 2 minutes after the last touch, so Santa usually crossed when nobody was looking.
  - The **first fly-by now comes 15–40 seconds after the screen wakes** (the page starts, or the first tap after the animations paused).
  - A fly-by that falls due while **nobody has touched the screen for 2 minutes**, or while the page is **hidden**, isn't shown over a dim or hidden screen: it **waits for the next tap** (or for the page to be shown again), then comes 15–40 seconds later.
  - Otherwise fly-bys stay 4–10 minutes apart, one at a time, and are removed from the page between crossings. A parent's **Preview** still shows Santa within a few seconds.
- **Unchanged:** the design of every animation (Santa in his red hat with his beard, the red sleigh and sack of presents, four antlered reindeer and Rudolph's glowing nose; the bats, hearts, fireworks and the rest), the 10-minute animation pause, **reduced-motion** support (everything still, no Santa), and the performance approach (only transform and opacity animated, no animation loop in JavaScript, no heavy filters).
  - Measured in desktop Chrome at 1080×1920 with the CPU slowed 4×: 60 frames a second, with the same main-thread work as 0.7.0 within run-to-run noise. **Not yet measured on the Raspberry Pi itself.**

## Updating (keeps your data)

Your data stays in the Docker volume `sfcc_chorechart-data`. In `~/sfcc-server` (the folder with `compose.server.yaml` and `.env`), add the same `-f compose.calendar.yaml` (and `-f compose.google-calendar.yaml`) to every command if you use the Family Calendar:

```bash
# 1. Back up and copy the backup off the volume (while the current version is running)
docker compose -p sfcc -f compose.server.yaml exec app node dist-server/cli.js backup before-update
docker compose -p sfcc -f compose.server.yaml exec app node dist-server/cli.js status     # shows the backup file name
docker compose -p sfcc -f compose.server.yaml cp app:/data/backups/<file> ./

# 2. Switch to 0.7.1 and start it
sed -i 's|^SFCC_SERVER_IMAGE=.*|SFCC_SERVER_IMAGE=ghcr.io/twmiddleton21-lgtm/smart-family-chore-chart-server:0.7.1|' .env
docker pull "$(grep ^SFCC_SERVER_IMAGE= .env | cut -d= -f2)"
docker compose -p sfcc -f compose.server.yaml up -d

# 3. Check it
docker compose -p sfcc -f compose.server.yaml ps                       # wait for "healthy"
docker compose -p sfcc -f compose.server.yaml logs app | grep -E 'format upgraded|data opened|unusable'
docker compose -p sfcc -f compose.server.yaml exec app node dist-server/cli.js status   # "schemaVersion": 4
```

Then open the app and check the children and their points. The [guide](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.7.1/docs/INSTALL-UBUNTU.md#update-to-a-newer-release) has a command that prints every child's points before and after, so you can compare them.

- **From 0.7.0:** nothing in the data or database changes; the before/after check should show **no difference at all**. Parents and paired kiosks stay signed in; `.env` (apart from the image line), the calendar key in `secrets/` and the calendar connection are untouched.
- **From 0.6.0 or earlier:** the first start upgrades the family data format once (v3 → v4), after an automatic backup `/data/backups/chorechart-<time>-pre-format-v3-to-v4.db`, exactly as described in the [0.7.0 release](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/releases/tag/server-v0.7.0). The before/after check shows the state version going up by 1. Themes are on after that upgrade (Christmas from 1 November); parents can switch any of them off.
- **Never run `docker compose … down -v` or delete the volume** while updating: that deletes the family's data.
- **Always use `-p sfcc`:** without it, Compose would start a second, empty installation.

**Going back to 0.7.0:** set the image line back to `:0.7.0` and run `up -d` again (with the same `-f` files). Same data and database, nothing else to do. Going back to 0.6.0 means restoring the pre-upgrade backup with 0.6.0; see the [guide](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.7.1/docs/INSTALL-UBUNTU.md#going-back-to-the-previous-version).

## New install (Ubuntu, Docker Compose)

Full guide: [docs/INSTALL-UBUNTU.md](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.7.1/docs/INSTALL-UBUNTU.md)

```bash
uname -m                                   # must be x86_64
mkdir -p ~/sfcc-server && cd ~/sfcc-server
BASE=https://raw.githubusercontent.com/twmiddleton21-lgtm/smart-family-chore-chart/server-v0.7.1
curl -fsSLO "$BASE/compose.server.yaml"
curl -fsSL "$BASE/.env.example" -o .env
nano .env    # set SFCC_BIND_ADDRESS=<LAN-IP>, SFCC_HOST_PORT=<PORT>, SFCC_ALLOWED_HOSTS=<LAN-IP>
docker pull "$(grep ^SFCC_SERVER_IMAGE= .env | cut -d= -f2)"
docker compose -p sfcc -f compose.server.yaml up -d
docker compose -p sfcc -f compose.server.yaml logs app | grep -A1 'FIRST-RUN'
```

## Important

- **Plain HTTP:** passwords, cookies and a calendar address typed into Settings aren't encrypted on your LAN. Use a private, trusted network.
- **Backups** contain family data, password hashes, birthdays and the encrypted calendar connection; keep them private. **A restore signs everyone out.**
- **Keep the calendar key file** (`secrets/sfcc-secret-key.txt`) safe and unchanged.
- **`docker compose … down` keeps the data;** `down -v` or deleting the volume deletes it.
- **Architecture:** linux/amd64 only.

## Known limitations

- **Not yet seen on a Raspberry Pi kiosk:** the new snow layer and Santa timing were checked in desktop Chrome (automated browser tests, and by eye on a local development server), not yet on the Pi 5 itself or on a live installation.
- **Snow and flying pieces can briefly cover a word** on a card (never a control, and they never take taps). There's no separate switch for them; switching the theme off removes them.
- **While Santa crosses** (about 15 seconds every few minutes) the page does a little more work per frame; in desktop Chrome with the CPU slowed 4× it stayed at 60 frames a second. This is the same as in 0.7.0.
- **The 0.7.0 limitations remain:** birthday rewards only on paired kiosks; on the day itself a kiosk knows whose birthday it is; calendar providers tested only with synthetic calendars and a mocked Google; not tested behind a reverse proxy or Cloudflare Tunnel; rate limits in memory only; Node.js's built-in SQLite is still experimental; no licence chosen yet.

Documentation: [README](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.7.1/README.md), [Kiosk touchscreens](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.7.1/docs/KIOSK-TOUCHSCREEN.md), [Family Calendar](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.7.1/docs/GOOGLE-CALENDAR.md).
