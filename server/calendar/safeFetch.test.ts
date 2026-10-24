import http, { type IncomingMessage, type RequestOptions, type ServerResponse } from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkFetchUrl, FeedFetchError, guardedLookup, isPublicAddress, safeFetchText, type Resolver, type SafeFetchOptions } from './safeFetch';

// SSRF protections for fetching calendar addresses. A local HTTP server
// stands in for calendar providers; DNS is a stub. Where a test needs a
// connection to succeed, 127.0.0.1 plays the "public" address (allowed via
// the test-only isAllowedAddress hook) and every other address is refused.
// Tests about refusing real non-public addresses use the real check.

const SECRET_PATH = '/calendar/ical/family%40example.test/private-0123456789abcdef0123456789abcdef/basic.ics';
const FEED = `https://calendar.google.com${SECRET_PATH}`;
const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
const allowGoogle = (h: string) => h === 'calendar.google.com' || h === 'other.example.test';

let server: http.Server;
let port: number;
let handler: (req: IncomingMessage, res: ServerResponse) => void;
let connections: number;
let seen: IncomingMessage[];

beforeEach(async () => {
  connections = 0;
  seen = [];
  handler = (_req, res) => res.end(ICS);
  server = http.createServer((req, res) => {
    seen.push(req);
    handler(req, res);
  });
  server.on('connection', () => connections++);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const answers = (...addresses: string[]): Resolver => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
/** Plain HTTP to the local test server, keeping the guarded lookup (so DNS checks still apply). */
const toLocalServer = (opts: RequestOptions, cb: (res: IncomingMessage) => void) => http.request({ ...opts, protocol: 'http:', port }, cb);
/** Test options in which 127.0.0.1 counts as the one "public" address. */
const local = (extra: Partial<SafeFetchOptions> = {}): SafeFetchOptions => ({
  allowHost: allowGoogle,
  resolve: answers('127.0.0.1'),
  isAllowedAddress: (a) => a === '127.0.0.1',
  requestImpl: toLocalServer,
  ...extra,
});
const failureOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(FeedFetchError);
    // An error never repeats the (secret) address.
    expect((error as Error).message).not.toContain('private-');
    expect((error as Error).message).not.toContain('calendar.google.com');
    return (error as FeedFetchError).failure;
  }
  throw new Error('expected a failure');
};

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.17.0.1', // Docker's default bridge
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.1.20',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'fe80::1%eth0',
    'fc00::1',
    'fd00:ec2::254', // AWS metadata over IPv6
    'ff02::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:7f00:1',
    '::ffff:8.8.8.8', // mapped, even if public: never needed, so refused
    '::127.0.0.1', // IPv4-compatible
    '64:ff9b::a00:1', // NAT64 of 10.0.0.1
    '100::1',
    '2001::1', // Teredo
    '2001:db8::1',
    '2002:7f00:1::1', // 6to4 of 127.0.0.1
    '3fff::1',
    'localhost',
    'not-an-ip',
    '',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '142.250.180.14', '172.32.0.1', '100.128.0.1', '2001:4860:4860::8888', '2a00:1450:4009:81f::200e', '2606:4700::1111'])('allows %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('checkFetchUrl', () => {
  const check = (raw: string) => {
    try {
      checkFetchUrl(new URL(raw), allowGoogle);
      return 'ok';
    } catch (error) {
      return (error as FeedFetchError).failure;
    }
  };

  it('accepts an https address on an allowed host', () => {
    expect(check(FEED)).toBe('ok');
    expect(check(`https://calendar.google.com:443${SECRET_PATH}`)).toBe('ok');
    expect(check(`https://CALENDAR.Google.COM${SECRET_PATH}`)).toBe('ok'); // the parser lower-cases
  });

  it.each([
    ['plain http', `http://calendar.google.com${SECRET_PATH}`],
    ['another scheme', 'ftp://calendar.google.com/x.ics'],
    ['file', 'file:///etc/passwd'],
    ['a user name', `https://user@calendar.google.com${SECRET_PATH}`],
    ['user:password', `https://u:p@calendar.google.com${SECRET_PATH}`],
    ['the allowed host as user info', 'https://calendar.google.com@evil.example/x.ics'],
    ['an unexpected port', `https://calendar.google.com:8443${SECRET_PATH}`],
    ['an IPv4 literal', 'https://127.0.0.1/x.ics'],
    ['a decimal IPv4', 'https://2130706433/x.ics'],
    ['a hex IPv4', 'https://0x7f.1/x.ics'],
    ['an octal IPv4', 'https://0177.0.0.1/x.ics'],
    ['an IPv6 literal', 'https://[::1]/x.ics'],
    ['a mapped IPv6 literal', 'https://[::ffff:169.254.169.254]/x.ics'],
    ['a metadata host name', 'https://metadata.google.internal/computeMetadata/v1/'],
    ['localhost', 'https://localhost/x.ics'],
    ['a look-alike suffix', 'https://calendar.google.com.evil.example/x.ics'],
    ['a look-alike prefix', 'https://evilcalendar.google.com/x.ics'],
    ['a trailing dot', `https://calendar.google.com.${SECRET_PATH}`],
    ['an encoded dot', 'https://calendar%2egoogle%2ecom.evil.example/x.ics'],
    ['a unicode look-alike', 'https://calendar.gооgle.com/x.ics'], // Cyrillic o's
  ])('refuses %s', (_name, raw) => {
    expect(check(raw)).toBe('blocked');
  });
});

