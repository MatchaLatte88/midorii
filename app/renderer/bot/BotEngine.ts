import type { DataProvider } from '../../../src/plugin';
import { BotRunner, type BotStatus } from './BotRunner';
import { clearBotAccount, sweepBotAccounts } from './botAccountStore';
import { normalizeBot, toStored, type BotConfig } from './botTypes';

/**
 * Every bot this machine has, and which of them are running.
 *
 * The list lives here rather than in the screen that edits it, for the reason a running bot
 * exists at all: it has to keep running while somebody is looking at the chart. A bot whose
 * runner belonged to a view would stop the moment the view unmounted, which is the one
 * thing an unattended strategy must not do.
 *
 * An active runner and a stopped readout are different things
 * -----------------------------------------------------------
 * A stopped bot has no active runner: no feed, no timers and no strategy making decisions.
 * Its last account and activity stay in a disposed runner purely as a read-only screen model.
 * That distinction makes the stop state honest without blanking the evidence somebody needs
 * to decide what to do next. Starting again discards the readout and builds a fresh runner.
 *
 * What a stopped bot does NOT throw away is its account. That is on disk (see
 * botAccountStore) and is picked back up on the next start, because a bot is meant to run for
 * weeks and its trades are the only evidence of what it did.
 *
 * Deleting one is the other thing entirely
 * ----------------------------------------
 * A deleted bot's account is filed as a run first — the same shelf a backtest of that
 * strategy lands on, which is the only place the two can be compared — and only then thrown
 * away. Weeks of trading must not disappear because somebody tidied up a list, and "delete"
 * must not quietly mean "delete the evidence".
 *
 * Restoring on startup
 * --------------------
 * Paper bots marked enabled come back by themselves. Live ones never do — a real account is
 * armed by a person each time the app starts, which is the same rule the chart's Trade menu
 * follows for Capital.com, and for the same reason: an app that came back up already
 * trading real money would be trading it on nobody's decision.
 */

export interface BotEngineOptions {
    /** Every market source the app can reach. Each bot builds its own instances from these. */
    providers: Record<string, () => DataProvider>;
    /** Told whenever anything about any bot changed. */
    onChange?: () => void;
    /** How a failure that nobody asked for reaches a person. */
    notify?: (message: string, kind: 'info' | 'error' | 'success') => void;
}

export class BotEngine {
    private bots: BotConfig[] = [];
    private readonly runners = new Map<string, BotRunner>();
    /** Disposed runners kept only so the stopped bot screen can still show its last account
     *  and activity. They own no feed, timer or pending writer. */
    private readonly stoppedReadouts = new Map<string, BotRunner>();
    private readonly starts = new Map<string, Promise<void>>();
    private readonly stops = new Map<string, Promise<void>>();
    private readonly listeners = new Set<() => void>();
    private readonly opts: BotEngineOptions;
    private loaded = false;
    private loadTask: Promise<void> | null = null;
    private persistence: Promise<void> = Promise.resolve();
    private shutdownTask: Promise<void> | null = null;

    constructor(opts: BotEngineOptions) {
        this.opts = opts;
        if (opts.onChange) this.listeners.add(opts.onChange);
    }

    /** Listen to engine changes. The engine outlives the optional screen that observes it. */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Every bot, in the order they were stored. */
    list(): readonly BotConfig[] {
        return this.bots;
    }

    find(id: string): BotConfig | undefined {
        return this.bots.find((b) => b.id === id);
    }

    /** The runner behind a bot, or null when it is not running. */
    runner(id: string): BotRunner | null {
        return this.runners.get(id) ?? null;
    }

    /** The current runner, or the last fully stopped one for a read-only screen. */
    displayRunner(id: string): BotRunner | null {
        return this.runners.get(id) ?? this.stoppedReadouts.get(id) ?? null;
    }

    status(id: string): BotStatus {
        if (this.stops.has(id)) return 'stopping';
        return this.runners.get(id)?.status ?? 'stopped';
    }

