/**
 * Label placement for the graph.
 *
 * Around a hub, every node wants to write its title in the same few hundred
 * pixels. Drawn naively the text overlaps into an unreadable smear, which is
 * worse than showing fewer labels.
 *
 * So labels are placed most-connected first, and any label whose box collides
 * with one already placed is skipped. The important names win, and what does
 * get drawn is always readable. Pure geometry, so it is testable without a
 * canvas.
 */

export interface LabelBox {
  id: string;
  text: string;
  /** Top-left of the box, in screen pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LabelCandidate {
  id: string;
  text: string;
  /** Node centre in screen pixels. */
  x: number;
  y: number;
  /** Node radius in screen pixels; the label sits below it. */
  radius: number;
  /** Higher wins a collision. Connection count, normally. */
  priority: number;
  /** Measured text width. */
  width: number;
}

export interface PlaceLabelsOptions {
  lineHeight?: number;
  /** Extra space around each box, so neighbours do not touch. */
  padding?: number;
  /** Labels below this priority are never drawn. */
  minPriority?: number;
  /** Hard cap, so a huge graph does not spend its frame on text. */
  maxLabels?: number;
  /** Viewport, so off-screen labels are skipped before any collision work. */
  viewport?: { width: number; height: number };
}

function overlaps(a: LabelBox, b: LabelBox, padding: number): boolean {
  return !(
    a.x + a.width + padding <= b.x ||
    b.x + b.width + padding <= a.x ||
    a.y + a.height + padding <= b.y ||
    b.y + b.height + padding <= a.y
  );
}

/**
 * Choose which labels to draw.
 *
 * Returns them in draw order. Candidates are sorted by priority descending, so
 * the most-connected node claims its space first and less important labels
 * give way.
 */
export function placeLabels(
  candidates: readonly LabelCandidate[],
  options: PlaceLabelsOptions = {},
): LabelBox[] {
  const lineHeight = options.lineHeight ?? 12;
  const padding = options.padding ?? 2;
  const minPriority = options.minPriority ?? 0;
  const maxLabels = options.maxLabels ?? 120;
  const viewport = options.viewport;

  const ranked = [...candidates]
    .filter((candidate) => candidate.priority >= minPriority)
    // Ties broken by id so the result is stable frame to frame; otherwise
    // labels would flicker in and out as sort order churned.
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  const placed: LabelBox[] = [];

  for (const candidate of ranked) {
    if (placed.length >= maxLabels) break;

    const box: LabelBox = {
      id: candidate.id,
      text: candidate.text,
      x: candidate.x - candidate.width / 2,
      y: candidate.y + candidate.radius + 3,
      width: candidate.width,
      height: lineHeight,
    };

    // Cheap rejection before the collision scan.
    if (viewport) {
      if (
        box.x + box.width < 0 ||
        box.y + box.height < 0 ||
        box.x > viewport.width ||
        box.y > viewport.height
      ) {
        continue;
      }
    }

    if (placed.some((existing) => overlaps(box, existing, padding))) continue;
    placed.push(box);
  }

  return placed;
}

/**
 * Shorten a title to fit a width budget, in characters.
 * A truncated label is still useful; an overflowing one is not.
 */
export function truncateLabel(text: string, maxChars = 22): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}
