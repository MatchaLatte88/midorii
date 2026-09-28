// The ticket drawn on the chart before it is sent: what it says each level would cost, how it
// warns about a size that loses more than the account's own risk setting, and that a level
// dragged on it goes back into the ticket rather than anywhere else.
import { describe, it, expect, vi } from 'vitest';
import { emptyTicket, riskExcess, ticketPlan, ticketPreview } from '../app/renderer/replay/orderTicket';
import type { TicketAccount, TicketDraft, TicketPreview } from '../app/renderer/replay/orderTicket';
import type { RiskSettings } from '../app/renderer/replay/replayOrders';
import {
    PREVIEW_ENTRY_ID, PREVIEW_INPUT, PREVIEW_STOP_ID, PREVIEW_TARGET_ID, buildPreviewOutput, readLineId, readPreviewLineId,
} from '../app/renderer/replay/replayIndicator';
import { wireTradePreview } from '../app/renderer/replay/chartPreview';
import type { TradeSidebar } from '../app/renderer/replay/tradeSidebar';
import { DEFAULT_POSITION_STYLE } from '../app/renderer/trading/positionStyle';
import type { PriceLine } from '../src';

/** 10,000 in the account, the market at 100. */
const ACCOUNT: TicketAccount = { equity: 10_000, price: 100 };
/** 1% of equity per trade. */
const RISK: RiskSettings = { mode: 'percent', value: 1, maxLeverage: 1 };
/** One NQ: twenty dollars a point, whole contracts. */
const FUTURES: TicketAccount = { equity: 50_000, price: 24_000, pointValue: 20, sizeStep: 1, minSize: 1 };

const ticket = (over: Partial<TicketDraft> = {}): TicketDraft => ({ ...emptyTicket(), ...over });

const previewOf = (draft: TicketDraft, side: 'buy' | 'sell' = 'buy', account = ACCOUNT, risk = RISK): TicketPreview | null =>
    ticketPreview(draft, side, account, ticketPlan(draft, account, risk), risk);

describe('what the preview says a ticket comes to', () => {
    it('draws a market order at the market, wherever the market is', () => {
        const draft = ticket({ fixedSize: 10 });
        expect(previewOf(draft)?.entryPrice).toBe(100);
        expect(previewOf(draft, 'buy', { ...ACCOUNT, price: 101.5 })?.entryPrice).toBe(101.5);
    });

    it('draws a resting order at its own price, whatever the market does', () => {
        const draft = ticket({ type: 'limit', entryPrice: 95, fixedSize: 10 });
        expect(previewOf(draft)?.entryPrice).toBe(95);
        expect(previewOf(draft, 'buy', { ...ACCOUNT, price: 120 })?.entryPrice).toBe(95);
    });

    it('draws nothing without a size, or a resting order without a price', () => {
        expect(previewOf(ticket())).toBeNull();
        expect(previewOf(ticket({ type: 'stop', fixedSize: 10 }))).toBeNull();
    });

    it('costs each level in the account money, through what a point is worth', () => {
        // Long 2 NQ: 10 points to the stop is $400 lost, 20 points to the target is $800 made.
        const long = previewOf(ticket({ fixedSize: 2, stopLoss: 23_990, takeProfit: 24_020 }), 'buy', FUTURES)!;
        expect(long.stopPnl).toBe(-400);
        expect(long.targetPnl).toBe(800);
        expect(long.stopShare).toBeCloseTo(0.008);
        expect(long.rr).toBe(2);

        // The same distances the other way round lose and make the same, with the levels swapped.
        const short = previewOf(ticket({ fixedSize: 2, stopLoss: 24_010, takeProfit: 23_980 }), 'sell', FUTURES)!;
        expect(short.stopPnl).toBe(-400);
        expect(short.targetPnl).toBe(800);
    });

    it('gives a trade with no stop no loss figure at all — not a loss of zero', () => {
        const preview = previewOf(ticket({ fixedSize: 10 }))!;
        expect(preview.stopPnl).toBeNull();
        expect(preview.stopShare).toBeNull();
        expect(preview.overRisk).toBeNull();
    });
});

