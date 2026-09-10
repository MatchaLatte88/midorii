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

    const [datasets, sessions] = await Promise.all([
        window.midori.data.datasets(),
        window.midori.replay.sessions(),
    ]);
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
        // Default a few hundred bars past the dataset's start, so a fresh session
        // opens with history behind it rather than at the very first bar.
        let startDate = isoDate((datasets[0]!.first ?? Date.now()) + 500 * 3_600_000);

        const symbolSelect = new Select({
            options: datasets.map((d) => ({ value: d.symbol, label: d.symbol })),
            value: symbol,
            onChange: (v) => {
                symbol = v;
                const d = datasets.find((x) => x.symbol === v);
                if (d?.first != null) {
                    startDate = isoDate(d.first + 500 * 3_600_000);
                    dateInput.value = startDate;
                    dateInput.min = isoDate(d.first);
                    if (d.last != null) dateInput.max = isoDate(d.last);
                }
            },
        });

        const dateInput = document.createElement('input');
        dateInput.type = 'date';
        dateInput.value = startDate;
        if (datasets[0]!.first != null) dateInput.min = isoDate(datasets[0]!.first);
        if (datasets[0]!.last != null) dateInput.max = isoDate(datasets[0]!.last);
        dateInput.style.cssText = 'background:var(--vela-surface-overlay);color:var(--vela-fg);border:1px solid var(--vela-border-soft);border-radius:var(--vela-control-radius);padding:0 10px;height:var(--vela-control-h);font:inherit;outline:none';
        dateInput.addEventListener('change', () => { startDate = dateInput.value; });

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
            const startTime = Date.parse(`${startDate}T00:00:00Z`);
            if (!Number.isFinite(startTime)) {
                error.textContent = 'Pick a start date.';
                return;
            }
            finish({ kind: 'new', setup: { symbol, startTime, balance } });
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
