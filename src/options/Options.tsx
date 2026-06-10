/**
 * NoneCap options page. Pixel-faithful port of the design prototype
 * (docs/.../extension-design/options.jsx), wired to chrome.storage via
 * src/shared/storage. Every control persists immediately.
 *
 * One of the three UI entry modules allowed to touch chrome.*.
 */

import { useEffect, useState } from 'preact/hooks';
import type { ConnectKeyReply, Msg } from '../shared/messages';
import type { Settings, SolveStyle } from '../shared/settings';
import { getAll, subscribe, updateSettings } from '../shared/storage';
import { EXTENSION_VERSION } from '../shared/version';
import { KEY_RE, keyHint, maskKey, type KeyError } from '../popup/format';

const PRIVACY_URL = 'https://nonecap.com/extension/privacy';
const DOCS_URL = 'https://nonecap.com/api-reference';

function send<T = unknown>(msg: Msg): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

function Toggle({
  on,
  onClick,
  disabled,
  label,
}: {
  on: boolean;
  onClick?: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      className={'pp-toggle' + (on ? ' on' : '')}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      aria-label={label ?? 'Toggle'}
    ></button>
  );
}

export function Options() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [userKey, setUserKey] = useState<string | null>(null);
  // Hosts to keep showing in the paused list even after they're resumed,
  // so the row can flip between Paused/Active while the page is open.
  const [pausedSeen, setPausedSeen] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [keyErr, setKeyErr] = useState<KeyError>(null);

  useEffect(() => {
    void (async () => {
      const all = await getAll();
      setSettings(all.settings);
      setUserKey(all.userKey);
      setPausedSeen(all.settings.pausedHosts);
    })();
    const unsub = subscribe((changes) => {
      if (changes.settings) {
        const next = changes.settings;
        setSettings(next);
        setPausedSeen((prev) => [...new Set([...prev, ...next.pausedHosts])]);
      }
      if ('userKey' in changes) setUserKey(changes.userKey ?? null);
    });
    return unsub;
  }, []);

  const patch = async (fn: (s: Settings) => Settings): Promise<void> => {
    const next = await updateSettings(fn);
    setSettings(next);
  };

  const addSite = async (): Promise<void> => {
    const s = draft.trim().toLowerCase();
    setDraft('');
    if (!s) return;
    await patch((cur) =>
      cur.blocklist.includes(s) ? cur : { ...cur, blocklist: [...cur.blocklist, s] },
    );
  };

  const removeSite = async (host: string): Promise<void> => {
    await patch((cur) => ({ ...cur, blocklist: cur.blocklist.filter((x) => x !== host) }));
  };

  const togglePausedHost = async (host: string, paused: boolean): Promise<void> => {
    try {
      await send({ t: 'SET_PAUSE', host, paused: !paused });
    } catch {
      // Background unreachable — the storage subscription will resync when it
      // comes back; nothing to roll back here (row state follows settings).
    }
  };

  const tryConnect = async (): Promise<void> => {
    const k = keyDraft.trim();
    if (!KEY_RE.test(k)) {
      setKeyErr('format');
      return;
    }
    let reply: ConnectKeyReply | undefined;
    try {
      reply = await send<ConnectKeyReply>({ t: 'CONNECT_KEY', key: k });
    } catch {
      setKeyErr('unreachable');
      return;
    }
    if (reply?.ok) {
      setKeyErr(null);
      setKeyDraft('');
      setUserKey(k);
    } else {
      setKeyErr('rejected');
    }
  };

  const disconnect = async (): Promise<void> => {
    try {
      await send({ t: 'DISCONNECT_KEY' });
    } catch {
      // Background unreachable — keep the key connected rather than lying.
      return;
    }
    setUserKey(null);
  };

  if (settings === null) return <div className="opts"></div>;

  const accountSub =
    keyErr !== null ? (
      <span className="err">{keyHint(keyErr)}</span>
    ) : (
      'On the free plan: 100 credits per day'
    );

  return (
    <div className="opts">
      <div className="opts-inner">
        <div className="opts-head">
          <div className="nc-mark" style={{ width: 26, height: 26 }}></div>
          <h1>NoneCap settings</h1>
          <span className="ver">v{EXTENSION_VERSION}</span>
        </div>
        <p className="opts-sub">Captchas, solved before you notice them.</p>

        <div className="opts-section">
          <div className="opts-label">General</div>
          <div className="opts-card">
            <div className="opts-row">
              <div className="r-body">
                <div className="r-title">Auto-solve captchas</div>
                <div className="r-sub">Solve automatically as soon as a captcha is detected</div>
              </div>
              <Toggle
                on={settings.autoSolve}
                onClick={() => void patch((s) => ({ ...s, autoSolve: !s.autoSolve }))}
                label="Auto-solve captchas"
              />
            </div>
            <div className="opts-row">
              <div className="r-body">
                <div className="r-title">Solving style</div>
                <div className="r-sub">Human-like adds natural cursor movement and pauses</div>
              </div>
              <select
                value={settings.style}
                aria-label="Solving style"
                onInput={(e) => {
                  const style = (e.currentTarget as HTMLSelectElement).value as SolveStyle;
                  void patch((s) => ({ ...s, style }));
                }}
              >
                <option value="human">Human-like</option>
                <option value="fast">Fast</option>
              </select>
            </div>
            <div className="opts-row">
              <div className="r-body">
                <div className="r-title">Show status overlay</div>
                <div className="r-sub">Small pill near the captcha while NoneCap works</div>
              </div>
              <Toggle
                on={settings.showOverlay}
                onClick={() => void patch((s) => ({ ...s, showOverlay: !s.showOverlay }))}
                label="Show status overlay"
              />
            </div>
          </div>
        </div>

        <div className="opts-section">
          <div className="opts-label">Challenge types</div>
          <div className="opts-card">
            <div className="opts-row">
              <div className="r-body">
                <div className="r-title">Image grid selection</div>
              </div>
              <span className="opts-tag live">Live</span>
              <Toggle
                on={settings.grid}
                onClick={() => void patch((s) => ({ ...s, grid: !s.grid }))}
                label="Image grid selection"
              />
            </div>
            <div className="opts-row">
              <div className="r-body">
                <div className="r-title">Drag &amp; slide puzzles</div>
              </div>
              <span className="opts-tag live">Live</span>
              <Toggle
                on={settings.drag}
                onClick={() => void patch((s) => ({ ...s, drag: !s.drag }))}
                label="Drag & slide puzzles"
              />
            </div>
            <div className="opts-row">
              <div className="r-body">
                <div className="r-title">Audio challenges</div>
              </div>
              <span className="opts-tag soon">Soon</span>
              <Toggle on={false} disabled label="Audio challenges" />
            </div>
          </div>
        </div>

        <div className="opts-section">
          <div className="opts-label">Account</div>
          <div className="opts-card">
            {userKey ? (
              <div className="opts-row">
                <div className="r-body">
                  <div className="r-title mono" style={{ fontSize: 12.5 }}>
                    {maskKey(userKey)}
                  </div>
                  <div className="r-sub">Pay-as-you-go · unlimited solves</div>
                </div>
                <button className="k-remove" onClick={() => void disconnect()}>
                  Disconnect
                </button>
              </div>
            ) : (
              <div className="opts-row">
                <div className="r-body">
                  <div className="r-title">API key</div>
                  <div className="r-sub">{accountSub}</div>
                </div>
                <div className="pp-keyform" style={{ width: 280 }}>
                  <input
                    placeholder="nc_live_…"
                    aria-label="NoneCap API key"
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
              </div>
            )}
          </div>
        </div>

        <div className="opts-section">
          <div className="opts-label">Never solve on these sites</div>
          <div className="opts-card opts-sitelist">
            {settings.blocklist.map((s) => (
              <div className="opts-row site-item" key={s}>
                <span className="mono">{s}</span>
                <button
                  className="rm"
                  title="Remove"
                  aria-label={'Remove ' + s}
                  onClick={() => void removeSite(s)}
                >
                  ×
                </button>
              </div>
            ))}
            {pausedSeen.map((host) => {
              const paused = settings.pausedHosts.includes(host);
              return (
                <div className="opts-row site-item" key={'paused-' + host}>
                  <span className="mono">{host}</span>
                  <span className={'opts-tag ' + (paused ? 'soon' : 'live')} style={{ marginLeft: 8 }}>
                    {paused ? 'Paused' : 'Active'}
                  </span>
                  <button
                    className="rm"
                    title={paused ? 'Resume' : 'Pause'}
                    aria-label={(paused ? 'Resume solving on ' : 'Pause solving on ') + host}
                    onClick={() => void togglePausedHost(host, paused)}
                  >
                    {paused ? '▸' : '⏸'}
                  </button>
                </div>
              );
            })}
            <div className="opts-addsite">
              <input
                placeholder="domain.com"
                aria-label="Add a site to never solve on"
                value={draft}
                onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addSite();
                }}
              ></input>
              <button className="pp-btn" onClick={() => void addSite()}>
                Add
              </button>
            </div>
          </div>
        </div>

        <div className="opts-foot">
          Challenges are solved by the NoneCap API over an encrypted connection. Page content
          outside the captcha frame never leaves your browser.{' '}
          <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
            Privacy policy
          </a>{' '}
          ·{' '}
          <a href={DOCS_URL} target="_blank" rel="noreferrer">
            Docs
          </a>
        </div>
      </div>
    </div>
  );
}
