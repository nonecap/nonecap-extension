/**
 * The solve loop: a pure, per-tab state machine driven entirely through
 * injected dependencies. Zero chrome.* here — index.ts owns all platform
 * wiring; this module owns all sequencing/cancellation logic so it can be
 * unit-tested with fake deps and a fake clock.
 */

import type { ExtAction, Phase, RectLike } from '../shared/messages';
import { assertNever } from '../shared/messages';
import type { ApiErrorKind, ApiResult, RecognizeData } from '../shared/api';

export type RecognizeResult = ApiResult<RecognizeData>;

export type LoopDeps = {
  /** Ask the top frame for the challenge popup's viewport rect. */
  getRect(tabId: number): Promise<{ rect: RectLike; dpr: number } | null>;
  /** Screenshot the visible tab; resolves to a data URL. Throws on failure. */
  capture(tabId: number, windowId: number): Promise<string>;
  /** Crop the screenshot to the rect; resolves to base64 PNG. Throws on failure. */
  crop(dataUrl: string, rect: RectLike, dpr: number): Promise<string>;
  /** Call the NoneCap recognize endpoint. Never throws (ApiResult seam). */
  recognize(p: {
    image: string;
    task: 'grid' | 'single';
    host: string;
    session?: string | null;
  }): Promise<RecognizeResult>;
  /** Send EXEC to the challenge frame; resolves to ExecReply.done. */
  exec(tabId: number, frameId: number, action: ExtAction): Promise<boolean>;
  /** Report a finished session to the API (fire-and-forget semantics). */
  outcome(p: { session: string; result: 'solved' | 'failed'; rounds?: number }): Promise<unknown>;
  /** Push a phase to the top frame overlay + badge hook. */
  phase(tabId: number, phase: Phase, detail?: { secs?: string; credits?: number }): void;
  now(): number;
  delay(ms: number): Promise<void>;
  /** Called when the API client fell back to the extKey: the stored userKey is dead. */
  onUserKeyDead?(): void;
};

export const MAX_ROUNDS = 6;
export const CAPTURE_RETRIES = 2;
export const CAPTURE_SPACING_MS = 600;
/** Wait before the single retry on a transient (network/server/429) recognize failure. */
export const TRANSIENT_RETRY_MS = 1500;
/** How long the 'solved' / 'error' phases stay up before falling back to 'idle'. */
export const PHASE_LINGER_MS = 4000;

type Token = { cancelled: boolean };

type Attempt = {
  windowId: number;
  frameId: number;
  host: string;
  task: 'grid' | 'single';
  session: string | null;
  /** Completed rounds (a round counts once recognize succeeded). */
  rounds: number;
  token: Token;
};

export type SolveLoop = {
  onChallengeReady(
    tabId: number,
    windowId: number,
    frameId: number,
    task: 'grid' | 'single',
    host: string,
  ): void;
  onSolved(tabId: number, secs: number): void;
  onChallengeGone(tabId: number): void;
  /** Cancel any in-flight attempt for the tab (user paused the host). */
  onPaused(tabId: number): void;
  getPhase(tabId: number): Phase;
};

