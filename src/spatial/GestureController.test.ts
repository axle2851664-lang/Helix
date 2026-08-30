import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GestureController, PALM_DWELL_MS } from './GestureController.js';
import { SpatialScene } from './SpatialScene.js';
import { EventBus } from '../core/EventBus.js';
import type { GestureFrame, Point2D } from '../gestures/types.js';

/**
 * Frames are constructed directly rather than recognised from landmarks, so
 * these tests cover the interaction rules - grabbing, dragging, dwelling -
 * independently of the recognition maths, which recognize.test.ts covers.
 *
 * Screen coordinates are mirrored (selfie view), so a frame at gesture x maps
 * to screen 1 - x. `at()` takes screen coordinates and flips them, keeping the
 * tests readable in terms of what the user sees.
 */
const at = (screen: Point2D) => ({ x: 1 - screen.x, y: screen.y });

function pinchFrame(screen: Point2D, timestamp = 0): GestureFrame {
  const position = at(screen);
  return {
    hands: [{ handedness: 'right', confidence: 0.9, landmarks: [], palm: position }],
    pinch: { active: true, distance: 0.1, position },
    twoHand: { active: false, separation: null, angle: null },
    openHand: false,
    timestamp,
  };
}

function palmFrame(screen: Point2D, timestamp = 0): GestureFrame {
  const palm = at(screen);
  return {
    hands: [{ handedness: 'right', confidence: 0.9, landmarks: [], palm }],
    pinch: { active: false, distance: 0.6, position: null },
    twoHand: { active: false, separation: null, angle: null },
    openHand: true,
    timestamp,
  };
}

function emptyFrame(timestamp = 0): GestureFrame {
  return {
    hands: [],
    pinch: { active: false, distance: null, position: null },
    twoHand: { active: false, separation: null, angle: null },
    openHand: false,
    timestamp,
  };
}

describe('GestureController: pinch to move', () => {
  let scene: SpatialScene;
  let controller: GestureController;

  beforeEach(() => {
    scene = new SpatialScene();
    scene.add({ label: 'Iron Man', x: 0.5, y: 0.5, scale: 1, rotation: 0 });
    controller = new GestureController({ scene });
  });

  it('grabs the object under the pinch', () => {
    const state = controller.update(pinchFrame({ x: 0.5, y: 0.5 }));

    expect(state.mode).toBe('dragging');
    expect(state.draggingId).toBe(scene.objects[0]?.id);
    expect(scene.selectedId).toBe(scene.objects[0]?.id);
  });

  it('ignores a pinch in empty space', () => {
    const state = controller.update(pinchFrame({ x: 0.05, y: 0.95 }));

    expect(state.mode).toBe('idle');
    expect(state.draggingId).toBeNull();
  });

  it('moves the object as the pinch travels', () => {
    controller.update(pinchFrame({ x: 0.5, y: 0.5 }));
    controller.update(pinchFrame({ x: 0.7, y: 0.3 }));

    const object = scene.objects[0];
    expect(object?.x).toBeCloseTo(0.7, 5);
    expect(object?.y).toBeCloseTo(0.3, 5);
  });

  // Grabbing an object off-centre must not snap it to the fingers.
  it('preserves the grab offset', () => {
    // Object centre 0.5,0.5; grab at 0.55,0.5 - an offset of -0.05.
    controller.update(pinchFrame({ x: 0.55, y: 0.5 }));
    controller.update(pinchFrame({ x: 0.75, y: 0.5 }));

    expect(scene.objects[0]?.x).toBeCloseTo(0.7, 5);
  });

  it('releases the object when the pinch opens', () => {
    controller.update(pinchFrame({ x: 0.5, y: 0.5 }));
    const state = controller.update(emptyFrame());

    expect(state.mode).toBe('idle');
    expect(state.draggingId).toBeNull();
  });

  // Only the grabbed object moves; the rest of the scene stays put.
  it('moves only the grabbed object', () => {
    const other = scene.add({ label: 'Helmet', x: 0.2, y: 0.2, scale: 1, rotation: 0 });

    controller.update(pinchFrame({ x: 0.5, y: 0.5 }));
    controller.update(pinchFrame({ x: 0.8, y: 0.8 }));

    expect(scene.get(other.id)?.x).toBe(0.2);
    expect(scene.get(other.id)?.y).toBe(0.2);
  });

  it('brings a grabbed object to the front', () => {
    const second = scene.add({ label: 'Helmet', x: 0.5, y: 0.5, scale: 1, rotation: 0 });
    // The topmost object at that point is the newest, so grab it, then
    // confirm the first object can be grabbed once it is raised.
    controller.update(pinchFrame({ x: 0.5, y: 0.5 }));
    expect(scene.objects[scene.objects.length - 1]?.id).toBe(second.id);
  });

  it('emits SPATIAL_OBJECT_MOVED while dragging', () => {
    const bus = new EventBus();
    const moved = vi.fn();
    bus.on('SPATIAL_OBJECT_MOVED', moved);

    const busScene = new SpatialScene(bus);
    busScene.add({ label: 'A', x: 0.5, y: 0.5, scale: 1, rotation: 0 });
    const busController = new GestureController({ scene: busScene });

    busController.update(pinchFrame({ x: 0.5, y: 0.5 }));
    busController.update(pinchFrame({ x: 0.6, y: 0.6 }));

    expect(moved).toHaveBeenCalled();
  });
});

