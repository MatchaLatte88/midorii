import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number }
interface Quote { contractId: string; last: number | null; bid: number | null; ask: number | null; time: number }
interface Credentials { userName: string; apiKey: string; base?: string; hub?: string; live?: boolean }

/** The main-process client's surface. Written out here because it is JavaScript — Electron
 *  loads it directly — and a dynamic import of it would otherwise be `any`. */
interface ProjectXClient {
    configureProjectX(next: Credentials | null): void;
    projectXProbe(creds: Partial<Credentials>): Promise<unknown[]>;
    projectXAccounts(onlyActive?: boolean): Promise<unknown[]>;
    projectXContracts(searchText: string): Promise<unknown[]>;
    projectXBars(contractId: string, timeframe: string, opts?: { from?: number; to?: number; limit?: number }): Promise<Bar[]>;
    projectXSubscribe(contractId: string, timeframe: string, cb: (bar: Bar) => void): Promise<() => void>;
    projectXSubscribeQuotes(contractId: string, cb: (quote: Quote) => void): Promise<() => void>;
}

/**
 * The client is imported FRESH for every test.
 *
 * It holds the things a relay has to hold — the session, the socket, and one forming bar
 * per feed — in module scope, which is right for an app that has one of each and wrong for
 * a test file that would otherwise hand each case the leftovers of the last one. A bar half
 * built at 18:50 in one test silently swallows a print at 18:49 in the next, and the failure
 * surfaces nowhere near the cause.
 */
let px: ProjectXClient;

/** SignalR frames its records with this byte rather than with newlines. */
const SEP = '\x1e';

/** The gateway answers HTTP 200 for a refusal too — `success` is the verdict. */
const ok = (body: unknown): Response => new Response(
    JSON.stringify(body),
    { status: 200, headers: { 'content-type': 'application/json' } },
);
const session = (): Response => ok({ token: 'session-token', success: true, errorCode: 0, errorMessage: null });
const negotiated = (): Response => ok({
    negotiateVersion: 1, connectionId: 'conn-id', connectionToken: 'conn-token',
    availableTransports: [{ transport: 'WebSockets', transferFormats: ['Text'] }],
});
const barsBody = (rows: unknown[]): Response => ok({ bars: rows, success: true, errorCode: 0, errorMessage: null });

/** One bar row in the gateway's own spelling — .NET timestamps, single-letter fields. */
const row = (t: string, o: number, h: number, l: number, c: number, v = 0) => ({ t, o, h, l, c, v, d: t.slice(0, 10), k: 1 });
/** One print, at a whole second of the 18:49 minute. */
const print = (price: number, volume: number, second: string, minute = '18:49') => (
    { price, volume, timestamp: `2026-09-10T${minute}:${second}.000+00:00` }
);

const CONTRACT = 'CON.F.US.ENQ.U26';

/**
 * A stand-in for the socket, driven by the test rather than by a server.
 *
 * The module talks to it through the same four handlers a real one has, so a frame pushed
 * here travels exactly the path a frame off the wire would.
 */
class FakeSocket {
    static OPEN = 1;
    static instances: FakeSocket[] = [];
    readyState = 1;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(public url: string) { FakeSocket.instances.push(this); }
    send(data: string) { this.sent.push(data); }
    close() { this.readyState = 3; this.onclose?.(); }

    /** Every record this socket was asked to send, parsed. */
    records(): Record<string, unknown>[] {
        return this.sent.flatMap((s) => s.split(SEP).filter(Boolean).map((p) => JSON.parse(p)));
    }
    /** Answer the handshake, which is what makes the connection usable. */
    completeHandshake() { this.onmessage?.({ data: `{}${SEP}` }); }
    /** Push one hub invocation. */
    push(target: string, args: unknown[]) {
        this.onmessage?.({ data: `${JSON.stringify({ type: 1, target, arguments: args })}${SEP}` });
    }
}

