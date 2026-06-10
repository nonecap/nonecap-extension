// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Msg, PopupState } from '../shared/messages';
import { installChromeMock, type ChromeMock } from '../shared/test/chrome-mock';
import { Popup } from './Popup';

/**
 * Preact defers effects via requestAnimationFrame; rAF is stubbed to a 0ms
 * timeout in beforeEach, so two macrotask rounds flush effects + re-renders.
 */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const baseState = (over: Partial<PopupState> = {}): PopupState => ({
  phase: 'idle',
  credits: { remaining: 87, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() },
  userKey: null,
  host: 'formly.dev',
  paused: false,
  lastSolve: null,
  stats: null,
  ...over,
});

let mock: ChromeMock;
let container: HTMLElement;
let state: PopupState;
let sendMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    return setTimeout(() => cb(performance.now()), 0) as unknown as number;
  });
  mock = installChromeMock();
  state = baseState();
  sendMessage = vi.fn(async (msg: Msg) => {
    if (msg.t === 'GET_STATE') return state;
    if (msg.t === 'CONNECT_KEY') return { ok: false };
    return undefined;
  });
  (globalThis as { chrome: { runtime?: unknown } }).chrome.runtime = {
    sendMessage,
    openOptionsPage: vi.fn(),
  };
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
  mock.uninstall();
  vi.unstubAllGlobals();
});

async function mount(over: Partial<PopupState> = {}): Promise<void> {
  state = baseState(over);
  render(<Popup />, container);
  await flush();
}

const click = (el: Element): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};

const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush(); // let the controlled input re-render before clicking
};

describe('Popup — free tier', () => {
  it('renders the credit count, copy, bar, and reset countdown', async () => {
    await mount();
    expect(container.querySelector('.pp-credits .big')!.textContent).toBe('87');
    expect(container.querySelector('.pp-credits .of')!.textContent).toBe(
      '/ 100 free credits today',
    );
    const bar = container.querySelector('.pp-bar i') as HTMLElement;
    expect(bar.style.width).toBe('87%');
    expect(bar.classList.contains('low')).toBe(false);
    expect(container.querySelector('.pp-credits .resets')!.textContent).toContain('resets in');
    // Spec correction: per-round metering means credits, never "solves".
    expect(container.textContent).not.toContain('free solves');
    // Status chip + add-key link present.
    expect(container.querySelector('.pp-status')!.textContent).toBe('Active');
    expect(container.querySelector('.pp-keylink')).not.toBeNull();
  });

  it('marks the bar low at ≤10 percent', async () => {
    await mount({ credits: { remaining: 8, resetsAt: baseState().credits!.resetsAt } });
    expect(container.querySelector('.pp-bar i')!.classList.contains('low')).toBe(true);
  });
});

describe('Popup — out of credits', () => {
  it('shows the warn card with reset countdown and Add API key CTA', async () => {
    await mount({ credits: { remaining: 0, resetsAt: baseState().credits!.resetsAt } });
    expect(container.querySelector('.pp-credits .big')!.classList.contains('zero')).toBe(true);
    const warn = container.querySelector('.pp-warncard')!;
    expect(warn.querySelector('.w-title')!.textContent).toBe('Daily free credits used');
    expect(warn.querySelector('.w-sub')!.textContent).toContain('reset in');
    const cta = warn.querySelector('.pp-btn.full')!;
    expect(cta.textContent).toBe('Add API key');
    // The collapsed keylink is replaced by the CTA…
    expect(container.querySelector('.pp-keylink')).toBeNull();
    // …and the CTA opens the key form.
    click(cta);
    await flush();
    expect(container.querySelector('.pp-keyform input')).not.toBeNull();
  });
});

describe('Popup — key connected', () => {
  it('shows the masked key chip and credit-denominated usage stats', async () => {
    await mount({
      userKey: 'nc_live_a1b2c3d4f00d',
      credits: null,
      stats: { monthSolves: 1284, monthCreditsSpent: 6420, solveRate: null },
    });
    expect(container.querySelector('.pp-keychip .k-key')!.textContent).toBe('nc_live_••••f00d');
    expect(container.querySelector('.pp-keychip .k-plan')!.textContent).toBe(
      'Pay-as-you-go · connected',
    );
    const stats = [...container.querySelectorAll('.pp-usage .u')];
    expect(stats).toHaveLength(3);
    expect(stats[0]!.textContent).toBe('1,284solves this month');
    expect(stats[1]!.textContent).toBe('6,420credits this month');
    expect(stats[2]!.textContent).toBe('—solve rate');
    // No hardcoded dollar pricing anywhere.
    expect(container.textContent).not.toContain('$');
    // Free-tier credits block is replaced by the key card.
    expect(container.querySelector('.pp-credits')).toBeNull();
  });

  it('shows a percentage when the solve rate is known and disconnects via DISCONNECT_KEY', async () => {
    await mount({
      userKey: 'nc_live_a1b2c3d4f00d',
      stats: { monthSolves: 5, monthCreditsSpent: 50, solveRate: 0.991 },
    });
    expect([...container.querySelectorAll('.pp-usage .u b')][2]!.textContent).toBe('99.1%');
    click(container.querySelector('.pp-keychip .k-remove')!);
    await flush();
    expect(sendMessage).toHaveBeenCalledWith({ t: 'DISCONNECT_KEY' });
  });
});

