import { randomBytes } from 'node:crypto';
import { safeEqual, sha256 } from '../auth/crypto';
import { AttemptLimiter, type Limit } from '../auth/rateLimit';
import type { SqlDatabase } from '../db/database';
import {
  addDays,
  CALENDAR_DAYS,
  CalendarService,
  CalendarSourceError,
  googleCalendarSource,
  listGoogleCalendars,
  type AccessTokenSource,
  type CalendarChoice,
  type CalendarState,
  type RefreshInfo,
} from './calendar';
import { authorizationUrl, GoogleOAuthClient, OAuthError, pkcePair, type GoogleOAuthSettings } from './googleOAuth';
import { checkFeedUrl, FeedTextCache, icalCalendarSource, PROVIDER_NAMES, readFeed, type FeedProvider, type FeedSettings } from './icalFeed';
import { SecretBox, SecretBoxError } from './secretBox';
import { todayInZone } from '../time';

// The FAMILY's calendar connection: Google OAuth (preferred) or a private
// iCal address (the alternative that needs no Google Cloud setup).
//
// One installation is one household: one database holding the family, its
// parents and its paired devices. The connection is stored there once, so
// it belongs to the household, not to the parent who connected it, a
// session or a device: every signed-in parent and paired device sees the
// same calendar, through the server, and it survives restarts, reloads and
// sign-outs. Another family runs its own installation, with its own
// database and secret key.
//
// One active connection: google_calendar_connection OR ical_feed_connection
// holds a row, never both (schema v4 triggers enforce it). Switching method
// validates the new connection first, needs the parent's explicit
// confirmation, and then swaps the rows in one transaction, so a failed or
// cancelled switch leaves the old connection working.
//
// Secrets: the Google refresh token and the iCal address are stored
// encrypted (AES-256-GCM, key from the deployment, see secretBox.ts); access
// tokens live only in memory. None of them ever leaves the server: API
// answers carry status, names and the feed's host only.

/** Purposes bound into the encryption, so a ciphertext can't be moved between columns. */
const REFRESH_TOKEN_PURPOSE = 'google-calendar-refresh-token:v1';
const FEED_URL_PURPOSE = 'ical-feed-url:v1';
/** How long a "Connect" may take, from the click to Google's answer. */
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 20;
/** Refresh access tokens this long before Google's expiry time. */
const EXPIRY_MARGIN_MS = 60 * 1000;
/** A checked iCal address waits this long for the parent to confirm it. */
const FEED_CHECK_TTL_MS = 10 * 60 * 1000;
const MAX_FEED_CHECKS = 10;
/** Checking an address fetches it: at most 10 checks per 15 minutes for the household. */
export const FEED_CHECK_LIMIT: Limit = { max: 10, windowMs: 15 * 60 * 1000 };

export type ConnectionProblem = 'revoked' | 'key_changed' | 'not_configured';
export type CalendarMethod = 'google' | 'ical';

/** The active connection, described safely (for "this will replace …"). */
export interface ConnectionSummary {
  method: CalendarMethod;
  /** e.g. "family@example.com" or "Google Calendar address (calendar.google.com)". */
  label: string;
  calendarName: string;
}

interface ConnectionViewBase {
  status: 'connected' | 'needs_reconnect';
  problem: ConnectionProblem | null;
  calendarName: string;
  connectedAt: string;
  connectedBy: string | null;
}

/** What a parent sees in Settings → Family calendar. Never contains a token or an address. */
export interface CalendarConnectionStatus {
  google: {
    available: boolean;
    /** Names of the missing server settings (not their values). */
    missing: string[];
    /** The address parents must use to connect (the redirect URI's origin). */
    connectOrigin: string | null;
  };
  ical: {
    available: boolean;
    missing: string[];
    /** Hosts the operator allowed besides the built-in providers. */
    extraHosts: string[];
  };
  connection:
    | null
    | (ConnectionViewBase & { method: 'google'; accountEmail: string; calendarId: string })
    | (ConnectionViewBase & { method: 'ical'; provider: FeedProvider; providerName: string; host: string });
  refresh: RefreshInfo;
}

