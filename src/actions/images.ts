import { HelixError } from '../core/HelixError.js';
import { describeOutcome, type ImageSearch } from '../images/ImageSearch.js';
import type { ImageResultsStore } from '../images/ImageResultsStore.js';
import type { SettingsManager } from '../settings/SettingsManager.js';
import type { ActionDefinition } from './action.js';
import { optionalNumber, optionalString, readString } from './action.js';

/**
 * Searching the web for pictures, as an action (spec 2, 10).
 *
 * Gated on WEB_ACCESS rather than a new permission of its own. A new
 * IMAGE_SEARCH permission would be a second prompt for the same thing a person
 * already answered - the question "may Helix reach the internet" does not get
 * a different answer because the bytes coming back are a JPEG. The `Image
 * search` setting is the separate off switch for this specific feature, which
 * is what the brief actually needs.
 *
 * Reading is not destructive, so no confirmation. Saving one is a different
 * action with different rules.
 */

export interface ImageActionServices {
  search: ImageSearch;
  results: ImageResultsStore;
  settings: SettingsManager;
}

export function imageActions(services: ImageActionServices): ActionDefinition[] {
  const { search, results, settings } = services;

  return [
    {
      id: 'images.search',
      label: 'Search for images',
      group: 'knowledge',
      summary: 'Search the web for pictures and show them.',
      parameters: {
        query: {
          type: 'string',
          description: 'What to find pictures of.',
          required: true,
          maxLength: 200,
        },
        provider: {
          type: 'string',
          description: 'Which source to try first.',
          required: false,
          maxLength: 40,
        },
        count: {
          type: 'number',
          description: 'How many to ask for.',
          required: false,
          min: 1,
          max: 50,
        },
      },
      permission: 'WEB_ACCESS',
      confirmation: 'none',
      reversible: true,
      appliesTo: [],
      describe: (params) => `Search the web for pictures of "${readString(params, 'query')}".`,
      run: async (params) => {
        if (!settings.get('imageSearchEnabled')) {
          throw new HelixError('CAPABILITY_UNAVAILABLE', 'Image search is switched off in Settings.', {
            remedy: 'settings:providers',
          });
        }

        const blocker = search.blocker();
        if (blocker !== null) {
          throw new HelixError('PROVIDER_NOT_CONFIGURED', blocker, { remedy: 'settings:providers' });
        }

        const provider = optionalString(params, 'provider');
        const count = optionalNumber(params, 'count');

        results.setSearching(true);
        try {
          const outcome = await search.search({
            query: readString(params, 'query'),
            safeSearch: settings.get('imageSafeSearch'),
            ...(provider !== undefined ? { provider } : {}),
            ...(count !== undefined ? { count } : {}),
          });

          results.set(outcome);

          if (outcome.results.length === 0 && outcome.failures.length > 0) {
            // Every provider refused. That is a failure, not an empty result,
            // and the difference is what tells the user whether to retry.
            throw new HelixError('PROVIDER_UNREACHABLE', describeOutcome(outcome, search.providers));
          }

          return {
            message: describeOutcome(outcome, search.providers),
            data: outcome,
          };
        } catch (error) {
          results.setSearching(false);
          throw error;
        }
      },
    },
  ];
}

export const IMAGE_ACTION_IDS: readonly string[] = ['images.search'];
