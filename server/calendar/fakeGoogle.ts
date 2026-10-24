import { createHash, randomBytes } from 'node:crypto';
import { CALENDAR_READONLY_SCOPE } from './calendar';
import { GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL } from './googleOAuth';

// TESTS ONLY: an in-memory stand-in for Google's OAuth and Calendar APIs,
// used as the server's `fetch`. It checks what the real Google checks (client
// secret, redirect URI, PKCE, single-use codes, revoked grants, bearer
// tokens) so the tests prove the server sends the right things. Nothing here
// contacts Google or uses real credentials.

export const FAKE_CLIENT = {
  clientId: 'test-client.apps.googleusercontent.com',
  clientSecret: 'TEST-CLIENT-SECRET-do-not-leak',
  redirectUri: 'https://chores.example.test/api/calendar/google/callback',
};

interface FakeCalendar {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole: string;
  items: Record<string, unknown>[];
}

export class FakeGoogle {
  accountEmail = 'family@example.test';
  calendars: FakeCalendar[] = [];
  /** Scope the consent screen grants (a parent may untick calendar access). */
  grantedScope = CALENDAR_READONLY_SCOPE;
  calendarApiEnabled = true;
  readonly calls: string[] = [];
  readonly revokedTokens: string[] = [];
  private readonly codes = new Map<string, { challenge: string; redirectUri: string }>();
  private readonly refreshTokens = new Set<string>();
  private readonly accessTokens = new Set<string>();
  /** Every token value handed out, to check none leaks. */
  readonly issued: string[] = [];

  constructor() {
    this.calendars = [
      { id: this.accountEmail, summary: 'Family', primary: true, accessRole: 'owner', items: [] },
      { id: 'school@group.calendar.example.test', summary: 'School dates', accessRole: 'reader', items: [] },
      { id: 'busy@group.calendar.example.test', summary: 'Free/busy only', accessRole: 'freeBusyReader', items: [] },
    ];
  }

  private token(prefix: string): string {
    const t = `${prefix}-${randomBytes(12).toString('hex')}`;
    this.issued.push(t);
    return t;
  }

  /** The parent approves on Google's consent page: returns the redirect query. */
  approve(authorizationUrl: string): { code: string; state: string } {
    const url = new URL(authorizationUrl);
    const p = url.searchParams;
    if (url.origin + url.pathname !== 'https://accounts.google.com/o/oauth2/v2/auth') throw new Error(`unexpected auth URL ${url}`);
    if (p.get('client_id') !== FAKE_CLIENT.clientId) throw new Error('wrong client_id');
    if (p.get('scope') !== CALENDAR_READONLY_SCOPE) throw new Error(`unexpected scope ${p.get('scope')}`);
    if (p.get('code_challenge_method') !== 'S256' || p.get('access_type') !== 'offline') throw new Error('missing PKCE or offline access');
    const code = this.token('code');
    this.codes.set(code, { challenge: p.get('code_challenge')!, redirectUri: p.get('redirect_uri')! });
    return { code, state: p.get('state')! };
  }

  /** Everything the family granted is withdrawn (e.g. at myaccount.google.com). */
  revokeEverything(): void {
    this.refreshTokens.clear();
    this.accessTokens.clear();
  }

  expireAccessTokens(): void {
    this.accessTokens.clear();
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const form = new URLSearchParams(String(init?.body ?? ''));
    if (url.toString() === GOOGLE_TOKEN_URL) {
      this.calls.push(`token:${form.get('grant_type')}`);
      if (form.get('client_id') !== FAKE_CLIENT.clientId || form.get('client_secret') !== FAKE_CLIENT.clientSecret) return json(401, { error: 'invalid_client' });
      if (form.get('grant_type') === 'authorization_code') {
        const entry = this.codes.get(form.get('code') ?? '');
        this.codes.delete(form.get('code') ?? '');
        const verifierOk = entry && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === entry.challenge;
        if (!entry || !verifierOk || form.get('redirect_uri') !== entry.redirectUri) return json(400, { error: 'invalid_grant' });
        const refresh = this.token('refresh');
        this.refreshTokens.add(refresh);
        const access = this.token('access');
        this.accessTokens.add(access);
        return json(200, { access_token: access, refresh_token: refresh, expires_in: 3599, scope: this.grantedScope, token_type: 'Bearer' });
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (!this.refreshTokens.has(form.get('refresh_token') ?? '')) return json(400, { error: 'invalid_grant' });
        const access = this.token('access');
        this.accessTokens.add(access);
        return json(200, { access_token: access, expires_in: 3599, scope: this.grantedScope, token_type: 'Bearer' });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url.toString() === GOOGLE_REVOKE_URL) {
      const token = form.get('token') ?? '';
      this.calls.push('revoke');
      this.revokedTokens.push(token);
      const known = this.refreshTokens.delete(token);
      return json(known ? 200 : 400, known ? {} : { error: 'invalid_token' });
    }
    if (url.origin === 'https://www.googleapis.com') {
      const bearer = new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /, '') ?? '';
      this.calls.push(`api:${url.pathname}`);
      if (!this.accessTokens.has(bearer)) return json(401, { error: { code: 401 } });
      if (!this.calendarApiEnabled || !this.grantedScope.includes(CALENDAR_READONLY_SCOPE)) return json(403, { error: { code: 403 } });
      if (url.pathname === '/calendar/v3/users/me/calendarList') {
        return json(200, { items: this.calendars.map(({ items: _items, ...c }) => c) });
      }
      const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(url.pathname);
      const calendar = m && this.calendars.find((c) => c.id === decodeURIComponent(m[1]!));
      if (!calendar) return json(404, { error: { code: 404 } });
      return json(200, { summary: calendar.summary, items: calendar.items });
    }
    throw new Error(`FakeGoogle: unexpected request ${url}`);
  };
}
