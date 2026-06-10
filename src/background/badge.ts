/**
 * Toolbar badge logic. Pure compute + a painter injected by index.ts so
 * chrome.action stays out of this module (index.ts is the only file in
 * src/background that touches chrome.* directly; storage access goes
 * through the shared typed wrapper).
 */

import { getAll, subscribe, type StoredCredits } from '../shared/storage';

export const BADGE_BG = '#6938ef';
export const BADGE_BG_MUTED = '#8c8c92';
export const BADGE_TEXT_COLOR = '#ffffff';

export type BadgeState = {
  credits: number | null;
  userKey: string | null;
  paused: boolean;
  blocked: boolean;
};

export type BadgeSpec = { text: string; background: string; textColor: string };

export type BadgePainter = (spec: BadgeSpec) => void;

/** Pure text/color matrix. */
export function computeBadge(s: BadgeState): BadgeSpec {
  const muted = s.paused || s.blocked;
  const text = s.userKey !== null ? 'API' : muted ? String(s.credits ?? 0) : String(s.credits ?? '…');
  return {
    text,
    background: muted ? BADGE_BG_MUTED : BADGE_BG,
    textColor: BADGE_TEXT_COLOR,
  };
}

let painter: BadgePainter | null = null;
let flags = { paused: false, blocked: false };
let snapshot: { credits: StoredCredits | null; userKey: string | null } = {
  credits: null,
  userKey: null,
};

/** Paint an explicit badge state through the wired painter. */
export function updateBadge(s: BadgeState): void {
  painter?.(computeBadge(s));
}

function repaint(): void {
  updateBadge({
    credits: snapshot.credits?.remaining ?? null,
    userKey: snapshot.userKey,
    ...flags,
  });
}

/** Runtime flags that don't live in storage (paused host on the active tab, blocked phase). */
export function setBadgeFlags(partial: Partial<{ paused: boolean; blocked: boolean }>): void {
  const next = { ...flags, ...partial };
  if (next.paused === flags.paused && next.blocked === flags.blocked) return;
  flags = next;
  repaint();
}

/**
 * Wire the painter, paint the current storage state, and repaint whenever
 * credits/userKey/settings change. Returns an unsubscribe function.
 */
export function wireBadge(paint: BadgePainter): () => void {
  painter = paint;
  void getAll().then((all) => {
    snapshot = { credits: all.credits, userKey: all.userKey };
    repaint();
  });
  return subscribe((changes) => {
    let dirty = false;
    if ('credits' in changes) {
      snapshot.credits = changes.credits ?? null;
      dirty = true;
    }
    if ('userKey' in changes) {
      snapshot.userKey = changes.userKey ?? null;
      dirty = true;
    }
    if ('settings' in changes) dirty = true;
    if (dirty) repaint();
  });
}

/** Test hook: reset module state between specs. */
export function resetBadgeForTests(): void {
  painter = null;
  flags = { paused: false, blocked: false };
  snapshot = { credits: null, userKey: null };
}
