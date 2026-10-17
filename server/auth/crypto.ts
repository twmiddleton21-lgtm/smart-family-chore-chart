import { createHash, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Password hashing and secret generation. Uses Node's built-in scrypt (a
// memory-hard password hash) with a random per-password salt. Plaintext
// passwords are never stored. All comparisons are constant-time.

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))),
  );

/** Work factors: N=2^15, r=8, p=1 (~32 MiB, tens of ms per hash). */
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keylen: 64 } as const;
const MAXMEM = 128 * 1024 * 1024;

/** Format: scrypt$N$r$p$<salt base64>$<hash base64> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT_PARAMS;
  const key = await scrypt(password.normalize('NFKC'), salt, keylen, { N, r, p, maxmem: MAXMEM });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** True if the password matches. Malformed or unknown hashes never match. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  // Refuse absurd parameters (a tampered hash must not be able to exhaust memory).
  if (![N, r, p].every(Number.isInteger) || N < 16384 || N > 1048576 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  if (salt.length < 16 || expected.length < 32) return false;
  try {
    const key = await scrypt(password.normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: MAXMEM });
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** A hash to verify against when the username is unknown (equalises timing). */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString('base64'));
  return dummyHash;
}

/** 256-bit random session token (base64url). */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex digest, used to store tokens and codes without the secret. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// Unambiguous alphabet (no 0/O, 1/I/L) for codes people read and type.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Random code like "ABCD-EFGH" (groups of 4). */
export function newCode(groups: number): string {
  const out: string[] = [];
  for (let g = 0; g < groups; g++) {
    let group = '';
    for (let i = 0; i < 4; i++) group += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    out.push(group);
  }
  return out.join('-');
}

/** Normalise user-typed codes: case, spaces and dashes don't matter. */
export function normaliseCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
