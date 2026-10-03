import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';
import {
  stopwatchElapsed,
  timerRemaining,
  TimeKeeper,
  wouldSleepThrough,
  type KeeperRecord,
} from './TimeKeeper.js';

const MINUTE = 60_000;

describe('TimeKeeper', () => {
  let clock: number;
  let store: MemoryKeyValueStore;
  const now = () => clock;

  beforeEach(() => {
    clock = 1_700_000_000_000;
    store = new MemoryKeyValueStore();
  });

  const keeper = (onRing?: (record: KeeperRecord) => void) =>
    new TimeKeeper(onRing ? { store, now, onRing } : { store, now });

  describe('timers', () => {
    /**
     * The behaviour the whole design is for. A counter that decrements drifts,
     * stops dead in a throttled tab, and loses the entire interval when the
     * machine sleeps - so a ten-minute timer rings twenty minutes late with no
     * sign anything went wrong. Against an absolute moment, time passing
     * unobserved is simply time passed.
     */
    it('rings on the clock even when nothing was watching', () => {
      const rung: string[] = [];
      const time = keeper((record) => rung.push(record.id));
      const timer = time.startTimer(10 * MINUTE);

      // Nothing ticks for the whole ten minutes, as if the tab were hidden.
      clock += 10 * MINUTE;
      time.tick();

      expect(rung).toEqual([timer.id]);
      expect(time.list()[0]).toMatchObject({ ringing: true });
    });

    it('does not ring twice, however often it is checked', () => {
      const rung: string[] = [];
      const time = keeper((record) => rung.push(record.id));
      time.startTimer(MINUTE);
      clock += MINUTE;

      time.tick();
      time.tick();
      time.tick();
      expect(rung).toHaveLength(1);
    });

    it('banks what is left when paused, and does not run down', () => {
      const time = keeper();
      const timer = time.startTimer(5 * MINUTE);

      clock += 2 * MINUTE;
      time.pause(timer.id);
      const paused = time.list()[0] as never as { pausedWithMs: number };
      expect(paused.pausedWithMs).toBe(3 * MINUTE);

      // An hour goes by while paused. Nothing is consumed.
      clock += 60 * MINUTE;
      expect(timerRemaining(time.list()[0] as never, clock)).toBe(3 * MINUTE);

      time.resume(timer.id);
      expect(timerRemaining(time.list()[0] as never, clock)).toBe(3 * MINUTE);
      clock += 3 * MINUTE;
      expect(timerRemaining(time.list()[0] as never, clock)).toBe(0);
    });

    it('does not ring while paused', () => {
      const rung: string[] = [];
      const time = keeper((record) => rung.push(record.id));
      const timer = time.startTimer(MINUTE);
      time.pause(timer.id);

      clock += 10 * MINUTE;
      time.tick();
      expect(rung).toEqual([]);
    });

    it('starts again from the top on reset', () => {
      const time = keeper();
      const timer = time.startTimer(5 * MINUTE);
      clock += 4 * MINUTE;
      time.reset(timer.id);
      expect(timerRemaining(time.list()[0] as never, clock)).toBe(5 * MINUTE);
    });

    it('clears a rung timer away when it is dismissed', () => {
      const time = keeper();
      const timer = time.startTimer(MINUTE);
      clock += MINUTE;
      time.tick();

      time.dismiss(timer.id);
      expect(time.list()).toHaveLength(0);
    });
  });

  describe('stopwatches', () => {
    it('counts the time that passed, not the times it was asked', () => {
      const time = keeper();
      time.startStopwatch();
      clock += 90_000;
      expect(stopwatchElapsed(time.list()[0] as never, clock)).toBe(90_000);
    });

    it('banks each run across a pause', () => {
      const time = keeper();
      const watch = time.startStopwatch();

      clock += 30_000;
      time.pause(watch.id);
      clock += 60_000;
      expect(stopwatchElapsed(time.list()[0] as never, clock)).toBe(30_000);

      time.resume(watch.id);
      clock += 10_000;
      expect(stopwatchElapsed(time.list()[0] as never, clock)).toBe(40_000);
    });

    it('goes back to zero and keeps running on reset', () => {
      const time = keeper();
      const watch = time.startStopwatch();
      clock += 45_000;
      time.reset(watch.id);
      expect(stopwatchElapsed(time.list()[0] as never, clock)).toBe(0);
      clock += 5_000;
      expect(stopwatchElapsed(time.list()[0] as never, clock)).toBe(5_000);
    });
  });

  describe('alarms', () => {
    it('rings at its moment', () => {
      const rung: string[] = [];
      const time = keeper((record) => rung.push(record.id));
      const alarm = time.setAlarm(clock + 30 * MINUTE);

      clock += 30 * MINUTE;
      time.tick();
      expect(rung).toEqual([alarm.id]);
    });

    it('has nothing to pause', () => {
      const time = keeper();
      const alarm = time.setAlarm(clock + MINUTE);
      expect(time.pause(alarm.id)).toBeNull();
    });
  });

  describe('surviving a reload', () => {
    it('brings back a running timer with the right time left', async () => {
      const first = keeper();
      await first.load();
      first.startTimer(10 * MINUTE);

      // Helix is closed for four minutes and opened again.
      clock += 4 * MINUTE;
      const second = keeper();
      await second.load();

      expect(second.list()).toHaveLength(1);
      expect(timerRemaining(second.list()[0] as never, clock)).toBe(6 * MINUTE);
    });

    it('a timer whose moment passed while it was closed comes back ringing', async () => {
      const first = keeper();
      await first.load();
      first.startTimer(MINUTE);

      clock += 5 * MINUTE;
      const second = keeper();
      await second.load();
      expect(second.list()[0]).toMatchObject({ ringing: true });
    });

    /**
     * The honest case. There is no operating-system scheduling behind these,
     * so an alarm due while Helix was closed did not sound. Ringing it hours
     * late as though it had would be a lie about what happened; it comes back
     * marked missed instead, and the interface says so.
     */
    it('an alarm due while it was closed is reported missed, not rung late', async () => {
      const first = keeper();
      await first.load();
      first.setAlarm(clock + MINUTE);

      clock += 8 * 60 * MINUTE;
      const second = keeper();
      await second.load();

      expect(second.list()[0]).toMatchObject({ missed: true, ringing: false });
    });

    it('an alarm due moments ago still rings', async () => {
      const first = keeper();
      await first.load();
      first.setAlarm(clock + MINUTE);

      clock += MINUTE + 5_000;
      const second = keeper();
      await second.load();
      expect(second.list()[0]).toMatchObject({ ringing: true, missed: false });
    });
  });

  describe('theOnly', () => {
    it('answers the single one, so a bare command is unambiguous', () => {
      const time = keeper();
      const timer = time.startTimer(MINUTE);
      expect(time.theOnly('timer')?.id).toBe(timer.id);
    });

    /** With two running, "stop the timer" names neither - the caller asks
        rather than picking one. */
    it('answers null for two, rather than guessing which was meant', () => {
      const time = keeper();
      time.startTimer(MINUTE);
      time.startTimer(5 * MINUTE);
      expect(time.theOnly('timer')).toBeNull();
    });

    it('prefers the one that is ringing, which is plainly the subject', () => {
      const time = keeper();
      const first = time.startTimer(MINUTE);
      time.startTimer(60 * MINUTE);
      clock += MINUTE;
      time.tick();

      expect(time.theOnly('timer')?.id).toBe(first.id);
    });
  });

  it('tells callers when an alarm is far enough off to be slept through', () => {
    expect(wouldSleepThrough(clock + 30 * MINUTE, clock)).toBe(false);
    expect(wouldSleepThrough(clock + 9 * 60 * MINUTE, clock)).toBe(true);
  });

  it('notifies subscribers on every change', () => {
    const time = keeper();
    const listener = vi.fn();
    const stop = time.subscribe(listener);

    time.startTimer(MINUTE);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    time.startTimer(MINUTE);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
