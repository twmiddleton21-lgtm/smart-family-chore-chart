import { randomBytes } from 'node:crypto';
import { createId } from '../../src/lib/ids';
import type { SqlDatabase } from '../db/database';
import { dummyPasswordHash, hashPassword, newCode, newSessionToken, normaliseCode, safeEqual, sha256, verifyPassword } from './crypto';
import { AttemptLimiter, LIMITS } from './rateLimit';
import { validateDeviceName, validateDisplayName, validatePassword, validateUsername } from './policy';

// Parent accounts, sessions, paired devices and pairing codes.
//
// Secrets never leave this module except once, at creation: session tokens
// (returned only to be set as HttpOnly cookies), pairing codes (shown once to
// the parent who created them) and the first-run setup code. Only SHA-256
// hashes of tokens/codes and scrypt hashes of passwords are stored.

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export const SESSION_POLICY = {
  /** Default parent session: safe on a shared kiosk. */
  parent: { idleMs: 30 * MINUTE, absoluteMs: 12 * 60 * MINUTE },
  /** "Keep me signed in on this device": a parent's own phone. */
  parentRemember: { idleMs: 30 * DAY, absoluteMs: 30 * DAY },
  /** Paired household device (kiosk): long-lived until revoked. */
  device: { idleMs: 90 * DAY, absoluteMs: 365 * DAY },
} as const;

export const PAIRING_CODE_TTL_MS = 10 * MINUTE;
/** Refresh last-used/idle expiry at most this often (limits writes). */
const SLIDE_INTERVAL_MS = MINUTE;

export interface ParentInfo {
  id: string;
  username: string;
  displayName: string;
}
export interface DeviceInfo {
  id: string;
  name: string;
}
/**
 * A public id for a session, derived one-way from its token hash. The app
 * learns it from /api/auth/status and names it when signing out, so a
 * delayed sign-out can only end the session it was meant for. It is not a
 * credential: requests are only ever authenticated by the token cookie.
 */
export function publicSessionId(tokenHash: string): string {
  return sha256(`sfcc-session-id:${tokenHash}`);
}

export interface AuthContext {
  parent: ParentInfo | null;
  device: DeviceInfo | null;
  /** Hash of the current parent session token (to keep it on password change). */
  parentSessionHash: string | null;
}

export type AuthError = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 422 | 429;
  error: string;
  message: string;
  retryAfter?: number;
};
type Ok<T> = { ok: true } & T;

const err = (status: AuthError['status'], error: string, message: string, retryAfter?: number): AuthError => ({
  ok: false,
  status,
  error,
  message,
  ...(retryAfter ? { retryAfter } : {}),
});

const INVALID_LOGIN = 'That username and password don’t match.';

interface ParentRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
}

export interface AuthOptions {
  now?: () => Date;
  /** Fixed setup code from configuration (SFCC_SETUP_CODE); otherwise random. */
  setupCode?: string;
}

export class AuthService {
  private readonly now: () => Date;
  readonly limiter: AttemptLimiter;
  private setupCodeHash: string | null = null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly options: AuthOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.limiter = new AttemptLimiter(() => this.now().getTime());
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  // ---------- first-run setup ----------

  hasParents(): boolean {
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM parents')!.n) > 0;
  }

  isSetupRequired(): boolean {
    return !this.hasParents();
  }

  /**
   * Prepare the one-time setup code if no parent exists yet. Returns the code
   * only when it was generated here (so the caller can show it once in the
   * server output); returns null if setup is not needed or the code came
   * from configuration.
   */
  prepareSetup(): string | null {
    if (this.hasParents()) {
      this.setupCodeHash = null;
      return null;
    }
    if (this.options.setupCode) {
      this.setupCodeHash = sha256(normaliseCode(this.options.setupCode));
      return null;
    }
    const code = newCode(3);
    this.setupCodeHash = sha256(normaliseCode(code));
    return code;
  }

