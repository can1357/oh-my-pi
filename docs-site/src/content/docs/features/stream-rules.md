---
title: Stream Rules
description: Rules that watch the agent's output as it streams and interrupt or inject a reminder when a pattern matches.
coverage: B
---

Stream rules — Time-Traveling Stream Rules, or TTSR — let you watch the agent's output as it streams and have omp interrupt the turn, retry, and inject a reminder the moment a pattern matches. A rule with no `condition` or `astCondition` is just a rulebook rule (see [Context Files](/oh-my-pi/configuration/context-files/)); once it has a condition, it becomes a TTSR rule.

## What "interrupting" means

The runtime walks the configured provider chain, normalizes every rule into a single `Rule` shape, and splits the result into rulebook rules, always-apply rules, and TTSR rules. A TTSR rule is registered only when its `condition` (regex) or `astCondition` (ast-grep patterns) is non-empty and the manager accepts it. The agent's text, thinking, and tool-argument streams are monitored as the turn streams; on a match, the agent is aborted, a `ttsr_triggered` session event fires, and a 50ms-deferred retry is scheduled. The retry appends a hidden `custom_message` with `customType: "ttsr-injection"` containing the rule reminder, then calls `agent.continue()` to regenerate from there.

:::caution
The retry is best-effort. State can change during the 50ms window (user interruption, mode actions, additional events) and `agent.continue()` is awaited in a try/catch — failures are swallowed and the TTSR resume gate is resolved without retrying.
:::

## Writing a TTSR rule

Drop a markdown file into `.omp/rules/*.md` (project), `~/.omp/agent/rules/` (user), or wherever your tool's rule source lives — Cursor `.mdc`, Cline `.clinerules`, Windsurf `.windsurf/rules/*.md`, Agents `.agent/rules/*.{md,mdc}`, or `~/.omp/agent/RULES.md` (always-apply). Filename without extension is the rule's `name`, used for `rule://<name>` lookups and the deduplication key across sources. Two different files with the same `name` are the same logical rule; first-wins by source priority (native → omp-plugins → agents → cursor/windsurf → cline → builtin-defaults).

