import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { HelixKernel, type KernelServices } from '../core/HelixKernel.js';
import type { HelixSettings, SettingsKey } from '../settings/schema.js';
import { toUserMessage } from '../core/HelixError.js';

/**
 * Binds the kernel's lifetime to the React tree.
 *
 * The kernel is created once and started once, even under StrictMode's
 * deliberate double-invocation in development. Components read services through
 * `useHelix()`; nothing constructs a manager itself, which is what keeps UI and
 * core logic separable (spec 19).
 */

type KernelState =
  | { phase: 'starting' }
  | { phase: 'ready'; services: KernelServices }
  | { phase: 'failed'; message: string };

interface HelixContextValue {
  state: KernelState;
  warnings: readonly string[];
}

const HelixContext = createContext<HelixContextValue | null>(null);

export function HelixProvider({
  children,
  kernel: injected,
}: {
  children: ReactNode;
  kernel?: HelixKernel;
}) {
  // A ref, not state: the kernel must not be recreated by a re-render.
  const kernelRef = useRef<HelixKernel | null>(null);
  if (kernelRef.current === null) {
    kernelRef.current = injected ?? new HelixKernel({ consoleLogging: import.meta.env.DEV });
  }
  const kernel = kernelRef.current;

  const [state, setState] = useState<KernelState>({ phase: 'starting' });
  const [warnings, setWarnings] = useState<readonly string[]>([]);

  useEffect(() => {
    let cancelled = false;

    kernel
      .start()
      .then((services) => {
        if (cancelled) return;
        setWarnings(kernel.warnings);
        setState({ phase: 'ready', services });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ phase: 'failed', message: toUserMessage(error) });
      });

    return () => {
      cancelled = true;
      // Deliberately not shutting down here. StrictMode mounts, unmounts and
      // remounts in development; tearing the kernel down on that unmount would
      // close the database underneath the remount. Shutdown belongs to the
      // application lifecycle (see useHelixShutdown), not to an effect cleanup.
    };
  }, [kernel]);

  const value = useMemo<HelixContextValue>(() => ({ state, warnings }), [state, warnings]);

  return <HelixContext.Provider value={value}>{children}</HelixContext.Provider>;
}

/** Raw kernel state, including the starting and failed phases. */
export function useHelixState(): HelixContextValue {
  const context = useContext(HelixContext);
  if (!context) {
    throw new Error('useHelixState must be used inside <HelixProvider>.');
  }
  return context;
}

/**
 * Services, for components rendered only once the kernel is ready.
 * Throws rather than returning a half-built object, so a component can never
 * silently operate on missing services.
 */
export function useHelix(): KernelServices {
  const { state } = useHelixState();
  if (state.phase !== 'ready') {
    throw new Error('useHelix() used before the Helix kernel was ready.');
  }
  return state.services;
}

/**
 * Subscribe to settings. Re-renders only when one of `keys` changes, or on any
 * change when `keys` is omitted.
 */
export function useSettings(keys?: readonly SettingsKey[]): HelixSettings {
  const { settings } = useHelix();
  const [value, setValue] = useState<HelixSettings>(() => settings.getAll());

  // Callers pass an inline array literal, whose identity changes every render.
  // Depending on that identity would resubscribe endlessly, and because
  // getAll() returns a fresh object each call, every resubscribe would set new
  // state and trigger another render. Collapse to a value-based signature so
  // the effect depends on the *contents* of the key list, not its identity.
  const signature = keys ? [...keys].join(',') : '';

  useEffect(() => {
    const watched = signature === '' ? null : new Set<string>(signature.split(','));

    // Re-read once on (re)subscribe to close the gap between the initial
    // render and this effect running.
    setValue(settings.getAll());

    return settings.subscribe((next, changed) => {
      if (watched && !changed.some((key) => watched.has(key))) return;
      setValue(next);
    });
  }, [settings, signature]);

  return value;
}

/** Flush and release kernel resources when the window is closing (spec 28). */
export function useHelixShutdown(kernel: HelixKernel | null): void {
  useEffect(() => {
    if (!kernel) return;
    const handler = () => {
      void kernel.shutdown('window-closing');
    };
    window.addEventListener('pagehide', handler);
    return () => window.removeEventListener('pagehide', handler);
  }, [kernel]);
}
