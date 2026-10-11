import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './EventBus.js';

/**
 * The seam between the shared bus and Helix's own catalogue.
 *
 * `@hx/core` owns the mechanism and is tested against a fixture map, because a
 * shared primitive that only compiles against one application's events is not
 * shared. That leaves one thing untested by either side: that Helix's bus is
 * actually bound to Helix's catalogue. This is that test.
 *
 * It is deliberately thin. It is not re-testing dispatch, isolation or the
 * listener ceiling - those belong to the package. It asserts the binding: real
 * Helix event names, real payload shapes, through the class the application
 * constructs.
 */
describe('the Helix event bus', () => {
  it('carries a real Helix event with its real payload', () => {
    const bus = new EventBus();
    const seen: string[] = [];

    bus.on('PROJECT_OPENED', (payload) => seen.push(payload.projectId));
    bus.emit('PROJECT_OPENED', { projectId: 'ironman' });

    expect(seen).toEqual(['ironman']);
  });

  /**
   * The sensor events exist so the active-camera indicator follows the device
   * rather than the UI's belief about it. Worth one assertion that they are
   * on the bus the application actually builds.
   */
  it('carries the sensor events the active indicator depends on', () => {
    const bus = new EventBus();
    const started = vi.fn();
    const stopped = vi.fn();

    bus.on('CAMERA_STARTED', started);
    bus.on('CAMERA_STOPPED', stopped);
    bus.emit('CAMERA_STARTED', { deviceId: 'cam0' });
    bus.emit('CAMERA_STOPPED', { reason: 'user' });

    expect(started).toHaveBeenCalledWith({ deviceId: 'cam0' });
    expect(stopped).toHaveBeenCalledWith({ reason: 'user' });
  });

  it('still isolates a throwing subscriber, through the binding', () => {
    const logger = { error: vi.fn() };
    const bus = new EventBus({ logger });
    const after = vi.fn();

    bus.on('helix:ready', () => {
      throw new Error('subscriber exploded');
    });
    bus.on('helix:ready', after);

    expect(() => bus.emit('helix:ready', { startedAt: 1 })).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  /**
   * What the extraction was for. An event name Helix does not declare is a
   * compile error, and so is a payload of the wrong shape - which is what
   * stops AXUM's catalogue and Helix's from merging into one list that both
   * have to carry.
   */
  it('rejects an unknown event name and a mistyped payload at compile time', () => {
    const bus = new EventBus();

    // @ts-expect-error 'axum:ready' is not in HelixEventMap
    bus.on('axum:ready', () => {});

    // @ts-expect-error PROJECT_OPENED carries a projectId, not a name
    bus.emit('PROJECT_OPENED', { name: 'ironman' });

    expect(bus.listenerCount('PROJECT_OPENED')).toBe(0);
  });
});
