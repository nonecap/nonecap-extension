/**
 * Challenge-frame readiness state machine. Platform-pure (DOM + timers, no
 * chrome.*) and extracted from index.ts so the edge-trigger and the post-exec
 * re-arm probe are jsdom-testable.
 *
 * CHALLENGE_READY is EDGE-triggered: announce once per ready state, re-arm on
 * a not-ready observation. That alone stalls on SINGLE challenges — they swap
 * their image ATOMICALLY between rounds (no placeholder window, unlike grids),
 * so `armed` would stay false forever after the first EXEC. The post-exec
 * re-arm probe closes that gap: after an EXEC completes, wait out a floor
 * (hCaptcha's brief verifying overlay), then — on the floor timeout or any
 * later relevant mutation — if the challenge is still present AND ready, the
 * round did not conclude (atomic swap or rejected answer; both need another
 * recognize round, capped by the background's MAX_ROUNDS), so force re-arm.
 */

import { frameKind, gridReady, singleReady, taskHint } from './detect';

export type ChallengeController = {
  /** Poll/scheduled evaluation (the caller's 250ms loop + mutation ticks). */
  tick(): void;
  /** A relevant DOM mutation happened (resets the stability debounce). */
  onMutation(): void;
  /** An EXEC is starting: pause announcements, cancel any pending probe. */
  execStarted(): void;
  /** An EXEC finished: disarm, then start the re-arm probe (one per exec). */
  execFinished(): void;
  /** Challenge gone (CHALLENGE_GONE/pagehide): cancel probe, reset for next. */
  teardown(): void;
};

export type ChallengeControllerOpts = {
  doc: Document;
  sendReady: (task: 'grid' | 'single') => void;
  /** Stability debounce before announcing readiness. */
  stableMsGrid?: number;
  stableMsSingle?: number;
  /**
   * Post-exec probe floor. Must stay comfortably above hCaptcha's brief
   * verifying overlay so the probe never captures a mid-submit frame.
   */
  rearmFloorMs?: number;
};

export const REARM_FLOOR_MS = 2500;

export function createChallengeController(opts: ChallengeControllerOpts): ChallengeController {
  const { doc, sendReady } = opts;
  const stableMsGrid = opts.stableMsGrid ?? 300;
  const stableMsSingle = opts.stableMsSingle ?? 500;
  const rearmFloorMs = opts.rearmFloorMs ?? REARM_FLOOR_MS;

  /** May we announce the next ready state? Re-set by a not-ready observation. */
  let armed = true;
  let executing = false;
  let lastDomChangeAt = 0;

  // ---- post-exec re-arm probe (at most one, cancelled by teardown/exec) ----
  let probeActive = false;
  let probeFloorPassed = false;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelProbe(): void {
    probeActive = false;
    probeFloorPassed = false;
    if (probeTimer !== null) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
  }

  function startProbe(): void {
    cancelProbe(); // never stack probes
    probeActive = true;
    probeTimer = setTimeout(() => {
      probeTimer = null;
      probeFloorPassed = true;
      evaluateProbe();
    }, rearmFloorMs);
  }

  /** Current round readiness, or null when absent/not ready. */
  function roundReady(): 'grid' | 'single' | null {
    if (frameKind(doc) !== 'challenge') return null;
    const hint = taskHint(doc);
    const ready = hint === 'grid' ? gridReady(doc) : singleReady(doc);
    return ready ? hint : null;
  }

  function evaluateProbe(): void {
    if (!probeActive || executing) return;
    // Not ready right now (e.g. overlay still up): stay active — any later
    // relevant mutation re-evaluates until teardown or the next exec.
    if (roundReady() === null) return;
    // Still present and ready after the floor: the round did not conclude.
    cancelProbe();
    armed = true;
    tick(); // the stability debounce inside still applies
  }

  function tick(): void {
    if (executing) return;
    const ready = roundReady();
    if (ready === null) {
      // Passing through not-ready re-arms the ready edge (the normal path,
      // e.g. a grid's next-round placeholders). The probe is additive to this.
      armed = true;
      return;
    }
    if (!armed) return;
    const stableMs = ready === 'single' ? stableMsSingle : stableMsGrid;
    if (Date.now() - lastDomChangeAt < stableMs) return; // mid-swap: wait for the DOM to settle
    armed = false;
    cancelProbe(); // this round is announced; the probe must not re-fire it
    sendReady(ready);
  }

  return {
    tick,
    onMutation(): void {
      lastDomChangeAt = Date.now();
      // Before the floor this is likely the verifying overlay — ignore it and
      // rely on the floor timeout. After the floor, re-evaluate immediately.
      if (probeActive && probeFloorPassed) evaluateProbe();
    },
    execStarted(): void {
      executing = true;
      cancelProbe();
    },
    execFinished(): void {
      executing = false;
      // Invalidate the previous ready state: the next CHALLENGE_READY fires
      // via not-ready→ready (grids) or via the probe (atomic single swaps).
      armed = false;
      lastDomChangeAt = Date.now();
      startProbe();
    },
    teardown(): void {
      cancelProbe();
      armed = true;
      lastDomChangeAt = 0;
    },
  };
}
