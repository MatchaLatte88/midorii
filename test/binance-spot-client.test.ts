import { beforeEach, describe, expect, it, vi } from 'vitest';
// The main-process client is JavaScript because Electron loads it directly.
// @ts-expect-error no declaration file is needed for this internal module.
import { BINANCE_SPOT_DEMO_BASE, binanceSpotClose, binanceSpotPlaceOrder, binanceSpotProbe, configureBinanceSpot, floorToStep, hmacSignature, parseBinanceSpotSymbol } from '../app/electron/data/binanceSpot.js';

const rules = {
    symbols: [{
        symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT',
        orderTypes: ['LIMIT', 'MARKET', 'STOP_LOSS'], ocoAllowed: true, otoAllowed: true,
        filters: [
            { filterType: 'PRICE_FILTER', tickSize: '0.01000000' },
            { filterType: 'LOT_SIZE', minQty: '0.00001000', maxQty: '9000', stepSize: '0.00001000' },
            { filterType: 'MARKET_LOT_SIZE', minQty: '0.00000000', maxQty: '120', stepSize: '0.00000000' },
            { filterType: 'NOTIONAL', minNotional: '5.00000000' },
        ],
    }],
};

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
});

beforeEach(() => {
    configureBinanceSpot({ apiKey: 'demo-key', secretKey: 'demo-secret' });
    vi.restoreAllMocks();
});

describe('Binance Spot Demo boundary', () => {
    it('has one immutable demo base URL', () => {
        expect(BINANCE_SPOT_DEMO_BASE).toBe('https://demo-api.binance.com/api');
        expect(BINANCE_SPOT_DEMO_BASE).not.toBe('https://api.binance.com/api');
    });

    it('produces a deterministic HMAC-SHA-256 signature', () => {
        expect(hmacSignature('key', 'The quick brown fox jumps over the lazy dog'))
            .toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
    });

    it('reads the symbol filters and floors quantities without raising risk', () => {
        const info = parseBinanceSpotSymbol(rules, 'BTCUSDT');
        expect(info).toMatchObject({ baseAsset: 'BTC', quoteAsset: 'USDT', tickSize: 0.01, stepSize: 0.00001 });
        expect(floorToStep(0.12345678, info.stepSize)).toBe(0.12345);
    });

    it('tests credentials with the demo clock and a signed Spot account read', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(json({ serverTime: Date.now() }))
            .mockResolvedValueOnce(json({ canTrade: true, permissions: ['SPOT'], balances: [], accountType: 'SPOT' }));
        const account = await binanceSpotProbe({ apiKey: 'candidate', secretKey: 'candidate-secret' });
        expect(account.canTrade).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(String(fetch.mock.calls[0]![0])).toBe(`${BINANCE_SPOT_DEMO_BASE}/v3/time`);
        expect(String(fetch.mock.calls[1]![0])).toMatch(/^https:\/\/demo-api\.binance\.com\/api\/v3\/account\?/);
        expect(fetch.mock.calls[1]![1]?.headers).toMatchObject({ 'X-MBX-APIKEY': 'candidate' });
        expect(String(fetch.mock.calls[1]![0])).not.toContain('candidate-secret');
    });

    it('uses an OPOCO so a limit buy and both exits are held together at the venue', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(json(rules))
            .mockResolvedValueOnce(json({ serverTime: Date.now() }))
            .mockResolvedValueOnce(json({ orderListId: 7, orders: [] }));
        await binanceSpotPlaceOrder({
            symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.01, price: 90_000,
            bracket: { stopLoss: 85_000, takeProfit: 100_000 },
        });
        const url = new URL(String(fetch.mock.calls[2]![0]));
        expect(`${url.origin}${url.pathname}`).toBe(`${BINANCE_SPOT_DEMO_BASE}/v3/orderList/opoco`);
        expect(url.searchParams.get('workingSide')).toBe('BUY');
        expect(url.searchParams.get('pendingSide')).toBe('SELL');
        expect(url.searchParams.get('pendingAboveType')).toBe('TAKE_PROFIT');
        expect(url.searchParams.get('pendingBelowType')).toBe('STOP_LOSS');
    });

    it('describes an unknown mutation outcome without claiming the order failed', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(json(rules))
            .mockResolvedValueOnce(json({ serverTime: Date.now() }))
            .mockResolvedValueOnce(json({ code: -1007, msg: 'Timeout waiting for response' }, 504));
        await expect(binanceSpotPlaceOrder({
            symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.01,
        })).rejects.toThrow('did not confirm what became');
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('still closes a holding when cancel-all reports that there are no open orders', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(json(rules))
            .mockResolvedValueOnce(json({ serverTime: Date.now() }))
            .mockResolvedValueOnce(json({ code: -2011, msg: 'Unknown order sent.' }, 400))
            .mockResolvedValueOnce(json({
                canTrade: true, permissions: ['SPOT'], accountType: 'SPOT',
                balances: [{ asset: 'BTC', free: '0.00100000', locked: '0.00000000' }],
            }))
            .mockResolvedValueOnce(json({ status: 'FILLED', side: 'SELL', executedQty: '0.00100000' }));

        await expect(binanceSpotClose('BTCUSDT')).resolves.toMatchObject({ status: 'FILLED', side: 'SELL' });
        const sell = new URL(String(fetch.mock.calls[4]![0]));
        expect(sell.pathname).toBe('/api/v3/order');
        expect(sell.searchParams.get('side')).toBe('SELL');
        expect(sell.searchParams.get('type')).toBe('MARKET');
    });
});
