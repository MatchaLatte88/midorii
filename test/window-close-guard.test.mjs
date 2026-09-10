import { describe, expect, it, vi } from 'vitest';
import { approveWindowClose, guardWindowClose } from '../app/electron/windowCloseGuard.js';

class FakeWindow {
  handlers = new Map();
  closeCalls = 0;
  destroyed = false;
  webContents = {
    isDestroyed: () => false,
    send: vi.fn(),
  };

  on(event, handler) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  close() {
    this.closeCalls += 1;
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    for (const handler of this.handlers.get('close') ?? []) handler(event);
    if (!event.prevented) {
      this.destroyed = true;
      for (const handler of this.handlers.get('closed') ?? []) handler();
    }
  }

  isDestroyed() {
    return this.destroyed;
  }
}

describe('the renderer shutdown handshake', () => {
  it('holds the first close and releases it after the renderer is ready', () => {
    const win = new FakeWindow();
    guardWindowClose(win);

    win.close();

    expect(win.destroyed).toBe(false);
    expect(win.webContents.send).toHaveBeenCalledOnce();
    expect(win.webContents.send).toHaveBeenCalledWith('window:close-requested');

    approveWindowClose(win);

    expect(win.closeCalls).toBe(2);
    expect(win.destroyed).toBe(true);
  });

  it('releases the window after the fallback timeout if the renderer never answers', async () => {
    vi.useFakeTimers();
    try {
      const win = new FakeWindow();
      guardWindowClose(win, 25);

      win.close();
      await vi.advanceTimersByTimeAsync(25);

      expect(win.closeCalls).toBe(2);
      expect(win.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