  async completeSetup(input: { setupCode: string; username: string; displayName: string; password: string }, ip: string): Promise<Ok<{ parent: ParentInfo; token: string }> | AuthError> {
    const key = `setup:ip:${ip}`;
    const wait = this.limiter.retryAfter(key, LIMITS.code);
    if (wait) return err(429, 'too_many_attempts', 'Too many attempts. Please wait and try again.', wait);
    if (!this.setupCodeHash || this.hasParents()) return err(409, 'setup_complete', 'This family server is already set up. Please sign in.');
    if (!safeEqual(sha256(normaliseCode(input.setupCode)), this.setupCodeHash)) {
      this.limiter.fail(key);
      return err(403, 'invalid_setup_code', 'That setup code isn’t right. Check the server’s startup output.');
    }
    const problem = validateUsername(input.username) ?? validateDisplayName(input.displayName) ?? validatePassword(input.password, input.username);
    if (problem) return err(422, 'invalid_account', problem);
    const hash = await hashPassword(input.password);
    const created = this.db.transaction(() => {
      // Re-check inside the write lock so two setup requests can't both win.
      if (this.hasParents()) return null;
      return this.insertParent(input.username, input.displayName, hash);
    });
    if (!created) return err(409, 'setup_complete', 'This family server is already set up. Please sign in.');
    this.setupCodeHash = null;
    return { ok: true, parent: created, token: this.createSession('parent', created.id, false) };
  }

  private insertParent(username: string, displayName: string, hash: string): ParentInfo {
    const id = createId('parent');
    const at = this.iso();
    this.db.run(
      'INSERT INTO parents (id, username, display_name, password_hash, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      username,
      displayName.trim(),
      hash,
      at,
      at,
    );
    return { id, username, displayName: displayName.trim() };
  }

  // ---------- sign in / out ----------

  async login(username: unknown, password: unknown, remember: boolean, ip: string): Promise<Ok<{ parent: ParentInfo; token: string }> | AuthError> {
    const user = typeof username === 'string' ? username.trim().toLowerCase() : '';
    // Counted before the (slow, async) hash so simultaneous guesses can't all
    // get through; released only if this attempt succeeds (see rateLimit.ts).
    const attempt = this.limiter.begin([`login:ip:${ip}`, `login:user:${user}`], LIMITS.login);
    if (!attempt.allowed) return err(429, 'too_many_attempts', 'Too many sign-in attempts. Please wait and try again.', attempt.retryAfter);
    const row = user ? this.db.get<ParentRow & Record<string, unknown>>('SELECT id, username, display_name, password_hash FROM parents WHERE username = ?', user) : undefined;
    const pw = typeof password === 'string' ? password : '';
    // Always run the hash, even for unknown users, so timing doesn't reveal accounts.
    const valid = await verifyPassword(pw, row ? row.password_hash : await dummyPasswordHash());
    if (!row || !valid || pw === '') return err(401, 'invalid_credentials', INVALID_LOGIN);
    attempt.release();
    this.purgeExpired();
    const parent = { id: row.id, username: row.username, displayName: row.display_name };
    return { ok: true, parent, token: this.createSession('parent', row.id, remember) };
  }

  /** Delete the session for this token (if any). Safe to call repeatedly. */
  logout(token: string | undefined): void {
    if (token) this.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  }

  // ---------- sessions ----------

