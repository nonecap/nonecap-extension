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

/**
 * Challenge-frame geometry, the reply to GET_GEOMETRY. Every Pt is in
 * IFRAME-LOCAL CSS viewport coordinates (the background adds the challenge
 * iframe's top-frame rect origin before dispatching trusted input).
 */
export type Geometry = {
  /** Tile centres in 1-based reading order: array index 0 = tile 1. */
  tiles: Pt[];
  /**
   * The `.button-submit` centre and whether it currently reads "Skip"
   * (hCaptcha reuses the element for Verify/Next AND Skip — clicking it
   * while it reads Skip throws the challenge away, so the background
   * refuses while isSkip is true).
   */
  verify: { center: Pt; isSkip: boolean } | null;
  /** The refresh button centre, if present. */
  refresh: Pt | null;
};

/** Cosmetic-cursor operations the background sequences in the challenge frame. */
export type CursorOp = 'move' | 'press' | 'release' | 'click';

export type Msg =
  | { t: 'CHECKBOX_SEEN' } // anchor frame → bg
  | { t: 'CHALLENGE_READY'; task: 'grid' | 'single' } // challenge frame → bg
  | { t: 'CHALLENGE_GONE' } // challenge frame → bg
  | { t: 'GET_CHALLENGE_RECT' } // bg → top frame; reply: { rect: RectLike; dpr: number } | null
  | { t: 'GET_GEOMETRY' } // bg → challenge frame; reply: Geometry | null
  // bg → challenge frame; fire-and-forget (no reply). x/y are iframe-local CSS
  // viewport coords; the frame only animates the cosmetic cursor — the
  // background owns sequencing and dispatches the real (trusted CDP) input.
  | { t: 'CURSOR'; op: CursorOp; x?: number; y?: number }
  | { t: 'PHASE'; phase: Phase; detail?: { secs?: string; credits?: number } } // bg → top frame + popup
  | { t: 'SOLVED'; secs: number } // top frame → bg
  | { t: 'OPEN_OPTIONS' } // top frame → bg; no reply (content scripts cannot open extension pages)
  | { t: 'GET_STATE' } // popup → bg; reply: PopupState
  | { t: 'SET_PAUSE'; host: string; paused: boolean } // popup → bg
  | { t: 'CONNECT_KEY'; key: string } // popup → bg; reply: { ok: boolean }
  | { t: 'DISCONNECT_KEY' }; // popup → bg

/** Reply to GET_CHALLENGE_RECT. */
export type ChallengeRectReply = { rect: RectLike; dpr: number } | null;

/** Reply to GET_GEOMETRY. */
export type GeometryReply = Geometry | null;

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
