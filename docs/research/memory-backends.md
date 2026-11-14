# Gap 14: project decision files (Sharpshooter style) and Hindsight

Status: research only. Nothing here is implemented or authorized.
Date: 2026-11-13
Baseline: omp2 f4186b783b; upstream c308970263 (pinned checkout).

Evidence keys:

- **OBSERVED** means read in code or docs at the baseline. Citations use `path:line`. Upstream paths carry the `upstream:` prefix.
- **[INFERENCE]** means the author's reasoning. Every size estimate is an inference.
- **UNVERIFIED** means no run or source confirmed it.

No build, test or run was made for this document.

## Question

Upstream has two memory backends omp2 lacks: Sharpshooter, which keeps three short project decision files earned by user friction, and Hindsight, a client for a remote memory server. What do they do, what does `omp-memory` offer, and where should each live? The assignment fixes the answer for Hindsight: an extension only.

Out of scope: the upstream `local` rollout-summary backend, and Mnemopi itself (omp2 already has it).

## 1. Upstream

### Backend selection

Upstream picks one backend from `memory.backend`: `hindsight`, `mnemopi`, `sharpshooter`, `local`, or off (`upstream:packages/coding-agent/src/memory-backend/resolve.ts:8-29`). A backend implements one interface with start, clear, enqueue, status, search, save, stats, diagnose, queue preview and settings hooks (`upstream:packages/coding-agent/src/memory-backend/types.ts:108-196`). One redactor, shared by every backend, strips credential-shaped tokens from memory writes, because recalled memories re-enter every later prompt (`upstream:packages/coding-agent/src/memory-backend/redact.ts:1-7`).

### Sharpshooter

