// A paper account on a market that states more than candles: a contract's point value and size
// grid, a two-sided quote that market orders fill at, and the sound when something fills.
import { afterEach, describe, expect, it, vi } from 'vitest';

const { chime } = vi.hoisted(() => ({ chime: vi.fn() }));
vi.mock('../app/renderer/trading/fillChime', () => ({ chime }));

import { PaperController } from '../app/renderer/trading/PaperController';
import { DEFAULT_PAPER_SETTINGS } from '../app/renderer/trading/paperSettings';

const T0 = Date.UTC(2026, 8, 13, 14, 0);

function account(over: { chime?: boolean } = {}): PaperController {
    const c = new PaperController({
        symbol: 'projectx:GC',
        settings: { ...DEFAULT_PAPER_SETTINGS, balance: 50_000, feeRate: 0, spreadPct: 0.001, slippagePct: 0 },
        ...over,
    });
    // The first update marks rather than fills; the second stands the account on a price.
    c.onBar({ time: T0, open: 2_000, high: 2_000, low: 2_000, close: 2_000, volume: 0 });
    c.onBar({ time: T0, open: 2_000, high: 2_000, low: 2_000, close: 2_000, volume: 1 });
    return c;
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('a paper account on a futures contract', () => {
    it('takes the point value and size grid of the contract', () => {
        const c = account();
        c.setInstrument({ pointValue: 100, sizeStep: 1, minSize: 1 });
        expect(c.pointValue()).toBe(100);
        expect(c.sizeOnGrid(2.7)).toBe(2);
        expect(c.sizeOnGrid(0.4)).toBe(0);
        expect(c.dealingRules()).toEqual({ sizeStep: 1, minSize: 1 });
        c.setInstrument(null);
        expect(c.pointValue()).toBe(1);
        expect(c.sizeOnGrid(0.4)).toBe(0.4);
    });

    it('refuses a new point value while a position is open', () => {
        const c = account();
        c.setInstrument({ pointValue: 100 });
        c.order({ side: 'buy', size: 1, type: 'market' });
        expect(() => c.setInstrument({ pointValue: 50 })).toThrow(/cannot change/);
        expect(c.pointValue()).toBe(100);
    });
});

describe('market orders against a quote', () => {
    it('buys at the ask while the quote is fresh', () => {
        const c = account();
        c.markQuote(1_999.5, 2_000.5);
        c.order({ side: 'buy', size: 1, type: 'market' });
        expect(c.broker.position!.entryPrice).toBe(2_000.5);
    });

    it('keeps the other side when a quote message carries only one', () => {
        const c = account();
        c.markQuote(1_999.5, 2_000.5);
        c.markQuote(1_999.75, null);
        expect(c.quote()).toEqual({ bid: 1_999.75, ask: 2_000.5 });
    });

    it('goes back to the last price and its simulated spread once the quote has gone quiet', () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        const c = account();
        c.markQuote(1_999.5, 2_000.5);
        vi.setSystemTime(T0 + 6_000);
        expect(c.quote()).toBeNull();
        c.order({ side: 'buy', size: 1, type: 'market' });
        expect(c.broker.position!.entryPrice).toBeCloseTo(2_000 * (1 + 0.0005));
    });

    it('forgets the quote when the account moves to another market', () => {
        const c = account();
        c.markQuote(1_999.5, 2_000.5);
        expect(c.follow('capital:US100')).toBe(true);
        expect(c.quote()).toBeNull();
    });
});

describe('the fill sound', () => {
    it('rings a fill, then a close, on the account that asked for it', () => {
        chime.mockClear();
        const c = account({ chime: true });
        c.order({ side: 'buy', size: 1, type: 'market' });
        expect(chime.mock.calls).toEqual([['fill']]);
        c.flatten();
        expect(chime.mock.calls).toEqual([['fill'], ['close']]);
    });

    it('stays quiet on an account nobody is watching, and on what a catch-up replays', () => {
        chime.mockClear();
        account().order({ side: 'buy', size: 1, type: 'market' });
        expect(chime).not.toHaveBeenCalled();

        const c = account({ chime: true });
        c.order({ side: 'buy', size: 1, type: 'limit', limitPrice: 1_990 });
        c.catchUp([{ time: T0 + 60_000, open: 1_995, high: 1_995, low: 1_985, close: 1_988, volume: 5 }]);
        expect(c.broker.fills.length).toBe(1);
        expect(chime).not.toHaveBeenCalled();
    });
});
