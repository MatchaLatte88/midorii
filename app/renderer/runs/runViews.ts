import { injectStyles } from '../../../src/ui';
// A trade's holding time reads the same as a measured span on the chart, and there is no
// reason for two of that.
import { formatDuration } from '../../../src/core/drawings';
import type { MidoriEquityPoint, MidoriRunStats, MidoriRunSummary, MidoriTrade } from '../midori';
import {
    formatMoney, formatPercent, formatProfitFactor, formatR, formatSignedMoney, formatWhen, rMultiple,
} from '../format';
import { equityPath } from './runStats';

/**
 * How a finished account reads — the tiles, the curve and the trade list.
 *
 * Apart from the dialog that first drew them because a second screen now shows the same
 * account: the Analysis tab. Two copies of this markup would be two screens drifting apart
 * about the same session, which is the same reason `summarize` lives in one place — a run's
 * figures are the run's, not the panel's.
 *
 * Deliberately read-only about the numbers, exactly as the dialog was. Nothing here
 * recomputes a statistic: the account summed itself up when it finished.
 */

const STYLE_ID = 'midorii-figures';
const CSS = `
.midorii-figures table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.midorii-figures th {
    position: sticky; top: 0; z-index: 1;
    padding: 6px 8px; text-align: right; white-space: nowrap;
    background: var(--vela-surface-elev);
    border-bottom: 1px solid var(--vela-border);
    font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--vela-fg-muted);
}
.midorii-figures th:first-child, .midorii-figures td:first-child { text-align: left; }
.midorii-figures td { padding: 7px 8px; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--vela-border-faint); }
.midorii-figures tbody tr[data-pick] { cursor: pointer; }
.midorii-figures tbody tr[data-pick]:hover { background: var(--vela-hover); }
.midorii-figures .num { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.midorii-figures .up { color: var(--vela-up); }
.midorii-figures .down { color: var(--vela-down); }
.midorii-figures .muted { color: var(--vela-fg-muted); }
.midorii-figures .market { color: var(--vela-fg-bright); font-weight: 600; }

.midorii-figures-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; background: var(--vela-border-faint); border: 1px solid var(--vela-border-faint); border-radius: var(--vela-radius-sm); overflow: hidden; margin-bottom: 14px; }
.midorii-figures-tile { padding: 8px 10px; background: var(--vela-surface); }
.midorii-figures-tile dt { margin: 0 0 3px; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--vela-fg-muted); }
.midorii-figures-tile dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; color: var(--vela-fg-bright); font-variant-numeric: tabular-nums; }

.midorii-figures-curve { display: block; width: 100%; margin-bottom: 14px; background: var(--vela-surface-sunken); border-radius: var(--vela-radius-sm); }

.midorii-figures-section { margin: 0 0 6px; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--vela-fg-muted); }

.midorii-figures-remove { width: 1%; padding-left: 0; }
.midorii-figures-remove button {
    all: unset; box-sizing: border-box;
    padding: 3px 9px; border-radius: var(--vela-radius-sm);
    font-size: 11px; font-weight: 600; white-space: nowrap; cursor: pointer;
    color: var(--vela-fg-faint); border: 1px solid transparent;
}
.midorii-figures tbody tr:hover .midorii-figures-remove button { color: var(--vela-fg-muted); border-color: var(--vela-border-soft); }
.midorii-figures-remove button:hover { color: var(--vela-danger); border-color: var(--vela-border-soft); }
.midorii-figures-remove button[data-armed='1'],
.midorii-figures tbody tr:hover .midorii-figures-remove button[data-armed='1'] {
    color: var(--vela-danger); border-color: var(--vela-danger);
}

.midorii-figures-settings {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 2px 18px; margin-bottom: 14px;
}
.midorii-figures-setting { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-height: 22px; }
.midorii-figures-setting dt { margin: 0; color: var(--vela-fg-muted); }
.midorii-figures-setting dd { margin: 0; color: var(--vela-fg-bright); font-variant-numeric: tabular-nums; text-align: right; }
`;

/** Inject the shared figure styles. Every screen that draws these calls it once. */
export function ensureFigureStyles(doc: Document): void {
    injectStyles(STYLE_ID, CSS, doc);
}

