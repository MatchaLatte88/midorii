import { readFileSync } from 'node:fs';

import { defineConfig } from 'vite';

/** The one version number: package.json, stamped into the renderer at build time. */
const { version } = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

/**
 * App server: `npm run dev` (or `npm run app`, which also starts Electron)
 * serves app/renderer/ with Vela imported straight from src/ — the same
 * no-build-step pattern as the Vela playground (see playground/vite.config.ts),
 * just for Midorii's own renderer instead of the OSS demo pages.
 *
 * Port 5301 deliberately avoids Project_Midori's 5300: both launchers reuse a
 * dev server that is already up on their port, so sharing one meant whichever
 * project started first served the other one's renderer. build.outDir lands
 * next to the Electron entry (app/dist/index.html) so main.js's production
 * loadFile() path needs no change.
 *
 * The renderer imports two files from outside its own root — src/ for Vela and
 * CHANGELOG.md for the release notes — so the dev server is allowed to read the
 * repo root. Nothing above it is served.
 */
export default defineConfig({
    root: 'app/renderer',
    define: { __APP_VERSION__: JSON.stringify(version) },
    server: {
        port: 5301,
        strictPort: true,
        fs: { allow: ['..', '../..'] },
    },
    build: { outDir: '../dist', emptyOutDir: true },
});
