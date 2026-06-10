/**
 * NoneCap toolbar popup. Pixel-faithful port of the design prototype
 * (docs/.../extension-design/popup.jsx), wired to the background worker.
 *
 * All real state comes from GET_STATE (polled while open) plus a storage
 * subscription for live credit/stats updates. This is one of the three UI
 * entry modules allowed to touch chrome.*.
 */

import { useEffect, useState } from 'preact/hooks';
import type { ConnectKeyReply, Msg, PopupState } from '../shared/messages';
import { subscribe } from '../shared/storage';
import { EXTENSION_VERSION } from '../shared/version';
import {
  FREE_DAILY_CREDITS,
  KEY_RE,
  creditsPct,
  formatNumber,
  formatResetsIn,
  formatSolveRate,
  isSolvingPhase,
  keyHint,
  maskKey,
  phaseLabel,
  type KeyError,
} from './format';

const DASHBOARD_URL = 'https://dashboard.nonecap.com';
const DOCS_URL = 'https://nonecap.com/api-reference';

function send<T = unknown>(msg: Msg): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

function openOptions(): void {
  chrome.runtime.openOptionsPage();
  window.close();
}

function GearIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="8" cy="8" r="2.2"></circle>
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"></path>
    </svg>
  );
}

export function Popup() {
  const [state, setState] = useState<PopupState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyErr, setKeyErr] = useState<KeyError>(null);

  const refresh = async (): Promise<void> => {
    try {
      const next = await send<PopupState>({ t: 'GET_STATE' });
      if (next) setState(next);
    } catch {
      // Background not reachable (e.g. reloading) — keep the last state.
    }
  };

  useEffect(() => {
    void refresh();
    // Phase only lives in the background; poll it cheaply while open.
    const poll = setInterval(() => void refresh(), 1_000);
    // "resets in Xh Ym" ticks while the popup stays open.
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const unsub = subscribe((changes) => {
      setState((prev) => {
        if (prev === null) return prev;
        const next = { ...prev };
        if ('credits' in changes) next.credits = changes.credits ?? null;
        if ('userKey' in changes) next.userKey = changes.userKey ?? null;
        if ('lastSolve' in changes) next.lastSolve = changes.lastSolve ?? null;
        if ('stats' in changes) next.stats = changes.stats ?? null;
        return next;
      });
    });
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      unsub();
    };
  }, []);

  const tryConnect = async (): Promise<void> => {
    const k = keyDraft.trim();
    if (!KEY_RE.test(k)) {
      setKeyErr('format');
      return;
    }
    const reply = await send<ConnectKeyReply>({ t: 'CONNECT_KEY', key: k });
    if (reply?.ok) {
      setKeyErr(null);
      setKeyOpen(false);
      setKeyDraft('');
      await refresh();
    } else {
      setKeyErr('rejected');
    }
  };

  const disconnect = async (): Promise<void> => {
    await send({ t: 'DISCONNECT_KEY' });
    await refresh();
  };

  const togglePause = async (): Promise<void> => {
    if (!state || state.host === null) return;
    const paused = !state.paused;
    setState({ ...state, paused }); // optimistic; refresh confirms
    await send({ t: 'SET_PAUSE', host: state.host, paused });
    await refresh();
  };

  if (state === null) {
    return (
      <div className="popup">
        <div className="pp-head">
          <div className="nc-mark" style={{ width: 22, height: 22 }}></div>
          <div className="pp-name">
            NoneCap <span className="pp-ver">v{EXTENSION_VERSION}</span>
          </div>
          <button className="pp-gear" title="Settings" onClick={openOptions}>
            <GearIcon />
          </button>
        </div>
      </div>
    );
  }

  const { credits, userKey, host, paused, lastSolve, stats } = state;
  const solving = isSolvingPhase(state.phase);
  const remaining = credits?.remaining ?? null;
  const outOfCredits = !userKey && remaining !== null && remaining <= 0;
  const pct = remaining === null ? 0 : creditsPct(remaining, FREE_DAILY_CREDITS);
  const resetsIn = credits ? formatResetsIn(credits.resetsAt, now) : '—';

  const status = paused
    ? { cls: 'off', label: 'Paused' }
    : solving
      ? { cls: 'busy', label: 'Solving' }
      : { cls: 'on', label: 'Active' };

  const keyForm = (
    <div>
      <div className="pp-keyform">
        <input
          autoFocus
          placeholder="nc_live_…"
          value={keyDraft}
          spellcheck={false}
          className={keyErr !== null ? 'bad' : ''}
          onInput={(e) => {
            setKeyDraft((e.currentTarget as HTMLInputElement).value);
            setKeyErr(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void tryConnect();
          }}
        ></input>
        <button className="pp-btn" onClick={() => void tryConnect()}>
          Connect
        </button>
      </div>
      <div className={'pp-key-hint' + (keyErr !== null ? ' err' : '')}>{keyHint(keyErr)}</div>
    </div>
  );

  return (
    <div className="popup">
      <div className="pp-head">
        <div className="nc-mark" style={{ width: 22, height: 22 }}></div>
        <div className="pp-name">
          NoneCap <span className="pp-ver">v{EXTENSION_VERSION}</span>
        </div>
        <div className={'pp-status ' + status.cls}>
          <span className="dot"></span>
          {status.label}
        </div>
        <button className="pp-gear" title="Settings" onClick={openOptions}>
          <GearIcon />
        </button>
      </div>

      <div className="pp-body">
        {/* credits / usage */}
        {!userKey ? (
          <div className="pp-credits">
            <div className="row1">
              <span className={'big' + (outOfCredits ? ' zero' : '')}>{remaining ?? '—'}</span>
              <span className="of">/ {FREE_DAILY_CREDITS} free credits today</span>
              <span className="resets mono">resets in {resetsIn}</span>
            </div>
            <div className="pp-bar">
              <i className={pct <= 10 ? 'low' : ''} style={{ width: pct + '%' }}></i>
            </div>
          </div>
        ) : (
          <div className="pp-card">
            <div className="pp-keychip">
              <div className="k-icon">⚿</div>
              <div className="k-body">
                <div className="k-key">{maskKey(userKey)}</div>
                <div className="k-plan">Pay-as-you-go · connected</div>
              </div>
              <button className="k-remove" onClick={() => void disconnect()}>
                Disconnect
              </button>
            </div>
            <div className="pp-usage">
              <div className="u">
                <b>{stats ? formatNumber(stats.monthSolves) : '—'}</b>
                <span>solves this month</span>
              </div>
              <div className="u">
                <b>{stats ? formatNumber(stats.monthCreditsSpent) : '—'}</b>
                <span>credits this month</span>
              </div>
              <div className="u">
                <b>{stats ? formatSolveRate(stats.solveRate) : '—'}</b>
                <span>solve rate</span>
              </div>
            </div>
          </div>
        )}

        {/* live activity */}
        {solving && !paused && (
          <div className="pp-card pp-activity">
            <div className="a-spin"></div>
            <div className="a-text">
              <div className="a-title">{phaseLabel(state.phase)}</div>
              <div className="a-sub">{host ?? '—'} · image challenge</div>
            </div>
          </div>
        )}
        {!solving && lastSolve && !paused && (
          <div className="pp-card pp-activity">
            <div className="a-check">✓</div>
            <div className="a-text">
              <div className="a-title">Last solve · {lastSolve.secs}s</div>
              <div className="a-sub">
                {host ?? '—'} · {userKey ? 'billed to key' : '1 free credit'}
              </div>
            </div>
          </div>
        )}

        {/* out of credits */}
        {outOfCredits && !paused && (
          <div className="pp-warncard">
            <div className="w-title">Daily free credits used</div>
            <div className="w-sub">
              Your {FREE_DAILY_CREDITS} free credits reset in {resetsIn}. Add a NoneCap API key to
              keep solving without limits.
            </div>
            <button className="pp-btn full" onClick={() => setKeyOpen(true)}>
              Add API key
            </button>
          </div>
        )}

        {/* current site */}
        <div className="pp-card pp-site">
          <div className="s-fav"></div>
          <div style={{ flex: 1 }}>
            <div className="s-host">{host ?? 'This page'}</div>
            <div className="s-sub">
              {host === null
                ? 'NoneCap doesn’t run here'
                : paused
                  ? 'Auto-solve paused on this site'
                  : 'Auto-solve enabled'}
            </div>
          </div>
          <button
            className={'pp-toggle' + (paused ? '' : ' on')}
            onClick={() => void togglePause()}
            disabled={host === null}
            aria-label="Toggle auto-solve on this site"
          ></button>
        </div>

        {paused && (
          <div className="pp-paused-note">
            NoneCap will stay quiet here. Captchas on {host ?? 'this site'} are left for you to
            solve manually.
          </div>
        )}

        {/* API key entry */}
        {!userKey &&
          (keyOpen ? (
            keyForm
          ) : !outOfCredits ? (
            <button className="pp-keylink" onClick={() => setKeyOpen(true)}>
              ⚿&ensp;Add API key for unlimited solves →
            </button>
          ) : null)}
      </div>

      <div className="pp-foot">
        <a href={DASHBOARD_URL} target="_blank" rel="noreferrer">
          Dashboard ↗
        </a>
        <a href={DOCS_URL} target="_blank" rel="noreferrer">
          Docs ↗
        </a>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            openOptions();
          }}
        >
          Settings
        </a>
      </div>
    </div>
  );
}
