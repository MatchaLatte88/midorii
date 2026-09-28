// A bot, running. The rules under test: a bar is only handed to the strategy once it has
// CLOSED, the strategy's own state survives being rebuilt on every bar, the guards gate
// entries without ever stopping a strategy managing what it already holds, and stopping a
// bot never closes anything.
// See app/renderer/bot/BotRunner.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BotRunner } from '../app/renderer/bot/BotRunner';
import { STRATEGIES } from '../app/renderer/strategies';
import type { StrategySpec } from '../app/renderer/strategies/types';
import type { DataProvider } from '../src/plugin';
import type { OHLCV } from '../src/core/model/ohlcv';
import type { BacktestContext } from '../shared/engine/backtest';
import { HISTORY_BARS, MAX_HISTORY_BARS, newBot, type BotConfig } from '../app/renderer/bot/botTypes';

const MINUTE = 60_000;

function bar(time: number, close: number): OHLCV {
    return { time, open: close, high: close + 0.5, low: close - 0.5, close, volume: 100 };
}

/** Enough seed bars for the runner to start on. Prices walk up so nothing is ambiguous. */
function seedBars(count: number): OHLCV[] {
    return Array.from({ length: count }, (_, i) => bar(i * MINUTE, 100 + i * 0.1));
}

/** A provider whose live feed the test drives by hand. */
function fakeProvider(bars: OHLCV[]) {
    let push: ((bar: OHLCV) => void) | null = null;
    let unsubscribed = false;
    const provider: DataProvider = {
        getBars: () => Promise.resolve(bars),
        subscribe: (_ticker, _tf, onBar) => {
            push = onBar;
            return () => { unsubscribed = true; push = null; };
        },
    };
    return {
        provider,
        feed: (b: OHLCV) => push?.(b),
        get subscribed() { return push != null; },
        get unsubscribed() { return unsubscribed; },
    };
}

/**
 * A strategy whose behaviour the test dictates, put into the registry for the run.
 *
 * A real strategy would work here too and one of them is exercised elsewhere; what this
 * file is about is the RUNNER — whether a bar reaches `onBar` once, at the right moment,
 * with the state it left behind last time.
 */
function installStrategy(id: string, onBar: (ctx: BacktestContext) => void): void {
    const spec: StrategySpec = {
        id,
        name: 'Test strategy',
        description: 'Only exists inside a test.',
        params: [],
        build: () => ({ params: {}, onBar: onBar as StrategySpec['build'] extends never ? never : (ctx: unknown) => void }),
    };
    STRATEGIES[id] = spec;
}

function testBot(over: Partial<BotConfig> = {}): BotConfig {
    return { ...newBot('test-strategy', 'fake:TEST'), timeframe: '1', balance: 10_000, ...over };
}

/** A runner on the fake provider, with the guards wide open unless the test says otherwise. */
function makeRunner(provider: DataProvider, bot: BotConfig): BotRunner {
    return new BotRunner({ bot, providers: { fake: () => provider } });
}

let calls: Array<{ index: number; close: number; state: Record<string, unknown> }>;

beforeEach(() => {
    calls = [];
    /* The runner reads and writes its account through the bridge now, so a bare stub is no
     * longer enough — a missing channel would fail every start rather than the thing under
     * test. Nothing here persists: what these tests are about is the runner, not the disk
     * (see bot-account-persistence.test.ts for that). */
    (globalThis as { window?: unknown }).window = {
        midori: {
            bots: {
                account: {
                    load: () => Promise.resolve(null),
                    save: () => Promise.resolve({ savedAt: Date.now() }),
                    clear: () => Promise.resolve(true),
                    sweep: () => Promise.resolve({ removed: 0 }),
                },
            },
        },
    };
    // A Wednesday at 14:00 UTC — inside the default Mon–Fri, whole-day window.
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 9, 14, 0)));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 9, 14, 0)));
});

