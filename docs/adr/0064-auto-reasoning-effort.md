# 0064. Automatic reasoning effort is a Director that chooses effort only and never switches models

Status: Proposed 2026-11-14; machine-reviewed (EGM, 3 rounds), not owner-approved
Date: 2026-11-13 (revised 2026-11-14)
Area: control-plane

Research: [docs/research/auto-reasoning-effort.md](../research/auto-reasoning-effort.md) (Gap 5 of the upstream gap closure). Upstream pin `c308970263` (v18.20.0); omp2 base `origin/omp2 9cb6fd6389`. Citations: `upstream:` is the OMPv1 pin; bare paths are omp2. Source was read only; nothing was built or run for this record. This record states decisions; the note holds the evidence.

**Review state.** The design was reviewed in three rounds by fresh-context machine reviewers (EGM: four reviewer personas and a synthesis per round, none seeing the author's context). It is machine-reviewed and **not owner-approved**. All behaviour ships behind the default-off convar `ai_auto_effort` (D2). Slices S0a and S0b change existing driver code without a gate and MUST NOT land until the owner rules on O7; S3 depends on them.

## Context

### Terms used here

- **Director** (ADR 0015): a standing behaviour stored as a `<director>` element in the session DOM. Hooks: `before_inference` (async, before each request, may make an isolated model call; the kernel's call of it is the **preflight**), `prepare_inference` (sync request edit), and verdict hooks at a yield, where `Pass` means "not mine" (`crates/contract/src/director.rs:630-690`). `before_inference` returns `Prepared::Unchanged` or `Prepared::Rebuild` (re-project the request) (`crates/contract/src/director.rs:524-530`). Directors nest: a newly engaged one becomes a child of the innermost active one (`crates/contract/src/director.rs:960-971`), and removing an element removes its subtree (`crates/dom/src/op.rs:47-48`).
- **Slot**: an exclusive resource a Director may claim (`mode | loop | tool_choice | worktree`); a second claimant waits in a queue (`crates/contract/src/director.rs:190-199`, `crates/contract/src/director.rs:963-971`). Effort is not a slot.
- **Convar** (ADR 0012): a typed setting. Flags say where it may be set: `archive` (user config), `session` (journaled per session), `project` (repository cfg).
- **Bind / engagement layer**: a Director's `bind/<convar>` element property. Active Directors' binds form layers above the user's own values; later layers win (`crates/con/src/ctx.rs:1060`). `value_below_engagements` is the value a bind shadows (`crates/con/src/ctx.rs:1169`).
- **`state/*`**: a Director's durable properties, written by a journaled `patch` of `Op::Set` operations with a `Txn` label (`crates/contract/src/director.rs:1628-1650`). Values are `BindValue` (`Bool | Int(i64) | Str | Float | List`, `crates/contract/src/director.rs:200-210`).
- **Turn**: one `<turn>` element, identified here by its `Handle` (`cx.turn`, `crates/contract/src/director.rs:540-545`), stored as `BindValue::Int(handle.get())` as the stack's owner ids do (`crates/contract/src/director.rs:925`). A turn holds many requests; a **continuation** is any request after the turn's first `<assistant>` (tool follow-ups, `Verdict::Continue`).
- **Effort**: a `ThinkingEffort`, spelled `off | minimal | low | medium | high | xhigh | max` (`crates/catalog/src/thinking.rs:30-53`). A model's thinking policy lists its non-`off` efforts, never empty and never containing `off` (`crates/catalog/src/thinking.rs:251-258`). An **effort-required model** has `requires_effort = Some(true)`: `off` is invalid for it (`crates/catalog/src/thinking.rs:226-227`, `crates/catalog/src/thinking.rs:279-284`).
- **Label**: in the judge prompt, an effort's own spelling; there is no separate mapping.
- **Policy clamp**: `convar_reasoning` in the driver maps an effort name to what the target model can take (`crates/driver/src/headless/kernel.rs:492-530`); the router then clamps by the configured ceiling.
- **`RouteFacts`**: catalog facts about the route the next request uses, given to Directors (`crates/contract/src/director.rs:266-287`). **`RuntimeFlags`**: switches read once when the kernel is composed (`crates/agent/src/loop.rs:437-446`).
- **Isolated call**: `ErasedInference::execute_on(selector, request)` from a Director, served by the driver's `chat_on`, on another model or `@role` without changing the session's model (`crates/contract/src/director.rs:612-624`).
- **`@tiny`**: the role ADR 0023 reserves for harness chores; unassigned it resolves to `@commit`, then `@smol` (`crates/catalog/src/selection.rs:460-464`).
- **Model** in "never switches models": the catalog model key of the session route. A thinking policy may route one effort to a sibling wire id of the same catalog model (`crates/catalog/src/thinking.rs:449-490`); that is effort, not a model switch.
- **`ModelWatch`**: the kernel's `model_changed` emitter, which watches `ai_thinking` (`crates/agent/src/model_watch.rs:60-66`). **`Plan` / `Prewalk`**: built-in Directors that hand off to another model and effort (`crates/agent/src/directors/plan.rs:137`, `crates/agent/src/directors/prewalk.rs:60`). **`TurnReceipt` / `ReceiptRole`**: the journal's usage record and its role (`crates/journal/src/data.rs:630-636`). **`ScriptedInference`**: the e2e harness's canned-response inference (`crates/e2e/src/support/scripted.rs:15-44`). **P6**: the crash-and-resume e2e proof (`crates/e2e/README.md`).

### What OMPv1 does

- `defaultThinkingLevel` accepts every effort plus `auto` (`upstream:packages/coding-agent/src/session/settings.ts:240-243`). `providers.autoThinkingMaxEffort` is `xhigh | max`, default `xhigh` (`upstream:packages/coding-agent/src/session/settings.ts:1156-1160`). `max` is reachable only when the setting says so and the model lists it (`upstream:packages/coding-agent/src/auto-thinking/classifier.ts:135-138`).
- Once per user turn, before the request, a judge answers one multiple-choice question on `low | medium | high | xhigh | max`, filtered to the model's efforts (`upstream:packages/coding-agent/src/auto-thinking/classifier.ts:86-99`). It asks nothing when exactly one tier other than `max` is eligible, and clamps to `low` when none is (`upstream:packages/coding-agent/src/auto-thinking/classifier.ts:169-177`). The judge role defaults to `@tiny`, `@smol`, `@default` (`upstream:packages/coding-agent/src/config/model-resolver.ts:1280`).
- The judge input is the prompt alone, through the shared tiny-model preprocessor (`upstream:packages/coding-agent/src/tiny/message-preproc.ts:1-13`). The judge request disables reasoning, uses temperature 0 and a 4096-token cap, and retries a parse twice with a forced answer tool (`upstream:packages/ai/src/judgment/chat.ts:28`, `upstream:packages/ai/src/judgment/chat.ts:50`, `upstream:packages/ai/src/judgment/chat.ts:78-80`). The rubric's instructions carry a `{{#if withMax}}` clause shown only when `max` is offered (`upstream:packages/coding-agent/src/prompts/judge/auto-thinking.json`, `level.instructions`; `upstream:packages/coding-agent/src/auto-thinking/classifier.ts:63-72`).
- The result is clamped: floor at `low` against the model's own ladder first (the full ladder only if nothing is at or above `low`), then the ceiling; an empty pool is `undefined` and leaves the level alone (`upstream:packages/tui/src/thinking.ts:268-300`). A 4 s timeout; on failure the last level, or a provisional one capped at `xhigh` (`upstream:packages/coding-agent/src/session/model-controls.ts:657-667`, `upstream:packages/tui/src/thinking.ts:405-425`). A result that arrives after the user left `auto` is dropped (`upstream:packages/coding-agent/src/session/model-controls.ts:715-716`). No breaker.
- `auto` is one value of the one selection; picking a level leaves it (`upstream:packages/coding-agent/src/session/model-controls.ts:586-598`). Only real user turns and user-invoked skills are classified (`upstream:packages/coding-agent/src/session/agent-session.ts:9645-9658`).

### What omp2 has

- `ai_thinking` (default `high`, no `auto`; `crates/agent/src/vars.rs:142-149`); `ai_thinking_ceiling` default `max` (`crates/catalog/src/settings.rs:1203-1206`). Convars are imported from v1 by their `legacy.path` metadata in `crates/driver/src/legacy_settings.rs:24`, `crates/driver/src/legacy_settings.rs:376`, `crates/driver/src/legacy_settings.rs:402`.
- **Effort to wire.** Requests are built with `reasoning: Unset` (`crates/agent/src/loop.rs:2343`). `apply_convars` fills a still-`Unset` reasoning from the effective `ai_thinking` through `convar_reasoning` (`crates/driver/src/headless/kernel.rs:342-348`), which gives `Unset` for a model without a thinking policy and the policy default when routing cannot resolve the effort (`crates/driver/src/headless/kernel.rs:497-523`). The router fails an effort on a policy-less model (`crates/ai/src/router.rs:1168-1187`) and fills an absent effort with its configured default (`crates/ai/src/router.rs:682-684`).
- **Binds** are re-derived from the elements (`crates/contract/src/director.rs:900-936`); a `Null` bind is skipped (`crates/contract/src/director.rs:235-246`). The kernel derives them before projecting (`crates/agent/src/loop.rs:1518-1521`), not after the preflight (`crates/agent/src/loop.rs:1592-1638`). A write to a shadowed convar reports `shadowed_by`, but no host surfaces it (`crates/con/src/ctx.rs:1333-1389`; only tests read it). The chat badge and RPC read the effective `ai_thinking` (`crates/chat/src/host.rs:951-953`, `crates/app/src/rpc_mode.rs:1156`).
- **Isolated calls.** `ProductionInference::chat_on` re-targets the shared client, awaits `execute`, then restores (`crates/driver/src/headless/kernel.rs:1822-1839`). The client copies its metadata into the call when it plans, synchronously, before any await (`crates/ai/src/client.rs:204-218`, `crates/ai/src/client.rs:226-240`). The kernel drops a preflight future on cancel and on steering, pause and approval messages, then loops (`crates/agent/src/loop.rs:1592-1624`). `chat_on` gives an `Unset` reasoning the session's `ai_thinking` (`crates/driver/src/headless/kernel.rs:424-436`). Existing isolated callers send `Unset` (`crates/agent/src/directors/advisor.rs:697`, `crates/driver/src/headless/reflection.rs:140`). The speech rewriter's production path builds its own call metadata (`crates/driver/src/headless/kernel.rs:1930-1941`).
- **Roles.** `@judge` (ADR 0053, proposed) falls back to the slow model (`crates/catalog/src/selection.rs:465`). ADR 0023 (accepted) puts "classify this prompt's difficulty" on `@tiny` with a fixed output ladder and earliest-match parsing (`docs/adr/0023-tiny-local-model.md:9-10`, `docs/adr/0023-tiny-local-model.md:21-30`). The upstream preprocessor is ported as `omp_ai::local::message_preproc::preprocess_tiny_message`, behind `omp-ai`'s dependency-free `local` feature (`crates/ai/src/local/message_preproc.rs:9-31`, `crates/ai/Cargo.toml:18`).
- **User turns.** A prompt is a `<user>` child of the turn (`crates/session/src/session.rs:632-638`); a user-invoked skill is `<user skill_prompt>` (`crates/session/src/session.rs:716-727`). Synthetic inputs are marked: `<user steering>` (`crates/agent/src/steering.rs:522-524`), `status=queued` (`crates/agent/src/steering.rs:295-297`), `<user async_result>` (`crates/agent/src/loop.rs:2119-2121`); custom messages are `<developer>` (`crates/session/src/custom_message.rs:169`). A tail retry rewinds the journal and keeps the turn's earlier assistant (`crates/agent/src/loop.rs:1262-1285`).
- **Children.** A child seeds every convar's effective value from the parent, then `subagent.cfg`, the class cfg, then the spawner's explicit writes (`crates/con/src/ctx.rs:1215-1236`; `docs/adr/0013-inheritance-by-seeding-and-cfg.md:53-55`). Both a fresh spawn and a resumed child build their control plane through `seeded_child_ctx` (`crates/driver/src/subagent/settings.rs:550-560`).
- **Writes of `ai_thinking`.** The chat host writes it on model switch, effort cycling and the picker (`crates/chat/src/host.rs:3956-3967`, `crates/chat/src/host.rs:4003-4009`, `crates/chat/src/host.rs:4044-4047`); `Plan` and `Prewalk` on handoff. No built-in Director binds it (`crates/agent/src/directors/plan.rs:228-233`, `crates/agent/src/directors/vibe.rs:60-63`).
- **Usage.** `ReceiptRole` is `Primary | Advisor`; compaction reads the latest non-advisor usage as context size (`crates/agent/src/directors/compaction.rs:797-814`).

### Rules that bind

- ADR 0015 (Directors), 0012 (convars), 0013 (seeding order), 0017 (routes clamp), 0023 (chores on `@tiny`), 0035 (typed errors).
- From the gap-closure brief (kept outside the tree): change nothing existing about tools, skills, convars, hooks, URL schemes or CLI commands, and put any such need to the owner; rules before models; `omp`-native names; behaviour behind a default-off gate until its tests pass.
- Gap 5's assignment: the Director chooses effort only and never switches the session model.

## Decision

**D1. Director `auto_effort`** in `crates/agent/src/directors/auto_effort.rs`, registered in `register_standard` (`crates/agent/src/directors/mod.rs:40`). No slot, no yields, `Pass` from every verdict hook, no `prepare_inference`.

**D2. Gate and engagement.** New convar `ai_auto_effort` (bool, default off, flags `archive | session`, no `project`: a repository must not turn on model calls), in `crates/agent/src/vars.rs` beside `ai_thinking`, with `ui.label` and a `ui.description` that says each prompt's text goes to the `@tiny` route. It is read live from the control plane, never through `RuntimeFlags`.
- At each turn start, beside the compaction check (`crates/agent/src/loop.rs:1419-1425`), the kernel engages `auto_effort` when the gate is on and none is active or queued. The kernel never removes it.
- The Director reads the gate on every request; off makes it inert (D3) from the next request.
- If an outer Director's exit removes it with its subtree, the next turn start re-engages it with fresh state, and the rest of that turn runs at the user's value.

**D3. Inert.** The Director makes no judge call and sets `bind/ai_thinking` to `Null` (only if it is not already) when any holds: no control plane (`MutDirectorCx::con` is `None`); the gate is off; `ai_external_thinking` is on (`crates/driver/src/headless/kernel.rs:344-346`); `RouteFacts::thinking_efforts` is empty (D8), so gateways and headless tests are inert; the ladder L (D5) is empty; or another active Director binds `ai_thinking`. The last uses a new `omp_contract::director::bind_holders(dom: &Dom, name: &str, except: Handle) -> impl Iterator<Item = Handle> + '_`, which walks the active chain as `DirectorStack::from_dom` does (`crates/contract/src/director.rs:846-861`), skips `except` (the Director's own handle, `cx.director`), and yields handles whose `bind/<name>` decodes to a value (`crates/contract/src/director.rs:235-246`, so `Null` does not count).

**D4. Precedence.** While the gate is on and the Director is not inert, its bind supplies `ai_thinking`. Every write of `ai_thinking` (user, picker, cycling, model-switch clamp, `Plan`/`Prewalk` handoff, cfg, spawner) lands below the bind. Such a value applies whenever the Director is inert and is the fallback F until the first judge answer (D5); after that it applies only while inert. To fix a level the user turns the gate off. This deviates from upstream, where picking a level leaves `auto`; making the host's level controls also clear the gate changes existing host behaviour and is owner question O2.

**D5. Ladder and fallback.** For the request's route:
- Pool = the route's efforts at or above `low`, or all of them if none is. L = the pool at or below `min(ai_auto_effort_ceiling, ai_thinking_ceiling)`. An empty L is inert (D3). This is upstream's order (`upstream:packages/tui/src/thinking.ts:290-299`). Because a policy never lists `off` (`crates/catalog/src/thinking.rs:256-258`), the only sub-`low` tier is `minimal`, so a sub-`low` L has one element.
- `clamp_L(x)` = the greatest element of L at or below x, else the lowest element of L.
- **F** = `clamp_L(state/effort)` when `state/effort` is set, else `clamp_L(value_below_engagements("ai_thinking"))`. Only a parsed judge answer writes `state/effort` (D7).

**D6. What each request does**, in `before_inference`, in order:
1. **Inert** (D3): clear the bind; stop.
2. **Already handled or not classifiable.** If `state/attempted` equals this turn, or the turn already has an `<assistant>` child, or its first `<user>` child is missing or carries `steering`, `async_result` or `status=queued`: keep the current effort, setting the bind to `clamp_L(bind)` if a bind is set, else to F; stop. A turn whose input is a `<developer>` custom message, and a tail retry (which keeps its earlier assistant), are therefore not classified. A `<user skill_prompt>` is classifiable.
3. **Shortcuts, no call.** L has one element: bind it. The prompt text t (the first `<user>` child's text through `preprocess_tiny_message`; attachments ignored) is empty: bind F.
4. **Judge** (D7).

The bind is written only when its value changes; the Director returns `Prepared::Unchanged`. The judge input is the first user message alone, as upstream: a terse follow-up such as "yes, do it" is judged on its own words. That limitation is inherited, not designed. "Effort is constant inside a turn" holds unless the Director turns inert or an outer Director's exit removes it mid-turn (D2).

**D7. The judge call.**
- Selector `@tiny` (ADR 0023), never `@judge`.
- Patch `auto_effort.attempt` sets `state/attempted` to the turn before the call, so the turn costs at most one call. If the kernel drops the future (steering, pause, approval, cancel; `crates/agent/src/loop.rs:1592-1624`), step 2 keeps the previous effort for that turn. A guard in the future emits `tracing::debug!(outcome = "dropped")` when dropped before it finishes.
- Prompt: one system message and one user message. The system message is `crates/agent/prompts/auto_effort/judge.md` (upstream's `level.instructions`, adapted), then `crates/agent/prompts/auto_effort/max_clause.md` only when `max` is in L (upstream's `withMax` clause), then one `- <label>: <criterion>` line per label in L from `crates/agent/prompts/auto_effort/criteria.md` (upstream's `level.criteria`, `low` to `max`), then the sentence `Answer with exactly one of: <labels of L joined by " | ">.` All three files are `include_str!`; the Rust renderer only concatenates them, as the advisor builds its request (`crates/agent/src/directors/advisor.rs:653-675`). The user message is `<request>` + t + `</request>`.
- Request: `reasoning: Prefer(ReasoningRequest { visibility: Hidden, effort: Some(off), max_tokens: None, preserve_signatures: false })`, temperature 0, `max_output_tokens` 4096, no tools. S0b resolves the `off` for the judge model; on an effort-required model it becomes that model's lowest effort, so the judge reasons briefly and costs more than the estimate below. `@tiny` is expected to resolve to a small model, but this record does not require it to avoid effort-required models.
- Parse, earliest match (ADR 0023): split the answer on whitespace, strip surrounding punctuation, lowercase; the first word equal to a label in L wins. None is unparseable. One attempt: upstream's forced-tool retries do not fit the 4 s budget.
- `tokio::time::timeout` of 4 s around opening the stream and draining it, reading text and usage from the stream events as the advisor does (`crates/agent/src/directors/advisor.rs:716-760`). No shared helper with the advisor, reflection or speech rewriter is introduced: their parsing and fallbacks differ; a common one-shot helper is a separate refactor.
- After the call, re-run D3; if the Director is now inert (gate off, another bind), drop the result (as `upstream:packages/coding-agent/src/session/model-controls.ts:715-716`).
- Success: patch `auto_effort.apply` sets the bind (if changed) and `state/effort` to the label. Timeout, error or unparseable: the bind becomes F (if changed). No breaker, no counters in state: outcome, latency and token counts go to one `tracing::debug!` event per call. No `TurnReceipt` (O5).

**D8. Applying the choice: a bind, resolved by the policy clamp.** The Director's only output is `bind/ai_thinking`. The projected request does not depend on `ai_thinking`, which is read at `chat` time (`crates/agent/src/loop.rs:2343`, `crates/driver/src/headless/kernel.rs:342-348`). The kernel re-derives binds once more after the preflight: one `directors.apply_binds(session.dom(), con)` after the `Prepared::Rebuild` block closes (`crates/agent/src/loop.rs:1629-1638`) and before `response_ordinal` is computed; a no-op when nothing changed (`crates/con/src/ctx.rs:1123-1137`). The effective `ai_thinking` then reaches the wire through `convar_reasoning` exactly as a user value does. New field `RouteFacts::thinking_efforts: SmallVec<ThinkingEffort, 6>` (inline, no allocation; `route_facts` runs per request, `crates/agent/src/loop.rs:2307-2312`), copied by the driver's `route_facts` from the model's thinking policy (`crates/driver/src/headless/kernel.rs:3554`), empty without a catalog route. Each change of the bind raises `model_changed` with reason `role` (`crates/agent/src/model_watch.rs:41-60`); hooks see that stream on turns where only effort changed, which is expected.

**D9. Effort only, enforced.** Never writes `ai_model` or any session convar, never reads or writes a model role, never sets `ChatRequest::reasoning` on the main request, binds nothing but `ai_thinking`, calls only `@tiny`. Tests fail on any other `bind/*`, any `DirectorEffect` write, or a different main-request catalog model with the gate on versus off.

**D10. Ceiling.** New convar `ai_auto_effort_ceiling` (`ThinkingEffort`, default `xhigh`, flags `archive`, `legacy.path` `providers.autoThinkingMaxEffort`), in `crates/catalog/src/settings.rs` beside `ai_thinking_ceiling`, with a `validate:` function (as `AI_THINKING_BUDGETS`, `crates/catalog/src/settings.rs:1208-1214`) accepting only `xhigh` and `max`. Two ceilings feed L because `ai_thinking_ceiling` also caps the user's own choices; the auto ceiling caps only the classifier and carries upstream's setting.

**D11. Children.** At the end of `seeded_child_ctx` (`crates/driver/src/subagent/settings.rs:557`), the driver writes `ai_auto_effort false` at `Origin::Class`, unconditionally. Fresh spawns and resumed children both pass there, so a child never classifies, whatever the scope it was seeded from. This is the spawner-explicit position of ADR 0013's order (`docs/adr/0013-inheritance-by-seeding-and-cfg.md:53-55`), not a private inheritance rule. A child starts from the seeded effective `ai_thinking` (the parent's auto effort at spawn), then its cfg, class and task effort as today. Upstream's `solutionSpace` classification of task turns is not ported (O3).

### State schema

| Property | Type | Written | Meaning |
|---|---|---|---|
| `bind/ai_thinking` | `Str` or `Null` | only on change, in `auto_effort.apply` or `auto_effort.settle` | the bound effort |
| `state/effort` | `Str` | `auto_effort.apply`, on a parsed judge answer only | the last judged effort |
| `state/attempted` | `Int` (turn handle) | `auto_effort.attempt` | the turn whose judge call has started |

D6 steps 1-3 write through one `auto_effort.settle` patch, and only when the bind changes. A fresh element has `Null` and no `state/*` keys; `from_node` reads absent keys as unset.

## Not ported from upstream

The judgment cache; the on-device three-bucket question; `solutionSpace` classification of task turns (D11); upstream's provisional level (F before the first judge answer is the user's value); parse retries (D7); `ultrathink`/`chillax` (O8); asking a judge candidate when the only tier is `max` (D6 binds it); picking a level leaving `auto` (D4, O2).

## Rejected options

| Option | Why not |
|---|---|
| Set `req.reasoning` in `prepare_inference` | Skips `convar_reasoning` (`crates/driver/src/headless/kernel.rs:346`); a policy-less model then fails the turn (`crates/ai/src/router.rs:1179-1185`). |
| Session-layer write of `ai_thinking` | Overwrites the user's value and commits only at a yield boundary. |
| `@judge` as the classifier | Falls back to the slow model (`crates/catalog/src/selection.rs:465`); ADR 0023 puts the chore on `@tiny`. |
| Pin when the value below the bind changes | Model switches, cycling and handoffs write `ai_thinking` (`crates/chat/src/host.rs:3956-3967`), so routine actions would end auto; an equal-value pick is invisible. |
| Kernel removes the Director when the gate is off | Removal takes later-engaged Directors nested under it (`crates/contract/src/director.rs:1054-1061`). |
| Engage once at composition, as stream rules are (`crates/driver/src/headless/kernel.rs:2911-2918`) | An outer Director's exit would remove it for the rest of the process. |
| A short-prompt word/grapheme rule | Upstream has none (`upstream:packages/coding-agent/src/auto-thinking/classifier.ts:147-197`); whitespace word counts fail on unspaced scripts. |
| A failure breaker with journaled counters (round-2 D7) | No reader; cost is already bounded by one call per turn and the 4 s timeout; upstream has none; each counter adds a journaled patch per judged turn. Replaced by `tracing` fields (round 3, S11). |
| Classifier quality and latency measurement in this record (round 3, S28) | Rejected here in favour of S11's smaller state; whether to add a non-gating recorder is O9. |
| `Prefer` with no effort instead of an explicit `off` for the judge | The router fills an absent effort with its configured default (`crates/ai/src/router.rs:682-684`), so the judge would reason at the default level. |
| A new `Slot::Effort` | Effort owners write or bind, they do not claim; a conflict queues rather than yields. |
| Router-side size rule; a session-layer port; switching models | Cannot read the prompt; races Directors; out of scope by the assignment. |

## Slices

One PR each; tests written first and not edited to pass. Verify with `just test-pkg <crate>` for the named crates, then `just lint`.

**S0a. Drop-safe `chat_on`** (`crates/driver`). Blocked on O7. `ProductionInference::chat_on` sets the judge metadata, plans the call with `Client::plan` (which copies the metadata synchronously, `crates/ai/src/client.rs:204-218`), restores the live metadata, and only then awaits `execute_plan`. No await falls between the two writes, so a drop cannot leave the client re-targeted, and the `&mut` borrow excludes any other user of this client meanwhile; the speech rewriter's production path never shares it (`crates/driver/src/headless/kernel.rs:1930-1941`). It also fixes the advisor's exposure and may land standalone.
- Tests (in `crates/driver/src/headless/kernel.rs` tests, with a never-answering local TCP provider as in `crates/driver/tests/provider_rejection_surfaces.rs`): `dropped_chat_on_restores_the_live_target`, `timed_out_chat_on_restores_the_live_target`, `completed_chat_on_still_restores`.
- Acceptance: `crates/agent/tests/advisor.rs` passes unchanged. Gate: none (O7).

**S0b. Explicit effort on `ProductionInference::chat_on`** (`crates/driver`). Blocked on O7. A request whose `reasoning` carries an effort is re-resolved for the target model by a new `isolated_reasoning(catalog, model, requested: &ReasoningRequest)`: no policy → `Unset`; the effort if `policy.supports` it; else, for `off`, the lowest listed effort; else `clamp_thinking_effort(policy, Some(effort), None)`; never `policy.default_level`; `Unset` if routing still cannot resolve it. Only the effort is rewritten; the `Setting` variant, visibility, `max_tokens` and `preserve_signatures` are kept. `Unset` requests keep `default_reasoning`.
- Tests (beside `crates/driver/src/headless/kernel.rs:5049-5097`): `explicit_off_ignores_ai_thinking`, `explicit_effort_on_policyless_model_is_unset`, `explicit_off_on_effort_required_model_takes_lowest_listed`, `explicit_off_never_takes_default_level`, `explicit_effort_keeps_variant_visibility_and_budget`, `unset_isolated_call_still_inherits_ai_thinking`.
- UNVERIFIED: how each codec spells `off` on a model whose wire has no "none" value; S0b's tests pin only the canonical request.
- Gate: none; no existing caller sends an explicit effort.

**S1. Settings** (`crates/agent`, `crates/catalog`, `crates/driver`). D2 and D10, with the gate's `ui.*` metadata; nothing reads them.
- Tests: `ai_auto_effort_defaults_off` (`crates/agent/tests/directors/auto_effort.rs`); `auto_effort_ceiling_accepts_only_xhigh_and_max`, `auto_effort_ceiling_defaults_to_xhigh` (`crates/catalog/src/settings.rs` tests); `legacy_path_maps_providers_auto_thinking_max_effort` (`crates/driver/src/legacy_settings.rs` tests, beside `converters_reshape_legacy_values` at `:739`); `ai_auto_effort_is_refused_in_project_cfg` (`crates/driver/tests/project_cfg_authority.rs`).
- Gate: `ai_auto_effort` default off.

**S2. Director without the judge** (`crates/agent`, `crates/contract`, `crates/driver`). D1-D6, D8, D9, D11 and the state schema; step 4 binds F. Adds `RouteFacts::thinking_efforts`, `bind_holders`, the kernel engage, the extra `apply_binds`, and the `seeded_child_ctx` write.
- Tests (`crates/agent/tests/directors/auto_effort.rs`, registered in `crates/agent/tests/directors/main.rs`; fake `ErasedInference` counting calls; route facts with a ladder):
  - gate: `engaged_at_turn_start_when_on`, `never_removed_when_off`, `gate_read_live_not_from_runtime_flags`, `reengaged_after_outer_director_exit`;
  - inert: `inert_without_con`, `inert_when_gate_off_clears_bind`, `inert_under_external_thinking`, `inert_without_route_efforts`, `inert_when_ceiling_hides_every_tier_at_or_above_low` (efforts `[minimal, max]`, ceiling `xhigh`), `yields_to_another_directors_thinking_bind`, `own_bind_does_not_make_it_inert`;
  - precedence: `user_write_below_bind_is_fallback_only_before_first_judgment`, `plan_handoff_effort_is_shadowed_while_on`;
  - turn shape: `steering_aside_is_not_classified`, `async_result_turn_is_not_classified`, `developer_message_turn_is_not_classified`, `tail_retry_is_not_classified`, `skill_prompt_is_classified`, `continuation_keeps_the_turn_effort`, `effort_is_constant_inside_a_turn_without_outer_exit`;
  - ladder: `single_tier_needs_no_judge`, `minimal_only_ladder_binds_minimal`, `empty_prompt_binds_fallback`, `bind_reclamped_after_model_change`;
  - writes: `unchanged_bind_is_not_rewritten`, `state_effort_written_only_by_a_judge_answer`;
  - invariant: `only_bind_is_ai_thinking`, `no_effect_carries_a_write`, `main_request_reasoning_never_set`, `claims_no_slot`.
- Driver tests: `bound_effort_on_policyless_model_sends_no_reasoning`, `bound_effort_reaches_wire_through_convar_reasoning`, `bind_written_in_preflight_applies_to_same_request`, `spawned_and_resumed_children_have_the_gate_off` (`crates/driver/tests/subagent_cfg.rs`).
- Acceptance: gate off, every existing Director, kernel and spawn test passes unchanged. Gate: `ai_auto_effort`. Depends on: S1.

**S3. The `@tiny` judge** (`crates/agent`; `omp-agent` enables `omp-ai/local`). D7. Depends on S0a, S0b (so on O7) and S2.
- Tests (fake `ErasedInference` that records selector and request and answers from a script): `judge_selector_is_tiny`, `each_effort_name_parses_to_its_effort`, `ladder_offers_max_only_when_ceiling_and_model_allow`, `earliest_label_wins`, `label_outside_ladder_falls_back`, `unparseable_falls_back`, `timeout_falls_back_without_failing_the_turn`, `dropped_attempt_keeps_previous_effort_without_a_second_call`, `gate_off_during_await_drops_result`, `judge_request_carries_explicit_off_hidden_prefer`, `judge_input_is_preprocessed`, `classifiable_prompt_calls_the_judge_once`, `replay_makes_no_judge_call`.
- Snapshot: `insta` of the full rendered system and user messages for L = `low..xhigh` (no max clause) and `low..max` (with it), in the module's tests.
- Driver test: `judge_timeout_leaves_main_route_on_session_model`.
- Gate: `ai_auto_effort`.

**S4. Joined proof** (`crates/driver`, `crates/e2e`, `crates/session`). The badge and RPC need no change: they already read the effective value (`crates/chat/src/host.rs:951-953`, `crates/app/src/rpc_mode.rs:1156`).
- Driver joined test: a kernel composed over `ProductionInference` against a local TCP provider (the patterns of `crates/driver/tests/approval_authority.rs:322` and `crates/driver/tests/provider_rejection_surfaces.rs`), two user turns, a scripted `@tiny` answer, asserting the classified effort on each turn's first request and its continuation, one `model_changed` per bind change, and the session catalog model on every main request. UNVERIFIED that both patterns combine in one test; if not, S4 adds the support helper first.
- E2E deliverables: `ScriptedInference` gains a `chat_on` override answering from its own script and a route-facts setter with a ladder (`crates/e2e/src/support/scripted.rs:15-44`); the kernel is built `with_route_facts`; the `Ctx` sets `ai_auto_effort`. Case in P6 (`crates/e2e/tests/p6_crash_resume.rs`, in-process `Kernel` as in its `redirect_crash` module at `:615-632`): cut the journal after the `auto_effort.apply` patch (found by label, as `REDIRECT_LABEL` at `:629`), resume, assert no second judge call and the same bind; and after `auto_effort.attempt` only, assert no call and the previous effort.
- Golden journal: a new `auto_effort` family in `crates/session/tests/golden_journals.rs`, with its committed `.oms` and `.snapshot.json` pair, folding the `attempt` and `apply` patches.
- Gate: `ai_auto_effort`. Depends on: S3.

Estimate: 4 to 6 days, excluding the wait for O7. [INFERENCE]

## Upstream origin and license

Drawn from `upstream:packages/coding-agent/src/auto-thinking/classifier.ts`, the rubric `upstream:packages/coding-agent/src/prompts/judge/auto-thinking.json`, `upstream:packages/tui/src/thinking.ts` (clamp rules) and `upstream:packages/ai/src/judgment/chat.ts` (judge request settings). TypeScript, rewritten in Rust. MIT (copyright Mario Zechner, Can Bölük, Stencil Labs, Inc.; `upstream:LICENSE:1-5`); keep the notice with the adapted rubric text in `crates/agent/prompts/auto_effort/`. No third-party code.

## Consequences

- Cost, with the gate on: per classifiable user turn, one `@tiny` call of about 1.2k input tokens and a few output tokens (more on an effort-required `@tiny` model), up to 4 s before the first request. [INFERENCE]
- A steering, pause or approval message during the judge wait keeps the previous effort for that turn without a second call; on an active session this may be frequent. Only a `tracing` event records it.
- Prefix cache: effort may change at every classifiable turn, with no hysteresis. Which routes key their prompt cache on effort is not established here (`ThinkingPolicy::prefix_binding` concerns signed thinking, `crates/catalog/src/thinking.rs:218-220`); a one-level change may re-bill the whole prefix on such a route. Accepted as a risk of the opt-in gate; hysteresis and measurement are O9.
- While on, the picker, effort cycling and `Plan`/`Prewalk` handoff efforts change only the value under the bind, and the cycle's notice names a level that does not apply (`crates/chat/src/host.rs:4003-4013`). The badge shows the bound effort but not that auto chose it. This is why the gate stays opt-in until O2 is ruled.
- Isolated calls that inherit `ai_thinking` (advisor, reflection) follow the auto effort while bound.
- Privacy: with the gate on, up to 2000 characters of each prompt go to the `@tiny` route, which may be another provider or account than the session's. The gate's `ui.description` says so (S1).
- Hooks receive a `model_changed` event on each effort change (D8).
- The kernel's turn start gains a third feature-specific engagement beside goal and compaction (`crates/agent/src/loop.rs:1409-1425`); a generic "standing Director with a gate" hook would change the registry API and is left for a separate record.

## Open questions for the owner

- **O1. `auto` as a value of `ai_thinking`, or the separate gate?** Recommendation: the gate `ai_auto_effort`, so an existing convar's values do not change. A value would let the host's existing level controls leave auto as upstream does, at the cost of changing every reader of `ai_thinking`.
- **O2. Should picking or cycling a level clear `ai_auto_effort`?** It changes existing chat-host behaviour (`crates/chat/src/host.rs:3956-3967`, `crates/chat/src/host.rs:4003-4009`, `crates/chat/src/host.rs:4044-4047`); surfacing `SetReport::shadowed_by` is a smaller alternative (`crates/con/src/ctx.rs:1333-1389`). Recommendation: rule before S4, the first slice a user can see.
- **O3. Should task children classify (upstream's `solutionSpace`)?** D11 keeps them off. Recommendation: revisit with data from O9.
- **O4.** Closed in round 2: the classifier uses `@tiny`.
- **O5. A judge receipt role.** `ReceiptRole::Judge` would put spend in usage totals but changes a journaled enum (`crates/journal/src/data.rs:630-636`). Recommendation: owner decides; `tracing` meanwhile.
- **O6. Map `defaultThinkingLevel: auto` in the importer, and show "auto" on the badge?** Both change existing surfaces (`crates/catalog/src/settings.rs:1199`, `crates/chat/src/host.rs:951-953`). Recommendation: follow-ups after O1.
- **O7. The ungated fixes S0a and S0b change existing driver behaviour.** They must not land until ruled; S3 waits on them. Recommendation: accept both; gating a drop fix would keep the advisor's leak.
- **O8.** `ultrathink` and `chillax`: out of scope.
- **O9. Counters or measurement?** Round 3 asked both to drop the breaker and counters (S11) and to measure classifier quality and latency (S28). This record takes S11: state holds only what behaviour needs, and outcomes go to `tracing`. Recommendation: before any default-on proposal, add a non-gating recorder in the P8 pattern for added latency, share of turns changed, and agreement on a labelled prompt set, and decide hysteresis from it.

## What the review changed

### Round 1 (Goldfish, 2026-11-13; resolved 2026-11-14)

Five findings, each checked against this tree and the upstream pin. Some resolutions were replaced later; the replacement is named.

- **D7 bypasses the policy clamp, so a turn can fail.** Confirmed (`crates/driver/src/headless/kernel.rs:346`, `crates/driver/src/headless/kernel.rs:497-523`, `crates/ai/src/router.rs:1179-1185`, `upstream:packages/tui/src/thinking.ts:283-287`). Changed: the choice is an `ai_thinking` bind resolved by `convar_reasoning` (D8).
- **A `chat_on` drop leaves the client on the judge's model.** Confirmed (`crates/driver/src/headless/kernel.rs:1832-1837`, `crates/driver/src/headless/kernel.rs:330-341`, `crates/agent/src/loop.rs:1592-1624`). Changed: slice S0a.
- **The judge inherits `ai_thinking`.** Confirmed (`crates/driver/src/headless/kernel.rs:424-436`; upstream disables it, `upstream:packages/ai/src/judgment/chat.ts:80`). Changed: explicit `off` and slice S0b.
- **Engagement gate and precedence unspecified.** Confirmed; the "slot" framing rejected, since effort is not a `Slot` (`crates/contract/src/director.rs:190-199`). Changed: gate, inert conditions and precedence (replaced in round 2 by D2-D4).
- **S2 thresholds unspecified.** Confirmed. Changed: two named thresholds (removed in round 2).
- Corrected while revising: no judge receipt role exists (`crates/journal/src/data.rs:630-636`); binds are re-derived from the element (`crates/contract/src/director.rs:900-936`).

### Round 2 (Goldfish, 2026-11-14: 2 blockers, 13 majors, 14 minors)

- **B1. `@judge` resolves to the slow model, against accepted ADR 0023.** Confirmed (`crates/catalog/src/selection.rs:465`; `docs/adr/0023-tiny-local-model.md:9-10`, `:21-23`; `upstream:packages/coding-agent/src/config/model-resolver.ts:1280`). ADR 0023 respected, not reopened. Changed: `@tiny`, earliest-match parsing; O4 closed.
- **B2. Removing or nesting the Director can destroy other Directors and reset a pin.** Confirmed (`crates/contract/src/director.rs:960-971`, `:1054-1061`, `:1285-1288`). Changed: never removed; no pin state.
- **M1. Gate not a live read.** Confirmed (`crates/driver/src/headless/kernel.rs:2969-2990`). Changed: read live per request.
- **M2. Value-diff pin detection.** Confirmed (`crates/chat/src/host.rs:3956-3967`, `:4003-4009`). Changed: one precedence rule; O2.
- **M3. A level chosen during the await.** Partly confirmed (`crates/agent/src/loop.rs:1592-1600`); `base` removed. Changed: re-check after the await.
- **M4. "User turn" undefined.** Confirmed (`crates/agent/src/steering.rs:295-297`, `:522-524`; `crates/agent/src/loop.rs:2119-2121`). Changed: D6 discriminator.
- **M5. Children inherit the gate.** Confirmed (`crates/con/src/ctx.rs:1215-1236`; `crates/driver/src/subagent/spawn.rs:1174-1225`). Changed: D11 (moved to `seeded_child_ctx` in round 3).
- **M6. No state schema.** Confirmed. Changed: schema (reduced to three properties in round 3).
- **M7. S0b's fallback.** Confirmed (`crates/driver/src/headless/kernel.rs:519-522`). Changed: `isolated_reasoning`.
- **M8. Judge input weaker than upstream.** Confirmed; omp2 has `preprocess_tiny_message` (`crates/ai/src/local/message_preproc.rs:17-31`). Changed: reused.
- **M9. Short-prompt rule.** Confirmed. Changed: removed.
- **M10. No breaker or cost.** Confirmed. Changed then: breaker and counters (reversed in round 3, S11); cost estimate kept.
- **M11. `Rebuild` and `apply_binds` placement.** Confirmed (`crates/agent/src/loop.rs:1629-1638`). Changed: `Unchanged`, placement named. Rejected: recomputing route facts (`crates/agent/src/loop.rs:1459`, `:1520`).
- **M12. E2E harness.** Confirmed (`crates/e2e/tests/p9_extension_control.rs:63-75`). Changed: driver seam and P6.
- **M13. Vocabulary.** Confirmed. Changed: Terms.
- **Minors.** m1 (ladder edges), m2 (`bind_holders`), m3 (usage), m4 (prompt files), m5 (validation, naming), m7 (S0b scope), m8 (indicator, O6), m9 (F order), m10 (S2 tests), m11 (privacy), m14 (not-ported list) accepted. m6 (third engage) kept with precedent. m12 (STATUS.md) and m13 (altitude) rejected: the orchestrator owns STATUS.md, and gap ADRs list named tests (`docs/adr/0071-subagent-isolation.md:91`).

### Round 3 (Goldfish, 2026-11-14: 0 blockers, 14 majors, 18 minors, 1 nit)

Each finding checked against source before accepting or rejecting it.

- **S1. F and the `state/effort` write rules contradict D4.** Confirmed: D6 wrote `state/effort` on every outcome, so user writes never reached F after the first request. Changed: only a parsed judge answer writes `state/effort` (D5, D7, schema); D4 now says user values are F until the first judge answer; binds are written only on change; the "Not ported" note narrowed.
- **S2. The gate ships the shadowed-controls defect.** Confirmed: the host writes `ai_thinking` on cycling, picking and model switch (`crates/chat/src/host.rs:3956-3967`, `:4003-4013`, `:4044-4047`), and `shadowed_by` is computed but never surfaced (`crates/con/src/ctx.rs:1333-1389`). Fixing it changes existing host behaviour, which needs the owner. Changed: O1 and O2 restated with both alternatives; O2 to be ruled before S4; Consequences names the defect.
- **S3. Two or more sub-`low` tiers undefined.** Rejected: a policy never lists `off` (`crates/catalog/src/thinking.rs:256-258`), so `minimal` is the only sub-`low` tier and such an L has one element, handled by the single-tier shortcut. Added that reasoning to D5 and the test `minimal_only_ladder_binds_minimal`; effort spellings added to Terms.
- **S4. Floor and ceiling in the opposite order from upstream.** Confirmed (`upstream:packages/tui/src/thinking.ts:268-299`). Changed: D5 floors first, then caps; empty is inert; test `inert_when_ceiling_hides_every_tier_at_or_above_low`.
- **S5. Once-per-turn guard not an explicit step; turn identity.** Confirmed. Changed: D6 step 2 is the guard; turn identity defined in Terms; turns without a qualifying `<user>` child, `<developer>` turns and tail retries are not classified (`crates/agent/src/loop.rs:1262-1285`, `crates/session/src/custom_message.rs:169`). The cooldown it mentions is gone (S11).
- **S6. A control message during the await silently cancels classification.** Confirmed (`crates/agent/src/loop.rs:1592-1624`). Changed: D7 says the turn keeps the previous effort, with no second call; a drop guard emits a `tracing` event; Consequences states the frequency risk.
- **S7. Judge prompt layout and the `max` clause unspecified.** Confirmed (`upstream:packages/coding-agent/src/auto-thinking/classifier.ts:63-72`). Changed: D7 names the three files, the order, the answer sentence, the system/user split and the `<request>` framing; S3 snapshots both ladders.
- **S8. The S0a mechanism unspecified.** Confirmed. Changed: S0a plans with the judge metadata and restores before the await, since `Client::plan` copies the metadata synchronously (`crates/ai/src/client.rs:204-218`); the concurrency assumption is stated (`crates/driver/src/headless/kernel.rs:1930-1941`).
- **S9. `bind_holders` without self-exclusion.** Confirmed. Changed: signature with `except`, non-`Null` rule, `con = None` inert; test `own_bind_does_not_make_it_inert`.
- **S10. Legacy-import test at the wrong seam.** Confirmed: the conversion lives in `crates/driver/src/legacy_settings.rs:24`, `:402`. Changed: the test moved there.
- **S11 vs S28. Breaker and counters speculative, versus add measurement.** S11 confirmed: nothing reads the counters, and upstream has no breaker (`upstream:packages/coding-agent/src/session/model-controls.ts:657-667`). Chosen: S11, because state should hold only what behaviour needs and cost is already bounded by one call per turn. S28 rejected for this record; the measurement question is O9.
- **S12. Cache cost unquantified.** Confirmed as a gap; the routes that key cache on effort could not be established from source. Changed: Consequences accepts the risk explicitly; hysteresis and measurement go to O9 (new design, not added here).
- **S13. "Label" undefined.** Confirmed. Changed: Terms defines a label as the effort's own spelling; test renamed `each_effort_name_parses_to_its_effort`.
- **S14. Undefined names; review changelog in the record.** Names confirmed and defined in Terms. The changelog part rejected: the gap-closure brief requires this section in the ADR ("Method", step 6).
- **S15. "Explicit `off`" not unconditional.** Confirmed (`crates/catalog/src/thinking.rs:279-284`). Changed: D7 states the exception, the `Prefer` variant, `Hidden` visibility and the cost note; S0b names the `None` ceiling; the codec spelling of `off` is marked UNVERIFIED.
- **S16. S0b may be unnecessary.** Rejected: the router fills an absent effort with its default (`crates/ai/src/router.rs:682-684`), so `Prefer` with no effort would make the judge reason. Added as a rejected option.
- **S17. A third near-copy of the one-shot path.** Confirmed. Changed: D7 states why no shared helper is introduced.
- **S18. Two ceilings.** Confirmed as unexplained. Changed: D10 gives the reason.
- **S19. Empty route facts not an explicit inert case; per-request cost.** Confirmed (`crates/agent/src/loop.rs:2307-2312`). Changed: D3 lists it; the field is an inline `SmallVec`.
- **S20. "Constant inside a turn" is conditional.** Confirmed. Changed: D6 and the test name say so.
- **S21. One-tier rule without upstream's qualification.** Confirmed. Changed: Context bullet.
- **S22. Forward references and review-history names.** Confirmed. Changed: references reworded; round-specific option names replaced by descriptions.
- **S23. The cited brief is not tracked.** Confirmed. Changed: "Rules that bind" restates the constraints inline.
- **S24. Header versus STATUS.md.** Rejected for this change: the orchestrator owns `docs/adr/STATUS.md`.
- **S25. A terse follow-up is judged alone.** Confirmed; matches upstream. Changed: D6 states the inherited limitation.
- **S26. "Model" means the catalog key.** Confirmed (`crates/catalog/src/thinking.rs:449-490`). Changed: Terms.
- **S27. `model_changed` on every effort change.** Confirmed (`crates/agent/src/model_watch.rs:41-60`). Changed: D8 and Consequences say it is expected; the S4 joined test counts it.
- **S28.** See S11.
- **S29. Privacy documentation has no deliverable.** Confirmed. Changed: the gate's `ui.description` in D2 and S1.
- **S30. Patch labels unnamed.** Confirmed (`crates/e2e/tests/p6_crash_resume.rs:629`). Changed: `auto_effort.attempt`, `auto_effort.apply`, `auto_effort.settle`.
- **S31. S4 tests that pass without a change; missing deliverables.** Confirmed (`crates/chat/src/host.rs:951-953`). Changed: badge and RPC tests dropped; S4 lists the `ScriptedInference`, route-facts, `Ctx` and golden-pair deliverables.
- **S32. The spawner write and the resumed-child path.** Confirmed (`crates/driver/src/subagent/settings.rs:550-560`). Changed: D11 writes unconditionally in `seeded_child_ctx`, which both paths use.
- **S33. State value types.** Confirmed. Changed: the state schema table.

Machine-reviewed (EGM, 3 rounds), not owner-approved.

## Acceptance tests

1. (S0a) A dropped or timed-out isolated call leaves the next main request on the session model.
2. (S0b) An isolated call with an explicit effort carries that effort resolved for its own model, never `ai_thinking`, never the policy default, and never fails on a policy-less model.
3. (S1) `ai_auto_effort` defaults off and is refused in project cfg; `ai_auto_effort_ceiling` defaults `xhigh`, accepts only `xhigh | max`, and imports from `providers.autoThinkingMaxEffort`.
4. (S2) Gate off: nothing changes. Gate on: the bound effort reaches the wire only through `convar_reasoning`; synthetic turns, continuations and retries are not classified; the ladder follows upstream's floor-then-ceiling order; children have the gate off.
5. (S3) The judge is `@tiny` with an explicit `off` (lowest effort on an effort-required model); every failure falls back to F without failing the turn; at most one call per turn; replay makes no call.
6. (S4) The driver joined test, the P6 cases and the golden family pass.

## Status in omp

**Status: Not started.** Machine-reviewed (EGM, 3 rounds), not owner-approved; behind the default-off `ai_auto_effort`; S0a and S0b wait for O7. Reusable today: the Director trait and registry (`crates/contract/src/director.rs:630`), bind derivation (`crates/contract/src/director.rs:900-936`), `execute_on` (`crates/contract/src/director.rs:619`), the `@tiny` role (`crates/catalog/src/selection.rs:460-464`), `preprocess_tiny_message` (`crates/ai/src/local/message_preproc.rs:17`), `convar_reasoning` (`crates/driver/src/headless/kernel.rs:492`), `ModelWatch` (`crates/agent/src/model_watch.rs`). UNVERIFIED: how a remote gateway resolves an explicit effort (the Director is inert there); codec spelling of `off` on wires without "none".

## References

[docs/research/auto-reasoning-effort.md](../research/auto-reasoning-effort.md); ADR 0012, 0013, 0015, 0017, 0023, 0035. Checked for collision: ADR 0006, 0024, 0036 (no tool, sandbox or extension-runtime change); ADR 0049 (no vendor code); ADR 0053 (`@judge` not used).
