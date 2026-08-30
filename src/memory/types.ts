/**
 * Memory record shapes (spec 6, 10).
 *
 * Helix keeps four separate memory systems. They are distinct types and
 * distinct storage namespaces, not one bucket with a flag, because the rules
 * differ:
 *
 * - **Short-term conversation memory** lives in ConversationStore. It is
 *   session context and is never promoted here automatically.
 * - **Long-term memory** is what this module stores, and only when the user
 *   explicitly asks.
 * - **Project memory** is long-term memory scoped to one project, so deleting
 *   the project takes its memories with it.
 * - **Preferences** are settings, not memories, and live in SettingsManager.
 */

export const MEMORY_CATEGORIES = [
  'fact',
  'preference',
  'person',
  'project',
  'instruction',
  'other',
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** How a memory came to exist. Nothing may be stored as 'inferred' today. */
export type MemorySource = 'user-explicit' | 'imported';

export interface MemoryRecord {
  id: string;
  content: string;
  category: MemoryCategory;
  source: MemorySource;
  /**
   * 0..1. Only user-stated memories exist right now, so this is 1 for them.
   * The field exists so a future inferred memory can be stored at lower
   * confidence and surfaced differently, rather than being indistinguishable.
   */
  confidence: number;
  createdAt: number;
  updatedAt: number;
  /** Updated when a search returns this record, for "least recently used". */
  lastAccessedAt: number;
  /** Set when the memory belongs to a project (spec 10: project memory). */
  projectId?: string;
  /** Free-form user tags, lowercased. */
  tags?: string[];
}

export interface MemoryMatch {
  memory: MemoryRecord;
  /** 0..1, higher is better. */
  score: number;
  reason: 'exact' | 'phrase' | 'token' | 'tag';
}

export interface MemorySaveRequest {
  content: string;
  category?: MemoryCategory;
  projectId?: string;
  tags?: string[];
  source?: MemorySource;
}
