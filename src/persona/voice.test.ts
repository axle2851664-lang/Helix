import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADDRESS_FORMS,
  acknowledge,
  addressed,
  allowAddressInReply,
  carriesAddress,
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

describe('honorifics', () => {
  /**
   * The rule this whole file exists to hold. Helix used to say "sir" in about
   * a third of its replies and there was machinery to meter it; the rate is
   * now zero, and the machinery removes rather than meters.
   */
  it('strips every form of address it knows', () => {
    expect(addressed('The project is open, sir.')).toBe('The project is open.');
    expect(addressed('Very good, boss.')).toBe('Very good.');
    expect(addressed('At once, milord.')).toBe('At once.');
    expect(addressed("Certainly, ma'am.")).toBe('Certainly.');
  });

  it('never adds one, even when asked to', () => {
    // `force` is the option that used to mean "address regardless of rate".
    // A call site that still passes it must not resurrect the behaviour.
    expect(addressed('The project is open.', { force: true })).toBe('The project is open.');
    expect(carriesAddress(addressed('Shall I proceed?', { force: true }))).toBe(false);
  });

  it('removes a mid-sentence address without eating the sentence', () => {
    expect(addressed('No, sir, that file is missing.')).toBe('No, that file is missing.');
  });

  it('leaves empty input alone', () => {
    expect(addressed('   ')).toBe('');
  });

  it('recognises every form it claims to refuse', () => {
    for (const form of ADDRESS_FORMS) {
      expect(carriesAddress(`Understood, ${form}.`), form).toBe(true);
    }
  });

  it('does not fire on ordinary words that merely contain one', () => {
    // "Master" inside "mastering" and "boss" inside "embossed" are not
    // honorifics. A matcher without word boundaries would edit the answer.
    for (const said of ['Mastering takes an hour.', 'The embossed logo is fine.']) {
      expect(carriesAddress(said), said).toBe(false);
      expect(addressed(said)).toBe(said);
    }
  });

  it('reports a rate of zero and refuses a model reply that carries one', () => {
    expect(recentAddressRate()).toBe(0);
    expect(allowAddressInReply(true)).toBe(false);
    expect(allowAddressInReply(false)).toBe(false);
  });
});

describe('confirm', () => {
  it('leads with a flat acknowledgement and states the result', () => {
    const text = confirm('The project is open');
    expect(text).toMatch(/^(Done|Complete|Confirmed|Handled)\./);
    expect(text).toContain('The project is open');
    expect(carriesAddress(text)).toBe(false);
  });

  it('does not double the full stop', () => {
    expect(confirm('Everything is in order.')).not.toContain('..');
  });

  // A scripted personality that repeats one phrase reads as mechanical.
  it('varies the acknowledgement across repeated calls', () => {
    const openers = new Set(Array.from({ length: 6 }, () => confirm('Done').split('.')[0]));
    expect(openers.size).toBeGreaterThan(1);
  });
});

describe('acknowledge', () => {
  it('signals work that has started and has not finished', () => {
    const text = acknowledge('I will search the project files');
    expect(text).toMatch(/^(Working|Looking now|One moment)\./);
    expect(text).toContain('search the project files');
  });

  it('never claims the work is finished', () => {
    // The distinction the brief is most insistent on: a started action and a
    // completed one must not read the same.
    for (let i = 0; i < 6; i += 1) {
      const text = acknowledge('I will index the vault');
      expect(text, text).not.toMatch(/^(Done|Complete|Confirmed|Handled)\./);
    }
  });
});

describe('regret', () => {
  it('states the failure without apologising for it', () => {
    expect(regret('the project could not be found')).toBe('The project could not be found.');
  });

  it('capitalises the problem so it reads as one sentence', () => {
    expect(regret('The file is missing')).toBe('The file is missing.');
  });

  it('never uses apologetic, alarmed or deferential filler', () => {
    const text = regret('that operation was unsuccessful');
    for (const banned of ["I'm afraid", 'I do apologise', 'Oops', 'my bad', 'Uh oh', '!', 'sir']) {
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
    expect(text).toContain('No speech provider is configured.');
    expect(text).toContain('Settings under Voice');
  });

  it('works without a remedy', () => {
    expect(unavailable('that capability is not configured')).toBe(
      'That capability is not configured.',
    );
  });
});

describe('uncertain', () => {
  it('declines to guess, without hedging', () => {
    expect(uncertain('which project you mean')).toBe("I don't know which project you mean.");
  });
});

describe('enquire', () => {
  it('asks a question with no address attached', () => {
    expect(enquire('Which one did you mean')).toBe('Which one did you mean?');
  });
});

describe('observe', () => {
  it('states a fact plainly', () => {
    expect(observe('Two files are indexed')).toBe('Two files are indexed.');
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
    observe('Two files are indexed'),
  ];

  it('never uses exclamation marks', () => {
    for (const text of samples()) expect(text, text).not.toContain('!');
  });

  it('never addresses the user by a title', () => {
    for (const text of samples()) expect(carriesAddress(text), text).toBe(false);
  });

  it('never uses archaic or theatrical address', () => {
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

  it('keeps replies short', () => {
    for (const text of samples()) expect(text.length, text).toBeLessThan(140);
  });
});

describe('stripping an address from the front of a sentence', () => {
  it('takes the comma with it and restores the capital', () => {
    expect(addressed('Sir, the file is missing.')).toBe('The file is missing.');
    expect(addressed('Boss, that is done.')).toBe('That is done.');
  });

  it('does not recapitalise something that is not a word', () => {
    // A filename raised to title case is a different filename.
    expect(addressed('Sir, report-q3.pdf is missing.')).toBe('report-q3.pdf is missing.');
  });
});
