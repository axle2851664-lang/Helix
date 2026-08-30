import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { useHelix } from '../HelixProvider.js';
import { toUserMessage } from '../../core/HelixError.js';
import { NullVisionProvider } from '../../vision/types.js';
import { NullGestureProvider } from '../../gestures/types.js';
import { formatBytes } from '../../projects/validation.js';
import type { CameraDevice, CameraSnapshot, CapturedFrame } from '../../camera/CameraManager.js';
import type { ProjectSummary } from '../../projects/types.js';

/**
 * The camera workspace (spec 10, 11).
 *
 * The camera is real: live preview, capture, and saving a still into a project.
 * Vision analysis and hand tracking are not - each states what is missing
 * rather than showing a control that does nothing.
 *
 * The camera is only ever opened by pressing the button here. Nothing on this
 * screen starts the device on mount.
 */
export function CameraWorkspace() {
  const { camera, projects, logger } = useHelix();

  const videoRef = useRef<HTMLVideoElement>(null);
  const [snapshot, setSnapshot] = useState<CameraSnapshot>(() => camera.snapshot);
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [captured, setCaptured] = useState<CapturedFrame | null>(null);
  const [capturedUrl, setCapturedUrl] = useState<string | null>(null);
  const [projectList, setProjectList] = useState<ProjectSummary[]>([]);
  const [saveTo, setSaveTo] = useState<string>('');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => camera.subscribe(setSnapshot), [camera]);

  useEffect(() => {
    void camera.listDevices().then(setDevices);
    void projects.listProjects().then(setProjectList);
  }, [camera, projects]);

  // Attach the live stream to the video element whenever it changes.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = camera.stream;
    if (camera.stream) void video.play().catch(() => undefined);
  }, [snapshot.live, camera]);

  // Object URLs leak until revoked; the browser will not do it for us.
  useEffect(() => {
    if (!captured) {
      setCapturedUrl(null);
      return;
    }
    const url = URL.createObjectURL(captured.blob);
    setCapturedUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [captured]);

  // Releasing the device when leaving the workspace is the safe default: a
  // camera left running behind another screen is exactly what the indicator
  // rules exist to prevent.
  useEffect(() => () => camera.stop('left-workspace'), [camera]);

  const say = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 6000);
  }, []);

  const blocker = camera.blocker();

  const toggle = async () => {
    if (snapshot.live) {
      camera.stop('user');
      return;
    }
    try {
      await camera.start();
      // Labels only become readable after permission is granted.
      setDevices(await camera.listDevices());
    } catch (error) {
      say(toUserMessage(error));
    }
  };

  const takePhoto = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      setCaptured(await camera.capture(video));
    } catch (error) {
      say(toUserMessage(error));
    }
  };

  const saveCapture = async () => {
    if (!captured || saveTo === '') return;
    setBusy(true);
    try {
      await projects.addFileToProject({
        projectId: saveTo,
        file: {
          name: `capture-${new Date(captured.capturedAt).toISOString().replace(/[:.]/g, '-')}.png`,
          size: captured.blob.size,
          type: captured.blob.type,
        },
        data: captured.blob,
      });
      setCaptured(null);
      say('Very good. The capture has been saved to the project, sir.');
    } catch (error) {
      say(toUserMessage(error));
      logger.warn('Could not save a capture.', error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hx-page">
      {notice && (
        <div className="hx-notice hx-notice--warn" role="status">
          {notice}
        </div>
      )}

      <section className="hx-panel">
        <div className="hx-settings__head">
          <h2 className="hx-panel__title">Camera</h2>
          {snapshot.live && (
            <span className="hx-camlive" role="status">
              <span className="hx-camlive__dot" aria-hidden="true" />
              CAMERA ACTIVE
            </span>
          )}
        </div>

        {blocker !== null ? (
          <p className="hx-muted">{blocker}</p>
        ) : (
          <>
            <div className={`hx-preview${snapshot.live ? ' hx-preview--live' : ''}`}>
              <video
                ref={videoRef}
                className="hx-preview__video"
                playsInline
                muted
                aria-label="Camera preview"
              />
              {!snapshot.live && (
                <div className="hx-preview__idle">
                  <Icon name="gesture" size={26} />
                  <p>The camera is off, sir.</p>
                  <p className="hx-muted">Nothing is captured until you turn it on.</p>
                </div>
              )}
            </div>

            <div className="hx-field__actions">
              <button type="button" className="hx-btn" onClick={() => void toggle()}>
                <Icon name={snapshot.live ? 'close' : 'gesture'} size={15} />
                {snapshot.live ? 'Turn off camera' : 'Turn on camera'}
              </button>

              {snapshot.live && (
                <button type="button" className="hx-btn" onClick={() => void takePhoto()}>
                  <Icon name="image" size={15} /> Capture
                </button>
              )}

              {snapshot.width && snapshot.height && (
                <span className="hx-muted">
                  {snapshot.width} &times; {snapshot.height}
                </span>
              )}
            </div>

            {devices.length > 0 && (
              <p className="hx-settings__note">
                {devices.length} {devices.length === 1 ? 'camera' : 'cameras'} detected:{' '}
                {devices.map((device) => device.label).join(', ')}
              </p>
            )}

            <p className="hx-settings__note">
              Nothing is recorded. Helix holds no video buffer, and a still exists only when you
              press Capture.
            </p>
          </>
        )}
      </section>

      {captured && capturedUrl && (
        <section className="hx-panel">
          <h2 className="hx-panel__title">Captured still</h2>
          <img className="hx-capture" src={capturedUrl} alt="Captured still" />
          <p className="hx-settings__note">
            {captured.width} &times; {captured.height} &middot; {formatBytes(captured.blob.size)}
          </p>

          <div className="hx-field__actions">
            <select
              className="hx-select hx-select--inline"
              value={saveTo}
              aria-label="Save to project"
              onChange={(event) => setSaveTo(event.target.value)}
            >
              <option value="">Choose a project&hellip;</option>
              {projectList.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="hx-btn"
              disabled={saveTo === '' || busy}
              onClick={() => void saveCapture()}
            >
              Save to project
            </button>
            <button type="button" className="hx-btn hx-btn--quiet" onClick={() => setCaptured(null)}>
              Discard
            </button>
          </div>

          {projectList.length === 0 && (
            <p className="hx-muted">
              You have no projects to save into as yet, sir. One can be created from Upload Project.
            </p>
          )}
        </section>
      )}

      <section className="hx-panel">
        <h2 className="hx-panel__title">Vision analysis</h2>
        <div className="hx-cap">
          <span className="hx-dot hx-dot--off" />
          <div className="hx-cap__body">
            <div className="hx-cap__name">Not configured</div>
            <div className="hx-cap__reason">{NullVisionProvider.REASON}</div>
          </div>
        </div>
        <p className="hx-settings__note">
          Once a provider is configured, a captured still can be described, questioned, or scanned
          for objects. Until then Helix will not guess at what an image contains.
        </p>
      </section>

      <section className="hx-panel">
        <h2 className="hx-panel__title">Hand tracking</h2>
        <div className="hx-cap">
          <span className="hx-dot hx-dot--off" />
          <div className="hx-cap__body">
            <div className="hx-cap__name">Not available</div>
            <div className="hx-cap__reason">{NullGestureProvider.REASON}</div>
          </div>
        </div>
        <p className="hx-settings__note">
          Pinch to select, drag to move, two hands to scale and rotate. Mouse and keyboard remain
          the supported way to manipulate objects, and will stay so as a fallback.
        </p>
      </section>
    </div>
  );
}
