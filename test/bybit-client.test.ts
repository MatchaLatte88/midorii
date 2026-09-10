import { beforeEach, describe, expect, it, vi } from 'vitest';
// The main-process client is JavaScript because Electron loads it directly.
// @ts-expect-error no declaration file is needed for this internal module.
import { BYBIT_DEMO_BASE, BYBIT_LIVE_BASE, BYBIT_MARKET_BASE, bybitCancelAll, bybitClose, bybitMarket, bybitPlaceOrder, bybitProbe, bybitSetProtection, bybitTicker, configureBybit, floorToStep, hmacSignature, parseBybitInstrument } from '../app/electron/data/bybit.js';

const spotRules = {
    list: [{
        symbol: 'BTCUSDT', status: 'Trading', baseCoin: 'BTC', quoteCoin: 'USDT',
        priceFilter: { tickSize: '0.01' },
        lotSizeFilter: { basePrecision: '0.000001', minOrderQty: '0.000048', maxOrderQty: '71', minOrderAmt: '1' },
    }],
};

const linearRules = {
    list: [{
        symbol: 'BTCUSDT', status: 'Trading', baseCoin: 'BTC', quoteCoin: 'USDT', settleCoin: 'USDT',
        priceFilter: { tickSize: '0.1' },
        lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001', maxOrderQty: '100', minNotionalValue: '5' },
        leverageFilter: { maxLeverage: '100' },
    }],
};

/** Bybit answers HTTP 200 for a refusal too — the retCode is the verdict. */
const ok = (result: unknown): Response => new Response(
    JSON.stringify({ retCode: 0, retMsg: 'OK', result, time: Date.now() }),
    { status: 200, headers: { 'content-type': 'application/json' } },
);
const refused = (retCode: number, retMsg: string, status = 200): Response => new Response(
    JSON.stringify({ retCode, retMsg, result: {}, time: Date.now() }),
    { status, headers: { 'content-type': 'application/json' } },
);
const clock = (): Response => ok({ timeSecond: String(Math.floor(Date.now() / 1000)), timeNano: String(Date.now() * 1e6) });

/** The JSON body a POST was signed over and sent with. */
const bodyOf = (call: [unknown, RequestInit | undefined]): Record<string, unknown> => (
    JSON.parse(String(call[1]?.body))
);

beforeEach(() => {
    vi.restoreAllMocks();
    configureBybit({ apiKey: 'demo-key', secretKey: 'demo-secret', env: 'demo' });
});

describe('Bybit host boundary', () => {
    it('keeps the demo and live hosts apart, and reads prices from the public one', () => {
        expect(BYBIT_DEMO_BASE).toBe('https://api-demo.bybit.com');
        expect(BYBIT_LIVE_BASE).toBe('https://api.bybit.com');
        expect(BYBIT_MARKET_BASE).toBe(BYBIT_LIVE_BASE);
    });

    it('sends a signed call to the host the stored credentials name, not a caller-chosen one', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(clock())
            .mockResolvedValueOnce(ok({ readOnly: 0, permissions: { Spot: ['SpotTrade'] }, userID: '42' }))
            .mockResolvedValueOnce(ok({ list: [{ totalEquity: '1000' }] }));
        await bybitProbe({ apiKey: 'candidate', secretKey: 'candidate-secret', env: 'live' });
        expect(String(fetch.mock.calls[0]![0])).toBe(`${BYBIT_MARKET_BASE}/v5/market/time`);
        expect(String(fetch.mock.calls[1]![0])).toMatch(/^https:\/\/api\.bybit\.com\/v5\/user\/query-api/);
        // The secret signs the request; it never travels in one.
        expect(String(fetch.mock.calls[1]![0])).not.toContain('candidate-secret');
        expect(JSON.stringify(fetch.mock.calls[1]![1]?.headers)).not.toContain('candidate-secret');
    });

    it('signs timestamp + key + recvWindow + payload, as the venue specifies', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(clock())
            .mockResolvedValueOnce(ok({ readOnly: 0, permissions: { ContractTrade: ['Order'] } }))
            .mockResolvedValueOnce(ok({ list: [] }));
        await bybitProbe({ apiKey: 'candidate', secretKey: 'candidate-secret', env: 'demo' });
        const headers = fetch.mock.calls[2]![1]?.headers as Record<string, string>;
        const expected = hmacSignature(
            'candidate-secret',
            `${headers['X-BAPI-TIMESTAMP']}candidate${headers['X-BAPI-RECV-WINDOW']}accountType=UNIFIED`,
        );
        expect(headers['X-BAPI-SIGN']).toBe(expected);
        expect(headers['X-BAPI-API-KEY']).toBe('candidate');
    });

    it('refuses a read-only key where it is typed, rather than at the first order', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(clock())
            .mockResolvedValueOnce(ok({ readOnly: 1, permissions: { Spot: ['SpotTrade'] } }));
        await expect(bybitProbe({ apiKey: 'k', secretKey: 's', env: 'demo' })).rejects.toThrow('read-only');
    });

    it('treats a non-zero retCode on HTTP 200 as the refusal it is', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(refused(10001, 'params error'));
        await expect(bybitPlaceOrder({
            category: 'spot', symbol: 'BTCUSDT', side: 'Buy', type: 'Market', qty: 0.01,
        })).rejects.toThrow('10001');
    });
});

