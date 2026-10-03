import type { KeyValueStore } from '../storage/KeyValueStore.js';

/**
 * Timers, alarms and stopwatches.
 *
 * ON WHERE THE TIME COMES FROM. Every one of these is stored as an absolute
 * moment - `endsAt`, `at`, `startedAt` - and compared against `Date.now()`.
 * None of them counts down. A decrementing counter drifts against the clock,
 * stops dead when the tab is throttled in the background, and loses the whole
 * interval when the machine sleeps; a timer set for ten minutes would ring
 * twenty minutes later with no sign anything had gone wrong. Against an
 * absolute moment, a throttled tab means the display updates late, and the
 * ring still happens at the right time or immediately on waking.
 *
 * ON WHAT THIS CANNOT DO, STATED RATHER THAN IMPLIED. An alarm here rings only
 * while Helix is running. There is no operating-system scheduling behind it,
 * so closing the app means the alarm does not sound - and a missed one is
 * reported as missed, with the time it was due, rather than being quietly
 * dropped or rung late as though nothing happened. `wouldSleepThrough` exists
 * so the interface can say this *before* someone relies on it for a morning.
 *
 * ON PERSISTENCE. Written through on every change, so a reload or a crash does
 * not lose a running timer. Absolute moments are what make that work: a timer
 * reloaded from disk needs no adjustment, because it never knew how long it
 * had left - only when it ends.
 */

const NAMESPACE = 'time';
const KEY = 'keepers';

export type KeeperKind = 'timer' | 'alarm' | 'stopwatch';

interface Base {
  id: string;
  label: string | null;
  /** When this was created, for ordering.  */
  createdAt: number;
}

export interface TimerRecord extends Base {
  kind: 'timer';
  /** What was asked for, kept so a reset can start it again. */
  durationMs: number;
  /** The moment it ends. Absolute, never a remaining count. */
  endsAt: number;
  /** Set while paused: how much was left at the moment it stopped. */
  pausedWithMs: number | null;
  /** True once it has run out and not yet been dismissed. */
  ringing: boolean;
}

export interface AlarmRecord extends Base {
  kind: 'alarm';
  /** The moment it is due. */
  at: number;
  ringing: boolean;
  /**
   * True when its moment passed while Helix was not running.
   *
   * Reported, not hidden. An alarm that did not sound is a failure the user
   * needs to know about, and silently ringing it hours late is worse.
   */
  missed: boolean;
}

export interface StopwatchRecord extends Base {
  kind: 'stopwatch';
  /** When the current run began, or null while paused. */
  runningSince: number | null;
  /** Time banked from previous runs. */
  elapsedBeforeMs: number;
}

export type KeeperRecord = TimerRecord | AlarmRecord | StopwatchRecord;

/** How long after it was due an alarm counts as missed rather than late. */
export const MISSED_AFTER_MS = 60_000;

/** Milliseconds on a stopwatch that is running now. */
export function stopwatchElapsed(record: StopwatchRecord, now: number): number {
  if (record.runningSince === null) return record.elapsedBeforeMs;
  return record.elapsedBeforeMs + Math.max(0, now - record.runningSince);
}

/** Milliseconds left on a timer, never below zero. */
export function timerRemaining(record: TimerRecord, now: number): number {
  if (record.pausedWithMs !== null) return record.pausedWithMs;
  return Math.max(0, record.endsAt - now);
}

/**
 * Would this alarm be slept through?
 *
 * True when it is due far enough ahead that the app will plausibly be closed
 * first. The interface uses this to say so when the alarm is set, which is the
 * only moment the warning is any use.
 */
export function wouldSleepThrough(at: number, now: number): boolean {
  // Four hours. Short enough that "a timer for tonight" is not nagged about,
  // long enough to catch the case this is actually for: an alarm for the
  // morning, set the night before, by someone who is about to close the app.
  return at - now > 4 * 60 * 60 * 1000;
}

