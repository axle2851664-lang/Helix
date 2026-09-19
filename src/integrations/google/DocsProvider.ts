import type { InferenceTransport } from '../../ai/types.js';
import { planDocument, titleFrom, type DocumentPlan } from './docs.js';

/**
 * Google Docs, through the same wall as Gmail.
 *
 * The token never reaches the page: this asks a transport, the shell attaches
 * the credential in Rust, and the browser build refuses outright.
 *
 * Two things this will not do, stated before any of it is written:
 *
 *   - It will not open a document you already have. The scope is `drive.file`,
 *     which covers files Helix created and nothing else. Asked for last year's
 *     report it says it has no access, rather than requesting the scope that
 *     would open every document in the account.
 *
 *   - It will not claim a document exists until Google has said so. The URL is
 *     built from the id Google returns, never from a title or a guess, because
 *     a link that 404s is worse than no link.
 */

export interface CreatedDocument {
  documentId: string;
  title: string;
  /** Where to open it. Built from the id Google returned. */
  url: string;
  /** What was actually written, so a caller can show it. */
  text: string;
}

const NOT_CONNECTED =
  'Google is not connected, so I cannot write a document. Connect an account in Settings.';

export interface DocsProviderOptions {
  transport: InferenceTransport;
  /**
   * The connected account, read at the moment of use.
   *
   * A function rather than a value: OAuth completes after the kernel has been
   * built, so a string captured at construction is null forever and Helix
   * refuses to write documents for an account it is in fact connected to.
   */
  account?: () => string | null | undefined;
}

export class DocsProvider {
  readonly #transport: InferenceTransport;
  readonly #account: () => string | null | undefined;

  constructor(options: DocsProviderOptions) {
    this.#transport = options.transport;
    this.#account = options.account ?? (() => null);
  }

  /** Why a document cannot be written right now, or null when one can. */
  unavailableReason(): string | null {
    const blocked = this.#transport.unavailableReason('google');
    if (blocked !== null) return blocked;
    const account = this.#account();
    if (account === null || account === undefined || account === '') return NOT_CONNECTED;
    return null;
  }

  /**
   * Work out what would be written, without writing it.
   *
   * Separate from `create` so a confirmation can show the real text and the
   * real title. Confirming a document nobody has seen is a formality.
   */
  plan(markdown: string, title?: string): { plan: DocumentPlan; title: string } {
    return {
      plan: planDocument(markdown),
      title: title?.trim() || titleFrom(markdown),
    };
  }

  /**
   * Create a document and write into it.
   *
   * Two requests, in this order, because the Docs API has no way to create a
   * populated document in one call. If the second fails the first has already
   * happened, so the error says the document exists but is empty rather than
   * implying nothing was created - an empty untitled document appearing in
   * somebody's Drive with no explanation is its own small mystery.
   */
  async create(markdown: string, title?: string): Promise<CreatedDocument> {
    const refusal = this.unavailableReason();
    if (refusal !== null) throw new Error(refusal);

    const prepared = this.plan(markdown, title);
    if (prepared.plan.requests.length === 0) {
      throw new Error('There is nothing to write.');
    }

    const created = (await this.#transport.request({
      providerId: 'google',
      path: '/v1/documents',
      body: { title: prepared.title },
    })) as { documentId?: unknown; title?: unknown };

    const documentId = typeof created.documentId === 'string' ? created.documentId : '';
    if (documentId === '') {
      throw new Error('Google created something but did not say what, so I have no link to give you.');
    }

    const url = `https://docs.google.com/document/d/${documentId}/edit`;

    try {
      await this.#transport.request({
        providerId: 'google',
        path: `/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
        body: { requests: prepared.plan.requests },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `The document was created but I could not write into it: ${reason} It is empty, at ${url}`,
      );
    }

    return {
      documentId,
      title: typeof created.title === 'string' && created.title !== '' ? created.title : prepared.title,
      url,
      text: prepared.plan.text,
    };
  }
}
