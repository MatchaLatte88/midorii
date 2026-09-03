// Walking skeleton: a bare Vela core (no workspace chrome yet) fed by a
// DataProvider that reads Midori's existing local bar store instead of the
// network. Proves the data path before indicators, broker, or the rest of
// the UI get ported — see the Midorii migration plan.
import { Vela } from '../../src';
import { LocalArchiveProvider } from './providers/LocalArchiveProvider';

const chart = new Vela('#chart', {
    symbol: 'local:BTCUSDT', // pinned to this provider explicitly, no bare-symbol resolution race
    timeframe: '1h',
    theme: 'dark',
});
chart.data.registerProvider('local', new LocalArchiveProvider());

void chart.ready().then(() => console.log('[midorii] chart ready'));

// For the acceptance probe (devtools console): chart.setMarket({ timeframe: '4h' }).
// Note: only Midori's own alias forms ('1m'/'5m'/'15m'/'30m'/'1h'/'4h'/'1d') work
// today — a bare-number Vela timeframe like '240' throws at the IPC boundary
// (barStore.js's TIMEFRAMES has no '240' key). Known gap, deliberately deferred
// — see the migration plan's "Timeframe-Vokabular-Lücke" risk note.
(window as unknown as { __chart: Vela }).__chart = chart;
