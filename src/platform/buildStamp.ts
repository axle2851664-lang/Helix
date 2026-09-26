/**
 * When this interface was built.
 *
 * Injected by Vite's `define` at build time. In a dev server it is the moment
 * the server started; in an installed application it is frozen at the moment
 * that installer was produced - which is exactly the distinction that matters,
 * because an installed Helix cannot be changed by pulling source.
 */
declare const __HELIX_BUILT_AT__: string | undefined;

export function builtAt(): Date | null {
  // Guarded: the constant is absent under vitest, which does not run the
  // application's Vite config, and an exception here would take the System
  // screen down over a diagnostic.
  const raw = typeof __HELIX_BUILT_AT__ === 'string' ? __HELIX_BUILT_AT__ : null;
  if (raw === null) return null;

  const when = new Date(raw);
  return Number.isNaN(when.getTime()) ? null : when;
}

/** "today", "yesterday", or a date - whichever makes staleness obvious. */
export function describeBuild(now: Date = new Date()): string {
  const when = builtAt();
  if (when === null) return 'unknown';

  const days = Math.floor((now.getTime() - when.getTime()) / 86_400_000);
  const time = when.toLocaleString();

  if (days < 0) return time;
  if (days === 0) return `${time} (today)`;
  if (days === 1) return `${time} (yesterday)`;
  return `${time} (${days} days ago)`;
}
