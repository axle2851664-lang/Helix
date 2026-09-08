import { describe, expect, it, vi } from 'vitest';
import { describePermission } from '../../security/permissions.js';
import { ConsentQueue, actionConsent, permissionConsent } from './ConsentQueue.js';
import type { ActionDefinition } from '../../actions/action.js';

const settled = () => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('the consent queue', () => {
  it('shows one question at a time and keeps the rest waiting', async () => {
    const queue = new ConsentQueue();
    const first = queue.ask(base({ title: 'First' }));
    const second = queue.ask(base({ title: 'Second' }));

    expect(queue.current?.title).toBe('First');
    expect(queue.waiting).toBe(1);

    queue.answer(queue.current!.id, true);
    await expect(first).resolves.toBe(true);
    expect(queue.current?.title).toBe('Second');

    queue.answer(queue.current!.id, false);
    await expect(second).resolves.toBe(false);
    expect(queue.current).toBeNull();
  });

  it('ignores an answer meant for a question that has already gone', async () => {
    const queue = new ConsentQueue();
    const first = queue.ask(base({ title: 'First' }));
    queue.ask(base({ title: 'Second' }));

    const staleId = queue.current!.id;
    queue.answer(staleId, true);
    await expect(first).resolves.toBe(true);

    // The same click landing again must not answer the question now on screen.
    queue.answer(staleId, true);
    expect(queue.current?.title).toBe('Second');
  });

  it('refuses everything outstanding when it closes', async () => {
    const queue = new ConsentQueue();
    const first = queue.ask(base({ title: 'First' }));
    const second = queue.ask(base({ title: 'Second' }));

    queue.close();

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    expect(queue.current).toBeNull();
  });

  it('refuses a question asked after it has closed, rather than hanging', async () => {
    const queue = new ConsentQueue();
    queue.close();
    await expect(queue.ask(base({ title: 'Late' }))).resolves.toBe(false);
  });

  it('tells subscribers when the question changes', async () => {
    const queue = new ConsentQueue();
    const listener = vi.fn();
    queue.subscribe(listener);

    queue.ask(base({ title: 'First' }));
    expect(listener).toHaveBeenCalledTimes(1);

    queue.answer(queue.current!.id, true);
    await settled();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('what the dialog says', () => {
  it('warns that a Helix permission is not the whole decision', () => {
    const request = permissionConsent({
      permission: describePermission('MICROPHONE'),
      reason: 'hear you speaking',
    });

    expect(request.title).toBe('Use your microphone');
    expect(request.reason).toBe('hear you speaking');
    expect(request.note).toContain('not the whole decision');
    expect(request.note).toContain('operating system');
  });

  it('says nothing about a second gate when there is not one', () => {
    const request = permissionConsent({
      permission: describePermission('FILES_READ'),
      reason: 'open your notes',
    });
    expect(request.note).toBeNull();
  });

  it('confirms the specific thing, and says when it cannot be undone', () => {
    const request = actionConsent({
      action: fakeAction,
      description: 'Forget: "The dentist is on Thursday."',
      reversible: false,
    });

    expect(request.detail).toBe('Forget: "The dentist is on Thursday."');
    expect(request.note).toBe('This cannot be undone.');
    expect(request.danger).toBe(true);
    // The button names the act rather than agreeing in the abstract.
    expect(request.allowLabel).toBe('Forget');
  });

  it('does not dress a reversible action up as dangerous', () => {
    const request = actionConsent({
      action: fakeAction,
      description: 'Move notes/tax.md into Archive.',
      reversible: true,
    });
    expect(request.danger).toBe(false);
    expect(request.note).toBeNull();
  });
});

const fakeAction: ActionDefinition = {
  id: 'memory.forget',
  label: 'Forget',
  group: 'memory',
  summary: 'Delete one thing Helix remembers.',
  parameters: {},
  permission: null,
  confirmation: 'destructive',
  reversible: false,
  appliesTo: ['memory'],
  describe: () => 'Forget something.',
  run: async () => ({ message: 'done' }),
};

function base(overrides: { title: string }) {
  return {
    kind: 'action' as const,
    title: overrides.title,
    detail: 'Something will happen.',
    reason: null,
    note: null,
    allowLabel: 'Yes',
    denyLabel: 'No',
    danger: false,
  };
}
