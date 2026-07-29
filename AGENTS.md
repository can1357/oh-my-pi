# Development Rules

## Scope

- Primary package: `packages/coding-agent/`; “agent” normally means this implementation.
- Other packages: `ai`, `catalog`, `agent`, `tui`, `natives`, `stats`, `utils`, `llm-router-agent`, and `crates/pi-natives`.
- Import catalog values from `@pk-nerdsaver-ai/pi-catalog/<module>`, never `pi-ai`. Type-only `Model`, `Api`, `ThinkingConfig`, and `Effort` imports from `pi-ai` are allowed.
- Before staging, review logical clusters. Never commit `AGENTS.md` without checking `git diff --stat`.
- Collaboration/queue rules: [docs/multi-agent-fork-collaboration.md](docs/multi-agent-fork-collaboration.md). Surface boundaries: [docs/fork-boundaries.md](docs/fork-boundaries.md).

## GitHub and Git

- Unless the user supplies exact text, never create GitHub issues or post GitHub comments.
- Never commit unless asked.

## Code Quality

- Avoid `any`; never use `ReturnType<>`.
- No inline/dynamic imports (`await import()` or `import("pkg").Type`). Use top-level imports. Inspect external types in `node_modules` instead of guessing.
- In pure barrels, prefer `export * from "./module"`. Resolve star ambiguity by removing redundant export paths, not adding duplicate named exports.
- Use ES `#private`; omit `private`/`protected`/`public` on fields and methods except required constructor parameter properties.
- Use `Promise.withResolvers()`, not `new Promise((resolve, reject) => ...)`.
- Prompts belong in static `.md` files with Handlebars for dynamic content. Import with `import content from "./prompt.md" with { type: "text" }`; never construct prompts in code or read them at runtime.

### Worker scripts

Workers re-enter the CLI entrypoint. `cli.ts` calls `declareWorkerHostEntry()` and dispatches hidden selectors (`__omp_worker_stats_sync`, `__omp_worker_tab`, `__omp_worker_js_eval`, `__omp_worker_tiny_inference`) before loading commands. Spawn with:

```ts
import { workerHostEntry } from "@pk-nerdsaver-ai/pi-utils";
const hostEntry = workerHostEntry();
const worker = hostEntry
	? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_<name>"] })
	: new Worker(new URL("./<worker>.ts", import.meta.url).href, { type: "module" });
```

Inside the CLI host, `workerHostEntry()` is `Bun.main`; elsewhere (`bun test`, SDK embedding, standalone tools) it returns `null`, so retain the direct-module fallback. Every new worker must add a `cli.ts` selector. Never add separate compiled worker entrypoints or use `with { type: "file" }`. Validate with `omp --smoke-test`; add a sibling smoke only for a distinct module graph.

## Bun First

- Prefer Bun APIs: `Bun.file`, `Bun.write`, Bun Shell/`Bun.spawn`, `Bun.sleep`, `bun:sqlite`, `Bun.hash`, `Bun.JSON5`, `Bun.JSONL`, `Bun.stringWidth`, and `Bun.wrapAnsi`.
- Use `node:*` only when Bun lacks coverage; namespace-import Node modules.
- In async flows avoid sync APIs, unnecessary `mkdir` before `Bun.write`, repeated `Bun.file(path)`, and `Buffer.from(await Bun.file(x).arrayBuffer())` where `fs.readFile` fits.
- Prefer `readStream`/`readLines`; reserve manual stream loops for SSE or streaming JSON-RPC.

## Generated Files

- Never edit `packages/catalog/src/models.json`. Fix resolver/descriptors, `generate-models.ts`, or `model-thinking.ts`, then run `bun --cwd=packages/catalog run generate-models` (or `bun run gen:models`) and commit generated JSON with the source.
- Test resolver/descriptor behavior, not bundled JSON, so upstream metadata changes do not invalidate the regression.

## Coding-Agent UI

- Never use `console.*` in coding-agent; use `logger` from `@pk-nerdsaver-ai/pi-utils`.
- Sanitize all rendered text, including success, errors, diffs, and streaming previews: tabs via `replaceTabs()`, lines via `truncateToWidth()`/`ui.truncate()` with `TRUNCATE_LENGTHS`, paths via `shortenPath()`, and limits via `PREVIEW_LIMITS`. No ad-hoc limits.
- Bash streaming previews may require raw `partialJson` because parsed arguments lag. Preserve preview-only fields through `event-controller.ts`, transcript rebuilding in `ui-helpers.ts`, and merged rendering in `tool-execution.ts`.
- `ToolExecutionComponent.#buildRenderContext()` must render bash calls before a result exists. Verify both live streaming and rebuilt transcripts.

## Commands

- Never run `tsc` or `npx tsc`; use `bun check`.

## Testing

Test externally observable contracts: behavior, output shape, transitions, error mapping, or regression-prone parsing boundaries.

- No placeholders, tautologies, bare `not.toThrow()`, non-empty checks, “length grew,” or prompt-exists assertions without semantics.
- Prefer contract/integration coverage over implementation wiring. Do not duplicate the same contract across abstraction levels.
- Tests must be full-suite safe. Avoid file-wide mutation of `Bun.*`, `process.platform`, `process.env`, or `Bun.env`; use per-test `vi.spyOn()` and restore each spy individually in `afterEach`:
  ```ts
  const spy = vi.spyOn(target, "method");
  afterEach(() => spy.mockRestore());
  ```
- **Do not call `vi.restoreAllMocks()` / `jest.restoreAllMocks()` / `mock.restore()` in a file that spies a module namespace.** All three are the *same* native function — `vi.restoreAllMocks === mock.restore` is `true` under Bun 1.3.14 — and the global restore walks Bun's entire mock registry to unpatch the sealed ESM namespace, segfaulting the process (`panic(main thread): Segmentation fault at address 0x4`, exit 132) once a later file in the same run imports an overlapping module graph. Test buckets share one process, so the crash takes every co-resident file down with it. A blanket restore is only safe when nothing in the file spied a namespace — spies on ordinary objects and class prototypes are unaffected.
- Never use `mock.module()`; it leaks through Bun’s global module registry. Namespace-import dependencies and spy on exports/pass `.run` methods.
- For lifecycle code, test invariants/transitions. For errors, trigger the real failure and assert surfaced behavior rather than constructing error classes or inspecting internal metadata.
- Smoke tests are only for failures narrower tests cannot expose. “Package boots” alone is insufficient.
- Assert exact bytes/order only when downstream consumers depend on them. Use type checks for compile-time guarantees.
- Never source-grep in tests. Do not read implementation `.ts`/`.rs`/build scripts and assert textual calls/imports/comments. Execute behavior, inspect generated output, use smoke probes, or enforce structure through type/lint rules.
- Skip tests for tiny low-risk edits unless they protect a real contract. Prefer focused package-local verification.

## Changelog

Package changelogs live at `packages/*/CHANGELOG.md`. Add entries only under `## [Unreleased]`; released sections are immutable. Section order: `Breaking Changes`, `Added`, `Changed`, `Fixed`, `Removed`. Do not flag ordering/formatting in reviews; release tooling normalizes it.

- Internal issue: `Fixed foo ([#123](https://github.com/kingkillery/oh-my-pk/issues/123)).`
- External contribution: `Added X ([#456](https://github.com/kingkillery/oh-my-pk/pull/456) by [@user](https://github.com/user)).`

## Releasing

Ensure every affected package has `[Unreleased]` entries, then run `bun run release`; it handles versions, changelogs, commit, tag, publish, and fresh unreleased sections.

## Maintenance

Keep this file below the context-bloat threshold; it is injected into every request.