/** Bring the socket up: the module opens it, the test answers for the server. */
async function raiseSocket() {
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    const socket = FakeSocket.instances[0]!;
    socket.onopen?.();
    socket.completeHandshake();
    return socket;
}

/** Open a live bar feed and hand back the socket driving it, plus the bars it emitted. */
async function feedFor(timeframe: string, seed: unknown[] = []) {
    const bars: Bar[] = [];
    vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(session())        // loginKey, for the seed request
        .mockResolvedValueOnce(barsBody(seed))   // the seed itself
        .mockResolvedValueOnce(negotiated());    // hub negotiate
    const pending = px.projectXSubscribe(CONTRACT, timeframe, (bar) => { bars.push(bar); });
    const socket = await raiseSocket();
    const unsubscribe = await pending;
    return { socket, bars, unsubscribe };
}

beforeEach(async () => {
    vi.restoreAllMocks();
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.resetModules();
    // The main-process client is JavaScript because Electron loads it directly.
    // @ts-expect-error no declaration file is needed for this internal module.
    px = await import('../app/electron/data/projectx.js') as unknown as ProjectXClient;
    px.configureProjectX({ userName: 'trader', apiKey: 'key', live: false });
});

describe('ProjectX session', () => {
    it('treats a 200 carrying no token as the refusal it is, and says what to do about it', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ token: null, success: false, errorCode: 3, errorMessage: null }));
        await expect(px.projectXProbe({ userName: 'trader', apiKey: 'wrong' }))
            .rejects.toThrow(/username is the one you sign in to the platform with/);
    });

    it('names the missing subscription rather than the credentials when the key is fine', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ token: null, success: false, errorCode: 9, errorMessage: null }));
        await expect(px.projectXProbe({ userName: 'trader', apiKey: 'key' }))
            .rejects.toThrow(/no API subscription/);
    });

    it('refuses a key that authenticates but reaches nothing tradeable', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(session())
            .mockResolvedValueOnce(ok({ accounts: [], success: true, errorCode: 0 }));
        await expect(px.projectXProbe({ userName: 'trader', apiKey: 'key' }))
            .rejects.toThrow(/no active trading accounts/);
    });

    it('sends the bearer token on the calls that follow the login, and never the key', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(session())
            .mockResolvedValueOnce(ok({ contracts: [], success: true, errorCode: 0 }));
        await px.projectXContracts('NQ');
        const headers = fetch.mock.calls[1]![1]?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer session-token');
        expect(JSON.stringify(fetch.mock.calls[1]![1])).not.toContain('"key"');
    });
});

describe('ProjectX bars', () => {
    it('asks with the account side it was configured for, not a caller-chosen one', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(session())
            .mockResolvedValueOnce(barsBody([]));
        await px.projectXBars(CONTRACT, '1', { limit: 10 });
        const body = JSON.parse(String(fetch.mock.calls[1]![1]?.body));
        expect(body.live).toBe(false);
        expect(body.unit).toBe(2);
        expect(body.unitNumber).toBe(1);
        expect(body.includePartialBar).toBe(true);
    });

    it('maps the canonical timeframes onto the gateway unit pairs', async () => {
        const cases: [string, number, number][] = [['5', 2, 5], ['60', 3, 1], ['240', 3, 4], ['D', 4, 1], ['W', 5, 1]];
        for (const [tf, unit, unitNumber] of cases) {
            const fetch = vi.spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce(session())
                .mockResolvedValueOnce(barsBody([]));
            px.configureProjectX({ userName: 'trader', apiKey: 'key', live: false });
            await px.projectXBars(CONTRACT, tf, { limit: 1 });
            const body = JSON.parse(String(fetch.mock.calls[1]![1]?.body));
            expect([tf, body.unit, body.unitNumber]).toEqual([tf, unit, unitNumber]);
            vi.restoreAllMocks();
        }
    });

    it('refuses a timeframe the gateway does not serve rather than sending a guess', async () => {
        await expect(px.projectXBars(CONTRACT, '7', {})).rejects.toThrow(/does not serve the "7" timeframe/);
    });

    it('reads the single-letter fields and the offset timestamps into chart bars', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(session())
            .mockResolvedValueOnce(barsBody([row('2026-09-10T15:38:00+00:00', 1, 4, 0.5, 3, 632)]));
        const bars = await px.projectXBars(CONTRACT, '1', { limit: 1 });
        expect(bars).toEqual([{ time: Date.parse('2026-09-10T15:38:00Z'), open: 1, high: 4, low: 0.5, close: 3, volume: 632 }]);
    });

    it('sorts what it hands back, rather than trusting the order it arrived in', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(session())
            .mockResolvedValueOnce(barsBody([
                row('2026-09-10T15:39:00+00:00', 2, 2, 2, 2),
                row('2026-09-10T15:37:00+00:00', 1, 1, 1, 1),
                row('2026-09-10T15:38:00+00:00', 3, 3, 3, 3),
            ]));
        const bars = await px.projectXBars(CONTRACT, '1', { limit: 3 });
        expect(bars.map((b) => b.open)).toEqual([1, 3, 2]);
    });

    it('surfaces a success:false body instead of charting it as an empty market', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(session())
            .mockResolvedValueOnce(ok({ bars: null, success: false, errorCode: 1, errorMessage: null }));
        await expect(px.projectXBars(CONTRACT, '1', { limit: 1 })).rejects.toThrow(/errorCode 1/);
    });
});

