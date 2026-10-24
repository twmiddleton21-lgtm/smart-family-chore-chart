import { describe, expect, it } from 'vitest';
import { parseSecretKey, SecretBox } from './secretBox';

const box = new SecretBox(Buffer.alloc(32, 1));

describe('SecretBox (AES-256-GCM at rest)', () => {
  it('round-trips, with a fresh nonce each time (same input, different ciphertext)', () => {
    const a = box.encrypt('refresh-token-value', 'p');
    const b = box.encrypt('refresh-token-value', 'p');
    expect(a).not.toBe(b);
    expect(a).not.toContain('refresh-token-value');
    expect(box.decrypt(a, 'p')).toBe('refresh-token-value');
  });

  it('refuses another key, another purpose and any tampering', () => {
    const sealed = box.encrypt('secret', 'p');
    expect(() => new SecretBox(Buffer.alloc(32, 2)).decrypt(sealed, 'p')).toThrow(/could not be decrypted/);
    expect(() => box.decrypt(sealed, 'other')).toThrow(/could not be decrypted/);
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => box.decrypt(parts.join('.'), 'p')).toThrow();
    expect(() => box.decrypt('garbage', 'p')).toThrow(/Unrecognised/);
  });

  it('has a stable key id that differs between keys and reveals nothing usable', () => {
    expect(box.keyId).toBe(new SecretBox(Buffer.alloc(32, 1)).keyId);
    expect(box.keyId).not.toBe(new SecretBox(Buffer.alloc(32, 2)).keyId);
    expect(box.keyId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('accepts only 32-byte keys (base64 or hex)', () => {
    expect(parseSecretKey(Buffer.alloc(32, 5).toString('base64'))).toEqual(Buffer.alloc(32, 5));
    expect(parseSecretKey('ab'.repeat(32))).toHaveLength(32);
    expect(parseSecretKey(Buffer.alloc(16).toString('base64'))).toBeNull();
    expect(parseSecretKey('password123')).toBeNull();
    expect(() => new SecretBox(Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});
