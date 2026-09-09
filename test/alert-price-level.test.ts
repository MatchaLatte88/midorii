// Alert levels are born from the pointer, not the keyboard: a right-click maps a pixel row
// back through the price scale, which hands over every decimal a double can hold. These are
// the two things that keep such a number readable — snapping it to the symbol's own tick,
// and printing it without the float dust. See app/renderer/alerts/symbolTick.ts.
import { describe, it, expect } from 'vitest';
import { snapToTick, tickSizeOf, trackSymbolTicks } from '../app/renderer/alerts/symbolTick';
import { formatPrice } from '../app/renderer/format';
import type { Vela } from '../src';

/** A chart that reports one market and one symbol's metadata, like the real one does. */
function stubChart(symbol: string, info: Record<string, unknown> | undefined): Vela {
    return {
        market: { symbol, offline: false },
        data: { symbolInfo: () => Promise.resolve(info) },
        on: () => () => {},
    } as unknown as Vela;
}

describe('snapToTick', () => {
    it('puts a pointer price on the symbol\'s own grid of tradable levels', async () => {
        const chart = stubChart('binance:BTCUSDT', { ticker: 'BTCUSDT', mintick: 0.01 });
        trackSymbolTicks(chart);
        await Promise.resolve(); // let the symbolInfo promise land
        expect(tickSizeOf('binance:BTCUSDT')).toBe(0.01);
        // The number a right-click at ~111234.57 actually produces.
        expect(snapToTick(111234.56789012345, 'binance:BTCUSDT')).toBe(111234.57);
    });

    it('leaves no float dust behind — the snapped value prints as itself', async () => {
        const chart = stubChart('binance:ETHUSDT', { ticker: 'ETHUSDT', mintick: 0.01 });
        trackSymbolTicks(chart);
        await Promise.resolve();
        // 1112345 * 0.01 is not exactly 11123.45 in binary floating point.
        const snapped = snapToTick(11123.449999999999, 'binance:ETHUSDT');
        expect(snapped).toBe(11123.45);
        expect(String(snapped)).toBe('11123.45');
    });

    it('respects a coarser tick — a level between two of them cannot be alerted on', async () => {
        const chart = stubChart('capital:GOLD', { ticker: 'GOLD', mintick: 0.5 });
        trackSymbolTicks(chart);
        await Promise.resolve();
        expect(snapToTick(2317.34, 'capital:GOLD')).toBe(2317.5);
        expect(snapToTick(2317.19, 'capital:GOLD')).toBe(2317);
    });

    it('leaves the price untouched for a symbol whose tick never arrived', async () => {
        const chart = stubChart('binance:NEWCOIN', { ticker: 'NEWCOIN' }); // no mintick
        trackSymbolTicks(chart);
        await Promise.resolve();
        expect(tickSizeOf('binance:NEWCOIN')).toBeUndefined();
        // Better an ugly level than one snapped to a guessed grid.
        expect(snapToTick(111234.56789012345, 'binance:NEWCOIN')).toBe(111234.56789012345);
        expect(snapToTick(1.5, 'never:CHARTED')).toBe(1.5);
    });
});

describe('formatPrice', () => {
    it('cuts the decimal tail off a level that was stored before snapping existed', () => {
        expect(formatPrice(111234.56789012345)).toBe('111234.56789012');
    });

    it('keeps a round price round and never pads it', () => {
        expect(formatPrice(111234.57)).toBe('111234.57');
        expect(formatPrice(2317)).toBe('2317');
        expect(formatPrice(0.00012345)).toBe('0.00012345');
    });

    it('reads as a dash for a level that is not a number', () => {
        expect(formatPrice(Number.NaN)).toBe('—');
        expect(formatPrice(Number.POSITIVE_INFINITY)).toBe('—');
    });
});
