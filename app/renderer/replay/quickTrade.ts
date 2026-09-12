import type { OrderBracket, OrderSpec } from '../../../shared/engine/broker.js';

/**
 * The quick way in: a size, a side, and it is on.
 *
 * The ticket beside the chart asks where the trade is wrong and works the size out from it.
 * This asks the opposite question — you know the size, the level is wherever the risk puts it —
 * and it exists because sometimes the market is already moving and the considered way in is
 * three fields too slow.
 *
 * Protection, if any, is stated as a DISTANCE rather than as two prices. A market order fills
 * at the market plus costs, not at the last close everyone can see; a stop set from that close
 * would cost a little more or less than the number typed. A distance attaches to the actual
 * fill, so "risk 50" costs 50 whatever the fill turns out to be — which is the whole point of
 * having typed it.
 */

export interface QuickDraft {
    /** Units to send. Null until something is typed. */
    size: number | null;
    /**
     * What the stop may cost, in whatever the account is denominated in. Null sends the order
     * with no protection at all — which is a real choice, not an oversight, and is why it is
     * allowed to be empty.
     */
    riskCash: number | null;
    /** Where the target goes, as a multiple of the stop distance. Null leaves it off. */
    rrr: number | null;
}

/** A panel with nothing in it. */
export function emptyQuick(): QuickDraft {
    return { size: null, riskCash: null, rrr: null };
}

export interface QuickPlan {
    size: number | null;
    /**
     * The price everything here was worked out against — the last one the session stands on.
     *
     * An estimate of the fill and only that: a market order fills at the market plus costs.
     * Carried because a venue that cannot take a distance has to be given levels, and levels
     * are only levels once there is a price to measure them from.
     */
    reference: number | null;
    /** How far the stop sits from the fill, or null when the order goes out unprotected. */
    stopDistance: number | null;
    /** The same for the target. */
    targetDistance: number | null;
    /** What the position would be worth at the last price. */
    notional: number | null;
    /** Why it cannot be sent, or null. Both sides at once: a market order has no side rules. */
    refusal: string | null;
}

/**
 * What the panel is describing, at the price the session is standing on.
 *
 * `pointValue` is what one point of price movement is worth, per unit, in the account's money
 * — one on a spot account, twenty on an NQ contract. It is the whole of the difference between
 * a stop that costs what was typed and one that costs a multiple of it: the risk is turned
 * into a DISTANCE here, and a distance in points divided by money-per-point is not the same
 * number as a distance in points divided by units. Defaults to one, which is what every
 * account here was until a futures contract was one of them.
 */
export function quickPlan(draft: QuickDraft, price: number, pointValue = 1): QuickPlan {
    const value = pointValue > 0 ? pointValue : 1;
    const size = draft.size != null && draft.size > 0 ? draft.size : null;
    const distance = size != null && draft.riskCash != null && draft.riskCash > 0
        ? draft.riskCash / (size * value)
        : null;

    return {
        size,
        reference: price > 0 ? price : null,
        stopDistance: distance,
        targetDistance: distance != null && draft.rrr != null && draft.rrr > 0 ? distance * draft.rrr : null,
        notional: size != null && price > 0 ? size * price * value : null,
        refusal: quickRefusal(draft, price, size, distance),
    };
}

function quickRefusal(draft: QuickDraft, price: number, size: number | null, distance: number | null): string | null {
    if (!(price > 0)) return 'The session has no price yet.';
    if (size == null) return 'Type a size first.';
    if (draft.riskCash != null && !(draft.riskCash > 0)) return 'A risk has to be a positive amount.';
    /* A reward:risk is a multiple of the stop distance, and with no risk there is no distance
     * for it to be a multiple of. Refused rather than ignored: silently dropping the target
     * would send a trade the panel appeared to say had one. */
    if (draft.rrr != null && draft.riskCash == null) {
        return 'A reward:risk needs a risk to measure against — give one, or clear it.';
    }
    if (draft.rrr != null && !(draft.rrr > 0)) return 'A reward:risk has to be a positive multiple.';
    /* The stop would sit at or below zero for a long. Nothing in the engine forbids it, and
     * nothing sensible comes of it either: that is not a stop, it is the whole instrument. */
    if (distance != null && distance >= price) return 'That risk is wider than the price itself.';
    return null;
}

