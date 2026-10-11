import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './EventBus.js';

/**
 * A fixture catalogue, not either application's.
 *
 * These tests used Helix's real event names - PROJECT_OPENED, CAMERA_STARTED,
 * `helix:ready`. That was fine while the bus was Helix's, and became the
 * coupling this package exists to remove: a shared primitive whose tests only
 * compile against one application's catalogue is not shared.
 *
 * The names below are deliberately nondescript. Every property under test here
 * is about the mechanism - dispatch, isolation, snapshot iteration, the
 * listener ceiling - and the names were always incidental to it. The Helix
 * binding is tested separately, next to the catalogue it binds.
 */
interface TestEvents {
  opened: { id: string };
  started: { deviceId: string };
  saved: { recordId: string; category: string };
  ready: { startedAt: number };
  stopped: { reason: string };
  'shut-down': { reason: string };
}

const makeBus = (options?: ConstructorParameters<typeof EventBus>[0]) =>
  new EventBus<TestEvents>(options);

describe('EventBus', () => {
  it('delivers a payload to a subscriber', () => {
    const bus = makeBus();
    const seen: string[] = [];
    bus.on('opened', (p) => seen.push(p.id));

    bus.emit('opened', { id: 'ironman' });

    expect(seen).toEqual(['ironman']);
  });

  it('delivers to every subscriber of the same event', () => {
    const bus = makeBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('started', a);
    bus.on('started', b);

    bus.emit('started', { deviceId: 'cam0' });

    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('stops delivering after unsubscribe', () => {
    const bus = makeBus();
    const handler = vi.fn();
    const off = bus.on('saved', handler);

    off();
    bus.emit('saved', { recordId: 'm1', category: 'user' });

    expect(handler).not.toHaveBeenCalled();
    expect(bus.listenerCount('saved')).toBe(0);
  });

  it('treats repeated unsubscribe calls as a no-op', () => {
    const bus = makeBus();
    const off = bus.on('saved', vi.fn());
    off();
    expect(() => {
      off();
      off();
    }).not.toThrow();
  });

  it('once() fires a single time', () => {
    const bus = makeBus();
    const handler = vi.fn();
    bus.once('ready', handler);

    bus.emit('ready', { startedAt: 1 });
    bus.emit('ready', { startedAt: 2 });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ startedAt: 1 });
    expect(bus.listenerCount('ready')).toBe(0);
  });

  // The important one: a broken subscriber must not be able to stop a
  // teardown handler or a warning reaching anyone else (spec 23).
  it('isolates a throwing handler from the others', () => {
    const logger = { error: vi.fn() };
    const bus = makeBus({ logger });
    const after = vi.fn();

    bus.on('stopped', () => {
      throw new Error('subscriber exploded');
    });
    bus.on('stopped', after);

    expect(() => bus.emit('stopped', { reason: 'user' })).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('does not silently swallow handler errors when a logger is present', () => {
    const logger = { error: vi.fn() };
    const bus = makeBus({ logger });
    bus.on('ready', () => {
      throw new Error('boom');
    });

    bus.emit('ready', { startedAt: 0 });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('ready'),
      expect.any(Error),
    );
  });

  it('lets a handler unsubscribe during dispatch without skipping peers', () => {
    const bus = makeBus();
    const calls: string[] = [];
    const offSelf = bus.on('ready', () => {
      calls.push('first');
      offSelf();
    });
    bus.on('ready', () => calls.push('second'));

    bus.emit('ready', { startedAt: 0 });
    bus.emit('ready', { startedAt: 1 });

    expect(calls).toEqual(['first', 'second', 'second']);
  });

  it('does not dispatch to a handler added during the same emit', () => {
    const bus = makeBus();
    const late = vi.fn();
    bus.on('ready', () => {
      bus.on('ready', late);
    });

    bus.emit('ready', { startedAt: 0 });

    expect(late).not.toHaveBeenCalled();
  });

  it('emitting an event with no subscribers is harmless', () => {
    const bus = makeBus();
    expect(() => bus.emit('shut-down', { reason: 'test' })).not.toThrow();
  });

  it('warns once the listener ceiling is crossed', () => {
    const logger = { error: vi.fn() };
    const bus = makeBus({ logger, maxListenersPerEvent: 2 });

    bus.on('ready', vi.fn());
    bus.on('ready', vi.fn());
    expect(logger.error).not.toHaveBeenCalled();

    bus.on('ready', vi.fn());
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('removeAll() clears one event or every event', () => {
    const bus = makeBus();
    bus.on('ready', vi.fn());
    bus.on('started', vi.fn());

    bus.removeAll('ready');
    expect(bus.listenerCount('ready')).toBe(0);
    expect(bus.listenerCount('started')).toBe(1);

    bus.removeAll();
    expect(bus.listenerCount('started')).toBe(0);
  });
});
