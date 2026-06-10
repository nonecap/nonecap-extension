/**
 * Pure DOM detection helpers for the hCaptcha frames.
 *
 * Platform-pure: operates on a `Document` only (jsdom-testable), no chrome.*
 * Selectors are the ones proven in production by the NoneCap solver — keep
 * the fallback order exactly as written.
 */

const CHECKBOX_SELECTORS = ['#checkbox', '[role=checkbox]', '#anchor', '.check'];
const CONTAINER_SELECTORS = ['.challenge-container', '.interface-challenge', '.challenge'];
const VERIFY_SELECTORS = ['.button-submit'];
const REFRESH_SELECTORS = ['.refresh.button', '.button.refresh', '.refresh'];
const PROMPT_SELECTOR = '.prompt-text, .challenge-prompt';

/**
 * First match honoring the FALLBACK ORDER of the selectors (a plain CSS
 * selector list would return the first match in document order instead).
 */
function firstMatch(doc: Document, selectors: readonly string[]): Element | null {
  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    if (el) return el;
  }
  return null;
}

export type FrameKind = 'anchor' | 'challenge';
export type TaskHint = 'grid' | 'single';

/** Which hCaptcha frame is this document? `null` until it has rendered. */
export function frameKind(doc: Document): FrameKind | null {
  if (firstMatch(doc, CONTAINER_SELECTORS)) return 'challenge';
  if (firstMatch(doc, CHECKBOX_SELECTORS)) return 'anchor';
  return null;
}

/** Grid (tile selection) vs single (drag / point-on-image) challenge. */
export function taskHint(doc: Document): TaskHint {
  return doc.querySelectorAll('.task-image').length > 1 ? 'grid' : 'single';
}

/** Extract a background-image URL from the style attribute or computed style. */
function backgroundUrl(el: Element): string | null {
  // Style attribute first: hCaptcha sets `background: url(...)` inline.
  const inline = el.getAttribute('style') ?? '';
  let match = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(inline);
  if (match?.[1]) return match[1];
  // Fall back to computed style for stylesheet-applied backgrounds.
  const view = el.ownerDocument.defaultView;
  if (!view) return null;
  const computed = view.getComputedStyle(el);
  match = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(computed.backgroundImage || computed.background || '');
  return match?.[1] ?? null;
}

/**
 * A grid round is ready when there are ≥2 task images and every tile's inner
 * `.image` div carries a background-image URL (placeholders have none yet).
 */
export function gridReady(doc: Document): boolean {
  const tiles = doc.querySelectorAll('.task-image');
  if (tiles.length < 2) return false;
  for (const tile of tiles) {
    const image = tile.querySelector('.image');
    if (!image || !backgroundUrl(image)) return false;
  }
  return true;
}

/**
 * A single/drag challenge is ready when the container exists and either a
 * canvas with nonzero width exists or the prompt text is non-empty.
 * (Temporal stability — ~500ms unchanged — is the caller's responsibility.)
 */
export function singleReady(doc: Document): boolean {
  const container = firstMatch(doc, CONTAINER_SELECTORS);
  if (!container) return false;
  for (const canvas of doc.querySelectorAll('canvas')) {
    if (canvas.width > 0) return true;
  }
  const prompt = doc.querySelector(PROMPT_SELECTOR);
  return (prompt?.textContent ?? '').trim().length > 0;
}

/** The anchor frame's "I am human" checkbox. */
export function findCheckbox(doc: Document): Element | null {
  return firstMatch(doc, CHECKBOX_SELECTORS);
}

/** The challenge frame's Verify/Next button. */
export function findVerify(doc: Document): Element | null {
  return firstMatch(doc, VERIFY_SELECTORS);
}

/** The challenge frame's refresh button. */
export function findRefresh(doc: Document): Element | null {
  return firstMatch(doc, REFRESH_SELECTORS);
}

/** 1-based reading-order tile lookup (reading order = DOM order). */
export function tileAt(doc: Document, n: number): Element | null {
  if (!Number.isInteger(n) || n < 1) return null;
  return doc.querySelectorAll('.task-image')[n - 1] ?? null;
}
