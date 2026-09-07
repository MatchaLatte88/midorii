import { describe, it, expect } from 'vitest';
import { accountFigures, type AccountSource } from '../app/renderer/replay/accountFigures';

/**
 * A stand-in for the Broker, holding only what the readout reads. `exitResult` is the one
 * piece of real behaviour worth faking: it is negative while a stop is protection and positive
 * once the stop sits past break-even, which is exactly the distinction the risk figure exists
 * to make.
 */
function broker(over: Partial<AccountSource> = {}): AccountSource {
    return {
        balance: 10_000,
        equity: 10_000,
        unrealizedPnl: 0,
        netSize: 0,
        initialBalance: 10_000,
        positions: [],
        exitResult: () => 0,
        ...over,
    };
}

describe('replay account figures', () => {
    it('reports a flat account without inventing figures for what is not open', () => {
        const f = accountFigures(broker());
        expect(f).toMatchObject({ equity: 10_000, cash: 10_000, returnPct: 0, netSize: 0, openPositions: 0 });
        // Not 0: an account holding nothing is not breaking even on it.
        expect(f.open).toBeNull();
        expect(f.risk).toBeNull();
        expect(f.unprotected).toBe(0);
    });

    it('measures the return against the balance the session started with', () => {
        expect(accountFigures(broker({ equity: 10_756 })).returnPct).toBeCloseTo(0.0756, 10);
        expect(accountFigures(broker({ equity: 9_000 })).returnPct).toBeCloseTo(-0.1, 10);
        // A snapshot off disk could carry anything; a division by zero is not a return.
        expect(accountFigures(broker({ initialBalance: 0, equity: 500 })).returnPct).toBe(0);
    });

    it('shows open profit only while something is open', () => {
        const flat = accountFigures(broker({ unrealizedPnl: 42 }));
        expect(flat.open).toBeNull(); // stale unrealised with no position is not a figure
        const live = accountFigures(broker({
            unrealizedPnl: 288,
            netSize: 0.3,
            positions: [{ stopLoss: 77_900 }],
            exitResult: () => -150,
        }));
        expect(live).toMatchObject({ open: 288, netSize: 0.3, openPositions: 1 });
    });

    it('sums what every stop would cost, as a cost', () => {
        const f = accountFigures(broker({
            positions: [{ stopLoss: 1 }, { stopLoss: 2 }],
            // Each stop, if it filled, would leave the account 150 and 90 worse off.
            exitResult: (p) => (p.stopLoss === 1 ? -150 : -90),
        }));
        expect(f.risk).toBe(240);
        expect(f.unprotected).toBe(0);
    });

    it('lets a stop past break-even pay into the risk rather than add to it', () => {
        // A stop trailed into profit closes the trade for a gain — it risks nothing.
        const f = accountFigures(broker({ positions: [{ stopLoss: 1 }], exitResult: () => 120 }));
        expect(f.risk).toBe(-120);
    });

    it('counts a position with no stop instead of folding a zero into the sum', () => {
        const f = accountFigures(broker({
            positions: [{ stopLoss: 1 }, { stopLoss: null }],
            exitResult: () => -150,
        }));
        expect(f.risk).toBe(150); // what the ONE stop would cost
        expect(f.unprotected).toBe(1);
    });

    it('answers null for risk when nothing open carries a stop at all', () => {
        // The dangerous case: reporting 0.00 here would read as the safest account on screen.
        const f = accountFigures(broker({ positions: [{ stopLoss: null }, { stopLoss: null }] }));
        expect(f.risk).toBeNull();
        expect(f.unprotected).toBe(2);
    });

    it('keeps cash and equity apart while a position is open', () => {
        const f = accountFigures(broker({
            balance: 10_000, equity: 10_288, unrealizedPnl: 288, positions: [{ stopLoss: null }],
        }));
        expect(f.cash).toBe(10_000);
        expect(f.equity).toBe(10_288);
    });
});
