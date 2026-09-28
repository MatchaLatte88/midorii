import { describe, it, expect } from 'vitest';
import type { OHLCV } from '../src/core/model/ohlcv';
import { alignSplitToBars, runSweep, sliceBars, SweepCancelled } from '../app/renderer/backtest/sweepRunner';
import { packBars, unpackBars } from '../app/renderer/backtest/sweepProtocol';

/**
 * Running a whole sweep.
 *
 * The pieces underneath — expanding the ranges, ranking the results — are checked in
 * sweep-math. What is checked here is the part only the loop can get wrong: that every
 * combination really runs with its own settings, that the winners are re-checked on bars
 * that had no say in choosing them, and that Stop stops.
 */

const STEP = 5 * 60_000;

/** The chain the detector and strategy tests use: a sweep, a bearish gap and the structure
 *  shift at 10:00 New York, the retest two bars later, and the target after that. */
const CHAIN: Array<[open: number, high: number, low: number, close: number]> = [
    [100, 101, 99, 100],
    [100, 102, 99.5, 101],
    [101, 110, 100.5, 109],
    [109, 109.5, 107, 108],
    [108, 108.5, 106, 107],
    [107, 111, 106.5, 107.5],
    [107.5, 108, 105, 105.5],
    [105.5, 106, 100, 100.5],
    [100.5, 104, 99, 99.5],
    [99.5, 101, 98, 100.5],
    [100.5, 104.5, 100, 103],
    [103, 103.5, 95, 96],
    [96, 96.5, 89, 90],
    [90, 91, 89.5, 90.5],
];

const DAY = 86_400_000;
/** 10:00 in New York on a date well inside daylight saving, so every repeat of the chain
 *  falls in the same hour without a clock change moving one of them. */
const FIRST_SHIFT = Date.parse('2024-04-01T14:00:00Z');

/** The chain repeated over `days` consecutive days — one setup per day, which is what
 *  gives a sweep enough trades to rank and enough range to split. */
function bars(days: number): OHLCV[] {
    const out: OHLCV[] = [];
    for (let day = 0; day < days; day++) {
        const start = FIRST_SHIFT + day * DAY - 8 * STEP;
        CHAIN.forEach(([open, high, low, close], i) => {
            out.push({ time: start + i * STEP, open, high, low, close, volume: 1 });
        });
    }
    return out;
}

/** A sweep over the reward-to-risk — the cheap axis, since it changes nothing detected. */
function sweep(days = 20, overrides: Record<string, unknown> = {}) {
    const series = bars(days);
    return runSweep({
        strategy: 'silverbullet',
        ranges: { rrr: { from: 1, to: 3, step: 1 } },
        base: { riskMode: 'percent', riskValue: 1, maxLeverage: 1 },
        bars: series,
        from: series[0]!.time,
        to: series[series.length - 1]!.time + STEP,
        balance: 10_000,
        stepMs: STEP,
        minTrades: 1,
        showCount: 2,
        ...overrides,
    });
}

