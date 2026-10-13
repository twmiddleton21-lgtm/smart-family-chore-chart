// crypto.randomUUID() is only available in secure contexts (HTTPS or
// localhost). When the app is opened over the LAN (e.g. http://192.168.x.x),
// it is undefined, so fall back to a timestamp + random suffix.
export function createId(prefix: string): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `${prefix}_${c.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
