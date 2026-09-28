// The risk mode as badges, and the label that reads off it.
//
// A minimal element stub (this suite runs in the node env — no jsdom), modelling just
// enough of the tree for the two functions under test: attributes, children, text and one
// listener each. The same pattern as color-picker.test.ts.
import { describe, expect, it } from 'vitest';
import { RISK_PARAMS } from '../shared/strategies/risk.js';
import { badgeGroup, contextualParam, fieldRow } from '../app/renderer/strategies/paramFields';
import type { StrategyParam } from '../app/renderer/strategies/types';

interface FakeEl {
    tag: string;
    className: string;
    textContent: string;
    title?: string;
    type?: string;
    tabIndex?: number;
    attrs: Record<string, string>;
    children: FakeEl[];
    listeners: Record<string, Array<() => void>>;
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    appendChild(child: FakeEl): FakeEl;
    append(...nodes: FakeEl[]): void;
    addEventListener(type: string, fn: () => void): void;
    click(): void;
}

function element(tag: string): FakeEl {
    const el: FakeEl = {
        tag,
        className: '',
        textContent: '',
        attrs: {},
        children: [],
        listeners: {},
        setAttribute(name, value) { this.attrs[name] = value; },
        getAttribute(name) { return this.attrs[name] ?? null; },
        appendChild(child) { this.children.push(child); return child; },
        append(...nodes) { this.children.push(...nodes); },
        addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
        click() { for (const fn of this.listeners.click ?? []) fn(); },
    };
    return el;
}

const doc = { createElement: (tag: string) => element(tag) } as unknown as Document;

/** The badge group as a list of [label, chosen] pairs. */
function badges(group: FakeEl): Array<[string, boolean]> {
    return group.children.map((b) => [b.textContent, b.getAttribute('aria-checked') === 'true']);
}

describe('the risk mode as badges', () => {
    const param = RISK_PARAMS.find((p) => p.key === 'riskMode')!;

    it('is what the shared schema asks for, with the symbol in the option', () => {
        expect(param.variant).toBe('badges');
        expect(param.options?.map((o) => o.label)).toEqual(['% of equity', '$ fixed']);
    });

    it('shows every option at once, with one of them on', () => {
        const group = badgeGroup(doc, param.options ?? [], 'fixed', () => {}) as unknown as FakeEl;

        expect(group.getAttribute('role')).toBe('radiogroup');
        expect(badges(group)).toEqual([['% of equity', false], ['$ fixed', true]]);
        // A radio group is one tab stop, not one per option.
        expect(group.children.map((b) => b.tabIndex)).toEqual([-1, 0]);
    });

    it('reports a pick, and says nothing when the chosen one is clicked again', () => {
        const picked: string[] = [];
        const group = badgeGroup(doc, param.options ?? [], 'fixed', (v) => picked.push(v)) as unknown as FakeEl;

        group.children[1]!.click();
        expect(picked).toEqual([]);
        group.children[0]!.click();
        expect(picked).toEqual(['percent']);
    });

    it('is not wrapped in a label, which would pick the leftmost option on a click', () => {
        const group = badgeGroup(doc, param.options ?? [], 'fixed', () => {});
        const withGroup = fieldRow(doc, 'Risk per trade', group) as unknown as FakeEl;
        const withControl = fieldRow(doc, 'Risk', element('input') as unknown as HTMLElement) as unknown as FakeEl;

        expect(withGroup.tag).toBe('div');
        expect(withGroup.getAttribute('aria-label')).toBe('Risk per trade');
        expect(withControl.tag).toBe('label');
    });
});

describe('the Risk field, labelled by the badge above it', () => {
    const param = RISK_PARAMS.find((p) => p.key === 'riskValue')! as StrategyParam;

    it('says which of the two readings applies', () => {
        expect(contextualParam(param, { riskMode: 'fixed' }).label).toBe('Risk ($ per trade)');
        expect(contextualParam(param, { riskMode: 'percent' }).label).toBe('Risk (% of equity)');
        // The schema's own default, for a form that has not been touched yet.
        expect(contextualParam(param, {}).label).toBe('Risk (% of equity)');
    });

    it('leaves every other field exactly as the schema wrote it', () => {
        const rrr = RISK_PARAMS.find((p) => p.key === 'rrr')! as StrategyParam;
        expect(contextualParam(rrr, { riskMode: 'fixed' })).toBe(rrr);
    });
});
