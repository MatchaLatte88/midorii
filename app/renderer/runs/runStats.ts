/**
 * The shape of a stored run's balance curve. Kept apart from the dialog so the geometry can
 * be asserted without a DOM.
 */

export interface Sparkline {
    /** SVG path data, empty when there was nothing to draw. */
    d: string;
    /** The value range the path was scaled to — the baseline included when one was given. */
    min: number;
    max: number;
    /** Where the baseline sits in the box, or null when none was given. */
    baselineY: number | null;
}

/**
 * The balance curve as an SVG path.
 *
 * Balance, not equity: the stored curve keeps the first point, the last, and every point where
 * the REALISED balance moved (see condenseEquity), so the unrealised wiggles between trades are
 * not in it. Drawing equity across those points would draw a line through prices the account
 * never sat at.
 *
 * Laid out by time rather than by index, so a run that traded twice in an hour and then stood
 * still for a week looks like what it was.
 */
export function equityPath(
    points: ReadonlyArray<{ time: number; balance: number }>,
    width: number,
    height: number,
    baseline?: number,
): Sparkline {
    if (points.length === 0 || !(width > 0) || !(height > 0)) {
        return { d: '', min: 0, max: 0, baselineY: null };
    }

    let min = Infinity;
    let max = -Infinity;
    for (const p of points) {
        if (p.balance < min) min = p.balance;
        if (p.balance > max) max = p.balance;
    }
    // The baseline belongs inside the window, or a run that only ever lost would draw a rising
    // line with nothing to read it against.
    if (baseline != null && Number.isFinite(baseline)) {
        min = Math.min(min, baseline);
        max = Math.max(max, baseline);
    }

    const span = max - min;
    // A flat account still has a shape: a line through the middle, not a division by zero.
    const y = (v: number): number => (span > 0 ? height - ((v - min) / span) * height : height / 2);

    const t0 = points[0]!.time;
    const t1 = points[points.length - 1]!.time;
    const dt = t1 - t0;
    const x = (t: number): number => (dt > 0 ? ((t - t0) / dt) * width : width / 2);

    const round = (n: number): string => (Math.round(n * 100) / 100).toString();
    const d = points
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${round(x(p.time))} ${round(y(p.balance))}`)
        .join(' ');

    return {
        d,
        min,
        max,
        baselineY: baseline != null && Number.isFinite(baseline) ? y(baseline) : null,
    };
}
