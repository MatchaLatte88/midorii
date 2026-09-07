// The account as the chart draws it — specifically, which of its fills reach the chart.
//
// A paper account outlives the market it is trading: it moves to whatever the chart is showing
// the moment it is flat, and it carries every fill it has ever made with it. Marking those onto
// the new market's candles would draw prices that never happened there, which is the one thing
// a mark on a candle must never do.
import { describe, it, expect } from 'vitest';
import type { Broker } from '../shared/engine/broker.js';
import { visualState } from '../app/renderer/trading/visualState';

interface StandInFill {
    orderId: number;
    time: number;
    price: number;
    side: 'buy' | 'sell';
    symbol?: string;
}

/** A Broker stand-in: only the three lists `visualState` reads. */
function broker(fills: StandInFill[]): Broker {
    return { positions: [], pending: [], fills } as unknown as Broker;
}

const BTC: StandInFill = { orderId: 1, time: 1_000, price: 78_000, side: 'buy', symbol: 'BTCUSDT' };
const ETH: StandInFill = { orderId: 2, time: 2_000, price: 3_100, side: 'sell', symbol: 'ETHUSDT' };

describe('the fills a chart is handed', () => {
    it('hands over every fill when there is no market to tell them apart', () => {
        // A replay: one account, one market, for its whole life.
        const state = visualState(broker([BTC, ETH]), 78_100);
        expect(state.fills?.map((f) => f.id)).toEqual([1, 2]);
    });

    it('keeps another market’s fills off this market’s chart', () => {
        const state = visualState(broker([BTC, ETH]), 3_150, 'ETHUSDT');
        expect(state.fills).toEqual([{ id: 2, time: 2_000, price: 3_100, side: 'sell' }]);
    });

    it('holds back a fill that carries no market rather than guessing at one', () => {
        // Unstamped can only mean a record written before the stamp existed. Drawing it would
        // be asserting where it happened; leaving it out only fails to assert anything.
        const state = visualState(broker([{ ...BTC, symbol: undefined }]), 78_100, 'BTCUSDT');
        expect(state.fills).toEqual([]);
    });
});
