# Gap 5: automatic reasoning effort as a Director

Status: research only. Nothing here is implemented or authorized.
Date: 2026-11-13
Baseline: omp2 f4186b783b; upstream c308970263 (pinned checkout).

Evidence keys:

- **OBSERVED** means read in code or docs at the baseline. Citations use `path:line`. Upstream paths carry the `upstream:` prefix.
- **[INFERENCE]** means the author's reasoning. Every size estimate is an inference.
- **UNVERIFIED** means no run or source confirmed it.

No build, test or run was made for this document.

Revision 2026-11-14 (EGM rounds 1 to 3; the ADR is machine-reviewed, not owner-approved): ADR 0064 now decides how the choice is applied, the engagement gate, precedence, the judge's role and effort, and child sessions. Where sections 2 and 5 below differ from the ADR, the ADR wins; the points it corrects are marked "Superseded by ADR 0064". The main corrections from round 2:

- The classifier runs on `@tiny`, not `@judge`: accepted ADR 0023 puts "classify this prompt's difficulty" on the tiny role (`docs/adr/0023-tiny-local-model.md:9-10`, `docs/adr/0023-tiny-local-model.md:21-23`), and `@judge` falls back to the slow model (`crates/catalog/src/selection.rs:465`). Upstream's judge role also chains to `@tiny` (`upstream:packages/coding-agent/src/config/model-resolver.ts:1280`).
- The gate is `ai_auto_effort` and the ceiling `ai_auto_effort_ceiling` (not `sv_auto_effort` / `ai_auto_thinking_ceiling`); the gate is read live and the Director is never removed.
- There is no short-prompt heuristic; only the single-tier and empty-prompt shortcuts remain. The judge input reuses `preprocess_tiny_message` (`crates/ai/src/local/message_preproc.rs:17`).
- No pin detection: while the gate is on, the auto bind wins over every `ai_thinking` write; the gate is the pin.
- Children spawn with the gate off (ADR 0064 D11).

Round 3 further changed: judge outcomes, latency and tokens go to `tracing`, not Director state, and there is no failure breaker (ADR 0064 O9 asks the owner about measurement); the ladder floors at `low` before the ceiling, as upstream does (`upstream:packages/tui/src/thinking.ts:290-299`); `state/effort` is written only by a judge answer; the S0a and S0b driver fixes wait for the owner (O7). A no-effort `Prefer` request would not avoid S0b, because the router fills an absent effort with its default (`crates/ai/src/router.rs:682-684`).

## Question

Upstream lets the user set `defaultThinkingLevel: auto`. A small classifier picks the reasoning effort for each user prompt, and `providers.autoThinkingMaxEffort` raises the ceiling it may reach. How would omp2 offer the same as a Director, under one hard rule: the Director chooses effort only and never switches the model in the middle of a session?

Out of scope: the `ultrathink` and `chillax` magic keywords (noted where they touch the design), and the auto-prewalk and auto-graph classifiers.

## 1. Upstream

### Settings

- `defaultThinkingLevel` accepts every effort plus the literal `auto`; the default is `high` (`upstream:packages/coding-agent/src/session/settings.ts:242`).
- `providers.autoThinkingMaxEffort` is an enum `xhigh | max`, default `xhigh`. It raises the ceiling the classifier may pick. `max` became a first-class tier after the classifier prompt was written, so without the setting `auto` could never reach it (`upstream:packages/coding-agent/src/session/settings.ts:1156`).
- The effective ceiling is `max` only when the setting says `max` and the model lists `max` among its supported efforts; otherwise `xhigh` (`upstream:packages/coding-agent/src/auto-thinking/classifier.ts:135-138`).

### Where it runs