describe('guardedLookup (the address check runs inside the socket’s own DNS lookup)', () => {
  const run = (resolve: Resolver, options: { all?: boolean; family?: number } = {}) =>
    new Promise<{ error: Error | null; address: unknown; family?: number }>((done) =>
      guardedLookup(resolve, isPublicAddress)('host.example', options as never, (error, address, family) => done({ error, address, family })),
    );

  it('hands the socket only checked public addresses (single and all-addresses forms)', async () => {
    expect(await run(answers('8.8.8.8'))).toEqual({ error: null, address: '8.8.8.8', family: 4 });
    expect((await run(answers('8.8.8.8', '2001:4860:4860::8888'), { all: true })).address).toEqual([
      { address: '8.8.8.8', family: 4 },
      { address: '2001:4860:4860::8888', family: 6 },
    ]);
    expect(await run(answers('8.8.8.8', '2001:4860:4860::8888'), { family: 6 })).toEqual({ error: null, address: '2001:4860:4860::8888', family: 6 });
  });

  it.each([
    ['loopback', ['127.0.0.1']],
    ['a private address', ['192.168.1.1']],
    ['cloud metadata', ['169.254.169.254']],
    ['IPv6 loopback', ['::1']],
    ['a unique-local IPv6', ['fd12:3456::1']],
    ['a mixed answer (one good, one private)', ['8.8.8.8', '10.0.0.5']],
    ['a mixed answer (private first)', ['10.0.0.5', '8.8.8.8']],
  ])('refuses %s', async (_name, addresses) => {
    const r = await run(answers(...addresses), { all: true });
    expect(r.error).toBeInstanceOf(FeedFetchError);
    expect((r.error as FeedFetchError).failure).toBe('blocked');
  });

  it('reports a name that does not resolve as not found', async () => {
    expect((await run(answers())).error).toMatchObject({ code: 'ENOTFOUND' });
    expect((await run(() => Promise.reject(new Error('SERVFAIL')))).error).toMatchObject({ code: 'ENOTFOUND' });
  });
});

