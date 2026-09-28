import { NumberInput, Select, injectStyles, overlayScrollbarCss } from '../../../src/ui';
import { DEFAULT_COSTS } from '../../../shared/engine/broker.js';
import type { Costs } from '../../../shared/engine/broker';
import type { MidoriDatasetMeta } from '../midori';
import { formatDay, formatPercent } from '../format';
import { button, cell, ensureFigureStyles, headerRow, tile, tileGrid } from '../runs/runViews';
import { startPatternSearch, type PatternSearchHandle } from './patternClient';
import type { MineProgress, MineResult, PatternCandidate } from './miner';
import type { PatternStats } from './stats';

/**
 * The Patterns tab: search a market's history for candlestick patterns that pay, and show
 * which of them survive being asked twice.
 *
 * Everything the search decides is explained in miner.ts; this screen's job is to make the
 * answer impossible to misread. Every row shows the stretch it was chosen on next to the
 * stretches it was not, the score luck alone reaches is printed beside the best score, and
 * each row carries a plain verdict. A screen that led with the discovery numbers would be
 * a machine for believing in noise.
 */

const STYLE_ID = 'midorii-patterns';
const CSS = `
.midorii-patterns {
    position: absolute; inset: 0;
    display: flex; flex-direction: column;
    background: var(--vela-bg);
    color: var(--vela-fg);
    font: 13px/1.5 var(--vela-font, sans-serif);
}
.midorii-patterns-body { flex: 1 1 auto; min-height: 0; overflow: auto; }
${overlayScrollbarCss('.midorii-patterns-body')}
.midorii-patterns-inner { max-width: 1240px; margin: 0 auto; padding: 24px 20px 48px; }
.midorii-patterns-card {
    margin-bottom: 18px;
    background: var(--vela-surface-card);
    border: 1px solid var(--vela-border);
    border-radius: var(--vela-radius-xl);
    box-shadow: 0 14px 34px color-mix(in srgb, var(--vela-bg) 72%, transparent);
    overflow: hidden;
}
.midorii-patterns-head {
    padding: 17px 20px 15px;
    border-bottom: 1px solid var(--vela-border-faint);
    background: var(--vela-chrome);
}
.midorii-patterns-eyebrow {
    margin-bottom: 5px;
    font-family: var(--vela-font-mono);
    font-size: 9px; line-height: 1.2; letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--vela-fg-muted); opacity: 0.8;
}
.midorii-patterns-head h2 {
    margin: 0;
    font-size: 18px; line-height: 1.25; letter-spacing: -0.02em; font-weight: 600;
    color: var(--vela-fg-bright);
}
.midorii-patterns-sub { max-width: 780px; margin: 6px 0 0; color: var(--vela-fg-muted); font-size: 12px; line-height: 1.55; }
.midorii-patterns-card-body { padding: 20px; }
.midorii-patterns-section + .midorii-patterns-section { margin-top: 22px; }
.midorii-patterns-section-title {
    margin: 0 0 4px;
    font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--vela-fg-muted);
}
.midorii-patterns-section-copy { margin: 0 0 12px; color: var(--vela-fg-muted); font-size: 11.5px; line-height: 1.5; }
.midorii-patterns-grid { display: grid; gap: 14px 18px; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.midorii-patterns-grid[data-cols='3'] { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.midorii-patterns-row { display: flex; flex-direction: column; align-items: stretch; gap: 6px; min-width: 0; }
.midorii-patterns-row > span:first-child { color: var(--vela-fg-muted); font-size: 11.5px; font-weight: 600; line-height: 1.3; }
.midorii-patterns-row > :is(.vela-select, .vela-number) { width: 100%; }
.midorii-patterns-date {
    width: 100%; height: 34px; box-sizing: border-box;
    background: transparent; color: var(--vela-fg-bright);
    border: 1px solid var(--vela-border-strong); border-radius: 6px;
    padding: 0 9px; font: 14px var(--vela-font); outline: none;
}
.midorii-patterns-date:hover { border-color: var(--vela-fg-muted); }
.midorii-patterns-date:focus { border-color: var(--vela-focus); box-shadow: 0 0 0 3px var(--vela-focus-soft); }
.midorii-patterns-actions {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 14px 20px;
    border-top: 1px solid var(--vela-border-faint);
    background: var(--vela-chrome);
}
.midorii-patterns-action-status { min-width: 0; flex: 1 1 auto; display: flex; align-items: center; gap: 10px; }
.midorii-patterns-action-buttons { flex: none; display: flex; align-items: center; gap: 10px; }
.midorii-patterns-status { color: var(--vela-fg-muted); font-size: 12px; line-height: 1.4; }
.midorii-patterns-status:empty::before { content: 'Ready to search'; opacity: 0.75; }
.midorii-patterns-status[data-error='1'] { color: var(--vela-danger); }
.midorii-patterns-progress {
    flex: 0 1 180px; height: 4px; min-width: 80px;
    background: var(--vela-surface-sunken); border-radius: 999px; overflow: hidden;
}
.midorii-patterns-progress[hidden] { display: none !important; }
.midorii-patterns-progress > div { height: 100%; background: var(--vela-accent); transition: width 120ms linear; }
.midorii-patterns-verdict {
    margin: 0 0 14px; padding: 10px 12px;
    border-left: 2px solid var(--vela-accent-line);
    border-radius: 0 var(--vela-radius-sm) var(--vela-radius-sm) 0;
    background: var(--vela-accent-soft);
    color: var(--vela-fg); font-size: 12px; line-height: 1.55;
}
.midorii-patterns-stretches { margin: 0 0 14px; color: var(--vela-fg-muted); font-size: 11.5px; line-height: 1.5; }
.midorii-patterns-scroll { overflow-x: auto; }
.midorii-patterns-scroll td.midorii-patterns-rule {
    min-width: 280px; white-space: normal; text-align: left; line-height: 1.45;
    color: var(--vela-fg-bright);
}
.midorii-patterns-rule > span { display: block; }
.midorii-patterns-band td {
    background: var(--vela-surface-sunken);
    font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase;
    color: var(--vela-fg-muted); text-align: left;
}
.midorii-patterns-tag {
    display: inline-block; padding: 2px 7px; border-radius: 999px;
    font: 600 10.5px/1.3 var(--vela-font); white-space: nowrap;
    border: 1px solid var(--vela-border-soft); color: var(--vela-fg-muted);
}
.midorii-patterns-tag[data-tone='up'] { color: var(--vela-up); border-color: currentColor; }
.midorii-patterns-tag[data-tone='down'] { color: var(--vela-down); border-color: color-mix(in srgb, currentColor 50%, transparent); }
.midorii-patterns-empty { padding: 4px 0 0; color: var(--vela-fg-muted); font-size: 12.5px; line-height: 1.6; }

@media (max-width: 900px) {
    .midorii-patterns-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .midorii-patterns-grid[data-cols='3'] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 560px) {
    .midorii-patterns-inner { padding: 14px 12px 32px; }
    .midorii-patterns-grid, .midorii-patterns-grid[data-cols='3'] { grid-template-columns: minmax(0, 1fr); }
    .midorii-patterns-actions { align-items: stretch; flex-direction: column; }
}
`;