describe('ProjectX tick aggregation', () => {
    it('folds every print in a batched trade message, not just the first', async () => {
        const { socket, bars } = await feedFor('1');
        socket.push('GatewayTrade', [CONTRACT, [print(100, 1, '01'), print(105, 2, '02'), print(95, 3, '03')]]);
        expect(bars).toHaveLength(3);
        expect(bars[2]).toEqual({
            time: Date.parse('2026-09-10T18:49:00Z'),
            open: 100, high: 105, low: 95, close: 95, volume: 6,
        });
    });

    it('opens a new bar when the tick crosses into the next bucket', async () => {
        const { socket, bars } = await feedFor('1');
        socket.push('GatewayTrade', [CONTRACT, [print(100, 1, '59')]]);
        socket.push('GatewayTrade', [CONTRACT, [print(200, 5, '00', '18:50')]]);
        expect(bars[0]!.time).toBe(Date.parse('2026-09-10T18:49:00Z'));
        expect(bars[1]).toEqual({
            time: Date.parse('2026-09-10T18:50:00Z'),
            open: 200, high: 200, low: 200, close: 200, volume: 5,
        });
    });

    it('buckets by the timeframe it was opened for, not by the minute', async () => {
        const { socket, bars } = await feedFor('5');
        socket.push('GatewayTrade', [CONTRACT, [print(100, 1, '30', '18:47')]]);
        socket.push('GatewayTrade', [CONTRACT, [print(110, 1, '30', '18:49')]]);
        // Both prints belong to the 18:45 bucket, so they are one bar and not two.
        expect(bars.map((b) => b.time)).toEqual([Date.parse('2026-09-10T18:45:00Z'), Date.parse('2026-09-10T18:45:00Z')]);
        expect(bars[1]!.high).toBe(110);
    });

    it('drops a print that belongs to a bar already emitted, rather than rewriting it', async () => {
        const { socket, bars } = await feedFor('1');
        socket.push('GatewayTrade', [CONTRACT, [print(200, 1, '00', '18:50')]]);
        socket.push('GatewayTrade', [CONTRACT, [print(999, 9, '00', '18:49')]]);
        expect(bars).toHaveLength(1);
        expect(bars[0]!.close).toBe(200);
    });

    it('ignores a print whose timestamp does not parse, rather than bucketing it at NaN', async () => {
        const { socket, bars } = await feedFor('1');
        socket.push('GatewayTrade', [CONTRACT, [{ price: 100, volume: 1, timestamp: 'not-a-date' }]]);
        expect(bars).toHaveLength(0);
    });

    it('seeds the forming bar from REST, so the first candle does not open at a made-up price', async () => {
        const openTime = Math.floor(Date.now() / 60_000) * 60_000;
        const seed = [row(new Date(openTime).toISOString(), 50, 60, 40, 55, 300)];
        const { socket, bars } = await feedFor('1', seed);
        socket.push('GatewayTrade', [CONTRACT, [{ price: 58, volume: 2, timestamp: new Date(openTime + 1_000).toISOString() }]]);
        expect(bars[0]).toEqual({ time: openTime, open: 50, high: 60, low: 40, close: 58, volume: 302 });
    });

    it('leaves a stale seed alone, so a bar from an earlier minute is not carried forward', async () => {
        // A seed for a bucket that has already closed says nothing about the one forming now.
        const stale = [row('2026-09-10T18:00:00+00:00', 50, 60, 40, 55, 300)];
        const { socket, bars } = await feedFor('1', stale);
        socket.push('GatewayTrade', [CONTRACT, [print(58, 2, '01')]]);
        expect(bars[0]).toEqual({
            time: Date.parse('2026-09-10T18:49:00Z'),
            open: 58, high: 58, low: 58, close: 58, volume: 2,
        });
    });

    it('hands each listener its own bar, so one keeping it cannot see it mutate', async () => {
        const { socket, bars } = await feedFor('1');
        socket.push('GatewayTrade', [CONTRACT, [print(100, 1, '01')]]);
        const first = bars[0]!;
        socket.push('GatewayTrade', [CONTRACT, [print(110, 1, '02')]]);
        expect(first.close).toBe(100);
        expect(bars[1]!.close).toBe(110);
    });

    it('ignores a trade for a contract it is not watching', async () => {
        const { socket, bars } = await feedFor('1');
        socket.push('GatewayTrade', ['CON.F.US.MNQ.U26', [print(100, 1, '01')]]);
        expect(bars).toHaveLength(0);
    });
});

