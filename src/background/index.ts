/**
 * Background service worker: the hub between content frames, the popup,
 * storage and the NoneCap API. This file is wiring only — sequencing logic
 * lives in solve-loop.ts (pure DI) and badge logic in badge.ts. It is also
 * the ONLY module in src/background that touches chrome.* directly.
 */

import {
  assertNever,
  type ChallengeRectReply,
  type ExecReply,
  type Msg,
  type Phase,
  type PopupState,
} from '../shared/messages';
import {
  outcome as apiOutcome,
  recognize as apiRecognize,
  register as apiRegister,
  stats as apiStats,
  type RecognizePayload,
  type RecognizeData,
  type ApiResult,
} from '../shared/api';
import { get, getAll, set, updateSettings } from '../shared/storage';
import { cropDataUrl } from '../shared/crop';
import { createSolveLoop, type LoopDeps } from './solve-loop';
import { setBadgeFlags, wireBadge } from './badge';

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
  chrome.alarms.create(REGISTER_RETRY_ALARM, {
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
// Solve-loop wiring.

/**
 * recognize with side effects: persist returned credits, re-register when the
 * key situation is broken. The loop itself stays pure.
 */
async function recognizeWithBookkeeping(p: RecognizePayload): Promise<ApiResult<RecognizeData>> {
  const res = await apiRecognize(p);
  if (res.ok) {
    if (res.data.credits !== undefined) {
      await set({
        credits: { remaining: res.data.credits.remaining, resetsAt: res.data.credits.resets_at },
      });
    }
    return res;
  }
  if (res.kind === 'no_key') {
    void ensureRegistered();
  } else if (res.kind === 'bad_key') {
    // The api client already fell back userKey→extKey, so bad_key here means
    // the extKey itself is dead (or absent): mint a fresh one.
    const userKey = await get('userKey');
    if (userKey === null) {
      await set({ extKey: null });
      void ensureRegistered();
    }
  }
  return res;
}

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
  capture(_tabId, windowId) {
    return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  },
  crop(dataUrl, rect, dpr) {
    return cropDataUrl(dataUrl, rect, dpr);
  },
  recognize: recognizeWithBookkeeping,
  async exec(tabId, frameId, action) {
    const msg: Msg = { t: 'EXEC', action };
    const reply = (await chrome.tabs.sendMessage(tabId, msg, { frameId })) as ExecReply | undefined;
    return reply?.done === true;
  },
  outcome: (p) => apiOutcome(p),
  phase: sendPhaseToTab,
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
// Gate: may we touch captchas on this host right now?

type Gate = { proceed: boolean; reason: 'ok' | 'off' | 'no-solves' };

async function evaluateGate(host: string, task?: 'grid' | 'single'): Promise<Gate> {
  const all = await getAll();
  const s = all.settings;
  if (!s.autoSolve || s.pausedHosts.includes(host) || s.blocklist.includes(host)) {
    return { proceed: false, reason: 'off' };
  }
  if (task !== undefined && !(task === 'grid' ? s.grid : s.drag)) {
    return { proceed: false, reason: 'off' };
  }
  const haveSolves = all.userKey !== null || (all.credits?.remaining ?? 1) > 0;
  if (!haveSolves) return { proceed: false, reason: 'no-solves' };
  return { proceed: true, reason: 'ok' };
}

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
      if (tab.id !== undefined && hostnameOf(tab.url) === msg.host) loop.onPaused(tab.id);
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

chrome.runtime.onMessage.addListener(
  (raw: unknown, sender, sendResponse): boolean | undefined => {
    const msg = raw as Msg;
    switch (msg.t) {
      case 'CHECKBOX_SEEN':
        // The anchor frame gates its checkbox click on this reply.
        void handleCheckboxSeen(sender).then(sendResponse);
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
        void assemblePopupState().then(sendResponse);
        return true;
      case 'SET_PAUSE':
        void handleSetPause(msg).then(() => sendResponse({ ok: true }));
        return true;
      case 'CONNECT_KEY':
        void handleConnectKey(msg.key).then(sendResponse);
        return true;
      case 'DISCONNECT_KEY':
        void set({ userKey: null });
        return undefined;
      // bg → frame messages; never handled here.
      case 'GET_CHALLENGE_RECT':
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

void refreshPausedFlag();