afterEach(() => {
    vi.useRealTimers();
    delete STRATEGIES['test-strategy'];
    delete (globalThis as { window?: unknown }).window;
});

describe('starting', () => {
    it('does not open a feed after it is stopped while history is still loading', async () => {
        installStrategy('test-strategy', () => undefined);
        let releaseHistory: (bars: OHLCV[]) => void = () => undefined;
        let subscriptions = 0;
        const provider: DataProvider = {
            getBars: () => new Promise((resolve) => { releaseHistory = resolve; }),
            subscribe: () => {
                subscriptions += 1;
                return () => undefined;
            },
        };
        const runner = makeRunner(provider, testBot());

        const starting = runner.start();
        await vi.waitFor(() => expect(runner.status).toBe('starting'));
        runner.stop();
        releaseHistory(seedBars(10));
        await starting;

        expect(runner.status).toBe('stopped');
        expect(subscriptions).toBe(0);
    });

    it('seeds the history without the bar that is still forming', async () => {
        installStrategy('test-strategy', () => undefined);
        const bars = seedBars(10);
        const feed = fakeProvider(bars);
        const runner = makeRunner(feed.provider, testBot());

        await runner.start();

        expect(runner.status).toBe('running');
        // Ten bars served, nine of them closed: the newest is the forming candle, and a
        // strategy handed a bar that is still moving is a strategy reading the future.
        expect(runner.barCount).toBe(9);
        expect(feed.subscribed).toBe(true);
        runner.stop();
    });

    it('refuses a market with no live feed rather than sitting there inert', async () => {
        installStrategy('test-strategy', () => undefined);
        const provider: DataProvider = { getBars: () => Promise.resolve(seedBars(10)) };
        const runner = makeRunner(provider, testBot());

        await expect(runner.start()).rejects.toThrow(/no live feed/);
        expect(runner.status).toBe('failed');
    });

    it('refuses a strategy this build does not have', async () => {
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot({ strategy: 'not-a-strategy' }));

        await expect(runner.start()).rejects.toThrow(/no strategy called/);
        expect(feed.subscribed).toBe(false);
    });

    it('refuses a live bot pointed at a market the venue does not serve', async () => {
        installStrategy('test-strategy', () => undefined);
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot({ venue: 'capital', symbol: 'binance:BTCUSDT' }));

        await expect(runner.start()).rejects.toThrow(/Capital\.com market/);
    });

    it('refuses a market that serves nothing', async () => {
        installStrategy('test-strategy', () => undefined);
        const feed = fakeProvider([]);
        const runner = makeRunner(feed.provider, testBot());

        await expect(runner.start()).rejects.toThrow(/served no bars/);
    });
});

describe('the feed', () => {
    it('calls the strategy once, when a bar has closed', async () => {
        installStrategy('test-strategy', (ctx) => {
            calls.push({ index: ctx.index, close: ctx.bar.close, state: ctx.state });
        });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        // The bar that was forming at seed time, updated twice: still forming, so nothing.
        feed.feed(bar(9 * MINUTE, 101.0));
        feed.feed(bar(9 * MINUTE, 101.4));
        expect(calls).toHaveLength(0);

        // A new bar opens — the one before it has closed, at the last price it was seen at.
        feed.feed(bar(10 * MINUTE, 102));
        expect(calls).toHaveLength(1);
        expect(calls[0]!.close).toBe(101.4);
        expect(calls[0]!.index).toBe(9);
        expect(runner.barCount).toBe(10);

        runner.stop();
    });

    it('does not run a bar twice when the feed re-sends one', async () => {
        installStrategy('test-strategy', (ctx) => {
            calls.push({ index: ctx.index, close: ctx.bar.close, state: ctx.state });
        });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));
        expect(calls).toHaveLength(1);

        // A reconnect replays the last bar. A strategy that places one order per session
        // would place two if this got through.
        feed.feed(bar(9 * MINUTE, 101.4));
        feed.feed(bar(10 * MINUTE, 102.1));
        expect(calls).toHaveLength(1);

        runner.stop();
    });

    it('keeps the strategy\'s own state across the rebuild every bar costs', async () => {
        installStrategy('test-strategy', (ctx) => {
            const seen = (ctx.state.seen as number | undefined) ?? 0;
            ctx.state.seen = seen + 1;
            calls.push({ index: ctx.index, close: ctx.bar.close, state: ctx.state });
        });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));
        feed.feed(bar(11 * MINUTE, 103));
        feed.feed(bar(12 * MINUTE, 104));

        expect(calls).toHaveLength(3);
        expect(calls[2]!.state.seen).toBe(3);
        runner.stop();
    });

    it('gives the strategy an index that keeps growing, so a stored one still means its bar', async () => {
        installStrategy('test-strategy', (ctx) => {
            calls.push({ index: ctx.index, close: ctx.bar.close, state: ctx.state });
        });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));
        feed.feed(bar(11 * MINUTE, 103));

        expect(calls.map((c) => c.index)).toEqual([9, 10]);
        runner.stop();
    });
});

