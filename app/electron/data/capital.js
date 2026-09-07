/* Capital.com session + WebSocket relay, built from scratch on their public REST +
 * WebSocket API (https://open-api.capital.com/) — no SDK.
 *
 * Runs entirely in the MAIN process, on purpose: Capital.com's login response carries
 * the session tokens (`CST`, `X-SECURITY-TOKEN`) in RESPONSE HEADERS, and their API
 * does not send `Access-Control-Expose-Headers` — a browser `fetch` in the renderer
 * would see the login succeed but be unable to read those headers at all. Node's
 * `fetch` has no such restriction, so the whole session (login, keepalive, historical
 * prices, the live OHLC stream) lives here; the renderer only ever sees bars.
 *
 * One account per app instance — the same "one shared feed" shape BarStore already
 * uses for the in-renderer providers.
 */
const DEMO_BASE = 'https://demo-api-capital.backend-capital.com/api/v1';
const LIVE_BASE = 'https://api-capital.backend-capital.com/api/v1';
const STREAM_URL = 'wss://api-streaming-capital.backend-capital.com/connect';

/** Both the REST and WS session expire 10 minutes after their last use; re-login
 *  this far before that so a slow request never lands on an already-dead session. */
const SESSION_MARGIN_MS = 5 * 60_000;
/** Keep the WS's underlying session alive while a subscription is open. */
const WS_PING_MS = 5 * 60_000;
/** Reconnect backoff after an unexpected WebSocket close. */
const WS_RECONNECT_MS = 2_000;

let creds = null; // { apiKey, identifier, password, env: 'demo' | 'live' }
let cst = null;
let securityToken = null;
let lastUsedAt = 0;
let loginPromise = null;

let ws = null;
let wsConnectPromise = null;
let wsPingTimer = null;
let wsReconnectTimer = null;
let correlationId = 0;
/** `${epic}:${resolution}` → subscriber count, so two panes on the same instrument
 *  share ONE of the 40 WS subscription slots Capital.com allows. */
const subs = new Map();
/** `${epic}:${resolution}` → Set<callback>, delivered every `ohlc.event`. */
const subscribers = new Map();

export function configureCapital(next) {
  creds = next && next.apiKey && next.identifier && next.password
    ? { apiKey: next.apiKey, identifier: next.identifier, password: next.password, env: next.env === 'live' ? 'live' : 'demo' }
    : null;
  cst = null;
  securityToken = null;
}

export function capitalConfigured() {
  return !!creds;
}

function baseUrl() {
  return creds?.env === 'live' ? LIVE_BASE : DEMO_BASE;
}

async function login() {
  const res = await fetch(`${baseUrl()}/session`, {
    method: 'POST',
    headers: { 'X-CAP-API-KEY': creds.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: creds.identifier, password: creds.password }),
  });
  const cstHeader = res.headers.get('cst');
  const tokenHeader = res.headers.get('x-security-token');
  if (!res.ok || !cstHeader || !tokenHeader) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.errorCode || `Capital.com login failed (HTTP ${res.status})`);
  }
  cst = cstHeader;
  securityToken = tokenHeader;
  lastUsedAt = Date.now();
}

async function ensureSession() {
  if (!creds) throw new Error('Capital.com is not configured — set CAPITAL_API_KEY, CAPITAL_IDENTIFIER and CAPITAL_PASSWORD in .env.local');
  if (cst && securityToken && Date.now() - lastUsedAt < SESSION_MARGIN_MS) return;
  if (!loginPromise) loginPromise = login().finally(() => { loginPromise = null; });
  return loginPromise;
}

/** An authenticated REST call, retried once after a fresh login on a 401 — the
 *  session can die between calls (the app was asleep past the 10-minute window). */
async function authedFetch(pathAndQuery) {
  await ensureSession();
  const attempt = () => fetch(`${baseUrl()}${pathAndQuery}`, { headers: { CST: cst, 'X-SECURITY-TOKEN': securityToken } });
  let res = await attempt();
  if (res.status === 401) {
    cst = null;
    securityToken = null;
    await ensureSession();
    res = await attempt();
  }
  if (res.ok) lastUsedAt = Date.now();
  return res;
}

/** The full instrument list Capital.com serves (`GET /markets`, no query), or a
 *  filtered subset by name/epic (`searchTerm`). */
export async function capitalMarkets(searchTerm) {
  const query = searchTerm ? `?searchTerm=${encodeURIComponent(searchTerm)}` : '';
  const res = await authedFetch(`/markets${query}`);
  if (!res.ok) throw new Error(`Capital.com /markets HTTP ${res.status}`);
  const data = await res.json();
  return data.markets ?? [];
}

export async function capitalMarketInfo(epic) {
  const res = await authedFetch(`/markets/${encodeURIComponent(epic)}`);
  if (!res.ok) return null;
  return res.json();
}

/** `YYYY-MM-DDTHH:MM:SS` in UTC, no offset — the format `/prices` filters on
 *  (against `snapshotTimeUTC`). */
function isoNoZ(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '');
}

/** One `/prices` page — `max` is capped at 1000 by the API. */
async function pricesPage(epic, resolution, { from, to, max }) {
  const params = new URLSearchParams({ resolution });
  if (max != null) params.set('max', String(Math.min(max, 1000)));
  if (from != null) params.set('from', isoNoZ(from));
  if (to != null) params.set('to', isoNoZ(to));
  const res = await authedFetch(`/prices/${encodeURIComponent(epic)}?${params}`);
  if (!res.ok) throw new Error(`Capital.com /prices HTTP ${res.status}`);
  const data = await res.json();
  return data.prices ?? [];
}

