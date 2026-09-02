import { describe, expect, it } from 'vitest';
import { inspect, repair } from './register.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';

describe('the measured failure', () => {
  /**
   * The exact reply qwen2.5:7b gave to "Helix, are you there?" with the full
   * persona prompt in front of it. Every rule it broke was already written in
   * that prompt, which is why this module exists.
   */
  const MEASURED = 'Affirmative, sir. Ready to assist.';

  it('recognises it as terminal register', () => {
    expect(inspect(MEASURED).map((finding) => finding.fault)).toContain('terminal');
  });

  it('removes the opener and keeps what was actually said', () => {
    expect(repair(MEASURED).text).toBe('Ready to assist.');
  });

  // The address belonged to the phrase being removed. Leaving it stranded as
  // ", sir. Ready to assist." would be worse than either.
  it('does not leave the address hanging', () => {
    expect(repair(MEASURED).text).not.toContain('sir');
  });
});

describe('terminal register', () => {
  it.each([
    ['Request received. I will open it now.', 'I will open it now.'],
    ['Processing your request. The file is here.', 'The file is here.'],
    ['Acknowledged - three files imported.', 'Three files imported.'],
    ['Executing: the index is rebuilding.', 'The index is rebuilding.'],
  ])('strips %j', (input, expected) => {
    expect(repair(input).text).toBe(expected);
  });

  /**
   * The matcher is anchored to the start for exactly this reason. "Executing"
   * is an ordinary English word, and a version that stripped it anywhere would
   * silently edit what the model said about the user's own program.
   */
  it('leaves the same words alone in the middle of a sentence', () => {
    const sentence = 'The script is still executing, so I cannot read the output yet.';
    expect(repair(sentence).text).toBe(sentence);
    expect(inspect(sentence)).toEqual([]);
  });

  // Removing everything would turn a bad answer into no answer.
  it('keeps a reply that is nothing but the fault', () => {
    const result = repair('Acknowledged.');
    expect(result.text).toBe('Acknowledged.');
    expect(result.wholesale).toBe(true);
  });
});

describe('costume-drama register', () => {
  it('substitutes archaic address rather than deleting it', () => {
    expect(repair('The file is open, my lord.').text).toBe('The file is open, sir.');
  });

  it('deletes flourishes, which carry nothing', () => {
    expect(repair('As you command. The index is rebuilt.').text).toBe('The index is rebuilt.');
  });
});

describe('address rate', () => {
  it('leaves a single address alone', () => {
    const single = 'I am here, sir. What do you need?';
    expect(repair(single).text).toBe(single);
  });

  /**
   * The prompt asks for it never twice in one reply and a small model obliges
   * about as often as not. The first is kept because it is nearly always the
   * natural one.
   */
  it('keeps the first and drops the rest', () => {
    const result = repair('Yes, sir. The file is open, sir, and indexed, sir.');
    expect(result.text).toBe('Yes, sir. The file is open and indexed.');
    expect(result.findings.map((finding) => finding.fault)).toContain('address-repeat');
  });
});

describe('the offer of further service', () => {
  /**
   * Measured, not imagined. qwen2.5:3b answered a plain "Much appreciated."
   * with this, and two of the other five replies carried the same shape.
   */
  it('removes a trailing service tag', () => {
    expect(repair("You're welcome, sir. How may I assist you further?").text).toBe(
      "You're welcome, sir.",
    );
  });

  it.each([
    'The render job is stopped. Is there anything else I can assist with?',
    'The render job is stopped. Let me know if I can help.',
    'The render job is stopped. Anything else you need?',
    // Both of these reached the user in real runs against qwen2.5:3b, each
    // with a trailing qualifier the pattern of the day did not know about.
    'The render job is stopped. What can I assist with today?',
    'The render job is stopped. How may I assist you this evening?',
  ])('removes it however it is phrased: %j', (input) => {
    expect(repair(input).text).toBe('The render job is stopped.');
  });

  // Filler is still better than silence.
  it('keeps a reply that is nothing but the tag', () => {
    const only = 'How may I assist you further?';
    expect(repair(only).text).toBe(only);
  });

  // A specific offer is content, not a tag.
  it('leaves a genuine offer alone', () => {
    const offer = 'Three files failed to index. I can list them if you want.';
    expect(repair(offer).text).toBe(offer);
  });

  /**
   * The line the filler list exists to hold.
   *
   * These have the exact shape of the tag and are not tags: they name a thing
   * to be done. A pattern permissive enough to catch every closing pleasantry
   * would take these too, which is why the trailing words are a closed list
   * rather than `\w+`.
   */
  it.each([
    'The printer is jammed. How can I help you fix it?',
    'There are two options. How may I help you choose?',
  ])('does not touch a specific offer of the same shape: %j', (input) => {
    expect(repair(input).text).toBe(input);
  });
});

