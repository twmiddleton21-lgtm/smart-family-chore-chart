import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CONNECT_RESULTS, connectResultFromHash, type CalendarConnectionStatus, type FeedCheck, type FeedConnectionView, type GoogleConnectionView } from '../../lib/calendar';
import { CalendarConnectionCardView, type CalendarList, type CardLoad, type FeedForm } from './CalendarConnectionCard';

// Static render checks of Settings → Integrations → Family calendar for each
// state. Made-up data only; nothing contacts Google or a calendar provider.

const noop = () => {};
const ORIGIN = 'https://chores.example.test';
const CLOSED: FeedForm = { open: false, url: '', check: null, error: null };
const render = (load: CardLoad, opts: { list?: CalendarList; appOrigin?: string; busy?: boolean; feed?: FeedForm } = {}) =>
  renderToStaticMarkup(
    <CalendarConnectionCardView
      load={load}
      list={opts.list ?? { state: 'idle' }}
      feed={opts.feed ?? CLOSED}
      busy={opts.busy ?? false}
      appOrigin={opts.appOrigin ?? ORIGIN}
      onRetry={noop}
      onConnectGoogle={noop}
      onLoadCalendars={noop}
      onSelect={noop}
      onDisconnect={noop}
      onFeedOpen={noop}
      onFeedUrl={noop}
      onFeedCheck={noop}
      onFeedUse={noop}
    />,
  );
const ready = (status: Partial<CalendarConnectionStatus>): CardLoad => ({
  state: 'ready',
  status: {
    google: { available: true, missing: [], connectOrigin: ORIGIN },
    ical: { available: true, missing: [], extraHosts: [] },
    connection: null,
    refresh: { lastSuccessAt: null, lastError: null, lastErrorDetail: null },
    ...status,
  },
});
const GOOGLE: GoogleConnectionView = {
  method: 'google',
  status: 'connected',
  problem: null,
  accountEmail: 'family@example.test',
  calendarId: 'family@example.test',
  calendarName: 'Family',
  connectedAt: '2026-10-24T08:00:00.000Z',
  connectedBy: 'Alex',
};
const FEED: FeedConnectionView = {
  method: 'ical',
  status: 'connected',
  problem: null,
  provider: 'google',
  providerName: 'Google Calendar',
  host: 'calendar.google.com',
  calendarName: 'Family (iCal)',
  connectedAt: '2026-10-24T08:00:00.000Z',
  connectedBy: 'Blake',
};
const CHECK: FeedCheck = {
  checkId: 'check-1',
  provider: 'google',
  providerName: 'Google Calendar',
  host: 'calendar.google.com',
  calendarName: 'School',
  upcomingEvents: 3,
  replaces: null,
};

