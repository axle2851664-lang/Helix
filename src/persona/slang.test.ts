import { describe, expect, it } from 'vitest';
import { slangPrompt, slangRequest } from './slang.js';

const asked = (text: string) => slangRequest(text).asked;
const subjectOf = (text: string) => {
  const result = slangRequest(text);
  return result.asked ? result.subject : undefined;
};

describe('when it should fire', () => {
  it('catches a direct instruction with the text supplied', () => {
    expect(asked('translate "good morning" into slang')).toBe(true);
    expect(subjectOf('translate "good morning" into slang')).toBe('good morning');
  });

  it('catches an instruction pointing at what was just said', () => {
    expect(asked('say that in slang')).toBe(true);
    expect(subjectOf('say that in slang')).toBeNull();
    expect(subjectOf('put that in slang')).toBeNull();
    expect(subjectOf('rewrite your last answer in slang')).toBeNull();
  });

  it('catches a polite request', () => {
    expect(asked('can you say that in slang')).toBe(true);
    expect(asked('could you put this in slang please')).toBe(true);
  });

  it('catches "the slang version of"', () => {
    expect(asked('give me the slang version of that')).toBe(true);
  });

  it('takes the text after a colon', () => {
    expect(subjectOf('in slang: the meeting has been moved to Tuesday')).toBe(
      'the meeting has been moved to Tuesday',
    );
  });

  it('takes unquoted text before the instruction', () => {
    expect(subjectOf('translate the meeting is cancelled into slang')).toBe(
      'the meeting is cancelled',
    );
  });
});

describe('when it must not fire', () => {
  // This is the whole of "only when asked": nearly every sentence containing
  // the word is about slang rather than a request to produce it.
  it('leaves a question about slang alone', () => {
    expect(asked('what does that slang mean')).toBe(false);
    expect(asked('what is slang')).toBe(false);
    expect(asked('define that slang for me')).toBe(false);
    expect(asked('is that slang or a typo')).toBe(false);
    expect(asked('why is slang regional')).toBe(false);
    expect(asked('explain the difference between slang and jargon')).toBe(false);
  });

  it('leaves ordinary conversation alone', () => {
    expect(asked('remember that my sister is called Mira')).toBe(false);
    expect(asked('what is on my calendar')).toBe(false);
    expect(asked('write me a python script')).toBe(false);
    expect(asked('')).toBe(false);
  });

  it('does not fire on the word alone', () => {
    expect(asked('slang')).toBe(false);
    expect(asked('that was a lot of slang')).toBe(false);
    expect(asked('he speaks in slang constantly')).toBe(false);
  });

  it('does not fire on a sentence that merely mentions translating', () => {
    expect(asked('translate this into french')).toBe(false);
    expect(asked('can you translate this page')).toBe(false);
  });
});

describe('what the model is told', () => {
  it('forbids answering the text instead of rewriting it', () => {
    const prompt = slangPrompt('the meeting is cancelled');
    expect(prompt.system).toContain('Do not answer it');
    expect(prompt.system).toContain('Keep the meaning exactly');
    expect(prompt.user).toBe('the meeting is cancelled');
  });

  it('asks for the text alone, since the reply is shown as the translation', () => {
    expect(slangPrompt('x').system).toContain('nothing else');
  });

  it('rules out slurs rather than leaving it to the model', () => {
    expect(slangPrompt('x').system).toContain('No slurs');
  });
});
