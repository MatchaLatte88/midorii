import { describe, it, expect } from 'vitest';
import { runBacktest, type BacktestBar, type RunnableStrategy } from '../shared/engine/backtest';
import { NO_COSTS } from '../shared/engine/broker.js';
import { leverageCap, positionSize, riskManagement } from '../shared/strategies/risk.js';
import { rMultiple } from '../app/renderer/format';

/**
 * What a fixed risk is supposed to cost, and what was quietly deciding it instead.
 *
 * The bug these are written against: on a market quoted in the thousands, a 10,000 account
 * with the default `maxLeverage` of 1 can carry 0.4 units of it. Risking 100 behind a stop
 * three points away asks for 33 — so every trade was capped, and the "100" in the form
 * never reached a single one of them. The realised risk was whatever 0.4 units times the
 * stop distance happened to be, which is a different number on every setup.
 *
 * The two switches below are the two halves of getting the promised number back: the
 * ceiling has to be lifted, and the costs have to stop being a crypto account's.
 */

const STEP = 60_000;

function bar(time: number, open: number, high: number, low: number, close: number): BacktestBar {
    return { time, open, high, low, close, volume: 1 };
}

describe('position sizing against the leverage ceiling', () => {
    // The screenshot's own numbers: an index at 24,758 against a 10,000 account.
    const equity = 10_000;
    const entry = 24_758;
    const stop = 24_786.5;

    it('caps the size at the account when the ceiling is on, whatever the risk asked for', () => {
        const size = positionSize(equity, entry, stop, 'fixed', 100, 1)!;

        expect(size).toBeCloseTo(equity / entry, 10);
        // And the stop therefore costs a seventh of what the form said it would.
        expect(size * Math.abs(entry - stop)).toBeCloseTo(11.5, 1);
    });

    it('gives the size the risk asks for when the ceiling is off', () => {
        const size = positionSize(equity, entry, stop, 'fixed', 100, null)!;

        expect(size * Math.abs(entry - stop)).toBeCloseTo(100, 10);
        // Which is a position worth nearly nine times the account — the honest reading of "off".
        expect(size * entry).toBeCloseTo(86_870, 0);
    });

    it('reads the ceiling off the parameters, and null only when it is switched off', () => {
        expect(leverageCap({ capLeverage: true, maxLeverage: 3 })).toBe(3);
        expect(leverageCap({ maxLeverage: 3 })).toBe(3);
        expect(leverageCap({ capLeverage: false, maxLeverage: 3 })).toBeNull();
        // A missing or unusable figure is spot, not "no ceiling".
        expect(leverageCap({})).toBe(1);
        expect(leverageCap({ maxLeverage: 0 })).toBe(1);
    });
});

describe('management read off the shared schema', () => {
    it('is nothing at all when both rules are zero', () => {
        expect(riskManagement({ breakEvenAtR: 0, trailAtR: 0, trailR: 1 })).toBeNull();
        expect(riskManagement({})).toBeNull();
    });

    it('ignores a trail that has no distance to sit at', () => {
        expect(riskManagement({ trailAtR: 2, trailR: 0 })).toBeNull();
    });

    it('carries the rules through as they were asked for', () => {
        expect(riskManagement({ breakEvenAtR: 1, trailAtR: 2, trailR: 0.5 }))
            .toEqual({ breakEvenAtR: 1, trailAtR: 2, trailR: 0.5 });
    });
});

describe('a fixed risk, with nothing in the way of it', () => {
    /**
     * One long, entered at market, risking a fixed amount with a 1.4 reward.
     *
     * The stop and the target are placed as a bracket on the entry, which is what every
     * strategy in the app does — so this is the same path a real run takes.
     */
    function oneTrade(entryPrice: number, stopPrice: number): RunnableStrategy {
        return {
            onBar(ctx) {
                if (ctx.index !== 0) return;
                const size = positionSize(ctx.equity, entryPrice, stopPrice, 'fixed', 100, null);
                if (size == null) return;
                const distance = entryPrice - stopPrice;
                ctx.order({
                    side: 'buy',
                    type: 'market',
                    size,
                    bracket: { stopLoss: stopPrice, takeProfit: entryPrice + distance * 1.4 },
                });
            },
        };
    }

    const free = { balance: 10_000, costs: NO_COSTS };

    it('loses exactly the amount that was typed in', () => {
        // Entry fills at bar 1's open, 100; the stop at 97 is reached on bar 2.
        const bars = [
            bar(0, 100, 100, 100, 100),
            bar(STEP, 100, 101, 99, 100),
            bar(2 * STEP, 100, 100, 96, 97),
        ];

        const run = runBacktest({ bars, strategy: oneTrade(100, 97), broker: free, stepMs: STEP });

        expect(run.trades).toHaveLength(1);
        const trade = run.trades[0] as { netPnl: number; size: number; riskPerUnit: number | null };
        expect(trade.netPnl).toBeCloseTo(-100, 8);
        expect(rMultiple(trade)).toBeCloseTo(-1, 8);
    });

    it('makes exactly the reward the ratio promised', () => {
        // Target for a 3-point stop at 1.4 is 104.2, reached on bar 2.
        const bars = [
            bar(0, 100, 100, 100, 100),
            bar(STEP, 100, 101, 99, 100),
            bar(2 * STEP, 100, 105, 100, 104.5),
        ];

        const run = runBacktest({ bars, strategy: oneTrade(100, 97), broker: free, stepMs: STEP });

        expect(run.trades).toHaveLength(1);
        const trade = run.trades[0] as { netPnl: number; size: number; riskPerUnit: number | null };
        expect(trade.netPnl).toBeCloseTo(140, 8);
        expect(rMultiple(trade)).toBeCloseTo(1.4, 8);
    });

    it('overshoots the fixed risk on the default costs, and that is what the switch is for', () => {
        const bars = [
            bar(0, 100, 100, 100, 100),
            bar(STEP, 100, 101, 99, 100),
            bar(2 * STEP, 100, 100, 96, 97),
        ];

        const run = runBacktest({
            bars, strategy: oneTrade(100, 97), broker: { balance: 10_000 }, stepMs: STEP,
        });

        const trade = run.trades[0] as { netPnl: number };
        /* The stop is still at 97, but it fills below it (spread and slippage) and the
         * commission comes off on top — so the trade loses more than the amount that was
         * typed in. 8% over here, on a notional a third of the account; on a market quoted
         * in the thousands, where the same risk buys a notional many times the account, the
         * same 0.1% per side is several times the risk itself. */
        expect(trade.netPnl).toBeLessThan(-100);
        expect(trade.netPnl).toBeCloseTo(-108.54, 1);
    });
});
