import type { BottombarBrand } from '../../../src/widget';
import { openChangelog } from './changelogDialog';

/**
 * The application's mark in the bottom-left of every window it opens: the name,
 * the version it is running, and the release notes behind the version.
 *
 * One object rather than a per-window literal, so the live chart and a mounted
 * replay cannot drift into claiming different versions of the same app.
 */
export const BRAND: BottombarBrand = {
    name: 'Midorii.',
    // Stamped in from package.json at build time — see vite.config.ts.
    version: `v${__APP_VERSION__}`,
    versionLabel: 'What changed in this version',
    onVersionClick: () => openChangelog(document.body),
};