describe('Family calendar card', () => {
  it('is labelled as an integration and says it is read-only', () => {
    const html = render({ state: 'loading' });
    expect(html).toContain('Integrations');
    expect(html).toContain('Family calendar');
    expect(html).toContain('never adds, changes or deletes events');
    expect(html).toContain('Checking the calendar connection');
  });

  it('explains the missing server settings, by name, when neither method is set up', () => {
    const html = render(
      ready({
        google: { available: false, missing: ['SFCC_GOOGLE_CLIENT_ID', 'SFCC_SECRET_KEY_FILE'], connectOrigin: null },
        ical: { available: false, missing: ['SFCC_SECRET_KEY_FILE'], extraHosts: [] },
      }),
    );
    expect(html).toContain('Not set up on this family server yet');
    expect(html).toContain('<code>SFCC_GOOGLE_CLIENT_ID</code>');
    expect(html.match(/<code>SFCC_SECRET_KEY_FILE<\/code>/g)).toHaveLength(1);
    expect(html).toContain('docs/GOOGLE-CALENDAR.md');
    expect(html).not.toContain('Connect Google Calendar</button>');
    expect(html).not.toContain('calendar-feed-url');
  });

  it('offers both methods when nothing is connected, Google first and recommended', () => {
    const html = render(ready({}));
    expect(html).toContain('1. Google Calendar sign-in (recommended)');
    expect(html).toMatch(/<button type="button" class="button button-primary">Connect Google Calendar<\/button>/);
    expect(html).toContain('2. Or a calendar address (iCal)');
    expect(html).toContain('id="calendar-feed-url"');
    expect(html.indexOf('Connect Google Calendar')).toBeLessThan(html.indexOf('calendar-feed-url'));
    expect(html).toContain('works for every parent and family device');
  });

  it('warns that a secret address works like a password, and lists the supported providers', () => {
    const html = render(ready({ ical: { available: true, missing: [], extraHosts: ['calendar.school.example'] } }));
    expect(html).toContain('works like a password');
    expect(html).toContain('Anyone who has it can read the whole calendar');
    expect(html).toContain('never shows it again');
    expect(html).toContain('Secret address in iCal format');
    expect(html).toContain('Outlook or Microsoft 365');
    expect(html).toContain('iCloud');
    expect(html).toContain('calendar.school.example');
    // The browser shouldn't remember, autocorrect or capitalise a secret address.
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('spellCheck="false"');
    expect(html).toContain('autoCapitalize="off"');
  });

  it('offers only the calendar address when the server has no Google OAuth client', () => {
    const html = render(ready({ google: { available: false, missing: ['SFCC_GOOGLE_CLIENT_ID', 'SFCC_GOOGLE_REDIRECT_URI'], connectOrigin: null } }));
    expect(html).not.toContain('Connect Google Calendar</button>');
    expect(html).toContain('Not available on this server');
    expect(html).toContain('<code>SFCC_GOOGLE_CLIENT_ID</code>');
    expect(html).toContain('id="calendar-feed-url"');
  });

  it('sends the parent to the registered address instead of a Google Connect that would fail', () => {
    const html = render(ready({}), { appOrigin: 'http://192.168.1.20:3080' });
    expect(html).not.toContain('Connect Google Calendar</button>');
    expect(html).toContain(`href="${ORIGIN}"`);
    expect(html).toContain('id="calendar-feed-url"'); // the address works from anywhere
  });

  it('shows a checked address before anything changes, and what it would replace', () => {
    const html = render(ready({ connection: GOOGLE }), {
      feed: { open: true, url: '', check: { ...CHECK, replaces: { method: 'google', label: 'family@example.test', calendarName: 'Family' } }, error: null },
    });
    expect(html).toContain('Found <strong>School</strong> (Google Calendar, calendar.google.com) with 3 events in the next 7 days');
    expect(html).toContain('replaces the current family calendar: <strong>Family</strong> (family@example.test)');
    expect(html).toContain('Use this calendar</button>');
    expect(html).not.toContain('id="calendar-feed-url"'); // the address field is gone (and was cleared)
  });

  it('shows why an address was refused', () => {
    const html = render(ready({}), { feed: { open: false, url: 'https://example.com/x.ics', check: null, error: 'That address isn’t from a supported calendar provider.' } });
    expect(html).toContain('role="alert"');
    expect(html).toContain('supported calendar provider');
    expect(html).toContain('aria-invalid="true"');
  });

  it('Google connected: account, calendar, who connected it, last refresh, and the way to switch', () => {
    const html = render(ready({ connection: GOOGLE, refresh: { lastSuccessAt: '2026-10-24T09:00:00.000Z', lastError: null, lastErrorDetail: null } }));
    expect(html).toContain('Connected for the whole family with Google Calendar sign-in');
    expect(html).toContain('family@example.test');
    expect(html).toContain('<dd>Family</dd>');
    expect(html).toContain(' by Alex');
    expect(html).toContain('Last refreshed');
    expect(html).not.toContain('Not yet since the server started');
    expect(html).toContain('Choose a different calendar');
    expect(html).toContain('>Reconnect</button>');
    expect(html).toContain('>Disconnect</button>');
    expect(html).toContain('Use a calendar address instead');
    expect(html).not.toContain('id="calendar-feed-url"'); // only once asked for
  });

  it('iCal connected: provider and host only (never the address), refresh timing, and switching to Google', () => {
    const html = render(ready({ connection: FEED }));
    expect(html).toContain('Connected for the whole family with a calendar address (iCal)');
    expect(html).toContain('Google Calendar · calendar.google.com');
    expect(html).toContain('the full address stays secret');
    expect(html).toContain('<dd>Family (iCal)</dd>');
    expect(html).toContain(' by Blake');
    expect(html).toContain('Not yet since the server started');
    expect(html).toContain('can take several hours');
    expect(html).toContain('Enter a new address</button>');
    expect(html).toContain('Switch to Google Calendar sign-in (recommended)');
    expect(html).toContain('Switch to Google Calendar</button>');
    expect(html).not.toContain('Choose a different calendar');
    expect(html).not.toMatch(/private-|basic\.ics|https:\/\/calendar\.google\.com\//);
  });

  it('shows the last refresh problem without hiding the connection', () => {
    const html = render(ready({ connection: FEED, refresh: { lastSuccessAt: '2026-10-24T09:00:00.000Z', lastError: 'auth', lastErrorDetail: 'not_found' } }));
    expect(html).toContain('may have been removed or reset');
    expect(html).toContain('Connected for the whole family');
  });

  it.each([
    [GOOGLE, 'revoked', 'no longer accepts this connection', 'Reconnect Google Calendar</button>'],
    [GOOGLE, 'key_changed', 'secret key changed', 'Reconnect Google Calendar</button>'],
    [FEED, 'key_changed', 'Enter the address again', 'Enter a new address</button>'],
  ] as const)('explains a connection that needs attention (%j, %s)', (connection, problem, text, action) => {
    const html = render(ready({ connection: { ...connection, status: 'needs_reconnect', problem } }));
    expect(html).toContain('role="alert"');
    expect(html).toContain(text);
    expect(html).toContain(action);
    expect(html).not.toContain('Choose a different calendar');
  });

  it('lists Google calendars to choose from, with the current one selected', () => {
    const html = render(ready({ connection: GOOGLE }), {
      list: {
        state: 'ready',
        calendars: [
          { id: 'family@example.test', name: 'Family', primary: true, selected: true },
          { id: 'school@x', name: 'School dates', primary: false, selected: false },
        ],
      },
    });
    expect(html).toContain('<option value="family@example.test" selected="">Family (main calendar)</option>');
    expect(html).toContain('<option value="school@x">School dates</option>');
    expect(html).toMatch(/disabled="">Show this calendar/); // nothing changed yet
  });

  it('shows an empty calendar list and list errors helpfully', () => {
    expect(render(ready({ connection: GOOGLE }), { list: { state: 'ready', calendars: [] } })).toContain('no calendars the app can read');
    const html = render(ready({ connection: GOOGLE }), { list: { state: 'error', message: 'Google Calendar can’t be reached right now.' } });
    expect(html).toContain('Google Calendar can’t be reached right now.');
    expect(html).toContain('Try again');
  });

  it('shows a load error with retry', () => {
    const html = render({ state: 'error', message: 'Can’t reach the family server.' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Try again');
  });
});

describe('coming back from Google', () => {
  it('reads only well-formed results from the address', () => {
    expect(connectResultFromHash('#google-calendar=connected')).toBe('connected');
    expect(connectResultFromHash('#google-calendar=invalid_state')).toBe('invalid_state');
    expect(connectResultFromHash('#google-calendar=<script>')).toBeNull();
    expect(connectResultFromHash('#other=connected')).toBeNull();
    expect(connectResultFromHash('')).toBeNull();
  });

  it('has a message for every result the server sends', () => {
    for (const r of ['connected', 'denied', 'scope_missing', 'invalid_state', 'calendar_api', 'setup', 'changed', 'not_configured', 'failed']) {
      expect(CONNECT_RESULTS[r]?.message, r).toBeTruthy();
    }
    expect(CONNECT_RESULTS.connected!.message).toContain('whole family');
    expect(CONNECT_RESULTS.denied!.message).toContain('Nothing was changed');
  });
});
