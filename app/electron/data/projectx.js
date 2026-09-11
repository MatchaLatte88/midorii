/* ProjectX Gateway session + SignalR relay, built from their REST + realtime API
 * (https://gateway.docs.projectx.com/) — no SDK.
 *
 * Runs in the MAIN process for the same reason capital.js does: the session is a bearer
 * token that must not be handed to the renderer, and the socket that carries the tick
 * stream is bound to it. The renderer only ever sees bars and quotes.
 *
 * What is different here, and why this file is not a copy of capital.js
 * --------------------------------------------------------------------
 * Capital.com streams CANDLES. ProjectX streams TICKS and nothing else — the market hub
 * has quotes, trades and depth, and no candle feed at any timeframe. So the forming bar
 * is built HERE, out of the trade stream, rather than read off the wire. That is the
 * whole of the extra machinery below, and it carries one correctness problem with it:
 * ticks say what traded since we subscribed, not what the bar opened at. A bar aggregated
 * from a standing start would show a false open for its first minute — so a subscription
 * SEEDS itself from the REST partial bar and only then starts folding ticks in.
 *
 * `live` is not a data flag
 * ------------------------
 * Measured against a real account rather than taken from the documentation, which does not
 * say: `live:true` is refused outright for a simulated account (contracts come back empty,
 * bars answer errorCode 1). It selects the ACCOUNT SIDE, not the data quality — the data is
 * real-time either way, arriving within ~0.1s of the exchange timestamp. It follows the
 * configured account rather than being guessed at.
 */
import { appendFileSync } from 'node:fs';

const DEFAULT_BASE = 'https://api.topstepx.com';
const DEFAULT_HUB = 'https://rtc.topstepx.com/hubs/market';

/** Tokens last 24h. Re-login this far ahead of that, so a slow request never lands on a
 *  token that expired between the check and the send. */
const SESSION_MARGIN_MS = 60 * 60_000;
/** Reconnect backoff after an unexpected socket close. */
const WS_RECONNECT_MS = 2_000;
/** SignalR frames its records with this byte rather than with newlines. */
const SEP = '\x1e';

/**
 * A record of what crossed the wire — off unless `MIDORII_PROJECTX_LOG` names a file.
 *
 * Same rule as the Capital.com relay: it is handed methods, paths, statuses and the app's
 * OWN payloads, and never a token, a key or a header. Ticks and quotes are left out too —
 * they arrive hundreds a second and say nothing a trade could be traced by.
 */
