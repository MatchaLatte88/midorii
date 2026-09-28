// Capital.com is the first venue Midorii charts that it could also TRADE, and a CFD order is
// refused for reasons a crypto order never is — a size below the venue's minimum, a size off
// its increment grid, a stop nearer the market than it allows. Those rules, and the tick the
// instrument is quoted to, ride on the symbol's metadata; the two-sided price does not, and
// comes off a separate stream. These cover both halves.
// See app/renderer/providers/CapitalProvider.ts.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CapitalProvider } from '../app/renderer/providers/CapitalProvider';
import type { MidoriCapitalBar, MidoriCapitalMarketInfo, MidoriCapitalQuote } from '../app/renderer/midori';
import type { OHLCV } from '../src';

/** A EURUSD record shaped the way `GET /markets/{epic}` answers. */
function eurusd(overrides: Partial<MidoriCapitalMarketInfo> = {}): MidoriCapitalMarketInfo {
    return {
        instrument: {
            epic: 'EURUSD',
            name: 'EUR/USD',
            type: 'CURRENCIES',
            currency: 'USD',
            lotSize: 1,
            marginFactor: 3.33,
            marginFactorUnit: 'PERCENTAGE',
        },
        dealingRules: {
            minDealSize: { unit: 'POINTS', value: 1000 },
            maxDealSize: { unit: 'POINTS', value: 1_000_000 },
            minSizeIncrement: { unit: 'POINTS', value: 100 },
            minStopOrProfitDistance: { unit: 'POINTS', value: 0.5 },
            maxStopOrProfitDistance: { unit: 'PERCENTAGE', value: 90 },
        },
        snapshot: {
            marketStatus: 'TRADEABLE',
            bid: 1.09241,
            offer: 1.09253,
            decimalPlacesFactor: 5,
            scalingFactor: 1,
        },
        ...overrides,
    };
}

/** The preload bridge, faked. Only the capital half exists — it is all this touches. */
function stubBridge(capital: Partial<Window['midori']['capital']>): void {
    (globalThis as { window?: unknown }).window = { midori: { capital } };
}

beforeEach(() => {
    delete (globalThis as { window?: unknown }).window;
});

/** A Capital history page, ascending as the bridge returns it. */
function bars(from: number, count: number): MidoriCapitalBar[] {
    return Array.from({ length: count }, (_, i) => ({
        time: from + i,
        open: from + i,
        high: from + i,
        low: from + i,
        close: from + i,
        volume: 1,
    }));
}

describe('progressive history', () => {
    type ProgressiveProvider = CapitalProvider & {
        getBarsProgressive(
            ticker: string,
            timeframe: string,
            range: { limit?: number },
            onBatch: (batch: OHLCV[]) => void,
            opts?: { signal?: AbortSignal },
        ): Promise<OHLCV[]>;
    };

    it('paints the newest 500 bars before fetching the next segment', async () => {
        const recent = bars(1_501, 500);
        let releaseSecond: (page: MidoriCapitalBar[]) => void = () => {};
        const second = new Promise<MidoriCapitalBar[]>((resolve) => { releaseSecond = resolve; });
        const pages = [second, Promise.resolve(bars(501, 500)), Promise.resolve(bars(1, 500))];
        const prices = vi.fn((request: Parameters<Window['midori']['capital']['prices']>[0]) => {
            if (request.to == null) return Promise.resolve(recent);
            return pages.shift() ?? Promise.resolve([]);
        });
        stubBridge({ prices });
        const provider = new CapitalProvider() as ProgressiveProvider;
        const snapshots: OHLCV[][] = [];

        const loading = provider.getBarsProgressive('GOLD', '5', { limit: 2_000 }, (batch) => snapshots.push(batch));
        await vi.waitFor(() => expect(snapshots.map((batch) => batch.length)).toEqual([500]));

        expect(prices).toHaveBeenNthCalledWith(1, {
            epic: 'GOLD', resolution: 'MINUTE_5', limit: 500,
        });
        expect(prices).toHaveBeenNthCalledWith(2, {
            epic: 'GOLD', resolution: 'MINUTE_5', to: 1_500, limit: 500,
        });

        releaseSecond(bars(1_001, 500));
        const full = await loading;
        expect(snapshots.map((batch) => batch.length)).toEqual([500, 1_000, 1_500]);
        expect(full).toHaveLength(2_000);
        expect(full[0]?.time).toBe(1);
        expect(full[full.length - 1]?.time).toBe(2_000);
        expect(prices).toHaveBeenCalledTimes(4);
    });

    it('does not start another segment after the chart switches away', async () => {
        const prices = vi.fn(() => Promise.resolve(bars(1_501, 500)));
        stubBridge({ prices });
        const provider = new CapitalProvider() as ProgressiveProvider;
        const abort = new AbortController();

        const full = await provider.getBarsProgressive(
            'GOLD',
            '5',
            { limit: 2_000 },
            () => abort.abort(),
            { signal: abort.signal },
        );

        expect(full).toHaveLength(500);
        expect(prices).toHaveBeenCalledTimes(1);
    });
});

