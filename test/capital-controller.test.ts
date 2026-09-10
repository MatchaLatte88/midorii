// The live account. Everything here is about the gap between "the app thinks" and "the venue
// says" — a gap a paper account does not have, because there the app IS the venue. The rules
// under test: nothing appears on screen that the venue has not confirmed, a refusal always
// reaches the person who caused it, a size is made acceptable before it is sent, and a lost
// connection is never drawn as a closed position.
// See app/renderer/trading/CapitalController.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CapitalController } from '../app/renderer/trading/CapitalController';
import type { LiveTradeRecord } from '../app/renderer/trading/CapitalController';
import type {
    MidoriBotCapitalOwnership,
    MidoriCapitalConfirmation,
    MidoriCapitalPosition,
    MidoriCapitalWorkingOrder,
} from '../app/renderer/midori';

/** One open position as GET /positions reports it. */
function venuePosition(over: Partial<MidoriCapitalPosition['position']> = {}, epic = 'EURUSD'): MidoriCapitalPosition {
    return {
        position: {
            dealId: 'deal-1',
            dealReference: 'p_deal-1',
            size: 1000,
            direction: 'BUY',
            level: 1.09241,
            currency: 'USD',
            contractSize: 1,
            createdDateUTC: '2026-09-08T10:00:00',
            stopLevel: null,
            profitLevel: null,
            upl: 1.5,
            ...over,
        },
        market: { epic, instrumentName: 'EUR/USD', marketStatus: 'TRADEABLE', bid: 1.0924, offer: 1.0925 },
    };
}

/** One resting order as GET /workingorders reports it. */
function venueOrder(over: Partial<MidoriCapitalWorkingOrder['workingOrderData']> = {}, epic = 'EURUSD'): MidoriCapitalWorkingOrder {
    return {
        workingOrderData: {
            dealId: 'order-1',
            direction: 'BUY',
            epic,
            orderSize: 1000,
            orderLevel: 1.085,
            orderType: 'LIMIT',
            createdDateUTC: '2026-09-08T10:00:00',
            currencyCode: 'USD',
            ...over,
        },
        marketData: { epic, instrumentName: 'EUR/USD', marketStatus: 'TRADEABLE' },
    };
}

const accepted = (over: Partial<MidoriCapitalConfirmation> = {}): MidoriCapitalConfirmation => ({
    accepted: true, dealId: 'deal-1', dealReference: 'o_1', status: 'OPEN',
    reason: null, level: 1.0925, size: 1000, direction: 'BUY', ...over,
});

const refused = (reason: string): MidoriCapitalConfirmation => ({
    accepted: false, dealId: null, dealReference: 'o_1', status: null,
    reason, level: null, size: null, direction: null,
});

/** The preload bridge, faked, with every call recorded. */
function stubVenue(over: Record<string, unknown> = {}) {
    const calls: Array<{ name: string; arg: unknown }> = [];
    const record = (name: string, result: unknown) => (arg: unknown) => {
        calls.push({ name, arg });
        return typeof result === 'function' ? (result as (a: unknown) => unknown)(arg) : Promise.resolve(result);
    };
    const capital = {
        account: record('account', { accountId: '1', accountName: 'EUR', currency: 'EUR', balance: { balance: 10_000, deposit: 10_000, profitLoss: 25, available: 9_000 } }),
        positions: record('positions', []),
        openPosition: record('openPosition', accepted()),
        amendPosition: record('amendPosition', accepted({ status: 'AMENDED' })),
        closePosition: record('closePosition', accepted({ status: 'CLOSED' })),
        workingOrders: record('workingOrders', []),
        marketInfo: record('marketInfo', {
            instrument: { epic: 'EURUSD', name: 'EUR/USD', type: 'CURRENCIES', currency: 'USD', lotSize: 1 },
            snapshot: { marketStatus: 'TRADEABLE', bid: 1.0924, offer: 1.0926, decimalPlacesFactor: 5, scalingFactor: 1 },
        }),
        createOrder: record('createOrder', accepted()),
        amendOrder: record('amendOrder', accepted({ status: 'AMENDED' })),
        cancelOrder: record('cancelOrder', accepted({ status: 'DELETED' })),
        ...over,
    };
    (globalThis as { window?: unknown }).window = { midori: { capital } };
    return { calls, capital };
}

