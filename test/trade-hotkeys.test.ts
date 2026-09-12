// Keys on a trading screen.
//
// The assertions that matter are the ones about NOT firing: a screen full of number boxes, and
// a key that flattens a position. Everything else here is bookkeeping.
//
// The suite runs in the node env like the rest of them, so the document and the key events are
// MINIMAL stubs — enough for the matching and the guards, which is all this module touches.
import { describe, it, expect, vi } from 'vitest';
import {
    DEFAULT_HOTKEYS, formatHotkey, installTradeHotkeys, isTyping, keyOf, normalizeHotkeys, sameKey,
} from '../app/renderer/trading/hotkeys';
import type { Hotkey, TradeAction } from '../app/renderer/trading/hotkeys';

/** Something a press can have landed on. `closest` answers only what the guard asks about. */
const target = (over: { tagName?: string; isContentEditable?: boolean; inDialog?: boolean } = {}) => ({
    tagName: over.tagName ?? 'DIV',
    isContentEditable: over.isContentEditable ?? false,
    closest: (selector: string) => (over.inDialog && selector.includes('dialog') ? {} : null),
});

const PLAIN = target();

/** A keydown, as the listener reads one. */
function press(
    key: string,
    mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey', boolean>> = {},
    on: unknown = PLAIN,
): KeyboardEvent {
    const event = {
        key,
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        ...mods,
        target: on,
        defaultPrevented: false,
        preventDefault(): void { (event as { defaultPrevented: boolean }).defaultPrevented = true; },
    };
    return event as unknown as KeyboardEvent;
}

/** A document that only remembers who is listening for a keydown. */
function harness(actions: Partial<Record<TradeAction, () => void>>, bindings = DEFAULT_HOTKEYS) {
    const listeners = new Set<(event: KeyboardEvent) => void>();
    const doc = {
        addEventListener: (_type: string, fn: (event: KeyboardEvent) => void) => { listeners.add(fn); },
        removeEventListener: (_type: string, fn: (event: KeyboardEvent) => void) => { listeners.delete(fn); },
    };
    const root = { ownerDocument: doc } as unknown as HTMLElement;
    const off = installTradeHotkeys({ root, bindings: () => bindings, actions });
    return {
        fire: (event: KeyboardEvent) => { for (const fn of [...listeners]) fn(event); },
        done: () => off(),
        listening: () => listeners.size,
    };
}

describe('reading a key press', () => {
    it('is nothing for a modifier on its own', () => {
        expect(keyOf(press('Shift', { shiftKey: true }))).toBeNull();
    });

    it('lowercases a letter so the binding does not depend on the shift state twice', () => {
        expect(keyOf(press('B', { shiftKey: true }))).toEqual({ key: 'b', shift: true, ctrl: false, alt: false });
    });

    it('treats the command key as control — one binding on either machine', () => {
        expect(keyOf(press('b', { metaKey: true }))?.ctrl).toBe(true);
    });

    it('writes a binding the way it is pressed', () => {
        expect(formatHotkey({ key: 'f', shift: true, ctrl: false, alt: false })).toBe('Shift+F');
        expect(formatHotkey({ key: 'Escape', shift: false, ctrl: true, alt: true })).toBe('Ctrl+Alt+Escape');
        expect(formatHotkey(null)).toBe('None');
    });

    it('matches on every modifier, not just on the key', () => {
        const bound: Hotkey = { key: 'f', shift: true, ctrl: false, alt: false };
        expect(sameKey(bound, keyOf(press('F', { shiftKey: true })))).toBe(true);
        expect(sameKey(bound, keyOf(press('f')))).toBe(false);
        expect(sameKey(bound, keyOf(press('F', { shiftKey: true, ctrlKey: true })))).toBe(false);
    });
});

