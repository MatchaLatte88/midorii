import type { DrawingTypeKey, RadialToolSlot } from '../../../src';
import { getDrawingType } from '../../../src/plugin';
import type { VelaWorkspace } from '../../../src/workspace';

export const RADIAL_MENU_SLOT_LABELS = [
    '1 · Top',
    '2 · Upper right',
    '3 · Right, upper',
    '4 · Right, lower',
    '5 · Lower right',
    '6 · Bottom',
    '7 · Lower left',
    '8 · Left, lower',
    '9 · Left, upper',
    '10 · Upper left',
] as const;

export interface RadialMenuPrefs {
    /** Clockwise from the top. `null` is pointer/select. */
    slots: RadialToolSlot[];
}

export const DEFAULT_RADIAL_MENU_PREFS: Readonly<RadialMenuPrefs> = {
    slots: [
        'trendline',
        'hline',
        'vline',
        'ray',
        'box',
        null,
        'freehand',
        'text',
        'fibretracement',
        'parallelchannel',
    ],
};

const STORAGE_KEY = 'midorii-radial-menu';
const CHANGE_EVENT = 'midorii:radial-menu-changed';

function defaults(): RadialMenuPrefs {
    return { slots: [...DEFAULT_RADIAL_MENU_PREFS.slots] };
}

/** Fill missing/malformed slots individually, so one stale tool never resets the wheel. */
export function normalizeRadialMenuPrefs(raw: unknown): RadialMenuPrefs {
    const source = raw && typeof raw === 'object' && Array.isArray((raw as { slots?: unknown }).slots)
        ? (raw as { slots: unknown[] }).slots
        : [];
    const slots = DEFAULT_RADIAL_MENU_PREFS.slots.map((fallback, index) => {
        const value = source[index];
        if (value === null) return null;
        return typeof value === 'string' && getDrawingType(value)
            ? value as DrawingTypeKey
            : fallback;
    });
    return { slots };
}

export function loadRadialMenuPrefs(): RadialMenuPrefs {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return normalizeRadialMenuPrefs(raw == null ? null : JSON.parse(raw));
    } catch (err) {
        console.error('[midorii] could not read the radial menu preferences', err);
        return defaults();
    }
}

export function saveRadialMenuPrefs(prefs: RadialMenuPrefs): void {
    const clean = normalizeRadialMenuPrefs(prefs);
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
    } catch (err) {
        console.error('[midorii] could not persist the radial menu preferences', err);
    }
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Keep one workspace on the machine-wide mapping, including live settings edits. */
export function wireRadialMenu(workspace: VelaWorkspace): () => void {
    const apply = (): void => {
        workspace.chart.drawings.setRadialMenu(loadRadialMenuPrefs().slots);
    };
    apply();
    const win = workspace.root.ownerDocument.defaultView;
    win?.addEventListener(CHANGE_EVENT, apply);
    return () => win?.removeEventListener(CHANGE_EVENT, apply);
}
