# 0068. Decision memory: friction-gated project decision files as a separate subsystem; Hindsight stays an extension

Status: Proposed 2026-11-14; machine-reviewed (EGM, 3 rounds), not owner-approved
Date: 2026-11-13 (revised 2026-11-14)
Area: memory

Research: [docs/research/memory-backends.md](../research/memory-backends.md) (Gap 14 of the upstream gap closure). Upstream pin `c308970263` (v18.20.0); omp2 base `origin/omp2 2028990110`. Citations: `upstream:` is the OMPv1 pin; bare paths are omp2. Nothing was built or run for this record; every omp2 claim was read in the tree.

Terms.
- *EGM*: the Elephant-Goldfish design review (fresh-context reviewers).
- *Mnemopi*: omp2's default-off SQLite memory backend (`omp-memory`); its prompt keys are `memory` and `standing` (Dynamic band) and `recall` (Volatile band).
- *Prompt bands*: the system prompt is built in four bands, Frozen, Stable, Dynamic and Volatile, each hashed separately so a provider's prefix cache survives changes in later bands (`crates/agent/src/prompt/mod.rs:99-117`); `crates/contract/src/slots.rs:5-18` defines them. `CanonicalPromptSource` is the production projector; `SlotId` is the fixed slot catalog (`crates/contract/src/slots.rs:20-55`).
- *Convar*: a typed setting (ADR 0012); `ARCHIVE` persists it, `PROJECT` lets a repository's cfg set it.
- *`<meta>` and `prompt-facts`*: the session DOM's metadata node and the JSON property on it that the prompt projects from.
- *`@memory`*: the catalog role selector that resolves the configured memory model, then `@commit`, then `@smol` (`crates/driver/src/headless/reflection.rs:20-23`).
- *Native hook host*: an in-process `NativeHookHost` attached to the session's hook gate; native hosts answer before Python extension hosts (`crates/contract/src/hooks.rs:758-785`).
- *Session secret rules*: the rules in the user secrets file, the project secrets file (trusted workspaces only) and the environment, as `SecretSessionSnapshot::build` loads them (`crates/driver/src/secrets/session.rs:33-55`).
- *Trusted workspace*: `WorkspaceTrust::Trusted` for the project. *Ephemeral*: a session whose journal is discarded (`KernelOptions::ephemeral`, `crates/driver/src/headless/kernel.rs:149`). *`tools_enabled`*: the composition installs the tool roster; it is off for tool-less print runs, and decision memory needs the auxiliary-inference binding that comes with it (`kernel.rs:2843`).
- *`<data>`*: the owner's private data directory (`omp_core::dirs::data_dir`). *`Hash32`*: omp's SHA-256 digest type. *`xutf`*: omp's Unicode crate.
- *Admission law*: the consolidator prompt's rule for which decisions enter the files (below). *Delta filter*: the code checks on an extracted delta (D5). Hook "admission" is the `before_agent_start` gate.
- *Auto-Learn*: the stop-time capture that writes managed skills (`crates/envd/src/host_settings.rs:106-128`).

## Context

### What OMPv1 does