describe('trading', () => {
    it('sends the strategy\'s order to the bot\'s own paper account', async () => {
        installStrategy('test-strategy', (ctx) => {
            if (ctx.index === 9) ctx.order({ side: 'buy', type: 'stop', size: 1, stopPrice: 105 });
        });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));

        expect(runner.restingOrders()).toBe(1);
        expect(runner.paperController?.broker.pending[0]?.stopPrice).toBe(105);
        // The bot's account, not the Chart tab's: it opens on the bot's own balance.
        expect(runner.paperController?.broker.initialBalance).toBe(10_000);
        runner.stop();
    });

    it('records what it placed on its own tape', async () => {
        installStrategy('test-strategy', (ctx) => {
            if (ctx.index === 9) ctx.order({ side: 'buy', type: 'stop', size: 1, stopPrice: 105 });
        });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));

        expect(runner.log.list().some((e) => e.kind === 'order' && e.text.includes('105'))).toBe(true);
        runner.stop();
    });
});

describe('the guards', () => {
    it('turn an entry away and say which guard it was', async () => {
        installStrategy('test-strategy', (ctx) => {
            ctx.order({ side: 'buy', type: 'stop', size: 1, stopPrice: 105 });
        });
        const feed = fakeProvider(seedBars(10));
        // A window that is shut at 14:00 UTC.
        const runner = makeRunner(feed.provider, testBot({
            guards: { sessionStart: 9 * 60, sessionEnd: 10 * 60 },
        }));
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));

        expect(runner.restingOrders()).toBe(0);
        const refused = runner.log.list().find((e) => e.kind === 'refused');
        expect(refused?.text).toMatch(/trading window/);
        runner.stop();
    });

    it('never stop a strategy running — only its entries', async () => {
        // The rule this whole design turns on: a strategy holding a position has work to do
        // on every bar, and a guard that stopped `onBar` would strand exactly the position
        // the guards exist to protect.
        installStrategy('test-strategy', (ctx) => {
            calls.push({ index: ctx.index, close: ctx.bar.close, state: ctx.state });
        });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot({
            guards: { sessionStart: 9 * 60, sessionEnd: 10 * 60 },
        }));
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));
        feed.feed(bar(11 * MINUTE, 103));

        expect(calls).toHaveLength(2);
        runner.stop();
    });

    it('report what would be refused right now, without anything having to ask for a trade', async () => {
        installStrategy('test-strategy', () => undefined);
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot({
            guards: { sessionStart: 9 * 60, sessionEnd: 10 * 60 },
        }));
        await runner.start();

        expect(runner.refusal()).toMatch(/trading window/);
        expect(runner.inWindow()).toBe(false);
        runner.stop();
    });

    it('are silent when nothing is wrong', async () => {
        installStrategy('test-strategy', () => undefined);
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();
        feed.feed(bar(10 * MINUTE, 102));

        expect(runner.refusal()).toBeNull();
        runner.stop();
    });
});

