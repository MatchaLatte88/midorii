import { Vela, timeframeToMs, type IndicatorHandle, type VelaTheme } from '../../../src';
import { isDarkColor } from '../../../src/core/color';
import { NumberInput, Select, Switch, TextArea, TextField, injectStyles, overlayScrollbarCss } from '../../../src/ui';
import { runBacktest, type BacktestResult } from '../../../shared/engine/backtest';
import { DEFAULT_COSTS, NO_COSTS } from '../../../shared/engine/broker.js';
import { MAX_COMBINATIONS, RANK_METRICS, countCombinations, detectionCount } from '../../../shared/analysis/sweep.js';
import type { RankMetricId, SweepEntry, SweepRanges } from '../../../shared/analysis/sweep';
import { buildStrategy, describeParams, detectionKeysOf, resolveStrategyParams, strategyCatalog } from '../strategies';
import type { StrategyInfo, StrategyParam, StrategyParams } from '../strategies';
import type { MidoriBar, MidoriDatasetMeta, MidoriSource, MidoriTrade } from '../midori';
import { formatDay, formatMoney, formatPrice, formatSignedMoney, formatSize, formatWhen } from '../format';
import { openCsvImportDialog } from '../data/csvImportDialog';
import { button, ensureFigureStyles, equityCurveSvg, sectionLabel, settingsGrid, statGrid, tile, tileGrid, tradesTable } from '../runs/runViews';
import { startSweep, type SweepHandle } from './sweepClient';
import type { SweepRun } from './sweepRunner';
import { ensureSweepStyles, overfitNote, sweepTable } from './sweepViews';
import { groupBacktestParams } from './formLayout';
import { badgeGroup, contextualParam } from '../strategies/paramFields';
import {
    BACKTEST_TRADE_REVIEW_TYPE,
    TRADE_INPUT,
    adjacentTradeIndex,
    registerBacktestTradeReview,
    tradePageBounds,
    tradePageFor,
    tradeReviewRange,
} from './tradeReview';

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
    height: 44px; padding: 0 20px;
    border-bottom: 1px solid var(--vela-border);
    background: var(--vela-chrome);
    font-size: 11px; color: var(--vela-fg-muted);
}
.midorii-backtest-bar > span:first-child {
    font-family: var(--vela-font-mono);
    font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase;
    opacity: 0.8;
}
.midorii-backtest-spacer { flex: 1 1 auto; }
.midorii-backtest-seg {
    display: inline-flex; align-items: center; gap: 2px;
    padding: 3px;
    border: 1px solid var(--vela-border-faint);
    border-radius: var(--vela-radius-md);
    background: var(--vela-surface-sunken);
}
.midorii-backtest-tab {
    all: unset;
    padding: 4px 12px; border-radius: var(--vela-radius-sm);
    font-size: 12px; font-weight: 600; color: var(--vela-fg-muted); cursor: pointer;
    transition: background var(--vela-dur-fast) ease, color var(--vela-dur-fast) ease, box-shadow var(--vela-dur-fast) ease;
}
.midorii-backtest-tab:hover { background: var(--vela-hover); color: var(--vela-fg-bright); }
.midorii-backtest-tab[data-active='1'] {
    background: var(--vela-surface-card); color: var(--vela-fg-bright);
    box-shadow: 0 1px 4px color-mix(in srgb, var(--vela-bg) 65%, transparent);
}

.midorii-backtest-body { flex: 1 1 auto; min-height: 0; overflow: auto; }
${overlayScrollbarCss('.midorii-backtest-body')}
.midorii-backtest-inner { max-width: 960px; margin: 0 auto; padding: 24px 20px 48px; }

.midorii-backtest-card {
    margin-bottom: 18px;
    background: var(--vela-surface-card);
    border: 1px solid var(--vela-border);
    border-radius: var(--vela-radius-xl);
    box-shadow: 0 14px 34px color-mix(in srgb, var(--vela-bg) 72%, transparent);
    overflow: hidden;
}
.midorii-backtest-head {
    padding: 17px 20px 15px;
    border-bottom: 1px solid var(--vela-border-faint);
    background: var(--vela-chrome);
}
.midorii-backtest-eyebrow {
    margin-bottom: 5px;
    font-family: var(--vela-font-mono);
    font-size: 9px; line-height: 1.2; letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--vela-fg-muted); opacity: 0.8;
}
.midorii-backtest-head h2 {
    margin: 0;
    font-size: 18px; line-height: 1.25; letter-spacing: -0.02em; font-weight: 600;
    color: var(--vela-fg-bright);
}
.midorii-backtest-sub {
    max-width: 760px;
    margin: 6px 0 0;
    color: var(--vela-fg-muted); font-size: 12px; line-height: 1.55;
}
.midorii-backtest-card-body { padding: 20px; }
.midorii-backtest-section + .midorii-backtest-section { margin-top: 22px; }
.midorii-backtest-section-title {
    margin: 0 0 4px;
    font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--vela-fg-muted);
}
.midorii-backtest-section-copy {
    margin: 0 0 12px;
    color: var(--vela-fg-muted); font-size: 11.5px; line-height: 1.5;
}

.midorii-backtest-grid {
    display: grid; gap: 14px 18px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
}
.midorii-backtest-market-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.midorii-backtest-row {
    display: flex; flex-direction: column; align-items: stretch; gap: 6px;
    min-width: 0;
}
.midorii-backtest-row > span:first-child {
    color: var(--vela-fg-muted);
    font-size: 11.5px; font-weight: 600; line-height: 1.3;
}
.midorii-backtest-row > :is(.vela-select, .vela-number, .vela-text) { width: 100%; }
.midorii-backtest-toggles {
    min-height: 34px;
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
}
.midorii-backtest-toggle {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--vela-fg); font-size: 12px;
}

.midorii-backtest-date {
    width: 100%; height: 34px; box-sizing: border-box;
    background: transparent; color: var(--vela-fg-bright);
    border: 1px solid var(--vela-border-strong); border-radius: 6px;
    padding: 0 9px; font: 14px var(--vela-font); outline: none;
    transition: border-color var(--vela-dur-fast) ease, box-shadow var(--vela-dur-fast) ease;
}
.midorii-backtest-date:hover { border-color: var(--vela-fg-muted); }
.midorii-backtest-date:focus { border-color: var(--vela-focus); box-shadow: 0 0 0 3px var(--vela-focus-soft); }
.midorii-backtest-actions {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 14px 20px;
    border-top: 1px solid var(--vela-border-faint);
    background: var(--vela-chrome);
}
.midorii-backtest-action-status {
    min-width: 0; flex: 1 1 auto;
    display: flex; align-items: center; gap: 10px;
}
.midorii-backtest-action-buttons { flex: none; display: flex; align-items: center; gap: 10px; }
.midorii-backtest-status { color: var(--vela-fg-muted); font-size: 12px; line-height: 1.4; }
.midorii-backtest-status:empty::before { content: 'Ready to run'; opacity: 0.75; }
.midorii-backtest-status[data-error='1'] { color: var(--vela-danger); }
.midorii-backtest-empty { padding: 24px; color: var(--vela-fg-muted); line-height: 1.6; font-size: 12.5px; }

