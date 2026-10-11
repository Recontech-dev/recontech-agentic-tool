import subprocess
import sys
from pathlib import Path

import pytest

from agentic_lazy_tool import config
from agentic_lazy_tool.redact import find_tokens, redact
from agentic_lazy_tool.tasks import detect

ROOT = Path(__file__).resolve().parent.parent
FAKE_KEY = "sk-" + "ant-api03-" + "a" * 30


def test_known_key_formats_are_masked():
    text = f"my key is {FAKE_KEY} and token: abcdef123456"
    assert find_tokens(text) == [FAKE_KEY]
    assert FAKE_KEY not in redact(text) and "abcdef123456" not in redact(text)


def test_ordinary_text_is_left_alone():
    assert redact("The token limit is 4096 and the key idea is caching.") == (
        "The token limit is 4096 and the key idea is caching."
    )


def test_data_folder_inside_a_repo_is_detected(monkeypatch, tmp_path):
    (tmp_path / "repo" / ".git").mkdir(parents=True)
    monkeypatch.setattr(config, "HOME", tmp_path / "repo" / "data")
    assert config.home_git_repo() == (tmp_path / "repo").resolve()
    monkeypatch.setattr(config, "HOME", tmp_path / "elsewhere")
    assert config.home_git_repo() is None


def test_repository_contains_no_secrets():
    if not (ROOT / ".git").exists():
        pytest.skip("not a git checkout")
    result = subprocess.run(
        [sys.executable, "scripts/check_secrets.py", "--all"], cwd=ROOT, capture_output=True, text=True
    )
    assert result.returncode == 0, result.stdout


@pytest.mark.parametrize(
    "text, task",
    [
        ("I get a TypeError when saving", "debug"),
        ("please review this function", "review"),
        ("write unit tests for the parser", "test"),
        ("refactor this to be shorter", "refactor"),
        ("what does this regex do", "explain"),
        ("should I use Postgres or SQLite", "plan"),
        ("create a function that parses dates", "write code"),
    ],
)
def test_task_detection(text, task):
    assert detect(text).name == task


def test_small_talk_has_no_task():
    assert detect("thanks, that helps") is None
