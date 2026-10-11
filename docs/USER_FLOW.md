# User flow

How Agentic Lazy Tool is meant to be used every day, and what still needs work.

The goal: one terminal you keep open while developing. It should be fast to reach, never stop because one AI hit a limit, and stay easy to manage.

## 1. First-time setup (about 10 minutes, once)

1. Install the tool and run `alt`.
2. Run `/add` once for each provider. A good starting chain:
   - `claude` (optional, paid API key) for the best answers
   - `gemini` and `groq` (free keys) as backups
   - `ollama` (local, no key) as the last backup that never runs out
3. Run `/test`. Every profile should say "working". If one fails, fix it with `/key <name>` or `/model <name> <id>`.
4. Run `/chain` with the names in the order you want them tried.
5. Optional: `/system You are helping me with Python and web projects. Keep answers short.`

After this, nothing in setup needs to be repeated.

## 2. Start of a work session

1. Open the tool in your project: `alt "D:\my-project"`, or run `alt` and then `/cd D:\my-project`.
2. Look at the bar at the bottom. It shows the folder, which profile answers next, and attached files.
3. Continue yesterday's chat with `/resume`, or just start typing for a new one.

## 3. Normal work loop

1. Find the file: `/ls src` (Tab completes paths).
2. Attach it: `/file src/app.py`, or several with `/file src/*.py`.
3. Ask the question. The attached files go with that one message.
4. Take the answer out: `/copy code` copies the last code block; `/copy` copies the whole reply.
5. Keep asking follow-up questions. The conversation remembers earlier messages.
6. Start a new topic with `/new` so old context does not confuse the model or use up limits.

## 4. When a limit is hit

You do nothing. This is the main point of the tool.

1. A yellow line appears, for example `claude-work: rate limited for 60s, switching`.
2. The next profile in the chain answers the same message, with the same history.
3. When the limit resets, the chain returns to the earlier profile by itself.

If you want control:

- `/profiles` shows who is ready and who is waiting.
- `/switch groq` puts one profile first for this session. `/switch auto` goes back.
- `/retry` asks the last question again, useful when a free model gave a weak answer and a better profile is back.

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

Just close it. Every conversation is already saved. `/sessions` lists them and `/resume 2` reopens one.

## Rules of the tool

- Claude profiles are API keys only. Claude Pro/Max logins are not supported and will not be added.
- It is chat only. It reads files you attach; it does not edit files or run commands.
- Free models are weaker than Claude. The fallback keeps you working; it is not equal quality.

## Status

Checked with automated tests and a full session against a local fake API server:

- Failover on a rate limit, cooldown, and return to the first profile
- Streaming replies through both the Claude adapter and the OpenAI-compatible adapter
- `/switch`, `/retry`, `/file`, `/ls`, `/test`, `/debate`, `/sessions`, `/resume`, `/copy code`, `/model`, `-p` mode

Not checked yet, because it needs real keys or a real keyboard:

- A reply from a real provider (Claude, Gemini, Groq, Cerebras, OpenRouter, Ollama)
- The default model names for the free providers, which may be out of date
- The `/add` and `/key` prompts, Tab completion, the bottom bar, and Esc+Enter typed by hand
- Saving keys in the OS keychain
- `/copy` writing to the real clipboard (only the text selection was tested)

## To do first

1. Run `pip install -e .`, then `python start.py`, add one real free key and run `/test`.
2. Correct any default model name in `providers.py` that `/test` rejects.
3. Rename the project folder to `agentic-lazy-tool` (close VS Code first).
4. Done: the repository is public at https://github.com/erlruben/agentic-lazy-tool.

## Ideas for later

- **Rendered replies:** show Markdown and highlighted code instead of plain text.
- **Long chats on small models:** trim or summarise old messages when a fallback model has a small context window.
- **Limit awareness:** show remaining requests in the bottom bar from the providers' rate-limit headers.
- **Per-project settings:** a file in the project folder that sets the system prompt and files to attach by default.
- **Saved prompts:** `/prompt review` to reuse a prompt you type often.
- **Themes:** colours and a custom prompt name.
- **Agent mode:** let the model edit files and run commands, with confirmation. This is a large step and changes the safety picture for a public tool.
