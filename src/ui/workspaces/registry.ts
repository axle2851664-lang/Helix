/**
 * Workspace registry (spec 3).
 *
 * Workspaces are declared as data so the nav rail, the router and any future
 * voice command ("Helix, open camera mode") all read from one list rather than
 * each keeping their own copy.
 *
 * `phase` records the milestone that makes a workspace functional. It is shown
 * in the UI: a workspace that cannot do its job yet says so plainly instead of
 * presenting controls that do nothing.
 */

export const WORKSPACE_IDS = [
  'console',
  'projects',
  'camera',
  'viewer',
  'system',
  'settings',
] as const;

export type WorkspaceId = (typeof WORKSPACE_IDS)[number];

export interface WorkspaceDescriptor {
  id: WorkspaceId;
  title: string;
  /** Short description shown in the workspace header. */
  subtitle: string;
  /** Spoken/typed aliases that should resolve to this workspace. */
  aliases: readonly string[];
  /** Milestone at which this workspace becomes functional. */
  phase: number;
  /** True when the workspace does real work today. */
  implemented: boolean;
}

export const WORKSPACES: Readonly<Record<WorkspaceId, WorkspaceDescriptor>> = {
  console: {
    id: 'console',
    title: 'Console',
    subtitle: 'Talk to Helix by voice or text.',
    aliases: ['home', 'chat', 'talk', 'assistant', 'main'],
    phase: 5,
    implemented: false,
  },
  projects: {
    id: 'projects',
    title: 'Projects',
    subtitle: 'Your projects, assets and generated models.',
    aliases: ['project', 'files', 'library', 'my projects'],
    phase: 3,
    implemented: false,
  },
  camera: {
    id: 'camera',
    title: 'Camera',
    subtitle: 'Live camera, vision analysis and gesture input.',
    aliases: ['camera mode', 'vision', 'see', 'webcam'],
    phase: 6,
    implemented: false,
  },
  viewer: {
    id: 'viewer',
    title: '3D Viewer',
    subtitle: 'Inspect and manipulate 3D geometry.',
    aliases: ['3d', 'model', 'mesh', 'three d'],
    phase: 7,
    implemented: false,
  },
  system: {
    id: 'system',
    title: 'System',
    subtitle: 'Host capabilities, storage and activity log.',
    aliases: ['status', 'diagnostics', 'about', 'logs'],
    phase: 2,
    implemented: true,
  },
  settings: {
    id: 'settings',
    title: 'Settings',
    subtitle: 'Providers, privacy, storage and appearance.',
    aliases: ['preferences', 'options', 'config', 'configure'],
    phase: 2,
    implemented: true,
  },
};

export const WORKSPACE_LIST: readonly WorkspaceDescriptor[] = WORKSPACE_IDS.map(
  (id) => WORKSPACES[id],
);

export function isWorkspaceId(value: string): value is WorkspaceId {
  return (WORKSPACE_IDS as readonly string[]).includes(value);
}

/**
 * Resolve free text to a workspace.
 *
 * This is intentionally simple, literal matching - not intent detection. Real
 * intent routing belongs to HelixCore in a later phase; pretending this is more
 * than alias lookup would misrepresent what it does.
 */
export function resolveWorkspace(input: string): WorkspaceId | null {
  const normalized = input.trim().toLowerCase();
  if (normalized === '') return null;
  if (isWorkspaceId(normalized)) return normalized;

  for (const descriptor of WORKSPACE_LIST) {
    if (descriptor.title.toLowerCase() === normalized) return descriptor.id;
    if (descriptor.aliases.includes(normalized)) return descriptor.id;
  }

  // Fall back to a contained alias, e.g. "open camera mode please".
  for (const descriptor of WORKSPACE_LIST) {
    const candidates = [descriptor.id, descriptor.title.toLowerCase(), ...descriptor.aliases];
    if (candidates.some((candidate) => normalized.includes(candidate))) return descriptor.id;
  }

  return null;
}