describe('Bybit market naming', () => {
    it('reads the app\'s .P suffix as the perpetual and everything else as the pair', () => {
        expect(bybitMarket('BTCUSDT')).toEqual({ category: 'spot', symbol: 'BTCUSDT' });
        expect(bybitMarket('btcusdt.p')).toEqual({ category: 'linear', symbol: 'BTCUSDT' });
        expect(bybitTicker('linear', 'ETHUSDT')).toBe('ETHUSDT.P');
        expect(bybitTicker('spot', 'ETHUSDT')).toBe('ETHUSDT');
    });

    it('reads both products\' rules into the same six numbers', () => {
        const spot = parseBybitInstrument(spotRules, 'spot', 'BTCUSDT');
        expect(spot).toMatchObject({
            category: 'spot', baseAsset: 'BTC', quoteAsset: 'USDT', settleAsset: null,
            tickSize: 0.01, stepSize: 0.000001, minNotional: 1,
        });
        const linear = parseBybitInstrument(linearRules, 'linear', 'BTCUSDT');
        expect(linear).toMatchObject({
            category: 'linear', settleAsset: 'USDT', tickSize: 0.1, stepSize: 0.001, minNotional: 5,
        });
    });

    it('floors a size onto the step, so snapping never raises what is risked', () => {
        expect(floorToStep(0.1234567891, 0.000001)).toBe(0.123456);
        expect(floorToStep(0.0019, 0.001)).toBe(0.001);
    });
});

