import { DEFAULT_COSTS } from '../../../shared/engine/broker.js';
import type { Costs, PositionMode } from '../../../shared/engine/broker.js';
import { normalizeQuickSizes } from '../replay/orderTicket';
import type { BracketSettings, TicketSizing } from '../replay/orderTicket';
import type { RiskSettings } from '../replay/replayOrders';

/**
 * What a paper account is, before it has traded anything.
 *
 * Two kinds of setting live here and they behave differently, which is the only
 * thing worth knowing about this file. The account's SHAPE — what it starts with,
 * what it is charged, whether a second entry stands beside the first — is fixed
 * when the account is created: changing it means a different account, so changing
 * it starts one. How a trade is SIZED is not part of the account at all; it is how
 * it is being traded today, and it changes under a running one.
 *
 * Percentages are stored the way the Broker reads them — as fractions. The dialog
 * is the only place they are ever a "%" figure, because that is the only place a
 * person types one.
 */

export interface PaperSettings {
    /** Starting cash, in whatever the market quotes in. */
    balance: number;
    /** Commission per side, as a fraction of notional (0.001 = 0.1%). */
    feeRate: number;
    /** Full bid/ask spread as a fraction of price; half is paid on each side. */
    spreadPct: number;
    /** Extra adverse move on market and triggered stop orders. */
    slippagePct: number;
    /**
     * Whether a second entry opens a second position instead of averaging into the
     * first. Hedging is what a person means by a second idea; netting is what an
     * exchange account does.
     */
    hedging: boolean;
    /** The most notional a position may carry, as a multiple of equity. */
    maxLeverage: number;
    /**
     * Which of the ticket's two ways of saying how big a trade is is on the panel.
     *
     * Not asked for anywhere — it is set by using the panel, and stored so that using it
     * once is enough. Somebody who trades in units types a number of units on every ticket,
     * and a ticket that came back asking about risk after every restart would be a setting
     * they had to keep making by hand.
     */
    sizingMode: TicketSizing;
    /** How the risk per trade is expressed. */
    riskMode: RiskSettings['mode'];
    /** How much one trade may lose — percent of equity, or cash, per `riskMode`. */
    riskValue: number;
    /**
     * The sizes offered as one press on the ticket, smallest first.
     *
     * A list rather than a step, because the sizes a person actually trades are not evenly
     * spaced — one, then three, then five is how position size is thought about, and
     * arriving at five by pressing "+" four times is four chances to arrive at four.
     */
    quickSizes: number[];
    /** Whether a fresh ticket arrives with a stop and a target already on it. */
    autoBrackets: boolean;
    /** How the two distances below are read — see {@link BracketSettings}. */
    bracketUnit: BracketSettings['unit'];
    /** How far the automatic stop sits from the entry, in `bracketUnit`. */
    bracketStop: number;
    /** How far the automatic target sits from the entry, in `bracketUnit`. */
    bracketTarget: number;
}

export const DEFAULT_PAPER_SETTINGS: PaperSettings = {
    balance: 10_000,
    feeRate: DEFAULT_COSTS.feeRate,
    spreadPct: DEFAULT_COSTS.spreadPct,
    slippagePct: DEFAULT_COSTS.slippagePct,
    hedging: true,
    maxLeverage: 1,
    sizingMode: 'fixed',
    riskMode: 'percent',
    riskValue: 1,
    quickSizes: [1, 3, 5, 10, 15],
    autoBrackets: false,
    bracketUnit: 'ticks',
    bracketStop: 40,
    bracketTarget: 80,
};

const STORAGE_KEY = 'midorii-paper-settings';

/** The Broker's half of the settings — what an account is charged. */
export function costsOf(settings: PaperSettings): Required<Costs> {
    return {
        feeRate: settings.feeRate,
        spreadPct: settings.spreadPct,
        slippagePct: settings.slippagePct,
    };
}

export function positionModeOf(settings: PaperSettings): PositionMode {
    return settings.hedging ? 'hedging' : 'netting';
}

