import { describe, expect, it } from 'vitest';
import {
  describeArc,
  describeReasoning,
  polarToCartesian,
  reactorSegments,
  segmentAngles,
  type ReactorInput,
} from './capabilities.js';
import { rotateWindow, suggestedPrompts, type PromptInput } from './prompts.js';

const input = (over: Partial<ReactorInput> = {}): ReactorInput => ({
  online: true,
  languageProvider: 'none',
  hearingBlocker: null,
  hearingProvider: 'local',
  speechBlocker: null,
  visionProvider: 'none',
  gestureProvider: 'none',
  memoryAllowed: true,
  durableStorage: true,
  projectCount: 0,
  searchableFiles: 0,
  ...over,
});

const find = (over: Partial<ReactorInput>, id: string) =>
  reactorSegments(input(over)).find((segment) => segment.id === id);

describe('reactorSegments', () => {
  it('keeps a fixed order, so a segment never moves between renders', () => {
    const a = reactorSegments(input()).map((segment) => segment.id);
    const b = reactorSegments(input({ memoryAllowed: false, projectCount: 9 })).map((s) => s.id);
    expect(b).toEqual(a);
  });

  // The rule this whole module exists for: no segment is lit for effect.
  it('gives every segment a reason in words', () => {
    for (const segment of reactorSegments(input())) {
      expect(segment.reason.length, segment.id).toBeGreaterThan(10);
      expect(segment.reason.trim().endsWith('.'), segment.id).toBe(true);
    }
  });

  /**
   * This used to read "never lights reasoning, because nothing connects to a
   * model", and it was correct for as long as that held. It stopped holding
   * when a local model started answering, and the segment went on reporting
   * REASONING as unavailable on a screen where Helix was replying - the exact
   * fabricated status this module exists to prevent, in the one direction
   * nobody thinks to check.
   *
   * A stated preference still cannot light it. Only a router naming what would
   * actually answer can.
   */
  it('stays dark on a preference alone', () => {
    expect(find({ languageProvider: 'cloud' }, 'reason')?.state).toBe('unavailable');
    expect(find({ languageProvider: 'local' }, 'reason')?.state).toBe('unavailable');
  });

  it('lights when something would genuinely answer', () => {
    const segment = find(
      { languageProvider: 'none', reasoning: { model: 'qwen2.5:3b', local: true } },
      'reason',
    );

    expect(segment?.state).toBe('ready');
    expect(segment?.reason).toContain('qwen2.5:3b');
  });

  // Where the words go matters as much as whether the light is on: running
  // locally is a privacy fact, and the ring is where the user reads it.
  it('says a local model keeps the conversation on the machine', () => {
    const local = find({ reasoning: { model: 'qwen2.5:3b', local: true } }, 'reason');
    const cloud = find({ reasoning: { model: 'gpt-oss 120B', local: false } }, 'reason');

    expect(local?.reason).toContain('leaves it');
    expect(cloud?.reason).not.toContain('leaves it');
  });

  it('distinguishes no provider from a selected one that cannot run', () => {
    expect(find({ languageProvider: 'none' }, 'reason')?.reason).toContain('No language provider');
    expect(find({ languageProvider: 'cloud' }, 'reason')?.reason).toContain('nothing is reachable');
  });

  describe('describeReasoning', () => {
    it('reports null when nothing would answer', () => {
      expect(
        describeReasoning({ describeSelection: () => ({ model: null, provider: null }) }),
      ).toBeNull();
    });

    it('carries the model name and whether it is local', () => {
      expect(
        describeReasoning({
          describeSelection: () => ({
            model: { name: 'qwen2.5:3b' },
            provider: { location: 'local' },
          }),
        }),
      ).toEqual({ model: 'qwen2.5:3b', local: true });
    });

    // A model with no provider to run it is not a working arrangement, and
    // half an answer here would light the segment on nothing.
    it('needs both halves before it reports anything', () => {
      expect(
        describeReasoning({
          describeSelection: () => ({ model: { name: 'orphan' }, provider: null }),
        }),
      ).toBeNull();
    });
  });

  /**
   * Browser speech recognition works and sends audio to Google. Filing that
   * under "working" would hide the cost; filing it under "broken" would be
   * wrong. It gets its own state with the caveat attached.
   */
  it('marks browser speech as working with a caveat, and names the caveat', () => {
    const segment = find({ hearingProvider: 'browser' }, 'hearing');

    expect(segment?.state).toBe('caveat');
    expect(segment?.reason).toContain('Google');
  });

  it('lights local speech without a caveat', () => {
    const segment = find({ hearingProvider: 'local' }, 'hearing');

    expect(segment?.state).toBe('ready');
    expect(segment?.reason).toContain('this machine');
  });

  it('repeats the voice manager reason verbatim rather than guessing', () => {
    const segment = find({ hearingBlocker: 'The microphone is blocked by the browser.' }, 'hearing');

    expect(segment?.state).toBe('unavailable');
    expect(segment?.reason).toBe('The microphone is blocked by the browser.');
  });

  it('separates memory switched off from memory that will not survive', () => {
    expect(find({ memoryAllowed: false }, 'memory')?.state).toBe('unavailable');

    const sessionOnly = find({ durableStorage: false }, 'memory');
    expect(sessionOnly?.state).toBe('caveat');
    expect(sessionOnly?.reason).toContain('lost when this tab closes');
  });

  it('separates having no projects from having indexed nothing', () => {
    expect(find({ projectCount: 0 }, 'files')?.state).toBe('unavailable');
    expect(find({ projectCount: 2, searchableFiles: 0 }, 'files')?.state).toBe('caveat');
    expect(find({ projectCount: 2, searchableFiles: 5 }, 'files')?.state).toBe('ready');
  });

  // Being online does not make the web reachable from this build, and saying
  // "not configured" would send someone looking for a setting that cannot help.
  it('blames the content policy for reach, not a missing setting', () => {
    const segment = find({ online: true }, 'reach');

    expect(segment?.state).toBe('unavailable');
    expect(segment?.reason).toContain("connect-src is 'self'");
  });

  it('still explains reach when the machine is offline', () => {
    expect(find({ online: false }, 'reach')?.reason).toContain('Offline');
  });
});

