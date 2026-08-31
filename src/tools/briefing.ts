import type { CardAccent, CardItem, ToolCard, ToolReply } from './cards.js';
import { observe } from '../persona/voice.js';

/**
 * The briefing and the plan.
 *
 * Both read the same snapshot of what Helix actually holds - projects, the
 * knowledge index, long-term memory - and both are pure functions of it, so
 * they can be tested without a browser, a store or a clock.
 *
 * The brief asked for five items "ordered by what moves money". Helix cannot
 * do that, and pretending otherwise would be the most expensive kind of lie:
 * a confident ordering built on nothing. Helix has never been told what the
 * user sells, what a client is worth, or when anything is due. So the ordering
 * is by a rule it *can* defend - how long something has sat untouched in
 * Helix, and whether Helix can still search it - and that rule is printed on
 * the card rather than implied.
 *
 * Every number on these cards carries its scope. "14 days" is a claim about
 * the user's working life that Helix has no standing to make; "14 days since
 * Helix saw a change" is a claim about Helix's own store, which is the only
 * thing it can actually observe.
 */

const DAY_MS = 86_400_000;

/** One project, reduced to what a briefing can honestly say about it. */
export interface BriefProject {
  id: string;
  name: string;
  description: string;
  assetCount: number;
  /** How many of those files the knowledge index has a record for. */
  indexedCount: number;
  /**
   * How many of those records actually yielded text. Kept apart from
   * `indexedCount` because the two failures are different: a file that was
   * never indexed is work someone can do, and a file whose text could not be
   * read is a missing parser. Telling a user to index a scanned PDF again is
   * sending them to do something that cannot work.
   */
  searchableCount: number;
  updatedAt: number;
}

export interface BriefingInput {
  now: number;
  projects: readonly BriefProject[];
  /**
   * How many long-term memories exist. Used only as the signal for whether
   * Helix has been told anything about the user at all - it is not treated as
   * knowing who they are.
   */
  memoryCount: number;
  /**
   * Whether Helix is permitted to use long-term memory at all. Distinct from
   * a count of zero: "you have told me nothing" and "you have told me things
   * I am not allowed to read" are different sentences, and collapsing them
   * would have Helix report an empty record when the truth is a closed door.
   */
  memoryEnabled: boolean;
  knowledge: { documents: number; searchable: number };
}

/** The ordering rule, stated once and printed on both cards. */
const ORDERING_RULE =
  'Ordered by what has gone longest untouched in Helix and what Helix can no longer search - not by what it is worth. I have not been told what your work is, so I cannot rank it by money.';

const MAX_ITEMS = 5;

interface Ranked {
  project: BriefProject;
  score: number;
  reason: string;
  accent: CardAccent;
}

function daysSince(then: number, now: number): number {
  return Math.max(0, Math.floor((now - then) / DAY_MS));
}

/** Age, always phrased as something Helix observed rather than something you did. */
function ageMeta(project: BriefProject, now: number): string {
  const days = daysSince(project.updatedAt, now);
  if (days === 0) return 'changed today, as Helix has it';
  if (days === 1) return '1 day since Helix saw a change';
  return days + ' days since Helix saw a change';
}

/**
 * Score a project for attention.
 *
 * The reasons are ordered by how much they cost the user, not by how easy they
 * are to detect. Files Helix cannot search are worse than files that are
 * merely old, because the second is a fact about time and the first is a
 * capability quietly missing.
 */
function rank(project: BriefProject, now: number): Ranked {
  const age = Math.min(daysSince(project.updatedAt, now), 60);

  if (project.assetCount > 0 && project.indexedCount < project.assetCount) {
    const missing = project.assetCount - project.indexedCount;
    return {
      project,
      score: 1000 + age,
      reason:
        missing +
        ' of ' +
        project.assetCount +
        ' files have never been indexed, so I cannot search them',
      accent: 'warn',
    };
  }

  // Indexed, but nothing readable came out. Nobody can act on this by trying
  // harder, so it is reported here and deliberately kept out of the plan.
  if (project.assetCount > 0 && project.searchableCount < project.assetCount) {
    const unreadable = project.assetCount - project.searchableCount;
    return {
      project,
      score: 800 + age,
      reason:
        unreadable +
        ' of ' +
        project.assetCount +
        ' files are indexed but no text could be read from them',
      accent: 'warn',
    };
  }

  if (project.assetCount === 0) {
    return {
      project,
      score: 500 + age,
      reason: 'No files have been added to it yet',
      accent: 'quiet',
    };
  }

  return {
    project,
    score: age,
    reason:
      project.description.trim() === ''
        ? project.assetCount + ' files, all indexed. No description written'
        : project.assetCount + ' files, all indexed',
    accent: 'good',
  };
}

