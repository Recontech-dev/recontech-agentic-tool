import pytest

from agentic_lazy_tool import cli, config, providers, sessions


@pytest.fixture
def app(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "HOME", tmp_path / "home")
    monkeypatch.setattr(config, "CONFIG_FILE", tmp_path / "home" / "config.json")
    monkeypatch.setattr(config, "get_key", lambda name: "key")
    monkeypatch.setattr(cli.net, "online", lambda: True)
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


def test_saved_prompt_is_sent_with_extra_text(app):
    app.cmd_prompt("add review Review this code for bugs.")
    app.cmd_prompt("review focus on a.py")
    assert app.history[0]["content"] == "Review this code for bugs. focus on a.py"
    assert config.load()["prompts"] == {"review": "Review this code for bugs."}


def test_project_file_adds_system_prompt_and_first_message_files(app, tmp_path):
    outside = tmp_path / "secret.txt"
    outside.write_text("SECRET", encoding="utf-8")
    (tmp_path / "work" / ".alt.json").write_text(
        '{"system": "Use tabs.", "files": ["a.py", "../secret.txt"]}', encoding="utf-8"
    )
    app.cmd_cd("")
    assert app.system_prompt() == "Use tabs."
    app.send(app.take_message("first"))
    app.send(app.take_message("second"))
    assert "A = 1" in app.history[0]["content"]
    assert "SECRET" not in app.history[0]["content"]
    assert app.history[2]["content"] == "second"


def test_render_setting_is_saved(app):
    app.cmd_render("off")
    assert config.load()["render"] is False
    assert app.renderer().markdown is False


def reply_with(monkeypatch, answers):
    """Make the fake provider give these answers in turn and record what it was sent."""
    calls = []

    def fake(profile, key, messages, system=""):
        calls.append({"messages": messages, "system": system})
        yield answers[min(len(calls), len(answers)) - 1]

    monkeypatch.setattr(providers, "stream_reply", fake)
    return calls


def test_task_is_detected_and_instructs_the_model(app, monkeypatch):
    calls = reply_with(monkeypatch, ["ok"])
    app.submit("I get an error when I run a.py")
    assert "debugging" in calls[0]["system"]
    app.cmd_specialize("off")
    app.submit("another error here")
    assert calls[1]["system"] == ""


def test_optimize_rewrites_the_prompt_before_sending(app, monkeypatch):
    calls = reply_with(monkeypatch, ["Explain what a.py does, step by step.", "answer"])
    app.cmd_optimize("tell me abt a.py")
    assert calls[0]["messages"][0]["content"] == "tell me abt a.py"
    assert app.history[0]["content"] == "Explain what a.py does, step by step."
    assert app.history[1]["content"] == "answer"


def test_remembered_notes_reach_later_conversations_and_drop_secrets(app, monkeypatch):
    calls = reply_with(monkeypatch, ["ok"])
    app.cmd_remember("Database is Postgres 16, password=hunter2secret")
    app.cmd_new("")
    app.submit("hello")
    assert "Postgres 16" in calls[0]["system"]
    assert "hunter2secret" not in calls[0]["system"]


def test_conversation_becomes_notes_when_it_ends(app, monkeypatch):
    reply_with(monkeypatch, ["one", "two", "- Uses Flask 3\n- Deploy is still unfinished\nchatter"])
    app.send("q1")
    app.send("q2")
    app.cmd_new("")
    from agentic_lazy_tool import memory
    from pathlib import Path

    assert [n["text"] for n in memory.notes(Path.cwd())] == ["Uses Flask 3", "Deploy is still unfinished"]
    assert memory.search("flask")[0][1]["text"] == "Uses Flask 3"
    app.cmd_memory("forget 1")
    assert len(memory.notes(Path.cwd())) == 1


def test_short_conversation_is_not_summarised(app, monkeypatch):
    calls = reply_with(monkeypatch, ["one"])
    app.send("q1")
    app.cmd_new("")
    assert len(calls) == 1


def test_memory_views_show_what_is_open(app, monkeypatch, tmp_path):
    import io
    from pathlib import Path

    from rich.console import Console

    from agentic_lazy_tool import graph, memory

    other = tmp_path / "other"
    other.mkdir()
    memory.add(other, "Deploys with Docker on port 8080", "manual")
    app.cmd_remember("Uses Docker for the database </script>")
    app.cmd_file("a.py")
    app.console = Console(file=io.StringIO(), width=200)
    app.cmd_memory("")
    app.cmd_context("")
    shown = app.console.file.getvalue()
    assert "(open now)" in shown and "● 1." in shown and "○ 1." in shown
    assert "docker  2 notes in 2 project(s)" in shown
    assert "Memory: 1 of 1 notes" in shown and "a.py" in shown

    opened = []
    monkeypatch.setattr(cli.webbrowser, "open", opened.append)
    app.cmd_memory("graph")
    page = (config.HOME / "memory-map.html").read_text(encoding="utf-8")
    assert opened and "</script> " not in page.split("const data = ")[1].split("\n")[0]

    data = graph.build(memory.tree(), str(Path.cwd().resolve()), 1)
    kinds = [node["kind"] for node in data["nodes"]]
    assert kinds.count("project") == 2 and kinds.count("note") == 2 and "topic" in kinds
    assert [n["open"] for n in data["nodes"] if n["kind"] == "project"].count(True) == 1
    assert {link["source"] for link in data["links"]} >= {"p0", "p1", "t:docker"}


def go_offline(app, monkeypatch):
    monkeypatch.setattr(cli.net, "online", lambda: False)
    app.check_connection(force=True)
    assert app.chain.offline


def test_offline_without_a_local_model_answers_from_memory(app, monkeypatch):
    import io

    from rich.console import Console

    calls = reply_with(monkeypatch, ["Run docker compose up to start Postgres."])
    app.submit("how do I start the database with docker")
    app.cmd_remember("Postgres runs in Docker on port 5433")
    app.cmd_new("")

    go_offline(app, monkeypatch)
    app.console = Console(file=io.StringIO(), width=200)
    app.submit("docker database port?")
    shown = app.console.file.getvalue()
    assert len(calls) == 1 and app.history == []
    assert "no local model" in shown
    assert "Postgres runs in Docker on port 5433" in shown
    assert "You asked: how do I start the database with docker" in shown
    assert "Run docker compose up" in shown
    assert "OFFLINE" in app.toolbar()


def test_offline_uses_only_the_local_model_and_gives_it_recalled_memory(app, monkeypatch, tmp_path):
    from agentic_lazy_tool import memory

    other = tmp_path / "other"
    other.mkdir()
    memory.add(other, "Redis cache listens on port 6380", "manual")
    app.chain.profiles.append({"name": "local", "provider": "ollama", "model": "m", "base_url": "http://localhost:11434/v1"})
    used = []

    def fake(profile, key, messages, system=""):
        used.append((profile["name"], system))
        yield "local answer"

    monkeypatch.setattr(providers, "stream_reply", fake)
    go_offline(app, monkeypatch)
    app.submit("which port is the redis cache on")
    assert [name for name, _ in used] == ["local"]
    assert "Redis cache listens on port 6380" in used[0][1]
    assert app.history[1]["content"] == "local answer"

    monkeypatch.setattr(cli.net, "online", lambda: True)
    app.check_connection(force=True)
    app.submit("and now?")
    assert used[-1][0] == "one"


def test_offline_setting_can_be_forced(app, monkeypatch):
    app.cmd_offline("on")
    assert app.chain.offline and config.load()["offline"] == "on"
    app.cmd_offline("off")
    assert not app.chain.offline