export function createSolveLoop(deps: LoopDeps): SolveLoop {
  const attempts = new Map<number, Attempt>();
  const phases = new Map<number, Phase>();
  /** Pending linger→idle transitions, cancellable per tab. */
  const lingerTokens = new Map<number, Token>();

  /** Global capture serialization: one captureVisibleTab at a time, spaced. */
  let captureChain: Promise<unknown> = Promise.resolve();
  let lastCaptureAt: number | null = null;

  function setPhase(tabId: number, phase: Phase, detail?: { secs?: string; credits?: number }): void {
    phases.set(tabId, phase);
    deps.phase(tabId, phase, detail);
  }

  function cancelLinger(tabId: number): void {
    const token = lingerTokens.get(tabId);
    if (token) token.cancelled = true;
    lingerTokens.delete(tabId);
  }

  /** Show `phase` now, then fall back to 'idle' after PHASE_LINGER_MS unless superseded. */
  function lingerToIdle(tabId: number): void {
    cancelLinger(tabId);
    const token: Token = { cancelled: false };
    lingerTokens.set(tabId, token);
    void deps.delay(PHASE_LINGER_MS).then(() => {
      if (token.cancelled) return;
      lingerTokens.delete(tabId);
      setPhase(tabId, 'idle');
    });
  }

  function clearAttempt(tabId: number, attempt: Attempt): void {
    attempt.token.cancelled = true;
    if (attempts.get(tabId) === attempt) attempts.delete(tabId);
  }

  /** Report 'failed' only if the session actually started (≥1 completed round). */
  function reportFailedIfStarted(attempt: Attempt): void {
    if (attempt.session !== null && attempt.rounds > 0) {
      void deps.outcome({ session: attempt.session, result: 'failed', rounds: attempt.rounds });
    }
  }

  /** Quiet abort: capture/crop/rect problems. No error UI, straight to idle. */
  function abortQuiet(tabId: number, attempt: Attempt): void {
    reportFailedIfStarted(attempt);
    clearAttempt(tabId, attempt);
    setPhase(tabId, 'idle');
  }

  /** Loud failure: error phase shown, then idle. */
  function failLoud(tabId: number, attempt: Attempt, withOutcome: boolean): void {
    if (withOutcome) reportFailedIfStarted(attempt);
    clearAttempt(tabId, attempt);
    setPhase(tabId, 'error');
    lingerToIdle(tabId);
  }

  /** Blocked (daily limit / out of credits): phase persists, no auto-idle. */
  function block(tabId: number, attempt: Attempt, withOutcome: boolean): void {
    if (withOutcome) reportFailedIfStarted(attempt);
    clearAttempt(tabId, attempt);
    setPhase(tabId, 'blocked');
  }

  function captureSerialized(tabId: number, windowId: number): Promise<string> {
    const run = captureChain.then(async () => {
      if (lastCaptureAt !== null) {
        const wait = lastCaptureAt + CAPTURE_SPACING_MS - deps.now();
        if (wait > 0) await deps.delay(wait);
      }
      lastCaptureAt = deps.now();
      return deps.capture(tabId, windowId);
    });
    // Keep the chain alive whether this capture succeeds or throws.
    captureChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function isTransient(kind: ApiErrorKind): boolean {
    return kind === 'network' || kind === 'server' || kind === 'rate_limited';
  }

  async function runRound(tabId: number, attempt: Attempt, token: Token): Promise<void> {
    setPhase(tabId, 'solving');

    let rectInfo: { rect: RectLike; dpr: number } | null;
    try {
      rectInfo = await deps.getRect(tabId);
    } catch {
      rectInfo = null;
    }
    if (token.cancelled) return;
    if (rectInfo === null) {
      abortQuiet(tabId, attempt);
      return;
    }

    let dataUrl: string | null = null;
    for (let i = 0; i <= CAPTURE_RETRIES; i++) {
      try {
        dataUrl = await captureSerialized(tabId, attempt.windowId);
      } catch {
        dataUrl = null;
      }
      if (token.cancelled) return;
      if (dataUrl !== null) break;
      if (i < CAPTURE_RETRIES) {
        await deps.delay(CAPTURE_SPACING_MS);
        if (token.cancelled) return;
      }
    }
    if (dataUrl === null) {
      abortQuiet(tabId, attempt);
      return;
    }

    let image: string;
    try {
      image = await deps.crop(dataUrl, rectInfo.rect, rectInfo.dpr);
    } catch {
      if (!token.cancelled) abortQuiet(tabId, attempt);
      return;
    }
    if (token.cancelled) return;

    const payload = { image, task: attempt.task, host: attempt.host, session: attempt.session };
    let res = await deps.recognize(payload);
    if (token.cancelled) return;

    if (!res.ok && isTransient(res.kind)) {
      await deps.delay(TRANSIENT_RETRY_MS);
      if (token.cancelled) return;
      res = await deps.recognize(payload);
      if (token.cancelled) return;
      if (!res.ok && isTransient(res.kind)) {
        failLoud(tabId, attempt, true);
        return;
      }
    }

    if (!res.ok) {
      switch (res.kind) {
        case 'daily_limit':
          block(tabId, attempt, true);
          return;
        case 'no_credits':
          block(tabId, attempt, false);
          return;
        case 'bad_key':
        case 'no_key':
          // index.ts handles re-registration; no outcome (the key is dead anyway).
          failLoud(tabId, attempt, false);
          return;
        case 'network':
        case 'server':
        case 'rate_limited':
          // Unreachable: transients were handled above.
          failLoud(tabId, attempt, true);
          return;
        default:
          return assertNever(res.kind);
      }
    }

    attempt.session = res.data.session;
    attempt.rounds += 1;
    if (res.usedFallback) deps.onUserKeyDead?.();

    let done = false;
    try {
      done = await deps.exec(tabId, attempt.frameId, res.data);
    } catch {
      done = false;
    }
    if (token.cancelled) return;
    if (!done) {
      abortQuiet(tabId, attempt);
      return;
    }

    setPhase(tabId, 'verifying');
  }

  function onChallengeReady(
    tabId: number,
    windowId: number,
    frameId: number,
    task: 'grid' | 'single',
    host: string,
  ): void {
    cancelLinger(tabId);

    const existing = attempts.get(tabId);
    if (existing !== undefined) {
      // Next round of the same attempt: supersede any in-flight round.
      existing.token.cancelled = true;
      if (existing.rounds >= MAX_ROUNDS) {
        failLoud(tabId, existing, true);
        return;
      }
      existing.token = { cancelled: false };
      existing.windowId = windowId;
      existing.frameId = frameId;
      existing.task = task;
      existing.host = host;
      void runRound(tabId, existing, existing.token);
      return;
    }

    const attempt: Attempt = {
      windowId,
      frameId,
      host,
      task,
      session: null,
      rounds: 0,
      token: { cancelled: false },
    };
    attempts.set(tabId, attempt);
    void runRound(tabId, attempt, attempt.token);
  }

  function onSolved(tabId: number, secs: number): void {
    const attempt = attempts.get(tabId);
    if (attempt === undefined) return;
    attempt.token.cancelled = true;
    if (attempt.session !== null) {
      void deps.outcome({ session: attempt.session, result: 'solved', rounds: attempt.rounds });
    }
    clearAttempt(tabId, attempt);
    setPhase(tabId, 'solved', { secs: secs.toFixed(1) });
    lingerToIdle(tabId);
  }

  function onChallengeGone(tabId: number): void {
    const attempt = attempts.get(tabId);
    if (attempt === undefined) return; // already solved/cleared — keep linger alive
    attempt.token.cancelled = true;
    reportFailedIfStarted(attempt);
    clearAttempt(tabId, attempt);
    setPhase(tabId, 'idle');
  }

  function onPaused(tabId: number): void {
    cancelLinger(tabId);
    const attempt = attempts.get(tabId);
    if (attempt === undefined) return;
    attempt.token.cancelled = true;
    clearAttempt(tabId, attempt);
    // Silent: no phase emission after a user-initiated cancel.
    phases.set(tabId, 'idle');
  }

  function getPhase(tabId: number): Phase {
    return phases.get(tabId) ?? 'idle';
  }

  return { onChallengeReady, onSolved, onChallengeGone, onPaused, getPhase };
}
