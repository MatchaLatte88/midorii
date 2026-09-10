// A bot's account has to outlive the bot's runner. The rules under test: a paper bot picks
// its account back up where it left off, an account is never thrown away without being filed
// as a run first, and a live bot writes every closed trade to the journal — the only record
// anywhere that it moved real money.
// See app/renderer/bot/BotRunner.ts and BotEngine.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BotRunner } from '../app/renderer/bot/BotRunner';
import { BotEngine } from '../app/renderer/bot/BotEngine';
import { STRATEGIES } from '../app/renderer/strategies';
import type { StrategySpec } from '../app/renderer/strategies/types';
import type { DataProvider } from '../src/plugin';
import type { OHLCV } from '../src/core/model/ohlcv';
import type { BacktestContext } from '../shared/engine/backtest';
import { newBot, type BotConfig } from '../app/renderer/bot/botTypes';
import type { MidoriBotAccount, MidoriBotAccountSnapshot } from '../app/renderer/midori';

const MINUTE = 60_000;

function bar(time: number, close: number): OHLCV {
    return { time, open: close, high: close + 0.5, low: close - 0.5, close, volume: 100 };
}

function seedBars(count: number): OHLCV[] {
    return Array.from({ length: count }, (_, i) => bar(i * MINUTE, 100 + i * 0.1));
}

function fakeProvider(bars: OHLCV[]) {
    let push: ((bar: OHLCV) => void) | null = null;
    let unsubscribed = false;
    const provider: DataProvider = {
        getBars: () => Promise.resolve(bars),
        subscribe: (_t, _tf, onBar) => {
            push = onBar;
            unsubscribed = false;
            return () => { push = null; unsubscribed = true; };
        },
    };
    return {
        provider,
        feed: (b: OHLCV) => push?.(b),
        get subscribed() { return push != null; },
        get unsubscribed() { return unsubscribed; },
    };
}

function installStrategy(onBar: (ctx: BacktestContext) => void): void {
    STRATEGIES['test-strategy'] = {
        id: 'test-strategy',
        name: 'Test strategy',
        description: 'Only exists inside a test.',
        params: [],
        build: () => ({ params: {}, onBar: onBar as (ctx: unknown) => void }),
    } as unknown as StrategySpec;
}

function testBot(over: Partial<BotConfig> = {}): BotConfig {
    return { ...newBot('test-strategy', 'fake:TEST'), id: 'bot_test', timeframe: '1', balance: 10_000, ...over };
}

/** Replace part of the bridge, for the tests that need it to fail or to be slow. */
function stub(path: string, value: unknown): void {
    const parts = path.split('.');
    const last = parts.pop()!;
    let node = (globalThis as unknown as { window: { midori: Record<string, unknown> } }).window.midori;
    for (const part of parts) node = node[part] as Record<string, unknown>;
    node[last] = value;
}

/** The disk, as far as these tests are concerned. */
let accounts: Map<string, MidoriBotAccount>;
let storedBots: unknown[];
let filedRuns: Array<Record<string, unknown>>;
let journal: Array<Record<string, unknown>>;

