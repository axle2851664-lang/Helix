/**
 * The structured card half of a two-part tool reply.
 *
 * The brief's rule: a tool answers with a short spoken line and a structured
 * card, and never the same text in both. The spoken line is what a person
 * wants to hear - one or two sentences, no lists, no numbers to memorise. The
 * card is what they want to look at afterwards.
 *
 * Saying the card out loud is the failure mode this shape exists to prevent.
 * Reading nine bullet points aloud is not an assistant, it is a screen reader.
 *
 * Two rules are encoded in the types rather than left to discipline:
 *
 * 1. **Every line carries its source.** `CardItem.source` names the store the
 *    line came from. A card cannot show a fact without saying where it got it,
 *    which is what stops invented detail slipping in beside real detail.
 *
 * 2. **Every card carries its limits.** `caveat` is required, not optional. If
 *    a card orders things, or counts things, or omits things, the reason is on
 *    the card - not left for the user to discover.
 */

export type CardAccent = 'normal' | 'good' | 'warn' | 'quiet';

export interface CardItem {
  /** The thing itself. Short - this is a row, not a paragraph. */
  label: string;
  /** Why this line is here, or what it means. */
  detail?: string;
  /**
   * The number or status, shown at the end of the row. Must carry its own
   * qualifier: "14 days since Helix saw a change", not "14 days".
   */
  meta?: string;
  accent?: CardAccent;
  /** Which store this came from. Required in practice; see the module note. */
  source: string;
}

export interface CardSection {
  heading?: string;
  items: CardItem[];
  /** Shown in place of the items when there are none. Never invents filler. */
  empty?: string;
}

export interface ToolCard {
  /**
   * Used by the UI for the accent colour and icon.
   *
   * Every member needs an entry in the view's icon map: an unlisted kind
   * renders no icon and fails the build, which is the intended trade.
   */
  kind: 'brief' | 'plan' | 'requirement' | 'result';
  title: string;
  subtitle?: string;
  sections: CardSection[];
  /**
   * What this card cannot tell you: the ordering rule, the missing input, the
   * scope of the numbers. Required, because a card that hides its limits is
   * more misleading than one that shows nothing.
   */
  caveat: string;
}

/** A tool reply: one line to say, one card to look at. */
export interface ToolReply {
  spoken: string;
  card: ToolCard;
}

/** Total rows across every section, for tests and for "and N more". */
export function countItems(card: ToolCard): number {
  return card.sections.reduce((total, section) => total + section.items.length, 0);
}

/**
 * True when the spoken line has been allowed to become the card.
 *
 * The check is deliberately blunt: a spoken line must be short, single-line,
 * and must not repeat a card row verbatim. It is used by the tests as an
 * executable version of "never the same text in both".
 */
export function spokenRepeatsCard(spoken: string, card: ToolCard): boolean {
  if (spoken.includes('\n')) return true;

  for (const section of card.sections) {
    for (const item of section.items) {
      if (item.detail && item.detail.length > 12 && spoken.includes(item.detail)) return true;
      if (item.meta && item.meta.length > 12 && spoken.includes(item.meta)) return true;
    }
  }
  return false;
}
