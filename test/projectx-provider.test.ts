import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectXProvider, projectXDealing, rootOf } from '../app/renderer/providers/ProjectXProvider';
import type { MidoriProjectXContract } from '../app/renderer/midori';
import type { OHLCV } from '../src';

const contract = (
    id: string, name: string, description: string,
    { tickSize = 0.25, tickValue = 5, activeContract = true, symbolId = 'F.US.ENQ' } = {},
): MidoriProjectXContract => ({ id, name, description, tickSize, tickValue, activeContract, symbolId });

const NQU6 = contract('CON.F.US.ENQ.U26', 'NQU6', 'E-mini NASDAQ-100: September 2026');
const NQZ6 = contract('CON.F.US.ENQ.Z26', 'NQZ6', 'E-mini NASDAQ-100: December 2026', { activeContract: false });
const MNQU6 = contract('CON.F.US.MNQ.U26', 'MNQU6', 'Micro E-mini Nasdaq-100: September 2026', { tickValue: 0.5, symbolId: 'F.US.MNQ' });
const QGV6 = contract('CON.F.US.NQG.V26', 'QGV6', 'E-Mini Natural Gas: October 2026', { tickSize: 0.005, tickValue: 12.5, symbolId: 'F.US.NQG' });

/** A history page, ascending as the provider hands it to the chart. */
function chartBars(from: number, count: number): OHLCV[] {
    return Array.from({ length: count }, (_, i) => ({
        time: from + i,
        open: from + i,
        high: from + i,
        low: from + i,
        close: from + i,
        volume: 1,
    }));
}

/** The bridge, with only the calls the provider makes. */
function bridge(overrides: Record<string, unknown> = {}) {
    const api = {
        availableContracts: vi.fn(async () => [NQU6, NQZ6, MNQU6, QGV6]),
        contracts: vi.fn(async () => [] as MidoriProjectXContract[]),
        bars: vi.fn(async () => []),
        subscribe: vi.fn(async () => 'sub-1'),
        unsubscribe: vi.fn(async () => {}),
        onBar: vi.fn(() => () => {}),
        subscribeQuotes: vi.fn(async () => 'quote-1'),
        unsubscribeQuotes: vi.fn(async () => {}),
        onQuote: vi.fn(() => () => {}),
        ...overrides,
    };
    vi.stubGlobal('window', { midori: { projectx: api } });
    return api;
}

beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('futures contract naming', () => {
    it('peels the month and year off a dated contract name', () => {
        expect(rootOf('NQU6')).toBe('NQ');
        expect(rootOf('MNQU6')).toBe('MNQ');
        expect(rootOf('QGV6')).toBe('QG');
        expect(rootOf('GCZ25')).toBe('GC');
        expect(rootOf('6EU6')).toBe('6E');
    });

    it('reads MNQU6 as the MNQ product, not as M with a month of N', () => {
        // The non-greedy match would take `M` first; only the year failing to parse rejects it.
        expect(rootOf('MNQU6')).toBe('MNQ');
    });

    it('answers null for a name that is not a dated code, rather than inventing a root', () => {
        expect(rootOf('SPX')).toBeNull();
        expect(rootOf('')).toBeNull();
    });
});