function wire(event, detail) {
  const file = process.env.MIDORII_PROJECTX_LOG;
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`);
  } catch {
    /* A log that cannot be written is not a reason to fail a trade. */
  }
}

let creds = null; // { userName, apiKey, base, hub, live }
let token = null;
let tokenIssuedAt = 0;
let loginPromise = null;

/**
 * Which account orders and positions are addressed to.
 *
 * A gateway account is not like a Capital.com one, where the venue has a "preferred"
 * account and a session lands on it. Here EVERY order, position read and trade carries an
 * `accountId`, and a key routinely reaches several: an evaluation and the funded accounts
 * that came out of it. So the choice is the app's to make and to hold, and there is no
 * sensible default — trading the wrong one of these is not a degraded experience, it is a
 * trade on somebody's funded account.
 *
 * Null until chosen. Everything that needs it asks {@link requireAccountId}, which refuses
 * rather than picking.
 */
let accountId = null;

let ws = null;
let wsConnectPromise = null;
let wsReconnectTimer = null;

/** `contractId:timeframe` → { bar, tfMs, listeners:Set<cb> } — one forming bar per feed,
 *  however many panes are watching it. */
const barFeeds = new Map();
/** `contractId` → Set<callback>, delivered every quote. */
const quoteSubscribers = new Map();
/** `contractId` → the last complete quote, since the feed sends deltas. See the
 *  GatewayQuote branch of {@link handleHubMessage}. */
const quoteState = new Map();
/** What the CURRENT socket has been told, as `contract:${id}`. Cleared when it goes,
 *  because a fresh socket remembers nothing. */
const streamed = new Set();

export function configureProjectX(next) {
  creds = next && next.userName && next.apiKey
    ? {
      userName: next.userName,
      apiKey: next.apiKey,
      base: next.base || DEFAULT_BASE,
      hub: next.hub || DEFAULT_HUB,
      live: next.live === true,
    }
    : null;
  /* The chosen account belongs to the key that reached it. A different key is a different
   * set of accounts, and carrying an id across would address an account this session may
   * not even be able to see — so it is dropped and has to be chosen again. */
  accountId = Number.isFinite(next?.accountId) ? Number(next.accountId) : null;
  token = null;
  tokenIssuedAt = 0;
  /* Every forming bar is dropped, though the subscriptions that built them stay. A bar
   * half-built under one account is not the same bar under another — the simulated and
   * live sides are separate books — and carrying it across a switch would splice two
   * markets into one candle. Cleared, each feed re-seeds from REST on the next tick.
   * The accumulated quotes go for the same reason: a stale bid folded under a delta from
   * the other book would read as a current one. */
  for (const feed of barFeeds.values()) feed.bar = null;
  quoteState.clear();
  /* The socket cannot outlive the credentials it was opened under — after a switch it
   * would be streaming under a session that no longer exists. Subscriptions themselves
   * stay; `onclose` reopens under whatever is configured by then. */
  if (ws) { try { ws.close(); } catch { /* onclose does the rest */ } }
}

export function projectXConfigured() {
  return !!creds;
}

/** Which side the credentials point at, for a screen that has to SAY so. */
export function projectXEnvironment() {
  return { configured: !!creds, live: creds?.live === true, base: creds?.base ?? null };
}

/**
 * What a refused login means, in words that say what to do about it.
 *
 * The gateway answers with a number and a null message, so the number is all there is to
 * go on. Codes are read here rather than in each caller, and an unrecognised one is passed
 * through whole — an unknown refusal is exactly the one worth reading verbatim.
 */
function loginFailure(json, status) {
  const known = {
    3: 'ProjectX refused these credentials. The username is the one you sign in to the '
      + 'platform with, not the email address on the account.',
    7: 'ProjectX accepted the credentials but the account has agreements still to be signed. '
      + 'Open the platform, accept what it asks for, and try again.',
    9: 'This account has no API subscription. The gateway is a paid add-on — it has to be '
      + 'active before a key will authenticate.',
    10: 'API key authentication is turned off for this account. Enable it in the platform, '
      + 'or generate a new key.',
  }[json?.errorCode];
  if (known) return new Error(known);
  if (json?.errorMessage) return new Error(`ProjectX refused the connection — ${json.errorMessage}`);
  return new Error(json?.errorCode != null
    ? `ProjectX refused the connection (errorCode ${json.errorCode}).`
    : `ProjectX refused the connection (HTTP ${status}).`);
}

async function login() {
  const res = await fetch(`${creds.base}/api/Auth/loginKey`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/plain' },
    body: JSON.stringify({ userName: creds.userName, apiKey: creds.apiKey }),
  });
  const json = await res.json().catch(() => null);
  wire('session', { status: res.status, success: json?.success ?? null, errorCode: json?.errorCode ?? null });
  /* The gateway answers 200 on a REFUSED login and says so in the body, so the status
   * alone proves nothing — the token is the only evidence that this worked. */
  if (!res.ok || !json?.token) throw loginFailure(json, res.status);
  token = json.token;
  tokenIssuedAt = Date.now();
}

async function ensureSession() {
  if (!creds) throw new Error('ProjectX is not connected — add the account under Settings → Broker connection.');
  if (token && Date.now() - tokenIssuedAt < 24 * 60 * 60_000 - SESSION_MARGIN_MS) return;
  if (!loginPromise) loginPromise = login().finally(() => { loginPromise = null; });
  return loginPromise;
}

/**
 * An authenticated POST, retried once after a fresh login on a 401.
 *
 * The retry is safe for a write as well as a read, and only because of what a 401 means:
 * the request was rejected before anything was done with it, so sending it again cannot
 * do it twice. Nothing else is retried here for exactly that reason — a timed-out order
 * may well have been placed, and asking again would be the second one.
 */
async function authedPost(pathname, body) {
  const startedAt = Date.now();
  await ensureSession();
  const attempt = () => fetch(`${creds.base}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/plain',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  let res = await attempt();
  if (res.status === 401) {
    token = null;
    await ensureSession();
    res = await attempt();
  }
  const json = await res.json().catch(() => null);
  wire('rest', { path: pathname, status: res.status, ms: Date.now() - startedAt, success: json?.success ?? null, errorCode: json?.errorCode ?? null });
  if (!res.ok) throw new Error(`ProjectX ${pathname} HTTP ${res.status}`);
  /* `success:false` with a 200 is how this gateway reports a refusal — an unchecked
   * caller would read `bars: null` as "no bars" and chart an empty market. */
  if (json && json.success === false) {
    throw new Error(`ProjectX ${pathname} refused the request (errorCode ${json.errorCode}).`);
  }
  return json;
}

// ── Accounts and contracts ──────────────────────────────────────────────────

