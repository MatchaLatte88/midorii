import { Dialog, NumberInput, Select, Switch, injectStyles } from '../../../src/ui';
import { formatMoney } from '../format';
import { NO_RULES, markAfterChange, type AccountRules } from './accountRules';
import { mllFloor, type MllMode, type RiskLimits } from './riskLimits';
import { SETTINGS_CSS, SETTINGS_STYLE_ID, button, note, row, section } from './settingsChrome';

/**
 * One account's limits: the floor under it, what it may lose in a day, and what it is for.
 *
 * Per account and reached from that account's own band, because the numbers are the FIRM's and
 * not this app's — they are copied off a dashboard, and the account on screen is the only one
 * they are true of. A dialog reached from anywhere else would be a dialog you had to remember
 * which account you had opened.
 *
 * Nothing here is guessed. Every figure is typed in, including the starting balance, which is
 * the one number no venue can be asked for: a gateway states today's balance, and an account
 * that is up 2,400 says nothing about where it began. Enter nothing and nothing is enforced.
 *
 * The floor is shown as it is being set
 * ------------------------------------
 * Four settings decide where the floor sits — the starting balance, the amount, what it
 * follows and whether it freezes — and none of them reads as a price on its own. So the level
 * itself is printed under them and moves as they are typed: the figure that will refuse an
 * order is the figure on the screen where it was chosen.
 */

/** What the dialog is opened with, and what it hands back. */
export interface PropRulesDialogOptions {
    /** The account these belong to, as it is named on the band. */
    account: string;
    rules: AccountRules;
    /** The account's money, for the labels. Absent ⇒ no currency is claimed. */
    currency?: string | null;
    /** What the account is worth right now, so the floor can be read against something real. */
    equity?: number | null;
}

const MODES: ReadonlyArray<{ value: MllMode; label: string }> = [
    { value: 'static', label: 'stays where it is' },
    { value: 'eod', label: 'follows the best day’s close' },
    { value: 'intraday', label: 'follows the best equity' },
];

/**
 * Open one account's limits.
 *
 * Resolves with the rules to apply, or null when the dialog was dismissed — never rejects.
 * Editing is local until Save, which is what makes it safe to open mid-trade just to read the
 * floor off it.
 */
