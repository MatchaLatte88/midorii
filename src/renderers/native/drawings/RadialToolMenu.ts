import type { VelaTheme } from '../../../core/options';
import type { DrawingTypeKey, RadialToolSlot } from '../../../core/drawings';
import { getDrawingType } from '../../../core/drawings';
import { injectStyles } from '../../../ui/styles';
import { applyChromeTokens } from '../../shared/theme-tokens';

const STYLE_ID = 'vela-radial-tool-menu';
const VIEW_SIZE = 430;
const CENTRE = VIEW_SIZE / 2;
const OUTER_RADIUS = 208;
const INNER_RADIUS = 84;
const LABEL_RADIUS = 147;
const MIN_SIZE = 310;
const EDGE_GAP = 10;

const POINTER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3.5 18.5 13l-6.1 1.1-3.2 5.4L5 3.5Z"/></svg>';

const CSS = `
.vela-radial {
    position: fixed;
    z-index: var(--vela-z-popover);
    width: var(--vela-radial-size); height: var(--vela-radial-size);
    transform: translate(-50%, -50%) scale(.94);
    opacity: 0;
    pointer-events: none;
    color: var(--vela-fg-bright);
    font: 600 12px/1.15 var(--vela-font, sans-serif);
    filter: drop-shadow(0 18px 34px rgba(0,0,0,.42));
    transition: opacity var(--vela-dur-med) var(--vela-ease), transform var(--vela-dur-med) var(--vela-ease);
}
.vela-radial[hidden] { display: none !important; }
.vela-radial[data-open='1'] { opacity: 1; transform: translate(-50%, -50%) scale(1); }
.vela-radial-ring { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.vela-radial-sector {
    fill: color-mix(in srgb, var(--vela-surface-card) 95%, transparent);
    stroke: var(--vela-border-strong);
    stroke-width: 1.25;
    transition: fill var(--vela-dur-fast) ease, stroke var(--vela-dur-fast) ease;
}
.vela-radial-sector[data-active='1'] {
    fill: color-mix(in srgb, var(--vela-accent) 82%, var(--vela-bg));
    stroke: var(--vela-accent-bright);
    stroke-width: 2;
}
.vela-radial-label {
    position: absolute;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
    width: 92px; min-height: 54px;
    transform: translate(-50%, -50%);
    text-align: center;
    color: var(--vela-fg);
    text-shadow: 0 1px 2px rgba(0,0,0,.7);
}
.vela-radial-label[data-active='1'] { color: var(--vela-fg-on-fill); }
.vela-radial-label-icon { display: grid; place-items: center; width: 23px; height: 23px; }
.vela-radial-label-icon svg { display: block; width: 23px; height: 23px; }
.vela-radial-label-text {
    max-width: 88px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.vela-radial-centre {
    position: absolute; left: 50%; top: 50%;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
    width: 156px; height: 156px;
    transform: translate(-50%, -50%);
    border: 1px solid var(--vela-accent-line);
    border-radius: 50%;
    background: color-mix(in srgb, var(--vela-surface-card) 97%, transparent);
    box-shadow: inset 0 0 0 5px color-mix(in srgb, var(--vela-accent-soft) 45%, transparent);
    text-align: center;
}
.vela-radial-centre-icon { display: grid; place-items: center; width: 25px; height: 25px; color: var(--vela-accent-ink); }
.vela-radial-centre-icon svg { display: block; width: 25px; height: 25px; }
.vela-radial-centre-label { max-width: 128px; font-size: 14px; color: var(--vela-fg-bright); }
.vela-radial-centre-hint {
    font: 600 9px/1 var(--vela-font-mono);
    letter-spacing: .12em; text-transform: uppercase;
    color: var(--vela-fg-muted);
}
.vela-radial[data-compact='1'] .vela-radial-label-text { display: none; }
.vela-radial[data-compact='1'] .vela-radial-label { width: 48px; }
@media (prefers-reduced-motion: reduce) {
    .vela-radial, .vela-radial-sector { transition: none; }
}
`;

function polar(radius: number, angle: number): { x: number; y: number } {
    return { x: CENTRE + Math.cos(angle) * radius, y: CENTRE + Math.sin(angle) * radius };
}

