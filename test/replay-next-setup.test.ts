// "Skip to the next setup" in a replay.
//
// Two promises: the stop is the first candle AFTER the playhead on which the strategy would
// send an order, and getting there matches every order on the way exactly as stepping by hand
// would. The strategies here are built for the test, so what counts as a setup is known.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { aggregate, STRIDE } from '../app/electron/data/store/barStore.js';
import { barIndexAt } from '../shared/engine/replaySession.js';
import { ReplayController } from '../app/renderer/replay/ReplayController';
import type { ReplayProvider } from '../app/renderer/replay/ReplayProvider';
import { nextSetupIndex } from '../app/renderer/replay/nextSetup';
import { loadReplayWindow } from '../app/renderer/replay/replayWindow';
import type { StrategySpec } from '../app/renderer/strategies/types';
import type { OHLCV } from '../src/core/model/ohlcv';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const START = Date.UTC(2024, 0, 1);

/** A strategy that sends an order on every candle whose index is a multiple of `every`. */
function everyNth(every: number): StrategySpec {
    return {
        id: 'test-every',
        name: 'Every nth',
        description: '',
        params: [],
        build: () => ({
            onBar(ctx) {
                if (ctx.index % every === 0) ctx.buy({ size: 1 });
            },
        }),
    };
}

/** A strategy that goes long on the first close above `level`, and holds it. */
function breakAbove(level: number): StrategySpec {
    return {
        id: 'test-break',
        name: 'Break above',
        description: '',
        params: [],
        build: () => ({
            onBar(ctx) {
                if (ctx.isFlat && ctx.bar.close > level) ctx.buy({ size: 1 });
            },
        }),
    };
}

const flatBars = (closes: number[]): OHLCV[] => closes.map((close, i) => ({
    time: START + i * MINUTE, open: close, high: close + 0.5, low: close - 0.5, close, volume: 1,
}));

describe('finding the next setup', () => {
    it('is the first candle after the playhead, never the one it is on', () => {
        const bars = flatBars(Array.from({ length: 50 }, () => 100));
        expect(nextSetupIndex(everyNth(10), {}, bars, 13)).toBe(20);
        expect(nextSetupIndex(everyNth(10), {}, bars, 20)).toBe(30);
    });

    it('starts the strategy flat at the playhead, so a trade it would have held does not hide one', () => {
        /* Run from the start, this strategy buys at candle 2 and holds for good — it would never
         * send another order. Started at the playhead, it is flat and finds the break after it. */
        const closes = [100, 100, 105, 100, 100, 100, 106, 100];
        expect(nextSetupIndex(breakAbove(101), {}, flatBars(closes), 3)).toBe(6);
    });

    it('says there is none rather than stopping somewhere', () => {
        const bars = flatBars(Array.from({ length: 30 }, () => 100));
        expect(nextSetupIndex(breakAbove(200), {}, bars, 0)).toBeNull();
    });

    it('lets a strategy that throws for its own reason say so', () => {
        const broken: StrategySpec = {
            ...everyNth(1),
            build: () => ({ onBar() { throw new Error('the detector fell over'); } }),
        };
        expect(() => nextSetupIndex(broken, {}, flatBars([1, 2, 3]), 0)).toThrow(/detector fell over/);
    });
});

describe('stepping to it', () => {
    const minutes = (): Float64Array => {
        const count = 24 * 60;
        const data = new Float64Array(count * STRIDE);
        for (let i = 0; i < count; i++) {
            const base = i * STRIDE;
            const price = 100 + Math.sin(i / 20) * 4;
            data.set([START + i * MINUTE, price, price + 0.3, price - 0.3, price, 10, 6], base);
        }
        return data;
    };
    const DATA = minutes();
    const midori = {
        data: {
            meta: () => Promise.resolve({ symbol: 'TEST', first: START, last: START + (24 * 60 - 1) * MINUTE }),
            bars: ({ timeframe, from, to, dropIncomplete = true }: { timeframe: string; from: number; to: number; dropIncomplete?: boolean }) =>
                Promise.resolve(aggregate(DATA, from, to, timeframe, dropIncomplete)),
        },
    };
    let previous: unknown;
    beforeAll(() => {
        previous = (globalThis as { window?: unknown }).window;
        (globalThis as { window?: unknown }).window = { midori };
    });
    afterAll(() => {
        (globalThis as { window?: unknown }).window = previous;
    });

    const provider = { retime() {}, revealNext() {} } as unknown as ReplayProvider;
    async function session() {
        const clock = START + 4 * HOUR;
        const { bars } = await loadReplayWindow('TEST', '5', clock);
        return new ReplayController({ provider, symbol: 'TEST', timeframe: '5', bars, startIndex: barIndexAt(bars, clock - 1), balance: 10_000 });
    }

    it('lands with that candle closed, and the account as though stepped there by hand', async () => {
        const skipped = await session();
        const byHand = await session();
        for (const c of [skipped, byHand]) {
            c.order({ side: 'buy', type: 'market', size: 1, bracket: { takeProfit: c.price() + 2, stopLoss: c.price() - 2 } });
        }

        const target = skipped.session.index + 37;
        expect(await skipped.skipToIndex(target)).toBe(37);
        byHand.skip(37);

        // The bracket was decided on the way — skipping had to match it, not step over it.
        expect(byHand.session.broker.trades.length).toBeGreaterThan(0);
        expect(skipped.session.index).toBe(target);
        expect(skipped.session.clock).toBe(byHand.session.clock);
        expect(skipped.session.broker.trades).toEqual(byHand.session.broker.trades);
        expect(skipped.session.broker.balance).toBe(byHand.session.broker.balance);
    });
});
