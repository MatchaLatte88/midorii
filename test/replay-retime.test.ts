// Changing the timeframe in the middle of a replay.
//
// This is the whole chain in one place: the bar store buckets the minutes, the
// window loader finds the bar the clock is standing in, and the session rebases
// onto it — with the account carried across untouched. It runs against the real
// aggregation code rather than a stub of it, because the two halves disagreeing
// about where a bucket starts is exactly the failure this has to rule out.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { aggregate, STRIDE } from '../app/electron/data/store/barStore.js';
import { barIndexAt } from '../shared/engine/replaySession.js';
import { ReplayController } from '../app/renderer/replay/ReplayController';
import type { ReplayProvider } from '../app/renderer/replay/ReplayProvider';
import { loadReplayWindow } from '../app/renderer/replay/replayWindow';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const START = Date.UTC(2024, 0, 1);
const DAYS = 2;

/** Two days of 1-minute bars, price walking upward so every bar is distinguishable. */
function minuteData(): Float64Array {
    const count = DAYS * 24 * 60;
    const data = new Float64Array(count * STRIDE);
    for (let i = 0; i < count; i++) {
        const base = i * STRIDE;
        const price = 100 + i * 0.1;
        data[base] = START + i * MINUTE;
        data[base + 1] = price;
        data[base + 2] = price + 1;
        data[base + 3] = price - 1;
        data[base + 4] = price + 0.5;
        data[base + 5] = 10;
        data[base + 6] = 6;
    }
    return data;
}

const DATA = minuteData();
const LAST = START + (DAYS * 24 * 60 - 1) * MINUTE;

/** Stands in for the Electron bridge: the same store code, over an in-memory dataset. */
const midori = {
    data: {
        meta: () => Promise.resolve({ symbol: 'TEST', first: START, last: LAST }),
        bars: ({ timeframe, from, to, dropIncomplete = true }: {
            timeframe: string; from: number; to: number; dropIncomplete?: boolean;
        }) => Promise.resolve(aggregate(DATA, from, to, timeframe, dropIncomplete)),
    },
};

/** Records what the chart would have been told, so the two can be compared. */
class FakeProvider {
    timeframe = '60';
    cutoff = 0;
    readonly revealed: number[] = [];

    retime(timeframe: string, clock: number): void {
        this.timeframe = timeframe;
        this.cutoff = clock;
    }

    revealNext(bar: { time: number }): void {
        this.revealed.push(bar.time);
    }
}

let previousWindow: unknown;

beforeAll(() => {
    previousWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { midori };
});

afterAll(() => {
    (globalThis as { window?: unknown }).window = previousWindow;
});

/** A session sitting at `clock` on `timeframe`, with the chart it drives. */
async function session(timeframe: string, clock: number) {
    const { bars } = await loadReplayWindow('TEST', timeframe, clock);
    const provider = new FakeProvider();
    provider.retime(timeframe, clock);
    const controller = new ReplayController({
        provider: provider as unknown as ReplayProvider,
        symbol: 'TEST',
        timeframe,
        bars,
        startIndex: barIndexAt(bars, clock - 1),
        balance: 10_000,
    });
    return { controller, provider };
}

describe('loadReplayWindow', () => {
    it('reports no bar in progress when the clock sits on a boundary', async () => {
        const { forming, stepMs } = await loadReplayWindow('TEST', '60', START + 12 * HOUR);
        expect(forming).toBeNull();
        expect(stepMs).toBe(HOUR);
    });

    it('builds the bar in progress from only the minutes that have been played', async () => {
        const clock = START + 14 * HOUR + 5 * MINUTE;
        const { bars, forming } = await loadReplayWindow('TEST', '240', clock);

        // 14:05 falls inside the four-hour bar that opened at 12:00.
        expect(forming?.time).toBe(START + 12 * HOUR);
        // 125 minutes of it have been played, of the 240 the finished bar holds.
        expect(forming?.volume).toBe(125 * 10);
        expect(bars.find((b) => b.time === START + 12 * HOUR)?.volume).toBe(240 * 10);
    });

    it('refuses a clock the data does not reach back to', async () => {
        await expect(loadReplayWindow('TEST', '60', START)).rejects.toThrow(/No bars before/);
    });
});

describe('ReplayController.retime', () => {
    let controller: ReplayController;
    let provider: FakeProvider;

    beforeEach(async () => {
        ({ controller, provider } = await session('60', START + 12 * HOUR));
    });

    it('carries the clock and the account onto a faster timeframe', async () => {
        controller.buy({ size: 1 });
        const entry = controller.session.broker.positions[0]!.entryPrice;
        const clock = controller.session.clock;

        await controller.retime('5');

        expect(controller.timeframe).toBe('5');
        expect(controller.session.clock).toBe(clock);
        expect(controller.session.stepMs).toBe(5 * MINUTE);
        // The last closed five-minute bar ends exactly where the clock is.
        expect(controller.session.bar.time).toBe(clock - 5 * MINUTE);
        // The position is the same position — nothing was replayed or re-priced.
        expect(controller.session.broker.positions).toHaveLength(1);
        expect(controller.session.broker.positions[0]!.entryPrice).toBe(entry);
        expect(provider.cutoff).toBe(clock);
    });

    it('stands inside the bar a slower timeframe lands it in, and finishes it on the next step', async () => {
        controller.step(); // 12:00 → 13:00
        controller.step(); // 13:00 → 14:00
        const clock = controller.session.clock;
        expect(clock).toBe(START + 14 * HOUR);

        await controller.retime('240');

        // The playhead is inside the 12:00–16:00 bar, drawn as far as it has got.
        const partial = controller.session.bar;
        expect(partial.time).toBe(START + 12 * HOUR);
        expect(partial.volume).toBe(120 * 10); // two of the four hours played
        expect(controller.session.clock).toBe(clock); // not a minute skipped
        expect(controller.atEnd).toBe(false); // finishing it is still a step

        controller.step();

        // Same bar, now whole — and the clock has moved to where it closes.
        expect(controller.session.bar.time).toBe(START + 12 * HOUR);
        expect(controller.session.bar.volume).toBe(240 * 10);
        expect(controller.session.clock).toBe(START + 16 * HOUR);
        expect(provider.revealed[provider.revealed.length - 1]).toBe(START + 12 * HOUR);
    });

    it('is a no-op on the timeframe it is already running', async () => {
        const before = controller.session.bars;
        await controller.retime('60');
        expect(controller.session.bars).toBe(before);
    });

    it('leaves the session alone when the new timeframe cannot be served', async () => {
        const clock = controller.session.clock;
        await expect(controller.retime('90s')).rejects.toThrow();
        expect(controller.timeframe).toBe('60');
        expect(controller.session.clock).toBe(clock);
    });
});
