import type { Vela } from '../../../src';
import type { LiveBar } from '../../../shared/engine/liveSession.js';

/**
 * The bars a paper account missed while the app was closed.
 *
 * A stored account remembers where it stood, not what happened next. Handing it
 * straight back would leave a stop still sitting behind a market that went through
 * it days ago — the account would open showing a position nobody would still have.
 * So the gap is fetched and played, and the fills land where they would have.
 *
 * How fine the gap is rechecked
 * -----------------------------
 * A finer timeframe resolves an ambiguous bar better: a bar that touched both the
 * stop and the target says nothing about which came first, and minutes inside it
 * do. But a provider answers one request with a bounded number of bars, so a month
 * of minutes is not a thing that can be asked for. The resolution therefore follows
 * the gap: the finest timeframe whose bars fit in one request. An hour away comes
 * back to the minute; a month away comes back to the hour, which is the honest
 * answer rather than a precise-looking one built from bars nobody fetched.
 */

/** Timeframes a catch-up may use, finest first — Vela's canonical spelling. */
const STEPS: ReadonlyArray<{ value: string; ms: number }> = [
    { value: '1', ms: 60_000 },
    { value: '5', ms: 300_000 },
    { value: '15', ms: 900_000 },
    { value: '30', ms: 1_800_000 },
    { value: '60', ms: 3_600_000 },
    { value: '240', ms: 14_400_000 },
    { value: 'D', ms: 86_400_000 },
];

/** How many bars one request is expected to answer with. Providers differ; this is
 *  the low end of what they all serve, so the choice below never overruns one. */
const BARS_PER_REQUEST = 1000;

/**
 * The finest timeframe whose bars cover `gapMs` within a single request — or the
 * coarsest there is, for a gap longer than even daily bars can span. A gap that
 * cannot be covered at all is still walked as far as the bars reach; see
 * {@link fetchGapBars}, which says how far that got.
 */
export function catchUpTimeframe(gapMs: number): string {
    for (const step of STEPS) {
        if (gapMs <= step.ms * BARS_PER_REQUEST) return step.value;
    }
    return STEPS[STEPS.length - 1]!.value;
}

/** How a catch-up timeframe reads in a sentence — `'60'` is an hour, not sixty of anything. */
export function catchUpLabel(timeframe: string): string {
    const step = STEPS.find((s) => s.value === timeframe);
    if (!step) return timeframe;
    if (step.ms >= 86_400_000) return '1D';
    if (step.ms >= 3_600_000) return `${step.ms / 3_600_000}h`;
    return `${step.ms / 60_000}m`;
}

export interface GapBars {
    bars: LiveBar[];
    /** The timeframe they were fetched on — worth reporting, since it is not always 1m. */
    timeframe: string;
}

/**
 * Fetch the bars between `from` and now for `symbol`, through the chart's own
 * provider registry — the same source the chart itself is painted from, so the
 * account is caught up on the prices it will then be looking at.
 *
 * Returns an empty list where the symbol resolves to nothing, or the provider has
 * nothing for that stretch. It never throws for a missing provider: an account that
 * cannot be caught up is a thing to say out loud, not a reason to lose it.
 */
export async function fetchGapBars(chart: Vela, symbol: string, from: number): Promise<GapBars> {
    const timeframe = catchUpTimeframe(Math.max(0, Date.now() - from));
    const resolved = chart.data.resolve(symbol);
    if (!resolved) return { bars: [], timeframe };

    const provider = chart.data.providerInstance(resolved.provider);
    if (!provider) return { bars: [], timeframe };

    const bars = await provider.getBars(resolved.ticker, timeframe, {
        from,
        to: Date.now(),
        limit: BARS_PER_REQUEST,
    });
    // Ascending and inside the gap: a provider may answer with more than was asked for,
    // and a bar from before the account's own position would be a price it is past.
    return { bars: bars.filter((b) => b.time >= from), timeframe };
}