- **Idea.** Memory is earned by friction, not by decision existence. Per-prompt extraction emits deltas into a per-session queue. A shared consolidation pass applies queued deltas, per project, into three markdown files (`upstream:packages/coding-agent/src/sharpshooter/types.ts:1-8`). The user docs say the same and add that it needs no server (`upstream:docs/memory.md:162`).
- **Files and layout.** `architecture.md`, `product.md` and `style.md`, in injection order, each capped at 120 lines (`upstream:packages/coding-agent/src/sharpshooter/types.ts:59-65`). They live home-scoped under `<agentDir>/memories/sharpshooter/<bank>/`, where the bank id is derived from the working directory, never inside the project tree. Beside them: `queue/<sessionId>/<ts36>-<nonce>.json` (one file per delta), `state.json` and a `consolidate.lock` (`upstream:packages/coding-agent/src/sharpshooter/paths.ts:1-11`).
- **Delta.** A delta has a kind (architecture decision, product decision, style decision, constraint, rejected approach, correction), a timeless statement, an optional rejected alternative and rationale, a source (explicit user, or resolved from a short reply against the assistant's question), an `evidence` string, three friction flags (corrective, regression, subtle), a session id and a timestamp (`upstream:packages/coding-agent/src/sharpshooter/types.ts:10-57`).
- **Extraction.** Each user prompt in the main session, never a subagent, goes to a model that must call `record_deltas` with a schema (`upstream:packages/coding-agent/src/sharpshooter/extract.ts:46-50`). Prompts shorter than `minPromptLength` (default 16, floor 2) and slash commands are skipped; one extraction runs at a time per session and a prompt arriving meanwhile is not extracted (`upstream:packages/coding-agent/src/sharpshooter/settings.ts:20-24`, `upstream:packages/coding-agent/src/sharpshooter/extract.ts:54-56`, `upstream:docs/memory.md:172`). The host rejects any delta whose `evidence` is not an exact substring of the triggering prompt, so a model cannot invent a decision the user never wrote (`upstream:packages/coding-agent/src/sharpshooter/extract.ts:288-289`).
- **Queue.** One JSON file per delta, so producers need no lock. The consolidator lists, applies and unlinks exactly the files it read. A crash between apply and unlink only redelivers, and consolidation is idempotent because the newest delta wins over a full-file rewrite (`upstream:packages/coding-agent/src/sharpshooter/queue.ts:1-10`).
- **Consolidation.** A scheduler checks every minute and, once `intervalMinutes` (default 5) have passed, applies queued deltas to the three files in one model pass (`upstream:docs/memory.md:174`, `upstream:packages/coding-agent/src/sharpshooter/settings.ts:26-30`). The model must call `replace_memory_files` once with the complete content of all three files. A cross-process lock guards the pass (`upstream:packages/coding-agent/src/sharpshooter/consolidate.ts:117-123`). Failures back off exponentially (`upstream:packages/coding-agent/src/sharpshooter/consolidate.ts:144-145`). A reply over 120 lines in any file is rejected (`upstream:packages/coding-agent/src/sharpshooter/consolidate.ts:335-336`).
- **Admission law.** The consolidator prompt admits a decision only if its lineage shows a regression, subtlety (non-obvious from the code alone) or repetition (two or more corrective touches, or a reversal whose rejected alternative is still tempting). A one-shot decision never got wrong again is not memory. Every bullet must change a fresh agent's behaviour, each decision lives in one file, file paths and line numbers and task state are excluded, and the newest delta wins (`upstream:packages/coding-agent/src/prompts/memories/sharpshooter-consolidate-system.md:5-13`, `upstream:packages/coding-agent/src/prompts/memories/sharpshooter-consolidate-system.md:15-43`).
- **Injection.** The populated files are joined under a header saying they are friction-earned decisions to follow unless the user overrides, cut to `injectionTokenLimit` (default 15,000 tokens) (`upstream:packages/coding-agent/src/sharpshooter/backend.ts:119-128`, `upstream:packages/coding-agent/src/sharpshooter/settings.ts:32-34`).
- **Controls.** `/memory queue` lists pending deltas, `/memory enqueue` consolidates now, `/memory clear` deletes the project's files and queue, and `status` reports file sizes, queue depth and the last consolidation (`upstream:docs/memory.md:174`, `upstream:packages/coding-agent/src/sharpshooter/backend.ts:155-169`). In the pinned source the sync control is named `/memory enqueue` (`upstream:packages/coding-agent/src/memory-backend/types.ts:135`); omp2 can pick its own name. omp2's `/memory clear` and `/memory enqueue` already act on Mnemopi, so the plan uses a new `/decisions` command (`/decisions sync`, ADR 0068 D9).
- **Size.** About 1,100 lines of TypeScript (backend 251, consolidate 382, extract 337, queue 123, paths 68, scheduler 70, types 86, settings 35) plus a 43-line prompt, counted with `wc -l`.

### Hindsight

- **What it is.** A backend for an external Hindsight server, default endpoint `http://localhost:8888`, with an optional token (`upstream:docs/memory.md:134-142`; `upstream:packages/coding-agent/src/hindsight/settings.ts:17-20`).
- **Client.** A hand-rolled fetch client replaces the vendor SDK so omp depends only on the endpoints it uses: retain, retain batch, recall, reflect, bank and document management, bulk listing (`upstream:packages/coding-agent/src/hindsight/client.ts:1-9`).
- **Lifecycle.** It wires recall on the first turn and retain every Nth `agent_end` onto the session event stream (`upstream:packages/coding-agent/src/hindsight/backend.ts:1-8`). Defaults: auto recall on, auto retain on, retain every 3 turns with 2 turns of overlap, recall budget 1,024 tokens, request timeout 30 s (`upstream:packages/coding-agent/src/hindsight/settings.ts`). It also keeps "mental models" and an on-disk outbox so a failed retain is redelivered by the next session (`upstream:packages/coding-agent/CHANGELOG.md:474`).
- **Size.** About 3,700 lines of TypeScript across 11 files (client 723, state 722, mental-models 450, backend 451, outbox 389, settings 290, content 286, bank 168, config 139, transcript 88).

## 2. omp2 inventory

### The memory crate

- `omp-memory` owns "OMP's default-off Mnemopi backend": project bank identity, durable SQLite rows, derived recall indexes, four-voice recall and retention cursors (`crates/memory/README.md:1-5`). It never reads application settings or discovers Git roots; the Environment supplies the canonical repository identity (`crates/memory/src/lib.rs:1-6`).
- The backend selector is a closed enum, `Off` and `Mnemopi` (`crates/memory/src/config.rs:25-31`). The runtime matches on a private `RuntimeBackend` of the same two cases (`crates/memory/src/runtime.rs:248-251`). The user-facing convar is `ai_memory_backend` with options `off` and `mnemopi`, legacy path `memory.backend` (`crates/envd/src/host_settings.rs:74-87`).
- The runtime reports capabilities: writable, searchable, resolvable (`memory://`), editable, lifecycle and embeddings (`crates/memory/src/runtime.rs:33-46`). The `recall`, `reflect` and `retain` tools are typed over that runtime (`crates/tools/src/memory.rs:1-20`).
- Prompt injection has three slots, `memory`, `standing` and `recall`, projected from the DOM (`crates/agent/src/prompt/mod.rs:138-147`). The runtime builds an immutable snapshot of the three (`crates/memory/src/runtime.rs:157-166`), bounded by `injection_token_limit` (`crates/memory/src/runtime.rs:556-570`). The standing slot says long-term memory is non-directive background that may be stale and must never override the conversation or system policy (`crates/memory/src/runtime.rs:566-569`). Upstream's Sharpshooter header says the opposite: follow these decisions. That difference is a design question below.
- **Nothing writes the `memory` property (OBSERVED, 2026-11-14).** The prompt reads `memory` from the `prompt-facts` JSON on `<meta>` (`crates/agent/src/prompt/projection.rs:15-31`, `crates/agent/src/prompt/mod.rs:139-149`). The only production writer of `prompt-facts`, `install_prompt_facts`, inserts no `memory` key (`crates/driver/src/headless/kernel.rs:4043-4129`); only the prompt golden test sets one (`crates/agent/tests/prompt_golden.rs:228-232`). `prompt_snapshot` has two callers outside the memory crate, the envd wrapper and `/memory view` (`crates/envd/src/memory.rs:111`, `crates/app/src/chat_services/misc.rs:111`). Mnemopi injection is inactive today and any new memory source needs its own producer.
- **Project identity needs Mnemopi on.** With `ai_memory_backend = off` the runtime resolves no bank scope (`crates/memory/src/runtime.rs:265-274`) and envd takes no repository snapshot (`crates/envd/src/server/session.rs:45-54`). The snapshot's `primary_root` is shared by linked worktrees (`crates/envd/src/vcs/mod.rs:24-37`); the `<data>/projects/<sha256>` bucket is keyed by the working directory instead (`crates/env/src/project_state.rs:83-89`).
- **`/memory` has five operations**: `view`, `stats`, `diagnose`, `clear`, `enqueue` (`crates/chat/src/overlays/services.rs:776-790`, `crates/chat/src/commands/misc.rs:419-430`); `clear` and `enqueue` act on Mnemopi (`crates/app/src/chat_services/misc.rs:140-147`).
- Roles: the built-in role ids include `memory`, `smol` and `judge` (`crates/catalog/src/selection.rs:175-178`).
- Secrets: `omp-secrets` has a rule-driven redactor, `redact(&mut self, text)` (`crates/secrets/src/redact.rs:24-37`). Its built-in rules cover GitHub, GitLab, OpenAI and Anthropic token shapes only (`crates/secrets/src/builtins.rs:7-29`); upstream's AWS, npm, Slack, Google, JWT and keyword-run patterns (`upstream:packages/coding-agent/src/memory-backend/redact.ts:11-143`) are not covered. Upstream Sharpshooter itself redacts only consolidated file writes (`upstream:packages/coding-agent/src/sharpshooter/consolidate.ts:330-338`); its extraction envelope and queue are unredacted (`upstream:packages/coding-agent/src/sharpshooter/extract.ts:238-246`, `upstream:packages/coding-agent/src/sharpshooter/extract.ts:270-273`).
- Isolated model calls from a Director: `ErasedInference::execute_on(selector, request)` runs a request on any catalog key or `@role` and leaves the live route untouched (`crates/contract/src/director.rs:612-619`).
- Not found (searched: `sharpshooter`, `decision`, `hindsight` across `crates/memory`, `crates/tools`, `crates/agent`, `crates/app`): no decision-file memory in core.
- Importer: a v1 `memory.backend` of `hindsight` or `sharpshooter` is refused with a typed error, "v2 has no such memory backend", and the import report warns (`crates/driver/src/legacy_settings.rs:446-449`, `crates/driver/src/legacy_settings.rs:299-302`, `crates/driver/src/v1_import/report.rs:126-128`). Nothing here has to change.

### Extension seams for Hindsight

Extensions are Python (ADR 0036). The design docs list these seams (`docs/py`):

- Tools: `@omp.tool` registers a tool (`docs/py/00-overview.md:157`, `docs/py/01-devices.md:4`). A `recall`, `reflect` and `retain` tool set can be registered, subject to name clashes with core's tools (not checked: UNVERIFIED).
- Prompt text: `@omp.prompt_slot("memory", priority=100, stability=omp.Stability.SESSION)` contributes a named slot with a stability class, and Rust assembles a prefix-stable prompt (`docs/py/00-overview.md:1157-1159`).
- Lifecycle: `before_agent_start` carries the submission text (`docs/py/05-hooks.md:1264-1272`); `turn_end` carries turn index, usage and item references (`docs/py/05-hooks.md:1297-1306`); `agent_end` carries a run summary (`docs/py/05-hooks.md:1325-1329`). Whether an extension can read an item's text to retain it is not shown there: UNVERIFIED.
- Network: egress is a policy profile, with `OPEN` meaning no filtering (`docs/py/06-policy.md:1091`); the sandboxed tier's network limits are described in the overview (`docs/py/00-overview.md:340`). An extension talking to a Hindsight server needs an egress grant.

### Gap table

| Capability | Upstream | omp2 | Gap |
|---|---|---|---|
| Project decision files, 3 files, 120-line cap | Sharpshooter | none | port, as a separate subsystem |
| Friction-gated extraction with evidence check | `extract.ts` | none | new Director |
| File-per-delta queue, lock, consolidation | `queue.ts`, `consolidate.ts` | none | port logic; storage in a new crate |
| Directive injection of decision files | `backend.ts` | standing slot is non-directive | new slot or text |
| `/memory queue`, sync, clear, status | yes | `/memory` `view`, `stats`, `diagnose`, `clear`, `enqueue`, all Mnemopi (`crates/app/src/chat_services/misc.rs:105-149`) | new `/decisions` command; `/memory` unchanged |
| Secret redaction | shared `redact.ts`, on file writes only | `omp-secrets` redactor, narrower built-ins | reuse plus memory rules; redact envelope, queue, files, injection |
| Remote memory server client | Hindsight | none | extension only |
| More than two core backends | `resolve.ts` | closed two-case enum | do not extend; add a separate subsystem |

## 3. Class

**Class c (port)** for the project decision files. The logic is TypeScript and small; omp2 needs a different home for it because its backend enum is closed.

**Hindsight: extension only.** No core slice. It is a vendor integration, so ADR 0049 puts it in an extension (`docs/adr/0049-tiered-integration-architecture.md:17`). Whether the extension seams above are enough is an open question, not a slice.

Verdict: implement the decision files in four slices behind a default-off convar; leave Hindsight to an extension and settle the seam questions first.

## 4. Options

### Decision files

1. **Build on existing omp2 code: add `Sharpshooter` to `MemoryBackend`.** Cost: low in code. Fit: poor. It changes the accepted values of the existing `ai_memory_backend` convar, which the additive-only rule forbids without a ruling, and it makes decision files exclusive with Mnemopi. Upstream's backends are exclusive; the two do different jobs, so exclusivity is a limit, not a feature. It also pulls a rewrite of every `match` on `RuntimeBackend`.
2. **A separate subsystem with its own convar**, in a new small crate for storage and consolidation logic, a driver-owned worker fed by a `before_agent_start` hook host for extraction (a Director is the wrong seam, ADR 0015), and a prompt slot for injection. Cost: about 2 weeks. Fit: good. It is additive, runs beside Mnemopi, and uses seams omp2 already has.
3. **A Python extension.** Cost: unknown. Fit: unclear. Extraction and consolidation need isolated model calls and atomic writes beside the journal. Whether an extension can make those calls is UNVERIFIED. Directive text in the system prompt from an extension is also a larger trust question than a first-party slot.
4. **Skip it and tell the user to keep decisions in `AGENTS.md`.** Cost: zero. Fit: honest for users who write them by hand, but it loses the automatic, friction-gated part, which is the point.

Choice: option 2. Where to place the code (new crate or inside `omp-memory`) is open; `omp-memory` is Mnemopi-specific and does not read settings, so a new crate keeps it that way. [INFERENCE]

### Hindsight

1. **Port into core as a `MemoryBackend` variant.** Rejected by ADR 0049.
2. **Extension.** Chosen. A Python extension with a small HTTP client, three tools and a prompt slot.
3. **Do nothing.** Acceptable; Hindsight users can keep using upstream.

## 5. Plan

Revised 2026-11-14 after EGM rounds 1-3 (round 3 also: no extraction while an extension or a before-prompt plugin hook is loaded; session secret rules from one snapshot built at composition, as `/share` does): ADR 0068 is authoritative for the slice plan (S0 gate and prompt producer, S1 redaction in `omp-secrets`, S2 `omp-decisions` store, S3 identity and read path, S4 extraction, S5 consolidation). Where this section differs, the ADR wins: the gate is the default-off convar `ai_decision_memory` (no `cap-*` feature, no `PROJECT` flag); the bank is `<data>/decisions/<hex>/`, keyed by the primary Git root from `omp_vcs::detect`, computed by the driver without Mnemopi or envd; extraction is a native `before_agent_start` hook host feeding a driver worker, not a Director; consolidation runs on `/decisions sync`, worker start and session switch, never at shutdown; a consolidated generation is injected only after `/decisions accept`; the controls are a new `/decisions` command and `/memory` does not change; redaction (fixed `[REDACTED]` marker) applies to the extraction envelope, consolidation replies and every read of the files. No existing convar, tool, scheme or command changes.

### Slice 1: storage and rules, no model

- A bank directory in the data directory, keyed by the primary Git root or workspace root (see the revision note above), never inside the working tree. Three files, a 120-line cap check, file-per-delta queue with atomic writes, `state.json`, and an advisory lock. Types for the delta and friction flags exactly as in `upstream:packages/coding-agent/src/sharpshooter/types.ts:10-57`.
- Acceptance: a delta round-trips; a crash between apply and unlink redelivers, and applying twice gives the same files; two processes cannot consolidate at once; a file over 120 lines is rejected; a bank id from a hostile directory name cannot escape the bank root.
- Tests: unit tests with a temporary directory, and a concurrent-writers test.

### Slice 2: read path

- A prompt slot that injects the populated files, cut to a token limit, with its own header text (see open question 1), and `/decisions show` to view them.
- Acceptance: with files present the prompt golden test shows the slot once, in the same place every turn; with none the prompt is unchanged byte for byte; an oversize file is truncated at the limit with a marker.
- Tests: extend the prompt golden tests (`crates/agent/tests/prompt_golden.rs:229`).

### Slice 3: extraction (superseded in shape by ADR 0068 D5: hook host plus driver worker)

- A background worker, main agent only, that sends each user prompt to the `@memory` role through the isolated inference path, with a forced `record_deltas` schema. Skip slash commands and prompts under a minimum length. Redact credential-shaped text with the `omp-secrets` redactor before sending. Reject any delta whose evidence is not an exact substring of the prompt. One extraction at a time.
- Acceptance: with a fake inference service, a valid delta lands in the queue; a delta with invented evidence is dropped; a prompt containing a token-shaped secret reaches the model redacted; a subagent session queues nothing; extraction failure never fails the turn.
- Gate: same convar, plus the role resolving. Tests: fake `ErasedInference`.

### Slice 4: consolidation and controls

- One consolidation pass through the `@memory` role with a forced `replace_memory_files` call and the admission-law prompt, run on `/decisions sync` and at session close (no background timer in the first cut: deterministic triggers first). Exponential backoff after failures, a 120-line cap check on the reply, and `/decisions queue`, `/decisions sync`, `/decisions clear` and `/decisions status`.
- Acceptance: a fake consolidator's reply is applied atomically and the consumed queue files are removed; a reply over the cap, or one that is not a single complete file set, leaves files and queue untouched; repeated failure backs off; `clear` removes only this project's bank.
- Tests: fake inference plus a golden test of the consolidation prompt.

### Hindsight extension (no core slice)

A separate effort outside this repository's core: E1, a spike extension that registers `recall`, `reflect` and `retain` tools over HTTP; E2, a prompt slot for first-turn recall; E3, auto-retain on `turn_end` if the item text is readable. Each needs an egress grant and a secret for the token. Core changes only if the spike finds a missing seam.

## 6. Open questions

1. **Directive versus non-directive.** omp2's standing text says memory never overrides the conversation or policy (`crates/memory/src/runtime.rs:566-569`). Sharpshooter's value is that its decisions are followed unless the user overrides them. They are the user's own earlier statements, so a directive header is defensible, but it is a different trust stance from Mnemopi. The owner must choose the wording; the plan assumes a separate slot with its own header.
2. **Convar versus enum value.** The plan uses a separate `ai_decision_memory` convar so `ai_memory_backend` keeps its meaning. If the owner prefers a third `ai_memory_backend` value, that changes an existing convar's accepted values and needs a ruling.
3. **Where the code lives**: a new crate, or inside `omp-memory`. Check the crate rules in `AGENTS.md`.
4. **Role.** The plan uses `@memory`. Upstream uses a dedicated setting that falls back to `smol`. Does the owner want a separate role or setting?
5. **Consolidation trigger.** Upstream runs a 5-minute scheduler. The plan runs on `/decisions sync` and at session close. A timer can be added later.
6. **Skipped prompts.** Upstream drops a prompt that arrives while an extraction runs, and short replies like "opt 2" are too short at the default length (`upstream:docs/memory.md:172`). Decide whether omp2 queues instead of dropping.
7. **Token limit.** Upstream injects up to 15,000 tokens. That is large for a standing slot; omp2 may want a smaller default.
8. **Hindsight seams.** Can an extension read item text, register a tool that clashes with a core name, and hold a secret and an egress grant? Each answer decides whether the extension is feasible. All UNVERIFIED.
9. **Privacy.** Prompts go to a model for extraction. Redaction is a floor, not a guarantee. Say so in the docs.
10. No locked ADR conflicts for the decision files. ADR 0049 is why Hindsight stays out of core. ADR 0036 requires the extension to be Python.

## 7. Upstream origin and license

A port of the decision files would draw from `upstream:packages/coding-agent/src/sharpshooter/` (types, paths, queue, extract, consolidate, backend, settings), the consolidator prompt `upstream:packages/coding-agent/src/prompts/memories/sharpshooter-consolidate-system.md` and the redaction patterns in `upstream:packages/coding-agent/src/memory-backend/redact.ts`. All TypeScript or Markdown under upstream's MIT licence (`upstream:LICENSE:1-5`; copyright Mario Zechner, Can Bölük, Stencil Labs, Inc.). Keep the notice for the copied prompt text.

Hindsight: nothing is proposed for core. The upstream client (`upstream:packages/coding-agent/src/hindsight/client.ts`) is MIT and could seed an extension. The Hindsight server itself is a separate product at `https://hindsight.vectorize.io/`; its licence was not checked (UNVERIFIED) and does not matter for a client that only calls its HTTP API.