/** The accounts this key can reach. `onlyActive` hides the ones already finished with. */
export async function projectXAccounts(onlyActive = true) {
  const json = await authedPost('/api/Account/search', { onlyActiveAccounts: onlyActive });
  return json?.accounts ?? [];
}

/** Which account is being traded, and whether one has been chosen at all. */
export function projectXAccount() {
  return { accountId, chosen: accountId != null };
}

/**
 * Trade a different account from now on.
 *
 * Verified against the venue rather than taken on trust: an id typed into a stale settings
 * page, or restored from disk after an evaluation ended, would otherwise be set here and
 * only refused later — at the moment an order was sent. The account is also checked for
 * whether it may trade at all, because one that cannot is a strictly worse answer than
 * none: it looks connected and refuses everything.
 */
export async function projectXSelectAccount(id) {
  const wanted = Number(id);
  if (!Number.isFinite(wanted)) throw new Error('A ProjectX account id is required.');
  const accounts = await projectXAccounts(true);
  const found = accounts.find((a) => a.id === wanted);
  if (!found) {
    throw new Error(`ProjectX does not list an active account ${wanted} for this key. It may have ended, or belong to another login.`);
  }
  if (found.canTrade === false) {
    throw new Error(`ProjectX account ${found.name} cannot trade. Pick one that can.`);
  }
  accountId = wanted;
  wire('account', { accountId: wanted, name: found.name });
  return found;
}

/**
 * The account to address, or a refusal naming what to do about it.
 *
 * Never guesses. A key that reaches an evaluation and two funded accounts has no "obvious"
 * one, and quietly picking the first would put an order on whichever the venue happened to
 * list first.
 */
function requireAccountId() {
  if (accountId == null) {
    throw new Error('No ProjectX account is selected — choose one under Settings → Broker connection.');
  }
  return accountId;
}

/** Every position the chosen account holds, including ones this app never opened. */
export async function projectXPositions() {
  const json = await authedPost('/api/Position/searchOpen', { accountId: requireAccountId() });
  return json?.positions ?? [];
}

/** Every resting order the chosen account holds, on any contract. */
export async function projectXOpenOrders() {
  const json = await authedPost('/api/Order/searchOpen', { accountId: requireAccountId() });
  return json?.orders ?? [];
}

// ── Trading ─────────────────────────────────────────────────────────────────

/** The gateway's own order kinds. Numbers on the wire, names in this app. */
export const ORDER_TYPE = { limit: 1, market: 2, stop: 4, trailingStop: 5, joinBid: 6, joinAsk: 7 };
/** Their sides, in the venue's spelling: a bid buys, an ask sells. */
export const ORDER_SIDE = { buy: 0, sell: 1 };

/**
 * What a refused instruction means, in words that say what to do about it.
 *
 * Separate from {@link authedPost}'s generic handling because an order's refusal is the one
 * a person is standing in front of, waiting. `6` is the interesting one: it is not a bad
 * order, it is an account that is not permitted to do this — a live account on an endpoint
 * the gateway only serves to simulated ones, or an account following another.
 */
function orderFailure(json, what) {
  if (json?.errorMessage) return new Error(`ProjectX refused to ${what} — ${json.errorMessage}`);
  if (json?.errorCode === 6) {
    return new Error(`ProjectX will not ${what} on this account. The gateway serves this only to `
      + 'simulated accounts that are not following another one.');
  }
  return new Error(`ProjectX refused to ${what} (errorCode ${json?.errorCode ?? 'unknown'}).`);
}

