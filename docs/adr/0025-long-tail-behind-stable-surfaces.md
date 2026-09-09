# 0025. `dyn` and code surfaces carry the long tail

Status: accepted
Date: 2026-09-02
Area: tools

## Context

0024 fixes the permanent roster and forbids mid-session changes. That leaves every other
capability — MCP servers, extension tools, image generation, database access, browser and desktop
automation — needing a way to be discovered and invoked without touching the grammar.

The post observed two shapes of long-tail API:

- **Bounded operation sets** (a GitHub server with `list_prs`, `create_pr`, …): each operation has
  a JSON schema already; what is missing is a stable way to find and call it.
- **Open-ended operation sets** (a browser, a desktop): the operations compose — navigate, wait,
  evaluate, assert — and a schema per operation would either explode or force one round-trip per
  step against a persistent session.

Both already have a home in the fixed roster: `Bash` and `Eval` are permanent, and they are
composition surfaces.

## Decision

### `dyn`: a discovery protocol inside the shell

`dyn` is a builtin of the in-process shell (0028), not a real CLI, and is also exposed as a Python
function in `Eval` (0036). It is the only discovery mechanism for non-roster tools.

```sh
dyn                                          # list the live catalog
dyn --q github                               # search it
dyn github/list_prs --state open | jq '.[] | .title'
cat query.sql | dyn database/query - --params limit=5
dyn image_gen "blueprint of a frog" > result.json
dyn github/create_pr --help                  # usage synthesized from the JSON schema
```

- `--help` MUST be synthesized from the device's JSON schema (positionals, `--flag/--no-flag`,
  repeatable options, dotted nested keys, `-j/--json` for raw arguments). No hand-written CLI
  definitions.
- Large inputs MUST accept a literal, `@file`, and `-` (stdin) uniformly.
- Output is ordinary text on stdout so it composes with `jq`, redirection, and pipes.
- Image-returning devices emit the same sixel/kitty passthrough the TUI uses; the `Bash` tool
  parses that passthrough out of the output and attaches the images, so remote images (e.g. over
  ssh) render without a special tool.
- The catalog is live: absent devices MUST NOT be advertised or guessed; empty searches are
  retried with different terms.

### Code surfaces for one-API open-ended sets

When many operations belong to one API with session state, expose one stable schema whose payload
is code: Browser keeps `open` / `run` / `close` and runs JavaScript against a persistent tab;
Computer exposes `desktop`, `wait`, and `assert` in a persistent session. Several operations
compose inside one call.

### The rule

**Bounded operation set → schema (reached via `dyn`). Open-ended operation set → code or command
surface.** Neither MUST change the permanent roster after discovery.

## Consequences

- Any MCP server or extension can be mounted at session start or later without a cache
  invalidation; the model discovers it through the shell it already uses.
- Extension authors ship a schema and get a CLI, `--help`, stdin/file handling, and image
  rendering for free — no per-tool ergonomics work (0002).
- Prohibited: exposing a device as a permanent tool "for convenience"; hand-authored CLI parsers
  beside the schema; discovery mechanisms that mutate the roster.
- Cost accepted: hosts that cannot run the in-process shell need a fallback (`tool_only`
  flattening), which reintroduces roster slots for those hosts only.

## Status in omp

**Partial.** Primary implementation: `crates/shell-builtins/src/dyn.rs`. `dyn` lists, documents,
validates, and calls long-tail devices. `crates/envd/src/mcp/discovery.rs` composes native,
Claude, Agent Plugins, Codex, Gemini, OpenCode, Cursor, Windsurf, VS Code, and standalone MCP
sources with deterministic provider/scope precedence; reload re-runs discovery without changing
the permanent model-facing roster. The `image_gen@4` device in
`crates/envd/src/media_devices.rs` is mounted only through this surface and implements a
structured generation/edit schema, configured/active/automatic provider ordering, bounded image
inputs and outputs, typed provider-attempt updates and faults, cancellation, a three-minute
deadline, content-addressed retention, and optional atomic workspace output. The `tts@4` device in
`crates/envd/src/{media_devices,media_tts}.rs` likewise performs real local/xAI/DeepInfra synthesis
with typed progress, cancellation, timeout, artifact retention, and atomic workspace output.
The `security_scan@2` device in `crates/tools/src/security_scan.rs` and
`crates/envd/src/security_scan{.rs,/}` provides durable local and cloud scan lineage, exact
credential selection, recursive public-export redaction, validated evidence, bounded cloud
responses, cancellable operations, SARIF interchange, and isolated remediation worktrees through
the generated `dyn` schema. MCP mounts in `crates/envd/src/mcp/manager.rs` publish generation-fenced
live tool/resource/prompt diffs into the same `dyn` catalog, recover failed startup and disconnected
servers through bounded shared reconnects, persist and invalidate config-keyed tool definitions,
buffer startup notifications, and expose setting-gated URI-debounced resource updates. MCP text
results retain their Markdown presentation semantic while the shell writes identical source bytes
for composition. The `browser@3` code surface in `crates/tools/src/browser.rs`,
`crates/envd/src/browser_daemon.rs`, and `crates/webview/src/{automation.rs,remote/chromium.rs}`
implements session-owned named tabs, owned launch and non-owning CDP/relay attachment, a lifted
JavaScript helper vocabulary, bounded waits/navigation/actions/extraction, CAS-backed screenshots
and downloads, run-scoped request interception cleanup, and forcibly closable run surfaces.
Gap: Eval binding and terminal graphics passthrough remain unproved.

## References

- The Harness Playbook, "The tool surface" — "Put the long tail behind stable surfaces"
- 0024 (why the roster is fixed), 0028 (the interpreter `dyn` lives in), 0036 (Eval/Python)
- `crates/shell-builtins/src/dyn.rs`, `crates/shell-builtins/src/host.rs`
- `crates/envd/src/devices_host.rs`, `crates/envd/src/mcp/manager.rs`
- `crates/tools/src/device.rs`, `crates/tool/src/registry.rs`