describe('safeFetchText', () => {
  it('fetches the calendar, sending only Accept, Accept-Encoding and User-Agent (no cookies or credentials)', async () => {
    expect(await safeFetchText(new URL(FEED), local())).toBe(ICS);
    const req = seen[0]!;
    expect(req.method).toBe('GET');
    expect(req.url).toBe(SECRET_PATH);
    expect(Object.keys(req.headers).sort()).toEqual(['accept', 'accept-encoding', 'connection', 'host', 'user-agent']);
    expect(req.headers.host).toBe(`calendar.google.com:${port}`); // the test server's port; 443 (omitted) for real
  });

  it('never connects to a host that resolves to a non-public address (real address check)', async () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.17.0.1', '::1', 'fd00:ec2::254', '::ffff:127.0.0.1']) {
      const failure = await failureOf(safeFetchText(new URL(FEED), { allowHost: allowGoogle, resolve: answers(address), requestImpl: toLocalServer }));
      expect(failure, address).toBe('blocked');
    }
    expect(connections).toBe(0);
  });

  it('DNS rebinding: each connection uses exactly the address its own lookup checked', async () => {
    let calls = 0;
    // First answer is the allowed address, every later one a forbidden one (127.0.0.2).
    const rebinding: Resolver = async () => [{ address: calls++ === 0 ? '127.0.0.1' : '127.0.0.2', family: 4 }];
    const opts = local({ resolve: rebinding });
    expect(await safeFetchText(new URL(FEED), opts)).toBe(ICS);
    expect(await failureOf(safeFetchText(new URL(FEED), opts))).toBe('blocked');
    expect(calls).toBe(2); // one lookup per connection, no separate "check first" lookup to race
    expect(connections).toBe(1);
  });

  it('checks the peer address again after connecting', async () => {
    // A transport that ignores the guarded lookup and connects to 127.0.0.1 directly.
    const bypass = (opts: RequestOptions, cb: (res: IncomingMessage) => void) => http.request({ ...opts, protocol: 'http:', host: '127.0.0.1', lookup: undefined, port }, cb);
    expect(await failureOf(safeFetchText(new URL(FEED), { allowHost: allowGoogle, resolve: answers('8.8.8.8'), requestImpl: bypass }))).toBe('blocked');
    // Checked when the connection opens, before the request is written.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toHaveLength(0);
  });

  describe('redirects', () => {
    it('follows a redirect to an allowed https address (every hop resolved and checked)', async () => {
      const hosts: string[] = [];
      handler = (req, res) => {
        if (req.url === '/start.ics') return res.writeHead(302, { Location: 'https://other.example.test/final.ics' }).end();
        res.end(ICS);
      };
      const resolve: Resolver = async (h) => (hosts.push(h), [{ address: '127.0.0.1', family: 4 }]);
      expect(await safeFetchText(new URL('https://calendar.google.com/start.ics'), local({ resolve }))).toBe(ICS);
      expect(hosts).toEqual(['calendar.google.com', 'other.example.test']);
    });

    it.each([
      ['plain http', 'http://calendar.google.com/x.ics'],
      ['a host that isn’t allowed', 'https://evil.example/x.ics'],
      ['loopback by IP', 'https://127.0.0.1/x.ics'],
      ['cloud metadata by IP', 'https://169.254.169.254/latest/meta-data/'],
      ['IPv6 loopback', 'https://[::1]/x.ics'],
      ['another port', 'https://calendar.google.com:8080/x.ics'],
      ['user info', 'https://calendar.google.com@evil.example/x.ics'],
      ['a file', 'file:///etc/passwd'],
    ])('refuses a redirect to %s', async (_name, location) => {
      handler = (_req, res) => res.writeHead(302, { Location: location }).end();
      expect(await failureOf(safeFetchText(new URL(FEED), local()))).toBe('blocked');
      expect(connections).toBe(1);
    });

    it('refuses a redirect to an allowed host that now resolves to a non-public address', async () => {
      handler = (req, res) => (req.url === '/start.ics' ? res.writeHead(302, { Location: 'https://other.example.test/x.ics' }).end() : res.end(ICS));
      const resolve: Resolver = async (h) => [{ address: h === 'calendar.google.com' ? '127.0.0.1' : '127.0.0.2', family: 4 }];
      expect(await failureOf(safeFetchText(new URL('https://calendar.google.com/start.ics'), local({ resolve })))).toBe('blocked');
    });

    it('gives up after three redirects', async () => {
      let n = 0;
      handler = (_req, res) => res.writeHead(301, { Location: `/loop-${++n}.ics` }).end();
      expect(await failureOf(safeFetchText(new URL(FEED), local()))).toBe('redirect');
      expect(n).toBe(4);
    });

    it('closes a redirect’s connection at once instead of draining its body (audit F3)', async () => {
      // The redirect comes with a body that never ends. Before the fix the
      // old connection kept downloading (6 MB in 1.5 s, unbounded) after
      // the fetch had moved on.
      const redirect = endlessRedirect('https://other.example.test/final.ics');
      handler = (req, res) => (req.url === SECRET_PATH ? redirect.handle(res) : res.end(ICS));
      const hosts: string[] = [];
      const resolve: Resolver = async (h) => (hosts.push(h), [{ address: '127.0.0.1', family: 4 }]);
      expect(await safeFetchText(new URL(FEED), local({ resolve }))).toBe(ICS);
      const sentWhenDone = redirect.sent();
      await new Promise((r) => setTimeout(r, 300));
      expect(redirect.closed()).toBe(true);
      const sentLater = redirect.sent();
      await new Promise((r) => setTimeout(r, 300));
      expect(redirect.sent()).toBe(sentLater); // nothing more is sent
      // At most what socket buffers took before the close (measured: none to a few hundred KB).
      expect(sentLater - sentWhenDone).toBeLessThan(4 * 1024 * 1024);
      expect(hosts).toEqual(['calendar.google.com', 'other.example.test']); // the next hop was resolved and checked as usual
    });

    it('closes a redirect’s connection even when the next hop is refused', async () => {
      const redirect = endlessRedirect('https://evil.example/x.ics');
      handler = (_req, res) => redirect.handle(res);
      expect(await failureOf(safeFetchText(new URL(FEED), local()))).toBe('blocked');
      await new Promise((r) => setTimeout(r, 300));
      expect(redirect.closed()).toBe(true);
    });
  });

  describe('hostile or failing answers', () => {
    it.each([
      [401, 'refused'],
      [403, 'refused'],
      [404, 'not_found'],
      [410, 'not_found'],
      [429, 'rate_limited'],
      [500, 'unavailable'],
      [503, 'unavailable'],
      [204, 'bad_response'],
      [418, 'bad_response'],
    ] as const)('maps HTTP %i to "%s"', async (status, failure) => {
      handler = (_req, res) => res.writeHead(status).end('nope');
      expect(await failureOf(safeFetchText(new URL(FEED), local()))).toBe(failure);
    });

    it('refuses a web page instead of a calendar (e.g. a sign-in page)', async () => {
      handler = (_req, res) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<html>Sign in</html>');
      expect(await failureOf(safeFetchText(new URL(FEED), local()))).toBe('bad_response');
    });

    it('refuses an oversized answer: declared, streamed without a length, and a gzip bomb', async () => {
      const maxBytes = 64 * 1024;
      handler = (_req, res) => res.writeHead(200, { 'Content-Length': String(maxBytes + 1) }).end('x'.repeat(maxBytes + 1));
      expect(await failureOf(safeFetchText(new URL(FEED), local({ maxBytes }))), handler.toString().slice(0, 60)).toBe('too_large');

      handler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/calendar' });
        const chunk = 'y'.repeat(16 * 1024);
        for (let i = 0; i < 8; i++) res.write(chunk);
        res.end();
      };
      expect(await failureOf(safeFetchText(new URL(FEED), local({ maxBytes }))), handler.toString().slice(0, 60)).toBe('too_large');

      const bomb = gzipSync(Buffer.alloc(20 * 1024 * 1024)); // 20 MB of zeros, about 20 KB compressed
      expect(bomb.length).toBeLessThan(maxBytes);
      handler = (_req, res) => res.writeHead(200, { 'Content-Encoding': 'gzip' }).end(bomb);
      expect(await failureOf(safeFetchText(new URL(FEED), local({ maxBytes }))), handler.toString().slice(0, 60)).toBe('too_large');
    });

    it('reads a gzip-compressed calendar and refuses unknown encodings', async () => {
      handler = (_req, res) => res.writeHead(200, { 'Content-Encoding': 'gzip' }).end(gzipSync(ICS));
      expect(await safeFetchText(new URL(FEED), local())).toBe(ICS);
      handler = (_req, res) => res.writeHead(200, { 'Content-Encoding': 'br' }).end('x');
      expect(await failureOf(safeFetchText(new URL(FEED), local()))).toBe('bad_response');
    });

    it('times out a server that never answers, and a connection that never starts', async () => {
      handler = () => {}; // accepts, never answers
      expect(await failureOf(safeFetchText(new URL(FEED), local({ totalTimeoutMs: 300 })))).toBe('timeout');
      const never: Resolver = () => new Promise(() => {});
      expect(await failureOf(safeFetchText(new URL(FEED), local({ resolve: never, connectTimeoutMs: 200 })))).toBe('timeout');
    });

    it('times out a server that answers too slowly (total limit, not just idle)', async () => {
      handler = (_req, res) => {
        res.writeHead(200);
        const timer = setInterval(() => res.write('BEGIN'), 50); // keeps "talking", never finishes
        res.on('close', () => clearInterval(timer));
      };
      expect(await failureOf(safeFetchText(new URL(FEED), local({ totalTimeoutMs: 400 })))).toBe('timeout');
    });

    it('reports a host that does not resolve as unavailable', async () => {
      expect(await failureOf(safeFetchText(new URL(FEED), local({ resolve: answers() })))).toBe('unavailable');
    });
  });
});

