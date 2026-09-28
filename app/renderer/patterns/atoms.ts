import type { OHLCV } from '../../../src/core/model/ohlcv';
import { detectFairValueGaps } from '../../../src/core/analysis/fvg';
import { atr, ema, sma } from '../../../src/core/native-indicators/classics/math';
import { createBitset, setBit, type Bitset } from './bits';

/**
 * The vocabulary a pattern is written in.
 *
 * A candlestick pattern, taken apart, is a handful of statements about the last few candles:
 * this one closed up, that one had a long lower wick, this one sits inside the one before it.
 * Named patterns are fixed conjunctions of such statements. The search here does not start
 * from the names; it starts from the statements — the atoms — and tries their conjunctions,
 * so a pattern nobody has named is as findable as one everybody has.
 *
 * Every atom is decided on a CLOSED bar. Bar `i` is the signal candle, the last one closed,
 * and an atom that holds at `i` only ever reads bars `i` and earlier. The average true range
 * a candle is measured against is the one from BEFORE that candle, so a wide candle is wide
 * compared with what came before it rather than with an average it has already moved.
 *
 * Why so few thresholds
 * ---------------------
 * Each atom is one fixed cut — a doji is a body under a tenth of the range, not a body
 * under a swept fraction. Every extra threshold multiplies what the search tries, and what
 * it tries is exactly what has to be paid for in the significance test afterwards. A coarse
 * vocabulary that survives the test is worth more than a fine one that cannot.
 *
 * Fair value gaps
 * ---------------
 * Gaps come from the chart's own detector, so a gap the search trades on is the box the FVG
 * study draws. A gap counts from 0.1 ATR up — smaller ones are a tick of noise on any
 * timeframe — and stays "open" until a close goes past its far edge, which is the one reading
 * under which a retest leaves it standing. It is also only watched for 48 bars: a gap from
 * last year that price happens to wander back into is a price level, not a fresh imbalance.
 *
 * Groups
 * ------
 * Atoms that answer the same question about the same candle share a group — bullish and
 * bearish, doji and full body. A conjunction never takes two atoms from one group: the pair
 * is either impossible or says the same thing twice.
 */

/** A bar as the search reads it. `buyVolume` is the taker-buy share of `volume` where the
 *  source records it, and NaN (or absent) where it does not. */
export interface PatternBar extends OHLCV {
    buyVolume?: number;
}

export interface AtomDef {
    /** Stable, short, and what a saved pattern is written in — `c0.bull`, `r0.inside`. */
    id: string;
    label: string;
    group: string;
}

export interface Atom extends AtomDef {
    /** The bars where the atom holds. */
    bits: Bitset;
}

export interface PatternFeatures {
    /** Average true range at each bar — the unit stops are measured in. NaN in warm-up. */
    atr: Float64Array;
    /** Bars where every atom can be decided. */
    ready: Bitset;
    atoms: Atom[];
}

export const ATR_LENGTH = 14;
export const TREND_LENGTH = 50;
export const VOLUME_LENGTH = 20;
export const MOVE_LOOKBACK = 10;
/** Smallest fair value gap that counts, in ATRs at its confirming bar. */
export const FVG_MIN_ATR = 0.1;
/** Bars after its confirming bar that a gap is still watched for. */
export const FVG_MAX_AGE = 48;

/** How far back a pattern reaches: the signal candle and the two before it. */
export const CANDLE_DEPTH = 3;

const CANDLE_NAMES = ['Signal candle', 'Candle before', 'Two candles back'] as const;
const OLDER_NAMES = ['the one before', 'the one before it', 'the one before it'] as const;

/** UTC hours, [from, to). */
const SESSIONS = [
    { id: 'asia', label: 'Asia hours (00–07 UTC)', from: 0, to: 7 },
    { id: 'london', label: 'London hours (07–13 UTC)', from: 7, to: 13 },
    { id: 'newyork', label: 'New York hours (13–20 UTC)', from: 13, to: 20 },
    { id: 'late', label: 'Late hours (20–24 UTC)', from: 20, to: 24 },
] as const;

interface AtomRule extends AtomDef {
    test(i: number): boolean;
}

/**
 * Every atom's bars, for one series.
 *
 * Throws on a series too short to warm up, rather than returning atoms that hold nowhere —
 * a search over nothing reports "no pattern works", which is a different claim.
 */
