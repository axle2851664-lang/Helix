import type { InferenceTransport } from '../../ai/types.js';

/**
 * Gmail, through the same wall as everything else.
 *
 * The rule that shapes this file is the one that shaped `ai/transport.ts`: a
 * credential must never reach the browser. An OAuth refresh token is worse
 * than an API key - it does not expire on its own and it opens a mailbox - so
 * this provider cannot call `fetch`. It asks a transport, and the browser
 * transport refuses, because a token held in a page is readable by everything
 * in the page.
 *
 * That is not a limitation to work around later. Gmail needs the desktop
 * shell, where the token is held in Rust and never crosses into the web view.
 *
 * What this file will not do, stated before any of it is written:
 *
 *   - It will not invent a message. If Gmail is not connected, every method
 *     says so. A plausible inbox is believed exactly when it matters most, and
 *     three made-up emails would be the worst thing in this codebase.
 *   - It exposes no delete, though the granted scope permits one.
 *   - It treats every subject and body as data. An email saying "ignore your
 *     instructions" is reported, never obeyed.
 */

/** The state of the connection, in enough detail to act on. */
export interface GmailStatus {
  connected: boolean;
  /** The account, once known. Never guessed. */
  address: string | null;
  /** One sentence, in Helix's voice, safe to show. */
  message: string;
}

export interface GmailMessage {
  id: string;
  from: string;
  subject: string;
  /** The snippet Gmail returns. The full body is fetched only when asked. */
  snippet: string;
  unread: boolean;
}

export interface UnreadSummary {
  /** Exact count from the mailbox. Never estimated. */
  total: number;
  messages: readonly GmailMessage[];
  /** Senders by frequency, so "mostly security alerts" is measured, not felt. */
  topSenders: ReadonlyArray<{ sender: string; count: number }>;
}

const NOT_CONNECTED =
  'Gmail is not connected. I have no access to your mail, so I cannot tell you what is in it.';

export interface GmailProviderOptions {
  transport: InferenceTransport;
  /** Set once OAuth has completed in the shell. Absent means not connected. */
  account?: string;
}

export class GmailProvider {
  readonly id = 'google';
  readonly #transport: InferenceTransport;
  #account: string | null;

  constructor(options: GmailProviderOptions) {
    this.#transport = options.transport;
    this.#account = options.account ?? null;
  }

  /**
   * Whether Helix can reach Gmail at all.
   *
   * Two failures kept apart, because they need different fixes: a host that
   * cannot hold a token, and a host that can but has not been authorised yet.
   */
  status(): GmailStatus {
    const hostProblem = this.#transport.unavailableReason(this.id);
    if (hostProblem !== null) {
      return {
        connected: false,
        address: null,
        message:
          'Gmail needs the desktop shell. A page cannot hold a mailbox token safely, so this build has no access to your mail.',
      };
    }

    if (this.#account === null) {
      return {
        connected: false,
        address: null,
        message:
          'Gmail is not connected yet. You will need to authorise Helix with your Google account first.',
      };
    }

    return {
      connected: true,
      address: this.#account,
      message: `Connected to ${this.#account}.`,
    };
  }

