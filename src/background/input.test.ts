import { describe, expect, it } from 'vitest';
import {
  createInputDriver,
  localToTop,
  normalizedToTop,
  type CdpTransport,
} from './input';

type Sent = {
  tabId: number;
  method: string;
  params: {
    type: string;
    x: number;
    y: number;
    button: string;
    buttons: number;
    clickCount?: number;
  };
};

function makeHarness(opts: { attachError?: Error; detachError?: Error } = {}) {
  const sends: Sent[] = [];
  const attaches: number[] = [];
  const detaches: number[] = [];
  const delays: number[] = [];

  const cdp: CdpTransport = {
    async attach(tabId) {
      if (opts.attachError) throw opts.attachError;
      attaches.push(tabId);
    },
    async detach(tabId) {
      detaches.push(tabId);
      if (opts.detachError) throw opts.detachError;
    },
    async send(tabId, method, params) {
      sends.push({ tabId, method, params } as Sent);
    },
  };

  const driver = createInputDriver(cdp, {
    now: () => 0,
    delay: async (ms) => {
      delays.push(ms);
    },
  });

  return { driver, sends, attaches, detaches, delays };
}

describe('coordinate conversion', () => {
  const rect = { x: 100, y: 50, width: 400, height: 300 };

  it('normalizedToTop scales a 0-1000 vision point into the rect', () => {
    expect(normalizedToTop({ x: 500, y: 500 }, rect)).toEqual({ x: 300, y: 200 });
    expect(normalizedToTop({ x: 0, y: 0 }, rect)).toEqual({ x: 100, y: 50 });
    expect(normalizedToTop({ x: 1000, y: 1000 }, rect)).toEqual({ x: 500, y: 350 });
  });

  it('localToTop offsets an iframe-local point by the rect origin', () => {
    expect(localToTop({ x: 10, y: 20 }, rect)).toEqual({ x: 110, y: 70 });
    expect(localToTop({ x: 0, y: 0 }, rect)).toEqual({ x: 100, y: 50 });
  });
});

describe('createInputDriver', () => {
  it('click: approach moves → press → dwell → release, all trusted-left at the exact coords', async () => {
    const h = makeHarness();
    await h.driver.click(1, 123, 456);

    expect(h.sends.length).toBeGreaterThan(2);
    expect(h.sends.every((s) => s.method === 'Input.dispatchMouseEvent')).toBe(true);
    expect(h.sends.every((s) => s.tabId === 1)).toBe(true);
    expect(h.sends.every((s) => s.params.button === 'left')).toBe(true);

    const types = h.sends.map((s) => s.params.type);
    const pressIdx = types.indexOf('mousePressed');
    const releaseIdx = types.indexOf('mouseReleased');

    // A few approach moves first (unpressed), then press, then release.
    expect(pressIdx).toBeGreaterThan(0);
    expect(releaseIdx).toBe(h.sends.length - 1);
    expect(types.slice(0, pressIdx).every((t) => t === 'mouseMoved')).toBe(true);
    expect(types.slice(0, pressIdx).length).toBeGreaterThanOrEqual(5);
    for (const move of h.sends.slice(0, pressIdx)) expect(move.params.buttons).toBe(0);

    // Coordinates pass through untouched — conversion is the caller's job.
    const press = h.sends[pressIdx]!.params;
    expect(press).toMatchObject({ x: 123, y: 456, buttons: 1, clickCount: 1 });
    const release = h.sends[releaseIdx]!.params;
    expect(release).toMatchObject({ x: 123, y: 456, buttons: 0, clickCount: 1 });
    // The approach trail eases exactly onto the target before the press.
    expect(h.sends[pressIdx - 1]!.params).toMatchObject({ x: 123, y: 456 });

    // Physical press dwell between press and release: 40-100ms.
    const dwell = h.delays.at(-1)!;
    expect(dwell).toBeGreaterThanOrEqual(40);
    expect(dwell).toBeLessThanOrEqual(100);
  });

  it('drag: press at from → 14-18 held eased moves monotonic toward the target → release at to', async () => {
    const h = makeHarness();
    const from = { x: 10, y: 20 };
    const to = { x: 200, y: 150 };
    await h.driver.drag(1, from, to);

    const types = h.sends.map((s) => s.params.type);
    const pressIdx = types.indexOf('mousePressed');
    const releaseIdx = types.indexOf('mouseReleased');
    expect(releaseIdx).toBe(h.sends.length - 1);

    const press = h.sends[pressIdx]!.params;
    expect(press).toMatchObject({ x: 10, y: 20, buttons: 1, clickCount: 1 });

    // Held moves between press and release: buttons:1, 14-18 of them,
    // x strictly progressing toward the target and landing on it.
    const held = h.sends.slice(pressIdx + 1, releaseIdx);
    expect(held.length).toBeGreaterThanOrEqual(14);
    expect(held.length).toBeLessThanOrEqual(18);
    expect(held.every((s) => s.params.type === 'mouseMoved')).toBe(true);
    expect(held.every((s) => s.params.buttons === 1)).toBe(true);
    let prevX = from.x;
    for (const move of held) {
      expect(move.params.x).toBeGreaterThanOrEqual(prevX);
      expect(move.params.x).toBeLessThanOrEqual(to.x);
      prevX = move.params.x;
    }
    expect(held.at(-1)!.params).toMatchObject({ x: 200, y: 150 });

    const release = h.sends[releaseIdx]!.params;
    expect(release).toMatchObject({ x: 200, y: 150, buttons: 0, clickCount: 1 });
  });

  it('attach is idempotent per tab; detach is best-effort and swallows transport errors', async () => {
    const h = makeHarness({ detachError: new Error('Debugger is not attached') });

    await h.driver.attach(7);
    await h.driver.attach(7);
    expect(h.attaches).toEqual([7]); // second attach is a no-op
    expect(h.driver.isAttached(7)).toBe(true);

    await expect(h.driver.detach(7)).resolves.toBeUndefined(); // error swallowed
    expect(h.detaches).toEqual([7]);
    expect(h.driver.isAttached(7)).toBe(false);
    await expect(h.driver.detach(7)).resolves.toBeUndefined(); // idempotent
  });

  it('attach failure (another CDP client) propagates and leaves the tab unattached', async () => {
    const h = makeHarness({ attachError: new Error('Another debugger is already attached') });
    await expect(h.driver.attach(3)).rejects.toThrow('already attached');
    expect(h.driver.isAttached(3)).toBe(false);
  });

  it('markDetached resets driver state so the next attach re-attaches', async () => {
    const h = makeHarness();
    await h.driver.attach(5);
    h.driver.markDetached(5); // user dismissed the infobar
    expect(h.driver.isAttached(5)).toBe(false);
    await h.driver.attach(5);
    expect(h.attaches).toEqual([5, 5]);
  });
});
