import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityManager } from './ActivityManager.js';
import { EventBus } from './EventBus.js';

describe('ActivityManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts standing by', () => {
    const activity = new ActivityManager();
    expect(activity.current.kind).toBe('standing-by');
    expect(activity.current.label).toBe('Standing by');
    expect(activity.isBusy).toBe(false);
  });

  it('reflects a running operation', () => {
    const activity = new ActivityManager();
    activity.begin('thinking');

    expect(activity.current.kind).toBe('thinking');
    expect(activity.current.label).toBe('Thinking...');
    expect(activity.isBusy).toBe(true);
  });

  it('accepts a custom label and detail', () => {
    const activity = new ActivityManager();
    activity.begin('opening-project', { label: 'Opening project...', detail: 'Iron Man' });
    expect(activity.current.detail).toBe('Iron Man');
  });

  it('shows the outcome, then settles back to standing by', () => {
    const activity = new ActivityManager();
    const token = activity.begin('searching');
    token.end('completed');

    expect(activity.current.kind).toBe('completed');
    expect(activity.isBusy).toBe(false);

    vi.advanceTimersByTime(3000);
    expect(activity.current.kind).toBe('standing-by');
  });

  it('reports a failed outcome', () => {
    const activity = new ActivityManager();
    activity.begin('generating').end('failed', 'no provider configured');

    expect(activity.current.kind).toBe('failed');
    expect(activity.current.detail).toBe('no provider configured');
  });

  it('ending twice is harmless', () => {
    const activity = new ActivityManager();
    const token = activity.begin('thinking');
    token.end();
    expect(() => token.end()).not.toThrow();
  });

  it('updates the detail line while running', () => {
    const activity = new ActivityManager();
    const token = activity.begin('searching');
    token.update('3 results');
    expect(activity.current.detail).toBe('3 results');
  });

  it('restores the parent operation when a nested one ends', () => {
    const activity = new ActivityManager();
    activity.begin('opening-project', { detail: 'Iron Man' });
    const inner = activity.begin('loading-model');

    expect(activity.current.kind).toBe('loading-model');

    inner.end();
    expect(activity.current.kind).toBe('opening-project');
    expect(activity.current.detail).toBe('Iron Man');
    expect(activity.isBusy).toBe(true);
  });

  it('handles an inner operation ending out of order', () => {
    const activity = new ActivityManager();
    const outer = activity.begin('opening-project');
    activity.begin('loading-model');

    // Outer finishes first; the visible activity should stay on the inner one.
    outer.end();
    expect(activity.current.kind).toBe('loading-model');
    expect(activity.isBusy).toBe(true);
  });

  it('notifies subscribers on change', () => {
    const activity = new ActivityManager();
    const listener = vi.fn();
    activity.subscribe(listener);

    activity.begin('listening');

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ kind: 'listening' }));
  });

  it('unsubscribe stops notifications', () => {
    const activity = new ActivityManager();
    const listener = vi.fn();
    activity.subscribe(listener)();
    activity.begin('thinking');
    expect(listener).not.toHaveBeenCalled();
  });

  it('a throwing listener cannot disturb tracking', () => {
    const activity = new ActivityManager();
    activity.subscribe(() => {
      throw new Error('listener exploded');
    });

    expect(() => activity.begin('thinking')).not.toThrow();
    expect(activity.current.kind).toBe('thinking');
  });

  it('emits ACTIVITY_CHANGED on the bus', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('ACTIVITY_CHANGED', handler);

    new ActivityManager(bus).begin('speaking');

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ kind: 'speaking' }));
  });

  describe('track', () => {
    it('ends the activity when the operation resolves', async () => {
      const activity = new ActivityManager();
      const result = await activity.track('searching', async () => 'done');

      expect(result).toBe('done');
      expect(activity.isBusy).toBe(false);
      expect(activity.current.kind).toBe('completed');
    });

    // A thrown error must not leave the panel stuck on "Thinking..." forever.
    it('ends the activity when the operation throws, and rethrows', async () => {
      const activity = new ActivityManager();

      await expect(
        activity.track('thinking', async () => {
          throw new Error('provider unreachable');
        }),
      ).rejects.toThrow('provider unreachable');

      expect(activity.isBusy).toBe(false);
      expect(activity.current.kind).toBe('failed');
    });
  });

  it('reset returns to standing by', () => {
    const activity = new ActivityManager();
    activity.begin('thinking');
    activity.reset();

    expect(activity.current.kind).toBe('standing-by');
    expect(activity.isBusy).toBe(false);
  });
});
