import { describe, expect, it } from 'vitest';
import {
  isWorkspaceId,
  resolveWorkspace,
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

  it('marks only the workspaces that actually work as implemented', () => {
    // Guards against a workspace being quietly marked done before it is.
    const implemented = WORKSPACE_LIST.filter((w) => w.implemented).map((w) => w.id);
    expect(implemented.sort()).toEqual(['settings', 'system']);
  });

  it('identifies valid ids', () => {
    expect(isWorkspaceId('settings')).toBe(true);
    expect(isWorkspaceId('nonsense')).toBe(false);
  });
});

describe('resolveWorkspace', () => {
  it('resolves an exact id', () => {
    expect(resolveWorkspace('camera')).toBe('camera');
  });

  it('is case and whitespace insensitive', () => {
    expect(resolveWorkspace('  SETTINGS  ')).toBe('settings');
  });

  it('resolves a title', () => {
    expect(resolveWorkspace('3D Viewer')).toBe('viewer');
  });

  it('resolves declared aliases', () => {
    expect(resolveWorkspace('preferences')).toBe('settings');
    expect(resolveWorkspace('webcam')).toBe('camera');
    expect(resolveWorkspace('my projects')).toBe('projects');
  });

  it('resolves an alias embedded in a phrase', () => {
    expect(resolveWorkspace('open camera mode please')).toBe('camera');
    expect(resolveWorkspace('take me to my projects')).toBe('projects');
  });

  it('returns null for empty or unmatched input', () => {
    expect(resolveWorkspace('')).toBeNull();
    expect(resolveWorkspace('   ')).toBeNull();
    expect(resolveWorkspace('order me a pizza')).toBeNull();
  });
});
