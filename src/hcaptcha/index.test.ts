// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Geometry, Msg } from '../shared/messages';
import { installChromeMock, type ChromeMock } from '../shared/test/chrome-mock';

/**
 * Wiring tests for the challenge-frame content script: GET_GEOMETRY replies,
 * CURSOR ops onto the (stubbed) cosmetic cursor, the post-action re-arm
 * probe trigger, the new-round cursor self-reset, and CHALLENGE_GONE.
 *
 * The script installs module-level listeners on import, so this file runs
 * ONE import against ONE jsdom document and walks a challenge lifecycle in
 * order (tests build on the previous one's state, like the real frame).
 */

// Stub the AnimatedCursor class but keep applyCursorOp real — index.ts
// routes CURSOR ops through it onto the cursor instance.
const cursorStub = vi.hoisted(() => ({
  showAt: vi.fn(),
  moveTo: vi.fn(async () => {}),
  click: vi.fn(async () => {}),
  press: vi.fn(),
  release: vi.fn(),
  hide: vi.fn(),
  setGlow: vi.fn(),
  getPos: vi.fn(() => ({ x: 0, y: 0 })),
  destroy: vi.fn(),
  speed: 1,
}));

vi.mock('./cursor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cursor')>();
  return {
    ...actual,
    AnimatedCursor: vi.fn(function AnimatedCursorStub() {
      return cursorStub;
    }),
  };
});

type Listener = (
  msg: Msg,
  sender: unknown,
  sendResponse: (reply: unknown) => void,
) => boolean | undefined;

let chromeMock: ChromeMock;
let listener: Listener | undefined;
const sent: Msg[] = [];

function readyCount(): number {
  return sent.filter((m) => m.t === 'CHALLENGE_READY').length;
}

function challengeHtml(): string {
  let html = '<div class="challenge-container">';
  for (let i = 1; i <= 9; i++) {
    html += `<div class="task-image"><div class="image" style="background: url('https://t/${i}.jpg')"></div></div>`;
  }
  return html + '<button class="button-submit">Verify</button><div class="refresh button"></div></div>';
}

/**
 * The content script installs a MutationObserver + a poll interval it never
 * tears down (the real frame just unloads). Track them so afterAll can stop
 * them — a callback firing after vitest swaps the jsdom environment crashes
 * on missing globals.
 */
const moduleTeardowns: (() => void)[] = [];

beforeAll(async () => {
  chromeMock = installChromeMock();

  const RealObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = class extends RealObserver {
    constructor(cb: MutationCallback) {
      super(cb);
      moduleTeardowns.push(() => this.disconnect());
    }
  };
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    const id = realSetInterval(fn, ms);
    moduleTeardowns.push(() => clearInterval(id));
    return id;
  }) as typeof globalThis.setInterval;
  // chrome-mock only covers storage — add the runtime surface index.ts uses.
  (globalThis.chrome as unknown as Record<string, unknown>)['runtime'] = {
    sendMessage: (msg: Msg, _cb?: unknown) => {
      sent.push(msg);
    },
    onMessage: {
      addListener: (fn: Listener) => {
        listener = fn;
      },
    },
    lastError: undefined,
  };

  document.body.innerHTML = challengeHtml();
  await import('./index');
});

afterAll(async () => {
  for (const teardown of moduleTeardowns) teardown();
  // Drain any already-queued observer callback / scheduleTick timeout inside
  // the live jsdom env.
  await new Promise((resolve) => setTimeout(resolve, 80));
  chromeMock.uninstall();
});

describe('challenge frame lifecycle', () => {
  it('announces CHALLENGE_READY for the initial round on load and registered a message listener', () => {
    expect(sent).toContainEqual({ t: 'CHALLENGE_READY', task: 'grid' });
    expect(listener).toBeDefined();
  });

  it('GET_GEOMETRY replies synchronously with the live geometry', () => {
    const reply = vi.fn();
    const ret = listener!({ t: 'GET_GEOMETRY' }, {}, reply);

    expect(ret).toBeUndefined(); // sync reply — channel not kept open
    expect(reply).toHaveBeenCalledOnce();
    const geo = reply.mock.calls[0]![0] as Geometry;
    expect(geo).not.toBeNull();
    expect(geo.tiles).toHaveLength(9); // 1-based reading order, index 0 = tile 1
    expect(geo.verify).toEqual({ center: { x: 0, y: 0 }, isSkip: false }); // jsdom rects are 0×0
    expect(geo.refresh).toEqual({ x: 0, y: 0 });
  });

  it('answering GET_GEOMETRY arms the post-action re-arm probe (replaces the EXEC finally-block trigger)', () => {
    vi.useFakeTimers();
    try {
      const before = readyCount();
      listener!({ t: 'GET_GEOMETRY' }, {}, vi.fn());
      // Nothing re-announces inside the probe floor…
      vi.advanceTimersByTime(1000);
      expect(readyCount()).toBe(before);
      // …but once the floor passes with the round still present and ready
      // (atomic swap / rejected answer), the round is re-announced.
      vi.advanceTimersByTime(1600);
      expect(readyCount()).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('CURSOR ops drive the cosmetic cursor (fire-and-forget, iframe-local coords)', async () => {
    expect(listener!({ t: 'CURSOR', op: 'move', x: 120, y: 80 }, {}, vi.fn())).toBeUndefined();
    listener!({ t: 'CURSOR', op: 'press' }, {}, vi.fn());
    listener!({ t: 'CURSOR', op: 'release' }, {}, vi.fn());
    listener!({ t: 'CURSOR', op: 'click' }, {}, vi.fn());

    // Ops are serialized behind async settings reads — wait for the last one.
    await vi.waitFor(() => expect(cursorStub.click).toHaveBeenCalledOnce());
    expect(cursorStub.moveTo).toHaveBeenCalledExactlyOnceWith(120, 80);
    expect(cursorStub.press).toHaveBeenCalledOnce();
    expect(cursorStub.release).toHaveBeenCalledOnce();
  });

  it('a new-round re-announce resets the cursor: release + hide (no stuck press)', () => {
    cursorStub.release.mockClear();
    cursorStub.hide.mockClear();
    vi.useFakeTimers();
    try {
      const before = readyCount();
      listener!({ t: 'GET_GEOMETRY' }, {}, vi.fn()); // background acts again
      vi.advanceTimersByTime(2600); // probe floor → re-announce
      expect(readyCount()).toBe(before + 1);
      expect(cursorStub.release).toHaveBeenCalled();
      expect(cursorStub.hide).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('CHALLENGE_GONE (pagehide) destroys the cursor and reports gone', () => {
    window.dispatchEvent(new Event('pagehide'));
    expect(cursorStub.destroy).toHaveBeenCalledOnce();
    expect(sent).toContainEqual({ t: 'CHALLENGE_GONE' });
  });

  it('GET_GEOMETRY replies null from non-challenge (anchor) frames', () => {
    document.body.innerHTML = '<div id="anchor"><div id="checkbox"></div></div>';
    const reply = vi.fn();
    listener!({ t: 'GET_GEOMETRY' }, {}, reply);
    expect(reply).toHaveBeenCalledExactlyOnceWith(null);
  });
});
