import { injectStyles } from '../../../src/ui';

/**
 * The band on the chart that says which account this is, and how it is doing.
 *
 * Every traded chart had one and every one of them was written again from scratch — four
 * copies of the same row of figures, four stylesheets that had already begun to drift, and no
 * way for anybody to say which figures they actually wanted. This is the one band, and the
 * columns are a choice.
 *
 * What stays the venue's
 * ----------------------
 * The badge, the accent, the name and the buttons: those are the things that genuinely differ.
 * A funded ProjectX account and a Capital.com demo are not the same claim, and a break-even
 * button exists on exactly one venue. So the band takes them as arguments rather than trying to
 * know about venues — it knows about a row of figures and a strip of controls.
 *
 * The columns are the customization
 * ---------------------------------
 * Each venue offers what it can honestly state; which of those are SHOWN is the person's, kept
 * on this machine and not on the account, because it describes a screen rather than a book.
 * Hiding a column never hides a warning: the note at the end of the row is not a column and
 * cannot be switched off.
 */

const STYLE_ID = 'midorii-band';
const CSS = `
.midorii-band {
    position: absolute;
    top: calc(var(--vela-price-pane-top, 0px) + 10px);
    right: calc(var(--vela-scale-gutter, 0px) + 10px);
    z-index: 5;
    display: flex;
    align-items: center;
    gap: var(--vela-space-3);
    padding: 7px 10px 8px 12px;
    border: 1px solid var(--vela-border);
    border-left: 3px solid var(--midorii-band-accent, var(--vela-accent));
    border-radius: var(--vela-radius-md);
    background: var(--vela-surface-elev);
    box-shadow: var(--vela-shadow);
    user-select: none;
}
/* Real money reads as real money, whatever the venue is called. */
.midorii-band[data-live='1'] { border-color: var(--vela-danger); border-left-color: var(--vela-danger); }
/* Figures that are no longer being confirmed say so by fading; the note says why. */
.midorii-band[data-stale='1'] .midorii-band-col { opacity: 0.4; }

.midorii-band-badge {
    flex: 0 0 auto;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
}
.midorii-band-badge[data-live='1'] { background: var(--vela-danger); color: var(--vela-fg-on-fill); }
.midorii-band-badge[data-live='0'] {
    border: 1px solid var(--midorii-band-accent, var(--vela-accent));
    background: var(--vela-surface);
    color: var(--midorii-band-accent, var(--vela-accent));
}

.midorii-band-name {
    flex: 0 1 auto;
    max-width: 22ch;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--vela-fg-bright);
    font-size: var(--vela-font-size-sm);
    font-weight: 600;
}

.midorii-band-cols { display: flex; align-items: center; gap: var(--vela-space-3); }
.midorii-band-col { display: flex; flex-direction: column; gap: 1px; min-width: 62px; }
.midorii-band-col[hidden] { display: none; }
.midorii-band-label {
    color: var(--vela-fg-muted);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
}
.midorii-band-value {
    color: var(--vela-fg-bright);
    font-family: var(--vela-font-mono);
    font-variant-numeric: tabular-nums;
    font-size: var(--vela-font-size-lg);
    line-height: 1.25;
}
.midorii-band-value[data-tone='up'] { color: var(--vela-up); }
.midorii-band-value[data-tone='down'] { color: var(--vela-down); }

.midorii-band-note {
    max-width: 15ch;
    color: var(--vela-fg-muted);
    font-size: 10px;
    line-height: 1.3;
}
.midorii-band-note.warn { color: var(--vela-danger); }
.midorii-band-note:empty { display: none; }

.midorii-band-actions { display: flex; align-items: center; gap: var(--vela-space-1); }
.midorii-band-btn {
    all: unset;
    box-sizing: border-box;
    padding: 5px 12px;
    border: 1px solid var(--vela-border);
    border-radius: var(--vela-radius-md);
    color: var(--vela-fg);
    font-size: var(--vela-font-size-md);
    cursor: pointer;
    transition: background var(--vela-dur-fast) var(--vela-ease), border-color var(--vela-dur-fast) var(--vela-ease);
}
.midorii-band-btn:hover:not([disabled]) { background: var(--vela-hover); }
.midorii-band-btn[disabled] { opacity: 0.4; cursor: default; }
.midorii-band-btn[data-tone='danger'] { border-color: var(--vela-danger-line); color: var(--vela-danger); }
.midorii-band-btn[data-tone='danger']:hover:not([disabled]) { background: var(--vela-danger-soft); }

/* Which figures are shown. A gear rather than a menu bar: it is set once and then left. */
.midorii-band-pick {
    all: unset;
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border-radius: var(--vela-radius-sm);
    color: var(--vela-fg-faint);
    font-size: 12px;
    cursor: pointer;
    transition: background var(--vela-dur-fast) var(--vela-ease), color var(--vela-dur-fast) var(--vela-ease);
}
.midorii-band-pick:hover { background: var(--vela-hover); color: var(--vela-fg-bright); }
.midorii-band[data-picking='1'] .midorii-band-pick { background: var(--vela-hover-strong); color: var(--vela-fg-bright); }

.midorii-band-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 1;
    min-width: 170px;
    padding: var(--vela-space-1);
    border: 1px solid var(--vela-border);
    border-radius: var(--vela-radius-md);
    background: var(--vela-surface-elev);
    box-shadow: var(--vela-shadow);
}
.midorii-band-menu[hidden] { display: none; }
.midorii-band-menu label {
    display: flex;
    align-items: center;
    gap: var(--vela-space-2);
    padding: 5px var(--vela-space-2);
    border-radius: var(--vela-radius-sm);
    font-size: var(--vela-font-size-md);
    color: var(--vela-fg);
    cursor: pointer;
}
.midorii-band-menu label:hover { background: var(--vela-hover); }
.midorii-band-menu input { accent-color: var(--vela-accent); margin: 0; }
`;

