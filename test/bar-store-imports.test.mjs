// A dataset whose base bar is not a minute — what a CSV import produces.
//
// Everything downloaded is minute data, and the store used to assume that everywhere: the
// completeness test for the last bucket measured it against a minute, and a request for a
// finer timeframe than the file actually holds was answered with the stored bars under a
// label they had not earned. An hourly import has to be aggregated from hours, refused
// below hours, and remembered as hourly across the next merge into it.
//
// Plain `.mjs` because the store is untyped Electron-side JS.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
    baseIntervalMs, deleteDataset, describeMs, listDatasets, mergeBars, readBars, readMeta,
} from '../app/electron/data/store/barStore.js';

const HOUR = 3_600_000;
const START = Date.parse('2024-01-01T00:00:00Z');

/** `count` hourly bars, close = index, so an aggregate is easy to read back. */
function hourly(count) {
    const out = [];
    for (let i = 0; i < count; i++) {
        out.push({
            time: START + i * HOUR,
            open: 100 + i,
            high: 200 + i,
            low: 50 + i,
            close: i,
            volume: 1,
        });
    }
    return out;
}

let dir;

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'midorii-store-'));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('describing a bar length', () => {
    it('names the timeframe someone would type', () => {
        expect(describeMs(60_000)).toBe('1m');
        expect(describeMs(300_000)).toBe('5m');
        expect(describeMs(HOUR)).toBe('1h');
        expect(describeMs(2 * HOUR)).toBe('2h');
        expect(describeMs(86_400_000)).toBe('1d');
    });
});

describe('an imported dataset', () => {
    it('records the bar length the file carried', async () => {
        await mergeBars(dir, 'NQ', hourly(10), { source: 'csv', baseMs: HOUR, timeframe: '1h' });

        const meta = await readMeta(dir, 'NQ');
        expect(meta.baseMs).toBe(HOUR);
        expect(meta.timeframe).toBe('1h');
        expect(meta.source).toBe('csv');
        expect(await baseIntervalMs(dir, 'NQ')).toBe(HOUR);
    });

    it('reads its own bar length back straight', async () => {
        await mergeBars(dir, 'NQ', hourly(10), { source: 'csv', baseMs: HOUR, timeframe: '1h' });

        const bars = await readBars(dir, 'NQ', '1h', START, START + 10 * HOUR);
        expect(bars).toHaveLength(10);
        expect(bars[0].close).toBe(0);
        expect(bars[9].close).toBe(9);
    });

    it('aggregates upwards, last bucket included', async () => {
        await mergeBars(dir, 'NQ', hourly(8), { source: 'csv', baseMs: HOUR, timeframe: '1h' });

        const bars = await readBars(dir, 'NQ', '4h', START, START + 8 * HOUR);
        // Measured against a minute, the closing bucket of an hourly dataset would look
        // unfinished and be withheld — the whole reason the base length is stored.
        expect(bars).toHaveLength(2);
        expect(bars[0]).toMatchObject({ time: START, open: 100, close: 3 });
        expect(bars[1]).toMatchObject({ time: START + 4 * HOUR, open: 104, close: 7 });
    });

    it('refuses a timeframe finer than what it holds', async () => {
        await mergeBars(dir, 'NQ', hourly(6), { source: 'csv', baseMs: HOUR, timeframe: '1h' });

        // Answering this with the hourly bars relabelled would put four-figure candles on
        // a 1m chart and hand a backtest sixty times the history it thinks it has.
        await expect(readBars(dir, 'NQ', '1m', START, START + 6 * HOUR))
            .rejects.toThrow(/finer than that/);
        await expect(readBars(dir, 'NQ', '30', START, START + 6 * HOUR))
            .rejects.toThrow(/stored as 1h bars/);
    });

    it('stays an hourly dataset when more of the same file is merged in', async () => {
        await mergeBars(dir, 'NQ', hourly(4), { source: 'csv', baseMs: HOUR, timeframe: '1h' });
        // A second import adds bars; it does not redefine what the dataset is.
        await mergeBars(dir, 'NQ', hourly(8).slice(4));

        const meta = await readMeta(dir, 'NQ');
        expect(meta.baseMs).toBe(HOUR);
        expect(meta.source).toBe('csv');
        expect(meta.count).toBe(8);
    });

    it('is listed as what it is', async () => {
        await mergeBars(dir, 'NQ', hourly(4), { source: 'csv', baseMs: HOUR, timeframe: '1h' });
        const [entry] = await listDatasets(dir);

        expect(entry).toMatchObject({ symbol: 'NQ', baseMs: HOUR, source: 'csv' });
    });
});

describe('a downloaded dataset', () => {
    it('is minute data even though it says nothing about a base length', async () => {
        // Everything stored before imports existed carries no `baseMs` at all.
        await mergeBars(dir, 'BTCUSDT', [
            { time: START, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
            { time: START + 60_000, open: 1.5, high: 2.5, low: 1, close: 2, volume: 1 },
        ], { source: 'binance' });

        expect(await baseIntervalMs(dir, 'BTCUSDT')).toBe(60_000);
        const bars = await readBars(dir, 'BTCUSDT', '1m', START, START + 120_000);
        expect(bars).toHaveLength(2);
    });
});

describe('removing a dataset', () => {
    it('takes the bars and the metadata with it', async () => {
        await mergeBars(dir, 'NQ', hourly(4), { source: 'csv', baseMs: HOUR });
        expect(existsSync(path.join(dir, 'NQ-1m.bin'))).toBe(true);

        expect(await deleteDataset(dir, 'NQ')).toBe(true);
        expect(await listDatasets(dir)).toEqual([]);
        expect(existsSync(path.join(dir, 'NQ-1m.bin'))).toBe(false);
        expect(existsSync(path.join(dir, 'NQ-1m.meta.json'))).toBe(false);
    });

    it('is not an error when there was nothing to remove', async () => {
        expect(await deleteDataset(dir, 'GONE')).toBe(false);
    });
});
