/**
 * Google's OAuth failures, as sentences with a next step in them.
 *
 * The shell reports what Google said, which is right - it must not invent a
 * cause - but what Google says is written for whoever built the client, not
 * for the person trying to connect their own mail. "Google returned an error:
 * access_denied" is accurate and tells the user nothing they can do.
 *
 * Each entry below names the actual setting to change and where it lives. The
 * original message is always kept alongside, because a translation that turns
 * out to be the wrong guess must not hide the evidence.
 */

export interface GoogleProblem {
  /** What to do about it, or null when the raw message is the best available. */
  remedy: string | null;
}

const REMEDIES: ReadonlyArray<{ matches: RegExp; remedy: string }> = [
  {
    matches: /access_denied/i,
    remedy:
      'Google blocked the sign-in rather than Helix refusing it. While an app is on Testing, only accounts listed as test users may sign in: open console.cloud.google.com, pick this project, then APIs & Services → OAuth consent screen → Audience, and add your own address under Test users. This also happens if you pressed Cancel on the consent screen.',
  },
  {
    matches: /redirect_uri_mismatch/i,
    remedy:
      'The OAuth client is the wrong type. Helix listens on a loopback port that changes each time, which only a Desktop app client allows. In Google Cloud Console under Credentials, create an OAuth client ID of type "Desktop app" and use its id and secret here.',
  },
  {
    matches: /invalid_client|unauthorized_client/i,
    remedy:
      'Google did not recognise the client id or secret. Check both against the OAuth client in Google Cloud Console → Credentials - it is easy to paste the id twice, or to copy a client from a different project.',
  },
  {
    matches: /invalid_grant/i,
    remedy:
      'The authorisation expired before it was exchanged. Press Connect again and complete the consent screen without leaving it sitting.',
  },
  {
    // reqwest prints a status as "401 Unauthorized", not "401", so the
    // closing bracket is not adjacent to the digits. A test caught this.
    matches: /refused the authorisation code \(4\d\d/i,
    remedy:
      'Google rejected the exchange. The usual cause is a client secret that does not belong to the client id above, or a client of the wrong type - it must be a Desktop app client.',
  },
  {
    matches: /Timed out waiting for Google/i,
    remedy:
      'The consent page never came back. If no browser window opened, open one and try again; if you finished consent and nothing happened, a firewall may be blocking the local callback.',
  },
  {
    matches: /has not completed the Google verification|unverified/i,
    remedy:
      'This is the expected warning for an app on Testing status. Choose Advanced, then "Go to Helix (unsafe)" - it is your own app, on your own machine. You must also be listed as a test user.',
  },
];

export function googleProblem(message: string): GoogleProblem {
  const found = REMEDIES.find((entry) => entry.matches.test(message));
  return { remedy: found?.remedy ?? null };
}
