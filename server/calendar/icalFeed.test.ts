import { describe, expect, it } from 'vitest';
import { checkFeedUrl, FeedParseError, PARSE_BUDGET_MS, PARSE_TIMEOUT_MS, parseIcalFeed, parseIcalFeedIsolated } from './icalFeed';

// Private iCal addresses: which addresses are accepted, and how feeds are
// read. Synthetic feeds only; nothing here contacts a calendar provider.

const GOOGLE_SECRET = 'https://calendar.google.com/calendar/ical/family%40example.test/private-0123456789abcdef0123456789abcdef/basic.ics';

describe('checkFeedUrl (supported providers and address formats)', () => {
  it.each([
    [GOOGLE_SECRET, 'google', 'calendar.google.com'],
    ['https://calendar.google.com/calendar/ical/abc%40group.calendar.google.com/public/basic.ics', 'google', 'calendar.google.com'],
    ['https://outlook.office365.com/owa/calendar/0f1e2d3c@example.com/a1b2c3d4e5/calendar.ics', 'microsoft', 'outlook.office365.com'],
    ['https://outlook.live.com/owa/calendar/00000000-0000-0000-0000-000000000000/a1b2c3/calendar.ics', 'microsoft', 'outlook.live.com'],
    // The Outlook.com shape with a cid- segment, complete and unmodified (synthetic values).
    ['https://outlook.live.com/owa/calendar/00000000-0000-0000-0000-000000000000/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0/cid-0123456789ABCDEF/calendar.ics', 'microsoft', 'outlook.live.com'],
    ['https://outlook.office365.com/owa/calendar/x@example.com/y/reachcalendar.ics', 'microsoft', 'outlook.office365.com'],
    ['webcal://p42-caldav.icloud.com/published/2/MTIzNDU2Nzg5MDEyMzQ1Ng', 'apple', 'p42-caldav.icloud.com'],
    ['  https://calendar.google.com/calendar/ical/a/private-ab12/basic.ics  ', 'google', 'calendar.google.com'], // pasted with spaces
  ])('accepts %s', (raw, provider, host) => {
    const r = checkFeedUrl(raw);
    expect(r).toMatchObject({ provider, host });
    expect('url' in r && r.url.protocol).toBe('https:'); // webcal:// is read as https://
  });

  it('accepts hosts the operator added (SFCC_CALENDAR_FEED_HOSTS), and only those', () => {
    expect(checkFeedUrl('https://calendar.school.example/feeds/term-dates.ics', ['calendar.school.example'])).toMatchObject({ provider: 'other', host: 'calendar.school.example' });
    expect(checkFeedUrl('https://calendar.school.example/feeds/term-dates.ics')).toEqual({ problem: 'unsupported' });
    expect(checkFeedUrl('https://evil.calendar.school.example/x.ics', ['calendar.school.example'])).toEqual({ problem: 'unsupported' });
  });

  it.each([
    ['the Google web page address', 'https://calendar.google.com/calendar/embed?src=family%40example.test'],
    ['a Google address in another shape', 'https://calendar.google.com/calendar/ical/x/private-abc/full.ics'],
    ['a non-hex Google key', 'https://calendar.google.com/calendar/ical/x/private-zzz/basic.ics'],
    ['another host', 'https://example.com/calendar.ics'],
    ['a look-alike host', 'https://calendar.google.com.evil.example/calendar/ical/x/private-ab/basic.ics'],
    ['a sub-domain', 'https://x.calendar.google.com/calendar/ical/x/private-ab/basic.ics'],
    ['an iCloud look-alike', 'https://p1-caldav.icloud.com.evil.example/published/2/abc'],
    ['an IP address', 'https://142.250.0.1/calendar/ical/x/private-ab/basic.ics'],
    ['localhost', 'https://localhost/calendar/ical/x/private-ab/basic.ics'],
    // Outlook: only the one extra cid-<hex> segment, only on outlook.live.com.
    ['a non-hex cid', 'https://outlook.live.com/owa/calendar/a/b/cid-xyz/calendar.ics'],
    ['an extra segment that isn’t cid-', 'https://outlook.live.com/owa/calendar/a/b/c/calendar.ics'],
    ['two extra segments', 'https://outlook.live.com/owa/calendar/a/b/cid-01/cid-02/calendar.ics'],
    ['a cid segment on Microsoft 365', 'https://outlook.office365.com/owa/calendar/x@example.com/y/cid-01/calendar.ics'],
    ['a webcal address to another host', 'webcal://evil.example/published/2/abc'],
  ])('refuses %s as unsupported', (_name, raw) => {
    expect(checkFeedUrl(raw)).toEqual({ problem: 'unsupported' });
  });

  it('reads webcal:// and webcals:// (any case) as https:// on port 443, never as another protocol', () => {
    for (const raw of ['webcal://p42-caldav.icloud.com/published/2/abc', 'WEBCAL://p42-caldav.icloud.com/published/2/abc', 'webcals://p42-caldav.icloud.com/published/2/abc']) {
      const r = checkFeedUrl(raw);
      expect('url' in r && r.url.href, raw).toBe('https://p42-caldav.icloud.com/published/2/abc');
    }
    // A port is still refused after the rewrite (webcal's usual port 80 included).
    expect(checkFeedUrl('webcal://p42-caldav.icloud.com:80/published/2/abc')).toEqual({ problem: 'invalid' });
    // Other look-alike schemes aren't rewritten, so they stay invalid.
    expect(checkFeedUrl('webcalx://p42-caldav.icloud.com/published/2/abc')).toEqual({ problem: 'invalid' });
    expect(checkFeedUrl('http://p42-caldav.icloud.com/published/2/abc')).toEqual({ problem: 'invalid' });
  });

  it.each([
    ['plain http', GOOGLE_SECRET.replace('https:', 'http:')],
    ['user info', GOOGLE_SECRET.replace('https://', 'https://me:pw@')],
    ['a port', GOOGLE_SECRET.replace('google.com/', 'google.com:8443/')],
    ['a fragment', `${GOOGLE_SECRET}#x`],
    ['spaces inside', GOOGLE_SECRET.replace('basic', 'ba sic')],
    ['a line break', `${GOOGLE_SECRET}\nhttps://evil.example/`],
    ['not an address', 'my calendar'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/calendar,BEGIN:VCALENDAR'],
    ['empty', '   '],
    ['too long', `${GOOGLE_SECRET}?${'a'.repeat(2100)}`],
  ])('refuses %s as invalid', (_name, raw) => {
    expect(checkFeedUrl(raw)).toEqual({ problem: 'invalid' });
  });
});

// ---------- parsing ----------

const LONDON_TZ = `BEGIN:VTIMEZONE
TZID:Europe/London
BEGIN:DAYLIGHT
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
TZNAME:BST
DTSTART:19700329T010000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
TZNAME:GMT
DTSTART:19701025T020000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE`;

const feed = (...events: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Family//EN', 'X-WR-CALNAME:Test Family', LONDON_TZ, ...events, 'END:VCALENDAR', '']
    .join('\n')
    .replace(/\n/g, '\r\n');
const vevent = (lines: string) => `BEGIN:VEVENT\n${lines.trim()}\nEND:VEVENT`;

const TZ = 'Europe/London';
/** Saturday 24 to Friday 30 October 2026; UK clocks go back on Sunday 25th. */
const RANGE = { start: '2026-10-24', end: '2026-10-30' };
const parse = (text: string, tz = TZ, range = RANGE) => parseIcalFeed(text, tz, range);
const brief = (text: string, tz = TZ) =>
  parse(text, tz)
    .events.map((e) => `${e.startDate}${e.allDay ? '' : ` ${e.startTime}-${e.endTime}`}${e.endDate !== e.startDate ? ` →${e.endDate}` : ''} ${e.title}`)
    .sort();

describe('parseIcalFeed', () => {
  it('reads the calendar name and a timed event in a time zone the feed defines', () => {
    const r = parse(feed(vevent('UID:a\nSUMMARY:Swimming\nLOCATION:Leisure centre\nDTSTART;TZID=Europe/London:20261024T093000\nDTEND;TZID=Europe/London:20261024T101500')));
    expect(r.calendarName).toBe('Test Family');
    expect(r.events).toEqual([
      { id: expect.stringMatching(/^[0-9a-f]{20}$/), title: 'Swimming', allDay: false, startDate: '2026-10-24', endDate: '2026-10-24', startTime: '09:30', endTime: '10:15', location: 'Leisure centre' },
    ]);
  });

  it('converts UTC, other zones without a definition, and floating times to the household time zone', () => {
    const text = feed(
      vevent('UID:utc\nSUMMARY:UTC\nDTSTART:20261026T150000Z\nDTEND:20261026T160000Z'),
      // No VTIMEZONE for New York: the IANA name is used (EDT, UTC-4, until 1 November).
      vevent('UID:ny\nSUMMARY:New York\nDTSTART;TZID=America/New_York:20261027T090000\nDTEND;TZID=America/New_York:20261027T100000'),
      // Floating: "the same wall-clock time wherever you are".
      vevent('UID:fl\nSUMMARY:Floating\nDTSTART:20261028T070000\nDTEND:20261028T073000'),
    );
    expect(brief(text)).toEqual(['2026-10-26 15:00-16:00 UTC', '2026-10-27 13:00-14:00 New York', '2026-10-28 07:00-07:30 Floating']);
    // Sydney is UTC+11: 15:00 UTC on the 26th is 02:00 on the 27th there.
    expect(brief(text, 'Australia/Sydney')).toContain('2026-10-27 02:00-03:00 UTC');
  });

  it('keeps local times across the clocks going back (DST) for a repeating event', () => {
    const text = feed(vevent('UID:w\nSUMMARY:Piano\nDTSTART;TZID=Europe/London:20260101T090000\nDTEND;TZID=Europe/London:20260101T093000\nRRULE:FREQ=DAILY'));
    expect(brief(text)).toEqual([24, 25, 26, 27, 28, 29, 30].map((d) => `2026-10-${d} 09:00-09:30 Piano`));
  });

  it('makes all-day end dates inclusive, and keeps multi-day events that started earlier', () => {
    const text = feed(
      vevent('UID:b\nSUMMARY:Birthday\nDTSTART;VALUE=DATE:20261025\nDTEND;VALUE=DATE:20261026'),
      vevent('UID:h\nSUMMARY:Half term\nDTSTART;VALUE=DATE:20261022\nDTEND;VALUE=DATE:20261031'),
      vevent('UID:n\nSUMMARY:No end\nDTSTART;VALUE=DATE:20261029'),
    );
    const r = parse(text).events;
    expect(r.find((e) => e.title === 'Birthday')).toMatchObject({ allDay: true, startDate: '2026-10-25', endDate: '2026-10-25' });
    expect(r.find((e) => e.title === 'Half term')).toMatchObject({ allDay: true, startDate: '2026-10-22', endDate: '2026-10-30' });
    expect(r.find((e) => e.title === 'No end')).toMatchObject({ startDate: '2026-10-29', endDate: '2026-10-29' });
  });

  it('expands repeating events with EXDATE, moved occurrences (RECURRENCE-ID) and cancelled ones', () => {
    const text = feed(
      // Mondays and Wednesdays at 16:00 since January…
      vevent(`UID:swim
SUMMARY:Swimming
DTSTART;TZID=Europe/London:20260105T160000
DTEND;TZID=Europe/London:20260105T170000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE
EXDATE;TZID=Europe/London:20261026T160000`),
      // …this Wednesday's lesson moved to Thursday 17:00 and renamed.
      vevent(`UID:swim
RECURRENCE-ID;TZID=Europe/London:20261028T160000
SUMMARY:Swimming (moved)
DTSTART;TZID=Europe/London:20261029T170000
DTEND;TZID=Europe/London:20261029T180000`),
      // A daily club since 2010 (many steps to reach today), one day cancelled.
      vevent(`UID:club
SUMMARY:Breakfast club
DTSTART;TZID=Europe/London:20100104T080000
DTEND;TZID=Europe/London:20100104T083000
RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR`),
      vevent(`UID:club
RECURRENCE-ID;TZID=Europe/London:20261027T080000
STATUS:CANCELLED
SUMMARY:Breakfast club
DTSTART;TZID=Europe/London:20261027T080000
DTEND;TZID=Europe/London:20261027T083000`),
      // Ends before the range: nothing.
      vevent('UID:old\nSUMMARY:Old series\nDTSTART:20250101T100000Z\nDTEND:20250101T110000Z\nRRULE:FREQ=WEEKLY;UNTIL=20250601T000000Z'),
      // A count-limited series.
      vevent('UID:three\nSUMMARY:Three times\nDTSTART;VALUE=DATE:20261028\nRRULE:FREQ=DAILY;COUNT=3'),
    );
    expect(brief(text)).toEqual([
      '2026-10-26 08:00-08:30 Breakfast club',
      '2026-10-28 08:00-08:30 Breakfast club',
      '2026-10-28 Three times',
      '2026-10-29 08:00-08:30 Breakfast club',
      '2026-10-29 17:00-18:00 Swimming (moved)',
      '2026-10-29 Three times',
      '2026-10-30 08:00-08:30 Breakfast club',
      '2026-10-30 Three times',
    ]);
  });

  it('uses DURATION when there is no DTEND, and gives occurrences distinct, stable IDs', () => {
    const text = feed(vevent('UID:d\nSUMMARY:Short\nDTSTART:20261024T100000Z\nDURATION:PT45M\nRRULE:FREQ=DAILY;COUNT=2'));
    const a = parse(text).events;
    // 10:00 UTC is 11:00 in London on Saturday (BST) and 10:00 on Sunday (GMT, after the clocks go back).
    expect(a.map((e) => `${e.startDate} ${e.startTime}-${e.endTime}`)).toEqual(['2026-10-24 11:00-11:45', '2026-10-25 10:00-10:45']);
    expect(new Set(a.map((e) => e.id)).size).toBe(2);
    expect(parse(text).events.map((e) => e.id)).toEqual(a.map((e) => e.id));
  });

  it('drops cancelled events and events without a start; keeps untitled ones', () => {
    const text = feed(
      vevent('UID:c\nSTATUS:CANCELLED\nSUMMARY:Called off\nDTSTART;VALUE=DATE:20261025'),
      vevent('UID:m\nSUMMARY:No start'),
      vevent('UID:u\nDTSTART;VALUE=DATE:20261025'),
      vevent('UID:late\nSUMMARY:Too late\nDTSTART;VALUE=DATE:20261105'),
    );
    expect(brief(text)).toEqual(['2026-10-25 (No title)']);
  });

  it('keeps only title, times and location: no descriptions, attendees, organisers or links', () => {
    const text = feed(
      vevent(`UID:p
SUMMARY:Parents' evening
DESCRIPTION:Meeting link https://meet.example/abc PIN 1234
ORGANIZER;CN=Head Teacher:mailto:head@school.example
ATTENDEE;CN=Parent:mailto:parent@example.test
URL:https://school.example/private
DTSTART:20261027T170000Z
DTEND:20261027T180000Z`),
    );
    const out = JSON.stringify(parse(text));
    expect(out).toContain('Parents');
    for (const secret of ['meet.example', '1234', 'head@school', 'parent@example', 'school.example/private', 'Head Teacher']) expect(out).not.toContain(secret);
  });

  it('trims long text and strips control characters', () => {
    const [e] = parse(feed(vevent(`UID:t\nSUMMARY:A\\nB${'x'.repeat(500)}\nDTSTART;VALUE=DATE:20261025`))).events;
    expect(e!.title.startsWith('A B')).toBe(true);
    expect(e!.title).toHaveLength(200);
  });

  it('survives hostile rules: SECONDLY/MINUTELY series are skipped, a zero interval is bounded', () => {
    const text = feed(
      vevent('UID:s\nSUMMARY:Every second\nDTSTART:19700101T000000Z\nRRULE:FREQ=SECONDLY'),
      vevent('UID:mi\nSUMMARY:Every minute\nDTSTART:19700101T000000Z\nRRULE:FREQ=MINUTELY'),
      vevent('UID:z\nSUMMARY:Zero interval\nDTSTART:20000101T100000Z\nRRULE:FREQ=DAILY;INTERVAL=0'),
      vevent('UID:ok\nSUMMARY:Fine\nDTSTART;VALUE=DATE:20261026'),
    );
    const started = Date.now();
    const shown = brief(text);
    expect(shown).toContain('2026-10-26 Fine');
    expect(shown.join()).not.toMatch(/Every/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('reports a feed with a syntactically broken rule as unreadable (not a crash)', () => {
    const text = feed(vevent('UID:bad\nSUMMARY:Broken rule\nDTSTART:20261025T100000Z\nRRULE:FREQ=NONSENSE;BYDAY=XX'));
    expect(() => parse(text)).toThrow(FeedParseError);
  });

  it('bounds the work for an hourly series from long ago (step budget) and caps the events returned', () => {
    const hourly = vevent('UID:h\nSUMMARY:Hourly\nDTSTART:19900101T000000Z\nDTEND:19900101T001500Z\nRRULE:FREQ=HOURLY');
    const many = Array.from({ length: 600 }, (_, i) => vevent(`UID:x${i}\nSUMMARY:Item ${i}\nDTSTART;VALUE=DATE:20261026`));
    const started = Date.now();
    const r = parse(feed(hourly, ...many));
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(r.events.length).toBeLessThanOrEqual(500);
  });

  it('refuses things that aren’t iCalendar', () => {
    for (const text of ['<!doctype html><html><body>Sign in</body></html>', '', '{"items":[]}', 'BEGIN:VCARD\r\nEND:VCARD\r\n']) {
      expect(() => parse(text), text).toThrow(FeedParseError);
    }
  });

  it('accepts a byte-order mark and LF line endings', () => {
    const text = `﻿${feed(vevent('UID:a\nSUMMARY:Bom\nDTSTART;VALUE=DATE:20261025')).replace(/\r\n/g, '\n')}`;
    expect(brief(text)).toEqual(['2026-10-25 Bom']);
  });
});

// ---------- cost: hostile and large feeds (audit findings F1, F2) ----------

const elapsed = (fn: () => unknown) => {
  const started = performance.now();
  fn();
  return performance.now() - started;
};
const failure = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

describe('parseIcalFeed cost limits', () => {
  // The audit's feed: 3.3 KB that blocked the server for 12 s (a new
  // Intl.DateTimeFormat per step, stepping daily from 1970, deadline only
  // checked between events).
  const AUDIT_FEED = feed(
    ...Array.from({ length: 30 }, (_, i) =>
      vevent(`UID:h${i}\nSUMMARY:Daily ${i}\nDTSTART;TZID=America/New_York:19700101T090000\nDTEND;TZID=America/New_York:19700101T100000\nRRULE:FREQ=DAILY`),
    ),
  );

  it('reads the audit’s hostile feed quickly, and correctly (daily series from 1970 reach today)', () => {
    let events: ReturnType<typeof parse>['events'] = [];
    const ms = elapsed(() => (events = parse(AUDIT_FEED).events));
    // Measured about 60 ms; 1 s allows for a slow or busy machine.
    expect(ms).toBeLessThan(1_000);
    expect(events).toHaveLength(30 * 7); // each of the 7 days
    // 09:00 in New York (EDT until 1 November) is 14:00 in London, then 13:00 once London's clocks go back.
    expect(events.filter((e) => e.title === 'Daily 0').map((e) => `${e.startDate} ${e.startTime}`)).toEqual([
      '2026-10-24 14:00',
      '2026-10-25 13:00',
      '2026-10-26 13:00',
      '2026-10-27 13:00',
      '2026-10-28 13:00',
      '2026-10-29 13:00',
      '2026-10-30 13:00',
    ]);
  });

  it('stops a feed that can’t be skipped through (COUNT from 1970) at the budget, as a whole-feed failure', () => {
    // COUNT is counted from the real start, so each series is stepped from 1970.
    const text = feed(
      ...Array.from({ length: 30 }, (_, i) => vevent(`UID:c${i}\nSUMMARY:x\nDTSTART;TZID=America/New_York:19700101T090000\nRRULE:FREQ=DAILY;COUNT=20000`)),
    );
    let error: unknown;
    const ms = elapsed(() => (error = failure(() => parse(text))));
    expect(error).toBeInstanceOf(FeedParseError);
    expect((error as FeedParseError).problem).toBe('too_complex');
    // The deadline is checked every 64 steps; the slowest single step measured
    // was 1.4 ms (BYSETPOS), so 64 steps can overrun by about 0.1 s. 0.5 s of
    // tolerance allows for a slow or busy machine.
    expect(ms).toBeGreaterThanOrEqual(PARSE_BUDGET_MS - 1);
    expect(ms).toBeLessThan(PARSE_BUDGET_MS + 500);
  });

  it('applies the budget inside a single series (not only between events)', () => {
    const one = feed(vevent('UID:one\nDTSTART:19700101T000000Z\nRRULE:FREQ=HOURLY;COUNT=20000'));
    const error = failure(() => parseIcalFeed(one, TZ, RANGE, { budgetMs: 0 }));
    expect(error).toBeInstanceOf(FeedParseError);
    expect((error as FeedParseError).problem).toBe('too_complex');
  });

  it('skipping ahead through old DAILY and WEEKLY series gives exactly the same events as stepping from the start', () => {
    const series = [
      'DTSTART;TZID=Europe/London:20000103T080000\nDTEND;TZID=Europe/London:20000103T083000\nRRULE:FREQ=DAILY',
      'DTSTART;TZID=Europe/London:20000103T233000\nDTEND;TZID=Europe/London:20000104T003000\nRRULE:FREQ=DAILY;INTERVAL=3', // crosses midnight
      'DTSTART;TZID=America/New_York:20050104T190000\nDTEND;TZID=America/New_York:20050104T200000\nRRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', // zone without a definition
      'DTSTART:20010107T220000Z\nDTEND:20010107T230000Z\nRRULE:FREQ=WEEKLY;BYDAY=SU,TU,SA',
      'DTSTART;TZID=Europe/London:20020101T170000\nDTEND;TZID=Europe/London:20020101T180000\nRRULE:FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=MO,WE,FR',
      'DTSTART;TZID=Europe/London:20031028T090000\nDTEND;TZID=Europe/London:20031028T100000\nRRULE:FREQ=WEEKLY;INTERVAL=3', // the weekday of DTSTART
      'DTSTART;TZID=Europe/London:20040106T120000\nDTEND;TZID=Europe/London:20040106T130000\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', // last weekday of each week
      'DTSTART;TZID=Europe/London:20040106T160000\nDTEND;TZID=Europe/London:20040106T170000\nRRULE:FREQ=DAILY;BYMONTH=10,11;BYMONTHDAY=26,27,28,29,30',
      'DTSTART;VALUE=DATE:20000101\nDTEND;VALUE=DATE:20000103\nRRULE:FREQ=WEEKLY;INTERVAL=4;BYDAY=SA', // two-day, all day
      'DTSTART:20060102T150000Z\nDURATION:PT45M\nRRULE:FREQ=DAILY;INTERVAL=7;UNTIL=20261027T000000Z', // ends inside the range
      'DTSTART;TZID=Europe/London:20000101T100000\nDTEND;TZID=Europe/London:20000101T110000\nRRULE:FREQ=DAILY\nEXDATE;TZID=Europe/London:20261026T100000,20261028T100000',
      'DTSTART;TZID=Australia/Sydney:20000101T070000\nDTEND;TZID=Australia/Sydney:20000101T080000\nRRULE:FREQ=WEEKLY;BYDAY=SU,MO', // other side of the date line
    ];
    const text = feed(
      ...series.map((s, i) => vevent(`UID:s${i}\nSUMMARY:Series ${i}\n${s}`)),
      // A moved occurrence, and a cancelled one, of series 0.
      vevent('UID:s0\nRECURRENCE-ID;TZID=Europe/London:20261027T080000\nSUMMARY:Series 0 (late)\nDTSTART;TZID=Europe/London:20261027T091500\nDTEND;TZID=Europe/London:20261027T094500'),
      vevent('UID:s0\nRECURRENCE-ID;TZID=Europe/London:20261029T080000\nSTATUS:CANCELLED\nDTSTART;TZID=Europe/London:20261029T080000'),
    );
    for (const tz of ['Europe/London', 'America/Los_Angeles', 'Pacific/Auckland']) {
      const skipped = parseIcalFeed(text, tz, RANGE).events;
      // The reference steps day by day from 2000 (slow by design, never used
      // in production), so it gets a generous time limit: under a busy,
      // parallel test run it could otherwise hit the 1.5 s production limit.
      const stepped = parseIcalFeed(text, tz, RANGE, { fastForward: false, budgetMs: 60_000 }).events;
      expect(skipped.length, tz).toBeGreaterThan(30);
      expect(skipped, tz).toEqual(stepped);
    }
    // Spot checks in London: the moved and cancelled occurrences, the EXDATEs, UNTIL.
    const titles = (date: string) => parse(text).events.filter((e) => e.startDate === date).map((e) => `${e.startTime ?? 'all day'} ${e.title}`).sort();
    expect(titles('2026-10-27')).toContain('09:15 Series 0 (late)');
    expect(titles('2026-10-27')).not.toContain('08:00 Series 0');
    expect(titles('2026-10-29')).not.toContain('08:00 Series 0');
    expect(titles('2026-10-26')).not.toContain('10:00 Series 10');
    expect(titles('2026-10-27')).toContain('10:00 Series 10');
    expect(parse(text).events.filter((e) => e.title === 'Series 9').every((e) => e.startDate <= '2026-10-26')).toBe(true);
  });

  it('keeps the events near the range edges among 20,000 irrelevant ones, without running out of budget', () => {
    const old = Array.from({ length: 20_000 }, (_, i) => {
      const y = 2010 + (i % 15);
      const d = `${y}${pad2(1 + (i % 12))}${pad2(1 + (i % 28))}`;
      // Half in a zone the feed doesn't define: that used to make every lookup scan the whole feed.
      const tz = i % 2 ? 'America/New_York' : 'Europe/London';
      return vevent(`UID:old${i}\nSUMMARY:Old ${i}\nLOCATION:Room ${i}\nDTSTART;TZID=${tz}:${d}T100000\nDTEND;TZID=${tz}:${d}T110000`);
    });
    const text = feed(
      ...old.slice(0, 10_000),
      vevent('UID:e2\nSUMMARY:Crosses into the range\nDTSTART;TZID=Europe/London:20261023T233000\nDTEND;TZID=Europe/London:20261024T003000'),
      vevent('UID:e3\nSUMMARY:Day before\nDTSTART;VALUE=DATE:20261023\nDTEND;VALUE=DATE:20261024'),
      vevent('UID:e4\nSUMMARY:Holiday from last month\nDTSTART;VALUE=DATE:20260920\nDTEND;VALUE=DATE:20261026'),
      vevent('UID:e5\nSUMMARY:Last evening\nDTSTART;TZID=America/New_York:20261030T183000\nDTEND;TZID=America/New_York:20261030T190000'), // 22:30 London
      vevent('UID:e6\nSUMMARY:Just after\nDTSTART;TZID=America/New_York:20261030T200000\nDTEND;TZID=America/New_York:20261030T210000'), // 00:00 on the 31st in London
      vevent('UID:e7\nSUMMARY:Called off\nSTATUS:CANCELLED\nDTSTART;VALUE=DATE:20261027'),
      vevent('UID:e8\nSUMMARY:Next week\nDTSTART;VALUE=DATE:20261031'),
      ...old.slice(10_000),
    );
    expect(text.length).toBeLessThan(5 * 1024 * 1024); // within the fetch limit
    let shown: string[] = [];
    // Measured about 0.25 s (before: rejected as "took too long" at about 16,000 events).
    const ms = elapsed(() => (shown = brief(text)));
    expect(ms).toBeLessThan(PARSE_BUDGET_MS);
    expect(shown).toEqual([
      '2026-09-20 →2026-10-25 Holiday from last month',
      '2026-10-23 23:30-00:30 →2026-10-24 Crosses into the range',
      '2026-10-30 22:30-23:00 Last evening',
    ]);
  });

  it('refuses a feed with more events than a 5 MB feed can hold', () => {
    const tiny = vevent('UID:t\nDTSTART;VALUE=DATE:20150101');
    const error = failure(() => parse(feed(...Array.from({ length: 50_001 }, () => tiny))));
    expect(error).toBeInstanceOf(FeedParseError);
    expect((error as FeedParseError).problem).toBe('too_complex');
  });
});

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

// ---------- the worker thread (what the server uses for fetched feeds) ----------

describe('parseIcalFeedIsolated', () => {
  it('gives the same result as parsing in place', async () => {
    const text = feed(vevent('UID:a\nSUMMARY:Swimming\nDTSTART;TZID=Europe/London:20261024T093000\nDTEND;TZID=Europe/London:20261024T101500'));
    await expect(parseIcalFeedIsolated(text, TZ, RANGE)).resolves.toEqual(parse(text));
  });

  it('reports a document that isn’t iCalendar as not_ical', async () => {
    await expect(parseIcalFeedIsolated('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:nonsense\r\n', TZ, RANGE)).rejects.toMatchObject({ problem: 'not_ical' });
  });

  it('stops a single ical.js call that never returns (impossible rule) while the server keeps answering', async () => {
    // FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30 never matches: in place, one call
    // ran for 112 s before failing to allocate memory. No step-by-step
    // deadline can interrupt it; terminating the worker does.
    const text = feed(vevent('UID:x\nSUMMARY:Never\nDTSTART:20200101T090000Z\nRRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30'));
    let worstLag = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      worstLag = Math.max(worstLag, now - last - 10);
      last = now;
    }, 10);
    const started = performance.now();
    try {
      await expect(parseIcalFeedIsolated(text, TZ, RANGE)).rejects.toMatchObject({ problem: 'too_complex' });
    } finally {
      clearInterval(ticker);
    }
    const ms = performance.now() - started;
    expect(ms).toBeGreaterThanOrEqual(PARSE_TIMEOUT_MS - 1);
    expect(ms).toBeLessThan(PARSE_TIMEOUT_MS + 1_000); // terminating and the event loop: measured within 10 ms
    // Measured under 10 ms; 250 ms allows for a busy test machine. In place, this was minutes.
    expect(worstLag).toBeLessThan(250);
  }, 15_000);

  it('runs several feeds at once (two workers at a time, the rest wait)', async () => {
    const text = (n: number) => feed(vevent(`UID:${n}\nSUMMARY:Feed ${n}\nDTSTART;VALUE=DATE:20261025`));
    const results = await Promise.all([1, 2, 3, 4].map((n) => parseIcalFeedIsolated(text(n), TZ, RANGE)));
    expect(results.map((r) => r.events[0]?.title)).toEqual(['Feed 1', 'Feed 2', 'Feed 3', 'Feed 4']);
  });
});