/** Deterministic ordering: score first, then id, so two runs agree. */
function rankAll(input: BriefingInput): Ranked[] {
  return input.projects
    .map((project) => rank(project, input.now))
    .sort((a, b) => b.score - a.score || a.project.id.localeCompare(b.project.id));
}

/** Context Helix can state without interpreting it. */
function standingSection(input: BriefingInput): CardItem[] {
  const items: CardItem[] = [];

  const held =
    input.memoryCount + ' ' + (input.memoryCount === 1 ? 'item' : 'items') + ' you asked me to keep';

  if (!input.memoryEnabled) {
    items.push({
      label: 'Long-term memory',
      detail:
        input.memoryCount === 0
          ? 'Nothing is stored, and nothing would be'
          : held + ', which I am not to read while this is off',
      meta: 'switched off',
      accent: 'warn',
      source: 'Settings',
    });
  } else {
    items.push({
      label: 'Long-term memory',
      meta: input.memoryCount === 0 ? 'nothing on record' : held,
      accent: input.memoryCount === 0 ? 'quiet' : 'normal',
      source: 'Memory',
    });
  }

  const unsearchable = input.knowledge.documents - input.knowledge.searchable;
  items.push({
    label: 'Indexed files',
    meta:
      input.knowledge.documents === 0
        ? 'nothing indexed'
        : input.knowledge.searchable + ' of ' + input.knowledge.documents + ' searchable',
    ...(unsearchable > 0
      ? { detail: unsearchable + ' indexed but with no readable text extracted' }
      : {}),
    accent: unsearchable > 0 ? 'warn' : 'normal',
    source: 'Knowledge index',
  });

  return items;
}

/**
 * The briefing: what is on hand, most-neglected first.
 *
 * When there is nothing, it says there is nothing. Padding an empty brief with
 * generalities is how an assistant teaches you to stop reading it.
 */
export function buildBrief(input: BriefingInput): ToolReply {
  const ranked = rankAll(input);
  const shown = ranked.slice(0, MAX_ITEMS);
  const hidden = ranked.length - shown.length;

  const items: CardItem[] = shown.map(({ project, reason, accent }) => ({
    label: project.name,
    detail: reason,
    meta: ageMeta(project, input.now),
    accent,
    source: 'Projects',
  }));

  const card: ToolCard = {
    kind: 'brief',
    title: 'Your briefing',
    subtitle:
      ranked.length === 0
        ? 'No projects on file'
        : shown.length +
          ' of ' +
          ranked.length +
          ' ' +
          (ranked.length === 1 ? 'project' : 'projects'),
    sections: [
      {
        heading: 'Wanting attention',
        items,
        empty:
          'No projects yet. Nothing here is a judgement on your work - Helix simply has not been given any.',
      },
      { heading: 'Standing', items: standingSection(input) },
    ],
    caveat:
      hidden > 0
        ? ORDERING_RULE +
          ' ' +
          hidden +
          ' further ' +
          (hidden === 1 ? 'project is' : 'projects are') +
          ' not shown.'
        : ORDERING_RULE,
  };

  return { spoken: briefSpoken(ranked, input), card };
}

/**
 * The half that is said out loud. One or two sentences, no lists, no numbers
 * worth writing down - those live on the card, which is the whole point of
 * there being two halves.
 */
