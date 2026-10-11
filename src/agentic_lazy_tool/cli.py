"""The interactive chat loop, its slash commands, and the one-shot mode."""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

from prompt_toolkit import PromptSession, prompt
from prompt_toolkit.completion import Completer, Completion, PathCompleter
from prompt_toolkit.document import Document
from prompt_toolkit.history import FileHistory
from prompt_toolkit.key_binding import KeyBindings
from rich.console import Console
from rich.table import Table
from rich.text import Text
from rich.tree import Tree

from agentic_lazy_tool import __version__, config, debate, graph, memory, net, providers, sessions, tasks
from agentic_lazy_tool.chain import Chain, NoProviderAvailable
from agentic_lazy_tool.render import ReplyRenderer

MAX_ATTACH_BYTES = 200_000
MAX_LISTED = 100
PROJECT_FILE = ".alt.json"

OPTIMIZER_PROMPT = (
    "Rewrite the user's request into a clear, specific prompt for an AI assistant that helps with software "
    "development. Keep their intent, their language and every detail they gave. State the goal, the relevant "
    "context, any constraints and the output they expect, using the project context below where it applies. "
    "Do not answer the request and do not invent requirements. Reply with the rewritten prompt only."
)
MEMORY_PROMPT = (
    "Below is a conversation about a software project. List up to 6 short notes worth remembering for future "
    "work on this project: decisions made, facts about the code or setup, the user's preferences, and tasks "
    "left unfinished. Each note must make sense on its own. Never include passwords, keys or tokens. "
    'Write one note per line, each starting with "- ". If nothing is worth keeping, reply with NONE.\n\n'
)
MEMORY_MIN_MESSAGES = 4
CONNECTION_CHECK_SECONDS = 20
RECALL_LIMIT = 3000

HELP = """\
Chat
  /new                 start a fresh conversation
  /retry               ask the last question again (use after /switch)
  /debate <question>   have several models argue it out, then give a verdict
  /prompt [name]       use a saved prompt; "/prompt add <name> <text>" saves one
  /optimize <text>     rewrite your request into a clearer prompt, then send it
  /optimize on|off     do that for every message
  /specialize on|off   detect the kind of task and instruct the model for it
  /copy [code]         copy the last reply, or only its last code block
  /resume [number]     reopen the latest saved conversation, or one from /sessions
  /sessions            list saved conversations

Project files
  /cd [folder]         show or set the folder you are working in
  /ls [pattern]        list files in the working folder
  /file <path|glob>    attach text files to your next message
  /project [init]      show this folder's project settings, or create the file

Memory
  /remember <fact>     keep a note about this project for future sessions
  /memory              show the memory tree and which notes are loaded now
  /memory graph        open the memory network as a picture in your browser
  /memory save         turn this conversation into notes now
  /memory forget <n>   delete one of this project's notes
  /memory auto on|off  save notes automatically when a conversation ends
  /recall <words>      search the notes of every project

Profiles
  /add                 add a profile (provider, name, model, API key)
  /remove <name>       delete a profile and its saved key
  /profiles            list profiles in chain order with their status
  /test                send a tiny request to every profile to check it works
  /chain <names...>    set the failover order, first name is tried first
  /switch <name|auto>  pin one profile for this session, or go back to the chain
  /model <name> <id>   change the model a profile uses
  /key <name>          replace a profile's API key
  /workspace <name> [id]  set or clear the Anthropic workspace ID of a Claude profile

Other
  /context             show everything that is loaded for the model right now
  /offline [on|off|auto]  work without internet: local models and stored memory only
  /system [text]       show or set the system prompt
  /render [on|off]     show replies as formatted Markdown, or as plain text
  /exit                quit

Esc then Enter adds a new line. Ctrl+C cancels a reply."""

COMMANDS = re.findall(r"^  (/\w+)", HELP, re.MULTILINE) + ["/help"]
PROFILE_COMMANDS = ("/remove ", "/switch ", "/model ", "/key ", "/chain ")


def copy_to_clipboard(text: str) -> None:
    if sys.platform == "win32":
        command, data = ["clip"], text.encode("utf-16")
    elif sys.platform == "darwin":
        command, data = ["pbcopy"], text.encode()
    else:
        command = ["wl-copy"] if shutil.which("wl-copy") else ["xclip", "-selection", "clipboard"]
        data = text.encode()
    subprocess.run(command, input=data, check=True)


