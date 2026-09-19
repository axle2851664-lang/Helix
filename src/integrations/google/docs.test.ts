import { describe, expect, it } from 'vitest';
import { parseBlocks, parseInline, planDocument, titleFrom } from './docs.js';

/** Pull one kind of request out of a plan, for readable assertions. */
function requestsOf(markdown: string, key: string) {
  return planDocument(markdown)
    .requests.filter((request) => key in request)
    .map((request) => request[key] as Record<string, never>);
}

/**
 * Read the characters a range actually covers.
 *
 * The whole file is index arithmetic, so the tests check the text a range
 * lands on rather than the numbers. A test asserting startIndex === 8 passes
 * happily while the bold sits on the wrong word.
 */
function covered(markdown: string, range: { startIndex: number; endIndex: number }): string {
  const { text } = planDocument(markdown);
  // The body starts at index 1, so index n is text[n - 1].
  return text.slice(range.startIndex - 1, range.endIndex - 1);
}

describe('reading bold', () => {
  it('removes the markers and reports offsets against what is left', () => {
    // Computing offsets against the input is the obvious mistake, and shifts
    // every run by two characters per preceding marker.
    const parsed = parseInline('the **quick** brown **fox**');
    expect(parsed.text).toBe('the quick brown fox');
    expect(parsed.bold).toEqual([
      [4, 9],
      [16, 19],
    ]);
    expect(parsed.text.slice(4, 9)).toBe('quick');
    expect(parsed.text.slice(16, 19)).toBe('fox');
  });

  it('keeps an unclosed marker as text rather than losing it', () => {
    expect(parseInline('a ** b').text).toBe('a ** b');
    expect(parseInline('a ** b').bold).toEqual([]);
  });

  it('ignores an empty run, which Docs would reject as an empty range', () => {
    expect(parseInline('a **** b').bold).toEqual([]);
    expect(parseInline('a **** b').text).toBe('a  b');
  });
});

describe('reading blocks', () => {
  it('reads the three heading levels', () => {
    const blocks = parseBlocks('# One\n## Two\n### Three');
    expect(blocks.map((block) => block.level)).toEqual([1, 2, 3]);
    expect(blocks.map((block) => block.text)).toEqual(['One', 'Two', 'Three']);
  });

  it('reads bullets written any of the usual ways', () => {
    const blocks = parseBlocks('- one\n* two\n+ three\n  - indented');
    expect(blocks.every((block) => block.kind === 'bullet')).toBe(true);
    expect(blocks.map((block) => block.text)).toEqual(['one', 'two', 'three', 'indented']);
  });

  it('does not read a hyphen mid-sentence as a bullet', () => {
    expect(parseBlocks('well - that is fine')[0]?.kind).toBe('paragraph');
  });

  it('keeps a blank line as an empty paragraph', () => {
    const blocks = parseBlocks('one\n\ntwo');
    expect(blocks.map((block) => block.text)).toEqual(['one', '', 'two']);
  });
});

describe('the edits', () => {
  it('inserts everything once, at the start, before any styling', () => {
    // The entire design: one length-changing request, then only styles, so
    // every index can be computed up front and stays valid.
    const { requests } = planDocument('# Title\n\nSome words.');
    expect(Object.keys(requests[0] ?? {})).toEqual(['insertText']);
    expect(requests.slice(1).every((request) => !('insertText' in request))).toBe(true);
  });

  it('puts a heading style on exactly the heading line', () => {
    const markdown = '# Shopping\n\nMilk and bread.';
    const style = requestsOf(markdown, 'updateParagraphStyle')[0] as unknown as {
      range: { startIndex: number; endIndex: number };
      paragraphStyle: { namedStyleType: string };
      fields: string;
    };

    expect(style.paragraphStyle.namedStyleType).toBe('HEADING_1');
    expect(style.fields).toBe('namedStyleType');
    // Covers the heading and its newline, and nothing of the line after.
    expect(covered(markdown, style.range)).toBe('Shopping\n');
  });

  it('puts bold on exactly the bold words, across several lines', () => {
    const markdown = 'The **deadline** is Friday.\nThe **invoice** is paid.';
    const styles = requestsOf(markdown, 'updateTextStyle') as unknown as Array<{
      range: { startIndex: number; endIndex: number };
    }>;

    expect(styles).toHaveLength(2);
    expect(covered(markdown, styles[0]!.range)).toBe('deadline');
    expect(covered(markdown, styles[1]!.range)).toBe('invoice');
  });

  it('never lets a bold range swallow the line break', () => {
    const markdown = '**all of it**\nnext line';
    const style = (requestsOf(markdown, 'updateTextStyle') as unknown as Array<{
      range: { startIndex: number; endIndex: number };
    }>)[0]!;
    expect(covered(markdown, style.range)).toBe('all of it');
  });

  it('makes one list of adjacent bullets rather than several', () => {
    const bullets = requestsOf('- one\n- two\n- three', 'createParagraphBullets') as unknown as Array<{
      range: { startIndex: number; endIndex: number };
    }>;
    expect(bullets).toHaveLength(1);
    expect(covered('- one\n- two\n- three', bullets[0]!.range)).toBe('one\ntwo\nthree\n');
  });

  it('separates lists that are not adjacent', () => {
    const markdown = '- one\n\n- two';
    const bullets = requestsOf(markdown, 'createParagraphBullets') as unknown as Array<{
      range: { startIndex: number; endIndex: number };
    }>;
    expect(bullets).toHaveLength(2);
  });

  it('applies bullets after everything else', () => {
    // They are the only styling request that changes a paragraph's structure,
    // so nothing may depend on indices once they have run.
    const { requests } = planDocument('# Head\n- one\n**bold** words');
    const lastKey = Object.keys(requests[requests.length - 1] ?? {})[0];
    expect(lastKey).toBe('createParagraphBullets');
  });

  it('writes the text it says it will write', () => {
    const plan = planDocument('# Title\n\n- one\n- two\n\nEnd.');
    expect(plan.text).toBe('Title\n\none\ntwo\n\nEnd.\n');
  });

  it('does nothing at all for empty input', () => {
    // Otherwise an empty request writes a stray blank line into a document.
    expect(planDocument('')).toEqual({ text: '', requests: [] });
    expect(planDocument('   \n  \n')).toEqual({ text: '', requests: [] });
  });

  it('survives a document that is only a heading', () => {
    const plan = planDocument('# Just this');
    expect(plan.text).toBe('Just this\n');
    expect(plan.requests).toHaveLength(2);
  });
});

describe('naming the document', () => {
  it('uses the first heading', () => {
    expect(titleFrom('# Quarterly review\n\nBody')).toBe('Quarterly review');
  });

  it('strips formatting from the title rather than putting asterisks in it', () => {
    expect(titleFrom('# The **big** one')).toBe('The big one');
  });

  it('falls back to the first line when there is no heading', () => {
    expect(titleFrom('Notes from Tuesday\nmore')).toBe('Notes from Tuesday');
  });

  it('has something to call an empty document', () => {
    expect(titleFrom('   \n  ', 'Untitled')).toBe('Untitled');
  });
});
