/**
 * Which chart, if any, is the Trading Bot tab's.
 *
 * The app's own topbar actions — the Trade menu above all — are registered globally and
 * appear on every chart in the window. On the bot's chart the Trade menu is not merely
 * redundant, it is wrong: it would wire a SECOND account to a chart that already has one
 * running behind it, and a hand-placed trade landing beside a bot's would be a trade nobody
 * could attribute afterwards. The same argument the bot screen makes by having no ticket.
 *
 * So the bot's chart declares itself, exactly the way a running replay does (see
 * replayActions.ts, whose `isReplayContext` this mirrors), and the actions that belong to
 * the live chart gate themselves off it.
 *
 * Compared by identity rather than by a flag on the context: a widget context hands out the
 * chart instance it is projecting for, and that is the only thing about it that cannot be
 * mistaken for another chart's.
 */

/** The Vela instance the bot tab's chart is running on, once it has been built. */
let botChart: unknown = null;

/** Told by the bot view when its chart exists. Passing null gives up the claim. */
export function setBotChart(chart: unknown): void {
    botChart = chart;
}

/** Whether a widget action is being projected onto the bot tab's chart. */
export function isBotContext(ctx: { readonly chart: unknown }): boolean {
    return botChart != null && botChart === ctx.chart;
}
