// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Phase } from '../shared/messages';
import { createPill, type PillHandle } from './pill';

let pill: PillHandle | null = null;

function makePill(opts: { onCta?: () => void } = {}): PillHandle {
  pill = createPill(document, opts);
  return pill;
}

function host(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-nonecap="pill"]');
  if (!el) throw new Error('pill host not found');
  return el;
}

function shadow(): ShadowRoot {
  const root = host().shadowRoot;
  if (!root) throw new Error('pill shadow root not found');
  return root;
}

function statusText(): string | null {
  return shadow().querySelector('.p-status')?.textContent ?? null;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  pill?.destroy();
  pill = null;
});

describe('createPill', () => {
  it('mounts a hidden shadow host with the pill inside', () => {
    makePill();
    expect(host().style.display).toBe('none');
    expect(shadow().querySelector('.nc-pill')).not.toBeNull();
    expect(host().style.pointerEvents).toBe('none');
  });
});

describe('setPhase', () => {
  it('renders the phase labels from the design mapping', () => {
    const p = makePill();
    const labels: Partial<Record<Phase, string>> = {
      detected: 'Captcha detected',
      opening: 'Opening challenge',
      solving: 'Solving',
      verifying: 'Verifying',
    };
    for (const [phase, label] of Object.entries(labels) as [Phase, string][]) {
      p.setPhase(phase);
      expect(host().style.display).not.toBe('none');
      expect(statusText()).toBe(label);
      expect(shadow().querySelector('.nc-mark')).not.toBeNull();
    }
  });

  it('shows a pulsing dot for detected and a spinner for busy phases', () => {
    const p = makePill();
    p.setPhase('detected');
    expect(shadow().querySelector('.p-dot.pulse')).not.toBeNull();
    expect(shadow().querySelector('.p-spin')).toBeNull();
    for (const phase of ['opening', 'solving', 'verifying'] as const) {
      p.setPhase(phase);
      expect(shadow().querySelector('.p-spin'), phase).not.toBeNull();
      expect(shadow().querySelector('.p-dot'), phase).toBeNull();
    }
  });

  it('solved shows the secs and a credits sub-label with pluralization', () => {
    const p = makePill();
    p.setPhase('solved', { secs: '4.2', credits: 1 });
    expect(statusText()).toBe('Solved in 4.2s');
    expect(shadow().querySelector('.p-check')?.textContent).toBe('✓');
    expect(shadow().querySelector('.p-sub')?.textContent).toBe('−1 credit');

    p.setPhase('solved', { secs: '12.0', credits: 3 });
    expect(statusText()).toBe('Solved in 12.0s');
    expect(shadow().querySelector('.p-sub')?.textContent).toBe('−3 credits');
  });

  it('solved without detail omits the secs and the sub-label', () => {
    const p = makePill();
    p.setPhase('solved');
    expect(statusText()).toBe('Solved');
    expect(shadow().querySelector('.p-sub')).toBeNull();
  });

  it('blocked shows the warn pill with the Add API key CTA', () => {
    const onCta = vi.fn();
    const p = makePill({ onCta });
    p.setPhase('blocked');
    expect(shadow().querySelector('.nc-pill.warn')).not.toBeNull();
    expect(statusText()).toBe('Out of free solves');
    const cta = shadow().querySelector<HTMLButtonElement>('.p-cta');
    expect(cta?.textContent).toBe('Add API key');
    cta?.click();
    expect(onCta).toHaveBeenCalledTimes(1);
  });

  it('error renders as a warn pill', () => {
    const p = makePill();
    p.setPhase('error');
    expect(shadow().querySelector('.nc-pill.warn')).not.toBeNull();
    expect(statusText()).toBe('Solve failed');
  });

  it('idle and paused hide the host', () => {
    const p = makePill();
    p.setPhase('solving');
    expect(host().style.display).not.toBe('none');
    p.setPhase('idle');
    expect(host().style.display).toBe('none');
    p.setPhase('solving');
    p.setPhase('paused');
    expect(host().style.display).toBe('none');
  });

  it('drops the warn class again after leaving blocked', () => {
    const p = makePill();
    p.setPhase('blocked');
    p.setPhase('solving');
    expect(shadow().querySelector('.nc-pill.warn')).toBeNull();
  });
});

describe('setVisible', () => {
  it('hides the pill even in an active phase and restores it later', () => {
    const p = makePill();
    p.setPhase('solving');
    p.setVisible(false);
    expect(host().style.display).toBe('none');
    p.setVisible(true);
    expect(host().style.display).not.toBe('none');
    expect(statusText()).toBe('Solving');
  });
});

describe('destroy', () => {
  it('removes the host node from the document', () => {
    const p = makePill();
    p.setPhase('solving');
    p.destroy();
    expect(document.querySelector('[data-nonecap="pill"]')).toBeNull();
    // Idempotent + inert after destroy.
    p.destroy();
    p.setPhase('solving');
    expect(document.querySelector('[data-nonecap="pill"]')).toBeNull();
  });
});
