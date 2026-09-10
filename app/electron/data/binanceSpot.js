/* Binance Spot Demo trading.
 *
 * The endpoint is deliberately a constant. This module cannot be pointed at Binance's
 * production API by a setting, an environment variable, or a caller; the account wired into
 * Midorii here always trades demo funds.
 *
 * Credentials and signatures stay in Electron's main process. The renderer can ask for an
 * account or an order, but it cannot read either secret back.
 */
import { createHmac, randomBytes } from 'node:crypto';

export const BINANCE_SPOT_DEMO_BASE = 'https://demo-api.binance.com/api';
const RECV_WINDOW = 5_000;

let credentials = null;
let clockOffset = 0;
let clockReadAt = 0;
let clockSync = null;

export function configureBinanceSpot({ apiKey, secretKey } = {}) {
  credentials = apiKey && secretKey ? { apiKey: String(apiKey), secretKey: String(secretKey) } : null;
  clockReadAt = 0;
  clockOffset = 0;
}

export function binanceSpotConfigured() {
  return credentials != null;
}

export function binanceSpotEnvironment() {
  return { configured: binanceSpotConfigured(), env: 'demo', live: false };
}

export function hmacSignature(secretKey, payload) {
  return createHmac('sha256', secretKey).update(payload).digest('hex');
}

function clientId(prefix) {
  return `midorii_${prefix}_${Date.now().toString(36)}_${randomBytes(5).toString('hex')}`;
}

function requireCredentials(override) {
  const value = override ?? credentials;
  if (!value?.apiKey || !value?.secretKey) {
    throw new Error('Binance Spot Demo is not connected. Add its API key in Settings first.');
  }
  return value;
}

function appendParams(search, params) {
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value == null) continue;
    search.set(key, String(value));
  }
}

async function readJson(response, action) {
  const body = await response.json().catch(() => null);
  if (response.ok) return body;
  const code = Number(body?.code);
  const venueMessage = typeof body?.msg === 'string' ? body.msg : `HTTP ${response.status}`;
  const err = new Error(`Binance Spot Demo ${action} failed${Number.isFinite(code) ? ` (${code})` : ''}: ${venueMessage}`);
  err.code = Number.isFinite(code) ? code : null;
  err.status = response.status;
  throw err;
}

async function publicRequest(path, params = {}) {
  const url = new URL(`${BINANCE_SPOT_DEMO_BASE}${path}`);
  appendParams(url.searchParams, params);
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  return readJson(response, path);
}

async function syncClock() {
  if (clockSync) return clockSync;
  clockSync = (async () => {
    const result = await publicRequest('/v3/time');
    const serverTime = Number(result?.serverTime);
    if (!Number.isFinite(serverTime)) throw new Error('Binance Spot Demo returned no valid server time.');
    clockOffset = serverTime - Date.now();
    clockReadAt = Date.now();
  })();
  try {
    await clockSync;
  } finally {
    clockSync = null;
  }
}