- Sharpshooter is one value of the exclusive `memory.backend` setting, beside `off`, `local`, `hindsight` and `mnemopi` (`upstream:docs/memory.md:5-11`, `upstream:packages/coding-agent/src/memory-backend/resolve.ts:8-29`), driven through `/memory enqueue|queue|clear` (`upstream:docs/memory.md:160-174`).
- It is a project decision memory earned by friction. Per-prompt extraction queues deltas; consolidation applies them into `architecture.md`, `product.md` and `style.md`, each capped at 120 lines (`upstream:packages/coding-agent/src/sharpshooter/types.ts:1-8`, `:59-65`). Files live under `<agentDir>/memories/sharpshooter/<bank>/`, never in the project tree; the bank id is `<basename>-<hash>` of the working directory (`upstream:packages/coding-agent/src/sharpshooter/paths.ts:1-26`).
- A delta has a kind, a statement, an optional rejected alternative and rationale, a source (`explicit_user`, or `contextual_resolution`: a short reply resolved against the assistant's question), an `evidence` string and three friction flags (`types.ts:10-57`).
- Extraction runs in the background; while one is in flight a new prompt is not extracted (`upstream:packages/coding-agent/src/sharpshooter/extract.ts:185-223`, `:196`). Slash commands and prompts under 16 characters are skipped (`:199-207`). The current prompt is only trimmed; the previous human message (400 characters) and the last assistant message (800) are whitespace-collapsed with fenced code omitted (`:103-110`, `:137`, `:140-162`). The request uses `@smol` unless `sharpshooter.model` is set (`upstream:packages/coding-agent/src/sharpshooter/settings.ts:7-16`), requires the `record_deltas` call, 2,048 output tokens, low reasoning, transient retry (`extract.ts:238-257`). Evidence must be a substring of the uncut current prompt (`:288`). Disposal waits up to 5 s for an in-flight extraction (`:62-78`).
- Consolidation runs from a one-minute scheduler once `intervalMinutes` (default 5) have passed, backing off `max(1 min, interval) × 2^(failures-1)`, at most 6 h (`upstream:packages/coding-agent/src/sharpshooter/scheduler.ts:11`, `:40-41`; `consolidate.ts:47-49`, `:131-146`). Input: the three files, a project-docs digest, the queued deltas grouped per session, oldest session first (`upstream:packages/coding-agent/src/prompts/memories/sharpshooter-consolidate-input.md:1-25`). Output cap 32,768 tokens, floor 1,024, clamped to the free context (`consolidate.ts:35-45`, `:159-172`); medium reasoning. The admission law admits a decision only on regression, subtlety or repetition and excludes paths, line numbers and task state (`upstream:packages/coding-agent/src/prompts/memories/sharpshooter-consolidate-system.md:5-43`); it is model-judged and no code reads the friction flags. Validation: at most 120 lines per file after redaction; an all-empty reply is rejected when any current file is non-empty (`consolidate.ts:317-343`). The files are renamed one by one (`:351-362`).
- Injection: the files under "follow them unless the user overrides", cut to 15,000 tokens (`upstream:packages/coding-agent/src/sharpshooter/backend.ts:119-128`).
- Redaction covers file writes only (`consolidate.ts:330-338`; envelope sent raw at `extract.ts:238-246`), with patterns for AWS, GitHub, npm, Slack and Google tokens, keyword-led runs and JWTs (`upstream:packages/coding-agent/src/memory-backend/redact.ts:11-149`).
- Hindsight is a client for an external memory server (`upstream:docs/memory.md:134-142`).

### What omp2 has

- Mnemopi: closed `Off | Mnemopi` selector (`crates/memory/src/config.rs:25-31`), convar `ai_memory_backend` (`crates/envd/src/host_settings.rs:74-87`); with `Off` no bank scope is resolved (`crates/memory/src/runtime.rs:265-274`). Nothing writes its `memory` prompt property: `install_prompt_facts` (`crates/driver/src/headless/kernel.rs:4043-4129`) is the only production writer of `prompt-facts`, with production callers at `:2921` (`compose_kernel`), `:3417` (`SessionHome::create`) and `:3436` (`SessionHome::open`). `SessionHome` serves `/new`, `/resume`, `/fork` and `/drop` (`:3213-3218`), is built by app at `crates/app/src/session_runner.rs:152`, `crates/app/src/acp_mode.rs:68`, `crates/app/src/chat_cmd.rs:1363` and `crates/app/src/rpc_mode.rs:90`, and as struct literals at `crates/app/src/chat_control.rs:2521`, `:3920`, `:4282`, `:4442` and `crates/driver/src/headless/kernel.rs:5369`, `:5707`.
- Repository identity: `omp_vcs::detect` and `primary_root()` give the primary checkout root without a status walk (`crates/envd/src/vcs/mod.rs:52-65`, `crates/vcs/src/git/mod.rs:99-115`); `GitRepo::worktrees()` lists the primary and linked worktrees (`crates/vcs/src/git/read.rs:443-485`).
- Hooks: `before_agent_start` is admitted once per submission with its `text`, then `agent_start` is notified (`crates/agent/src/loop.rs:1076-1107`). Skill, authored and custom turns pass the same seam with `source: "interactive"` (`crates/agent/src/loop.rs:1022-1058`, `:1084`). `HookGate::subscribed` reports Python extension subscriptions and `native_subscribed` native ones (`crates/contract/src/hooks.rs:2024-2031`). The only production native host is the plugin hook host (`crates/driver/src/plugin_hooks.rs:309-311`, attached at `crates/driver/src/headless/kernel.rs:3079-3098`); its `events()` includes `before_agent_start` when a plugin declares `UserPromptSubmit`, `Stop` or `SessionStart` (`crates/driver/src/plugin_hooks.rs:313-330`). `session_switched` reaches every host and must not block (`crates/contract/src/hooks.rs:778-784`); `session_shutdown` has a 1.5 s budget (`:569-571`).
- Directors are the wrong seam: Director inference runs inside an awaited `before_inference` (`crates/agent/src/loop.rs:1592-1602`), dropped on interrupt (`crates/contract/src/director.rs:671-675`); ADR 0015 forbids a Director for behaviour that observes one turn (`docs/adr/0015-directors.md:87-89`).
- Auxiliary inference: `ComposedInference::auxiliary_inference()` (`crates/driver/src/headless/kernel.rs:2122`, `:2233`) is bound for memory reflection, which calls `chat_on("@memory", …)` per request (`:2841-2845`; `crates/driver/src/headless/reflection.rs:45-69`). `ForcedCall` ladder state is carried across turns (`crates/ai/src/call.rs:1000-1011`); `tool_choice` names the tool (`:1023`).
- `/memory` has five Mnemopi operations (`crates/chat/src/overlays/services.rs:776-790`, `crates/chat/src/commands/misc.rs:419-430`) served synchronously (`crates/chat/src/overlays/services.rs:1451`); `/share` returns `Pending<Str>` (`:1476`). No `/decisions` command exists.
- Secrets: `SecretRule` kinds are `Plain | Regex`, regex linear-time (`crates/secrets/src/rule.rs:10-18`); `SecretRedactor::new` lowers rules to `Replace` without a replacement (`crates/secrets/src/redact.rs:24-37`, `rule.rs:129-136`), which emits a derived look-alike (`crates/secrets/src/obfuscator.rs:253-263`); `redact` takes `&mut self` (`redact.rs:35`). Built-ins cover GitHub, GitLab, OpenAI, Anthropic (`crates/secrets/src/builtins.rs:7-29`). No production composition holds a `SecretSessionSnapshot`; the only production build is `/share`'s, generation 0, no extension rules, over paths from app's `secrets_files` (`crates/app/src/chat_services/misc.rs:259-283`): `omp_core::dirs::user_config_root()/secrets.yml` and `<project>/.omp/secrets.yml` (`crates/core/src/dirs.rs:218-221`; `crates/ext/src/workspace_trust/inventory.rs:82`, `:143`).
- Other learning paths: Auto-Learn writes managed skills, listed and loaded on demand (`crates/contract/src/managed_skills.rs:1-9`); Mnemopi's `ExtractionLane` extracts recall facts (`crates/memory/src/extract.rs:30-35`).
- Extension prompt contributions have no consumer outside envd (`crates/envd/src/lib.rs:1476-1478`). The v1 importer refuses `sharpshooter` and `hindsight` (`crates/driver/src/legacy_settings.rs:446-449`).

### Rules that bind

- Additive only: `ai_memory_backend`, `/memory`, `MemoryOp`, `SlotId`, `credential_rules()`, `SecretRedactor` and the `before_agent_start` payload do not change.
- ADR 0015 (hook, not Director); ADR 0049 (vendors as extensions; new capabilities default to T2, `docs/adr/0049-tiered-integration-architecture.md:47`, `:53`); ADR 0012 (no `PROJECT` flag on abusable convars, `docs/adr/0012-convars.md:77`); ADR 0019 and the locked rule that native forced-call flags are used only where cache-free; ADR 0035 (typed errors); ADR 0036 (Python extensions).
- Deterministic first: identity, eligibility, the delta filter, redaction, caps, validation, commit and acceptance are code; extraction and the admission law are model-judged.

## Decision

**D1. A separate subsystem.** Decision memory runs beside Mnemopi, on or off. Upstream makes it exclusive with Mnemopi; omp2 keeps them separate so `ai_memory_backend` and `/memory` stay unchanged (additive rule) and because the two answer different questions (recall facts versus directive project rules). Whether to make them exclusive is O19. It is not a managed-skill kind (skills load on demand; decisions are always injected) and not an `ExtractionLane` consumer (recall facts, off by default). It MUST NOT touch `ai_memory_backend`, `omp-memory` or envd.

**D2. Project identity.** At composition the driver runs `omp_vcs::detect` on the canonical working directory.
- Git: take `primary_root()`. Accept it when the working directory lies inside it, or when `GitRepo::worktrees()` of that repository lists this checkout. Otherwise use the checkout root. This guards against a `.git` file that names another repository; Mnemopi does not apply the check (O20).
- Jujutsu: the workspace root.
- No repository: the canonical working directory.

The bank is `<data>/decisions/<hex>/`, `<hex>` the 64-digit `Hash32` hex of the identity root's bytes. A failure to resolve identity or open the bank logs a warning and disables decision memory for the session; it never fails composition. The bank is path-keyed: moving a repository leaves its bank behind, and a different project cloned at the same path inherits it; `status` shows the identity root so the user can see this.

**D3. Bank layout and commit.**
- `generations/<n>/{architecture,product,style}.md`, `n` from 1. omp never edits a generation after it commits; a user may, so every read is redacted (R4).
- `queue/<id>.json`, one delta per file (D5 schema).
- `state.json`: `v` (1), `latest` and `accepted` (generation number or null: none yet), `consumed` (delta ids not yet unlinked), `contributors` (for `latest` only: `[{id, evidence, session_id, ts_ms}]`), `last_ok_ms`, `failures` (u32), `last_error_ms`, `attempt_started_ms` (all ms since the epoch, or null).
- `lock`, held with `std::fs::File::try_lock` as the journal does (`crates/journal/src/lib.rs:500-511`); the OS releases it if the process dies. **Every writer of the bank holds it**: a consolidation pass, accept, auto-accept, failure recording, consumed-file cleanup and clear. A writer that cannot take it reports busy and writes nothing. Queue appends do not need it (one new file each).
- Commit: remove any `generations/` directory above `max(latest, accepted)` (a crashed partial write); write and fsync `generations/<n+1>`; write `state.json` to a temp file and rename it, then fsync the bank directory; unlink the consumed queue files and clear `consumed` (under the lock). A crash before the rename leaves the previous state and the queue intact; after it, nothing consumed is re-sent.
- Pruning at each commit: generations other than `latest` and `accepted` are deleted.

**D4. Redaction.** `omp-secrets` gains, additively:
- `memory_redaction_rules()`: `Replace` rules with the fixed replacement `[REDACTED]`, using upstream's thresholds (`upstream:packages/coding-agent/src/memory-backend/redact.ts:11-19`) for AWS, GitHub (`gh[opusr]_` and `github_pat_`, `{20,}`), npm, Slack and Google, plus the built-in GitLab, OpenAI and Anthropic shapes, and a JWT regex (three dot-separated `[A-Za-z0-9_-]{16,}` segments; the regex engine is linear-time, so upstream's procedural matcher is not needed);
- `redact_keyword_runs`, a linear scanner ported from `redact.ts:22-106`;
- `SecretRule::into_redaction(replacement)`: makes any rule `Replace` with that replacement, overriding an existing one;
- `MemoryRedactor`: keyword runs, then the memory rules, then the session secret rules lowered with `into_redaction("[REDACTED]")`.

