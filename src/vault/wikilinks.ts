/**
 * Wikilink parsing.
 *
 * `[[Target]]` between notes becomes an edge in the vault graph. The syntax has
 * three common variants, all of which appear in real note collections:
 *
 *   [[Target]]              plain
 *   [[Target|shown text]]   aliased - the pipe is display only
 *   [[Target#Heading]]      section - the heading is not part of the target
 *
 * Matching is deliberately conservative. A link inside a fenced code block is
 * almost always an example rather than a real reference, and treating it as an
 * edge produces phantom nodes that make the graph misleading.
 */

export interface Wikilink {
  /** The note being linked to, normalised for matching. */
  target: string;
  /** The text as written, for display. */
  raw: string;
  /** Alias after a pipe, when present. */
  alias: string | null;
  /** Heading after a hash, when present. */
  heading: string | null;
}

/**
 * Normalise a note title for matching: case-insensitive, whitespace collapsed.
 * `[[Iron Man]]`, `[[iron man]]` and `[[Iron  Man]]` are the same note.
 */
export function normalizeTarget(target: string): string {
  return target.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Strip fenced and inline code so examples inside them are not read as links. */
export function stripCode(text: string): string {
  return text
    // Fenced blocks first, so an inline pass cannot cut them in half.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

const LINK_PATTERN = /\[\[([^\]\n]+)\]\]/g;

/** Every wikilink in a document, in order, with duplicates preserved. */
export function parseWikilinks(text: string): Wikilink[] {
  const source = stripCode(text);
  const links: Wikilink[] = [];

  for (const match of source.matchAll(LINK_PATTERN)) {
    const inner = match[1];
    if (inner === undefined) continue;

    const raw = inner.trim();
    if (raw === '') continue;

    // Pipe splits target from display alias; hash splits target from heading.
    const pipeIndex = raw.indexOf('|');
    const beforePipe = pipeIndex === -1 ? raw : raw.slice(0, pipeIndex);
    const alias = pipeIndex === -1 ? null : raw.slice(pipeIndex + 1).trim() || null;

    const hashIndex = beforePipe.indexOf('#');
    const target = (hashIndex === -1 ? beforePipe : beforePipe.slice(0, hashIndex)).trim();
    const heading = hashIndex === -1 ? null : beforePipe.slice(hashIndex + 1).trim() || null;

    // A link that is only a heading refers to this note, not another one.
    if (target === '') continue;

    links.push({ target, raw, alias, heading });
  }

  return links;
}

/** Distinct link targets, normalised. Order of first appearance is kept. */
export function linkTargets(text: string): string[] {
  const seen = new Set<string>();
  const targets: string[] = [];

  for (const link of parseWikilinks(text)) {
    const key = normalizeTarget(link.target);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(link.target);
  }

  return targets;
}

/** Title from a filename: drop the extension, keep the rest as written. */
export function titleFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/, '');
  return withoutExtension.trim() || fileName;
}

/**
 * A note's title, preferring a leading `# Heading` over the filename, since
 * that is what a link is most likely to name.
 */
export function titleFromContent(fileName: string, text: string): string {
  const heading = /^\s*#\s+(.+)$/m.exec(stripCode(text));
  const fromHeading = heading?.[1]?.trim();
  return fromHeading && fromHeading !== '' ? fromHeading : titleFromFileName(fileName);
}
