/**
 * Animated synthetic cursor rendered inside the hCaptcha frame.
 * Vanilla-TS port of the design reference (solver.jsx + styles.css).
 *
 * No chrome.* here — index.ts reads settings and passes the speed in.
 */

import type { Cursor } from './executor';
import { moveDuration, ncTween, ncWait } from './tween';
import cursorCss from './cursor.css?inline';

const ARROW_SVG =
  '<svg width="21" height="24" viewBox="0 0 21 24">' +
  '<path d="M3 1 L3 19.5 L7.8 15.2 L10.7 22.4 L14.1 21 L11.2 13.9 L17.6 13.6 Z" ' +
  'fill="#ffffff" stroke="#16161a" stroke-width="1.4" stroke-linejoin="round"></path>' +
  '</svg>';

export class AnimatedCursor implements Cursor {
  private readonly root: HTMLElement;
  private readonly cur: HTMLElement;
  private readonly ripple: HTMLElement;
  private pos = { x: 0, y: 0 };
  speed: number;

  constructor(doc: Document = document, speed = 1) {
    this.speed = speed;

    const root = doc.createElement('div');
    root.setAttribute('data-nonecap', '');
    root.className = 'nc-root';
    root.style.pointerEvents = 'none';

    const style = doc.createElement('style');
    style.textContent = cursorCss;
    root.appendChild(style);

    const ripple = doc.createElement('div');
    ripple.className = 'nc-ripple';
    root.appendChild(ripple);

    const cur = doc.createElement('div');
    cur.className = 'nc-cursor';
    const inner = doc.createElement('div');
    inner.className = 'cur-inner';
    const glow = doc.createElement('div');
    glow.className = 'cur-glow';
    inner.appendChild(glow);
    inner.insertAdjacentHTML('beforeend', ARROW_SVG);
    cur.appendChild(inner);
    root.appendChild(cur);

    (doc.body ?? doc.documentElement).appendChild(root);
    this.root = root;
    this.cur = cur;
    this.ripple = ripple;
  }

  private place(x: number, y: number): void {
    this.pos = { x, y };
    this.cur.style.transform = `translate(${x}px,${y}px)`;
  }

  showAt(x: number, y: number): void {
    this.place(x, y);
    this.cur.style.transition = 'opacity 350ms ease';
    this.cur.style.opacity = '1';
  }

  hide(): void {
    this.cur.style.opacity = '0';
    this.cur.classList.remove('glowing', 'pressing');
  }

  setGlow(on: boolean): void {
    this.cur.classList.toggle('glowing', on);
  }

  async moveTo(x: number, y: number): Promise<void> {
    // Make sure the cursor is visible before it travels.
    if (this.cur.style.opacity !== '1') this.showAt(this.pos.x, this.pos.y);
    const from = { ...this.pos };
    const dist = Math.hypot(x - from.x, y - from.y);
    await ncTween(moveDuration(dist, this.speed), (e) => {
      this.place(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    });
  }

  press(): void {
    this.cur.classList.add('pressing');
  }

  release(): void {
    this.cur.classList.remove('pressing');
  }

  async click(): Promise<void> {
    this.cur.classList.add('pressing');
    // Ripple at the cursor tip.
    this.ripple.style.left = `${this.pos.x}px`;
    this.ripple.style.top = `${this.pos.y}px`;
    this.ripple.classList.remove('go');
    void this.ripple.offsetWidth; // restart the animation
    this.ripple.classList.add('go');
    await ncWait(130 / this.speed);
    this.cur.classList.remove('pressing');
  }

  getPos(): { x: number; y: number } {
    return { ...this.pos };
  }

  /** Remove the cursor layer from the document. */
  destroy(): void {
    this.root.remove();
  }
}

export type { Cursor };
