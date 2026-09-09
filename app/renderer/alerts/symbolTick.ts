import type { Vela } from '../../../src';

/**
 * The tick size of the symbols this session has charted, so an alert level can be snapped
 * to a tradable increment SYNCHRONOUSLY.
 *
 * Module-level and keyed by symbol, for the same reason `cursorPrice.ts` is: a right-click
 * or a dropped line has to produce a level there and then, while `chart.data.symbolInfo`
 * is a promise. The chart resolves that very metadata for its own price axis on every
 * market switch, so a symbol whose axis is drawn at its true precision is warm here too —
 * and an unknown symbol simply leaves the price unsnapped rather than blocking on a fetch.
 */
const ticks = new Map<string, number>();

/** The symbol's tick size, or undefined while its metadata has not landed. */
export function tickSizeOf(symbol: string): number | undefined {
    return ticks.get(symbol);
}

/**
 * A price on the symbol's own grid of tradable levels.
 *
 * The prices alerts are born from come off the pointer — a pixel row mapped back through
 * the price scale — so they carry as many decimals as the double has room for. Rounding to
 * the increment the market actually quotes in is what turns one of those into a level a
 * person could have named. `toFixed(8)` afterwards clears the dust the multiplication puts
 * back (`1112345 * 0.01` is not exactly `11123.45`); eight decimals is a satoshi, finer
 * than anything is quoted in. An unknown tick leaves the price alone — a guessed grid would
 * be worse than an ugly one.
 */
export function snapToTick(price: number, symbol: string): number {
    const tick = ticks.get(symbol);
    if (tick == null || !(tick > 0) || !Number.isFinite(price)) return price;
    return Number((Math.round(price / tick) * tick).toFixed(8));
}

/** Keep the cache fed from the chart's own metadata: the market it is on now, and every
 *  one it switches to. Returns a disposer. */
export function trackSymbolTicks(chart: Vela): () => void {
    const learn = (symbol: string | undefined): void => {
        if (!symbol || ticks.has(symbol)) return;
        void chart.data.symbolInfo(symbol).then((info) => {
            const tick = info?.mintick;
            if (typeof tick === 'number' && tick > 0) ticks.set(symbol, tick);
        });
    };
    learn(chart.market.symbol);
    return chart.on('market:changed', ({ symbol }) => learn(symbol));
}
