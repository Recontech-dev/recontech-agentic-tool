"""The window app: the same terminal, with the memory graph beside it.

A small web server that only this machine can reach serves one page, and a browser
window in app mode shows it. Nothing here is reachable from the network.
"""

import collections
import json
import os
import queue
import secrets
import shutil
import subprocess
import sys
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from rich.console import Console

from agentic_lazy_tool import config
from agentic_lazy_tool.cli import COMMANDS, App
from agentic_lazy_tool.render import ReplyRenderer
from agentic_lazy_tool.webui import PAGE

STARTUP_GRACE_SECONDS = 60
CLOSED_WINDOW_SECONDS = 15
BACKLOG_CHUNKS = 5000

BROWSERS = [
    "msedge",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "chrome",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "google-chrome",
    "chromium",
    "chromium-browser",
]


class Output:
    """The file Rich writes to; every write becomes an event for the window."""

    def __init__(self, emit):
        self.emit = emit

    def write(self, text: str) -> int:
        if text:
            self.emit({"type": "out", "text": text})
        return len(text)

    def flush(self) -> None:
        pass

    def isatty(self) -> bool:
        return True


class WebApp(App):
    def __init__(self):
        super().__init__()
        self.token = secrets.token_urlsafe(24)
        self.events: queue.Queue = queue.Queue()
        self.lines: queue.Queue = queue.Queue()
        self.answers: queue.Queue = queue.Queue()
        self.backlog = collections.deque(maxlen=BACKLOG_CHUNKS)
        self.lock = threading.Lock()
        self.cancel = threading.Event()
        self.asking = False
        self.stream_id = 0
        self.connected = False
        self.last_seen = time.time() + STARTUP_GRACE_SECONDS
        self.server = None
        self.console = Console(
            file=Output(self.emit), force_terminal=True, color_system="truecolor", width=100, legacy_windows=False
        )

    def emit(self, event: dict) -> None:
        with self.lock:
            if event["type"] == "out":
                self.backlog.append(event["text"])
            self.events.put(event)

    def state(self) -> dict:
        return {
            "type": "state",
            "status": self.toolbar(),
            "graph": self.graph_data(),
            "commands": [*COMMANDS, "/browse"],
        }

    # The window connects, reloads and closes on its own schedule.

    def connect(self) -> tuple[int, str]:
        """Register a new window connection; returns its id and everything printed so far."""
        with self.lock:
            self.stream_id += 1
            self.connected = True
            while not self.events.empty():
                self.events.get_nowait()
            return self.stream_id, "".join(self.backlog)

    def disconnect(self, stream_id: int) -> None:
        with self.lock:
            if stream_id == self.stream_id:
                self.connected = False
                self.last_seen = time.time()

    def watch(self) -> None:
        """Stop the program once the window has been closed for a while."""
        while self.connected or time.time() - self.last_seen < CLOSED_WINDOW_SECONDS:
            time.sleep(2)
        self.lines.put("/exit")

    # Replacements for the parts of the terminal that need a real keyboard or screen.

    def ask_user(self, label: str, default: str = "", secret: bool = False) -> str:
        self.asking = True
        self.emit({"type": "ask", "label": label, "default": default, "secret": secret})
        try:
            answer = self.answers.get()
        finally:
            self.asking = False
        if answer is None:
            raise KeyboardInterrupt
        return answer

    def renderer(self) -> ReplyRenderer:
        renderer = ReplyRenderer(
            self.console,
            markdown=self.cfg.get("render", True),
            preview=lambda text: self.emit({"type": "preview", "text": text}),
        )
        feed = renderer.feed

        def feed_unless_cancelled(chunk: str) -> None:
            if self.cancel.is_set():
                raise KeyboardInterrupt
            feed(chunk)

        renderer.feed = feed_unless_cancelled
        return renderer

    def show_graph(self, data: dict) -> None:
        self.say("The memory graph is on the right side of this window.")

    def cmd_browse(self, _arg: str) -> None:
        """Pick the working folder in a normal folder window."""
        try:
            import tkinter
            from tkinter import filedialog

            root = tkinter.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            folder = filedialog.askdirectory(title="Choose the folder to work in", initialdir=str(Path.cwd()))
            root.destroy()
        except Exception:  # tkinter is missing on some systems and fails without a display
            return self.error("Could not open a folder window here. Type /cd <folder> instead.")
        if folder:
            self.cmd_cd(folder)

    def request_cancel(self) -> None:
        self.cancel.set()
        if self.asking:
            self.answers.put(None)

    def work(self) -> None:
        """Run the lines the window sends, one at a time, until the user quits."""
        self.cmd_cd("")
        self.greet()
        self.emit(self.state())
        while True:
            line = self.lines.get()
            self.cancel.clear()
            try:
                keep_going = self.handle(line)
            except Exception:
                self.error(traceback.format_exc())
                keep_going = True
            self.emit(self.state())
            if not keep_going:
                break
        self.memorize()
        self.emit({"type": "bye"})
        time.sleep(0.5)
        self.server.shutdown()


