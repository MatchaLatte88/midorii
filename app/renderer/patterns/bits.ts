/**
 * Bitsets over bar indices — the representation a pattern search is fast in.
 *
 * A search tries tens of thousands of conjunctions, and each one asks the same question of
 * every bar: do all of these conditions hold here? As a byte per bar that is a hundred
 * thousand reads per condition per candidate; as a bit per bar it is three thousand words,
 * and combining two conditions is one AND per word. The whole search is built on that.
 *
 * Bit `i` of a set is bar `i`. Every function takes a half-open `[from, to)` range of bar
 * indices, because a search only ever looks at one stretch of history at a time — the
 * discovery stretch — and the stretches after it must not leak into the counting.
 */

export type Bitset = Uint32Array;

export function createBitset(size: number): Bitset {
    return new Uint32Array(Math.ceil(size / 32));
}

export function setBit(set: Bitset, index: number): void {
    set[index >>> 5]! |= 1 << (index & 31);
}

export function hasBit(set: Bitset, index: number): boolean {
    return (set[index >>> 5]! & (1 << (index & 31))) !== 0;
}

/** `out = a & b`, for every word — `out` may be `a` or `b`. */
export function andInto(out: Bitset, a: Bitset, b: Bitset): Bitset {
    for (let w = 0; w < out.length; w++) out[w] = a[w]! & b[w]!;
    return out;
}

function popcount32(v: number): number {
    v -= (v >>> 1) & 0x55555555;
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/** The mask of the bits of word `w` that fall inside `[from, to)`. */
function rangeMask(w: number, from: number, to: number): number {
    const lo = w * 32;
    let mask = 0xffffffff;
    if (from > lo) mask &= 0xffffffff << (from - lo);
    if (to < lo + 32) mask &= (to - lo) <= 0 ? 0 : 0xffffffff >>> (32 - (to - lo));
    return mask >>> 0;
}

/** How many bits are set in `[from, to)`. */
export function countRange(set: Bitset, from: number, to: number): number {
    if (to <= from) return 0;
    const first = from >>> 5;
    const last = (to - 1) >>> 5;
    let count = 0;
    for (let w = first; w <= last; w++) {
        const word = w === first || w === last ? set[w]! & rangeMask(w, from, to) : set[w]!;
        if (word !== 0) count += popcount32(word);
    }
    return count;
}

/** How many bits `a & b` has in `[from, to)`, without building it. */
export function countAndRange(a: Bitset, b: Bitset, from: number, to: number): number {
    if (to <= from) return 0;
    const first = from >>> 5;
    const last = (to - 1) >>> 5;
    let count = 0;
    for (let w = first; w <= last; w++) {
        let word = a[w]! & b[w]!;
        if (w === first || w === last) word &= rangeMask(w, from, to);
        if (word !== 0) count += popcount32(word);
    }
    return count;
}

/**
 * Calls `visit` with every set index in `[from, to)`, ascending. Returning a number from
 * `visit` skips ahead: nothing below that index is visited afterwards — which is how a
 * trade that is still open keeps the next signal from being taken.
 */
export function forEachBit(
    set: Bitset,
    from: number,
    to: number,
    visit: (index: number) => number | void,
): void {
    if (to <= from) return;
    let next = from;
    const last = (to - 1) >>> 5;
    for (let w = from >>> 5; w <= last; w++) {
        if (w * 32 + 31 < next) continue;
        let word = set[w]! & rangeMask(w, Math.max(from, next), to);
        while (word !== 0) {
            const bit = 31 - Math.clz32(word & -word);
            const index = w * 32 + bit;
            word &= word - 1;
            if (index < next) continue;
            const skip = visit(index);
            if (typeof skip === 'number' && skip > next) {
                next = skip;
                if (next >= to) return;
                if ((next >>> 5) > w) break;
            }
        }
    }
}