describe('ProjectX symbol index', () => {
    it('lists the dated contracts and folds them under their product root', async () => {
        bridge();
        const symbols = await new ProjectXProvider().listSymbols();
        expect(symbols.map((s) => s.ticker)).toEqual(['NQU6', 'NQZ6', 'MNQU6', 'QGV6']);
        expect(symbols.map((s) => s.group)).toEqual(['NQ', 'NQ', 'MNQ', 'QG']);
        expect(symbols.every((s) => s.type === 'futures')).toBe(true);
    });

    it('marks the active expiry as what the product itself loads', async () => {
        bridge();
        const symbols = await new ProjectXProvider().listSymbols();
        expect(symbols.find((s) => s.ticker === 'NQU6')?.default).toBe(true);
        expect(symbols.find((s) => s.ticker === 'NQZ6')?.default).toBeUndefined();
    });

    it('claims default at most once per product, even where the venue lists two active expiries', async () => {
        const bothActive = contract('CON.F.US.ENQ.Z26', 'NQZ6', 'December', { activeContract: true });
        bridge({ availableContracts: vi.fn(async () => [NQU6, bothActive]) });
        const symbols = await new ProjectXProvider().listSymbols();
        expect(symbols.filter((s) => s.group === 'NQ' && s.default)).toHaveLength(1);
        expect(symbols.find((s) => s.default)?.ticker).toBe('NQU6');
    });

    it('carries the venue product as the market, so sessions can differ per instrument', async () => {
        bridge();
        const symbols = await new ProjectXProvider().listSymbols();
        expect(symbols.find((s) => s.ticker === 'NQU6')?.market).toBe('ENQ');
        expect(symbols.find((s) => s.ticker === 'QGV6')?.market).toBe('NQG');
    });

    it('does not cache a failed listing, so the picker fills once the account connects', async () => {
        const failing = vi.fn(async () => { throw new Error('not connected'); });
        const api = bridge({ availableContracts: failing });
        const provider = new ProjectXProvider();
        expect(await provider.listSymbols()).toEqual([]);
        api.availableContracts.mockImplementation(async () => [NQU6]);
        expect((await provider.listSymbols()).map((s) => s.ticker)).toEqual(['NQU6']);
    });
});

describe('ProjectX ticker resolution', () => {
    it('resolves the venue short name to its dated contract', async () => {
        bridge();
        expect((await new ProjectXProvider().resolve('NQU6'))?.id).toBe('CON.F.US.ENQ.U26');
    });

    it('resolves a product root to the active expiry', async () => {
        bridge();
        expect((await new ProjectXProvider().resolve('NQ'))?.name).toBe('NQU6');
    });

    it('resolves the raw gateway id, for anything already holding one', async () => {
        bridge();
        expect((await new ProjectXProvider().resolve('CON.F.US.MNQ.U26'))?.name).toBe('MNQU6');
    });

    it('is case- and whitespace-insensitive about what was typed', async () => {
        bridge();
        expect((await new ProjectXProvider().resolve('  nqu6 '))?.name).toBe('NQU6');
    });

    it('falls back to a targeted search where listing does not serve the contract', async () => {
        const api = bridge({
            availableContracts: vi.fn(async () => [] as MidoriProjectXContract[]),
            contracts: vi.fn(async () => [QGV6]),
        });
        expect((await new ProjectXProvider().resolve('QGV6'))?.id).toBe('CON.F.US.NQG.V26');
        expect(api.contracts).toHaveBeenCalledWith('QGV6');
    });

    it('answers null rather than guessing when nothing matches', async () => {
        bridge({ availableContracts: vi.fn(async () => [] as MidoriProjectXContract[]) });
        expect(await new ProjectXProvider().resolve('NOPE')).toBeNull();
    });

    it('takes a stale expiry over nothing when the venue marks none active', async () => {
        const dormant = contract('CON.F.US.ENQ.U26', 'NQU6', 'September', { activeContract: false });
        bridge({ availableContracts: vi.fn(async () => [dormant]) });
        expect((await new ProjectXProvider().resolve('NQ'))?.name).toBe('NQU6');
    });
});

