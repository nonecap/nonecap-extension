/**
 * Background service worker: the hub between content frames, the popup,
 * storage and the NoneCap API. This file is wiring only — sequencing logic
 * lives in solve-loop.ts (pure DI) and badge logic in badge.ts. It is also
 * the ONLY module in src/background that touches chrome.* directly.
 */

import {
  assertNever,
  type ChallengeRectReply,
  type CursorOp,
  type ExtAction,
  type GeometryReply,
  type Msg,
  type Phase,
  type PopupState,
  type Pt,
  type RectLike,
} from '../shared/messages';
import {
  outcome as apiOutcome,
  recognize as apiRecognize,
  register as apiRegister,
  stats as apiStats,
} from '../shared/api';
import { get, getAll, set, updateSettings } from '../shared/storage';
import { cropDataUrl } from '../shared/crop';
import { createSolveLoop, type LoopDeps } from './solve-loop';
import { createRecognizeBookkeeper, evaluateGate, refreshStatsIfStale } from './gate';
import { setBadgeFlags, wireBadge } from './badge';
import { chromeDebuggerTransport, createInputDriver, localToTop, normalizedToTop } from './input';

// ---------------------------------------------------------------------------
// Registration (anonymous free-tier key) with alarm-backed retries.

const REGISTER_RETRY_ALARM = 'register-retry';
const REGISTER_RETRY_MINUTES = [1, 5, 30] as const;
/** In-memory step; a SW restart resets to the fastest retry, which is fine. */
let registerRetryStep = 0;

function nextUtcMidnightIso(): string {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

async function ensureRegistered(): Promise<void> {
  const extKey = await get('extKey');
  if (extKey !== null) {
    await chrome.alarms.clear(REGISTER_RETRY_ALARM);
    return;
  }
  const res = await apiRegister();
  if (res.ok) {
    await set({
      extKey: res.data.key,
      credits: { remaining: res.data.daily_limit, resetsAt: nextUtcMidnightIso() },
    });
    await chrome.alarms.clear(REGISTER_RETRY_ALARM);
    registerRetryStep = 0;
    return;
  }
  const step = Math.min(registerRetryStep, REGISTER_RETRY_MINUTES.length - 1);
  registerRetryStep += 1;
  void chrome.alarms.create(REGISTER_RETRY_ALARM, {
    delayInMinutes: REGISTER_RETRY_MINUTES[step] ?? 30,
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureRegistered();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REGISTER_RETRY_ALARM) void ensureRegistered();
});

// ---------------------------------------------------------------------------
// Helpers.

function hostnameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function sendPhaseToTab(tabId: number, phase: Phase, detail?: { secs?: string; credits?: number }): void {
  const msg: Msg = { t: 'PHASE', phase, detail };
  void chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => {
    // Top frame may not have a content script (chrome://, detached tab) — ignore.
  });
  // Repaint the badge when a tab becomes blocked (out of solves) and clear
  // the flag again once activity resumes.
  setBadgeFlags({ blocked: phase === 'blocked' });
}

/** Recompute the badge "paused" flag from the active tab's host. */
async function refreshPausedFlag(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const host = hostnameOf(tab?.url);
    const settings = await get('settings');
    setBadgeFlags({ paused: host !== null && settings.pausedHosts.includes(host) });
  } catch {
    // tabs may be unavailable during teardown; keep the last flag.
  }
}

// ---------------------------------------------------------------------------
// Trusted input (chrome.debugger / CDP).
//
// Real mouse input is dispatched from here as trusted CDP events in top-frame
// viewport CSS coords (docs/SOLVING-ARCHITECTURE.md). The challenge frame
// only supplies geometry (GET_GEOMETRY) and renders the cosmetic cursor
// (CURSOR) — it never dispatches real pointer events anymore.

const input = createInputDriver(chromeDebuggerTransport, {
  now: () => Date.now(),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

// The user can dismiss Chrome's debugger infobar (or the target can go away);
// either way our session is gone — reset the driver so the next attempt
// re-attaches instead of dispatching into the void.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) input.markDetached(source.tabId);
});

