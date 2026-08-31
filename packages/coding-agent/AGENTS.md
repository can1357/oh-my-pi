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

## Selective PR 45 adoption

- Build on current `main`; use PR 45 only as evidence and as a source of bounded hunks.
- Follow the explicit pull-over inventory in [`.wiki/concepts/pr45-convergence.md`](../../.wiki/concepts/pr45-convergence.md); do not replay behavior that the inventory marks as already present in `main`.
- The remaining coding-agent lanes are: terminal placement of dynamic Fusion prompt content, Fusion singleflight/CAS lifecycle hardening, failure-epoch gating/reset, and the missing CoLab bridge regression contract. Keep them independent from broad provider, task, MCP, SDK, identity, or release rewrites.
- Cache-affinity changes must preserve provider wire contracts and breakpoint ceilings. Verify direct API, OAuth, OpenRouter, rolling-message, opt-out, and caller-override behavior where applicable.
- Fusion is disabled by default. Any Fusion port must preserve that default, keep its dynamic system block terminal for prefix caching, and test session switching, singleflight creation, failure-epoch reset, and manual override behavior.
- CoLab uses protocol v3 and trusted browser hosts. Preserve `/collab`, `/remote-control`, the `collab.json` bridge, `X-OMP-*` relay contracts, and the separation from extension-owned `/remote`.
- A donor branch that needs a compile-clean overlay is not a merge candidate. The port itself must typecheck and test against current `main` source and dependencies.
