/**
 * Facts the user has explicitly asked Helix to hold.
 *
 * WHAT THIS IS FOR. Helix already learns a narrow set of self-disclosures -
 * your name, where you live - from `disclosure.ts`. This is the general case:
 * anything at all, marked by the user as something to treat as true.
 *
 *   "The truth is that my project is called Helix."
 *   "Remember this as a fact: the supplier only ships on Tuesdays."
 *
 * THE DISTINCTION THAT MATTERS MOST, and the reason this file is mostly
 * refusals. Marking something as true is an instruction; saying something is
 * not. Helix must not quietly turn a conversation into a set of beliefs, and
 * the three cases it has to keep apart are:
 *
 *   A QUESTION      "Is the Earth flat?"
 *                   Not a fact. Not stored. Answered.
 *
 *   AN OPINION      "I think the Earth is flat."
 *                   Not stored. The user said what they think; they did not
 *                   ask Helix to hold it.
 *
 *   A MARKED TRUTH  "The truth is that I believe the Earth is flat."
 *                   Stored - and stored as what it actually is, a fact about
 *                   what the user believes, not a fact about the Earth.
 *
 * That last one is the whole design. When the marked statement is itself about
 * believing or thinking something, the stored fact is about the user's stated
 * belief. The claim and the claimant do not get collapsed.
 *
 * AND WHAT A STORED TRUTH IS NOT. It is a record of what the user said, never
 * a verified fact about the world. "The truth is that the moon is made of
 * cheese" is stored faithfully and recalled as something the user stated -
 * `phrase()` below is what keeps that true at the point it is read back,
 * because a memory recalled as "the moon is made of cheese" would have
 * laundered an assertion into a fact on the way out.
 */

/** Where a stored claim came from, and therefore how far it may be trusted. */
export type Provenance =
  /** The user said so, and asked Helix to keep it. Nothing verified it. */
  | 'user-stated'
  /** The user said they believe or think it. A fact about them, not the world. */
  | 'user-belief';

export interface Truth {
  /** The claim, as a sentence Helix can hold and read back. */
  claim: string;
  provenance: Provenance;
  /** The words that marked it, for the confirmation and the log. */
  marker: string;
}

/** Tag every truth carries in long-term memory, so they can be found again. */
export const TRUTH_TAG = 'truth';

/** The tag that records provenance alongside it. */
export const PROVENANCE_TAGS: Readonly<Record<Provenance, string>> = {
  'user-stated': 'user-stated',
  'user-belief': 'user-belief',
};

/** Markers that say "treat what follows as true". */
const MARKERS: readonly RegExp[] = [
  /^(?:this is|here is|here's)\s+(?:the\s+)?truth\s*[:,-]?\s*/i,
  /^the\s+truth\s+is\s+(?:that\s+)?/i,
  /^(?:remember|store|keep|save)\s+(?:this|that|it)\s+as\s+(?:a\s+)?(?:truth|fact|true)\s*[:,-]?\s*/i,
  /^(?:this|that)\s+is\s+(?:a\s+)?fact\s*[:,-]?\s*/i,
  /^(?:it'?s|it is)\s+(?:a\s+)?fact\s+that\s+/i,
  /^(?:store|record)\s+(?:this|that)\s+as\s+(?:a\s+)?fact\s*[:,-]?\s*/i,
  /^i\s+want\s+you\s+to\s+know\s+(?:that\s+)?/i,
  /^(?:for\s+the\s+record|fyi)\s*[:,-]?\s*/i,
  /^fact\s*[:-]\s*/i,
];

/**
 * The statement is about what the user believes, not about the world.
 *
 * Checked against the claim *after* the marker is removed, because the marker
 * is what makes it storable and this is what decides how it is stored.
 */
const BELIEF = /^(?:i\s+(?:believe|think|reckon|feel|suspect|assume)|in\s+my\s+(?:opinion|view))\b/i;

/** A question, whatever else it looks like. */
function isQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.endsWith('?')) return true;
  return /^(?:is|are|was|were|do|does|did|can|could|should|would|will|has|have|had|am|what|who|where|when|why|how|which)\b/i.test(
    trimmed,
  );
}