/** POST an instruction, and read the venue's verdict rather than the HTTP status. */
async function instruct(pathname, body, what) {
  const startedAt = Date.now();
  await ensureSession();
  const res = await fetch(`${creds.base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/plain', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  wire('order', { path: pathname, status: res.status, ms: Date.now() - startedAt, body, success: json?.success ?? null, errorCode: json?.errorCode ?? null });
  /* Deliberately NOT retried on a 401, unlike a read. A timed-out or rejected order may
   * still have been delivered, and sending it again is how an account ends up with two
   * positions where somebody asked for one. */
  if (!res.ok || json?.success === false) throw orderFailure(json, what);
  return json;
}

/**
 * Place an order.
 *
 * `size` is whole contracts, `side` is `'buy'` or `'sell'`, `type` one of {@link ORDER_TYPE}'s
 * names. Brackets are given in TICKS from the fill rather than in prices, which is the
 * gateway's own shape — and note its restriction: brackets here cannot be combined with
 * position brackets, and the account needs Auto OCO enabled for them to work at all.
 */
export async function projectXPlaceOrder({ contractId, side, type, size, limitPrice, stopPrice, trailPrice, customTag, stopLossTicks, takeProfitTicks }) {
  const typeCode = ORDER_TYPE[type];
  const sideCode = ORDER_SIDE[side];
  if (typeCode == null) throw new Error(`Unknown ProjectX order type "${type}". Known: ${Object.keys(ORDER_TYPE).join(', ')}.`);
  if (sideCode == null) throw new Error(`Unknown ProjectX order side "${side}". Known: ${Object.keys(ORDER_SIDE).join(', ')}.`);
  if (!Number.isInteger(size) || size < 1) throw new Error('A ProjectX order size must be a whole number of contracts, at least one.');

  const json = await instruct('/api/Order/place', {
    accountId: requireAccountId(),
    contractId,
    type: typeCode,
    side: sideCode,
    size,
    ...(limitPrice != null ? { limitPrice } : {}),
    ...(stopPrice != null ? { stopPrice } : {}),
    ...(trailPrice != null ? { trailPrice } : {}),
    ...(customTag != null ? { customTag } : {}),
    ...(stopLossTicks != null ? { stopLossBracket: { ticks: stopLossTicks, type: ORDER_TYPE.stop } } : {}),
    ...(takeProfitTicks != null ? { takeProfitBracket: { ticks: takeProfitTicks, type: ORDER_TYPE.limit } } : {}),
  }, 'place the order');
  return { orderId: json?.orderId ?? null };
}

/** Change a resting order. Only the fields given are sent. */
export async function projectXModifyOrder(orderId, { size, limitPrice, stopPrice, trailPrice } = {}) {
  await instruct('/api/Order/modify', {
    accountId: requireAccountId(),
    orderId,
    ...(size != null ? { size } : {}),
    ...(limitPrice != null ? { limitPrice } : {}),
    ...(stopPrice != null ? { stopPrice } : {}),
    ...(trailPrice != null ? { trailPrice } : {}),
  }, 'change the order');
}

export async function projectXCancelOrder(orderId) {
  await instruct('/api/Order/cancel', { accountId: requireAccountId(), orderId }, 'cancel the order');
}

/**
 * Close a position at market, whole or in part.
 *
 * Two endpoints rather than one with an optional size, because that is how the gateway
 * splits them — and the distinction matters: a partial close with a size equal to the whole
 * position is not the same call as a full close, and only one of them is guaranteed to
 * leave nothing behind.
 */
export async function projectXClosePosition(contractId, size = null) {
  const accountId = requireAccountId();
  if (size == null) {
    await instruct('/api/Position/closeContract', { accountId, contractId }, 'close the position');
    return;
  }
  if (!Number.isInteger(size) || size < 1) throw new Error('A partial close needs a whole number of contracts, at least one.');
  await instruct('/api/Position/partialCloseContract', { accountId, contractId, size }, 'close part of the position');
}

/**
 * Contracts matching `searchText`.
 *
 * The `live` flag follows the configured account: asking the live side from a simulated
 * account answers with an empty list rather than an error, which would look exactly like
 * a symbol that does not exist.
 */
export async function projectXContracts(searchText) {
  const json = await authedPost('/api/Contract/search', { live: creds?.live === true, searchText });
  return json?.contracts ?? [];
}

/**
 * Every contract the account can reach, with no search text.
 *
 * What a symbol index is built from — {@link projectXContracts} needs something to search
 * FOR, which is no use to a picker that has to show what exists before anybody types. The
 * only endpoint here this app has never seen answer on a real account, so callers are
 * expected to degrade rather than depend on it.
 */
export async function projectXAvailableContracts() {
  const json = await authedPost('/api/Contract/available', { live: creds?.live === true });
  return json?.contracts ?? [];
}

// ── Bars ────────────────────────────────────────────────────────────────────

/**
 * Canonical Vela timeframe → the gateway's `unit`/`unitNumber` pair, and the span in
 * milliseconds that one bar covers.
 *
 * The span is not decoration: it is what the tick aggregator buckets by, so a timeframe
 * that cannot state its length cannot be streamed. Units are 1=second, 2=minute, 3=hour,
 * 4=day, 5=week, 6=month. Months are left out — their length is not a constant and the
 * aggregator would have to special-case a calendar it has no other use for.
 */
const TF_TO_UNIT = {
  /*
   * The second-resolution timeframes reach back FOURTEEN DAYS and no further.
   *
   * Measured, not documented: asking for 50,000 half-minute bars returns 27,103 of them
   * covering exactly 14.0 days, and widening the request window by half again changes
   * nothing. That is the gateway's own retention for this unit, not a paging limit at this
   * end — so a backtest on seconds has a fortnight of history to work with, and anything
   * that needs more has to run on minutes.
   */
  '15S': { unit: 1, unitNumber: 15, ms: 15_000 },
  '30S': { unit: 1, unitNumber: 30, ms: 30_000 },
  1: { unit: 2, unitNumber: 1, ms: 60_000 },
  5: { unit: 2, unitNumber: 5, ms: 5 * 60_000 },
  15: { unit: 2, unitNumber: 15, ms: 15 * 60_000 },
  30: { unit: 2, unitNumber: 30, ms: 30 * 60_000 },
  60: { unit: 3, unitNumber: 1, ms: 60 * 60_000 },
  240: { unit: 3, unitNumber: 4, ms: 4 * 60 * 60_000 },
  D: { unit: 4, unitNumber: 1, ms: 24 * 60 * 60_000 },
  W: { unit: 5, unitNumber: 1, ms: 7 * 24 * 60 * 60_000 },
};

function unitOf(timeframe) {
  const spec = TF_TO_UNIT[timeframe];
  if (!spec) {
    throw new Error(`ProjectX does not serve the "${timeframe}" timeframe. Known: ${Object.keys(TF_TO_UNIT).join(', ')}.`);
  }
  return spec;
}

/** The gateway's own cap on one request. */
const MAX_BARS = 20_000;

/**
 * One bar row → the shape the chart reads.
 *
 * Their timestamps carry a `+00:00` offset and up to seven decimal places (.NET ticks).
 * `Date.parse` handles both, truncating to milliseconds, which is the resolution
 * everything downstream works in anyway.
 */
function rowToBar(row) {
  return {
    time: Date.parse(row.t),
    open: row.o,
    high: row.h,
    low: row.l,
    close: row.c,
    volume: row.v ?? 0,
  };
}

/** How many pages one call may walk back through. A guard against a window so wide, or a
 *  timeframe so fine, that the loop would run for minutes against a rate-limited endpoint. */
const MAX_PAGES = 20;

/**
 * How much wider than the bars themselves an unbounded window is opened.
 *
 * The index futures trade roughly 23 hours a day, five days a week — about two thirds of
 * the calendar. Three halves of it is the smallest slack that reliably covers the nights
 * and weekends inside a request, without reaching so far back that a short-history
 * contract spends pages on empty time.
 */
const CLOSED_MARKET_SLACK = 1.5;

/** One window's worth of bars, capped by the gateway's own limit. */
async function barsPage(contractId, { unit, unitNumber }, startTime, endTime, limit) {
  const json = await authedPost('/api/History/retrieveBars', {
    contractId,
    live: creds?.live === true,
    startTime: new Date(startTime).toISOString(),
    endTime: new Date(endTime).toISOString(),
    unit,
    unitNumber,
    limit: Math.min(limit, MAX_BARS),
    includePartialBar: true,
  });
  const bars = (json?.bars ?? []).map(rowToBar);
  /* Their newest-first ordering is not promised anywhere, so it is not relied on. */
  bars.sort((a, b) => a.time - b.time);
  return bars;
}

/**
 * Historical bars for `contractId`/`timeframe`.
 *
 * `includePartialBar` is on: the newest bar is the one still forming, which is what the
 * chart treats its last candle as. Leaving it off would hand back a chart that is always one
 * bar behind the market and looks stalled.
 *
 * Paged BACKWARD past the gateway's 20,000-bar ceiling, which is a server limit and not a
 * setting — asking for more in one call does not raise it. The ceiling only started to bite
 * with the second-resolution timeframes: 20,000 minute bars are a fortnight, 20,000
 * fifteen-second bars are three and a half days.
 */
export async function projectXBars(contractId, timeframe, { from, to, limit } = {}) {
  const spec = unitOf(timeframe);
  const end = to ?? Date.now();
  const want = limit ?? 500;

  /* A bounded window is walked from its own end; an unbounded one is "the most recent
   * `want` bars", which this API cannot ask for directly — it only takes a window, so one
   * is computed from the bar span.
   *
   * Widened by {@link CLOSED_MARKET_SLACK}, because bar span times bar count is CALENDAR
   * time and a futures market is shut for a good deal of it. Measured: 50,000 half-minute
   * bars asked over their own 17.4 days came back 27,103 — the nights and the weekends in
   * between. The window is only an outer bound; the paging stops when the venue runs out,
   * so asking for more time than is needed costs nothing. */
  const floor = from ?? end - want * spec.ms * CLOSED_MARKET_SLACK;

  let out = [];
  let cursor = end;
  for (let page = 0; page < MAX_PAGES && out.length < want && cursor > floor; page += 1) {
    const bars = await barsPage(contractId, spec, floor, cursor, want - out.length);
    if (!bars.length) break;
    /* Prepended: each page is OLDER than the last, so the answer is built from the back. */
    out = bars.concat(out);
    const earliest = bars[0].time;
    /* No backward progress means the venue is answering the same window again — stop
     * rather than ask for it a third time. */
    if (earliest >= cursor) break;
    cursor = earliest - 1;
    if (bars.length < MAX_BARS) break; // the window was served whole; there is no more
  }

  /* Pages can overlap at their seams — the gateway is inclusive at both ends — so identical
   * open times are collapsed rather than handed on as duplicate candles. */
  const seen = new Set();
  const unique = [];
  for (const bar of out) {
    if (seen.has(bar.time)) continue;
    seen.add(bar.time);
    unique.push(bar);
  }
  return unique.length > want ? unique.slice(unique.length - want) : unique;
}

// ── Realtime ────────────────────────────────────────────────────────────────

/**
 * SignalR by hand, rather than through @microsoft/signalr.
 *
 * The protocol needed here is small — negotiate over HTTP, open the socket, send one
 * handshake frame, then read 0x1e-separated JSON records — and the app already speaks a
 * raw WebSocket for Capital.com. A dependency that exists to hide four messages would be
 * carried by every build for the rest of the project's life; this is the smaller cost.
 * If the hub ever needs the parts that are genuinely hard (transport fallback, automatic
 * reconnect with state replay), that trade changes and the library should come in.
 */
async function negotiate() {
  await ensureSession();
  const res = await fetch(`${creds.hub}/negotiate?negotiateVersion=1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`ProjectX hub negotiate HTTP ${res.status}`);
  const json = await res.json();
  wire('hub.negotiate', { status: res.status, transports: (json.availableTransports ?? []).map((t) => t.transport) });
  return json;
}