beforeEach(() => {
    accounts = new Map();
    storedBots = [];
    filedRuns = [];
    journal = [];
    (globalThis as { window?: unknown }).window = {
        midori: {
            bots: {
                load: () => Promise.resolve(storedBots),
                save: (bots: unknown[]) => { storedBots = bots; return Promise.resolve({ savedAt: Date.now() }); },
                account: {
                    load: (id: string) => Promise.resolve(accounts.get(id) ?? null),
                    save: (id: string, account: MidoriBotAccountSnapshot) => {
                        accounts.set(id, { ...account, savedAt: Date.now() });
                        return Promise.resolve({ savedAt: Date.now() });
                    },
                    clear: (id: string) => { accounts.delete(id); return Promise.resolve(true); },
                    sweep: (keep: string[]) => {
                        let removed = 0;
                        for (const id of [...accounts.keys()]) {
                            if (!keep.includes(id)) { accounts.delete(id); removed += 1; }
                        }
                        return Promise.resolve({ removed });
                    },
                },
            },
            backtest: {
                save: (run: Record<string, unknown>) => {
                    filedRuns.push(run);
                    return Promise.resolve({ id: `run_${filedRuns.length}` });
                },
            },
            live: {
                append: (trade: Record<string, unknown>) => {
                    journal.push(trade);
                    return Promise.resolve({ added: true });
                },
            },
            capital: {
                environment: () => Promise.resolve({ configured: true, env: 'demo', live: false }),
                account: () => Promise.resolve(null),
                positions: () => Promise.resolve([]),
                workingOrders: () => Promise.resolve([]),
                marketInfo: () => Promise.resolve(null),
                openPosition: () => Promise.resolve({ accepted: true, dealId: 'position-1' }),
                amendPosition: () => Promise.resolve({ accepted: true, dealId: 'position-1' }),
                closePosition: () => Promise.resolve({ accepted: true, dealId: 'position-1' }),
                createOrder: () => Promise.resolve({ accepted: true, dealId: 'order-1' }),
                amendOrder: () => Promise.resolve({ accepted: true, dealId: 'order-1' }),
                cancelOrder: () => Promise.resolve({ accepted: true, dealId: 'order-1' }),
            },
        },
    };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 9, 14, 0)));
});

afterEach(() => {
    vi.useRealTimers();
    delete STRATEGIES['test-strategy'];
    delete (globalThis as { window?: unknown }).window;
});

/** Run a bot far enough to book one closed round trip, then stop it. */
async function tradeAndStop(bot: BotConfig): Promise<BotRunner> {
    installStrategy((ctx) => {
        if (ctx.index === 9) ctx.buy({ size: 0.01 });
        if (ctx.index === 12 && !ctx.isFlat) ctx.close('test');
    });
    const firstBarAt = Date.now() - 10 * MINUTE;
    const feed = fakeProvider(Array.from({ length: 10 }, (_, i) => bar(firstBarAt + i * MINUTE, 100 + i * 0.1)));
    const runner = new BotRunner({ bot, providers: { fake: () => feed.provider } });
    await runner.start();
    for (let i = 10; i <= 14; i += 1) feed.feed(bar(firstBarAt + i * MINUTE, 100 + i));
    runner.stop();
    return runner;
}

describe('a bot keeps its account', () => {
    it('writes it to disk as it trades', async () => {
        const runner = await tradeAndStop(testBot());
        expect(runner.paperController!.broker.trades.length).toBeGreaterThan(0);
        // Flushed on the way out: the runner is about to be the last place it exists.
        await runner.settle();
        expect(accounts.has('bot_test')).toBe(true);
    });

    it('picks it back up on the next start, trades and all', async () => {
        const first = await tradeAndStop(testBot());
        const traded = first.paperController!.broker.trades.length;
        const worth = first.equity();
        await first.settle();
        first.dispose();

        // A second runner over the same bot — what an app restart is.
        installStrategy(() => undefined);
        const feed = fakeProvider(seedBars(10));
        const second = new BotRunner({ bot: testBot(), providers: { fake: () => feed.provider } });
        await second.start();

        expect(second.paperController!.broker.trades.length).toBe(traded);
        expect(second.equity()).toBeCloseTo(worth, 6);
        expect(second.log.list().some((e) => e.text.includes('Picked its account back up'))).toBe(true);
        second.stop();
    });

    it('starts fresh when there is nothing stored', async () => {
        installStrategy(() => undefined);
        const feed = fakeProvider(seedBars(10));
        const runner = new BotRunner({ bot: testBot(), providers: { fake: () => feed.provider } });
        await runner.start();

        expect(runner.paperController!.broker.trades).toHaveLength(0);
        expect(runner.paperController!.broker.initialBalance).toBe(10_000);
        runner.stop();
    });

    it('refuses to start on a stored account still holding another market', async () => {
        // Its positions belong to the market that made them. Moving them across would mark
        // one instrument's position against another's prices.
        installStrategy((ctx) => { if (ctx.index === 9) ctx.buy({ size: 0.01 }); });
        const feed = fakeProvider(seedBars(10));
        const first = new BotRunner({ bot: testBot(), providers: { fake: () => feed.provider } });
        await first.start();
        feed.feed(bar(10 * MINUTE, 101));
        feed.feed(bar(11 * MINUTE, 102));
        expect(first.openPositions()).toBe(1);
        first.stop();
        /* Waited on, because the next runner READS this account off disk. This is the whole
         * job of `settle` — see BotRunner. */
        await first.settle();
        first.dispose();

        const moved = new BotRunner({
            bot: testBot({ symbol: 'fake:OTHER' }),
            providers: { fake: () => fakeProvider(seedBars(10)).provider },
        });
        await expect(moved.start()).rejects.toThrow(/still holding a position on fake:TEST/);
    });
});

