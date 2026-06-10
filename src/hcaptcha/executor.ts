/**
 * Executes solver actions inside the hCaptcha challenge frame.
 *
 * Platform-pure: DOM only, no chrome.*. The caller (index.ts) supplies the
 * cursor, the speed factor (1.0 = human, 3.0 = fast) and optionally the
 * document (tests pass a jsdom document and a stub cursor).
 */

import type { ExtAction, Pt } from '../shared/messages';
import { assertNever } from '../shared/messages';
import { findRefresh, findVerify, tileAt } from './detect';
import { ncEase, ncWait } from './tween';

/**
 * What the executor needs from the animated cursor. The concrete
 * implementation lives in cursor.ts; tests pass a no-op stub.
 */
export interface Cursor {
  showAt(x: number, y: number): void;
  moveTo(x: number, y: number): Promise<void>;
  click(): Promise<void>;
  press(): void;
  release(): void;
  hide(): void;
  setGlow(on: boolean): void;
}

/**
 * Construct with `view: window`; some test environments (vitest's jsdom
 * globals) fail the WebIDL Window brand check — retry without `view` there.
 */
function buildEvent<I extends MouseEventInit>(
  Ctor: new (type: string, init?: I) => MouseEvent,
  type: string,
  init: I,
  view: Window | null,
): MouseEvent {
  try {
    return new Ctor(type, { ...init, view } as I);
  } catch {
    return new Ctor(type, init);
  }
}

function firePointer(el: Element, type: string, x: number, y: number): void {
  const init: PointerEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    isPrimary: true,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    button: 0,
    buttons: type === 'pointerup' || type === 'mouseup' ? 0 : 1,
  };
  // jsdom builds without PointerEvent still get a coordinate-correct event.
  const Ctor = typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent;
  el.dispatchEvent(buildEvent(Ctor, type, init, el.ownerDocument.defaultView));
}

function fireMouse(el: Element, type: string, x: number, y: number): void {
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    button: 0,
    buttons: type === 'mouseup' || type === 'click' ? 0 : 1,
  };
  el.dispatchEvent(buildEvent(MouseEvent, type, init, el.ownerDocument.defaultView));
}

/** Element under (x, y), with a fallback for environments without layout. */
function targetAt(doc: Document, x: number, y: number, fallback?: Element | null): Element | null {
  let el: Element | null = null;
  try {
    if (typeof doc.elementFromPoint === 'function') el = doc.elementFromPoint(x, y);
  } catch {
    el = null;
  }
  return el ?? fallback ?? doc.body ?? null;
}

/**
 * Full synthetic click sequence at (x, y):
 * pointerover, pointermove, pointerdown, mousedown, pointerup, mouseup, click.
 * (pointerenter does not bubble — skipped.)
 */
export function dispatchClick(doc: Document, x: number, y: number, fallback?: Element | null): boolean {
  const el = targetAt(doc, x, y, fallback);
  if (!el) return false;
  firePointer(el, 'pointerover', x, y);
  firePointer(el, 'pointermove', x, y);
  firePointer(el, 'pointerdown', x, y);
  fireMouse(el, 'mousedown', x, y);
  firePointer(el, 'pointerup', x, y);
  fireMouse(el, 'mouseup', x, y);
  fireMouse(el, 'click', x, y);
  return true;
}

function centerOf(el: Element): Pt {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Scale a 0-1000 normalized point to this frame's viewport. */
function scalePoint(doc: Document, p: Pt): Pt {
  const view = doc.defaultView;
  const w = view?.innerWidth ?? 0;
  const h = view?.innerHeight ?? 0;
  return { x: (p.x / 1000) * w, y: (p.y / 1000) * h };
}

/** Small human-ish pause between actions; none in fast mode. */
function humanPause(speed: number): Promise<void> {
  if (speed > 1) return Promise.resolve();
  return ncWait(60 + Math.random() * 80);
}

async function clickElement(doc: Document, cursor: Cursor, el: Element): Promise<void> {
  const c = centerOf(el);
  await cursor.moveTo(c.x, c.y);
  dispatchClick(doc, c.x, c.y, el);
  await cursor.click();
}

async function clickVerifyIfPresent(doc: Document, cursor: Cursor, speed: number): Promise<void> {
  const verify = findVerify(doc);
  if (!verify) return;
  await humanPause(speed);
  await clickElement(doc, cursor, verify);
}

async function dragMove(doc: Document, cursor: Cursor, from: Pt, to: Pt, speed: number): Promise<void> {
  await cursor.moveTo(from.x, from.y);
  const startEl = targetAt(doc, from.x, from.y);
  if (!startEl) return;

  cursor.press();
  firePointer(startEl, 'pointerover', from.x, from.y);
  firePointer(startEl, 'pointermove', from.x, from.y);
  firePointer(startEl, 'pointerdown', from.x, from.y);
  fireMouse(startEl, 'mousedown', from.x, from.y);

  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = 14 + Math.floor(Math.random() * 5); // 14-18 intermediate moves
  const duration = Math.max(350, Math.min(1150, dist * 1.3)) / speed;
  const stepDelay = duration / steps;

  for (let i = 1; i <= steps; i++) {
    const e = ncEase(i / steps);
    const x = from.x + (to.x - from.x) * e;
    // Sin-wave vertical drift from the design, fading out at the endpoints.
    const drift = i === steps ? 0 : Math.sin(e * Math.PI) * -3;
    const y = from.y + (to.y - from.y) * e + drift;
    cursor.showAt(x, y);
    const el = targetAt(doc, x, y, startEl);
    if (el) {
      firePointer(el, 'pointermove', x, y);
      fireMouse(el, 'mousemove', x, y);
    }
    await ncWait(stepDelay);
  }

  const endEl = targetAt(doc, to.x, to.y, startEl);
  if (endEl) {
    firePointer(endEl, 'pointerup', to.x, to.y);
    fireMouse(endEl, 'mouseup', to.x, to.y);
  }
  cursor.release();
}

/**
 * Execute a solver action. Resolves true when all steps were dispatched
 * (best-effort: missing tiles are skipped, a missing verify button is fine);
 * false only when the action could not be performed at all (e.g. refresh
 * button missing).
 */
export async function exec(
  action: ExtAction,
  cursor: Cursor,
  speed: number,
  doc: Document = document,
): Promise<boolean> {
  switch (action.action) {
    case 'click_tiles': {
      for (const n of action.tiles) {
        const tile = tileAt(doc, n);
        if (!tile) continue;
        await clickElement(doc, cursor, tile);
        await humanPause(speed);
      }
      await clickVerifyIfPresent(doc, cursor, speed);
      return true;
    }
    case 'click_points': {
      for (const p of action.points) {
        const { x, y } = scalePoint(doc, p);
        await cursor.moveTo(x, y);
        dispatchClick(doc, x, y);
        await cursor.click();
        await humanPause(speed);
      }
      await clickVerifyIfPresent(doc, cursor, speed);
      return true;
    }
    case 'drag': {
      const moves = action.moves.length > 0 ? action.moves : [{ from: action.from, to: action.to }];
      for (const move of moves) {
        await dragMove(doc, cursor, scalePoint(doc, move.from), scalePoint(doc, move.to), speed);
        await humanPause(speed);
      }
      await clickVerifyIfPresent(doc, cursor, speed);
      return true;
    }
    case 'refresh': {
      const refresh = findRefresh(doc);
      if (!refresh) return false;
      await clickElement(doc, cursor, refresh);
      return true;
    }
    default:
      return assertNever(action);
  }
}
