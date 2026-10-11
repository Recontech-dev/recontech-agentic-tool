import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from agentic_lazy_tool import cli, config, providers, webapp


@pytest.fixture
def server(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "HOME", tmp_path / "home")
    monkeypatch.setattr(config, "CONFIG_FILE", tmp_path / "home" / "config.json")
    monkeypatch.setattr(cli.net, "online", lambda: True)
    monkeypatch.chdir(tmp_path)
    app = webapp.WebApp()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), webapp.make_handler(app))
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield app, f"http://127.0.0.1:{httpd.server_port}"
    httpd.shutdown()


def status(url, token="", data=None, host=None):
    request = urllib.request.Request(url, data=data)
    if token:
        request.add_header("X-Token", token)
    if host:
        request.add_header("Host", host)
    try:
        return urllib.request.urlopen(request, timeout=5).status
    except urllib.error.HTTPError as error:
        return error.code


def test_only_the_window_with_the_token_gets_in(server):
    app, base = server
    assert status(f"{base}/?t={app.token}") == 200
    assert status(f"{base}/?t=wrong") == 403
    assert status(f"{base}/?t={app.token}", host="attacker.example") == 403
    assert status(f"{base}/input", data=b'{"text": "/exit"}') == 403
    assert app.lines.empty()
    assert status(f"{base}/input", token=app.token, data=b'{"text": "hello"}') == 204
    assert app.lines.get_nowait() == "hello"


def test_cancel_stops_a_question_and_a_reply(server, monkeypatch):
    app, _ = server
    app.answers.put(None)
    with pytest.raises(KeyboardInterrupt):
        app.ask_user("Provider: ")

    def endless(*args, **kwargs):
        app.request_cancel()
        while True:
            yield "word "

    monkeypatch.setattr(providers, "stream_reply", endless)
    monkeypatch.setattr(config, "get_key", lambda name: "key")
    app.chain.profiles.append({"name": "one", "provider": "groq", "model": "m", "base_url": "x"})
    app.send("hi")
    assert app.history == []


def test_state_carries_the_graph_and_short_labels(server):
    app, _ = server
    app.cmd_remember("Deploys with Docker on port 8080")
    state = app.state()
    labels = [node["label"] for node in state["graph"]["nodes"] if node["kind"] == "note"]
    assert labels == ["Deploys Docker"]
    assert "/browse" in state["commands"]
    printed = "".join(app.backlog)
    assert "Remembered" in printed and json.dumps(state)
