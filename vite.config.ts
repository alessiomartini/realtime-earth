import { defineConfig } from 'vite';

// The Worker serves everything from one origin: static assets come out of
// `dist/client` via the Wrangler `assets` binding, API and WebSocket routes are
// handled by `worker/index.ts`. During `vite dev` those routes do not exist, so
// use `npm run preview` (build + `wrangler dev`) to exercise the full stack.
export default defineConfig({
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    // Keep the bundle inspectable: the "no secrets in the client bundle"
    // acceptance check greps this output, and a readable build makes the
    // result trustworthy rather than merely green.
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
  },
});
