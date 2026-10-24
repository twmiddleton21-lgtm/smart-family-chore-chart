import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { createCalendarConnectionClient, type CalendarConnectionClient } from '../../api/calendarConnection';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import {
  CONNECTION_PROBLEMS,
  REFRESH_PROBLEMS,
  type CalendarChoice,
  type CalendarConnectionStatus,
  type ConnectionSummary,
  type FeedCheck,
} from '../../lib/calendar';
import { useToast } from '../../state/toast';

// Parent area → Settings → Integrations → Family calendar (server builds).
// One connection for the whole family, made in one of two ways:
// - Google Calendar sign-in (OAuth, recommended), or
// - a private iCal address (no Google Cloud setup needed).
// Whichever parent connects it, every parent and paired device then sees
// the same calendar. Switching method replaces the old connection only
// after the new one has been checked and the parent has confirmed.

export type CardLoad = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; status: CalendarConnectionStatus };
export type CalendarList = { state: 'idle' } | { state: 'loading' } | { state: 'ready'; calendars: CalendarChoice[] } | { state: 'error'; message: string };
/** The iCal form. The typed address is cleared as soon as the server has checked it. */
export interface FeedForm {
  open: boolean;
  url: string;
  check: FeedCheck | null;
  error: string | null;
}
type Confirm = null | { kind: 'disconnect' } | { kind: 'google'; replaces: ConnectionSummary } | { kind: 'feed'; check: FeedCheck; replaces: ConnectionSummary };

const defaultClient = createCalendarConnectionClient();
const dateTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const messageOf = (error: unknown) => (error instanceof ApiError ? error.message : 'Something went wrong. Please try again.');
const METHOD_NAMES = { google: 'Google Calendar sign-in', ical: 'calendar address (iCal)' } as const;
const CLOSED_FORM: FeedForm = { open: false, url: '', check: null, error: null };

/** The server asks for confirmation (409 confirm_replace) when the family's connection changed meanwhile. */
function replacesFrom(error: unknown): ConnectionSummary | null {
  return error instanceof ApiError && error.body?.error === 'confirm_replace' ? ((error.body.replaces as ConnectionSummary | undefined) ?? null) : null;
}

