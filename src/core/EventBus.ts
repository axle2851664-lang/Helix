import { EventBus as TypedEventBus } from '@hx/core';
import type { HelixEventMap } from './events.js';

/**
 * Helix's event bus: the shared mechanism, bound to Helix's own catalogue.
 *
 * The bus itself lives in `@hx/core` and knows nothing about Helix. This file
 * is where the two meet, and it exists so that the catalogue stays here, with
 * the application that owns it. AXUM binds the same class to its own map and
 * the two cannot see each other's events — adding an AXUM event is not an edit
 * to Helix's catalogue, and a Helix event name is not in scope inside AXUM.
 *
 * Declared as a subclass rather than a type alias because `EventBus` is used
 * both as a value (`new EventBus()`) and as a type annotation across twenty-odd
 * files. A subclass satisfies both, so the extraction changed no call site.
 */
export class EventBus extends TypedEventBus<HelixEventMap> {}

export type { EventBusLogger, EventBusOptions, Unsubscribe } from '@hx/core';

/** Helix-bound handler type, for modules that name it explicitly. */
export type HelixEventHandler<K extends keyof HelixEventMap> = (
  payload: HelixEventMap[K],
) => void;
