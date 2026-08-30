import type { ActivityManager } from './ActivityManager.js';
import type { EventBus } from './EventBus.js';
import { HelixError } from './HelixError.js';
import type { Logger } from './Logger.js';
import type { SettingsManager } from '../settings/SettingsManager.js';
import type { ConversationStore } from '../conversations/ConversationStore.js';
import { resolveWorkspace, type WorkspaceId } from '../ui/workspaces/registry.js';
import { ProjectManager } from '../projects/ProjectManager.js';
import { formatContext, getModelOrDefault, resolveModel } from '../models/catalog.js';

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
  logger: Logger;
  bus?: EventBus;
}

export class HelixOrchestrator {
  readonly #settings: SettingsManager;
  readonly #conversations: ConversationStore;
  readonly #activity: ActivityManager;
  readonly #projects: ProjectManager;
  readonly #logger: Logger;
  readonly #tools: HelixTool[] = [];

  constructor(options: OrchestratorOptions) {
    this.#settings = options.settings;
    this.#conversations = options.conversations;
    this.#activity = options.activity;
    this.#projects = options.projects;
    this.#logger = options.logger.child('orchestrator');

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
        const helix = HelixError.from(error, 'That request could not be completed.');
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
        text:
          'No language provider is configured, so I cannot answer that yet. ' +
          'Choose one in Settings under AI providers. ' +
          'I can still open any Helix workspace if you tell me where to go.',
        handled: false,
        failure: 'PROVIDER_NOT_CONFIGURED',
      };
    }

    const model = getModelOrDefault(this.#settings.get('languageModel'));
    return {
      text:
        `${model.name} is selected and a ${provider} provider is chosen, but the connection ` +
        'is not built yet and no API key is configured. Helix will not invent an answer, so ' +
        'this request cannot be completed.',
      handled: false,
      failure: 'PROVIDER_NOT_IMPLEMENTED',
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
              `Selected model: ${current.name} (${current.id}). ` +
              `${formatContext(current.contextTokens)} context, ` +
              `$${current.inputPricePerMTok}/$${current.outputPricePerMTok} per million tokens. ` +
              this.#connectionCaveat(),
            handled: true,
          };
        }

        const target = resolveModel(lower);
        if (!target) return null;

        if (target.id === current.id) {
          return {
            text: `Already using ${target.name}. ${this.#connectionCaveat()}`,
            handled: true,
          };
        }

        await this.#settings.set('languageModel', target.id);
        this.#logger.info('Model switched.', { from: current.id, to: target.id });

        return {
          text:
            `Switched to ${target.name} (${target.id}). ${target.summary} ` +
            `${formatContext(target.contextTokens)} context. ` +
            this.#connectionCaveat(),
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
    return 'No API key is connected yet, so I still cannot answer questions with it.';
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
              text: 'You do not have any projects yet. Import a file from Upload Project to create one.',
              handled: false,
              failure: 'NOT_FOUND',
            };
          }
          return {
            text: `I could not find a project matching that. You have ${total} ${
              total === 1 ? 'project' : 'projects'
            } - open Projects to see them.`,
            handled: false,
            failure: 'NOT_FOUND',
          };
        }

        // A near-tie is ambiguous; ask rather than guess.
        const runnerUp = results[1];
        if (runnerUp && best.score - runnerUp.score < 0.1) {
          return {
            text: `That could be "${best.project.name}" or "${runnerUp.project.name}". Which one do you mean?`,
            handled: false,
            failure: 'AMBIGUOUS',
          };
        }

        const summary = await this.#projects.openProject(best.project.id);
        const parts = [`Opening "${summary.name}".`];
        parts.push(
          summary.assetCount === 0
            ? 'It has no files yet.'
            : `${summary.assetCount} ${summary.assetCount === 1 ? 'file' : 'files'}${
                summary.generatedCount > 0 ? `, ${summary.generatedCount} generated` : ''
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
            text: 'I could not tell which workspace you meant.',
            handled: false,
            failure: 'NOT_FOUND',
          };
        }
        return {
          text: `Opening ${target.replace(/-/g, ' ')}.`,
          handled: true,
          navigateTo: target,
        };
      },
    };
  }
}
