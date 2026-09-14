import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, normalizePrefs } from '../app/renderer/settings/prefs';

describe('app preferences', () => {
    it('keeps the experimental feed off for old or malformed stored preferences', () => {
        expect(normalizePrefs(null).experimentalMarketFeed).toBe(false);
        expect(normalizePrefs({ experimentalMarketFeed: 'yes' }).experimentalMarketFeed).toBe(false);
        expect(DEFAULT_PREFS.experimentalMarketFeed).toBe(false);
    });

    it('enables the feed only for an explicit stored true', () => {
        expect(normalizePrefs({ experimentalMarketFeed: true }).experimentalMarketFeed).toBe(true);
    });
});

