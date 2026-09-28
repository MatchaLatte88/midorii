import { positionSize } from '../../../shared/strategies/risk.js';
import type { OrderBracket, OrderSpec } from '../../../shared/engine/broker.js';
import { formatMoney } from '../format';
import { levelAllowed } from './replayLevels';
import type { RiskSettings } from './replayOrders';

/**
 * A typed order, before it is an order: what the panel is describing, what it would cost, and
 * why it cannot be sent yet.
 *
 * Kept apart from the sidebar that paints it for the same reason the book is kept apart from
 * the dock — every rule here is a rule about money, and a rule about money that can only be
 * exercised by clicking on a chart is a rule nobody checks.
 *
 * Two ways to say how big
 * -----------------------
 * A ticket starts on a typed size — a number of units, the thing a person placing an order by
 * hand already has in mind. The other way is to say where the trade is wrong and how much that
 * may cost, and let the size follow through the same `positionSize` a strategy uses; a trade
 * taken that way is the same size for the same stop as one a bot took, so the two are
 * comparable afterwards. Neither is the panel's opinion for long: which one was last used is
 * remembered by whoever mounts the panel and handed back on the next ticket.
 */

export type TicketOrderType = 'market' | 'limit' | 'stop';
export type TicketSizing = 'risk' | 'fixed';

/** What the panel currently says. Every field is exactly what is in the boxes. */
export interface TicketDraft {
    type: TicketOrderType;
    /** Where a resting order waits. Ignored by a market order, which fills at the market. */
    entryPrice: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    sizing: TicketSizing;
    /** Units, when the size is typed rather than derived. */
    fixedSize: number | null;
}

/** A ticket with nothing in it. */
export function emptyTicket(): TicketDraft {
    return { type: 'market', entryPrice: null, stopLoss: null, takeProfit: null, sizing: 'fixed', fixedSize: null };
}

/** The account, as far as a ticket needs to know it. */
export interface TicketAccount {
    equity: number;
    /** The last price on the chart — the only price a market order can be sized against. */
    price: number;
    /**
     * What is left to open something new with, and what share of a position's notional the
     * venue holds against it.
     *
     * Both absent on a paper account, which has no margin: there the ceiling is the leverage
     * setting, a number somebody typed. On a live account it is neither typed nor negotiable —
     * the venue decides it per instrument, and a size the account cannot fund is refused
     * however sound the risk behind it was.
     */
    available?: number;
    /** A fraction of notional: 0.0333 for a venue asking 3.33%. */
    marginFactor?: number;
    /**
     * The two sides of the market, where the venue quotes two.
     *
     * Display only — everything below is still measured from `price`, which is what the
     * engine fills against. Absent on the accounts whose feed is one-sided (the replay, the
     * crypto providers, the local archive), and then the panel shows the last price on both
     * sides rather than inventing a spread nobody quoted.
     */
    bid?: number;
    ask?: number;
    /**
     * What one point of price movement is worth, per unit, in the account's money.
     *
     * On a spot account this is 1 and always was: one unit of the instrument moving one point
     * moves the balance by one of whatever it is quoted in. A futures contract is the case it
     * exists for — one NQ moving four points is eighty dollars, not four — and without it every
     * figure below is out by that multiple, in the direction that sizes the trade too large.
     *
     * Absent means 1. Not because one is always right, but because it is what every account
     * here has been measured as until now, and a number invented for an instrument nobody has
     * asked about would be a confident wrong answer where there is currently an honest one.
     */
    pointValue?: number;
    /**
     * The grid sizes have to sit on, and the smallest the venue will deal.
     *
     * A size is worked out from risk and comes out a fraction; what is SENT is that fraction
     * on the venue's own grid. Absent where the panel has not been told, and then nothing is
     * snapped and the venue applies its own rules after the fact — which is what every account
     * did before these were carried, and is exactly the gap they close: the figure on the
     * ticket was not the figure the order went out with.
     */
    sizeStep?: number;
    minSize?: number;
}

