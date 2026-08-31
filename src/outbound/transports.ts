import type { OutboundKind } from './outbound.js';

/**
 * The ways Helix could actually send something, and what each one costs.
 *
 * Written as a decision record rather than as configuration, the same as the
 * Earth provider list, and for the same reason: the useful part is not the
 * list of names but what has and has not been verified about each.
 *
 * The question this file exists to answer honestly is "which of these are
 * free". One structural fact settles most of it, and it is worth stating
 * plainly because it is the thing people hope is not true:
 *
 *   **Reaching the public telephone network always costs money.** Somebody
 *   pays a carrier to terminate a call or a text on a real phone number. No
 *   provider gives that away, free tiers are trial credit that runs out, and a
 *   trial account is usually restricted to numbers you have already verified.
 *   There is no arrangement in which Helix rings an arbitrary phone for free.
 *
 * Messages are a different matter. A bot API or your own mailbox carries no
 * per-message charge, so "send" can be genuinely free in a way that "call"
 * cannot.
 *
 * Nothing here quotes a price or a trial allowance. Those change, I do not
 * know them to current accuracy, and a made-up figure in a file about money is
 * the worst possible place for one - somebody would plan around it.
 */

export type CostModel =
  /** No charge at all, for anyone. */
  | 'free'
  /** No per-message charge on an account you already pay for or hold. */
  | 'free-within-your-account'
  /** Free until a trial allowance runs out, then billed. */
  | 'trial-then-paid'
  /** Billed per use, always. */
  | 'always-paid';

export interface TransportOption {
  id: string;
  name: string;
  kinds: readonly OutboundKind[];
  cost: CostModel;
  /** One line on what it actually is. */
  summary: string;
  /** What must be held or set up first. */
  needs: readonly string[];
  /** Real limitations, including the ones that make it unsuitable. */
  limits: readonly string[];
  /** Facts not verified against the provider's current terms. */
  toConfirm: readonly string[];
}

export const TRANSPORT_OPTIONS: readonly TransportOption[] = [
  {
    id: 'smtp',
    name: 'Your own mailbox, over SMTP',
    kinds: ['email'],
    cost: 'free-within-your-account',
    summary:
      'Helix sends through the mail account you already have, so mail arrives from your real address.',
    needs: [
      'An app password or an OAuth token for the mailbox.',
      'The desktop shell. A browser cannot open an SMTP connection at all, and the credential must not sit in the page.',
    ],
    limits: [
      'Providers cap how many messages an account may send in a day. Exceeding it gets the account limited, not billed.',
      'Mail sent this way is indistinguishable from mail you sent yourself, which is the point and also the risk.',
    ],
    toConfirm: [
      'The current daily send limit for the mailbox you would use.',
      'Whether an app password is still offered, or whether OAuth is now required.',
    ],
  },
  {
    id: 'telegram',
    name: 'Telegram bot',
    kinds: ['message'],
    cost: 'free',
    summary: 'A bot you create sends messages and files to you or to a chat it has been added to.',
    needs: [
      'A bot token from BotFather, held outside the browser.',
      'The desktop shell, or any host that can reach an outside origin.',
    ],
    limits: [
      'A bot cannot message someone who has not started a chat with it first. This is deliberate on their part and cannot be worked around.',
      'It is Telegram only. It reaches people who use Telegram and nobody else.',
    ],
    toConfirm: [
      'Current rate limits per chat and in total.',
      'Whether the terms still permit this kind of personal-assistant use.',
    ],
  },
  {
    id: 'webhook',
    name: 'Slack or Discord webhook',
    kinds: ['message'],
    cost: 'free',
    summary: 'Posts into one channel you nominate. The simplest thing on this list by a wide margin.',
    needs: ['A webhook URL, which is itself the credential and must be held like one.'],
    limits: [
      'One channel per webhook, and it can only post. It cannot read replies or send to a person.',
      'Anyone holding the URL can post as you, so it is a secret despite looking like an address.',
    ],
    toConfirm: ['Current rate limits.'],
  },
  {
    id: 'twilio',
    name: 'Twilio',
    kinds: ['sms', 'call'],
    cost: 'trial-then-paid',
    summary: 'The usual answer for programmatic calls and texts to real phone numbers.',
    needs: [
      'An account, a card on file, and a purchased phone number to send from.',
      'The desktop shell, and credentials held well away from the browser.',
    ],
    limits: [
      'The free trial is credit, not a free tier. It runs down and then it bills.',
      'Trial accounts are normally restricted to numbers you have verified, and messages carry a trial notice. That makes it fine for testing and not for use.',
      'Renting the phone number is a recurring charge on its own, separate from what calls and texts cost.',
    ],
    toConfirm: [
      'The current trial credit and what it covers. I do not know this to present accuracy and will not guess at it.',
      'Per-minute and per-message rates for the countries you would call.',
      'The monthly cost of the number itself.',
    ],
  },
  {
    id: 'webrtc',
    name: 'Browser-to-browser call',
    kinds: ['call'],
    cost: 'free',
    summary:
      'A real voice call between two people running Helix, or Helix and a browser, carried directly between them.',
    needs: [
      'A signalling step, so the two ends can find each other. It carries no audio and can be very small.',
      'A STUN server, which is a trivial free service.',
    ],
    limits: [
      'It cannot ring a telephone. This calls another browser, and that is a different thing from what most people mean by a call.',
      'Some networks refuse a direct connection and need a relay to carry the audio. Relays cost money to run, so a call that falls back to one stops being free.',
    ],
    toConfirm: [
      'How often a relay is actually needed on the networks you use.',
      'Whether the signalling step can be small enough to be worth self-hosting.',
    ],
  },
];

