import { describe, expect, it } from 'vitest';
import { HelixError } from '../core/HelixError.js';
import { joinPath, normalizePath, PathManager } from './PathManager.js';

describe('normalizePath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('E:\\Helix\\projects')).toBe('E:/Helix/projects');
  });

  it('collapses redundant separators and dot segments', () => {
    expect(normalizePath('E:/Helix//./projects/')).toBe('E:/Helix/projects');
  });

  it('resolves parent segments', () => {
    expect(normalizePath('E:/Helix/projects/../models')).toBe('E:/Helix/models');
  });

  it('clamps traversal at an absolute root rather than escaping it', () => {
    expect(normalizePath('E:/Helix/../../../..')).toBe('E:/');
    expect(normalizePath('/a/../../..')).toBe('/');
  });

  it('keeps leading parent segments on a relative path', () => {
    expect(normalizePath('../sibling')).toBe('../sibling');
  });

  it('preserves a UNC prefix', () => {
    expect(normalizePath('\\\\server\\share\\Helix')).toBe('//server/share/Helix');
  });
});

describe('joinPath', () => {
  it('joins and normalises', () => {
    expect(joinPath('E:/Helix', 'projects', 'ironman')).toBe('E:/Helix/projects/ironman');
  });

  it('ignores empty segments', () => {
    expect(joinPath('E:/Helix', '', 'models')).toBe('E:/Helix/models');
  });

  it('returns an empty string when given nothing', () => {
    expect(joinPath()).toBe('');
  });
});

describe('PathManager', () => {
  const portable = () => new PathManager({ root: 'E:/Helix', portable: true });

  it('refuses an empty root with a user-readable message', () => {
    expect(() => new PathManager({ root: '' })).toThrow(HelixError);
    try {
      new PathManager({ root: '' });
    } catch (error) {
      expect((error as HelixError).userMessage).not.toContain('PathManager');
    }
  });

  it('requires an explicit dataRoot when not portable', () => {
    expect(() => new PathManager({ root: 'C:/Program Files/Helix', portable: false })).toThrow(
      HelixError,
    );
  });

  it('resolves each Helix directory under the root when portable', () => {
    const paths = portable();
    expect(paths.getProjectPath()).toBe('E:/Helix/projects');
    expect(paths.getModelPath()).toBe('E:/Helix/models');
    expect(paths.getConfigPath()).toBe('E:/Helix/config');
    expect(paths.getCachePath()).toBe('E:/Helix/cache');
    expect(paths.getLogPath()).toBe('E:/Helix/logs');
    expect(paths.getMemoryPath()).toBe('E:/Helix/memory');
    expect(paths.getTempPath()).toBe('E:/Helix/temp');
    expect(paths.getBackupPath()).toBe('E:/Helix/backups');
  });

  it('accepts trailing path segments', () => {
    expect(portable().getProjectPath('ironman', 'reference.png')).toBe(
      'E:/Helix/projects/ironman/reference.png',
    );
  });

  it('separates data from the app directory when not portable', () => {
    const paths = new PathManager({
      root: 'C:/Program Files/Helix',
      portable: false,
      dataRoot: 'C:/HelixData',
    });
    expect(paths.getAppPath()).toBe('C:/Program Files/Helix/app');
    expect(paths.getProjectPath()).toBe('C:/HelixData/projects');
    expect(paths.isPortable).toBe(false);
  });

  // The requirement this module exists for: E:\Helix -> F:\Helix must be
  // invisible to anything already stored.
  it('survives a drive-letter change for stored paths', () => {
    const onE = new PathManager({ root: 'E:/Helix' });
    const stored = onE.toPortable('E:/Helix/projects/ironman/reference.png');
    expect(stored).toBe('projects/ironman/reference.png');
    expect(stored).not.toMatch(/^[A-Za-z]:/);

    const onF = new PathManager({ root: 'F:/Helix' });
    expect(onF.fromPortable(stored)).toBe('F:/Helix/projects/ironman/reference.png');
  });

  it('round-trips a path through portable form unchanged', () => {
    const paths = portable();
    const absolute = paths.getProjectPath('ironman', 'notes.md');
    expect(paths.fromPortable(paths.toPortable(absolute))).toBe(absolute);
  });

  it('treats a drive letter case-insensitively, as Windows does', () => {
    const paths = new PathManager({ root: 'E:/Helix' });
    expect(paths.toPortable('e:/helix/projects/a.png')).toBe('projects/a.png');
  });

  it('refuses to store a path outside the workspace', () => {
    expect(() => portable().toPortable('C:/Windows/System32/config')).toThrow(HelixError);
  });

  it('refuses an absolute path where a portable one is expected', () => {
    expect(() => portable().fromPortable('E:/Helix/projects/a.png')).toThrow(HelixError);
  });

  describe('workspace containment', () => {
    it('accepts paths inside the workspace', () => {
      const paths = portable();
      expect(paths.isWithinWorkspace('projects/ironman')).toBe(true);
      expect(paths.isWithinWorkspace('E:/Helix/models/llm.gguf')).toBe(true);
      expect(paths.isWithinWorkspace('E:/Helix')).toBe(true);
    });

    it('rejects traversal that escapes the workspace', () => {
      const paths = portable();
      expect(paths.isWithinWorkspace('../outside')).toBe(false);
      expect(paths.isWithinWorkspace('projects/../../outside')).toBe(false);
      expect(paths.isWithinWorkspace('C:/Windows')).toBe(false);
    });

    it('rejects a sibling directory sharing a name prefix', () => {
      // "E:/HelixSecrets" must not pass merely because it starts with "E:/Helix".
      expect(portable().isWithinWorkspace('E:/HelixSecrets/keys.txt')).toBe(false);
    });

    it('assertWithinWorkspace throws a permission error on escape', () => {
      try {
        portable().assertWithinWorkspace('../../etc/passwd');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HelixError);
        expect((error as HelixError).code).toBe('PERMISSION_DENIED');
      }
    });

    it('assertWithinWorkspace returns the resolved path when valid', () => {
      expect(portable().assertWithinWorkspace('projects/ironman')).toBe(
        'E:/Helix/projects/ironman',
      );
    });
  });
});
