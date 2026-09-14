import { Menu, type MenuItemDescriptor } from '../../../src/ui';
import { registerWidgetAction, type WidgetContext } from '../../../src/plugin';
import type { ThemeName, VelaTheme } from '../../../src';
import type { VelaWorkspace } from '../../../src/workspace';
import { PaperController } from './PaperController';
import { mountPaperTrading, type PaperMount } from './paperMount';
import { loadPaperSettings, needsFreshAccount, savePaperSettings, type PaperSettings } from './paperSettings';
import { openPaperSettings } from './paperSettingsDialog';
import { clearPaperAccount, loadActiveBroker, loadPaperAccount, paperWriter, saveActiveBroker } from './paperStore';
import { CapitalController } from './CapitalController';
import { mountCapitalTrading, type CapitalMount } from './capitalMount';
import { askToArm } from './capitalArmDialog';
import { BinanceSpotController } from './BinanceSpotController';
import { mountBinanceSpotTrading, type BinanceSpotMount } from './binanceSpotMount';
import { BybitController } from './BybitController';
import { mountBybitTrading, type BybitMount } from './bybitMount';
import { categoryOf, venueSymbol } from '../providers/BybitProvider';
import { ProjectXController } from './ProjectXController';
import { PROJECTX_ACCENT, mountProjectXTrading, type ProjectXMount } from './projectxMount';
import type { ProjectXDealing } from '../providers/ProjectXProvider';
import type { MidoriProjectXAccount } from '../midori';
import { formatMoney } from '../format';
import { leftArmedMarket, leftBehindNotice, loadAccountMarket, marketForAccount, saveAccountMarket } from './accountMarkets';

/**
 * The Trade menu — which broker, if any, the chart is wired to.
 *
 * A chart is a chart. Everything about trading one — the account card, the ticket,
 * the dock, the levels a position draws — is off until somebody says otherwise, and
 * the first entry in the menu says otherwise back: Just Watching returns the chart to
 * being only a chart, with the account left exactly where it was rather than closed.
 *
 * Paper trading is the first broker in the list, and a real Capital.com account is the
 * second where the credentials for one exist. They are the same shape of entry on purpose —
 * what changes underneath is only where the orders go — but they are not the same kind of
 * thing, and the menu does not pretend otherwise: the live entry says which account it is,
 * and asks before it opens — on the first start and on every start after, including the one
 * that comes back to it because it is where the app was left.
 */

/** Which broker the chart is wired to. */
export type TradeBroker = 'off' | 'paper' | 'capital' | 'binance-spot' | 'bybit' | 'projectx';

export interface TradeModeOptions {
    workspace: VelaWorkspace;
    /** The column the chart lives in — the dock mounts at the bottom of it. */
    stack: HTMLElement;
    /** The row the chart lives in — the ticket mounts beside it. */
    main: HTMLElement;
    /** The app's palette, read fresh: the ticket sits outside the chart's own root, so it
     *  is dressed by hand — and the app has more palettes than a name can carry. */
    theme: () => ThemeName | VelaTheme;
    /** Where the menu may appear. Absent ⇒ everywhere. */
    when?: (ctx: WidgetContext) => boolean;
}

export interface TradeModeHandle {
    /** Which broker is wired up right now. */
    readonly broker: TradeBroker;
    /**
     * The paper account being traded right now, or null on Just Watching.
     *
     * For a screen that READS the account — the Analysis tab. The running controller is
     * ahead of the stored record by up to a write interval, and a second screen showing the
     * older of two answers about the same account is the drift this exists to avoid.
     */
    readonly account: PaperController | null;
    /** Put the account down and take the trading UI off — what Just Watching does. */
    stop(): void;

    /**
     * What a paper account is and how it is traded, for a screen that edits it.
     *
     * The Settings tab edits the same record the gear beside the Trade menu does, and both
     * hand it back through {@link applySettings}: the decision about what a changed setting
     * COSTS — a different balance means a different account, and a different account means
     * the one on screen is filed and started again — is made once, here, rather than in
     * every form that offers the field.
     */
    readonly settings: PaperSettings;
    /** How much history the running account has, so a reset warning can be specific. */
    readonly tradeCount: number;
    /** Apply edited settings: the sizing half to the account as it stands, the account's
     *  own shape by filing it and starting a fresh one. Resolves once that has happened. */
    applySettings(next: PaperSettings): Promise<void>;
    /** File the account as a run and start a fresh one on the current settings — starting
     *  over on purpose, rather than as a side effect of a changed number. */
    resetAccount(): Promise<void>;
}

/**
 * A press on the trigger while its own menu is open arrives AFTER the outside-press
 * dismissal has already closed it, so the menu would close and immediately reopen.
 * Anything within this window of a close is that same press.
 */
const REOPEN_GUARD_MS = 200;

