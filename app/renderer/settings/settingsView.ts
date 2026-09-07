import {
    buildFieldControl, fieldGrid, fieldRow, fieldSection, injectStyles, overlayScrollbarCss,
} from '../../../src/ui';
import { resolveTheme } from '../../../src/core/theme';
import type { VelaTheme } from '../../../src/core/options';
import { openChangelog } from '../about/changelogDialog';
import { button } from '../runs/runViews';
import { STYLES, STYLE_OPTIONS, type AppStyle, type AppThemeName } from '../shell/themes';
import { DEFAULT_PAPER_SETTINGS, needsFreshAccount, type PaperSettings } from '../trading/paperSettings';
import {
    DEFAULT_POSITION_STYLE, LINE_WIDTHS, ZONE_OPACITIES, loadPositionStyle, opacityLabel,
    savePositionStyle, type PositionLineStyle, type PositionStyle,
} from '../trading/positionStyle';
import type { TradeModeHandle } from '../trading/tradeMode';
import { STARTUP_TABS, loadPrefs, savePrefs, type AppPrefs, type StartupTab } from './prefs';

/**
 * The Settings tab: everything about the program that is a choice rather than a result.
 *
 * A page rather than a dialog, and a rail of panes rather than one long scroll, because
 * settings are looked up as often as they are changed — "what is this account charged" is a
 * question, not only an edit. A dialog answers it over the top of the chart and takes the
 * chart away to do it; a page can be read beside the work.
 *
 * What is NOT here
 * ----------------
 * Anything that belongs to one chart. The candles, the grid, the scales and the crosshair
 * are the chart's own settings and stay behind its gear, because they are per-chart: a
 * replay and the live chart are allowed to disagree about them. What this page holds is
 * what the APP is — the theme, what it opens on, how a position is drawn wherever one is
 * drawn, and what a paper account is. So nothing here is a second copy of anything: the
 * position style and the paper account are edited through the same modules the chart's own
 * surfaces edit them through, and a change made here reaches a running chart at once.
 *
 * When a setting applies
 * ----------------------
 * Everything applies as it is changed, except the paper account, which has a Save button
 * because saving it can cost something: the balance and the costs are fixed when an account
 * is created, so changing one files the account as a run and starts a fresh one. A setting
 * that can do that is a setting worth pressing a button for.
 */

const STYLE_ID = 'midorii-settings';
const CSS = `
.midorii-settings {
    position: absolute; inset: 0;
    display: flex; flex-direction: column;
    background: var(--vela-bg);
    color: var(--vela-fg);
    font: 13px/1.5 var(--vela-font, sans-serif);
}
.midorii-settings-bar {
    flex: none;
    display: flex; align-items: center; gap: 10px;
    height: 34px; padding: 0 14px;
    border-bottom: 1px solid var(--vela-border);
    font-size: 12px; color: var(--vela-fg-muted);
}
.midorii-settings-main { flex: 1 1 auto; min-height: 0; display: flex; }

.midorii-settings-rail {
    flex: none; width: 190px; padding: 10px 8px;
    border-right: 1px solid var(--vela-border);
    overflow: auto;
}
${overlayScrollbarCss('.midorii-settings-rail')}
.midorii-settings-tab {
    all: unset;
    display: block; box-sizing: border-box; width: 100%;
    padding: 8px 10px; margin-bottom: 2px;
    border-radius: var(--vela-radius-sm);
    font-size: 13px; font-weight: 600; color: var(--vela-fg-muted);
    cursor: pointer;
}
.midorii-settings-tab:hover { background: var(--vela-hover); color: var(--vela-fg-bright); }
.midorii-settings-tab[data-active='1'] { background: var(--vela-active); color: var(--vela-fg-bright); }

.midorii-settings-body { flex: 1 1 auto; min-width: 0; overflow: auto; }
${overlayScrollbarCss('.midorii-settings-body')}
.midorii-settings-inner { max-width: 820px; margin: 0 auto; padding: 18px 20px 40px; }

.midorii-settings-head { margin: 0 0 4px; font-size: 17px; color: var(--vela-fg-bright); }
.midorii-settings-lede { margin: 0 0 18px; color: var(--vela-fg-muted); font-size: 12.5px; line-height: 1.6; }

.midorii-settings-card {
    padding: 14px 16px 18px; margin-bottom: 16px;
    background: var(--vela-surface);
    border: 1px solid var(--vela-border-faint);
    border-radius: var(--vela-radius-sm);
}
.midorii-settings-card .vela-field-section:first-child { margin-top: 0; }

.midorii-settings-note {
    grid-column: 1 / -1;
    margin: -6px 0 2px;
    color: var(--vela-fg-muted); font-size: 11.5px; line-height: 1.5;
}
.midorii-settings-warn {
    grid-column: 1 / -1;
    margin: 2px 0 0;
    color: var(--vela-danger); font-size: 11.5px; line-height: 1.5;
}
.midorii-settings-value { color: var(--vela-fg-bright); font-variant-numeric: tabular-nums; }

.midorii-settings-actions { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
.midorii-settings-actions-end { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.midorii-settings-status { color: var(--vela-fg-muted); font-size: 12px; }
.midorii-settings-status[data-error='1'] { color: var(--vela-danger); }
`;

