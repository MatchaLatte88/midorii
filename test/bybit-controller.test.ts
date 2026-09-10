import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BybitController, bybitSpotCost, decimalsOf, isBybitProtection } from '../app/renderer/trading/BybitController';
import type {
    MidoriBybitExecution, MidoriBybitInstrument, MidoriBybitOrder, MidoriBybitPosition, MidoriBybitWallet,
} from '../app/renderer/midori';

const spotInfo: MidoriBybitInstrument = {
    category: 'spot', symbol: 'BTCUSDT', status: 'Trading', baseAsset: 'BTC', quoteAsset: 'USDT',
    settleAsset: null, tickSize: 0.01, stepSize: 0.000001, minQty: 0.000048, maxQty: 71,
    minNotional: 1, maxLeverage: null,
};

const linearInfo: MidoriBybitInstrument = {
    category: 'linear', symbol: 'BTCUSDT', status: 'Trading', baseAsset: 'BTC', quoteAsset: 'USDT',
    settleAsset: 'USDT', tickSize: 0.1, stepSize: 0.001, minQty: 0.001, maxQty: 100,
    minNotional: 5, maxLeverage: 100,
};

const wallet = (coins: Array<{ coin: string; balance: number; equity?: number }>, available = 10_000): MidoriBybitWallet => ({
    list: [{
        accountType: 'UNIFIED',
        totalEquity: '10000',
        totalAvailableBalance: String(available),
        totalWalletBalance: '10000',
        coin: coins.map((c) => ({
            coin: c.coin,
            equity: String(c.equity ?? c.balance),
            walletBalance: String(c.balance),
            usdValue: '0',
        })),
    }],
});

const position = (over: Partial<MidoriBybitPosition> = {}): MidoriBybitPosition => ({
    symbol: 'BTCUSDT', side: 'Buy', size: '0.01', avgPrice: '90000', positionValue: '900',
    leverage: '10', markPrice: '95000', liqPrice: '0', unrealisedPnl: '50',
    takeProfit: '', stopLoss: '', createdTime: '1700000000000', updatedTime: '1700000000000', ...over,
});

const order = (over: Partial<MidoriBybitOrder> = {}): MidoriBybitOrder => ({
    orderId: 'o1', orderLinkId: 'mi_ord_1', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Limit',
    price: '85000', qty: '0.01', leavesQty: '0.01', triggerPrice: '', stopOrderType: '',
    orderStatus: 'New', reduceOnly: false, takeProfit: '', stopLoss: '', createdTime: '1700000000000', ...over,
});

const execution = (over: Partial<MidoriBybitExecution> = {}): MidoriBybitExecution => ({
    execId: 'e1', orderId: 'o1', symbol: 'BTCUSDT', side: 'Buy', execPrice: '90000', execQty: '0.1',
    execValue: '9000', execFee: '0', feeCurrency: 'BTC', execType: 'Trade', execTime: '1700000000000', ...over,
});

function stub(over: Partial<Window['midori']['bybit']> = {}) {
    const calls: Array<{ name: string; value: unknown }> = [];
    const record = <T>(name: string, result: T) => (value?: unknown): Promise<T> => {
        calls.push({ name, value });
        return Promise.resolve(result);
    };
    const venue = {
        wallet: record('wallet', wallet([])),
        positions: record('positions', { list: [] as MidoriBybitPosition[] }),
        openOrders: record('openOrders', [] as MidoriBybitOrder[]),
        executions: record('executions', [] as MidoriBybitExecution[]),
        placeOrder: record('placeOrder', {}),
        cancelOrder: record('cancelOrder', {}),
        cancelAll: record('cancelAll', {}),
        setProtection: record('setProtection', {}),
        close: record('close', {}),
        ...over,
    } as unknown as Window['midori']['bybit'];
    (globalThis as { window?: unknown }).window = { midori: { bybit: venue } };
    return { calls, venue };
}

/** Let the reconcile's chain of awaits run out. */
const settle = async (): Promise<void> => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
};

beforeEach(() => {
    delete (globalThis as { window?: unknown }).window;
});

