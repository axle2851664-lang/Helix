import { beforeEach, describe, expect, it } from 'vitest';
import {
  carriesAddress,
  acknowledge,
  addressed,
  confirm,
  enquire,
  observe,
  recentAddressRate,
  regret,
  resetVoice,
  uncertain,
  unavailable,
} from './voice.js';

beforeEach(() => {
  resetVoice();
});

describe('addressed', () => {
  /**
   * Either form, because there are two and they alternate. Pinning this to
   * "sir" made the second call in the same test fail for doing exactly what it
   * was asked to do.
   */
  it('adds the form of address before terminal punctuation', () => {
    expect(addressed('The project is open.', { force: true })).toMatch(
      /^The project is open, (?:sir|boss)\.$/,
    );
    expect(addressed('Shall I proceed?', { force: true })).toMatch(
      /^Shall I proceed, (?:sir|boss)\?$/,
    );
  });

  // Alternating rather than random: a run of "boss, boss, boss" reads as a tic.
  it('alternates between the two forms', () => {
    const lines = Array.from({ length: 4 }, (_, i) =>
      addressed(`Line ${i}.`, { force: true }),
    );

    expect(lines[0]).toContain('sir');
    expect(lines[1]).toContain('boss');
    expect(lines[2]).toContain('sir');
    expect(lines[3]).toContain('boss');
  });

  it('does not double up when already addressed', () => {
    expect(addressed('Very good, sir.', { force: true })).toBe('Very good, sir.');
    expect(addressed('Certainly, Sir.', { force: true })).toBe('Certainly, Sir.');
  });

  it('handles a sentence with no terminal punctuation', () => {
    expect(addressed('Opening the project', { force: true })).toBe('Opening the project, sir.');
  });

  it('leaves empty input alone', () => {
    expect(addressed('   ', { force: true })).toBe('');
  });
});

describe('confirm', () => {
  it('leads with an acknowledgement and states the result', () => {
    const text = confirm('The project is open');
    expect(text).toMatch(/^(Certainly|Very good|Of course|Right away)\./);
    expect(text).toContain('The project is open');
    expect(text, 'should end with an address in either form').toMatch(/, (?:sir|boss)\.$/);
  });

  it('does not double the full stop', () => {
    expect(confirm('Everything is in order.')).not.toContain('..');
  });

  // A scripted personality that repeats one phrase reads as mechanical.
  it('varies the acknowledgement across repeated calls', () => {
    const openers = new Set(
      Array.from({ length: 6 }, () => confirm('Done').split('.')[0]),
    );
    expect(openers.size).toBeGreaterThan(1);
  });

  it('can omit the address where it would read oddly', () => {
    expect(carriesAddress(confirm('Indexed', { address: false }))).toBe(false);
  });
});

describe('acknowledge', () => {
  it('signals work about to begin', () => {
    const text = acknowledge('I will search the project files');
    expect(text).toMatch(/^(Allow me a moment|I'll take a look|I'll examine that now)\./);
    expect(text).toContain('search the project files');
  });
});

describe('regret', () => {
  it('opens with composed regret, never alarm', () => {
    const text = regret('the project could not be found');
    expect(text).toBe("I'm afraid the project could not be found, sir.");
  });

  it('lowercases the problem so it reads as one sentence', () => {
    expect(regret('The file is missing')).toBe("I'm afraid the file is missing, sir.");
  });

  // The brief forbids cheerful apology and panic.
  it('never uses alarmed or apologetic filler', () => {
    const text = regret('that operation was unsuccessful');
    for (const banned of ['Oops', 'my bad', 'Uh oh', 'horribly wrong', '!']) {
      expect(text, banned).not.toContain(banned);
    }
  });
});

describe('unavailable', () => {
  it('states the missing capability and how to fix it', () => {
    const text = unavailable(
      'no speech provider is configured',
      'You can choose one in Settings under Voice.',
    );
    expect(text).toContain("I'm afraid no speech provider is configured, sir.");
    expect(text).toContain('Settings under Voice');
  });

  it('works without a remedy', () => {
    expect(unavailable('that capability is not configured')).toBe(
      "I'm afraid that capability is not configured, sir.",
    );
  });
});

describe('uncertain', () => {
  it('declines to guess', () => {
    expect(uncertain('which project you mean')).toBe(
      "I'm not certain which project you mean, sir.",
    );
  });
});

describe('enquire', () => {
  it('asks a question with the address in place', () => {
    expect(enquire('Which one did you mean')).toBe('Which one did you mean, sir?');
  });
});

describe('observe', () => {
  it('states a fact plainly', () => {
    expect(observe('Two files are indexed')).toBe('Two files are indexed, sir.');
  });
});

describe('tone rules', () => {
  const samples = () => [
    confirm('The project is open'),
    acknowledge('I will investigate'),
    regret('that operation was unsuccessful'),
    unavailable('no provider is configured'),
    uncertain('what caused it'),
    enquire('Shall I proceed'),
  ];

  it('never uses exclamation marks', () => {
    for (const text of samples()) expect(text, text).not.toContain('!');
  });

  it('never uses archaic address', () => {
    for (const text of samples()) {
      for (const archaic of ['milord', 'master', 'indubitably', 'my good sir']) {
        expect(text.toLowerCase(), text).not.toContain(archaic);
      }
    }
  });

  it('never uses casual internet register', () => {
    for (const text of samples()) {
      for (const casual of ['bro', 'dude', 'lol', 'oops']) {
        expect(text.toLowerCase(), text).not.toContain(casual);
      }
    }
  });

  it('keeps replies short by default', () => {
    for (const text of samples()) {
      expect(text.length, text).toBeLessThan(140);
    }
  });
});

describe('how often Helix addresses the user', () => {
  beforeEach(resetVoice);

  /**
   * The brief asks for roughly 20-40% of replies. Below that it stops being
   * characteristic; above it, "Yes sir / Certainly sir / Of course sir" in
   * succession reads as a machine performing deference.
   */
  it('lands inside the intended range over a long conversation', () => {
    const lines = Array.from({ length: 60 }, (_, i) => addressed(`Reply number ${i}.`));
    // Counted across both forms. This counted "sir" alone, and when a second
    // form was added it reported half the true rate and failed - measuring the
    // vocabulary rather than the behaviour it was written to protect.
    const withAddress = lines.filter((line) => carriesAddress(line)).length;
    const rate = withAddress / lines.length;

    expect(rate).toBeGreaterThanOrEqual(0.2);
    expect(rate).toBeLessThanOrEqual(0.4);
  });

  // The specific failure being designed out: a run of them.
  it('never addresses twice in a row', () => {
    const lines = Array.from({ length: 40 }, (_, i) => addressed(`Line ${i}.`));

    for (let i = 1; i < lines.length; i += 1) {
      // Across both forms. Checking "sir" alone would let "sir" followed by
      // "boss" pass as though it were not a run, which is exactly the effect
      // the rule exists to prevent.
      const both = carriesAddress(lines[i] as string) && carriesAddress(lines[i - 1] as string);
      expect(both, `lines ${i - 1} and ${i}`).toBe(false);
    }
  });

  it('does not add a second address to a sentence that already has one', () => {
    const once = addressed('Very good, sir.', { force: true });
    expect(once.match(/sir/gi)).toHaveLength(1);
  });

  it('reports its own recent rate', () => {
    for (let i = 0; i < 12; i += 1) addressed(`Line ${i}.`);
    expect(recentAddressRate()).toBeGreaterThan(0);
    expect(recentAddressRate()).toBeLessThanOrEqual(0.4);
  });
});
