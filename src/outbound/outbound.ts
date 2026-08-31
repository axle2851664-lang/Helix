/**
 * Things that leave the machine.
 *
 * The standing rule used to be that nothing did. That has changed: Helix may
 * send a message and place a call. What has not changed is that it may not
 * spend, and what is added here is the gate that makes the new permission
 * safe to hold.
 *
 * The shape of the rule is now "ask, then send" rather than "never send", and
 * the difference between those two is one confirmation step. So the step is
 * structural. Nothing here can be dispatched that was not first drafted,
 * shown, and confirmed by a specific act referring to that specific draft.
 *
 * Four properties, each of which exists because the obvious shortcut is worse:
 *
 * 1. **Confirmation is per draft.** There is no "always allow", no remembered
 *    approval, no trusted recipient. A standing permission is indistinguishable
 *    from no permission the first time it is wrong.
 *
 * 2. **Confirmation goes stale.** An approval given and then forgotten must not
 *    fire an hour later against a draft the user has stopped thinking about.
 *
 * 3. **A draft is immutable once confirmed.** Editing after approval would
 *    make the approval refer to something that no longer exists, which is the
 *    whole trick behind confirming one thing and sending another.
 *
 * 4. **Cost is stated, and unknown cost is stated as unknown.** A call costs
 *    money. Reporting zero because nothing was measured would turn "never
 *    spend" into a rule Helix breaks while believing it is keeping it.
 */

export type OutboundKind = 'email' | 'message' | 'calendar-invite' | 'call' | 'sms';

export type DraftState = 'drafted' | 'confirmed' | 'sent' | 'cancelled' | 'failed';

/**
 * What an action will cost.
 *
 * `null` means not measured. It never means free - a distinction the type
 * makes impossible to lose, because the two are different answers and only
 * one of them is safe to act on.
 */
export interface Cost {
  amount: number;
  currency: string;
  /** Where the figure came from. An unsourced number is a guess. */
  basis: string;
}

export interface OutboundDraft {
  id: string;
  kind: OutboundKind;
  /** Addresses, numbers or handles. Never resolved from a nickname silently. */
  to: readonly string[];
  subject?: string;
  body: string;
  createdAt: number;
  state: DraftState;
  /** Null when nothing has measured it. Not zero. */
  cost: Cost | null;
  /** Set when confirmed, so staleness can be judged. */
  confirmedAt?: number;
  /** Set once it has actually left, or failed to. */
  settledAt?: number;
  /** Why it failed, or why it was refused. */
  reason?: string;
}

export class OutboundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundError';
  }
}

/**
 * How long a confirmation stays good.
 *
 * Long enough to click send after reading it back, short enough that an
 * approval cannot resurface later attached to something forgotten.
 */
export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/** Kinds that cost money to perform on every provider worth using. */
export const BILLABLE_KINDS: ReadonlySet<OutboundKind> = new Set(['call', 'sms']);

/**
 * Words that mean the request is to spend, not to communicate.
 *
 * "Never spend" survives the change to "may send", and these are the requests
 * where the two collide. Buying something is not a message that happens to
 * cost money; it is a purchase, and it stays refused.
 */
const PURCHASE_PATTERNS = [
  /\b(?:buy|purchase|order|pay|paying|payment)\b/i,
  /\b(?:top ?up|topping up|recharge|add (?:credit|funds|money))\b/i,
  /\b(?:subscribe|subscription|upgrade (?:my |the )?(?:plan|account|tier))\b/i,
  /\b(?:transfer|send)\s+(?:£|\$|€)?\d/i,
  /\b(?:checkout|check ?out|place (?:an? )?order)\b/i,
];

/**
 * Is this request asking Helix to spend?
 *
 * Deliberately blunt and erring towards refusing. A false positive costs the
 * user one rephrase; a false negative spends their money.
 */
export function looksLikePurchase(text: string): boolean {
  return PURCHASE_PATTERNS.some((pattern) => pattern.test(text));
}

