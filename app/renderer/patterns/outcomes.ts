import type { Costs } from '../../../shared/engine/broker';
import type { PatternBar } from './atoms';

/**
 * What a trade taken on each bar would have done — computed once, read by every candidate.
 *
 * The exit is fixed for the whole search, and that is the point of it: with the exit held
 * still, the only thing that differs between two candidates is WHERE they get in, which is
 * what a pattern claims to know. It also makes the search cheap. A trade taken at bar `i`
 * ends the same way whichever pattern took it, so its result is worked out here once and a
 * candidate only has to add up the bars it picked.
 *
 * The rules, and why they match the engine exactly
 * ------------------------------------------------
 * The signal candle `i` closes. A market order goes in and fills at the next bar's open.
 * The stop sits `stopAtr` ATRs from the signal close and the target `rrr` times that
 * distance on the other side — both anchored to the close, because that is the price the
 * strategy knows when it places them. From the entry bar on, a bar that reaches the stop
 * stops out; one that reaches only the target takes profit; one that reaches both stops
 * out, because nothing in a single bar says which came first. A level the open has already
 * jumped past fills at the open. If neither is hit within `maxBars` bars, the trade is
 * closed at the open of the bar after.
 *
 * That is, to the fill, what `runBacktest` does with the same orders and no minute bars —
 * see `_fillAgainst` in the Broker — and the tests hold the two to it. A search that scored
 * trades one way and a backtest that filled them another would disagree about the very
 * patterns it found.
 *
 * Measured in R
 * -------------
 * One R is the planned risk: the distance from the signal close to the stop. A pattern's
 * worth is then its average R per trade, which does not depend on the account size and
 * reads the same on a quiet month as on a wild one. Costs are charged in R as well, using
 * the Broker's own cost model, so a pattern that only works before costs does not survive.
 */

export interface ExitRule {
    /** Stop distance in ATRs from the signal close. */
    stopAtr: number;
    /** Target distance as a multiple of the stop distance. */
    rrr: number;
    /** Bars a trade may stay open before it is closed on the clock. */
    maxBars: number;
}

export const DEFAULT_EXIT: ExitRule = { stopAtr: 1, rrr: 2, maxBars: 24 };

export interface Outcomes {
    /** Net R of a long taken on each bar; NaN where no trade could be taken or finished. */
    longR: Float64Array;
    shortR: Float64Array;
    /** The bar a long taken on each bar is flat again by — the first bar a new signal may
     *  act on. */
    longExit: Int32Array;
    shortExit: Int32Array;
}

/**
 * The outcome of a trade on every bar, both ways.
 *
 * A trade that would still be open at the last bar is NaN, not a partial result: the data
 * ends, the trade does not, and scoring it as if it had would count a price nobody traded
 * at as an exit.
 */
export function computeOutcomes(
    bars: readonly PatternBar[],
    atrs: Float64Array,
    rule: ExitRule,
    costs: Required<Costs>,
): Outcomes {
    if (!(rule.stopAtr > 0)) throw new Error('The stop distance has to be more than zero ATR.');
    if (!(rule.rrr > 0)) throw new Error('The reward-to-risk has to be more than zero.');
    if (!Number.isInteger(rule.maxBars) || rule.maxBars < 1) throw new Error('A trade has to be allowed at least one bar.');

    const n = bars.length;
    const out: Outcomes = {
        longR: new Float64Array(n).fill(Number.NaN),
        shortR: new Float64Array(n).fill(Number.NaN),
        longExit: new Int32Array(n).fill(-1),
        shortExit: new Int32Array(n).fill(-1),
    };

    for (let i = 0; i + 1 < n; i++) {
        const distance = rule.stopAtr * atrs[i]!;
        if (!(distance > 0)) continue;
        const anchor = bars[i]!.close;

        for (const direction of [1, -1] as const) {
            const stop = anchor - direction * distance;
            const target = anchor + direction * rule.rrr * distance;
            const entry = bars[i + 1]!.open;

            let exit = Number.NaN;
            let exitAt = -1;
            let market = false;

            for (let j = i + 1; j <= i + rule.maxBars && j < n; j++) {
                const bar = bars[j]!;
                // On the entry bar the fill is the reference; after it, the bar's own open.
                const reference = j === i + 1 ? entry : bar.open;
                const pastStop = direction > 0 ? reference <= stop : reference >= stop;
                const pastTarget = direction > 0 ? reference >= target : reference <= target;
                if (pastStop || pastTarget) {
                    exit = reference;
                    exitAt = j;
                    market = pastStop;
                    break;
                }
                const hitStop = direction > 0 ? bar.low <= stop : bar.high >= stop;
                const hitTarget = direction > 0 ? bar.high >= target : bar.low <= target;
                if (hitStop) {
                    exit = stop;
                    exitAt = j;
                    market = true;
                    break;
                }
                if (hitTarget) {
                    exit = target;
                    exitAt = j;
                    break;
                }
            }

            if (exitAt < 0) {
                const closeAt = i + rule.maxBars + 1;
                if (closeAt >= n) continue; // still open when the data ends
                exit = bars[closeAt]!.open;
                exitAt = closeAt;
                market = true;
            }

            const perSide = costs.feeRate + costs.spreadPct / 2;
            const charged = entry * (perSide + costs.slippagePct)
                + exit * (perSide + (market ? costs.slippagePct : 0))
                + 2 * costs.feePerUnit;
            const r = (direction * (exit - entry) - charged) / distance;

            if (direction > 0) {
                out.longR[i] = r;
                out.longExit[i] = exitAt;
            } else {
                out.shortR[i] = r;
                out.shortExit[i] = exitAt;
            }
        }
    }

    return out;
}
