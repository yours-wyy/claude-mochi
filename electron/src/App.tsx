import React, { useCallback, useEffect, useRef, useState } from 'react';

import { DaemonEvent } from './daemonEvents';
import Expressions from './views/Expressions';

// The daemon's own status contract (daemon/hud_daemon/ipc_server.py _status_dict).
interface LinkStatus {
  state: string;
  address: string | null;
  mtu: number;
  rtt_ms: number | null;
  backoff_s: number;
}

interface Status {
  ok?: boolean;
  link: LinkStatus;
  state: string;
  events_seen: number;
  udp_packets: number;
  dropped: number;
  queue_depth: number;
}

interface DaemonState {
  state: string;
  restarts: number;
  startedAt: number | null;
}

const POLL_MS = 2000;

// The daemon pushes on /ws and pushes a lot: state changes, link changes, the
// device's own STATUS, its firmware version, upload progress, ACK failures.
// The 2s /status poll below is the floor, not the feed — at 2 s a TOOL_END,
// which holds for exactly 1 s, can never be seen at all. This is what makes
// "did anything happen?" answerable without waiting.
const WS_URL = window.claudeHUD.daemonUrl.replace(/^http/, 'ws') + '/ws';
const WS_RETRY_MS = 1500;

// A link colour chosen to survive being seen at a glance: green when live, red
// when not, amber for the in-between states the user cannot act on.
const LINK_COLOUR: Record<string, string> = {
  connected: '#3ecf6e',
  scanning: '#f0b429',
  connecting: '#f0b429',
  disconnected: '#e5484d',
};

// Pill uses a soft tinted background + bright text rather than a solid chip,
// so the strip reads as calm status, not a traffic-light alarm.
const LINK_PILL: Record<string, React.CSSProperties> = {
  connected: { background: 'rgba(62,207,110,0.14)', color: '#3ecf6e' },
  scanning: { background: 'rgba(240,180,41,0.14)', color: '#f0b429' },
  connecting: { background: 'rgba(240,180,41,0.14)', color: '#f0b429' },
  disconnected: { background: 'rgba(229,72,77,0.14)', color: '#e5484d' },
};

const STATE_FACE: Record<string, string> = {
  idle: 'IDLE',
  thinking: 'THINKING',
  tool_start: 'TOOL',
  tool_end: 'DONE',
  waiting: 'WAIT',
  error: 'ERROR',
  offline: 'NO HOST',
  none: '—',
  unknown: '?',
};

// The wire protocol speaks numbers (protocol.py STATE_NAMES); the pushed
// 'state' frame carries one and nothing maps it back. Without this the live
// channel is a dead end.
const STATE_KEYS: Record<number, string> = {
  0: 'idle', 1: 'thinking', 2: 'tool_start', 3: 'tool_end',
  4: 'waiting', 5: 'error', 6: 'offline',
};

async function fetchStatus(): Promise<Status | null> {
  try {
    const res = await fetch(`${window.claudeHUD.daemonUrl}/status`);
    if (!res.ok) return null;
    return (await res.json()) as Status;
  } catch {
    return null;
  }
}

function Stat({ label, value, colour }: {
  label: string; value: React.ReactNode; colour?: string;
}) {
  return (
    <div style={styles.stat}>
      <div style={styles.statKey}>{label}</div>
      <div style={{ ...styles.statVal, ...(colour ? { color: colour } : null) }}>{value}</div>
    </div>
  );
}

