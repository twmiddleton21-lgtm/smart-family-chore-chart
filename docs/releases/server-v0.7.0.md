# Smart Family Chore Chart Server v0.7.0

Seasonal themes and birthday celebrations. Parents choose which themes show and when; on a child's birthday the kiosk celebrates and can give a birthday reward, once a year. **Existing installations update in place and keep all their data**, but this release **upgrades the family data format once (v3 → v4)**, after an automatic backup. Going back to 0.6.0 afterwards means restoring that backup; read [Updating](#updating-keeps-your-data) first.

**For private networks**, as before. The browser-only app and its `ghcr.io/twmiddleton21-lgtm/smart-family-chore-chart` image (`latest`) are unchanged by this release.

## What's new

- **Themes & Celebrations** (Parent area → Themes & Celebrations, also linked from Settings):
  - **New Year, Valentine's Day, Easter, Halloween and Christmas**, each with an on/off switch, its own dates (or the defaults), "Restore default dates", and **Preview**, which shows a theme on that screen only and saves nothing.
  - Christmas runs from 1 November to 25 December by default, with a countdown; Easter is calculated each year.
  - **Every screen is themed:** sign-in and pairing, home, chore charts, rewards, the Family Calendar and the parent area (with a readable panel on dark skies).
- **Animations:** falling snow and fairy lights, glowing pumpkins and bats with flapping wings, rising hearts, fireworks. Now and then at Christmas, **Santa's sleigh and reindeer fly across** the screen.
  - Flying pieces pass in front of the screens but **never take a tap, swipe or scroll**, fade while someone types, and stay below every dialog (PIN, sign-in, confirmations).
  - Animations **pause after 10 minutes without input** and start again at the next tap. With the device's **reduced-motion** setting, everything is still and Santa doesn't fly.
- **Birthdays** (Children → 🎂 Birthday): a day and month per child (no year), an optional **reward** (bonus points and/or a gift), and a birthday celebration on the day.
  - The reward is given at the **first tap on a paired kiosk** on the birthday, **once per child per year**, however many kiosks or taps; the server checks this in one transaction.
  - It shows in the child's points, their Rewards screen ("Birthday bonus 2026") and the parent's Chore history.
- **Privacy:** birthdays and reward settings are sent only to signed-in parents. A paired kiosk learns only whose birthday it is on the day; afterwards it keeps each reward's year, points and gift, **never the day**, so it can't work a birthday out later.
- **New public endpoint** `GET /api/celebrations/theme`: only which theme shows today and its dates (no names, birthdays or family details), for the screens shown before sign-in.

## Updating (keeps your data)

Your data stays in the Docker volume `sfcc_chorechart-data`. In `~/sfcc-server` (the folder with `compose.server.yaml` and `.env`), add the same `-f compose.calendar.yaml` (and `-f compose.google-calendar.yaml`) to every command if you use the Family Calendar:

```bash
# 1. Back up and copy the backup off the volume (while 0.6.0 is running)
docker compose -p sfcc -f compose.server.yaml exec app node dist-server/cli.js backup before-update
docker compose -p sfcc -f compose.server.yaml exec app node dist-server/cli.js status     # shows the backup file name
docker compose -p sfcc -f compose.server.yaml cp app:/data/backups/<file> ./

# 2. Switch to 0.7.0 and start it
sed -i 's|^SFCC_SERVER_IMAGE=.*|SFCC_SERVER_IMAGE=ghcr.io/twmiddleton21-lgtm/smart-family-chore-chart-server:0.7.0|' .env
docker pull "$(grep ^SFCC_SERVER_IMAGE= .env | cut -d= -f2)"
docker compose -p sfcc -f compose.server.yaml up -d

# 3. Check it
docker compose -p sfcc -f compose.server.yaml ps                       # wait for "healthy"
docker compose -p sfcc -f compose.server.yaml logs app | grep -E 'format upgraded|data opened|unusable'
docker compose -p sfcc -f compose.server.yaml exec app node dist-server/cli.js status   # "schemaVersion": 4
```

