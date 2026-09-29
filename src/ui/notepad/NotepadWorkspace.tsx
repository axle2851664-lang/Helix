import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { useHelix } from '../HelixProvider.js';
import { toUserMessage } from '../../core/HelixError.js';
import type { Note } from '../../notepad/types.js';

/**
 * The Notepad.
 *
 * Two panes: the notes, and the one being read. Deliberately not a third thing
 * to learn - it is a list and an editor, and everything else the brief asks
 * for happens by talking to Helix instead.
 *
 * Three decisions worth stating, because each is the opposite of what an
 * editor usually does:
 *
 * 1. **Saving is explicit.** There is a Save button and it is enabled only
 *    when there is something to save. Autosave would mean Helix writing to the
 *    user's own notes on a timer, which is the one thing the Notepad promises
 *    not to do; it would also silently persist a paste the user was about to
 *    undo.
 *
 * 2. **Deleting asks first, and names the note.** A confirmation that says
 *    "delete this note?" is a formality. This one shows the title, because
 *    nothing brings it back.
 *
 * 3. **A refusal is shown verbatim.** When the manager declines to write
 *    something - a credential, a note past the length ceiling - its own words
 *    go on screen. Rewording a refusal into "something went wrong" is how a
 *    user comes to believe a key was saved.
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
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(() => {
    void notepad.list().then(setNotes);
  }, [notepad]);

  useEffect(() => {
    refresh();
    return notepad.subscribe(refresh);
  }, [refresh, notepad]);

  /**
   * Load the note into the editor.
   *
   * Keyed on the id rather than on the note object: the list refreshes on
   * every change, and re-running this on a new array reference would throw
   * away whatever the user had typed since.
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

  /**
   * A note Helix was asked to open.
   *
   * "Find my note about suppliers" resolves the note in the orchestrator and
   * hands the id here, so the screen opens on the note rather than on the list
   * with the user hunting for it again.
   */
  useEffect(() => {
    if (openNoteId) {
      setSelectedId(openNoteId);
      // The cursor goes to the end, because the instruction that most often
      // brings you here is "add this to my note about ...".
      window.setTimeout(() => {
        const field = bodyRef.current;
        if (!field) return;
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      }, 0);
    }
  }, [openNoteId]);

  const selected = notes.find((note) => note.id === selectedId) ?? null;
  const dirty =
    selected === null
      ? body.trim() !== ''
      : body !== selected.content || title !== selected.title;

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
    } catch (caught) {
      // The manager's own words. A refusal reworded is a refusal not read.
      setError(toUserMessage(caught));
    }
  };

  const remove = async (id: string) => {
    setError(null);
    await notepad.remove(id);
    setConfirmingDelete(null);
    if (selectedId === id) setSelectedId(null);
  };

  const newNote = () => {
    setSelectedId(null);
    setTitle('');
    setBody('');
    setError(null);
    bodyRef.current?.focus();
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
    <div className="hx-page hx-notepad">
      <section className="hx-panel hx-notepad__list">
        <div className="hx-settings__head">
          <h2 className="hx-panel__title">
            {notes.length} {notes.length === 1 ? 'note' : 'notes'}
          </h2>
          <div className="hx-notepad__head-actions">
            <button type="button" className="hx-btn" onClick={newNote}>
              <Icon name="plus" size={15} /> New
            </button>
            {/*
              Closing returns to the core, which is the resting state of the
              whole interface. Without it the only way back is the sidebar,
              and on a narrow screen the sidebar is not there.
            */}
            <button
              type="button"
              className="hx-btn hx-btn--quiet"
              aria-label="Close the Notepad"
              onClick={onClose}
            >
              <Icon name="close" size={15} />
            </button>
          </div>
        </div>

        <input
          className="hx-input hx-input--search"
          value={query}
          placeholder="Filter"
          aria-label="Filter notes"
          onChange={(event) => setQuery(event.target.value)}
        />

        {notes.length === 0 ? (
          <div className="hx-empty">
            <Icon name="notepad" size={26} />
            <p>Nothing written down.</p>
            <p className="hx-muted">
              Write one here, or say &ldquo;write this down&rdquo; on the home screen.
              Helix writes nothing here unless you ask it to.
            </p>
          </div>
        ) : visible.length === 0 ? (
          <p className="hx-muted">Nothing matches &ldquo;{query}&rdquo;.</p>
        ) : (
          <ul className="hx-notelist">
            {visible.map((note) => (
              <li key={note.id}>
                <button
                  type="button"
                  className={`hx-notelist__row${note.id === selectedId ? ' hx-notelist__row--on' : ''}`}
                  onClick={() => setSelectedId(note.id)}
                >
                  <span className="hx-notelist__title">{note.title}</span>
                  <span className="hx-notelist__when">
                    {new Date(note.updatedAt).toLocaleDateString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="hx-panel hx-notepad__editor">
        <input
          className="hx-input hx-notepad__title"
          value={title}
          maxLength={120}
          placeholder="Title (taken from the first line if you leave it empty)"
          aria-label="Note title"
          onChange={(event) => setTitle(event.target.value)}
        />

        <textarea
          ref={bodyRef}
          className="hx-input hx-notepad__body"
          value={body}
          placeholder="Write here."
          aria-label="Note"
          onChange={(event) => setBody(event.target.value)}
        />

        {error && (
          <div className="hx-notice hx-notice--warn hx-field__error" role="alert">
            {error}
          </div>
        )}

        <div className="hx-field__actions">
          <button
            type="button"
            className="hx-btn"
            // Explicit, and only when there is a change to write. Autosave
            // would mean Helix writing to your notes on a timer.
            disabled={!dirty || body.trim() === ''}
            onClick={() => void save()}
          >
            {selected === null ? 'Write it down' : 'Save changes'}
          </button>

          {selected !== null &&
            (confirmingDelete === selected.id ? (
              <>
                <span className="hx-muted">
                  Delete &ldquo;{selected.title}&rdquo;? Nothing brings it back.
                </span>
                <button
                  type="button"
                  className="hx-btn hx-btn--danger"
                  onClick={() => void remove(selected.id)}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="hx-btn hx-btn--quiet"
                  onClick={() => setConfirmingDelete(null)}
                >
                  Keep it
                </button>
              </>
            ) : (
              <button
                type="button"
                className="hx-btn hx-btn--quiet"
                onClick={() => setConfirmingDelete(selected.id)}
              >
                Delete
              </button>
            ))}
        </div>

        <p className="hx-settings__note">
          Notes live in Helix, not on your disk, and nothing here is written unless you
          ask for it. Credentials are refused rather than stored, and they are left out
          of every copy Helix makes.
        </p>
      </section>
    </div>
  );
}
