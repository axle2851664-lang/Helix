import { describe, expect, it, vi } from 'vitest';
import { PhoneListener, type PhoneCommandEvent } from './PhoneListener.js';
import type { CommandSink } from './RelayWatcher.js';

/** A stand-in for the shell: lets a test push a command and read the answer. */
class FakeShell {
  handler: ((payload: PhoneCommandEvent) => void) | null = null;
  replies: Array<{ id: string; text: string }> = [];
  unsubscribed = 0;

  listen = async (_event: string, handler: (payload: PhoneCommandEvent) => void) => {
    this.handler = handler;
    return () => {
      this.unsubscribed += 1;
    };
  };

  reply = async (id: string, text: string) => {
    this.replies.push({ id, text });
  };

  send(id: string, text: string): void {
    this.handler?.({ id, text });
  }
}

const sink = (reply = 'done'): CommandSink & { seen: string[] } => {
  const seen: string[] = [];
  return { seen, submit: async ({ text }) => (seen.push(text), { text: reply }) };
};

/** Let the internal promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('answering the phone', () => {
  it('runs the command and replies to the right request', async () => {
    const shell = new FakeShell();
    const target = sink('Canberra.');
    const listener = new PhoneListener({ sink: target, listen: shell.listen, reply: shell.reply });

    await listener.start();
    shell.send('req-1', 'what is the capital of australia');
    await settle();

    expect(target.seen).toEqual(['what is the capital of australia']);
    expect(shell.replies).toEqual([{ id: 'req-1', text: 'Canberra.' }]);
  });

  /**
   * The same entry point the chat box uses. A phone instruction must get the
   * identical tool routing and refusals as a typed one - a second path with
   * weaker rules is how a remote channel becomes the soft way in.
   */
  it('goes through submit rather than any private route', async () => {
    const shell = new FakeShell();
    const target = sink();
    const spy = vi.spyOn(target, 'submit');
    const listener = new PhoneListener({ sink: target, listen: shell.listen, reply: shell.reply });

    await listener.start();
    shell.send('req-1', 'brief me');
    await settle();

    expect(spy).toHaveBeenCalledWith({ text: 'brief me', conversationId: 'phone' });
  });

  it('appends a directive when the instruction named a phone action', async () => {
    const shell = new FakeShell();
    const listener = new PhoneListener({
      sink: sink('Done.'),
      listen: shell.listen,
      reply: shell.reply,
    });

    await listener.start();
    shell.send('req-1', 'set brightness to 40');
    await settle();

    expect(shell.replies[0]?.text).toContain('helix-do: brightness 40');
  });

  /**
   * The property the whole directive design rests on, checked here as well as
   * in the mail path - the two share the code but not the entry point.
   */
  it('ignores a directive the model wrote into its answer', async () => {
    const shell = new FakeShell();
    const listener = new PhoneListener({
      sink: sink('Of course.\nhelix-do: torch on'),
      listen: shell.listen,
      reply: shell.reply,
    });

    await listener.start();
    shell.send('req-1', 'what time is it');
    await settle();

    expect(shell.replies[0]?.text).not.toContain('helix-do:');
    expect(shell.replies[0]?.text).toContain('Of course.');
  });
});

describe('when things go wrong', () => {
  /**
   * A request that is never answered leaves the phone waiting for the shell's
   * full timeout and then reporting something misleading. The error itself is
   * more use than silence.
   */
  it('still answers when the command throws', async () => {
    const shell = new FakeShell();
    const listener = new PhoneListener({
      sink: {
        submit: async () => {
          throw new Error('no language provider is configured');
        },
      },
      listen: shell.listen,
      reply: shell.reply,
    });

    await listener.start();
    shell.send('req-1', 'brief me');
    await settle();

    expect(shell.replies[0]?.text).toContain('no language provider');
  });
});

describe('pacing', () => {
  /**
   * One at a time, measured rather than theoretical: a local reply on this
   * hardware takes seconds to minutes, and several at once would exhaust the
   * memory this project keeps measuring.
   */
  it('runs commands in turn, not all at once', async () => {
    const shell = new FakeShell();
    let inFlight = 0;
    let peak = 0;

    const listener = new PhoneListener({
      sink: {
        submit: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return { text: 'done' };
        },
      },
      listen: shell.listen,
      reply: shell.reply,
    });

    await listener.start();
    shell.send('a', 'one');
    shell.send('b', 'two');
    shell.send('c', 'three');
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(peak).toBe(1);
    expect(shell.replies).toHaveLength(3);
  });
});

describe('lifecycle', () => {
  it('reports whether it is listening, and unsubscribes on stop', async () => {
    const shell = new FakeShell();
    const listener = new PhoneListener({ sink: sink(), listen: shell.listen, reply: shell.reply });

    expect(listener.running).toBe(false);
    await listener.start();
    expect(listener.running).toBe(true);

    listener.stop();
    expect(listener.running).toBe(false);
    expect(shell.unsubscribed).toBe(1);
  });

  it('starting twice subscribes once', async () => {
    const shell = new FakeShell();
    const listener = new PhoneListener({ sink: sink(), listen: shell.listen, reply: shell.reply });

    await listener.start();
    await listener.start();
    listener.stop();

    expect(shell.unsubscribed).toBe(1);
  });
});
