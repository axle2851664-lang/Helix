/**
 * Recognising a request to write a document.
 *
 * Matched in code rather than emitted by the model, like the other explicit
 * instructions: a structured command assembled from generated text is
 * generated text being executed, and the local model is often small enough to
 * produce a malformed one.
 *
 * The refusals matter as much as the matches. "Document this function" is a
 * request about code, "write it down" is a note, and neither should put a file
 * in somebody's Google Drive.
 */

export interface DocsIntent {
  /** What the document should be about. */
  subject: string;
  /** An explicit title, when the request named one in quotes. */
  title?: string;
}

const OPENERS = [
  'write a google doc about',
  'write a google doc on',
  'write a google doc',
  'make a google doc about',
  'make a google doc',
  'create a google doc about',
  'create a google doc',
  'draft a google doc about',
  'write a document about',
  'write a document on',
  'write a doc about',
  'write a doc on',
  'draft a document about',
  'draft a document on',
  'draft a doc about',
  'create a document about',
  'make a document about',
  'put together a document about',
  'write up a document about',
];

/** Phrases that look close but mean something else entirely. */
const NOT_A_DOCUMENT =
  /\b(?:document (?:this|that|the|my) (?:code|function|class|module|file|script)|documentation for the code)\b/i;

function quoted(text: string): string | null {
  const match = /["“”']([^"“”']{2,120})["“”']/.exec(text);
  return match?.[1]?.trim() ?? null;
}

export function docsIntent(input: string): DocsIntent | null {
  const text = input.trim().replace(/[?!.]+$/, '');
  if (text === '') return null;

  const lower = text.toLowerCase();
  if (NOT_A_DOCUMENT.test(lower)) return null;

  const opener = [...OPENERS]
    .sort((a, b) => b.length - a.length)
    .find((candidate) => lower.startsWith(candidate));
  if (opener === undefined) return null;

  let subject = text.slice(opener.length).trim();

  // "called X" / "titled X" names the document; the rest is the subject.
  const named = /\s+(?:called|titled|named)\s+["“”']?([^"“”']+)["“”']?\s*$/i.exec(subject);
  let title = named?.[1]?.trim();
  if (named) subject = subject.slice(0, named.index).trim();

  if (title === undefined) {
    const inQuotes = quoted(subject);
    if (inQuotes !== null && inQuotes === subject.replace(/^["“”']|["“”']$/g, '').trim()) {
      title = inQuotes;
    }
  }

  subject = subject.replace(/^(?:about|on|covering|for)\s+/i, '').trim();
  if (subject === '') return null;

  return { subject, ...(title !== undefined && title !== '' ? { title } : {}) };
}

/** What the model is told when asked to draft the document. */
export function draftPrompt(subject: string): { system: string; user: string } {
  return {
    system: [
      'Write a document in plain markdown.',
      'Use # for the title, ## for sections, - for bullets and **bold** for emphasis. Use nothing else - no tables, no links, no code fences.',
      'Begin with a single # title line.',
      'Be concise and concrete. Do not pad, do not restate the request, and do not write a preamble about what you are about to write.',
      'Write only the document. No commentary before or after it.',
    ].join(' '),
    user: subject,
  };
}
