import { ApiError } from '../api/client';
import type { AuthClient, AuthStatus } from '../api/auth';

// Ending a parent session has two separate parts:
//   1. Locking this screen: the app stops treating the parent as signed in
//      (done immediately by the caller, whatever the server says). This only
//      hides the parent area; it is NOT access control.
//   2. Ending the session on the server, which is what actually removes the
//      parent's rights. Only a successful answer from the server confirms it.
// This module does part 2 and reports honestly whether it was confirmed.
//
// A sign-out always names the session it is for (`previous.sessionId`, from
// when it started), and the server only ends that one. A retry that runs
// after the parent signed in again (in this or another tab: both share the
// browser's cookie) therefore can't end the newer session; it reports
// `superseded` instead.

export type SignOutOutcome =
  /** The session is no longer this browser's (`superseded`: a newer one is, and was left alone). */
  | { confirmed: true; status: AuthStatus; superseded?: true }
  | { confirmed: false; message: string };

export const UNCONFIRMED_PREFIX = 'Couldn’t confirm sign-out with the family server';

const unconfirmed = (reason: string): SignOutOutcome => ({ confirmed: false, message: `${UNCONFIRMED_PREFIX}. ${reason}` });

/** Ask the server to end the parent session `previous` describes. Never throws. */
export async function confirmSignOut(client: AuthClient, previous: AuthStatus): Promise<SignOutOutcome> {
  const target = previous.sessionId;
  if (target) {
    let result: string;
    try {
      result = await client.logout(target);
    } catch (e) {
      return unconfirmed(e instanceof ApiError ? e.message : 'Something went wrong.');
    }
    if (result === 'replaced') {
      // That session is no longer this browser's: signing in again ended it.
      return { confirmed: true, superseded: true, status: await statusOr(client, { ...previous, parent: null, sessionId: null }) };
    }
    // ended / not_signed_in: the server says this browser no longer holds it.
  }
  // Re-read the rest of the state (e.g. whether this is a paired device).
  let status: AuthStatus;
  try {
    status = await client.status();
  } catch {
    // Without a target we know nothing; with one, the server already confirmed.
    if (!target) return unconfirmed('Can’t reach the family server.');
    return { confirmed: true, status: { ...previous, parent: null, sessionId: null } };
  }
  if (!status.parent) return { confirmed: true, status };
  if (target && status.sessionId === target) {
    return unconfirmed('It still reports a parent signed in on this device.');
  }
  // A different (newer) session, or we never knew which one we were ending:
  // leave it alone and say so, never sign out a session we can't name.
  return { confirmed: true, superseded: true, status };
}

async function statusOr(client: AuthClient, fallback: AuthStatus): Promise<AuthStatus> {
  try {
    return await client.status();
  } catch {
    return fallback;
  }
}
