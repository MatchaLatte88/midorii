// How an open position is drawn: the stored style, and the geometry it turns into.
//
// The style is the only part of a position that is a matter of taste, which is exactly why it
// needs holding to: a zone shaded the wrong way round, or a colour that silently reverted to
// the default, is not something anyone reads off a chart as a bug.
import { describe, it, expect } from 'vitest';
import { buildReplayOutput, readOrderLineId, type ReplayVisualState } from '../app/renderer/replay/replayIndicator';
import { DEFAULT_POSITION_STYLE, normalizeStyle, withAlpha, type PositionStyle } from '../app/renderer/trading/positionStyle';

const NOW = 5_000;

/** A long at 100, stopped at 90, targeting 120 — opened one bar ago. */
function longState(): ReplayVisualState {
    return {
        positions: [{
            id: 1, side: 'buy', entryPrice: 100, entryTime: 1_000,
            stopPrice: 90, targetPrice: 120, size: 1,
            openPnl: 5, stopPnl: -10, targetPnl: 20,
            openR: 0.5, stopR: -1, targetR: 2,
        }],
        orders: [],
    };
}

/** The same trade the other way up: a short at 100, stopped at 110, targeting 80. */
function shortState(): ReplayVisualState {
    const s = longState();
    s.positions[0] = { ...s.positions[0]!, side: 'sell', stopPrice: 110, targetPrice: 80 };
    return s;
}

const styled = (over: Partial<PositionStyle>): PositionStyle => ({ ...DEFAULT_POSITION_STYLE, ...over });
const boxOf = (out: { boxes?: unknown[] }, id: string) => (out.boxes as Array<{ id: string }>).find((b) => b.id === id) as
    | { id: string; extend: string; bgColor?: string; bgColorTo?: string; top: number; bottom: number }
    | undefined;

describe('a colour at an alpha', () => {
    it('reads the forms a picker and a stored record produce', () => {
        expect(withAlpha('#f23645', 0.15)).toBe('rgba(242,54,69,0.15)');
        expect(withAlpha('#fff', 0.5)).toBe('rgba(255,255,255,0.5)');
        expect(withAlpha('rgb(8, 153, 129)', 0.2)).toBe('rgba(8,153,129,0.2)');
        expect(withAlpha('rgba(8,153,129,0.9)', 0)).toBe('rgba(8,153,129,0)');
    });

    it('leaves a colour it cannot read alone', () => {
        // Returned untouched rather than replaced: a wrong colour that LOOKS wrong is findable,
        // one that quietly became the default is not.
        expect(withAlpha('tomato', 0.3)).toBe('tomato');
    });
});

describe('a stored style', () => {
    it('fills in what an older or half-written record is missing', () => {
        expect(normalizeStyle({ stopColor: '#ff0000' })).toEqual({ ...DEFAULT_POSITION_STYLE, stopColor: '#ff0000' });
        expect(normalizeStyle(null)).toEqual(DEFAULT_POSITION_STYLE);
    });

    it('refuses values that would paint over the chart', () => {
        const s = normalizeStyle({ lineWidth: 400, zoneOpacity: 9, levelStyle: 'wavy', entryColor: '' });
        expect(s.lineWidth).toBe(DEFAULT_POSITION_STYLE.lineWidth);
        expect(s.zoneOpacity).toBe(DEFAULT_POSITION_STYLE.zoneOpacity);
        expect(s.levelStyle).toBe(DEFAULT_POSITION_STYLE.levelStyle);
        expect(s.entryColor).toBe(DEFAULT_POSITION_STYLE.entryColor);
    });
});

describe('the position as chart geometry', () => {
    it('shades each zone strongest at its level and clear at the entry', () => {
        // The whole point of the fade: the colour says how far this is from where the trade is
        // wrong (or done), so the solid end must be the LEVEL — whichever side of the entry
        // that lands on.
        const out = buildReplayOutput(longState(), NOW, styled({ zoneGradient: true, zoneOpacity: 0.2 }));
        const risk = boxOf(out, 'pos_1_risk')!; // entry 100 on top, stop 90 below
        expect(risk.bgColor).toBe('rgba(242,54,69,0)'); // top = entry → clear
        expect(risk.bgColorTo).toBe('rgba(242,54,69,0.2)'); // bottom = stop → solid
        const reward = boxOf(out, 'pos_1_reward')!; // target 120 on top, entry 100 below
        expect(reward.bgColor).toBe('rgba(8,153,129,0.2)');
        expect(reward.bgColorTo).toBe('rgba(8,153,129,0)');
    });

    it('turns the shading over for a short, without being told which way is which', () => {
        const out = buildReplayOutput(shortState(), NOW, styled({ zoneGradient: true, zoneOpacity: 0.2 }));
        const risk = boxOf(out, 'pos_1_risk')!; // stop 110 on top now
        expect(risk.bgColor).toBe('rgba(242,54,69,0.2)');
        expect(risk.bgColorTo).toBe('rgba(242,54,69,0)');
    });

    it('fills evenly, with no second colour at all, when the fade is off', () => {
        const out = buildReplayOutput(longState(), NOW, styled({ zoneGradient: false, zoneOpacity: 0.15 }));
        const risk = boxOf(out, 'pos_1_risk')!;
        expect(risk.bgColor).toBe('rgba(242,54,69,0.15)');
        expect(risk.bgColorTo).toBeUndefined();
    });

    it('runs the zones and the entry line to the right edge, or stops them at the last bar', () => {
        const far = buildReplayOutput(longState(), NOW, styled({ extendRight: true }));
        expect(boxOf(far, 'pos_1_risk')!.extend).toBe('right');
        expect((far.lines as Array<{ id: string; extend: string }>).find((l) => l.id === 'pos_1_entry')!.extend).toBe('right');

        const near = buildReplayOutput(longState(), NOW, styled({ extendRight: false }));
        expect(boxOf(near, 'pos_1_risk')!.extend).toBe('none');
        expect((near.lines as Array<{ id: string; extend: string }>).find((l) => l.id === 'pos_1_entry')!.extend).toBe('none');
    });

    it('draws no zones at all when they are switched off, and keeps every level', () => {
        // Switching the areas off must not take the stop with them: the line is the level, the
        // area is only a way of looking at it.
        const out = buildReplayOutput(longState(), NOW, styled({ zones: false }));
        expect(out.boxes).toEqual([]);
        const ids = (out.priceLines as Array<{ id: string }>).map((l) => l.id);
        expect(ids).toContain('pos_1_sl');
        expect(ids).toContain('pos_1_tp');
    });

    it('strokes the levels the way the style says', () => {
        const out = buildReplayOutput(longState(), NOW, styled({ levelStyle: 'dotted', lineWidth: 3, stopColor: '#abcdef' }));
        const sl = (out.priceLines as Array<{ id: string; lineStyle?: string; width?: number; color?: string }>).find((l) => l.id === 'pos_1_sl')!;
        expect(sl.lineStyle).toBe('dotted');
        expect(sl.width).toBe(3);
        expect(sl.color).toBe('#abcdef');
    });
});