function tidy(claim: string): string {
  const cleaned = claim
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return '';
  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

/**
 * Read a marked truth out of a sentence, or return null.
 *
 * Null is the common answer and the safe one: almost nothing anyone says is a
 * request to store a fact, and storing something that was not meant as one is
 * both a privacy failure and a correctness failure - Helix would go on to use
 * it.
 */
export function truthStatement(said: string): Truth | null {
  const text = said
    .trim()
    .replace(/^(?:hey\s+|ok(?:ay)?\s+)?helix[,:]?\s*/i, '')
    .trim();
  if (text === '') return null;

  for (const marker of MARKERS) {
    const match = marker.exec(text);
    if (!match) continue;

    const rest = text.slice(match[0].length).trim();
    if (rest === '') return null;

    /**
     * "The truth is, what did I say yesterday?" is still a question. The
     * marker does not make an interrogative into a claim, and storing one
     * would put a question mark into long-term memory.
     */
    if (isQuestion(rest)) return null;

    const belief = BELIEF.test(rest);
    const claim = tidy(rest);
    if (claim === '') return null;

    return {
      claim,
      // A marked statement about believing something is a fact about the
      // believer. The claim and the claimant are not collapsed.
      provenance: belief ? 'user-belief' : 'user-stated',
      marker: match[0].trim(),
    };
  }

  return null;
}

export type TruthEditKind = 'update' | 'delete';

export interface TruthEdit {
  kind: TruthEditKind;
  /** The replacement claim, for an update. Empty for a delete. */
  claim: string;
  marker: string;
}

/** "That's no longer true", "the new truth is ...", "forget that truth". */
const EDITS: ReadonlyArray<{ pattern: RegExp; kind: TruthEditKind }> = [
  { pattern: /^the\s+new\s+truth\s+is\s+(?:that\s+)?/i, kind: 'update' },
  { pattern: /^(?:actually,?\s*)?(?:that'?s|that is)\s+(?:no\s+longer|not)\s+true\b[.,]?\s*/i, kind: 'delete' },
  { pattern: /^(?:that'?s|that is)\s+(?:outdated|out\s+of\s+date|wrong|incorrect)\b[.,]?\s*/i, kind: 'delete' },
  { pattern: /^(?:i\s+was\s+wrong\s+about\s+that)\b[.,]?\s*/i, kind: 'delete' },
  { pattern: /^(?:forget|delete|remove)\s+(?:that|this|the)\s+(?:truth|fact)\b[.,]?\s*/i, kind: 'delete' },
  { pattern: /^(?:change|update|correct)\s+(?:that|this|the)\s+(?:truth|fact)\b[.,:-]?\s*/i, kind: 'update' },
  { pattern: /^(?:update|correct)\s+that\s+information\b[.,:-]?\s*/i, kind: 'update' },
];

/**
 * A correction to something already stored.
 *
 * An update carries its replacement when the sentence has one - "the new truth
 * is X" - and otherwise asks, because changing a stored fact to nothing in
 * particular is worse than changing nothing.
 */
export function truthEdit(said: string): TruthEdit | null {
  const text = said.trim().replace(/^(?:hey\s+|ok(?:ay)?\s+)?helix[,:]?\s*/i, '').trim();
  if (text === '') return null;

  for (const { pattern, kind } of EDITS) {
    const match = pattern.exec(text);
    if (!match) continue;

    const rest = text.slice(match[0].length).trim();
    // A correction phrased as a question is a question.
    if (rest !== '' && isQuestion(rest)) return null;

    return { kind, claim: kind === 'update' ? tidy(rest) : '', marker: match[0].trim() };
  }

  return null;
}

/**
 * How a stored truth is said back.
 *
 * This is the single place that stops a user's assertion being laundered into
 * a verified fact. "The truth is the moon is made of cheese" comes back as
 * something the user told Helix, never as something Helix knows - because
 * Helix does not know it, and nothing about having been told makes it so.
 */
export function phrase(claim: string, provenance: Provenance): string {
  const body = claim.replace(/\.$/, '');
  return provenance === 'user-belief'
    ? `You told me you believe ${lowerFirst(stripBelief(body))}.`
    : `You told me ${lowerFirst(body)}.`;
}

function stripBelief(claim: string): string {
  return claim.replace(BELIEF, '').replace(/^\s*(?:that\s+)?/i, '').trim();
}

function lowerFirst(text: string): string {
  // Only when the opening word is ordinary. Lowercasing a name would be a
  // different claim about a different thing.
  const first = text.split(/\s+/)[0] ?? '';
  if (first.length > 1 && first === first.toUpperCase()) return text;
  if (/^(?:i|i'm|i've)$/i.test(first)) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}