export async function openPropRules(
    host: HTMLElement,
    opts: PropRulesDialogOptions,
): Promise<AccountRules | null> {
    const doc = host.ownerDocument;
    injectStyles(SETTINGS_STYLE_ID, SETTINGS_CSS, doc);

    return new Promise<AccountRules | null>((resolve) => {
        const original = opts.rules.limits;
        const draft: RiskLimits = { ...original };
        let mark = opts.rules.highWater;

        let settled = false;
        const finish = (result: AccountRules | null): void => {
            if (settled) return;
            settled = true;
            dialog.hide();
            resolve(result);
        };

        const money = (n: number): string => (opts.currency ? `${formatMoney(n)} ${opts.currency}` : formatMoney(n));

        /* Where the floor is, in words, under the four settings that decide it. Also the one
         * place the app says what it cannot know: a mark is only as good as the days it saw. */
        const floorNote = doc.createElement('p');
        floorNote.className = 'midorii-paper-note';
        const markRow = doc.createElement('div');
        const freezeRow = doc.createElement('div');

        const paintFloor = (): void => {
            const floor = mllFloor(draft, mark);
            const trailing = draft.mllMode !== 'static';
            markRow.hidden = !trailing;
            freezeRow.hidden = !trailing;

            if (floor == null) {
                floorNote.textContent = draft.maxLoss > 0
                    ? 'No floor yet — a maximum loss needs a starting balance to be measured from.'
                    : 'No floor set. Enter what the account may lose in total and it appears here.';
                floorNote.classList.remove('warn');
                return;
            }
            const parts = [`The floor is at ${money(floor)}`];
            if (trailing) parts.push(`, ${money(mark)} being the best the account has done`);
            if (opts.equity != null && opts.equity > 0) {
                parts.push(`, which is ${money(opts.equity - floor)} below what it is worth now`);
            }
            floorNote.textContent = `${parts.join('')}.`;
        };

        const startBalance = new NumberInput({
            value: draft.startBalance, min: 0, max: 1e12, step: 1000, size: 'sm', fill: false,
            onChange: (v) => {
                const next = { ...draft, startBalance: v };
                mark = markAfterChange(draft, next, mark);
                draft.startBalance = v;
                markInput.setValue(mark);
                paintFloor();
            },
        });
        const maxLoss = new NumberInput({
            value: draft.maxLoss, min: 0, max: 1e12, step: 100, size: 'sm', fill: false,
            onChange: (v) => { draft.maxLoss = v; paintFloor(); },
        });
        const mllMode = new Select({
            options: [...MODES],
            value: draft.mllMode,
            size: 'sm',
            onChange: (v) => {
                const mode = MODES.find((m) => m.value === v)?.value ?? 'static';
                const next = { ...draft, mllMode: mode };
                mark = markAfterChange(draft, next, mark);
                draft.mllMode = mode;
                markInput.setValue(mark);
                paintFloor();
            },
        });
        const markInput = new NumberInput({
            value: mark, min: 0, max: 1e12, step: 100, size: 'sm', fill: false,
            onChange: (v) => { mark = v; paintFloor(); },
        });
        const freeze = new Switch({
            checked: draft.mllFreezeAtStart,
            onChange: (on) => { draft.mllFreezeAtStart = on; paintFloor(); },
        });

        const dailyLoss = new NumberInput({
            value: draft.dailyLoss, min: 0, max: 1e9, step: 50, size: 'sm', fill: false,
            onChange: (v) => { draft.dailyLoss = v; },
        });
        const profitGoal = new NumberInput({
            value: draft.profitGoal, min: 0, max: 1e12, step: 100, size: 'sm', fill: false,
            onChange: (v) => { draft.profitGoal = v; },
        });
        const maxSize = new NumberInput({
            value: draft.maxSize, min: 0, max: 1e9, step: 1, size: 'sm', fill: false,
            onChange: (v) => { draft.maxSize = v; },
        });
        const lossStreak = new NumberInput({
            value: draft.lossStreak, min: 0, max: 100, step: 1, size: 'sm', fill: false,
            onChange: (v) => { draft.lossStreak = v; },
        });

        /* The one setting here that makes the app SEND something. It says so on the row, in the
         * colour every other irreversible thing in this app is written in. */
        const breachWarn = doc.createElement('p');
        breachWarn.className = 'midorii-paper-warn';
        const paintBreach = (): void => {
            breachWarn.textContent = draft.onBreach === 'flatten'
                ? 'Midorii will close the open position at market and cancel the working orders, by '
                    + 'itself, the moment the floor or the daily limit is past. It is one market order '
                    + 'you did not press — and it goes out on a figure typed into this dialog, so a '
                    + 'mistyped limit closes a good trade.'
                : '';
        };
        const onBreach = new Select({
            options: [
                { value: 'refuse', label: 'refuse new entries' },
                { value: 'flatten', label: 'close everything at market' },
            ],
            value: draft.onBreach,
            size: 'sm',
            onChange: (v) => { draft.onBreach = v === 'flatten' ? 'flatten' : 'refuse'; paintBreach(); },
        });

        const save = button('Save', doc, true);
        save.onclick = () => finish({ limits: { ...draft }, highWater: mark });

        const dialog = new Dialog({
            title: 'Account limits',
            eyebrow: opts.account,
            host,
            draggable: true,
            align: 'center',
            closeOnInteractOutside: false,
            onOpenChange: (open) => { if (!open) finish(null); },
            content: (body) => {
                body.append(
                    section('What this account is', doc),
                    note(
                        'The balance the account began with, as your firm states it. The floor and the '
                        + 'goal are both measured from it, and it is the one figure no venue can be asked '
                        + 'for — a gateway states today’s balance and nothing about how it got there. '
                        + 'Leave it at zero and neither the floor nor the goal is enforced.',
                        doc,
                    ),
                    row('Starting balance', startBalance.el, doc),

                    section('Maximum loss limit', doc),
                    note(
                        'The MLL: the level that ends the account rather than the day. How it follows the '
                        + 'account up differs by firm — Topstep measures the best day’s CLOSE, firms in the '
                        + 'Apex mould measure the best equity the account ever showed, open trade included. '
                        + 'Freezing it at the starting balance is what a funded account in the Topstep mould '
                        + 'does: the floor climbs until it is level with what the account started at, then '
                        + 'stops. Zero is off.',
                        doc,
                    ),
                    row('Most the account may lose', maxLoss.el, doc),
                    row('The floor', mllMode.el, doc),
                    markRow,
                    freezeRow,
                    floorNote,
                    note(
                        'The mark is worked back out of the closed trades the venue serves, and it is kept '
                        + 'once found so a rolling history window cannot lower a floor that has already '
                        + 'risen. A day that closed higher than the venue still reports is invisible here — '
                        + 'then the mark is too low, the floor with it, and the warning comes late. That is '
                        + 'what the field is for: put the figure your firm shows into it.',
                        doc,
                    ),

                    section('Daily loss limit', doc),
                    note(
                        'The DLL. Counted from 17:00 New York to the next — the futures day, not the '
                        + 'calendar one — and it counts what is OPEN as well as what is closed, the way a '
                        + 'firm counts it. A limit measured on closed trades alone would be met only after '
                        + 'you had already taken the loss. Zero is off.',
                        doc,
                    ),
                    row('Most the account may lose in a session', dailyLoss.el, doc),

                    section('Profit goal', doc),
                    note(
                        'What the account is trying to make, measured from the starting balance, open trade '
                        + 'included. Shown on the band as progress. It refuses nothing: a goal is a '
                        + 'destination, and an account that reaches it and goes on trading has broken no '
                        + 'rule. Zero is off.',
                        doc,
                    ),
                    row('Profit goal', profitGoal.el, doc),

                    section('The rest of the session limits', doc),
                    note(
                        'Your own rules rather than the firm’s. Both are off at zero, and only orders that '
                        + 'would ADD to a position are ever refused — closing what is open always works, '
                        + 'whatever has been breached.',
                        doc,
                    ),
                    row('Most that may be held at once', maxSize.el, doc),
                    row('Stop after this many losses in a row', lossStreak.el, doc),

                    section('When a limit is past', doc),
                    row('Midorii should', onBreach.el, doc),
                    breachWarn,

                    section('What these are not', doc),
                    note(
                        'Midorii’s own guard, not your firm’s. It does not know their threshold, cannot see '
                        + 'trades you place on their platform, and measures the day on the boundary above '
                        + 'rather than on whatever they use. Treat a refusal here as a warning that arrived '
                        + 'early — never as proof the account is still within its rules.',
                        doc,
                    ),
                );
            },
            footer: (el) => {
                const clear = button('Turn everything off', doc);
                clear.dataset.tone = 'danger';
                clear.title = 'Every limit to zero. Nothing is refused and nothing is closed after this.';
                clear.onclick = () => finish({ ...NO_RULES });
                const spacer = doc.createElement('span');
                spacer.style.flex = '1 1 auto';
                const cancel = button('Cancel', doc);
                cancel.onclick = () => finish(null);
                el.append(clear, spacer, cancel, save);
            },
        });

        markRow.append(row('Best the account has done', markInput.el, doc));
        freezeRow.append(row('Stop trailing at the starting balance', freeze.el, doc));
        paintFloor();
        paintBreach();
        dialog.show();
    });
}
