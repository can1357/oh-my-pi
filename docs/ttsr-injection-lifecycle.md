# TTSR Injection Lifecycle

This document covers the current Time Traveling Stream Rules (TTSR) runtime path from rule discovery to stream interruption, retry injection, extension notifications, and session-state handling.

## Implementation files

- [`packages/coding-agent/src/sdk.ts`](../packages/coding-agent/src/sdk.ts)
- [`packages/coding-agent/src/export/ttsr.ts`](../packages/coding-agent/src/export/ttsr.ts)
- [`packages/coding-agent/src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`packages/coding-agent/src/session/ttsr-coordinator.ts`](../packages/coding-agent/src/session/ttsr-coordinator.ts)
- [`packages/coding-agent/src/session/ttsr-outputs.ts`](../packages/coding-agent/src/session/ttsr-outputs.ts)
- [`packages/coding-agent/src/export/ttsr-settings.ts`](../packages/coding-agent/src/export/ttsr-settings.ts)
- [`packages/coding-agent/src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`packages/coding-agent/src/prompts/system/ttsr-interrupt.md`](../packages/coding-agent/src/prompts/system/ttsr-interrupt.md)
- [`packages/coding-agent/src/prompts/system/ttsr-prose-notice.md`](../packages/coding-agent/src/prompts/system/ttsr-prose-notice.md)
- [`packages/coding-agent/src/prompts/system/ttsr-warning.md`](../packages/coding-agent/src/prompts/system/ttsr-warning.md)
- [`packages/coding-agent/src/prompts/system/ttsr-tool-reminder.md`](../packages/coding-agent/src/prompts/system/ttsr-tool-reminder.md)
- [`packages/coding-agent/src/prompts/system/ttsr-gate-refused.md`](../packages/coding-agent/src/prompts/system/ttsr-gate-refused.md)
- [`packages/coding-agent/src/tools/tool-guard.ts`](../packages/coding-agent/src/tools/tool-guard.ts)
- [`packages/coding-agent/src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`packages/coding-agent/src/extensibility/extensions/types.ts`](../packages/coding-agent/src/extensibility/extensions/types.ts)
- [`packages/coding-agent/src/extensibility/hooks/types.ts`](../packages/coding-agent/src/extensibility/hooks/types.ts)
- [`packages/coding-agent/src/extensibility/custom-tools/types.ts`](../packages/coding-agent/src/extensibility/custom-tools/types.ts)
- [`packages/coding-agent/src/modes/controllers/event-controller.ts`](../packages/coding-agent/src/modes/controllers/event-controller.ts)

## 1. Discovery feed and rule registration

At session creation, `createAgentSession()` loads discovered rules, constructs a `TtsrManager`, and buckets rules through `bucketRules(...)`:

```ts
const ttsrSettings = cfgTtsr.get(settings);
// Live source: enable/repeat/interrupt/context changes apply on the next check.
const ttsrManager = new TtsrManager(() => cfgTtsr.get(settings));
const rulesResult =
	options.rules !== undefined
		? { items: options.rules, warnings: undefined }
		: await loadCapability<Rule>(ruleCapability.id, { cwd, agentDir });
const { rulebookRules, alwaysApplyRules } = bucketRules(rulesResult.items, ttsrManager, {
	builtinRules: ttsrSettings.builtinRules,
	disabledRules: ttsrSettings.disabledRules,
	agentName: resolvedAgentName,
});
```

`bucketRules(...)` drops names listed in `ttsr.disabledRules`, drops embedded builtin-defaults rules when `ttsr.builtinRules === false`, drops rules whose `agents` globs do not match this session's agent, registers accepted TTSR rules, and then routes the remaining rules to always-apply/rulebook buckets.

Session-scoped prompt rebuilds re-discover and re-bucket rules (explicit rule sets are only re-bucketed). `replaceRules()` replaces registrations and clears stream buffers, preserving injection records for names still registered. Removed names lose their records; when TTSR is disabled, records are retained for re-enablement. The session-local and top-level active-rule URL snapshots are refreshed too.

### Pre-registration dedupe behavior

`loadCapability("rules")` deduplicates by `rule.name` with first-wins semantics (higher provider priority first). Shadowed duplicates are removed before TTSR registration.

### `TtsrManager.addRule()` behavior

Registration is skipped when:

- TTSR is disabled (`ttsr.enabled === false`)
- `rule.condition` (regex), `rule.astCondition` (ast-grep patterns), and `rule.question` (judged) are all absent, or every regex condition fails to compile and there are neither AST conditions nor a question
- a rule with the same `rule.name` was already registered in this manager
- a gate rule (`gate: before`) has no `question` (logged as a warning)
- the parsed rule scope excludes all monitored streams

Invalid regex conditions and unreachable scopes are logged as warnings and ignored; session startup continues. AST parse/match failures are logged when matching is attempted and count as no match. If a TTSR rule defines `globs`, those globs are compiled as a global file-path gate for matching.

With no explicit `scope`, a rule monitors assistant text and all tool arguments, but not thinking. Explicit scope tokens can enable `text`, `thinking`, any tool (`tool`/`toolcall`), a named tool, and optional per-tool path globs. A gate rule judges tool calls only: with no `scope` it covers every tool call, and `text`/`thinking` tokens are dropped with a warning.

### AST conditions (`astCondition`)

AST conditions only evaluate on tool-argument streams for tools that expose a reconstructed `matcherDigest` or per-file `matcherEntries`, and only when a candidate path supplies a usable file extension for language inference. Built-in edit/write tools provide these surfaces, but the coordinator resolves them generically from the active tool. They match against the tool's reconstructed source snapshot — the per-file `matcherEntries` digests when available, else the combined `matcherDigest` — not the raw wire delta; streams without a usable file path (prose, thinking, path-less tool calls) skip AST conditions entirely. A rule may mix `condition` and `astCondition`: the regex paths keep working on every scope while AST paths apply only to those tool streams.

The snapshot is source-bearing payload, not the whole prospective file: pre-existing target content is invisible unless the call repeats it. Current edit modes expose `new_string` for replace, added lines for JSON patch, hashline, and apply-patch forms, and full content for create forms; write exposes its entire `content`. Multi-file hashline/apply-patch calls are split into separate `{ path, digest }` entries, so AST language, path scope/globs, buffers, and matching are evaluated per file. Matching is in-memory through native `astMatch` with Smart strictness.

### Setting gating

`TtsrSettings.enabled` gates the manager: when `ttsr.enabled === false`, `addRule()` refuses registration and `checkDelta()`/`checkSnapshot()`/`checkAstSnapshot()`/`hasRules()`/`hasAstRules()` all return empty/false, so no matching runs.

Manager defaults when a setting is omitted:

| Setting         | Default                                          |
| --------------- | ------------------------------------------------ |
| `enabled`       | `true`                                           |
| `judge`         | `"auto"` (consumed by the session, not matching) |
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

Buffers also reset at each assistant `message_start` and on a later provider `start` that replaces the partial response, preventing content from discarded attempts or retries from combining.

### During stream (`message_update`)

When assistant updates arrive and rules exist:

- monitor `text_delta`, `thinking_delta`, `toolcall_delta`, and finalized `toolcall_end` arguments; final arguments seed the snapshot even when a provider emits no argument deltas
- isolate buffers by source or tool-call stream key
- the match context's file paths prefer the tool's `matcherPaths(args)` hook. Edit strategies surface every path the payload touches, embedded in the wire payload (hashline `[path#TAG]` section headers, apply_patch `*** Add/Update/Delete File:` envelope markers, move destinations), tolerant of partially streamed buffers, and fall back to the generic top-level `path`/`paths` argument scan
- for tools exposing `matcherEntries(args)`, the streamed payload is projected per touched file into `{ path, digest }` entries (added lines only, same-path sections/hunks merged); each entry is checked in isolation via `checkSnapshot(entry.digest, perFileContext)` under its own file path and stream key (`<toolcall>#<path>`), so a path-scoped rule like `tool:edit(*.ts)` never fires on text belonging to a sibling Markdown hunk in a multi-file payload
- otherwise, for tools exposing a combined `matcherDigest` (edit/write), replace the scoped buffer with the reconstructed source snapshot and call `checkSnapshot(snapshot, matchContext)`; otherwise append the delta into the scoped manager buffer and call `checkDelta(delta, matchContext)` (synchronous regex matching either way)
- `checkDelta` skips buffering entirely for text/thinking sources when no registered rule allows that source (`canMatchText`/`canMatchThinking`), so unmatched prose/thinking deltas pay no buffering cost
- a non-final check evaluates only rules that can interrupt the stream's source (`TtsrManager.interrupts`: the rule's `interruptMode`, else the global one). A rule that cannot (`never`, like every built-in rule; `prose-only` on tool calls; `tool-only` on text/thinking) is delivered after the output ends either way, so it waits for the `*_end` check and costs nothing per delta. When an interrupting rule matches mid-stream, the deferred rules get their final check on the same buffer in that call, so the interrupt reminder still names every rule the discarded output broke. A `toolcall_delta` for a call no interrupting rule is scoped to (`interruptsToolStream`, path globs aside) is skipped whole: its arguments are neither inspected nor buffered until `toolcall_end`
- at `message_end` of a successful response, `TtsrCoordinator` runs the deferred rules' final check (`TtsrCheckOptions.deferredOnly`) on the text and thinking buffers and on every tool call that never reached `toolcall_end`, so a provider that omits an end event loses no non-interrupting rule
- conditions compile to `LinearRegExp` (`packages/utils/src/regex/linear-regexp.ts`), a `RegExp` whose matching cannot backtrack catastrophically: an automaton over character classes JSC itself computes for the condition's flags (so case folding and line terminators are the `RegExp`'s own) decides whether a match exists, and a memoized backtracker with ECMAScript semantics finds the match itself. Each buffer feeds every delta to the automaton once, so a check costs only the delta and, for a condition without lookarounds or backreferences, gives exactly what `RegExp.test` on the whole buffer would return. A condition whose backtracking explodes (overlapping alternatives under a lazy loop, an indentation backreference) cannot stall the stream
- for a condition with lookarounds, backreferences, or Unicode properties of strings, the automaton approximates them, so its miss is final and its hit is confirmed by scanning with the condition. Those confirmations, and conditions the engine declines (such as variable-width repetitions past its node limit), use incremental scans. A condition that cannot cross a newline (no `s` flag, nothing in it matches `\n`) is re-tested only from the start of the line holding the previous buffer end. A condition that can span lines is re-scanned over the whole buffer only while it is ≤4 KB or once it has grown 25% since the last full scan
- `text_end`, `thinking_end`, and `toolcall_end` run a final whole-buffer check (`TtsrCheckOptions.final`), so a cross-line `RegExp` match deferred by the growth throttle is still caught before the block closes; `checkDelta` defaults to `final: false`, `checkSnapshot` to `final: true` (one-shot callers such as the CLI stay exact). The judged-rule prefilter and `omp ttsr test`/`scan` use the same linear matching

