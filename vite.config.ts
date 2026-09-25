import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Helix build configuration.
 *
 * `base: './'` is deliberate and load-bearing: Helix must run from a portable
 * drive whose letter can change (E:\Helix -> F:\Helix) and, in a later phase,
 * from inside a Tauri WebView. Absolute asset paths would break both.
 * See docs/PORTABLE.md.
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@platform': fileURLToPath(new URL('./src/platform', import.meta.url)),
      '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
      '@types': fileURLToPath(new URL('./src/types', import.meta.url)),
    },
  },
  server: {
    /**
     * Pinned, and it must stay pinned.
     *
     * `src-tauri/tauri.conf.json` hard-codes `devUrl: http://localhost:5173`.
     * Without `strictPort`, a port already in use makes Vite quietly move to
     * 5174 and say so in one line - and the Tauri window then loads 5173,
     * which is whatever stale dev server is still sitting there. The app
     * opens, looks fine, and serves code from a previous checkout.
     *
     * That cost a long debugging session: a native window showing strings
     * from commits back, while a pull, a rebuild and a restart all reported
     * success. Every symptom pointed at the application and none of it was
     * the application.
     *
     * With `strictPort`, Vite refuses to start instead, and the error names
     * the real problem in the terminal where it can be acted on.
     */
    port: 5173,
    strictPort: true,
    watch: {
      // Vendored assets: multi-megabyte, never hand-edited, and watching them
      // crashes the dev server with EBUSY while the fetch script writes them.
      // Every vendored folder must be listed here - onnx was missed when it
      // was added, and the server died the next time the script ran.
      ignored: [
        '**/public/mediapipe/**',
        '**/public/models/**',
        '**/public/onnx/**',
        '**/public/pdfjs/**',
        // The Rust tree, for the same reason and worse. `target` runs to
        // several gigabytes, and cargo rewrites executables inside it while
        // the dev server is running, so watching it fails with EBUSY and
        // takes the server down in the middle of a build. Tauri watches
        // src-tauri itself; Vite has no business in there at all.
        '**/src-tauri/**',
      ],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
