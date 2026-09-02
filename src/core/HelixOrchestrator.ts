import type { ActivityManager } from './ActivityManager.js';
import type { EventBus } from './EventBus.js';
import { HelixError } from './HelixError.js';
import type { Logger } from './Logger.js';
import type { SettingsManager } from '../settings/SettingsManager.js';
import type { ConversationStore } from '../conversations/ConversationStore.js';
import { resolveWorkspace, type WorkspaceId } from '../ui/workspaces/registry.js';
import { ProjectManager } from '../projects/ProjectManager.js';
import { formatContext, getModelOrDefault, resolveModel } from '../models/catalog.js';
import type { MemoryManager } from '../memory/MemoryManager.js';
import type { KnowledgeIndex } from '../knowledge/KnowledgeIndex.js';
import {
  allowAddressInReply,
  confirm,
  enquire,
  observe,
  regret,
  uncertain,
  unavailable,
} from '../persona/voice.js';
import type { ToolCard } from '../tools/cards.js';
import {
  buildBrief,
  buildPlan,
  type BriefProject,
  type BriefingInput,
} from '../tools/briefing.js';
import {
  inboxRequirement,
  researchRequirement,
  sendingRequirement,
} from '../tools/requirements.js';
import type { OutboundKind } from '../outbound/outbound.js';
import { scanForInjection } from '../guardrails/untrusted.js';
import type { WebResearch } from '../web/WebResearch.js';
import { asEvidence } from '../web/WebResearch.js';
import { researchCard } from '../tools/researchCard.js';
import type { AIRouter } from '../ai/AIRouter.js';
import { classify } from '../ai/AIRouter.js';
import { SYSTEM_PROMPT } from '../persona/systemPrompt.js';
import { repair } from '../persona/register.js';

/**
 * The Helix orchestration seam (spec: UI -> ORCHESTRATOR -> TOOLS).
 *
 * What this genuinely does today:
 *   1. Receives an instruction.
 *   2. Classifies it against the registered tools.
 *   3. Executes the tool when one matches and is available.
 *   4. Reports the outcome, tracking it as a real activity.
 *
 *   5. Sends anything no tool claimed to a language model, and puts the reply
 *      through the register check in `persona/register.ts` before it is shown.
 *
 * Point 5 was written before there was a model to send it to, and said so.
 * There is one now - it runs on this machine - but the rule it was protecting
 * has not moved an inch: when no provider can answer, this returns a failure
 * naming the missing dependency and never a canned reply that looks like an
 * answer. A plausible fake is worse than no answer, and the register pass is
 * held to the same line: it may delete a phrase from a fixed list, and it may
 * never write a sentence of its own.
 *
 * Tools are tried first and the model only sees what none of them claimed.
 * That ordering is what keeps "open my Iron Man project" a real action rather
 * than a model saying it opened something.
 *
 * Tools are registered rather than hard-coded so later phases add capability
 * without editing this class (spec: "Do NOT hard-code every command").
 */

export type IntentKind = 'navigate' | 'converse' | 'unknown';

export interface HelixRequest {
  text: string;
  conversationId: string;
}

export interface HelixResponse {
  /** Text to show the user. Always truthful about what happened. */
  text: string;
  /** True only when a tool actually ran to completion. */
  handled: boolean;
  /** Error code when the request could not be fulfilled. */
  failure?: string;
  /** Set when the orchestrator wants the UI to change workspace. */
  navigateTo?: WorkspaceId;
  /** Set when a tool resolved a project the UI should open. */
  openProjectId?: string;
  /**
   * The structured half of a two-part reply. The text above is what Helix says
   * out loud; this is what it puts on screen. They are never the same content -
   * reading a card aloud is not conversation.
   */
  card?: ToolCard;
}

/** A capability the orchestrator can route to. */
export interface HelixTool {
  name: string;
  description: string;
  /** Higher runs first. */
  priority: number;
  /** Can this tool handle the request? */
  matches(request: HelixRequest): boolean;
  /**
   * Why the tool cannot run right now, or null when it can. Checked before
   * execution so the user is told what is missing rather than seeing a failure.
   */
  unavailableReason(): string | null;
  /**
   * Handle the request, or return null to decline it so the next tool gets a
   * turn. Declining matters when a tool can only tell whether a request is
   * really its own by doing async work: "open settings" and "open my Iron Man
   * project" are the same shape, and only a project lookup can separate them.
   */
  execute(request: HelixRequest): Promise<HelixResponse | null>;
}

export interface OrchestratorOptions {
  settings: SettingsManager;
  conversations: ConversationStore;
  activity: ActivityManager;
  projects: ProjectManager;
  memory: MemoryManager;
  knowledge: KnowledgeIndex;
  logger: Logger;
  bus?: EventBus;
  /** Live web search. Absent means the research tool reports what is missing. */
  research?: WebResearch;
  /** The brain. Absent in tests that only exercise the tool routing. */
  ai?: AIRouter;
}

