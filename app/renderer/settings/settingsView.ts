import {
    buildFieldControl, fieldGrid, fieldRow, fieldSection, iconEl, injectStyles, overlayScrollbarCss,
} from '../../../src/ui';
import { resolveTheme } from '../../../src/core/theme';
import type { VelaTheme } from '../../../src/core/options';
import { openChangelog } from '../about/changelogDialog';
import { button } from '../runs/runViews';
import { STYLES, STYLE_OPTIONS, type AppStyle, type AppThemeName } from '../shell/themes';
import { DEFAULT_PAPER_SETTINGS, needsFreshAccount, type PaperSettings } from '../trading/paperSettings';
import { normalizeQuickSizes } from '../replay/orderTicket';
import {
    DEFAULT_POSITION_STYLE, LINE_WIDTHS, ZONE_OPACITIES, loadPositionStyle, opacityLabel,
    savePositionStyle, type PositionLineStyle, type PositionStyle,
} from '../trading/positionStyle';
import type { TradeModeHandle } from '../trading/tradeMode';
import { loadAlertDisplay, saveAlertDisplay, type AlertDisplay } from '../alerts/alertDisplay';
import { loadQuoteDisplay, saveQuoteDisplay, type QuoteDisplay } from '../quotes/quoteDisplay';
import type { MidoriCapitalAccountSummary, MidoriCapitalCredentialStatus } from '../midori';
import { loadOverlayDisplay, saveOverlayDisplay, type OverlayDisplay } from '../replay/overlayDisplay';
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

/* A secret typed blind is a secret typed wrong, so the field carries its own reveal.
   The button sits inside the box rather than beside it: the row stays one control wide,
   and the eye belongs to that field and no other. */
.midorii-settings-secret { position: relative; display: block; width: 100%; }
.midorii-settings-secret .vela-text-field { padding-right: 34px; }
.midorii-settings-reveal {
    all: unset;
    box-sizing: border-box;
    position: absolute; top: 50%; right: 4px; transform: translateY(-50%);
    display: flex; align-items: center; justify-content: center;
    width: 26px; height: 26px;
    border-radius: var(--vela-radius-sm);
    color: var(--vela-fg-muted);
    cursor: pointer;
}
.midorii-settings-reveal:hover { background: var(--vela-hover); color: var(--vela-fg-bright); }
.midorii-settings-reveal:focus-visible { box-shadow: 0 0 0 2px var(--vela-focus); }
.midorii-settings-reveal .vela-icon, .midorii-settings-reveal svg { display: block; width: 15px; height: 15px; }

