import { CAPABILITIES, vocabulary, type Capability, type Risk, type Verb } from './registry.js';
import { normalise, type Normalised } from './normalise.js';

/**
 * Turning a sentence into a scored intent.
 *
 * The matcher is generic: it knows nothing about notes or drives, only about
 * subjects and verbs, and it reads both from the registry. That is what makes
 * a new capability an entry in a data file rather than a new branch here.
 *
 * HOW A SCORE IS ARRIVED AT, and why it is a score rather than a yes.
 *
 * Every earlier matcher in this codebase answered a boolean: either the
 * sentence contained the magic phrase or it did not. That is why "open my
 * notepad" worked and "pull up my notebook" did not, and it is why there was
 * no way to express "I am fairly sure but not sure enough to delete
 * something". Confidence replaces the boolean, and the policy in `decide` uses
 * it: act when high, ask a short question when middling, say what is unclear
 * when low. A destructive verb needs more of it than a safe one.
 *
 * The signals, in descending weight:
 *
 *   - An implied phrase. "Write this down" names no subject at all and is
 *     unmistakable, so it scores highest and carries its own verb.
 *   - A subject word. "Notebook" is strong evidence for the Notepad.
 *   - A verb word near that subject. "Pull ... up" plus "notebook" is an open.
 *   - Position. A subject at the front of a short sentence is more likely to
 *     be the topic than one mentioned in passing at the end.
 *
 * And against:
 *
 *   - A typo that had to be repaired costs a little confidence, because the
 *     repair itself was a judgement.
 *   - A sentence that mentions two capabilities is worth less for each.
 */

export interface Match {
  capability: Capability;
  verb: Verb;
  risk: Risk;
  /** True when this verb is useless without something to act on. */
  needsTarget: boolean;
  /** What the verb should act on, taken from the sentence. May be empty. */
  target: string;
  /** 0..1. */
  confidence: number;
  /** Why, in words, for the log and for a clarifying question. */
  because: string[];
}

/** Words that separate a verb from what it acts on. */
const TARGET_LEADS = [
  'about', 'regarding', 'mentioning', 'called', 'titled', 'named', 'on',
  'for', 'saying', 'that says', 'with',
];

/**
 * Pull the thing being acted on out of the sentence.
 *
 * Deliberately simple and deliberately willing to return nothing. A wrong
 * target is worse than no target: no target produces a clarifying question,
 * and a wrong one produces confident action on the wrong object.
 */
export function extractTarget(normalised: Normalised, capability: Capability): string {
  const text = normalised.text;

  for (const lead of TARGET_LEADS) {
    const at = text.indexOf(` ${lead} `);
    if (at === -1) continue;

    const tail = text
      .slice(at + lead.length + 2)
      .replace(/^(?:the|my|a|an|that|this)\s+/, '')
      .trim();
    if (tail !== '') return tail;
  }

  // "what did i write about X" handled above; this catches "find my X note".
  const aliasAt = capability.aliases
    .map((alias) => ({ alias, at: text.indexOf(alias) }))
    .filter((found) => found.at !== -1)
    .sort((a, b) => a.at - b.at)[0];

  if (aliasAt) {
    const after = text
      .slice(aliasAt.at + aliasAt.alias.length)
      .replace(/^(?:s\b)?\s*/, '')
      .replace(/^(?:the|my|a|an|that|this)\s+/, '')
      .trim();
    // Only when it reads as a name rather than the rest of an instruction.
    if (after !== '' && after.split(' ').length <= 6 && !TARGET_LEADS.includes(after)) {
      return after;
    }
  }

  return '';
}

function verbFor(capability: Capability, normalised: Normalised): {
  verb: Verb;
  risk: Risk;
  needsTarget: boolean;
  score: number;
  word: string | null;
} {
  const tokens = new Set(normalised.tokens);
  let best: { verb: Verb; risk: Risk; needsTarget: boolean; score: number; word: string | null } = {
    verb: capability.bare,
    risk: capability.verbs.find((entry) => entry.verb === capability.bare)?.risk ?? 'safe',
    needsTarget: false,
    score: 0,
    word: null,
  };

  for (const entry of capability.verbs) {
    for (const word of entry.words) {
      const present = word.includes(' ')
        ? normalised.text.includes(word)
        : tokens.has(word);
      if (!present) continue;

      /**
       * A destructive verb outranks a safe one that also matched.
       *
       * "Delete my note about X" contains both "delete" and "about", and
       * "about" is a search word. Read as a search it shows the note; read as
       * a delete it destroys it. The stronger reading wins, and the
       * confirmation pipeline then makes it safe - whereas a delete read as a
       * search silently does nothing the user asked for.
       */
      const weight = entry.risk === 'destructive' ? 3 : entry.verb === capability.bare ? 1 : 2;
      if (weight > best.score) {
        best = {
          verb: entry.verb,
          risk: entry.risk,
          needsTarget: entry.needsTarget,
          score: weight,
          word,
        };
      }
    }
  }

  return best;
}

/** Score one capability against a sentence. Null when it is not mentioned. */
function scoreCapability(capability: Capability, normalised: Normalised): Match | null {
  const because: string[] = [];
  let confidence = 0;

  const implied = capability.implied.find((phrase) => normalised.text.includes(phrase));
  if (implied !== undefined) {
    confidence += 0.75;
    because.push(`"${implied}" means the ${capability.label}`);
  }

  const alias = capability.aliases.find((word) => normalised.tokens.includes(word));
  if (alias !== undefined) {
    confidence += 0.6;
    because.push(`"${alias}" names the ${capability.label}`);

    // A subject in the first three words is the topic; one at the end is
    // usually an aside.
    const at = normalised.tokens.indexOf(alias);
    if (at <= 2) confidence += 0.1;
  }

  if (confidence === 0) return null;

  const verb = verbFor(capability, normalised);
  if (verb.word !== null) {
    confidence += 0.2;
    because.push(`"${verb.word}" means ${capability.verbs.find((v) => v.verb === verb.verb)?.summary ?? verb.verb}`);
  } else if (implied === undefined) {
    // A bare subject with no verb is a weaker request than one with both.
    confidence -= 0.05;
  }

  // Every repair was a judgement, and judgements should cost something.
  confidence -= normalised.repairs.length * 0.08;

  return {
    capability,
    verb: verb.verb,
    risk: verb.risk,
    needsTarget: verb.needsTarget,
    target: extractTarget(normalised, capability),
    confidence: Math.max(0, Math.min(1, confidence)),
    because,
  };
}

export interface MatchOptions {
  /** Pre-normalised text, when the caller has already done it. */
  normalised?: Normalised;
}

/** Every capability the sentence could mean, best first. */
export function matchCapabilities(text: string, options: MatchOptions = {}): Match[] {
  const normalised = options.normalised ?? normalise(text, vocabulary());

  const matches = CAPABILITIES.map((entry) => scoreCapability(entry, normalised)).filter(
    (match): match is Match => match !== null,
  );

  // A sentence naming two capabilities is less certain about each of them.
  if (matches.length > 1) {
    for (const match of matches) match.confidence = Math.max(0, match.confidence - 0.12);
  }

  return matches.sort((a, b) => b.confidence - a.confidence);
}
