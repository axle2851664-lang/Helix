import { describe, expect, it } from 'vitest';
import { describeReasoning, reactorSegments, type ReactorInput } from './capabilities.js';

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
   * REASONING as unavailable on a screen where Havoc was replying - the exact
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