/** Which pane is on screen. The rail is the whole of this list, in this order. */
export type SettingsPane = 'general' | 'customization' | 'trading';

const PANES: ReadonlyArray<{ id: SettingsPane; label: string }> = [
    { id: 'general', label: 'General' },
    { id: 'customization', label: 'Customization' },
    { id: 'trading', label: 'Trading' },
];

/** Dropdown labels for a position's line styles, and the values behind them. */
const LINE_STYLES: ReadonlyArray<{ value: PositionLineStyle; label: string }> = [
    { value: 'solid', label: 'Solid' },
    { value: 'dashed', label: 'Dashed' },
    { value: 'dotted', label: 'Dotted' },
];

const THEMES: ReadonlyArray<{ value: AppThemeName; label: string }> = [
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
];

export interface SettingsViewOptions {
    /** The app's theme, read fresh — the topbar's own switch changes it behind this page. */
    theme: () => AppThemeName;
    /** Switch the whole app's theme. The same call the topbar's switch makes. */
    setTheme: (theme: AppThemeName) => void;
    /** Which palette the app is wearing, and how to change it. Read fresh for the same
     *  reason the theme is: this page is not the only thing holding the answer. */
    style: () => AppStyle;
    setStyle: (style: AppStyle) => void;
    /** The paper account: what it is set to, and the one path that applies a change. */
    trading: TradeModeHandle;
}

export interface SettingsViewHandle {
    /** Re-read what is stored and repaint. Called whenever the tab is opened, and whenever
     *  something this page shows was changed somewhere else. */
    refresh(): void;
}

