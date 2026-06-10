// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { applyCursorOp, type Cursor } from './cursor';

// The CURSOR message handler (index.ts) maps background-sequenced ops onto
// the cosmetic cursor via applyCursorOp — covered here with a stub cursor.

function stubCursor() {
  return {
    showAt: vi.fn<(x: number, y: number) => void>(),
    moveTo: vi.fn<(x: number, y: number) => Promise<void>>(async () => {}),
    click: vi.fn<() => Promise<void>>(async () => {}),
    press: vi.fn<() => void>(),
    release: vi.fn<() => void>(),
    hide: vi.fn<() => void>(),
    setGlow: vi.fn<(on: boolean) => void>(),
    getPos: vi.fn<() => { x: number; y: number }>(() => ({ x: 0, y: 0 })),
  } satisfies Cursor;
}

describe('applyCursorOp', () => {
  it("'move' animates to the given iframe-local coords", async () => {
    const cur = stubCursor();
    await applyCursorOp(cur, 'move', 120, 80);
    expect(cur.moveTo).toHaveBeenCalledExactlyOnceWith(120, 80);
    expect(cur.press).not.toHaveBeenCalled();
    expect(cur.release).not.toHaveBeenCalled();
    expect(cur.click).not.toHaveBeenCalled();
  });

  it("'move' without coordinates is a no-op (never teleports to NaN)", async () => {
    const cur = stubCursor();
    await applyCursorOp(cur, 'move');
    await applyCursorOp(cur, 'move', 50);
    expect(cur.moveTo).not.toHaveBeenCalled();
  });

  it("'press' / 'release' toggle the pressed visual", async () => {
    const cur = stubCursor();
    await applyCursorOp(cur, 'press');
    expect(cur.press).toHaveBeenCalledOnce();
    await applyCursorOp(cur, 'release');
    expect(cur.release).toHaveBeenCalledOnce();
    expect(cur.moveTo).not.toHaveBeenCalled();
    expect(cur.click).not.toHaveBeenCalled();
  });

  it("'click' plays the click animation", async () => {
    const cur = stubCursor();
    await applyCursorOp(cur, 'click');
    expect(cur.click).toHaveBeenCalledOnce();
    expect(cur.press).not.toHaveBeenCalled();
  });
});