describe('a bot keeps its unattended guards', () => {
    it('keeps today\'s entry count across a stop and restart', async () => {
        const bot = testBot({ guards: { maxTradesPerDay: 1, staleFeedSeconds: 0 } });
        const first = await tradeAndStop(bot);
        await first.settle();
        first.dispose();

        expect(accounts.get(bot.id)?.guards?.tradesToday).toBe(1);

        installStrategy(() => undefined);
        const feed = fakeProvider(seedBars(10));
        const second = new BotRunner({ bot, providers: { fake: () => feed.provider } });
        await second.start();

        expect(second.todaysTrades).toBe(1);
        expect(second.refusal()).toMatch(/trades for today/i);
        second.stop();
        await second.settle();
    });

    it('resets the daily count after UTC midnight but keeps a cooldown that crosses it', async () => {
        installStrategy(() => undefined);
        const bot = testBot({ guards: { cooldownMinutes: 120, staleFeedSeconds: 0 } });
        const first = new BotRunner({
            bot,
            providers: { fake: () => fakeProvider(seedBars(10)).provider },
        });
        await first.start();
        first.stop();
        await first.settle();
        first.dispose();

        const now = Date.now();
        const stored = accounts.get(bot.id)!;
        accounts.set(bot.id, {
            ...stored,
            guards: {
                dayKey: '2026-09-08',
                dayOpenEquity: 11_000,
                tradesToday: 7,
                lastLossAt: now - 30 * MINUTE,
            },
        });

        const second = new BotRunner({
            bot,
            providers: { fake: () => fakeProvider(seedBars(10)).provider },
        });
        await second.start();
        expect(second.todaysTrades).toBe(0);
        expect(second.refusal()).toMatch(/cooling off after a loss/i);
        second.stop();
        await second.settle();

        expect(accounts.get(bot.id)?.guards).toMatchObject({
            dayKey: '2026-09-09',
            tradesToday: 0,
            lastLossAt: now - 30 * MINUTE,
        });
    });

    it('counts a resting entry when it fills, not when it is merely placed', async () => {
        installStrategy((ctx) => {
            if (ctx.index === 9) ctx.order({ side: 'buy', type: 'limit', size: 1, limitPrice: 95 });
        });
        const bot = testBot({ guards: { maxTradesPerDay: 1, maxOpenPositions: 2, staleFeedSeconds: 0 } });
        const firstBarAt = Date.now() - 10 * MINUTE;
        const feed = fakeProvider(Array.from({ length: 10 }, (_, i) => (
            bar(firstBarAt + i * MINUTE, 100 + i * 0.1)
        )));
        const runner = new BotRunner({ bot, providers: { fake: () => feed.provider } });
        await runner.start();

        feed.feed(bar(firstBarAt + 10 * MINUTE, 101));
        expect(runner.restingOrders()).toBe(1);
        expect(runner.todaysTrades).toBe(0);

        feed.feed({
            time: firstBarAt + 11 * MINUTE,
            open: 101,
            high: 102,
            low: 94,
            close: 96,
            volume: 100,
        });
        expect(runner.todaysTrades).toBe(1);
        expect(runner.refusal()).toMatch(/trades for today/i);
        runner.stop();
        await runner.settle();
    });

    it('refuses to start when its durable state cannot be read', async () => {
        installStrategy(() => undefined);
        const feed = fakeProvider(seedBars(10));
        stub('bots.account.load', () => Promise.reject(new Error('runtime JSON is corrupt')));
        const runner = new BotRunner({ bot: testBot(), providers: { fake: () => feed.provider } });

        await expect(runner.start()).rejects.toThrow(/runtime JSON is corrupt/);
        expect(runner.status).toBe('failed');
        expect(runner.barCount).toBe(0);
    });
});

