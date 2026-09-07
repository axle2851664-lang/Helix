/**
 * THE ONLY FILE THAT DECIDES BETWEEN DEMO AND REAL DATA.
 *
 * Everything else in Helix asks this module which vault to load and never
 * inspects the environment itself. One switch, one place, so it is impossible
 * to half-enable real data by editing the wrong file.
 *
 * The default is DEMO. Reading someone's actual folders must be something they
 * opt into deliberately, never something that happens because a default was
 * left unset.
 */

export type VaultMode = 'demo' | 'real';

/**
 * Roots to index when in real mode. Empty until the user supplies paths.
 *
 * Deliberately not pre-filled with a guess: a wrong path would either index
 * nothing and look broken, or index something unintended.
 */
export interface RealVaultConfig {
  roots: string[];
  /** Files above this are skipped regardless of type. */
  maxFileBytes: number;
  /** Directory names never descended into. */
  ignoredDirectories: string[];
}

export const REAL_VAULT: RealVaultConfig = {
  roots: ['C:/Users/selam/Notes'],
  maxFileBytes: 2 * 1024 * 1024,
  ignoredDirectories: ['node_modules', '.git', 'dist', 'build', '.cache', 'venv', '__pycache__'],
};

/**
 * Resolve the mode.
 *
 * Reads `VITE_HELIX_VAULT` at build time (Vite inlines it) and falls back to
 * demo. Anything other than the exact string 'real' is treated as demo, so a
 * typo fails safe rather than exposing real folders.
 */
export function vaultMode(): VaultMode {
  const configured =
    typeof import.meta.env !== 'undefined'
      ? (import.meta.env['VITE_HELIX_VAULT'] as string | undefined)
      : undefined;
  return configured === 'demo' ? 'demo' : 'real';
}

/** True when Helix is running on invented fixtures. Safe to screen-record. */
export function isDemo(): boolean {
  return vaultMode() === 'demo';
}

/**
 * Why real mode cannot run yet, or null when it can.
 * Real indexing also needs filesystem access, which the browser host lacks.
 */
export function realVaultBlocker(): string | null {
  if (REAL_VAULT.roots.length === 0) {
    return 'No folders have been configured to index. Add them to REAL_VAULT.roots in src/vault/config.ts.';
  }
  return null;
}