AST matching does not run in the streaming listener. The awaited `beforeToolCall` hook checks the finalized, validated execution arguments using the same per-file or combined source snapshot. An interrupt blocks the tool before its side effects, marks the assistant turn aborted, and follows the existing TTSR injection/retry path; `never` mode allows execution and attaches its reminder to the result. Streaming regex matching remains synchronous.

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
4. builds injection content from pending rules using `ttsr-interrupt.md` — this is the abort/retry path, where the rule did interrupt the output, so the interrupting template is the truthful one
5. appends a hidden runtime custom message and persists a matching `custom_message` entry with `customType: "ttsr-injection"` and `details.rules`
6. marks/persists those rule names through a `ttsr_injection` entry and schedules a continuation with the session's agent-continue scheduler. If the interrupted run is still busy, the scheduler waits for it to settle and retries; skipped or failed continuations release the resume gate.

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

- **`source === "tool"` (tool-source match).** The rule is bucketed into `TtsrCoordinator.#perToolInjections`, keyed by the matched tool call's `id`, and marked injected in memory immediately. There is **no** deferred follow-up turn and the stream is not aborted. When the tool actually produces a result, the `afterToolCall` hook returns a rendered `ttsr-tool-reminder.md` block as passive `additionalContext`; agent-core emits it in a separate developer message after the tool result, never as part of tool output (calls dispatched outside the agent loop are covered by the next bullet). It also persists a `ttsr_injection` entry with the consumed rule names. The template payload is:

   ```xml
   <system-reminder reason="rule_violation" rule="{{name}}" path="{{path}}">
   ...
   {{content}}
   </system-reminder>
   ```

   The opening line depends on where the rule comes from: a bundled `builtin-defaults` rule says a built-in style rule matched and asks the model to check what it wrote against the rule, exceptions included, and fix only a real violation; every other rule says a user-defined rule matched and must be complied with.

