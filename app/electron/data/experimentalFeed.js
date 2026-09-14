import chartData from '@mathieuc/tradingview';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BARS = 10_001;

let sharedClient = null;
const streams = new Map();
const infoCache = new Map();

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_BARS, Math.floor(n)) : fallback;
}

function errorText(parts) {
  return parts.map((part) => (
    part instanceof Error ? part.message : typeof part === 'string' ? part : JSON.stringify(part)
  )).join(' ');
}

function client() {
  if (sharedClient) return sharedClient;
  const next = new chartData.Client();
  sharedClient = next;
  next.onError((...parts) => {
    console.warn(`[midorii] Experimental feed: ${errorText(parts)}`);
  });
  next.onDisconnected(() => {
    if (sharedClient === next) sharedClient = null;
    for (const [key, stream] of streams) {
      if (stream.client !== next) continue;
      streams.delete(key);
      stream.closed = true;
    }
  });
  return next;
}

/** Convert the bridge's newest-first periods into Midorii's ascending OHLCV shape. */
export function periodsToBars(periods) {
  if (!Array.isArray(periods)) return [];
  const bars = periods.flatMap((period) => {
    const time = Number(period?.time) * 1_000;
    const open = Number(period?.open);
    const high = Number(period?.max);
    const low = Number(period?.min);
    const close = Number(period?.close);
    if (![time, open, high, low, close].every(Number.isFinite)) return [];
    const volume = Number(period?.volume);
    return [{ time, open, high, low, close, ...(Number.isFinite(volume) ? { volume } : {}) }];
  });
  bars.sort((a, b) => a.time - b.time);
  return [...new Map(bars.map((bar) => [bar.time, bar])).values()];
}

function symbolType(type) {
  const value = String(type ?? '').toLowerCase();
  if (value === 'spot' || value === 'crypto') return 'crypto';
  if (value === 'fund' || value === 'etf') return 'etf';
  if (value === 'commodity') return 'commodity';
  if (value === 'forex' || value === 'cfd') return 'forex';
  if (value === 'futures') return 'futures';
  if (value === 'stock' || value === 'index') return value;
  return value || undefined;
}

/** Normalize search rows while preserving their complete, directly loadable market id. */
export function marketRowsToSymbols(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const ticker = typeof row?.id === 'string' ? row.id.trim() : '';
    if (!ticker) return [];
    const exchange = typeof row.exchange === 'string' ? row.exchange.trim() : '';
    const description = typeof row.description === 'string' ? row.description.trim() : '';
    return [{
      ticker,
      ...(description || exchange ? { description: [description, exchange].filter(Boolean).join(' · ') } : {}),
      ...(symbolType(row.type) ? { type: symbolType(row.type) } : {}),
    }];
  });
}

export async function experimentalSearch(rawQuery = '') {
  const query = String(rawQuery ?? '').trim();
  const rows = await chartData.searchMarketV3(query, '', 0);
  return marketRowsToSymbols(rows);
}

/** Keep only neutral instrument metadata used by the chart and its scripting context. */
export function marketInfoToSymbolInfo(info, market) {
  const pricescale = Number(info?.pricescale);
  const minmov = Number(info?.minmov);
  const prefix = typeof info?.listed_exchange === 'string' && info.listed_exchange
    ? info.listed_exchange
    : info?.exchange;
  const mintick = Number.isFinite(pricescale) && pricescale > 0 && Number.isFinite(minmov) && minmov > 0
    ? minmov / pricescale
    : undefined;
  return {
    ticker: typeof info?.name === 'string' && info.name ? info.name : market,
    tickerid: market,
    ...(typeof prefix === 'string' && prefix ? { prefix } : {}),
    ...(typeof info?.description === 'string' && info.description ? { description: info.description } : {}),
    ...(typeof info?.type === 'string' && info.type ? { type: symbolType(info.type) } : {}),
    ...(typeof info?.currency_code === 'string' && info.currency_code ? { currency: info.currency_code } : {}),
    ...(typeof info?.timezone === 'string' && info.timezone ? { timezone: info.timezone } : {}),
    ...(Number.isFinite(pricescale) && pricescale > 0 ? { pricescale } : {}),
    ...(mintick != null ? { mintick } : {}),
  };
}

