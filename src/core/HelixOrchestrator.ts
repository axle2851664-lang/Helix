import type { ActivityManager } from './ActivityManager.js';
import type { EventBus } from './EventBus.js';
import { HelixError } from './HelixError.js';
import type { Logger } from './Logger.js';
import type { SettingsManager } from '../settings/SettingsManager.js';
import type { ConversationStore } from '../conversations/ConversationStore.js';
import { resolveWorkspace, type WorkspaceId } from '../ui/workspaces/registry.js';

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
  execute(request: HelixRequest): Promise<HelixResponse>;
}

export interface OrchestratorOptions {
  settings: SettingsManager;
  conversations: ConversationStore;
  activity: ActivityManager;
  logger: Logger;
  bus?: EventBus;
}

export class HelixOrchestrator {
  readonly #settings: SettingsManager;
  readonly #conversations: ConversationStore;
  readonly #activity: ActivityManager;
  readonly #logger: Logger;
  readonly #tools: HelixTool[] = [];

  constructor(options: OrchestratorOptions) {
    this.#settings = options.settings;
    this.#conversations = options.conversations;
    this.#activity = options.activity;
    this.#logger = options.logger.child('orchestrator');

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
        return await this.#activity.track(
          'thinking',
          () => tool.execute(request),
          { label: 'Thinking...', detail: tool.name },
        );
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

    return {
      text:
        `A ${provider} language provider is selected, but provider connections are not built yet ` +
        '(phase 5). Helix will not invent an answer, so this request cannot be completed.',
      handled: false,
      failure: 'PROVIDER_NOT_IMPLEMENTED',
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