The session secret rules come from one `SecretSessionSnapshot::build(0, user, project, root, trust, [])` at composition, as `/share` builds it (`crates/app/src/chat_services/misc.rs:276-283`). The driver resolves the same two paths; app's `secrets_files` moves into `omp_driver::secrets` and app calls it there. The rules are not rebuilt during the session. A `DecisionHandle` holds the redactor as `Arc<parking_lot::Mutex<MemoryRedactor>>`; the worker, the prompt producer and `/decisions` share it.

Boundaries:
- R1: the extraction envelope, before it leaves the process. Redact the full text first, then cut.
- R3: each file of a consolidation reply, before the line-cap check.
- R4: every read of generation files (consolidation input, injection, `/decisions show`). Redact, then cut.

Deltas are not redacted again: they are built from redacted text. Redaction does not cover personal data, paths or a secret described in prose, and does not protect the raw session journal or the main provider request. User docs MUST say so and MUST name the `@memory` route as an extra egress.

**D5. Extraction: a native hook host and a driver worker.**
- Seam. `compose_kernel` attaches a `DecisionHost` with `admission_gate.attach_native(host, &[HookEventId::HookEventBeforeAgentStart])`. `decide` never awaits the model; it returns `NativeReply::defer()` after at most a non-blocking hand-off.
- **No extraction while another host can deny or rewrite the prompt.** The host is not attached when the plugin hook host's `events()` contains `before_agent_start`. In `decide` it hands nothing off when `admission_gate.subscribed(HookEventId::HookEventBeforeAgentStart)` is true, meaning a Python extension subscribes the event. Those are the only production hosts that see the event (Context). Holding the prompt until `agent_start` instead is O21.
- Runner. A `DecisionWorker` task owns a clone of `auxiliary_inference()` and reads one flume mailbox of `WorkerMsg { Prompt, Sync(reply), Switched }`, bounded at 8. Cancellation arrives on a `tokio::watch`. While a prompt is in flight an `AtomicBool` is set, and `decide` drops new prompts (upstream parity: at most one in flight, none waiting). `Sync` and `Switched` use a blocking `send` from async context (`send_async`), so they are never dropped.
- Lifecycle. One host and one worker per composition. `SessionHome::create` and `SessionHome::open` re-evaluate eligibility for the switched-to session from `session_agent(dom)` (`crates/driver/src/headless/kernel.rs:3394`) and reset the previous prompt and the extraction counter. `session_switched` supplies the session id deltas record. Composition-end cancellation abandons in-flight work; no flush (O22).
- Eligibility. `ai_decision_memory` on, `tools_enabled`, not ephemeral, and the agent is `MAIN_AGENT` (`kernel_agent` at composition, `kernel.rs:3984-3990`; `session_agent(dom)` on switch). Skipped: text whose first non-blank character is `/`; text under 16 graphemes (`xutf`); every prompt after 40 extractions in one session.
- Envelope. The current prompt and the previous prompt this host handed off in the same session. Both are redacted (R1). The current prompt is then cut to its first 4,000 Unicode scalar values. The previous prompt is cut to 400, after whitespace collapse and replacing fenced code with `[code omitted]`. There is no assistant context.
- Request. Scribe templates ported from `sharpshooter-extract-system.md` and `sharpshooter-extract-input.md`, edited to remove the assistant-context block and every `contextual_resolution` instruction. A `record_deltas` schema with no `source` field. `tool_choice: Setting::Require(ToolChoice::Named("record_deltas"))` and `forced: None`: a one-shot auxiliary request has no prompt cache to protect, so the native flag is used on the first attempt and no ladder runs. 2,048 output tokens, low reasoning. The worker retries a transient transport error once. A reply without the call is a failure, not retried.
- Delta filter. Kept only if the kind is one of `architecture_decision | product_decision | style_decision | constraint | rejected_approach | correction`, the statement is non-empty, and the evidence is at least 8 characters and an exact substring of the full redacted current prompt (uncut, fences kept).
- Delta schema (`queue/<id>.json`, snake_case): `v` (1), `id` (ULID), `kind`, `statement`, `rejected_alternative` and `rationale` (string or null), `evidence`, `friction` (`corrective`, `regression`, `subtle`: bool), `session_id`, `ts_ms` (u64). This is omp2's format, not upstream's.
- Failures are logged at debug level and counted in `status`; they never fail the turn. Each call records a tracing span with token usage.
- Known limit: skill, authored and custom turns reach the seam as `source: "interactive"`, so their text (a project skill body, a collaborator's or an extension's message) can supply evidence. D7's acceptance bounds the effect (O16).

