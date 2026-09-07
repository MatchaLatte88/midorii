import { registerWidgetAttachment } from '../../../src/plugin';

/**
 * The price under the pointer, last time it was over the PRICE pane.
 *
 * Module-level rather than per-chart: Midorii mounts one chart at a time (see
 * `app/renderer/main.ts`, `layout: false`), so this mirrors exactly what
 * `src/workspace/ChartCell.ts`'s own `lastCrossPrice` already does for the `alt+h`/
 * `alt+v` shortcuts — a right-click always follows a pointer move to that pixel, so the
 * last tracked price IS the click price by the time the context menu opens.
 */
let lastPrice: number | null = null;

export function lastCrosshairPrice(): number | null {
    return lastPrice;
}

/** Track the crosshair's price on every mounted chart. Register once at startup. */
export function installCursorPriceTracking(): () => void {
    return registerWidgetAttachment({
        id: 'midorii.alerts.cursor-price',
        mount(ctx) {
            return ctx.chart.renderer.onCrosshairMove((e) => {
                // A study pane's "price" is an indicator value, not a real price — ignore it
                // rather than let it overwrite the last genuine price-pane reading.
                if (e.paneKind === 'price') lastPrice = e.price;
            });
        },
    });
}
