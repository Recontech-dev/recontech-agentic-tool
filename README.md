# Agentic Lazy Tool

A chat terminal for everyday development that keeps going when one AI runs out. Add several API keys, set the order once, and when a provider hits its rate limit or runs out of credit the conversation continues on the next one.

- **Multiple Claude profiles:** up to 6 Claude API keys (for example personal, work, client).
- **Free fallbacks:** Gemini, Groq, Cerebras, OpenRouter, local Ollama, or any OpenAI-compatible API.
- **Automatic failover:** a limited profile is skipped until its limit resets, then used again.
- **Project aware:** point it at a folder, attach files, copy code blocks out.
- **Debate mode:** several models argue a question and one gives the verdict.
- **Project memory:** notes from past sessions are kept per project and given to the model in later sessions.
- **Works offline:** with no internet it uses a local model if you have one, and otherwise answers from your stored notes and past conversations.
- **Better prompts:** it detects the kind of task (debug, review, explain, ...) and can rewrite a rough request into a clear prompt.
- **Saved conversations:** every chat is saved and can be resumed.
- **Scriptable:** `git diff | alt -p "review this"`.
- **Keys stay out of files:** they are stored in your OS keychain.

It works with free keys alone. A Claude key is optional.

> Claude profiles use **API keys** from the Anthropic Console, which are billed per use. Claude Pro/Max subscription logins are not supported: Anthropic only allows those in its own apps.

## Install

### Windows app (easiest)

