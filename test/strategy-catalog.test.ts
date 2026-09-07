import { describe, it, expect } from 'vitest';
import { RISK_PARAM_KEYS, STRATEGIES, describeParams, strategyCatalog } from '../app/renderer/strategies';

/**
 * What the strategy library promises about everything in it.
 *
 * The line these guard is the one that makes the app's two halves mean different things: an
 * indicator describes the market and stops, a strategy commits to an entry, a stop, a
 * target and a size. Anything registered here has to be able to state all four — a
 * "strategy" that cannot is an indicator with ambitions, and nothing downstream (the
 * backtest, a sweep, one day a bot) can automate it.
 */

describe('every registered strategy', () => {
    const specs = strategyCatalog();

    it('is registered under the id it names', () => {
        for (const [id, spec] of Object.entries(STRATEGIES)) expect(spec.id).toBe(id);
        expect(specs.length).toBeGreaterThan(0);
    });

    it('commits to an entry, a stop, a target and a size', () => {
        for (const spec of specs) {
            expect(spec.rules, `${spec.id} states no rules`).toBeDefined();
            expect(spec.rules!.entry.length).toBeGreaterThan(20);
            expect(spec.rules!.stop.length).toBeGreaterThan(20);
            expect(spec.rules!.target.length).toBeGreaterThan(20);
            expect(spec.rules!.size.length).toBeGreaterThan(20);
            // A strategy with no preconditions would trade every bar.
            expect(spec.rules!.conditions.length).toBeGreaterThan(0);
        }
    });

    it('asks the same four questions about risk as every other one', () => {
        // Two runs that named their risk differently would not be comparable, which is the
        // whole reason the library stores them.
        for (const spec of specs) {
            const keys = spec.params.map((p) => p.key);
            for (const shared of RISK_PARAM_KEYS) expect(keys).toContain(shared);
        }
    });

    it('gives every setting a label and a default', () => {
        for (const spec of specs) {
            for (const param of spec.params) {
                expect(param.label, `${spec.id}.${param.key}`).toBeTruthy();
                expect(param.default, `${spec.id}.${param.key}`).toBeDefined();
                if (param.type === 'select' || param.type === 'multi') {
                    expect(param.options?.length, `${spec.id}.${param.key}`).toBeGreaterThan(0);
                }
            }
        }
    });

    it('names only settings it actually has as changing what it detects', () => {
        for (const spec of specs) {
            const keys = spec.params.map((p) => p.key);
            for (const key of spec.detectionKeys ?? []) expect(keys).toContain(key);
            // Risk is about what is done with a setup, never about which ones exist.
            for (const shared of RISK_PARAM_KEYS) expect(spec.detectionKeys ?? []).not.toContain(shared);
        }
    });
});

describe('silver bullet as a strategy', () => {
    const spec = STRATEGIES.silverbullet!;

    it('reads the indicator rather than re-detecting what it draws', () => {
        // One definition, two uses: if the strategy detected for itself, the chart and the
        // backtest would eventually disagree about the same market.
        expect(spec.indicator).toBeTruthy();
        expect(spec.indicatorName).toBe('Silver Bullet');
    });

    it('rests a limit order rather than buying the setup bar', () => {
        expect(spec.rules!.entry).toMatch(/limit order/i);
        expect(spec.rules!.entry).toMatch(/never a market order/i);
    });

    it('derives the size from the risk and the stop', () => {
        expect(spec.rules!.size).toMatch(/divided by the distance to the stop/i);
    });
});

describe('settings, as a person reads them back', () => {
    it('prints an option under its label rather than its id', () => {
        const rows = describeParams('silverbullet', {
            riskMode: 'percent',
            riskValue: 1,
            windows: ['london', 'am'],
            minGapSizeUnit: 'points',
        });
        const byLabel = new Map(rows.map((r) => [r.label, r.value]));

        expect(byLabel.get('Risk per trade')).toBe('Percent of equity');
        expect(byLabel.get('Hours')).toBe('London, NY AM');
        expect(byLabel.get('Measured in')).toBe('Points');
        expect(byLabel.get('Risk')).toBe('1');
    });

    it('keeps a setting this build no longer knows rather than dropping it', () => {
        // A run made by an older build has to say what it did.
        const rows = describeParams('silverbullet', { rrr: 2, retiredSetting: 7 });
        expect(rows.find((r) => r.key === 'retiredSetting')?.value).toBe('7');
    });

    it('says nothing at all about a strategy that is gone', () => {
        expect(describeParams('vanished', {})).toEqual([]);
    });

    it('reads a hand-traded session as having no settings, because it has none', () => {
        expect(describeParams('replay', {})).toEqual([]);
    });
});
