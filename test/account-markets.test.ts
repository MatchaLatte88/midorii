// Which market arming an account brings the chart back to.
//
// A wrong answer here puts the chart on a market the account cannot trade, or on the other
// account's market — so the choice itself is asserted, not only the storage round trip.
import { describe, it, expect } from 'vitest';
import { leftArmedMarket, leftBehindNotice, marketForAccount, normalizeAccountMarkets } from '../app/renderer/trading/accountMarkets';

const PROVIDERS: Record<string, string> = {
    'projectx:GC': 'projectx',
    'capital:US100': 'capital',
    'binance:BTCUSDT': 'binance',
};
const providerOf = (symbol: string): string | null => PROVIDERS[symbol] ?? null;

describe('the market an account is armed on', () => {
    it('brings back the market and timeframe the account was left on, over whatever is on screen', () => {
        const remembered = { symbol: 'projectx:GC', timeframe: '1' };
        expect(marketForAccount(remembered, 'capital:US100', 'projectx', providerOf)).toEqual(remembered);
    });

    it('keeps the market on screen, and its timeframe, when nothing is remembered and it is this venue\'s', () => {
        expect(marketForAccount(null, 'capital:US100', 'capital', providerOf)).toEqual({ symbol: 'capital:US100', timeframe: null });
    });

    it('asks when nothing is remembered and the chart is on another venue', () => {
        expect(marketForAccount(null, 'binance:BTCUSDT', 'capital', providerOf)).toBeNull();
        expect(marketForAccount(null, '', 'capital', providerOf)).toBeNull();
    });

    it('ignores a remembered market this venue no longer serves', () => {
        const gone = { symbol: 'projectx:ZZ', timeframe: '5' };
        expect(marketForAccount(gone, 'projectx:GC', 'projectx', providerOf)).toEqual({ symbol: 'projectx:GC', timeframe: null });
        expect(marketForAccount(gone, 'binance:BTCUSDT', 'projectx', providerOf)).toBeNull();
    });

    it('never hands one venue\'s account a market remembered under another venue', () => {
        const other = { symbol: 'capital:US100', timeframe: '5' };
        expect(marketForAccount(other, 'binance:BTCUSDT', 'projectx', providerOf)).toBeNull();
    });
});

describe('what is read back from storage', () => {
    it('keeps every usable entry and drops the rest', () => {
        expect(normalizeAccountMarkets({
            'projectx:7': { symbol: 'projectx:GC', timeframe: '1' },
            'capital:live': { symbol: 'capital:US100' },
            'bybit:demo': { symbol: '', timeframe: '5' },
            'binance-spot': null,
        })).toEqual({ 'projectx:7': { symbol: 'projectx:GC', timeframe: '1' } });
    });

    it('reads nothing out of something that is not a map', () => {
        expect(normalizeAccountMarkets(null)).toEqual({});
        expect(normalizeAccountMarkets('x')).toEqual({});
        expect(normalizeAccountMarkets([{ symbol: 'a', timeframe: '1' }])).toEqual({});
    });
});

describe('the chart moving away from an armed account', () => {
    const gold = { provider: 'projectx', ticker: 'GC' };

    it('reads another instrument as leaving, and the same one in another spelling or timeframe as staying', () => {
        expect(leftArmedMarket(gold, { provider: 'projectx', ticker: 'SI' })).toBe(true);
        expect(leftArmedMarket(gold, { provider: 'capital', ticker: 'GC' })).toBe(true);
        expect(leftArmedMarket(gold, { provider: 'projectx', ticker: 'gc' })).toBe(false);
    });

    it('reads a symbol nothing resolves as leaving, and nothing armed as never leaving', () => {
        expect(leftArmedMarket(gold, null)).toBe(true);
        expect(leftArmedMarket(null, { provider: 'projectx', ticker: 'SI' })).toBe(false);
    });

    it('names what stays open at the venue, and says nothing when nothing does', () => {
        expect(leftBehindNotice('GC', { positions: 1, orders: 2 })).toMatch(/^1 open position and 2 working orders on GC stay at the venue/);
        expect(leftBehindNotice('GC', { positions: 0, orders: 1 })).toMatch(/^1 working order on GC/);
        expect(leftBehindNotice('GC', { positions: 0, orders: 0 })).toBeNull();
    });
});
