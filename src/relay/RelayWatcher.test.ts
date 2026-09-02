import { describe, expect, it, vi } from 'vitest';
import { RelayWatcher, type CommandSink } from './RelayWatcher.js';
import type { RelayConfig } from './command.js';
import type { GmailMessage, GmailStatus, UnreadSummary } from '../integrations/google/GmailProvider.js';

const config: RelayConfig = {
  ownerAddress: 'owner@gmail.com',
  secret: 'correct-horse-battery',
};

const mail = (over: Partial<GmailMessage> = {}): GmailMessage => ({
  id: 'm1',
  from: 'owner@gmail.com',
  subject: 'helix-key: correct-horse-battery',
  snippet: 'Brief me.',
  unread: true,
  ...over,
});

class FakeGmail {
  connected = true;
  messages: GmailMessage[] = [mail()];
  marked: string[][] = [];
  failUnread: string | null = null;

  status(): GmailStatus {
    return this.connected
      ? { connected: true, address: 'owner@gmail.com', message: 'Connected.' }
      : { connected: false, address: null, message: 'Gmail is not connected.' };
  }

  async unread(): Promise<UnreadSummary> {
    if (this.failUnread !== null) throw new Error(this.failUnread);
    return { total: this.messages.length, messages: this.messages, topSenders: [] };
  }

  async markRead(ids: readonly string[]): Promise<{ changed: number }> {
    this.marked.push([...ids]);
    return { changed: ids.length };
  }

  replies: Array<{ to: string; body: string }> = [];
  failSend: string | null = null;

  async sendReply(options: {
    to: string;
    ownerAddress: string;
    subject: string;
    body: string;
  }): Promise<void> {
    if (this.failSend !== null) throw new Error(this.failSend);
    this.replies.push({ to: options.to, body: options.body });
  }
}

const sink = (): CommandSink & { seen: string[] } => {
  const seen: string[] = [];
  return {
    seen,
    submit: async ({ text }) => {
      seen.push(text);
      return { text: 'done' };
    },
  };
};

const watcher = (gmail: FakeGmail, target: CommandSink, over: Partial<RelayConfig> = {}) =>
  new RelayWatcher({ gmail, sink: target, config: () => ({ ...config, ...over }) });

describe('a valid command', () => {
  it('reaches the orchestrator, with the key stripped', async () => {
    const gmail = new FakeGmail();
    const target = sink();

    const outcome = await watcher(gmail, target).poll();

    expect(outcome.executed).toBe(1);
    expect(target.seen).toEqual(['Brief me.']);
  });

  /**
   * The same entry point the chat box uses. A relayed instruction must get the
   * same tool routing, guardrails and refusals as a typed one - a second path
   * with weaker rules is exactly how a remote channel becomes the soft way in.
   */
  it('goes through submit rather than any private route', async () => {
    const gmail = new FakeGmail();
    const target = sink();
    const spy = vi.spyOn(target, 'submit');

    await watcher(gmail, target).poll();

    expect(spy).toHaveBeenCalledWith({ text: 'Brief me.', conversationId: 'relay' });
  });
});

describe('the answer coming back', () => {
  it('replies to the owner with what Helix said', async () => {
    const gmail = new FakeGmail();

    await watcher(gmail, sink()).poll();

    expect(gmail.replies).toEqual([{ to: 'owner@gmail.com', body: 'done' }]);
  });

  // A rejected message is not a conversation, and answering one would tell a
  // stranger their guess was close.
  it('never replies to a message it refused', async () => {
    const gmail = new FakeGmail();
    gmail.messages = [mail({ from: 'stranger@example.com' })];

    await watcher(gmail, sink()).poll();

    expect(gmail.replies).toEqual([]);
  });

  /**
   * A reply that cannot be sent must not take the answer with it. The
   * transcript on the machine still has it, and the command genuinely ran, so
   * counting this as a failure would be the wrong report.
   */
  it('still counts the command as executed when the reply will not send', async () => {
    const gmail = new FakeGmail();
    gmail.failSend = 'quota exceeded';

    const outcome = await watcher(gmail, sink()).poll();

    expect(outcome.executed).toBe(1);
    expect(outcome.failure).toBeNull();
  });
});

