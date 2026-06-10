// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  findCheckbox,
  findRefresh,
  findVerify,
  frameKind,
  gridReady,
  singleReady,
  taskHint,
  tileAt,
} from './detect';

function setBody(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

function gridTiles(count: number, opts: { loaded?: boolean; placeholderAt?: number[] } = {}): string {
  const placeholders = new Set(opts.placeholderAt ?? []);
  let html = '<div class="challenge-container">';
  for (let i = 1; i <= count; i++) {
    const loaded = (opts.loaded ?? true) && !placeholders.has(i);
    const style = loaded ? ` style="background: url(&quot;https://imgs.hcaptcha.com/tile${i}.jpg&quot;)"` : '';
    html += `<div class="task-image" data-n="${i}"><div class="image"${style}></div></div>`;
  }
  html += '<button class="button-submit">Verify</button></div>';
  return html;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('frameKind', () => {
  it('detects the anchor frame via the checkbox selector', () => {
    expect(frameKind(setBody('<div id="anchor"><div id="checkbox"></div></div>'))).toBe('anchor');
  });

  it('detects the anchor frame via each checkbox fallback', () => {
    for (const html of [
      '<div id="checkbox"></div>',
      '<div role="checkbox"></div>',
      '<div id="anchor"></div>',
      '<div class="check"></div>',
    ]) {
      expect(frameKind(setBody(html)), html).toBe('anchor');
    }
  });

  it('detects the challenge frame via each container fallback', () => {
    for (const html of [
      '<div class="challenge-container"></div>',
      '<div class="interface-challenge"></div>',
      '<div class="challenge"></div>',
    ]) {
      expect(frameKind(setBody(html)), html).toBe('challenge');
    }
  });

  it('prefers challenge when both kinds of markers exist', () => {
    expect(frameKind(setBody('<div class="check"></div><div class="challenge"></div>'))).toBe('challenge');
  });

  it('returns null for an empty / unrelated document', () => {
    expect(frameKind(setBody(''))).toBeNull();
    expect(frameKind(setBody('<div class="something-else"></div>'))).toBeNull();
  });
});

describe('taskHint', () => {
  it('is grid for 2+ task images', () => {
    expect(taskHint(setBody(gridTiles(9)))).toBe('grid');
    expect(taskHint(setBody(gridTiles(2)))).toBe('grid');
  });

  it('is single for 0 or 1 task images', () => {
    expect(taskHint(setBody(gridTiles(1)))).toBe('single');
    expect(taskHint(setBody('<div class="challenge-container"><canvas></canvas></div>'))).toBe('single');
  });
});

describe('gridReady', () => {
  it('is true when every tile has a background-image url (style attribute)', () => {
    expect(gridReady(setBody(gridTiles(9)))).toBe(true);
  });

  it('is true when the background is set via background-image longhand', () => {
    setBody(gridTiles(2, { loaded: false }));
    for (const image of document.querySelectorAll('.task-image .image')) {
      image.setAttribute('style', "background-image: url('https://imgs.hcaptcha.com/x.jpg')");
    }
    expect(gridReady(document)).toBe(true);
  });

  it('is false while any tile is still a placeholder (no background url)', () => {
    expect(gridReady(setBody(gridTiles(9, { placeholderAt: [5] })))).toBe(false);
  });

  it('is false when a tile has no inner .image element', () => {
    setBody(gridTiles(9));
    document.querySelector('.task-image .image')?.remove();
    expect(gridReady(document)).toBe(false);
  });

  it('is false with fewer than 2 tiles', () => {
    expect(gridReady(setBody(gridTiles(1)))).toBe(false);
    expect(gridReady(setBody('<div class="challenge-container"></div>'))).toBe(false);
  });
});

describe('singleReady', () => {
  it('is true when the container has a canvas with nonzero width', () => {
    expect(singleReady(setBody('<div class="challenge"><canvas width="240" height="240"></canvas></div>'))).toBe(
      true,
    );
  });

  it('is false when the canvas width is zero and the prompt is empty', () => {
    expect(
      singleReady(setBody('<div class="challenge"><canvas width="0"></canvas><div class="prompt-text"> </div></div>')),
    ).toBe(false);
  });

  it('is true when the prompt text is non-empty (no canvas)', () => {
    expect(
      singleReady(setBody('<div class="interface-challenge"><div class="prompt-text">Drag the ball</div></div>')),
    ).toBe(true);
    expect(
      singleReady(setBody('<div class="challenge"><div class="challenge-prompt">Place the puzzle piece</div></div>')),
    ).toBe(true);
  });

  it('is false without a challenge container', () => {
    expect(singleReady(setBody('<canvas width="240"></canvas><div class="prompt-text">hi</div>'))).toBe(false);
  });
});

describe('element finders', () => {
  it('findCheckbox follows the fallback order', () => {
    setBody('<div class="check" id="late"></div><div id="checkbox"></div>');
    expect(findCheckbox(document)?.id).toBe('checkbox');
    setBody('<div class="check" id="only"></div>');
    expect(findCheckbox(document)?.id).toBe('only');
  });

  it('findVerify finds .button-submit', () => {
    setBody(gridTiles(9));
    expect(findVerify(document)?.textContent).toBe('Verify');
    expect(findVerify(setBody('<div class="challenge"></div>'))).toBeNull();
  });

  it('findRefresh follows the fallback order', () => {
    setBody('<div class="refresh" id="bare"></div><div class="refresh button" id="combo"></div>');
    expect(findRefresh(document)?.id).toBe('combo');
    setBody('<div class="refresh" id="bare"></div>');
    expect(findRefresh(document)?.id).toBe('bare');
    expect(findRefresh(setBody('<div class="challenge"></div>'))).toBeNull();
  });
});

describe('tileAt', () => {
  it('returns tiles 1-based in DOM (reading) order', () => {
    setBody(gridTiles(9));
    expect(tileAt(document, 1)?.getAttribute('data-n')).toBe('1');
    expect(tileAt(document, 5)?.getAttribute('data-n')).toBe('5');
    expect(tileAt(document, 9)?.getAttribute('data-n')).toBe('9');
  });

  it('returns null out of range or for non-positive / fractional indices', () => {
    setBody(gridTiles(4));
    expect(tileAt(document, 0)).toBeNull();
    expect(tileAt(document, 5)).toBeNull();
    expect(tileAt(document, -1)).toBeNull();
    expect(tileAt(document, 1.5)).toBeNull();
  });
});