function briefSpoken(ranked: readonly Ranked[], input: BriefingInput): string {
  if (ranked.length === 0 && input.memoryCount === 0 && input.knowledge.documents === 0) {
    return observe(
      'There is nothing to brief you on yet - no projects, no files, and nothing on record',
    );
  }
  if (ranked.length === 0) {
    return observe('No projects yet, though I do have your files and notes. The details are on screen');
  }

  const top = ranked[0];
  if (!top) return observe('Your briefing is on screen');

  const urgent = ranked.filter((entry) => entry.accent === 'warn').length;
  if (urgent > 0) {
    return observe(
      'A few things want attention, starting with ' +
        top.project.name +
        '. I have set out why on screen',
    );
  }
  return observe(
    top.project.name + ' has been quiet the longest. Nothing is pressing, and the rest is on screen',
  );
}

/**
 * The plan: the same state, turned into things that can actually be done.
 *
 * Each line says whose job it is. An assistant that lists work without saying
 * who does it is writing a wish, not a plan.
 */
export function buildPlan(input: BriefingInput): ToolReply {
  const items: CardItem[] = [];

  // Memory is off: asking the user to tell Helix things it cannot keep would
  // be a task designed to fail, so the switch is the item instead.
  if (!input.memoryEnabled) {
    items.push({
      label: 'Turn long-term memory back on, or leave it off deliberately',
      detail:
        'While it is off I cannot keep anything you tell me, so every briefing starts from nothing',
      meta: 'yours to do',
      accent: 'warn',
      source: 'Settings',
    });
  } else if (input.memoryCount === 0) {
    // Nothing on record at all: everything else is guesswork until this is done.
    items.push({
      label: 'Tell me what your work is',
      detail:
        'Say "remember that ..." with what you sell, who your clients are and what a job is worth. Until then I cannot order anything by value',
      meta: 'yours to do',
      accent: 'warn',
      source: 'Not on record',
    });
  }

  for (const entry of rankAll(input)) {
    if (items.length >= MAX_ITEMS) break;
    const { project } = entry;

    if (project.assetCount > project.indexedCount) {
      items.push({
        label: 'Index the files in ' + project.name,
        detail:
          project.assetCount -
          project.indexedCount +
          ' files cannot be searched until this is done',
        meta: 'I can do this',
        accent: 'warn',
        source: 'Projects',
      });
      continue;
    }

    // Indexed but unreadable: no action exists, so it stays off the plan
    // rather than becoming a task that cannot succeed.
    if (project.searchableCount < project.assetCount) continue;

    if (project.assetCount === 0) {
      items.push({
        label: 'Add files to ' + project.name + ', or remove it',
        detail: 'An empty project costs nothing but tells you nothing either',
        meta: 'yours to do',
        accent: 'quiet',
        source: 'Projects',
      });
      continue;
    }

    items.push({
      label: 'Return to ' + project.name,
      detail: entry.reason,
      meta: ageMeta(project, input.now),
      accent: 'normal',
      source: 'Projects',
    });
  }

  const card: ToolCard = {
    kind: 'plan',
    title: 'Today',
    subtitle:
      items.length === 0 ? 'Nothing outstanding' : items.length + ' of ' + MAX_ITEMS + ' at most',
    sections: [
      {
        items,
        empty:
          'Nothing outstanding that Helix can see. That is a statement about Helix, not about your day.',
      },
    ],
    caveat:
      'Built from what Helix holds - projects, files and notes. It knows nothing of your calendar, your inbox or your deadlines, so this is not your whole day.',
  };

  return { spoken: planSpoken(items), card };
}

function planSpoken(items: readonly CardItem[]): string {
  if (items.length === 0) {
    return observe('Nothing outstanding that I can see, though I only see what is in Helix');
  }
  const mine = items.filter((item) => item.meta === 'I can do this').length;
  const one = items.length === 1;
  const noun = one ? 'thing' : 'things';

  if (mine > 0) {
    const share = mine === 1 ? 'one is' : mine + ' are';
    return observe(
      items.length + ' ' + noun + ' for today, and ' + share + ' mine to do. The list is on screen',
    );
  }
  return observe(
    items.length +
      ' ' +
      noun +
      ' for today, all yours. ' +
      (one ? 'It is' : 'They are') +
      ' on screen',
  );
}
