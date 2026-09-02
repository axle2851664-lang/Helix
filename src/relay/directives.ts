/**
 * Telling the phone to do something, from the other end of a mailbox.
 *
 * The return leg works because iOS Shortcuts has an Email automation trigger:
 * an automation can watch for mail from a given sender with a given subject
 * and run without being touched. So Helix replies, the phone wakes, and a
 * Shortcut reads a directive line and acts on it.
 *
 * That is a remote-control channel into a phone, which makes the design of
 * this file mostly a list of things it refuses to do.
 *
 * **Directives come from the user's own words, never from the model.** This is
 * the decision the whole file rests on. The obvious build is to let the model
 * write directives - it is already composing the reply, and it could phrase
 * them perfectly. It is also a language model, which means the directive line
 * would be generated text, and generated text is exactly what nobody should be
 * executing on a phone. So `matchPhoneAction` reads the *instruction the user
 * sent*, matches it against a closed list, and emits a directive only on an
 * exact structural match. The model's prose is carried alongside, never parsed.
 *
 * **And the model's prose is scrubbed before it goes.** A reply that happens to
 * contain a line starting `helix-do:` - because the user asked Helix to explain
 * how directives work, or because a mail it summarised contained one - would be
 * executed by the phone. `stripDirectives` removes any such line from text
 * Helix did not generate as a directive, and the real one is appended
 * afterwards by code. Without that step this file would be an injection
 * vector with a friendly interface.
 *
 * **Nothing here is destructive or outward-facing.** Every action is reversible
 * from the phone in one tap, and none of them sends anything to anybody. No
 * messaging, no calling, no deleting, no purchases, no toggling the radios the
 * phone needs to be reachable at all. A remote channel is the wrong place to
 * put an irreversible action, however well authenticated it is.
 */

/** The marker the phone-side Shortcut looks for. One line, at the end. */
export const DIRECTIVE_PREFIX = 'helix-do:';

/** An action the phone is allowed to be asked to perform. */
export interface PhoneAction {
  /** Wire name, matched by the Shortcut. */
  name: string;
  /** What it does, for the setup guide and for the user's own reassurance. */
  describes: string;
  /** Phrases that select it, matched at the start of the instruction. */
  triggers: readonly string[];
  /** How the argument is read, when there is one. */
  argument: 'none' | 'percent' | 'minutes' | 'text' | 'onoff';
}

/**
 * The closed list.
 *
 * Deliberately short, and each entry earns its place by being reversible and
 * self-contained. Absent on purpose: sending messages or making calls (they
 * reach other people and the standing rule is that nothing leaves without a
 * confirmed draft), anything that deletes, and Wi-Fi or cellular toggles - a
 * remote command that can cut the phone off the network can also make itself
 * the last command you ever send it.
 */
export const PHONE_ACTIONS: readonly PhoneAction[] = [
  {
    name: 'speak',
    describes: 'Read the answer aloud on the phone.',
    triggers: ['read that out', 'say that out loud', 'speak the answer', 'read it to me'],
    argument: 'text',
  },
  {
    name: 'brightness',
    describes: 'Set screen brightness.',
    triggers: ['set brightness to', 'set the brightness to', 'brightness to'],
    argument: 'percent',
  },
  {
    name: 'volume',
    describes: 'Set the volume.',
    triggers: ['set volume to', 'set the volume to', 'volume to'],
    argument: 'percent',
  },
  {
    name: 'torch',
    describes: 'Turn the torch on or off.',
    triggers: ['turn the torch', 'turn torch', 'turn the flashlight', 'torch'],
    argument: 'onoff',
  },
  {
    name: 'low-power',
    describes: 'Turn Low Power Mode on or off.',
    triggers: ['low power mode', 'turn low power'],
    argument: 'onoff',
  },
  {
    name: 'play',
    describes: 'Resume playback.',
    triggers: ['play music', 'resume music', 'play my music'],
    argument: 'none',
  },
  {
    name: 'pause',
    describes: 'Pause playback.',
    triggers: ['pause music', 'stop the music', 'pause my music'],
    argument: 'none',
  },
  {
    name: 'timer',
    describes: 'Start a timer.',
    triggers: ['set a timer for', 'start a timer for', 'timer for'],
    argument: 'minutes',
  },
];