class CommandCompleter(Completer):
    def __init__(self, app: "App"):
        self.app = app
        self.files = PathCompleter(expanduser=True)
        self.folders = PathCompleter(expanduser=True, only_directories=True)

    def get_completions(self, document, complete_event):
        text = document.text_before_cursor
        for command, paths in (("/file ", self.files), ("/cd ", self.folders)):
            if text.startswith(command):
                yield from paths.get_completions(Document(text[len(command):]), complete_event)
                return
        if text.startswith(PROFILE_COMMANDS):
            word = text.split(" ")[-1]
            for profile in self.app.chain.profiles:
                if profile["name"].startswith(word):
                    yield Completion(profile["name"], start_position=-len(word))
        elif text.startswith("/") and " " not in text:
            for command in COMMANDS:
                if command.startswith(text):
                    yield Completion(command, start_position=-len(text))


class App:
    def __init__(self):
        self.console = Console()
        self.cfg = config.load()
        self.chain = Chain(self.cfg)
        self.history: list[dict] = []
        self.attachments: list[str] = []
        self.project = {"system": "", "files": []}
        self.memory = ""
        self.memorized = 0
        self.connection_checked = 0.0
        self.session_id = sessions.new_id()

    def say(self, message: str, style: str = "") -> None:
        # Provider error text can contain square brackets, which Rich would read as markup.
        self.console.print(Text(message, style=style))

    def notify(self, message: str) -> None:
        self.say("\n" + message, "yellow")

    def error(self, message: str) -> None:
        self.say(message, "red")

    def system_prompt(self, instruction: str = "") -> str:
        return "\n\n".join(filter(None, [self.cfg["system"], self.project["system"], self.memory, instruction]))

    def ask_user(self, label: str, default: str = "", secret: bool = False) -> str:
        """Ask the user for one value. The window app replaces this with its own input."""
        return prompt(label, default=default, is_password=secret)

    def renderer(self) -> ReplyRenderer:
        return ReplyRenderer(self.console, markdown=self.cfg.get("render", True))

    def read_files(self, paths: list[Path]) -> list[str]:
        attachments = []
        for path in paths:
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                self.error(f"Skipped {path.name}: not a readable text file.")
                continue
            attachments.append(f"File: {path}\n```\n{text}\n```")
        return attachments

    def attach(self, paths: list[Path]) -> int:
        """Queue files for the next message. Nothing is added if the size limit would be passed."""
        attachments = self.read_files(paths)
        if sum(len(a.encode()) for a in [*self.attachments, *attachments]) > MAX_ATTACH_BYTES:
            self.error(f"That would attach more than {MAX_ATTACH_BYTES // 1000} KB. Nothing was added.")
            return 0
        self.attachments += attachments
        return len(attachments)

    def load_project(self, announce: bool = True) -> None:
        self.project = {"system": "", "files": []}
        path = Path.cwd() / PROJECT_FILE
        if not path.is_file():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            self.project = {"system": str(data.get("system", "")), "files": [str(f) for f in data.get("files", [])]}
        except (ValueError, OSError, AttributeError):
            return self.error(f"{PROJECT_FILE} could not be read; ignoring it.")
        if announce:
            self.say(f"Project settings loaded from {PROJECT_FILE}.", "dim")

    def load_memory(self, announce: bool = True) -> None:
        self.memory = memory.context(Path.cwd())
        count = len(memory.notes(Path.cwd()))
        if announce and count:
            self.say(f"Remembering {count} note(s) about this project. See /memory.", "dim")

    def memorize(self, force: bool = False) -> None:
        """Turn the part of the conversation not yet remembered into notes for this project."""
        fresh = self.history[self.memorized:]
        if not force and (not self.cfg.get("auto_memory", True) or len(fresh) < MEMORY_MIN_MESSAGES):
            return
        if not fresh:
            return self.say("Nothing new in this conversation to remember.")
        transcript = "\n\n".join(f"{m['role'].upper()}: {m['content'][:2000]}" for m in fresh)[-24000:]
        self.say("Saving what is worth remembering (Ctrl+C to skip)...", "dim")
        try:
            _, reply = self.chain.ask([{"role": "user", "content": MEMORY_PROMPT + transcript}])
        except (NoProviderAvailable, KeyboardInterrupt):
            return self.say("Skipped. The full conversation is still saved; see /sessions.", "dim")
        notes = [line[2:].strip() for line in reply.splitlines() if line.startswith("- ") and line[2:].strip()]
        for note in notes[:6]:
            memory.add(Path.cwd(), note, f"session:{self.session_id}")
        self.memorized = len(self.history)
        self.load_memory(announce=False)
        self.say(f"Remembered {len(notes[:6])} note(s) for this project." if notes else "Nothing new to remember.", "dim")

    def optimized(self, text: str) -> str:
        context = self.system_prompt()
        system = OPTIMIZER_PROMPT + (f"\n\nProject context:\n{context}" if context else "")
        try:
            _, better = self.chain.ask([{"role": "user", "content": text}], system=system, notify=self.notify)
        except (NoProviderAvailable, KeyboardInterrupt):
            return text
        if not better.strip():
            return text
        self.say("Optimized prompt:", "dim")
        self.say(better.strip(), "dim")
        return better.strip()

    def check_connection(self, force: bool = False) -> None:
        """Switch offline mode on or off to match the setting or the actual connection."""
        mode = self.cfg.get("offline", "auto")
        if mode == "auto":
            if not force and time.time() - self.connection_checked < CONNECTION_CHECK_SECONDS:
                return
            self.connection_checked = time.time()
            offline = not net.online()
        else:
            offline = mode == "on"
        if offline != self.chain.offline:
            self.chain.offline = offline
            if offline:
                self.say("Offline: using local models and your stored memory only.", "yellow")
            else:
                self.say("Online again: every profile is available.", "yellow")

    def recalled(self, question: str) -> str:
        """Stored notes and past exchanges about the question, as extra context for a local model."""
        lines = [
            f"- Note from project {project}: {note['text']}"
            for project, note in memory.search(question, limit=5)
            if note["text"] not in self.memory
        ]
        for past in sessions.search(question, exclude=self.session_id):
            lines.append(f"- Earlier the user asked: {past['question'][:300]}\n  The answer was: {past['reply'][:800]}")
        if not lines:
            return ""
        return ("Possibly relevant, from the user's stored memory and past conversations:\n" + "\n".join(lines))[:RECALL_LIMIT]

    def answer_from_memory(self, question: str) -> None:
        """With no model reachable, show what is already stored about the question."""
        notes = memory.search(question, limit=5)
        past = sessions.search(question, exclude=self.session_id)
        if not notes and not past:
            return self.say("Nothing in your stored memory matches this question either.", "dim")
        view = Tree(Text("From your stored memory (saved notes and past answers, not a new answer)", style="bold"))
        if notes:
            branch = view.add(Text("Notes", style="bold"))
            for project, note in notes:
                branch.add(Text(f"{project} ({note['time'][:10]}): {note['text']}"))
        if past:
            branch = view.add(Text("Past conversations", style="bold"))
            for exchange in past:
                item = branch.add(Text(f"You asked: {exchange['question'][:200]}", style="cyan"))
                reply = exchange["reply"]
                item.add(Text(reply[:600] + (" ..." if len(reply) > 600 else "")))
        self.console.print(view)

    def submit(self, text: str, optimize: bool | None = None) -> None:
        """Send what the user typed, after the optional prompt rewrite and task detection."""
        self.check_connection()
        if self.cfg.get("optimize", False) if optimize is None else optimize:
            text = self.optimized(text)
        task = tasks.detect(text) if self.cfg.get("specialize", True) else None
        if task:
            self.say(f"task: {task.name}", "dim")
        instruction = task.instruction if task else ""
        if self.chain.offline:
            # A local model knows less than a cloud one, so it gets more of the stored memory.
            instruction = "\n\n".join(filter(None, [instruction, self.recalled(text)]))
        self.send(self.take_message(text), instruction, question=text)

    def project_files(self) -> list[Path]:
        # The settings file comes with the project, which may be someone else's repository,
        # so it may only name files inside the project folder.
        root = Path.cwd().resolve()
        found = []
        for pattern in self.project["files"]:
            try:
                matches = sorted(p for p in root.glob(pattern) if p.is_file())
            except (ValueError, NotImplementedError):
                continue
            found += [p for p in matches if p.resolve().is_relative_to(root)]
        return found

    def take_message(self, text: str) -> str:
        if not self.history and self.project["files"]:
            self.attach(self.project_files())
        content = "\n\n".join([*self.attachments, text])
        self.attachments = []
        return content

    def send(self, content: str, instruction: str = "", question: str = "") -> None:
        self.history.append({"role": "user", "content": content})
        renderer = self.renderer()
        try:
            _, reply = self.chain.ask(
                self.history,
                system=self.system_prompt(instruction),
                on_start=renderer.start,
                on_text=renderer.feed,
                notify=self.notify,
            )
        except NoProviderAvailable as unavailable:
            self.history.pop()
            self.error(str(unavailable))
            self.answer_from_memory(question or content[-500:])
            return
        except KeyboardInterrupt:
            self.history.pop()
            renderer.close()
            self.say("cancelled", "dim")
            return
        finally:
            renderer.close()
        self.history.append({"role": "assistant", "content": reply})
        sessions.save(self.session_id, self.history)

    def last_reply(self) -> str | None:
        return next((m["content"] for m in reversed(self.history) if m["role"] == "assistant"), None)

    # Chat

    def cmd_new(self, _arg: str) -> None:
        self.memorize()
        self.history = []
        self.memorized = 0
        self.attachments = []
        self.session_id = sessions.new_id()
        self.say("Started a new conversation.")

    def cmd_retry(self, _arg: str) -> None:
        if len(self.history) < 2:
            return self.error("Nothing to retry yet.")
        self.history.pop()
        self.send(self.history.pop()["content"])

    def cmd_debate(self, question: str) -> None:
        if not question:
            return self.error("Usage: /debate <question>")
        content = self.take_message(question)
        try:
            verdict = debate.run(self.chain, content, self.console, self.notify, self.renderer())
        except NoProviderAvailable as unavailable:
            return self.error(str(unavailable))
        except KeyboardInterrupt:
            return self.say("\ncancelled", "dim")
        self.history += [{"role": "user", "content": content}, {"role": "assistant", "content": verdict}]
        sessions.save(self.session_id, self.history)

    def cmd_prompt(self, arg: str) -> None:
        saved = self.cfg.setdefault("prompts", {})
        action, _, rest = arg.partition(" ")
        if not arg:
            if not saved:
                return self.say('No saved prompts. Save one with "/prompt add <name> <text>".')
            for name, text in saved.items():
                self.say(f"{name}: {text}")
        elif action == "add":
            name, _, text = rest.partition(" ")
            if not text.strip() or name in ("add", "remove"):
                return self.error("Usage: /prompt add <name> <text>")
            saved[name] = text.strip()
            config.save(self.cfg)
            self.say(f"Saved. Use it with /prompt {name}")
        elif action == "remove":
            if saved.pop(rest, None) is None:
                return self.error("No saved prompt with that name.")
            config.save(self.cfg)
            self.say(f"Removed {rest}.")
        elif action in saved:
            self.submit(" ".join(filter(None, [saved[action], rest])))
        else:
            self.error("No saved prompt with that name. See /prompt.")

    def cmd_optimize(self, arg: str) -> None:
        if arg in ("on", "off"):
            self.cfg["optimize"] = arg == "on"
            config.save(self.cfg)
        if arg in ("on", "off", ""):
            state = "on" if self.cfg.get("optimize", False) else "off"
            return self.say(f"Rewriting every message into a clearer prompt is {state}. It costs one extra request each.")
        self.submit(arg, optimize=True)

    def cmd_specialize(self, arg: str) -> None:
        if arg in ("on", "off"):
            self.cfg["specialize"] = arg == "on"
            config.save(self.cfg)
        self.say("Task detection is " + ("on." if self.cfg.get("specialize", True) else "off."))

    def cmd_remember(self, fact: str) -> None:
        if not fact:
            return self.error("Usage: /remember <fact>")
        stored = memory.add(Path.cwd(), fact, "manual")
        self.load_memory(announce=False)
        self.say(f"Remembered: {stored}")

    def cmd_memory(self, arg: str) -> None:
        action, _, rest = arg.partition(" ")
        if action == "save":
            return self.memorize(force=True)
        if action == "auto":
            if rest in ("on", "off"):
                self.cfg["auto_memory"] = rest == "on"
                config.save(self.cfg)
            return self.say("Automatic memory is " + ("on." if self.cfg.get("auto_memory", True) else "off."))
        if action == "forget":
            removed = memory.remove(Path.cwd(), int(rest)) if rest.isdigit() else None
            if not removed:
                return self.error("Usage: /memory forget <note number>")
            self.load_memory(announce=False)
            return self.say(f"Forgot: {removed['text']}")
        projects = memory.tree()
        if not projects:
            return self.say("Nothing remembered yet. Notes are saved when a conversation ends, or with /remember.")
        current = str(Path.cwd().resolve())
        loaded = len(memory.loaded(Path.cwd()))
        if action == "graph":
            return self.show_graph(graph.build(projects, current, loaded))
        view = Tree(Text("Memory", style="bold"))
        for project in projects:
            notes = project["notes"]
            is_current = project["folder"] == current
            label = Text(f"{project['name']}  {len(notes)} notes  {project['folder']}", style="bold cyan" if is_current else "")
            if is_current:
                label.append("  (open now)", style="green")
            branch = view.add(label)
            # The open project is listed in full; the others show their three newest notes.
            first_shown = 0 if is_current else max(len(notes) - 3, 0)
            if first_shown:
                branch.add(Text(f"... {first_shown} older notes", style="dim"))
            for index in range(first_shown, len(notes)):
                in_context = is_current and index >= len(notes) - loaded
                line = Text("● " if in_context else "○ ", style="green" if in_context else "dim")
                line.append(f"{index + 1}. ({notes[index]['time'][:10]}) {notes[index]['text']}", style="" if in_context else "dim")
                branch.add(line)
        shared = memory.topics(projects)[:8]
        if shared:
            branch = view.add(Text("Shared topics", style="bold"))
            for word, references in shared:
                in_projects = len({p for p, _ in references})
                branch.add(Text(f"{word}  {len(references)} notes in {in_projects} project(s)", style="yellow"))
        self.console.print(view)
        self.say("● given to the model in this session   ○ stored only   /memory graph for the picture", "dim")

    def show_graph(self, data: dict) -> None:
        path = config.HOME / "memory-map.html"
        graph.write_html(path, data)
        webbrowser.open(path.as_uri())
        self.say(f"Opened {path}")

    def graph_data(self) -> dict:
        return graph.build(memory.tree(), str(Path.cwd().resolve()), len(memory.loaded(Path.cwd())))

    def cmd_recall(self, query: str) -> None:
        if not query:
            return self.error("Usage: /recall <words>")
        matches = memory.search(query)
        if not matches:
            return self.say("No notes match.")
        for project, note in matches:
            self.say(f"{project} ({note['time'][:10]}): {note['text']}")

    def cmd_copy(self, what: str) -> None:
        reply = self.last_reply()
        if not reply:
            return self.error("No reply to copy yet.")
        if what == "code":
            blocks = re.findall(r"```[^\n]*\n(.*?)```", reply, re.DOTALL)
            if not blocks:
                return self.error("The last reply has no code block.")
            reply = blocks[-1]
        try:
            copy_to_clipboard(reply)
        except (OSError, subprocess.CalledProcessError):
            return self.error("Could not reach the clipboard.")
        self.say(f"Copied {len(reply)} characters.")

    def cmd_sessions(self, _arg: str) -> None:
        saved = sessions.recent()
        if not saved:
            return self.say("No saved conversations yet.")
        table = Table()
        for column in ("#", "When", "Folder", "First message"):
            table.add_column(column)
        for index, entry in enumerate(saved, 1):
            table.add_row(str(index), entry["id"], entry["folder"], Text(entry["title"]))
        self.console.print(table)

    def cmd_resume(self, number: str) -> None:
        saved = sessions.recent()
        index = int(number) - 1 if number.isdigit() else 0
        if not 0 <= index < len(saved):
            return self.error("No saved conversation with that number. See /sessions.")
        self.memorize()
        entry = saved[index]
        self.history = entry["messages"]
        self.memorized = len(self.history)
        self.session_id = entry["id"]
        self.say(f"Resumed {len(self.history) // 2} exchanges: {entry['title']}")

    # Project files

    def cmd_cd(self, arg: str) -> None:
        if arg:
            folder = Path(arg.strip('"')).expanduser()
            if not folder.is_dir():
                return self.error("Folder not found.")
            self.memorize()
            os.chdir(folder)
        self.say(f"Working folder: {Path.cwd()}")
        self.load_project()
        self.load_memory()

    def cmd_project(self, arg: str) -> None:
        path = Path.cwd() / PROJECT_FILE
        if arg == "init":
            if path.exists():
                return self.error(f"{PROJECT_FILE} already exists.")
            path.write_text(json.dumps({"system": "", "files": []}, indent=2) + "\n", encoding="utf-8")
            return self.say(f"Created {path}. Edit it, then run /cd to reload.")
        if not path.is_file():
            return self.say(f"No {PROJECT_FILE} in this folder. Create one with /project init.")
        self.say(f"System prompt: {self.project['system'] or '(none)'}")
        files = [p.relative_to(Path.cwd().resolve()).as_posix() for p in self.project_files()]
        self.say("Attached to the first message of each conversation: " + (", ".join(files) or "(none)"))

    def cmd_ls(self, pattern: str) -> None:
        entries = sorted(Path.cwd().glob(pattern or "*"), key=lambda p: (p.is_file(), p.name.lower()))
        for entry in entries[:MAX_LISTED]:
            name = entry.relative_to(Path.cwd()).as_posix()
            self.say(name + "/" if entry.is_dir() else name, "cyan" if entry.is_dir() else "")
        if len(entries) > MAX_LISTED:
            self.say(f"... and {len(entries) - MAX_LISTED} more", "dim")
        if not entries:
            self.say("Nothing matches.", "dim")

    def cmd_file(self, arg: str) -> None:
        arg = arg.strip('"')
        if not arg:
            return self.error("Usage: /file <path or glob>")
        if any(char in arg for char in "*?["):
            paths = sorted(p for p in Path.cwd().glob(arg) if p.is_file())
        else:
            paths = [Path(arg).expanduser()]
        if not paths or not all(p.is_file() for p in paths):
            return self.error("File not found.")
        count = self.attach(paths)
        if count:
            self.say(f"Attached {count} file(s); they go with your next message.")

    # Profiles

    def cmd_add(self, _arg: str) -> None:
        provider = self.ask_user(f"Provider ({', '.join(providers.PRESETS)}): ").strip().lower()
        preset = providers.PRESETS.get(provider)
        if not preset:
            return self.error("Unknown provider.")
        claude_count = sum(p["provider"] == "claude" for p in self.chain.profiles)
        if provider == "claude" and claude_count >= config.MAX_CLAUDE_PROFILES:
            return self.error(f"You already have {config.MAX_CLAUDE_PROFILES} Claude profiles.")
        name = self.ask_user("Profile name: ", default=provider).strip()
        if not name or " " in name or self.chain.find(name):
            return self.error("The name must be one word that is not already in use.")
        base_url = preset["base_url"]
        if provider == "custom":
            base_url = self.ask_user("Base URL of the OpenAI-compatible API: ").strip()
        model = self.ask_user("Model: ", default=preset["model"]).strip()
        if not model:
            return self.error("No model entered.")
        if preset["key_url"]:
            self.say(f"Get it at {preset['key_url']}", "dim")
        key = ""
        if preset["needs_key"] or provider == "custom":
            key = self.ask_user("API key (leave empty if none is needed): ", secret=True).strip()
            if not key and preset["needs_key"]:
                return self.error("No key entered.")
        if key:
            config.set_key(name, key)
        profile = {"name": name, "provider": provider, "model": model, "base_url": base_url}
        self.chain.profiles.append(profile)
        config.save(self.cfg)
        self.say(f"Added {name} at the end of the chain. Run /test to check it.")

    def cmd_remove(self, name: str) -> None:
        profile = self.chain.find(name)
        if not profile:
            return self.error("No profile with that name.")
        self.chain.profiles.remove(profile)
        config.delete_key(name)
        config.save(self.cfg)
        if self.chain.pinned == name:
            self.chain.pinned = None
        self.say(f"Removed {name}.")

    def cmd_profiles(self, _arg: str) -> None:
        if not self.chain.profiles:
            return self.say("No profiles yet. Add one with /add.")
        table = Table()
        for column in ("#", "Name", "Provider", "Model", "Status", "Replies"):
            table.add_column(column)
        for index, profile in enumerate(self.chain.profiles, 1):
            replies = str(self.chain.replies.get(profile["name"], 0))
            wait = self.chain.cooldown_left(profile["name"])
            if not self.chain.has_key(profile):
                status = "[red]no key[/red]"
            elif wait:
                status = f"[yellow]back in {wait:.0f}s[/yellow]"
            else:
                status = "[green]ready[/green]"
            if self.chain.pinned == profile["name"]:
                status += " (pinned)"
            table.add_row(str(index), profile["name"], profile["provider"], profile["model"], status, replies)
        self.console.print(table)

    def cmd_test(self, _arg: str) -> None:
        question = [{"role": "user", "content": "Reply with the single word OK."}]
        for profile in self.chain.profiles:
            name = profile["name"]
            if not self.chain.has_key(profile):
                self.say(f"{name}: no key saved", "red")
                continue
            try:
                reply = "".join(providers.stream_reply(profile, config.get_key(name), question))
            except providers.ProviderFailure as failure:
                self.say(f"{name}: {failure.reason}", "red")
            else:
                self.say(f"{name}: working ({reply.strip()[:30]})", "green")

    def cmd_chain(self, arg: str) -> None:
        names = arg.split()
        if sorted(names) != sorted(p["name"] for p in self.chain.profiles):
            return self.error("List every profile name exactly once, in the order you want.")
        self.chain.profiles.sort(key=lambda p: names.index(p["name"]))
        config.save(self.cfg)
        self.say("Chain: " + " → ".join(names))

    def cmd_switch(self, name: str) -> None:
        if name == "auto":
            self.chain.pinned = None
            return self.say("Back to the chain order.")
        if not self.chain.find(name):
            return self.error("No profile with that name.")
        self.chain.pinned = name
        self.say(f"{name} goes first for this session; the rest still back it up.")

    def cmd_model(self, arg: str) -> None:
        name, _, model = arg.partition(" ")
        profile = self.chain.find(name)
        if not profile or not model.strip():
            return self.error("Usage: /model <profile name> <model id>")
        profile["model"] = model.strip()
        config.save(self.cfg)
        self.say(f"{name} now uses {profile['model']}.")

    def cmd_workspace(self, arg: str) -> None:
        name, _, workspace = arg.partition(" ")
        profile = self.chain.find(name)
        if not profile or profile["provider"] != "claude":
            return self.error("Usage: /workspace <Claude profile name> [workspace id]")
        if workspace.strip():
            profile["workspace"] = workspace.strip()
        else:
            profile.pop("workspace", None)
        config.save(self.cfg)
        self.chain.cooldowns.pop(name, None)
        self.say(f"{name} workspace: {profile.get('workspace', '(none)')}. Run /test to check it.")

    def cmd_key(self, name: str) -> None:
        if not self.chain.find(name):
            return self.error("No profile with that name.")
        key = self.ask_user("New API key: ", secret=True).strip()
        if not key:
            return self.error("No key entered.")
        config.set_key(name, key)
        self.chain.cooldowns.pop(name, None)
        self.say(f"Saved a new key for {name}.")

    # Other

    def cmd_context(self, _arg: str) -> None:
        def tokens(text: str) -> str:
            return f"about {len(text) // 4:,} tokens"

        loaded = memory.loaded(Path.cwd())
        history = "".join(m["content"] for m in self.history)
        view = Tree(Text("Loaded for the model right now", style="bold"))
        view.add(Text(f"Working folder: {Path.cwd()}"))
        view.add(Text("Answers next: " + self.toolbar().split("next: ")[1].split("  |")[0]))
        view.add(Text(f"Your system prompt: {self.cfg['system'] or '(none)'}"))
        project = view.add(Text(f"Project settings ({PROJECT_FILE}): " + (self.project["system"] or "(no system prompt)")))
        for path in self.project_files():
            project.add(Text(f"attached to each new conversation: {path.name}", style="dim"))
        notes = view.add(Text(f"Memory: {len(loaded)} of {len(memory.notes(Path.cwd()))} notes ({tokens(self.memory)})"))
        for note in loaded:
            notes.add(Text(f"({note['time'][:10]}) {note['text']}", style="dim"))
        queued = view.add(Text(f"Files waiting for your next message: {len(self.attachments)} ({tokens(''.join(self.attachments))})"))
        for attachment in self.attachments:
            queued.add(Text(attachment.splitlines()[0].removeprefix("File: "), style="dim"))
        view.add(Text(f"Conversation: {len(self.history) // 2} exchanges ({tokens(history)})"))
        self.console.print(view)
        total = self.system_prompt() + history + "".join(self.attachments)
        self.say(f"Your next message will send {tokens(total)} plus what you type.", "dim")

    def cmd_offline(self, arg: str) -> None:
        if arg in ("on", "off", "auto"):
            self.cfg["offline"] = arg
            config.save(self.cfg)
        self.check_connection(force=True)
        mode = self.cfg.get("offline", "auto")
        state = "offline" if self.chain.offline else "online"
        local = [p["name"] for p in self.chain.profiles if providers.is_local(p)]
        self.say(f"Offline setting: {mode}. Right now: {state}.")
        self.say("Local models that work offline: " + (", ".join(local) or "none (install Ollama, then /add ollama)"))

    def cmd_system(self, text: str) -> None:
        if text:
            self.cfg["system"] = text
            config.save(self.cfg)
        self.say(self.cfg["system"] or "No system prompt set.")

    def cmd_render(self, arg: str) -> None:
        if arg in ("on", "off"):
            self.cfg["render"] = arg == "on"
            config.save(self.cfg)
        self.say("Replies are shown as " + ("formatted Markdown." if self.cfg.get("render", True) else "plain text."))

    def cmd_help(self, _arg: str) -> None:
        self.say(HELP)

    def toolbar(self) -> str:
        ready = self.chain.ready()
        if self.chain.pinned and self.chain.cooldown_left(self.chain.pinned) == 0:
            active = self.chain.pinned + " (pinned)"
        else:
            active = ready[0]["name"] if ready else "no profile ready"
        parts = [str(Path.cwd()), f"next: {active}", f"{len(self.history) // 2} exchanges"]
        if self.chain.offline:
            parts.insert(0, "OFFLINE")
        if self.memory:
            parts.append(f"{self.memory.count(chr(10))} notes")
        if self.attachments:
            parts.append(f"{len(self.attachments)} attached")
        return "  |  ".join(parts)

    def greet(self) -> None:
        self.console.print("[bold]Agentic Lazy Tool[/bold]  /help for commands")
        self.check_connection()
        repo = config.home_git_repo()
        if repo:
            self.error(
                f"Warning: your data folder {config.HOME} is inside the git repository {repo}. "
                "Conversations and memory could be committed. Move it by setting ALT_HOME."
            )
        if not self.chain.profiles:
            self.say("No profiles yet. Add one with /add.")

    def handle(self, line: str) -> bool:
        """Run one line the user entered. Returns False when they asked to quit."""
        line = line.strip()
        if not line:
            return True
        if not line.startswith("/"):
            self.submit(line)
            return True
        command, _, arg = line[1:].partition(" ")
        if command in ("exit", "quit"):
            return False
        handler = getattr(self, f"cmd_{command}", None)
        if not handler:
            self.error("Unknown command. Try /help.")
            return True
        try:
            handler(arg.strip())
        except (EOFError, KeyboardInterrupt):
            self.say("cancelled", "dim")
        return True

    def run(self) -> None:
        config.HOME.mkdir(parents=True, exist_ok=True)
        keys = KeyBindings()

        @keys.add("escape", "enter")
        def _(event):
            event.current_buffer.insert_text("\n")

        session = PromptSession(
            history=FileHistory(str(config.HOME / "history")),
            completer=CommandCompleter(self),
            complete_while_typing=True,
            bottom_toolbar=self.toolbar,
            key_bindings=keys,
        )
        self.greet()
        while True:
            try:
                line = session.prompt("you> ")
            except (EOFError, KeyboardInterrupt):
                break
            if not self.handle(line):
                break
        self.memorize()

    def one_shot(self, question: str) -> int:
        """Answer one question on stdout and exit, for use in scripts and pipes."""
        if not sys.stdin.isatty():
            piped = sys.stdin.read()
            if piped.strip():
                self.attachments.append(f"Input:\n```\n{piped}\n```")
        sys.stdout.reconfigure(errors="replace")
        self.load_project(announce=False)
        self.load_memory(announce=False)
        if self.cfg.get("offline", "auto") != "off":
            self.chain.offline = self.cfg.get("offline") == "on" or not net.online()

        def write(chunk: str) -> None:
            sys.stdout.write(chunk)
            sys.stdout.flush()

        try:
            self.chain.ask(
                [{"role": "user", "content": self.take_message(question)}],
                system=self.system_prompt(),
                on_text=write,
                notify=lambda message: print(message, file=sys.stderr),
            )
        except NoProviderAvailable as unavailable:
            print(unavailable, file=sys.stderr)
            return 1
        print()
        return 0


def main() -> None:
    parser = argparse.ArgumentParser(prog="alt", description="Chat terminal with automatic AI failover.")
    parser.add_argument("folder", nargs="?", help="folder to work in")
    parser.add_argument("-p", "--prompt", help="answer one question and exit; piped input is attached")
    parser.add_argument("--app", action="store_true", help="open the window app: terminal with the memory graph beside it")
    parser.add_argument("--version", action="version", version=__version__)
    args = parser.parse_args()

    if args.folder:
        if not Path(args.folder).expanduser().is_dir():
            parser.error(f"folder not found: {args.folder}")
        os.chdir(Path(args.folder).expanduser())
    if args.app:
        from agentic_lazy_tool import webapp

        return webapp.main()
    app = App()
    if args.prompt:
        sys.exit(app.one_shot(args.prompt))
    app.cmd_cd("")
    app.run()
