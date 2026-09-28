// The ONE chart document, worn by every mode's chart.
//
// The app builds three charts — the Chart tab's, the Trading Bot tab's, and a replay
// session's — and each one used to keep a workspace document of its own (or, in the
// replay's case, none at all). A candle colour picked on one was a candle colour picked
// on one: the other two kept whatever they had, and a replay started on the factory look
// every time. This module makes the three wear the same document instead.
//
// What is SHARED: everything the workspace persists — the renderer's cosmetics, the
// drawings, the indicator ledger, favorites, the docked panels, the timezone.
// What stays LOCAL: the market (a mode's symbol and timeframe are its own business — the
// Chart tab's BTC hour chart has nothing to say about which market a bot trades) and the
// app's own position/alert/quote indicators, each of which is driven by a controller that
// only exists on the chart that put it there.
//
// The seam is the workspace's own storage adapter, not a layer above it: a synchronous
// `get` restores BEFORE the first cell is built, so a chart opens already wearing the
// shared look rather than flashing the defaults and correcting itself. Charts that are
// already open are pushed the new document as it is written — only one of them is ever on
// screen (the tabs are mutually exclusive), but coming back to a hidden one must not show
// a stale look either.
import type { VelaStorage } from '../../../src/widget';
import { decodeState, encodeState, type ChartState, type VelaWorkspace, type WorkspaceState } from '../../../src/workspace';
import type { PersistedNativeEntry } from '../../../src/state/document';
import { ALERT_INDICATOR_TYPE } from '../alerts/alertIndicator';
import { QUOTE_INDICATOR_TYPE } from '../quotes/quoteIndicator';
import { REPLAY_INDICATOR_TYPE, TRADE_INDICATOR_TYPE } from '../replay/replayIndicator';

/** Where the shared document lives. */
const SHARED_KEY = 'midorii-chart-doc';

/** Where each mode's own market is remembered, by mode name. */
const MARKET_KEY = 'midorii-chart-market:';

/**
 * The documents written before the charts shared one, by mode.
 *
 * Read once, so an app that has been used keeps its look and its market instead of
 * opening on the factory defaults after the update. The Chart tab's document wins as the
 * shared one — it is the chart people dress.
 */
const LEGACY_KEY: Record<string, string> = {
    chart: 'midorii-workspace',
    bot: 'midorii-bot-workspace',
};

/**
 * The native indicators the APP puts on a chart, as opposed to the ones a person adds.
 *
 * Each is drawn by a controller that exists on exactly one chart — a replay's positions,
 * a bot's, a broker's, the price alerts, the two-sided quote — so none of them may travel
 * in the shared ledger: restored anywhere else it would be a set of lines with nothing
 * behind them, and on the chart that owns it a SECOND copy of what is already there.
 */
const APP_INDICATORS: readonly string[] = [ALERT_INDICATOR_TYPE, QUOTE_INDICATOR_TYPE, TRADE_INDICATOR_TYPE, REPLAY_INDICATOR_TYPE];

const nativeType = (entry: PersistedNativeEntry): string => typeof entry === 'string' ? entry : entry.type;

/** A chart's market — the one thing each mode keeps to itself. */
export interface ChartMarket {
    /** Prefixed, the way the workspace spells it: `binance:BTCUSDT`. */
    symbol: string;
    timeframe: string;
}

/** What a mode hands to its workspace, and then its workspace to. */
export interface SharedChart {
    /** The `persist` key — the mode's name, so the adapter below knows whose write it is. */
    key: string;
    /** The `storage` adapter that splits the mode's document into shared + local. */
    storage: VelaStorage;
    /** Follow the shared document from here on: this workspace's edits reach the others,
     *  and theirs reach it. Call once, after the workspace is constructed. */
    attach(ws: VelaWorkspace): void;
}