export function experimentalSymbolInfo(rawSymbol) {
  const market = requireText(rawSymbol, 'symbol');
  const cached = infoCache.get(market);
  if (cached) return cached;

  const pending = new Promise((resolve, reject) => {
    const chart = new (client().Session.Chart)();
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chart.delete();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`Timed out resolving ${market}`)), REQUEST_TIMEOUT_MS);
    chart.onError((...parts) => finish(reject, new Error(errorText(parts))));
    chart.onSymbolLoaded(() => finish(resolve, marketInfoToSymbolInfo(chart.infos, market)));
    chart.setMarket(market, { timeframe: 'D', range: 1 });
  });
  pending.catch(() => infoCache.delete(market));
  infoCache.set(market, pending);
  return pending;
}

export function experimentalBars({ symbol, timeframe, from, to, limit, session } = {}) {
  const market = requireText(symbol, 'symbol');
  const resolution = requireText(timeframe, 'timeframe');
  const count = positiveInt(limit, 600);
  const fromTime = typeof from === 'number' && Number.isFinite(from) ? from : undefined;
  const toTime = typeof to === 'number' && Number.isFinite(to) ? to : undefined;

  return new Promise((resolve, reject) => {
    const chart = new (client().Session.Chart)();
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chart.delete();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`Timed out loading ${market}`)), REQUEST_TIMEOUT_MS);

    chart.onError((...parts) => finish(reject, new Error(errorText(parts))));
    chart.onUpdate((changes) => {
      if (!changes.includes('$prices') || !chart.periods.length) return;
      let bars = periodsToBars(chart.periods);
      if (fromTime != null) bars = bars.filter((bar) => bar.time >= fromTime);
      if (toTime != null) bars = bars.filter((bar) => bar.time < toTime);
      finish(resolve, bars.slice(-count));
    });
    chart.setMarket(market, {
      timeframe: resolution,
      range: count,
      ...(toTime != null ? { to: Math.floor((toTime - 1) / 1_000) } : {}),
      ...(session === 'extended' ? { session: 'extended' } : {}),
    });
  });
}

function streamKey(symbol, timeframe, session) {
  return `${symbol}\u0000${timeframe}\u0000${session === 'extended' ? 'extended' : 'regular'}`;
}

function openStream(symbol, timeframe, session) {
  const owner = client();
  const chart = new (owner.Session.Chart)();
  const stream = { chart, client: owner, listeners: new Set(), closed: false };

  chart.onError((...parts) => {
    console.warn(`[midorii] Experimental feed: ${errorText(parts)}`);
  });
  chart.onUpdate((changes) => {
    if (stream.closed || !changes.includes('$prices')) return;
    const bar = periodsToBars(chart.periods).at(-1);
    if (!bar) return;
    for (const listener of [...stream.listeners]) listener(bar);
  });
  chart.setMarket(symbol, {
    timeframe,
    range: 2,
    ...(session === 'extended' ? { session: 'extended' } : {}),
  });
  return stream;
}

/** Share one upstream chart session across panes watching the same market. */
export function experimentalSubscribe({ symbol, timeframe, session } = {}, onBar) {
  const market = requireText(symbol, 'symbol');
  const resolution = requireText(timeframe, 'timeframe');
  if (typeof onBar !== 'function') throw new Error('onBar is required');
  const key = streamKey(market, resolution, session);
  let stream = streams.get(key);
  if (!stream || stream.closed) {
    stream = openStream(market, resolution, session);
    streams.set(key, stream);
  }
  stream.listeners.add(onBar);

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    stream.listeners.delete(onBar);
    if (stream.listeners.size) return;
    stream.closed = true;
    streams.delete(key);
    stream.chart.delete();
  };
}
