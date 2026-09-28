import { forEachBit, type Bitset } from './bits';

/**
 * Scoring one candidate on one stretch of history.
 *
 * Trades do not overlap. A signal that arrives while the previous trade is still open is
 * passed over, exactly as a strategy holding one position at a time would pass it over —
 * counting it would score the same market move twice and make a pattern that fires in
 * clusters look far more certain than it is.
 *
 * A trade must also END inside the stretch. One that opens in discovery and closes in
 * validation would let validation prices decide a discovery score, which is the leak the
 * stretches exist to prevent.
 */

export interface PatternStats {
    trades: number;
    /** Average net R per trade. */
    meanR: number;
    /** Sample standard deviation of R. */
    sdR: number;
    /** `meanR / (sdR / √trades)` — how many standard errors the average sits above zero. */
    t: number;
    winRate: number;
    totalR: number;
    /** Gross won R over gross lost R; null when nothing lost. */
    profitFactor: number | null;
}

export interface Segment {
    from: number;
    to: number;
}

/**
 * The trades a signal set takes in `[from, to)`, as bar indices, one at a time.
 *
 * `visit` is handed each trade's signal bar and R.
 */
export function walkTrades(
    signals: Bitset,
    r: Float64Array,
    exits: Int32Array,
    segment: Segment,
    visit: (index: number, r: number) => void,
): void {
    forEachBit(signals, segment.from, segment.to, (i) => {
        const value = r[i]!;
        const exit = exits[i]!;
        if (Number.isNaN(value) || exit < 0 || exit >= segment.to) return undefined;
        visit(i, value);
        return exit;
    });
}

/**
 * Running figures, so a score needs no array of trades. The variance is Welford's, not a
 * difference of two large sums: trades that all end within a hair of the same R would
 * otherwise cancel into rounding noise and report a spread that is not there.
 */
export class StatsAccumulator {
    n = 0;
    sum = 0;
    mean = 0;
    m2 = 0;
    wins = 0;
    won = 0;
    lost = 0;

    add(r: number): void {
        this.n++;
        this.sum += r;
        const delta = r - this.mean;
        this.mean += delta / this.n;
        this.m2 += delta * (r - this.mean);
        if (r > 0) {
            this.wins++;
            this.won += r;
        } else {
            this.lost -= r;
        }
    }

    reset(): void {
        this.n = 0;
        this.sum = 0;
        this.mean = 0;
        this.m2 = 0;
        this.wins = 0;
        this.won = 0;
        this.lost = 0;
    }

    /**
     * The t statistic alone — what the search ranks on, without building an object.
     *
     * Trades that all ended at exactly the same R have no spread, and an average above zero
     * with no spread is as certain as a sample gets: +∞, not "undefined". Discarding it
     * would drop the strongest pattern a search can meet.
     */
    t(): number {
        if (this.n < 2) return Number.NaN;
        const variance = this.m2 / (this.n - 1);
        if (!(variance > 0)) {
            if (this.mean > 0) return Number.POSITIVE_INFINITY;
            return this.mean < 0 ? Number.NEGATIVE_INFINITY : 0;
        }
        return this.mean / Math.sqrt(variance / this.n);
    }

    stats(): PatternStats {
        const n = this.n;
        return {
            trades: n,
            meanR: n > 0 ? this.mean : Number.NaN,
            sdR: n > 1 ? Math.sqrt(Math.max(0, this.m2 / (n - 1))) : Number.NaN,
            t: this.t(),
            winRate: n > 0 ? this.wins / n : Number.NaN,
            totalR: this.sum,
            profitFactor: this.lost > 0 ? this.won / this.lost : null,
        };
    }
}

export function scoreSignals(
    signals: Bitset,
    r: Float64Array,
    exits: Int32Array,
    segment: Segment,
): PatternStats {
    const acc = new StatsAccumulator();
    walkTrades(signals, r, exits, segment, (_i, value) => acc.add(value));
    return acc.stats();
}

/**
 * The complementary error function, to about 1.2e-7 everywhere.
 *
 * The Chebyshev fit from Numerical Recipes (§6.2) — accurate enough for a p-value that is
 * about to be multiplied by the number of candidates tried.
 */
export function erfc(x: number): number {
    const z = Math.abs(x);
    const t = 1 / (1 + 0.5 * z);
    const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418
        + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587
        + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
}

/** One-sided p-value of a t statistic, read against the normal distribution. */
export function pValue(t: number): number {
    if (Number.isNaN(t)) return 1;
    if (t === Number.POSITIVE_INFINITY) return 0;
    return 0.5 * erfc(t / Math.SQRT2);
}