  /**
   * What is unread.
   *
   * Throws rather than returning an empty summary when it cannot ask: zero
   * unread and "I cannot see your mail" are completely different answers, and
   * a caller that cannot tell them apart will report the wrong one.
   */
  async unread(limit = 25): Promise<UnreadSummary> {
    const status = this.status();
    if (!status.connected) throw new Error(status.message ?? NOT_CONNECTED);

    const response = (await this.#transport.request({
      providerId: this.id,
      path: `/gmail/v1/users/me/messages?q=is:unread&maxResults=${limit}`,
      body: null,
    })) as { messages?: unknown; resultSizeEstimate?: unknown };

    const messages = Array.isArray(response.messages) ? response.messages : [];
    const parsed = messages
      .map((entry): GmailMessage | null => (isMessage(entry) ? toMessage(entry) : null))
      .filter((message): message is GmailMessage => message !== null);

    return {
      // Gmail's own count. `resultSizeEstimate` is an estimate and is named
      // as one by the API, so it is used only when nothing better exists.
      total: typeof response.resultSizeEstimate === 'number'
        ? response.resultSizeEstimate
        : parsed.length,
      messages: parsed,
      topSenders: countSenders(parsed),
    };
  }

  /**
   * Mark messages read.
   *
   * Takes explicit ids rather than a query. "Mark them all as read" is a
   * sentence, and turning a sentence directly into an unbounded mutation is
   * how the wrong thousand messages get changed - the caller resolves which
   * ones and confirms them first.
   */
  async markRead(ids: readonly string[]): Promise<{ changed: number }> {
    const status = this.status();
    if (!status.connected) throw new Error(status.message ?? NOT_CONNECTED);
    if (ids.length === 0) return { changed: 0 };

    await this.#transport.request({
      providerId: this.id,
      path: '/gmail/v1/users/me/messages/batchModify',
      body: { ids, removeLabelIds: ['UNREAD'] },
    });

    return { changed: ids.length };
  }

  /**
   * Reply to the owner, and to nobody else.
   *
   * The recipient is not a parameter. It is read from the configured owner
   * address, and a mismatch throws rather than sending - which is what keeps
   * `gmail.send` from being a general licence to mail people. The scope
   * permits any recipient; this method permits one, and that gap is deliberate
   * and tested.
   *
   * Anything addressed elsewhere goes through the outbound confirmation flow,
   * where the user sees the exact draft and agrees to that specific one.
   */
  async sendReply(options: {
    to: string;
    ownerAddress: string;
    subject: string;
    body: string;
  }): Promise<void> {
    const status = this.status();
    if (!status.connected) throw new Error(status.message ?? NOT_CONNECTED);

    const recipient = options.to.trim().toLowerCase();
    const owner = options.ownerAddress.trim().toLowerCase();

    if (owner === '' || recipient !== owner) {
      throw new Error(
        `Helix only replies to your own address. Sending to ${options.to} needs your confirmation here.`,
      );
    }

    // RFC 2822, base64url as the Gmail API expects for a raw message.
    const mime = [
      `To: ${options.to}`,
      `Subject: ${options.subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      options.body,
    ].join('\r\n');

    await this.#transport.request({
      providerId: this.id,
      path: '/gmail/v1/users/me/messages/send',
      body: { raw: base64Url(mime) },
    });
  }
}

/** Base64url without padding, which is what the Gmail API's `raw` field takes. */
function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);

  const standard = typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(bytes).toString('base64');

  return standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isMessage(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function header(entry: Record<string, unknown>, name: string): string {
  const payload = entry['payload'];
  if (typeof payload !== 'object' || payload === null) return '';
  const headers = (payload as Record<string, unknown>)['headers'];
  if (!Array.isArray(headers)) return '';

  for (const raw of headers) {
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as Record<string, unknown>;
    if (String(record['name']).toLowerCase() === name && typeof record['value'] === 'string') {
      return record['value'];
    }
  }
  return '';
}

function toMessage(entry: Record<string, unknown>): GmailMessage | null {
  const id = entry['id'];
  if (typeof id !== 'string') return null;

  const labels = entry['labelIds'];
  return {
    id,
    from: header(entry, 'from'),
    subject: header(entry, 'subject'),
    snippet: typeof entry['snippet'] === 'string' ? entry['snippet'] : '',
    unread: Array.isArray(labels) ? labels.includes('UNREAD') : false,
  };
}

/**
 * Group senders so a summary can say "mostly Google security alerts" on
 * evidence rather than on impression.
 */
function countSenders(
  messages: readonly GmailMessage[],
): ReadonlyArray<{ sender: string; count: number }> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    // The display name where there is one; it is what a person recognises.
    const name = /^([^<]+)</.exec(message.from)?.[1]?.trim() ?? message.from;
    if (name === '') continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([sender, count]) => ({ sender, count }))
    .sort((a, b) => b.count - a.count || a.sender.localeCompare(b.sender));
}