**D6. Consolidation: the same worker.**
- Triggers. `Sync` (from `/decisions sync`) runs a pass now, ignoring interval and backoff. An automatic pass runs at worker start and on `Switched` when the queue is non-empty and `now ≥ max(last_ok + 5 min, last_error + backoff)`, with `backoff = 5 min × 2^(failures-1)`, at most 6 h. Nothing runs on `session_shutdown`. A long single session does not consolidate automatically (O23).
- A pass records `attempt_started_ms` under the lock first. At the next open, an attempt newer than `last_ok_ms` with no completion counts as a failure, so abandoned passes also back off.
- Input. The base is the latest generation's files (R4). Queued deltas are grouped per session, oldest session first, up to 64 KiB; the rest waits. Only in a trusted workspace, the context files already in `prompt-facts` are added, cut to 8 KiB and labelled as already documented, to exclude. The templates are scribe ports of `sharpshooter-consolidate-system.md` and `sharpshooter-consolidate-input.md`, with slots for the three files, the docs digest and the session groups.
- Request. A `replace_memory_files` schema, required as in D5, medium reasoning, output tokens `min(model maximum, 8,192)`. Upstream allows 32,768 (O24).
- Validation. Exactly one entry per file (stricter than upstream); R3; at most 120 lines per file; an all-empty reply is rejected when any current file is non-empty. A failure records `failures` and `last_error_ms` only.

**D7. Acceptance before injection.** A pass sets `latest`; injection uses `accepted`.
- `/decisions accept` sets `accepted = latest`, under the lock.
- `/decisions show` shows the accepted files (or "no accepted decisions"), a unified diff per file from accepted to latest, and latest's `contributors`.
- With `latest` null, `accept` reports nothing to accept.
- `ai_decision_memory_auto_accept` (default false) accepts every pass.
- Consolidation builds on `latest`, so stacked passes accept together. A reject or revert path is O18.

**D8. Injection.**
- Producer. `install_prompt_facts` gains a `decisions: Option<&str>` parameter and writes a top-level `decisions` key only when it is `Some`. Its three production callers pass the text from `DecisionHandle::injection()` when the session is eligible (D5). That text is redacted (R4), framed and cut by `omp-decisions`; the token limit comes from the convar. `SessionHome` gains `decisions: Option<DecisionHandle>`; its struct-literal sites (Context) set it. Every other case passes `None`, leaving `prompt-facts` and the prompt byte for byte unchanged. No `memory` key is written.
- Capture. The text is read only when `install_prompt_facts` runs (composition, `/new`, `/resume`, `/fork`), so the Dynamic band never changes mid-session.
- Projection. `CanonicalPromptSource` pushes the `decisions` text, verbatim, first in the Dynamic band, before Mnemopi's `memory` and `standing`. There is no new `SlotId`.
- Framing. `<project-decisions>` with a header from a static prompt file: decisions the user accepted in earlier sessions of this project, not long-term memory; follow them unless the user overrides them now; system and tool policy win. Cut at `ai_decision_memory_tokens` × 4 bytes on a UTF-8 boundary, with a marker.

