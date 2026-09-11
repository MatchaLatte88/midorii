import { describe, expect, it } from 'vitest';
import { timeframeToMs } from '../src/data/timeframe';
import { parseTimeframe } from '../src/widget/timeframe';

/**
 * The picker and the core have to agree about what a timeframe string means.
 *
 * They did not: the picker canonicalises a typed `S` into `30S`, and `timeframeToMs` knew
 * only m/h/d/w, so every second-resolution string fell through to the 1h fallback — a
 * 30-second chart would have bucketed its bars hourly, quietly and with no error anywhere.
 * These tests pin the round trip rather than either half on its own.
 */
describe('second timeframes survive the picker → core round trip', () => {
    it('reads the second suffix the picker produces', () => {
        expect(timeframeToMs('15S')).toBe(15_000);
        expect(timeframeToMs('30S')).toBe(30_000);
        expect(timeframeToMs('1S')).toBe(1_000);
    });

    it('agrees with the picker on the duration, whatever was typed', () => {
        for (const typed of ['15s', '30s', 'S', '5S']) {
            const parsed = parseTimeframe(typed);
            expect(parsed.valid).toBe(true);
            expect(timeframeToMs(parsed.canonical!)).toBe(parsed.ms);
        }
    });

    it('is case-insensitive about the suffix, like every other unit', () => {
        expect(timeframeToMs('30s')).toBe(timeframeToMs('30S'));
    });

    it('leaves the timeframes that already worked alone', () => {
        expect(timeframeToMs('1')).toBe(60_000);       // a bare number is minutes
        expect(timeframeToMs('60')).toBe(3_600_000);
        expect(timeframeToMs('240')).toBe(14_400_000);
        expect(timeframeToMs('15m')).toBe(900_000);
        expect(timeframeToMs('4h')).toBe(14_400_000);
        expect(timeframeToMs('D')).toBe(86_400_000);
        expect(timeframeToMs('W')).toBe(604_800_000);
        expect(timeframeToMs('M')).toBe(2_592_000_000);
    });

    it('still falls back to an hour for something it cannot read', () => {
        expect(timeframeToMs('nonsense')).toBe(3_600_000);
        expect(timeframeToMs('')).toBe(3_600_000);
    });

    it('does not read a bare S as a number of seconds', () => {
        // The picker refuses to canonicalise a countless unit into anything but `1S`, and the
        // core needs digits — neither should invent a count.
        expect(parseTimeframe('S').canonical).toBe('1S');
        expect(timeframeToMs('S')).toBe(3_600_000);
    });
});