  private createSession(kind: 'parent' | 'device', ownerId: string, remember: boolean): string {
    const policy = kind === 'device' ? SESSION_POLICY.device : remember ? SESSION_POLICY.parentRemember : SESSION_POLICY.parent;
    const token = newSessionToken();
    const at = this.iso();
    this.db.run(
      `INSERT INTO sessions (token_hash, kind, parent_id, device_id, remember, created_at, last_used_at, idle_expires_at, absolute_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sha256(token),
      kind,
      kind === 'parent' ? ownerId : null,
      kind === 'device' ? ownerId : null,
      remember ? 1 : 0,
      at,
      at,
      this.iso(policy.idleMs),
      this.iso(policy.absoluteMs),
    );
    return token;
  }

  /** Max-Age (seconds) for the cookie, or undefined for a browser-session cookie. */
  static cookieMaxAge(kind: 'parent' | 'device', remember: boolean): number | undefined {
    if (kind === 'device') return Math.floor(SESSION_POLICY.device.absoluteMs / 1000);
    return remember ? Math.floor(SESSION_POLICY.parentRemember.absoluteMs / 1000) : undefined;
  }

  /** Validate cookies; expired or unknown sessions are ignored (and expired ones deleted). */
  authenticate(parentToken: string | undefined, deviceToken: string | undefined): AuthContext {
    const ctx: AuthContext = { parent: null, device: null, parentSessionHash: null };
    if (parentToken) {
      const hash = sha256(parentToken);
      const row = this.db.get<{ id: string; username: string; display_name: string; remember: number; last_used_at: string; idle_expires_at: string; absolute_expires_at: string }>(
        `SELECT p.id, p.username, p.display_name, s.remember, s.last_used_at, s.idle_expires_at, s.absolute_expires_at
         FROM sessions s JOIN parents p ON p.id = s.parent_id WHERE s.token_hash = ? AND s.kind = 'parent'`,
        hash,
      );
      if (row && this.stillValid(hash, row, row.remember ? SESSION_POLICY.parentRemember : SESSION_POLICY.parent)) {
        ctx.parent = { id: row.id, username: row.username, displayName: row.display_name };
        ctx.parentSessionHash = hash;
      }
    }
    if (deviceToken) {
      const hash = sha256(deviceToken);
      const row = this.db.get<{ id: string; name: string; last_used_at: string; idle_expires_at: string; absolute_expires_at: string }>(
        `SELECT d.id, d.name, s.last_used_at, s.idle_expires_at, s.absolute_expires_at
         FROM sessions s JOIN devices d ON d.id = s.device_id WHERE s.token_hash = ? AND s.kind = 'device'`,
        hash,
      );
      if (row && this.stillValid(hash, row, SESSION_POLICY.device)) {
        ctx.device = { id: row.id, name: row.name };
        if (this.now().getTime() - Date.parse(row.last_used_at) >= SLIDE_INTERVAL_MS) {
          this.db.run('UPDATE devices SET last_seen_at = ? WHERE id = ?', this.iso(), row.id);
        }
      }
    }
    return ctx;
  }

  private stillValid(hash: string, row: { last_used_at: string; idle_expires_at: string; absolute_expires_at: string }, policy: { idleMs: number }): boolean {
    const now = this.iso();
    if (now >= row.idle_expires_at || now >= row.absolute_expires_at) {
      this.db.run('DELETE FROM sessions WHERE token_hash = ?', hash);
      return false;
    }
    if (this.now().getTime() - Date.parse(row.last_used_at) >= SLIDE_INTERVAL_MS) {
      const idle = this.iso(policy.idleMs);
      this.db.run(
        'UPDATE sessions SET last_used_at = ?, idle_expires_at = ? WHERE token_hash = ?',
        now,
        idle < row.absolute_expires_at ? idle : row.absolute_expires_at,
        hash,
      );
    }
    return true;
  }

  purgeExpired(): void {
    const now = this.iso();
    this.db.run('DELETE FROM sessions WHERE idle_expires_at <= ? OR absolute_expires_at <= ?', now, now);
    this.db.run('DELETE FROM pairing_codes WHERE expires_at <= ? OR used_at IS NOT NULL', this.iso(-DAY));
  }

  // ---------- parent accounts (equal parents) ----------

  listParents(): { id: string; username: string; displayName: string; createdAt: string }[] {
    return this.db
      .all<{ id: string; username: string; display_name: string; created_at: string }>('SELECT id, username, display_name, created_at FROM parents ORDER BY created_at, username')
      .map((r) => ({ id: r.id, username: r.username, displayName: r.display_name, createdAt: r.created_at }));
  }

  async createParent(input: { username: unknown; displayName: unknown; password: unknown }): Promise<Ok<{ parent: ParentInfo }> | AuthError> {
    const problem =
      validateUsername(input.username) ??
      validateDisplayName(input.displayName) ??
      validatePassword(input.password, typeof input.username === 'string' ? input.username : undefined);
    if (problem) return err(422, 'invalid_account', problem);
    const username = input.username as string;
    if (this.db.get('SELECT id FROM parents WHERE username = ?', username)) return err(409, 'username_taken', 'That username is already used.');
    const hash = await hashPassword(input.password as string);
    try {
      const parent = this.db.transaction(() => this.insertParent(username, input.displayName as string, hash));
      return { ok: true, parent };
    } catch {
      return err(409, 'username_taken', 'That username is already used.');
    }
  }

  /**
   * Re-check a signed-in parent's own password before a sensitive change.
   * Rate-limited per parent, so a stolen session can't be used to guess the
   * password.
   */
  private async reauthenticate(parentId: string, password: unknown, hash: string, wrongMessage: string): Promise<AuthError | null> {
    // Counted before the async hash, released only on success (see login).
    const attempt = this.limiter.begin([`reauth:parent:${parentId}`], LIMITS.login);
    if (!attempt.allowed) return err(429, 'too_many_attempts', 'Too many wrong passwords. Please wait and try again.', attempt.retryAfter);
    if (!(await verifyPassword(typeof password === 'string' ? password : '', hash))) return err(403, 'wrong_password', wrongMessage);
    attempt.release();
    return null;
  }

  /** Remove a parent (any parent may, re-entering their own password). Never the last one. */
  async removeParent(actorId: string, targetId: string, actorPassword: unknown): Promise<Ok<{ removedSelf: boolean }> | AuthError> {
    const actor = this.db.get<{ password_hash: string }>('SELECT password_hash FROM parents WHERE id = ?', actorId);
    if (!actor) return err(401, 'unauthenticated', 'Please sign in again.');
    const denied = await this.reauthenticate(actorId, actorPassword, actor.password_hash, 'Your password isn’t right.');
    if (denied) return denied;
    return this.db.transaction((): Ok<{ removedSelf: boolean }> | AuthError => {
      if (!this.db.get('SELECT id FROM parents WHERE id = ?', targetId)) return err(404, 'not_found', 'That parent account no longer exists.');
      const count = Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM parents')!.n);
      if (count <= 1) return err(409, 'last_parent', 'The last parent account can’t be removed.');
      // Sessions and pairing codes go with the account (ON DELETE CASCADE).
      this.db.run('DELETE FROM parents WHERE id = ?', targetId);
      return { ok: true, removedSelf: targetId === actorId };
    });
  }

  /** Change your own password; all your other sessions are signed out. */
  async changeOwnPassword(parentId: string, currentPassword: unknown, newPassword: unknown, keepSessionHash: string | null): Promise<Ok<object> | AuthError> {
    const row = this.db.get<{ username: string; password_hash: string }>('SELECT username, password_hash FROM parents WHERE id = ?', parentId);
    if (!row) return err(401, 'unauthenticated', 'Please sign in again.');
    const denied = await this.reauthenticate(parentId, currentPassword, row.password_hash, 'Your current password isn’t right.');
    if (denied) return denied;
    const problem = validatePassword(newPassword, row.username);
    if (problem) return err(422, 'invalid_password', problem);
    const hash = await hashPassword(newPassword as string);
    this.db.transaction(() => {
      this.db.run('UPDATE parents SET password_hash = ?, password_changed_at = ? WHERE id = ?', hash, this.iso(), parentId);
      this.db.run("DELETE FROM sessions WHERE kind = 'parent' AND parent_id = ? AND token_hash IS NOT ?", parentId, keepSessionHash);
    });
    return { ok: true };
  }

  // ---------- devices and pairing ----------

  createPairingCode(parentId: string, deviceName: unknown): Ok<{ code: string; expiresAt: string }> | AuthError {
    const problem = validateDeviceName(deviceName);
    if (problem) return err(422, 'invalid_device', problem);
    this.purgeExpired();
    const code = newCode(2);
    const expiresAt = this.iso(PAIRING_CODE_TTL_MS);
    this.db.run(
      'INSERT INTO pairing_codes (code_hash, device_name, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      sha256(normaliseCode(code)),
      (deviceName as string).trim(),
      parentId,
      this.iso(),
      expiresAt,
    );
    return { ok: true, code, expiresAt };
  }

  pairDevice(code: unknown, ip: string): Ok<{ device: DeviceInfo; token: string }> | AuthError {
    const key = `pair:ip:${ip}`;
    const wait = this.limiter.retryAfter(key, LIMITS.code);
    if (wait) return err(429, 'too_many_attempts', 'Too many attempts. Please wait and try again.', wait);
    const hash = typeof code === 'string' ? sha256(normaliseCode(code)) : '';
    const result = this.db.transaction((): Ok<{ device: DeviceInfo; token: string }> | null => {
      const row = hash
        ? this.db.get<{ device_name: string; created_by: string }>(
            'SELECT device_name, created_by FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?',
            hash,
            this.iso(),
          )
        : undefined;
      if (!row) return null;
      this.db.run('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?', this.iso(), hash);
      const id = createId('device');
      this.db.run('INSERT INTO devices (id, name, created_by, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', id, row.device_name, row.created_by, this.iso(), this.iso());
      return { ok: true, device: { id, name: row.device_name }, token: this.createSession('device', id, false) };
    });
    if (!result) {
      this.limiter.fail(key);
      return err(401, 'invalid_code', 'That pairing code isn’t valid. Codes work once and expire after 10 minutes.');
    }
    // A success doesn't erase earlier wrong codes from this address (see rateLimit.ts).
    return result;
  }

  listDevices(): { id: string; name: string; createdAt: string; lastSeenAt: string | null }[] {
    return this.db
      .all<{ id: string; name: string; created_at: string; last_seen_at: string | null }>('SELECT id, name, created_at, last_seen_at FROM devices ORDER BY created_at')
      .map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastSeenAt: r.last_seen_at }));
  }

  /** Unpair a device: its sessions stop working immediately. */
  revokeDevice(id: string): Ok<object> | AuthError {
    const removed = this.db.run('DELETE FROM devices WHERE id = ?', id);
    return removed.changes ? { ok: true } : err(404, 'not_found', 'That device is no longer paired.');
  }

  /** Forget this browser's device session (e.g. when re-pairing). */
  forgetDeviceSession(token: string | undefined): void {
    if (token) this.db.run("DELETE FROM sessions WHERE kind = 'device' AND token_hash = ?", sha256(token));
  }

  // ---------- recovery (server command line only) ----------

  /** Set a random temporary password and sign the parent out everywhere. */
  async resetPassword(username: string): Promise<Ok<{ temporaryPassword: string }> | AuthError> {
    const row = this.db.get<{ id: string }>('SELECT id FROM parents WHERE username = ?', username);
    if (!row) return err(404, 'not_found', `No parent account named "${username}".`);
    const temporaryPassword = `${newCode(2)}-${randomBytes(4).toString('hex')}`;
    const hash = await hashPassword(temporaryPassword);
    this.db.transaction(() => {
      this.db.run('UPDATE parents SET password_hash = ?, password_changed_at = ? WHERE id = ?', hash, this.iso(), row.id);
      this.db.run("DELETE FROM sessions WHERE kind = 'parent' AND parent_id = ?", row.id);
    });
    return { ok: true, temporaryPassword };
  }
}
