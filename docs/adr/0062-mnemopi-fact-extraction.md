# 0062. Mnemopi retains main-session turns and extracts facts without a model: journal-keyed retention, English and Spanish rules, expiring facts

Status: Proposed 2026-11-14; machine-reviewed (EGM, 3 rounds), not owner-approved
Date: 2026-11-13
Area: state

Research: [docs/research/mnemopi-fact-extraction.md](../research/mnemopi-fact-extraction.md) (gap 2 of the upstream gap closure; the gap-closure brief is `docs/research/upstream-gap-closure-brief.md`, which is not yet on omp2). Upstream pin `c308970263` (v18.20.0); omp2 base `origin/omp2 9cb6fd6389`. Citations are `path:line`; upstream paths carry the prefix `upstream:`; bare `store.rs`, `extract.rs`, `retain.rs`, `session.rs`, `runtime.rs` and `config.rs` are in `crates/memory/src/`; `kernel.rs` is `crates/driver/src/headless/kernel.rs`; `hooks.rs` is `crates/contract/src/hooks.rs`. Docs-only record: nothing was built or run for it. The `Date:` line is the record's creation date (`docs/adr/README.md`, "Format"); the status line carries the revision date.

**Scope of this record.** This ADR covers three things for main sessions: wiring retention of the user's messages, a deterministic English and Spanish rule extractor for `llm_mode = none`, and fact expiry. Four things move to a follow-up ADR, not yet numbered (D12):
- structured tool observations (`package.json`, `Cargo.toml`, version banners);
- model lanes: a lane over the `@memory` role and the Apple Foundation Models lane, with typed lane faults, a bounded worker and the fallback to the rules;
- the sixth `FACT` field;
- retaining assistant text.

**Implementation gate.** Every slice is behind the default-off convar `sv_memory_session_retention`. Expiry is additionally behind `sv_memory_fact_expiry`, also default-off. The rules run only when `sv_memory_llm_mode` is set to `none`; its default, `smol`, is today's value. No `cap-*` feature is added (D7).

## Glossary

- **Bank**: one SQLite memory database (`store.rs`), possibly shared by several omp processes (`store.rs:1`).
- **Episode**: one retained window of a session's transcript, stored as a `working_memory` row (`store.rs:512-526`).
- **Retention window**: the settled messages since the last retention.
- **Cursor**: the highest user-turn count already retained for a key, stored in `retention_cursors` (`store.rs:545-550`; `retain.rs:109-127`).
- **Working memory and consolidation**: working rows are evicted when the same key retains again, past 24 h or 1000 rows (`config.rs:263-268`; `store.rs:537-544,1559-1625`). Consolidation (`MemoryRuntime::enqueue`, `runtime.rs:766-778`) promotes working rows to durable episodic rows.
- **Extraction job**: a row in `extraction_jobs` holding the user-authored text of one episode. It is written in the retention transaction (`store.rs:527-536`) and deleted together with its facts by `complete_extraction` (`store.rs:712-760`).
- **Fact**: an immutable `(subject, predicate, object, confidence)` row in `facts`, recalled by full-text search over `subject predicate object` (`store.rs:826-850,1740-1762`). Users reach facts today through the `recall` and `reflect` memory tools and the `memory://` device (`crates/tools/src/memory.rs:186-200`; `crates/envd/src/tool_url/memory.rs`). Automatic first-turn recall (`session.rs:72-122`) has no caller yet.
- **`FACT` line**: the existing model output protocol `FACT<TAB>subject<TAB>predicate<TAB>object<TAB>confidence`, parsed by `parse_facts` (`extract.rs:95-136`). This record does not change it.
- **`llm_mode`**: `MnemopiSettings.llm_mode`, one of `none`, `smol` (default), `remote` or `local-memory-model` (`config.rs:113-123,306`). `none` means the user chose no memory model.
- **Memory role**: the catalog's `@memory` selector, which tries the configured memory selectors, then `@commit`, then `@smol`. Reflection already uses it (`crates/driver/src/headless/reflection.rs:21-24`).
- **Lane**: an `ExtractionLane` implementation that turns a job into `FACT` lines with a model (`extract.rs:30-35`). None exists.
- **Hook gate and native hook host**: `HookGate` is the per-environment dispatcher for lifecycle hook events. A `NativeHookHost` is an in-process subscriber attached to it that receives events such as `turn_end`, `agent_end` and `session_shutdown` (`hooks.rs:760-784`).
- **Director**: a control-plane object kept in the session DOM that owns candidate yields (ADR 0015).
- **Convar**: a typed setting declared with `omp_con::var!` (ADR 0012).
- **Bank scoping**: `PerProject` (default) keeps one bank per project; `Global` shares one bank across projects (`config.rs`; `host_settings.rs:89`).
- **Main session**: a session the user talks to, composed through `ChatCommand::compose` (Context). Every other `compose_kernel` caller is auxiliary and runs on its own:
  - subagents and workpools (task workers);
  - the `/btw` side question;
  - "tan" jobs, which are background tasks a session dispatches;
  - the adw, cleanse and compress pipelines;
  - standalone tool runs.
- **EGM**: the Elephant-Goldfish Model design review: fresh-context reviewers read only this record and the files it cites.

## Context

- Upstream keeps a deterministic floor under LLM fact extraction. `heuristicExtractFacts` turns eight English first-person patterns into at most five fact sentences (`upstream:packages/mnemopi/src/core/extraction.ts:276-315`). `extractAndStoreFacts` adds metric, date, version and relation patterns (`upstream:packages/mnemopi/src/core/beam/consolidate.ts:675-783`). Both run when no model resolves (`upstream:packages/coding-agent/src/mnemopi/backend.ts:539,558-563`). The rules have three limits that matter here:
  - they write key/value rows (`upstream:packages/mnemopi/src/core/beam/consolidate.ts:289-314`);
  - they keep only counters for decisions (`:781-782`);
  - they are English only.
  omp2 indexes facts as `subject predicate object` text (`store.rs:1666,1751-1753`), so its rows must be real triples. Upstream's clause split treats every `.` as a boundary (`upstream:packages/mnemopi/src/core/extraction.ts:283`). Its newer pattern extractor treats a dot as a boundary only before whitespace, so that versions survive (`upstream:packages/mnemopi/test/beam-consolidate-unit.test.ts:424-455`).
- The gap brief requires the following (`docs/research/upstream-gap-closure-brief.md`, gap 2): rules that "cover Spanish and technical facts (versions, dependencies, decisions)", preferring structured tool results, a `valid_until` field, and an Apple FM lane. This record delivers the first and the third; the other two are D12.
- Nothing is wired.
  - No code outside `crates/memory/src` calls `retain_settled`, `shutdown_flush`, `pending_extractions` or `ExtractionLane` (repository search).
  - The finalizer's Mnemopi slot has no registrant, and `finalize` has no caller (`crates/driver/src/headless/finalize.rs:100-136`).
  - `HostSettings::from_con` never sets `llm_mode`, so production is always `smol` (`crates/envd/src/host_settings.rs:204-234`).
  - The only app-side consolidation trigger is `/memory enqueue` (`crates/app/src/chat_services/misc.rs:144-146`).
  - `/memory clear` runs `BankStore::clear`, which deletes every table including `retention_cursors` (`store.rs:1116-1127`; `runtime.rs:782-793`).
