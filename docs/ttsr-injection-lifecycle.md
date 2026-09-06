# TTSR Injection Lifecycle

This document covers the current Time Traveling Stream Rules (TTSR) runtime path from rule discovery to stream interruption, retry injection, extension notifications, and session-state handling.

## Implementation files

- [`../src/sdk.ts`](../packages/coding-agent/src/sdk.ts)
- [`../src/export/ttsr.ts`](../packages/coding-agent/src/export/ttsr.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/session/ttsr-coordinator.ts`](../packages/coding-agent/src/session/ttsr-coordinator.ts)
- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/prompts/system/ttsr-interrupt.md`](../packages/coding-agent/src/prompts/system/ttsr-interrupt.md)
- [`../src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`../src/extensibility/extensions/types.ts`](../packages/coding-agent/src/extensibility/extensions/types.ts)
- [`../src/extensibility/hooks/types.ts`](../packages/coding-agent/src/extensibility/hooks/types.ts)
- [`../src/extensibility/custom-tools/types.ts`](../packages/coding-agent/src/extensibility/custom-tools/types.ts)
- [`../src/modes/controllers/event-controller.ts`](../packages/coding-agent/src/modes/controllers/event-controller.ts)

## 1. Discovery feed and rule registration

At session creation, `createAgentSession()` loads discovered rules, constructs a `TtsrManager`, and buckets rules through `bucketRules(...)`:

```ts
const ttsrSettings = settings.getGroup("ttsr");
const ttsrManager = new TtsrManager(ttsrSettings);
const rulesResult = await loadCapability<Rule>(ruleCapability.id, { cwd });
const { rulebookRules, alwaysApplyRules } = bucketRules(
  rulesResult.items,
  ttsrManager,
  {
    builtinRules: ttsrSettings.builtinRules,
    disabledRules: ttsrSettings.disabledRules,
  },
);
```

`bucketRules(...)` drops names listed in `ttsr.disabledRules`, drops embedded `builtin-defaults` rules when `ttsr.builtinRules === false`, registers accepted TTSR rules, and then routes the remaining rules to always-apply/rulebook buckets.

### Pre-registration dedupe behavior

`loadCapability("rules")` deduplicates by `rule.name` with first-wins semantics (higher provider priority first). Shadowed duplicates are removed before TTSR registration.

### `TtsrManager.addRule()` behavior

Registration is skipped when:

- TTSR is disabled (`ttsr.enabled === false`)
- both `rule.condition` (regex) and `rule.astCondition` (ast-grep patterns) are absent, or every regex condition fails to compile and there are no non-empty AST conditions
- a rule with the same `rule.name` was already registered in this manager
- the parsed rule scope excludes all monitored streams

Invalid regex conditions and unreachable scopes are logged as warnings and ignored; session startup continues. AST parse/match failures are logged when matching is attempted and count as no match. If a TTSR rule defines `globs`, those globs are compiled as a global file-path gate for matching.

With no explicit `scope`, a rule monitors assistant text and all tool arguments, but not thinking. Explicit scope tokens can enable `text`, `thinking`, any tool (`tool`/`toolcall`), a named tool, and optional per-tool path globs.

### AST conditions (`astCondition`)

AST conditions only evaluate on tool-argument streams for tools that expose a reconstructed `matcherDigest` or per-file `matcherEntries`, and only when a candidate path supplies a usable file extension for language inference. Built-in edit/write tools provide these surfaces, but the coordinator resolves them generically from the active tool. They match against the tool's reconstructed source snapshot — the per-file `matcherEntries` digests when available, else the combined `matcherDigest` — not the raw wire delta; streams without a usable file path (prose, thinking, path-less tool calls) skip AST conditions entirely. A rule may mix `condition` and `astCondition`: the regex paths keep working on every scope while AST paths apply only to those tool streams.

The snapshot is source-bearing payload, not the whole prospective file: pre-existing target content is invisible unless the call repeats it. Current edit modes expose `new_string` for replace, added lines for JSON patch, hashline, and apply-patch forms, and full content for create forms; write exposes its entire `content`. Multi-file hashline/apply-patch calls are split into separate `{ path, digest }` entries, so AST language, path scope/globs, buffers, and matching are evaluated per file. Matching is in-memory through native `astMatch` with Smart strictness.

### Setting gating

`TtsrSettings.enabled` gates the manager: when `ttsr.enabled === false`, `addRule()` refuses registration and `checkDelta()`/`checkSnapshot()`/`checkAstSnapshot()`/`hasRules()`/`hasAstRules()` all return empty/false, so no matching runs.

Manager defaults when a setting is omitted:

| Setting         | Default                                          |
| --------------- | ------------------------------------------------ |
| `enabled`       | `true`                                           |
| `contextMode`   | `"discard"`                                      |
| `interruptMode` | `"always"`                                       |
| `repeatMode`    | `"once"`                                         |
| `repeatGap`     | `10` completed turns                             |
| `builtinRules`  | `true` (consumed by `bucketRules`, not matching) |
| `disabledRules` | `[]` (consumed by `bucketRules`, not matching)   |

## 2. Streaming monitor lifecycle

TTSR detection is delegated by `AgentSession.#handleAgentEvent` to the session-owned `TtsrCoordinator`.

### Turn start

On `turn_start`, the stream buffer is reset:

- `ttsrManager.resetBuffer()`

### During stream (`message_update`)

When assistant updates arrive and rules exist:

- monitor `text_delta`, `thinking_delta`, and `toolcall_delta`
- isolate buffers by source or tool-call stream key
- the match context's file paths prefer the tool's `matcherPaths(args)` hook — edit strategies surface paths embedded in the wire payload (hashline `[path#TAG]` section headers, apply_patch `*** Add/Update/Delete File:` envelope markers), tolerant of partially streamed buffers — falling back to the generic top-level `path`/`paths` argument scan
- for tools exposing `matcherEntries(args)`, the streamed payload is projected per touched file into `{ path, digest }` entries (added lines only, same-path sections/hunks merged); each entry is checked in isolation via `checkSnapshot(entry.digest, perFileContext)` under its own file path and stream key (`<toolcall>#<path>`), so a path-scoped rule like `tool:edit(*.ts)` never fires on text belonging to a sibling Markdown hunk in a multi-file payload
- otherwise, for tools exposing a combined `matcherDigest` (edit/write), replace the scoped buffer with the reconstructed source snapshot and call `checkSnapshot(snapshot, matchContext)`; otherwise append the delta into the scoped manager buffer and call `checkDelta(delta, matchContext)` (synchronous regex matching either way)
- `checkDelta` skips buffering entirely for text/thinking sources when no registered rule allows that source (`canMatchText`/`canMatchThinking`), so unmatched prose/thinking deltas pay no buffering cost
- when AST rules exist, `checkAstSnapshot` runs (awaited) on the same reconstructed per-file or single snapshot; identical consecutive snapshots for a stream key are skipped

`checkDelta()`/`checkSnapshot()` iterate registered rules and return all matching rules that pass scope, global path-glob, regex condition, and repeat policy checks. `checkAstSnapshot()` applies the same scope/path/repeat gates, infers language from the candidate file path, then tests each candidate rule's AST patterns. Regex and AST match arrays feed the same trigger-decision handler.

## 3. Trigger decision and immediate abort path

Each rule's `interruptMode` overrides the global setting when present:

- `always` interrupts any matching source
- `prose-only` interrupts text/thinking matches only
- `tool-only` interrupts tool matches only
- `never` never interrupts

If no matched rule interrupts, handling follows the source-specific deferred paths below.

When one or more rules match and at least one matched rule allows interruption:

1. Matched rules are deduplicated into the coordinator's pending injections.
2. The abort-pending flag is set and a TTSR resume gate is created.
3. `agent.abort()` is called immediately. For a tool match, the abort reason is scoped to that tool-call id so sibling calls receive the separate `TTSR interrupt on another tool call` reason.
4. `ttsr_triggered` is emitted asynchronously (fire-and-forget).
5. Retry work is scheduled through the post-prompt task scheduler with a 50ms delay, tagged with the current prompt generation and a retry token.

Abort is not blocked on extension callbacks.

## 4. Retry scheduling, context mode, and reminder injection

After the 50ms timeout, the scheduled task first verifies that its retry token, prompt generation, abort-pending state, and target assistant message are still current. If any check fails, it clears pending TTSR state and resolves the resume gate without retrying. Otherwise it:

1. clears the abort-pending flag and per-tool reminder buckets
2. reads `ttsrManager.getSettings().contextMode`
3. if `contextMode === "discard"`, drops the targeted partial assistant output with `agent.replaceMessages(...slice(0, targetAssistantIndex))`
4. builds injection content from pending rules using `ttsr-interrupt.md`
5. appends a hidden runtime custom message and persists a matching `custom_message` entry with `customType: "ttsr-injection"` and `details.rules`
6. marks/persists those rule names through a `ttsr_injection` entry and calls `agent.continue()` to retry generation

Template payload is:

```xml
<system-interrupt reason="rule_violation" rule="{{name}}" path="{{path}}">
...
{{content}}
</system-interrupt>
```

Pending injections are cleared after content generation.

### `contextMode` behavior on partial output

- `discard`: partial/aborted assistant message is removed before retry.
- `keep`: partial assistant output remains in conversation state; reminder is appended after it.

### Non-interrupting matches

Non-interrupting matches split by `matchContext.source`:

- **`source === "tool"` (tool-source match).** The rule is bucketed into `TtsrCoordinator.#perToolInjections`, keyed by the matched tool call's `id`, and marked injected in memory immediately. There is **no** deferred follow-up turn and the stream is not aborted. When the tool actually produces a result, the `afterToolCall` hook prepends a rendered `ttsr-tool-reminder.md` block to `ctx.result.content` (a single `text` block inserted ahead of the tool's own content) and persists a `ttsr_injection` entry with the consumed rule names. The template payload is:

  ```xml
  <system-reminder reason="rule_violation" rule="{{name}}" path="{{path}}">
  ...
  {{content}}
  </system-reminder>
  ```

