"""Install the git pre-commit hook that runs scripts/check_secrets.py before every commit."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOOK = ROOT / ".git" / "hooks" / "pre-commit"

if not HOOK.parent.is_dir():
    raise SystemExit("This folder is not a git repository.")
if HOOK.exists():
    raise SystemExit(f"{HOOK} already exists; add 'python scripts/check_secrets.py' to it by hand.")
HOOK.write_text("#!/bin/sh\npython scripts/check_secrets.py\n", encoding="utf-8", newline="\n")
HOOK.chmod(0o755)
print(f"Installed {HOOK}")
