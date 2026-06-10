/**
 * Executes solver actions inside the hCaptcha challenge frame.
 *
 * Platform-pure: DOM only, no chrome.*. The caller (index.ts) supplies the
 * cursor, the speed factor (1.0 = human, 3.0 = fast) and optionally the
 * document (tests pass a jsdom document and a stub cursor).
 *
 * The dispatched event stream is shaped to avoid synthetic tells —
 * hCaptcha's risk engine is the consumer:
 *  - `buttons` is state-based (1 only while pressed), never type-derived
 *  - clicks are approached with an eased pointermove trail, never teleported
 *  - press→release has a physical dwell that is NOT scaled by solve speed
 *  - moves carry movementX/movementY deltas from the previous position
 *  - screen coordinates derive from client coords + window screen offset
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
  getPos(): Pt;
}

export type WaitFn = (ms: number) => Promise<void>;

export type ExecOpts = {
  /** Injected by tests to skip real waits. Defaults to setTimeout (ncWait). */
  wait?: WaitFn;
  /** Optional cancellation; exec bails (→ false) between steps when aborted. */
  signal?: AbortSignal;
};

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
 * Eased pointermove trail from `from` toward (x, y) — clicks and drags
 * approach their target instead of teleporting. All moves are unpressed.
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
function humanPause(speed: number, wait: WaitFn): Promise<void> {
  if (speed > 1) return Promise.resolve();
  return wait(60 + Math.random() * 80);
}

/** Cursor-animated, trail-approached click on an element's center. */
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

async function clickPoint(doc: Document, cursor: Cursor, x: number, y: number, wait: WaitFn): Promise<void> {
  const from = cursor.getPos();
  await cursor.moveTo(x, y);
  await emitTrail(doc, from, x, y, wait);
  await dispatchClick(doc, x, y, undefined, wait);
  await cursor.click();
}

async function clickVerifyIfPresent(doc: Document, cursor: Cursor, speed: number, wait: WaitFn): Promise<void> {
  const verify = findVerify(doc);
  if (!verify) return;
  await humanPause(speed, wait);
  await clickElement(doc, cursor, verify, wait);
}

/** Returns false only when aborted mid-drag. */
async function dragMove(
  doc: Document,
  cursor: Cursor,
  from: Pt,
  to: Pt,
  speed: number,
  wait: WaitFn,
  signal?: AbortSignal,
): Promise<boolean> {
  const origin = cursor.getPos();
  await cursor.moveTo(from.x, from.y);
  await emitTrail(doc, origin, from.x, from.y, wait);
  const startEl = targetAt(doc, from.x, from.y);
  if (!startEl) return true;

  cursor.press();
  firePointer(startEl, 'pointerover', from.x, from.y, false);
  fireMove(startEl, from.x, from.y, false);
  firePointer(startEl, 'pointerdown', from.x, from.y, true);
  fireMouse(startEl, 'mousedown', from.x, from.y, true);

  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = 14 + Math.floor(Math.random() * 5); // 14-18 intermediate moves
  const duration = Math.max(350, Math.min(1150, dist * 1.3)) / speed;
  const stepDelay = duration / steps;

  let aborted = false;
  for (let i = 1; i <= steps; i++) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    const e = ncEase(i / steps);
    const x = from.x + (to.x - from.x) * e;
    // Sin-wave vertical drift from the design, fading out at the endpoints.
    const drift = i === steps ? 0 : Math.sin(e * Math.PI) * -3;
    const y = from.y + (to.y - from.y) * e + drift;
    cursor.showAt(x, y);
    const el = targetAt(doc, x, y, startEl);
    if (el) fireMove(el, x, y, true);
    await wait(stepDelay);
  }

  // Always release — never leave the pointer stuck down, even when aborted.
  const releaseAt = aborted ? (lastPos ?? from) : to;
  const endEl = targetAt(doc, releaseAt.x, releaseAt.y, startEl);
  if (endEl) {
    firePointer(endEl, 'pointerup', releaseAt.x, releaseAt.y, false);
    fireMouse(endEl, 'mouseup', releaseAt.x, releaseAt.y, false);
  }
  lastPos = { x: releaseAt.x, y: releaseAt.y };
  cursor.release();
  return !aborted;
}

/**
 * Execute a solver action. Resolves true when all steps were dispatched
 * (best-effort: missing tiles are skipped, a missing verify button is fine);
 * false when the action could not be performed at all (e.g. refresh button
 * missing) or when `opts.signal` aborted it between steps.
 */
export async function exec(
  action: ExtAction,
  cursor: Cursor,
  speed: number,
  doc: Document = document,
  opts: ExecOpts = {},
): Promise<boolean> {
  const wait = opts.wait ?? ncWait;
  const aborted = (): boolean => opts.signal?.aborted === true;
  if (aborted()) return false;

  switch (action.action) {
    case 'click_tiles': {
      for (const n of action.tiles) {
        if (aborted()) return false;
        const tile = tileAt(doc, n);
        if (!tile) continue;
        await clickElement(doc, cursor, tile, wait);
        await humanPause(speed, wait);
      }
      if (aborted()) return false;
      await clickVerifyIfPresent(doc, cursor, speed, wait);
      return true;
    }
    case 'click_points': {
      for (const p of action.points) {
        if (aborted()) return false;
        const { x, y } = scalePoint(doc, p);
        await clickPoint(doc, cursor, x, y, wait);
        await humanPause(speed, wait);
      }
      if (aborted()) return false;
      await clickVerifyIfPresent(doc, cursor, speed, wait);
      return true;
    }
    case 'drag': {
      const moves = action.moves.length > 0 ? action.moves : [{ from: action.from, to: action.to }];
      for (const move of moves) {
        if (aborted()) return false;
        const ok = await dragMove(
          doc,
          cursor,
          scalePoint(doc, move.from),
          scalePoint(doc, move.to),
          speed,
          wait,
          opts.signal,
        );
        if (!ok) return false;
        await humanPause(speed, wait);
      }
      if (aborted()) return false;
      await clickVerifyIfPresent(doc, cursor, speed, wait);
      return true;
    }
    case 'refresh': {
      const refresh = findRefresh(doc);
      if (!refresh) return false;
      await clickElement(doc, cursor, refresh, wait);
      return true;
    }
    default:
      return assertNever(action);
  }
}
