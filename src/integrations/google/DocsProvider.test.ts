import { describe, expect, it } from 'vitest';
import { DocsProvider } from './DocsProvider.js';
import { ALL_DOCUMENTS_SCOPE, DRIVE_FILE, REQUESTED_SCOPES, scopeParameter } from './scopes.js';
import type { InferenceTransport } from '../../ai/types.js';

function transport(answers: unknown[]) {
  const sent: Array<{ path: string; body: unknown }> = [];
  const queue = [...answers];
  const inference: InferenceTransport = {
    id: 'test',
    unavailableReason: () => null,
    hasCredential: () => true,
    request: async (options) => {
      sent.push({ path: options.path, body: options.body });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next ?? {};
    },
  };
  return { transport: inference, sent };
}

const created = { documentId: 'doc_abc123', title: 'Shopping' };

describe('the scope it asks for', () => {
  it('asks for drive.file, not the key to every document you own', () => {
    // The same guard as the full-mailbox scope, and for the same reason: the
    // wide scope is one line away at every future change.
    expect(scopeParameter()).toContain(DRIVE_FILE.url);
    expect(scopeParameter()).not.toContain(ALL_DOCUMENTS_SCOPE);
    for (const scope of REQUESTED_SCOPES) {
      expect(scope.url).not.toBe(ALL_DOCUMENTS_SCOPE);
    }
  });

  it('says plainly what it cannot do, rather than only what it can', () => {
    expect(DRIVE_FILE.alsoPermits).toContain('Documents you already had are invisible');
  });
});

describe('writing a document', () => {
  it('creates it, then writes into it, in that order', async () => {
    const { transport: t, sent } = transport([created, {}]);
    const result = await new DocsProvider({ transport: t, account: () => 'me@example.com' }).create(
      '# Shopping\n\n- milk\n- bread',
    );

    expect(sent[0]?.path).toBe('/v1/documents');
    expect(sent[0]?.body).toEqual({ title: 'Shopping' });
    expect(sent[1]?.path).toBe('/v1/documents/doc_abc123:batchUpdate');
    expect(result.url).toBe('https://docs.google.com/document/d/doc_abc123/edit');
  });

  it('builds the link from the id Google returned, never from the title', async () => {
    // A link that 404s is worse than no link.
    const { transport: t } = transport([{ documentId: 'other_id', title: 'Shopping' }, {}]);
    const result = await new DocsProvider({ transport: t, account: () => 'me@example.com' }).create('# A');
    expect(result.url).toContain('other_id');
  });

  it('refuses when Google has not said what it made', async () => {
    const { transport: t } = transport([{ title: 'Shopping' }, {}]);
    await expect(
      new DocsProvider({ transport: t, account: () => 'me@example.com' }).create('# A'),
    ).rejects.toThrow(/no link to give you/);
  });

  it('says the document exists but is empty when the writing fails', async () => {
    // Otherwise an empty untitled document appears in somebody's Drive with
    // no explanation, which is its own small mystery.
    const { transport: t } = transport([created, new Error('quota exceeded')]);
    const error = await new DocsProvider({ transport: t, account: () => 'me@example.com' })
      .create('# A')
      .then(() => null)
      .catch((e: unknown) => e as Error);

    expect(error?.message).toContain('created but I could not write into it');
    expect(error?.message).toContain('doc_abc123');
  });

  it('writes nothing when there is nothing to write', async () => {
    const { transport: t, sent } = transport([created, {}]);
    await expect(
      new DocsProvider({ transport: t, account: () => 'me@example.com' }).create('   '),
    ).rejects.toThrow(/nothing to write/);
    expect(sent).toHaveLength(0);
  });

  it('refuses before making any request when Google is not connected', async () => {
    const { transport: t, sent } = transport([created]);
    await expect(new DocsProvider({ transport: t }).create('# A')).rejects.toThrow(
      /not connected/,
    );
    expect(sent).toHaveLength(0);
  });

  it('refuses in a browser, where a token cannot be held', async () => {
    const browser: InferenceTransport = {
      id: 'browser',
      unavailableReason: () => 'This is a web build.',
      hasCredential: () => false,
      request: async () => ({}),
    };
    expect(new DocsProvider({ transport: browser, account: () => 'me@example.com' }).unavailableReason()).toContain(
      'web build',
    );
  });

  it('can show what it would write before writing it', () => {
    const prepared = new DocsProvider({ transport: transport([]).transport }).plan(
      '# Title\n\nSome words.',
    );
    expect(prepared.title).toBe('Title');
    expect(prepared.plan.text).toBe('Title\n\nSome words.\n');
  });
});
