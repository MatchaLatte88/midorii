import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BinanceSpotController, decimalPlaces, spotAverageCost } from '../app/renderer/trading/BinanceSpotController';
import type {
    MidoriBinanceSpotAccount, MidoriBinanceSpotOrder, MidoriBinanceSpotSymbolInfo, MidoriBinanceSpotTrade,
} from '../app/renderer/midori';

const info: MidoriBinanceSpotSymbolInfo = {
    symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT',
    tickSize: 0.01, stepSize: 0.00001, minQty: 0.00001, maxQty: 9_000,
    marketStepSize: 0.00001, marketMinQty: 0.00001, marketMaxQty: 120,
    minNotional: 5, orderTypes: ['MARKET', 'LIMIT', 'STOP_LOSS'], ocoAllowed: true, otoAllowed: true,
};

const account = (btc = 0, usdt = 10_000, lockedBtc = 0): MidoriBinanceSpotAccount => ({
    canTrade: true, accountType: 'SPOT', permissions: ['SPOT'],
    balances: [
        { asset: 'BTC', free: String(btc), locked: String(lockedBtc) },
        { asset: 'USDT', free: String(usdt), locked: '0' },
    ],
});

const trade = (over: Partial<MidoriBinanceSpotTrade> = {}): MidoriBinanceSpotTrade => ({
    id: 1, orderId: 10, orderListId: -1, price: '90000', qty: '0.1', quoteQty: '9000',
    commission: '0', commissionAsset: 'BTC', time: 1_700_000_000_000, isBuyer: true, ...over,
});

const order = (over: Partial<MidoriBinanceSpotOrder> = {}): MidoriBinanceSpotOrder => ({
    symbol: 'BTCUSDT', orderId: 20, orderListId: -1, clientOrderId: 'demo', price: '85000',
    origQty: '0.01', executedQty: '0', status: 'NEW', type: 'LIMIT', side: 'BUY', stopPrice: '0',
    time: 1_700_000_000_000, updateTime: 1_700_000_000_000, ...over,
});

function stub(over: Partial<Window['midori']['binanceSpot']> = {}) {
    const calls: Array<{ name: string; value: unknown }> = [];
    const record = <T>(name: string, result: T) => (value?: unknown): Promise<T> => {
        calls.push({ name, value });
        return Promise.resolve(result);
    };
    const venue = {
        account: record('account', account()),
        openOrders: record('openOrders', [] as MidoriBinanceSpotOrder[]),
        trades: record('trades', [] as MidoriBinanceSpotTrade[]),
        placeOrder: record('placeOrder', {}),
        cancelOrder: record('cancelOrder', {}),
        cancelAll: record('cancelAll', {}),
        replaceProtection: record('replaceProtection', {}),
        close: record('close', {}),
        ...over,
    } as Window['midori']['binanceSpot'];
    (globalThis as { window?: unknown }).window = { midori: { binanceSpot: venue } };
    return { calls, venue };
}

const settle = async (): Promise<void> => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
};

beforeEach(() => {
    delete (globalThis as { window?: unknown }).window;
});

describe('Binance Spot account truth', () => {
    it('draws one long holding from the venue balance and its executions', async () => {
        stub({
            account: () => Promise.resolve(account(0.1)),
            trades: () => Promise.resolve([trade()]),
        });
        const controller = new BinanceSpotController({ symbol: 'BTCUSDT', info, notify: vi.fn() });
        controller.mark(95_000);
        controller.refreshVisuals();
        await settle();
        expect(controller.positions()).toMatchObject([{ size: 0.1, entryPrice: 90_000 }]);
        expect(controller.equity()).toBe(19_500);
    });

    it('keeps the last known holding when the venue stops answering', async () => {
        let fails = false;
        stub({
            account: () => fails ? Promise.reject(new Error('offline')) : Promise.resolve(account(0.1)),
            trades: () => Promise.resolve([trade()]),
        });
        const controller = new BinanceSpotController({ symbol: 'BTCUSDT', info, notify: vi.fn() });
        controller.mark(95_000);
        controller.refreshVisuals();
        await settle();
        fails = true;
        controller.refreshVisuals();
        await settle();
        expect(controller.positions()).toHaveLength(1);
        expect(controller.isStale()).toBe(true);
    });
});