describe('spot cost basis', () => {
    it('prices the units that remain at what this account paid for them, fees included', () => {
        const cost = bybitSpotCost([
            execution({ execQty: '0.1', execValue: '9000', execFee: '0.0001', feeCurrency: 'BTC' }),
        ], 'BTC', 'USDT');
        // 0.0999 BTC survived the fee, and it cost the whole 9000 USDT.
        expect(cost.quantity).toBeCloseTo(0.0999, 8);
        expect(cost.price).toBeCloseTo(9000 / 0.0999, 4);
    });

    it('reduces the cost of what came before a sale, not of what came after it', () => {
        const cost = bybitSpotCost([
            execution({ execId: 'a', execQty: '1', execValue: '100', execFee: '0', feeCurrency: 'USDT', execTime: '1' }),
            execution({ execId: 'b', side: 'Sell', execQty: '0.5', execValue: '80', execFee: '0', feeCurrency: 'USDT', execTime: '2' }),
            execution({ execId: 'c', execQty: '1', execValue: '300', execFee: '0', feeCurrency: 'USDT', execTime: '3' }),
        ], 'BTC', 'USDT');
        // 0.5 left at 100, plus 1 at 300 ⇒ 350 over 1.5.
        expect(cost.quantity).toBeCloseTo(1.5, 8);
        expect(cost.price).toBeCloseTo(350 / 1.5, 8);
    });

    it('forgets the cost entirely once the holding has been sold out', () => {
        const cost = bybitSpotCost([
            execution({ execId: 'a', execQty: '1', execValue: '100', execFee: '0', feeCurrency: 'USDT', execTime: '1' }),
            execution({ execId: 'b', side: 'Sell', execQty: '1', execValue: '150', execFee: '0', feeCurrency: 'USDT', execTime: '2' }),
        ], 'BTC', 'USDT');
        expect(cost).toEqual({ quantity: 0, price: 0, openedAt: 0 });
    });
});

describe('writing a size out', () => {
    it('counts the decimals of a step JavaScript prints in exponent form', () => {
        expect(decimalsOf(0.001)).toBe(3);
        expect(decimalsOf(0.000001)).toBe(6);
        // String(1e-8) is "1e-8"; counting after the dot would say zero and round to a whole coin.
        expect(decimalsOf(1e-8)).toBe(8);
        expect(decimalsOf(1)).toBe(0);
    });
});

describe('telling protection from a way in', () => {
    it('keeps a perpetual\'s own levels out of the working-order list', () => {
        expect(isBybitProtection(order({ stopOrderType: 'StopLoss' }), 'linear')).toBe(true);
        expect(isBybitProtection(order({ reduceOnly: true }), 'linear')).toBe(true);
        expect(isBybitProtection(order(), 'linear')).toBe(false);
    });

    it('reads a spot TP/SL sell as protection and a plain sell as an order', () => {
        expect(isBybitProtection(order({ side: 'Sell', stopOrderType: 'tpslOrder' }), 'spot')).toBe(true);
        expect(isBybitProtection(order({ side: 'Sell' }), 'spot')).toBe(false);
        expect(isBybitProtection(order({ side: 'Buy', stopOrderType: 'tpslOrder' }), 'spot')).toBe(false);
    });
});

