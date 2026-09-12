import { useCallback, useEffect, useRef, useState } from 'react';
import { useHelix } from '../HelixProvider.js';
import { toUserMessage } from '../../core/HelixError.js';
import { fileNameFor, noteFor, readIntake, type IntakeItem } from '../../intake/intake.js';

/**
 * Drop or paste anything, from anywhere, anywhere in the window.
 *
 * Deliberately not a button on one screen. The point of "from anywhere" is
 * that you should not have to find the right page first: a file from Explorer,
 * an image dragged out of Chrome, a TikTok link, a paragraph copied from
 * ChatGPT - all of it lands the same way, wherever you happen to be.
 *
 * It lands in one place, an Inbox project, created on first use. Sorting is a
 * thing you can do later; deciding where something goes at the moment you drop
 * it is the friction that stops people dropping things at all.
 *
 * Helix does not open a saved link. Fetching at drag time would be a network
 * request nobody asked for, to a page that may be private to you.
 */

const INBOX = 'Inbox';

export function DropZone() {
  const { projects, knowledge, logger } = useHelix();
  const [over, setOver] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  // Drag events fire for every child element, so a boolean flickers. Counting
  // enter against leave is the standard fix and the only one that is stable.
  const depth = useRef(0);

  const say = useCallback((message: string) => {
    setReport(message);
    window.setTimeout(() => setReport(null), 6000);
  }, []);

  const inboxId = useCallback(async (): Promise<string> => {
    const existing = (await projects.listProjects()).find((project) => project.name === INBOX);
    if (existing) return existing.id;
    return (await projects.createProject(INBOX, 'Things sent to Helix from elsewhere.')).id;
  }, [projects]);

  const take = useCallback(
    async (items: readonly IntakeItem[]) => {
      if (items.length === 0) return;

      const projectId = await inboxId();
      const now = new Date();
      let kept = 0;
      const failures: string[] = [];

      for (const item of items) {
        try {
          if (item.kind === 'file' && item.file) {
            const data = await item.file.arrayBuffer();
            const asset = await projects.addFileToProject({
              projectId,
              file: { name: item.file.name, size: item.file.size, type: item.file.type },
              data,
            });
            // Indexed so it is searchable straight away; a failure to index is
            // not a failure to keep the file, so it is caught separately.
            await knowledge.indexAsset(asset.id).catch((error: unknown) => {
              logger.debug('Kept but could not index.', error);
            });
          } else {
            const body = noteFor(item, now);
            const bytes = new TextEncoder().encode(body);
            const asset = await projects.addFileToProject({
              projectId,
              file: {
                name: fileNameFor(item, now),
                size: bytes.byteLength,
                type: 'text/markdown',
              },
              data: bytes.buffer as ArrayBuffer,
            });
            await knowledge.indexAsset(asset.id).catch(() => undefined);
          }
          kept += 1;
        } catch (error) {
          failures.push(`${item.name}: ${toUserMessage(error)}`);
        }
      }

      // Counted separately so a partial success is reported as one, rather
      // than as everything working or nothing working.
      if (kept > 0 && failures.length === 0) {
        say(`${kept} ${kept === 1 ? 'thing' : 'things'} kept in ${INBOX}.`);
      } else if (kept > 0) {
        say(`${kept} kept in ${INBOX}. ${failures.length} could not be: ${failures[0]}`);
      } else {
        say(failures[0] ?? 'Nothing could be kept.');
      }
    },
    [inboxId, projects, knowledge, logger, say],
  );

  useEffect(() => {
    const onDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer) return;
      depth.current += 1;
      setOver(true);
    };

    const onDragOver = (event: DragEvent) => {
      // Without this the browser navigates to the dropped file, which loses
      // both the drop and whatever was on screen.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };

    const onDragLeave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    };

    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      depth.current = 0;
      setOver(false);
      const transfer = event.dataTransfer;
      if (!transfer) return;

      void take(
        readIntake({
          files: [...transfer.files],
          uriList: transfer.getData('text/uri-list') || undefined,
          text: transfer.getData('text/plain') || undefined,
        }),
      );
    };

    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      // A paste into a text box belongs to that text box. Stealing it would
      // make every input in Helix unusable.
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;

      const clipboard = event.clipboardData;
      if (!clipboard) return;

      const items = readIntake({
        files: [...clipboard.files],
        uriList: clipboard.getData('text/uri-list') || undefined,
        text: clipboard.getData('text/plain') || undefined,
      });
      if (items.length === 0) return;

      event.preventDefault();
      void take(items);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('paste', onPaste);

    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('paste', onPaste);
    };
  }, [take]);

  return (
    <>
      {over && (
        <div className="hx-drop" role="presentation">
          <div className="hx-drop__panel">
            <p className="hx-drop__title">Drop it anywhere</p>
            <p className="hx-drop__detail">
              Files, images, links and text all go to <strong>{INBOX}</strong>.
            </p>
          </div>
        </div>
      )}

      {report && (
        <div className="hx-drop__report" role="status">
          {report}
        </div>
      )}
    </>
  );
}
