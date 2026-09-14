import { runBacktest, type BacktestContext, type RunnableStrategy } from '../../../shared/engine/backtest.js';
import type { OHLCV } from '../../../src/core/model/ohlcv';
import type { StrategyParams, StrategySpec } from '../strategies/types';

/**
 * Where a strategy would next act, from the playhead on.
 *
 * "A setup" means something different to every strategy here — a gap, a range break, an
 * oscillator cross — and each names its own events differently. What they all have in common
 * is the moment they commit: the bar on which the strategy sends an order. So that is what is
 * looked for, and it is looked for by running the strategy itself over the bars, through the
 * same backtest loop a run goes through. A second, simplified reading of each strategy's
 * conditions would be a second definition of its setups, and the replay would stop on bars the
 * backtest never traded.
 *
 * The strategy is started FLAT at the playhead
 * --------------------------------------------
 * Nothing it would have done before the playhead counts. A strategy that is still holding a
 * trade it took an hour ago does not take the next setup — and that trade is not the person's,
 * so it must not hide the setup from them. Detection runs over every bar the session holds, so
 * the indicators it reads are warmed up; the decisions start at the bar after the playhead.
 *
 * One consequence, said rather than hidden: a strategy that waits several bars between its
 * signal and its entry, with the signal before the playhead, is found at its NEXT signal, not at
 * the entry of the one already in progress.
 *
 * Looking ahead to find the stop is the point of the feature and costs the replay nothing:
 * every event a strategy acts on is placed at the bar it could first have been known at, so
 * the bar it stops on is the first moment the setup existed.
 */

/** Thrown out of the loop the moment an order is asked for — the search is over. */
class SetupFound {
    constructor(readonly index: number) {}
}

/**
 * The index in `bars` of the next bar after `fromIndex` on which the strategy sends an order,
 * or null when it sends none before the bars run out.
 *
 * `params` must already be resolved against the strategy's schema.
 */
export function nextSetupIndex(
    spec: StrategySpec,
    params: StrategyParams,
    bars: readonly OHLCV[],
    fromIndex: number,
): number | null {
    const built = spec.build(params, bars);

    const watched: RunnableStrategy<StrategyParams> = {
        ...built,
        onBar(ctx: BacktestContext<StrategyParams>) {
            if (ctx.index <= fromIndex) return;
            const found = (): never => {
                throw new SetupFound(ctx.index);
            };
            const proxy = new Proxy(ctx, {
                get(target, key, receiver) {
                    if (key === 'buy' || key === 'sell' || key === 'order') return found;
                    return Reflect.get(target, key, receiver) as unknown;
                },
            });
            built.onBar.call(built, proxy);
        },
    };

    try {
        runBacktest({ bars, strategy: watched });
    } catch (err: unknown) {
        if (err instanceof SetupFound) return err.index;
        throw err;
    }
    return null;
}
