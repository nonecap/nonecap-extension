// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec, type Cursor } from './executor';

// jsdom has no elementFromPoint; the executor falls back to the provided
// element (tiles/buttons) or document.body — events still bubble to document.

const EVENT_TYPES = [
  'pointerover',
  'pointermove',
  'pointerdown',
  'mousedown',
  'pointermove',
  'mousemove',
  'pointerup',
  'mouseup',
  'click',
] as const;

const CLICK_SEQUENCE = ['pointerover', 'pointermove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];

type Recorded = { type: string; x: number; y: number };

let abort: AbortController;

function recordEvents(): Recorded[] {
  const events: Recorded[] = [];
  for (const type of new Set(EVENT_TYPES)) {
    document.addEventListener(
      type,
      (e) => {
        const me = e as MouseEvent;
        events.push({ type: e.type, x: me.clientX, y: me.clientY });
      },
      { capture: true, signal: abort.signal },
    );
  }
  return events;
}

function stubCursor(): { cursor: Cursor; moves: { x: number; y: number }[] } {
  const moves: { x: number; y: number }[] = [];
  const cursor: Cursor = {
    showAt: () => {},
    moveTo: async (x, y) => {
      moves.push({ x, y });
    },
    click: async () => {},
    press: () => {},
    release: () => {},
    hide: () => {},
    setGlow: () => {},
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
  it('fires the full pointer sequence in order at each tile center, then verify', async () => {
    buildGrid();
    const events = recordEvents();
    const { cursor, moves } = stubCursor();

    const done = await exec({ action: 'click_tiles', tiles: [2, 1] }, cursor, 3);

    expect(done).toBe(true);
    expect(events.map((e) => e.type)).toEqual([...CLICK_SEQUENCE, ...CLICK_SEQUENCE, ...CLICK_SEQUENCE]);
    // tile 2 center, tile 1 center, then verify center — in the given order
    const centers = [
      { x: 245, y: 95 },
      { x: 145, y: 95 },
      { x: 400, y: 420 },
    ];
    centers.forEach((c, i) => {
      for (const e of events.slice(i * 7, i * 7 + 7)) {
        expect({ x: e.x, y: e.y }).toEqual(c);
      }
    });
    expect(moves).toEqual(centers);
  });

  it('skips missing tiles and still verifies', async () => {
    buildGrid();
    const events = recordEvents();
    const { cursor } = stubCursor();

    const done = await exec({ action: 'click_tiles', tiles: [1, 99] }, cursor, 3);

    expect(done).toBe(true);
    const clicks = events.filter((e) => e.type === 'click');
    expect(clicks).toEqual([
      { type: 'click', x: 145, y: 95 },
      { type: 'click', x: 400, y: 420 },
    ]);
  });

  it('with an empty tiles array only the verify button is clicked', async () => {
    buildGrid();
    const events = recordEvents();
    const { cursor } = stubCursor();

    const done = await exec({ action: 'click_tiles', tiles: [] }, cursor, 3);

    expect(done).toBe(true);
    expect(events.map((e) => e.type)).toEqual(CLICK_SEQUENCE);
    expect(events.filter((e) => e.type === 'click')).toEqual([{ type: 'click', x: 400, y: 420 }]);
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
    );

    expect(done).toBe(true);
    expect(moves).toEqual([
      { x: 400, y: 125 },
      { x: 800, y: 500 },
    ]);
    expect(events.filter((e) => e.type === 'click')).toEqual([
      { type: 'click', x: 400, y: 125 },
      { type: 'click', x: 800, y: 500 },
    ]);
  });

  it('clicks verify afterwards when present', async () => {
    setViewport(1000, 1000);
    document.body.innerHTML = '<div class="challenge"><button class="button-submit">Verify</button></div>';
    mockRect(document.querySelector('.button-submit')!, 350, 400, 100, 40);
    const events = recordEvents();
    const { cursor } = stubCursor();

    await exec({ action: 'click_points', points: [{ x: 100, y: 100 }] }, cursor, 3);

    const clicks = events.filter((e) => e.type === 'click');
    expect(clicks).toEqual([
      { type: 'click', x: 100, y: 100 },
      { type: 'click', x: 400, y: 420 },
    ]);
  });
});

describe('drag', () => {
  it('presses, emits ≥14 monotonic pointermoves toward the target, releases at it', async () => {
    setViewport(1000, 1000);
    document.body.innerHTML = '<div class="challenge"><canvas width="500"></canvas></div>';
    const events = recordEvents();
    const { cursor } = stubCursor();

    const done = await exec(
      { action: 'drag', from: { x: 100, y: 500 }, to: { x: 900, y: 500 }, moves: [] },
      cursor,
      10,
    );

    expect(done).toBe(true);
    const downIdx = events.findIndex((e) => e.type === 'pointerdown');
    expect(downIdx).toBeGreaterThan(-1);
    expect(events[downIdx]).toEqual({ type: 'pointerdown', x: 100, y: 500 });
    expect(events[downIdx + 1]?.type).toBe('mousedown');

    const after = events.slice(downIdx + 2);
    const pointerMoves = after.filter((e) => e.type === 'pointermove');
    expect(pointerMoves.length).toBeGreaterThanOrEqual(14);
    // monotonic progress toward the target on the drag axis
    let prev = 100;
    for (const m of pointerMoves) {
      expect(m.x).toBeGreaterThanOrEqual(prev);
      expect(m.x).toBeLessThanOrEqual(900);
      prev = m.x;
    }
    expect(pointerMoves.at(-1)).toEqual({ type: 'pointermove', x: 900, y: 500 });

    const up = after.filter((e) => e.type === 'pointerup');
    expect(up).toEqual([{ type: 'pointerup', x: 900, y: 500 }]);
    expect(after.at(-1)?.type).toBe('mouseup');
    expect(after.at(-1)).toMatchObject({ x: 900, y: 500 });
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
    );

    expect(done).toBe(true);
    expect(events.filter((e) => e.type === 'pointerdown')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'pointerup')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'pointerup').at(-1)).toMatchObject({ x: 300, y: 400 });
  });
});

describe('refresh', () => {
  it('returns false when the refresh button is missing', async () => {
    document.body.innerHTML = '<div class="challenge"></div>';
    const { cursor } = stubCursor();
    expect(await exec({ action: 'refresh' }, cursor, 3)).toBe(false);
  });

  it('clicks the refresh button when present', async () => {
    document.body.innerHTML = '<div class="challenge"><div class="refresh button"></div></div>';
    mockRect(document.querySelector('.refresh')!, 10, 10, 30, 30);
    const events = recordEvents();
    const { cursor } = stubCursor();

    expect(await exec({ action: 'refresh' }, cursor, 3)).toBe(true);
    expect(events.filter((e) => e.type === 'click')).toEqual([{ type: 'click', x: 25, y: 25 }]);
  });
});
