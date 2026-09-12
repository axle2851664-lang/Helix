import { describe, expect, it } from 'vitest';
import {
  describeLink,
  fileNameFor,
  looksLikeLink,
  noteFor,
  readIntake,
  titleFromText,
} from './intake.js';

const file = (name: string, type = 'text/plain') =>
  new File(['x'], name, { type }) as File;

const NOW = new Date('2026-09-12T10:30:00.000Z');

describe('what a drop carried', () => {
  it('takes the files', () => {
    const items = readIntake({ files: [file('notes.md'), file('shot.png', 'image/png')] });
    expect(items.map((item) => item.name)).toEqual(['notes.md', 'shot.png']);
    expect(items.every((item) => item.kind === 'file')).toBe(true);
  });

  it('keeps the file and not its address when a drag carries both', () => {
    // Dragging an image out of Chrome hands over the file, its URL and the
    // page URL. Three arrivals for one drag is three things in the vault.
    const items = readIntake({
      files: [file('cat.png', 'image/png')],
      uriList: 'https://example.com/cat.png',
      text: 'https://example.com/cat.png',
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('file');
  });

  it('takes a dragged link', () => {
    const items = readIntake({ files: [], uriList: 'https://www.tiktok.com/@someone/video/12345' });
    expect(items[0]?.kind).toBe('link');
    expect(items[0]?.url).toBe('https://www.tiktok.com/@someone/video/12345');
  });

  it('ignores the comment lines a uri-list carries', () => {
    const items = readIntake({
      files: [],
      uriList: '# this is a comment\nhttps://example.com/page',
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe('https://example.com/page');
  });

  it('takes pasted prose as text, not as a link', () => {
    const items = readIntake({ files: [], text: 'Go and look at https://example.com later' });
    expect(items[0]?.kind).toBe('text');
  });

  it('takes a pasted bare URL as a link', () => {
    const items = readIntake({ files: [], text: '  https://youtu.be/abc123  ' });
    expect(items[0]?.kind).toBe('link');
    expect(items[0]?.url).toBe('https://youtu.be/abc123');
  });

  it('takes nothing from an empty drop', () => {
    expect(readIntake({ files: [] })).toEqual([]);
    expect(readIntake({ files: [], text: '   ' })).toEqual([]);
  });

  it('refuses a scheme that is not the web', () => {
    // A dragged file:// or javascript: URL is not something to save as a link.
    expect(looksLikeLink('file:///C:/Users/selam/secret.txt')).toBe(false);
    expect(looksLikeLink('javascript:alert(1)')).toBe(false);
    expect(readIntake({ files: [], uriList: 'file:///C:/secret.txt' })).toEqual([]);
  });
});

describe('naming a link', () => {
  it('names the site people would recognise', () => {
    expect(describeLink('https://www.tiktok.com/@chef/video/7300')).toContain('TikTok');
    expect(describeLink('https://youtu.be/dQw4w9WgXcQ')).toContain('YouTube');
    expect(describeLink('https://chatgpt.com/c/abc')).toContain('ChatGPT');
    expect(describeLink('https://docs.google.com/document/d/x/edit')).toContain('Google');
  });

  it('uses the readable part of the path when there is one', () => {
    expect(describeLink('https://example.com/how-to-fix-a-bike')).toBe(
      'example.com: how to fix a bike',
    );
  });

  it('does not put an opaque id in the title', () => {
    expect(describeLink('https://youtu.be/dQw4w9WgXcQ')).toBe('YouTube');
  });

  it('falls back rather than throwing on something that is not a URL', () => {
    expect(describeLink('not a url')).toBe('Link');
  });
});

describe('naming pasted text', () => {
  it('uses the first line', () => {
    expect(titleFromText('Shopping list\n- milk\n- bread')).toBe('Shopping list');
  });

  it('strips a markdown heading marker', () => {
    expect(titleFromText('# Shopping list\n- milk')).toBe('Shopping list');
  });

  it('shortens a long first line rather than using all of it', () => {
    const title = titleFromText('x'.repeat(200));
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('…')).toBe(true);
  });

  it('has something to say about text with no first line', () => {
    expect(titleFromText('\n\n   \n')).toBe('Pasted text');
  });
});

describe('what gets written', () => {
  it('keeps a link as a link rather than fetching it', () => {
    // Fetching at drag time is a network request nobody asked for, to a page
    // that may be private.
    const note = noteFor(
      { kind: 'link', name: 'TikTok', url: 'https://www.tiktok.com/@a/video/1' },
      NOW,
    );
    expect(note).toContain('https://www.tiktok.com/@a/video/1');
    expect(note).toContain('# TikTok');
    expect(note).toContain('2026-09-12');
  });

  it('writes a filename that is safe everywhere', () => {
    const name = fileNameFor({ kind: 'link', name: 'Google: my notes/draft?' }, NOW);
    expect(name).toBe('2026-09-12-google-my-notes-draft.md');
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('still produces a filename when the title survives nothing', () => {
    expect(fileNameFor({ kind: 'text', name: '???' }, NOW)).toBe('2026-09-12-saved.md');
  });
});
