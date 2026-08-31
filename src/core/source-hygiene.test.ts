import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No control characters in source.
 *
 * This has bitten this project more than once, and it is worth a test because
 * of how it fails rather than how often. A `\b` in a regular expression,
 * passed through a shell heredoc into a JavaScript template literal, arrives
 * as an actual backspace - U+0008. The file still parses. The regex still
 * runs. The word boundary is simply gone, and the character that replaced it
 * is invisible in an editor, invisible in a diff and invisible in review.
 *
 * One such character sat in `extractRecallSubject` from the commit that
 * introduced it until this test was written, silently turning a word-boundary
 * assertion into a match for a literal backspace that no input would ever
 * contain.
 *
 * Tabs, newlines and carriage returns are allowed; nothing else below 0x20 is.
 */

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** Everything under src, since the fault can land in any file a patch touches. */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.(ts|tsx|css)$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

const FORBIDDEN = new RegExp(
  '[' +
    String.fromCharCode(0) +
    '-' +
    String.fromCharCode(8) +
    String.fromCharCode(11) +
    String.fromCharCode(12) +
    String.fromCharCode(14) +
    '-' +
    String.fromCharCode(31) +
    ']',
  'g',
);

describe('source hygiene', () => {
  const files = sourceFiles(ROOT);

  it('finds source to check', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it('contains no control characters', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const matches = text.match(FORBIDDEN);
      if (!matches) continue;

      // Report where, and as a code point: the character itself would be
      // invisible in the failure message too.
      const line = text.slice(0, text.search(FORBIDDEN)).split('\n').length;
      const codes = [...new Set(matches.map((c) => 'U+' + c.charCodeAt(0).toString(16).padStart(4, '0')))];
      offenders.push(`${file.replace(ROOT, '')}:${line} has ${matches.length} (${codes.join(', ')})`);
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
