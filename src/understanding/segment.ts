/**
 * Splitting one message into the several requests it actually contains.
 *
 *   "Open my notes, find the one about the website, and add that I need to
 *    fix the login page."
 *
 * is three instructions, and a matcher reading it whole scores it as a
 * confused mixture of open, search and append. Split, each clause is
 * unambiguous, and the clauses run in order with the result of one becoming
 * the context for the next - which is exactly what makes "the one about the
 * website" and then "add that ..." resolvable.
 *
 * WHERE IT IS CAREFUL. Commas and "and" join clauses, and they also appear
 * inside perfectly ordinary single requests: "write down eggs, milk and bread"
 * is one note, not three. Splitting that would be worse than not splitting at
 * all, so a split only happens where the following clause starts with
 * something that can begin an instruction - a verb - and the whole thing is
 * left alone otherwise.
 *
 * The content of a note is also protected explicitly: once a clause says
 * "write down" or "note that", everything after it is the note, commas
 * included. Anything else cuts a shopping list into three notes.
 */

/** Words that can begin an instruction, so a clause starting with one is one. */
const OPENERS = [
  'open', 'show', 'find', 'search', 'look', 'pull', 'bring', 'display', 'get',
  'create', 'make', 'new', 'write', 'jot', 'add', 'append', 'put', 'save',
  'store', 'keep', 'delete', 'remove', 'export', 'back', 'copy', 'read',
  'list', 'check', 'go', 'take', 'send', 'call', 'tell', 'remember', 'forget',
];

/**
 * Verbs after which the rest of the message is content rather than more
 * instructions. Everything following one of these stays in one piece.
 */
const CONTENT_VERBS = [
  'write down', 'note down', 'jot down', 'make a note', 'take a note',
  'note that', 'remember that', 'remember this', 'add that', 'saying',
  'that says', 'called', 'titled', 'named',
];

const JOINERS = /\s*(?:,\s*(?:and\s+|then\s+)?|\s+and then\s+|\s+then\s+|\s+and\s+|;\s*)/gi;

/**
 * Split a message into clauses.
 *
 * Returns a single-element list when the message is one request, which is the
 * overwhelmingly common case and must stay cheap.
 */
export function segment(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];

  const lower = trimmed.toLowerCase();

  /**
   * Everything after a content verb is content. Split before it if there is
   * anything there, and keep the remainder whole.
   */
  for (const verb of CONTENT_VERBS) {
    const at = lower.indexOf(verb);
    if (at === -1) continue;

    // The joiner goes with the split. Without the trailing \s* the "and" in
    // "... about the website, and" survived onto the end of the clause.
    const head = trimmed.slice(0, at).trim().replace(/[,;]?\s*(?:and|then)?\s*$/i, '').trim();
    const tail = trimmed.slice(at).trim();

    if (head === '') return [tail];
    // The head may itself be several instructions; the tail never is.
    return [...segment(head), tail];
  }

  const pieces: string[] = [];
  let cursor = 0;

  for (const match of trimmed.matchAll(JOINERS)) {
    const at = match.index ?? 0;
    const after = trimmed.slice(at + match[0].length);
    const firstWord = after.toLowerCase().split(/[^a-z']+/).filter(Boolean)[0] ?? '';

    // Only a clause that begins with an instruction word is a new instruction.
    if (!OPENERS.includes(firstWord)) continue;

    const clause = trimmed.slice(cursor, at).trim();
    if (clause !== '') pieces.push(clause);
    cursor = at + match[0].length;
  }

  const rest = trimmed.slice(cursor).trim();
  if (rest !== '') pieces.push(rest);

  return pieces.length === 0 ? [trimmed] : pieces;
}
