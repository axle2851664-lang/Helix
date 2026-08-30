import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADDRESS,
  acknowledge,
  addressed,
  confirm,
  enquire,
  observe,
  regret,
  resetVoice,
  uncertain,
  unavailable,
} from './voice.js';

beforeEach(() => {
  resetVoice();
});

describe('addressed', () => {
  it('adds the form of address before terminal punctuation', () => {
    expect(addressed('The project is open.')).toBe('The project is open, sir.');
    expect(addressed('Shall I proceed?')).toBe('Shall I proceed, sir?');
  });

  it('does not double up when already addressed', () => {
    expect(addressed('Very good, sir.')).toBe('Very good, sir.');
    expect(addressed('Certainly, Sir.')).toBe('Certainly, Sir.');
  });

  it('handles a sentence with no terminal punctuation', () => {
    expect(addressed('Opening the project')).toBe('Opening the project, sir.');
  });

  it('leaves empty input alone', () => {
    expect(addressed('   ')).toBe('');
  });
});

describe('confirm', () => {
  it('leads with an acknowledgement and states the result', () => {
    const text = confirm('The project is open');
    expect(text).toMatch(/^(Certainly|Very good|Of course|Right away)\./);
    expect(text).toContain('The project is open');
    expect(text.endsWith(`, ${ADDRESS}.`)).toBe(true);
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
    expect(confirm('Indexed', { address: false })).not.toContain(ADDRESS);
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