describe('a strategy that fails', () => {
    it('is reported rather than silently doing nothing forever', async () => {
        installStrategy('test-strategy', () => { throw new Error('detector blew up'); });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));

        expect(runner.log.list().some((e) => e.kind === 'error' && e.text.includes('detector blew up'))).toBe(true);
        // Still running: one bad bar is not a reason to stop watching the market.
        expect(runner.status).toBe('running');
        runner.stop();
    });
});

describe('strategy.init', () => {
    /** Installs a strategy with both hooks, the way the registry actually shapes one —
     *  `installStrategy` above only ever wires `onBar`. */
    function installWithInit(
        id: string,
        init: (ctx: BacktestContext) => void,
        onBar: (ctx: BacktestContext) => void = () => undefined,
    ): void {
        const spec: StrategySpec = {
            id,
            name: 'Test strategy',
            description: 'Only exists inside a test.',
            params: [],
            build: () => ({
                params: {}, init, onBar,
            } as unknown as ReturnType<StrategySpec['build']>),
        };
        STRATEGIES[id] = spec;
    }

    it('runs once, before the first onBar ever reads ctx.state', async () => {
        const seen: string[] = [];
        installWithInit(
            'test-strategy',
            (ctx) => { seen.push('init'); ctx.state.seeded = true; },
            (ctx) => { seen.push(`onBar:${String(ctx.state.seeded)}`); },
        );
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));
        feed.feed(bar(11 * MINUTE, 103));

        // init before the very first onBar, and never again on the second bar.
        expect(seen).toEqual(['init', 'onBar:true', 'onBar:true']);
        runner.stop();
    });

    it('reports a failing init once rather than retrying it every bar', async () => {
        let calls_ = 0;
        installWithInit('test-strategy', () => { calls_ += 1; throw new Error('init blew up'); });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        feed.feed(bar(10 * MINUTE, 102));
        feed.feed(bar(11 * MINUTE, 103));

        expect(calls_).toBe(1);
        expect(runner.log.list().some((e) => e.kind === 'error' && e.text.includes('init blew up'))).toBe(true);
        expect(runner.status).toBe('running');
        runner.stop();
    });

    it('runs again after a stop and restart', async () => {
        let calls_ = 0;
        installWithInit('test-strategy', () => { calls_ += 1; });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());

        await runner.start();
        feed.feed(bar(10 * MINUTE, 102));
        expect(calls_).toBe(1);
        runner.stop();

        await runner.start();
        feed.feed(bar(11 * MINUTE, 103));
        expect(calls_).toBe(2);
        runner.stop();
    });
});

