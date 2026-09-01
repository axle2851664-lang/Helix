import { describe, expect, it } from 'vitest';
import {
  assessFit,
  estimateResidentBytes,
  footprintFromName,
  largestComfortableModel,
} from './resources.js';

/** The machine this was written on: 7.8 GB, measured. */
const thisMachine = { totalMemoryBytes: 7.8 * 1024 ** 3, memoryIsApproximate: false, availableMemoryBytes: null };
const roomy = { totalMemoryBytes: 64 * 1024 ** 3, memoryIsApproximate: false, availableMemoryBytes: null };

describe('footprintFromName', () => {
  it('reads the parameter count from an Ollama-style tag', () => {
    expect(footprintFromName('qwen2.5:7b').parameters).toBe(7);
    expect(footprintFromName('llama3.1:8b-instruct-q4_K_M').parameters).toBe(8);
    expect(footprintFromName('phi3:3.8b').parameters).toBe(3.8);
  });

  it('reads the quantisation where the name states it', () => {
    expect(footprintFromName('llama3:8b-q4_K_M').quantisation).toBe('q4');
    expect(footprintFromName('mistral:7b-q8_0').quantisation).toBe('q8');
    expect(footprintFromName('gemma:2b-f16').quantisation).toBe('f16');
  });

  /**
   * Ollama's default tags are 4-bit, but the name does not say so. Recording
   * that as `q4` would look like knowledge; it is an assumption, and it is
   * flagged as one where it is used.
   */
  it('does not claim a quantisation the name never stated', () => {
    expect(footprintFromName('qwen2.5:7b').quantisation).toBe('unknown');
  });

  it('returns null rather than guessing at an unreadable name', () => {
    expect(footprintFromName('my-custom-model').parameters).toBeNull();
  });
});

describe('estimateResidentBytes', () => {
  // A measured file size beats an estimate from a name every time.
  it('prefers the real file size when the runtime reports one', () => {
    const fromDisk = estimateResidentBytes({
      parameters: 7,
      quantisation: 'q4',
      diskBytes: 4.7 * 1024 ** 3,
    });
    expect(fromDisk).toBeGreaterThan(4.7 * 1024 ** 3);
  });

  it('estimates from parameters when there is no file yet', () => {
    const sevenB = estimateResidentBytes(footprintFromName('qwen2.5:7b'));
    expect(sevenB).not.toBeNull();
    // A 7B at 4-bit lands near 5 GB resident.
    expect((sevenB as number) / 1024 ** 3).toBeGreaterThan(4);
    expect((sevenB as number) / 1024 ** 3).toBeLessThan(7);
  });

  it('costs more at higher precision', () => {
    const q4 = estimateResidentBytes({ parameters: 7, quantisation: 'q4', diskBytes: null });
    const f16 = estimateResidentBytes({ parameters: 7, quantisation: 'f16', diskBytes: null });
    expect(f16 as number).toBeGreaterThan((q4 as number) * 2);
  });

  it('gives null rather than a number it cannot support', () => {
    expect(estimateResidentBytes({ parameters: null, quantisation: 'unknown', diskBytes: null }))
      .toBeNull();
  });
});

