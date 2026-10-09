// Expressions.tsx — the custom-face editor.
//
// Layout is three columns: canvas and the built-in gallery, the layer inspector
// with device settings, and the saved library. Everything that changes what the
// panel shows is reachable from here, which was not true before: brightness,
// speed, rotation and the offline timeout had a firmware handler and a daemon
// helper but no route and no control, so they were unreachable.
//
// The canvas is directly manipulable — drag a layer to move it — because tuning
// a face by typing x/y pairs one digit at a time is the slowest part of the
// whole workflow, and this is a tool for tuning faces.
//
// Nothing here talks to the device. Every request goes through the daemon's
// HTTP API, because the daemon owns the single BLE connection.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EFFECTS,
  EXPR_MAX_BYTES,
  Expression,
  PANEL,
  PRIM_TYPES,
  Prim,
  PrimType,
  Effect,
  drawExpression,
  validate,
} from '../render/renderExpression';
import { BUILTIN_FACES, BUILTIN_ORDER, builtinDrift } from '../render/builtinFaces';
import { DaemonEvent } from '../daemonEvents';
import {
  ANIMATIONS, ANIM_GROUPS, ANIM_BUDGET, BYTE_WARN, MAX_BYTES, MAX_PRIMS,
  PARTS, PART_GROUPS, Part,
} from './shapeLibrary';

const DAEMON = window.claudeHUD.daemonUrl;
const DRAFT_KEY = 'cchud.draft.v1';

const STATES: Array<{ key: string; label: string }> = [
  { key: 'idle', label: '空闲' },
  { key: 'thinking', label: '思考' },
  { key: 'tool_start', label: '工具' },
  { key: 'tool_end', label: '完成' },
  { key: 'waiting', label: '等待' },
  { key: 'error', label: '错误' },
  { key: 'offline', label: '离线' },
];

const STATE_LABEL: Record<string, string> = Object.fromEntries(
  STATES.map((s) => [s.key, s.label]),
);

const DEFAULT_EXPR: Expression = {
  schema: 1,
  id: 'custom',
  name: '我的表情',
  bg: '#0A0C10',
  layers: [
    { type: 'rect', color: '#000000', x: 62, y: 70, w: 28, h: 46 },
    { type: 'rect', color: '#000000', x: 150, y: 70, w: 28, h: 46 },
  ],
};

function blankPrim(type: PrimType): Prim {
  const base: Prim = { type, color: '#000000', x: 0, y: 0 };
  switch (type) {
    case 'rect':   return { ...base, w: 30, h: 30 };
    case 'circle': return { ...base, cx: 120, cy: 120, r: 30 };
    case 'line':   return { ...base, x: 60, y: 120, x2: 180, y2: 120 };
    case 'poly':   return { ...base, points: [[60, 60], [120, 90], [60, 120]] };
    case 'text':   return { ...base, x: 70, y: 110, text: 'HELLO', size: 2 };
  }
}

interface SlotInfo { id: string; name: string; bytes: number }
interface LibraryEntry { id: string; bytes: number }
interface DeviceCfg {
  brightness: number; speed: number; rotation: number; idle_s: number;
}

/**
 * One level of undo for the animation presets. applyAnimation records what the
 * selected layer looked like before the apply; clicking the highlighted preset
 * again restores it. That is the cancel path — no hunting through the layer
 * list for what to delete. For the blink lid, which is a layer that did not
 * exist before, the snapshot records the appended prim so cancel removes
 * exactly it and hands selection back.
 */
type AnimUndo =
  | { kind: 'patch'; index: number; before: Prim; after: Prim }
  | { kind: 'lid'; index: number; lid: Prim; prevSelected: number };

// ── small controls ───────────────────────────────────────────────────────────
// The editor works in effect names; the device works in enum indices. The
// firmware's Fx enum is FX_NONE=0, FX_BLINK=1, FX_PULSE=2, FX_SHAKE=3,
// FX_SPIN=4, FX_FADE=5 — which is exactly EFFECTS' order, so the index is the
// value. Sending the index rather than the name is what makes this reliable:
// the firmware reads the field with `l["effect"] | 0`, and a JSON string read
// that way converts to 0, i.e. FX_NONE. Every uploaded face then silently lost
// its animation while the preview — which renders from the same JSON in the same
// browser — looked correct.
//
// The firmware also accepts the names, but this does not depend on that.
const EFFECT_INDEX: Record<Effect, number> = {
  none: 0, blink: 1, pulse: 2, shake: 3, spin: 4, fade: 5,
};

// The wire form of an expression: effect as an enum index, editor-only fields
// dropped. The on-disk JSON stays human-readable; only what crosses to the
// device changes.
//
// The cast is honest about what is happening: `effect` is a name in every other
// part of the editor, and this one function deliberately lies about its type on
// the way out to the device.
function toWire(expr: Expression): Expression {
  return {
    ...expr,
    layers: expr.layers.map((l) => {
      const { part: _part, ...rest } = l;
      return {
        ...rest,
        effect: EFFECT_INDEX[rest.effect ?? 'none'],
      } as unknown as Prim;
    }),
  };
}

/**
 * True when a layer's animation fields are exactly what a preset applies.
 * Compared on the whole parameter set — effect, period and amount. Amount is
 * what tells 呼吸 (130%) and 缩小 (70%) apart: both are pulse at 1200 ms, and
 * matching without it lit both preset buttons at once. 100 is the firmware's
 * default for a layer that never got an explicit amount (expression.h), so an
 * eyelid built by the graphics library still matches the 眨眼 preset.
 */
function matchesPreset(prim: Prim | undefined, apply: Partial<Prim>): boolean {
  if (!prim) return false;
  return (prim.effect ?? 'none') === (apply.effect ?? 'none')
    && (prim.period_ms ?? 0) === (apply.period_ms ?? 0)
    && (prim.amount ?? 100) === (apply.amount ?? 100);
}

/** The "current effect" readout beside the 动画 header, parameters included. */
function animNowText(prim: Prim | undefined): string {
  if (!prim) return '';
  const effect = prim.effect ?? 'none';
  if (effect === 'none') return '静止';
  const amount = effect === 'blink' ? ''
    : effect === 'shake' ? ` · ${prim.amount ?? 0}px`
    : effect === 'spin' ? ` · ${prim.amount ?? 0}°`
    : ` · ${prim.amount ?? 100}%`;
  return `${effect} · ${prim.period_ms ?? 0}ms${amount}`;
}

