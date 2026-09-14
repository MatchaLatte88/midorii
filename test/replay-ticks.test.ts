// Playing recorded prints and quotes inside the bars of a replay.
//
// What must hold: the candle under the playhead is only ever what has printed, every order is
// matched against the prints the moment they happen and never twice, and the account is the
// same however the stretch is cut into pieces — which is what lets a tick replay be rebuilt to
// any instant.
import { beforeEach, describe, expect, it } from 'vitest';
import { ReplaySession } from '../shared/engine/replaySession.js';
import { resetOrderIds } from '../shared/engine/broker.js';

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 8, 11, 14, 0);

type Event = [number, number, number | null, number | null, number | null];

/** Ten one-minute candles at 100, the last visible one at index 4. */
function session(): ReplaySession {
    const bars = Array.from({ length: 10 }, (_, i) => ({
        time: T0 + i * MINUTE, open: 100, high: 101, low: 99, close: 100, volume: 10,
    }));
    return new ReplaySession({ bars, startIndex: 4, balance: 10_000, costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 } });
}

const at = (minute: number, second: number): number => T0 + minute * MINUTE + second * 1000;
const print = (t: number, price: number, volume = 1, side = 0): Event => [t, 1, price, volume, side];
const quote = (t: number, bid: number, ask: number): Event => [t, 2, bid, ask, null];

beforeEach(() => resetOrderIds());

describe('the candle under the playhead', () => {
    it('is built from the prints so far, and nothing after them', () => {
        const s = session();
        const events = [print(at(5, 5), 100.5, 2), print(at(5, 20), 99.25, 1), print(at(5, 40), 103, 5)];
        s.advanceTicks(events, at(5, 30));

        expect(s.index).toBe(5);
        expect(s.bar).toMatchObject({ time: at(5, 0), open: 100.5, high: 100.5, low: 99.25, close: 99.25, volume: 3 });
        expect(s.clock).toBe(at(5, 30));
        expect(s.broker.lastPrice).toBe(99.25);
    });

    it('becomes the whole candle once its minute is over', () => {
        const s = session();
        const { closed } = s.advanceTicks([print(at(5, 5), 100.5)], at(6, 0));
        expect(closed.map((b) => b.time)).toEqual([at(5, 0)]);
        expect(s.forming).toBeNull();
        expect(s.bar).toMatchObject({ time: at(5, 0), high: 101, low: 99 });
        expect(s.clock).toBe(at(6, 0));
    });

    it('steps a minute nothing printed in as a whole bar', () => {
        const s = session();
        // A resting buy limit at 99 — the unrecorded minute's low reaches it.
        s.order({ side: 'buy', type: 'limit', size: 1, limitPrice: 99 });
        s.advanceTicks([], at(6, 0));
        expect(s.broker.positions).toHaveLength(1);
    });
});

describe('orders against the prints', () => {
    it('fills a resting limit where it rests when the market goes through it, not at the better print', () => {
        const s = session();
        s.advanceTicks([print(at(5, 1), 100.25)], at(5, 2));
        s.order({ side: 'buy', type: 'limit', size: 1, limitPrice: 100 });
        s.advanceTicks([print(at(5, 3), 99.75)], at(5, 4));
        expect(s.broker.positions[0]?.entryPrice).toBe(100);
    });

    it('does not fill before the print that reaches it has happened', () => {
        const s = session();
        s.advanceTicks([print(at(5, 1), 100.25)], at(5, 2));
        s.order({ side: 'buy', type: 'limit', size: 1, limitPrice: 100 });
        const events = [print(at(5, 3), 100.25), print(at(5, 10), 100)];
        s.advanceTicks(events, at(5, 5));
        expect(s.broker.positions).toHaveLength(0);
        s.advanceTicks(events, at(5, 11));
        expect(s.broker.positions).toHaveLength(1);
    });

    it('fills a market order at the ask while the quote is fresh, and at the last print once it is not', () => {
        const s = session();
        s.advanceTicks([print(at(5, 1), 100), quote(at(5, 1), 99.75, 100.25)], at(5, 2));
        s.buy({ size: 1 });
        expect(s.broker.positions[0]?.entryPrice).toBe(100.25);
        s.close();

        s.advanceTicks([print(at(5, 20), 100.5)], at(5, 21));   // the quote is 19 seconds old now
        s.buy({ size: 1 });
        expect(s.broker.positions[0]?.entryPrice).toBe(100.5);
    });

    it('does not match a candle built from prints a second time when it finishes', () => {
        const s = session();
        s.advanceTicks([print(at(5, 1), 100), print(at(5, 2), 99.1)], at(5, 3));
        // Below the market after the dip: the later prints stay above it, the finished candle's low (99) does not.
        s.order({ side: 'buy', type: 'limit', size: 1, limitPrice: 99 });
        s.advanceTicks([print(at(5, 30), 100)], at(6, 0));
        expect(s.forming).toBeNull();
        expect(s.broker.positions).toHaveLength(0);
    });
});

describe('the account, however the stretch is cut', () => {
    const events: Event[] = [
        quote(at(5, 0), 99.75, 100.25),
        print(at(5, 2), 100.25), print(at(5, 9), 99.5), print(at(5, 31), 98.75),
        quote(at(5, 40), 98.5, 99),
        print(at(5, 59), 99.75), print(at(6, 1), 101), quote(at(6, 1), 100.75, 101.25), print(at(6, 1), 101.25),
        print(at(6, 45), 102.25),
        print(at(8, 12), 100), print(at(8, 50), 97),
    ];

    function played(cuts: number[]) {
        resetOrderIds();
        const s = session();
        s.order({ side: 'buy', type: 'limit', size: 2, limitPrice: 99, bracket: { takeProfit: 102, stopLoss: 97.5 } });
        for (const cut of cuts) s.advanceTicks(events, cut);
        return {
            clock: s.clock,
            index: s.index,
            bar: s.bar,
            trades: s.broker.trades,
            balance: s.broker.balance,
            curve: s.equityCurve,
        };
    }

    it('is the same played at once as played in pieces', () => {
        const whole = played([at(9, 0)]);
        expect(whole.trades.length).toBeGreaterThan(0);   // the bracket was decided in here
        expect(played([at(5, 10), at(5, 45), at(6, 0), at(7, 30), at(9, 0)])).toEqual(whole);
        expect(played([at(5, 3), at(5, 3) + 1, at(8, 12) + 1, at(9, 0)])).toEqual(whole);
        // Cut exactly between events that share a millisecond, and just after them.
        expect(played([at(6, 1), at(6, 1) + 1, at(9, 0)])).toEqual(whole);
    });
});
