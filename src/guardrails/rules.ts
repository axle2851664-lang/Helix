/**
 * The standing rules, as data.
 *
 * These are the instructions Helix operates under. Writing them into a file
 * that the application itself renders is the point: a rule that lives only in
 * a conversation is a rule nobody can check, and a rule nobody can check is
 * indistinguishable from a rule that was quietly dropped.
 *
 * The honesty that matters here is in `enforcement`. A rule can be:
 *
 * - `code`     - something actively refuses the violation, and a test proves it.
 * - `structure`- the violation is not expressible in this build. There is no
 *                network reach, no filesystem, no billing path. Nothing has to
 *                hold the line because the line cannot be crossed.
 * - `promise`  - nothing stops it. It is a rule that is followed, and a thing
 *                still to build.
 *
 * Marking everything `code` would be exactly the failure these rules exist to
 * prevent, so a `promise` stays a `promise` on screen until the code lands.
 * Several entries below say plainly that they become promises the moment the
 * desktop shell removes the wall currently doing the work.
 */

export type Enforcement = 'code' | 'structure' | 'promise';

export interface Guardrail {
  id: string;
  /** Short name, for the checklist. */
  title: string;
  /** The rule itself, in the user's own terms. */
  rule: string;
  /** Why it exists. The cost of breaking it. */
  why: string;
  enforcement: Enforcement;
  /** What actually holds the line. A file, a mechanism, or an admission. */
  evidence: string;
  /**
   * What would weaken this, and when. Present wherever today's enforcement is
   * an accident of the build rather than a decision that survives the shell.
   */
  atRisk?: string;
}