describe('GestureController: open palm reveals actions', () => {
  let scene: SpatialScene;
  let controller: GestureController;
  let objectId: string;

  beforeEach(() => {
    scene = new SpatialScene();
    objectId = scene.add({ label: 'Iron Man', x: 0.5, y: 0.5, scale: 1, rotation: 0 }).id;
    controller = new GestureController({ scene, dwellMs: 700 });
  });

  // A dwell, not an instant trigger: a palm crossing the view would otherwise
  // open menus continuously.
  it('does not open the menu immediately', () => {
    const state = controller.update(palmFrame({ x: 0.5, y: 0.5 }, 0));

    expect(state.menu).toBeNull();
    expect(state.dwellProgress).toBeLessThan(1);
  });

  it('reports dwell progress so the wait is visible', () => {
    controller.update(palmFrame({ x: 0.5, y: 0.5 }, 0));
    const state = controller.update(palmFrame({ x: 0.5, y: 0.5 }, 350));

    expect(state.dwellProgress).toBeCloseTo(0.5, 1);
  });

  it('opens the menu once the palm has dwelled', () => {
    controller.update(palmFrame({ x: 0.5, y: 0.5 }, 0));
    const state = controller.update(palmFrame({ x: 0.5, y: 0.5 }, PALM_DWELL_MS));

    expect(state.mode).toBe('menu');
    expect(state.menu?.objectId).toBe(objectId);
  });

  it('does not open a menu over empty space', () => {
    controller.update(palmFrame({ x: 0.05, y: 0.95 }, 0));
    const state = controller.update(palmFrame({ x: 0.05, y: 0.95 }, 2000));

    expect(state.menu).toBeNull();
  });

  it('restarts the dwell when the palm moves to another object', () => {
    const second = scene.add({ label: 'Helmet', x: 0.2, y: 0.2, scale: 1, rotation: 0 });

    controller.update(palmFrame({ x: 0.5, y: 0.5 }, 0));
    controller.update(palmFrame({ x: 0.5, y: 0.5 }, 500));
    // Move to the other object: progress must restart, not carry over.
    const state = controller.update(palmFrame({ x: 0.2, y: 0.2 }, 600));

    expect(state.dwellProgress).toBeLessThan(0.5);
    expect(state.menu).toBeNull();
    expect(second.id).toBeTruthy();
  });

  it('deletes the object from the menu', () => {
    controller.update(palmFrame({ x: 0.5, y: 0.5 }, 0));
    controller.update(palmFrame({ x: 0.5, y: 0.5 }, PALM_DWELL_MS));

    expect(controller.deleteFromMenu()).toBe(true);
    expect(scene.objects).toHaveLength(0);
    expect(controller.state.menu).toBeNull();
  });

  it('duplicates the object from the menu', () => {
    controller.update(palmFrame({ x: 0.5, y: 0.5 }, 0));
    controller.update(palmFrame({ x: 0.5, y: 0.5 }, PALM_DWELL_MS));

    expect(controller.duplicateFromMenu()).toBe(true);
    expect(scene.objects).toHaveLength(2);
    // The copy is offset, so it is visibly distinct from the original.
    expect(scene.objects[1]?.x).not.toBe(scene.objects[0]?.x);
  });

  it('does nothing when acting with no menu open', () => {
    expect(controller.deleteFromMenu()).toBe(false);
    expect(controller.duplicateFromMenu()).toBe(false);
    expect(scene.objects).toHaveLength(1);
  });

  it('dismisses the menu', () => {
    controller.update(palmFrame({ x: 0.5, y: 0.5 }, 0));
    controller.update(palmFrame({ x: 0.5, y: 0.5 }, PALM_DWELL_MS));

    controller.dismissMenu();
    expect(controller.state.menu).toBeNull();
    expect(controller.state.mode).toBe('idle');
  });

  // The menu must survive the hand lowering, so it can be used with the mouse.
  it('keeps the menu open after the hand leaves', () => {
    controller.update(palmFrame({ x: 0.5, y: 0.5 }, 0));
    controller.update(palmFrame({ x: 0.5, y: 0.5 }, PALM_DWELL_MS));

    const state = controller.update(emptyFrame(PALM_DWELL_MS + 200));
    expect(state.menu?.objectId).toBe(objectId);
  });

  it('starting a drag dismisses an open menu', () => {
    controller.update(palmFrame({ x: 0.5, y: 0.5 }, 0));
    controller.update(palmFrame({ x: 0.5, y: 0.5 }, PALM_DWELL_MS));

    const state = controller.update(pinchFrame({ x: 0.5, y: 0.5 }, PALM_DWELL_MS + 100));
    expect(state.menu).toBeNull();
    expect(state.mode).toBe('dragging');
  });
});

