// A paper account against a feed that is still arriving.
//
// The rule the whole class exists for: every price is offered to the book exactly
// once. A streaming feed re-sends the same forming bar on every tick, and an
// account that took each of those at face value would fill an order on a spike
// that had already been and gone — which is look-ahead pointing backwards, and
// the one way a paper account flatters itself without anybody noticing.
//
// Run against the real Broker rather than a stub of it: the thing under test is
// which PRICES reach the book, and a fake book would answer that question itself.
import { describe, expect, it } from 'vitest';

import { LiveSession } from '../shared/engine/liveSession.js';
import type { LiveBar } from '../shared/engine/liveSession.js';

const T0 = Date.UTC(2024, 0, 1);
const MINUTE = 60_000;

function bar(over: Partial<LiveBar> & { close: number }): LiveBar {
    const { close } = over;
    return {
        time: T0,
        open: close,
        high: Math.max(over.high ?? close, close),
        low: Math.min(over.low ?? close, close),
        volume: 0,
        ...over,
    };
}

/** A session with costs off, so a fill lands on the price and nothing else. */
function session(balance = 10_000): LiveSession {
    return new LiveSession({
        balance,
        costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 },
    });
}

describe('LiveSession — playing a feed into an account', () => {
    it('marks on the first update instead of filling on it', () => {
        const s = session();
        // A resting order placed before the account has a price at all.
        s.broker.time = T0;
        s.broker.lastPrice = 100;
        s.order({ side: 'buy', type: 'limit', size: 1, limitPrice: 95 });
        s.barTime = null; // pretend the feed has not spoken yet
        s.seenHigh = null;
        s.seenLow = null;

        const step = s.onBar(bar({ close: 100, high: 120, low: 90 }));

        expect(step).toBeNull();
        expect(s.broker.pending).toHaveLength(1); // the bar's low never reached the book
        expect(s.price).toBe(100);
    });

    it('plays only the ground covered since the last update', () => {
        const s = session();
        s.onBar(bar({ close: 100, high: 100, low: 100 })); // first update: marks

        const step = s.onBar(bar({ close: 104, high: 105, low: 99 }));

        expect(step).toEqual({ time: T0, open: 100, high: 105, low: 99, close: 104 });
    });

    it('does not offer the same extreme twice', () => {
        const s = session();
        s.onBar(bar({ close: 100, high: 100, low: 100 }));
        // A spike down to 90 and back — while nothing was in the book.
        s.onBar(bar({ close: 100, high: 100, low: 90 }));

        // Only NOW does a buy limit go in at the price the spike reached.
        s.order({ side: 'buy', type: 'limit', size: 1, limitPrice: 92 });
        // The feed re-sends the same forming bar, still carrying that low.
        s.onBar(bar({ close: 101, high: 101, low: 90 }));

        expect(s.broker.pending).toHaveLength(1);
        expect(s.broker.positions).toHaveLength(0);
    });

    it('fills a resting order on the part of the bar that IS new', () => {
        const s = session();
        s.onBar(bar({ close: 100, high: 100, low: 100 }));
        s.order({ side: 'buy', type: 'limit', size: 1, limitPrice: 95 });

        s.onBar(bar({ close: 96, high: 100, low: 94 }));

        expect(s.broker.pending).toHaveLength(0);
        expect(s.broker.positions).toHaveLength(1);
        expect(s.broker.positions[0]!.size).toBe(1);
    });

    it('takes a stop out intrabar, on the tick that reaches it', () => {
        const s = session();
        s.onBar(bar({ close: 100, high: 100, low: 100 }));
        s.buy({ size: 1, stopLoss: 98 });
        expect(s.broker.positions).toHaveLength(1);

        s.onBar(bar({ close: 99, high: 100, low: 99 }));
        expect(s.broker.positions).toHaveLength(1); // not there yet

        s.onBar(bar({ close: 97.5, high: 99, low: 97.5 }));
        expect(s.broker.positions).toHaveLength(0);
        expect(s.broker.trades).toHaveLength(1);
    });

    it('bridges a gap between one bar and the next', () => {
        const s = session();
        s.onBar(bar({ close: 100, high: 100, low: 100 }));
        s.order({ side: 'sell', type: 'stop', size: 1, stopPrice: 97 });

        // The next bar opens below the resting stop — the market went through it.
        const step = s.onBar(bar({ time: T0 + MINUTE, close: 94, high: 95, low: 93 }));

        expect(step!.open).toBe(100); // where the account stood, not the bar's own open
        expect(s.broker.positions).toHaveLength(1);
        expect(s.broker.positions[0]!.size).toBe(-1);
    });

    it('ignores an update for a bar it has already left behind', () => {
        const s = session();
        s.onBar(bar({ close: 100, high: 100, low: 100 }));
        s.onBar(bar({ time: T0 + MINUTE, close: 101, high: 101, low: 101 }));

        expect(s.onBar(bar({ time: T0, close: 80, high: 100, low: 80 }))).toBeNull();
        expect(s.price).toBe(101);
    });
});

