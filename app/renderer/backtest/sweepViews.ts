import { injectStyles } from '../../../src/ui';
import { RANK_METRICS } from '../../../shared/analysis/sweep.js';
import type { RankMetricId, SweepEntry } from '../../../shared/analysis/sweep';
import { formatPercent, formatProfitFactor, formatSignedMoney, formatWhen } from '../format';
import type { MidoriSweepSummary } from '../midori';
import { cell, deleteCell, headerRow } from '../runs/runViews';

/**
 * How a finished sweep reads.
 *
 * Its own file because two screens draw it: the Backtest tab, which has just run one, and
 * the Analysis tab, which is reading one back weeks later. Two copies of this table would
 * be two screens disagreeing about the same ranking.
 *
 * Both ends, and both stretches
 * -----------------------------
 * The table shows the worst combinations next to the best, and the out-of-sample column
 * next to the in-sample one, because either on its own misleads. A ranking without its
 * tail cannot say whether the parameter mattered at all — four combinations within a hair
 * of each other mean the setting is not what drove the result. And an in-sample winner
 * without its out-of-sample number is precisely the overfit a sweep manufactures: the
 * combination that memorised those bars looks excellent right up until it is asked about
 * bars it did not choose.
 */

const STYLE_ID = 'midorii-sweep';
const CSS = `
.midorii-sweep-note { margin: 0 0 10px; color: var(--vela-fg-muted); font-size: 12px; line-height: 1.5; }
.midorii-sweep-scroll { overflow-x: auto; margin-bottom: 14px; }
.midorii-sweep-scroll table { min-width: 100%; }
.midorii-sweep-band td {
    background: var(--vela-surface-sunken);
    font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase;
    color: var(--vela-fg-muted);
}
.midorii-sweep-out { color: var(--vela-fg-muted); }
.midorii-sweep-pick { all: unset; cursor: pointer; color: var(--vela-accent); font-weight: 600; }
.midorii-sweep-pick:hover { text-decoration: underline; }
`;

export function ensureSweepStyles(doc: Document): void {
    injectStyles(STYLE_ID, CSS, doc);
}

/** A swept value as the table prints it — trimmed, because a step of 0.1 stores 1.9 and a
 *  column of `1.9000000000000001` is unreadable even when it is right. */
function paramText(value: unknown): string {
    if (typeof value === 'number') return String(Math.round(value * 1e6) / 1e6);
    if (Array.isArray(value)) return value.join(', ');
    return String(value ?? '—');
}

function metricText(metric: RankMetricId, value: number | null): string {
    if (value == null) return '—';
    if (metric === 'profitFactor') return formatProfitFactor(value);
    if (metric === 'returnPct') return formatPercent(value, 2, true);
    return formatSignedMoney(value);
}

export interface SweepTableOptions {
    /** The parameters that varied — the only ones worth a column. */
    sweptKeys: readonly string[];
    /** What each swept parameter is called in the form. */
    labels?: ReadonlyMap<string, string>;
    metric: RankMetricId;
    best: readonly SweepEntry[];
    worst: readonly SweepEntry[];
    /** True when the two ends are largely the same rows, which the table has to admit. */
    overlapping?: boolean;
    /** Offered per row, so a winner can be taken back to the form and run in full. */
    onPick?: (entry: SweepEntry) => void;
}

/**
 * The ranking: the best few, then the worst few, with what each did on both stretches.
 *
 * The metric the sweep was ordered by gets its own column even when it duplicates one of
 * the others — reading a ranking without seeing the number it was ranked on means taking
 * the order on trust.
 */