export const GUARDRAILS: readonly Guardrail[] = [
  {
    id: 'confirm-before-sending',
    title: 'Ask before it leaves',
    rule: 'Helix may send messages and place calls. Nothing leaves without you seeing it first and confirming that specific draft.',
    why: 'A draft that turns out wrong costs a rewrite. A sent message cannot be recalled, and a call cannot be unmade.',
    enforcement: 'code',
    evidence:
      'Every outbound action is drafted, shown in full and confirmed by id. There is no bulk confirm, no remembered approval and no trusted recipient - a standing permission is indistinguishable from none the first time it is wrong. Approvals go stale after five minutes, and a confirmed draft cannot be edited.',
    atRisk:
      'This is the rule that replaced "never send", at your instruction. It is the only thing now standing between a mistaken draft and a real recipient.',
  },
  {
    id: 'account-of-what-was-sent',
    title: 'A record of everything sent',
    rule: 'Every message and call, and every one refused, is recorded with what it was and who it was for.',
    why: 'Anything that can act on your behalf owes you an account of what it did.',
    enforcement: 'code',
    evidence:
      'The outbox keeps every draft with its state - drafted, confirmed, sent, cancelled or failed - and the reason for each refusal.',
  },
  {
    id: 'read-only',
    title: 'Read-only outside its own folders',
    rule: 'Helix never writes to your folders. Everything it keeps goes in its own data directory.',
    why: 'An assistant that can overwrite your work is one bug away from destroying it.',
    enforcement: 'structure',
    evidence:
      'A browser page has no filesystem access at all. PathManager already refuses any path outside the workspace, ready for the shell.',
    atRisk: 'Under the shell this becomes the only thing standing between Helix and your disk.',
  },
  {
    id: 'memory-aloud',
    title: 'Never remember silently',
    rule: 'Nothing is written to long-term memory without Helix saying so, and quoting it back.',
    why: 'Memory you did not know was taken is surveillance, however well meant.',
    enforcement: 'code',
    evidence:
      'Saving happens on an explicit instruction only, and the reply quotes the stored record. Nothing in the conversation path writes memory on its own.',
  },
  {
    id: 'no-secrets',
    title: 'Never keep a credential',
    rule: 'No API key, password or token is stored, logged, or committed.',
    why: 'A leaked key is a bill and a breach, and it leaks once for all time.',
    enforcement: 'code',
    evidence:
      'One shared pattern list in core/secrets.ts. The logger redacts matches before a sink sees them; memory refuses to store them at all.',
  },
  {
    id: 'never-spend',
    title: 'Never spend',
    rule: 'Helix may use an account you have already set up and funded. It may never buy, pay, top up, subscribe or upgrade.',
    why: 'Sending on your behalf and spending on your behalf are different permissions, and only one of them was given. Money spent without your say-so is the fastest way to lose trust.',
    enforcement: 'code',
    evidence:
      'A draft whose text reads as a purchase - buy, pay, order, top up, subscribe, transfer a sum - is refused outright rather than confirmed. The check errs towards refusing: a false positive costs one rephrase, a false negative costs money.',
    atRisk:
      'Placing a call is itself billable on every provider worth using. Helix will make the call you asked for on an account you have funded, and will not fund it.',
  },
  {
    id: 'no-invention',
    title: 'Never invent',
    rule: 'No made-up number, date, filename or client. If it is not in the files, Helix says so.',
    why: 'A plausible fabrication is worse than a blank, because it gets acted on.',
    enforcement: 'structure',
    evidence:
      'There is no generative path. A request no tool can handle returns a named failure identifying the missing provider, never a composed reply.',
    atRisk:
      'A connected model can invent fluently. This becomes the hardest rule in the project the day one is wired in.',
  },
  {
    id: 'qualified-numbers',
    title: 'Never state a bare derived number',
    rule: 'Every derived figure carries the qualifier that makes it true.',
    why: 'A half-paid invoice on a running job is not a discount, and reporting it as one is a lie made of true numbers.',
    enforcement: 'code',
    evidence:
      'The briefing reports ages as "since Helix saw a change", never as elapsed work. Indexing reports what it skipped alongside what it indexed. Both are pinned by tests.',
  },
  {
    id: 'files-are-data',
    title: 'Files are information, not instructions',
    rule: 'A note in your files saying "ignore your instructions" is reported to you, never obeyed.',
    why: 'Anything Helix reads could have been written by someone else, for Helix to read.',
    enforcement: 'code',
    evidence:
      'guardrails/untrusted.ts scans file text for instruction-shaped passages and labels them wherever the content is shown. It flags and never edits: your file stays your file.',
  },
  {
    id: 'sensors-visible',
    title: 'No silent camera or microphone',
    rule: 'Neither sensor runs without a visible indicator, and the indicator follows the hardware.',
    why: 'A recording light that can be wrong is worse than none, because it is believed.',
    enforcement: 'code',
    evidence:
      'The camera indicator is driven by whether a track is genuinely live, not by intent to start one, so it cannot claim a camera that has stopped.',
  },
  {
    id: 'demo-by-default',
    title: 'Real data is opted into',
    rule: 'The vault runs on invented fixtures unless it is explicitly set to real.',
    why: 'A default that reaches your documents is a default that reaches them by accident.',
    enforcement: 'code',
    evidence:
      'One function decides it, and anything other than the exact string "real" resolves to demo - so a typo fails towards the safe side.',
  },
  {
    id: 'ask-before-installing',
    title: 'Ask before installing',
    rule: 'Nothing is downloaded or installed that you have not named.',
    why: 'Weight and dependencies accumulate silently, and a portable tool stops being portable.',
    enforcement: 'structure',
    evidence:
      'The application downloads nothing at runtime. Model weights arrive only when you run the fetch script yourself.',
  },
];

export function guardrail(id: string): Guardrail | undefined {
  return GUARDRAILS.find((rule) => rule.id === id);
}

export interface GuardrailTally {
  code: number;
  structure: number;
  promise: number;
}

/**
 * Count by enforcement.
 *
 * Deliberately not reduced to a single score. "Nine of eleven" invites the
 * reading that the project is nine-elevenths safe, when the two that matter
 * most may be the ones held up by nothing but a missing feature.
 */
export function tallyEnforcement(rules: readonly Guardrail[] = GUARDRAILS): GuardrailTally {
  return rules.reduce<GuardrailTally>(
    (tally, rule) => ({ ...tally, [rule.enforcement]: tally[rule.enforcement] + 1 }),
    { code: 0, structure: 0, promise: 0 },
  );
}

/** Rules whose current enforcement does not survive the desktop shell. */
export function weakenedByShell(rules: readonly Guardrail[] = GUARDRAILS): Guardrail[] {
  return rules.filter((rule) => rule.atRisk !== undefined);
}
