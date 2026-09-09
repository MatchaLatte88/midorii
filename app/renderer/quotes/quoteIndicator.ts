import { registerNativeIndicator } from '../../../src/plugin';
import type { NativeIndicator, NativeIndicatorContext, NativeIndicatorOutput, PriceLine } from '../../../src/plugin';
import { DEFAULT_QUOTE_DISPLAY, type QuoteDisplay } from './quoteDisplay';

/**
 * Bid and ask as levels on the chart.
 *
 * The candles are drawn from the bid, which means the chart's own last-price line marks
 * where you can SELL. The ask is somewhere above it and nothing on the chart says where —
 * so a buy always fills a little further away than the chart appears to promise, and on a
 * wide spread it is a lot further. These two lines are that gap, drawn where it happens
 * rather than only counted in a corner.
 *
 * Both lines share one colour. They are not two independent levels to be told apart; they
 * are the two ends of one measurement, and the ask is always the upper of the two — an
 * ordering the market itself guarantees, which is why neither line needs a label saying
 * which it is.
 */

/** The native-indicator type id — mounted once per chart, like the alert lines. */
export const QUOTE_INDICATOR_TYPE = 'market-quote';

const BID_INPUT = 'bid';
const ASK_INPUT = 'ask';
const BRACKETS_INPUT = 'showBrackets';

/**
 * A muted cyan, kept clear of every level that means something a person DID: the alert
 * orange, and the position grey/red/green. A quote is not a decision — it is the ground the
 * decisions are made on, and it should not look like one of them.
 */
const LINE_COLOR = '#4a9db8';

export const BID_LINE_ID = 'quote_bid';
export const ASK_LINE_ID = 'quote_ask';

/** The two lines for one quote, or none where there is nothing to draw yet. */
export function quotePriceLines(bid: number, ask: number, showBrackets: boolean): PriceLine[] {
    if (!(bid > 0) || !(ask > 0)) return [];
    const line = (id: string, price: number): PriceLine => ({
        id,
        paneId: 'price',
        price,
        color: LINE_COLOR,
        /* Dotted, and thinner-reading than every other level on the chart. These two are
         * always on screen and always moving; a solid pair would compete with the candles
         * they sit on top of, which is the one thing a quote must never do. */
        lineStyle: 'dotted',
        axisTag: showBrackets,
    });
    return [line(BID_LINE_ID, bid), line(ASK_LINE_ID, ask)];
}

class MarketQuoteIndicator implements NativeIndicator {
    private ctx: NativeIndicatorContext | null = null;
    private bid = 0;
    private ask = 0;
    private showBrackets = DEFAULT_QUOTE_DISPLAY.showBrackets;

    start(ctx: NativeIndicatorContext, inputs: Record<string, unknown>): void {
        this.ctx = ctx;
        this.apply(inputs);
        this.emit();
    }

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
        const bid = inputs[BID_INPUT];
        const ask = inputs[ASK_INPUT];
        const brackets = inputs[BRACKETS_INPUT];
        if (typeof bid === 'number') this.bid = bid;
        if (typeof ask === 'number') this.ask = ask;
        if (typeof brackets === 'boolean') this.showBrackets = brackets;
    }

    private emit(): void {
        if (!this.ctx) return;
        const out: NativeIndicatorOutput = { priceLines: quotePriceLines(this.bid, this.ask, this.showBrackets) };
        this.ctx.emit(out);
    }
}

let registered = false;

/** Registers the type once per process (the registry is process-wide). */
export function registerQuoteIndicator(): void {
    if (registered) return;
    registered = true;
    registerNativeIndicator({
        type: QUOTE_INDICATOR_TYPE,
        title: 'Bid / ask',
        paneHint: 'price',
        overlay: true,
        multiInstance: false,
        // Machinery, not a setting anyone edits by hand — the same empty schema the alert
        // and position indicators carry, for the same reason.
        inputsSchema: () => [],
        defaultInputs: () => ({ [BID_INPUT]: 0, [ASK_INPUT]: 0 }),
        create: () => new MarketQuoteIndicator(),
    });
}

/** The input payload `installQuotes.ts` pushes on every tick and on every display change. */
export function quoteIndicatorInputs(
    bid: number,
    ask: number,
    display: QuoteDisplay = DEFAULT_QUOTE_DISPLAY,
): Record<string, number | boolean> {
    // Lines off ⇒ no levels at all, which is also what takes the brackets with them: a
    // bracket is a label ON a line, and there is nothing to label.
    if (!display.showLines) return { [BID_INPUT]: 0, [ASK_INPUT]: 0, [BRACKETS_INPUT]: false };
    return { [BID_INPUT]: bid, [ASK_INPUT]: ask, [BRACKETS_INPUT]: display.showBrackets };
}
