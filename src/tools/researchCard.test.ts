import { describe, expect, it } from 'vitest';
import { researchCard } from './researchCard.js';
import { countItems, spokenRepeatsCard } from './cards.js';
import type { ResearchFinding } from '../web/WebResearch.js';

/**
 * This module had no test at all, and the gap had a cost.
 *
 * `researchCard` returned `kind: 'result'` while `ToolCard.kind` was
 * `'brief' | 'plan' | 'requirement'`. The compiler said so from the commit
 * that introduced it; nothing ran the function, so nothing else did. The kind
 * is now a real member of the union, and these tests exist so the next person
 * to touch the card shape finds out here rather than from a blank icon.
 */

function finding(over: Partial<ResearchFinding> = {}): ResearchFinding {
  return {
    query: 'tauri vs electron size',
    results: [],
    failures: [],
    answered: [],
    suspicious: [],
    ...over,
  };
}

const result = (over: Partial<ResearchFinding['results'][number]> = {}) => ({
  title: 'Tauri vs Electron',
  url: 'https://example.test/a',
  snippet: 'Tauri bundles no browser runtime.',
  provider: 'DuckDuckGo',
  ...over,
});

describe('researchCard', () => {
  it('is a result card, not a brief', () => {
    // A brief is Helix summarising state it holds; this is what someone
    // else's index said. The distinction drives the icon and the accent.
    expect(researchCard(finding()).kind).toBe('result');
  });

  it('carries a caveat, as every card must', () => {
    expect(researchCard(finding()).caveat).not.toBe('');
  });

  it('names the query in the title', () => {
    expect(researchCard(finding({ query: 'who is the mayor' })).title).toContain(
      'who is the mayor',
    );
  });

  it('lists each source with its URL as the source field', () => {
    const card = researchCard(
      finding({ results: [result(), result({ url: 'https://example.test/b' })], answered: ['DuckDuckGo'] }),
    );
    const sources = card.sections.find((section) => section.heading === 'Sources');
    expect(sources?.items).toHaveLength(2);
    expect(sources?.items.map((item) => item.source)).toEqual([
      'https://example.test/a',
      'https://example.test/b',
    ]);
  });

  it('numbers sources so the spoken half can cite them', () => {
    const card = researchCard(finding({ results: [result()], answered: ['DuckDuckGo'] }));
    expect(card.sections[0]?.items[0]?.label).toBe('[1] Tauri vs Electron');
  });

  it('falls back to the URL when a provider returned no snippet', () => {
    const card = researchCard(
      finding({ results: [result({ snippet: '' })], answered: ['DuckDuckGo'] }),
    );
    expect(card.sections[0]?.items[0]?.detail).toBe('https://example.test/a');
  });

  /**
   * The distinction the card exists to preserve: nobody looked, versus nobody
   * found anything. Collapsing them tells a user their question has no answer
   * when in fact no provider was reachable.
   */
  it('separates "could not look" from "found nothing"', () => {
    const card = researchCard(
      finding({ failures: [{ provider: 'Brave', reason: 'No API key configured.' }] }),
    );
    const section = card.sections.find((s) => s.heading === 'Could not look');
    expect(section?.items[0]?.detail).toBe('No API key configured.');
    expect(card.subtitle).toBe('Nothing was able to search');
  });

  it('counts providers and sources in the subtitle, with singulars right', () => {
    expect(
      researchCard(finding({ results: [result()], answered: ['DuckDuckGo'] })).subtitle,
    ).toBe('1 source from 1 provider');

    expect(
      researchCard(
        finding({
          results: [result(), result({ url: 'https://example.test/b' })],
          answered: ['DuckDuckGo', 'Wikipedia'],
        }),
      ).subtitle,
    ).toBe('2 sources from 2 providers');
  });

  /**
   * A page that tries to instruct Helix is reported, never obeyed - and the
   * card is where the user is told. Both the flag on the row and the
   * explanation section are part of that, so both are asserted.
   */
  it('marks a page that carried instructions, and says it was not obeyed', () => {
    const card = researchCard(
      finding({
        results: [result()],
        answered: ['DuckDuckGo'],
        suspicious: [
          {
            url: 'https://example.test/a',
            findings: [
              { kind: 'override', description: 'd', matched: 'ignore your instructions', index: 0 },
            ],
          },
        ],
      }),
    );

    const sources = card.sections.find((s) => s.heading === 'Sources');
    expect(sources?.items[0]?.meta).toBe('contains instructions');
    expect(sources?.items[0]?.accent).toBe('warn');

    const flagged = card.sections.find(
      (s) => s.heading === 'Treated as data, not instruction',
    );
    expect(flagged?.items[0]?.detail).toContain('not obeyed');
    expect(flagged?.items[0]?.detail).toContain('override');
  });

  it('leaves out every section it has nothing for, rather than showing filler', () => {
    const card = researchCard(finding());
    expect(card.sections).toEqual([]);
    expect(countItems(card)).toBe(0);
  });

  it('gives the spoken line nothing to repeat verbatim', () => {
    const card = researchCard(finding({ results: [result()], answered: ['DuckDuckGo'] }));
    expect(spokenRepeatsCard('I found one source on that, and listed it.', card)).toBe(false);
  });

  it('every row names where it came from', () => {
    const card = researchCard(
      finding({
        results: [result()],
        answered: ['DuckDuckGo'],
        failures: [{ provider: 'Brave', reason: 'No API key configured.' }],
      }),
    );
    for (const section of card.sections) {
      for (const item of section.items) expect(item.source).not.toBe('');
    }
  });
});