/** The ticket's half — how a trade is sized. Read fresh whenever one is placed. */
export function riskOf(settings: PaperSettings): RiskSettings {
    return { mode: settings.riskMode, value: settings.riskValue, maxLeverage: settings.maxLeverage };
}

/** Where a fresh ticket's stop and target start. Read fresh, for the same reason. */
export function bracketsOf(settings: PaperSettings): BracketSettings {
    return {
        on: settings.autoBrackets,
        unit: settings.bracketUnit,
        stop: settings.bracketStop,
        target: settings.bracketTarget,
    };
}

/**
 * Whether moving from `a` to `b` means a different ACCOUNT rather than a different
 * way of trading the same one.
 *
 * The starting cash and the costs are baked into a Broker when it is built and are
 * not changeable afterwards — an account charged 0.1% for a month cannot be
 * retroactively charged 0.02%, and pretending otherwise would rewrite trades that
 * have already happened. So these are the settings that start a fresh account, and
 * the dialog says so before it does it.
 */
export function needsFreshAccount(a: PaperSettings, b: PaperSettings): boolean {
    return a.balance !== b.balance
        || a.feeRate !== b.feeRate
        || a.spreadPct !== b.spreadPct
        || a.slippagePct !== b.slippagePct
        || a.hedging !== b.hedging;
}

/**
 * Fill in whatever a stored record is missing, and refuse whatever it cannot mean.
 *
 * Storage is data from outside the program: a hand-edited entry, a record written by
 * an older version, a half-written one. A balance of zero or a negative commission
 * would be taken by the Broker as an error at the worst possible moment — the first
 * click — so it is answered here, where the fallback is simply the default.
 */
export function normalizeSettings(raw: unknown): PaperSettings {
    const source = (raw ?? {}) as Partial<Record<keyof PaperSettings, unknown>>;
    const number = (value: unknown, fallback: number, min: number, max: number): number => {
        const n = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
    };
    const d = DEFAULT_PAPER_SETTINGS;

    return {
        balance: number(source.balance, d.balance, 1, 1e12),
        feeRate: number(source.feeRate, d.feeRate, 0, 1),
        spreadPct: number(source.spreadPct, d.spreadPct, 0, 1),
        slippagePct: number(source.slippagePct, d.slippagePct, 0, 1),
        hedging: typeof source.hedging === 'boolean' ? source.hedging : d.hedging,
        maxLeverage: number(source.maxLeverage, d.maxLeverage, 1, 100),
        sizingMode: source.sizingMode === 'risk' ? 'risk' : 'fixed',
        riskMode: source.riskMode === 'fixed' ? 'fixed' : 'percent',
        riskValue: number(source.riskValue, d.riskValue, 0.01, 1e6),
        quickSizes: quickSizes(source.quickSizes) ?? [...d.quickSizes],
        autoBrackets: typeof source.autoBrackets === 'boolean' ? source.autoBrackets : d.autoBrackets,
        bracketUnit: source.bracketUnit === 'cash' ? 'cash' : 'ticks',
        bracketStop: number(source.bracketStop, d.bracketStop, 0, 1e9),
        bracketTarget: number(source.bracketTarget, d.bracketTarget, 0, 1e9),
    };
}

/** A stored quick-size list, cleaned up — or null where there is nothing usable in it. */
function quickSizes(raw: unknown): number[] | null {
    return Array.isArray(raw) ? normalizeQuickSizes(raw) : null;
}

/** The settings this machine last saved, or the defaults. Never throws. */
export function loadPaperSettings(): PaperSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return normalizeSettings(raw == null ? null : JSON.parse(raw));
    } catch (err) {
        console.error('[midorii] could not read the paper-trading settings', err);
        return { ...DEFAULT_PAPER_SETTINGS };
    }
}

/** Store them. A storage failure is reported, never swallowed — and never fatal. */
export function savePaperSettings(settings: PaperSettings): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (err) {
        console.error('[midorii] could not persist the paper-trading settings', err);
    }
}
