import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import type { GestureController, ControllerState } from '../../spatial/GestureController.js';
import type { SpatialObject, SpatialScene } from '../../spatial/SpatialScene.js';
import type { ActionDefinition } from '../../actions/action.js';

/**
 * The spatial stage: objects laid over the camera view.
 *
 * Gesture and mouse input drive the *same* scene operations. The mouse is a
 * genuine fallback rather than a parallel implementation - dragging with a
 * mouse calls `scene.move`, exactly as a pinch does, and right-clicking opens
 * the same action menu an open palm reveals.
 *
 * The menu's contents come from the action registry, filtered to what applies
 * to a stage object. That is the specification's rule - only show actions
 * compatible with the selected object - held by construction: an action that
 * does not declare itself compatible cannot appear, and one that does needs no
 * change here to show up. Choosing an item runs it through the action runner,
 * so Delete gets its confirmation from the same pipeline as everything else
 * rather than from a check written into this file.
 */

interface SpatialStageProps {
  scene: SpatialScene;
  controller: GestureController;
  /** Live camera element to show behind the objects, when running. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  cameraLive: boolean;
  /** What the registry says applies to a stage object. */
  actions: readonly ActionDefinition[];
  /** Runs one, through the permission and confirmation pipeline. */
  onRun: (actionId: string, objectId: string) => void;
}

export function SpatialStage({
  scene,
  controller,
  videoRef,
  cameraLive,
  actions,
  onRun,
}: SpatialStageProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [objects, setObjects] = useState<readonly SpatialObject[]>(scene.objects);
  const [selectedId, setSelectedId] = useState<string | null>(scene.selectedId);
  const [control, setControl] = useState<ControllerState>(controller.state);
  const [mouseDragId, setMouseDragId] = useState<string | null>(null);
  const mouseOffset = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const sync = () => {
      setObjects([...scene.objects]);
      setSelectedId(scene.selectedId);
    };
    sync();
    return scene.subscribe(sync);
  }, [scene]);

  useEffect(() => controller.subscribe(setControl), [controller]);

  /** Convert a pointer event to normalised stage coordinates. */
  const toNormalised = useCallback((event: { clientX: number; clientY: number }) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0.5, y: 0.5 };
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }, []);

  // Mouse dragging uses the same scene.move as a pinch, so the two inputs
  // cannot drift apart in behaviour.
  useEffect(() => {
    if (!mouseDragId) return;

    const onMove = (event: PointerEvent) => {
      const point = toNormalised(event);
      scene.move(mouseDragId, point.x + mouseOffset.current.x, point.y + mouseOffset.current.y);
    };
    const onUp = () => setMouseDragId(null);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [mouseDragId, scene, toNormalised]);

  const startMouseDrag = (event: React.PointerEvent, object: SpatialObject) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const point = toNormalised(event);
    mouseOffset.current = { x: object.x - point.x, y: object.y - point.y };
    scene.select(object.id);
    scene.bringToFront(object.id);
    controller.dismissMenu();
    setMouseDragId(object.id);
  };

  const menu = control.menu;
  const menuObject = menu ? scene.get(menu.objectId) : null;

  return (
    <div
      className={`hx-stage${cameraLive ? ' hx-stage--camera' : ''}`}
      ref={stageRef}
      onPointerDown={(event) => {
        // A click on empty space clears the selection and any open menu.
        if (event.target === stageRef.current) {
          scene.select(null);
          controller.dismissMenu();
        }
      }}
    >
      <video
        ref={videoRef}
        className="hx-stage__video"
        playsInline
        muted
        aria-hidden="true"
        style={{ opacity: cameraLive ? 1 : 0 }}
      />

      {objects.length === 0 && (
        <div className="hx-stage__empty">
          <Icon name="image" size={26} />
          <p>No objects on the stage, sir.</p>
          <p className="hx-muted">Add one below, or open a project with images.</p>
        </div>
      )}

      {objects.map((object) => {
        const isSelected = object.id === selectedId;
        const isDragging = control.draggingId === object.id || mouseDragId === object.id;
        const isDwelling = control.dwellProgress > 0 && menu === null && isSelected;

        return (
          <div
            key={object.id}
            className={`hx-obj${isSelected ? ' hx-obj--selected' : ''}${
              isDragging ? ' hx-obj--dragging' : ''
            }`}
            style={{
              left: `${object.x * 100}%`,
              top: `${object.y * 100}%`,
              transform: `translate(-50%, -50%) scale(${object.scale}) rotate(${object.rotation}rad)`,
            }}
            onPointerDown={(event) => startMouseDrag(event, object)}
            onContextMenu={(event) => {
              // Right-click is the mouse equivalent of holding a palm over it.
              event.preventDefault();
              scene.select(object.id);
              controller.openMenuFor(object.id);
            }}
          >
            {object.src ? (
              <img className="hx-obj__image" src={object.src} alt={object.label} draggable={false} />
            ) : (
              <div className="hx-obj__placeholder">{object.label}</div>
            )}
            <span className="hx-obj__label">{object.label}</span>

            {isDwelling && (
              <span
                className="hx-obj__dwell"
                style={{ ['--hx-dwell' as string]: String(control.dwellProgress) }}
                aria-hidden="true"
              />
            )}
          </div>
        );
      })}

      {menu && menuObject && (
        <div
          className="hx-objmenu"
          style={{ left: `${menuObject.x * 100}%`, top: `${menuObject.y * 100}%` }}
          role="menu"
          aria-label={`Actions for ${menuObject.label}`}
        >
          <div className="hx-objmenu__title">{menuObject.label}</div>

          {actions.length === 0 && (
            <p className="hx-objmenu__empty">Nothing can be done to this yet.</p>
          )}

          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              className={`hx-objmenu__item${
                action.reversible ? '' : ' hx-objmenu__item--danger'
              }`}
              onClick={() => onRun(action.id, menuObject.id)}
            >
              {action.reversible ? null : <Icon name="close" size={14} />}
              {action.label}
            </button>
          ))}

          <button
            type="button"
            role="menuitem"
            className="hx-objmenu__item hx-objmenu__item--quiet"
            onClick={() => controller.dismissMenu()}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
