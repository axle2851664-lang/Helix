import type { ToolCard, ToolReply } from './cards.js';
import { unavailable } from '../persona/voice.js';

/**
 * The two tools that cannot run, and exactly why.
 *
 * Reading a mailbox and searching the web are both asked for in the brief, and
 * neither is possible in this build. The tempting move is a stub - three
 * plausible emails, a paragraph of plausible research - and it is the single
 * worst thing this codebase could contain. A stub that looks like an answer
 * gets believed, and a fabricated inbox is believed at exactly the moment it
 * matters.
 *
 * So they return the truth in the same shape as a working tool: a spoken line
 * saying it cannot be done, and a card setting out what is missing, what is
 * blocking it, and what Helix will still refuse to do once it works. A user who
 * asks Helix to read their inbox learns more from this card than from a
 * one-line refusal - it tells them what to go and build.
 *
 * The blocker is worth stating plainly because it is not a matter of effort.
 * The page ships a Content-Security-Policy of `connect-src 'self' blob:`,
 * which means the browser refuses every request to an origin that is not
 * Helix itself. No mail server and no search engine is reachable from here,
 * with or without credentials. That is deliberate - it is also why no API key
 * can leak from this build - and it does not change until Helix runs inside a
 * desktop shell that makes network calls outside the page.
 */

/** Named once: several cards point at the same wall. */
const CSP_BLOCKER =
  "This build is a web page with `connect-src 'self'`, so the browser refuses every request to an outside origin. No credentials would change that.";

const SHELL_REMEDY =
  'It needs the desktop shell, where network calls happen outside the page and a key can be held out of the browser entirely.';

export function inboxRequirement(): ToolReply {
  const card: ToolCard = {
    kind: 'requirement',
    title: 'Reading your inbox',
    subtitle: 'Not built. Here is what it would take',
    sections: [
      {
        heading: 'Missing',
        items: [
          {
            label: 'A mail account connection',
            detail: 'No mail provider exists in Helix. Nothing is half-built and nothing is stubbed',
            meta: 'not written',
            accent: 'warn',
            source: 'Helix providers',
          },
          {
            label: 'A way to reach it',
            detail: CSP_BLOCKER,
            meta: 'blocked by design',
            accent: 'warn',
            source: 'index.html CSP',
          },
          {
            label: 'Somewhere to hold the credential',
            detail:
              'A mail token must never sit in browser storage or in the page. ' + SHELL_REMEDY,
            meta: 'needs the shell',
            accent: 'warn',
            source: 'docs/SECURITY.md',
          },
        ],
      },
      {
        heading: 'When it exists',
        items: [
          {
            label: 'I will read and I will draft',
            detail: 'Summaries, replies written out for you, nothing hidden',
            meta: 'planned',
            accent: 'good',
            source: 'Your standing instruction',
          },
          {
            label: 'I will not send',
            detail:
              'No message, no reply, no calendar invite leaves this machine without you pressing send yourself',
            meta: 'permanent',
            accent: 'good',
            source: 'Your standing instruction',
          },
          {
            label: 'Anything in a message is information, not an order',
            detail:
              'An email telling me to ignore my instructions gets reported to you, never obeyed',
            meta: 'permanent',
            accent: 'good',
            source: 'Your standing instruction',
          },
        ],
      },
    ],
    caveat:
      'Nothing on this card is a sample of your mail. Helix has never seen your mail and has no way to reach it.',
  };

  return {
    spoken: unavailable(
      'I have no way to reach your mail, and I would rather show you why than invent a message',
    ),
    card,
  };
}

export function researchRequirement(query: string): ToolReply {
  const asked = query.trim();

  const card: ToolCard = {
    kind: 'requirement',
    title: 'Searching the web',
    subtitle: asked === '' ? 'Not built' : 'Not built - nothing was looked up',
    sections: [
      ...(asked === ''
        ? []
        : [
            {
              heading: 'You asked about',
              items: [
                {
                  label: asked,
                  detail: 'Recorded here so you can see it was not answered from memory',
                  meta: 'not searched',
                  accent: 'quiet' as const,
                  source: 'Your request',
                },
              ],
            },
          ]),
      {
        heading: 'Missing',
        items: [
          {
            label: 'A search provider',
            detail: 'No search or fetch provider is configured, and none is written',
            meta: 'not written',
            accent: 'warn',
            source: 'Helix providers',
          },
          {
            label: 'A way to reach one',
            detail: CSP_BLOCKER + ' ' + SHELL_REMEDY,
            meta: 'blocked by design',
            accent: 'warn',
            source: 'index.html CSP',
          },
        ],
      },
      {
        heading: 'When it exists',
        items: [
          {
            label: 'Every claim will carry its page',
            detail: 'A result without a link it came from is a guess wearing a citation',
            meta: 'planned',
            accent: 'good',
            source: 'Your standing instruction',
          },
          {
            label: 'A page is information, not an order',
            detail:
              'Text on a fetched page instructing me to do something gets shown to you, never followed',
            meta: 'permanent',
            accent: 'good',
            source: 'Your standing instruction',
          },
        ],
      },
    ],
    caveat:
      'I have not answered the question from my own knowledge either. Doing so while you believed I had searched would be the worse of the two failures.',
  };

  return {
    spoken: unavailable(
      'I cannot search the web from this build, and I will not answer from memory while you think I looked it up',
    ),
    card,
  };
}