- Once per user turn, before the model request. The caller in `agent-session.ts` classifies only user turns (a user message, or a user-invoked `/skill:`), and skips synthetic and tool-continuation turns and turns settled by `chillax` (`upstream:packages/coding-agent/src/session/agent-session.ts:9651`, `upstream:packages/coding-agent/src/session/agent-session.ts:9655`).
- `applyAutoThinkingLevel` is bounded by a 4000 ms timer and an abort, and never throws into the turn (`upstream:packages/coding-agent/src/session/model-controls.ts:657`, `upstream:packages/coding-agent/src/session/model-controls.ts:667`).
- It returns early when the model has no reasoning, or reasoning is unverified, or the model exposes no controllable effort (`upstream:packages/coding-agent/src/session/model-controls.ts:669`).
- The `ultrathink` keyword bypasses the classifier and the ceiling and takes the highest supported effort (`upstream:packages/coding-agent/src/session/model-controls.ts:676`).
- On any failure it keeps the last classified level, or the provisional level before the first resolution (comment block at `upstream:packages/coding-agent/src/session/model-controls.ts:660-666`).
- The result is published as the turn's effort. The transcript records a change entry only when the level actually changed (`upstream:packages/coding-agent/src/session/model-controls.ts:753`, `upstream:packages/coding-agent/src/session/model-controls.ts:759`).

### The classifier

- Input is the prompt, or, for a task-spawned turn, only the delegator's `solutionSpace` text (`upstream:packages/coding-agent/src/auto-thinking/classifier.ts:162-166`). The text is shortened by a pre-processor first.
- It asks a calibrated multiple-choice question to a judge resolved from the `judge` model role. The ladder is `low | medium | high | xhigh | max` and the rubric lives in a JSON prompt file (`upstream:packages/coding-agent/src/prompts/judge/auto-thinking.json`; the keys are `bucket`, `level` and `solutionSpace`).
- A judge that is a small local model gets a coarser 3-way question, `trivial | moderate | hard`, mapped to `low | high | xhigh`, because 3-class is more reliable than 4-way ordinal on very small models (`upstream:packages/coding-agent/src/auto-thinking/classifier.ts:9-12`, `upstream:packages/coding-agent/src/auto-thinking/classifier.ts:40-44`).
- It short-circuits without any judge call when zero or one tier is available (`upstream:packages/coding-agent/src/auto-thinking/classifier.ts:169-177`).
- A judge answer for a level the model does not support is an error (`upstream:packages/coding-agent/src/auto-thinking/classifier.ts:189-191`).
- The chosen effort is clamped into the model's supported range and never below `low`, and never above the ceiling (`upstream:packages/tui/src/thinking.ts:289`).
- Before the first classification the session shows a provisional effort: the model's default, capped at `xhigh` so an unclassified turn never bills the top tier (`upstream:packages/tui/src/thinking.ts:421`).
- Usage of the judge call is recorded on the session (`upstream:packages/coding-agent/src/auto-thinking/classifier.ts:125`; call site in `upstream:packages/coding-agent/src/session/model-controls.ts:683-700`).

Upstream never changes the model in this path. It only sets effort.

## 2. omp2 inventory

### Effort plumbing

- The session-level selection is `ai_thinking`, a string with `off, minimal, low, medium, high, xhigh, max` suggestions, flags `archive | session | project` (`crates/agent/src/vars.rs:145`). It has no `auto` value.
- The catalog has its own `ai_default_thinking` (`crates/catalog/src/settings.rs:1191`) and a universal `ai_thinking_ceiling` defaulting to `Max` (`crates/catalog/src/settings.rs:1203`). The legacy path for the default is `defaultThinkingLevel` (`crates/catalog/src/settings.rs:1199`).
- The type is `ThinkingEffort` (`crates/catalog/src/thinking.rs:36`). There is a coarse `ThinkingEffortSelector` (`Lo | Med | Hi`) used by delegated tasks (`crates/catalog/src/thinking.rs:113`).
- The router clamps every request. `clamp_thinking_effort` bounds the requested effort by a configured ceiling and by the model's own, picking the greatest supported effort at or below it (`crates/catalog/src/thinking.rs:320`). The router calls it with the request's `thinking_ceiling` (`crates/ai/src/router.rs:143`, `crates/ai/src/router.rs:682-687`).
- The kernel builds the request with `reasoning: Setting::Unset` (`crates/agent/src/loop.rs:2343`). The effort that finally goes out is decided in the driver and the router: `ProductionInference::apply_convars` fills a still-`Unset` reasoning from the effective `ai_thinking` through `convar_reasoning` (`crates/driver/src/headless/kernel.rs:342-348`, `crates/driver/src/headless/kernel.rs:492-530`), and the router clamps it again and rejects an effort on a model without a thinking policy (`crates/ai/src/router.rs:1168-1187`). OBSERVED 2026-11-14. `ModelWatch` reads the resulting effort and reports changes (`crates/agent/src/model_watch.rs:1-11`, `crates/agent/src/model_watch.rs:24-34`).
- A Director bind that supplies `ai_thinking` is already a known case: `ModelWatch` checks `engagement_owner(AI_THINKING)` (`crates/agent/src/model_watch.rs:88`).

