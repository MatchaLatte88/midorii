import { describe, expect, it } from 'vitest';
import { marketInfoToSymbolInfo, marketRowsToSymbols, periodsToBars } from '../app/electron/data/experimentalFeed.js';

describe('experimental feed normalization', () => {
  it('sorts, de-duplicates, and maps price periods into OHLCV bars', () => {
    expect(periodsToBars([
      { time: 20, open: 2, max: 4, min: 1, close: 3, volume: 8 },
      { time: 10, open: 1, max: 3, min: 0, close: 2, volume: 5 },
      { time: 20, open: 2, max: 5, min: 1, close: 4, volume: 9 },
      { time: 'bad', open: 1, max: 1, min: 1, close: 1, volume: 1 },
    ])).toEqual([
      { time: 10_000, open: 1, high: 3, low: 0, close: 2, volume: 5 },
      { time: 20_000, open: 2, high: 5, low: 1, close: 4, volume: 9 },
    ]);
  });

  it('keeps complete market ids so an explicit provider prefix remains loadable', () => {
    expect(marketRowsToSymbols([
      { id: 'NASDAQ:AAPL', exchange: 'NASDAQ', description: 'Apple Inc.', type: 'stock' },
      { id: 'BITSTAMP:BTCUSD', exchange: 'BITSTAMP', description: 'Bitcoin / U.S. Dollar', type: 'spot' },
      { exchange: 'NOPE' },
    ])).toEqual([
      { ticker: 'NASDAQ:AAPL', description: 'Apple Inc. · NASDAQ', type: 'stock' },
      { ticker: 'BITSTAMP:BTCUSD', description: 'Bitcoin / U.S. Dollar · BITSTAMP', type: 'crypto' },
    ]);
  });

  it('derives the price grid from the instrument scale', () => {
    expect(marketInfoToSymbolInfo({
      name: 'AAPL',
      exchange: 'Cboe One',
      listed_exchange: 'NASDAQ',
      description: 'Apple Inc.',
      type: 'stock',
      currency_code: 'USD',
      timezone: 'America/New_York',
      pricescale: 100,
      minmov: 1,
    }, 'NASDAQ:AAPL')).toEqual({
      ticker: 'AAPL',
      tickerid: 'NASDAQ:AAPL',
      prefix: 'NASDAQ',
      description: 'Apple Inc.',
      type: 'stock',
      currency: 'USD',
      timezone: 'America/New_York',
      pricescale: 100,
      mintick: 0.01,
    });
  });
});
