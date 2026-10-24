import { createHash, randomBytes } from 'node:crypto';
import { CALENDAR_READONLY_SCOPE } from './calendar';

// Google OAuth 2.0 for web server applications (authorization-code flow
// with PKCE and a client secret). The server alone talks to Google's token
// endpoint; the browser only ever visits Google's consent page and comes
// back to our callback with a one-time code.
//   https://developers.google.com/identity/protocols/oauth2/web-server

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const TIMEOUT_MS = 10_000;

export interface GoogleOAuthSettings {
  clientId: string;
  clientSecret: string;
  /** Exactly as registered in Google Cloud ("Authorised redirect URIs"). */
  redirectUri: string;
}

export type OAuthFailure =
  | 'invalid_grant' // code or refresh token expired, used or revoked
  | 'invalid_client' // client ID or secret wrong (server setup)
  | 'scope_missing' // the parent didn't allow calendar access on the consent screen
  | 'no_refresh_token'
  | 'unavailable'; // network failure or unexpected answer

export class OAuthError extends Error {
  constructor(public readonly failure: OAuthFailure, message: string) {
    super(message);
  }
}

export interface TokenSet {
  accessToken: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  refreshToken?: string;
  scope: string;
}

/** PKCE (RFC 7636): a random verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizationUrl(settings: GoogleOAuthSettings, state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: settings.clientId,
    redirect_uri: settings.redirectUri,
    response_type: 'code',
    scope: CALENDAR_READONLY_SCOPE, // read-only; never create, edit or delete events
    access_type: 'offline', // a refresh token, so the family stays connected
    prompt: 'consent', // always issue a new refresh token on (re)connect
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

export class GoogleOAuthClient {
  constructor(
    private readonly settings: GoogleOAuthSettings,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async tokenRequest(form: Record<string, string>): Promise<TokenSet> {
    let response: Response;
    try {
      response = await this.fetchImpl(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: this.settings.clientId, client_secret: this.settings.clientSecret, ...form }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new OAuthError('unavailable', 'Google could not be reached.');
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      // Only Google's error code is kept; never the request or response body.
      const code = typeof body?.error === 'string' ? body.error : '';
      if (code === 'invalid_grant') throw new OAuthError('invalid_grant', 'Google no longer accepts this authorisation.');
      if (code === 'invalid_client' || code === 'unauthorized_client') throw new OAuthError('invalid_client', 'Google refused the server’s OAuth client.');
      throw new OAuthError('unavailable', `Google’s token endpoint answered ${response.status}.`);
    }
    if (!body || typeof body.access_token !== 'string') throw new OAuthError('unavailable', 'Unexpected answer from Google.');
    const scope = typeof body.scope === 'string' ? body.scope : '';
    if (!scope.split(' ').includes(CALENDAR_READONLY_SCOPE)) {
      throw new OAuthError('scope_missing', 'Calendar access was not granted.');
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    return {
      accessToken: body.access_token,
      expiresAt: this.now() + expiresIn * 1000,
      scope,
      ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
    };
  }

  /** Exchange the one-time code from the callback. */
  async exchangeCode(code: string, codeVerifier: string): Promise<TokenSet & { refreshToken: string }> {
    const tokens = await this.tokenRequest({ grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: this.settings.redirectUri });
    if (!tokens.refreshToken) throw new OAuthError('no_refresh_token', 'Google did not return a refresh token.');
    return tokens as TokenSet & { refreshToken: string };
  }

  refresh(refreshToken: string): Promise<TokenSet> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /** Best effort: tell Google to drop the grant. Returns whether Google confirmed it. */
  async revoke(token: string): Promise<boolean> {
    try {
      const response = await this.fetchImpl(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // 400 invalid_token: already revoked or expired, which is what we wanted.
      return response.ok || response.status === 400;
    } catch {
      return false;
    }
  }
}
