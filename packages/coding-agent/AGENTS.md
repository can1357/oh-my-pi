# Coding-Agent Development Rules

## Prompt and UI

- Keep prompts in static `.md` files with Handlebars for dynamic content. Import them with `with { type: "text" }`; never build prompts in code or read them at runtime.
- Never use `console.*`; use `logger` from `@pk-nerdsaver-ai/pi-utils`.
- Sanitize rendered text: tabs via `replaceTabs()`, lines via `truncateToWidth()`/`ui.truncate()` with `TRUNCATE_LENGTHS`, paths via `shortenPath()`, and limits via `PREVIEW_LIMITS`.
- Bash previews may need raw `partialJson`; preserve preview-only fields through event-controller, transcript rebuilding, and merged rendering. Render bash calls before a result exists in both live and rebuilt transcripts.

## Workers

Workers re-enter `cli.ts`, which dispatches hidden `__omp_worker_<name>` selectors before loading commands. Spawn with `workerHostEntry()` and retain the direct-module fallback for tests and SDK embedding. Every new worker needs a CLI selector; never add a compiled worker entrypoint or `with { type: "file" }`. Validate with `omp --smoke-test`.

## System prompts

Keep stable harness instructions separate from dynamic project context so providers can cache prefixes. Test rendered behavior, capability gating, and prompt deduplication rather than source text or exact defaults.