function Num({ label, value, onChange }: {
  label: string; value: number; onChange: (n: number) => void;
}) {
  return (
    <label style={s.numLabel}>
      <span style={s.numKey}>{label}</span>
      <input style={s.numInput} type="number" value={value}
             onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

// ── timing: slider + typed seconds ───────────────────────────────────────────
//
// Two reasons this is not just the number box it replaced.
//
// Millisecond integers are the wrong unit for "how often should it blink". A
// person thinks in seconds, and 4600 is a number nobody has a feeling for.
//
// And the range has to be enforced somewhere. The firmware stores period_ms and
// on_ms in uint16_t, so 65535 is a hard ceiling and anything above it is
// truncated to garbage — plus period_ms of 0 makes the firmware drop the effect
// entirely. Both used to be reachable by typing.

const TIMING_RANGE: Record<string, { minMs: number; maxMs: number }> = {
  blink: { minMs: 300,  maxMs: 30000 },
  pulse: { minMs: 200,  maxMs: 10000 },
  shake: { minMs: 100,  maxMs: 5000 },
  spin:  { minMs: 200,  maxMs: 10000 },
  // fade has no entry, and the inspector shows it no period slider: the
  // firmware's FX_FADE blends the colour toward the background once, with no
  // time term, so period_ms does nothing for it — a slider that does nothing
  // is a lie about what the layer will do.
};

/** Floor for an effect's own duration, so a "hold" can never swallow the cycle. */
const ON_MIN_MS = 30;

function TimingField({ label, ms, effect, kind, onChange, maxMs }: {
  label: string;
  ms: number;
  effect: string;
  /** "period" drives the cycle; "on" is only the blink layer's visible span. */
  kind: 'period' | 'on';
  /**
   * Explicit ceiling, overriding the effect's own range. Used for the blink
   * "on" time, whose real limit is the cycle itself: a slider allowed past the
   * period would happily offer values that make the layer permanently visible.
   */
  maxMs?: number;
  onChange: (ms: number) => void;
}) {
  const range = TIMING_RANGE[effect] ?? { minMs: 200, maxMs: 30000 };
  const minMs = kind === 'on' ? ON_MIN_MS : range.minMs;
  // An on-time's ceiling is the period minus a floor; a period's is its range.
  const ceiling = maxMs ?? range.maxMs;
  const maxFloor = minMs + 10;      // keep the slider's max above its min
  const upper = Math.max(maxFloor, ceiling);

  const clamp = (v: number) =>
    Math.max(minMs, Math.min(upper, Math.round(v)));

  const seconds = ms / 1000;
  return (
    <div style={s.timingRow}>
      <div style={s.timingHead}>
        <span style={s.numKey}>{label}</span>
        <span style={s.timingVal}>
          {seconds % 1 === 0 ? seconds.toFixed(0) : seconds.toFixed(2)} 秒
        </span>
      </div>
      <div style={s.timingControls}>
        <input style={s.timingRange}
               type="range"
               min={minMs / 1000}
               max={upper / 1000}
               step={0.05}
               value={Math.max(minMs, Math.min(upper, ms)) / 1000}
               onChange={(e) => onChange(clamp(Number(e.target.value) * 1000))} />
        <input style={s.timingInput}
               type="number"
               step={0.05}
               min={minMs / 1000}
               max={upper / 1000}
               value={seconds}
               onChange={(e) => {
                 const v = Number(e.target.value);
                 if (Number.isFinite(v)) onChange(clamp(v * 1000));
               }} />
      </div>
      <div style={s.timingHint}>
        可调 {minMs / 1000} – {upper / 1000} 秒
        {kind === 'on' ? '（不能超过周期，否则就不眨了）' : ''}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={s.row}>
      <div style={s.rowKey}>{label}</div>
      <div style={s.rowVal}>{children}</div>
    </div>
  );
}

function Slider({ label, value, min, max, onChange, hint }: {
  label: string; value: number; min: number; max: number;
  onChange: (n: number) => void; hint?: string;
}) {
  return (
    <div style={s.sliderRow}>
      <div style={s.sliderHead}>
        <span style={s.numKey}>{label}</span>
        <span style={s.sliderVal}>{value}</span>
      </div>
      <input style={s.slider} type="range" min={min} max={max} value={value}
             onChange={(e) => onChange(Number(e.target.value))} />
      {hint && <div style={s.sliderHint}>{hint}</div>}
    </div>
  );
}

/** A tiny non-interactive preview of one expression. */
function Thumb({ expr, size = 52, onClick, title, badge }: {
  expr: Expression; size?: number; onClick?: () => void;
  title: string; badge?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    drawExpression(ctx, expr, 0);
  }, [expr]);

  return (
    <div style={s.thumb} onClick={onClick} title={title}>
      <canvas ref={ref} width={PANEL.w} height={PANEL.h}
              style={{ width: size, height: size }} />
      <div style={s.thumbLabel}>{badge ?? title}</div>
    </div>
  );
}

// ── canvas hit testing ───────────────────────────────────────────────────────
// Approximate: a layer is "hit" when the point falls inside its bounding box.
// The editor's own boxes are recomputed here rather than imported from the
// firmware, because this is preview geometry, not panel geometry.
function primBox(p: Prim): { x: number; y: number; w: number; h: number } | null {
  switch (p.type) {
    case 'rect':   return { x: p.x ?? 0, y: p.y ?? 0, w: p.w ?? 0, h: p.h ?? 0 };
    case 'circle': {
      const r = p.r ?? 0;
      return { x: (p.cx ?? 0) - r, y: (p.cy ?? 0) - r, w: r * 2, h: r * 2 };
    }
    case 'line': {
      const x1 = p.x ?? 0, y1 = p.y ?? 0, x2 = p.x2 ?? 0, y2 = p.y2 ?? 0;
      return { x: Math.min(x1, x2), y: Math.min(y1, y2),
               w: Math.abs(x2 - x1) + 1, h: Math.abs(y2 - y1) + 1 };
    }
    case 'poly': {
      const pts = p.points ?? [];
      if (pts.length === 0) return null;
      const xs = pts.map((q) => q[0]);
      const ys = pts.map((q) => q[1]);
      return { x: Math.min(...xs), y: Math.min(...ys),
               w: Math.max(...xs) - Math.min(...xs) + 1,
               h: Math.max(...ys) - Math.min(...ys) + 1 };
    }
    case 'text': {
      const size = p.size ?? 2;
      return { x: p.x ?? 0, y: p.y ?? 0,
               w: (p.text ?? '').length * 6 * size, h: 8 * size };
    }
    default: return null;
  }
}

function hitTest(layers: Prim[], px: number, py: number): number {
  // Topmost first, so the last-drawn layer wins.
  for (let i = layers.length - 1; i >= 0; i--) {
    const b = primBox(layers[i]);
    if (b && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return i;
  }
  return -1;
}

function movePrim(p: Prim, dx: number, dy: number): Prim {
  switch (p.type) {
    case 'rect':
    case 'text':
      return { ...p, x: (p.x ?? 0) + dx, y: (p.y ?? 0) + dy };
    case 'circle':
      return { ...p, cx: (p.cx ?? 0) + dx, cy: (p.cy ?? 0) + dy };
    case 'line':
      return { ...p, x: (p.x ?? 0) + dx, y: (p.y ?? 0) + dy,
               x2: (p.x2 ?? 0) + dx, y2: (p.y2 ?? 0) + dy };
    case 'poly':
      return { ...p, points: (p.points ?? []).map(([qx, qy]) => [qx + dx, qy + dy]) };
    default:
      return p;
  }
}

// ── main view ────────────────────────────────────────────────────────────────
export default function Expressions({
  exprEvent,
}: {
  // Frames App's WebSocket forwards that belong to the editor. The daemon has
  // always pushed upload progress and upload results; until now nothing
  // rendered them, so an upload either worked silently or said one word.
  exprEvent: DaemonEvent | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ index: number; lastX: number; lastY: number } | null>(null);
  const animUndoRef = useRef<AnimUndo | null>(null);

  const [expr, setExpr] = useState<Expression>(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Expression;
        if (Array.isArray(parsed.layers) && parsed.layers.length > 0) return parsed;
      }
    } catch { /* a corrupt draft falls back to the default, not a crash */ }
    return DEFAULT_EXPR;
  });

  const [selected, setSelected] = useState(0);
  const [states, setStates] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(`${DRAFT_KEY}.states`);
      if (raw) {
        const parsed = JSON.parse(raw) as string[];
        if (Array.isArray(parsed) && parsed.length) return parsed;
      }
    } catch { /* ignore */ }
    return ['thinking'];
  });

  const [slots, setSlots] = useState<Record<string, SlotInfo>>({});
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  // Upload progress, driven by the daemon's pushed frames. The slot is recorded
  // at POST time so a progress frame from a different upload can be ignored.
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const uploadSlotRef = useRef<number | null>(null);

  // Device settings. Loaded from the daemon, which mirrors what the panel holds.
  const [dev, setDev] = useState<DeviceCfg>({
    brightness: 160, speed: 2, rotation: 1, idle_s: 30,
  });
  const [devOpen, setDevOpen] = useState(false);

  // Import / export.
  const [ioOpen, setIoOpen] = useState(false);
  const [ioText, setIoText] = useState('');

  // Boot animation.
  const [bootDir, setBootDir] = useState('');
  const [bootOpen, setBootOpen] = useState(false);
  const [bootBusy, setBootBusy] = useState(false);

  const problems = useMemo(() => validate(expr), [expr]);
  const bytes = useMemo(() => new TextEncoder().encode(JSON.stringify(expr)).length, [expr]);
  const drift = useMemo(() => builtinDrift(), []);

  // ── draft autosave ─────────────────────────────────────────────────────────
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(expr));
        localStorage.setItem(`${DRAFT_KEY}.states`, JSON.stringify(states));
      } catch { /* quota or disabled storage: editing still works, it just will not persist */ }
    }, 400);
    return () => clearTimeout(id);
  }, [expr, states]);

  // ── animated preview ───────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const start = performance.now();
    const tick = () => {
      drawExpression(ctx, expr, performance.now() - start);
      // Selection outline, drawn after the face so it is never hidden by it.
      const prim = expr.layers[selected];
      const box = prim ? primBox(prim) : null;
      if (box) {
        ctx.strokeStyle = '#4c8dff';
        ctx.lineWidth = 1;
        ctx.strokeRect(box.x - 1.5, box.y - 1.5, box.w + 3, box.h + 3);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [expr, selected]);

  // ── device + library ───────────────────────────────────────────────────────
  const refreshSlots = useCallback(async () => {
    try {
      const res = await fetch(`${DAEMON}/expressions`);
      const body = await res.json();
      setSlots(body.slots ?? {});
      setLibrary(body.library ?? []);
    } catch {
      setSlots({});
      setLibrary([]);
    }
  }, []);

  const refreshDevice = useCallback(async () => {
    try {
      const res = await fetch(`${DAEMON}/device`);
      const body = await res.json();
      if (body?.config) setDev(body.config);
    } catch { /* daemon down: the panel keeps its last known values */ }
  }, []);

  useEffect(() => { refreshSlots(); refreshDevice(); }, [refreshSlots, refreshDevice]);

  // ── live feedback from the device ──────────────────────────────────────────
  // The progress bar needs the pushed frames, not the HTTP reply: the reply
  // arrives only after the whole blob has been chunked across, and a 4 KB
  // upload at ~10 KB/s is long enough that nothing-is-happening is the wrong
  // impression to leave.
  useEffect(() => {
    if (!exprEvent) return;

    if (exprEvent.type === 'expr-progress' &&
        typeof exprEvent.sent === 'number' && typeof exprEvent.total === 'number') {
      // Only show progress for the upload this view initiated. App forwards
      // every expr frame, including one triggered by the CLI or another panel,
      // and a foreign upload's bar in the middle of ours would be a lie.
      if (uploadSlotRef.current === null) return;
      setProgress({ sent: exprEvent.sent, total: exprEvent.total });
      return;
    }

    if (exprEvent.type === 'expr-uploaded') {
      if (uploadSlotRef.current !== null) {
        if (exprEvent.slot !== undefined && exprEvent.slot !== uploadSlotRef.current) return;
        uploadSlotRef.current = null;
        setProgress(null);
      }
      const bound = (exprEvent.bound ?? []).map((b) => b.state);
      const rejected = exprEvent.rejected ?? [];
      setMsg(
        `已写入 slot ${exprEvent.slot}（${exprEvent.bytes ?? '?'} 字节）` +
        `${bound.length ? ` → ${bound.join('、')}` : ' → 未绑定'}` +
        `${rejected.length ? `；设备拒绝绑定：${rejected.join('、')}` : ''}`,
      );
      refreshSlots();
      return;
    }

    if (exprEvent.type === 'expr-failed') {
      if (uploadSlotRef.current !== null) {
        uploadSlotRef.current = null;
        setProgress(null);
      }
      setMsg(`上传失败：${exprEvent.error ?? '未知原因'}`
             + `${exprEvent.ack_code != null ? `（ack=${exprEvent.ack_code}）` : ''}`);
      return;
    }

    if (exprEvent.type === 'expr-deleted') {
      // Unbinding used to be claimed unconditionally, so a slot could be deleted
      // from the UI while the panel kept showing its face. Report both halves.
      const unbound = exprEvent.unbound ?? [];
      const failed = exprEvent.failed ?? [];
      setMsg(
        `slot ${exprEvent.slot} 已删除` +
        `${unbound.length ? `，解绑：${unbound.join('、')}` : ''}` +
        `${failed.length
          ? `；但设备未确认解绑：${failed.join('、')}（设备可能仍在显示该表情）`
          : ''}`,
      );
      refreshSlots();
      return;
    }

    // expr-selected arrives when another client rebinds a state; nothing to
    // render here beyond refreshing the slot list.
    if (exprEvent.type === 'expr-selected') {
      refreshSlots();
      return;
    }

    // device-config: another client changed the display settings. The daemon
    // broadcasts the full config after every POST /device/config, so we can
    // update locally without waiting for a refetch.
    if (exprEvent.type === 'device-config') {
      if (typeof exprEvent.brightness === 'number') setDev((prev) => ({
        ...prev, brightness: exprEvent.brightness!,
      }));
      if (typeof exprEvent.speed === 'number') setDev((prev) => ({
        ...prev, speed: exprEvent.speed!,
      }));
      if (typeof exprEvent.rotation === 'number') setDev((prev) => ({
        ...prev, rotation: exprEvent.rotation!,
      }));
      if (typeof exprEvent.idle_s === 'number') setDev((prev) => ({
        ...prev, idle_s: exprEvent.idle_s!,
      }));
      return;
    }

    // boot-*: boot animation upload progress and results. Surface as a message
    // so the user knows what happened without watching the log panel.
    if (exprEvent.type === 'boot-uploaded') {
      const files = Array.isArray(exprEvent.files)
        ? exprEvent.files.map((f) => (typeof f === 'string' ? f : f.name))
        : [];
      setMsg(`Boot 动画已上传（${files.join(', ')}，${exprEvent.bytes ?? '?'} 字节）`);
      return;
    }
    if (exprEvent.type === 'boot-failed') {
      setMsg(`Boot 动画上传失败：${exprEvent.error ?? '未知原因'}`);
      return;
    }
    if (exprEvent.type === 'boot-playing') {
      setMsg('正在播放 boot 动画');
      return;
    }
  }, [exprEvent, refreshSlots]);

  // ── editing helpers ────────────────────────────────────────────────────────
  const patchPrim = (index: number, patch: Partial<Prim>) => {
    setExpr((prev) => ({
      ...prev,
      layers: prev.layers.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    }));
  };

  const addPrim = (type: PrimType) => {
    setExpr((prev) => (
      prev.layers.length >= MAX_PRIMS
        ? prev
        : { ...prev, layers: [...prev.layers, blankPrim(type)] }
    ));
    setSelected(expr.layers.length);
  };

  const removePrim = (index: number) => {
    setExpr((prev) => ({ ...prev, layers: prev.layers.filter((_, i) => i !== index) }));
    setSelected(0);
  };

  const prim = expr.layers[selected];

  // ── canvas dragging (C) ────────────────────────────────────────────────────
  const canvasPoint = (e: React.MouseEvent): { x: number; y: number } => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * PANEL.w,
      y: ((e.clientY - rect.top) / rect.height) * PANEL.h,
    };
  };

  const onCanvasDown = (e: React.MouseEvent) => {
    const pt = canvasPoint(e);
    const hit = hitTest(expr.layers, pt.x, pt.y);
    if (hit < 0) return;
    setSelected(hit);
    dragRef.current = { index: hit, lastX: pt.x, lastY: pt.y };
    e.preventDefault();
  };

  const onCanvasMove = (e: React.MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const pt = canvasPoint(e);
    const dx = Math.round(pt.x - drag.lastX);
    const dy = Math.round(pt.y - drag.lastY);
    if (dx === 0 && dy === 0) return;
    drag.lastX = pt.x;
    drag.lastY = pt.y;
    setExpr((prev) => ({
      ...prev,
      layers: prev.layers.map((l, i) => (i === drag.index ? movePrim(l, dx, dy) : l)),
    }));
  };

  const endDrag = () => { dragRef.current = null; };

  // ── device settings (A) ────────────────────────────────────────────────────
  const pushDevice = async (patch: Partial<DeviceCfg>) => {
    const next = { ...dev, ...patch };
    setDev(next);
    try {
      const res = await fetch(`${DAEMON}/device/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await res.json();
      if (!res.ok) setMsg(`设备设置保存失败：${body.error ?? res.status}`);
      else if (!body.pushed) setMsg('已保存到本机，但设备当前离线，重连后生效');
    } catch (e) {
      setMsg(`设备设置请求失败：${(e as Error).message}`);
    }
  };

  // ── boot animation (E) ──────────────────────────────────────────────────────
  const uploadBoot = async () => {
    if (!bootDir.trim()) {
      setMsg('请先填写 boot 文件目录路径');
      return;
    }
    setBootBusy(true);
    setMsg('正在上传 boot 动画…');
    try {
      const res = await fetch(`${DAEMON}/boot/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: bootDir.trim() }),
      });
      const body = await res.json();
      if (!res.ok) {
        setMsg(`Boot 上传失败：${body.error ?? res.status}`);
      } else {
        const files = (body.files ?? []).map((f: { name: string; bytes: number }) =>
          `${f.name}(${f.bytes}B)`).join(', ');
        setMsg(`Boot 已上传：${files}`);
      }
    } catch (e) {
      setMsg(`Boot 上传请求失败：${(e as Error).message}`);
    } finally {
      setBootBusy(false);
    }
  };

  const playBoot = async () => {
    setMsg('正在播放 boot 动画…');
    try {
      const res = await fetch(`${DAEMON}/boot/play`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) {
        setMsg(`Boot 播放失败：${body.error ?? res.status}`);
      } else {
        setMsg('已发送播放指令');
      }
    } catch (e) {
      setMsg(`Boot 播放请求失败：${(e as Error).message}`);
    }
  };

  // ── test upload (F) ─────────────────────────────────────────────────────────
  const runTest = async () => {
    setBusy(true);
    setMsg('正在上传测试表情…');
    try {
      const res = await fetch(`${DAEMON}/expressions/test`, { method: 'GET' });
      const body = await res.json();
      if (!res.ok) {
        setMsg(`测试上传失败：${body.error ?? res.status}`);
      } else {
        setMsg(`测试表情已上传（slot ${body.slot}，绑定到 thinking）`);
        refreshSlots();
      }
    } catch (e) {
      setMsg(`测试上传请求失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // ── import / export (D) ────────────────────────────────────────────────────
  const exportJson = async () => {
    const text = JSON.stringify(expr, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setMsg(`已复制到剪贴板（${text.length} 字符）`);
    } catch {
      // Clipboard access can be denied; fall back to showing the text so it can
      // still be copied by hand.
      setIoText(text);
      setIoOpen(true);
      setMsg('剪贴板不可用，已改为显示原文');
    }
  };

  const importJson = () => {
    try {
      const parsed = JSON.parse(ioText) as Expression;
      if (!Array.isArray(parsed.layers) || parsed.layers.length === 0) {
        setMsg('导入失败：没有 layers');
        return;
      }
      setExpr({ ...DEFAULT_EXPR, ...parsed });
      setSelected(0);
      setIoOpen(false);
      setMsg(`已导入（${parsed.layers.length} 个图层）`);
    } catch (e) {
      setMsg(`导入失败：${(e as Error).message}`);
    }
  };

  // ── built-in gallery (B) ───────────────────────────────────────────────────
  const loadBuiltin = (state: string) => {
    const face = BUILTIN_FACES[state];
    if (!face) return;
    // A copy, not a reference: the firmware treats an uploaded face as the
    // user's own, and editing it must not appear to change the built-in.
    setExpr({ ...face, id: 'custom', name: `仿 · ${face.name ?? state}` });
    setSelected(0);
    setMsg(`已载入「${STATE_LABEL[state] ?? state}」作为修改起点`);
  };

  // ── graphics library ───────────────────────────────────────────────────────
  // A part is a group of layers that only makes sense together, so it is added
  // as a group and selected as a group: picking the eyelid out of a one-click
  // eye to retune it is the fiddly work this library exists to avoid.
  const addPart = (part: Part) => {
    setExpr((prev) => {
      const added = part.build(prev.bg ?? '#0A0C10');
      if (prev.layers.length + added.length > MAX_PRIMS) {
        // Reported through the message line rather than a dialog: the ceiling is
        // a design constraint, not an error, and the user is mid-edit.
        setMsg(`再加会超过 ${MAX_PRIMS} 个图层上限，先删掉一些`);
        return prev;
      }
      // Tag each layer with the part that made it. The device never sees this
      // field — it is what lets the layer list delete the part as a group.
      const tagged = added.map((l) => ({ ...l, part: part.id }));
      // Select the first layer of what was just added, so the animation presets
      // act on the new part rather than on whatever happened to be selected.
      setSelected(prev.layers.length);
      setMsg(`已添加「${part.name}」— ${part.hint}`);
      return { ...prev, layers: [...prev.layers, ...tagged] };
    });
  };

  // Layers grouped by consecutive part, so the layer list can show a part as one
  // row and delete it as one row. Consecutive runs rather than a part->indices
  // map: the same part added twice (two eyes from one button) stays two rows,
  // because deleting one should not silently delete the other.
  const layerGroups = useMemo(() => {
    const groups: Array<{ part: string | null; name: string; indices: number[] }> = [];
    expr.layers.forEach((l, i) => {
      const last = groups[groups.length - 1];
      if (l.part && last && last.part === l.part) {
        last.indices.push(i);
      } else {
        const part = PARTS.find((p) => p.id === l.part);
        groups.push({
          part: l.part ?? null,
          name: part?.name ?? (l.part ? l.part : ''),
          indices: [i],
        });
      }
    });
    return groups;
  }, [expr.layers]);

  // Remove a set of layers by index, keeping the rest in order and moving the
  // selection to something that still exists.
  const removeIndices = (indices: number[]) => {
    const drop = new Set(indices);
    setExpr((prev) => {
      const layers = prev.layers.filter((_, i) => !drop.has(i));
      const firstKept = Math.min(...indices);
      setSelected(Math.max(0, Math.min(firstKept, layers.length - 1)));
      return { ...prev, layers };
    });
  };

  // ── animation library ──────────────────────────────────────────────────────
  // Applies a tuned effect to the selected layer. The numbers behind each
  // preset are the reason this exists: they were previously something you had
  // to know, not choose.
  //
  // Blink is the one effect that cannot simply be applied to whatever is
  // selected, and getting that wrong was the bug this branch fixes.
  //
  // FX_BLINK toggles the layer's visibility — it has no idea what the layer
  // means. On a highlight dot that reads as flashing; on a background-coloured
  // rectangle laid over an eye it reads as the eye closing; on the eye itself it
  // makes the eye vanish, which leaves the pupil and highlight floating on the
  // background. The preview and the panel agree on this (both implement
  // `visible = phase < on_ms`), so the disagreement the user saw was between
  // what they expected and what the layer actually is.
  //
  // So: apply to a layer that already is a cover, and synthesise the cover
  // otherwise. The synthesis is what makes "select the eye, click 眨眼" do the
  // right thing instead of silently doing the wrong one.
  const applyAnimation = (animId: string) => {
    const anim = ANIMATIONS.find((a) => a.id === animId);
    if (!anim) return;
    setExpr((prev) => {
      if (prev.layers.length === 0) {
        setMsg('先添加一个图形，再选动画');
        return prev;
      }

      const target = prev.layers[selected];

      // Clicking the preset that is already active on this layer cancels it by
      // restoring the snapshot the last apply left behind. 静止 is excluded:
      // it is the explicit "make it static", never a toggle.
      if (animId !== 'none' && matchesPreset(target, anim.apply)) {
        const u = animUndoRef.current;
        if (u && u.index === selected) {
          // The layer must still be what the apply produced; if it was edited
          // since, the snapshot no longer describes it and restoring would
          // clobber those edits.
          const unchanged = (i: number, p: Prim) =>
            i < prev.layers.length &&
            JSON.stringify(prev.layers[i]) === JSON.stringify(p);
          if (u.kind === 'patch' && unchanged(u.index, u.after)) {
            animUndoRef.current = null;
            const layers = prev.layers.map((l, i) =>
              (i === u.index ? u.before : l));
            setMsg(`已取消「${anim.name}」，恢复到应用前的状态`);
            return { ...prev, layers };
          }
          if (u.kind === 'lid' && unchanged(u.index, u.lid)) {
            animUndoRef.current = null;
            const layers = prev.layers.filter((_, i) => i !== u.index);
            setSelected(u.prevSelected);
            setMsg(`已取消「${anim.name}」，撤掉了补的眼皮`);
            return { ...prev, layers };
          }
          // The preset matches but the snapshot is stale (the layer was loaded
          // from a library or edited since). Re-applying silently would read
          // as a cancel button that does nothing, so say why instead.
          setMsg(`「${anim.name}」不是刚通过按钮应用的（图层已改动），可用「静止」取消`);
          return prev;
        }
        // No snapshot for this layer — fall through and apply, which takes one.
      }

      const bg = (prev.bg ?? '#0A0C10').toLowerCase();
      const isCover = target.type === 'rect' &&
        (target.color ?? '').toLowerCase() === bg;

      if (anim.apply.effect === 'blink' && !isCover) {
        const box = primBox(target);
        if (box && box.w > 2 && box.h > 2) {
          // A lid over the selected layer's whole box, in the background
          // colour. Full coverage rather than a band: a band reads as a chunk
          // cut out of the middle, while covering the whole thing reads as the
          // eye closing.
          //
          // Appended at the END of the layer list — the lid has to draw after
          // everything it needs to cover. An eye with a pupil inside it would
          // otherwise leave the pupil painting on top of the closed lid, and a
          // light dot floating on the background is exactly the "cut into
          // blocks" look.
          const lid = {
            type: 'rect' as const,
            x: box.x, y: box.y, w: box.w, h: box.h,
            color: prev.bg ?? '#0A0C10',
            effect: 'blink' as const,
            period_ms: anim.apply.period_ms,
            on_ms: anim.apply.on_ms,
            amount: 100,
          };
          const layers = [...prev.layers, lid];
          animUndoRef.current = {
            kind: 'lid', index: layers.length - 1, lid,
            prevSelected: selected,
          };
          setSelected(layers.length - 1);
          setMsg('已加一块眼皮（背景色、全覆盖、画在最上层）');
          return { ...prev, layers };
        }
        // No measurable box — fall through and apply to the layer itself.
      }

      const after = { ...target, ...anim.apply };
      animUndoRef.current = { kind: 'patch', index: selected, before: target, after };
      const layers = prev.layers.map((l, i) => (i === selected ? after : l));
      setMsg(`「${anim.name}」已应用到 ${prev.layers[selected].type} — ${anim.hint}`);
      return { ...prev, layers };
    });
  };

  // The three limits worth knowing before uploading, all of which the device
  // enforces by silently ignoring the excess.
  // Changing the background has to move the cover layers with it. An eyelid or a
  // highlight is drawn in the background colour precisely so it is invisible
  // until it covers something; leave it at the old colour and it becomes a solid
  // block that blinks on and off in front of the face.
  //
  // Detected by "a rect whose colour equals what the background used to be",
  // which is the only signal available — the face JSON has no back-reference to
  // say "this is a lid".
  const setBackground = (hex: string) => {
    setExpr((prev) => {
      const previous = (prev.bg ?? '#0A0C10').toLowerCase();
      const layers = prev.layers.map((l) =>
        (l.type === 'rect' && (l.color ?? '').toLowerCase() === previous)
          ? { ...l, color: hex }
          : l);
      return { ...prev, bg: hex, layers };
    });
  };

  const animCount = useMemo(
    () => expr.layers.filter((l) => (l.effect ?? 'none') !== 'none').length,
    [expr.layers]);

  // ── library actions ────────────────────────────────────────────────────────
  const loadFromLibrary = async (id: string) => {
    setMsg('载入中…');
    try {
      const res = await fetch(`${DAEMON}/expressions/item/${encodeURIComponent(id)}`);
      const body = await res.json();
      if (!res.ok) {
        setMsg(`载入失败：${body.error ?? res.status}`);
        return;
      }
      setExpr({ ...body.expression, id });
      setSelected(0);
      setMsg(`已载入「${id}」`);
    } catch (e) {
      setMsg(`载入失败：${(e as Error).message}`);
    }
  };

  const deleteSlot = async (slot: string) => {
    setMsg(`删除 slot ${slot}…`);
    try {
      const res = await fetch(`${DAEMON}/expressions/${slot}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) setMsg(`删除失败：${body.error ?? res.status}`);
      else {
        // Unbinding is now confirmed by the device, so 'failed' names the states
        // the panel did not agree to release. Those keep showing this slot's
        // face until the device is rebooted or the slot is overwritten.
        const unbound = (body.unbound ?? []).join('、');
        const failed = (body.failed ?? []).join('、');
        setMsg(`slot ${slot} 已清空${unbound ? `，解绑：${unbound}` : ''}`
               + `${failed ? `；未确认解绑：${failed}` : ''}`);
        refreshSlots();
      }
    } catch (e) {
      setMsg(`删除失败：${(e as Error).message}`);
    }
  };

  // ── upload ─────────────────────────────────────────────────────────────────
  const upload = async () => {
    if (problems.length > 0) {
      setMsg(`先修复：${problems[0]}`);
      return;
    }
    setBusy(true);
    setMsg('上传中…');
    try {
      const res = await fetch(`${DAEMON}/expressions/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: expr.id ?? 'custom', name: expr.name,
                               expression: toWire(expr), states }),
      });
      const body = await res.json();
      if (!res.ok) {
        // The pushed expr-failed frame usually arrives first and has already
        // set a message; only overwrite it when the HTTP call itself failed
        // before the daemon could report the device's verdict.
        setProgress(null);
        setMsg(`上传失败：${body.error ?? res.status}`);
        return;
      }

      // The daemon confirms each binding with the device now, so 'bound' is
      // what actually took rather than what was requested. Showing the request
      // instead is what made binding feel like it did nothing.
      const bound = (body.bound ?? []).map((b: { state: string }) => b.state);
      const rejected = body.rejected ?? [];
      setMsg(`已上传 slot ${body.slot}（${body.bytes} 字节）`
             + `${bound.length ? ` → ${bound.join('、')}` : ' → 未绑定'}`
             + `${rejected.length
                ? `；设备拒绝绑定：${rejected.join('、')}（状态越界或槽位内容无法解析）`
                : ''}`);
      setProgress(null);
      refreshSlots();
    } catch (e) {
      setProgress(null);
      setMsg(`请求失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
      uploadSlotRef.current = null;
    }
  };

  // Progress the daemon has actually confirmed, not a guess from the request.
  const pct = progress && progress.total > 0
    ? Math.round((progress.sent / progress.total) * 100)
    : 0;
  const onUpload = () => {
    // Marks the upload as ours so its progress frames are the only ones shown.
    // The slot itself is not known yet — the daemon reports it in the reply, and
    // progress frames arrive before that — so the ref is a boolean, not a slot.
    uploadSlotRef.current = -1;
    setProgress({ sent: 0, total: bytes });
    void upload();
  };

  const slotCount = Object.keys(slots).length;

  return (
    <div style={s.app}>
      <div style={s.header}>
        <span style={s.title}>表情编辑器</span>
        <span style={{
          ...s.meta,
          color: bytes > MAX_BYTES ? '#e5484d' : bytes > BYTE_WARN ? '#f0b429' : '#8a8a90',
        }}
              title={bytes > BYTE_WARN ? '接近 4096 字节上限，设备会拒收' : ''}>
          {bytes} / {MAX_BYTES} 字节
        </span>
      </div>

      <div style={s.body}>
        {/* ── column 1: canvas + built-ins + binding ── */}
        <div style={s.col1}>
          <div style={s.canvasWrap}>
            <canvas
              ref={canvasRef}
              width={PANEL.w}
              height={PANEL.h}
              style={{ ...s.canvas, cursor: dragRef.current ? 'grabbing' : 'grab' }}
              onMouseDown={onCanvasDown}
              onMouseMove={onCanvasMove}
              onMouseUp={endDrag}
              onMouseLeave={endDrag}
            />
          </div>
          <div style={s.hint}>拖动画布中的图层可移动位置</div>

          {/* ── background colour ──────────────────────────────────────────────
              Directly under the canvas, ahead of everything else: it is a
              property of the whole face rather than of a layer, and burying it
              below two long panels made it unreachable — which is exactly what
              happened before this moved up top. */}
          <div style={s.bgBox}>
            <div style={s.bgHead}>
              <span style={s.sectionKey}>背景色</span>
              <span style={s.bgHex}>{expr.bg ?? '#0A0C10'}</span>
            </div>
            <div style={s.bgRow}>
              <input type="color" value={expr.bg ?? '#0A0C10'}
                     onChange={(e) => setBackground(e.target.value)} />
              <span style={s.bgNote}>
                面板底色。图形库生成的眼皮/高光会自动跟着它变色，改完上传即可看到。
              </span>
            </div>
          </div>

          <div style={s.sectionKey}>内置表情（点击作为修改起点）</div>
          {drift.length > 0 && (
            <div style={s.driftWarn}>
              预览与固件不一致：{drift.join('；')}
            </div>
          )}
          <div style={s.builtinRow}>
            {BUILTIN_ORDER.map((st) => (
              <Thumb
                key={st}
                expr={BUILTIN_FACES[st]}
                onClick={() => loadBuiltin(st)}
                title={`载入「${STATE_LABEL[st] ?? st}」`}
                badge={st.slice(0, 6)}
              />
            ))}
          </div>

          {/* ── graphics library ────────────────────────────────────────────
              Replaces "know what layers a blinking eye needs" with a click.
              Grouped by what the part is, and every button carries the hint
              that says what it will look like, because a bare label like
              "圆眼" does not tell you it also brings an eyelid. */}
          <div style={s.sectionKey}>图形库</div>
          {PART_GROUPS.map((group) => (
            <div key={group} style={s.partGroup}>
              <div style={s.partGroupKey}>{group}</div>
              <div style={s.partRow}>
                {PARTS.filter((p) => p.group === group).map((p) => (
                  <button key={p.id} style={s.partBtn}
                          title={p.hint}
                          onClick={() => addPart(p)}>
                    <span style={s.partName}>{p.name}</span>
                    <span style={s.partHint}>{p.hint}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}

          <div style={s.sectionKey}>绑定到状态</div>
          <div style={s.chips}>
            {STATES.map((st) => (
              <button
                key={st.key}
                title={st.label}
                style={{ ...s.chip, ...(states.includes(st.key) ? s.chipOn : null) }}
                onClick={() => setStates((prev) =>
                  prev.includes(st.key) ? prev.filter((k) => k !== st.key) : [...prev, st.key])}
              >
                {st.key}
              </button>
            ))}
          </div>
          <Row label="名称">
            <input style={s.textInput} value={expr.name ?? ''}
                   onChange={(e) => setExpr((p) => ({ ...p, name: e.target.value }))} />
          </Row>
        </div>

        {/* ── column 2: layers + animation library + inspector + settings ── */}
        <div style={s.col2}>
          {/* The three ceilings the device enforces by silently dropping the
              excess. Shown before uploading rather than discovered after. */}
          <div style={s.sectionKey}>
            图层 {expr.layers.length}/{MAX_PRIMS}
            <span style={{
              ...s.gauge,
              color: expr.layers.length >= MAX_PRIMS ? '#e5484d'
                   : expr.layers.length >= MAX_PRIMS - 4 ? '#f0b429' : '#8a8a90',
            }}>
              {expr.layers.length >= MAX_PRIMS ? '已满'
                : expr.layers.length >= MAX_PRIMS - 4 ? '接近上限' : '余量充足'}
            </span>
          </div>
          {animCount > ANIM_BUDGET && (
            <div style={s.driftWarn}>
              同时动画 {animCount} 个图层，超过建议的 {ANIM_BUDGET} 个。
              面板会开始变卡、状态切换延迟——这是 SPI 带宽和 BLE 在抢同一个核，
              不是故障。减少动画图层即可。
            </div>
          )}
          {/* Grouped by part: a row that came from the graphics library shows its
              name and deletes as one unit, because that is how it was added.
              Layers without a part still show individually. */}
          <div style={s.layerList}>
            {layerGroups.map((group, gi) => {
              const groupSelected = group.indices.includes(selected);
              const isPart = group.part !== null;
              return (
                <div key={gi} style={{ ...s.layerItem, ...(groupSelected ? s.layerItemOn : null) }}
                     onClick={() => setSelected(group.indices[0])}>
                  {isPart ? (
                    <>
                      <span style={s.layerPart}>{group.name}</span>
                      <span style={s.layerCount}>{group.indices.length} 层</span>
                    </>
                  ) : (
                    <>
                      <span style={s.layerType}>{expr.layers[group.indices[0]].type}</span>
                      <span style={{
                        ...s.swatch,
                        background: expr.layers[group.indices[0]].color,
                      }} />
                    </>
                  )}
                  <button style={s.layerDel}
                          title={isPart ? `删除整个「${group.name}」` : '删除这一层'}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isPart) {
                              removeIndices(group.indices);
                              setMsg(`已删除「${group.name}」（${group.indices.length} 层）`);
                            } else {
                              removePrim(group.indices[0]);
                            }
                          }}>×</button>
                </div>
              );
            })}
            {expr.layers.length === 0 && (
              <div style={s.libEmpty}>（还没有图层，从左边图形库添加）</div>
            )}
          </div>
          <div style={s.addRow}>
            {PRIM_TYPES.map((t) => (
              <button key={t} style={s.addBtn} onClick={() => addPrim(t)}>+{t}</button>
            ))}
          </div>

          {prim && (
            <div style={s.inspector}>
              <div style={s.sectionKey}>属性 — {prim.type}</div>

              {/* ── animation library ──────────────────────────────────────────
                  Sits above the raw fields, because choosing "眨眼" is the
                  intent and period_ms/on_ms are the implementation. The numeric
                  fields stay visible so a preset can still be tuned after. */}
              <div style={s.animLib}>
                <div style={s.animLibHead}>
                  <span style={s.sectionKey}>动画</span>
                  <span style={s.animNow}>{animNowText(prim)}</span>
                </div>
                {ANIM_GROUPS.map((group) => (
                  <div key={group} style={s.animGroupRow}>
                    <span style={s.animGroupKey}>{group}</span>
                    {ANIMATIONS.filter((a) => a.group === group).map((a) => {
                      // Highlight is the same matchesPreset() the cancel
                      // toggle keys off, so what is lit is exactly what
                      // clicking again would undo.
                      const active = matchesPreset(prim, a.apply);
                      return (
                        <button key={a.id}
                                title={active ? `${a.hint}（再点一次取消）` : a.hint}
                                style={{ ...s.animBtn, ...(active ? s.animBtnOn : null) }}
                                onClick={() => applyAnimation(a.id)}>
                          {a.name}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>

              <Row label="颜色">
                <input type="color" value={prim.color}
                       onChange={(e) => patchPrim(selected, { color: e.target.value })} />
              </Row>

              {prim.type === 'rect' && (<>
                <Num label="x" value={prim.x ?? 0} onChange={(v) => patchPrim(selected, { x: v })} />
                <Num label="y" value={prim.y ?? 0} onChange={(v) => patchPrim(selected, { y: v })} />
                <Num label="宽" value={prim.w ?? 0} onChange={(v) => patchPrim(selected, { w: v })} />
                <Num label="高" value={prim.h ?? 0} onChange={(v) => patchPrim(selected, { h: v })} />
              </>)}

              {prim.type === 'circle' && (<>
                <Num label="cx" value={prim.cx ?? 0} onChange={(v) => patchPrim(selected, { cx: v })} />
                <Num label="cy" value={prim.cy ?? 0} onChange={(v) => patchPrim(selected, { cy: v })} />
                <Num label="半径" value={prim.r ?? 0} onChange={(v) => patchPrim(selected, { r: v })} />
              </>)}

              {prim.type === 'line' && (<>
                <Num label="x1" value={prim.x ?? 0} onChange={(v) => patchPrim(selected, { x: v })} />
                <Num label="y1" value={prim.y ?? 0} onChange={(v) => patchPrim(selected, { y: v })} />
                <Num label="x2" value={prim.x2 ?? 0} onChange={(v) => patchPrim(selected, { x2: v })} />
                <Num label="y2" value={prim.y2 ?? 0} onChange={(v) => patchPrim(selected, { y2: v })} />
              </>)}

              {prim.type === 'poly' && (
                <Row label="顶点">
                  <textarea style={s.textarea} rows={4}
                            value={JSON.stringify(prim.points ?? [])}
                            onChange={(e) => {
                              try { patchPrim(selected, { points: JSON.parse(e.target.value) }); }
                              catch { /* keep the last valid value while typing */ }
                            }} />
                </Row>
              )}

              {prim.type === 'text' && (<>
                <Row label="文字">
                  <input style={s.textInput} value={prim.text ?? ''} maxLength={24}
                         onChange={(e) => patchPrim(selected, { text: e.target.value })} />
                </Row>
                <Num label="x" value={prim.x ?? 0} onChange={(v) => patchPrim(selected, { x: v })} />
                <Num label="y" value={prim.y ?? 0} onChange={(v) => patchPrim(selected, { y: v })} />
                <Num label="字号" value={prim.size ?? 2} onChange={(v) => patchPrim(selected, { size: v })} />
              </>)}

              <Row label="效果">
                <select value={prim.effect ?? 'none'}
                        onChange={(e) => patchPrim(selected, { effect: e.target.value as Effect })}>
                  {EFFECTS.map((fx) => <option key={fx} value={fx}>{fx}</option>)}
                </select>
              </Row>

              {(prim.effect ?? 'none') !== 'none' && prim.effect !== 'fade' && (
                /* fade is excluded above: it has no cycle on the device, so a
                    period field would offer control the panel ignores. Its one
                    real parameter, the blend percentage, stays below. */
                <TimingField
                  label="触发周期"
                  ms={prim.period_ms ?? 0}
                  effect={prim.effect ?? 'none'}
                  kind="period"
                  onChange={(v) => patchPrim(selected, { period_ms: v })} />
              )}

              {prim.effect === 'blink' && (
                <TimingField
                  label="盖住时长"
                  // The ceiling is the cycle itself, minus the floor: at or
                  // above it the eyelid is always visible, which is the
                  // opposite of blinking. Passing it as the range is what
                  // keeps the slider from offering those values.
                  maxMs={(prim.period_ms ?? 1000) - ON_MIN_MS}
                  ms={prim.on_ms ?? 0}
                  effect="blink"
                  kind="on"
                  onChange={(v) => patchPrim(selected, { on_ms: v })} />
              )}

              {['pulse', 'shake', 'spin', 'fade'].includes(prim.effect ?? '') && (
                <Num label={prim.effect === 'shake' ? '抖动px'
                        : prim.effect === 'spin' ? '角度/周期' : '百分比'}
                     value={prim.amount ?? 100}
                     onChange={(v) => patchPrim(selected, { amount: v })} />
              )}
            </div>
          )}

          {/* ── device settings (A) ── */}
          <div style={s.devBox}>
            <button style={s.devHead} onClick={() => setDevOpen((v) => !v)}>
              <span>设备设置</span>
              <span style={s.devChevron}>{devOpen ? '▾' : '▸'}</span>
            </button>
            {devOpen && (
              <div style={s.devBody}>
                <Slider label="亮度" value={dev.brightness} min={0} max={255}
                        onChange={(v) => pushDevice({ brightness: v })}
                        hint="背光 PWM，0 为全暗" />
                <Row label="动画速度">
                  <select value={dev.speed} onChange={(e) => pushDevice({ speed: Number(e.target.value) })}>
                    <option value={1}>慢</option>
                    <option value={2}>正常</option>
                    <option value={3}>快</option>
                  </select>
                </Row>
                <Row label="屏幕旋转">
                  <select value={dev.rotation}
                          onChange={(e) => pushDevice({ rotation: Number(e.target.value) })}>
                    <option value={0}>0°</option>
                    <option value={1}>90°</option>
                    <option value={2}>180°</option>
                    <option value={3}>270°</option>
                  </select>
                </Row>
                <Slider label="离线判定（秒）" value={dev.idle_s} min={5} max={300}
                        onChange={(v) => pushDevice({ idle_s: v })}
                        hint="主机多久不说话就算离线" />
              </div>
            )}
          </div>

          {/* ── boot animation (E) ── */}
          <div style={s.devBox}>
            <button style={s.devHead} onClick={() => setBootOpen((v) => !v)}>
              <span>Boot 动画</span>
              <span style={s.devChevron}>{bootOpen ? '▾' : '▸'}</span>
            </button>
            {bootOpen && (
              <div style={s.devBody}>
                <Row label="文件目录">
                  <input style={s.textInput} type="text" placeholder="含 meta.json/segs.bin/tris.bin 的目录"
                         value={bootDir}
                         onChange={(e) => setBootDir(e.target.value)} />
                </Row>
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button style={{ ...s.addBtn, flex: 1 }}
                          disabled={bootBusy} onClick={uploadBoot}>
                    {bootBusy ? '上传中…' : '上传 Boot'}
                  </button>
                  <button style={{ ...s.addBtn, ...s.smallBtnGhost }}
                          onClick={playBoot}>播放</button>
                </div>
                <div style={{ fontSize: 10, color: '#626b7a', marginTop: 6, lineHeight: 1.5 }}>
                  需要三个文件：meta.json、segs.bin、tris.bin，放在同一个目录下。
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── column 3: library ── */}
        <div style={s.col3}>
          <div style={s.sectionKey}>设备 slot {slotCount}/12</div>
          <div style={s.libList}>
            {slotCount === 0 && <div style={s.libEmpty}>（设备上没有表情）</div>}
            {Object.entries(slots).map(([slot, meta]) => (
              <div key={slot} style={s.libItem}>
                <div style={s.libMain}>
                  <button style={s.libLoad} onClick={() => loadFromLibrary(meta.id)}>
                    {meta.name || meta.id}
                  </button>
                  <div style={s.libSub}>slot {slot} · {meta.bytes}B</div>
                </div>
                <button style={s.libDel} title="清空这个 slot"
                        onClick={() => deleteSlot(slot)}>×</button>
              </div>
            ))}
          </div>

          <div style={s.sectionKey}>本地库</div>
          <div style={s.libList}>
            {library.length === 0 && <div style={s.libEmpty}>（空）</div>}
            {library.map((e) => (
              <div key={e.id} style={s.libItem}>
                <div style={s.libMain}>
                  <button style={s.libLoad} onClick={() => loadFromLibrary(e.id)}>{e.id}</button>
                  <div style={s.libSub}>{e.bytes}B</div>
                </div>
              </div>
            ))}
          </div>

          <div style={s.sectionKey}>分享</div>
          <div style={s.ioRow}>
            <button style={s.addBtn} onClick={exportJson}>导出 JSON</button>
            <button style={s.addBtn} onClick={() => {
              setIoText(JSON.stringify(expr, null, 2));
              setIoOpen((v) => !v);
            }}>导入</button>
          </div>
          {ioOpen && (
            <div style={s.ioBox}>
              <textarea style={{ ...s.textarea, width: '100%' }} rows={8}
                        value={ioText} onChange={(e) => setIoText(e.target.value)} />
              <button style={{ ...s.addBtn, marginTop: 4 }} onClick={importJson}>
                应用到画布
              </button>
            </div>
          )}
        </div>
      </div>

      {problems.length > 0 && <div style={s.problems}>{problems.slice(0, 3).join('；')}</div>}

      {/* Upload progress. The daemon emits an expr-progress frame after every
          chunk, so this is the device's own throughput, not an estimate. */}
      {progress && (
        <div style={s.progressRow}>
          <div style={s.progressTrack}>
            <div style={{ ...s.progressFill, width: `${pct}%` }} />
          </div>
          <span style={s.progressText}>
            {pct}% ({progress.sent}/{progress.total} B)
          </span>
        </div>
      )}

      <div style={s.footer}>
        <button style={{ ...s.upload, ...(busy ? s.uploadBusy : null) }}
                disabled={busy} onClick={onUpload}>
          {busy ? (progress ? `上传中 ${pct}%` : '上传中…') : '上传并绑定'}
        </button>
        <button style={{ ...s.addBtn, ...s.smallBtnGhost }}
                disabled={busy} onClick={runTest} title="上传内置测试表情并绑定到 thinking">
          测试上传
        </button>
      </div>
      {msg && <div style={s.msg}>{msg}</div>}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  app: { display: 'flex', flexDirection: 'column', height: '100%', gap: 10 },
  header: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' },
  title: { fontSize: 15, fontWeight: 700, letterSpacing: 0.2 },
  meta: { fontSize: 11, fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--mono)' },
  body: { display: 'flex', gap: 12, flex: 1, minHeight: 0 },
  col1: {
    display: 'flex', flexDirection: 'column', gap: 9, flexShrink: 0, width: 256,
    // Scrolling is not optional here. This column holds the canvas, the built-in
    // gallery, the graphics library and the state chips — well over a screenful
    // in a 256px column — and without overflow the tail is clipped with no way
    // to reach it. That is how the background picker ended up unreachable: it was
    // below the graphics library, off the bottom of the window.
    overflowY: 'auto', paddingRight: 2,
  },
  col2: { display: 'flex', flexDirection: 'column', gap: 9, flex: 1, minWidth: 0, overflowY: 'auto', paddingRight: 2 },
  col3: {
    display: 'flex', flexDirection: 'column', gap: 9, width: 156, flexShrink: 0,
    overflowY: 'auto',
  },
  canvasWrap: {
    padding: 10, background: '#0a0c10', borderRadius: 12,
    border: '1px solid #242a35',
    boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.6), 0 0 28px rgba(218,17,0,0.18)',
    alignSelf: 'center',
  },
  canvas: { display: 'block', width: 236, height: 236, borderRadius: 6 },
  hint: { fontSize: 10, color: '#626b7a', textAlign: 'center' },
  sectionKey: {
    fontSize: 9.5, fontWeight: 700, color: '#626b7a',
    textTransform: 'uppercase', letterSpacing: 0.9, marginTop: 2,
  },
  driftWarn: {
    fontSize: 10, color: '#f0b429', background: 'rgba(240,180,41,0.10)',
    padding: '5px 8px', borderRadius: 6,
  },
  builtinRow: { display: 'flex', gap: 5, flexWrap: 'wrap' },
  // ── graphics library ────────────────────────────────────────
  partGroup: { display: 'flex', flexDirection: 'column', gap: 3 },
  partGroupKey: { fontSize: 9, color: '#55555c', letterSpacing: 0.5 },
  partRow: { display: 'flex', gap: 3, flexWrap: 'wrap' },
  partBtn: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1,
    padding: '5px 7px', borderRadius: 6, cursor: 'pointer',
    background: '#26272c', border: '1px solid #303136', minWidth: 62,
  },
  partName: { fontSize: 10, fontWeight: 600, color: '#d6d6da' },
  partHint: { fontSize: 8, color: '#6a6a72', maxWidth: 90 },
  // ── animation library ───────────────────────────────────────
  animLib: {
    display: 'flex', flexDirection: 'column', gap: 4, padding: 7,
    background: '#1c1d21', borderRadius: 7, border: '1px solid #26272c',
  },
  animLibHead: {
    display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
  },
  animNow: { fontSize: 9, color: '#3b6cf6', fontVariantNumeric: 'tabular-nums' },
  animGroupRow: { display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' },
  animGroupKey: { fontSize: 8, color: '#55555c', width: 22, flexShrink: 0 },
  animBtn: {
    fontSize: 9, padding: '3px 6px', borderRadius: 5, cursor: 'pointer',
    background: '#26272c', color: '#c6c6cc', border: '1px solid transparent',
  },
  animBtnOn: { background: '#3b6cf6', color: '#fff', borderColor: '#3b6cf6' },
  // ── timing (slider + typed seconds) ─────────────────────────
  timingRow: {
    display: 'flex', flexDirection: 'column', gap: 5, padding: '7px 9px',
    background: '#161a21', borderRadius: 7, border: '1px solid #242a35',
  },
  timingHead: {
    display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
  },
  timingVal: {
    fontSize: 11, fontWeight: 600, color: '#e8ebf0',
    fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums',
  },
  timingControls: { display: 'flex', alignItems: 'center', gap: 9 },
  timingRange: {
    flex: 1, height: 4, WebkitAppearance: 'none', appearance: 'none',
    background: '#242a35', borderRadius: 999, outline: 'none',
    cursor: 'pointer',
  },
  timingInput: {
    width: 62, fontSize: 11, padding: '3px 6px', borderRadius: 5,
    background: '#10131a', color: '#e8ebf0', border: '1px solid #242a35',
    fontFamily: 'var(--mono)',
  },
  timingHint: { fontSize: 9, color: '#5b6472' },
  // ── limits and background ───────────────────────────────────
  gauge: { fontSize: 9, fontWeight: 400, marginLeft: 6, letterSpacing: 0 },
  // Framed so the background control reads as one object and does not float
  // among the part buttons, and so it is findable at a glance — it governs the
  // whole face, not the selected layer.
  bgBox: {
    display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 9px',
    background: '#161a21', borderRadius: 8, border: '1px solid #242a35',
    flexShrink: 0,
  },
  bgHead: {
    display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
  },
  bgRow: { display: 'flex', alignItems: 'center', gap: 8 },
  bgHex: {
    fontSize: 9, color: '#6a6a72', fontFamily: 'var(--mono)',
    fontVariantNumeric: 'tabular-nums',
  },
  bgNote: { fontSize: 9, color: '#5b6472', lineHeight: 1.5, flex: 1 },
  thumb: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
    cursor: 'pointer', padding: 4, borderRadius: 7,
    border: '1px solid #242a35', background: '#161a21',
    transition: 'border-color .12s, background .12s',
  },
  thumbLabel: { fontSize: 8, color: '#626b7a', maxWidth: 52, overflow: 'hidden' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 4 },
  chip: {
    fontSize: 10, padding: '3px 8px', borderRadius: 999, cursor: 'pointer',
    background: '#1c212b', color: '#9aa3b0', border: '1px solid #242a35',
    fontFamily: 'var(--mono)', transition: 'all .12s',
  },
  chipOn: {
    background: '#4c8dff', color: '#fff', borderColor: '#4c8dff',
  },
  layerList: { display: 'flex', flexDirection: 'column', gap: 4 },
  layerItem: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px',
    background: '#161a21', borderRadius: 7, cursor: 'pointer',
    border: '1px solid #242a35', transition: 'border-color .12s',
  },
  layerItemOn: { borderColor: '#4c8dff', background: 'rgba(76,141,255,0.08)' },
  layerType: { fontSize: 11, flex: 1, fontFamily: 'var(--mono)', color: '#c8cdd6' },
  // A graphics-library part in the layer list: named, counted, deletable as one.
  layerPart: {
    fontSize: 11, fontWeight: 600, color: '#dfe3ea', flex: 1,
    fontFamily: 'var(--mono)',
  },
  layerCount: {
    fontSize: 9, color: '#5b6472', fontVariantNumeric: 'tabular-nums', flexShrink: 0,
  },
  swatch: {
    width: 14, height: 14, borderRadius: 4,
    border: '1px solid #303747', flexShrink: 0,
  },
  layerDel: {
    background: 'none', border: 'none', color: '#626b7a', cursor: 'pointer', fontSize: 15,
    lineHeight: 1,
  },
  addRow: { display: 'flex', gap: 4, flexWrap: 'wrap' },
  addBtn: {
    fontSize: 10, padding: '4px 8px', borderRadius: 6, cursor: 'pointer',
    background: '#1c212b', color: '#c8cdd6', border: '1px solid #242a35',
    fontFamily: 'var(--mono)', transition: 'all .12s',
  },
  smallBtnGhost: { background: '#161a21', color: '#9aa3b0', border: '1px solid #242a35' },
  inspector: { display: 'flex', flexDirection: 'column', gap: 6 },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  rowKey: { fontSize: 11, color: '#9aa3b0', flexShrink: 0 },
  rowVal: { flex: 1, display: 'flex', justifyContent: 'flex-end' },
  numLabel: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  numKey: { fontSize: 11, color: '#9aa3b0' },
  numInput: { width: 60, fontFamily: 'var(--mono)' },
  textInput: { width: 120 },
  textarea: {
    width: 150, fontSize: 10, fontFamily: 'var(--mono)', resize: 'vertical',
  },
  devBox: {
    border: '1px solid #242a35', borderRadius: 9, overflow: 'hidden', flexShrink: 0,
    background: '#161a21',
  },
  devHead: {
    width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '9px 11px', background: '#1c212b', color: '#c8cdd6', border: 'none',
    borderBottom: '1px solid #242a35',
    fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
  },
  devChevron: { color: '#626b7a' },
  devBody: { display: 'flex', flexDirection: 'column', gap: 9, padding: 11 },
  sliderRow: { display: 'flex', flexDirection: 'column', gap: 2 },
  sliderHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
  sliderVal: { fontSize: 11, fontVariantNumeric: 'tabular-nums', color: '#e8ebf0', fontFamily: 'var(--mono)' },
  slider: { width: '100%' },
  sliderHint: { fontSize: 9, color: '#626b7a' },
  libList: { display: 'flex', flexDirection: 'column', gap: 4 },
  libEmpty: { fontSize: 10, color: '#4a5160', fontStyle: 'italic', padding: '4px 2px' },
  libItem: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
    background: '#161a21', borderRadius: 7, border: '1px solid #242a35',
  },
  libMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 },
  libLoad: {
    background: 'none', border: 'none', color: '#d6dae1', fontSize: 11,
    textAlign: 'left', cursor: 'pointer', padding: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  libSub: { fontSize: 9, color: '#626b7a', fontFamily: 'var(--mono)' },
  libDel: {
    background: 'none', border: 'none', color: '#626b7a', cursor: 'pointer', fontSize: 15,
    lineHeight: 1,
  },
  ioRow: { display: 'flex', gap: 5 },
  ioBox: { display: 'flex', flexDirection: 'column', gap: 5 },
  problems: {
    fontSize: 11, color: '#f0b429', background: 'rgba(240,180,41,0.10)',
    padding: '6px 10px', borderRadius: 7,
  },
  progressRow: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 },
  progressTrack: {
    flex: 1, height: 6, background: '#1c212b', borderRadius: 999, overflow: 'hidden',
  },
  progressFill: {
    height: '100%', background: '#4c8dff', borderRadius: 999,
    transition: 'width 80ms linear',
  },
  progressText: {
    fontSize: 9.5, color: '#626b7a', fontVariantNumeric: 'tabular-nums',
    fontFamily: 'var(--mono)',
  },
  footer: { display: 'flex', gap: 8, alignItems: 'center' },
  upload: {
    flex: 1, padding: '10px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
    background: '#4c8dff', color: '#fff', border: 'none', borderRadius: 8,
    transition: 'filter .15s',
  },
  uploadBusy: { opacity: 0.6, cursor: 'default' },
  msg: { fontSize: 11, color: '#9aa3b0' },
};
