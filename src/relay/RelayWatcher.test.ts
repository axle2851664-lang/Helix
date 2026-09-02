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
