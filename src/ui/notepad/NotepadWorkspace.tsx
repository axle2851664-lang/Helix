import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { useHelix } from '../HelixProvider.js';
import { toUserMessage } from '../../core/HelixError.js';
import type { Note } from '../../notepad/types.js';

/**
 * The Notepad: a page, not a file browser.
 *
 * WHY THIS IS NOT TWO PANES. The first version was a list beside an editor,
 * which is the shape of every file manager ever written - and that was the
 * problem. The Notepad kept being mistaken for Files because it was built like
 * Files. Two things with different rules should not look the same, and the
 * layout is the loudest statement a screen makes about what it is.
 *
 * So there is one note on screen and nothing else: a title, a body, and the
 * room around them. Opening the Notepad puts the cursor in the page, because
 * the reason to come here is to write. Files is a search box over things you
 * brought to Helix; this is a page you are writing on. They now read as
 * different activities at a glance, which is the point.
 *
 * WHERE THE OTHER NOTES WENT. Into a switcher that is summoned and dismissed,
 * rather than a column that is always there. A permanent list is a permanent
 * dashboard, which the rest of this interface has just finished removing, and
 * it spends a third of the screen on navigation for a collection that is
 * usually under twenty items.
 *
 * Three rules from the first version survive unchanged, because they were
 * never about layout:
 *
 * 1. **Saving is explicit.** Autosave would mean Helix writing to your own
 *    notes on a timer, which is the one thing the Notepad promises not to do.
 *    The control appears only when there is a change to write.
 * 2. **Deleting asks, and names the note.** Nothing brings it back.
 * 3. **A refusal is shown verbatim.** When the manager declines to write
 *    something - a credential, a note past the ceiling - its own words go on
 *    screen. Rewording a refusal into "something went wrong" is how a user
 *    comes to believe a key was saved.
 */
