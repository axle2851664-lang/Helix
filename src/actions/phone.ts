import { HelixError } from '../core/HelixError.js';
import {
  endpointUrl,
  generateKey,
  hostProblem,
  normaliseHost,
  portProblem,
} from '../relay/pairing.js';
import type { SettingsManager } from '../settings/SettingsManager.js';
import type { ActionDefinition } from './action.js';
import { optionalNumber, readString } from './action.js';

/**
 * Pairing and unpairing a phone (spec 5, 6, 9).
 *
 * These write settings that `settings.change` deliberately refuses to touch -
 * the relay section, which holds the shared key and the listener switch. That
 * is not a contradiction: the general "change a setting" action is a blunt
 * instrument handed to a planner, and letting it near the key that guards a
 * network listener would be exactly the hole that rule exists to close. These
 * two do one specific, named thing each, and pairing is gated on PHONE_PAIR.
 *
 * The key never appears in a message, only in the returned data. The runner
 * logs an action's id and outcome and never its result, so a key that stays
 * out of the message stays out of the log.
 */

export interface PhoneActionServices {
  settings: SettingsManager;
}

export function phoneActions(services: PhoneActionServices): ActionDefinition[] {
  const { settings } = services;

  return [
    {
      id: 'phone.pair',
      label: 'Pair a phone',
      group: 'system',
      summary: 'Generate a key and start listening for a phone on your private network.',
      parameters: {
        host: {
          type: 'string',
          description: 'The address your phone uses to reach this machine.',
          required: true,
          maxLength: 200,
        },
        port: {
          type: 'number',
          description: 'The port to listen on.',
          required: false,
          min: 1024,
          max: 65535,
        },
      },
      // Opening a network listener on this machine is exactly what this
      // permission is for. A phone pairing itself would be no permission at all.
      permission: 'PHONE_PAIR',
      confirmation: 'none',
      // Pairing again replaces the key, which is destructive; that is unpair's
      // job to warn about, and it runs first.
      reversible: true,
      appliesTo: [],
      describe: (params) => {
        const port = optionalNumber(params, 'port') ?? settings.get('phoneListenerPort');
        return `Listen for your phone on ${endpointUrl({ host: readString(params, 'host'), port })}.`;
      },
      run: async (params) => {
        const host = normaliseHost(readString(params, 'host'));
        const port = optionalNumber(params, 'port') ?? settings.get('phoneListenerPort');

        const problem = hostProblem(host) ?? portProblem(port);
        if (problem) throw new HelixError('VALIDATION_FAILED', problem);

        const key = generateKey();
        await settings.set('relaySecret', key);
        await settings.set('phoneListenerPort', port);
        // Switched on as part of pairing, so the key and the switch cannot
        // disagree - a stored key with the listener off is a setup that looks
        // finished and answers nothing.
        await settings.set('phoneListenerEnabled', true);

        return {
          // The key is not in the message, and the message is what gets shown
          // and repeated. It is in the data, for the screen that displays it.
          message: `Ready for your phone on ${endpointUrl({ host, port })}.`,
          data: { host, port, key },
        };
      },
    },

    {
      id: 'phone.unpair',
      label: 'Forget paired phones',
      group: 'system',
      summary: 'Delete the shared key and stop listening.',
      parameters: {},
      permission: null,
      confirmation: 'destructive',
      // Every paired phone stops working at once, and the old key is gone.
      reversible: false,
      appliesTo: [],
      describe: () =>
        'Delete the shared key and stop listening. Every phone paired with this machine will stop working until you pair it again.',
      run: async () => {
        await settings.set('phoneListenerEnabled', false);
        await settings.set('relaySecret', '');
        return { message: 'The key is gone and Helix is no longer listening for a phone.' };
      },
    },
  ];
}

export const PHONE_ACTION_IDS: readonly string[] = ['phone.pair', 'phone.unpair'];