describe('the address rate across replies', () => {
  /**
   * The one-per-reply rule was never the problem. The prompt asks for the
   * address in roughly a third of replies and qwen2.5:3b put it in five of
   * six, every one of them singly and correctly placed. Nothing in the reply
   * itself is wrong; it is the rate, which only the caller can see.
   */
  it('removes the address when the rate says no', () => {
    expect(repair('I am here, sir. What do you need?', { allowAddress: false }).text).toBe(
      'I am here. What do you need?',
    );
  });

  it('reports the rate as the reason', () => {
    const result = repair('Of course, sir.', { allowAddress: false });
    expect(result.findings.map((finding) => finding.fault)).toContain('address-rate');
  });

  it('leaves the reply alone when the rate allows it', () => {
    const allowed = 'I am here, sir. What do you need?';
    expect(repair(allowed, { allowAddress: true }).text).toBe(allowed);
  });

  it('does nothing to a reply that never used it', () => {
    const plain = 'Canberra.';
    expect(repair(plain, { allowAddress: false }).text).toBe(plain);
    expect(repair(plain, { allowAddress: false }).findings).toEqual([]);
  });
});

describe('what it must never do', () => {
  /**
   * The whole safety argument for this module. It may delete a phrase from a
   * closed list and substitute another from a closed list. If it could add
   * words it could add a claim, and a personality layer that invents content
   * is indistinguishable from a model that hallucinates.
   */
  it('never produces a word that was not in the input', () => {
    const inputs = [
      'Affirmative, sir. The backup completed at 14:32.',
      'As you command, my lord. Seven files.',
      'As an AI, I cannot know that. The figure is 12 per cent.',
    ];

    for (const input of inputs) {
      const source = new Set(
        input.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean),
      );
      const produced = repair(input)
        .text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);

      for (const word of produced) {
        // "sir" is the one substitution, and it replaces an address with an
        // address - it adds no information.
        if (word === 'sir') continue;
        expect(source.has(word), `"${word}" was not in the input`).toBe(true);
      }
    }
  });

  it('keeps every number and filename intact', () => {
    const result = repair('Affirmative, sir. report-q3.pdf is 4.7 GB and dated 12 March.');
    expect(result.text).toContain('report-q3.pdf');
    expect(result.text).toContain('4.7 GB');
    expect(result.text).toContain('12 March');
  });

  it('leaves a reply that was already right completely untouched', () => {
    const good = "I'm here. Canberra, incidentally - not Sydney.";
    expect(repair(good).text).toBe(good);
    expect(repair(good).findings).toEqual([]);
  });
});

describe('the model talking about being a model', () => {
  it('removes the disclaimer sentence and keeps the answer', () => {
    const result = repair('As an AI, I have no feelings. The index finished an hour ago.');
    expect(result.text).toBe('The index finished an hour ago.');
  });

  // A genuine question about language models is not a disclaimer.
  it('does not eat a sentence that is genuinely about models', () => {
    const sentence = 'Running it as a language model on this machine would need more memory.';
    expect(repair(sentence).text).toBe(sentence);
  });
});

describe('the prompt and the checker agree', () => {
  /**
   * A prompt that forbade one set of phrases while the checker removed another
   * would drift apart the first time either was edited. Every phrase the prompt
   * writes out as wrong is checked here to be one the checker catches.
   */
  it('every phrase the prompt calls wrong is one the checker finds', () => {
    const wrong = [...SYSTEM_PROMPT.matchAll(/Wrong: "([^"]+)"/g)].map((match) => match[1] ?? '');

    expect(wrong.length).toBeGreaterThan(5);
    for (const phrase of wrong) {
      expect(inspect(phrase).length, `the checker misses ${phrase}`).toBeGreaterThan(0);
    }
  });

  it('every good example in the prompt passes the checker', () => {
    const good = [...SYSTEM_PROMPT.matchAll(/^ {2}You: (.+)$/gm)].map((match) => match[1] ?? '');

    expect(good.length).toBeGreaterThan(4);
    for (const reply of good) {
      expect(inspect(reply), `the checker rejects ${reply}`).toEqual([]);
    }
  });
});
