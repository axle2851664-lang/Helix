import type { KeyValueStore } from '../storage/KeyValueStore.js';
import type { Logger } from '../core/Logger.js';
import { HelixError } from '../core/HelixError.js';
import {
  BILLABLE_KINDS,
  OutboundError,
  blockedReason,
  cancel,
  confirm,
  draft,
  type DraftRequest,
  type OutboundDraft,
  type OutboundKind,
} from './outbound.js';

/**
 * The outbox, and the transports it does not yet have.
 *
 * Helix may now send and call. It still cannot, because nothing is connected -
 * a browser with `connect-src 'self'` cannot reach a mail server or a
 * telephony provider, and neither exists in this build regardless. So every
 * draft made here sits in the outbox, confirmed or not, waiting for a
 * transport.
 *
 * That is worth building before the transports rather than after. The gate,
 * the record and the refusals are the parts that must be right, and they are
 * far easier to get right while nothing can actually leave. When a transport
 * arrives it plugs in below and changes nothing about the rules.
 *
 * The audit trail is not optional. Anything that can send on someone's behalf
 * must leave a record of what it sent, when, and to whom - including the
 * things it refused to send and why.
 */

const NAMESPACE = 'outbound';

/** What a working provider must look like. None exists yet. */
export interface Transport {
  readonly kind: OutboundKind;
  readonly name: string;
  /** Why it cannot run now, or null when it can. */
  unavailableReason(): string | null;
  send(item: OutboundDraft): Promise<void>;
}

export interface OutboundManagerOptions {
  store: KeyValueStore;
  logger: Logger;
  transports?: readonly Transport[];
}

export class OutboundManager {
  readonly #store: KeyValueStore;
  readonly #logger: Logger;
  readonly #transports: readonly Transport[];
  #listeners = new Set<() => void>();

  constructor(options: OutboundManagerOptions) {
    this.#store = options.store;
    this.#logger = options.logger.child('outbound');
    this.#transports = options.transports ?? [];
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        this.#logger.error('An outbox listener threw.', error);
      }
    }
  }

  /**
   * Why a kind cannot be sent, or null when it can.
   *
   * Reported per kind rather than as one blanket answer, because "no mail
   * provider" and "no telephony provider" are different missing things with
   * different fixes.
   */
  transportBlocker(kind: OutboundKind): string | null {
    const transport = this.#transports.find((candidate) => candidate.kind === kind);
    if (!transport) {
      return `Nothing in Helix can ${kind === 'call' ? 'place a call' : `send ${kind}`} yet. No provider is connected, and this build cannot reach one.`;
    }
    return transport.unavailableReason();
  }

  async create(request: DraftRequest): Promise<OutboundDraft> {
    // Throws for a purchase, an empty body, or nobody to send to. Those are
    // refusals rather than failures, and the message says which.
    const item = draft(request);

    await this.#store.set(NAMESPACE, item.id, item);
    this.#logger.info('Draft created.', { id: item.id, kind: item.kind, to: item.to.length });
    this.#notify();

    return item;
  }

  async get(id: string): Promise<OutboundDraft | undefined> {
    return this.#store.get<OutboundDraft>(NAMESPACE, id);
  }

  async list(): Promise<OutboundDraft[]> {
    const entries = await this.#store.entries<OutboundDraft>(NAMESPACE);
    return entries.map(([, item]) => item).sort((a, b) => b.createdAt - a.createdAt);
  }

  async pending(): Promise<OutboundDraft[]> {
    return (await this.list()).filter((item) => item.state === 'drafted');
  }

  async #require(id: string): Promise<OutboundDraft> {
    const item = await this.get(id);
    if (!item) throw new HelixError('NOT_FOUND', 'That draft no longer exists.');
    return item;
  }

  /** Confirm one draft, by id. There is deliberately no confirm-all. */
  async confirm(id: string, now: number = Date.now()): Promise<OutboundDraft> {
    const item = await this.#require(id);

    let confirmed: OutboundDraft;
    try {
      confirmed = confirm(item, now);
    } catch (error) {
      throw new HelixError(
        'VALIDATION_FAILED',
        error instanceof OutboundError ? error.message : 'That could not be confirmed.',
      );
    }

    await this.#store.set(NAMESPACE, id, confirmed);
    this.#logger.info('Draft confirmed.', { id });
    this.#notify();

    return confirmed;
  }

  async cancel(id: string, reason?: string): Promise<OutboundDraft> {
    const item = await this.#require(id);
    const cancelled = cancel(item, reason);

    await this.#store.set(NAMESPACE, id, cancelled);
    this.#logger.info('Draft cancelled.', { id });
    this.#notify();

    return cancelled;
  }

  /**
   * Hand a confirmed draft to its transport.
   *
   * Every refusal below is checked again here rather than trusted from the
   * caller. The screen that confirms and the code that sends are far apart,
   * and the whole value of the gate is that it cannot be walked around.
   */
  async dispatch(id: string, now: number = Date.now()): Promise<OutboundDraft> {
    const item = await this.#require(id);

    const blocked = blockedReason(item, now);
    if (blocked !== null) {
      throw new HelixError('VALIDATION_FAILED', blocked);
    }

    const transportProblem = this.transportBlocker(item.kind);
    if (transportProblem !== null) {
      // Not a failure of the draft: it stays confirmed and waiting, because
      // the draft is fine and the world is not.
      throw new HelixError('PROVIDER_NOT_CONFIGURED', transportProblem);
    }

    const transport = this.#transports.find((candidate) => candidate.kind === item.kind);
    if (!transport) {
      throw new HelixError('PROVIDER_NOT_CONFIGURED', this.transportBlocker(item.kind) ?? '');
    }

    try {
      await transport.send(item);
    } catch (error) {
      const failed: OutboundDraft = {
        ...item,
        state: 'failed',
        settledAt: now,
        reason: error instanceof Error ? error.message : 'The provider refused it.',
      };
      await this.#store.set(NAMESPACE, id, failed);
      this.#logger.error('Send failed.', { id, error });
      this.#notify();

      throw new HelixError('INTERNAL', `That could not be sent: ${failed.reason}`);
    }

    const sent: OutboundDraft = { ...item, state: 'sent', settledAt: now };
    await this.#store.set(NAMESPACE, id, sent);

    // The record of what left, kept because anything that can send on
    // someone's behalf owes them an account of what it sent.
    this.#logger.info('Sent.', {
      id,
      kind: sent.kind,
      to: sent.to.length,
      billable: BILLABLE_KINDS.has(sent.kind),
    });
    this.#notify();

    return sent;
  }
}
