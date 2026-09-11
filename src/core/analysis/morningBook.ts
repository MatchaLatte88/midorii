import type { OHLCV } from '../model/ohlcv';
import { bucketBars } from './aggregate';
import { barStepMs, readBarClock, type BarClock } from './barClock';
import {
    detectPhaseOscillator,
    type PhaseOscillatorCross,
    type PhaseOscillatorOptions,
} from './phaseOscillator';
import {
    detectTimeBasedRange,
    type TimeBasedRangeOptions,
} from './timeBasedRange';

/**
 * The morning book: two engines watching the same session, and the first one to speak takes
 * the only seat.
 *
 * Why a book rather than two strategies side by side
 * --------------------------------------------------
 * The cell continuation and the phase oscillator both trade the same morning, on the same
 * instrument, in the same direction more often than not. Run as two strategies they would
 * sometimes double the position on exactly the mornings they agree about — which is the
 * opposite of what a person watching both screens would do, and it doubles the loss on the
 * mornings they are both wrong.
 *
 * So there is one seat. Whichever engine fires first that day takes it, and the other is
 * finished for the morning whatever it later sees. The seat is taken by the SIGNAL, not by
 * the trade: an engine whose signal is later rejected — the cell break that closed back
 * through its own open — has still spent the morning, because the decision to follow that
 * engine was made when it spoke. That is the published rule, and it is the pessimistic one.
 *
 * A tie goes to the oscillator, which only matters when both fire on the same bar.
 *
 * Two timeframes in one series
 * ----------------------------
 * The cell engine reads minutes and the oscillator reads ten-minute bars, so the oscillator's
 * bars are folded out of the series the strategy runs on and its crossings are mapped back to
 * the minute that COMPLETED each one — see `aggregate.ts` for why that mapping is the whole
 * correctness of this file.
 *
 * Every crossing is reported, not just the winning ones, because the oscillator's exit rule
 * needs them: a position opened at 09:20 comes off at the opposite cross whenever that
 * happens, which is usually long after the book has stopped taking signals.
 */

export interface MorningBookOptions {
    oscillator: PhaseOscillatorOptions;
    cell: TimeBasedRangeOptions;
    /** Bar length the oscillator is measured on. Must be a whole multiple of the series' own. */
    oscillatorStepMs: number;
}

/** The engine that took the seat that morning, and what it committed to. */
export interface MorningBookSignal {
    /** Index in the series the strategy runs on — the bar the signal could be acted on from. */
    index: number;
    direction: 'long' | 'short';
    day: string;
    source: 'oscillator' | 'cell';
    /** Where the trade is wrong, for the engine that has an answer. The cell engine's is its
     *  07:00 open; the oscillator has no stop at all, and says so with null. */
    stop: number | null;
}

export interface MorningBookDetection {
    /** At most one per session: the engine that spoke first. */
    signals: MorningBookSignal[];
    /** Every oscillator crossing, indexed against the base series, for the exit rule. */
    crosses: PhaseOscillatorCross[];
    clock: BarClock;
}

export function detectMorningBook(
    bars: readonly OHLCV[],
    options: MorningBookOptions,
): MorningBookDetection {
    if (bars.length < 2) {
        throw new Error('detectMorningBook: at least two bars are needed');
    }

    const baseStep = barStepMs(bars);
    const { oscillatorStepMs } = options;
    if (oscillatorStepMs < baseStep || oscillatorStepMs % baseStep !== 0) {
        throw new Error(
            `detectMorningBook: the oscillator timeframe (${oscillatorStepMs} ms) must be a whole `
            + `multiple of the chart's own (${baseStep} ms). Folding it out of these bars would `
            + 'otherwise invent bars that were never traded.',
        );
    }

    const clock = readBarClock(bars, options.cell.zone);

    const folded = bucketBars(bars, oscillatorStepMs);
    const oscillator = detectPhaseOscillator(folded.bars, options.oscillator);
    /* Mapped to the minute that completed each oscillator bar, and re-dated from the base
     * clock so both engines answer to one calendar. */
    const crosses: PhaseOscillatorCross[] = oscillator.crosses.map((cross) => {
        const index = folded.sourceEnd[cross.index]!;
        return { ...cross, index, day: clock.days[index]! };
    });

    const cell = detectTimeBasedRange(bars, options.cell);

    const winners = new Map<string, MorningBookSignal>();

    const offer = (candidate: MorningBookSignal): void => {
        const held = winners.get(candidate.day);
        if (!held) {
            winners.set(candidate.day, candidate);
            return;
        }
        if (candidate.index < held.index) winners.set(candidate.day, candidate);
        /* Same bar: the oscillator wins. `held` is only ever replaced here, so the cell can
         * never take a seat back off it. */
        else if (candidate.index === held.index && candidate.source === 'oscillator') {
            winners.set(candidate.day, candidate);
        }
    };

    for (const cross of crosses) {
        if (!cross.inEntryWindow) continue;
        offer({
            index: cross.index,
            direction: cross.direction,
            day: cross.day,
            source: 'oscillator',
            stop: null,
        });
    }

    for (const setup of cell.setups) {
        offer({
            index: setup.index,
            direction: setup.direction,
            day: setup.day,
            source: 'cell',
            stop: setup.cellOpen,
        });
    }

    const signals = [...winners.values()].sort((a, b) => a.index - b.index);
    return { signals, crosses, clock };
}
