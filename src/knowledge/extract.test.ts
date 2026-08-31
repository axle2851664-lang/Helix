import { describe, expect, it } from 'vitest';
import { canExtract, chunkText, extractionBlocker, extractText } from './extract.js';

const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe('canExtract', () => {
  it('accepts plain-text formats', () => {
    for (const name of ['notes.txt', 'README.md', 'data.csv', 'config.json', 'a.yaml', 'b.xml']) {
      expect(canExtract(name, 'document'), name).toBe(true);
    }
  });

  it('rejects images and 3D models', () => {
    expect(canExtract('photo.png', 'image')).toBe(false);
    expect(canExtract('suit.glb', 'model3d')).toBe(false);
  });

  // PDFs used to be rejected here. They are read properly now, through the
  // parser loaded on demand.
  it('accepts a PDF', () => {
    expect(canExtract('report.pdf', 'document')).toBe(true);
  });
});

describe('extractionBlocker', () => {
  it('returns null for readable files', () => {
    expect(extractionBlocker('notes.md', 'document')).toBeNull();
  });

  it('no longer blocks a PDF', () => {
    expect(extractionBlocker('report.pdf', 'document')).toBeNull();
  });

  // The reason must name the missing dependency, not just say "unsupported".
  it('names why a 3D model holds no text', () => {
    expect(extractionBlocker('suit.glb', 'model3d')).toContain('geometry');
  });

  it('explains that images need OCR or vision', () => {
    const reason = extractionBlocker('photo.png', 'image');
    expect(reason).toContain('OCR');
    expect(reason).toContain('vision provider');
  });

  it('explains that 3D models hold no text', () => {
    expect(extractionBlocker('suit.glb', 'model3d')).toContain('geometry, not text');
  });
});

describe('extractText', () => {
  it('extracts UTF-8 text', async () => {
    const result = await extractText('notes.md', 'document', encode('# Title\n\nSome content.'));
    expect(result.status).toBe('extracted');
    expect(result.text).toContain('Some content.');
  });

  it('handles non-ASCII characters', async () => {
    const result = await extractText('notes.txt', 'document', encode('café naïve 日本語'));
    expect(result.status).toBe('extracted');
    expect(result.text).toBe('café naïve 日本語');
  });

  it('accepts a Blob as well as an ArrayBuffer', async () => {
    const blob = new Blob(['hello from a blob'], { type: 'text/plain' });
    const result = await extractText('a.txt', 'document', blob);
    expect(result.text).toBe('hello from a blob');
  });

  it('reports an unsupported format rather than returning empty text', async () => {
    const result = await extractText('suit.glb', 'model3d', encode('binary geometry'));
    expect(result.status).toBe('unsupported');
    expect(result.text).toBe('');
    expect(result.reason).toBeTruthy();
  });

  // A PDF now reaches the parser. This one is not a real document, so it
  // fails as an unreadable file rather than as an unsupported format - a
  // different answer, and the right one.
  it('sends a PDF to the parser rather than refusing it outright', async () => {
    const result = await extractText('report.pdf', 'document', encode('%PDF-1.4'));

    expect(result.status).not.toBe('unsupported');
    expect(result.reason ?? '').toContain('PDF');
  });

  it('reports an empty file', async () => {
    expect((await extractText('a.txt', 'document', encode(''))).status).toBe('empty');
    expect((await extractText('a.txt', 'document', encode('   \n  '))).status).toBe('empty');
  });

  // A .txt containing binary would otherwise be indexed as junk search terms.
  it('refuses binary content wearing a text extension', async () => {
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]).buffer;
    const result = await extractText('fake.txt', 'document', binary as ArrayBuffer);
    expect(result.status).toBe('not-text');
    expect(result.reason).toContain('binary');
  });

  it('refuses invalid UTF-8', async () => {
    const invalid = new Uint8Array([0x41, 0xc3, 0x28, 0x42, 0x43, 0x44, 0x45]).buffer;
    const result = await extractText('bad.txt', 'document', invalid as ArrayBuffer);
    expect(result.status).toBe('not-text');
  });
});

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('short')).toEqual(['short']);
  });

  it('returns nothing for empty text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   ')).toEqual([]);
  });

  it('splits long text into several chunks', () => {
    const text = 'word '.repeat(1000);
    const chunks = chunkText(text, { size: 200, overlap: 20 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
  });

  it('does not lose content between chunks', () => {
    const text = Array.from({ length: 200 }, (_, i) => `token${i}`).join(' ');
    const chunks = chunkText(text, { size: 300, overlap: 50 });

    const joined = chunks.join(' ');
    // Every token must survive somewhere, or search would silently miss it.
    for (const token of ['token0', 'token99', 'token199']) {
      expect(joined, token).toContain(token);
    }
  });

  it('overlaps chunks so a phrase spanning a boundary stays findable', () => {
    const text = `${'a '.repeat(150)}FINDME PHRASE${' b'.repeat(150)}`;
    const chunks = chunkText(text, { size: 200, overlap: 60 });
    expect(chunks.some((chunk) => chunk.includes('FINDME PHRASE'))).toBe(true);
  });

  it('terminates on text with no spaces', () => {
    const chunks = chunkText('x'.repeat(1000), { size: 100, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('').length).toBeGreaterThan(900);
  });
});
