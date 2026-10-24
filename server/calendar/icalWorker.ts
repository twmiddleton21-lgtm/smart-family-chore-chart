import { parentPort, workerData } from 'node:worker_threads';
import { FeedParseError, parseIcalFeed } from './icalFeed';

// Worker thread for parseIcalFeedIsolated (icalFeed.ts): reads one feed and
// posts the events back. Started fresh for each feed, so the server can stop
// it (terminate) whatever the parser is doing. Never logs the feed.

const { text, timeZone, range } = workerData as { text: string; timeZone: string; range: { start: string; end: string } };

try {
  parentPort!.postMessage({ ok: true, feed: parseIcalFeed(text, timeZone, range) });
} catch (error) {
  parentPort!.postMessage({ ok: false, problem: error instanceof FeedParseError ? error.problem : 'not_ical' });
}
