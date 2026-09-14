// A replay played on recorded ticks, through the controller the chart drives.
//
// The engine's own rules are proved in replay-ticks.test.ts. What is proved here is the part a
// person meets: the tape and the ladder are fed, the candle on the chart grows and closes, dead
// air is jumped, leaving ticks finishes the candle on its prints, the recording ending is said
// out loud — and going back to a candle rebuilds an account that was played on ticks exactly.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { aggregate, STRIDE } from '../app/electron/data/store/barStore.js';
import { barIndexAt } from '../shared/engine/replaySession.js';
import { resetOrderIds } from '../shared/engine/broker.js';
import { ReplayController } from '../app/renderer/replay/ReplayController';
import type { ReplayProvider } from '../app/renderer/replay/ReplayProvider';
import { TickFeed } from '../app/renderer/replay/tickFeed';
import { loadReplayWindow } from '../app/renderer/replay/replayWindow';
import type { MidoriTick } from '../app/renderer/midori';

const MINUTE = 60_000;
const START = Date.UTC(2026, 8, 11, 13, 0);

/** Three hours of one-minute candles at 100, as a recording's own dataset would hold. */
function minutes(): Float64Array {
    const count = 3 * 60;
    const data = new Float64Array(count * STRIDE);
    for (let i = 0; i < count; i++) {
        data.set([START + i * MINUTE, 100, 101, 99, 100, 10, 5], i * STRIDE);
    }
    return data;
}
const DATA = minutes();

/** The recording: prints every ten seconds from 14:00 to 14:10, a quote with each, then nothing. */
function recording(): MidoriTick[] {
    const out: MidoriTick[] = [];
    const t0 = START + 60 * MINUTE;
    for (let s = 0; s < 600; s += 10) {
        const price = 100 + Math.sin(s / 60) * 0.75;
        const rounded = Math.round(price * 4) / 4;
        out.push([t0 + s * 1000, 2, rounded - 0.25, rounded + 0.25, null]);
        out.push([t0 + s * 1000 + 1, 1, rounded, 1, s % 20 === 0 ? 0 : 1]);
    }
    return out;
}
const TICKS = recording();

const readTicks = ({ from, to }: { name: string; from: number; to: number }): Promise<MidoriTick[]> =>
    Promise.resolve(TICKS.filter((e) => e[0] >= from && e[0] < to));

const midori = {
    data: {
        meta: () => Promise.resolve({ symbol: 'NQU6.REC', first: START, last: START + (3 * 60 - 1) * MINUTE }),
        bars: ({ timeframe, from, to, dropIncomplete = true }: { timeframe: string; from: number; to: number; dropIncomplete?: boolean }) =>
            Promise.resolve(aggregate(DATA, from, to, timeframe, dropIncomplete)),
    },
    ticks: { read: readTicks },
};

let previous: unknown;
beforeAll(() => {
    previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { midori };
});
afterAll(() => {
    (globalThis as { window?: unknown }).window = previous;
});
beforeEach(() => resetOrderIds());

/** What the chart was told. */
class FakeProvider {
    readonly closed: number[] = [];
    readonly forming: Array<{ time: number; close: number; clock: number }> = [];
    retime(): void {}
    revealNext(bar: { time: number }): void {
        this.closed.push(bar.time);
    }
    revealForming(bar: { time: number; close: number }, clock: number): void {
        this.forming.push({ time: bar.time, close: bar.close, clock });
    }
}

async function session(at = START + 60 * MINUTE) {
    const { bars } = await loadReplayWindow('NQU6.REC', '1', at);
    const provider = new FakeProvider();
    const notices: string[] = [];
    const prints: number[] = [];
    const controller = new ReplayController({
        provider: provider as unknown as ReplayProvider,
        symbol: 'NQU6.REC',
        timeframe: '1',
        bars,
        startIndex: barIndexAt(bars, at - 1),
        balance: 10_000,
        ticks: new TickFeed('NQU6', readTicks),
        rechart: () => Promise.resolve(new FakeProvider() as unknown as ReplayProvider),
        onNotice: (message) => notices.push(message),
    });
    controller.onPrints = (batch) => { for (const p of batch) prints.push(p[2]); };
    await controller.setPlayMode('ticks');
    return { controller, provider, notices, prints };
}

