// Going back to an earlier candle in a replay.
//
// The promise is exact: after the jump, the account is the account a person would have had
// if they had stopped at that candle — not one with the later trades filtered out of a list.
// So every test here compares against a second session that simply never did the later
// things, on the same bars, through the same store code.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { aggregate, STRIDE } from '../app/electron/data/store/barStore.js';
import { barIndexAt } from '../shared/engine/replaySession.js';
import { ReplayController } from '../app/renderer/replay/ReplayController';
import type { ReplayProvider } from '../app/renderer/replay/ReplayProvider';
import { ReplayJournal, rebuildSession } from '../app/renderer/replay/replayJournal';
import { loadReplayWindow } from '../app/renderer/replay/replayWindow';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const START = Date.UTC(2024, 0, 1);
const DAYS = 2;

/** Two days of 1-minute bars. A slow wave, so a target above and a stop below both get hit. */
function minuteData(): Float64Array {
    const count = DAYS * 24 * 60;
    const data = new Float64Array(count * STRIDE);
    for (let i = 0; i < count; i++) {
        const base = i * STRIDE;
        const price = 100 + Math.sin(i / 30) * 5;
        data[base] = START + i * MINUTE;
        data[base + 1] = price;
        data[base + 2] = price + 0.4;
        data[base + 3] = price - 0.4;
        data[base + 4] = price + 0.1;
        data[base + 5] = 10;
        data[base + 6] = 6;
    }
    return data;
}

const DATA = minuteData();
const LAST = START + (DAYS * 24 * 60 - 1) * MINUTE;

const midori = {
    data: {
        meta: () => Promise.resolve({ symbol: 'TEST', first: START, last: LAST }),
        bars: ({ timeframe, from, to, dropIncomplete = true }: {
            timeframe: string; from: number; to: number; dropIncomplete?: boolean;
        }) => Promise.resolve(aggregate(DATA, from, to, timeframe, dropIncomplete)),
    },
};

/** What the chart would have been told. A jump hands out a fresh one, as the real one does. */
class FakeProvider {
    timeframe = '5';
    cutoff = 0;
    constructor(timeframe: string, clock: number) {
        this.retime(timeframe, clock);
    }
    retime(timeframe: string, clock: number): void {
        this.timeframe = timeframe;
        this.cutoff = clock;
    }
    revealNext(): void {}
}

let previousWindow: unknown;
beforeAll(() => {
    previousWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { midori };
});
afterAll(() => {
    (globalThis as { window?: unknown }).window = previousWindow;
});

/** A session at `clock` on `timeframe`, able to go back. */
async function session(timeframe: string, clock: number) {
    const { bars } = await loadReplayWindow('TEST', timeframe, clock);
    const rechartedTo: number[] = [];
    const controller = new ReplayController({
        provider: new FakeProvider(timeframe, clock) as unknown as ReplayProvider,
        symbol: 'TEST',
        timeframe,
        bars,
        startIndex: barIndexAt(bars, clock - 1),
        balance: 10_000,
        rechart: (tf, at) => {
            rechartedTo.push(at);
            return Promise.resolve(new FakeProvider(tf, at) as unknown as ReplayProvider);
        },
    });
    return { controller, rechartedTo };
}

/** The figures that would differ if anything after the jump had survived. */
function account(controller: ReplayController) {
    const { broker } = controller.session;
    return {
        clock: controller.session.clock,
        balance: Number(broker.balance.toFixed(6)),
        equity: Number(broker.equity.toFixed(6)),
        trades: broker.trades.map((t) => Number((t as { netPnl: number }).netPnl.toFixed(6))),
        open: broker.positions.map((p) => ({ size: p.size, entry: p.entryPrice })),
        pending: broker.pending.length,
        maxDrawdown: Number((controller.result().stats.maxDrawdown as number).toFixed(6)),
    };
}

const T0 = START + 6 * HOUR;

