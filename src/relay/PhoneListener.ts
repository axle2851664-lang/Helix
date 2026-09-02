import { composeReply, matchPhoneAction } from './directives.js';
import type { CommandSink } from './RelayWatcher.js';

/**
 * The half of the direct connection that lives in the web view.
 *
 * The shell holds the socket and does the guarding - peer address, shared key,
 * body size. It cannot run a command, because the orchestrator and everything
 * it routes to are here. So a request arrives as an event, this answers it,
 * and the shell releases the waiting HTTP response.
 *
 * The same rule as the mail relay, and for the same reason: commands go
 * through the orchestrator's own `submit`, so a phone instruction gets the
 * identical tools, guardrails and refusals as one typed into the chat box.
 * A second path with weaker rules is how a remote channel becomes the soft
 * way in.
 *
 * One request at a time, deliberately. A local model on this hardware takes
 * seconds to minutes per reply, and letting several run at once would exhaust
 * the memory this project keeps measuring. The shell's own timeout is the
 * backstop for anything that queues too long.
 */

/** What the shell sends when a request arrives. */
export interface PhoneCommandEvent {
  id: string;
  text: string;
}

export interface PhoneListenerOptions {
  sink: CommandSink;
  /** Subscribe to shell events. Returns an unsubscribe. */
  listen: (event: string, handler: (payload: PhoneCommandEvent) => void) => Promise<() => void>;
  /** Hand an answer back to the waiting HTTP request. */
  reply: (id: string, text: string) => Promise<void>;
  conversationId?: string;
  log?: (message: string, detail?: unknown) => void;
}

export class PhoneListener {
  readonly #options: Required<Omit<PhoneListenerOptions, 'log'>> & {
    log: (message: string, detail?: unknown) => void;
  };
  #stop: (() => void) | null = null;
  /** Commands run in turn rather than at once. */
  #queue: Promise<void> = Promise.resolve();

  constructor(options: PhoneListenerOptions) {
    this.#options = {
      sink: options.sink,
      listen: options.listen,
      reply: options.reply,
      conversationId: options.conversationId ?? 'phone',
      log: options.log ?? (() => {}),
    };
  }

  get running(): boolean {
    return this.#stop !== null;
  }

  async start(): Promise<void> {
    if (this.#stop !== null) return;
    this.#stop = await this.#options.listen('phone:command', (payload) => {
      this.#enqueue(payload);
    });
  }

  stop(): void {
    this.#stop?.();
    this.#stop = null;
  }

  /**
   * Run one command, and answer whatever happens.
   *
   * A request that is never answered leaves the phone waiting for the shell's
   * full timeout and then reports something misleading, so a thrown error
   * still produces a reply - the error itself, which is more use than silence.
   */
  #enqueue(command: PhoneCommandEvent): void {
    this.#queue = this.#queue.then(async () => {
      try {
        const response = await this.#options.sink.submit({
          text: command.text,
          conversationId: this.#options.conversationId,
        });

        // The same directive rules as the mail relay: read from the user's own
        // words, never from the model's, and the model's prose scrubbed of
        // anything directive-shaped before the real one is appended.
        const directive = matchPhoneAction(command.text, response.text);
        await this.#options.reply(command.id, composeReply(response.text, directive));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.#options.log('A phone command failed.', reason);
        await this.#options.reply(command.id, reason).catch(() => {});
      }
    });
  }
}
