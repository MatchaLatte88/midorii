/* Bybit V5 trading — spot pairs and USDT perpetuals, on the demo host or the real one.
 *
 * One module for both products, because the venue itself is one API: every call below takes
 * a `category` — `spot` or `linear` — and the two diverge only where they genuinely differ.
 * A spot holding is a balance and a perpetual is a position, so what is open is read from
 * two different books; spot protection is a resting sell and a perpetual's is an attribute
 * of the position itself. Everything else — signing, clock, order placement, cancellation —
 * is the same endpoint with a different word in it, and is written once.
 *
 * Which host is a fact about the credentials rather than a setting a caller may pass. Demo
 * keys are issued by a separate Bybit account and work only against api-demo.bybit.com; live
 * keys work only against api.bybit.com. So the two travel together, they are stored together,
 * and `bybitEnvironment()` reports which of them is in force — anything that can place an
 * order has to be able to say whether the money is real.
 *
 * Public market data is read from the live host in both cases. Bybit's demo module has no
 * price archive of its own: it serves the mainnet's prices, and asking mainnet directly needs
 * no key at all.
 *
 * Credentials and signatures stay in this process. The renderer can ask for an account or an
 * order; there is no channel that hands the secret back.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { createGate, request } from './providers/http.js';

export const BYBIT_DEMO_BASE = 'https://api-demo.bybit.com';
export const BYBIT_LIVE_BASE = 'https://api.bybit.com';
/** Where prices come from, whichever account is connected — demo mirrors mainnet. */
export const BYBIT_MARKET_BASE = BYBIT_LIVE_BASE;

const RECV_WINDOW = 5_000;
/** Re-read the venue clock this often; a signature outside recvWindow is refused. */
const CLOCK_TTL_MS = 5 * 60_000;

/** `{ apiKey, secretKey, env }`, or null when nothing is connected. */
let credentials = null;
let clockOffset = 0;
let clockReadAt = 0;
let clockSync = null;

export function configureBybit({ apiKey, secretKey, env } = {}) {
  credentials = apiKey && secretKey
    ? { apiKey: String(apiKey), secretKey: String(secretKey), env: env === 'live' ? 'live' : 'demo' }
    : null;
  clockReadAt = 0;
  clockOffset = 0;
}

export function bybitConfigured() {
  return credentials != null;
}

/**
 * Which account the credentials point at, for a screen that has to SAY so.
 *
 * The same reason Capital.com reports it: the difference between demo and live is one word
 * in a file nobody looks at twice, and it is the difference between a mistake that costs
 * nothing and one that costs money.
 */
export function bybitEnvironment() {
  return { configured: bybitConfigured(), env: credentials?.env ?? null, live: credentials?.env === 'live' };
}

function tradeBase(env) {
  return (env ?? credentials?.env) === 'live' ? BYBIT_LIVE_BASE : BYBIT_DEMO_BASE;
}

export function hmacSignature(secretKey, payload) {
  return createHmac('sha256', secretKey).update(payload).digest('hex');
}

/** Bybit caps `orderLinkId` at 36 characters; this shape is 30. */
function clientId(prefix) {
  return `mi_${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`.slice(0, 36);
}

function requireCredentials(override) {
  const value = override ?? credentials;
  if (!value?.apiKey || !value?.secretKey) {
    throw new Error('Bybit is not connected. Add its API key in Settings first.');
  }
  return value;
}

/** The category as the venue spells it, refusing anything this module has not been taught. */
export function bybitCategory(value) {
  const category = String(value ?? '').toLowerCase();
  if (category !== 'spot' && category !== 'linear') {
    throw new Error(`Midorii trades Bybit spot and linear perpetuals; "${value}" is neither.`);
  }
  return category;
}

/**
 * A ticker as the app writes it → the market Bybit means by it.
 *
 * Bybit calls its BTC perpetual and its BTC spot pair the same thing, `BTCUSDT`, and keeps
 * them apart with a category rather than a name. The app cannot: one chart symbol has to name
 * one market. So it uses the suffix it already uses for Binance's perpetuals — `BTCUSDT.P` is
 * the contract, `BTCUSDT` is the pair — and this is the one place that knows it.
 */
