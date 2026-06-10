import { describe, expect, it } from 'vitest';
import { EXTENSION_VERSION } from './version';
import manifest from '../../manifest.config';
import pkg from '../../package.json';

describe('version', () => {
  it('is a valid Chrome extension version string', () => {
    expect(EXTENSION_VERSION).toMatch(/^\d+(\.\d+){0,3}$/);
  });

  it('matches the package.json version', () => {
    expect(pkg.version).toBe(EXTENSION_VERSION);
  });

  it('matches the manifest version', async () => {
    const resolved = await (typeof manifest === 'function'
      ? manifest({ command: 'build', mode: 'production' })
      : manifest);
    expect(resolved.version).toBe(EXTENSION_VERSION);
  });
});
