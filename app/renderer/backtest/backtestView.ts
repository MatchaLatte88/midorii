import { timeframeToMs } from '../../../src';
import { NumberInput, Select, Switch, TextArea, TextField, injectStyles, overlayScrollbarCss } from '../../../src/ui';
import { runBacktest, type BacktestResult } from '../../../shared/engine/backtest';
import { MAX_COMBINATIONS, RANK_METRICS, countCombinations, detectionCount } from '../../../shared/analysis/sweep.js';
import type { RankMetricId, SweepEntry, SweepRanges } from '../../../shared/analysis/sweep';
import { buildStrategy, describeParams, detectionKeysOf, resolveStrategyParams, strategyCatalog } from '../strategies';
import type { StrategyInfo, StrategyParam, StrategyParams } from '../strategies';
import type { MidoriBar, MidoriDatasetMeta, MidoriSource, MidoriTrade } from '../midori';
import { formatDay, formatMoney } from '../format';
import { openCsvImportDialog } from '../data/csvImportDialog';
import { button, ensureFigureStyles, equityCurveSvg, sectionLabel, settingsGrid, statGrid, tile, tileGrid, tradesTable } from '../runs/runViews';
import { startSweep, type SweepHandle } from './sweepClient';
import type { SweepRun } from './sweepRunner';
import { ensureSweepStyles, overfitNote, sweepTable } from './sweepViews';

/**
 * The Backtest tab: pick a strategy, a market and a stretch of history, and see what the
 * rules would have done with it.
 *
 * The run happens here, in the renderer, not in the main process. A strategy is built on the
 * chart's own detectors, and those are TypeScript modules in the chart core; the main process
 * runs plain JavaScript off disk and cannot import them. Duplicating them there is the one
 * thing that must not happen — the chart and the backtest would drift apart about the same
 * market. So the bars come over the bridge, the loop runs here, and only the finished run goes
 * back to be stored.
 *
 * Every finished run that took a trade is filed in the library straight away. That is what
 * makes the Analysis tab worth opening: a result you have to remember to save is a result you
 * compare against nothing. A run that took no trades is not filed, and says so — an empty
 * account is a fact about the settings, not a result.
 *
 * Where the bars come from
 * ------------------------
 * Three ways in, one destination. The local library is whatever is already on this machine —
 * downloaded, or imported from a file through the button beside it. Picking a venue instead
 * fetches whatever the chosen range is missing before the run starts, and keeps it: the bars
 * are worth having. A second run over the same range costs nothing, the chart can be pointed
 * at exactly what was tested, and the run stays reproducible after the venue has rewritten its
 * own history.
 *
 * Fills inside the bar
 * -------------------
 * A bar that touches both the stop and the target says nothing about which came first, and the
 * engine's honest answer without more information is the pessimistic one: the stop. Replaying
 * the finer bars underneath the range replaces that guess with the order they actually
 * happened in. It costs the transfer of every one of them, which is why it is a switch and not
 * a silent default.
 *
 * One run, or a thousand
 * ----------------------
 * Sweep mode runs the same strategy over every combination of a set of ranges and ranks what
 * came back. It is a machine for overfitting unless it is used carefully, so it is built to
 * make that visible rather than comfortable: the range is split, the winners are re-checked on
 * the stretch that had no say in choosing them, and the worst rows are shown next to the best.
 * The work happens on a worker thread — a sweep is minutes to hours, and a page that stops
 * repainting for that long looks broken.
 */

const STYLE_ID = 'midorii-backtest';
const CSS = `
.midorii-backtest {
    position: absolute; inset: 0;
    display: flex; flex-direction: column;
    background: var(--vela-bg);
    color: var(--vela-fg);
    font: 13px/1.5 var(--vela-font, sans-serif);
}
.midorii-backtest-bar {
    flex: none;
    display: flex; align-items: center; gap: 10px;
    height: 34px; padding: 0 14px;
    border-bottom: 1px solid var(--vela-border);
    font-size: 12px; color: var(--vela-fg-muted);
}
.midorii-backtest-spacer { flex: 1 1 auto; }
.midorii-backtest-seg { display: inline-flex; gap: 2px; }
.midorii-backtest-tab {
    all: unset;
    padding: 4px 12px; border-radius: var(--vela-radius-sm);
    font-size: 12px; font-weight: 600; color: var(--vela-fg-muted); cursor: pointer;
}
.midorii-backtest-tab:hover { background: var(--vela-hover); color: var(--vela-fg-bright); }
.midorii-backtest-tab[data-active='1'] { background: var(--vela-active); color: var(--vela-fg-bright); }

.midorii-backtest-body { flex: 1 1 auto; min-height: 0; overflow: auto; }
${overlayScrollbarCss('.midorii-backtest-body')}
.midorii-backtest-inner { max-width: 1100px; margin: 0 auto; padding: 16px 18px 32px; }

.midorii-backtest-card {
    padding: 12px 14px; margin-bottom: 20px;
    background: var(--vela-surface);
    border: 1px solid var(--vela-border-faint);
    border-radius: var(--vela-radius-sm);
}
.midorii-backtest-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 2px; }
.midorii-backtest-head h2 { margin: 0; font-size: 15px; color: var(--vela-fg-bright); }
.midorii-backtest-sub { margin: 0 0 12px; color: var(--vela-fg-muted); font-size: 12px; }

.midorii-backtest-grid {
    display: grid; gap: 10px 18px;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}
.midorii-backtest-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    min-height: 26px;
}
.midorii-backtest-row > span:first-child { color: var(--vela-fg-muted); white-space: nowrap; }
.midorii-backtest-toggles { display: inline-flex; align-items: center; gap: 10px; }
.midorii-backtest-toggle { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; }

.midorii-backtest-date {
    background: var(--vela-surface-overlay); color: var(--vela-fg);
    border: 1px solid var(--vela-border-soft); border-radius: var(--vela-radius-sm);
    padding: 4px 8px; font: inherit; outline: none;
}
.midorii-backtest-actions { display: flex; align-items: center; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
.midorii-backtest-status { color: var(--vela-fg-muted); font-size: 12px; }
.midorii-backtest-status[data-error='1'] { color: var(--vela-danger); }
.midorii-backtest-empty { padding: 20px 4px 24px; color: var(--vela-fg-muted); line-height: 1.6; font-size: 12.5px; }

.midorii-backtest-dataset {
    margin: 8px 0 0; font-size: 12px; color: var(--vela-fg-muted); line-height: 1.5;
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
}
.midorii-backtest-hint { margin: 8px 0 0; font-size: 12px; color: var(--vela-fg-muted); line-height: 1.5; }

.midorii-backtest-progress {
    flex: 1 1 160px; height: 4px; min-width: 120px;
    background: var(--vela-surface-sunken); border-radius: 999px; overflow: hidden;
}
.midorii-backtest-progress > div { height: 100%; background: var(--vela-accent); transition: width 120ms linear; }

.midorii-backtest-sweeprow {
    display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 10px;
    min-height: 30px;
}
.midorii-backtest-sweeprow > span:first-child { color: var(--vela-fg-muted); }
.midorii-backtest-range { display: inline-flex; align-items: center; gap: 4px; }
.midorii-backtest-range > span { color: var(--vela-fg-muted); font-size: 11px; }
`;

