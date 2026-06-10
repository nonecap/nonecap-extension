import { describe, expect, it } from 'vitest';
import { computeCropRect } from './crop';

describe('computeCropRect', () => {
  it('passes a simple rect through at dpr 1', () => {
    const r = computeCropRect({ x: 10, y: 20, width: 100, height: 50 }, 1);
    expect(r).toEqual({ sx: 10, sy: 20, sw: 100, sh: 50, scale: 1, outW: 100, outH: 50 });
  });

  it('rounds fractional device pixels at dpr 1.25 without drifting the far edge', () => {
    const r = computeCropRect({ x: 10, y: 20, width: 100, height: 60 }, 1.25);
    // left 12.5→13, right 137.5→138, top 25, bottom 100
    expect(r.sx).toBe(13);
    expect(r.sy).toBe(25);
    expect(r.sw).toBe(125);
    expect(r.sh).toBe(75);
    expect(r.scale).toBe(1);
    expect(r.outW).toBe(125);
    expect(r.outH).toBe(75);
  });

  it('scales the rect by dpr 2 with fractional CSS coordinates', () => {
    const r = computeCropRect({ x: 5.3, y: 7.8, width: 50.4, height: 30.2 }, 2);
    // left 10.6→11, right 111.4→111, top 15.6→16, bottom 76
    expect(r).toEqual({ sx: 11, sy: 16, sw: 100, sh: 60, scale: 1, outW: 100, outH: 60 });
  });

  it('clamps negative origins to zero and trims the size', () => {
    const r = computeCropRect({ x: -10, y: -20, width: 100, height: 100 }, 1);
    expect(r.sx).toBe(0);
    expect(r.sy).toBe(0);
    expect(r.sw).toBe(90); // right edge at 90, origin clamped to 0
    expect(r.sh).toBe(80);
  });

  it('clamps negative origins in device px (dpr 2)', () => {
    const r = computeCropRect({ x: -5, y: 0, width: 50, height: 50 }, 2);
    expect(r.sx).toBe(0);
    expect(r.sw).toBe(90); // right edge 45*2=90
    expect(r.sh).toBe(100);
  });

  it('caps a 2000px-wide rect at 1024 (scale 0.512)', () => {
    const r = computeCropRect({ x: 0, y: 0, width: 2000, height: 1000 }, 1);
    expect(r.scale).toBeCloseTo(0.512, 10);
    expect(r.outW).toBe(1024);
    expect(r.outH).toBe(512);
  });

  it('caps on the LONG side even when that is the height', () => {
    const r = computeCropRect({ x: 0, y: 0, width: 500, height: 2048 }, 1);
    expect(r.scale).toBe(0.5);
    expect(r.outW).toBe(250);
    expect(r.outH).toBe(1024);
  });

  it('applies the cap to device pixels, not CSS pixels', () => {
    const r = computeCropRect({ x: 0, y: 0, width: 1000, height: 400 }, 2);
    expect(r.sw).toBe(2000);
    expect(r.scale).toBeCloseTo(0.512, 10);
    expect(r.outW).toBe(1024);
    expect(r.outH).toBe(410); // 800 * 0.512 = 409.6 → 410
  });

  it('never upscales: a tiny rect keeps scale 1', () => {
    const r = computeCropRect({ x: 3, y: 4, width: 10, height: 12 }, 1);
    expect(r).toEqual({ sx: 3, sy: 4, sw: 10, sh: 12, scale: 1, outW: 10, outH: 12 });
  });

  it('respects a custom capW', () => {
    const r = computeCropRect({ x: 0, y: 0, width: 400, height: 200 }, 1, 100);
    expect(r.scale).toBe(0.25);
    expect(r.outW).toBe(100);
    expect(r.outH).toBe(50);
  });

  it('handles a degenerate zero-size rect without dividing by zero', () => {
    const r = computeCropRect({ x: 10, y: 10, width: 0, height: 0 }, 1);
    expect(r.sw).toBe(0);
    expect(r.sh).toBe(0);
    expect(r.scale).toBe(1);
  });
});