describe('a live bot owns only its confirmed venue ids', () => {
    it('will not initialize ownership over pre-existing exposure on the same market', async () => {
        installStrategy(() => undefined);
        stub('capital.positions', () => Promise.resolve([{ market: { epic: 'EURUSD' } }]));
        const runner = new BotRunner({
            bot: testBot({ venue: 'capital', symbol: 'capital:EURUSD' }),
            providers: { capital: () => fakeProvider(seedBars(10)).provider },
        });

        await expect(runner.start()).rejects.toThrow(/cannot safely assign pre-existing exposure/i);
        expect(runner.status).toBe('failed');
    });

    it('persists an empty, verified ownership book before it begins trading', async () => {
        installStrategy(() => undefined);
        const bot = testBot({ venue: 'capital', symbol: 'capital:EURUSD' });
        const runner = new BotRunner({
            bot,
            providers: { capital: () => fakeProvider(seedBars(10)).provider },
        });

        await runner.start();
        runner.stop();
        await runner.settle();

        expect(accounts.get(bot.id)).toMatchObject({
            symbol: 'capital:EURUSD',
            capital: {
                initialized: true,
                positionDealIds: [],
                workingOrderDealIds: [],
                uncertain: false,
            },
        });
        expect('session' in accounts.get(bot.id)!).toBe(false);
    });

    it('counts and persists a newly confirmed live entry', async () => {
        installStrategy((ctx) => {
            if (ctx.index === 9) ctx.buy({ size: 1000 });
        });
        const bot = testBot({
            venue: 'capital',
            symbol: 'capital:EURUSD',
            guards: { maxTradesPerDay: 1, staleFeedSeconds: 0 },
        });
        const firstBarAt = Date.now() - 10 * MINUTE;
        const feed = fakeProvider(Array.from(
            { length: 10 },
            (_, i) => bar(firstBarAt + i * MINUTE, 1.09 + i * 0.0001),
        ));
        const runner = new BotRunner({ bot, providers: { capital: () => feed.provider } });

        await runner.start();
        feed.feed(bar(firstBarAt + 10 * MINUTE, 1.092));
        await vi.advanceTimersByTimeAsync(0);

        expect(runner.todaysTrades).toBe(1);
        expect(runner.refusal()).toMatch(/trades for today/i);
        runner.stop();
        await runner.settle();
        expect(accounts.get(bot.id)).toMatchObject({
            guards: { tradesToday: 1 },
            capital: { positionDealIds: ['position-1'] },
        });
    });

    it('waits for an in-flight venue create before its stopped state is settled', async () => {
        installStrategy((ctx) => {
            if (ctx.index === 9) ctx.buy({ size: 1000 });
        });
        let answer!: (confirmation: Record<string, unknown>) => void;
        stub('capital.openPosition', () => new Promise((resolve) => { answer = resolve; }));
        const bot = testBot({ venue: 'capital', symbol: 'capital:EURUSD' });
        const firstBarAt = Date.now() - 10 * MINUTE;
        const feed = fakeProvider(Array.from(
            { length: 10 },
            (_, i) => bar(firstBarAt + i * MINUTE, 1.09 + i * 0.0001),
        ));
        const runner = new BotRunner({ bot, providers: { capital: () => feed.provider } });
        await runner.start();

        feed.feed(bar(firstBarAt + 10 * MINUTE, 1.092));
        runner.stop();
        let settled = false;
        const stopping = runner.settle().then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);

        answer({ accepted: true, dealId: 'position-late' });
        await stopping;
        expect(accounts.get(bot.id)?.capital).toMatchObject({
            positionDealIds: ['position-late'],
            uncertain: false,
        });
    });

    it('reads the current Capital.com environment when it starts', async () => {
        installStrategy(() => undefined);
        stub('capital.environment', () => Promise.resolve({ configured: true, env: 'live', live: true }));
        const runner = new BotRunner({
            bot: testBot({ venue: 'capital', symbol: 'capital:EURUSD' }),
            providers: { capital: () => fakeProvider(seedBars(10)).provider },
        });

        await runner.start();
        expect(runner.log.list().some((entry) => entry.text.includes('live money'))).toBe(true);
        runner.stop();
        await runner.settle();
    });

    it('does not start when the Capital.com account cannot be read safely', async () => {
        installStrategy(() => undefined);
        const feed = fakeProvider(seedBars(10));
        stub('capital.account', () => Promise.reject(new Error('account endpoint offline')));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const runner = new BotRunner({
            bot: testBot({ venue: 'capital', symbol: 'capital:EURUSD' }),
            providers: { capital: () => feed.provider },
        });

        await expect(runner.start()).rejects.toThrow(/could not be read/i);
        expect(runner.status).toBe('failed');
        expect(feed.subscribed).toBe(false);
        warn.mockRestore();
    });
});

