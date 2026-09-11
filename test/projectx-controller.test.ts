import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectXController } from '../app/renderer/trading/ProjectXController';

const CONTRACT = 'CON.F.US.ENQ.U26';
const DEALING = { contractId: CONTRACT, tickSize: 0.25, tickValue: 5, minSize: 1, sizeStep: 1 };
const ACCOUNT = { id: 42, name: 'EXPRESS-V2-CT', balance: 50_000, canTrade: true, simulated: true };

/** A gateway position. `type` is 1 for long and 2 for short — the venue's own enum. */
const position = (over: Record<string, unknown> = {}) => ({
    id: 6124, accountId: 42, contractId: CONTRACT,
    creationTimestamp: '2026-09-11T12:00:00+00:00',
    type: 1, size: 2, averagePrice: 29_000, ...over,
});

/** A resting order. `type` 4 is Stop and 1 is Limit; `side` 1 is sell. */
const order = (over: Record<string, unknown> = {}) => ({
    id: 26_970, accountId: 42, contractId: CONTRACT,
    creationTimestamp: '2026-09-11T12:00:00+00:00', updateTimestamp: '2026-09-11T12:00:00+00:00',
    status: 1, type: 4, side: 1, size: 2, limitPrice: null, stopPrice: 28_900, filledPrice: null, ...over,
});

function bridge(over: Record<string, unknown> = {}) {
    const api = {
        positions: vi.fn(async () => [] as unknown[]),
        openOrders: vi.fn(async () => [] as unknown[]),
        accounts: vi.fn(async () => [ACCOUNT]),
        account: vi.fn(async () => ({ accountId: ACCOUNT.id, chosen: true })),
        placeOrder: vi.fn(async () => ({ orderId: 1 })),
        modifyOrder: vi.fn(async () => {}),
        cancelOrder: vi.fn(async () => {}),
        closePosition: vi.fn(async () => {}),
        ...over,
    };
    vi.stubGlobal('window', { midori: { projectx: api } });
    return api;
}

/** A controller that has read the venue once. */
async function controllerWith(api: ReturnType<typeof bridge>) {
    const notes: Array<[string, string]> = [];
    const c = new ProjectXController({
        ticker: 'NQU6', dealing: DEALING, accountName: ACCOUNT.name,
        notify: (m, k) => notes.push([k, m]),
    });
    c.start();
    await vi.waitFor(() => expect(api.positions).toHaveBeenCalled());
    await vi.waitFor(() => expect(c.readAt()).toBeGreaterThan(0));
    return { c, notes };
}

beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('ProjectX positions', () => {
    it('signs the size from the venue enum — 1 is long, 2 is short', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ type: 1, size: 2 }), position({ id: 2, type: 2, size: 3 })]) });
        const { c } = await controllerWith(api);
        expect(c.positions().map((p) => p.size)).toEqual([2, -3]);
        c.stop();
    });

    it('values a position in ticks times tick value, not in points', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ type: 1, size: 2, averagePrice: 29_000 })]) });
        const { c } = await controllerWith(api);
        c.mark(29_004);
        // 4 points = 16 ticks; 16 × $5 × 2 contracts = $160. A naive price difference says 8.
        expect(c.positions()[0]!.unrealized).toBe(160);
        expect(c.equity()).toBe(50_000 + 160);
        c.stop();
    });

    it('values a short the other way round', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ type: 2, size: 1, averagePrice: 29_000 })]) });
        const { c } = await controllerWith(api);
        c.mark(28_996);
        expect(c.positions()[0]!.unrealized).toBe(80);
        c.stop();
    });

    it('attaches the resting orders that protect a position to it', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position()]),
            openOrders: vi.fn(async () => [
                order({ id: 10, type: 4, side: 1, stopPrice: 28_900 }),
                order({ id: 11, type: 1, side: 1, limitPrice: 29_200, stopPrice: null }),
            ]),
        });
        const { c } = await controllerWith(api);
        expect(c.positions()[0]).toMatchObject({ stopLoss: 28_900, takeProfit: 29_200, stopOrderId: 10, targetOrderId: 11 });
        c.stop();
    });

    it('marks itself stale when the venue cannot be read, rather than showing old figures as current', async () => {
        const api = bridge({ positions: vi.fn(async () => { throw new Error('gateway down'); }) });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const c = new ProjectXController({ ticker: 'NQU6', dealing: DEALING, notify: () => {} });
        c.start();
        await vi.waitFor(() => expect(c.isStale()).toBe(true));
        c.stop();
    });
});