async function signedRequest(method, path, params = {}, override = null, retriedClock = false) {
  const creds = requireCredentials(override);
  if (Date.now() - clockReadAt > 5 * 60_000) await syncClock();

  const search = new URLSearchParams();
  appendParams(search, params);
  search.set('recvWindow', String(RECV_WINDOW));
  search.set('timestamp', String(Date.now() + clockOffset));
  const payload = search.toString();
  search.set('signature', hmacSignature(creds.secretKey, payload));

  let response;
  try {
    response = await fetch(`${BINANCE_SPOT_DEMO_BASE}${path}?${search}`, {
      method,
      headers: { Accept: 'application/json', 'X-MBX-APIKEY': creds.apiKey },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (err) {
    if (method !== 'GET') {
      throw new Error(
        'Binance Spot Demo did not confirm what became of the instruction. Check the open orders and balance before sending it again.',
      );
    }
    throw err;
  }
  try {
    return await readJson(response, path);
  } catch (err) {
    if (err?.code === -1021 && !retriedClock) {
      await syncClock();
      return signedRequest(method, path, params, override, true);
    }
    if (method !== 'GET' && (err?.code === -1007 || Number(err?.status) >= 500)) {
      throw new Error(
        'Binance Spot Demo did not confirm what became of the instruction. Check the open orders and balance before sending it again.',
      );
    }
    throw err;
  }
}

export async function binanceSpotProbe(candidate) {
  await syncClock();
  const account = await signedRequest('GET', '/v3/account', { omitZeroBalances: true }, candidate);
  if (account?.canTrade !== true || !Array.isArray(account?.permissions) || !account.permissions.includes('SPOT')) {
    throw new Error('This Binance Demo key cannot trade Spot. Enable Spot trading for the key and try again.');
  }
  return account;
}

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

function decimal(value, step) {
  const snapped = floorToStep(value, step);
  if (!(snapped > 0)) throw new Error('The order is smaller than this Spot market allows.');
  return snapped.toFixed(decimalPlaces(step));
}

function filterOf(symbol, type) {
  return symbol.filters?.find((filter) => filter.filterType === type) ?? null;
}

export function parseBinanceSpotSymbol(payload, wanted) {
  const row = payload?.symbols?.find((candidate) => candidate.symbol === wanted) ?? payload?.symbols?.[0];
  if (!row) throw new Error(`Binance Spot Demo does not list ${wanted}.`);
  const price = filterOf(row, 'PRICE_FILTER');
  const lot = filterOf(row, 'LOT_SIZE');
  const marketLot = filterOf(row, 'MARKET_LOT_SIZE');
  const notional = filterOf(row, 'NOTIONAL') ?? filterOf(row, 'MIN_NOTIONAL');
  if (!price || !lot) throw new Error(`Binance Spot Demo returned incomplete rules for ${wanted}.`);
  const marketStep = Number(marketLot?.stepSize);
  const marketMin = Number(marketLot?.minQty);
  const marketMax = Number(marketLot?.maxQty);
  return {
    symbol: row.symbol,
    status: row.status,
    baseAsset: row.baseAsset,
    quoteAsset: row.quoteAsset,
    tickSize: Number(price.tickSize),
    stepSize: Number(lot.stepSize),
    minQty: Number(lot.minQty),
    maxQty: Number(lot.maxQty),
    marketStepSize: marketStep > 0 ? marketStep : Number(lot.stepSize),
    marketMinQty: marketMin > 0 ? marketMin : Number(lot.minQty),
    marketMaxQty: marketMax > 0 ? marketMax : Number(lot.maxQty),
    minNotional: Number(notional?.minNotional ?? 0),
    orderTypes: Array.isArray(row.orderTypes) ? row.orderTypes : [],
    ocoAllowed: row.ocoAllowed === true,
    otoAllowed: row.otoAllowed === true,
  };
}

export async function binanceSpotSymbolInfo(symbol) {
  const sym = String(symbol).toUpperCase();
  return parseBinanceSpotSymbol(await publicRequest('/v3/exchangeInfo', { symbol: sym }), sym);
}

export function binanceSpotAccount() {
  return signedRequest('GET', '/v3/account', { omitZeroBalances: true });
}

export function binanceSpotOpenOrders(symbol) {
  return signedRequest('GET', '/v3/openOrders', { symbol: String(symbol).toUpperCase() });
}

export function binanceSpotTrades(symbol) {
  return signedRequest('GET', '/v3/myTrades', { symbol: String(symbol).toUpperCase(), limit: 500 });
}

function normalOrderParams(spec, info) {
  const type = String(spec.type ?? 'MARKET').toUpperCase();
  const step = type === 'MARKET' ? info.marketStepSize : info.stepSize;
  const quantity = decimal(spec.quantity, step);
  const side = String(spec.side).toUpperCase();
  const common = { symbol: info.symbol, side, type, quantity, newClientOrderId: clientId('order') };
  if (type === 'LIMIT') {
    return { ...common, timeInForce: 'GTC', price: decimal(spec.price, info.tickSize), newOrderRespType: 'FULL' };
  }
  if (type === 'STOP_LOSS') {
    return { ...common, stopPrice: decimal(spec.stopPrice, info.tickSize), newOrderRespType: 'FULL' };
  }
  if (type !== 'MARKET') throw new Error(`Unsupported Binance Spot order type: ${type}`);
  return { ...common, newOrderRespType: 'FULL' };
}

function protectionParams(symbol, quantity, info, bracket, prefix = '') {
  const stop = bracket?.stopLoss;
  const target = bracket?.takeProfit;
  if (!(stop > 0) && !(target > 0)) return null;
  const qty = decimal(quantity, info.stepSize);
  if (stop > 0 && target > 0) {
    return {
      path: '/v3/orderList/oco',
      params: {
        symbol, side: 'SELL', quantity: qty, listClientOrderId: clientId(`${prefix}oco`),
        aboveType: 'TAKE_PROFIT', aboveStopPrice: decimal(target, info.tickSize),
        belowType: 'STOP_LOSS', belowStopPrice: decimal(stop, info.tickSize),
        newOrderRespType: 'RESULT',
      },
    };
  }
  return {
    path: '/v3/order',
    params: {
      symbol, side: 'SELL', quantity: qty,
      type: stop > 0 ? 'STOP_LOSS' : 'TAKE_PROFIT',
      stopPrice: decimal(stop > 0 ? stop : target, info.tickSize),
      newClientOrderId: clientId(`${prefix}protect`), newOrderRespType: 'RESULT',
    },
  };
}

function pendingProtection(bracket, info) {
  const stop = bracket?.stopLoss;
  const target = bracket?.takeProfit;
  if (!(stop > 0) && !(target > 0)) return null;
  if (stop > 0 && target > 0) {
    return {
      pendingAboveType: 'TAKE_PROFIT', pendingAboveStopPrice: decimal(target, info.tickSize),
      pendingBelowType: 'STOP_LOSS', pendingBelowStopPrice: decimal(stop, info.tickSize),
    };
  }
  return {
    pendingType: stop > 0 ? 'STOP_LOSS' : 'TAKE_PROFIT',
    pendingStopPrice: decimal(stop > 0 ? stop : target, info.tickSize),
  };
}

export async function binanceSpotPlaceOrder(spec) {
  const info = await binanceSpotSymbolInfo(spec.symbol);
  if (info.status !== 'TRADING') throw new Error(`Binance Spot Demo has ${info.symbol} on ${info.status}.`);
  const order = normalOrderParams(spec, info);
  const bracket = pendingProtection(spec.bracket, info);
  if (!bracket) return signedRequest('POST', '/v3/order', order);
  if (order.side !== 'BUY') throw new Error('Spot sell orders cannot open a short or carry buy-side protection.');
  if (order.type === 'STOP_LOSS') {
    throw new Error('A Spot stop-entry cannot carry atomic protection. Place it first, then add protection after it fills.');
  }
  if (order.type === 'LIMIT') {
    if (!info.otoAllowed) throw new Error(`${info.symbol} does not allow linked Spot orders.`);
    const both = spec.bracket?.stopLoss > 0 && spec.bracket?.takeProfit > 0;
    return signedRequest('POST', both ? '/v3/orderList/opoco' : '/v3/orderList/opo', {
      symbol: info.symbol,
      listClientOrderId: clientId(both ? 'opoco' : 'opo'),
      workingType: 'LIMIT', workingSide: 'BUY', workingPrice: order.price,
      workingQuantity: order.quantity, workingTimeInForce: 'GTC',
      pendingSide: 'SELL', ...bracket, newOrderRespType: 'RESULT',
    });
  }

  const fill = await signedRequest('POST', '/v3/order', order);
  const executed = Number(fill?.executedQty ?? 0);
  const baseFees = Array.isArray(fill?.fills)
    ? fill.fills.reduce((sum, row) => sum + (row.commissionAsset === info.baseAsset ? Number(row.commission) || 0 : 0), 0)
    : 0;
  const quantity = floorToStep(executed - baseFees, info.stepSize);
  try {
    const protection = protectionParams(info.symbol, quantity, info, spec.bracket, 'filled_');
    if (!protection) return fill;
    const linked = await signedRequest('POST', protection.path, protection.params);
    return { order: fill, protection: linked };
  } catch (err) {
    throw new Error(
      `The demo buy filled, but its protection was not placed: ${err instanceof Error ? err.message : String(err)} Check the balance before trying again.`,
    );
  }
}

export function binanceSpotCancelOrder(symbol, orderId) {
  return signedRequest('DELETE', '/v3/order', { symbol: String(symbol).toUpperCase(), orderId });
}

export async function binanceSpotCancelAll(symbol) {
  try {
    return await signedRequest('DELETE', '/v3/openOrders', { symbol: String(symbol).toUpperCase() });
  } catch (err) {
    // Spot Demo reports -2011 when the symbol already has no open orders.
    if (err?.code === -2011) return [];
    throw err;
  }
}

async function cancelProtection(symbol, orders) {
  const lists = new Set();
  const singles = [];
  for (const row of orders ?? []) {
    const listId = Number(row?.orderListId);
    if (Number.isFinite(listId) && listId >= 0) lists.add(listId);
    else if (Number.isFinite(Number(row?.orderId))) singles.push(Number(row.orderId));
  }
  for (const orderListId of lists) {
    await signedRequest('DELETE', '/v3/orderList', { symbol, orderListId }).catch((err) => {
      if (err?.code !== -2011) throw err;
    });
  }
  for (const orderId of singles) {
    await binanceSpotCancelOrder(symbol, orderId).catch((err) => {
      if (err?.code !== -2011) throw err;
    });
  }
}

export async function binanceSpotReplaceProtection(spec) {
  const symbol = String(spec.symbol).toUpperCase();
  const info = await binanceSpotSymbolInfo(symbol);
  await cancelProtection(symbol, spec.orders);
  const protection = protectionParams(symbol, spec.quantity, info, spec, 'replace_');
  if (!protection) return { cancelled: true, protection: null };
  try {
    return { cancelled: true, protection: await signedRequest('POST', protection.path, protection.params) };
  } catch (err) {
    throw new Error(
      `The old Spot protection was cancelled, but its replacement was not placed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function binanceSpotClose(symbol) {
  const info = await binanceSpotSymbolInfo(symbol);
  await binanceSpotCancelAll(info.symbol);
  const account = await binanceSpotAccount();
  const balance = account?.balances?.find((row) => row.asset === info.baseAsset);
  const quantity = floorToStep(Number(balance?.free ?? 0), info.marketStepSize);
  if (!(quantity >= info.marketMinQty)) throw new Error(`There is no free ${info.baseAsset} balance to sell.`);
  return signedRequest('POST', '/v3/order', normalOrderParams({ symbol: info.symbol, side: 'SELL', type: 'MARKET', quantity }, info));
}
