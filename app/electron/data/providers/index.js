/* The download sources.
 *
 * One shape for all of them — `listSymbols()` and `downloadRange()` — so the
 * IPC layer and the UI stay the same whether the bars come out of a monthly
 * archive or a thousand paged REST calls. What differs between venues is how
 * they name a market, which is what `example` and `naming` are for: the
 * download dialog shows them, because a symbol typed in another venue's
 * spelling is the most common way a download fails.
 *
 * Every source serves the base timeframe (1m) and the store aggregates
 * everything above it, so there is exactly one file per symbol on disk no
 * matter what timeframe the chart is on.
 */
import * as binance from './binance.js';
import * as coinbase from './coinbase.js';
import * as hyperliquid from './hyperliquid.js';

/** @type {Record<string, {id:string,label:string,example:string,naming:string,module:object}>} */
export const SOURCES = {
  binance: {
    id: 'binance',
    label: 'Binance',
    example: 'BTCUSDT',
    naming: 'Spot pairs with no separator, from the public monthly archive — the deepest history of the three.',
    module: binance,
  },
  coinbase: {
    id: 'coinbase',
    label: 'Coinbase',
    example: 'BTC-USD',
    naming: 'Products written BASE-QUOTE. Paged from the public API, so a long range takes a while.',
    module: coinbase,
  },
  hyperliquid: {
    id: 'hyperliquid',
    label: 'Hyperliquid',
    example: 'BTC',
    naming: 'Perpetuals named by their base asset, spot pairs as BASE/QUOTE. History is shorter than the others.',
    module: hyperliquid,
  },
};

/** The default source — the one with a full archive behind it. */
export const DEFAULT_SOURCE = 'binance';

/** A source by id, or a plain error naming the ones that exist. */
export function sourceOf(id) {
  const source = SOURCES[id];
  if (!source) {
    throw new Error(`Unknown data source "${id}". Known: ${Object.keys(SOURCES).join(', ')}.`);
  }
  return source;
}

/** What the renderer needs to show a source picker — no functions cross IPC. */
export function listSources() {
  return Object.values(SOURCES).map(({ id, label, example, naming }) => ({ id, label, example, naming }));
}
