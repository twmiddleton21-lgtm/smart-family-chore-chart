import { greetingFor } from '../lib/dates';
import { useNow } from '../state/time';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

export function Clock({ familyName }: { familyName: string }) {
  const now = useNow(1000);
  return (
    <section className="clock-card" aria-label="Today">
      <p className="clock-greeting">
        {greetingFor(now)}, {familyName}!
      </p>
      <time className="clock-time" dateTime={now.toISOString()}>
        {timeFormat.format(now)}
      </time>
      <p className="clock-date">
        <span className="clock-weekday">{weekdayFormat.format(now)}</span>
        <span className="clock-day">{dateFormat.format(now)}</span>
      </p>
    </section>
  );
}
