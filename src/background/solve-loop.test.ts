import { describe, expect, it, vi } from 'vitest';
import type { Phase } from '../shared/messages';
import type { ApiErrorKind } from '../shared/api';
import {
  CAPTURE_RETRIES,
  CAPTURE_SPACING_MS,
  MAX_ROUNDS,
  ROUND_STALL_MS,
  TRANSIENT_RETRY_MS,
  createSolveLoop,
  type LoopDeps,
  type RecognizeResult,
} from './solve-loop';

type PhaseEvent = { tabId: number; phase: Phase; detail?: { secs?: string; credits?: number } };
type OutcomeCall = { session: string; result: 'solved' | 'failed'; rounds?: number };

function ok(session: string, tiles: number[] = [1], creditsCharged?: number): RecognizeResult {
  return {
    ok: true,
    data: {
      action: 'click_tiles',
      tiles,
      session,
      ...(creditsCharged !== undefined ? { credits_charged: creditsCharged } : {}),
    },
  };
}

function err(kind: ApiErrorKind): RecognizeResult {
  return { ok: false, kind, message: `mock ${kind}` };
}

function makeHarness() {
  let now = 0;
  let seq = 0;
  const pending: { at: number; ms: number; seq: number; resolve: () => void }[] = [];

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      pending.push({ at: now + ms, ms, seq: seq++, resolve });
    });

  /** Flush all microtasks queued so far (a macrotask runs after them). */
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  /**
   * Drive the fake clock until no work is left. Watchdog-length delays
   * (≥ ROUND_STALL_MS) are deliberately left pending: events in these tests
   * arrive "in time", like the real world — use expire() to let them fire.
   */
  async function drive(includeStall: boolean): Promise<void> {
    const eligible = () =>
      pending.filter((p) => includeStall || p.ms < ROUND_STALL_MS);
    for (let guard = 0; guard < 1000; guard++) {
      await flush();
      let candidates = eligible();
      if (candidates.length === 0) {
        await flush();
        candidates = eligible();
        if (candidates.length === 0) return;
      }
      candidates.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = candidates[0];
      if (!next) continue;
      pending.splice(pending.indexOf(next), 1);
      now = Math.max(now, next.at);
      next.resolve();
    }
    throw new Error('drive exceeded its guard — runaway loop?');
  }

  const runAll = (): Promise<void> => drive(false);
  /** Let stalled watchdogs fire, then settle all follow-up work. */
  const expire = (): Promise<void> => drive(true);

  const phases: PhaseEvent[] = [];
  const outcomes: OutcomeCall[] = [];
  const delayCalls: number[] = [];
  const recognizeQueue: RecognizeResult[] = [];
  const captureStarts: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const deps: LoopDeps = {
    getRect: vi.fn(async () => ({ rect: { x: 10, y: 10, width: 400, height: 500 }, dpr: 2 })),
    capture: vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      captureStarts.push(now);
      await sleep(50); // captures occupy time so overlap would be observable
      inFlight -= 1;
      return 'data:image/png;base64,CAPTURE';
    }),
    crop: vi.fn(async () => 'BASE64PNG'),
    recognize: vi.fn(async () => {
      const next = recognizeQueue.shift();
      if (!next) throw new Error('recognize called more times than the test scripted');
      return next;
    }),
    performAction: vi.fn(async () => true),
    outcome: vi.fn(async (p: OutcomeCall) => {
      outcomes.push(p);
      return { ok: true };
    }),
    phase: vi.fn((tabId: number, phase: Phase, detail?: PhaseEvent['detail']) => {
      phases.push({ tabId, phase, detail });
    }),
    now: () => now,
    delay: vi.fn((ms: number) => {
      delayCalls.push(ms);
      return sleep(ms);
    }),
  };

  return {
    deps,
    phases,
    outcomes,
    delayCalls,
    captureStarts,
    runAll,
    expire,
    /** Flush microtasks only — pending fake delays stay pending. */
    flush,
    queue: (...results: RecognizeResult[]) => recognizeQueue.push(...results),
    phaseNames: () => phases.map((p) => p.phase),
    maxInFlight: () => maxInFlight,
  };
}

