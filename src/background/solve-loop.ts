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
  /**
   * Perform the recognized action with trusted (CDP) input, animating the
   * challenge frame's cosmetic cursor in sync. `rect` is the challenge
   * iframe's top-frame viewport rect already fetched for this round's
   * capture — the performer converts coordinates against it instead of
   * fetching again. Injected from index.ts (the loop stays chrome-free);
   * resolves false when the action could not be performed (e.g. debugger
   * attach failed or the frame's geometry was unavailable).
   */
  performAction(tabId: number, frameId: number, action: ExtAction, rect: RectLike): Promise<boolean>;
  /** Report a finished session to the API (fire-and-forget semantics). */
  outcome(p: { session: string; result: 'solved' | 'failed'; rounds?: number }): Promise<unknown>;
  /** Push a phase to the top frame overlay + badge hook. */
  phase(tabId: number, phase: Phase, detail?: { secs?: string; credits?: number }): void;
  now(): number;
  delay(ms: number): Promise<void>;
  /** Called when the API client fell back to the extKey: the stored userKey is dead. */
  onUserKeyDead?(): void;
};

/**
 * Hard cap on rounds per challenge. hCaptcha passes after 1-2 correct rounds;
 * if it is still re-challenging after 6, we're almost certainly
 * mis-recognizing and would just burn credits — report failed and stand down.
 */
export const MAX_ROUNDS = 6;
/**
 * Quick in-round retries for a failed capture. captureVisibleTab fails
 * transiently (window occluded/minimized, focus churn, quota window) and
 * usually recovers within a beat — more retries would only delay the abort.
 */
export const CAPTURE_RETRIES = 2;
/**
 * Minimum gap between captures, enforced globally: Chrome caps
 * captureVisibleTab at MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2, so
 * 600ms keeps us safely under the quota even with several tabs solving.
 */
export const CAPTURE_SPACING_MS = 600;
/** Wait before the single retry on a transient (network/server/429) recognize failure. */
export const TRANSIENT_RETRY_MS = 1500;
/** How long the 'solved' / 'error' phases stay up before falling back to 'idle'. */
export const PHASE_LINGER_MS = 4000;
/**
 * Watchdog for a concluded round: armed when the action finishes (phase
 * 'verifying'). 20s comfortably covers hCaptcha's verify animation plus the
 * next round's render; if no CHALLENGE_READY / SOLVED / CHALLENGE_GONE has
 * arrived by then the challenge frame is dead and the attempt would
 * otherwise hang at 'verifying' (and the on-page pill with it) forever.
 */
export const ROUND_STALL_MS = 20_000;

type Token = { cancelled: boolean };

type Attempt = {
  windowId: number;
  frameId: number;
  host: string;
  task: 'grid' | 'single';
  session: string | null;
  /** Completed rounds (a round counts once recognize succeeded). */
  rounds: number;
  /**
   * Cumulative credits consumed: free keys meter 1 per round, user keys
   * report credits_charged per recognize. Shown in the solved pill
   * ("Solved in Xs · −N credits").
   */
  creditsSpent: number;
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
  /** Armed round watchdogs, cancellable per tab (see ROUND_STALL_MS). */
  const watchdogTokens = new Map<number, Token>();

  /** Global capture serialization: one captureVisibleTab at a time, spaced. */
  let captureChain: Promise<unknown> = Promise.resolve();
  let lastCaptureAt: number | null = null;

  function setPhase(tabId: number, phase: Phase, detail?: { secs?: string; credits?: number }): void {
    // 'idle' is the getPhase default, so store it as absence: every terminal
    // path prunes its map entry instead of the map growing per tab forever.
    if (phase === 'idle') phases.delete(tabId);
    else phases.set(tabId, phase);
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

  function cancelWatchdog(tabId: number): void {
    const token = watchdogTokens.get(tabId);
    if (token) token.cancelled = true;
    watchdogTokens.delete(tabId);
  }

  /**
   * Arm the post-action stall watchdog. Disarmed by the next CHALLENGE_READY /
   * SOLVED / CHALLENGE_GONE / onPaused (all of which either re-arm here or
   * pass through clearAttempt). On fire — token-guarded and re-checked
   * against the live attempt, like every other resumption point — the
   * attempt is dead: report failed (if a round completed) and fail loud.
   */
  function armWatchdog(tabId: number, attempt: Attempt): void {
    cancelWatchdog(tabId);
    const token: Token = { cancelled: false };
    watchdogTokens.set(tabId, token);
    void deps.delay(ROUND_STALL_MS).then(() => {
      if (token.cancelled) return;
      watchdogTokens.delete(tabId);
      if (attempts.get(tabId) !== attempt) return; // superseded meanwhile
      failLoud(tabId, attempt, true);
    });
  }

  function clearAttempt(tabId: number, attempt: Attempt): void {
    attempt.token.cancelled = true;
    cancelWatchdog(tabId);
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

  function captureSerialized(tabId: number, windowId: number, token: Token): Promise<string> {
    const run = captureChain.then(async () => {
      // The round may have been cancelled while queued behind other tabs'
      // captures — bail before burning quota for a dead attempt.
      if (token.cancelled) throw new Error('attempt cancelled while queued');
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
        dataUrl = await captureSerialized(tabId, attempt.windowId, token);
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
    // User keys say what each call cost; the free tier meters 1 per round.
    attempt.creditsSpent += res.data.credits_charged ?? 1;
    if (res.usedFallback) deps.onUserKeyDead?.();

    let done = false;
    try {
      done = await deps.performAction(tabId, attempt.frameId, res.data, rectInfo.rect);
    } catch {
      done = false;
    }
    if (token.cancelled) return;
    if (!done) {
      abortQuiet(tabId, attempt);
      return;
    }

    setPhase(tabId, 'verifying');
    armWatchdog(tabId, attempt);
  }

  function onChallengeReady(
    tabId: number,
    windowId: number,
    frameId: number,
    task: 'grid' | 'single',
    host: string,
  ): void {
    cancelLinger(tabId);
    cancelWatchdog(tabId); // the next round arrived in time — re-armed post-action

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
      creditsSpent: 0,
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
    setPhase(tabId, 'solved', { secs: secs.toFixed(1), credits: attempt.creditsSpent });
    lingerToIdle(tabId);
  }

  function onChallengeGone(tabId: number): void {
    const attempt = attempts.get(tabId);
    // No attempt: either already terminal (CHALLENGE_GONE fires right after
    // SOLVED and after 'blocked' — keep that linger/phase alive) or the tab
    // was never ours. Nothing to clean up. index.ts also routes
    // tabs.onRemoved here so closed tabs reap their attempt + phase entry.
    if (attempt === undefined) return;
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
    phases.delete(tabId);
  }

  function getPhase(tabId: number): Phase {
    return phases.get(tabId) ?? 'idle';
  }

  return { onChallengeReady, onSolved, onChallengeGone, onPaused, getPhase };
}