describe('ring geometry', () => {
  it('starts at twelve o clock', () => {
    const point = polarToCartesian(100, 100, 50, 0);

    expect(point.x).toBeCloseTo(100);
    expect(point.y).toBeCloseTo(50);
  });

  it('runs clockwise', () => {
    expect(polarToCartesian(100, 100, 50, 90).x).toBeCloseTo(150);
  });

  it('divides the circle evenly', () => {
    const angles = segmentAngles(8);
    expect(angles).toHaveLength(8);

    for (let i = 1; i < angles.length; i += 1) {
      const previous = angles[i - 1];
      const current = angles[i];
      if (!previous || !current) throw new Error('missing angle');
      expect(current.start).toBeGreaterThan(previous.end);
    }
  });

  // The gap comes out of each segment, so the ring closes at 360 whatever the
  // count. Adding it between segments would overflow and wrap.
  it('closes the ring for any segment count', () => {
    for (const count of [1, 2, 3, 5, 8, 13]) {
      const angles = segmentAngles(count);
      expect(angles.at(-1)?.end, String(count)).toBeLessThanOrEqual(360);
      expect(angles[0]?.start, String(count)).toBeGreaterThanOrEqual(0);
    }
  });

  it('never lets the gap swallow a segment', () => {
    for (const angle of segmentAngles(12, 90)) {
      expect(angle.end).toBeGreaterThan(angle.start);
    }
  });

  it('handles an empty ring', () => {
    expect(segmentAngles(0)).toEqual([]);
  });

  it('writes a finite arc path', () => {
    const path = describeArc(110, 110, 96, 3, 42);

    expect(path).toMatch(/^M [\d.-]+ [\d.-]+ A /);
    expect(path).not.toContain('NaN');
  });

  it('sets the large-arc flag only past a half turn', () => {
    expect(describeArc(0, 0, 10, 0, 90).split(' ')[7]).toBe('0');
    expect(describeArc(0, 0, 10, 0, 270).split(' ')[7]).toBe('1');
  });
});