.midorii-backtest-market-tools {
    display: flex; align-items: stretch; gap: 10px;
    margin-top: 16px;
}
.midorii-backtest-dataset {
    min-width: 0; flex: 1 1 auto;
    margin: 0; padding: 9px 10px 9px 12px;
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    border: 1px solid var(--vela-border-faint); border-radius: var(--vela-radius-md);
    background: var(--vela-surface-sunken);
    color: var(--vela-fg-muted); font-size: 11.5px; line-height: 1.45;
}
.midorii-backtest-dataset > span { min-width: 0; overflow-wrap: anywhere; }
.midorii-backtest-dataset .vela-dialog-btn,
.midorii-backtest-market-tools > .vela-dialog-btn {
    flex: none; height: 34px; padding-inline: 12px;
}
.midorii-backtest-disclosure {
    margin-top: 18px;
    border: 1px solid var(--vela-border-faint);
    border-radius: var(--vela-radius-lg);
    background: var(--vela-surface-sunken);
    overflow: hidden;
}
.midorii-backtest-disclosure > summary {
    position: relative;
    display: flex; align-items: center; gap: 12px;
    min-height: 48px; padding: 9px 42px 9px 13px;
    cursor: pointer; list-style: none;
    transition: background var(--vela-dur-fast) ease;
}
.midorii-backtest-disclosure > summary::-webkit-details-marker { display: none; }
.midorii-backtest-disclosure > summary:hover { background: var(--vela-hover); }
.midorii-backtest-disclosure > summary:focus-visible { outline: 2px solid var(--vela-focus); outline-offset: -2px; }
.midorii-backtest-disclosure > summary::after {
    content: '';
    position: absolute; right: 17px; top: 50%;
    width: 7px; height: 7px;
    border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
    color: var(--vela-fg-muted);
    transform: translateY(-65%) rotate(45deg);
    transition: transform var(--vela-dur-fast) ease;
}
.midorii-backtest-disclosure[open] > summary::after { transform: translateY(-35%) rotate(225deg); }
.midorii-backtest-disclosure-title {
    color: var(--vela-fg-bright); font-size: 12.5px; font-weight: 600;
}
.midorii-backtest-disclosure-meta {
    margin-left: auto;
    color: var(--vela-fg-muted); font-size: 11px; text-align: right;
}
.midorii-backtest-disclosure-body {
    padding: 15px 13px 14px;
    border-top: 1px solid var(--vela-border-faint);
    background: var(--vela-surface-card);
}
.midorii-backtest-hint { margin: 8px 0 0; font-size: 12px; color: var(--vela-fg-muted); line-height: 1.5; }

.midorii-backtest-progress {
    flex: 0 1 180px; height: 4px; min-width: 80px;
    background: var(--vela-surface-sunken); border-radius: 999px; overflow: hidden;
}
.midorii-backtest-progress > div { height: 100%; background: var(--vela-accent); transition: width 120ms linear; }

.midorii-backtest-sweeprow {
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--vela-border-faint); border-radius: var(--vela-radius-md);
    background: var(--vela-surface-sunken);
}
.midorii-backtest-sweephead {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.midorii-backtest-sweeptitle { min-width: 0; }
.midorii-backtest-sweeptitle > b {
    display: block; color: var(--vela-fg-bright); font-size: 12px; font-weight: 600;
}
.midorii-backtest-sweeptitle > span {
    display: block; margin-top: 2px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--vela-fg-muted); font-size: 10.5px;
}
.midorii-backtest-range {
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px;
    margin-top: 11px;
}
.midorii-backtest-range[data-fixed='1'] { grid-template-columns: minmax(0, 1fr); }
.midorii-backtest-range-field { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.midorii-backtest-range-field > span {
    color: var(--vela-fg-muted); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase;
}
.midorii-backtest-range-field > .vela-number { width: 100%; }
.midorii-backtest-estimate {
    margin: 16px 0 0; padding: 10px 12px;
    border-left: 2px solid var(--vela-accent-line);
    border-radius: 0 var(--vela-radius-sm) var(--vela-radius-sm) 0;
    background: var(--vela-accent-soft);
    color: var(--vela-fg); font-size: 11.5px; line-height: 1.5;
}

.midorii-backtest-review {
    overflow: hidden;
    border: 1px solid var(--vela-border);
    border-radius: var(--vela-radius-lg);
    background: var(--vela-surface-sunken);
}
.midorii-backtest-review-bar {
    min-height: 58px; padding: 10px 12px;
    display: flex; align-items: center; gap: 14px;
    border-bottom: 1px solid var(--vela-border-faint);
    background: var(--vela-chrome);
}
.midorii-backtest-review-readout {
    min-width: 0; flex: 1 1 auto;
    display: flex; align-items: center; gap: 10px;
}
.midorii-backtest-review-index {
    flex: none;
    padding: 3px 7px;
    border: 1px solid var(--vela-border-soft); border-radius: 999px;
    background: var(--vela-surface-card);
    color: var(--vela-fg-muted);
    font: 600 10px/1.2 var(--vela-font-mono);
    letter-spacing: 0.04em; text-transform: uppercase;
}
.midorii-backtest-review-copy { min-width: 0; }
.midorii-backtest-review-copy > b {
    display: block;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--vela-fg-bright); font-size: 12.5px; font-weight: 650;
}
.midorii-backtest-review-copy > span {
    display: block; margin-top: 2px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--vela-fg-muted); font: 10.5px/1.3 var(--vela-font-mono);
}
.midorii-backtest-review-net {
    flex: none;
    font: 700 13px/1 var(--vela-font-mono);
}
.midorii-backtest-review-net[data-sign='positive'] { color: var(--vela-up); }
.midorii-backtest-review-net[data-sign='negative'] { color: var(--vela-down); }
.midorii-backtest-review-nav { flex: none; display: flex; align-items: center; gap: 8px; }
.midorii-backtest-review-nav .vela-dialog-btn { white-space: nowrap; }
.midorii-backtest-review-chart {
    position: relative;
    height: 420px;
    background: var(--vela-bg);
}
.midorii-backtest-trade-list {
    overflow: hidden;
    border: 1px solid var(--vela-border-faint);
    border-radius: var(--vela-radius-lg);
}
.midorii-backtest-trade-list .midorii-backtest-trades { margin: 0; }
.midorii-backtest-pagination {
    min-height: 48px; padding: 8px 10px;
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    border-bottom: 1px solid var(--vela-border-faint);
    background: var(--vela-chrome);
}
.midorii-backtest-pagination-copy {
    min-width: 0;
    display: flex; align-items: baseline; gap: 8px;
    color: var(--vela-fg); font-size: 11.5px;
}
.midorii-backtest-pagination-page {
    color: var(--vela-fg-muted);
    font: 10.5px/1.2 var(--vela-font-mono);
    white-space: nowrap;
}
.midorii-backtest-pagination-nav { display: flex; align-items: center; gap: 8px; }
.midorii-backtest-pagination-nav .vela-dialog-btn { white-space: nowrap; }
.midorii-backtest-trades tbody tr[data-trade-index] {
    cursor: pointer;
    transition: background var(--vela-dur-fast) ease, box-shadow var(--vela-dur-fast) ease;
}
.midorii-backtest-trades tbody tr[data-trade-index]:hover { background: var(--vela-hover); }
.midorii-backtest-trades tbody tr[data-trade-index]:focus-visible {
    outline: 2px solid var(--vela-focus); outline-offset: -2px;
}
.midorii-backtest-trades tbody tr[aria-current='true'] {
    background: var(--vela-accent-soft);
    box-shadow: inset 2px 0 0 var(--vela-accent-line);
}

