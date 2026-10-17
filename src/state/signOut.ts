import { ApiError } from '../api/client';
import type { AuthClient, AuthStatus } from '../api/auth';

// Ending a parent session has two separate parts:
//   1. Locking this screen: the app stops treating the parent as signed in
//      (done immediately by the caller, whatever the server says). This only
//      hides the parent area; it is NOT access control.
//   2. Ending the session on the server, which is what actually removes the
//      parent's rights. Only a successful answer from the server confirms it.
// This module does part 2 and reports honestly whether it was confirmed.

export type SignOutOutcome =
  | { confirmed: true; status: AuthStatus }
  | { confirmed: false; message: string };

export const UNCONFIRMED_PREFIX = 'Couldn’t confirm sign-out with the family server';

/** Ask the server to end this browser's parent session. Never throws. */
export async function confirmSignOut(client: AuthClient, previous: AuthStatus): Promise<SignOutOutcome> {
  try {
    await client.logout();
  } catch (e) {
    const reason = e instanceof ApiError ? e.message : 'Something went wrong.';
    return { confirmed: false, message: `${UNCONFIRMED_PREFIX}. ${reason}` };
  }
  // The server answered OK, so the session is gone. Re-read the rest of the
  // state (e.g. whether this is a paired device). If that read fails we still
  // know the parent session ended.
  let status: AuthStatus;
  try {
    status = await client.status();
  } catch {
    return { confirmed: true, status: { ...previous, parent: null } };
  }
  if (status.parent) {
    return { confirmed: false, message: `${UNCONFIRMED_PREFIX}. It still reports a parent signed in on this device.` };
  }
  return { confirmed: true, status };
}
