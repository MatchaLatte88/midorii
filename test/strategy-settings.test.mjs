// What a strategy is set to, on disk.
//
// Configuration rather than a result, which is what shapes every rule here: losing it must
// never stop the app from opening, and it must survive a build that changes the schema
// underneath it — the values are stored as given and made sense of where the schema is.
//
// Plain `.mjs` because the store is untyped Electron-side JS.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
    clearStrategySettings, loadStrategySettings, saveStrategySettings,
} from '../app/electron/data/store/strategyStore.js';

let dir;

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'midorii-strategies-'));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('strategy settings', () => {
    it('is empty before anything is saved', async () => {
        expect(await loadStrategySettings(dir)).toEqual({});
    });

    it('keeps what was saved, per strategy', async () => {
        await saveStrategySettings(dir, 'silverbullet', { rrr: 3, riskValue: 0.5 });
        await saveStrategySettings(dir, 'other', { rrr: 1 });

        expect(await loadStrategySettings(dir)).toEqual({
            silverbullet: { rrr: 3, riskValue: 0.5 },
            other: { rrr: 1 },
        });
    });

    it(`replaces a strategy's settings whole rather than merging into them`, async () => {
        await saveStrategySettings(dir, 'silverbullet', { rrr: 3, riskValue: 0.5 });
        await saveStrategySettings(dir, 'silverbullet', { rrr: 2 });

        // A setting someone removed has to actually go, or it comes back on the next read.
        expect((await loadStrategySettings(dir)).silverbullet).toEqual({ rrr: 2 });
    });

    it('forgets one strategy without touching the others', async () => {
        await saveStrategySettings(dir, 'silverbullet', { rrr: 3 });
        await saveStrategySettings(dir, 'other', { rrr: 1 });

        const after = await clearStrategySettings(dir, 'silverbullet');
        expect(after).toEqual({ other: { rrr: 1 } });
        expect(await loadStrategySettings(dir)).toEqual({ other: { rrr: 1 } });
    });

    it('is not an error to forget what was never set', async () => {
        expect(await clearStrategySettings(dir, 'silverbullet')).toEqual({});
    });

    it('stores a value the current schema would refuse, and says nothing about it', async () => {
        /* Deliberate: what a parameter MEANS lives in the renderer, with the schema. A store
         * that validated would have to be updated in step with every strategy, and would
         * refuse to read a file written by a build that spelled things differently. */
        await saveStrategySettings(dir, 'silverbullet', { rrr: -5, madeUp: 'yes' });
        expect((await loadStrategySettings(dir)).silverbullet).toEqual({ rrr: -5, madeUp: 'yes' });
    });

    it('reads an unreadable file as empty rather than refusing to open', async () => {
        await writeFile(path.join(dir, 'strategies.json'), '{ this is not json', 'utf8');
        expect(await loadStrategySettings(dir)).toEqual({});
    });

    it('reads a file that is not an object as empty', async () => {
        await writeFile(path.join(dir, 'strategies.json'), '[1, 2, 3]', 'utf8');
        expect(await loadStrategySettings(dir)).toEqual({});
    });

    it('refuses an id that would not be safe to key a file by', async () => {
        await expect(saveStrategySettings(dir, '../escape', { rrr: 1 })).rejects.toThrow(/Invalid strategy id/);
        await expect(saveStrategySettings(dir, '', { rrr: 1 })).rejects.toThrow(/Invalid strategy id/);
    });

    it('refuses settings that are not settings', async () => {
        await expect(saveStrategySettings(dir, 'silverbullet', null)).rejects.toThrow(/must be an object/);
        await expect(saveStrategySettings(dir, 'silverbullet', [1, 2])).rejects.toThrow(/must be an object/);
    });

    it('refuses more settings than a strategy has', async () => {
        const runaway = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i]));
        await expect(saveStrategySettings(dir, 'silverbullet', runaway)).rejects.toThrow(/more than a strategy has/);
    });
});
