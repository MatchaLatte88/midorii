import { describe, expect, it } from 'vitest';

import {
    accountTopbarMetrics,
    type AccountTopbarSnapshot,
} from '../app/renderer/shell/accountTopbarModel';

function snapshot(overrides: Partial<AccountTopbarSnapshot> = {}): AccountTopbarSnapshot {
    return {
        context: 'live',
        balance: 10_125,
        limit: { label: 'MLL', value: 1_750, title: 'Maximum loss room' },
        realised: -75.5,
        unrealised: 11,
        currency: 'USD',
        ...overrides,
    };
}

describe('account topbar presentation', () => {
    it('keeps realised and unrealised results separate and directional', () => {
        const metrics = accountTopbarMetrics(snapshot());

        expect(metrics).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'balance', label: 'BAL USD', value: '10,125.00', tone: null }),
            expect.objectContaining({ id: 'realised', value: '−75.50', tone: 'down' }),
            expect.objectContaining({ id: 'unrealised', value: '+11.00', tone: 'up' }),
        ]));
    });

    it('shows unavailable venue figures as unknown instead of inventing zero', () => {
        const metrics = accountTopbarMetrics(snapshot({ realised: null, unrealised: null }));

        expect(metrics.find((metric) => metric.id === 'realised')).toMatchObject({ value: '—', tone: null });
        expect(metrics.find((metric) => metric.id === 'unrealised')).toMatchObject({ value: '—', tone: null });
    });

    it('presents backtest drawdown as a loss while retaining its positive magnitude', () => {
        const metrics = accountTopbarMetrics(snapshot({
            context: 'backtest',
            limit: { label: 'MDD', value: 625.25, title: 'Maximum drawdown' },
        }));

        expect(metrics.find((metric) => metric.id === 'limit')).toMatchObject({
            label: 'MDD',
            value: '−625.25',
            tone: 'down',
        });
    });

    it('marks an exhausted live loss limit without colouring healthy room as profit', () => {
        const healthy = accountTopbarMetrics(snapshot());
        const breached = accountTopbarMetrics(snapshot({
            limit: { label: 'DLL', value: -20, title: 'Daily loss room' },
        }));

        expect(healthy.find((metric) => metric.id === 'limit')?.tone).toBeNull();
        expect(breached.find((metric) => metric.id === 'limit')).toMatchObject({ value: '−20.00', tone: 'down' });
    });
});
