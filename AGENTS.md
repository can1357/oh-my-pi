# Development Rules

## Default Context

This repo contains multiple packages, but **`packages/coding-agent/`** is the primary focus. When the user says "agent" or asks "why is agent doing X", they mean the **coding-agent package implementation**, not you.

| Package | Description |
| --- | --- |
| `packages/ai` | Multi-provider LLM client with streaming support |
| `packages/catalog` | Model catalog: bundled models.json, provider descriptors, identity/classification |
| `packages/agent` | Agent runtime with tool calling and state management |
| `packages/coding-agent` | Main CLI application (primary focus) |
| `packages/tui` | Terminal UI library with differential rendering |
| `packages/natives` | Bindings for native text/image/grep operations |
| `packages/stats` | Local observability dashboard (`omp stats`) |
| `packages/utils` | Shared utilities (logger, streams, temp files) |
| `crates/pi-natives` | Rust crate for performance-critical text/grep ops |

**Catalog import convention**: import catalog *values* from `@pk-nerdsaver-ai/pi-catalog/<module>` — never via `@pk-nerdsaver-ai/pi-ai`. Type-only imports of `Model`, `Api`, `ThinkingConfig`, `Effort` from `pi-ai` are fine.

- **Commit hygiene**: review clusters by logical feature before staging; never commit `AGENTS.md` itself without `git diff --stat`.

## Code Quality

- No `any` unless absolutely necessary.
- **NEVER use `ReturnType<>`** — use the actual type name.
- **NEVER use inline imports** (`await import()`, `import("pkg").Type`). Always top-level.
- Check `node_modules` for external API types instead of guessing.
- **Barrel exports**: prefer `export * from "./module"` over named re-exports, including `export type { ... } from`.
- **Class privacy**: use ES `#private` fields; leave externally accessible members bare. No `private`/`protected`/`public` keywords except on constructor parameter properties.
- **Promises**: use `Promise.withResolvers()` instead of `new Promise((resolve, reject) => ...)`.
- **Prompts**: never build prompts in code. Import `.md` files via `import content from "./prompt.md" with { type: "text" }`.
- **Worker scripts**: the omp CLI is also the worker host. Verify new worker kinds against `cli.ts` before editing; keep a direct-module fallback for non-CLI hosts and validate with `omp --smoke-test`.

## Bun Over Node

Use Bun APIs where cleaner; fall back to `node:*` only for what Bun doesn't cover. **Never spawn shell commands for operations with proper APIs.**

| Operation | Use | Not |
| --- | --- | --- |
| File read/write | `Bun.file()`, `Bun.write()` | `readFileSync`, `writeFileSync` |
| Spawn process | `` $`cmd` ``, `Bun.spawn()` | `child_process` |
| Sleep | `Bun.sleep(ms)` | `setTimeout` promise |
| Binary lookup | `$which("git")` from `@pk-nerdsaver-ai/pi-utils` | `spawnSync(["which", "git"])` |
| HTTP server | `Bun.serve()` | `http.createServer()` |
| SQLite | `bun:sqlite` | `better-sqlite3` |
| Hashing | `Bun.hash()`, `Bun.password.*`, WebCrypto | `node:crypto` |
| Path resolution | `import.meta.dir`, `import.meta.path` | `fileURLToPath` dance |
| JSON5 | `Bun.JSON5.parse()` / `.stringify()` | `json5` package |
| JSONL | `Bun.JSONL.parse()` / `.parseChunk()` | `text.split("\n").map(JSON.parse)` |
| String width | `Bun.stringWidth()` | `get-east-asian-width`, custom |
| Text wrapping | `Bun.wrapAnsi()` | custom ANSI-aware wrappers |

Prefer **Bun Shell** for simple commands; use `Bun.spawn`/`Bun.spawnSync` only for long-running processes, streaming I/O, or lifecycle control. When using `pipe` mode, cast the stream to `ReadableStream<Uint8Array>`.

