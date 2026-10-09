// daemonEvents.ts — the frames the daemon pushes on ws://127.0.0.1:17321/ws.
//
// Everything here has existed on the daemon side from the start:
// ipc_server._broadcast() has been emitting state changes, upload progress,
// delete results, and the device's own STATUS frames the whole time. What was
// missing was anyone on this end subscribing, which is why the panel could only
// show a 2-second-stale status — and why TOOL_END, which holds for exactly
// 1 second, could never be seen at all.
//
// Keep in step with daemon/hud_daemon/ipc_server.py. Anything added there should
// show up here in the same change, or the UI silently loses that signal.

export type DaemonEventType =
  | 'status'
  | 'state'
  | 'link'
  | 'device-status'
  | 'device-info'
  | 'device-ack-error'
  | 'device-log'
  | 'device-config'
  | 'expr-progress'
  | 'expr-uploaded'
  | 'expr-failed'
  | 'expr-selected'
  | 'expr-deleted'
  | 'hook-status'
  | 'boot-progress'
  | 'boot-failed'
  | 'boot-uploaded'
  | 'boot-playing';

export interface DaemonEvent {
  type: DaemonEventType;

  // status / state — note the two are different kinds: the HTTP /status frame
  // already carries the state *name*, while the pushed 'state' frame carries
  // the protocol's numeric Hudsonium and has to be mapped here.
  state?: number | string;
  state_name?: string;
  reason?: string;
  event?: string;

  // link
  // (link's value is the state string itself)

  // device-status: what the panel last reported about itself.
  ble?: boolean;
  err?: number;

  // device-info: firmware version and slot occupancy, from PONG.
  fw?: string;
  slot_count?: number;
  used_slots?: number;

  // device-ack-error
  acked_type?: number;
  ack_code?: number;
  ack_name?: string;

  // device-log
  text?: string;

  // expr-*
  slot?: number;
  sent?: number;
  total?: number;
  bytes?: number;
  name?: string;
  bound?: Array<{ state: string; slot: number }>;
  unbound?: string[];
  // States the device refused to bind or unbind. Reported rather than assumed,
  // because the daemon now waits for the device's ACK and knows the difference.
  failed?: string[];
  rejected?: string[];
  error?: string;
  // device-config
  pushed?: boolean;
  brightness?: number;
  speed?: number;
  rotation?: number;
  idle_s?: number;

  // hook-status
  repaired?: boolean;
  changed?: boolean;

  // boot-*
  files?: string[] | Array<{ name: string; bytes: number }>;
  error?: string;
}

