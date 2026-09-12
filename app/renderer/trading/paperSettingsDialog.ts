import { Dialog, NumberInput, Select, Switch, TextField, injectStyles } from '../../../src/ui';
import { DEFAULT_PAPER_SETTINGS, needsFreshAccount, type PaperSettings } from './paperSettings';
import { normalizeQuickSizes } from '../replay/orderTicket';
import { TRADE_ACTIONS, formatHotkey, keyOf, loadHotkeys, saveHotkeys, type Hotkey } from './hotkeys';
import { chimeOn, setChime } from './fillChime';

/**
 * What a paper account is, before it has traded anything — and what it costs.
 *
 * The dialog is honest about the one thing that is easy to get wrong here: some of
 * these settings describe the account and some describe how it is being traded, and
 * only the first kind can force a fresh start. An account charged 0.1% for a month
 * cannot be retroactively charged 0.02% — the trades already happened at the old
 * price. So the fields that would rewrite history are grouped together, under a line
 * that says what saving them does, and the button says it again.
 *
 * Percentages are typed as percentages and stored as fractions. Nobody thinks in
 * 0.0002.
 */

const STYLE_ID = 'midorii-paper-settings';
const CSS = `
.midorii-paper-sect {
    margin: 18px 0 10px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--vela-fg-muted);
    opacity: 0.85;
}
.midorii-paper-sect:first-child { margin-top: 0; }
.midorii-paper-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 10px;
    font-size: var(--vela-font-size-md);
    color: var(--vela-fg);
}
.midorii-paper-row > span:first-child { white-space: nowrap; }
.midorii-paper-pair { display: flex; align-items: center; gap: 6px; }
.midorii-paper-note {
    margin: -2px 0 12px;
    font-size: 11px;
    line-height: 1.45;
    color: var(--vela-fg-muted);
}
.midorii-paper-warn {
    margin: 4px 0 0;
    font-size: 11px;
    line-height: 1.45;
    color: var(--vela-danger);
    min-height: 1.45em;
}
.midorii-paper-key {
    min-width: 10ch;
    font-family: var(--vela-font-mono);
    font-size: 11px;
}
.midorii-paper-key[data-listening='1'] {
    border-color: var(--vela-accent);
    color: var(--vela-accent);
}
/* Only the danger tone is this dialog's own — the plain and primary shapes are the kit's
   footer buttons, which every other dialog in the app now wears. */
.vela-dialog-btn[data-tone='danger'] { color: var(--vela-danger); }
.vela-dialog-btn[data-tone='danger']:hover {
    border-color: var(--vela-danger-line);
    background: var(--vela-danger-soft);
    color: var(--vela-danger);
}
`;

/** What the dialog resolves with — the settings to apply, or nothing at all. */
export interface PaperSettingsResult {
    settings: PaperSettings;
    /** The account has to start again for these to mean anything — see needsFreshAccount. */
    resetsAccount: boolean;
}

export interface PaperSettingsDialogOptions {
    settings: PaperSettings;
    /** How much history the running account has, so the warning can be specific. Zero
     *  (or nothing at all) means a reset costs nobody anything and is not announced. */
    trades?: number;
    /** Offered as its own button — starting over on purpose, rather than as a side
     *  effect of a changed number. Absent ⇒ no such button. */
    onResetAccount?: () => void;
}

function row(label: string, control: HTMLElement, doc: Document): HTMLElement {
    const el = doc.createElement('label');
    el.className = 'midorii-paper-row';
    const text = doc.createElement('span');
    text.textContent = label;
    el.append(text, control);
    return el;
}

function note(text: string, doc: Document): HTMLElement {
    const el = doc.createElement('p');
    el.className = 'midorii-paper-note';
    el.textContent = text;
    return el;
}

function section(text: string, doc: Document): HTMLElement {
    const el = doc.createElement('div');
    el.className = 'midorii-paper-sect';
    el.textContent = text;
    return el;
}

