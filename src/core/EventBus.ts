import type { HavocEventMap, HavocEventName } from './events.js';

export type Unsubscribe = () => void;

export type HavocEventHandler<K extends HavocEventName> = (
  payload: HavocEventMap[K],
) => void;

/** Injected so the bus never reaches for a global logger (spec 22/33). */
export interface EventBusLogger {
  error(message: string, detail?: unknown): void;
}

export interface EventBusOptions {
  logger?: EventBusLogger;
  /** Guards against runaway subscription leaks. 0 disables the check. */
  maxListenersPerEvent?: number;
}

const DEFAULT_MAX_LISTENERS = 64;

/**
 * Typed synchronous publish/subscribe bus (spec 20).
 *
 * Design decisions worth knowing:
 *
 * - **A throwing handler cannot stop other handlers.** Each is invoked in its
 *   own try/catch. One broken subscriber must not take down camera teardown or
 *   a storage warning. Errors are reported to the logger, never swallowed
 *   silently (spec 23).
 *
 * - **Emit iterates a snapshot.** A handler may subscribe or unsubscribe during
 *   dispatch without corrupting the in-flight iteration.
 *
 * - **Dispatch is synchronous.** Callers that need async work should schedule it
 *   themselves; the bus stays predictable and easy to test.
 */
export class EventBus {
  readonly #handlers = new Map<HavocEventName, Set<(payload: never) => void>>();
  readonly #logger: EventBusLogger | undefined;
  readonly #maxListeners: number;

  constructor(options: EventBusOptions = {}) {
    this.#logger = options.logger;
    this.#maxListeners = options.maxListenersPerEvent ?? DEFAULT_MAX_LISTENERS;
  }

  on<K extends HavocEventName>(event: K, handler: HavocEventHandler<K>): Unsubscribe {
    let set = this.#handlers.get(event);
    if (!set) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    set.add(handler as (payload: never) => void);

    if (this.#maxListeners > 0 && set.size > this.#maxListeners) {
      this.#logger?.error(
        `EventBus: listener count for "${event}" exceeded ${this.#maxListeners}; likely a subscription leak.`,
      );
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.off(event, handler);
    };
  }

  /** Subscribe for exactly one dispatch, then auto-unsubscribe. */
  once<K extends HavocEventName>(event: K, handler: HavocEventHandler<K>): Unsubscribe {
    const unsubscribe = this.on(event, (payload) => {
      unsubscribe();
      handler(payload);
    });
    return unsubscribe;
  }

  off<K extends HavocEventName>(event: K, handler: HavocEventHandler<K>): void {
    const set = this.#handlers.get(event);
    if (!set) return;
    set.delete(handler as (payload: never) => void);
    if (set.size === 0) this.#handlers.delete(event);
  }

  emit<K extends HavocEventName>(event: K, payload: HavocEventMap[K]): void {
    const set = this.#handlers.get(event);
    if (!set || set.size === 0) return;

    for (const handler of [...set]) {
      try {
        (handler as HavocEventHandler<K>)(payload);
      } catch (error) {
        this.#logger?.error(`EventBus: handler for "${event}" threw.`, error);
      }
    }
  }

  listenerCount(event: HavocEventName): number {
    return this.#handlers.get(event)?.size ?? 0;
  }

  /** Drop subscribers for one event, or all of them when called bare. */
  removeAll(event?: HavocEventName): void {
    if (event === undefined) this.#handlers.clear();
    else this.#handlers.delete(event);
  }
}
