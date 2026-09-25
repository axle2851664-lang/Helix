import { createRoot } from 'react-dom/client';

// A fake Tauri bridge, installed before the workspace loads so tauriInvoke()
// finds it. The shell is the one thing the harness cannot supply for real.
const written: unknown[] = [];
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (command: string, args: unknown) => {
    if (command === 'portable_drives') {
      return [
        { name: 'KINGSTON', mountPoint: 'E:\\', freeBytes: 14_000_000_000, totalBytes: 16_000_000_000, hasHelix: false },
        { name: 'SANDISK', mountPoint: 'F:\\', freeBytes: 900_000, totalBytes: 2_000_000_000, hasHelix: true },
      ];
    }
    if (command === 'portable_write') {
      written.push(args);
      return { folder: 'E:\\Helix', bytesWritten: 48_000_000 };
    }
    return null;
  },
};
(window as unknown as Record<string, unknown>).written = written;

const { PortableWorkspace } = await import('../src/ui/portable/PortableWorkspace.js');
createRoot(document.getElementById('root')!).render(<PortableWorkspace />);
