import type { BacktestEvent, RunnableStrategy } from '../../../shared/engine/backtest';
import { positionSize } from '../../../shared/strategies/risk.js';
import { andInto, createBitset, forEachBit, type Bitset } from './bits';
import type { Atom } from './atoms';
import type { ExitRule } from './outcomes';

/**
 * A found pattern as something the backtest engine can run.
 *
 * The search scores trades with its own arithmetic (see outcomes.ts); this is the same
 * trade written as orders, so the Broker fills it — with its costs, its sizing and its
 * compounding — and the two can be held to each other. The orders are the ones the
 * arithmetic assumes: a market entry after the signal candle closes, the stop and the
 * target anchored to that close, and a close on the clock after `maxBars`.
 */

export type PatternSide = 'long' | 'short';

/** The bars where every one of `ids` holds. Throws on an id the vocabulary lacks — a
 *  pattern that silently dropped a condition would trade something nobody found. */
export function patternBits(atoms: readonly Atom[], ids: readonly string[], size: number): Bitset {
    if (ids.length === 0) throw new Error('A pattern needs at least one condition.');
    const byId = new Map(atoms.map((a) => [a.id, a]));
    const out = createBitset(size);
    out.fill(0xffffffff);
    for (const id of ids) {
        const atom = byId.get(id);
        if (!atom) throw new Error(`Unknown pattern condition "${id}".`);
        andInto(out, out, atom.bits);
    }
    return out;
}

export interface PatternStrategyOptions {
    signals: Bitset;
    barCount: number;
    side: PatternSide;
    atr: Float64Array;
    exit: ExitRule;
    /** Percent of equity risked per trade. */
    riskPct: number;
}

interface OpenTrade {
    signalIndex: number;
    closing: boolean;
}

export function buildPatternStrategy(options: PatternStrategyOptions): RunnableStrategy {
    const { side, atr, exit, riskPct } = options;
    const events: BacktestEvent[] = [];
    forEachBit(options.signals, 0, options.barCount, (index) => { events.push({ index }); });
    const direction = side === 'long' ? 1 : -1;

    return {
        events: { signals: events },

        onBar(ctx) {
            const open = ctx.state.trade as OpenTrade | undefined;
            if (!ctx.isFlat) {
                /* Closed on the bar that completes the hold, so the order fills at the open
                 * after it — the same bar the search's arithmetic exits on. The stop and the
                 * target come off first: a reduce-only leg outlives the position it guarded
                 * and would otherwise sit in the book until price happened to reach it. */
                if (open && !open.closing && ctx.index - open.signalIndex >= exit.maxBars) {
                    ctx.cancelAll();
                    ctx.close('time');
                    open.closing = true;
                }
                return;
            }
            ctx.state.trade = undefined;
            if (ctx.pendingOrders.length > 0) return;
            if (ctx.events('signals').length === 0) return;

            const distance = exit.stopAtr * atr[ctx.index]!;
            if (!(distance > 0)) return;
            const anchor = ctx.bar.close;
            const stopLoss = anchor - direction * distance;
            const takeProfit = anchor + direction * exit.rrr * distance;
            const size = positionSize(ctx.equity, anchor, stopLoss, 'percent', riskPct, null);
            if (size == null) return;

            const spec = { size, stopLoss, takeProfit, tag: 'pattern' };
            if (direction > 0) ctx.buy(spec);
            else ctx.sell(spec);
            ctx.state.trade = { signalIndex: ctx.index, closing: false } satisfies OpenTrade;
        },
    };
}
