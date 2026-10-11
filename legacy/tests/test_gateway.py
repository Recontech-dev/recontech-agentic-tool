"""The gateway against a fake provider server: real SDKs and real HTTP on both sides."""

import json
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import openai
import pytest

from agentic_lazy_tool import config, gateway, memory


class FakeProviders(BaseHTTPRequestHandler):
    """OpenAI-compatible and Anthropic endpoints. The API key decides how each one behaves."""

    received: list = []

    def log_message(self, *args):
        pass

    def sse(self, events):
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        for name, data in events:
            if name:
                self.wfile.write(f"event: {name}\n".encode())
            self.wfile.write(f"data: {data if isinstance(data, str) else json.dumps(data)}\n\n".encode())

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        key = self.headers.get("x-api-key") or self.headers.get("authorization", "").removeprefix("Bearer ")
        FakeProviders.received.append((key, body))
        if key == "limited":
            self.send_response(429)
            self.send_header("retry-after", "30")
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error": {"message": "slow down", "type": "rate_limit_error"}}')
            return
        if self.path == "/v1/messages":
            usage = {"input_tokens": 1, "output_tokens": 1}
            self.sse([
                ("message_start", {"type": "message_start", "message": {"id": "m", "type": "message", "role": "assistant",
                 "model": body["model"], "content": [], "stop_reason": None, "stop_sequence": None, "usage": usage}}),
                ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
                ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "from claude"}}),
                ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 2}}),
                ("message_stop", {"type": "message_stop"}),
            ])
            return
        reply = f"from {key}"
        if not body.get("stream"):
            data = json.dumps({"id": "c", "object": "chat.completion", "created": 0, "model": body["model"],
                               "choices": [{"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}]}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        part = lambda delta, finish=None: {"id": "c", "object": "chat.completion.chunk", "created": 0, "model": body["model"],
                                           "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        self.sse([(None, part({"role": "assistant", "content": reply[:5]})), (None, part({"content": reply[5:]})),
                  (None, part({}, "stop")), (None, "[DONE]")])


@pytest.fixture
def setup(monkeypatch, tmp_path):
    upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeProviders)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    fake = f"http://127.0.0.1:{upstream.server_port}"
    FakeProviders.received = []
    monkeypatch.setenv("ANTHROPIC_BASE_URL", fake)
    monkeypatch.setattr(config, "HOME", tmp_path / "home")
    monkeypatch.setattr(config, "CONFIG_FILE", tmp_path / "home" / "config.json")
    monkeypatch.setattr(gateway.net, "online", lambda: True)
    keys = {"busy": "limited", "free": "freekey", "claude": "claudekey"}
    monkeypatch.setattr(config, "get_key", keys.get)
    cfg = {"system": "", "profiles": [
        {"name": "busy", "provider": "groq", "model": "m1", "base_url": fake + "/v1"},
        {"name": "free", "provider": "groq", "model": "m2", "base_url": fake + "/v1"},
        {"name": "claude", "provider": "claude", "model": "claude-opus-5-5", "base_url": None},
    ]}
    gw = gateway.Gateway(cfg)
    server = ThreadingHTTPServer(("127.0.0.1", 0), gateway.make_handler(gw))
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    client = openai.OpenAI(base_url=base + "/v1", api_key=gw.key, max_retries=0)
    yield gw, base, client, tmp_path
    server.shutdown()
    upstream.shutdown()


def test_streaming_fails_over_and_skips_the_cooling_profile(setup):
    gw, _, client, _ = setup
    stream = client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "hi"}], stream=True)
    assert "".join(c.choices[0].delta.content or "" for c in stream if c.choices) == "from freekey"
    assert gw.chain.cooldown_left("busy") > 25
    client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "again"}])
    assert [key for key, _ in FakeProviders.received] == ["limited", "freekey", "freekey"]
    log = gw.status()["log"]
    assert log[1]["used"] == "free" and "busy: rate limited" in log[1]["skipped"][0]


def test_naming_a_profile_puts_it_first_including_claude(setup):
    _, _, client, _ = setup
    reply = client.chat.completions.create(
        model="claude", messages=[{"role": "system", "content": "Be brief."}, {"role": "user", "content": "hi"}]
    )
    assert reply.choices[0].message.content == "from claude"
    key, sent = FakeProviders.received[0]
    assert key == "claudekey" and sent["system"] == "Be brief." and sent["messages"] == [{"role": "user", "content": "hi"}]
    stream = client.chat.completions.create(model="claude", messages=[{"role": "user", "content": "hi"}], stream=True)
    assert "".join(c.choices[0].delta.content or "" for c in stream) == "from claude"


def test_tools_are_passed_through_and_never_sent_to_claude(setup):
    gw, _, client, _ = setup
    gw.chain.cooldowns["busy"] = 1e12
    gw.chain.cooldowns["free"] = 1e12
    tool = {"type": "function", "function": {"name": "lookup", "parameters": {"type": "object", "properties": {}}}}
    with pytest.raises(openai.APIStatusError) as failure:
        client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "hi"}], tools=[tool])
    assert failure.value.status_code == 503 and "tool calls" in str(failure.value)
    gw.chain.cooldowns.clear()
    client.chat.completions.create(model="free", messages=[{"role": "user", "content": "hi"}], tools=[tool], temperature=0.2, seed=7)
    _, sent = FakeProviders.received[-1]
    assert sent["tools"] == [tool] and sent["model"] == "m2" and sent["temperature"] == 0.2


def test_project_memory_is_added_when_asked(setup):
    _, _, client, tmp_path = setup
    project = tmp_path / "shop"
    project.mkdir()
    memory.add(project, "Postgres runs on port 5433", "manual")
    client.chat.completions.create(
        model="free", messages=[{"role": "user", "content": "db port?"}], extra_headers={"X-Alt-Project": str(project)}
    )
    _, sent = FakeProviders.received[-1]
    assert sent["messages"][0]["role"] == "system" and "port 5433" in sent["messages"][0]["content"]


def test_access_needs_the_key_and_the_local_host_name(setup):
    gw, base, client, _ = setup
    assert [m.id for m in client.models.list()] == ["auto", "busy", "free", "claude"]

    def status(path, headers):
        request = urllib.request.Request(base + path, headers=headers)
        try:
            return urllib.request.urlopen(request, timeout=5).status
        except urllib.error.HTTPError as error:
            return error.code

    assert status("/v1/models", {}) == 401
    assert status("/v1/models", {"Authorization": "Bearer wrong"}) == 401
    assert status("/v1/models", {"Authorization": f"Bearer {gw.key}", "Host": "evil.example"}) == 403
    assert status(f"/?key={gw.key}", {}) == 200
    assert status(f"/graph?key={gw.key}", {}) == 200
    with pytest.raises(openai.NotFoundError):
        client.chat.completions.create(model="nope", messages=[{"role": "user", "content": "hi"}])
    assert config.load()["gateway_key"] == gw.key