describe('a live bot writes every closed trade to the journal', () => {
    /** One finished trade, as CapitalController reports one. */
    function closed(over: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            id: 'deal-1',
            symbol: 'EURUSD',
            side: 'long',
            size: 1000,
            entryPrice: 1.09,
            exitPrice: 1.095,
            openedAt: Date.now() - 60_000,
            closedAt: Date.now(),
            netPnl: 5,
            fees: 0.4,
            estimated: false,
            live: false,
            exitTag: null,
            currency: 'USD',
            ...over,
        };
    }

    /** Start a live bot far enough to have a controller, and hand back the hook the venue
     *  client would call. Nothing is subscribed to: the venue is never reached in a test. */
    async function liveRunner(): Promise<BotRunner> {
        installStrategy(() => undefined);
        const feed = fakeProvider(seedBars(10));
        const runner = new BotRunner({
            bot: testBot({ venue: 'capital', symbol: 'capital:EURUSD' }),
            providers: { capital: () => feed.provider },
        });
        await runner.start();
        return runner;
    }

    it('records it, because nothing else anywhere does', async () => {
        // The venue serves at most a day of history per request and loses it with the
        // account. A bot trading unwatched is exactly the case where nobody is there to
        // notice a trade went unrecorded.
        const runner = await liveRunner();
        runner.capitalController!.onTradeClosed!(closed() as never);
        await vi.advanceTimersByTimeAsync(0);

        expect(journal).toHaveLength(1);
        expect(journal[0]!.id).toBe('deal-1');
        expect(runner.log.list().some((e) => e.text.includes('journalled'))).toBe(true);
        runner.stop();
    });

    it('says so loudly when the journal could not be written', async () => {
        const runner = await liveRunner();
        stub('live.append', () => Promise.reject(new Error('disk full')));

        runner.capitalController!.onTradeClosed!(closed() as never);
        await vi.advanceTimersByTimeAsync(0);

        const said = runner.log.list().find((e) => e.kind === 'error');
        expect(said?.text).toMatch(/only record this happened/);
        runner.stop();
    });

    it('arms the cooldown guard on a losing trade', async () => {
        // A live account keeps no trade ledger this app can read, so the closure hook is the
        // only place a loss can be noticed at all.
        const runner = await liveRunner();
        runner.capitalController!.onTradeClosed!(closed({ netPnl: -12 }) as never);
        await vi.advanceTimersByTimeAsync(0);

        expect(journal).toHaveLength(1);
        runner.stop();
        await runner.settle();
        expect(accounts.get('bot_test')?.guards?.lastLossAt).toBe(Date.now());
    });
});

