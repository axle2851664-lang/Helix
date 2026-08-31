import { beforeEach, describe, expect, it } from 'vitest';
import { buildBrief, buildPlan, type BriefProject, type BriefingInput } from './briefing.js';
import { countItems, spokenRepeatsCard } from './cards.js';
import { inboxRequirement, researchRequirement } from './requirements.js';
import { resetVoice } from '../persona/voice.js';

const NOW = Date.UTC(2026, 7, 30);
const DAY = 86_400_000;

const project = (over: Partial<BriefProject> & { id: string }): BriefProject => ({
  name: over.id,
  description: 'A project.',
  assetCount: 3,
  indexedCount: 3,
  searchableCount: 3,
  updatedAt: NOW - DAY,
  ...over,
});

const input = (over: Partial<BriefingInput> = {}): BriefingInput => ({
  now: NOW,
  projects: [],
  memoryCount: 2,
  memoryEnabled: true,
  knowledge: { documents: 3, searchable: 3 },
  ...over,
});

beforeEach(resetVoice);

describe('the two halves of a reply', () => {
  const cards = () => [
    buildBrief(input({ projects: [project({ id: 'alpha', indexedCount: 0 })] })),
    buildBrief(input()),
    buildPlan(input({ projects: [project({ id: 'alpha', assetCount: 0 })] })),
    buildPlan(input()),
    inboxRequirement(),
    researchRequirement('what a Tauri shell costs'),
  ];

  // The rule from the brief, made executable: never the same text in both.
  it('never lets the spoken line repeat the card', () => {
    for (const reply of cards()) {
      expect(spokenRepeatsCard(reply.spoken, reply.card), reply.spoken).toBe(false);
    }
  });

  it('keeps the spoken line short enough to say out loud', () => {
    for (const reply of cards()) {
      expect(reply.spoken.length, reply.spoken).toBeLessThanOrEqual(200);
      expect(reply.spoken).not.toContain('\n');
    }
  });

  it('addresses the user, as asked', () => {
    for (const reply of cards()) {
      expect(reply.spoken.toLowerCase(), reply.spoken).toContain('sir');
    }
  });

  // A card that hides what it cannot tell you is worse than no card.
  it('always states its limits', () => {
    for (const reply of cards()) {
      expect(reply.card.caveat.length).toBeGreaterThan(40);
    }
  });

  // Provenance is the difference between a fact and an assertion.
  it('names a source on every row', () => {
    for (const reply of cards()) {
      for (const section of reply.card.sections) {
        for (const item of section.items) {
          expect(item.source, item.label).toBeTruthy();
        }
      }
    }
  });
});

describe('buildBrief', () => {
  it('says there is nothing rather than inventing something', () => {
    const reply = buildBrief(
      input({ memoryCount: 0, knowledge: { documents: 0, searchable: 0 } }),
    );

    expect(reply.spoken).toContain('nothing to brief you on');
    expect(reply.card.sections[0]?.items).toEqual([]);
    expect(reply.card.sections[0]?.empty).toBeTruthy();
  });

  it('shows at most five projects and says how many it hid', () => {
    const projects = Array.from({ length: 9 }, (_, i) =>
      project({ id: 'p' + i, updatedAt: NOW - i * DAY }),
    );
    const reply = buildBrief(input({ projects }));

    expect(reply.card.sections[0]?.items).toHaveLength(5);
    expect(reply.card.caveat).toContain('4 further projects');
  });

  it('puts files it cannot search above files that are merely old', () => {
    const reply = buildBrief(
      input({
        projects: [
          project({ id: 'ancient', updatedAt: NOW - 300 * DAY }),
          project({ id: 'unindexed', indexedCount: 0, updatedAt: NOW }),
        ],
      }),
    );

    expect(reply.card.sections[0]?.items[0]?.label).toBe('unindexed');
  });

  // A scanned PDF is indexed and unsearchable at once. Reporting it as
  // "not indexed" would send the user to do something that cannot work.
  it('separates never-indexed from indexed-but-unreadable', () => {
    const never = buildBrief(input({ projects: [project({ id: 'a', indexedCount: 0, searchableCount: 0 })] }));
    const unreadable = buildBrief(
      input({ projects: [project({ id: 'a', indexedCount: 3, searchableCount: 0 })] }),
    );

    expect(never.card.sections[0]?.items[0]?.detail).toContain('never been indexed');
    expect(unreadable.card.sections[0]?.items[0]?.detail).toContain('no text could be read');
  });

  /**
   * The rule the user set: a derived number never appears without the
   * qualifier that makes it true. Helix can only observe its own store, so an
   * age is always "since Helix saw a change", never "since you worked on it".
   */
  it('qualifies every age with whose observation it is', () => {
    const reply = buildBrief(input({ projects: [project({ id: 'a', updatedAt: NOW - 14 * DAY })] }));
    const meta = reply.card.sections[0]?.items[0]?.meta ?? '';

    expect(meta).toContain('14');
    expect(meta).toContain('Helix');
  });

  it('admits it cannot order by money', () => {
    const reply = buildBrief(input({ projects: [project({ id: 'a' })] }));
    expect(reply.card.caveat).toContain('money');
  });

  it('reports memory being switched off as different from having none', () => {
    const off = buildBrief(input({ memoryEnabled: false, memoryCount: 4 }));
    const empty = buildBrief(input({ memoryCount: 0 }));

    const offRow = off.card.sections[1]?.items[0];
    const emptyRow = empty.card.sections[1]?.items[0];

    expect(offRow?.meta).toBe('switched off');
    expect(emptyRow?.meta).toBe('nothing on record');
  });

  it('is deterministic for the same input', () => {
    const projects = [project({ id: 'b' }), project({ id: 'a' })];
    const first = buildBrief(input({ projects }));
    resetVoice();
    const second = buildBrief(input({ projects }));

    expect(second.card).toEqual(first.card);
  });
});

