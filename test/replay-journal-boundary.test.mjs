// The one fact the renderer and the main process must agree on about a replay journal: which
// version of it is being written. The main process refuses a journal it does not recognise when
// a session is parked — so a renderer that moved on without it would fail every "pause for
// later" with a message about a journal, and nothing else would notice.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { ReplayJournal } from '../app/renderer/replay/replayJournal';

describe('the replay journal at the boundary', () => {
    it('is written in the version the main process accepts', () => {
        const ipc = readFileSync('app/electron/ipc.js', 'utf8');
        const accepted = Number(/REPLAY_JOURNAL_VERSION = (\d+)/.exec(ipc)?.[1]);
        const written = ReplayJournal.startingFrom({ snapshot: {}, timeframe: '1', clock: 0, ticks: null }).toRecord().version;
        expect(written).toBe(accepted);
    });
});
