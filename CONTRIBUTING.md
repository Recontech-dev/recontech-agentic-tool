# Contributing

Contributions are welcome. The project is MIT licensed (see [LICENSE](LICENSE)), and by sending a contribution you agree that it is released under the same license.

## Set up

```
git clone https://github.com/erlruben/agentic-lazy-tool
cd agentic-lazy-tool
python -m pip install -e . pytest
python scripts/install_hook.py
python -m pytest -q
```

The hook stops a commit that contains an API key or a personal data file. Run the tool with `alt` (terminal) or `alt --app` (window with the memory graph).

## Where things are

| File | What it does |
|---|---|
| `src/agentic_lazy_tool/cli.py` | Terminal app and every slash command |
| `src/agentic_lazy_tool/chain.py` | Failover between profiles, cooldowns, trimming long conversations |
| `src/agentic_lazy_tool/providers.py` | Claude adapter and the OpenAI-compatible adapter; add providers to `PRESETS` |
| `src/agentic_lazy_tool/memory.py` | Project memory, topics and search |
| `src/agentic_lazy_tool/tasks.py` | Task detection rules |
| `src/agentic_lazy_tool/gateway.py` | Local OpenAI-compatible gateway and its dashboard |
| `src/agentic_lazy_tool/webapp.py`, `webui.py` | Window app: local server and the page with the memory graph |
| `packaging/build_exe.py` | Builds `dist/AgenticLazyTool.exe` |

## Rules

- Never commit keys, `.env` files, or anything from `~/.agentic-lazy-tool/` (conversations, memory).
- Add or update a test in `tests/` with each change. Tests must not call real AI providers.
- Keep pull requests to one change each and describe what you tested.

## Releasing (maintainers)

Push a version tag, for example `git tag v0.2.0 && git push origin v0.2.0`. GitHub Actions runs the tests, builds `AgenticLazyTool.exe` and attaches it to a new release.
