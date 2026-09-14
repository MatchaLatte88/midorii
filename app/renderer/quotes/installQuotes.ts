import type { DataProvider } from '../../../src/plugin';
import type { IndicatorHandle } from '../../../src';
import type { VelaWorkspace } from '../../../src/workspace';
import type { Unsubscribe } from '../../../src/core/util/types';
import { mountQuoteStrip, type Quote, type QuoteStrip } from './quoteStrip';
import { QUOTE_INDICATOR_TYPE, quoteIndicatorInputs, registerQuoteIndicator } from './quoteIndicator';
import { loadQuoteDisplay, onQuoteDisplayChange, type QuoteDisplay } from './quoteDisplay';

/**
 * The two-sided price, wired to whichever market is on the chart.
 *
 * A venue that quotes two sides is the exception rather than the rule here: the crypto
 * providers stream one price and the local archive streams none, so this is off on most
 * markets and neither the card nor the lines are on the chart at all. Rather than asking
 * WHICH provider is a quoting one — a list that goes stale the moment another venue is
 * added — it asks the provider instance whether it can do it, through the seam
 * `chart.data.providerInstance` exists for (a provider may implement surfaces beyond the
 * `DataProvider` port).
 *
 * Call once, after the workspace is built — see `app/renderer/main.ts`, alongside
 * `installAlerts`.
 */

/** What this needs of a provider, over and above serving candles. */
export interface QuoteFeed {
    subscribeQuotes(ticker: string, onQuote: (quote: Quote) => void): Unsubscribe;
}

/** Narrow a provider to one that streams two-sided prices, or null. */
export function quoteFeed(provider: DataProvider | undefined): QuoteFeed | null {
    const candidate = provider as Partial<QuoteFeed> | undefined;
    return typeof candidate?.subscribeQuotes === 'function' ? (candidate as QuoteFeed) : null;
}

export function installQuotes(workspace: VelaWorkspace): void {
    const chart = workspace.chart;
    registerQuoteIndicator();

    let strip: QuoteStrip | null = null;
    let indicator: IndicatorHandle | null = null;
    let stopQuotes: Unsubscribe | null = null;
    let display: QuoteDisplay = loadQuoteDisplay();
    /* The last tick this market delivered, so a settings change can redraw from it rather
     * than leaving the chart on the old drawing until the next one arrives — on a quiet
     * market that could be a while, and a switch that appears to do nothing reads as broken. */
    let last: Quote | null = null;
    /** Whether the market on screen quotes two sides at all. */
    let quoting = false;
    /* Which market the card is currently showing. A symbolInfo fetch and a first tick both
     * land asynchronously, and a chart switched twice in quick succession would otherwise
     * let the slower answer from the market BEFORE last paint over the one on screen. */
    let generation = 0;
    let tick: number | undefined;

    /** Put the current quote in front of whoever is meant to be showing it. */
    function paint(): void {
        /* Through the card rather than by setting `hidden` here: the readout is a floating
         * card now, and its own close button owns that flag. Two hands on it would have this
         * repaint undo a dismissal on the next tick. */
        strip?.setAvailable(quoting); // the card reads its own Settings switch
        if (last) {
            strip?.update(last, tick);
            indicator?.setInputs(quoteIndicatorInputs(last.bid, last.ask, display));
        } else {
            strip?.clear();
            // Zeroes are what the indicator reads as "nothing to draw" — see quotePriceLines.
            indicator?.setInputs(quoteIndicatorInputs(0, 0, display));
        }
    }

    /** Follow `symbol`: drop whatever was streaming, and start again if it quotes. */
    function follow(symbol: string | undefined): void {
        const mine = ++generation;
        stopQuotes?.();
        stopQuotes = null;
        last = null;
        tick = undefined;

        const resolved = symbol ? chart.data.resolve(symbol) : null;
        const feed = resolved ? quoteFeed(chart.data.providerInstance(resolved.provider)) : null;
        quoting = !!(symbol && resolved && feed);
        paint();
        if (!symbol || !resolved || !feed) return;

        /* The instrument's own increment, for printing the figures at the precision the
         * market quotes them in. Fetched per market and applied only if this is still the
         * market being shown; absent, the quotes print as they arrived. */
        void chart.data.symbolInfo(symbol).then((info) => {
            if (mine !== generation) return;
            const mintick = info?.mintick;
            if (typeof mintick === 'number' && mintick > 0) tick = mintick;
        });

        stopQuotes = feed.subscribeQuotes(resolved.ticker, (quote) => {
            if (mine !== generation) return;
            last = quote;
            paint();
        });
    }

    /* The card mounts into the chart's cell, which does not exist until the chart has laid
     * itself out — the same wait `paperMount` makes for the account card. The lines' own
     * indicator goes on beside it: added straight to the chart rather than through the
     * widget context, so a level recomputed on every tick stays out of the undo timeline
     * and out of the persisted indicator ledger (mirrors the alert lines). */
    void chart.ready().then(() => {
        const cell = workspace.root.querySelector<HTMLElement>('.vela-cell');
        if (!cell) {
            console.warn('[midorii] no chart cell to mount the quote readout into');
            return;
        }
        strip = mountQuoteStrip(cell);
        indicator = chart.addNativeIndicator(QUOTE_INDICATOR_TYPE);
        follow(chart.market.symbol);
    });

    chart.on('market:changed', ({ symbol }) => follow(symbol));

    // The Settings tab can turn any of the three off while a market is already quoting —
    // redraw from the last tick so the change lands now rather than at the next one.
    onQuoteDisplayChange((next) => {
        display = next;
        paint();
    });
}