export function CalendarConnectionCard({ client = defaultClient }: { client?: CalendarConnectionClient }) {
  const notify = useToast();
  const [load, setLoad] = useState<CardLoad>({ state: 'loading' });
  const [list, setList] = useState<CalendarList>({ state: 'idle' });
  const [feed, setFeed] = useState<FeedForm>(CLOSED_FORM);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const refresh = useCallback(async () => {
    try {
      setLoad({ state: 'ready', status: await client.status() });
    } catch (error) {
      setLoad({ state: 'error', message: messageOf(error) });
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const status = load.state === 'ready' ? load.status : null;

  const goToGoogle = async (replace: boolean) => {
    setConfirm(null);
    setBusy(true);
    try {
      // Off to Google's consent page; Google sends the browser back to the app.
      window.location.assign(await client.connectGoogle(window.location.origin, replace));
    } catch (error) {
      setBusy(false);
      const replaces = replacesFrom(error);
      if (replaces) setConfirm({ kind: 'google', replaces });
      else notify(messageOf(error), 'error');
    }
  };

  const connectGoogle = () => {
    const c = status?.connection;
    // Reconnecting Google replaces nothing; replacing an iCal address is confirmed first.
    if (c?.method === 'ical') setConfirm({ kind: 'google', replaces: { method: 'ical', label: `${c.providerName} address (${c.host})`, calendarName: c.calendarName } });
    else void goToGoogle(false);
  };

  const loadCalendars = async () => {
    setList({ state: 'loading' });
    try {
      setList({ state: 'ready', calendars: await client.calendars() });
    } catch (error) {
      setList({ state: 'error', message: messageOf(error) });
      void refresh(); // e.g. the connection turned out to be revoked
    }
  };

  const select = async (calendarId: string) => {
    setBusy(true);
    try {
      await client.selectCalendar(calendarId);
      notify('Family calendar changed. Every family device shows it now.');
      setList({ state: 'idle' });
      await refresh();
    } catch (error) {
      notify(messageOf(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const checkFeed = async () => {
    setBusy(true);
    try {
      const check = await client.checkFeed(feed.url);
      // The server keeps the address now; the browser forgets it.
      setFeed({ open: true, url: '', check, error: null });
    } catch (error) {
      setFeed((f) => ({ ...f, check: null, error: messageOf(error) }));
    } finally {
      setBusy(false);
    }
  };

  const applyFeed = async (check: FeedCheck, replace: boolean) => {
    if (check.replaces && !replace) return setConfirm({ kind: 'feed', check, replaces: check.replaces });
    setConfirm(null);
    setBusy(true);
    try {
      const r = await client.useFeed(check.checkId, replace);
      notify(
        r.replaced === 'google' && !r.revokedAtGoogle
          ? 'Calendar address connected for the whole family. Google couldn’t be told about the old connection, so you may also want to remove access at myaccount.google.com/permissions.'
          : 'Calendar address connected. The whole family can now see it.',
      );
      setFeed(CLOSED_FORM);
      setList({ state: 'idle' });
      await refresh();
    } catch (error) {
      const replaces = replacesFrom(error);
      if (replaces) setConfirm({ kind: 'feed', check: { ...check, replaces }, replaces });
      else setFeed((f) => ({ ...f, check: null, error: messageOf(error) }));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setConfirm(null);
    setBusy(true);
    try {
      if (status?.connection?.method === 'ical') {
        await client.disconnectFeed();
        notify('Calendar address removed. The family calendar is no longer shown. To stop the address working anywhere, reset it at your calendar provider.', 'info');
      } else {
        const r = await client.disconnectGoogle();
        notify(
          r.revokedAtGoogle || !r.wasConnected
            ? 'Google Calendar disconnected. The family calendar is no longer shown.'
            : 'Google Calendar disconnected here. Google couldn’t be told, so you may also want to remove access at myaccount.google.com/permissions.',
          'info',
        );
      }
      setList({ state: 'idle' });
      setFeed(CLOSED_FORM);
      await refresh();
    } catch (error) {
      notify(messageOf(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <CalendarConnectionCardView
        load={load}
        list={list}
        feed={feed}
        busy={busy}
        appOrigin={typeof window === 'undefined' ? '' : window.location.origin}
        onRetry={() => void refresh()}
        onConnectGoogle={connectGoogle}
        onLoadCalendars={() => void loadCalendars()}
        onSelect={(id) => void select(id)}
        onDisconnect={() => setConfirm({ kind: 'disconnect' })}
        onFeedOpen={(open) => setFeed({ ...CLOSED_FORM, open })}
        onFeedUrl={(url) => setFeed((f) => ({ ...f, url, error: null }))}
        onFeedCheck={() => void checkFeed()}
        onFeedUse={(check) => void applyFeed(check, false)}
      />
      {confirm?.kind === 'disconnect' && status?.connection && (
        <ConfirmDialog title="Disconnect the family calendar?" confirmLabel="Disconnect" tone="danger" onConfirm={() => void disconnect()} onCancel={() => setConfirm(null)}>
          <p>
            The Family Calendar stops showing <strong>{status.connection.calendarName}</strong> on every family device, and this server forgets{' '}
            {status.connection.method === 'google' ? (
              <>
                its access to <strong>{status.connection.accountEmail}</strong>
              </>
            ) : (
              'the calendar address'
            )}
            .
          </p>
          <p>Nothing in the calendar itself is changed. You can connect again at any time.</p>
        </ConfirmDialog>
      )}
      {(confirm?.kind === 'google' || confirm?.kind === 'feed') && (
        <ConfirmDialog
          title="Replace the family calendar?"
          confirmLabel={confirm.kind === 'google' ? 'Continue to Google' : 'Replace it'}
          onConfirm={() => void (confirm.kind === 'google' ? goToGoogle(true) : applyFeed(confirm.check, true))}
          onCancel={() => setConfirm(null)}
        >
          <p>
            The family can have <strong>one</strong> calendar connection. This replaces the current one,{' '}
            <strong>{confirm.replaces.calendarName}</strong> via {METHOD_NAMES[confirm.replaces.method]} ({confirm.replaces.label}), on every family device.
          </p>
          <p>
            {confirm.kind === 'google'
              ? 'It is only replaced once Google confirms the new connection. If you cancel on Google’s page, the current calendar stays.'
              : `The new calendar, ${confirm.check.calendarName}, has been checked and works.`}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

interface ViewProps {
  load: CardLoad;
  list: CalendarList;
  feed: FeedForm;
  busy: boolean;
  appOrigin: string;
  onRetry: () => void;
  onConnectGoogle: () => void;
  onLoadCalendars: () => void;
  onSelect: (calendarId: string) => void;
  onDisconnect: () => void;
  onFeedOpen: (open: boolean) => void;
  onFeedUrl: (url: string) => void;
  onFeedCheck: () => void;
  onFeedUse: (check: FeedCheck) => void;
}

/** The card for a given state (no fetching; rendered directly by tests). */
export function CalendarConnectionCardView(props: ViewProps) {
  const { load, busy } = props;
  return (
    <section className="settings-card integration-card" aria-labelledby="family-calendar-title" aria-busy={load.state === 'loading' || busy}>
      <p className="integration-eyebrow">Integrations</p>
      <h2 className="section-subtitle" id="family-calendar-title">
        <span aria-hidden="true">📅</span> Family calendar
      </h2>
      <p className="muted">
        Show the family’s calendar on the Family Calendar page, on every family device. Read-only: this app never adds, changes or
        deletes events.
      </p>
      <CardBody {...props} />
    </section>
  );
}

function CardBody(props: ViewProps) {
  const { load, onRetry } = props;
  if (load.state === 'loading') return <p className="muted">Checking the calendar connection…</p>;
  if (load.state === 'error') {
    return (
      <div className="integration-problem" role="alert">
        <p>{load.message}</p>
        <button type="button" className="button button-secondary" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }

  const { status } = load;
  if (!status.google.available && !status.ical.available) {
    const missing = [...new Set([...status.ical.missing, ...status.google.missing])];
    return (
      <div className="integration-setup" role="status">
        <p>
          <strong>Not set up on this family server yet.</strong> Whoever runs the server needs to add a secret key (enough for a calendar
          address) and, for Google Calendar sign-in, a Google OAuth client, then restart it:
        </p>
        <ul className="plain-list">
          {missing.map((name) => (
            <li key={name}>
              <code>{name}</code>
            </li>
          ))}
        </ul>
        <p className="muted">Step-by-step instructions: docs/GOOGLE-CALENDAR.md in the app’s source code.</p>
      </div>
    );
  }

  return status.connection ? <ActiveConnection {...props} status={status} /> : <ChooseMethod {...props} status={status} />;
}

type WithStatus = ViewProps & { status: CalendarConnectionStatus };

function GoogleButton({ status, appOrigin, busy, onConnectGoogle, label, primary = true }: WithStatus & { label: string; primary?: boolean }) {
  const origin = status.google.connectOrigin;
  if (origin !== null && appOrigin !== origin) {
    return (
      <p className="integration-note" role="note">
        To {label.toLowerCase()}, open the app at{' '}
        <a href={origin} className="integration-link">
          {origin}
        </a>{' '}
        (the address registered with Google), sign in, and come back here.
      </p>
    );
  }
  return (
    <button type="button" className={`button ${primary ? 'button-primary' : 'button-secondary'}`} onClick={onConnectGoogle} disabled={busy}>
      {label}
    </button>
  );
}

function ChooseMethod(props: WithStatus) {
  const { status } = props;
  return (
    <div className="integration-body">
      <p>
        No calendar is connected. A parent connects it <strong>once</strong>, and it then works for every parent and family device. Choose
        one way:
      </p>
      <div className="integration-method">
        <h3 className="integration-method-title">1. Google Calendar sign-in (recommended)</h3>
        {status.google.available ? (
          <>
            <p>
              You’ll be taken to Google to sign in and allow <em>See your calendars</em>. You can then choose which of the account’s
              calendars to show, and access can be withdrawn in the Google account at any time.
            </p>
            <div className="button-row data-buttons">
              <GoogleButton {...props} label="Connect Google Calendar" />
            </div>
          </>
        ) : (
          <p className="muted">
            Not available on this server: it needs a Google OAuth client set up by whoever runs it (
            {status.google.missing.map((m, i) => (
              <span key={m}>
                {i > 0 && ', '}
                <code>{m}</code>
              </span>
            ))}
            ).
          </p>
        )}
      </div>
      <div className="integration-method">
        <h3 className="integration-method-title">{status.google.available ? '2. Or a calendar address (iCal)' : '2. A calendar address (iCal)'}</h3>
        {status.ical.available ? (
          <FeedFormView {...props} />
        ) : (
          <p className="muted">
            Not available on this server: it needs <code>SFCC_SECRET_KEY_FILE</code>.
          </p>
        )}
      </div>
    </div>
  );
}

function ActiveConnection(props: WithStatus) {
  const { status, list, busy, feed, onLoadCalendars, onSelect, onDisconnect, onFeedOpen } = props;
  const c = status.connection!;
  const problem = c.problem ? CONNECTION_PROBLEMS[c.method][c.problem] : null;
  const refreshProblem = status.refresh.lastError ? REFRESH_PROBLEMS[status.refresh.lastError] : null;
  return (
    <div className="integration-body">
      {c.status === 'needs_reconnect' ? (
        <p className="integration-problem" role="alert">
          ⚠️ {problem ?? 'This connection needs to be reconnected.'}
        </p>
      ) : (
        <p className="integration-ok" role="status">
          ✅ Connected for the whole family with {c.method === 'google' ? 'Google Calendar sign-in' : 'a calendar address (iCal)'}.
        </p>
      )}
      <dl className="integration-details">
        {c.method === 'google' ? (
          <div>
            <dt>Google account</dt>
            <dd>{c.accountEmail}</dd>
          </div>
        ) : (
          <div>
            <dt>Address</dt>
            <dd>
              {c.providerName} · {c.host} <span className="muted">(the full address stays secret on the family server)</span>
            </dd>
          </div>
        )}
        <div>
          <dt>Calendar shown</dt>
          <dd>{c.calendarName}</dd>
        </div>
        <div>
          <dt>Connected</dt>
          <dd>
            {dateTime.format(new Date(c.connectedAt))}
            {c.connectedBy ? ` by ${c.connectedBy}` : ''}
          </dd>
        </div>
        <div>
          <dt>Last refreshed</dt>
          <dd>{status.refresh.lastSuccessAt ? dateTime.format(new Date(status.refresh.lastSuccessAt)) : 'Not yet since the server started'}</dd>
        </div>
      </dl>
      {c.status === 'connected' && refreshProblem && (
        <p className="integration-note" role="note">
          {refreshProblem}
        </p>
      )}
      {c.method === 'ical' && (
        <p className="muted">
          Changes in the calendar appear here once the provider updates the address (Google can take several hours) and this server
          re-reads it (at most every 5 minutes).
        </p>
      )}

      {c.method === 'google' && c.status === 'connected' && <CalendarPicker list={list} busy={busy} onLoad={onLoadCalendars} onSelect={onSelect} />}

      <div className="button-row data-buttons">
        {c.method === 'google' && status.google.available && (
          <GoogleButton {...props} label={c.status === 'needs_reconnect' ? 'Reconnect Google Calendar' : 'Reconnect'} primary={c.status === 'needs_reconnect'} />
        )}
        {c.method === 'ical' && status.ical.available && !feed.open && (
          <button type="button" className={`button ${c.status === 'needs_reconnect' ? 'button-primary' : 'button-secondary'}`} onClick={() => onFeedOpen(true)} disabled={busy}>
            Enter a new address
          </button>
        )}
        <button type="button" className="button button-danger-outline" onClick={onDisconnect} disabled={busy}>
          Disconnect
        </button>
      </div>

      {/* Another address, or switching method. Nothing is replaced until it has been checked and confirmed. */}
      {status.ical.available && (c.method === 'google' || feed.open) && (
        <div className="integration-method">
          <h3 className="integration-method-title">{c.method === 'ical' ? 'Replace the calendar address' : 'Use a calendar address instead'}</h3>
          {feed.open ? (
            <FeedFormView {...props} />
          ) : (
            <div className="button-row data-buttons">
              <button type="button" className="button button-secondary" onClick={() => onFeedOpen(true)} disabled={busy}>
                Use a calendar address…
              </button>
            </div>
          )}
        </div>
      )}
      {c.method === 'ical' && status.google.available && (
        <div className="integration-method">
          <h3 className="integration-method-title">Switch to Google Calendar sign-in (recommended)</h3>
          <p>Google sign-in needs no secret address, and access can be withdrawn in the Google account. The current address stays until Google confirms.</p>
          <div className="button-row data-buttons">
            <GoogleButton {...props} label="Switch to Google Calendar" primary={false} />
          </div>
        </div>
      )}
    </div>
  );
}

function FeedFormView({ status, feed, busy, onFeedUrl, onFeedCheck, onFeedUse, onFeedOpen }: WithStatus) {
  const extra = status.ical.extraHosts;
  return (
    <div className="integration-body">
      <p className="integration-warning" role="note">
        <strong>⚠️ A secret calendar address works like a password.</strong> Anyone who has it can read the whole calendar. Paste it only
        here and don’t share it. This app never shows it again after it is saved. If it leaks, reset it at your calendar provider (Google
        Calendar: Settings → your calendar → Integrate calendar → Reset).
      </p>
      <p className="muted">
        Supported: Google Calendar’s <em>Secret address in iCal format</em>, published Outlook or Microsoft 365 calendars (ICS link),
        and public iCloud calendars (webcal://){extra.length ? `, plus addresses on ${extra.join(', ')}` : ''}.
      </p>
      {feed.check ? (
        <div className="integration-check" role="status">
          <p>
            ✅ Found <strong>{feed.check.calendarName}</strong> ({feed.check.providerName}, {feed.check.host}) with {feed.check.upcomingEvents}{' '}
            {feed.check.upcomingEvents === 1 ? 'event' : 'events'} in the next 7 days.
          </p>
          {feed.check.replaces && (
            <p>
              Using it replaces the current family calendar: <strong>{feed.check.replaces.calendarName}</strong> ({feed.check.replaces.label}).
            </p>
          )}
          <div className="button-row data-buttons">
            <button type="button" className="button button-primary" onClick={() => onFeedUse(feed.check!)} disabled={busy}>
              Use this calendar
            </button>
            <button type="button" className="button button-secondary" onClick={() => onFeedOpen(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <form
          className="field"
          onSubmit={(e) => {
            e.preventDefault();
            if (feed.url.trim()) onFeedCheck();
          }}
        >
          <label className="field-label" htmlFor="calendar-feed-url">
            Calendar address
          </label>
          <div className="food-add-row">
            <input
              id="calendar-feed-url"
              className="input"
              type="url"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
              value={feed.url}
              aria-invalid={feed.error ? true : undefined}
              aria-describedby={feed.error ? 'calendar-feed-error' : undefined}
              onChange={(e) => onFeedUrl(e.target.value)}
            />
            <button type="submit" className="button button-primary" disabled={busy || !feed.url.trim()}>
              {busy ? 'Checking…' : 'Check address'}
            </button>
          </div>
          {feed.error && (
            <p className="field-error" id="calendar-feed-error" role="alert">
              {feed.error}
            </p>
          )}
          <p className="field-hint">The address is checked first; nothing changes until you confirm.</p>
        </form>
      )}
    </div>
  );
}

function CalendarPicker({ list, busy, onLoad, onSelect }: { list: CalendarList; busy: boolean; onLoad: () => void; onSelect: (id: string) => void }) {
  const [choice, setChoice] = useState<string | null>(null);
  if (list.state === 'idle') {
    return (
      <div className="button-row data-buttons">
        <button type="button" className="button button-secondary" onClick={onLoad}>
          Choose a different calendar
        </button>
      </div>
    );
  }
  if (list.state === 'loading') return <p className="muted">Loading calendars from Google…</p>;
  if (list.state === 'error') {
    return (
      <div className="integration-problem" role="alert">
        <p>{list.message}</p>
        <button type="button" className="button button-secondary" onClick={onLoad}>
          Try again
        </button>
      </div>
    );
  }
  if (list.calendars.length === 0) return <p className="muted">This Google account has no calendars the app can read.</p>;
  const current = list.calendars.find((c) => c.selected)?.id ?? list.calendars[0]!.id;
  const value = choice ?? current;
  return (
    <div className="field">
      <label className="field-label" htmlFor="google-calendar-choice">
        Calendar to show
      </label>
      <div className="food-add-row">
        <select id="google-calendar-choice" className="select" value={value} onChange={(e) => setChoice(e.target.value)}>
          {list.calendars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.primary ? ' (main calendar)' : ''}
            </option>
          ))}
        </select>
        <button type="button" className="button button-primary" disabled={busy || value === current} onClick={() => onSelect(value)}>
          Show this calendar
        </button>
      </div>
    </div>
  );
}
