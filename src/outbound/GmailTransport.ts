import type { GmailProvider } from '../integrations/google/GmailProvider.js';
import type { OutboundDraft, OutboundKind } from './outbound.js';
import type { Transport } from './OutboundManager.js';

/**
 * The first real transport.
 *
 * `OutboundManager` was written before any transport existed, with a note
 * saying the gate, the record and the refusals were the parts that had to be
 * right and were easier to get right while nothing could leave. This is the
 * moment that claim gets tested, and the test is that this file is boring:
 * it implements three members and decides nothing.
 *
 * In particular it does not confirm anything. Every draft reaching `send` has
 * already been drafted (which refuses a purchase, an empty body and an empty
 * recipient list), confirmed one at a time, and re-checked by `dispatch`
 * against the expiry and the transport blocker. A transport that re-asked
 * would be a second confirmation, and a transport that assumed would be a
 * hole. It does neither.
 *
 * One rule is enforced here because only here can it be: Gmail sends one
 * message at a time and a draft may name several recipients. Sending to each
 * separately would put a message in somebody's inbox with no sign of who else
 * received it, and sending only to the first would silently drop the rest. So
 * a multi-recipient draft is refused, and it is refused before anything has
 * been sent rather than halfway through.
 */
export class GmailTransport implements Transport {
  readonly kind: OutboundKind = 'email';
  readonly name = 'Gmail';

  readonly #gmail: GmailProvider;

  constructor(gmail: GmailProvider) {
    this.#gmail = gmail;
  }

  unavailableReason(): string | null {
    const status = this.#gmail.status();
    return status.connected ? null : status.message;
  }

  async send(item: OutboundDraft): Promise<void> {
    const blocker = this.unavailableReason();
    if (blocker !== null) throw new Error(blocker);

    if (item.to.length !== 1) {
      throw new Error(
        'Gmail sends one message to one recipient here. Send this to each person separately, so each of them can see who it went to.',
      );
    }

    const to = item.to[0];
    if (to === undefined) throw new Error('There is nobody to send that to.');

    await this.#gmail.send({
      to,
      subject: item.subject ?? '(no subject)',
      body: item.body,
    });
  }
}