describe('Popup — solving', () => {
  it('shows the activity card with the phase label and host', async () => {
    await mount({ phase: 'solving' });
    expect(container.querySelector('.pp-status')!.textContent).toBe('Solving');
    expect(container.querySelector('.pp-status')!.classList.contains('busy')).toBe(true);
    const card = container.querySelector('.pp-activity')!;
    expect(card.querySelector('.a-spin')).not.toBeNull();
    expect(card.querySelector('.a-title')!.textContent).toBe('Solving challenge…');
    expect(card.querySelector('.a-sub')!.textContent).toBe('formly.dev · image challenge');
  });

  it('shows the last-solve card when idle', async () => {
    await mount({ lastSolve: { secs: 4, at: Date.now() } });
    const card = container.querySelector('.pp-activity')!;
    expect(card.querySelector('.a-check')!.textContent).toBe('✓');
    expect(card.querySelector('.a-title')!.textContent).toBe('Last solve · 4s');
    expect(card.querySelector('.a-sub')!.textContent).toBe('formly.dev · 1 free credit');
  });
});

describe('Popup — paused', () => {
  it('renders the off toggle, paused chip, and paused note', async () => {
    await mount({ paused: true });
    expect(container.querySelector('.pp-status')!.textContent).toBe('Paused');
    const toggle = container.querySelector('.pp-site .pp-toggle')!;
    expect(toggle.classList.contains('on')).toBe(false);
    expect(container.querySelector('.pp-site .s-sub')!.textContent).toBe(
      'Auto-solve paused on this site',
    );
    expect(container.querySelector('.pp-paused-note')!.textContent).toContain('formly.dev');
  });

  it('sends SET_PAUSE for the active host when toggled', async () => {
    await mount();
    click(container.querySelector('.pp-site .pp-toggle')!);
    await flush();
    expect(sendMessage).toHaveBeenCalledWith({ t: 'SET_PAUSE', host: 'formly.dev', paused: true });
  });

  it('disables the toggle when there is no host', async () => {
    await mount({ host: null });
    const toggle = container.querySelector('.pp-site .pp-toggle') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
  });
});

describe('Popup — key form', () => {
  const openForm = async (): Promise<HTMLInputElement> => {
    click(container.querySelector('.pp-keylink')!);
    await flush();
    return container.querySelector('.pp-keyform input') as HTMLInputElement;
  };

  it('rejects a malformed key locally without messaging the background', async () => {
    await mount();
    const input = await openForm();
    await type(input, 'not-a-key');
    click(container.querySelector('.pp-keyform .pp-btn')!);
    await flush();
    expect(container.querySelector('.pp-key-hint.err')!.textContent).toBe(
      'That doesn’t look like a NoneCap key (nc_live_…)',
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ t: 'CONNECT_KEY' }),
    );
  });

  it('shows the rejected hint when the background says no', async () => {
    await mount();
    const input = await openForm();
    await type(input, 'nc_live_a1b2c3d4');
    click(container.querySelector('.pp-keyform .pp-btn')!);
    await flush();
    expect(sendMessage).toHaveBeenCalledWith({ t: 'CONNECT_KEY', key: 'nc_live_a1b2c3d4' });
    expect(container.querySelector('.pp-key-hint.err')!.textContent).toBe(
      'Key was rejected by the API',
    );
  });

  it('refreshes state after a successful connect', async () => {
    await mount();
    sendMessage.mockImplementation(async (msg: Msg) => {
      if (msg.t === 'GET_STATE') return state;
      if (msg.t === 'CONNECT_KEY') {
        state = baseState({ userKey: msg.key, credits: null });
        return { ok: true };
      }
      return undefined;
    });
    const input = await openForm();
    await type(input, 'nc_live_a1b2c3d4f00d');
    click(container.querySelector('.pp-keyform .pp-btn')!);
    await flush();
    expect(container.querySelector('.pp-keychip .k-key')!.textContent).toBe('nc_live_••••f00d');
  });
});

describe('Popup — live storage updates', () => {
  it('re-renders when credits change in storage', async () => {
    await mount();
    await chrome.storage.local.set({
      credits: { remaining: 42, resetsAt: baseState().credits!.resetsAt },
    });
    await flush();
    expect(container.querySelector('.pp-credits .big')!.textContent).toBe('42');
  });
});