interface Member {
    mode: string;
    ws: VelaWorkspace | null;
    /** Whether this mode remembers the market it was last left on. A replay's does not —
     *  its market comes from the session that was set up, never from a previous one. */
    remembers: boolean;
    seed: ChartMarket;
    /** This member was just handed the shared document and has not answered yet. The
     *  answer is a write of its own — see {@link push} on why it must go no further. */
    converging: boolean;
}

const members: Member[] = [];

/** The shared document every member is currently converged on, as written. Null until one
 *  has been read or written — the guard that stops a pushed document echoing back. */
let sharedJson: string | null = null;

let migrated = false;

function read(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch (err) {
        console.error('[midorii] could not read the chart document', err);
        return null;
    }
}

function write(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch (err) {
        console.error('[midorii] could not save the chart document', err);
    }
}

/**
 * Carry the pre-sharing documents over, once.
 *
 * The Chart tab's becomes the shared one; each mode's market is lifted out of its own old
 * document so a restart still opens on the market it was left on. Runs on the first
 * `shareChartDoc` call rather than at import, and only while nothing shared exists yet.
 */
function migrate(): void {
    if (migrated) return;
    migrated = true;
    if (read(SHARED_KEY) != null) return;
    for (const [mode, key] of Object.entries(LEGACY_KEY)) {
        const doc = decodeState(read(key) ?? '');
        if (!doc) continue;
        const market = marketOf(doc);
        if (market) write(MARKET_KEY + mode, JSON.stringify(market));
        if (mode === 'chart') write(SHARED_KEY, encodeState(strip(doc)));
    }
}

/** The market a document's live chart is on (its first entry — every chart here is a
 *  single-cell workspace). Null when the document carries none. */
function marketOf(doc: WorkspaceState): ChartMarket | null {
    const cell = doc.charts[0];
    if (!cell?.symbol || !cell.timeframe) return null;
    // The workspace mirrors the venue into `provider` beside the prefixed symbol; older
    // documents stored it there beside a BARE one. Weld it back on either way.
    const symbol = cell.symbol.includes(':') || !cell.provider ? cell.symbol : `${cell.provider}:${cell.symbol}`;
    return { symbol, timeframe: cell.timeframe };
}

function storedMarket(mode: string): ChartMarket | null {
    const raw = read(MARKET_KEY + mode);
    if (!raw) return null;
    try {
        const m = JSON.parse(raw) as Partial<ChartMarket>;
        return typeof m.symbol === 'string' && typeof m.timeframe === 'string' ? { symbol: m.symbol, timeframe: m.timeframe } : null;
    } catch {
        return null;
    }
}

/**
 * The shared half of a document: the market out, the app's own indicators out.
 *
 * Only the FIRST chart entry survives. Every chart here is a single-cell workspace, so a
 * second entry is a dormant slot from some other mode's grid — state that would follow
 * the document around without ever being looked at.
 */
function strip(doc: WorkspaceState): WorkspaceState {
    const cell = doc.charts[0];
    if (!cell) return { ...doc, charts: [] };
    const { symbol: _s, provider: _p, timeframe: _t, ...rest } = cell;
    const natives = cell.indicators?.natives.filter((entry) => !APP_INDICATORS.includes(nativeType(entry)));
    return {
        ...doc,
        charts: [{ ...rest, ...(cell.indicators ? { indicators: { ...cell.indicators, natives: natives ?? [] } } : {}) }],
    };
}

/**
 * The shared document dressed for one chart: its market back in, and the app indicators
 * it is CURRENTLY carrying back in the ledger.
 *
 * Both halves matter. Without the market the cell would boot with no symbol at all (a
 * restored slot replaces the seed rather than merging with it). Without the indicators
 * the ledger converges as a multiset and takes them straight back off — a replay would
 * lose the very lines drawing its position the moment anything elsewhere was edited.
 */
