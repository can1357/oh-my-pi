# Development Rules

## Scope

- Primary package: `packages/coding-agent/`. "agent" usually means this implementation, not the assistant.
- Other packages: `ai` LLM client, `catalog` model catalog, `agent` runtime, `tui`, `natives`, `stats`, `utils`, `llm-router-agent`, `crates/pi-natives`.
- Catalog values import from `@pk-nerdsaver-ai/pi-catalog/<module>`, never through `@pk-nerdsaver-ai/pi-ai`; type-only `Model`, `Api`, `ThinkingConfig`, `Effort` from `pi-ai` are okay.
- Review logical clusters before staging; never commit `AGENTS.md` without `git diff --stat`.

## Code Quality

- No `any` unless necessary. Never use `ReturnType<>`; write the actual type.
- No inline imports (`await import()`, `import("pkg").Type`); use top-level imports.
- Check `node_modules` for external API types before guessing.
- Prefer barrel `export * from "./module"`.
- Use ES `#private`; avoid `private`/`protected`/`public` except constructor parameter properties.
- Use `Promise.withResolvers()` over `new Promise((resolve, reject) => ...)`.
- Prompts live in `.md` files imported with `{ type: "text" }`; never build prompt strings in code.
- Worker kinds: verify against `cli.ts`, keep direct-module fallback, validate with `omp --smoke-test`.

## Bun First

- Prefer Bun APIs: `Bun.file`, `Bun.write`, Bun Shell/`Bun.spawn`, `Bun.sleep`, `bun:sqlite`, `Bun.hash`, `Bun.JSON5`, `Bun.JSONL`, `Bun.stringWidth`, `Bun.wrapAnsi`.
- Use `node:*` only where Bun lacks coverage. Namespace imports for Node modules.
- Avoid sync APIs in async flows, `mkdir` before `Bun.write`, repeated `Bun.file(path)`, and `Buffer.from(await Bun.file(x).arrayBuffer())` where `fs.readFile` fits.
- Streams: prefer `readStream`/`readLines`; manual loops only for SSE/streaming JSON-RPC.

## Generated Files

- Never edit `packages/catalog/src/models.json` directly. Fix sources: provider resolver/descriptors, `generate-models.ts`, or `model-thinking.ts`; regenerate with `bun --cwd=packages/catalog run generate-models`; test source behavior.

## Coding-Agent UI

- Never use `console.*` in coding-agent; use `logger` from `@pk-nerdsaver-ai/pi-utils`.
- Sanitize displayed text: tabs to spaces, width truncation, shortened paths, preview limits. Keep streaming bash `__partialJson` consistent through live and rebuilt transcript paths.

## Commands and Tests

- Never commit unless asked.
- Never run `tsc`/`npx tsc`; use `bun check`.
- Test observable contracts: behavior, output shape, state transitions, error mapping, parsing boundaries.
- No placeholder/tautology tests. Avoid implementation-coupled assertions.
- Full-suite safe: no file-wide mutation of `Bun.*`, `process.platform`, `process.env`, or `Bun.env`; use `vi.spyOn` + `vi.restoreAllMocks()`.
- Never use `mock.module()`; spy on imported module objects.
- One test per invariant/transition for stateful code. Trigger real failure paths. Type guarantees belong in type checks.

## Release Notes

- Changelogs: `packages/*/CHANGELOG.md`, under `## [Unreleased]` with standard sections. Never edit released sections.
- Release command: `bun run release`.

## Maintenance

- Keep this file small; it ships in prompt context. Prune before adding rules.