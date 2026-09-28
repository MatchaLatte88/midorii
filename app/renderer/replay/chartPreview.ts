import type { IndicatorHandle, Vela } from '../../../src';
import type { TicketPreview } from './orderTicket';
import { PREVIEW_INPUT, readPreviewLineId } from './replayIndicator';
import { levelFromDrop } from './replayLevels';
import type { TradeSidebar } from './tradeSidebar';

export interface PreviewWiringOptions {
    chart: Vela;
    /** The account's own position indicator — the preview is drawn as part of it. */
    indicator: IndicatorHandle;
    /** The ticket being previewed, and where a level dragged on the chart is written back. */
    sidebar: TradeSidebar;
    /** Feedback for a dropped level the ticket refuses. */
    notify?: (message: string, kind: 'info' | 'error') => void;
}

/**
 * The ticket, on the chart, before it is sent.
 *
 * What a trade would lose is the number a size is chosen by, and a panel is the wrong place to
 * read it: the stop is a place on the chart, and so is the loss. So the ticket is drawn where it
 * would trade — its entry, its stop and its target, each saying what it comes to — and it can be
 * taken hold of there the same way an open position can.
 *
 * Drawn through the position indicator rather than an indicator of its own, which would put a
 * second row in the chart's legend for something that is not a study anyone added.
 *
 * Nothing is decided here, exactly as with a position's levels. The chart reports where a line
 * was dropped, the ticket decides whether the level goes there, and the next preview it publishes
 * is what moves the line — so a refused drop springs back without anything to put back.
 *
 * Returns an unsubscribe function.
 */
export function wireTradePreview(opts: PreviewWiringOptions): () => void {
    const { chart, indicator, sidebar } = opts;
    const notify = opts.notify ?? (() => {});

    let shown: TicketPreview | null = null;
    /* The ticket repaints on every tick, and an unchanged preview is not sent again: every input
     * change remounts the indicator's output. A market order's entry changes with the price, so
     * that one is resent exactly as often as the price moves it. */
    let sent: string | null = null;

    const offPreview = sidebar.onPreview((preview) => {
        shown = preview;
        const json = JSON.stringify(preview);
        if (json === sent) return;
        sent = json;
        indicator.setInput(PREVIEW_INPUT, json);
    });

    const drop = (level: 'entry' | 'stop' | 'target', price: number): void => {
        const refusal = sidebar.dragLevel(level, price);
        if (refusal) notify(refusal, 'error');
    };

    const offMoved = chart.on('priceline:moved', ({ id, price }) => {
        const level = readPreviewLineId(id);
        if (level == null || shown == null) return;
        drop(level, price);
    });

    /* A level pulled out of a market entry — the only handle a preview without a stop has. Which
     * level came out follows from the side it landed on, as it does off a position's entry. */
    const offSpawned = chart.on('priceline:spawned', ({ id, price }) => {
        if (readPreviewLineId(id) !== 'entry' || shown == null) return;
        const level = levelFromDrop(shown.side, shown.entryPrice, price);
        if (level == null) return;
        drop(level, price);
    });

    const offAction = chart.on('priceline:action', ({ id }) => {
        if (readPreviewLineId(id) !== 'entry') return;
        sidebar.dismissPreview();
    });

    return () => {
        offPreview();
        offMoved();
        offSpawned();
        offAction();
        // A preview left behind by a wiring that is gone would be a ticket nobody can reach.
        indicator.setInput(PREVIEW_INPUT, 'null');
    };
}
