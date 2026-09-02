/**
 * Exactly what Helix asks Google for, and what it deliberately does not.
 *
 * An OAuth consent screen is the one moment the user is asked to decide, and
 * it is answered once, quickly, years before the consequence. Whatever is
 * requested there is what Helix can do forever after - so the list is built
 * from what has actually been asked for rather than from what might be handy
 * later, and every entry carries the reason it is present.
 *
 * The temptation this file exists to resist is `https://mail.google.com/`,
 * the full-mailbox scope. It is one line, it makes everything work, and it
 * grants permanent unrestricted access to every email the user has ever
 * received - including password resets and bank statements - to a program
 * running on a laptop. The narrower scopes below do everything that has been
 * asked for.
 *
 * On `gmail.modify` specifically: it is the narrowest scope that can mark a
 * message read, which was in the worked example. It also permits deleting, and
 * that is not a licence to delete - `GmailProvider` exposes no delete at all,
 * and the confirmation rules apply on top. A scope is a ceiling, not a plan.
 */

export interface GoogleScope {
  url: string;
  /** What it lets Helix do, in plain words. */
  grants: string;
  /** Why Helix needs it. If this is ever hard to write, drop the scope. */
  because: string;
  /** What it also permits that Helix will not do. Null where nothing. */
  alsoPermits: string | null;
}

export const GMAIL_READ: GoogleScope = {
  url: 'https://www.googleapis.com/auth/gmail.readonly',
  grants: 'Read your mail: message lists, subjects, senders and bodies.',
  because: 'Answering "what is unread" and reading the relay mailbox both need it.',
  alsoPermits: null,
};

export const GMAIL_MODIFY: GoogleScope = {
  url: 'https://www.googleapis.com/auth/gmail.modify',
  grants: 'Change labels on your mail - marking read, archiving, starring.',
  because: 'Marking messages read, and marking a relay command as handled.',
  alsoPermits:
    'Deleting messages. Helix exposes no way to delete mail, and this scope is not a plan to add one.',
};

export const CALENDAR_READ: GoogleScope = {
  url: 'https://www.googleapis.com/auth/calendar.readonly',
  grants: 'Read your calendars and events.',
  because: 'Answering what is on today, which the briefing already asks for.',
  alsoPermits: null,
};

/**
 * Sending, added when a feature finally needed it.
 *
 * This was deliberately absent, with a note saying it would go in "when a
 * feature needs it, alongside the confirmation flow that governs it". Helix
 * answering the phone is that feature, and this is that moment - so the rule
 * comes with it rather than after it.
 *
 * The standing rule is that nothing leaves without the user seeing the exact
 * draft and agreeing to that specific one. A reply to a question the user
 * asked thirty seconds ago, sent to nobody but themselves, is the one case
 * where that would be absurd - so the permission is narrowed in code instead:
 * `sendReply` refuses every recipient except the configured owner address, and
 * a test asserts it. Mail to anyone else still goes through confirmation.
 */
export const GMAIL_SEND: GoogleScope = {
  url: 'https://www.googleapis.com/auth/gmail.send',
  grants: 'Send mail from your account, appearing as you.',
  because: 'Answering a question you asked from your phone, back to your own address.',
  alsoPermits:
    'Mailing anyone at all. Helix will only reply to the configured owner address; any other recipient needs your confirmation at the machine.',
};

export const REQUESTED_SCOPES: readonly GoogleScope[] = [
  GMAIL_READ,
  GMAIL_MODIFY,
  GMAIL_SEND,
  CALENDAR_READ,
];

/** The full-mailbox scope, named so a test can assert it is never requested. */
export const FULL_MAILBOX_SCOPE = 'https://mail.google.com/';

/** The space-separated string for the authorisation URL. */
export function scopeParameter(scopes: readonly GoogleScope[] = REQUESTED_SCOPES): string {
  return scopes.map((scope) => scope.url).join(' ');
}