/** How the browser comes back from Google (shown as a message in the app). */
export type ConnectResult =
  | 'connected'
  | 'denied' // the parent pressed Cancel on Google's page
  | 'scope_missing' // the parent unticked calendar access
  | 'invalid_state' // expired, reused, forged, or started in another browser
  | 'calendar_api' // Google Calendar API not enabled, or no calendar access
  | 'setup' // the server's client ID or secret is wrong
  | 'changed' // another parent changed the family's calendar meanwhile: nothing replaced
  | 'not_configured'
  | 'failed';

export type FamilyCalendarError = {
  ok: false;
  status: number;
  error: string;
  message: string;
  /** With error "confirm_replace": the connection that would be replaced. */
  replaces?: ConnectionSummary;
  retryAfter?: number;
};

/** A checked iCal address, before the parent confirms it. */
export interface FeedCheck {
  ok: true;
  /** Single use; refers to the address kept on the server (the browser can forget it). */
  checkId: string;
  provider: FeedProvider;
  providerName: string;
  host: string;
  calendarName: string;
  /** Events in the next CALENDAR_DAYS days. */
  upcomingEvents: number;
  /** The connection that confirming would replace, if any. */
  replaces: ConnectionSummary | null;
}

interface GoogleRow {
  account_email: string;
  refresh_token_enc: string;
  key_id: string;
  scope: string;
  calendar_id: string;
  calendar_name: string;
  status: 'connected' | 'needs_reconnect';
  problem: 'revoked' | 'key_changed' | null;
  connected_by: string | null;
  connected_at: string;
  updated_at: string;
}

interface FeedRow {
  url_enc: string;
  key_id: string;
  provider: FeedProvider;
  host: string;
  calendar_name: string;
  connected_by: string | null;
  connected_at: string;
  updated_at: string;
}

interface Pending {
  browserHash: string;
  parentId: string | null;
  verifier: string;
  expiresAt: number;
  /** The iCal connection the parent agreed to replace (its connected_at), or null. */
  replacesFeed: string | null;
}

interface PendingFeed {
  url: URL;
  parentId: string | null;
  provider: FeedProvider;
  host: string;
  calendarName: string;
  expiresAt: number;
  /** The connection last shown to the parent as "will be replaced" (see identity()). */
  replaces: string | null;
}

