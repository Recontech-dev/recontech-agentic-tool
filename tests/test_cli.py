import pytest

from agentic_lazy_tool import cli, config, providers, sessions


@pytest.fixture
def app(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "HOME", tmp_path / "home")
    monkeypatch.setattr(config, "CONFIG_FILE", tmp_path / "home" / "config.json")
    monkeypatch.setattr(config, "get_key", lambda name: "key")
    monkeypatch.setattr(providers, "stream_reply", lambda *a, **k: iter(["Use this:\n```py\nprint(1)\n```\n"]))
    work = tmp_path / "work"
    work.mkdir()
    (work / "a.py").write_text("A = 1", encoding="utf-8")
    (work / "b.py").write_text("B = 2", encoding="utf-8")
    monkeypatch.chdir(work)
    app = cli.App()
    app.chain.profiles.append({"name": "one", "provider": "groq", "model": "m", "base_url": "x"})
    return app


def test_every_help_command_has_a_handler(app):
    for command in cli.COMMANDS:
        assert command == "/exit" or hasattr(app, "cmd_" + command[1:]), command


def test_file_glob_attaches_and_is_sent_once(app):
    app.cmd_file("*.py")
    assert len(app.attachments) == 2
    app.send(app.take_message("review"))
    assert "A = 1" in app.history[0]["content"] and app.history[0]["content"].endswith("review")
    assert app.attachments == []


def test_oversized_attachment_is_refused(app, monkeypatch):
    monkeypatch.setattr(cli, "MAX_ATTACH_BYTES", 5)
    app.cmd_file("a.py")
    assert app.attachments == []


def test_conversation_is_saved_and_resumed(app):
    app.send("hello")
    app.cmd_new("")
    assert app.history == []
    app.cmd_resume("")
    assert [m["role"] for m in app.history] == ["user", "assistant"]
    assert sessions.recent()[0]["title"] == "hello"


def test_retry_resends_last_question(app):
    app.send("hello")
    app.cmd_retry("")
    assert [m["content"] for m in app.history if m["role"] == "user"] == ["hello"]
    assert len(app.history) == 2


def test_copy_code_takes_last_block(app, monkeypatch):
    copied = []
    monkeypatch.setattr(cli, "copy_to_clipboard", copied.append)
    app.send("hello")
    app.cmd_copy("code")
    assert copied == ["print(1)\n"]


def test_model_change_is_saved(app):
    app.cmd_model("one new-model")
    assert config.load()["profiles"][0]["model"] == "new-model"


def test_toolbar_names_next_profile(app):
    assert "next: one" in app.toolbar()


def test_one_shot_prints_reply_and_attaches_piped_input(app, monkeypatch, capsys):
    import io

    seen = []
    monkeypatch.setattr(providers, "stream_reply", lambda p, k, messages, s="": seen.append(messages) or iter(["done"]))
    monkeypatch.setattr("sys.stdin", io.StringIO("diff text"))
    assert app.one_shot("review this") == 0
    assert capsys.readouterr().out == "done\n"
    assert "diff text" in seen[0][0]["content"] and seen[0][0]["content"].endswith("review this")


def test_one_shot_fails_cleanly_when_nothing_is_available(app, monkeypatch, capsys):
    import io

    def limited(*args, **kwargs):
        raise providers.ProviderFailure("rate limited", cooldown=60)
        yield

    monkeypatch.setattr(providers, "stream_reply", limited)
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    assert app.one_shot("hi") == 1
    assert "unavailable" in capsys.readouterr().err
