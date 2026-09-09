// The bid/ask readout's two decisions, kept out of the DOM so they can be checked:
// how many decimals an instrument's increment implies (a quote printed to the wrong
// precision is a quote that reads as a different price), and whether a provider streams
// two-sided prices at all — asked of the instance rather than of a list of venue names.
// See app/renderer/quotes/.
import { describe, it, expect } from 'vitest';
import { decimalsOf } from '../app/renderer/quotes/quoteStrip';
import { quoteFeed } from '../app/renderer/quotes/installQuotes';
import type { DataProvider } from '../src/plugin';

describe('decimalsOf', () => {
    it('reads the precision an instrument is quoted to off its increment', () => {
        expect(decimalsOf(0.00001)).toBe(5); // EUR/USD
        expect(decimalsOf(0.001)).toBe(3); // USD/JPY
        expect(decimalsOf(0.01)).toBe(2); // an index, or gold
        expect(decimalsOf(1)).toBe(0);
    });

    it('survives the exponent form a small increment prints as', () => {
        // String(0.0000001) is '1e-7' — reading the decimals off that gives 0, and the
        // quote would print as a whole number.
        expect(decimalsOf(0.0000001)).toBe(7);
    });

    it('does not report a finer precision than a half-increment has', () => {
        // 0.5 quotes to one decimal, not to none: 1912.5 is a price, 1912.25 is not.
        expect(decimalsOf(0.5)).toBe(1);
        expect(decimalsOf(0.25)).toBe(2);
    });

    it('falls back rather than dividing by an increment that cannot be one', () => {
        expect(decimalsOf(0)).toBe(2);
        expect(decimalsOf(-1)).toBe(2);
    });
});

describe('quoteFeed', () => {
    const bars = { info: () => ({}), getBars: () => Promise.resolve([]) } as unknown as DataProvider;

    it('passes a provider that streams two-sided prices', () => {
        const quoting = { ...bars, subscribeQuotes: () => () => {} } as unknown as DataProvider;
        expect(quoteFeed(quoting)).not.toBeNull();
    });

    it('rejects one that only serves candles', () => {
        // Every crypto provider is this shape: one price, no sides.
        expect(quoteFeed(bars)).toBeNull();
    });

    it('rejects an unregistered provider rather than assuming it quotes', () => {
        expect(quoteFeed(undefined)).toBeNull();
    });

    it('is not fooled by a non-callable property of the same name', () => {
        const odd = { ...bars, subscribeQuotes: true } as unknown as DataProvider;
        expect(quoteFeed(odd)).toBeNull();
    });
});