describe('ProjectX protection', () => {
    it('places a stop as a resting order facing the other way', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ type: 1, size: 2 })]) });
        const { c } = await controllerWith(api);
        c.protect({ stopLoss: 28_900 });
        await vi.waitFor(() => expect(api.placeOrder).toHaveBeenCalled());
        expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
            contractId: CONTRACT, side: 'sell', type: 'stop', size: 2, stopPrice: 28_900,
        }));
        c.stop();
    });

    it('protects a short by buying', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ type: 2, size: 1 })]) });
        const { c } = await controllerWith(api);
        c.protect({ stopLoss: 29_100 });
        await vi.waitFor(() => expect(api.placeOrder).toHaveBeenCalled());
        expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'buy', type: 'stop' }));
        c.stop();
    });

    /**
     * The point of the whole design: moving a level must not uncover the position.
     */
    it('moves an existing stop instead of cancelling and replacing it', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position()]),
            openOrders: vi.fn(async () => [order({ id: 10, type: 4, side: 1, stopPrice: 28_900 })]),
        });
        const { c } = await controllerWith(api);
        c.protect({ stopLoss: 28_950 });
        await vi.waitFor(() => expect(api.modifyOrder).toHaveBeenCalled());
        expect(api.modifyOrder).toHaveBeenCalledWith(10, { stopPrice: 28_950 });
        expect(api.cancelOrder).not.toHaveBeenCalled();
        expect(api.placeOrder).not.toHaveBeenCalled();
        c.stop();
    });

    it('cancels the order when a level is removed', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position()]),
            openOrders: vi.fn(async () => [order({ id: 10, type: 4, side: 1 })]),
        });
        const { c } = await controllerWith(api);
        c.protect({ stopLoss: null });
        await vi.waitFor(() => expect(api.cancelOrder).toHaveBeenCalledWith(10));
        c.stop();
    });

    it('leaves the target alone when only the stop is dragged', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position()]),
            openOrders: vi.fn(async () => [
                order({ id: 10, type: 4, side: 1, stopPrice: 28_900 }),
                order({ id: 11, type: 1, side: 1, limitPrice: 29_200, stopPrice: null }),
            ]),
        });
        const { c } = await controllerWith(api);
        c.protect({ stopLoss: 28_950 });
        await vi.waitFor(() => expect(api.modifyOrder).toHaveBeenCalled());
        expect(api.modifyOrder).toHaveBeenCalledTimes(1);
        expect(api.modifyOrder).toHaveBeenCalledWith(10, { stopPrice: 28_950 });
        c.stop();
    });

    it('refuses to protect when nothing is open', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        expect(() => c.protect({ stopLoss: 1 })).toThrow(/No open NQU6 position/);
        c.stop();
    });
});

describe('ProjectX orphan protection', () => {
    /**
     * The dangerous case this polling exists for.
     *
     * Stop and target are independent orders and the venue does not link them. When one
     * fills, the position is gone and the other is still working — and a working order
     * against no position OPENS one the other way.
     */
    it('cancels a protective order whose position has gone', async () => {
        const api = bridge({
            positions: vi.fn(async () => []),
            openOrders: vi.fn(async () => [order({ id: 11, type: 1, side: 1, limitPrice: 29_200, stopPrice: null })]),
        });
        const { c, notes } = await controllerWith(api);
        await vi.waitFor(() => expect(api.cancelOrder).toHaveBeenCalledWith(11));
        expect(notes.some(([, m]) => /left over from a closed/.test(m))).toBe(true);
        c.stop();
    });

    it('leaves orders alone while their position is still open', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position()]),
            openOrders: vi.fn(async () => [order({ id: 10, type: 4, side: 1 })]),
        });
        const { c } = await controllerWith(api);
        expect(api.cancelOrder).not.toHaveBeenCalled();
        c.stop();
    });

    it('says so loudly when an orphan cannot be cancelled — a live order against nothing', async () => {
        const api = bridge({
            positions: vi.fn(async () => []),
            openOrders: vi.fn(async () => [order({ id: 11, type: 1, side: 1 })]),
            cancelOrder: vi.fn(async () => { throw new Error('refused'); }),
        });
        const { c, notes } = await controllerWith(api);
        await vi.waitFor(() => expect(notes.some(([k]) => k === 'error')).toBe(true));
        expect(notes.find(([k]) => k === 'error')![1]).toMatch(/could not be cancelled — check it on the platform/);
        c.stop();
    });
});

describe('ProjectX break-even', () => {
    it('refuses while the trade is not in profit, and says why', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ type: 1, averagePrice: 29_000 })]) });
        const { c } = await controllerWith(api);
        c.mark(28_990);
        expect(c.breakEvenRefusal()).toMatch(/not in profit/);
        expect(() => c.breakEven()).toThrow(/not in profit/);
        c.stop();
    });

    it('moves the stop to the entry once the trade is in profit', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ type: 1, size: 2, averagePrice: 29_000 })]) });
        const { c } = await controllerWith(api);
        c.mark(29_010);
        expect(c.breakEvenRefusal()).toBeNull();
        c.breakEven();
        await vi.waitFor(() => expect(api.placeOrder).toHaveBeenCalled());
        expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ type: 'stop', stopPrice: 29_000, side: 'sell' }));
        c.stop();
    });

    it('works the same way on a short', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ type: 2, size: 1, averagePrice: 29_000 })]) });
        const { c } = await controllerWith(api);
        c.mark(28_980);
        expect(c.breakEvenRefusal()).toBeNull();
        c.breakEven();
        await vi.waitFor(() => expect(api.placeOrder).toHaveBeenCalled());
        expect(api.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'buy', stopPrice: 29_000 }));
        c.stop();
    });

    it('declines to repeat itself when the stop already sits at entry', async () => {
        const api = bridge({
            positions: vi.fn(async () => [position({ type: 1, averagePrice: 29_000 })]),
            openOrders: vi.fn(async () => [order({ id: 10, type: 4, side: 1, stopPrice: 29_000 })]),
        });
        const { c } = await controllerWith(api);
        c.mark(29_010);
        expect(c.breakEvenRefusal()).toMatch(/already at entry/);
        c.stop();
    });
});

describe('ProjectX orders', () => {
    it('refuses a size below one whole contract', async () => {
        const api = bridge();
        const { c } = await controllerWith(api);
        expect(() => c.order({ side: 'buy', size: 0, type: 'market' })).toThrow(/whole contracts/);
        expect(api.placeOrder).not.toHaveBeenCalled();
        c.stop();
    });

    it('closes a position through the venue rather than by sending an opposing order', async () => {
        const api = bridge({ positions: vi.fn(async () => [position({ id: 6124 })]) });
        const { c } = await controllerWith(api);
        c.closeOne(6124);
        await vi.waitFor(() => expect(api.closePosition).toHaveBeenCalledWith(CONTRACT));
        expect(api.placeOrder).not.toHaveBeenCalled();
        c.stop();
    });
});
