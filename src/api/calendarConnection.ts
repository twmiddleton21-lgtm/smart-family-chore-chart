import type { CalendarChoice, CalendarConnectionStatus, CalendarMethod, FeedCheck } from '../lib/calendar';
import { createRequester, type Requester } from './client';

// Settings → Integrations → Family calendar (parents only). The server keeps
// every credential, including a private iCal address: after the one
// "check" request that sends it, these calls only ever see status, names
// and the address's host.

export interface CalendarConnectionClient {
  status(): Promise<CalendarConnectionStatus>;
  /** Returns Google's consent-page address to send the browser to. `replace`: the parent confirmed replacing an iCal address. */
  connectGoogle(appOrigin: string, replace: boolean): Promise<string>;
  calendars(): Promise<CalendarChoice[]>;
  selectCalendar(calendarId: string): Promise<void>;
  disconnectGoogle(): Promise<{ wasConnected: boolean; revokedAtGoogle: boolean }>;
  /** Checks an iCal address on the server; nothing changes yet. */
  checkFeed(url: string): Promise<FeedCheck>;
  /** Uses a checked address for the family. `replace`: the parent confirmed replacing the current connection. */
  useFeed(checkId: string, replace: boolean): Promise<{ replaced: CalendarMethod | null; revokedAtGoogle: boolean }>;
  disconnectFeed(): Promise<{ wasConnected: boolean }>;
}

export function createCalendarConnectionClient(request: Requester = createRequester()): CalendarConnectionClient {
  return {
    status: () => request<CalendarConnectionStatus>('GET', '/api/calendar/connection'),
    connectGoogle: async (appOrigin, replace) =>
      (await request<{ authorizationUrl: string }>('POST', '/api/calendar/google/connect', { appOrigin, ...(replace ? { replace: true } : {}) })).authorizationUrl,
    calendars: async () => (await request<{ calendars: CalendarChoice[] }>('GET', '/api/calendar/google/calendars', undefined, { timeoutMs: 20_000 })).calendars,
    selectCalendar: async (calendarId) => {
      await request('POST', '/api/calendar/google/calendar', { calendarId }, { timeoutMs: 20_000 });
    },
    disconnectGoogle: () => request('POST', '/api/calendar/google/disconnect', {}, { timeoutMs: 20_000 }),
    checkFeed: (url) => request<FeedCheck>('POST', '/api/calendar/ical/check', { url }, { timeoutMs: 30_000 }),
    useFeed: (checkId, replace) => request('POST', '/api/calendar/ical/use', { checkId, ...(replace ? { replace: true } : {}) }, { timeoutMs: 20_000 }),
    disconnectFeed: () => request('POST', '/api/calendar/ical/disconnect', {}),
  };
}
