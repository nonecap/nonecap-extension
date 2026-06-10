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
import { findCheckbox, frameKind } from './detect';
import { createChallengeController } from './challenge-state';
import { AnimatedCursor } from './cursor';
import { clickElement, exec } from './executor';
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
let executing = false;

// anchor frame
let checkboxAnnounced = false;

// challenge frame
let sawContainer = false;
let goneSent = false;

/**
 * Edge-triggered readiness + post-exec re-arm probe (atomic single-challenge
 * round swaps never pass through not-ready). Logic lives in challenge-state.ts.
 */
const challenge = createChallengeController({
  doc: document,
  sendReady: (task) => send({ t: 'CHALLENGE_READY', task }),
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
  challenge.teardown(); // cancels the post-exec re-arm probe
  cursor?.destroy();
  cursor = null;
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

  // ---- EXEC handler ----------------------------------------------------------

  chrome.runtime.onMessage.addListener(
    (msg: Msg, _sender, sendResponse: (reply: ExecReply) => void): boolean | undefined => {
      if (!msg || msg.t !== 'EXEC') return undefined;
      // Only the challenge frame executes actions.
      if (frameKind(document) !== 'challenge') return undefined;
      // One action at a time — a concurrent EXEC is rejected, never queued.
      if (executing) {
        sendResponse({ done: false });
        return true;
      }
      void (async () => {
        executing = true;
        challenge.execStarted();
        try {
          const speed = await speedFromSettings();
          const done = await exec(msg.action, ensureCursor(speed), speed);
          sendResponse({ done });
        } catch (err) {
          console.debug('[nonecap] exec failed', err);
          sendResponse({ done: false });
        } finally {
          executing = false;
          // Disarm + start the re-arm probe: the next CHALLENGE_READY fires
          // via not-ready→ready (grids) or via the probe when the challenge
          // is still present and ready after the floor (atomic single swaps,
          // rejected answers).
          challenge.execFinished();
        }
      })();
      return true; // keep the message channel open for the async reply
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