**D9. Controls.**
- `/decisions [show|accept|sync|clear|status]`, `show` by default. A strum `DecisionsOp` enum beside `MemoryOp`.
- `Services::decisions(op) -> ServiceResult<Pending<Str>>`, asynchronous as `/share` is, so `sync` never blocks the chat. Output goes in a `ReportPanel`.
- `ServiceState` gains `decisions: Option<DecisionHandle>`, taken from `ComposedInference::decisions()` (a new accessor beside `auxiliary_inference()`). Where the kernel runs in an attached project daemon that this process cannot reach, the handle is `None` and `/decisions` reports unavailable.
- `sync` replies `a pass is running` if one is in flight in this process, `busy` if another process holds the lock, otherwise the outcome.
- `clear` takes the lock and removes only this bank. It asks no confirmation, as `/memory clear` does not.
- `status` reports the identity root, the latest and accepted generations, queue depth, failures, the next automatic pass and extractions this session.
- `/memory` does not change.

**D10. Settings.** Declared with `omp_con::var!` in `crates/driver/src/decisions.rs`, `"ui.tab": "memory"`, `"ui.group": "Decision memory"`. All are `ARCHIVE` and none is `PROJECT`, so a repository cannot switch on directive injection or prompt egress.

| Convar | Type, default, range | `ui.label` |
|---|---|---|
| `ai_decision_memory` | bool, false | Decision memory (experimental) |
| `ai_decision_memory_tokens` | i64, 4,000, 256-16,000 | Decision injection token limit |
| `ai_decision_memory_auto_accept` | bool, false; `ui.when` `ai_decision_memory=true` | Accept consolidated decisions automatically |

The minimum prompt length (16), the extraction cap (40) and the interval (5 min) are constants in the first cut. There is no `cap-*` feature (O14) and no `legacy.path`. v1 decision files are not imported, and the docs say so.

**D11. Code home.** A new crate `crates/decisions` (`omp-decisions`) holds the types, layout, `state.json`, queue, lock, reply validation, injection text, scribe prompts and the two forced-call schemas. Those schemas are sent only inside auxiliary requests and never join the tool roster (ADR 0024). Its errors are one `thiserror` enum with variants `Busy`, `Io { path, #[source] }`, `Corrupt { path, #[source] }`, `InvalidReply` (with a typed reason enum), `Inference { #[source] }`. Dependencies: `omp-core`, `omp-secrets`, `serde`, `serde_json`, `thiserror`, `xutf`. The driver owns identity, the host, the worker, the handle and the convars; chat and app own the command. Crate or driver module is O3.

**D12. Hindsight is an extension only** (ADR 0049); nothing in core (O8).

## Rejected options

| Option | Why not |
|---|---|
| A third `ai_memory_backend` value | Changes an existing convar's values (additive rule); exclusivity itself is O19. |
| A Director for extraction | ADR 0015:87-89; inference inline in the turn, dropped on interrupt. |
| Consolidating on `session_shutdown` | 1.5 s budget. |
| Identity from Mnemopi's `BankScope` or a full `vcs::snapshot` | The first needs Mnemopi on; the second walks worktree status every start. |
| Nesting under `omp_env::project_state::directory(data, identity_root)` | Would work equally; a separate `<data>/decisions` root keeps banks out of the per-working-directory buckets session listings walk. |
| Files in the project tree | A repository could plant directive text. |
| Controls under `/memory` | Edits an existing command (O11). |
| `memory.decisions` inside Mnemopi's map | Couples two producers in one property. |
| Grammar inside `omp-decisions`; changing `credential_rules()` | `omp-secrets` owns credential grammar; changing built-ins changes export and capture output. |
| Upstream's assistant-context envelope and `contextual_resolution` | A short reply would promote assistant text that repository content can steer. |
| A pending prompt buffer | Not upstream behaviour. |
| Python extension for decision files | No prompt-facts producer or auxiliary inference in `omp.*`; extension prompt slots reach no prompt. |
| `AGENTS.md` only | Loses the automatic part. |

## Slices

The gate is the default-off convar `ai_decision_memory` (D10). One PR per slice. Tests are written first and not edited to pass. Every slice leaves `just lint`, `just test` and `just check-minimal-caps` green. With the gate off, existing prompt goldens, `/memory` tests and driver composition tests pass unchanged.

**S0. Gate and prompt producer.** D10 convars; the `decisions` parameter and its three callers (`None` until S3); `CanonicalPromptSource` pushes `decisions` verbatim.
- Tests: `crates/agent/tests/prompt_golden.rs` `decisions_render_once_first_in_the_dynamic_band`, `no_decisions_key_leaves_the_prompt_unchanged_byte_for_byte`; driver `prompt_facts_without_decisions_have_no_decisions_key`.
- Verification: `just test-pkg omp-agent`, `just test-pkg omp-driver`.

**S1. Memory redaction in `omp-secrets`; `secrets_files` moves to the driver.**
- Tests: `memory_rules_replace_every_listed_shape_with_the_marker`, `keyword_run_is_redacted_and_authentication_is_not`, `keyword_scanner_is_linear_on_a_long_run`, `into_redaction_overrides_an_existing_replacement`, `credential_rules_and_secret_redactor_output_unchanged`; app `share_reads_the_same_secret_files_after_the_move`.
- Verification: `just test-pkg omp-secrets`.

