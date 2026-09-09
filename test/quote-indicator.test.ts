// The bid/ask levels: what gets drawn, and what each of the three switches actually takes
// away. The switches are the point — two extra lines across the plot and two extra chips on
// the scale are exactly the kind of thing somebody wants gone, and "optional" is only true
// if turning it off removes it rather than dimming it.
// See app/renderer/quotes/.
import { describe, it, expect } from 'vitest';
import { quotePriceLines, quoteIndicatorInputs, BID_LINE_ID, ASK_LINE_ID } from '../app/renderer/quotes/quoteIndicator';
import { normalizeQuoteDisplay, DEFAULT_QUOTE_DISPLAY, type QuoteDisplay } from '../app/renderer/quotes/quoteDisplay';

const display = (over: Partial<QuoteDisplay> = {}): QuoteDisplay => ({ ...DEFAULT_QUOTE_DISPLAY, ...over });

describe('quotePriceLines', () => {
    it('draws the two sides, the ask above the bid', () => {
        const lines = quotePriceLines(1.09241, 1.09253, true);
        expect(lines.map((l) => l.id)).toEqual([BID_LINE_ID, ASK_LINE_ID]);
        const bid = lines.find((l) => l.id === BID_LINE_ID)!;
        const ask = lines.find((l) => l.id === ASK_LINE_ID)!;
        expect(ask.price).toBeGreaterThan(bid.price);
        // One colour: they are two ends of one measurement, not two separate levels.
        expect(bid.color).toBe(ask.color);
    });

    it('chips the prices onto the scale only when the brackets are wanted', () => {
        expect(quotePriceLines(1.0924, 1.0925, true).every((l) => l.axisTag)).toBe(true);
        // Off, the levels stay and the scale is left to the price it already shows.
        const bare = quotePriceLines(1.0924, 1.0925, false);
        expect(bare).toHaveLength(2);
        expect(bare.every((l) => !l.axisTag)).toBe(true);
    });

    it('draws nothing before a quote has arrived', () => {
        // Zero is not a price. Drawing a level there would put two lines at the bottom of
        // every chart for as long as the first tick takes to land.
        expect(quotePriceLines(0, 0, true)).toEqual([]);
        expect(quotePriceLines(1.0924, 0, true)).toEqual([]);
        expect(quotePriceLines(0, 1.0925, true)).toEqual([]);
    });
});

describe('quoteIndicatorInputs', () => {
    it('passes the quote through when the levels are wanted', () => {
        expect(quoteIndicatorInputs(1.09241, 1.09253, display())).toEqual({
            bid: 1.09241, ask: 1.09253, showBrackets: true,
        });
    });

    it('removes the levels entirely when they are switched off', () => {
        // Not dimmed, not left in place — a zeroed quote is what the indicator reads as
        // "nothing to draw".
        expect(quoteIndicatorInputs(1.09241, 1.09253, display({ showLines: false }))).toEqual({
            bid: 0, ask: 0, showBrackets: false,
        });
    });

    it('takes the brackets with the lines — a bracket is a label on a line', () => {
        const out = quoteIndicatorInputs(1.09241, 1.09253, display({ showLines: false, showBrackets: true }));
        expect(out.showBrackets).toBe(false);
    });

    it('keeps the levels when only the brackets are switched off', () => {
        expect(quoteIndicatorInputs(1.09241, 1.09253, display({ showBrackets: false }))).toEqual({
            bid: 1.09241, ask: 1.09253, showBrackets: false,
        });
    });
});

describe('normalizeQuoteDisplay', () => {
    it('fills in what a stored record does not say', () => {
        expect(normalizeQuoteDisplay({ showCard: false })).toEqual({
            showCard: false, showLines: true, showBrackets: true,
        });
    });

    it('refuses what a record cannot mean', () => {
        // Storage is data from outside the program: a hand-edited entry, or one written by
        // an older version that had no such field.
        expect(normalizeQuoteDisplay({ showLines: 'yes', showBrackets: 1 })).toEqual(DEFAULT_QUOTE_DISPLAY);
        expect(normalizeQuoteDisplay(null)).toEqual(DEFAULT_QUOTE_DISPLAY);
        expect(normalizeQuoteDisplay('nonsense')).toEqual(DEFAULT_QUOTE_DISPLAY);
    });

    it('shows everything by default', () => {
        expect(DEFAULT_QUOTE_DISPLAY).toEqual({ showCard: true, showLines: true, showBrackets: true });
    });
});