describe('a Bybit perpetual on the chart', () => {
    it('draws a short as a negative size and reports the venue\'s own result, not a computed one', async () => {
        stub({
            wallet: () => Promise.resolve(wallet([{ coin: 'USDT', balance: 9_500, equity: 9_800 }])),
            positions: () => Promise.resolve({
                list: [position({ side: 'Sell', size: '0.02', avgPrice: '95000', unrealisedPnl: '-120', stopLoss: '97000' })],
            }),
        });
        const controller = new BybitController({ ticker: 'BTCUSDT.P', info: linearInfo, notify: vi.fn() });
        controller.mark(96_000);
        controller.refreshVisuals();
        await settle();

        const [open] = controller.positions();
        expect(open?.size).toBe(-0.02);
        expect(open?.entryPrice).toBe(95_000);
        expect(open?.stopLoss).toBe(97_000);
        // The venue said −120; nothing here recomputes it from the mark.
        expect(open?.unrealized).toBe(-120);
        expect(controller.book().positions[0]).toMatchObject({ side: 'short', size: 0.02, unrealized: -120 });
        // Equity is the settle coin's, which already carries the open result.
        expect(controller.equity()).toBe(9_800);
    });

    it('refuses a stop that would sit on the wrong side of a short', async () => {
        stub({
            wallet: () => Promise.resolve(wallet([{ coin: 'USDT', balance: 9_500 }])),
            positions: () => Promise.resolve({ list: [position({ side: 'Sell', size: '0.02' })] }),
        });
        const controller = new BybitController({ ticker: 'BTCUSDT.P', info: linearInfo, notify: vi.fn() });
        controller.mark(96_000);
        controller.refreshVisuals();
        await settle();

        expect(() => controller.protect({ stopLoss: 90_000 })).toThrow('short must sit above');
        expect(() => controller.protect({ takeProfit: 99_000 })).toThrow('short must sit below');
    });

    it('sets a perpetual\'s protection without naming an order to cancel', async () => {
        const { calls } = stub({
            wallet: () => Promise.resolve(wallet([{ coin: 'USDT', balance: 9_500 }])),
            positions: () => Promise.resolve({ list: [position()] }),
        });
        const controller = new BybitController({ ticker: 'BTCUSDT.P', info: linearInfo, notify: vi.fn() });
        controller.mark(95_000);
        controller.refreshVisuals();
        await settle();

        controller.protect({ stopLoss: 90_000 });
        await settle();
        const sent = calls.find((c) => c.name === 'setProtection')?.value as Record<string, unknown>;
        expect(sent).toMatchObject({ category: 'linear', symbol: 'BTCUSDT', stopLoss: 90_000 });
        // The spot-only fields are absent: a position's levels replace themselves.
        expect(sent).not.toHaveProperty('orders');
        expect(sent).not.toHaveProperty('quantity');
    });
});

describe('a Bybit spot pair on the chart', () => {
    it('holds what the balance says and prices it from this account\'s executions', async () => {
        stub({
            wallet: () => Promise.resolve(wallet([{ coin: 'BTC', balance: 0.1 }, { coin: 'USDT', balance: 5_000 }])),
            executions: () => Promise.resolve([execution({ execFee: '0', feeCurrency: 'USDT' })]),
        });
        const controller = new BybitController({ ticker: 'BTCUSDT', info: spotInfo, notify: vi.fn() });
        controller.mark(95_000);
        controller.refreshVisuals();
        await settle();

        const [held] = controller.positions();
        expect(held?.size).toBe(0.1);
        expect(held?.entryPrice).toBeCloseTo(90_000, 6);
        // Spot states no result of its own, so this is the one number the controller computes.
        expect(held?.unrealized).toBeCloseTo(500, 6);
        // Both balances, valued in the quote asset.
        expect(controller.equity()).toBeCloseTo(5_000 + 0.1 * 95_000, 6);
    });

    it('counts a resting sell as base that is no longer free', async () => {
        stub({
            wallet: () => Promise.resolve(wallet([{ coin: 'BTC', balance: 0.1 }, { coin: 'USDT', balance: 5_000 }])),
            openOrders: () => Promise.resolve([
                order({ orderId: 'p1', side: 'Sell', stopOrderType: 'tpslOrder', qty: '0.04', leavesQty: '0.04' }),
                order({ orderId: 'w1', side: 'Sell', qty: '0.01', leavesQty: '0.01' }),
            ]),
            executions: () => Promise.resolve([execution()]),
        });
        const controller = new BybitController({ ticker: 'BTCUSDT', info: spotInfo, notify: vi.fn() });
        controller.mark(95_000);
        controller.refreshVisuals();
        await settle();

        // 0.1 held, 0.04 under protection and 0.01 resting ⇒ 0.05 free.
        expect(controller.availableBase()).toBeCloseTo(0.05, 8);
        // The protective leg is not offered as a cancellable working order.
        expect(controller.orders().map((o) => o.orderId)).toEqual(['w1']);
    });

    it('will not sell more of the base than is free', async () => {
        stub({
            wallet: () => Promise.resolve(wallet([{ coin: 'BTC', balance: 0.02 }, { coin: 'USDT', balance: 5_000 }])),
            executions: () => Promise.resolve([execution({ execQty: '0.02', execValue: '1800' })]),
        });
        const controller = new BybitController({ ticker: 'BTCUSDT', info: spotInfo, notify: vi.fn() });
        controller.mark(95_000);
        controller.refreshVisuals();
        await settle();

        expect(() => controller.order({ side: 'sell', size: 0.05 })).toThrow('can only sell the BTC you hold');
    });

    it('names the old protection so the replacement can take its place', async () => {
        const { calls } = stub({
            wallet: () => Promise.resolve(wallet([{ coin: 'BTC', balance: 0.1 }, { coin: 'USDT', balance: 5_000 }])),
            openOrders: () => Promise.resolve([
                order({ orderId: 'p1', side: 'Sell', stopOrderType: 'tpslOrder', stopLoss: '85000', qty: '0.1', leavesQty: '0.1' }),
            ]),
            executions: () => Promise.resolve([execution()]),
        });
        const controller = new BybitController({ ticker: 'BTCUSDT', info: spotInfo, notify: vi.fn() });
        controller.mark(95_000);
        controller.refreshVisuals();
        await settle();

        controller.protect({ stopLoss: 88_000 });
        await settle();
        expect(calls.find((c) => c.name === 'setProtection')?.value).toMatchObject({
            category: 'spot', quantity: 0.1, orders: ['p1'], stopLoss: 88_000,
        });
    });

    it('says so when the account cannot be read, rather than showing an empty one', async () => {
        stub({ wallet: () => Promise.reject(new Error('network down')) });
        const controller = new BybitController({ ticker: 'BTCUSDT', info: spotInfo, notify: vi.fn() });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        controller.refreshVisuals();
        await settle();

        expect(controller.isStale()).toBe(true);
        expect(controller.readAt()).toBe(0);
        warn.mockRestore();
    });
});