/** One point in account money, per unit. See {@link TicketAccount.pointValue}. */
function pointValueOf(account: TicketAccount): number {
    const value = account.pointValue;
    return value != null && value > 0 ? value : 1;
}

/**
 * The largest size at or below `size` that the venue would accept, or null where none is.
 *
 * DOWN, never up. A size rounded up risks more than the number it was worked out from, and a
 * risk figure is the one thing on this panel that may not be wrong in that direction: a
 * ticket that says 40 dollars and sends 60 is worse than one that says it cannot be sent.
 */
function snapSize(size: number | null, account: TicketAccount): number | null {
    if (size == null) return null;
    const step = account.sizeStep;
    // Eight decimals clears the dust a divide-and-multiply leaves behind; the epsilon keeps a
    // size that IS on the grid from falling a step through a binary-float hair.
    const out = step != null && step > 0
        ? Number((Math.floor((size + step * 1e-9) / step) * step).toFixed(8))
        : size;
    if (!(out > 0)) return null;
    if (account.minSize != null && out < account.minSize) return null;
    return out;
}

/** The smallest trade this instrument accepts, where the panel has been told. */
function sizeFloor(account: TicketAccount): number | null {
    const floor = account.minSize ?? account.sizeStep;
    return floor != null && floor > 0 ? floor : null;
}

/**
 * Where a ticket's stop and target start out, before anyone drags them.
 *
 * A distance, not a level: the levels follow from wherever the trade would go in, so they
 * stay the same distance away as the market moves under an untouched ticket.
 */
export interface BracketSettings {
    /** Whether a fresh ticket arrives with levels on it at all. */
    on: boolean;
    /**
     * How the two distances below are read.
     *
     * `ticks` counts the instrument's own increment — the unit a futures or FX trader
     * actually thinks a stop in, and the one that means the same thing on an instrument
     * quoted in thousands as on one quoted in pennies. `cash` is a distance in the quote
     * currency: 20 means twenty of whatever the price is printed in, not a twenty-dollar
     * loss — what the loss comes to is the size times the distance, and the size is not
     * known until the distance is.
     */
    unit: 'ticks' | 'cash';
    stop: number;
    target: number;
}

/** How many quick sizes a ticket will offer. Past this the row is aimed at, not read. */
export const MAX_QUICK_SIZES = 8;

/**
 * A list of quick sizes, cleaned up — or null where there is nothing usable in it.
 *
 * Sorted and de-duplicated because the row is read left to right: two chips saying 5 is a
 * misprint, and 10 sitting before 3 is a row nobody can aim at. Nothing usable gives null
 * rather than an empty list, so a mistyped list leaves the sizes as they were instead of
 * leaving the ticket with no quick sizes and no way to get any back.
 *
 * Here rather than beside the settings that store it, because both the settings and the
 * panel need it and the panel must not import the settings — the settings already import
 * this file for {@link BracketSettings}.
 */
export function normalizeQuickSizes(raw: readonly unknown[]): number[] | null {
    const clean = [...new Set(raw
        .map((v) => (typeof v === 'number' ? v : Number(String(v).trim())))
        .filter((n) => Number.isFinite(n) && n > 0))]
        .sort((a, b) => a - b)
        .slice(0, MAX_QUICK_SIZES);
    return clean.length > 0 ? clean : null;
}

/**
 * The levels an auto-bracketed ticket opens with, or nulls where they cannot be worked out.
 *
 * `tick` is the instrument's own increment, and it is genuinely unknown for some markets —
 * a distance in ticks then has no length, and nothing is placed. A silent fallback of "1"
 * would put a stop four ticks from the entry on an instrument that moves in hundredths.
 */