/** SVG path for one ring segment, with a small angular gap at either edge. */
export function annularSectorPath(index: number, count: number): string {
    const step = (Math.PI * 2) / count;
    const gap = Math.min(0.018, step * 0.08);
    const start = -Math.PI / 2 - step / 2 + index * step + gap;
    const end = start + step - gap * 2;
    const a = polar(OUTER_RADIUS, start);
    const b = polar(OUTER_RADIUS, end);
    const c = polar(INNER_RADIUS, end);
    const d = polar(INNER_RADIUS, start);
    const large = end - start > Math.PI ? 1 : 0;
    return [
        `M ${a.x} ${a.y}`,
        `A ${OUTER_RADIUS} ${OUTER_RADIUS} 0 ${large} 1 ${b.x} ${b.y}`,
        `L ${c.x} ${c.y}`,
        `A ${INNER_RADIUS} ${INNER_RADIUS} 0 ${large} 0 ${d.x} ${d.y}`,
        'Z',
    ].join(' ');
}

/** Clockwise segment under a vector from the menu centre; `-1` is the centre dead zone. */
export function radialSectorIndex(dx: number, dy: number, count: number, deadZone: number): number {
    if (count < 1 || Math.hypot(dx, dy) < deadZone) return -1;
    const step = (Math.PI * 2) / count;
    const start = -Math.PI / 2 - step / 2;
    const angle = Math.atan2(dy, dx);
    const normalized = (angle - start + Math.PI * 4) % (Math.PI * 2);
    return Math.min(count - 1, Math.floor(normalized / step));
}

function slotMeta(slot: RadialToolSlot): { label: string; icon: string } {
    if (slot === null) return { label: 'Pointer', icon: POINTER_ICON };
    const meta = getDrawingType(slot);
    return meta ? { label: meta.label, icon: meta.icon } : { label: slot, icon: POINTER_ICON };
}

/** Transient, pointer-transparent wheel opened by the native input controller. */
export class RadialToolMenu {
    private readonly root: HTMLDivElement;
    private readonly svg: SVGSVGElement;
    private readonly labels: HTMLDivElement[] = [];
    private readonly sectors: SVGPathElement[] = [];
    private readonly centreIcon: HTMLSpanElement;
    private readonly centreLabel: HTMLSpanElement;
    private readonly centreHint: HTMLSpanElement;
    private slots: RadialToolSlot[] = [];
    private selected = -1;
    private centreX = 0;
    private centreY = 0;
    private renderedSize = VIEW_SIZE;

    constructor(
        host: HTMLElement,
        theme: VelaTheme,
        private readonly onArm: (slot: RadialToolSlot) => void,
    ) {
        const doc = host.ownerDocument;
        injectStyles(STYLE_ID, CSS, doc);
        this.root = doc.createElement('div');
        this.root.className = 'vela-radial';
        this.root.hidden = true;
        this.root.setAttribute('role', 'menu');
        this.root.setAttribute('aria-label', 'Drawing tools');
        this.root.setAttribute('aria-hidden', 'true');
        applyChromeTokens(this.root, theme);

        this.svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        this.svg.classList.add('vela-radial-ring');
        this.svg.setAttribute('viewBox', `0 0 ${VIEW_SIZE} ${VIEW_SIZE}`);

        const centre = doc.createElement('div');
        centre.className = 'vela-radial-centre';
        this.centreIcon = doc.createElement('span');
        this.centreIcon.className = 'vela-radial-centre-icon';
        this.centreIcon.innerHTML = POINTER_ICON;
        this.centreLabel = doc.createElement('span');
        this.centreLabel.className = 'vela-radial-centre-label';
        this.centreLabel.textContent = 'Move to a tool';
        this.centreHint = doc.createElement('span');
        this.centreHint.className = 'vela-radial-centre-hint';
        this.centreHint.textContent = 'Release to close';
        centre.append(this.centreIcon, this.centreLabel, this.centreHint);
        this.root.append(this.svg, centre);
        host.appendChild(this.root);

        doc.defaultView?.addEventListener('keydown', this.onKeyDown, true);
    }

    get enabled(): boolean {
        return this.slots.length > 0;
    }

    setSlots(slots: readonly RadialToolSlot[]): void {
        this.slots = slots.filter((slot): slot is RadialToolSlot => slot === null || getDrawingType(slot) != null);
        this.rebuild();
        if (!this.enabled) this.cancel();
    }

    setTheme(theme: VelaTheme): void {
        applyChromeTokens(this.root, theme);
    }

