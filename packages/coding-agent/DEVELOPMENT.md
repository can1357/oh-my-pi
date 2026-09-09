# Developing `@oh-my-pi/pi-coding-agent`

This package is the `omp` CLI. This file is a **developer's map**: where things live
in `src/`, how to run the local loops, and — for each subsystem — which document in
the repo [`docs/`](../../docs/) tree is the authoritative reference.

The long architecture walkthrough that used to live here drifted out of date faster
than anyone re-read it. The `docs/` tree is kept current (and indexed for the
in-agent `docs://` / `/docs` surface), so this file links there instead of
duplicating prose that goes stale.

## Local development

Run from `packages/coding-agent/` (or add `--cwd=packages/coding-agent`):

| Task | Command |
|---|---|
| Typecheck + lint (the gate) | `bun run check` |
| Types only | `bun run check:types` |
| Lint only | `bun run lint` |
| Tests | `bun run test` |
| Autofix: lint + format prompts | `bun run fix` |
| Build the `dist/omp` binary | `bun run build` |

Never invoke `tsc`/`npx tsc` directly — `bun run check` is the typecheck gate. After
changing the React tool renderers under `collab-web/src/tool-render/`, rebuild them
with `bun run gen:tool-views`.

## Boot flow

```text
process argv
   │
   ▼
src/cli.ts (runCli)            ── worker-host dispatch + Bun version guard;
   │  default subcommand: launch    argv normalization
   ▼
src/commands/* (+ src/cli/)   ── per-command adapters
   │
   ▼
src/main.ts (runRootCommand)  ── theme / settings / model registry / session opts
   │
   ▼
createAgentSession(...)        ── src/sdk.ts → AgentSession
   │
   ├── InteractiveMode   (src/modes/, TUI event loop)
   ├── runPrintMode      (one-shot text/json)
   └── runRpcMode        (JSONL stdin/stdout server)
```

`cli.ts` doubles as the worker host: it declares itself via `declareWorkerHostEntry()`
and dispatches the hidden `__omp_worker_*` argv selectors before loading the command
registry (see `AGENTS.md` → *Worker scripts*).

## Source layout (`src/`)

Top-level entry modules: `cli.ts`, `main.ts`, `sdk.ts`, `index.ts` (SDK barrel),
`config.ts`, `system-prompt.ts`, `thinking.ts`, `workspace-tree.ts`,
`cli-commands.ts`, `telemetry-export.ts`.

| Directory | Responsibility | Reference |
|---|---|---|
| `cli/`, `commands/`, `commit/`, `export/` | Command-line adapters and concrete subcommands | — |
| `modes/` | Interactive TUI, print, and RPC runtimes | [rpc.md](../../docs/rpc.md), [sdk.md](../../docs/sdk.md) |
| `session/` | `AgentSession`, JSONL session tree, storage, history | [session.md](../../docs/session.md), [session-tree-plan.md](../../docs/session-tree-plan.md) |
| `config/`, `registry/`, `secrets/` | Settings, model/provider registry, secret obfuscation | [settings.md](../../docs/settings.md), [config-usage.md](../../docs/config-usage.md), [models.md](../../docs/models.md), [secrets.md](../../docs/secrets.md) |
| `tools/` | Built-in tool implementations + render/meta helpers | [custom-tools.md](../../docs/custom-tools.md), [`tools/`](../../docs/tools/) |
| `exec/`, `eval/`, `ssh/`, `dap/`, `debug/` | Execution backends (shell, py/js kernels, ssh, debugger) | [bash-tool-runtime.md](../../docs/bash-tool-runtime.md), [python-repl.md](../../docs/python-repl.md) |
| `lsp/` | Language-server client/runtime | [lsp-config.md](../../docs/lsp-config.md), [tools/lsp.md](../../docs/tools/lsp.md) |
| `task/`, `swarm/`, `irc/`, `goals/`, `plan-mode/` | Subagent delegation, parallelism, inter-agent IRC, plan mode | [task-agent-discovery.md](../../docs/task-agent-discovery.md), [tools/task.md](../../docs/tools/task.md) |
| `web/`, `exa/` | Fetch, browser automation, search providers, scrapers | [tools/web_search.md](../../docs/tools/web_search.md), [tools/browser.md](../../docs/tools/browser.md) |
| `mcp/` | MCP transport / manager / loader / tool bridge | [mcp-config.md](../../docs/mcp-config.md), [mcp-runtime-lifecycle.md](../../docs/mcp-runtime-lifecycle.md) |
| `extensibility/`, `slash-commands/` | Extensions, hooks, custom tools/commands, skills, plugins | [extensions.md](../../docs/extensions.md), [hooks.md](../../docs/hooks.md), [skills.md](../../docs/skills.md) |
| `capability/`, `discovery/` | Capability registry + provider discovery modules | [extension-loading.md](../../docs/extension-loading.md), [context-files.md](../../docs/context-files.md) |
| `advisor/`, `autolearn/`, `autoresearch/` | Advisor/watchdog, managed skills, background research | [advisor-watchdog.md](../../docs/advisor-watchdog.md) |
| `memories/`, `memory-backend/`, `mnemopi/`, `hindsight/` | Memory subsystems and backends | [memory.md](../../docs/memory.md), [mnemosyne-memory-backend.md](../../docs/mnemosyne-memory-backend.md) |
| `internal-urls/` | Router + handlers (`agent://`, `docs://`, `rule://`, …) | [tree.md](../../docs/tree.md) |
| `tui/`, `collab/` | Low-level TUI primitives, live session sharing | [tui.md](../../docs/tui.md), [collab.md](../../docs/collab.md) |
| `tts/`, `stt/` | Text-to-speech / speech-to-text | — |
| `tiny/`, `auto-thinking/` | Embedded tiny-model experiments, auto thinking level | [local-models.md](../../docs/local-models.md) |
| `async/`, `lib/`, `utils/`, `prompts/`, `edit/` | Shared plumbing, prompt assets, patch/diff engine | [tools/edit.md](../../docs/tools/edit.md) |