describe('a sweep', () => {
    it('runs every combination and keeps what each did', async () => {
        const result = await sweep();

        expect(result.combinationCount).toBe(3);
        expect(result.results.map((r) => r.params.rrr)).toEqual([1, 2, 3]);
        // Every combination traded, and they did not all do the same thing.
        expect(result.results.every((r) => r.stats.tradeCount > 0)).toBe(true);
        expect(new Set(result.results.map((r) => r.stats.netPnl)).size).toBeGreaterThan(1);
    });

    it('splits the range and checks the winners on bars that did not choose them', async () => {
        const result = await sweep();

        expect(result.split).not.toBeNull();
        // Train sees only its own share of the range — the part that chose the winners.
        expect(result.split!.trainBars).toBeLessThan(bars(20).length);
        expect(result.split!.trainBars).toBeGreaterThan(0);
        // Test's own bars array carries the train period too, as warm-up for a detector
        // with a long window — see runSweep. It spans the whole loaded range; `tradeFrom`
        // is what actually keeps the ranking and the check apart.
        expect(result.split!.testBars).toBe(bars(20).length);
        // The ranking is in-sample; the check beside it is not.
        for (const entry of result.best) {
            expect(entry.outOfSample).toBeDefined();
            expect(entry.outOfSample!.tradeCount).toBeGreaterThan(0);
        }
    });

    it('moves the split onto the start of an actual bar rather than an arithmetic instant', async () => {
        const result = await sweep();
        const cut = result.split!.test.from;

        // The cut must land exactly on one of the loaded bars' own times, never between
        // two — a cut inside a bar would divide that bar's minutes between train and test.
        expect(bars(20).some((b) => b.time === cut)).toBe(true);
        expect(cut).toBeGreaterThan(result.split!.train.from);
        expect(cut).toBeLessThan(result.to);
    });

    it('ranks by the metric it was given', async () => {
        const result = await sweep(20, { metric: 'netPnl' });
        const pnls = result.best.map((e) => e.stats.netPnl);
        expect(pnls).toEqual([...pnls].sort((a, b) => b - a));
    });

    it('sets aside a combination that barely traded rather than ranking it', async () => {
        const result = await sweep(20, { minTrades: 1000 });
        expect(result.rankedCount).toBe(0);
        expect(result.excludedCount).toBe(3);
        expect(result.best).toEqual([]);
    });

    it('reuses one detection across the combinations that share it', async () => {
        /* The cache is not observable from the result, so this measures the thing it
         * exists for: nineteen reward levels must not cost nineteen detections. Both
         * sweeps detect once; the wide one only trades more often. */
        const series = bars(12);
        const time = async (steps: number) => {
            const started = Date.now();
            await runSweep({
                strategy: 'silverbullet',
                ranges: { rrr: { from: 1, to: steps, step: 1 } },
                base: {},
                bars: series,
                from: series[0]!.time,
                to: series[series.length - 1]!.time + STEP,
                stepMs: STEP,
                minTrades: 1,
            });
            return Date.now() - started;
        };

        const one = await time(1);
        const many = await time(12);
        // Twelve times the combinations, nowhere near twelve times the work.
        expect(many).toBeLessThan(Math.max(one * 6, 400));
    });

    it('stops when asked, without throwing away what it already ran', async () => {
        let seen = 0;
        await expect(runSweep({
            strategy: 'silverbullet',
            ranges: { rrr: { from: 1, to: 10, step: 1 } },
            base: {},
            bars: bars(6),
            from: FIRST_SHIFT - DAY,
            to: FIRST_SHIFT + 10 * DAY,
            stepMs: STEP,
            onProgress: () => { seen++; },
            shouldStop: () => seen >= 2,
        })).rejects.toBeInstanceOf(SweepCancelled);

        expect(seen).toBe(2);
    });

    it('refuses a sweep with nothing to sweep', async () => {
        await expect(sweep(20, { ranges: {} })).rejects.toThrow(/no ranges/);
    });

    it('refuses a bad setting before it runs anything rather than on combination 900', async () => {
        /* The reward-to-risk has a floor of 0.1, and this range walks under it. Every
         * combination is resolved against the schema before the first one runs, so
         * nothing here executes — a bad step that only surfaced on combination 900 would
         * waste everything up to it. */
        await expect(sweep(6, { ranges: { rrr: { from: 0.05, to: 0.3, step: 0.05 } } }))
            .rejects.toThrow(/below 0.1/);
    });

    it('costs a full sweep, not a doubled one, to check both ends', async () => {
        const result = await sweep(20, { showCount: 4 });
        // Only what is shown is re-run out of sample; the rest keep their in-sample figures.
        const verified = result.results.filter((r) => r.outOfSample != null);
        expect(verified).toHaveLength(0);
        expect(result.best.length + result.worst.length).toBeGreaterThan(0);
    });
});

describe('slicing a stretch', () => {
    it('is half-open, so no bar can be in both stretches', () => {
        const series = bars(2);
        const cut = series[10]!.time;
        const train = sliceBars(series, series[0]!.time, cut);
        const test = sliceBars(series, cut, series[series.length - 1]!.time + STEP);

        expect(train[train.length - 1]!.time).toBeLessThan(cut);
        expect(test[0]!.time).toBe(cut);
        expect(train.length + test.length).toBe(series.length);
    });
});

describe('aligning a split onto a real bar', () => {
    it('moves an arithmetic cut forward onto the next bar it actually finds', () => {
        const series = bars(1);
        const arithmeticCut = series[5]!.time + 137; // lands inside bar 5, before bar 6
        const split = { train: { from: series[0]!.time, to: arithmeticCut }, test: { from: arithmeticCut, to: series[series.length - 1]!.time + STEP } };

        const aligned = alignSplitToBars(split, series);

        expect(aligned.train.to).toBe(series[6]!.time);
        expect(aligned.test.from).toBe(series[6]!.time);
        // Never leaves bar 5 itself split between the two.
        const train = sliceBars(series, aligned.train.from, aligned.train.to);
        const test = sliceBars(series, aligned.test.from, aligned.test.to);
        expect(train.some((b) => b.time === series[5]!.time)).toBe(true);
        expect(test.some((b) => b.time === series[5]!.time)).toBe(false);
    });

    it('falls back to the last bar when the cut is beyond every bar it has', () => {
        const series = bars(1);
        const split = { train: { from: series[0]!.time, to: series[series.length - 1]!.time + STEP * 10 }, test: { from: 0, to: 0 } };
        const aligned = alignSplitToBars(split, series);
        expect(aligned.train.to).toBe(series[series.length - 1]!.time);
    });
});

describe('handing bars to the thread', () => {
    it('packs and unpacks a bar without changing it', () => {
        const series = bars(1).map((b, i) => ({ ...b, volume: i, buyVolume: i / 2 }));
        const back = unpackBars(packBars(series));

        expect(back).toHaveLength(series.length);
        expect(back[3]).toMatchObject({
            time: series[3]!.time, open: series[3]!.open, high: series[3]!.high,
            low: series[3]!.low, close: series[3]!.close, volume: 3,
        });
    });

    it('keeps an unrecorded buy volume unknown rather than calling it zero', () => {
        const back = unpackBars(packBars([{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5 }]));
        expect((back[0] as unknown as { buyVolume: number }).buyVolume).toBeNaN();
    });
});