    openAt(clientX: number, clientY: number): boolean {
        if (!this.enabled) return false;
        const win = this.root.ownerDocument.defaultView;
        const width = win?.innerWidth ?? VIEW_SIZE;
        const height = win?.innerHeight ?? VIEW_SIZE;
        this.renderedSize = Math.min(VIEW_SIZE, Math.max(MIN_SIZE, Math.min(width - EDGE_GAP * 2, height - EDGE_GAP * 2)));
        const half = this.renderedSize / 2;
        this.centreX = Math.max(half + EDGE_GAP, Math.min(width - half - EDGE_GAP, clientX));
        this.centreY = Math.max(half + EDGE_GAP, Math.min(height - half - EDGE_GAP, clientY));
        this.root.style.setProperty('--vela-radial-size', `${this.renderedSize}px`);
        this.root.style.left = `${this.centreX}px`;
        this.root.style.top = `${this.centreY}px`;
        this.root.dataset.compact = this.renderedSize < 370 ? '1' : '0';
        this.root.hidden = false;
        this.root.setAttribute('aria-hidden', 'false');
        // Force the hidden→open transition to start from the authored closed state.
        void this.root.offsetWidth;
        this.root.dataset.open = '1';
        this.update(clientX, clientY);
        return true;
    }

    update(clientX: number, clientY: number): void {
        if (this.root.hidden) return;
        const deadZone = (INNER_RADIUS / VIEW_SIZE) * this.renderedSize * 0.92;
        this.paintSelection(radialSectorIndex(clientX - this.centreX, clientY - this.centreY, this.slots.length, deadZone));
    }

    finish(clientX: number, clientY: number): boolean {
        if (this.root.hidden) return false;
        this.update(clientX, clientY);
        const slot = this.selected >= 0 ? this.slots[this.selected] : undefined;
        this.cancel();
        if (slot !== undefined) this.onArm(slot);
        return slot !== undefined;
    }

    cancel(): void {
        this.paintSelection(-1);
        delete this.root.dataset.open;
        this.root.hidden = true;
        this.root.setAttribute('aria-hidden', 'true');
    }

    destroy(): void {
        this.root.ownerDocument.defaultView?.removeEventListener('keydown', this.onKeyDown, true);
        this.root.remove();
    }

    private rebuild(): void {
        this.svg.replaceChildren();
        for (const label of this.labels) label.remove();
        this.labels.length = 0;
        this.sectors.length = 0;
        const count = this.slots.length;
        if (count === 0) return;
        const step = (Math.PI * 2) / count;
        for (let index = 0; index < count; index++) {
            const slot = this.slots[index]!;
            const meta = slotMeta(slot);
            const sector = this.root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
            sector.classList.add('vela-radial-sector');
            sector.setAttribute('d', annularSectorPath(index, count));
            this.svg.appendChild(sector);
            this.sectors.push(sector);

            const angle = -Math.PI / 2 + index * step;
            const point = polar(LABEL_RADIUS, angle);
            const label = this.root.ownerDocument.createElement('div');
            label.className = 'vela-radial-label';
            label.style.left = `${(point.x / VIEW_SIZE) * 100}%`;
            label.style.top = `${(point.y / VIEW_SIZE) * 100}%`;
            label.title = meta.label;
            const icon = this.root.ownerDocument.createElement('span');
            icon.className = 'vela-radial-label-icon';
            icon.innerHTML = meta.icon;
            const text = this.root.ownerDocument.createElement('span');
            text.className = 'vela-radial-label-text';
            text.textContent = meta.label;
            label.append(icon, text);
            this.root.appendChild(label);
            this.labels.push(label);
        }
        this.paintSelection(-1);
    }

    private paintSelection(index: number): void {
        if (index === this.selected && index >= 0) return;
        this.selected = index;
        for (let i = 0; i < this.sectors.length; i++) {
            this.sectors[i]!.dataset.active = i === index ? '1' : '0';
            this.labels[i]!.dataset.active = i === index ? '1' : '0';
        }
        const meta = index >= 0 ? slotMeta(this.slots[index]!) : null;
        this.centreIcon.innerHTML = meta?.icon ?? POINTER_ICON;
        this.centreLabel.textContent = meta?.label ?? 'Move to a tool';
        this.centreHint.textContent = meta ? 'Release to arm' : 'Release to close';
    }

    private readonly onKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape' || this.root.hidden) return;
        event.preventDefault();
        event.stopPropagation();
        this.cancel();
    };
}
