// The app shell: Vela's workspace, wired to Midorii's own data layer.
//
// Two kinds of market sit side by side in one symbol picker. `local:` reads the
// bar store on this machine over IPC — the archive a replay or a backtest runs
// on — while the venue providers stream live from the exchange. Same chart,
// same tools; what differs is only where the bars come from.
import { BinanceProvider } from '../../src/data/providers/binance';
import { CoinbaseProvider } from '../../src/data/providers/coinbase';
import { HyperliquidProvider } from '../../src/data/providers/hyperliquid';
import { registerIcon, registerWidgetAction } from '../../src/plugin';
import { VelaWorkspace } from '../../src/workspace';
import { BRAND } from './about/brand';
import { openDownloadDialog } from './data/downloadDialog';
import { LocalArchiveProvider } from './providers/LocalArchiveProvider';
import { isReplayChart } from './replay/replayActions';
import { resumeReplay, startReplay } from './replay/replayBootstrap';
import { askReplaySetup } from './replay/replaySetup';

/** Every market source the app can chart: the local archive, then the venues. */
function providers() {
    return {
        local: () => new LocalArchiveProvider(),
        binance: () => new BinanceProvider(),
        coinbase: () => new CoinbaseProvider(),
        hyperliquid: () => new HyperliquidProvider(),
    };
}

const chartRoot = document.getElementById('chart')!;
const replayRoot = document.getElementById('replay-root')!;

const workspace = new VelaWorkspace(chartRoot, {
    layout: false,
    theme: 'dark',
    // A venue symbol rather than a local one so a fresh install charts something
    // on first run; the picker lists whatever has been downloaded beside it.
    symbol: 'binance:BTCUSDT',
    timeframe: '60',
    brand: BRAND,
    providers: providers(),
    persist: 'midorii-workspace',
});

(window as unknown as { __workspace: VelaWorkspace }).__workspace = workspace;

// ── topbar actions ───────────────────────────────────────────────────────
//
// Contributions rather than chrome of our own: they land in Vela's topbar next
// to the replay transport, and everything they act on comes from the context
// they are handed. Both are gated off the replay chart — a session has its own
// controls there, and neither downloading nor starting a second replay belongs
// in the middle of one.

registerIcon('midorii-download', '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8"/><path d="M4.5 7 8 10.5 11.5 7"/><path d="M2.5 13.5h11"/></svg>');
registerIcon('midorii-replay', '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.9-4.2"/><path d="M13.5 2v3h-3"/></svg>');

registerWidgetAction({
    id: 'midorii.download',
    target: 'topbar',
    align: 'right',
    order: 20,
    iconOnly: true,
    label: 'Download market data',
    icon: 'midorii-download',
    when: (ctx) => !isReplayChart(ctx.chart),
    run: (ctx) => {
        void openDownloadDialog(document.body)
            .then((symbol) => {
                if (symbol) ctx.toast(`${symbol} is in the local archive`, 'success');
            })
            .catch((err: unknown) => ctx.toast(err instanceof Error ? err.message : String(err), 'error'));
    },
});

registerWidgetAction({
    id: 'midorii.replay',
    target: 'topbar',
    align: 'right',
    order: 21,
    iconOnly: true,
    label: 'Replay',
    icon: 'midorii-replay',
    when: (ctx) => !isReplayChart(ctx.chart),
    run: (ctx) => void openReplay().catch((err: unknown) => (
        ctx.toast(err instanceof Error ? err.message : String(err), 'error')
    )),
});

// ── replay ───────────────────────────────────────────────────────────────
//
// A separate, dedicated VelaWorkspace mounted on demand into #replay-root: it
// runs against a provider that reveals bars one at a time, so it cannot share
// the live workspace's feed. The live chart is hidden rather than torn down —
// leaving the session is meant to be instant.

let mounted = false;

async function openReplay(): Promise<void> {
    if (mounted) return;

    const choice = await askReplaySetup(document.body);
    if (!choice) return; // dismissed — stay on the live chart

    chartRoot.hidden = true;
    replayRoot.hidden = false;
    mounted = true;

    try {
        const replay = choice.kind === 'new'
            ? await startReplay(replayRoot, choice.setup)
            : await resumeReplay(replayRoot, choice.sessionId);
        (window as unknown as { __replay: typeof replay }).__replay = replay;
    } catch (err) {
        // Nothing mounted, so put the live chart back rather than leaving an
        // empty panel with no way out of it.
        replayRoot.hidden = true;
        chartRoot.hidden = false;
        mounted = false;
        throw err;
    }
}