/** One figure the band can show. `value` is read fresh on every repaint. */
export interface BandColumn {
    /** Stable across versions — it is what the chosen set is stored as. */
    id: string;
    /**
     * What the figure is called.
     *
     * A function where the name itself depends on the account: a CFD account's equity is
     * "Equity EUR" or "Equity USD" and the currency is not decoration — the same number means
     * different money, and a label that left it out would be the band's one real lie.
     */
    label: string | (() => string);
    /** What the label's tooltip says. Where the figure comes from, not what it is called. */
    title: string;
    value(): string;
    /** Colours the figure by what it is. Absent ⇒ the plain foreground. */
    tone?(): 'up' | 'down' | null;
    /** Off until somebody asks for it. Absent ⇒ shown by default. */
    optional?: boolean;
}

/** One control at the end of the row. */
export interface BandAction {
    id: string;
    label: string;
    tone?: 'danger';
    /** Why it cannot be pressed right now, or null. Shown as the tooltip either way. */
    refusal?(): string | null;
    title?(): string;
    run(): void;
    /**
     * Press once to arm, once more to do it — for the destructive one.
     *
     * The label changes while armed and goes back when the pointer leaves, which is the same
     * bargain a confirmation dialog strikes without stopping the screen to strike it.
     */
    arm?: { label: string };
}

export interface AccountBandOptions {
    /** Where it mounts — the chart cell. */
    cell: HTMLElement;
    /** What this account is called. Shown in full: on some venues it is the only thing that
     *  tells two accounts apart. Absent ⇒ no name shown. */
    name?: string;
    /** The short word in the pill. */
    badge: string;
    badgeTitle: string;
    /** Whether orders from this chart are real orders. Drives the whole band's colour. */
    live: boolean;
    /** The venue's own colour, where it has one. */
    accent?: string;
    columns: readonly BandColumn[];
    actions?: readonly BandAction[];
    /** Whether the figures are still being confirmed, and what to say when they are not. */
    staleNote?(): string | null;
    /** Where the chosen columns are kept. One key per venue, so two accounts do not fight. */
    storageKey: string;
}

export interface AccountBand {
    readonly el: HTMLElement;
    /** Redraw the figures and the controls from the account as it stands. */
    refresh(): void;
    destroy(): void;
}

/** Which columns this machine wants, or null where it has never said. */
function loadChosen(key: string): string[] | null {
    try {
        const raw = localStorage.getItem(key);
        if (raw == null) return null;
        const list = JSON.parse(raw) as unknown;
        return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : null;
    } catch (err) {
        console.error('[midorii] could not read the account band columns', err);
        return null;
    }
}

function saveChosen(key: string, ids: readonly string[]): void {
    try {
        localStorage.setItem(key, JSON.stringify(ids));
    } catch (err) {
        console.error('[midorii] could not persist the account band columns', err);
    }
}