// What the panel itself last told us. This is the device's own report, not the
// host's intent: it is the only thing that proves a face actually changed.
interface DeviceReport {
  state: number;
  state_name: string;
  ble: boolean;
  err: number;
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [daemon, setDaemon] = useState<DaemonState>({ state: 'stopped', restarts: 0, startedAt: null });
  const [logs, setLogs] = useState<string[]>([]);
  const [hooksMsg, setHooksMsg] = useState('');
  const [logOpen, setLogOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Live state, pushed rather than polled. liveState wins whenever it is set
  // because it is strictly fresher than /status; the poll fills in whenever the
  // socket is down or the daemon restarts underneath us.
  const [liveState, setLiveState] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [device, setDevice] = useState<DeviceReport | null>(null);
  const [fw, setFw] = useState<{ fw: string; used_slots: number; slot_count: number } | null>(null);
  const [pushErr, setPushErr] = useState<string | null>(null);
  const [exprEvent, setExprEvent] = useState<DaemonEvent | null>(null);

  // ── poll the daemon's own status ───────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const next = await fetchStatus();
      if (alive) setStatus(next);
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // ── the push channel ───────────────────────────────────────────────────────
  // Reopened with a delay whenever the socket closes. The daemon restarts take
  // it down with them, and a HUD panel that silently shows nothing is worse
  // than one that says it disconnected.
  useEffect(() => {
    let alive = true;
    let retryTimer = 0;

    const connect = () => {
      if (!alive) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(WS_URL);
      } catch {
        retryTimer = window.setTimeout(connect, WS_RETRY_MS);
        return;
      }

      ws.onopen = () => setLive(true);
      ws.onclose = () => {
        setLive(false);
        setLiveState(null);
        setDevice(null);
        if (alive) retryTimer = window.setTimeout(connect, WS_RETRY_MS);
      };
      ws.onerror = () => ws.close();

      ws.onmessage = (e: MessageEvent) => {
        let frame: DaemonEvent;
        try {
          frame = JSON.parse(String(e.data)) as DaemonEvent;
        } catch {
          return;   // a frame we cannot read is not worth tearing down for
        }

        switch (frame.type) {
          case 'state':
            // The daemon emits the numeric state; only its name is useful here.
            if (typeof frame.state === 'number') {
              const name = STATE_KEYS[frame.state];
              if (name) setLiveState(name);
            }
            return;
          case 'device-status':
            if (typeof frame.state === 'number' && frame.state_name) {
              setDevice({ state: frame.state, state_name: frame.state_name,
                          ble: frame.ble ?? false, err: frame.err ?? 0 });
            }
            return;
          case 'device-info':
            if (frame.fw) {
              setFw({ fw: frame.fw, used_slots: frame.used_slots ?? 0,
                      slot_count: frame.slot_count ?? 0 });
            }
            return;
          case 'device-ack-error':
            setPushErr(`设备拒绝了请求：${frame.ack_name ?? frame.ack_code}`);
            return;
          case 'device-log':
            setPushErr(`设备报告：${frame.text ?? ''}`);
            return;
          case 'link':
            // The BLE link changed state right now, not on the next 2s poll.
            // Update the status strip immediately so the dot and pill flip the
            // instant the device is gone or back.
            if (typeof frame.state === 'string') {
              setStatus((prev) => prev
                ? { ...prev, link: { ...prev.link, state: frame.state as string } }
                : prev);
            }
            return;
          case 'device-config':
            // Another client changed the display settings. Forward to the
            // editor so it can update without a manual refresh.
            setExprEvent(frame);
            return;
          case 'status':
            // The daemon sends a full status frame on WS connect. Use it to
            // populate immediately instead of waiting for the first poll tick.
            if (frame.link && typeof frame.link === 'object') {
              setStatus((prev) => prev
                ? { ...prev, ...(frame as unknown as Status) }
                : (frame as unknown as Status));
            }
            return;
          default:
            setExprEvent(frame);
        }
      };
    };

    connect();
    return () => {
      alive = false;
      clearTimeout(retryTimer);
    };
  }, []);

