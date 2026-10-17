import type { DateKey, FamilyData } from '../types';
import type { ExportFile, ExportedFamily } from '../lib/exportFile';

// Small typed client for the family server API. Every failure becomes an
// ApiError with a kind the UI can explain to the user.

export type ApiErrorKind =
  | 'unreachable' // network failure or proxy/gateway error: server not reachable
  | 'disabled' // server reachable, but its family-data API is turned off
  | 'conflict' // 409: changed elsewhere / not allowed in the current state
  | 'rejected' // 422: business rules or validation said no
  | 'invalid' // 400: malformed request (a bug, or a stale file)
  | 'not_found' // 404
  | 'forbidden' // 403
  | 'unauthenticated' // 401: not signed in / not paired (or the session ended)
  | 'parent_required' // 403: a paired device tried something only a parent may do
  | 'rate_limited' // 429: too many attempts
  | 'server'; // 500 or an unexpected response

/** Fired on window when the server says the sign-in state changed (401 / parent required). */
export const AUTH_CHANGED_EVENT = 'sfcc:auth-changed';

export class ApiError extends Error {
  constructor(
    public readonly kind: ApiErrorKind,
    message: string,
    public readonly status: number | null = null,
    public readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

export interface ServerState {
  stateVersion: number;
  recordVersions: Record<string, number>;
  family: ExportedFamily;
  today: DateKey;
  timeZone: string;
}

export interface CommandBody {
  type: string;
  payload: Record<string, unknown>;
  expectedVersion?: number;
}

export interface CommandResponse {
  stateVersion: number;
  changed: string[];
  noChange: boolean;
}

export interface ImportSummary {
  sourceFormatVersion: number;
  upgraded: boolean;
  pinIgnored: boolean;
  familyName: string;
  counts: Record<'children' | 'chores' | 'rewards' | 'completions' | 'redemptions' | 'meals' | 'mainMeals' | 'puddings', number>;
  children: { name: string; points: number }[];
}

export interface ImportPreview {
  summary: ImportSummary;
  checksum: string;
  server: { stateVersion: number; empty: boolean };
}

export interface ApiClient {
  getState(): Promise<ServerState>;
  sendCommand(command: CommandBody): Promise<CommandResponse>;
  exportData(): Promise<ExportFile & { stateVersion: number }>;
  previewImport(data: unknown): Promise<ImportPreview>;
  applyImport(body: { data: unknown; checksum: string; expectedStateVersion: number; replace: boolean }): Promise<{ stateVersion: number; backup: string }>;
}

const FRIENDLY: Record<ApiErrorKind, string> = {
  unreachable: 'Can’t reach the family server. Check that it is running, then try again.',
  disabled: 'This server’s family data is switched off.',
  conflict: 'This was changed on another device.',
  rejected: 'That change wasn’t accepted.',
  invalid: 'The app sent a request the server didn’t understand. Please reload the page.',
  not_found: 'That item no longer exists. It may have been removed on another device.',
  forbidden: 'The server refused this request.',
  unauthenticated: 'Please sign in again.',
  parent_required: 'A parent needs to sign in for this.',
  rate_limited: 'Too many attempts. Please wait a few minutes and try again.',
  server: 'The server had a problem. Please try again.',
};

function kindFor(status: number, error: unknown): ApiErrorKind {
  if (status === 503 && error === 'api_unavailable') return 'disabled';
  if (status === 409) return 'conflict';
  if (status === 422) return 'rejected';
  if (status === 400 || status === 413 || status === 415) return 'invalid';
  if (status === 404) return 'not_found';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return error === 'parent_required' ? 'parent_required' : 'forbidden';
  if (status === 429) return 'rate_limited';
  // Gateway errors (e.g. the dev proxy when the server is down) mean "unreachable".
  if (status === 502 || status === 503 || status === 504) return 'unreachable';
  return 'server';
}

export interface RequestOptions {
  /** Give up (as "unreachable") if the server hasn't answered in this time. */
  timeoutMs?: number;
}

export type Requester = <T>(method: 'GET' | 'POST', path: string, body?: unknown, options?: RequestOptions) => Promise<T>;

const TIMED_OUT = 'The family server didn’t answer in time.';

/** Kinds where the server's own message is the most helpful one to show. */
const SERVER_WORDED: ReadonlySet<ApiErrorKind> = new Set(['rejected', 'conflict', 'not_found', 'rate_limited', 'forbidden', 'unauthenticated']);

export function createRequester(fetchImpl: typeof fetch = (...args) => fetch(...args), base = ''): Requester {
  return async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const controller = options.timeoutMs ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
    let response: Response;
    let text: string;
    try {
      try {
        response = await fetchImpl(base + path, {
          method,
          headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: 'same-origin',
          cache: 'no-store',
          ...(controller ? { signal: controller.signal } : {}),
        });
      } catch {
        throw new ApiError('unreachable', controller?.signal.aborted ? TIMED_OUT : FRIENDLY.unreachable);
      }
      text = await response.text().catch(() => '');
      // A body cut off by the timeout is not an answer we can trust.
      if (controller?.signal.aborted) throw new ApiError('unreachable', TIMED_OUT);
    } finally {
      if (timer) clearTimeout(timer);
    }
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    const obj = json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
    if (response.ok) {
      if (!obj) throw new ApiError('server', FRIENDLY.server, response.status);
      return obj as T;
    }
    const kind = kindFor(response.status, obj?.error);
    const serverMessage = typeof obj?.message === 'string' ? obj.message : null;
    // Prefer the server's own message for business-rule and sign-in answers;
    // use our wording for transport-level problems.
    const message = SERVER_WORDED.has(kind) && serverMessage ? serverMessage : FRIENDLY[kind];
    // The session ended or more rights are needed: let the app re-check who is signed in.
    if ((obj?.error === 'unauthenticated' || obj?.error === 'parent_required') && typeof window !== 'undefined') {
      window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
    }
    throw new ApiError(kind, message, response.status, obj);
  };
}

export function createApiClient(fetchImpl: typeof fetch = (...args) => fetch(...args), base = ''): ApiClient {
  const request = createRequester(fetchImpl, base);
  return {
    getState: () => request<ServerState>('GET', '/api/state'),
    sendCommand: (command) => request<CommandResponse>('POST', '/api/commands', command),
    exportData: () => request('GET', '/api/export'),
    previewImport: (data) => request<ImportPreview>('POST', '/api/import/preview', { data }),
    applyImport: (body) => request('POST', '/api/import/apply', body),
  };
}

/** Server documents have no PIN; the browser FamilyData type still carries one. */
export function toFamilyData(family: ExportedFamily): FamilyData {
  return { ...family, settings: { ...family.settings, parentPin: '' } };
}
