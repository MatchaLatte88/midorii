import {
    registerNativeIndicator,
    type DrawingBox,
    type DrawingLabel,
    type DrawingLine,
    type NativeIndicator,
    type NativeIndicatorContext,
    type NativeIndicatorOutput,
} from '../../../src';
import { BEARISH, BULLISH } from '../../../src/core/palette';
import type { MidoriTrade } from '../midori';
import { formatPrice, formatSignedMoney } from '../format';
import {
    DEFAULT_POSITION_STYLE,
    loadPositionStyle,
    onPositionStyleChange,
    type PositionStyle,
} from '../trading/positionStyle';
import { positionLevelLine, positionZone } from '../trading/positionVisual';

/** The private native indicator used by the result chart. */
export const BACKTEST_TRADE_REVIEW_TYPE = 'backtest-trade-review';
export const TRADE_INPUT = 'tradeJson';

/** Eight candles of context on either side keeps a one-bar trade legible without
 *  making a longer hold feel artificially compressed. */
export const TRADE_REVIEW_PADDING_BARS = 8;
export const TRADES_PER_PAGE = 100;

export interface TradeReviewRange {
    from: number;
    to: number;
}

/** The time window the chart should frame for one trade. */
export function tradeReviewRange(trade: MidoriTrade, stepMs: number): TradeReviewRange {
    const step = Number.isFinite(stepMs) && stepMs > 0 ? stepMs : 60_000;
    const openedAt = Math.min(trade.openedAt, trade.closedAt);
    const closedAt = Math.max(trade.openedAt, trade.closedAt);
    const padding = step * TRADE_REVIEW_PADDING_BARS;
    return { from: openedAt - padding, to: closedAt + padding };
}

function label(
    id: string,
    time: number,
    price: number,
    text: string,
    style: DrawingLabel['style'],
    color: string,
    tooltip: string,
): DrawingLabel {
    return {
        id,
        paneId: 'price',
        xloc: 'bar_time',
        overlay: true,
        x: time,
        y: price,
        yloc: 'price',
        text,
        style,
        color,
        textColor: '#ffffff',
        size: 'small',
        textAlign: 'center',
        tooltip,
        fontFamily: 'default',
        bold: true,
        noFill: false,
    };
}

/** Renderer-neutral geometry for the selected round trip. A closed trade uses the same
 *  risk/reward zones and levels as the position tool, but stops at its actual exit time. */
export function tradeReviewOutput(
    trade: MidoriTrade,
    style: PositionStyle = DEFAULT_POSITION_STYLE,
): NativeIndicatorOutput {
    const profitable = trade.netPnl >= 0;
    const resultColor = profitable ? BULLISH : BEARISH;
    const entryColor = trade.side === 'long' ? BULLISH : BEARISH;
    const entryStyle: DrawingLabel['style'] = trade.side === 'long' ? 'label_up' : 'label_down';
    const exitStyle: DrawingLabel['style'] = trade.side === 'long' ? 'label_down' : 'label_up';
    /* Older saved runs can lack planned brackets. Their realised exit still supplies the one
     * side of the position block that actually happened, so every closed trade remains visible. */
    const riskLevel = trade.stopLoss ?? (profitable ? null : trade.exitPrice);
    const rewardLevel = trade.takeProfit ?? (profitable ? trade.exitPrice : null);

    const boxes: DrawingBox[] = [];
    if (style.zones && riskLevel != null && riskLevel !== trade.entryPrice) {
        boxes.push(positionZone(
            'trade-risk', trade.openedAt, trade.closedAt, trade.entryPrice,
            riskLevel, style.stopColor, style, 'none',
        ));
    }
    if (style.zones && rewardLevel != null && rewardLevel !== trade.entryPrice) {
        boxes.push(positionZone(
            'trade-reward', trade.openedAt, trade.closedAt, trade.entryPrice,
            rewardLevel, style.targetColor, style, 'none',
        ));
    }

    const lines: DrawingLine[] = [
        positionLevelLine(
            'trade-entry', trade.openedAt, trade.closedAt, trade.entryPrice,
            style.entryColor, style.entryStyle, 'none', style.lineWidth,
        ),
    ];

    if (riskLevel != null) {
        lines.push(positionLevelLine(
            'trade-stop', trade.openedAt, trade.closedAt, riskLevel,
            style.stopColor, style.levelStyle, 'none', style.lineWidth,
        ));
    }
    if (rewardLevel != null) {
        lines.push(positionLevelLine(
            'trade-target', trade.openedAt, trade.closedAt, rewardLevel,
            style.targetColor, style.levelStyle, 'none', style.lineWidth,
        ));
    }

    const side = trade.side === 'long' ? 'Long' : 'Short';
    const labels: DrawingLabel[] = [
        label(
            'trade-entry-label',
            trade.openedAt,
            trade.entryPrice,
            `${side} entry · ${formatPrice(trade.entryPrice)}`,
            entryStyle,
            entryColor,
            `${side} entry at ${formatPrice(trade.entryPrice)}`,
        ),
        label(
            'trade-exit-label',
            trade.closedAt,
            trade.exitPrice,
            `Exit · ${formatPrice(trade.exitPrice)} · ${formatSignedMoney(trade.netPnl)}`,
            exitStyle,
            resultColor,
            `${side} exit at ${formatPrice(trade.exitPrice)}; net ${formatSignedMoney(trade.netPnl)}`,
        ),
    ];

    return { boxes, lines, labels };
}