/** Send one framed record, saying whether it actually went. */
function sendWs(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(obj) + SEP);
  return true;
}

/**
 * Ask the socket for one contract's feeds, and only once.
 *
 * Quotes and trades are taken together because the two answer different questions and the
 * aggregator needs both: trades are what actually printed (the bar's body), quotes are what
 * it costs to trade right now (the price a ticket is priced against). Depth is not
 * subscribed — nothing in the app reads a ladder, and it is the noisiest of the three.
 */
function streamContract(contractId) {
  if (streamed.has(`contract:${contractId}`)) return;
  const quotes = sendWs({ type: 1, target: 'SubscribeContractQuotes', arguments: [contractId] });
  const trades = sendWs({ type: 1, target: 'SubscribeContractTrades', arguments: [contractId] });
  if (quotes && trades) streamed.add(`contract:${contractId}`);
}

/** Every contract something is currently listening to, across both kinds of subscription. */
function activeContracts() {
  const ids = new Set(quoteSubscribers.keys());
  for (const key of barFeeds.keys()) ids.add(key.slice(0, key.lastIndexOf(':')));
  return ids;
}

function stopReconnectingIfIdle() {
  if (barFeeds.size === 0 && quoteSubscribers.size === 0 && wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
}

async function ensureStream() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (wsConnectPromise) return wsConnectPromise;
  wsConnectPromise = (async () => {
    const neg = await negotiate();
    const url = `${creds.hub.replace(/^http/, 'ws')}`
      + `?id=${encodeURIComponent(neg.connectionToken || neg.connectionId)}`
      + `&access_token=${encodeURIComponent(token)}`;
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      let settled = false;
      let handshakeDone = false;

      socket.onopen = () => {
        /* Not resolved yet: an open socket is not a usable one until the handshake is
         * answered, and subscribing before that is silently ignored. */
        socket.send(`${JSON.stringify({ protocol: 'json', version: 1 })}${SEP}`);
      };
      socket.onmessage = (ev) => {
        const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
        for (const part of raw.split(SEP)) {
          if (!part) continue;
          let msg;
          try { msg = JSON.parse(part); } catch { continue; }
          if (!handshakeDone) {
            handshakeDone = true;
            if (msg.error) {
              wire('hub.handshake', { error: msg.error });
              try { socket.close(); } catch { /* onclose follows */ }
              if (!settled) { settled = true; reject(new Error(`ProjectX hub refused the handshake — ${msg.error}`)); }
              return;
            }
            settled = true;
            ws = socket;
            streamed.clear();
            wire('hub.handshake', { ok: true });
            // Re-subscribe everything — a fresh socket remembers nothing.
            for (const id of activeContracts()) streamContract(id);
            resolve();
            continue;
          }
          handleHubMessage(msg);
        }
      };
      socket.onerror = () => { try { socket.close(); } catch { /* onclose follows */ } };
      socket.onclose = () => {
        ws = null;
        streamed.clear();
        if (!settled) { settled = true; reject(new Error('ProjectX hub closed before it opened')); }
        if (barFeeds.size > 0 || quoteSubscribers.size > 0) {
          /* Reported rather than thrown into nothing: reopening runs on a timer with no
           * caller left to reject to. */
          wsReconnectTimer = setTimeout(() => {
            ensureStream().catch((e) => console.warn(`[midorii] ProjectX stream could not be reopened — ${e instanceof Error ? e.message : String(e)}`));
          }, WS_RECONNECT_MS);
        }
      };
    });
  })().finally(() => { wsConnectPromise = null; });
  return wsConnectPromise;
}

