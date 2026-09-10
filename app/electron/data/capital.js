/* Capital.com session + WebSocket relay, built from scratch on their public REST +
 * WebSocket API (https://open-api.capital.com/) — no SDK.
 *
 * Runs entirely in the MAIN process, on purpose: Capital.com's login response carries
 * the session tokens (`CST`, `X-SECURITY-TOKEN`) in RESPONSE HEADERS, and their API
 * does not send `Access-Control-Expose-Headers` — a browser `fetch` in the renderer
 * would see the login succeed but be unable to read those headers at all. Node's
 * `fetch` has no such restriction, so the whole session (login, keepalive, historical
 * prices, the live OHLC stream, the bid/ask quote stream) lives here; the renderer
 * only ever sees bars and quotes.
 *
 * One account per app instance — the same "one shared feed" shape BarStore already
 * uses for the in-renderer providers.
 */
import { appendFileSync } from 'node:fs';

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

/**
 * A record of what actually crossed the wire — off unless `MIDORII_CAPITAL_LOG` names a
 * file to append to.
 *
 * A debugging aid rather than a feature, and one that has to be asked for by name. What it
 * must never contain is the things that open the account: the API key, the custom password,
 * and the two session tokens. So it is handed the method, the path, the status and the
 * payloads that are the app's OWN — an order's size and levels, the venue's verdict on it —
 * and is never handed a header.
 */
