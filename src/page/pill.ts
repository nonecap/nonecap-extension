/**
 * On-page status pill (shadow-DOM), driven by PHASE messages from the
 * background. Faithful port of the design prototype's NCPill component.
 *
 * Platform-pure: DOM only, no chrome.* — the CTA action is injected by the
 * caller (src/page/index.ts) so this module stays jsdom-testable.
 */

import { assertNever, type Phase } from '../shared/messages';
import pillCss from './pill.css?inline';

export type PillDetail = { secs?: string; credits?: number };

export type PillHandle = {
  /** Render the given phase. 'idle' / 'paused' hide the pill. */
  setPhase(phase: Phase, detail?: PillDetail): void;
  /** Anchor element (the checkbox widget iframe) the pill floats above. */
  setAnchor(anchor: Element | null): void;
  /** Master visibility gate (showOverlay setting / dark mode). */
  setVisible(visible: boolean): void;
  /** Remove the pill and all listeners. */
  destroy(): void;
};

const PILL_HEIGHT = 38;
const ANCHOR_GAP = 10;
const VIEWPORT_MARGIN = 8;

const BUSY_LABELS = {
  detected: 'Captcha detected',
  opening: 'Opening challenge',
  solving: 'Solving',
  verifying: 'Verifying',
} as const;

export function createPill(doc: Document, opts: { onCta?: () => void } = {}): PillHandle {
  const win = doc.defaultView ?? window;

  const host = doc.createElement('div');
  host.setAttribute('data-nonecap', 'pill');
  Object.assign(host.style, {
    position: 'fixed',
    top: '16px',
    right: '16px',
    zIndex: '2147483647',
    pointerEvents: 'none',
    display: 'none',
  });
  const shadow = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = pillCss;
  shadow.appendChild(style);
  const pill = doc.createElement('div');
  pill.className = 'nc-pill';
  shadow.appendChild(pill);
  (doc.body ?? doc.documentElement).appendChild(host);

  let phase: Phase = 'idle';
  let detail: PillDetail | undefined;
  let visible = true;
  let anchor: Element | null = null;
  let destroyed = false;

  function el(tag: string, className: string, text?: string): HTMLElement {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---- positioning: float just above (else below) the checkbox widget ------

  function reposition(): void {
    if (host.style.display === 'none') return;
    const rect = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
    if (!rect || rect.width * rect.height === 0) {
      // No (visible) widget to anchor to — park top-right of the viewport.
      host.style.top = '16px';
      host.style.right = '16px';
      return;
    }
    const above = rect.top - PILL_HEIGHT - ANCHOR_GAP;
    const top = above >= VIEWPORT_MARGIN ? above : rect.bottom + ANCHOR_GAP;
    host.style.top = `${Math.max(VIEWPORT_MARGIN, top)}px`;
    host.style.right = `${Math.max(VIEWPORT_MARGIN, win.innerWidth - rect.right)}px`;
  }

  let rafPending = false;
  function scheduleReposition(): void {
    if (rafPending || destroyed) return;
    rafPending = true;
    const raf =
      typeof win.requestAnimationFrame === 'function'
        ? win.requestAnimationFrame.bind(win)
        : (cb: FrameRequestCallback) => win.setTimeout(() => cb(win.performance.now()), 16);
    raf(() => {
      rafPending = false;
      if (!destroyed) reposition();
    });
  }
  win.addEventListener('scroll', scheduleReposition, { capture: true, passive: true });
  win.addEventListener('resize', scheduleReposition, { passive: true });

  // ---- rendering ------------------------------------------------------------

  function render(): void {
    const hidden = !visible || phase === 'idle' || phase === 'paused';
    host.style.display = hidden ? 'none' : 'block';
    if (hidden) return;

    pill.classList.toggle('warn', phase === 'blocked' || phase === 'error');
    pill.replaceChildren();
    pill.appendChild(el('div', 'nc-mark'));

    switch (phase) {
      case 'blocked': {
        pill.appendChild(el('span', 'p-dot'));
        pill.appendChild(el('span', 'p-status', 'Out of free solves'));
        const cta = el('button', 'p-cta', 'Add API key') as HTMLButtonElement;
        cta.type = 'button';
        cta.addEventListener('click', () => opts.onCta?.());
        pill.appendChild(cta);
        break;
      }
      case 'error':
        pill.appendChild(el('span', 'p-dot'));
        pill.appendChild(el('span', 'p-status', 'Solve failed'));
        break;
      case 'solved': {
        pill.appendChild(el('span', 'p-check', '✓'));
        const secs = detail?.secs;
        pill.appendChild(el('span', 'p-status', secs !== undefined ? `Solved in ${secs}s` : 'Solved'));
        const credits = detail?.credits;
        if (credits !== undefined) {
          pill.appendChild(el('span', 'p-sub', `−${credits} credit${credits === 1 ? '' : 's'}`));
        }
        break;
      }
      case 'detected':
      case 'opening':
      case 'solving':
      case 'verifying': {
        const busy = phase !== 'detected';
        pill.appendChild(el('span', busy ? 'p-spin' : 'p-dot pulse'));
        pill.appendChild(el('span', 'p-status', BUSY_LABELS[phase]));
        break;
      }
      case 'idle':
      case 'paused':
        break; // unreachable: hidden above
      default:
        assertNever(phase);
    }
    reposition();
  }

  return {
    setPhase(nextPhase, nextDetail) {
      if (destroyed) return;
      phase = nextPhase;
      detail = nextDetail;
      render();
    },
    setAnchor(nextAnchor) {
      if (destroyed || nextAnchor === anchor) return;
      anchor = nextAnchor;
      scheduleReposition();
    },
    setVisible(nextVisible) {
      if (destroyed || nextVisible === visible) return;
      visible = nextVisible;
      render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      win.removeEventListener('scroll', scheduleReposition, true);
      win.removeEventListener('resize', scheduleReposition);
      host.remove();
    },
  };
}