describe('where a press must be ignored', () => {
    it('knows the places a person is writing', () => {
        expect(isTyping(target({ tagName: 'INPUT' }) as unknown as EventTarget)).toBe(true);
        expect(isTyping(target({ tagName: 'TEXTAREA' }) as unknown as EventTarget)).toBe(true);
        expect(isTyping(target({ isContentEditable: true }) as unknown as EventTarget)).toBe(true);
        expect(isTyping(PLAIN as unknown as EventTarget)).toBe(false);
        expect(isTyping(null)).toBe(false);
    });

    it('does not flatten a position while a stop is being typed', () => {
        const flatten = vi.fn();
        const h = harness({ flatten });
        h.fire(press('F', { shiftKey: true }, target({ tagName: 'INPUT' })));
        expect(flatten).not.toHaveBeenCalled();
        h.done();
    });

    it('stays out of an open dialog', () => {
        const flatten = vi.fn();
        const h = harness({ flatten });
        h.fire(press('F', { shiftKey: true }, target({ tagName: 'BUTTON', inDialog: true })));
        expect(flatten).not.toHaveBeenCalled();
        h.done();
    });

    it('leaves a press something else has already handled alone', () => {
        const flatten = vi.fn();
        const h = harness({ flatten });
        const event = press('F', { shiftKey: true });
        event.preventDefault();
        h.fire(event);
        expect(flatten).not.toHaveBeenCalled();
        h.done();
    });
});

describe('running an action', () => {
    it('fires the one the key is bound to, and only that one', () => {
        const flatten = vi.fn();
        const cancelAll = vi.fn();
        const h = harness({ flatten, cancelAll });
        h.fire(press('F', { shiftKey: true }));
        expect(flatten).toHaveBeenCalledTimes(1);
        expect(cancelAll).not.toHaveBeenCalled();
        h.done();
    });

    it('takes the press, so nothing else also acts on it', () => {
        const h = harness({ flatten: vi.fn() });
        const event = press('F', { shiftKey: true });
        h.fire(event);
        expect(event.defaultPrevented).toBe(true);
        h.done();
    });

    it('does nothing for an action this venue does not offer', () => {
        // Capital.com has no break-even gesture, so that key is simply not bound there.
        const h = harness({ flatten: vi.fn() });
        const event = press('E', { shiftKey: true });
        h.fire(event);
        expect(event.defaultPrevented).toBe(false);
        h.done();
    });

    it('reads the bindings fresh, so a rebinding needs no remount', () => {
        const flatten = vi.fn();
        const bindings = { ...DEFAULT_HOTKEYS };
        const listeners = new Set<(event: KeyboardEvent) => void>();
        const doc = {
            addEventListener: (_t: string, fn: (e: KeyboardEvent) => void) => { listeners.add(fn); },
            removeEventListener: (_t: string, fn: (e: KeyboardEvent) => void) => { listeners.delete(fn); },
        };
        const off = installTradeHotkeys({
            root: { ownerDocument: doc } as unknown as HTMLElement,
            bindings: () => bindings,
            actions: { flatten },
        });
        bindings.flatten = { key: 'q', shift: false, ctrl: true, alt: false };
        for (const fn of listeners) fn(press('q', { ctrlKey: true }));
        expect(flatten).toHaveBeenCalledTimes(1);
        off();
    });

    it('stops listening when trading is switched off', () => {
        const h = harness({ flatten: vi.fn() });
        expect(h.listening()).toBe(1);
        h.done();
        expect(h.listening()).toBe(0);
    });
});

describe('what is stored', () => {
    it('falls back to the default for anything unusable', () => {
        expect(normalizeHotkeys({ flatten: { key: '' } }).flatten).toEqual(DEFAULT_HOTKEYS.flatten);
        expect(normalizeHotkeys(null).buy).toEqual(DEFAULT_HOTKEYS.buy);
    });

    it('keeps a binding somebody deliberately cleared', () => {
        // Null is a choice; missing is not. Falling back would hand the key back unasked.
        expect(normalizeHotkeys({ flatten: null }).flatten).toBeNull();
    });

    it('gives every action a binding out of the box, all of them behind a modifier', () => {
        for (const binding of Object.values(DEFAULT_HOTKEYS)) {
            expect(binding).not.toBeNull();
            expect(binding!.shift || binding!.ctrl || binding!.alt).toBe(true);
        }
    });
});
