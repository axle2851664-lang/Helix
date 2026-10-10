import { describe, expect, it } from 'vitest';
import { HavocError } from '../core/HavocError.js';
import { joinPath, normalizePath, PathManager } from './PathManager.js';

describe('normalizePath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('E:\\Havoc\\projects')).toBe('E:/Havoc/projects');
  });

  it('collapses redundant separators and dot segments', () => {
    expect(normalizePath('E:/Havoc//./projects/')).toBe('E:/Havoc/projects');
  });

  it('resolves parent segments', () => {
    expect(normalizePath('E:/Havoc/projects/../models')).toBe('E:/Havoc/models');
  });

  it('clamps traversal at an absolute root rather than escaping it', () => {
    expect(normalizePath('E:/Havoc/../../../..')).toBe('E:/');
    expect(normalizePath('/a/../../..')).toBe('/');
  });

  it('keeps leading parent segments on a relative path', () => {
    expect(normalizePath('../sibling')).toBe('../sibling');
  });

  it('preserves a UNC prefix', () => {
    expect(normalizePath('\\\\server\\share\\Havoc')).toBe('//server/share/Havoc');
  });
});

describe('joinPath', () => {
  it('joins and normalises', () => {
    expect(joinPath('E:/Havoc', 'projects', 'ironman')).toBe('E:/Havoc/projects/ironman');
  });

  it('ignores empty segments', () => {
    expect(joinPath('E:/Havoc', '', 'models')).toBe('E:/Havoc/models');
  });

  it('returns an empty string when given nothing', () => {
    expect(joinPath()).toBe('');
  });
});

describe('PathManager', () => {
  const portable = () => new PathManager({ root: 'E:/Havoc', portable: true });

  it('refuses an empty root with a user-readable message', () => {
    expect(() => new PathManager({ root: '' })).toThrow(HavocError);
    try {
      new PathManager({ root: '' });
    } catch (error) {
      expect((error as HavocError).userMessage).not.toContain('PathManager');
    }
  });

  it('requires an explicit dataRoot when not portable', () => {
    expect(() => new PathManager({ root: 'C:/Program Files/Havoc', portable: false })).toThrow(
      HavocError,
    );
  });

  it('resolves each Havoc directory under the root when portable', () => {
    const paths = portable();
    expect(paths.getProjectPath()).toBe('E:/Havoc/projects');
    expect(paths.getModelPath()).toBe('E:/Havoc/models');
    expect(paths.getConfigPath()).toBe('E:/Havoc/config');
    expect(paths.getCachePath()).toBe('E:/Havoc/cache');
    expect(paths.getLogPath()).toBe('E:/Havoc/logs');
    expect(paths.getMemoryPath()).toBe('E:/Havoc/memory');
    expect(paths.getTempPath()).toBe('E:/Havoc/temp');
    expect(paths.getBackupPath()).toBe('E:/Havoc/backups');
  });

  it('accepts trailing path segments', () => {
    expect(portable().getProjectPath('ironman', 'reference.png')).toBe(
      'E:/Havoc/projects/ironman/reference.png',
    );
  });

  it('separates data from the app directory when not portable', () => {
    const paths = new PathManager({
      root: 'C:/Program Files/Havoc',
      portable: false,
      dataRoot: 'C:/HavocData',
    });
    expect(paths.getAppPath()).toBe('C:/Program Files/Havoc/app');
    expect(paths.getProjectPath()).toBe('C:/HavocData/projects');
    expect(paths.isPortable).toBe(false);
  });

  // The requirement this module exists for: E:\Havoc -> F:\Havoc must be
  // invisible to anything already stored.
  it('survives a drive-letter change for stored paths', () => {
    const onE = new PathManager({ root: 'E:/Havoc' });
    const stored = onE.toPortable('E:/Havoc/projects/ironman/reference.png');
    expect(stored).toBe('projects/ironman/reference.png');
    expect(stored).not.toMatch(/^[A-Za-z]:/);

    const onF = new PathManager({ root: 'F:/Havoc' });
    expect(onF.fromPortable(stored)).toBe('F:/Havoc/projects/ironman/reference.png');
  });

  it('round-trips a path through portable form unchanged', () => {
    const paths = portable();
    const absolute = paths.getProjectPath('ironman', 'notes.md');
    expect(paths.fromPortable(paths.toPortable(absolute))).toBe(absolute);
  });

  it('treats a drive letter case-insensitively, as Windows does', () => {
    const paths = new PathManager({ root: 'E:/Havoc' });
    expect(paths.toPortable('e:/havoc/projects/a.png')).toBe('projects/a.png');
  });

  it('refuses to store a path outside the workspace', () => {
    expect(() => portable().toPortable('C:/Windows/System32/config')).toThrow(HavocError);
  });

  it('refuses an absolute path where a portable one is expected', () => {
    expect(() => portable().fromPortable('E:/Havoc/projects/a.png')).toThrow(HavocError);
  });

  describe('workspace containment', () => {
    it('accepts paths inside the workspace', () => {
      const paths = portable();
      expect(paths.isWithinWorkspace('projects/ironman')).toBe(true);
      expect(paths.isWithinWorkspace('E:/Havoc/models/llm.gguf')).toBe(true);
      expect(paths.isWithinWorkspace('E:/Havoc')).toBe(true);
    });

    it('rejects traversal that escapes the workspace', () => {
      const paths = portable();
      expect(paths.isWithinWorkspace('../outside')).toBe(false);
      expect(paths.isWithinWorkspace('projects/../../outside')).toBe(false);
      expect(paths.isWithinWorkspace('C:/Windows')).toBe(false);
    });

    it('rejects a sibling directory sharing a name prefix', () => {
      // "E:/HavocSecrets" must not pass merely because it starts with "E:/Havoc".
      expect(portable().isWithinWorkspace('E:/HavocSecrets/keys.txt')).toBe(false);
    });

    it('assertWithinWorkspace throws a permission error on escape', () => {
      try {
        portable().assertWithinWorkspace('../../etc/passwd');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HavocError);
        expect((error as HavocError).code).toBe('PERMISSION_DENIED');
      }
    });

    it('assertWithinWorkspace returns the resolved path when valid', () => {
      expect(portable().assertWithinWorkspace('projects/ironman')).toBe(
        'E:/Havoc/projects/ironman',
      );
    });
  });
});