export function sweepTable(opts: SweepTableOptions): HTMLElement {
    const metric = RANK_METRICS[opts.metric];
    const wrap = document.createElement('div');
    wrap.className = 'midorii-sweep-scroll';

    const table = document.createElement('table');
    const columns = [
        ...opts.sweptKeys.map((key) => opts.labels?.get(key) ?? key),
        'Trades', 'Win', 'Max DD', 'Net', metric.label, `${metric.label} (out of sample)`,
    ];
    if (opts.onPick) columns.push('');
    table.appendChild(headerRow(columns));

    const body = document.createElement('tbody');

    const band = (text: string): void => {
        const tr = document.createElement('tr');
        tr.className = 'midorii-sweep-band';
        const td = document.createElement('td');
        td.colSpan = columns.length;
        td.textContent = text;
        tr.appendChild(td);
        body.appendChild(tr);
    };

    const rows = (entries: readonly SweepEntry[]): void => {
        for (const entry of entries) {
            const tr = document.createElement('tr');
            for (const key of opts.sweptKeys) {
                tr.appendChild(cell(paramText(entry.params[key]), { mono: true }));
            }
            const inSample = metric.read(entry.stats);
            const outOfSample = entry.outOfSample ? metric.read(entry.outOfSample) : null;

            tr.append(
                cell(String(entry.stats.tradeCount)),
                cell(formatPercent(entry.stats.winRate, 0)),
                cell(formatPercent(entry.stats.maxDrawdownPct, 1)),
                cell(formatSignedMoney(entry.stats.netPnl), { sign: entry.stats.netPnl }),
                cell(metricText(opts.metric, inSample), { sign: inSample ?? 0 }),
            );

            const out = cell(
                entry.outOfSample ? metricText(opts.metric, outOfSample) : '—',
                { sign: outOfSample ?? 0 },
            );
            out.classList.add('midorii-sweep-out');
            if (entry.outOfSample) {
                out.title = `${entry.outOfSample.tradeCount} trades on the stretch that had no say `
                    + 'in the ranking.';
            }
            tr.appendChild(out);

            if (opts.onPick) {
                const td = document.createElement('td');
                const pick = document.createElement('button');
                pick.className = 'midorii-sweep-pick';
                pick.textContent = 'Use';
                pick.onclick = () => opts.onPick?.(entry);
                td.appendChild(pick);
                tr.appendChild(td);
            }
            body.appendChild(tr);
        }
    };

    band('Best');
    rows(opts.best);
    if (opts.worst.length > 0) {
        band(opts.overlapping ? 'Worst — the same rows as above; too few combinations cleared the floor' : 'Worst');
        rows(opts.worst);
    }

    table.appendChild(body);
    wrap.appendChild(table);
    return wrap;
}

/** The metric a stored sweep was ranked by, or expectancy when it names one this build no
 *  longer has — a sweep filed by an older version still has to be readable. */
function metricOf(id: string): RankMetricId {
    return (id in RANK_METRICS ? id : 'expectancy') as RankMetricId;
}

/**
 * A shelf of sweeps, newest first — the row a person clicks to open one.
 *
 * What each row is FOR is the parameters it varied, so those are the second column: a list
 * of "BTCUSDT · 5m" rows is a list of things that cannot be told apart, and the whole
 * reason to keep a sweep is the question it asked.
 */
export function sweepsTable(
    sweeps: readonly MidoriSweepSummary[],
    onPick: (id: string) => void,
    labels?: (sweep: MidoriSweepSummary, key: string) => string,
    onDelete?: (id: string) => void,
): HTMLElement {
    const table = document.createElement('table');
    const columns = ['Market', 'Swept', 'Ran', 'Combinations', 'Best', 'Out of sample'];
    if (onDelete) columns.push('');
    table.appendChild(headerRow(columns));

    const body = document.createElement('tbody');
    for (const sweep of sweeps) {
        const metric = RANK_METRICS[metricOf(sweep.metric)];
        const tr = document.createElement('tr');
        tr.dataset.pick = sweep.id;
        tr.onclick = () => onPick(sweep.id);

        const market = document.createElement('td');
        const name = document.createElement('span');
        name.className = 'market';
        name.textContent = `${sweep.symbol} · ${sweep.timeframe}`;
        const who = document.createElement('span');
        who.className = 'muted';
        who.textContent = `  ${sweep.strategyName}`;
        market.append(name, who);

        const swept = document.createElement('td');
        swept.textContent = sweep.sweptKeys
            .map((key) => labels?.(sweep, key) ?? key)
            .join(', ') || '—';

        const best = sweep.best ? metric.read(sweep.best.stats) : null;
        const out = sweep.best?.outOfSample ? metric.read(sweep.best.outOfSample) : null;

        tr.append(
            market,
            swept,
            cell(formatWhen(sweep.createdAt), { mono: false }),
            cell(sweep.combinationCount.toLocaleString()),
            cell(metricText(metricOf(sweep.metric), best), { sign: best ?? 0 }),
            cell(metricText(metricOf(sweep.metric), out), { sign: out ?? 0 }),
        );
        if (onDelete) tr.appendChild(deleteCell(() => onDelete(sweep.id)));
        body.appendChild(tr);
    }
    table.appendChild(body);
    return table;
}

/** The sentence a sweep result needs beside it, and which nobody should have to be told
 *  twice: an in-sample winner is a candidate, not a finding. */
export function overfitNote(hasSplit: boolean): HTMLElement {
    const p = document.createElement('p');
    p.className = 'midorii-sweep-note';
    p.textContent = hasSplit
        ? 'The ranking is from the earlier stretch. The out-of-sample column is the same settings '
            + 'on the later one, which had no say in choosing them — a winner whose second number '
            + 'collapses was fitted to noise, not found.'
        : 'This sweep optimised on the whole range and checked nothing. The best row is the '
            + 'combination that fitted these bars best, which is not the same as one that works.';
    return p;
}