/** Bid-price OHLCV — the convention MT4/MT5-style CFD charts chart by. */
function rowToBar(row) {
  return {
    time: Date.parse(`${row.snapshotTimeUTC}Z`),
    open: row.openPrice?.bid,
    high: row.highPrice?.bid,
    low: row.lowPrice?.bid,
    close: row.closePrice?.bid,
    volume: row.lastTradedVolume ?? 0,
  };
}

/** Historical bars for `epic`/`resolution`, paginating backward past the 1000-row
 *  cap when `limit` asks for more (mirrors the bundled providers' own pagination). */
export async function capitalPrices(epic, resolution, { from, to, limit } = {}) {
  if (from != null) {
    // Ranged fetch: page FORWARD from `from` to `to` (tail re-fetches, deep backfills).
    const out = [];
    let cursor = from;
    const end = to ?? Date.now();
    for (let guard = 0; cursor < end && guard < 500; guard++) {
      const page = await pricesPage(epic, resolution, { from: cursor, to: end, max: 1000 });
      if (page.length === 0) break;
      out.push(...page);
      const lastTime = Date.parse(`${page[page.length - 1].snapshotTimeUTC}Z`);
      if (!(lastTime > cursor)) break; // no forward progress — stop rather than loop forever
      cursor = lastTime + 1;
      if (page.length < 1000) break;
    }
    return out.map(rowToBar);
  }

  // Unbounded: the most recent `limit` bars (default page size otherwise).
  const want = limit ?? 500;
  if (want <= 1000) return (await pricesPage(epic, resolution, { to, max: want })).map(rowToBar);
  let out = [];
  let remaining = want;
  let cursor = to;
  for (let guard = Math.ceil(want / 1000) + 5; remaining > 0 && guard-- > 0; ) {
    const page = await pricesPage(epic, resolution, { to: cursor, max: Math.min(remaining, 1000) });
    if (page.length === 0) break;
    out = page.concat(out);
    remaining -= page.length;
    const earliest = Date.parse(`${page[0].snapshotTimeUTC}Z`);
    cursor = earliest - 1;
    if (page.length < 1000) break;
  }
  return out.map(rowToBar);
}

// ── Live OHLC stream ────────────────────────────────────────────────────────

function sendWs(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function nextCorrelationId() {
  correlationId += 1;
  return String(correlationId);
}

async function ensureStream() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (wsConnectPromise) return wsConnectPromise;
  wsConnectPromise = (async () => {
    await ensureSession();
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(STREAM_URL);
      let settled = false;
      socket.onopen = () => {
        settled = true;
        ws = socket;
        wsPingTimer = setInterval(() => sendWs({ destination: 'ping', correlationId: nextCorrelationId(), cst, securityToken }), WS_PING_MS);
        // Re-subscribe every active instrument — a fresh socket remembers nothing.
        for (const key of subs.keys()) {
          const [epic, resolution] = key.split(':');
          sendWs({ destination: 'OHLCMarketData.subscribe', correlationId: nextCorrelationId(), cst, securityToken, payload: { epics: [epic], resolutions: [resolution], type: 'classic' } });
        }
        resolve();
      };
      socket.onmessage = (ev) => handleWsMessage(ev.data);
      socket.onerror = () => { try { socket.close(); } catch { /* onclose follows */ } };
      socket.onclose = () => {
        ws = null;
        if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
        if (!settled) reject(new Error('Capital.com stream closed before it opened'));
        if (subs.size > 0) wsReconnectTimer = setTimeout(() => { void ensureStream(); }, WS_RECONNECT_MS);
      };
    });
  })().finally(() => { wsConnectPromise = null; });
  return wsConnectPromise;
}

function handleWsMessage(raw) {
  let msg;
  try { msg = JSON.parse(typeof raw === 'string' ? raw : ''); } catch { return; }
  if (msg.destination !== 'ohlc.event' || !msg.payload) return;
  const p = msg.payload;
  const key = `${p.epic}:${p.resolution}`;
  const bar = { time: p.t, open: p.o, high: p.h, low: p.l, close: p.c };
  for (const cb of subscribers.get(key) ?? []) cb(bar);
}

/** Subscribe `cb` to live OHLC updates for `epic`/`resolution`. Returns an
 *  unsubscribe that drops the WS subscription once nothing else needs it. */
export async function capitalSubscribe(epic, resolution, cb) {
  const key = `${epic}:${resolution}`;
  if (!subscribers.has(key)) subscribers.set(key, new Set());
  subscribers.get(key).add(cb);
  const count = subs.get(key) ?? 0;
  subs.set(key, count + 1);

  await ensureStream();
  if (count === 0) sendWs({ destination: 'OHLCMarketData.subscribe', correlationId: nextCorrelationId(), cst, securityToken, payload: { epics: [epic], resolutions: [resolution], type: 'classic' } });

  return () => {
    subscribers.get(key)?.delete(cb);
    const left = (subs.get(key) ?? 1) - 1;
    if (left <= 0) {
      subs.delete(key);
      subscribers.delete(key);
      sendWs({ destination: 'OHLCMarketData.unsubscribe', correlationId: nextCorrelationId(), cst, securityToken, payload: { epics: [epic], resolutions: [resolution] } });
      if (subs.size === 0 && wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    } else {
      subs.set(key, left);
    }
  };
}