/** Let the controller's fire-and-forget work finish. */
const settle = async (): Promise<void> => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
};

/** A notify that records, for the messages a late answer produces. */
const notify = () => {
    const fn = vi.fn((_message: string, _kind: 'info' | 'error' | 'success') => {});
    return { fn, messages: (): string[] => fn.mock.calls.map((c) => String(c[0])) };
};

/** A notify for the cases where nothing is expected to be said. */
const noop = (): void => {};

const ownership = (over: Partial<MidoriBotCapitalOwnership> = {}): MidoriBotCapitalOwnership => ({
    initialized: true,
    positionDealIds: [],
    workingOrderDealIds: [],
    uncertain: false,
    ...over,
});

beforeEach(() => {
    delete (globalThis as { window?: unknown }).window;
});

describe('reading the venue back', () => {
    it('reports what the venue holds, not what was pressed', async () => {
        stubVenue({ positions: () => Promise.resolve([venuePosition()]) });
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        // Before asking, it claims nothing — a press has not made a position.
        expect(c.positions()).toEqual([]);
        c.refreshVisuals();
        await settle();
        expect(c.positions()).toHaveLength(1);
        expect(c.positions()[0]!.entryPrice).toBe(1.09241);
    });

    it('signs a short, which the venue expresses as a direction', async () => {
        stubVenue({ positions: () => Promise.resolve([venuePosition({ direction: 'SELL', size: 500 })]) });
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.refreshVisuals();
        await settle();
        // The chart reads long/short off the sign; the venue never sends a negative size.
        expect(c.positions()[0]!.size).toBe(-500);
    });

    it('keeps a position\'s number across reconciles', async () => {
        stubVenue({ positions: () => Promise.resolve([venuePosition()]) });
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.refreshVisuals();
        await settle();
        const first = c.positions()[0]!.id;
        c.refreshVisuals();
        await settle();
        // A line that changed identity under a drag would re-protect the wrong trade.
        expect(c.positions()[0]!.id).toBe(first);
    });

    it('ignores positions on other instruments', async () => {
        stubVenue({ positions: () => Promise.resolve([venuePosition({}, 'GOLD'), venuePosition({ dealId: 'd2' })]) });
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.refreshVisuals();
        await settle();
        expect(c.positions()).toHaveLength(1);
    });

    it('takes equity from the venue, never from a sum over positions', async () => {
        stubVenue({ positions: () => Promise.resolve([venuePosition()]) });
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.refreshVisuals();
        await settle();
        // Cash plus the venue's own open P&L — 10,000 + 25. Not 10,000 + upl.
        expect(c.equity()).toBe(10_025);
        expect(c.available()).toBe(9_000);
    });

    it('keeps the last known state when the venue cannot be reached', async () => {
        let fail = false;
        stubVenue({ positions: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve([venuePosition()])) });
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.refreshVisuals();
        await settle();
        expect(c.positions()).toHaveLength(1);

        fail = true;
        c.refreshVisuals();
        await settle();
        // A dropped connection is not a closed position, and drawing it as one is the more
        // alarming lie.
        expect(c.positions()).toHaveLength(1);
    });
});