/**
 * One rebindable key: what it does, and a button that listens for the next press.
 *
 * Captured from a real key event rather than typed, because what has to be stored is the
 * event — which key, with which modifiers — and asking somebody to spell that out is asking
 * them to get it wrong. Escape clears the binding; clicking away leaves it as it was.
 */
function hotkeyRow(
    label: string,
    hint: string,
    current: () => Hotkey | null,
    onBind: (next: Hotkey | null) => void,
    doc: Document,
): HTMLElement {
    const capture = doc.createElement('button');
    capture.type = 'button';
    capture.className = 'vela-dialog-btn midorii-paper-key';
    capture.title = `${hint} Press to rebind; Escape clears it.`;

    let listening = false;
    const paint = (): void => {
        capture.textContent = listening ? 'Press a key…' : formatHotkey(current());
        capture.dataset.listening = listening ? '1' : '0';
    };

    const onKey = (event: KeyboardEvent): void => {
        if (!listening) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') {
            stop();
            onBind(null);
            paint();
            return;
        }
        const pressed = keyOf(event);
        if (!pressed) return;   // a modifier on its own is not a binding
        stop();
        onBind(pressed);
        paint();
    };
    const onBlur = (): void => { stop(); paint(); };
    function stop(): void {
        listening = false;
        doc.removeEventListener('keydown', onKey, true);
        capture.removeEventListener('blur', onBlur);
    }

    capture.onclick = () => {
        if (listening) { stop(); paint(); return; }
        listening = true;
        paint();
        doc.addEventListener('keydown', onKey, true);
        capture.addEventListener('blur', onBlur);
    };
    paint();
    return row(label, capture, doc);
}

function button(text: string, doc: Document, primary = false): HTMLButtonElement {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = primary ? 'vela-dialog-btn vela-dialog-btn-primary' : 'vela-dialog-btn';
    b.textContent = text;
    return b;
}

/** A percentage field over a fraction: typed as 0.1, stored as 0.001. */
function percentField(value: number, step: number, onChange: (fraction: number) => void): NumberInput {
    return new NumberInput({
        value: Number((value * 100).toFixed(4)),
        min: 0,
        max: 100,
        step,
        size: 'sm',
        fill: false,
        onChange: (v) => onChange(v / 100),
    });
}

/**
 * Open the paper-trading settings.
 *
 * Resolves with the settings to apply, or null when the dialog was dismissed —
 * never rejects. Editing is local until Save: closing it changes nothing, which is
 * what makes it safe to open one mid-trade just to read the numbers off it.
 */