/** Mount the Settings tab into `host`. */
export function mountSettingsView(host: HTMLElement, opts: SettingsViewOptions): SettingsViewHandle {
    const doc = host.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);

    const root = doc.createElement('div');
    root.className = 'midorii-settings';

    const bar = doc.createElement('div');
    bar.className = 'midorii-settings-bar';
    const barLabel = doc.createElement('span');
    barLabel.textContent = 'Settings';
    bar.appendChild(barLabel);

    const main = doc.createElement('div');
    main.className = 'midorii-settings-main';
    const rail = doc.createElement('div');
    rail.className = 'midorii-settings-rail';
    const body = doc.createElement('div');
    body.className = 'midorii-settings-body';
    const inner = doc.createElement('div');
    inner.className = 'midorii-settings-inner';
    body.appendChild(inner);
    main.append(rail, body);

    root.append(bar, main);
    host.appendChild(root);

    const paneButtons = new Map<SettingsPane, HTMLButtonElement>();
    for (const pane of PANES) {
        const b = doc.createElement('button');
        b.className = 'midorii-settings-tab';
        b.textContent = pane.label;
        b.onclick = () => {
            active = pane.id;
            status = null;
            paint();
        };
        paneButtons.set(pane.id, b);
        rail.appendChild(b);
    }

    let active: SettingsPane = 'general';
    let prefs: AppPrefs = loadPrefs();
    let style: PositionStyle = loadPositionStyle();
    /**
     * The paper-account form, which is the one thing here that is not applied as it is
     * typed. Kept across a pane switch rather than thrown away: it is never applied without
     * Save, and losing a half-typed account because the theme was changed on the way past
     * is worse than carrying it.
     */
    let draft: PaperSettings | null = null;
    /** What the draft was seeded from, so an untouched form can tell that the account moved
     *  underneath it — through the chart's own gear — and re-read rather than show a record
     *  nothing holds any more. */
    let draftBase: PaperSettings | null = null;
    let status: { text: string; error?: boolean } | null = null;

    /** The colour picker needs the palette it is drawing on, not the name of it. */
    function theme(): VelaTheme {
        return resolveTheme(opts.theme());
    }

    /* ── small parts ─────────────────────────────────────────────────────── */

    function head(title: string, lede: string): DocumentFragment {
        const frag = doc.createDocumentFragment();
        const h = doc.createElement('h1');
        h.className = 'midorii-settings-head';
        h.textContent = title;
        const p = doc.createElement('p');
        p.className = 'midorii-settings-lede';
        p.textContent = lede;
        frag.append(h, p);
        return frag;
    }

    /** A card holding one field grid. Everything on this page is one of these. */
    function card(...parts: Node[]): HTMLElement {
        const el = doc.createElement('div');
        el.className = 'midorii-settings-card';
        const grid = fieldGrid({ variant: 'settings' });
        /* The label column gives way and the control column hugs, so a control sits at the
         * card's right edge and a paragraph spanning both columns WRAPS. The kit sizes both
         * columns to their content, which is right in a dialog built around its rows and
         * wrong on a page: one long line of explanation would otherwise stretch the grid
         * past the window and put a horizontal scrollbar under the whole tab. Written on the
         * element because that is where the kit writes its own. */
        grid.style.gridTemplateColumns = 'minmax(0, 1fr) max-content';
        grid.append(...parts);
        el.appendChild(grid);
        return el;
    }

    /** A line of explanation that spans both grid columns. */
    function note(text: string): HTMLElement {
        const p = doc.createElement('p');
        p.className = 'midorii-settings-note';
        p.textContent = text;
        return p;
    }

    /** A read-only value, for the facts a settings page states rather than offers. */
    function value(text: string): HTMLElement {
        const span = doc.createElement('span');
        span.className = 'midorii-settings-value';
        span.textContent = text;
        return span;
    }

    function selectRow(
        label: string,
        options: ReadonlyArray<{ value: string; label: string }>,
        current: string,
        onChange: (v: string) => void,
    ): HTMLElement {
        const control = buildFieldControl({
            kind: 'select',
            options: [...options],
            value: current,
            fill: false,
            theme: theme(),
            title: label,
            onChange,
        });
        return fieldRow({ label, control: control.el });
    }

    function numberRow(
        label: string,
        opt: { value: number; min: number; max: number; step: number; onChange: (v: number) => void },
    ): HTMLElement {
        const control = buildFieldControl({
            kind: 'number',
            value: opt.value,
            min: opt.min,
            max: opt.max,
            step: opt.step,
            fill: false,
            steppers: true,
            clamp: true,
            title: label,
            onChange: opt.onChange,
        });
        return fieldRow({ label, control: control.el });
    }

    /** A percentage field over a fraction: typed as 0.1, stored as 0.001. Nobody thinks in
     *  0.0002 — the same bargain the paper-trading dialog makes. */
    function percentRow(
        label: string,
        fraction: number,
        step: number,
        onChange: (fraction: number) => void,
    ): HTMLElement {
        return numberRow(label, {
            value: Number((fraction * 100).toFixed(4)),
            min: 0,
            max: 100,
            step,
            onChange: (v) => onChange(v / 100),
        });
    }

    function boolRow(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
        return fieldRow({ label, bool: true, toggle: { checked, onChange } });
    }

    function colorRow(label: string, get: () => string, onChange: (v: string) => void): HTMLElement {
        const control = buildFieldControl({ kind: 'color', theme: theme(), get, onChange, title: label });
        return fieldRow({ label, control: control.el, fit: true });
    }

    /** The row of buttons under a card, and the one line of feedback beside them. Feedback
     *  reads next to the buttons on the left, never after the right-hand group: a sentence
     *  pushed to the far edge of a wide page is a sentence beside nothing. */
    function actions(...parts: HTMLElement[]): HTMLElement {
        const el = doc.createElement('div');
        el.className = 'midorii-settings-actions';
        el.append(...parts);
        if (status) {
            const line = doc.createElement('span');
            line.className = 'midorii-settings-status';
            if (status.error) line.dataset.error = '1';
            line.textContent = status.text;
            const end = el.querySelector('.midorii-settings-actions-end');
            if (end) el.insertBefore(line, end);
            else el.appendChild(line);
        }
        return el;
    }

    /** A button that asks a second time before it does something that cannot be undone —
     *  the same two step the run shelf uses, and for the same reason: a page has no dialog
     *  to say "are you sure" in. */
    function armed(label: string, armedLabel: string, run: () => void): HTMLButtonElement {
        const b = button(label, 'danger');
        b.onclick = () => {
            if (b.dataset.armed !== '1') {
                b.dataset.armed = '1';
                b.textContent = armedLabel;
                return;
            }
            run();
        };
        b.onmouseleave = () => {
            if (b.dataset.armed !== '1') return;
            delete b.dataset.armed;
            b.textContent = label;
        };
        return b;
    }

    /* ── the panes ───────────────────────────────────────────────────────── */

    function changePrefs(patch: Partial<AppPrefs>): void {
        prefs = { ...prefs, ...patch };
        savePrefs(prefs);
    }

    function changeStyle(patch: Partial<PositionStyle>): void {
        style = { ...style, ...patch };
        // Storing IS applying: whoever is drawing positions is listening for this.
        savePositionStyle(style);
    }

    function paintGeneral(): void {
        inner.append(head(
            'General',
            'How the program starts, and which one it is. Everything here takes effect as it is '
            + 'changed.',
        ));

        inner.append(card(
            fieldSection('Startup'),
            note('Which view a fresh window lands on. Replay is not offered: it asks what to '
                + 'replay before it can show anything, and a window that opens on a question has '
                + 'to be answered before it can be used.'),
            selectRow('Open on start', STARTUP_TABS, prefs.startupTab, (v) => (
                changePrefs({ startupTab: v as StartupTab })
            )),
        ));

        const about = card(
            fieldSection('About'),
            fieldRow({ label: 'Version', control: value(`v${__APP_VERSION__}`), fit: true }),
            fieldRow({ label: 'Platform', control: value(window.midori.platform), fit: true }),
        );
        const notes = button('What changed in this version');
        notes.onclick = () => openChangelog(doc.body);
        about.appendChild(actions(notes));
        inner.append(about);
    }

    function paintCustomization(): void {
        inner.append(head(
            'Customization',
            'What the app looks like, and how a trade is drawn on the chart. Every change here '
            + 'lands on screen at once — on the live chart and on a running replay alike.',
        ));

        // `style` is taken in this file — it is how a POSITION is drawn. This one is the
        // palette the whole app is wearing.
        const palette = opts.style();
        inner.append(card(
            fieldSection('Appearance'),
            selectRow('Colour style', STYLE_OPTIONS, palette, (v) => opts.setStyle(v as AppStyle)),
            note(STYLES[palette].hint),
            selectRow('Theme', THEMES, opts.theme(), (v) => opts.setTheme(v === 'light' ? 'light' : 'dark')),
            note('A style is the palette; dark and light are that palette at two lightnesses, '
                + 'which is why the title bar switches only the second of them. The chart’s own '
                + 'look — candles, grid, crosshair, scales — belongs to the chart and stays '
                + 'behind the gear at the bottom of it, because a replay and the live chart are '
                + 'allowed to differ about it.'),
        ));

        const positions = card(
            fieldSection('Positions'),
            note('How an open trade is drawn, wherever one is open: the entry, the two levels, and '
                + 'the areas between them.'),
            colorRow('Entry', () => style.entryColor, (v) => changeStyle({ entryColor: v })),
            colorRow('Stop loss', () => style.stopColor, (v) => changeStyle({ stopColor: v })),
            colorRow('Take profit', () => style.targetColor, (v) => changeStyle({ targetColor: v })),
            selectRow('Level line', LINE_STYLES, style.levelStyle, (v) => (
                changeStyle({ levelStyle: v as PositionLineStyle })
            )),
            selectRow('Entry line', LINE_STYLES, style.entryStyle, (v) => (
                changeStyle({ entryStyle: v as PositionLineStyle })
            )),
            selectRow(
                'Line width',
                LINE_WIDTHS.map((px) => ({ value: String(px), label: `${px} px` })),
                String(style.lineWidth),
                (v) => changeStyle({ lineWidth: Number.parseInt(v, 10) }),
            ),
            boolRow('Extend to the right edge', style.extendRight, (v) => changeStyle({ extendRight: v })),

            fieldSection('Risk / reward zones'),
            boolRow('Show the zones', style.zones, (v) => changeStyle({ zones: v })),
            selectRow(
                'Opacity',
                ZONE_OPACITIES.map((o) => ({ value: String(o), label: opacityLabel(o) })),
                String(style.zoneOpacity),
                (v) => changeStyle({ zoneOpacity: Number.parseFloat(v) }),
            ),
            boolRow('Fade towards the entry', style.zoneGradient, (v) => changeStyle({ zoneGradient: v })),

            fieldSection('Executions'),
            note('A position says where the account is; a fill says what it did. On a chart being '
                + 'read back the marks are the only thing left of the trades.'),
            boolRow('Mark filled orders', style.executions, (v) => changeStyle({ executions: v })),
        );

        const defaults = button('Back to defaults');
        defaults.onclick = () => {
            style = { ...DEFAULT_POSITION_STYLE };
            savePositionStyle(style);
            status = { text: 'Positions are drawn the way they came.' };
            paint();
        };
        positions.appendChild(actions(defaults));
        inner.append(positions);
    }

    function paintTrading(): void {
        const trading = opts.trading;
        if (!draft) {
            draft = { ...trading.settings };
            draftBase = { ...trading.settings };
        }
        const edit = draft;

        inner.append(head(
            'Trading',
            'What a paper account is, and how a trade on it is sized. The same settings the gear '
            + 'beside the chart’s Trade menu opens — this is the other door to them, not a '
            + 'second copy.',
        ));

        const warn = doc.createElement('p');
        warn.className = 'midorii-settings-warn';
        const save = button('Save', 'primary');

        /** Saving these means a different account, and the button has to say so. */
        const syncSave = (): void => {
            const resets = needsFreshAccount(trading.settings, edit);
            save.textContent = resets ? 'Save and start a fresh account' : 'Save';
            const trades = trading.tradeCount;
            warn.textContent = resets && trades > 0
                ? `The account has ${trades} ${trades === 1 ? 'trade' : 'trades'} on it. They were `
                    + 'taken at the old balance and costs, so they cannot be carried over — saving '
                    + 'files the account as a run and starts a fresh one.'
                : '';
        };

        inner.append(card(
            fieldSection('The account'),
            note('What the account starts with and what it is charged. These are fixed when the '
                + 'account is created — changing one starts a new account, and nothing is thrown '
                + 'away when it does: the old one is filed on the Analysis shelf.'),
            numberRow('Account size', {
                value: edit.balance,
                min: 1,
                max: 1e12,
                step: 1000,
                onChange: (v) => { edit.balance = v; syncSave(); },
            }),
            percentRow('Commission per side (%)', edit.feeRate, 0.01, (v) => { edit.feeRate = v; syncSave(); }),
            percentRow('Spread (%)', edit.spreadPct, 0.005, (v) => { edit.spreadPct = v; syncSave(); }),
            percentRow('Slippage (%)', edit.slippagePct, 0.005, (v) => { edit.slippagePct = v; syncSave(); }),
            boolRow('A second entry opens a second position', edit.hedging, (v) => { edit.hedging = v; syncSave(); }),
            warn,
        ));

        const riskValue = buildFieldControl({
            kind: 'number',
            value: edit.riskValue,
            min: 0.01,
            max: 1e6,
            step: 0.25,
            fill: false,
            clamp: true,
            title: 'Risk per trade',
            onChange: (v) => { edit.riskValue = v; },
        });
        const riskMode = buildFieldControl({
            kind: 'select',
            options: [
                { value: 'percent', label: '% of equity' },
                { value: 'fixed', label: 'cash' },
            ],
            value: edit.riskMode,
            // Filled inside a width of its own: the kit's unfilled select is a 100px column
            // that ellipsises, and "% of eq…" is not a unit anybody can read a risk off.
            fill: true,
            theme: theme(),
            title: 'Risk per trade',
            onChange: (v) => { edit.riskMode = v === 'fixed' ? 'fixed' : 'percent'; },
        });
        const riskModeWrap = doc.createElement('span');
        riskModeWrap.style.width = '132px';
        riskModeWrap.appendChild(riskMode.el);

        inner.append(card(
            fieldSection('How a trade is sized'),
            note('These change under a running account. The size follows from what a trade may '
                + 'lose and how far away its stop is, so a wider stop buys a smaller position '
                + 'rather than a bigger loss.'),
            numberRow('Leverage (max notional × equity)', {
                value: edit.maxLeverage,
                min: 1,
                max: 100,
                step: 0.5,
                onChange: (v) => { edit.maxLeverage = v; },
            }),
            fieldRow({ label: 'Risk per trade', control: [riskValue.el, riskModeWrap] }),
        ));

        save.onclick = () => {
            const applying = { ...edit };
            save.disabled = true;
            void trading.applySettings(applying)
                .then(() => {
                    draft = { ...applying };
                    draftBase = { ...trading.settings };
                    status = { text: 'Saved.' };
                })
                .catch((err: unknown) => {
                    status = { text: err instanceof Error ? err.message : String(err), error: true };
                })
                .finally(() => paint());
        };

        const defaults = button('Defaults');
        defaults.onclick = () => {
            // The form, not the account: nothing is applied until Save, exactly as if every
            // field had been typed back to its default by hand.
            draft = { ...DEFAULT_PAPER_SETTINGS };
            status = null;
            paint();
        };

        const reset = armed('File and reset account', 'File and reset — click again', () => {
            // Read before, not after: an account with nothing on it is not filed at all — the
            // run library refuses an empty one — and saying it was would be a run to go and
            // look for that is not there.
            const had = trading.tradeCount;
            void trading.resetAccount()
                .then(() => {
                    status = {
                        text: had > 0
                            ? 'The account was filed as a run and started again.'
                            : 'A fresh account. The old one had no trades to file.',
                    };
                })
                .catch((err: unknown) => {
                    status = { text: err instanceof Error ? err.message : String(err), error: true };
                })
                .finally(() => paint());
        });
        reset.title = 'File this account as a run and start a fresh one on the current settings. '
            + 'Nothing is thrown away: the trades stay in the run library.';

        const end = doc.createElement('span');
        end.className = 'midorii-settings-actions-end';
        end.append(defaults, save);
        inner.append(actions(reset, end));

        syncSave();
    }

    /* ── painting ────────────────────────────────────────────────────────── */

    function paint(): void {
        for (const [id, b] of paneButtons) {
            if (id === active) b.dataset.active = '1';
            else delete b.dataset.active;
        }

        inner.replaceChildren();
        if (active === 'general') paintGeneral();
        else if (active === 'customization') paintCustomization();
        else paintTrading();
    }

    /**
     * Re-read and repaint.
     *
     * Everything on this page is stored somewhere else — the preferences, the position
     * style, the paper account — and every one of those can be changed by a surface that
     * is not this one. So the page reads them again on the way in rather than trusting
     * what it drew last time.
     */
    function refresh(): void {
        prefs = loadPrefs();
        style = loadPositionStyle();
        /* The paper form is the exception, because it can hold work: an edit nobody has
         * saved yet is kept, and only an UNTOUCHED form is re-read. So changing the account
         * through the chart's own gear shows here on the next visit, and a half-typed
         * balance is not thrown away by a visit to another tab. */
        if (draft && draftBase && JSON.stringify(draft) === JSON.stringify(draftBase)) {
            draft = null;
            draftBase = null;
        }
        status = null;
        paint();
    }

    paint();
    return { refresh };
}