describe('placing an order', () => {
    it('sends a market order as a direction and a positive size', async () => {
        const { calls } = stubVenue();
        const c = new CapitalController({ epic: 'eurusd', notify: noop });
        c.order({ side: 'sell', size: 1000 });
        await settle();
        const sent = calls.find((x) => x.name === 'openPosition')!.arg as Record<string, unknown>;
        expect(sent).toMatchObject({ epic: 'EURUSD', direction: 'SELL', size: 1000 });
    });

    it('sends protection with the order rather than after it', async () => {
        const { calls } = stubVenue();
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.order({ side: 'buy', size: 1000, bracket: { stopLoss: 1.09, takeProfit: 1.1 } });
        await settle();
        const sent = calls.find((x) => x.name === 'openPosition')!.arg as Record<string, unknown>;
        // Attaching it afterwards leaves the position unprotected for a whole round trip.
        expect(sent).toMatchObject({ stopLevel: 1.09, profitLevel: 1.1 });
        expect(calls.filter((x) => x.name === 'amendPosition')).toHaveLength(0);
    });

    it('sends a resting order to the book, not to the market', async () => {
        const { calls } = stubVenue();
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.order({ side: 'buy', type: 'limit', size: 1000, limitPrice: 1.05 });
        await settle();
        // Two different books at the venue, with different endpoints and different ids.
        expect(calls.some((x) => x.name === 'openPosition')).toBe(false);
        expect(calls.find((x) => x.name === 'createOrder')!.arg).toMatchObject({
            epic: 'EURUSD', direction: 'BUY', type: 'LIMIT', level: 1.05, size: 1000,
        });
    });

    it('puts a refusal in front of the person who caused it', async () => {
        const n = notify();
        stubVenue({ openPosition: () => Promise.resolve(refused('INSUFFICIENT_FUNDS')) });
        const c = new CapitalController({ epic: 'EURUSD', notify: n.fn });
        c.order({ side: 'buy', size: 1000 });
        await settle();
        const [message] = n.messages();
        expect(message).toContain('Buying 1000');
        expect(message).toContain('available margin');
        expect(n.fn.mock.calls[0]![1]).toBe('error');
    });

    it('reports a lost verdict as its own thing, not as a refusal', async () => {
        const n = notify();
        stubVenue({ openPosition: () => Promise.reject(new Error('did not say what became of o_1')) });
        const c = new CapitalController({ epic: 'EURUSD', notify: n.fn });
        c.order({ side: 'buy', size: 1000 });
        await settle();
        // Something may well be open. The message must not read as "nothing happened".
        expect(n.messages()[0]).toContain('did not say what became of');
    });

    it('says where it actually filled', async () => {
        const n = notify();
        stubVenue({ openPosition: () => Promise.resolve(accepted({ level: 1.09255 })) });
        const c = new CapitalController({ epic: 'EURUSD', notify: n.fn });
        c.order({ side: 'buy', size: 1000 });
        await settle();
        expect(n.messages()[0]).toContain('1.09255');
    });

    it('reads the venue again after every instruction', async () => {
        const { calls } = stubVenue();
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.order({ side: 'buy', size: 1000 });
        await settle();
        expect(calls.some((x) => x.name === 'positions')).toBe(true);
    });
});

describe('sizing for the venue', () => {
    const dealing = { minSize: 1000, sizeIncrement: 100, maxSize: 1_000_000,
        marginFactor: 3.33, marginFactorUnit: 'PERCENTAGE', minStopDistance: null, maxStopDistance: null, lotSize: 1 };

    it('rounds a risk-derived size onto the venue\'s grid', async () => {
        const { calls } = stubVenue();
        const c = new CapitalController({ epic: 'EURUSD', notify: noop, dealing });
        // What `positionSize` produces is never on a grid.
        c.order({ side: 'buy', size: 1234.567 });
        await settle();
        expect((calls.find((x) => x.name === 'openPosition')!.arg as { size: number }).size).toBe(1200);
    });

    it('refuses a size below the minimum instead of quietly raising it', () => {
        stubVenue();
        const c = new CapitalController({ epic: 'EURUSD', notify: noop, dealing });
        // Rounding up would send a bigger trade than the one that was sized against the risk.
        expect(() => c.order({ side: 'buy', size: 400 })).toThrow(/below the smallest deal/i);
    });

    it('refuses a size above the maximum', () => {
        stubVenue();
        const c = new CapitalController({ epic: 'EURUSD', notify: noop, dealing });
        expect(() => c.order({ side: 'buy', size: 2_000_000 })).toThrow(/largest deal/i);
    });

    it('sends the size untouched when the venue\'s rules are not known yet', async () => {
        const { calls } = stubVenue();
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.order({ side: 'buy', size: 1234.567 });
        await settle();
        // Unknown is not "no limit" — but inventing a grid would be worse than letting the
        // venue apply its own and say so.
        expect((calls.find((x) => x.name === 'openPosition')!.arg as { size: number }).size).toBe(1234.567);
    });
});

