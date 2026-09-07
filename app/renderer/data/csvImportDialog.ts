import { Dialog, Select, Switch, TextField, injectStyles } from '../../../src/ui';
import type { MidoriCsvDateStyle, MidoriCsvInspection, MidoriCsvMapping } from '../midori';

/**
 * Importing market data from a file.
 *
 * A download knows what it is fetching. A file does not: it arrives with some character
 * separating its columns, some order of day and month, and a clock nobody wrote down. So
 * this dialog is built around one idea — show what the file will BECOME, before it becomes
 * it.
 *
 * That is what the preview is. Reading `12/26/2022 18:01` tells you nothing about whether
 * the import has understood it; reading `2022-12-26 23:01 UTC` underneath tells you
 * everything, because a wrong date style or a wrong time zone is visible there and nowhere
 * else. The preview comes from the same parser the import runs, so it cannot flatter it.
 *
 * Every guess is a control
 * -----------------------
 * The delimiter, the header row, which column is the close, the date order and the clock
 * are all sniffed and all overridable. Sniffing is right most of the time and silently
 * wrong the rest of it, and a dataset that imported cleanly under the wrong reading is the
 * expensive kind of wrong: it looks completely normal on the chart.
 */

const STYLE_ID = 'midorii-csv-import';
const CSS = `
.midorii-csv { width: min(760px, 88vw); font-size: 12.5px; color: var(--vela-fg); }
.midorii-csv-file {
    display: flex; align-items: baseline; gap: 8px;
    margin-bottom: 12px; color: var(--vela-fg-muted);
}
.midorii-csv-file b { color: var(--vela-fg-bright); font-weight: 600; }

.midorii-csv-grid {
    display: grid; gap: 8px 18px;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    margin-bottom: 14px;
}
.midorii-csv-row {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    min-height: 26px;
}
.midorii-csv-row > span:first-child { color: var(--vela-fg-muted); white-space: nowrap; }

.midorii-csv-label {
    margin: 14px 0 6px;
    font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase;
    color: var(--vela-fg-muted);
}
.midorii-csv-hint { margin: -4px 0 10px; color: var(--vela-fg-muted); line-height: 1.45; }

.midorii-csv-scroll { max-height: 190px; overflow: auto; border: 1px solid var(--vela-border-faint); border-radius: var(--vela-radius-sm); }
.midorii-csv-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.midorii-csv-table th, .midorii-csv-table td {
    padding: 3px 8px; text-align: right; white-space: nowrap;
    border-bottom: 1px solid var(--vela-border-faint);
}
.midorii-csv-table th {
    position: sticky; top: 0; z-index: 1;
    background: var(--vela-surface); color: var(--vela-fg-muted);
    font-weight: 600; text-align: right;
}
.midorii-csv-table th:first-child, .midorii-csv-table td:first-child { text-align: left; }
.midorii-csv-table td { color: var(--vela-fg); }
.midorii-csv-table tr:last-child td { border-bottom: none; }
.midorii-csv-table [data-mapped='1'] { color: var(--vela-fg-bright); }
.midorii-csv-table [data-mapped='0'] { color: var(--vela-fg-muted); opacity: 0.65; }

.midorii-csv-status { min-height: 2.6em; margin-top: 10px; line-height: 1.45; color: var(--vela-fg-muted); }
.midorii-csv-status[data-tone='error'] { color: var(--vela-danger); }
.midorii-csv-status[data-tone='ok'] { color: var(--vela-fg-bright); }
`;

/** The fields the mapping controls, and what to call each. `time` doubles as the split
 *  date/clock pair, which is why it is not simply one of the price rows. */
const FIELDS: ReadonlyArray<{ key: keyof MidoriCsvMapping; label: string; required: boolean }> = [
    { key: 'time', label: 'Timestamp', required: true },
    { key: 'date', label: 'Date', required: false },
    { key: 'clock', label: 'Time of day', required: false },
    { key: 'open', label: 'Open', required: true },
    { key: 'high', label: 'High', required: true },
    { key: 'low', label: 'Low', required: true },
    { key: 'close', label: 'Close', required: true },
    { key: 'volume', label: 'Volume', required: false },
    { key: 'buyVolume', label: 'Buy volume', required: false },
];

const DELIMITERS: ReadonlyArray<{ value: string; label: string }> = [
    { value: ',', label: 'Comma  ,' },
    { value: ';', label: 'Semicolon  ;' },
    { value: '\t', label: 'Tab' },
    { value: '|', label: 'Pipe  |' },
];

