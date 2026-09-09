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

/** What happened to one request from the phone. */
export interface PhoneActivity {
  at: number;
  /** The instruction, so setup can show that the right phone got through. */
  text: string;
  outcome: 'answered' | 'failed';
}

export class PhoneListener {
  readonly #options: Required<Omit<PhoneListenerOptions, 'log'>> & {
    log: (message: string, detail?: unknown) => void;
  };
  #stop: (() => void) | null = null;
  /** Commands run in turn rather than at once. */
  #queue: Promise<void> = Promise.resolve();
  readonly #watchers = new Set<(activity: PhoneActivity) => void>();
  #last: PhoneActivity | null = null;

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

  /** The most recent request, or null when none has arrived. */
  get lastActivity(): PhoneActivity | null {
    return this.#last;
  }

  /**
   * Watch requests as they arrive.
   *
   * Setting a phone up is the one time somebody genuinely needs to see that a
   * request landed, because until one does there is no way to tell a working
   * connection from a silent one. Note the limit: a request refused for a bad
   * key or a disallowed address is answered by the shell and never reaches
   * here, so silence still has more than one cause.
   */
  watch(watcher: (activity: PhoneActivity) => void): () => void {
    this.#watchers.add(watcher);
    return () => this.#watchers.delete(watcher);
  }

  #announce(activity: PhoneActivity): void {
    this.#last = activity;
    for (const watcher of [...this.#watchers]) {
      try {
        watcher(activity);
      } catch {
        // A broken watcher must not break the phone connection.
      }
    }
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
        this.#announce({ at: Date.now(), text: command.text, outcome: 'answered' });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.#options.log('A phone command failed.', reason);
        await this.#options.reply(command.id, reason).catch(() => {});
        // Announced either way: a request that arrived and then failed still
        // proves the connection, which is the question being asked at setup.
        this.#announce({ at: Date.now(), text: command.text, outcome: 'failed' });
      }
    });
  }
}
