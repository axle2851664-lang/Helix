import { describe, expect, it } from 'vitest';
import { mailIntent } from './mailIntent.js';

/**
 * The phrasings that must never reach the language model.
 *
 * The first entry below is the one that failed in front of the user: Helix
 * answered "I'm checking your Gmail inbox. As of now, you have several unread
 * messages" without touching the mailbox, because the phrase missed the
 * matcher and fell through to a model that cannot see mail and answered
 * anyway. A fabricated inbox is believed exactly when it matters.
 */

describe('asking what is in the mailbox', () => {
  it('catches the phrasing that was answered with an invention', () => {
    expect(mailIntent("whats unread on my gmail right mow")?.kind).toBe('unread');
  });

  it('catches the ordinary ways people ask', () => {
    for (const phrase of [
      'read my inbox',
      'check my mail',
      'what is unread on my gmail',
      'anything new in my email',
      'any new mail',
      'show me my messages',
      'what have I got in my inbox',
      'check gmail',
    ]) {
      expect(mailIntent(phrase)?.kind, phrase).toBe('unread');
    }
  });

  it('is not fooled by talk that is not about the mailbox', () => {
    for (const phrase of [
      'what is on my calendar',
      'read the third chapter',
      'show me pictures of a car',
      'delete that file',
      '',
    ]) {
      expect(mailIntent(phrase), phrase).toBeNull();
    }
  });
});

describe('acting on messages', () => {
  it('reads the ones just listed when asked straight after', () => {
    expect(mailIntent('read them for me', true)).toEqual({
      kind: 'read',
      which: { of: 'all-listed' },
    });
  });

  it('picks out one by position', () => {
    expect(mailIntent('read the second one', true)).toEqual({
      kind: 'read',
      which: { of: 'nth', index: 2 },
    });
  });

  it('picks out one by sender', () => {
    expect(mailIntent('archive the email from Marlow')).toMatchObject({
      kind: 'archive',
      which: { of: 'sender', name: 'Marlow' },
    });
  });

  it('treats delete as trash, which is what the word means in Gmail', () => {
    expect(mailIntent('delete them', true)?.kind).toBe('trash');
    expect(mailIntent('bin those emails')?.kind).toBe('trash');
  });

  it('understands archive, star and mark read', () => {
    expect(mailIntent('archive them', true)?.kind).toBe('archive');
    expect(mailIntent('star them', true)?.kind).toBe('star');
    expect(mailIntent('mark them as read', true)?.kind).toBe('markRead');
  });

  /**
   * The refusal that matters. Acting on the wrong message cannot be undone
   * and the user would never know it happened, so a target that cannot be
   * resolved is refused rather than guessed at.
   */
  it('refuses a verb with nothing to act on', () => {
    expect(mailIntent('archive my email')).toBeNull();
    expect(mailIntent('delete the mail')).toBeNull();
  });

  it('does not act on mail from a stray verb in unrelated talk', () => {
    expect(mailIntent('delete them')).toBeNull();
    expect(mailIntent('archive the project files')).toBeNull();
  });
});
