import { describe, expect, it } from 'vitest';
import { isSensitiveMemory, promptableMemories, volunteersPrivateFact } from './sensitivity.js';
import type { MemoryRecord } from './types.js';

const record = (content: string, tags: string[] = []): MemoryRecord =>
  ({
    id: `mem_${content.length}`,
    content,
    category: 'fact',
    source: 'user-explicit',
    confidence: 1,
    createdAt: 0,
    updatedAt: 0,
    lastAccessedAt: 0,
    tags,
  }) as MemoryRecord;

describe('what counts as too private for a model prompt', () => {
  it('holds back an address, however it was tagged', () => {
    expect(isSensitiveMemory(record('They live at 1937 Riddell RD', ['location']))).toBe(true);
    // Stored through the older "remember that ..." path, so no tag at all.
    expect(isSensitiveMemory(record('My address is 1937 Riddell Road'))).toBe(true);
    expect(isSensitiveMemory(record('14 Chapel Street is where the office is'))).toBe(true);
  });

  it('holds back contact details', () => {
    expect(isSensitiveMemory(record('Their contact detail: michael@example.com'))).toBe(true);
    expect(isSensitiveMemory(record('Their contact detail: +44 7700 900123'))).toBe(true);
    expect(isSensitiveMemory(record('My postcode is listed on the form'))).toBe(true);
  });

  /**
   * A name is different in kind. Havoc using it in conversation is the point
   * of knowing it, and a name said unprompted is awkward rather than harmful.
   */
  it('lets a name through', () => {
    expect(isSensitiveMemory(record('Their name is Michael', ['name']))).toBe(false);
  });

  it('lets ordinary facts through', () => {
    for (const content of [
      'Their favourite colour is blue',
      'Their sister is called Ada',
      'They prefer short answers',
      'They work as a plumber',
    ]) {
      expect(isSensitiveMemory(record(content)), content).toBe(false);
    }
  });
});

describe('what reaches the model', () => {
  const all = [
    record('Their name is Michael', ['name']),
    record('They live at 1937 Riddell RD', ['location']),
    record('Their favourite colour is blue'),
  ];

  /**
   * The judgement made about the persona demonstrations, for the same
   * reasons: every one of these failures has happened on the local path, its
   * context budget is the tightest, and it loses least by going without,
   * because a direct question is answered by the memory tool before a model
   * is ever reached.
   */
  it('gives a local model nothing at all', () => {
    expect(promptableMemories(all, { local: true })).toEqual([]);
  });

  it('gives a cloud model everything except the private parts', () => {
    const sent = promptableMemories(all, { local: false });

    expect(sent).toContain('Their name is Michael');
    expect(sent).toContain('Their favourite colour is blue');
    expect(sent.join(' ')).not.toContain('Riddell');
  });

  it('honours a limit', () => {
    expect(promptableMemories(all, { local: false, limit: 1 })).toHaveLength(1);
  });
});

describe('volunteering something nobody asked for', () => {
  const remembered = [
    record('They live at 1937 Riddell RD', ['location']),
    record('Their contact detail: michael@example.com', ['contact']),
    record('Their name is Michael', ['name']),
  ];

  /**
   * The reply this exists because of: a greeting answered with a street
   * address. The model paraphrases, so the match is on the distinctive part
   * rather than the stored sentence.
   */
  it('catches an address blurted at a greeting', () => {
    const verdict = volunteersPrivateFact('1937 Riddell RD', remembered, { asked: false });
    expect(verdict.leaked).toBe(true);
  });

  it('catches an email offered unprompted', () => {
    expect(
      volunteersPrivateFact('You can be reached at michael@example.com.', remembered, {
        asked: false,
      }).leaked,
    ).toBe(true);
  });

  /**
   * The line it must not cross. Asked where they live, a reply saying where
   * they live is the correct answer - a guard that could not tell the
   * difference would break the feature it protects.
   */
  it('says nothing when the user asked', () => {
    expect(
      volunteersPrivateFact('You live at 1937 Riddell RD.', remembered, { asked: true }).leaked,
    ).toBe(false);
  });

  it('leaves an ordinary reply alone', () => {
    for (const reply of [
      "I'm here.",
      'Your name is Michael.',
      'Canberra. It exists because Sydney and Melbourne could not agree.',
      'The render has about ten minutes left.',
    ]) {
      expect(volunteersPrivateFact(reply, remembered, { asked: false }).leaked, reply).toBe(false);
    }
  });

  it('does not fire when nothing private is remembered', () => {
    const harmless = [record('Their favourite colour is blue')];
    expect(volunteersPrivateFact('Blue, you said.', harmless, { asked: false }).leaked).toBe(false);
  });
});
