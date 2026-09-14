import { formatMoney, formatPercent } from '../format';
import { propGuard, type PropGuard } from './accountRules';
import { openPropRules } from './propRulesDialog';
import { limitRefusal, type Exposure, type PropStanding, type RiskLimits } from './riskLimits';
import type { BandAction, BandColumn } from './accountBand';
import type { HistoryRow } from '../replay/tradeBook';

/**
 * One account's limits, wired to the screen it is traded on.
 *
 * Everything a venue has to do with the rule set is here rather than three times over in the
 * mounts: read the standing once per repaint, put the three figures on the band, offer the
 * door to the settings, refuse an order that would break a limit, and — where the account
 * asked for it by name — close what is open when a limit is past.
 *
 * Written once for the same reason the band itself was (see accountBand.ts): three copies of
 * "how much room is left before the floor" is three chances for two screens to disagree about
 * an account, and the disagreement would show up as a figure somebody trusted.
 *
 * The reading is taken ONCE per repaint
 * -------------------------------------
 * `read` walks the closed trades; the columns, the refusal and the enforcement all want the
 * same answer, and computing it per figure would both cost three walks and let the floor on
 * the band differ from the floor an order was refused by. So the mount calls `read` at the top
 * of its repaint and everything else reads `last`.
 */

export interface PropWiring {
    /** Recompute from the account as it stands, advancing and storing the trailing mark. */
    read(): PropStanding;
    /** The most recent reading. What the band's figures and the enforcement both use. */
    last(): PropStanding;
    limits(): RiskLimits;
    /** Throws with the reason where this order may not go out. The mounts' one choke point. */
    guard(exposure: Exposure): void;
    /** The floor, the day and the goal, for the band. */
    columns: readonly BandColumn[];
    /** The door to this account's settings. */
    action: BandAction;
    /**
     * Act on the reading, where the account asked for more than a refusal.
     *
     * Called after the band has repainted, so whatever is about to be closed was on screen
     * first. Fires once per breach: it latches until the account is back inside its limits,
     * because a market order re-sent every time the price ticks is not a guard.
     */
    enforce(): void;
}

export interface PropWiringOptions {
    /** The account's key, spelled as the trade menu spells it: `projectx:1234`, `capital:live`. */
    account: string;
    /** What the account is called, for the dialog's heading. */
    name: string;
    /** Where the dialog mounts. */
    host: HTMLElement;
    /**
     * The account's money, for the labels — read fresh, never captured.
     *
     * A CFD account does not say what it is held in until the venue's first answer, and a
     * label fixed at mount would go without it for the rest of the session. The band's own
     * equity column takes it the same way, for the same reason: "1,500.00" is a figure and
     * not yet an amount.
     */
    currency?: () => string | null;
    /** What the account is worth, open trade included. */
    equity(): number;
    /** What the open position is worth right now. Zero when flat. */
    openPnl(): number;
    /** Closed trades, newest first. */
    history(): readonly HistoryRow[];
    /** Close everything at market. Called only where `onBreach` is `flatten`. */
    flatten(): void;
    notify(message: string, kind: 'info' | 'error'): void;
    /** Repaint — the settings changed under the band. */
    onChange(): void;
}

/**
 * Close every position and cancel everything working, and say what refused.
 *
 * Every position is attempted even after one has refused: stopping at the first would leave
 * the rest open on an account that has just been told to go flat, which is the opposite of
 * what was asked for. What refused is raised afterwards, together, because the one thing
 * somebody must know is that they still have to go and look at the venue.
 */
export function flattenAll(account: {
    positions(): readonly { id: number }[];
    closeOne(positionId: number): void;
    cancelAll?(): void;
}): void {
    const refused: string[] = [];
    const say = (err: unknown): string => (err instanceof Error ? err.message : String(err));

    for (const position of account.positions()) {
        try {
            account.closeOne(position.id);
        } catch (err: unknown) {
            refused.push(say(err));
        }
    }
    try {
        account.cancelAll?.();
    } catch (err: unknown) {
        refused.push(say(err));
    }
    if (refused.length > 0) throw new Error(refused.join('; '));
}

