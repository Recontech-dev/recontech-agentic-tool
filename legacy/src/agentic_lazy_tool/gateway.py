"""Local AI gateway: one OpenAI-compatible address that routes each request across your profiles.

Any tool that can talk to the OpenAI API (Cursor, Cline, Continue, scripts, your own apps)
points at http://127.0.0.1:20129/v1 and uses model "auto". The gateway tries your profiles
in chain order, skips any that are cooling down, and fails over before the first word of the
answer is sent. It listens only on this machine.
"""

import collections
import inspect
import itertools
import json
import secrets
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import anthropic
import openai

from agentic_lazy_tool import config, graph, memory, net, providers
from agentic_lazy_tool.chain import Chain

DEFAULT_PORT = 20129
CONNECTION_CHECK_SECONDS = 30
LOG_SIZE = 200
CREATE_PARAMS = set(inspect.signature(openai.resources.chat.Completions.create).parameters) - {"self"}


class NoRoute(Exception):
    """No profile could answer. `status` is the HTTP status to report."""

    def __init__(self, message: str, status: int = 503):
        super().__init__(message)
        self.status = status


def text_of(content) -> str:
    """The text of an OpenAI message content, which is either a string or a list of parts."""
    if isinstance(content, str):
        return content
    return "".join(part.get("text", "") for part in content or [] if isinstance(part, dict))


def chunk(model: str, request_id: str, delta: dict, finish: str | None = None) -> dict:
    return {
        "id": request_id, "object": "chat.completion.chunk", "created": int(time.time()), "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


def openai_compatible(profile: dict, key: str | None, body: dict, stream: bool):
    client = openai.OpenAI(api_key=key or "none", base_url=profile["base_url"], max_retries=0)
    known = {k: v for k, v in body.items() if k in CREATE_PARAMS and k not in ("model", "stream")}
    extra = {k: v for k, v in body.items() if k not in CREATE_PARAMS}
    response = client.chat.completions.create(
        model=profile["model"], stream=stream, extra_body=extra or None, **known
    )
    if not stream:
        return response.model_dump(exclude_none=True)
    return (part.model_dump(exclude_none=True) for part in response)


def claude(profile: dict, key: str, body: dict, stream: bool):
    if body.get("tools"):
        # Translating tool calls between the two formats is not supported yet.
        raise providers.ProviderFailure("tool calls are only routed to OpenAI-compatible profiles")
    system = "\n\n".join(text_of(m.get("content")) for m in body["messages"] if m.get("role") in ("system", "developer"))
    messages = [
        {"role": m["role"], "content": text_of(m.get("content"))}
        for m in body["messages"]
        if m.get("role") in ("user", "assistant") and text_of(m.get("content"))
    ]
    headers = {"anthropic-workspace-id": profile["workspace"]} if profile.get("workspace") else None
    client = anthropic.Anthropic(api_key=key, max_retries=0, default_headers=headers)
    kwargs = {
        "model": profile["model"],
        "max_tokens": body.get("max_completion_tokens") or body.get("max_tokens") or 16000,
        "messages": messages,
    }
    if system:
        kwargs["system"] = system
    request_id = "chatcmpl-" + uuid.uuid4().hex

    def chunks():
        with client.messages.stream(**kwargs) as reply:
            yield chunk(profile["model"], request_id, {"role": "assistant", "content": ""})
            for text in reply.text_stream:
                yield chunk(profile["model"], request_id, {"content": text})
            final = reply.get_final_message()
        finish = {"max_tokens": "length", "refusal": "content_filter"}.get(final.stop_reason, "stop")
        yield chunk(profile["model"], request_id, {}, finish)

    if stream:
        return chunks()
    parts = list(chunks())
    return {
        "id": request_id, "object": "chat.completion", "created": int(time.time()), "model": profile["model"],
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "".join(p["choices"][0]["delta"].get("content", "") for p in parts)},
            "finish_reason": parts[-1]["choices"][0]["finish_reason"],
        }],
    }


def call(profile: dict, key: str | None, body: dict, stream: bool):
    """Start the request. For a stream, the first chunk is fetched here so failures surface before anything is sent."""
    adapter = claude if profile["provider"] == "claude" else openai_compatible
    try:
        result = adapter(profile, key, body, stream)
        if not stream:
            return result
        first = next(result, None)
        return itertools.chain([first] if first else [], result)
    except (anthropic.APIError, openai.APIError) as error:
        raise providers._failure(error) from error


