/**
 * Message protocol between the extension's contexts.
 *
 * The background service worker is the hub: content frames and the popup
 * only ever talk to the background, never directly to each other.
 *
 * This module is platform-pure: no chrome.* and no DOM dependencies.
 */

export type Pt = { x: number; y: number };

/** Action returned by the NoneCap API. Coordinates are normalized 0-1000 relative to the uploaded image. */
export type ExtAction =
  | { action: 'click_tiles'; tiles: number[] }
  | { action: 'click_points'; points: Pt[] }
  | { action: 'drag'; from: Pt; to: Pt; moves: { from: Pt; to: Pt }[] }
  | { action: 'refresh' };

export type Phase =
  | 'idle'
  | 'detected'
  | 'opening'
  | 'solving'
  | 'verifying'
  | 'solved'
  | 'blocked'
  | 'error'
  | 'paused';

export type RectLike = { x: number; y: number; width: number; height: number };

export type Msg =
  | { t: 'CHECKBOX_SEEN' } // anchor frame → bg
  | { t: 'CHALLENGE_READY'; task: 'grid' | 'single' } // challenge frame → bg
  | { t: 'CHALLENGE_GONE' } // challenge frame → bg
  | { t: 'GET_CHALLENGE_RECT' } // bg → top frame; reply: { rect: RectLike; dpr: number } | null
  | { t: 'EXEC'; action: ExtAction } // bg → challenge frame; reply: { done: boolean }
  | { t: 'PHASE'; phase: Phase; detail?: { secs?: string; credits?: number } } // bg → top frame + popup
  | { t: 'SOLVED'; secs: number } // top frame → bg
  | { t: 'GET_STATE' } // popup → bg; reply: PopupState
  | { t: 'SET_PAUSE'; host: string; paused: boolean } // popup → bg
  | { t: 'CONNECT_KEY'; key: string } // popup → bg; reply: { ok: boolean }
  | { t: 'DISCONNECT_KEY' }; // popup → bg

/** Reply to GET_CHALLENGE_RECT. */
export type ChallengeRectReply = { rect: RectLike; dpr: number } | null;

/** Reply to EXEC. */
export type ExecReply = { done: boolean };

/** Reply to CONNECT_KEY. */
export type ConnectKeyReply = { ok: boolean };

/** Compile-time exhaustiveness guard for switches over Msg/ExtAction/Phase. */
export function assertNever(x: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(x)}`);
}

/** Reply to GET_STATE: everything the popup needs to render every design state. */
export type PopupState = {
  phase: Phase;
  credits: { remaining: number; resetsAt: string } | null;
  userKey: string | null;
  host: string | null;
  paused: boolean;
  lastSolve: { secs: number; at: number } | null;
  stats: {
    monthSolves: number;
    monthCreditsSpent: number;
    solveRate: number | null;
  } | null;
};
