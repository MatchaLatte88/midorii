import { beforeEach, describe, expect, it } from 'vitest';
import { ExperimentalFeedProvider, normalizeExperimentalTimeframe } from '../app/renderer/providers/ExperimentalFeedProvider';
import type { MidoriExperimentalBar, MidoriExperimentalSymbol } from '../app/renderer/midori';

function stubBridge(experimentalFeed: Partial<Window['midori']['experimentalFeed']>): void {
    (globalThis as { window?: unknown }).window = { midori: { experimentalFeed } };
}

beforeEach(() => {
    delete (globalThis as { window?: unknown }).window;
});

describe('ExperimentalFeedProvider', () => {
    it('normalizes timeframe aliases and forwards ranges without changing the market id', async () => {
        const calls: unknown[] = [];
        const bars: MidoriExperimentalBar[] = [
            { time: 1, open: 10, high: 12, low: 9, close: 11, volume: 20 },
        ];
        stubBridge({
            bars: (query) => { calls.push(query); return Promise.resolve(bars); },
        });

        expect(normalizeExperimentalTimeframe('1h')).toBe('60');
        expect(await new ExperimentalFeedProvider().getBars('NASDAQ:AAPL', '1h', {
            from: 100,
            to: 200,
            limit: 50,
            session: 'extended',
        })).toEqual(bars);
        expect(calls).toEqual([{
            symbol: 'NASDAQ:AAPL',
            timeframe: '60',
            from: 100,
            to: 200,
            limit: 50,
            session: 'extended',
        }]);
    });

    it('uses on-demand search and removes its own picker prefix', async () => {
        const queries: string[] = [];
        const symbols: MidoriExperimentalSymbol[] = [{ ticker: 'NASDAQ:AAPL', type: 'stock' }];
        stubBridge({
            search: (query) => { queries.push(query); return Promise.resolve(symbols); },
        });

        expect(await new ExperimentalFeedProvider().searchSymbols('experimental:AAPL')).toEqual(symbols);
        expect(queries).toEqual(['AAPL']);
    });

    it('exposes the instrument price grid to the chart', async () => {
        stubBridge({
            symbolInfo: () => Promise.resolve({
                ticker: 'AAPL',
                tickerid: 'NASDAQ:AAPL',
                pricescale: 100,
                mintick: 0.01,
            }),
        });
        expect(await new ExperimentalFeedProvider().getSymbolInfo('NASDAQ:AAPL')).toMatchObject({
            pricescale: 100,
            mintick: 0.01,
        });
    });

    it('delivers only its own subscription and releases it when stopped', async () => {
        const listeners: Array<(payload: { subscriptionId: string; bar: MidoriExperimentalBar }) => void> = [];
        const released: string[] = [];
        stubBridge({
            subscribe: () => Promise.resolve('sub-1'),
            unsubscribe: (id) => { released.push(id); return Promise.resolve(); },
            onBar: (handler) => {
                listeners.push(handler);
                return () => { listeners.splice(listeners.indexOf(handler), 1); };
            },
        });
        const seen: MidoriExperimentalBar[] = [];
        const stop = new ExperimentalFeedProvider().subscribe('NASDAQ:AAPL', '60', (bar) => seen.push(bar));
        await Promise.resolve();

        const bar = { time: 1, open: 1, high: 2, low: 0, close: 2 };
        listeners[0]?.({ subscriptionId: 'other', bar });
        listeners[0]?.({ subscriptionId: 'sub-1', bar });
        expect(seen).toEqual([bar]);

        stop();
        expect(released).toEqual(['sub-1']);
    });

    it('releases an id that arrives after the subscription was stopped', async () => {
        let resolveId: (id: string) => void = () => {};
        const released: string[] = [];
        stubBridge({
            subscribe: () => new Promise((resolve) => { resolveId = resolve; }),
            unsubscribe: (id) => { released.push(id); return Promise.resolve(); },
            onBar: () => () => {},
        });
        const stop = new ExperimentalFeedProvider().subscribe('NASDAQ:AAPL', '60', () => {});
        stop();
        resolveId('sub-late');
        await Promise.resolve();
        await Promise.resolve();
        expect(released).toEqual(['sub-late']);
    });
});