    /** How many are running right now — for the tab's own badge. */
    get runningCount(): number {
        let count = 0;
        for (const runner of this.runners.values()) {
            if (runner.status === 'running' || runner.status === 'starting') count += 1;
        }
        return count;
    }

    /**
     * Read the stored bots.
     *
     * A record the current build cannot make sense of is dropped and said out loud rather
     * than half-loaded: a bot is a thing that sends orders, and one assembled from a
     * definition nobody could fully read is exactly the kind of thing that should not.
     */
    async load(): Promise<void> {
        if (this.loaded) return;
        if (this.loadTask) return this.loadTask;
        const task = this.loadOnce();
        this.loadTask = task;
        try {
            await task;
        } finally {
            if (this.loadTask === task) this.loadTask = null;
        }
    }

    private async loadOnce(): Promise<void> {
        const stored = await window.midori.bots.load();
        const bots: BotConfig[] = [];
        let dropped = 0;
        for (const raw of stored) {
            const bot = normalizeBot(raw);
            if (bot) bots.push(bot);
            else dropped += 1;
        }
        this.bots = bots;
        await Promise.all(bots
            .filter((bot) => bot.venue === 'paper' && !bot.enabled)
            .map((bot) => this.restoreStoppedReadout(bot)));
        this.loaded = true;
        /* Accounts whose bot is gone. Only ever finds one left behind by a crash between the
         * two writes in `remove`, but left alone it would sit there for good carrying an
         * account's worth of trades. */
        void sweepBotAccounts(bots.map((b) => b.id)).catch((err: unknown) => (
            console.error('[midorii] could not sweep the orphaned bot accounts', err)
        ));
        if (dropped > 0) {
            this.opts.notify?.(
                `${dropped} stored ${dropped === 1 ? 'bot was' : 'bots were'} not a definition this build can read, and ${dropped === 1 ? 'was' : 'were'} left out.`,
                'error',
            );
        }
        this.changed();
    }

    /** Load a stopped paper account for display without building a strategy or opening a
     *  market feed. Activity is intentionally session-local; executed trades remain in the
     *  restored account itself. */
    private async restoreStoppedReadout(bot: BotConfig): Promise<void> {
        const runner = new BotRunner({ bot, providers: this.opts.providers });
        try {
            await runner.loadStoredAccount();
            if (!runner.paperController) return;
            runner.log.note(
                'info',
                'Stopped account restored. Activity from the previous app session is not retained; its trades remain in the account history.',
            );
            runner.dispose();
            this.stoppedReadouts.set(bot.id, runner);
        } catch (err) {
            this.opts.notify?.(
                `The stored account for “${bot.name}” could not be shown: ${err instanceof Error ? err.message : String(err)}`,
                'error',
            );
        } finally {
            if (this.stoppedReadouts.get(bot.id) !== runner) runner.dispose();
        }
    }

    /** Whether {@link load} has happened. A screen paints an empty list either way; this is
     *  what tells "none yet" apart from "not read yet". */
    get ready(): boolean {
        return this.loaded;
    }

    private async persist(): Promise<void> {
        const snapshot = this.bots.map(toStored);
        const write = this.persistence.then(() => window.midori.bots.save(snapshot)).then(() => undefined);
        /* A rejected write reaches its caller, while later writes still get a live queue. */
        this.persistence = write.catch(() => undefined);
        await write;
    }

    /** Add one. */
    async add(bot: BotConfig): Promise<void> {
        this.bots = [...this.bots, bot];
        await this.persist();
        this.changed();
    }

    /**
     * Replace one.
     *
     * A running bot refuses the edit, in the runner's own words: the settings a bot started
     * with are the settings its open position was sized under, and swapping them mid-trade
     * would leave a stop placed by one set of rules being managed by another.
     */
    async update(bot: BotConfig): Promise<void> {
        const runner = this.runners.get(bot.id);
        if (runner) runner.update(bot); // throws while running — deliberately, see above
        this.stoppedReadouts.get(bot.id)?.update(bot);
        this.bots = this.bots.map((b) => (b.id === bot.id ? bot : b));
        await this.persist();
        this.changed();
    }

