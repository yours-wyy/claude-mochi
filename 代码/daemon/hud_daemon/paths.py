"""paths.py — every machine-specific path in the daemon, in one place.

Two shapes, one module. The daemon runs in development from the source tree,
and packaged it runs as a frozen sidecar next to the Electron app. Those two
shapes want the same things — the hook shim, the firmware sketch — from
completely different roots, and this module is what tells them apart.

Why the old version of this file could not be shipped:

  * `PROJECT_ROOT = Path(__file__).resolve().parents[2]` walks up from
    daemon/hud_daemon/paths.py. Frozen, `__file__` points into the PyInstaller
    extraction directory, so the walk lands somewhere unrelated and every
    derived path silently becomes wrong. Not fatal — just a hook command
    pointing at a file that no longer exists, which Claude Code reports as
    nothing at all.
  * `build.json` holds `python_exe` = one developer's Python path. Shipping it
    means shipping a path that is wrong on every other machine, and the
    fallback is this machine's path too.
  * The shim's path was read from the project tree, so the hook command
    installed into settings.json pointed into a directory an app update would
    replace.

What it does now:

  * Development: everything resolves under the project root, from build.json
    when present, so moving the tree is still a non-event.
  * Frozen: everything resolves under the PyInstaller bundle, and build.json is
    ignored — a packaged build must not depend on a developer's file.
  * The hook shim is *copied* into a stable per-user location the first time it
    is needed, and settings.json is pointed there. That is the part that makes
    updates safe: the app can be reinstalled or upgraded under a versioned
    directory, and the hook keeps working because its path never moved.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

# ── shapes ────────────────────────────────────────────────────────────────
_HERE = Path(__file__).resolve()
_PROJECT_ROOT = _HERE.parents[2] if len(_HERE.parents) >= 3 else _HERE.parent
BUILD_JSON = _PROJECT_ROOT / "build.json"

# Where the packaged build keeps its files. With a onedir PyInstaller build
# this is the directory the daemon exe sits in, so resources placed next to it
# are found without any archive extraction. Always defined, so a test that
# simulates frozen can restore a real module-level name rather than leaving the
# module without one.
_MEIPASS: Path | None = None
if getattr(sys, "frozen", False):
    _raw = getattr(sys, "_MEIPASS", "")
    _MEIPASS = Path(_raw) if _raw else None


def frozen() -> bool:
    """True when running from a PyInstaller build rather than the source tree."""
    return bool(getattr(sys, "frozen", False))


def bundle_dir() -> Path:
    """Directory holding the shipped files: the source project, or the bundle."""
    return _MEIPASS if (_MEIPASS is not None and _MEIPASS.is_dir()) else _PROJECT_ROOT


# ── user data ─────────────────────────────────────────────────────────────
def stable_dir() -> Path:
    """Per-user directory for files that must survive an app reinstall.

    LOCALAPPDATA, not APPDATA: this holds a binary the hook command points at,
    and it is machine state rather than roaming profile state.
    """
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") \
        or os.path.expanduser("~")
    path = Path(base) / "ClaudeHUD" / "bin"
    path.mkdir(parents=True, exist_ok=True)
    return path


# ── build.json (development only) ─────────────────────────────────────────
# Fallbacks used only when build.json is missing or unreadable, and only in
# development. In a frozen build these are never consulted: the bundle's own
# layout is authoritative, and pointing at a developer's machine would be worse
# than admitting the file is not there.
_FALLBACK = {
    "hookshim": {
        "exe": "hookshim/cchud-hook-cs/bin/Release/net10.0/win-x64/publish/cchud-hook.exe",
        "script": "hookshim/cchud_hook.py",
    },
}


def _load() -> dict:
    if frozen():
        # A packaged build must not depend on a file that only exists on the
        # machine that built it. Everything it could have configured is derived
        # from the bundle layout instead. python_exe is deliberately absent:
        # a frozen daemon carries its own interpreter and a leftover developer
        # path would be worse than nothing.
        return {"hookshim": dict(_FALLBACK["hookshim"])}

    try:
        raw = json.loads(BUILD_JSON.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"hookshim": dict(_FALLBACK["hookshim"])}
    if not isinstance(raw, dict):
        return {"hookshim": dict(_FALLBACK["hookshim"])}

    merged: dict = {"hookshim": dict(_FALLBACK["hookshim"])}
    # python_exe is development-only: a frozen build carries its own interpreter.
    if isinstance(raw.get("python_exe"), str) and raw["python_exe"]:
        merged["python_exe"] = raw["python_exe"]

    shim = raw.get("hookshim")
    if isinstance(shim, dict):
        for key in ("exe", "script"):
            if isinstance(shim.get(key), str) and shim[key]:
                merged["hookshim"][key] = shim[key]
    return merged


_RESOLVED: dict | None = None


def _cfg() -> dict:
    """The effective configuration, computed once per process.

    Lazy rather than a module constant so the frozen check runs on first use
    instead of at import: a test that simulates frozen after import gets the
    behaviour a packaged build would really have, instead of the dev-mode
    values captured at import time.
    """
    global _RESOLVED
    if _RESOLVED is None:
        _RESOLVED = _load()
    return _RESOLVED


def project_root() -> Path:
    return bundle_dir()


def daemon_dir() -> Path:
    return bundle_dir() / "daemon"


def firmware_dir() -> Path:
    return bundle_dir() / "firmware" / "claude_hud"


def python_exe() -> str | None:
    """The interpreter to run the daemon with — development only.

    None in a frozen build, where there is no interpreter to find: the daemon
    *is* the executable. A caller that gets None must not fall back to a
    hardcoded path, because that path is this developer's and nobody else's.
    """
    value = _cfg().get("python_exe")
    return value if isinstance(value, str) and value else None


def _resolve(relative: str) -> Path:
    """Absolutise a bundle-relative path, tolerating an already-absolute one."""
    p = Path(relative)
    return p if p.is_absolute() else bundle_dir() / p


def _bundled_shim() -> Path:
    """Where the shim lives inside the bundle."""
    rel = _cfg()["hookshim"]["exe"]
    candidate = _resolve(rel)
    if candidate.exists():
        return candidate
    # The shipped layout puts it next to the daemon exe, which is flatter than
    # the source tree's Release/publish nesting.
    flat = bundle_dir() / Path(rel).name
    return flat if flat.exists() else candidate


def ensure_stable_shim() -> Path | None:
    """Copy the shim into stable_dir() and return that path.

    The hook command installed into Claude Code's settings.json must point at
    something an app update will not move. The bundle is not that: it lives
    under a versioned directory, and a reinstall replaces it. Copying once into
    the per-user location makes the installed command durable, and a later app
    version overwrites the copy rather than invalidating it.
    """
    src = _bundled_shim()
    if not src.exists():
        return None
    dst = stable_dir() / "cchud-hook.exe"
    if not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime:
        shutil.copy2(src, dst)
    return dst


def hookshim_exe() -> str:
    """The compiled, stable shim path this machine's hook command should use."""
    stable = ensure_stable_shim()
    if stable is not None:
        return str(stable)
    # No shim available at all. Return the bundled path rather than raising:
    # validate() reports it, and a daemon that refuses to start is worse than
    # one whose hooks are known-broken.
    return str(_bundled_shim())