export function bracketLevels(
    reference: number,
    side: 'buy' | 'sell',
    brackets: BracketSettings,
    tick: number | null,
): { stopLoss: number | null; takeProfit: number | null } {
    const none = { stopLoss: null, takeProfit: null };
    if (!brackets.on || !(reference > 0)) return none;

    const step = brackets.unit === 'ticks' ? (tick != null && tick > 0 ? tick : null) : 1;
    if (step == null) return none;

    const away = (distance: number): number | null => (distance > 0 ? distance * step : null);
    const stopAway = away(brackets.stop);
    const targetAway = away(brackets.target);

    // A stop below a long's entry and above a short's, and the target the other way — the
    // same rule levelAllowed holds a dragged level to, applied before anything is dragged.
    const sign = side === 'buy' ? 1 : -1;
    /* On the instrument's own grid where it is known. A cash distance lands between two
     * tradable levels more often than not, and a stop at 29603.7413 is one no venue would
     * take and nobody would have typed. */
    const level = (distance: number | null, direction: 1 | -1): number | null => {
        if (distance == null) return null;
        const price = reference + direction * sign * distance;
        if (!(price > 0)) return null;
        if (tick == null || !(tick > 0)) return price;
        return Number((Math.round(price / tick) * tick).toFixed(8));
    };

    // A level the rounding has walked onto the entry is no level at all.
    const stopLoss = level(stopAway, -1);
    const takeProfit = level(targetAway, 1);
    return {
        stopLoss: stopLoss === reference ? null : stopLoss,
        takeProfit: takeProfit === reference ? null : takeProfit,
    };
}

export interface TicketPlan {
    /**
     * The price the fill is expected around: the market for a market order, the typed level
     * for a resting one. Null when there is no honest answer yet.
     *
     * An estimate, and only that — the engine charges spread and slippage on top, so a market
     * order fills near this and not on it. Everything below is measured from it, so everything
     * below is an estimate too. That is the right kind of wrong for a number read while
     * deciding: it is the plan, not the receipt.
     */
    reference: number | null;
    /** What would be sent, or null where no size can be worked out. */
    size: number | null;
    /** Size at the reference price — what the account would actually be carrying. */
    notional: number | null;
    /**
     * What the stop would cost, in cash and as a share of equity. Null without a stop: a trade
     * with no stop does not risk nothing, it risks an amount nobody has worked out.
     */
    risk: { cash: number; share: number | null } | null;
    /** How far the target is, measured in stops. */
    rr: number | null;
    /** The leverage ceiling decided this size, not the risk — the stop is too tight for it. */
    capped: boolean;
    /**
     * What the venue would hold against this position, and what the account has left.
     *
     * Null where the account does not margin — a paper account ties up nothing, and showing
     * it a requirement of zero would read as "this is free" rather than "this does not apply".
     */
    margin: { required: number; available: number } | null;
}

/**
 * What the ticket comes to. Side-independent on purpose: the size, the notional, the cash at
 * risk and the reward:risk are the same numbers whichever way the trade goes — only whether it
 * may be SENT depends on the side, and that is {@link ticketRefusal}.
 */
export function ticketPlan(draft: TicketDraft, account: TicketAccount, risk: RiskSettings): TicketPlan {
    const typed = draft.entryPrice != null && draft.entryPrice > 0 ? draft.entryPrice : null;
    const reference = draft.type === 'market' ? (account.price > 0 ? account.price : null) : typed;

    /* Points into money, once, here — every figure below is in the account's currency and
     * none of them is a price. See {@link TicketAccount.pointValue}. */
    const value = pointValueOf(account);

    /* What the risk asks for, and what the venue would actually take. The two are kept apart
     * because only the first of them says whether the CEILING decided this trade: a size held
     * to the grid differs from the ceiling by up to a step, every time, and comparing the
     * snapped one would report a cap that never bit. */
    const wanted = ticketSize(draft, reference, account, risk, value);
    const size = snapSize(wanted, account);

    const notional = size != null && reference != null ? size * reference * value : null;

    const cash = size != null && reference != null && draft.stopLoss != null
        ? Math.abs(reference - draft.stopLoss) * size * value
        : null;

    const spread = reference != null && draft.stopLoss != null ? Math.abs(reference - draft.stopLoss) : 0;
    const rr = reference != null && draft.takeProfit != null && spread > 0
        ? Math.abs(draft.takeProfit - reference) / spread
        : null;

    /* Where the cap bit, the size is no longer the one the risk asked for, and the trade will
     * lose less than it was allowed to at its stop. Worth saying out loud: a ticket pinned to
     * the ceiling is telling you the stop is too tight for the risk, not that all is well. */
    const ceiling = sizeCeiling(reference, account, risk, value);
    const capped = draft.sizing === 'risk' && wanted != null && ceiling != null
        && Math.abs(wanted - ceiling) < ceiling * 1e-9;

    return {
        reference,
        size,
        notional,
        risk: cash == null ? null : { cash, share: account.equity > 0 ? cash / account.equity : null },
        rr,
        capped,
        margin: marginFor(notional, account),
    };
}