export function wireProp(opts: PropWiringOptions): PropWiring {
    const guard: PropGuard = propGuard(opts.account);
    const money = (n: number): string => formatMoney(n);

    let standing = guard.read({ equity: opts.equity(), openPnl: opts.openPnl(), history: opts.history() });
    /** Whether the breach on the table has already been acted on — see {@link PropWiring.enforce}. */
    let acted = false;

    const read = (): PropStanding => {
        standing = guard.read({ equity: opts.equity(), openPnl: opts.openPnl(), history: opts.history() });
        return standing;
    };

    const named = (what: string) => (): string => {
        const ccy = opts.currency?.() ?? null;
        return ccy ? `${what} ${ccy}` : what;
    };

    const columns: BandColumn[] = [
        {
            id: 'mll-room',
            label: named('To MLL'),
            title: 'What the account may still lose before it reaches its maximum loss limit — the '
                + 'floor, which ends the account rather than the day. Counts the open position. '
                + 'A dash means no floor is set for this account.',
            value: () => (standing.room == null ? '—' : money(standing.room)),
            /* Down the whole time it is gone, not only at the moment it goes: this is the figure
             * somebody looks at to decide whether to take one more trade. */
            tone: () => (standing.room == null ? null : standing.room <= 0 ? 'down' : null),
        },
        {
            id: 'dll-room',
            label: named('To DLL'),
            title: 'What the account may still lose in this session before its daily limit. Counts '
                + 'the open position, the way a firm counts it. A dash means no daily limit is set.',
            value: () => (standing.dayRoom == null ? '—' : money(standing.dayRoom)),
            tone: () => (standing.dayRoom == null ? null : standing.dayRoom <= 0 ? 'down' : null),
        },
        {
            id: 'goal',
            label: 'Goal',
            title: 'How far along the profit goal the account is, measured from the starting balance '
                + 'with the open position counted. A dash means no goal is set.',
            value: () => {
                if (standing.goalProgress == null) return '—';
                return formatPercent(standing.goalProgress, 0);
            },
            tone: () => (standing.goalProgress != null && standing.goalProgress >= 1 ? 'up' : null),
        },
    ];

    const action: BandAction = {
        id: 'limits',
        label: 'Limits',
        title: () => {
            const limits = guard.limits();
            if (limits.maxLoss > 0 || limits.dailyLoss > 0 || limits.profitGoal > 0) {
                return `The floor under ${opts.name}, its daily limit and its goal.`;
            }
            return `No limits set for ${opts.name}. Nothing is refused until they are.`;
        },
        run: () => {
            void openPropRules(opts.host, {
                account: opts.name,
                rules: guard.rules(),
                currency: opts.currency?.() ?? null,
                equity: opts.equity(),
            }).then((next) => {
                if (!next) return;
                guard.set(next);
                /* The latch belongs to the limits that set it. New numbers are a new question,
                 * and one that was already answered must not keep a fresh breach quiet. */
                acted = false;
                read();
                opts.onChange();
            }).catch((err: unknown) => {
                console.error('[midorii] the account limits dialog failed', err);
            });
        },
    };

    return {
        read,
        last: () => standing,
        limits: () => guard.limits(),
        guard: (exposure) => {
            const refusal = limitRefusal(guard.limits(), read(), exposure);
            if (refusal) throw new Error(refusal);
        },
        columns,
        action,
        enforce: () => {
            if (standing.breached == null) {
                acted = false;
                return;
            }
            if (guard.limits().onBreach !== 'flatten' || acted) return;
            acted = true;
            const what = standing.breached === 'mll' ? 'maximum loss limit' : 'loss limit for this session';
            opts.notify(
                `The ${what} is past — closing everything, which is what this account is set to do. `
                + 'Check the venue itself before trading again.',
                'error',
            );
            try {
                opts.flatten();
            } catch (err: unknown) {
                /* Said out loud rather than swallowed: an account that was told to flatten and
                 * could not is the one case where somebody must go and look at the venue. */
                opts.notify(
                    `Could not close out on the breach: ${err instanceof Error ? err.message : String(err)}. `
                    + 'Close the position at the venue.',
                    'error',
                );
            }
        },
    };
}
