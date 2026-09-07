import { describe, it, expect } from 'vitest';
import {
    formatDay, formatMoney, formatPercent, formatProfitFactor, formatR, formatSignedMoney,
    formatSize, formatWhen, rMultiple,
} from '../app/renderer/format';
import { equityPath } from '../app/renderer/runs/runStats';

const MINUS = '−';

describe('run library — figures', () => {
    it('groups money and uses a real minus, never a hyphen', () => {
        expect(formatMoney(1234.5)).toBe('1,234.50');
        expect(formatMoney(-890)).toBe(`${MINUS}890.00`);
        expect(formatMoney(0)).toBe('0.00');
        expect(formatSignedMoney(12.3)).toBe('+12.30');
        expect(formatSignedMoney(-12.3)).toBe(`${MINUS}12.30`);
        // Zero has no direction to show.
        expect(formatSignedMoney(0)).toBe('0.00');
    });

    it('reads an unanswerable figure as a dash, not as zero', () => {
        // No trades means no win rate. 0% would say the account lost every time.
        expect(formatPercent(null)).toBe('—');
        expect(formatPercent(undefined)).toBe('—');
        expect(formatPercent(0)).toBe('0.00%');
        expect(formatPercent(0.5, 0)).toBe('50%');
        expect(formatPercent(-0.1234, 2)).toBe(`${MINUS}12.34%`);
        expect(formatPercent(0.1234, 2, true)).toBe('+12.34%');
    });

    it('reads a profit factor with no losses as infinite, which is what null means there', () => {
        // summarize() returns null for "won something, lost nothing" — the one place in the
        // stats where null is a value rather than a missing answer.
        expect(formatProfitFactor(null)).toBe('∞');
        expect(formatProfitFactor(1.8367)).toBe('1.84');
        expect(formatProfitFactor(0)).toBe('0.00');
        expect(formatProfitFactor(undefined)).toBe('—');
    });

    it('prints a size without the floating-point dust of adding two of them', () => {
        // 0.2 + 0.1 is 0.30000000000000004, and a size readout is where that shows.
        expect(formatSize(0.1 + 0.2)).toBe('0.3');
        expect(formatSize(1234.5)).toBe('1,234.5');
        expect(formatSize(0.00000001)).toBe('0.00000001');
        expect(formatSize(Number.NaN)).toBe('—');
    });

    it('stamps times in UTC, to the minute', () => {
        const t = Date.parse('2026-09-04T08:47:31Z');
        expect(formatWhen(t)).toBe('2026-09-04 08:47');
        expect(formatDay(t)).toBe('2026-09-04');
        expect(formatWhen(Number.NaN)).toBe('—');
    });
});

describe('run library — R multiples', () => {
    const trade = (netPnl: number, size: number, riskPerUnit: number | null) => ({ netPnl, size, riskPerUnit });

    it('measures the result against what the trade risked when it opened', () => {
        // Risked 2 a unit over 3 units = 6; made 12.
        expect(rMultiple(trade(12, 3, 2))).toBe(2);
        expect(rMultiple(trade(-6, 3, 2))).toBe(-1);
    });

    it('answers null for a trade that carried no stop — that is not a risk of zero', () => {
        expect(rMultiple(trade(50, 1, null))).toBeNull();
        expect(rMultiple(trade(50, 1, 0))).toBeNull();
        expect(rMultiple(trade(50, 0, 2))).toBeNull();
        expect(formatR(null)).toBe('—');
    });

    it('always shows the direction of an R', () => {
        expect(formatR(2)).toBe('+2.00R');
        expect(formatR(-1.5)).toBe(`${MINUS}1.50R`);
    });
});

describe('run library — the balance curve', () => {
    const pts = (rows: Array<[time: number, balance: number]>) => rows.map(([time, balance]) => ({ time, balance }));

    it('lays the curve out by time, so a quiet week looks like a quiet week', () => {
        // Two points an hour apart, then one nine hours later: the last leg is the long one.
        const line = equityPath(pts([[0, 100], [3_600_000, 110], [36_000_000, 90]]), 100, 40);
        expect(line.d).toBe('M0 20 L10 0 L100 40');
        expect(line).toMatchObject({ min: 90, max: 110, baselineY: null });
    });

    it('keeps the starting balance inside the window so a losing run reads as one', () => {
        // Every point is below the baseline: without folding it in, the curve would rise.
        const line = equityPath(pts([[0, 90], [10, 80]]), 100, 40, 100);
        expect(line).toMatchObject({ min: 80, max: 100 });
        expect(line.baselineY).toBe(0); // the baseline is the top of the window
        expect(line.d).toBe('M0 20 L100 40');
    });

    it('draws a flat account through the middle rather than dividing by zero', () => {
        const line = equityPath(pts([[0, 100], [10, 100]]), 100, 40);
        expect(line.d).toBe('M0 20 L100 20');
    });

    it('has nothing to draw for an empty curve or an empty box', () => {
        expect(equityPath([], 100, 40)).toEqual({ d: '', min: 0, max: 0, baselineY: null });
        expect(equityPath(pts([[0, 1]]), 0, 40).d).toBe('');
    });

    it('puts a single point in the middle of the box, not against its edge', () => {
        expect(equityPath(pts([[5, 100]]), 100, 40).d).toBe('M50 20');
    });
});
