/**
 * PDF text extraction.
 *
 * Kept apart from `extract.ts` for one reason: pdf.js is a megabyte and a half
 * and must not be pulled into the bundle by a text file. It is imported
 * dynamically, so a user who never opens a PDF never downloads the parser.
 *
 * The content policy shapes almost every option below, and each is set
 * deliberately rather than left at its default:
 *
 *   - The worker is resolved through Vite so it is served from this origin.
 *     pdf.js otherwise reaches for a CDN, which connect-src refuses outright,
 *     and the failure then surfaces as an unrelated timeout.
 *   - `useSystemFonts: false` and no standard font data. Those exist to make
 *     a PDF *look* right, and nothing here draws anything.
 *   - Character maps are served from this origin too. Without them a CJK
 *     document extracts as nothing useful, and the default location is remote.
 *
 * The legacy build is used rather than the modern one, and not for the usual
 * reason. The modern build calls `Uint8Array.prototype.toHex`, which is a very
 * recent addition to the language: it throws outright on any engine without
 * it, and the failure arrives as "toHex is not a function" from inside a
 * worker, which is a long way from the file the user just imported. The legacy
 * build is transpiled and asks for nothing exotic. It costs about sixty
 * kilobytes, which is a small price for working on a browser that is a year
 * old.
 *
 * Worth recording, because the opposite was true until recently: pdf.js used
 * to compile embedded font programs with the Function constructor, which
 * script-src would refuse. Version 6 no longer does - checked against the
 * shipped worker, which contains no such call - so there is nothing to switch
 * off and no 'unsafe-eval' to grant.
 *
 * A PDF of scanned pages contains images and no text layer. This will extract
 * nothing from one, and says so specifically rather than reporting a generic
 * failure - "no text layer, this looks like a scan" tells the user their
 * document needs OCR, which is a different problem with a different answer.
 */

/** Enough of the pdf.js surface to type what is used, without depending on it. */
interface TextItem {
  str?: string;
  hasEOL?: boolean;
}

interface PdfPage {
  getTextContent(): Promise<{ items: unknown[] }>;
}

interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
}

/**
 * The loading task owns the worker, not the document.
 *
 * Worth naming explicitly: `destroy` lives here and not on the document
 * proxy, so calling it on the document silently does nothing in JavaScript
 * and throws in TypeScript. The worker stays alive either way, holding the
 * file open.
 */
interface PdfLoadingTask {
  promise: Promise<unknown>;
  destroy(): Promise<void>;
}

export interface PdfExtraction {
  text: string;
  pages: number;
  /** Pages that yielded no text at all. A scan yields none on every page. */
  emptyPages: number;
}

export class PdfExtractionError extends Error {
  constructor(
    message: string,
    /** True when the file is fine but simply has no text to give. */
    readonly noTextLayer: boolean = false,
  ) {
    super(message);
    this.name = 'PdfExtractionError';
  }
}

/**
 * Stop before a pathological document eats the session.
 *
 * A thousand-page PDF is a legitimate thing to own and not something Helix
 * should spend a minute of the user's time on silently. The cap is reported
 * rather than applied quietly.
 */
export const MAX_PAGES = 200;

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let loader: Promise<PdfjsModule> | null = null;

/**
 * Load pdf.js once, and point it at a worker served from this origin.
 *
 * The `?url` import is what makes Vite emit the worker as its own asset and
 * hand back a same-origin path. Without it pdf.js reaches for a CDN, which
 * connect-src refuses, and the failure surfaces as an unrelated timeout.
 *
 * The worker is wired only where there is a page to serve it from. That URL is
 * an HTTP path, and off the browser pdf.js treats it as a filename and looks
 * for it at the root of the drive - which fails with a module-not-found error
 * naming a path nobody wrote. Left unset, pdf.js runs the same worker code
 * in-process instead, which is what makes this testable at all.
 */
async function load(): Promise<PdfjsModule> {
  if (!loader) {
    loader = (async () => {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

      if (typeof document !== 'undefined') {
        const workerUrl = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url').then(
          (module) => module.default,
        );
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      }
      return pdfjs;
    })();
  }
  return loader;
}

/** Where the character maps are served from. Same origin, always. */
function cMapUrl(): string {
  // A URL base must itself be absolute, so resolving against "/" throws.
  // Outside a document there is nothing to resolve against, so hand back the
  // relative path rather than crashing on the way to reading a file.
  if (typeof document === 'undefined') return 'pdfjs/cmaps/';
  return new URL('pdfjs/cmaps/', document.baseURI).href;
}

/**
 * Join the pieces of a page back into readable text.
 *
 * pdf.js returns positioned fragments, not lines - a fragment can be a single
 * word or a single letter. Joining them without regard for the end-of-line
 * flag produces one enormous run-on line, which then chunks badly and reads
 * badly in a search snippet.
 */
function joinItems(items: readonly unknown[]): string {
  let text = '';

  for (const raw of items) {
    const item = raw as TextItem;
    if (typeof item.str !== 'string') continue;

    text += item.str;
    if (item.hasEOL === true) text += '\n';
    else if (!item.str.endsWith(' ')) text += ' ';
  }

  return text;
}

/**
 * Read the text of a PDF.
 *
 * Throws PdfExtractionError with a reason a user can act on. The distinction
 * that matters is `noTextLayer`: a corrupt file and a scanned file both yield
 * nothing, and only one of them is worth trying to fix.
 */
export async function extractPdfText(data: ArrayBuffer): Promise<PdfExtraction> {
  const pdfjs = await load().catch(() => {
    throw new PdfExtractionError('The PDF parser could not be loaded in this build.');
  });

  // Never named `document`: this file tests for the global of that name to
  // decide whether it is in a browser, and shadowing it here would make that
  // check read the wrong thing from anywhere below.
  let task: PdfLoadingTask;
  let pdf: PdfDocument;

  try {
    task = pdfjs.getDocument({
      // A copy, deliberately: pdf.js transfers the buffer to its worker and
      // detaches it. The bytes handed in belong to the asset store, and
      // detaching them would corrupt the next read of the same file.
      data: new Uint8Array(data.slice(0)),
      // See the module note: each of these is set because of the content
      // policy, or because nothing here renders.
      useSystemFonts: false,
      cMapUrl: cMapUrl(),
      cMapPacked: true,
      // Quiet: pdf.js is chatty about fonts it will not need for text.
      verbosity: 0,
    }) as unknown as PdfLoadingTask;

    pdf = (await task.promise) as PdfDocument;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PdfExtractionError(
      message.toLowerCase().includes('password')
        ? 'This PDF is password protected, so its text cannot be read.'
        : 'This file could not be opened as a PDF.',
    );
  }

  try {
    const pages = Math.min(pdf.numPages, MAX_PAGES);
    const parts: string[] = [];
    let emptyPages = 0;

    for (let number = 1; number <= pages; number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = joinItems(content.items).trim();

      if (text === '') emptyPages += 1;
      else parts.push(text);
    }

    const text = parts.join('\n\n').trim();

    if (text === '') {
      throw new PdfExtractionError(
        // Specific on purpose. This is the commonest PDF in an office and the
        // user needs to know it is a scan, not a broken file.
        'This PDF has no text layer - it is most likely scanned pages, which need OCR to read.',
        true,
      );
    }

    return { text, pages: pdf.numPages, emptyPages };
  } finally {
    // Always: the worker holds the file open otherwise, and a session that
    // indexes a folder of PDFs would leak one worker per document.
    await task.destroy().catch(() => undefined);
  }
}
