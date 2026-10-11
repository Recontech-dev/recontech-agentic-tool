"""Long-term memory: a tree of projects, each holding notes kept from past sessions.

Everything is stored under the user's data folder, never inside a project, so it
cannot end up in a project's git repository.
"""

import hashlib
import json
import re
import time
from pathlib import Path

from agentic_lazy_tool import config
from agentic_lazy_tool.redact import redact

CONTEXT_LIMIT = 6000
MAX_TOPICS = 30
STOPWORDS = set(
    "this that with from have will uses using used when then than they them their there which would should "
    "could about into over also only been being were what your just more most some such each very must make "
    "made need needs does done still left user wants want project".split()
)


def root() -> Path:
    return config.HOME / "memory"


def project_dir(folder: Path) -> Path:
    resolved = folder.resolve()
    digest = hashlib.sha1(str(resolved).lower().encode()).hexdigest()[:8]
    name = re.sub(r"[^A-Za-z0-9_-]+", "-", resolved.name).strip("-") or "root"
    return root() / f"{name}-{digest}"


def _read(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _write(path: Path, notes: list[dict]) -> None:
    path.write_text("".join(json.dumps(note) + "\n" for note in notes), encoding="utf-8")


def notes(folder: Path) -> list[dict]:
    """This project's notes, oldest first."""
    return _read(project_dir(folder) / "notes.jsonl")


def add(folder: Path, text: str, source: str) -> str:
    directory = project_dir(folder)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "project.json").write_text(json.dumps({"folder": str(folder.resolve())}), encoding="utf-8")
    note = {"time": time.strftime("%Y-%m-%d %H:%M"), "text": redact(text.strip()), "source": source}
    with open(directory / "notes.jsonl", "a", encoding="utf-8") as file:
        file.write(json.dumps(note) + "\n")
    return note["text"]


def remove(folder: Path, number: int) -> dict | None:
    """Delete the note with this 1-based number; return it, or None if there is no such note."""
    kept = notes(folder)
    if not 1 <= number <= len(kept):
        return None
    removed = kept.pop(number - 1)
    _write(project_dir(folder) / "notes.jsonl", kept)
    return removed


def tree() -> list[dict]:
    """Every remembered project with its notes, most recently updated first."""
    projects = []
    for directory in root().glob("*"):
        kept = _read(directory / "notes.jsonl")
        if not kept:
            continue
        folder = json.loads((directory / "project.json").read_text(encoding="utf-8"))["folder"]
        projects.append({"name": Path(folder).name, "folder": folder, "notes": kept})
    return sorted(projects, key=lambda project: project["notes"][-1]["time"], reverse=True)


def search(query: str, limit: int = 10) -> list[tuple[str, dict]]:
    """Notes from any project that share words with the query, best match first."""
    words = {word for word in re.findall(r"\w+", query.lower()) if len(word) > 2}
    scored = []
    for project in tree():
        for note in project["notes"]:
            text = note["text"].lower()
            score = sum(word in text for word in words)
            if score:
                scored.append((score, note["time"], project["name"], note))
    scored.sort(key=lambda item: item[:2], reverse=True)
    return [(name, note) for _, _, name, note in scored[:limit]]


def topics(projects: list[dict]) -> list[tuple[str, list[tuple[int, int]]]]:
    """Words that appear in two or more notes, most common first.

    Each comes with the (project index, note index) pairs of the notes it links.
    """
    found: dict[str, list[tuple[int, int]]] = {}
    for p, project in enumerate(projects):
        for n, note in enumerate(project["notes"]):
            for word in set(re.findall(r"[a-z][a-z0-9_+#-]{3,}", note["text"].lower())):
                if word not in STOPWORDS:
                    found.setdefault(word, []).append((p, n))
    shared = [(word, references) for word, references in found.items() if len(references) >= 2]
    shared.sort(key=lambda item: (-len(item[1]), item[0]))
    return shared[:MAX_TOPICS]


def keywords(text: str, limit: int = 2) -> str:
    """A note shortened to its first few meaningful words, for labels in the memory picture."""
    words = [word for word in re.findall(r"[A-Za-z][A-Za-z0-9_+#-]{2,}", text) if word.lower() not in STOPWORDS]
    return " ".join(words[:limit]) or text[:20]


def loaded(folder: Path) -> list[dict]:
    """The notes given to the model: the newest ones that fit the size limit, oldest first."""
    chosen, size = [], 0
    for note in reversed(notes(folder)):
        size += len(note["text"])
        if size > CONTEXT_LIMIT:
            break
        chosen.append(note)
    return chosen[::-1]


def context(folder: Path) -> str:
    """The loaded notes as text for the system prompt."""
    chosen = loaded(folder)
    if not chosen:
        return ""
    lines = [f"- ({note['time'][:10]}) {note['text']}" for note in chosen]
    return "Notes you kept from earlier sessions on this project:\n" + "\n".join(lines)