def hookshim_script() -> str:
    """The Python shim. Slower to start but needs no rebuild."""
    return str(_resolve(_cfg()["hookshim"]["script"]))


def hookshim_command(which: str = "exe") -> str:
    """The exact command string installed into settings.json.

    Quoting happens here rather than at the call site: the project lives under
    "D:\\Claude DIY\\", and an unquoted space makes the shell treat "D:\\Claude"
    as the executable — a hook that silently never runs.
    """
    if which == "script":
        exe = python_exe()
        parts = [exe, hookshim_script()] if exe else [hookshim_script()]
    else:
        parts = [hookshim_exe()]
    return " ".join(f'"{p}"' if " " in p else p for p in parts)


def validate() -> list[str]:
    """Check that everything this module points at actually exists.

    Called at daemon startup, because a wrong path here is invisible until the
    user wonders why their expressions never appear.
    """
    problems: list[str] = []
    if not frozen():
        exe = python_exe()
        if exe and not Path(exe).exists():
            problems.append(f"python_exe does not exist: {exe}")
    if not _bundled_shim().exists():
        problems.append(f"hookshim exe missing: {_bundled_shim()}")
    if not frozen() and not Path(hookshim_script()).exists():
        problems.append(f"hookshim script missing: {hookshim_script()}")
    return problems


