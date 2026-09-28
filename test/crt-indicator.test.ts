import { describe, expect, it } from 'vitest';
import { buildCrtOutput, crtDescriptor } from '../src/core/native-indicators/crt';
import type { CrtSetup } from '../src/core/analysis/crt';

const setup: CrtSetup = {
    direction: 'bear',
    referenceStartIndex: 0,
    referenceEndIndex: 9,
    referenceStartTime: 0,
    referenceEndTime: 9,
    referenceHigh: 106,
    referenceLow: 98,
    keySource: 'swing',
    keyLevel: 106,
    keyIndex: 4,
    keyTime: 4,
    sweepIndex: 12,
    sweepTime: 12,
    sweepExtreme: 107,
    structureIndex: 7,
    structureTime: 7,
    structureLevel: 98,
    modelIndex: 12,
    modelTime: 12,
    modelTop: 105.5,
    modelBottom: 105,
    entryPrice: 105,
    stop: 107,
    target: 98,
    risk: 2,
    reward: 7,
    rewardRisk: 3.5,
    expiryIndex: 17,
    expiryTime: 17,
    fillIndex: 14,
    fillTime: 14,
    index: 13,
    time: 13,
    outcome: 'target',
    outcomeIndex: 16,
    outcomeTime: 16,
};

const VIEW = {
    bullColor: '#00aa88',
    bearColor: '#ee3344',
    rangeColor: '#888888',
    keyColor: '#e0b400',
    profitColor: '#00cc88',
    lossColor: '#ff4455',
};

describe('CRT native indicator', () => {
    it('draws the range, key, Model 1 and complete risk/reward plan', () => {
        const out = buildCrtOutput([setup], Array.from({ length: 20 }, (_, i) => i), VIEW);

        expect(out.boxes?.map((box) => box.id)).toEqual(expect.arrayContaining([
            expect.stringMatching(/_range$/),
            expect.stringMatching(/_model$/),
            expect.stringMatching(/_risk$/),
            expect.stringMatching(/_reward$/),
        ]));
        expect(out.lines?.map((line) => line.id)).toEqual(expect.arrayContaining([
            expect.stringMatching(/_key$/),
            expect.stringMatching(/_entry$/),
            expect.stringMatching(/_stop$/),
            expect.stringMatching(/_target$/),
        ]));
        expect(out.labels?.[0]?.text).toBe('TS');
    });

    it('is a price overlay with editable inputs', () => {
        expect(crtDescriptor).toMatchObject({ type: 'crt', paneHint: 'price', overlay: true });
        expect(crtDescriptor.inputsSchema().map((input) => input.key)).toEqual(expect.arrayContaining([
            'referenceTimeframe', 'referenceAnchor', 'useSwing', 'internalStrength',
            'orderExpiryBars', 'minimumRewardRisk',
        ]));
    });
});