/** A redirect whose body never ends: sent as fast as the client reads it, until the connection closes. */
function endlessRedirect(location: string) {
  let sent = 0;
  let closed = false;
  const chunk = Buffer.alloc(64 * 1024, 'z');
  return {
    handle(res: ServerResponse) {
      res.writeHead(302, { Location: location, 'Content-Type': 'text/plain' });
      res.on('close', () => (closed = true));
      const pump = () => {
        while (!closed) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
      };
      pump();
    },
    sent: () => sent,
    closed: () => closed,
  };
}

// ---------- the real TLS path (https.request, as in production) ----------

// TEST ONLY: a self-signed certificate for feed.example.test and
// other.example.test (valid until 2126), trusted only by these tests through
// the `ca` option. It secures nothing.
const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgEkSfswpMKZEHnymI
H2CNSwl4cw67m18cqOhdOW/0/vWhRANCAASb45f75kV8wP8Hhf8fx3S8hH/dwTjO
Hrow4x7rJIpNnya9knPkrJqzD65i5eBX9z60noDqfJqTiyLLdDPQs8fN
-----END PRIVATE KEY-----`;
const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBwzCCAWmgAwIBAgIUc/kl+t7y+710ywsGGb6Eopm7pnowCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRZmVlZC5leGFtcGxlLnRlc3QwIBcNMjYxMDI0MTQzNDU5WhgP
MjEyNjA5MzAxNDM0NTlaMBwxGjAYBgNVBAMMEWZlZWQuZXhhbXBsZS50ZXN0MFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEm+OX++ZFfMD/B4X/H8d0vIR/3cE4zh66
MOMe6ySKTZ8mvZJz5Kyasw+uYuXgV/c+tJ6A6nyak4siy3Qz0LPHzaOBhjCBgzAd
BgNVHQ4EFgQUv2AiUOBXd+miMGI3aFGgvqE+9UMwHwYDVR0jBBgwFoAUv2AiUOBX
d+miMGI3aFGgvqE+9UMwDwYDVR0TAQH/BAUwAwEB/zAwBgNVHREEKTAnghFmZWVk
LmV4YW1wbGUudGVzdIISb3RoZXIuZXhhbXBsZS50ZXN0MAoGCCqGSM49BAMCA0gA
MEUCIQCHBM0tv/MPEFxxbmY/xOMSJa9VTFSzoVeVu0zIwFhuqQIgW6adBLnRUwuB
VUpFjf48x0Q/8FvL/ImaYviGNmbjIC4=
-----END CERTIFICATE-----`;

