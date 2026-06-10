// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyFrame, findTokenFields, findWidgetFrames, getChallengeRect } from './widgets';

const BASE = 'https://newassets.hcaptcha.com/captcha/v1/abc123/static/hcaptcha.html';

type RectInit = { x?: number; y?: number; width?: number; height?: number };

function stubRect(el: Element, init: RectInit): void {
  const x = init.x ?? 0;
  const y = init.y ?? 0;
  const width = init.width ?? 0;
  const height = init.height ?? 0;
  el.getBoundingClientRect = () =>
    ({
      x,
      y,
      width,
      height,
      top: y,
      left: x,
      right: x + width,
      bottom: y + height,
      toJSON: () => ({}),
    }) as DOMRect;
}

function addIframe(src: string, rect: RectInit = {}): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  frame.setAttribute('src', src);
  stubRect(frame, rect);
  document.body.appendChild(frame);
  return frame;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('classifyFrame', () => {
  it('parses the query-param form', () => {
    expect(classifyFrame(`${BASE}?frame=checkbox`)).toBe('checkbox');
    expect(classifyFrame(`${BASE}?frame=challenge`)).toBe('challenge');
    expect(classifyFrame(`${BASE}?sitekey=k&frame=challenge&theme=light`)).toBe('challenge');
  });

  it('parses the bare hash form', () => {
    expect(classifyFrame(`${BASE}#frame=challenge`)).toBe('challenge');
    expect(classifyFrame(`${BASE}#frame=checkbox`)).toBe('checkbox');
  });

  it('parses the hash-encoded query form hCaptcha actually uses', () => {
    expect(
      classifyFrame(`${BASE}#endpoint=https%3A%2F%2Fapi.hcaptcha.com&frame=challenge&id=0x1&host=example.com`),
    ).toBe('challenge');
    expect(classifyFrame(`${BASE}#id=0abc&host=example.com&frame=checkbox&sentry=true`)).toBe('checkbox');
  });

  it('rejects wrong hosts, including lookalikes', () => {
    expect(classifyFrame('https://evil.example.com/hcaptcha.html?frame=checkbox')).toBeNull();
    expect(classifyFrame('https://newassets.hcaptcha.com.evil.com/x.html?frame=checkbox')).toBeNull();
    expect(classifyFrame('https://hcaptcha.com/captcha.html#frame=challenge')).toBeNull();
  });

  it('rejects missing/unknown frame params and unparseable urls', () => {
    expect(classifyFrame(`${BASE}`)).toBeNull();
    expect(classifyFrame(`${BASE}?sitekey=k`)).toBeNull();
    expect(classifyFrame(`${BASE}#endpoint=x&id=1`)).toBeNull();
    expect(classifyFrame(`${BASE}?frame=banner`)).toBeNull();
    expect(classifyFrame('not a url')).toBeNull();
    expect(classifyFrame('')).toBeNull();
  });
});

describe('findWidgetFrames', () => {
  it('finds the checkbox and challenge frames', () => {
    const checkbox = addIframe(`${BASE}?frame=checkbox`, { width: 300, height: 74 });
    const challenge = addIframe(`${BASE}#frame=challenge`, { x: 10, y: 10, width: 400, height: 500 });
    const found = findWidgetFrames(document);
    expect(found.checkbox).toBe(checkbox);
    expect(found.challenge).toBe(challenge);
  });

  it('picks the nonzero-area challenge among multiple', () => {
    addIframe(`${BASE}#frame=challenge`); // zero-area (closed/hidden)
    const visible = addIframe(`${BASE}#frame=challenge`, { width: 400, height: 500 });
    addIframe(`${BASE}#frame=challenge`); // another zero-area after it
    expect(findWidgetFrames(document).challenge).toBe(visible);
  });

  it('prefers the latest visible challenge when several are visible', () => {
    addIframe(`${BASE}#frame=challenge`, { width: 100, height: 100 });
    const latest = addIframe(`${BASE}#frame=challenge`, { width: 400, height: 500 });
    expect(findWidgetFrames(document).challenge).toBe(latest);
  });

  it('falls back to a zero-area challenge when none is visible', () => {
    const only = addIframe(`${BASE}#frame=challenge`);
    expect(findWidgetFrames(document).challenge).toBe(only);
  });

  it('ignores non-hcaptcha and unclassifiable iframes', () => {
    addIframe('https://example.com/ad.html?frame=challenge', { width: 100, height: 100 });
    addIframe(`${BASE}`, { width: 100, height: 100 }); // no frame param
    const found = findWidgetFrames(document);
    expect(found.checkbox).toBeNull();
    expect(found.challenge).toBeNull();
  });
});

describe('getChallengeRect', () => {
  it('returns null when there is no challenge iframe', () => {
    addIframe(`${BASE}?frame=checkbox`, { width: 300, height: 74 });
    expect(getChallengeRect(document)).toBeNull();
  });

  it('returns null when the challenge iframe has zero area', () => {
    addIframe(`${BASE}#frame=challenge`);
    expect(getChallengeRect(document)).toBeNull();
  });

  it('maps the bounding rect to a plain RectLike with the dpr', () => {
    addIframe(`${BASE}#frame=challenge`, { x: 42, y: 17, width: 400, height: 536 });
    expect(getChallengeRect(document)).toEqual({
      rect: { x: 42, y: 17, width: 400, height: 536 },
      dpr: window.devicePixelRatio,
    });
  });

  it('reports the window devicePixelRatio', () => {
    addIframe(`${BASE}#frame=challenge`, { width: 400, height: 500 });
    const original = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    try {
      expect(getChallengeRect(document)?.dpr).toBe(2);
    } finally {
      if (original) Object.defineProperty(window, 'devicePixelRatio', original);
    }
  });
});

describe('findTokenFields', () => {
  it('finds both token field names and keeps document order per name', () => {
    document.body.innerHTML = `
      <form>
        <textarea name="h-captcha-response" id="h"></textarea>
        <textarea name="g-recaptcha-response" id="g"></textarea>
        <textarea name="unrelated" id="x"></textarea>
      </form>`;
    expect(findTokenFields(document).map((f) => f.id)).toEqual(['h', 'g']);
  });

  it('dedupes and ignores non-textarea elements with the same names', () => {
    document.body.innerHTML = `
      <textarea name="h-captcha-response" id="h"></textarea>
      <input name="h-captcha-response" id="i">
      <div name="g-recaptcha-response" id="d"></div>`;
    const fields = findTokenFields(document);
    expect(fields.map((f) => f.id)).toEqual(['h']);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it('returns an empty array when no fields exist', () => {
    expect(findTokenFields(document)).toEqual([]);
  });
});