describe('suggestedPrompts', () => {
  const promptInput = (over: Partial<PromptInput> = {}): PromptInput => ({
    memoryAllowed: true,
    memoryCount: 0,
    projectCount: 0,
    unindexedFiles: 0,
    searchableFiles: 0,
    hearingBlocker: 'No speech provider.',
    ...over,
  });

  const texts = (over: Partial<PromptInput> = {}) =>
    suggestedPrompts(promptInput(over)).map((prompt) => prompt.text);

  /**
   * The rule: a suggestion is a promise. Offering the inbox makes Helix look
   * like something that reads inboxes, and the honest card that comes back
   * does not undo the impression.
   */
  it('never advertises what Helix cannot do', () => {
    const all = texts({ memoryCount: 4, projectCount: 3, searchableFiles: 9, unindexedFiles: 2 })
      .join(' ')
      .toLowerCase();

    expect(all).not.toContain('inbox');
    expect(all).not.toContain('search the web');
    expect(all).not.toContain('look up');
  });

  it('always offers the two that need nothing switched on', () => {
    expect(texts()).toContain('Brief me');
    expect(texts()).toContain('Plan my day');
  });

  it('offers indexing only when something is unindexed', () => {
    expect(texts({ unindexedFiles: 0 })).not.toContain('Index my files');
    expect(texts({ unindexedFiles: 3 })).toContain('Index my files');
  });

  it('offers file search only once something is searchable', () => {
    expect(texts({ searchableFiles: 0 }).some((t) => t.startsWith('Search my files'))).toBe(false);
    expect(texts({ searchableFiles: 2 }).some((t) => t.startsWith('Search my files'))).toBe(true);
  });

  it('does not offer to recall memories that do not exist', () => {
    expect(texts({ memoryCount: 0 })).not.toContain('What do you remember?');
    expect(texts({ memoryCount: 1 })).toContain('What do you remember?');
  });

  it('says nothing about memory when memory is switched off', () => {
    const all = texts({ memoryAllowed: false, memoryCount: 5 }).join(' ');
    expect(all.toLowerCase()).not.toContain('remember');
  });

  it('invites speech only when speech input actually works', () => {
    expect(texts({ hearingBlocker: 'No provider.' }).some((t) => t.includes('talk'))).toBe(false);
    expect(texts({ hearingBlocker: null }).some((t) => t.includes('talk'))).toBe(true);
  });

  it('tells the user what each one will do', () => {
    for (const prompt of suggestedPrompts(promptInput())) {
      expect(prompt.outcome.length, prompt.text).toBeGreaterThan(15);
    }
  });

  it('is deterministic', () => {
    expect(texts({ projectCount: 2 })).toEqual(texts({ projectCount: 2 }));
  });
});

describe('rotateWindow', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];

  it('takes a window from the offset', () => {
    expect(rotateWindow(items, 0, 3)).toEqual(['a', 'b', 'c']);
    expect(rotateWindow(items, 2, 3)).toEqual(['c', 'd', 'e']);
  });

  it('wraps around the end', () => {
    expect(rotateWindow(items, 4, 3)).toEqual(['e', 'a', 'b']);
  });

  // A page left open all day reaches a large offset; it must keep working.
  it('survives an offset far beyond the list', () => {
    expect(rotateWindow(items, 5003, 2)).toEqual(rotateWindow(items, 3, 2));
  });

  it('handles a negative offset', () => {
    expect(rotateWindow(items, -1, 2)).toEqual(['e', 'a']);
  });

  it('never repeats an item while the list is long enough', () => {
    const window = rotateWindow(items, 3, 5);
    expect(new Set(window).size).toBe(5);
  });

  it('returns everything when asked for more than exists', () => {
    expect(rotateWindow(['a', 'b'], 0, 9)).toHaveLength(2);
  });

  it('handles an empty list', () => {
    expect(rotateWindow([], 3, 4)).toEqual([]);
  });
});
