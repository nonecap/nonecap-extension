/**
 * Pure DOM helpers for tracking hCaptcha widget iframes from the TOP frame.
 *
 * Platform-pure: operates on a `Document` only (jsdom-testable), no chrome.*
 *
 * hCaptcha embeds two kinds of iframes from newassets.hcaptcha.com:
 *   - the CHECKBOX iframe sits inline in the page (inside div.h-captcha);
 *   - the CHALLENGE iframe is appended near document.body in a floating
 *     container when a challenge opens, sized to the challenge popup.
 * Which is which is encoded in a `frame=` parameter that appears either as a
 * real query param (`?frame=checkbox`) or inside a hash-encoded query
 * (`#endpoint=…&frame=challenge`).
 */

import type { RectLike } from '../shared/messages';

const HCAPTCHA_HOST = 'newassets.hcaptcha.com';

export type FrameRole = 'checkbox' | 'challenge';

export type WidgetFrames = {
  checkbox: HTMLIFrameElement | null;
  challenge: HTMLIFrameElement | null;
};

/** Classify an iframe src as the hCaptcha checkbox or challenge frame. */
export function classifyFrame(src: string): FrameRole | null {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.hostname !== HCAPTCHA_HOST) return null;
  // Real query param first, then the hash-encoded query hCaptcha uses.
  let frame = url.searchParams.get('frame');
  if (frame === null && url.hash.length > 1) {
    frame = new URLSearchParams(url.hash.slice(1)).get('frame');
  }
  return frame === 'checkbox' || frame === 'challenge' ? frame : null;
}

function area(el: Element): number {
  const r = el.getBoundingClientRect();
  return r.width * r.height;
}

/**
 * Find the hCaptcha widget iframes on the page.
 *
 * For the challenge, the latest VISIBLE frame wins (nonzero bounding-rect
 * area); zero-area frames are only used as a fallback when no visible one
 * exists. Same preference for the checkbox, which pages occasionally
 * duplicate in hidden templates.
 */
export function findWidgetFrames(doc: Document): WidgetFrames {
  let checkbox: HTMLIFrameElement | null = null;
  let checkboxVisible = false;
  let challenge: HTMLIFrameElement | null = null;
  let challengeVisible = false;

  for (const frame of doc.querySelectorAll<HTMLIFrameElement>(`iframe[src*="${HCAPTCHA_HOST}"]`)) {
    const role = classifyFrame(frame.src);
    if (role === null) continue;
    const visible = area(frame) > 0;
    if (role === 'checkbox') {
      // First visible checkbox wins; first overall as fallback.
      if ((visible && !checkboxVisible) || checkbox === null) {
        checkbox = frame;
        checkboxVisible = visible;
      }
    } else {
      // Latest visible challenge wins; latest overall as fallback.
      if (visible) {
        challenge = frame;
        challengeVisible = true;
      } else if (!challengeVisible) {
        challenge = frame;
      }
    }
  }
  return { checkbox, challenge };
}

/**
 * The challenge iframe's viewport rect (CSS px) + devicePixelRatio, in the
 * shape the background needs for cropping the tab screenshot.
 * Null when there is no challenge iframe or it has zero area.
 */
export function getChallengeRect(doc: Document): { rect: RectLike; dpr: number } | null {
  const { challenge } = findWidgetFrames(doc);
  if (!challenge) return null;
  const r = challenge.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  const dpr = doc.defaultView?.devicePixelRatio ?? 1;
  return { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, dpr };
}

const TOKEN_SELECTORS = [
  'textarea[name="h-captcha-response"]',
  'textarea[name="g-recaptcha-response"]',
] as const;

/**
 * The hidden token fields hCaptcha fills on success. Each widget has an
 * `h-captcha-response` textarea and usually a `g-recaptcha-response` alias.
 */
export function findTokenFields(doc: Document): HTMLTextAreaElement[] {
  const out = new Set<HTMLTextAreaElement>();
  for (const selector of TOKEN_SELECTORS) {
    for (const el of doc.querySelectorAll<HTMLTextAreaElement>(selector)) out.add(el);
  }
  return [...out];
}