describe('the history window', () => {
    /** Start a runner already seeded to the brim, then feed it `extra` more closed bars. */
    async function runTo(extra: number, onBar: (ctx: BacktestContext) => void): Promise<BotRunner> {
        installStrategy('test-strategy', onBar);
        // One more than the window, so the seed (which drops the forming bar) lands exactly on it.
        const feed = fakeProvider(seedBars(HISTORY_BARS + 1));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();
        for (let i = 0; i < extra; i += 1) {
            feed.feed(bar((HISTORY_BARS + i) * MINUTE, 100 + i));
        }
        return runner;
    }

    it('trims back to the window once the strategy is holding nothing', async () => {
        const runner = await runTo(5, () => undefined);
        // Five bars past the window, and back at it: the rebuild cost stops growing here.
        expect(runner.barCount).toBe(HISTORY_BARS);
        runner.stop();
    });

    it('lets the history grow while the strategy is holding a bar index', async () => {
        // The shape every strategy in this app uses: one object in `state`, cleared when the
        // setup is done. While it is set, renumbering the bars under it would move the index
        // it is waiting for.
        const runner = await runTo(5, (ctx) => { ctx.state.session = { flatIndex: ctx.index + 500 }; });
        expect(runner.barCount).toBeGreaterThan(HISTORY_BARS);
        runner.stop();
    });

    it('trims as soon as the strategy lets go', async () => {
        let hold = true;
        installStrategy('test-strategy', (ctx) => { ctx.state.session = hold ? { flatIndex: 1 } : undefined; });
        const feed = fakeProvider(seedBars(HISTORY_BARS + 1));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        for (let i = 0; i < 5; i += 1) feed.feed(bar((HISTORY_BARS + i) * MINUTE, 100));
        expect(runner.barCount).toBeGreaterThan(HISTORY_BARS);

        hold = false;
        feed.feed(bar((HISTORY_BARS + 5) * MINUTE, 100));
        expect(runner.barCount).toBe(HISTORY_BARS);
        runner.stop();
    });

    it('lets the history grow while a position is open', async () => {
        const runner = await runTo(5, (ctx) => {
            if (ctx.index === HISTORY_BARS) ctx.buy({ size: 0.01 });
        });
        expect(runner.openPositions()).toBe(1);
        expect(runner.barCount).toBeGreaterThan(HISTORY_BARS);
        runner.stop();
    });

    it('lets the history grow while an order is resting', async () => {
        const runner = await runTo(5, (ctx) => {
            if (ctx.index === HISTORY_BARS) ctx.order({ side: 'buy', type: 'stop', size: 0.01, stopPrice: 1e9 });
        });
        expect(runner.restingOrders()).toBe(1);
        expect(runner.barCount).toBeGreaterThan(HISTORY_BARS);
        runner.stop();
    });

    it('cuts anyway at the hard limit, and says what it cost', async () => {
        // A strategy that never lets go. Without the backstop this one gets slower every day
        // until a bar close stalls the window.
        const runner = await runTo(MAX_HISTORY_BARS - HISTORY_BARS + 1, (ctx) => {
            ctx.state.session = { flatIndex: ctx.index + 10 };
        });
        expect(runner.barCount).toBe(HISTORY_BARS);
        const said = runner.log.list().find((e) => e.kind === 'error');
        expect(said?.text).toMatch(/state dropped with it/);
        runner.stop();
    }, 20_000);
});

describe('stopping', () => {
    it('closes the feed', async () => {
        installStrategy('test-strategy', () => undefined);
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();

        runner.stop();

        expect(runner.status).toBe('stopped');
        expect(feed.unsubscribed).toBe(true);
    });

    it('does not close what the bot is holding, and says so', async () => {
        installStrategy('test-strategy', (ctx) => {
            if (ctx.index === 9) ctx.order({ side: 'buy', type: 'stop', size: 1, stopPrice: 105 });
        });
        const feed = fakeProvider(seedBars(10));
        const runner = makeRunner(feed.provider, testBot());
        await runner.start();
        feed.feed(bar(10 * MINUTE, 102));
        expect(runner.restingOrders()).toBe(1);

        runner.stop();

        // Stopping a bot stops it DECIDING. Liquidating on a button press would be the app
        // making a trading decision nobody asked it to make.
        expect(runner.paperController?.broker.pending).toHaveLength(1);
        expect(runner.log.last()?.text).toMatch(/nothing was closed/);
    });

    it('refuses an edit while it is running', async () => {
        installStrategy('test-strategy', () => undefined);
        const feed = fakeProvider(seedBars(10));
        const bot = testBot();
        const runner = makeRunner(feed.provider, bot);
        await runner.start();

        expect(() => runner.update({ ...bot, name: 'Renamed' })).toThrow(/Stop the bot/);
        runner.stop();
        expect(() => runner.update({ ...bot, name: 'Renamed' })).not.toThrow();
    });
});
