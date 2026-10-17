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
  if (config.production) {
    throw new ConfigError('SFCC_DEV_UNAUTHENTICATED_API cannot be used with NODE_ENV=production.');
  }
  if (!isLoopbackHost(config.host)) {
    throw new ConfigError(
      `SFCC_DEV_UNAUTHENTICATED_API requires a loopback SFCC_HOST (127.0.0.1, ::1 or localhost), got "${config.host}".`,
    );
  }
}
