import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, type ChromeMock } from '../shared/test/chrome-mock';
import {
  BADGE_BG,
  BADGE_BG_MUTED,
  BADGE_TEXT_COLOR,
  computeBadge,
  resetBadgeForTests,
  setBadgeFlags,
  updateBadge,
  wireBadge,
  type BadgeSpec,
} from './badge';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('computeBadge', () => {
  const cases: { name: string; state: Parameters<typeof computeBadge>[0]; want: BadgeSpec }[] = [
    {
      name: 'free key with credits → count on purple',
      state: { credits: 12, userKey: null, paused: false, blocked: false },
      want: { text: '12', background: BADGE_BG, textColor: BADGE_TEXT_COLOR },
    },
    {
      name: 'free key, credits unknown → ellipsis on purple',
      state: { credits: null, userKey: null, paused: false, blocked: false },
      want: { text: '…', background: BADGE_BG, textColor: BADGE_TEXT_COLOR },
    },
    {
      name: 'user key → API on purple',
      state: { credits: 12, userKey: 'nc_live_x', paused: false, blocked: false },
      want: { text: 'API', background: BADGE_BG, textColor: BADGE_TEXT_COLOR },
    },
    {
      name: 'paused free key → count on gray',
      state: { credits: 12, userKey: null, paused: true, blocked: false },
      want: { text: '12', background: BADGE_BG_MUTED, textColor: BADGE_TEXT_COLOR },
    },
    {
      name: 'paused free key, credits unknown → 0 on gray',
      state: { credits: null, userKey: null, paused: true, blocked: false },
      want: { text: '0', background: BADGE_BG_MUTED, textColor: BADGE_TEXT_COLOR },
    },
    {
      name: 'blocked free key → count on gray',
      state: { credits: 0, userKey: null, paused: false, blocked: true },
      want: { text: '0', background: BADGE_BG_MUTED, textColor: BADGE_TEXT_COLOR },
    },
    {
      name: 'blocked user key → API on gray',
      state: { credits: null, userKey: 'nc_live_x', paused: false, blocked: true },
      want: { text: 'API', background: BADGE_BG_MUTED, textColor: BADGE_TEXT_COLOR },
    },
    {
      name: 'paused and blocked → still gray',
      state: { credits: 3, userKey: null, paused: true, blocked: true },
      want: { text: '3', background: BADGE_BG_MUTED, textColor: BADGE_TEXT_COLOR },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(computeBadge(c.state)).toEqual(c.want);
    });
  }
});

describe('updateBadge / wireBadge', () => {
  let mock: ChromeMock;
  let unwire: (() => void) | null = null;

  beforeEach(() => {
    mock = installChromeMock();
    resetBadgeForTests();
  });

  afterEach(() => {
    unwire?.();
    unwire = null;
    resetBadgeForTests();
    mock.uninstall();
  });

  it('paints the stored state on wire and repaints on credits/userKey changes', async () => {
    const paint = vi.fn<(spec: BadgeSpec) => void>();
    unwire = wireBadge(paint);
    await tick();

    // Nothing stored yet → ellipsis on purple.
    expect(paint).toHaveBeenLastCalledWith({
      text: '…',
      background: BADGE_BG,
      textColor: BADGE_TEXT_COLOR,
    });

    await chrome.storage.local.set({ credits: { remaining: 42, resetsAt: 'soon' } });
    await tick();
    expect(paint).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: '42', background: BADGE_BG }),
    );

    await chrome.storage.local.set({ userKey: 'nc_live_abc' });
    await tick();
    expect(paint).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'API', background: BADGE_BG }),
    );
  });

  it('setBadgeFlags repaints muted and back', async () => {
    const paint = vi.fn<(spec: BadgeSpec) => void>();
    unwire = wireBadge(paint);
    await tick();
    await chrome.storage.local.set({ credits: { remaining: 7, resetsAt: 'soon' } });

    setBadgeFlags({ paused: true });
    expect(paint).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: '7', background: BADGE_BG_MUTED }),
    );

    setBadgeFlags({ paused: false });
    expect(paint).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: '7', background: BADGE_BG }),
    );

    // No-op flag updates don't repaint.
    const calls = paint.mock.calls.length;
    setBadgeFlags({ paused: false, blocked: false });
    expect(paint.mock.calls.length).toBe(calls);
  });

  it('updateBadge paints an explicit state through the wired painter', async () => {
    const paint = vi.fn<(spec: BadgeSpec) => void>();
    unwire = wireBadge(paint);
    await tick();

    updateBadge({ credits: 5, userKey: null, paused: false, blocked: true });
    expect(paint).toHaveBeenLastCalledWith({
      text: '5',
      background: BADGE_BG_MUTED,
      textColor: BADGE_TEXT_COLOR,
    });
  });
});
