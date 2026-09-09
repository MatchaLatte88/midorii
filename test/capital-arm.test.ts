// The gate between a chart and real money. Small surface, and the one rule that matters:
// nothing short of a deliberate act opens it on a live account.
// See app/renderer/trading/capitalArmDialog.ts.
import { describe, it, expect } from 'vitest';
import { typedToConfirm, LIVE_CONFIRM_WORD } from '../app/renderer/trading/capitalArmDialog';

describe('typedToConfirm', () => {
    it('accepts the word, however it was typed', () => {
        // The point is the deliberate act, not the keystrokes.
        expect(typedToConfirm(LIVE_CONFIRM_WORD)).toBe(true);
        expect(typedToConfirm('live')).toBe(true);
        expect(typedToConfirm('  Live  ')).toBe(true);
    });

    it('refuses everything else', () => {
        expect(typedToConfirm('')).toBe(false);
        expect(typedToConfirm(' ')).toBe(false);
        expect(typedToConfirm('yes')).toBe(false);
        expect(typedToConfirm('LIV')).toBe(false);
        // Not a substring match: a stray paste must not arm a real account.
        expect(typedToConfirm('I want LIVE trading')).toBe(false);
    });
});