export function buildFeatures(bars: readonly PatternBar[]): PatternFeatures {
    const n = bars.length;
    const open = new Float64Array(n);
    const high = new Float64Array(n);
    const low = new Float64Array(n);
    const close = new Float64Array(n);
    const volume = new Float64Array(n);
    const buy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const b = bars[i]!;
        open[i] = b.open;
        high[i] = b.high;
        low[i] = b.low;
        close[i] = b.close;
        volume[i] = b.volume ?? 0;
        buy[i] = b.buyVolume ?? Number.NaN;
    }

    const atrs = Float64Array.from(atr(bars, ATR_LENGTH));
    const trend = ema(Array.from(close), TREND_LENGTH);
    const volumeAverage = sma(Array.from(volume), VOLUME_LENGTH);

    /* A candle's size is read against the ATR of the bar before it, so the candle two back
     * needs the ATR three bars back — which is also what moves the first ready bar. */
    const ready = createBitset(n);
    let readyCount = 0;
    for (let i = Math.max(CANDLE_DEPTH, MOVE_LOOKBACK); i < n; i++) {
        if (!Number.isFinite(atrs[i - CANDLE_DEPTH]!) || !Number.isFinite(atrs[i]!)) continue;
        if (!Number.isFinite(trend[i]!)) continue;
        if (!Number.isFinite(volumeAverage[i - 1]!)) continue;
        setBit(ready, i);
        readyCount++;
    }
    if (readyCount === 0) {
        throw new Error(`Not enough bars to read a pattern — ${n} given, at least ${TREND_LENGTH + CANDLE_DEPTH} needed.`);
    }

    const rules: AtomRule[] = [];

    for (let k = 0; k < CANDLE_DEPTH; k++) {
        const name = CANDLE_NAMES[k]!;
        const range = (i: number): number => high[i - k]! - low[i - k]!;
        const body = (i: number): number => Math.abs(close[i - k]! - open[i - k]!);
        const upper = (i: number): number => high[i - k]! - Math.max(open[i - k]!, close[i - k]!);
        const lower = (i: number): number => Math.min(open[i - k]!, close[i - k]!) - low[i - k]!;
        const share = (part: (i: number) => number) => (i: number): number => {
            const r = range(i);
            return r > 0 ? part(i) / r : Number.NaN;
        };
        const bodyShare = share(body);
        const upperShare = share(upper);
        const lowerShare = share(lower);
        const size = (i: number): number => range(i) / atrs[i - k - 1]!;

        rules.push(
            { id: `c${k}.bull`, label: `${name}: bullish`, group: `c${k}.dir`, test: (i) => close[i - k]! > open[i - k]! },
            { id: `c${k}.bear`, label: `${name}: bearish`, group: `c${k}.dir`, test: (i) => close[i - k]! < open[i - k]! },
            { id: `c${k}.doji`, label: `${name}: doji (body under 10% of range)`, group: `c${k}.body`, test: (i) => bodyShare(i) < 0.1 },
            { id: `c${k}.small`, label: `${name}: small body (10–40% of range)`, group: `c${k}.body`, test: (i) => bodyShare(i) >= 0.1 && bodyShare(i) < 0.4 },
            { id: `c${k}.full`, label: `${name}: full body (70%+ of range)`, group: `c${k}.body`, test: (i) => bodyShare(i) >= 0.7 },
            { id: `c${k}.noupper`, label: `${name}: no upper wick`, group: `c${k}.upper`, test: (i) => upperShare(i) < 0.05 },
            { id: `c${k}.longupper`, label: `${name}: long upper wick (half the range+)`, group: `c${k}.upper`, test: (i) => upperShare(i) >= 0.5 },
            { id: `c${k}.nolower`, label: `${name}: no lower wick`, group: `c${k}.lower`, test: (i) => lowerShare(i) < 0.05 },
            { id: `c${k}.longlower`, label: `${name}: long lower wick (half the range+)`, group: `c${k}.lower`, test: (i) => lowerShare(i) >= 0.5 },
            { id: `c${k}.narrow`, label: `${name}: narrow (under 0.5 ATR)`, group: `c${k}.size`, test: (i) => size(i) < 0.5 },
            { id: `c${k}.wide`, label: `${name}: wide (1.5 ATR+)`, group: `c${k}.size`, test: (i) => size(i) >= 1.5 },
        );
    }

    for (let k = 0; k < CANDLE_DEPTH - 1; k++) {
        const newer = CANDLE_NAMES[k]!;
        const older = OLDER_NAMES[k]!;
        const j = (i: number): number => i - k;
        const p = (i: number): number => i - k - 1;
        const top = (x: number): number => Math.max(open[x]!, close[x]!);
        const bottom = (x: number): number => Math.min(open[x]!, close[x]!);

        rules.push(
            {
                id: `r${k}.inside`, label: `${newer} inside ${older}`, group: `r${k}.span`,
                test: (i) => high[j(i)]! < high[p(i)]! && low[j(i)]! > low[p(i)]!,
            },
            {
                id: `r${k}.outside`, label: `${newer} engulfs the range of ${older}`, group: `r${k}.span`,
                test: (i) => high[j(i)]! > high[p(i)]! && low[j(i)]! < low[p(i)]!,
            },
            {
                id: `r${k}.breakup`, label: `${newer} closes above the high of ${older}`, group: `r${k}.close`,
                test: (i) => close[j(i)]! > high[p(i)]!,
            },
            {
                id: `r${k}.breakdown`, label: `${newer} closes below the low of ${older}`, group: `r${k}.close`,
                test: (i) => close[j(i)]! < low[p(i)]!,
            },
            {
                id: `r${k}.engulf`, label: `${newer}'s body engulfs the body of ${older}`, group: `r${k}.engulf`,
                test: (i) => top(j(i)) >= top(p(i)) && bottom(j(i)) <= bottom(p(i))
                    && top(j(i)) - bottom(j(i)) > top(p(i)) - bottom(p(i)),
            },
            {
                id: `r${k}.sweephigh`, label: `${newer} takes the high of ${older} and closes back below it`, group: `r${k}.sweephigh`,
                test: (i) => high[j(i)]! > high[p(i)]! && close[j(i)]! < high[p(i)]!,
            },
            {
                id: `r${k}.sweeplow`, label: `${newer} takes the low of ${older} and closes back above it`, group: `r${k}.sweeplow`,
                test: (i) => low[j(i)]! < low[p(i)]! && close[j(i)]! > low[p(i)]!,
            },
        );
    }

    rules.push(
        { id: 'x.trendup', label: `Close above its ${TREND_LENGTH}-bar average`, group: 'x.trend', test: (i) => close[i]! > trend[i]! },
        { id: 'x.trenddown', label: `Close below its ${TREND_LENGTH}-bar average`, group: 'x.trend', test: (i) => close[i]! < trend[i]! },
        {
            id: 'x.rally', label: `Up more than 2 ATR over the last ${MOVE_LOOKBACK} bars`, group: 'x.move',
            test: (i) => close[i]! - close[i - MOVE_LOOKBACK]! > 2 * atrs[i]!,
        },
        {
            id: 'x.drop', label: `Down more than 2 ATR over the last ${MOVE_LOOKBACK} bars`, group: 'x.move',
            test: (i) => close[i]! - close[i - MOVE_LOOKBACK]! < -2 * atrs[i]!,
        },
        ...SESSIONS.map((s): AtomRule => ({
            id: `x.${s.id}`, label: `Signal candle opens in ${s.label}`, group: 'x.session',
            test: (i) => {
                const hour = new Date(bars[i]!.time).getUTCHours();
                return hour >= s.from && hour < s.to;
            },
        })),
        {
            id: 'x.volhigh', label: `Signal candle volume 1.5× its ${VOLUME_LENGTH}-bar average+`, group: 'x.volume',
            test: (i) => volume[i]! >= 1.5 * volumeAverage[i - 1]!,
        },
        {
            id: 'x.vollow', label: `Signal candle volume under 0.6× its ${VOLUME_LENGTH}-bar average`, group: 'x.volume',
            test: (i) => volume[i]! < 0.6 * volumeAverage[i - 1]!,
        },
        {
            id: 'x.buyers', label: 'Takers bought 55%+ of the signal candle', group: 'x.flow',
            test: (i) => volume[i]! > 0 && buy[i]! / volume[i]! >= 0.55,
        },
        {
            id: 'x.sellers', label: 'Takers sold 55%+ of the signal candle', group: 'x.flow',
            test: (i) => volume[i]! > 0 && buy[i]! / volume[i]! <= 0.45,
        },
    );

    const fvg = fvgStates(bars, atrs);
    const flag = (states: Uint8Array) => (i: number): boolean => states[i] === 1;
    rules.push(
        { id: 'f.bullnew', label: 'Signal candle completes a bullish FVG', group: 'f.new', test: flag(fvg.bullNew) },
        { id: 'f.bearnew', label: 'Signal candle completes a bearish FVG', group: 'f.new', test: flag(fvg.bearNew) },
        { id: 'f.bulltap', label: 'Signal candle trades into an open bullish FVG', group: 'f.tap', test: flag(fvg.bullTap) },
        { id: 'f.beartap', label: 'Signal candle trades into an open bearish FVG', group: 'f.tap', test: flag(fvg.bearTap) },
        {
            id: 'f.bullhold', label: 'Signal candle dips into an open bullish FVG and closes above it',
            group: 'f.hold', test: flag(fvg.bullHold),
        },
        {
            id: 'f.bearhold', label: 'Signal candle reaches into an open bearish FVG and closes below it',
            group: 'f.hold', test: flag(fvg.bearHold),
        },
        { id: 'f.bullbreak', label: 'Signal candle closes below an open bullish FVG', group: 'f.break', test: flag(fvg.bullBreak) },
        { id: 'f.bearbreak', label: 'Signal candle closes above an open bearish FVG', group: 'f.break', test: flag(fvg.bearBreak) },
    );

    const atoms: Atom[] = rules.map(({ test, ...def }) => {
        const bits = createBitset(n);
        for (let i = 0; i < n; i++) {
            // NaN comparisons are false, so a candle with no range simply matches nothing.
            if ((ready[i >>> 5]! & (1 << (i & 31))) !== 0 && test(i)) setBit(bits, i);
        }
        return { ...def, bits };
    });

    return { atr: atrs, ready, atoms };
}

