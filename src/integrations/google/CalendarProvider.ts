import type { InferenceTransport } from '../../ai/types.js';

/**
 * Google Calendar: reading what is on, and putting something on it.
 *
 * Same wall as Gmail and Docs - the token is attached in the shell and never
 * reaches the page.
 *
 * One capability is deliberately absent. **Events are created without
 * attendees.** Adding one sends an invitation, which is mail to another
 * person, and the standing rule is that nothing reaches anybody else without
 * the user seeing the exact thing and agreeing to that specific one. Helix has
 * that flow for outbound drafts; wiring invitations into it is a separate
 * piece of work, and shipping a half-tested version that emails your
 * colleagues is the wrong way round. So this puts things on your own calendar
 * and says so.
 *
 * Nothing here deletes or edits an existing event either. The scope for that
 * is the same one used to create, so the restraint is in the code rather than
 * in what Google permits - and that gap is deliberate, as with `sendReply`.
 */

export interface CalendarEvent {
  id: string;
  summary: string;
  /** As Google returned it: a date for an all-day entry, else a datetime. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  /** The page to open it on. */
  url?: string;
}

export interface CreatedEvent {
  id: string;
  summary: string;
  start: string;
  url: string | null;
}

const NOT_CONNECTED =
  'Google is not connected, so I cannot see your calendar. Connect an account in Settings.';

export interface CalendarProviderOptions {
  transport: InferenceTransport;
  /** Read at the moment of use: OAuth completes after the kernel is built. */
  account?: () => string | null | undefined;
  /** Injected so tests do not depend on the machine's zone. */
  timeZone?: () => string;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export class CalendarProvider {
  readonly #transport: InferenceTransport;
  readonly #account: () => string | null | undefined;
  readonly #timeZone: () => string;

  constructor(options: CalendarProviderOptions) {
    this.#transport = options.transport;
    this.#account = options.account ?? (() => null);
    this.#timeZone =
      options.timeZone ??
      (() => {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        } catch {
          return 'UTC';
        }
      });
  }

  unavailableReason(): string | null {
    const blocked = this.#transport.unavailableReason('google');
    if (blocked !== null) return blocked;
    const account = this.#account();
    if (account === null || account === undefined || account === '') return NOT_CONNECTED;
    return null;
  }

  /**
   * What is coming up.
   *
   * `singleEvents` expands a repeating event into its occurrences, which is
   * what anybody asking "what's on Thursday" means. Without it a weekly
   * stand-up appears once, on the day it was first created.
   */
  async upcoming(options: { from?: Date; days?: number; limit?: number } = {}): Promise<
    readonly CalendarEvent[]
  > {
    const refusal = this.unavailableReason();
    if (refusal !== null) throw new Error(refusal);

    const from = options.from ?? new Date();
    const until = new Date(from);
    until.setDate(until.getDate() + (options.days ?? 7));

    const path =
      '/calendar/v3/calendars/primary/events' +
      `?timeMin=${encodeURIComponent(from.toISOString())}` +
      `&timeMax=${encodeURIComponent(until.toISOString())}` +
      `&maxResults=${Math.max(1, Math.min(50, options.limit ?? 20))}` +
      '&singleEvents=true&orderBy=startTime';

    const body = (await this.#transport.request({
      providerId: 'google',
      path,
      body: null,
    })) as { items?: unknown };

    const items = Array.isArray(body.items) ? body.items : [];
    const events: CalendarEvent[] = [];

    for (const raw of items) {
      const item = raw as Record<string, unknown>;
      const start = item['start'] as Record<string, unknown> | undefined;
      const end = item['end'] as Record<string, unknown> | undefined;

      const startAt = text(start?.['dateTime']) ?? text(start?.['date']);
      const endAt = text(end?.['dateTime']) ?? text(end?.['date']);
      const id = text(item['id']);
      if (startAt === undefined || endAt === undefined || id === undefined) continue;

      events.push({
        id,
        // An event with no title is normal in Google and shows as this there.
        summary: text(item['summary']) ?? '(no title)',
        start: startAt,
        end: endAt,
        allDay: text(start?.['dateTime']) === undefined,
        ...(text(item['location']) !== undefined ? { location: text(item['location']) as string } : {}),
        ...(text(item['htmlLink']) !== undefined ? { url: text(item['htmlLink']) as string } : {}),
      });
    }

    return events;
  }

  /**
   * Put something on your own calendar.
   *
   * No attendees, by construction - see the note at the top of this file.
   */
  async createEvent(options: {
    summary: string;
    /** Local wall-clock ISO, or a bare date for an all-day entry. */
    start: string;
    end: string;
    allDay: boolean;
    description?: string;
    location?: string;
  }): Promise<CreatedEvent> {
    const refusal = this.unavailableReason();
    if (refusal !== null) throw new Error(refusal);

    const summary = options.summary.trim();
    if (summary === '') throw new Error('An event needs a name.');

    const zone = this.#timeZone();
    const when = (value: string) =>
      options.allDay ? { date: value } : { dateTime: value, timeZone: zone };

    const body = (await this.#transport.request({
      providerId: 'google',
      path: '/calendar/v3/calendars/primary/events',
      body: {
        summary,
        start: when(options.start),
        end: when(options.end),
        ...(options.description ? { description: options.description } : {}),
        ...(options.location ? { location: options.location } : {}),
      },
    })) as Record<string, unknown>;

    const id = text(body['id']);
    if (id === undefined) {
      throw new Error('Google accepted that but did not say what it created.');
    }

    return {
      id,
      summary: text(body['summary']) ?? summary,
      start: options.start,
      url: text(body['htmlLink']) ?? null,
    };
  }
}
