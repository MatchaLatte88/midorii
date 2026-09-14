// Recording the live feed — the tape on disk, and the candles made from it.
//
// Run against real files in a temporary folder: what matters is what is on disk afterwards,
// including after the kind of crash that cuts a write short.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { appendTicks, listRecordings, readTicks } from '../app/electron/data/store/tickStore.js';
import { createTickRecorder, recordedDatasetName } from '../app/electron/data/tickRecorder.js';
import { readDataset, STRIDE } from '../app/electron/data/store/barStore.js';
import { loadRecorderEnabled, saveRecorderEnabled } from '../app/electron/data/store/recorderStore.js';

const T = Date.UTC(2026, 8, 11, 14, 30, 0);   // 14:30:00 UTC
const MINUTE = 60_000;

let root;
beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'midorii-ticks-'));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('the tick store', () => {
    it('reads back what was appended, in time order, across several appends', async () => {
        await appendTicks(root, 'NQU6', [[T + 2, 1, 100, 1, 0], [T + 5, 2, 99.75, 100, 100]]);
        await appendTicks(root, 'NQU6', [[T + 1, 1, 100.25, 2, 1]]);   // arrived late
        const read = await readTicks(root, 'NQU6', T, T + 10);
        expect(read.map((e) => e[0])).toEqual([T + 1, T + 2, T + 5]);
        expect(read[0]).toEqual([T + 1, 1, 100.25, 2, 1]);
    });

    it('keeps the order two events arrived in when they share a millisecond', async () => {
        await appendTicks(root, 'NQU6', [[T, 2, 1, 2, 1.5], [T, 1, 1.5, 1, 0]]);
        expect((await readTicks(root, 'NQU6', T, T + 1)).map((e) => e[1])).toEqual([2, 1]);
    });

    it('splits a batch that crosses midnight into two days, and reads across them', async () => {
        const late = Date.UTC(2026, 8, 11, 23, 59, 59, 900);
        const early = Date.UTC(2026, 8, 12, 0, 0, 0, 100);
        await appendTicks(root, 'NQU6', [[late, 1, 1, 1, 0], [early, 1, 2, 1, 1]]);
        expect((await listRecordings(root))[0].days).toEqual(['2026-09-11', '2026-09-12']);
        expect(await readTicks(root, 'NQU6', late, early + 1)).toHaveLength(2);
    });

    it('returns only the stretch asked for', async () => {
        await appendTicks(root, 'NQU6', [[T, 1, 1, 1, 0], [T + MINUTE, 1, 2, 1, 0], [T + 2 * MINUTE, 1, 3, 1, 0]]);
        const read = await readTicks(root, 'NQU6', T + MINUTE, T + 2 * MINUTE);
        expect(read.map((e) => e[2])).toEqual([2]);
    });

    it('keeps everything before a write that a crash cut short — and what comes after the restart', async () => {
        await appendTicks(root, 'ESU6', [[T, 1, 1, 1, 0]]);
        const file = path.join(root, 'ESU6', '2026-09-11.ticks.gz');
        // Half a member on the end: the process died mid-append.
        const member = zlib.gzipSync('[' + (T + 1) + ',1,2,1,0]\n');
        await appendFile(file, member.subarray(0, member.length - 10));

        const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // A later run of the app goes on recording into the same day.
        await appendTicks(root, 'ESU6', [[T + 2, 1, 3, 1, 1]]);
        quiet.mockRestore();

        const read = await readTicks(root, 'ESU6', T, T + 10);
        expect(read.map((e) => e[0])).toContain(T);
        expect(read.map((e) => e[0])).toContain(T + 2);
    });

    it('refuses a name that could reach outside its folder', async () => {
        await expect(appendTicks(root, '../evil', [[T, 1, 1, 1, 0]])).rejects.toThrow(/cannot name a recording/);
    });
});