describe('sending an order', () => {
    it('snaps a size down onto the venue\'s step and carries the bracket with it', async () => {
        const { calls } = stub({
            wallet: () => Promise.resolve(wallet([{ coin: 'USDT', balance: 10_000 }])),
        });
        const controller = new BybitController({ ticker: 'BTCUSDT.P', info: linearInfo, notify: vi.fn() });
        controller.mark(95_000);
        controller.refreshVisuals();
        await settle();

        controller.order({ side: 'buy', size: 0.0129, bracket: { stopLoss: 90_000, takeProfit: 100_000 } });
        await settle();
        expect(calls.find((c) => c.name === 'placeOrder')?.value).toMatchObject({
            category: 'linear', symbol: 'BTCUSDT', side: 'Buy', type: 'Market', qty: 0.012,
            bracket: { stopLoss: 90_000, takeProfit: 100_000 },
        });
    });

    it('sends a stop entry with the market it was measured against', async () => {
        const { calls } = stub({
            wallet: () => Promise.resolve(wallet([{ coin: 'USDT', balance: 10_000 }])),
        });
        const controller = new BybitController({ ticker: 'BTCUSDT.P', info: linearInfo, notify: vi.fn() });
        controller.mark(95_000);
        controller.refreshVisuals();
        await settle();

        controller.order({ side: 'buy', type: 'stop', size: 0.01, stopPrice: 97_000 });
        await settle();
        expect(calls.find((c) => c.name === 'placeOrder')?.value).toMatchObject({
            triggerPrice: 97_000, reference: 95_000, type: 'Market',
        });
    });

    it('refuses an order below the minimum size before it reaches the venue', async () => {
        stub({ wallet: () => Promise.resolve(wallet([{ coin: 'USDT', balance: 10_000 }])) });
        const controller = new BybitController({ ticker: 'BTCUSDT.P', info: linearInfo, notify: vi.fn() });
        controller.mark(95_000);
        expect(() => controller.order({ side: 'buy', size: 0.0004 })).toThrow('minimum Bybit size');
    });

    it('refuses to trade a market the venue has taken off', async () => {
        stub();
        const controller = new BybitController({
            ticker: 'BTCUSDT.P', info: { ...linearInfo, status: 'Delivering' }, notify: vi.fn(),
        });
        controller.mark(95_000);
        expect(() => controller.order({ side: 'buy', size: 0.01 })).toThrow('Delivering');
    });
});