describe('Binance Spot instructions', () => {
    it('sends base quantity and maps the three ticket order types', async () => {
        const { calls } = stub();
        const controller = new BinanceSpotController({ symbol: 'BTCUSDT', info, notify: vi.fn() });
        controller.mark(90_000);
        controller.order({ side: 'buy', type: 'limit', size: 0.012347, limitPrice: 85_000 });
        controller.order({ side: 'buy', size: 0.001 });
        controller.order({ side: 'buy', type: 'stop', size: 0.001, stopPrice: 95_000 });
        await settle();
        const sent = calls.filter((call) => call.name === 'placeOrder').map((call) => call.value);
        expect(sent[0]).toMatchObject({
            symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01234, price: 85_000,
        });
        expect(sent[1]).toMatchObject({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.001 });
        expect(sent[2]).toMatchObject({ symbol: 'BTCUSDT', side: 'BUY', type: 'STOP_LOSS', quantity: 0.001, stopPrice: 95_000 });
    });

    it('snaps a size DOWN on a step JavaScript prints in exponent form, never up', async () => {
        /* `String(1e-7)` is "1e-7", so counting decimals after the dot says none — and
         * `(0.5).toFixed(0)` is "1". Reading the step wrongly does not merely lose precision
         * here; it turns a floor into a round, and sends an order twice the size asked for. */
        const fine = { ...info, stepSize: 1e-7, minQty: 1e-7, marketStepSize: 1e-7, marketMinQty: 1e-7 };
        const { calls } = stub();
        const controller = new BinanceSpotController({ symbol: 'BTCUSDT', info: fine, notify: vi.fn() });
        controller.mark(90_000);
        controller.order({ side: 'buy', size: 0.5 });
        controller.order({ side: 'buy', size: 1.23456789 });
        await settle();
        const sent = calls.filter((call) => call.name === 'placeOrder').map((call) => call.value);
        expect(sent[0]).toMatchObject({ quantity: 0.5 });
        expect(sent[1]).toMatchObject({ quantity: 1.2345678 });
    });

    it('reads a step\'s precision out of its exponent form', () => {
        expect(decimalPlaces(0.00001)).toBe(5);
        expect(decimalPlaces(1e-8)).toBe(8);
        expect(decimalPlaces(1)).toBe(0);
    });

    it('refuses a short instead of selling more base asset than is free', async () => {
        stub({ account: () => Promise.resolve(account(0.01)) });
        const controller = new BinanceSpotController({ symbol: 'BTCUSDT', info, notify: vi.fn() });
        controller.mark(90_000);
        controller.refreshVisuals();
        await settle();
        expect(() => controller.order({ side: 'sell', size: 0.02 })).toThrow('can only sell');
    });

    it('replaces server-side protection with the untouched level preserved', async () => {
        const protective = [
            order({ orderId: 30, orderListId: 5, side: 'SELL', type: 'STOP_LOSS', stopPrice: '85000' }),
            order({ orderId: 31, orderListId: 5, side: 'SELL', type: 'TAKE_PROFIT', stopPrice: '100000' }),
        ];
        const { calls } = stub({
            account: () => Promise.resolve(account(0, 10_000, 0.1)),
            openOrders: () => Promise.resolve(protective),
            trades: () => Promise.resolve([trade()]),
        });
        const controller = new BinanceSpotController({ symbol: 'BTCUSDT', info, notify: vi.fn() });
        controller.mark(95_000);
        controller.refreshVisuals();
        await settle();
        controller.protect({ stopLoss: 86_000 }, 1);
        await settle();
        expect(calls.find((call) => call.name === 'replaceProtection')?.value).toMatchObject({
            quantity: 0.1, stopLoss: 86_000, takeProfit: 100_000,
            orders: [{ orderId: 30, orderListId: 5 }, { orderId: 31, orderListId: 5 }],
        });
    });
});

describe('Spot cost basis', () => {
    it('keeps the average cost of what remains after a partial sell', () => {
        const basis = spotAverageCost([
            trade({ id: 1, qty: '0.1', quoteQty: '9000', price: '90000' }),
            trade({ id: 2, qty: '0.1', quoteQty: '10000', price: '100000', time: 1_700_000_000_100 }),
            trade({ id: 3, qty: '0.05', quoteQty: '5500', price: '110000', isBuyer: false, time: 1_700_000_000_200 }),
        ], 'BTC', 'USDT');
        expect(basis.quantity).toBeCloseTo(0.15);
        expect(basis.price).toBeCloseTo(95_000);
    });
});
