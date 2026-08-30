/**
 * Vision provider interface (spec 10).
 *
 * Helix can capture images today; it cannot interpret them. Analysis requires a
 * vision model, and none is configured. This interface exists so a local model
 * or a cloud provider can be added without touching the camera, the projects
 * system or the UI - and so the absence of one is a reported state rather than
 * a silent failure.
 *
 * The specification is explicit: "Do not pretend computer vision works if no
 * provider is configured." `NullVisionProvider` below is the honest default.
 */

export interface VisionAvailability {
  available: boolean;
  /** Why analysis is unavailable, and what would enable it. */
  reason?: string;
}

/** A region a provider identified within an image. */
export interface DetectedObject {
  label: string;
  /** 0..1. Providers that do not report confidence must send null, not a guess. */
  confidence: number | null;
  /** Normalised 0..1 box, so it survives resizing. */
  box: { x: number; y: number; width: number; height: number } | null;
}

export interface SceneDescription {
  /** Prose description of the image. */
  text: string;
  objects: DetectedObject[];
  /** Which provider and model produced this, for display. Never invented. */
  source: { providerId: string; model: string | null };
}

export interface VisionProvider {
  readonly id: string;
  readonly name: string;
  /** Where the image is processed, for the privacy notice. */
  readonly processing: 'on-device' | 'remote' | 'unknown';

  isAvailable(): VisionAvailability;

  /** Describe an image in prose. */
  describeScene(image: Blob): Promise<SceneDescription>;
  /** Identify objects and, where supported, their regions. */
  detectObjects(image: Blob): Promise<DetectedObject[]>;
  /** Answer a specific question about an image. */
  analyzeImage(image: Blob, question: string): Promise<string>;
}

/**
 * The provider in use when none is configured.
 *
 * Every method refuses with the same explanation rather than returning empty
 * results, because an empty result is indistinguishable from "the image
 * contains nothing" and would read as a working analysis that found nothing.
 */
export class NullVisionProvider implements VisionProvider {
  readonly id = 'none';
  readonly name = 'No vision provider';
  readonly processing = 'unknown' as const;

  static readonly REASON =
    'No vision provider is configured, so images cannot be analysed. A provider is ' +
    'selected in Settings under Vision.';

  isAvailable(): VisionAvailability {
    return { available: false, reason: NullVisionProvider.REASON };
  }

  async describeScene(): Promise<SceneDescription> {
    throw new Error(NullVisionProvider.REASON);
  }

  async detectObjects(): Promise<DetectedObject[]> {
    throw new Error(NullVisionProvider.REASON);
  }

  async analyzeImage(): Promise<string> {
    throw new Error(NullVisionProvider.REASON);
  }
}
