// Validation rules for account input (server-side; the browser only mirrors
// them for friendlier messages).

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

// A short list of very common passwords that pass the length rule.
const COMMON = new Set([
  'password123',
  'password1234',
  '1234567890',
  '12345678910',
  'qwertyuiop',
  'iloveyou123',
  'letmein1234',
  'welcome123',
  'abc1234567',
  '0987654321',
  'passwordpassword',
  'qwerty123456',
  'administrator',
  'changeme123',
  'familychores',
  'chorechart1',
]);

export function validatePassword(password: unknown, username?: string): string | null {
  if (typeof password !== 'string') return 'Please enter a password.';
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (/^(.)\1+$/.test(password)) return 'Please choose a less predictable password.';
  if (COMMON.has(password.toLowerCase())) return 'That password is too common. Please choose another.';
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'The password must not contain the username.';
  return null;
}

/** Usernames: 3-32 characters, letters, digits, dot, dash or underscore. Case-insensitive. */
export function validateUsername(username: unknown): string | null {
  if (typeof username !== 'string') return 'Please enter a username.';
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) return 'Use 3-32 letters, numbers, dots, dashes or underscores.';
  return null;
}

export function validateDisplayName(name: unknown): string | null {
  if (typeof name !== 'string' || name.trim() === '') return 'Please enter a name.';
  if (name.trim().length > 40) return 'Keep the name to 40 characters or fewer.';
  return null;
}

export function validateDeviceName(name: unknown): string | null {
  if (typeof name !== 'string' || name.trim() === '') return 'Please name the device (e.g. “Kitchen screen”).';
  if (name.trim().length > 40) return 'Keep the device name to 40 characters or fewer.';
  return null;
}