describe('Bybit orders', () => {
    it('sizes a spot market buy in BASE units, which is not the venue\'s own default', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(ok(spotRules))
            .mockResolvedValueOnce(clock())
            .mockResolvedValueOnce(ok({ orderId: '1' }));
        await bybitPlaceOrder({ category: 'spot', symbol: 'BTCUSDT', side: 'Buy', type: 'Market', qty: 0.01 });
        const body = bodyOf(fetch.mock.calls[2] as [unknown, RequestInit]);
        expect(body).toMatchObject({ category: 'spot', side: 'Buy', orderType: 'Market', qty: '0.010000', marketUnit: 'baseCoin' });
    });

    it('hands a perpetual entry its stop and target in the same call, so it is never unprotected', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(ok(linearRules))
            .mockResolvedValueOnce(clock())
            .mockResolvedValueOnce(ok({ orderId: '1' }));
        await bybitPlaceOrder({
            category: 'linear', symbol: 'BTCUSDT', side: 'Buy', type: 'Market', qty: 0.01,
            bracket: { stopLoss: 85_000, takeProfit: 100_000 },
        });
        const body = bodyOf(fetch.mock.calls[2] as [unknown, RequestInit]);
        expect(body).toMatchObject({
            category: 'linear', positionIdx: 0, tpslMode: 'Full', stopLoss: '85000.0', takeProfit: '100000.0',
        });
    });

    it('reads a stop entry\'s trigger direction off the market rather than guessing it', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(ok(linearRules))
            .mockResolvedValueOnce(clock())
            .mockResolvedValueOnce(ok({ orderId: '1' }));
        await bybitPlaceOrder({
            category: 'linear', symbol: 'BTCUSDT', side: 'Buy', type: 'Market', qty: 0.01,
            triggerPrice: 95_000, reference: 90_000,
        });
        // The trigger sits above the market, so it is reached by price RISING into it.
        expect(bodyOf(fetch.mock.calls[2] as [unknown, RequestInit])).toMatchObject({ triggerDirection: 1, triggerPrice: '95000.0' });
    });

    it('follows a spot market buy with its protection, and blames the protection when that fails', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(ok(spotRules))
            .mockResolvedValueOnce(clock())
            .mockResolvedValueOnce(ok({ orderId: '99' }))
            .mockResolvedValueOnce(refused(10001, 'no execution found'));
        await expect(bybitPlaceOrder({
            category: 'spot', symbol: 'BTCUSDT', side: 'Buy', type: 'Market', qty: 0.01,
            bracket: { stopLoss: 85_000 },
        })).rejects.toThrow('went in, but its protection was not placed');
    });

    it('refuses spot protection it cannot actually attach, rather than dropping it', async () => {
        // A fresh Response per call: a body can only be read once.
        vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(ok(spotRules)));
        await expect(bybitPlaceOrder({
            category: 'spot', symbol: 'BTCUSDT', side: 'Sell', type: 'Market', qty: 0.01,
            bracket: { stopLoss: 85_000 },
        })).rejects.toThrow('cannot open a short or carry protection');
        await expect(bybitPlaceOrder({
            category: 'spot', symbol: 'BTCUSDT', side: 'Buy', type: 'Market', qty: 0.01,
            triggerPrice: 95_000, bracket: { stopLoss: 85_000 },
        })).rejects.toThrow('stop-entry cannot carry protection');
    });

    it('says an instruction\'s fate is unknown rather than that it failed', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(ok(linearRules))
            .mockResolvedValueOnce(clock())
            .mockRejectedValueOnce(new Error('socket hang up'));
        await expect(bybitPlaceOrder({
            category: 'linear', symbol: 'BTCUSDT', side: 'Buy', type: 'Market', qty: 0.01,
        })).rejects.toThrow('did not confirm what became');
    });
});

describe('Bybit protection and closing', () => {
    it('sets both of a perpetual\'s levels in one call, clearing an absent one with the venue\'s own zero', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(ok(linearRules))
            .mockResolvedValueOnce(clock())
            .mockResolvedValueOnce(ok({}));
        await bybitSetProtection({ category: 'linear', symbol: 'BTCUSDT', stopLoss: 85_000 });
        const call = fetch.mock.calls[2] as [unknown, RequestInit];
        expect(String(call[0])).toContain('/v5/position/trading-stop');
        expect(bodyOf(call)).toMatchObject({ stopLoss: '85000.0', takeProfit: '0', tpslMode: 'Full', positionIdx: 0 });
    });

    it('cancels the old spot protection before placing the new one, and says so if the second half fails', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(ok(spotRules))
            .mockResolvedValueOnce(clock())
            .mockResolvedValueOnce(ok({ orderId: 'old' }))
            .mockResolvedValueOnce(refused(10001, 'insufficient balance'));
        await expect(bybitSetProtection({
            category: 'spot', symbol: 'BTCUSDT', quantity: 0.01, orders: ['old'], stopLoss: 85_000,
        })).rejects.toThrow('cancelled, but its replacement was not placed');
        expect(String(fetch.mock.calls[2]![0])).toContain('/v5/order/cancel');
    });

    it('closes a short perpetual by buying the same size back, reduce-only', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(ok(linearRules))
            .mockResolvedValueOnce(clock())
            .mockResolvedValueOnce(ok({ list: [] }))
            .mockResolvedValueOnce(ok({ list: [{ side: 'Sell', size: '0.005' }] }))
            .mockResolvedValueOnce(ok({ orderId: '2' }));
        await bybitClose('linear', 'BTCUSDT');
        expect(bodyOf(fetch.mock.calls[4] as [unknown, RequestInit])).toMatchObject({
            side: 'Buy', qty: '0.005', reduceOnly: true, orderType: 'Market',
        });
    });

    it('treats "nothing was open" as the state cancel-all was asked for', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(clock())
            .mockResolvedValueOnce(refused(110001, 'order does not exist'));
        await expect(bybitCancelAll('linear', 'BTCUSDT')).resolves.toEqual({ list: [] });
    });
});
