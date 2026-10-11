# Agentic Lazy Tool

A chat terminal for everyday development that keeps going when one AI runs out. Add several API keys, set the order once, and when a provider hits its rate limit or runs out of credit the conversation continues on the next one.

- **Multiple Claude profiles:** up to 6 Claude API keys (for example personal, work, client).
- **Free fallbacks:** Gemini, Groq, Cerebras, OpenRouter, local Ollama, or any OpenAI-compatible API.
- **Automatic failover:** a limited profile is skipped until its limit resets, then used again.
- **Project aware:** point it at a folder, attach files, copy code blocks out.
- **Debate mode:** several models argue a question and one gives the verdict.
- **Saved conversations:** every chat is saved and can be resumed.
- **Scriptable:** `git diff | alt -p "review this"`.
- **Keys stay out of files:** they are stored in your OS keychain.

It works with free keys alone. A Claude key is optional.

> Claude profiles use **API keys** from the Anthropic Console, which are billed per use. Claude Pro/Max subscription logins are not supported: Anthropic only allows those in its own apps.

## Install

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
| `/copy [code]` | Copy the last reply, or only its last code block |
| `/resume [number]` | Reopen the latest saved conversation, or one from `/sessions` |
| `/sessions` | List saved conversations |

**Project files**

| Command | What it does |
|---|---|
| `/cd [folder]` | Show or set the folder you are working in |
| `/ls [pattern]` | List files in the working folder |
| `/file <path\|glob>` | Attach text files to your next message, for example `/file src/*.py` |

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

**Other**

| Command | What it does |
|---|---|
| `/system [text]` | Show or set the system prompt |
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

## Debate mode

`/debate <question>` runs two rounds and a verdict:

1. Up to three profiles answer independently, each with a different role (advocate, skeptic, pragmatist).
2. Each reads the others' answers and revises.
3. The first available profile in the chain judges and gives one recommendation.

A debate makes about seven requests, so it uses limits faster than normal chat. It is most useful with profiles from different providers, because different models disagree more than one model asked twice.

## Configuration

- Profiles and the system prompt are saved in `~/.agentic-lazy-tool/config.json`.
- Conversations are saved in `~/.agentic-lazy-tool/sessions/`.
- Keys are saved in the OS keychain (Windows Credential Manager, macOS Keychain, Secret Service on Linux).
- On a machine with no keychain, set a key with an environment variable instead: `ALT_KEY_<PROFILE NAME>`, upper case with other characters replaced by `_` (for example `ALT_KEY_CLAUDE_WORK`).

## Development

```
git clone https://github.com/erlruben/agentic-lazy-tool
cd agentic-lazy-tool
uv run --with pytest pytest
uv run alt
```

To add a provider with an OpenAI-compatible API, add an entry to `PRESETS` in `src/agentic_lazy_tool/providers.py`.

The intended day-to-day flow and the list of open work are in [docs/USER_FLOW.md](docs/USER_FLOW.md).

## License

MIT