export async function openPaperSettings(
    host: HTMLElement,
    opts: PaperSettingsDialogOptions,
): Promise<PaperSettingsResult | null> {
    const doc = host.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);

    return new Promise<PaperSettingsResult | null>((resolve) => {
        const original = opts.settings;
        const draft: PaperSettings = { ...original };
        const trades = opts.trades ?? 0;

        let settled = false;
        const finish = (result: PaperSettingsResult | null): void => {
            if (settled) return;
            settled = true;
            dialog.hide();
            resolve(result);
        };

        const warn = doc.createElement('p');
        warn.className = 'midorii-paper-warn';
        const save = button('Save', doc, true);

        /** Saving these means a different account, and the button has to say so. */
        const syncSave = (): void => {
            const resets = needsFreshAccount(original, draft);
            save.textContent = resets ? 'Save and start a fresh account' : 'Save';
            warn.textContent = resets && trades > 0
                ? `The account has ${trades} ${trades === 1 ? 'trade' : 'trades'} on it. `
                    + 'They were taken at the old balance and costs, so they cannot be carried '
                    + 'over — saving files the account as a run and starts a fresh one.'
                : '';
        };

        const balance = new NumberInput({
            value: draft.balance, min: 1, max: 1e12, step: 1000, size: 'sm', fill: false,
            onChange: (v) => { draft.balance = v; syncSave(); },
        });
        const hedging = new Switch({
            checked: draft.hedging,
            onChange: (on) => { draft.hedging = on; syncSave(); },
        });
        const fee = percentField(draft.feeRate, 0.01, (v) => { draft.feeRate = v; syncSave(); });
        const spread = percentField(draft.spreadPct, 0.005, (v) => { draft.spreadPct = v; syncSave(); });
        const slippage = percentField(draft.slippagePct, 0.005, (v) => { draft.slippagePct = v; syncSave(); });

        const leverage = new NumberInput({
            value: draft.maxLeverage, min: 1, max: 100, step: 0.5, size: 'sm', fill: false,
            onChange: (v) => { draft.maxLeverage = v; },
        });
        const riskValue = new NumberInput({
            value: draft.riskValue, min: 0.01, max: 1e6, step: 0.25, size: 'sm', fill: false,
            onChange: (v) => { draft.riskValue = v; },
        });
        const riskMode = new Select({
            options: [
                { value: 'percent', label: '% of equity' },
                { value: 'fixed', label: 'cash' },
            ],
            value: draft.riskMode,
            size: 'sm',
            onChange: (v) => { draft.riskMode = v === 'fixed' ? 'fixed' : 'percent'; },
        });

        const risk = doc.createElement('span');
        risk.className = 'midorii-paper-pair';
        risk.append(riskValue.el, riskMode.el);

        /* ── what a fresh ticket arrives with ─────────────────────────────
         *
         * Two distances and the unit they are read in. `ticks` counts the instrument's own
         * increment; `price` is a distance in what the market is quoted in — NOT a sum the
         * trade may lose, which is that distance times a size the risk settings above decide.
         * The rows say which of the two is on, because the reading changes entirely with it
         * and a bare "40" says neither. */
        const autoBrackets = new Switch({
            checked: draft.autoBrackets,
            onChange: (on) => { draft.autoBrackets = on; },
        });
        const bracketStop = new NumberInput({
            value: draft.bracketStop, min: 0, max: 1e9, step: 1, size: 'sm', fill: false,
            onChange: (v) => { draft.bracketStop = v; },
        });
        const bracketTarget = new NumberInput({
            value: draft.bracketTarget, min: 0, max: 1e9, step: 1, size: 'sm', fill: false,
            onChange: (v) => { draft.bracketTarget = v; },
        });
        const bracketUnit = new Select({
            options: [
                { value: 'ticks', label: 'ticks' },
                { value: 'cash', label: 'price' },
            ],
            value: draft.bracketUnit,
            size: 'sm',
            onChange: (v) => {
                draft.bracketUnit = v === 'cash' ? 'cash' : 'ticks';
                syncBracketUnit();
            },
        });
        /* Stored the moment one is rebound rather than on Save, because they are this
         * machine's and not the account's: nothing about a key can force a fresh account, and
         * a binding that vanished because somebody closed the dialog with Escape would be a
         * setting that silently did not take. */
        let hotkeys = loadHotkeys();

        /* Stored on the flip, like the keys and for the same reason: it describes this machine,
         * and a preference lost to an Escape is a preference somebody set twice. */
        const fillSound = new Switch({ checked: chimeOn(), onChange: (on) => setChime(on) });

        const dailyLoss = new NumberInput({
            value: draft.dailyLossLimit, min: 0, max: 1e9, step: 50, size: 'sm', fill: false,
            onChange: (v) => { draft.dailyLossLimit = v; },
        });
        const maxPosition = new NumberInput({
            value: draft.maxPositionSize, min: 0, max: 1e9, step: 1, size: 'sm', fill: false,
            onChange: (v) => { draft.maxPositionSize = v; },
        });
        const lossStreak = new NumberInput({
            value: draft.lossStreakLimit, min: 0, max: 100, step: 1, size: 'sm', fill: false,
            onChange: (v) => { draft.lossStreakLimit = v; },
        });

        const bracketStopRow = row('Stop distance', bracketStop.el, doc);
        const bracketTargetRow = row('Target distance', bracketTarget.el, doc);

        /** Say the unit on the rows it applies to, rather than only on the one that picks it. */
        function syncBracketUnit(): void {
            const unit = draft.bracketUnit === 'cash' ? 'price' : 'ticks';
            for (const [el, name] of [[bracketStopRow, 'Stop'], [bracketTargetRow, 'Target']] as const) {
                const text = el.querySelector('span');
                if (text) text.textContent = `${name} distance (${unit})`;
            }
        }

        /* ── the sizes the ticket offers as one press ─────────────────────
         *
         * The same list the ticket's own pencil edits — one setting, two doors. A list that
         * says nothing usable leaves the sizes as they were: emptying the row is not what
         * anybody means by mistyping it, and it is not something the ticket could undo. */
        const quickSizes = new TextField({
            value: draft.quickSizes.join(', '),
            size: 'sm',
            /* Filled inside a width of its own: unfilled, the kit's field is a column narrow
             * enough to ellipsise five sizes, and a list you cannot read to the end is one you
             * cannot edit. */
            fill: true,
            onChange: (v) => {
                const next = normalizeQuickSizes(v.split(','));
                if (next != null) draft.quickSizes = next;
                // Whatever survived the cleaning, shown as it will actually be used.
                quickSizes.setValue(draft.quickSizes.join(', '));
            },
        });
        /* The kit's own row wrapper, which is a flex box — a bare span is inline, and a width
         * on an inline element is not a width at all. */
        const quickSizesWrap = doc.createElement('span');
        quickSizesWrap.className = 'midorii-paper-pair';
        /* `flex: none` and not merely a width: the row is a flex box with a long label beside
         * it, and a plain width would be shrunk back to the column it was widened out of. */
        quickSizesWrap.style.flex = '0 0 160px';
        quickSizesWrap.appendChild(quickSizes.el);

        save.onclick = () => finish({ settings: { ...draft }, resetsAccount: needsFreshAccount(original, draft) });

        const dialog = new Dialog({
            title: 'Trading settings',
            eyebrow: 'Trading',
            host,
            draggable: true,
            align: 'center',
            closeOnInteractOutside: false,
            onOpenChange: (open) => { if (!open) finish(null); },
            content: (body) => {
                body.append(
                    section('The paper account', doc),
                    note(
                        'What the account starts with and what it is charged. These are fixed '
                        + 'when the account is created — changing one starts a new account.',
                        doc,
                    ),
                    row('Account size', balance.el, doc),
                    row('Commission per side (%)', fee.el, doc),
                    row('Spread (%)', spread.el, doc),
                    row('Slippage (%)', slippage.el, doc),
                    row('A second entry opens a second position', hedging.el, doc),
                    warn,

                    section('How a trade is sized', doc),
                    note(
                        'These change under a running account. The size follows from what a trade '
                        + 'may lose and how far away its stop is, so a wider stop buys a smaller '
                        + 'position rather than a bigger loss.',
                        doc,
                    ),
                    row('Leverage (max notional × equity)', leverage.el, doc),
                    row('Risk per trade', risk, doc),

                    section('Automatic brackets', doc),
                    note(
                        'A stop and a target already on the ticket when it opens, measured from '
                        + 'wherever the trade would go in. They follow the market until you type '
                        + 'over one. In ticks they are counted in the instrument’s own increment; '
                        + 'in price they are a distance in what the market is quoted in, not a sum '
                        + 'of money — what the trade loses is that distance times its size.',
                        doc,
                    ),
                    row('A fresh ticket arrives bracketed', autoBrackets.el, doc),
                    row('Distances are read in', bracketUnit.el, doc),
                    bracketStopRow,
                    bracketTargetRow,

                    section('Session limits', doc),
                    note(
                        'What stops a session rather than what sizes a trade. Zero is off, and all three '
                        + 'start off. A session runs from 17:00 New York to the next — the futures day, not '
                        + 'the calendar one — and only orders that would ADD to a position are refused: '
                        + 'closing what is open always works.',
                        doc,
                    ),
                    note(
                        'This is Midorii\'s own guard, not your firm\'s. It cannot see trades placed on '
                        + 'their platform and does not know their threshold, so treat a refusal here as a '
                        + 'warning that came early, never as proof the account is still within its rules.',
                        doc,
                    ),
                    row('Loss limit per session', dailyLoss.el, doc),
                    row('Most that may be held at once', maxPosition.el, doc),
                    row('Stop after this many losses in a row', lossStreak.el, doc),

                    section('Keys', doc),
                    note(
                        'Each of these is a button that is already on the trading chart — the key is the '
                        + 'same press without the reach. Buy and Sell send the ticket exactly as it stands, '
                        + 'so the size, the brackets and any refusal are the ones on screen. Nothing fires '
                        + 'while a field has focus.',
                        doc,
                    ),
                    ...TRADE_ACTIONS.map(({ id, label, hint }) => hotkeyRow(
                        label, hint,
                        () => hotkeys[id],
                        (next) => { hotkeys = { ...hotkeys, [id]: next }; saveHotkeys(hotkeys); },
                        doc,
                    )),

                    row('A fill makes a sound', fillSound.el, doc),

                    section('Quick sizes', doc),
                    note(
                        'The sizes the ticket offers as one press, smallest first. The smallest is '
                        + 'also the step its − and + walk in, so a list of 1, 3, 5 steps in whole '
                        + 'contracts and one of 0.01, 0.05, 0.1 steps in hundredths. The ticket’s '
                        + 'own pencil edits this same list.',
                        doc,
                    ),
                    row('Sizes offered', quickSizesWrap, doc),
                );
            },
            footer: (el) => {
                if (opts.onResetAccount) {
                    const reset = button('File and reset account', doc);
                    reset.dataset.tone = 'danger';
                    reset.title = 'File this account as a run and start a fresh one on the current settings. '
                        + 'Nothing is thrown away: the trades stay in the run library.';
                    reset.onclick = () => {
                        opts.onResetAccount?.();
                        finish(null);
                    };
                    el.append(reset);
                }
                const spacer = doc.createElement('span');
                spacer.style.flex = '1 1 auto';
                const defaults = button('Defaults', doc);
                defaults.onclick = () => {
                    Object.assign(draft, DEFAULT_PAPER_SETTINGS);
                    balance.setValue(draft.balance);
                    leverage.setValue(draft.maxLeverage);
                    riskValue.setValue(draft.riskValue);
                    riskMode.setValue(draft.riskMode);
                    hedging.setChecked(draft.hedging);
                    fee.setValue(Number((draft.feeRate * 100).toFixed(4)));
                    spread.setValue(Number((draft.spreadPct * 100).toFixed(4)));
                    slippage.setValue(Number((draft.slippagePct * 100).toFixed(4)));
                    /* Object.assign copies the default LIST by reference; a fresh array so
                     * editing the sizes afterwards cannot write into the defaults themselves. */
                    draft.quickSizes = [...DEFAULT_PAPER_SETTINGS.quickSizes];
                    autoBrackets.setChecked(draft.autoBrackets);
                    bracketUnit.setValue(draft.bracketUnit);
                    bracketStop.setValue(draft.bracketStop);
                    bracketTarget.setValue(draft.bracketTarget);
                    quickSizes.setValue(draft.quickSizes.join(', '));
                    syncBracketUnit();
                    syncSave();
                };
                const cancel = button('Cancel', doc);
                cancel.onclick = () => finish(null);
                el.append(spacer, defaults, cancel, save);
            },
        });

        syncBracketUnit();
        syncSave();
        dialog.show();
    });
}
