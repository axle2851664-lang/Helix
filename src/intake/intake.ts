/**
 * Taking things in from anywhere (your standing instruction).
 *
 * The request was to send things to Helix from TikTok, YouTube, Facebook,
 * Google, Chrome, ChatGPT and so on. Worth being exact about what that can and
 * cannot mean, because the two are easy to blur:
 *
 * Helix cannot sign in to those accounts and fetch your things. Some have no
 * API for it, some forbid it, and all of them would need a credential this
 * project has no business holding. Anything claiming otherwise would be a
 * scraper wearing a friendly name, and it would break the first time one of
 * them changed a page.
 *
 * What every one of them *can* do is hand something over: a downloaded file, a
 * dragged image, a copied link, a selected paragraph, an exported archive.
 * That is the real shape of "from anywhere" - not an integration per site, but
 * one intake that accepts whatever arrives and never asks where it came from.
 * This module is that intake's rules.
 *
 * Deliberately pure: given what a drop or a paste carried, it says what Helix
 * received. No DOM and no storage, so the awkward cases are decided somewhere
 * they can be tested.
 */

export type IntakeKind = 'file' | 'link' | 'text';

export interface IntakeItem {
  kind: IntakeKind;
  /** What it will be called. Never empty. */
  name: string;
  file?: File;
  url?: string;
  text?: string;
}

/** Hosts worth naming in a title, so a list of saved links stays readable. */
const KNOWN_SOURCES: ReadonlyArray<[RegExp, string]> = [
  [/(?:^|\.)tiktok\.com$/i, 'TikTok'],
  [/(?:^|\.)(?:youtube\.com|youtu\.be)$/i, 'YouTube'],
  [/(?:^|\.)(?:facebook\.com|fb\.watch)$/i, 'Facebook'],
  [/(?:^|\.)instagram\.com$/i, 'Instagram'],
  [/(?:^|\.)(?:x\.com|twitter\.com)$/i, 'X'],
  [/(?:^|\.)reddit\.com$/i, 'Reddit'],
  [/(?:^|\.)(?:chatgpt\.com|chat\.openai\.com)$/i, 'ChatGPT'],
  [/(?:^|\.)claude\.ai$/i, 'Claude'],
  [/(?:^|\.)(?:docs|drive|mail)\.google\.com$/i, 'Google'],
  [/(?:^|\.)google\.com$/i, 'Google'],
  [/(?:^|\.)github\.com$/i, 'GitHub'],
];

/**
 * Is this path segment an identifier rather than words?
 *
 * "dQw4w9WgXcQ" and "7300" say nothing to anybody; "how-to-fix-a-bike" does.
 * The tell is separators: written-for-humans segments use hyphens or
 * underscores, and ids do not.
 */
function isOpaqueId(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true;
  if (/[-_]/.test(segment)) return false;
  if (segment.length < 8) return false;
  return /\d/.test(segment) || (/[a-z]/.test(segment) && /[A-Z]/.test(segment));
}

/** A readable name for a link, which is otherwise an unreadable line of URL. */
export function describeLink(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Link';
  }

  const host = parsed.hostname.replace(/^www\./i, '');
  const known = KNOWN_SOURCES.find(([pattern]) => pattern.test(host));
  const source = known?.[1] ?? host;

  // The last meaningful path segment is usually the only human part of a URL.
  const segment = parsed.pathname
    .split('/')
    .filter((part) => part !== '')
    .pop();

  if (segment === undefined || isOpaqueId(segment)) return source;

  const readable = decodeURIComponent(segment)
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();

  return readable === '' ? source : `${source}: ${readable}`;
}

/** Is this text a single URL rather than prose that happens to contain one? */
export function looksLikeLink(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '' || /\s/.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** First line, trimmed to something that reads as a title. */
export function titleFromText(text: string, limit = 60): string {
  const firstLine = text.trim().split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  const cleaned = firstLine.replace(/^#+\s*/, '').trim();
  if (cleaned === '') return 'Pasted text';
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * What a paste or drop actually carried.
 *
 * Files and the text flavours are considered together on purpose, because a
 * real drag carries several at once. Dragging an image out of Chrome hands
 * over the file *and* its URL *and* the page URL, and treating that as three
 * arrivals would put three things in the vault every time.
 */
export interface Carried {
  files: readonly File[];
  /** text/uri-list, which a browser sets when a link or image is dragged. */
  uriList?: string | undefined;
  text?: string | undefined;
}

export function readIntake(carried: Carried): IntakeItem[] {
  const items: IntakeItem[] = [];

  for (const file of carried.files) {
    items.push({ kind: 'file', name: file.name || 'Dropped file', file });
  }

  // A file came with it, so any URL is that file's address rather than a
  // separate thing to keep. Saving both is the duplicate this avoids.
  if (items.length > 0) return items;

  const urls = (carried.uriList ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  for (const url of urls) {
    if (looksLikeLink(url)) items.push({ kind: 'link', name: describeLink(url), url });
  }

  if (items.length > 0) return items;

  const text = carried.text?.trim() ?? '';
  if (text === '') return items;

  if (looksLikeLink(text)) {
    items.push({ kind: 'link', name: describeLink(text), url: text });
  } else {
    items.push({ kind: 'text', name: titleFromText(text), text });
  }

  return items;
}

/**
 * The note written for a link or a piece of text.
 *
 * A link is kept as a link. Helix does not fetch it here: that would be a
 * network request nobody asked for, to a page that may be private to you, at
 * the moment of a drag. Fetching is a separate thing to ask for, with its own
 * permission.
 */
export function noteFor(item: IntakeItem, now: Date): string {
  const stamp = now.toISOString();
  const body = item.kind === 'link' ? (item.url ?? '') : (item.text ?? '');
  return [`# ${item.name}`, '', body, '', `Saved ${stamp}`, ''].join('\n');
}

/** A filename for a note, safe on every filesystem Helix runs on. */
export function fileNameFor(item: IntakeItem, now: Date): string {
  const slug = item.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  const date = now.toISOString().slice(0, 10);
  return `${date}-${slug === '' ? 'saved' : slug}.md`;
}
