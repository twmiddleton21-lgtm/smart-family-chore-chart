import { promises as dns, type LookupAddress } from 'node:dns';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction, type Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { createGunzip } from 'node:zlib';

// Fetching a calendar feed from an address a parent typed in, without
// turning the family server into a proxy for anything else.
//
// - HTTPS on port 443 only; no user name or password in the address; no IP
//   literals (so no 0x7f.1, 2130706433 or [::ffff:127.0.0.1] tricks); the
//   host must pass the caller's allow-list.
// - The address check runs INSIDE the socket's own DNS lookup: the address
//   that is checked is the one the socket connects to, so a name that
//   resolves to a public address once and to 127.0.0.1 a moment later
//   (DNS rebinding) can't slip through. If ANY resolved address is not a
//   public unicast address, nothing is connected. After connecting, the
//   socket's peer address is checked again.
// - Redirects are followed only to addresses that pass the same checks, at
//   most MAX_REDIRECTS times. Every hop is resolved and checked afresh.
// - Strict connect and total time limits, a size limit (also after gzip
//   decompression), and no cookies or caller headers: only Accept,
//   Accept-Encoding and User-Agent are sent.
// - Errors never contain the address (it may be a secret).

export type FeedFetchFailure =
  | 'blocked' // not a public address, or not an allowed host
  | 'refused' // 401 / 403
  | 'not_found' // 404 / 410
  | 'redirect' // too many redirects
  | 'too_large'
  | 'timeout'
  | 'rate_limited' // 429
  | 'bad_response' // unexpected status, encoding or content type
  | 'unavailable'; // DNS or network failure, 5xx

export class FeedFetchError extends Error {
  constructor(public readonly failure: FeedFetchFailure, message: string) {
    super(message);
  }
}

export const MAX_FEED_BYTES = 5 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'SmartFamilyChoreChart/1 (read-only calendar feed)';

// ---------- which addresses may be contacted ----------

const NON_PUBLIC_V4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private (also Docker's default networks)
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including broadcast
] as const) {
  NON_PUBLIC_V4.addSubnet(net, prefix, 'ipv4');
}

/** IPv6 is allowed only inside global unicast (2000::/3), minus the special blocks in it. */
const GLOBAL_UNICAST_V6 = new BlockList();
GLOBAL_UNICAST_V6.addSubnet('2000::', 3, 'ipv6');
const NON_PUBLIC_V6 = new BlockList();
for (const [net, prefix] of [
  ['2001::', 23], // IETF protocol assignments, including Teredo (2001::/32)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4 address)
  ['3fff::', 20], // documentation
] as const) {
  NON_PUBLIC_V6.addSubnet(net, prefix, 'ipv6');
}

/**
 * True only for public unicast addresses. Loopback, private, link-local,
 * unique-local, multicast, reserved, documentation, NAT64 and
 * IPv4-mapped/compatible IPv6 addresses (::ffff:10.0.0.1) are all refused.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NON_PUBLIC_V4.check(address, 'ipv4');
  if (family === 6) {
    const a = address.replace(/%.*$/, ''); // a zone index (fe80::1%eth0) is never public anyway
    return isIP(a) === 6 && GLOBAL_UNICAST_V6.check(a, 'ipv6') && !NON_PUBLIC_V6.check(a, 'ipv6');
  }
  return false;
}

// ---------- the address itself ----------

/**
 * Checks an https:// address before anything is contacted. Throws
 * FeedFetchError('blocked') without repeating the address.
 */
export function checkFetchUrl(url: URL, allowHost: (hostname: string) => boolean): void {
  if (url.protocol !== 'https:') throw new FeedFetchError('blocked', 'Only https:// addresses can be used.');
  if (url.username || url.password) throw new FeedFetchError('blocked', 'Addresses with a user name or password can’t be used.');
  if (url.port && url.port !== '443') throw new FeedFetchError('blocked', 'Only the standard HTTPS port can be used.');
  const host = url.hostname;
  // The URL parser has already turned 0x7f.1, 2130706433 etc. into dotted
  // form, so this catches every IPv4 spelling as well as [IPv6].
  if (isIP(host) || host.startsWith('[')) throw new FeedFetchError('blocked', 'Addresses must use a host name, not an IP address.');
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
    throw new FeedFetchError('blocked', 'That host name can’t be used.');
  }
  if (!allowHost(host)) throw new FeedFetchError('blocked', 'That calendar provider isn’t supported by this family server.');
}

// ---------- fetching ----------

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

export interface SafeFetchOptions {
  allowHost: (hostname: string) => boolean;
  /** DNS (tests use a stub). */
  resolve?: Resolver;
  /** TESTS ONLY: which resolved addresses may be contacted (default: public ones). */
  isAllowedAddress?: (address: string) => boolean;
  /** TESTS ONLY: an https.request-compatible function (e.g. http.request to a local server). */
  requestImpl?: (options: RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest;
  maxBytes?: number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
}

const systemResolver: Resolver = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

/**
 * A `lookup` for the socket that only ever hands it checked addresses, so
 * there is no gap between checking and connecting.
 */
export function guardedLookup(resolve: Resolver, isAllowed: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (found) => {
        const wanted = options.family === 4 || options.family === 6 ? found.filter((a) => a.family === options.family) : found;
        if (!found.length || !wanted.length) {
          callback(Object.assign(new Error('Host not found.'), { code: 'ENOTFOUND' }), '', 0);
        } else if (found.some((a) => !isAllowed(a.address))) {
          // One bad answer spoils them all: never pick "the good one" of a mixed set.
          callback(new FeedFetchError('blocked', 'The calendar host points to an address this server won’t contact.'), '', 0);
        } else if (options.all) {
          (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, wanted);
        } else {
          callback(null, wanted[0]!.address, wanted[0]!.family);
        }
      },
      () => callback(Object.assign(new Error('Host not found.'), { code: 'ENOTFOUND' }), '', 0),
    );
  };
}

