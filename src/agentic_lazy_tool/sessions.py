"""Conversations are saved after every reply so they can be resumed later."""

import json
import time
from pathlib import Path

from agentic_lazy_tool import config


def folder() -> Path:
    return config.HOME / "sessions"


def new_id() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


def save(session_id: str, messages: list[dict]) -> None:
    folder().mkdir(parents=True, exist_ok=True)
    data = {"folder": str(Path.cwd()), "messages": messages}
    (folder() / f"{session_id}.json").write_text(json.dumps(data), encoding="utf-8")


def recent(limit: int = 10) -> list[dict]:
    """Newest first. Each entry has id, folder, title and messages."""
    entries = []
    for path in sorted(folder().glob("*.json"), reverse=True)[:limit]:
        data = json.loads(path.read_text(encoding="utf-8"))
        first = next((m["content"] for m in data["messages"] if m["role"] == "user"), "")
        title = first.strip().splitlines()[-1][:60] if first.strip() else "(empty)"
        entries.append({"id": path.stem, "title": title, **data})
    return entries
