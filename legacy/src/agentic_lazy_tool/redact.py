"""Find and mask secrets, so they are not stored in memory or committed by mistake."""

import re

# Formats that are specific enough to trust anywhere, including in source code.
TOKEN_PATTERNS = [
    r"sk-[A-Za-z0-9_-]{20,}",  # Anthropic, OpenAI, OpenRouter
    r"gsk_[A-Za-z0-9]{20,}",  # Groq
    r"csk-[A-Za-z0-9]{20,}",  # Cerebras
    r"AIza[0-9A-Za-z_-]{35}",  # Google
    r"gh[pousr]_[A-Za-z0-9]{36,}",  # GitHub
    r"github_pat_[A-Za-z0-9_]{20,}",
    r"AKIA[0-9A-Z]{16}",  # AWS
    r"xox[baprs]-[A-Za-z0-9-]{10,}",  # Slack
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
]
TOKENS = re.compile("|".join(TOKEN_PATTERNS))

# "password = hunter2" style assignments. Too noisy for scanning code, fine for notes.
ASSIGNMENT = re.compile(r"(?i)\b(password|passwd|secret|api[_-]?key|token)(\s*[:=]\s*)[\"']?[^\s\"']{6,}[\"']?")


def find_tokens(text: str) -> list[str]:
    return TOKENS.findall(text)


def redact(text: str) -> str:
    text = TOKENS.sub("[secret removed]", text)
    return ASSIGNMENT.sub(r"\1\2[secret removed]", text)