describe('assessFit', () => {
  /**
   * The case this module exists for. On this machine a 13B would swap and
   * appear to hang, and finding that out after a several-gigabyte download is
   * the outcome worth preventing.
   */
  it('refuses a 13B on an 8 GB machine, and says why', () => {
    const verdict = assessFit(footprintFromName('llama2:13b'), thisMachine);

    expect(verdict.verdict).toBe('will-not-fit');
    expect(verdict.message).toContain('swap to disk');
  });

  /**
   * Written the other way round at first, and measurement corrected it. A 7B
   * on this machine ran at 0.2 tokens per second; calling that \"tight\" was
   * the optimistic error this module exists to avoid.
   */
  it('refuses a 7B on this machine too, because it genuinely does not fit', () => {
    expect(assessFit(footprintFromName('qwen2.5:7b'), thisMachine).verdict).toBe('will-not-fit');
  });

  it('accepts a 3B on this machine, which is what actually ran well', () => {
    expect(assessFit(footprintFromName('qwen2.5:3b'), thisMachine).verdict).not.toBe(
      'will-not-fit',
    );
  });

  it('is comfortable with a 7B on a large machine', () => {
    expect(assessFit(footprintFromName('qwen2.5:7b'), roomy).verdict).toBe('comfortable');
  });

  // Assessing against total rather than free memory is how something is
  // declared to fit and then does not.
  it('reserves headroom for the rest of the system', () => {
    const verdict = assessFit(
      { parameters: null, quantisation: 'q4', diskBytes: 6.0 * 1024 ** 3 },
      thisMachine,
    );
    expect(verdict.verdict).toBe('will-not-fit');
  });

  it('admits when the model cannot be measured', () => {
    const verdict = assessFit(footprintFromName('mystery-model'), thisMachine);

    expect(verdict.verdict).toBe('unknown');
    expect(verdict.message).toContain('cannot tell how large');
  });

  it('admits when the machine cannot be measured', () => {
    const verdict = assessFit(footprintFromName('qwen2.5:7b'), {
      totalMemoryBytes: null,
      memoryIsApproximate: false, availableMemoryBytes: null,
    });

    expect(verdict.verdict).toBe('unknown');
    expect(verdict.message).toContain('cannot measure');
  });

  it('says when the memory figure is only approximate', () => {
    const verdict = assessFit(footprintFromName('qwen2.5:7b'), {
      totalMemoryBytes: 7.8 * 1024 ** 3,
      memoryIsApproximate: true, availableMemoryBytes: null,
    });
    expect(verdict.message).toContain('approximate');
  });

  it('always gives a sentence, whatever the verdict', () => {
    for (const name of ['qwen2.5:7b', 'llama2:70b', 'mystery']) {
      expect(assessFit(footprintFromName(name), thisMachine).message.length).toBeGreaterThan(20);
    }
  });

  /**
   * The case that was got wrong, pinned with the numbers that got it wrong.
   *
   * This machine has 7.8 GB total and had 2.3 GB genuinely free. The earlier
   * version assumed a flat 3 GB reserve, concluded 4.8 GB was usable, and
   * called a 7B "tight". It was not tight: it ran at 0.2 tokens per second
   * because it was swapping, against 10.8 for a 3B on the same machine.
   *
   * With free memory measured rather than assumed, the same model on the same
   * machine is correctly refused.
   */
  it('uses measured free memory, not an assumed reserve', () => {
    const measured = {
      totalMemoryBytes: 7.8 * 1024 ** 3,
      memoryIsApproximate: false,
      availableMemoryBytes: 2.3 * 1024 ** 3,
    };

    const sevenB = assessFit(footprintFromName('qwen2.5:7b'), measured);
    expect(sevenB.verdict).toBe('will-not-fit');
    expect(sevenB.message).toContain('free now');

    // The 3B that actually ran well is not refused.
    expect(assessFit(footprintFromName('qwen2.5:3b'), measured).verdict).not.toBe('will-not-fit');
  });

  it('says whether the free figure was measured or assumed', () => {
    const assumed = assessFit(footprintFromName('llama2:13b'), thisMachine);
    const measured = assessFit(footprintFromName('llama2:13b'), {
      ...thisMachine,
      availableMemoryBytes: 2.3 * 1024 ** 3,
    });

    expect(assumed.message).toContain('estimated free');
    expect(measured.message).toContain('free now');
  });

  // A recommendation made against free memory has to move when it changes.
  it('recommends a smaller model when less is free', () => {
    const plenty = largestComfortableModel({
      ...thisMachine,
      availableMemoryBytes: 6 * 1024 ** 3,
    });
    const squeezed = largestComfortableModel({
      ...thisMachine,
      availableMemoryBytes: 2.3 * 1024 ** 3,
    });

    expect(squeezed as number).toBeLessThan(plenty as number);
  });
});

describe('largestComfortableModel', () => {
  it('recommends a size that actually exists', () => {
    const size = largestComfortableModel(thisMachine);
    expect([1, 2, 3, 4, 7, 8, 13, 14, 20, 30, 32, 70]).toContain(size);
  });

  // Rounding up would recommend a model that does not fit, which is worse
  // than recommending one slightly smaller than necessary.
  it('rounds down rather than up', () => {
    const size = largestComfortableModel(thisMachine) as number;
    const verdict = assessFit(footprintFromName(`model:${size}b`), thisMachine);

    expect(verdict.verdict).not.toBe('will-not-fit');
  });

  it('suggests something larger on a larger machine', () => {
    expect(largestComfortableModel(roomy) as number).toBeGreaterThan(
      largestComfortableModel(thisMachine) as number,
    );
  });

  it('returns null when memory cannot be measured', () => {
    expect(
      largestComfortableModel({ totalMemoryBytes: null, memoryIsApproximate: false, availableMemoryBytes: null }),
    ).toBeNull();
  });

  it('returns null on a machine too small for anything', () => {
    expect(
      largestComfortableModel({ totalMemoryBytes: 2 * 1024 ** 3, memoryIsApproximate: false, availableMemoryBytes: null }),
    ).toBeNull();
  });
});