**S2. `omp-decisions` store.** D3, the D5 filter and schema, the D6 validation, the D8 injection text, the D11 errors. A commit-step fault seam for tests. README and NOTICE.
- Tests: `delta_round_trips_in_the_omp2_schema`, `crash_before_state_rename_leaves_previous_generation_and_queue`, `crash_after_state_rename_resends_no_consumed_delta`, `partial_generation_dir_is_removed_on_next_commit`, `every_bank_writer_refuses_when_the_lock_is_held`, `reply_missing_or_duplicating_a_file_is_rejected`, `file_over_120_lines_after_redaction_is_rejected`, `all_empty_reply_with_a_non_empty_current_file_is_rejected`, `evidence_shorter_than_8_or_not_a_substring_is_rejected`, `injection_redacts_then_cuts_at_a_utf8_boundary`, `consolidation_input_groups_by_session_and_caps_at_64_kib`, `commit_prunes_generations_other_than_latest_and_accepted`.
- Gate: none; no caller until S3.

**S3. Identity, handle, read path, `/decisions show|accept|status`.**
- Tests: driver `identity_is_shared_by_linked_worktrees`, `foreign_gitdir_falls_back_to_the_checkout_root`, `jj_and_no_repository_identities`, `identity_failure_disables_decisions_without_failing_composition`, `accepted_generation_reaches_prompt_facts_redacted`, `unaccepted_latest_is_not_injected`, `session_home_create_and_open_inject_decisions_only_for_main_sessions`, `subagent_composition_passes_no_decisions`; app `decisions_show_reports_accepted_diff_and_contributors`, `decisions_unavailable_without_a_handle`, `memory_view_output_is_unchanged`; e2e `p5_decisions_block_keeps_the_prefix_stable_across_turns`.
- Golden journal: one new family for `prompt-facts` with `decisions` (append-only corpus).

**S4. Extraction host and worker.**
- Tests with a fake auxiliary inference: `before_agent_start_returns_defer_without_awaiting_the_model`, `valid_delta_lands_in_the_queue`, `invented_or_short_evidence_is_dropped`, `secret_straddling_the_cut_reaches_the_model_as_the_marker`, `slash_and_short_prompts_are_skipped`, `prompt_during_extraction_is_dropped`, `extraction_cap_stops_after_40`, `no_handoff_while_an_extension_subscribes_before_agent_start`, `host_not_attached_when_plugins_subscribe_before_agent_start`, `switch_resets_previous_prompt_and_counter`, `sync_and_switch_messages_are_never_dropped`, `extraction_failure_never_fails_the_turn`, `turn_interrupt_does_not_cancel_extraction`; a golden of the edited extraction prompts.

**S5. Consolidation and `/decisions sync|clear`.**
- Tests: `sync_ignores_interval_and_backoff`, `automatic_pass_waits_for_interval_and_backoff`, `abandoned_attempt_counts_as_a_failure`, `valid_reply_commits_a_new_latest_generation`, `invalid_reply_changes_only_failure_state`, `reply_secret_is_redacted_before_the_cap_check`, `docs_digest_is_sent_only_in_a_trusted_workspace`, `sync_reports_running_and_busy`, `clear_refuses_during_a_pass`, `decisions_clear_removes_only_this_bank`, `memory_clear_leaves_the_decision_bank`; a golden of the consolidation prompts.

## Upstream origin and license

Drawn from `upstream:packages/coding-agent/src/sharpshooter/`, the prompts `upstream:packages/coding-agent/src/prompts/memories/sharpshooter-extract-system.md`, `sharpshooter-extract-input.md`, `sharpshooter-consolidate-system.md` and `sharpshooter-consolidate-input.md` (edited as D5 says), and `upstream:packages/coding-agent/src/memory-backend/redact.ts`. MIT (`upstream:LICENSE:1-5`; copyright Mario Zechner, Can Bölük, Stencil Labs, Inc.). The notice goes in the NOTICE files of `omp-decisions` (prompts) and `omp-secrets` (redaction logic).

## Consequences

- Projects accumulate a short set of user-accepted decisions, shared across worktrees, followed unless the user overrides.
- Latency: a decision reaches the prompt only after a later pass, an accept and a further composition or switch, typically two sessions after it was stated.
- Cost: each eligible prompt costs one `@memory` call. That is roughly 4 KB of static prompt plus up to 4,000 characters of prompt, at most 40 per session per process, so N concurrent sessions across worktrees can make 40×N. Each pass sends up to 64 KiB of deltas, 8 KiB of docs and the files. `@memory` may resolve to `@commit` or `@smol`. In one-shot runs an in-flight extraction is abandoned at exit, and its cost is lost.
- Prompts leave the machine to the `@memory` route, redacted first. With any extension or before-prompt plugin hook loaded, nothing is extracted.
- A directive block is a new trust stance; acceptance and framing keep it apart from Mnemopi's non-directive text.
- Decision text is journaled in `prompt-facts`, redacted, so exports and session files contain it.

## Open questions for the owner

