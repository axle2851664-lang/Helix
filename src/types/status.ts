/** Helix identity/status states (spec 25). */
export const HELIX_STATES = [
  'IDLE',
  'LISTENING',
  'THINKING',
  'SPEAKING',
  'PROCESSING',
  'ERROR',
] as const;

export type HelixStatus = (typeof HELIX_STATES)[number];

/** Connectivity posture shown in the status bar (spec 27). */
export type ConnectivityMode = 'ONLINE' | 'OFFLINE' | 'HYBRID';
