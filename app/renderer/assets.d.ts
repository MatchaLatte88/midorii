/* Ambient declarations for what the bundler hands the renderer beyond TypeScript.
 *
 * Deliberately a script rather than a module (no imports, no exports): ambient
 * module declarations are only legal at the top level of one.
 */

/** Vite's `?raw` suffix: the file's text, as it is on disk. */
declare module '*.md?raw' {
    const content: string;
    export default content;
}

/** The app version, stamped in from package.json at build time (see vite.config.ts). */
declare const __APP_VERSION__: string;
