import { describe, expect, it } from 'vitest';
import { docsIntent, draftPrompt } from './docsIntent.js';

describe('when it should fire', () => {
  it('catches the ordinary ways of asking', () => {
    expect(docsIntent('write a google doc about the Q3 results')?.subject).toBe('the Q3 results');
    expect(docsIntent('make a google doc about my trip')?.subject).toBe('my trip');
    expect(docsIntent('draft a document on the new hiring process')?.subject).toBe(
      'the new hiring process',
    );
    expect(docsIntent('write a doc about Tuesday')?.subject).toBe('Tuesday');
  });

  it('takes a title when the request names one', () => {
    const intent = docsIntent('write a google doc about the budget called "Q3 Budget"');
    expect(intent?.title).toBe('Q3 Budget');
    expect(intent?.subject).toBe('the budget');
  });

  it('accepts "titled" and "named" as well as "called"', () => {
    expect(docsIntent('write a doc about pricing titled Pricing Notes')?.title).toBe(
      'Pricing Notes',
    );
    expect(docsIntent('write a doc about pricing named Pricing Notes')?.title).toBe(
      'Pricing Notes',
    );
  });
});

describe('when it must not fire', () => {
  it('leaves code documentation alone', () => {
    // "Document this function" is a request about code. It must not put a
    // file in somebody's Google Drive.
    expect(docsIntent('document this function')).toBeNull();
    expect(docsIntent('write documentation for the code')).toBeNull();
    expect(docsIntent('document my module')).toBeNull();
  });

  it('leaves notes and ordinary requests alone', () => {
    for (const text of [
      'write it down',
      'remember that my sister is called Mira',
      'write me a python script',
      'what is on my calendar',
      'show me pictures of a car',
      '',
    ]) {
      expect(docsIntent(text)).toBeNull();
    }
  });

  it('needs a subject, not just the instruction', () => {
    expect(docsIntent('write a google doc')).toBeNull();
    expect(docsIntent('write a document about')).toBeNull();
  });
});

describe('what the model is told', () => {
  it('asks for the markdown subset the formatter actually understands', () => {
    const prompt = draftPrompt('the budget');
    expect(prompt.system).toContain('# for the title');
    // Anything else would arrive as literal characters in the document.
    expect(prompt.system).toContain('no tables, no links, no code fences');
  });

  it('asks for the document alone, since the whole reply becomes the document', () => {
    expect(draftPrompt('x').system).toContain('No commentary before or after it');
  });
});
