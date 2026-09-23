import { describe, expect, it } from 'vitest';
import { GmailTransport } from './GmailTransport.js';
import { GmailProvider } from '../integrations/google/GmailProvider.js';
import type { InferenceTransport } from '../ai/types.js';
import type { OutboundDraft } from './outbound.js';

function harness(options: { connected?: boolean } = {}) {
  const sent: Array<{ path: string; body: unknown }> = [];
  const transport: InferenceTransport = {
    id: 'google',
    unavailableReason: () =>
      options.connected === false ? 'Gmail needs the desktop shell.' : null,
    hasCredential: () => true,
    request: async (request) => {
      sent.push({ path: request.path, body: request.body });
      return { id: 'sent_1' };
    },
  };

  const gmail = new GmailProvider({
    transport,
    account: () => (options.connected === false ? null : 'me@example.com'),
  });

  return { gmail, sent, mail: new GmailTransport(gmail) };
}

const draft = (over: Partial<OutboundDraft> = {}): OutboundDraft => ({
  id: 'out_1',
  kind: 'email',
  to: ['marlow@example.com'],
  subject: 'Thursday',
  body: 'Are we still on?',
  createdAt: 0,
  state: 'confirmed',
  cost: null,
  ...over,
});

/** The decoded message, so the assertions are about what Gmail receives. */
function decode(body: unknown): string {
  const raw = (body as { raw: string }).raw;
  const standard = raw.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(standard, 'base64').toString('utf8');
}

describe('sending through Gmail', () => {
  it('sends the confirmed draft, unchanged', async () => {
    const { mail, sent } = harness();
    await mail.send(draft());

    expect(sent[0]?.path).toBe('/gmail/v1/users/me/messages/send');
    const mime = decode(sent[0]?.body);
    expect(mime).toContain('To: marlow@example.com');
    expect(mime).toContain('Subject: Thursday');
    expect(mime).toContain('Are we still on?');
  });

  it('reports the mailbox as unavailable rather than failing at send time', () => {
    expect(harness({ connected: false }).mail.unavailableReason()).not.toBeNull();
    expect(harness().mail.unavailableReason()).toBeNull();
  });

  it('sends nothing at all when the mailbox is not connected', async () => {
    const { mail, sent } = harness({ connected: false });
    await expect(mail.send(draft())).rejects.toThrow();
    expect(sent).toEqual([]);
  });

  /**
   * The failure this refusal prevents: two people receive what reads as a
   * private message, neither knowing the other got it. Refused before
   * anything is sent, not halfway through.
   */
  it('refuses a draft naming several recipients, before sending to any of them', async () => {
    const { mail, sent } = harness();
    await expect(mail.send(draft({ to: ['a@example.com', 'b@example.com'] }))).rejects.toThrow(
      /separately/,
    );
    expect(sent).toEqual([]);
  });

  it('refuses a draft naming nobody', async () => {
    const { mail, sent } = harness();
    await expect(mail.send(draft({ to: [] }))).rejects.toThrow();
    expect(sent).toEqual([]);
  });
});

describe('header injection', () => {
  /**
   * A newline in a header ends it and starts another, which is how one
   * recipient quietly becomes a Bcc list. Both fields that reach a header are
   * checked, and the check is here rather than in the UI because the UI is
   * not the only caller.
   */
  it('refuses a line break in the recipient', async () => {
    const { gmail, sent } = harness();
    await expect(
      gmail.send({ to: 'a@example.com\r\nBcc: everyone@example.com', subject: 'x', body: 'y' }),
    ).rejects.toThrow(/line break/);
    expect(sent).toEqual([]);
  });

  it('refuses a line break in the subject', async () => {
    const { gmail, sent } = harness();
    await expect(
      gmail.send({ to: 'a@example.com', subject: 'x\nBcc: everyone@example.com', body: 'y' }),
    ).rejects.toThrow(/line break/);
    expect(sent).toEqual([]);
  });

  it('allows line breaks in the body, which is not a header', async () => {
    const { gmail, sent } = harness();
    await gmail.send({ to: 'a@example.com', subject: 'x', body: 'one\ntwo' });
    expect(decode(sent[0]?.body)).toContain('one\ntwo');
  });
});

describe('the owner-only reply path is untouched', () => {
  /**
   * `sendReply` exists so the phone relay can answer without a confirmation,
   * and it is safe only because it refuses every recipient but the owner.
   * Adding a general `send` next to it must not have loosened it.
   */
  it('still refuses any recipient but the owner', async () => {
    const { gmail, sent } = harness();
    await expect(
      gmail.sendReply({
        to: 'someone@example.com',
        ownerAddress: 'me@example.com',
        subject: 'x',
        body: 'y',
      }),
    ).rejects.toThrow();
    expect(sent).toEqual([]);
  });

  it('still sends to the owner', async () => {
    const { gmail, sent } = harness();
    await gmail.sendReply({
      to: 'me@example.com',
      ownerAddress: 'me@example.com',
      subject: 'x',
      body: 'y',
    });
    expect(sent).toHaveLength(1);
  });
});