describe('playing on ticks', () => {
    it('feeds the tape, grows the candle on the chart, and closes it at its end', async () => {
        const { controller, provider, prints } = await session();
        await controller.playFrame(35_000);   // 14:00:00 to 14:00:35

        expect(prints).toHaveLength(4);        // prints at :00, :10, :20, :30
        expect(controller.session.clock).toBe(START + 60 * MINUTE + 35_000);
        expect(provider.forming[provider.forming.length - 1]).toMatchObject({ time: START + 60 * MINUTE, clock: controller.session.clock });
        expect(provider.closed).toEqual([]);

        await controller.stepForward();        // to the end of the 14:00 candle
        expect(provider.closed).toEqual([START + 60 * MINUTE]);
        expect(controller.session.clock).toBe(START + 61 * MINUTE);
    });

    it('fills a market order at the recorded ask — plus the slippage the account charges, not the spread', async () => {
        const { controller } = await session();
        await controller.playFrame(5_000);
        const { broker } = controller.session;
        const ask = broker.quote!.ask;
        expect(ask).not.toBe(controller.price());   // the ask, not the last print
        controller.buy({ size: 1 });
        expect(broker.positions[0]!.entryPrice).toBeCloseTo(ask * (1 + broker.costs.slippagePct), 9);
    });

    it('jumps the dead air before the recording begins instead of playing it in real time', async () => {
        const { controller, prints } = await session(START + 30 * MINUTE);   // half an hour early
        await controller.playFrame(1_000);
        // The clock went straight to the first recorded event, and the minutes in between were stepped.
        expect(controller.session.clock).toBe(START + 60 * MINUTE);
        expect(prints).toHaveLength(0);
        await controller.playFrame(2_000);
        expect(prints.length).toBeGreaterThan(0);
    });

    it('stops, and says so, where the recording ends', async () => {
        const { controller, notices } = await session();
        await controller.skipForward(12);      // past 14:10, where the prints stop
        await controller.playFrame(1_000);
        expect(notices[notices.length - 1]).toMatch(/recording ends here/);
        expect(controller.playing).toBe(false);
    });

    it('finishes the candle on its prints before playing on candles again', async () => {
        const { controller, provider } = await session();
        await controller.playFrame(25_000);
        await controller.setPlayMode('bars');
        expect(controller.mode).toBe('bars');
        expect(controller.session.clock).toBe(START + 61 * MINUTE);
        expect(provider.closed).toEqual([START + 60 * MINUTE]);
        controller.step();                     // a whole candle now
        expect(controller.session.clock).toBe(START + 62 * MINUTE);
    });

    it('refuses a whole-candle step while the prints are being played', async () => {
        const { controller } = await session();
        expect(() => controller.step()).toThrow(/Playing on ticks/);
    });
});

describe('going back on ticks', () => {
    it('rebuilds an account that was traded on ticks, exactly', async () => {
        const { controller } = await session();
        await controller.playFrame(12_000);
        // A buy stop the rising prints go through inside this candle, with a bracket on it.
        const p = controller.price();
        controller.order({ side: 'buy', type: 'stop', size: 2, stopPrice: p + 0.25, bracket: { takeProfit: p + 0.5, stopLoss: p - 0.5 } });
        await controller.playFrame(61_000);    // into the next candle; the entry is decided on prints
        const candle = controller.session.bar.time - MINUTE;   // the candle that closed on the way
        await controller.playFrame(90_000);
        controller.sell({ size: 1 });          // after it — must vanish

        await controller.jumpTo(candle);

        const { controller: reference } = await session();
        await reference.playFrame(12_000);
        const q = reference.price();
        reference.order({ side: 'buy', type: 'stop', size: 2, stopPrice: q + 0.25, bracket: { takeProfit: q + 0.5, stopLoss: q - 0.5 } });
        await reference.skipForward(1);        // played to the end of the 14:00 candle, cut differently

        const figures = (c: ReplayController) => ({
            clock: c.session.clock,
            trades: c.session.broker.trades,
            open: c.session.broker.positions.map((p) => [p.size, p.entryPrice]),
            pending: c.session.broker.pending.map((o) => [o.type, o.limitPrice ?? o.stopPrice]),
            balance: c.session.broker.balance,
        });
        // Something was decided by the prints before the candle — the rebuild had to replay it.
        expect(reference.session.broker.fills.length).toBeGreaterThan(0);
        expect(controller.mode).toBe('ticks');
        expect(figures(controller)).toEqual(figures(reference));
    });

    it('goes back to the start of the candle still in progress', async () => {
        const { controller } = await session();
        await controller.playFrame(20_000);
        controller.buy({ size: 1 });
        await controller.jumpTo(START + 60 * MINUTE);   // the candle the playhead is inside
        expect(controller.session.clock).toBe(START + 60 * MINUTE);
        expect(controller.session.broker.positions).toHaveLength(0);
    });
});

describe('the tick feed', () => {
    it('loads a window ahead and answers from it, reloading only outside it', async () => {
        const asked: Array<[number, number]> = [];
        const feed = new TickFeed('NQU6', (request) => {
            asked.push([request.from, request.to]);
            return readTicks(request);
        });
        const t = START + 60 * MINUTE;
        await feed.between(t, t + 5_000);
        await feed.between(t + 5_000, t + 60_000);
        expect(asked).toHaveLength(1);
        await feed.between(t - 60_000, t);           // behind the window: a fresh read
        expect(asked).toHaveLength(2);
    });

    it('finds the next event across a gap, and none past the end of the recording', async () => {
        const feed = new TickFeed('NQU6', readTicks);
        expect(await feed.nextAfter(START)).toBe(START + 60 * MINUTE);
        expect(await feed.nextAfter(START + 3 * 60 * MINUTE)).toBeNull();
    });
});