### Directors

- The trait is `Director` (`crates/contract/src/director.rs:630`). The hooks that matter here:
  - `binds()`: scalar convar bindings held while the engagement is active (`crates/contract/src/director.rs:640`);
  - `before_inference`: a cold async auxiliary call before the request is projected, with a mutable context holding the session, an isolated inference service, route facts and the control plane (`crates/contract/src/director.rs:653`, `crates/contract/src/director.rs:532`);
  - `prepare_inference`: a synchronous edit of the `ChatRequest` (`crates/contract/src/director.rs:662`);
  - `observe_turn`: state updates after each completed turn (`crates/contract/src/director.rs:686`).
- `MutDirectorCx.inference` is an `ErasedInference`. `execute_on(selector, request)` runs an isolated request on any catalog key or `@role` and leaves the live route untouched (`crates/contract/src/director.rs:612`, `crates/contract/src/director.rs:619`). The advisor Director already uses it for its second-model review (`crates/agent/src/directors/advisor.rs:344`).
- A `@judge` role exists. It falls back to the slow selection when unset (`crates/catalog/src/selection.rs:177`, `crates/catalog/src/selection.rs:465`, tests at `crates/catalog/src/selection.rs:1228` and `crates/catalog/src/selection.rs:1243`).
- `DirectorEffect` can carry session-layer convar writes. `Plan` and `Prewalk` use that to set `ai_model` and `ai_thinking` on handoff (`crates/contract/src/director.rs:457`, `crates/contract/src/director.rs:489`, `crates/agent/src/directors/plan.rs:137`, `crates/agent/src/directors/prewalk.rs:60`). `Prewalk` documents that it "switches models exactly once" (`crates/agent/src/directors/prewalk.rs:19-20`). The new Director must not copy that.
- Binds are written into the Director's DOM node when it is built (`crates/contract/src/director.rs:1580`, `crates/contract/src/director.rs:1591`). A bind can change while the engagement stays active: binds are the element's `bind/*` props, re-derived from the DOM on every derivation (`crates/contract/src/director.rs:900-936`), so one `Op::Set` changes one and a `Null` value clears it (`crates/contract/src/director.rs:235-246`). OBSERVED 2026-11-14.
- Standing Directors are registered in `register_standard` (`crates/agent/src/directors/mod.rs:43` shows the pattern) and the kernel engages `CompactionDirector` itself when a runtime flag is on and none is active or queued (`crates/agent/src/loop.rs:1421-1425`). The stack runs `before_inference` on every request round trip (`crates/contract/src/director.rs:1066`; call site `crates/agent/src/loop.rs:1592`).
- Not related, do not confuse: `RecoveryKind::ThinkingClassification` heals reasoning text leaked into the answer; it is not effort selection (`crates/ai/src/recovery/thinking.rs:1`).

### Gap table

| Piece | Upstream | omp2 | Gap |
|---|---|---|---|
| `auto` as a level | `defaultThinkingLevel: auto` | `ai_thinking` has no `auto` | new value, or a separate switch |
| Ceiling for auto | `providers.autoThinkingMaxEffort`, default `xhigh` | global `ai_thinking_ceiling`, default `max` | need an auto-only ceiling, default `xhigh` |
| Per-prompt classifier | judge role, 3-way or 5-way | `@judge` role exists; no effort question | new classifier and prompt |
| Clamp into model range | `clampAutoThinkingEffort` | `clamp_thinking_effort` in the router | reuse; add a floor of `low` |
| Provisional level | `resolveProvisionalAutoLevel` | none | small |
| Timeout and fallback | 4 s, keep last level | none | new |
| Judge usage accounting | appended to session | advisor's usage path | reuse |
| Transcript record | change entry only on change | `ModelWatch` emits changes | reuse |
| `ultrathink`, `chillax` | present | not found (searched: `ultrathink`, `chillax` in `crates/` by name) | out of scope |

