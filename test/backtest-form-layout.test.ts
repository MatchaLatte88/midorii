import { describe, expect, it } from 'vitest';

import { groupBacktestParams } from '../app/renderer/backtest/formLayout';
import type { StrategyParam } from '../app/renderer/strategies';

function param(key: string): StrategyParam {
    return { key, label: key, type: 'number', default: 1 };
}

describe('backtest form hierarchy', () => {
    it('keeps shared risk controls visible and puts signal controls under Advanced', () => {
        const grouped = groupBacktestParams([
            param('riskMode'),
            param('riskValue'),
            param('maxLeverage'),
            param('rrr'),
            param('signalWindow'),
            param('confirmationBars'),
        ]);

        expect(grouped.common.map(({ key }) => key)).toEqual([
            'riskMode',
            'riskValue',
            'maxLeverage',
            'rrr',
        ]);
        expect(grouped.advanced.map(({ key }) => key)).toEqual([
            'signalWindow',
            'confirmationBars',
        ]);
    });
});