/** The timeframes the tab offers, in Vela's canonical spelling. The store buckets any whole
 *  multiple of its base bar, so this is a menu rather than a limit. */
const TIMEFRAMES: ReadonlyArray<{ value: string; label: string }> = [
    { value: '1', label: '1m' },
    { value: '2', label: '2m' },
    { value: '3', label: '3m' },
    { value: '5', label: '5m' },
    { value: '15', label: '15m' },
    { value: '30', label: '30m' },
    { value: '60', label: '1h' },
    { value: '240', label: '4h' },
    { value: '480', label: '8h' },
    { value: 'D', label: '1d' },
];

/** How much history a fresh form asks for. Long enough to be worth reading, short enough to
 *  run while you wait. */
const DEFAULT_DAYS = 90;
const DAY = 86_400_000;
const MINUTE = 60_000;

/** The library, as a market source. Not a venue: nothing is fetched, it is already here. */
const LIBRARY = 'library';

/** How much of a sweep's range chooses the winners, as the menu offers it. */
const TRAIN_SPLITS: ReadonlyArray<{ value: string; label: string }> = [
    { value: '0.5', label: '50 / 50' },
    { value: '0.6', label: '60 / 40' },
    { value: '0.7', label: '70 / 30' },
    { value: '0.8', label: '80 / 20' },
    { value: '0', label: 'No split — optimise on everything' },
];

/** `YYYY-MM-DD` in UTC — the date input's own format, and the clock the ranges are in. */
function isoDate(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
    const el = document.createElement('label');
    el.className = 'midorii-backtest-row';
    const text = document.createElement('span');
    text.textContent = label;
    if (hint) text.title = hint;
    el.append(text, control);
    return el;
}

