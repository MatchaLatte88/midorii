import { describe, it, expect } from 'vitest';
import {
    SILVER_BULLET_WINDOWS,
    detectSilverBullet,
    type SilverBulletSetup,
} from '../src/core/analysis/silverBullet';
import type { OHLCV } from '../src/core/model/ohlcv';

const STEP = 5 * 60_000;

/**
 * One complete bearish setup, laid out so that bar 8 — the structure shift — falls on 10:00
 * New York (15:00 UTC in March, EST). The chain is:
 *
 *   bar 2   swing high at 110
 *   bar 5   wick to 111 and a close back below — the sweep
 *   bar 8   bearish gap [104, 105] confirmed, and the same bar closes below bar 5's open (107),
 *           which is the structure shift
 *   bar 10  price comes back to 104 — the fill
 *   bar 12  the low reaches 90 — the target at 2R
 */
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

/** Bars from OHLC rows, 5m apart, with `shiftAt` landing on the given UTC instant. */
function bars(rows = CHAIN, anchor = '2024-03-05T15:00:00Z', shiftAt = 8): OHLCV[] {
    const start = Date.parse(anchor) - shiftAt * STEP;
    return rows.map(([open, high, low, close], i) => ({
        time: start + i * STEP, open, high, low, close, volume: 1,
    }));
}

function only(setups: readonly SilverBulletSetup[]): SilverBulletSetup {
    expect(setups).toHaveLength(1);
    return setups[0]!;
}