function handleHubMessage(msg) {
  if (msg.type === 7) {                       // server closing
    wire('hub.close', { error: msg.error ?? null });
    return;
  }
  if (msg.type === 3 && msg.error) {          // completion carrying a refusal
    wire('hub.invocation-error', { error: msg.error });
    return;
  }
  if (msg.type !== 1) return;                 // 6 is a ping, the rest is bookkeeping

  const [contractId, payload] = msg.arguments ?? [];
  if (!contractId || payload == null) return;

  if (msg.target === 'GatewayTrade') {
    /* An array, not a tick: up to twenty prints arrive in one message, and reading only
     * the first would silently drop most of the tape. */
    for (const trade of payload) foldTrade(contractId, trade);
    return;
  }

  if (msg.target === 'GatewayQuote') {
    /*
     * A quote is a DELTA, not a snapshot.
     *
     * Only the first message on a subscription carries the whole picture; every one after
     * it names just the fields that moved. Measured on a live feed: of 176 payloads, the
     * session figures appeared once and 130 were missing at least one of last/bid/ask.
     * Passing those gaps on as nulls would hand a ticket a missing bid three times out of
     * four, so the last known state is kept here and the delta folded into it — every
     * listener sees a complete quote or none at all.
     */
    const previous = quoteState.get(contractId);
    const state = previous ?? { last: null, bid: null, ask: null, time: 0 };
    if (payload.lastPrice != null) state.last = payload.lastPrice;
    if (payload.bestBid != null) state.bid = payload.bestBid;
    if (payload.bestAsk != null) state.ask = payload.bestAsk;
    /* `lastUpdated`, NOT `timestamp` — the latter carries the session's start on the
     * opening snapshot and would date the quote to the previous day. Measured, not assumed. */
    state.time = payload.lastUpdated ? Date.parse(payload.lastUpdated) : Date.now();
    quoteState.set(contractId, state);
    /* Copied out: the state above goes on being mutated by the next delta, and a listener
     * that keeps a quote must not watch its own copy change underneath it. */
    const quote = { contractId, ...state };
    for (const cb of quoteSubscribers.get(contractId) ?? []) cb(quote);
  }
}