/** Ask the challenge frame for tile/verify/refresh centres (iframe-local). */
async function getGeometry(tabId: number, frameId: number): Promise<GeometryReply> {
  try {
    const msg: Msg = { t: 'GET_GEOMETRY' };
    const reply = (await chrome.tabs.sendMessage(tabId, msg, { frameId })) as
      | GeometryReply
      | undefined;
    return reply ?? null;
  } catch {
    return null;
  }
}

/** Fire-and-forget cosmetic-cursor op to the challenge frame. */
function sendCursor(tabId: number, frameId: number, op: CursorOp, p?: Pt): void {
  const msg: Msg = { t: 'CURSOR', op, ...(p !== undefined ? { x: p.x, y: p.y } : {}) };
  void chrome.tabs.sendMessage(tabId, msg, { frameId }).catch(() => {
    // The cursor is cosmetic — a missing frame must never fail the action.
  });
}

/** Small human-ish pause between consecutive clicks (not the press dwell). */
function actionPause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 80));
}

/**
 * Perform a recognized action with trusted input, mirroring the old in-frame
 * executor's sequencing: act → re-read geometry → click Verify/Next unless
 * it still reads "Skip" (an unregistered answer; clicking would throw the
 * challenge away — leave it and let the round re-arm / the watchdog end it).
 * Coordinates: vision points are normalized 0-1000 over `rect`; tile /
 * verify / refresh centres come from GET_GEOMETRY in iframe-local coords and
 * are offset by `rect`'s origin. Resolves false when nothing could be done
 * (attach failed, geometry unavailable) so the loop aborts the round.
 */
async function performAction(
  tabId: number,
  frameId: number,
  action: ExtAction,
  rect: RectLike,
): Promise<boolean> {
  try {
    await input.attach(tabId);
  } catch (err) {
    // One CDP client per tab: DevTools (or another extension) already holds
    // it. Not retryable from here — fail the action; the loop stands down.
    console.warn('[nonecap] debugger attach failed (is DevTools open on this tab?)', err);
    return false;
  }

  /** Trusted click at an iframe-local point, cursor animated in sync. */
  const clickLocal = async (local: Pt): Promise<void> => {
    sendCursor(tabId, frameId, 'move', local);
    const top = localToTop(local, rect);
    await input.click(tabId, top.x, top.y);
    sendCursor(tabId, frameId, 'click', local);
  };

  /** Re-read geometry and click Verify/Next — never Skip. */
  const clickVerifyUnlessSkip = async (): Promise<void> => {
    const geo = await getGeometry(tabId, frameId);
    if (!geo?.verify || geo.verify.isSkip) return;
    await actionPause();
    await clickLocal(geo.verify.center);
  };

  switch (action.action) {
    case 'click_tiles': {
      const geo = await getGeometry(tabId, frameId);
      if (geo === null) return false;
      for (const n of action.tiles) {
        const center = geo.tiles[n - 1]; // 1-based reading order
        if (!center) continue; // best-effort, like the old executor
        await clickLocal(center);
        await actionPause();
      }
      await clickVerifyUnlessSkip();
      return true;
    }
    case 'click_points': {
      for (const p of action.points) {
        // Normalized → iframe-local (rect-relative without the origin).
        await clickLocal({ x: (p.x / 1000) * rect.width, y: (p.y / 1000) * rect.height });
        await actionPause();
      }
      await clickVerifyUnlessSkip();
      return true;
    }
    case 'drag': {
      const moves = action.moves.length > 0 ? action.moves : [{ from: action.from, to: action.to }];
      for (const move of moves) {
        const fromLocal = { x: (move.from.x / 1000) * rect.width, y: (move.from.y / 1000) * rect.height };
        const toLocal = { x: (move.to.x / 1000) * rect.width, y: (move.to.y / 1000) * rect.height };
        sendCursor(tabId, frameId, 'move', fromLocal);
        sendCursor(tabId, frameId, 'press');
        await input.drag(tabId, normalizedToTop(move.from, rect), normalizedToTop(move.to, rect));
        sendCursor(tabId, frameId, 'move', toLocal);
        sendCursor(tabId, frameId, 'release');
        await actionPause();
      }
      await clickVerifyUnlessSkip();
      return true;
    }
    case 'refresh': {
      const geo = await getGeometry(tabId, frameId);
      if (!geo?.refresh) return false;
      await clickLocal(geo.refresh);
      return true;
    }
    default:
      return assertNever(action);
  }
}

