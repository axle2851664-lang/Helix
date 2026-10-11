export type Unsubscribe = () => void;

/**
 * The shape an event catalogue has to have. Keys are event names, values are
 * that event's payload type.
 *
 * Deliberately structural rather than a named import. This class used to type
 * itself directly against `HelixEventMap` - Helix's catalogue of 31 events,
 * covering projects, spatial mode, camera and 3D model generation. That was
 * correct while Helix was the only thing in the repository, and wrong the
 * moment this module became shared: AXUM would have been handed compile-time
 * knowledge of features it does not have, and adding an AXUM event would have
 * meant editing Helix's catalogue.
 *
 * So the map arrives as a type parameter and each application binds its own.
 * The mechanism lives here; the catalogue lives with the application that
 * owns it.
 *
 * The constraint is `object` rather than the more obvious
 * `Record<string, unknown>`, which does not work: a catalogue declared as an
 * `interface` has no implicit index signature and is therefore not assignable
 * to a `Record`, so both applications' real catalogues were rejected. `object`
 * accepts them and costs nothing in safety - payload types are still checked
 * through `Map[K]`, and an unknown event name is still a compile error.
 */
export type EventMap = object;

export type EventHandler<Map extends EventMap, K extends keyof Map> = (
  payload: Map[K],
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
export class EventBus<Map extends EventMap> {
  readonly #handlers = new globalThis.Map<keyof Map, Set<(payload: never) => void>>();
  readonly #logger: EventBusLogger | undefined;
  readonly #maxListeners: number;

  constructor(options: EventBusOptions = {}) {
    this.#logger = options.logger;
    this.#maxListeners = options.maxListenersPerEvent ?? DEFAULT_MAX_LISTENERS;
  }

  on<K extends keyof Map>(event: K, handler: EventHandler<Map, K>): Unsubscribe {
    let set = this.#handlers.get(event);
    if (!set) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    set.add(handler as (payload: never) => void);

    if (this.#maxListeners > 0 && set.size > this.#maxListeners) {
      this.#logger?.error(
        `EventBus: listener count for "${String(event)}" exceeded ${this.#maxListeners}; likely a subscription leak.`,
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
  once<K extends keyof Map>(event: K, handler: EventHandler<Map, K>): Unsubscribe {
    const unsubscribe = this.on(event, (payload) => {
      unsubscribe();
      handler(payload);
    });
    return unsubscribe;
  }

  off<K extends keyof Map>(event: K, handler: EventHandler<Map, K>): void {
    const set = this.#handlers.get(event);
    if (!set) return;
    set.delete(handler as (payload: never) => void);
    if (set.size === 0) this.#handlers.delete(event);
  }

  emit<K extends keyof Map>(event: K, payload: Map[K]): void {
    const set = this.#handlers.get(event);
    if (!set || set.size === 0) return;

    for (const handler of [...set]) {
      try {
        (handler as EventHandler<Map, K>)(payload);
      } catch (error) {
        this.#logger?.error(`EventBus: handler for "${String(event)}" threw.`, error);
      }
    }
  }

  listenerCount(event: keyof Map): number {
    return this.#handlers.get(event)?.size ?? 0;
  }

  /** Drop subscribers for one event, or all of them when called bare. */
  removeAll(event?: keyof Map): void {
    if (event === undefined) this.#handlers.clear();
    else this.#handlers.delete(event);
  }
}
