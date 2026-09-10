import type { HostSettingsRow, VelaWorkspace } from '../../../src/workspace';
import { contributeChartSettings } from '../shell/chartSettings';
import { loadOverlayDisplay, saveOverlayDisplay, type OverlayDisplay } from './overlayDisplay';
import { loadQuoteDisplay, saveQuoteDisplay, type QuoteDisplay } from '../quotes/quoteDisplay';

/**
 * The Chart cards tab in the chart's own settings dialog: which of the floating cards this
 * chart puts on the plot.
 *
 * Behind the gear rather than on the Settings page, because a card is a thing lying on a
 * chart — somebody who wants it gone is looking AT it, and the gear is two inches away. It
 * keeps company with the rest of what the chart looks like, which is where a person goes to
 * change how a chart looks.
 *
 * The switches are the permanent half of a pair. The other half is each card's own close
 * button, and the difference is what is left behind: a closed card leaves the restore button
 * in the corner, a card switched off here leaves nothing at all. Both survive a restart — see
 * `overlayCards.ts`.
 *
 * The bid/ask card answers from `quotes/quoteDisplay` rather than from `overlayDisplay`,
 * because there it sits beside the two other ways of showing the same two-sided price. It is
 * offered here as well, on the same row as its siblings: one place to ask "what is allowed on
 * my chart" beats a tidy split nobody can see from the dialog.
 */

export interface OverlaySettings {
    /** Take the tab back down. */
    dispose(): void;
}

export function wireOverlaySettings(workspace: VelaWorkspace): OverlaySettings {
    let display: OverlayDisplay = loadOverlayDisplay();
    let quotes: QuoteDisplay = loadQuoteDisplay();

    /* Read fresh on every `get` rather than trusted from here: the same switches can be thrown
     * on another chart, and a dialog opened afterwards must not show what this copy last saw. */
    const change = (patch: Partial<OverlayDisplay>): void => {
        display = { ...loadOverlayDisplay(), ...patch };
        saveOverlayDisplay(display);
    };
    const changeQuotes = (patch: Partial<QuoteDisplay>): void => {
        quotes = { ...loadQuoteDisplay(), ...patch };
        saveQuoteDisplay(quotes);
    };
    const read = (): OverlayDisplay => (display = loadOverlayDisplay());
    const readQuotes = (): QuoteDisplay => (quotes = loadQuoteDisplay());

    /* Typed against the dialog's own row shape: these cross into the renderer as `unknown[]`,
     * so a misspelled `kind` would otherwise turn up as a control that silently does nothing. */
    const rows: HostSettingsRow[] = [
        { kind: 'heading', label: 'On the plot', id: 'cards' },
        {
            kind: 'toggle',
            label: 'Account card',
            id: 'card-account',
            get: () => read().showAccount,
            set: (v: boolean) => change({ showAccount: v }),
        },
        {
            kind: 'toggle',
            label: 'Quick Buy / Sell panel',
            id: 'card-quick',
            get: () => read().showQuick,
            set: (v: boolean) => change({ showQuick: v }),
        },
        {
            kind: 'toggle',
            label: 'Bid / ask card',
            id: 'card-quote',
            get: () => readQuotes().showCard,
            set: (v: boolean) => changeQuotes({ showCard: v }),
        },
        {
            kind: 'toggle',
            label: 'Live account band',
            id: 'card-live',
            get: () => read().showLive,
            set: (v: boolean) => change({ showLive: v }),
        },
    ];

    contributeChartSettings(workspace, 'chart-cards', { title: 'Chart cards', id: 'chart-cards', rows });

    return {
        dispose(): void {
            contributeChartSettings(workspace, 'chart-cards', null);
        },
    };
}
