import type { CardSection, ToolCard } from './cards.js';
import type { ResearchFinding } from '../web/WebResearch.js';

/**
 * What a search actually found, on screen, with its sources.
 *
 * The spoken half of the reply is a sentence a model wrote from the evidence.
 * This is the half that lets the user check it: every source named, every
 * provider that could not answer named too, and anything that tried to give
 * Helix instructions marked as such.
 *
 * The card is what makes the prose accountable. Without it, a summary of five
 * pages is indistinguishable from a summary of nothing, and the user has no
 * way to tell which they are reading.
 */
export function researchCard(finding: ResearchFinding): ToolCard {
  const suspiciousUrls = new Set(finding.suspicious.map((entry) => entry.url));
  const sections: CardSection[] = [];

  if (finding.results.length > 0) {
    sections.push({
      heading: 'Sources',
      items: finding.results.map((result, index) => ({
        label: `[${index + 1}] ${result.title}`,
        detail: result.snippet === '' ? result.url : result.snippet,
        meta: suspiciousUrls.has(result.url) ? 'contains instructions' : result.provider,
        accent: suspiciousUrls.has(result.url) ? ('warn' as const) : ('normal' as const),
        source: result.url,
      })),
    });
  }

  if (finding.suspicious.length > 0) {
    sections.push({
      heading: 'Treated as data, not instruction',
      items: finding.suspicious.map((entry) => ({
        label: entry.url,
        detail: `This page contains text aimed at an assistant: ${entry.findings
          .map((item) => item.kind)
          .join(', ')}. It was quoted to the model as somebody else's words, and not obeyed.`,
        meta: 'flagged',
        accent: 'warn' as const,
        source: entry.url,
      })),
    });
  }

  if (finding.failures.length > 0) {
    sections.push({
      // Named separately from "found nothing" throughout, because a user told
      // only that there were no results concludes their question has no
      // answer, when in fact nobody looked.
      heading: 'Could not look',
      items: finding.failures.map((failure) => ({
        label: failure.provider,
        detail: failure.reason,
        meta: 'unavailable',
        accent: 'warn' as const,
        source: 'Helix providers',
      })),
    });
  }

  const searched = finding.answered.length;

  return {
    kind: 'result',
    title: `Web search: ${finding.query}`,
    subtitle:
      searched === 0
        ? 'Nothing was able to search'
        : `${finding.results.length} ${finding.results.length === 1 ? 'source' : 'sources'} from ${searched} ${searched === 1 ? 'provider' : 'providers'}`,
    sections,
    // Required on every card. The limit worth stating is that these are
    // snippets, not the pages themselves - a snippet can be out of date or out
    // of context, and Helix has not read the article.
    caveat:
      'These are search snippets, not the full pages. Follow a source before relying on it for anything that matters.',
  };
}
