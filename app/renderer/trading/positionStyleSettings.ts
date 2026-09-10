import type { IndicatorHandle } from '../../../src';
import type { HostSettingsRow, VelaWorkspace } from '../../../src/workspace';
import { contributeChartSettings } from '../shell/chartSettings';
import { STYLE_INPUT } from '../replay/replayIndicator';
import {
    LINE_WIDTHS, ZONE_OPACITIES, loadPositionStyle, onPositionStyleChange, opacityLabel,
    savePositionStyle, type PositionLineStyle, type PositionStyle,
} from './positionStyle';

/**
 * The Trading tab in the chart's own settings dialog: how a position is drawn.
 *
 * It goes THERE rather than behind the indicator's gear or in the paper-account dialog, and
 * both of those would have been easier. The gear belongs to one instance of one indicator on
 * one chart, and this is neither — it is how positions look, everywhere, whichever account is
 * open. The account dialog is about money. So it sits with the chart's other appearance
 * settings, which is where someone looking to change a colour goes first.
 *
 * The rows are callbacks, so this holds no copy of the style beyond the one it just saved: the
 * dialog reads through `get` every time it opens, and each `set` writes storage and repaints in
 * one step. Nothing here decides what a colour MEANS — see {@link PositionStyle}.
 */

export interface PositionStyleOptions {
    workspace: VelaWorkspace;
    /** The mounted position indicator — the style reaches the chart through its input. */
    indicator: IndicatorHandle;
}

/** Dropdown labels, and the values behind them. */
const LINE_STYLES: ReadonlyArray<{ label: string; value: PositionLineStyle }> = [
    { label: 'Solid', value: 'solid' },
    { label: 'Dashed', value: 'dashed' },
    { label: 'Dotted', value: 'dotted' },
];

const styleLabel = (value: PositionLineStyle): string => LINE_STYLES.find((s) => s.value === value)!.label;
const styleValue = (label: string): PositionLineStyle => LINE_STYLES.find((s) => s.label === label)?.value ?? 'solid';
const widthLabel = (px: number): string => `${px} px`;

/**
 * Put the style on the chart and its controls in the settings dialog.
 *
 * Returns the current style — the caller may need it before the dialog is ever opened — and an
 * unsubscribe that takes the tab back down again.
 */
export function wirePositionStyle(opts: PositionStyleOptions): { style: () => PositionStyle; dispose: () => void } {
    const { workspace, indicator } = opts;
    let style = loadPositionStyle();

    /* The indicator redraws from whatever it was last given, so pushing IS applying: there is
     * no separate repaint, and no way for the chart to be showing a style that was not saved. */
    const push = (): void => {
        indicator.setInput(STYLE_INPUT, JSON.stringify(style));
    };
    const change = (patch: Partial<PositionStyle>): void => {
        style = { ...style, ...patch };
        savePositionStyle(style);
        push();
    };

    push();

    /* A save from anywhere else — the Settings tab — is the same style arriving by another
     * door. Its own saves come back here too and are dropped: `change` already pushed the
     * very object being announced. */
    const unsubscribe = onPositionStyleChange((next) => {
        if (next === style) return;
        style = next;
        push();
    });

    /* Typed against the dialog's own row shape: these cross into the renderer as `unknown[]`,
     * so a misspelled `kind` or a row missing its setter would otherwise turn up as a control
     * that silently does nothing. */
    const rows: HostSettingsRow[] = [
        { kind: 'heading', label: 'Position', id: 'position' },
        { kind: 'color', label: 'Entry', id: 'entry-color', get: () => style.entryColor, set: (v: string) => change({ entryColor: v }) },
        { kind: 'color', label: 'Stop loss', id: 'stop-color', get: () => style.stopColor, set: (v: string) => change({ stopColor: v }) },
        { kind: 'color', label: 'Take profit', id: 'target-color', get: () => style.targetColor, set: (v: string) => change({ targetColor: v }) },
        {
            kind: 'select',
            label: 'Level line',
            id: 'level-style',
            options: LINE_STYLES.map((s) => s.label),
            get: () => styleLabel(style.levelStyle),
            set: (v: string) => change({ levelStyle: styleValue(v) }),
        },
        {
            kind: 'select',
            label: 'Entry line',
            id: 'entry-style',
            options: LINE_STYLES.map((s) => s.label),
            get: () => styleLabel(style.entryStyle),
            set: (v: string) => change({ entryStyle: styleValue(v) }),
        },
        {
            kind: 'select',
            label: 'Line width',
            id: 'line-width',
            options: LINE_WIDTHS.map(widthLabel),
            get: () => widthLabel(style.lineWidth),
            set: (v: string) => change({ lineWidth: Number.parseInt(v, 10) }),
        },
        {
            kind: 'toggle',
            label: 'Extend to right edge',
            id: 'extend-right',
            get: () => style.extendRight,
            set: (v: boolean) => change({ extendRight: v }),
        },
        { kind: 'heading', label: 'Risk / reward zones', id: 'zones' },
        { kind: 'toggle', label: 'Show zones', id: 'zones-on', get: () => style.zones, set: (v: boolean) => change({ zones: v }) },
        {
            kind: 'select',
            label: 'Opacity',
            id: 'zone-opacity',
            options: ZONE_OPACITIES.map(opacityLabel),
            get: () => opacityLabel(style.zoneOpacity),
            // The label IS the value here, to a hundredth — `15%` is the only thing
            // `0.15` was ever displayed as, so reading it back needs no table.
            set: (v: string) => change({ zoneOpacity: Number.parseInt(v, 10) / 100 }),
        },
        {
            kind: 'toggle',
            label: 'Fade towards entry',
            id: 'zone-gradient',
            get: () => style.zoneGradient,
            set: (v: boolean) => change({ zoneGradient: v }),
        },
        { kind: 'heading', label: 'Executions', id: 'executions' },
        {
            kind: 'toggle',
            label: 'Mark filled orders',
            id: 'executions-on',
            get: () => style.executions,
            set: (v: boolean) => change({ executions: v }),
        },
    ];

    /* Through the registry rather than straight at the workspace: this tab comes and goes with
     * an account, and the dialog has other tabs that must not go with it. */
    contributeChartSettings(workspace, 'trading', { title: 'Trading', id: 'trading', rows });

    return {
        style: () => style,
        dispose: () => {
            unsubscribe();
            contributeChartSettings(workspace, 'trading', null);
        },
    };
}
