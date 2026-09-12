import { describe, expect, it } from 'vitest';
import {
  isWorkspaceId,
  resolveWorkspace,
  SIDEBAR_WORKSPACES,
  WORKSPACE_IDS,
  WORKSPACE_LIST,
  WORKSPACES,
} from './registry.js';

describe('workspace registry', () => {
  it('exposes a descriptor for every id', () => {
    for (const id of WORKSPACE_IDS) {
      expect(WORKSPACES[id]).toBeDefined();
      expect(WORKSPACES[id].id).toBe(id);
    }
    expect(WORKSPACE_LIST).toHaveLength(WORKSPACE_IDS.length);
  });

  // Matches the reference interface's eleven navigable entries.
  it('lists the sidebar workspaces in reference order', () => {
    expect(SIDEBAR_WORKSPACES.map((w) => w.id)).toEqual([
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
    ]);
  });

  it('keeps home and system out of the sidebar', () => {
    expect(WORKSPACES.home.inSidebar).toBe(false);
    expect(WORKSPACES.system.inSidebar).toBe(false);
  });

  it('marks only genuinely working workspaces as implemented', () => {
    const implemented = WORKSPACE_LIST.filter((w) => w.implemented).map((w) => w.id).sort();
    expect(implemented).toEqual([
      // Coding writes code with a local model and shows it. It does not read
      // a project or run anything, which is why the subtitle says what it
      // does rather than what the workspace was once planned to do.
      'coding',
      'conversations',
      'files',
      'gesture-control',
      'graph',
      'home',
      'memory',
      'models',
      'settings',
      'spatial',
      'storage',
      'system',
      'upload-project',
    ]);
  });

  it('identifies valid ids', () => {
    expect(isWorkspaceId('memory')).toBe(true);
    expect(isWorkspaceId('nonsense')).toBe(false);
  });
});

describe('resolveWorkspace', () => {
  it('resolves an exact id', () => {
    expect(resolveWorkspace('memory')).toBe('memory');
    expect(resolveWorkspace('web-research')).toBe('web-research');
  });

  it('is case and whitespace insensitive', () => {
    expect(resolveWorkspace('  SETTINGS  ')).toBe('settings');
  });

  it('resolves a title', () => {
    expect(resolveWorkspace('Helix Earth')).toBe('earth');
    expect(resolveWorkspace('Image Generation')).toBe('image-generation');
  });

  it('resolves declared aliases', () => {
    expect(resolveWorkspace('preferences')).toBe('settings');
    expect(resolveWorkspace('webcam')).toBe('gesture-control');
    expect(resolveWorkspace('globe')).toBe('earth');
    expect(resolveWorkspace('disk')).toBe('storage');
  });

  it('resolves an alias embedded in a phrase', () => {
    expect(resolveWorkspace('open camera mode please')).toBe('gesture-control');
    expect(resolveWorkspace('take me to my settings')).toBe('settings');
    expect(resolveWorkspace('show me the globe')).toBe('earth');
  });

  // "new conversation" must not be shortened to the Conversations list.
  it('prefers the longest matching alias', () => {
    expect(resolveWorkspace('start a new conversation')).toBe('home');
    expect(resolveWorkspace('open conversations')).toBe('conversations');
  });

  it('returns null for empty or unmatched input', () => {
    expect(resolveWorkspace('')).toBeNull();
    expect(resolveWorkspace('   ')).toBeNull();
    expect(resolveWorkspace('order me a pizza')).toBeNull();
  });
});