@media (max-width: 840px) {
    .midorii-backtest-market-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 720px) {
    .midorii-backtest-bar { height: 42px; padding-inline: 12px; }
    .midorii-backtest-inner { padding: 14px 12px 32px; }
    .midorii-backtest-card { border-radius: var(--vela-radius-lg); margin-bottom: 14px; }
    .midorii-backtest-head { padding: 15px 14px 13px; }
    .midorii-backtest-card-body { padding: 14px; }
    .midorii-backtest-grid { grid-template-columns: minmax(0, 1fr); gap: 13px; }
    .midorii-backtest-market-tools { flex-direction: column; }
    .midorii-backtest-dataset { align-items: flex-start; }
    .midorii-backtest-actions { align-items: stretch; flex-direction: column; padding: 12px 14px; }
    .midorii-backtest-action-status { min-height: 18px; }
    .midorii-backtest-action-buttons { justify-content: flex-end; }
    .midorii-backtest-action-buttons .vela-dialog-btn { flex: 1 1 auto; }
    .midorii-backtest-disclosure-meta { max-width: 48%; }
    .midorii-backtest-review-bar { align-items: stretch; flex-direction: column; }
    .midorii-backtest-review-nav { justify-content: flex-end; }
    .midorii-backtest-review-nav .vela-dialog-btn { flex: 1 1 auto; }
    .midorii-backtest-review-chart { height: 340px; }
    .midorii-backtest-pagination { align-items: stretch; flex-direction: column; }
    .midorii-backtest-pagination-copy { justify-content: space-between; }
    .midorii-backtest-pagination-nav .vela-dialog-btn { flex: 1 1 auto; }
}
@media (max-width: 430px) {
    .midorii-backtest-bar > span:first-child { display: none; }
    .midorii-backtest-seg { margin-inline: auto; }
    .midorii-backtest-range { grid-template-columns: minmax(0, 1fr); }
}
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
    /* A `<label>` forwards its clicks to the first labelable control inside it, and every
     * badge is a button — so around a radio group the wrapper has to be a plain div, or
     * clicking the words above it would quietly pick the leftmost option. */
    const grouped = control.getAttribute('role') === 'radiogroup';
    const el = document.createElement(grouped ? 'div' : 'label');
    el.className = 'midorii-backtest-row';
    if (grouped) el.setAttribute('aria-label', label);
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
    /** Current single-run figures for the app title bar. */
    summary(): BacktestAccountSummary;
    /** Re-read the datasets and repaint the form. Called whenever the tab is opened. */
    refresh(): Promise<void>;
    /** Keep the embedded result chart in step with the app palette. */
    setTheme(theme: VelaTheme): void;
}

export interface BacktestAccountSummary {
    balance: number;
    maxDrawdown: number;
    realised: number;
    unrealised: number;
}

export interface BacktestViewOptions {
    /** The current app palette. Read when a result chart is mounted. */
    theme: () => VelaTheme;
}