// ── Tick → bar aggregation ──────────────────────────────────────────────────

/** The open time of the bucket `time` falls in, for a bar spanning `tfMs`. */
function bucketOf(time, tfMs) {
  return Math.floor(time / tfMs) * tfMs;
}

/**
 * Fold one print into every feed watching this contract.
 *
 * A bar is emitted on every tick rather than only when it closes, because the chart draws
 * the forming candle live; the bar object is copied out so a listener that keeps it does
 * not find its own reference mutating underneath.
 */
function foldTrade(contractId, trade) {
  const price = trade.price;
  if (typeof price !== 'number') return;
  const at = trade.timestamp ? Date.parse(trade.timestamp) : Date.now();
  if (Number.isNaN(at)) return;
  const size = trade.volume ?? 0;

  for (const [key, feed] of barFeeds) {
    if (key.slice(0, key.lastIndexOf(':')) !== contractId) continue;
    const open = bucketOf(at, feed.tfMs);

    /* A print older than the bar being built belongs to a bar already emitted. Rewriting
     * history from a late tick would make the chart flicker backwards, so it is dropped —
     * the REST backfill is what corrects a closed bar, not the tape. */
    if (feed.bar && open < feed.bar.time) continue;

    if (!feed.bar || open > feed.bar.time) {
      feed.bar = { time: open, open: price, high: price, low: price, close: price, volume: size };
    } else {
      feed.bar.high = Math.max(feed.bar.high, price);
      feed.bar.low = Math.min(feed.bar.low, price);
      feed.bar.close = price;
      feed.bar.volume += size;
    }
    for (const cb of feed.listeners) cb({ ...feed.bar });
  }
}

