import {cloudflare} from '@cloudflare/vite-plugin';
import {defineConfig} from 'vite';

export default defineConfig({
  plugins: [cloudflare()],
  publicDir: 'assets',
  build: {
    // The original index.html and classic scripts are copied verbatim from publicDir.
    // This entry lets Vite build a client alongside the Worker.
    rollupOptions: {input: 'assets/index.html'},
  },
});