const TIMEFRAMES: ReadonlyArray<{ value: string; label: string }> = [
    { value: '15', label: '15m' },
    { value: '30', label: '30m' },
    { value: '60', label: '1h' },
    { value: '240', label: '4h' },
    { value: 'D', label: '1d' },
];

const DEPTHS: ReadonlyArray<{ value: string; label: string }> = [
    { value: '1', label: '1 condition' },
    { value: '2', label: 'Up to 2' },
    { value: '3', label: 'Up to 3' },
];

/** What a search may be anchored on — the fair value gap states, in the order a trader
 *  would reach for them. `none` searches everywhere. */
const ANCHORS: ReadonlyArray<{ value: string; label: string }> = [
    { value: 'none', label: 'Nowhere — search every bar' },
    { value: 'f.bulltap', label: 'In an open bullish FVG' },
    { value: 'f.beartap', label: 'In an open bearish FVG' },
    { value: 'f.bullhold', label: 'Rejected off a bullish FVG' },
    { value: 'f.bearhold', label: 'Rejected off a bearish FVG' },
    { value: 'f.bullnew', label: 'A bullish FVG just formed' },
    { value: 'f.bearnew', label: 'A bearish FVG just formed' },
    { value: 'f.bullbreak', label: 'Closed through a bullish FVG' },
    { value: 'f.bearbreak', label: 'Closed through a bearish FVG' },
];