- In `session.rs`, both retention paths build a `Retainer` keyed by `runtime.session_id()`, with `extraction_enabled = llm_mode != None` (`session.rs:145-152,221-228`). The test `disabled_extraction_lane_retains_without_enqueuing` pins "`none` enqueues no job" (`session.rs:384`). `shutdown_flush` runs on its own thread and waits up to `shutdown_timeout_ms` (default 30 s; `session.rs:181-209`; `config.rs:236-238,281-283`). `Retainer` already strips `<memories>` blocks from retained text (`retain.rs:287-309`).
- **The runtime's session id is not durable.** It is a fresh ULID at every environment start (`crates/envd/src/lib.rs:1612-1617`), passed to `start_memory_runtime` (`crates/envd/src/server/session.rs:39-63,351`). The cursor, the episode id and the job's `session_id` all derive from it (`store.rs:490-499,545-550`).
- **Journal names.** The lifecycle surface names a session by its journal *file name*: `journal_name` returns the file name, `.oms` included (`hooks.rs:751-758`). `SessionSwitched::to` and `SessionShutdown` use that function (`hooks.rs:617-654,741-747`). `compose_kernel` gives the plugin host the file *stem* instead (`kernel.rs:3061-3064,3083-3086`). Journals that omp creates are named `<ULID>.oms`: new sessions and forks (`kernel.rs:3877,3901`; a fork copies its source journal, `:3876-3878`). `--session <path>` opens any name, and an ephemeral journal is `session.oms` (`kernel.rs:3873,3904-3906`).
- Facts have no end of validity: `search_facts` returns them forever (`store.rs:826-850`). They are immutable (`store.rs:706`; `crates/envd/src/tool_url/memory.rs:195-197`). Upstream has validity on memory rows and triples, but not on facts (`upstream:packages/mnemopi/src/core/beam/schema.ts:346-356,414`).
- Schema migration.
  - `SCHEMA_VERSION = 3` (`store.rs:32`).
  - `migrate` runs in an exclusive transaction (`store.rs:1215`) and refuses a newer bank (`:1217-1219`).
  - Column additions run only when `version < SCHEMA_VERSION`, together with `RESET_REBUILDABLE_INDEXES` (`store.rs:1220-1233,1642-1658`).
  - Every reader and writer of `facts` names its columns (`store.rs:379,734-735,832-836,957-959,1666`).
- Hook surface.
  - `turn_end` fires after every inference turn (`crates/agent/src/loop.rs:1844-1858`), and its payload carries no transcript (`:1856`).
  - `agent_end` fires once per submission, when a run ends (`crates/agent/src/loop.rs:1203-1225`).
  - `observe` must not block.
  - The session's end awaits `decide(session_shutdown)` for at most `SESSION_SHUTDOWN_BUDGET` = 1500 ms (`hooks.rs:571,760-784`).
  - On a session switch the controller first ends the old session (`SessionShutdown::switching`), then sends `session_switched` (`crates/app/src/rpc_mode.rs:3292-3304`).
  - `compose_kernel` attaches the plugin host to the admission gate, but only `if tools_enabled` (`kernel.rs:3081-3099`).
  - `Journal::scan` reads committed entries without the writer lock (`crates/journal/src/lib.rs:186-203`).
- Journal shapes. A user message is a `msg.user@1` with `text`, plus `author` for a message written remotely by another person (collaboration; `crates/journal/src/data.rs:100-125`). Assistant content streams all open on prop `text`; the block kind (text or thinking) is a `kind` prop set by a separate `patch@1` (`crates/agent/src/loop.rs:4765-4797`). So a journal scan cannot tell thinking from text without replaying the patches.
- A Director would also see completed turns (`crates/contract/src/director.rs:686-689`). But engaging one journals a `<director>` node, and `DirectorStack::from_dom` stops the active chain at the first node the registry cannot construct (`director.rs:855-857,950-975`).
- Main-session owners. Interactive, print, RPC, ACP and share modes all compose through `ChatCommand::compose` (`crates/app/src/chat_cmd.rs:747-760`; callers `session_runner.rs:133`, `print_mode.rs:101`, `rpc_mode.rs:89`, `acp_mode.rs:66`, `share_cmd.rs:91`, `chat_cmd.rs:1166`). `--no-session` sets `ephemeral` (`chat_cmd.rs:602,657`). `/btw` (`crates/app/src/chat_services/session_ops.rs:269-275`) and tan jobs (`crates/app/src/chat_control.rs:3064-3073`) compose their own kernels. `KernelOptions` derives `Default`, and its `parent_session` field marks children (`kernel.rs:138,184-185`).
- Secrets. Retention stores transcripts unredacted (`retain.rs:172-175`). `SecretSessionSnapshot::build` combines the user's and project's configured secret rules, environment secrets and the built-in credential rules (`crates/driver/src/secrets/session.rs:22-50`). `/share` builds one from the user and project secrets files and redacts with `SecretRedactor` (`crates/app/src/chat_services/misc.rs:254-283`; `crates/driver/src/share.rs:470-478`).
- Text tooling. `omp-memory` already depends on `jiff` (`crates/memory/Cargo.toml:24`). `regex` is a workspace dependency (`Cargo.toml:215`). `xutf` offers NFC checks but no folding (`xutf` 1.6.0 `src/normalize.rs:134-199`).
- Owner decisions fixed before this ADR:
  1. The rule extractor runs only when no memory model is set.
  2. `valid_until` is set both by the rule extractor and, through an optional sixth field, by the model's `FACT` lines; five-field lines stay valid.
  3. Recall filters expired facts in `search_facts`, and read-by-id still returns them.
  4. Session wiring is part of this work (research note, header).
  5. The brief's Spanish and technical-fact requirement (above).
  The model half of (2) moves to D12.

## Decision

**D1. The rules run only when the user chose no memory model.** The rule extractor runs for a main session when `sv_memory_session_retention` is on and `llm_mode` is `none`. It MUST NOT run in any other mode.
- This is the narrow reading of owner decision 1. In `smol` the `@memory` role normally resolves to a model, so a memory model is set.
- The rules MUST NOT call any model; this rule is this record's own.
- In `smol`, retention stores episodes and enqueues no extraction job (D9). Default users therefore get episodes but no facts until the follow-up ADR adds lanes (D12; O1).

**D2. Facts may expire.** `facts.valid_until INTEGER NULL` holds the exclusive end of validity in UTC epoch milliseconds.
- *Producer.* In this record the only producer is the deadline row (D5).
- *Gate on.* With `sv_memory_fact_expiry` on, `search_facts` excludes facts with `valid_until <= now` in its `WHERE` clause, ahead of `LIMIT`, so expired rows never use up result slots. Read-by-id (`store.rs:955-963`) still returns them. A deadline already past when it is stored is hidden at once.
- *Gate off.* No producer writes the column, and `search_facts` runs today's query.
- *Unchanged.* `parse_facts` does not change.

**D3. The column is additive and is added only while the gate is on. `SCHEMA_VERSION` stays 3.**
- *Opening.* `BankStore` gains `BankOptions { fact_expiry: bool }` and `open_with(path, bank, root, options)`, and stores the option. `open` (`store.rs:193`) keeps its signature and means `BankOptions::default()`. The two production open sites pass `MnemopiSettings.fact_expiry` (`runtime.rs:285,310`). `clear()`, the v1 importer and tests keep calling `open`.
- *Migration.* With `fact_expiry`, `migrate` runs `add_column_if_missing(facts, valid_until, INTEGER)` (`store.rs:1360-1371`) inside its existing exclusive transaction (`store.rs:1215`), after `SCHEMA` (`:1224`), whatever the version. Concurrent first opens therefore add the column only once. Without `fact_expiry`, the schema text, the migration and the bank file are today's.
- *Writes.* `NewFact` gains `valid_until: Option<i64>`. `persist_extracted_facts` (`store.rs:724-760`) uses a nine-column INSERT when the store's option is on. When it is off, it uses today's eight-column INSERT and ignores the new field.
- *Reads.* `search_facts_at(query, limit, now_ms)` is the filtered query. `search_facts`, called at `crates/memory/src/recall.rs:205`, keeps its signature. When the option is on it delegates to `search_facts_at` with `jiff::Timestamp::now()`; otherwise it runs today's query.
- *State matrix:*
  - Column absent, gate off: today's behaviour.
  - Column present, gate on: recall filters expired facts.
  - Column present, gate off (it was on earlier): new rows get NULL and nothing reads the column, so expired facts are recalled again.
  - Older binary on a bank that has the column: unaffected, and it does not filter.
- *Accepted lag.* Cached recall can lag expiry by one index generation.
- *Why no bump.* A bump resets every bank's derived indexes and locks out older binaries (`store.rs:1217-1233,1642-1658`). Rule for later changes: a nullable column nothing else touches MAY be added this way; a change to meaning, a derived index or a constraint MUST bump.
- *Owner ruling.* This changes an existing schema, so the mechanism waits for the owner (O3), and slice S4 does not merge until O3 is answered.