/**
 * The largest size the account could carry, or null where nothing bounds it.
 *
 * Two different ceilings, and which one applies says what kind of account this is. A live
 * account's is the money it has left divided by what the venue holds per unit — a hard
 * limit, decided by somebody else. A paper account's is the leverage figure in its own
 * settings, which is a rule its owner wrote for themselves.
 */
function sizeCeiling(reference: number | null, account: TicketAccount, risk: RiskSettings, value: number): number | null {
    if (reference == null || !(reference > 0)) return null;
    /* `reference * value` is what ONE unit is worth, which is what both ceilings are really
     * divided by — a leverage multiple and a margin share are both shares of what is being
     * carried, and what is carried is not the price on a contract that multiplies it. */
    const perUnit = reference * value;
    if (account.marginFactor != null && account.marginFactor > 0 && account.available != null) {
        return account.available / (account.marginFactor * perUnit);
    }
    return (account.equity * risk.maxLeverage) / perUnit;
}

/** What the venue would hold against this position. Null on an account that does not margin. */
function marginFor(notional: number | null, account: TicketAccount): { required: number; available: number } | null {
    if (notional == null || account.marginFactor == null || account.available == null) return null;
    return { required: notional * account.marginFactor, available: account.available };
}

/**
 * The size the risk asks for, before the venue's grid is applied — or null where there is no
 * honest answer.
 *
 * `positionSize` is the one answer in this app to "how big for this risk", and it is written
 * in a world where one point of price is one unit of money. That is not a limitation of it;
 * it is the arithmetic. So the two prices are converted into account money on the way in,
 * rather than the rule being copied out and adjusted here — a second implementation of sizing
 * is how a hand-placed trade and a bot's stop being "the same 1%" quietly stop being the same.
 */
function ticketSize(
    draft: TicketDraft,
    reference: number | null,
    account: TicketAccount,
    risk: RiskSettings,
    value: number,
): number | null {
    if (draft.sizing === 'fixed') return draft.fixedSize != null && draft.fixedSize > 0 ? draft.fixedSize : null;
    if (reference == null || draft.stopLoss == null) return null;
    const sized = positionSize(
        account.equity,
        reference * value,
        draft.stopLoss * value,
        risk.mode,
        risk.value,
        risk.maxLeverage,
    );
    /* On a margined account the leverage setting is not the binding limit — the money left is.
     * Held to whichever is smaller, so a ticket never offers a size the account cannot fund. */
    const ceiling = sizeCeiling(reference, account, risk, value);
    if (sized == null || ceiling == null) return sized;
    return Math.min(sized, ceiling);
}

/**
 * Why this side cannot be sent, in words — or null when it can.
 *
 * A reason rather than a disabled button, because every one of these is a question with an
 * answer ("which box do I fix?") and a grey button answers none of them.
 */
