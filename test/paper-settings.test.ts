// The two rules a paper account's settings actually carry.
//
// One: some settings describe the ACCOUNT and cannot be changed under it — an account
// charged 0.1% for a month cannot be retroactively charged 0.02%, because the trades
// already happened at the old price. The dialog's button says which those are, and
// `needsFreshAccount` is what it asks.
//
// Two: settings come back from storage, which is data from outside the program. A
// balance of zero would be taken by the Broker as an error at the first click.
import { describe, expect, it } from 'vitest';

import {
    DEFAULT_PAPER_SETTINGS,
    bracketsOf,
    costsOf,
    needsFreshAccount,
    normalizeSettings,
    positionModeOf,
    riskOf,
    type PaperSettings,
} from '../app/renderer/trading/paperSettings';
import { catchUpLabel, catchUpTimeframe } from '../app/renderer/trading/paperCatchUp';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function settings(over: Partial<PaperSettings> = {}): PaperSettings {
    return { ...DEFAULT_PAPER_SETTINGS, ...over };
}

describe('what starts a fresh account', () => {
    it('leaves the account alone for a change to how a trade is sized', () => {
        const before = settings();
        expect(needsFreshAccount(before, settings({ maxLeverage: 5 }))).toBe(false);
        expect(needsFreshAccount(before, settings({ riskValue: 2 }))).toBe(false);
        expect(needsFreshAccount(before, settings({ riskMode: 'fixed' }))).toBe(false);
    });

    it('starts again for anything baked into the account itself', () => {
        const before = settings();
        expect(needsFreshAccount(before, settings({ balance: 25_000 }))).toBe(true);
        expect(needsFreshAccount(before, settings({ feeRate: 0.0005 }))).toBe(true);
        expect(needsFreshAccount(before, settings({ spreadPct: 0 }))).toBe(true);
        expect(needsFreshAccount(before, settings({ slippagePct: 0 }))).toBe(true);
        expect(needsFreshAccount(before, settings({ hedging: false }))).toBe(true);
    });

    it('hands the two halves to the two places that read them', () => {
        const s = settings({ feeRate: 0.002, spreadPct: 0.001, slippagePct: 0, hedging: false, maxLeverage: 3 });
        expect(costsOf(s)).toEqual({ feeRate: 0.002, spreadPct: 0.001, slippagePct: 0 });
        expect(positionModeOf(s)).toBe('netting');
        expect(riskOf(s)).toEqual({ mode: 'percent', value: 1, maxLeverage: 3 });
    });
});

describe('settings coming back from storage', () => {
    it('falls back to the defaults for nothing at all', () => {
        expect(normalizeSettings(null)).toEqual(DEFAULT_PAPER_SETTINGS);
        expect(normalizeSettings({})).toEqual(DEFAULT_PAPER_SETTINGS);
    });

    it('refuses a value the Broker would throw on', () => {
        const out = normalizeSettings({ balance: 0, feeRate: -1, maxLeverage: 0, riskValue: 'x' });
        expect(out.balance).toBe(DEFAULT_PAPER_SETTINGS.balance);
        expect(out.feeRate).toBe(DEFAULT_PAPER_SETTINGS.feeRate);
        expect(out.maxLeverage).toBe(DEFAULT_PAPER_SETTINGS.maxLeverage);
        expect(out.riskValue).toBe(DEFAULT_PAPER_SETTINGS.riskValue);
    });

    it('keeps what it can read', () => {
        const out = normalizeSettings({ balance: 50_000, hedging: false, riskMode: 'fixed', riskValue: 250 });
        expect(out.balance).toBe(50_000);
        expect(out.hedging).toBe(false);
        expect(out.riskMode).toBe('fixed');
        expect(out.riskValue).toBe(250);
    });

    it('brings back the way the ticket was last sized, and defaults it to units', () => {
        // Set by using the panel rather than by typing it anywhere, so a record written by a
        // version that had no such field — and one carrying nonsense — both mean the default.
        expect(normalizeSettings({ sizingMode: 'risk' }).sizingMode).toBe('risk');
        expect(normalizeSettings({ sizingMode: 'fixed' }).sizingMode).toBe('fixed');
        expect(normalizeSettings({}).sizingMode).toBe('fixed');
        expect(normalizeSettings({ sizingMode: 'units' }).sizingMode).toBe('fixed');
    });
});

describe('how finely a gap is rechecked', () => {
    it('comes back to the minute for a short absence', () => {
        expect(catchUpTimeframe(0)).toBe('1');
        expect(catchUpTimeframe(2 * HOUR)).toBe('1');
    });

    it('coarsens rather than asking for bars no provider would answer with', () => {
        // A day of minutes is 1440 bars — past one request, so five-minute bars.
        expect(catchUpTimeframe(DAY)).toBe('5');
        expect(catchUpTimeframe(7 * DAY)).toBe('15');
        expect(catchUpTimeframe(60 * DAY)).toBe('240');
    });

    it('stops at the coarsest there is rather than giving up', () => {
        expect(catchUpTimeframe(10 * 365 * DAY)).toBe('D');
    });

    it('says the timeframe the way a sentence would', () => {
        expect(catchUpLabel('1')).toBe('1m');
        expect(catchUpLabel('60')).toBe('1h');
        expect(catchUpLabel('240')).toBe('4h');
        expect(catchUpLabel('D')).toBe('1D');
    });
});

describe('what a fresh ticket arrives with', () => {
    it('hands the ticket its own half of the settings', () => {
        const s = settings({ autoBrackets: true, bracketUnit: 'cash', bracketStop: 12, bracketTarget: 30 });
        expect(bracketsOf(s)).toEqual({ on: true, unit: 'cash', stop: 12, target: 30 });
    });

    it('is off on a fresh install', () => {
        // A stop nobody asked for is a stop nobody chose the distance of.
        expect(bracketsOf(DEFAULT_PAPER_SETTINGS).on).toBe(false);
    });

    it('changes nothing about the account itself', () => {
        // These are how a trade is entered, not what the account IS — no reset.
        const before = settings();
        expect(needsFreshAccount(before, settings({ autoBrackets: true }))).toBe(false);
        expect(needsFreshAccount(before, settings({ bracketStop: 99 }))).toBe(false);
        expect(needsFreshAccount(before, settings({ quickSizes: [2, 4] }))).toBe(false);
    });
});

describe('the quick sizes coming back from storage', () => {
    it('keeps a list it can read, in the order the row needs', () => {
        expect(normalizeSettings({ quickSizes: [5, 1, 5, 3] }).quickSizes).toEqual([1, 3, 5]);
    });

    it('falls back to the defaults for anything it cannot use', () => {
        // A hand-edited entry, or a record from a version that had no such field.
        for (const raw of [undefined, null, 'nonsense', [], [0, -1]]) {
            expect(normalizeSettings({ quickSizes: raw }).quickSizes).toEqual(DEFAULT_PAPER_SETTINGS.quickSizes);
        }
    });

    it('refuses a bracket unit it does not know', () => {
        expect(normalizeSettings({ bracketUnit: 'furlongs' }).bracketUnit).toBe('ticks');
        expect(normalizeSettings({ bracketUnit: 'cash' }).bracketUnit).toBe('cash');
    });

    it('refuses a distance that is not one', () => {
        const d = DEFAULT_PAPER_SETTINGS;
        expect(normalizeSettings({ bracketStop: -5 }).bracketStop).toBe(d.bracketStop);
        expect(normalizeSettings({ bracketTarget: 'soon' }).bracketTarget).toBe(d.bracketTarget);
    });
});