Then open the app and check the children and their points. The [guide](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.7.0/docs/INSTALL-UBUNTU.md#update-to-a-newer-release) has a command that prints every child's points before and after, so you can compare them; from 0.6.0 the only expected difference is the **state version going up by 1**.

- **What happens at the first start:** 0.7.0 writes an automatic backup, `/data/backups/chorechart-<time>-pre-format-v3-to-v4.db`, then upgrades the family data format **v3 → v4** in one step. The log says `family data format upgraded (backup taken first)`. It only adds the theme settings (**all themes on**, default dates), an empty birthday list and empty birthday awards. Every child, chore, tick, reward, meal and setting is kept exactly. **The database schema stays at 4.**
- **If the stored data has anything invalid,** 0.7.0 refuses to upgrade, changes nothing and doesn't start. Set the image line back to `:0.6.0` and start it again; the data is untouched.
- **Parents and paired kiosks stay signed in.** Your `.env`, the calendar key in `secrets/` and the calendar connection are untouched.
- **Themes are on after the update** (Christmas from 1 November). Parents can switch any of them off in Themes & Celebrations.
- **Never run `docker compose … down -v` or delete the volume** while updating: that deletes the family's data.
- **Always use `-p sfcc`:** without it, Compose would start a second, empty installation.

**Going back to 0.6.0:** 0.6.0 can't read the v4 format; it refuses to start ("Family data has an unusable shape or version") rather than lose birthdays and birthday points. Restore the automatic pre-upgrade backup with 0.6.0. Changes made since the update are lost, and everyone signs in again (kiosks are paired again):

```bash
docker compose -p sfcc -f compose.server.yaml stop app
sed -i 's|^SFCC_SERVER_IMAGE=.*|SFCC_SERVER_IMAGE=ghcr.io/twmiddleton21-lgtm/smart-family-chore-chart-server:0.6.0|' .env
docker compose -p sfcc -f compose.server.yaml run --rm app node dist-server/cli.js restore /data/backups/<the chorechart-…-pre-format-v3-to-v4.db file> --yes
docker compose -p sfcc -f compose.server.yaml up -d
```

This was rehearsed with the real 0.6.0 and 0.7.0 code on throwaway data: upgrade, refusal by 0.6.0, 0.6.0's own `restore`, and 0.6.0 starting with exactly the data from before the update. It hasn't been tried inside Docker on a real volume, so keep the backup copy from step 1.

## New install (Ubuntu, Docker Compose)

Full guide: [docs/INSTALL-UBUNTU.md](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.7.0/docs/INSTALL-UBUNTU.md)

```bash
uname -m                                   # must be x86_64
mkdir -p ~/sfcc-server && cd ~/sfcc-server
BASE=https://raw.githubusercontent.com/twmiddleton21-lgtm/smart-family-chore-chart/server-v0.7.0
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

- **Not yet seen on a Raspberry Pi kiosk:** the themes, animations and birthday celebration have been checked in desktop Chrome (including with the CPU slowed 4×, at 60 frames a second), not yet on the Pi 5 itself.
- **Flying pieces can briefly cover a word** or cross the home banner (they never take taps). There's no separate switch for them; switching the theme off removes them.
- **Birthday rewards are given only on shared screens** (paired kiosks). A household with no paired kiosk doesn't get them automatically.
- **On the day itself, a kiosk knows whose birthday it is** (it shows the celebration).
- **The 0.6.0 limitations remain:** calendar providers tested only with synthetic calendars and a mocked Google; not tested behind a reverse proxy or Cloudflare Tunnel; rate limits in memory only; Node.js's built-in SQLite is still experimental; no licence chosen yet.

Documentation: [README](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.7.0/README.md), [Kiosk touchscreens](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.7.0/docs/KIOSK-TOUCHSCREEN.md), [Family Calendar](https://github.com/twmiddleton21-lgtm/smart-family-chore-chart/blob/server-v0.7.0/docs/GOOGLE-CALENDAR.md).