- **O1. Directive wording?** Recommendation: directive, framed, subordinate to policy and the current user.
- **O2. Convar or enum value?** Recommendation: the convar.
- **O3. Crate or driver module?** A module avoids a single-consumer crate. Recommendation: the crate, so prompts, schemas and storage test without the driver.
- **O4. `@memory` or a dedicated setting (upstream defaults to `smol`)?** Recommendation: `@memory`.
- **O5. Triggers?** Recommendation: D6.
- **O6. Drop or hold prompts during an extraction?** Recommendation: drop.
- **O7. Token limit?** Recommendation: 4,000.
- **O8. Hindsight seams?** Recommendation: a separate Hindsight record.
- **O9. Write Mnemopi's snapshot into `memory`?** That turns on injection for every Mnemopi user. Recommendation: a separate decision.
- **O10. Own `SlotId`?** Recommendation: no.
- **O11. Controls under `/memory`?** Recommendation: `/decisions`.
- **O12. Inject into subagents?** Recommendation: not in the first cut.
- **O13. Promote memory rules into export and capture redaction?** Recommendation: separately.
- **O14. ADR 0049 tier?** Not a vendor integration. T2 fails (no `omp.*` producer). No T1 admission reason applies cleanly. Recommendation: core and uncapped, like `omp-memory` (`crates/app/Cargo.toml:97`).
- **O15. Acceptance default?** Recommendation: `auto_accept = false`.
- **O16. Skill, authored, custom and command-submitted turns supply evidence.** Recommendation: accept, bounded by acceptance; a source field would change the payload.
- **O17. Wire provider-bound obfuscation for auxiliary requests?** Recommendation: separately.
- **O18. A reject or revert path** (`/decisions reject`, consolidating on `accepted` instead of `latest`)? Recommendation: add `reject` (discard `latest`, re-queue nothing) in a follow-up.
- **O19. Make decision memory exclusive with Mnemopi, as upstream does?** Recommendation: keep them separate.
- **O20. Apply D2's linked-worktree check to Mnemopi's bank identity too?** Recommendation: yes, in a separate change.
- **O21. Extract while extensions subscribe `before_agent_start`, by holding the prompt until the matching `agent_start` (`crates/contract/src/hooks.rs:1093-1096`, `crates/agent/src/loop.rs:1076-1107`)?** That sees denials, not rewrites. Recommendation: consider after the first cut.
- **O22. Flush an in-flight extraction at exit (upstream waits 5 s)?** Recommendation: no flush in the first cut.
- **O23. A periodic pass in long sessions, or drop the interval and backoff?** Recommendation: keep D6 and add a timer only on evidence.
- **O24. Consolidation output cap: 8,192 or upstream's 32,768 with a context clamp?** Recommendation: upstream's 32,768 clamped to the free context, if the owner prefers parity.

## What the review changed

### Round 1 (EGM, 2026-11-13; resolved 2026-11-14)

Four findings, all confirmed, none rejected. Later rounds revised some resolutions.

- **S0 producer and slot.** Confirmed (`crates/driver/src/headless/kernel.rs:4043-4129`, `crates/agent/src/prompt/mod.rs:139-149`). Changed: named producer, band and capture.
- **Identity when Mnemopi is off.** Confirmed (`crates/memory/src/runtime.rs:265-274`, `crates/envd/src/server/session.rs:45-54`). Changed: own identity from the primary root.
- **`/memory` collisions.** Confirmed (`crates/chat/src/commands/misc.rs:419-430`). Changed: `/decisions`.
- **Redaction scope.** Confirmed (`crates/secrets/src/builtins.rs:7-29`). Changed: named boundaries.

### Round 2 (EGM, 2026-11-14)

1 blocker, 15 major, 18 minor, each checked in source. Headline changes: extraction moved from a Director to a native `before_agent_start` host plus a driver worker (B1); consolidation runs from that worker, never at shutdown (M1, M2); redaction uses a fixed marker and lives in `omp-secrets` (M3, M4); generations commit atomically (M9); injection waits for acceptance (M10); producer call sites and predicate named (M12); envd wiring dropped (M13); `ai_` convar names (m8). R2 dropped and R1 kept (M5, partly confirmed); `identity.json` dropped and layout kept (m12, partly); command-submitted prompts recorded as O16 (m15, partly); the STATUS.md row left to the orchestrator (m5).

### Round 3 (EGM, 2026-11-14; final round)

2 blockers, 21 major, 22 minor. Final-round rule: a blocker closes only by a factual correction that changes no reviewed decision, or by removing scope. A fix that would change a reviewed decision became an owner question.