  // ── pushed from the main process ───────────────────────────────────────────
  useEffect(() => {
    const offState = window.claudeHUD.onDaemonState(setDaemon);
    const offLog = window.claudeHUD.onDaemonLog((line) => {
      setLogs((prev) => [...prev.slice(-80), line]);
    });
    const offHooks = window.claudeHUD.onHooksResult((r) => {
      setHooksMsg(r.ok ? 'hook 已安装/修复' : `hook 安装失败:\n${r.output}`);
    });
    return () => { offState(); offLog(); offHooks(); };
  }, []);

  // Keep the log tail pinned to the newest line.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs, logOpen]);

  const link = status?.link;
  const linkState = link?.state ?? 'disconnected';
  const linkColour = LINK_COLOUR[linkState] ?? '#888';
  // Prefer the pushed state: it changes the instant the daemon acts, with no
  // 2s window in the middle where the screen still shows the previous face.
  const hudState = liveState ?? status?.state ?? 'none';
  const face = STATE_FACE[hudState] ?? hudState.toUpperCase();

  // The device's own report, when it disagrees with what we think we sent.
  const hostState = hudState;
  const panelState = device?.state_name ?? null;
  const panelDisagrees =
    panelState !== null &&
    panelState !== hostState &&
    !(panelState === 'offline' && hostState === 'offline') &&
    // TOOL_END is transient by design: the daemon holds it for 1 s and then
    // falls back to thinking, so the panel legitimately shows it after the host
    // has already moved on.
    !(hostState === 'tool_end' && panelState === 'thinking');

  const onInstallHooks = useCallback(() => {
    setHooksMsg('正在安装…');
    window.claudeHUD.installHooks();
  }, []);
  const onRestart = useCallback(() => { window.claudeHUD.restartDaemon(); }, []);