describe('ProjectX quotes', () => {
    /** Open a quote feed and hand back the socket driving it, plus the quotes it emitted. */
    async function quoteFeed() {
        const quotes: Quote[] = [];
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(session())
            .mockResolvedValueOnce(negotiated());
        const pending = px.projectXSubscribeQuotes(CONTRACT, (q) => { quotes.push(q); });
        const socket = await raiseSocket();
        const unsubscribe = await pending;
        return { socket, quotes, unsubscribe };
    }

    /** The opening message, the only one that carries the whole picture. */
    const snapshot = {
        symbol: 'F.US.ENQ', symbolName: '/NQ',
        lastPrice: 29165.5, bestBid: 29165.25, bestAsk: 29165.75,
        open: 29458.5, high: 29508.25, low: 29043.25, volume: 475921,
        lastUpdated: '2026-09-10T18:49:52.7035892+00:00',
        timestamp: '2026-09-09T21:00:00.168+00:00',
    };

    it('reads lastUpdated rather than timestamp, which carries the session start', async () => {
        const { socket, quotes } = await quoteFeed();
        socket.push('GatewayQuote', [CONTRACT, snapshot]);
        expect(quotes[0]).toEqual({
            contractId: CONTRACT,
            last: 29165.5, bid: 29165.25, ask: 29165.75,
            time: Date.parse('2026-09-10T18:49:52.703Z'),
        });
    });

    it('folds a delta into the last known quote instead of reporting the gaps as null', async () => {
        const { socket, quotes } = await quoteFeed();
        socket.push('GatewayQuote', [CONTRACT, snapshot]);
        // What the feed actually sends after the opening message: one moved field.
        socket.push('GatewayQuote', [CONTRACT, {
            symbol: 'F.US.ENQ', bestBid: 29165, contract: CONTRACT,
            lastUpdated: '2026-09-10T18:49:52.966764+00:00',
            timestamp: '2026-09-10T18:49:52.852+00:00',
        }]);
        expect(quotes[1]).toEqual({
            contractId: CONTRACT,
            last: 29165.5,      // carried over
            bid: 29165,         // moved
            ask: 29165.75,      // carried over
            time: Date.parse('2026-09-10T18:49:52.966Z'),
        });
    });

    it('hands each listener its own quote, so one keeping it cannot see it mutate', async () => {
        const { socket, quotes } = await quoteFeed();
        socket.push('GatewayQuote', [CONTRACT, snapshot]);
        const first = quotes[0]!;
        socket.push('GatewayQuote', [CONTRACT, { bestAsk: 29999, lastUpdated: '2026-09-10T18:49:53.000+00:00' }]);
        expect(first.ask).toBe(29165.75);
        expect(quotes[1]!.ask).toBe(29999);
    });

    it('forgets the accumulated quote once nothing is watching the contract', async () => {
        const { socket, quotes, unsubscribe } = await quoteFeed();
        socket.push('GatewayQuote', [CONTRACT, snapshot]);
        unsubscribe();

        const second: Quote[] = [];
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(negotiated());
        await px.projectXSubscribeQuotes(CONTRACT, (q) => { second.push(q); });
        // A bid remembered across a gap would read as current; the feed re-opens with its own snapshot.
        socket.push('GatewayQuote', [CONTRACT, { bestBid: 29100, lastUpdated: '2026-09-10T18:52:00.000+00:00' }]);
        expect(second[0]).toEqual({ contractId: CONTRACT, last: null, bid: 29100, ask: null, time: Date.parse('2026-09-10T18:52:00Z') });
        expect(quotes).toHaveLength(1);
    });

    it('drops the accumulated quotes when the account side changes', async () => {
        const { socket, quotes } = await quoteFeed();
        socket.push('GatewayQuote', [CONTRACT, snapshot]);
        px.configureProjectX({ userName: 'trader', apiKey: 'key', live: true });
        socket.push('GatewayQuote', [CONTRACT, { bestBid: 29100, lastUpdated: '2026-09-10T18:52:00.000+00:00' }]);
        expect(quotes[1]).toEqual({ contractId: CONTRACT, last: null, bid: 29100, ask: null, time: Date.parse('2026-09-10T18:52:00Z') });
    });
});

