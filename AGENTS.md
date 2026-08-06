# Development Rules

## Scope

- Primary package: `packages/coding-agent/`; “agent” normally means this implementation.
- Other packages: `ai`, `catalog`, `agent`, `tui`, `natives`, `stats`, `utils`, `llm-router-agent`, and `crates/pi-natives`.
- Import catalog values from `@pk-nerdsaver-ai/pi-catalog/<module>`, never `pi-ai`. Type-only `Model`, `Api`, `ThinkingConfig`, and `Effort` imports from `pi-ai` are allowed.
- Keep changes scoped; review logical clusters before staging. Never commit unless asked.
- Collaboration rules: [docs/multi-agent-fork-collaboration.md](docs/multi-agent-fork-collaboration.md). Surface boundaries: [docs/fork-boundaries.md](docs/fork-boundaries.md).
- Deeper `AGENTS.md` files contain package-specific rules; read them before editing those directories.
- Before editing `packages/coding-agent/` or `packages/catalog/`, read that package's `AGENTS.md`.

## Code

- Avoid `any` and `ReturnType<>`; use ES `#private` fields and methods.
- Use `Promise.withResolvers()`, not the constructor pattern.
- Prefer Bun APIs; use `node:*` only where Bun lacks coverage.
- In async flows avoid sync I/O, unnecessary copies, and repeated `Bun.file()` calls.
- Never run `tsc` or `npx tsc`; use `bun check`.

## Testing

- Test externally observable behavior: output, transitions, errors, and regression-prone boundaries.
- Prefer focused contract or integration tests. Do not add placeholders, tautologies, mocks, or source-text assertions.
- Keep tests full-suite safe: restore spies per test and never use `mock.module()`.
- Exercise real lifecycle transitions and failures. Skip tests only for tiny edits without contract impact.

## Changelog and release

- Add package entries only under `## [Unreleased]`; released sections are immutable.
- Never create GitHub issues/comments or run release/commit commands unless the user asks.