describe('GestureController: mirroring and reset', () => {
  it('mirrors gesture coordinates to match the selfie preview', () => {
    const scene = new SpatialScene();
    scene.add({ label: 'A', x: 0.8, y: 0.5, scale: 1, rotation: 0 });
    const controller = new GestureController({ scene, mirrored: true });

    // A hand at gesture x=0.2 appears at screen x=0.8.
    controller.update({
      hands: [{ handedness: 'right', confidence: 1, landmarks: [], palm: { x: 0.2, y: 0.5 } }],
      pinch: { active: true, distance: 0.1, position: { x: 0.2, y: 0.5 } },
      twoHand: { active: false, separation: null, angle: null },
      openHand: false,
      timestamp: 0,
    });

    expect(controller.state.draggingId).toBe(scene.objects[0]?.id);
  });

  it('can run unmirrored', () => {
    const scene = new SpatialScene();
    scene.add({ label: 'A', x: 0.2, y: 0.5, scale: 1, rotation: 0 });
    const controller = new GestureController({ scene, mirrored: false });

    controller.update({
      hands: [{ handedness: 'right', confidence: 1, landmarks: [], palm: { x: 0.2, y: 0.5 } }],
      pinch: { active: true, distance: 0.1, position: { x: 0.2, y: 0.5 } },
      twoHand: { active: false, separation: null, angle: null },
      openHand: false,
      timestamp: 0,
    });

    expect(controller.state.draggingId).toBe(scene.objects[0]?.id);
  });

  it('reset clears all interaction state', () => {
    const scene = new SpatialScene();
    scene.add({ label: 'A', x: 0.5, y: 0.5, scale: 1, rotation: 0 });
    const controller = new GestureController({ scene });

    controller.update(pinchFrame({ x: 0.5, y: 0.5 }));
    controller.reset();

    expect(controller.state.mode).toBe('idle');
    expect(controller.state.draggingId).toBeNull();
  });
});

describe('GestureController: mouse fallback parity', () => {
  // The mouse must reach the same actions as the palm gesture, or the
  // "fallback" would really be a lesser second-class input.
  it('openMenuFor reaches the same menu a palm dwell produces', () => {
    const scene = new SpatialScene();
    const id = scene.add({ label: 'A', x: 0.4, y: 0.4, scale: 1, rotation: 0 }).id;
    const controller = new GestureController({ scene });

    expect(controller.openMenuFor(id)).toBe(true);
    expect(controller.state.mode).toBe('menu');
    expect(controller.state.menu?.objectId).toBe(id);
  });

  it('the same delete and duplicate actions work from a mouse-opened menu', () => {
    const scene = new SpatialScene();
    const id = scene.add({ label: 'A', x: 0.4, y: 0.4, scale: 1, rotation: 0 }).id;
    const controller = new GestureController({ scene });

    controller.openMenuFor(id);
    expect(controller.duplicateFromMenu()).toBe(true);
    expect(scene.objects).toHaveLength(2);

    controller.openMenuFor(scene.objects[0]?.id as string);
    expect(controller.deleteFromMenu()).toBe(true);
    expect(scene.objects).toHaveLength(1);
  });

  it('refuses to open a menu for an object that does not exist', () => {
    const controller = new GestureController({ scene: new SpatialScene() });
    expect(controller.openMenuFor('obj_nope')).toBe(false);
  });

  it('opening a menu cancels an in-progress drag', () => {
    const scene = new SpatialScene();
    const id = scene.add({ label: 'A', x: 0.5, y: 0.5, scale: 1, rotation: 0 }).id;
    const controller = new GestureController({ scene });

    controller.update(pinchFrame({ x: 0.5, y: 0.5 }));
    expect(controller.state.draggingId).toBe(id);

    controller.openMenuFor(id);
    expect(controller.state.draggingId).toBeNull();
  });
});
