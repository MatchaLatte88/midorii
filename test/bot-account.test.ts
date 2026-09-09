// The bridge that makes a paper engine and a real venue look the same to a running strategy.
// The rules under test: a live order gets an id the bot issued and resolves to the venue's
// own only once the venue has one, an id that resolves to nothing answers honestly rather
// than cancelling something else, and neither adapter ever invents a figure.
// See app/renderer/bot/botAccount.ts.
import { describe, it, expect, vi } from 'vitest';
import { liveAccount, paperAccount } from '../app/renderer/bot/botAccount';
import type { CapitalController } from '../app/renderer/trading/CapitalController';
import type { PaperController } from '../app/renderer/trading/PaperController';
import type { OrderSpec } from '../shared/engine/broker.js';

/** A stand-in for the venue client, holding whatever book the test sets. */
function fakeCapital(book: Array<{ id: number; side: 'buy' | 'sell'; price: number; size: number; kind: 'limit' | 'stop' }> = []) {
    const sent: OrderSpec[] = [];
    const cancelled: number[] = [];
    const closed: number[] = [];
    const controller = {
        equity: () => 5_000,
        price: () => 1.09,
        quote: () => ({ bid: 1.0899, ask: 1.0901 }),
        positions: () => [{ id: 1, size: 1000, entryPrice: 1.088 }],
        orders: () => book,
        order: (spec: OrderSpec) => { sent.push(spec); },
        cancelOrder: (id: number) => { cancelled.push(id); },
        cancelAll: () => { cancelled.push(-1); },
        closeOne: (id: number) => { closed.push(id); },
    };
    return { controller: controller as unknown as CapitalController, sent, cancelled, closed, book };
}

describe('a live account', () => {
    it('reports the venue’s own figures and never computes one', () => {
        const { controller } = fakeCapital();
        const account = liveAccount(controller);
        expect(account.equity()).toBe(5_000);
        // The venue states one figure and does not split settled from unrealized; inventing
        // the split would be a number nobody stated.
        expect(account.balance()).toBe(5_000);
        expect(account.quote()).toEqual({ bid: 1.0899, ask: 1.0901 });
    });

    it('hands out its own id for a resting order, because the venue has none yet', () => {
        const venue = fakeCapital();
        const account = liveAccount(venue.controller);

        const first = account.order({ side: 'buy', type: 'stop', size: 1000, stopPrice: 1.095 });
        const second = account.order({ side: 'sell', type: 'limit', size: 1000, limitPrice: 1.085 });

        expect(venue.sent).toHaveLength(2);
        expect(first.id).toBe(1);
        expect(second.id).toBe(2);
    });

    it('resolves that id to the venue’s order once the book has one', () => {
        const venue = fakeCapital();
        const account = liveAccount(venue.controller);
        const order = account.order({ side: 'buy', type: 'stop', size: 1000, stopPrice: 1.095 });

        // The venue confirms it, under its own number.
        venue.book.push({ id: 42, side: 'buy', price: 1.095, size: 1000, kind: 'stop' });

        expect(account.cancel(order.id)).toBe(true);
        expect(venue.cancelled).toEqual([42]);
    });

    it('tolerates the venue storing the level slightly differently', () => {
        const venue = fakeCapital();
        const account = liveAccount(venue.controller);
        const order = account.order({ side: 'buy', type: 'stop', size: 1000, stopPrice: 1.09500 });
        venue.book.push({ id: 42, side: 'buy', price: 1.0950001, size: 1000, kind: 'stop' });

        expect(account.cancel(order.id)).toBe(true);
    });

    it('answers false rather than cancelling something else', () => {
        const venue = fakeCapital();
        const account = liveAccount(venue.controller);
        const order = account.order({ side: 'buy', type: 'stop', size: 1000, stopPrice: 1.095 });

        // A different order entirely — wrong side, wrong level.
        venue.book.push({ id: 42, side: 'sell', price: 1.05, size: 1000, kind: 'limit' });

        expect(account.cancel(order.id)).toBe(false);
        expect(venue.cancelled).toEqual([]);
    });

    it('answers false for an order that filled before anybody cancelled it', () => {
        const venue = fakeCapital();
        const account = liveAccount(venue.controller);
        const order = account.order({ side: 'buy', type: 'stop', size: 1000, stopPrice: 1.095 });
        // Never appeared on the book — it filled on arrival.
        expect(account.cancel(order.id)).toBe(false);
    });

    it('remembers nothing about a market order, which has nothing to cancel', () => {
        const venue = fakeCapital();
        const account = liveAccount(venue.controller);
        const order = account.order({ side: 'buy', type: 'market', size: 1000 });
        expect(account.cancel(order.id)).toBe(false);
        expect(venue.cancelled).toEqual([]);
    });

    it('reports the venue’s book in the shape a strategy reads', () => {
        const venue = fakeCapital([{ id: 7, side: 'buy', price: 1.1, size: 500, kind: 'limit' }]);
        const account = liveAccount(venue.controller);
        expect(account.pending()).toEqual([
            { id: 7, side: 'buy', size: 500, type: 'limit', limitPrice: 1.1, stopPrice: null },
        ]);
    });

    it('closes every position it holds, one at a time — the venue has no "close all"', () => {
        const venue = fakeCapital();
        const account = liveAccount(venue.controller);
        account.close();
        expect(venue.closed).toEqual([1]);
    });

    it('cancels and closes on a flatten', () => {
        const venue = fakeCapital();
        const account = liveAccount(venue.controller);
        account.flatten();
        expect(venue.cancelled).toEqual([-1]);
        expect(venue.closed).toEqual([1]);
    });
});

describe('a paper account', () => {
    it('passes the engine’s own ids straight through', () => {
        const order = vi.fn(() => ({ id: 17 }));
        const controller = {
            equity: () => 10_000,
            price: () => 100,
            broker: { balance: 9_000, positions: [], pending: [] },
            order,
            cancelOrder: vi.fn(() => true),
            cancelAll: vi.fn(),
            flatten: vi.fn(),
            close: vi.fn(),
        } as unknown as PaperController;

        const account = paperAccount(controller);
        expect(account.order({ side: 'buy', size: 1 }).id).toBe(17);
        expect(account.balance()).toBe(9_000);
        // A paper account is marked from the chart's candles, which are one price.
        expect(account.quote()).toBeNull();
    });

    it('reports how many orders a cancel-all actually took off', () => {
        const pending = [{ id: 1 }, { id: 2 }];
        const controller = {
            equity: () => 10_000,
            price: () => 100,
            broker: { balance: 9_000, positions: [], get pending() { return pending; } },
            cancelAll: () => { pending.length = 0; },
        } as unknown as PaperController;

        expect(paperAccount(controller).cancelAll()).toBe(2);
    });
});