function dress(doc: WorkspaceState, market: ChartMarket, appIndicators: readonly string[]): WorkspaceState {
    const cell: ChartState = doc.charts[0] ?? { id: 'c1' };
    const natives = [...(cell.indicators?.natives ?? []), ...appIndicators];
    return {
        ...doc,
        charts: [{
            ...cell,
            symbol: market.symbol,
            provider: undefined,
            timeframe: market.timeframe,
            ...(cell.indicators || appIndicators.length > 0
                ? { indicators: { manifest: cell.indicators?.manifest ?? [], natives } }
                : {}),
        }],
    };
}

/** The app indicators a live chart is carrying right now — what {@link dress} must put
 *  back so the converging ledger leaves them alone. */
function appIndicatorsOn(ws: VelaWorkspace): string[] {
    return ws.chart.presentNativeIndicators().filter((type) => APP_INDICATORS.includes(type));
}

/** The market a live chart is on right now (the requested identity, so a switch still
 *  loading is not lost). */
function liveMarket(ws: VelaWorkspace, fallback: ChartMarket): ChartMarket {
    const m = ws.chart.market;
    return m.symbol && m.timeframe ? { symbol: m.symbol, timeframe: m.timeframe } : fallback;
}

/**
 * Put the shared document on one member's chart, keeping its own market and indicators.
 *
 * Applying it makes that workspace persist in turn, a debounce later — a write this module
 * then sees like any other. Usually it is the document verbatim and the guard below stops
 * there, but a chart is entitled to answer with something slightly different (a renderer
 * that fills a config in, a market still switching), and that difference must NOT be sent
 * back out: two charts each correcting the other's answer would push at each other for as
 * long as the app is open. So the answer is marked in advance and spent on arrival — a
 * follower's echo is never news, and the edit that WAS news has already been written.
 */
function push(member: Member, doc: WorkspaceState): void {
    const ws = member.ws;
    if (!ws) return;
    member.converging = true;
    ws.applyState(dress(doc, liveMarket(ws, member.seed), appIndicatorsOn(ws)));
}

/**
 * Join a mode's chart to the shared document.
 *
 * `seed` is the market the chart opens on when nothing is remembered for this mode.
 * `remembers: false` pins it: the chart always opens on the seed, and never writes a
 * market of its own — what a replay session needs, since its market is the one that was
 * set up rather than the one it was last left on.
 */
export function shareChartDoc(mode: string, seed: ChartMarket, options: { remembers?: boolean } = {}): SharedChart {
    migrate();
    const member: Member = { mode, ws: null, remembers: options.remembers !== false, seed, converging: false };
    // One member per mode: a mode that builds its chart again (a second replay session)
    // replaces the entry rather than leaving a destroyed workspace behind to push to.
    const existing = members.findIndex((m) => m.mode === mode);
    if (existing >= 0) members.splice(existing, 1, member);
    else members.push(member);

    const storage: VelaStorage = {
        get: () => {
            const doc = decodeState(read(SHARED_KEY) ?? '');
            if (!doc) return null; // nothing shared yet — the workspace boots on its own options
            sharedJson ??= encodeState(doc);
            const market = (member.remembers ? storedMarket(mode) : null) ?? seed;
            // No chart is live yet at boot: the app indicators are added by whatever wires
            // this chart, a moment after it is built.
            return encodeState(dress(doc, market, []));
        },
        set: (_key, value) => {
            const doc = decodeState(value);
            if (!doc) return;
            if (member.remembers) {
                const market = marketOf(doc);
                if (market) write(MARKET_KEY + mode, JSON.stringify(market));
            }
            // This write is the answer to a document this member was just handed (see push).
            if (member.converging) {
                member.converging = false;
                return;
            }
            const shared = strip(doc);
            const json = encodeState(shared);
            // Unchanged — a write that only moved the market. Not news for the others.
            if (json === sharedJson) return;
            sharedJson = json;
            write(SHARED_KEY, json);
            for (const other of members) {
                if (other !== member) push(other, shared);
            }
        },
    };

    return {
        key: mode,
        storage,
        attach: (ws) => {
            member.ws = ws;
        },
    };
}
