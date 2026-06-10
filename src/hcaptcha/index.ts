/**
 * Content script for the hCaptcha frames (anchor + challenge).
 *
 * Runs in every frame on https://newassets.hcaptcha.com/*. Since the
 * trusted-input switch (docs/SOLVING-ARCHITECTURE.md) the challenge frame is
 * a SENSOR + COSMETIC CURSOR HOST: all real challenge input is dispatched by
 * the background as trusted CDP events — this script never dispatches real
 * pointer events for the challenge. The anchor frame's "I am human" checkbox
 * click stays a synthetic in-frame click by design (synthetic-click.ts).
 *
 * This is the ONLY module under src/hcaptcha that touches chrome.* —
 * detect.ts, cursor.ts, challenge-state.ts and synthetic-click.ts stay
 * platform-pure.
 *
 * Background protocol (src/shared/messages.ts):
 *   send CHECKBOX_SEEN   → reply { proceed: boolean }: gate for clicking
 *                          the checkbox locally (no reply ⇒ do NOT click)
 *   send CHALLENGE_READY (edge-triggered, after DOM-stability debounce)
 *   send CHALLENGE_GONE  (container removed / frame unloading)
 *   recv GET_GEOMETRY    → reply Geometry | null (sync DOM read; null from
 *                          anchor/other frames)
 *   recv CURSOR          → fire-and-forget cosmetic-cursor op (no reply)
 */

import type { CursorOp, GeometryReply, Msg } from '../shared/messages';
import { get } from '../shared/storage';
import { findCheckbox, frameKind, geometry } from './detect';
import { createChallengeController } from './challenge-state';
import { AnimatedCursor, applyCursorOp } from './cursor';
import { clickElement } from './synthetic-click';
import { ncWait } from './tween';

declare global {
  interface Window {
    /** Double-init guard — re-injection must not install duplicate listeners. */
    __ncHcaptcha?: boolean;
  }
}

const POLL_MS = 250;

// ---- state ----------------------------------------------------------------

let cursor: AnimatedCursor | null = null;

// anchor frame
let checkboxAnnounced = false;

// challenge frame
let sawContainer = false;
let goneSent = false;

/**
 * Edge-triggered readiness + post-action re-arm probe (atomic single-challenge
 * round swaps never pass through not-ready). Logic lives in challenge-state.ts.
 * The probe is armed/heartbeaten from the message handler below: every
 * answered GET_GEOMETRY and every CURSOR op means the background is acting on
 * this round (this replaced the old in-frame EXEC finally-block trigger).
 */
const challenge = createChallengeController({
  doc: document,
  sendReady: (task) => {
    // New round: an interrupted background action (press without a matching
    // release) must never leave the cosmetic cursor stuck pressed.
    cursor?.release();
    cursor?.hide();
    send({ t: 'CHALLENGE_READY', task });
  },
});

// ---- helpers ----------------------------------------------------------------

/** Fire-and-forget send; swallows "no receiver" / invalidated-context errors. */
function send(msg: Msg): void {
  try {
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  } catch {
    // Extension context invalidated (e.g. extension reloaded) — ignore.
  }
}

function ensureCursor(speed: number): AnimatedCursor {
  if (!cursor) cursor = new AnimatedCursor(document, speed);
  cursor.speed = speed;
  return cursor;
}

async function speedFromSettings(): Promise<number> {
  const settings = await get('settings');
  return settings.style === 'fast' ? 3 : 1;
}

// ---- anchor frame -----------------------------------------------------------

async function clickCheckbox(checkbox: Element): Promise<void> {
  const speed = await speedFromSettings();
  const cur = ensureCursor(speed);
  const r = checkbox.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  // Enter from below-right of the checkbox, clamped to the (tiny) frame.
  cur.showAt(Math.min(window.innerWidth - 6, cx + 120), Math.min(window.innerHeight - 6, cy + 90));
  await ncWait(220 / speed);
  await clickElement(document, cur, checkbox);
  await ncWait(400);
  cur.hide();
}

