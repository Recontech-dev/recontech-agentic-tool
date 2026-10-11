# User flow

How Agentic Lazy Tool is meant to be used every day, and what still needs work.

The goal: one terminal you keep open while developing. It should be fast to reach, never stop because one AI hit a limit, and stay easy to manage.

## 1. First-time setup (about 10 minutes, once)

1. Download `AgenticLazyTool.exe` from the latest GitHub release and double-click it, or install the terminal version and run `alt`. The app shows the terminal on the left and the memory graph on the right; everything below works the same in both.
2. Run `/add` once for each provider. A good starting chain:
   - `claude` (optional, paid API key) for the best answers
   - `gemini` and `groq` (free keys) as backups
   - `ollama` (local, no key) as the last backup that never runs out
3. Run `/test`. Every profile should say "working". If one fails, fix it with `/key <name>` or `/model <name> <id>`.
4. Run `/chain` with the names in the order you want them tried.
5. Optional: `/system You are helping me with Python and web projects. Keep answers short.`
6. Optional: save the prompts you type often, for example `/prompt add review Review this code for bugs and unclear names.`

For each project, run `/project init` once in its folder and edit `.alt.json`. It holds a system prompt for that project and the files to attach to every new conversation (for example the README and the main models file), so you do not attach them by hand each time.

After this, nothing in setup needs to be repeated.

## 2. Start of a work session

1. Open the tool in your project: `alt "D:\my-project"`, or run `alt` and then `/cd D:\my-project`.
2. Look at the bar at the bottom. It shows the folder, which profile answers next, and attached files.
3. Continue yesterday's chat with `/resume`, or just start typing for a new one.

You do not need to re-explain the project. The notes kept from earlier sessions are loaded for this folder ("Remembering 8 notes about this project") and given to the model.

To see what is loaded:

- `/memory` shows the tree of all projects, with the open project marked and its loaded notes shown as `●`.
- `/memory graph` opens the memory as a network picture in the browser, with the open project and loaded notes in green.
- `/context` lists everything the model will receive with your next message.

## 3. Normal work loop

1. Find the file: `/ls src` (Tab completes paths).
2. Attach it: `/file src/app.py`, or several with `/file src/*.py`.
3. Ask the question, or use a saved prompt such as `/prompt review`. The attached files go with that one message.
   - Type it the short way. The tool detects the kind of task (it shows `task: debug`, `task: review`, ...) and tells the model how to answer that kind.
   - For an important or vague request, use `/optimize <request>`. A model rewrites it into a clear prompt first, shows it, and sends it.
4. Take the answer out: `/copy code` copies the last code block; `/copy` copies the whole reply.
5. Keep asking follow-up questions. The conversation remembers earlier messages.
6. Start a new topic with `/new` so old context does not confuse the model or use up limits. The finished conversation is turned into notes for the project first.
7. When you decide something or learn a fact worth keeping, save it straight away: `/remember we deploy with Docker on port 8080`.
8. Need something from another project? `/recall docker port` searches the notes of every project.

## 4. When a limit is hit

You do nothing. This is the main point of the tool.

1. A yellow line appears, for example `claude-work: rate limited for 60s, switching`.
2. The next profile in the chain answers the same message, with the same history.
3. When the limit resets, the chain returns to the earlier profile by itself.
4. If the fallback model cannot take the whole conversation, the oldest messages are left out for that model and a notice says so.

If you want control:

- `/profiles` shows who is ready and who is waiting.
- `/switch groq` puts one profile first for this session. `/switch auto` goes back.
- `/retry` asks the last question again, useful when a free model gave a weak answer and a better profile is back.

## 4b. When there is no internet

You also do nothing. The tool notices, says "Offline", and shows `OFFLINE` in the bottom bar.

- If you set up a local model (Ollama), it answers, and it is given the stored notes and past answers that match your question.
- If you have no local model, the tool shows what your memory already holds about the question: matching notes from all projects and the answers you got in past conversations.
- `/memory`, `/memory graph`, `/recall`, `/sessions` and `/resume` all work offline.

To be ready for this, do it once while online: install Ollama, run `ollama pull llama3.2`, then `/add` with provider `ollama` and put it last in the chain.

## 5. Hard decisions

For a choice between designs or libraries, use `/debate <question>`.

