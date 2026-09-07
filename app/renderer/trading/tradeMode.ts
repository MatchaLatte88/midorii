import { Menu, type MenuItemDescriptor } from '../../../src/ui';
import { registerWidgetAction, type WidgetContext } from '../../../src/plugin';
import type { ThemeName, VelaTheme } from '../../../src';
import type { VelaWorkspace } from '../../../src/workspace';
import { PaperController } from './PaperController';
import { mountPaperTrading, type PaperMount } from './paperMount';
import { loadPaperSettings, needsFreshAccount, savePaperSettings, type PaperSettings } from './paperSettings';
import { openPaperSettings } from './paperSettingsDialog';
import { clearPaperAccount, loadActiveBroker, loadPaperAccount, paperWriter, saveActiveBroker } from './paperStore';

/**
 * The Trade menu — which broker, if any, the chart is wired to.
 *
 * A chart is a chart. Everything about trading one — the account card, the ticket,
 * the dock, the levels a position draws — is off until somebody says otherwise, and
 * the first entry in the menu says otherwise back: Just Watching returns the chart to
 * being only a chart, with the account left exactly where it was rather than closed.
 *
 * Paper trading is the first broker in the list and, for now, the only one. The list
 * is a list because the next ones are live venues: the entry is the same shape, the
 * gear beside it configures the same kinds of thing, and what changes underneath is
 * only which engine the orders go to.
 */

/** Which broker the chart is wired to. More will join `paper` here. */
export type TradeBroker = 'off' | 'paper';

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

    let settings: PaperSettings = loadPaperSettings();
    let broker: TradeBroker = 'off';
    let controller: PaperController | null = null;
    let mount: PaperMount | null = null;
    const writer = paperWriter();

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
        return [
            { id: 'off', label: 'Just Watching', checked: broker === 'off' },
            {
                id: 'paper',
                label: 'Paper trading',
                checked: broker === 'paper',
                separatorBefore: true,
                trailing: { icon: 'gear', label: 'Paper trading settings' },
            },
        ];
    }

    /** Wire the chart to the paper account — restoring the stored one where there is one. */
    async function startPaper(): Promise<void> {
        if (broker === 'paper' || starting) return;
        starting = true;

        let stored: Awaited<ReturnType<typeof loadPaperAccount>>;
        try {
            stored = await loadPaperAccount();
        } catch (err: unknown) {
            starting = false;
            /* An account that cannot be read is not an account to guess at: better to say so
             * and stay on Just Watching than to open a fresh one over the top of weeks of
             * trades that may still be on disk. */
            ws.toast(`The stored paper account could not be read: ${err instanceof Error ? err.message : String(err)}`, 'error');
            return;
        }

        /* Undefined only before the chart has resolved a market at all — which is not a
         * moment anybody can click this menu in, but the account has to be bound to
         * SOMETHING, and the stored market is a better guess than an empty string. */
        const chartSymbol = ws.chart.market.symbol ?? stored?.symbol ?? '';
        controller = new PaperController({
            symbol: stored?.symbol ?? chartSymbol,
            settings,
            restore: stored?.session,
            onPersist: persist,
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
            theme: opts.theme(),
        });
        broker = 'paper';
        starting = false;
        saveActiveBroker(broker);
        persist();
        void mount.resync();
    }

    /** Back to a chart that is only a chart. The account is put down, not closed. */
    function stop(): void {
        if (broker === 'off') return;
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
            },
            onTrailing: (id) => {
                if (id === 'paper') openSettings();
            },
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

    /* Back into the mode this machine was left in, once the chart has a market and a
     * price to hand — which is also when the account can be caught up over whatever
     * happened while the app was shut. Anything the restore refuses (a market nothing
     * serves any more) leaves the chart on Just Watching, which is the safe end of it. */
    if (loadActiveBroker() === 'paper') {
        void ws.chart.ready()
            .then(() => startPaper())
            .catch((err: unknown) => console.error('[midorii] could not resume paper trading', err));

    }

    /* The account is written on a delay so a burst of ticks is one write; a window
     * closing mid-burst would otherwise lose the last of it. */
    window.addEventListener('beforeunload', () => {
        persist();
        writer.flush();
    });

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