describe('changing an open position', () => {
    async function withPosition(over: Partial<MidoriCapitalPosition['position']> = {}) {
        const n = notify();
        const stub = stubVenue({ positions: () => Promise.resolve([venuePosition(over)]) });
        const c = new CapitalController({ epic: 'EURUSD', notify: n.fn });
        c.refreshVisuals();
        await settle();
        return { c, n, ...stub };
    }

    it('moves a stop on the position the chart names', async () => {
        const { c, calls } = await withPosition();
        c.protect({ stopLoss: 1.09 }, c.positions()[0]!.id);
        await settle();
        expect(calls.find((x) => x.name === 'amendPosition')!.arg).toEqual({ dealId: 'deal-1', stopLevel: 1.09, profitLevel: null });
    });

    it('carries the untouched level through rather than dropping it', async () => {
        const { c, calls } = await withPosition({ stopLevel: 1.08 });
        c.protect({ takeProfit: 1.1 }, c.positions()[0]!.id);
        await settle();
        /* `PUT /positions` REPLACES the protection set rather than patching it: a body that
         * names only the target is a body that takes the stop off. Found the hard way on a
         * demo account, where setting a target silently removed the stop that was already
         * there — so the stop has to be restated even though nothing asked to change it. */
        expect(calls.find((x) => x.name === 'amendPosition')!.arg).toEqual({ dealId: 'deal-1', stopLevel: 1.08, profitLevel: 1.1 });
    });

    it('takes a level off when it is explicitly cleared', async () => {
        const { c, calls } = await withPosition();
        c.protect({ stopLoss: null }, c.positions()[0]!.id);
        await settle();
        expect((calls.find((x) => x.name === 'amendPosition')!.arg as Record<string, unknown>).stopLevel).toBeNull();
    });

    it('closes by the venue\'s own id, not the chart\'s number', async () => {
        const { c, calls } = await withPosition();
        c.closeOne(c.positions()[0]!.id);
        await settle();
        expect(calls.find((x) => x.name === 'closePosition')!.arg).toBe('deal-1');
    });

    it('refuses to act on a position that is no longer there', async () => {
        const { c } = await withPosition();
        expect(() => c.closeOne(999)).toThrow(/no longer open/i);
        expect(() => c.protect({ stopLoss: 1.09 }, 999)).toThrow(/no longer open/i);
    });
});


describe('resting orders', () => {
    it('sends a stop order as STOP, at the price it waits at', async () => {
        const { calls } = stubVenue();
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.order({ side: 'buy', type: 'stop', size: 1000, stopPrice: 1.1 });
        await settle();
        // A buy above the market is a breakout, not a pullback — the ticket has already
        // refused a level on the wrong side, so the type is passed through unchanged.
        expect(calls.find((x) => x.name === 'createOrder')!.arg).toMatchObject({ type: 'STOP', level: 1.1 });
    });

    it('carries protection onto the order so it is armed the moment it fills', async () => {
        const { calls } = stubVenue();
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.order({ side: 'buy', type: 'limit', size: 1000, limitPrice: 1.05, bracket: { stopLoss: 1.04, takeProfit: 1.08 } });
        await settle();
        expect(calls.find((x) => x.name === 'createOrder')!.arg).toMatchObject({ stopLevel: 1.04, profitLevel: 1.08 });
    });

    it('refuses a resting order with no level to wait at', () => {
        stubVenue();
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        expect(() => c.order({ side: 'buy', type: 'limit', size: 1000 })).toThrow(/price to wait at/i);
    });

    it('reads the book back, filtered to this instrument', async () => {
        stubVenue({ workingOrders: () => Promise.resolve([venueOrder(), venueOrder({ dealId: 'o2' }, 'GOLD')]) });
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.refreshVisuals();
        await settle();
        expect(c.orders()).toHaveLength(1);
        expect(c.orders()[0]).toMatchObject({ side: 'buy', price: 1.085, kind: 'limit', size: 1000 });
    });

    it('never gives an order the same number as a position', async () => {
        stubVenue({
            positions: () => Promise.resolve([venuePosition()]),
            workingOrders: () => Promise.resolve([venueOrder()]),
        });
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.refreshVisuals();
        await settle();
        // The chart addresses both by number; a collision would cancel an order when
        // somebody meant to close a position.
        expect(c.orders()[0]!.id).not.toBe(c.positions()[0]!.id);
    });

    it('cancels by the id the venue gave it', async () => {
        const stub = stubVenue({ workingOrders: () => Promise.resolve([venueOrder()]) });
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.refreshVisuals();
        await settle();
        c.cancelOrder(c.orders()[0]!.id);
        await settle();
        expect(stub.calls.find((x) => x.name === 'cancelOrder')!.arg).toBe('order-1');
    });

    it('refuses to cancel one that is no longer on the book', () => {
        stubVenue();
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        expect(() => c.cancelOrder(999)).toThrow(/no longer on the book/i);
    });
});