class Gateway:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.chain = Chain(cfg)
        if not cfg.get("gateway_key"):
            cfg["gateway_key"] = "alt-" + secrets.token_urlsafe(24)
            config.save(cfg)
        self.key = cfg["gateway_key"]
        self.log = collections.deque(maxlen=LOG_SIZE)
        self.served = collections.Counter()
        self.lock = threading.Lock()
        self.connection_checked = 0.0

    def check_connection(self) -> None:
        if time.time() - self.connection_checked > CONNECTION_CHECK_SECONDS:
            self.connection_checked = time.time()
            self.chain.offline = not net.online()

    def candidates(self, model: str) -> list[dict]:
        if model in ("", "auto"):
            return self.chain.order()
        if self.chain.find(model):
            return self.chain.order(model)
        raise NoRoute(f"Unknown model {model!r}. Use \"auto\" or one of your profile names.", 404)

    def with_memory(self, body: dict, folder: str) -> dict:
        """Add the stored notes of a project to the request, as a system message at the start."""
        if not folder or not Path(folder).is_dir():
            return body
        notes = memory.context(Path(folder))
        if not notes:
            return body
        return {**body, "messages": [{"role": "system", "content": notes}, *body["messages"]]}

    def complete(self, body: dict, stream: bool, folder: str = ""):
        """Return (profile name, result) from the first profile that accepts the request."""
        if not isinstance(body.get("messages"), list) or not body["messages"]:
            raise NoRoute("The request needs a non-empty messages list.", 400)
        self.check_connection()
        body = self.with_memory(body, folder)
        started, tried = time.time(), []
        for profile in self.candidates(str(body.get("model", "auto"))):
            name = profile["name"]
            if self.chain.cooldown_left(name) or not self.chain.usable(profile) or not self.chain.has_key(profile):
                continue
            try:
                result = call(profile, config.get_key(name), body, stream)
            except providers.ProviderFailure as failure:
                if failure.cooldown:
                    self.chain.cooldowns[name] = time.time() + failure.cooldown
                tried.append(f"{name}: {failure.reason}")
                continue
            self.record(body, name, tried, started, ok=True)
            return name, result
        self.record(body, None, tried, started, ok=False)
        raise NoRoute("No profile could answer. " + ("; ".join(tried) or self.chain.unavailable_reason()))

    def record(self, body: dict, used: str | None, tried: list[str], started: float, ok: bool) -> None:
        with self.lock:
            if used:
                self.served[used] += 1
            self.log.appendleft({
                "time": time.strftime("%H:%M:%S"), "asked": body.get("model", "auto"), "used": used or "-",
                "skipped": tried, "ms": int((time.time() - started) * 1000), "ok": ok,
            })

    def status(self) -> dict:
        profiles = [{
            "name": p["name"], "provider": p["provider"], "model": p["model"],
            "state": "no key" if not self.chain.has_key(p)
            else "offline" if not self.chain.usable(p)
            else f"back in {self.chain.cooldown_left(p['name']):.0f}s" if self.chain.cooldown_left(p["name"])
            else "ready",
            "served": self.served[p["name"]],
        } for p in self.chain.profiles]
        return {"offline": self.chain.offline, "profiles": profiles, "log": list(self.log)}


