// Every Capital.com order is two steps: the venue takes delivery of the instruction and
// answers with a reference, and only a second call says what became of it. This is the
// reading of that second answer — the single place where "the venue accepted my order" is
// decided. Getting it wrong in the permissive direction reports a refused order as an open
// position, which is the worst thing this app could tell someone.
// See app/electron/data/capital.js.
import { describe, it, expect } from 'vitest';
// @ts-expect-error — capital.js is main-process JavaScript with no type declarations.
import { readConfirmation } from '../app/electron/data/capital.js';

describe('readConfirmation', () => {
    it('reads an accepted deal, and the price it actually filled at', () => {
        const c = readConfirmation({
            dealReference: 'o_fcc7e6c0',
            dealId: '006011e7-0001',
            dealStatus: 'ACCEPTED',
            status: 'OPEN',
            level: 24.285,
            size: 1,
            direction: 'BUY',
        });
        expect(c.accepted).toBe(true);
        expect(c.dealId).toBe('006011e7-0001');
        expect(c.status).toBe('OPEN');
        expect(c.reason).toBeNull();
        // Never the price that was asked for — the fill is its own fact.
        expect(c.level).toBe(24.285);
        expect(c.size).toBe(1);
    });

    it('reads a refusal and keeps the venue\'s own word for it', () => {
        const c = readConfirmation({ dealStatus: 'REJECTED', rejectReason: 'INSUFFICIENT_FUNDS' });
        expect(c.accepted).toBe(false);
        expect(c.reason).toBe('INSUFFICIENT_FUNDS');
        expect(c.dealId).toBeNull();
    });

    it('treats an answer that does not say ACCEPTED as a refusal', () => {
        // The permissive reading of these is the dangerous one: anything short of an explicit
        // acceptance must not open a position in the app's own books.
        expect(readConfirmation({ dealStatus: 'PENDING' }).accepted).toBe(false);
        expect(readConfirmation({ status: 'OPEN' }).accepted).toBe(false);
        expect(readConfirmation({}).accepted).toBe(false);
        expect(readConfirmation(null).accepted).toBe(false);
        expect(readConfirmation(undefined).accepted).toBe(false);
    });

    it('always names a reason when it refused, even if the venue gave none', () => {
        // A refusal with an empty explanation still has to read as a refusal to whoever shows
        // it — `null` here would print as "the order failed because null".
        expect(readConfirmation({ dealStatus: 'REJECTED' }).reason).toBe('REJECTED');
        expect(readConfirmation({}).reason).toBeTruthy();
    });

    it('takes the reason from whichever field the venue used', () => {
        expect(readConfirmation({ dealStatus: 'REJECTED', reason: 'MARKET_CLOSED' }).reason).toBe('MARKET_CLOSED');
        expect(readConfirmation({ dealStatus: 'REJECTED', errorCode: 'error.invalid.size' }).reason).toBe('error.invalid.size');
    });

    it('does not invent a fill price that was not reported', () => {
        const c = readConfirmation({ dealStatus: 'ACCEPTED', dealId: 'd', level: null, size: undefined });
        expect(c.level).toBeNull();
        expect(c.size).toBeNull();
    });
});