describe('createSolveLoop', () => {
  it('solves a 2-round grid: sessions chain, outcome solved with rounds, sane phase order', async () => {
    const h = makeHarness();
    h.queue(ok('s1', [1, 3]), ok('s1', []));
    const loop = createSolveLoop(h.deps);

    loop.onChallengeReady(1, 10, 7, 'grid', 'example.com');
    await h.runAll();

    expect(h.deps.recognize).toHaveBeenCalledTimes(1);
    expect(h.deps.recognize).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'grid', host: 'example.com', session: null }),
    );
    // performAction receives the action AND the round's already-fetched rect
    // (the loop must not fetch it twice — the performer re-fetches a fresh
    // rect itself and uses this one only as a fallback).
    expect(h.deps.performAction).toHaveBeenCalledWith(
      1,
      7,
      expect.objectContaining({ action: 'click_tiles', tiles: [1, 3] }),
      { x: 10, y: 10, width: 400, height: 500 },
    );
    expect(h.phaseNames()).toEqual(['solving', 'verifying']);

    // hCaptcha presented another round in the same popup.
    loop.onChallengeReady(1, 10, 7, 'grid', 'example.com');
    await h.runAll();

    expect(h.deps.recognize).toHaveBeenCalledTimes(2);
    expect(h.deps.recognize).toHaveBeenLastCalledWith(expect.objectContaining({ session: 's1' }));
    expect(h.phaseNames()).toEqual(['solving', 'verifying', 'solving', 'verifying']);

    loop.onSolved(1, 4.2);
    await h.runAll();

    expect(h.outcomes).toEqual([{ session: 's1', result: 'solved', rounds: 2 }]);
    expect(h.phaseNames()).toEqual([
      'solving',
      'verifying',
      'solving',
      'verifying',
      'solved',
      'idle',
    ]);
    // Free tier meters 1 credit per round → the pill shows "−2 credits".
    expect(h.phases[4]?.detail).toEqual({ secs: '4.2', credits: 2 });
    expect(loop.getPhase(1)).toBe('idle');
  });

  it('forwards the CHALLENGE_READY prompt to recognize as `instruction` (count-grid corroboration)', async () => {
    const h = makeHarness();
    h.queue(ok('s1', []));
    const loop = createSolveLoop(h.deps);

    loop.onChallengeReady(1, 10, 7, 'grid', 'example.com', 'Click each animal icon the exact number of times listed');
    await h.runAll();

    expect(h.deps.recognize).toHaveBeenCalledWith(
      expect.objectContaining({ instruction: 'Click each animal icon the exact number of times listed' }),
    );
  });

  it('omits `instruction` when no prompt was provided', async () => {
    const h = makeHarness();
    h.queue(ok('s1', []));
    const loop = createSolveLoop(h.deps);

    loop.onChallengeReady(1, 10, 7, 'grid', 'example.com');
    await h.runAll();

    const payload = (h.deps.recognize as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(payload).not.toHaveProperty('instruction');
  });

  it('gives up after MAX_ROUNDS: outcome failed, phase error then idle, state cleared', async () => {
    const h = makeHarness();
    for (let i = 0; i < MAX_ROUNDS; i++) h.queue(ok('s1'));
    const loop = createSolveLoop(h.deps);

    for (let i = 0; i < MAX_ROUNDS; i++) {
      loop.onChallengeReady(1, 10, 7, 'grid', 'example.com');
      await h.runAll();
    }
    expect(h.deps.performAction).toHaveBeenCalledTimes(MAX_ROUNDS);
    expect(h.outcomes).toEqual([]);

    loop.onChallengeReady(1, 10, 7, 'grid', 'example.com'); // round 7 → cap
    await h.runAll();

    expect(h.deps.recognize).toHaveBeenCalledTimes(MAX_ROUNDS); // no extra API call
    expect(h.outcomes).toEqual([{ session: 's1', result: 'failed', rounds: MAX_ROUNDS }]);
    const tail = h.phaseNames().slice(-2);
    expect(tail).toEqual(['error', 'idle']);
    expect(loop.getPhase(1)).toBe('idle');

    // State was cleared: a later CHALLENGE_GONE is a no-op.
    loop.onChallengeGone(1);
    await h.runAll();
    expect(h.outcomes).toHaveLength(1);
  });

  it('daily_limit → phase blocked, outcome failed, attempt cleared', async () => {
    const h = makeHarness();
    h.queue(ok('s1'), err('daily_limit'));
    const loop = createSolveLoop(h.deps);

    loop.onChallengeReady(1, 10, 7, 'grid', 'example.com');
    await h.runAll();
    loop.onChallengeReady(1, 10, 7, 'grid', 'example.com');
    await h.runAll();

    expect(h.outcomes).toEqual([{ session: 's1', result: 'failed', rounds: 1 }]);
    expect(loop.getPhase(1)).toBe('blocked');
    expect(h.phaseNames().at(-1)).toBe('blocked');

    // Cleared: CHALLENGE_GONE neither double-reports nor changes the phase.
    loop.onChallengeGone(1);
    await h.runAll();
    expect(h.outcomes).toHaveLength(1);
    expect(loop.getPhase(1)).toBe('blocked');
  });

  it('pause mid-solve cancels the attempt: nothing fires after onPaused', async () => {
    const h = makeHarness();
    const loop = createSolveLoop(h.deps);

    // Capture we can hold open: pause lands between getRect resolving and recognize.
    let releaseCapture: (() => void) | undefined;
    h.deps.capture = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseCapture = () => resolve('data:image/png;base64,LATE');
        }),
    );

    loop.onChallengeReady(1, 10, 7, 'grid', 'example.com');
    await h.runAll(); // getRect resolved; capture is now in flight
    expect(h.deps.capture).toHaveBeenCalledTimes(1);

    loop.onPaused(1);
    releaseCapture?.();
    await h.runAll();

    expect(h.deps.crop).not.toHaveBeenCalled();
    expect(h.deps.recognize).not.toHaveBeenCalled();
    expect(h.deps.performAction).not.toHaveBeenCalled();
    expect(h.outcomes).toEqual([]);
    expect(h.phaseNames()).toEqual(['solving']); // no phase emissions after the cancel
    expect(loop.getPhase(1)).toBe('idle');
  });

  it('capture failing CAPTURE_RETRIES+1 times aborts quietly with no outcome (round never completed)', async () => {
    const h = makeHarness();
    const loop = createSolveLoop(h.deps);
    h.deps.capture = vi.fn(async () => {
      throw new Error('capture failed');
    });

    loop.onChallengeReady(1, 10, 7, 'grid', 'example.com');
    await h.runAll();

    expect(h.deps.capture).toHaveBeenCalledTimes(CAPTURE_RETRIES + 1);
    expect(h.deps.recognize).not.toHaveBeenCalled();
    expect(h.outcomes).toEqual([]); // rounds === 0 → never report
    expect(h.phaseNames()).toEqual(['solving', 'idle']);
    expect(h.delayCalls.filter((ms) => ms === CAPTURE_SPACING_MS).length).toBeGreaterThanOrEqual(
      CAPTURE_RETRIES,
    );
    expect(loop.getPhase(1)).toBe('idle');
  });

  it('performAction failing AFTER a charged recognize fails loud: error pill + outcome failed', async () => {
    const h = makeHarness();
    h.queue(ok('s1'));
    h.deps.performAction = vi.fn(async () => false);
    const loop = createSolveLoop(h.deps);

    loop.onChallengeReady(1, 10, 7, 'grid', 'example.com');
    await h.runAll();

    // The round was billed (recognize succeeded) — never a silent idle.
    expect(h.outcomes).toEqual([{ session: 's1', result: 'failed', rounds: 1 }]);
    expect(h.phaseNames()).toEqual(['solving', 'error', 'idle']);
    expect(loop.getPhase(1)).toBe('idle');
  });

  it('performAction throwing AFTER a charged recognize also fails loud', async () => {
    const h = makeHarness();
    h.queue(ok('s2'));
    h.deps.performAction = vi.fn(async () => {
      throw new Error('debugger went away');
    });
    const loop = createSolveLoop(h.deps);

    loop.onChallengeReady(1, 10, 7, 'grid', 'example.com');
    await h.runAll();

    expect(h.outcomes).toEqual([{ session: 's2', result: 'failed', rounds: 1 }]);
    expect(h.phaseNames()).toEqual(['solving', 'error', 'idle']);
    expect(loop.getPhase(1)).toBe('idle');
  });

  it('transient recognize error is retried once after 1500ms, then error → idle', async () => {
    const h = makeHarness();
    h.queue(err('network'), err('network'));
    const loop = createSolveLoop(h.deps);

    loop.onChallengeReady(1, 10, 7, 'grid', 'example.com');
    await h.runAll();

    expect(h.deps.recognize).toHaveBeenCalledTimes(2);
    expect(h.delayCalls).toContain(TRANSIENT_RETRY_MS);
    expect(h.deps.performAction).not.toHaveBeenCalled();
    expect(h.phaseNames()).toEqual(['solving', 'error', 'idle']);
    expect(h.outcomes).toEqual([]); // no session ever started
    expect(loop.getPhase(1)).toBe('idle');
  });

  it('serializes captures globally: never concurrent and spaced ≥ CAPTURE_SPACING_MS', async () => {
    const h = makeHarness();
    h.queue(ok('a'), ok('b'));
    const loop = createSolveLoop(h.deps);

    loop.onChallengeReady(1, 10, 5, 'grid', 'one.test');
    loop.onChallengeReady(2, 11, 6, 'grid', 'two.test');
    await h.runAll();

    expect(h.captureStarts).toHaveLength(2);
    expect(h.maxInFlight()).toBe(1);
    const [first, second] = h.captureStarts;
    expect(second! - first!).toBeGreaterThanOrEqual(CAPTURE_SPACING_MS);
    expect(h.deps.performAction).toHaveBeenCalledTimes(2);
    expect(loop.getPhase(1)).toBe('verifying');
    expect(loop.getPhase(2)).toBe('verifying');
  });

  it('a round cancelled while queued for capture never burns a capture', async () => {
    const h = makeHarness();
    h.queue(ok('a'));
    const loop = createSolveLoop(h.deps);

    loop.onChallengeReady(1, 10, 5, 'grid', 'one.test');
    loop.onChallengeReady(2, 11, 6, 'grid', 'two.test');
    await h.flush(); // tab 1's capture is in flight; tab 2 is queued behind it

    loop.onPaused(2);
    await h.runAll();

    // Only tab 1 ever captured; tab 2 bailed at the head of the queue.
    expect(h.deps.capture).toHaveBeenCalledTimes(1);
    expect(h.captureStarts).toHaveLength(1);
    expect(h.deps.recognize).toHaveBeenCalledTimes(1);
    expect(loop.getPhase(1)).toBe('verifying');
    expect(loop.getPhase(2)).toBe('idle');
  });

  it('watchdog: a round stalled at verifying fails the attempt after ROUND_STALL_MS', async () => {
    const h = makeHarness();
    h.queue(ok('s1'));
    const loop = createSolveLoop(h.deps);

    loop.onChallengeReady(1, 10, 7, 'grid', 'example.com');
    await h.runAll();
    expect(h.phaseNames()).toEqual(['solving', 'verifying']);
    expect(h.delayCalls).toContain(ROUND_STALL_MS); // watchdog armed post-exec

    // Nothing else ever arrives — the challenge frame is dead.
    await h.expire();

    expect(h.outcomes).toEqual([{ session: 's1', result: 'failed', rounds: 1 }]);
    expect(h.phaseNames()).toEqual(['solving', 'verifying', 'error', 'idle']);
    expect(loop.getPhase(1)).toBe('idle');

    // Attempt cleared: a later CHALLENGE_GONE is a no-op.
    loop.onChallengeGone(1);
    await h.runAll();
    expect(h.outcomes).toHaveLength(1);
  });

  it('watchdog: a timely CHALLENGE_READY disarms it — the next round proceeds without a spurious failure', async () => {
    const h = makeHarness();
    h.queue(ok('s1', [1, 3]), ok('s1', []));
    const loop = createSolveLoop(h.deps);

    loop.onChallengeReady(1, 10, 7, 'grid', 'example.com');
    await h.runAll();

    // Next round arrives well inside ROUND_STALL_MS.
    loop.onChallengeReady(1, 10, 7, 'grid', 'example.com');
    await h.runAll();
    expect(h.phaseNames()).toEqual(['solving', 'verifying', 'solving', 'verifying']);

    loop.onSolved(1, 3.1);
    await h.expire(); // round 1's disarmed watchdog must do nothing when it elapses

    expect(h.outcomes).toEqual([{ session: 's1', result: 'solved', rounds: 2 }]);
    expect(h.phaseNames()).not.toContain('error');
    expect(loop.getPhase(1)).toBe('idle');
  });

  it('watchdog: SOLVED disarms it (and a key-path solve sums credits_charged)', async () => {
    const h = makeHarness();
    h.queue(ok('s1', [1], 10)); // user-key response: explicit credits_charged
    const loop = createSolveLoop(h.deps);

    loop.onChallengeReady(1, 10, 7, 'grid', 'example.com');
    await h.runAll();

    loop.onSolved(1, 2.0);
    await h.expire();

    expect(h.outcomes).toEqual([{ session: 's1', result: 'solved', rounds: 1 }]);
    expect(h.phaseNames()).toEqual(['solving', 'verifying', 'solved', 'idle']);
    expect(h.phases.find((p) => p.phase === 'solved')?.detail).toEqual({
      secs: '2.0',
      credits: 10,
    });
    expect(loop.getPhase(1)).toBe('idle');
  });

  it('watchdog: onPaused mid-verifying — it never fires anything', async () => {
    const h = makeHarness();
    h.queue(ok('s1'));
    const loop = createSolveLoop(h.deps);

    loop.onChallengeReady(1, 10, 7, 'grid', 'example.com');
    await h.runAll();
    expect(loop.getPhase(1)).toBe('verifying');

    loop.onPaused(1);
    await h.expire();

    expect(h.outcomes).toEqual([]);
    expect(h.phaseNames()).toEqual(['solving', 'verifying']); // silence after the cancel
    expect(loop.getPhase(1)).toBe('idle');
  });

  it('CHALLENGE_GONE after a started attempt reports failed once', async () => {
    const h = makeHarness();
    h.queue(ok('s9'));
    const loop = createSolveLoop(h.deps);

    loop.onChallengeReady(1, 10, 7, 'single', 'example.com');
    await h.runAll();
    expect(loop.getPhase(1)).toBe('verifying');

    loop.onChallengeGone(1);
    await h.runAll();

    expect(h.outcomes).toEqual([{ session: 's9', result: 'failed', rounds: 1 }]);
    expect(loop.getPhase(1)).toBe('idle');
  });

  it('usedFallback from recognize triggers the onUserKeyDead hook', async () => {
    const h = makeHarness();
    const dead = vi.fn();
    h.deps.onUserKeyDead = dead;
    h.queue({ ok: true, usedFallback: true, data: { action: 'click_tiles', tiles: [0], session: 'sf' } });
    const loop = createSolveLoop(h.deps);

    loop.onChallengeReady(1, 10, 7, 'grid', 'example.com');
    await h.runAll();

    expect(dead).toHaveBeenCalledTimes(1);
    expect(loop.getPhase(1)).toBe('verifying');
  });
});
