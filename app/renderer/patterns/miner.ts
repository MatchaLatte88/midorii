import { runBacktest } from '../../../shared/engine/backtest';
import type { Costs } from '../../../shared/engine/broker';
import { breathe } from '../backtest/sweepRunner';
import { buildFeatures, type AtomDef, type PatternBar, type PatternFeatures } from './atoms';
import { andInto, countAndRange, countRange, createBitset, type Bitset } from './bits';
import { computeOutcomes, type ExitRule, type Outcomes } from './outcomes';
import { buildPatternStrategy, patternBits, type PatternSide } from './patternStrategy';
import { StatsAccumulator, pValue, scoreSignals, walkTrades, type PatternStats, type Segment } from './stats';

/**
 * Searching for candlestick patterns that pay — and refusing to believe the first answer.
 *
 * The search itself is simple: every conjunction of one to three atoms (see atoms.ts), both
 * ways, scored on the earliest stretch of history by how far its average trade sits above
 * zero in standard errors. What makes it worth running is everything around that.
 *
 * Three stretches, in time order
 * ------------------------------
 *   discovery    the search looks here and nowhere else
 *   validation   the survivors are asked again, once
 *   holdout      only what passed validation is ever shown here
 *
 * Try forty thousand patterns on one stretch of history and the best of them will look
 * superb by chance alone. Validation is the first defence: a pattern fitted to noise has no
 * reason to work on bars it never saw. The holdout is the second, because validation is
 * itself a filter — someone reading the list picks by it — and the only honest number is one
 * nothing was chosen on. That is why the holdout is withheld for patterns that failed
 * validation: shown for all of them, it would become one more thing to pick by.
 *
 * What "best by chance" looks like, measured
 * ------------------------------------------
 * The null test runs the whole search again with the trades slid in time against the
 * candles — the outcome of bar `i` is handed to bar `i + shift`, wrapping around the
 * discovery stretch. The candles keep their patterns and the outcomes keep their own runs
 * and volatility, but the link between the two is cut. Whatever the search finds then is
 * pure selection luck, and the best score of each such run is what a real finding has to
 * beat. It is slower than a formula and worth it: the candidates overlap heavily, which
 * makes a textbook correction for the number of tests far too strict, and trade outcomes
 * cluster in time, which makes the formula's own assumption false.
 *
 * The Bonferroni-adjusted p-value is reported beside it as the conservative reading.
 */

export interface MineOptions {
    bars: readonly PatternBar[];
    exit: ExitRule;
    costs: Required<Costs>;
    /** Largest number of atoms in one pattern, 1 to 3 — besides the anchor, when there is one. */
    maxDepth: number;
    /**
     * An atom every pattern must contain, or absent for a free search. Anchoring on, say, a
     * retest of an open fair value gap asks a narrower question — which candles at THAT place
     * pay — and a narrower question tries fewer patterns, which is exactly what makes a real
     * finding easier to tell from luck.
     */
    anchor?: string | null;
    /** Fewest trades a pattern needs in discovery to be scored at all. */
    minTrades: number;
    /** Share of the bars that discovery gets. */
    discoveryFraction?: number;
    /** Share of the bars that validation gets; the holdout is what is left. */
    validationFraction?: number;
    /** How many times the search is rerun on slid outcomes. 0 skips the null test. */
    nullRuns?: number;
    seed?: number;
    /** How many distinct patterns the result lists. */
    keep?: number;
    /** Balance and risk for the engine's confirmation runs. */
    balance?: number;
    riskPct?: number;
    onProgress?: (progress: MineProgress) => void;
    shouldStop?: () => boolean;
}

export type MineStage = 'search' | 'null' | 'validate' | 'confirm';

export interface MineProgress {
    stage: MineStage;
    /** Within the stage. */
    done: number;
    total: number;
    elapsedMs: number;
}

export interface SegmentInfo {
    from: number;
    to: number;
    /** Bar times — the first bar's own, and the last bar's own. */
    fromTime: number;
    toTime: number;
}

/** What a random entry in each direction averaged on a stretch — the bar every pattern is
 *  read against. A long in a rising market makes money without knowing anything. */
export interface Baseline {
    long: number;
    short: number;
}

/** What the Broker made of a pattern over validation and holdout together. */
export interface EngineCheck {
    trades: number;
    netPnl: number;
    returnPct: number;
    maxDrawdownPct: number;
    winRate: number | null;
    profitFactor: number | null;
}