/**
 * The structural fact, in one place.
 *
 * Asked for once by the code and once by the screen, so the two cannot come to
 * disagree about the single thing in this file most likely to be wished away.
 */
export const PSTN_TRUTH =
  'Reaching a real phone number always costs money. A carrier is paid to connect every call and every text, so no provider gives it away - free tiers are trial credit that runs out. Sending a message can be free; ringing a telephone cannot.';

export function optionsFor(kind: OutboundKind): TransportOption[] {
  return TRANSPORT_OPTIONS.filter((option) => option.kinds.includes(kind));
}

/**
 * The options that cost nothing beyond what you already hold.
 *
 * `free-within-your-account` counts, because a mailbox you already own charges
 * nothing per message. Trial credit does not count: it runs out, and something
 * that works until it silently stops is worse than something that never
 * started.
 */
export function freeOptionsFor(kind: OutboundKind): TransportOption[] {
  return optionsFor(kind).filter(
    (option) => option.cost === 'free' || option.cost === 'free-within-your-account',
  );
}

/** True when nothing free can do this at all. */
export function requiresPayment(kind: OutboundKind): boolean {
  return optionsFor(kind).length > 0 && freeOptionsFor(kind).length === 0;
}

/**
 * What Helix can honestly tell someone who asks whether this is free.
 *
 * Named per kind rather than answered once, because the true answer is
 * different for a message and for a call and flattening them would mislead in
 * whichever direction the summary went.
 */
export function costAnswer(kind: OutboundKind): string {
  const free = freeOptionsFor(kind);

  if (kind === 'sms') {
    return `Nothing free will send a text to a phone. ${PSTN_TRUTH}`;
  }

  if (kind === 'call') {
    return `A call between two browsers is free; ringing a telephone is not. ${PSTN_TRUTH}`;
  }

  if (free.length === 0) {
    return 'Nothing free is on the list for this yet.';
  }

  return `Free: ${free.map((option) => option.name).join(', ')}. Each needs setting up once, and each needs the desktop shell before it can reach anything.`;
}
