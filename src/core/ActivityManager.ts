import type { EventBus } from './EventBus.js';

/**
 * Tracks what Helix is actually doing, for the ACTIVE OPERATION panel.
 *
 * The whole value of this module is that it cannot be faked. Activities are
 * started and ended by the code that performs the work, using a token, so the
 * panel says "Thinking..." only while something is genuinely thinking. There is
 * no way to set a label without owning a real operation, and a caller that
 * forgets to end one leaves it visibly stuck rather than silently resetting -
 * which is the correct failure mode for a status display.
 */

export const ACTIVITY_KINDS = [
  'standing-by',
  'listening',
  'thinking',
  'searching',
  'opening-project',
  'loading-model',
  'analyzing-image',
  'generating',
  'speaking',
  'completed',
  'failed',
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface Activity {
  kind: ActivityKind;
  label: string;
  detail?: string;
  startedAt: number;
}

/** Handle returned when an activity begins. Ending it is the caller's job. */
export interface ActivityToken {
  readonly id: number;
  /** Update the detail line while the operation runs. */
  update(detail: string): void;
  /** Mark finished. Safe to call more than once. */
  end(outcome?: 'completed' | 'failed', detail?: string): void;
}

const DEFAULT_LABELS: Record<ActivityKind, string> = {
  'standing-by': 'Standing by',
  listening: 'Listening...',
  thinking: 'Thinking...',
  searching: 'Searching...',
  'opening-project': 'Opening project...',
  'loading-model': 'Loading model...',
  'analyzing-image': 'Analyzing image...',
  generating: 'Generating...',
  speaking: 'Speaking...',
  completed: 'Completed',
  failed: 'Failed',
};

const IDLE: Activity = { kind: 'standing-by', label: DEFAULT_LABELS['standing-by'], startedAt: 0 };

/** How long a terminal state lingers before falling back to standing by. */
const SETTLE_MS = 2500;

export type ActivityListener = (activity: Activity) => void;

export class ActivityManager {
  readonly #bus: EventBus | undefined;
  readonly #listeners = new Set<ActivityListener>();
  /** Stack, so a nested operation restores its parent when it ends. */
  #stack: Array<{ id: number; activity: Activity }> = [];
  #current: Activity = IDLE;
  #nextId = 1;
  #settleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(bus?: EventBus) {
    this.#bus = bus;
  }

  get current(): Activity {
    return this.#current;
  }

  get isBusy(): boolean {
    return this.#stack.length > 0;
  }

  begin(kind: ActivityKind, options: { label?: string; detail?: string } = {}): ActivityToken {
    const id = this.#nextId++;
    const activity: Activity = {
      kind,
      label: options.label ?? DEFAULT_LABELS[kind],
      startedAt: Date.now(),
      ...(options.detail !== undefined ? { detail: options.detail } : {}),
    };

    this.#clearSettle();
    this.#stack.push({ id, activity });
    this.#apply(activity);

    let ended = false;
    return {
      id,
      update: (detail: string) => {
        const entry = this.#stack.find((item) => item.id === id);
        if (!entry) return;
        entry.activity = { ...entry.activity, detail };
        // Only repaint if this is the operation currently on top.
        if (this.#stack[this.#stack.length - 1]?.id === id) this.#apply(entry.activity);
      },
      end: (outcome = 'completed', detail?: string) => {
        if (ended) return;
        ended = true;
        this.#end(id, outcome, detail);
      },
    };
  }

  #end(id: number, outcome: 'completed' | 'failed', detail?: string): void {
    const index = this.#stack.findIndex((item) => item.id === id);
    if (index === -1) return;
    const wasTop = index === this.#stack.length - 1;
    this.#stack.splice(index, 1);

    if (!wasTop) return;

    const parent = this.#stack[this.#stack.length - 1];
    if (parent) {
      this.#apply(parent.activity);
      return;
    }

    // Nothing left running: show the outcome briefly, then return to idle.
    this.#apply({
      kind: outcome,
      label: DEFAULT_LABELS[outcome],
      startedAt: Date.now(),
      ...(detail !== undefined ? { detail } : {}),
    });

    this.#settleTimer = setTimeout(() => {
      this.#settleTimer = null;
      if (this.#stack.length === 0) this.#apply(IDLE);
    }, SETTLE_MS);
  }

  #clearSettle(): void {
    if (this.#settleTimer !== null) {
      clearTimeout(this.#settleTimer);
      this.#settleTimer = null;
    }
  }

  #apply(activity: Activity): void {
    this.#current = activity;
    for (const listener of [...this.#listeners]) {
      try {
        listener(activity);
      } catch {
        // A broken status listener must not disturb the work being tracked.
      }
    }
    this.#bus?.emit('ACTIVITY_CHANGED', {
      kind: activity.kind,
      label: activity.label,
      ...(activity.detail !== undefined ? { detail: activity.detail } : {}),
    });
  }

  subscribe(listener: ActivityListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Wrap an async operation so the activity always ends, even on throw. */
  async track<T>(
    kind: ActivityKind,
    run: (token: ActivityToken) => Promise<T>,
    options: { label?: string; detail?: string } = {},
  ): Promise<T> {
    const token = this.begin(kind, options);
    try {
      const result = await run(token);
      token.end('completed');
      return result;
    } catch (error) {
      token.end('failed');
      throw error;
    }
  }

  /** Drop all state. Used on shutdown and by tests. */
  reset(): void {
    this.#clearSettle();
    this.#stack = [];
    this.#apply(IDLE);
  }
}