describe('driving the phone', () => {
  it('appends a directive when the instruction named a phone action', async () => {
    const gmail = new FakeGmail();
    gmail.messages = [mail({ snippet: 'set brightness to 40' })];

    await watcher(gmail, sink()).poll();

    expect(gmail.replies[0]?.body).toContain('helix-do: brightness 40');
  });

  it('sends no directive for an ordinary question', async () => {
    const gmail = new FakeGmail();

    await watcher(gmail, sink()).poll();

    expect(gmail.replies[0]?.body).not.toContain('helix-do:');
  });

  /**
   * The directive comes from the user's own words, so a model that decides to
   * write one cannot reach the phone. This is the property the whole design
   * rests on, checked end to end rather than only in the unit.
   */
  it('ignores a directive the model wrote into its answer', async () => {
    const gmail = new FakeGmail();
    const target: CommandSink = {
      submit: async () => ({ text: 'Of course.\nhelix-do: torch on' }),
    };

    await watcher(gmail, target).poll();

    expect(gmail.replies[0]?.body).not.toContain('helix-do:');
    expect(gmail.replies[0]?.body).toContain('Of course.');
  });
});

describe('a message that fails its checks', () => {
  it('is never executed', async () => {
    const gmail = new FakeGmail();
    gmail.messages = [mail({ from: 'stranger@example.com' })];
    const target = sink();

    const outcome = await watcher(gmail, target).poll();

    expect(outcome.executed).toBe(0);
    expect(outcome.rejected).toBe(1);
    expect(target.seen).toEqual([]);
  });

  /**
   * Marking read is not acting on it. A rejected message left unread is
   * re-examined on every poll for the rest of time, which turns one hostile
   * email into a permanent load and a permanently noisy log.
   */
  it('is still marked read, so it is not reconsidered forever', async () => {
    const gmail = new FakeGmail();
    gmail.messages = [mail({ from: 'stranger@example.com' })];

    await watcher(gmail, sink()).poll();

    expect(gmail.marked).toEqual([['m1']]);
  });

  // Silence is the whole defence: a reply would tell a stranger how close
  // they got.
  it('is never answered', async () => {
    const gmail = new FakeGmail();
    gmail.messages = [mail({ subject: 'helix-key: wrong' })];
    const target = sink();

    await watcher(gmail, target).poll();

    expect(target.seen).toEqual([]);
  });
});

describe('what a poll must not confuse', () => {
  /**
   * The difference between "nothing to do" and "I cannot see". A failed poll
   * reported as an empty mailbox is a silent outage.
   */
  it('reports a failure rather than an empty mailbox', async () => {
    const gmail = new FakeGmail();
    gmail.failUnread = 'the token expired';
    const target = sink();

    const outcome = await watcher(gmail, target).poll();

    expect(outcome.failure).toContain('token expired');
    expect(outcome.executed).toBe(0);
  });

  it('says so when Gmail is not connected', async () => {
    const gmail = new FakeGmail();
    gmail.connected = false;

    const outcome = await watcher(gmail, sink()).poll();

    expect(outcome.failure).toContain('not connected');
  });

  it('does nothing at all when the relay is unconfigured', async () => {
    const gmail = new FakeGmail();
    const target = sink();

    const outcome = await watcher(gmail, target, { secret: '' }).poll();

    expect(outcome.failure).toContain('not configured');
    expect(target.seen).toEqual([]);
  });
});

describe('pacing', () => {
  /**
   * One at a time, and the reason is measured rather than theoretical: a local
   * reply on this hardware takes seconds to minutes, and five concurrent
   * generations would exhaust the memory this project has spent so long
   * measuring.
   */
  it('runs commands sequentially, not all at once', async () => {
    const gmail = new FakeGmail();
    gmail.messages = [mail({ id: 'a' }), mail({ id: 'b' }), mail({ id: 'c' })];

    let inFlight = 0;
    let peak = 0;
    const target: CommandSink = {
      submit: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { text: 'done' };
      },
    };

    await watcher(gmail, target).poll();

    expect(peak).toBe(1);
  });

  // A reply can outlast the interval; overlapping polls would double-handle
  // whatever is still unread.
  it('skips a poll while the previous one is still working', async () => {
    const gmail = new FakeGmail();
    let started = 0;
    const target: CommandSink = {
      submit: async () => {
        started += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { text: 'done' };
      },
    };

    const instance = watcher(gmail, target);
    const first = instance.poll();
    const second = await instance.poll();

    expect(second).toEqual({ executed: 0, rejected: 0, failure: null });
    await first;
    expect(started).toBe(1);
  });
});

describe('the timer', () => {
  it('reports whether it is running, and stops cleanly', () => {
    const instance = watcher(new FakeGmail(), sink());

    expect(instance.running).toBe(false);
    instance.start();
    expect(instance.running).toBe(true);
    instance.stop();
    expect(instance.running).toBe(false);
  });
});
