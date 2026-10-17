import { createRequester, type Requester } from './client';

// Parent accounts and device pairing on the family server. Session tokens
// live only in HttpOnly cookies set by the server: this code never sees them.

export interface ParentInfo {
  id: string;
  username: string;
  displayName: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
}

export interface AuthStatus {
  /** Development mode: no sign-in at all (loopback only). */
  devMode: boolean;
  /** No parent account exists yet: first-run setup is needed. */
  setupRequired: boolean;
  /** The parent signed in on this browser, if any. */
  parent: ParentInfo | null;
  /** This browser's paired-device identity, if any. */
  device: DeviceInfo | null;
}

export interface ParentListItem extends ParentInfo {
  createdAt: string;
  isYou: boolean;
}

export interface DeviceListItem extends DeviceInfo {
  createdAt: string;
  lastSeenAt: string | null;
  isThisDevice: boolean;
}

export interface AuthClient {
  status(): Promise<AuthStatus>;
  setup(input: { setupCode: string; username: string; displayName: string; password: string }): Promise<{ parent: ParentInfo }>;
  login(username: string, password: string, remember: boolean): Promise<{ parent: ParentInfo }>;
  logout(): Promise<void>;
  pair(code: string): Promise<{ device: DeviceInfo }>;
  listParents(): Promise<ParentListItem[]>;
  addParent(input: { username: string; displayName: string; password: string }): Promise<{ parent: ParentInfo }>;
  removeParent(id: string, yourPassword: string): Promise<{ removedSelf: boolean }>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  listDevices(): Promise<DeviceListItem[]>;
  createPairingCode(name: string): Promise<{ code: string; expiresAt: string }>;
  revokeDevice(id: string): Promise<void>;
}

export function createAuthClient(request: Requester = createRequester()): AuthClient {
  return {
    status: () => request<AuthStatus>('GET', '/api/auth/status'),
    setup: (input) => request('POST', '/api/auth/setup', input),
    login: (username, password, remember) => request('POST', '/api/auth/login', { username, password, remember }),
    logout: async () => {
      await request('POST', '/api/auth/logout', {});
    },
    pair: (code) => request('POST', '/api/devices/pair', { code }),
    listParents: async () => (await request<{ parents: ParentListItem[] }>('GET', '/api/parents')).parents,
    addParent: (input) => request('POST', '/api/parents', input),
    removeParent: (id, password) => request('POST', `/api/parents/${encodeURIComponent(id)}/remove`, { password }),
    changePassword: async (currentPassword, newPassword) => {
      await request('POST', '/api/account/password', { currentPassword, newPassword });
    },
    listDevices: async () => (await request<{ devices: DeviceListItem[] }>('GET', '/api/devices')).devices,
    createPairingCode: (name) => request('POST', '/api/devices/pairing-codes', { name }),
    revokeDevice: async (id) => {
      await request('POST', `/api/devices/${encodeURIComponent(id)}/revoke`, {});
    },
  };
}

export const authClient = createAuthClient();

// Mirrors of the server's rules, for friendlier messages before sending.
// The server checks everything again; these are only hints.
export const PASSWORD_MIN = 10;
export function passwordProblem(password: string, username: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > 128) return 'Use at most 128 characters.';
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'The password must not contain the username.';
  return null;
}
export function usernameProblem(username: string): string | null {
  return /^[A-Za-z0-9._-]{3,32}$/.test(username) ? null : 'Use 3–32 letters, numbers, dots, dashes or underscores.';
}