describe('the mark an execution leaves', () => {
    /** Two fills on one trade: bought at 100 mid-bar, sold at 118 two bars later. */
    const traded = (): ReplayVisualState => ({
        positions: [],
        orders: [],
        fills: [
            { id: 7, time: 1_500, price: 100, side: 'buy' },
            { id: 9, time: 3_000, price: 118, side: 'sell' },
        ],
    });

    const labelsOf = (out: { labels?: unknown[] }) => (out.labels ?? []) as Array<{
        id: string; x: number; y: number; xloc: string; yloc: string; style: string; color?: string; size: string;
    }>;

    it('stands each mark on the time and the price the order filled at', () => {
        // The two readings the mark exists for. `bar_time` rather than a bar index because a
        // fill has a moment, not a bar: a mid-bar fill must land mid-bar.
        const marks = labelsOf(buildReplayOutput(traded(), NOW, styled({})));
        expect(marks.map((m) => m.id)).toEqual(['fill_7', 'fill_9']);
        expect(marks[0]).toMatchObject({ x: 1_500, y: 100, xloc: 'bar_time', yloc: 'price', style: 'cross' });
        expect(marks[1]).toMatchObject({ x: 3_000, y: 118 });
    });

    it('colours a mark by the side that filled, not by how the trade went', () => {
        const marks = labelsOf(buildReplayOutput(traded(), NOW, styled({ stopColor: '#111111', targetColor: '#222222' })));
        expect(marks[0]!.color).toBe('#089981'); // bought
        expect(marks[1]!.color).toBe('#f23645'); // sold
    });

    it('draws nothing when the marks are switched off', () => {
        expect(labelsOf(buildReplayOutput(traded(), NOW, styled({ executions: false })))).toEqual([]);
    });

    it('keeps the marks of trades that are long closed', () => {
        // The state carries no position at all here — the account is flat. A record that
        // emptied itself as trades closed would be blank exactly when it is read back.
        const out = buildReplayOutput(traded(), NOW, styled({}));
        expect(out.boxes).toEqual([]);
        expect(labelsOf(out)).toHaveLength(2);
    });
});

/**
 * A resting order's own line.
 *
 * The one assertion that matters is the negative one: a line is only draggable where the
 * account behind it can actually move an order. A handle that can be grabbed and then springs
 * back has already taken the gesture by the time anything says otherwise.
 */
describe('the line a resting order draws', () => {
    const order = (over: Partial<ReplayVisualState['orders'][number]> = {}) => ({
        id: 7, side: 'buy' as const, price: 100, tag: 'limit', ...over,
    });
    const state = (over: Partial<ReplayVisualState> = {}): ReplayVisualState => ({
        positions: [], orders: [order()], ...over,
    });
    const lineFor = (over: Partial<ReplayVisualState> = {}) =>
        buildReplayOutput(state(over), 0).priceLines!.find((l) => l.id === 'ord_7_lvl')!;

    it('is drawn at the price the order waits at', () => {
        expect(lineFor().price).toBe(100);
    });

    it('cannot be dragged unless the account said it can move one', () => {
        // Bybit, Binance Spot and a replay have no `moveOrder` and send no flag.
        expect(lineFor().draggable).toBe(false);
        expect(lineFor({ ordersMovable: false }).draggable).toBe(false);
    });

    it('can be dragged where the account said so', () => {
        expect(lineFor({ ordersMovable: true }).draggable).toBe(true);
    });

    it('always carries the ✕, because every account here can cancel', () => {
        expect(lineFor().action).toBe('close');
        expect(lineFor({ ordersMovable: true }).action).toBe('close');
    });

    it('says which way it goes and how big, not just what kind it is', () => {
        // Three resting orders are told apart by their sizes; "limit" is true of all three.
        expect(lineFor({ orders: [order({ size: 3 })] }).title).toBe('limit  3');
    });

    it('falls back to the side where there is no tag and no size', () => {
        expect(lineFor({ orders: [order({ tag: null })] }).title).toBe('buy');
    });

    it('is addressed by an id the wiring can read back', () => {
        expect(readOrderLineId(lineFor().id)).toBe(7);
        // And a position's own levels are not mistaken for one.
        expect(readOrderLineId('pos_7_sl')).toBeNull();
    });
});
