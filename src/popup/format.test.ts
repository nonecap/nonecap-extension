import { describe, expect, it } from 'vitest';
import {
  KEY_RE,
  creditsPct,
  formatNumber,
  formatResetsIn,
  formatSolveRate,
  isSolvingPhase,
  keyHint,
  maskKey,
  phaseLabel,
} from './format';

describe('KEY_RE', () => {
  it.each(['nc_live_a1b2c3d4', 'nc_test_ABCDEFGH123', 'nc_live_' + 'x'.repeat(24)])(
    'accepts %s',
    (k) => {
      expect(KEY_RE.test(k)).toBe(true);
    },
  );

  it.each([
    'nc_live_short1', // < 8 chars after prefix
    'nc_prod_a1b2c3d4', // bad env
    'sk_live_a1b2c3d4', // wrong prefix
    'nc_live_a1b2c3d4!', // bad char
    ' nc_live_a1b2c3d4', // leading space
    '',
  ])('rejects %j', (k) => {
    expect(KEY_RE.test(k)).toBe(false);
  });
});

describe('maskKey', () => {
  it('keeps the prefix and last four', () => {
    expect(maskKey('nc_live_a1b2c3d4f00d')).toBe('nc_live_••••f00d');
  });

  it('fully masks keys too short for non-overlapping slices', () => {
    expect(maskKey('nc_live_ab')).toBe('nc_••••');
    expect(maskKey('')).toBe('nc_••••');
  });
});

describe('formatResetsIn', () => {
  const now = Date.parse('2026-06-10T12:00:00.000Z');

  it('formats hours and minutes', () => {
    expect(formatResetsIn('2026-06-10T18:12:00.000Z', now)).toBe('6h 12m');
  });

  it('formats sub-hour spans without the hour part', () => {
    expect(formatResetsIn('2026-06-10T12:42:00.000Z', now)).toBe('42m');
  });

  it('rounds partial minutes up', () => {
    expect(formatResetsIn('2026-06-10T12:00:30.000Z', now)).toBe('1m');
  });

  it('clamps past timestamps to 0m', () => {
    expect(formatResetsIn('2026-06-10T11:00:00.000Z', now)).toBe('0m');
  });

  it('returns an em dash for garbage input', () => {
    expect(formatResetsIn('not-a-date', now)).toBe('—');
  });
});

describe('formatNumber / formatSolveRate', () => {
  it('groups thousands', () => {
    expect(formatNumber(1284)).toBe('1,284');
  });

  it('renders a fraction as a percentage', () => {
    expect(formatSolveRate(0.991)).toBe('99.1%');
  });

  it('renders null rate as an em dash', () => {
    expect(formatSolveRate(null)).toBe('—');
  });
});

describe('creditsPct', () => {
  it('maps remaining to a 0-100 percentage', () => {
    expect(creditsPct(87, 100)).toBe(87);
    expect(creditsPct(0, 100)).toBe(0);
    expect(creditsPct(250, 100)).toBe(100);
    expect(creditsPct(-5, 100)).toBe(0);
  });
});

describe('phase helpers', () => {
  it('classifies solving phases', () => {
    expect(isSolvingPhase('detected')).toBe(true);
    expect(isSolvingPhase('opening')).toBe(true);
    expect(isSolvingPhase('solving')).toBe(true);
    expect(isSolvingPhase('verifying')).toBe(true);
    expect(isSolvingPhase('idle')).toBe(false);
    expect(isSolvingPhase('solved')).toBe(false);
    expect(isSolvingPhase('paused')).toBe(false);
  });

  it('labels phases per the design', () => {
    expect(phaseLabel('solving')).toBe('Solving challenge…');
    expect(phaseLabel('verifying')).toBe('Verifying…');
  });
});

describe('keyHint', () => {
  it('covers all four variants', () => {
    expect(keyHint(null)).toBe('Find your key in the NoneCap dashboard.');
    expect(keyHint('format')).toBe('That doesn’t look like a NoneCap key (nc_live_…)');
    expect(keyHint('rejected')).toBe('Key was rejected by the API');
    expect(keyHint('unreachable')).toBe(
      'Could not reach the extension background. Try reloading the extension.',
    );
  });
});
