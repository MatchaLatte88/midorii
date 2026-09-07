import { readLineId } from './replayIndicator';
import type { Vela } from '../../../src';
import type { TradingController } from '../trading/TradingController';

/**
 * The levels of an open position, taken hold of on the chart.
 *
 * Typing a stop into a field works, but it is not how anyone moves a stop: you look at the
 * chart, see where the level should be, and put it there. So the two lines a position draws are
 * draggable, and dropping one re-protects the position — through the same `protect` call a
 * typed level goes through, so a level moved by hand is the same order as a level typed in.
 *
 * A position with no protection has no such lines, which is exactly when one is needed most.
 * There its ENTRY is the handle: a drag off it pulls a level out (`priceline:spawned`), and
 * which one that is comes from the direction alone — see {@link levelFromDrop}.
 *
 * Nothing is decided here. The chart reports where a line was dropped; the account decides
 * whether it goes there, and the next state push is what actually moves the line. A rejected
 * drop therefore snaps back on its own — there is no second copy of the truth to correct.
 */

export interface LevelWiringOptions {
    chart: Vela;
    controller: TradingController;
    /** Feedback for a drop the account refuses. */
    notify?: (message: string, kind: 'info' | 'error') => void;
}

/**
 * Whether a level may go where it was dropped.
 *
 * A stop belongs on the losing side of the entry and a target on the winning side; crossing
 * over turns one into the other, which is never what a drag meant — it is a slip, or a
 * misjudged scale. Refused rather than reinterpreted, because "your stop is now a target" is
 * not something to discover from a position that closed.
 */
export function levelAllowed(level: 'stop' | 'target', side: 'buy' | 'sell', entryPrice: number, price: number): boolean {
    if (!Number.isFinite(price) || price === entryPrice) return false;
    const above = price > entryPrice;
    return level === 'stop' ? above === (side === 'sell') : above === (side === 'buy');
}

/**
 * Which level a drag off the entry just drew, from nothing but the side it landed on.
 *
 * The same rule as {@link levelAllowed}, read the other way round. Nobody pulling a line off a
 * position is choosing between a stop and a target — they are pointing at where the trade is
 * wrong or where it is done, and which of the two that is follows from the direction. So the
 * gesture asks no question, and there is nothing to get wrong: a drop on the losing side can
 * only be a stop, and one on the winning side can only be a target.
 *
 * Null for a drop on the entry itself, which names neither.
 */
export function levelFromDrop(side: 'buy' | 'sell', entryPrice: number, price: number): 'stop' | 'target' | null {
    if (!Number.isFinite(price) || price === entryPrice) return null;
    return (price > entryPrice) === (side === 'buy') ? 'target' : 'stop';
}

/** Wire chart-level drags and the close button to the account. Returns an unsubscribe. */
export function wirePositionLevels(opts: LevelWiringOptions): () => void {
    const { chart, controller } = opts;
    const notify = opts.notify ?? (() => {});

    const positionOf = (id: number) => controller.broker.positions.find((p) => p.id === id) ?? null;

    const offMoved = chart.on('priceline:moved', ({ id, price }) => {
        const target = readLineId(id);
        if (!target || target.level === 'entry') return;
        const position = positionOf(target.positionId);
        if (!position) return;
        const side = position.size > 0 ? 'buy' : 'sell';
        if (!levelAllowed(target.level, side, position.entryPrice, price)) {
            notify(target.level === 'stop'
                ? 'A stop belongs on the losing side of the entry.'
                : 'A target belongs on the winning side of the entry.', 'error');
            controller.refreshVisuals(); // the line is still where it was; redraw says so
            return;
        }
        controller.protect(target.level === 'stop' ? { stopLoss: price } : { takeProfit: price }, position.id);
    });

    /* A level dragged OUT of the entry line — the way a position that opened with no
     * protection gets some. It goes through the same `protect` call a moved level does: what
     * arrives here is a price and a direction, and past this point there is no difference
     * between a stop that was pulled off an entry and one that was typed into the panel. */
    const offSpawned = chart.on('priceline:spawned', ({ id, price }) => {
        const target = readLineId(id);
        if (!target || target.level !== 'entry') return;
        const position = positionOf(target.positionId);
        if (!position) return;
        const side = position.size > 0 ? 'buy' : 'sell';
        const level = levelFromDrop(side, position.entryPrice, price);
        // Only a drop exactly on the entry, which the renderer's travel floor already all but
        // rules out. Nothing was created, so there is nothing to undo and nothing to say.
        if (!level) return;
        controller.protect(level === 'stop' ? { stopLoss: price } : { takeProfit: price }, position.id);
    });

    const offAction = chart.on('priceline:action', ({ id }) => {
        const target = readLineId(id);
        if (!target) return;
        controller.closeOne(target.positionId);
    });

    return () => {
        offMoved();
        offSpawned();
        offAction();
    };
}
