import { DARK_THEME } from '../../../src';
import { Dialog, NumberInput, Select, ensureUIHost } from '../../../src/ui';
import type { ReplaySetup } from './replayBootstrap';

export type SetupChoice =
    | { kind: 'new'; setup: ReplaySetup }
    | { kind: 'resume'; sessionId: string };

function row(label: string, control: HTMLElement): HTMLElement {
    const el = document.createElement('label');
    el.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px;font-size:var(--vela-font-size-md);color:var(--vela-fg)';
    const text = document.createElement('span');
    text.style.whiteSpace = 'nowrap';
    text.textContent = label;
    el.append(text, control);
    return el;
}

function button(text: string, primary = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = primary ? 'vela-dialog-btn vela-dialog-btn-primary' : 'vela-dialog-btn';
    b.textContent = text;
    return b;
}

/** `YYYY-MM-DD` in UTC — the date input's own format, and the clock is UTC. */
function isoDate(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Asks what to replay: a downloaded symbol, where to start, and the starting
 * balance — or picks up a session that was put down earlier.
 *
 * It deliberately does not ask for a timeframe. A timeframe is not a property of
 * a session, it is how you are looking at one, and the chart's own picker
 * changes it at any point without disturbing the account — so asking here would
 * only be a decision to regret ten minutes in.
 *
 * Built from Vela's own kit so it matches the chart's chrome without a second
 * design language. Resolves once the user commits; never rejects — a dismissed
 * dialog resolves `null`.
 */
export async function askReplaySetup(host: HTMLElement): Promise<SetupChoice | null> {
    // The dialog is mounted before any chart exists, so nothing else has tokened
    // this host yet — without it the kit renders outside the theme variables.
    ensureUIHost(host, DARK_THEME);

    const [datasets, sessions, recorder] = await Promise.all([
        window.midori.data.datasets(),
        window.midori.replay.sessions(),
        /* Best effort: a replay on candles needs nothing from the recorder, and one that cannot
         * be asked must not stop a session being started. */
        window.midori.recorder.status().catch((err: unknown) => {
            console.error('[midorii] could not read what has been recorded', err);
            return { enabled: false, recordings: [] };
        }),
    ]);
    const recordings = recorder.recordings;
    if (datasets.length === 0) {
        throw new Error('No market data downloaded yet — there is nothing to replay.');
    }

    return new Promise<SetupChoice | null>((resolve) => {
        let settled = false;
        const finish = (choice: SetupChoice | null): void => {
            if (settled) return;
            settled = true;
            dialog.hide();
            resolve(choice);
        };

        let symbol = datasets[0]!.symbol;
        let balance = 10_000;
        /* Where a fresh session starts. A few hundred bars past the dataset's start, so it opens
         * with history behind it rather than at the very first bar — except on a dataset shorter
         * than that, which a recording of a day or two always is: that one starts a quarter of an
         * hour in, since five hundred hours past its start is past its end. */
        const startFor = (d: { first?: number | null; last?: number | null }): { date: string; time: string } => {
            const first = d.first ?? Date.now();
            const lead = 500 * 3_600_000;
            if (d.last != null && d.last - first < lead) {
                const at = new Date(first + 15 * 60_000).toISOString();
                return { date: at.slice(0, 10), time: at.slice(11, 16) };
            }
            return { date: isoDate(first + lead), time: '00:00' };
        };
        const initial = startFor(datasets[0]!);
        let startDate = initial.date;

        const symbolSelect = new Select({
            options: datasets.map((d) => ({ value: d.symbol, label: d.symbol })),
            value: symbol,
            onChange: (v) => {
                symbol = v;
                // A recording's own candles come with its ticks, unless somebody has already chosen.
                const own = recordedFor(v);
                if (own && ticks === null) {
                    ticks = own;
                    ticksSelect.setValue(own);
                }
                const d = datasets.find((x) => x.symbol === v);
                if (d?.first != null) {
                    const start = startFor(d);
                    startDate = start.date;
                    timeInput.value = start.time;
                    dateInput.value = startDate;
                    dateInput.min = isoDate(d.first);
                    if (d.last != null) dateInput.max = isoDate(d.last);
                }
            },
        });

        /* Which recording to play on ticks. Candles and ticks are chosen apart, and that is the
         * switch between the two ways of getting candles: pick the dataset a recording wrote
         * (NQU6.REC) and the candles are made from the same prints the tape plays; pick an
         * archive dataset and the recorded ticks are played inside ITS candles. */
        const recordedFor = (dataset: string): string | null => {
            if (!dataset.endsWith('.REC')) return null;
            const name = dataset.slice(0, -'.REC'.length);
            return recordings.some((r) => r.name === name) ? name : null;
        };
        let ticks: string | null = recordedFor(symbol);
        const ticksSelect = new Select({
            options: [
                { value: '', label: 'None — candles only' },
                ...recordings.map((r) => ({
                    value: r.name,
                    label: `${r.name} — ${r.days.length} recorded ${r.days.length === 1 ? 'day' : 'days'}`,
                })),
            ],
            value: ticks ?? '',
            onChange: (v) => { ticks = v || null; },
        });

        const timeInput = document.createElement('input');
        timeInput.type = 'time';
        timeInput.value = initial.time;

        const dateInput = document.createElement('input');
        dateInput.type = 'date';
        dateInput.value = startDate;
        if (datasets[0]!.first != null) dateInput.min = isoDate(datasets[0]!.first);
        if (datasets[0]!.last != null) dateInput.max = isoDate(datasets[0]!.last);
        dateInput.style.cssText = 'background:var(--vela-surface-overlay);color:var(--vela-fg);border:1px solid var(--vela-border-soft);border-radius:var(--vela-control-radius);padding:0 10px;height:var(--vela-control-h);font:inherit;outline:none';
        dateInput.addEventListener('change', () => { startDate = dateInput.value; });
        timeInput.style.cssText = dateInput.style.cssText;

        const balanceInput = new NumberInput({
            value: balance,
            min: 1,
            step: 1000,
            onChange: (v) => { balance = v; },
        });

        const error = document.createElement('div');
        error.style.cssText = 'min-height:1.2em;margin-top:4px;color:var(--vela-danger);font-size:var(--vela-font-size-md)';

        const start = button('Start replay', true);
        start.onclick = () => {
            const startTime = Date.parse(`${startDate}T${timeInput.value || '00:00'}:00Z`);
            if (!Number.isFinite(startTime)) {
                error.textContent = 'Pick a start date.';
                return;
            }
            const chosen = datasets.find((x) => x.symbol === symbol);
            if (chosen?.first != null && startTime <= chosen.first) {
                error.textContent = `${symbol} begins at ${new Date(chosen.first).toISOString().slice(0, 16).replace('T', ' ')} UTC — start after that.`;
                return;
            }
            finish({ kind: 'new', setup: { symbol, startTime, balance, ticks } });
        };

        const dialog = new Dialog({
            title: 'New session',
            eyebrow: 'Replay',
            host,
            draggable: true,
            align: 'center',
            closeOnInteractOutside: false,
            onOpenChange: (open) => { if (!open) finish(null); },
            content: (body) => {
                body.append(
                    row('Symbol', symbolSelect.el),
                    row('Start date (UTC)', dateInput),
                    row('Start time (UTC)', timeInput),
                    row('Play recorded ticks', ticksSelect.el),
                    row('Starting balance', balanceInput.el),
                    error,
                );

                // Parked sessions, if any — the other half of "pause for later".
                if (sessions.length > 0) {
                    const heading = document.createElement('div');
                    heading.textContent = 'Or pick up where you left off';
                    heading.style.cssText = 'margin:18px 0 8px;font-size:var(--vela-font-size-md);color:var(--vela-fg-muted)';
                    body.append(heading);

                    for (const s of sessions) {
                        const item = document.createElement('div');
                        item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0;border-top:1px solid var(--vela-border-soft)';
                        const label = document.createElement('span');
                        label.style.cssText = 'font-size:var(--vela-font-size-md);color:var(--vela-fg)';
                        label.textContent = `${s.name || 'Untitled'} — ${s.symbol} ${s.timeframe}, ${isoDate(s.clock)}`;
                        const resume = button('Resume');
                        resume.onclick = () => finish({ kind: 'resume', sessionId: s.id });
                        item.append(label, resume);
                        body.append(item);
                    }
                }
            },
            footer: (el) => {
                const cancel = button('Cancel');
                cancel.onclick = () => finish(null);
                el.append(cancel, start);
            },
        });
        dialog.show();
    });
}