export interface FamilyCalendarOptions {
  db: SqlDatabase;
  /** Null when the installation has no (complete) Google OAuth settings. */
  google: GoogleOAuthSettings | null;
  /** Null when no secret key is configured (then neither method is available). */
  secretBox: SecretBox | null;
  /** Missing Google setting names, for the setup instructions. */
  missing?: string[];
  timeZone: string;
  /** iCal addresses: extra allowed hosts, and (tests only) network overrides. */
  feeds?: FeedSettings;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class FamilyCalendar {
  /** The events shown on the Family Calendar page, for the whole household. */
  readonly events: CalendarService;
  private readonly db: SqlDatabase;
  private readonly google: GoogleOAuthSettings | null;
  private readonly box: SecretBox | null;
  private readonly missing: string[];
  private readonly timeZone: string;
  private readonly feeds: FeedSettings;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly oauth: GoogleOAuthClient | null;
  private readonly pending = new Map<string, Pending>();
  private readonly pendingFeeds = new Map<string, PendingFeed>();
  private readonly limiter: AttemptLimiter;
  /** The iCal feed's last download, reused briefly across months. */
  private readonly feedText: FeedTextCache;
  private access: { token: string; expiresAt: number; generation: number } | null = null;
  private refreshing: Promise<string> | null = null;
  /** Bumped on every connect, switch and disconnect, so a late refresh can't bring back an old token. */
  private generation = 0;

  constructor(options: FamilyCalendarOptions) {
    this.db = options.db;
    this.google = options.google;
    this.box = options.secretBox;
    this.missing = options.missing ?? [];
    this.timeZone = options.timeZone;
    this.feeds = options.feeds ?? { extraHosts: [] };
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.now = options.now ?? (() => new Date());
    this.limiter = new AttemptLimiter(() => this.now().getTime(), FEED_CHECK_LIMIT.windowMs);
    this.feedText = new FeedTextCache(() => this.now().getTime());
    this.oauth = this.google ? new GoogleOAuthClient(this.google, this.fetchImpl, () => this.now().getTime()) : null;
    this.events = new CalendarService(() => this.state(), options.timeZone, this.now);
  }

  /** Google OAuth can be used (client settings and the secret key are present). */
  get configured(): boolean {
    return this.google !== null && this.box !== null;
  }

  /** A private iCal address can be used (the secret key is present). */
  get feedsAvailable(): boolean {
    return this.box !== null;
  }

  private googleRow(): GoogleRow | undefined {
    return this.db.get<GoogleRow & Record<string, unknown>>('SELECT * FROM google_calendar_connection WHERE id = 1');
  }

  private feedRow(): FeedRow | undefined {
    return this.db.get<FeedRow & Record<string, unknown>>('SELECT * FROM ical_feed_connection WHERE id = 1');
  }

  private state(): CalendarState {
    if (!this.box) return { kind: 'not_configured' };
    const g = this.googleRow();
    if (g) {
      if (!this.google) return { kind: 'problem', reason: 'setup', source: 'google' };
      if (g.status !== 'connected' || g.key_id !== this.box.keyId) return { kind: 'problem', reason: 'auth', source: 'google' };
      return {
        kind: 'ready',
        key: `google|${g.connected_at}|${g.calendar_id}`,
        source: googleCalendarSource({ calendarId: g.calendar_id, tokens: this.tokens, fetchImpl: this.fetchImpl }),
      };
    }
    const f = this.feedRow();
    if (f) {
      const url = this.decryptFeedUrl(f);
      if (!url) return { kind: 'problem', reason: 'auth', source: 'ical' };
      return {
        kind: 'ready',
        key: `ical|${f.connected_at}`,
        source: icalCalendarSource({ url, fallbackName: f.calendar_name, settings: this.feeds, cache: this.feedText }),
      };
    }
    return { kind: 'not_connected' };
  }

  private connectedByName(parentId: string | null): string | null {
    return parentId ? (this.db.get<{ display_name: string }>('SELECT display_name FROM parents WHERE id = ?', parentId)?.display_name ?? null) : null;
  }

  /** Identifies the active connection exactly (method and when it was made), or null. */
  private identity(): string | null {
    const g = this.googleRow();
    if (g) return `google|${g.connected_at}`;
    const f = this.feedRow();
    return f ? `ical|${f.connected_at}` : null;
  }

  /** The active connection, described safely, or null. */
  activeConnection(): ConnectionSummary | null {
    const g = this.googleRow();
    if (g) return { method: 'google', label: g.account_email, calendarName: g.calendar_name };
    const f = this.feedRow();
    if (f) return { method: 'ical', label: `${PROVIDER_NAMES[f.provider]} address (${f.host})`, calendarName: f.calendar_name };
    return null;
  }

  status(): CalendarConnectionStatus {
    const keyId = this.box?.keyId;
    const g = this.googleRow();
    const f = g ? undefined : this.feedRow();
    let connection: CalendarConnectionStatus['connection'] = null;
    if (g) {
      const keyChanged = g.key_id !== keyId;
      const problem: ConnectionProblem | null = !this.configured ? 'not_configured' : keyChanged ? 'key_changed' : g.problem;
      connection = {
        method: 'google',
        status: problem ? 'needs_reconnect' : g.status,
        problem,
        accountEmail: g.account_email,
        calendarId: g.calendar_id,
        calendarName: g.calendar_name,
        connectedAt: g.connected_at,
        connectedBy: this.connectedByName(g.connected_by),
      };
    } else if (f) {
      const problem: ConnectionProblem | null = !this.box ? 'not_configured' : this.decryptFeedUrl(f) ? null : 'key_changed';
      connection = {
        method: 'ical',
        status: problem ? 'needs_reconnect' : 'connected',
        problem,
        provider: f.provider,
        providerName: PROVIDER_NAMES[f.provider],
        host: f.host,
        calendarName: f.calendar_name,
        connectedAt: f.connected_at,
        connectedBy: this.connectedByName(f.connected_by),
      };
    }
    return {
      google: { available: this.configured, missing: this.missing, connectOrigin: this.google ? new URL(this.google.redirectUri).origin : null },
      ical: { available: this.feedsAvailable, missing: this.box ? [] : ['SFCC_SECRET_KEY_FILE'], extraHosts: [...this.feeds.extraHosts] },
      connection,
      refresh: this.events.lastRefresh(),
    };
  }

  /** After any change of connection: no old token, event or refresh survives it. */
  private connectionChanged(): void {
    this.generation++;
    this.access = null;
    this.refreshing = null;
    this.feedText.clear();
    this.events.invalidate();
  }

  // ---------- Google: connecting ----------

  /**
   * Start connecting: returns Google's consent-page address and a nonce for
   * a short-lived cookie that binds the flow to this browser. The `state`
   * value only identifies the pending flow (stored hashed, single use,
   * 10 minutes); PKCE protects the code itself.
   *
   * If the family uses an iCal address, `replace` must be true (the parent
   * confirmed); the address is only replaced once Google has said yes.
   */
  startConnect(parentId: string | null, replace = false): { authorizationUrl: string; browserNonce: string } | FamilyCalendarError {
    if (!this.configured) return notConfigured();
    const feed = this.feedRow();
    if (feed && !replace) return confirmReplace(this.activeConnection()!);
    const now = this.now().getTime();
    for (const [key, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(key);
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    const state = randomBytes(32).toString('base64url');
    const browserNonce = randomBytes(32).toString('base64url');
    const { verifier, challenge } = pkcePair();
    this.pending.set(sha256(state), {
      browserHash: sha256(browserNonce),
      parentId,
      verifier,
      expiresAt: now + PENDING_TTL_MS,
      replacesFeed: feed?.connected_at ?? null,
    });
    return { authorizationUrl: authorizationUrl(this.google!, state, challenge), browserNonce };
  }

  /** Google's redirect back to us (?code&state, or ?error&state). */
  async completeConnect(input: { code?: string; state?: string; error?: string; browserNonce?: string }): Promise<ConnectResult> {
    if (!this.configured) return 'not_configured';
    if (!input.state) return 'invalid_state';
    const key = sha256(input.state);
    const pending = this.pending.get(key);
    this.pending.delete(key); // single use, whatever happens next
    if (!pending || pending.expiresAt <= this.now().getTime()) return 'invalid_state';
    if (!input.browserNonce || !safeEqual(sha256(input.browserNonce), pending.browserHash)) return 'invalid_state';
    if (pending.parentId && !this.db.get('SELECT 1 AS ok FROM parents WHERE id = ?', pending.parentId)) return 'invalid_state';
    if (input.error) return input.error === 'access_denied' ? 'denied' : 'failed';
    if (!input.code) return 'failed';

    let tokens;
    try {
      tokens = await this.oauth!.exchangeCode(input.code, pending.verifier);
    } catch (error) {
      if (error instanceof OAuthError && error.failure === 'scope_missing') return 'scope_missing';
      if (error instanceof OAuthError && error.failure === 'invalid_client') return 'setup';
      return 'failed';
    }
    const once: AccessTokenSource = { getAccessToken: async () => tokens.accessToken };
    let calendars: CalendarChoice[];
    try {
      calendars = await listGoogleCalendars(once, this.fetchImpl);
    } catch (error) {
      // The new grant is useless to us: give it back.
      await this.oauth!.revoke(tokens.refreshToken);
      return error instanceof CalendarSourceError && error.reason === 'access' ? 'calendar_api' : 'failed';
    }
    const primary = calendars.find((c) => c.primary);
    const accountEmail = primary?.id ?? 'Google account';
    const previous = this.googleRow();
    // Keep the chosen calendar when the same account reconnects; otherwise start with its main calendar.
    const keep = previous && previous.account_email === accountEmail ? calendars.find((c) => c.id === previous.calendar_id) : undefined;
    const chosen = keep ?? primary ?? calendars[0];
    if (!chosen) {
      await this.oauth!.revoke(tokens.refreshToken);
      return 'calendar_api';
    }

    // Validated. Now swap in one transaction: the iCal address the parent
    // agreed to replace (if any) goes, and the Google connection is stored.
    const now = this.now().toISOString();
    const sealed = this.box!.encrypt(tokens.refreshToken, REFRESH_TOKEN_PURPOSE);
    const outcome = this.db.transaction(() => {
      const feed = this.feedRow();
      if (feed && feed.connected_at !== pending.replacesFeed) return 'changed' as const;
      this.db.run('DELETE FROM ical_feed_connection WHERE id = 1');
      this.db.run(
        `INSERT INTO google_calendar_connection
           (id, account_email, refresh_token_enc, key_id, scope, calendar_id, calendar_name, status, problem, connected_by, connected_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, 'connected', NULL, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           account_email = excluded.account_email, refresh_token_enc = excluded.refresh_token_enc, key_id = excluded.key_id,
           scope = excluded.scope, calendar_id = excluded.calendar_id, calendar_name = excluded.calendar_name,
           status = 'connected', problem = NULL, connected_by = excluded.connected_by,
           connected_at = excluded.connected_at, updated_at = excluded.updated_at`,
        accountEmail,
        sealed,
        this.box!.keyId,
        tokens.scope,
        chosen.id,
        chosen.name,
        pending.parentId,
        now,
        now,
      );
      return 'connected' as const;
    });
    if (outcome === 'changed') {
      // Someone set up another iCal address while this parent was at Google: keep theirs.
      await this.oauth!.revoke(tokens.refreshToken);
      return 'changed';
    }
    this.connectionChanged();
    this.access = { token: tokens.accessToken, expiresAt: tokens.expiresAt, generation: this.generation };
    // Replacing another grant (e.g. a different account): give the old one back.
    const old = previous ? this.decryptRefreshToken(previous) : null;
    if (old && old !== tokens.refreshToken) void this.oauth!.revoke(old);
    return 'connected';
  }

  // ---------- Google: managing ----------

  async listCalendars(): Promise<{ ok: true; calendars: (CalendarChoice & { selected: boolean })[] } | FamilyCalendarError> {
    const ready = this.requireGoogle();
    if (!ready.ok) return ready;
    try {
      const calendars = await listGoogleCalendars(this.tokens, this.fetchImpl);
      return { ok: true, calendars: calendars.map((c) => ({ ...c, selected: c.id === ready.row.calendar_id })) };
    } catch (error) {
      return calendarProblem(error);
    }
  }

  async selectCalendar(calendarId: string): Promise<{ ok: true } | FamilyCalendarError> {
    const listed = await this.listCalendars();
    if (!listed.ok) return listed;
    const chosen = listed.calendars.find((c) => c.id === calendarId);
    if (!chosen) return { ok: false, status: 422, error: 'unknown_calendar', message: 'That calendar isn’t available to the connected Google account.' };
    this.db.run('UPDATE google_calendar_connection SET calendar_id = ?, calendar_name = ?, updated_at = ? WHERE id = 1', chosen.id, chosen.name, this.now().toISOString());
    this.events.invalidate();
    return { ok: true };
  }

  /** Remove the family's Google connection; also asks Google to revoke it (best effort). */
  async disconnect(): Promise<{ ok: true; wasConnected: boolean; revokedAtGoogle: boolean }> {
    const row = this.googleRow();
    this.db.run('DELETE FROM google_calendar_connection WHERE id = 1');
    this.connectionChanged();
    if (!row) return { ok: true, wasConnected: false, revokedAtGoogle: false };
    const token = this.decryptRefreshToken(row);
    const revokedAtGoogle = token && this.oauth ? await this.oauth.revoke(token) : false;
    return { ok: true, wasConnected: true, revokedAtGoogle };
  }

  // ---------- iCal address ----------

  /**
   * Step 1 of using an iCal address: check it (supported provider, fetched
   * under the SSRF rules, really an iCalendar document) WITHOUT changing the
   * family's connection. The address stays on the server; the browser gets a
   * single-use check ID, a safe description, and what confirming would
   * replace.
   */
  async checkFeed(rawUrl: string, parentId: string | null): Promise<FeedCheck | FamilyCalendarError> {
    if (!this.feedsAvailable) return feedsNotConfigured();
    const checked = checkFeedUrl(rawUrl, this.feeds.extraHosts);
    if ('problem' in checked) {
      return checked.problem === 'invalid'
        ? { ok: false, status: 422, error: 'feed_url_invalid', message: 'That isn’t a usable calendar address. Paste the whole https:// (or webcal://) address.' }
        : {
            ok: false,
            status: 422,
            error: 'feed_unsupported',
            message: 'That address isn’t from a supported calendar provider. Use Google Calendar’s “Secret address in iCal format”, or a published Outlook or iCloud calendar link.',
          };
    }
    const wait = this.limiter.retryAfter('feed-check', FEED_CHECK_LIMIT);
    if (wait) return { ok: false, status: 429, error: 'rate_limited', message: 'Too many calendar addresses checked. Please wait a few minutes.', retryAfter: wait };
    this.limiter.fail('feed-check'); // every check fetches something, so every check counts

    const start = todayInZone(this.timeZone, this.now());
    let feed;
    try {
      feed = await readFeed(checked.url, this.timeZone, { start, end: addDays(start, CALENDAR_DAYS - 1) }, this.feeds);
    } catch (error) {
      return feedProblem(error instanceof CalendarSourceError ? (error.detail ?? error.reason) : 'unavailable');
    }

    const now = this.now().getTime();
    for (const [key, p] of this.pendingFeeds) if (p.expiresAt <= now) this.pendingFeeds.delete(key);
    while (this.pendingFeeds.size >= MAX_FEED_CHECKS) this.pendingFeeds.delete(this.pendingFeeds.keys().next().value!);
    const checkId = randomBytes(32).toString('base64url');
    const calendarName = feed.calendarName ?? PROVIDER_NAMES[checked.provider];
    this.pendingFeeds.set(sha256(checkId), {
      url: checked.url,
      parentId,
      provider: checked.provider,
      host: checked.host,
      calendarName,
      expiresAt: now + FEED_CHECK_TTL_MS,
      replaces: this.identity(),
    });
    return {
      ok: true,
      checkId,
      provider: checked.provider,
      providerName: PROVIDER_NAMES[checked.provider],
      host: checked.host,
      calendarName,
      upcomingEvents: feed.events.length,
      replaces: this.activeConnection(),
    };
  }

  /**
   * Step 2: use the checked address for the whole family. If another
   * connection is active, `replace` must be true, and the parent must have
   * been shown exactly that connection (if it changed since, they are asked
   * again). The old connection is removed and the new one stored in the
   * same transaction.
   */
  async useFeed(checkId: string, parentId: string | null, replace: boolean): Promise<{ ok: true; replaced: CalendarMethod | null; revokedAtGoogle: boolean } | FamilyCalendarError> {
    if (!this.feedsAvailable) return feedsNotConfigured();
    const key = sha256(checkId);
    const pending = this.pendingFeeds.get(key);
    if (!pending || pending.expiresAt <= this.now().getTime() || pending.parentId !== parentId) {
      return { ok: false, status: 409, error: 'feed_check_expired', message: 'That check has expired. Please check the address again.' };
    }
    const active = this.activeConnection();
    const current = this.identity();
    if (current && (!replace || current !== pending.replaces)) {
      pending.replaces = current; // what the parent is now being asked about
      return confirmReplace(active!);
    }
    this.pendingFeeds.delete(key); // single use from here on

    const now = this.now().toISOString();
    const sealed = this.box!.encrypt(pending.url.toString(), FEED_URL_PURPOSE);
    const oldGoogle = this.googleRow();
    this.db.transaction(() => {
      this.db.run('DELETE FROM google_calendar_connection WHERE id = 1');
      this.db.run('DELETE FROM ical_feed_connection WHERE id = 1');
      this.db.run(
        `INSERT INTO ical_feed_connection (id, url_enc, key_id, provider, host, calendar_name, connected_by, connected_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sealed,
        this.box!.keyId,
        pending.provider,
        pending.host,
        pending.calendarName,
        parentId,
        now,
        now,
      );
    });
    this.connectionChanged();
    // The Google grant isn't needed any more: give it back (best effort).
    const token = oldGoogle ? this.decryptRefreshToken(oldGoogle) : null;
    const revokedAtGoogle = token && this.oauth ? await this.oauth.revoke(token) : false;
    return { ok: true, replaced: active?.method ?? null, revokedAtGoogle };
  }

  /** Forget the family's iCal address (the provider isn't told: reset the address there to invalidate it). */
  disconnectFeed(): { ok: true; wasConnected: boolean } {
    const { changes } = this.db.run('DELETE FROM ical_feed_connection WHERE id = 1');
    this.pendingFeeds.clear();
    this.connectionChanged();
    return { ok: true, wasConnected: changes > 0 };
  }

  private decryptFeedUrl(row: FeedRow): URL | null {
    if (!this.box || row.key_id !== this.box.keyId) return null;
    try {
      return new URL(this.box.decrypt(row.url_enc, FEED_URL_PURPOSE));
    } catch (error) {
      if (error instanceof SecretBoxError || error instanceof TypeError) return null;
      throw error;
    }
  }

  // ---------- Google tokens ----------

  private decryptRefreshToken(row: GoogleRow): string | null {
    if (!this.box || row.key_id !== this.box.keyId) return null;
    try {
      return this.box.decrypt(row.refresh_token_enc, REFRESH_TOKEN_PURPOSE);
    } catch (error) {
      if (error instanceof SecretBoxError) return null;
      throw error;
    }
  }

  private requireGoogle(): { ok: true; row: GoogleRow } | FamilyCalendarError {
    if (!this.configured) return notConfigured();
    const row = this.googleRow();
    if (!row) return { ok: false, status: 409, error: 'not_connected', message: 'No Google account is connected.' };
    if (row.status !== 'connected' || row.key_id !== this.box!.keyId) {
      return { ok: false, status: 409, error: 'needs_reconnect', message: 'The Google connection needs to be reconnected.' };
    }
    return { ok: true, row };
  }

  private markNeedsReconnect(problem: 'revoked' | 'key_changed'): void {
    this.db.run("UPDATE google_calendar_connection SET status = 'needs_reconnect', problem = ?, updated_at = ? WHERE id = 1", problem, this.now().toISOString());
    this.access = null;
    this.events.invalidate();
  }

  /** Access tokens for the stored connection: cached in memory, refreshed when due. */
  private readonly tokens: AccessTokenSource = {
    getAccessToken: async (fresh = false) => {
      const now = this.now().getTime();
      if (!fresh && this.access && this.access.generation === this.generation && this.access.expiresAt - EXPIRY_MARGIN_MS > now) {
        return this.access.token;
      }
      this.refreshing ??= this.refreshAccessToken().finally(() => (this.refreshing = null));
      return this.refreshing;
    },
  };

  private async refreshAccessToken(): Promise<string> {
    const generation = this.generation;
    const row = this.googleRow();
    if (!this.configured || !row) throw new CalendarSourceError('auth', 'Not connected.');
    const refreshToken = this.decryptRefreshToken(row);
    if (!refreshToken) {
      this.markNeedsReconnect('key_changed');
      throw new CalendarSourceError('auth', 'The stored connection can’t be read with this server’s secret key.');
    }
    try {
      const tokens = await this.oauth!.refresh(refreshToken);
      if (generation !== this.generation) throw new CalendarSourceError('auth', 'The connection changed.');
      this.access = { token: tokens.accessToken, expiresAt: tokens.expiresAt, generation };
      // Google may rotate the refresh token: keep the new one.
      if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
        this.db.run('UPDATE google_calendar_connection SET refresh_token_enc = ?, updated_at = ? WHERE id = 1', this.box!.encrypt(tokens.refreshToken, REFRESH_TOKEN_PURPOSE), this.now().toISOString());
      }
      return tokens.accessToken;
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      if (error.failure === 'invalid_grant' || error.failure === 'scope_missing') {
        // Revoked at myaccount.google.com, password changed, expired (e.g. a
        // "Testing" OAuth app after 7 days) or calendar access removed.
        if (generation === this.generation) this.markNeedsReconnect('revoked');
        throw new CalendarSourceError('auth', 'Google no longer accepts the family’s connection.');
      }
      if (error.failure === 'invalid_client') throw new CalendarSourceError('setup', 'The server’s Google OAuth client was refused.');
      throw new CalendarSourceError('unavailable', 'Google could not be reached.');
    }
  }
}

function notConfigured(): FamilyCalendarError {
  return { ok: false, status: 409, error: 'not_configured', message: 'Google Calendar isn’t set up on this family server yet.' };
}

function feedsNotConfigured(): FamilyCalendarError {
  return { ok: false, status: 409, error: 'not_configured', message: 'Calendar addresses aren’t set up on this family server yet (it needs a secret key).' };
}

function confirmReplace(replaces: ConnectionSummary): FamilyCalendarError {
  return {
    ok: false,
    status: 409,
    error: 'confirm_replace',
    message: 'The family already has a calendar connected. Confirm that it should be replaced.',
    replaces,
  };
}

/** Why a checked address can't be used, for the parent. Never repeats the address. */
function feedProblem(detail: string): FamilyCalendarError {
  const messages: Record<string, [string, string]> = {
    refused: ['feed_refused', 'The calendar provider refused that address. It may have been reset: copy the current secret address again.'],
    not_found: ['feed_not_found', 'There’s no calendar at that address any more. It may have been reset: copy the current secret address again.'],
    blocked: ['feed_blocked', 'That address points somewhere this server won’t connect to.'],
    redirect: ['feed_redirect', 'That address redirected too many times.'],
    too_large: ['feed_too_large', 'That calendar is too large (over 5 MB) to show here.'],
    not_ical: ['feed_not_ical', 'That address didn’t return a calendar (iCalendar). Check that you copied the iCal address, not the web page address.'],
    bad_response: ['feed_not_ical', 'That address didn’t return a calendar (iCalendar). Check that you copied the iCal address, not the web page address.'],
    too_complex: ['feed_too_complex', 'That calendar has too many events, or repeating events too complex, to read here.'],
    timeout: ['feed_unavailable', 'The calendar provider took too long to answer. Please try again.'],
    rate_limited: ['feed_unavailable', 'The calendar provider asked us to slow down. Please try again in a few minutes.'],
    unavailable: ['feed_unavailable', 'The calendar provider can’t be reached right now. Please try again.'],
  };
  const [error, message] = messages[detail] ?? messages.unavailable!;
  return { ok: false, status: 422, error, message };
}

function calendarProblem(error: unknown): FamilyCalendarError {
  const reason = error instanceof CalendarSourceError ? error.reason : 'unavailable';
  const messages: Record<string, [number, string]> = {
    auth: [409, 'The Google connection needs to be reconnected.'],
    setup: [409, 'The family server’s Google settings were refused by Google.'],
    access: [409, 'Google refused access. Check that the Google Calendar API is enabled.'],
    not_found: [409, 'Google couldn’t find the calendar list.'],
    unavailable: [409, 'Google Calendar can’t be reached right now. Please try again.'],
  };
  const [status, message] = messages[reason] ?? messages.unavailable!;
  return { ok: false, status, error: reason === 'auth' ? 'needs_reconnect' : `google_${reason}`, message };
}