export function bybitMarket(ticker) {
  const text = String(ticker ?? '').toUpperCase();
  return text.endsWith('.P')
    ? { category: 'linear', symbol: text.slice(0, -2) }
    : { category: 'spot', symbol: text };
}

/** The inverse: the market this module names, written the way the app writes it. */
export function bybitTicker(category, symbol) {
  return bybitCategory(category) === 'linear' ? `${String(symbol).toUpperCase()}.P` : String(symbol).toUpperCase();
}

function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value == null) continue;
    search.set(key, String(value));
  }
  return search.toString();
}

/**
 * Bybit's own answer, unwrapped.
 *
 * A refusal arrives as HTTP 200 with a non-zero `retCode`, so the status alone says nothing:
 * reading `result` off a rejected call would hand back an empty object as though the order
 * had worked. Both failure shapes end up as one Error carrying the venue's code, which the
 * callers below branch on.
 */
async function readResult(response, action) {
  const body = await response.json().catch(() => null);
  const code = Number(body?.retCode);
  if (response.ok && code === 0) return body?.result ?? null;
  const message = typeof body?.retMsg === 'string' && body.retMsg ? body.retMsg : `HTTP ${response.status}`;
  const err = new Error(`Bybit ${action} failed${Number.isFinite(code) && code !== 0 ? ` (${code})` : ''}: ${message}`);
  err.code = Number.isFinite(code) ? code : null;
  err.status = response.status;
  throw err;
}

/* Public market data is serial and spaced, through the same gate the paged download sources
 * use: a history download is hundreds of calls, the live chart polls on top of it, and both
 * land on this one host. A burst that earns a 429 costs more time than the spacing does. */
const publicGate = createGate(60);

async function publicRequest(path, params = {}) {
  const query = queryString(params);
  const url = `${BYBIT_MARKET_BASE}${path}${query ? `?${query}` : ''}`;
  return readResult(await request(publicGate, url, { headers: { Accept: 'application/json' } }), path);
}

async function syncClock() {
  if (clockSync) return clockSync;
  clockSync = (async () => {
    const result = await publicRequest('/v5/market/time');
    // `timeNano` is a nanosecond string; `timeSecond` loses the sub-second part.
    const nano = Number(result?.timeNano);
    const seconds = Number(result?.timeSecond);
    const serverTime = Number.isFinite(nano) && nano > 0 ? Math.round(nano / 1e6)
      : Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : NaN;
    if (!Number.isFinite(serverTime)) throw new Error('Bybit returned no valid server time.');
    clockOffset = serverTime - Date.now();
    clockReadAt = Date.now();
  })();
  try {
    await clockSync;
  } finally {
    clockSync = null;
  }
}

/** The wording for an instruction whose fate the venue never reported. */
function unconfirmed() {
  return new Error(
    'Bybit did not confirm what became of the instruction. Check the open orders and the position before sending it again.',
  );
}

/**
 * A signed V5 call.
 *
 * The signature covers `timestamp + apiKey + recvWindow + payload`, where the payload is the
 * query string on a GET and the exact JSON body on a POST — exact meaning the same bytes
 * that are sent, which is why the body is serialized once and reused rather than serialized
 * twice from the same object.
 */