## Subsystem reference

### Sessions, persistence, and turn lifecycle
- [session.md](../../docs/session.md) — storage and entry model
- [session-tree-plan.md](../../docs/session-tree-plan.md) — branch/tree architecture
- [session-switching-and-recent-listing.md](../../docs/session-switching-and-recent-listing.md)
- [session-operations-export-share-fork-resume.md](../../docs/session-operations-export-share-fork-resume.md)
- [compaction.md](../../docs/compaction.md) — compaction and branch summaries
- [ttsr-injection-lifecycle.md](../../docs/ttsr-injection-lifecycle.md)
- [non-compaction-retry-policy.md](../../docs/non-compaction-retry-policy.md)
- [handoff-generation-pipeline.md](../../docs/handoff-generation-pipeline.md)

### Configuration, models, providers, auth
- [settings.md](../../docs/settings.md), [config-usage.md](../../docs/config-usage.md)
- [environment-variables.md](../../docs/environment-variables.md)
- [models.md](../../docs/models.md), [providers.md](../../docs/providers.md), [adding-a-provider.md](../../docs/adding-a-provider.md)
- [local-models.md](../../docs/local-models.md)
- [provider-streaming-internals.md](../../docs/provider-streaming-internals.md), [ai-schema-normalize.md](../../docs/ai-schema-normalize.md)
- [toolconv/](../../docs/toolconv/) — per-family tool-call conversion (anthropic, deepseek, gemini, gemma, glm-4.5, harmony, hermes, kimi-k2, minimax, pi-native, qwen3, xml); see also [ERRATA-GPT5-HARMONY.md](../../docs/ERRATA-GPT5-HARMONY.md)
- [keybindings.md](../../docs/keybindings.md)
- [secrets.md](../../docs/secrets.md), [auth-broker-gateway.md](../../docs/auth-broker-gateway.md), [install-id.md](../../docs/install-id.md)
- [system-prompt-customization.md](../../docs/system-prompt-customization.md)

### Tools framework and built-in tools
- Authoring + registry: [custom-tools.md](../../docs/custom-tools.md)
- Output/artifacts: [blob-artifact-architecture.md](../../docs/blob-artifact-architecture.md)
- Gating/approval: [approval-mode.md](../../docs/approval-mode.md), [resolve-tool-runtime.md](../../docs/resolve-tool-runtime.md)
- Per-tool reference: [`docs/tools/`](../../docs/tools/) — `read`, `write`, `edit`, `ast-edit`, `ast-grep`, `grep`, `glob`, `bash`, `eval`, `hub`, `lsp`, `debug`, `task`, `web_search`, `browser`, `github`, `ask`, `todo`, `recall`, `retain`, `reflect`, `checkpoint`, `rewind`

### Execution backends
- [bash-tool-runtime.md](../../docs/bash-tool-runtime.md), [tools/bash.md](../../docs/tools/bash.md)
- [python-repl.md](../../docs/python-repl.md), [notebook-tool-runtime.md](../../docs/notebook-tool-runtime.md), [tools/eval.md](../../docs/tools/eval.md), [tools/hub.md](../../docs/tools/hub.md)
- [tools/debug.md](../../docs/tools/debug.md), [tools/lsp.md](../../docs/tools/lsp.md), [lsp-config.md](../../docs/lsp-config.md)

