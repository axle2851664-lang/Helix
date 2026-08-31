/**
 * The rotating examples under the reactor.
 *
 * A suggestion is a promise. Offering "Read my inbox" as an example makes
 * Helix look like something that reads inboxes, and the honest card that comes
 * back does not undo the impression - the user already believed it before they
 * clicked. So the rotation only ever offers things that will genuinely
 * succeed, given what is switched on right now.
 *
 * Everything Helix cannot do stays reachable by typing it. It simply is not
 * advertised.
 */

export interface PromptSuggestion {
  text: string;
  /** What will actually happen. Shown as the chip's title. */
  outcome: string;
}

export interface PromptInput {
  memoryAllowed: boolean;
  memoryCount: number;
  projectCount: number;
  unindexedFiles: number;
  searchableFiles: number;
  /** Null when speech input is available; the reason when it is not. */
  hearingBlocker: string | null;
}

/**
 * The examples worth offering, best first.
 *
 * Deterministic: the same state gives the same list in the same order, so the
 * rotation is reproducible and testable.
 */
export function suggestedPrompts(input: PromptInput): PromptSuggestion[] {
  const prompts: PromptSuggestion[] = [];

  // Always true: these read local state and need no provider at all.
  prompts.push({
    text: 'Brief me',
    outcome: 'Summarises your projects, files and notes, most-neglected first.',
  });
  prompts.push({
    text: 'Plan my day',
    outcome: 'Turns the same state into an ordered list, saying whose job each line is.',
  });

  if (input.unindexedFiles > 0) {
    prompts.push({
      text: 'Index my files',
      outcome: 'Extracts searchable text from files that have none yet.',
    });
  }

  if (input.searchableFiles > 0) {
    prompts.push({
      text: 'Search my files for invoices',
      outcome: 'Keyword search across indexed file contents. No model involved.',
    });
  }

  if (input.memoryAllowed) {
    prompts.push({
      text: 'Remember that I prefer short answers',
      outcome: 'Stores one note on this machine, and tells you exactly what it wrote.',
    });
    if (input.memoryCount > 0) {
      prompts.push({
        text: 'What do you remember?',
        outcome: 'Lists what you have asked Helix to keep.',
      });
    }
  }

  if (input.projectCount > 0) {
    prompts.push({
      text: 'Open my projects',
      outcome: 'Switches to the projects workspace.',
    });
  }

  prompts.push({
    text: 'Which model are you using?',
    outcome: 'Names the selected Claude model, and says it is not connected.',
  });
  prompts.push({
    text: 'Show me system diagnostics',
    outcome: 'Opens the system workspace: storage, capabilities and what is missing.',
  });
  prompts.push({
    text: 'Open the graph',
    outcome: 'Opens the vault graph.',
  });

  if (input.hearingBlocker === null) {
    prompts.push({
      text: 'Press the H and simply talk',
      outcome: 'Starts a voice turn. Helix stops listening when you stop speaking.',
    });
  }

  return prompts;
}

/**
 * A window of `size` items starting at `offset`, wrapping around.
 *
 * Pure, so the rotation can be tested without waiting on a timer - which is
 * the only way this is worth testing at all.
 */
export function rotateWindow<T>(items: readonly T[], offset: number, size: number): T[] {
  if (items.length === 0 || size <= 0) return [];

  const take = Math.min(size, items.length);
  // Modulo first, so a long-running page with a large offset does not walk off
  // the end, and a negative offset still lands inside the list.
  const start = ((offset % items.length) + items.length) % items.length;

  return Array.from({ length: take }, (_, index) => items[(start + index) % items.length] as T);
}
