# Contributing

Contributions are welcome. The project is MIT licensed (see [LICENSE](LICENSE)), and by sending a contribution you agree that it is released under the same license.

## Set up

```
git clone https://github.com/erlruben/agentic-lazy-tool
cd agentic-lazy-tool
npm install
npm test
npm start
```

Install the secret check as a pre-commit hook once:

```
printf '#!/bin/sh\nnode scripts/check-secrets.mjs\n' > .git/hooks/pre-commit
```

## Where things are

| File | What it does |
|---|---|
| `src/main/main.ts` | Electron main process: window, terminals (node-pty), brain refresh |
| `src/main/preload.ts` | The fixed list of channels the page may use |
| `src/renderer/renderer.ts`, `static/index.html` | The window: terminals (xterm.js), brain search and graph |
| `src/brain/store.ts` | Notes per project, word helpers |
| `src/brain/sessions.ts` | Reads Claude Code session transcripts into the session index |
| `src/brain/brain.ts` | Search, project summary and the graph |
| `src/brain/workspace.ts` | Profiles, existing Claude Code folders, and the project folder |
| `src/brain/kits.ts` | Project kits and terminal roles: the standing instructions and kit detection |
| `src/brain/share.ts` | Team memory: the share file in the project folder |
| `src/brain/meaning.ts` | Search by meaning with a local embedding model |
| `src/brain/launch.ts` | How each profile's Claude Code starts (sign-in or Ollama), internet and Ollama checks |
| `src/brain/sorting.ts`, `src/brain/sorter.ts` | Smart sorting: the questions asked of Laya, and the background worker |
| `src/proxy/translate.ts`, `src/proxy/server.ts` | Free models bridge: translates Claude Code's requests for OpenAI-compatible providers, with failover |
| `src/main/control.ts` | The link that lets terminals list, read and message each other |
| `src/main/free.ts` | Free models settings and encrypted API keys |
| `src/mcp/server.ts` | The brain as an MCP server for Claude Code |
| `src/test/` | Tests (`node --test`) |
| `docs/index.html` | The project website (GitHub Pages) |

## Rules

- Never commit keys, `.env` files, or anything from `~/.agentic-lazy-tool/` or a Claude Code config folder.
- Add or update a test with each change. Tests must not read the real sessions on your machine; set `ALT_HOME` and `ALT_CLAUDE_HOME` to temporary folders as the existing tests do. Tests must not download the Smart sorting model; pass a stand-in model to `classify` instead.
- Screenshots and examples must use made-up data, never your own projects or sessions.
- The app must never read, store or send Claude sign-in credentials. Claude Code handles sign-in.
- Keep pull requests to one change each and describe what you tested.

## Releasing (maintainers)

Update `version` in `package.json`, then push a tag, for example `git tag v0.3.0 && git push origin v0.3.0`. GitHub Actions runs the tests, builds the installer and attaches it to a new release.
