import { injectStyles } from '../../../src/ui';
import { accountTopbarMetrics, type AccountTopbarSnapshot } from './accountTopbarModel';

const CHEVRON = '<svg viewBox="0 0 12 8" width="9" height="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m2 2 4 4 4-4"/></svg>';
const LOCK = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><rect x="3.25" y="7" width="9.5" height="7" rx="1.5"/><path d="M5.25 7V4.75a2.75 2.75 0 0 1 5.5 0V7"/></svg>';

const STYLE_ID = 'midorii-account-topbar';
/**
 * The account strip in the title bar — who is trading, how that account is doing, and the
 * lock that ends it.
 *
 * It states the same four figures the on-chart band states (trading/accountBand.ts) and is
 * built out of the same two pieces: a tracked label over a mono figure. One readout at two
 * sizes rather than two designs.
 *
 * THREE objects, not six. The account is a control, the four figures are ONE panel with
 * hairlines between them, and the lock is a control. A box around every single figure made
 * a readout look like a row of buttons that were not clickable — and since `--vela-surface`
 * IS the bar's own background, those boxes were outlines around nothing. The panel now sits
 * one wash above the bar, so it reads as a surface with figures on it.
 */
const CSS = `
.midorii-account-topbar {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 100%;
    margin-right: 8px;
    -webkit-app-region: no-drag;
}
.midorii-account-topbar[hidden] { display: none !important; }

/* One height and one shape for the three objects, so the strip is a row and not a pile. */
.midorii-account-picker,
.midorii-account-metrics,
.midorii-account-lock {
    box-sizing: border-box;
    height: 30px;
    border: 1px solid var(--vela-border);
    border-radius: var(--vela-radius-md);
    background: var(--vela-surface-elev);
}

.midorii-account-picker {
    all: unset;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    width: 188px;
    height: 30px;
    padding: 0 8px 0 10px;
    border: 1px solid color-mix(in srgb, var(--midorii-account-accent, var(--vela-border)) 62%, var(--vela-border));
    border-radius: var(--vela-radius-md);
    background: var(--vela-surface-elev);
    cursor: pointer;
    transition: background var(--vela-dur-fast) var(--vela-ease), border-color var(--vela-dur-fast) var(--vela-ease);
}
.midorii-account-picker:hover:not([disabled]) { background: var(--vela-hover); border-color: var(--midorii-account-accent, var(--vela-fg-faint)); }
.midorii-account-picker:focus-visible { outline: 2px solid var(--vela-accent-bright); outline-offset: 1px; }
/* Real money reads as real money — the same danger edge the on-chart band wears, and the
   faintest wash of it behind, because an outline on its own is easy to stop seeing. */
.midorii-account-picker[data-live='1'] { border-color: var(--vela-danger); background: var(--vela-danger-soft); }
.midorii-account-picker[data-live='1']:hover:not([disabled]) { border-color: var(--vela-danger); }
.midorii-account-picker[disabled] { cursor: default; opacity: 0.68; }
.midorii-account-picker[hidden] { display: none !important; }

/* Venue OVER account, not "venue | account": the pipe existed to squeeze two facts into one
   cramped line, and two lines state them at a size worth reading. The lower line is the
   loud one throughout this strip, so it shares a baseline with the figures beside it. */
.midorii-account-picker-text {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 1px;
    flex: 1 1 auto;
    min-width: 0;
}
.midorii-account-picker-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--midorii-account-accent, var(--vela-accent-ink));
    font-size: 9px;
    line-height: 10px;
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
}
.midorii-account-picker-detail {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--vela-fg-bright);
    font-size: 12px;
    line-height: 14px;
    font-weight: 600;
}
.midorii-account-picker[data-live='1'] .midorii-account-picker-detail { color: var(--vela-danger); }
.midorii-account-picker-chevron { display: inline-flex; flex: none; color: var(--vela-fg-muted); }
.midorii-account-picker-chevron[hidden] { display: none !important; }

.midorii-account-metrics { display: inline-flex; align-items: stretch; overflow: hidden; }
.midorii-account-metric {
    box-sizing: border-box;
    display: grid;
    align-content: center;
    gap: 1px;
    /* A floor, not a width: the cell still grows for a figure that needs the room, so a
       six-figure balance is never the one that gets clipped. */
    min-width: 86px;
    padding: 0 10px;
}
/* Rules INSIDE the panel, not a border around each figure. */
.midorii-account-metric + .midorii-account-metric { border-left: 1px solid var(--vela-border-faint); }
.midorii-account-metric-label {
    color: var(--vela-fg-muted);
    font-family: var(--vela-font, sans-serif);
    font-size: 9px;
    line-height: 10px;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    white-space: nowrap;
}
.midorii-account-metric-value {
    color: var(--vela-fg-bright);
    font-family: var(--vela-font-mono);
    font-size: 12px;
    line-height: 14px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}
.midorii-account-metric-value[data-tone='up'] { color: var(--vela-up); }
.midorii-account-metric-value[data-tone='down'] { color: var(--vela-down); }

.midorii-account-lock {
    all: unset;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border: 1px solid var(--vela-border);
    border-radius: var(--vela-radius-md);
    color: var(--vela-fg-muted);
    background: var(--vela-surface-elev);
    cursor: pointer;
    transition: background var(--vela-dur-fast) var(--vela-ease), border-color var(--vela-dur-fast) var(--vela-ease), color var(--vela-dur-fast) var(--vela-ease);
}
.midorii-account-lock:hover:not([disabled]) { color: var(--vela-danger); background: var(--vela-danger-soft); border-color: var(--vela-danger-line); }
.midorii-account-lock:focus-visible { outline: 2px solid var(--vela-accent-bright); outline-offset: 1px; }
.midorii-account-lock[disabled] { opacity: 0.42; cursor: default; }
.midorii-account-lock[hidden] { display: none !important; }

/* A narrow window drops figures from the left, the least urgent news first. Whichever one
   is left leading loses its rule — a hidden neighbour still matches the sibling selector. */
@media (max-width: 1430px) {
    .midorii-account-topbar { gap: 5px; margin-right: 6px; }
    .midorii-account-picker { width: 160px; padding-left: 8px; }
    .midorii-account-metric { min-width: 78px; padding-inline: 8px; }
}
@media (max-width: 1260px) {
    .midorii-account-picker { width: 124px; }
    .midorii-account-metric[data-id='limit'] { display: none; }
}
@media (max-width: 1090px) {
    .midorii-account-metric[data-id='balance'] { display: none; }
    .midorii-account-metric[data-id='realised'] { border-left: none; }
}
@media (max-width: 970px) {
    .midorii-account-metric[data-id='realised'] { display: none; }
    .midorii-account-metric[data-id='unrealised'] { border-left: none; }
}
`;