describe('the warning against a size that loses too much', () => {
    it('names the percentage a typed size would lose more than', () => {
        // 30 units, 5 away: 150 of a 10,000 account is 1.5% against a 1% setting.
        expect(previewOf(ticket({ fixedSize: 30, stopLoss: 95 }))?.overRisk).toBe('1%');
    });

    it('stays quiet at or under the setting', () => {
        expect(previewOf(ticket({ fixedSize: 20, stopLoss: 95 }))?.overRisk).toBeNull(); // exactly 1%
        expect(previewOf(ticket({ fixedSize: 10, stopLoss: 95 }))?.overRisk).toBeNull();
    });

    it('never fires on a size worked out from the risk itself', () => {
        const draft = ticket({ sizing: 'risk', stopLoss: 97 });
        expect(previewOf(draft, 'buy', ACCOUNT, { ...RISK, maxLeverage: 100 })?.overRisk).toBeNull();
    });

    it('does not call a stop on the winning side a risk, however far away it is', () => {
        // A long stopped ABOVE its limit entry: the ticket refuses it, and the preview must not
        // present the distance as a loss that is over the setting.
        const draft = ticket({ type: 'limit', entryPrice: 95, fixedSize: 30, stopLoss: 100 });
        const preview = previewOf(draft, 'buy', { ...ACCOUNT, price: 101 })!;
        expect(preview.stopPnl).toBe(150);
        expect(preview.stopShare).toBeNull();
        expect(preview.overRisk).toBeNull();
    });

    it('names a cash setting as cash', () => {
        const cash: RiskSettings = { mode: 'fixed', value: 500, maxLeverage: 1 };
        const draft = ticket({ fixedSize: 2, stopLoss: 23_985 }); // 15 points × $20 × 2 = $600
        expect(riskExcess(ticketPlan(draft, FUTURES, cash), FUTURES, cash)).toBe('500.00');
    });
});

const NOW = 5_000;
const LONG: TicketPreview = {
    side: 'buy', type: 'market', entryPrice: 100, size: 20,
    stopPrice: 95, targetPrice: 110, stopPnl: -100, targetPnl: 200, stopShare: 0.01, rr: 2, overRisk: null,
};
const lineOf = (out: { priceLines?: PriceLine[] }, id: string): PriceLine | undefined => out.priceLines?.find((l) => l.id === id);

describe('the preview on the chart', () => {
    it('draws nothing when there is no preview', () => {
        const out = buildPreviewOutput(null, NOW);
        expect(out.priceLines).toEqual([]);
        expect(out.boxes).toEqual([]);
    });

    it('puts the loss on the stop tag and the gain on the target tag', () => {
        const out = buildPreviewOutput(LONG, NOW, DEFAULT_POSITION_STYLE, 'USD');
        expect(lineOf(out, PREVIEW_STOP_ID)?.title).toBe('SL  −$100.00  1.00% of equity');
        expect(lineOf(out, PREVIEW_TARGET_ID)?.title).toBe('TP  +$200.00  +2.00R');
        expect(lineOf(out, PREVIEW_ENTRY_ID)?.title).toBe('Preview  Buy 20  Market');
    });

    it('lets the stop and the target be dragged, and a market entry pull a level out', () => {
        const out = buildPreviewOutput(LONG, NOW);
        expect(lineOf(out, PREVIEW_STOP_ID)?.draggable).toBe(true);
        expect(lineOf(out, PREVIEW_TARGET_ID)?.draggable).toBe(true);
        const entry = lineOf(out, PREVIEW_ENTRY_ID)!;
        expect(entry.dragSpawns).toBe(true);
        expect(entry.draggable).toBeUndefined();
        expect(entry.action).toBe('close');
    });

    it('lets a resting entry itself be moved', () => {
        const entry = lineOf(buildPreviewOutput({ ...LONG, type: 'limit', entryPrice: 98 }, NOW), PREVIEW_ENTRY_ID)!;
        expect(entry.draggable).toBe(true);
        expect(entry.dragSpawns).toBeUndefined();
        expect(entry.title).toBe('Preview  Buy 20  Limit');
    });

    it('turns the entry red and says so on the stop when the size loses too much', () => {
        const out = buildPreviewOutput({ ...LONG, overRisk: '1%' }, NOW);
        expect(lineOf(out, PREVIEW_STOP_ID)?.title).toContain('over 1% risk');
        expect(lineOf(out, PREVIEW_ENTRY_ID)?.titleColor).toBe(DEFAULT_POSITION_STYLE.stopColor);
        expect(lineOf(buildPreviewOutput(LONG, NOW), PREVIEW_ENTRY_ID)?.titleColor).toBe(DEFAULT_POSITION_STYLE.entryColor);
    });

    it('says on the entry itself when there is no stop, since there is no stop tag to say it', () => {
        const out = buildPreviewOutput({ ...LONG, stopPrice: null, stopPnl: null, stopShare: null }, NOW);
        expect(lineOf(out, PREVIEW_STOP_ID)).toBeUndefined();
        const entry = lineOf(out, PREVIEW_ENTRY_ID)!;
        expect(entry.title).toBe('Preview  Buy 20  Market  no stop');
        expect(entry.titleColor).toBe(DEFAULT_POSITION_STYLE.stopColor);
    });

    it('shades ahead of now only, even where positions are not run to the edge', () => {
        const out = buildPreviewOutput(LONG, NOW, { ...DEFAULT_POSITION_STYLE, extendRight: false });
        expect(out.boxes).toHaveLength(2);
        for (const box of out.boxes ?? []) {
            expect(box.left).toBe(NOW);
            expect(box.extend).toBe('right');
        }
        expect(buildPreviewOutput(LONG, NOW, { ...DEFAULT_POSITION_STYLE, zones: false }).boxes).toEqual([]);
    });

    it('addresses its lines so they are never read as a position\'s', () => {
        expect(readPreviewLineId(PREVIEW_ENTRY_ID)).toBe('entry');
        expect(readPreviewLineId(PREVIEW_STOP_ID)).toBe('stop');
        expect(readPreviewLineId(PREVIEW_TARGET_ID)).toBe('target');
        expect(readPreviewLineId('pos_1_sl')).toBeNull();
        expect(readLineId(PREVIEW_STOP_ID)).toBeNull();
    });
});

