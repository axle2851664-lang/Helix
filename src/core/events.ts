/**
 * Helix event catalogue (spec 20).
 *
 * Every cross-module signal is declared here with its payload type. Modules
 * communicate through these events rather than importing each other directly,
 * which is what keeps Camera, Spatial, Memory, Storage and the providers
 * independently removable.
 *
 * Adding an event = add a key here. The EventBus is typed off this map, so a
 * typo in an event name or payload is a compile error, not a silent no-op.
 */

export interface StorageWarningPayload {
  /** Fraction of the effective limit currently used, 0..1 */
  usedFraction: number;
  usedBytes: number;
  limitBytes: number;
  severity: 'high' | 'very-high' | 'critical' | 'exhausted';
}

export interface HelixEventMap {
  // --- Lifecycle ---
  'helix:ready': { startedAt: number };
  'helix:shutdown': { reason: string };

  // --- Projects (spec 7) ---
  PROJECT_CREATED: { projectId: string; name: string };
  PROJECT_OPENED: { projectId: string };
  PROJECT_DELETED: { projectId: string };

  // --- 3D generation (spec 14) ---
  MODEL_GENERATION_STARTED: { jobId: string; sourceFile: string };
  MODEL_GENERATION_COMPLETED: { jobId: string; outputPath: string };
  MODEL_GENERATION_FAILED: { jobId: string; reason: string };

  // --- Spatial mode (spec 12) ---
  SPATIAL_OBJECT_SELECTED: { objectId: string | null };
  SPATIAL_OBJECT_MOVED: { objectId: string; position: [number, number, number] };
  SPATIAL_OBJECT_SCALED: { objectId: string; scale: number };
  SPATIAL_OBJECT_ROTATED: { objectId: string; rotation: [number, number, number] };

  // --- Sensors. These exist so the UI indicator (spec 9/10) can never
  //     fall out of sync with actual device state. ---
  CAMERA_STARTED: { deviceId: string | null };
  CAMERA_STOPPED: { reason: string };
  MICROPHONE_STARTED: { deviceId: string | null };
  MICROPHONE_STOPPED: { reason: string };

  // --- Memory (spec 6) ---
  MEMORY_SAVED: { memoryId: string; category: string };
  MEMORY_DELETED: { memoryId: string };

  // --- Models (spec 3) ---
  MODEL_INSTALLED: { modelId: string; sizeBytes: number };
  MODEL_REMOVED: { modelId: string };

  // --- Storage (spec 2) ---
  STORAGE_WARNING: StorageWarningPayload;

  // --- Connectivity (spec 27) ---
  CONNECTIVITY_CHANGED: { mode: 'online' | 'offline' };

  // --- Settings (spec 15) ---
  SETTINGS_CHANGED: { keys: string[] };
  /** Raised when settings can no longer be written to durable storage. */
  SETTINGS_PERSISTENCE_LOST: { reason: string };

  // --- Navigation (spec 3) ---
  WORKSPACE_CHANGED: { workspace: string; previous: string | null };

  // --- Activity. Drives the ACTIVE OPERATION panel, so it must reflect work
  //     that is genuinely happening, never a decorative animation. ---
  ACTIVITY_CHANGED: { kind: string; label: string; detail?: string };

  // --- Knowledge index (spec 12) ---
  KNOWLEDGE_INDEXED: { assetId: string; indexed: boolean };

  // --- Conversations ---
  CONVERSATION_CREATED: { conversationId: string };
  CONVERSATION_OPENED: { conversationId: string };
  CONVERSATION_DELETED: { conversationId: string };
  MESSAGE_APPENDED: { conversationId: string; role: string };
}

export type HelixEventName = keyof HelixEventMap;