export function ticketRefusal(draft: TicketDraft, side: 'buy' | 'sell', account: TicketAccount, plan: TicketPlan): string | null {
    if (!(account.price > 0)) return 'The session has no price yet.';
    if (plan.reference == null) return 'A resting order needs a price to wait at.';

    /* What blocks BOTH directions comes first. Both sides are refused at once often enough —
     * a size of nothing, a missing stop — and the panel shows one message for the pair; if a
     * side-specific reason won that race it would name the direction the user did not press
     * while the real obstacle went unmentioned. */
    if (draft.sizing === 'risk' && draft.stopLoss == null) {
        return 'Risk sizing needs a stop — without one there is no distance to size against.';
    }
    if (draft.sizing === 'fixed' && !(draft.fixedSize != null && draft.fixedSize > 0)) {
        return 'A fixed size has to be a positive number of units.';
    }
    if (plan.size == null) {
        /* The size existed and the venue's grid took it to nothing — a different problem from
         * "this cannot be sized", and one with a different answer: widen nothing, risk more,
         * or accept that this instrument does not trade in pieces that small. */
        const floor = sizeFloor(account);
        if (floor != null) {
            return `The smallest trade this instrument takes is ${floor} — this works out to less.`;
        }
        return 'This cannot be sized against the account.';
    }

    if (draft.type !== 'market') {
        /* A limit is a pullback and a stop is a breakout: which side of the market the level
         * sits on is what makes it one or the other. The engine does not check this — it would
         * happily rest a buy limit above the market and fill it on the next bar at a price
         * nobody meant. */
        if (plan.reference === account.price) return `A ${side} ${draft.type} needs a price away from the market.`;
        const wantAbove = draft.type === 'stop' ? side === 'buy' : side === 'sell';
        if ((plan.reference > account.price) !== wantAbove) {
            return wantAbove
                ? `A ${side} ${draft.type} waits above the market.`
                : `A ${side} ${draft.type} rests below the market.`;
        }
    }

    // The same rule a level dragged on the chart is held to, in the same words.
    if (draft.stopLoss != null && !levelAllowed('stop', side, plan.reference, draft.stopLoss)) {
        return 'A stop belongs on the losing side of the entry.';
    }
    if (draft.takeProfit != null && !levelAllowed('target', side, plan.reference, draft.takeProfit)) {
        return 'A target belongs on the winning side of the entry.';
    }
    return null;
}

/**
 * Which resting order waits at `level` on this `side`, or null where there is none to be had.
 *
 * The rule {@link ticketRefusal} holds a typed ticket to, asked the other way round: a buy
 * below the market is a limit and above it a stop, a sell the opposite. A level picked off the
 * chart already says where, and this is what saves asking which. Null at the market itself and
 * without a market — neither kind of order rests at the price it would fill at.
 */
export function restingTypeAt(side: 'buy' | 'sell', level: number, market: number): 'limit' | 'stop' | null {
    if (!(market > 0) || !(level > 0) || level === market) return null;
    return (side === 'buy') === (level > market) ? 'stop' : 'limit';
}

/**
 * A price on the instrument's grid, or unchanged where there is no grid to put it on.
 *
 * For a level that came off the chart rather than off a keyboard: the pointer lands on whatever
 * price its pixel works out to, and a stop at 21034.1237 is one no venue would take and nobody
 * would have typed.
 */
export function priceOnGrid(price: number, tick: number | null): number {
    if (tick == null || !(tick > 0)) return price;
    return Number((Math.round(price / tick) * tick).toFixed(8));
}

/**
 * The risk setting this ticket's stop would lose more than, as it reads — or null where it would
 * not, or where there is no stop to lose anything at.
 *
 * In practice only a typed size gets here. A size worked out from the risk IS the risk, snapped
 * down; a typed size is a number nobody held against it, and a size one digit too long is how an
 * account is lost by accident rather than by judgement.
 */
export function riskExcess(plan: TicketPlan, account: TicketAccount, risk: RiskSettings): string | null {
    if (plan.risk == null) return null;
    const allowed = risk.mode === 'percent' ? (account.equity * risk.value) / 100 : risk.value;
    /* The same tolerance the cap check uses: a size worked out from this very figure lands a
     * binary-float hair either side of it, and that is not over. */
    if (!(allowed > 0) || plan.risk.cash <= allowed * (1 + 1e-9)) return null;
    return risk.mode === 'percent' ? `${Number(risk.value.toFixed(2))}%` : formatMoney(risk.value);
}