export function installTradeMenu(opts: TradeModeOptions): TradeModeHandle {
    const ws = opts.workspace;

    const chartOnlyMarket = (symbol: string): boolean => (
        ws.chart.data.resolve(symbol)?.provider === 'experimental'
    );

    let settings: PaperSettings = loadPaperSettings();
    let broker: TradeBroker = 'off';
    let controller: PaperController | null = null;
    let mount: PaperMount | null = null;
    let live: CapitalController | null = null;
    let liveMount: CapitalMount | null = null;
    let spot: BinanceSpotController | null = null;
    let spotMount: BinanceSpotMount | null = null;
    let bybit: BybitController | null = null;
    let bybitMount: BybitMount | null = null;
    let projectx: ProjectXController | null = null;
    let projectxMountHandle: ProjectXMount | null = null;
    /** Whether the credentials point at a real-money account, once the main process has
     *  been asked. Undefined until then — the menu entry waits rather than guessing. */
    let capital: { configured: boolean; live: boolean } | null = null;
    let binanceSpot: { configured: boolean } | null = null;
    /** The same question for Bybit, and its answer carries the same warning: `live` here
     *  means orders from this chart are real orders. Undefined until the main process has
     *  been asked. */
    let bybitVenue: { configured: boolean; live: boolean } | null = null;
    /* ProjectX is the one venue here that offers a CHOICE of accounts rather than one: a
     * key reaches an evaluation and the funded accounts that came out of it, and which one
     * is traded is a decision, not a detail. So the menu lists them individually. */
    let projectxVenue: { configured: boolean; live: boolean } | null = null;
    let projectxAccounts: MidoriProjectXAccount[] = [];
    let projectxChosen: number | null = null;
    const writer = paperWriter();
    /** Stops remembering the armed live account's market — null while none is armed. */
    let forgetMarket: (() => void) | null = null;

    /** Reading the account off disk is a round trip, and the menu can be clicked again
     *  while it is in flight. Without this the second click builds a second account over
     *  the first. */
    let starting = false;

    let menu: Menu | null = null;
    let menuOpen = false;
    let closedAt = 0;

    /** The account as it stands, on its way to storage. */
    const persist = (): void => {
        if (controller) writer.schedule(controller.snapshot());
    };

    function items(): MenuItemDescriptor[] {
        /* Every broker row carries it: the settings behind it are how trading is done on
         * whichever account is on, and reaching them only through the paper row meant
         * somebody on a funded account opened a menu called Paper trading to change the
         * risk on it. */
        const gear = { icon: 'gear' as const, label: 'Trading settings' };
        const list: MenuItemDescriptor[] = [
            { id: 'off', label: 'Just Watching', checked: broker === 'off' },
            {
                id: 'paper',
                label: 'Paper trading',
                checked: broker === 'paper',
                separatorBefore: true,
                trailing: gear,
            },
        ];
        /* Only where an account actually exists to trade. An entry that is always there and
         * always fails is a worse answer than no entry — and it would put "real money" in a
         * menu on a machine that has no credentials for any. */
        if (capital?.configured) {
            list.push({
                id: 'capital',
                label: capital.live ? 'Capital.com — live money' : 'Capital.com — demo',
                checked: broker === 'capital',
                separatorBefore: true,
                trailing: gear,
            });
            /* The venue's OTHER account, on the same key.
             *
             * One row rather than a second selectable account: the row above says which of the
             * two is on, and this one says where else it can go. Two checkable rows would read
             * as two accounts that are both ready to trade, which is the confusion this venue
             * can least afford. Nothing here reaches real money on its own — arming still goes
             * through the door that asks. */
            list.push({
                id: 'capital:swap',
                label: capital.live ? 'Switch to the demo account' : 'Switch to the live money account',
            });
        }
        if (binanceSpot?.configured) {
            list.push({
                id: 'binance-spot',
                label: 'Binance Spot — demo',
                checked: broker === 'binance-spot',
                separatorBefore: !capital?.configured,
                trailing: gear,
            });
        }
        /* One entry for both of Bybit's products, because the chart already says which of
         * them is meant: BTCUSDT is the pair, BTCUSDT.P is the contract. Two entries would
         * put a choice in the menu that the symbol has already made, and one of them would
         * be an entry that can only refuse. */
        if (bybitVenue?.configured) {
            const product = bybitProduct();
            list.push({
                id: 'bybit',
                label: [
                    'Bybit',
                    product,
                    `— ${bybitVenue.live ? 'live money' : 'demo'}`,
                ].filter(Boolean).join(' '),
                checked: broker === 'bybit',
                separatorBefore: !capital?.configured && !binanceSpot?.configured,
                trailing: gear,
            });
        }
        /* One row per account, not one per venue. Each is marked with the venue's colour so
         * three Topstep rows read as one group, and each carries its own NAME — on this
         * gateway the name is the only thing separating an evaluation from a funded account,
         * because it reports both as simulated. */
        if (projectxVenue?.configured && projectxAccounts.length) {
            const first = !capital?.configured && !binanceSpot?.configured && !bybitVenue?.configured;
            projectxAccounts.forEach((account, index) => {
                list.push({
                    id: `projectx:${account.id}`,
                    label: `${account.name} — ${formatMoney(account.balance)}`,
                    checked: broker === 'projectx' && projectxChosen === account.id,
                    accent: PROJECTX_ACCENT,
                    trailing: gear,
                    separatorBefore: index === 0 && first,
                    ...(account.canTrade === false ? { disabled: true } : {}),
                });
            });
        }
        return list;
    }

    /**
     * The market to arm an account on — the one it was left on, see accountMarkets.ts.
     *
     * With nothing remembered and another venue on screen, the symbol search opens on this
     * venue alone. Not on a resume (`ask` false): a dialog nobody asked for at startup is
     * worse than the chart staying on Just Watching.
     */
    async function marketFor(account: string, provider: string, ask: boolean): Promise<{ symbol: string; timeframe: string | null } | null> {
        const choice = marketForAccount(
            loadAccountMarket(account),
            ws.chart.market.symbol ?? '',
            provider,
            (symbol) => ws.chart.data.resolve(symbol)?.provider ?? null,
        );
        if (choice || !ask) return choice;
        const picked = await ws.pickSymbol({ providers: [provider] });
        return picked ? { symbol: picked, timeframe: null } : null;
    }

    /**
     * Put the chart on the market an account was just armed on, and keep the search to that
     * venue while it is: a symbol from anywhere else is one the account has no way to trade.
     * Called after the confirmation, so a "no" leaves the chart exactly where it was.
     *
     * `rearm` is how this account is armed again — what a move to another instrument calls.
     */
    function showAccountMarket(
        account: string,
        provider: string,
        market: { symbol: string; timeframe: string | null },
        rearm: () => Promise<void>,
    ): void {
        ws.active.setSymbol(market.symbol);
        if (market.timeframe) ws.active.setTimeframe(market.timeframe);
        ws.setSymbolScope([provider]);
        const armedOn = ws.chart.data.resolve(market.symbol);
        const remember = (): void => {
            const { symbol, timeframe } = ws.chart.market;
            if (!symbol || !timeframe || ws.chart.data.resolve(symbol)?.provider !== provider) return;
            saveAccountMarket(account, { symbol, timeframe });
        };
        remember();
        /* Compared with the instrument the account was ARMED on, not with the event's previous
         * symbol: the switch this function just asked for lands as an event of its own, after
         * the listener is already here, and must not read as the chart moving away. */
        forgetMarket = ws.chart.on('market:changed', ({ symbol }) => {
            remember();
            if (!leftArmedMarket(armedOn, ws.chart.data.resolve(symbol))) return;
            leaveAccountMarket(armedOn?.ticker ?? symbol, rearm);
        });
    }

    /**
     * The chart moved to another instrument under an armed account.
     *
     * The account is taken off at once — a ticket bound to gold under a chart of silver sends
     * orders for a market nobody is looking at, and its levels are drawn at the wrong prices.
     * It is then offered again for the instrument now on screen, through the same dialog every
     * arming goes through; a "no" leaves the chart on Just Watching. What stays open on the old
     * instrument is said out loud, because the venue still holds it.
     */
    function leaveAccountMarket(ticker: string, rearm: () => Promise<void>): void {
        const venue = live ?? projectx ?? bybit ?? spot;
        const left = venue ? { positions: venue.positions().length, orders: venue.orders().length } : { positions: 0, orders: 0 };
        stop();
        const notice = leftBehindNotice(ticker, left);
        if (notice) ws.toast(notice, 'error');
        void rearm().catch(report);
    }

    /** Wire the chart to Binance's demo Spot account. Production has no path into this mode. */
    async function startBinanceSpot(ask = true): Promise<void> {
        if (broker === 'binance-spot' || starting) return;
        starting = true;
        try {
            const market = await marketFor('binance-spot', 'binance', ask);
            const refusal = 'Binance Spot Demo needs a Binance Spot market on the chart — choose a symbol without the .P futures suffix.';
            if (!market) {
                // A dismissed symbol search is already an answer; only a resume has nobody to ask.
                if (!ask) ws.toast(refusal, 'error');
                return;
            }
            const resolved = ws.chart.data.resolve(market.symbol);
            if (resolved?.provider !== 'binance' || resolved.ticker.endsWith('.P')) {
                ws.toast(refusal, 'error');
                return;
            }
            const [info, account] = await Promise.all([
                window.midori.binanceSpot.symbolInfo(resolved.ticker),
                window.midori.binanceSpot.account(),
            ]);
            const quote = account.balances.find((row) => row.asset === info.quoteAsset);
            const quoteBalance = Number(quote?.free ?? 0) + Number(quote?.locked ?? 0);
            const go = await askToArm(ws.root, {
                live: false,
                epic: info.symbol,
                accountName: 'Binance Spot Demo',
                currency: info.quoteAsset,
                balance: quoteBalance,
            });
            if (!go) return;

            stop();
            showAccountMarket('binance-spot', 'binance', market, () => startBinanceSpot());
            spot = new BinanceSpotController({
                symbol: info.symbol,
                info,
                notify: (message, kind) => ws.toast(message, kind === 'success' ? 'success' : kind),
            });
            spotMount = mountBinanceSpotTrading({
                workspace: ws,
                stack: opts.stack,
                main: opts.main,
                controller: spot,
                settings: () => settings,
                onSettings: (next) => void applySettings(next).catch(report),
                theme: opts.theme(),
            });
            broker = 'binance-spot';
            saveActiveBroker(broker);
        } finally {
            starting = false;
        }
    }

    /** Which Bybit product the chart is currently on, or null when it is not on one. */
    function bybitProduct(): 'perpetual' | 'spot' | null {
        const resolved = ws.chart.data.resolve(ws.chart.market.symbol ?? '');
        if (resolved?.provider !== 'bybit') return null;
        return categoryOf(resolved.ticker) === 'linear' ? 'perpetual' : 'spot';
    }

    /**
     * Wire the chart to Bybit — whichever of its two products the chart is showing.
     *
     * Bound to the market on screen and refused off it, for the reason the Capital.com entry
     * gives: the account trades ONE instrument, and a chart on something else has nothing to
     * send. The product is not asked for either — `BTCUSDT` is the spot pair and `BTCUSDT.P`
     * the perpetual, so the symbol has already answered it.
     */
    async function startBybit(ask = true): Promise<void> {
        if (broker === 'bybit' || starting) return;
        starting = true;
        try {
            const env = await window.midori.bybit.environment();
            const accountKey = `bybit:${env.live ? 'live' : 'demo'}`;
            const market = await marketFor(accountKey, 'bybit', ask);
            const resolved = market ? ws.chart.data.resolve(market.symbol) : null;
            if (!market || resolved?.provider !== 'bybit') {
                // A dismissed symbol search is already an answer; only a resume has nobody to ask.
                if (!ask) ws.toast('Bybit trading needs a Bybit market on the chart — pick one from the symbol list first.', 'error');
                return;
            }
            const ticker = resolved.ticker.toUpperCase();
            // What the suffix means is the provider's to say, not a second copy of it here.
            const category = categoryOf(ticker);
            const [info, wallet] = await Promise.all([
                window.midori.bybit.instrument({ category, symbol: venueSymbol(ticker) }),
                window.midori.bybit.wallet().catch(() => null),
            ]);
            const account = wallet?.list?.[0] ?? null;
            const go = await askToArm(ws.root, {
                live: env.live,
                epic: ticker,
                accountName: `Bybit ${env.live ? '' : 'Demo '}unified account · ${category === 'linear' ? 'USDT perpetual' : 'spot'}`,
                // The unified account states one total, and Bybit denominates it in USD.
                currency: account ? 'USD' : null,
                balance: account ? Number(account.totalEquity) : null,
            });
            if (!go) return;

            stop(); // whatever was on comes off first — one account at a time
            showAccountMarket(accountKey, 'bybit', market, () => startBybit());
            bybit = new BybitController({
                ticker,
                info,
                live: env.live,
                notify: (message, kind) => ws.toast(message, kind === 'success' ? 'success' : kind),
            });
            bybitMount = mountBybitTrading({
                workspace: ws,
                stack: opts.stack,
                main: opts.main,
                controller: bybit,
                settings: () => settings,
                onSettings: (next) => void applySettings(next).catch(report),
                theme: opts.theme(),
            });
            broker = 'bybit';
            saveActiveBroker(broker);
        } finally {
            starting = false;
        }
    }

    /**
     * Wire the chart to one ProjectX account, once the person has said so in as many words.
     *
     * The account is an ARGUMENT here, unlike every other venue in this menu: a ProjectX key
     * reaches several, and picking a row is picking which one to trade. Chosen through the
     * main process rather than held here, so the choice is the same one Settings shows and
     * the same one that survives a restart.
     *
     * The arm dialog is given the account's own name rather than the venue's. On a prop firm
     * the gateway calls an evaluation and a funded account alike "simulated", so a dialog
     * saying "ProjectX — simulated" would be true of both and useful for neither.
     */
    async function startProjectX(accountId: number, ask = true): Promise<void> {
        if (starting) return;
        starting = true;
        try {
            const account = projectxAccounts.find((a) => a.id === accountId);
            if (!account) {
                ws.toast('That ProjectX account is no longer listed. Open the menu again.', 'error');
                return;
            }
            const accountKey = `projectx:${accountId}`;
            const market = await marketFor(accountKey, 'projectx', ask);
            const resolved = market ? ws.chart.data.resolve(market.symbol) : null;
            if (!market || resolved?.provider !== 'projectx') {
                // A dismissed symbol search is already an answer; only a resume has nobody to ask.
                if (!ask) ws.toast('ProjectX trading needs a futures contract on the chart — pick one from the symbol list first.', 'error');
                return;
            }
            /* The contract comes off the symbol's own metadata, which the provider fills in
             * — the ticker on the chart may be a product root (NQ) and every order has to
             * carry the dated contract it resolved to. Asked through the chart rather than
             * through a second provider instance, so it is the same answer the chart drew. */
            const info = await ws.chart.data.symbolInfo(market.symbol);
            const dealing = (info as { dealing?: ProjectXDealing } | undefined)?.dealing;
            if (!dealing?.contractId) {
                ws.toast(`ProjectX has no contract matching ${resolved.ticker}.`, 'error');
                return;
            }
            const contractName = String((info as { ticker?: string } | undefined)?.ticker ?? resolved.ticker);
            const go = await askToArm(ws.root, {
                live: projectxVenue?.live === true,
                epic: contractName,
                accountName: account.name,
                currency: 'USD',
                balance: account.balance,
            });
            if (!go) return;

            /* Only now: switching the account is a change to where every subsequent order
             * goes, so it happens after the confirmation rather than on the way to it. */
            await window.midori.projectx.selectAccount(accountId);
            projectxChosen = accountId;

            stop(); // whatever was on comes off first — one account at a time
            showAccountMarket(accountKey, 'projectx', market, () => startProjectX(accountId));
            projectx = new ProjectXController({
                ticker: contractName,
                dealing,
                accountName: account.name,
                live: projectxVenue?.live === true,
                notify: (message, kind) => ws.toast(message, kind === 'success' ? 'success' : kind),
            });
            projectxMountHandle = mountProjectXTrading({
                workspace: ws,
                stack: opts.stack,
                main: opts.main,
                controller: projectx,
                /* The same key the market and the limits are both remembered under, so one
                 * account's floor can never end up over another's chart. */
                accountKey,
                settings: () => settings,
                onSettings: (next) => void applySettings(next).catch(report),
                theme: opts.theme(),
            });
            broker = 'projectx';
            saveActiveBroker(broker);
        } finally {
            starting = false;
        }
    }

    /**
     * Wire the chart to the real venue, once the person has said so in as many words.
     *
     * Bound to the market on screen, and refused off it: the account trades ONE instrument
     * and the venue names it its own way, so a chart on Bitcoin has nothing to send.
     */
    async function startCapital(ask = true): Promise<void> {
        if (broker === 'capital' || starting) return;
        starting = true;
        try {
            const env = await window.midori.capital.environment();
            const accountKey = `capital:${env.live ? 'live' : 'demo'}`;
            const market = await marketFor(accountKey, 'capital', ask);
            const resolved = market ? ws.chart.data.resolve(market.symbol) : null;
            if (!market || resolved?.provider !== 'capital') {
                // A dismissed symbol search is already an answer; only a resume has nobody to ask.
                if (!ask) ws.toast('Live trading needs a Capital.com market on the chart — pick one from the symbol list first.', 'error');
                return;
            }
            const account = await window.midori.capital.account().catch(() => null);
            const go = await askToArm(ws.root, {
                live: env.live,
                epic: resolved.ticker,
                accountName: account?.accountName ?? null,
                currency: account?.currency ?? null,
                balance: account?.balance.balance ?? null,
            });
            if (!go) return;

            stop(); // whatever was on comes off first — one account at a time
            showAccountMarket(accountKey, 'capital', market, () => startCapital());
            live = new CapitalController({
                epic: resolved.ticker,
                notify: (message, kind) => ws.toast(message, kind === 'success' ? 'success' : kind),
                // Stamped onto every journal entry, so a demo run can never be totalled
                // together with a live one.
                live: env.live,
            });
            /* The venue's own rules for this instrument, so a size is made acceptable before
             * it is sent rather than refused after. Best effort: an order still goes out
             * without them, and the venue applies them itself. */
            void ws.chart.data.symbolInfo(market.symbol).then((info) => {
                const dealing = (info as { dealing?: unknown } | undefined)?.dealing;
                if (dealing) live?.setDealing(dealing as Parameters<CapitalController['setDealing']>[0]);
            });
            liveMount = mountCapitalTrading({
                workspace: ws,
                stack: opts.stack,
                main: opts.main,
                controller: live,
                accountKey,
                settings: () => settings,
                onSettings: (next) => void applySettings(next).catch(report),
                live: env.live,
                epic: resolved.ticker,
                theme: opts.theme(),
            });
            broker = 'capital';
            /* Remembered across restarts like every other mode — but the memory only gets
             * the chart as far as the arm dialog. What actually wires it to live money is
             * still a person answering that dialog, this start and every start after it. */
            saveActiveBroker(broker);
        } finally {
            starting = false;
        }
    }

    /**
     * Move Capital.com to its other account, and put the chart back on it.
     *
     * The same key reaches both, so this stores nothing new — see `switchCapitalEnvironment`
     * in the main process, which tries the other side before it lets go of this one.
     *
     * Two things have to happen in this order and nothing else does. The chart comes OFF
     * first: it is wired to the account being left, and a ticket left standing while the
     * ground moves under it is a ticket aimed at the other account. Then, only if it was
     * being traded, it goes back on through `startCapital` — which is the door that names
     * the account and asks before real money is reachable. Switching alone sends nothing,
     * and this deliberately does not arm a chart that was not armed to begin with.
     */
    async function swapCapital(): Promise<void> {
        const next = capital?.live ? 'demo' : 'live';
        const wasArmed = broker === 'capital';
        if (wasArmed) stop();
        const result = await window.midori.capital.setEnvironment(next);
        // The menu's own label for this venue is read from here.
        await refreshVenues();
        ws.toast(
            `Capital.com is now on ${result.env === 'live' ? 'LIVE MONEY' : 'the demo account'}.`
            + (result.persisted ? '' : ' Credentials come from .env.local, so this holds for this sitting only.'),
            'info',
        );
        if (wasArmed) await startCapital();
    }

    /** Wire the chart to the paper account — restoring the stored one where there is one. */
    async function startPaper(): Promise<void> {
        if (broker === 'paper' || starting) return;
        starting = true;
        /* Released however this leaves, which the venue starts already do with a `finally`.
         * Without one, anything that threw on the way — a mount that could not be built —
         * left the flag set, and every later press on the Trade menu returned at the guard
         * above without a word. A dead menu, and no way back to it but a restart. */
        try {
            await openPaper();
        } finally {
            starting = false;
        }
    }

    async function openPaper(): Promise<void> {
        if (chartOnlyMarket(ws.chart.market.symbol ?? '')) {
            stop();
            ws.toast('This experimental feed is chart-only. Paper trading stays off.', 'error');
            return;
        }
        let stored: Awaited<ReturnType<typeof loadPaperAccount>>;
        try {
            stored = await loadPaperAccount();
        } catch (err: unknown) {
            /* An account that cannot be read is not an account to guess at: better to say so
             * and stay on Just Watching than to open a fresh one over the top of weeks of
             * trades that may still be on disk. */
            ws.toast(`The stored paper account could not be read: ${err instanceof Error ? err.message : String(err)}`, 'error');
            return;
        }

        /* Whatever was on comes off first — one account at a time, exactly as the two venue
         * modes already do it. Without this a venue mount stayed live underneath: its
         * reconcile timer went on running, and — because the position drawing is a
         * single-instance native indicator — `addNativeIndicator` handed the paper account
         * the venue's OWN instance back. Two controllers then wrote one drawing, so the
         * figures on the chart were whichever account had pushed last. */
        stop();

        /* Undefined only before the chart has resolved a market at all — which is not a
         * moment anybody can click this menu in, but the account has to be bound to
         * SOMETHING, and the stored market is a better guess than an empty string. */
        const chartSymbol = ws.chart.market.symbol ?? stored?.symbol ?? '';
        controller = new PaperController({
            symbol: stored?.symbol ?? chartSymbol,
            settings,
            restore: stored?.session,
            onPersist: persist,
            // The account on screen; one a bot trades in the background stays quiet.
            chime: true,
        });

        /* A stored account that was left on another market moves to this one if it is
         * holding nothing. Holding something, it stays where its money is — and says so
         * once, here, rather than only when the first order is refused. */
        if (controller.symbol !== chartSymbol && !controller.follow(chartSymbol)) {
            ws.toast(controller.refusal ?? '', 'info');
        }

        mount = mountPaperTrading({
            workspace: ws,
            stack: opts.stack,
            main: opts.main,
            controller,
            settings: () => settings,
            onSettings: (next) => void applySettings(next).catch(report),
            theme: opts.theme(),
        });
        broker = 'paper';
        saveActiveBroker(broker);
        persist();
        void mount.resync();
    }

    /** Back to a chart that is only a chart. The account is put down, not closed. */
    function stop(): void {
        if (broker === 'off') return;
        forgetMarket?.();
        forgetMarket = null;
        ws.setSymbolScope(null);
        if (broker === 'capital') {
            liveMount?.unmount();
            liveMount = null;
            live = null;
            broker = 'off';
            saveActiveBroker('off');
            return;
        }
        if (broker === 'binance-spot') {
            spotMount?.unmount();
            spotMount = null;
            spot = null;
            broker = 'off';
            saveActiveBroker('off');
            return;
        }
        if (broker === 'bybit') {
            bybitMount?.unmount();
            bybitMount = null;
            bybit = null;
            broker = 'off';
            saveActiveBroker('off');
            return;
        }
        if (broker === 'projectx') {
            projectxMountHandle?.unmount();
            projectxMountHandle = null;
            projectx = null;
            broker = 'off';
            saveActiveBroker('off');
            return;
        }
        mount?.unmount();
        mount = null;
        persist();
        writer.flush(); // the write is in flight; the account itself is already complete
        controller = null;
        broker = 'off';
        saveActiveBroker(broker);
    }

    /**
     * Start the account again, keeping what it did.
     *
     * An account that has traded is weeks of work, and "reset" must not mean "delete that".
     * So a finished one is filed as a run first — the same shelf a backtest and a
     * hand-played replay land on, which is the only place three accounts traded three
     * different ways can be compared — and only then is the working record cleared.
     *
     * An account with no trades is not filed: there is nothing to compare, and the run
     * library refuses an empty one anyway.
     */
    async function freshAccount(): Promise<void> {
        const wasOn = broker === 'paper';
        const finished = controller;
        writer.cancel();

        if (finished && finished.broker.trades.length > 0) {
            try {
                const id = await archive(finished);
                ws.toast(`Paper account filed as a run (${id}) — starting a fresh one`, 'success');
            } catch (err: unknown) {
                /* Nothing is thrown away on a failed archive: the account stays exactly where
                 * it is, and the person can try again or close the position first. Thrown
                 * rather than toasted, because there is now more than one screen that can ask
                 * for this and each reports where the person is looking — the toast belongs
                 * to the chart, and the Settings tab is not on it. */
                throw new Error(
                    `The account was NOT reset — filing it failed: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }

        if (wasOn) {
            mount?.unmount();
            mount = null;
            controller = null;
            broker = 'off';
        }
        await clearPaperAccount();
        if (wasOn) await startPaper();
    }

    /** Put a finished account on the run shelf, and answer with the id it got. */
    async function archive(finished: PaperController): Promise<string> {
        const { id } = await window.midori.replay.save({
            // What traded it, so the library does not file a live paper account as a replay.
            source: 'paper',
            symbol: finished.symbol,
            timeframe: ws.chart.market.timeframe ?? '60',
            note: `Paper account, opened ${new Date(finished.openedAt).toISOString().slice(0, 10)}`,
            ...finished.result(ws.chart.market.timeframe ?? null),
        });
        return id;
    }

    /**
     * Take edited settings, whoever edited them.
     *
     * The sizing half applies to the running account as it is; the account's own shape
     * cannot — the trades already happened at the old balance and costs — so it starts
     * again, which is what every form offering those fields has to have said first.
     */
    async function applySettings(next: PaperSettings): Promise<void> {
        const resets = needsFreshAccount(settings, next);
        settings = { ...next };
        savePaperSettings(settings);
        if (resets) await freshAccount();
    }

    function openSettings(): void {
        void openPaperSettings(ws.root, {
            settings,
            trades: controller?.broker.trades.length ?? 0,
            onResetAccount: () => void freshAccount().catch(report),
        })
            .then((result) => {
                if (!result) return undefined;
                const resets = result.resetsAccount;
                return applySettings(result.settings).then(() => {
                    if (!resets) ws.toast('Paper trading settings saved', 'success');
                });
            })
            .catch(report);
    }

    /** One place for a failure that reached the top of a click. */
    function report(err: unknown): void {
        ws.toast(err instanceof Error ? err.message : String(err), 'error');
    }

    function ensureMenu(host: HTMLElement): Menu {
        menu ??= new Menu({
            host,
            items: items(),
            placement: 'bottom-end',
            checkmarks: true,
            onOpenChange: (open) => {
                menuOpen = open;
                if (!open) closedAt = Date.now();
            },
            onSelect: (id) => {
                if (id === 'off') stop();
                else if (id === 'paper') void startPaper().catch(report);
                else if (id === 'capital') void startCapital().catch(report);
                else if (id === 'capital:swap') void swapCapital().catch(report);
                else if (id === 'binance-spot') void startBinanceSpot().catch(report);
                else if (id === 'bybit') void startBybit().catch(report);
                else if (id.startsWith('projectx:')) void startProjectX(Number(id.slice('projectx:'.length))).catch(report);
            },
            /* Any row's gear opens the same settings, because they ARE the same settings:
             * how a trade is sized, what a fresh ticket is bracketed with, the quick sizes,
             * the session limits and the keys apply to whichever account is being traded.
             * Only the account's own shape is the paper one's, and that section says so. */
            onTrailing: () => openSettings(),
        });
        return menu;
    }

    registerWidgetAction({
        id: 'midorii.trade',
        target: 'topbar',
        align: 'right',
        order: 10,
        label: 'Trade',
        when: opts.when,
        run: (ctx) => {
            void refreshVenues();
            if (menuOpen || Date.now() - closedAt < REOPEN_GUARD_MS) {
                menu?.close();
                return;
            }
            const list = ensureMenu(ctx.host);
            list.setItems(items());
            /* Anchored to the button the press came from. A contributed action's button is
             * rebuilt whenever the topbar re-projects, so the menu is not bound to one —
             * it is opened at whichever button is currently on screen. */
            const rect = ctx.trigger?.getBoundingClientRect();
            if (rect) list.openAt(rect.right, rect.bottom + 4);
            else list.open();
        },
    });

    /* Read again whenever the menu opens as well as at startup. Credentials can be saved in
     * Settings after this handle was installed, and the newly connected venue should appear
     * without making somebody restart the app. */
    const refreshVenues = async (): Promise<void> => {
        const [capitalResult, spotResult, bybitResult, projectxResult] = await Promise.allSettled([
            window.midori.capital.environment(),
            window.midori.binanceSpot.environment(),
            window.midori.bybit.environment(),
            window.midori.projectx.environment(),
        ]);
        if (capitalResult.status === 'fulfilled') {
            capital = { configured: capitalResult.value.configured, live: capitalResult.value.live };
        }
        if (spotResult.status === 'fulfilled') binanceSpot = { configured: spotResult.value.configured };
        if (bybitResult.status === 'fulfilled') {
            bybitVenue = { configured: bybitResult.value.configured, live: bybitResult.value.live };
        }
        if (projectxResult.status === 'fulfilled') {
            projectxVenue = { configured: projectxResult.value.configured, live: projectxResult.value.live };
            /* The accounts come with it, because the rows ARE the accounts — a configured
             * venue with no list would show nothing and look broken. Failures leave the
             * previous list standing rather than emptying the menu mid-session. */
            if (projectxVenue.configured) {
                const [accounts, chosen] = await Promise.allSettled([
                    window.midori.projectx.accounts(true),
                    window.midori.projectx.account(),
                ]);
                if (accounts.status === 'fulfilled') projectxAccounts = accounts.value;
                if (chosen.status === 'fulfilled') projectxChosen = chosen.value.accountId;
            } else {
                projectxAccounts = [];
                projectxChosen = null;
            }
        }
        if (menuOpen) menu?.setItems(items());
    };
    const venuesRead = refreshVenues();

    /* A running paper account must not follow the chart onto a display-only feed. This
     * listener is installed before any paper mount, so stopping it also removes that
     * mount's later market-change listener before it can consume the new series. */
    const offChartOnlyMarket = ws.chart.on('market:changed', ({ symbol }) => {
        if (broker === 'off' || !chartOnlyMarket(symbol)) return;
        stop();
        ws.toast('Trading was turned off because this experimental feed is chart-only.', 'info');
    });

    /*
     * Back into the mode this machine was left in, once the chart has a market and a price
     * to hand — which is also when a paper account can be caught up over whatever happened
     * while the app was shut.
     *
     * The MODE is remembered; being wired up is not. Paper comes back on its own, and a
     * venue comes back only as far as its arm dialog — so the app can open where it was
     * left without any account ever having been armed by a memory instead of by a person.
     * A venue whose credentials have since gone, a market nothing serves any more, or a
     * dialog answered no all leave the chart on Just Watching, which is the safe end of it,
     * and none of them forget the mode: the next start offers it again.
     */
    const resume = loadActiveBroker();
    if (resume && resume !== 'off') {
        void ws.chart.ready()
            .then(async () => {
                if (resume === 'paper') return startPaper();
                /* Which venues this machine still has credentials for is a round trip, and
                 * a venue it no longer has would reach the dialog only to fail behind it. */
                await venuesRead;
                if (resume === 'capital' && capital?.configured) return startCapital(false);
                if (resume === 'binance-spot' && binanceSpot?.configured) return startBinanceSpot(false);
                if (resume === 'bybit' && bybitVenue?.configured) return startBybit(false);
                /* ProjectX resumes only onto the account that is still chosen — the mode
                 * alone does not say which one, and there is no safe way to pick. An
                 * evaluation that ended, or a key replaced since, leaves the chart on Just
                 * Watching rather than arming whichever account happens to be first. */
                if (resume === 'projectx' && projectxVenue?.configured && projectxChosen != null
                    && projectxAccounts.some((a) => a.id === projectxChosen)) {
                    return startProjectX(projectxChosen, false);
                }
                return undefined;
            })
            .catch((err: unknown) => console.error('[midorii] could not resume trading', err));
    }

    /* The account is written on a delay so a burst of ticks is one write; a window
     * closing mid-burst would otherwise lose the last of it. */
    window.addEventListener('beforeunload', () => {
        persist();
        writer.flush();
    });
    void offChartOnlyMarket;

    return {
        get broker(): TradeBroker {
            return broker;
        },
        get account(): PaperController | null {
            return controller;
        },
        get settings(): PaperSettings {
            return settings;
        },
        get tradeCount(): number {
            return controller?.broker.trades.length ?? 0;
        },
        stop,
        applySettings,
        resetAccount: freshAccount,
    };
}
