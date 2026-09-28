import { describe, expect, it } from 'vitest';

import {
    TRADE_REVIEW_PADDING_BARS,
    TRADES_PER_PAGE,
    adjacentTradeIndex,
    tradePageBounds,
    tradePageFor,
    tradeReviewOutput,
    tradeReviewRange,
} from '../app/renderer/backtest/tradeReview';
import type { MidoriTrade } from '../app/renderer/midori';

const MINUTE = 60_000;

function trade(overrides: Partial<MidoriTrade> = {}): MidoriTrade {
    return {
        side: 'long',
        size: 2,
        entryPrice: 100,
        exitPrice: 106,
        openedAt: 10 * MINUTE,
        closedAt: 14 * MINUTE,
        pnl: 12,
        fees: 2,
        netPnl: 10,
        entryTag: 'breakout',
        exitTag: 'take-profit',
        stopLoss: 97,
        takeProfit: 106,
        riskPerUnit: 3,
        ...overrides,
    };
}

describe('backtest trade review', () => {
    it('frames entry through exit with eight bars of context on both sides', () => {
        expect(tradeReviewRange(trade(), MINUTE)).toEqual({
            from: (10 - TRADE_REVIEW_PADDING_BARS) * MINUTE,
            to: (14 + TRADE_REVIEW_PADDING_BARS) * MINUTE,
        });
    });

    it('clamps previous and next navigation at the ends', () => {
        expect(adjacentTradeIndex(0, 3, -1)).toBe(0);
        expect(adjacentTradeIndex(0, 3, 1)).toBe(1);
        expect(adjacentTradeIndex(2, 3, 1)).toBe(2);
    });

    it('keeps at most 100 trades on a page and moves the boundary trade to page two', () => {
        expect(TRADES_PER_PAGE).toBe(100);
        expect(tradePageBounds(0, 100)).toEqual({ page: 0, pageCount: 1, from: 0, to: 100 });
        expect(tradePageBounds(0, 116)).toEqual({ page: 0, pageCount: 2, from: 0, to: 100 });
        expect(tradePageBounds(1, 116)).toEqual({ page: 1, pageCount: 2, from: 100, to: 116 });
        expect(tradePageFor(99, 116)).toBe(0);
        expect(tradePageFor(100, 116)).toBe(1);
    });

    it('clamps requested trade pages at both ends', () => {
        expect(tradePageBounds(-1, 116).page).toBe(0);
        expect(tradePageBounds(8, 116).page).toBe(1);
        expect(tradePageBounds(0, 0)).toEqual({ page: 0, pageCount: 0, from: 0, to: 0 });
    });

    it('paints the selected round trip as the position tool risk and reward block', () => {
        const output = tradeReviewOutput(trade());

        expect(output.boxes).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'trade-risk', left: 10 * MINUTE, right: 14 * MINUTE,
                top: 100, bottom: 97, borderWidth: 0,
                bgColor: 'rgba(242,54,69,0)', bgColorTo: 'rgba(242,54,69,0.15)',
            }),
            expect.objectContaining({
                id: 'trade-reward', left: 10 * MINUTE, right: 14 * MINUTE,
                top: 106, bottom: 100, borderWidth: 0,
                bgColor: 'rgba(8,153,129,0.15)', bgColorTo: 'rgba(8,153,129,0)',
            }),
        ]));
        expect(output.lines).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'trade-entry', y1: 100, y2: 100, color: '#b2b5be', style: 'dashed' }),
            expect.objectContaining({ id: 'trade-stop', y1: 97, y2: 97, color: '#f23645', style: 'solid' }),
            expect.objectContaining({ id: 'trade-target', y1: 106, y2: 106, color: '#089981', style: 'solid' }),
        ]));
        expect(output.lines?.some((line) => line.id === 'trade-path')).toBe(false);
        expect(output.labels).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'trade-entry-label', text: 'Long entry · 100' }),
            expect.objectContaining({ id: 'trade-exit-label', text: 'Exit · 106 · +10.00' }),
        ]));
    });

    it('uses the realised result as a visible zone when an older run has no brackets', () => {
        const output = tradeReviewOutput(trade({ stopLoss: null, takeProfit: null }));

        expect(output.boxes).toEqual([
            expect.objectContaining({ id: 'trade-reward', top: 106, bottom: 100 }),
        ]);
        expect(output.lines).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'trade-target', y1: 106, y2: 106 }),
        ]));
    });

    it('follows customised position-tool colours, strokes, and zone fills', () => {
        const output = tradeReviewOutput(trade(), {
            extendRight: true,
            entryColor: '#aaaaaa',
            stopColor: '#bb0000',
            targetColor: '#00cc88',
            levelStyle: 'dotted',
            entryStyle: 'solid',
            lineWidth: 3,
            zones: true,
            zoneOpacity: 0.3,
            zoneGradient: false,
            executions: true,
        });

        expect(output.boxes).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'trade-risk', bgColor: 'rgba(187,0,0,0.3)', extend: 'none' }),
            expect.objectContaining({ id: 'trade-reward', bgColor: 'rgba(0,204,136,0.3)', extend: 'none' }),
        ]));
        expect(output.boxes?.every((box) => box.bgColorTo == null)).toBe(true);
        expect(output.lines).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'trade-entry', color: '#aaaaaa', style: 'solid', width: 3 }),
            expect.objectContaining({ id: 'trade-stop', color: '#bb0000', style: 'dotted', width: 3 }),
            expect.objectContaining({ id: 'trade-target', color: '#00cc88', style: 'dotted', width: 3 }),
        ]));
    });

    it('uses short-side entry and exit marker directions', () => {
        const output = tradeReviewOutput(trade({ side: 'short', entryPrice: 106, exitPrice: 100, netPnl: 10 }));

        expect(output.labels).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'trade-entry-label', style: 'label_down' }),
            expect.objectContaining({ id: 'trade-exit-label', style: 'label_up' }),
        ]));
    });
});