async function signedRequest(method, path, params = {}, override = null, retriedClock = false) {
  const creds = requireCredentials(override);
  if (Date.now() - clockReadAt > CLOCK_TTL_MS) await syncClock();

  const get = method === 'GET';
  const payload = get ? queryString(params) : JSON.stringify(params ?? {});
  const timestamp = String(Date.now() + clockOffset);
  const signature = hmacSignature(creds.secretKey, `${timestamp}${creds.apiKey}${RECV_WINDOW}${payload}`);
  const url = `${tradeBase(override?.env)}${path}${get && payload ? `?${payload}` : ''}`;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        'X-BAPI-API-KEY': creds.apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': String(RECV_WINDOW),
        'X-BAPI-SIGN': signature,
        ...(get ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(get ? {} : { body: payload }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (err) {
    /* A read that never arrived can simply be asked again. A WRITE that never arrived may
     * still have been executed, and the honest answer is that nobody knows which. */
    if (!get) throw unconfirmed();
    throw err;
  }

  try {
    return await readResult(response, path);
  } catch (err) {
    // 10002: the request timestamp sat outside recvWindow — this machine's clock has drifted.
    if (err?.code === 10002 && !retriedClock) {
      await syncClock();
      return signedRequest(method, path, params, override, true);
    }
    if (!get && Number(err?.status) >= 500) throw unconfirmed();
    throw err;
  }
}

/**
 * Try credentials without storing them, and answer with what they reach.
 *
 * Both halves matter. The key's own record says whether it may trade at all — a read-only
 * key connects perfectly and then refuses every order — and the wallet says which account it
 * landed on, which is the only way to notice a live key typed into the demo form.
 */
export async function bybitProbe(candidate) {
  await syncClock();
  const key = await signedRequest('GET', '/v5/user/query-api', {}, candidate);
  if (Number(key?.readOnly) === 1) {
    throw new Error('This Bybit key is read-only. Create one with trade permission, or Midorii can watch but not trade.');
  }
  const permissions = key?.permissions ?? {};
  const canSpot = Array.isArray(permissions.Spot) && permissions.Spot.length > 0;
  const canDerivatives = (Array.isArray(permissions.ContractTrade) && permissions.ContractTrade.length > 0)
    || (Array.isArray(permissions.Derivatives) && permissions.Derivatives.length > 0);
  if (!canSpot && !canDerivatives) {
    throw new Error('This Bybit key carries neither spot nor derivatives trade permission. Enable one of them for the key and try again.');
  }
  const wallet = await signedRequest('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' }, candidate);
  return {
    uid: key?.userID ?? null,
    note: key?.note ?? null,
    readOnly: Number(key?.readOnly) === 1,
    uta: Number(key?.uta) === 1,
    spot: canSpot,
    derivatives: canDerivatives,
    wallet: wallet?.list?.[0] ?? null,
  };
}

/* ── sizes and prices ──────────────────────────────────────────────────────
 *
 * Every number Bybit is sent is a string, and a string it refuses is a rejected order. So a
 * size is floored onto the venue's own step and a price onto its own tick before either is
 * spelled out — floored rather than rounded, so snapping can only ever make an order smaller
 * than asked for, never larger than the balance behind it.
 */

export function decimalPlaces(step) {
  const text = String(step).toLowerCase();
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

export function floorToStep(value, step) {
  const n = Number(value);
  const s = Number(step);
  if (!Number.isFinite(n) || !Number.isFinite(s) || !(s > 0)) return NaN;
  const places = Math.min(15, decimalPlaces(s));
  const units = Math.floor((n + s * 1e-9) / s);
  return Number((units * s).toFixed(places));
}

function decimal(value, step, what) {
  const snapped = floorToStep(value, step);
  if (!(snapped > 0)) throw new Error(`The ${what} is smaller than this Bybit market allows.`);
  return snapped.toFixed(decimalPlaces(step));
}

/**
 * One instrument's rules, in the shape the app uses for every venue.
 *
 * Spot and linear describe themselves differently — spot states a `basePrecision` and a
 * minimum ORDER VALUE, linear a `qtyStep` and a minimum NOTIONAL — so both are read into the
 * same six numbers here rather than at each of the places that needs them.
 */
export function parseBybitInstrument(payload, category, wanted) {
  const row = payload?.list?.find((candidate) => candidate.symbol === wanted) ?? payload?.list?.[0];
  if (!row) throw new Error(`Bybit does not list ${wanted} as a ${category} market.`);
  const tickSize = Number(row.priceFilter?.tickSize);
  const lot = row.lotSizeFilter ?? {};
  const step = Number(category === 'spot' ? lot.basePrecision : lot.qtyStep);
  const minQty = Number(lot.minOrderQty);
  const maxQty = Number(lot.maxOrderQty ?? lot.maxMktOrderQty);
  if (!(tickSize > 0) || !(step > 0)) {
    throw new Error(`Bybit returned incomplete ${category} rules for ${wanted}.`);
  }
  return {
    category,
    symbol: row.symbol,
    /* Spot says `Trading`, linear says `Trading` too — but linear also has `PreLaunch`,
     * `Delivering` and `Closed`, and only the first of the four takes an order. */
    status: row.status,
    baseAsset: row.baseCoin,
    quoteAsset: row.quoteCoin,
    /** What a perpetual's result is paid in; null on spot, which settles in the pair. */
    settleAsset: category === 'linear' ? (row.settleCoin ?? row.quoteCoin) : null,
    tickSize,
    stepSize: step,
    minQty: Number.isFinite(minQty) && minQty > 0 ? minQty : step,
    maxQty: Number.isFinite(maxQty) && maxQty > 0 ? maxQty : Infinity,
    /** The smallest an order may be WORTH, in the quote asset. 0 where the venue sets none. */
    minNotional: Number(lot.minNotionalValue ?? lot.minOrderAmt ?? 0) || 0,
    maxLeverage: Number(row.leverageFilter?.maxLeverage ?? 0) || null,
  };
}

export async function bybitInstrument(category, symbol) {
  const cat = bybitCategory(category);
  const sym = String(symbol).toUpperCase();
  return parseBybitInstrument(await publicRequest('/v5/market/instruments-info', { category: cat, symbol: sym }), cat, sym);
}

/**
 * Candles, oldest first.
 *
 * Bybit answers newest-first and in strings; the chart wants the opposite of both, and every
 * caller would otherwise reverse and coerce the same list itself.
 */
export async function bybitKlines({ category, symbol, interval, start, end, limit } = {}) {
  const result = await publicRequest('/v5/market/kline', {
    category: bybitCategory(category),
    symbol: String(symbol).toUpperCase(),
    interval: String(interval),
    ...(Number.isFinite(Number(start)) ? { start: Math.floor(Number(start)) } : {}),
    ...(Number.isFinite(Number(end)) ? { end: Math.floor(Number(end)) } : {}),
    limit: Math.min(1000, Math.max(1, Math.floor(Number(limit) || 200))),
  });
  const rows = Array.isArray(result?.list) ? result.list : [];
  const bars = [];
  for (const row of rows) {
    const time = Number(row[0]);
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[5]);
    if (!Number.isFinite(time) || !Number.isFinite(open) || !Number.isFinite(high)
      || !Number.isFinite(low) || !Number.isFinite(close)) continue;
    bars.push({ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }
  bars.sort((a, b) => a.time - b.time);
  return bars;
}

/** Every market of one category, for the symbol picker and the download dialog. */
export async function bybitInstruments(category) {
  const cat = bybitCategory(category);
  const out = [];
  let cursor = null;
  do {
    const result = await publicRequest('/v5/market/instruments-info', {
      category: cat,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const row of result?.list ?? []) {
      if (row.status !== 'Trading') continue;
      out.push({ symbol: row.symbol, base: row.baseCoin, quote: row.quoteCoin });
    }
    // Spot ignores paging entirely and returns the same cursor forever; stop after one page.
    cursor = cat === 'spot' ? null : (result?.nextPageCursor || null);
  } while (cursor);
  return out;
}

/* ── the account ──────────────────────────────────────────────────────── */

export function bybitWallet() {
  return signedRequest('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
}

/** Open perpetual positions. Meaningless on spot, which holds balances instead. */
export function bybitPositions(symbol) {
  return signedRequest('GET', '/v5/position/list', { category: 'linear', symbol: String(symbol).toUpperCase() });
}

/**
 * What is still waiting, of every kind.
 *
 * Spot keeps its plain orders, its conditional orders and its TP/SL orders in three separate
 * filters and serves ONE of them per call, so all three are asked for and joined. Linear has
 * no such split — a conditional order is an order — and is one call.
 */
export async function bybitOpenOrders(category, symbol) {
  const cat = bybitCategory(category);
  const sym = String(symbol).toUpperCase();
  if (cat !== 'spot') {
    const result = await signedRequest('GET', '/v5/order/realtime', { category: cat, symbol: sym, limit: 50 });
    return result?.list ?? [];
  }
  const filters = ['Order', 'StopOrder', 'tpslOrder'];
  const answers = await Promise.all(filters.map((orderFilter) => (
    signedRequest('GET', '/v5/order/realtime', { category: cat, symbol: sym, orderFilter, limit: 50 })
  )));
  const seen = new Set();
  const orders = [];
  for (const answer of answers) {
    for (const order of answer?.list ?? []) {
      if (seen.has(order.orderId)) continue;
      seen.add(order.orderId);
      orders.push(order);
    }
  }
  return orders;
}

/** This account's own executions on one market — what a spot holding's cost is read from. */
export async function bybitExecutions(category, symbol) {
  const result = await signedRequest('GET', '/v5/execution/list', {
    category: bybitCategory(category),
    symbol: String(symbol).toUpperCase(),
    limit: 100,
  });
  return result?.list ?? [];
}

/* ── orders ───────────────────────────────────────────────────────────── */

/** Which way price has to move to spring a trigger: 1 rises into it, 2 falls into it. */
function triggerDirection(side, triggerPrice, reference) {
  if (Number.isFinite(reference) && reference > 0) return triggerPrice > reference ? 1 : 2;
  // Without a reference price, read it off the side: a stop-entry buys above and sells below.
  return side === 'Buy' ? 1 : 2;
}

/**
 * One order, in Bybit's own vocabulary.
 *
 * Protection travels WITH the entry wherever the venue allows it, which is the whole point of
 * placing it here rather than afterwards: an entry that fills and then fails to be protected
 * is the one outcome nobody wants, and the venue can only rule it out if it is told both at
 * once. Linear takes stop and target on any entry. Spot takes them on a limit entry only —
 * a spot market entry is protected by the follow-up in {@link bybitPlaceOrder}.
 */
function orderParams(spec, info) {
  const category = info.category;
  const side = spec.side === 'Sell' ? 'Sell' : 'Buy';
  const type = spec.type === 'Limit' ? 'Limit' : 'Market';
  const trigger = Number(spec.triggerPrice);
  const conditional = Number.isFinite(trigger) && trigger > 0;
  const qty = decimal(spec.qty, info.stepSize, 'order size');
  const stopLoss = Number(spec.bracket?.stopLoss);
  const takeProfit = Number(spec.bracket?.takeProfit);
  const hasStop = Number.isFinite(stopLoss) && stopLoss > 0;
  const hasTarget = Number.isFinite(takeProfit) && takeProfit > 0;

  const params = {
    category,
    symbol: info.symbol,
    side,
    orderType: type,
    qty,
    orderLinkId: clientId('ord'),
    ...(type === 'Limit' ? { price: decimal(spec.price, info.tickSize, 'limit price'), timeInForce: 'GTC' } : {}),
  };

  if (category === 'spot') {
    /* Without this a spot MARKET BUY reads `qty` as an amount of the quote asset — Bybit's
     * own default, and a silent factor-of-the-price difference from every other order this
     * app sends. Everything here is sized in base units, so it says so. */
    if (type === 'Market') params.marketUnit = 'baseCoin';
    /* The two places spot cannot carry the protection it was asked for. Refused rather than
     * dropped: an order that quietly arrives without its stop is the one failure that looks
     * exactly like success until it costs something. */
    if ((hasStop || hasTarget) && side === 'Sell') {
      throw new Error('A spot sell closes a holding; it cannot open a short or carry protection of its own.');
    }
    if ((hasStop || hasTarget) && conditional) {
      throw new Error('A spot stop-entry cannot carry protection. Place it first, then set the stop and target once it has filled.');
    }
    if (conditional) {
      params.orderFilter = 'StopOrder';
      params.triggerPrice = decimal(trigger, info.tickSize, 'trigger price');
    } else if (type === 'Limit' && (hasStop || hasTarget)) {
      params.orderFilter = 'tpslOrder';
      if (hasTarget) { params.takeProfit = decimal(takeProfit, info.tickSize, 'take-profit'); params.tpOrderType = 'Market'; }
      if (hasStop) { params.stopLoss = decimal(stopLoss, info.tickSize, 'stop-loss'); params.slOrderType = 'Market'; }
    }
    return params;
  }

  // Linear runs in one-way mode: one position per symbol, which is what the chart draws.
  params.positionIdx = 0;
  if (spec.reduceOnly === true) params.reduceOnly = true;
  if (conditional) {
    params.triggerPrice = decimal(trigger, info.tickSize, 'trigger price');
    params.triggerDirection = triggerDirection(side, trigger, Number(spec.reference));
    params.triggerBy = 'LastPrice';
  }
  if (hasTarget) { params.takeProfit = decimal(takeProfit, info.tickSize, 'take-profit'); params.tpTriggerBy = 'LastPrice'; }
  if (hasStop) { params.stopLoss = decimal(stopLoss, info.tickSize, 'stop-loss'); params.slTriggerBy = 'LastPrice'; }
  if (hasTarget || hasStop) params.tpslMode = 'Full';
  return params;
}

/**
 * A standalone spot TP/SL sell over a holding that already exists.
 *
 * Bybit's `tpslOrder` filter reserves the base units when the order is placed rather than
 * when it triggers, so one order can carry both legs and neither can fire twice. This is the
 * one shape in this module that no amount of reading settles for certain — the documented
 * examples all attach TP/SL to an entry — so a refusal is passed straight through in the
 * venue's own words rather than smoothed over.
 */
function spotProtectionParams(info, quantity, levels) {
  const stopLoss = Number(levels?.stopLoss);
  const takeProfit = Number(levels?.takeProfit);
  const hasStop = Number.isFinite(stopLoss) && stopLoss > 0;
  const hasTarget = Number.isFinite(takeProfit) && takeProfit > 0;
  if (!hasStop && !hasTarget) return null;
  return {
    category: 'spot',
    symbol: info.symbol,
    side: 'Sell',
    orderType: 'Market',
    qty: decimal(quantity, info.stepSize, 'protected size'),
    orderFilter: 'tpslOrder',
    orderLinkId: clientId('prot'),
    ...(hasTarget ? { takeProfit: decimal(takeProfit, info.tickSize, 'take-profit'), tpOrderType: 'Market' } : {}),
    ...(hasStop ? { stopLoss: decimal(stopLoss, info.tickSize, 'stop-loss'), slOrderType: 'Market' } : {}),
  };
}

/** What the account holds of one asset, free and total. */
function walletCoin(wallet, asset) {
  const row = wallet?.list?.[0]?.coin?.find((candidate) => candidate.coin === asset);
  return {
    equity: Number(row?.equity ?? 0) || 0,
    walletBalance: Number(row?.walletBalance ?? 0) || 0,
  };
}

export async function bybitPlaceOrder(spec) {
  const info = await bybitInstrument(spec.category, spec.symbol);
  if (info.status !== 'Trading') throw new Error(`Bybit has ${info.symbol} on ${info.status}.`);
  const params = orderParams(spec, info);
  const placed = await signedRequest('POST', '/v5/order/create', params);

  /* A spot MARKET entry cannot carry its own protection — the venue attaches TP/SL to limit
   * entries only — so it is added the moment the fill is known. Reported as a failure of the
   * PROTECTION rather than of the order, because the position is already open either way and
   * the person has to know that before they do anything else. */
  const needsFollowUp = info.category === 'spot'
    && params.orderType === 'Market'
    && params.side === 'Buy'
    && !params.orderFilter
    && (spec.bracket?.stopLoss > 0 || spec.bracket?.takeProfit > 0);
  if (!needsFollowUp) return placed;

  try {
    const filled = await bybitFilledBase(info, placed?.orderId);
    const protection = spotProtectionParams(info, filled, spec.bracket);
    if (!protection) return placed;
    return { order: placed, protection: await signedRequest('POST', '/v5/order/create', protection) };
  } catch (err) {
    throw new Error(
      `The spot buy went in, but its protection was not placed: ${err instanceof Error ? err.message : String(err)} `
      + 'Check the holding before trying again.',
    );
  }
}

/**
 * How much base the order actually bought, fees already taken out.
 *
 * A spot buy is charged in the base asset by default, so the units that can be sold again are
 * fewer than the units that were bought — placing protection over the full fill would be
 * placing it over coins the account does not have.
 */
async function bybitFilledBase(info, orderId) {
  const result = await signedRequest('GET', '/v5/execution/list', {
    category: 'spot', symbol: info.symbol, orderId: String(orderId), limit: 50,
  });
  let quantity = 0;
  for (const row of result?.list ?? []) {
    quantity += Number(row.execQty) || 0;
    if (row.feeCurrency === info.baseAsset) quantity -= Number(row.execFee) || 0;
  }
  const snapped = floorToStep(quantity, info.stepSize);
  if (!(snapped > 0)) throw new Error('Bybit reported no filled quantity for the buy.');
  return snapped;
}

export function bybitCancelOrder({ category, symbol, orderId, orderFilter } = {}) {
  return signedRequest('POST', '/v5/order/cancel', {
    category: bybitCategory(category),
    symbol: String(symbol).toUpperCase(),
    orderId: String(orderId),
    ...(orderFilter ? { orderFilter } : {}),
  });
}

export async function bybitCancelAll(category, symbol) {
  const cat = bybitCategory(category);
  const sym = String(symbol).toUpperCase();
  try {
    return await signedRequest('POST', '/v5/order/cancel-all', { category: cat, symbol: sym });
  } catch (err) {
    // 110001: nothing was open to cancel, which is the state the caller wanted anyway.
    if (err?.code === 110001) return { list: [] };
    throw err;
  }
}

/**
 * Put a stop and a target on what is open, replacing whatever it had.
 *
 * Two different things behind one call, because the two products protect differently. A
 * perpetual's stop and target are attributes OF the position — one call sets both, and zero
 * removes one — so nothing has to be cancelled first and there is no window in which the
 * position stands unprotected. Spot has no position to hang them on: the old TP/SL order is
 * cancelled and a new one placed, and that window is real, so the failure says which half
 * happened.
 */
export async function bybitSetProtection(spec) {
  const info = await bybitInstrument(spec.category, spec.symbol);
  const stopLoss = Number(spec.stopLoss);
  const takeProfit = Number(spec.takeProfit);
  const hasStop = Number.isFinite(stopLoss) && stopLoss > 0;
  const hasTarget = Number.isFinite(takeProfit) && takeProfit > 0;

  if (info.category === 'linear') {
    return signedRequest('POST', '/v5/position/trading-stop', {
      category: 'linear',
      symbol: info.symbol,
      positionIdx: 0,
      tpslMode: 'Full',
      // "0" is the venue's own word for "take it off"; omitting the field leaves it as it was.
      stopLoss: hasStop ? decimal(stopLoss, info.tickSize, 'stop-loss') : '0',
      takeProfit: hasTarget ? decimal(takeProfit, info.tickSize, 'take-profit') : '0',
      ...(hasStop ? { slTriggerBy: 'LastPrice' } : {}),
      ...(hasTarget ? { tpTriggerBy: 'LastPrice' } : {}),
    });
  }

  for (const orderId of spec.orders ?? []) {
    await bybitCancelOrder({ category: 'spot', symbol: info.symbol, orderId, orderFilter: 'tpslOrder' })
      .catch((err) => {
        // 110001 / 170213: it had already gone — triggered, or cancelled by somebody else.
        if (err?.code !== 110001 && err?.code !== 170213) throw err;
      });
  }
  const protection = spotProtectionParams(info, spec.quantity, { stopLoss, takeProfit });
  if (!protection) return { cancelled: true, protection: null };
  try {
    return { cancelled: true, protection: await signedRequest('POST', '/v5/order/create', protection) };
  } catch (err) {
    throw new Error(
      `The old spot protection was cancelled, but its replacement was not placed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Close what is open at market, orders and all.
 *
 * The resting orders go first in both cases. On a perpetual they would otherwise reopen the
 * position they were meant to protect; on spot they hold the very units that are about to be
 * sold, and a sale of reserved coins is a refusal.
 */
export async function bybitClose(category, symbol) {
  const info = await bybitInstrument(category, symbol);
  await bybitCancelAll(info.category, info.symbol);

  if (info.category === 'linear') {
    const positions = await bybitPositions(info.symbol);
    const open = positions?.list?.find((row) => Number(row.size) > 0);
    if (!open) throw new Error(`There is no open ${info.symbol} position to close.`);
    const size = decimal(open.size, info.stepSize, 'position size');
    return signedRequest('POST', '/v5/order/create', {
      category: 'linear',
      symbol: info.symbol,
      side: open.side === 'Buy' ? 'Sell' : 'Buy',
      orderType: 'Market',
      qty: size,
      positionIdx: 0,
      reduceOnly: true,
      orderLinkId: clientId('close'),
    });
  }

  const wallet = await bybitWallet();
  const held = walletCoin(wallet, info.baseAsset);
  const quantity = floorToStep(held.walletBalance, info.stepSize);
  if (!(quantity >= info.minQty)) throw new Error(`There is no free ${info.baseAsset} balance to sell.`);
  return signedRequest('POST', '/v5/order/create', {
    category: 'spot',
    symbol: info.symbol,
    side: 'Sell',
    orderType: 'Market',
    qty: quantity.toFixed(decimalPlaces(info.stepSize)),
    marketUnit: 'baseCoin',
    orderLinkId: clientId('close'),
  });
}
