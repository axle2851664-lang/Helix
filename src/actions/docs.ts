import { HelixError } from '../core/HelixError.js';
import type { DocsProvider } from '../integrations/google/DocsProvider.js';
import type { ActionDefinition } from './action.js';
import { optionalString, readString } from './action.js';

/**
 * Writing a Google Doc (spec 5).
 *
 * Gated on GOOGLE_DRIVE_WRITE and confirmed every time. Confirmation is not
 * about danger - a new document destroys nothing - it is about a thing
 * appearing in somebody's Drive that they did not watch being made. The
 * confirmation shows the title and the opening of the actual text, so what is
 * agreed to is this document rather than the idea of one.
 */

export interface DocsActionServices {
  docs: DocsProvider;
}

/** Enough of the text to recognise it, without filling the dialog. */
function preview(text: string, limit = 160): string {
  const flat = text.replace(/\n+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}...`;
}

export function docsActions(services: DocsActionServices): ActionDefinition[] {
  const { docs } = services;

  return [
    {
      id: 'docs.create',
      label: 'Write a Google Doc',
      group: 'files',
      summary: 'Create a document in Google Docs and write formatted text into it.',
      parameters: {
        content: {
          type: 'string',
          description: 'The text to write. Headings, bullets and **bold** are formatted.',
          required: true,
          maxLength: 40_000,
        },
        title: {
          type: 'string',
          description: 'What to call it. Taken from the first heading when omitted.',
          required: false,
          maxLength: 120,
        },
      },
      permission: 'GOOGLE_DRIVE_WRITE',
      confirmation: 'always',
      // Nothing is overwritten and the document can be deleted, but it does
      // appear in a place Helix does not control.
      reversible: true,
      appliesTo: [],
      describe: (params) => {
        const prepared = docs.plan(
          readString(params, 'content'),
          optionalString(params, 'title'),
        );
        if (prepared.plan.requests.length === 0) {
          return 'There is nothing to write.';
        }
        return `Create a Google Doc called "${prepared.title}", beginning "${preview(prepared.plan.text)}"`;
      },
      run: async (params) => {
        const refusal = docs.unavailableReason();
        if (refusal !== null) {
          throw new HelixError('PROVIDER_NOT_CONFIGURED', refusal, { remedy: 'settings:relay' });
        }

        const created = await docs.create(
          readString(params, 'content'),
          optionalString(params, 'title'),
        );

        return {
          message: `"${created.title}" is in your Google Docs: ${created.url}`,
          data: created,
        };
      },
    },
  ];
}

export const DOCS_ACTION_IDS: readonly string[] = ['docs.create'];
