import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { useHelix } from '../HelixProvider.js';
import { toUserMessage } from '../../core/HelixError.js';
import { SpatialScene } from '../../spatial/SpatialScene.js';
import { GestureController } from '../../spatial/GestureController.js';
import { MediaPipeGestureProvider } from '../../gestures/MediaPipeGestureProvider.js';
import { SpatialStage } from './SpatialStage.js';
import { spatialActions, SPATIAL_ACTION_IDS } from '../../actions/spatial.js';
import type { CameraSnapshot } from '../../camera/CameraManager.js';
import type { ProjectSummary } from '../../projects/types.js';
import type { ActionDefinition } from '../../actions/action.js';

/**
 * Spatial mode: objects manipulated by hand over the camera view (spec 11, 12).
 *
 * Hand tracking runs on this machine - the MediaPipe runtime and model are
 * served from Helix's own origin, so camera frames are never transmitted.
 *
 * Tracking is opt-in and separate from the camera: the camera can run without
 * tracking, and turning tracking off leaves the preview alone. Mouse control
 * works throughout, whether tracking is on or not.
 */
export function SpatialWorkspace() {
  const { camera, projects, logger, bus, actions, runner } = useHelix();

  const videoRef = useRef<HTMLVideoElement>(null);
  const providerRef = useRef<MediaPipeGestureProvider | null>(null);

  // One scene and controller for the lifetime of the workspace.
  const scene = useMemo(() => new SpatialScene(bus), [bus]);
  const controller = useMemo(() => new GestureController({ scene }), [scene]);

  /**
   * The stage's actions exist only while the stage does, because they hold
   * this scene. Registering them centrally rather than keeping a private list
   * is what lets the palm-out menu - and anything else that asks the registry
   * what applies to an object - see them without knowing about this file.
   */
  const [objectActions, setObjectActions] = useState<readonly ActionDefinition[]>([]);

  useEffect(() => {
    actions.registerAll(spatialActions(scene));
    // Read back rather than using the list we just built: what the menu shows
    // is whatever the registry says applies, so an action registered anywhere
    // else appears here too.
    setObjectActions(actions.forTarget('spatial-object'));
    return () => {
      actions.unregisterAll(SPATIAL_ACTION_IDS);
      setObjectActions([]);
    };
  }, [actions, scene]);

  const [cameraState, setCameraState] = useState<CameraSnapshot>(() => camera.snapshot);
  const [tracking, setTracking] = useState(false);
  const [loadingModel, setLoadingModel] = useState(false);
  const [handsSeen, setHandsSeen] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [projectList, setProjectList] = useState<ProjectSummary[]>([]);

  useEffect(() => camera.subscribe(setCameraState), [camera]);
  useEffect(() => {
    void projects.listProjects().then(setProjectList);
  }, [projects]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = camera.stream;
    if (camera.stream) void video.play().catch(() => undefined);
  }, [cameraState.live, camera]);

  const say = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 7000);
  }, []);

  const stopTracking = useCallback(() => {
    providerRef.current?.stop();
    setTracking(false);
    setHandsSeen(0);
    controller.reset();
  }, [controller]);

  // Release the camera, the model and its GPU resources on the way out.
  useEffect(
    () => () => {
      providerRef.current?.dispose();
      providerRef.current = null;
      camera.stop('left-workspace');
    },
    [camera],
  );

  const toggleCamera = async () => {
    if (cameraState.live) {
      stopTracking();
      camera.stop('user');
      return;
    }
    try {
      await camera.start();
    } catch (error) {
      say(toUserMessage(error));
    }
  };

  const toggleTracking = async () => {
    if (tracking) {
      stopTracking();
      return;
    }

    const video = videoRef.current;
    if (!video || !cameraState.live) {
      say('The camera must be running before I can track your hands, sir.');
      return;
    }

    const provider = providerRef.current ?? new MediaPipeGestureProvider();
    providerRef.current = provider;

    const availability = provider.isAvailable();
    if (!availability.available) {
      say(availability.reason ?? 'Hand tracking is unavailable.');
      return;
    }

    setLoadingModel(true);
    try {
      await provider.start(video, (frame) => {
        setHandsSeen(frame.hands.length);
        controller.update(frame);
      });
      setTracking(true);
    } catch (error) {
      // The most likely cause is the model not having been fetched.
      say(toUserMessage(error));
      logger.warn('Hand tracking could not start.', error);
    } finally {
      setLoadingModel(false);
    }
  };

  /** Put a project's images onto the stage so there is something to grab. */
  const loadProject = async (projectId: string) => {
    const assets = await projects.listAssets(projectId);
    const images = assets.filter((asset) => asset.kind === 'image');

    if (images.length === 0) {
      say('That project holds no images to place on the stage, sir.');
      return;
    }

    let index = 0;
    for (const asset of images.slice(0, 6)) {
      const data = await projects.getAssetData(asset.id);
      if (!data) continue;
      const blob = data instanceof Blob ? data : new Blob([data], { type: asset.mimeType });
      scene.add({
        label: asset.fileName,
        // Spread across the stage so they do not stack on one another.
        x: 0.25 + (index % 3) * 0.25,
        y: 0.3 + Math.floor(index / 3) * 0.3,
        scale: 1,
        rotation: 0,
        assetId: asset.id,
        projectId,
        src: URL.createObjectURL(blob),
      });
      index += 1;
    }
  };

  return (
    <div className="hx-page">
      {notice && (
        <div className="hx-notice hx-notice--warn" role="status">
          {notice}
        </div>
      )}

      <SpatialStage
        scene={scene}
        controller={controller}
        videoRef={videoRef}
        cameraLive={cameraState.live}
        actions={objectActions}
        onRun={(actionId, objectId) => {
          // The menu closes as the action starts. Any question it raises is
          // asked by the consent dialog, which must not be behind a menu.
          controller.dismissMenu();
          void runner.run(actionId, { objectId }).then((result) => {
            // A refusal is the user's own answer and needs no announcement;
            // a failure is something they could not have expected.
            if (result.status === 'failed') say(result.message);
          });
        }}
      />

      <section className="hx-panel">
        <div className="hx-field__actions">
          <button type="button" className="hx-btn" onClick={() => void toggleCamera()}>
            <Icon name={cameraState.live ? 'close' : 'gesture'} size={15} />
            {cameraState.live ? 'Turn off camera' : 'Turn on camera'}
          </button>

          <button
            type="button"
            className="hx-btn"
            disabled={!cameraState.live || loadingModel}
            onClick={() => void toggleTracking()}
          >
            <Icon name="gesture" size={15} />
            {loadingModel ? 'Loading model...' : tracking ? 'Stop hand tracking' : 'Start hand tracking'}
          </button>

          <button
            type="button"
            className="hx-btn hx-btn--quiet"
            onClick={() =>
              scene.add({
                label: `Object ${scene.objects.length + 1}`,
                x: 0.5,
                y: 0.5,
                scale: 1,
                rotation: 0,
              })
            }
          >
            <Icon name="plus" size={15} /> Add test object
          </button>

          {tracking && (
            <span className={`hx-track${handsSeen > 0 ? ' hx-track--seen' : ''}`}>
              <span className={`hx-dot hx-dot--${handsSeen > 0 ? 'ok' : 'off'}`} />
              {handsSeen === 0
                ? 'Tracking, no hands in view'
                : `${handsSeen} ${handsSeen === 1 ? 'hand' : 'hands'} tracked`}
            </span>
          )}
        </div>

        {projectList.length > 0 && (
          <div className="hx-field__actions">
            <select
              className="hx-select hx-select--inline"
              defaultValue=""
              aria-label="Load a project onto the stage"
              onChange={(event) => {
                if (event.target.value) void loadProject(event.target.value);
                event.target.value = '';
              }}
            >
              <option value="">Place a project&rsquo;s images&hellip;</option>
              {projectList.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </section>

      <section className="hx-panel">
        <h2 className="hx-panel__title">How to use it</h2>
        <ul className="hx-list">
          <li>
            <strong>Pinch</strong> thumb and forefinger over an object to grab it, then move your
            hand to drag it. Opening your hand releases it.
          </li>
          <li>
            <strong>Hold an open palm</strong> over an object for a moment to open its menu. A
            ring fills to show the wait, so a passing hand does not trigger it. The menu lists
            only what can actually be done to that object, and Delete asks before it acts.
          </li>
          <li>
            <strong>Mouse:</strong> drag to move, right-click for the same menu. This works whether
            hand tracking is running or not.
          </li>
        </ul>
        <p className="hx-settings__note">
          Hand tracking runs entirely on this machine. The runtime and model are served from Helix
          itself, so camera frames are never sent anywhere.
        </p>
      </section>
    </div>
  );
}
