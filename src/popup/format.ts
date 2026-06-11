/**
 * Pure presentation helpers for the popup/options UI.
 * No chrome.* and no DOM here — everything is unit-testable.
 */

import type { Phase } from '../shared/messages';

/** Daily free-tier credit allowance shown in the popup. */
export const FREE_DAILY_CREDITS = 100;

/**
 * Format of a user-connected NoneCap API key: `nc_live_`/`nc_test_` + a
 * base64url body, whose alphabet is `A-Za-z0-9` plus `-` and `_` (the API
 * mints keys as base64url(random bytes) — see api-keys.ts). The body MUST
 * allow `-`/`_` or a large fraction of valid keys are wrongly rejected.
 */
export const KEY_RE = /^nc_(live|test)_[A-Za-z0-9_-]{8,}$/;

export const HINT_DEFAULT = 'Find your key in the NoneCap dashboard.';
export const HINT_FORMAT = 'That doesn’t look like a NoneCap key (nc_live_…)';
export const HINT_REJECTED = 'Key was rejected by the API';
export const HINT_UNREACHABLE =
  'Could not reach the extension background. Try reloading the extension.';

export type KeyError = 'format' | 'rejected' | 'unreachable' | null;

export function keyHint(err: KeyError): string {
  if (err === 'format') return HINT_FORMAT;
  if (err === 'rejected') return HINT_REJECTED;
  if (err === 'unreachable') return HINT_UNREACHABLE;
  return HINT_DEFAULT;
}

/**
 * `nc_live_a1b2c3d4e5f6` → `nc_live_••••e5f6`.
 *
 * Precondition: real keys always match KEY_RE (≥ 16 chars), so the prefix and
 * suffix slices never overlap. Anything shorter (corrupt storage, tests) falls
 * back to a fully masked stub instead of leaking overlapping slices.
 */
export function maskKey(key: string): string {
  if (key.length < 12) return 'nc_••••';
  return `${key.slice(0, 8)}••••${key.slice(-4)}`;
}

/** "6h 12m" / "42m" until `resetsAt` (UTC ISO), clamped at "0m". */
export function formatResetsIn(resetsAt: string, now: number): string {
  const target = Date.parse(resetsAt);
  if (Number.isNaN(target)) return '—';
  const mins = Math.max(0, Math.ceil((target - now) / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Grouped number for the usage row (deterministic locale). */
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/** `0.991` → `"99.1%"`; null → em dash. */
export function formatSolveRate(rate: number | null): string {
  if (rate === null) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

/** Free-credit progress bar percentage, clamped to 0–100. */
export function creditsPct(remaining: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(100, (remaining / max) * 100));
}

const SOLVING_PHASES: readonly Phase[] = ['detected', 'opening', 'solving', 'verifying'];

export function isSolvingPhase(phase: Phase): boolean {
  return SOLVING_PHASES.includes(phase);
}

export function phaseLabel(phase: Phase): string {
  switch (phase) {
    case 'detected':
      return 'Captcha detected';
    case 'opening':
      return 'Opening challenge…';
    case 'solving':
      return 'Solving challenge…';
    case 'verifying':
      return 'Verifying…';
    default:
      return '';
  }
}