function tickAnchor(): void {
  const checkbox = findCheckbox(document);
  if (!checkbox) {
    checkboxAnnounced = false;
    return;
  }
  if (checkboxAnnounced) return;
  checkboxAnnounced = true;
  // The reply is the gate: background answers { proceed: boolean }.
  // No reply / no listener / undefined ⇒ do NOT click.
  try {
    chrome.runtime.sendMessage({ t: 'CHECKBOX_SEEN' } satisfies Msg, (reply?: { proceed?: boolean }) => {
      if (chrome.runtime.lastError) return;
      if (!reply || reply.proceed !== true) return;
      void clickCheckbox(checkbox).catch(() => undefined);
    });
  } catch {
    // Extension context invalidated — ignore.
  }
}

// ---- challenge frame ----------------------------------------------------------

function sendGone(): void {
  if (!sawContainer || goneSent) return;
  goneSent = true;
  challenge.teardown(); // cancels the post-action re-arm probe
  cursor?.destroy(); // includes any stuck pressed state — next round starts fresh
  cursor = null;
  send({ t: 'CHALLENGE_GONE' });
}

/**
 * Serialized cosmetic-cursor ops. CURSOR messages are fire-and-forget, so
 * consecutive ops must queue behind the current animation instead of
 * overlapping mid-tween.
 */
let cursorChain: Promise<void> = Promise.resolve();

function enqueueCursorOp(op: CursorOp, x?: number, y?: number): void {
  cursorChain = cursorChain
    .then(async () => {
      if (frameKind(document) !== 'challenge') return; // frame died while queued
      const cur = ensureCursor(await speedFromSettings());
      await applyCursorOp(cur, op, x, y);
    })
    .catch(() => undefined);
}

// ---- main loop ------------------------------------------------------------------

function tick(): void {
  const kind = frameKind(document);
  if (kind === 'anchor') {
    tickAnchor();
    return;
  }
  if (kind === 'challenge') {
    sawContainer = true;
    goneSent = false;
    challenge.tick();
    return;
  }
  // No challenge container (anymore): if we had one, report it gone.
  sendGone();
}

let tickScheduled = false;
function scheduleTick(): void {
  if (tickScheduled) return;
  tickScheduled = true;
  setTimeout(() => {
    tickScheduled = false;
    tick();
  }, 50);
}

function isNonecapNode(node: Node): boolean {
  return node instanceof Element && (node.hasAttribute('data-nonecap') || node.closest('[data-nonecap]') !== null);
}

function relevantMutation(records: MutationRecord[]): boolean {
  for (const rec of records) {
    if (isNonecapNode(rec.target)) continue;
    if (rec.type === 'childList') {
      const nodes = [...rec.addedNodes, ...rec.removedNodes];
      if (nodes.length > 0 && nodes.every(isNonecapNode)) continue;
    }
    return true;
  }
  return false;
}

function init(): void {
  const observer = new MutationObserver((records) => {
    if (!relevantMutation(records)) return;
    challenge.onMutation();
    scheduleTick();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class'],
  });

  setInterval(tick, POLL_MS);
  tick();

  window.addEventListener('pagehide', () => {
    if (frameKind(document) === 'challenge' || sawContainer) sendGone();
  });

  // ---- background → frame messages -----------------------------------------

  chrome.runtime.onMessage.addListener(
    (msg: Msg, _sender, sendResponse: (reply: GeometryReply) => void): boolean | undefined => {
      if (!msg) return undefined;

      if (msg.t === 'GET_GEOMETRY') {
        // Synchronous DOM read; null from anchor/other frames. No need to
        // return true / keep the port open.
        const geo = geometry(document);
        if (geo !== null) {
          // A geometry request means the background is acting on this round:
          // disarm the ready edge and start the post-action re-arm probe
          // (the old EXEC finally-block used to do this).
          challenge.noteAction();
        }
        sendResponse(geo);
        return undefined;
      }

      if (msg.t === 'CURSOR') {
        // Cosmetic only — the trusted input already happened/happens in the
        // background. Coordinates are iframe-local, the cursor's own space.
        if (frameKind(document) !== 'challenge') return undefined;
        challenge.noteAction(); // heartbeat: keeps the probe floor behind the action
        enqueueCursorOp(msg.op, msg.x, msg.y);
        return undefined;
      }

      // All other Msg variants target the background / other frames.
      return undefined;
    },
  );

  console.debug('[nonecap] hcaptcha frame script loaded');
}

// Re-injection (extension reload, programmatic injection) must not install a
// second observer/listener set — that would double-click every target.
if (!window.__ncHcaptcha) {
  window.__ncHcaptcha = true;
  init();
}
