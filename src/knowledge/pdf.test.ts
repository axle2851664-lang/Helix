import { describe, expect, it } from 'vitest';
import { PdfExtractionError, extractPdfText } from './pdf.js';
import { canExtract, extractText, extractionBlocker, isPdf } from './extract.js';

/**
 * A real PDF, assembled byte by byte.
 *
 * Built here rather than committed as a fixture: a binary in the repository is
 * something nobody can review, and this way the test says exactly what is in
 * the document it is asserting about. Offsets in the cross-reference table are
 * computed rather than hard-coded, because a table that disagrees with the
 * body is the commonest way a hand-written PDF fails to open.
 */
function buildPdf(options: { text?: string; pages?: number } = {}): ArrayBuffer {
  const text = options.text ?? 'Hello Helix';
  const pageCount = options.pages ?? 1;

  const objects: string[] = [];
  const pageIds = Array.from({ length: pageCount }, (_, index) => 3 + index * 2);

  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objects.push(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`,
  );

  for (let page = 0; page < pageCount; page += 1) {
    const contentId = pageIds[page]! + 1;
    const body = `BT /F1 24 Tf 72 700 Td (${text}${pageCount > 1 ? ` page ${page + 1}` : ''}) Tj ET`;

    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R ` +
        `/Resources << /Font << /F1 ${3 + pageCount * 2} 0 R >> >> >>`,
    );
    objects.push(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
  }

  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];

  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;

  return new TextEncoder().encode(pdf).buffer as ArrayBuffer;
}

/** A PDF with a page but no text-drawing operators: a scan, in effect. */
function buildTextlessPdf(): ArrayBuffer {
  const source = new TextDecoder().decode(buildPdf());
  // Strip the drawing operators, leaving a structurally valid page with
  // nothing on it.
  return new TextEncoder().encode(source.replace(/BT[\s\S]*?ET/g, '')).buffer as ArrayBuffer;
}

describe('routing PDFs to the parser', () => {
  it('recognises a PDF by extension', () => {
    expect(isPdf('invoice.PDF')).toBe(true);
    expect(isPdf('notes.md')).toBe(false);
  });

  it('now says it can read them', () => {
    expect(canExtract('invoice.pdf', 'document')).toBe(true);
    expect(extractionBlocker('invoice.pdf', 'document')).toBeNull();
  });

  // The old message promised a parser Helix did not have. It must be gone,
  // not merely unreachable.
  it('no longer claims a parser is missing', () => {
    const blockers = ['glb', 'obj', 'stl'].map((extension) =>
      extractionBlocker(`model.${extension}`, 'model3d'),
    );
    expect(blockers.join(' ')).not.toContain('PDF');
  });

  it('still refuses an image, which needs OCR rather than a parser', () => {
    expect(extractionBlocker('scan.png', 'image')).toContain('OCR');
  });
});

describe('extractPdfText', () => {
  it('reads the text out of a real PDF', async () => {
    const result = await extractPdfText(buildPdf({ text: 'The deadline is Friday' }));

    expect(result.text).toContain('The deadline is Friday');
    expect(result.pages).toBe(1);
  });

  it('reads every page, in order', async () => {
    const result = await extractPdfText(buildPdf({ text: 'Northgate', pages: 3 }));

    expect(result.pages).toBe(3);
    expect(result.text).toContain('page 1');
    expect(result.text).toContain('page 3');
    expect(result.text.indexOf('page 1')).toBeLessThan(result.text.indexOf('page 3'));
  });

  /**
   * The commonest PDF in an office. A scan and a corrupt file both yield
   * nothing, and only one of them is worth trying to fix, so they must not
   * come back as the same failure.
   */
  it('identifies a page with no text layer as a scan', async () => {
    await expect(extractPdfText(buildTextlessPdf())).rejects.toMatchObject({
      noTextLayer: true,
    });

    await expect(extractPdfText(buildTextlessPdf())).rejects.toThrow(/OCR/);
  });

  it('refuses a file that is not a PDF at all', async () => {
    const notAPdf = new TextEncoder().encode('this is just a sentence').buffer as ArrayBuffer;

    await expect(extractPdfText(notAPdf)).rejects.toBeInstanceOf(PdfExtractionError);
    await expect(extractPdfText(notAPdf)).rejects.toMatchObject({ noTextLayer: false });
  });

  it('refuses an empty buffer', async () => {
    await expect(extractPdfText(new ArrayBuffer(0))).rejects.toBeInstanceOf(PdfExtractionError);
  });
});

describe('extractText, end to end', () => {
  it('indexes a PDF like any other document', async () => {
    const result = await extractText(
      'brief.pdf',
      'document',
      buildPdf({ text: 'Retainer terms agreed' }),
    );

    expect(result.status).toBe('extracted');
    expect(result.text).toContain('Retainer terms agreed');
  });

  // A scanned PDF is empty rather than broken, and the reason must say which.
  it('reports a scan as empty, with the reason', async () => {
    const result = await extractText('scan.pdf', 'document', buildTextlessPdf());

    expect(result.status).toBe('empty');
    expect(result.reason).toContain('OCR');
  });

  it('reports a file that is not really a PDF', async () => {
    const result = await extractText(
      'broken.pdf',
      'document',
      new TextEncoder().encode('nonsense').buffer as ArrayBuffer,
    );

    expect(result.status).toBe('not-text');
    expect(result.reason).toBeTruthy();
  });

  it('does not treat a PDF as binary junk, which is what it used to do', async () => {
    const result = await extractText('brief.pdf', 'document', buildPdf());

    expect(result.reason ?? '').not.toContain('binary');
  });
});
