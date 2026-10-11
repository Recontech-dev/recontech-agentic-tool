"""Conversations are saved after every reply so they can be resumed later."""

import json
import re
import time
from pathlib import Path

from agentic_lazy_tool import config


def folder() -> Path:
    return config.HOME / "sessions"


def new_id() -> str:
    # Two conversations started in the same second must not share a file.
    stamp = time.strftime("%Y%m%d-%H%M%S")
    candidate, count = stamp, 1
    while (folder() / f"{candidate}.json").exists():
        count += 1
        candidate = f"{stamp}-{count}"
    return candidate


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


def search(query: str, limit: int = 3, exclude: str = "") -> list[dict]:
    """Past exchanges that share words with the query, best match first.

    Each result has the session id, the question as typed and the reply.
    """
    words = {word for word in re.findall(r"\w+", query.lower()) if len(word) > 2}
    scored = []
    for path in folder().glob("*.json"):
        if path.stem == exclude:
            continue
        messages = json.loads(path.read_text(encoding="utf-8"))["messages"]
        for asked, reply in zip(messages[::2], messages[1::2]):
            # Attached files come before the typed text, so the question is the last paragraph.
            question = asked["content"].rsplit("\n\n", 1)[-1]
            text = (question + " " + reply["content"]).lower()
            score = sum(word in text for word in words)
            if score:
                scored.append((score, path.stem, {"id": path.stem, "question": question, "reply": reply["content"]}))
    scored.sort(key=lambda item: item[:2], reverse=True)
    return [result for _, _, result in scored[:limit]]
