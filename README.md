# Agentic Lazy Tool

**One window for all your Claude Code work, with a memory that never forgets.**

## What it is for

Every Claude Code session starts from zero. What you decided yesterday, why a bug happened last week, how a project is deployed: it is all in old sessions that the next session cannot see. And if you use more than one Claude Code sign-in, or need to keep working without internet, you juggle several terminals by hand.

Agentic Lazy Tool puts your Claude Code terminals side by side in one window and connects all of them to a shared local **brain**. The brain is built from your past sessions and the notes Claude saves while it works, so every new session can pick up where the last one left off.

## Main features

- **Claude Code side by side:** up to 6 terminals in a grid or tabs, each running the real Claude Code with its own sign-in (for example Personal and Work).
- **Shared brain:** every terminal connects to the same local memory. A fact one session learns, the next session knows, across profiles and projects.
- **Past sessions become memory:** the brain reads the sessions Claude Code saves on your disk and keeps each one's title, project, your prompts and its main topics, even after Claude Code's own files are gone.
- **See your brain:** a live network beside the terminals shows your projects, past sessions (coloured by profile), notes and the topics that link them. It arranges itself so nothing overlaps and zooms to fit as it grows.
- **Resume anything:** click a past session and press **Resume** to continue it in the right terminal and folder.
- **Search everything:** find any earlier decision or session across all projects.
- **Smart sorting (optional):** a local model labels every session as bug fix, feature, refactor, setup and deploy, tests, docs or question, and spots work that was left unfinished. Claude is told about unfinished work first, and the graph can show only unfinished sessions or one kind of work.
- **Works offline:** an Ollama profile runs Claude Code on a model on your own computer, with the same brain, when there is no internet.
- **Private by design:** everything stays on your computer, secrets are masked before anything is stored, and the app never sees your Claude sign-in.

![Three Claude Code profiles side by side with the brain graph](docs/screenshot.png)

*The screenshot uses made-up demo projects.*

## Install (Windows)

1. Install Claude Code if you do not have it: https://docs.claude.com/en/docs/claude-code
2. Download `AgenticLazyTool-Setup.exe` from the [latest release](https://github.com/erlruben/agentic-lazy-tool/releases/latest) and run it. It installs for your user only; no admin rights needed.
3. Open **Agentic Lazy Tool** from the Start menu.

Windows may show "Windows protected your PC" because the app is new and not code-signed. Click **More info**, then **Run anyway**.

## Use it

1. Click **Choose project folder**. Every terminal starts there; no terminal starts until a folder is chosen. The first time Claude Code opens a folder it asks whether you trust it: choose **Yes** for your own projects.
2. The first terminal (Main) runs Claude Code with your normal sign-in.
3. Click **+ Profile** to add another, for example Work. Its terminal asks you to sign in to Claude Code the first time; after that it stays signed in. If you already have signed-in Claude Code folders such as `~/.claude-account1`, the app finds them and shows a bar at the top offering to add them as profiles with their existing sign-ins. **+ Profile** also lists any that are not used yet.
4. Work as usual. Claude sees the brain as tools named `remember`, `recall`, `project_memory` and `forget`, and is told to check the project's memory when it starts and to save decisions as it goes. You can also ask it directly: "remember that we deploy with Docker", "what did we decide about the login page last week?"
5. Use the search box above the graph to find anything from earlier sessions or notes, across all projects.

An **Offline** badge appears in the top bar when Claude cannot be reached; Claude profiles then show "needs internet".

Buttons: **↻** restarts a terminal, **✕** removes a profile (its sign-in and past sessions stay on disk), **Tabs/Grid** switches the layout, **Hide brain** gives the terminals the whole window.

### About accounts

Each profile is a separate Claude Code sign-in. Use your own accounts, for example a personal and a work account. Sharing or borrowing someone else's Claude account breaks Anthropic's terms and puts that account at risk. The app does not switch accounts for you when a usage limit is reached.

## Offline with Ollama

1. Install [Ollama](https://ollama.com/download) and, while online, download a model that can use tools, for example `ollama pull qwen3:8b` (about 5 GB) or `ollama pull qwen3-coder:30b` (about 19 GB, much better, needs a strong PC). Very small models such as `qwen3:0.6b` start, but cannot use tools or the brain.
2. Click **+ Profile**, choose **Offline with Ollama**, and pick the model.
3. That terminal runs Claude Code against Ollama on your computer. It needs no internet and no Claude account, and it uses the same brain.

Claude Code sends a long set of instructions with every request, so give Ollama a larger context: set the environment variable `OLLAMA_CONTEXT_LENGTH` to `32768` or more and restart Ollama. Answers from local models are slower and weaker than Claude's.

## Smart sorting

Smart sorting is off until you turn it on with the **Smart sorting** button above the graph.

- It uses [Laya](https://github.com/receptron/laya), an open-source classification model that runs on your computer. Nothing is sent anywhere, and it works offline.
- The first time, it downloads the model once: about 1.7 GB. If the drive it would use has less than 2.5 GB free, the app asks you to choose a folder on another drive. It uses about 2 GB of memory while it runs.
- For each session it answers three questions: what kind of work it was, whether it was finished, and whether it records a decision worth remembering. A session is sorted once it has been quiet for 10 minutes, and again if you continue it later.
- After the app starts, loading the model can take a minute or two; then each session takes a few seconds. It runs in the background, so you can keep working.
- Sessions that look unfinished get a dashed orange ring in the graph, and `project_memory` lists them first so Claude picks them up. Use the menu next to the search box to show only unfinished sessions or one kind of work.
- The kind of work is judged from the start of a session (title, topics and your first prompts), and finished-or-not from how it ended (your last message and Claude's last reply). The model understands English best, and its labels are estimates.

## How the brain works

| Part | Where it lives | What it holds |
|---|---|---|
| Past sessions | read from each profile's Claude Code folder, indexed in `~/.agentic-lazy-tool/brain/sessions.json` | title, project folder, dates, your prompts, main topics |
| Notes | `~/.agentic-lazy-tool/memory/<project>/notes.jsonl` | short facts Claude or you saved with `remember` |
| Profiles | `~/.agentic-lazy-tool/workspace.json`, sign-ins in `~/.agentic-lazy-tool/profiles/` | which Claude Code sign-ins you use |
| Smart sorting labels | `~/.agentic-lazy-tool/brain/labels.json`, model in `~/.agentic-lazy-tool/models/` or the folder you chose | each session's kind of work and whether it was finished |

- Notes and sessions are linked by the words they share, which is how the topics in the graph appear. It is a searchable memory, not a trained neural network.
- API keys, tokens and `password=...` values are masked before anything is stored.
- The brain checks for new sessions every 10 seconds while the app is open.
- To use the brain in a Claude Code you start yourself, run `claude --mcp-config "%USERPROFILE%\.agentic-lazy-tool\brain\mcp.json"`. The file is written the first time the app starts a terminal.

## Build from source

Requires Node.js 22 or newer.

```
git clone https://github.com/erlruben/agentic-lazy-tool
cd agentic-lazy-tool
npm install
npm start          # run the app
npm test           # run the tests
npm run dist       # build release/AgenticLazyTool-Setup-<version>.exe
```

macOS and Linux run from source with `npm start`; only the Windows installer is built automatically.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). You may use, copy, change and share it, including in commercial work, as long as the license notice stays with it.
