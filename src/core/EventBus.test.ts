import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './EventBus.js';

describe('EventBus', () => {
  it('delivers a payload to a subscriber', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('PROJECT_OPENED', (p) => seen.push(p.projectId));

    bus.emit('PROJECT_OPENED', { projectId: 'ironman' });

    expect(seen).toEqual(['ironman']);
  });

  it('delivers to every subscriber of the same event', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('CAMERA_STARTED', a);
    bus.on('CAMERA_STARTED', b);

    bus.emit('CAMERA_STARTED', { deviceId: 'cam0' });

    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const off = bus.on('MEMORY_SAVED', handler);

    off();
    bus.emit('MEMORY_SAVED', { memoryId: 'm1', category: 'user' });

    expect(handler).not.toHaveBeenCalled();
    expect(bus.listenerCount('MEMORY_SAVED')).toBe(0);
  });

  it('treats repeated unsubscribe calls as a no-op', () => {
    const bus = new EventBus();
    const off = bus.on('MEMORY_SAVED', vi.fn());
    off();
    expect(() => {
      off();
      off();
    }).not.toThrow();
  });

  it('once() fires a single time', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.once('helix:ready', handler);

    bus.emit('helix:ready', { startedAt: 1 });
    bus.emit('helix:ready', { startedAt: 2 });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ startedAt: 1 });
    expect(bus.listenerCount('helix:ready')).toBe(0);
  });

  // The important one: a broken subscriber must not be able to prevent
  // camera teardown or a storage warning reaching anyone else (spec 23).
  it('isolates a throwing handler from the others', () => {
    const logger = { error: vi.fn() };
    const bus = new EventBus({ logger });
    const after = vi.fn();

    bus.on('CAMERA_STOPPED', () => {
      throw new Error('subscriber exploded');
    });
    bus.on('CAMERA_STOPPED', after);

    expect(() => bus.emit('CAMERA_STOPPED', { reason: 'user' })).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('does not silently swallow handler errors when a logger is present', () => {
    const logger = { error: vi.fn() };
    const bus = new EventBus({ logger });
    bus.on('helix:ready', () => {
      throw new Error('boom');
    });

    bus.emit('helix:ready', { startedAt: 0 });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('helix:ready'),
      expect.any(Error),
    );
  });

  it('lets a handler unsubscribe during dispatch without skipping peers', () => {
    const bus = new EventBus();
    const calls: string[] = [];
    const offSelf = bus.on('helix:ready', () => {
      calls.push('first');
      offSelf();
    });
    bus.on('helix:ready', () => calls.push('second'));

    bus.emit('helix:ready', { startedAt: 0 });
    bus.emit('helix:ready', { startedAt: 1 });

    expect(calls).toEqual(['first', 'second', 'second']);
  });

  it('does not dispatch to a handler added during the same emit', () => {
    const bus = new EventBus();
    const late = vi.fn();
    bus.on('helix:ready', () => {
      bus.on('helix:ready', late);
    });

    bus.emit('helix:ready', { startedAt: 0 });

    expect(late).not.toHaveBeenCalled();
  });

  it('emitting an event with no subscribers is harmless', () => {
    const bus = new EventBus();
    expect(() => bus.emit('helix:shutdown', { reason: 'test' })).not.toThrow();
  });

  it('warns once the listener ceiling is crossed', () => {
    const logger = { error: vi.fn() };
    const bus = new EventBus({ logger, maxListenersPerEvent: 2 });

    bus.on('helix:ready', vi.fn());
    bus.on('helix:ready', vi.fn());
    expect(logger.error).not.toHaveBeenCalled();

    bus.on('helix:ready', vi.fn());
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('removeAll() clears one event or every event', () => {
    const bus = new EventBus();
    bus.on('helix:ready', vi.fn());
    bus.on('CAMERA_STARTED', vi.fn());

    bus.removeAll('helix:ready');
    expect(bus.listenerCount('helix:ready')).toBe(0);
    expect(bus.listenerCount('CAMERA_STARTED')).toBe(1);

    bus.removeAll();
    expect(bus.listenerCount('CAMERA_STARTED')).toBe(0);
  });
});