export class HelixOrchestrator {
  readonly #settings: SettingsManager;
  readonly #conversations: ConversationStore;
  readonly #activity: ActivityManager;
  readonly #projects: ProjectManager;
  readonly #memory: MemoryManager;
  readonly #knowledge: KnowledgeIndex;
  readonly #logger: Logger;
  readonly #ai: AIRouter | undefined;
  readonly #research: WebResearch | undefined;
  readonly #tools: HelixTool[] = [];

  constructor(options: OrchestratorOptions) {
    this.#settings = options.settings;
    this.#conversations = options.conversations;
    this.#activity = options.activity;
    this.#projects = options.projects;
    this.#memory = options.memory;
    this.#knowledge = options.knowledge;
    this.#logger = options.logger.child('orchestrator');
    this.#ai = options.ai;
    this.#research = options.research;

    // File search sits just below memory: "search my files for X" is explicit.
    this.registerTool(this.#fileSearchTool());
    // Memory runs first: "remember that ..." is an explicit instruction and
    // must never be mistaken for a project or navigation request.
    this.registerTool(this.#memoryTool());
    // Model switching outranks the rest: "switch to Sonnet" is unambiguous and
    // must never be mistaken for a project or workspace name.
    this.registerTool(this.#modelTool());
    // Projects outrank navigation: "open my Iron Man project" names a project,
    // and the word "project" alone must not send the user to a workspace.
    this.registerTool(this.#projectTool());
    // The briefing tools sit below the explicit instructions above and above
    // navigation, so that "brief me" is never read as "open the briefing".
    this.registerTool(this.#indexTool());
    this.registerTool(this.#briefingTool());
    this.registerTool(this.#planTool());
    this.registerTool(this.#inboxTool());
    this.registerTool(this.#sendingTool());
    this.registerTool(this.#researchTool());
    this.registerTool(this.#navigationTool());
  }

  registerTool(tool: HelixTool): void {
    this.#tools.push(tool);
    this.#tools.sort((a, b) => b.priority - a.priority);
    this.#logger.debug('Tool registered.', { name: tool.name });
  }

  get tools(): readonly HelixTool[] {
    return this.#tools;
  }

  /**
   * Handle one instruction end to end, recording both sides in the
   * conversation so the transcript reflects what actually happened.
   */
  async submit(request: HelixRequest): Promise<HelixResponse> {
    const text = request.text.trim();
    if (text === '') {
      return { text: '', handled: false, failure: 'EMPTY' };
    }

    await this.#conversations.appendMessage(request.conversationId, { role: 'user', text });

    const response = await this.#route({ ...request, text });

    await this.#conversations.appendMessage(request.conversationId, {
      role: 'helix',
      text: response.text,
      ...(response.failure !== undefined ? { failure: response.failure } : {}),
      ...(response.card !== undefined ? { card: response.card } : {}),
    });

    return response;
  }

  async #route(request: HelixRequest): Promise<HelixResponse> {
    for (const tool of this.#tools) {
      if (!tool.matches(request)) continue;

      const blocked = tool.unavailableReason();
      if (blocked !== null) {
        this.#logger.info('Tool matched but is unavailable.', { tool: tool.name });
        return { text: blocked, handled: false, failure: 'CAPABILITY_UNAVAILABLE' };
      }

      try {
        const response = await this.#activity.track(
          'thinking',
          () => tool.execute(request),
          { label: 'Thinking...', detail: tool.name },
        );
        // null means the tool declined; keep looking.
        if (response === null) continue;
        return response;
      } catch (error) {
        const helix = HelixError.from(
          error,
          regret('that request could not be completed'),
        );
        this.#logger.error('Tool execution failed.', { tool: tool.name, error });
        return { text: helix.userMessage, handled: false, failure: helix.code };
      }
    }

    return this.#converse(request);
  }

  /**
   * No tool matched, so this needs a language model. Report the missing
   * dependency instead of inventing a reply.
   */
  /**
   * Nothing matched a tool, so this is conversation.
   *
   * Runs the local model where one is available, and says plainly what is
   * missing where none is. The one thing it must never do is compose a reply
   * itself: a fabricated answer from a model that is not running is the single
   * worst failure this file could have, and it would be indistinguishable from
   * a real one.
   */
  async #converse(request: HelixRequest): Promise<HelixResponse> {
    if (!this.#ai) return this.#unhandled();

    const requirement = classify(request.text);

    try {
      // Short-term context: the conversation so far, so "show me the model"
      // knows which project was just opened.
      const conversation = await this.#conversations.get(request.conversationId);
      const history = (conversation?.messages ?? [])
        .filter((message) => message.role === 'user' || message.role === 'helix')
        .slice(-12)
        .map((message) => ({
          role: message.role === 'helix' ? ('assistant' as const) : ('user' as const),
          content: message.text,
        }));

      const result = await this.#ai.generate(
        [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
        requirement,
      );

      // A substitution is reported rather than hidden. The user asked one
      // thing to answer and something else did.
      const note = result.substituted
        ? `\n\n(${result.model} answered rather than ${result.requestedModel}.${
            result.capabilityLoss ? ` ${result.capabilityLoss}` : ''
          })`
        : '';

      // The persona prompt asks for Helix's register; this is what checks it
      // arrived. A small local model answers "Affirmative, sir" however plainly
      // the prompt forbids it, and `repair` removes that phrasing without ever
      // writing a sentence of its own - so what the model actually said still
      // reaches the user, in Helix's voice rather than a console's.
      const raw = result.text.trim();
      const spoken = repair(raw, {
        // The same rolling window that governs Helix's own sentences, so a
        // model that reaches for "sir" every time is brought back to the rate
        // rather than left to set it.
        allowAddress: allowAddressInReply(/\bsir\b/i.test(raw)),
      });
      if (spoken.findings.length > 0) {
        this.#logger.debug('Register corrected on a model reply.', {
          model: result.model,
          faults: spoken.findings.map((finding) => finding.fault),
          wholesale: spoken.wholesale,
        });
      }

      return { text: spoken.text + note, handled: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#logger.info('Conversation could not be answered.', { reason });

      return { text: reason, handled: false, failure: 'PROVIDER_NOT_CONFIGURED' };
    }
  }

  #unhandled(): HelixResponse {
    const provider = this.#settings.get('languageProvider');

    if (provider === 'none') {
      return {
        text: unavailable(
          'no language provider is configured, so I am unable to answer that yet',
          'You may select one in Settings under AI providers. In the meantime I can open any Helix workspace you name.',
        ),
        handled: false,
        failure: 'PROVIDER_NOT_CONFIGURED',
      };
    }

    const model = getModelOrDefault(this.#settings.get('languageModel'));
    return {
      text: unavailable(
        `${model.name} is selected with a ${provider} provider, but the connection is not yet built and no API key is configured`,
        'I would rather say so than invent an answer.',
      ),
      handled: false,
      failure: 'PROVIDER_NOT_IMPLEMENTED',
    };
  }

  /**
   * Searching indexed file contents (spec 12).
   *
   * Deliberately distinct from memory: this reads what is in the user's files,
   * never what Helix has been told to remember. Keyword search, no model, so it
   * works offline and with no provider configured.
   */
  #fileSearchTool(): HelixTool {
    const phrases = [
      'search my files',
      'search files',
      'find in my files',
      'find in files',
      'what do my files say',
      'search my documents',
      'look in my files',
      'search my notes',
    ];

    return {
      name: 'searchFiles',
      description: 'Search the text of your indexed files.',
      priority: 450,
      matches: (request) => {
        const lower = request.text.toLowerCase();
        return phrases.some((phrase) => lower.includes(phrase));
      },
      unavailableReason: () => null,
      execute: async (request) => {
        const lower = request.text.toLowerCase();
        // Longest phrase first so "search my files" is not cut at "search files".
        const phrase = [...phrases]
          .sort((a, b) => b.length - a.length)
          .find((candidate) => lower.includes(candidate));
        const at = phrase ? lower.indexOf(phrase) + phrase.length : 0;
        const query = request.text
          .slice(at)
          .replace(/^\s*(?:for|about|regarding|on)\b/i, '')
          .replace(/[?!.]+$/, '')
          .trim();

        const stats = await this.#knowledge.stats();

        if (query === '') {
          return {
            text:
              stats.searchable === 0
                ? observe('No files are indexed yet. You may import some from Upload Project')
                : enquire(
                    `What shall I search for? ${stats.searchable} ${
                      stats.searchable === 1 ? 'file is' : 'files are'
                    } indexed`,
                  ),
            handled: false,
            failure: 'VALIDATION_FAILED',
          };
        }

        if (stats.searchable === 0) {
          const unreadable = stats.documents - stats.searchable;
          return {
            text:
              unreadable > 0
                ? regret(
                    `none of your ${stats.documents} ${
                      stats.documents === 1 ? 'file' : 'files'
                    } could be indexed, so there is nothing to search. Files will show you why`,
                  )
                : observe('No files are indexed yet. You may import some from Upload Project'),
            handled: false,
            failure: 'NOT_FOUND',
          };
        }

        const hits = await this.#knowledge.search(query, { limit: 4 });
        if (hits.length === 0) {
          return {
            text: observe(
              `Nothing in your ${stats.searchable} indexed ${
                stats.searchable === 1 ? 'file' : 'files'
              } mentions "${query}"`,
            ),
            handled: true,
          };
        }

        const lines = hits.map((hit) => `- ${hit.fileName}: ${hit.snippet}`).join('\n');

        // A result that also contains text addressed to an assistant must say
        // so here. Leaving it to be discovered later, in a workspace the user
        // may never open, is too late to be of any use.
        const flagged = await this.#flaggedFiles(hits.map((hit) => hit.assetId));
        const notice =
          flagged.length === 0
            ? ''
            : `

${flagged.length === 1 ? 'One of those files' : `${flagged.length} of those files`} also contains text written as an instruction - ${flagged.join(', ')}. I have read it as content and nothing more. Files shows you the passages.`;

        return {
          text:
            confirm(
              `I've located ${hits.length === 1 ? 'a mention' : 'several mentions'} of "${query}"`,
            ) +
            `
${lines}${notice}`,
          handled: true,
        };
      },
    };
  }

  /**
   * Remembering, recalling and forgetting (spec 6, 10).
   *
   * Saving happens here and only here, in response to an explicit instruction.
   * Nothing in the conversation path writes long-term memory on its own, which
   * is the specification's rule that temporary context is never silently
   * promoted to permanent memory.
   *
   * Fully working offline and with no provider: storage and retrieval are
   * literal, no model involved.
   */
  #memoryTool(): HelixTool {
    const savePrefixes = [
      'remember that ',
      'remember this: ',
      'remember: ',
      'remember ',
      'note that ',
      'keep in mind that ',
    ];
    const recallPhrases = [
      'what do you remember',
      'what do you know about',
      'do you remember',
      'recall ',
      'what have you remembered',
      'list my memories',
      'show my memories',
      'what do you remember about',
    ];
    const forgetPrefixes = ['forget that ', 'forget about ', 'forget ', 'delete the memory '];

    return {
      name: 'memory',
      description: 'Remember something, recall what is stored, or forget it.',
      priority: 400,
      matches: (request) => {
        const lower = request.text.toLowerCase();
        return (
          savePrefixes.some((prefix) => lower.startsWith(prefix.trim())) ||
          recallPhrases.some((phrase) => lower.includes(phrase)) ||
          forgetPrefixes.some((prefix) => lower.startsWith(prefix.trim()))
        );
      },
      unavailableReason: () => null,
      execute: async (request) => {
        const text = request.text.trim();
        const lower = text.toLowerCase();

        // --- forget ---
        const forgetPrefix = forgetPrefixes.find((prefix) => lower.startsWith(prefix.trim()));
        if (forgetPrefix && !recallPhrases.some((phrase) => lower.includes(phrase))) {
          const subject = text.slice(forgetPrefix.trim().length).trim();
          if (subject === '') {
            return {
              text: enquire('What would you like me to forget'),
              handled: false,
              failure: 'VALIDATION_FAILED',
            };
          }
          const found = await this.#memory.search(subject, { limit: 5 });
          if (found.length === 0) {
            return {
              text: observe(`I have nothing on record regarding "${subject}"`),
              handled: false,
              failure: 'NOT_FOUND',
            };
          }
          const target = found[0];
          if (!target) {
            return {
              text: observe('Nothing matched that description'),
              handled: false,
              failure: 'NOT_FOUND',
            };
          }
          await this.#memory.delete(target.memory.id);
          return {
            text: confirm('That has been put out of mind') + `
"${target.memory.content}"`,
            handled: true,
          };
        }

        // --- recall ---
        if (recallPhrases.some((phrase) => lower.includes(phrase))) {
          const subject = extractRecallSubject(lower, recallPhrases);

          if (subject === '') {
            const all = await this.#memory.list();
            if (all.length === 0) {
              return {
                text: observe(
                  'You have not yet asked me to remember anything. Say "remember that ..." and I shall keep it',
                ),
                handled: true,
              };
            }
            const preview = all.slice(0, 5).map((record) => `- ${record.content}`).join('\n');
            const more = all.length > 5 ? `\n...and ${all.length - 5} more.` : '';
            return {
              text:
                observe(
                  `I have ${all.length} ${all.length === 1 ? 'item' : 'items'} on record`,
                ) + `
${preview}${more}`,
              handled: true,
            };
          }

          const found = await this.#memory.search(subject, { limit: 5 });
          if (found.length === 0) {
            return {
              text: observe(`I have nothing on record regarding "${subject}"`),
              handled: true,
            };
          }
          const lines = found.map((match) => `- ${match.memory.content}`).join('\n');
          return {
            text: observe(`Regarding "${subject}"`) + `
${lines}`,
            handled: true,
          };
        }

        // --- remember ---
        const savePrefix = savePrefixes.find((prefix) => lower.startsWith(prefix.trim()));
        if (!savePrefix) return null;

        const content = text.slice(savePrefix.trim().length).replace(/^[:,\s]+/, '').trim();
        if (content === '') {
          return {
            text: enquire('What would you like me to remember'),
            handled: false,
            failure: 'VALIDATION_FAILED',
          };
        }

        try {
          const record = await this.#memory.save({ content });
          // Quoted on its own line: echoing the content inline would put the
          // user's first person into Helix's mouth ("I've noted that I take my
          // coffee black" reads as Helix taking coffee black).
          return {
            text: confirm("I've made a note of that") + `
"${record.content}"`,
            handled: true,
          };
        } catch (error) {
          // Refusals (credentials, memory disabled) are the user's answer, not
          // an internal failure - surface the reason verbatim.
          const helix = HelixError.from(error, 'I could not store that.');
          return { text: helix.userMessage, handled: false, failure: helix.code };
        }
      },
    };
  }

  /**
   * Switching the Claude model, and reporting which one is selected.
   *
   * Genuinely working: it changes persisted state, so the choice survives a
   * restart and is visible in Settings and the status panel. It does not
   * connect to anything - the reply says so, because a user who switches models
   * would otherwise reasonably assume the next question gets answered.
   */
  #modelTool(): HelixTool {
    const switchVerbs = ['switch to', 'use ', 'change to', 'set model', 'switch model'];
    const askPhrases = [
      'which model',
      'what model',
      'which claude',
      'current model',
      'model are you',
    ];

    return {
      name: 'switchModel',
      description: 'Switch the Claude model, or report which one is selected.',
      priority: 300,
      matches: (request) => {
        const lower = request.text.toLowerCase();
        if (askPhrases.some((phrase) => lower.includes(phrase))) return true;
        // A switch needs both a switching verb and a recognisable model name.
        return switchVerbs.some((verb) => lower.includes(verb)) && resolveModel(lower) !== null;
      },
      unavailableReason: () => null,
      execute: async (request) => {
        const lower = request.text.toLowerCase();
        const current = getModelOrDefault(this.#settings.get('languageModel'));

        // A question about the current model, not a switch.
        if (askPhrases.some((phrase) => lower.includes(phrase))) {
          return {
            text:
              observe(
                `I am presently set to ${current.name} (${current.id}), with a ` +
                  `${formatContext(current.contextTokens)} context window`,
              ) +
              ` ${this.#connectionCaveat()}`,
            handled: true,
          };
        }

        const target = resolveModel(lower);
        if (!target) return null;

        if (target.id === current.id) {
          return {
            text: `${observe(`I am already set to ${target.name}`)} ${this.#connectionCaveat()}`,
            handled: true,
          };
        }

        await this.#settings.set('languageModel', target.id);
        this.#logger.info('Model switched.', { from: current.id, to: target.id });

        return {
          text:
            `${confirm(`I've switched to ${target.name}`)} ${target.summary} ` +
            `${this.#connectionCaveat()}`,
          handled: true,
        };
      },
    };
  }

  /**
   * Appended to every model reply. Selecting a model is real and persisted;
   * talking to it is not built, and the user must not be left guessing which.
   */
  #connectionCaveat(): string {
    return regret(
      'no API key is connected as yet, so I am still unable to answer questions with it',
      // The sentence this follows is already addressed; a second "sir" in one
      // reply reads as parody rather than courtesy.
      { address: false },
    );
  }

  /**
   * Opening a project by name (spec 7, 19).
   *
   * Genuinely working and model-free: the project index is searched literally,
   * so this works offline and with no provider configured. It only claims a
   * match when one is confident enough; an ambiguous or absent match says so
   * rather than opening the wrong project.
   */
  #projectTool(): HelixTool {
    const verbs = ['open', 'show', 'bring up', 'load', 'go to', 'take me to', 'display', 'launch'];
    /** Below this the match is too weak to act on without confirmation. */
    const CONFIDENT = 0.6;

    return {
      name: 'openProject',
      description: 'Open one of your projects by name.',
      priority: 200,
      matches: (request) => {
        const lower = request.text.toLowerCase();
        if (!verbs.some((verb) => lower.includes(verb))) return false;
        // Requires something to search for beyond filler words.
        return ProjectManager.normalizeQuery(lower) !== '';
      },
      unavailableReason: () => null,
      execute: async (request) => {
        const results = await this.#projects.searchProjects(request.text);
        const best = results[0];

        if (!best || best.score < CONFIDENT) {
          // No project matched. If what remains after stripping filler is just
          // a workspace name, this was navigation all along - decline so the
          // navigation tool can handle it. ("open settings" reaches here.)
          const residual = ProjectManager.normalizeQuery(request.text);
          if (resolveWorkspace(residual) !== null) return null;

          const total = (await this.#projects.listProjects()).length;
          if (total === 0) {
            return {
              text: observe(
                'You have no projects as yet. Importing a file from Upload Project will create one',
              ),
              handled: false,
              failure: 'NOT_FOUND',
            };
          }
          return {
            text: regret(
              `I could not find a project matching that. You have ${total} ${
                total === 1 ? 'project' : 'projects'
              }, which Projects will list for you`,
            ),
            handled: false,
            failure: 'NOT_FOUND',
          };
        }

        // A near-tie is ambiguous; ask rather than guess.
        const runnerUp = results[1];
        if (runnerUp && best.score - runnerUp.score < 0.1) {
          return {
            text: `${uncertain(
              `whether you mean "${best.project.name}" or "${runnerUp.project.name}"`,
            )} ${enquire('Which did you have in mind', { address: false })}`,
            handled: false,
            failure: 'AMBIGUOUS',
          };
        }

        const summary = await this.#projects.openProject(best.project.id);
        const parts = [confirm(`I've located the ${summary.name} project and am opening it now`)];
        parts.push(
          summary.assetCount === 0
            ? 'It holds no files as yet.'
            : `It holds ${summary.assetCount} ${summary.assetCount === 1 ? 'file' : 'files'}${
                summary.generatedCount > 0 ? `, ${summary.generatedCount} of them generated` : ''
              }.`,
        );

        return {
          text: parts.join(' '),
          handled: true,
          openProjectId: summary.id,
          navigateTo: 'upload-project',
        };
      },
    };
  }

  /**
   * Which of these files contain text shaped like an instruction.
   *
   * Scanned on read rather than stored at index time: a stored flag goes stale
   * as soon as the patterns improve, and a file indexed before a pattern
   * existed would report itself clean for ever.
   */
  async #flaggedFiles(assetIds: readonly string[]): Promise<string[]> {
    const names: string[] = [];

    for (const assetId of [...new Set(assetIds)]) {
      const document = await this.#knowledge.get(assetId);
      if (!document || !document.indexed) continue;
      if (scanForInjection(document.chunks.join('\n'), { limit: 1 }).length > 0) {
        names.push(document.fileName);
      }
    }
    return names;
  }

  /**
   * Gather the one snapshot both briefing tools read.
   *
   * Everything here is measured, never estimated. Two separate counts come out
   * of the knowledge index: how many files it has a record for, and how many
   * of those records actually produced text. A scanned PDF is indexed and
   * unsearchable at the same time, and collapsing those into one number would
   * have Helix tell a user to index a file that is already indexed.
   */
  async #briefingInput(): Promise<BriefingInput> {
    const [summaries, documents, memoryCount] = await Promise.all([
      this.#projects.listProjects(),
      this.#knowledge.list(),
      this.#memory.count(),
    ]);

    const attempted = new Map<string, number>();
    const readable = new Map<string, number>();
    for (const document of documents) {
      attempted.set(document.projectId, (attempted.get(document.projectId) ?? 0) + 1);
      if (document.indexed) {
        readable.set(document.projectId, (readable.get(document.projectId) ?? 0) + 1);
      }
    }

    const projects: BriefProject[] = summaries.map((summary) => ({
      id: summary.id,
      name: summary.name,
      description: summary.description,
      assetCount: summary.assetCount,
      indexedCount: attempted.get(summary.id) ?? 0,
      searchableCount: readable.get(summary.id) ?? 0,
      updatedAt: summary.updatedAt,
    }));

    return {
      now: Date.now(),
      projects,
      memoryCount,
      memoryEnabled: this.#memory.enabled,
      knowledge: {
        documents: documents.length,
        searchable: documents.filter((document) => document.indexed).length,
      },
    };
  }

  /**
   * "Brief me".
   *
   * Reads only what Helix itself holds. It deliberately does not reach for the
   * demo vault, which is invented fixtures - a briefing that mixed real
   * projects with fictional clients would be indistinguishable from one that
   * made them all up, and the entire value of a briefing is that you can act
   * on it without checking it first.
   */
  #briefingTool(): HelixTool {
    const phrases = [
      'brief me',
      'briefing',
      'catch me up',
      'where do things stand',
      'status report',
      'bring me up to speed',
    ];

    return {
      name: 'briefMe',
      description: 'Summarise what Helix holds, most-neglected first.',
      priority: 250,
      matches: (request) => {
        const lower = request.text.toLowerCase();
        return phrases.some((phrase) => lower.includes(phrase));
      },
      unavailableReason: () => null,
      execute: async () => {
        const reply = buildBrief(await this.#briefingInput());
        return { text: reply.spoken, handled: true, card: reply.card };
      },
    };
  }

  /** "Plan my day": the same state, as things that can actually be done. */
  #planTool(): HelixTool {
    const phrases = [
      'plan my day',
      'plan the day',
      'plan today',
      'what should i do',
      'what should i work on',
      'what is on today',
      'whats on today',
    ];

    return {
      name: 'planDay',
      description: 'Turn what Helix holds into an ordered, actionable list.',
      priority: 250,
      matches: (request) => {
        const lower = request.text.toLowerCase();
        return phrases.some((phrase) => lower.includes(phrase));
      },
      unavailableReason: () => null,
      execute: async () => {
        const reply = buildPlan(await this.#briefingInput());
        return { text: reply.spoken, handled: true, card: reply.card };
      },
    };
  }

  /**
   * Indexing, so that the plan's "I can do this" is a promise Helix can keep.
   *
   * A plan line claiming Helix can act, with no way to ask it to, is a lie
   * with a pleasant tone of voice.
   */
  #indexTool(): HelixTool {
    const phrases = ['index my files', 'index my projects', 'index everything', 'index the files'];

    return {
      name: 'indexFiles',
      description: 'Extract searchable text from project files.',
      priority: 260,
      matches: (request) => {
        const lower = request.text.toLowerCase();
        return phrases.some((phrase) => lower.includes(phrase));
      },
      unavailableReason: () => null,
      execute: async () => {
        const projects = await this.#projects.listProjects();
        if (projects.length === 0) {
          return {
            text: observe('There are no projects to index'),
            handled: false,
            failure: 'NOT_FOUND',
          };
        }

        let indexed = 0;
        let skipped = 0;
        for (const project of projects) {
          const result = await this.#knowledge.indexProject(project.id);
          indexed += result.indexed;
          skipped += result.skipped;
        }

        // Both numbers, always. Reporting only the successes would let a run
        // that skipped everything read as a run that worked.
        const detail =
          skipped === 0
            ? indexed + ' files are now searchable'
            : indexed +
              ' files are now searchable, and ' +
              skipped +
              ' yielded no readable text';
        return { text: confirm(detail), handled: true };
      },
    };
  }

