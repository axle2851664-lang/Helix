import { describe, expect, it } from 'vitest';
import {
  PSTN_TRUTH,
  TRANSPORT_OPTIONS,
  costAnswer,
  freeOptionsFor,
  optionsFor,
  requiresPayment,
} from './transports.js';

describe('transport options', () => {
  it('gives every option needs, limits and something to confirm', () => {
    for (const option of TRANSPORT_OPTIONS) {
      expect(option.needs.length, option.id).toBeGreaterThan(0);
      expect(option.limits.length, option.id).toBeGreaterThan(0);
      expect(option.toConfirm.length, option.id).toBeGreaterThan(0);
    }
  });

  /**
   * The whole point of the file. A price or a trial allowance written here
   * would be planned around, and I do not know them to current accuracy.
   */
  it('quotes no prices or trial allowances', () => {
    const text = JSON.stringify(TRANSPORT_OPTIONS);

    expect(text).not.toMatch(/[£$€]\s?\d/);
    expect(text).not.toMatch(/\d+\s*(?:cents?|pence)/i);
    expect(text).not.toMatch(/\$\d|\d+ dollars/i);
  });

  it('says the Twilio trial is credit rather than a free tier', () => {
    const twilio = TRANSPORT_OPTIONS.find((option) => option.id === 'twilio');

    expect(twilio?.cost).toBe('trial-then-paid');
    expect(twilio?.limits.join(' ')).toContain('credit, not a free tier');
  });
});

describe('what is actually free', () => {
  it('finds free ways to send a message', () => {
    const free = freeOptionsFor('message').map((option) => option.id);
    expect(free).toContain('telegram');
    expect(free).toContain('webhook');
  });

  it('counts your own mailbox as free for email', () => {
    expect(freeOptionsFor('email').map((option) => option.id)).toContain('smtp');
  });

  /**
   * Trial credit does not count as free. Something that works until it
   * silently stops is worse than something that never started.
   */
  it('does not count trial credit as free', () => {
    expect(freeOptionsFor('sms')).toEqual([]);
    expect(requiresPayment('sms')).toBe(true);
  });

  // A browser-to-browser call is genuinely free and is not what most people
  // mean by a call, so it must not be allowed to imply that it is.
  it('offers a free call only between browsers, and says so', () => {
    const free = freeOptionsFor('call');

    expect(free.map((option) => option.id)).toEqual(['webrtc']);
    expect(free[0]?.limits.join(' ')).toContain('cannot ring a telephone');
  });

  it('tells the truth about the telephone network in both answers', () => {
    expect(costAnswer('sms')).toContain(PSTN_TRUTH);
    expect(costAnswer('call')).toContain(PSTN_TRUTH);
  });

  it('answers per kind rather than flattening them into one', () => {
    expect(costAnswer('message')).toContain('Free:');
    expect(costAnswer('sms')).toContain('Nothing free');
  });

  it('knows which kinds it has options for', () => {
    expect(optionsFor('call').length).toBeGreaterThan(0);
    expect(optionsFor('calendar-invite')).toEqual([]);
  });
});
