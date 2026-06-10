/**
 * Synthetic in-frame click — used ONLY for the anchor frame's "I am human"
 * checkbox. The checkbox click stays synthetic by design (it passes today;
 * docs/SOLVING-ARCHITECTURE.md): all challenge input is dispatched by the
 * background as trusted CDP events, never from a content script.
 *
 * Platform-pure: DOM only, no chrome.*. The caller (index.ts) supplies the
 * cursor and optionally the document (tests pass jsdom + a stub cursor).
 *
 * The dispatched event stream is shaped to avoid synthetic tells —
 * hCaptcha's risk engine is the consumer:
 *  - `buttons` is state-based (1 only while pressed), never type-derived
 *  - the click is approached with an eased pointermove trail, never teleported
 *  - press→release has a physical dwell that is NOT scaled by solve speed
 *  - moves carry movementX/movementY deltas from the previous position
 *  - screen coordinates derive from client coords + window screen offset
 */

import type { Pt } from '../shared/messages';
import type { Cursor } from './cursor';
import { centerOf } from './detect';
import { ncEase, ncWait } from './tween';

export type WaitFn = (ms: number) => Promise<void>;

/** Fallback vertical offset between client and screen coords (~toolbar). */
const SCREEN_Y_OFFSET = 80;

/** Last dispatched pointer position — source of movementX/movementY deltas. */
let lastPos: Pt | null = null;

function screenCoords(el: Element, x: number, y: number): { sx: number; sy: number } {
  const view = el.ownerDocument.defaultView;
  return {
    sx: x + (view?.screenX || 0),
    sy: y + (view?.screenY || 0) + SCREEN_Y_OFFSET,
  };
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

function firePointer(
  el: Element,
  type: string,
  x: number,
  y: number,
  pressed: boolean,
  movement?: Pt,
): void {
  const { sx, sy } = screenCoords(el, x, y);
  const init: PointerEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    isPrimary: true,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: x,
    clientY: y,
    screenX: sx,
    screenY: sy,
    button: 0,
    buttons: pressed ? 1 : 0,
    movementX: movement?.x ?? 0,
    movementY: movement?.y ?? 0,
  };
  // jsdom builds without PointerEvent still get a coordinate-correct event.
  const Ctor = typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent;
  el.dispatchEvent(buildEvent(Ctor, type, init, el.ownerDocument.defaultView));
}

function fireMouse(
  el: Element,
  type: string,
  x: number,
  y: number,
  pressed: boolean,
  movement?: Pt,
): void {
  const { sx, sy } = screenCoords(el, x, y);
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    screenX: sx,
    screenY: sy,
    button: 0,
    buttons: pressed ? 1 : 0,
    movementX: movement?.x ?? 0,
    movementY: movement?.y ?? 0,
  };
  el.dispatchEvent(buildEvent(MouseEvent, type, init, el.ownerDocument.defaultView));
}

/** pointermove + mousemove pair with movement deltas from the previous point. */
function fireMove(el: Element, x: number, y: number, pressed: boolean): void {
  const movement: Pt = lastPos ? { x: x - lastPos.x, y: y - lastPos.y } : { x: 0, y: 0 };
  firePointer(el, 'pointermove', x, y, pressed, movement);
  fireMouse(el, 'mousemove', x, y, pressed, movement);
  lastPos = { x, y };
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
 * Eased pointermove trail from `from` toward (x, y) — the click approaches
 * its target instead of teleporting. All moves are unpressed.
 */
async function emitTrail(doc: Document, from: Pt, x: number, y: number, wait: WaitFn): Promise<void> {
  const dist = Math.hypot(x - from.x, y - from.y);
  if (dist < 2) return;
  const steps = 5 + Math.floor(Math.random() * 4); // 5-8 approach moves
  for (let i = 1; i <= steps; i++) {
    const e = ncEase(i / steps);
    const px = from.x + (x - from.x) * e;
    const py = from.y + (y - from.y) * e;
    const el = targetAt(doc, px, py);
    if (el) fireMove(el, px, py, false);
    await wait(14);
  }
}

/**
 * Full synthetic click sequence at (x, y):
 * pointerover, pointermove/mousemove, pointerdown, mousedown,
 * (physical press dwell), pointerup, mouseup, click.
 * (pointerenter does not bubble — skipped.)
 *
 * The dwell is deliberately NOT scaled by solve speed: a fast solver still
 * physically presses for ~40-100ms, and distinct down/up timeStamps matter.
 */
export async function dispatchClick(
  doc: Document,
  x: number,
  y: number,
  fallback?: Element | null,
  wait: WaitFn = ncWait,
): Promise<boolean> {
  const el = targetAt(doc, x, y, fallback);
  if (!el) return false;
  firePointer(el, 'pointerover', x, y, false);
  fireMove(el, x, y, false);
  firePointer(el, 'pointerdown', x, y, true);
  fireMouse(el, 'mousedown', x, y, true);
  await wait(40 + Math.random() * 60);
  firePointer(el, 'pointerup', x, y, false);
  fireMouse(el, 'mouseup', x, y, false);
  fireMouse(el, 'click', x, y, false);
  lastPos = { x, y };
  return true;
}

/** Cursor-animated, trail-approached synthetic click on an element's center. */
export async function clickElement(
  doc: Document,
  cursor: Cursor,
  el: Element,
  wait: WaitFn = ncWait,
): Promise<boolean> {
  const c = centerOf(el);
  const from = cursor.getPos();
  await cursor.moveTo(c.x, c.y);
  await emitTrail(doc, from, c.x, c.y, wait);
  const ok = await dispatchClick(doc, c.x, c.y, el, wait);
  await cursor.click();
  return ok;
}
