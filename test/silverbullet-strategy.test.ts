import { describe, it, expect } from 'vitest';
import { runBacktest } from '../shared/engine/backtest';
import { STRATEGIES, buildStrategy, resolveStrategyParams, strategyCatalog } from '../app/renderer/strategies';
import type { OHLCV } from '../src/core/model/ohlcv';

const STEP = 5 * 60_000;

/** The same chain the detector test uses: a sweep at bar 5, a bearish gap and the structure
 *  shift at bar 8 (10:00 New York), the retest at bar 10 and the target at bar 12. */
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

function bars(rows = CHAIN): OHLCV[] {
    const start = Date.parse('2024-03-05T15:00:00Z') - 8 * STEP;
    return rows.map(([open, high, low, close], i) => ({
        time: start + i * STEP, open, high, low, close, volume: 1,
    }));
}

/** No costs, so a fill lands exactly where the rules asked for it. */
const FREE = { balance: 10_000, costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 } };

function run(params: Record<string, unknown> = {}, rows = CHAIN) {
    const series = bars(rows);
    return runBacktest({ bars: series, strategy: buildStrategy('silverbullet', params, series), broker: FREE });
}

/** The same chain on a market quoted in the thousands — an index rather than a 100-dollar
 *  share. Multiplying every price leaves the shape, and so every setup, untouched. */
const INDEX_CHAIN = CHAIN.map(
    (row) => row.map((price) => price * 250) as [number, number, number, number],
);

