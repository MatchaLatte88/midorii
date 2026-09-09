// A refused order arrives from Capital.com as a bare code and nothing else. This is the one
// place that turns it into something a person can act on — and, just as importantly, the place
// that refuses to invent a meaning for a code nobody has documented.
// See app/renderer/trading/venueRefusal.ts.
import { describe, it, expect } from 'vitest';
import { refusalMessage, readableCode } from '../app/renderer/trading/venueRefusal';

describe('readableCode', () => {
    it('turns a screaming code into a phrase', () => {
        expect(readableCode('INSUFFICIENT_FUNDS')).toBe('Insufficient funds');
        expect(readableCode('MARKET_CLOSED')).toBe('Market closed');
    });

    it('handles the dotted shape the venue also uses', () => {
        // The leading "error." says nothing a refusal message has not already said.
        expect(readableCode('error.invalid.stoploss.maxvalue')).toBe('Invalid stoploss maxvalue');
        expect(readableCode('error.invalid.size')).toBe('Invalid size');
    });

    it('leaves a code it cannot break up alone', () => {
        expect(readableCode('REJECTED')).toBe('Rejected');
        expect(readableCode('')).toBe('');
    });
});

describe('refusalMessage', () => {
    it('explains the codes whose meaning follows from their own name', () => {
        const msg = refusalMessage('INSUFFICIENT_FUNDS');
        expect(msg).toContain('Insufficient funds');
        expect(msg).toContain('available margin');
    });

    it('passes an unknown code through in the venue\'s own words', () => {
        // The full set of these is not published. Tidying is allowed; inventing a reason is
        // not — a confident wrong explanation about money is worse than a terse right one.
        const msg = refusalMessage('SOME_UNDOCUMENTED_STATE');
        expect(msg).toBe('The order was refused: Some undocumented state.');
    });

    it('names what was being attempted, so a late rejection still has a cause', () => {
        // The answer can arrive seconds after the press that caused it.
        expect(refusalMessage('MARKET_CLOSED', 'Closing the position')).toContain('Closing the position was refused');
    });

    it('says so plainly when the venue gave no reason at all', () => {
        expect(refusalMessage(null)).toBe('The order was refused, and the venue gave no reason.');
        expect(refusalMessage('')).toContain('gave no reason');
        expect(refusalMessage(undefined)).toContain('gave no reason');
    });

    it('recognises a code whatever case it arrives in', () => {
        expect(refusalMessage('insufficient_funds')).toContain('available margin');
    });
});
