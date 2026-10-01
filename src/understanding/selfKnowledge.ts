/**
 * Questions about Helix itself, answered by Helix.
 *
 * THE CONVERSATION THIS COMES FROM. A user asked how to give Helix permission
 * to read their files. The model - llama3.2:1b - answered:
 *
 *   "You can type 'I want to give you permission to access my files' at any
 *    time."
 *
 * There is no such mechanism. It invented one, the user typed the phrase in
 * good faith, and Helix opened the Files screen - which looked like
 * confirmation that the invented mechanism was real. The same exchange
 * produced a menu that does not exist, services that are not running, and a
 * configuration page "not stored in any files, database or any other
 * location".
 *
 * None of that is a hallucination about the world, which a user can check. It
 * is a hallucination about *Helix*, which they cannot - and which teaches them
 * a false mental model of the thing in front of them.
 *
 * THE RULE. A language model is told, in the prompt, that it cannot see how
 * Helix works. That is a request, and a small model declines it. So questions
 * about Helix's own operation are answered here instead, from the registries
 * that hold the real answers, and never reach a model at all.
 *
 * What is NOT here: anything Helix would have to guess at. Where the honest
 * answer is "that isn't a thing", it says so, and names the screen that is.
 */

/**
 * Note what is absent: which model is answering.
 *
 * That question already has a tool, and a better answer than this file could
 * give - it names the exact model, says whether it was substituted, and
 * explains what is missing when nothing would answer. Adding a second path to
 * it would be the duplicate system all of this is meant to avoid.
 */
export type SelfTopic =
  | 'permissions'
  | 'capabilities'
  | 'configuration'
  | 'memory-policy';

export interface SelfQuestion {
  topic: SelfTopic;
  /** The phrase that identified it, for the log. */
  matched: string;
}

interface Probe {
  topic: SelfTopic;
  patterns: readonly RegExp[];
}

const PROBES: readonly Probe[] = [
  {
    topic: 'permissions',
    patterns: [
      /\b(?:how|where)\s+(?:do|can|would)\s+i\s+(?:give|grant|allow|enable)\b/i,
      /\bgive\s+you\s+(?:permission|access)\b/i,
      /\bgrant\s+(?:you\s+)?(?:permission|access)\b/i,
      /\b(?:do|can)\s+you\s+have\s+permission\b/i,
      /\bpermission\s+to\s+(?:access|read|see|open)\b/i,
      /\bwhat\s+(?:are\s+you|can\s+you)\s+allowed\b/i,
      /\bdo\s+you\s+have\s+access\s+to\b/i,
    ],
  },
  {
    topic: 'capabilities',
    patterns: [
      /\bwhat\s+can\s+you\s+(?:do|help)\b/i,
      /\bwhat\s+(?:can'?t|cannot)\s+you\s+do\b/i,
      /\bwhat\s+are\s+you\s+(?:able|capable)\b/i,
      /\bwhat\s+(?:features|commands|tools)\b/i,
      /\bhow\s+do\s+i\s+use\s+you\b/i,
    ],
  },
  {
    topic: 'configuration',
    patterns: [
      /\bwhere\s+is\s+(?:the\s+)?(?:menu|settings?|configuration|config|options?)\b/i,
      /\bhow\s+do\s+i\s+(?:configure|set\s+up|change\s+(?:the\s+)?settings?)\b/i,
      /\b(?:start|stop|restart)\s+(?:the|these|those|your|its)?\s*services?\b/i,
      /\bwhat\s+(?:console|services?|daemon)\b/i,
      /\bhow\s+do\s+i\s+make\s+(?:it|that)\s+available\b/i,
    ],
  },
  {
    topic: 'memory-policy',
    patterns: [
      /\bwhat\s+do\s+you\s+(?:store|keep|save|record)\b/i,
      /\bdo\s+you\s+(?:store|keep|record)\s+(?:my|our|everything)\b/i,
      /\bis\s+(?:this|my\s+data)\s+(?:private|stored|saved)\b/i,
      /\bwhere\s+(?:does|do)\s+(?:my|this)\s+(?:data|information)\s+go\b/i,
    ],
  },
];

/** Is this a question about how Helix itself works? */
export function selfQuestion(text: string): SelfQuestion | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  for (const probe of PROBES) {
    for (const pattern of probe.patterns) {
      const match = pattern.exec(trimmed);
      if (match) return { topic: probe.topic, matched: match[0].trim() };
    }
  }

  return null;
}

export interface SelfFacts {
  /** Capability labels Helix can genuinely act on by conversation. */
  capabilities: readonly string[];
  /** How many permissions are granted, out of how many exist. */
  permissions: { granted: number; total: number };
}

/**
 * The answer, built from facts rather than from a prompt.
 *
 * Every number here is read from the thing that owns it. Nothing is phrased
 * as a capability Helix does not have, and where the honest answer is "that
 * is not how this works", it says so and names what is.
 */
export function answerAbout(topic: SelfTopic, facts: SelfFacts): string {
  switch (topic) {
    case 'permissions':
      return [
        'There is nothing to type. Helix asks when it actually needs something,',
        'and the dialog names what and why - you allow or refuse it there.',
        facts.permissions.granted === 0
          ? 'Nothing is granted at the moment.'
          : `${facts.permissions.granted} of ${facts.permissions.total} are granted.`,
        'Settings lists them all, and anything granted can be taken back.',
      ].join(' ');

    case 'capabilities':
      return [
        `By talking to me: ${facts.capabilities.join(', ')}.`,
        'The sidebar has the rest, and anything marked with a phase is not built yet.',
      ].join(' ');

    case 'configuration':
      return [
        'Helix has no menus or background services - it is this window and nothing else.',
        'Settings is in the sidebar for preferences and privacy, and Models for which model answers.',
      ].join(' ');

    case 'memory-policy':
      return [
        'Only what you ask me to keep, and I say so when I keep it.',
        'Nothing from a conversation is stored on its own, credentials are refused outright,',
        'and Memory lists everything with a way to delete it.',
      ].join(' ');
  }
}
