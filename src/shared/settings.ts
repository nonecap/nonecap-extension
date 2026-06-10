/** User-configurable extension settings. Platform-pure: no chrome.* here. */

export type SolveStyle = 'human' | 'fast';

export type Settings = {
  /** Solve challenges automatically when detected. */
  autoSolve: boolean;
  /** Click pacing: human-like animated movement vs as-fast-as-possible. */
  style: SolveStyle;
  /** Show the on-page status overlay while solving. */
  showOverlay: boolean;
  /** Attempt grid (tile selection) challenges. */
  grid: boolean;
  /** Attempt drag challenges. */
  drag: boolean;
  /** Hosts the extension must never touch. */
  blocklist: string[];
  /** Hosts the user has temporarily paused solving on. */
  pausedHosts: string[];
};

export const DEFAULT_SETTINGS: Settings = {
  autoSolve: true,
  style: 'human',
  showOverlay: true,
  grid: true,
  drag: true,
  blocklist: [],
  pausedHosts: [],
};