- **`source === "text"` / `"thinking"` (prose-source match).** The rule is queued in the pending injections. After a successful non-error, non-aborted assistant message, `TtsrCoordinator` queues the hidden `ttsr-injection` custom message with `agent.followUp()` and schedules continuation after 1ms. These deferred non-interrupting prose matches do not emit `ttsr_triggered`; that event is emitted for actual interrupt paths and for non-interrupting per-tool reminders.

Within a matching batch, each rule is attached to exactly one sibling tool call: if multiple sibling calls would satisfy the same rule, the first claimed bucket wins. Multiple distinct rules can still fold onto one tool call.

#### Implications for tool authors and transcript readers

- The tool's own `toolResult` content is preserved verbatim; the reminder is **prepended** as an additional leading text block. Renderers that assume `content[0]` is the tool's primary output must scan past any block whose text begins with `<system-reminder reason="rule_violation"` (or filter on the wrapper tag) to find the real payload.
- The reminder is in-band on the tool result, not a separate `custom_message`/`ttsr-injection` entry. Transcript readers looking for non-interrupting TTSR activity on tool-source rules MUST inspect tool results (and the persisted `ttsr_injection` entry list), not just synthetic injection entries.
- A single tool result may carry reminders for several rules concatenated with a blank line between rendered templates.
- If the assistant message ends with `stopReason === "aborted"` or `"error"` before the matched tools run, pending per-tool buckets are cleared and no `ttsr_injection` entry is persisted. The match-time in-memory injection record is **not** rolled back: in `once` mode it stays suppressed until session reload; in `after-gap` mode it becomes eligible after the configured number of completed turns. Because the undelivered match was not persisted, reload also makes it eligible again.

