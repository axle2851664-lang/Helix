import { useHelix, useSettings } from '../HelixProvider.js';
import { PendingWorkspace } from './PendingWorkspace.js';
import { SettingsWorkspace } from './SettingsWorkspace.js';
import { SystemWorkspace } from './SystemWorkspace.js';
import { ConversationsWorkspace } from './ConversationsWorkspace.js';
import { HomeWorkspace } from '../chat/HomeWorkspace.js';
import { ProjectsWorkspace } from '../projects/ProjectsWorkspace.js';
import { WORKSPACES, type WorkspaceId } from './registry.js';

/**
 * Workspace router. Each id maps to exactly one component; workspaces whose
 * subsystem is not built render PendingWorkspace with their real dependency
 * status rather than a placeholder screen.
 */
export function WorkspaceView({
  workspace,
  conversationId,
  ensureConversation,
  selectedProjectId,
  onSelectProject,
  onOpenProject,
  onNavigate,
  onOpenConversation,
}: {
  workspace: WorkspaceId;
  conversationId: string | null;
  ensureConversation: () => Promise<string>;
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  onOpenProject: (projectId: string) => void;
  onNavigate: (workspace: WorkspaceId) => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  switch (workspace) {
    case 'home':
      return (
        <HomeWorkspace
          conversationId={conversationId}
          ensureConversation={ensureConversation}
          onNavigate={onNavigate}
          onOpenProject={onOpenProject}
        />
      );
    case 'conversations':
      return <ConversationsWorkspace onOpen={onOpenConversation} />;
    case 'settings':
      return <SettingsWorkspace />;
    case 'system':
      return <SystemWorkspace />;
    case 'memory':
      return <MemoryPending />;
    case 'files':
      return <FilesPending />;
    case 'web-research':
      return <WebResearchPending />;
    case 'coding':
      return <CodingPending />;
    case 'image-generation':
      return <ImageGenerationPending />;
    case 'earth':
      return <EarthPending />;
    case 'storage':
      return <StoragePending />;
    case 'upload-project':
      return (
        <ProjectsWorkspace
          selectedProjectId={selectedProjectId}
          onSelectProject={onSelectProject}
        />
      );
    case 'gesture-control':
      return <GestureControlPending />;
    default: {
      const never: never = workspace;
      void never;
      return null;
    }
  }
}

function MemoryPending() {
  const settings = useSettings(['allowLongTermMemory']);
  return (
    <PendingWorkspace
      descriptor={WORKSPACES.memory}
      planned={[
        'Inspect and delete anything Helix has remembered.',
        'Separate short-term, long-term, project and file memory.',
        'Save a memory only when you explicitly ask for one.',
        'Search memory semantically once an embedding provider exists.',
      ]}
      inPlace={[
        'Namespaced durable storage is working, so memory cannot collide with settings or projects.',
        `Long-term memory is currently ${settings.allowLongTermMemory ? 'allowed' : 'disabled'} in Settings.`,
        'Conversation memory is implemented and is deliberately not promoted to long-term storage.',
        'MEMORY_SAVED and MEMORY_DELETED events are declared.',
      ]}
      blockedBy="Semantic search needs an embedding provider, and none is configured. Keyword memory search does not need one and lands first."
    />
  );
}

function FilesPending() {
  const { paths, platform } = useHelix();
  return (
    <PendingWorkspace
      descriptor={WORKSPACES.files}
      planned={[
        'Import files into a controlled Helix workspace.',
        'Index contents for search, with previews.',
        'Track assets by stable id rather than filename.',
        'Report per-file storage usage.',
      ]}
      inPlace={[
        `File paths resolve portably (${paths.getDataPath()}) and survive a drive-letter change.`,
        'Workspace containment is enforced and tested, so Helix cannot read outside its own folder.',
      ]}
      requires={[{ label: 'Filesystem access', status: platform.capabilities.filesystem }]}
    />
  );
}

function WebResearchPending() {
  const { platform } = useHelix();
  return (
    <PendingWorkspace
      descriptor={WORKSPACES['web-research']}
      planned={[
        'Search the web and summarise results with citations.',
        'Fetch and read a specific page on request.',
        'Show which sources were used for an answer.',
      ]}
      inPlace={[
        'Connectivity is tracked, and Helix stops retrying cloud requests when offline.',
        `This host currently reports ${platform.isOnline() ? 'online' : 'offline'}.`,
      ]}
      blockedBy="No web search provider is configured, and the app's content security policy currently permits no external origins. Both are set up in phase 6."
    />
  );
}

function CodingPending() {
  return (
    <PendingWorkspace
      descriptor={WORKSPACES.coding}
      planned={[
        'Read and explain code from an imported project.',
        'Propose edits for review before anything is written.',
        'Run project tests and report results.',
      ]}
      inPlace={[
        'Workspace containment prevents Helix reading outside its own folder.',
        'Generated code is never executed automatically.',
      ]}
      blockedBy="Requires a language provider, which is not configured."
    />
  );
}

function ImageGenerationPending() {
  const { platform } = useHelix();
  return (
    <PendingWorkspace
      descriptor={WORKSPACES['image-generation']}
      planned={[
        'Generate images from a prompt.',
        'Save results into a project with their prompt and settings.',
        'Feed a generated image into the 2D-to-3D pipeline.',
      ]}
      inPlace={['Generated assets have a reserved storage location, separate from originals.']}
      requires={[{ label: 'GPU acceleration', status: platform.capabilities.webgl2 }]}
      blockedBy="No image provider is configured. Local image generation is additionally not viable on this machine's integrated GPU, which has no dedicated VRAM - a cloud provider is the realistic route here."
    />
  );
}

function EarthPending() {
  const { platform } = useHelix();
  return (
    <PendingWorkspace
      descriptor={WORKSPACES.earth}
      planned={[
        'Interactive 3D globe with search by place name.',
        'Coordinates, markers, distance and area measurement.',
        'Map and terrain layers from licensed or open data.',
      ]}
      inPlace={['GeographicDataProvider is designed as a replaceable interface.']}
      requires={[{ label: 'WebGL2', status: platform.capabilities.webgl2 }]}
      blockedBy="Requires a map data provider and a 3D renderer, neither of which is bundled. Helix will use properly licensed sources and will say when imagery for a location does not exist rather than substituting something else."
    />
  );
}

function StoragePending() {
  const { store, paths } = useHelix();
  const durable = (store as { durable?: boolean }).durable ?? false;
  return (
    <PendingWorkspace
      descriptor={WORKSPACES.storage}
      planned={[
        'Break usage down by core, models, projects, generated assets, cache and logs.',
        'Warn at 75, 85, 95 and 99 percent of the configured ceiling.',
        'Clean cache and temporary files, never user data.',
        'Block an install that would exceed the limit, before it starts.',
      ]}
      inPlace={[
        `Data root resolves to ${paths.dataRoot} and moves with the drive.`,
        `Durable storage is ${durable ? 'active' : 'unavailable'}.`,
        'The storage ceiling is stored in Settings and defaults to 500 GB.',
        'STORAGE_WARNING is declared with severity levels.',
      ]}
      blockedBy="Real disk figures need the Tauri shell. A browser reports only an origin quota, which is not free space, so Helix will not present one as the other."
    />
  );
}

function GestureControlPending() {
  const { platform } = useHelix();
  return (
    <PendingWorkspace
      descriptor={WORKSPACES['gesture-control']}
      planned={[
        'Live camera preview with an always-visible active indicator.',
        'Hand tracking: pinch to select, drag to move, two hands to scale and rotate.',
        'Analyse a captured frame through a vision provider.',
        'Mouse and keyboard fallback for every gesture.',
      ]}
      inPlace={[
        'Camera permission is never requested implicitly.',
        'CAMERA_STARTED and CAMERA_STOPPED events exist so the active indicator cannot drift out of sync with the device.',
        'Nothing is recorded by default, and the log redactor refuses to serialise camera frames.',
      ]}
      requires={[
        { label: 'Camera', status: platform.capabilities.camera },
        { label: 'WebGL2', status: platform.capabilities.webgl2 },
      ]}
      blockedBy="Hand tracking needs MediaPipe, which is not bundled yet. Gestures will not be simulated with mouse events."
    />
  );
}
