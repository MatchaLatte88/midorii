import { timeframeToMs } from '../../../src';
import type { BarRange, DataProvider, OHLCV, ProviderInfo } from '../../../src';

/**
 * Wraps a DataProvider (the local archive) and reveals bars only up to a moving
 * cutoff — the replay "clock". `getBars` never returns anything at or after the
 * cutoff, no matter what range is requested, so a stray reload (Vela's gap-heal,
 * a mistaken setMarket) can never leak the future into the chart.
 *
 * The cutoff is an INSTANT, not a bar count, which is what makes the timeframe
 * free to change underneath a running session: the same cutoff answers a 5m and
 * a 4h request with the same history, and the bucket the cutoff falls inside
 * comes back drawn as far as it has got. Only `revealNext` needs to know the
 * timeframe, to say how far one bar moves the clock.
 *
 * `subscribe` only holds the callback — no polling, no timer. `revealNext` is the
 * only thing that ever calls it, advancing the cutoff by exactly one bar. That
 * drives Vela's incremental live-tick path (IChartRenderer.updateBar) instead of
 * a full reload: no indicator restart, no viewport reset.
 */
export class ReplayProvider implements DataProvider {
    private cutoff: number;
    private timeframe: string;
    private onBarCb: ((bar: OHLCV) => void) | null = null;

    /**
     * @param name the registry name this provider is registered under — `info().name`
     *   is contractually the registration id, and a chart symbol pins the venue by it.
     *   Vela's symbol grammar parses that prefix as `[A-Za-z0-9_.]+`: a name outside
     *   that alphabet (a hyphen, say) fails to parse silently and the chart never
     *   resolves a provider at all, so the caller must stay within it.
     */
    constructor(
        private readonly archive: DataProvider,
        private readonly name: string,
        timeframe: string,
        startCutoff: number,
    ) {
        this.timeframe = timeframe;
        this.cutoff = startCutoff;
    }

    info(): ProviderInfo {
        return {
            name: this.name,
            displayName: 'Replay',
            requiresApiKey: false,
            // Whatever the archive underneath can serve: a replay does not pin the
            // chart to one resolution, it pins it to one moment in time.
            supportedTimeframes: this.archive.info?.().supportedTimeframes,
            capabilities: { enumerate: false, stream: true, symbolInfo: false },
        };
    }

    /**
     * Follow the session onto another timeframe. The clock comes with it because
     * the session is the one that owns it — a bar boundary on the old timeframe
     * is not one on the new, and a cutoff left behind would hide or leak the
     * difference.
     */
    retime(timeframe: string, clock: number): void {
        this.timeframe = timeframe;
        this.cutoff = clock;
    }

    async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
        const to = Math.min(range.to ?? this.cutoff, this.cutoff);
        const bars = await this.archive.getBars(ticker, timeframe, { ...range, to });
        // The clamp above is the contract; this filter is the guard against an archive
        // that over-serves past its bound (Vela's own cache takes the same precaution).
        return bars.filter((b) => b.time < this.cutoff);
    }

    subscribe(_ticker: string, _timeframe: string, onBar: (bar: OHLCV) => void): () => void {
        this.onBarCb = onBar;
        return () => { this.onBarCb = null; };
    }

    /**
     * Reveal exactly one more bar — advances the cutoff and pushes it through the
     * live-tick path. Throws on a bar that would move the clock backwards: replay
     * only ever runs forwards, and a rewound cutoff would silently re-hide bars the
     * session has already traded against.
     */
    revealNext(bar: OHLCV): void {
        if (bar.time < this.cutoff - timeframeToMs(this.timeframe)) {
            throw new Error(`revealNext went backwards: bar ${new Date(bar.time).toISOString()} predates the replay clock`);
        }
        this.cutoff = bar.time + timeframeToMs(this.timeframe);
        this.onBarCb?.(bar);
    }

    /**
     * Draw the candle the playhead is standing inside, as far as it has got — what a tick replay
     * pushes after every stretch of prints.
     *
     * The cutoff moves to the clock rather than to the end of the candle: a reload in the middle
     * of a candle must not hand back the rest of it. The same bar time sent again is Vela's live
     * update of the forming candle, so it is redrawn in place.
     */
    revealForming(bar: OHLCV, clock: number): void {
        if (bar.time < this.cutoff - timeframeToMs(this.timeframe)) {
            throw new Error(`revealForming went backwards: bar ${new Date(bar.time).toISOString()} predates the replay clock`);
        }
        this.cutoff = clock;
        this.onBarCb?.(bar);
    }
}