describe('ProjectX bars', () => {
    it('addresses the gateway by contract id, whatever was typed', async () => {
        const api = bridge();
        await new ProjectXProvider().getBars('NQ', '5m', { limit: 100 });
        expect(api.bars).toHaveBeenCalledWith({
            contractId: 'CON.F.US.ENQ.U26', timeframe: '5', from: undefined, to: undefined, limit: 100,
        });
    });

    it('passes the second timeframes through, in the spelling the picker produces', async () => {
        const api = bridge();
        const provider = new ProjectXProvider();
        for (const [typed, expected] of [['30S', '30S'], ['15s', '15S'], ['30s', '30S']] as const) {
            api.bars.mockClear();
            await provider.getBars('NQ', typed, { limit: 10 });
            expect(api.bars).toHaveBeenCalledWith(expect.objectContaining({ timeframe: expected }));
        }
    });

    it('refuses a timeframe the gateway does not serve instead of sending a guess', async () => {
        const api = bridge();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await new ProjectXProvider().getBars('NQ', '120', {})).toEqual([]);
        expect(api.bars).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalled();
    });

    it('returns an empty series, with a reason, for a contract that does not exist', async () => {
        const api = bridge({ availableContracts: vi.fn(async () => [] as MidoriProjectXContract[]) });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await new ProjectXProvider().getBars('NOPE', '1', {})).toEqual([]);
        expect(api.bars).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalled();
    });

    it('paints the newest 500 bars before fetching older segments', async () => {
        const recent = chartBars(1_501, 500);
        let releaseSecond: (page: OHLCV[]) => void = () => {};
        const second = new Promise<OHLCV[]>((resolve) => { releaseSecond = resolve; });
        const pages = [second, Promise.resolve(chartBars(501, 500)), Promise.resolve(chartBars(1, 500))];
        const requests: Array<{ from?: number; to?: number }> = [];
        const api = bridge({
            bars: vi.fn((request: { from?: number; to?: number }) => {
                requests.push(request);
                return request.to == null ? Promise.resolve(recent) : (pages.shift() ?? Promise.resolve([]));
            }),
        });
        const provider = new ProjectXProvider();
        const snapshots: OHLCV[][] = [];

        const loading = provider.getBarsProgressive('NQ', '5', { limit: 2_000 }, (batch) => snapshots.push(batch));
        await vi.waitFor(() => expect(snapshots.map((batch) => batch.length)).toEqual([500]));

        expect(api.bars).toHaveBeenNthCalledWith(1, expect.objectContaining({
            contractId: 'CON.F.US.ENQ.U26', timeframe: '5', to: undefined, limit: 500,
        }));
        expect(requests[0]!.from!).toBeLessThan(Date.now() - 3 * 24 * 60 * 60_000);
        expect(api.bars).toHaveBeenNthCalledWith(2, expect.objectContaining({
            contractId: 'CON.F.US.ENQ.U26', timeframe: '5', to: 1_500, limit: 500,
        }));

        releaseSecond(chartBars(1_001, 500));
        const full = await loading;
        expect(snapshots.map((batch) => batch.length)).toEqual([500, 1_000, 1_500]);
        expect(full).toHaveLength(2_000);
        expect(full[0]?.time).toBe(1);
        expect(full[full.length - 1]?.time).toBe(2_000);
        expect(api.bars).toHaveBeenCalledTimes(4);
    });

    it('stops before the next older segment after the chart switches away', async () => {
        const api = bridge({ bars: vi.fn(async () => chartBars(1_501, 500)) });
        const provider = new ProjectXProvider();
        const abort = new AbortController();

        const full = await provider.getBarsProgressive(
            'NQ',
            '5',
            { limit: 2_000 },
            () => abort.abort(),
            { signal: abort.signal },
        );

        expect(full).toHaveLength(500);
        expect(api.bars).toHaveBeenCalledTimes(1);
    });
});

describe('ProjectX symbol info', () => {
    it('takes the tick from the venue rather than deriving it from decimal places', async () => {
        bridge();
        const info = await new ProjectXProvider().getSymbolInfo('QGV6');
        // Natural gas moves in 0.005 — a tick that is not a power of ten.
        expect(info?.mintick).toBe(0.005);
        expect(info?.pricescale).toBe(1000);
    });

    it('scales the price by the quoted precision, not by one over the tick', async () => {
        bridge();
        // A quarter-point tick is quoted to two decimals. One over the tick would say 4.
        expect((await new ProjectXProvider().getSymbolInfo('NQU6'))?.pricescale).toBe(100);
    });

    it('handles the ticks that are not decimal at all', async () => {
        const bond = contract('CON.F.US.TN.Z26', 'TNZ6', 'Ultra 10yr Treasury Note', { tickSize: 0.015625, tickValue: 15.625, symbolId: 'F.US.TN' });
        const yen = contract('CON.F.US.JY6.Z26', '6JZ6', 'Japanese Yen', { tickSize: 5e-7, tickValue: 6.25, symbolId: 'F.US.JY6' });
        bridge({ availableContracts: vi.fn(async () => [bond, yen]) });
        const provider = new ProjectXProvider();
        // 1/64th, and a yen tick seven decimals down — both real contracts on this gateway.
        expect((await provider.getSymbolInfo('TNZ6'))?.pricescale).toBe(1_000_000);
        expect((await provider.getSymbolInfo('6JZ6'))?.mintick).toBe(5e-7);
        expect((await provider.getSymbolInfo('6JZ6'))?.pricescale).toBe(10_000_000);
    });

    it('carries the contract id and tick value, which sizing and P&L cannot be computed without', async () => {
        bridge();
        const info = await new ProjectXProvider().getSymbolInfo('MNQU6');
        expect(info?.dealing).toEqual({
            contractId: 'CON.F.US.MNQ.U26', tickSize: 0.25, tickValue: 0.5, minSize: 1, sizeStep: 1,
        });
    });

    it('names the resolved contract, so a root-typed ticker reports the expiry it got', async () => {
        bridge();
        const info = await new ProjectXProvider().getSymbolInfo('NQ');
        expect(info?.ticker).toBe('NQU6');
        expect(info?.tickerid).toBe('PROJECTX:NQU6');
    });

    it('sizes futures in whole contracts', () => {
        expect(projectXDealing(NQU6)).toMatchObject({ minSize: 1, sizeStep: 1 });
    });
});