| Id | Confirmed in source | Change, or why not |
|---|---|---|
| B1 No source for session secret rules | Yes: `crates/app/src/chat_services/misc.rs:259-283`; `crates/driver/src/secrets/session.rs:33-55`; no snapshot in `kernel.rs` | Closed by (a): one `SecretSessionSnapshot::build(0, …, [])` at composition, as `/share` does; paths from `user_config_root()` and `<project>/.omp/secrets.yml` (`crates/core/src/dirs.rs:218-221`, `crates/ext/src/workspace_trust/inventory.rs:82`, `:143`); `secrets_files` moves to the driver. Also (b): extension rules and rebuild-on-generation removed from Terms and D4. |
| B2 Prompt seen before extensions can deny or rewrite it | Yes: `crates/contract/src/hooks.rs:758-765` | Closed by (b): no hand-off while `HookGate::subscribed(before_agent_start)` (extensions), and no host when the plugin host's `events()` contains it (`crates/driver/src/plugin_hooks.rs:313-330`); these are the only production hosts. The `agent_start` hold is O21. |
| M1 Lifecycle across switches | Yes: `kernel.rs:3210-3218`, `:3394` | D5 Lifecycle: per-composition host, reset and re-evaluation on `SessionHome::create/open`, session id from `session_switched`. |
| M2 No reject path | Yes | Clarified `show`/`accept` with nulls, the diff format and R4 versus "never edited by omp". Reject and the consolidation base are O18. |
| M3 Contributors lack evidence | Yes | D3 stores `{id, evidence, session_id, ts_ms}` in `contributors`. |
| M4 App plumbing | Yes: `crates/app/src/session_runner.rs:36-66`, `:152`; `chat_control.rs:2521` | D8 and D9: `DecisionHandle`, `ComposedInference::decisions()`, the `SessionHome` field and its sites; the daemon case reports unavailable. |
| M5 Synchronous `sync` | Yes: `crates/chat/src/overlays/services.rs:1451`, `:1476` | D9: `Pending<Str>`; "running" and "busy" replies. |
| M6 `bounded(1)` is a buffer | Yes | D5: in-flight flag, drop while set. |
| M7 Mailbox kinds | Yes | D5: `WorkerMsg` mailbox, watch for cancellation, sync and switch never dropped. |
| M8 Cut before redaction | Yes: `crates/secrets/src/builtins.rs:7-14` | D4 and D5: redact the full text, then cut. |
| M9 Evidence target | Yes: `upstream:…/extract.ts:103-110`, `:137`, `:288` | D5: full redacted current prompt; fences stripped only from the previous prompt; Context corrected. |
| M10 8,192 against 32,768 | Yes: `upstream:…/consolidate.ts:35-45` | Kept 8,192; O24. |
| M11 Lock scope | Yes | D3: every bank writer holds the lock. |
| M12 Interval without a scheduler | Yes | Interval and backoff made constants, plus a long-session consequence; dropping them is O23. |
| M13 Identity algorithm and divergence | Yes: `crates/vcs/src/git/read.rs:443-485`; IR-M11's "no worktree API" rejected by the same lines | D2 names `worktrees()` and Jujutsu; the Mnemopi divergence is O20. |
| M14 Upstream exclusivity unstated | Yes: `upstream:docs/memory.md:5-11` | Context and D1 state it and why omp2 splits; exclusivity is O19. |
| M15 Skill, authored and custom turns | Yes: `crates/agent/src/loop.rs:1022-1058` | D5 known limit; O16 widened. |
| M16 Schema missing | Yes: `upstream:…/types.ts:10-57` | D5 and D3 list the fields and types; test renamed to the omp2 schema. |
| M17 Prompts still use assistant context | Yes: `upstream:…/sharpshooter-extract-input.md:6-10` | D5: edits named, scribe templates, `source` removed from the schema. |
| M18 Redactor sharing | Yes: `crates/secrets/src/redact.rs:35` | D4: `Arc<Mutex<MemoryRedactor>>` in the handle. |
| M19 Forced call has no concrete form | Yes: `crates/ai/src/call.rs:1000-1011` | D5: `Require(Named)` with `forced: None`, cache-free, no ladder; worker-owned retry. |
| M20 Abandoned work | Yes | D6: `attempt_started_ms` makes abandoned passes back off; extraction cost in Consequences; flush is O22. |
| M21 Bands undefined | Yes: `crates/agent/src/prompt/mod.rs:99-117` | Terms define them. |
| m1 `project_state` rejection reason | Yes: `crates/env/src/project_state.rs:83-89` | Rejection row corrected. |
| m2 Crate or module | Yes | O3. |
| m3 Six convars | Yes | Three convars; three constants. |
| m4 Hand-copy does not activate | Yes | Claim removed; docs say no import. |
| m5 Unbounded growth | Yes | D3 pruning. |
| m6 Crash gaps | Yes | D3 removes partial dirs and fsyncs the directory; S2 adds a fault seam. |
| m7 Detail in decisions | Partly | Kept where tests depend on it (lock, schema, mailbox kinds). |
| m8 R2 gap unexplained | Yes | D4 says why there is no R2. |
| m9 "No new tool" | Yes | D11: schemas never join the roster. |
| m10 "Admission" overloaded | Yes | Terms; "delta filter". |
| m11 Convar types and ranges | Yes: `crates/envd/src/host_settings.rs:74-128` | D10 table. |
| m12 Undefined terms | Yes | Terms extended. |
| m13 Latency understated | Yes | Consequences. |
| m14 References unlinked; stale D7 pointer | Yes: `docs/research/memory-backends.md:37` | References linked; note fixed. |
| m15 No cost estimate | Yes | Consequences. |
| m16 Path-keyed bank | Yes | D2 states it; `status` shows the root. |
| m17 D1-D11 against D1-D12 | Yes | Fixed. |
| m18 Who frames and cuts | Yes | D8: `omp-decisions` frames and cuts, the agent pushes verbatim. |
| m19 Patterns and thresholds | Yes: `upstream:…/redact.ts:11-19` | D4 lists shapes, upstream thresholds, JWT regex and `into_redaction` override. |
| m20 No error taxonomy | Yes | D11 variants. |
| m21 `status` cannot name the model | Yes: `kernel.rs:2057-2091` | Removed from `status` (scope). |
| m22 Grouping and template | Yes: `upstream:…/sharpshooter-consolidate-input.md:1-25` | D6: per-session groups and scribe slots. |

No blocker remains open. Machine-reviewed (EGM, 3 rounds), not owner-approved.

## Acceptance tests

1. (S0) With `ai_decision_memory` off, prompt goldens and `prompt-facts` are unchanged.
2. (S0) A `decisions` fact renders once, first in the Dynamic band.
3. (S1) Every listed shape becomes `[REDACTED]`; `credential_rules()`, `SecretRedactor` and `/share` output are unchanged.
4. (S2) A crash at any commit step leaves a consistent bank and re-sends no consumed delta; every bank writer refuses under a held lock.
5. (S3) Linked worktrees share a bank, a foreign `gitdir` does not, only the accepted generation reaches main sessions' prompts, and P5 holds.
6. (S4) `before_agent_start` never waits on the model; nothing is handed off while an extension or before-prompt plugin hook is loaded; secrets reach the model only as the marker; a failure or interrupt does not affect the turn.
7. (S5) Sync ignores interval and backoff; an invalid or abandoned pass changes only failure state; `/decisions clear` and `/memory clear` leave each other's state alone.

## Status in omp

**Status: Not started.** Reusable: `omp_vcs::detect` and `worktrees()`, the `before_agent_start` native seam, auxiliary inference and `@memory`, the `omp-secrets` rule engine and `SecretSessionSnapshot::build`, `prompt-facts` and the Dynamic band. Not yet implemented: D1-D12. Mnemopi injection stays inactive.

## References

[docs/research/memory-backends.md](../research/memory-backends.md); [ADR 0012](0012-convars.md); [ADR 0015](0015-directors.md); [ADR 0019](0019-forced-tool-call-escalation.md); [ADR 0024](0024-small-permanent-roster.md); [ADR 0035](0035-rust-for-the-engine.md); [ADR 0036](0036-python-for-extensions.md); [ADR 0049](0049-tiered-integration-architecture.md).
