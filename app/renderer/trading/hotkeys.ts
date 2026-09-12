/**
 * Keys for the things that are done while looking at the chart.
 *
 * Every gesture here already has a button, and that is the point: a hotkey is not a second way
 * of deciding anything, it is the same press without the reach. The two entry keys go through
 * the ticket panel rather than building an order of their own, so the size, the brackets and
 * every refusal are the ones that were on screen — a key that assembled its own order would be
 * a second opinion about how big, and it would be wrong in a hurry.
 *
 * Nothing fires while a field has focus. A trading screen is full of number boxes, and "f" for
 * flatten landing in the middle of typing a stop is the kind of thing that only has to happen
 * once.
 *
 * Bindings are this machine's, not the account's — they describe a pair of hands.
 */

/** What a key can be bound to. Each one exists as a button somewhere on the trading chart. */
export type TradeAction = 'buy' | 'sell' | 'flatten' | 'cancelAll' | 'breakEven';

/** In the order they are offered, with what to call them where they are chosen. */
export const TRADE_ACTIONS: ReadonlyArray<{ id: TradeAction; label: string; hint: string }> = [
    { id: 'buy', label: 'Buy', hint: 'Sends the ticket as it stands, pointed long.' },
    { id: 'sell', label: 'Sell', hint: 'Sends the ticket as it stands, pointed short.' },
    { id: 'flatten', label: 'Flatten', hint: 'Closes every open position at market.' },
    { id: 'cancelAll', label: 'Cancel orders', hint: 'Cancels everything resting.' },
    { id: 'breakEven', label: 'Break-even', hint: 'Moves the stop to the entry, where the venue offers it.' },
];

/** One binding. `key` is `KeyboardEvent.key`, lowercased for letters. */
export interface Hotkey {
    key: string;
    shift: boolean;
    ctrl: boolean;
    alt: boolean;
}

/**
 * What each action arrives bound to.
 *
 * All carry a modifier. A bare letter is one stray keystroke away from flattening a position,
 * and the guard against a focused field does not cover the case of no field being focused at
 * all — which, on a chart, is most of the time.
 */
export const DEFAULT_HOTKEYS: Record<TradeAction, Hotkey | null> = {
    buy: { key: 'b', shift: true, ctrl: false, alt: false },
    sell: { key: 's', shift: true, ctrl: false, alt: false },
    flatten: { key: 'f', shift: true, ctrl: false, alt: false },
    cancelAll: { key: 'c', shift: true, ctrl: false, alt: false },
    breakEven: { key: 'e', shift: true, ctrl: false, alt: false },
};

const STORAGE_KEY = 'midorii-trade-hotkeys';

/** The binding a key press describes. Null for a press that is only a modifier. */
export function keyOf(event: KeyboardEvent): Hotkey | null {
    const key = event.key;
    if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') return null;
    return {
        key: key.length === 1 ? key.toLowerCase() : key,
        shift: event.shiftKey,
        ctrl: event.ctrlKey || event.metaKey,
        alt: event.altKey,
    };
}

export function sameKey(a: Hotkey | null, b: Hotkey | null): boolean {
    if (!a || !b) return false;
    return a.key === b.key && a.shift === b.shift && a.ctrl === b.ctrl && a.alt === b.alt;
}

/** `Shift+B` — how a binding is written where somebody has to read it back. */
export function formatHotkey(hotkey: Hotkey | null): string {
    if (!hotkey) return 'None';
    const parts: string[] = [];
    if (hotkey.ctrl) parts.push('Ctrl');
    if (hotkey.alt) parts.push('Alt');
    if (hotkey.shift) parts.push('Shift');
    parts.push(hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key);
    return parts.join('+');
}

/** Whatever is stored, with anything missing or unusable falling back to the default. */
export function normalizeHotkeys(raw: unknown): Record<TradeAction, Hotkey | null> {
    const source = (raw ?? {}) as Partial<Record<TradeAction, unknown>>;
    const out = {} as Record<TradeAction, Hotkey | null>;
    for (const { id } of TRADE_ACTIONS) {
        const value = source[id];
        if (value === null) {
            // Deliberately unbound, which is different from never having been set.
            out[id] = null;
            continue;
        }
        const row = value as Partial<Hotkey> | undefined;
        out[id] = typeof row?.key === 'string' && row.key.length > 0
            ? { key: row.key, shift: row.shift === true, ctrl: row.ctrl === true, alt: row.alt === true }
            : DEFAULT_HOTKEYS[id];
    }
    return out;
}

export function loadHotkeys(): Record<TradeAction, Hotkey | null> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return normalizeHotkeys(raw == null ? null : JSON.parse(raw));
    } catch (err) {
        console.error('[midorii] could not read the trading hotkeys', err);
        return { ...DEFAULT_HOTKEYS };
    }
}

export function saveHotkeys(bindings: Record<TradeAction, Hotkey | null>): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
    } catch (err) {
        console.error('[midorii] could not persist the trading hotkeys', err);
    }
}

/**
 * Whether a press landed somewhere a person is writing.
 *
 * Anything that takes text is off limits, and so is anything inside an open dialog — a key
 * meant for a settings field must not also flatten a position behind it.
 */
export function isTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || typeof el.closest !== 'function') return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return el.closest('dialog, [role="dialog"]') != null;
}

export interface HotkeyOptions {
    /** Where the listener goes — the workspace root's document. */
    root: HTMLElement;
    /** Read fresh on every press, so a rebinding takes effect without a remount. */
    bindings(): Record<TradeAction, Hotkey | null>;
    /**
     * What each action does. Anything absent is simply not bound — a venue with no
     * break-even gesture gets no break-even key rather than one that explains itself.
     */
    actions: Partial<Record<TradeAction, () => void>>;
}

/**
 * Listen while trading is on. Returns the unsubscribe.
 *
 * Bound on the document rather than on the chart, because the hands are not necessarily on
 * the chart — the point of a flatten key is that it works wherever the pointer happens to be.
 */
export function installTradeHotkeys(opts: HotkeyOptions): () => void {
    const doc = opts.root.ownerDocument;
    const onKey = (event: KeyboardEvent): void => {
        if (event.defaultPrevented || isTyping(event.target)) return;
        const pressed = keyOf(event);
        if (!pressed) return;
        const bindings = opts.bindings();
        for (const { id } of TRADE_ACTIONS) {
            if (!sameKey(bindings[id], pressed)) continue;
            const run = opts.actions[id];
            if (!run) return;
            event.preventDefault();
            run();
            return;
        }
    };
    doc.addEventListener('keydown', onKey);
    return () => doc.removeEventListener('keydown', onKey);
}