const LUCK_RUNS: ReadonlyArray<{ value: string; label: string }> = [
    { value: '0', label: 'Off' },
    { value: '10', label: '10 runs' },
    { value: '20', label: '20 runs' },
    { value: '50', label: '50 runs' },
];

const DAY = 86_400_000;
/** Below this the three stretches are too short to say anything. */
const MIN_BARS = 1500;
const PREFERRED_SYMBOL = 'BTCUSDT';

function isoDate(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
    const el = document.createElement('label');
    el.className = 'midorii-patterns-row';
    const text = document.createElement('span');
    text.textContent = label;
    if (hint) text.title = hint;
    el.append(text, control);
    return el;
}

function section(title: string, copy: string, grid: HTMLElement): HTMLElement {
    const el = document.createElement('section');
    el.className = 'midorii-patterns-section';
    const h = document.createElement('h3');
    h.className = 'midorii-patterns-section-title';
    h.textContent = title;
    const p = document.createElement('p');
    p.className = 'midorii-patterns-section-copy';
    p.textContent = copy;
    el.append(h, p, grid);
    return el;
}

function grid(children: HTMLElement[], cols?: number): HTMLElement {
    const el = document.createElement('div');
    el.className = 'midorii-patterns-grid';
    if (cols) el.dataset.cols = String(cols);
    el.append(...children);
    return el;
}

function formatR(value: number): string {
    if (!Number.isFinite(value)) return '—';
    return `${value >= 0 ? '+' : ''}${value.toFixed(2)} R`;
}

function formatT(value: number): string {
    if (value === Number.POSITIVE_INFINITY) return '∞';
    if (!Number.isFinite(value)) return '—';
    return value.toFixed(2);
}

function statsText(stats: PatternStats | null): string {
    if (!stats || stats.trades === 0) return '—';
    return `${formatR(stats.meanR)} · ${stats.trades}`;
}

interface Verdict {
    text: string;
    tone: 'up' | 'down' | 'muted';
    title: string;
}

/** One plain answer per row, checked in the order a skeptic would ask. */
function verdictOf(c: PatternCandidate): Verdict {
    if (c.beatsNull === false) {
        return {
            text: 'No better than luck', tone: 'muted',
            title: 'Its discovery score is one the same search reaches on outcomes that have nothing to do with the candles.',
        };
    }
    if (!c.validated) {
        return c.validation.trades < 10
            ? { text: 'Too rare to check', tone: 'muted', title: 'Fewer than 10 trades on the validation stretch.' }
            : { text: 'Failed validation', tone: 'down', title: 'It lost money on bars it was not chosen on.' };
    }
    if (!c.holdout || !(c.holdout.meanR > 0)) {
        return { text: 'Failed holdout', tone: 'down', title: 'It passed validation and then lost on the last, untouched stretch.' };
    }
    return {
        text: 'Holds up', tone: 'up',
        title: 'It beat luck, and stayed positive on both stretches it was not chosen on. A candidate for a full backtest — not proof.',
    };
}

export interface PatternsViewHandle {
    /** Re-read the datasets. Called whenever the tab is opened. */
    refresh(): Promise<void>;
}