export function mountAccountBand(opts: AccountBandOptions): AccountBand {
    const doc = opts.cell.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);

    const el = doc.createElement('div');
    el.className = 'midorii-band';
    el.dataset.live = opts.live ? '1' : '0';
    if (opts.accent) el.style.setProperty('--midorii-band-accent', opts.accent);

    const badge = doc.createElement('span');
    badge.className = 'midorii-band-badge';
    badge.dataset.live = opts.live ? '1' : '0';
    badge.textContent = opts.badge;
    badge.title = opts.badgeTitle;
    el.append(badge);

    if (opts.name) {
        const name = doc.createElement('span');
        name.className = 'midorii-band-name';
        name.textContent = opts.name;
        name.title = `Orders from this chart go to ${opts.name}.`;
        el.append(name);
    }

    /* What is shown, and what has merely never been asked about. A column added in a later
     * version is shown or not by its own default rather than by an old stored list, which is
     * why the stored set is a list of what is ON rather than a list of what is off. */
    const stored = loadChosen(opts.storageKey);
    const chosen = new Set(stored ?? opts.columns.filter((c) => !c.optional).map((c) => c.id));

    const cols = doc.createElement('div');
    cols.className = 'midorii-band-cols';
    const built = opts.columns.map((column) => {
        const box = doc.createElement('div');
        box.className = 'midorii-band-col';
        const label = doc.createElement('span');
        label.className = 'midorii-band-label';
        label.textContent = typeof column.label === 'string' ? column.label : column.label();
        label.title = column.title;
        const value = doc.createElement('span');
        value.className = 'midorii-band-value';
        value.textContent = '—';
        box.append(label, value);
        cols.append(box);
        return { column, box, label, value };
    });
    el.append(cols);

    const note = doc.createElement('span');
    note.className = 'midorii-band-note';
    el.append(note);

    // ── the controls the venue offers ────────────────────────────────────
    const actions = doc.createElement('div');
    actions.className = 'midorii-band-actions';
    const buttons = (opts.actions ?? []).map((action) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'midorii-band-btn';
        b.textContent = action.label;
        if (action.tone) b.dataset.tone = action.tone;

        let armed = false;
        const disarm = (): void => {
            if (!armed) return;
            armed = false;
            b.textContent = action.label;
        };
        b.onclick = () => {
            if (action.arm && !armed) {
                armed = true;
                b.textContent = action.arm.label;
                return;
            }
            disarm();
            action.run();
        };
        b.onmouseleave = disarm;
        actions.append(b);
        return { action, b, disarm };
    });
    if (buttons.length > 0) el.append(actions);

    // ── which figures are shown ──────────────────────────────────────────
    const pick = doc.createElement('button');
    pick.type = 'button';
    pick.className = 'midorii-band-pick';
    pick.textContent = '⋮';
    pick.title = 'Which figures this band shows';

    const menu = doc.createElement('div');
    menu.className = 'midorii-band-menu';
    menu.hidden = true;
    for (const column of opts.columns) {
        const row = doc.createElement('label');
        const box = doc.createElement('input');
        box.type = 'checkbox';
        box.checked = chosen.has(column.id);
        box.onchange = () => {
            if (box.checked) chosen.add(column.id);
            else chosen.delete(column.id);
            saveChosen(opts.storageKey, [...chosen]);
            refresh();
        };
        const text = doc.createElement('span');
        text.textContent = typeof column.label === 'string' ? column.label : column.label();
        row.append(box, text);
        menu.append(row);
    }
    el.append(pick, menu);

    const closeMenu = (): void => {
        menu.hidden = true;
        el.dataset.picking = '0';
    };
    pick.onclick = (event) => {
        event.stopPropagation();
        menu.hidden = !menu.hidden;
        el.dataset.picking = menu.hidden ? '0' : '1';
    };
    /* Dismissed by a press anywhere else, the way every other small menu in the app is. */
    const onOutside = (event: MouseEvent): void => {
        if (!menu.hidden && !el.contains(event.target as Node)) closeMenu();
    };
    doc.addEventListener('mousedown', onOutside);

    opts.cell.appendChild(el);

    function refresh(): void {
        for (const { column, box, label, value } of built) {
            const on = chosen.has(column.id);
            box.hidden = !on;
            if (!on) continue;
            if (typeof column.label === 'function') label.textContent = column.label();
            value.textContent = column.value();
            const tone = column.tone?.() ?? null;
            if (tone) value.dataset.tone = tone;
            else delete value.dataset.tone;
        }

        for (const { action, b, disarm } of buttons) {
            const refusal = action.refusal?.() ?? null;
            b.disabled = refusal != null;
            b.title = refusal ?? action.title?.() ?? '';
            if (refusal != null) disarm();
        }

        const stale = opts.staleNote?.() ?? null;
        el.dataset.stale = stale ? '1' : '0';
        note.textContent = stale ?? '';
        note.classList.toggle('warn', stale != null);
    }

    refresh();

    return {
        el,
        refresh,
        destroy(): void {
            doc.removeEventListener('mousedown', onOutside);
            el.remove();
        },
    };
}