export function button(text: string, tone: 'plain' | 'primary' | 'danger' = 'plain'): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = text;
    const fill = tone === 'primary' ? 'background:var(--vela-accent);color:var(--vela-fg-on-fill);border:1px solid transparent'
        : tone === 'danger' ? 'background:transparent;color:var(--vela-danger);border:1px solid var(--vela-border-soft)'
            : 'background:var(--vela-surface-overlay);color:var(--vela-fg);border:1px solid var(--vela-border-soft)';
    b.style.cssText = `all:unset;box-sizing:border-box;padding:5px 14px;border-radius:var(--vela-radius-sm);cursor:pointer;font-weight:600;font-size:12px;${fill}`;
    return b;
}

/** A number cell, colored by its sign when the sign is what it is there to say. */
export function cell(text: string, opts: { sign?: number; mono?: boolean } = {}): HTMLTableCellElement {
    const td = document.createElement('td');
    td.textContent = text;
    const classes = ['num'];
    if (opts.mono === false) classes.pop();
    if (opts.sign != null && opts.sign !== 0) classes.push(opts.sign > 0 ? 'up' : 'down');
    td.className = classes.join(' ');
    return td;
}

/**
 * The trailing cell that takes a row off its shelf.
 *
 * Armed by the first click and only acted on by the second, the same two step the detail
 * screens use and for the same reason: every row here is one click away from being opened,
 * so the button beside it must not throw a session away on a mis-click. Leaving the row
 * disarms it — an armed button nobody is looking at any more is a delete waiting to happen
 * on the next pass — and the click never reaches the row underneath.
 */
export function deleteCell(onDelete: () => void): HTMLTableCellElement {
    const td = document.createElement('td');
    td.className = 'midorii-figures-remove';
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'Delete';
    b.title = 'Delete — click twice';
    b.onclick = (ev) => {
        ev.stopPropagation();
        if (b.dataset.armed !== '1') {
            b.dataset.armed = '1';
            b.textContent = 'Sure?';
            return;
        }
        onDelete();
    };
    const disarm = (): void => {
        if (b.dataset.armed !== '1') return;
        delete b.dataset.armed;
        b.textContent = 'Delete';
    };
    b.onmouseleave = disarm;
    b.onblur = disarm;
    td.appendChild(b);
    return td;
}

export function tile(label: string, value: string, sign?: number): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'midorii-figures-tile';
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (sign != null && sign !== 0) dd.classList.add(sign > 0 ? 'up' : 'down');
    wrap.append(dt, dd);
    return wrap;
}

/** A four-across row of tiles — what every figure grid in the app is. */
export function tileGrid(tiles: readonly HTMLElement[]): HTMLElement {
    const grid = document.createElement('dl');
    grid.className = 'midorii-figures-grid';
    grid.append(...tiles);
    return grid;
}

export function headerRow(labels: string[]): HTMLTableSectionElement {
    const head = document.createElement('thead');
    const tr = document.createElement('tr');
    for (const label of labels) {
        const th = document.createElement('th');
        th.textContent = label;
        tr.appendChild(th);
    }
    head.appendChild(tr);
    return head;
}

export function sectionLabel(text: string): HTMLElement {
    const p = document.createElement('p');
    p.className = 'midorii-figures-section';
    p.textContent = text;
    return p;
}

/**
 * The settings a run was made with.
 *
 * A run without them is a number nobody can act on: knowing that something returned 14%
 * is worth nothing if what produced it is gone. Printed as the form asked the questions,
 * not as the object stores them — see `describeParams`.
 */
export function settingsGrid(rows: ReadonlyArray<{ label: string; value: string }>): HTMLElement {
    const grid = document.createElement('dl');
    grid.className = 'midorii-figures-settings';
    for (const row of rows) {
        const wrap = document.createElement('div');
        wrap.className = 'midorii-figures-setting';
        const dt = document.createElement('dt');
        dt.textContent = row.label;
        const dd = document.createElement('dd');
        dd.textContent = row.value;
        wrap.append(dt, dd);
        grid.appendChild(wrap);
    }
    return grid;
}

/** The eight figures an account is judged on, in the order they are read. */
export function statGrid(stats: MidoriRunStats): HTMLElement {
    return tileGrid([
        tile('Net', formatSignedMoney(stats.netPnl), stats.netPnl),
        tile('Return', formatPercent(stats.returnPct, 2, true), stats.returnPct),
        tile('Max drawdown', formatPercent(stats.maxDrawdownPct, 2)),
        tile('Final equity', formatMoney(stats.finalEquity)),
        tile('Trades', `${stats.winCount}W / ${stats.lossCount}L`),
        tile('Win rate', formatPercent(stats.winRate, 1)),
        tile('Profit factor', formatProfitFactor(stats.profitFactor)),
        tile('Expectancy', stats.expectancy == null ? '—' : formatSignedMoney(stats.expectancy)),
    ]);
}

