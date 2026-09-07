import { describe, it, expect } from 'vitest';
import { detectSilverBullet } from '../src/core/analysis/silverBullet';
import {
    SILVER_BULLET_INDICATOR_TYPE,
    buildSilverBulletOutput,
    registerSilverBullet,
    silverBulletDescriptor,
} from '../src/core/native-indicators/silverbullet';
import { getNativeIndicator } from '../src/core/native-indicators';
import type { OHLCV } from '../src/core/model/ohlcv';
import type { DrawingBox, DrawingLine } from '../src/core/model/drawings';

const STEP = 5 * 60_000;

/** The chain from the detector test: sweep at bar 5, gap and structure shift at bar 8 (10:00
 *  New York), the retest at bar 10 and the target at bar 12. */
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

function bars(rows = CHAIN): OHLCV[] {
    const start = Date.parse('2024-03-05T15:00:00Z') - 8 * STEP;
    return rows.map(([open, high, low, close], i) => ({
        time: start + i * STEP, open, high, low, close, volume: 1,
    }));
}

const VIEW = { bullColor: '#00ff00', bearColor: '#ff0000', profitColor: '#0ecb81', lossColor: '#f6465d' };

function output(rows = CHAIN, opts = {}): { boxes: DrawingBox[]; lines: DrawingLine[] } {
    const series = bars(rows);
    const setups = detectSilverBullet(series, { show: 'all', ...opts });
    const out = buildSilverBulletOutput(setups, series.map((b) => b.time), VIEW);
    return { boxes: out.boxes ?? [], lines: out.lines ?? [] };
}

describe('silver bullet indicator', () => {
    it('draws the run-up and the block for a setup that filled', () => {
        const series = bars();
        const setup = detectSilverBullet(series)[0]!;
        const { boxes, lines } = output();

        const gap = boxes.find((b) => b.id.endsWith('_gap'))!;
        expect(gap.left).toBe(series[setup.gapStartIndex]!.time);
        // The gap stops where the trade began — past the fill it is a trade, not a level.
        expect(gap.right).toBe(setup.fillTime);
        expect(gap.top).toBe(105);
        expect(gap.bottom).toBe(104);

        const risk = boxes.find((b) => b.id.endsWith('_risk'))!;
        const reward = boxes.find((b) => b.id.endsWith('_reward'))!;
        expect(risk.left).toBe(setup.fillTime);
        expect(risk.right).toBe(setup.outcomeTime);
        expect([risk.top, risk.bottom]).toEqual([111, 104]); // entry to stop
        expect([reward.top, reward.bottom]).toEqual([104, 90]); // entry to target
        // Colour means outcome, not direction: the stop side is the loss colour either way.
        expect(risk.bgColor).toContain('246,70,93');
        expect(reward.bgColor).toContain('14,203,129');
        expect(reward.text).toBe('NY AM · 2R');

        const ids = lines.map((l) => l.id.replace(/^sb_bear_\d+_/, ''));
        expect(ids.sort()).toEqual(['entry', 'sweep', 'stop', 'target'].sort());
        expect(lines.find((l) => l.id.endsWith('_sweep'))!.y1).toBe(111);
        expect(lines.find((l) => l.id.endsWith('_entry'))!.style).toBe('dashed');
    });

    it('draws an unfilled setup as the level the order waited at, and no block', () => {
        const rows = CHAIN.map((r) => [...r] as typeof CHAIN[number]);
        rows[10] = [100.5, 101, 100, 100.5];

        const { boxes, lines } = output(rows, { maxGapToEntry: 3 });

        expect(boxes.map((b) => b.id.replace(/^sb_bear_\d+_/, ''))).toEqual(['gap']);
        const resting = lines.find((l) => l.id.endsWith('_resting'))!;
        expect(resting.y1).toBe(104);
        expect(resting.style).toBe('dashed');
        // It ran to the bar the order came off on, not to the right edge.
        const series = bars(rows);
        expect(resting.x2).toBe(series[11]!.time);
    });

    it('runs a trade that has not resolved to the right edge', () => {
        // The chain stops one bar after the fill, before either level is reached.
        const rows = CHAIN.slice(0, 11);
        const { boxes } = output(rows);

        const reward = boxes.find((b) => b.id.endsWith('_reward'))!;
        expect(reward.extend).toBe('right');
    });

    it('fades a setup that is over and keeps a winner bright', () => {
        const won = output().boxes.find((b) => b.id.endsWith('_gap'))!;

        const rows = CHAIN.map((r) => [...r] as typeof CHAIN[number]);
        rows[11] = [103, 111, 95, 96]; // the same bar now reaches the stop first
        const lost = output(rows).boxes.find((b) => b.id.endsWith('_gap'))!;

        const alpha = (color: string): number => Number(/,([\d.]+)\)$/.exec(color)![1]);
        expect(alpha(lost.bgColor!)).toBeLessThan(alpha(won.bgColor!));
    });

    it('has nothing to draw without bars', () => {
        expect(buildSilverBulletOutput([], [], VIEW)).toEqual({ boxes: [], lines: [] });
    });

    it('registers itself as an overlay that stays out of the pane scale', () => {
        registerSilverBullet();
        expect(getNativeIndicator(SILVER_BULLET_INDICATOR_TYPE)).toBe(silverBulletDescriptor);

        expect(silverBulletDescriptor.overlay).toBe(true);
        expect(silverBulletDescriptor.paneHint).toBe('price');
        // A target can sit far from the candles; folding it into the scale would zoom out.
        expect(silverBulletDescriptor.autoscaleDrawings).toBe(false);
        expect(silverBulletDescriptor.multiInstance).toBe(true);
    });

    it('gives every input it declares a default', () => {
        const defaults = silverBulletDescriptor.defaultInputs();
        for (const input of silverBulletDescriptor.inputsSchema()) {
            expect(defaults[input.key], input.key).toBe(input.defval);
        }
    });
});
