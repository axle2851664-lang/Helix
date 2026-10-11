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
      // The workspace package, aliased explicitly rather than left to node
      // resolution. npm links it into node_modules, but its entry point is
      // TypeScript source, and an explicit alias keeps it on Vite's normal
      // transform path instead of its dependency-prebundling path.
      '@hx/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@platform': fileURLToPath(new URL('./src/platform', import.meta.url)),
      '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
      '@types': fileURLToPath(new URL('./src/types', import.meta.url)),
    },
  },
  server: {
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
    // Shared packages are tested by the same run as the application. One
    // command, one count: a package whose tests needed a second invocation
    // would be a package whose tests stop being run.
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.test.tsx',
      'apps/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.tsx',
    ],
  },
});
