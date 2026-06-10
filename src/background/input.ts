/**
 * Trusted-input driver: dispatches REAL mouse input over the Chrome DevTools
 * Protocol (`Input.dispatchMouseEvent` via chrome.debugger). Unlike content
 * script synthetics these events carry `isTrusted: true` and are hit-tested
 * by the browser like physical input, so they reach the cross-origin
 * hCaptcha challenge iframe's canvas (drag / point-on-canvas puzzles ignore
 * untrusted events — see docs/SOLVING-ARCHITECTURE.md).
 *
 * Coordinate space: TOP-FRAME viewport CSS pixels. This module performs no
 * conversion — callers convert iframe-local / normalized coordinates first
 * (helpers below). No devicePixelRatio math is involved.
 *
 * The driver is pure DI (testable with a fake transport); the only chrome.*
 * surface is `chromeDebuggerTransport` at the bottom, whose methods are
 * guarded so importing this module in unit tests never touches chrome.
 */

import type { Pt, RectLike } from '../shared/messages';

// ---------------------------------------------------------------------------
// Coordinate conversion (pure helpers — unit-tested directly).

/**
 * Vision coordinates are normalized 0-1000 relative to the cropped challenge
 * image, which is exactly the challenge iframe's rect → scale + offset.
 */
export function normalizedToTop(p: Pt, rect: RectLike): Pt {
  return {
    x: rect.x + (p.x / 1000) * rect.width,
    y: rect.y + (p.y / 1000) * rect.height,
  };
}

/**
 * Iframe-local CSS viewport coords (GET_GEOMETRY replies) → top-frame
 * viewport coords. Pure translation: the challenge iframe has no border and
 * is not internally scrolled (the same assumption the screenshot crop
 * already relies on).
 */
export function localToTop(p: Pt, rect: RectLike): Pt {
  return { x: rect.x + p.x, y: rect.y + p.y };
}

// ---------------------------------------------------------------------------
// The driver.

export interface CdpTransport {
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  send(tabId: number, method: string, params: object): Promise<void>;
}

export type InputDriverDeps = {
  now(): number;
  delay(ms: number): Promise<void>;
};

export type InputDriver = {
  /** Idempotent: a tab this driver already attached is not re-attached. */
  attach(tabId: number): Promise<void>;
  /** Best-effort + idempotent: transport errors are swallowed. */
  detach(tabId: number): Promise<void>;
  /** External detach observed (user dismissed the banner, tab closed). */
  markDetached(tabId: number): void;
  isAttached(tabId: number): boolean;
  /** Trusted click: approach moves → press → physical dwell → release. */
  click(tabId: number, x: number, y: number): Promise<void>;
  /** Trusted drag: press at `from` → eased held moves → release at `to`. */
  drag(tabId: number, from: Pt, to: Pt): Promise<void>;
};

/** Cubic ease in/out (same curve as the old in-frame executor). */
function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

type MouseEventType = 'mousePressed' | 'mouseReleased' | 'mouseMoved';

