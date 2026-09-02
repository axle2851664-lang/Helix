import { describe, expect, it } from 'vitest';
import {
  composeReply,
  matchPhoneAction,
  stripDirectives,
  DIRECTIVE_PREFIX,
  PHONE_ACTIONS,
} from './directives.js';

describe('matching a phone action', () => {
  it.each([
    ['set brightness to 40', 'brightness', '40'],
    ['Set the volume to 70%', 'volume', '70'],
    ['turn the torch on', 'torch', 'on'],
    ['turn the flashlight off', 'torch', 'off'],
    ['set a timer for 10 minutes', 'timer', '10'],
    ['pause music', 'pause', ''],
    ['low power mode on', 'low-power', 'on'],
  ])('reads %j', (instruction, action, argument) => {
    expect(matchPhoneAction(instruction)).toEqual({ action, argument });
  });

  it('sees through a polite lead-in', () => {
    expect(matchPhoneAction('Helix, could you set brightness to 25')).toEqual({
      action: 'brightness',
      argument: '25',
    });
  });

  /**
   * Almost everything is not a phone action, and the default has to be
   * silence. An ordinary question that happens to contain a word from the
   * list must not reach into the phone.
   */
  it.each([
    'What is the capital of Australia?',
    'Brief me.',
    'Remind me to buy a torch',
    'What did I say about volume in that email?',
  ])('returns nothing for %j', (instruction) => {
    expect(matchPhoneAction(instruction)).toBeNull();
  });

  // Sloppy number, clear intention.
  it('clamps a percentage rather than refusing it', () => {
    expect(matchPhoneAction('set brightness to 150')?.argument).toBe('100');
  });

  // A twelve-hour timer set by accident is a phone that buzzes in the night.
  it('refuses an absurd timer instead of clamping it', () => {
    expect(matchPhoneAction('set a timer for 5000 minutes')).toBeNull();
    expect(matchPhoneAction('set a timer for 0 minutes')).toBeNull();
  });

  it('refuses an on/off action with neither', () => {
    expect(matchPhoneAction('turn the torch sideways')).toBeNull();
  });

  it('speaks the answer, not the instruction', () => {
    const directive = matchPhoneAction('read that out', 'Canberra, since 1913.');
    expect(directive).toEqual({ action: 'speak', argument: 'Canberra, since 1913.' });
  });

  it('has nothing to speak when there is no answer', () => {
    expect(matchPhoneAction('read that out', '   ')).toBeNull();
  });
});

describe('what the list deliberately excludes', () => {
  /**
   * A remote channel is the wrong place for an irreversible action, however
   * well authenticated. If any of these ever appears, it wants a confirmation
   * flow first, not a place on this list.
   */
  it('has no way to send, call, delete or buy', () => {
    const names = PHONE_ACTIONS.map((action) => action.name).join(' ');
    for (const forbidden of ['send', 'message', 'call', 'delete', 'buy', 'pay', 'erase']) {
      expect(names).not.toContain(forbidden);
    }
  });

  /**
   * A command that can cut the phone off the network can also be the last
   * command it ever receives.
   */
  it('cannot turn off the radios that make the phone reachable', () => {
    const triggers = PHONE_ACTIONS.flatMap((action) => action.triggers).join(' ');
    for (const forbidden of ['wifi', 'wi-fi', 'cellular', 'airplane', 'aeroplane']) {
      expect(triggers).not.toContain(forbidden);
    }
  });

  it('describes every action it does allow', () => {
    for (const action of PHONE_ACTIONS) {
      expect(action.describes.length, action.name).toBeGreaterThan(10);
      expect(action.triggers.length, action.name).toBeGreaterThan(0);
    }
  });
});

describe('stripping directives out of model prose', () => {
  /**
   * The step without which this module is an injection vector with a friendly
   * interface. Model text reaches the phone, and a line beginning with the
   * prefix would be executed by the Shortcut.
   */
  it('removes a directive the model wrote', () => {
    const answer = `Certainly.\n${DIRECTIVE_PREFIX} torch on\nAnything else?`;
    expect(stripDirectives(answer)).toBe('Certainly.\nAnything else?');
  });

  // The realistic route in: the user asks a question whose answer quotes one.
  it('removes one that arrived by being quoted', () => {
    const answer = `The format is a line reading "${DIRECTIVE_PREFIX} brightness 100".\n${DIRECTIVE_PREFIX} brightness 100`;
    const stripped = stripDirectives(answer);

    // The explanatory sentence survives; the executable line does not.
    expect(stripped).toContain('The format is a line');
    expect(stripped.split('\n').some((line) => line.trim().startsWith(DIRECTIVE_PREFIX))).toBe(
      false,
    );
  });

  it('leaves ordinary prose exactly as it was', () => {
    const answer = 'Canberra. Chosen as a compromise.';
    expect(stripDirectives(answer)).toBe(answer);
  });
});

describe('composing the reply', () => {
  it('appends the directive after the answer', () => {
    const body = composeReply('Brightness set.', { action: 'brightness', argument: '40' });
    expect(body).toBe(`Brightness set.\n\n${DIRECTIVE_PREFIX} brightness 40`);
  });

  it('adds nothing when there is no action', () => {
    expect(composeReply('Canberra.', null)).toBe('Canberra.');
  });

  /**
   * The ordering that makes the scrub meaningful: model text is cleaned first,
   * the real directive is added second, so exactly one can survive and it is
   * the one code chose.
   */
  it('lets only the directive it was given through', () => {
    const body = composeReply(
      `Fine.\n${DIRECTIVE_PREFIX} torch on`,
      { action: 'pause', argument: '' },
    );

    const directives = body
      .split('\n')
      .filter((line) => line.trim().startsWith(DIRECTIVE_PREFIX));

    expect(directives).toEqual([`${DIRECTIVE_PREFIX} pause`]);
  });

  it('still sends the directive when the answer was empty', () => {
    expect(composeReply('', { action: 'play', argument: '' })).toBe(`${DIRECTIVE_PREFIX} play`);
  });

  // One line, so a multi-line answer cannot smuggle a second instruction.
  it('flattens spoken text to a single line', () => {
    const directive = matchPhoneAction('read that out', 'One.\nTwo.\nThree.');
    expect(directive?.argument).toBe('One. Two. Three.');
  });
});