/**
 * Subscribe `cb` to live bars for `contractId`/`timeframe`, built from the trade stream.
 *
 * Seeded from REST before the first tick lands. Without that seed the first bar would open
 * at whatever printed immediately after subscribing — a candle with a made-up open, a
 * missing high and a volume counted from the wrong moment, sitting at the right edge of the
 * chart where it is most likely to be traded off.
 */
export async function projectXSubscribe(contractId, timeframe, cb) {
  const { ms } = unitOf(timeframe);
  const key = `${contractId}:${timeframe}`;

  let feed = barFeeds.get(key);
  if (!feed) {
    feed = { bar: null, tfMs: ms, listeners: new Set() };
    barFeeds.set(key, feed);
    /* Seeded once per feed rather than per listener — a second pane on the same
     * instrument joins the bar already being built. */
    try {
      const recent = await projectXBars(contractId, timeframe, { limit: 2 });
      const last = recent[recent.length - 1];
      if (last && last.time === bucketOf(Date.now(), ms)) feed.bar = { ...last };
    } catch (e) {
      /* Reported, not thrown: a seed that fails costs one imperfect bar, and refusing the
       * subscription over it would cost the whole live chart. */
      console.warn(`[midorii] ProjectX could not seed the forming bar for ${key} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  feed.listeners.add(cb);

  await ensureStream();
  streamContract(contractId);

  return () => {
    const live = barFeeds.get(key);
    if (!live) return;
    live.listeners.delete(cb);
    if (live.listeners.size > 0) return;
    barFeeds.delete(key);
    unstreamIfIdle(contractId);
    stopReconnectingIfIdle();
  };
}

/** Subscribe `cb` to live quotes for `contractId`. */
export async function projectXSubscribeQuotes(contractId, cb) {
  if (!quoteSubscribers.has(contractId)) quoteSubscribers.set(contractId, new Set());
  quoteSubscribers.get(contractId).add(cb);

  await ensureStream();
  streamContract(contractId);

  return () => {
    const listeners = quoteSubscribers.get(contractId);
    if (!listeners) return;
    listeners.delete(cb);
    if (listeners.size > 0) return;
    quoteSubscribers.delete(contractId);
    unstreamIfIdle(contractId);
    stopReconnectingIfIdle();
  };
}

/**
 * Drop the contract's feeds once nothing is watching it in either form.
 *
 * Both kinds of subscription ride the same pair of hub subscriptions, so neither may
 * unsubscribe on its own account — a chart closing must not silence the quotes an open
 * ticket is being priced against.
 */
function unstreamIfIdle(contractId) {
  if (activeContracts().has(contractId)) return;
  streamed.delete(`contract:${contractId}`);
  /* Dropped with the subscription: the next one starts from the feed's own opening
   * snapshot, and a bid remembered from minutes ago is worse than no bid at all. */
  quoteState.delete(contractId);
  sendWs({ type: 1, target: 'UnsubscribeContractQuotes', arguments: [contractId] });
  sendWs({ type: 1, target: 'UnsubscribeContractTrades', arguments: [contractId] });
}

/**
 * Check credentials without keeping them — what a settings screen calls before saving.
 *
 * Runs on its own session rather than the configured one, so testing a second set of
 * credentials cannot disturb the account currently streaming.
 */
export async function projectXProbe({ userName, apiKey, base, live } = {}) {
  const endpoint = base || DEFAULT_BASE;
  const res = await fetch(`${endpoint}/api/Auth/loginKey`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/plain' },
    body: JSON.stringify({ userName, apiKey }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.token) throw loginFailure(json, res.status);

  const accountsRes = await fetch(`${endpoint}/api/Account/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/plain', Authorization: `Bearer ${json.token}` },
    body: JSON.stringify({ onlyActiveAccounts: true }),
  });
  const accountsJson = await accountsRes.json().catch(() => null);
  const accounts = accountsJson?.accounts ?? [];
  /* The account list is the honest answer to "do these credentials work": a key that
   * authenticates but reaches nothing tradeable is not a working connection. */
  if (accounts.length === 0) {
    throw new Error('ProjectX accepted the key but the account has no active trading accounts on it.');
  }
  return accounts.map((a) => ({
    id: a.id,
    name: a.name,
    balance: a.balance,
    canTrade: a.canTrade,
    simulated: a.simulated,
    live: live === true,
  }));
}