export function NotepadWorkspace({
  openNoteId,
  onClose,
}: {
  openNoteId: string | null;
  /** Back to the core. The Notepad is somewhere you go and then leave. */
  onClose: () => void;
}) {
  const { notepad } = useHelix();

  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saved, setSaved] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(() => {
    void notepad.list().then(setNotes);
  }, [notepad]);

  useEffect(() => {
    refresh();
    return notepad.subscribe(refresh);
  }, [refresh, notepad]);

  /**
   * Load the note into the page.
   *
   * Keyed on the id rather than on the note object: the list refreshes on
   * every change, and re-running this on a new array reference would throw
   * away whatever had been typed since.
   */
  useEffect(() => {
    if (selectedId === null) {
      setTitle('');
      setBody('');
      return;
    }
    void notepad.get(selectedId).then((note) => {
      if (!note) return;
      setTitle(note.title);
      setBody(note.content);
    });
  }, [selectedId, notepad]);

  /** Straight into writing. The reason to open the Notepad is to write. */
  useEffect(() => {
    bodyRef.current?.focus();
  }, []);

  /**
   * A note Helix was asked to open.
   *
   * "Find my note about suppliers" resolves it in the orchestrator and hands
   * the id here, so the page opens on that note rather than on a list with the
   * user hunting for it again. The cursor goes to the end, because the
   * instruction that most often brings you here is "add this to my note
   * about ...".
   */
  useEffect(() => {
    if (!openNoteId) return;
    setSelectedId(openNoteId);
    window.setTimeout(() => {
      const field = bodyRef.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }, 0);
  }, [openNoteId]);

  const selected = notes.find((note) => note.id === selectedId) ?? null;
  const dirty =
    selected === null ? body.trim() !== '' : body !== selected.content || title !== selected.title;

  // Clears itself, so the page does not keep a stale "Saved" next to text that
  // has since changed.
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 2200);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const save = async () => {
    setError(null);
    try {
      if (selected === null) {
        const created = await notepad.save({
          content: body,
          ...(title.trim() === '' ? {} : { title }),
        });
        setSelectedId(created.id);
      } else {
        await notepad.update(selected.id, { content: body, title });
      }
      setSaved(true);
    } catch (caught) {
      // The manager's own words. A refusal reworded is a refusal not read.
      setError(toUserMessage(caught));
    }
  };

  const openNote = (id: string) => {
    setSelectedId(id);
    setSwitcherOpen(false);
    setQuery('');
    setError(null);
    setConfirmingDelete(false);
    window.setTimeout(() => bodyRef.current?.focus(), 0);
  };

  const newNote = () => {
    setSelectedId(null);
    setTitle('');
    setBody('');
    setError(null);
    setConfirmingDelete(false);
    setSwitcherOpen(false);
    window.setTimeout(() => bodyRef.current?.focus(), 0);
  };

  const remove = async () => {
    if (selected === null) return;
    await notepad.remove(selected.id);
    setConfirmingDelete(false);
    newNote();
  };

  /**
   * Ctrl/Cmd-S saves, Escape closes whatever is open.
   *
   * On a page you write on, reaching for the mouse to save is the friction
   * that makes people want autosave - which is the thing that must not
   * happen here. Escape closes the switcher first and the Notepad second,
   * so it never dismisses more than the user expected.
   */
  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (dirty && body.trim() !== '') void save();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (switcherOpen) setSwitcherOpen(false);
      else if (confirmingDelete) setConfirmingDelete(false);
      else onClose();
    }
  };

  const needle = query.trim().toLowerCase();
  const visible =
    needle === ''
      ? notes
      : notes.filter(
          (note) =>
            note.title.toLowerCase().includes(needle) ||
            note.content.toLowerCase().includes(needle) ||
            note.tags.some((tag) => tag.includes(needle)),
        );

  return (
    // The keyboard handler sits on the region rather than on the textarea, so
    // Escape works from the title and the switcher too.
    <div className="hx-pad" onKeyDown={onKeyDown}>
      {/* A thin row of verbs. Not a toolbar - there are four things you can
          do here and they are all one word. */}
      <div className="hx-pad__bar">
        <button type="button" className="hx-pad__verb" onClick={onClose}>
          <Icon name="close" size={13} /> Close
        </button>

        <button
          type="button"
          className="hx-pad__verb"
          onClick={() => setSwitcherOpen((open) => !open)}
          aria-expanded={switcherOpen}
        >
          <Icon name="notepad" size={13} />{' '}
          {notes.length === 0
            ? 'No notes yet'
            : `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`}
        </button>

        <button type="button" className="hx-pad__verb" onClick={newNote}>
          <Icon name="plus" size={13} /> New
        </button>

        <span className="hx-pad__spacer" />

        {selected !== null && !confirmingDelete && (
          <button
            type="button"
            className="hx-pad__verb hx-pad__verb--quiet"
            onClick={() => setConfirmingDelete(true)}
          >
            Delete
          </button>
        )}

        {/* Appears only when there is a change to write. A permanently lit
            Save button says nothing about whether anything is unsaved. */}
        {dirty && body.trim() !== '' && (
          <button type="button" className="hx-pad__verb hx-pad__verb--on" onClick={() => void save()}>
            Save
          </button>
        )}
        {!dirty && saved && (
          <span className="hx-pad__state" role="status">
            Saved
          </span>
        )}
      </div>

      {confirmingDelete && selected !== null && (
        <div className="hx-pad__confirm" role="alert">
          <span>
            Delete &ldquo;{selected.title}&rdquo;? Nothing brings it back.
          </span>
          <button type="button" className="hx-btn hx-btn--danger" onClick={() => void remove()}>
            Delete
          </button>
          <button
            type="button"
            className="hx-btn hx-btn--quiet"
            onClick={() => setConfirmingDelete(false)}
          >
            Keep it
          </button>
        </div>
      )}

      {error && (
        <div className="hx-notice hx-notice--warn hx-pad__error" role="alert">
          {error}
        </div>
      )}

      {/* The page. One note, and the room around it. */}
      <div className="hx-pad__page">
        <input
          className="hx-pad__title"
          value={title}
          maxLength={120}
          placeholder="Untitled"
          aria-label="Note title"
          onChange={(event) => setTitle(event.target.value)}
        />
        <textarea
          ref={bodyRef}
          className="hx-pad__body"
          value={body}
          placeholder="Write."
          aria-label="Note"
          onChange={(event) => setBody(event.target.value)}
        />
      </div>

      <p className="hx-pad__foot">
        Notes live in Helix, not on your disk, and nothing is written here unless you ask.
        Files you imported are in Files; a vault of markdown on your disk is in Graph.
        Credentials are refused rather than stored.
      </p>

      {switcherOpen && (
        <NoteSwitcher
          notes={visible}
          total={notes.length}
          query={query}
          selectedId={selectedId}
          onQuery={setQuery}
          onPick={openNote}
          onDismiss={() => setSwitcherOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * The other notes, summoned and dismissed.
 *
 * An overlay rather than a column, because a list that is always on screen is
 * a permanent dashboard - and because a collection of twenty items does not
 * deserve a third of the width for the whole time you are writing.
 */
function NoteSwitcher({
  notes,
  total,
  query,
  selectedId,
  onQuery,
  onPick,
  onDismiss,
}: {
  notes: readonly Note[];
  total: number;
  query: string;
  selectedId: string | null;
  onQuery: (value: string) => void;
  onPick: (id: string) => void;
  onDismiss: () => void;
}) {
  const filterRef = useRef<HTMLInputElement>(null);
  useEffect(() => filterRef.current?.focus(), []);

  return (
    <>
      {/* Clicking away dismisses. Nothing here changes anything, so leaving
          it costs nothing and needs no confirmation. */}
      <button
        type="button"
        className="hx-pad__scrim"
        aria-label="Close the note list"
        onClick={onDismiss}
      />
      <div className="hx-pad__switcher" role="dialog" aria-label="Your notes">
        <input
          ref={filterRef}
          className="hx-pad__filter"
          value={query}
          placeholder={total === 0 ? 'Nothing written down yet' : 'Filter'}
          aria-label="Filter notes"
          onChange={(event) => onQuery(event.target.value)}
        />

        {total === 0 ? (
          <p className="hx-pad__empty">
            Nothing written down. Write here, or say &ldquo;write this down&rdquo; on the
            home screen.
          </p>
        ) : notes.length === 0 ? (
          <p className="hx-pad__empty">Nothing matches &ldquo;{query}&rdquo;.</p>
        ) : (
          <ul className="hx-pad__list">
            {notes.map((note) => (
              <li key={note.id}>
                <button
                  type="button"
                  className={`hx-pad__row${note.id === selectedId ? ' hx-pad__row--on' : ''}`}
                  onClick={() => onPick(note.id)}
                >
                  <span className="hx-pad__row-title">{note.title}</span>
                  <span className="hx-pad__row-when">
                    {new Date(note.updatedAt).toLocaleDateString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