describe('ProjectX subscriptions', () => {
    it('subscribes the contract once however many feeds want it', async () => {
        const { socket } = await feedFor('1');
        const before = socket.records().filter((r) => r.target === 'SubscribeContractTrades').length;
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(barsBody([]));
        await px.projectXSubscribe(CONTRACT, '5', (() => {}));
        expect(socket.records().filter((r) => r.target === 'SubscribeContractTrades')).toHaveLength(before);
    });

    it('keeps the contract streaming while a quote listener still needs it', async () => {
        const { socket, unsubscribe } = await feedFor('1');
        await px.projectXSubscribeQuotes(CONTRACT, (() => {}));
        unsubscribe();
        expect(socket.records().some((r) => r.target === 'UnsubscribeContractTrades')).toBe(false);
    });

    it('drops the contract once nothing is watching it in either form', async () => {
        const { socket, unsubscribe } = await feedFor('1');
        unsubscribe();
        const targets = socket.records().map((r) => r.target);
        expect(targets).toContain('UnsubscribeContractTrades');
        expect(targets).toContain('UnsubscribeContractQuotes');
    });

    it('drops the forming bars when the account side changes, without dropping the feeds', async () => {
        const { socket, bars } = await feedFor('1');
        socket.push('GatewayTrade', [CONTRACT, [print(100, 1, '01')]]);
        px.configureProjectX({ userName: 'trader', apiKey: 'key', live: true });
        socket.push('GatewayTrade', [CONTRACT, [print(110, 1, '02')]]);
        // The second print opens a fresh bar rather than extending one built on the other book.
        expect(bars[1]).toEqual({
            time: Date.parse('2026-09-10T18:49:00Z'),
            open: 110, high: 110, low: 110, close: 110, volume: 1,
        });
    });
});
