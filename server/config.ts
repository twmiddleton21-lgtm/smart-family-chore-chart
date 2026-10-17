import { isIP } from 'node:net';
import path from 'node:path';

// Server configuration from environment variables. Everything has a safe
// default; invalid values stop the server instead of being silently ignored.

export interface ServerConfig {
  /** Directory holding the SQLite database and backups. */
  dataDir: string;
  host: string;
  port: number;
  /** IANA time zone used for "today" in server-side business rules. */
  timeZone: string;
  /**
   * DEVELOPMENT ONLY (Stage A): exposes the family-data API without any
   * authentication, restricted to loopback clients. Never a production
   * default; see assertSafeConfig().
   */
  devUnauthenticatedApi: boolean;
  production: boolean;
  /** Maximum JSON request body size in bytes. */
  bodyLimit: number;
  /** Secure flag on session cookies: "auto" (when the request is HTTPS), "always" or "never". */
  cookieSecure: 'auto' | 'always' | 'never';
  /** Optional fixed first-run setup code (otherwise a random one is printed at start-up). */
  setupCode?: string;
  /**
   * Reverse proxies to trust (IP addresses or CIDR ranges; empty = none).
   * Only for requests from these addresses are X-Forwarded-For (client
   * address, used for rate limits) and X-Forwarded-Proto (HTTPS, used for
   * Secure cookies) believed.
   */
  trustProxy: string[];
  /**
   * Folder with the built frontend (server build, `npm run build:app`) to
   * serve at /. Unset: API only (development, where Vite serves the app).
   */
  staticDir?: string;
  /**
   * Host names (or IP addresses) the server answers to, besides the loopback
   * names (localhost, 127.0.0.1, [::1]), which are always accepted. Each may
   * have a :port. Requests with any other Host header are refused, which
   * blocks DNS-rebinding attacks.
   */
  allowedHosts: string[];
}

export class ConfigError extends Error {}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`SFCC_PORT must be a number, got "${raw}"`);
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new ConfigError(`SFCC_PORT must be 1-65535, got ${port}`);
  return port;
}

function parseCookieSecure(raw: string | undefined): ServerConfig['cookieSecure'] {
  if (raw === undefined || raw === '' || raw === 'auto') return 'auto';
  if (raw === 'always' || raw === 'never') return raw;
  throw new ConfigError(`SFCC_COOKIE_SECURE must be auto, always or never, got "${raw}"`);
}

/** A preset setup code must be long and random enough (at least 12 letters/digits). */
function parseSetupCode(raw: string): string {
  const normalised = raw.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z0-9]{12,64}$/.test(normalised)) {
    throw new ConfigError('SFCC_SETUP_CODE must be 12-64 letters or digits (dashes and spaces are ignored).');
  }
  return raw;
}

/**
 * SFCC_TRUST_PROXY: comma-separated IP addresses or CIDR ranges of the
 * reverse proxies in front of this server, e.g. "172.18.0.0/16" or
 * "127.0.0.1". Never "trust everything": a forged X-Forwarded-For would then
 * let anyone pick their own address and escape the rate limits.
 */
function parseTrustProxy(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const entries = raw.split(',').map((e) => e.trim());
  for (const entry of entries) {
    const [address, bits, extra] = entry.split('/');
    const family = isIP(address ?? '');
    const maxBits = family === 6 ? 128 : 32;
    const validBits = bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= maxBits);
    if (!family || !validBits || extra !== undefined) {
      throw new ConfigError(`SFCC_TRUST_PROXY must list proxy IP addresses or CIDR ranges (comma-separated), got "${entry}".`);
    }
  }
  return entries;
}

/**
 * SFCC_ALLOWED_HOSTS: comma-separated host names or IP addresses (IPv6 in
 * brackets), each with an optional :port, e.g. "chores.example.com" or
 * "192.168.1.20:3000". Never a wildcard: the point is to refuse unknown names.
 */
function parseAllowedHosts(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw.split(',').map((e) => {
    const entry = e.trim().toLowerCase();
    if (!parseHostHeader(entry)) {
      throw new ConfigError(`SFCC_ALLOWED_HOSTS must list host names or IP addresses with an optional :port (comma-separated), got "${e.trim()}".`);
    }
    return entry;
  });
}

const HOST_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Split a Host header (or an SFCC_ALLOWED_HOSTS entry) into a lower-case name
 * and an optional port; null if it isn't a plain host name, IPv4 address or
 * bracketed IPv6 address.
 */
export function parseHostHeader(value: string | undefined): { name: string; port: number | null } | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  const m = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(v);
  if (!m) return null;
  const [, name, portText] = m as unknown as [string, string, string | undefined];
  const port = portText === undefined ? null : Number(portText);
  if (port !== null && (port < 1 || port > 65535)) return null;
  if (name.startsWith('[')) return isIP(name.slice(1, -1)) === 6 ? { name, port } : null;
  if (isIP(name) === 4 || (HOST_NAME.test(name) && !/^[0-9.]+$/.test(name))) return { name, port };
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ServerConfig {
  const production = env.NODE_ENV === 'production';
  const timeZone = env.SFCC_TIMEZONE || env.TZ || 'UTC';
  if (!isValidTimeZone(timeZone)) {
    throw new ConfigError(`Unknown time zone "${timeZone}". Use an IANA name such as Europe/London.`);
  }
  const config: ServerConfig = {
    dataDir: path.resolve(cwd, env.SFCC_DATA_DIR || 'data'),
    host: env.SFCC_HOST || '127.0.0.1',
    port: parsePort(env.SFCC_PORT, 3000),
    timeZone,
    devUnauthenticatedApi: env.SFCC_DEV_UNAUTHENTICATED_API === '1',
    production,
    bodyLimit: 64 * 1024,
    cookieSecure: parseCookieSecure(env.SFCC_COOKIE_SECURE),
    ...(env.SFCC_SETUP_CODE ? { setupCode: parseSetupCode(env.SFCC_SETUP_CODE) } : {}),
    trustProxy: parseTrustProxy(env.SFCC_TRUST_PROXY),
    ...(env.SFCC_STATIC_DIR ? { staticDir: path.resolve(cwd, env.SFCC_STATIC_DIR) } : {}),
    allowedHosts: parseAllowedHosts(env.SFCC_ALLOWED_HOSTS),
  };
  assertSafeConfig(config);
  return config;
}

/**
 * Refuse configurations that could expose family data without
 * authentication. The development API is only allowed when NOT in
 * production and only when bound to a loopback address.
 */
export function assertSafeConfig(config: ServerConfig): void {
  if (!config.devUnauthenticatedApi) return;
  if (config.trustProxy.length) {
    throw new ConfigError('SFCC_TRUST_PROXY cannot be used with SFCC_DEV_UNAUTHENTICATED_API (development mode is for this computer only).');
  }
  if (config.production) {
    throw new ConfigError('SFCC_DEV_UNAUTHENTICATED_API cannot be used with NODE_ENV=production.');
  }
  if (!isLoopbackHost(config.host)) {
    throw new ConfigError(
      `SFCC_DEV_UNAUTHENTICATED_API requires a loopback SFCC_HOST (127.0.0.1, ::1 or localhost), got "${config.host}".`,
    );
  }
}