type Hop = { kind: 'redirect'; location: string } | { kind: 'body'; body: string };

function fetchOnce(url: URL, options: Required<Omit<SafeFetchOptions, 'requestImpl'>> & Pick<SafeFetchOptions, 'requestImpl'>, deadline: number): Promise<Hop> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // Settle first, then tear down: destroying emits events that must not win.
    const fail = (error: FeedFetchError) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearTimeout(connectTimer);
      reject(error);
      request.destroy();
    };
    const succeed = (hop: Hop) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearTimeout(connectTimer);
      resolve(hop);
      // Close the connection: after a redirect its body is never read, and
      // draining it would download without the size and time limits.
      request.destroy();
    };
    const blocked = () => fail(new FeedFetchError('blocked', 'The calendar host points to an address this server won’t contact.'));
    const request = (options.requestImpl ?? https.request)(
      {
        protocol: 'https:',
        host: url.hostname,
        servername: url.hostname, // TLS SNI and certificate check against the host name
        port: 443,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        headers: { Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.1', 'Accept-Encoding': 'gzip', 'User-Agent': USER_AGENT },
        lookup: guardedLookup(options.resolve, options.isAllowedAddress),
        agent: false, // a fresh connection: no shared pool, no proxy
      },
      (response) => {
        const peer = response.socket?.remoteAddress;
        if (!peer || !options.isAllowedAddress(peer)) return blocked();
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          return location ? succeed({ kind: 'redirect', location }) : fail(new FeedFetchError('bad_response', 'The calendar server sent a redirect without a destination.'));
        }
        if (status !== 200) {
          response.resume();
          if (status === 401 || status === 403) return fail(new FeedFetchError('refused', `The calendar server refused access (${status}).`));
          if (status === 404 || status === 410) return fail(new FeedFetchError('not_found', `The calendar server has no calendar at that address (${status}).`));
          if (status === 429) return fail(new FeedFetchError('rate_limited', 'The calendar server asked us to slow down (429).'));
          if (status >= 500) return fail(new FeedFetchError('unavailable', `The calendar server failed (${status}).`));
          return fail(new FeedFetchError('bad_response', `The calendar server answered ${status}.`));
        }
        const type = String(response.headers['content-type'] ?? '').toLowerCase();
        if (/^(text\/html|application\/(json|xhtml\+xml))/.test(type)) {
          response.resume();
          return fail(new FeedFetchError('bad_response', 'The address returned a web page, not a calendar.'));
        }
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          response.resume();
          return fail(new FeedFetchError('too_large', 'The calendar is too large.'));
        }
        const encoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
        if (encoding !== 'identity' && encoding !== 'gzip') {
          response.resume();
          return fail(new FeedFetchError('bad_response', 'The calendar server used an unsupported encoding.'));
        }
        const stream: NodeJS.ReadableStream = encoding === 'gzip' ? response.pipe(createGunzip()) : response;
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          // Counted after decompression, so a small gzip bomb can't expand past the limit.
          if (size > options.maxBytes) return fail(new FeedFetchError('too_large', 'The calendar is too large.'));
          chunks.push(chunk);
        });
        stream.on('error', () => fail(new FeedFetchError('bad_response', 'The calendar download was damaged.')));
        response.on('aborted', () => fail(new FeedFetchError('unavailable', 'The calendar download was interrupted.')));
        stream.on('end', () => succeed({ kind: 'body', body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    const totalTimer = setTimeout(() => fail(new FeedFetchError('timeout', 'The calendar server took too long.')), Math.max(0, deadline - Date.now()));
    const connectTimer = setTimeout(() => fail(new FeedFetchError('timeout', 'The calendar server took too long to answer.')), options.connectTimeoutMs);
    request.on('socket', (socket: Socket) => {
      // The peer, checked as soon as the TCP connection exists: over TLS that
      // is before the handshake, so before the (secret) path is sent. Checked
      // again on the response above.
      socket.once('connect', () => {
        if (!socket.remoteAddress || !options.isAllowedAddress(socket.remoteAddress)) blocked();
      });
      socket.once(socket instanceof TLSSocket ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer));
    });
    request.on('error', (error) => fail(error instanceof FeedFetchError ? error : new FeedFetchError('unavailable', 'The calendar server could not be reached.')));
    request.end();
  });
}

/**
 * GET an https:// calendar address under all the rules above and return
 * the body as text. Throws FeedFetchError.
 */
export async function safeFetchText(address: URL, options: SafeFetchOptions): Promise<string> {
  const opts = {
    allowHost: options.allowHost,
    resolve: options.resolve ?? systemResolver,
    isAllowedAddress: options.isAllowedAddress ?? isPublicAddress,
    requestImpl: options.requestImpl,
    maxBytes: options.maxBytes ?? MAX_FEED_BYTES,
    connectTimeoutMs: options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    totalTimeoutMs: options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS,
  };
  const deadline = Date.now() + opts.totalTimeoutMs;
  let url = address;
  for (let hop = 0; ; hop++) {
    checkFetchUrl(url, opts.allowHost);
    const result = await fetchOnce(url, opts, deadline);
    if (result.kind === 'body') return result.body;
    if (hop >= MAX_REDIRECTS) throw new FeedFetchError('redirect', 'The calendar address redirected too many times.');
    try {
      url = new URL(result.location, url);
    } catch {
      throw new FeedFetchError('bad_response', 'The calendar server sent an unusable redirect.');
    }
  }
}