export function createInputDriver(cdp: CdpTransport, deps: InputDriverDeps): InputDriver {
  const attached = new Set<number>();
  /** Last dispatched position per tab — approach trails start from here. */
  const lastPos = new Map<number, Pt>();

  function mouse(
    tabId: number,
    type: MouseEventType,
    x: number,
    y: number,
    pressed: boolean,
  ): Promise<void> {
    const params: Record<string, unknown> = {
      type,
      x,
      y,
      button: 'left',
      // State-based bitmask, never type-derived: 1 only while the left
      // button is held (so mouseReleased itself carries 0, like a real
      // mouseup's `buttons`).
      buttons: pressed ? 1 : 0,
    };
    if (type !== 'mouseMoved') params['clickCount'] = 1;
    lastPos.set(tabId, { x, y });
    return cdp.send(tabId, 'Input.dispatchMouseEvent', params);
  }

  /**
   * Eased unpressed approach toward (x, y) — trusted input must not teleport
   * any more than the old synthetic stream did. Starts from the tab's last
   * dispatched position, or a small offset on the very first action.
   */
  async function approach(tabId: number, x: number, y: number): Promise<void> {
    const from = lastPos.get(tabId) ?? { x: x - 60 - Math.random() * 60, y: y - 40 - Math.random() * 40 };
    const dist = Math.hypot(x - from.x, y - from.y);
    if (dist < 2) return;
    const steps = 5 + Math.floor(Math.random() * 4); // 5-8 approach moves
    for (let i = 1; i <= steps; i++) {
      const e = ease(i / steps);
      await mouse(tabId, 'mouseMoved', from.x + (x - from.x) * e, from.y + (y - from.y) * e, false);
      await deps.delay(14);
    }
  }

  async function attach(tabId: number): Promise<void> {
    if (attached.has(tabId)) return;
    await cdp.attach(tabId); // failure (e.g. DevTools attached) propagates
    attached.add(tabId);
  }

  async function detach(tabId: number): Promise<void> {
    attached.delete(tabId);
    lastPos.delete(tabId);
    try {
      await cdp.detach(tabId);
    } catch {
      // Best-effort: already detached / tab gone — nothing to clean up.
    }
  }

  return {
    attach,
    detach,
    markDetached(tabId) {
      attached.delete(tabId);
      lastPos.delete(tabId);
    },
    isAttached: (tabId) => attached.has(tabId),

    async click(tabId, x, y) {
      await approach(tabId, x, y);
      await mouse(tabId, 'mousePressed', x, y, true);
      // Physical press dwell — deliberately NOT scaled by anything: a fast
      // solver still holds the button for ~40-100ms.
      await deps.delay(40 + Math.random() * 60);
      await mouse(tabId, 'mouseReleased', x, y, false);
    },

    async drag(tabId, from, to) {
      await approach(tabId, from.x, from.y);
      await mouse(tabId, 'mousePressed', from.x, from.y, true);
      await deps.delay(40 + Math.random() * 60);

      const dist = Math.hypot(to.x - from.x, to.y - from.y);
      const steps = 14 + Math.floor(Math.random() * 5); // 14-18 held moves
      const stepDelay = Math.max(350, Math.min(1150, dist * 1.3)) / steps;
      for (let i = 1; i <= steps; i++) {
        const e = ease(i / steps);
        const x = from.x + (to.x - from.x) * e;
        // Small sin-wave vertical drift, fading out at the endpoints.
        const driftY = i === steps ? 0 : Math.sin(e * Math.PI) * -3;
        const y = from.y + (to.y - from.y) * e + driftY;
        await mouse(tabId, 'mouseMoved', x, y, true);
        await deps.delay(stepDelay);
      }

      await mouse(tabId, 'mouseReleased', to.x, to.y, false);
    },
  };
}

// ---------------------------------------------------------------------------
// The real chrome.debugger transport. Guarded so unit tests can import this
// module without a chrome global; only index.ts ever calls these methods.

const CDP_VERSION = '1.3';

function requireChrome(): typeof chrome {
  if (typeof chrome === 'undefined' || !chrome.debugger) {
    throw new Error('chrome.debugger is not available in this context');
  }
  return chrome;
}

export const chromeDebuggerTransport: CdpTransport = {
  async attach(tabId) {
    try {
      await requireChrome().debugger.attach({ tabId }, CDP_VERSION);
    } catch (err) {
      // OUR earlier attach can outlive the service worker (the in-memory
      // driver state resets, the debugger session does not) — re-attaching
      // then races with ourselves; treat as attached. A FOREIGN client
      // (DevTools open) surfaces the same message, but its presence shows up
      // immediately as a failed sendCommand, which fails the action cleanly.
      if (/already attached/i.test(String(err))) return;
      throw err;
    }
  },
  async detach(tabId) {
    try {
      await requireChrome().debugger.detach({ tabId });
    } catch (err) {
      if (/not attached|no tab with given id|no target/i.test(String(err))) return;
      throw err;
    }
  },
  async send(tabId, method, params) {
    await requireChrome().debugger.sendCommand({ tabId }, method, params as Record<string, unknown>);
  },
};