describe('silver bullet strategy', () => {
    it('rests a limit order at the gap edge and takes the fill there', () => {
        const result = run();

        expect(result.orders.filter((o) => o.tag === 'am')).toHaveLength(1);
        const entry = result.orders.find((o) => o.tag === 'am')!;
        expect(entry.type).toBe('limit');
        expect(entry.side).toBe('sell');
        expect(entry.limitPrice).toBe(104);
        // Placed on the shift bar, filled two bars later where price came back.
        expect(entry.status).toBe('filled');
        expect(entry.fillPrice).toBe(104);
    });

    it('sizes the position off the risk, not off the balance', () => {
        const result = run({ riskMode: 'percent', riskValue: 1 });

        // 1% of 10,000 across a 7-point stop.
        expect(result.trades).toHaveLength(1);
        const trade = result.trades[0] as { size: number; riskPerUnit: number };
        expect(trade.size).toBeCloseTo(100 / 7, 6);
        expect(trade.riskPerUnit).toBeCloseTo(7, 6);
    });

    it('exits at the reward-to-risk it was asked for', () => {
        const result = run({ rrr: 2 });
        const trade = result.trades[0] as { side: string; entryPrice: number; exitPrice: number; netPnl: number };

        expect(trade.side).toBe('short');
        expect(trade.entryPrice).toBe(104);
        expect(trade.exitPrice).toBe(90); // 104 − 2 × 7
        // Two units of risk, and the risk was 1% of the starting balance.
        expect(trade.netPnl).toBeCloseTo(200, 6);
    });

    it('caps the size at the leverage ceiling rather than inventing an account', () => {
        // 8% across a 7-point stop wants 114 units at 104 — more notional than the account has.
        const trade = run({ riskValue: 8, maxLeverage: 1 }).trades[0] as { size: number };
        expect(trade.size).toBeCloseTo(10_000 / 104, 6);
    });

    it('cancels the order once its window closes, and takes no trade', () => {
        // Nothing after the shift comes back to the gap edge.
        const rows = CHAIN.map((r) => [...r] as typeof CHAIN[number]);
        rows[10] = [100.5, 101, 100, 100.5];

        const result = run({ maxGapToEntry: 3 }, rows);
        const entry = result.orders.find((o) => o.tag === 'am')!;

        expect(entry.status).toBe('cancelled');
        expect(result.trades).toHaveLength(0);
        expect(result.fills).toHaveLength(0);
        // An order that never filled still cost nothing but is not a trade either.
        expect(result.stats.tradeCount).toBe(0);
        expect(result.stats.netPnl).toBe(0);
    });

    it('leaves the order resting while its window is still open', () => {
        const rows = CHAIN.map((r) => [...r] as typeof CHAIN[number]);
        rows[10] = [100.5, 101, 100, 100.5];

        const result = run({}, rows); // the default window runs past the end of the data
        expect(result.orders.find((o) => o.tag === 'am')!.status).toBe('pending');
    });

    it('takes nothing outside the hours it was given', () => {
        expect(run({ windows: ['london', 'pm'] }).trades).toHaveLength(0);
        expect(run({ windows: ['am'] }).trades).toHaveLength(1);
    });

    /**
     * A fixed risk, end to end, through the strategy a person actually runs.
     *
     * The chain moved to an index's prices, so the figures are the ones the form promises
     * rather than fractions of a point. With the ceiling off and nothing charged, every
     * trade comes out at exactly the amount typed in or exactly that times the reward —
     * which is what "risk 100 at 1.4" is supposed to mean and what it did not mean while
     * the leverage ceiling was deciding the size. Where the ceiling binds instead of the
     * risk is measured on its own, against real numbers, in risk-sizing.test.ts.
     */
    describe('a fixed risk of 100 at a reward of 1.4', () => {
        const FIXED = { riskMode: 'fixed', riskValue: 100, rrr: 1.4, capLeverage: false };

        it('makes exactly the reward on a winner', () => {
            const trade = run(FIXED, INDEX_CHAIN).trades[0] as {
                size: number; netPnl: number; riskPerUnit: number;
            };

            expect(trade.size * trade.riskPerUnit).toBeCloseTo(100, 6);
            expect(trade.netPnl).toBeCloseTo(140, 6);
        });

        it('loses exactly the risk on a loser, not a point more', () => {
            /* The same setup, with the last bars turned round so price runs up through the
             * stop (1,750 above the 26,000 entry) instead of down to the target. */
            const stopped = INDEX_CHAIN.map((row, i) => (
                i >= 11 ? ([25_750, 28_000, 25_700, 27_900] as [number, number, number, number]) : row
            ));
            const trade = run(FIXED, stopped).trades[0] as { netPnl: number; riskPerUnit: number };

            expect(trade.riskPerUnit).toBeCloseTo(1_750, 6);
            expect(trade.netPnl).toBeCloseTo(-100, 6);
        });
    });

    it('fills in the defaults and refuses a setting it cannot honour', () => {
        const params = resolveStrategyParams('silverbullet', { riskValue: 2 });

        expect(params.riskValue).toBe(2);
        expect(params.rrr).toBe(2);
        expect(params.windows).toEqual(['london', 'am', 'pm']);
        expect(params.scope).toBe('signal');

        expect(() => resolveStrategyParams('silverbullet', { riskValue: 0 })).toThrow(/below/);
        expect(() => resolveStrategyParams('silverbullet', { scope: 'nope' })).toThrow(/not one of/);
        expect(() => resolveStrategyParams('silverbullet', { windows: ['asia'] })).toThrow(/not one of/);
        expect(() => resolveStrategyParams('nope', {})).toThrow(/Unknown strategy/);
    });

    it('lists itself with the indicator it is built on, and without its build function', () => {
        const catalog = strategyCatalog();
        const entry = catalog.find((s) => s.id === 'silverbullet')!;

        expect(entry.name).toBe('Silver Bullet');
        expect(entry.indicator).toBe('silverbullet');
        // Risk comes first, so two strategies ask the same questions in the same order.
        expect(entry.params.slice(0, 5).map((p) => p.key))
            .toEqual(['riskMode', 'riskValue', 'capLeverage', 'maxLeverage', 'rrr']);
        expect('build' in entry).toBe(false);
        expect(Object.keys(STRATEGIES)).toContain('silverbullet');
    });
});