/** The balance curve, with the starting balance drawn across it so up and down are visible. */
export function equityCurveSvg(
    points: readonly MidoriEquityPoint[],
    initialBalance: number,
    netPnl: number,
    height = 96,
): SVGSVGElement {
    const W = 800;
    const H = height;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'midorii-figures-curve');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.height = `${H}px`;

    const line = equityPath(points, W, H - 12, initialBalance);
    if (!line.d) return svg;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', 'translate(0 6)');

    if (line.baselineY !== null) {
        const base = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        base.setAttribute('x1', '0');
        base.setAttribute('x2', String(W));
        base.setAttribute('y1', String(line.baselineY));
        base.setAttribute('y2', String(line.baselineY));
        base.setAttribute('stroke', 'var(--vela-border-strong)');
        base.setAttribute('stroke-dasharray', '4 4');
        base.setAttribute('vector-effect', 'non-scaling-stroke');
        g.appendChild(base);
    }

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', line.d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    // The whole run in one color: it ended up or it did not.
    path.setAttribute('stroke', netPnl >= 0 ? 'var(--vela-up)' : 'var(--vela-down)');
    g.appendChild(path);

    svg.appendChild(g);
    return svg;
}

/**
 * A shelf of runs, newest first — the row a person clicks to open one.
 *
 * `who` says what traded it, which is the whole point of the label: the library is read to
 * compare one way of trading against another. The Analysis tab drops it where the list is
 * already one kind of thing (every filed paper account says "Paper trading").
 *
 * `onDelete` adds the last column. A shelf that only grows is a shelf nobody reads, so the
 * screens that are read to compare runs let a run go from the list itself rather than only
 * after opening it.
 */
export function runsTable(
    runs: readonly MidoriRunSummary[],
    onPick: (id: string) => void,
    opts: { who?: boolean; onDelete?: (id: string) => void } = {},
): HTMLElement {
    const table = document.createElement('table');
    const columns = ['Market', 'Ran', 'Trades', 'Win', 'Max DD', 'Return', 'Net'];
    if (opts.onDelete) columns.push('');
    table.appendChild(headerRow(columns));

    const body = document.createElement('tbody');
    for (const run of runs) {
        const tr = document.createElement('tr');
        tr.dataset.pick = run.id;
        tr.onclick = () => onPick(run.id);

        const market = document.createElement('td');
        const name = document.createElement('span');
        name.className = 'market';
        name.textContent = `${run.symbol} · ${run.timeframe}`;
        market.appendChild(name);
        if (opts.who !== false) {
            const who = document.createElement('span');
            who.className = 'muted';
            who.textContent = `  ${run.strategyName}`;
            market.appendChild(who);
        }

        tr.append(
            market,
            cell(formatWhen(run.createdAt), { mono: false }),
            cell(String(run.stats.tradeCount)),
            cell(formatPercent(run.stats.winRate, 0)),
            cell(formatPercent(run.stats.maxDrawdownPct, 1)),
            cell(formatPercent(run.stats.returnPct, 2, true), { sign: run.stats.returnPct }),
            cell(formatSignedMoney(run.stats.netPnl), { sign: run.stats.netPnl }),
        );
        if (opts.onDelete) tr.appendChild(deleteCell(() => opts.onDelete!(run.id)));
        body.appendChild(tr);
    }
    table.appendChild(body);
    return table;
}

/** Every closed round trip, in the order the account took them. */
export function tradesTable(trades: readonly MidoriTrade[]): HTMLElement {
    const table = document.createElement('table');
    table.appendChild(headerRow(['Side', 'Size', 'Entry', 'Exit', 'Held', 'R', 'Net']));

    const body = document.createElement('tbody');
    for (const t of trades) {
        const tr = document.createElement('tr');

        const side = document.createElement('td');
        side.textContent = t.side === 'long' ? 'Long' : 'Short';
        side.className = t.side === 'long' ? 'up' : 'down';

        tr.append(
            side,
            cell(String(t.size)),
            cell(formatMoney(t.entryPrice)),
            cell(formatMoney(t.exitPrice)),
            cell(formatDuration(t.closedAt - t.openedAt)),
            cell(formatR(rMultiple(t))),
            cell(formatSignedMoney(t.netPnl), { sign: t.netPnl }),
        );
        body.appendChild(tr);
    }
    table.appendChild(body);
    return table;
}
