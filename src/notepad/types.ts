/**
 * The Notepad: Havoc's own notes.
 *
 * WHAT THIS IS NOT. It is not a view onto files on the disk. Havoc has a
 * separate thing for those - projects, assets and the knowledge index - and
 * conflating the two would mean a note the user wrote living in the same place
 * as a PDF they imported, with the same rules about indexing, extraction and
 * deletion. These are Havoc's own notes, in Havoc's own storage, and they
 * exist whether or not there is a filesystem underneath.
 *
 * WHY IT IS NOT MEMORY EITHER. Long-term memory is a set of short statements
 * Havoc has been told to hold about the user - "I take my coffee black", "my
 * sister is called Ada" - and it is consulted on every turn. A note is a
 * document: a title, a body of any length, written to be read again later.
 * Storing notes as memories would flood every reply's context with paragraphs
 * nobody asked for, and storing memories as notes would lose the thing memory
 * is for. They are separate namespaces with separate rules, in the same way
 * and for the same reason that conversation memory and project memory are.
 *
 * WHAT THEY SHARE is the rule that matters most: nothing is written unless the
 * user asks for it. There is no code path that turns a conversation into a
 * note. Havoc does not keep a journal of what you said.
 */

export const NOTE_CATEGORIES = ['note', 'idea', 'list', 'plan', 'reference', 'other'] as const;

export type NoteCategory = (typeof NOTE_CATEGORIES)[number];

/**
 * How a note came to exist.
 *
 * There is no 'inferred'. A note Havoc decided to write on its own is exactly
 * what this module exists to make impossible, and leaving the value out of the
 * type is a stronger statement than a comment saying not to use it.
 */
export type NoteSource = 'user-explicit' | 'imported';

export interface Note {
  id: string;
  /** A line, for the list. Derived from the body when the user gives none. */
  title: string;
  content: string;
  category: NoteCategory;
  source: NoteSource;
  createdAt: number;
  updatedAt: number;
  /** Free-form user tags, lowercased. */
  tags: string[];
}

export interface NoteSaveRequest {
  content: string;
  title?: string;
  category?: NoteCategory;
  tags?: string[];
  source?: NoteSource;
}

export interface NoteMatch {
  note: Note;
  /** 0..1, higher is better. */
  score: number;
  reason: 'title' | 'exact' | 'phrase' | 'token' | 'tag';
  /**
   * The line the match was found on, so the user can see why a note came back
   * without opening it. Never invented: it is a substring of the note.
   */
  excerpt: string;
}