function wire(event, detail) {
  const file = process.env.MIDORII_CAPITAL_LOG;
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`);
  } catch {
    /* A log that cannot be written is not a reason to fail a trade. */
  }
}

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
/**
 * `epic` → Set<callback>, delivered every `quote` event.
 *
 * The tick stream, alongside the candle stream and deliberately separate from it: a
 * candle is what the market DID, a quote is what it costs to trade right now, and the
 * two arrive on different destinations at different rates. One map rather than the
 * count/callback pair above because the set's own size is the count — nothing else
 * about a quote subscription needs remembering.
 */
const quoteSubscribers = new Map();
/**
 * What the CURRENT socket has already been asked for, as `ohlc:${key}` / `quote:${epic}`.
 *
 * A subscription lives in two places that can disagree: `subs`/`quoteSubscribers` are what
 * the app wants, this is what the socket has been told. They come apart during a connect —
 * a caller adds its key and then awaits the socket, whose own `onopen` re-subscribes
 * everything it finds, that key included — and with no record of what was sent, the caller
 * then asks for the same feed a second time. Emptied whenever the socket goes, because a
 * fresh one remembers nothing.
 */
const streamed = new Set();

export function configureCapital(next) {
  creds = next && next.apiKey && next.identifier && next.password
    ? { apiKey: next.apiKey, identifier: next.identifier, password: next.password, env: next.env === 'live' ? 'live' : 'demo' }
    : null;
  cst = null;
  securityToken = null;
  /* The socket cannot outlive the credentials it was opened under: it is bound to that
   * session, and after a switch from demo to live it would be streaming the wrong account
   * entirely. The subscriptions themselves stay — `onclose` reopens the socket while
   * anything is still listening, under whichever account is configured by then. */
  if (ws) { try { ws.close(); } catch { /* onclose does the rest */ } }
}

export function capitalConfigured() {
  return !!creds;
}

/**
 * Which account the credentials point at, for a screen that has to SAY so.
 *
 * The difference between demo and live is one word in a file nobody looks at twice, and it is
 * the difference between a mistake that costs nothing and one that costs money. So it is
 * reported rather than assumed: anything that can place an order has to be able to show which
 * of the two it is wired to.
 */
export function capitalEnvironment() {
  return { configured: !!creds, env: creds?.env ?? null, live: creds?.env === 'live' };
}

function baseUrl() {
  return creds?.env === 'live' ? LIVE_BASE : DEMO_BASE;
}

/**
 * What a refused login actually means, in words that say what to do about it.
 *
 * The venue answers with a code and nothing else, and the codes are the same whether the
 * credentials are being typed in or were stored months ago — so both paths read them here
 * rather than each inventing its own wording. A code with no entry is passed through whole:
 * an unrecognised refusal is exactly the one worth reading verbatim.
 */
async function sessionFailure(res, env) {
  const body = await res.json().catch(() => null);
  const code = body?.errorCode ?? null;
  const where = env === 'live' ? 'live' : 'demo';
  const known = {
    'error.invalid.details':
      'Capital.com refused these details. The password here is the "Custom password" set when the '
      + 'API key was created — not the account login password.',
    'error.invalid.api.key':
      `Capital.com did not recognise this API key on the ${where} endpoint. Check it was copied whole, `
      + `and that it is a key from the ${where} side of the platform.`,
    'error.null.accountId':
      `Capital.com accepted the key and the password but did not attach the session to a ${where} `
      + 'trading account (error.null.accountId). That is the state of the account rather than a wrong '
      + `password: open the platform, switch to the ${where === 'live' ? 'Live' : 'Demo'} account so that it `
      + 'exists, and generate the API key again from there if it still refuses.',
    'error.too-many.requests':
      'Capital.com is turning logins away for the moment — it allows one per second, and counts the '
      + 'failed ones. Wait a few seconds before trying again.',
  }[code];
  if (known) return new Error(known);
  return new Error(code
    ? `Capital.com refused the connection (${code}).`
    : `Capital.com refused the connection (HTTP ${res.status}).`);
}

async function login() {
  const res = await fetch(`${baseUrl()}/session`, {
    method: 'POST',
    headers: { 'X-CAP-API-KEY': creds.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: creds.identifier, password: creds.password }),
  });
  const cstHeader = res.headers.get('cst');
  const tokenHeader = res.headers.get('x-security-token');
  wire('session', { env: creds.env, status: res.status, tokens: !!(cstHeader && tokenHeader) });
  if (!res.ok) throw await sessionFailure(res, creds.env);
  if (!cstHeader || !tokenHeader) throw new Error('Capital.com accepted the login but sent no session tokens.');
  cst = cstHeader;
  securityToken = tokenHeader;
  lastUsedAt = Date.now();
}

async function ensureSession() {
  if (!creds) throw new Error('Capital.com is not connected — add the account under Settings → Broker connection.');
  if (cst && securityToken && Date.now() - lastUsedAt < SESSION_MARGIN_MS) return;
  if (!loginPromise) loginPromise = login().finally(() => { loginPromise = null; });
  return loginPromise;
}

/**
 * An authenticated REST call, retried once after a fresh login on a 401 — the session can
 * die between calls (the app was asleep past the 10-minute window).
 *
 * The retry is safe for a WRITE as well as a read, and only because of what a 401 means: the
 * server rejected the request before doing anything with it, so nothing was placed and
 * sending it again cannot place it twice. No other failure is retried here for exactly that
 * reason — a timed-out `POST /positions` may well have opened a position, and asking again
 * would be the second one.
 */
async function authedFetch(pathAndQuery, { method = 'GET', body } = {}) {
  const startedAt = Date.now();
  await ensureSession();
  const attempt = () => fetch(`${baseUrl()}${pathAndQuery}`, {
    method,
    headers: {
      CST: cst,
      'X-SECURITY-TOKEN': securityToken,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let res = await attempt();
  if (res.status === 401) {
    cst = null;
    securityToken = null;
    await ensureSession();
    res = await attempt();
  }
  if (res.ok) lastUsedAt = Date.now();
  wire('rest', { method, path: pathAndQuery, status: res.status, ms: Date.now() - startedAt, ...(body !== undefined ? { body } : {}) });
  return res;
}

/** The venue's own words for a refusal, or the bare status when it does not give any. */
async function failureOf(res, what) {
  const body = await res.json().catch(() => null);
  return new Error(body?.errorCode || `Capital.com ${what} HTTP ${res.status}`);
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

/** Send on the socket, saying whether it actually went — a subscription that never left
 *  must not be recorded as one that did. */
function sendWs(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  // The tokens ride along in every message and are deliberately not part of the record.
  wire('ws.out', { destination: message.destination, payload: message.payload ?? null });
  return true;
}

function nextCorrelationId() {
  correlationId += 1;
  return String(correlationId);
}

/** Ask the socket for one candle feed, and only once. */
function streamOhlc(key) {
  if (streamed.has(`ohlc:${key}`)) return;
  const [epic, resolution] = key.split(':');
  const sent = sendWs({ destination: 'OHLCMarketData.subscribe', correlationId: nextCorrelationId(), cst, securityToken, payload: { epics: [epic], resolutions: [resolution], type: 'classic' } });
  if (sent) streamed.add(`ohlc:${key}`);
}

/** Ask the socket for one tick feed, and only once. */
function streamQuotes(epic) {
  if (streamed.has(`quote:${epic}`)) return;
  const sent = sendWs({ destination: 'marketData.subscribe', correlationId: nextCorrelationId(), cst, securityToken, payload: { epics: [epic] } });
  if (sent) streamed.add(`quote:${epic}`);
}

/** Nothing is listening on either stream any more ⇒ stop trying to get the socket back.
 *  Both kinds of subscription keep it alive, so both have to be gone. */
function stopReconnectingIfIdle() {
  if (subs.size === 0 && quoteSubscribers.size === 0 && wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
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
        streamed.clear();
        wsPingTimer = setInterval(() => sendWs({ destination: 'ping', correlationId: nextCorrelationId(), cst, securityToken }), WS_PING_MS);
        // Re-subscribe every active instrument — a fresh socket remembers nothing.
        for (const key of subs.keys()) streamOhlc(key);
        for (const epic of quoteSubscribers.keys()) streamQuotes(epic);
        resolve();
      };
      socket.onmessage = (ev) => handleWsMessage(ev.data);
      socket.onerror = () => { try { socket.close(); } catch { /* onclose follows */ } };
      socket.onclose = () => {
        ws = null;
        streamed.clear();
        if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
        if (!settled) reject(new Error('Capital.com stream closed before it opened'));
        if (subs.size > 0 || quoteSubscribers.size > 0) {
          /* Reported rather than thrown into nothing: reopening runs on a timer with no
           * caller left to reject to, so a login that now fails — the credentials were
           * replaced or cleared — would otherwise surface as an unhandled rejection. */
          wsReconnectTimer = setTimeout(() => {
            ensureStream().catch((e) => console.warn(`[midorii] Capital.com stream could not be reopened — ${e instanceof Error ? e.message : String(e)}`));
          }, WS_RECONNECT_MS);
        }
      };
    });
  })().finally(() => { wsConnectPromise = null; });
  return wsConnectPromise;
}

function handleWsMessage(raw) {
  let msg;
  try { msg = JSON.parse(typeof raw === 'string' ? raw : ''); } catch { return; }
  /* Recorded before the payload check below, and before the two high-rate destinations are
   * dealt with: a subscription the venue REFUSED arrives here as a status this function
   * otherwise drops on the floor, and that is exactly the message worth having kept. Ticks
   * and candles are left out — they arrive several a second and say nothing about a trade. */
  if (msg.destination !== 'ohlc.event' && msg.destination !== 'quote') {
    wire('ws.in', { destination: msg.destination ?? null, status: msg.status ?? null, payload: msg.payload ?? null });
  }
  if (!msg.payload) return;

  if (msg.destination === 'ohlc.event') {
    const p = msg.payload;
    const key = `${p.epic}:${p.resolution}`;
    const bar = { time: p.t, open: p.o, high: p.h, low: p.l, close: p.c };
    for (const cb of subscribers.get(key) ?? []) cb(bar);
    return;
  }

  /* `ofr` is Capital.com's name for the ask. Renamed on the way through: every other
   * price in this app is named the way a trader says it, and nothing downstream should
   * have to know which vendor's abbreviation this arrived under. */
  if (msg.destination === 'quote') {
    const p = msg.payload;
    if (typeof p.bid !== 'number' || typeof p.ofr !== 'number') return;
    const quote = { epic: p.epic, bid: p.bid, ask: p.ofr, bidSize: p.bidQty ?? null, askSize: p.ofrQty ?? null, time: p.timestamp };
    for (const cb of quoteSubscribers.get(p.epic) ?? []) cb(quote);
  }
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
  streamOhlc(key);

  return () => {
    subscribers.get(key)?.delete(cb);
    const left = (subs.get(key) ?? 1) - 1;
    if (left <= 0) {
      subs.delete(key);
      subscribers.delete(key);
      streamed.delete(`ohlc:${key}`);
      sendWs({ destination: 'OHLCMarketData.unsubscribe', correlationId: nextCorrelationId(), cst, securityToken, payload: { epics: [epic], resolutions: [resolution] } });
      stopReconnectingIfIdle();
    } else {
      subs.set(key, left);
    }
  };
}

/**
 * Subscribe `cb` to live bid/ask quotes for `epic`. Returns an unsubscribe that drops
 * the WS subscription once nothing else needs it.
 *
 * The candle stream and this one share the socket and the session; they do not share a
 * subscription. An account that is only reading the spread does not need candles, and a
 * chart that is only drawing candles must not pay for a tick stream it never reads.
 */
export async function capitalSubscribeQuotes(epic, cb) {
  const first = !quoteSubscribers.has(epic);
  if (first) quoteSubscribers.set(epic, new Set());
  quoteSubscribers.get(epic).add(cb);

  await ensureStream();
  streamQuotes(epic);

  return () => {
    const listeners = quoteSubscribers.get(epic);
    if (!listeners) return;
    listeners.delete(cb);
    if (listeners.size > 0) return;
    quoteSubscribers.delete(epic);
    streamed.delete(`quote:${epic}`);
    sendWs({ destination: 'marketData.unsubscribe', correlationId: nextCorrelationId(), cst, securityToken, payload: { epics: [epic] } });
    stopReconnectingIfIdle();
  };
}

// ── Trading ─────────────────────────────────────────────────────────────────
//
// Every order here is TWO steps, and conflating them is the mistake this section
// exists to prevent. `POST /positions` answers with a `dealReference` and nothing
// else: it means the venue took delivery of the instruction, not that a position
// exists. What actually happened — filled, at what price, or refused and why — only
// `GET /confirms/{dealReference}` says. A caller that treats the first answer as the
// outcome is a caller that will report a rejected order as an open trade.

/** The venue accepts one position-changing request per 100ms; the rest of the API allows
 *  ten a second. Orders are queued through one gate so a fast hand cannot trip it. */
const ORDER_INTERVAL_MS = 120;
let orderGate = Promise.resolve();
let lastOrderAt = 0;

/** Run `task` no sooner than {@link ORDER_INTERVAL_MS} after the previous one. Serialised
 *  rather than merely delayed: two orders sent at once must not race into one window. */
function throughOrderGate(task) {
  const queued = orderGate.then(async () => {
    const wait = lastOrderAt + ORDER_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastOrderAt = Date.now();
    return task();
  });
  // The gate must not stay broken after one failed order, so it forgets the rejection —
  // the caller still receives it, through `queued`.
  orderGate = queued.then(() => undefined, () => undefined);
  return queued;
}

/**
 * What a `/confirms` answer means, in the terms a caller acts on.
 *
 * `dealStatus` is the venue's verdict on the instruction and is the only field that says
 * whether anything happened; `status` describes the position that resulted, and is absent on
 * a refusal. A missing `dealStatus` is treated as a refusal rather than a success — an answer
 * that does not say it was accepted is not one to open a position on.
 */
export function readConfirmation(json) {
  const accepted = json?.dealStatus === 'ACCEPTED';
  return {
    accepted,
    dealId: json?.dealId ?? null,
    dealReference: json?.dealReference ?? null,
    /** `OPEN`, `CLOSED`, `AMENDED`, … — what became of the position. Null on a refusal. */
    status: json?.status ?? null,
    /** The venue's own word for why not: `INSUFFICIENT_FUNDS`, `MARKET_CLOSED`, … */
    reason: accepted ? null : (json?.rejectReason ?? json?.reason ?? json?.errorCode ?? 'REJECTED'),
    /** Where it actually filled — never assume this is the price that was asked for. */
    level: typeof json?.level === 'number' ? json.level : null,
    size: typeof json?.size === 'number' ? json.size : null,
    direction: json?.direction ?? null,
  };
}

/** How long to keep asking what became of a deal, and how often. */
const CONFIRM_TIMEOUT_MS = 10_000;
const CONFIRM_POLL_MS = 250;

/** The venue's verdict on one deal reference, raw. 404 while it is still being processed. */
export async function capitalConfirm(dealReference) {
  const res = await authedFetch(`/confirms/${encodeURIComponent(dealReference)}`);
  if (res.status === 404) return null; // not decided yet
  if (!res.ok) throw await failureOf(res, `/confirms/${dealReference}`);
  return readConfirmation(await res.json());
}

/**
 * Ask what became of `dealReference` until the venue says, or until waiting is hopeless.
 *
 * A timeout is NOT a refusal, and is reported as its own thing: the instruction was
 * delivered, so a position may well be open — the one thing that must not happen is the app
 * deciding nothing happened and sending it again.
 */
async function awaitConfirmation(dealReference) {
  const until = Date.now() + CONFIRM_TIMEOUT_MS;
  for (;;) {
    const confirmation = await capitalConfirm(dealReference);
    if (confirmation) return confirmation;
    if (Date.now() >= until) {
      throw new Error(
        `Capital.com did not say what became of ${dealReference} within ${CONFIRM_TIMEOUT_MS / 1000}s. `
        + 'The instruction was delivered — check the position list before sending it again.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
  }
}

/** Send one position-changing request and answer with what the venue made of it. */
async function deal(pathAndQuery, options, what) {
  return throughOrderGate(async () => {
    const res = await authedFetch(pathAndQuery, options);
    if (!res.ok) throw await failureOf(res, what);
    const { dealReference } = await res.json();
    if (!dealReference) throw new Error(`Capital.com ${what} answered without a deal reference`);
    const confirmation = await awaitConfirmation(dealReference);
    wire('deal', { what, dealReference, confirmation });
    return confirmation;
  });
}

/** The trading account this session acts on — the preferred one, as the platform marks it. */
export async function capitalAccount() {
  const res = await authedFetch('/accounts');
  if (!res.ok) throw await failureOf(res, '/accounts');
  const { accounts = [] } = await res.json();
  return accounts.find((a) => a.preferred) ?? accounts[0] ?? null;
}

/** Every position the account holds — including ones this app did not open. */
export async function capitalPositions() {
  const res = await authedFetch('/positions');
  if (!res.ok) throw await failureOf(res, '/positions');
  const { positions = [] } = await res.json();
  return positions;
}

/**
 * Open a position. `direction` is `BUY`/`SELL` and `size` is always positive — the venue has
 * no notion of a negative size, and a short is a direction rather than a sign.
 *
 * Protection rides along on the way in (`stopLevel`/`profitLevel`) rather than being attached
 * afterwards: a stop placed in a second request is a stop that does not exist for as long as
 * that request takes, on a position that is already live.
 */
export async function capitalOpenPosition(payload) {
  return deal('/positions', { method: 'POST', body: payload }, 'POST /positions');
}

/** Move the stop and target on an open position. */
export async function capitalAmendPosition(dealId, payload) {
  return deal(`/positions/${encodeURIComponent(dealId)}`, { method: 'PUT', body: payload }, `PUT /positions/${dealId}`);
}

/** Close one position outright, at market. */
export async function capitalClosePosition(dealId) {
  return deal(`/positions/${encodeURIComponent(dealId)}`, { method: 'DELETE' }, `DELETE /positions/${dealId}`);
}

// ── Working orders (resting limits and stops) ───────────────────────────────
//
// A position is a trade that HAS happened; a working order is one that has not, and
// the venue keeps them in different places with different ids. Which of LIMIT and
// STOP a level means depends on the direction — a buy below the market is a limit and
// a buy above it is a stop — and that decision belongs to the caller, which already
// has to make it to refuse a level dropped on the wrong side.

/** Every resting order the account holds, whatever instrument it is on. */
export async function capitalWorkingOrders() {
  const res = await authedFetch('/workingorders');
  if (!res.ok) throw await failureOf(res, '/workingorders');
  const { workingOrders = [] } = await res.json();
  return workingOrders;
}

/** Rest an order at `level`. `type` is `LIMIT` or `STOP`. */
export async function capitalCreateOrder(payload) {
  return deal('/workingorders', { method: 'POST', body: payload }, 'POST /workingorders');
}

/** Move a resting order, or change the protection it will carry when it fills. */
export async function capitalAmendOrder(dealId, payload) {
  return deal(`/workingorders/${encodeURIComponent(dealId)}`, { method: 'PUT', body: payload }, `PUT /workingorders/${dealId}`);
}

/** Take a resting order off the book. */
export async function capitalCancelOrder(dealId) {
  return deal(`/workingorders/${encodeURIComponent(dealId)}`, { method: 'DELETE' }, `DELETE /workingorders/${dealId}`);
}

// ── Account history ─────────────────────────────────────────────────────────
//
// What a trade actually COST, which nothing else here can answer. The venue keeps it in
// two ledgers that have to be joined: `/history/transactions` carries the cash (the
// realized result, overnight swap, commission) and `/history/activity` carries the
// position's life (direction, levels, and what closed it). The join key is the deal id.
//
// `/history/activity` serves at most a day per request — its `lastPeriod` caps at 86400
// seconds — so a longer window has to be walked in daily slices. Every slice has to
// succeed: a half-read window would settle a trade with figures that are missing rather
// than wrong, and a settled trade is never revisited.

/** A window longer than this is refused rather than walked — see the day-slicing above. */
const HISTORY_MAX_DAYS = 31;

export async function capitalTransactions(fromMs, toMs) {
  const params = new URLSearchParams({ from: isoNoZ(fromMs), to: isoNoZ(toMs) });
  const res = await authedFetch(`/history/transactions?${params}`);
  if (!res.ok) throw await failureOf(res, '/history/transactions');
  const { transactions = [] } = await res.json();
  return transactions;
}

/** Detailed activities across `from`→`to`, in the daily slices the endpoint allows. */
export async function capitalActivities(fromMs, toMs) {
  const days = (toMs - fromMs) / 86_400_000;
  if (!(days > 0)) return [];
  if (days > HISTORY_MAX_DAYS) {
    throw new Error(`Capital.com history is read a day at a time; ${Math.ceil(days)} days is more than the ${HISTORY_MAX_DAYS} this asks for at once.`);
  }
  const out = [];
  for (let cursor = fromMs; cursor < toMs;) {
    const next = Math.min(cursor + 86_400_000, toMs);
    const params = new URLSearchParams({ from: isoNoZ(cursor), to: isoNoZ(next), detailed: 'true' });
    const res = await authedFetch(`/history/activity?${params}`);
    if (!res.ok) throw await failureOf(res, '/history/activity');
    const { activities } = await res.json();
    if (!Array.isArray(activities)) throw new Error('Capital.com returned an unreadable activity list.');
    out.push(...activities);
    cursor = next;
  }
  return out;
}

/**
 * Try one set of credentials without touching the session this app is running on.
 *
 * Used before anything is stored: a key that does not work should be refused at the point
 * somebody typed it, not discovered later by a chart that will not load. It logs in on its
 * own and lists the accounts, so the answer is not merely "accepted" but "here is what you
 * are connected to" — which is also how a person notices they have reached the demo account
 * when they meant the live one.
 *
 * Deliberately does NOT set `creds`: a failed probe must leave a working configuration alone.
 */
export async function capitalProbe({ apiKey, identifier, password, env } = {}) {
  const base = env === 'live' ? LIVE_BASE : DEMO_BASE;
  const res = await fetch(`${base}/session`, {
    method: 'POST',
    headers: { 'X-CAP-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  const probeCst = res.headers.get('cst');
  const probeToken = res.headers.get('x-security-token');
  if (!res.ok) throw await sessionFailure(res, env);
  if (!probeCst || !probeToken) throw new Error('Capital.com accepted the login but sent no session tokens.');
  const accounts = await fetch(`${base}/accounts`, { headers: { CST: probeCst, 'X-SECURITY-TOKEN': probeToken } });
  if (!accounts.ok) throw new Error(`Signed in, but the account list could not be read (HTTP ${accounts.status}).`);
  const { accounts: list = [] } = await accounts.json();
  return list.map((a) => ({
    accountId: a.accountId,
    accountName: a.accountName,
    currency: a.currency,
    preferred: a.preferred === true,
    balance: a.balance?.balance ?? null,
    available: a.balance?.available ?? null,
  }));
}
