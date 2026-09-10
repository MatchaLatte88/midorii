import { Dialog, TextArea, injectStyles, overlayScrollbarCss } from '../../../src/ui';
import { formatDay, formatMoney, formatWhen } from '../format';
import {
    button, ensureFigureStyles, equityCurveSvg, runsTable, sectionLabel, statGrid, tradesTable,
} from './runViews';

/**
 * The run library: everything that was played to the end, on one shelf.
 *
 * A finished replay is already stored beside what a backtest will store — same folder, same
 * shape, same figures — and until now nothing could open it again. This is the reading half:
 * the list, one run in full, and the two things you do to a run afterwards, which are writing
 * down what you learned and throwing it away.
 *
 * Deliberately read-only about the numbers. Nothing here recomputes a statistic: the account
 * summed itself up when it finished, and a second opinion computed at display time is how two
 * screens end up reporting different win rates for the same session.
 *
 * The figures themselves — tiles, curve, trade list — are drawn by runViews, which the
 * Analysis tab draws them with too.
 */

const STYLE_ID = 'midorii-runs';
const CSS = `
.midorii-runs-panel {
    width: fit-content;
    min-width: min(760px, 92vw);
    max-width: min(920px, 94vw);
    max-height: 84vh;
}
.midorii-runs { width: 100%; font-size: 13px; color: var(--vela-fg); }
${overlayScrollbarCss('.vela-dialog--runs .vela-dialog-body')}

.midorii-runs-empty { padding: 28px 4px; text-align: center; color: var(--vela-fg-muted); line-height: 1.6; }

.midorii-runs-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 2px; }
.midorii-runs-head h2 { margin: 0; font-size: 15px; color: var(--vela-fg-bright); }
.midorii-runs-sub { margin: 0 0 14px; color: var(--vela-fg-muted); font-size: 12px; }

.midorii-runs-note { margin-bottom: 14px; }
.midorii-runs-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
`;

/**
 * Opens the library. Resolves when it closes.
 *
 * The list is fetched on open rather than cached: a session finished while this was shut is
 * exactly the run someone opens it to look at.
 */
export async function openRunsDialog(host: HTMLElement): Promise<void> {
    injectStyles(STYLE_ID, CSS, host.ownerDocument);
    ensureFigureStyles(host.ownerDocument);
    const runs = await window.midori.runs.list();

    return new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
            if (settled) return;
            settled = true;
            dialog.hide();
            resolve();
        };

        const scroll = document.createElement('div');
        scroll.className = 'midorii-runs midorii-figures';

        const footer = document.createElement('div');
        const close = button('Close');
        close.onclick = finish;

        let list = runs;

        const showList = (): void => {
            scroll.replaceChildren();
            footer.replaceChildren(close);

            if (list.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'midorii-runs-empty';
                empty.textContent = 'Nothing here yet. Play a replay session to the end and it lands on this shelf, '
                    + 'beside the backtests.';
                scroll.appendChild(empty);
                return;
            }
            scroll.appendChild(runsTable(list, (id) => void showRun(id)));
        };

        const showRun = async (id: string): Promise<void> => {
            const run = await window.midori.runs.load(id);
            scroll.replaceChildren();

            const head = document.createElement('div');
            head.className = 'midorii-runs-head';
            const title = document.createElement('h2');
            title.textContent = `${run.symbol} · ${run.timeframe}`;
            const who = document.createElement('span');
            who.className = 'muted';
            who.textContent = run.strategyName;
            head.append(title, who);

            const sub = document.createElement('p');
            sub.className = 'midorii-runs-sub';
            sub.textContent = `${formatDay(run.from)} to ${formatDay(run.to)} · `
                + `${run.stats.barCount.toLocaleString()} bars · started with ${formatMoney(run.initialBalance)} · `
                + `stored ${formatWhen(run.createdAt)}`;

            const note = new TextArea({
                value: run.note,
                rows: 2,
                placeholder: 'What did this session teach you?',
            });
            note.el.classList.add('midorii-runs-note');
            // Saved on blur rather than behind a button: a note nobody pressed save on is a
            // note that was written and lost.
            note.input.addEventListener('blur', () => {
                const next = note.input.value;
                if (next === run.note) return;
                void window.midori.runs.annotate(run.id, next).then((stored) => {
                    run.note = stored;
                    list = list.map((r) => (r.id === run.id ? { ...r, note: stored } : r));
                });
            });

            scroll.append(
                head,
                sub,
                statGrid(run.stats),
                equityCurveSvg(run.equityCurve, run.initialBalance, run.stats.netPnl),
                note.el,
                sectionLabel(`Trades (${run.trades.length})`),
                tradesTable(run.trades),
            );

            const back = button('← All runs');
            back.onclick = () => showList();
            const remove = button('Delete run', 'danger');
            remove.onclick = () => {
                if (remove.dataset.armed !== '1') {
                    remove.dataset.armed = '1';
                    remove.textContent = 'Delete — click again';
                    return;
                }
                void window.midori.runs.delete(run.id).then(() => {
                    list = list.filter((r) => r.id !== run.id);
                    showList();
                });
            };

            const bar = document.createElement('div');
            bar.className = 'midorii-runs-bar';
            bar.style.cssText += ';width:100%';
            const right = document.createElement('div');
            right.style.cssText = 'display:flex;gap:8px';
            right.append(remove, close);
            bar.append(back, right);
            footer.replaceChildren(bar);
        };

        const dialog = new Dialog({
            title: 'Runs',
            eyebrow: 'Journal',
            host,
            className: 'vela-dialog--runs midorii-runs-panel',
            draggable: true,
            align: 'center',
            onOpenChange: (open) => { if (!open) finish(); },
            content: (body) => {
                body.appendChild(scroll);
                showList();
            },
            footer: (el) => {
                el.appendChild(footer);
            },
        });
        dialog.show();
    });
}