## 5. Repeat policy and gap logic

`TtsrManager` tracks `#messageCount` and per-rule `lastInjectedAt`.

### `repeatMode: "once"`

A rule can trigger only once after it has an injection record.

### `repeatMode: "after-gap"`

A rule can re-trigger only when:

- `messageCount - lastInjectedAt >= repeatGap`

`messageCount` increments on `turn_end`, so gap is measured in completed turns, not stream chunks.

## 6. Event emission and extension/hook surfaces

### Session event

`AgentSessionEvent` includes:

```ts
{ type: "ttsr_triggered"; rules: Rule[] }
```

### Extension runner

`#emitSessionEvent()` routes the event to:

- extension listeners (`ExtensionRunner.emit({ type: "ttsr_triggered", rules })`)
- local session subscribers

### Hook and custom-tool typing

- extension API exposes `on("ttsr_triggered", ...)`
- hook API exposes `on("ttsr_triggered", ...)`
- custom tools receive `onSession({ reason: "ttsr_triggered", rules })`

### Interactive-mode rendering difference

Interactive mode uses `session.isTtsrAbortPending` to suppress showing the aborted assistant stop reason as a visible failure during TTSR interruption, and renders a `TtsrNotificationComponent` when the event arrives.

## 7. Persistence and resume state (current implementation)

