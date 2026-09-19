/**
 * Turning written text into Google Docs edits.
 *
 * The Docs API does not take a document; it takes a list of edits against
 * character indices, and the indices are where this goes wrong. The body
 * starts at index 1, every newline is one character, and an edit that inserts
 * text shifts every index after it. Getting that arithmetic slightly wrong
 * does not fail loudly - it produces a document where the bold starts one word
 * late and a heading swallows the line beneath it.
 *
 * So the arrangement here is chosen to make the arithmetic hold still:
 *
 *   1. The entire body is inserted in one request, at index 1.
 *   2. Every other request is a *style* request, and style requests do not
 *      change the length of anything.
 *
 * Because nothing after the first request moves a character, every range can
 * be computed once, against the final text, before any of it is sent. That is
 * the whole design, and it is why this file is pure and testable rather than
 * a sequence of calls that can only be checked against a live document.
 */

export type BlockKind = 'heading' | 'bullet' | 'paragraph';

export interface ParsedBlock {
  kind: BlockKind;
  /** 1, 2 or 3 for a heading; absent otherwise. */
  level?: 1 | 2 | 3;
  /** The text with markdown markers removed. */
  text: string;
  /** Bold runs, as offsets into `text`. */
  bold: ReadonlyArray<readonly [number, number]>;
}

/** Loosely typed: the API's request union is large and mostly unused here. */
export type DocsRequest = Record<string, unknown>;

export interface DocumentPlan {
  /** The plain text, exactly as it will be inserted. */
  text: string;
  /** insertText first, then styling. Order matters; see the module note. */
  requests: DocsRequest[];
}

/**
 * Read `**bold**` out of one line.
 *
 * Offsets are against the *returned* text, not the input, because the markers
 * are removed. Computing them against the input is the obvious mistake and
 * shifts every run by two characters per preceding marker.
 */
export function parseInline(raw: string): {
  text: string;
  bold: Array<readonly [number, number]>;
} {
  const bold: Array<readonly [number, number]> = [];
  let text = '';
  let openedAt: number | null = null;
  let index = 0;

  while (index < raw.length) {
    if (raw.startsWith('**', index)) {
      if (openedAt === null) {
        openedAt = text.length;
      } else {
        // A zero-length run styles nothing and Docs rejects an empty range.
        if (text.length > openedAt) bold.push([openedAt, text.length] as const);
        openedAt = null;
      }
      index += 2;
      continue;
    }
    text += raw[index];
    index += 1;
  }

  // An unclosed marker is text, not an instruction. Dropping it silently would
  // lose characters the user wrote.
  if (openedAt !== null) text = `${text.slice(0, openedAt)}**${text.slice(openedAt)}`;

  return { text, bold };
}

/** Split written text into the blocks a document is made of. */
export function parseBlocks(markdown: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];

  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      const inline = parseInline(heading[2].trim());
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        text: inline.text,
        bold: inline.bold,
      });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet?.[1] !== undefined) {
      const inline = parseInline(bullet[1].trim());
      blocks.push({ kind: 'bullet', text: inline.text, bold: inline.bold });
      continue;
    }

    const inline = parseInline(line);
    blocks.push({ kind: 'paragraph', text: inline.text, bold: inline.bold });
  }

  return blocks;
}

const HEADING_STYLE: Record<1 | 2 | 3, string> = {
  1: 'HEADING_1',
  2: 'HEADING_2',
  3: 'HEADING_3',
};

/**
 * The full set of edits that turns an empty document into this one.
 *
 * Returns the text as well as the requests so a caller can show exactly what
 * will be written before writing it - which is what the confirmation needs.
 */
export function planDocument(markdown: string): DocumentPlan {
  // Nothing to say means no edits. Without this, an empty string parses as one
  // empty paragraph and writes a stray blank line into the document.
  if (markdown.trim() === '') return { text: '', requests: [] };

  const blocks = parseBlocks(markdown);

  let text = '';
  const paragraphStyles: DocsRequest[] = [];
  const textStyles: DocsRequest[] = [];
  const bulletRanges: Array<{ start: number; end: number }> = [];

  for (const block of blocks) {
    const start = text.length;
    text += `${block.text}\n`;
    const end = start + block.text.length;

    // The body begins at index 1, so every offset shifts by one.
    const from = start + 1;
    // Paragraph styles take the newline too: a range that stops short of it
    // still works, but including it is what the API's own examples do and it
    // behaves predictably on an empty paragraph.
    const to = end + 2;

    if (block.kind === 'heading' && block.level !== undefined) {
      paragraphStyles.push({
        updateParagraphStyle: {
          range: { startIndex: from, endIndex: to },
          paragraphStyle: { namedStyleType: HEADING_STYLE[block.level] },
          // Only the field named is changed; everything else is left alone.
          fields: 'namedStyleType',
        },
      });
    }

    if (block.kind === 'bullet') {
      const previous = bulletRanges[bulletRanges.length - 1];
      if (previous && previous.end === from) {
        // Adjacent bullets become one request covering both paragraphs, which
        // is how the API expects a list rather than a run of separate ones.
        previous.end = to;
      } else {
        bulletRanges.push({ start: from, end: to });
      }
    }

    for (const [boldStart, boldEnd] of block.bold) {
      textStyles.push({
        updateTextStyle: {
          // Not the newline: a bold range that includes it bolds the break.
          range: { startIndex: from + boldStart, endIndex: from + boldEnd },
          textStyle: { bold: true },
          fields: 'bold',
        },
      });
    }
  }

  if (text === '') return { text, requests: [] };

  const requests: DocsRequest[] = [
    { insertText: { location: { index: 1 }, text } },
    ...paragraphStyles,
    ...textStyles,
    // Bullets last. They are the only styling request that changes a
    // paragraph's structure rather than only its appearance, so nothing else
    // depends on indices after they have run.
    ...bulletRanges.map((range) => ({
      createParagraphBullets: {
        range: { startIndex: range.start, endIndex: range.end },
        bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
      },
    })),
  ];

  return { text, requests };
}

/** A title for a document, taken from its first heading when it has one. */
export function titleFrom(markdown: string, fallback = 'Untitled'): string {
  const heading = /^#\s+(.+)$/m.exec(markdown.replace(/\r\n/g, '\n'));
  const title = heading?.[1] ? parseInline(heading[1]).text.trim() : '';
  if (title !== '') return title.slice(0, 120);

  const firstLine = markdown
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');

  return firstLine === undefined ? fallback : parseInline(firstLine).text.slice(0, 120);
}