export interface Directive {
  action: string;
  /** Empty where the action takes none. Already validated for its kind. */
  argument: string;
}

/** Politeness that precedes an instruction without changing it. */
const LEAD_IN = /^(?:(?:hey\s+)?helix[,.]?|please|could you|can you|would you|will you)\s+/;

/** Longest trigger first, so "set the brightness to" beats "brightness". */
const ORDERED = [...PHONE_ACTIONS]
  .flatMap((action) => action.triggers.map((trigger) => ({ action, trigger })))
  .sort((a, b) => b.trigger.length - a.trigger.length);

function readPercent(rest: string): string | null {
  const match = /^(\d{1,3})\s*%?/.exec(rest.trim());
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  // Clamped rather than refused: "set brightness to 150" is a clear intention
  // with a sloppy number, and 100 is unambiguously what was meant.
  return String(Math.min(100, Math.max(0, value)));
}

function readMinutes(rest: string): string | null {
  const match = /^(\d{1,4})\s*(?:minutes?|mins?|m)?\b/.exec(rest.trim());
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  // A twelve-hour timer set by accident is a phone that buzzes in the night.
  if (!Number.isFinite(value) || value < 1 || value > 600) return null;
  return String(value);
}

function readOnOff(rest: string, whole: string): string | null {
  const text = `${whole} ${rest}`.toLowerCase();
  if (/\boff\b/.test(text)) return 'off';
  if (/\bon\b/.test(text)) return 'on';
  return null;
}

/**
 * Does this instruction name a phone action?
 *
 * Null for everything else, which is almost everything - an ordinary question
 * gets an ordinary answer and no directive at all. Matching is anchored to the
 * start of the instruction after a polite lead-in, so a phone action mentioned
 * in passing inside a longer sentence does not fire one.
 */
export function matchPhoneAction(instruction: string, answer = ''): Directive | null {
  let cleaned = instruction.trim().toLowerCase();

  // Looped, because lead-ins chain. "Helix, could you set brightness to 25"
  // carries two, and a single pass left the second in place and failed to
  // match a perfectly ordinary sentence.
  for (;;) {
    const shorter = cleaned.replace(LEAD_IN, '').trim();
    if (shorter === cleaned) break;
    cleaned = shorter;
  }

  for (const { action, trigger } of ORDERED) {
    if (!cleaned.startsWith(trigger)) continue;
    const rest = cleaned.slice(trigger.length);

    switch (action.argument) {
      case 'none':
        return { action: action.name, argument: '' };
      case 'percent': {
        const value = readPercent(rest);
        return value === null ? null : { action: action.name, argument: value };
      }
      case 'minutes': {
        const value = readMinutes(rest);
        return value === null ? null : { action: action.name, argument: value };
      }
      case 'onoff': {
        const value = readOnOff(rest, trigger);
        return value === null ? null : { action: action.name, argument: value };
      }
      case 'text': {
        // The thing to speak is Helix's own answer, not the instruction.
        const spoken = answer.trim();
        return spoken === '' ? null : { action: action.name, argument: oneLine(spoken) };
      }
    }
  }

  return null;
}

/** Directives are one line, so anything multi-line is flattened. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

/**
 * Remove anything that looks like a directive from text Helix did not author
 * as one.
 *
 * The step without which this whole file is an injection vector. Model prose
 * reaches the phone, and a line beginning `helix-do:` in that prose would be
 * executed - whether it got there because the user asked Helix to explain the
 * directive format, or because Helix summarised an email that contained one.
 */
export function stripDirectives(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trim().toLowerCase().startsWith(DIRECTIVE_PREFIX))
    .join('\n')
    .trim();
}

/**
 * The reply body: the answer, scrubbed, with at most one directive appended.
 *
 * Order matters. The scrub runs over the model's text first and the directive
 * is added afterwards by code, so the only directive that can survive is the
 * one this function put there.
 */
export function composeReply(answer: string, directive: Directive | null): string {
  const body = stripDirectives(answer);
  if (directive === null) return body;

  const line = directive.argument === ''
    ? `${DIRECTIVE_PREFIX} ${directive.action}`
    : `${DIRECTIVE_PREFIX} ${directive.action} ${directive.argument}`;

  return body === '' ? line : `${body}\n\n${line}`;
}