## 3. Class

**Class c (port)**, redesigned as a Director.

Upstream's classifier is TypeScript in the session layer. omp2 has no such layer; the same job belongs in a Director. The classifier logic, the rubric and the clamp rules are ported; the wiring is new. No existing omp2 piece already does this (the router clamps an effort but never chooses one: `crates/catalog/src/thinking.rs:320`), so class a does not apply. It is additive, so class b does not apply either.

Hard rule, from the assignment: the Director chooses effort only and never switches the model in the middle of a session. Section 5 enforces it by construction and by test.

Verdict: implement, in four slices, with the application mechanism settled first.

## 4. Options

1. **Build on existing omp2 code: a router-side rule.** Make the router pick an effort from request size or tool count, with no model call. Cost: low. Fit: it is deterministic, which AGENTS.md prefers, but it cannot read what the prompt asks for, so it misjudges short hard prompts and long easy ones. It also puts policy in the router, which today only clamps. Kept as the heuristic pre-pass inside option 3, not as the whole answer.
2. **Port the TypeScript classifier into the session layer.** Cost: medium. Fit: poor. omp2 runs turns in the agent kernel, and a second place that sets effort would race the Directors and `ModelWatch`.
3. **A standing `auto_effort` Director** using the existing `before_inference` hook and the isolated `@judge` inference path (`crates/contract/src/director.rs:653`, `crates/contract/src/director.rs:619`). Cost: 3 to 5 days. Fit: good. It matches how compaction, advisor and the other standing behaviours are built (ADR 0015 puts candidate-yield ownership in Directors), and it keeps the live route untouched.

Choice: option 3, with option 1's rules as its first pass. A deterministic rule decides the obvious cases; the model decides only where rules cannot. [INFERENCE]

## 5. Plan

Superseded by ADR 0064: the slice plan there (S0a, S0b, S1 to S4) replaces the four slices below, adds the drop-safe isolated call and the judge's own effort, and applies the choice as an `ai_thinking` bind, not a request edit.

### Slice 1: settings, no behaviour

- Add the `auto` selection and `ai_auto_thinking_ceiling` (`xhigh | max`, default `xhigh`, legacy path `providers.autoThinkingMaxEffort`).
- Acceptance: both parse and round-trip through the settings tests; the ceiling is capped by `ai_thinking_ceiling` (`crates/catalog/src/settings.rs:1203`); nothing reads them yet.
- Gate: ships behind default-off convar `sv_auto_effort`.

### Slice 2: the Director with the heuristic pass only

- Add `crates/agent/src/directors/auto_effort.rs`, register it in `register_standard`, engage it like compaction when `sv_auto_effort` is on, and apply the choice by request edit.
- Acceptance: with a fake inference service, short prompts resolve to `low`, a tool-continuation request never re-classifies, and the effort inside a turn is constant. A test fails if the Director's effect contains any write named `ai_model`.
- Gate: `sv_auto_effort`, default off.

### Slice 3: the `@judge` call

- Add the rubric prompt file and one isolated `execute_on("@judge", ...)` request with a 4 s timeout and journaled usage.
- Acceptance: fake-judge tests cover every label, `max` accepted only when the ceiling is `max` and the model lists it, an unsupported label keeps the previous level, timeout and parse failure fall back without failing the turn, and a replay of the journal gives the same effort with no judge call.
- Gate: same convar.

### Slice 4: surfaces

- Show the resolved effort in the chat badge and RPC through `ModelWatch`.
- Acceptance: a session with `auto` reports a concrete effort, never the string `auto`, in `crates/chat/src/host.rs:953` and `crates/app/src/rpc_mode.rs:1156`.

Estimate for all four slices: 3 to 5 days including tests. [INFERENCE]

### Design (applies to slices 2 and 3)

#### Shape

