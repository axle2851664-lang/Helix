import type { GmailProvider } from '../integrations/google/GmailProvider.js';
import { readRelayMessage, type RelayConfig, type RelayVerdict } from './command.js';

/**
 * The loop that makes the phone gesture do something.
 *
 * Polls the relay mailbox, checks each message against `command.ts`, and hands
 * what survives to the orchestrator - the same entry point the chat box uses,
 * so a relayed instruction gets the same tool routing, the same guardrails and
 * the same refusals as a typed one. There is deliberately no separate path
 * with weaker rules for messages that arrive by email.
 *
 * Four properties this has to hold, each of which was easy to get wrong:
 *
 *   - **Every message is marked handled, including rejected ones.** A message
 *     that fails its checks and stays unread is re-examined on every poll
 *     forever. Marking it read is not acting on it.
 *   - **One message at a time.** A local model on a modest machine takes
 *     seconds to minutes per reply; five arriving at once must queue rather
 *     than start five generations and exhaust the memory this project has
 *     spent so long measuring.
 *   - **A poll that fails is not a poll that found nothing.** The network
 *     drops, tokens expire. Errors are reported and the loop continues; they
 *     never look like an empty mailbox.
 *   - **Rejections are logged, never answered.** Replying would turn the
 *     address into an oracle a stranger could probe.
 */

/** What the watcher needs from the orchestrator. Narrow on purpose. */
export interface CommandSink {
  submit(request: { text: string; conversationId: string }): Promise<{ text: string }>;
}

export interface RelayWatcherOptions {
  gmail: Pick<GmailProvider, 'unread' | 'markRead' | 'status'>;
  sink: CommandSink;
  config: () => RelayConfig;
  /** Where relayed turns are recorded. One thread, so context carries over. */
  conversationId?: string;
  /** Seconds between polls. */
  intervalSeconds?: number;
  log?: (message: string, detail?: unknown) => void;
}

export interface PollOutcome {
  /** Messages that passed every check and were run. */
  executed: number;
  /** Messages that failed a check. Marked read, never answered. */
  rejected: number;
  /** Null when the poll succeeded. A reason when it could not run at all. */
  failure: string | null;
}

const DEFAULT_INTERVAL_SECONDS = 30;

export class RelayWatcher {
  readonly #options: Required<Omit<RelayWatcherOptions, 'log'>> & {
    log: (message: string, detail?: unknown) => void;
  };
  #timer: ReturnType<typeof setInterval> | null = null;
  /** True while a poll is in flight, so a slow reply cannot overlap the next. */
  #busy = false;

  constructor(options: RelayWatcherOptions) {
    this.#options = {
      gmail: options.gmail,
      sink: options.sink,
      config: options.config,
      conversationId: options.conversationId ?? 'relay',
      intervalSeconds: options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
      log: options.log ?? (() => {}),
    };
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      void this.poll();
    }, this.#options.intervalSeconds * 1000);
    (this.#timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * One pass over the mailbox.
   *
   * Public so it can be driven directly in a test and triggered by hand from
   * the interface - waiting thirty seconds to find out whether the relay works
   * is a poor way to set it up.
   */
  async poll(): Promise<PollOutcome> {
    if (this.#busy) {
      // Not a failure. The previous poll is still working through a reply,
      // which on this hardware can genuinely take minutes.
      return { executed: 0, rejected: 0, failure: null };
    }

    const config = this.#options.config();
    if (config.ownerAddress.trim() === '' || config.secret === '') {
      return { executed: 0, rejected: 0, failure: 'The relay is not configured.' };
    }

    const status = this.#options.gmail.status();
    if (!status.connected) {
      return { executed: 0, rejected: 0, failure: status.message };
    }

    this.#busy = true;
    try {
      const summary = await this.#options.gmail.unread();
      let executed = 0;
      let rejected = 0;

      // Sequential, deliberately. `for ... of` with await rather than
      // Promise.all: five concurrent local generations would exhaust memory on
      // the machine this runs on.
      for (const message of summary.messages) {
        const verdict = readRelayMessage(
          {
            id: message.id,
            from: message.from,
            subject: message.subject,
            body: message.snippet,
          },
          config,
        );

        if (await this.#handle(verdict)) executed += 1;
        else rejected += 1;

        // Marked read either way. A rejected message left unread is examined
        // again on every poll for the rest of time.
        await this.#options.gmail.markRead([message.id]).catch((error: unknown) => {
          this.#options.log('Could not mark a relay message read.', error);
        });
      }

      return { executed, rejected, failure: null };
    } catch (error) {
      // A failed poll is not an empty mailbox, and must never be reported as
      // one - the difference is between "nothing to do" and "I cannot see".
      const reason = error instanceof Error ? error.message : String(error);
      this.#options.log('Relay poll failed.', reason);
      return { executed: 0, rejected: 0, failure: reason };
    } finally {
      this.#busy = false;
    }
  }

  /** Returns true when the message was executed. */
  async #handle(verdict: RelayVerdict): Promise<boolean> {
    if (!verdict.accepted) {
      // Logged locally, where a forger cannot see it, and never answered.
      this.#options.log('Relay message refused.', {
        reason: verdict.reason,
        detail: verdict.detail,
      });
      return false;
    }

    if (verdict.findings.length > 0) {
      // Reported, not obeyed, and not a reason to refuse: the user may
      // genuinely have forwarded something that reads like an instruction.
      this.#options.log('Relay command contains text aimed at Helix.', {
        kinds: verdict.findings.map((finding) => finding.kind),
      });
    }

    await this.#options.sink.submit({
      text: verdict.command,
      conversationId: this.#options.conversationId,
    });
    return true;
  }
}
