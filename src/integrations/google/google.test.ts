import { describe, expect, it } from 'vitest';
import {
  FULL_MAILBOX_SCOPE,
  REQUESTED_SCOPES,
  scopeParameter,
} from './scopes.js';
import { GmailProvider } from './GmailProvider.js';
import { BrowserInferenceTransport } from '../../ai/transport.js';
import type { InferenceTransport } from '../../ai/types.js';

const shellTransport = (handler: (path: string, body: unknown) => unknown): InferenceTransport => ({
  id: 'fake-shell',
  unavailableReason: () => null,
  hasCredential: () => true,
  request: async ({ path, body }) => handler(path, body),
});

describe('the scopes Helix asks for', () => {
  /**
   * The line this file exists to hold. `https://mail.google.com/` is one entry
   * that makes everything work and grants permanent unrestricted access to
   * every email the user has ever received.
   */
  it('never asks for the full mailbox', () => {
    expect(scopeParameter()).not.toContain(FULL_MAILBOX_SCOPE);
    for (const scope of REQUESTED_SCOPES) {
      expect(scope.url).not.toBe(FULL_MAILBOX_SCOPE);
    }
  });

  // A scope requested "in case" is a permission granted for nothing.
  it('does not ask to send mail, because nothing sends mail yet', () => {
    expect(scopeParameter()).not.toContain('gmail.send');
    expect(scopeParameter()).not.toContain('gmail.compose');
  });

  /**
   * Every scope has to justify itself in words. If the reason is hard to
   * write, that is the signal to drop the scope rather than to write something
   * vague - so the test insists on a real sentence.
   */
  it('makes every scope explain why it is present', () => {
    for (const scope of REQUESTED_SCOPES) {
      expect(scope.because.length, scope.url).toBeGreaterThan(20);
      expect(scope.grants.length, scope.url).toBeGreaterThan(20);
    }
  });

  // A scope is a ceiling, not a plan; where the two differ, say so.
  it('admits where a scope permits more than Helix will do', () => {
    const modify = REQUESTED_SCOPES.find((scope) => scope.url.includes('gmail.modify'));
    expect(modify?.alsoPermits).toContain('Deleting');
  });
});

describe('GmailProvider in a browser build', () => {
  const provider = new GmailProvider({ transport: new BrowserInferenceTransport() });

  /**
   * A refresh token is worse than an API key - it does not expire on its own
   * and it opens a mailbox. The browser refusal is the same wall inference
   * hits, for a stronger reason.
   */
  it('refuses, and names the shell as the fix', () => {
    const status = provider.status();
    expect(status.connected).toBe(false);
    expect(status.message).toContain('desktop shell');
  });

  /**
   * The most important test here. "I cannot see your mail" and "you have no
   * unread mail" are completely different answers, and returning an empty
   * summary would let a caller report the second when the first is true.
   */
  it('throws rather than returning an empty inbox', async () => {
    await expect(provider.unread()).rejects.toThrow(/desktop shell/);
  });

  it('will not mark anything read either', async () => {
    await expect(provider.markRead(['a'])).rejects.toThrow();
  });
});

describe('GmailProvider once connected', () => {
  const inbox = {
    resultSizeEstimate: 13,
    messages: [
      {
        id: 'm1',
        snippet: 'Security alert for your account',
        labelIds: ['UNREAD', 'INBOX'],
        payload: {
          headers: [
            { name: 'From', value: 'Google <no-reply@accounts.google.com>' },
            { name: 'Subject', value: 'Security alert' },
          ],
        },
      },
      {
        id: 'm2',
        snippet: 'Another one',
        labelIds: ['UNREAD'],
        payload: {
          headers: [
            { name: 'From', value: 'Google <no-reply@accounts.google.com>' },
            { name: 'Subject', value: 'Security alert' },
          ],
        },
      },
      {
        id: 'm3',
        snippet: 'Lunch?',
        labelIds: ['UNREAD'],
        payload: {
          headers: [{ name: 'From', value: 'Sam <sam@example.com>' }, { name: 'Subject', value: 'Lunch' }],
        },
      },
    ],
  };

  const connected = () =>
    new GmailProvider({
      transport: shellTransport(() => inbox),
      account: 'axle.2851664@gmail.com',
    });

  it('reports the count from Gmail rather than from the page it fetched', async () => {
    const summary = await connected().unread();
    // Three messages were returned; thirteen are unread. Reporting three would
    // be a page size dressed up as a total.
    expect(summary.total).toBe(13);
    expect(summary.messages).toHaveLength(3);
  });

  /**
   * "Most of them from Google security alerts" should be a measurement. This
   * is what makes that sentence true rather than an impression.
   */
  it('counts senders so a summary is evidence, not impression', async () => {
    const summary = await connected().unread();
    expect(summary.topSenders[0]).toEqual({ sender: 'Google', count: 2 });
  });

  /**
   * "Mark them all as read" is a sentence. Turning a sentence straight into an
   * unbounded mutation is how the wrong thousand messages get changed, so the
   * ids are explicit and the caller resolves them first.
   */
  it('marks only the ids it was given', async () => {
    let sent: unknown = null;
    const provider = new GmailProvider({
      transport: shellTransport((_path, body) => {
        sent = body;
        return {};
      }),
      account: 'a@b.com',
    });

    const result = await provider.markRead(['m1', 'm2']);

    expect(result.changed).toBe(2);
    expect(sent).toEqual({ ids: ['m1', 'm2'], removeLabelIds: ['UNREAD'] });
  });

  it('does nothing at all for an empty list', async () => {
    let called = false;
    const provider = new GmailProvider({
      transport: shellTransport(() => {
        called = true;
        return {};
      }),
      account: 'a@b.com',
    });

    expect((await provider.markRead([])).changed).toBe(0);
    expect(called).toBe(false);
  });

  // The API is not our type, and a missing header is not a crash.
  it('survives a message with no headers', async () => {
    const provider = new GmailProvider({
      transport: shellTransport(() => ({ messages: [{ id: 'x' }] })),
      account: 'a@b.com',
    });

    const summary = await provider.unread();
    expect(summary.messages[0]).toMatchObject({ id: 'x', from: '', subject: '' });
  });
});