1. Up to three models answer with different roles.
2. They read each other and revise.
3. One model gives the verdict.

A debate costs about seven requests. Use it for decisions, not for everyday questions.

## 6. Quick questions without opening the chat

From any terminal, including the one in VS Code:

```
alt -p "explain this error: ..."
git diff | alt -p "review this change"
type error.log | alt -p "what went wrong?"
```

## 7. End of day

Type `/exit`. The conversation is turned into notes for the project, which takes one request (Ctrl+C skips it). Every conversation is also saved in full: `/sessions` lists them and `/resume 2` reopens one.

Nothing is deleted when a session ends. Memory only shrinks when you run `/memory forget <number>`.

## 8. Keeping private data private

- Keys are in the OS keychain. Conversations and memory are in `~/.agentic-lazy-tool/`, outside every project, so they cannot be pushed with a project.
- Notes have API keys and passwords masked before they are stored.
- Messages, attached files and the project's notes are sent to the AI provider that answers. Do not attach files that hold secrets.
- In this repository, a pre-commit hook (`python scripts/install_hook.py`) stops a commit that contains a key or a personal data file.

## Rules of the tool

- Claude profiles are API keys only. Claude Pro/Max logins are not supported and will not be added.
- It is chat only. It reads files you attach; it does not edit files or run commands.
- Free models are weaker than Claude. The fallback keeps you working; it is not equal quality.

## Status

Checked with automated tests and a full session against a local fake API server:

- Failover on a rate limit, cooldown, and return to the first profile
- Streaming replies through both the Claude adapter and the OpenAI-compatible adapter
- `/switch`, `/retry`, `/file`, `/ls`, `/test`, `/debate`, `/sessions`, `/resume`, `/copy code`, `/model`, `-p` mode
- Markdown rendering of replies, trimming of a too-long conversation, saved prompts, and project settings
- The Windows app: the built `.exe` starts, serves its window and shuts down on `/exit`; the window was driven with a fake provider and checked with a headless browser screenshot (reply rendering, live graph with key-word labels, cancel, token and host checks)
- The memory views: `/memory` tree, `/context`, and the `/memory graph` page (checked with a headless browser screenshot)
- Offline mode with the connection check simulated: cloud profiles skipped, a local profile used and given recalled memory, and the answer-from-memory view when no model is available
- Task detection, `/optimize`, project memory (`/remember`, automatic notes, `/memory`, `/recall`), secret masking, and the pre-commit secret check

Not checked yet, because it needs real keys or a real keyboard:

- A reply from a real provider (Claude, Gemini, Groq, Cerebras, OpenRouter, Ollama)
- The default model names for the free providers, which may be out of date
- The `/add` and `/key` prompts, Tab completion, the bottom bar, and Esc+Enter typed by hand
- How the live preview of a reply looks in a real terminal window while it streams
- Whether each real provider's "too long" error is recognised (the wording differs per provider)
- The `.exe` used by hand: typing, `/add` with saving a key to the keychain from the packaged app, the Open folder button, closing the window
- The release workflow on GitHub (it runs only when a version tag is pushed)
- Offline mode with the network really disconnected, and with a real Ollama model (Ollama is not installed on this machine)
- The quality of the notes and optimized prompts that real models write (only the plumbing was tested)
- Saving keys in the OS keychain
- `/copy` writing to the real clipboard (only the text selection was tested)

## To do first

1. Run `pip install -e .`, then `python start.py`, add one real free key and run `/test`.
2. Correct any default model name in `providers.py` that `/test` rejects.
3. Rename the project folder to `agentic-lazy-tool` (close VS Code first).
4. Done: the repository is public at https://github.com/erlruben/agentic-lazy-tool.

## Ideas for later

- **Limit awareness:** show remaining requests in the bottom bar from the providers' rate-limit headers.
- **Summaries instead of trimming:** when a conversation is too long for a fallback model, summarise the old messages instead of leaving them out.
- **Smarter memory:** link related notes across projects, merge duplicates, and pick the notes most relevant to the current question instead of the newest ones.
- **Memory that follows a moved project:** notes are tied to the folder path, so a renamed folder starts fresh.
- **Themes:** colours and a custom prompt name.
- **Agent mode:** let the model edit files and run commands, with confirmation. This is a large step and changes the safety picture for a public tool.