export interface PatternCandidate {
    atoms: string[];
    side: PatternSide;
    discovery: PatternStats;
    validation: PatternStats;
    /** Null unless validation passed — see the file comment. */
    holdout: PatternStats | null;
    /** One-sided p-value of the discovery score, times the number of patterns scored. */
    pAdjusted: number;
    /** Whether the discovery score beat 95% of the best scores luck produced. Null without
     *  a null test. */
    beatsNull: boolean | null;
    validated: boolean;
    engine: EngineCheck | null;
}

export interface MineResult {
    barCount: number;
    exit: ExitRule;
    costs: Required<Costs>;
    maxDepth: number;
    minTrades: number;
    anchor: string | null;
    segments: { discovery: SegmentInfo; validation: SegmentInfo; holdout: SegmentInfo };
    baseline: { discovery: Baseline; validation: Baseline; holdout: Baseline };
    /** Patterns scored — each with enough trades, each direction counted once. */
    tested: number;
    bestT: number;
    /** The best discovery score of each null run. */
    nullBest: number[];
    /** The score luck alone reached one run in twenty. Null without a null test. */
    nullThreshold: number | null;
    candidates: PatternCandidate[];
    atoms: AtomDef[];
    elapsedMs: number;
}

/** Raised when a search is stopped on request, so a caller can tell it apart from a fault. */
export class PatternSearchCancelled extends Error {
    constructor() {
        super('The pattern search was stopped');
        this.name = 'PatternSearchCancelled';
    }
}

/** How many of the best-scoring patterns are kept while searching, before near-duplicates
 *  are folded together. Generous, because most of the top of the list is one pattern
 *  written several ways. */
const POOL_SIZE = 600;

/** Two patterns whose trades overlap this much are the same finding. */
const DUPLICATE_OVERLAP = 0.6;

/** Fewest validation trades a pattern needs before validation can pass it. */
const MIN_VALIDATION_TRADES = 10;

/** How many validated patterns get a full engine run. */
const CONFIRM_LIMIT = 12;

const BREATHE_EVERY_MS = 30;

interface Scored {
    atoms: number[];
    side: PatternSide;
    t: number;
}

/** A min-heap on `t`, so the pool keeps the best `POOL_SIZE` without sorting as it goes. */
class Pool {
    private readonly items: Scored[] = [];

    constructor(private readonly capacity: number) {}

    offer(item: Scored): void {
        const items = this.items;
        if (items.length < this.capacity) {
            items.push(item);
            this.up(items.length - 1);
            return;
        }
        if (item.t <= items[0]!.t) return;
        items[0] = item;
        this.down(0);
    }

    sorted(): Scored[] {
        return [...this.items].sort((a, b) => b.t - a.t);
    }

    private up(k: number): void {
        const items = this.items;
        while (k > 0) {
            const parent = (k - 1) >> 1;
            if (items[parent]!.t <= items[k]!.t) return;
            [items[parent], items[k]] = [items[k]!, items[parent]!];
            k = parent;
        }
    }

    private down(k: number): void {
        const items = this.items;
        for (;;) {
            const l = 2 * k + 1;
            const r = l + 1;
            let smallest = k;
            if (l < items.length && items[l]!.t < items[smallest]!.t) smallest = l;
            if (r < items.length && items[r]!.t < items[smallest]!.t) smallest = r;
            if (smallest === k) return;
            [items[smallest], items[k]] = [items[k]!, items[smallest]!];
            k = smallest;
        }
    }
}

