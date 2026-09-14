/**
 * How money, percentages and times read across the app.
 *
 * One place, because the same figure has to look the same wherever it turns up: an account's
 * equity on the chart during a session and the same account's equity in the run library
 * afterwards are the same number, and two formatters would eventually disagree about it.
 */
/** A minus that matches the rest of the chart's typography, not the keyboard's hyphen. */
export const MINUS = '−';

/** Groups and fixes to two decimals, with a real minus. No currency: the account is in
 *  whatever the market quotes in, and inventing a symbol would be a claim about that. */
export function formatMoney(value: number): string {
    if (!Number.isFinite(value)) return '—';
    const text = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return value < 0 ? `${MINUS}${text}` : text;
}

/** The same, with the sign always shown — for a figure whose direction is the point. */
export function formatSignedMoney(value: number): string {
    if (!Number.isFinite(value)) return '—';
    return value > 0 ? `+${formatMoney(value)}` : formatMoney(value);
}

/**
 * A fraction as a percentage. `null` is an account that gave no answer — no trades means no
 * win rate — and reads as a dash rather than as zero.
 */
export function formatPercent(fraction: number | null | undefined, digits = 2, signed = false): string {
    if (fraction == null || !Number.isFinite(fraction)) return '—';
    const pct = fraction * 100;
    const text = `${Math.abs(pct).toFixed(digits)}%`;
    if (pct < 0) return `${MINUS}${text}`;
    return signed && pct > 0 ? `+${text}` : text;
}

/**
 * Profit factor, where `null` means something quite different from everywhere else in the
 * stats: gross profit with no gross loss at all. That is infinite, not unknown — see
 * `summarize` in shared/engine, which returns null precisely so an infinity stays out of sums.
 */
export function formatProfitFactor(value: number | null | undefined): string {
    if (value === null) return '∞';
    if (value == null || !Number.isFinite(value)) return '—';
    return value.toFixed(2);
}

/**
 * A position size as the instrument quotes it.
 *
 * Rounded before it is printed, because adding 0.2 and 0.1 lots leaves
 * 0.30000000000000004 behind and a size readout is the one place that dust is visible.
 * Eight decimals is a satoshi, which is finer than anything is quoted in.
 */
export function formatSize(size: number): string {
    if (!Number.isFinite(size)) return '—';
    return Number(size.toFixed(8)).toLocaleString('en-US', { maximumFractionDigits: 8 });
}

/**
 * A price, as short as it can be said without changing it.
 *
 * Prices that came off the pointer rather than off a keyboard carry the double's full
 * decimal tail, and a level of 111234.56789012345 is one no one chose and no one could
 * read back. Alert levels are snapped to the symbol's tick before they are stored (see
 * `alerts/symbolTick.ts`), so this is the second line of defence: it covers a level saved
 * before that snapping existed, and one whose symbol never reported a tick size. Eight
 * decimals is a satoshi — finer than anything is quoted in — and `Number()` drops the
 * zeros `toFixed` pads with, so a round price still reads round.
 */
export function formatPrice(price: number): string {
    if (!Number.isFinite(price)) return '—';
    return String(Number(price.toFixed(8)));
}

/**
 * A trade's result in R — what it made against what it risked when it was opened.
 *
 * Null when the trade carried no stop: risking nothing is not a risk of zero, it is a trade
 * whose result cannot be stated in R at all. Uses `riskPerUnit` rather than the stop the trade
 * ended with, which for anything moved to break-even is a distance of almost nothing.
 */
export function rMultiple(trade: { netPnl: number; size: number; riskPerUnit: number | null; pointValue?: number | null }): number | null {
    const risk = trade.riskPerUnit;
    if (risk == null || !(risk > 0) || !(trade.size > 0)) return null;
    // `riskPerUnit` is in points; the result is money. Absent means a point is worth one.
    const perPoint = trade.pointValue != null && trade.pointValue > 0 ? trade.pointValue : 1;
    return trade.netPnl / (risk * trade.size * perPoint);
}

/** A signed R multiple, or a dash for a trade that had no stop to measure against. */
export function formatR(value: number | null): string {
    if (value == null) return '—';
    const text = `${Math.abs(value).toFixed(2)}R`;
    return value < 0 ? `${MINUS}${text}` : `+${text}`;
}

/** UTC, to the minute — the clock everything else in the app is stamped in. */
export function formatWhen(ms: number): string {
    if (!Number.isFinite(ms)) return '—';
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

/** UTC date only, for a run's covered range. */
export function formatDay(ms: number): string {
    if (!Number.isFinite(ms)) return '—';
    return new Date(ms).toISOString().slice(0, 10);
}

