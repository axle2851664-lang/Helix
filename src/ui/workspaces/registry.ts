/**
 * Workspace registry (spec 3, and the reference interface's left navigation).
 *
 * Workspaces are declared as data so the sidebar, the router and the
 * orchestrator's navigation tool all read one list rather than each keeping
 * their own copy. Adding a workspace is a single entry here.
 *
 * `phase` records the milestone that makes a workspace functional, and
 * `implemented` is the honest flag the UI keys off: a workspace that cannot do
 * its job yet says so rather than presenting controls that do nothing.
 */

export const WORKSPACE_IDS = [
  'home',
  'conversations',
  'memory',
  'files',
  'web-research',
  'coding',
  'image-generation',
  'earth',
  'storage',
  'upload-project',
  'gesture-control',
  'spatial',
  'graph',
  'models',
  'settings',
  'system',
] as const;

export type WorkspaceId = (typeof WORKSPACE_IDS)[number];

export interface WorkspaceDescriptor {
  id: WorkspaceId;
  title: string;
  subtitle: string;
  /** Spoken or typed aliases that should resolve to this workspace. */
  aliases: readonly string[];
  phase: number;
  implemented: boolean;
  /** False for entries reachable only indirectly (e.g. the status panel). */
  inSidebar: boolean;
}

export const WORKSPACES: Readonly<Record<WorkspaceId, WorkspaceDescriptor>> = {
  home: {
    id: 'home',
    title: 'Helix',
    subtitle: 'Ask anything by voice or text.',
    aliases: ['chat', 'assistant', 'main', 'console', 'talk', 'new conversation'],
    phase: 3,
    implemented: true,
    inSidebar: false,
  },
  conversations: {
    id: 'conversations',
    title: 'Conversations',
    subtitle: 'Your saved conversations.',
    aliases: ['history', 'chats', 'transcripts'],
    phase: 3,
    implemented: true,
    inSidebar: true,
  },
  memory: {
    id: 'memory',
    title: 'Memory',
    subtitle: 'What Helix remembers, and what it forgets.',
    aliases: ['memories', 'remember', 'recall'],
    phase: 4,
    implemented: true,
    inSidebar: true,
  },
  files: {
    id: 'files',
    title: 'Files',
    subtitle: 'Indexed files and knowledge.',
    aliases: ['documents', 'knowledge', 'library'],
    phase: 4,
    implemented: true,
    inSidebar: true,
  },
  'web-research': {
    id: 'web-research',
    title: 'Web Research',
    subtitle: 'Search and summarise the web.',
    aliases: ['web', 'search', 'research', 'browse', 'internet'],
    phase: 6,
    implemented: false,
    inSidebar: true,
  },
  coding: {
    id: 'coding',
    title: 'Coding',
    subtitle: 'Write code, locally. Nothing is run.',
    aliases: ['code', 'programming', 'develop', 'write code'],
    phase: 6,
    implemented: true,
    inSidebar: true,
  },
  'image-generation': {
    id: 'image-generation',
    title: 'Image Generation',
    subtitle: 'Generate and edit images.',
    aliases: ['images', 'image', 'generate image', 'art', 'picture'],
    phase: 8,
    implemented: false,
    inSidebar: true,
  },
  earth: {
    id: 'earth',
    title: 'Helix Earth',
    subtitle: 'Maps, globe and geographic data.',
    aliases: ['map', 'maps', 'globe', 'geography', 'earth', 'location'],
    phase: 10,
    implemented: false,
    inSidebar: true,
  },
  storage: {
    id: 'storage',
    title: 'Storage',
    subtitle: 'Space used by Helix and its data.',
    aliases: ['disk', 'space', 'usage', 'capacity'],
    phase: 11,
    implemented: true,
    inSidebar: true,
  },
  'upload-project': {
    id: 'upload-project',
    title: 'Upload Project',
    subtitle: 'Import files and create a project.',
    aliases: ['import', 'upload', 'new project', 'projects', 'project'],
    phase: 3,
    implemented: true,
    inSidebar: true,
  },
  'gesture-control': {
    id: 'gesture-control',
    title: 'Gesture Control',
    subtitle: 'Camera, vision and hand tracking.',
    aliases: ['camera', 'camera mode', 'gestures', 'hands', 'vision', 'webcam'],
    phase: 7,
    implemented: true,
    inSidebar: true,
  },
  spatial: {
    id: 'spatial',
    title: 'Spatial',
    subtitle: 'Manipulate objects by hand over the camera view.',
    aliases: ['spatial mode', 'objects', 'stage', 'hand control', 'manipulate'],
    phase: 7,
    implemented: true,
    inSidebar: true,
  },
  graph: {
    id: 'graph',
    title: 'Graph',
    subtitle: 'Your notes and the links between them.',
    aliases: ['vault', 'notes graph', 'links', 'map of notes', 'knowledge graph'],
    phase: 4,
    implemented: true,
    inSidebar: true,
  },
  models: {
    id: 'models',
    title: 'Local AI',
    subtitle: 'Models on this machine, and what will fit.',
    aliases: ['models', 'local ai', 'local model', 'ollama', 'brain', 'llm'],
    phase: 6,
    implemented: true,
    inSidebar: true,
  },
  settings: {
    id: 'settings',
    title: 'Settings',
    subtitle: 'Providers, privacy, storage and appearance.',
    aliases: ['preferences', 'options', 'config', 'configure'],
    phase: 2,
    implemented: true,
    inSidebar: true,
  },
  system: {
    id: 'system',
    title: 'System',
    subtitle: 'Host capabilities, hardware and activity log.',
    aliases: ['status', 'diagnostics', 'about', 'logs', 'health'],
    phase: 2,
    implemented: true,
    // Reached from the status panel rather than the sidebar, matching the
    // reference interface, which has no System entry in its navigation.
    inSidebar: false,
  },
};

export const WORKSPACE_LIST: readonly WorkspaceDescriptor[] = WORKSPACE_IDS.map(
  (id) => WORKSPACES[id],
);

export const SIDEBAR_WORKSPACES: readonly WorkspaceDescriptor[] = WORKSPACE_LIST.filter(
  (workspace) => workspace.inSidebar,
);

export function isWorkspaceId(value: string): value is WorkspaceId {
  return (WORKSPACE_IDS as readonly string[]).includes(value);
}

/**
 * Resolve free text to a workspace.
 *
 * Deliberately literal alias matching, not intent detection. Real intent
 * routing belongs to a language provider in a later phase; presenting this as
 * more than lookup would misrepresent what it does.
 */
export function resolveWorkspace(input: string): WorkspaceId | null {
  const normalized = input.trim().toLowerCase();
  if (normalized === '') return null;
  if (isWorkspaceId(normalized)) return normalized;

  for (const descriptor of WORKSPACE_LIST) {
    if (descriptor.title.toLowerCase() === normalized) return descriptor.id;
    if (descriptor.aliases.includes(normalized)) return descriptor.id;
  }

  // Fall back to a contained alias, e.g. "open camera mode please". Longest
  // candidates are tried first so "new conversation" beats "conversation".
  const candidates: Array<{ id: WorkspaceId; text: string }> = [];
  for (const descriptor of WORKSPACE_LIST) {
    candidates.push({ id: descriptor.id, text: descriptor.id });
    candidates.push({ id: descriptor.id, text: descriptor.title.toLowerCase() });
    for (const alias of descriptor.aliases) candidates.push({ id: descriptor.id, text: alias });
  }
  candidates.sort((a, b) => b.text.length - a.text.length);

  for (const candidate of candidates) {
    if (normalized.includes(candidate.text)) return candidate.id;
  }

  return null;
}
