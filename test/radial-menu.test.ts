import { describe, expect, it } from 'vitest';
import { annularSectorPath, radialSectorIndex } from '../src/renderers/native/drawings/RadialToolMenu';
import {
    DEFAULT_RADIAL_MENU_PREFS,
    normalizeRadialMenuPrefs,
} from '../app/renderer/settings/radialMenuPrefs';

describe('radial tool menu geometry', () => {
    it('maps vectors clockwise from a top-centred first segment', () => {
        expect(radialSectorIndex(0, -100, 10, 20)).toBe(0);
        expect(radialSectorIndex(Math.cos(-Math.PI / 10) * 100, Math.sin(-Math.PI / 10) * 100, 10, 20)).toBe(2);
        expect(radialSectorIndex(Math.cos(Math.PI / 10) * 100, Math.sin(Math.PI / 10) * 100, 10, 20)).toBe(3);
        expect(radialSectorIndex(0, 100, 10, 20)).toBe(5);
        expect(radialSectorIndex(Math.cos(Math.PI * 0.9) * 100, Math.sin(Math.PI * 0.9) * 100, 10, 20)).toBe(7);
        expect(radialSectorIndex(4, 4, 10, 20)).toBe(-1);
    });

    it('builds a closed annular path for every configured segment', () => {
        for (let index = 0; index < 10; index++) {
            const path = annularSectorPath(index, 10);
            expect(path.startsWith('M ')).toBe(true);
            expect(path.endsWith(' Z')).toBe(true);
        }
    });
});

describe('radial menu preferences', () => {
    it('keeps valid tools and pointer slots while repairing invalid entries individually', () => {
        const result = normalizeRadialMenuPrefs({ slots: ['ray', null, 'not-a-tool'] });
        expect(result.slots[0]).toBe('ray');
        expect(result.slots[1]).toBeNull();
        expect(result.slots[2]).toBe(DEFAULT_RADIAL_MENU_PREFS.slots[2]);
        expect(result.slots).toHaveLength(10);
    });
});
