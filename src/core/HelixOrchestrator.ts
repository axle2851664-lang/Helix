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
  confirm,
  enquire,
  observe,
  regret,
  uncertain,
  unavailable,
} from '../persona/voice.js';

/**
 * The Helix orchestration seam (spec: UI -> ORCHESTRATOR -> TOOLS).
 *
 * What this genuinely does today:
 *   1. Receives an instruction.
 *   2. Classifies it against the registered tools.
 *   3. Executes the tool when one matches and is available.
 *   4. Reports the outcome, tracking it as a real activity.
 *
 * What it explicitly does NOT do: answer questions. Conversation requires a
 * language provider, and none is implemented yet. Rather than emit a canned
 * reply that looks like an answer, an unroutable request returns a failure
 * naming the missing dependency. This is the single most important behaviour in
 * the file - a plausible fake answer would be worse than no answer.
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
}

export class HelixOrchestrator {
  readonly #settings: SettingsManager;
  readonly #conversations: ConversationStore;
  readonly #activity: ActivityManager;
  readonly #projects: ProjectManager;
  readonly #memory: MemoryManager;
  readonly #knowledge: KnowledgeIndex;
  readonly #logger: Logger;
  readonly #tools: HelixTool[] = [];

  constructor(options: OrchestratorOptions) {
    this.#settings = options.settings;
    this.#conversations = options.conversations;
    this.#activity = options.activity;
    this.#projects = options.projects;
    this.#memory = options.memory;
    this.#knowledge = options.knowledge;
    this.#logger = options.logger.child('orchestrator');

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

    return this.#unhandled();
  }

  /**
   * No tool matched, so this needs a language model. Report the missing
   * dependency instead of inventing a reply.
   */
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
        return {
          text:
            confirm(
              `I've located ${hits.length === 1 ? 'a mention' : 'several mentions'} of "${query}"`,
            ) +
            `
${lines}`,
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
    rest = rest.replace(/^(?:about|of|regarding)/, '');
    return rest.replace(/[?!.]+$/, '').trim();
  }
  return '';
}