/**
 * The ticket as the chart draws it before anything is sent: where it would go in, where it would
 * get out, and what each of those comes to.
 *
 * Plain numbers, so it crosses into the chart as data and is drawn without the chart knowing what
 * a ticket is.
 */
export interface TicketPreview {
    side: 'buy' | 'sell';
    type: TicketOrderType;
    /**
     * The plan's reference: the market for a market order, so the line moves with every tick,
     * and the typed level for a resting one, so it stays where it was put.
     */
    entryPrice: number;
    size: number;
    stopPrice: number | null;
    targetPrice: number | null;
    /** What each level would come to if it traded — signed, in the account's money. */
    stopPnl: number | null;
    targetPnl: number | null;
    /** The stop's loss as a share of equity. Null without a stop, or without equity to share. */
    stopShare: number | null;
    rr: number | null;
    /** The risk setting the stop would lose more than — see {@link riskExcess}. */
    overRisk: string | null;
}

/**
 * The preview of a ticket, or null where there is nothing honest to draw: no size yet, or a
 * resting order with no price to wait at.
 *
 * Every figure is the plan's or measured the way the plan measures — from the same reference, at
 * the same size, through the same point value — so the loss on the chart and the loss on the
 * panel cannot be two different numbers.
 */
export function ticketPreview(
    draft: TicketDraft,
    side: 'buy' | 'sell',
    account: TicketAccount,
    plan: TicketPlan,
    risk: RiskSettings,
): TicketPreview | null {
    if (plan.size == null || plan.reference == null) return null;
    const reference = plan.reference;
    const size = plan.size;
    const value = pointValueOf(account);
    const direction = side === 'buy' ? 1 : -1;
    const at = (level: number | null): number | null => (level == null ? null : (level - reference) * direction * size * value);
    const stopPnl = at(draft.stopLoss);
    /* The plan's risk is a distance, whichever side the stop is on. A stop on the winning side
     * is one the ticket refuses to send, and a share of equity or a warning measured off it
     * would label a gain as the thing that is too big. */
    const losing = stopPnl != null && stopPnl < 0;
    return {
        side,
        type: draft.type,
        entryPrice: reference,
        size,
        stopPrice: draft.stopLoss,
        targetPrice: draft.takeProfit,
        stopPnl,
        targetPnl: at(draft.takeProfit),
        stopShare: losing ? plan.risk?.share ?? null : null,
        rr: plan.rr,
        overRisk: losing ? riskExcess(plan, account, risk) : null,
    };
}

/**
 * The ticket as an order spec.
 *
 * A stop and a target on an entry that has not filled yet cannot be two live orders — they
 * would trade against a position that does not exist. They ride along as a bracket instead and
 * become real orders the moment the entry fills, so a resting entry is protected exactly like
 * a market one.
 */
export function ticketOrder(draft: TicketDraft, side: 'buy' | 'sell', size: number): OrderSpec {
    const bracket: OrderBracket = {};
    if (draft.stopLoss != null) bracket.stopLoss = draft.stopLoss;
    if (draft.takeProfit != null) bracket.takeProfit = draft.takeProfit;

    return {
        side,
        type: draft.type,
        size,
        ...(draft.type === 'limit' ? { limitPrice: draft.entryPrice! } : {}),
        ...(draft.type === 'stop' ? { stopPrice: draft.entryPrice! } : {}),
        bracket: draft.stopLoss == null && draft.takeProfit == null ? null : bracket,
        // The tag the trade is filed under afterwards. 'manual' matches what a block traded
        // from the chart sends, so a hand-traded run reads as one thing in the library.
        tag: draft.type === 'market' ? 'manual' : `manual-${draft.type}`,
    };
}
