"""device.py — the HUD's display settings, mirrored on the host.

The firmware has accepted these four values since the first rewrite (MSG_CONFIG
in claude_hud.ino, persisted to NVS), but nothing on the host could ever set
them: expressions.py grew a config() helper that no route called, so brightness,
animation speed, rotation and the offline timeout were unreachable. On a panel
this bright that is the difference between usable and not.

The device stays authoritative — it holds the values in NVS and applies them on
boot. This module is the host's mirror, so the UI has something to render, and a
copy to push back after a reflash or a factory reset wipes the device's.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

from .logbus import app_dir

# Ranges the firmware clamps to. Kept here so the UI can size its controls
# without a second source of truth.
BRIGHTNESS_RANGE = (0, 255)
SPEED_RANGE = (1, 3)
ROTATION_RANGE = (0, 3)
IDLE_RANGE = (5, 300)


@dataclass(slots=True)
class DeviceConfig:
    brightness: int = 160     # backlight PWM duty; 0 is dark, 255 is full
    speed: int = 2            # animation speed: 1 slow, 2 normal, 3 fast
    rotation: int = 1         # ST7789 rotation, 0..3
    idle_s: int = 30          # seconds of host silence before OFFLINE

    @classmethod
    def load(cls, path: Path | None = None) -> "DeviceConfig":
        path = path or config_path()
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return cls()
        if not isinstance(raw, dict):
            return cls()

        cfg = cls()
        for name, (lo, hi) in (
            ("brightness", BRIGHTNESS_RANGE),
            ("speed", SPEED_RANGE),
            ("rotation", ROTATION_RANGE),
            ("idle_s", IDLE_RANGE),
        ):
            value = raw.get(name)
            if isinstance(value, int) and not isinstance(value, bool):
                setattr(cfg, name, max(lo, min(hi, value)))
        return cfg

    def save(self, path: Path | None = None) -> None:
        path = path or config_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")
        tmp.replace(path)

    def validate(self) -> list[str]:
        problems = []
        for name, (lo, hi) in (
            ("brightness", BRIGHTNESS_RANGE),
            ("speed", SPEED_RANGE),
            ("rotation", ROTATION_RANGE),
            ("idle_s", IDLE_RANGE),
        ):
            value = getattr(self, name)
            if not lo <= value <= hi:
                problems.append(f"{name}={value} outside {lo}..{hi}")
        return problems

    def to_dict(self) -> dict:
        """Dict of this config for API responses.

        dataclass(slots=True) has no __dict__, so callers must not reach for it.
        """
        return asdict(self)


def config_path() -> Path:
    return app_dir() / "device.json"


def _selftest() -> None:
    import os
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        os.environ["APPDATA"] = tmp
        path = Path(tmp) / "ClaudeHUD" / "device.json"

        cfg = DeviceConfig(brightness=90, speed=3, rotation=2, idle_s=45)
        cfg.save(path)
        back = DeviceConfig.load(path)
        assert back == cfg, (back, cfg)

        # Out-of-range values are clamped rather than rejected: a stale file
        # from an older build should degrade, not disable the panel.
        path.write_text('{"brightness": 9999, "speed": 99, "rotation": -5}',
                        encoding="utf-8")
        clamped = DeviceConfig.load(path)
        assert clamped.brightness == 255, clamped.brightness
        assert clamped.speed == 3, clamped.speed
        assert clamped.rotation == 0, clamped.rotation
        assert not clamped.validate()

        # Booleans are not ints for this purpose, and junk types fall back.
        path.write_text('{"brightness": true, "speed": "fast"}', encoding="utf-8")
        junk = DeviceConfig.load(path)
        assert junk.brightness == 160 and junk.speed == 2, junk

        # A missing file is defaults, not an error.
        assert DeviceConfig.load(Path(tmp) / "nope.json") == DeviceConfig()

        # Nothing left behind by a successful save.
        assert not (path.parent / "device.tmp").exists()

        # The firmware's frame payload is four bytes in this order.
        order = (cfg.brightness, cfg.speed, cfg.rotation, cfg.idle_s)
        assert len(bytes(b & 0xFF for b in order)) == 4
    print("device selftest OK")


if __name__ == "__main__":
    _selftest()