**D4. Rule output is typed, closed and bounded.**
- *Predicates.* A closed set of 12: `name`, `is`, `works_at`, `lives_in`, `uses`, `prefers`, `dislikes`, `instruction`, `version`, `depends_on`, `decided`, `rejected`, plus `deadline` from S4. No other predicate is emitted.
- *Subjects.* `user`, a package-shaped name captured by the rule, or `project`. With `Global` scoping, `project` is ambiguous (O6).
- *Ids.* `rule_` plus the first 24 hex characters of `Hash32` over `source_memory_id \0 rule_id \0 subject \0 predicate \0 object`. This is the same length as `parse_facts` ids (`extract.rs:128`), so replays are idempotent under `INSERT OR IGNORE` (`store.rs:733-737`).
- *Bounds and confidences.* These are starting values kept in code, and the tests assert them:
  - at most 32 facts per source memory;
  - subject at most 128 bytes and object at most 240 bytes, inside the parser's limits (`extract.rs:114-119`);
  - confidence 0.7 for identity, preference and instruction (upstream's 0.7 for entity strings, `upstream:packages/mnemopi/src/core/beam/consolidate.ts:622`);
  - confidence 0.6 for version, dependency and decision (upstream's 0.6 for versions, `:768`);
  - confidence 0.5 for deadline (upstream's 0.5 for dates, `:750`).
- *Timestamp.* `NewFact.timestamp` is the job's `created_at` (`store.rs:533`), carried by `QueuedExtraction` (D9).
- *Purity.* Rules are pure functions of the job text and read no clock.
- *Duplicates.* The same triple stated in several episodes gives several rows, because the id includes the source. This is accepted (O6).

**D5. The rule tables are data, specified here.** Rules are `const` tables in `crates/memory/src/extract/rules/{en,es}.rs`, one row per `Rule { id, family, pattern, subject, predicate, confidence }`. Each pattern is compiled once with `regex` in `(?i)` mode, which applies Unicode-aware simple case folding.
- *Input.* The rules run on one user message at a time. Within a message, retention markers are removed (`strip_protocol_markers`, `retain.rs:212`), fenced code blocks are removed, and whitespace runs collapse to one space, as upstream does (`upstream:packages/mnemopi/src/core/extraction.ts:278`).
- *Clauses.* `.`, `!`, `?` and `;` end a clause only when followed by whitespace or the end of the message (`upstream:packages/mnemopi/test/beam-consolidate-unit.test.ts:424-455`). The words " and ", " but ", " y " and " pero " also split. A clause keeps its terminator for the guards below.
- *Anchoring.* Every pattern is anchored at the clause start (`^`), allowing leading `also`, `también` and `now`. This handles:
  - negation, since "I don't use X", "No uso X" and "No me gusta X" cannot match "I use X", "uso X" or "me gusta X";
  - questions such as "Should I use X";
  - row overlap.
  Every row that matches fires, and the table has no two anchored rows that match the same text (a unit test asserts each vector's exact triples).
- *Skipped clauses.* A clause is skipped in any of these cases. Every word list matches on Unicode word boundaries (`\b`), so `si` does not hit "sistema" and `clave` does not hit "enclave".
  - Its terminator is `?`, or it starts with `¿`.
  - Its first word is an interrogative opener: `what`, `why`, `how`, `when`, `where`, `who`, `which`, `should`, `can`, `could`, `would`, `will`, `do`, `does`, `did`, `is`, `are`, `qu[eé]`, `c[oó]mo`, `cu[aá]ndo`, `d[oó]nde`, `qui[eé]n`, `cu[aá]l`.
  - It contains a hypothetical marker: `if`, `unless`, `would`, `could`, `should`, `might`, `maybe`, `si`, `a menos que`, `quiz[aá]s?`, `tal vez`, `podr[ií]a`, `deber[ií]amos`.
  - It contains a secret word: `password`, `passwd`, `token`, `api key`, `apikey`, `secret`, `private key`, `contrase[nñ]a`, `clave`, `secreto`, `credencial`.
- *Accents.* Matching is accent-insensitive through explicit alternations, with no folding crate (AGENTS.md "Unicode/ANSI"). Input in decomposed form (NFD) misses accented alternatives; this is accepted.
- *Captures.* `X`, `Y`, `<name>` and `<dep>` stop at the next clause boundary or comma.
  - `<name>` and `<dep>` are package-shaped tokens: letters, digits, `-`, `_`, `.`, `/` and `@`, starting with a letter or `@`.
  - A leading article (`a`, `an`, `the`, `un`, `una`, `el`, `la`) is dropped from `X`, as upstream does (`upstream:packages/mnemopi/src/core/extraction.ts:288`).
- *Versions.* `V` must pass a port of upstream's `isVersionMention` (`upstream:packages/mnemopi/src/core/beam/consolidate.ts:68-88`):
  - a `v`-prefixed or `x.y.z` token counts on its own;
  - a bare `x.y` counts only after a version cue: upstream's cue words, plus `versi[oó]n`, `actualizamos` and `subimos`;
  - a slice of a longer dotted run, such as an IP address, never counts.
  The row's own verb counts as the cue.
- *Dates (S4).* `D` is one of `YYYY-MM-DD`, `D Month YYYY`, `Month D, YYYY` or `[el] D de <mes> de YYYY`. English months are `January` to `December`; Spanish months are `enero` to `diciembre`, with `setiembre` also accepted. Dates are parsed with `jiff`. An invalid date (`2027-02-30`) produces nothing. "The deadline is D" means valid through D, so `valid_until` is the next UTC midnight after D (O4). Numeric and relative dates are not parsed (O5).
- *Starting set.* Each row has a paired negative test:

| Family | English (anchored) | Spanish (anchored) | Triple |
|---|---|---|---|
| identity | `my name is X` | `me llamo X`, `mi nombre es X` | `(user, name, X)` |
| identity | `I work as X` | `trabajo como X` | `(user, is, X)` |
| identity | `I work (at\|for) X` | `trabajo (en\|para) X` | `(user, works_at, X)` |
| identity | `I live in X`, `I am based in X` | `vivo en X` | `(user, lives_in, X)` |
| preference | `I use X`, `I am using X` | `uso X`, `estoy usando X` | `(user, uses, X)` |
| preference | `I (like\|love\|prefer\|enjoy) X` | `me gusta X`, `prefiero X` | `(user, prefers, X)` |
| preference | `I (hate\|dislike\|don't like\|do not like) X` | `odio X`, `no me gusta X` | `(user, dislikes, X)` |
| instruction | `(I\|you) (always\|never) X` | `(yo \|tú )?(siempre\|nunca) X` | `(user, instruction, "<always\|never\|siempre\|nunca> X")` |
| version | `we (upgraded\|updated\|bumped) <name> to (version )?V`, `<name> is (now )?(at\|on) (version )?V` | `(actualizamos\|subimos) <name> a (la versi[oó]n )?V`, `<name> est[aá] en (la versi[oó]n )?V` | `(<name>, version, V)` |
| dependency | `<name> (depends on\|requires) <dep>` | `<name> (depende de\|requiere) <dep>` | `(<name>, depends_on, <dep>)` |
| decision | `we decided (on\|to use) X( (over\|instead of) Y)?`, `we chose X( (over\|instead of) Y)?`, `we are going with X` | `decidimos usar X( en lugar de Y)?`, `elegimos X( en lugar de Y)?`, `optamos por X` | `(project, decided, X)`, plus `(project, rejected, Y)` when Y is captured |
| deadline (S4) | `the deadline is D` | `la fecha l[ií]mite es D` | `(project, deadline, D)`; `valid_until` is set only while `sv_memory_fact_expiry` is on |

- *Not ported.* Upstream's `I am X` row (copular `is`): it turns "I am getting an error" into a fact. Upstream's metric and relation patterns (`upstream:packages/mnemopi/src/core/beam/consolidate.ts:693-744,776-780`). Supersession ("we no longer use X"), because facts are immutable (D10).

**D6. Retention content is the user's own messages, redacted and bounded.** The projection from the journal to `OwnedRetentionMessage` (`retain.rs:31-40`) is a pure function in `omp-driver` over the live chain of `Journal::scan`. Nothing else is projected in v1.
- *What is projected.* Each `msg.user@1` whose `author` is absent becomes a `RetentionRole::User` message carrying its `text`. Its `stable_id` is the entry id.
- *What is not projected.* Messages with an `author` (another person in a collaborative session) are skipped. Assistant messages are not projected, because the journal cannot tell thinking from text without replaying patches (Context). Tool calls and results, compaction entries and all other entry kinds are not projected either, so the projection never reads a CAS blob.
- *Recalled memories.* `Retainer`'s existing `<memories>` stripping applies (`retain.rs:287-309`); the projection adds none.
- *Live chain.* The live chain uses the rule in `crates/driver/src/sessions.rs:268-294`. That private function moves to one `pub(crate)` helper in `omp-driver` in S1 and is used by both callers.
- *Redaction.* Each text passes through a `SecretRedactor` built from a `SecretSessionSnapshot`. The snapshot is built the way `/share` builds it (`crates/app/src/chat_services/misc.rs:254-283`): from the user and project secrets files under the composition's workspace trust, plus environment secrets and the built-in credential rules (`crates/driver/src/secrets/session.rs:29-44`).
  - The host owns the redactor (`redact` takes `&mut self`).
  - If building the snapshot or the redactor fails, the host does not attach, so nothing is retained (fail closed).
  - Secrets that match no rule are stored (O13).
- *Bounds.* Each message is truncated on a character boundary at 32 KiB, a starting value. The extraction text keeps its 256 KiB bound (`retain.rs:189-203`).
- *Not guarded.* Pasted quoted prose is not detected (O6).

**D7. Gates: three convars, default-off or default-unchanged; no `cap-*` feature.** The convars are declared beside `SV_WORKTREE_BASE` in `crates/envd/src/host_settings.rs` (`:139`; the module is public, `crates/envd/src/lib.rs:58`).
- `sv_memory_session_retention` (bool, off) is the rollout gate for D11. The driver reads it in `compose_kernel` from `ctx`, as it reads `SV_PLUGIN_HOOK_IDLE_PROMPT` (`kernel.rs:3091`).
  - It is needed because `ai_memory_backend = mnemopi` with `auto_retain` (default true, `config.rs:193-195`) already promises retention, which nothing performs. Enabling it for existing users before the tests pass would change that setting's effect.
  - *Sunset:* once S1-S3 pass and the owner approves (O8), it is removed.
- `sv_memory_llm_mode` (new con enum `MemoryLlmModeSetting { Smol, None }`, default `Smol`). `from_con` maps it to `MnemopiSettings.llm_mode`, like `ai_memory_backend` (`host_settings.rs:211-214`). The host reads the result from `MemoryRuntime::mnemopi_settings()` (`runtime.rs:992`). Only those two values are offered, because no lane consumes `remote` or `local-memory-model` yet.
- `sv_memory_fact_expiry` (bool, off) flows to `MnemopiSettings.fact_expiry` (`#[serde(default)]`, pattern `config.rs:196-198`) and then to `BankOptions.fact_expiry`.

The `sv_` prefix marks omp2-native host policy. New dependencies: only `regex` in `omp-memory`. With every gate at its default, behaviour and the bank file are byte-identical to today.

**D8. Retention is keyed by the journal file name.**
- *Key.* The key is `omp_contract::hooks::journal_name(&session)` (`hooks.rs:751-758`). It is computed in `compose_kernel` from the composed session, and later read from the `SessionSwitched` and `SessionShutdown` payloads, which use the same function. It is the file name, `.oms` included.
- *Which journals.* The host attaches only when the key's stem parses as a ULID, which is true of every journal omp creates (Context). Custom `--session` names and the ephemeral `session.oms` are not retained, so keys cannot collide across projects in a `Global` bank. A renamed journal no longer qualifies; a moved journal keeps its key.
- *API.* `SessionMemory` gains `SessionMemory::keyed(runtime, key, rules: bool)`. It uses `key` where today's code uses `runtime.session_id()` (`session.rs:145-152,221-228`): for the cursor, the episode id material and the job's `session_id`. With `rules` false it writes no job. With `rules` true it writes the job and drains it (D9). Keyed retention does not call `notify_extraction()` (`session.rs:154-156,229-231`), because no async worker exists.
- *Unchanged.* `SessionMemory::top_level` and the explicit `retain` tool keep the runtime id and today's predicate (`runtime.rs:511,525`; `session.rs:151,227`), so every existing test holds.
- *Missing cursor.* Whenever the key has no `retention_cursors` row, the host does not retain on that pass. Instead it seeds the cursor with the live chain's current user-turn count through `BankStore::seed_retention_cursor(key, turns)`, an `INSERT OR IGNORE`. This happens at first attach, after a fork, on a journal from before the feature, and after `/memory clear` deleted the row (`store.rs:1116-1127`). Retention therefore never re-retains history the user cleared or turns from before the feature.
- *Resume.* Resuming the same journal continues from its durable cursor. That recovers a window cut off by the shutdown budget or a crash, as long as the journal is resumed.
- *Rewind.* After a rewind the cursor can exceed the live chain's count. New turns are then retained only once the count passes the cursor (O7).

**D9. `none` mode: enqueue, then drain with the rules, in the same call.** With `rules` true the retainer is built with `extraction_enabled = true`, so the job row is written in the retention transaction (`store.rs:527-536`).
- *Drain.* After retaining, keyed retention calls `extract::rules::drain_key(store, key)`. It reads one batch of this key's jobs through a new `BankStore::pending_extractions_for_key(key, MAX_EXTRACTION_BATCH_JOBS)`, which has the bounds of `store.rs:571-599` and returns `QueuedExtraction { request: ExtractionRequest, created_at: Str }`. It runs the rules, maps `created_at` to `NewFact.timestamp`, and calls `complete_extraction` per job.
- *Scope.* The drain reads only this key's jobs. Another process sharing the bank owns other keys.
- *Errors.* A drain error is logged with its typed error and does not fail retention. `RetentionOutcome` gains `rule_facts_inserted: usize`.
- *At attach.* The host first drains this key's leftover jobs. It then deletes the key's jobs whose `created_at` is older than the working-memory TTL, through a new `BankStore::prune_stale_extractions(key, max_age)`. Pruning bounds jobs whose episode was consolidated, which eviction does not reach (`store.rs:1599-1605`).
- *Other modes.* With `rules` false no job is written, so no queue grows.

**D10. Facts stay immutable.** There is no mutation path. A newer fact does not replace an older one, so `(user, works_at, X)` and a later `(user, works_at, Y)` coexist. Recall ranks by text match only, with underscore predicates and no stemming (`store.rs:832-836`), so question-shaped queries such as "where do I work" need not match `works_at` (O6).

**D11. Wiring: a native hook host in `omp-driver`.**
- *Attach.* `crates/driver/src/memory_retention.rs` defines `MemoryRetentionHost: NativeHookHost`. `compose_kernel` attaches it to the admission gate beside the plugin host (`kernel.rs:3081-3099`), but not under `tools_enabled`, so `--no-tools` runs retain. It declares the events `AgentEnd` and `SessionShutdown` to `HookGate::attach_native`, as `PluginHookHost::attach` does (`crates/driver/src/plugin_hooks.rs:308-311`); `session_switched` reaches every host. All of these must hold:
  - `sv_memory_session_retention` is on;
  - the new `KernelOptions.memory_retention: bool` (default false) is true. Only `ChatCommand::compose` sets it, on the options value it passes (`chat_cmd.rs:747-760`), which covers all six main-session callers;
  - `options.parent_session` is `None`, and `options.ephemeral` is false;
  - the D8 key qualifies;
  - `environment.memory_runtime().is_active()` (`crates/envd/src/lib.rs:1337-1339`; `runtime.rs:347-350`);
  - the D6 redactor builds.
  A gateway composition (`KernelOptions.gateway`) is treated like any other; the host only touches the local bank.
- *Thread and mailbox.* The host owns one `std::thread` and one `flume` mailbox. The thread reads messages in FIFO order and owns the state: current key, journal path, the `SessionMemory::keyed` handle, the redactor and an `agent_end` counter. All work is synchronous. The messages are:
  - `Attach { key, path }`: seed, drain and prune (D8, D9);
  - `Signal`: scan and retain;
  - `Close { key, reply }`: final scan, then keyed force retention (the `retain_force` path, `retain.rs:99-101`), then the drain, then `MemoryRuntime::enqueue`, then a reply.
  Close is idempotent per key. The thread ends when the host is dropped (the mailbox disconnects) and is not joined. At construction the host posts `Attach` for the composed journal, so `compose_kernel` never waits on the scan.
- *Run end.* `observe(agent_end)` increments the counter and returns at once. `agent_end` fires once per submission, which is the same unit as `retain_every_n_turns`. When the counter reaches `retain_every_n_turns` it resets and posts `Signal`; signals that pile up coalesce in the thread. A `Signal` scans the journal, projects it (D6) and calls keyed `retain_settled`, which checks the durable cursor and drains in rules mode.
  - Periodic retention is kept, not only end-of-session retention: it limits what a crash of a long session can lose.
  - A scan error, such as an I/O failure or a malformed frame, is logged and skipped, and the counter is kept. The scan uses `Journal::scan` with the built-in vocabulary.
  - Each scan is a `tracing` span with the entry count and duration.
- *Session end.* `decide(session_shutdown)` reads the ending key from the payload (`hooks.rs:617-654`) and posts `Close`. It then awaits the reply with `recv_async` under `tokio::time::timeout(SESSION_SHUTDOWN_BUDGET)` and returns `NativeReply::defer()` (`hooks.rs:563-567`; the verdict is ignored, `:770-772`). Only that 1.5 s budget governs, because the host does not call `shutdown_flush` and so does not start its 30 s thread.
  - *Guarantee:* a best effort within 1.5 s. Work still running at the deadline continues on the thread until the process exits.
  - Turns left unretained are recovered when that journal is next resumed (D8).
  - A one-shot print run that is never resumed can lose its window if 1.5 s is not enough (O12).
- *Session switch.* The old journal is closed by its `session_shutdown`, which can delay `/new` by up to 1.5 s, as plugin hooks already can. `session_switched` must not block (`hooks.rs:778-783`); it only posts `Attach` for the new journal. FIFO order keeps the old journal's `Close` ahead of the new journal's `Attach`, and any `agent_end` after the switch counts for the new key. A path that ends a session without `session_shutdown`, such as an ACP `session/close`, retains that journal's trailing turns on resume.
- *Daemons.* `memory_runtime()` is the runtime of the session process's own server, so retention writes the bank from the session's process (O2).
- *Test seams.* `MemoryRetentionHost::with_mailbox(sender)` lets S1 tests hold the thread, and S1 tests fire `session_switched` through `LifecycleHooks::session_switched`, as `crates/driver/tests/plugin_hooks.rs` does.

**D12. Deferred to the follow-up ADR.** The follow-up MUST settle:
- the transport and crash safety of tool observations, and how manifest facts are retired;
- a lane over the `@memory` role (`reflection.rs:21-24`) and the Apple FM lane, with their bounds;
- producer separation across processes: a per-key drain, or a claim on jobs;
- a typed fault and worker API whose "rejected" agrees with D1, reconciling the existing extraction wakeup (`runtime.rs:961-973`) with `drain_key`;
- the fallback from an unavailable lane to the rules;
- the sixth `FACT` field, and whether model predicates outside D4 are accepted (`parse_facts` accepts any, `extract.rs:111-122`);
- retaining assistant text, by replaying `patch@1` kinds or reading the session DOM.

## Alternatives considered

| Option | Why not |
|---|---|
| Literal port of the upstream patterns | English only; key/value rows would index as "version version 1.2.3"; no decisions or dependencies; every `.` splits, which cuts versions. |
| Rules as an `ExtractionLane` emitting `FACT` text | `parse_facts` derives ids from the line number (`extract.rs:125-128`). Rule provenance and rule-id idempotence would be lost, and the five-field line cannot carry `valid_until`. |
| Rules also in `smol` when no lane is bound | In `smol` the `@memory` role normally resolves, so a memory model is set (owner decision 1). |
| Enqueue jobs in `smol` now | Nothing here drains them, and consolidated jobs escape eviction (`store.rs:1599-1605`; `runtime.rs:766-778`). |
| Key by the runtime's session id | It is a fresh ULID per process (`crates/envd/src/lib.rs:1617`). |
| Key by the file stem the plugin host gets | It differs from the `journal_name` that `SessionShutdown` and `SessionSwitched` carry (`hooks.rs:751-758`; `kernel.rs:3061-3064`). |
| Key by a genesis id or a project-qualified name | Not needed once only ULID-named journals qualify (D8); a moved journal keeps its name. |
| A memory Director | It journals a `<director>` node, which `from_dom` truncates at (`crates/contract/src/director.rs:855-857`). |
| The headless finalizer's Mnemopi phase (30 s, `crates/driver/src/headless/finalize.rs:50-56`) | No owner calls `finalize` (`:118-136`). |
| A full-window DOM projection (`project_window`, `crates/session/src/projection.rs:311-343`) | A native hook host has no DOM; it receives JSON payloads and the journal path (`hooks.rs:760-784`). |
| Retain assistant text from the journal | Thinking and text streams both open on `text` (`crates/agent/src/loop.rs:4765-4797`), so separating them needs patch replay (D12). |
| Retain tool results | Large, often spilled to blobs, the most secret-prone content, and no consumer until D12. |
| Trigger on `turn_end` | It fires per inference turn, not per user turn (`crates/agent/src/loop.rs:1844-1858`); `agent_end` matches the retention unit. |
| Call `shutdown_flush` at session end | It starts its own 30 s thread under the hook's 1.5 s budget (`session.rs:181-209`). |
| Redact with `credential_rules()` only | Misses the user's configured and environment secrets; `/share` uses the whole snapshot. |
| Unconditional column, or bump to 4 | Kept as alternatives in O3. |
| Defer expiry until a model producer exists | The brief requires `valid_until` now; deadlines are a real producer. |
| Drop Spanish or technical rules | The brief requires both (Context). |
| A Unicode folding dependency | Banned outside `xutf`, which has no folding. |

## Slices

Each slice is one PR, written test-first; tests are not edited to pass. Every slice:
- is verified remotely with `just remote-test-pkg omp-memory`, `just remote-test-pkg omp-driver` and a clippy run (`AGENTS.md`, "Commands");
- leaves `just lint` and `just test` green;
- updates this ADR's `Status in omp` and its STATUS.md row.

No slice adds a journal kind or payload (no golden journal) or changes model-facing prompts. Nothing user-visible appears until S1 is on. Facts appear only with `sv_memory_llm_mode = none`, and users reach them through the memory tools (Glossary).

**S1. Journal-keyed retention of user messages.**
- *Gate:* `sv_memory_session_retention`.
- *Scope:*
  - the D6 projection, redaction and the shared live-chain helper;
  - D8: the key, the ULID check, `SessionMemory::keyed(.., rules: false)`, `seed_retention_cursor` and the missing-cursor rule;
  - D11: the host, mailbox, thread, `agent_end` counter, close, switch and test seams;
  - `KernelOptions.memory_retention` and the convar.
- *Unit tests, `omp-driver`:*
  - `projection_takes_local_user_messages_only` (assistant, author-set and tool entries excluded);
  - `projection_redacts_configured_and_credential_secrets`;
  - `projection_follows_the_live_chain`;
  - `host_does_not_attach_when_the_redactor_fails`;
  - `non_ulid_journals_are_not_retained`.
- *Unit tests, `omp-memory`:*
  - `keyed_retention_uses_the_key_for_cursor_and_episode`;
  - `seed_does_not_override_an_existing_cursor`;
  - `keyed_without_rules_writes_no_job`.
- *Driver test:* `crates/driver/tests/memory_retention.rs`, built on `crates/driver/tests/memory_reflect.rs`.
- *Acceptance, gate off.* No row, cursor, job or host appears, and the journal holds nothing memory-specific.
- *Acceptance, gate on:*
  - a session of `retain_every_n_turns` submissions stores one episode, recallable through `search`;
  - a print-mode run stores its window at `session_shutdown` within the budget on a small bank;
  - resuming the same journal in a new process neither re-retains earlier turns nor loses ones cut off before;
  - a fork starts from the fork point;
  - after `/memory clear`, nothing earlier is retained again;
  - `observe(agent_end)` returns while the thread is held;
  - `/new` closes the old key and attaches the new one, in that order;
  - child, `--no-session`, `/btw`, tan and non-opted-in compositions retain nothing.

**S2. English rules in `none` mode.**
- *Gate:* `sv_memory_session_retention` with `sv_memory_llm_mode = none`. Depends on S1.
- *Scope:*
  - `crates/memory/src/extract/rules/`: the clause splitter, guards and the English identity, preference and instruction rows of D5;
  - `SessionMemory::keyed(.., rules: true)`, `drain_key`, `pending_extractions_for_key`, `prune_stale_extractions` and `QueuedExtraction`;
  - the `sv_memory_llm_mode` convar and the `regex` dependency;
  - the `omp-memory` attribution notice in `THIRD-PARTY-NOTICES.txt`.
- *Unit tests:*
  - one positive and one negative per row;
  - "My name is Ada. I work at Example Corp and I prefer dark mode." gives exactly `(user, name, Ada)`, `(user, works_at, Example Corp)` and `(user, prefers, dark mode)` (`upstream:packages/mnemopi/test/extraction.test.ts:93-103`);
  - "I live in Berlin and I use TypeScript." gives exactly `lives_in` and `uses`;
  - "I never use semicolons and you always wrap lines at 100." gives exactly two `instruction` facts;
  - the subjectless assistant narrative gives none (`:205-227`);
  - "Should I use Postgres?", "I don't use Postgres" and "If I use Postgres, …" give none;
  - "I use Node.js" gives `(user, uses, Node.js)`;
  - adversarial inputs (256 KiB of "I am ", 1 MiB without separators) stay within 32 facts.
- *Store tests:*
  - `drain_key_leaves_other_keys_alone`;
  - `crash_between_retention_and_drain_is_recovered_at_attach` (two processes on one journal key);
  - `attach_drains_before_it_prunes`.
- *Acceptance:*
  - `disabled_extraction_lane_retains_without_enqueuing` and every existing test pass unchanged;
  - with `smol`, no job and no rule fact appear;
  - replays leave one row per fact;
  - eviction removes rule facts;
  - the S1 driver test gains a `none` row that stores the vector above end to end.

**S3. Spanish and technical rules.**
- *Gate:* as S2. Depends on S2.
- *Scope:* the Spanish rows, and the version, dependency and decision rows of D5 in both languages, with the ported version guard.
- *Tests, each asserting the exact triples:*
  - "Me llamo Ada" gives `(user, name, Ada)`;
  - "We upgraded tokio to 1.40.0" and "Actualizamos tokio a la versión 1.40.0" give `(tokio, version, 1.40.0)`;
  - "omp-memory depends on jiff" and "omp-memory depende de jiff" give `(omp-memory, depends_on, jiff)`;
  - "We decided on SQLite instead of Postgres" and "Elegimos SQLite en lugar de Postgres" give `(project, decided, SQLite)` and `(project, rejected, Postgres)`.
- *Negatives:*
  - "¿Usamos tokio 1.40?", "No uso Postgres" and "No me gusta Postgres" give no `uses` or `prefers` fact;
  - "Should we upgrade tokio to 1.41?";
  - "set it to 1.0.0" (no fact, because no row starts that way);
  - a password sentence;
  - "Host 10.0.0.1 is up".
- *Version guard:* a unit test runs the ported guard on upstream's regression text (`upstream:packages/mnemopi/test/beam-consolidate-unit.test.ts:476-488`) and accepts exactly `1.3.2`, `2.4`, `v18.18.8`, `3.1` and `5.0`.
- *Clause rule:* a unit test runs it on upstream's boundary cases (`:424-455`, "Deployed v1.2 migration …" against "Deployed v1.2. Migration …").
- *Accents:* accented and unaccented spellings both match.

**S4. Fact expiry.**
- *Gate:* `sv_memory_fact_expiry`. Depends on S2. Merges only after O3 is answered.
- *Scope:* D2 and D3 (`BankOptions`, `open_with` at `runtime.rs:285,310`, the gated migration step, `NewFact.valid_until`, the nine-column INSERT, `search_facts_at`) and the deadline row in both languages.
- *Tests, gate off:*
  - after open, the `facts` columns and `user_version` equal today's;
  - recall does not filter;
  - the deadline row stores its fact with no `valid_until`.
- *Tests, gate on:*
  - `SCHEMA_VERSION` stays 3 and `memory_embeddings` rows survive the open;
  - two stores opening a pre-column bank at once leave one column;
  - the old eight-column INSERT succeeds on a migrated table;
  - "The deadline is 2027-03-15" and "La fecha límite es el 15 de marzo de 2027" store `(project, deadline, 2027-03-15)` with `valid_until` at 2027-03-16T00:00Z, a constant computed independently in the test;
  - `valid_until == now` counts as expired, and expired rows are hidden ahead of `LIMIT`;
  - read-by-id returns expired rows;
  - `2027-02-30` produces nothing.
- *Tests, gate on then off:* expired facts are recalled again.

## Consequences

- With `sv_memory_session_retention` on, the user's own messages in interactive, print, RPC, ACP and share sessions are retained, redacted, under their journal; nothing retains them today. Resume, crash, `/memory clear` and session switch behave per journal.
- With `llm_mode = none` the user also gets English and Spanish facts, including versions, dependencies and decisions. With expiry on, deadline facts expire.
- With every gate at its default nothing changes, including the bank file.
- Prohibited:
  - rules in any mode but `none`;
  - rules calling a model or touching another key's jobs;
  - mutating a fact;
  - retaining assistant text, tool results or other people's messages in this record;
  - a memory Director;
  - a JS/TS rule engine.
- Costs accepted:
  - episodes hold only the user's side of the conversation;
  - one journal decode per `retain_every_n_turns` submissions, which is measured in S1;
  - the D3 schema precedent; older binaries ignore expiry; turning expiry off re-surfaces expired facts; recall-cache lag;
  - stale and duplicate facts; poor recall for question-shaped queries; `project` is ambiguous in a `Global` bank;
  - pasted quoted prose can yield facts;
  - secrets outside every rule are stored;
  - NFD input misses accented patterns;
  - the 1.5 s shutdown budget (O12);
  - custom-named and pre-feature history is not retained;
  - three convars until the sunset.
- Not delivered by this record, though the brief asks for them: structured tool results first, the Apple FM lane with fallback, and model-written `valid_until` (D12; O9).

## Open questions for the owner

- **O1. Narrow reading of "no memory model is set".** D1 runs rules only in `none`, so default `smol` users get episodes but no facts until the follow-up ADR. Alternative: the broad reading. Recommendation: D1.
- **O2. Project-daemon retention.** No wire message carries memory to a daemon; D11 retains from the session's own process. Recommendation: revisit with the follow-up ADR.
- **O3. Additive `valid_until` column without a `SCHEMA_VERSION` bump (D3).** This changes an existing schema. Recommendation: confirm D3 (the column exists only while `sv_memory_fact_expiry` is on; no bump). Alternatives:
  - add the column unconditionally in the exclusive migrate step. This removes `BankOptions` and the dual INSERT, but changes every bank.
  - bump to 4: an index reset and older binaries locked out.
  S4 waits for the answer; S1-S3 do not depend on it.
- **O4. Date-only bounds are UTC.** "The deadline is D" means valid through D and ends at the next UTC midnight. Alternative: local time.
- **O5. Numeric and relative dates are out of v1.** Revisit when retained messages carry timestamps.
- **O6. Fact quality.** Four limits are accepted for v1:
  - immutable, duplicate and stale facts with no recency preference;
  - question-shaped queries that may miss underscore predicates;
  - `project` without a project identity in a `Global` bank;
  - pasted prose taken as the user's statement.
  Recommendation: accept; a later record may add supersession, deduplication by triple, or a natural-language index rendering.
- **O7. Rewind.** After a rewind, new turns retain only once the count passes the cursor. Recommendation: accept for v1.
- **O8. Gate sunset.** Remove `sv_memory_session_retention` once S1-S3 pass. Recommendation: confirm.
- **O9. The scope split.** Tool observations, model lanes, lane faults, the sixth `FACT` field and assistant text move to a follow-up ADR (D12). Recommendation: confirm.
- **O10. Languages.** Spanish only, as the brief asks. Upstream's detector also knows Russian and German (`upstream:packages/mnemopi/src/core/beam/consolidate.ts:555-612`).
- **O12. Shutdown budget.** `session_shutdown` waits 1.5 s (`hooks.rs:571`). A one-shot print run that is never resumed loses its window if retention plus consolidation exceeds that. Unconsolidated rows are evicted the next time the same key retains, and other sessions' consolidation can promote them (`store.rs:537-544,1559-1625`; `runtime.rs:766-778`). Options:
  - accept and measure in S1;
  - consolidate after each periodic retention;
  - a longer budget for this host, which changes a shared hook contract.
  Recommendation: accept, measure, then decide.
- **O13. Residual secret exposure.** Episodes are redacted with the session's secret rules and built-in credential patterns. Secrets that match no rule, such as an unconfigured password typed in prose, are stored. Recommendation: accept with the existing rule set; add rules if needed.

## What the review changed

### Round 1 (findings recorded in `docs/adr/STATUS.md` row 0062; verified and resolved 2026-11-14)

- **Session wiring slice missing; the extraction worker has no production caller; the ADR must say how `session.rs` calls it in `none` mode.** Confirmed: nothing outside `crates/memory/src` references `pending_extractions`, `ExtractionLane`, `retain_settled` or `shutdown_flush` (repository search). Neither `RegisteredMemoryRuntime::session` (`crates/envd/src/memory.rs:100-102`) nor `finalize` (`crates/driver/src/headless/finalize.rs:118-136`) has a caller. `session.rs:151,227` skip the job in `none` mode. Changed: a native hook host in `omp-driver`, the `session.rs` change and `drain_session`, with wiring as the first slice.
- **`SCHEMA_VERSION` choice for `valid_until` undecided.** Confirmed. The previous D3 also misread the code: column additions run only when `version < SCHEMA_VERSION`, together with the index reset (`store.rs:1220-1222`). Changed: an additive column with no bump, a new migration step that runs only while the gate is on, `open_with`, and O3 kept for the owner.
- **Apple FM lane bounds unspecified.** Confirmed in part. Chunk size, chunk count, deadline and token cap were stated. The token arithmetic, time and request bounds, the mid-job unavailability rule and the `Runtime` and `ModelNotReady` mappings were not (`applefm.rs:98-99,1480-1484`). Changed: D9 rewritten. Round 2 then moved the lane to a follow-up ADR.
- Corrected against this tree in round 1:
  - the prototype commit `daab333d13` is not in the repository;
  - the research note's close-path owners were wrong (`session_ops.rs:275` is `/btw`, `chat_control.rs:3073` a tan job);
  - a Director would truncate the active chain (`director.rs:855-857`);
  - `sv_memory_local_extraction` was dropped.

### Round 2 (four fresh-context reviewers and a synthesizer; 3 blockers, 20 majors, 5 minors; verified 2026-11-14)

Blockers:
- **B1. The cursor and job identity are per-process, so the resume and crash claims were false.** Confirmed: the runtime id is `Ulid::generate()` at every start (`crates/envd/src/lib.rs:1617`), and the cursor, episode id and job `session_id` derive from it (`store.rs:490-499,545-550`). Resolved by D8: a journal key through `SessionMemory::keyed`, cursor seeding, and drain and prune at attach.
- **B2. No path carries tool observations from the journal to the rules.** Confirmed: the job holds user text only (`retain.rs:177-187`; `store.rs:527-536`). Resolved by scope cut to the follow-up ADR (D12).
- **B3. The journal projection was unspecified.** Confirmed (`crates/journal/src/data.rs:102-104,505-575`). Resolved by specifying D6. `project_thread` was rejected because it drops pre-compaction turns (`crates/session/src/projection.rs:305-320`).

Majors, accepted:
- **M1, M2, M17** (`Rejected` against D1; cross-process producer mixing; the untyped worker API): moved to D12 as requirements.
- **M3 shutdown thread and budget:** `recv_async` under the timeout, plus a print-mode test.
- **M4 dead and unbounded queue:** no job outside `none`; prune at attach.
- **M5 the S2 and S6 contradiction:** S6 removed.
- **M6 scope:** accepted (O9).
- **M7(a) `@memory` binding:** informs D1 and D12.
- **M8 gate layering:** the rollout gate is justified, with a sunset; `sv_memory_rule_facts` dropped; the enum is named.
- **M9 expiry plumbing:** specified.
- **M10 manifests:** moved to D12.
- **M11 vocabulary:** 13 predicates and specified tables.
- **M12 accents:** explicit alternations.
- **M13 redaction:** added.
- **M14 `--no-session`:** excluded.
- **M15 rescans:** fewer scans.
- **M16 first session only:** fixed by D8.
- **M18 `created_at`:** carried by `QueuedExtraction`.
- **M19 handle and attach site:** corrected.
- **M20 glossary:** added.

Majors, rejected:
- **M7(b) a `RuleLane`:** ids and provenance would be lost (`extract.rs:125-128`).

Minors:
- m1 moot.
- m2 accepted as costs.
- m3 acknowledged.
- m4 numbers marked as starting values.
- m5: the ADR 0023 citation was corrected. The `Date:` objection was rejected: `Date:` is the creation date (`docs/adr/README.md`, "Format").

Corrected in round 2:
- the plugin host attaches under `tools_enabled` (`kernel.rs:3081`);
- `project_thread` drops pre-compaction turns.

### Round 3 (four fresh-context reviewers and a synthesizer; 3 blockers, 14 majors, 13 minors; verified 2026-11-14)

Blockers. All three are closed under the final-round rule: a factual correction that changes no reviewed decision, or removal of the affected scope.
- **S-01. Thinking cannot be told from text by stream prop.** Confirmed: every content stream opens on `PropId::Text`, and the block kind is a `kind` prop set by `patch@1` (`crates/agent/src/loop.rs:4765-4797`). Closed by removing scope: D6 now projects only the user's own `msg.user@1` text, and assistant text moves to D12.
- **S-02. The journal key was defined two ways.** Confirmed: `journal_name` returns the file name (`hooks.rs:751-758`), while compose gives the plugin host the stem (`kernel.rs:3061-3064`). Closed by factual correction plus scope removal:
  - D8 already named the `SessionSwitched::to` value, and compose now computes the same `journal_name(&session)`;
  - collisions were possible only for custom `--session` names and the ephemeral `session.oms` (`kernel.rs:3873,3904-3906`). Only journals with a ULID stem are now retained, which covers every journal omp creates (`kernel.rs:3877,3901`).
- **S-03. Splitting clauses at every `.` destroyed versions and dotted names.** Confirmed: the old D5 split on every `.`, which is what upstream's heuristic does (`upstream:packages/mnemopi/src/core/extraction.ts:283`). The ADR also misdescribed upstream's split tokens. Closed by factual correction: a dot now ends a clause only before whitespace or the end of the message, which is upstream's own corrected boundary (`upstream:packages/mnemopi/test/beam-consolidate-unit.test.ts:424-455`). The reviewed vectors (`1.40.0`, `omp-memory`) already required this, and no decision changed. Upstream's `\s+` collapse replaces the newline split.

Majors:
- **S-04, version vectors and citations.** Confirmed: only `:476` of `beam-consolidate-unit.test.ts` is a version test. Fixed: the S3 tests state exact triples; `:476` tests the ported guard directly; `:424-455` test the clause rule; the version row now starts with `we upgraded <name> to V`.
- **S-05, a 14th predicate in the bound row.** Confirmed (old D5 bound row). Fixed by removal: only the `deadline` row remains, and its gate-off behaviour is stated.
- **S-06, ineffective question guard and substring markers.** Confirmed. Fixed: clauses keep their terminator; patterns are anchored at the clause start; an interrogative-opener list was added; `should`, `might` and `deberíamos` are hypothetical markers; every list matches on word boundaries.
- **S-07, rule overlap and noise.** Confirmed: `I am X` over-matches (`upstream:packages/mnemopi/src/core/extraction.ts:288`). Fixed: `I am X` and `soy X` removed; anchoring removes the overlaps; the bare `<name> to V` form removed; a test asserts exact triples.
- **S-08, unspecified asserted values.** Fixed: D4 names the cap, byte limits, id length, hash input and confidences, anchored on upstream's confidences (`upstream:packages/mnemopi/src/core/beam/consolidate.ts:622,750,768`). D5 names article handling, the instruction object, the optional Y and the month tables.
- **S-09, a third decoder instead of `project_window`.** Checked (`crates/session/src/projection.rs:311-343`). Rejected for the host: a `NativeHookHost` gets JSON payloads and the journal path, not a DOM (`hooks.rs:760-784`). With user-only projection the decoder reads one entry kind. The shared live-chain helper is now in S1's scope.
- **S-10, two shutdown budgets.** Confirmed (`session.rs:181-209`). Fixed: the host runs keyed force retention directly, with no `shutdown_flush` thread, so only the 1.5 s budget governs. The order and the guarantee are stated, and the print-mode loss is in O12.
- **S-11, switch ordering and thread state.** Confirmed (`crates/app/src/rpc_mode.rs:3292-3304`). Fixed: D11 defines a single FIFO mailbox with `Attach`, `Signal` and `Close`, the thread's owned state, the close-then-attach order, the up-to-1.5 s delay to `/new`, thread exit, and the ACP path.
- **S-12, redaction narrower than claimed.** Confirmed: `credential_rules()` covers four token shapes (`crates/secrets/src/builtins.rs:7-30`). Fixed: the redactor uses the session's `SecretSessionSnapshot`, as `/share` does (`crates/app/src/chat_services/misc.rs:254-283`), and fails closed. Residual exposure is O13.
- **S-13, trigger unit mismatch.** Confirmed: `turn_end` fires per inference turn (`crates/agent/src/loop.rs:1844-1858`). Fixed: the trigger is `agent_end`, once per submission (`:1203-1225`).
- **S-14, `/memory clear` re-retains history.** Confirmed (`store.rs:1116-1127`). Fixed: the missing-cursor rule seeds instead of retaining.
- **S-15, remote authors and pasted text.** Confirmed: `msg.user@1` carries `author` (`crates/journal/src/data.rs:109-114`). Fixed: author-set messages are skipped. Pasted prose is accepted as a cost (O6).
- **S-16, S2-S4 serve only `none` mode.** Confirmed. Rejected the recommendation to ship S1 alone, because the brief requires rules for `llm_mode = none` (Context). Added in Slices and the Glossary: what the user sees, and that automatic recall has no caller yet (`session.rs:72-122`).
- **S-17, expiry machinery for one rule family.** Rejected deferral, because the brief requires `valid_until`. The unconditional-column alternative stays in O3.

Minors:
- S-18: the deadline boundary and past bounds are stated (D2, D5).
- S-19: how the driver reads the gates, and where `memory_retention` is set, are stated (D7, D11).
- S-20: the projection's own `<memories>` stripping was removed in favour of `Retainer`'s (`retain.rs:287-309`).
- S-21:
  - the declared events are stated;
  - attach drains before it prunes;
  - `drain_key` reads one batch;
  - keyed retention skips `notify_extraction`;
  - scan errors are logged and skipped.
- S-22: duplicates and question-shaped recall are accepted costs (D4, D10, O6).
- S-23: the eviction wording was corrected (Glossary, O12).
- S-24: periodic retention is kept, to bound crash loss; the test seams are named.
- S-25: rejected. The wakeup serves an async worker, while the rules are synchronous; reconciling the two is D12.
- S-26: accepted in part. `ExtractionPolicy` became `rules: bool`. The two-value con enum stays, because `remote` and `local-memory-model` have no consumer.
- S-27: accepted in part. Terms were added to the Glossary. The review history stays, because the brief requires this section ("Method", step 6).
- S-28: the brief's Spanish requirement is now cited.
- S-29: rejected. The status wording follows the review procedure, and STATUS.md belongs to the gap ledger owner.
- S-30: the license lines were corrected.

Machine-reviewed (EGM, 3 rounds), not owner-approved.

## Acceptance tests

1. S1, gate off. With `sv_memory_session_retention` off, a composed session attaches no memory host and writes no row, cursor or job. Every existing `omp-driver` and `omp-memory` test passes unchanged.
2. S1, gate on.
   - A main session retains its own redacted messages under its journal key, at the interval and at session end.
   - Resuming the same journal in a new process neither duplicates nor loses turns.
   - A fork, or a clear, starts from "now".
   - `/new` closes the old key and then attaches the new one.
   - Child, `--no-session`, `/btw`, tan, non-ULID and non-opted-in compositions retain nothing.
   - A print-mode run stores its window at shutdown.
3. S2. With `none`:
   - the upstream English vectors give the exact stated triples end to end;
   - questions, negation and hypotheticals give none;
   - with `smol`, no job and no rule fact appear;
   - replays are idempotent;
   - a crashed job is drained when its journal is next attached;
   - other keys' jobs are untouched;
   - adversarial inputs stay within 32 facts.
4. S3. The paired English and Spanish vectors give exact triples, the negatives give none, and the ported version guard and clause rule pass upstream's regression texts.
5. S4. Gate off: the bank's schema and `user_version` are unchanged and recall does not filter. Gate on:
   - no version bump;
   - one column under concurrent opens;
   - embeddings survive;
   - older statements work;
   - expiry is exclusive at `now` and is applied ahead of `LIMIT`;
   - read-by-id still returns expired facts;
   - the dated vectors store the independently computed instant.
6. All slices. No `pi` product name, every new convar is `sv_memory_*`, no string-payload errors, no prompt text built in code, and no Unicode utility crate.

## Status in omp

**Status: Not started.**

- The seam exists unwired: `ExtractionRequest`, `ExtractionLane`, `parse_facts` and `extract_and_store` (`extract.rs:19-136`); the queue (`store.rs:571-605,712-760`); the retention gate `llm_mode != None` (`session.rs:151,227`).
- Nothing calls retention, drains the queue, implements a lane, or controls `llm_mode` (research note 2.2-2.4). No slice is implemented.

## Upstream origin and license

**Draws from:**
- `upstream:packages/mnemopi/src/core/extraction.ts:264-315` (the English first-person patterns);
- `upstream:packages/mnemopi/src/core/beam/consolidate.ts:66-88` (the version guard).

**Ports the vectors in:**
- `upstream:packages/mnemopi/test/extraction.test.ts:93-103,205-227`;
- `upstream:packages/mnemopi/test/beam-consolidate-unit.test.ts:424-455,476-488`.

**Original work:** the Spanish rules, the dependency, decision and deadline rules, the triple shape, fact expiry, journal-keyed retention and the hook host.

**License: MIT.**
- Root license (`upstream:LICENSE:3-5`): Copyright 2025 Mario Zechner; 2025-2026 Can Bölük; 2026 Stencil Labs, Inc.
- Package license (`upstream:packages/mnemopi/LICENSE:3-4`): Copyright 2025-2026 Can Bölük; 2026 Stencil Labs, Inc. See also `upstream:packages/mnemopi/package.json:11`.
- There is no NOTICE file.

omp2 is MIT, Copyright 2026 Stencil Labs, Inc. (`LICENSE:3`), and it records ported lineages in `THIRD-PARTY-NOTICES.txt`; the `omp-shell-builtins` notice starts at `:1498`, and ADR 0054 records the same practice (`docs/adr/0054-shell-builtins.md:106`). S2 adds an `omp-memory` attribution notice that names the upstream files and the three copyright holders: Mario Zechner, Can Bölük and Stencil Labs, Inc.

## References

- ADR 0006: policy stays on the host; the rules execute nothing and read no files.
- ADR 0012: convars.
- ADR 0015: Directors, and why retention is not one.
- ADR 0023: the tiny local model, relevant to the follow-up's lanes.
- ADR 0024: no tool or roster change.
- ADR 0035: typed errors.
- ADR 0036: Python extensions, not used here.
- ADR 0049: no vendor code in this record.
- ADR 0054: the gate and notice precedent.
- ADR 0068: its extraction Director also observes main-agent prompts and uses `omp-secrets`, but it writes decision files, not the Mnemopi bank.
- `docs/research/mnemopi-fact-extraction.md`.
- `crates/driver/src/plugin_hooks.rs`: the native hook host precedent.