describe('ProjectX live subscription', () => {
    it('subscribes the resolved contract id and hands back the venue bars', async () => {
        const handlers: Array<(p: { subscriptionId: string; bar: unknown }) => void> = [];
        const api = bridge({ onBar: vi.fn((h: (p: { subscriptionId: string; bar: unknown }) => void) => { handlers.push(h); return () => {}; }) });
        const bars: unknown[] = [];
        new ProjectXProvider().subscribe('NQ', '1m', (bar) => bars.push(bar));
        await vi.waitFor(() => expect(api.subscribe).toHaveBeenCalled());
        expect(api.subscribe).toHaveBeenCalledWith({ contractId: 'CON.F.US.ENQ.U26', timeframe: '1' });

        const bar = { time: 1, open: 2, high: 3, low: 1, close: 2, volume: 5 };
        handlers[0]!({ subscriptionId: 'sub-1', bar });
        expect(bars).toEqual([bar]);
    });

    it('ignores bars belonging to another subscription', async () => {
        const handlers: Array<(p: { subscriptionId: string; bar: unknown }) => void> = [];
        const api = bridge({ onBar: vi.fn((h: (p: { subscriptionId: string; bar: unknown }) => void) => { handlers.push(h); return () => {}; }) });
        const bars: unknown[] = [];
        new ProjectXProvider().subscribe('NQ', '1', (bar) => bars.push(bar));
        await vi.waitFor(() => expect(api.subscribe).toHaveBeenCalled());
        handlers[0]!({ subscriptionId: 'someone-else', bar: { time: 1 } });
        expect(bars).toEqual([]);
    });

    it('hands the slot back when unsubscribed before the venue answered', async () => {
        let release!: (id: string) => void;
        const api = bridge({ subscribe: vi.fn(() => new Promise<string>((resolve) => { release = resolve; })) });
        const stop = new ProjectXProvider().subscribe('NQ', '1', () => {});
        await vi.waitFor(() => expect(api.subscribe).toHaveBeenCalled());
        stop();
        release('late-id');
        await vi.waitFor(() => expect(api.unsubscribe).toHaveBeenCalledWith('late-id'));
    });

    it('reports a failed subscription without falling back to polling', async () => {
        const api = bridge({ subscribe: vi.fn(async () => { throw new Error('hub refused'); }) });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        new ProjectXProvider().subscribe('NQ', '1', () => {});
        await vi.waitFor(() => expect(warn).toHaveBeenCalled());
        // A quiet tape is a quiet market, not a dead stream — nothing starts polling here.
        expect(api.bars).not.toHaveBeenCalled();
    });

    it('subscribes quotes by contract id and stops cleanly', async () => {
        const api = bridge();
        const stop = new ProjectXProvider().subscribeQuotes('NQU6', () => {});
        await vi.waitFor(() => expect(api.subscribeQuotes).toHaveBeenCalledWith({ contractId: 'CON.F.US.ENQ.U26' }));
        stop();
        await vi.waitFor(() => expect(api.unsubscribeQuotes).toHaveBeenCalledWith('quote-1'));
    });
});