describe('getSymbolInfo', () => {
    it('derives the tick from how many decimals the instrument is quoted to', async () => {
        stubBridge({ marketInfo: () => Promise.resolve(eurusd()) });
        const info = await new CapitalProvider().getSymbolInfo('EURUSD');
        // 5 decimals ⇒ a pip's tenth. Without this the price axis guesses, and `snapToTick`
        // has no grid at all — a dropped level keeps every decimal the pointer gave it.
        expect(info?.mintick).toBe(0.00001);
        expect(info?.pricescale).toBe(100_000);
    });

    it('leaves the tick off rather than guessing one when the snapshot is absent', async () => {
        stubBridge({ marketInfo: () => Promise.resolve(eurusd({ snapshot: undefined })) });
        const info = await new CapitalProvider().getSymbolInfo('EURUSD');
        expect(info).toBeDefined();
        expect(info?.mintick).toBeUndefined();
        expect(info?.pricescale).toBeUndefined();
    });

    it('carries the rules an order would otherwise be rejected for', async () => {
        stubBridge({ marketInfo: () => Promise.resolve(eurusd()) });
        const info = await new CapitalProvider().getSymbolInfo('EURUSD');
        expect(info?.dealing).toEqual({
            minSize: 1000,
            sizeIncrement: 100,
            maxSize: 1_000_000,
            marginFactor: 3.33,
            marginFactorUnit: 'PERCENTAGE',
            // The unit rides along: one of these is POINTS and the other PERCENTAGE, and
            // reading either value without it would put the level somewhere else entirely.
            minStopDistance: { unit: 'POINTS', value: 0.5 },
            maxStopDistance: { unit: 'PERCENTAGE', value: 90 },
            lotSize: 1,
            // What the INSTRUMENT books in, which is not always what the account is held in.
            currency: 'USD',
        });
    });

    it('reads a missing rule as unknown, never as "no limit"', async () => {
        stubBridge({ marketInfo: () => Promise.resolve(eurusd({ dealingRules: undefined })) });
        const info = await new CapitalProvider().getSymbolInfo('EURUSD');
        const dealing = info?.dealing as Record<string, unknown>;
        expect(dealing.minSize).toBeNull();
        expect(dealing.sizeIncrement).toBeNull();
        // A zero here would size an order the venue refuses, and read as "any size goes".
        expect(dealing.minSize).not.toBe(0);
    });
});

describe('snapshot', () => {
    it('answers what the market is doing right now, and at what', async () => {
        stubBridge({ marketInfo: () => Promise.resolve(eurusd()) });
        expect(await new CapitalProvider().snapshot('eurusd')).toEqual({
            status: 'TRADEABLE',
            tradeable: true,
            bid: 1.09241,
            ask: 1.09253, // Capital.com calls it `offer`; nothing downstream should have to.
        });
    });

    it('is not tradeable when the venue is shut — forex on a Saturday', async () => {
        const closed = eurusd();
        closed.snapshot!.marketStatus = 'CLOSED';
        stubBridge({ marketInfo: () => Promise.resolve(closed) });
        const snap = await new CapitalProvider().snapshot('EURUSD');
        expect(snap?.tradeable).toBe(false);
        expect(snap?.status).toBe('CLOSED');
    });
});