describe('going back to a candle', () => {
    it('leaves the account exactly as it was when that candle appeared', async () => {
        const { controller } = await session('5', T0);
        controller.skip(3);
        controller.order({ side: 'buy', type: 'market', size: 2, bracket: { takeProfit: controller.price() + 2, stopLoss: controller.price() - 2 } });
        controller.skip(40);                       // the bracket gets decided somewhere in here
        controller.skip(5);
        const candle = controller.session.bar.time; // the candle to come back to
        controller.skip(4);
        controller.sell({ size: 1 });               // after it — must vanish
        controller.skip(20);
        controller.close();

        await controller.jumpTo(candle);

        // The same session, played to that candle and no further.
        const { controller: reference } = await session('5', T0);
        reference.skip(3);
        reference.order({ side: 'buy', type: 'market', size: 2, bracket: { takeProfit: reference.price() + 2, stopLoss: reference.price() - 2 } });
        reference.skip(45);

        // The bracket was decided by the market before the candle — so the rebuild had to
        // re-play a fill no click made, not merely re-send the clicks.
        expect(reference.session.broker.trades.length).toBeGreaterThan(0);
        expect(account(controller)).toEqual(account(reference));
        expect(controller.session.bar.time).toBe(candle);
    });

    it('opens again a position that was open at that candle and closed after it', async () => {
        const { controller } = await session('5', T0);
        controller.skip(2);
        controller.buy({ size: 1 });
        controller.skip(6);
        const candle = controller.session.bar.time;
        controller.skip(3);
        controller.closeOne(controller.session.broker.positions[0]!.id);
        expect(controller.session.broker.positions).toHaveLength(0);

        await controller.jumpTo(candle);

        expect(controller.session.broker.positions).toHaveLength(1);
        expect(controller.session.broker.trades).toHaveLength(0);
    });

    it('keeps what was done by id before the candle, although the ids are handed out again', async () => {
        const { controller } = await session('5', T0);
        controller.skip(2);
        controller.buy({ size: 1 });
        controller.buy({ size: 1 });
        controller.skip(1);
        // The SECOND position closed by id, a resting order placed and then moved by id.
        controller.closeOne(controller.session.broker.positions[1]!.id);
        const resting = controller.order({ side: 'buy', type: 'limit', size: 1, limitPrice: 80 });
        controller.modifyOrder(resting.id, { limitPrice: 81 });
        controller.skip(2);
        const candle = controller.session.bar.time;
        controller.skip(2);
        controller.cancelOrder(resting.id);

        await controller.jumpTo(candle);

        const { broker } = controller.session;
        expect(broker.positions).toHaveLength(1);
        expect(broker.trades).toHaveLength(1);
        // The order is back, where it had been moved to — the cancel was after the candle.
        expect(broker.pending.map((o) => o.limitPrice)).toEqual([81]);
    });

    it('plays a stretch on the timeframe it was played on, across a timeframe change', async () => {
        const { controller } = await session('60', T0);
        controller.order({ side: 'buy', type: 'market', size: 1, bracket: { takeProfit: controller.price() + 3 } });
        controller.skip(2);
        await controller.retime('5');
        controller.skip(6);
        const candle = controller.session.bar.time;
        controller.skip(6);
        controller.sell({ size: 1 });

        await controller.jumpTo(candle);

        const { controller: reference } = await session('60', T0);
        reference.order({ side: 'buy', type: 'market', size: 1, bracket: { takeProfit: reference.price() + 3 } });
        reference.skip(2);
        await reference.retime('5');
        reference.skip(6);

        expect(account(controller)).toEqual(account(reference));
        expect(controller.timeframe).toBe('5');
    });

    it('can go back to a candle before a timeframe change, and land on the chart on screen', async () => {
        const { controller, rechartedTo } = await session('60', T0);
        controller.buy({ size: 1 });
        controller.skip(3);
        await controller.retime('5');
        controller.skip(12);
        controller.close();

        // A five-minute candle inside the stretch that was played on the hourly chart.
        const candle = T0 + HOUR + 20 * MINUTE;
        await controller.jumpTo(candle);

        expect(controller.session.clock).toBe(candle + 5 * MINUTE);
        expect(controller.timeframe).toBe('5');
        expect(controller.session.stepMs).toBe(5 * MINUTE);
        expect(controller.session.broker.positions).toHaveLength(1);
        expect(controller.session.broker.trades).toHaveLength(0);
        expect(rechartedTo).toEqual([candle + 5 * MINUTE]);
    });

    it('undoes what was done on the candle it is standing on', async () => {
        const { controller } = await session('5', T0);
        controller.skip(4);
        const candle = controller.session.bar.time;
        controller.buy({ size: 3 });

        await controller.jumpTo(candle);

        expect(controller.session.broker.positions).toHaveLength(0);
        expect(controller.session.clock).toBe(candle + 5 * MINUTE);
    });

    it('can go back more than once, and again after carrying on', async () => {
        const { controller } = await session('5', T0);
        controller.skip(2);
        controller.buy({ size: 1 });
        controller.skip(10);
        const first = controller.session.bar.time;
        controller.skip(10);
        controller.close();

        await controller.jumpTo(first);
        controller.skip(3);
        controller.close();          // the redo: out earlier this time
        controller.skip(5);
        const second = controller.session.bar.time;
        controller.skip(5);
        controller.buy({ size: 5 });

        await controller.jumpTo(second);

        const { controller: reference } = await session('5', T0);
        reference.skip(2);
        reference.buy({ size: 1 });
        reference.skip(13);
        reference.close();
        reference.skip(5);

        expect(account(controller)).toEqual(account(reference));
    });

    it('refuses a candle that has not been played, and one where nothing was done', async () => {
        const { controller } = await session('5', T0);
        controller.skip(4);
        const here = controller.session.bar.time;
        await expect(controller.jumpTo(here + 5 * MINUTE)).rejects.toThrow(/not been played/);
        await expect(controller.jumpTo(here)).rejects.toThrow(/Nothing has been done on this candle/);
    });

    it('refuses to go back before the session began', async () => {
        const { controller } = await session('5', T0);
        controller.skip(4);
        controller.buy({ size: 1 });
        await expect(controller.jumpTo(T0 - HOUR)).rejects.toThrow(/cannot go back before/);
        // And refusing changed nothing.
        expect(controller.session.broker.positions).toHaveLength(1);
    });

    it('leaves the session where it was when the bars no longer line up', async () => {
        const { controller } = await session('5', T0);
        controller.skip(4);
        controller.buy({ size: 1 });
        controller.skip(4);
        const candle = controller.session.bar.time;
        controller.skip(4);
        const before = account(controller);

        // The data "changed on disk": the window comes back a minute out.
        const journal = (controller as unknown as { journal: ReplayJournal }).journal;
        const shifted = {
            loadWindow: async (tf: string, at: number) => {
                const w = await loadReplayWindow('TEST', tf, at);
                return { ...w, bars: w.bars.map((b) => ({ ...b, time: b.time + MINUTE })) };
            },
        };
        await expect(rebuildSession(journal, { clock: candle + 5 * MINUTE, timeframe: '5' }, shifted))
            .rejects.toThrow();
        expect(account(controller)).toEqual(before);
    });
});

