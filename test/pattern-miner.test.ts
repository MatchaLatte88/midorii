import { describe, it, expect } from 'vitest';
import { DEFAULT_COSTS, NO_COSTS } from '../shared/engine/broker.js';
import type { PatternBar } from '../app/renderer/patterns/atoms';
import { minePatterns, PatternSearchCancelled, type MineOptions } from '../app/renderer/patterns/miner';
import { pValue, StatsAccumulator } from '../app/renderer/patterns/stats';

/**
 * The search, end to end.
 *
 * Two claims are worth testing and they pull in opposite directions: a real pattern is
 * found, and noise is not mistaken for one. Either alone is easy — a search that reports
 * everything passes the first, one that reports nothing passes the second.
 */

const HOUR = 3_600_000;

function generator(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * A random walk. With `planted`, a bearish candle with a long lower wick is followed by
 * three bars of steady rise — an edge a long on that candle can take, and nothing else in
 * the series has.
 */
function walk(count: number, seed: number, planted: boolean): PatternBar[] {
    const rand = generator(seed);
    const out: PatternBar[] = [];
    let price = 20_000;
    let lift = 0;
    for (let i = 0; i < count; i++) {
        const open = price;
        const move = lift > 0 ? 220 : (rand() - 0.5) * 300;
        if (lift > 0) lift--;
        const close = open + move;
        const high = Math.max(open, close) + rand() * 150;
        const low = Math.min(open, close) - rand() * 150;
        const volume = 10 + rand() * 20;
        out.push({ time: Date.UTC(2024, 0, 1) + i * HOUR, open, high, low, close, volume, buyVolume: volume * rand() });
        price = close;

        const range = high - low;
        const lowerWick = Math.min(open, close) - low;
        if (planted && lift === 0 && close < open && range > 0 && lowerWick / range >= 0.5) lift = 3;
    }
    return out;
}

function options(bars: PatternBar[], overrides: Partial<MineOptions> = {}): MineOptions {
    return {
        bars,
        exit: { stopAtr: 1, rrr: 2, maxBars: 12 },
        costs: { ...NO_COSTS },
        maxDepth: 2,
        minTrades: 30,
        nullRuns: 10,
        seed: 1,
        keep: 10,
        ...overrides,
    };
}

describe('pattern scoring', () => {
    it('reads trades with no spread as certain rather than undefined', () => {
        const acc = new StatsAccumulator();
        for (let k = 0; k < 40; k++) acc.add(2);
        expect(acc.t()).toBe(Number.POSITIVE_INFINITY);
        acc.reset();
        for (let k = 0; k < 40; k++) acc.add(-1);
        expect(acc.t()).toBe(Number.NEGATIVE_INFINITY);
    });

    it('matches the textbook t statistic and normal tail', () => {
        const values = [2, -1, -1, 2, 2, -1, 0.5, -1];
        const acc = new StatsAccumulator();
        for (const r of values) acc.add(r);
        const s = acc.stats();
        const mean = 2.5 / 8;
        const sd = Math.sqrt(values.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (values.length - 1));
        expect(s.meanR).toBeCloseTo(mean, 12);
        expect(s.sdR).toBeCloseTo(sd, 12);
        expect(s.t).toBeCloseTo(mean / (sd / Math.sqrt(values.length)), 12);
        expect(s.profitFactor).toBeCloseTo(6.5 / 4, 12);
        expect(pValue(1.6449)).toBeCloseTo(0.05, 4);
        expect(pValue(0)).toBeCloseTo(0.5, 7);
    });
});

describe('minePatterns', () => {
    it('finds a planted pattern, and it survives every check', async () => {
        const result = await minePatterns(options(walk(6000, 5, true)));
        const best = result.candidates[0]!;

        expect(best.side).toBe('long');
        expect(best.atoms).toContain('c0.longlower');
        expect(best.discovery.meanR).toBeGreaterThan(0.5);
        expect(best.beatsNull).toBe(true);
        expect(best.validated).toBe(true);
        expect(best.holdout!.meanR).toBeGreaterThan(0.5);
        expect(best.pAdjusted).toBeLessThan(0.001);
        // The Broker agrees it made money on the stretches the search never looked at.
        expect(best.engine!.trades).toBeGreaterThan(0);
        expect(best.engine!.netPnl).toBeGreaterThan(0);
    }, 60_000);

    it('does not call noise a pattern', async () => {
        const result = await minePatterns(options(walk(6000, 9, false)));

        expect(result.tested).toBeGreaterThan(500);
        // Some pattern always scores well on the stretch it was chosen on...
        expect(result.bestT).toBeGreaterThan(2);
        // ...and luck alone scores about as well, which is the point of measuring it.
        expect(result.nullThreshold).not.toBeNull();
        expect(result.candidates[0]!.pAdjusted).toBeGreaterThan(0.05);
        const survivors = result.candidates.filter((c) => c.beatsNull && c.validated && c.holdout!.meanR > 0);
        expect(survivors).toHaveLength(0);
    }, 60_000);

    it('never combines two answers to the same question, and scores only what traded enough', async () => {
        const result = await minePatterns(options(walk(3000, 2, true), { maxDepth: 3, nullRuns: 0, keep: 25 }));
        const groupOf = new Map(result.atoms.map((a) => [a.id, a.group]));

        expect(result.candidates.length).toBeGreaterThan(0);
        for (const candidate of result.candidates) {
            const groups = candidate.atoms.map((id) => groupOf.get(id));
            expect(new Set(groups).size).toBe(groups.length);
            expect(candidate.discovery.trades).toBeGreaterThanOrEqual(30);
            expect(candidate.beatsNull).toBeNull();
        }
    }, 60_000);

    it('anchors every pattern on the chosen place, and tries fewer of them', async () => {
        const bars = walk(4000, 8, false);
        const free = await minePatterns(options(bars, { nullRuns: 0, minTrades: 20 }));
        const anchored = await minePatterns(options(bars, { nullRuns: 0, minTrades: 20, anchor: 'f.bulltap' }));

        expect(anchored.anchor).toBe('f.bulltap');
        expect(anchored.candidates.length).toBeGreaterThan(0);
        expect(anchored.tested).toBeLessThan(free.tested);
        for (const candidate of anchored.candidates) {
            expect(candidate.atoms[0]).toBe('f.bulltap');
            // Never a second answer to the anchor's own question.
            expect(candidate.atoms.filter((id) => id.startsWith('f.') && id.endsWith('tap'))).toHaveLength(1);
            expect(candidate.atoms.length).toBeLessThanOrEqual(3);
            expect(candidate.discovery.trades).toBeGreaterThanOrEqual(20);
        }
    });

    it('refuses an anchor the vocabulary does not have', async () => {
        await expect(minePatterns(options(walk(1000, 1, false), { nullRuns: 0, anchor: 'f.nothing' })))
            .rejects.toThrow(/anchor/);
    });

    it('keeps the stretches in time order and apart', async () => {
        const result = await minePatterns(options(walk(3000, 4, false), { nullRuns: 0 }));
        const { discovery, validation, holdout } = result.segments;

        expect(discovery.to).toBe(validation.from);
        expect(validation.to).toBe(holdout.from);
        expect(holdout.to).toBe(3000);
        expect(discovery.toTime).toBeLessThan(validation.fromTime);
    });

    it('reads costs as a loss on every trade', async () => {
        const bars = walk(3000, 6, true);
        const free = await minePatterns(options(bars, { nullRuns: 0 }));
        const charged = await minePatterns(options(bars, { nullRuns: 0, costs: { ...DEFAULT_COSTS } }));

        expect(charged.baseline.discovery.long).toBeLessThan(free.baseline.discovery.long);
    });

    it('stops when asked, and says it was asked', async () => {
        let polls = 0;
        const run = minePatterns(options(walk(6000, 5, true), { shouldStop: () => ++polls > 0 }));
        await expect(run).rejects.toBeInstanceOf(PatternSearchCancelled);
    });

    it('refuses settings that leave no holdout', async () => {
        await expect(minePatterns(options(walk(500, 1, false), { discoveryFraction: 0.7, validationFraction: 0.3 })))
            .rejects.toThrow(/holdout/);
    });
});
