import { Dialog, Select, injectStyles } from '../../../src/ui';
import { STRATEGIES, resolveStrategyParams, strategyCatalog } from '../strategies';
import { SETTINGS_CSS, SETTINGS_STYLE_ID, button, note, row } from '../trading/settingsChrome';
import { nextSetupIndex } from './nextSetup';
import type { ReplayController } from './ReplayController';

/**
 * Which strategy "Next setup" looks for, and the looking.
 *
 * One strategy at a time, remembered on this machine: somebody practising opening-range breaks
 * presses the button twenty times in a sitting, and a question in front of every press would
 * be the button's whole cost. The choice is changed from the chart's context menu.
 *
 * The strategy runs on the settings the Strategies tab holds for it — the same ones a backtest
 * starts from — so the setups the replay stops on are the setups a run with those settings
 * would have traded.
 */

const STORAGE_KEY = 'midorii-replay-setup-strategy';

/** The remembered strategy, or null where none is — or where it is one this version lacks. */
export function loadSetupStrategy(): string | null {
    try {
        const id = localStorage.getItem(STORAGE_KEY);
        return id != null && id in STRATEGIES ? id : null;
    } catch (err) {
        console.error('[midorii] could not read the strategy "Next setup" looks for', err);
        return null;
    }
}

export function saveSetupStrategy(id: string): void {
    try {
        localStorage.setItem(STORAGE_KEY, id);
    } catch (err) {
        console.error('[midorii] could not remember the strategy "Next setup" looks for', err);
    }
}

export function strategyName(id: string): string {
    return STRATEGIES[id]?.name ?? id;
}

/** Ask which strategy to look for. Resolves the id, or null when dismissed. */
export function askSetupStrategy(host: HTMLElement, current: string | null): Promise<string | null> {
    const doc = host.ownerDocument;
    injectStyles(SETTINGS_STYLE_ID, SETTINGS_CSS, doc);
    const catalog = strategyCatalog();

    return new Promise((resolve) => {
        let chosen = current ?? catalog[0]?.id ?? '';
        let settled = false;
        const finish = (result: string | null): void => {
            if (settled) return;
            settled = true;
            dialog.hide();
            resolve(result);
        };

        const select = new Select({
            options: catalog.map((s) => ({ value: s.id, label: s.name })),
            value: chosen,
            size: 'sm',
            onChange: (v) => { chosen = v; },
        });

        const dialog = new Dialog({
            title: 'Next setup',
            eyebrow: 'Replay',
            host,
            draggable: true,
            align: 'center',
            closeOnInteractOutside: false,
            onOpenChange: (open) => { if (!open) finish(null); },
            content: (body) => {
                body.append(
                    note(
                        'The replay steps forward, candle by candle, to the next candle on which this '
                        + 'strategy would send an order — on the settings the Strategies tab holds for it. '
                        + 'Every order you have open is matched on the way, exactly as if you had stepped '
                        + 'there yourself.',
                        doc,
                    ),
                    row('Look for', select.el, doc),
                );
            },
            footer: (el) => {
                const spacer = doc.createElement('span');
                spacer.style.flex = '1 1 auto';
                const cancel = button('Cancel', doc);
                cancel.onclick = () => finish(null);
                const ok = button('Use this strategy', doc, true);
                ok.onclick = () => finish(chosen || null);
                el.append(spacer, cancel, ok);
            },
        });
        dialog.show();
    });
}

/**
 * The index of the next candle, in the session's bars, on which `strategyId` would send an
 * order — or null when there is none before the loaded bars run out.
 *
 * Throws where the stored settings no longer fit the strategy, with the strategy's own reason:
 * a search on silently corrected settings would stop on setups nobody configured.
 */
export async function findNextSetup(controller: ReplayController, strategyId: string): Promise<number | null> {
    const spec = STRATEGIES[strategyId];
    if (!spec) throw new Error(`There is no strategy "${strategyId}".`);
    const stored = await window.midori.strategies.load();
    const params = resolveStrategyParams(strategyId, stored[strategyId] ?? {});
    const { session } = controller;
    return nextSetupIndex(spec, params, session.bars, session.index);
}