def make_handler(app: WebApp):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args) -> None:
            pass

        def allowed(self) -> bool:
            # The token stops other programs and web pages on this machine from driving the
            # tool; the Host check stops a web page from reaching it through a look-alike name.
            token = parse_qs(urlparse(self.path).query).get("t", [""])[0] or self.headers.get("X-Token", "")
            port = self.server.server_port
            ok = secrets.compare_digest(token, app.token) and self.headers.get("Host") in (
                f"127.0.0.1:{port}",
                f"localhost:{port}",
            )
            if not ok:
                self.send_error(403)
            return ok

        def do_GET(self) -> None:
            if not self.allowed():
                return
            route = urlparse(self.path).path
            if route == "/":
                body = PAGE.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
            elif route == "/events":
                self.stream()
            else:
                self.send_error(404)

        def do_POST(self) -> None:
            if not self.allowed():
                return
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            route = urlparse(self.path).path
            if route == "/input":
                app.lines.put(str(body.get("text", "")))
            elif route == "/answer":
                app.answers.put(str(body.get("text", "")))
            elif route == "/cancel":
                app.request_cancel()
            elif route == "/size":
                app.console.width = max(40, min(int(body.get("columns", 100)), 240))
            else:
                return self.send_error(404)
            self.send_response(204)
            self.end_headers()

        def send_event(self, event: dict) -> None:
            self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
            self.wfile.flush()

        def stream(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            stream_id, printed = app.connect()
            try:
                self.send_event({"type": "reset", "text": printed})
                self.send_event(app.state())
                while app.stream_id == stream_id:
                    try:
                        self.send_event(app.events.get(timeout=5))
                    except queue.Empty:
                        self.wfile.write(b": still here\n\n")
                        self.wfile.flush()
            except OSError:
                pass
            finally:
                app.disconnect(stream_id)

    return Handler


def open_window(url: str) -> None:
    """Show the page in a browser window without tabs or address bar, if such a browser exists."""
    for browser in BROWSERS:
        path = browser if Path(browser).is_file() else shutil.which(browser)
        if path:
            subprocess.Popen([path, f"--app={url}", "--window-size=1400,860"])
            return
    webbrowser.open(url)


def run() -> None:
    app = WebApp()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    server.daemon_threads = True
    app.server = server
    url = f"http://127.0.0.1:{server.server_port}/?t={app.token}"
    threading.Thread(target=app.work, daemon=True).start()
    threading.Thread(target=app.watch, daemon=True).start()
    if os.environ.get("ALT_NO_WINDOW") == "1":
        print(url, flush=True)
    else:
        open_window(url)
    server.serve_forever()


def main() -> None:
    config.HOME.mkdir(parents=True, exist_ok=True)
    try:
        run()
    except Exception:
        # The packaged app has no console, so a crash would otherwise leave no trace.
        (config.HOME / "app-error.log").write_text(traceback.format_exc(), encoding="utf-8")
        raise
    os._exit(0)