export interface AccountTopbarSource {
    read(): AccountTopbarSnapshot;
    openSelector?(trigger: HTMLElement): void;
    lock?(): void | Promise<void>;
}

export interface AccountTopbarHandle {
    readonly el: HTMLElement;
    setSource(source: AccountTopbarSource | null): void;
    refresh(): void;
}

export function mountAccountTopbar(host: HTMLElement): AccountTopbarHandle {
    const doc = host.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);

    const el = doc.createElement('span');
    el.className = 'midorii-account-topbar';
    el.hidden = true;

    const picker = doc.createElement('button');
    picker.type = 'button';
    picker.className = 'midorii-account-picker';
    const pickerText = doc.createElement('span');
    pickerText.className = 'midorii-account-picker-text';
    const pickerLabel = doc.createElement('span');
    pickerLabel.className = 'midorii-account-picker-label';
    const pickerDetail = doc.createElement('span');
    pickerDetail.className = 'midorii-account-picker-detail';
    pickerText.append(pickerLabel, pickerDetail);
    const pickerChevron = doc.createElement('span');
    pickerChevron.className = 'midorii-account-picker-chevron';
    pickerChevron.innerHTML = CHEVRON;
    picker.append(pickerText, pickerChevron);

    const figures = doc.createElement('span');
    figures.className = 'midorii-account-metrics';
    const metrics = new Map<string, { el: HTMLElement; label: HTMLElement; value: HTMLElement }>();
    for (const id of ['balance', 'limit', 'realised', 'unrealised'] as const) {
        const metric = doc.createElement('span');
        metric.className = 'midorii-account-metric';
        metric.dataset.id = id;
        const label = doc.createElement('span');
        label.className = 'midorii-account-metric-label';
        const value = doc.createElement('span');
        value.className = 'midorii-account-metric-value';
        metric.append(label, value);
        metrics.set(id, { el: metric, label, value });
        figures.appendChild(metric);
    }

    const lock = doc.createElement('button');
    lock.type = 'button';
    lock.className = 'midorii-account-lock';
    lock.innerHTML = LOCK;

    el.append(picker, figures, lock);
    host.appendChild(el);

    let source: AccountTopbarSource | null = null;
    let lastSnapshot: AccountTopbarSnapshot | null = null;

    picker.addEventListener('click', () => source?.openSelector?.(picker));
    lock.addEventListener('click', () => {
        if (!lastSnapshot?.canLock) return;
        void source?.lock?.();
    });

    const refresh = (): void => {
        if (!source) {
            lastSnapshot = null;
            el.hidden = true;
            return;
        }
        const snapshot = source.read();
        lastSnapshot = snapshot;
        el.hidden = false;

        const account = snapshot.account;
        picker.hidden = account == null;
        if (account) {
            pickerLabel.textContent = account.label;
            pickerDetail.textContent = account.detail ?? '';
            pickerDetail.hidden = !account.detail;
            picker.disabled = snapshot.selectable !== true;
            picker.dataset.live = account.live ? '1' : '0';
            // The ink of the accent pair, not the bright one: this is the venue's name set
            // as TEXT, and on paper the bright partner is a pale line nobody can read.
            picker.style.setProperty('--midorii-account-accent', account.accent ?? 'var(--vela-accent-ink)');
            picker.title = snapshot.selectable ? 'Choose an account' : account.label;
            picker.setAttribute('aria-label', snapshot.selectable ? `Choose account. Current: ${account.label}` : account.label);
            pickerChevron.hidden = snapshot.selectable !== true;
        }

        for (const metric of accountTopbarMetrics(snapshot)) {
            const target = metrics.get(metric.id)!;
            target.label.textContent = metric.label;
            target.value.textContent = metric.value;
            target.el.title = metric.title;
            if (metric.tone) target.value.dataset.tone = metric.tone;
            else delete target.value.dataset.tone;
        }

        lock.hidden = snapshot.context === 'backtest';
        lock.disabled = snapshot.canLock !== true;
        lock.title = snapshot.lockTitle ?? 'Trading is already locked';
        lock.setAttribute('aria-label', lock.title);
    };

    // Venue marks and live bot ticks can move between controller events. A compact readout
    // should never be the stale copy, so it samples while it is visible and does no work when
    // the current app view has no source.
    window.setInterval(() => {
        if (source && !el.hidden) refresh();
    }, 500);

    return {
        el,
        setSource(next): void {
            source = next;
            refresh();
        },
        refresh,
    };
}