/** Detach the debugger when an attempt reaches any terminal state. */
function detachIfTerminal(tabId: number, phase: Phase): void {
  if (phase === 'idle' || phase === 'solved' || phase === 'error' || phase === 'blocked') {
    void input.detach(tabId);
  }
}

// ---------------------------------------------------------------------------
// Solve-loop wiring.

/** recognize + storage side effects (see gate.ts). The loop itself stays pure. */
const recognizeWithBookkeeping = createRecognizeBookkeeper({
  recognize: apiRecognize,
  reRegister: () => void ensureRegistered(),
});

const loopDeps: LoopDeps = {
  async getRect(tabId) {
    try {
      const msg: Msg = { t: 'GET_CHALLENGE_RECT' };
      const reply = (await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 })) as
        | ChallengeRectReply
        | undefined;
      return reply ?? null;
    } catch {
      return null;
    }
  },
  async capture(_tabId, windowId) {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    // Chrome occasionally resolves with undefined/'' (occluded window, quota
    // edge) instead of rejecting — surface that as a retryable failure.
    if (!dataUrl) throw new Error('captureVisibleTab returned no data');
    return dataUrl;
  },
  crop(dataUrl, rect, dpr) {
    return cropDataUrl(dataUrl, rect, dpr);
  },
  recognize: recognizeWithBookkeeping,
  performAction,
  outcome: (p) => apiOutcome(p),
  phase(tabId, phase, detail) {
    sendPhaseToTab(tabId, phase, detail);
    // Attempt-terminal phases end the trusted-input session: the debugger
    // (and Chrome's infobar with it) is attached only while actively solving.
    detachIfTerminal(tabId, phase);
  },
  now: () => Date.now(),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onUserKeyDead() {
    // The stored user key is dead; drop it so the popup shows the free tier
    // again (the api client already solved this round via the extKey).
    void set({ userKey: null });
  },
};

const loop = createSolveLoop(loopDeps);

// ---------------------------------------------------------------------------
// Message handlers.

async function handleCheckboxSeen(sender: chrome.runtime.MessageSender): Promise<{ proceed: boolean }> {
  const tabId = sender.tab?.id;
  const host = hostnameOf(sender.tab?.url);
  if (tabId === undefined || host === null) return { proceed: false };
  // Challenge-type toggles don't apply to the checkbox itself.
  const gate = await evaluateGate(host);
  if (gate.proceed && loop.getPhase(tabId) === 'idle') {
    sendPhaseToTab(tabId, 'detected');
  }
  return { proceed: gate.proceed };
}

async function handleChallengeReady(
  msg: Extract<Msg, { t: 'CHALLENGE_READY' }>,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tab = sender.tab;
  const host = hostnameOf(tab?.url);
  if (tab?.id === undefined || tab.windowId === undefined || host === null) return;
  const frameId = sender.frameId ?? 0;

  const gate = await evaluateGate(host, msg.task);
  if (!gate.proceed) {
    if (gate.reason === 'no-solves') sendPhaseToTab(tab.id, 'blocked');
    return;
  }
  loop.onChallengeReady(tab.id, tab.windowId, frameId, msg.task, host);
}

async function assemblePopupState(): Promise<PopupState> {
  const all = await getAll();
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const host = hostnameOf(tab?.url);
  return {
    phase: tab?.id !== undefined ? loop.getPhase(tab.id) : 'idle',
    credits: all.credits,
    userKey: all.userKey,
    host,
    paused: host !== null && all.settings.pausedHosts.includes(host),
    lastSolve: all.lastSolve,
    stats:
      all.stats !== null
        ? {
            monthSolves: all.stats.monthSolves,
            monthCreditsSpent: all.stats.monthCreditsSpent,
            solveRate: all.stats.solveRate,
          }
        : null,
  };
}

async function handleSetPause(msg: Extract<Msg, { t: 'SET_PAUSE' }>): Promise<void> {
  await updateSettings((s) => ({
    ...s,
    pausedHosts: msg.paused
      ? [...new Set([...s.pausedHosts, msg.host])]
      : s.pausedHosts.filter((h) => h !== msg.host),
  }));
  if (msg.paused) {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id !== undefined && hostnameOf(tab.url) === msg.host) {
        loop.onPaused(tab.id);
        // onPaused is deliberately silent (no phase emission), so the
        // terminal-phase detach hook never sees it — detach here.
        void input.detach(tab.id);
      }
    }
  }
  await refreshPausedFlag();
}