describe('a parked session', () => {
    it('can still go back to a candle from before it was put down', async () => {
        const { controller } = await session('5', T0);
        controller.skip(2);
        controller.buy({ size: 1 });
        controller.skip(6);
        const candle = controller.session.bar.time;
        controller.skip(6);
        controller.close();

        // What saveSession writes, and what resumeReplay reads back.
        const snapshot = JSON.parse(JSON.stringify(controller.session.snapshot()));
        const record = JSON.parse(JSON.stringify((controller as unknown as { journal: ReplayJournal }).journal.toRecord()));
        const clock = controller.session.clock;
        const { bars, forming } = await loadReplayWindow('TEST', '5', clock);
        const resumed = new ReplayController({
            provider: new FakeProvider('5', clock) as unknown as ReplayProvider,
            symbol: 'TEST',
            timeframe: '5',
            bars,
            startIndex: 0,
            forming,
            restoreFrom: snapshot,
            journal: record,
            rechart: (tf, at) => Promise.resolve(new FakeProvider(tf, at) as unknown as ReplayProvider),
        });
        expect(resumed.session.broker.trades).toHaveLength(1);

        await resumed.jumpTo(candle);

        expect(resumed.session.broker.positions).toHaveLength(1);
        expect(resumed.session.broker.trades).toHaveLength(0);
    });

    it('refuses a journal that is not one', () => {
        expect(() => ReplayJournal.fromRecord({ version: 1 })).toThrow(/not a replay journal/);
    });
});
