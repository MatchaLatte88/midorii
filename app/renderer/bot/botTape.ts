import { injectStyles } from '../../../src/ui';
import type { BotRunner } from './BotRunner';
import type { BotLogEntry } from './botLog';

/**
 * What the bot has been doing, under its chart.
 *
 * The one thing a screen for an unattended strategy has to get right. A bot that has taken
 * no trades all week is either working perfectly on a market that offered nothing, or has
 * been turning every setup away since Tuesday for a reason nobody can now reconstruct.
 * Nothing else on the screen tells those apart — the chart looks the same, the account
 * looks the same, and "no positions" is what both of them look like.
 *
 * So refusals are on the tape beside the orders, and they read as sentences rather than as
 * codes. A line that has repeated says how many times instead of appearing that many times
 * (see BotLog), which is what keeps a night of "outside the trading window" from burying
 * the trade taken that afternoon.
 */

const STYLE_ID = 'midorii-bot-tape';
const CSS = `
.midorii-tape { padding: 4px 0; font: 12px/1.5 var(--vela-font, sans-serif); }
.midorii-tape-row {
    display: grid; grid-template-columns: 62px 12px 1fr auto;
    gap: 8px; align-items: baseline;
    padding: 2px 14px;
}
.midorii-tape-row:hover { background: var(--vela-hover); }
.midorii-tape-time { color: var(--vela-fg-faint); font-variant-numeric: tabular-nums; font-size: 11px; }
.midorii-tape-mark { font-weight: 700; color: var(--vela-fg-faint); }
.midorii-tape-row[data-kind='order'] .midorii-tape-mark { color: var(--vela-accent-bright, #2962ff); }
.midorii-tape-row[data-kind='refused'] .midorii-tape-mark { color: var(--vela-warning, #d9822b); }
.midorii-tape-row[data-kind='error'] .midorii-tape-mark { color: var(--vela-danger, #f23645); }
.midorii-tape-text { color: var(--vela-fg); min-width: 0; overflow-wrap: anywhere; }
.midorii-tape-row[data-kind='refused'] .midorii-tape-text { color: var(--vela-fg-muted); }
.midorii-tape-row[data-kind='error'] .midorii-tape-text { color: var(--vela-danger); }
.midorii-tape-count {
    padding: 0 6px; border-radius: 999px;
    background: var(--vela-surface-overlay); color: var(--vela-fg-muted);
    font-size: 10.5px; font-variant-numeric: tabular-nums;
}
.midorii-tape-empty { padding: 14px; color: var(--vela-fg-muted); }
`;

/** The character in front of each line — what KIND of thing happened, at a glance. */
const MARKS: Record<BotLogEntry['kind'], string> = {
    info: '·',
    order: '›',
    refused: '⊘',
    error: '!',
};

export interface BotTape {
    /** Draw one runner's log, or the empty state when nothing is running. */
    render(runner: BotRunner | null): void;
}

export function botTape(host: HTMLElement): BotTape {
    const doc = host.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);

    const root = doc.createElement('div');
    root.className = 'midorii-tape';
    host.appendChild(root);

    /** What was drawn last, so a repaint on every tick does not rebuild an unchanged list.
     *  The head entry's time and count together change on every note, which is the cheapest
     *  thing that cannot go stale. */
    let drawn = '';

    return {
        render(runner): void {
            if (!runner) {
                if (drawn === 'none') return;
                drawn = 'none';
                root.replaceChildren(empty(doc, 'This bot is not running. Start it and everything it does — and everything it declines to do — appears here.'));
                return;
            }

            const entries = runner.log.list();
            const head = entries[0];
            const key = head ? `${entries.length}:${head.at}:${head.count}` : 'empty';
            if (key === drawn) return;
            drawn = key;

            if (entries.length === 0) {
                root.replaceChildren(empty(doc, 'Nothing yet — the log fills as bars close.'));
                return;
            }

            const rows = doc.createDocumentFragment();
            for (const entry of entries) rows.appendChild(row(doc, entry));
            root.replaceChildren(rows);
        },
    };
}

function empty(doc: Document, text: string): HTMLElement {
    const el = doc.createElement('p');
    el.className = 'midorii-tape-empty';
    el.textContent = text;
    return el;
}

function row(doc: Document, entry: BotLogEntry): HTMLElement {
    const el = doc.createElement('div');
    el.className = 'midorii-tape-row';
    el.dataset.kind = entry.kind;

    const time = doc.createElement('span');
    time.className = 'midorii-tape-time';
    time.textContent = new Date(entry.at).toLocaleTimeString(undefined, { hour12: false });

    const mark = doc.createElement('span');
    mark.className = 'midorii-tape-mark';
    mark.textContent = MARKS[entry.kind];

    const text = doc.createElement('span');
    text.className = 'midorii-tape-text';
    text.textContent = entry.text;

    el.append(time, mark, text);

    if (entry.count > 1) {
        const count = doc.createElement('span');
        count.className = 'midorii-tape-count';
        count.textContent = `×${entry.count}`;
        count.title = 'This line has repeated. The time is the most recent one.';
        el.appendChild(count);
    }
    return el;
}