/** Mount the Patterns tab into `host`. */
export function mountPatternsView(host: HTMLElement): PatternsViewHandle {
    const doc = host.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);
    ensureFigureStyles(doc);

    /* ── state ─────────────────────────────────────────────────────────── */
    let datasets: MidoriDatasetMeta[] = [];
    let symbol = '';
    let timeframe = '60';
    let from = 0;
    let to = 0;
    const exit = { stopAtr: 1, rrr: 2, maxBars: 24 };
    let maxDepth = 3;
    let anchor = 'none';
    let minTrades = 30;
    let nullRuns = 20;
    const costPct = {
        fee: DEFAULT_COSTS.feeRate * 100,
        spread: DEFAULT_COSTS.spreadPct * 100,
        slippage: DEFAULT_COSTS.slippagePct * 100,
    };

    let running: PatternSearchHandle | null = null;
    let result: MineResult | null = null;
    let ranOn = '';

    /* ── frame ─────────────────────────────────────────────────────────── */
    const root = doc.createElement('div');
    root.className = 'midorii-patterns';
    const body = doc.createElement('div');
    body.className = 'midorii-patterns-body';
    const inner = doc.createElement('div');
    inner.className = 'midorii-patterns-inner';
    body.appendChild(inner);
    root.appendChild(body);
    host.appendChild(root);

    const formCard = doc.createElement('div');
    formCard.className = 'midorii-patterns-card';
    const resultCard = doc.createElement('div');
    resultCard.className = 'midorii-patterns-card';
    resultCard.hidden = true;
    inner.append(formCard, resultCard);

    const head = doc.createElement('div');
    head.className = 'midorii-patterns-head';
    head.innerHTML = '<div class="midorii-patterns-eyebrow">Candlestick patterns</div>'
        + '<h2>Find the patterns that hold up</h2>'
        + '<p class="midorii-patterns-sub">Every combination of up to three candle conditions is scored on the '
        + 'first 60% of the range, both ways, after costs. Only what also holds on the next 20% is shown on the '
        + 'final 20% — and the whole search is repeated with the outcomes slid in time against the candles, to '
        + 'measure how good a pattern looks by luck alone.</p>';

    const formBody = doc.createElement('div');
    formBody.className = 'midorii-patterns-card-body';

    const actions = doc.createElement('div');
    actions.className = 'midorii-patterns-actions';
    const actionStatus = doc.createElement('div');
    actionStatus.className = 'midorii-patterns-action-status';
    const status = doc.createElement('span');
    status.className = 'midorii-patterns-status';
    const progress = doc.createElement('div');
    progress.className = 'midorii-patterns-progress';
    progress.hidden = true;
    const progressFill = doc.createElement('div');
    progressFill.style.width = '0%';
    progress.appendChild(progressFill);
    actionStatus.append(progress, status);
    const actionButtons = doc.createElement('div');
    actionButtons.className = 'midorii-patterns-action-buttons';
    const stopButton = button('Stop');
    stopButton.hidden = true;
    stopButton.onclick = () => running?.stop();
    const runButton = button('Search patterns', 'primary');
    runButton.onclick = () => void run();
    actionButtons.append(stopButton, runButton);
    actions.append(actionStatus, actionButtons);

    formCard.append(head, formBody, actions);

    function say(text: string, error = false): void {
        status.textContent = text;
        if (error) status.dataset.error = '1';
        else delete status.dataset.error;
    }

    function setRunning(on: boolean): void {
        runButton.disabled = on;
        stopButton.hidden = !on;
        progress.hidden = !on;
        if (!on) progressFill.style.width = '0%';
    }

    function showProgress(p: MineProgress): void {
        const units = 1 + nullRuns;
        let done = 1;
        if (p.stage === 'search') {
            done = p.done;
            say('Searching every combination…');
        } else if (p.stage === 'null') {
            done = 1 + p.done;
            say(`Measuring luck — run ${p.done} of ${p.total}`);
        } else if (p.stage === 'confirm') {
            done = units;
            say(`Backtesting the survivors — ${p.done} of ${p.total}`);
        } else {
            done = units;
            say('Checking the best patterns on unseen bars…');
        }
        progressFill.style.width = `${Math.round((100 * done) / units)}%`;
    }

    /* ── the form ──────────────────────────────────────────────────────── */

    function dateInput(value: number, onChange: (ms: number) => void): HTMLInputElement {
        const input = doc.createElement('input');
        input.type = 'date';
        input.className = 'midorii-patterns-date';
        input.value = isoDate(value);
        input.onchange = () => {
            const ms = Date.parse(`${input.value}T00:00:00Z`);
            if (Number.isFinite(ms)) onChange(ms);
        };
        return input;
    }

    function number(value: number, opts: { min: number; max: number; step: number; integer?: boolean }, onChange: (v: number) => void): HTMLElement {
        return new NumberInput({ value, ...opts, integer: opts.integer ?? false, fill: true, onChange }).el;
    }

    function select(options: ReadonlyArray<{ value: string; label: string }>, value: string, onChange: (v: string) => void): HTMLElement {
        return new Select({ options: [...options], value, fill: true, onChange }).el;
    }

    function resetRange(meta: MidoriDatasetMeta | undefined): void {
        to = (meta?.last ?? Date.now()) + 60_000;
        from = meta?.first ?? to - 365 * DAY;
    }

    function paintForm(): void {
        formBody.replaceChildren();

        if (datasets.length === 0) {
            const empty = doc.createElement('p');
            empty.className = 'midorii-patterns-empty';
            empty.textContent = 'No market data on this machine yet. Download a market from the chart\'s '
                + 'download button, then come back — the search needs at least a year of history to say anything.';
            formBody.appendChild(empty);
            runButton.disabled = true;
            return;
        }
        runButton.disabled = running !== null;

        formBody.append(
            section('Market', 'The history the search reads. Longer is better: every stretch has to hold enough trades on its own.', grid([
                row('Market', select(datasets.map((d) => ({ value: d.symbol, label: d.symbol })), symbol, (v) => {
                    symbol = v;
                    resetRange(datasets.find((d) => d.symbol === v));
                    paintForm();
                })),
                row('Timeframe', select(TIMEFRAMES, timeframe, (v) => { timeframe = v; })),
                row('From', dateInput(from, (ms) => { from = ms; })),
                row('To', dateInput(to - DAY, (ms) => { to = ms + DAY; })),
            ])),
            section('Trade', 'One exit for every pattern, so patterns differ only in where they get in. The '
                + 'stop and target are measured from the signal candle\'s close.', grid([
                row('Stop (ATR)', number(exit.stopAtr, { min: 0.25, max: 10, step: 0.25 }, (v) => { exit.stopAtr = v; }),
                    'Stop distance in average true ranges (14) from the signal close.'),
                row('Reward-to-risk', number(exit.rrr, { min: 0.25, max: 10, step: 0.25 }, (v) => { exit.rrr = v; }),
                    'Target distance as a multiple of the stop distance.'),
                row('Max bars held', number(exit.maxBars, { min: 1, max: 500, step: 1, integer: true }, (v) => { exit.maxBars = v; }),
                    'A trade that reaches neither level is closed at the open after this many bars.'),
            ], 3)),
            section('Search', 'More conditions find more — and more of it by chance. The luck runs are what '
                + 'tell the two apart, and they cost one search each. An anchor makes every pattern start at '
                + 'a fair value gap (0.1 ATR or more, watched for 48 bars) and asks only which candles there pay.', grid([
                row('Anchored at', select(ANCHORS, anchor, (v) => { anchor = v; }),
                    'A condition every pattern must contain. The conditions below are added on top of it.'),
                row('Conditions', select(DEPTHS, String(maxDepth), (v) => { maxDepth = Number(v); })),
                row('Min trades', number(minTrades, { min: 10, max: 1000, step: 5, integer: true }, (v) => { minTrades = v; }),
                    'Fewest trades a pattern needs on the discovery stretch to be scored.'),
                row('Luck runs', select(LUCK_RUNS, String(nullRuns), (v) => { nullRuns = Number(v); }),
                    'How often the search is repeated on outcomes slid against the candles.'),
            ])),
            section('Costs', 'Charged on every trade, per side. A crypto taker fee is about 0.1%; on a futures '
                + 'or maker account it is far less, and that difference decides most patterns.', grid([
                row('Fee (%)', number(costPct.fee, { min: 0, max: 1, step: 0.01 }, (v) => { costPct.fee = v; })),
                row('Spread (%)', number(costPct.spread, { min: 0, max: 1, step: 0.01 }, (v) => { costPct.spread = v; }),
                    'The full bid/ask spread; half is paid on each side.'),
                row('Slippage (%)', number(costPct.slippage, { min: 0, max: 1, step: 0.01 }, (v) => { costPct.slippage = v; }),
                    'Extra adverse move on market entries, stops and time exits.'),
            ], 3)),
        );
    }

    /* ── running ───────────────────────────────────────────────────────── */

    async function run(): Promise<void> {
        if (running) return;
        if (!symbol) return say('Choose a market first.', true);
        if (!(to > from)) return say('The range has to end after it starts.', true);

        const anchorLabel = anchor === 'none' ? '' : ` · anchored: ${ANCHORS.find((a) => a.value === anchor)?.label ?? anchor}`;
        const label = `${symbol} · ${TIMEFRAMES.find((t) => t.value === timeframe)?.label ?? timeframe}${anchorLabel}`;
        runButton.disabled = true;
        try {
            say('Loading bars…');
            const bars = await window.midori.data.bars({ symbol, timeframe, from, to, dropIncomplete: true });
            if (bars.length < MIN_BARS) {
                throw new Error(`Only ${bars.length} bars in that range — the search needs at least ${MIN_BARS}. `
                    + 'Widen the range or pick a shorter timeframe.');
            }

            const costs: Required<Costs> = {
                feeRate: costPct.fee / 100,
                feePerUnit: 0,
                spreadPct: costPct.spread / 100,
                slippagePct: costPct.slippage / 100,
            };
            setRunning(true);
            running = startPatternSearch({
                bars,
                exit: { ...exit },
                costs,
                maxDepth,
                anchor: anchor === 'none' ? null : anchor,
                minTrades,
                nullRuns,
                keep: 25,
                seed: 1,
                riskPct: 1,
                balance: 10_000,
                onProgress: showProgress,
            });
            const found = await running.result;
            if (!found) {
                say('Stopped.');
                return;
            }
            result = found;
            ranOn = `${label} · ${bars.length.toLocaleString('en-US')} bars`;
            say(`Done in ${(found.elapsedMs / 1000).toFixed(1)} s.`);
            paintResult();
        } catch (err) {
            say(err instanceof Error ? err.message : String(err), true);
        } finally {
            running = null;
            setRunning(false);
            runButton.disabled = datasets.length === 0;
        }
    }

    /* ── the result ────────────────────────────────────────────────────── */

    function summaryText(r: MineResult): string {
        const holds = r.candidates.filter((c) => verdictOf(c).tone === 'up').length;
        if (holds > 0) {
            return `${holds} ${holds === 1 ? 'pattern' : 'patterns'} beat what luck reaches and stayed positive on `
                + 'both stretches they were not chosen on. Treat them as candidates for a full backtest with '
                + 'intrabar fills, not as proof — this search tried '
                + `${r.tested.toLocaleString('en-US')} patterns to find them.`;
        }
        const luck = r.nullThreshold != null && !(r.bestT > r.nullThreshold)
            ? `The best pattern scored t = ${formatT(r.bestT)}; the same search on outcomes that have nothing to do `
                + `with the candles reached t = ${formatT(r.nullThreshold)} one run in twenty. `
            : '';
        const base = r.baseline.discovery;
        const costNote = base.long < -0.2 && base.short < -0.2
            ? `A random entry averaged ${formatR(base.long)} long and ${formatR(base.short)} short here — `
                + 'most of that is costs, and a pattern has to overcome it before it can show anything.'
            : '';
        return `Nothing here holds up. ${luck}${costNote}`.trim();
    }

    function stretchText(r: MineResult): string {
        const s = r.segments;
        const span = (x: { fromTime: number; toTime: number }) => `${formatDay(x.fromTime)} → ${formatDay(x.toTime)}`;
        return `${ranOn}. Discovery ${span(s.discovery)} · Validation ${span(s.validation)} · Holdout ${span(s.holdout)}.`;
    }

    function patternCell(c: PatternCandidate, labels: ReadonlyMap<string, string>): HTMLTableCellElement {
        const td = doc.createElement('td');
        td.className = 'midorii-patterns-rule';
        for (const id of c.atoms) {
            const line = doc.createElement('span');
            line.textContent = labels.get(id) ?? id;
            td.appendChild(line);
        }
        return td;
    }

    function verdictCell(c: PatternCandidate): HTMLTableCellElement {
        const v = verdictOf(c);
        const td = doc.createElement('td');
        const tag = doc.createElement('span');
        tag.className = 'midorii-patterns-tag';
        if (v.tone !== 'muted') tag.dataset.tone = v.tone;
        tag.textContent = v.text;
        tag.title = v.title;
        td.appendChild(tag);
        return td;
    }

    function paintResult(): void {
        const r = result;
        resultCard.hidden = !r;
        resultCard.replaceChildren();
        if (!r) return;

        const head = doc.createElement('div');
        head.className = 'midorii-patterns-head';
        head.innerHTML = '<div class="midorii-patterns-eyebrow">Result</div><h2></h2>';
        head.querySelector('h2')!.textContent = `${r.candidates.length} distinct patterns, best first`;

        const content = doc.createElement('div');
        content.className = 'midorii-patterns-card-body midorii-figures';

        const note = doc.createElement('p');
        note.className = 'midorii-patterns-verdict';
        note.textContent = summaryText(r);

        const stretches = doc.createElement('p');
        stretches.className = 'midorii-patterns-stretches';
        stretches.textContent = stretchText(r);

        const tiles = tileGrid([
            tile('Patterns scored', r.tested.toLocaleString('en-US')),
            tile('Best score (t)', formatT(r.bestT)),
            tile('Luck reaches (t)', r.nullThreshold == null ? 'Not measured' : formatT(r.nullThreshold)),
            tile('Random entry', `${formatR(r.baseline.discovery.long)} / ${formatR(r.baseline.discovery.short)}`),
        ]);

        content.append(note, tiles, stretches);

        if (r.candidates.length === 0) {
            const empty = doc.createElement('p');
            empty.className = 'midorii-patterns-empty';
            empty.textContent = `No pattern traded ${r.minTrades} times on the discovery stretch. Lower the minimum, `
                + 'use fewer conditions, or give the search more history.';
            content.appendChild(empty);
        } else {
            const labels = new Map(r.atoms.map((a) => [a.id, a.label]));
            const wrap = doc.createElement('div');
            wrap.className = 'midorii-patterns-scroll';
            const table = doc.createElement('table');
            table.appendChild(headerRow([
                'Pattern', 'Verdict', 'Side', 'Discovery', 'Score (t)', 'Validation', 'Holdout',
                'Broker return', 'Broker DD',
            ]));
            const tbody = doc.createElement('tbody');
            for (const c of r.candidates) {
                const tr = doc.createElement('tr');
                tr.append(
                    patternCell(c, labels),
                    verdictCell(c),
                    cell(c.side === 'long' ? 'Long' : 'Short', { mono: false }),
                    cell(statsText(c.discovery), { sign: c.discovery.meanR }),
                    cell(formatT(c.discovery.t)),
                    cell(statsText(c.validation), { sign: c.validation.meanR }),
                    cell(c.holdout ? statsText(c.holdout) : 'Withheld', c.holdout ? { sign: c.holdout.meanR } : {}),
                    cell(c.engine ? formatPercent(c.engine.returnPct, 1, true) : '—', c.engine ? { sign: c.engine.returnPct } : {}),
                    cell(c.engine ? formatPercent(c.engine.maxDrawdownPct, 1) : '—'),
                );
                tbody.appendChild(tr);
            }
            table.appendChild(tbody);
            wrap.appendChild(table);
            content.appendChild(wrap);

            const foot = doc.createElement('p');
            foot.className = 'midorii-patterns-stretches';
            foot.style.marginTop = '12px';
            foot.textContent = 'Average R per trade after costs, then the number of trades. "Withheld": the holdout is '
                + 'only shown for patterns that passed validation, so it cannot become one more thing to pick by. '
                + 'Broker columns: the pattern run through the backtest engine over validation and holdout together, '
                + 'risking 1% per trade.';
            content.appendChild(foot);
        }

        resultCard.append(head, content);
    }

    /* ── reading ───────────────────────────────────────────────────────── */

    async function refresh(): Promise<void> {
        try {
            datasets = await window.midori.data.datasets();
        } catch (err) {
            datasets = [];
            say(err instanceof Error ? err.message : String(err), true);
        }
        if (!datasets.some((d) => d.symbol === symbol)) {
            const pick = datasets.find((d) => d.symbol === PREFERRED_SYMBOL) ?? datasets[0];
            symbol = pick?.symbol ?? '';
            resetRange(pick);
        }
        // Never rebuilt under a running search: the form is what that search was started from.
        if (!running) paintForm();
    }

    paintForm();
    return { refresh };
}