describe('an account is filed before it is thrown away', () => {
    function engine(): BotEngine {
        return new BotEngine({ providers: { fake: () => fakeProvider(seedBars(10)).provider } });
    }

    it('files a deleted bot\'s account as a run', async () => {
        const bot = testBot();
        const runner = await tradeAndStop(bot);
        await runner.settle();
        runner.dispose();

        const e = engine();
        storedBots = [bot];
        await e.load();
        await e.remove(bot.id);

        expect(filedRuns).toHaveLength(1);
        expect(filedRuns[0]!.strategy).toBe('test-strategy');
        // The note is what stops a bot's run being read as a backtest of the same strategy.
        expect(String(filedRuns[0]!.note)).toMatch(/Trading bot/);
        // Only then is the account gone.
        expect(accounts.has(bot.id)).toBe(false);
        expect(e.list()).toHaveLength(0);
    });

    it('keeps the bot when filing fails, rather than deleting the evidence', async () => {
        const bot = testBot();
        const runner = await tradeAndStop(bot);
        await runner.settle();
        runner.dispose();

        stub('backtest.save', () => Promise.reject(new Error('disk full')));

        const e = engine();
        storedBots = [bot];
        await e.load();
        await expect(e.remove(bot.id)).rejects.toThrow(/NOT deleted/);

        expect(e.list()).toHaveLength(1);
        expect(accounts.has(bot.id)).toBe(true);
    });

    it('deletes a bot that never traded without filing anything', async () => {
        const bot = testBot();
        const e = engine();
        storedBots = [bot];
        await e.load();
        await e.remove(bot.id);

        expect(filedRuns).toHaveLength(0);
        expect(e.list()).toHaveLength(0);
    });

    it('files the account on a reset and starts over', async () => {
        const bot = testBot();
        const runner = await tradeAndStop(bot);
        await runner.settle();
        runner.dispose();

        const e = engine();
        storedBots = [bot];
        await e.load();
        const filed = await e.resetAccount(bot.id);

        expect(filed).toBe('run_1');
        expect(accounts.has(bot.id)).toBe(false);
        // The bot itself is untouched — only its account started over.
        expect(e.list()).toHaveLength(1);
    });

    it('does not let a write still in flight resurrect a reset account', async () => {
        /* The bug this test exists for: the account is written on a delay, and stopping a bot
         * only STARTS that write. A reset that deleted the account while the write was still
         * going put it straight back — a reset that silently did nothing. Only a real app
         * run found it, because the fake disk answered instantly.
         *
         * Here the save is made slow on purpose, which is what a real one is. */
        const bot = testBot();
        const runner = await tradeAndStop(bot);
        await runner.settle();
        runner.dispose();

        const gate: { release: (() => void) | null } = { release: null };
        const realSave = (globalThis as unknown as {
            window: { midori: { bots: { account: { save: (id: string, a: unknown) => Promise<unknown> } } } };
        }).window.midori.bots.account.save;
        stub('bots.account', {
            ...(globalThis as unknown as {
                window: { midori: { bots: { account: Record<string, unknown> } } };
            }).window.midori.bots.account,
            save: (id: string, account: unknown) => new Promise((resolve) => {
                gate.release = () => resolve(realSave(id, account));
            }),
        } as never);

        const e = engine();
        storedBots = [bot];
        await e.load();

        const reset = e.resetAccount(bot.id);
        // The slow write lands in the middle of the reset, exactly as it did in the app.
        gate.release?.();
        await reset;

        expect(accounts.has(bot.id)).toBe(false);
    });

    it('leaves nothing behind when the account it filed is deleted', async () => {
        /* The second half of the same bug. `resetAccount` builds a runner purely to READ the
         * stored account and file it — and that runner used to write the account back as it
         * was thrown away, landing after the delete. Only the app found it: in a test the
         * fake disk answered fast enough that the delete happened to win. */
        const bot = testBot();
        const runner = await tradeAndStop(bot);
        await runner.settle();
        runner.dispose();

        const e = engine();
        storedBots = [bot];
        await e.load();
        await e.resetAccount(bot.id);
        // Anything the helper started would land in the next few ticks.
        await vi.advanceTimersByTimeAsync(2000);

        expect(accounts.has(bot.id)).toBe(false);
    });

    it('sweeps accounts whose bot is gone', async () => {
        accounts.set('bot_ghost', { symbol: 'fake:TEST', session: {}, savedAt: 0 });
        const e = engine();
        storedBots = [testBot()];
        await e.load();
        await vi.advanceTimersByTimeAsync(0);

        expect(accounts.has('bot_ghost')).toBe(false);
    });
});