.midorii-settings-actions { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
.midorii-settings-actions-end { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.midorii-settings-status { color: var(--vela-fg-muted); font-size: 12px; }
.midorii-settings-status[data-error='1'] { color: var(--vela-danger); }
`;

/** Which pane is on screen. The rail is the whole of this list, in this order. */
export type SettingsPane = 'general' | 'customization' | 'trading' | 'brokers';

const PANES: ReadonlyArray<{ id: SettingsPane; label: string }> = [
    { id: 'general', label: 'General' },
    { id: 'customization', label: 'Customization' },
    { id: 'trading', label: 'Trading' },
    { id: 'brokers', label: 'Broker connection' },
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
    let alertDisplay: AlertDisplay = loadAlertDisplay();
    let quoteDisplay: QuoteDisplay = loadQuoteDisplay();
    /** What is stored for the broker — never the secret itself, which the main process
     *  has no channel to hand back. Null until the first read. */
    let broker: MidoriCapitalCredentialStatus | null = null;
    /** What is currently typed into the connection form. Kept across repaints so a half-
     *  entered key is not lost by switching tabs. */
    const brokerDraft = { apiKey: '', identifier: '', password: '', env: 'demo' as 'demo' | 'live' };
    let overlayDisplay: OverlayDisplay = loadOverlayDisplay();
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
        /** Fixed control width. Without it the control hugs its own content, which is right
         *  for a short list and wrong where the row sits beside typed fields. */
        width?: number,
    ): HTMLElement {
        const control = buildFieldControl({
            kind: 'select',
            options: [...options],
            value: current,
            fill: width != null,
            theme: theme(),
            title: label,
            onChange,
        });
        return fieldRow({ label, control: control.el, controlWidth: width });
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

    function changeAlertDisplay(patch: Partial<AlertDisplay>): void {
        alertDisplay = { ...alertDisplay, ...patch };
        saveAlertDisplay(alertDisplay); // same contract: the chart is listening
    }

    function changeQuoteDisplay(patch: Partial<QuoteDisplay>): void {
        quoteDisplay = { ...quoteDisplay, ...patch };
        saveQuoteDisplay(quoteDisplay); // same contract: the chart is listening
    }

    function changeOverlayDisplay(patch: Partial<OverlayDisplay>): void {
        overlayDisplay = { ...overlayDisplay, ...patch };
        saveOverlayDisplay(overlayDisplay); // same contract: the chart is listening
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

        inner.append(card(
            fieldSection('Alerts'),
            note('An alert’s tag repeats its level by default. Turning that off leaves the price '
                + 'to the axis alone — where a position and its stop and target already leave '
                + 'theirs — and the tag says only what the alert is. Nothing about when it fires '
                + 'changes.'),
            boolRow('Show the level on the tag', alertDisplay.showLevel, (v) => (
                changeAlertDisplay({ showLevel: v })
            )),
        ));

        inner.append(card(
            fieldSection('Bid and ask'),
            note('Forex and commodity charts draw their candles from the bid, so the chart '
                + 'alone never says what a buy costs. Three ways of showing it, off '
                + 'independently: the card in the corner, the two levels across the plot, and '
                + 'the prices chipped onto the scale beside them. Markets that quote a single '
                + 'price — every crypto venue here — show none of it either way.'),
            boolRow('Show the bid/ask card', quoteDisplay.showCard, (v) => (
                changeQuoteDisplay({ showCard: v })
            )),
            boolRow('Show the two levels on the chart', quoteDisplay.showLines, (v) => (
                changeQuoteDisplay({ showLines: v })
            )),
            boolRow('Show their prices on the scale', quoteDisplay.showBrackets, (v) => (
                changeQuoteDisplay({ showBrackets: v })
            )),
        ));

        inner.append(card(
            fieldSection('Chart cards'),
            note('The account card and the quick ticket float over the plot, and both can be '
                + 'dragged anywhere on it and closed from their own corner — closed, they come '
                + 'straight back through the button in the top right. This is the other answer: '
                + 'somebody who reads the account in the dock below the chart can have the card '
                + 'gone for good, and the ticket then takes the corner it was using.'),
            boolRow('Show the account card', overlayDisplay.showAccount, (v) => (
                changeOverlayDisplay({ showAccount: v })
            )),
        ));
    }

    /**
     * Where a real account is connected.
     *
     * Its own pane rather than a corner of Trading, because it is a different kind of thing:
     * Trading is what a trade IS, this is who you are to the venue. And it is the one screen
     * in the app that handles a secret, which is worth keeping visibly separate.
     *
     * The key and the password go in and never come back. The main process has no channel
     * that returns them — the status call says only whether something is stored and which
     * login it belongs to — so this form can show what is connected without ever having held
     * the secret that connects it.
     */
    function paintBrokers(): void {
        inner.append(head(
            'Broker connection',
            'The account Midorii trades through. Stored encrypted by your operating system, '
            + 'never in a file anyone could read.',
        ));

        const status = doc.createElement('p');
        status.className = 'midorii-settings-status';
        const accounts = doc.createElement('div');
        accounts.className = 'midorii-settings-note';

        const say = (text: string, error = false): void => {
            status.textContent = text;
            if (error) status.dataset.error = '1';
            else delete status.dataset.error;
        };

        const listAccounts = (found: MidoriCapitalAccountSummary[]): void => {
            accounts.replaceChildren();
            for (const a of found) {
                const line = doc.createElement('div');
                const money = a.balance == null
                    ? ''
                    : ` · ${a.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${a.currency}`;
                // The filled bullet marks the account the venue treats as active — the one
                // every order and every history read is scoped to.
                line.textContent = `${a.preferred ? '●' : '○'} ${a.accountName} (${a.accountId})${money}`;
                accounts.appendChild(line);
            }
        };

        /* What is stored right now, in words. Whether a .env.local is supplying credentials
         * is worth saying: a connection that works with nothing stored is otherwise a
         * mystery, and so is one that ignores a file somebody edited. */
        if (broker?.configured) {
            say(`Connected as ${broker.identifier ?? 'unknown'} · ${broker.env === 'live' ? 'LIVE MONEY' : 'demo'}`);
        } else if (broker?.envPresent) {
            say('Using credentials from .env.local. Saving here replaces them.');
        } else {
            say('Not connected.');
        }

        /* These rows are typed into, not picked from, and what goes in them is long: a key,
         * an email address, a password. The card's control column hugs its content, which
         * leaves a filling field with nothing to fill — so the width is stated here. */
        const FIELD_WIDTH = 340;

        const field = (
            label: string,
            key: 'apiKey' | 'identifier' | 'password',
            placeholder: string,
            secret = false,
        ): HTMLElement => {
            const control = buildFieldControl({
                kind: 'text',
                value: brokerDraft[key],
                fill: true,
                placeholder,
                onChange: (v) => { brokerDraft[key] = v; },
            });
            if (!secret) return fieldRow({ label, control: control.el, controlWidth: FIELD_WIDTH });

            // The kit has no password field; this is the same control with its characters
            // hidden, which is all a password field is — plus the button that shows them
            // again, because a key that cannot be read back cannot be checked for a typo.
            const input = control.el.querySelector('input');
            if (input) input.type = 'password';
            const wrap = doc.createElement('div');
            wrap.className = 'midorii-settings-secret';
            const reveal = doc.createElement('button');
            reveal.type = 'button';
            reveal.className = 'midorii-settings-reveal';
            const paintReveal = (): void => {
                const shown = input?.type === 'text';
                reveal.replaceChildren(iconEl(shown ? 'eye-off' : 'eye', doc));
                const title = `${shown ? 'Hide' : 'Show'} ${label.toLowerCase()}`;
                reveal.title = title;
                reveal.setAttribute('aria-label', title);
            };
            reveal.onclick = () => {
                if (!input) return;
                input.type = input.type === 'password' ? 'text' : 'password';
                paintReveal();
            };
            paintReveal();
            wrap.append(control.el, reveal);
            return fieldRow({ label, control: wrap, controlWidth: FIELD_WIDTH });
        };

        const save = button('Connect and save', 'primary');
        const test = button('Test only');
        const forget = button('Forget', 'danger');

        const collect = (): { apiKey: string; identifier: string; password: string; env: 'demo' | 'live' } | null => {
            const apiKey = brokerDraft.apiKey.trim();
            const identifier = brokerDraft.identifier.trim();
            const password = brokerDraft.password;
            if (!apiKey || !identifier || !password) {
                say('Fill in the API key, the login email and the key password first.', true);
                return null;
            }
            return { apiKey, identifier, password, env: brokerDraft.env };
        };

        const busy = (on: boolean): void => {
            save.disabled = on;
            test.disabled = on;
        };

        test.onclick = () => {
            const creds = collect();
            if (!creds) return;
            busy(true);
            say('Connecting…');
            void window.midori.capital.credentials.test(creds)
                .then((found) => {
                    listAccounts(found);
                    say(`Works — ${found.length} ${found.length === 1 ? 'account' : 'accounts'} reachable. Nothing was saved.`);
                })
                .catch((err: unknown) => say(err instanceof Error ? err.message : String(err), true))
                .finally(() => busy(false));
        };

        save.onclick = () => {
            const creds = collect();
            if (!creds) return;
            busy(true);
            say('Connecting…');
            /* Tried before it is stored, so a key that does not work is refused where somebody
             * typed it rather than found later by a chart that will not load. */
            void window.midori.capital.credentials.save(creds)
                .then((result) => {
                    listAccounts(result.accounts);
                    // The secret is out of the form the moment it is safely stored; there is
                    // no reason for it to sit in a text box for the rest of the session.
                    brokerDraft.apiKey = '';
                    brokerDraft.password = '';
                    say(`Saved and connected · ${result.env === 'live' ? 'LIVE MONEY' : 'demo'}`);
                    refresh();
                })
                .catch((err: unknown) => say(err instanceof Error ? err.message : String(err), true))
                .finally(() => busy(false));
        };

        forget.onclick = () => {
            if (forget.dataset.armed !== '1') {
                forget.dataset.armed = '1';
                forget.textContent = 'Forget — click again';
                return;
            }
            void window.midori.capital.credentials.clear()
                .then(() => { say('Forgotten.'); refresh(); })
                .catch((err: unknown) => say(err instanceof Error ? err.message : String(err), true));
        };
        forget.onmouseleave = () => {
            forget.dataset.armed = '0';
            forget.textContent = 'Forget';
        };

        const rows: HTMLElement[] = [
            fieldSection('Capital.com'),
            note('Create the key under Settings → API integrations on the Capital.com platform; '
                + 'two-factor authentication has to be on before it will issue one. The password '
                + 'below is the “Custom password” set for that key — not your account login '
                + 'password, which does not work here and should not be put here.'),
            field('API key', 'apiKey', 'the key from API integrations', true),
            field('Login email', 'identifier', 'you@example.com'),
            field('Key password', 'password', 'the custom password set for the key', true),
            selectRow('Account', [
                { value: 'demo', label: 'Demo — real prices, money that is not real' },
                { value: 'live', label: 'Live — real money' },
            ], brokerDraft.env, (v) => { brokerDraft.env = v === 'live' ? 'live' : 'demo'; }, FIELD_WIDTH),
        ];
        if (broker && !broker.encryptionAvailable) {
            const warn = doc.createElement('p');
            warn.className = 'midorii-settings-warn';
            warn.textContent = 'This machine has no OS keychain available, so Midorii will refuse to '
                + 'write the secret to disk rather than store it in plain text. Use a .env.local file instead.';
            rows.push(warn);
        }

        const panel = card(...rows);
        const actions = doc.createElement('div');
        actions.className = 'midorii-settings-actions';
        actions.append(save, test, status);
        if (broker?.configured) {
            const end = doc.createElement('div');
            end.className = 'midorii-settings-actions-end';
            end.append(forget);
            actions.appendChild(end);
        }
        panel.append(actions, accounts);
        inner.append(panel);
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

        /* ── what a fresh ticket arrives with ─────────────────────────────
         *
         * Two distances and the unit they are read in. Ticks are the instrument's own
         * increment — the unit a stop is actually thought in, and the one that means the
         * same thing on an index quoted in thousands as on a pair quoted in pennies. The
         * cash alternative is a distance in the quote currency, NOT a sum the trade may
         * lose: what it loses is that distance times the size, and the size is decided by
         * the risk settings above. The note says so, because the two readings are one word
         * apart and only one of them is true. */
        const bracketUnitLabel = (): string => (edit.bracketUnit === 'cash' ? 'price' : 'ticks');
        const bracketStop = numberRow(`Stop distance (${bracketUnitLabel()})`, {
            value: edit.bracketStop,
            min: 0,
            max: 1e9,
            step: 1,
            onChange: (v) => { edit.bracketStop = v; },
        });
        const bracketTarget = numberRow(`Target distance (${bracketUnitLabel()})`, {
            value: edit.bracketTarget,
            min: 0,
            max: 1e9,
            step: 1,
            onChange: (v) => { edit.bracketTarget = v; },
        });

        inner.append(card(
            fieldSection('Automatic brackets'),
            note('A stop and a target already on the ticket when it opens, measured from '
                + 'wherever the trade would go in. They follow the market until you type over '
                + 'one — after that the level is yours and nothing moves it. In ticks they are '
                + 'counted in the instrument’s own increment; in price they are a distance in '
                + 'what the market is quoted in, not a sum of money the trade may lose. What '
                + 'it loses is that distance times the size.'),
            boolRow('A fresh ticket arrives bracketed', edit.autoBrackets, (v) => { edit.autoBrackets = v; }),
            selectRow(
                'Distances are read in',
                [
                    { value: 'ticks', label: 'ticks' },
                    { value: 'cash', label: 'price' },
                ],
                edit.bracketUnit,
                (v) => {
                    edit.bracketUnit = v === 'cash' ? 'cash' : 'ticks';
                    // The two rows below are labelled with the unit, so they have to be redrawn.
                    paint();
                },
                132,
            ),
            bracketStop,
            bracketTarget,
        ));

        inner.append(card(
            fieldSection('Quick sizes'),
            note('The sizes the ticket offers as one press, smallest first. The smallest is '
                + 'also the step its − and + walk in, so a list of 1, 3, 5 steps in whole '
                + 'contracts and a list of 0.01, 0.05, 0.1 steps in hundredths. The ticket can '
                + 'edit this row itself — this is the same list, not a second one.'),
            fieldRow({
                label: 'Sizes offered on the ticket',
                control: buildFieldControl({
                    kind: 'text',
                    value: edit.quickSizes.join(', '),
                    fill: true,
                    placeholder: '1, 3, 5, 10, 15',
                    /* A list that says nothing usable leaves the sizes as they were: emptying
                     * the row is not something anybody means by mistyping it. */
                    onChange: (v) => {
                        const next = normalizeQuickSizes(v.split(','));
                        if (next != null) edit.quickSizes = next;
                    },
                }).el,
            }),
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
        else if (active === 'brokers') paintBrokers();
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
        alertDisplay = loadAlertDisplay();
        quoteDisplay = loadQuoteDisplay();
        overlayDisplay = loadOverlayDisplay();
        /* What is stored for the broker, asked fresh: it can be changed from here and read
         * back by the same page, and the answer comes from the main process rather than from
         * anything this page could hold. Repaints when it lands — the pane is drawn from
         * whatever is known at the time, and this is usually a few milliseconds later. */
        void window.midori.capital.credentials.status()
            .then((next) => {
                broker = next;
                if (active === 'brokers') paint();
            })
            .catch((err: unknown) => console.error('[midorii] could not read the broker credential status', err));
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
