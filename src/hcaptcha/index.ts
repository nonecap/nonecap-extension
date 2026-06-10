/**
 * Content script for the hCaptcha frames (anchor + challenge).
 *
 * Runs in every frame on https://newassets.hcaptcha.com/*. Reports readiness
 * to the background hub and executes the actions it sends back. This is the
 * ONLY module under src/hcaptcha that touches chrome.* — detect.ts and
 * executor.ts stay platform-pure.
 *
 * Background protocol (src/shared/messages.ts):
 *   send CHECKBOX_SEEN      → reply { proceed: boolean }: gate for clicking
 *                             the checkbox locally (no reply ⇒ do NOT click)
 *   send CHALLENGE_READY    (edge-triggered, after DOM-stability debounce)
 *   send CHALLENGE_GONE     (container removed / frame unloading)
 *   recv EXEC { action }    → reply { done: boolean }
 */

import type { ExecReply, Msg } from '../shared/messages';
import { get } from '../shared/storage';
import { findCheckbox, frameKind, gridReady, singleReady, taskHint } from './detect';
import { AnimatedCursor } from './cursor';
import { dispatchClick, exec } from './executor';
import { ncWait } from './tween';

const POLL_MS = 250;
const STABLE_MS_GRID = 300;
const STABLE_MS_SINGLE = 500;

// ---- state ----------------------------------------------------------------

let cursor: AnimatedCursor | null = null;
let executing = false;

// anchor frame
let checkboxAnnounced = false;

// challenge frame (edge-triggered readiness)
let sawContainer = false;
let goneSent = false;
/** True when we may announce the next ready state (re-set by a not-ready observation). */
let armed = true;
let lastDomChangeAt = 0;

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
  await cur.moveTo(cx, cy);
  dispatchClick(document, cx, cy, checkbox);
  await cur.click();
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

function resetChallengeState(): void {
  armed = true;
  goneSent = false;
}

function tickChallenge(): void {
  if (executing) return;
  const hint = taskHint(document);
  const ready = hint === 'grid' ? gridReady(document) : singleReady(document);
  if (!ready) {
    // Passing through not-ready re-arms the ready edge (e.g. next round's
    // placeholders after an EXEC invalidated the previous state).
    armed = true;
    return;
  }
  if (!armed) return;
  const stableMs = hint === 'single' ? STABLE_MS_SINGLE : STABLE_MS_GRID;
  if (Date.now() - lastDomChangeAt < stableMs) return; // wait for DOM to settle
  armed = false;
  send({ t: 'CHALLENGE_READY', task: hint });
}

function sendGone(): void {
  if (!sawContainer || goneSent) return;
  goneSent = true;
  send({ t: 'CHALLENGE_GONE' });
}

// ---- main loop ------------------------------------------------------------------

function tick(): void {
  const kind = frameKind(document);
  if (kind === 'anchor') {
    tickAnchor();
    return;
  }
  if (kind === 'challenge') {
    if (sawContainer && goneSent) resetChallengeState(); // a new challenge appeared
    sawContainer = true;
    goneSent = false;
    tickChallenge();
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

const observer = new MutationObserver((records) => {
  if (!relevantMutation(records)) return;
  lastDomChangeAt = Date.now();
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

// ---- EXEC handler ------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (msg: Msg, _sender, sendResponse: (reply: ExecReply) => void): boolean | undefined => {
    if (!msg || msg.t !== 'EXEC') return undefined;
    // Only the challenge frame executes actions.
    if (frameKind(document) !== 'challenge') return undefined;
    void (async () => {
      executing = true;
      try {
        const speed = await speedFromSettings();
        const done = await exec(msg.action, ensureCursor(speed), speed);
        sendResponse({ done });
      } catch (err) {
        console.debug('[nonecap] exec failed', err);
        sendResponse({ done: false });
      } finally {
        executing = false;
        // Invalidate the previous ready state: the next CHALLENGE_READY only
        // fires after the DOM passes through not-ready and settles again.
        armed = false;
        lastDomChangeAt = Date.now();
      }
    })();
    return true; // keep the message channel open for the async reply
  },
);

console.debug('[nonecap] hcaptcha frame script loaded');