- **Bridged AgentTool calls (Cursor exec handlers, eval).** These dispatches bypass the agent loop, so `afterToolCall` never runs for them. Finalized inner calls are checked at the `ExtensionToolWrapper` boundary, which passes the call's tool context to `TtsrCoordinator.afterBridgedToolCall`. When that context carries an `addAdditionalContext` sink, the reminder is delivered through it as passive context (the Cursor exec bridge installs a sink whenever the session supplies a tool context, and delivers after its buffered results on the next provider request) and the bridged result stays untouched. A bridged call with no sink has no trusted channel, so the reminder is prepended to its result as a leading text block instead; eval-bridged calls take this fallback today. Prelude host calls (`browser.*`, `computer.*`, `tab.run`) are not AgentTool dispatches and stay outside this path.

- **`source === "text"` / `"thinking"` (prose-source match).** The rule is queued in the pending injections. After a successful non-error, non-aborted assistant message, `TtsrCoordinator` queues the hidden `ttsr-injection` custom message with `agent.followUp()` and schedules continuation after 1ms. These deferred non-interrupting prose matches do not emit `ttsr_triggered`; that event is emitted for actual interrupt paths and for non-interrupting per-tool reminders. The deferred message is rendered with `ttsr-prose-notice.md`: the rule matched output it did not interrupt, so the notice states that the output was not interrupted by the rule. It deliberately claims nothing else about the output — a `length` stop truncates it and a `toolUse` stop continues into tool calls.

  ```xml
  <system-reminder reason="rule_violation" rule="{{name}}" path="{{path}}">
  ...
  {{content}}
  </system-reminder>
  ```

