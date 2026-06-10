/**
 * Animation math shared by the cursor and the executor.
 * Ported from the design reference (solver.jsx). No chrome.*, DOM-only
 * (requestAnimationFrame / setTimeout).
 */

/** Cubic ease in/out. */
export function ncEase(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export type TweenFn = (
  duration: number,
  onUpdate: (eased: number, progress: number) => void,
) => Promise<void>;

/** requestAnimationFrame tween driving `onUpdate(eased, rawProgress)`. */
export const ncTween: TweenFn = (duration, onUpdate) =>
  new Promise((resolve) => {
    const t0 = performance.now();
    function frame(now: number): void {
      const p = duration > 0 ? Math.min(1, (now - t0) / duration) : 1;
      onUpdate(ncEase(p), p);
      if (p < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });

export const ncWait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Cursor travel duration for a move of `dist` px at the given speed factor. */
export function moveDuration(dist: number, speed: number): number {
  return Math.max(260, Math.min(850, dist * 1.15)) / speed;
}