describe('one bot\'s venue ownership', () => {
    it('shows and manages only the positions and orders assigned to that bot', async () => {
        const positions = [venuePosition({ dealId: 'position-a' }), venuePosition({ dealId: 'position-b' })];
        const orders = [venueOrder({ dealId: 'order-a' }), venueOrder({ dealId: 'order-b' })];
        const { calls } = stubVenue({
            positions: () => Promise.resolve(positions),
            workingOrders: () => Promise.resolve(orders),
        });
        const a = new CapitalController({
            epic: 'EURUSD',
            notify: noop,
            ownership: ownership({ positionDealIds: ['position-a'], workingOrderDealIds: ['order-a'] }),
        });
        const b = new CapitalController({
            epic: 'EURUSD',
            notify: noop,
            ownership: ownership({ positionDealIds: ['position-b'], workingOrderDealIds: ['order-b'] }),
        });

        a.refreshVisuals();
        b.refreshVisuals();
        await settle();
        expect(a.positions()).toHaveLength(1);
        expect(a.orders()).toHaveLength(1);
        expect(b.positions()).toHaveLength(1);
        expect(b.orders()).toHaveLength(1);

        a.closeOne(a.positions()[0]!.id);
        a.cancelAll();
        await settle();
        expect(calls.filter((call) => call.name === 'closePosition').map((call) => call.arg)).toEqual(['position-a']);
        expect(calls.filter((call) => call.name === 'cancelOrder').map((call) => call.arg)).toEqual(['order-a']);
    });

    it('persists an accepted position before the venue read catches up', async () => {
        const changes: MidoriBotCapitalOwnership[] = [];
        stubVenue({
            openPosition: () => Promise.resolve(accepted({ dealId: 'position-new' })),
            positions: () => Promise.resolve([]),
        });
        const c = new CapitalController({
            epic: 'EURUSD',
            notify: noop,
            ownership: ownership(),
            onOwnershipChange: (next) => changes.push(next),
        });

        c.refreshVisuals();
        await settle();
        c.order({ side: 'buy', size: 1000 });
        await settle();
        expect(changes[changes.length - 1]?.positionDealIds).toEqual(['position-new']);
    });

    it('persists an uncertain create before the venue verdict arrives', async () => {
        const changes: MidoriBotCapitalOwnership[] = [];
        let answer!: (confirmation: MidoriCapitalConfirmation) => void;
        const pending = new Promise<MidoriCapitalConfirmation>((resolve) => { answer = resolve; });
        stubVenue({ openPosition: () => pending });
        const c = new CapitalController({
            epic: 'EURUSD',
            notify: noop,
            ownership: ownership(),
            onOwnershipChange: (next) => changes.push(next),
        });

        expect(() => c.order({ side: 'buy', size: 1000 })).toThrow(/account state is not current/i);
        c.refreshVisuals();
        await settle();
        c.order({ side: 'buy', size: 1000 });
        expect(changes[changes.length - 1]).toMatchObject({
            positionDealIds: [],
            uncertain: true,
        });

        answer(accepted({ dealId: 'position-new' }));
        await settle();
        expect(changes[changes.length - 1]).toMatchObject({
            positionDealIds: ['position-new'],
            uncertain: false,
        });
    });

    it('promotes a filled working order through the venue\'s durable link', async () => {
        const changes: MidoriBotCapitalOwnership[] = [];
        stubVenue({
            positions: () => Promise.resolve([venuePosition({
                dealId: 'position-from-order',
                workingOrderId: 'order-owned',
            })]),
            workingOrders: () => Promise.resolve([]),
        });
        const c = new CapitalController({
            epic: 'EURUSD',
            notify: noop,
            ownership: ownership({ workingOrderDealIds: ['order-owned'] }),
            onOwnershipChange: (next) => changes.push(next),
        });

        c.refreshVisuals();
        await settle();
        expect(c.positions()).toHaveLength(1);
        expect(changes[changes.length - 1]).toMatchObject({
            positionDealIds: ['position-from-order'],
            workingOrderDealIds: [],
        });
    });

    it('retires an old confirmed id once a successful venue read says it is gone', async () => {
        const changes: MidoriBotCapitalOwnership[] = [];
        stubVenue({ positions: () => Promise.resolve([]) });
        const c = new CapitalController({
            epic: 'EURUSD',
            notify: noop,
            ownership: ownership({ positionDealIds: ['position-old'] }),
            onOwnershipChange: (next) => changes.push(next),
        });

        c.refreshVisuals();
        await settle();
        expect(changes[changes.length - 1]?.positionDealIds).toEqual([]);
    });

    it('blocks another entry after a create request loses its verdict', async () => {
        const changes: MidoriBotCapitalOwnership[] = [];
        stubVenue({ openPosition: () => Promise.reject(new Error('the request outcome is unknown')) });
        const c = new CapitalController({
            epic: 'EURUSD',
            notify: noop,
            ownership: ownership(),
            onOwnershipChange: (next) => changes.push(next),
        });

        c.refreshVisuals();
        await settle();
        c.order({ side: 'buy', size: 1000 });
        await settle();
        expect(changes[changes.length - 1]?.uncertain).toBe(true);
        expect(() => c.order({ side: 'buy', size: 1000 })).toThrow(/outcome could not be identified/i);
    });

    it('blocks a bot entry when the last account read failed', async () => {
        let offline = false;
        stubVenue({
            account: () => offline
                ? Promise.reject(new Error('account endpoint offline'))
                : Promise.resolve({ currency: 'EUR', balance: { balance: 10_000, profitLoss: 0, available: 9_000 } }),
        });
        const c = new CapitalController({ epic: 'EURUSD', notify: noop, ownership: ownership() });
        c.refreshVisuals();
        await settle();
        expect(c.isStale()).toBe(false);

        offline = true;
        c.refreshVisuals();
        await settle();
        expect(c.isStale()).toBe(true);
        expect(() => c.order({ side: 'buy', size: 1000 })).toThrow(/account state is not current/i);
    });

    it('applies the instrument size increment learned from the account read', async () => {
        const { calls } = stubVenue({
            marketInfo: () => Promise.resolve({
                instrument: {
                    epic: 'EURUSD', name: 'EUR/USD', type: 'CURRENCIES', currency: 'USD',
                    lotSize: 1, marginFactor: 3.33, marginFactorUnit: 'PERCENTAGE',
                },
                snapshot: { marketStatus: 'TRADEABLE', bid: 1.0924, offer: 1.0926 },
                dealingRules: {
                    minDealSize: { value: 0.1, unit: 'POINTS' },
                    minSizeIncrement: { value: 0.1, unit: 'POINTS' },
                    maxDealSize: { value: 100, unit: 'POINTS' },
                },
            }),
        });
        const c = new CapitalController({ epic: 'EURUSD', notify: noop, ownership: ownership() });
        c.refreshVisuals();
        await settle();
        c.order({ side: 'buy', size: 1.04 });
        await settle();

        const sent = calls.find((call) => call.name === 'openPosition')?.arg as { size?: number };
        expect(sent.size).toBe(1);
    });
});


