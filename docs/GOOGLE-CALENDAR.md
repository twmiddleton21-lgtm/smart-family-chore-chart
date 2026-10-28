# Family Calendar (Google Calendar or a private iCal address, read-only)

The shared family server can show the family's calendar on a **Family Calendar** page, opened from a button on the home screen. The page shows a **whole month**, laid out like a wall calendar or Google Calendar's month view.
- **The grid:** Sunday to Saturday, including the neighbouring months' days at either end. Events sit inside their days; all-day and multi-day events are coloured bars.
- **Moving around:** previous and next month, up to a year either way, and **Today** to come back.
- **A full day:** if a day has more events than fit, it shows "N more". Selecting a day, an event or "N more" lists that day in full.

The browser-only edition doesn't have this page: the calendar is fetched by the server.

**One connection belongs to the whole family.**
- A parent connects the family's calendar **once**, in **Parent area → Settings → Integrations → Family calendar**.
- Every parent and every paired family device (kiosk, tablet) then sees the same calendar. Nobody else connects anything.
- The connection survives server restarts, page reloads and signing out and in. It stays until a parent disconnects or replaces it, or the provider withdraws it.

**Two ways to connect, and the family uses one of them at a time:**

| | **Google Calendar sign-in (OAuth)** (recommended) | **Private calendar address (iCal)** |
|---|---|---|
| Server operator sets up | A secret key, plus **their own** Google Cloud OAuth client (once) | A secret key only |
| Parent does | Presses **Connect**, signs in to Google, allows "See your calendars" | Copies the calendar's secret address and pastes it in |
| Calendars | Any calendar the Google account can read, including ones shared with it; switch between them in Settings | The one calendar the address belongs to |
| Providers | Google | Google, Outlook / Microsoft 365, iCloud, plus hosts the operator allows |
| Credential held by the server | A refresh token (encrypted) that a parent can withdraw in the Google account | The address itself (encrypted). It works like a password until it is reset at the provider |
| Freshness | Live: events.list on each refresh (at most every 5 minutes) | As fresh as the provider updates the address (Google: often several hours) |
| Needs HTTPS or `localhost` for the server | Yes, for Google's redirect | Not required, but **strongly recommended** while a parent enters the address: over plain `http://` the secret address crosses the network unencrypted (see [Entering the address safely](#entering-the-address-safely)) |

The app only **reads** events. It never adds, changes or deletes them. Only titles, start and end times, and locations are shown. Descriptions, attendees, organisers and links are never fetched from Google, and are dropped from iCal feeds.

**No central service is involved.** Each installation talks directly to Google or the calendar provider. There's no maintainer-run OAuth broker, proxy or hosted service, no shared client secret and no extra hosting or paid dependency (see [Decision history](#decision-history)).

## Who does what

| Who | What | How often |
|---|---|---|
| **Server operator**: whoever installs and runs this family's server | Create the secret key. For Google sign-in, also create a Google Cloud project and OAuth client, and provide an HTTPS address (or use `localhost`) | Once per installation |
| **A parent** in the family | Connect the calendar with one of the two methods; optionally choose which Google calendar to show | Once per family; again only to switch, or if access is withdrawn |
| **Children, kiosks, other parents** | Nothing. They open the Family Calendar. | Never |

## How it works

```
Google sign-in:
Parent's browser ──"Connect"──▶ family server ──▶ Google consent page (accounts.google.com)
        ▲                                                          │
        └────── /#google-calendar=connected ◀── /api/calendar/google/callback (code + state)
                                 family server exchanges the code (its own client secret + PKCE)
                                 and stores the refresh token ENCRYPTED in its database

Calendar address:
Parent's browser ──address──▶ POST /api/calendar/ical/check ──(SSRF-checked HTTPS GET)──▶ provider
        ▲                       the server keeps the address in memory and answers with a check ID,
        │                       the calendar's name, its host and what it would replace
        └──"Use this calendar"──▶ POST /api/calendar/ical/use ── stores the address ENCRYPTED

Showing it:
Kiosks, parents ──GET /api/calendar──▶ family server ──read-only──▶ Google Calendar API or the iCal address
```

- **One connection per household, enforced by the database.** It is stored in the family's own database: `google_calendar_connection` or `ical_feed_connection`, each with at most one row. Database triggers refuse a second connection of the other kind.
- **Who may do what** (the existing sign-in rules):
  - Family Calendar (`GET /api/calendar`): a signed-in parent or a paired device.
    - The month view asks for its grid's dates with `?start=YYYY-MM-DD&end=YYYY-MM-DD`. Without them, the answer covers today and the next six days.
    - A range may cover at most 42 days and reach about a year either side of today; anything else is refused with 400. This stops a device making the server read arbitrary stretches of the calendar.
  - Settings (`/api/calendar/connection`, `/api/calendar/google/*`, `/api/calendar/ical/*`): signed-in parents only. Paired devices get 403; anyone else gets 401.
  - These checks are on the server, not just hidden buttons.