Within a matching batch, each rule is attached to exactly one sibling tool call: if multiple sibling calls would satisfy the same rule, the first claimed bucket wins. Multiple distinct rules can still share one tool call's passive context.

#### Implications for tool authors and transcript readers

- The tool's own `toolResult` content is preserved verbatim. Agent-core emits the rendered reminder in a separate developer message after every result in the batch has settled and before the next provider request.
- Transcript readers looking for non-interrupting TTSR activity on tool-source rules must inspect developer messages that follow tool-result batches (and the persisted `ttsr_injection` entry list), not tool output or synthetic custom-message entries.
- One developer message may carry reminders for several rules or tool calls, concatenated in assistant call order with a blank line between rendered templates.
- If the assistant message ends with `stopReason === "aborted"` or `"error"` before the matched tools run, pending per-tool buckets are cleared and no `ttsr_injection` entry is persisted. The match-time in-memory injection record is **not** rolled back: in `once` mode it stays suppressed until session reload; in `after-gap` mode it becomes eligible after the configured number of completed turns. Because the undelivered match was not persisted, reload also makes it eligible again.

## 5. Repeat policy and gap logic

`TtsrManager` tracks `#messageCount` and per-rule `lastInjectedAt`.

### `repeatMode: "once"`

A rule with an injection record stays suppressed for the current session, including after `/clear` or compaction. `/new` and RPC `new_session` start a new transcript with no repeat history.

### `repeatMode: "after-gap"`

A rule can re-trigger only when:

- `messageCount - lastInjectedAt >= repeatGap`

`messageCount` increments on `turn_end`, so gap is measured in completed turns, not stream chunks.

### Per-rule override and `repeatMode: "always"`

A rule's own `repeatMode` frontmatter key (`once`, `after-gap`, or `always`) overrides the global setting for that rule; the gap is still the global `repeatGap`.

`always` is rule-level only and is the gap check with `repeatGap = 1`: the rule fires at most once per turn and is eligible again once the turn its reminder landed in has ended. The record is the turn the reminder lands in, never earlier than the current turn:

- Tool reminders (`afterToolCall`) and bridged blocks land in the triggering turn, so the next turn can fire the rule again.
- An interrupt's reminder lands in the `ttsr-interrupt` retry. The coordinator captures that turn (current turn + 1) when it aborts, so the retry stays exempt even if the timer-driven retry task records it before the aborted turn's `turn_end` is processed.
- Deferred reminders and judged warnings are recorded again when their message is delivered, which is after the triggering turn ends; the `ttsr-injection` continuation or aside turn they start is that turn.

A turn spawned by a reminder therefore cannot re-fire the same rule: each firing starts at most one extra turn, and a model that repeats the match while answering the reminder is not interrupted or prompted again.

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
- non-interrupting tool-source matches are marked in memory when bucketed, then persisted from `afterToolCall` (or the bridged-call postflight) only when the matched tool's result is produced
- `createAgentSession()` restores `existingSession.injectedTtsrRules` into the manager

Injected-rule suppression is therefore restored from the current branch path. Persistence stores names, not the original turn age: `restoreInjected()` records each restored rule at message count zero. In `repeatMode: "after-gap"`, a resumed rule becomes eligible after `repeatGap` newly completed turns, regardless of how many turns elapsed before reload; a resumed `repeatMode: "always"` rule likewise sits out the first turn after resume and is eligible from the second.

