/**
 * Catching a model that reports a state Havoc is not in.
 *
 * Measured, in a real conversation on a local model:
 *
 *   User: hello
 *   Havoc: You've sent a greeting.
 *   User: I supposed so brp
 *   Havoc: I'm still waiting for permission to proceed.
 *   User: proceed doing what?
 *   Havoc: I can't run a tool now.
 *   User: Which tool
 *   Havoc: I'm not sure.
 *
 * Nothing was waiting for permission. No tool existed to run. The model was
 * reading its own prompt back in paraphrase: an earlier version listed six
 * states to distinguish and four canned refusals to use, and a model with
 * nothing to say to "hello" ordered off that menu. The prompt no longer
 * carries the menu, which is the real fix. This is the proof.
 *
 * WHY THIS CAN BE CHECKED AT ALL, and checked with certainty rather than by
 * guessing at intent: it only runs on the conversational path. If a tool had
 * matched the request, the orchestrator would have executed it and never
 * reached a model. So on this path there is provably no tool running and
 * nothing outstanding for the user to approve, and any reply asserting
 * otherwise is false about Havoc's own state.
 *
 * That makes this a stricter relative of the rule the whole codebase is built
 * on. Inventing a fact about the world is bad; inventing a fact about what
 * Havoc is currently doing is worse, because the user cannot check it and it
 * sends them round in circles - "proceed doing what?" - chasing a task that
 * does not exist.
 *
 * WHAT IT MUST NOT CATCH is a statement about capability. "I'd need permission
 * to read your mail" describes what would be required and claims nothing about
 * now; "Havoc can do that once you allow it in Settings" is an instruction to
 * the user. Only present-tense claims about being in a state are matched.
 */

export type PhantomKind = 'permission' | 'running' | 'tool';

export interface PhantomVerdict {
  claimed: boolean;
  kind?: PhantomKind;
  /** The phrase that gave it away, for the log. */
  found?: string;
}

interface Probe {
  kind: PhantomKind;
  pattern: RegExp;
}

const PROBES: readonly Probe[] = [
  // "I'm still waiting for permission to proceed." Present tense, first
  // person, about now.
  {
    kind: 'permission',
    pattern:
      /\b(?:i'?m|i am)\s+(?:still\s+|currently\s+)?(?:waiting|awaiting|held up|blocked)\b[^.!?]{0,40}\b(?:permission|consent|approval|confirmation|authoris|authoriz)/i,
  },
  {
    kind: 'permission',
    pattern: /\b(?:still\s+)?waiting\s+(?:for|on)\s+(?:your\s+|the\s+)?(?:permission|consent|approval|confirmation)\b/i,
  },
  /**
   * The sanctioned refusal, which is sanctioned everywhere except here.
   *
   * `echo.ts` deliberately lets this through, because the prompt tells Havoc
   * to say it when it is true. On the conversational path it cannot be true:
   * there is nothing to get permission for.
   */
  {
    kind: 'permission',
    pattern: /\bi (?:need|require|still need)\s+(?:your\s+)?permission to (?:continue|proceed|go on)\b/i,
  },
  // "I'm running that now." Nothing is running.
  {
    kind: 'running',
    pattern: /\b(?:i'?m|i am)\s+(?:currently\s+|now\s+)?(?:running|executing|processing|performing)\b/i,
  },
  {
    kind: 'running',
    pattern: /\b(?:running|executing)\s+(?:it|that|this|the tool|the command)\s+now\b/i,
  },
  // "I can't run a tool now." There is no tool in this conversation at all.
  {
    kind: 'tool',
    pattern: /\bi (?:can'?t|cannot|am unable to)\s+(?:run|call|reach|use)\s+(?:a|the|any|that)\s+tool\b/i,
  },
  {
    kind: 'tool',
    pattern: /\bno tool (?:is |was )?(?:available|running|ready)\b/i,
  },
];

/**
 * Statements about what would be required, which are not claims about now.
 *
 * Checked first, because several of them contain the same words as a probe
 * and every one of them is a reply Havoc should be free to give.
 */
const CONDITIONAL: readonly RegExp[] = [
  /\bi(?:'d| would)\s+need\b/i,
  /\byou(?:'d| would|'ll| will)\s+need to\b/i,
  /\bonce you\b/i,
  /\bif you\s+(?:allow|permit|approve|grant)\b/i,
  /\bin settings\b/i,
];

/** Does this reply claim Havoc is in a state it is provably not in? */
export function claimsPhantomState(reply: string): PhantomVerdict {
  const trimmed = reply.trim();
  if (trimmed === '') return { claimed: false };

  for (const exempt of CONDITIONAL) {
    if (exempt.test(trimmed)) return { claimed: false };
  }

  for (const probe of PROBES) {
    const match = probe.pattern.exec(trimmed);
    if (match) return { claimed: true, kind: probe.kind, found: match[0].trim() };
  }

  return { claimed: false };
}