def make_handler(gateway: Gateway):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args) -> None:
            pass

        def send_json(self, status: int, data: dict) -> None:
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def send_error_json(self, status: int, message: str) -> None:
            self.send_json(status, {"error": {"message": message, "type": "gateway_error", "code": status}})

        def send_html(self, html: str) -> None:
            body = html.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def allowed(self) -> bool:
            # A key is required even on this machine, so web pages and other programs cannot use
            # your accounts; the Host check blocks pages that reach the port through a look-alike name.
            port = self.server.server_port
            if self.headers.get("Host") not in (f"127.0.0.1:{port}", f"localhost:{port}"):
                self.send_error_json(403, "Wrong host.")
                return False
            auth = self.headers.get("Authorization", "")
            given = auth.removeprefix("Bearer ").strip() or self.headers.get("x-api-key", "")
            given = given or parse_qs(urlparse(self.path).query).get("key", [""])[0]
            if not secrets.compare_digest(given, gateway.key):
                self.send_error_json(401, "Missing or wrong gateway key. It is shown when you run: alt serve")
                return False
            return True

        def do_GET(self) -> None:
            if not self.allowed():
                return
            route = urlparse(self.path).path
            if route == "/v1/models":
                names = ["auto", *(p["name"] for p in gateway.chain.profiles)]
                self.send_json(200, {"object": "list", "data": [
                    {"id": name, "object": "model", "created": 0, "owned_by": "agentic-lazy-tool"} for name in names
                ]})
            elif route == "/api/status":
                self.send_json(200, gateway.status())
            elif route in ("/", "/dashboard"):
                self.send_html(DASHBOARD)
            elif route == "/graph":
                data = graph.build(memory.tree(), "", 0)
                page = graph.PAGE.replace("__DATA__", json.dumps(data).replace("</", "<\\/"))
                self.send_html(page)
            else:
                self.send_error_json(404, "Not found.")

        def do_POST(self) -> None:
            if not self.allowed():
                return
            if urlparse(self.path).path != "/v1/chat/completions":
                return self.send_error_json(404, "Only /v1/chat/completions is supported.")
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            except ValueError:
                return self.send_error_json(400, "The body is not valid JSON.")
            stream = bool(body.get("stream"))
            try:
                used, result = gateway.complete(body, stream, self.headers.get("X-Alt-Project", ""))
            except NoRoute as problem:
                return self.send_error_json(problem.status, str(problem))
            if not stream:
                self.send_json(200, result)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Alt-Profile", used)
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            try:
                for part in result:
                    self.wfile.write(f"data: {json.dumps(part)}\n\n".encode())
                    self.wfile.flush()
            except OSError:
                return
            except Exception as error:
                # The answer had already started, so it can no longer move to another profile.
                message = getattr(error, "message", str(error))
                self.wfile.write(f"data: {json.dumps({'error': {'message': message}})}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

    return Handler


def serve(port: int = DEFAULT_PORT) -> None:
    gateway = Gateway(config.load())
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(gateway))
    server.daemon_threads = True
    base = f"http://127.0.0.1:{server.server_port}"
    print(f"""Agentic Lazy Tool gateway

  Endpoint   {base}/v1
  API key    {gateway.key}
  Model      auto   (or the name of one profile)
  Dashboard  {base}/?key={gateway.key}

Point any OpenAI-compatible tool at the endpoint with this key.
Add the header  X-Alt-Project: <project folder>  to give the model that project's memory.
Press Ctrl+C to stop.""", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


DASHBOARD = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gateway dashboard</title>
<style>
  :root { --bg:#f6f7f9; --panel:#fff; --text:#1c2330; --dim:#6b7686; --line:#dde2e9; --ok:#16a36a; --warn:#c27c0e; --bad:#d23f3f; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12161c; --panel:#1b212a; --text:#e6eaf0; --dim:#8b96a6; --line:#2f3845;
    --ok:#3ad193; --warn:#f0b354; --bad:#ff7b7b; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 system-ui, sans-serif; padding:24px 16px; }
  main { max-width:1000px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:15px; margin:24px 0 8px; }
  .dim { color:var(--dim); } a { color:inherit; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow-x:auto; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--dim); font-weight:500; font-size:12px; }
  tr:last-child td { border-bottom:0; }
  .ready, .ok { color:var(--ok); } .wait { color:var(--warn); } .bad { color:var(--bad); }
  code { background:var(--panel); border:1px solid var(--line); border-radius:4px; padding:1px 5px; }
</style>
</head>
<body>
<main>
  <h1>Gateway</h1>
  <div class="dim" id="summary">Loading...</div>
  <p class="dim">Endpoint <code id="endpoint"></code>, model <code>auto</code>. <a id="graphlink">Open the memory graph</a></p>
  <h2>Profiles, in failover order</h2>
  <div class="card"><table><thead><tr><th>Name</th><th>Provider</th><th>Model</th><th>State</th><th>Requests served</th></tr></thead>
  <tbody id="profiles"></tbody></table></div>
  <h2>Recent requests</h2>
  <div class="card"><table><thead><tr><th>Time</th><th>Asked for</th><th>Answered by</th><th>Skipped</th><th>Time to start</th></tr></thead>
  <tbody id="log"></tbody></table></div>
</main>
<script>
const key = new URLSearchParams(location.search).get("key");
document.getElementById("endpoint").textContent = location.origin + "/v1";
document.getElementById("graphlink").href = "/graph?key=" + encodeURIComponent(key);
function cell(row, text, cls) { const td = document.createElement("td"); td.textContent = text; if (cls) td.className = cls; row.append(td); }
async function refresh() {
  try {
    const data = await (await fetch("/api/status", { headers: { Authorization: "Bearer " + key } })).json();
    const ready = data.profiles.filter(p => p.state === "ready").length;
    document.getElementById("summary").textContent = (data.offline ? "Offline: only local models are used. " : "")
      + ready + " of " + data.profiles.length + " profiles ready, " + data.log.length + " recent requests";
    const profiles = document.getElementById("profiles"); profiles.textContent = "";
    data.profiles.forEach(p => { const row = profiles.insertRow();
      cell(row, p.name); cell(row, p.provider); cell(row, p.model);
      cell(row, p.state, p.state === "ready" ? "ready" : p.state.startsWith("back") ? "wait" : "bad"); cell(row, p.served); });
    if (!data.profiles.length) { const row = profiles.insertRow(); cell(row, "No profiles yet. Add them in the terminal with /add.", "dim"); }
    const log = document.getElementById("log"); log.textContent = "";
    data.log.forEach(e => { const row = log.insertRow();
      cell(row, e.time); cell(row, e.asked); cell(row, e.used, e.ok ? "ok" : "bad");
      cell(row, e.skipped.join("; ") || "-", e.skipped.length ? "wait" : "dim"); cell(row, e.ms + " ms"); });
    if (!data.log.length) { const row = log.insertRow(); cell(row, "No requests yet.", "dim"); }
  } catch (error) { document.getElementById("summary").textContent = "The gateway is not running."; }
}
refresh(); setInterval(refresh, 3000);
</script>
</body>
</html>
"""
