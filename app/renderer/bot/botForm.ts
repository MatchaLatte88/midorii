import { Select, TextField, injectStyles } from '../../../src/ui';
import { RISK_PARAM_KEYS, STRATEGIES, resolveStrategyParams, strategyCatalog } from '../strategies';
import { LIVE_GUARD_PARAMS, resolveGuards } from '../strategies/liveGuards';
import { fieldGrid, fieldRow, paramField } from '../strategies/paramFields';
import type { StrategyParams } from '../strategies/types';
import { NumberInput } from '../../../src/ui';
import { button, sectionLabel } from '../runs/runViews';
import { VENUE_OPTIONS, type BotConfig, type BotVenue } from './botTypes';

/**
 * What a bot is set to, as a form.
 *
 * Four sections, in the order somebody actually decides them: what it trades, which
 * strategy and how that strategy is set, and — last, because it is the part a backtest
 * never had to answer — what it is allowed to do while nobody is watching.
 *
 * The strategy's own settings are the strategy's, copied
 * -----------------------------------------------------
 * A new bot starts from whatever the Strategies tab has that strategy set to, and then owns
 * its copy. That is deliberate in both directions: starting from the tuned settings is what
 * makes a bot one press away from a backtest that worked, and owning the copy is what stops
 * a change made on the Strategies tab from silently retuning a bot that is holding a
 * position. The form says so.
 */

const STYLE_ID = 'midorii-bot-form';
const CSS = `
.midorii-botform-card {
    padding: 12px 14px; margin-bottom: 16px;
    background: var(--vela-surface);
    border: 1px solid var(--vela-border-faint);
    border-radius: var(--vela-radius-sm);
}
.midorii-botform-sub { margin: 0 0 12px; color: var(--vela-fg-muted); font-size: 12.5px; line-height: 1.55; }
.midorii-botform-actions { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
.midorii-botform-status { color: var(--vela-fg-muted); font-size: 12px; }
.midorii-botform-status[data-error='1'] { color: var(--vela-danger); }
.midorii-botform-warn {
    margin: 0 0 12px; padding: 8px 10px;
    border-left: 2px solid var(--vela-warning, #d9822b);
    background: var(--vela-surface-overlay);
    color: var(--vela-fg); font-size: 12.5px; line-height: 1.55;
}
`;

/** The timeframes a bot may run on. A bot on a one-minute chart rebuilds its detectors
 *  sixty times an hour, which is fine; anything finer is a tick strategy this app has no
 *  data shape for, so it is simply not offered. */
const TIMEFRAME_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
    { value: '1', label: '1 minute' },
    { value: '2', label: '2 minutes' },
    { value: '3', label: '3 minutes' },
    { value: '5', label: '5 minutes' },
    { value: '15', label: '15 minutes' },
    { value: '30', label: '30 minutes' },
    { value: '60', label: '1 hour' },
    { value: '240', label: '4 hours' },
    { value: '480', label: '8 hours' },
    { value: '1D', label: '1 day' },
];

/** This form's own older wording for the daily bar, still carried by saved bots. The
 *  venues declare the canonical `D`, so the two have to be spoken to in one spelling. */
const canonicalTf = (value: string): string => (value === '1D' ? 'D' : value);

/** The provider segment of a market string (`capital:EURUSD` → `capital`), or null when
 *  it carries none — the same grammar the chart's symbol resolution reads. */
function venueOf(symbol: string): string | null {
    const colon = symbol.indexOf(':');
    return colon > 0 ? symbol.slice(0, colon).trim().toLowerCase() : null;
}

export interface BotFormOptions {
    /** The bot as it stands. Never mutated — the form works on its own copy. */
    bot: BotConfig;
    /** Whether the fields may be edited at all. A running bot's cannot. */
    readOnly: boolean;
    /** Whether a Capital.com account is configured on this machine, so the venue picker can
     *  say why it is not offering one. */
    capitalConfigured: boolean;
    /** Save the edited bot. Rejects with what went wrong. */
    onSave: (bot: BotConfig) => Promise<void>;
    /** Throw it away. */
    onDelete: () => void;
    /**
     * File this bot's account as a run and start it over on its opening balance.
     *
     * Separate from deleting the bot, and separate from editing it: an account that has been
     * trading for weeks is the only evidence of what the bot did, so starting over has to
     * mean filing it, not binning it. Refused while the bot is running.
     */
    onResetAccount: () => void;
    /** How many trades the stored account has, so the reset can say what it is filing. */
    accountTrades: number;
    /**
     * What a VENUE serves, by the name a market string prefixes itself with — the
     * providers' own `supportedTimeframes`, so the form narrows its timeframe field to
     * bars the typed market can actually be fed. A venue absent from the map is taken
     * to serve everything: the form is not the place to invent a restriction.
     */
    venueTimeframes: Readonly<Record<string, readonly string[]>>;
}