  return (
    <div style={styles.app}>
      {/* ── status strip: always visible, so the link is never a surprise ── */}
      <div style={styles.strip}>
        <div style={styles.stripLeft}>
          <span style={{ ...styles.statusDot,
                         background: linkColour,
                         boxShadow: `0 0 8px ${linkColour}` }} />
          <span style={{ ...styles.pill,
                         ...(LINK_PILL[linkState] ?? LINK_PILL.disconnected) }}>
            {linkState}
          </span>
          <span style={styles.stripFace}>{face}</span>
          {/* What the panel itself reports, once it has told us. A faint amber
              tag when it disagrees beats another stat column nobody reads.
              Kept free of apostrophes on purpose: esbuild reads one inside
              JSX comment text as the start of a string literal and reports
              "unterminated" hundreds of lines later, at a line that reads
              fine. */}
          {panelState && (
            <span style={{ ...styles.panelTag,
                           color: panelDisagrees ? '#f0b429' : '#6a6a72' }}
                  title={panelDisagrees
                    ? `面板实际显示 ${panelState}，与预期 ${hostState} 不一致`
                    : `面板报告自己正在显示 ${panelState}`}>
              面板 {panelState}
            </span>
          )}
          {pushErr && (
            <span style={{ ...styles.panelTag, color: '#e5484d' }}
                  onClick={() => setPushErr(null)}
                  title="点击清除">
              {pushErr}
            </span>
          )}
        </div>
        <div style={styles.stripRight}>
          {fw && (
            <Stat label="固件" value={fw.fw}
                  colour={fw.used_slots >= fw.slot_count ? '#f0b429' : undefined} />
          )}
          <Stat label="MTU" value={link?.mtu ?? '—'} />
          <Stat label="延迟"
                value={link?.rtt_ms != null ? `${link.rtt_ms.toFixed(0)}ms` : '—'} />
          <Stat label="hook" value={status?.events_seen ?? '—'} />
          <Stat label="重启" value={daemon.restarts} colour={daemon.restarts > 0 ? '#f0b429' : undefined} />
        </div>
      </div>

      {/* ── the editor, which is the point of the window ── */}
      <div style={styles.main}>
        <Expressions exprEvent={exprEvent} />
      </div>

      {/* ── footer: actions + log ── */}
      <div style={styles.footer}>
        <div style={styles.footerBtns}>
          <button style={styles.smallBtn} onClick={onInstallHooks}>修复 hook</button>
          <button style={{ ...styles.smallBtn, ...styles.smallBtnGhost }} onClick={onRestart}>
            重启 daemon
          </button>
          <button style={{ ...styles.smallBtn, ...styles.smallBtnGhost }}
                  onClick={() => setLogOpen((v) => !v)}>
            {logOpen ? '收起日志' : `日志 ${logs.length}`}
          </button>
        </div>
        {hooksMsg && <div style={styles.hooksMsg}>{hooksMsg}</div>}
        {(status?.dropped ?? 0) > 0 && (
          <div style={styles.warn}>丢弃 {status?.dropped} 个事件</div>
        )}
        {link && link.backoff_s > 1 && (
          <div style={styles.warn}>重连等待 {link.backoff_s.toFixed(1)}s</div>
        )}
        {/* A disconnected push channel is worth stating: everything above it is
            now on the 2s poll, and TOOL_END will not be visible. */}
        {!live && (
          <div style={styles.warn}>实时通道断开，状态每 2 秒刷新</div>
        )}
      </div>

      {logOpen && (
        <div style={styles.logBox} ref={logRef}>
          {logs.length === 0
            ? <div style={styles.logEmpty}>（暂无日志）</div>
            : logs.map((line, i) => <div key={i} style={styles.logLine}>{line}</div>)}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: {
    padding: 14,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
    fontSize: 13,
    color: '#e8ebf0',
    background: '#0e1116',
    height: '100vh',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    overflow: 'hidden',
  },
  strip: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 10, padding: '9px 14px', background: '#161a21',
    borderRadius: 10, border: '1px solid #242a35', flexShrink: 0,
  },
  stripLeft: { display: 'flex', alignItems: 'center', gap: 9 },
  stripRight: { display: 'flex', gap: 18 },
  statusDot: {
    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
  },
  pill: {
    fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
    textTransform: 'uppercase', letterSpacing: 0.6,
  },
  stripFace: {
    fontSize: 11, fontWeight: 600, color: '#c8cdd6', letterSpacing: 1,
    fontVariantNumeric: 'tabular-nums',
  },
  panelTag: {
    fontSize: 9.5, fontWeight: 600, padding: '3px 8px', borderRadius: 999,
    background: '#1c212b', color: '#626b7a', letterSpacing: 0.3, cursor: 'default',
  },
  stat: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 },
  statKey: {
    fontSize: 8.5, color: '#626b7a', textTransform: 'uppercase', letterSpacing: 0.7,
  },
  statVal: {
    fontSize: 11.5, fontVariantNumeric: 'tabular-nums', color: '#d6dae1',
    fontFamily: 'var(--mono)',
  },
  main: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
  footer: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, flexWrap: 'wrap' },
  footerBtns: { display: 'flex', gap: 6 },
  smallBtn: {
    fontSize: 11.5, padding: '6px 12px', borderRadius: 7, cursor: 'pointer',
    background: '#4c8dff', color: '#fff', border: 'none', fontWeight: 600,
    transition: 'filter .15s',
  },
  smallBtnGhost: { background: '#1c212b', color: '#c8cdd6', border: '1px solid #242a35' },
  hooksMsg: { fontSize: 11.5, color: '#f0b429' },
  warn: {
    fontSize: 11.5, color: '#f0b429', background: 'rgba(240,180,41,0.10)',
    padding: '4px 10px', borderRadius: 6,
  },
  logBox: {
    height: 130, overflowY: 'auto', background: '#0a0c10', borderRadius: 8,
    padding: 10, fontFamily: 'var(--mono)',
    fontSize: 10.5, lineHeight: 1.6, border: '1px solid #242a35', flexShrink: 0,
  },
  logEmpty: { color: '#4a5160' },
  logLine: { color: '#9aa3b0', wordBreak: 'break-all' },
};