describe('the recorder', () => {
    const print = (at, price, volume, type) => ({
        price, volume, type, timestamp: new Date(at).toISOString(),
    });

    function recorder(now, enabled = true) {
        return createTickRecorder({
            ticksRoot: path.join(root, 'ticks'),
            dataDir: path.join(root, 'bars'),
            nameOf: (id) => (id === 'CON.F.US.ENQ.U26' ? 'NQU6' : 'OTHER'),
            enabled,
            now: () => now.t,
            flushMs: 1_000_000,   // flushed by hand in these tests
        });
    }

    async function candles(name) {
        const data = await readDataset(path.join(root, 'bars'), recordedDatasetName(name));
        if (!data) return [];
        const out = [];
        for (let i = 0; i < data.length; i += STRIDE) {
            out.push({ time: data[i], open: data[i + 1], high: data[i + 2], low: data[i + 3], close: data[i + 4], volume: data[i + 5], buyVolume: data[i + 6] });
        }
        return out;
    }

    it('writes the prints and quotes down under the contract’s name', async () => {
        const now = { t: T + 5 * MINUTE };
        const rec = recorder(now);
        rec.onPrints('CON.F.US.ENQ.U26', [print(T + 1000, 100, 2, 0), print(T + 2000, 100.25, 1, 1)]);
        rec.onQuote('CON.F.US.ENQ.U26', { bid: 100, ask: 100.25, last: 100.25, time: T + 2500 });
        await rec.flush();

        const read = await readTicks(path.join(root, 'ticks'), 'NQU6', T, T + MINUTE);
        expect(read).toEqual([
            [T + 1000, 1, 100, 2, 0],
            [T + 2000, 1, 100.25, 1, 1],
            [T + 2500, 2, 100, 100.25, 100.25],
        ]);
    });

    it('builds one-minute candles from the prints, with the buyers’ share of the volume', async () => {
        const now = { t: T + 5 * MINUTE };
        const rec = recorder(now);
        rec.onPrints('CON.F.US.ENQ.U26', [
            print(T + 1_000, 100, 3, 0),
            print(T + 20_000, 102, 1, 1),
            print(T + 40_000, 99, 2, 1),
            print(T + 59_000, 101, 4, 0),
            print(T + MINUTE + 1_000, 101.5, 1, 0),
        ]);
        await rec.flush();

        expect(await candles('NQU6')).toEqual([
            { time: T, open: 100, high: 102, low: 99, close: 101, volume: 10, buyVolume: 7 },
            { time: T + MINUTE, open: 101.5, high: 101.5, low: 101.5, close: 101.5, volume: 1, buyVolume: 1 },
        ]);
    });

    it('leaves a minute unwritten until its last prints have had time to arrive', async () => {
        const now = { t: T + MINUTE + 10_000 };   // the 14:30 minute ended ten seconds ago
        const rec = recorder(now);
        rec.onPrints('CON.F.US.ENQ.U26', [print(T + 1_000, 100, 1, 0)]);
        await rec.flush();
        expect(await candles('NQU6')).toEqual([]);

        now.t = T + MINUTE + 45_000;
        await rec.flush();
        expect(await candles('NQU6')).toHaveLength(1);
    });

    it('does not let a print that arrives after its candle was written replace the candle', async () => {
        const now = { t: T + 5 * MINUTE };
        const rec = recorder(now);
        rec.onPrints('CON.F.US.ENQ.U26', [print(T + 1_000, 100, 5, 0), print(T + 30_000, 104, 5, 1)]);
        await rec.flush();
        rec.onPrints('CON.F.US.ENQ.U26', [print(T + 59_000, 90, 1, 1)]);   // very late
        await rec.flush();

        const [bar] = await candles('NQU6');
        expect(bar).toMatchObject({ high: 104, low: 100, volume: 10 });
        // It is still on the tape, where it belongs.
        const tape = await readTicks(path.join(root, 'ticks'), 'NQU6', T, T + MINUTE);
        expect(tape.map((e) => e[2])).toContain(90);
    });

    it('records nothing while switched off, and writes out what it held when switched off', async () => {
        const now = { t: T + 5 * MINUTE };
        const rec = recorder(now);
        rec.onPrints('CON.F.US.ENQ.U26', [print(T + 1_000, 100, 1, 0)]);
        await rec.setEnabled(false);
        rec.onPrints('CON.F.US.ENQ.U26', [print(T + 2_000, 101, 1, 0)]);
        await rec.flush();

        const tape = await readTicks(path.join(root, 'ticks'), 'NQU6', T, T + MINUTE);
        expect(tape.map((e) => e[2])).toEqual([100]);
    });

    it('writes the minute still running when the app closes', async () => {
        const now = { t: T + 20_000 };
        const rec = recorder(now);
        rec.onPrints('CON.F.US.ENQ.U26', [print(T + 1_000, 100, 1, 0)]);
        await rec.stop();
        expect(await candles('NQU6')).toHaveLength(1);
    });
});

describe('the recorder setting', () => {
    it('is on until it has been switched off', async () => {
        expect(await loadRecorderEnabled(root)).toBe(true);
        await saveRecorderEnabled(root, false);
        expect(await loadRecorderEnabled(root)).toBe(false);
        expect(JSON.parse(await readFile(path.join(root, 'recorder.json'), 'utf8'))).toEqual({ enabled: false });
    });
});
