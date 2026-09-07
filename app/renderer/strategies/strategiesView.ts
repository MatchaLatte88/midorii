import { NumberInput, Select, Switch, injectStyles, overlayScrollbarCss } from '../../../src/ui';
import { RISK_PARAM_KEYS, resolveStrategyParams, strategyCatalog } from './index';
import type { StrategyInfo, StrategyParam, StrategyParams } from './types';
import { button, ensureFigureStyles, sectionLabel } from '../runs/runViews';

/**
 * The Strategies tab: what this app can trade on its own, and what each one is set to.
 *
 * The distinction this screen exists to make
 * ------------------------------------------
 * An indicator describes the market and stops there. It draws a gap, a sweep, a session —
 * "look, this happened" — and a person decides what to do about it. It has no entry, no
 * stop, no target and no size, and nothing about it can be automated, because it never
 * commits to anything.
 *
 * A strategy commits. It says where it gets in, where it is wrong, where it takes profit
 * and how much is at stake, and it says all of that as rules rather than as judgement. That
 * is what makes it something a backtest can run and a bot could one day trade — and it is
 * the only kind of thing on this screen.
 *
 * A strategy is allowed to READ an indicator, and Silver Bullet does: the detector stays in
 * the chart core, keeps painting on the chart, and the strategy acts on what it finds. One
 * definition, two uses. If the strategy re-implemented the detection, the chart and the
 * backtest would eventually disagree about the same market.
 *
 * Settings here are the strategy's, not a run's
 * ---------------------------------------------
 * What is saved on this screen is what the strategy IS — the reward-to-risk it aims for,
 * the risk it takes, what it counts as a setup. The Backtest tab starts from these and may
 * override them for one run; what a run stores is what it actually ran with. So the two
 * never have to be kept in step, and neither can quietly rewrite the other's history.
 */

const STYLE_ID = 'midorii-strategies';
const CSS = `
.midorii-strategies {
    position: absolute; inset: 0;
    display: flex; flex-direction: column;
    background: var(--vela-bg);
    color: var(--vela-fg);
    font: 13px/1.5 var(--vela-font, sans-serif);
}
.midorii-strategies-bar {
    flex: none;
    display: flex; align-items: center; gap: 10px;
    height: 34px; padding: 0 14px;
    border-bottom: 1px solid var(--vela-border);
    font-size: 12px; color: var(--vela-fg-muted);
}
.midorii-strategies-main { flex: 1 1 auto; min-height: 0; display: flex; }

.midorii-strategies-list {
    flex: none; width: 220px; padding: 10px 8px;
    border-right: 1px solid var(--vela-border);
    overflow: auto;
}
${overlayScrollbarCss('.midorii-strategies-list')}
.midorii-strategies-item {
    all: unset;
    display: block; box-sizing: border-box; width: 100%;
    padding: 8px 10px; margin-bottom: 2px;
    border-radius: var(--vela-radius-sm);
    cursor: pointer;
}
.midorii-strategies-item:hover { background: var(--vela-hover); }
.midorii-strategies-item[data-active='1'] { background: var(--vela-active); }
.midorii-strategies-item b { display: block; font-size: 13px; font-weight: 600; color: var(--vela-fg-bright); }
.midorii-strategies-item span { display: block; margin-top: 2px; font-size: 11.5px; color: var(--vela-fg-muted); }

.midorii-strategies-body { flex: 1 1 auto; min-width: 0; overflow: auto; }
${overlayScrollbarCss('.midorii-strategies-body')}
.midorii-strategies-inner { max-width: 900px; margin: 0 auto; padding: 16px 18px 32px; }

.midorii-strategies-card {
    padding: 12px 14px; margin-bottom: 20px;
    background: var(--vela-surface);
    border: 1px solid var(--vela-border-faint);
    border-radius: var(--vela-radius-sm);
}
.midorii-strategies-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 2px; }
.midorii-strategies-head h2 { margin: 0; font-size: 16px; color: var(--vela-fg-bright); }
.midorii-strategies-badge {
    padding: 1px 7px; border-radius: 999px;
    font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    background: var(--vela-surface-overlay); color: var(--vela-fg-muted);
}
.midorii-strategies-sub { margin: 0 0 12px; color: var(--vela-fg-muted); font-size: 12.5px; line-height: 1.55; }

.midorii-strategies-rules { margin: 0; }
.midorii-strategies-rule {
    display: grid; grid-template-columns: 96px 1fr; gap: 10px;
    padding: 7px 0; border-bottom: 1px solid var(--vela-border-faint);
}
.midorii-strategies-rule:last-child { border-bottom: none; }
.midorii-strategies-rule dt {
    margin: 0; font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--vela-fg-muted); padding-top: 2px;
}
.midorii-strategies-rule dd { margin: 0; color: var(--vela-fg); line-height: 1.55; }
.midorii-strategies-conditions { margin: 0; padding-left: 18px; }
.midorii-strategies-conditions li { margin-bottom: 3px; }

.midorii-strategies-grid {
    display: grid; gap: 10px 18px;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
}
.midorii-strategies-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    min-height: 26px;
}
.midorii-strategies-row > span:first-child { color: var(--vela-fg-muted); white-space: nowrap; }
.midorii-strategies-toggles { display: inline-flex; align-items: center; gap: 10px; }
.midorii-strategies-toggle { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; }

.midorii-strategies-actions { display: flex; align-items: center; gap: 10px; margin-top: 16px; }
.midorii-strategies-status { color: var(--vela-fg-muted); font-size: 12px; }
.midorii-strategies-status[data-error='1'] { color: var(--vela-danger); }
.midorii-strategies-empty { padding: 20px 4px; color: var(--vela-fg-muted); line-height: 1.6; }
`;