/** A duration a person reads at a glance: 90 s, 4 min, 1 h 12 min. */
function duration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const seconds = Math.round(ms / 1000);
    if (seconds < 90) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes} min`;
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export interface BacktestViewHandle {
    /** Re-read the datasets and repaint the form. Called whenever the tab is opened. */
    refresh(): Promise<void>;
}

/** Mount the Backtest tab into `host`. */
export function mountBacktestView(host: HTMLElement): BacktestViewHandle {
    const doc = host.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);
    ensureFigureStyles(doc);
    ensureSweepStyles(doc);

    const root = doc.createElement('div');
    root.className = 'midorii-backtest midorii-figures';

    const bar = doc.createElement('div');
    bar.className = 'midorii-backtest-bar';
    const barLabel = doc.createElement('span');
    barLabel.textContent = 'Backtest';
    const seg = doc.createElement('div');
    seg.className = 'midorii-backtest-seg';
    const spacer = doc.createElement('div');
    spacer.className = 'midorii-backtest-spacer';
    bar.append(barLabel, seg, spacer);

    const body = doc.createElement('div');
    body.className = 'midorii-backtest-body';
    const inner = doc.createElement('div');
    inner.className = 'midorii-backtest-inner';
    body.appendChild(inner);

    root.append(bar, body);
    host.appendChild(root);

    const catalog = strategyCatalog();

    /* ── the form ────────────────────────────────────────────────────────── */

    /** Single run, or every combination of a set of ranges. */
    let mode: 'single' | 'sweep' = 'single';
    let datasets: MidoriDatasetMeta[] = [];
    let venues: MidoriSource[] = [];
    let loadError: string | null = null;

    let strategyId = catalog[0]?.id ?? '';
    /** Where the bars come from: the local library, or a venue to fetch them from. */
    let origin = LIBRARY;
    let symbol = '';
    /** The market typed for a venue, which is not one of the library's names. */
    let venueSymbol = '';
    let timeframe = '5';
    let from = 0;
    let to = 0;
    let balance = 10_000;
    let intrabar = true;

    /** The form's current settings per strategy, so switching back does not lose them. */
    const settings = new Map<string, StrategyParams>();
    /** What each strategy is set to on the Strategies tab — where a fresh form starts. */
    let strategyDefaults: Record<string, Record<string, unknown>> = {};
    /** The defaults the form was last seeded from, so a change made on the other tab is
     *  noticed without throwing away an edit made on this one. */
    let seededFrom = '';
    /** The ranges a sweep varies, per strategy — the same thinking, kept apart. */
    const sweeps = new Map<string, SweepRanges>();
    let metric: RankMetricId = 'expectancy';
    let minTrades = 10;
    let trainFraction = 0.7;

    let running = false;
    let status: { text: string; error?: boolean } | null = null;
    let progress: { done: number; total: number; etaMs: number } | null = null;
    let handle: SweepHandle | null = null;

    let result: BacktestResult | null = null;
    let savedId: string | null = null;
    let sweepResult: SweepRun | null = null;
    let sweepSavedId: string | null = null;

    function strategy(): StrategyInfo | undefined {
        return catalog.find((s) => s.id === strategyId);
    }

    /**
     * The form's values for one strategy.
     *
     * Seeded from what the Strategies tab has that strategy set to, not from the schema's
     * bare defaults: that screen is where a strategy is configured, and a backtest that
     * ignored it would be testing something else. Changing a value here overrides it for
     * this run only — what the run stores is what it actually ran with.
     */
    function paramsFor(id: string): StrategyParams {
        let held = settings.get(id);
        if (!held) {
            try {
                held = resolveStrategyParams(id, strategyDefaults[id] ?? {});
            } catch (err) {
                /* Stored settings that no longer fit the schema. Falling back is right —
                 * refusing to open the tab over a stale config would not be — but it has to
                 * say so, because the form is now not what the Strategies tab shows. */
                status = {
                    text: `This strategy's stored settings no longer fit and were left out: `
                        + `${err instanceof Error ? err.message : String(err)}`,
                    error: true,
                };
                held = resolveStrategyParams(id, {});
            }
            settings.set(id, held);
        }
        return held;
    }

    function rangesFor(id: string): SweepRanges {
        let held = sweeps.get(id);
        if (!held) {
            held = {};
            sweeps.set(id, held);
        }
        return held;
    }

    /** The dataset the form is pointed at, when it is pointed at one. */
    function dataset(): MidoriDatasetMeta | undefined {
        return datasets.find((d) => d.symbol === market());
    }

    /** The market name in play, whichever source it comes from. */
    function market(): string {
        return origin === LIBRARY ? symbol : venueSymbol.trim().toUpperCase();
    }

    /**
     * How long one stored bar is for the market in play.
     *
     * Everything downloaded is a minute. An import is whatever the file carried, and that
     * decides both which timeframes can be asked for at all and what "minute-accurate
     * fills" can possibly mean.
     */
    function baseMs(): number {
        if (origin !== LIBRARY) return MINUTE;
        const meta = dataset();
        return Number.isFinite(meta?.baseMs) ? meta!.baseMs! : MINUTE;
    }

    /** The timeframes this market can actually be asked for — never finer than it holds. */
    function timeframes(): ReadonlyArray<{ value: string; label: string }> {
        const base = baseMs();
        return TIMEFRAMES.filter((t) => timeframeToMs(t.value) >= base);
    }

    /** The range a freshly picked market starts with: the last stretch it has data for. */
    function resetRange(meta: MidoriDatasetMeta | undefined): void {
        const last = meta?.last ?? Date.now();
        const first = meta?.first ?? last - DEFAULT_DAYS * DAY;
        to = last;
        from = Math.max(first, last - DEFAULT_DAYS * DAY);
    }

    /* ── reading ─────────────────────────────────────────────────────────── */

    async function refresh(): Promise<void> {
        try {
            const [nextDatasets, nextVenues, nextDefaults] = await Promise.all([
                window.midori.data.datasets(),
                window.midori.data.sources(),
                window.midori.strategies.load(),
            ]);
            datasets = nextDatasets;
            venues = nextVenues;

            /* Re-seed the form only when the Strategies tab actually changed something.
             * Doing it on every visit would discard a per-run override half typed in; never
             * doing it would leave this tab running settings the other one has replaced. */
            const signature = JSON.stringify(nextDefaults);
            if (signature !== seededFrom) {
                strategyDefaults = nextDefaults;
                seededFrom = signature;
                settings.clear();
            }
            loadError = null;
        } catch (err) {
            datasets = [];
            venues = [];
            loadError = err instanceof Error ? err.message : String(err);
        }
        if (origin === LIBRARY && !datasets.some((d) => d.symbol === symbol)) {
            symbol = datasets[0]?.symbol ?? '';
            resetRange(datasets[0]);
        }
        if (timeframes().every((t) => t.value !== timeframe)) {
            timeframe = timeframes()[0]?.value ?? '5';
        }
        paint();
    }

    /* ── running ─────────────────────────────────────────────────────────── */

    function say(text: string, error = false): void {
        status = { text, error };
        paint();
    }

    /** Lets the status paint before a synchronous loop takes the thread. */
    function nextFrame(): Promise<void> {
        return new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
    }

    /**
     * The bars the run needs, fetched from the venue first when there is one.
     *
     * Closed bars only. The engine must never see the bar currently forming — a strategy
     * acting on a bar that is still moving is reading the future.
     */
    async function loadBars(): Promise<{ bars: MidoriBar[]; baseBars: MidoriBar[] | null }> {
        const name = market();

        if (origin !== LIBRARY) {
            const venue = venues.find((v) => v.id === origin);
            say(`Checking what ${venue?.label ?? origin} has for ${name}…`);
            const off = window.midori.data.onDownloadProgress((p) => {
                if (p.symbol === name) say(`${p.label} — ${p.done} of ${p.total}`);
            });
            try {
                const ensured = await window.midori.data.ensure({ symbol: name, source: origin, from, to });
                if (ensured.missing.length > 0) {
                    say(`${venue?.label ?? origin} had nothing for ${ensured.missing.join(', ')}.`);
                }
            } finally {
                off();
            }
        }

        say('Loading bars…');
        const bars = await window.midori.data.bars({ symbol: name, timeframe, from, to, dropIncomplete: true });
        if (bars.length === 0) {
            throw new Error('No bars in that range — widen the range, or fetch this market first.');
        }

        /* A day past the end, so a trade still open at the boundary can finish against real
         * bars rather than being cut off mid-flight. */
        const base = baseMs();
        const finer = timeframeToMs(timeframe) > base;
        const baseBars = intrabar && finer
            ? await window.midori.data.bars({
                symbol: name,
                // Vela's canonical spelling is bare minutes, which is what every base bar is.
                timeframe: String(Math.round(base / MINUTE)),
                from,
                to: to + DAY,
                dropIncomplete: true,
            })
            : null;

        return { bars, baseBars };
    }

    /** What both modes have to agree about before either can start. */
    function guard(): boolean {
        if (!market()) {
            say(origin === LIBRARY
                ? 'No market data on this machine yet — import a file or download one first.'
                : 'Type the market to fetch.', true);
            return false;
        }
        if (!(to > from)) {
            say('The range has to end after it starts.', true);
            return false;
        }
        return true;
    }

    async function run(): Promise<void> {
        const spec = strategy();
        if (running || !spec || !guard()) return;

        running = true;
        result = null;
        savedId = null;
        sweepResult = null;
        paint();

        try {
            const { bars, baseBars } = await loadBars();

            say(`Running ${bars.length.toLocaleString()} bars…`);
            await nextFrame();

            const params = resolveStrategyParams(strategyId, paramsFor(strategyId));
            const built = buildStrategy(strategyId, params, bars);
            result = runBacktest({
                bars,
                baseBars,
                strategy: built,
                broker: { balance },
                stepMs: timeframeToMs(timeframe),
            });

            if (result.trades.length === 0) {
                status = { text: 'The strategy took no trades over this range — nothing was filed.' };
            } else {
                const summary = await window.midori.backtest.save({
                    ...result,
                    strategy: spec.id,
                    strategyName: spec.name,
                    params,
                    symbol: market(),
                    timeframe,
                    from: bars[0]!.time,
                    to: bars[bars.length - 1]!.time,
                });
                savedId = summary.id;
                status = { text: `Filed in the library · ${result.elapsedMs} ms · ${result.resolution} fills` };
            }
        } catch (err) {
            result = null;
            status = { text: err instanceof Error ? err.message : String(err), error: true };
        } finally {
            running = false;
            paint();
        }
    }

    async function runSweepNow(): Promise<void> {
        const spec = strategy();
        if (running || !spec || !guard()) return;

        const ranges = rangesFor(strategyId);
        const total = countCombinations(ranges);
        if (total === 0) {
            say('Switch on at least one setting to sweep.', true);
            return;
        }
        if (total > MAX_COMBINATIONS) {
            say(`That is ${total.toLocaleString()} combinations, over the limit of `
                + `${MAX_COMBINATIONS.toLocaleString()}. Widen a step or drop a parameter.`, true);
            return;
        }

        running = true;
        result = null;
        sweepResult = null;
        sweepSavedId = null;
        progress = null;
        paint();

        try {
            const { bars, baseBars } = await loadBars();

            say(`Sweeping ${total.toLocaleString()} combinations over ${bars.length.toLocaleString()} bars…`);
            /* The fixed half of the settings. Anything swept is overwritten per combination,
             * so what is left here is exactly what every run shares. */
            const base: Record<string, unknown> = { ...paramsFor(strategyId) };
            for (const key of Object.keys(ranges)) delete base[key];

            handle = startSweep({
                strategy: strategyId,
                ranges,
                base,
                bars,
                baseBars,
                from: bars[0]!.time,
                to: bars[bars.length - 1]!.time + timeframeToMs(timeframe),
                balance,
                stepMs: timeframeToMs(timeframe),
                trainFraction,
                metric,
                minTrades,
                onProgress: (p) => {
                    progress = { done: p.done, total: p.total, etaMs: p.etaMs };
                    paint();
                },
            });

            const finished = await handle.result;
            progress = null;

            if (!finished) {
                status = { text: 'The sweep was stopped. Nothing was filed.' };
                return;
            }

            sweepResult = finished;
            const summary = await window.midori.sweep.save({
                ...finished,
                strategyName: spec.name,
                symbol: market(),
                timeframe,
            });
            sweepSavedId = summary.id;
            status = {
                text: `Filed in the library · ${finished.combinationCount.toLocaleString()} combinations in `
                    + `${duration(finished.elapsedMs)} · ${finished.resolution} fills`,
            };
        } catch (err) {
            sweepResult = null;
            status = { text: err instanceof Error ? err.message : String(err), error: true };
        } finally {
            handle = null;
            running = false;
            progress = null;
            paint();
        }
    }

    async function annotate(note: string): Promise<void> {
        if (savedId) await window.midori.runs.annotate(savedId, note);
    }

    async function annotateSweep(note: string): Promise<void> {
        if (sweepSavedId) await window.midori.sweep.annotate(sweepSavedId, note);
    }

    /** Takes one combination's settings back into the form, ready to run in full. */
    function adopt(entry: SweepEntry): void {
        const held = paramsFor(strategyId);
        for (const [key, value] of Object.entries(entry.params)) {
            held[key] = value as StrategyParams[string];
        }
        mode = 'single';
        status = { text: 'Settings taken from the sweep. Run it to get the trades behind them.' };
        paint();
    }

    async function importCsv(): Promise<void> {
        try {
            const imported = await openCsvImportDialog(doc.body);
            await refresh();
            if (imported) {
                origin = LIBRARY;
                symbol = imported;
                resetRange(datasets.find((d) => d.symbol === imported));
                if (timeframes().every((t) => t.value !== timeframe)) {
                    timeframe = timeframes()[0]?.value ?? '5';
                }
                say(`${imported} is in the library.`);
            }
        } catch (err) {
            say(err instanceof Error ? err.message : String(err), true);
        }
    }

    /* ── drawing ─────────────────────────────────────────────────────────── */

    /** One field of a strategy's schema, as the control its type asks for. */
    function field(param: StrategyParam, values: StrategyParams): HTMLElement {
        if (param.type === 'select') {
            const select = new Select({
                options: [...(param.options ?? [])],
                value: String(values[param.key] ?? param.default),
                onChange: (v) => { values[param.key] = v; },
            });
            return row(param.label, select.el, param.hint);
        }

        if (param.type === 'multi') {
            const picked = new Set(Array.isArray(values[param.key]) ? (values[param.key] as readonly string[]) : []);
            const group = doc.createElement('div');
            group.className = 'midorii-backtest-toggles';
            for (const option of param.options ?? []) {
                const wrap = doc.createElement('label');
                wrap.className = 'midorii-backtest-toggle';
                const toggle = new Switch({
                    checked: picked.has(option.value),
                    size: 'sm',
                    onChange: (on) => {
                        if (on) picked.add(option.value);
                        else picked.delete(option.value);
                        // The schema's own order, not the order they were clicked in.
                        values[param.key] = (param.options ?? []).map((o) => o.value).filter((v) => picked.has(v));
                    },
                });
                const text = doc.createElement('span');
                text.textContent = option.label;
                wrap.append(toggle.el, text);
                group.appendChild(wrap);
            }
            return row(param.label, group, param.hint);
        }

        if (param.type === 'bool') {
            const toggle = new Switch({
                checked: values[param.key] === true,
                onChange: (on) => { values[param.key] = on; },
            });
            return row(param.label, toggle.el, param.hint);
        }

        const input = new NumberInput({
            value: Number(values[param.key] ?? param.default),
            min: param.min,
            max: param.max,
            step: param.step,
            integer: param.step === 1,
            fill: false,
            onChange: (v) => { values[param.key] = v; },
        });
        return row(param.label, input.el, param.hint);
    }

    /**
     * One numeric field as a sweep axis: a switch, and three inputs when it is on.
     *
     * A range that is switched off is not present in `ranges` at all rather than stored as
     * a range of one — the difference is what "swept" means, and a combination count is
     * built from exactly the keys that are there.
     */
    function sweepField(param: StrategyParam, values: StrategyParams, ranges: SweepRanges): HTMLElement {
        const el = doc.createElement('div');
        el.className = 'midorii-backtest-sweeprow';
        const text = doc.createElement('span');
        text.textContent = param.label;
        if (param.hint) text.title = param.hint;

        const controls = doc.createElement('div');
        controls.className = 'midorii-backtest-range';

        const current = ranges[param.key];
        const step = param.step ?? 1;

        if (current) {
            for (const [label, get, set] of [
                ['from', () => current.from, (v: number) => { current.from = v; }],
                ['to', () => current.to, (v: number) => { current.to = v; }],
                ['step', () => current.step, (v: number) => { current.step = v; }],
            ] as const) {
                const caption = doc.createElement('span');
                caption.textContent = label;
                const input = new NumberInput({
                    value: get(),
                    min: label === 'step' ? undefined : param.min,
                    max: label === 'step' ? undefined : param.max,
                    step,
                    integer: step === 1,
                    fill: false,
                    onChange: (v) => { set(v); paint(); },
                });
                controls.append(caption, input.el);
            }
        } else {
            const input = new NumberInput({
                value: Number(values[param.key] ?? param.default),
                min: param.min,
                max: param.max,
                step,
                integer: step === 1,
                fill: false,
                onChange: (v) => { values[param.key] = v; },
            });
            controls.appendChild(input.el);
        }

        const toggle = new Switch({
            checked: current != null,
            size: 'sm',
            onChange: (on) => {
                if (on) {
                    const value = Number(values[param.key] ?? param.default);
                    // Four steps out from where the form already stands: a range of one
                    // value is a fixed setting written the long way.
                    const end = param.max == null ? value + 4 * step : Math.min(param.max, value + 4 * step);
                    ranges[param.key] = { from: value, to: Math.max(value, end), step };
                } else {
                    delete ranges[param.key];
                }
                paint();
            },
        });
        const sweepLabel = doc.createElement('label');
        sweepLabel.className = 'midorii-backtest-toggle';
        const sweepText = doc.createElement('span');
        sweepText.textContent = 'Sweep';
        sweepLabel.append(toggle.el, sweepText);

        controls.appendChild(sweepLabel);
        el.append(text, controls);
        return el;
    }

    function card(title: string, sub?: string): HTMLElement {
        const el = doc.createElement('div');
        el.className = 'midorii-backtest-card';
        const head = doc.createElement('div');
        head.className = 'midorii-backtest-head';
        const h = doc.createElement('h2');
        h.textContent = title;
        head.appendChild(h);
        el.appendChild(head);
        if (sub) {
            const p = doc.createElement('p');
            p.className = 'midorii-backtest-sub';
            p.textContent = sub;
            el.appendChild(p);
        }
        return el;
    }

    /** What the picked market is, and the one destructive thing that can be done to it. */
    function datasetLine(): HTMLElement {
        const el = doc.createElement('p');
        el.className = 'midorii-backtest-dataset';

        if (origin !== LIBRARY) {
            const venue = venues.find((v) => v.id === origin);
            const text = doc.createElement('span');
            text.textContent = venue
                ? `${venue.naming} Whatever the range is missing is fetched before the run and kept.`
                : '';
            el.appendChild(text);
            return el;
        }

        const meta = dataset();
        if (!meta) return el;

        const text = doc.createElement('span');
        const range = meta.first != null && meta.last != null
            ? `${formatDay(meta.first)} – ${formatDay(meta.last)}`
            : 'empty';
        const origin_ = meta.importedFrom ? `imported from ${meta.importedFrom}` : `from ${meta.source ?? 'unknown'}`;
        text.textContent = `${meta.count.toLocaleString()} × ${meta.timeframe} bars · ${range} · ${origin_}`;
        el.appendChild(text);

        const remove = button('Remove', 'danger');
        remove.onclick = () => {
            if (remove.dataset.armed !== '1') {
                remove.dataset.armed = '1';
                remove.textContent = 'Remove — click again';
                return;
            }
            void window.midori.data.delete(meta.symbol)
                .then(() => refresh())
                .catch((err: unknown) => say(err instanceof Error ? err.message : String(err), true));
        };
        el.appendChild(remove);
        return el;
    }

    function paintForm(): void {
        const spec = strategy();
        if (!spec) return;

        const setup = card('Run', spec.description);
        const grid = doc.createElement('div');
        grid.className = 'midorii-backtest-grid';

        const strategySelect = new Select({
            options: catalog.map((s) => ({ value: s.id, label: s.name })),
            value: strategyId,
            onChange: (v) => {
                strategyId = v;
                result = null;
                savedId = null;
                sweepResult = null;
                status = null;
                paint();
            },
        });
        grid.appendChild(row('Strategy', strategySelect.el));

        const sourceSelect = new Select({
            options: [
                { value: LIBRARY, label: 'Local library' },
                ...venues.map((v) => ({ value: v.id, label: `Fetch from ${v.label}` })),
            ],
            value: origin,
            onChange: (v) => {
                origin = v;
                if (origin === LIBRARY) {
                    if (!datasets.some((d) => d.symbol === symbol)) symbol = datasets[0]?.symbol ?? '';
                    resetRange(dataset());
                } else if (!venueSymbol) {
                    venueSymbol = venues.find((s) => s.id === origin)?.example ?? '';
                }
                if (timeframes().every((t) => t.value !== timeframe)) {
                    timeframe = timeframes()[0]?.value ?? '5';
                }
                paint();
            },
        });
        grid.appendChild(row(
            'Market data',
            sourceSelect.el,
            'The library is what is already on this machine. A venue fetches whatever the '
            + 'range is missing before the run, and keeps it.',
        ));

        if (origin === LIBRARY) {
            const symbolSelect = new Select({
                options: datasets.map((d) => ({ value: d.symbol, label: d.symbol })),
                value: symbol,
                onChange: (v) => {
                    symbol = v;
                    resetRange(datasets.find((d) => d.symbol === v));
                    if (timeframes().every((t) => t.value !== timeframe)) {
                        timeframe = timeframes()[0]?.value ?? '5';
                    }
                    paint();
                },
            });
            grid.appendChild(row('Market', symbolSelect.el));
        } else {
            const venue = venues.find((v) => v.id === origin);
            const symbolField = new TextField({
                value: venueSymbol,
                fill: false,
                onChange: (v: string) => { venueSymbol = v; },
            });
            symbolField.input.placeholder = venue?.example ?? '';
            symbolField.input.addEventListener('input', () => { venueSymbol = symbolField.input.value; });
            grid.appendChild(row('Market', symbolField.el, venue?.naming));
        }

        const tfSelect = new Select({
            options: [...timeframes()],
            value: timeframe,
            onChange: (v) => { timeframe = v; paint(); },
        });
        grid.appendChild(row('Timeframe', tfSelect.el));

        const meta = origin === LIBRARY ? dataset() : undefined;
        for (const [label, get, set] of [
            ['From (UTC)', () => from, (v: number) => { from = v; }],
            ['To (UTC)', () => to, (v: number) => { to = v; }],
        ] as const) {
            const input = doc.createElement('input');
            input.type = 'date';
            input.className = 'midorii-backtest-date';
            input.value = isoDate(get());
            if (meta?.first != null) input.min = isoDate(meta.first);
            if (meta?.last != null) input.max = isoDate(meta.last);
            input.addEventListener('change', () => {
                const ms = Date.parse(`${input.value}T00:00:00Z`);
                if (Number.isFinite(ms)) set(ms);
            });
            grid.appendChild(row(label, input));
        }

        const balanceInput = new NumberInput({
            value: balance,
            min: 1,
            step: 1000,
            fill: false,
            onChange: (v) => { balance = v; },
        });
        grid.appendChild(row('Starting balance', balanceInput.el));

        const base = baseMs();
        const finer = timeframeToMs(timeframe) > base;
        const intrabarToggle = new Switch({
            checked: intrabar && finer,
            onChange: (on) => { intrabar = on; },
            disabled: !finer,
        });
        grid.appendChild(row(
            'Fine-grained fills',
            intrabarToggle.el,
            finer
                ? `Replay the ${base === MINUTE ? 'minutes' : 'finer bars'} inside each bar so a bar `
                    + 'that reaches both the stop and the target is settled by the order they happened '
                    + 'in, instead of the pessimistic guess. Loads every one of them.'
                : 'Unavailable: this market holds nothing finer than the timeframe being run.',
        ));

        setup.appendChild(grid);
        setup.appendChild(datasetLine());

        const actions = doc.createElement('div');
        actions.className = 'midorii-backtest-actions';

        const start = button(
            running ? 'Running…' : mode === 'sweep' ? 'Run sweep' : 'Run backtest',
            'primary',
        );
        start.disabled = running;
        start.onclick = () => void (mode === 'sweep' ? runSweepNow() : run());
        actions.appendChild(start);

        if (running && mode === 'sweep' && handle) {
            const stop = button('Stop');
            stop.onclick = () => {
                handle?.stop();
                say('Stopping after this combination…');
            };
            actions.appendChild(stop);
        }

        const importButton = button('Import CSV…');
        importButton.disabled = running;
        importButton.onclick = () => void importCsv();
        actions.appendChild(importButton);

        if (progress) {
            const track = doc.createElement('div');
            track.className = 'midorii-backtest-progress';
            const fill = doc.createElement('div');
            fill.style.width = `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%`;
            track.appendChild(fill);
            actions.appendChild(track);

            const count = doc.createElement('span');
            count.className = 'midorii-backtest-status';
            count.textContent = `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`
                + `${progress.etaMs > 0 ? ` · about ${duration(progress.etaMs)} left` : ''}`;
            actions.appendChild(count);
        }

        const statusEl = doc.createElement('span');
        statusEl.className = 'midorii-backtest-status';
        if (status) {
            statusEl.textContent = status.text;
            if (status.error) statusEl.dataset.error = '1';
        }
        actions.appendChild(statusEl);
        setup.appendChild(actions);
        inner.appendChild(setup);

        const values = paramsFor(strategyId);

        if (mode === 'single') {
            const tuning = card('Settings', 'Starting from what this strategy is set to on the '
                + 'Strategies tab. Change anything here and it applies to this run only — every value '
                + 'is stored with the run, so a result always says what produced it.');
            const paramGrid = doc.createElement('div');
            paramGrid.className = 'midorii-backtest-grid';
            for (const param of spec.params) paramGrid.appendChild(field(param, values));
            tuning.appendChild(paramGrid);
            inner.appendChild(tuning);
            return;
        }

        paintSweepForm(spec, values);
    }

    /** The settings card in sweep mode: every numeric field, with a range beside it. */
    function paintSweepForm(spec: StrategyInfo, values: StrategyParams): void {
        const ranges = rangesFor(spec.id);

        const tuning = card('Settings to sweep', 'Switch on the ones to vary and give each a range. '
            + 'Everything left switched off is held fixed at the value beside it, and stored with the '
            + 'sweep — a ranking that does not say what the other settings were is not reproducible.');

        const numeric = spec.params.filter((p) => p.type === 'number');
        const other = spec.params.filter((p) => p.type !== 'number');

        const list = doc.createElement('div');
        list.className = 'midorii-backtest-grid';
        for (const param of numeric) list.appendChild(sweepField(param, values, ranges));
        tuning.appendChild(list);

        if (other.length > 0) {
            tuning.appendChild(sectionLabel('Held fixed'));
            const fixed = doc.createElement('div');
            fixed.className = 'midorii-backtest-grid';
            // A sweep walks numbers. Anything else is a choice, and a choice is not a range.
            for (const param of other) fixed.appendChild(field(param, values));
            tuning.appendChild(fixed);
        }

        const combinations = countCombinations(ranges);
        const detections = detectionCount(ranges, detectionKeysOf(spec.id));
        const cost = doc.createElement('p');
        cost.className = 'midorii-backtest-hint';
        cost.textContent = combinations === 0
            ? 'Nothing is being swept yet.'
            : `${combinations.toLocaleString()} combinations, needing ${detections.toLocaleString()} `
                + `detection${detections === 1 ? '' : 's'}. Detection is nearly the whole cost of a run, `
                + 'so a sweep over the risk or the reward is quick and one over what counts as a setup '
                + 'is not.';
        if (combinations > MAX_COMBINATIONS) {
            cost.style.color = 'var(--vela-danger)';
            cost.textContent = `${combinations.toLocaleString()} combinations is over the limit of `
                + `${MAX_COMBINATIONS.toLocaleString()}. Widen a step or drop a parameter.`;
        }
        tuning.appendChild(cost);
        inner.appendChild(tuning);

        const ranking = card('Ranking', 'How the results are ordered, and what a result has to be before '
            + 'it is ranked at all.');
        const rankGrid = doc.createElement('div');
        rankGrid.className = 'midorii-backtest-grid';

        const metricSelect = new Select({
            options: Object.values(RANK_METRICS).map((m) => ({ value: m.id, label: m.label })),
            value: metric,
            onChange: (v) => { metric = v as RankMetricId; paint(); },
        });
        rankGrid.appendChild(row('Rank by', metricSelect.el, RANK_METRICS[metric].hint));

        const minTradesInput = new NumberInput({
            value: minTrades,
            min: 0,
            step: 1,
            integer: true,
            fill: false,
            onChange: (v) => { minTrades = v; },
        });
        rankGrid.appendChild(row(
            'At least this many trades',
            minTradesInput.el,
            'A combination that fired four times can top any measure by luck. Below this it is set '
            + 'aside rather than ranked badly — it is not evidence either way.',
        ));

        const splitSelect = new Select({
            options: [...TRAIN_SPLITS],
            value: String(trainFraction),
            onChange: (v) => { trainFraction = Number(v); paint(); },
        });
        rankGrid.appendChild(row(
            'Optimise / check',
            splitSelect.el,
            'How the range is split. Every combination runs on the earlier stretch; the best and '
            + 'worst few are re-run on the later one, which had no say in choosing them.',
        ));

        ranking.appendChild(rankGrid);
        if (trainFraction === 0) {
            const warn = doc.createElement('p');
            warn.className = 'midorii-backtest-hint';
            warn.style.color = 'var(--vela-danger)';
            warn.textContent = 'With no split, the best row is the combination that fitted these exact '
                + 'bars best. That is not the same as one that works.';
            ranking.appendChild(warn);
        }
        inner.appendChild(ranking);
    }

    function paintResult(): void {
        if (!result) return;
        const spec = strategy();

        const el = card(
            `${market()} · ${TIMEFRAMES.find((t) => t.value === timeframe)?.label ?? timeframe}`,
            `${spec?.name ?? strategyId} · ${formatDay(from)} – ${formatDay(to)} · `
            + `${formatMoney(result.initialBalance)} start · ${result.barCount.toLocaleString()} bars`,
        );

        el.appendChild(statGrid(result.stats));
        el.appendChild(equityCurveSvg(
            result.equityCurve,
            result.initialBalance,
            result.stats.netPnl,
            120,
        ));

        el.appendChild(sectionLabel('Settings'));
        el.appendChild(settingsGrid(describeParams(strategyId, paramsFor(strategyId))));

        if (result.trades.length > 0) {
            el.appendChild(sectionLabel('Trades'));
            el.appendChild(tradesTable(result.trades as readonly MidoriTrade[]));
        }

        if (savedId) {
            el.appendChild(sectionLabel('Note'));
            const note = new TextArea({
                rows: 2,
                placeholder: 'What this run was for…',
                onChange: (v: string) => void annotate(v),
            });
            el.appendChild(note.el);
        }

        inner.appendChild(el);
    }

    function paintSweepResult(): void {
        const sweep = sweepResult;
        if (!sweep) return;
        const spec = strategy();

        const el = card(
            `${market()} · ${TIMEFRAMES.find((t) => t.value === timeframe)?.label ?? timeframe}`,
            `${spec?.name ?? strategyId} · ${formatDay(sweep.from)} – ${formatDay(sweep.to)} · `
            + `${sweep.combinationCount.toLocaleString()} combinations in ${duration(sweep.elapsedMs)}`,
        );

        el.appendChild(tileGrid([
            tile('Combinations', sweep.combinationCount.toLocaleString()),
            tile('Ranked', sweep.rankedCount.toLocaleString()),
            tile('Set aside', sweep.excludedCount.toLocaleString()),
            tile('Optimised on', sweep.split
                ? `${sweep.split.trainBars.toLocaleString()} bars`
                : 'everything'),
        ]));

        el.appendChild(overfitNote(sweep.split != null));

        const labels = new Map((spec?.params ?? []).map((p) => [p.key, p.label]));
        el.appendChild(sweepTable({
            sweptKeys: Object.keys(sweep.ranges),
            labels,
            metric: sweep.metric,
            best: sweep.best,
            worst: sweep.worst,
            overlapping: sweep.overlapping,
            onPick: adopt,
        }));

        if (sweep.rankedCount === 0) {
            const none = doc.createElement('p');
            none.className = 'midorii-backtest-hint';
            none.textContent = `Nothing cleared ${sweep.minTrades} trades, so nothing was ranked. `
                + 'Either the range is too short for these settings, or they hardly ever fire.';
            el.appendChild(none);
        }

        el.appendChild(sectionLabel('Held fixed'));
        el.appendChild(settingsGrid(describeParams(strategyId, sweep.base)));

        if (sweepSavedId) {
            el.appendChild(sectionLabel('Note'));
            const note = new TextArea({
                rows: 2,
                placeholder: 'What this sweep was for…',
                onChange: (v: string) => void annotateSweep(v),
            });
            el.appendChild(note.el);
        }

        inner.appendChild(el);
    }

    function paint(): void {
        for (const [id, b] of modeButtons) {
            if (id === mode) b.dataset.active = '1';
            else delete b.dataset.active;
            b.disabled = running;
        }

        inner.replaceChildren();

        if (loadError !== null) {
            const empty = doc.createElement('p');
            empty.className = 'midorii-backtest-empty midorii-backtest-status';
            empty.dataset.error = '1';
            empty.textContent = `Could not read the data library: ${loadError}`;
            inner.appendChild(empty);
            return;
        }

        if (datasets.length === 0 && origin === LIBRARY && venues.length === 0) {
            const empty = doc.createElement('p');
            empty.className = 'midorii-backtest-empty';
            empty.textContent = 'No market data on this machine, and no venue to fetch any from.';
            inner.appendChild(empty);
            return;
        }

        /* An empty library is not an empty screen any more: the form still works against a
         * venue, and the Import button is on it. Only the market picker has nothing in it. */
        if (datasets.length === 0 && origin === LIBRARY) origin = venues[0]?.id ?? LIBRARY;

        paintForm();
        paintResult();
        paintSweepResult();
    }

    const modeButtons = new Map<'single' | 'sweep', HTMLButtonElement>();
    for (const [id, label] of [['single', 'Single run'], ['sweep', 'Sweep']] as const) {
        const b = doc.createElement('button');
        b.className = 'midorii-backtest-tab';
        b.textContent = label;
        b.onclick = () => {
            if (running) return;
            mode = id;
            status = null;
            paint();
        };
        modeButtons.set(id, b);
        seg.appendChild(b);
    }

    paint();
    return { refresh };
}