export interface TimeKeeperOptions {
  store: KeyValueStore;
  /** Injectable for tests. */
  now?: () => number;
  /** Called when something starts ringing, once per keeper. */
  onRing?: (record: KeeperRecord) => void;
}

export class TimeKeeper {
  readonly #store: KeyValueStore;
  readonly #now: () => number;
  readonly #onRing: ((record: KeeperRecord) => void) | undefined;

  #records: KeeperRecord[] = [];
  #listeners = new Set<() => void>();
  #loaded = false;
  #sequence = 0;

  constructor(options: TimeKeeperOptions) {
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#onRing = options.onRing;
  }

  /**
   * Read what was running before.
   *
   * Timers whose moment passed while Helix was closed come back ringing, and
   * alarms come back marked missed if their moment is well past. Both are
   * surfaced rather than cleaned up: the user asked for something to happen at
   * a time, and whether it did is information they are owed.
   */
  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;

    /**
     * A broken store costs the timers, not the session.
     *
     * This threw, and the kernel awaits it during startup - so a storage
     * failure took Helix down at boot instead of costing it the one feature
     * that needs storage. Nothing here is important enough to refuse to
     * start over: an empty list is the honest state when nothing can be
     * read, and `#announce` already swallows the matching write failure.
     */
    let stored: KeeperRecord[] | undefined;
    try {
      stored = await this.#store.get<KeeperRecord[]>(NAMESPACE, KEY);
    } catch {
      stored = undefined;
    }
    this.#records = Array.isArray(stored) ? stored : [];

    const now = this.#now();
    for (const record of this.#records) {
      if (record.kind === 'timer' && record.pausedWithMs === null && record.endsAt <= now) {
        record.ringing = true;
      }
      if (record.kind === 'alarm' && record.at <= now && !record.ringing) {
        // Just gone off: ring it. Long past: say it was missed.
        if (now - record.at > MISSED_AFTER_MS) record.missed = true;
        else record.ringing = true;
      }
    }