- **No cross-family access.** Another family is another installation, with its own database and its own secret key. A copied database row is useless without that key, and a check ID only works on the server that issued it, for the parent who made it.
- **Caching:**
  - Events are cached for 5 minutes per month shown and shared by every device, with one request to the provider per month at a time.
  - A calendar address's download is reused for 2 minutes, so looking through several months fetches it once.
  - After a failure, every device gets the same answer for 1 minute, so a failing provider isn't asked again by every kiosk.
  - If the provider is briefly unreachable, the last good copy of that month is shown, marked as older.
  - Settings shows when the calendar was last read successfully (since the server started) and why the last read failed, if it did.
- **Disconnecting** deletes the stored token or address and drops the cached events at once, so the calendar stops showing everywhere.
  - Google: the server also asks Google to revoke the grant.
  - Calendar address: providers can't be told. Reset the address at the provider to stop it working anywhere else.

### Switching method, or replacing the connection

The family has **one active connection**. To switch, or to use a different address:

1. **The new connection is validated first.**
   - Google: sign-in, the code exchange and reading the calendar list must all succeed.
   - A calendar address: the server fetches it and checks that it really is a calendar.
2. **The parent sees what will be replaced** (for example "Family via Google Calendar sign-in (family@example.com)") and must confirm.
   - The server refuses to replace without that confirmation (`409 confirm_replace`).
   - If the connection changed since the parent was asked (another parent changed it), the parent is asked again.