const DATE_STYLES: ReadonlyArray<{ value: MidoriCsvDateStyle; label: string }> = [
    { value: 'mdy', label: 'Month / Day / Year' },
    { value: 'dmy', label: 'Day / Month / Year' },
    { value: 'ymd', label: 'Year / Month / Day' },
];

function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
    const el = document.createElement('label');
    el.className = 'midorii-csv-row';
    const text = document.createElement('span');
    text.textContent = label;
    if (hint) text.title = hint;
    el.append(text, control);
    return el;
}

function label(text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'midorii-csv-label';
    el.textContent = text;
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

/** `2022-12-26 23:01` in UTC — the clock everything downstream is in, spelled out so a
 *  misread time zone is visible rather than plausible. */
function stamp(ms: number): string {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

function bytes(size: number): string {
    if (size >= 1e9) return `${(size / 1e9).toFixed(1)} GB`;
    if (size >= 1e6) return `${(size / 1e6).toFixed(1)} MB`;
    if (size >= 1e3) return `${Math.round(size / 1e3)} kB`;
    return `${size} bytes`;
}

/**
 * A dataset name out of a file name: what someone would have typed anyway.
 *
 * A trailing part number goes, because it belongs to the file and not to the market —
 * importing eleven parts of one export as `…_PART_001` would name the dataset after the
 * first eleventh of it.
 */
function suggestSymbol(fileName: string): string {
    const base = fileName
        .replace(/\.[^.]+$/, '')
        .replace(/[_-]?part[_-]?\d+$/i, '')
        .toUpperCase()
        .replace(/[^A-Z0-9._-]+/g, '-');
    return base.replace(/^[^A-Z0-9]+/, '').slice(0, 32) || 'IMPORT';
}

/**
 * Opens the picker, then the dialog. Resolves with the dataset name that was imported, or
 * null when nothing was — a dismissed picker never shows a dialog at all.
 */
export async function openCsvImportDialog(host: HTMLElement): Promise<string | null> {
    const picked = await window.midori.data.pickCsv();
    if (!picked) return null;

    injectStyles(STYLE_ID, CSS, host.ownerDocument);

    return new Promise<string | null>((resolve) => {
        let file: MidoriCsvInspection = picked;
        let symbol = suggestSymbol(picked.name);
        let running = false;
        let imported: string | null = null;
        let settled = false;

        const finish = (): void => {
            if (settled) return;
            settled = true;
            dialog.hide();
            resolve(imported);
        };

        const body = document.createElement('div');
        body.className = 'midorii-csv';
        const status = document.createElement('div');
        status.className = 'midorii-csv-status';

        const say = (text: string, tone: 'muted' | 'error' | 'ok' = 'muted'): void => {
            status.textContent = text;
            status.dataset.tone = tone;
        };

        /** Re-reads the head under the settings as they stand, then repaints. Cheap: the
         *  main process reads 64 kB, not the file. */
        const reinspect = async (patch: Partial<MidoriCsvInspection>): Promise<void> => {
            const next = { ...file, ...patch };
            try {
                file = await window.midori.data.inspectCsv({
                    file: next.file,
                    delimiter: next.delimiter,
                    hasHeader: next.hasHeader,
                    // A delimiter change re-splits the file, so the old column indices are
                    // meaningless — let the sniffer map the new columns instead.
                    mapping: patch.delimiter === undefined && patch.hasHeader === undefined ? next.mapping : undefined,
                    dateStyle: next.dateStyle,
                    timeZone: next.timeZone,
                });
                say('');
            } catch (err: unknown) {
                say(err instanceof Error ? err.message : String(err), 'error');
            }
            paint();
        };

        const start = button('Import', true);
        const close = button('Close');
        close.onclick = () => {
            if (running) say('The import is still running — it will say when it is done.');
            else finish();
        };

        start.onclick = () => {
            if (running) return;
            if (file.missing.length > 0) {
                say(`Point ${file.missing.join(', ')} at a column first.`, 'error');
                return;
            }
            running = true;
            start.disabled = true;
            start.style.opacity = '0.6';
            say(file.files && file.files.length > 1
                ? `Reading ${file.files.length} files…`
                : `Reading ${file.name}…`);

            void window.midori.data
                .importCsv({
                    files: file.files ?? [file.file],
                    symbol,
                    delimiter: file.delimiter,
                    hasHeader: file.hasHeader,
                    mapping: file.mapping,
                    dateStyle: file.dateStyle,
                    timeZone: file.timeZone,
                })
                .then((result) => {
                    imported = result.symbol;
                    const range = result.first != null && result.last != null
                        ? ` covering ${stamp(result.first)} to ${stamp(result.last)} UTC`
                        : '';
                    /* A handful of unreadable rows is a footer or a blank price; a large
                     * share of the file is the wrong delimiter, and only the number says
                     * which of the two just happened. */
                    const skipped = result.skipped > 0
                        ? ` ${result.skipped.toLocaleString()} of ${result.rows.toLocaleString()} rows could not be read.`
                        : '';
                    say(`${result.symbol}: ${result.added.toLocaleString()} new ${result.timeframe} bars, `
                        + `${result.total.toLocaleString()} in total${range}.${skipped}`, 'ok');
                })
                .catch((err: unknown) => say(err instanceof Error ? err.message : String(err), 'error'))
                .finally(() => {
                    running = false;
                    start.disabled = false;
                    start.style.opacity = '';
                });
        };

        /* ── painting ──────────────────────────────────────────────────────── */

        /** Which column each field is on, as a picker over the columns that exist. */
        function mappingControls(): HTMLElement {
            const grid = document.createElement('div');
            grid.className = 'midorii-csv-grid';

            const columns = file.headers.map((name, i) => ({ value: String(i), label: name || `Column ${i + 1}` }));

            for (const field of FIELDS) {
                /* The split date/clock pair only makes sense when the file has one, and a
                 * whole timestamp column only when it does not. Showing all three at once
                 * invites a mapping that names the same instant twice. */
                const split = file.mapping.date != null && file.mapping.clock != null;
                if (field.key === 'time' && split) continue;
                if ((field.key === 'date' || field.key === 'clock') && !split) continue;

                const current = file.mapping[field.key];
                const select = new Select({
                    options: field.required ? columns : [{ value: '', label: '—' }, ...columns],
                    value: current == null ? '' : String(current),
                    onChange: (v) => {
                        void reinspect({ mapping: { ...file.mapping, [field.key]: v === '' ? null : Number(v) } });
                    },
                });
                grid.appendChild(row(field.label, select.el));
            }
            return grid;
        }

        function previewTable(): HTMLElement {
            const wrap = document.createElement('div');
            wrap.className = 'midorii-csv-scroll';
            const table = document.createElement('table');
            table.className = 'midorii-csv-table';

            const head = document.createElement('thead');
            const headRow = document.createElement('tr');
            for (const name of ['Bar opens (UTC)', 'Open', 'High', 'Low', 'Close', 'Volume']) {
                const th = document.createElement('th');
                th.textContent = name;
                headRow.appendChild(th);
            }
            head.appendChild(headRow);

            const tbody = document.createElement('tbody');
            for (const bar of file.preview) {
                const tr = document.createElement('tr');
                for (const text of [
                    stamp(bar.time), String(bar.open), String(bar.high), String(bar.low), String(bar.close),
                    Number.isFinite(bar.volume) ? String(bar.volume) : '—',
                ]) {
                    const td = document.createElement('td');
                    td.textContent = text;
                    tr.appendChild(td);
                }
                tbody.appendChild(tr);
            }

            table.append(head, tbody);
            wrap.appendChild(table);
            return wrap;
        }

        function rawTable(): HTMLElement {
            const wrap = document.createElement('div');
            wrap.className = 'midorii-csv-scroll';
            const table = document.createElement('table');
            table.className = 'midorii-csv-table';

            const mapped = new Set(Object.values(file.mapping).filter((v): v is number => v != null));

            const head = document.createElement('thead');
            const headRow = document.createElement('tr');
            file.headers.forEach((name, i) => {
                const th = document.createElement('th');
                th.textContent = name || `Column ${i + 1}`;
                th.dataset.mapped = mapped.has(i) ? '1' : '0';
                headRow.appendChild(th);
            });
            head.appendChild(headRow);

            const tbody = document.createElement('tbody');
            for (const cells of file.sample) {
                const tr = document.createElement('tr');
                file.headers.forEach((_, i) => {
                    const td = document.createElement('td');
                    td.textContent = cells[i] ?? '';
                    td.dataset.mapped = mapped.has(i) ? '1' : '0';
                    tr.appendChild(td);
                });
                tbody.appendChild(tr);
            }

            table.append(head, tbody);
            wrap.appendChild(table);
            return wrap;
        }

        function paint(): void {
            body.replaceChildren();

            const head = document.createElement('div');
            head.className = 'midorii-csv-file';
            const name = document.createElement('b');
            name.textContent = file.name;
            const size = document.createElement('span');
            const parts = file.files && file.files.length > 1
                ? ` · ${file.files.length} files, read as one series`
                : '';
            size.textContent = `${bytes(file.bytes)} · ${file.columnCount} columns${parts}`;
            head.append(name, size);
            body.appendChild(head);

            const grid = document.createElement('div');
            grid.className = 'midorii-csv-grid';

            const nameField = new TextField({
                value: symbol,
                fill: false,
                onChange: (v: string) => { symbol = v.toUpperCase(); },
            });
            nameField.input.addEventListener('input', () => { symbol = nameField.input.value.toUpperCase(); });
            grid.appendChild(row(
                'Dataset name',
                nameField.el,
                'What the market is called in the library, on the chart and in a run. Letters, '
                + 'digits, dot, dash or underscore.',
            ));

            const delimiter = new Select({
                options: [...DELIMITERS],
                value: file.delimiter,
                onChange: (v) => { void reinspect({ delimiter: v }); },
            });
            grid.appendChild(row('Columns split by', delimiter.el));

            const header = new Switch({
                checked: file.hasHeader,
                onChange: (on) => { void reinspect({ hasHeader: on }); },
            });
            grid.appendChild(row(
                'First row names the columns',
                header.el,
                'Off reads the first row as data, in the Binance dump order: time, open, high, '
                + 'low, close, volume.',
            ));

            if (file.needsTimeZone) {
                const style = new Select({
                    options: [...DATE_STYLES],
                    value: file.dateStyle,
                    onChange: (v) => { void reinspect({ dateStyle: v as MidoriCsvDateStyle }); },
                });
                grid.appendChild(row(
                    'Date order',
                    style.el,
                    'Which number is the day. Check it against the preview below — 03/04 reads '
                    + 'either way, and a file read the wrong way round looks entirely normal.',
                ));

                const zone = new Select({
                    options: file.timeZones.map((z) => ({ value: z.value, label: z.label })),
                    value: file.timeZone,
                    onChange: (v) => { void reinspect({ timeZone: v }); },
                });
                grid.appendChild(row(
                    'Timestamps are in',
                    zone.el,
                    'The clock the file was written in. Everything is stored in UTC, so this is '
                    + 'what a New York export needs in order to land on the right hour.',
                ));
            }

            body.append(grid, label('Columns'), mappingControls());

            if (file.missing.length > 0) {
                const missing = document.createElement('p');
                missing.className = 'midorii-csv-hint';
                missing.style.color = 'var(--vela-danger)';
                missing.textContent = `Nothing is mapped to: ${file.missing.join(', ')}.`;
                body.appendChild(missing);
            }

            body.append(label('The file, as it reads'), rawTable());

            body.appendChild(label('The first bars, as they will be stored'));
            if (file.preview.length > 0) {
                const hint = document.createElement('p');
                hint.className = 'midorii-csv-hint';
                hint.textContent = file.needsTimeZone
                    ? 'These are in UTC. If the dates or the hours are not what the file meant, '
                        + 'the date order or the time zone above is the reason.'
                    : 'The timestamps in this file are epoch numbers, which carry their own clock.';
                body.appendChild(hint);
                body.appendChild(previewTable());
            } else {
                const why = document.createElement('p');
                why.className = 'midorii-csv-hint';
                why.style.color = 'var(--vela-danger)';
                why.textContent = file.previewError ?? 'Nothing in the sample parsed as a bar.';
                body.appendChild(why);
            }

            body.appendChild(status);
        }

        const dialog = new Dialog({
            title: 'Import market data',
            host,
            draggable: true,
            align: 'center',
            closeOnInteractOutside: false,
            onOpenChange: (open) => { if (!open) finish(); },
            content: (el) => {
                paint();
                el.appendChild(body);
            },
            footer: (el) => {
                el.style.cssText += ';display:flex;justify-content:flex-end;gap:8px';
                el.append(close, start);
            },
        });
        dialog.show();
    });
}