describe('buildPlan', () => {
  it('asks to be told about the work when nothing is on record', () => {
    const reply = buildPlan(input({ memoryCount: 0 }));
    expect(reply.card.sections[0]?.items[0]?.label).toContain('what your work is');
  });

  it('does not nag once something has been stored', () => {
    const reply = buildPlan(input({ memoryCount: 3 }));
    const labels = (reply.card.sections[0]?.items ?? []).map((item) => item.label);
    expect(labels.some((label) => label.includes('what your work is'))).toBe(false);
  });

  // Turning the switch back on is the only task worth giving; asking the user
  // to store something while storage is off is a task designed to fail.
  it('offers the switch rather than an impossible instruction', () => {
    const reply = buildPlan(input({ memoryEnabled: false, memoryCount: 0 }));
    const first = reply.card.sections[0]?.items[0];

    expect(first?.label).toContain('memory');
    expect(first?.label).not.toContain('what your work is');
  });

  it('says whose job each line is', () => {
    const reply = buildPlan(
      input({
        memoryCount: 1,
        projects: [project({ id: 'a', indexedCount: 0 }), project({ id: 'b', assetCount: 0 })],
      }),
    );

    const metas = (reply.card.sections[0]?.items ?? []).map((item) => item.meta);
    expect(metas).toContain('I can do this');
    expect(metas).toContain('yours to do');
  });

  // Nothing can be done about a file whose text will not extract, so it must
  // not appear as a task.
  it('leaves out work that cannot succeed', () => {
    const reply = buildPlan(
      input({
        memoryCount: 1,
        projects: [project({ id: 'scans', indexedCount: 3, searchableCount: 0 })],
      }),
    );

    expect(reply.card.sections[0]?.items).toEqual([]);
  });

  it('never exceeds five items', () => {
    const projects = Array.from({ length: 12 }, (_, i) =>
      project({ id: 'p' + i, indexedCount: 0, updatedAt: NOW - i * DAY }),
    );
    const reply = buildPlan(input({ memoryCount: 0, projects }));
    expect(countItems(reply.card)).toBeLessThanOrEqual(5);
  });

  it('does not pretend to know the day', () => {
    const reply = buildPlan(input());
    expect(reply.card.caveat).toContain('calendar');
  });
});

describe('the tools that cannot run', () => {
  it('shows no message content for the inbox', () => {
    const reply = inboxRequirement();
    expect(reply.card.caveat).toContain('never seen your mail');
    // Nothing that could be mistaken for a message.
    for (const section of reply.card.sections) {
      for (const item of section.items) {
        expect(item.source).not.toBe('Inbox');
      }
    }
  });

  /**
   * The permission changed: Helix may send now. What must stay visible is the
   * gate that replaced the prohibition, and the fact that spending did not
   * change with it.
   */
  it('keeps the confirmation gate and the spending rule visible in the product', () => {
    const labels = inboxRequirement()
      .card.sections.flatMap((section) => section.items)
      .map((item) => item.label);

    expect(labels.some((label) => label.includes('Nothing leaves unconfirmed'))).toBe(true);
    expect(labels.some((label) => label.includes('not spend'))).toBe(true);
    expect(labels.some((label) => label.includes('will not send'))).toBe(false);
  });

  it('names the content policy as the blocker, not a missing key', () => {
    const details = researchRequirement('anything')
      .card.sections.flatMap((section) => section.items)
      .map((item) => item.detail ?? '');

    expect(details.join(' ')).toContain("connect-src 'self'");
  });

  it('echoes the query back so it is clear nothing was looked up', () => {
    const reply = researchRequirement('the price of a Tauri build');
    const labels = reply.card.sections.flatMap((section) => section.items).map((i) => i.label);

    expect(labels).toContain('the price of a Tauri build');
  });

  it('refuses to answer from memory instead', () => {
    expect(researchRequirement('x').card.caveat).toContain('from my own knowledge');
  });

  it('handles an empty query without an empty row', () => {
    const reply = researchRequirement('   ');
    const labels = reply.card.sections.flatMap((section) => section.items).map((i) => i.label);

    expect(labels).not.toContain('');
  });
});
