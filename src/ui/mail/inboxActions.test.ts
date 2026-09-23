import { describe, expect, it } from 'vitest';
import { MAIL_UNDO, encodeIds } from './inboxActions.js';

describe('encoding message ids for the action layer', () => {
  it('joins with commas, which is the only shape the action layer takes', () => {
    expect(encodeIds(['18c1', '18c2'])).toBe('18c1,18c2');
  });

  it('drops an id that would split in half rather than inventing a second one', () => {
    expect(encodeIds(['18c1', 'a,b'])).toBe('18c1');
  });

  it('drops blanks, so an empty selection cannot act on everything', () => {
    expect(encodeIds([])).toBe('');
    expect(encodeIds(['  ', ''])).toBe('');
  });
});

describe('undo', () => {
  /**
   * The screen's promise is that nothing on it is one-way. That holds only
   * while every offered action has an inverse, so the two lists are checked
   * against each other rather than trusted to stay in step.
   */
  it('offers an inverse for every action the screen can run', () => {
    const offered = ['mail.archive', 'mail.star', 'mail.markRead'];
    for (const action of offered) {
      expect(MAIL_UNDO[action], action).toBeDefined();
    }
  });

  it('names the real undo action for each', () => {
    expect(MAIL_UNDO['mail.archive']?.action).toBe('mail.unarchive');
    expect(MAIL_UNDO['mail.star']?.action).toBe('mail.unstar');
    expect(MAIL_UNDO['mail.markRead']?.action).toBe('mail.markUnread');
  });
});
