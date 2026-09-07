/**
 * A price alert — set from the chart (right-click → Add Alert), watched against the
 * symbol's live feed regardless of what the chart happens to be showing, and shown as a
 * dashed line on the chart when that symbol IS on screen (see alertIndicator.ts).
 */
export interface PriceAlert {
    id: string;
    /** The full committed symbol string ("binance:BTCUSDT") — same form as
     *  `WidgetContext.symbol` / `NativeIndicatorContext.symbol`. */
    symbol: string;
    price: number;
    /** 'crossing' fires either direction; 'above'/'below' fire only that one. */
    condition: 'crossing' | 'above' | 'below';
    /** Short — capped at {@link LABEL_MAX_LENGTH} — and shown ON THE CHART, riding the
     *  line's own tag. */
    label: string;
    /** As long as it needs to be, shown only in the alert's own popup — the chart's tag
     *  would be unreadable at any real length. */
    message: string;
    /** Disables itself once it fires. A repeating alert re-arms immediately. */
    once: boolean;
    enabled: boolean;
    createdAt: number;
    lastTriggeredAt: number | null;
}

/** The chart tag has real estate for a name, not a note — see {@link PriceAlert.label}. */
export const LABEL_MAX_LENGTH = 30;

/** A freshly created alert's defaults — everything but the symbol and price a caller supplies. */
export function newAlert(symbol: string, price: number): PriceAlert {
    return {
        id: `alert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        symbol,
        price,
        condition: 'crossing',
        label: '',
        message: '',
        once: true,
        enabled: true,
        createdAt: Date.now(),
        lastTriggeredAt: null,
    };
}

/** The provider prefix of a committed symbol string ("binance:BTCUSDT" → "binance"),
 *  or null for a bare ticker (no provider prefix). */
export function symbolProvider(symbol: string): string | null {
    const i = symbol.indexOf(':');
    return i > 0 ? symbol.slice(0, i).toLowerCase() : null;
}

/** The bare ticker a provider's `subscribe`/`getBars` expects — the part after the
 *  provider prefix, exactly as the user typed it (see `DataProvider.getBars`). */
export function symbolTicker(symbol: string): string {
    const i = symbol.indexOf(':');
    return i > 0 ? symbol.slice(i + 1) : symbol;
}
