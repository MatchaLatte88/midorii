import { describe, expect, it } from 'vitest';
import { resolveStrategyParams, STRATEGIES, buildStrategy } from '../app/renderer/strategies';
import type { OHLCV } from '../src/core/model/ohlcv';

/**
 * The one check that does not need to read a detector to find a detector that looks ahead.
 *
 * Every strategy's `build()` computes `series` and `events` once, over the whole bars array
 * it is handed — see `shared/engine/backtest.js`'s own header on why. A detector that is
 * honest about that produces the SAME values for bar `j` whether the array it was given
 * stops at `j` or runs on for another year: nothing after `j` was available to it either
 * way. A detector that centres a moving average, smooths across a window that reaches
 * forward, or reads tomorrow's session to label today's would not — its value for `j` would
 * change once more bars appear after it, because some of what it computed for `j` came from
 * them.
 *
 * So this asks the question directly, without reading a single detector: build every
 * registered strategy over the full series, build it again over a PREFIX of the same bars,
 * and demand that every series value and every event up to the prefix's own last bar agree
 * between the two. Anything that disagrees was computed with information from beyond that
 * bar — which is a definition, not a heuristic.
 *
 * What this checks about an event, and what it deliberately does not
 * ---------------------------------------------------------------
 * Only `index` and `startIndex` — the two fields `runBacktest` itself reads (see its own
 * header) — have to be identical between the two builds: whether a setup exists, and which
 * bar it is actionable from, must never depend on how much history follows it. Every other
 * field on an event is a detector's own payload, and several of them (`sessionEndIndex` in
 * the opening-range detector, `endIndex` in `intradayWindows.ts`) are documented as "the
 * last bar of this session SEEN SO FAR" — correct and necessary for a bot whose history
 * grows one bar at a time, and expected to differ between a full run and a truncated one
 * for exactly that reason. Demanding those agree too would fail on the detectors doing
 * exactly what they are supposed to, not on the ones looking ahead.
 *
 * What this cannot promise
 * -------------------------
 * A strategy that detects nothing at all on this synthetic series proves nothing about
 * itself here — an empty series or an empty bucket trivially "agrees" with another empty
 * one. RSI(2) Dip's 200-session average, in particular, never has enough calendar days to
 * come alive on the run below; it passes here vacuously, reported rather than hidden — see
 * the final check below. This test is a strong check for the strategies it does exercise,
 * and a stated, visible gap for the ones it does not.
 */

const MIN = 60_000;
const BARS_PER_DAY = 288; // a bar every 5 minutes, all day — session-agnostic on purpose,
// so a strategy that only trades a slice of the day still sees that slice on every day.
const DAYS = 45;

/** A small, deterministic PRNG — reproducible across runs and platforms, unlike Math.random. */
function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * A synthetic OHLCV series with real calendar timestamps (so a session-time detector sees
 * genuine hours of the day across genuine, distinct dates) and enough drift and noise that
 * most detectors find something to react to.
 */
function syntheticBars(): OHLCV[] {
    const rand = mulberry32(20260918);
    const bars: OHLCV[] = [];
    // A Monday, so the calendar days this walks through are not all the same weekday.
    let t = Date.parse('2024-01-01T00:00:00Z');
    let price = 100;

    for (let day = 0; day < DAYS; day++) {
        // A drift per day, so the series trends rather than just chopping — opening ranges,
        // momentum windows and reversion bands all need SOME days that actually move.
        const drift = (rand() - 0.5) * 0.6;
        for (let i = 0; i < BARS_PER_DAY; i++) {
            const open = price;
            const noise = (rand() - 0.5) * 0.8;
            const close = open + drift + noise;
            const high = Math.max(open, close) + rand() * 0.5;
            const low = Math.min(open, close) - rand() * 0.5;
            const volume = 50 + rand() * 200;
            bars.push({ time: t, open, high, low, close, volume });
            price = close;
            t += 5 * MIN;
        }
    }
    return bars;
}

const BARS = syntheticBars();
/** Several cut points spread through the run, not just one — a detector could easily agree
 *  at one prefix length and diverge at another. */
const SPLITS = [0.15, 0.35, 0.55, 0.75, 0.9].map((f) => Math.floor(BARS.length * f));

function seriesOf(id: string, n: number): RunnableStrategyOutput {
    const params = resolveStrategyParams(id, {});
    return buildStrategy(id, params, BARS.slice(0, n)) as RunnableStrategyOutput;
}

interface RunnableStrategyOutput {
    series?: Record<string, ReadonlyArray<number | null | undefined>>;
    events?: Record<string, readonly { index: number; startIndex?: number }[]>;
}

describe('no registered strategy looks past the bar it is asked about', () => {
    for (const id of Object.keys(STRATEGIES)) {
        it(`${id}: series and events up to a prefix's last bar do not change once more bars follow it`, () => {
            const full = seriesOf(id, BARS.length);
            let comparedSomeSeries = false;
            let comparedSomeEvent = false;

            for (const n of SPLITS) {
                const prefix = seriesOf(id, n);

                for (const [name, values] of Object.entries(full.series ?? {})) {
                    const prefixValues = prefix.series?.[name];
                    expect(prefixValues, `${id}: series "${name}" missing from the prefix build`).toBeDefined();
                    for (let j = 0; j < n; j++) {
                        comparedSomeSeries = true;
                        expect(prefixValues![j] ?? null, `${id}: series "${name}" at bar ${j}, prefix length ${n}`)
                            .toBe(values[j] ?? null);
                    }
                }

                for (const [name, items] of Object.entries(full.events ?? {})) {
                    const prefixItems = prefix.events?.[name] ?? [];
                    // Identity and timing only — see the header on why the rest of an
                    // event's payload is deliberately not compared here.
                    const identity = (list: readonly { index: number; startIndex?: number }[]) => (
                        list.filter((e) => e.index < n).map((e) => [e.index, e.startIndex ?? null])
                    );
                    const fullUpToN = identity(items);
                    comparedSomeEvent ||= fullUpToN.length > 0;
                    expect(identity(prefixItems), `${id}: events "${name}", prefix length ${n}`).toEqual(fullUpToN);
                }
            }

            // At least one of the two kinds of check must have compared something real, or
            // this run proved nothing about this strategy at all. Not a failure — see the
            // limitation in the header — but worth being able to see, since a strategy that
            // silently stopped being exercised here would make every OTHER assertion above
            // trivially true forever without anyone noticing.
            if (!comparedSomeSeries && !comparedSomeEvent) {
                console.warn(`strategy-lookahead: "${id}" detected nothing on the synthetic series — not tested here.`);
            }
        });
    }
});