1. Download `AgenticLazyTool.exe` from the [latest release](https://github.com/erlruben/agentic-lazy-tool/releases/latest).
2. Double-click it. Nothing else needs installing.

It opens one window: the terminal on the left and your memory graph on the right, updating as you work. Notes show as one or two key words; point at one to read it in full. **Open folder** picks the folder you work in, and **Hide memory** gives the terminal the whole window.

- Windows may show "Windows protected your PC" because the app is new and not code-signed. Click **More info**, then **Run anyway**.
- It needs Microsoft Edge or Google Chrome, which Windows 10 and 11 already have.
- The app runs only on your computer. Its window talks to a server on `127.0.0.1` that other computers cannot reach, and that is locked to the window with a random key.
- Closing the window closes the app.

### Terminal (any system)

Requires Python 3.10 or newer.

```
uv tool install git+https://github.com/erlruben/agentic-lazy-tool
```

Or with pip:

```
pip install git+https://github.com/erlruben/agentic-lazy-tool
```

Then start it with `alt` (or `agentic-lazy-tool`). To start in the folder you want to work on, pass it as an argument:

```
alt "D:\my-project"
```

`alt --app` opens the same window as the Windows app, with the memory graph beside the terminal, on any system.

### Run from a downloaded copy

If you downloaded the repository instead of installing it, install the dependencies once and then open `start.py` (double-click it, or run `python start.py`):

```
pip install -e .
python start.py
```

## Quick start

```
you> /add
Provider (claude, gemini, groq, cerebras, openrouter, ollama, custom): gemini
Profile name: gemini
Model: gemini-2.5-flash
API key: ********
Added gemini at the end of the chain. Run /test to check it.

you> /test
gemini: working (OK)

you> hello
gemini> Hi! How can I help?
```

Run `/add` again for each provider you want. The order you add them in is the failover order; change it with `/chain`.

The bar at the bottom of the screen shows the working folder, which profile answers next, and how many files are attached.

## Where to get keys

| Provider | Cost | Key |
|---|---|---|
| Claude | Pay per use | https://console.anthropic.com/settings/keys |
| Gemini | Free tier | https://aistudio.google.com/apikey |
| Groq | Free tier | https://console.groq.com/keys |
| Cerebras | Free tier | https://cloud.cerebras.ai |
| OpenRouter | Free models (`:free`) | https://openrouter.ai/keys |
| Ollama | Free, runs locally | No key; install from https://ollama.com/download |
| Custom | Depends | Any OpenAI-compatible API; `/add` asks for its base URL |

Free tiers and model names change often. The model shown at `/add` is only a suggestion; type any model the provider offers, and change it later with `/model`.

## Commands

**Chat**

| Command | What it does |
|---|---|
| `/new` | Start a fresh conversation |
| `/retry` | Ask the last question again, for example after `/switch` |
| `/debate <question>` | Have several models argue it out, then give a verdict |
| `/prompt [name]` | Use a saved prompt; `/prompt add <name> <text>` saves one, `/prompt remove <name>` deletes it |
| `/optimize <text>` | Rewrite your request into a clearer prompt, show it, then send it |
| `/optimize on\|off` | Do that for every message (one extra request each) |
| `/specialize on\|off` | Detect the kind of task and instruct the model for it (on by default) |
| `/copy [code]` | Copy the last reply, or only its last code block |
| `/resume [number]` | Reopen the latest saved conversation, or one from `/sessions` |
| `/sessions` | List saved conversations |

**Project files**

| Command | What it does |
|---|---|
| `/cd [folder]` | Show or set the folder you are working in |
| `/ls [pattern]` | List files in the working folder |
| `/file <path\|glob>` | Attach text files to your next message, for example `/file src/*.py` |
| `/project [init]` | Show this folder's project settings, or create the settings file |

**Memory**

| Command | What it does |
|---|---|
| `/remember <fact>` | Keep a note about this project for future sessions |
| `/memory` | Show the memory tree and which notes are loaded now |
| `/memory graph` | Open the memory network as a picture in your browser |
| `/memory save` | Turn the current conversation into notes now |
| `/memory forget <n>` | Delete one of this project's notes |
| `/memory auto on\|off` | Save notes automatically when a conversation ends (on by default) |
| `/recall <words>` | Search the notes of every project |

**Profiles**

| Command | What it does |
|---|---|
| `/add` | Add a profile (provider, name, model, API key) |
| `/remove <name>` | Delete a profile and its saved key |
| `/profiles` | List profiles in chain order with their status |
| `/test` | Send a tiny request to every profile to check it works |
| `/chain <names...>` | Set the failover order; the first name is tried first |
| `/switch <name\|auto>` | Pin one profile for this session, or go back to the chain |
| `/model <name> <id>` | Change the model a profile uses |
| `/key <name>` | Replace a profile's API key |
| `/workspace <name> [id]` | Set or clear the Anthropic workspace ID of a Claude profile (needed for keys not made inside a workspace) |
| `/workspace <name> [id]` | Set or clear the Anthropic workspace ID of a Claude profile (needed for organization-wide keys) |

**Other**

| Command | What it does |
|---|---|
| `/context` | Show everything that is loaded for the model right now, with rough sizes |
| `/offline [on\|off\|auto]` | Work without internet: local models and stored memory only |
| `/system [text]` | Show or set the system prompt |
| `/render [on\|off]` | Show replies as formatted Markdown with highlighted code, or as plain text |
| `/help` | List the commands |
| `/exit` | Quit |

Tab completes commands, profile names and file paths. Esc then Enter adds a new line. Ctrl+C cancels a reply.

## Use it in scripts

`-p` answers one question and exits. Anything piped in is attached to the question.

```
git diff | alt -p "review this change"
alt -p "write a .gitignore for a Python project" > .gitignore
```

Failover works the same way. Switch notices go to stderr, so the output stays clean. The exit code is 1 if no profile could answer.

## How failover works

1. Your message goes to the first profile in the chain.
2. If that profile is rate limited, out of credit, unreachable or has a rejected key, it is put on cooldown and the same message is sent to the next profile. The conversation history goes with it.
3. A one-line notice tells you which profile took over.
4. When the cooldown ends, the chain uses the earlier profile again.

Cooldowns follow the provider's `retry-after` header when there is one. Otherwise they are 60 seconds for a rate limit, 30 seconds for an outage, and an hour for no credit or a rejected key.

Free fallback models often accept less text than Claude. If a model rejects the conversation as too long, the oldest half is left out for that model and the request is retried, with a notice. Your saved conversation is not changed.

## Project settings

A file named `.alt.json` in a project folder sets defaults for that project. Create it with `/project init`:

```json
{
  "system": "This is a Flask app. Use Python 3.12 and keep answers short.",
  "files": ["README.md", "src/models.py"]
}
```

- `system` is added to your own system prompt while you work in that folder.
- `files` are attached to the first message of every new conversation. Glob patterns work, and only files inside the project folder are read.

The settings load when the tool starts in that folder or when you `/cd` into it.

## Saved prompts

Save the prompts you type often and reuse them by name:

```
you> /prompt add review Review this code for bugs and unclear names.
you> /file src/app.py
you> /prompt review
```

Anything after the name is added to the prompt: `/prompt review focus on error handling`.

## Better prompts

Two things help a short, rough request get a good answer.

**Task detection** is on by default and costs nothing. Keyword rules on your machine decide whether a message is debugging, a review, tests, a refactor, an explanation, a plan or new code, and add matching instructions for the model. For example, a message containing "error" tells the model to name the likely cause first, show the exact fix and say how to confirm it. The detected task is shown as `task: debug`. Turn it off with `/specialize off`.

**Prompt optimization** asks a model to rewrite your request into a clear prompt (goal, context, constraints, expected output) using what it knows about the project, shows you the result, and sends that instead:

```
you> /optimize fix login its slow
Optimized prompt:
The login endpoint in this Flask app responds slowly. Find the likely causes ...
```

It costs one extra request, so it is used only when you type `/optimize`, unless you turn it on for every message with `/optimize on`.

## Project memory

The tool remembers each project across sessions.

- When a conversation ends (`/new`, `/resume`, `/cd` to another folder, or `/exit`), a model turns it into at most 6 short notes: decisions made, facts about the code and setup, your preferences, unfinished tasks. This takes one request and needs at least two exchanges.
- Add a note yourself at any time with `/remember <fact>`.
- The notes for the folder you are working in are given to the model at the start of every later conversation, newest first, up to about 6,000 characters.
- `/memory` shows the tree: every remembered project, and the numbered notes of the current one. `/recall <words>` searches the notes of all projects, so something learned in one project can be found from another.

### Seeing the memory

- `/memory` draws the tree in the terminal. The project you have open is marked `(open now)`. Its notes are marked `●` when they are being given to the model in this session and `○` when they are only stored. Topics that link notes across projects are listed at the end.
- `/memory graph` opens the same data as a network picture in your browser: projects, their notes, and the topics that connect them. The open project has a green ring and the loaded notes are green. Point at a circle to read it, click to keep it selected, drag to move it. The page is one local file with nothing downloaded and nothing sent anywhere.
- `/context` lists everything loaded for the model right now: system prompt, project settings, loaded notes, files waiting to be sent, and the conversation, each with a rough token count.

Memory is a tree of plain files: one folder per project under `~/.agentic-lazy-tool/memory/`, each holding its notes. Projects are identified by their folder path, so a project you move or rename starts a new set of notes; the old ones stay and can still be found with `/recall`.

Nothing is deleted when a session ends. The full conversations are kept as well (see `/sessions`), and notes are only removed when you run `/memory forget`.

## Working offline

The tool keeps working without internet, using what is stored on your machine.

- **It notices by itself.** It checks the connection when it starts and again while you work. When there is no internet it says so, shows `OFFLINE` in the bottom bar, and skips the cloud profiles immediately instead of waiting for each to fail. When the connection returns, it goes back to the normal chain.
- **With a local model, you still get answers.** A model running on your machine answers offline. Install [Ollama](https://ollama.com/download), download a model while you are online (`ollama pull llama3.2`), and add it with `/add` (provider `ollama`). While offline, the model is also given the stored notes and past answers that match your question, from every project, because a local model knows less than a cloud one.
- **Without a local model, you get your memory.** No AI can write a new answer, so the tool shows what it already holds about the question: matching notes from every project and matching past conversations with the answers you got then. It is labelled as stored memory, not a new answer.
- **Everything local still works:** `/memory`, `/memory graph`, `/recall`, `/sessions`, `/resume`, `/context`, `/file`, `/copy`.

`/offline` shows the current state and which local models you have. `/offline on` forces offline mode (for example to keep everything on your machine), `/offline off` turns the check off, and `/offline auto` is the default.

What does not work offline: cloud providers, and turning a finished conversation into notes when there is no local model. The conversation itself is still saved in full.

## Privacy and what gets committed

- **Your data is outside your projects.** Keys are in the OS keychain. Profiles, conversations and memory are in `~/.agentic-lazy-tool/`, which is not inside any project, so `git add .` in a project cannot pick them up. If that folder ever is inside a git repository, the tool warns at start-up.
- **Secrets are masked in memory.** Before a note is stored, anything that looks like an API key, token, private key or `password=...` is replaced with `[secret removed]`.
- **What does leave your machine:** your messages, attached files, the system prompt and the project's memory notes are sent to whichever AI provider answers. That is how the tool works. Do not attach files that contain secrets.
- **`.alt.json` is meant to be committed** with a project, so do not put secrets in it.

For people working on this repository: `python scripts/install_hook.py` installs a pre-commit hook that stops a commit containing an API key or a personal data file, and `python scripts/check_secrets.py --all` scans everything git tracks.

## Debate mode

`/debate <question>` runs two rounds and a verdict:

1. Up to three profiles answer independently, each with a different role (advocate, skeptic, pragmatist).
2. Each reads the others' answers and revises.
3. The first available profile in the chain judges and gives one recommendation.

A debate makes about seven requests, so it uses limits faster than normal chat. It is most useful with profiles from different providers, because different models disagree more than one model asked twice.

## Configuration

- Profiles and the system prompt are saved in `~/.agentic-lazy-tool/config.json`.
- Conversations are saved in `~/.agentic-lazy-tool/sessions/`.
- Memory notes are saved in `~/.agentic-lazy-tool/memory/`, one folder per project.
- Keys are saved in the OS keychain (Windows Credential Manager, macOS Keychain, Secret Service on Linux).
- On a machine with no keychain, set a key with an environment variable instead: `ALT_KEY_<PROFILE NAME>`, upper case with other characters replaced by `_` (for example `ALT_KEY_CLAUDE_WORK`).

## Contributing

Anyone can work on this project. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, where the code lives, and the rules. The intended day-to-day flow and the list of open work are in [docs/USER_FLOW.md](docs/USER_FLOW.md).

To build the Windows app yourself: `pip install pyinstaller`, then `python packaging/build_exe.py`. It writes `dist/AgenticLazyTool.exe`.

## License

[MIT](LICENSE). You may use, copy, change and share it, including in commercial work, as long as the license notice stays with it.