  /**
   * "Read my inbox": not built, and it says exactly what is missing.
   *
   * There is no mail provider, and no way to reach one from a page whose
   * content policy forbids every outside origin. The only alternative to this
   * card is a plausible fake inbox, which is the one failure a user has no way
   * of detecting.
   */
  #inboxTool(): HelixTool {
    const phrases = [
      'read my inbox',
      'check my inbox',
      'my inbox',
      'my email',
      'my emails',
      'read my mail',
      'check my mail',
      'any new mail',
    ];

    return {
      name: 'readInbox',
      description: 'Read the inbox. Not built - reports what it would require.',
      priority: 250,
      matches: (request) => {
        const lower = request.text.toLowerCase();
        return phrases.some((phrase) => lower.includes(phrase));
      },
      unavailableReason: () => null,
      execute: async () => {
        const reply = inboxRequirement();
        return {
          text: reply.spoken,
          handled: false,
          failure: 'PROVIDER_NOT_CONFIGURED',
          card: reply.card,
        };
      },
    };
  }

  /**
   * "Email Marlow", "text her", "call the supplier".
   *
   * Helix is permitted to do all three now and can do none of them, so the
   * reply says what it would take and what it would cost. The cost half is the
   * point: a message can be genuinely free and a telephone call cannot, and
   * someone deciding what to set up needs that difference stated rather than
   * discovered on a bill.
   */
  #sendingTool(): HelixTool {
    /**
     * Anchored at the start, on whole words.
     *
     * A substring match is far too eager here: "ring" sits inside "bring up
     * the settings", so a looser test quietly stole every navigation request
     * that began with "bring". The verb has to be the first thing asked for,
     * after any politeness.
     */
    const LEAD_IN = /^(?:can you |could you |would you |please |helix,? )+/;

    const patterns: ReadonlyArray<{ kind: OutboundKind; pattern: RegExp }> = [
      { kind: 'call', pattern: /^(?:call|ring|phone)\b/ },
      { kind: 'sms', pattern: /^(?:text|sms)\b|^send (?:a |an )?(?:text|sms)\b/ },
      { kind: 'email', pattern: /^(?:email|e-mail)\b|^(?:send|draft|write|reply)\b[^.]{0,20}\bemail\b|^reply to\b/ },
      { kind: 'message', pattern: /^(?:message|dm|telegram)\b|^send (?:a |an )?(?:message|dm)\b/ },
    ];

    const classify = (text: string): OutboundKind | null => {
      let lower = text.toLowerCase().trim();
      // Strip repeated politeness, so "could you please call them" still reads
      // as a request to call.
      while (LEAD_IN.test(lower)) lower = lower.replace(LEAD_IN, '');

      for (const { kind, pattern } of patterns) {
        if (pattern.test(lower)) return kind;
      }
      return null;
    };

    return {
      name: 'sendSomething',
      description: 'Send a message or place a call. Reports what it would take and cost.',
      priority: 240,
      matches: (request) => classify(request.text) !== null,
      unavailableReason: () => null,
      execute: async (request) => {
        const kind = classify(request.text);
        if (kind === null) return null;

        const reply = sendingRequirement(kind);
        return {
          text: reply.spoken,
          handled: false,
          failure: 'PROVIDER_NOT_CONFIGURED',
          card: reply.card,
        };
      },
    };
  }

  /** "Look this up": the same shape, the same wall, with the query echoed back. */
  #researchTool(): HelixTool {
    const prefixes = [
      'research ',
      'look up ',
      'search the web for ',
      'search the web ',
      'search online for ',
      'find out about ',
      'what is the latest on ',
    ];

    return {
      name: 'researchWeb',
      description: 'Search the live web and answer from what was found.',
      priority: 250,
      matches: (request) => {
        const lower = request.text.toLowerCase();
        return prefixes.some((prefix) => lower.startsWith(prefix.trim()));
      },
      unavailableReason: () => null,
      execute: async (request) => {
        const lower = request.text.toLowerCase();
        const prefix = prefixes.find((candidate) => lower.startsWith(candidate.trim()));
        const query = prefix === undefined ? '' : request.text.slice(prefix.trim().length).trim();

        // No research service at all: the old requirement card, which names
        // what is missing rather than pretending to have searched.
        if (!this.#research) {
          const reply = researchRequirement(query);
          return {
            text: reply.spoken,
            handled: false,
            failure: 'PROVIDER_NOT_CONFIGURED',
            card: reply.card,
          };
        }

        return this.#searchAndAnswer(query);
      },
    };
  }

  /**
   * Search, then answer from what was found and from nothing else.
   *
   * The order matters and so does the failure handling. If the search finds
   * nothing, Helix says so - it does not fall through to answering from the
   * model's own memory, because an answer that arrives after "searching the
   * web" carries the authority of a search whether or not one succeeded. That
   * is the specific dishonesty this method is arranged to prevent.
   */
  async #searchAndAnswer(query: string): Promise<HelixResponse> {
    const research = this.#research as WebResearch;

    const finding = await this.#activity.track(
      'thinking',
      () => research.search(query),
      { label: 'Searching...', detail: query },
    );

    const card = researchCard(finding);

    if (finding.results.length === 0) {
      // Nothing found is a real answer, and it is not the same as a failure to
      // look - the card carries whichever it was, per provider.
      const spoken =
        finding.answered.length === 0
          ? unavailable('nothing could search for that', 'The card says what each provider needs.')
          : observe(`I searched and found nothing useful on ${query}`);
      return { text: spoken, handled: finding.answered.length > 0, card };
    }

    if (!this.#ai) {
      // Results without a model is still a useful answer: the card lists what
      // was found, with sources. Better than refusing to show it.
      return { text: observe(`I found ${finding.results.length} sources on ${query}`), handled: true, card };
    }

    if (finding.suspicious.length > 0) {
      this.#logger.info('A search result tried to give instructions.', {
        urls: finding.suspicious.map((entry) => entry.url),
      });
    }

    const result = await this.#ai.generate(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        // The evidence goes in as a user turn deliberately. A model treats its
        // system prompt as authority, and web text must never sit there.
        { role: 'user', content: asEvidence(finding) },
        { role: 'user', content: query },
      ],
      classify(query),
    );

    const spoken = repair(result.text.trim(), {
      allowAddress: allowAddressInReply(/\bsir\b/i.test(result.text)),
    });

    return { text: spoken.text, handled: true, card };
  }

  /**
   * Navigation is a genuinely working tool: it resolves a workspace by name or
   * alias and tells the UI to switch. No model is involved, so it works offline
   * and with no provider configured.
   */
  #navigationTool(): HelixTool {
    const verbs = ['open', 'show', 'go to', 'take me to', 'bring up', 'switch to', 'launch'];

    return {
      name: 'navigate',
      description: 'Open a Helix workspace by name.',
      priority: 100,
      matches: (request) => {
        const lower = request.text.toLowerCase();
        if (!verbs.some((verb) => lower.includes(verb))) return false;
        return resolveWorkspace(lower) !== null;
      },
      unavailableReason: () => null,
      execute: async (request) => {
        const target = resolveWorkspace(request.text.toLowerCase());
        if (target === null) {
          return {
            text: uncertain('which workspace you had in mind'),
            handled: false,
            failure: 'NOT_FOUND',
          };
        }
        return {
          text: confirm(`I'm opening ${target.replace(/-/g, ' ')}`),
          handled: true,
          navigateTo: target,
        };
      },
    };
  }
}

/**
 * Pull the subject out of a recall question.
 *
 * "what do you remember about my sister" -> "my sister";
 * "what do you remember" -> "" (a request to list everything).
 */
function extractRecallSubject(lower: string, phrases: readonly string[]): string {
  // Longest phrase first, so "what do you remember about" wins over
  // "what do you remember" and the word "about" is not left in the subject.
  const ordered = [...phrases].sort((a, b) => b.length - a.length);

  for (const phrase of ordered) {
    const index = lower.indexOf(phrase);
    if (index === -1) continue;
    let rest = lower.slice(index + phrase.length);
    rest = rest.replace(/^(?:about|of|regarding)\b/, '');
    return rest.replace(/[?!.]+$/, '').trim();
  }
  return '';
}
