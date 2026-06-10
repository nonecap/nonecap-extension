/**
 * Top-frame content script. Runs on <all_urls> at document_idle.
 *
 * Roles:
 *   - find the hCaptcha widget iframes on the page (lazily — many pages
 *     inject hCaptcha late);
 *   - answer the background's GET_CHALLENGE_RECT with the challenge iframe's
 *     viewport rect + devicePixelRatio (for screenshot cropping);
 *   - render the on-page status pill, driven by PHASE messages;
 *   - watch the h-captcha-response token fields and report SOLVED {secs};
 *   - stay dark on blocklisted/paused hosts (defense in depth — the
 *     background gates too).
 *
 * This is the ONLY module under src/page that touches chrome.* —
 * widgets.ts and pill.ts stay platform-pure.
 */

import type { ChallengeRectReply, Msg } from '../shared/messages';
import type { Settings } from '../shared/settings';
import { get, subscribe } from '../shared/storage';
import { createPill } from './pill';
import { findTokenFields, findWidgetFrames, getChallengeRect } from './widgets';

declare global {
  interface Window {
    /** Double-init guard — re-injection must not install duplicate listeners. */
    __ncPage?: boolean;
  }
}

const SCAN_MS = 500;
const TOKEN_POLL_MS = 300;
const MUTATION_DEBOUNCE_MS = 100;

/** Fire-and-forget send; swallows "no receiver" / invalidated-context errors. */
function send(msg: Msg): void {
  try {
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  } catch {
    // Extension context invalidated (e.g. extension reloaded) — ignore.
  }
}

function init(): void {
  const host = location.hostname;

  // ---- settings gates -------------------------------------------------------

  let blocklisted = false; // host on the blocklist → fully dark
  let paused = false; // host paused → pill hidden, nothing served
  let showOverlay = true;

  /** Dark = serve no rects, watch no tokens, send nothing. */
  const dark = (): boolean => blocklisted || paused;

  const pill = createPill(document, {
    // Content scripts cannot open the popup, and web-origin window.open to a
    // non-web-accessible extension page is blocked — the "Add API key" CTA
    // asks the background to open the options page instead.
    onCta: () => {
      send({ t: 'OPEN_OPTIONS' });
    },
  });

  function applySettings(settings: Settings): void {
    blocklisted = settings.blocklist.includes(host);
    paused = settings.pausedHosts.includes(host);
    showOverlay = settings.showOverlay;
    pill.setVisible(showOverlay && !dark());
  }

  void get('settings')
    .then(applySettings)
    .catch(() => undefined);
  subscribe((changes) => {
    if (changes.settings) applySettings(changes.settings);
  });

  // ---- widget tracking (pill anchor) ----------------------------------------

  function scan(): void {
    if (dark()) {
      pill.setAnchor(null);
      return;
    }
    pill.setAnchor(findWidgetFrames(document).checkbox);
  }

  // ---- solve timer + token watcher -------------------------------------------

  /** Set on PHASE 'detected'; cleared once SOLVED is sent. */
  let timerStart: number | null = null;
  /** Edge guard: one SOLVED per token appearance, re-armed when it clears. */
  let solvedFired = false;

  function checkTokens(): void {
    if (dark()) return;
    let anyToken = false;
    for (const field of findTokenFields(document)) {
      if (field.value.trim().length > 0) {
        anyToken = true;
        break;
      }
    }
    if (anyToken && !solvedFired) {
      solvedFired = true;
      // Timer never started ⇒ passive pass (no challenge ever opened) ⇒ 0s.
      const secs = timerStart === null ? 0 : Math.round((performance.now() - timerStart) / 100) / 10;
      timerStart = null;
      send({ t: 'SOLVED', secs });
    } else if (!anyToken && solvedFired) {
      solvedFired = false; // token cleared (expiry / widget reset) → re-arm
    }
  }

  // ---- DOM observation: lazy widgets + token writes ---------------------------

  let pokeScheduled = false;
  function poke(): void {
    if (pokeScheduled) return;
    pokeScheduled = true;
    setTimeout(() => {
      pokeScheduled = false;
      scan();
      checkTokens();
    }, MUTATION_DEBOUNCE_MS);
  }

  const observer = new MutationObserver(poke);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(scan, SCAN_MS);
  setInterval(checkTokens, TOKEN_POLL_MS);
  scan();
  checkTokens();

  // ---- background message router ----------------------------------------------

  chrome.runtime.onMessage.addListener(
    (raw: unknown, _sender, sendResponse: (reply: ChallengeRectReply) => void): undefined => {
      const msg = raw as Msg;
      if (!msg || typeof msg !== 'object') return undefined;
      switch (msg.t) {
        case 'GET_CHALLENGE_RECT':
          // Synchronous reply — no need to return true / keep the port open.
          sendResponse(dark() ? null : getChallengeRect(document));
          return undefined;
        case 'PHASE':
          if (msg.phase === 'detected') timerStart = performance.now();
          pill.setPhase(msg.phase, msg.detail);
          return undefined;
        default:
          // All other Msg variants target the background / hcaptcha frames.
          return undefined;
      }
    },
  );

  console.debug('[nonecap] page content script loaded');
}

if (!window.__ncPage) {
  window.__ncPage = true;
  init();
}

export {};
