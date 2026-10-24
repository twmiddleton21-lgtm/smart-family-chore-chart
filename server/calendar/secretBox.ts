import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Encryption at rest for secrets the server must keep (the family's Google
// refresh token). AES-256-GCM with a random 96-bit nonce per value. The key
// comes from the deployment (SFCC_SECRET_KEY_FILE / SFCC_SECRET_KEY), never
// from the database, so a copied database or backup alone reveals nothing.
// Each value is bound to its purpose (additional authenticated data), so a
// ciphertext can't be moved to another column and still decrypt.

const VERSION = 'v1';

export class SecretBoxError extends Error {}

export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new SecretBoxError('The secret key must be exactly 32 bytes.');
    this.key = key;
  }

  /** Short, non-secret fingerprint of the key, to notice a changed key. */
  get keyId(): string {
    return createHash('sha256').update('sfcc-key-id').update(this.key).digest('hex').slice(0, 16);
  }

  encrypt(plaintext: string, purpose: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(purpose, 'utf8'));
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }

  /** Throws SecretBoxError if the value was tampered with, or encrypted with another key or purpose. */
  decrypt(sealed: string, purpose: string): string {
    const [version, iv, tag, data, extra] = sealed.split('.');
    if (version !== VERSION || !iv || !tag || data === undefined || extra !== undefined) throw new SecretBoxError('Unrecognised encrypted value.');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(purpose, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      throw new SecretBoxError('The value could not be decrypted (wrong key, or it was changed).');
    }
  }
}

/**
 * Parse a 32-byte key written as base64 (e.g. `openssl rand -base64 32`) or
 * 64 hex digits. Returns null if it isn't one.
 */
export function parseSecretKey(text: string): Buffer | null {
  const t = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(t)) {
    const key = Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return key.length === 32 ? key : null;
  }
  return null;
}
