import { Dialog, Select, TextField } from '../../../src/ui';

/**
 * Download market data into the local archive.
 *
 * Everything lands as 1-minute bars in one file per symbol — the store folds
 * every higher timeframe out of those — so the only questions are which venue,
 * which market, and how far back. The venues spell a market differently enough
 * that a wrong spelling is the usual failure, so each one says how it names
 * things right under the field.
 *
 * The download itself runs in the main process and reports every archive month
 * or candle page as it lands; this dialog just shows that and stays open until
 * it is done, so closing the window mid-download is a deliberate act.
 */

const ROW_CSS = 'display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:10px;font-size:var(--vela-font-size-md);color:var(--vela-fg)';

function row(label: string, control: HTMLElement): HTMLElement {
    const el = document.createElement('label');
    el.style.cssText = ROW_CSS;
    const text = document.createElement('span');
    text.style.whiteSpace = 'nowrap';
    text.textContent = label;
    el.append(text, control);
    return el;
}

function button(text: string, primary = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = `all:unset;padding:6px 16px;border-radius:var(--vela-radius-sm);cursor:pointer;font-weight:600;${
        primary
            ? 'background:var(--vela-accent);color:#0b0e14'
            : 'background:var(--vela-surface-overlay);color:var(--vela-fg);border:1px solid var(--vela-border-soft)'
    }`;
    return b;
}

function dateInput(value: string): HTMLInputElement {
    const el = document.createElement('input');
    el.type = 'date';
    el.value = value;
    el.style.cssText = 'background:var(--vela-surface-overlay);color:var(--vela-fg);border:1px solid var(--vela-border-soft);border-radius:var(--vela-radius-sm);padding:5px 8px;font:inherit;outline:none';
    return el;
}

/** `YYYY-MM-DD` in UTC — the date input's own format, and the store's clock. */
function isoDate(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Opens the dialog. Resolves when it closes — with the symbol that was
 * downloaded (so the caller can go and look at it), or null if nothing was.
 */
export async function openDownloadDialog(host: HTMLElement): Promise<string | null> {
    const sources = await window.midori.data.sources();
    if (sources.length === 0) throw new Error('No download sources are registered.');

    return new Promise<string | null>((resolve) => {
        let settled = false;
        let downloaded: string | null = null;
        let running = false;
        let offProgress: (() => void) | null = null;

        const finish = (): void => {
            if (settled) return;
            settled = true;
            offProgress?.();
            dialog.hide();
            resolve(downloaded);
        };

        let source = sources[0]!;
        const YEAR_MS = 365 * 86_400_000;

        const symbolField = new TextField({ value: source.example, fill: false });
        const symbols = document.createElement('datalist');
        symbols.id = 'midorii-download-symbols';
        symbolField.input.setAttribute('list', symbols.id);
        symbolField.input.placeholder = source.example;

        const naming = document.createElement('div');
        naming.style.cssText = 'margin:-4px 0 12px;font-size:var(--vela-font-size-sm);color:var(--vela-fg-muted);line-height:1.45';
        naming.textContent = source.naming;

        const status = document.createElement('div');
        status.style.cssText = 'min-height:2.6em;margin-top:8px;font-size:var(--vela-font-size-md);color:var(--vela-fg-muted);line-height:1.45';

        const say = (text: string, tone: 'muted' | 'error' | 'ok' = 'muted'): void => {
            status.textContent = text;
            status.style.color = tone === 'error' ? 'var(--vela-danger)'
                : tone === 'ok' ? 'var(--vela-fg-bright)'
                    : 'var(--vela-fg-muted)';
        };

        /* The symbol lists are a network call each and only one of them is ever
         * on screen, so they are fetched per source and remembered. A venue that
         * will not answer is not fatal — the field is a free-text box with a
         * suggestion list, not a picker. */
        const symbolCache = new Map<string, string[]>();
        const loadSymbols = (id: string): void => {
            const cached = symbolCache.get(id);
            if (cached) {
                symbols.replaceChildren(...cached.map((s) => new Option(s)));
                return;
            }
            symbols.replaceChildren();
            void window.midori.data.symbols(id)
                .then((list) => {
                    const names = list.map((s) => s.symbol);
                    symbolCache.set(id, names);
                    if (source.id === id) symbols.replaceChildren(...names.map((s) => new Option(s)));
                })
                .catch(() => { /* suggestions only — typing the symbol still works */ });
        };

        const sourceSelect = new Select({
            options: sources.map((s) => ({ value: s.id, label: s.label })),
            value: source.id,
            onChange: (id) => {
                source = sources.find((s) => s.id === id) ?? source;
                naming.textContent = source.naming;
                symbolField.input.placeholder = source.example;
                loadSymbols(source.id);
            },
        });

        const now = Date.now();
        const fromInput = dateInput(isoDate(now - YEAR_MS));
        const toInput = dateInput(isoDate(now));

        const start = button('Download', true);
        const close = button('Close');
        close.onclick = () => {
            // A download keeps running in the main process either way; closing
            // here would only hide the one thing that reports on it.
            if (running) say('The download is still running — it will say when it is done.');
            else finish();
        };

        start.onclick = () => {
            if (running) return;
            const symbol = symbolField.input.value.trim();
            if (!symbol) {
                say(`Type a market to download, e.g. ${source.example}.`, 'error');
                return;
            }
            const from = Date.parse(`${fromInput.value}T00:00:00Z`);
            const to = Date.parse(`${toInput.value}T00:00:00Z`);
            if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
                say('Pick a start date before the end date.', 'error');
                return;
            }

            running = true;
            start.disabled = true;
            start.style.opacity = '0.6';
            say(`Starting ${symbol} from ${source.label}…`);

            offProgress?.();
            offProgress = window.midori.data.onDownloadProgress((p) => {
                if (p.symbol !== symbol.toUpperCase()) return;
                say(`${p.label} — ${p.done} of ${p.total}`);
            });

            void window.midori.data
                .download({ symbol, source: source.id, from, to })
                .then((result) => {
                    downloaded = symbol.toUpperCase();
                    const range = result.first != null && result.last != null
                        ? ` covering ${isoDate(result.first)} to ${isoDate(result.last)}`
                        : '';
                    const gaps = result.missing.length > 0
                        ? ` ${source.label} had nothing for ${result.missing.join(', ')}.`
                        : '';
                    say(`${downloaded}: ${result.added.toLocaleString()} new bars, `
                        + `${result.total.toLocaleString()} in total${range}.${gaps}`, 'ok');
                })
                .catch((err: unknown) => {
                    say(err instanceof Error ? err.message : String(err), 'error');
                })
                .finally(() => {
                    running = false;
                    start.disabled = false;
                    start.style.opacity = '';
                    offProgress?.();
                    offProgress = null;
                });
        };

        const dialog = new Dialog({
            title: 'Download market data',
            host,
            draggable: true,
            align: 'center',
            closeOnInteractOutside: false,
            onOpenChange: (open) => { if (!open) finish(); },
            content: (body) => {
                body.append(
                    row('Source', sourceSelect.el),
                    row('Market', symbolField.el),
                    naming,
                    row('From (UTC)', fromInput),
                    row('To (UTC)', toInput),
                    symbols,
                    status,
                );
                loadSymbols(source.id);
            },
            footer: (el) => {
                el.style.cssText += ';display:flex;justify-content:flex-end;gap:8px';
                el.append(close, start);
            },
        });
        dialog.show();
    });
}
