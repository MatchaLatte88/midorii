import type { BacktestBar, BacktestResult } from '../../../shared/engine/backtest';
import { runBacktest } from '../../../shared/engine/backtest';
import { DEFAULT_COSTS } from '../../../shared/engine/broker.js';
import {
    bestAndWorst, expandSweep, rankResults, splitRange,
} from '../../../shared/analysis/sweep.js';
import type { RankMetricId, SweepEntry, SweepRanges, SweepStats } from '../../../shared/analysis/sweep';
import type { Costs } from '../../../shared/engine/broker';
import { buildStrategy, resolveStrategyParams, type DetectionCache } from '../strategies';

/**
 * Running every combination of a sweep, and checking the winners.
 *
 * Deliberately free of worker plumbing: the loop takes a progress callback and a "should I
 * stop" callback, so it runs the same way inside a worker, inside a test, and from a
 * script. `sweep.worker.ts` is the thin wrapper that gives it a thread; nothing in here
 * knows that thread exists.
 *
 * Two stretches, and why
 * ----------------------
 * A sweep is a machine for overfitting. Try a thousand combinations on one set of bars,
 * keep the best, and what you have found is the combination that memorised those bars — it
 * will look excellent and mean nothing.
 *
 * So the range is split. Every combination runs on the earlier stretch, and only the
 * handful that are actually going to be shown are re-run on the later one, which had no
 * say in choosing them. Two numbers per combination, and the gap between them is the
 * finding: a setting whose out-of-sample result collapses was fitted to noise, and a sweep
 * that reported only the first number would have hidden that.
 *
 * Re-running only the shown ones is a deliberate economy. Checking all 1,615 would double
 * the cost of the sweep to produce numbers nobody will look at.
 *
 * What makes this affordable
 * --------------------------
 * One detection cache per stretch. On a year of BTC 5m the detection is essentially the
 * whole cost of a run, and parameters like the reward-to-risk do not change what was
 * detected — only what the strategy does about it. A sweep of nineteen reward levels
 * therefore detects once, not nineteen times. The cache is per stretch because it is keyed
 * by parameters and not by bars: sharing one between train and test would report the
 * training period's setups against the test period's bars.
 */

/** Raised when a sweep is stopped on request, so a caller can tell it apart from a fault. */
export class SweepCancelled extends Error {
    constructor() {
        super('The sweep was stopped');
        this.name = 'SweepCancelled';
    }
}

/** How often the loop hands the thread back, in ms. Long enough to cost nothing, short
 *  enough that Stop is felt as a click rather than as a wait. */
const BREATHE_EVERY_MS = 30;

export interface SweepProgress {
    done: number;
    total: number;
    elapsedMs: number;
    /** Projected from the average so far. Honest about being an estimate: later
     *  combinations are not guaranteed to cost what earlier ones did. */
    etaMs: number;
}

export interface SweepOptions {
    strategy: string;
    ranges: SweepRanges;
    /** The settings every combination shares. */
    base?: Record<string, unknown>;
    bars: readonly BacktestBar[];
    /** Minute bars for intrabar fills, covering the same span. */
    baseBars?: readonly BacktestBar[] | null;
    from: number;
    to: number;
    balance?: number;
    /** What every combination is charged. Null takes the Broker's defaults. */
    costs?: Costs | null;
    /** Money per point per unit. 1 unless the instrument says otherwise — see
     *  `Broker.pointValue`. */
    pointValue?: number;
    /** The smallest a size may move by, or null for no step — see `Broker.sizeStep`. */
    sizeStep?: number | null;
    /** The least a position may ever be, or null — see `Broker.minSize`. */
    minSize?: number | null;
    stepMs?: number | null;
    /** How much of the range chooses the winners. 0 runs the whole range and checks
     *  nothing, which is a sweep with no defence against itself. */
    trainFraction?: number;
    metric?: RankMetricId;
    /** Below this a combination is set aside rather than ranked — see rankResults. */
    minTrades?: number;
    /** How many at each end get re-checked out of sample. */
    showCount?: number;
    onProgress?: (p: SweepProgress) => void;
    shouldStop?: () => boolean;
}