    this.#announce();
  }

  list(): readonly KeeperRecord[] {
    return this.#records;
  }

  /** Subscribe to any change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Check the clock and ring anything due.
   *
   * Called from the UI's frame loop and safe to call as often as anyone likes:
   * it only acts on a transition, so nothing fires twice.
   */
  tick(): void {
    const now = this.#now();
    let changed = false;

    for (const record of this.#records) {
      if (record.kind === 'timer') {
        if (!record.ringing && record.pausedWithMs === null && record.endsAt <= now) {
          record.ringing = true;
          changed = true;
          this.#onRing?.(record);
        }
      } else if (record.kind === 'alarm') {
        if (!record.ringing && !record.missed && record.at <= now) {
          record.ringing = true;
          changed = true;
          this.#onRing?.(record);
        }
      }
    }

    if (changed) this.#announce();
  }

  #id(kind: KeeperKind): string {
    this.#sequence += 1;
    return `${kind}-${this.#now().toString(36)}-${this.#sequence}`;
  }

  startTimer(durationMs: number, label: string | null = null): TimerRecord {
    const now = this.#now();
    const record: TimerRecord = {
      kind: 'timer',
      id: this.#id('timer'),
      label,
      createdAt: now,
      durationMs,
      endsAt: now + durationMs,
      pausedWithMs: null,
      ringing: false,
    };
    this.#records = [...this.#records, record];
    this.#announce();
    return record;
  }

  setAlarm(at: number, label: string | null = null): AlarmRecord {
    const record: AlarmRecord = {
      kind: 'alarm',
      id: this.#id('alarm'),
      label,
      createdAt: this.#now(),
      at,
      ringing: false,
      missed: false,
    };
    this.#records = [...this.#records, record];
    this.#announce();
    return record;
  }

  startStopwatch(label: string | null = null): StopwatchRecord {
    const now = this.#now();
    const record: StopwatchRecord = {
      kind: 'stopwatch',
      id: this.#id('stopwatch'),
      label,
      createdAt: now,
      runningSince: now,
      elapsedBeforeMs: 0,
    };
    this.#records = [...this.#records, record];
    this.#announce();
    return record;
  }

  /**
   * Pause a timer or a stopwatch.
   *
   * A paused timer banks what was left rather than keeping its end moment,
   * because the end moment is meaningless once the clock keeps going without
   * it. Resuming computes a fresh one.
   */
  pause(id: string): KeeperRecord | null {
    const record = this.#find(id);
    if (!record) return null;
    const now = this.#now();

    if (record.kind === 'timer' && record.pausedWithMs === null && !record.ringing) {
      record.pausedWithMs = timerRemaining(record, now);
      this.#announce();
      return record;
    }
    if (record.kind === 'stopwatch' && record.runningSince !== null) {
      record.elapsedBeforeMs = stopwatchElapsed(record, now);
      record.runningSince = null;
      this.#announce();
      return record;
    }
    // Already paused, or an alarm, which has nothing to pause.
    return null;
  }

  resume(id: string): KeeperRecord | null {
    const record = this.#find(id);
    if (!record) return null;
    const now = this.#now();

    if (record.kind === 'timer' && record.pausedWithMs !== null) {
      record.endsAt = now + record.pausedWithMs;
      record.pausedWithMs = null;
      this.#announce();
      return record;
    }
    if (record.kind === 'stopwatch' && record.runningSince === null) {
      record.runningSince = now;
      this.#announce();
      return record;
    }
    return null;
  }

  /** Back to the beginning, still running. */
  reset(id: string): KeeperRecord | null {
    const record = this.#find(id);
    if (!record) return null;
    const now = this.#now();

    if (record.kind === 'timer') {
      record.endsAt = now + record.durationMs;
      record.pausedWithMs = null;
      record.ringing = false;
      this.#announce();
      return record;
    }
    if (record.kind === 'stopwatch') {
      record.elapsedBeforeMs = 0;
      record.runningSince = now;
      this.#announce();
      return record;
    }
    return null;
  }

  /** Stop the noise without removing the record. */
  dismiss(id: string): KeeperRecord | null {
    const record = this.#find(id);
    if (!record) return null;

    if (record.kind === 'timer' && record.ringing) {
      // A rung timer has done its job; dismissing it clears it away.
      this.cancel(id);
      return record;
    }
    if (record.kind === 'alarm' && (record.ringing || record.missed)) {
      this.cancel(id);
      return record;
    }
    return null;
  }

  cancel(id: string): KeeperRecord | null {
    const record = this.#find(id);
    if (!record) return null;
    this.#records = this.#records.filter((entry) => entry.id !== id);
    this.#announce();
    return record;
  }

  /** Everything of one kind, newest last. */
  ofKind<K extends KeeperKind>(kind: K): ReadonlyArray<Extract<KeeperRecord, { kind: K }>> {
    return this.#records.filter(
      (record): record is Extract<KeeperRecord, { kind: K }> => record.kind === kind,
    );
  }

  /**
   * The one a bare command means.
   *
   * "Stop the timer" with one timer running is unambiguous. With several it is
   * not, and the caller is expected to ask rather than pick - so this answers
   * null for more than one, and the orchestrator turns that into a question.
   * Anything ringing wins outright, because that is plainly what is being
   * talked about.
   */
  theOnly<K extends KeeperKind>(kind: K): Extract<KeeperRecord, { kind: K }> | null {
    const all = this.ofKind(kind);
    const ringing = all.filter((record) => 'ringing' in record && record.ringing);
    if (ringing.length === 1) return ringing[0] as Extract<KeeperRecord, { kind: K }>;
    if (all.length === 1) return all[0] as Extract<KeeperRecord, { kind: K }>;
    return null;
  }

  #find(id: string): KeeperRecord | undefined {
    return this.#records.find((record) => record.id === id);
  }

  #announce(): void {
    // Written through on every change: a running timer must survive a reload,
    // and the write is small enough that batching it would only add a window
    // in which it is lost.
    void this.#store.set(NAMESPACE, KEY, this.#records).catch(() => undefined);
    for (const listener of this.#listeners) listener();
  }
}
