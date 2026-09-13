Re-read config that was frozen when this session started, and swap the fresh values into the running session — no restart, conversation preserved.

Use it when skills, rules, settings, the default model, or MCP servers changed on disk after the session began (a synced-in new skill, an edited rulebook, a `config.yml` change) and you need this session to pick them up. Common trigger: a supervisor announces "run `refresh`" after updating shared config across a fleet.

`scope` (default `all`) selects which surface to re-read:

- `skills` / `rules` — re-scan the skill/rule roster so `skill://<name>` and `rule://<name>` resolve newly added entries (the roster is one on-disk surface; both re-scan together, the scope just names which count you get back).
- `settings` — re-read every settings layer and re-resolve the default model, swapping the active model if it changed on disk (skipped if you set a session `/model` override, which always wins).
- `mcp` — disconnect and rediscover MCP servers, rebinding their tools.
- `all` — every surface above.

Pure re-read: it never writes or reformats any config file. A no-op refresh (nothing changed) is cheap and leaves the system prompt byte-identical.