/** Everything a finished sweep reports, minus what the store stamps on it. */
export interface SweepRun {
    strategy: string;
    ranges: SweepRanges;
    base: Record<string, unknown>;
    from: number;
    to: number;
    balance: number;
    /** What every combination was actually charged — stored, because two sweeps run with
     *  different costs are not comparable and nothing else in here would say so. */
    costs: Required<Costs>;
    /** The instrument every combination was actually charged in — same reasoning as
     *  `costs`. A sweep stored without these could not be told apart from one run
     *  against a plain spot instrument. */
    pointValue: number;
    sizeStep: number | null;
    minSize: number | null;
    metric: RankMetricId;
    minTrades: number;
    trainFraction: number;
    split: {
        train: { from: number; to: number };
        test: { from: number; to: number };
        trainBars: number;
        testBars: number;
    } | null;
    combinationCount: number;
    /** Every combination's in-sample figures, so the whole surface can be re-sorted
     *  without running it again. */
    results: SweepEntry[];
    rankedCount: number;
    excludedCount: number;
    best: SweepEntry[];
    worst: SweepEntry[];
    overlapping: boolean;
    elapsedMs: number;
    resolution: 'intrabar' | 'pessimistic';
}

/** Only the figures worth keeping for every combination — there can be thousands. */
function summarize(result: BacktestResult): SweepStats {
    const s = result.stats;
    return {
        tradeCount: s.tradeCount,
        netPnl: s.netPnl,
        returnPct: s.returnPct,
        winRate: s.winRate,
        maxDrawdownPct: s.maxDrawdownPct,
        profitFactor: s.profitFactor,
        expectancy: s.expectancy,
        feesPaid: s.feesPaid,
    };
}

/**
 * The bars inside a half-open range.
 *
 * Half-open on purpose: the training stretch ends where the test stretch begins, and a bar
 * counted in both would let a combination be chosen partly on a bar it is then checked
 * against.
 */
export function sliceBars(bars: readonly BacktestBar[], from: number, to: number): BacktestBar[] {
    const out: BacktestBar[] = [];
    for (const bar of bars) {
        if (bar.time < from) continue;
        if (bar.time >= to) break;
        out.push(bar);
    }
    return out;
}

/**
 * Moves a split's boundary onto the start of an actual bar.
 *
 * `splitRange` cuts by a fraction of the clock, which almost never lands on a bar's own
 * start — bars have gaps (a session close, a halt), so the arithmetic cut can fall inside
 * one. Slicing there is fine for the bar itself, which simply goes whole to whichever side
 * it belongs on; it is NOT fine for what is underneath it. `makeSubBarLookup` in the engine
 * hands a bar every one of its own minutes, keyed by that bar's own start — so a cut inside
 * the bar would still give the WHOLE bar, minutes included, to one side, while `sliceBars`
 * on the base-bar array (keyed by minute, not by parent bar) would divide those same
 * minutes between train and test by raw timestamp. A fill that happened in the half of the
 * bar assigned to the other side would then be invisible to intrabar resolution, silently,
 * on every sweep that does not happen to land its split exactly on a bar.
 *
 * Rounding forward — to the next bar at or after the arithmetic cut — keeps the split
 * half-open exactly like `sliceBars` already reads it: the bar found becomes the first bar
 * of test, never a bar shared between the two.
 */
export function alignSplitToBars(
    split: { train: { from: number; to: number }; test: { from: number; to: number } },
    bars: readonly BacktestBar[],
): { train: { from: number; to: number }; test: { from: number; to: number } } {
    const cut = bars.find((b) => b.time >= split.train.to)?.time ?? bars[bars.length - 1]!.time;
    return { train: { from: split.train.from, to: cut }, test: { from: cut, to: split.test.to } };
}

/**
 * Hands the thread back so a posted Stop can be read.
 *
 * A worker never yields to its own message queue while a loop is running, so a stop sent
 * as a message would not arrive until the sweep had already finished. A macrotask between
 * combinations is what makes the button work. `MessageChannel` rather than `setTimeout`,
 * whose minimum delay would add four milliseconds to every combination.
 */
export function breathe(): Promise<void> {
    return new Promise((resolve) => {
        if (typeof MessageChannel === 'function') {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => {
                channel.port1.close();
                resolve();
            };
            channel.port2.postMessage(null);
            return;
        }
        setTimeout(resolve, 0);
    });
}

/**
 * Runs one strategy over every combination of the given ranges.
 *
 * Async only so it can put the thread down between combinations; nothing here awaits any
 * real work. A sweep that never yielded would finish just as fast and ignore every attempt
 * to stop it.
 */
