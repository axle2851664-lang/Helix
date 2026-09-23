import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = import.meta.dirname;

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    alias: [{ find: /^.*HelixProvider\.js$/, replacement: `${here}/stubProvider.tsx` }],
  },
});