describe('LiveSession — the gap while nobody was watching', () => {
    it('fills a stop where the market actually went through it', () => {
        const s = session();
        s.onBar(bar({ close: 100, high: 100, low: 100 }));
        s.buy({ size: 1, stopLoss: 98 });

        const played = s.catchUp([
            bar({ time: T0 + MINUTE, close: 99.5, high: 100.5, low: 99 }),
            bar({ time: T0 + 2 * MINUTE, close: 96, high: 99.5, low: 95 }),
            bar({ time: T0 + 3 * MINUTE, close: 97, high: 97.5, low: 95.5 }),
        ]);

        expect(played).toBe(3);
        expect(s.broker.positions).toHaveLength(0);
        expect(s.broker.trades).toHaveLength(1);
        expect((s.broker.trades[0] as { exitPrice: number }).exitPrice).toBe(98);
    });

    it('skips bars the account has already stood past', () => {
        const s = session();
        s.onBar(bar({ time: T0 + MINUTE, close: 100, high: 100, low: 100 }));

        const played = s.catchUp([
            bar({ time: T0, close: 50, high: 100, low: 50 }),
            bar({ time: T0 + MINUTE, close: 60, high: 100, low: 60 }),
            bar({ time: T0 + 2 * MINUTE, close: 101, high: 101, low: 100 }),
        ]);

        expect(played).toBe(1);
        expect(s.price).toBe(101);
    });
});

describe('LiveSession — putting the account down and picking it up', () => {
    it('comes back with the position, the book and where it stood', () => {
        const s = session();
        s.onBar(bar({ close: 100, high: 100, low: 100 }));
        s.buy({ size: 2, stopLoss: 95 });
        s.order({ side: 'sell', type: 'limit', size: 1, limitPrice: 110 });
        s.onBar(bar({ close: 102, high: 102, low: 100 }));

        const back = LiveSession.restore(JSON.parse(JSON.stringify(s.snapshot())));

        expect(back.broker.positions).toHaveLength(1);
        expect(back.broker.positions[0]!.size).toBe(2);
        expect(back.broker.positions[0]!.stopLoss).toBe(95);
        // The stop rides along as a reduce-only leg beside the resting sell limit.
        expect(back.broker.pending).toHaveLength(s.broker.pending.length);
        expect(back.barTime).toBe(s.barTime);
        expect(back.seenHigh).toBe(102);
        expect(back.price).toBe(102);
    });

    it('is idle only while nothing is open and nothing is waiting', () => {
        const s = session();
        s.onBar(bar({ close: 100, high: 100, low: 100 }));
        expect(s.isIdle).toBe(true);

        s.order({ side: 'buy', type: 'limit', size: 1, limitPrice: 90 });
        expect(s.isIdle).toBe(false);

        s.cancelAll();
        expect(s.isIdle).toBe(true);
    });
});