/** A chart that only relays the three price-line events, and lets a test fire them. */
function fakeChart() {
    const handlers = new Map<string, Set<(payload: unknown) => void>>();
    return {
        on(event: string, handler: (payload: unknown) => void) {
            const set = handlers.get(event) ?? new Set();
            set.add(handler);
            handlers.set(event, set);
            return () => set.delete(handler);
        },
        fire(event: string, payload: unknown) {
            for (const handler of handlers.get(event) ?? []) handler(payload);
        },
        count: () => [...handlers.values()].reduce((n, set) => n + set.size, 0),
    };
}

function mount(refusal: string | null = null) {
    const chart = fakeChart();
    const indicator = { setInput: vi.fn() };
    let listener: ((preview: TicketPreview | null) => void) | null = null;
    const sidebar = {
        onPreview: vi.fn((next: (preview: TicketPreview | null) => void) => {
            listener = next;
            next(null);
            return () => { listener = null; };
        }),
        dragLevel: vi.fn(() => refusal),
        dismissPreview: vi.fn(),
    };
    const notify = vi.fn();
    const off = wireTradePreview({
        chart: chart as never,
        indicator: indicator as never,
        sidebar: sidebar as unknown as TradeSidebar,
        notify,
    });
    const publish = (preview: TicketPreview | null) => listener?.(preview);
    return { chart, indicator, sidebar, notify, off, publish, listening: () => listener != null };
}

describe('the preview wired to the chart', () => {
    it('hands the indicator each preview once, and not again while it is unchanged', () => {
        const { indicator, publish } = mount();
        publish(LONG);
        publish({ ...LONG });
        publish({ ...LONG, entryPrice: 100.25 });
        expect(indicator.setInput.mock.calls).toEqual([
            [PREVIEW_INPUT, 'null'],
            [PREVIEW_INPUT, JSON.stringify(LONG)],
            [PREVIEW_INPUT, JSON.stringify({ ...LONG, entryPrice: 100.25 })],
        ]);
    });

    it('writes a dragged stop back into the ticket', () => {
        const { chart, sidebar, notify, publish } = mount();
        publish(LONG);
        chart.fire('priceline:moved', { id: PREVIEW_STOP_ID, price: 93.5 });
        expect(sidebar.dragLevel).toHaveBeenCalledWith('stop', 93.5);
        expect(notify).not.toHaveBeenCalled();
    });

    it('says why, when the ticket refuses the drop', () => {
        const { chart, notify, publish } = mount('A stop belongs on the losing side of the entry.');
        publish(LONG);
        chart.fire('priceline:moved', { id: PREVIEW_STOP_ID, price: 104 });
        expect(notify).toHaveBeenCalledWith('A stop belongs on the losing side of the entry.', 'error');
    });

    it('reads a level pulled off the entry by the side it landed on', () => {
        const { chart, sidebar, publish } = mount();
        publish({ ...LONG, stopPrice: null, targetPrice: null });
        chart.fire('priceline:spawned', { id: PREVIEW_ENTRY_ID, price: 97 });
        chart.fire('priceline:spawned', { id: PREVIEW_ENTRY_ID, price: 104 });
        expect(sidebar.dragLevel.mock.calls).toEqual([['stop', 97], ['target', 104]]);
    });

    it('puts the preview away on the entry\'s ✕', () => {
        const { chart, sidebar, publish } = mount();
        publish(LONG);
        chart.fire('priceline:action', { id: PREVIEW_ENTRY_ID, action: 'close' });
        expect(sidebar.dismissPreview).toHaveBeenCalledTimes(1);
    });

    it('leaves a position\'s own lines, and every drop while nothing is previewed, alone', () => {
        const { chart, sidebar, publish } = mount();
        publish(LONG);
        chart.fire('priceline:moved', { id: 'pos_1_sl', price: 90 });
        chart.fire('priceline:action', { id: 'pos_1_entry_lvl', action: 'close' });
        publish(null);
        chart.fire('priceline:moved', { id: PREVIEW_STOP_ID, price: 90 });
        expect(sidebar.dragLevel).not.toHaveBeenCalled();
        expect(sidebar.dismissPreview).not.toHaveBeenCalled();
    });

    it('takes the preview off the chart and stops listening when unwired', () => {
        const { chart, indicator, off, publish, listening } = mount();
        publish(LONG);
        off();
        expect(indicator.setInput).toHaveBeenLastCalledWith(PREVIEW_INPUT, 'null');
        expect(listening()).toBe(false);
        expect(chart.count()).toBe(0);
    });
});