function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
    const el = document.createElement('label');
    el.className = 'midorii-strategies-row';
    const text = document.createElement('span');
    text.textContent = label;
    if (hint) text.title = hint;
    el.append(text, control);
    return el;
}

export interface StrategiesViewHandle {
    /** Re-read the stored settings and repaint. Called whenever the tab is opened. */
    refresh(): Promise<void>;
}

/** Mount the Strategies tab into `host`. */
export function mountStrategiesView(host: HTMLElement): StrategiesViewHandle {
    const doc = host.ownerDocument;
    injectStyles(STYLE_ID, CSS, doc);
    ensureFigureStyles(doc);

    const root = doc.createElement('div');
    root.className = 'midorii-strategies midorii-figures';

    const bar = doc.createElement('div');
    bar.className = 'midorii-strategies-bar';
    const barLabel = doc.createElement('span');
    barLabel.textContent = 'Strategies';
    bar.appendChild(barLabel);

    const main = doc.createElement('div');
    main.className = 'midorii-strategies-main';
    const list = doc.createElement('div');
    list.className = 'midorii-strategies-list';
    const body = doc.createElement('div');
    body.className = 'midorii-strategies-body';
    const inner = doc.createElement('div');
    inner.className = 'midorii-strategies-inner';
    body.appendChild(inner);
    main.append(list, body);

    root.append(bar, main);
    host.appendChild(root);

    const catalog = strategyCatalog();

    let selected = catalog[0]?.id ?? '';
    /** What is on disk, keyed by strategy id. */
    let stored: Record<string, Record<string, unknown>> = {};
    /** The form's current values per strategy — the stored settings until they are edited. */
    const editing = new Map<string, StrategyParams>();
    let status: { text: string; error?: boolean } | null = null;

    function strategy(): StrategyInfo | undefined {
        return catalog.find((s) => s.id === selected);
    }

    /**
     * The form's values for one strategy.
     *
     * Resolved against the current schema on the way out of storage, so a stored value that
     * no longer fits — a parameter this build renamed, a bound that moved — falls back to
     * the default and SAYS so, rather than being carried forward as a setting nothing
     * honours.
     */
    function valuesFor(id: string): StrategyParams {
        let held = editing.get(id);
        if (!held) {
            try {
                held = resolveStrategyParams(id, stored[id] ?? {});
            } catch (err) {
                status = {
                    text: `Stored settings for this strategy no longer fit and were left out: `
                        + `${err instanceof Error ? err.message : String(err)}`,
                    error: true,
                };
                held = resolveStrategyParams(id, {});
            }
            editing.set(id, held);
        }
        return held;
    }

    /** Whether the form differs from what is on disk — what the Save button is for. */
    function isDirty(id: string): boolean {
        const spec = catalog.find((s) => s.id === id);
        if (!spec) return false;
        let saved: StrategyParams;
        try {
            saved = resolveStrategyParams(id, stored[id] ?? {});
        } catch {
            return true;
        }
        return JSON.stringify(valuesFor(id)) !== JSON.stringify(saved);
    }

    /* ── reading and writing ─────────────────────────────────────────────── */

    async function refresh(): Promise<void> {
        try {
            const next = await window.midori.strategies.load();
            /* Only re-seed the form where the file actually changed. Re-seeding everything
             * on every visit would throw away an edit somebody left half-finished. */
            for (const spec of catalog) {
                if (JSON.stringify(next[spec.id] ?? null) !== JSON.stringify(stored[spec.id] ?? null)) {
                    editing.delete(spec.id);
                }
            }
            stored = next;
            status = null;
        } catch (err) {
            status = { text: err instanceof Error ? err.message : String(err), error: true };
        }
        paint();
    }

    async function save(): Promise<void> {
        const spec = strategy();
        if (!spec) return;
        try {
            const params = resolveStrategyParams(spec.id, valuesFor(spec.id));
            stored = await window.midori.strategies.save(spec.id, params);
            editing.set(spec.id, params);
            status = { text: 'Saved. The Backtest tab starts from these.' };
        } catch (err) {
            status = { text: err instanceof Error ? err.message : String(err), error: true };
        }
        paint();
    }

    async function reset(): Promise<void> {
        const spec = strategy();
        if (!spec) return;
        try {
            stored = await window.midori.strategies.reset(spec.id);
            editing.delete(spec.id);
            status = { text: 'Back to the strategy’s own defaults.' };
        } catch (err) {
            status = { text: err instanceof Error ? err.message : String(err), error: true };
        }
        paint();
    }

    /* ── drawing ─────────────────────────────────────────────────────────── */

    /** One field of a strategy's schema, as the control its type asks for. */
    function field(param: StrategyParam, values: StrategyParams): HTMLElement {
        if (param.type === 'select') {
            const select = new Select({
                options: [...(param.options ?? [])],
                value: String(values[param.key] ?? param.default),
                onChange: (v) => { values[param.key] = v; paint(); },
            });
            return row(param.label, select.el, param.hint);
        }

        if (param.type === 'multi') {
            const picked = new Set(Array.isArray(values[param.key]) ? (values[param.key] as readonly string[]) : []);
            const group = doc.createElement('div');
            group.className = 'midorii-strategies-toggles';
            for (const option of param.options ?? []) {
                const wrap = doc.createElement('label');
                wrap.className = 'midorii-strategies-toggle';
                const toggle = new Switch({
                    checked: picked.has(option.value),
                    size: 'sm',
                    onChange: (on) => {
                        if (on) picked.add(option.value);
                        else picked.delete(option.value);
                        // The schema's own order, not the order they were clicked in.
                        values[param.key] = (param.options ?? []).map((o) => o.value).filter((v) => picked.has(v));
                        paint();
                    },
                });
                const text = doc.createElement('span');
                text.textContent = option.label;
                wrap.append(toggle.el, text);
                group.appendChild(wrap);
            }
            return row(param.label, group, param.hint);
        }

        if (param.type === 'bool') {
            const toggle = new Switch({
                checked: values[param.key] === true,
                onChange: (on) => { values[param.key] = on; paint(); },
            });
            return row(param.label, toggle.el, param.hint);
        }

        const input = new NumberInput({
            value: Number(values[param.key] ?? param.default),
            min: param.min,
            max: param.max,
            step: param.step,
            integer: param.step === 1,
            fill: false,
            onChange: (v) => { values[param.key] = v; paint(); },
        });
        return row(param.label, input.el, param.hint);
    }

    function card(title?: string): HTMLElement {
        const el = doc.createElement('div');
        el.className = 'midorii-strategies-card';
        if (title) el.appendChild(sectionLabel(title));
        return el;
    }

    /** Entry, stop, target, size — the four answers that make this a strategy. */
    function rulesCard(spec: StrategyInfo): HTMLElement {
        const el = card();
        const heading = doc.createElement('p');
        heading.className = 'midorii-strategies-sub';
        heading.textContent = 'What it does, in rules rather than in judgement. This is the whole '
            + 'difference between a strategy and an indicator: an indicator would mark the same '
            + 'setups and stop there.';
        el.appendChild(heading);

        const rules = spec.rules;
        if (!rules) {
            const none = doc.createElement('p');
            none.className = 'midorii-strategies-empty';
            none.textContent = 'This strategy does not describe its own rules.';
            el.appendChild(none);
            return el;
        }

        const dl = doc.createElement('dl');
        dl.className = 'midorii-strategies-rules';

        const rule = (label: string, content: Node | string): void => {
            const wrap = doc.createElement('div');
            wrap.className = 'midorii-strategies-rule';
            const dt = doc.createElement('dt');
            dt.textContent = label;
            const dd = doc.createElement('dd');
            if (typeof content === 'string') dd.textContent = content;
            else dd.appendChild(content);
            wrap.append(dt, dd);
            dl.appendChild(wrap);
        };

        const conditions = doc.createElement('ul');
        conditions.className = 'midorii-strategies-conditions';
        for (const line of rules.conditions) {
            const li = doc.createElement('li');
            li.textContent = line;
            conditions.appendChild(li);
        }

        rule('Setup', conditions);
        rule('Entry', rules.entry);
        rule('Stop', rules.stop);
        rule('Target', rules.target);
        rule('Size', rules.size);
        el.appendChild(dl);
        return el;
    }

    function paintDetail(spec: StrategyInfo): void {
        const head = doc.createElement('div');
        head.className = 'midorii-strategies-head';
        const h = doc.createElement('h2');
        h.textContent = spec.name;
        const badge = doc.createElement('span');
        badge.className = 'midorii-strategies-badge';
        badge.textContent = 'Strategy';
        head.append(h, badge);
        inner.appendChild(head);

        const sub = doc.createElement('p');
        sub.className = 'midorii-strategies-sub';
        sub.textContent = spec.description;
        inner.appendChild(sub);

        if (spec.indicatorName) {
            const reads = doc.createElement('p');
            reads.className = 'midorii-strategies-sub';
            reads.textContent = `Reads the ${spec.indicatorName} indicator’s detector — the same one that `
                + 'paints on the chart, so the two can never disagree about the same market. The '
                + 'indicator only draws; the entry, the stop, the target and the size below are what '
                + 'this adds.';
            inner.appendChild(reads);
        }

        inner.appendChild(rulesCard(spec));

        const values = valuesFor(spec.id);
        const risk = spec.params.filter((p) => RISK_PARAM_KEYS.includes(p.key));
        const own = spec.params.filter((p) => !RISK_PARAM_KEYS.includes(p.key));

        const settings = card();
        const intro = doc.createElement('p');
        intro.className = 'midorii-strategies-sub';
        intro.textContent = 'What this strategy is set to. Saved here and used as the starting point '
            + 'everywhere it runs — a backtest may override them for one run, and stores what it '
            + 'actually ran with.';
        settings.appendChild(intro);

        settings.appendChild(sectionLabel('Risk and size'));
        const riskGrid = doc.createElement('div');
        riskGrid.className = 'midorii-strategies-grid';
        for (const param of risk) riskGrid.appendChild(field(param, values));
        settings.appendChild(riskGrid);

        if (own.length > 0) {
            settings.appendChild(sectionLabel('What counts as a setup'));
            const ownGrid = doc.createElement('div');
            ownGrid.className = 'midorii-strategies-grid';
            for (const param of own) ownGrid.appendChild(field(param, values));
            settings.appendChild(ownGrid);
        }

        const actions = doc.createElement('div');
        actions.className = 'midorii-strategies-actions';
        const dirty = isDirty(spec.id);

        const saveButton = button(dirty ? 'Save settings' : 'Saved', 'primary');
        saveButton.disabled = !dirty;
        saveButton.onclick = () => void save();

        const resetButton = button('Reset to defaults');
        resetButton.disabled = !(spec.id in stored) && !dirty;
        resetButton.onclick = () => void reset();

        const statusEl = doc.createElement('span');
        statusEl.className = 'midorii-strategies-status';
        if (status) {
            statusEl.textContent = status.text;
            if (status.error) statusEl.dataset.error = '1';
        } else if (dirty) {
            statusEl.textContent = 'Not saved yet.';
        }

        actions.append(saveButton, resetButton, statusEl);
        settings.appendChild(actions);

        const filed = doc.createElement('p');
        filed.className = 'midorii-strategies-sub';
        filed.style.marginTop = '12px';
        filed.textContent = 'Every one of these is stored with each run made from them, and shown '
            + 'again on the Analysis tab — a result that cannot say what produced it is not a '
            + 'result anybody can act on.';
        settings.appendChild(filed);
        inner.appendChild(settings);
    }

    function paint(): void {
        list.replaceChildren();
        for (const spec of catalog) {
            const item = doc.createElement('button');
            item.className = 'midorii-strategies-item';
            if (spec.id === selected) item.dataset.active = '1';
            const name = doc.createElement('b');
            name.textContent = spec.name;
            const what = doc.createElement('span');
            what.textContent = spec.indicatorName ? `reads ${spec.indicatorName}` : 'strategy';
            item.append(name, what);
            item.onclick = () => {
                selected = spec.id;
                status = null;
                paint();
            };
            list.appendChild(item);
        }

        inner.replaceChildren();
        const spec = strategy();
        if (!spec) {
            const none = doc.createElement('p');
            none.className = 'midorii-strategies-empty';
            none.textContent = 'No strategies are registered in this build.';
            inner.appendChild(none);
            return;
        }
        paintDetail(spec);
    }

    paint();
    return { refresh };
}