class BacktestTradeReviewIndicator implements NativeIndicator {
    private ctx: NativeIndicatorContext | null = null;
    private trade: MidoriTrade | null = null;
    private style: PositionStyle = DEFAULT_POSITION_STYLE;
    private unsubscribeStyle: (() => void) | null = null;

    start(ctx: NativeIndicatorContext, inputs: Record<string, unknown>): void {
        this.ctx = ctx;
        this.style = loadPositionStyle();
        this.unsubscribeStyle?.();
        this.unsubscribeStyle = onPositionStyleChange((style) => {
            this.style = style;
            this.emit();
        });
        this.apply(inputs);
        this.emit();
    }

    onBars(): void {
        this.emit();
    }

    onViewport(): void {
        /* The selected trade is independent of the viewport. */
    }

    setInputs(inputs: Record<string, unknown>): void {
        this.apply(inputs);
        this.emit();
    }

    suspend(): void {
        /* Style changes stay subscribed so a hidden chart resumes with the latest look. */
    }

    resume(): void {
        this.emit();
    }

    stop(): void {
        this.unsubscribeStyle?.();
        this.unsubscribeStyle = null;
        this.ctx = null;
    }

    private apply(inputs: Record<string, unknown>): void {
        const raw = inputs[TRADE_INPUT];
        if (typeof raw !== 'string' || raw.length === 0) return;
        try {
            this.trade = JSON.parse(raw) as MidoriTrade;
        } catch {
            this.trade = null;
        }
    }

    private emit(): void {
        if (!this.ctx) return;
        this.ctx.emit(this.trade ? tradeReviewOutput(this.trade, this.style) : {
            boxes: [],
            lines: [],
            labels: [],
        });
    }
}

let registered = false;

/** Register once per renderer process. The type is internal because the review panel,
 *  not the chart's indicator picker, owns its selected-trade state. */
export function registerBacktestTradeReview(): void {
    if (registered) return;
    registered = true;
    registerNativeIndicator({
        type: BACKTEST_TRADE_REVIEW_TYPE,
        title: 'Backtest trade',
        internal: true,
        paneHint: 'price',
        overlay: true,
        multiInstance: false,
        inputsSchema: () => [],
        defaultInputs: () => ({ [TRADE_INPUT]: '' }),
        create: () => new BacktestTradeReviewIndicator(),
    });
}

/** A clamped move for the two navigation buttons. */
export function adjacentTradeIndex(current: number, total: number, delta: -1 | 1): number {
    if (total <= 0) return 0;
    return Math.max(0, Math.min(total - 1, current + delta));
}

function pageSize(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : TRADES_PER_PAGE;
}

/** The page that owns a selected trade. */
export function tradePageFor(index: number, total: number, size = TRADES_PER_PAGE): number {
    const count = Math.max(0, Math.floor(total));
    if (count === 0) return 0;
    const selected = Math.max(0, Math.min(count - 1, Math.floor(index)));
    return Math.floor(selected / pageSize(size));
}

export interface TradePageBounds {
    page: number;
    pageCount: number;
    from: number;
    to: number;
}

/** The half-open trade range for one clamped page. */
export function tradePageBounds(page: number, total: number, size = TRADES_PER_PAGE): TradePageBounds {
    const count = Math.max(0, Math.floor(total));
    if (count === 0) return { page: 0, pageCount: 0, from: 0, to: 0 };

    const perPage = pageSize(size);
    const pageCount = Math.ceil(count / perPage);
    const current = Math.max(0, Math.min(pageCount - 1, Math.floor(page)));
    const from = current * perPage;
    return { page: current, pageCount, from, to: Math.min(count, from + perPage) };
}