describe('the price a plan is measured against', () => {
    it('is the mid, once both sides are known', async () => {
        stubVenue();
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.refreshVisuals();
        await settle();
        // Sizing off the bid alone is wrong by the whole spread on a buy and right on a sell
        // — silent, and one-sided. The mid is wrong by half in both directions.
        expect(c.price()).toBeCloseTo(1.0925, 8);
        expect(c.quote()).toEqual({ bid: 1.0924, ask: 1.0926 });
    });

    it('falls back to the candle close before a quote has arrived', () => {
        stubVenue();
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.mark(1.09);
        // Better a one-sided price than none, as long as nothing pretends otherwise.
        expect(c.price()).toBe(1.09);
        expect(c.quote()).toBeNull();
    });

    it('lets a real quote override the candle close', () => {
        stubVenue();
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.mark(1.09);
        c.markQuote(1.0924, 1.0926);
        expect(c.price()).toBeCloseTo(1.0925, 8);
    });
});

describe('a market that is not open', () => {
    const shut = (status: string) => ({
        marketInfo: () => Promise.resolve({
            instrument: { epic: 'EURUSD', name: 'EUR/USD', type: 'CURRENCIES', currency: 'USD', lotSize: 1 },
            snapshot: { marketStatus: status, bid: 1.0924, offer: 1.0926, decimalPlacesFactor: 5, scalingFactor: 1 },
        }),
    });

    it('refuses an order before sending it', async () => {
        stubVenue(shut('CLOSED'));
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.refreshVisuals();
        await settle();
        expect(c.tradeable()).toBe(false);
        // Answered at the moment of the press, in words about the market rather than a code
        // that comes back from a round trip.
        expect(() => c.order({ side: 'buy', size: 1000 })).toThrow(/market is closed/i);
    });

    it('names an unusual state rather than calling everything closed', async () => {
        stubVenue(shut('EDITS_ONLY'));
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.refreshVisuals();
        await settle();
        expect(() => c.order({ side: 'buy', size: 1000 })).toThrow(/EDITS_ONLY/);
    });

    it('does not block orders before it has heard anything', () => {
        stubVenue();
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        // Unknown must not mean shut: refusing on no information would block the first order
        // of every session.
        expect(c.tradeable()).toBe(true);
    });
});

