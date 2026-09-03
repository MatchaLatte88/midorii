import { defineConfig } from 'vite';

/**
 * App server: `npm run dev` (or `npm run app`, which also starts Electron)
 * serves app/renderer/ with Vela imported straight from src/ — the same
 * no-build-step pattern as the Vela playground (see playground/vite.config.ts),
 * just for Midorii's own renderer instead of the OSS demo pages.
 *
 * Port 5300 matches Project_Midori's dev port, which app/electron/main.js
 * still points at. build.outDir lands next to the Electron entry
 * (app/dist/index.html) so main.js's production loadFile() path needs no
 * change either.
 */
export default defineConfig({
    root: 'app/renderer',
    server: { port: 5300, strictPort: true },
    build: { outDir: '../dist', emptyOutDir: true },
});
