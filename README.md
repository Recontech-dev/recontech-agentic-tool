# Agentic Lazy Tool

A workspace for Claude Code with a shared brain. Run several Claude Code terminals side by side, one per profile, and let all of them read and write one local memory that is built from your past sessions. Nothing is forgotten when a session ends.

- **Claude Code side by side:** up to 6 terminals, each running the real Claude Code with its own sign-in (for example Personal and Work). Grid or tabs.
- **Shared brain:** every terminal connects to the same local memory through MCP. A fact one session learns, the next session knows.
- **Past sessions become memory:** Claude Code saves every session on your disk. The brain reads them and keeps each one's title, folder, your prompts and its main topics, even after Claude Code's own files are gone.
- **See your brain:** a live network on the right side of the window shows your projects, past sessions (coloured by profile), notes and the topics that link them. What is open now is green. Click a past session and press **Resume** to continue it in its terminal.
- **Works offline:** an Ollama profile runs Claude Code on a model on your computer, with the same brain, when there is no internet.
- **Private:** everything stays on your computer. The app never sees your Claude sign-in; Claude Code handles it, as usual.

## Install (Windows)

1. Install Claude Code if you do not have it: https://docs.claude.com/en/docs/claude-code
2. Download `AgenticLazyTool-Setup.exe` from the [latest release](https://github.com/erlruben/agentic-lazy-tool/releases/latest) and run it. It installs for your user only; no admin rights needed.
3. Open **Agentic Lazy Tool** from the Start menu.

Windows may show "Windows protected your PC" because the app is new and not code-signed. Click **More info**, then **Run anyway**.

## Use it

1. Click **Choose project folder**. Every terminal starts there.
2. The first terminal (Main) runs Claude Code with your normal sign-in.
3. Click **+ Profile** to add another, for example Work. Its terminal asks you to sign in to Claude Code the first time; after that it stays signed in. If you already have signed-in Claude Code folders such as `~/.claude-account1`, the app finds them: on first start they become profiles, and **+ Profile** offers any that are not used yet.
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

## How the brain works

| Part | Where it lives | What it holds |
|---|---|---|
| Past sessions | read from each profile's Claude Code folder, indexed in `~/.agentic-lazy-tool/brain/sessions.json` | title, project folder, dates, your prompts, main topics |
| Notes | `~/.agentic-lazy-tool/memory/<project>/notes.jsonl` | short facts Claude or you saved with `remember` |
| Profiles | `~/.agentic-lazy-tool/workspace.json`, sign-ins in `~/.agentic-lazy-tool/profiles/` | which Claude Code sign-ins you use |

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