describe('when the venue stops answering', () => {
    it('says so instead of showing stale figures as current', async () => {
        let fail = false;
        stubVenue({ account: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve({ balance: { balance: 10_000, deposit: 10_000, profitLoss: 25, available: 9_000 } })) });
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.refreshVisuals();
        await settle();
        expect(c.isStale()).toBe(false);
        const readAt = c.readAt();
        expect(readAt).toBeGreaterThan(0);

        fail = true;
        c.refreshVisuals();
        await settle();
        // The figures stay — a dropped connection is not a closed position — but they are
        // marked, and the timestamp says how old they are.
        expect(c.isStale()).toBe(true);
        expect(c.equity()).toBe(10_025);
        expect(c.readAt()).toBe(readAt);
    });

    it('clears the mark once it is answering again', async () => {
        let fail = true;
        stubVenue({ account: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve({ balance: { balance: 10_000, deposit: 10_000, profitLoss: 0, available: 9_000 } })) });
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.refreshVisuals();
        await settle();
        expect(c.isStale()).toBe(true);

        fail = false;
        c.refreshVisuals();
        await settle();
        expect(c.isStale()).toBe(false);
    });
});


describe('recording what has ended', () => {
    /** Collects everything the controller reports as a finished trade. */
    function withJournal(over: Record<string, unknown> = {}) {
        const closed: LiveTradeRecord[] = [];
        const stub = stubVenue(over);
        const c = new CapitalController({
            epic: 'EURUSD',
            notify: noop,
            live: true,
            onTradeClosed: (t) => closed.push(t),
        });
        return { c, closed, ...stub };
    }

    it('records a position that is gone from one read to the next', async () => {
        let open = [venuePosition()];
        const { c, closed } = withJournal({ positions: () => Promise.resolve(open) });
        c.refreshVisuals();
        await settle();
        expect(closed).toHaveLength(0);

        open = [];
        c.refreshVisuals();
        await settle();
        // A stop firing overnight is the commonest trade there is, and nobody here asked for
        // it — a journal that only wrote down its own requests would be missing most of them.
        expect(closed).toHaveLength(1);
        expect(closed[0]).toMatchObject({ id: 'deal-1', symbol: 'EURUSD', side: 'long', size: 1000, entryPrice: 1.09241, live: true });
    });

    it('marks an exit it did not see as an estimate', async () => {
        let open = [venuePosition({ upl: 4.2 })];
        const { c, closed } = withJournal({ positions: () => Promise.resolve(open) });
        c.refreshVisuals();
        await settle();
        open = [];
        c.refreshVisuals();
        await settle();
        expect(closed[0]!.estimated).toBe(true);
        // The venue's own unrealized figure at the last read is the closest honest answer.
        expect(closed[0]!.netPnl).toBe(4.2);
    });

    it('records the real fill when it closed the position itself', async () => {
        let open = [venuePosition()];
        const { c, closed } = withJournal({
            positions: () => Promise.resolve(open),
            closePosition: () => { open = []; return Promise.resolve(accepted({ status: 'CLOSED', level: 1.09441 })); },
        });
        c.refreshVisuals();
        await settle();
        c.closeOne(c.positions()[0]!.id);
        await settle();

        expect(closed).toHaveLength(1);
        // The confirmation carried the fill, so nothing here is a reconstruction.
        expect(closed[0]!.estimated).toBe(false);
        expect(closed[0]!.exitPrice).toBe(1.09441);
        expect(closed[0]!.netPnl).toBeCloseTo((1.09441 - 1.09241) * 1000, 6);
    });

    it('gets the direction of a short the right way round', async () => {
        let open = [venuePosition({ direction: 'SELL', size: 500, level: 1.1 })];
        const { c, closed } = withJournal({
            positions: () => Promise.resolve(open),
            closePosition: () => { open = []; return Promise.resolve(accepted({ status: 'CLOSED', level: 1.09 })); },
        });
        c.refreshVisuals();
        await settle();
        c.closeOne(c.positions()[0]!.id);
        await settle();
        expect(closed[0]!.side).toBe('short');
        // A short makes money as the price falls: 1.10 down to 1.09 on 500 is +5.
        expect(closed[0]!.netPnl).toBeCloseTo(5, 6);
    });

    it('records nothing when the venue simply could not be reached', async () => {
        let fail = false;
        const { c, closed } = withJournal({
            positions: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve([venuePosition()])),
        });
        c.refreshVisuals();
        await settle();

        fail = true;
        c.refreshVisuals();
        await settle();
        // The worst possible bug in this file: a dropped connection booking every open
        // position as a closed trade, in the record money is judged by.
        expect(closed).toHaveLength(0);
        expect(c.positions()).toHaveLength(1);
    });

    it('records a closure once, not on every later read', async () => {
        let open = [venuePosition()];
        const { c, closed } = withJournal({ positions: () => Promise.resolve(open) });
        c.refreshVisuals();
        await settle();
        open = [];
        c.refreshVisuals();
        await settle();
        c.refreshVisuals();
        await settle();
        expect(closed).toHaveLength(1);
    });
});


describe('which money a figure is in', () => {
    it('reports the currency the account itself is held in', async () => {
        stubVenue();
        const c = new CapitalController({ epic: 'EURUSD', notify: noop });
        c.refreshVisuals();
        await settle();
        expect(c.accountCurrency()).toBe('EUR');
    });

    it('stamps a recorded trade with the currency the venue books it in', async () => {
        let open = [venuePosition({ currency: 'USD' })];
        const closed: LiveTradeRecord[] = [];
        stubVenue({ positions: () => Promise.resolve(open) });
        const c = new CapitalController({ epic: 'EURUSD', notify: noop, onTradeClosed: (t) => closed.push(t) });
        c.refreshVisuals();
        await settle();
        open = [];
        c.refreshVisuals();
        await settle();
        // The instrument books in USD while the account is held in EUR — the two are
        // different money, and the record has to keep the unit with the number.
        expect(closed[0]!.currency).toBe('USD');
        expect(c.accountCurrency()).toBe('EUR');
    });
});
