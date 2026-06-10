import { describe, expect, it } from 'vitest';
import { maxActionGapMs } from './input';
import { REARM_FLOOR_MS } from '../hcaptcha/challenge-state';

/**
 * Cross-side timing tripwire.
 *
 * The challenge frame re-arms for the next round on a REARM_FLOOR_MS probe
 * floor that is pushed forward by EVERY CURSOR / GET_GEOMETRY message the
 * background sends during an action (see ../hcaptcha/challenge-state and the
 * coupling comments in ./index). If the background ever goes silent for close
 * to REARM_FLOOR_MS mid-action — the worst case being the drag bracket, where
 * approach + press dwell + the full held-drag run between the CURSOR 'press'
 * and the CURSOR 'move' — the frame spuriously re-announces, cancelling the
 * live round and burning a recognize on a mid-drag screenshot.
 *
 * maxActionGapMs() bounds that silent gap from the background side. This test
 * fails CI if anyone raises the drag cap or the jitter factor past the budget,
 * so the two sides can't drift apart silently. The 500ms margin is deliberate
 * headroom (event-loop scheduling, message-pipe latency, future tweaks).
 */
describe('action timing vs. challenge-frame re-arm floor', () => {
  const SAFETY_MARGIN_MS = 500;

  it('keeps the worst-case silent action gap safely under the re-arm floor', () => {
    expect(maxActionGapMs()).toBeLessThan(REARM_FLOOR_MS);
    expect(REARM_FLOOR_MS - maxActionGapMs()).toBeGreaterThanOrEqual(SAFETY_MARGIN_MS);
  });
});
