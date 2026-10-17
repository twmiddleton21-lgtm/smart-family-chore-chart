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
  | 'server'; // 500 or an unexpected response

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
  disabled: 'This server’s family data is switched off until sign-in is available.',
  conflict: 'This was changed on another device.',
  rejected: 'That change wasn’t accepted.',
  invalid: 'The app sent a request the server didn’t understand. Please reload the page.',
  not_found: 'That item no longer exists. It may have been removed on another device.',
  forbidden: 'The server refused this request.',
  server: 'The server had a problem. Please try again.',
};

function kindFor(status: number, error: unknown): ApiErrorKind {
  if (status === 503 && error === 'api_unavailable') return 'disabled';
  if (status === 409) return 'conflict';
  if (status === 422) return 'rejected';
  if (status === 400 || status === 413 || status === 415) return 'invalid';
  if (status === 404) return 'not_found';
  if (status === 403) return 'forbidden';
  // Gateway errors (e.g. the dev proxy when the server is down) mean "unreachable".
  if (status === 502 || status === 503 || status === 504) return 'unreachable';
  return 'server';
}

export function createApiClient(fetchImpl: typeof fetch = (...args) => fetch(...args), base = ''): ApiClient {
  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(base + path, {
        method,
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      throw new ApiError('unreachable', FRIENDLY.unreachable);
    }
    let json: unknown = null;
    const text = await response.text().catch(() => '');
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
    // Prefer the server's own message for business-rule answers; use our
    // wording for transport-level problems.
    const message = (kind === 'rejected' || kind === 'conflict' || kind === 'not_found') && serverMessage ? serverMessage : FRIENDLY[kind];
    throw new ApiError(kind, message, response.status, obj);
  }

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
