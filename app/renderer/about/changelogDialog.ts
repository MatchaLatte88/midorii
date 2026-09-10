import { Dialog, injectStyles, overlayScrollbarCss } from '../../../src/ui';
import changelogSource from '../../../CHANGELOG.md?raw';
import { renderChangelog } from './changelogMarkdown';

/**
 * The release notes, behind the version number in the status bar.
 *
 * CHANGELOG.md is the single source of truth — it ships with the app as text
 * and is rendered here, so there is never a second copy of the notes to keep in
 * step with the first.
 */

const STYLE_ID = 'midorii-changelog';
const CSS = `
.midorii-changelog { max-width: 62ch; font-size: 13px; line-height: 1.6; color: var(--vela-fg); }
.midorii-changelog h1 { font-size: 15px; margin: 0 0 14px; color: var(--vela-fg-bright); }
.midorii-changelog h2 {
    font-size: 14px;
    margin: 22px 0 8px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--vela-border);
    color: var(--vela-fg-bright);
    font-variant-numeric: tabular-nums;
}
.midorii-changelog h2:first-child { margin-top: 0; }
.midorii-changelog h3 {
    font-size: 11px;
    margin: 14px 0 6px;
    color: var(--vela-fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
}
.midorii-changelog p { margin: 0 0 10px; }
.midorii-changelog ul { margin: 0 0 10px; padding-left: 18px; }
.midorii-changelog li { margin: 0 0 8px; }
.midorii-changelog strong { color: var(--vela-fg-bright); font-weight: 600; }
.midorii-changelog code {
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--vela-surface-overlay);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.92em;
}
.midorii-changelog-scroll { max-height: min(62vh, 640px); overflow-y: auto; padding-right: 6px; }
${overlayScrollbarCss('.midorii-changelog-scroll')}
`;

let open: Dialog | null = null;

/** Show the release notes. Opening twice just brings the one dialog forward. */
export function openChangelog(host: HTMLElement): void {
    if (open) {
        open.show();
        return;
    }
    injectStyles(STYLE_ID, CSS, host.ownerDocument);

    open = new Dialog({
        title: 'Release notes',
        eyebrow: 'Midorii',
        host,
        draggable: true,
        align: 'center',
        content: (body) => {
            const scroll = body.ownerDocument.createElement('div');
            scroll.className = 'midorii-changelog-scroll';
            const article = body.ownerDocument.createElement('div');
            article.className = 'midorii-changelog';
            article.innerHTML = renderChangelog(changelogSource);
            scroll.appendChild(article);
            body.appendChild(scroll);
        },
    });
    open.show();
}