### Task delegation and subagents
- [task-agent-discovery.md](../../docs/task-agent-discovery.md), [tools/task.md](../../docs/tools/task.md)
- [collab.md](../../docs/collab.md), [tools/hub.md](../../docs/tools/hub.md)

### Web I/O and retrieval
- [tools/web_search.md](../../docs/tools/web_search.md), [tools/browser.md](../../docs/tools/browser.md), [tools/github.md](../../docs/tools/github.md)

### MCP
- [mcp-config.md](../../docs/mcp-config.md), [mcp-runtime-lifecycle.md](../../docs/mcp-runtime-lifecycle.md)
- [mcp-protocol-transports.md](../../docs/mcp-protocol-transports.md), [mcp-server-tool-authoring.md](../../docs/mcp-server-tool-authoring.md)

### Memory
- [memory.md](../../docs/memory.md), [mnemosyne-memory-backend.md](../../docs/mnemosyne-memory-backend.md)
- Memory tools: [tools/recall.md](../../docs/tools/recall.md), [tools/retain.md](../../docs/tools/retain.md), [tools/reflect.md](../../docs/tools/reflect.md)

### Discovery, context, and rules
- [context-files.md](../../docs/context-files.md), [rulebook-matching-pipeline.md](../../docs/rulebook-matching-pipeline.md)
- [advisor-watchdog.md](../../docs/advisor-watchdog.md), [fs-scan-cache-architecture.md](../../docs/fs-scan-cache-architecture.md), [tree.md](../../docs/tree.md)

### TUI and theming
- [tui.md](../../docs/tui.md), [tui-core-renderer.md](../../docs/tui-core-renderer.md), [tui-runtime-internals.md](../../docs/tui-runtime-internals.md)
- [theme.md](../../docs/theme.md)

### Natives (`crates/pi-natives`, `packages/natives`)
- [natives-architecture.md](../../docs/natives-architecture.md), [natives-addon-loader-runtime.md](../../docs/natives-addon-loader-runtime.md), [natives-binding-contract.md](../../docs/natives-binding-contract.md)
- [natives-text-search-pipeline.md](../../docs/natives-text-search-pipeline.md), [natives-shell-pty-process.md](../../docs/natives-shell-pty-process.md), [natives-media-system-utils.md](../../docs/natives-media-system-utils.md)
- [natives-build-release-debugging.md](../../docs/natives-build-release-debugging.md), [natives-rust-task-cancellation.md](../../docs/natives-rust-task-cancellation.md), [porting-to-natives.md](../../docs/porting-to-natives.md)

### Build, release, and porting
- [macos-signing-notarization.md](../../docs/macos-signing-notarization.md)
- [porting-from-pi-mono.md](../../docs/porting-from-pi-mono.md)

## Extending omp

| To add… | Start here |
|---|---|
| A built-in tool | `src/tools/index.ts` (`BUILTIN_TOOLS` / `HIDDEN_TOOLS`) + [custom-tools.md](../../docs/custom-tools.md) |
| An extension (TS/JS module) | [extensions.md](../../docs/extensions.md), [extension-loading.md](../../docs/extension-loading.md), [skills/authoring-extensions.md](../../docs/skills/authoring-extensions.md) |
| A hook | `src/extensibility/hooks/types.ts` + [hooks.md](../../docs/hooks.md), [skills/authoring-hooks.md](../../docs/skills/authoring-hooks.md) |
| A slash command | [slash-command-internals.md](../../docs/slash-command-internals.md) |
| An RPC command | `src/modes/rpc/rpc-types.ts` + [rpc.md](../../docs/rpc.md) |
| A skill | [skills.md](../../docs/skills.md) |
| A marketplace plugin | [marketplace.md](../../docs/marketplace.md), [plugin-manager-installer-plumbing.md](../../docs/plugin-manager-installer-plumbing.md), [skills/authoring-marketplaces.md](../../docs/skills/authoring-marketplaces.md), [gemini-manifest-extensions.md](../../docs/gemini-manifest-extensions.md) |
| A custom MCP tool/server | [mcp-server-tool-authoring.md](../../docs/mcp-server-tool-authoring.md), [custom-tools.md](../../docs/custom-tools.md) |
| A provider | [adding-a-provider.md](../../docs/adding-a-provider.md) |
| Programmatic/SDK use | [sdk.md](../../docs/sdk.md) |

See also `AGENTS.md` at the repo root for repo-wide conventions (Bun-over-Node,
logging, TUI sanitization, generated files, changelog, releasing).