async function handleConnectKey(key: string): Promise<{ ok: boolean }> {
  const res = await apiStats(key);
  if (!res.ok) return { ok: false };
  await set({
    userKey: key,
    stats: {
      monthSolves: res.data.month_solves,
      monthCreditsSpent: res.data.month_credits_spent,
      solveRate: res.data.solve_rate,
      fetchedAt: Date.now(),
    },
  });
  return { ok: true };
}

/** Fallback GET_STATE reply if assembly rejects — never leave the popup hanging. */
const IDLE_POPUP_STATE: PopupState = {
  phase: 'idle',
  credits: null,
  userKey: null,
  host: null,
  paused: false,
  lastSolve: null,
  stats: null,
};

chrome.runtime.onMessage.addListener(
  (raw: unknown, sender, sendResponse): boolean | undefined => {
    const msg = raw as Msg;
    switch (msg.t) {
      case 'CHECKBOX_SEEN':
        // The anchor frame gates its checkbox click on this reply; a rejection
        // must still respond or the sender's channel hangs open.
        void handleCheckboxSeen(sender).then(sendResponse, () => sendResponse({ proceed: false }));
        return true;
      case 'CHALLENGE_READY':
        void handleChallengeReady(msg, sender);
        return undefined;
      case 'CHALLENGE_GONE':
        if (sender.tab?.id !== undefined) loop.onChallengeGone(sender.tab.id);
        return undefined;
      case 'SOLVED':
        if (sender.tab?.id !== undefined) {
          loop.onSolved(sender.tab.id, msg.secs);
          void set({ lastSolve: { secs: msg.secs, at: Date.now() } });
        }
        return undefined;
      case 'GET_STATE':
        // Popup open = natural moment to refresh key-user stats. Deliberately
        // NOT awaited: reply with current state now, the popup's poll picks
        // up the refreshed numbers via storage on its next tick.
        void refreshStatsIfStale(() => apiStats()).catch(() => {});
        void assemblePopupState().then(sendResponse, () => sendResponse(IDLE_POPUP_STATE));
        return true;
      case 'SET_PAUSE':
        void handleSetPause(msg).then(
          () => sendResponse({ ok: true }),
          () => sendResponse({ ok: false }),
        );
        return true;
      case 'CONNECT_KEY':
        void handleConnectKey(msg.key).then(sendResponse, () => sendResponse({ ok: false }));
        return true;
      case 'DISCONNECT_KEY':
        void set({ userKey: null });
        return undefined;
      case 'OPEN_OPTIONS':
        // Web-origin pages can't navigate to non-web-accessible extension
        // pages, so the pill's CTA delegates to the background.
        void chrome.runtime.openOptionsPage();
        return undefined;
      // bg → frame messages; never handled here. (EXEC is deprecated — no
      // longer sent; the variant lives until Phase 2 drops the frame handler.)
      case 'GET_CHALLENGE_RECT':
      case 'GET_GEOMETRY':
      case 'CURSOR':
      case 'EXEC':
      case 'PHASE':
        return undefined;
      default:
        return assertNever(msg);
    }
  },
);

// ---------------------------------------------------------------------------
// Badge.

wireBadge((spec) => {
  void chrome.action.setBadgeText({ text: spec.text });
  void chrome.action.setBadgeBackgroundColor({ color: spec.background });
  void chrome.action.setBadgeTextColor({ color: spec.textColor });
});

chrome.tabs.onActivated.addListener(() => {
  void refreshPausedFlag();
});

// A closed tab can't send CHALLENGE_GONE — reap its attempt/phase state here
// (reports 'failed' if a solve had started, and prunes the loop's tab maps).
chrome.tabs.onRemoved.addListener((tabId) => {
  loop.onChallengeGone(tabId);
  // Chrome detaches the debugger with the tab; this just prunes driver state
  // (best-effort + idempotent, the transport swallows "not attached").
  void input.detach(tabId);
});

void refreshPausedFlag();
