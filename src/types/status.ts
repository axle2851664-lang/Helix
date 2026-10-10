/** Havoc identity/status states (spec 25). */
export const HAVOC_STATES = [
  'IDLE',
  'LISTENING',
  'THINKING',
  'SPEAKING',
  'PROCESSING',
  'ERROR',
] as const;

export type HavocStatus = (typeof HAVOC_STATES)[number];

/** Connectivity posture shown in the status bar (spec 27). */
export type ConnectivityMode = 'ONLINE' | 'OFFLINE' | 'HYBRID';
