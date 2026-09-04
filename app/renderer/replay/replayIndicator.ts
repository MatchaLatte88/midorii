import { registerNativeIndicator } from '../../../src';
import type {
    DrawingBox, DrawingLine, NativeIndicator, NativeIndicatorContext,
    NativeIndicatorOutput, PriceLine,
} from '../../../src';

/** The native-indicator type id the replay chart mounts. */
export const REPLAY_INDICATOR_TYPE = 'replay-position';

/** The visual half of the replay state — what the chart needs, nothing else. */
export interface ReplayVisualState {
    positions: Array<{
        id: number;
        side: 'buy' | 'sell';
        entryPrice: number;
        entryTime: number;
        stopPrice: number | null;
        targetPrice: number | null;
    }>;
    orders: Array<{
        id: number;
        side: 'buy' | 'sell';
        price: number;
        tag: string | null;
    }>;
}

const EMPTY_STATE: ReplayVisualState = { positions: [], orders: [] };

const RISK_FILL = 'rgba(242,54,69,0.15)';
const REWARD_FILL = 'rgba(8,153,129,0.15)';
const STOP_COLOR = '#f23645';
const TARGET_COLOR = '#089981';
const ENTRY_COLOR = '#b2b5be';
const ORDER_COLOR = '#787b86';

/** Box defaults — the neutral model has no partials, so every field is spelled out. */
function box(id: string, left: number, right: number, a: number, b: number, bgColor: string): DrawingBox {
    return {
        id, paneId: 'price', xloc: 'bar_time', overlay: true,
        left, right, top: Math.max(a, b), bottom: Math.min(a, b),
        extend: 'none', bgColor, borderWidth: 0, borderStyle: 'solid',
        textSize: 'auto', hAlign: 'center', vAlign: 'center',
        wrap: false, fontFamily: 'default', bold: false, italic: false,
    };
}

function line(id: string, x1: number, x2: number, y: number, color: string, style: 'solid' | 'dashed', extend: 'none' | 'right'): DrawingLine {
    return {
        id, paneId: 'price', xloc: 'bar_time', overlay: true,
        x1, y1: y, x2, y2: y, extend, color,
        invisible: false, width: 1, style, arrowLeft: false, arrowRight: false,
    };
}

/**
 * Turns the replay account into chart geometry: an open position becomes a risk
 * zone (entry→stop) and a reward zone (entry→target) running from its entry bar
 * to the playhead, with the entry line across it and the levels labelled on the
 * price axis; a resting order becomes a dashed line into the future only.
 *
 * Exported so the shapes can be asserted without a chart.
 */
export function buildReplayOutput(state: ReplayVisualState, nowTime: number): NativeIndicatorOutput {
    const boxes: DrawingBox[] = [];
    const lines: DrawingLine[] = [];
    const priceLines: PriceLine[] = [];

    for (const p of state.positions) {
        const right = Math.max(nowTime, p.entryTime);
        if (p.stopPrice != null) boxes.push(box(`pos_${p.id}_risk`, p.entryTime, right, p.entryPrice, p.stopPrice, RISK_FILL));
        if (p.targetPrice != null) boxes.push(box(`pos_${p.id}_reward`, p.entryTime, right, p.entryPrice, p.targetPrice, REWARD_FILL));
        lines.push(line(`pos_${p.id}_entry`, p.entryTime, right, p.entryPrice, ENTRY_COLOR, 'dashed', 'none'));
        if (p.stopPrice != null) {
            priceLines.push({ id: `pos_${p.id}_sl`, paneId: 'price', price: p.stopPrice, color: STOP_COLOR, lineStyle: 'dashed', title: 'SL' });
        }
        if (p.targetPrice != null) {
            priceLines.push({ id: `pos_${p.id}_tp`, paneId: 'price', price: p.targetPrice, color: TARGET_COLOR, lineStyle: 'dashed', title: 'TP' });
        }
    }

    // A resting order has not happened yet: it is only drawn ahead of the playhead.
    for (const o of state.orders) {
        lines.push(line(`ord_${o.id}`, nowTime, nowTime, o.price, ORDER_COLOR, 'dashed', 'right'));
        priceLines.push({
            id: `ord_${o.id}_lvl`, paneId: 'price', price: o.price, color: ORDER_COLOR,
            lineStyle: 'dotted', title: o.tag ?? o.side,
        });
    }

    return { boxes, lines, priceLines };
}

/**
 * The replay account's visuals, mounted as a native indicator.
 *
 * State arrives as JSON through a single string input: `setInput` is the only
 * channel into a running native instance, and `InputValue` is primitives only.
 * Deliberately not a user drawing — that would file every recomputed frame into
 * Vela's undo history alongside the user's own lines.
 */
class ReplayPositionIndicator implements NativeIndicator {
    private ctx: NativeIndicatorContext | null = null;
    private state: ReplayVisualState = EMPTY_STATE;

    start(ctx: NativeIndicatorContext, inputs: Record<string, unknown>): void {
        this.ctx = ctx;
        this.apply(inputs);
    }

    /** Every revealed bar re-renders against the new playhead. */
    onBars(): void {
        this.emit();
    }

    onViewport(): void {
        /* not viewport-dependent */
    }

    setInputs(inputs: Record<string, unknown>): void {
        this.apply(inputs);
        this.emit();
    }

    suspend(): void {
        /* nothing running between frames */
    }

    resume(): void {
        this.emit();
    }

    stop(): void {
        this.ctx = null;
    }

    private apply(inputs: Record<string, unknown>): void {
        const raw = inputs[STATE_INPUT];
        if (typeof raw !== 'string' || raw.length === 0) return;
        // A malformed payload must not take the chart down mid-replay; the last
        // good state simply stays on screen.
        try {
            this.state = JSON.parse(raw) as ReplayVisualState;
        } catch {
            /* keep the previous state */
        }
    }

    private emit(): void {
        if (!this.ctx) return;
        const bars = this.ctx.bars();
        const now = bars.length > 0 ? bars[bars.length - 1]!.time : Date.now();
        this.ctx.emit(buildReplayOutput(this.state, now));
    }
}

/** The single string input carrying the serialized account state. */
export const STATE_INPUT = 'stateJson';

let registered = false;

/** Registers the type once per process (the registry is process-wide). */
export function registerReplayIndicator(): void {
    if (registered) return;
    registered = true;
    registerNativeIndicator({
        type: REPLAY_INDICATOR_TYPE,
        title: 'Replay position',
        paneHint: 'price',
        overlay: true,
        multiInstance: false,
        // Deliberately empty: `stateJson` is machinery, not a setting anyone edits,
        // so it must not appear in the indicator's settings dialog.
        inputsSchema: () => [],
        defaultInputs: () => ({ [STATE_INPUT]: '{}' }),
        create: () => new ReplayPositionIndicator(),
    });
}