export interface DraftRequest {
  kind: OutboundKind;
  to: readonly string[];
  subject?: string;
  body: string;
  cost?: Cost | null;
  now?: number;
}

function newId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `out_${random}`;
}

/**
 * Create a draft.
 *
 * Refuses a request to spend, refuses one with nobody to send to, and refuses
 * an empty one. None of those is a message worth confirming, and all three are
 * easier to catch here than after a provider has been handed them.
 */
export function draft(request: DraftRequest): OutboundDraft {
  const haystack = `${request.subject ?? ''} ${request.body}`;

  if (looksLikePurchase(haystack)) {
    throw new OutboundError(
      'That reads as a request to spend money, which Helix will not do. It may send and it may call, but buying, paying and topping up are yours.',
    );
  }

  const recipients = request.to.map((entry) => entry.trim()).filter((entry) => entry !== '');
  if (recipients.length === 0) {
    throw new OutboundError('There is nobody to send that to.');
  }

  if (request.body.trim() === '') {
    throw new OutboundError('There is nothing to send.');
  }

  return {
    id: newId(),
    kind: request.kind,
    to: recipients,
    ...(request.subject !== undefined ? { subject: request.subject } : {}),
    body: request.body,
    createdAt: request.now ?? Date.now(),
    state: 'drafted',
    // Unmeasured is null, never zero. A billable kind with no figure says so.
    cost: request.cost ?? null,
  };
}

/** Confirm one specific draft. There is no bulk confirm, deliberately. */
export function confirm(item: OutboundDraft, now: number = Date.now()): OutboundDraft {
  if (item.state !== 'drafted') {
    throw new OutboundError(`That has already been ${item.state}.`);
  }
  return { ...item, state: 'confirmed', confirmedAt: now };
}

export function cancel(item: OutboundDraft, reason?: string): OutboundDraft {
  if (item.state === 'sent') {
    throw new OutboundError('That has already gone. It cannot be unsent.');
  }
  return {
    ...item,
    state: 'cancelled',
    ...(reason !== undefined ? { reason } : {}),
  };
}

/** True when an approval has gone stale and must be given again. */
export function confirmationExpired(item: OutboundDraft, now: number = Date.now()): boolean {
  if (item.state !== 'confirmed' || item.confirmedAt === undefined) return false;
  return now - item.confirmedAt > CONFIRMATION_TTL_MS;
}

/**
 * May this be handed to a transport?
 *
 * Returns the reason it may not, or null when it may. The order matters: the
 * most specific objection is reported first, so a user is told the actual
 * problem rather than the first one the code happened to notice.
 */
export function blockedReason(item: OutboundDraft, now: number = Date.now()): string | null {
  if (item.state === 'sent') return 'That has already been sent.';
  if (item.state === 'cancelled') return 'That was cancelled.';
  if (item.state === 'drafted') return 'That has not been confirmed yet.';
  if (item.state === 'failed') return 'That failed, and needs confirming again to retry.';

  if (confirmationExpired(item, now)) {
    return 'That confirmation has gone stale. Read it again and confirm if it still stands.';
  }
  return null;
}

/**
 * A sentence describing what is about to happen, for the confirmation.
 *
 * Recipients in full, never a count. "Send to 4 people" is exactly the shape
 * of confirmation someone approves without reading.
 */
export function describe(item: OutboundDraft): string {
  const verb =
    item.kind === 'call'
      ? 'Call'
      : item.kind === 'calendar-invite'
        ? 'Invite'
        : 'Send to';

  const cost =
    item.cost === null
      ? BILLABLE_KINDS.has(item.kind)
        ? ' This costs money, and nothing here has measured how much.'
        : ''
      : ` This costs ${item.cost.currency}${item.cost.amount.toFixed(2)}, ${item.cost.basis}.`;

  return `${verb} ${item.to.join(', ')}.${cost}`;
}
