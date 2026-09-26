import { HelixError } from '../core/HelixError.js';
import type { CalendarProvider } from '../integrations/google/CalendarProvider.js';
import type { GmailProvider } from '../integrations/google/GmailProvider.js';
import { parseWhen } from '../integrations/google/when.js';
import type { ActionDefinition, ActionParams } from './action.js';
import { optionalString, readString } from './action.js';

/**
 * Mail housekeeping and calendar entries, as actions.
 *
 * The confirmation choices are the interesting part, and they are not uniform:
 *
 * - **Archiving and starring are not confirmed.** Both are one click to undo
 *   in Gmail, both have an undo action here, and confirming every one would
 *   teach the user to click through confirmations - which is how the
 *   confirmation that matters gets clicked through too.
 *
 * - **Creating an event is confirmed.** It appears in a place Helix does not
 *   control, at a specific time, and the confirmation shows that time in full
 *   so a misread "Tuesday" is caught before it is booked rather than after it
 *   is missed.
 */

export interface GoogleActionServices {
  gmail: GmailProvider;
  calendar: CalendarProvider;
  now?: () => Date;
}

/** Message ids arrive as a comma-separated list; the action layer has no arrays. */
function idsFrom(params: ActionParams, name = 'ids'): string[] {
  return readString(params, name)
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

const idsParam = {
  ids: {
    type: 'string' as const,
    description: 'Message ids, separated by commas.',
    required: true,
    maxLength: 4000,
  },
};

function mailAction(options: {
  id: string;
  label: string;
  summary: string;
  verb: string;
  run: (ids: readonly string[]) => Promise<{ changed: number }>;
}): ActionDefinition {
  return {
    id: options.id,
    label: options.label,
    group: 'system',
    summary: options.summary,
    parameters: idsParam,
    permission: 'GOOGLE_GMAIL_READ',
    // Reversible in one click from Gmail, and each has an undo here.
    confirmation: 'none',
    reversible: true,
    appliesTo: [],
    describe: (params) => {
      const count = idsFrom(params).length;
      return `${options.verb} ${count} ${count === 1 ? 'message' : 'messages'}.`;
    },
    run: async (params) => {
      const ids = idsFrom(params);
      if (ids.length === 0) throw new HelixError('VALIDATION_FAILED', 'No messages were named.');
      const result = await options.run(ids);
      return {
        message: `${options.verb} ${result.changed} ${result.changed === 1 ? 'message' : 'messages'}.`,
        data: result,
      };
    },
  };
}

export function googleActions(services: GoogleActionServices): ActionDefinition[] {
  const { gmail, calendar } = services;
  const now = services.now ?? (() => new Date());

  return [
    mailAction({
      id: 'mail.archive',
      label: 'Archive mail',
      summary: 'Take messages out of the inbox. They stay in All Mail.',
      verb: 'Archived',
      run: (ids) => gmail.archive(ids),
    }),
    mailAction({
      id: 'mail.unarchive',
      label: 'Put mail back in the inbox',
      summary: 'The undo for archiving.',
      verb: 'Returned to the inbox:',
      run: (ids) => gmail.unarchive(ids),
    }),
    mailAction({
      id: 'mail.star',
      label: 'Star mail',
      summary: 'Add a star.',
      verb: 'Starred',
      run: (ids) => gmail.star(ids),
    }),
    mailAction({
      id: 'mail.unstar',
      label: 'Remove a star',
      summary: 'The undo for starring.',
      verb: 'Unstarred',
      run: (ids) => gmail.unstar(ids),
    }),
    mailAction({
      id: 'mail.markRead',
      label: 'Mark mail read',
      summary: 'Remove the unread marker.',
      verb: 'Marked read:',
      run: (ids) => gmail.markRead(ids),
    }),
    // Trash is the one mail action that is confirmed.
    //
    // The others are a label change away from being undone and Gmail undoes
    // them in a click. This takes a message out of the inbox entirely, and
    // although Trash holds it for thirty days, that is a window rather than
    // an undo - nobody checks a bin they did not know they filled. The
    // confirmation shows the count before it happens.
    {
      ...mailAction({
        id: 'mail.trash',
        label: 'Move mail to Trash',
        summary: 'What Gmail\u2019s own Delete button does. Recoverable for thirty days.',
        verb: 'Moved to Trash:',
        run: (ids) => gmail.trash(ids),
      }),
      confirmation: 'destructive' as const,
    },
    mailAction({
      id: 'mail.untrash',
      label: 'Take mail back out of Trash',
      summary: 'The undo for trashing, while it is still there.',
      verb: 'Restored:',
      run: (ids) => gmail.untrash(ids),
    }),
    mailAction({
      id: 'mail.markUnread',
      label: 'Mark mail unread',
      summary: 'The undo for marking read.',
      verb: 'Marked unread:',
      run: (ids) => gmail.markUnread(ids),
    }),

    {
      id: 'calendar.create',
      label: 'Add to your calendar',
      group: 'system',
      summary: 'Put an event on your own calendar. Nobody is invited.',
      parameters: {
        summary: {
          type: 'string',
          description: 'What the event is called.',
          required: true,
          maxLength: 200,
        },
        when: {
          type: 'string',
          description: 'When, e.g. "tomorrow at 3pm" or "2026-10-02 at 09:30 for 30 minutes".',
          required: true,
          maxLength: 200,
        },
        location: {
          type: 'string',
          description: 'Where.',
          required: false,
          maxLength: 200,
        },
      },
      permission: 'GOOGLE_CALENDAR_WRITE',
      // It appears at a specific time in a place Helix does not control, and
      // the confirmation is where a misread day gets caught.
      confirmation: 'always',
      reversible: true,
      appliesTo: [],
      describe: (params) => {
        const parsed = parseWhen(readString(params, 'when'), now());
        if (parsed === null) {
          return `Helix could not work out when "${readString(params, 'when')}" is.`;
        }
        return parsed.allDay
          ? `Add "${readString(params, 'summary')}" to your calendar, all day on ${parsed.start}.`
          : `Add "${readString(params, 'summary')}" to your calendar at ${parsed.start.replace('T', ' ')}, ending ${parsed.end.replace('T', ' ')}.`;
      },
      run: async (params) => {
        const when = readString(params, 'when');
        const parsed = parseWhen(when, now());

        if (parsed === null) {
          // Refusing beats guessing: a misread time is found out by missing
          // the appointment.
          throw new HelixError(
            'VALIDATION_FAILED',
            `I could not be certain when "${when}" is, and I will not guess at a time. Give me a day and a time - "tomorrow at 3pm", or a date like 2026-10-02 at 09:30.`,
          );
        }

        const location = optionalString(params, 'location');
        const created = await calendar.createEvent({
          summary: readString(params, 'summary'),
          start: parsed.start,
          end: parsed.end,
          allDay: parsed.allDay,
          ...(location !== undefined ? { location } : {}),
        });

        return {
          message: `"${created.summary}" is on your calendar${created.url ? `: ${created.url}` : '.'}`,
          data: created,
        };
      },
    },
  ];
}

export const GOOGLE_ACTION_IDS: readonly string[] = [
  'mail.archive',
  'mail.unarchive',
  'mail.star',
  'mail.unstar',
  'mail.markRead',
  'mail.markUnread',
  'calendar.create',
];