Frontmatter fields the rule shape carries:

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `description` | string | empty | One-line summary; required to be addressable in the rulebook. |
| `globs` | string list | empty | Global file-path gate. When present, the rule only matches if the match context includes at least one matching file path. |
| `alwaysApply` | boolean | false | Inject the full content into the system prompt; the rule does **not** become a TTSR rule when it is always-apply-only. |
| `condition` | string list | empty | Regexes (OR'd) that match against assistant text, thinking, or tool argument deltas. Legacy alias `ttsr_trigger` is accepted. A leading `(?i)`, `(?m)`, or `(?s)` inline flag group is translated to the equivalent JavaScript `RegExp` flags. |
| `astCondition` | string list | empty | ast-grep patterns (OR'd). Only matches on **edit/write tool argument streams**; the language is inferred from the file extension on the tool's path argument. A repeated metavariable inside one pattern must bind the same node in both spots. |
| `scope` | string list | `text, tool` | Streams to watch. Omitting `scope` watches assistant prose (`text`) and all tool arguments (`tool`), but not thinking. Valid tokens: `text`, `thinking`, `tool` (or `toolcall`), and `tool:<name>(<path-glob>)`. |
| `interruptMode` | enum | `ttsr.interruptMode` setting | Override the global TTSR interrupt mode for this rule. One of `never`, `prose-only`, `tool-only`, `always`. |

A `condition` token that looks like a file glob becomes `tool:edit(<glob>)` and `tool:write(<glob>)` scope entries plus a catch-all `.*` condition. `astCondition` tokens never trigger this shorthand.

### Example

```markdown
---
description: "Never use `any` in TypeScript annotations or assertions"
condition: ": any|as any"
scope: "tool:edit(*.ts), tool:edit(*.tsx), tool:write(*.ts), tool:write(*.tsx)"
interruptMode: never
---

Never use `: any` or `as any`. They disable type checking exactly where the boundary needs precision.

## Use instead

- `unknown` for unvalidated input.
```

The matching builtin rule is shipped as `ts-no-any`; rules are deduplicated by name, so a same-named user/project rule overrides the bundled one.

## What you see when a rule fires

The visible UX depends on the rule's `interruptMode` and the match `source` (where the pattern was seen: `text`, `thinking`, or `tool`).

- **`interruptMode: always` (default) with a `text` or `thinking` match** — the agent's stream aborts. After the 50ms deferred-retry timer:
  - if `ttsr.contextMode` is `discard` (default), the partial assistant message is removed before retry,
  - if `ttsr.contextMode` is `keep`, the partial output stays and the reminder is appended after it,
  - the reminder template renders as
    ```xml
    <system-interrupt reason="rule_violation" rule="{{name}}" path="{{path}}">
    ...
    {{content}}
    </system-interrupt>
    ```
    and is appended as a hidden `custom_message` with `customType: "ttsr-injection"`.
  - `agent.continue()` retries generation. A `TtsrNotificationComponent` renders in the TUI, and `session.isTtsrAbortPending` suppresses showing the aborted stop reason as a visible failure.

- **`interruptMode: never` (default for the shipped language rules) with a `tool` match** — the rule is bucketed against the matched tool call, the stream is **not** aborted, and there is no deferred follow-up turn. When the tool produces its result, the `afterToolCall` hook prepends a rendered `<system-reminder reason="rule_violation" rule="..." path="...">...</system-reminder>` block to `ctx.result.content`, then persists a `ttsr_injection` entry. The tool's own `toolResult` content is preserved verbatim; renderers that assume `content[0]` is the tool's primary output must scan past any block whose text begins with `<system-reminder reason="rule_violation"`.

- **`interruptMode: never` with a `text` or `thinking` match** — no abort. The rule is queued in pending injections and, after a successful non-error, non-aborted assistant message, the hidden `ttsr-injection` custom message is injected as a follow-up and continuation is scheduled.

When the parent assistant message ends with `stopReason === "aborted"` or `"error"` before the matched tool's result arrives, the per-tool buckets are cleared — those rules are not persisted as injected and remain eligible to re-trigger on a future turn (subject to repeat policy).

:::note
Injected-rule state is persisted as `ttsr_injection` entries on the session and restored by `createAgentSession()` from `existingSession.injectedTtsrRules`, so suppression survives session reload/resume.
:::

## Repeat policy

Each rule tracks `lastInjectedAt` and the session's `messageCount` (incremented on `turn_end`, not on stream chunks).

- `ttsr.repeatMode: once` (default) — a rule can trigger only once after it has an injection record.
- `ttsr.repeatMode: after-gap` — a rule can re-trigger when `messageCount - lastInjectedAt >= ttsr.repeatGap`. Default gap is 10 messages.

## Built-in rules

omp ships 28 language-specific rules in `packages/coding-agent/src/discovery/builtin-rules/`. They are all TTSR rules with `interruptMode: never` and a `scope` that targets the language's edit/write streams. Same-named rules in higher-priority sources override them; disable them all with `ttsr.builtinRules: false`, or list a name in `ttsr.disabledRules` to drop one.

| Name | Description |
| --- | --- |
| `go-add-cleanup` | Prefer `runtime.AddCleanup` over `runtime.SetFinalizer` for new code (Go 1.24) |
| `go-bench-loop` | Use `for b.Loop()` in benchmarks instead of the `for i := 0; i < b.N; i++` loop (Go 1.24) |
| `go-exp-promoted` | Use the standard library `slices` and `maps` packages instead of `golang.org/x/exp/{slices,maps}` |
| `go-ioutil` | Use `io` and `os` instead of the deprecated `io/ioutil` package |
| `go-join-hostport` | Build network addresses with `net.JoinHostPort`, not `fmt.Sprintf("%s:%d", host, port)` — the Sprintf form breaks on IPv6 |
| `go-new-expr` | Use `new(expr)` for pointer-to-value helpers instead of `func ptr[T any](v T) *T { return &v }` (Go 1.26) |
| `go-rand-v2` | Prefer `math/rand/v2` over the legacy `math/rand` package |
| `go-range-int` | Use `for i := range n` instead of the C-style `for i := 0; i < n; i++` loop (Go 1.22) |
| `rs-box-leak` | Never use `Box::leak` — it intentionally leaks memory |
| `rs-future-prelude` | Use `Future` not `std::future::Future` — it's in the prelude |
| `rs-lazylock` | Prefer `std::sync::LazyLock` over `OnceLock` and `once_cell` |
| `rs-match-ergonomics` | Use match ergonomics instead of `ref`/`ref mut` patterns |
| `rs-parking-lot` | Use `parking_lot` instead of `std::sync` for `Mutex`/`RwLock` |
| `rs-result-type` | `Result` type aliases must include a defaulted error type parameter |
| `ts-bare-catch` | Use bare `catch {` when the error binding is unused |
| `ts-import-type` | Use `import type`, not `import('pkg').Type` in type positions |
| `ts-no-any` | Never use `any` in TypeScript annotations or assertions — use `unknown`, generics, a schema parse at trust boundaries, or the actual type |
| `ts-no-deprecated-leftovers` | Do not leave `@deprecated` shims behind after refactors — update call sites and remove the old API |
| `ts-no-dynamic-import` | Do not use `await import()` — use static imports unless dynamic loading is unavoidable |
| `ts-no-inline-cast-access` | Don't assert an inline object type and immediately read a property — validate with a schema parse, narrow with `in`/`typeof`, or use a validated named type |
| `ts-no-local-is-record` | Never use `isRecord` |
| `ts-no-return-type` | Do not use `ReturnType<typeof fn>` — name the type explicitly |
| `ts-no-test-timers` | Do not use real timers (`Bun.sleep`, `setTimeout`, `setInterval`) in tests — drive time with fake timers instead |
| `ts-no-tiny-functions` | Do not extract 1-2 line functions that only wrap an expression — inline them |
| `ts-promise-with-resolvers` | Use `Promise.withResolvers()` instead of `new Promise()` constructor |
| `ts-redundant-clear-guard` | Do not guard `clearTimeout`/`clearInterval`/`clearImmediate` with a truthiness or null/undefined check — they accept `null` and `undefined` |
| `ts-set-map` | Prefer `Record<K, V>` for small static literals; use `Set`/`Map` for anything dynamic |

## Settings

`omp config set <key> <value>`; see [Settings](/oh-my-pi/configuration/settings/) for scopes and precedence.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `ttsr.enabled` | boolean | `true` | When `false`, `TtsrManager.addRule()` refuses registration and `checkDelta` / `checkSnapshot` / `checkAstSnapshot` all return empty. |
| `ttsr.contextMode` | enum | `discard` | `discard` drops the partial assistant message before the reminder retry; `keep` leaves it in conversation state. |
| `ttsr.interruptMode` | enum | `always` | When to interrupt mid-stream vs inject a warning after completion: `always` (prose and tool), `prose-only`, `tool-only`, `never`. |
| `ttsr.repeatMode` | enum | `once` | `once` allows a single injection per session; `after-gap` re-allows the rule after `ttsr.repeatGap` messages. |
| `ttsr.repeatGap` | number | `10` | Messages before a rule can trigger again, when `ttsr.repeatMode` is `after-gap`. Measured in completed turns (`turn_end` increments). |
| `ttsr.builtinRules` | boolean | `true` | Load the bundled defaults; drop the set entirely with `false`. |
| `ttsr.disabledRules` | string list | `[]` | Rule names to ignore entirely; applies to bundled defaults and your own rules. |

## `omp ttsr` — inspect and test rules

```text
omp ttsr list
omp ttsr test 'const x: any = 1'
omp ttsr test src/foo.ts
omp ttsr test --file src/foo.ts --source text
omp ttsr test --rule .omp/rules/no-any.md --source tool --path src/foo.ts 'const x: any = 1'
echo 'Box::leak(&mut v)' | omp ttsr test --file - --path src/lib.rs
omp ttsr test --source tool --tool edit --path src/foo.ts 'const x: any = 1'
omp ttsr scan
omp ttsr scan src/
```

| Flag | Effect |
| --- | --- |
| `action` | One of `list` (default), `test`, or `scan` |
| `--file` | Snippet file path, or `-` for stdin (for `ttsr test`). When omitted and the positional resolves to an existing file, that file is used. |
| `-r, --rule` | Rule markdown file to test in isolation; skips project rule loading |
| `--source` | Match source: `text`, `thinking`, or `tool`. Inferred from `--file` when omitted: `tool` for source files, `text` otherwise. |
| `--tool` | Tool name when `--source tool` (e.g. `edit`, `write`); defaults to `edit` |
| `-p, --path` | Candidate file path for scope/glob matching and AST language inference |
| `-v, --verbose` | Show every evaluated rule, not just triggered ones |
| `--json` | Output JSON |
| `--no-gitignore` | `ttsr scan` only: include files excluded by `.gitignore` |
| `--max-bytes` | `ttsr scan` only: maximum file size to scan in bytes; `0` disables the limit |

`omp ttsr test` runs a snippet through the real TTSR matching pipeline and reports which rules would trigger. `omp ttsr scan` walks a directory and reports matches per file.

## Sharp edges

- Invalid `condition` regexes are skipped with a warning; other conditions/rules continue. An unreachable `scope` (one that excludes every monitored stream) is also skipped.
- A rule with both a trigger `condition` and `alwaysApply: true` goes to TTSR only if registration accepts it; otherwise it can fall through to always-apply. A rule with `alwaysApply: true` and a `description` is always-apply only.
- `astCondition` is only evaluated on `edit`/`write` tool-argument streams, against the tool's `matcherDigest` — `new_text` in replace mode, the `+` body rows or added diff lines in other edit update modes, the full content for a patch create, and the entire `content` for `write`. It is **not** the whole prospective file; pre-existing target content is invisible unless the edit repeats it in its source-bearing payload.
- YAML gotcha: do not write `scope: "text","thinking"` — adjacent quoted scalars are not valid YAML. Put the comma inside one string (`scope: "text, thinking"`) or use a YAML sequence (`scope: [text, thinking]`).
- `ttsr.repeatGap` increments at `turn_end`, so mid-turn stream chunks do not advance the counter.
