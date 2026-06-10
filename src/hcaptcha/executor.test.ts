// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec, type Cursor } from './executor';

// jsdom has no elementFromPoint; the executor falls back to the provided
// element (tiles/buttons) or document.body — events still bubble to document.

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

function setViewport(w: number, h: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
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

/** 3 loaded tiles (centers at (145,95), (245,95), (345,95)) + verify at (400,420). */
function buildGrid(): void {
  document.body.innerHTML = `
    <div class="challenge-container">
      <div class="task-image"><div class="image" style="background: url('https://t/1.jpg')"></div></div>
      <div class="task-image"><div class="image" style="background: url('https://t/2.jpg')"></div></div>
      <div class="task-image"><div class="image" style="background: url('https://t/3.jpg')"></div></div>
      <button class="button-submit">Verify</button>
    </div>`;
  const tiles = document.querySelectorAll('.task-image');
  tiles.forEach((tile, i) => mockRect(tile, 100 + i * 100, 50, 90, 90));
  mockRect(document.querySelector('.button-submit')!, 350, 400, 100, 40);
}

beforeEach(() => {
  abort = new AbortController();
  document.body.innerHTML = '';
});

afterEach(() => {
  abort.abort();
});

describe('click_tiles', () => {
  it('approaches and clicks each tile center in order, then verify', async () => {
    buildGrid();
    const events = recordEvents();
    const { cursor, moves } = stubCursor();

    const done = await exec({ action: 'click_tiles', tiles: [2, 1] }, cursor, 3, document, { wait: noWait });

    expect(done).toBe(true);
    // tile 2 center, tile 1 center, then verify center — in the given order
    const centers = [
      { x: 245, y: 95 },
      { x: 145, y: 95 },
      { x: 400, y: 420 },
    ];
    expect(moves).toEqual(centers);

    const downs = ofType(events, 'pointerdown');
    const ups = ofType(events, 'pointerup');
    const clicks = ofType(events, 'click');
    expect(downs).toHaveLength(3);
    expect(ups).toHaveLength(3);
    expect(clicks).toHaveLength(3);
    centers.forEach((c, i) => {
      expectNear(downs[i], c.x, c.y);
      expectNear(ups[i], c.x, c.y);
      expectNear(clicks[i], c.x, c.y);
    });

    // press-state-based buttons: down = 1, up/click = 0
    for (const e of downs) expect(e.buttons).toBe(1);
    for (const e of [...ups, ...clicks]) expect(e.buttons).toBe(0);
    for (const e of ofType(events, 'mousedown')) expect(e.buttons).toBe(1);
    for (const e of ofType(events, 'mouseup')) expect(e.buttons).toBe(0);

    // ordering per click: over < down < mousedown < up < mouseup < click
    const overIdx = indicesOf(events, 'pointerover');
    const downIdx = indicesOf(events, 'pointerdown');
    const mdIdx = indicesOf(events, 'mousedown');
    const upIdx = indicesOf(events, 'pointerup');
    const muIdx = indicesOf(events, 'mouseup');
    const clickIdx = indicesOf(events, 'click');
    for (let k = 0; k < 3; k++) {
      expect(overIdx[k]!).toBeLessThan(downIdx[k]!);
      expect(downIdx[k]!).toBeLessThan(mdIdx[k]!);
      expect(mdIdx[k]!).toBeLessThan(upIdx[k]!);
      expect(upIdx[k]!).toBeLessThan(muIdx[k]!);
      expect(muIdx[k]!).toBeLessThan(clickIdx[k]!);
    }

    // approach trail: ≥1 unpressed pointermove before each pointerover
    // (≥5 before the first — the full eased trail from the cursor origin)
    const firstTrail = events.slice(0, overIdx[0]).filter((e) => e.type === 'pointermove');
    expect(firstTrail.length).toBeGreaterThanOrEqual(5);
    for (const e of firstTrail) expect(e.buttons).toBe(0);
    for (let k = 1; k < 3; k++) {
      const between = events.slice(clickIdx[k - 1]! + 1, overIdx[k]).filter((e) => e.type === 'pointermove');
      expect(between.length).toBeGreaterThanOrEqual(1);
      for (const e of between) expect(e.buttons).toBe(0);
    }
  });

  it('skips missing tiles and still verifies', async () => {
    buildGrid();
    const events = recordEvents();
    const { cursor } = stubCursor();

    const done = await exec({ action: 'click_tiles', tiles: [1, 99] }, cursor, 3, document, { wait: noWait });

    expect(done).toBe(true);
    const clicks = ofType(events, 'click');
    expect(clicks).toHaveLength(2);
    expectNear(clicks[0], 145, 95);
    expectNear(clicks[1], 400, 420);
  });

  it('with an empty tiles array only the verify button is clicked', async () => {
    buildGrid();
    const events = recordEvents();
    const { cursor } = stubCursor();

    const done = await exec({ action: 'click_tiles', tiles: [] }, cursor, 3, document, { wait: noWait });

    expect(done).toBe(true);
    expect(ofType(events, 'pointerdown')).toHaveLength(1);
    const clicks = ofType(events, 'click');
    expect(clicks).toHaveLength(1);
    expectNear(clicks[0], 400, 420);
  });

  it('bails out (done=false, no events) when the signal is already aborted', async () => {
    buildGrid();
    const events = recordEvents();
    const { cursor } = stubCursor();
    const controller = new AbortController();
    controller.abort();

    const done = await exec({ action: 'click_tiles', tiles: [1, 2] }, cursor, 3, document, {
      wait: noWait,
      signal: controller.signal,
    });

    expect(done).toBe(false);
    expect(events).toHaveLength(0);
  });
});

describe('click_points', () => {
  it('scales 0-1000 normalized points to the viewport and clicks each', async () => {
    setViewport(800, 500);
    document.body.innerHTML = '<div class="challenge"></div>';
    const events = recordEvents();
    const { cursor, moves } = stubCursor();

    const done = await exec(
      {
        action: 'click_points',
        points: [
          { x: 500, y: 250 },
          { x: 1000, y: 1000 },
        ],
      },
      cursor,
      3,
      document,
      { wait: noWait },
    );

    expect(done).toBe(true);
    expect(moves).toEqual([
      { x: 400, y: 125 },
      { x: 800, y: 500 },
    ]);
    const clicks = ofType(events, 'click');
    expect(clicks).toHaveLength(2);
    expectNear(clicks[0], 400, 125);
    expectNear(clicks[1], 800, 500);

    // each click is approached with an unpressed pointermove trail
    const overIdx = indicesOf(events, 'pointerover');
    const beforeFirst = events.slice(0, overIdx[0]).filter((e) => e.type === 'pointermove');
    expect(beforeFirst.length).toBeGreaterThanOrEqual(1);
    for (const e of beforeFirst) expect(e.buttons).toBe(0);
  });

  it('clicks verify afterwards when present', async () => {
    setViewport(1000, 1000);
    document.body.innerHTML = '<div class="challenge"><button class="button-submit">Verify</button></div>';
    mockRect(document.querySelector('.button-submit')!, 350, 400, 100, 40);
    const events = recordEvents();
    const { cursor } = stubCursor();

    await exec({ action: 'click_points', points: [{ x: 100, y: 100 }] }, cursor, 3, document, { wait: noWait });

    const clicks = ofType(events, 'click');
    expect(clicks).toHaveLength(2);
    expectNear(clicks[0], 100, 100);
    expectNear(clicks[1], 400, 420);
  });
});

describe('drag', () => {
  it('presses, emits ≥14 monotonic pressed pointermoves toward the target, releases at it', async () => {
    setViewport(1000, 1000);
    document.body.innerHTML = '<div class="challenge"><canvas width="500"></canvas></div>';
    const events = recordEvents();
    const { cursor } = stubCursor();

    const done = await exec(
      { action: 'drag', from: { x: 100, y: 500 }, to: { x: 900, y: 500 }, moves: [] },
      cursor,
      10,
      document,
      { wait: noWait },
    );

    expect(done).toBe(true);
    const downIdx = events.findIndex((e) => e.type === 'pointerdown');
    expect(downIdx).toBeGreaterThan(-1);
    expectNear(events[downIdx], 100, 500);
    expect(events[downIdx]?.buttons).toBe(1);
    expect(events[downIdx + 1]?.type).toBe('mousedown');
    expect(events[downIdx + 1]?.buttons).toBe(1);

    // approach trail before grabbing the handle is unpressed
    const preDownMoves = events.slice(0, downIdx).filter((e) => e.type === 'pointermove');
    expect(preDownMoves.length).toBeGreaterThanOrEqual(1);
    for (const e of preDownMoves) expect(e.buttons).toBe(0);

    const upIdxAll = indicesOf(events, 'pointerup');
    expect(upIdxAll).toHaveLength(1);
    const upIdx = upIdxAll[0]!;
    const dragMoves = events.slice(downIdx + 2, upIdx).filter((e) => e.type === 'pointermove');
    expect(dragMoves.length).toBeGreaterThanOrEqual(14);
    // pressed while dragging, monotonic progress toward the target
    let prev = 100;
    for (const m of dragMoves) {
      expect(m.buttons).toBe(1);
      expect(m.x).toBeGreaterThanOrEqual(prev);
      expect(m.x).toBeLessThanOrEqual(900);
      prev = m.x;
    }
    expectNear(dragMoves.at(-1), 900, 500);

    expectNear(events[upIdx], 900, 500);
    expect(events[upIdx]?.buttons).toBe(0);
    expect(events.at(-1)?.type).toBe('mouseup');
    expectNear(events.at(-1), 900, 500);
    expect(events.at(-1)?.buttons).toBe(0);
  });

  it('performs each move in the moves array (one press/release per move)', async () => {
    setViewport(1000, 1000);
    document.body.innerHTML = '<div class="challenge"></div>';
    const events = recordEvents();
    const { cursor } = stubCursor();

    const done = await exec(
      {
        action: 'drag',
        from: { x: 0, y: 0 },
        to: { x: 0, y: 0 },
        moves: [
          { from: { x: 100, y: 100 }, to: { x: 300, y: 100 } },
          { from: { x: 300, y: 100 }, to: { x: 300, y: 400 } },
        ],
      },
      cursor,
      10,
      document,
      { wait: noWait },
    );

    expect(done).toBe(true);
    expect(ofType(events, 'pointerdown')).toHaveLength(2);
    const ups = ofType(events, 'pointerup');
    expect(ups).toHaveLength(2);
    expectNear(ups.at(-1), 300, 400);
  });
});

describe('refresh', () => {
  it('returns false when the refresh button is missing', async () => {
    document.body.innerHTML = '<div class="challenge"></div>';
    const { cursor } = stubCursor();
    expect(await exec({ action: 'refresh' }, cursor, 3, document, { wait: noWait })).toBe(false);
  });

  it('clicks the refresh button when present', async () => {
    document.body.innerHTML = '<div class="challenge"><div class="refresh button"></div></div>';
    mockRect(document.querySelector('.refresh')!, 10, 10, 30, 30);
    const events = recordEvents();
    const { cursor } = stubCursor();

    expect(await exec({ action: 'refresh' }, cursor, 3, document, { wait: noWait })).toBe(true);
    const clicks = ofType(events, 'click');
    expect(clicks).toHaveLength(1);
    expectNear(clicks[0], 25, 25);
  });
});

describe('press dwell', () => {
  it('holds the press for real time: pointerup.timeStamp > pointerdown.timeStamp', async () => {
    document.body.innerHTML = '<div class="challenge"><div class="refresh button"></div></div>';
    mockRect(document.querySelector('.refresh')!, 10, 10, 30, 30);
    const events = recordEvents();
    const { cursor } = stubCursor();

    // default wait (real timers): dwell is 40-100ms and NOT scaled by speed
    expect(await exec({ action: 'refresh' }, cursor, 3, document)).toBe(true);

    const down = events.find((e) => e.type === 'pointerdown');
    const up = events.find((e) => e.type === 'pointerup');
    expect(down).toBeDefined();
    expect(up).toBeDefined();
    expect(up!.t).toBeGreaterThan(down!.t);
    expect(up!.t - down!.t).toBeGreaterThanOrEqual(30);
  });
});
