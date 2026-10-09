"""ipc_server.py — the daemon's localhost API.

Four listeners' worth of job, in two transports:

  * UDP on the port, for the Claude Code hook shim. The shim must never block,
    and a TCP connect to a port with nothing behind it does not fail fast on
    every machine: filtering rules in VPN clients and security suites silently
    drop loopback SYNs, which cost this machine 266 ms per tool call before the
    switch. A UDP datagram has no handshake, so it cannot block.
  * HTTP on the same port, for the Electron UI and the CLI.

The HTTP half is also the only way anything reaches the BLE link: the daemon
owns the single central connection, so a second client — the CLI, the UI, a
curl — must go through it. A client that opened its own connection would steal
the link and both would drop at once.

Everything binds to 127.0.0.1 only. A daemon listening on 0.0.0.0 would let any
machine on the network drive the user's HUD.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse

from . import protocol as P
from .ble_link import BleLink
from .boot import TARGETS, play as play_boot, upload_all
from .config import Settings
from .device import DeviceConfig
from .expressions import SLOT_COUNT, ExpressionLibrary, config as send_device_config
from .expressions import select as select_expression
from .expressions import upload as upload_expression
from .logbus import log
from .state_map import StateMapper

# How many accepted hook events may wait for the worker before new ones are
# dropped. A backlog of stale state changes is worse than a missed one: the next
# event re-syncs the panel, but a burst of old ones replays history.
HOOK_QUEUE_MAX = 32

# Which field of an accepted hook payload names the Claude Code event.
#
# Two producers, two spellings. The UDP path carries the shim's reduced form,
# where the event is in "ev" (see hookshim/cchud_hook.py), and the HTTP path
# carries whatever Claude Code put on stdin, where it is "hook_event_name".
#
# This list was missing entirely for a while, and the failure was worse than a
# missing face: _drain_queue() evaluated the undefined name on its very first
# event, the worker task died with NameError, asyncio logged it once and never
# restarted it — and the queue silently stopped being drained. The panel kept
# looking perfectly healthy, because /status is answered by the heartbeat task
# and knows nothing about the queue. Every hook event after the first was
# counted in udp_packets and nowhere else.
EVENT_FIELDS = ("ev", "hook_event_name", "event")

# What the boot upload writes, and in what order. Exposed over GET /boot so the
# UI can say what it is about to send before it sends it.
BOOT_TARGETS_JSON = [
    {"target": target, "name": name} for target, name in TARGETS
]


class _UdpProtocol(asyncio.DatagramProtocol):
    """Receives hook datagrams and hands them to the queue."""

    def __init__(self, server: "IpcServer") -> None:
        self._server = server

    def datagram_received(self, data: bytes, addr) -> None:  # type: ignore[override]
        self._server._on_datagram(data, addr)

    def error_received(self, exc: Exception) -> None:
        # A transient ICMP error (port unreachable on a previous send, say) is
        # not worth tearing the listener down over.
        log.debug("udp error: %s", exc)


class IpcServer:
    def __init__(self, *, link: BleLink, settings: Settings, mapper: StateMapper) -> None:
        self.link = link
        self.settings = settings
        self.mapper = mapper
        self.expressions = ExpressionLibrary()
        self.app = self._build_app()
        self._queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=HOOK_QUEUE_MAX)
        self._ws_clients: set[WebSocket] = set()
        self._worker: asyncio.Task | None = None
        self._udp: asyncio.BaseTransport | None = None
        self._events_seen = 0
        self._udp_packets = 0
        self._dropped = 0
        # state name -> slot, for bindings this daemon made. Not persisted: a
        # restart forgets them, which is safe because an unrecorded state is
        # left bound rather than being swept up by someone else's delete.
        self._state_bindings: dict[str, int] = {}
        # Host mirror of the panel's display settings. The device holds the
        # authoritative copy in NVS; this exists so the UI has something to
        # render and so the values can be pushed back after a reflash.
        self.device_cfg = DeviceConfig.load()
        # Strong references to broadcasts scheduled from synchronous callbacks.
        self._bg_tasks: set[asyncio.Task] = set()

    # ── HTTP app ───────────────────────────────────────────────
    def _build_app(self) -> FastAPI:
        app = FastAPI(title="Claude HUD daemon", docs_url=None, redoc_url=None)

        @app.get("/status")
        async def status() -> JSONResponse:
            return JSONResponse({"ok": True, **self._status_dict()})

        # ── hooks ────────────────────────────────────────────────────────────
        # The injector lives in the daemon (see __main__.py), and the panel used
        # to reach it by spawning a *second* Python process to run
        # `python -m hud_daemon.settings_watch --once`. That cannot work once
        # packaged: the recipient has no Python. Exposing it here keeps one
        # injector, one process, one truth — and makes "修复 hook" work in the
        # packaged app.
        @app.get("/hooks")
        async def hooks_status() -> JSONResponse:
            watcher = getattr(self, "watcher", None)
            if watcher is None:
                return JSONResponse({"ok": True, "enabled": False,
                                     "reason": "hook injection is disabled "
                                               "on this daemon"})
            return JSONResponse({"ok": True, "enabled": True,
                                 **watcher.status_dict()})

        @app.post("/hooks/repair")
        async def hooks_repair() -> JSONResponse:
            """Re-inject our hooks into settings.json, right now.

            Safe to call any number of times: the merge is idempotent and
            preserves everything else in the file.
            """
            watcher = getattr(self, "watcher", None)
            if watcher is None:
                return JSONResponse({"ok": False,
                                     "error": "hook injection is disabled "
                                              "on this daemon"},
                                    status_code=503)
            result = watcher.repair()
            if result.error:
                return JSONResponse({"ok": False, "error": result.error},
                                    status_code=500)
            await self._broadcast({"type": "hook-status",
                                   "repaired": True, "changed": result.changed})
            return JSONResponse({"ok": True, "changed": result.changed,
                                 "backup": str(result.backup) if result.backup
                                 else None})

        @app.post("/hook")
        async def hook(request: Request) -> JSONResponse:
            # Read the body ourselves rather than declaring a pydantic model:
            # the payload shape belongs to Claude Code, and an unknown field
            # must not blow up the endpoint.
            try:
                body = await request.json()
            except Exception:
                return JSONResponse({"ok": False, "error": "bad json"}, status_code=400)
            if not isinstance(body, dict):
                return JSONResponse({"ok": False, "error": "not an object"},
                                    status_code=400)
            self._enqueue(body)
            return JSONResponse({"ok": True})

        @app.get("/device")
        async def device_get() -> JSONResponse:
            return JSONResponse({"ok": True, "config": self.device_cfg.to_dict(),
                                 "ranges": {
                                     "brightness": [0, 255], "speed": [1, 3],
                                     "rotation": [0, 3], "idle_s": [5, 300]}})

        # ── boot animation ──────────────────────────────────────
        # The panel streams its logo from LittleFS rather than holding 162
        # primitives it does not have room for, so "change the boot animation"
        # means "upload three files". They go through the daemon because it owns
        # the single central BLE connection: a second client would steal the link
        # and both would drop.
        @app.get("/boot")
        async def boot_status() -> JSONResponse:
            return JSONResponse({"ok": True, "targets": BOOT_TARGETS_JSON})

        @app.post("/boot/upload")
        async def boot_upload(request: Request) -> JSONResponse:
            """Upload meta.json, segs.bin and tris.bin from a directory.

            The directory is read server-side, on the machine the daemon runs on,
            because these are binary files and the daemon is the only process that
            can reach the panel. The client sends a path, not 3 KB of binary.
            """
            try:
                body = await request.json()
            except Exception:
                return JSONResponse({"ok": False, "error": "bad json"}, status_code=400)
            directory = body.get("dir") if isinstance(body, dict) else None
            if not isinstance(directory, str) or not directory:
                return JSONResponse({"ok": False, "error": "need a 'dir'"},
                                    status_code=400)
            path = Path(directory)
            if not path.is_dir():
                return JSONResponse({"ok": False, "error": f"not a directory: {path}"},
                                    status_code=400)

            async def progress(sent: int, total: int) -> None:
                await self._broadcast({"type": "boot-progress",
                                       "sent": sent, "total": total})

            result = await upload_all(self.link, path, on_progress=progress)
            if not result.ok:
                await self._broadcast({"type": "boot-failed", "error": result.error})
                return JSONResponse({"ok": False, "error": result.error,
                                     "files": [f.__dict__ for f in result.files]},
                                    status_code=502)
            await self._broadcast({"type": "boot-uploaded",
                                   "bytes": result.bytes_sent,
                                   "files": [f.name for f in result.files]})
            return JSONResponse({"ok": True, "bytes": result.bytes_sent,
                                 "files": [{"name": f.name, "bytes": f.bytes_sent}
                                           for f in result.files]})

        @app.post("/boot/play")
        async def boot_play() -> JSONResponse:
            """Replay the animation without rebooting the panel."""
            ok = await play_boot(self.link)
            if not ok:
                return JSONResponse({"ok": False, "error": "device not connected"},
                                    status_code=502)
            await self._broadcast({"type": "boot-playing"})
            return JSONResponse({"ok": True})

        @app.post("/device/config")
        async def device_set(request: Request) -> JSONResponse:
            """Update one or more display settings and push them to the device.

            Partial updates are accepted: the UI sends only the field the user
            actually moved, so a slider drag does not need to read-modify-write.
            """
            try:
                body = await request.json()
            except Exception:
                return JSONResponse({"ok": False, "error": "bad json"}, status_code=400)
            if not isinstance(body, dict):
                return JSONResponse({"ok": False, "error": "not an object"},
                                    status_code=400)

            for name in ("brightness", "speed", "rotation", "idle_s"):
                value = body.get(name)
                if isinstance(value, int) and not isinstance(value, bool):
                    setattr(self.device_cfg, name, value)

            problems = self.device_cfg.validate()
            if problems:
                return JSONResponse({"ok": False, "error": "; ".join(problems)},
                                    status_code=400)

            self.device_cfg.save()
            pushed = await send_device_config(
                self.link, self.device_cfg.brightness, self.device_cfg.speed,
                self.device_cfg.rotation, self.device_cfg.idle_s)

            await self._broadcast({"type": "device-config",
                                   **self.device_cfg.to_dict()})
            # A device that is offline will still have the values in NVS from
            # the last successful push, so a failed send is a warning rather
            # than an error — but the UI should know the panel may be stale.
            return JSONResponse({"ok": True, "pushed": pushed,
                                 "config": self.device_cfg.to_dict()})

        # ── expressions ─────────────────────────────────────────
        @app.get("/expressions/item/{expr_id}")
        async def expressions_item(expr_id: str) -> JSONResponse:
            """The stored JSON for one library entry, so the editor can load it
            back onto the canvas and keep editing instead of starting over."""
            blob = self.expressions.get(expr_id)
            if blob is None:
                return JSONResponse({"ok": False, "error": f"no entry '{expr_id}'"},
                                    status_code=404)
            try:
                parsed = json.loads(blob.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return JSONResponse({"ok": False, "error": "stored entry is not valid JSON"},
                                    status_code=500)
            return JSONResponse({"ok": True, "id": expr_id,
                                 "bytes": len(blob), "expression": parsed})

        @app.get("/expressions")
        async def expressions() -> JSONResponse:
            return JSONResponse({"ok": True, **self._expr_status()})

        @app.post("/expressions/upload")
        async def expressions_upload(request: Request) -> JSONResponse:
            try:
                body = await request.json()
            except Exception:
                return JSONResponse({"ok": False, "error": "bad json"}, status_code=400)
            if not isinstance(body, dict):
                return JSONResponse({"ok": False, "error": "not an object"},
                                    status_code=400)

            # Two ways to supply the blob. Inline JSON is what the editor uses;
            # a library id is what a shared pack uses, so neither has to ship
            # the whole file through the wire when it is already on disk.
            blob: bytes | None = None
            expr_id = body.get("id")
            if isinstance(body.get("expression"), (dict, list)):
                blob = json.dumps(body["expression"],
                                  separators=(",", ":")).encode("utf-8")
            elif isinstance(expr_id, str) and expr_id:
                blob = self.expressions.get(expr_id)
                if blob is None:
                    return JSONResponse(
                        {"ok": False, "error": f"no library entry '{expr_id}'"},
                        status_code=404)

            if blob is None:
                return JSONResponse(
                    {"ok": False, "error": "need an 'expression' object or a library 'id'"},
                    status_code=400)

            # Reuse the slot this expression already owns. Claiming a fresh one
            # per upload burns through all twelve slots and leaves the earlier
            # ones pointing at a stale copy — which is exactly what happened
            # when this reuse existed only on the /expressions/test endpoint
            # and not here, where the editor actually uploads.
            slot = body.get("slot")
            if not isinstance(slot, int):
                slot = self.expressions.slot_of(str(expr_id)) if expr_id else None
            if slot is None:
                slot = self.expressions.claim_free_slot()
                if slot is None:
                    return JSONResponse({"ok": False, "error": "all slots in use"},
                                        status_code=409)

            name = body.get("name")
            if not isinstance(name, str) or not name:
                name = str(expr_id) if expr_id else f"slot{slot}"

            async def progress(sent: int, total: int) -> None:
                await self._broadcast({"type": "expr-progress", "slot": slot,
                                       "sent": sent, "total": total})

            result = await upload_expression(self.link, slot, blob, on_progress=progress)
            if not result.ok:
                await self._broadcast({"type": "expr-failed", "slot": slot,
                                       "error": result.error})
                return JSONResponse({"ok": False, "error": result.error,
                                     "ack_code": result.ack_code, "slot": slot},
                                    status_code=502)

            # Record it in the library and the manifest so the UI can list it
            # without a round trip per slot.
            if isinstance(expr_id, str) and expr_id:
                self.expressions.put(expr_id, name, blob)
            self.expressions.assign(slot, str(expr_id) if expr_id else f"slot{slot}",
                                    name, result.bytes_sent)

            # Binding the slot in the same request is what an "apply to
            # thinking" button wants, and saves a round trip the UI would make
            # while the user is watching the panel for the change. Each binding
            # is confirmed by the device, and the response reports only the ones
            # that actually took — the previous version listed every requested
            # state, so "已上传 → thinking" was printed even when the device had
            # refused.
            bound: list[dict[str, Any]] = []
            rejected: list[str] = []
            states = body.get("states")
            if isinstance(states, list):
                for state_name in states:
                    if not isinstance(state_name, str):
                        continue
                    state = P.STATE_NAMES_INV.get(state_name)
                    if state is None:
                        continue
                    if await select_expression(self.link, state, slot):
                        self._record_binding(state_name, slot)
                        bound.append({"state": state_name, "slot": slot})
                    else:
                        rejected.append(state_name)

            await self._broadcast({"type": "expr-uploaded", "slot": slot,
                                   "name": name, "bytes": result.bytes_sent,
                                   "bound": bound, "rejected": rejected})
            return JSONResponse({"ok": True, "slot": slot, "name": name,
                                 "bytes": result.bytes_sent, "bound": bound,
                                 "rejected": rejected})

        @app.post("/expressions/select")
        async def expressions_select(request: Request) -> JSONResponse:
            try:
                body = await request.json()
            except Exception:
                return JSONResponse({"ok": False, "error": "bad json"}, status_code=400)
            state_name = body.get("state")
            slot = body.get("slot")
            if not isinstance(state_name, str) or not isinstance(slot, int):
                return JSONResponse({"ok": False, "error": "need 'state' and 'slot'"},
                                    status_code=400)
            state = P.STATE_NAMES_INV.get(state_name)
            if state is None:
                return JSONResponse({"ok": False, "error": f"unknown state '{state_name}'"},
                                    status_code=400)
            # The device confirms the binding now, so a rejection is reported as
            # what it is rather than being guessed at. "device not connected"
            # used to be the only message available, which was wrong about half
            # the time: the common cause was a bad index or an unparseable slot.
            bound = await select_expression(self.link, state, slot)
            if not bound:
                reason = ("device not connected" if not self.link.connected
                          else "device rejected the binding")
                return JSONResponse({"ok": False, "error": reason}, status_code=502)
            self._record_binding(state_name, slot)
            await self._broadcast({"type": "expr-selected", "state": state_name,
                                   "slot": slot})
            return JSONResponse({"ok": True})

        @app.delete("/expressions/{slot}")
        async def expressions_delete(slot: int) -> JSONResponse:
            if slot < 0 or slot >= SLOT_COUNT:
                return JSONResponse({"ok": False, "error": "slot out of range"},
                                    status_code=400)
            # Unbind only the states this daemon recorded as pointing at THIS
            # slot. It used to unbind all seven, which silently destroyed every
            # other binding: deleting a duplicate slot wiped the state that
            # pointed at the copy being kept, and the face quietly reverted to a
            # built-in one with nothing saying so.
            #
            # States with no record here are left alone. The device keeps their
            # binding, and a binding to a now-empty slot degrades to the built-in
            # face — visible and correct — rather than to nothing.
            unbound: list[str] = []
            rejected: list[str] = []
            for state_name in [s for s, sl in list(self._state_bindings.items())
                               if sl == slot]:
                state = P.STATE_NAMES_INV.get(state_name)
                if state is None:
                    continue
                # 0xFF unbinds, and the device now confirms it. A state that
                # fails to unbind is reported rather than quietly dropped: the
                # old behaviour left the UI claiming success for a device that
                # had never changed, which is the whole complaint this rewrite
                # exists to fix.
                if await select_expression(self.link, state, 0xFF):
                    self._state_bindings.pop(state_name, None)
                    unbound.append(state_name)
                else:
                    rejected.append(state_name)

            self.expressions.forget_slot(slot)
            await self._broadcast({"type": "expr-deleted", "slot": slot,
                                   "unbound": unbound, "failed": rejected})
            return JSONResponse({"ok": True, "slot": slot,
                                 "unbound": unbound, "failed": rejected})

        @app.get("/expressions/test")
        async def expressions_test() -> JSONResponse:
            """Upload the built-in test face and bind it to thinking.

            The fastest way to prove the whole upload path works, and the only
            thing the user has to run to find out whether the firmware's chunk
            handling is correct.
            """
            from .expressions import TEST_EXPRESSION

            blob = json.dumps(TEST_EXPRESSION, separators=(",", ":")).encode("utf-8")
            # Reuse the slot the test already owns. Claiming a fresh one each
            # run burns through all twelve slots and leaves the earlier ones
            # pointing at a stale expression.
            slot = self.expressions.slot_of("test")
            if slot is None:
                slot = self.expressions.claim_free_slot()
                if slot is None:
                    return JSONResponse({"ok": False, "error": "all slots in use"},
                                        status_code=409)

            async def progress(sent: int, total: int) -> None:
                await self._broadcast({"type": "expr-progress", "slot": slot,
                                       "sent": sent, "total": total})

            result = await upload_expression(self.link, slot, blob, on_progress=progress)
            if not result.ok:
                return JSONResponse({"ok": False, "slot": slot,
                                     "error": result.error, "ack_code": result.ack_code},
                                    status_code=502)

            self.expressions.assign(slot, "test", "Upload Test", result.bytes_sent)
            await select_expression(self.link, P.ST_THINKING, slot)
            await self._broadcast({"type": "expr-uploaded", "slot": slot,
                                   "name": "Upload Test",
                                   "bytes": result.bytes_sent})
            return JSONResponse({"ok": True, "slot": slot, "bytes": result.bytes_sent,
                                 "bound_to": "thinking"})

        @app.websocket("/ws")
        async def ws(websocket: WebSocket) -> None:
            await websocket.accept()
            self._ws_clients.add(websocket)
            try:
                # One status frame on connect so a just-opened UI does not have
                # to guess the current state.
                await websocket.send_json({"type": "status", **self._status_dict()})
                while True:
                    # The daemon pushes; the UI does not ask. Drain whatever the
                    # client sends so the socket stays healthy.
                    await websocket.receive_text()
            except Exception:
                pass
            finally:
                self._ws_clients.discard(websocket)

        return app

    # ── lifecycle ──────────────────────────────────────────────
    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        self._udp, _ = await loop.create_datagram_endpoint(
            lambda: _UdpProtocol(self), local_addr=("127.0.0.1", self.settings.port)
        )
        self._worker = asyncio.create_task(self._drain_queue(), name="hook-worker")
        log.info("ipc listening: udp 127.0.0.1:%d (hooks), http :%d (ui)",
                 self.settings.port, self.settings.port)

    async def stop(self) -> None:
        if self._worker is not None:
            self._worker.cancel()
            try:
                await self._worker
            except asyncio.CancelledError:
                pass
        if self._udp is not None:
            self._udp.close()
        for ws in list(self._ws_clients):
            try:
                await ws.close()
            except Exception:
                pass
        self._ws_clients.clear()

    # ── hook intake ────────────────────────────────────────────
    def _on_datagram(self, data: bytes, addr) -> None:
        self._udp_packets += 1
        if len(data) > 64 * 1024:
            self._dropped += 1
            log.warning("udp datagram too large (%d bytes) from %s", len(data), addr)
            return
        try:
            body = json.loads(data.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._dropped += 1
            log.debug("udp datagram not json from %s", addr)
            return
        if not isinstance(body, dict):
            self._dropped += 1
            return
        self._enqueue(body)

    def _enqueue(self, body: dict[str, Any]) -> None:
        try:
            self._queue.put_nowait(body)
        except asyncio.QueueFull:
            self._dropped += 1
            log.warning("hook queue full, dropping event")

    # ── internals ──────────────────────────────────────────────
    def _status_dict(self) -> dict[str, Any]:
        return {
            "link": self.link.status(),
            "state": P.STATE_NAMES.get(self.mapper.last_state, "unknown")
                     if self.mapper.last_state is not None else "none",
            "events_seen": self._events_seen,
            "udp_packets": self._udp_packets,
            "dropped": self._dropped,
            "queue_depth": self._queue.qsize(),
        }

    def _expr_status(self) -> dict[str, Any]:
        return {
            "slot_count": SLOT_COUNT,
            "slots": {str(k): v for k, v in sorted(self.expressions.slots.items())},
            "bindings": dict(self._state_bindings),
            "library": self.expressions.list(),
            "mtu": self.link.mtu,
            "chunk_budget": P.chunk_payload_budget(self.link.mtu),
        }

    def _record_binding(self, state_name: str, slot: int) -> None:
        """Remember which slot a state points at, so a delete can be surgical.

        Without this the delete endpoint had no way to know which bindings
        belonged to the slot being removed, and fell back to unbinding all seven
        — destroying bindings to slots nobody was touching. A restart forgets
        these, which is the safe direction: an unrecorded state is left bound
        rather than swept up by someone else's delete.
        """
        self._state_bindings[state_name] = slot

    async def _drain_queue(self) -> None:
        """Turn accepted hook payloads into device frames, one at a time."""
        while True:
            body = await self._queue.get()
            self._events_seen += 1

            event = next((body[f] for f in EVENT_FIELDS if isinstance(body.get(f), str)), None)
            if event is None:
                self._dropped += 1
                log.debug("hook payload without an event name: %r", list(body)[:6])
                continue

            decision = self.mapper.on_hook_event(event)
            if not decision.send:
                log.debug("hook %-18s -> %s", event, decision.reason)
                continue

            await self.link.send_frame(P.MSG_STATE, bytes((decision.state,)))
            log.info("hook %-18s -> %s (%s)", event,
                     P.STATE_NAMES.get(decision.state, decision.state), decision.reason)
            await self._broadcast({"type": "state", "state": decision.state,
                                   "reason": decision.reason, "event": event})

            # A transient TOOL_END needs its fallback delivered too.
            if decision.state == P.ST_TOOL_END:
                asyncio.create_task(self._schedule_revert())

    async def _schedule_revert(self) -> None:
        """Deliver the TOOL_END fallback once its hold expires."""
        await asyncio.sleep(self.settings.tool_end_hold_ms / 1000.0)
        decision = self.mapper.poll()
        if not decision.send:
            return
        await self.link.send_frame(P.MSG_STATE, bytes((decision.state,)))
        log.info("revert -> %s", P.STATE_NAMES.get(decision.state, decision.state))
        await self._broadcast({"type": "state", "state": decision.state,
                               "reason": decision.reason, "event": "revert"})

    async def _broadcast(self, payload: dict[str, Any]) -> None:
        if not self._ws_clients:
            return
        dead: list[WebSocket] = []
        for ws in self._ws_clients:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._ws_clients.discard(ws)

    def _spawn(self, coro) -> None:
        """Schedule a broadcast from a synchronous callback.

        Device frames arrive on the event loop but inside a plain function, so
        there is nowhere to await. asyncio.create_task() would also work, except
        that the only reference asyncio keeps to a running task is weak, and a
        task nobody holds can be collected before it gets to run — which loses
        exactly the STATUS frame this exists to deliver. Holding it until it
        finishes costs one set.
        """
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No loop yet. A notify that arrives before the loop started is
            # dropped, same as ble_link's own early-notification path.
            coro.close()
            return
        task = loop.create_task(coro)
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)

    # ── device frames -> UI ───────────────────────────────────────────────
    def handle_device_frame(self, frame: P.Frame) -> None:
        """Log what the device said, then send the UI what it needs to know.

        Everything here used to be a log.info() and nothing else. That left the
        UI reading the daemon's *intent* — what the host decided to send —
        rather than the device's state, and since a successful MSG_STATE draws no
        ACK there was nothing anywhere to prove a face actually changed. STATUS
        is that proof: it is the device's own report of what is on screen, every
        five seconds whether or not anything happened.
        """
        if frame.type == P.MSG_STATUS:
            st = P.parse_status(frame.payload)
            if st is not None:
                log.info("STATUS state=%s ble=%d err=%d",
                         P.STATE_NAMES.get(st.state, st.state),
                         st.ble_connected, st.last_err)
                self._spawn(self._broadcast({
                    "type": "device-status",
                    "state": st.state,
                    "state_name": P.STATE_NAMES.get(st.state, "unknown"),
                    "ble": st.ble_connected,
                    "err": st.last_err,
                }))
            return

        if frame.type == P.MSG_PONG:
            pong = P.parse_pong(frame.payload)
            if pong is not None:
                log.info("PONG fw=%d.%d slots=%d used=%d",
                         pong.fw_major, pong.fw_minor, pong.slot_count, pong.used_slots)
                # The firmware version is the only place it exists, and a UI that
                # cannot see it cannot tell "your panel is on an old build" from
                # "your panel is broken".
                self._spawn(self._broadcast({
                    "type": "device-info",
                    "fw": f"{pong.fw_major}.{pong.fw_minor}",
                    "slot_count": pong.slot_count,
                    "used_slots": pong.used_slots,
                }))
            return

        if frame.type == P.MSG_ACK:
            ack = P.parse_ack(frame.payload)
            if ack is not None:
                names = {P.ACK_OK: "ok", P.ACK_CRC: "crc",
                         P.ACK_NOSPACE: "nospace", P.ACK_BADREQ: "badreq"}
                log.info("ACK type=0x%02x seq=%d -> %s",
                         ack.acked_type, ack.acked_seq,
                         names.get(ack.code, ack.code))
                # Failures only. An ACK_OK is the absence of news, and whatever
                # was waiting for it already has it.
                if ack.code != P.ACK_OK:
                    self._spawn(self._broadcast({
                        "type": "device-ack-error",
                        "acked_type": ack.acked_type,
                        "ack_code": ack.code,
                        "ack_name": names.get(ack.code, str(ack.code)),
                    }))
            return

        if frame.type == P.MSG_LOG:
            line = P.parse_log(frame.payload)
            if line is not None:
                log.info("device: %s", line.text)
                # The device reports its own failures over MSG_LOG — a slot that
                # would not parse, a renderer that never painted, a store that
                # failed to mount. Those are the only evidence a user has that
                # the thing on their desk is unhappy.
                if any(tag in line.text for tag in
                       ("fail", "stalled", "no-store", "rejected", "out of")):
                    self._spawn(self._broadcast(
                        {"type": "device-log", "text": line.text}))
            return

        log.info("frame type=0x%02x seq=%d len=%d",
                 frame.type, frame.seq, len(frame.payload))

    def relay_link_state(self, state: str) -> None:
        """Push a link change the moment it happens.

        Waiting for the next status broadcast means the panel sits on
        "connected" for up to a heartbeat interval after the device is gone.
        """
        self._spawn(self._broadcast({"type": "link", "state": state}))

    def bind_device_handlers(self, link: BleLink) -> None:
        """Take over the link's frame and state callbacks.

        Called from __main__ right after this server is constructed. Until now
        the daemon logged device frames in __main__.handle_frame() and nothing
        else: the panel's own view of itself — STATUS, PONG, ACK failures,
        MSG_LOG diagnostics — died in the log file. Routing them here is what
        lets the UI show what the device actually reports instead of what the
        host decided to send.

        One caller at a time by construction: the daemon owns the single
        central connection, so there is nothing else to race with.
        """
        link.attach_handlers(self.handle_device_frame, self.relay_link_state)
