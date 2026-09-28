import type { DrawingBox, DrawingLine } from '../../../src';
import { withAlpha, type PositionStyle } from './positionStyle';

/**
 * One side of a position block, shaded most strongly at its stop or target and fading towards
 * the entry. The caller chooses whether the block is still open to the right or ends at a
 * known time; everything else comes from the shared position style.
 */
export function positionZone(
    id: string,
    left: number,
    right: number,
    entryPrice: number,
    levelPrice: number,
    color: string,
    style: PositionStyle,
    extend: DrawingBox['extend'] = style.extendRight ? 'right' : 'none',
): DrawingBox {
    const strong = withAlpha(color, style.zoneOpacity);
    const faded = withAlpha(color, 0);
    const levelOnTop = levelPrice > entryPrice;
    return {
        id,
        paneId: 'price',
        xloc: 'bar_time',
        overlay: true,
        left,
        right,
        top: Math.max(entryPrice, levelPrice),
        bottom: Math.min(entryPrice, levelPrice),
        extend,
        bgColor: style.zoneGradient ? (levelOnTop ? strong : faded) : strong,
        ...(style.zoneGradient ? { bgColorTo: levelOnTop ? faded : strong } : {}),
        borderWidth: 0,
        borderStyle: 'solid',
        textSize: 'auto',
        hAlign: 'center',
        vAlign: 'center',
        wrap: false,
        fontFamily: 'default',
        bold: false,
        italic: false,
    };
}

/** A horizontal entry, stop, or target level in the shared position-tool language. */
export function positionLevelLine(
    id: string,
    x1: number,
    x2: number,
    price: number,
    color: string,
    lineStyle: DrawingLine['style'],
    extend: DrawingLine['extend'],
    width: number,
): DrawingLine {
    return {
        id,
        paneId: 'price',
        xloc: 'bar_time',
        overlay: true,
        x1,
        y1: price,
        x2,
        y2: price,
        extend,
        color,
        invisible: false,
        width,
        style: lineStyle,
        arrowLeft: false,
        arrowRight: false,
    };
}
