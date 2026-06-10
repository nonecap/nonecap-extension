// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Cursor } from './cursor';
import { clickElement } from './synthetic-click';

// The synthetic click survives Phase 2 ONLY for the anchor frame's checkbox —
// all challenge input is trusted CDP from the background. These tests cover
// the checkbox path: a realism-shaped event stream on the clicked element.

// jsdom has no elementFromPoint; the helper falls back to the provided
// element (the checkbox) or document.body — events still bubble to document.

const EVENT_TYPES = [
  'pointerover',
  'pointermove',
  'mousemove',
  'pointerdown',
  'mousedown',
  'pointerup',
  'mouseup',
  'click',
] as const;

type Recorded = { type: string; x: number; y: number; buttons: number; t: number };

/** Test wait stub: no real timers, keeps the suite fast. */
const noWait = async (): Promise<void> => {};

let abort: AbortController;

function recordEvents(): Recorded[] {
  const events: Recorded[] = [];
  for (const type of EVENT_TYPES) {
    document.addEventListener(
      type,
      (e) => {
        const me = e as MouseEvent;
        events.push({ type: e.type, x: me.clientX, y: me.clientY, buttons: me.buttons, t: e.timeStamp });
      },
      { capture: true, signal: abort.signal },
    );
  }
  return events;
}

function stubCursor(): { cursor: Cursor; moves: { x: number; y: number }[] } {
  const moves: { x: number; y: number }[] = [];
  let pos = { x: 0, y: 0 };
  const cursor: Cursor = {
    showAt: (x, y) => {
      pos = { x, y };
    },
    moveTo: async (x, y) => {
      moves.push({ x, y });
      pos = { x, y };
    },
    click: async () => {},
    press: () => {},
    release: () => {},
    hide: () => {},
    setGlow: () => {},
    getPos: () => ({ ...pos }),
  };
  return { cursor, moves };
}

function mockRect(el: Element, x: number, y: number, w: number, h: number): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect;
}

function expectNear(e: { x: number; y: number } | undefined, x: number, y: number): void {
  expect(e).toBeDefined();
  expect(Math.abs(e!.x - x)).toBeLessThanOrEqual(2);
  expect(Math.abs(e!.y - y)).toBeLessThanOrEqual(2);
}

function indicesOf(events: Recorded[], type: string): number[] {
  return events.flatMap((e, i) => (e.type === type ? [i] : []));
}

function ofType(events: Recorded[], type: string): Recorded[] {
  return events.filter((e) => e.type === type);
}

/** Anchor-frame DOM: the "I am human" checkbox, centre at (60, 40). */
function buildCheckbox(): Element {
  document.body.innerHTML = '<div id="anchor"><div id="checkbox" role="checkbox"></div></div>';
  const checkbox = document.querySelector('#checkbox')!;
  mockRect(checkbox, 40, 25, 40, 30);
  return checkbox;
}

beforeEach(() => {
  abort = new AbortController();
  document.body.innerHTML = '';
});

afterEach(() => {
  abort.abort();
});

describe('clickElement (checkbox synthetic click)', () => {
  it('approaches the checkbox centre with an unpressed trail, then runs the full click sequence', async () => {
    const checkbox = buildCheckbox();
    const events = recordEvents();
    const { cursor, moves } = stubCursor();

    const ok = await clickElement(document, cursor, checkbox, noWait);

    expect(ok).toBe(true);
    expect(moves).toEqual([{ x: 60, y: 40 }]); // cosmetic cursor travels to the centre

    // one full click at the centre
    const downs = ofType(events, 'pointerdown');
    const ups = ofType(events, 'pointerup');
    const clicks = ofType(events, 'click');
    expect(downs).toHaveLength(1);
    expect(ups).toHaveLength(1);
    expect(clicks).toHaveLength(1);
    expectNear(downs[0], 60, 40);
    expectNear(ups[0], 60, 40);
    expectNear(clicks[0], 60, 40);

    // press-state-based buttons: down = 1, up/click = 0
    for (const e of downs) expect(e.buttons).toBe(1);
    for (const e of [...ups, ...clicks]) expect(e.buttons).toBe(0);
    for (const e of ofType(events, 'mousedown')) expect(e.buttons).toBe(1);
    for (const e of ofType(events, 'mouseup')) expect(e.buttons).toBe(0);

    // ordering: over < down < mousedown < up < mouseup < click
    const overIdx = indicesOf(events, 'pointerover')[0]!;
    const downIdx = indicesOf(events, 'pointerdown')[0]!;
    const mdIdx = indicesOf(events, 'mousedown')[0]!;
    const upIdx = indicesOf(events, 'pointerup')[0]!;
    const muIdx = indicesOf(events, 'mouseup')[0]!;
    const clickIdx = indicesOf(events, 'click')[0]!;
    expect(overIdx).toBeLessThan(downIdx);
    expect(downIdx).toBeLessThan(mdIdx);
    expect(mdIdx).toBeLessThan(upIdx);
    expect(upIdx).toBeLessThan(muIdx);
    expect(muIdx).toBeLessThan(clickIdx);

    // approach trail: ≥5 unpressed eased pointermoves before pointerover
    // (never teleported to the target)
    const trail = events.slice(0, overIdx).filter((e) => e.type === 'pointermove');
    expect(trail.length).toBeGreaterThanOrEqual(5);
    for (const e of trail) expect(e.buttons).toBe(0);
  });

  it('holds the press for real time: pointerup.timeStamp > pointerdown.timeStamp', async () => {
    const checkbox = buildCheckbox();
    const events = recordEvents();
    const { cursor } = stubCursor();

    // default wait (real timers): dwell is 40-100ms and NOT scaled by speed
    expect(await clickElement(document, cursor, checkbox)).toBe(true);

    const down = events.find((e) => e.type === 'pointerdown');
    const up = events.find((e) => e.type === 'pointerup');
    expect(down).toBeDefined();
    expect(up).toBeDefined();
    expect(up!.t).toBeGreaterThan(down!.t);
    expect(up!.t - down!.t).toBeGreaterThanOrEqual(30);
  });
});
