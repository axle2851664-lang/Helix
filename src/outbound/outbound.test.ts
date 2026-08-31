import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIRMATION_TTL_MS,
  OutboundError,
  blockedReason,
  cancel,
  confirm,
  confirmationExpired,
  describe as describeDraft,
  draft,
  looksLikePurchase,
} from './outbound.js';
import { OutboundManager, type Transport } from './OutboundManager.js';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';
import { Logger } from '../core/Logger.js';

const email = (over: Partial<Parameters<typeof draft>[0]> = {}) =>
  draft({
    kind: 'email',
    to: ['marlow@example.com'],
    subject: 'Invoice 204',
    body: 'The balance is due on the 14th.',
    now: 1000,
    ...over,
  });

describe('draft', () => {
  it('creates a draft that has not been confirmed', () => {
    const item = email();

    expect(item.state).toBe('drafted');
    expect(item.to).toEqual(['marlow@example.com']);
  });

  it('refuses a draft with nobody to send to', () => {
    expect(() => email({ to: [] })).toThrow(/nobody to send/);
    expect(() => email({ to: ['   '] })).toThrow(/nobody to send/);
  });

  it('refuses an empty message', () => {
    expect(() => email({ body: '   ' })).toThrow(/nothing to send/);
  });

  /**
   * Sending and spending are different permissions and only one was given.
   * A message that is really a purchase is refused rather than confirmed.
   */
  it('refuses a draft that is really a purchase', () => {
    expect(() => email({ body: 'Please buy the domain for me.' })).toThrow(OutboundError);
    expect(() => email({ body: 'Top up the account with 50.' })).toThrow(/will not do/);
    expect(() => email({ body: 'Transfer £400 to this account.' })).toThrow(/will not do/);
  });

  it('checks the subject as well as the body', () => {
    expect(() => email({ subject: 'Order the parts', body: 'See attached.' })).toThrow(
      /will not do/,
    );
  });

  // Erring towards refusing: a false positive costs one rephrase, a false
  // negative costs money.
  it('leaves an ordinary message alone', () => {
    for (const body of [
      'The balance is due on the 14th.',
      'Can you confirm Tuesday works?',
      'I have attached the revised scope.',
    ]) {
      expect(() => email({ body }), body).not.toThrow();
    }
  });

  it('knows a purchase from a message about one', () => {
    expect(looksLikePurchase('buy the domain')).toBe(true);
    expect(looksLikePurchase('subscribe to the plan')).toBe(true);
    expect(looksLikePurchase('the invoice is attached')).toBe(false);
  });

  /**
   * Unmeasured cost is null, never zero. Reporting zero because nothing
   * measured would turn "never spend" into a rule Helix breaks while
   * believing it is keeping it.
   */
  it('records unmeasured cost as unknown rather than as free', () => {
    expect(email().cost).toBeNull();
    expect(draft({ kind: 'call', to: ['+441234567890'], body: 'Confirm Tuesday.' }).cost).toBeNull();
  });
});

describe('confirmation', () => {
  it('moves a draft to confirmed', () => {
    const confirmed = confirm(email(), 2000);

    expect(confirmed.state).toBe('confirmed');
    expect(confirmed.confirmedAt).toBe(2000);
  });

  it('refuses to confirm the same draft twice', () => {
    const confirmed = confirm(email(), 2000);
    expect(() => confirm(confirmed, 3000)).toThrow(/already been confirmed/);
  });

  // An approval given and forgotten must not fire later against a draft the
  // user has stopped thinking about.
  it('goes stale', () => {
    const confirmed = confirm(email(), 0);

    expect(confirmationExpired(confirmed, CONFIRMATION_TTL_MS - 1)).toBe(false);
    expect(confirmationExpired(confirmed, CONFIRMATION_TTL_MS + 1)).toBe(true);
  });

  it('reports a stale confirmation as the reason it is blocked', () => {
    const confirmed = confirm(email(), 0);
    expect(blockedReason(confirmed, CONFIRMATION_TTL_MS + 1)).toContain('gone stale');
  });

  it('blocks an unconfirmed draft', () => {
    expect(blockedReason(email(), 2000)).toContain('not been confirmed');
  });

  it('allows a fresh confirmation through', () => {
    expect(blockedReason(confirm(email(), 1000), 1500)).toBeNull();
  });

  it('will not cancel something already sent', () => {
    const sent = { ...confirm(email(), 1000), state: 'sent' as const };
    expect(() => cancel(sent)).toThrow(/cannot be unsent/);
  });
});

describe('describe', () => {
  // "Send to 4 people" is exactly the shape of confirmation someone approves
  // without reading.
  it('names every recipient rather than counting them', () => {
    const sentence = describeDraft(email({ to: ['a@example.com', 'b@example.com'] }));

    expect(sentence).toContain('a@example.com');
    expect(sentence).toContain('b@example.com');
    expect(sentence).not.toContain('2 people');
  });

  it('says a call costs money even when the amount is unknown', () => {
    const call = draft({ kind: 'call', to: ['+441234567890'], body: 'Confirm Tuesday.' });
    expect(describeDraft(call)).toContain('nothing here has measured how much');
  });

  it('states a measured cost with where it came from', () => {
    const call = draft({
      kind: 'call',
      to: ['+441234567890'],
      body: 'Confirm Tuesday.',
      cost: { amount: 0.02, currency: '£', basis: 'per minute, from your provider' },
    });

    expect(describeDraft(call)).toContain('£0.02');
    expect(describeDraft(call)).toContain('per minute');
  });

  it('says nothing about cost for an ordinary email', () => {
    expect(describeDraft(email())).not.toContain('costs');
  });
});