interface FvgStates {
    bullNew: Uint8Array;
    bearNew: Uint8Array;
    bullTap: Uint8Array;
    bearTap: Uint8Array;
    bullHold: Uint8Array;
    bearHold: Uint8Array;
    bullBreak: Uint8Array;
    bearBreak: Uint8Array;
}

/**
 * What each bar did with the fair value gaps around it.
 *
 * A gap is confirmed on its third bar and only acted on from the bar after — the detector's
 * own rule that a bar cannot fill the gap it creates. The bar that closes past a gap still
 * traded into it while it was open, so it both taps and breaks it.
 */
function fvgStates(bars: readonly PatternBar[], atrs: Float64Array): FvgStates {
    const n = bars.length;
    const states: FvgStates = {
        bullNew: new Uint8Array(n), bearNew: new Uint8Array(n),
        bullTap: new Uint8Array(n), bearTap: new Uint8Array(n),
        bullHold: new Uint8Array(n), bearHold: new Uint8Array(n),
        bullBreak: new Uint8Array(n), bearBreak: new Uint8Array(n),
    };
    const zones = detectFairValueGaps(bars, { mitigation: 'break', show: 'all' });
    for (const zone of zones) {
        // A gap before the ATR exists has no size to be measured against, so it does not count.
        if (!(zone.size >= FVG_MIN_ATR * atrs[zone.index]!)) continue;
        const bull = zone.direction === 'bull';
        (bull ? states.bullNew : states.bearNew)[zone.index] = 1;

        const last = Math.min(n - 1, zone.index + FVG_MAX_AGE, zone.mitigatedIndex ?? Number.POSITIVE_INFINITY);
        for (let i = zone.index + 1; i <= last; i++) {
            const bar = bars[i]!;
            if (bull) {
                if (bar.low <= zone.top) {
                    states.bullTap[i] = 1;
                    if (bar.close > zone.top) states.bullHold[i] = 1;
                }
                if (i === zone.mitigatedIndex) states.bullBreak[i] = 1;
            } else {
                if (bar.high >= zone.bottom) {
                    states.bearTap[i] = 1;
                    if (bar.close < zone.bottom) states.bearHold[i] = 1;
                }
                if (i === zone.mitigatedIndex) states.bearBreak[i] = 1;
            }
        }
    }
    return states;
}

/** Every atom the vocabulary has, without computing any bars — for labels. */
export function atomCatalog(): AtomDef[] {
    const bars: PatternBar[] = [];
    // The catalog is the same whatever the bars are; a flat series long enough to warm up
    // is the cheapest way to get it from the one place atoms are defined.
    for (let i = 0; i < TREND_LENGTH + CANDLE_DEPTH + 2; i++) {
        bars.push({ time: i * 60_000, open: 1, high: 1.01, low: 0.99, close: 1, volume: 1 });
    }
    return buildFeatures(bars).atoms.map(({ bits: _bits, ...def }) => def);
}