/**
 * How the protection is written down, which is not a preference — it is what the other end
 * can read.
 *
 * `distance` is the honest one and what this panel was built on: the offset attaches to the
 * actual fill, so a risk of 50 costs 50 whatever the fill turns out to be. Only this app's own
 * engine can do that, because only it is holding the fill when the bracket becomes real.
 *
 * `levels` is for a venue. Capital.com, Bybit and Binance all take two prices and nothing else
 * — hand one a distance and the protection is dropped on the way out, silently, on an order
 * that has already gone. So the distance is turned into prices HERE, measured off the last
 * price, and what that costs is said out loud: the fill lands a spread away from where the
 * levels were worked out, so the trade risks a little more or less than the number typed.
 */
export interface QuickProtection {
    as: 'distance' | 'levels';
    /**
     * The instrument's own price increment, where it is known.
     *
     * A level worked out from a risk lands between two tradable prices almost every time, and
     * a venue refuses what is off its grid. Null leaves the level exactly as computed, which
     * is what a venue with no published increment gets either way.
     */
    tick?: number | null;
}

/** A price on the instrument's own grid, or unchanged where there is no grid to put it on. */
function onGrid(price: number, tick: number | null | undefined): number {
    if (tick == null || !(tick > 0)) return price;
    return Number((Math.round(price / tick) * tick).toFixed(8));
}

/**
 * The panel as an order spec — always a market order, because that is what this panel is for.
 *
 * The bracket rides along as distances and becomes real orders the moment the fill happens, so
 * the risk is measured from the fill rather than from the close it was typed against. Where
 * the other end cannot read a distance, `protection` turns them into levels instead — see
 * {@link QuickProtection} for what that costs.
 */
export function quickOrder(
    draft: QuickDraft,
    side: 'buy' | 'sell',
    plan: QuickPlan,
    protection: QuickProtection = { as: 'distance' },
): OrderSpec {
    /* Left empty where the order goes out bare — which is a real choice, and the one case
     * `levels` has no work to do and nothing to refuse over. It is dropped below either way. */
    const bracket: OrderBracket = {};
    if (plan.stopDistance != null && protection.as === 'levels') {
        /* Unreachable through the panel — a plan with no price is already refused — and
         * thrown rather than quietly turned back into distances, which is the one outcome
         * this branch exists to prevent: a venue that cannot read them would drop the
         * protection on an order that has already gone. */
        if (plan.reference == null) throw new Error('A protected order needs a price to measure its levels from.');
        // Down for a long, up for a short — the stop is on the losing side of the entry.
        const dir = side === 'buy' ? 1 : -1;
        bracket.stopLoss = onGrid(plan.reference - dir * plan.stopDistance, protection.tick);
        if (plan.targetDistance != null) {
            bracket.takeProfit = onGrid(plan.reference + dir * plan.targetDistance, protection.tick);
        }
    } else if (plan.stopDistance != null) {
        bracket.stopDistance = plan.stopDistance;
        if (plan.targetDistance != null) bracket.targetDistance = plan.targetDistance;
    }

    return {
        side,
        type: 'market',
        size: plan.size!,
        bracket: plan.stopDistance == null ? null : bracket,
        // The same tag the ticket and a traded block use — one column in the run library.
        tag: 'manual',
    };
}

/**
 * The step a stepper takes from what is currently in the box: one unit of its last decimal
 * place, so 1 steps by 1, 0.25 by 0.01, and 0.0000001 by 0.0000001.
 *
 * A fixed step cannot serve both: on an instrument quoted around 90,000 a whole unit is a
 * fortune and a hundredth is still real money, while on another it is nothing at all. Following
 * what was typed means the panel steps at the precision the person is already working in,
 * without knowing anything about the instrument.
 */
export function sizeStep(text: string): number {
    const decimals = (text.split('.')[1] ?? '').length;
    if (decimals === 0) return 1;
    return Number(`1e-${Math.min(8, decimals)}`);
}

/** Add `dir` steps to what is in the box, never going below zero. Empty counts as nothing. */
export function stepSize(text: string, dir: 1 | -1): string {
    const step = sizeStep(text);
    const current = Number(text.trim());
    const base = Number.isFinite(current) && current > 0 ? current : 0;
    const next = base + dir * step;
    if (!(next > 0)) return '';
    /* Written out, never as an exponent: `String(2e-7)` is "2e-7", and that would go straight
     * into the size box in front of someone about to press Buy. Eight places is a satoshi,
     * which is finer than anything is quoted in, and it also rounds off the dust binary floats
     * leave behind (0.1 + 0.1 + 0.1). */
    return next.toFixed(8).replace(/\.?0+$/, '');
}