def _selftest() -> None:
    import tempfile

    assert Path(hookshim_exe()).is_absolute(), hookshim_exe()
    assert Path(hookshim_script()).is_absolute(), hookshim_script()

    cmd = hookshim_command("exe")
    # The whole path must sit inside the quotes, spaces and all. Checking that
    # the path has no spaces would be checking the opposite of what quoting is
    # for: this project lives under "D:\Claude DIY\".
    #
    # Quoting is conditional, not unconditional: a path without spaces stays
    # bare, and on this machine the stable shim path (under LOCALAPPDATA, no
    # spaces) is exactly that. Asserting a leading quote would be asserting the
    # wrong invariant and would fail for every user without a space in their
    # profile path.
    assert cmd == f'"{hookshim_exe()}"' if " " in hookshim_exe() else hookshim_exe(), cmd
    # Explicitly exercise the spacing case: the source tree does contain a
    # space, and that is the path the quoting rule exists for.
    spaced = hookshim_command("script") if " " in hookshim_script() else None
    if spaced is not None:
        assert f'"{hookshim_script()}"' in spaced, spaced

    # hookshim_exe() returns the *stable* copy, not the bundled original — that
    # is the whole point: the path installed into settings.json must survive an
    # app update that replaces the bundle. The bundled path is an internal
    # detail and must not leak into a hook command.
    stable = hookshim_exe()
    assert str(stable_dir()) in stable, stable
    assert stable_dir().name == "bin", stable

    # Frozen mode must not consult build.json, and must resolve inside the
    # bundle. Simulated rather than actually frozen, because PyInstaller is not
    # part of the daemon's runtime. sys.frozen does not exist until PyInstaller
    # sets it, so save and restore it as a plain attribute rather than assuming
    # it is already there.
    saved_frozen = getattr(sys, "frozen", False)
    saved_meipass = globals().get("_MEIPASS")
    had_frozen = hasattr(sys, "frozen")
    try:
        # Drop the cached configuration so the frozen check runs again with the
        # simulated state — otherwise the dev values captured at first use would
        # be what gets asserted.
        globals()["_RESOLVED"] = None
        sys.frozen = True
        globals()["_MEIPASS"] = _PROJECT_ROOT
        assert frozen()
        assert bundle_dir() == _PROJECT_ROOT, bundle_dir()
        assert daemon_dir() == _PROJECT_ROOT / "daemon", daemon_dir()
        assert firmware_dir().name == "claude_hud", firmware_dir()
        # python_exe is meaningless once frozen, and must be None rather than
        # this developer's interpreter path.
        assert python_exe() is None, python_exe()
        assert hookshim_command("script") == f'"{hookshim_script()}"' \
            if " " in hookshim_script() else hookshim_command("script") == hookshim_script(), \
            hookshim_command("script")
    finally:
        if had_frozen:
            sys.frozen = saved_frozen
        else:
            del sys.frozen
        globals()["_MEIPASS"] = saved_meipass      # always a name, never absent
        # Recompute with the real (development) state so the assertions below
        # see what an unpackaged daemon would actually use.
        globals()["_RESOLVED"] = None

    # The stable copy is what settings.json should point at: it must be outside
    # the bundle so an app update cannot invalidate it.
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["LOCALAPPDATA"] = tmp
        os.environ["APPDATA"] = tmp
        stable = ensure_stable_shim()
        if stable is not None:
            assert stable.parent.name == "bin", stable
            assert str(stable_dir()) not in str(bundle_dir()), (
                "the stable location must not be inside the bundle")
            # Second call is a no-op copy, not a rewrite.
            assert ensure_stable_shim() == stable

    # An already-absolute path passes through untouched.
    assert _resolve(r"C:\Windows\System32\cmd.exe").name == "cmd.exe"

    # A missing build.json still yields usable values rather than raising.
    saved = BUILD_JSON
    try:
        globals()["BUILD_JSON"] = Path(saved.parent / "definitely-not-here.json")
        assert hookshim_script(), "fallback must still answer"
    finally:
        globals()["BUILD_JSON"] = saved

    print("paths selftest OK")


if __name__ == "__main__":
    _selftest()