describe('safeFetchText over real TLS (https.request, the guarded lookup, certificate checks)', () => {
  const TLS_FEED = `https://feed.example.test${SECRET_PATH}`;
  const allowTest = (h: string) => h === 'feed.example.test' || h === 'other.example.test' || h === 'calendar.google.com';
  let tlsServer: https.Server;
  let tlsPort: number;
  let tlsHandler: (req: IncomingMessage, res: ServerResponse) => void;
  let tcpConnections: number;
  let handshakes: number;
  let requests: IncomingMessage[];

  beforeEach(async () => {
    tcpConnections = 0;
    handshakes = 0;
    requests = [];
    tlsHandler = (_req, res) => res.writeHead(200, { 'Content-Type': 'text/calendar' }).end(ICS);
    tlsServer = https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
      requests.push(req);
      tlsHandler(req, res);
    });
    tlsServer.on('connection', () => tcpConnections++);
    tlsServer.on('secureConnection', () => handshakes++);
    tlsServer.on('tlsClientError', () => {});
    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
    tlsPort = (tlsServer.address() as AddressInfo).port;
  });
  afterEach(async () => {
    tlsServer.closeAllConnections();
    await new Promise((resolve) => tlsServer.close(resolve));
  });

  /** https.request to the local TLS server; everything else (lookup, SNI, no agent) as safeFetch set it. */
  const toTlsServer =
    (extra: https.RequestOptions = { ca: TEST_TLS_CERT }) =>
    (opts: RequestOptions, cb: (res: IncomingMessage) => void) =>
      https.request({ ...opts, ...extra, port: tlsPort }, cb);
  const tls = (extra: Partial<SafeFetchOptions> = {}): SafeFetchOptions => ({
    allowHost: allowTest,
    resolve: answers('127.0.0.1'),
    isAllowedAddress: (a) => a === '127.0.0.1',
    requestImpl: toTlsServer(),
    ...extra,
  });

  it('fetches over TLS, connecting only through the guarded lookup', async () => {
    const hosts: string[] = [];
    expect(await safeFetchText(new URL(TLS_FEED), tls({ resolve: async (h) => (hosts.push(h), [{ address: '127.0.0.1', family: 4 }]) }))).toBe(ICS);
    expect(hosts).toEqual(['feed.example.test']);
    expect(requests.map((r) => r.url)).toEqual([SECRET_PATH]);
  });

  it('refuses a certificate it doesn’t trust, and one for another name, before sending the request', async () => {
    expect(await failureOf(safeFetchText(new URL(TLS_FEED), tls({ requestImpl: toTlsServer({}) })))).toBe('unavailable'); // self-signed, not trusted
    // The certificate is for feed.example.test, not calendar.google.com (SNI and name check use the address's host).
    expect(await failureOf(safeFetchText(new URL(FEED), tls()))).toBe('unavailable');
    expect(requests).toHaveLength(0);
  });

  it('refuses a host that resolves to a non-public address over TLS too (real address check, no connection)', async () => {
    expect(await failureOf(safeFetchText(new URL(TLS_FEED), { allowHost: allowTest, resolve: answers('127.0.0.1'), requestImpl: toTlsServer() }))).toBe('blocked');
    expect(tcpConnections).toBe(0);
  });

  it('checks the peer when the TCP connection opens: before the TLS handshake, so the secret path is never sent', async () => {
    // A transport that skips the guarded lookup and connects straight to 127.0.0.1, which these options forbid.
    const bypass = (opts: RequestOptions, cb: (res: IncomingMessage) => void) => https.request({ ...opts, ca: TEST_TLS_CERT, host: '127.0.0.1', lookup: undefined, port: tlsPort }, cb);
    expect(await failureOf(safeFetchText(new URL(TLS_FEED), { allowHost: allowTest, resolve: answers('8.8.8.8'), requestImpl: bypass }))).toBe('blocked');
    await new Promise((r) => setTimeout(r, 100));
    expect(handshakes).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it('times out a connection whose TLS handshake never completes (the connect limit covers the handshake)', async () => {
    // Accepts TCP, then says nothing.
    const silent = net.createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const silentPort = (silent.address() as AddressInfo).port;
    const started = Date.now();
    try {
      const toSilent = (opts: RequestOptions, cb: (res: IncomingMessage) => void) => https.request({ ...opts, ca: TEST_TLS_CERT, port: silentPort }, cb);
      expect(await failureOf(safeFetchText(new URL(TLS_FEED), tls({ requestImpl: toSilent, connectTimeoutMs: 300, totalTimeoutMs: 10_000 })))).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      silent.close();
    }
  });

  it('closes a redirect’s TLS connection at once, and checks the next hop as usual', async () => {
    const redirect = endlessRedirect('https://other.example.test/final.ics');
    tlsHandler = (req, res) => (req.url === SECRET_PATH ? redirect.handle(res) : res.writeHead(200, { 'Content-Type': 'text/calendar' }).end(ICS));
    const hosts: string[] = [];
    expect(await safeFetchText(new URL(TLS_FEED), tls({ resolve: async (h) => (hosts.push(h), [{ address: '127.0.0.1', family: 4 }]) }))).toBe(ICS);
    await new Promise((r) => setTimeout(r, 300));
    expect(redirect.closed()).toBe(true);
    const sent = redirect.sent();
    await new Promise((r) => setTimeout(r, 300));
    expect(redirect.sent()).toBe(sent);
    expect(hosts).toEqual(['feed.example.test', 'other.example.test']);
    // And a redirect onward to a forbidden address is still refused.
    tlsHandler = (_req, res) => res.writeHead(302, { Location: 'https://other.example.test/x.ics' }).end();
    const resolve: Resolver = async (h) => [{ address: h === 'feed.example.test' ? '127.0.0.1' : '10.0.0.1', family: 4 }];
    expect(await failureOf(safeFetchText(new URL(TLS_FEED), tls({ resolve })))).toBe('blocked');
  });
});