**Node module imports:** use namespace imports (`import * as fs from "node:fs/promises"`; use `node:fs` only if sync is needed).

**File I/O:** prefer `Bun.file()`, `Bun.write()`. Use `node:fs/promises` for directory ops (`mkdir`, `rm`, `readdir`). Avoid sync APIs in async flows.

**Anti-patterns:** `existsSync`/`readFileSync`/`writeFileSync` in async code; `mkdir` before `Bun.write`; `if (await file.exists()) { await file.json() }` instead of try-catch with `isEnoent`; reusing `Bun.file(path)` for the same path; `Buffer.from(await Bun.file(x).arrayBuffer())` instead of `await fs.readFile(path)`.

**Streams:** prefer centralized helpers (`readStream`, `readLines` from `./utils/stream`); manual loops only for SSE/streaming JSON-RPC.

**Misc:** `Bun.sleep()`; `Bun.password` for bcrypt; `Bun.stringWidth()`; `Bun.wrapAnsi()`.

## Generated Files

**NEVER edit `packages/catalog/src/models.json` directly.** Fix the source instead:
- Resolution rules / per-id overrides → resolver in `packages/catalog/src/provider-models/openai-compat.ts`.
- Provider catalog entries → `CATALOG_PROVIDERS` in `packages/catalog/src/provider-models/descriptors.ts`.
- Generator-level fixups → `packages/catalog/scripts/generate-models.ts`.
- Thinking policies → `packages/catalog/src/model-thinking.ts`.

Regenerate with `bun --cwd=packages/catalog run generate-models` and commit JSON alongside source changes. Add regression tests against resolver/descriptor, not JSON.

## Logging

**NEVER use `console.*` in coding-agent** — it corrupts TUI rendering. Use `import { logger } from "@pk-nerdsaver-ai/pi-utils"`.

## TUI Sanitization

Sanitize all displayed text: **tabs → spaces** (`replaceTabs`), **truncate** (`truncateToWidth`/`ui.truncate`, use `TRUNCATE_LENGTHS`), **shorten paths** (`shortenPath`), **preview limits** from `PREVIEW_LIMITS`. Apply to success, error, diff, and streaming paths. For streaming bash previews, preserve `__partialJson` through `event-controller.ts`, `ui-helpers.ts`, and `tool-execution.ts` so both live and rebuilt transcript paths stay consistent.

## Commands

- NEVER commit unless asked.
- Never use `tsc`/`npx tsc` — always `bun check`.

## Testing Guidance

Test observable contracts, not easy internals.
- Defend a concrete contract: behavior, output shape, state transition, error mapping, or parsing boundary.
- No placeholder tests, tautologies, or "the code ran" assertions.
- Prefer contract-level tests over implementation details; avoid duplicated coverage.
- Full-suite safe: no file-wide mutations of `Bun.*`, `process.platform`, `process.env`, `Bun.env`. Use `vi.spyOn` + `vi.restoreAllMocks()`.
- **Never use `mock.module()`** — it leaks across files; spy on the imported module object instead.
- For stateful code, prefer one test per invariant/transition.
- Trigger real failure paths; don't instantiate error classes directly.
- Smoke tests only when they catch what narrower tests miss.
- Assert exact strings/order only when downstream code parses them.
- Compile-time guarantees → type checks, not runtime placeholders.
- Prefer focused package-local verification.

## Changelog

Location: `packages/*/CHANGELOG.md`. New entries under `## [Unreleased]`, sections: Breaking Changes, Added, Changed, Fixed, Removed. Never modify already-released sections; release script normalizes order.

## Releasing

1. Ensure all changes are in `[Unreleased]`.
2. Run `bun run release`.

## Maintenance

**Keep this file under ~8KB (~2K tokens).** If it grows beyond that, it negates its own purpose by bloating every system prompt. Prune redundant prose, code examples, and explanations before adding new rules.