    /**
     * Remove one.
     *
     * Nothing it holds is CLOSED — see {@link BotRunner.stop}; a position keeps the stop and
     * target that went out with it. What is destroyed is the account record, and that is why
     * it is filed as a run first: weeks of trading must not vanish because somebody tidied a
     * list. A bot whose account could not be filed is not removed at all, and says so — the
     * person can try again, or delete it deliberately after looking at what it did.
     */
    async remove(id: string): Promise<void> {
        const bot = this.find(id);
        if (!bot) return;
        const active = this.runners.get(id);
        const runner = active ?? this.stoppedReadouts.get(id);

        /* Filed whether or not it is running, and from memory where it is: stopping a bot
         * and then deleting it is the ordinary way this happens, and an account only filed
         * for running bots would lose exactly the ones somebody had finished with. */
        let filed: string | null = null;
        try {
            if (active && runner) {
                runner.stop();
                /* Its account goes down before anything reads it back — see BotRunner.settle. */
                await runner.settle();
                filed = await runner.archive();
            } else if (runner) {
                filed = await runner.archive();
            } else {
                filed = await this.fileStoredAccount(bot);
            }
        } catch (err) {
            /* Thrown rather than notified: the bot is still here, still on the list, with
             * everything it did intact. Reporting this as a warning while deleting anyway
             * would be the one outcome nobody can recover from. */
            throw new Error(
                `The bot was NOT deleted — filing its account failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        if (filed) {
            this.opts.notify?.(`“${bot.name}” was filed as a run (${filed}) before it was deleted.`, 'success');
        }
        if (runner) {
            runner.dispose();
            this.runners.delete(id);
            this.stoppedReadouts.delete(id);
        }

        this.bots = this.bots.filter((b) => b.id !== id);
        await this.persist();
        /* Last, and after the list is written: an account left behind by a failure here is
         * swept on the next load, while a list that lost the bot before the account went
         * would leave one nothing could ever reach. */
        await clearBotAccount(id).catch((err: unknown) => (
            console.error(`[midorii] could not remove the account for bot ${id}`, err)
        ));
        this.changed();
    }

    /**
     * File a bot's account as a run and start it over on its opening balance.
     *
     * What "reset" has to mean for something that has been trading for weeks: the record goes
     * onto the shelf, not into the bin. Refused while the bot is running, because an account
     * cannot be filed as finished while it is still moving.
     */
    async resetAccount(id: string): Promise<string | null> {
        if (this.runners.has(id)) {
            throw new Error('Stop the bot before starting its account over.');
        }
        const bot = this.find(id);
        if (!bot) throw new Error('That bot is gone.');
        const readout = this.stoppedReadouts.get(id);
        /* Prefer the stopped in-memory account. With no readout, a runner is built purely to
         * read the stored account and file it; neither path opens a feed or sends an order. */
        const filed = readout ? await readout.archive() : await this.fileStoredAccount(bot);
        await clearBotAccount(id);
        readout?.dispose();
        this.stoppedReadouts.delete(id);
        this.changed();
        return filed;
    }

    /**
     * Load a stopped bot's account far enough to file it, without starting anything.
     *
     * The runner built here never starts: no feed, no orders, no strategy. It reads and it
     * files, and {@link BotRunner.dispose} deliberately writes nothing on the way out — a
     * write from this one would land after the caller had deleted the account and put it
     * back, which is the reset that used to do nothing at all.
     */
    private async fileStoredAccount(bot: BotConfig): Promise<string | null> {
        const runner = new BotRunner({ bot, providers: this.opts.providers });
        try {
            await runner.loadStoredAccount();
            return await runner.archive();
        } finally {
            runner.dispose();
        }
    }

    /**
     * Start a bot.
     *
     * `enabled` is written down as part of starting, so a paper bot that was running when
     * the app closed is running again when it opens. A live bot is marked the same way and
     * still is not resumed — see the file header.
     */
    async start(id: string): Promise<void> {
        if (this.shutdownTask) throw new Error('The app is closing; this bot cannot be started.');
        const stopping = this.stops.get(id);
        if (stopping) await stopping;
        const existing = this.starts.get(id);
        if (existing) return existing;

        const bot = this.find(id);
        if (!bot) throw new Error('That bot is gone.');

        /* A stopped readout is deliberately unusable as a runner. Release it before building
         * the new active lifetime; its account has already been written to disk. */
        this.stoppedReadouts.get(id)?.dispose();
        this.stoppedReadouts.delete(id);

        let runner = this.runners.get(id);
        if (!runner) {
            runner = new BotRunner({
                bot,
                providers: this.opts.providers,
                onChange: () => this.changed(),
            });
            this.runners.set(id, runner);
        }
        const current = runner;
        const start = (async () => {
            await current.start();
            /* Stop may have removed this runner while its account or history request was in
             * flight. Only the runner still owned by the engine may mark the bot enabled. */
            if (this.runners.get(id) === current && current.status === 'running') {
                await this.setEnabled(id, true);
            }
        })();
        this.starts.set(id, start);
        try {
            await start;
        } finally {
            if (this.starts.get(id) === start) this.starts.delete(id);
        }
    }

    /** Stop a bot and forget it was meant to be running. */
    async stop(id: string): Promise<void> {
        const existing = this.stops.get(id);
        if (existing) return existing;
        const stop = this.stopOne(id, true);
        this.stops.set(id, stop);
        this.changed();
        try {
            await stop;
        } finally {
            if (this.stops.get(id) === stop) this.stops.delete(id);
            this.changed();
        }
    }

    private async stopOne(id: string, disable: boolean): Promise<void> {
        const runner = this.runners.get(id);
        if (runner) {
            runner.stop();
            /* The promise may still be waiting on history, but it no longer represents the
             * runner the engine owns. A later explicit start must be free to build a fresh
             * runner instead of waiting for that cancelled request. */
            this.starts.delete(id);
            /* Waited on, so anything the person does NEXT — starting the account over,
             * deleting the bot, or letting the window close — reads an account that has
             * finished being written. */
            await runner.settle();
            runner.dispose();
            if (this.runners.get(id) === runner) {
                this.runners.delete(id);
                const previous = this.stoppedReadouts.get(id);
                if (previous && previous !== runner) previous.dispose();
                this.stoppedReadouts.set(id, runner);
            }
        }
        if (disable) await this.setEnabled(id, false);
    }

    /**
     * Stop every runner and wait for its account write before the renderer is allowed out.
     * Bot definitions stay enabled, so paper bots resume on the next app start.
     */
    shutdown(): Promise<void> {
        if (this.shutdownTask) return this.shutdownTask;
        const task = Promise.all([...this.runners.keys()].map((id) => this.stopOne(id, false)))
            .then(() => {
                this.changed();
            });
        this.shutdownTask = task;
        return task;
    }

    private async setEnabled(id: string, enabled: boolean): Promise<void> {
        const bot = this.find(id);
        if (!bot || bot.enabled === enabled) {
            this.changed();
            return;
        }
        this.bots = this.bots.map((b) => (b.id === id ? { ...b, enabled } : b));
        await this.persist();
        this.changed();
    }

    /**
     * Start the paper bots this machine was left with running.
     *
     * Failures are reported and skipped rather than thrown: one bot whose market has gone
     * away must not stop the other three from coming back, and the person needs to be told
     * which one it was.
     */
    async resume(): Promise<void> {
        for (const bot of this.bots) {
            if (!bot.enabled) continue;
            if (bot.venue === 'capital') {
                this.opts.notify?.(
                    `“${bot.name}” trades a real account and is not resumed automatically — start it when you are ready.`,
                    'info',
                );
                continue;
            }
            try {
                await this.start(bot.id);
            } catch (err) {
                this.opts.notify?.(
                    `“${bot.name}” could not be resumed: ${err instanceof Error ? err.message : String(err)}`,
                    'error',
                );
            }
        }
    }

    private changed(): void {
        for (const listener of this.listeners) listener();
    }
}