describe('subscribe', () => {
    it('refines the forming candle from every bid/ask midpoint without regressing on a slower OHLC update', async () => {
        let emitOhlc: (payload: { subscriptionId: string; bar: MidoriCapitalBar }) => void = () => {};
        let emitQuote: (payload: { subscriptionId: string; quote: MidoriCapitalQuote }) => void = () => {};
        const unsubscribed: string[] = [];
        stubBridge({
            subscribe: () => Promise.resolve('ohlc-1'),
            unsubscribe: (id: string) => { unsubscribed.push(id); return Promise.resolve(); },
            onOhlc: (handler) => { emitOhlc = handler; return () => { emitOhlc = () => {}; }; },
            subscribeQuotes: () => Promise.resolve('quote-1'),
            unsubscribeQuotes: (id: string) => { unsubscribed.push(id); return Promise.resolve(); },
            onQuote: (handler) => { emitQuote = handler; return () => { emitQuote = () => {}; }; },
        });
        const seen: OHLCV[] = [];
        const stop = new CapitalProvider().subscribe('EURUSD', '1', (bar) => seen.push(bar));
        await Promise.resolve();
        await Promise.resolve();

        const time = 1_700_000_040_000;
        emitOhlc({
            subscriptionId: 'ohlc-1',
            bar: { time, open: 100, high: 102, low: 99, close: 101, volume: 5 },
        });
        emitQuote({
            subscriptionId: 'quote-1',
            quote: { epic: 'EURUSD', bid: 102, ask: 104, bidSize: null, askSize: null, time: time + 18_000 },
        });

        expect(seen[seen.length - 1]).toEqual({ time, open: 100, high: 103, low: 99, close: 103, volume: 5 });

        // A later bid-based OHLC payload must not pull the visible close behind the newer mid.
        emitOhlc({
            subscriptionId: 'ohlc-1',
            bar: { time, open: 100, high: 104, low: 98, close: 102, volume: 7 },
        });
        expect(seen[seen.length - 1]).toEqual({ time, open: 100, high: 104, low: 98, close: 103, volume: 7 });

        emitQuote({
            subscriptionId: 'quote-1',
            quote: { epic: 'EURUSD', bid: 96, ask: 98, bidSize: null, askSize: null, time: time + 19_000 },
        });
        expect(seen[seen.length - 1]).toEqual({ time, open: 100, high: 104, low: 97, close: 97, volume: 7 });

        stop();
        expect(unsubscribed).toEqual(['ohlc-1', 'quote-1']);
    });
});

describe('subscribeQuotes', () => {
    /** A bridge that hands out subscription ids and remembers what was dropped. */
    function quoteBridge(subscribeId: Promise<string>) {
        let emit: ((payload: { subscriptionId: string; quote: MidoriCapitalQuote }) => void) | null = null;
        const unsubscribed: string[] = [];
        stubBridge({
            subscribeQuotes: () => subscribeId,
            unsubscribeQuotes: (id: string) => { unsubscribed.push(id); return Promise.resolve(); },
            onQuote: (handler) => { emit = handler; return () => { emit = null; }; },
        });
        return { unsubscribed, fire: (payload: { subscriptionId: string; quote: MidoriCapitalQuote }) => emit?.(payload) };
    }

    const tick = (bid: number, ask: number): MidoriCapitalQuote => (
        { epic: 'EURUSD', bid, ask, bidSize: null, askSize: null, time: 1 }
    );

    it('delivers only the ticks belonging to its own subscription', async () => {
        const bridge = quoteBridge(Promise.resolve('sub-1'));
        const seen: MidoriCapitalQuote[] = [];
        const stop = new CapitalProvider().subscribeQuotes('eurusd', (q) => seen.push(q));
        await Promise.resolve();

        bridge.fire({ subscriptionId: 'sub-1', quote: tick(1.09241, 1.09253) });
        // A second pane on another instrument shares the socket; its ticks are not ours.
        bridge.fire({ subscriptionId: 'sub-2', quote: tick(9, 9.1) });

        expect(seen).toEqual([tick(1.09241, 1.09253)]);
        stop();
    });

    it('still drops the subscription when it is stopped before the id lands', async () => {
        // The window between asking and being told: a market switched twice in quick
        // succession lives entirely inside it, and a subscription leaked here is one of the
        // 40 slots the venue allows, gone for the life of the session.
        let hand: (id: string) => void = () => {};
        const bridge = quoteBridge(new Promise<string>((resolve) => { hand = resolve; }));
        const stop = new CapitalProvider().subscribeQuotes('EURUSD', () => {});

        stop();
        hand('sub-late');
        await Promise.resolve();
        await Promise.resolve();

        expect(bridge.unsubscribed).toEqual(['sub-late']);
    });

    it('warns rather than throwing when the venue refuses the subscription', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubBridge({
            subscribeQuotes: () => Promise.reject(new Error('too many subscriptions')),
            unsubscribeQuotes: () => Promise.resolve(),
            onQuote: () => () => {},
        });

        expect(() => new CapitalProvider().subscribeQuotes('EURUSD', () => {})).not.toThrow();
        await Promise.resolve();
        await Promise.resolve();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('too many subscriptions'));
        warn.mockRestore();
    });
});
