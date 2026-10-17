import type { DateKey } from '../src/types';

// The household's calendar date. Containers usually run in UTC, so "today"
// must be computed in the configured household time zone; otherwise an
// evening chore in (say) British Summer Time could land on the wrong day.

export function todayInZone(timeZone: string, now: Date = new Date()): DateKey {
  // en-CA formats as YYYY-MM-DD.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