describe('the engine lifecycle', () => {
    it('loads a stored stopped paper account for display without opening a feed', async () => {
        const bot = testBot();
        const stored = await tradeAndStop(bot);
        await stored.settle();
        stored.dispose();
        storedBots = [bot];
        let subscriptions = 0;
        const engine = new BotEngine({
            providers: {
                fake: () => ({
                    getBars: () => Promise.resolve(seedBars(10)),
                    subscribe: () => { subscriptions += 1; return () => undefined; },
                }),
            },
        });

        await engine.load();

        expect(engine.runner(bot.id)).toBeNull();
        expect(engine.displayRunner(bot.id)?.paperController?.broker.trades).toHaveLength(1);
        expect(engine.displayRunner(bot.id)?.log.last()?.text).toMatch(/account restored/i);
        expect(subscriptions).toBe(0);
    });

    it('keeps a stopped account and activity as a read-only display without keeping its feed alive', async () => {
        installStrategy(() => undefined);
        const feed = fakeProvider(seedBars(10));
        const bot = testBot();
        storedBots = [bot];
        const engine = new BotEngine({ providers: { fake: () => feed.provider } });
        await engine.load();
        await engine.start(bot.id);
        const active = engine.runner(bot.id);

        expect(active).not.toBeNull();
        expect(feed.subscribed).toBe(true);
        await engine.stop(bot.id);

        const readout = engine.displayRunner(bot.id);
        expect(engine.runner(bot.id)).toBeNull();
        expect(readout).toBe(active);
        expect(readout?.paperController).not.toBeNull();
        expect(readout?.log.last()?.text).toBe('Stopped.');
        expect(feed.unsubscribed).toBe(true);

        await engine.start(bot.id);
        expect(engine.displayRunner(bot.id)).toBe(engine.runner(bot.id));
        expect(engine.displayRunner(bot.id)).not.toBe(readout);
        await engine.stop(bot.id);
    });

    it('coalesces concurrent loads into one read and one bot list', async () => {
        let releaseLoad: (bots: unknown[]) => void = () => undefined;
        let loadCalls = 0;
        stub('bots.load', () => {
            loadCalls += 1;
            return new Promise((resolve) => { releaseLoad = resolve; });
        });
        const engine = new BotEngine({ providers: {} });

        const firstLoad = engine.load();
        const secondLoad = engine.load();
        expect(loadCalls).toBe(1);
        releaseLoad([testBot()]);
        await Promise.all([firstLoad, secondLoad]);

        expect(engine.ready).toBe(true);
        expect(engine.list()).toHaveLength(1);
    });

    it('coalesces duplicate starts and cannot be re-enabled by a start that was stopped', async () => {
        installStrategy(() => undefined);
        let releaseHistory: (bars: OHLCV[]) => void = () => undefined;
        let subscriptions = 0;
        const provider: DataProvider = {
            getBars: () => new Promise((resolve) => { releaseHistory = resolve; }),
            subscribe: () => {
                subscriptions += 1;
                return () => undefined;
            },
        };
        const bot = testBot();
        storedBots = [bot];
        const engine = new BotEngine({ providers: { fake: () => provider } });
        await engine.load();

        const firstStart = engine.start(bot.id);
        const secondStart = engine.start(bot.id);
        await vi.waitFor(() => expect(engine.status(bot.id)).toBe('starting'));
        await engine.stop(bot.id);
        releaseHistory(seedBars(10));
        await Promise.all([firstStart, secondStart]);

        expect(engine.runner(bot.id)).toBeNull();
        expect(engine.find(bot.id)?.enabled).toBe(false);
        expect(subscriptions).toBe(0);
    });

    it('can start a fresh runner while the cancelled history request is still pending', async () => {
        installStrategy(() => undefined);
        let releaseOldHistory: (bars: OHLCV[]) => void = () => undefined;
        let providerBuilds = 0;
        let oldSubscriptions = 0;
        let freshSubscriptions = 0;
        const stalled: DataProvider = {
            getBars: () => new Promise((resolve) => { releaseOldHistory = resolve; }),
            subscribe: () => {
                oldSubscriptions += 1;
                return () => undefined;
            },
        };
        const fresh: DataProvider = {
            getBars: () => Promise.resolve(seedBars(10)),
            subscribe: () => {
                freshSubscriptions += 1;
                return () => undefined;
            },
        };
        const bot = testBot();
        storedBots = [bot];
        const engine = new BotEngine({
            providers: { fake: () => (providerBuilds++ === 0 ? stalled : fresh) },
        });
        await engine.load();

        const cancelledStart = engine.start(bot.id);
        await vi.waitFor(() => expect(engine.status(bot.id)).toBe('starting'));
        await engine.stop(bot.id);
        await engine.start(bot.id);

        expect(engine.status(bot.id)).toBe('running');
        expect(freshSubscriptions).toBe(1);
        releaseOldHistory(seedBars(10));
        await cancelledStart;

        expect(engine.status(bot.id)).toBe('running');
        expect(engine.find(bot.id)?.enabled).toBe(true);
        expect(oldSubscriptions).toBe(0);
        await engine.stop(bot.id);
    });

    it('waits for the final account write during shutdown and preserves resume intent', async () => {
        installStrategy(() => undefined);
        const feed = fakeProvider(seedBars(10));
        const bot = testBot();
        storedBots = [bot];
        const engine = new BotEngine({ providers: { fake: () => feed.provider } });
        await engine.load();
        await engine.start(bot.id);

        let releaseSave: () => void = () => undefined;
        let saveStarted = false;
        let saveCalls = 0;
        stub('bots.account', {
            ...(globalThis as unknown as {
                window: { midori: { bots: { account: Record<string, unknown> } } };
            }).window.midori.bots.account,
            save: () => {
                saveCalls += 1;
                if (saveCalls > 1) return Promise.resolve({ savedAt: Date.now() });
                return new Promise((resolve) => {
                    saveStarted = true;
                    releaseSave = () => resolve({ savedAt: Date.now() });
                });
            },
        } as never);

        let finished = false;
        const shutdown = engine.shutdown().then(() => { finished = true; });
        await vi.waitFor(() => expect(saveStarted).toBe(true));
        expect(finished).toBe(false);
        expect(engine.find(bot.id)?.enabled).toBe(true);

        releaseSave();
        await shutdown;

        expect(finished).toBe(true);
        expect(engine.runner(bot.id)).toBeNull();
        expect(engine.find(bot.id)?.enabled).toBe(true);
    });
});