describe('OutboundManager', () => {
  let manager: OutboundManager;
  let sent: string[];

  const workingTransport = (): Transport => ({
    kind: 'email',
    name: 'test',
    unavailableReason: () => null,
    send: async (item) => {
      sent.push(item.id);
    },
  });

  const make = (transports: Transport[] = []) =>
    new OutboundManager({
      store: new MemoryKeyValueStore(),
      logger: new Logger('test', { level: 'ERROR', sinks: [] }),
      transports,
    });

  beforeEach(() => {
    sent = [];
    manager = make();
  });

  it('keeps a draft in the outbox', async () => {
    const item = await manager.create({
      kind: 'email',
      to: ['marlow@example.com'],
      body: 'Confirming Tuesday.',
    });

    expect((await manager.pending()).map((entry) => entry.id)).toEqual([item.id]);
  });

  /**
   * The gate. The screen that confirms and the code that sends are far apart,
   * and the whole value of the gate is that it cannot be walked around.
   */
  it('refuses to dispatch a draft that was never confirmed', async () => {
    const withTransport = make([workingTransport()]);
    const item = await withTransport.create({
      kind: 'email',
      to: ['marlow@example.com'],
      body: 'Confirming Tuesday.',
    });

    await expect(withTransport.dispatch(item.id)).rejects.toThrow(/not been confirmed/);
    expect(sent).toEqual([]);
  });

  it('sends once confirmed', async () => {
    const withTransport = make([workingTransport()]);
    const item = await withTransport.create({
      kind: 'email',
      to: ['marlow@example.com'],
      body: 'Confirming Tuesday.',
    });

    await withTransport.confirm(item.id, 1000);
    const result = await withTransport.dispatch(item.id, 1500);

    expect(result.state).toBe('sent');
    expect(sent).toEqual([item.id]);
  });

  it('refuses to send the same draft twice', async () => {
    const withTransport = make([workingTransport()]);
    const item = await withTransport.create({
      kind: 'email',
      to: ['marlow@example.com'],
      body: 'Confirming Tuesday.',
    });

    await withTransport.confirm(item.id, 1000);
    await withTransport.dispatch(item.id, 1100);

    await expect(withTransport.dispatch(item.id, 1200)).rejects.toThrow(/already been sent/);
    expect(sent).toHaveLength(1);
  });

  it('refuses a stale confirmation', async () => {
    const withTransport = make([workingTransport()]);
    const item = await withTransport.create({
      kind: 'email',
      to: ['marlow@example.com'],
      body: 'Confirming Tuesday.',
    });

    await withTransport.confirm(item.id, 0);
    await expect(withTransport.dispatch(item.id, CONFIRMATION_TTL_MS + 1)).rejects.toThrow(
      /gone stale/,
    );
    expect(sent).toEqual([]);
  });

  it('will not send a cancelled draft', async () => {
    const withTransport = make([workingTransport()]);
    const item = await withTransport.create({
      kind: 'email',
      to: ['marlow@example.com'],
      body: 'Confirming Tuesday.',
    });

    await withTransport.confirm(item.id, 1000);
    await withTransport.cancel(item.id, 'changed my mind');

    await expect(withTransport.dispatch(item.id, 1100)).rejects.toThrow(/was cancelled/);
  });

  // Nothing is connected. The draft stays confirmed and waiting, because the
  // draft is fine and the world is not.
  it('says which provider is missing rather than failing vaguely', async () => {
    const item = await manager.create({
      kind: 'email',
      to: ['marlow@example.com'],
      body: 'Confirming Tuesday.',
    });
    await manager.confirm(item.id, 1000);

    await expect(manager.dispatch(item.id, 1100)).rejects.toThrow(/No provider is connected/);
    expect((await manager.get(item.id))?.state).toBe('confirmed');
  });

  it('reports each missing transport separately', async () => {
    expect(manager.transportBlocker('call')).toContain('place a call');
    expect(manager.transportBlocker('email')).toContain('send email');
  });

  it('records a failure with its reason rather than losing it', async () => {
    const breaking: Transport = {
      kind: 'email',
      name: 'broken',
      unavailableReason: () => null,
      send: async () => {
        throw new Error('mailbox full');
      },
    };
    const withTransport = make([breaking]);

    const item = await withTransport.create({
      kind: 'email',
      to: ['marlow@example.com'],
      body: 'Confirming Tuesday.',
    });
    await withTransport.confirm(item.id, 1000);

    await expect(withTransport.dispatch(item.id, 1100)).rejects.toThrow(/mailbox full/);

    const stored = await withTransport.get(item.id);
    expect(stored?.state).toBe('failed');
    expect(stored?.reason).toContain('mailbox full');
  });

  it('refuses a purchase before it ever reaches the outbox', async () => {
    await expect(
      manager.create({ kind: 'email', to: ['a@example.com'], body: 'Please pay the invoice.' }),
    ).rejects.toThrow(/will not do/);

    expect(await manager.list()).toEqual([]);
  });
});