- **Family** `auto_effort`, in `crates/agent/src/directors/auto_effort.rs`, registered in `register_standard`. It claims no `Slot` (it must not block Plan, Goal or Loop, which claim `Mode` or `Loop`; `Slot` is at `crates/contract/src/director.rs:190`). It never returns a verdict other than `Pass`, because it does not own yields.
- **Engagement.** The kernel engages it, like compaction, when `ai_thinking` is `auto` (or when the auto setting is on). It disengages when the user pins a level. Superseded by ADR 0064 D2-D4: engaged per turn when `ai_auto_effort` is on, never removed, inert when the gate is off; no pin detection.
- **When it runs.** `before_inference`, but only on the first request of a user turn. Detect that by remembering the last classified user-turn id in the Director's durable state (`state()` at `crates/contract/src/director.rs:645`) and comparing it with `cx.turn`. Tool-continuation round trips return `Prepared::Unchanged` at once. This also keeps the effort stable inside a turn, which protects the provider's cached prompt prefix. [INFERENCE]
- **Inputs.** The latest user text (and, for a task-spawned child, the delegator's `solutionSpace`, which omp2 already carries; not traced here, UNVERIFIED). Nothing else is needed for a first slice.

#### Classifier

Superseded by ADR 0064 D6 and D7: the selector is `@tiny`, the short-prompt rule below is removed, and the call is bounded to one attempt per turn (round 3 removed the failure cooldown).

- A heuristic pre-pass answers the obvious cases without a model call: an empty or very short prompt maps to `low`; a prompt that is only a slash command or a yes/no maps to `low`. [INFERENCE]
- Otherwise one isolated request through `cx.inference.execute_on("@judge", request)`. The request asks for exactly one label of `low | medium | high | xhigh | max` with a fixed rubric stored as a prompt file next to the other prompts. It is cheap, short and non-streaming. The ladder offered excludes `max` unless the auto ceiling is `max`.
- Timeout 4 s, copied from upstream. On timeout, error or an unparseable answer the Director keeps the previous auto choice, or the provisional effort on the first turn, and journals a debug notice. It never fails the turn.
- Use the coarse 3-way question when the `@judge` route resolves to a small local model. Whether omp2 can tell that from `RouteFacts` is UNVERIFIED (`RouteFacts` has no size or locality field, `crates/contract/src/director.rs:268-287`). First slice: always 5-way.

#### Applying the result (the part that needs a decision)

Three ways to apply it. All three only change effort.

1. **Session write.** Return a `DirectorEffect` with `with_write("ai_thinking", ...)`. Journaled, visible to `ModelWatch`. Problem: the write would overwrite the user's `auto` selection, and effects are committed at a yield or settled-turn boundary, not before the request. [INFERENCE]
2. **Bind.** `binds()` supplies `ai_thinking` while engaged. `ModelWatch` already treats that as a Director-supplied effort (`crates/agent/src/model_watch.rs:88`). The user's `auto` stays stored under the engagement. Problem: binds look fixed at node build time, so a changing value may need a re-engagement or a state update path. UNVERIFIED.
3. **Request edit.** `prepare_inference` sets `req.reasoning` (the field built as `Unset` at `crates/agent/src/loop.rs:2343`) from the stored choice. Simple and local; not journaled, so `ModelWatch` and the UI badge would not show it unless the choice is also journaled in Director state. [INFERENCE]

Superseded by ADR 0064 D8: option 3 skips `convar_reasoning`, because the driver fills only an `Unset` reasoning (`crates/driver/src/headless/kernel.rs:346`), so a model without a thinking policy fails the request (`crates/ai/src/router.rs:1179-1185`); the ADR chooses option 2, which the bind trace above makes cheap. The original recommendation, kept for the record: store the choice in Director state (`StateUpdate`), apply it with option 3 on every request of the turn, and publish it for the UI through the existing `ModelWatch` path if it can be made to observe it. Option 2 is better if a bind can be updated cheaply. The first slice should settle this by reading how `ai_thinking` flows into the router, which this research did not trace.

#### The invariant: effort only, never the model

- The Director never writes `ai_model`, never reads or writes a model role, and never calls `execute_on` with a selector for the main route. Its only auxiliary model is `@judge`, and only through the isolated path that leaves the live route untouched (`crates/contract/src/director.rs:616-619`).
- It never changes `ai_thinking_ceiling`. It reads the model's allowed range through the same clamp the router already applies (`crates/catalog/src/thinking.rs:320`), so an effort the model cannot take falls to the nearest supported one below.
- Enforce it by construction and by test: the Director's `DirectorEffect` never contains a write named `ai_model`; a test fails if any `with_write` name other than `ai_thinking` appears (compare the existing plan test that asserts an `ai_thinking` write, `crates/agent/tests/directors/plan.rs:89`).
- The `@judge` call may itself run on a different model. That is an isolated auxiliary request, not a change of the session's model, and its tokens must be journaled as judge usage (as the advisor does). Say so in the user-facing docs. Superseded by ADR 0064 D7: the role is `@tiny` and its usage goes to `tracing`, since the journal has no judge receipt role (O5).

#### Settings

- `ai_thinking = auto` as a new accepted value, or a boolean `ai_thinking_auto`. Prefer the value, to match upstream's `defaultThinkingLevel: auto` and its migration path; the catalog's legacy path for the default is `defaultThinkingLevel` (`crates/catalog/src/settings.rs:1199`), so a legacy import maps with no new name.
- `ai_auto_thinking_ceiling`: `xhigh | max`, default `xhigh`, legacy path `providers.autoThinkingMaxEffort`. It applies only to the Director's choice and is capped by the global `ai_thinking_ceiling` (`crates/catalog/src/settings.rs:1203`).
- Remember the global ceiling defaults to `Max`; the auto ceiling must not inherit that default.

#### Tests

- Unit: a fake `ErasedInference` returns canned labels. Cases: label to effort, ceiling `xhigh` rejects `max`, ceiling `max` allows it only on a model that lists it, unsupported label falls to the previous level, timeout falls back, tool-continuation requests do not call the judge, the invariant test above.
- Router: add a case for a model whose supported efforts skip the requested one, using the existing clamp tests (`crates/catalog/src/thinking.rs:320`).
- Replay: a journal replay yields the same effort without a judge call, because the choice sits in Director state. [INFERENCE]

## 6. Open questions

- **Cache.** Changing effort between turns may break a provider's prefix cache on some routes. Upstream notes that only models taking per-message effort relax mid-run (`upstream:packages/coding-agent/src/session/model-controls.ts:735`); omp2 has no such flag that I found (searched: `per_message` effort in `crates/catalog`, not exhaustive). Classify once per user turn, never inside a turn.
- **Cost and latency.** A judge call on every prompt costs tokens and up to 4 s. The heuristic pre-pass and the short-circuit when only one tier exists limit it.
- **Judge availability.** `@judge` falls back to the slow model (`crates/catalog/src/selection.rs:465`), which may be expensive. Resolved in ADR 0064 round 2: the classifier uses `@tiny` (ADR 0023).
- **Subagents.** A child session inherits `ai_thinking`. Whether a child of an `auto` parent should also classify, or take the delegator's `solutionSpace`, is open.
- **Wire visibility.** Adding a value to `ai_thinking` touches `ModelWatch`, the chat badge (`crates/chat/src/host.rs:953`) and RPC (`crates/app/src/rpc_mode.rs:1156`). Each reads it as an effort string today. That is a change to an existing convar's accepted values, so under the additive-only rule the separate boolean is the safer fallback; the owner should choose.
- UNVERIFIED: whether `solutionSpace` is available to a child's Director. (How `ai_thinking` reaches the router and whether binds can change while engaged are now traced in section 2.)
- Found in round 1 (ADR 0064 Context): an isolated `chat_on` call leaves the client on the judge's model if its future is dropped (`crates/driver/src/headless/kernel.rs:1822-1839`), and it gives an `Unset` request the session's `ai_thinking` (`crates/driver/src/headless/kernel.rs:424-436`).

## 7. Upstream origin and license

A port draws from `upstream:packages/coding-agent/src/auto-thinking/classifier.ts` (197 lines, TypeScript, rewritten in Rust), the rubric `upstream:packages/coding-agent/src/prompts/judge/auto-thinking.json`, and the clamp functions in `upstream:packages/tui/src/thinking.ts`. The upstream `LICENSE` is MIT (copyright Mario Zechner, Can Bölük, Stencil Labs, Inc.; `upstream:LICENSE:1-5`). Keep the notice for any copied prompt text. No third-party code is involved.
