import { describe, it, expect } from 'vitest';
import { andInto, countAndRange, countRange, createBitset, forEachBit, hasBit, setBit } from '../app/renderer/patterns/bits';

/**
 * The bit arithmetic the pattern search is built on. Every edge here is a word boundary,
 * because that is where an off-by-one in a bitset lives.
 */

function setOf(size: number, indices: number[]): Uint32Array {
    const out = createBitset(size);
    for (const i of indices) setBit(out, i);
    return out;
}

describe('pattern bitsets', () => {
    const indices = [0, 1, 31, 32, 33, 63, 64, 95, 96, 127, 150];
    const set = setOf(160, indices);

    it('counts exactly the bits inside a half-open range', () => {
        for (let from = 0; from <= 160; from += 7) {
            for (let to = from; to <= 160; to += 5) {
                const expected = indices.filter((i) => i >= from && i < to).length;
                expect(countRange(set, from, to)).toBe(expected);
            }
        }
        expect(countRange(set, 31, 32)).toBe(1);
        expect(countRange(set, 32, 32)).toBe(0);
        expect(countRange(set, 0, 160)).toBe(indices.length);
    });

    it('counts and combines two sets the same way', () => {
        const other = setOf(160, [1, 32, 64, 100, 127]);
        const both = andInto(createBitset(160), set, other);
        expect([...Array(160).keys()].filter((i) => hasBit(both, i))).toEqual([1, 32, 64, 127]);
        expect(countAndRange(set, other, 2, 128)).toBe(3);
    });

    it('visits in order, and skips ahead when told to', () => {
        const all: number[] = [];
        forEachBit(set, 0, 160, (i) => { all.push(i); });
        expect(all).toEqual(indices);

        const inRange: number[] = [];
        forEachBit(set, 32, 96, (i) => { inRange.push(i); });
        expect(inRange).toEqual([32, 33, 63, 64, 95]);

        // A trade from 1 that runs to 64 hides everything below 64, across two words.
        const taken: number[] = [];
        forEachBit(set, 0, 160, (i) => {
            taken.push(i);
            return i === 1 ? 64 : undefined;
        });
        expect(taken).toEqual([0, 1, 64, 95, 96, 127, 150]);

        const stopped: number[] = [];
        forEachBit(set, 0, 160, (i) => {
            stopped.push(i);
            return 200;
        });
        expect(stopped).toEqual([0]);
    });
});
