"""The interactive chat loop, its slash commands, and the one-shot mode."""

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from prompt_toolkit import PromptSession, prompt
from prompt_toolkit.completion import Completer, Completion, PathCompleter
from prompt_toolkit.document import Document
from prompt_toolkit.history import FileHistory
from prompt_toolkit.key_binding import KeyBindings
from rich.console import Console
from rich.table import Table
from rich.text import Text

from agentic_lazy_tool import __version__, config, debate, providers, sessions
from agentic_lazy_tool.chain import Chain, NoProviderAvailable

MAX_ATTACH_BYTES = 200_000
MAX_LISTED = 100

HELP = """\
Chat
  /new                 start a fresh conversation
  /retry               ask the last question again (use after /switch)
  /debate <question>   have several models argue it out, then give a verdict
  /copy [code]         copy the last reply, or only its last code block
  /resume [number]     reopen the latest saved conversation, or one from /sessions
  /sessions            list saved conversations

Project files
  /cd [folder]         show or set the folder you are working in
  /ls [pattern]        list files in the working folder
  /file <path|glob>    attach text files to your next message

Profiles
  /add                 add a profile (provider, name, model, API key)
  /remove <name>       delete a profile and its saved key
  /profiles            list profiles in chain order with their status
  /test                send a tiny request to every profile to check it works
  /chain <names...>    set the failover order, first name is tried first
  /switch <name|auto>  pin one profile for this session, or go back to the chain
  /model <name> <id>   change the model a profile uses
  /key <name>          replace a profile's API key

Other
  /system [text]       show or set the system prompt
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
        self.session_id = sessions.new_id()

    def say(self, message: str, style: str = "") -> None:
        # Provider error text can contain square brackets, which Rich would read as markup.
        self.console.print(Text(message, style=style))

    def notify(self, message: str) -> None:
        self.say("\n" + message, "yellow")

    def error(self, message: str) -> None:
        self.say(message, "red")

    def take_message(self, text: str) -> str:
        content = "\n\n".join([*self.attachments, text])
        self.attachments = []
        return content

    def send(self, content: str) -> None:
        self.history.append({"role": "user", "content": content})
        try:
            _, reply = self.chain.ask(
                self.history,
                system=self.cfg["system"],
                on_start=lambda name: self.console.print(f"[cyan]{name}>[/cyan] ", end=""),
                on_text=lambda chunk: self.console.print(chunk, end="", markup=False, highlight=False),
                notify=self.notify,
            )
        except NoProviderAvailable as unavailable:
            self.history.pop()
            self.error(str(unavailable))
            return
        except KeyboardInterrupt:
            self.history.pop()
            self.say("\ncancelled", "dim")
            return
        self.console.print()
        self.history.append({"role": "assistant", "content": reply})
        sessions.save(self.session_id, self.history)

    def last_reply(self) -> str | None:
        return next((m["content"] for m in reversed(self.history) if m["role"] == "assistant"), None)

    # Chat

    def cmd_new(self, _arg: str) -> None:
        self.history = []
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
            verdict = debate.run(self.chain, content, self.console, self.notify)
        except NoProviderAvailable as unavailable:
            return self.error(str(unavailable))
        except KeyboardInterrupt:
            return self.say("\ncancelled", "dim")
        self.history += [{"role": "user", "content": content}, {"role": "assistant", "content": verdict}]
        sessions.save(self.session_id, self.history)

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
        entry = saved[index]
        self.history = entry["messages"]
        self.session_id = entry["id"]
        self.say(f"Resumed {len(self.history) // 2} exchanges: {entry['title']}")

    # Project files

    def cmd_cd(self, arg: str) -> None:
        if arg:
            folder = Path(arg.strip('"')).expanduser()
            if not folder.is_dir():
                return self.error("Folder not found.")
            os.chdir(folder)
        self.say(f"Working folder: {Path.cwd()}")

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
        attached = []
        for path in paths:
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                self.error(f"Skipped {path.name}: not a text file.")
                continue
            attached.append(f"File: {path}\n```\n{text}\n```")
        size = sum(len(a.encode()) for a in [*self.attachments, *attached])
        if size > MAX_ATTACH_BYTES:
            return self.error(f"That would attach more than {MAX_ATTACH_BYTES // 1000} KB. Nothing was added.")
        self.attachments += attached
        self.say(f"Attached {len(attached)} file(s); they go with your next message.")

    # Profiles

    def cmd_add(self, _arg: str) -> None:
        provider = prompt(f"Provider ({', '.join(providers.PRESETS)}): ").strip().lower()
        preset = providers.PRESETS.get(provider)
        if not preset:
            return self.error("Unknown provider.")
        claude_count = sum(p["provider"] == "claude" for p in self.chain.profiles)
        if provider == "claude" and claude_count >= config.MAX_CLAUDE_PROFILES:
            return self.error(f"You already have {config.MAX_CLAUDE_PROFILES} Claude profiles.")
        name = prompt("Profile name: ", default=provider).strip()
        if not name or " " in name or self.chain.find(name):
            return self.error("The name must be one word that is not already in use.")
        base_url = preset["base_url"]
        if provider == "custom":
            base_url = prompt("Base URL of the OpenAI-compatible API: ").strip()
        model = prompt("Model: ", default=preset["model"]).strip()
        if not model:
            return self.error("No model entered.")
        if preset["key_url"]:
            self.say(f"Get it at {preset['key_url']}", "dim")
        key = ""
        if preset["needs_key"] or provider == "custom":
            key = prompt("API key (leave empty if none is needed): ", is_password=True).strip()
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
        for column in ("#", "Name", "Provider", "Model", "Status"):
            table.add_column(column)
        for index, profile in enumerate(self.chain.profiles, 1):
            wait = self.chain.cooldown_left(profile["name"])
            if not self.chain.has_key(profile):
                status = "[red]no key[/red]"
            elif wait:
                status = f"[yellow]back in {wait:.0f}s[/yellow]"
            else:
                status = "[green]ready[/green]"
            if self.chain.pinned == profile["name"]:
                status += " (pinned)"
            table.add_row(str(index), profile["name"], profile["provider"], profile["model"], status)
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

    def cmd_key(self, name: str) -> None:
        if not self.chain.find(name):
            return self.error("No profile with that name.")
        key = prompt("New API key: ", is_password=True).strip()
        if not key:
            return self.error("No key entered.")
        config.set_key(name, key)
        self.chain.cooldowns.pop(name, None)
        self.say(f"Saved a new key for {name}.")

    # Other

    def cmd_system(self, text: str) -> None:
        if text:
            self.cfg["system"] = text
            config.save(self.cfg)
        self.say(self.cfg["system"] or "No system prompt set.")

    def cmd_help(self, _arg: str) -> None:
        self.say(HELP)

    def toolbar(self) -> str:
        ready = self.chain.ready()
        if self.chain.pinned and self.chain.cooldown_left(self.chain.pinned) == 0:
            active = self.chain.pinned + " (pinned)"
        else:
            active = ready[0]["name"] if ready else "no profile ready"
        parts = [str(Path.cwd()), f"next: {active}", f"{len(self.history) // 2} exchanges"]
        if self.attachments:
            parts.append(f"{len(self.attachments)} attached")
        return "  |  ".join(parts)

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
        self.console.print("[bold]Agentic Lazy Tool[/bold]  /help for commands")
        if not self.chain.profiles:
            self.say("No profiles yet. Add one with /add.")
        while True:
            try:
                line = session.prompt("you> ").strip()
            except (EOFError, KeyboardInterrupt):
                break
            if not line:
                continue
            if not line.startswith("/"):
                self.send(self.take_message(line))
                continue
            command, _, arg = line[1:].partition(" ")
            if command in ("exit", "quit"):
                break
            handler = getattr(self, f"cmd_{command}", None)
            if not handler:
                self.error("Unknown command. Try /help.")
                continue
            try:
                handler(arg.strip())
            except (EOFError, KeyboardInterrupt):
                self.say("cancelled", "dim")

    def one_shot(self, question: str) -> int:
        """Answer one question on stdout and exit, for use in scripts and pipes."""
        if not sys.stdin.isatty():
            piped = sys.stdin.read()
            if piped.strip():
                self.attachments.append(f"Input:\n```\n{piped}\n```")
        sys.stdout.reconfigure(errors="replace")

        def write(chunk: str) -> None:
            sys.stdout.write(chunk)
            sys.stdout.flush()

        try:
            self.chain.ask(
                [{"role": "user", "content": self.take_message(question)}],
                system=self.cfg["system"],
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
    parser.add_argument("--version", action="version", version=__version__)
    args = parser.parse_args()

    app = App()
    if args.folder:
        if not Path(args.folder).expanduser().is_dir():
            parser.error(f"folder not found: {args.folder}")
        os.chdir(Path(args.folder).expanduser())
    if args.prompt:
        sys.exit(app.one_shot(args.prompt))
    app.cmd_cd("")
    app.run()