## 8. Race boundaries and ordering guarantees

### Abort vs retry callback

- abort is synchronous from TTSR handler perspective (`agent.abort()` called immediately)
- retry is deferred by timer (`50ms`)
- extension notification is asynchronous and intentionally not awaited before abort/retry scheduling

### Multiple matches in same stream window

`checkDelta()` returns all currently matching eligible rules for that scoped buffer. Pending injections are deduplicated by rule name before injection. Trigger notifications track rule names per stream key, so a delta match re-confirmed at `toolcall_end` does not announce the same violation twice; this tracking clears at turn end.

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
- `interruptMode: "never"`: prose-source matches queue a deferred hidden injection after a successful assistant message; tool-source matches return an OMP-authored `<system-reminder>` through `afterToolCall.additionalContext`, which agent-core emits as a separate developer message after the matched call's tool result (no tool-output mutation, mid-stream abort, or extra follow-up turn). Bridged calls use their own passive-context sink the same way; only a bridged call without one (eval) folds the reminder into its result.
- Tool-source non-interrupting buckets are cleared when the parent assistant message ends with `stopReason === "aborted"` or `"error"`. Their match-time in-memory suppression remains until repeat policy permits another trigger (or reload discards the unpersisted record).
- Repeat-after-gap depends on turn count increments at `turn_end`; after reload, restored injection ages restart at zero.
- Judged (`question`) rules never appear in `checkDelta`/`checkSnapshot`/`checkAstSnapshot` results; see §10.
- Gate rules (`gate: before`) are judged only before a call runs, never after its output (§10) and never mid-stream; `repeatMode`/`interruptMode` on a gate are ignored with a warning. See §11.

## 10. Judged rules (`question`)

A rule with `question` is judged: its natural-language question goes to the `judge` model role after an output completes, never while it streams, so it cannot interrupt.

### When judgment runs

- `ttsr.judge`: `auto` (default) judges only when the judge role resolves to a native System One model (TypeSafe jev); `on` judges with whatever the role resolves to, including the session's chat model; `off` never judges. Question rules still register either way.
- On `message_end` of an assistant message whose `stopReason` is neither `aborted` nor `error`, `TtsrCoordinator` splits the message into outputs: all text blocks as one `text` output, all thinking blocks as one `thinking` output, and each tool call as a `tool` output. Tools exposing `matcherEntries` yield one output per file, with the `{ path, digest }` digest as content; otherwise the `matcherDigest` or the raw JSON arguments.
- For each output, `TtsrManager.judgedCandidates()` selects question rules that pass scope, `globs`, the repeat policy, and (when the rule also declares `condition`/`astCondition`) that prefilter against the completed content. Gate rules (§11) are never candidates here. No candidates → no request.
- One judge request per output carries every candidate's question as a `noul` question over a shared state `{ output, content }` (content cut to its longest prefix within 32,000 Jev tokens, counted locally with `Encoding.Jev`, so each branch stays under Jev's ~33k-token limit). Jev bills the state once per request, so rules sharing an output share its cost. Usage is journaled as `model_usage` with purpose `ttsr` and counts toward the session's cost cap; once the cap is reached, the judge refuses further requests.

### Delivery

- A yes-probability ≥ 0.7 flags the rule. Flagged rules pass through `TtsrManager.claim()`, which drops rules another verdict already claimed or that the repeat policy blocks, and marks the rest injected in memory; one rule flagged by several outputs is therefore delivered once.
- Verdicts arriving after a session replacement (`/new`, session switch) are dropped.
- Survivors emit `ttsr_triggered` and are rendered with `ttsr-warning.md` into a hidden `ttsr-injection` custom message (`details.rules`), sent with `deliverAs: "aside"`: mid-run it joins the next step without interrupting (a running interruptible `wait` ends); on an idle session it starts a turn. Its `message_end` persists the `ttsr_injection` entry.
- The session's `onBeforeYield` hook awaits in-flight judgments (up to 5s) before the agent loop drains asides and stops, so a warning about the final reply or last tool call lands in the same run. Later verdicts still arrive as asides.
- Judge failures (no credentials, timeouts, parse errors) are logged and deliver nothing.

### `/omfg` and CLI

`/omfg` generates `condition`, `astCondition`, or `question` rules, instructed to prefer the pattern triggers. It validates candidates against conversation history through the same completed-output view (`TtsrToolInspector.outputs`); a `question` candidate must pass its scope/prefilter and get a yes from the judge on one of the 8 most recent in-scope outputs. With no judge available, the user decides whether to save it unconfirmed.

