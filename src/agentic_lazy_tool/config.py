"""Profiles live in a JSON file; API keys live in the OS keychain (or env vars)."""

import json
import os
import re
from pathlib import Path

import keyring
import keyring.errors

HOME = Path(os.environ.get("ALT_HOME") or Path.home() / ".agentic-lazy-tool")
CONFIG_FILE = HOME / "config.json"
KEYRING_SERVICE = "agentic-lazy-tool"
MAX_CLAUDE_PROFILES = 6


def load() -> dict:
    if CONFIG_FILE.exists():
        cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    else:
        cfg = {}
    cfg.setdefault("profiles", [])
    cfg.setdefault("system", "")
    return cfg


def save(cfg: dict) -> None:
    HOME.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def env_var(name: str) -> str:
    return "ALT_KEY_" + re.sub(r"[^A-Za-z0-9]", "_", name).upper()


_key_cache: dict[str, str | None] = {}


def get_key(name: str) -> str | None:
    key = os.environ.get(env_var(name))
    if key:
        return key
    # Keychain lookups are slow enough to notice when the status bar asks on every redraw.
    if name not in _key_cache:
        try:
            _key_cache[name] = keyring.get_password(KEYRING_SERVICE, name)
        except keyring.errors.KeyringError:
            _key_cache[name] = None
    return _key_cache[name]


def set_key(name: str, key: str) -> None:
    keyring.set_password(KEYRING_SERVICE, name, key)
    _key_cache[name] = key


def delete_key(name: str) -> None:
    _key_cache.pop(name, None)
    try:
        keyring.delete_password(KEYRING_SERVICE, name)
    except keyring.errors.KeyringError:
        pass
