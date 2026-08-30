import { describe, expect, it } from 'vitest';
import { HelixError } from '../core/HelixError.js';
import {
  ACCEPT_ATTRIBUTE,
  fileExtension,
  formatBytes,
  kindForFile,
  sanitizeFileName,
  validateUpload,
} from './validation.js';

describe('fileExtension', () => {
  it('reads the extension', () => {
    expect(fileExtension('ironman.png')).toBe('png');
    expect(fileExtension('archive.tar.gz')).toBe('gz');
  });

  it('lowercases it', () => {
    expect(fileExtension('IMAGE.PNG')).toBe('png');
  });

  it('returns empty when there is none', () => {
    expect(fileExtension('README')).toBe('');
    expect(fileExtension('.gitignore')).toBe('');
    expect(fileExtension('trailing.')).toBe('');
  });
});

describe('sanitizeFileName', () => {
  it('keeps an ordinary name', () => {
    expect(sanitizeFileName('iron man ref.png')).toBe('iron man ref.png');
  });

  // The important cases: a name must never carry a path out of the workspace.
  it('strips directory components', () => {
    expect(sanitizeFileName('C:\\Windows\\System32\\evil.png')).toBe('evil.png');
    expect(sanitizeFileName('../../etc/passwd.txt')).toBe('passwd.txt');
    expect(sanitizeFileName('folder/sub/image.png')).toBe('image.png');
  });

  it('removes characters Windows forbids', () => {
    expect(sanitizeFileName('a<b>c:d"e|f?g*h.png')).toBe('abcdefgh.png');
  });

  it('removes leading dots', () => {
    expect(sanitizeFileName('...hidden.png')).toBe('hidden.png');
  });

  it('does not blank an ordinary name', () => {
    // Guards a regression where the leading-dot rule matched the whole string.
    expect(sanitizeFileName('reference.png')).toBe('reference.png');
    expect(sanitizeFileName('a.b.c.png')).toBe('a.b.c.png');
  });

  it('falls back when nothing usable remains', () => {
    expect(sanitizeFileName('///')).toBe('unnamed');
    expect(sanitizeFileName('   ')).toBe('unnamed');
  });

  it('caps the length', () => {
    expect(sanitizeFileName(`${'x'.repeat(400)}.png`).length).toBeLessThanOrEqual(180);
  });
});

describe('kindForFile', () => {
  it('classifies by extension', () => {
    expect(kindForFile('a.png', '')).toBe('image');
    expect(kindForFile('a.glb', '')).toBe('model3d');
    expect(kindForFile('a.md', '')).toBe('document');
    expect(kindForFile('a.json', '')).toBe('data');
  });

  it('falls back to the mime type', () => {
    expect(kindForFile('blob', 'image/png')).toBe('image');
  });

  it('returns other for anything unrecognised', () => {
    expect(kindForFile('a.xyz', '')).toBe('other');
  });
});

describe('validateUpload', () => {
  const file = (name: string, size = 1024, type = '') => ({ name, size, type });

  it('accepts a supported image', () => {
    const result = validateUpload(file('ironman.png', 2048, 'image/png'));
    expect(result.kind).toBe('image');
    expect(result.fileName).toBe('ironman.png');
    expect(result.sizeBytes).toBe(2048);
  });

  it('accepts 3D, document and data files', () => {
    expect(validateUpload(file('suit.glb')).kind).toBe('model3d');
    expect(validateUpload(file('notes.md')).kind).toBe('document');
    expect(validateUpload(file('data.csv')).kind).toBe('data');
  });

  // Spec 18/24: programs and scripts must never enter the workspace.
  it('refuses executables and scripts with a clear reason', () => {
    for (const name of ['setup.exe', 'run.bat', 'script.ps1', 'payload.js', 'lib.dll', 'go.sh']) {
      let thrown: unknown;
      try {
        validateUpload(file(name));
      } catch (error) {
        thrown = error;
      }
      expect(thrown, name).toBeInstanceOf(HelixError);
      expect((thrown as HelixError).userMessage, name).toContain('does not accept');
    }
  });

  it('refuses a disguised executable regardless of mime type', () => {
    expect(() => validateUpload(file('evil.exe', 1024, 'image/png'))).toThrow(HelixError);
  });

  it('refuses an unsupported type', () => {
    expect(() => validateUpload(file('archive.zip'))).toThrow('does not support .zip');
  });

  it('refuses a file with no extension', () => {
    expect(() => validateUpload(file('README'))).toThrow('no file extension');
  });

  it('refuses an empty file', () => {
    expect(() => validateUpload(file('empty.png', 0))).toThrow('is empty');
  });

  it('refuses a file over the size limit', () => {
    expect(() => validateUpload(file('huge.png', 900), { maxBytes: 500 })).toThrow(
      'over the 500 B limit',
    );
  });

  it('accepts a file exactly at the limit', () => {
    expect(validateUpload(file('exact.png', 500), { maxBytes: 500 }).sizeBytes).toBe(500);
  });

  it('sanitises the stored name', () => {
    expect(validateUpload(file('../../evil/ref.png')).fileName).toBe('ref.png');
  });

  it('reports the failure in userMessage, not just the technical field', () => {
    try {
      validateUpload(file('setup.exe'));
    } catch (error) {
      const helix = error as HelixError;
      expect(helix.userMessage).not.toContain('Rejected');
      expect(helix.technical).toContain('Rejected');
    }
  });
});

describe('formatBytes', () => {
  it('formats a range of sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('ACCEPT_ATTRIBUTE', () => {
  it('lists supported extensions and excludes executables', () => {
    expect(ACCEPT_ATTRIBUTE).toContain('.png');
    expect(ACCEPT_ATTRIBUTE).toContain('.glb');
    expect(ACCEPT_ATTRIBUTE).not.toContain('.exe');
  });
});