export interface BotForm {
    readonly el: HTMLElement;
    /** Repaint from the bot handed in, discarding unsaved edits. */
    reset(bot: BotConfig, readOnly: boolean, accountTrades: number, capitalConfigured: boolean): void;
}

/** Build the form into a fresh element. */
export function mountBotForm(doc: Document, opts: BotFormOptions): BotForm {
    injectStyles(STYLE_ID, CSS, doc);

    const root = doc.createElement('div');

    let bot = opts.bot;
    let readOnly = opts.readOnly;
    /** The edits, live. Reset whenever the form is pointed at a different bot. */
    let draft = draftOf(bot);
    let status: { text: string; error?: boolean } | null = null;
    let saving = false;
    let accountTrades = opts.accountTrades;
    let capitalConfigured = opts.capitalConfigured;
    let statusNode: HTMLElement | null = null;

    /** A scalar edit changes the draft, not the form's structure. Keep the controls mounted so
     *  the focused field and its selection survive each keystroke. */
    function markChanged(): void {
        status = null;
        if (!statusNode) return;
        statusNode.textContent = '';
        delete statusNode.dataset.error;
    }

    function draftOf(source: BotConfig): {
        name: string;
        strategy: string;
        symbol: string;
        timeframe: string;
        venue: BotVenue;
        balance: number;
        params: StrategyParams;
        guards: StrategyParams;
    } {
        return {
            name: source.name,
            strategy: source.strategy,
            symbol: source.symbol,
            timeframe: source.timeframe,
            venue: source.venue,
            balance: source.balance,
            params: safeParams(source.strategy, source.params),
            guards: safeGuards(source.guards),
        };
    }

    /** Stored settings resolved against the current schema, falling back to the defaults
     *  where they no longer fit — the same rule the Strategies tab follows, and the reason
     *  a renamed parameter is a default rather than an unreadable bot. */
    function safeParams(strategy: string, raw: Record<string, unknown>): StrategyParams {
        try {
            return resolveStrategyParams(strategy, raw);
        } catch {
            return resolveStrategyParams(strategy, {});
        }
    }

    function safeGuards(raw: Record<string, unknown>): StrategyParams {
        try {
            return resolveGuards(raw);
        } catch {
            return resolveGuards({});
        }
    }

    function card(title?: string): HTMLElement {
        const el = doc.createElement('div');
        el.className = 'midorii-botform-card';
        if (title) el.appendChild(sectionLabel(title));
        return el;
    }

    function note(text: string, className = 'midorii-botform-sub'): HTMLElement {
        const el = doc.createElement('p');
        el.className = className;
        el.textContent = text;
        return el;
    }

    /* ── the sections ────────────────────────────────────────────────────── */

    function marketCard(): HTMLElement {
        const el = card();
        el.appendChild(note(
            'What this bot trades, and where its orders go. A bot is bound to one market: it '
            + 'watches that market whatever the Chart tab happens to be showing, which is the '
            + 'whole point of it running unattended.',
        ));

        const grid = fieldGrid(doc);

        const name = new TextField({
            value: draft.name,
            fill: true,
            disabled: readOnly,
            onChange: (v) => { draft.name = v.trim() || 'Bot'; markChanged(); },
        });
        grid.appendChild(fieldRow(doc, 'Name', name.el, 'What you call it. Never used as a key.'));

        const symbol = new TextField({
            value: draft.symbol,
            fill: true,
            disabled: readOnly,
            // Repaint: the market decides which timeframes the field below may offer, and
            // a TextField commits on blur — the focus has already left, so nothing is lost.
            onChange: (v) => { draft.symbol = v.trim(); markChanged(); paint(); },
        });
        grid.appendChild(fieldRow(
            doc,
            'Market',
            symbol.el,
            'Written the way the chart writes it: provider, a colon, then the ticker — '
            + 'capital:EURUSD, binance:BTCUSDT. The provider has to have a live feed; the local '
            + 'archive can be backtested but not traded.',
        ));

        const timeframe = new Select({
            options: timeframeOptions(),
            value: draft.timeframe,
            disabled: readOnly,
            onChange: (v) => { draft.timeframe = v; markChanged(); },
        });
        grid.appendChild(fieldRow(
            doc,
            'Bars',
            timeframe.el,
            'The bars the strategy is fed. It sees each one when it closes and never while it '
            + 'is still forming — the same rule the backtest runs under.',
        ));

        const venue = new Select({
            options: VENUE_OPTIONS.map((v) => ({
                value: v.value,
                label: v.value === 'capital' && !capitalConfigured ? `${v.label} (no credentials)` : v.label,
            })),
            value: draft.venue,
            disabled: readOnly,
            onChange: (v) => {
                draft.venue = v === 'capital' ? 'capital' : 'paper';
                markChanged();
                paint();
            },
        });
        grid.appendChild(fieldRow(
            doc,
            'Account',
            venue.el,
            'Paper is this app’s own engine at real prices — nothing reaches a venue. '
            + 'Capital.com sends real orders to whichever account the stored credentials point at.',
        ));

        if (draft.venue === 'paper') {
            const balance = new NumberInput({
                value: draft.balance,
                min: 1,
                max: 1e9,
                step: 1000,
                fill: false,
                disabled: readOnly,
                onChange: (v) => { draft.balance = v; markChanged(); },
            });
            grid.appendChild(fieldRow(
                doc,
                'Starting cash',
                balance.el,
                'What this bot’s own paper account opens with. Its own — a bot does not share '
                + 'the Chart tab’s paper account, so hand-placed trades and automated ones are '
                + 'never mixed in one ledger.',
            ));
        }

        el.appendChild(grid);

        if (draft.venue === 'capital') {
            el.appendChild(note(
                capitalConfigured
                    ? 'This bot sends real orders. It is never resumed by itself when the app '
                      + 'starts — a real account is armed by a person, every time.'
                    : 'There are no Capital.com credentials on this machine, so this bot cannot '
                      + 'start. Add them under Settings.',
                'midorii-botform-warn',
            ));
        }
        return el;
    }

    function strategyCard(): HTMLElement {
        const el = card();
        const catalog = strategyCatalog();
        const spec = STRATEGIES[draft.strategy];

        el.appendChild(note(
            'The strategy is the same object the Backtest tab runs, unchanged. That is what '
            + 'makes a bot worth having: what it does live is what was tested, rule for rule.',
        ));

        const grid = fieldGrid(doc);
        const picker = new Select({
            options: catalog.map((s) => ({ value: s.id, label: s.name })),
            value: draft.strategy,
            disabled: readOnly,
            onChange: (v) => {
                draft.strategy = v;
                // A different strategy has a different schema — its own settings, from the
                // Strategies tab where they were tuned.
                draft.params = safeParams(v, storedStrategySettings[v] ?? {});
                markChanged();
                paint();
            },
        });
        grid.appendChild(fieldRow(doc, 'Strategy', picker.el));
        el.appendChild(grid);

        if (!spec) {
            el.appendChild(note(`This build has no strategy called “${draft.strategy}”.`, 'midorii-botform-warn'));
            return el;
        }

        el.appendChild(note(spec.description));

        const risk = spec.params.filter((p) => RISK_PARAM_KEYS.includes(p.key));
        const own = spec.params.filter((p) => !RISK_PARAM_KEYS.includes(p.key));

        el.appendChild(sectionLabel('Risk and size'));
        const riskGrid = fieldGrid(doc);
        for (const param of risk) riskGrid.appendChild(readOnlyGuard(paramField(doc, param, draft.params, markChanged)));
        el.appendChild(riskGrid);

        if (own.length > 0) {
            el.appendChild(sectionLabel('What counts as a setup'));
            const ownGrid = fieldGrid(doc);
            for (const param of own) ownGrid.appendChild(readOnlyGuard(paramField(doc, param, draft.params, markChanged)));
            el.appendChild(ownGrid);
        }

        el.appendChild(note(
            'These started as whatever the Strategies tab had this strategy set to, and are now '
            + 'this bot’s own copy. Changing them there does not change them here — a bot holding '
            + 'a position must not be retuned underneath it.',
        ));
        return el;
    }

    function guardsCard(): HTMLElement {
        const el = card();
        el.appendChild(note(
            'What the bot may do while nobody is watching. None of these can open a trade; every '
            + 'one of them can refuse one. A strategy that is already holding a position is never '
            + 'blocked from managing it — a guard that could strand a live position would cost '
            + 'more than it saves.',
        ));

        el.appendChild(sectionLabel('When it may trade'));
        const whenGrid = fieldGrid(doc);
        for (const param of LIVE_GUARD_PARAMS.slice(0, 4)) {
            whenGrid.appendChild(readOnlyGuard(paramField(doc, param, draft.guards, markChanged)));
        }
        el.appendChild(whenGrid);

        el.appendChild(sectionLabel('How much it may do'));
        const muchGrid = fieldGrid(doc);
        for (const param of LIVE_GUARD_PARAMS.slice(4, 9)) {
            muchGrid.appendChild(readOnlyGuard(paramField(doc, param, draft.guards, markChanged)));
        }
        el.appendChild(muchGrid);

        el.appendChild(sectionLabel('What it refuses to trade through'));
        const condGrid = fieldGrid(doc);
        for (const param of LIVE_GUARD_PARAMS.slice(9)) {
            condGrid.appendChild(readOnlyGuard(paramField(doc, param, draft.guards, markChanged)));
        }
        el.appendChild(condGrid);
        return el;
    }

    /** Disable every control inside a row when the bot is running. Done here rather than by
     *  passing `disabled` into each control, because the shared field factory builds them
     *  from a schema that knows nothing about a bot's state. */
    function readOnlyGuard(row: HTMLElement): HTMLElement {
        if (!readOnly) return row;
        for (const el of row.querySelectorAll('input, button, select, textarea')) {
            (el as HTMLInputElement).disabled = true;
        }
        row.style.opacity = '0.6';
        return row;
    }

    /* ── saving ──────────────────────────────────────────────────────────── */

    async function save(): Promise<void> {
        if (saving) return;
        saving = true;
        status = null;
        paint();
        try {
            await opts.onSave({
                ...bot,
                name: draft.name,
                strategy: draft.strategy,
                symbol: draft.symbol,
                timeframe: draft.timeframe,
                venue: draft.venue,
                balance: draft.balance,
                params: { ...draft.params },
                guards: { ...draft.guards },
            });
            status = { text: 'Saved.' };
        } catch (err) {
            status = { text: err instanceof Error ? err.message : String(err), error: true };
        }
        saving = false;
        paint();
    }

    /** What the Strategies tab has each strategy set to — the starting point for a bot's
     *  own copy when its strategy is changed. Read once; a form open across a change on
     *  that tab is a rarer thing than a round trip on every repaint. */
    let storedStrategySettings: Record<string, Record<string, unknown>> = {};
    void window.midori.strategies.load()
        .then((stored) => { storedStrategySettings = stored; })
        .catch((err: unknown) => console.error('[midorii] could not read the strategy settings for the bot form', err));

    /**
     * The timeframe options for the market currently typed into the form — the venue's
     * own declaration, not this list in full (Capital.com has no 8-hour bar to give).
     *
     * What the bot is SET to always stays in the list. A market can be retyped under a
     * saved bot, and a field that quietly renamed its own value would be lying about
     * what the bot runs on; the venue refusing the bars is the honest place to find out.
     */
    function timeframeOptions(): Array<{ value: string; label: string }> {
        const venue = venueOf(draft.symbol);
        const supported = venue === null ? undefined : opts.venueTimeframes[venue];
        if (!supported || supported.length === 0) return [...TIMEFRAME_OPTIONS];
        const offered = new Set(supported);
        const kept = TIMEFRAME_OPTIONS.filter((o) => offered.has(canonicalTf(o.value)));
        if (kept.length === 0) return [...TIMEFRAME_OPTIONS];
        const current = TIMEFRAME_OPTIONS.find((o) => o.value === draft.timeframe);
        return current && !kept.includes(current) ? [...kept, current] : [...kept];
    }

    /* ── drawing ─────────────────────────────────────────────────────────── */

    function paint(): void {
        root.replaceChildren();

        if (readOnly) {
            root.appendChild(note(
                'This bot is running. Its settings are what its open positions were sized under, '
                + 'so they cannot be changed until it is stopped.',
                'midorii-botform-warn',
            ));
        }

        root.append(marketCard(), strategyCard(), guardsCard());

        const actions = doc.createElement('div');
        actions.className = 'midorii-botform-actions';

        const saveButton = button(saving ? 'Saving…' : 'Save', 'primary');
        saveButton.disabled = readOnly || saving;
        saveButton.onclick = () => void save();

        const revert = button('Discard changes');
        revert.disabled = readOnly || saving;
        revert.onclick = () => { draft = draftOf(bot); status = null; paint(); };

        const reset = button('Start account over');
        reset.disabled = readOnly;
        reset.title = accountTrades > 0
            ? `Files this bot's ${accountTrades} ${accountTrades === 1 ? 'trade' : 'trades'} as a run, `
              + 'then starts it again on its opening balance.'
            : 'This bot has traded nothing yet, so there is nothing to file.';
        reset.onclick = () => opts.onResetAccount();

        const remove = button('Delete bot', 'danger');
        remove.disabled = readOnly;
        remove.title = 'Deletes the bot. Its account is filed as a run first — nothing it traded is lost.';
        remove.onclick = () => opts.onDelete();

        statusNode = doc.createElement('span');
        statusNode.className = 'midorii-botform-status';
        if (status) {
            statusNode.textContent = status.text;
            if (status.error) statusNode.dataset.error = '1';
        }

        actions.append(saveButton, revert, reset, remove, statusNode);
        root.appendChild(actions);
    }

    paint();

    return {
        el: root,
        reset(next, nextReadOnly, nextAccountTrades, nextCapitalConfigured): void {
            bot = next;
            readOnly = nextReadOnly;
            accountTrades = nextAccountTrades;
            capitalConfigured = nextCapitalConfigured;
            draft = draftOf(next);
            status = null;
            paint();
        },
    };
}
