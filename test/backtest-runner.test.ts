import { describe, it, expect } from 'vitest';
import { runBacktest, type BacktestBar, type RunnableStrategy } from '../shared/engine/backtest';

const STEP = 60_000;

/** Bars from close prices, one minute apart, with no range of their own. */
function bars(closes: number[]): BacktestBar[] {
    return closes.map((c, i) => ({ time: i * STEP, open: c, high: c, low: c, close: c, volume: 1 }));
}

/** No costs, so a fill lands exactly on the price the rules asked for. */
const FREE = { balance: 10_000, costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 } };

describe('backtest runner', () => {
    it('never fills an order on the bar that placed it', () => {
        const strategy: RunnableStrategy = {
            onBar(ctx) {
                if (ctx.index === 0) ctx.buy({ size: 1 });
            },
        };

        const run = runBacktest({ bars: bars([100, 110, 120]), strategy, broker: FREE });

        expect(run.fills).toHaveLength(1);
        // Placed on bar 0, matched against bar 1 — at its open, not bar 0's close.
        expect(run.fills[0]).toMatchObject({ price: 110, time: STEP });
    });

    it('hands a strategy only the events this bar confirmed', () => {
        const seen: Array<[number, number]> = [];
        // `startIndex` is where the thing is drawn; the loop must bucket by `index`.
        const setups = [{ index: 2, startIndex: 0 }, { index: 3, startIndex: 1 }];
        const strategy: RunnableStrategy = {
            events: { setups },
            onBar(ctx) {
                for (const e of ctx.events('setups')) seen.push([ctx.index, e.index]);
            },
        };

        runBacktest({ bars: bars([1, 2, 3, 4, 5]), strategy, broker: FREE });
        expect(seen).toEqual([[2, 2], [3, 3]]);
    });

    it('drops events that fall outside the run', () => {
        let count = 0;
        const strategy: RunnableStrategy = {
            events: { setups: [{ index: -1 }, { index: 9 }, { index: 1 }] },
            onBar(ctx) { count += ctx.events('setups').length; },
        };

        runBacktest({ bars: bars([1, 2, 3]), strategy, broker: FREE });
        expect(count).toBe(1);
    });

    it('skips the warm-up while a declared series is still undefined', () => {
        const seen: number[] = [];
        const strategy: RunnableStrategy = {
            series: { slow: [null, null, 3, 4] },
            onBar(ctx) { seen.push(ctx.index); },
        };

        const run = runBacktest({ bars: bars([1, 2, 3, 4]), strategy, broker: FREE });

        expect(seen).toEqual([2, 3]);
        expect(run.warmupBars).toBe(2);
        expect(run.equityCurve).toHaveLength(2);
        expect(run.stats.barCount).toBe(2);
    });

    it('reads a series backwards without ever reaching forward', () => {
        const seen: Array<number | null> = [];
        const strategy: RunnableStrategy = {
            series: { fast: [10, 20, 30] },
            onBar(ctx) { seen.push(ctx.value('fast', 1)); },
        };

        runBacktest({ bars: bars([1, 2, 3]), strategy, broker: FREE });
        expect(seen).toEqual([null, 10, 20]);
    });

    it('settles an ambiguous bar with the minutes underneath it', () => {
        /* One bar that touches both the stop and the target. Without sub-bars the stop wins;
         * with them the target is reached first and the trade is a winner. */
        const day: BacktestBar[] = [
            { time: 0, open: 100, high: 100, low: 100, close: 100 },
            { time: STEP, open: 100, high: 130, low: 80, close: 120 },
        ];
        const minutes: BacktestBar[] = [
            { time: STEP, open: 100, high: 130, low: 100, close: 130 },
            { time: STEP + 1, open: 130, high: 130, low: 80, close: 120 },
        ];
        const strategy: RunnableStrategy = {
            onBar(ctx) {
                if (ctx.index === 0) ctx.buy({ size: 1, stopLoss: 90, takeProfit: 120 });
            },
        };

        const pessimistic = runBacktest({ bars: day, strategy, broker: FREE });
        const intrabar = runBacktest({ bars: day, baseBars: minutes, strategy, broker: FREE, stepMs: STEP });

        expect(pessimistic.resolution).toBe('pessimistic');
        expect(intrabar.resolution).toBe('intrabar');
        expect(intrabar.stats.netPnl).toBeGreaterThan(pessimistic.stats.netPnl);
    });

    it('reports the costs it actually charged, not the ones it was handed', () => {
        const strategy: RunnableStrategy = { onBar() { /* trades nothing */ } };
        const run = runBacktest({ bars: bars([1, 2]), strategy });

        expect(run.costs.feeRate).toBeGreaterThan(0);
        expect(run.initialBalance).toBe(10_000);
        expect(run.stepMs).toBe(STEP);
    });

    it('refuses a run it cannot make sense of', () => {
        const ok: RunnableStrategy = { onBar() { /* nothing */ } };

        expect(() => runBacktest({ bars: [], strategy: ok })).toThrow(/no bars/);
        // @ts-expect-error — a strategy without onBar cannot be driven.
        expect(() => runBacktest({ bars: bars([1]), strategy: {} })).toThrow(/onBar/);
        expect(() => runBacktest({
            bars: bars([1, 2]), strategy: { ...ok, series: { s: [1] } },
        })).toThrow(/1 values for 2 bars/);
        expect(() => runBacktest({
            // @ts-expect-error — an event with no index could not be placed on a bar.
            bars: bars([1, 2]), strategy: { ...ok, events: { e: [{ at: 1 }] } },
        })).toThrow(/integer index/);
    });
});