`omp ttsr list` shows each rule's `question`, `gate` and `onJudgeError`, in text and in `--json`. `omp ttsr test` never calls the judge, so question rules report as not triggered, with their question shown, marked as judged before each call for a gate, and their `onJudgeError`. `omp ttsr scan` skips question rules: their conditions are prefilters, not violations.

## 11. Pre-execution gates (`gate: before`)

A judged rule with `gate: before` is asked about each in-scope tool call before the call runs, and a yes refuses the call: the tool does not run and the model gets the refusal in place of its result.

```yaml
---
question: Does this command delete files outside the project?
gate: before
onJudgeError: block
scope: tool:bash
---
Never delete files outside the working directory; ask the user first.
```

### Where the gate runs

- `ExtensionToolWrapper` calls the session's tool guard (`ExtensionRunner.setToolGuard`) once per call, after the approval gate, with the arguments that will run. Agent-loop and bridged (eval, Cursor exec) calls both pass through it.
- `ToolGuard.check()` runs the gate first on every call: calls the user approved in a prompt too, and whether or not `tools.guard.enabled` is on. Only then does the harm guard screen calls approval let through on its own. The harm guard's judge breaker never skips gates.
- A gate refusal counts toward the tool guard's stop rule: three refusals in a row (or 20 in one run) stop the run. A call that runs ends a streak, except a read-tier call no gate rule covers, since nothing could have refused it; a read-tier call a gate rule covers and lets through does end it.

### Matching and judging

- `TtsrCoordinator.gateToolCall()` judges the call under the name the model called the tool by (the wrapper passes the batch's call name when it is the tool's `customWireName`, e.g. `apply_patch`), so rule scopes match as they do on completed output. A call that is not the batch's own, such as `tool.edit(…)` from an eval cell, carries no such name: a tool scope naming either the tool or its `customWireName` covers it, so `tool:apply_patch` and `tool:edit` both gate an edit an eval cell runs in `apply_patch` mode. It builds the call's outputs with `TtsrToolInspector.gateOutputs()`: the outputs of §10 (per file for `matcherEntries` tools, else the digest or JSON arguments). Per-file digests hold only added lines, so a tool exposing `matcherSections` (multi-file edit modes) also gets each file's section of the call, patch grammar kept, under that file alone: a file the call deletes, moves (the destination shares the source's section) or only removes lines from is judged there, and a file-scoped gate never sees a sibling file's text. A section equal to its file's digest is not judged twice. A `matcherEntries` tool without sections gets the whole call's arguments once more, whose paths are every file the call touches (`matcherPaths`, including moved-to paths). `TtsrManager.gateCandidates()` selects gate rules that pass scope, `globs`, and the `condition`/`astCondition` prefilter. There is no repeat policy: a refused call retried unchanged is judged again.
- The judge is the same as §10 (`ttsr.judge`, `judge` role, purpose `ttsr`, cost cap). Each output with candidates gets one request; a yes-probability ≥ 0.7 refuses. The first refusing rule, in output and rule order, is reported.
- Each request carries at most the first 32,000 Jev tokens of the output (§10). A yes about that prefix still refuses; otherwise a gate does not count a cut output as judged, and the candidate's `onJudgeError` decides it as below.
- The wait is bounded by `ttsr.gateTimeoutMs` (default 10000 ms), read from the operator layers only, and by the call's abort signal. An abort at any point of the gate, including candidate prefiltering (an `astCondition` match is asynchronous) and a rule decided without a judge, rejects without a verdict: the call neither runs nor is refused, emits no `ttsr_triggered`, and does not count toward the stop rule.
- Only that timeout is operator-only. `ttsr.enabled`, `ttsr.judge`, `ttsr.disabledRules` and the judge model come from merged settings, so a project layer can still turn a gate or its judge off.
- When the judge is off, fails, times out, returns no number or one outside 0..1, or could read only a prefix of the output, each candidate's `onJudgeError` decides: `allow` (default) logs a warning and runs the call, `block` refuses it. A session whose gate rules have no judge logs a warning at startup.

### Refusal

- The refusal is rendered with `ttsr-gate-refused.md` (rule name, path, the refused call, and the rule body) and thrown by the wrapper, so the call ends as a tool error without running.
- It emits `ttsr_triggered` for the rule. Nothing is persisted and no injection record is written, so a later call is gated the same way.
- `ttsr.enabled: false` registers no rules, so no gates run.
