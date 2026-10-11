"""Refuse a commit that contains an API key or private key.

Run by the git pre-commit hook (install it with: python scripts/install_hook.py).
Run by hand to scan everything git tracks: python scripts/check_secrets.py --all
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from agentic_lazy_tool.redact import find_tokens  # noqa: E402

# Personal data that must never be committed, whatever it contains.
FORBIDDEN_PARTS = {".agentic-lazy-tool", "memory", "sessions"}
FORBIDDEN_NAMES = {".env", "config.json", "history", "notes.jsonl"}


def git(*args: str) -> list[str]:
    result = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True)
    return [line for line in result.stdout.splitlines() if line]


def main() -> int:
    if "--all" in sys.argv:
        files = git("ls-files")
    else:
        files = git("diff", "--cached", "--name-only", "--diff-filter=ACM")
    problems = []
    for name in files:
        path = Path(name)
        if FORBIDDEN_PARTS & set(path.parts[:-1]) or path.name in FORBIDDEN_NAMES:
            problems.append(f"{name}: personal data file")
            continue
        try:
            text = (ROOT / path).read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for token in find_tokens(text):
            problems.append(f"{name}: looks like a secret ({token[:8]}...)")
    for problem in problems:
        print(problem)
    if problems:
        print("\nCommit stopped. Remove these before committing.")
        return 1
    print(f"No secrets found in {len(files)} file(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
