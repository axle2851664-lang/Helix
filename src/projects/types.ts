/**
 * Project and asset shapes (spec 7, 9).
 *
 * Two rules are encoded here rather than left to convention:
 *
 * 1. **Stable ids, not filenames.** Every project and asset carries an id that
 *    never changes. Renaming a project or re-importing a file with the same
 *    name cannot break a reference.
 *
 * 2. **Originals are separate from generated output.** `origin` distinguishes
 *    a file the user imported from anything Helix produced from it, so a failed
 *    or unwanted generation can be removed without touching the source.
 */

export type AssetOrigin = 'original' | 'generated';

export type AssetKind = 'image' | 'model3d' | 'document' | 'data' | 'other';

export interface ProjectAsset {
  id: string;
  projectId: string;
  /** Name as imported, kept for display only. Never used as an identifier. */
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: AssetKind;
  origin: AssetOrigin;
  createdAt: number;
  /** For a generated asset, the id of the asset it was produced from. */
  derivedFrom?: string;
  /** Free-form, e.g. the prompt or provider that produced a generated asset. */
  metadata?: Record<string, unknown>;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  /** Asset id used as the project's thumbnail, when one has been chosen. */
  thumbnailAssetId?: string;
  metadata: Record<string, unknown>;
}

export interface ProjectSummary extends Project {
  assetCount: number;
  originalCount: number;
  generatedCount: number;
  totalBytes: number;
}

/** A project search hit, with why it matched so the UI can explain itself. */
export interface ProjectMatch {
  project: ProjectSummary;
  /** 0..1, higher is a better match. */
  score: number;
  reason: 'exact' | 'prefix' | 'contains' | 'token' | 'description';
}
