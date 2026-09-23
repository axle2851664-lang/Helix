import { describe, expect, it } from 'vitest';
import { emailIntent, subjectFrom } from './emailIntent.js';

const intent = (text: string) => {
  const parsed = emailIntent(text);
  return parsed?.kind === 'intent' ? parsed.intent : null;
};

describe('recognising a request to email somebody', () => {
  it('takes the address from the request', () => {
    expect(intent('email marlow@example.com about the site visit')).toMatchObject({
      to: 'marlow@example.com',
      about: 'the site visit',
    });
  });

  it('accepts the longer phrasings', () => {
    for (const phrase of [
      'send an email to a@b.com about the invoice',
      'write an email to a@b.com about the invoice',
      'draft an email to a@b.com about the invoice',
      'please email a@b.com about the invoice',
    ]) {
      expect(intent(phrase)?.to, phrase).toBe('a@b.com');
    }
  });

  it('keeps dictated wording verbatim instead of drafting from it', () => {
    const parsed = intent('email a@b.com saying I will be twenty minutes late');
    expect(parsed?.verbatim).toBe('I will be twenty minutes late');
  });

  it('takes an explicit subject and keeps it out of the body topic', () => {
    const parsed = intent('email a@b.com subject: Invoice 88 about the overdue payment');
    expect(parsed?.subject).toBe('Invoice 88');
    expect(parsed?.about).not.toContain('Invoice 88');
  });

  /**
   * The refusal that matters most. Helix holds no contacts, and guessing
   * which Marlow is meant sends a message that cannot be recalled to somebody
   * who was never named.
   */
  it('refuses to turn a name into an address', () => {
    const parsed = emailIntent('email Marlow about Thursday');
    expect(parsed?.kind).toBe('no-address');
  });

  it('does not mistake other requests for an email', () => {
    for (const phrase of ['what is on my calendar', 'read my inbox', 'call the supplier', '']) {
      expect(emailIntent(phrase), phrase).toBeNull();
    }
  });

  it('does not let the topic swallow the address', () => {
    const parsed = intent('email a@b.com about the invoice');
    expect(parsed?.about).not.toContain('a@b.com');
  });
});

describe('the subject, when none was given', () => {
  it('uses the first sentence of the topic', () => {
    expect(subjectFrom('the site visit on Thursday. Also parking.')).toBe(
      'The site visit on Thursday',
    );
  });

  it('never returns an empty subject', () => {
    expect(subjectFrom('')).toBe('(no subject)');
    expect(subjectFrom('   ')).toBe('(no subject)');
  });

  it('keeps a subject inside a sane header length', () => {
    expect(subjectFrom('x'.repeat(300)).length).toBeLessThanOrEqual(78);
  });
});
