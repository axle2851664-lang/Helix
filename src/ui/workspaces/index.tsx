import { useHelix, useSettings } from '../HelixProvider.js';
import { PendingWorkspace } from './PendingWorkspace.js';
import { SettingsWorkspace } from './SettingsWorkspace.js';
import { SystemWorkspace } from './SystemWorkspace.js';
import { WORKSPACES, type WorkspaceId } from './registry.js';

/**
 * Workspace router. Each id maps to exactly one component; workspaces whose
 * subsystem is not built render PendingWorkspace with their real dependency
 * status rather than a placeholder screen.
 */
export function WorkspaceView({ workspace }: { workspace: WorkspaceId }) {
  switch (workspace) {
    case 'settings':
      return <SettingsWorkspace />;
    case 'system':
      return <SystemWorkspace />;
    case 'console':
      return <ConsolePending />;
    case 'projects':
      return <ProjectsPending />;
    case 'camera':
      return <CameraPending />;
    case 'viewer':
      return <ViewerPending />;
    default: {
      const never: never = workspace;
      void never;
      return null;
    }
  }
}

function ConsolePending() {
  const { platform } = useHelix();
  const settings = useSettings(['speechToTextProvider', 'languageProvider']);

  return (
    <PendingWorkspace
      descriptor={WORKSPACES.console}
      planned={[
        'Speak or type to Helix and see a running transcript.',
        'Push-to-talk, with an optional wake word.',
        'Interrupt Helix while it is speaking.',
        'Watch which tools Helix invokes for a request.',
      ]}
      inPlace={[
        'Helix status states (idle, listening, thinking, speaking, processing, error) are implemented and driven by real state.',
        'The event bus that carries microphone and speech events exists and is tested.',
        'Voice provider selection is stored in Settings and will be read by the pipeline when it lands.',
      ]}
      requires={[{ label: 'Microphone', status: platform.capabilities.microphone }]}
      blockedBy={
        <>
          No language provider is configured (currently{' '}
          <strong>{settings.languageProvider}</strong>) and no speech provider is configured
          (currently <strong>{settings.speechToTextProvider}</strong>). Helix will not claim to
          answer a question until a real provider is connected.
        </>
      }
    />
  );
}

function ProjectsPending() {
  const { paths } = useHelix();
  return (
    <PendingWorkspace
      descriptor={WORKSPACES.projects}
      planned={[
        'Create a project when you import a file, and require a name for it.',
        'Keep the original file separate from anything generated from it.',
        'Search projects by name, so "open my Iron Man project" resolves.',
        'Track assets with stable ids rather than filenames.',
      ]}
      inPlace={[
        `Project paths resolve portably (currently ${paths.getProjectPath()}) and survive a drive-letter change.`,
        'Namespaced, durable storage is working and covered by a shared contract test.',
        'PROJECT_CREATED, PROJECT_OPENED and PROJECT_DELETED events are declared.',
      ]}
    />
  );
}

function CameraPending() {
  const { platform } = useHelix();
  return (
    <PendingWorkspace
      descriptor={WORKSPACES.camera}
      planned={[
        'Live camera preview with an always-visible active indicator.',
        'Capture a frame and send it for vision analysis.',
        'Show detected regions where a provider supports them.',
        'Feed frames to the hand-tracking provider in phase 9.',
      ]}
      inPlace={[
        'Camera permission is never requested implicitly; it will be an explicit action.',
        'CAMERA_STARTED and CAMERA_STOPPED events exist so the indicator cannot drift out of sync with the device.',
        'Nothing is recorded or stored by default, and frames are excluded from logs by the redactor.',
      ]}
      requires={[{ label: 'Camera', status: platform.capabilities.camera }]}
    />
  );
}

function ViewerPending() {
  const { platform } = useHelix();
  return (
    <PendingWorkspace
      descriptor={WORKSPACES.viewer}
      planned={[
        'Orbit, zoom, pan and reset on real geometry.',
        'Select, move, rotate and scale a loaded model.',
        'Switch lighting and environment.',
        'Show model information read from the file, never estimated.',
      ]}
      inPlace={[
        'Transform operations will be shared with gesture input, so both drive the same state.',
        'MODEL_GENERATION_* and SPATIAL_OBJECT_* events are declared.',
      ]}
      requires={[{ label: 'WebGL2', status: platform.capabilities.webgl2 }]}
      blockedBy="No 3D renderer is bundled yet. Three.js is added in phase 7; until then there is no geometry to display, and Helix will not show a picture in place of a model."
    />
  );
}