/** A seeded generator, so the same search on the same bars slides the same way twice. */
function mulberry32(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

interface SideOutcomes {
    r: Float64Array;
    exits: Int32Array;
}

function sidesOf(outcomes: Outcomes): Record<PatternSide, SideOutcomes> {
    return {
        long: { r: outcomes.longR, exits: outcomes.longExit },
        short: { r: outcomes.shortR, exits: outcomes.shortExit },
    };
}

/**
 * The outcomes slid by `shift` bars within `segment`, wrapping at its end. Each trade keeps
 * its own length, so one that took five bars still takes five — only which candle it is
 * attributed to changes.
 */
function slide(side: SideOutcomes, segment: Segment, shift: number): SideOutcomes {
    const r = new Float64Array(side.r.length).fill(Number.NaN);
    const exits = new Int32Array(side.exits.length).fill(-1);
    const length = segment.to - segment.from;
    for (let i = segment.from; i < segment.to; i++) {
        const source = segment.from + ((i - segment.from + shift) % length);
        const value = side.r[source]!;
        if (Number.isNaN(value)) continue;
        r[i] = value;
        exits[i] = i + (side.exits[source]! - source);
    }
    return { r, exits };
}

/**
 * The atoms a search combines, already narrowed to the anchor.
 *
 * Built once per mine rather than per search: every null run combines the same atoms, only
 * the outcomes under them move.
 */
interface Vocabulary {
    /** Index into `features.atoms` of the anchor, or null. */
    anchor: number | null;
    /** The anchor's bars, or null for a free search. */
    base: Bitset | null;
    /** Indices into `features.atoms` of the atoms a pattern may add. */
    atoms: number[];
    /** Each atom's bars, ANDed with the anchor's — indexed like `features.atoms`. */
    bits: Bitset[];
    groups: string[];
}

function vocabularyOf(features: PatternFeatures, anchorId: string | null): Vocabulary {
    const all = features.atoms;
    const anchor = anchorId == null ? null : all.findIndex((a) => a.id === anchorId);
    if (anchor === -1) throw new Error(`Unknown anchor "${anchorId}".`);
    const base = anchor == null ? null : all[anchor]!.bits;
    const anchorGroup = anchor == null ? null : all[anchor]!.group;
    return {
        anchor,
        base,
        atoms: all.map((_a, k) => k).filter((k) => all[k]!.group !== anchorGroup),
        bits: all.map((a) => (base ? andInto(createBitset(a.bits.length * 32), a.bits, base) : a.bits)),
        groups: all.map((a) => a.group),
    };
}

interface SearchInput {
    vocabulary: Vocabulary;
    sides: Record<PatternSide, SideOutcomes>;
    segment: Segment;
    maxDepth: number;
    minTrades: number;
    pool: Pool | null;
    tick: () => Promise<void>;
}

/**
 * Every conjunction of up to `maxDepth` atoms from different groups, scored both ways.
 *
 * Pruned the way frequent-itemset searches are: a conjunction with fewer signals than
 * `minTrades` cannot yield enough trades, and neither can anything built on top of it. A
 * conjunction whose signals are exactly those of one of its parts says nothing that part did
 * not, and is skipped rather than counted as a second test of the same thing.
 */
async function search(input: SearchInput): Promise<{ tested: number; bestT: number }> {
    const { vocabulary, sides, segment, maxDepth, minTrades, pool, tick } = input;
    const { from, to } = segment;
    const { bits: atomBits, groups } = vocabulary;
    const size = atomBits[0]!.length * 32;
    const prefix = vocabulary.anchor == null ? [] : [vocabulary.anchor];

    const support = atomBits.map((b) => countRange(b, from, to));
    const usable = vocabulary.atoms.filter((k) => support[k]! >= minTrades);
    const anchorSupport = vocabulary.base ? countRange(vocabulary.base, from, to) : Number.NaN;

    let tested = 0;
    let bestT = Number.NEGATIVE_INFINITY;
    const acc = new StatsAccumulator();

    const score = (bits: Bitset, ids: number[]): void => {
        for (const side of ['long', 'short'] as const) {
            acc.reset();
            walkTrades(bits, sides[side].r, sides[side].exits, segment, (_i, r) => acc.add(r));
            if (acc.n < minTrades) continue;
            tested++;
            const t = acc.t();
            if (Number.isNaN(t)) continue;
            if (t > bestT) bestT = t;
            pool?.offer({ atoms: [...prefix, ...ids], side, t });
        }
    };

    // The anchor on its own is a pattern too — whether the place alone pays is the first question.
    if (vocabulary.base && anchorSupport >= minTrades) score(vocabulary.base, []);

    const pair = createBitset(size);
    const triple = createBitset(size);

    for (let x = 0; x < usable.length; x++) {
        const a = usable[x]!;
        // Adding an atom the anchor already implies changes nothing about which bars fire.
        if (support[a] !== anchorSupport) score(atomBits[a]!, [a]);
        await tick();
        if (maxDepth < 2) continue;

        for (let y = x + 1; y < usable.length; y++) {
            const b = usable[y]!;
            if (groups[a] === groups[b]) continue;
            const ab = countAndRange(atomBits[a]!, atomBits[b]!, from, to);
            if (ab < minTrades || ab === support[a] || ab === support[b]) continue;
            andInto(pair, atomBits[a]!, atomBits[b]!);
            score(pair, [a, b]);
            if (maxDepth < 3) continue;

            for (let z = y + 1; z < usable.length; z++) {
                const c = usable[z]!;
                if (groups[c] === groups[a] || groups[c] === groups[b]) continue;
                const abc = countAndRange(pair, atomBits[c]!, from, to);
                if (abc < minTrades || abc === ab) continue;
                // Also redundant when `c` is implied by `a` or `b` alone — the same set as a pair already scored.
                if (abc === countAndRange(atomBits[a]!, atomBits[c]!, from, to)
                    || abc === countAndRange(atomBits[b]!, atomBits[c]!, from, to)) continue;
                andInto(triple, pair, atomBits[c]!);
                score(triple, [a, b, c]);
            }
            await tick();
        }
    }

    return { tested, bestT };
}

/** The first bar at or after `time`, or `bars.length`. */
function indexAt(bars: readonly PatternBar[], time: number): number {
    let lo = 0;
    let hi = bars.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (bars[mid]!.time < time) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function segmentInfo(bars: readonly PatternBar[], segment: Segment): SegmentInfo {
    return {
        from: segment.from,
        to: segment.to,
        fromTime: bars[segment.from]!.time,
        toTime: bars[segment.to - 1]!.time,
    };
}

/** The average R of a trade taken on every readable bar of the stretch, overlapping. */
function baselineOf(features: PatternFeatures, sides: Record<PatternSide, SideOutcomes>, segment: Segment): Baseline {
    const mean = (side: SideOutcomes): number => {
        let sum = 0;
        let n = 0;
        for (let i = segment.from; i < segment.to; i++) {
            if ((features.ready[i >>> 5]! & (1 << (i & 31))) === 0) continue;
            const r = side.r[i]!;
            if (Number.isNaN(r) || side.exits[i]! >= segment.to) continue;
            sum += r;
            n++;
        }
        return n > 0 ? sum / n : Number.NaN;
    };
    return { long: mean(sides.long), short: mean(sides.short) };
}

/** The trades a pattern takes on a stretch, as the set of bars it entered on. */
function tradeSet(bits: Bitset, side: SideOutcomes, segment: Segment): Set<number> {
    const out = new Set<number>();
    walkTrades(bits, side.r, side.exits, segment, (i) => { out.add(i); });
    return out;
}

function overlap(a: Set<number>, b: Set<number>): number {
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let shared = 0;
    for (const i of small) if (large.has(i)) shared++;
    const union = a.size + b.size - shared;
    return union > 0 ? shared / union : 0;
}

function quantile(values: readonly number[], q: number): number {
    const sorted = [...values].sort((x, y) => x - y);
    const at = (sorted.length - 1) * q;
    const lo = Math.floor(at);
    const hi = Math.ceil(at);
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

export async function minePatterns(options: MineOptions): Promise<MineResult> {
    const {
        bars, exit, costs, maxDepth, minTrades, anchor = null,
        discoveryFraction = 0.6, validationFraction = 0.2,
        nullRuns = 20, seed = 1, keep = 25, balance = 10_000, riskPct = 1,
        onProgress, shouldStop,
    } = options;

    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 3) {
        throw new Error('A pattern can have one to three conditions.');
    }
    if (!Number.isInteger(minTrades) || minTrades < 5) {
        throw new Error('A pattern needs at least 5 trades to be scored.');
    }
    if (!(discoveryFraction > 0) || !(validationFraction > 0) || discoveryFraction + validationFraction >= 1) {
        throw new Error('Discovery and validation have to leave room for a holdout.');
    }

    const startedAt = Date.now();
    let lastBreath = startedAt;
    const tick = async (): Promise<void> => {
        if (shouldStop?.()) throw new PatternSearchCancelled();
        if (Date.now() - lastBreath < BREATHE_EVERY_MS) return;
        // The thread is handed back so a posted Stop can arrive at all — see `breathe`.
        await breathe();
        lastBreath = Date.now();
        if (shouldStop?.()) throw new PatternSearchCancelled();
    };
    const report = (stage: MineStage, done: number, total: number): void => {
        onProgress?.({ stage, done, total, elapsedMs: Date.now() - startedAt });
    };

    const features = buildFeatures(bars);
    const vocabulary = vocabularyOf(features, anchor);
    const sides = sidesOf(computeOutcomes(bars, features.atr, exit, costs));

    /* Cut by time rather than by bar count, so a stretch with missing data does not quietly
     * move the boundaries — and the first readable bar is where the clock starts. */
    let first = 0;
    while (first < bars.length && (features.ready[first >>> 5]! & (1 << (first & 31))) === 0) first++;
    const span = bars[bars.length - 1]!.time - bars[first]!.time;
    const cut1 = indexAt(bars, bars[first]!.time + span * discoveryFraction);
    const cut2 = indexAt(bars, bars[first]!.time + span * (discoveryFraction + validationFraction));
    const discovery: Segment = { from: first, to: cut1 };
    const validation: Segment = { from: cut1, to: cut2 };
    const holdout: Segment = { from: cut2, to: bars.length };
    for (const [name, s] of [['discovery', discovery], ['validation', validation], ['holdout', holdout]] as const) {
        if (s.to - s.from < 2) throw new Error(`The ${name} stretch has no bars — load a longer range.`);
    }

    /* ── the search ──────────────────────────────────────────────────── */
    const pool = new Pool(POOL_SIZE);
    const stages = 1 + nullRuns;
    report('search', 0, stages);
    const real = await search({ vocabulary, sides, segment: discovery, maxDepth, minTrades, pool, tick });
    report('search', 1, stages);

    /* ── what luck finds ─────────────────────────────────────────────── */
    const rand = mulberry32(seed);
    const nullBest: number[] = [];
    const length = discovery.to - discovery.from;
    for (let run = 0; run < nullRuns; run++) {
        // At least a tenth of the stretch each way, so no slide leaves trades next to their own candles.
        const shift = Math.floor(length * (0.1 + 0.8 * rand()));
        const slid = {
            long: slide(sides.long, discovery, shift),
            short: slide(sides.short, discovery, shift),
        };
        const luck = await search({ vocabulary, sides: slid, segment: discovery, maxDepth, minTrades, pool: null, tick });
        nullBest.push(luck.bestT);
        report('null', run + 1, nullRuns);
    }
    // A run where luck scored nothing at all has no best to speak of, rather than a best of -∞.
    const luckScores = nullBest.filter((t) => t > Number.NEGATIVE_INFINITY);
    const nullThreshold = luckScores.length > 0 ? quantile(luckScores, 0.95) : null;

    /* ── one finding, one row ────────────────────────────────────────── */
    const picked: Array<{ scored: Scored; bits: Bitset; trades: Set<number> }> = [];
    for (const scored of pool.sorted()) {
        if (picked.length >= keep) break;
        const bits = patternBits(features.atoms, scored.atoms.map((k) => features.atoms[k]!.id), bars.length);
        const trades = tradeSet(bits, sides[scored.side], discovery);
        if (picked.some((p) => p.scored.side === scored.side && overlap(p.trades, trades) >= DUPLICATE_OVERLAP)) continue;
        picked.push({ scored, bits, trades });
    }

    /* ── asked again, on bars they never saw ─────────────────────────── */
    const candidates: PatternCandidate[] = [];
    let confirmed = 0;
    const confirmTotal = Math.min(CONFIRM_LIMIT, picked.length);
    for (const [k, { scored, bits }] of picked.entries()) {
        const side = sides[scored.side];
        const disc = scoreSignals(bits, side.r, side.exits, discovery);
        const val = scoreSignals(bits, side.r, side.exits, validation);
        const validated = val.trades >= MIN_VALIDATION_TRADES && val.meanR > 0;

        let engine: EngineCheck | null = null;
        if (validated && confirmed < CONFIRM_LIMIT) {
            const run = runBacktest({
                bars,
                strategy: buildPatternStrategy({
                    signals: bits, barCount: bars.length, side: scored.side, atr: features.atr, exit, riskPct,
                }),
                broker: { balance, costs },
                tradeFrom: bars[validation.from]!.time,
            });
            engine = {
                trades: run.stats.tradeCount,
                netPnl: run.stats.netPnl,
                returnPct: run.stats.returnPct,
                maxDrawdownPct: run.stats.maxDrawdownPct,
                winRate: run.stats.winRate,
                profitFactor: run.stats.profitFactor,
            };
            confirmed++;
            report('confirm', confirmed, confirmTotal);
        }

        candidates.push({
            atoms: scored.atoms.map((a) => features.atoms[a]!.id),
            side: scored.side,
            discovery: disc,
            validation: val,
            holdout: validated ? scoreSignals(bits, side.r, side.exits, holdout) : null,
            pAdjusted: Math.min(1, pValue(disc.t) * Math.max(1, real.tested)),
            beatsNull: nullThreshold == null ? null : disc.t > nullThreshold,
            validated,
            engine,
        });
        report('validate', k + 1, picked.length);
        await tick();
    }

    return {
        barCount: bars.length,
        exit,
        costs,
        maxDepth,
        minTrades,
        anchor,
        segments: {
            discovery: segmentInfo(bars, discovery),
            validation: segmentInfo(bars, validation),
            holdout: segmentInfo(bars, holdout),
        },
        baseline: {
            discovery: baselineOf(features, sides, discovery),
            validation: baselineOf(features, sides, validation),
            holdout: baselineOf(features, sides, holdout),
        },
        tested: real.tested,
        bestT: real.bestT,
        nullBest,
        nullThreshold,
        candidates,
        atoms: features.atoms.map(({ bits: _bits, ...def }) => def),
        elapsedMs: Date.now() - startedAt,
    };
}
