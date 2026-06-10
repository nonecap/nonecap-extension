// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Msg } from '../shared/messages';
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings';
import { installChromeMock, type ChromeMock } from '../shared/test/chrome-mock';
import { Options } from './Options';

/**
 * Preact defers effects via requestAnimationFrame; rAF is stubbed to a 0ms
 * timeout in beforeEach, so two macrotask rounds flush effects + re-renders.
 */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

let mock: ChromeMock;
let container: HTMLElement;
let sendMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    return setTimeout(() => cb(performance.now()), 0) as unknown as number;
  });
  mock = installChromeMock();
  sendMessage = vi.fn(async (_msg: Msg) => undefined);
  (globalThis as { chrome: { runtime?: unknown } }).chrome.runtime = { sendMessage };
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
  mock.uninstall();
  vi.unstubAllGlobals();
});

async function mount(settings: Partial<Settings> = {}, userKey: string | null = null) {
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...settings }, userKey });
  render(<Options />, container);
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

const storedSettings = (): Settings => mock.store['settings'] as Settings;

describe('Options — blocklist', () => {
  it('renders existing entries and adds a lowercased, deduped site', async () => {
    await mount({ blocklist: ['bank.example.com'] });
    expect(container.querySelector('.opts-sitelist .mono')!.textContent).toBe('bank.example.com');

    const input = container.querySelector('.opts-addsite input') as HTMLInputElement;
    await type(input, '  Mail.Corp.INTERNAL ');
    click(container.querySelector('.opts-addsite .pp-btn')!);
    await flush();
    expect(storedSettings().blocklist).toEqual(['bank.example.com', 'mail.corp.internal']);

    // Duplicate adds are ignored.
    await type(input, 'bank.example.com');
    click(container.querySelector('.opts-addsite .pp-btn')!);
    await flush();
    expect(storedSettings().blocklist).toEqual(['bank.example.com', 'mail.corp.internal']);
  });

  it('removes an entry via the × button and persists', async () => {
    await mount({ blocklist: ['bank.example.com', 'mail.corp.internal'] });
    click(container.querySelector('.opts-sitelist .site-item .rm')!);
    await flush();
    expect(storedSettings().blocklist).toEqual(['mail.corp.internal']);
    expect(container.textContent).not.toContain('bank.example.com');
  });

  it('shows paused hosts with a Paused tag and unpauses via SET_PAUSE', async () => {
    await mount({ pausedHosts: ['formly.dev'] });
    const tag = container.querySelector('.opts-sitelist .opts-tag')!;
    expect(tag.textContent).toBe('Paused');
    click(tag.parentElement!.querySelector('.rm')!);
    await flush();
    expect(sendMessage).toHaveBeenCalledWith({ t: 'SET_PAUSE', host: 'formly.dev', paused: false });
  });
});

describe('Options — general settings', () => {
  it('persists toggle and style changes immediately', async () => {
    await mount();
    // First toggle = auto-solve.
    click(container.querySelector('.opts-card .pp-toggle')!);
    await flush();
    expect(storedSettings().autoSolve).toBe(false);

    const select = container.querySelector('.opts-row select') as HTMLSelectElement;
    select.value = 'fast';
    select.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(storedSettings().style).toBe('fast');
  });

  it('keeps the audio challenges toggle disabled', async () => {
    await mount();
    const toggles = [...container.querySelectorAll('.pp-toggle')] as HTMLButtonElement[];
    const audio = toggles.find((t) => t.getAttribute('aria-label') === 'Audio challenges')!;
    expect(audio.disabled).toBe(true);
    expect(audio.classList.contains('on')).toBe(false);
  });
});

describe('Options — account', () => {
  it('shows the free-plan credits copy and validates key format locally', async () => {
    await mount();
    expect(container.textContent).toContain('On the free plan: 100 credits per day');
    const input = container.querySelector('.pp-keyform input') as HTMLInputElement;
    await type(input, 'nope');
    click(container.querySelector('.pp-keyform .pp-btn')!);
    await flush();
    expect(container.querySelector('.r-sub .err')!.textContent).toBe(
      'That doesn’t look like a NoneCap key (nc_live_…)',
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('shows the masked key with a Disconnect action when connected', async () => {
    await mount({}, 'nc_live_a1b2c3d4f00d');
    expect(container.querySelector('.opts-card .r-title.mono')!.textContent).toBe(
      'nc_live_••••f00d',
    );
    click(container.querySelector('.k-remove')!);
    await flush();
    expect(sendMessage).toHaveBeenCalledWith({ t: 'DISCONNECT_KEY' });
    expect(container.textContent).toContain('On the free plan: 100 credits per day');
  });
});