`SessionManager` persists injected-rule state:

- entry type: `ttsr_injection`
- append API: `appendTtsrInjection(ruleNames)`
- query API: `getInjectedTtsrRules()`
- context reconstruction includes `SessionContext.injectedTtsrRules`

`TtsrManager` supports restoration via `restoreInjected(ruleNames)`.

Current runtime wiring:

- interrupted injections append a hidden `custom_message` with `customType: "ttsr-injection"` and append a `ttsr_injection` entry
- deferred non-interrupting prose-source injections are marked/persisted when their queued custom message reaches `message_end`
- non-interrupting tool-source matches are marked in memory when bucketed, then persisted from `afterToolCall` only when the matched tool's result is produced
- `createAgentSession()` restores `existingSession.injectedTtsrRules` into the manager

Injected-rule suppression is therefore restored from the current branch path. Persistence stores names, not the original turn age: `restoreInjected()` records each restored rule at message count zero. In `repeatMode: "after-gap"`, a resumed rule becomes eligible after `repeatGap` newly completed turns, regardless of how many turns elapsed before reload.

## 8. Race boundaries and ordering guarantees

### Abort vs retry callback

- abort is synchronous from TTSR handler perspective (`agent.abort()` called immediately)
- retry is deferred by timer (`50ms`)
- extension notification is asynchronous and intentionally not awaited before abort/retry scheduling

### Multiple matches in same stream window

`checkDelta()` returns all currently matching eligible rules for that scoped buffer. Pending injections are deduplicated by rule name before injection.

### Between abort and continue

During the timer window, state can change. The retry is guarded by retry token, prompt generation, abort state, and target-message identity; a stale task clears pending state and resolves its gate. `agent.continue()` failures are caught and also resolve the gate.

## 9. Edge cases summary

- Invalid `condition` regex: skipped with warning; other conditions/rules continue.
- Duplicate rule names at capability layer: lower-priority duplicates are shadowed before registration.
- Duplicate names at manager layer: second registration is ignored.
- `ttsr.disabledRules`: listed names are dropped before TTSR registration and are not surfaced through always-apply/rulebook buckets.
- `ttsr.builtinRules: false`: embedded `builtin-defaults` rules are dropped before TTSR registration; user/project rules still load.
- `globs` on a TTSR rule require at least one candidate file path matching either its normalized path or basename; for hashline/apply_patch edit streams those paths come from the tool's `matcherPaths` hook, not top-level arguments.
- Tools without `matcherPaths`/`matcherEntries` keep the generic top-level path scan and combined `matcherDigest` behavior — the per-file hooks are additive.
- Default scope monitors text and tools, not thinking.
- `contextMode: "keep"`: partial violating output can remain in context before reminder retry.
- `interruptMode: "never"`: prose-source matches queue a deferred hidden injection after a successful assistant message; tool-source matches fold an in-band `<system-reminder>` into the matched tool call's `toolResult` content via the `afterToolCall` hook (no mid-stream abort, no separate follow-up turn).
- Tool-source non-interrupting buckets are cleared when the parent assistant message ends with `stopReason === "aborted"` or `"error"`. Their match-time in-memory suppression remains until repeat policy permits another trigger (or reload discards the unpersisted record).
- Repeat-after-gap depends on turn count increments at `turn_end`; after reload, restored injection ages restart at zero.
