// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  centerOf,
  findCheckbox,
  findRefresh,
  findVerify,
  findSubmitUnlessSkip,
  frameKind,
  geometry,
  gridReady,
  singleReady,
  taskHint,
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

  it('findSubmitUnlessSkip refuses a Skip button but returns a real Verify', () => {
    // hCaptcha reuses .button-submit for both; it reads "Skip" until an answer
    // is placed. Clicking it then would skip the challenge.
    setBody('<div class="challenge"><button class="button-submit">Verify</button></div>');
    expect(findSubmitUnlessSkip(document)?.textContent).toBe('Verify');
    setBody('<div class="challenge"><button class="button-submit"> Skip </button></div>');
    expect(findSubmitUnlessSkip(document)).toBeNull();
    setBody('<div class="challenge"><button class="button-submit">SKIP</button></div>');
    expect(findSubmitUnlessSkip(document)).toBeNull();
    expect(findSubmitUnlessSkip(setBody('<div class="challenge"></div>'))).toBeNull();
  });

  it('findRefresh follows the fallback order', () => {
    setBody('<div class="refresh" id="bare"></div><div class="refresh button" id="combo"></div>');
    expect(findRefresh(document)?.id).toBe('combo');
    setBody('<div class="refresh" id="bare"></div>');
    expect(findRefresh(document)?.id).toBe('bare');
    expect(findRefresh(setBody('<div class="challenge"></div>'))).toBeNull();
  });
});

function mockRect(el: Element, x: number, y: number, w: number, h: number): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect;
}

describe('centerOf', () => {
  it('returns the bounding-rect centre in CSS viewport coords', () => {
    setBody('<div id="el"></div>');
    const el = document.querySelector('#el')!;
    mockRect(el, 100, 50, 90, 60);
    expect(centerOf(el)).toEqual({ x: 145, y: 80 });
  });
});

describe('geometry', () => {
  /** 3×3 grid with mocked layout; tile n centre = (55 + 100·col, 65 + 100·row). */
  function buildChallenge(opts: { verify?: string | null; refresh?: boolean } = {}): void {
    const verifyLabel = opts.verify === undefined ? 'Verify' : opts.verify;
    setBody(gridTiles(9));
    document.querySelectorAll('.task-image').forEach((tile, i) => {
      mockRect(tile, 10 + (i % 3) * 100, 20 + Math.floor(i / 3) * 100, 90, 90);
    });
    const button = document.querySelector('.button-submit')!;
    if (verifyLabel === null) button.remove();
    else {
      button.textContent = verifyLabel;
      mockRect(button, 350, 400, 100, 40);
    }
    if (opts.refresh) {
      const refresh = document.createElement('div');
      refresh.className = 'refresh button';
      document.querySelector('.challenge-container')!.appendChild(refresh);
      mockRect(refresh, 10, 400, 30, 30);
    }
  }

  it('returns tile centres in 1-based reading (DOM) order, iframe-local', () => {
    buildChallenge({ refresh: true });
    const geo = geometry(document)!;
    expect(geo).not.toBeNull();
    expect(geo.tiles).toHaveLength(9);
    expect(geo.tiles[0]).toEqual({ x: 55, y: 65 }); // tile 1 (index 0)
    expect(geo.tiles[1]).toEqual({ x: 155, y: 65 });
    expect(geo.tiles[3]).toEqual({ x: 55, y: 165 }); // row 2 starts at tile 4
    expect(geo.tiles[8]).toEqual({ x: 255, y: 265 }); // tile 9
  });

  it('reports the verify button centre with isSkip=false when it reads Verify', () => {
    buildChallenge();
    expect(geometry(document)!.verify).toEqual({ center: { x: 400, y: 420 }, isSkip: false });
  });

  it('still reports the centre but flags isSkip=true while the button reads Skip', () => {
    buildChallenge({ verify: ' Skip ' });
    expect(geometry(document)!.verify).toEqual({ center: { x: 400, y: 420 }, isSkip: true });
  });

  it('verify is null when the button is missing entirely', () => {
    buildChallenge({ verify: null });
    expect(geometry(document)!.verify).toBeNull();
  });

  it('refresh is the button centre when present, null when missing', () => {
    buildChallenge({ refresh: true });
    expect(geometry(document)!.refresh).toEqual({ x: 25, y: 415 });
    buildChallenge();
    expect(geometry(document)!.refresh).toBeNull();
  });

  it('has no tiles on a single (canvas) challenge but still reports the buttons', () => {
    setBody('<div class="challenge"><canvas width="500"></canvas><button class="button-submit">Skip</button></div>');
    mockRect(document.querySelector('.button-submit')!, 350, 400, 100, 40);
    const geo = geometry(document)!;
    expect(geo.tiles).toEqual([]);
    expect(geo.verify).toEqual({ center: { x: 400, y: 420 }, isSkip: true });
  });

  it('is null for the anchor frame and for unrendered/unrelated documents', () => {
    expect(geometry(setBody('<div id="anchor"><div id="checkbox"></div></div>'))).toBeNull();
    expect(geometry(setBody(''))).toBeNull();
    expect(geometry(setBody('<div class="something-else"></div>'))).toBeNull();
  });
});