export async function runSweep(options: SweepOptions): Promise<SweepRun> {
    const {
        strategy: strategyId, ranges, base = {}, bars, baseBars = null, from, to,
        balance = 10_000, costs = null, pointValue = 1, sizeStep = null, minSize = null,
        stepMs = null, trainFraction = 0.7, metric = 'expectancy',
        minTrades = 10, showCount = 4, onProgress, shouldStop,
    } = options;

    /* Resolved once, so the figure stored on the run is the one every combination paid
     * rather than the override it was handed — a sweep that stored `{}` would claim to
     * have been free. Same reasoning as `costs` on a single run. */
    const charged: Required<Costs> = { ...DEFAULT_COSTS, ...(costs ?? {}) };
    const broker = { balance, costs: charged, pointValue, sizeStep, minSize };

    if (!Array.isArray(bars) || bars.length === 0) throw new Error('runSweep: no bars to run on');

    const combinations = expandSweep(ranges, base);
    if (combinations.length === 0) throw new Error('runSweep: no ranges to sweep');

    /* Validated once, before anything runs. A bad step that only shows up on combination
     * 900 would waste everything up to it. */
    for (const params of combinations) resolveStrategyParams(strategyId, params);

    const rawSplit = trainFraction > 0 ? splitRange(from, to, trainFraction) : null;
    const split = rawSplit ? alignSplitToBars(rawSplit, bars) : null;
    const trainBars = split ? sliceBars(bars, split.train.from, split.train.to) : bars;
    /* The out-of-sample run gets everything from the very start of the loaded range as
     * warm-up, not just its own slice — a detector with a long window (a 200-session
     * average, say) would otherwise never produce a value inside a short test stretch and
     * silently take no trades at all, which reads as "the setting doesn't hold" when what
     * actually happened is "it never got to run". `tradeFrom` below keeps the ledger
     * honest: nothing before the test period counts as a decision the test period made. */
    const testBars = split ? sliceBars(bars, bars[0]!.time, split.test.to) : [];
    const trainBase = baseBars && split ? sliceBars(baseBars, split.train.from, split.train.to) : baseBars;
    const testBase = baseBars && split ? sliceBars(baseBars, bars[0]!.time, split.test.to) : null;

    if (trainBars.length === 0) {
        throw new Error('runSweep: the optimisation stretch contains no bars');
    }

    const startedAt = Date.now();
    const trainCache: DetectionCache = new Map();
    const results: SweepEntry[] = [];
    let lastBreath = startedAt;

    for (let i = 0; i < combinations.length; i++) {
        if (shouldStop?.()) throw new SweepCancelled();

        const params = combinations[i]!;
        const result = runBacktest({
            bars: trainBars,
            baseBars: trainBase,
            strategy: buildStrategy(strategyId, params, trainBars, trainCache),
            broker,
            stepMs,
        });

        results.push({ params, stats: summarize(result) });

        const now = Date.now();
        onProgress?.({
            done: i + 1,
            total: combinations.length,
            elapsedMs: now - startedAt,
            etaMs: Math.round(((now - startedAt) / (i + 1)) * (combinations.length - i - 1)),
        });

        if (now - lastBreath >= BREATHE_EVERY_MS) {
            await breathe();
            lastBreath = Date.now();
        }
    }

    const { ranked, excluded } = rankResults(results, metric, minTrades);
    const ends = bestAndWorst(ranked, showCount);

    /* The out-of-sample check, on bars that had no say in the ranking. Its own cache: the
     * key is the parameters, so reusing the training one here would hand these runs the
     * training period's detections. */
    const testCache: DetectionCache = new Map();
    const verify = (entry: SweepEntry): SweepEntry => {
        if (testBars.length === 0) return entry;
        const result = runBacktest({
            bars: testBars,
            baseBars: testBase,
            strategy: buildStrategy(strategyId, entry.params, testBars, testCache),
            broker,
            stepMs,
            // testBars runs from the start of the whole loaded range for warm-up; only
            // the test period itself may become a fill, a trade, or an equity point.
            tradeFrom: split!.test.from,
        });
        return { ...entry, outOfSample: summarize(result) };
    };

    return {
        strategy: strategyId,
        ranges,
        base,
        from,
        /* The last bar's own time, not the exclusive bound `to` was given as. `sliceBars`
         * needs one bar-width past the last bar to include it — see the split above — but
         * that is an implementation detail of a half-open range, not what the range
         * covers. A single backtest stores the same bar's own time for the same field, and
         * a sweep whose stored range read one bar later would look like it covered
         * different bars than a single run made over the identical stretch. */
        to: bars[bars.length - 1]!.time,
        balance,
        costs: charged,
        pointValue,
        sizeStep,
        minSize,
        metric,
        minTrades,
        trainFraction,
        split: split && {
            train: split.train,
            test: split.test,
            trainBars: trainBars.length,
            testBars: testBars.length,
        },
        combinationCount: combinations.length,
        results,
        rankedCount: ranked.length,
        excludedCount: excluded.length,
        best: ends.best.map(verify),
        worst: ends.worst.map(verify),
        overlapping: ends.overlapping,
        elapsedMs: Date.now() - startedAt,
        resolution: baseBars && baseBars.length > 0 ? 'intrabar' : 'pessimistic',
    };
}