3. **The swap is one database transaction:** the old row is deleted and the new one stored together. If anything fails, the old connection stays exactly as it was.
4. **If validation fails or the parent cancels** (including pressing Cancel on Google's page), nothing changes.
5. **Replacing Google with an address** also revokes the old Google grant (best effort; the app says if Google couldn't be told).
6. **If another parent changes the calendar while you're on Google's consent page,** nothing is replaced and the new Google grant is returned (`#google-calendar=changed`).

Reconnecting the same Google connection (for example after Google withdrew access) is not a switch and needs no confirmation.

## Security

### Secrets

- **Encryption at rest.** The Google refresh token and the calendar address are encrypted with AES-256-GCM.
  - The key is a deployment secret (`SFCC_SECRET_KEY_FILE`) and is never stored in the database.
  - Each value is bound to its purpose, so a ciphertext can't be moved to the other column and still decrypt.
  - A key fingerprint is stored to notice a changed key; the app then asks a parent to reconnect.
- **Access tokens** live only in server memory and are refreshed shortly before they expire.
- **Nothing secret goes back to a browser.**
  - No token, code, client secret or calendar address is ever sent to a browser or put in an API answer, error message or log line.
  - After the one check request that carries it, the address isn't sent anywhere else. API answers show only the provider and host, for example `Google Calendar · calendar.google.com`.
  - The browser clears the address field as soon as the server has checked it.
  - Logged request addresses have their query strings removed. Request bodies are never logged.
- **Tests enforce it.** They check that no secret value appears in any response body, header or log line, and that the database file doesn't contain the address in plain text.

### Fetching calendar addresses safely (SSRF protection)

A parent-supplied address could otherwise turn the server into a proxy that reaches the home network, Docker networks or cloud metadata. `server/calendar/safeFetch.ts` and `server/calendar/icalFeed.ts` apply these rules to every fetch and every redirect hop:

- **Supported providers only.** The address must match one of the formats below, or use a host the operator listed in `SFCC_CALENDAR_FEED_HOSTS`.
- **HTTPS on port 443 only.** `webcal://` is read as `https://`.
- **No tricks in the address.**
  - No user name or password in it.
  - No IP literals in any spelling: `127.0.0.1`, `2130706433`, `0x7f.1`, `[::1]` and `[::ffff:…]` are all refused.
  - No look-alike or sub-domain hosts, no trailing dots, no fragments, no control characters or spaces.
- **Public addresses only, checked where the connection is made.** The address check runs inside the socket's own DNS lookup, so the address that was checked is the address connected to: a name that resolves differently a moment later (**DNS rebinding**) can't slip through.
  - If any resolved address is not public unicast, nothing is connected.
  - Refused IPv4: loopback, private (10/8, 172.16/12, 192.168/16, including Docker's networks), carrier-grade NAT, link-local (including the cloud metadata address `169.254.169.254`), multicast, reserved, broadcast and documentation ranges.
  - Refused IPv6: everything outside 2000::/3. That covers loopback, unique-local (including `fd00:ec2::254`), link-local, multicast, IPv4-mapped and -compatible addresses, and NAT64. Teredo, 6to4 and documentation ranges are refused too.
  - The connected peer's address is checked again as soon as the TCP connection opens. Over HTTPS that is before the TLS handshake, so before any part of the address (its secret path) is sent. It is checked once more on the response.
  - **Limitation, IPv6-only networks:** NAT64 addresses (`64:ff9b::/96`) are refused, so on a network that reaches IPv4-only providers only through NAT64, those providers can't be fetched. Give the server IPv4 access, or use Google sign-in.
- **Redirects:** at most 3, and each hop must pass every rule above, with its own DNS lookup and check. A redirect's connection is closed as soon as the redirect is accepted; its body is never read.
- **Limits:**
  - 5 seconds to connect, 15 seconds in total.
  - 5 MB per calendar, counted after gzip decompression, so a compressed "bomb" is cut off.
  - Web pages (`text/html`, JSON) are refused, and the content must be iCalendar.
  - Checking addresses is limited to 10 per 15 minutes for the household. Showing the calendar reads it at most once every 5 minutes (once a minute while it is failing).
- **Nothing extra is sent.** No cookies, credentials or forwarded headers: only `Accept`, `Accept-Encoding` and `User-Agent`. A fresh connection is used each time, with no shared pool or proxy.
- **Parsing is bounded, and can't hold up the server.**
  - The maintained [`ical.js`](https://github.com/kewisch/ical.js) parser (Mozilla) is used, with time zones read from each feed's own definitions, so feeds can't affect each other.
  - **In a worker thread.** Each fetched calendar is read in its own worker thread, so the server keeps answering everyone else meanwhile. The worker is stopped after **3 seconds**, or if it uses more than 256 MB, and at most two are read at once. This is what stops a repeat rule that can never match (such as "every 30 February"): inside ical.js, one such rule ran for minutes in a single call, which no step-by-step limit can interrupt.
  - **A work limit.** Inside the worker, reading stops after **1.5 seconds** of work, checked every 64 steps of every loop. The feed then fails as "too many events or too complex", and the last good copy keeps being shown.
  - **Measured on a development PC:** 20,000 events took about 0.25 s, and a calendar with 100 weekly series since 2015 plus 20 daily ones since 2010 took about 0.06 s. These timings are indicative, not guarantees for other hardware.
  - **Old events cost little.** Events outside the week shown are skipped before they are converted. Daily and weekly series that started years ago are skipped ahead by whole repeat periods (unless they use COUNT or RDATE), which gives exactly the same occurrences.
  - **Caps:** at most 50,000 events per calendar (about what fits in 5 MB), 20,000 repeat steps per series and 400,000 per calendar, and at most 500 events returned. Every-second and every-minute repeat rules are skipped.
- **Errors are vague on purpose.** Error messages name the problem (for example "refused", "not found", "too large", "not a calendar") but never the address or an internal IP.

**Limitation:** these rules decide which addresses the server will *contact*. They can't stop the provider itself from serving wrong events. A calendar address is also only as private as the people who have seen it.

### Supported calendar address formats

| Provider | Where to find it | Format accepted |
|---|---|---|
| Google Calendar | Google Calendar on the web → Settings → your calendar → **Integrate calendar** → **Secret address in iCal format** (the public address works too, for public calendars) | `https://calendar.google.com/calendar/ical/<calendar ID>/private-<key>/basic.ics` (or `…/public/basic.ics`) |
| Microsoft 365 | Outlook on the web → Settings → Calendar → **Shared calendars** → **Publish a calendar** → ICS link | `https://outlook.office365.com/owa/calendar/<id>/<key>/calendar.ics` (or `…/reachcalendar.ics`) |
| Outlook.com | As for Microsoft 365 | `https://outlook.live.com/owa/calendar/<id>/<key>/calendar.ics`, or with one extra `cid-<hex>` segment: `…/<id>/<key>/cid-<hex>/calendar.ics` |
| iCloud | Calendar → share a calendar as a **Public Calendar** → copy the link | `webcal://pNN-caldav.icloud.com/published/2/<key>` |
| Other hosts | Only if the operator lists the host in `SFCC_CALENDAR_FEED_HOSTS` | Any `https://` address on that host |

**Not yet confirmed with real accounts (UNVERIFIED):** these formats come from the providers' published address shapes and commonly reported examples, and are tested only with synthetic addresses. In particular:
- whether real Outlook.com links use the `cid-` segment;
- whether iCloud serves `webcal://` links over HTTPS without signing in;
- whether a provider redirects to a host outside its own (that would be refused as "points somewhere this server won't connect to").

If a genuine address is refused, please report the provider and the *shape* of the address (never the address itself).

`webcal://` and `webcals://` (any capitalisation) are rewritten to `https://` before any check, so they are fetched over HTTPS on port 443 only. A port in the address is still refused.

Google's secret address is only available in Google Calendar on the web, not in the phone apps, and Google Workspace administrators can turn it off. Changes made in Google Calendar can take **several hours** to appear in the iCal address (the provider decides; this app can't speed it up).

## Server operator: one-time setup

### 1. The secret key (both methods)

Work in the installation's folder, `~/sfcc-server` in the [installation guide](INSTALL-UBUNTU.md), which holds `compose.server.yaml` and `.env`. Put `compose.calendar.yaml` from the same release next to them (and, for Google sign-in, `compose.google-calendar.yaml`).

```bash
cd ~/sfcc-server
BASE=https://raw.githubusercontent.com/twmiddleton21-lgtm/smart-family-chore-chart/server-v0.6.0
curl -fsSL -O "$BASE/compose.calendar.yaml" -O "$BASE/compose.google-calendar.yaml"   # the add-on files, if you don't have them yet
mkdir -p secrets
openssl rand -base64 32 > secrets/sfcc-secret-key.txt   # once only: a new key means connecting the calendar again
sudo chown 1000:1000 secrets/sfcc-secret-key.txt && sudo chmod 400 secrets/sfcc-secret-key.txt   # the container runs as uid 1000
docker compose -p sfcc -f compose.server.yaml -f compose.calendar.yaml config --quiet && echo "configuration OK"
docker compose -p sfcc -f compose.server.yaml -f compose.calendar.yaml up -d
docker compose -p sfcc -f compose.server.yaml -f compose.calendar.yaml logs app | grep -i calendar
# → "Calendar addresses (iCal) available (read-only)"
```

**Always use the installation's project name, `-p sfcc`, as the installation guide does.** The add-on file then changes the existing installation: the same `app` service and container, and the same data volume `sfcc_chorechart-data`, so the family's data is kept.
- **A different project name means a separate installation.** Without `-p sfcc`, Compose names the project after the folder (`sfcc-server` for `~/sfcc-server`).
  - It then creates a **second container with a new, empty data volume** (`sfcc-server_chorechart-data`), or fails with "port is already allocated".
  - Nothing is deleted, but the family's data would seem to be missing.
  - If that happened, remove only the accidental project, by its name, and keep every volume:
    ```bash
    docker compose ls     # lists sfcc and the accidental project (e.g. sfcc-server)
    docker compose -p sfcc-server -f compose.server.yaml -f compose.calendar.yaml down   # the ACCIDENTAL project only; no -v
    docker compose -p sfcc -f compose.server.yaml -f compose.calendar.yaml up -d
    ```
- **Use the same `-f` files in every command for this installation**, including the installation guide's update, backup and restore commands, which show only `-f compose.server.yaml`. This matters most for `up`: it recreates the container from just the files given, so leaving the add-on file out starts the server without the calendar settings. The stored connection is kept, but the calendar shows "Not set up" until the server is started with the add-on file again.

That's all a calendar address needs. Parents can now use **Settings → Integrations → Family calendar → A calendar address (iCal)**.

**Keep `secrets/sfcc-secret-key.txt` safe and unchanged.**
- Losing or changing it doesn't lose family data, but parents must connect the calendar again.
- Backups contain the encrypted connection. They can only use it together with this key, so store the key separately from backups.

### 2. Google Calendar sign-in (optional, recommended)

You'll need:
- A Google account to own the Google Cloud project. This can be the family's account.
- An address Google accepts for the redirect:
  - **HTTPS with a real host name** (recommended), for example `https://chores.example.com` behind a reverse proxy or tunnel, **or**
  - **`http://localhost:<port>`**, if a parent connects from the server machine itself (directly or through an SSH tunnel, see below).
  - Google refuses plain `http://` on LAN addresses such as `http://192.168.1.20:3080`.

The OAuth client is **yours**: it's created in your own Google Cloud project, and its secret stays on your server. Nothing in this repository or its images contains a client ID or secret.

#### 2a. Google Cloud project and Calendar API

1. Open <https://console.cloud.google.com/> and **create a project** (for example "Our family chore chart").
2. **APIs & Services → Library → Google Calendar API → Enable.**

#### 2b. OAuth consent screen (Google Auth Platform)

1. **Google Auth Platform → Branding:** app name (for example "Family chore chart"), support e-mail, developer contact e-mail.
2. **Audience:** user type **External**, unless the family uses Google Workspace, where **Internal** avoids the steps below.
3. **Data Access → Add or remove scopes:** add **`.../auth/calendar.readonly`** only. That is the only permission the app asks for.
4. **Publishing status:**
   - **Testing:** only the Google accounts listed under **Test users** can connect, so add the family account there. Google **ends the connection after 7 days** (the refresh token expires), and the app then asks a parent to reconnect. Fine for trying it out, not for daily use.
   - **In production:** connections don't expire after 7 days.
     - Because `calendar.readonly` is a *sensitive* scope, Google shows the parent an **"unverified app" warning** ("Google hasn't verified this app"). They continue via **Advanced → Go to … (unsafe)**.
     - Removing the warning needs Google's **verification**: a privacy policy, a home page on a verified domain, a demo video and review.
     - An unverified app is limited to **100 users** in total, which a single family's installation stays well within.
   - These are Google's rules, and the app can't change them. If they're a problem, use a calendar address instead.

#### 2c. OAuth client

1. **Google Auth Platform → Clients → Create client → Web application.**
2. **Authorised redirect URIs:** add exactly your server's address followed by `/api/calendar/google/callback`, for example:
   - `https://chores.example.com/api/calendar/google/callback`, or
   - `http://localhost:3080/api/calendar/google/callback` (the port you open the app on, on the server itself).
3. Leave **Authorised JavaScript origins** empty: the browser never calls Google's APIs.
4. **Create**, then copy the **Client ID**. **Download or copy the client secret into a file only.** Don't paste it into `.env`, the repository or a chat.

#### 2d. Settings on the server

```bash
# The client secret from step 2c (paste it, then Ctrl+D):
cat > secrets/google-client-secret.txt
sudo chown 1000:1000 secrets/google-client-secret.txt && sudo chmod 400 secrets/google-client-secret.txt
```

Add to `.env`:

```bash
SFCC_GOOGLE_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com
SFCC_GOOGLE_REDIRECT_URI=https://chores.example.com/api/calendar/google/callback
SFCC_ALLOWED_HOSTS=chores.example.com     # the redirect URI's host must be listed (localhost always is)
```

Start with both add-on files:

```bash
docker compose -p sfcc -f compose.server.yaml -f compose.calendar.yaml -f compose.google-calendar.yaml config --quiet && echo "configuration OK"
docker compose -p sfcc -f compose.server.yaml -f compose.calendar.yaml -f compose.google-calendar.yaml up -d
docker compose -p sfcc -f compose.server.yaml -f compose.calendar.yaml -f compose.google-calendar.yaml logs app | grep -i calendar
# → "Google Calendar integration available (read-only)" and "Calendar addresses (iCal) available (read-only)"
```

**Optional: shorter commands.** Instead of typing `-p` and `-f` each time, you can put both lines below in `.env`:

```bash
COMPOSE_PROJECT_NAME=sfcc
COMPOSE_FILE=compose.server.yaml:compose.calendar.yaml:compose.google-calendar.yaml
```

- Plain `docker compose up -d`, `ps` and `logs app` then use the right project and all three files. For the calendar address only, leave out `:compose.google-calendar.yaml`.
- `sfcc` is the same name as `-p sfcc`, so the two never refer to different installations.
- **But `-f` on the command line overrides `COMPOSE_FILE`.** The installation guide's commands all say `-f compose.server.yaml`, so drop that part when you use them, or `up` will leave the calendar settings out (see [step 1](#1-the-secret-key-both-methods)).

### Settings reference

| Setting | Needed for | Meaning |
|---|---|---|
| `SFCC_SECRET_KEY_FILE` | Both methods | File with 32 random bytes (`openssl rand -base64 32`, or 64 hex digits) that encrypts the stored token or address. `compose.calendar.yaml` mounts `./secrets/sfcc-secret-key.txt` (or `SFCC_SECRET_KEY_PATH`). `SFCC_SECRET_KEY` also works for development. |
| `SFCC_CALENDAR_FEED_HOSTS` | Calendar addresses (optional) | Extra public host names (comma-separated; no IP addresses, ports or wildcards) that calendar addresses may use besides Google, Outlook/Microsoft 365 and iCloud. |
| `SFCC_GOOGLE_CLIENT_ID` | Google sign-in | Your OAuth client ID (`…apps.googleusercontent.com`). Not a secret. |
| `SFCC_GOOGLE_CLIENT_SECRET_FILE` | Google sign-in | File holding your client secret. `compose.google-calendar.yaml` mounts `./secrets/google-client-secret.txt` (or `SFCC_GOOGLE_CLIENT_SECRET_PATH`). `SFCC_GOOGLE_CLIENT_SECRET` also works for development, but a file is preferred. |
| `SFCC_GOOGLE_REDIRECT_URI` | Google sign-in | Exactly as registered: HTTPS, or `http://localhost`/`127.0.0.1`, path `/api/calendar/google/callback`. Its host must be in `SFCC_ALLOWED_HOSTS`. |

- **Invalid values stop the server** with a clear message.
- **Missing values leave the method off.** Parents then see which setting names are missing; values are never shown.
- The server needs **outbound HTTPS** to the calendar providers (and to Google for sign-in). Nothing has to be reachable from the internet for a calendar address.

### HTTPS and reverse proxies (Google sign-in)

- Follow [Networking, HTTPS and reverse proxies](../README.md#networking-https-and-reverse-proxies) in the README.
- Put the public host name in `SFCC_ALLOWED_HOSTS`. Either set `SFCC_COOKIE_SECURE=always` or list the proxy in `SFCC_TRUST_PROXY`, and pass the original `Host` header through.
- The redirect URI's host must be the address parents open the app at when they press **Connect**. The app tells them if they're on a different address.

### No HTTPS yet: connect Google once through `localhost`

The kiosk and phones can keep using `http://192.168.1.20:3080`. Only the one-off **Connect** must happen at the registered `localhost` address:

1. Register `http://localhost:3080/api/calendar/google/callback` and set `SFCC_GOOGLE_REDIRECT_URI` to it.
2. On a parent's computer: `ssh -L 3080:127.0.0.1:3080 <user>@<server>`. Then open `http://localhost:3080`, sign in as a parent, and connect.
3. Close the tunnel. The connection is stored on the server and works for everyone.

Or use a calendar address, which works without HTTPS. Enter it over HTTPS or this same `localhost` tunnel if you can (see [Entering the address safely](#entering-the-address-safely)).

## Parents: connect, choose, switch, disconnect

**Google Calendar sign-in (recommended):**
1. **Connect:** Parent area → Settings → **Integrations → Family calendar → Connect Google Calendar**.
   - Sign in with the family's Google account and allow **"See your calendars"**.
   - You come back to the app, and the family's main calendar is shown.
2. **Choose a calendar:** **Choose a different calendar** lists the calendars this account can read, including ones shared with it, so it can be the family's shared calendar. The change applies on every device.
3. **Reconnect:** use this if the card or Family Calendar says the connection needs attention, for example after removing access in the Google account, a password change, or the 7-day limit of a "Testing" app.
   - **Sign in with the same Google account** that the card shows, to keep the chosen calendar.
   - **Reconnecting with a different Google account replaces the family's connection without a separate confirmation.** The new account's main calendar is shown, and the old account's access is given back to Google. The parent chose the account on Google's page, and the app only learns which account it is after that. The card then names the new account.
   - Switching *between methods* (Google ↔ a calendar address) always asks first.

**A calendar address (iCal):**
1. Copy the calendar's address (see [Supported calendar address formats](#supported-calendar-address-formats)). For Google, use the **secret** address in iCal format, not the page address.
2. Paste it into **Calendar address** and press **Check address**. The server fetches it and shows the calendar's name and how many events it found. Nothing is changed yet.
3. Press **Use this calendar**. If the family already has a calendar connected, confirm that it should be replaced.
4. **Treat the address like a password.** Anyone with it can read the whole calendar. The app never shows it again.
   - If it may have leaked, reset it at the provider (Google: **Integrate calendar → Reset**), then enter the new one with **Enter a new address**.
   - Resetting it at the provider also stops the old copy stored on this server from working.

#### Entering the address safely

- **Over `http://` the address is sent unencrypted.** This is the case when the app is opened at a plain address such as `http://192.168.1.20:3080`.
  - Anyone who can watch that network can copy it, for example on shared or guest Wi-Fi, or with a compromised device on the LAN.
  - The parent's password travels the same way on such a setup. But the calendar address keeps working until it is reset at the provider, even after the parent changes their password.
- **Prefer to enter it over HTTPS.** Open the app at its `https://` address (behind a reverse proxy or tunnel), or at `http://localhost:<port>` on the server itself, or through an SSH tunnel from a parent's computer (see [No HTTPS yet](#no-https-yet-connect-google-once-through-localhost)). Traffic to `localhost` never leaves the machine.
- **If it was entered over plain HTTP on a network you don't fully trust,** reset the address at the provider and enter the new one over HTTPS or `localhost`.
- Once stored, the address never travels to a browser again. Showing the calendar sends only the events.

**Switching:**
- From Google to an address: **Use a calendar address instead**.
- From an address to Google: **Switch to Google Calendar**.
- Either way, nothing is replaced until the new connection works and you confirm. See [Switching method](#switching-method-or-replacing-the-connection).

**Disconnect:** asks for confirmation, then removes the stored access on the server.
- Google is also asked to revoke access. If Google couldn't be told, the app says so; you can then remove access at <https://myaccount.google.com/permissions>.
- A calendar address can't be revoked from here: reset it at the provider.

Connecting Google from a parent's own phone or computer is easiest. A kiosk signs parents out when the page reloads, and coming back from Google reloads the page. The connection is still saved; the kiosk just shows the result message.

## Troubleshooting

| What you see | What to do |
|---|---|
| "Not set up on this family server yet" (with setting names) | The operator hasn't created the secret key, or the server wasn't started with `compose.calendar.yaml`. |
| Google sign-in "Not available on this server" | The Google settings are missing; a calendar address still works. For Google, finish [step 2](#2-google-calendar-sign-in-optional-recommended) and add `compose.google-calendar.yaml`. |
| "That address isn't from a supported calendar provider" | Use one of the [supported formats](#supported-calendar-address-formats). For Google, copy **Secret address in iCal format**, not the browser's address bar. For another host, the operator can add it to `SFCC_CALENDAR_FEED_HOSTS`. |
| "That address didn't return a calendar (iCalendar)" | The address leads to a web page or a sign-in page. Copy the iCal/ICS link instead. |
| "There's no calendar at that address any more" / "refused that address" | The address was reset or unpublished at the provider. Copy the current address and use **Enter a new address**. |
| "That calendar is too large (over 5 MB)" | The feed has many years of events. Use a smaller calendar (for example a dedicated family calendar), or Google sign-in. |
| "That calendar has too many events, or repeating events too complex, to read here" | Reading it went over the [parsing limits](#fetching-calendar-addresses-safely-ssrf-protection): more than 50,000 events, very long repeating series (for example ones counted with COUNT from decades ago), or a repeat rule that can never match. Use a smaller, dedicated calendar, or Google sign-in. |
| "Not set up" after an update or restart, though it worked before | The server was recreated without `compose.calendar.yaml`. Use the same `-p sfcc` and `-f` files as when you set it up (see [step 1](#1-the-secret-key-both-methods)). |
| "Too many calendar addresses checked" | Wait up to 15 minutes. |
| Events changed in the calendar don't show yet | Calendar addresses are updated by the provider on its own schedule (Google: often several hours), then read here at most every 5 minutes. Google sign-in is near-live. |
| Google: "Access blocked: … has not completed the Google verification process" / "access_denied" | The app is in **Testing** and the account isn't a **test user**. Add it, or publish the app (see the consent-screen step). |
| Google: "redirect_uri_mismatch" | The registered redirect URI and `SFCC_GOOGLE_REDIRECT_URI` must match exactly: scheme, host, port and path. |
| "Open the app at https://… to connect" | You're on another address (for example the LAN IP). Open the app at the address shown to connect Google. |
| "That connection attempt expired or was started in another browser" | Press Connect again and finish within 10 minutes, in the same browser. |
| "Please allow 'See your calendars'" | The calendar box was unticked on Google's page. Connect again and tick it. |
| "Another parent changed the family's calendar meanwhile" | Someone else changed the connection while you were at Google. Look at the card, then try again if you still want to switch. |
| "Google refused calendar access…" / Family Calendar: "Google won't share this calendar" | Enable the **Google Calendar API** in the project, and check that the account can still see the chosen calendar. |
| "The calendar connection needs attention" | Google: access was removed, the password changed, or a "Testing" app hit its 7-day limit; **Reconnect**. Address: it was reset; **Enter a new address**. |
| Card: "secret key changed" | `SFCC_SECRET_KEY_FILE` changed since the connection was made. Reconnect (or enter the address again), or restore the old key. |
| "The family server's Google settings need checking" | Google refused the client ID or secret. Check `SFCC_GOOGLE_CLIENT_ID` and the secret file, and that the client wasn't deleted. |
| "Can't reach Google Calendar / the calendar right now" | A network problem between the server and the provider. The last good copy from today is shown while it lasts. |
| Server won't start: `SFCC_GOOGLE_REDIRECT_URI …` / `SFCC_ALLOWED_HOSTS …` / `SFCC_CALENDAR_FEED_HOSTS …` | Fix the value as the message says. |

Server log lines to look for:
- `Google Calendar integration available` and `Calendar addresses (iCal) available`, at start-up.
- `Google Calendar connect finished`, with a result such as `connected`, `denied`, `invalid_state` or `changed`.
- `calendar address checked`, with a result code and the host only.
- `calendar address connected`, `Google Calendar disconnected` and `calendar address disconnected`.

Tokens, codes and addresses are never logged.

## Upgrading, backups and rolling back

- **Database migrations.** Version 0.4.0 has schema v2; version 0.5.0 has schema v4. The family calendar adds two migrations; both are additive, so no existing table or row changes:
  - **v3:** `google_calendar_connection`.
  - **v4:** `ical_feed_connection`, plus two triggers that allow only one calendar connection per family. An existing Google connection is kept as it is.
  - Before migrating, the server takes a verified **automatic backup** (for example `/data/backups/chorechart-<time>-pre-migration-v2-to-v4.db`), then applies each migration in its own transaction.
- **Updating and rolling back:** follow [Update to a newer release](INSTALL-UBUNTU.md#update-to-a-newer-release) in the installation guide. An older image refuses a database with a newer schema, to protect data it doesn't understand: 0.4.0 refuses v3 and v4. The guide gives two tested ways back to 0.4.0:
  - restoring the automatic pre-migration backup (loses changes made since the update);
  - keeping today's data and removing only the calendar tables. The image has no `sqlite3` tool, so the guide uses Node's built-in SQLite through `docker compose run`.
- **Backups** include the encrypted connection. Restoring one on the same server, with the same key, keeps it. Otherwise parents connect again.

## Development and tests

The tests never contact Google or any calendar provider, and use no real accounts, credentials or addresses.

- **Test doubles:**
  - `server/calendar/fakeGoogle.ts` is an in-memory stand-in for Google that checks the client secret, redirect URI, PKCE, single-use codes, revoked grants and bearer tokens.
  - `server/calendar/testInstallation.ts` is one family's installation driven through the HTTP API.
- **`server/calendar/familyCalendar.test.ts` (Google sign-in):**
  - Parent A connecting, and Parent B plus a paired kiosk seeing the same calendar.
  - Surviving a restart and sign-out.
  - Access control, and isolation from another family's installation.
  - State and callback errors, revoked consent, reconnecting, disconnecting and choosing a calendar.
  - No secret in any response, header or log.
- **`server/calendar/icalConnection.test.ts` (calendar addresses and switching):**
  - Shared family view, caching and updates, and survival across a restart.
  - Revoked and broken addresses, refused addresses, the rate limit, and single-use, parent-bound checks.
  - Google ↔ iCal switching with confirmation, an atomic swap (a simulated write failure keeps the old connection), cancelled Google consent, and concurrent changes.
  - Disconnecting, access control, cross-installation isolation, and the address never appearing in answers, logs or the database file.
- **`server/calendar/safeFetch.test.ts` (SSRF):**
  - Loopback, private, link-local, metadata, IPv6 and mapped addresses.
  - DNS rebinding, mixed DNS answers, and the peer check when the connection opens (the request is never sent).
  - Redirects to disallowed places, encoded and obfuscated hosts, ports and user info. A redirect with an endless body has its connection closed at once.
  - Timeouts, oversized answers and gzip bombs, web pages instead of calendars, and HTTP errors.
  - **Real TLS** (`https.request` to a local HTTPS server with a test-only certificate):
    - certificate trust and name checks;
    - the peer check before the TLS handshake;
    - a TLS handshake that never completes;
    - the redirect connection closing.
- **`server/calendar/icalFeed.test.ts` (parser):**
  - The supported address formats, including `webcal://` rewriting and the complete Outlook.com `cid-` shape.
  - Time zones (feed-defined, IANA, UTC, floating) and the change of the clocks.
  - All-day and multi-day events, RRULE/EXDATE/RECURRENCE-ID, cancellations, DURATION, and dropped fields.
  - Hostile rules, size caps, and documents that aren't iCalendar.
  - **Cost:** the security review's hostile feed; the work limit, inside a single series too; and 20,000 irrelevant events with relevant ones at the range edges.
  - **Skipping ahead** gives exactly the same events as stepping from the start, across 12 rule shapes and 3 time zones.
  - **The worker:** the same result as reading in place; a never-matching rule stopped at the timeout while the main thread keeps running (lag measured); several feeds at once.
- **Development fixture.** `SFCC_DEV_CALENDAR_FIXTURE=<file>` (development only, refused in production) shows events from a local file: JSON in Google's `events.list` shape, or an `.ics` file. The Playwright tests use it.

## Not implemented (and why)

- **Writing to the calendar:** out of scope by design (read-only).
- **Several calendars or connections at once:** one connection, and one calendar, is shown, so events are never merged or duplicated. A family's shared Google calendar can be chosen.
- **Google sign-in without each installation's own OAuth client:** see [Decision history](#decision-history). A calendar address is the no-setup alternative.

## Decision history

- **2026-10-24, self-hosted OAuth:** chosen for Google sign-in.
  - Google requires each OAuth client to list the exact web addresses it may send people back to, and a client secret can't be published in this public repository. So each installation uses its own client, created once by its operator.
- **2026-10-24, central broker proposed and abandoned:** a maintainer-run central "connection broker" (one shared, Google-verified OAuth client for all installations) was studied and **abandoned**. It would have needed separate hosting, Google verification of a sensitive scope (privacy policy, verified domain, demo video, review), a 100-user cap until verified, and every family trusting a third party with sign-in. Alternatives were also ruled out:
  - **Google's device flow** (for TVs and kiosks) doesn't allow Calendar scopes.
  - **A shared "desktop app" client in the repository** would publish its secret and allows only loopback redirects.
- **2026-10-24, final design:** self-hosted Google OAuth (recommended) **plus** a private iCal address as a first-class alternative that needs no Google Cloud setup. One connection per family, switched atomically after confirmation. No central broker, separate service or extra hosting.