describe('silver bullet detector', () => {
    it('reads the whole chain off a sweep, a gap and a shift', () => {
        const setup = only(detectSilverBullet(bars()));

        expect(setup.direction).toBe('bear');
        expect(setup.window).toBe('am');
        expect(setup.sweepIndex).toBe(5);
        expect(setup.sweepExtreme).toBe(111);
        expect(setup.gapStartIndex).toBe(6);
        expect(setup.gapIndex).toBe(8);
        expect(setup.gapTop).toBe(105);
        expect(setup.gapBottom).toBe(104);
        // The last bullish candle before the gap started, and its open.
        expect(setup.shiftRefIndex).toBe(5);
        expect(setup.shiftLevel).toBe(107);
    });

    it('confirms at the shift, and draws from the sweep', () => {
        const setup = only(detectSilverBullet(bars()));

        // The only index a strategy may read is the shift — never the fill, which is hindsight.
        expect(setup.index).toBe(setup.shiftIndex);
        expect(setup.index).toBe(8);
        expect(setup.startIndex).toBe(setup.sweepIndex);
        expect(setup.index).toBeGreaterThan(setup.startIndex);
        // Nothing in the chain is knowable after the bar that confirms it.
        expect(setup.gapIndex).toBeLessThanOrEqual(setup.index);
    });

    it('rests the order at the gap edge, with the stop beyond the wick', () => {
        const setup = only(detectSilverBullet(bars()));

        expect(setup.entryPrice).toBe(104); // the near edge of a bearish gap is its bottom
        expect(setup.stop).toBe(111);
        expect(setup.risk).toBe(7);
        expect(setup.target).toBe(104 - 2 * 7);
        expect(setup.expiryIndex).toBe(setup.gapIndex + 12);
    });

    it('fills no earlier than the bar after the shift and resolves the outcome', () => {
        const setup = only(detectSilverBullet(bars()));

        expect(setup.fillIndex).toBe(10);
        expect(setup.fillIndex!).toBeGreaterThan(setup.index);
        expect(setup.outcome).toBe('target');
        expect(setup.outcomeIndex).toBe(12);
        expect(setup.barsToOutcome).toBe(2);
    });

    it('keeps the stop when one bar reaches both levels', () => {
        // Bar 11 now runs to 111 as well as down to 95: pessimistic, so the stop wins.
        const rows = CHAIN.map((r) => [...r] as typeof CHAIN[number]);
        rows[11] = [103, 111, 95, 96];

        const setup = only(detectSilverBullet(bars(rows)));
        expect(setup.outcome).toBe('stop');
        expect(setup.outcomeIndex).toBe(11);
    });

    it('reports a setup price never came back to, and only when asked', () => {
        // Nothing after the shift trades back up to 104.
        const rows = CHAIN.map((r) => [...r] as typeof CHAIN[number]);
        rows[10] = [100.5, 101, 100, 100.5];

        expect(detectSilverBullet(bars(rows))).toHaveLength(0);

        const setup = only(detectSilverBullet(bars(rows), { show: 'all' }));
        expect(setup.fillIndex).toBeNull();
        // The window runs past the end of the data, so the order is still waiting.
        expect(setup.outcome).toBe('armed');
        expect(setup.expiryIndex).toBeGreaterThan(rows.length - 1);
    });

    it('expires the order once its window closes', () => {
        const rows = CHAIN.map((r) => [...r] as typeof CHAIN[number]);
        rows[10] = [100.5, 101, 100, 100.5];

        const setup = only(detectSilverBullet(bars(rows), { show: 'all', maxGapToEntry: 3 }));
        expect(setup.expiryIndex).toBe(11);
        expect(setup.outcome).toBe('expired');
        expect(setup.fillIndex).toBeNull();
    });

    it('reads the hours off a New York clock, not a UTC one', () => {
        // Same bars, shifted so the structure shift lands at 09:00 New York — an hour early.
        expect(detectSilverBullet(bars(CHAIN, '2024-03-05T14:00:00Z'))).toHaveLength(0);
        expect(detectSilverBullet(bars(CHAIN, '2024-03-05T15:00:00Z'))).toHaveLength(1);

        /* Summer time: the same 10:00 New York is now 14:00 UTC. A window pinned to a UTC hour
         * would find the setup at 15:00 and miss this one. */
        expect(detectSilverBullet(bars(CHAIN, '2024-07-09T14:00:00Z'))).toHaveLength(1);
        expect(detectSilverBullet(bars(CHAIN, '2024-07-09T15:00:00Z'))).toHaveLength(0);
    });

    it('honours which hours are switched on', () => {
        expect(detectSilverBullet(bars(), { windows: ['am'] })).toHaveLength(1);
        expect(detectSilverBullet(bars(), { windows: ['london', 'pm'] })).toHaveLength(0);
        // No windows is a switched-off indicator, not an error.
        expect(detectSilverBullet(bars(), { windows: [] })).toHaveLength(0);
    });

    it('demands the whole chain inside the hour under the stricter scope', () => {
        // The sweep sits at 09:45 New York, before the window opens.
        expect(detectSilverBullet(bars(), { scope: 'all', show: 'all' })).toHaveLength(0);
        expect(detectSilverBullet(bars(), { scope: 'signal', show: 'all' })).toHaveLength(1);
    });

    it('drops gaps thinner than the minimum', () => {
        // The gap is one point wide.
        expect(detectSilverBullet(bars(), { minGapSize: 0.5 })).toHaveLength(1);
        expect(detectSilverBullet(bars(), { minGapSize: 2 })).toHaveLength(0);
    });

    it('refuses settings it cannot honour rather than correcting them', () => {
        expect(() => detectSilverBullet(bars(), { rrr: 0 })).toThrow(/rrr/);
        expect(() => detectSilverBullet(bars(), { maxGapToEntry: 0 })).toThrow(/maxGapToEntry/);
        // @ts-expect-error — an unknown window is a caller bug, not a silent no-op.
        expect(() => detectSilverBullet(bars(), { windows: ['asia'] })).toThrow(/unknown window/);
    });

    it('names the three hours the setup is named after', () => {
        expect(SILVER_BULLET_WINDOWS.map((w) => [w.id, w.startMin])).toEqual([
            ['london', 180], ['am', 600], ['pm', 840],
        ]);
    });

    it('has nothing to say about an empty series', () => {
        expect(detectSilverBullet([])).toEqual([]);
    });
});