/** Mount the Backtest tab into `host`. */
export function mountBacktestView(host: HTMLElement, options: BacktestViewOptions): BacktestViewHandle {
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
    let timeframe = catalog[0]?.timeframe ?? '5';
    let from = 0;
    let to = 0;
    let balance = 10_000;
    let intrabar = true;
    /**
     * Whether the run is charged fees, spread and slippage at all.
     *
     * On by default, because a result that was never charged anything is not a result. Off
     * is the other half of the same question: what the rules alone are worth, with nothing
     * between the stop and the price it says. The gap between the two runs is the only
     * honest thing either number says about an edge.
     */
    let costsOn = true;
    /**
     * Money per point per unit. 1 unless the instrument says otherwise.
     *
     * The Broker was written against a coin, a share, a CFD unit — anything where a point
     * of price movement IS a point of account money. A futures contract is not: one gold
     * contract moving a point is a hundred dollars, and left at 1 every figure a run
     * reports — P&L, drawdown, fees, size — states that instrument a hundred times too
     * small. There is no honest default for this across instruments, so it stays 1 (a spot
     * assumption) until the person running the test says otherwise.
     */
    let pointValue = 1;
    /** The smallest a size may move by, or 0 for no step — a futures contract, a share lot. */
    let sizeStep = 0;
    /** The least a position may ever be, or 0 for no minimum. */
    let minSize = 0;

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

    /** Advanced choices stay out of the first scan, but reopening the form must not fold
     *  a section somebody was actively working in. Strategy-owned sections are remembered
     *  per strategy because switching strategies paints a different schema. */
    let runAdvancedOpen = false;
    const strategyAdvancedOpen = new Map<string, boolean>();
    const sweepAdvancedOpen = new Map<string, boolean>();

    let running = false;
    let status: { text: string; error?: boolean } | null = null;
    let progress: { done: number; total: number; etaMs: number } | null = null;
    let handle: SweepHandle | null = null;

    let result: BacktestResult | null = null;
    let savedId: string | null = null;
    let sweepResult: SweepRun | null = null;
    let sweepSavedId: string | null = null;

    /** The exact candles the current single run saw. The review chart stays offline so a
     *  later provider revision cannot make the evidence disagree with the result. */
    let resultBars: MidoriBar[] = [];
    let selectedTradeIndex = 0;
    let reviewChart: Vela | null = null;
    let reviewIndicator: IndicatorHandle | null = null;
    let reviewGeneration = 0;

    function disposeTradeReview(): void {
        reviewGeneration += 1;
        reviewIndicator = null;
        reviewChart?.destroy();
        reviewChart = null;
    }

    function setTheme(theme: VelaTheme): void {
        reviewChart?.setTheme(theme);
    }

    function summary(): BacktestAccountSummary {
        if (!result) {
            return { balance, maxDrawdown: 0, realised: 0, unrealised: 0 };
        }
        const last = result.equityCurve[result.equityCurve.length - 1];
        const settled = last?.balance ?? result.stats.finalEquity;
        const equity = last?.equity ?? result.stats.finalEquity;
        return {
            balance: settled,
            maxDrawdown: result.stats.maxDrawdown,
            realised: settled - result.initialBalance,
            unrealised: equity - settled,
        };
    }

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

    /** Switch to the timeframe a strategy's defaults were chosen for, when this market has it. */
    function applyPresetTimeframe(id: string): void {
        const preset = catalog.find((s) => s.id === id)?.timeframe;
        if (preset && timeframes().some((t) => t.value === preset)) timeframe = preset;
    }

    /**
     * The action row under the settings: back to the strategy's own defaults.
     *
     * Its own defaults, not the Strategies tab's saved values — this is the way back to the
     * configuration the strategy ships with, whatever either screen has been set to since.
     */
    function resetRow(spec: StrategyInfo): HTMLElement {
        const presetLabel = spec.timeframe ? TIMEFRAMES.find((t) => t.value === spec.timeframe)?.label ?? spec.timeframe : null;

        /* Always enabled: the fields above repaint only themselves, so a button that tracked
         * whether anything differs would go stale after the first edit. */
        const el = doc.createElement('div');
        el.className = 'midorii-backtest-actions';
        const note = doc.createElement('span');
        note.className = 'midorii-backtest-status';
        note.textContent = `Reset puts every setting here back on the strategy’s own defaults`
            + `${presetLabel ? `, on ${presetLabel}` : ''}.`;
        const reset = button('Reset to defaults');
        reset.onclick = () => {
            settings.set(spec.id, resolveStrategyParams(spec.id, {}));
            applyPresetTimeframe(spec.id);
            status = { text: 'Settings are back on the strategy’s own defaults.' };
            paint();
        };
        el.append(note, reset);
        return el;
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

        /* A day past the end. This does not close anything — the engine reports a
         * position still open at the last bar as it stands, on purpose, rather than
         * forcing an exit nobody decided (see runBacktest's own comment on `openAtEnd`).
         * What it guards is `makeSubBarLookup`: the last strategy bar's own window is
         * `[time, time + stepMs)`, and without this margin a `to` that lands a little
         * inside that window would hand the last bar an incomplete set of minutes to
         * resolve its fills against, understating exactly the bar most likely to still
         * be open. */
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
        resultBars = [];
        selectedTradeIndex = 0;
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
                broker: {
                    balance,
                    costs: costsOn ? undefined : NO_COSTS,
                    pointValue,
                    sizeStep: sizeStep > 0 ? sizeStep : null,
                    minSize: minSize > 0 ? minSize : null,
                },
                stepMs: timeframeToMs(timeframe),
            });
            resultBars = [...bars];

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
            resultBars = [];
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
        resultBars = [];
        selectedTradeIndex = 0;
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
                costs: costsOn ? null : NO_COSTS,
                pointValue,
                sizeStep: sizeStep > 0 ? sizeStep : null,
                minSize: minSize > 0 ? minSize : null,
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

    /**
     * One field of a strategy's schema, as the control its type asks for.
     *
     * `repaint` is called when a change alters what another field MEANS rather than what
     * it holds — picking percent over cash changes how the Risk beside it reads. Only the
     * badges ask for it: a number that has just been typed into must not be rebuilt
     * underneath the cursor.
     */
    function field(schemaField: StrategyParam, values: StrategyParams, repaint?: () => void): HTMLElement {
        const param = contextualParam(schemaField, values);
        if (param.type === 'select') {
            const current = String(values[param.key] ?? param.default);
            if (param.variant === 'badges') {
                const group = badgeGroup(doc, param.options ?? [], current, (v) => {
                    values[param.key] = v;
                    repaint?.();
                });
                return row(param.label, group, param.hint);
            }
            const select = new Select({
                options: [...(param.options ?? [])],
                value: current,
                fill: true,
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
            fill: true,
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

        const current = ranges[param.key];
        const step = param.step ?? 1;

        const head = doc.createElement('div');
        head.className = 'midorii-backtest-sweephead';
        const title = doc.createElement('span');
        title.className = 'midorii-backtest-sweeptitle';
        const name = doc.createElement('b');
        name.textContent = param.label;
        const state = doc.createElement('span');
        state.textContent = current == null
            ? `Fixed at ${String(values[param.key] ?? param.default)}`
            : `${current.from} to ${current.to}, step ${current.step}`;
        if (param.hint) title.title = param.hint;
        title.append(name, state);

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
        const vary = doc.createElement('label');
        vary.className = 'midorii-backtest-toggle';
        const varyText = doc.createElement('span');
        varyText.textContent = 'Vary';
        vary.append(toggle.el, varyText);
        head.append(title, vary);

        const controls = doc.createElement('div');
        controls.className = 'midorii-backtest-range';

        if (current) {
            for (const [label, get, set] of [
                ['from', () => current.from, (v: number) => { current.from = v; }],
                ['to', () => current.to, (v: number) => { current.to = v; }],
                ['step', () => current.step, (v: number) => { current.step = v; }],
            ] as const) {
                const field = doc.createElement('label');
                field.className = 'midorii-backtest-range-field';
                const caption = doc.createElement('span');
                caption.textContent = label;
                const input = new NumberInput({
                    value: get(),
                    min: label === 'step' ? undefined : param.min,
                    max: label === 'step' ? undefined : param.max,
                    step,
                    integer: step === 1,
                    fill: true,
                    onChange: (v) => { set(v); paint(); },
                });
                field.append(caption, input.el);
                controls.appendChild(field);
            }
        } else {
            controls.dataset.fixed = '1';
            const field = doc.createElement('label');
            field.className = 'midorii-backtest-range-field';
            const caption = doc.createElement('span');
            caption.textContent = 'Fixed value';
            const input = new NumberInput({
                value: Number(values[param.key] ?? param.default),
                min: param.min,
                max: param.max,
                step,
                integer: step === 1,
                fill: true,
                onChange: (v) => { values[param.key] = v; },
            });
            field.append(caption, input.el);
            controls.appendChild(field);
        }

        el.append(head, controls);
        return el;
    }

    interface CardParts {
        el: HTMLElement;
        body: HTMLElement;
    }

    function card(title: string, sub?: string, eyebrow = 'Backtest'): CardParts {
        const el = doc.createElement('div');
        el.className = 'midorii-backtest-card';
        const head = doc.createElement('div');
        head.className = 'midorii-backtest-head';
        const overline = doc.createElement('div');
        overline.className = 'midorii-backtest-eyebrow';
        overline.textContent = eyebrow;
        const h = doc.createElement('h2');
        h.textContent = title;
        head.append(overline, h);
        el.appendChild(head);
        if (sub) {
            const p = doc.createElement('p');
            p.className = 'midorii-backtest-sub';
            p.textContent = sub;
            head.appendChild(p);
        }
        const body = doc.createElement('div');
        body.className = 'midorii-backtest-card-body';
        el.appendChild(body);
        return { el, body };
    }

    function formSection(title: string, copy?: string): HTMLElement {
        const el = doc.createElement('section');
        el.className = 'midorii-backtest-section';
        const heading = doc.createElement('h3');
        heading.className = 'midorii-backtest-section-title';
        heading.textContent = title;
        el.appendChild(heading);
        if (copy) {
            const text = doc.createElement('p');
            text.className = 'midorii-backtest-section-copy';
            text.textContent = copy;
            el.appendChild(text);
        }
        return el;
    }

    interface DisclosureParts {
        el: HTMLDetailsElement;
        body: HTMLElement;
        meta: HTMLElement;
    }

    /** A quiet secondary layer. Native details/summary keeps it keyboard-operable and means
     *  hidden controls do not need a second state machine of their own. */
    function disclosure(
        title: string,
        description: string,
        open: boolean,
        onToggle: (open: boolean) => void,
    ): DisclosureParts {
        const el = doc.createElement('details');
        el.className = 'midorii-backtest-disclosure';
        el.open = open;
        const summary = doc.createElement('summary');
        const heading = doc.createElement('span');
        heading.className = 'midorii-backtest-disclosure-title';
        heading.textContent = title;
        const meta = doc.createElement('span');
        meta.className = 'midorii-backtest-disclosure-meta';
        meta.textContent = description;
        summary.append(heading, meta);
        const body = doc.createElement('div');
        body.className = 'midorii-backtest-disclosure-body';
        el.append(summary, body);
        el.addEventListener('toggle', () => onToggle(el.open));
        return { el, body, meta };
    }

    /** What the picked market is, and the one destructive thing that can be done to it. */
    function datasetLine(): HTMLElement {
        const el = doc.createElement('div');
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

        const remove = button('Remove data', 'danger');
        remove.onclick = () => {
            if (remove.dataset.armed !== '1') {
                remove.dataset.armed = '1';
                remove.textContent = 'Click again to remove';
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

        const setup = card(
            mode === 'sweep' ? 'Set up a parameter sweep' : 'Set up a backtest',
            spec.description,
        );

        const strategySection = formSection('Strategy');
        const strategyGrid = doc.createElement('div');
        strategyGrid.className = 'midorii-backtest-grid';

        const strategySelect = new Select({
            options: catalog.map((s) => ({ value: s.id, label: s.name })),
            value: strategyId,
            fill: true,
            onChange: (v) => {
                strategyId = v;
                applyPresetTimeframe(v);
                result = null;
                savedId = null;
                sweepResult = null;
                status = null;
                paint();
            },
        });
        strategyGrid.appendChild(row('Strategy', strategySelect.el));
        strategySection.appendChild(strategyGrid);
        setup.body.appendChild(strategySection);

        const marketSection = formSection(
            'Market and period',
            'Choose the history to test. Local data stays on this machine; a venue fills and keeps any missing bars.',
        );
        const marketGrid = doc.createElement('div');
        marketGrid.className = 'midorii-backtest-grid midorii-backtest-market-grid';

        const sourceSelect = new Select({
            options: [
                { value: LIBRARY, label: 'Local library' },
                ...venues.map((v) => ({ value: v.id, label: `Fetch from ${v.label}` })),
            ],
            value: origin,
            fill: true,
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
        marketGrid.appendChild(row('Data source', sourceSelect.el));

        if (origin === LIBRARY) {
            const symbolSelect = new Select({
                options: datasets.map((d) => ({ value: d.symbol, label: d.symbol })),
                value: symbol,
                fill: true,
                onChange: (v) => {
                    symbol = v;
                    resetRange(datasets.find((d) => d.symbol === v));
                    if (timeframes().every((t) => t.value !== timeframe)) {
                        timeframe = timeframes()[0]?.value ?? '5';
                    }
                    paint();
                },
            });
            marketGrid.appendChild(row('Market', symbolSelect.el));
        } else {
            const venue = venues.find((v) => v.id === origin);
            const symbolField = new TextField({
                value: venueSymbol,
                fill: true,
                onChange: (v: string) => { venueSymbol = v; },
            });
            symbolField.input.placeholder = venue?.example ?? '';
            symbolField.input.addEventListener('input', () => { venueSymbol = symbolField.input.value; });
            marketGrid.appendChild(row('Market', symbolField.el, venue?.naming));
        }

        const tfSelect = new Select({
            options: [...timeframes()],
            value: timeframe,
            fill: true,
            onChange: (v) => { timeframe = v; paint(); },
        });
        marketGrid.appendChild(row('Timeframe', tfSelect.el));

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
            marketGrid.appendChild(row(label, input));
        }

        marketSection.appendChild(marketGrid);

        const marketTools = doc.createElement('div');
        marketTools.className = 'midorii-backtest-market-tools';
        marketTools.appendChild(datasetLine());

        const importButton = button('Import market data…');
        importButton.disabled = running;
        importButton.onclick = () => void importCsv();
        marketTools.appendChild(importButton);
        marketSection.appendChild(marketTools);
        setup.body.appendChild(marketSection);

        const base = baseMs();
        const finer = timeframeToMs(timeframe) > base;
        const advanced = disclosure(
            'Advanced run settings',
            '',
            runAdvancedOpen,
            (open) => { runAdvancedOpen = open; },
        );
        const syncAdvancedSummary = (): void => {
            const fillSummary = finer ? (intrabar ? 'fine fills on' : 'fine fills off') : 'fine fills unavailable';
            const instrumentSummary = pointValue !== 1 ? ` · ${pointValue}/pt` : '';
            advanced.meta.textContent = `${formatMoney(balance)} start · `
                + `${costsOn ? 'costs on' : 'costs off'} · ${fillSummary}${instrumentSummary}`;
        };

        const balanceInput = new NumberInput({
            value: balance,
            min: 1,
            step: 1000,
            fill: true,
            onChange: (v) => { balance = v; syncAdvancedSummary(); },
        });
        const intrabarToggle = new Switch({
            checked: intrabar && finer,
            onChange: (on) => { intrabar = on; syncAdvancedSummary(); },
            disabled: !finer,
        });
        const costsToggle = new Switch({
            checked: costsOn,
            onChange: (on) => { costsOn = on; syncAdvancedSummary(); },
        });
        const pointValueInput = new NumberInput({
            value: pointValue,
            min: 0.0001,
            step: 1,
            fill: true,
            onChange: (v) => { pointValue = v; syncAdvancedSummary(); },
        });
        const sizeStepInput = new NumberInput({
            value: sizeStep,
            min: 0,
            step: 1,
            placeholder: 'none',
            emptyValue: 0,
            fill: true,
            onChange: (v) => { sizeStep = v; syncAdvancedSummary(); },
        });
        const minSizeInput = new NumberInput({
            value: minSize,
            min: 0,
            step: 1,
            placeholder: 'none',
            emptyValue: 0,
            fill: true,
            onChange: (v) => { minSize = v; syncAdvancedSummary(); },
        });
        const advancedGrid = doc.createElement('div');
        advancedGrid.className = 'midorii-backtest-grid';
        advancedGrid.appendChild(row('Starting balance', balanceInput.el));
        advancedGrid.appendChild(row(
            'Trading costs',
            costsToggle.el,
            'Commission, spread and slippage. The defaults are a crypto account’s '
                + `(${(DEFAULT_COSTS.feeRate * 100).toFixed(2)}% of notional per side, `
                + `${(DEFAULT_COSTS.spreadPct * 100).toFixed(2)}% spread, `
                + `${(DEFAULT_COSTS.slippagePct * 100).toFixed(2)}% slippage) and belong to no `
                + 'other instrument — on an index future that fee alone can be several times '
                + 'the trade’s entire risk. Off charges nothing: every stop fills exactly at the '
                + 'stop and every target exactly at the target, which is the ceiling of what the '
                + 'rules could ever make and not a result anybody could have had.',
        ));
        advancedGrid.appendChild(row(
            'Point value',
            pointValueInput.el,
            'Money per point per unit. 1 is a spot assumption — a coin, a share, a CFD unit, '
                + 'where a point of price movement is a point of account money. A futures '
                + 'contract is not: one gold contract moving a point is $100, and left at 1 '
                + 'every figure this run reports — P&L, drawdown, fees, size — states that '
                + 'instrument a hundred times too small.',
        ));
        advancedGrid.appendChild(row(
            'Size step',
            sizeStepInput.el,
            'The smallest a position may move by — a futures contract, a share lot. Sizes are '
                + 'rounded down onto it before an order is ever placed, the same rounding a '
                + 'live venue enforces, so a strategy cannot trade a fraction nobody could '
                + 'actually hold. Empty for an instrument with no step, such as a coin.',
        ));
        advancedGrid.appendChild(row(
            'Minimum size',
            minSizeInput.el,
            'The least a position may ever be. A size that rounds under it refuses rather '
                + 'than silently trading zero. Empty for no minimum.',
        ));
        advancedGrid.appendChild(row(
            'Fine-grained fills',
            intrabarToggle.el,
            finer
                ? `Replay the ${base === MINUTE ? 'minutes' : 'finer bars'} inside each bar so a bar `
                    + 'that reaches both the stop and the target is settled by the order they happened '
                    + 'in, instead of the pessimistic guess. Loads every one of them.'
                : 'Unavailable: this market holds nothing finer than the timeframe being run.',
        ));
        advanced.body.appendChild(advancedGrid);
        syncAdvancedSummary();
        setup.body.appendChild(advanced.el);

        const actions = doc.createElement('div');
        actions.className = 'midorii-backtest-actions';

        const actionStatus = doc.createElement('div');
        actionStatus.className = 'midorii-backtest-action-status';

        const actionButtons = doc.createElement('div');
        actionButtons.className = 'midorii-backtest-action-buttons';

        const start = button(
            running ? 'Running…' : mode === 'sweep' ? 'Run sweep' : 'Run backtest',
            'primary',
        );
        start.disabled = running;
        start.onclick = () => void (mode === 'sweep' ? runSweepNow() : run());

        if (running && mode === 'sweep' && handle) {
            const stop = button('Stop');
            stop.onclick = () => {
                handle?.stop();
                say('Stopping after this combination…');
            };
            actionButtons.appendChild(stop);
        }
        actionButtons.appendChild(start);

        if (progress) {
            const track = doc.createElement('div');
            track.className = 'midorii-backtest-progress';
            const fill = doc.createElement('div');
            fill.style.width = `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%`;
            track.appendChild(fill);
            actionStatus.appendChild(track);

            const count = doc.createElement('span');
            count.className = 'midorii-backtest-status';
            count.textContent = `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`
                + `${progress.etaMs > 0 ? ` · about ${duration(progress.etaMs)} left` : ''}`;
            actionStatus.appendChild(count);
        }

        const statusEl = doc.createElement('span');
        statusEl.className = 'midorii-backtest-status';
        if (status) {
            statusEl.textContent = status.text;
            if (status.error) statusEl.dataset.error = '1';
        }
        actionStatus.appendChild(statusEl);
        actions.append(actionStatus, actionButtons);
        setup.el.appendChild(actions);
        inner.appendChild(setup.el);

        const values = paramsFor(strategyId);

        if (mode === 'single') {
            const tuning = card(
                'Risk and size',
                'These values start from the Strategies tab and apply to this run only.',
                'Strategy settings',
            );
            const { common: risk, advanced: own } = groupBacktestParams(spec.params);

            const riskGrid = doc.createElement('div');
            riskGrid.className = 'midorii-backtest-grid';
            /* Only this grid, not the whole tab: picking cash over percent relabels the
             * field beside it, and repainting everything would throw away the result chart
             * underneath for a change that touched eight words. */
            const paintRisk = (): void => {
                riskGrid.replaceChildren();
                for (const param of risk) riskGrid.appendChild(field(param, values, paintRisk));
            };
            paintRisk();
            tuning.body.appendChild(riskGrid);

            if (own.length > 0) {
                const signalSettings = disclosure(
                    'Advanced signal rules',
                    `${own.length} inherited settings`,
                    strategyAdvancedOpen.get(spec.id) ?? false,
                    (open) => { strategyAdvancedOpen.set(spec.id, open); },
                );
                const signalIntro = formSection(
                    'What counts as a setup',
                    'Change these only when this run should test a different signal definition.',
                );
                const signalGrid = doc.createElement('div');
                signalGrid.className = 'midorii-backtest-grid';
                for (const param of own) signalGrid.appendChild(field(param, values));
                signalIntro.appendChild(signalGrid);
                signalSettings.body.appendChild(signalIntro);
                tuning.body.appendChild(signalSettings.el);
            }

            tuning.el.appendChild(resetRow(spec));
            inner.appendChild(tuning.el);
            return;
        }

        paintSweepForm(spec, values);
    }

    /** The settings card in sweep mode: every numeric field, with a range beside it. */
    function paintSweepForm(spec: StrategyInfo, values: StrategyParams): void {
        const ranges = rangesFor(spec.id);

        const tuning = card(
            'Choose what to vary',
            'Start with risk or reward. Signal-definition ranges take longer and stay under Advanced.',
            'Sweep settings',
        );

        const grouped = groupBacktestParams(spec.params);
        const common = grouped.common.filter((p) => p.type === 'number');
        const signal = grouped.advanced.filter((p) => p.type === 'number');
        const other = spec.params.filter((p) => p.type !== 'number');

        const list = doc.createElement('div');
        list.className = 'midorii-backtest-grid';
        for (const param of common) list.appendChild(sweepField(param, values, ranges));
        tuning.body.appendChild(list);

        if (signal.length > 0 || other.length > 0) {
            const advanced = disclosure(
                'Advanced strategy settings',
                `${signal.length} signal ranges · ${other.length} fixed choices`,
                sweepAdvancedOpen.get(spec.id) ?? false,
                (open) => { sweepAdvancedOpen.set(spec.id, open); },
            );
            if (signal.length > 0) {
                const signalSection = formSection(
                    'Signal ranges',
                    'These change which setups are detected and can make a sweep substantially slower.',
                );
                const signalGrid = doc.createElement('div');
                signalGrid.className = 'midorii-backtest-grid';
                for (const param of signal) signalGrid.appendChild(sweepField(param, values, ranges));
                signalSection.appendChild(signalGrid);
                advanced.body.appendChild(signalSection);
            }
            if (other.length > 0) {
                const fixedSection = formSection(
                    'Fixed choices',
                    'A sweep walks numeric ranges. These choices stay fixed for every combination.',
                );
                const fixed = doc.createElement('div');
                fixed.className = 'midorii-backtest-grid';
                for (const param of other) fixed.appendChild(field(param, values));
                fixedSection.appendChild(fixed);
                advanced.body.appendChild(fixedSection);
            }
            tuning.body.appendChild(advanced.el);
        }

        const combinations = countCombinations(ranges);
        const detections = detectionCount(ranges, detectionKeysOf(spec.id));
        const cost = doc.createElement('p');
        cost.className = 'midorii-backtest-estimate';
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
        tuning.body.appendChild(cost);
        tuning.el.appendChild(resetRow(spec));
        inner.appendChild(tuning.el);

        const ranking = card(
            'Ranking and confidence',
            'Choose how results are ordered and how much evidence a combination needs.',
            'Quality controls',
        );
        const rankGrid = doc.createElement('div');
        rankGrid.className = 'midorii-backtest-grid';

        const metricSelect = new Select({
            options: Object.values(RANK_METRICS).map((m) => ({ value: m.id, label: m.label })),
            value: metric,
            fill: true,
            onChange: (v) => { metric = v as RankMetricId; paint(); },
        });
        rankGrid.appendChild(row('Rank by', metricSelect.el, RANK_METRICS[metric].hint));

        const minTradesInput = new NumberInput({
            value: minTrades,
            min: 0,
            step: 1,
            integer: true,
            fill: true,
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
            fill: true,
            onChange: (v) => { trainFraction = Number(v); paint(); },
        });
        rankGrid.appendChild(row(
            'Optimise / check',
            splitSelect.el,
            'How the range is split. Every combination runs on the earlier stretch; the best and '
            + 'worst few are re-run on the later one, which had no say in choosing them.',
        ));

        ranking.body.appendChild(rankGrid);
        if (trainFraction === 0) {
            const warn = doc.createElement('p');
            warn.className = 'midorii-backtest-hint';
            warn.style.color = 'var(--vela-danger)';
            warn.textContent = 'With no split, the best row is the combination that fitted these exact '
                + 'bars best. That is not the same as one that works.';
            ranking.body.appendChild(warn);
        }
        inner.appendChild(ranking.el);
    }

    interface TradeReviewParts {
        el: HTMLElement;
        chartHost: HTMLElement;
        select(index: number): void;
    }

    /** Keep the requested span intact when a trade sits at the first or last candle. */
    function clampReviewRange(range: { from: number; to: number }): { from: number; to: number } {
        const step = timeframeToMs(timeframe);
        const first = resultBars[0]?.time ?? range.from;
        const last = (resultBars[resultBars.length - 1]?.time ?? range.to) + step;
        const available = Math.max(step, last - first);
        const span = Math.min(available, Math.max(step, range.to - range.from));
        let from_ = range.from;
        let to_ = range.to;
        if (from_ < first) {
            from_ = first;
            to_ = first + span;
        }
        if (to_ > last) {
            to_ = last;
            from_ = last - span;
        }
        return { from: Math.max(first, from_), to: Math.min(last, to_) };
    }

    function syncTradeRows(index: number): void {
        for (const row of inner.querySelectorAll<HTMLTableRowElement>('tr[data-trade-index]')) {
            if (Number(row.dataset.tradeIndex) === index) row.setAttribute('aria-current', 'true');
            else row.removeAttribute('aria-current');
        }
    }

    function frameTrade(trade: MidoriTrade): void {
        if (!reviewChart) return;
        reviewChart.setVisibleRange(clampReviewRange(tradeReviewRange(trade, timeframeToMs(timeframe))));
    }

    function tradeReviewPanel(
        trades: readonly MidoriTrade[],
        onSelect: (index: number) => void,
    ): TradeReviewParts {
        const el = doc.createElement('section');
        el.className = 'midorii-backtest-review';

        const toolbar = doc.createElement('div');
        toolbar.className = 'midorii-backtest-review-bar';

        const readout = doc.createElement('div');
        readout.className = 'midorii-backtest-review-readout';
        readout.setAttribute('aria-live', 'polite');

        const index = doc.createElement('span');
        index.className = 'midorii-backtest-review-index';

        const copy = doc.createElement('span');
        copy.className = 'midorii-backtest-review-copy';
        const title = doc.createElement('b');
        const detail = doc.createElement('span');
        copy.append(title, detail);

        const net = doc.createElement('span');
        net.className = 'midorii-backtest-review-net';
        readout.append(index, copy, net);

        const nav = doc.createElement('div');
        nav.className = 'midorii-backtest-review-nav';
        const previous = button('Previous trade');
        const next = button('Next trade', 'primary');
        nav.append(previous, next);
        toolbar.append(readout, nav);

        const chartHost = doc.createElement('div');
        chartHost.id = 'midorii-backtest-review-chart';
        chartHost.className = 'midorii-backtest-review-chart';
        chartHost.setAttribute('role', 'img');
        el.append(toolbar, chartHost);

        const select = (requested: number): void => {
            selectedTradeIndex = Math.max(0, Math.min(trades.length - 1, requested));
            const trade = trades[selectedTradeIndex]!;
            const side = trade.side === 'long' ? 'Long' : 'Short';

            index.textContent = `Trade ${selectedTradeIndex + 1} of ${trades.length}`;
            title.textContent = `${side} ${formatSize(trade.size)} · ${formatPrice(trade.entryPrice)} → ${formatPrice(trade.exitPrice)}`;
            detail.textContent = `${formatWhen(trade.openedAt)} → ${formatWhen(trade.closedAt)} UTC`;
            net.textContent = formatSignedMoney(trade.netPnl);
            if (trade.netPnl > 0) net.dataset.sign = 'positive';
            else if (trade.netPnl < 0) net.dataset.sign = 'negative';
            else delete net.dataset.sign;

            previous.disabled = selectedTradeIndex === 0;
            next.disabled = selectedTradeIndex === trades.length - 1;
            chartHost.setAttribute(
                'aria-label',
                `${side} trade ${selectedTradeIndex + 1} of ${trades.length}, `
                + `${formatPrice(trade.entryPrice)} to ${formatPrice(trade.exitPrice)}, `
                + `net ${formatSignedMoney(trade.netPnl)}`,
            );

            reviewIndicator?.setInput(TRADE_INPUT, JSON.stringify(trade));
            frameTrade(trade);
            syncTradeRows(selectedTradeIndex);
            onSelect(selectedTradeIndex);
        };

        previous.onclick = () => select(adjacentTradeIndex(selectedTradeIndex, trades.length, -1));
        next.onclick = () => select(adjacentTradeIndex(selectedTradeIndex, trades.length, 1));
        select(selectedTradeIndex);

        return { el, chartHost, select };
    }

    async function mountTradeReviewChart(
        chartHost: HTMLElement,
        trades: readonly MidoriTrade[],
        select: (index: number) => void,
        generation: number,
    ): Promise<void> {
        if (generation !== reviewGeneration || !chartHost.isConnected || resultBars.length === 0) return;

        registerBacktestTradeReview();
        const trade = trades[selectedTradeIndex] ?? trades[0]!;
        const chart = new Vela(chartHost, {
            symbol: market(),
            timeframe,
            data: resultBars,
            visibleRange: clampReviewRange(tradeReviewRange(trade, timeframeToMs(timeframe))),
            live: false,
            theme: options.theme(),
            height: '100%',
            drawings: false,
            volume: false,
            currentPriceLine: false,
            animations: false,
        });
        reviewChart = chart;

        try {
            await chart.ready();
            if (generation !== reviewGeneration || !chartHost.isConnected) {
                chart.destroy();
                if (reviewChart === chart) reviewChart = null;
                return;
            }

            reviewIndicator = chart.addNativeIndicator(BACKTEST_TRADE_REVIEW_TYPE, {
                inputs: { [TRADE_INPUT]: JSON.stringify(trade) },
            });
            select(selectedTradeIndex);
        } catch (err) {
            chart.destroy();
            if (reviewChart === chart) reviewChart = null;
            if (generation !== reviewGeneration || !chartHost.isConnected) return;
            chartHost.textContent = `Could not open the trade chart: ${err instanceof Error ? err.message : String(err)}`;
            chartHost.classList.add('midorii-backtest-empty');
        }
    }

    function paintResult(): void {
        if (!result) return;
        const spec = strategy();

        const resultCard = card(
            `${market()} · ${TIMEFRAMES.find((t) => t.value === timeframe)?.label ?? timeframe}`,
            `${spec?.name ?? strategyId} · ${formatDay(from)} – ${formatDay(to)} · `
            + `${formatMoney(result.initialBalance)} start · ${result.barCount.toLocaleString()} bars`,
            'Backtest result',
        );
        const el = resultCard.body;

        el.appendChild(statGrid(result.stats));
        el.appendChild(equityCurveSvg(
            result.equityCurve,
            result.initialBalance,
            result.stats.netPnl,
            120,
        ));

        const trades = result.trades as readonly MidoriTrade[];
        let tradeListPage = tradePageFor(selectedTradeIndex, trades.length);
        let renderTradeList = (): void => undefined;
        const review = trades.length > 0 && resultBars.length > 0
            ? tradeReviewPanel(trades, (index) => {
                const page = tradePageFor(index, trades.length);
                if (page === tradeListPage) {
                    syncTradeRows(index);
                    return;
                }
                tradeListPage = page;
                renderTradeList();
            })
            : null;
        if (review) {
            el.appendChild(sectionLabel('Trade review'));
            el.appendChild(review.el);
        }

        el.appendChild(sectionLabel('Settings'));
        el.appendChild(settingsGrid(describeParams(strategyId, paramsFor(strategyId))));

        if (trades.length > 0) {
            el.appendChild(sectionLabel('Trades'));
            const tradeList = doc.createElement('div');
            tradeList.className = 'midorii-backtest-trade-list';

            renderTradeList = (): void => {
                const bounds = tradePageBounds(tradeListPage, trades.length);
                tradeListPage = bounds.page;

                const table = tradesTable(trades.slice(bounds.from, bounds.to), review ? {
                    selectedIndex: selectedTradeIndex,
                    onSelect: review.select,
                    indexOffset: bounds.from,
                    totalCount: trades.length,
                } : {});
                table.classList.add('midorii-backtest-trades');

                if (bounds.pageCount <= 1) {
                    tradeList.replaceChildren(table);
                    return;
                }

                const pagination = doc.createElement('nav');
                pagination.className = 'midorii-backtest-pagination';
                pagination.setAttribute('aria-label', 'Trade list pages');

                const copy = doc.createElement('div');
                copy.className = 'midorii-backtest-pagination-copy';
                const range = doc.createElement('span');
                range.textContent = `Trades ${bounds.from + 1}–${bounds.to} of ${trades.length}`;
                const page = doc.createElement('span');
                page.className = 'midorii-backtest-pagination-page';
                page.textContent = `Page ${bounds.page + 1} of ${bounds.pageCount}`;
                copy.append(range, page);

                const nav = doc.createElement('div');
                nav.className = 'midorii-backtest-pagination-nav';
                const previous = button('Previous page');
                const next = button('Next page');
                previous.disabled = bounds.page === 0;
                next.disabled = bounds.page === bounds.pageCount - 1;
                const goToPage = (requested: number): void => {
                    const target = tradePageBounds(requested, trades.length);
                    if (review) review.select(target.from);
                    else {
                        tradeListPage = target.page;
                        renderTradeList();
                    }
                };
                previous.onclick = () => goToPage(bounds.page - 1);
                next.onclick = () => goToPage(bounds.page + 1);
                nav.append(previous, next);
                pagination.append(copy, nav);
                tradeList.replaceChildren(pagination, table);
            };

            renderTradeList();
            el.appendChild(tradeList);
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

        inner.appendChild(resultCard.el);
        if (review) {
            review.select(selectedTradeIndex);
            const generation = reviewGeneration;
            void mountTradeReviewChart(review.chartHost, trades, review.select, generation);
        }
    }

    function paintSweepResult(): void {
        const sweep = sweepResult;
        if (!sweep) return;
        const spec = strategy();

        const resultCard = card(
            `${market()} · ${TIMEFRAMES.find((t) => t.value === timeframe)?.label ?? timeframe}`,
            `${spec?.name ?? strategyId} · ${formatDay(sweep.from)} – ${formatDay(sweep.to)} · `
            + `${sweep.combinationCount.toLocaleString()} combinations in ${duration(sweep.elapsedMs)}`,
            'Sweep result',
        );
        const el = resultCard.body;

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

        inner.appendChild(resultCard.el);
    }

    function paint(): void {
        disposeTradeReview();
        const background = getComputedStyle(root).getPropertyValue('--vela-bg').trim();
        root.style.colorScheme = isDarkColor(background) ? 'dark' : 'light';

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
    return { refresh, setTheme, summary };
}
