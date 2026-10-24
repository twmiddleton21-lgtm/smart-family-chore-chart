import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { buildApp, GOOGLE_OAUTH_COOKIE } from '../app';
import { AuthService } from '../auth/service';
import { openData } from '../open';
import { tempDir } from '../testUtils';
import { FakeGoogle, FAKE_CLIENT } from './fakeGoogle';
import { FamilyCalendar } from './familyCalendar';
import type { FeedSettings } from './icalFeed';
import { SecretBox } from './secretBox';

// TESTS ONLY: one family's installation (its own data folder, database,
// secret key and server) driven through the HTTP API in normal mode
// (sign-in on), against a fake Google (fakeGoogle.ts) and, for iCal
// addresses, a local test server. No real account, credential or network.

export const PASSWORD = 'correct horse battery';
export const APP_ORIGIN = new URL(FAKE_CLIENT.redirectUri).origin;
export const HOST = new URL(FAKE_CLIENT.redirectUri).host;
export const MINUTE = 60_000;

export type Jar = Record<string, string>;

export function absorb(jar: Jar, r: LightMyRequestResponse): void {
  for (const c of r.cookies as { name: string; value: string; maxAge?: number }[]) {
    if (c.value === '' || c.maxAge === 0) delete jar[c.name];
    else jar[c.name] = c.value;
  }
}

export class Installation {
  tmp = tempDir();
  opened!: Awaited<ReturnType<typeof openData>>;
  app!: FastifyInstance;
  auth!: AuthService;
  family!: FamilyCalendar;
  logs: string[] = [];
  bodies: string[] = [];
  setupCode = '';

  constructor(
    readonly google: FakeGoogle,
    readonly key: Buffer,
    readonly clock: { now: number },
    /** Google OAuth settings and the secret key present. */
    readonly configured = true,
    readonly feeds: FeedSettings = { extraHosts: [] },
    /** The secret key present (iCal addresses need nothing else). */
    readonly hasKey = configured,
  ) {}

  async start(): Promise<this> {
    this.opened = await openData(this.tmp.dir, 'Europe/London');
    const now = () => new Date(this.clock.now);
    this.auth = new AuthService(this.opened.db, { now });
    this.setupCode = this.auth.prepareSetup() ?? '';
    this.family = new FamilyCalendar({
      db: this.opened.db,
      google: this.configured ? FAKE_CLIENT : null,
      secretBox: this.hasKey ? new SecretBox(this.key) : null,
      missing: this.configured ? [] : ['SFCC_GOOGLE_CLIENT_ID', 'SFCC_GOOGLE_CLIENT_SECRET_FILE', 'SFCC_GOOGLE_REDIRECT_URI', 'SFCC_SECRET_KEY_FILE'],
      timeZone: 'Europe/London',
      feeds: this.feeds,
      fetchImpl: this.google.fetch,
      now,
    });
    this.app = buildApp({
      config: { devUnauthenticatedApi: false, bodyLimit: 64 * 1024, timeZone: 'Europe/London', port: 443, dataDir: this.tmp.dir, cookieSecure: 'auto', allowedHosts: [HOST] },
      db: this.opened.db,
      store: this.opened.store,
      auth: this.auth,
      familyCalendar: this.family,
      logger: { level: 'trace', stream: { write: (line: string) => void this.logs.push(line) } },
    });
    await this.app.ready();
    return this;
  }

  /** Server restart: close everything and open the same data folder again. */
  async restart(): Promise<void> {
    await this.app.close();
    this.opened.db.close();
    await this.start();
  }

  async stop(): Promise<void> {
    await this.app?.close();
    this.opened?.db.close();
    this.tmp.cleanup();
  }

  async req(jar: Jar | null, opts: InjectOptions): Promise<LightMyRequestResponse> {
    const r = await this.app.inject({ ...opts, headers: { host: HOST, ...(opts.headers ?? {}) }, cookies: { ...(jar ?? {}), ...(opts.cookies ?? {}) } });
    this.bodies.push(r.body, JSON.stringify(r.headers));
    if (jar) absorb(jar, r);
    return r;
  }
  get = (jar: Jar | null, url: string) => this.req(jar, { method: 'GET', url });
  post = (jar: Jar | null, url: string, payload: object = {}) => this.req(jar, { method: 'POST', url, payload });

  async firstParent(username = 'alex'): Promise<Jar> {
    const jar: Jar = {};
    const r = await this.post(jar, '/api/auth/setup', { setupCode: this.setupCode, username, displayName: 'Alex', password: PASSWORD });
    expect(r.statusCode, r.body).toBe(200);
    return jar;
  }

  async secondParent(by: Jar, username = 'blake'): Promise<Jar> {
    expect((await this.post(by, '/api/parents', { username, displayName: 'Blake', password: PASSWORD })).statusCode).toBe(200);
    const jar: Jar = {};
    expect((await this.post(jar, '/api/auth/login', { username, password: PASSWORD })).statusCode).toBe(200);
    return jar;
  }

  async pairDevice(parent: Jar): Promise<Jar> {
    const code = (await this.post(parent, '/api/devices/pairing-codes', { name: 'Kitchen kiosk' })).json().code as string;
    const device: Jar = {};
    expect((await this.post(device, '/api/devices/pair', { code })).statusCode).toBe(200);
    return device;
  }

  /** "Connect Google Calendar" → Google's consent page → back to the callback. */
  async connect(
    parent: Jar,
    approve: (url: string) => { code?: string; state: string; error?: string } = (url) => this.google.approve(url),
    options: { replace?: boolean } = {},
  ) {
    const start = await this.post(parent, '/api/calendar/google/connect', { appOrigin: APP_ORIGIN, ...options });
    expect(start.statusCode, start.body).toBe(200);
    const query = approve(start.json().authorizationUrl);
    return this.callback(parent, query);
  }

  async callback(jar: Jar | null, query: Record<string, string | undefined>) {
    const qs = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined));
    // Google's redirect is cross-site: the SameSite=Strict parent cookie is not sent, only the Lax one.
    const nonce = jar?.[GOOGLE_OAUTH_COOKIE];
    const lax: Record<string, string> = nonce ? { [GOOGLE_OAUTH_COOKIE]: nonce } : {};
    const r = await this.req(null, { method: 'GET', url: `/api/calendar/google/callback?${qs}`, cookies: lax });
    if (jar) absorb(jar, r);
    expect(r.statusCode).toBe(303);
    return /#google-calendar=(\w+)$/.exec(r.headers.location as string)?.[1];
  }

  /** Check an iCal address, then use it (confirming any replacement). Returns the "use" answer. */
  async useFeed(parent: Jar, url: string, options: { replace?: boolean } = {}) {
    const check = await this.post(parent, '/api/calendar/ical/check', { url });
    expect(check.statusCode, check.body).toBe(200);
    return this.post(parent, '/api/calendar/ical/use', { checkId: check.json().checkId, ...options });
  }

  storedRow() {
    return this.opened.db.get<Record<string, string>>('SELECT * FROM google_calendar_connection WHERE id = 1');
  }

  storedFeed() {
    return this.opened.db.get<Record<string, string>>('SELECT * FROM ical_feed_connection WHERE id = 1');
  }
}
