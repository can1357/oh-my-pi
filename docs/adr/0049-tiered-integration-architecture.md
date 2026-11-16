# 0049. Tiered integration architecture: lean authority core, generic capability crates, neutral provider contracts, vendors as extensions

Status: accepted 2026-11-09. Phase 0 is recorded. Phases 1–3 landed. Phase 4 has started (PR1: pure `omp-forge` contract, PR2: pure `omp-ci` contract, PR3: `omp-forge-delegated` host router, PR4: `omp-ci-delegated` host router, PR5: `forge@1` and `ci@1` replace `github@3` through those routers). The contract is not stable until GitLab T2 (D2.8).
Date: 2026-11-09
Area: runtime/extensions/integrations

## Context

Accepted and proposed decisions point the same way, but none says **where a new capability belongs**. So the periphery keeps landing in `omp-envd`, and vendor code keeps landing in core crates.
- [ADR 0045](0045-envd-responsibility-boundaries.md) (accepted 2026-10-28, Alternative F) preserves the authority core and extracts the periphery. Vocabulary extraction, modularization and peripheral extraction are open.
- [ADR 0046](0046-recover-v1-extensibility-without-centralization.md) recovers v1 locality: a table-driven roster, a contract crate, additive events, extension UI host arms, and periphery outside envd.
- [ADR 0024](0024-small-permanent-roster.md)/[0025](0025-long-tail-behind-stable-surfaces.md) keep a small, latched wire roster and push the long tail behind `dyn`.
- [ADR 0036](0036-python-for-extensions.md) keeps extensions as embedded Python only.
- [ADR 0040's 2026-11-05 amendment](0040-remote-build-and-test-execution.md#amendment-2026-11-05-vendor-integration-leaves-core) records the owner's ruling: **vendor integration moves outside core as an extension; core keeps only the generic, extensible ground.** It also defines one in-core `Delegated` adapter for a backend outside the binary.
- [ADR 0047's 2026-11-05 amendment](0047-agent-build-execution-model.md#amendment-2026-11-05-vendor-clients-leave-core) extends the vendor-name prohibition to every core crate.

**Owner ruling, 2026-11-09:** the 2026-11-05 vendor rule applies to forge and CI vendors too, not only to execution vendors.

### Evidence (at `omp2` @ `278d636`)

| Fact | Source |
|---|---|
| envd has no optional dependencies; its only feature is `local-tts`. The periphery compiles in every envd build regardless of runtime use | `crates/envd/Cargo.toml` |
| The `omp` binary closure is 1,214 crates; envd's alone is 1,164 | `Cargo.lock` graph |
| `omp-exec-local` uses only `omp_envd::exec::{ExecError, ExecEvent, ExecHost, ExecRun}`: closure 1,165 crates, 284 without envd | `crates/exec-local/src`, `Cargo.lock` |
| `omp-exec-ssh` uses only `omp_envd::ssh::SshService`: 1,165 crates, 200 without envd. It has no composer since PR #486 | `crates/exec-ssh/src`, ADR 0040 amendment |
| `omp-desktop` (`computer`) is used only by envd and adds 67 crates to `omp`, many of them Linux-only | `Cargo.lock` |
| `russh`/`russh-sftp` are used only by envd and add 30 crates | `Cargo.lock` |
| `candle` adds 29 crates through `omp-ai`, enabled by `app`'s `default = ["local"]` | `crates/app/Cargo.toml` |
| `omp-ai/realtime` (WebRTC/DTLS/Opus) is used by `app` voice, so it earns its weight | `crates/app/src/{chat_voice.rs,voice/synth.rs}` |
| GitHub vendor code sat in core (`envd/src/github.rs`, historically `github_url.rs`, `github@3`); Phase 4–5 moved forge/CI to Dyn T2 extensions and neutralized schemes/credentials to `forge_url.rs` | `crates/{envd,tools}/src`, `extensions/{forge,ci,github,gitlab}/` |
| Built-ins are closed at compile time (`Scheme` + `url-vocab.json`); the unknown-scheme fallback (`install_unknown_fallback` → `HostUriResolver`) already resolves schemes declared by the RPC host, with selectors in core; extensions cannot declare schemes today | `crates/tools/src/read/resolver.rs`, `crates/tools/url-vocab.json`, `crates/py/build.rs`, `crates/envd/src/tool_url.rs`, `omp/urls.py`; [ADR 0050](0050-extension-declared-url-schemes.md) |
| A Python extension can mount an MCP server (`omp.mcp.mount`), whose resources are readable as `mcp://` | `crates/py/python/omp/mcp.py`, ADR 0027 |
| 120 Python ports (113 v1 extensions plus 7 probes) were written 2026-08-20..24 to measure API gaps and deleted 2026-09-03 (`00611047`). 58 have no native equivalent today | `00611047c1^:examples/` |
| The gaps that blocked those ports are closed: `omp.Device.subtool`, `Device.mount` and `omp.creds.mint_scoped` exist | `crates/py/python/omp/{devices,creds}.py` |

Crate counts come from the `Cargo.lock` graph, which unifies platforms and features. They are proxies. Phase 0 replaces them with `cargo build --timings`.

## Decision

### D1. One placement rule, four tiers
Every capability belongs to exactly one tier: **the lowest tier that satisfies its requirements.**

| Tier | What lives here | Admission test | Location | Build cost |
|---|---|---|---|---|
| **T0 Authority core** (`omp-envd`) | Document authority, exec and kill boundary, sandbox and egress, admission decision function, blobs and generations, Python supervision, MCP transports (audit §8 invariants) | Needs a single owner, a kill boundary or the effect gate | `omp2` | Always compiled |
| **T1 Generic capability crates** | Vendor-neutral capabilities and contracts: `browser`, `computer`, `tts`, `omp-forge`, `omp-ci`, the `Delegated` adapters, generic protocols (git, REAPI, SSH, MCP) | Names **no vendor**, **and** needs one of: a first-class scheme with its own selectors or cache; repository-lock or worktree coordination; a hot-path budget; holding raw credentials | `omp2`, one crate each | Behind a Cargo feature `cap-<name>`, default-on in `omp-app` only |
| **T2 First-party extensions** | **All vendor integrations** (GitHub, GitLab, Gitea, Bitbucket, BuildBuddy, Jenkins…), plus maintained long-tail workflows, policy, UI and provider data | Expressible with the frozen `omp.*` API, the T1 contracts and declared effects | This monorepo’s `extensions/` tree (not a Cargo member; root `Cargo.toml` keeps `members = ["crates/*"]`) | Zero Cargo weight |
| **T3 Third-party** | Python extensions, MCP servers | Declares effects; obeys trust tiers | Anywhere | Zero |

Placement rules:
- **Vendor integration code (D6 class A) never enters T0 or T1.** Inference and search transports follow providers-as-data (D6 class B). Vendor *data* may flow through T1 as operator or extension data: host patterns, env-var names, API base paths, ref conventions. Vendor *code* may not.
- **Tier is not roster.** T1 tools still ride `dyn` unless they pass ADR 0024's permanent-roster bar. No tier mutates the latched wire roster or schemas at runtime (Locked Deviation).
- **New capabilities default to T2.** Promotion to T1 needs an evidenced reason from the T1 test, recorded in the crate README. A capability that no longer meets its reason is demoted.

### D2. Neutral contracts in core; vendors behind one `Delegated` adapter
This follows the execution precedent (ADR 0040 Part A.1 as amended: `Local | Reapi | Ssh | Delegated`).

1. **Pure contract crates** hold types, traits and pure logic, with no I/O and no vendor names:
   - **`omp-forge`**: `RepoRef`, `CommitRef`, `ChangeRequest`, `Issue`, `Check`/`CheckState`, `ForgeChecks`, change-request and issue read/write operations, `required_checks`, and which operations **mutate**.
   - **`omp-ci`**: `Pipeline`, `Job`, `CiStatus`, `CiProvider`, `Capabilities` (`rerun_failed`, `rerun_job`, `cancel`, `trigger_with_inputs`, `artifacts`, `log_stream`, `play_manual`), and a pure `route(details_url)`.
2. **One in-core adapter per contract.** `omp-forge-delegated` and `omp-ci-delegated` (T1) route each request by host to the extension that declared it, and enforce security in core:
   - mutation flags come from the contract, not from vendor code;
   - approvals, egress host checks and result bounding are applied in core.
3. **Vendor adapters are T2 extensions.** They implement the contract through a documented `dyn` device schema (`forge/*`, `ci/*`) over `toolhost.v1`, or through an MCP server they mount. Adding a vendor edits no Cargo-workspace file (trees under `extensions/` only).
4. **Repository work stays generic and in core.** An adapter returns *data*: clone URL, ref spec, head SHA, base. Core performs fetch, worktree checkout under the repository mutation lock, and push, using `omp-vcs` and the user's git credential helpers. `pr_checkout` and `pr_push` therefore keep their isolation and lease guarantees without vendor code.
5. **Schemes are generalized, not added.**
   - `pr://` and `issue://` keep their names. Their meaning changes from "a cached GitHub pull request/issue" to "a forge change request/issue".
   - They are resolved by the `Delegated` resolver to the adapter owning the host, with core-side caching and selectors (`/diff`, comments).
   - The built-in vocabulary does not grow. A GitLab merge request is `pr://gitlab.example.com/group/project/42`. Extension-declared schemes follow [ADR 0050](0050-extension-declared-url-schemes.md).
6. **Tools become neutral.** `github@3` is replaced by neutral `forge@1` and `ci@1` contracts, served by the `Delegated` adapters. `run_watch`, checks, rerun, cancel, dispatch and artifacts move to `ci@1`. ADR 0024 roster review applies.
7. **Credentials are host-scoped.**
   - The resolution order (stored credential for the canonical host only → host-family env vars → git credential helper) stays in core.
   - Env-var names and canonical hosts are **adapter data**, not core constants.
   - Adapters receive only `omp.creds.mint_scoped` short-TTL, scope-limited credentials for providers listed in `credentials.allow`.
8. **A second adapter proves the contract** before it is declared stable. The GitLab adapter (T2) lands before the GitHub adapter replaces the in-core code.

**Vendor-lock register** (reviewed whenever an adapter is added):

| Area | Today | Target |
|---|---|---|
| Model providers | providers as data | keep |
| Remote execution | generic REAPI, plus BuildBuddy code in core | generic REAPI in core; BuildBuddy is an extension behind `Delegated` (ADR 0040 amendment) |
| Forge | GitHub code in envd and the tools contract | `omp-forge` + `Delegated`; GitHub and GitLab are extensions |
| CI | Actions-only `run_watch` | `omp-ci` + `route()` + `Delegated`; vendors are extensions |
| Tool interop | MCP | keep as the T3 standard and as a T2 transport |

### D3. Build weight: cut edges, gate capabilities
Each item is one reversible change.
1. **`ExecHost` contract → `omp-exec`.** Move `ExecError`, `ExecEvent`, `ExecHost` and `ExecRun` out of envd; `omp-exec-local` drops `omp-envd` (≈284 crates, from 1,165).
2. **`ssh` → `omp-ssh`** (ENVD-07, widened to include the `exec-ssh` edge). `omp-exec-ssh` drops `omp-envd` (≈200 crates), and envd drops `russh`/`russh-sftp` (30).
3. **Vocabulary contract crate** (ENVD-02, ADR 0046 item 2). envd stops depending on `omp-agent`.
4. **Table-driven roster** (ADR 0046 item 1). A T1 crate registers through a construction-table row plus `RegistryBridges`/`DynamicToolFactory`/`ContentResolver`, and edits no envd file. The built-in half is the static `omp_tools::roster` table. A test capability uses `SelectedRoster::with_extension` so it does not add a `Family` arm in envd. `DynamicToolFactory` and `ContentResolver` stay the other extension seams.
5. **Capability features.**
   - `cap-computer` (`omp-desktop`), `cap-browser` (`omp-webview`), `cap-tts`/media, `cap-forge`, `cap-ci`.
   - Each is default-on in `omp-app`, and absent from envd, `exec-*` and `driver` tests and from headless builds.
   - A compiled-out capability is absent from the construction table; it never becomes a runtime toggle.
6. **Vendor code leaves the workspace**: `envd/src/github*.rs` (Phase 4) and `omp-exec-buildbuddy` plus the vendor items in `omp-exec-reapi` (ADR 0040 amendment).
7. **`local` (candle) default** is an owner choice, recorded with timings.

CI builds the default `omp` profile and a minimal profile with all `cap-*` off.

### D4. Security is preserved or strengthened, never traded for lightness
- Raw provider tokens stay in core. envd keeps scrubbing provider tokens from children. Extensions get only `mint_scoped` credentials.
- Effects are declared:
  - T1 tools declare precise effects (fetch hosts, mutation).
  - T2/T3 manifests declare `capabilities`, fetch hosts and credentials.
  - Anything undeclared stays `Effects::unknown()`, which means the exec approval tier.
- Every mutation is approval-gated in core: forge writes, CI rerun/cancel/dispatch, pushes. The `Delegated` adapter applies the contract's mutation flags, so a vendor adapter cannot mark a write as a read.
- Sandbox egress per host (ADR 0028), the document authority and the effect gate are unchanged. No tier bypasses them.

### D5. Rescue the extensions deliberately, outside the Cargo workspace
- **A first-party extensions home** lives in this monorepo at `extensions/` (same-repo layout as early omp2 / can1357 upstream; owner decision 2026-11-10). It is **not** a Cargo workspace member — root `Cargo.toml` stays `members = ["crates/*"]` — so T2 code adds zero Cargo weight. Wheels are still locked and signed through `crates/ext`. That covers vendor adapters and the rescued ports. “Outside `omp2`” in this ADR means outside the Cargo workspace, not a separate GitHub remote.
- **Conformance CI.**
  - An `omp2` CI job runs every extension under `extensions/` against the frozen `omp.*` API using the QA fixture harness (`scripts/qa/fixtures/extensions`).
  - An API change that breaks a maintained extension fails `omp2` CI. That missing guard is what made the 2026-08 ports obsolete.
- **Triage the 58 ports without a native equivalent.** Restore a first wave of 6–8 with distinct surfaces and real demand, from `git show 00611047c1^:examples/<name>/`.
  - Candidates: `pr-review`, `green-loop`, `workflows`, `remote-approve`, `search-provider`, `provider-pack`, `fuzzy-index`, `spec-flow`.
  - Each must pass on the current API, declare its effects and have an owner.
- **UI-bound ports** (`sidebar`, `hover-cards`, `welcome-chrome`) restored with ADR 0046 item 4 host arms.
- The 34 ports with a confirmed native equivalent are not restored.

### D6. Vendor-code inventory: what leaves, what stays

"Vendor code" means code that names a vendor. It falls into three classes, and only class A leaves `omp2`. Inventory at `278d636`:

| Class | Rule | Code |
|---|---|---|
| **A. Vendor integration** (acts on a vendor's account, repository or service API) | Leaves `omp2`. It is replaced by a neutral contract plus `Delegated` (D2), and the vendor part becomes a T2 extension | Forge: `envd/src/github.rs`, `envd/src/github_url.rs` (historically named; neutralized to `envd/src/forge_url.rs`), `tools/src/github.rs` (`github@3`), `cache/src/github_cache.rs` (historically named; neutralized to `cache/src/forge_cache.rs`), `chat/src/cards/github.rs`, `chat/src/autocomplete/github_refs.rs`, `chat/src/gitwatch.rs` (spawns `gh`). Execution: `crates/exec-buildbuddy`, `exec-reapi/src/buildbuddy_cancel.rs`, `exec-reapi/proto-buildbuddy` (ADR 0040 amendment) |
| **B. Inference and search transports** | Stays. Governed by the Locked Deviation "providers-as-data": providers are catalog data, and codec code exists only for genuinely different wire protocols. Many interchangeable providers is not lock-in | `ai/src/codec/*` (model and `search_*` codecs), `ai/src/auth/**` (OAuth flows, including `github_copilot`, `gitlab`, `devin`), `ai/src/operation/usage/*`, `ai/src/provider/*`, `catalog/compat/providers/*.kdl` |
| **C. Content shaping and safety data** | Stays, as data or tables. No vendor API is called | `tools/src/read/web/scrapers/{github,github_gist,gitlab}.rs` (page extraction, like `arxiv`/`crates_io`); `minimizer` `gh` filter (output shaping, like other CLI filters); `envd/src/admission.rs` `gh` check and `envd/src/child_env.rs` `GITHUB_TOKEN` scrub (D4 safety) |
| **Recorded exception** (owner ruling 2026-11-09) | Stays until an exit condition holds | `envd/src/codex_app_server/*` speaks Codex's own agent-session protocol (threads, turns, approvals), which no other vendor implements. It is not an OpenAI-compatible model API; that API is class B. An extension would add a new executor surface and one IPC hop per streamed event, and would save almost no build weight, because spawn, kill, approval mapping and policy stay in core either way. **Exits:** (1) a maintained Codex ACP route with no loss on the gaps ADR 0043 lists (system prompt on `turn/start`, approval and network policy mapping): then delete the module and add Codex as an ACP profile; (2) a delegated-executor extension contract exists for another reason: then move the module behind it. **Phase 4 re-check (tip `3dba669808`):** both exits unmet; exception remains (no Codex ACP profile; ADR 0043 gaps still hold; no delegated-executor extension contract yet) |
| **T1 generic protocol** | Stays | `envd/src/acp_client/*`, `app/src/acp_client.rs` and `driver/src/delegated_acp.rs` speak generic ACP, and their CLI profiles are already data (`sv_delegated_<cli>_program`) |

Class A items move in Phase 4. Cards render `forge@1` data. `gitwatch` reads the checked-out branch's change request through the forge `Delegated` router (`view_change_request`) and does not spawn `gh`. Autocomplete insertion strings stay `pr://` and `issue://`. The rebuildable issue/change-request SQLite cache is forge-neutral (`cache/src/forge_cache.rs`; class A inventory historically named `cache/src/github_cache.rs`). The autocomplete module name `github_refs` stays. The extensions home decision landed (2026-11-10: in-repo `extensions/`); GitLab T2 (D2.8) is next and is not blocked on a separate repository.

## Sequencing

| Phase | Work | Backlog | Exit criterion |
|---|---|---|---|
| 0 Baseline | `cargo build --timings` (cold and one-line incremental) for `omp`, `omp-envd`, `omp-exec-local`, `omp-exec-ssh`; per-platform closure counts | ENVD-01 extension | Recorded in P8 |
| 1 Decouple | D3.1, D3.2, D3.3 | ENVD-16 (new), ENVD-07, ENVD-02 | `exec-*` closures ≤ 300 crates with no `omp-envd`; envd without `omp-agent` |
| 2 Locality | D3.4; `server.rs`/`tools.rs`/`mcp` splits | 0046 item 1, ENVD-03/04 | Adding a test capability edits 0 envd files |
| 2S Extension schemes | Extension-declared URL schemes ([ADR 0050](0050-extension-declared-url-schemes.md)): manifest `schemes`, additive `omp.schemes`, served by the existing unknown-scheme fallback. One PR per S1–S5 | ADR 0050 S1–S5 | S1–S5 land under [ADR 0050](0050-extension-declared-url-schemes.md), accepted by the owner 2026-11-11 with conditions; S1 may start, S2–S5 stay gated |
| 3 Generic capabilities | D3.5, one capability per change | ENVD-08/09 | Each removes an envd dependency edge; the minimal profile builds |
| 4 Neutral forge/CI/exec | `omp-forge`, `omp-ci`, `Delegated` adapters, `forge@1`/`ci@1`, generalized `pr://`/`issue://`; GitLab adapter (T2) proves the contract; GitHub adapter (T2) reaches parity; then remove every D6 class A forge item; BuildBuddy behind the execution `Delegated` adapter, then remove the D6 class A execution items | ENVD-09 (github item), ADR 0040 amendment | Parity suite green on the GitHub adapter; no D6 class A code in any `omp2` crate |
| 5 Extensions | In-repo `extensions/` home, conformance CI, rescue wave 1, GitLab T2 (D2.8), ADR 0046 item 4 UI host arms + UI ports | 0046 item 4 DONE | Wave-1 + UI ports green against the frozen API; Phase 5 remainder empty |
| 5b Typed catalog and discovery slices | [ADR 0046](0046-recover-v1-extensibility-without-centralization.md) items 3 and 5. **Item 3, typed hook-event catalog:** an event descriptor table (identity, schema revision, payload type name) in the neutral contract crate `omp-contract`; an exhaustiveness test over every `HookEventId` variant (`crates/proto/proto/omp/toolhost/v1/toolhost.proto:503`); then route the `crates/driver/src/plugin_hooks.rs` default arm through the table (payloads stay typed prost/serde structs per ADR 0046 owner ruling 3, and only rendering falls back to the default arm; other adapters are out of scope until a later PR). Step 3 added parity tests that hold the descriptor table to that enum, `crates/py/python/omp/events.py`, `crates/py/python/omp/hooks.py` and the Claude seams of `crates/ext/src/claude_hooks.rs`; the driver's `seam_event` mapping and the `docs/py/05-hooks.md` catalog stay unchecked (step 4). **Item 5, discovery as static provider slices:** `crates/driver/src/discovery/rules.rs` already uses static tables (`PROJECT_CONTEXT_PROVIDERS`, `USER_CONTEXT_PROVIDERS`); `crates/driver/src/discovery/skills.rs` still builds sources with an imperative `push` closure gated by `SkillPolicy` flags. **Entry:** item 2's contract crate has landed (`omp-contract`, ADR 0046 ruling 2; met). **PR plan:** (1) this docs PR; (2) skills static provider table; (3) descriptor table plus exhaustiveness test in `omp-contract` (DONE: `omp_contract::HOOK_EVENTS`, with parity tests against `toolhost.proto`, `omp.events`, `omp.hooks` and the Claude `HookSeam` mapping); (4) `plugin_hooks` default-arm routing; (5) a measurement fixture that counts the files touched to add a synthetic hook event, against the 11-file v1 baseline and the 29-file current cost recorded in ADR 0046 | 0046 items 3 and 5 | Item 3: exhaustiveness test green over every `HookEventId`, default arm routed through the table, existing event IDs and schema revisions unchanged. Item 5: skills converted to a static provider table, plus a no-foreign-executable test. Step (5) fixture reports its file count |

Every step is one self-contained, reversible change, with no shims or re-exports and all callers migrated (AGENTS.md). Until Phase 4 completes, the existing in-core GitHub code stays and receives fixes (for example host-scoped API authentication) as ordinary maintenance.

Phase 5b's "discovery" (ADR 0046 item 5, foreign-config discovery providers under `crates/driver/src/discovery/`) is unrelated to the "host-claim discovery" of Phase 5 (forge Dyn host claims through `sv_forge_dyn_hosts`).

## Non-goals
- No new daemons, no event bus, no thin supervisor (ADR 0045 alternatives C, D and E stay rejected).
- No JS/TS runtime, no dynamic tool schemas, no runtime roster mutation (Locked Deviations).
- No new built-in schemes for vendor concepts. Extension-declared schemes follow [ADR 0050](0050-extension-declared-url-schemes.md).
- Document authority never leaves envd.
- No bulk restore of the 2026-08 ports.

## Alternatives considered
| Alternative | Why not |
|---|---|
| Vendor adapters as first-party Rust crates in core (this ADR's first draft) | Contradicts the 2026-11-05 vendor rule as extended by the owner on 2026-11-09 |
| Keep adding capabilities natively in envd | Repeats the weight and inversion costs ADR 0045 classifies as defects |
| Everything as extensions, including repository work | Loses worktree, lock and precise-effect guarantees; weakens security |
| Bulk-restore all ports | Unowned code against a moving API; repeats the 2026-09-03 deletion |
| Vendor-specific tools and built-in schemes (`gitlab@1`, `mr://`) | N parallel contracts and prompt surfaces; grows the closed built-in vocabulary; lock-in by shape. An adapter may document merge requests as `pr://…` |

## Consequences
**Easier:**
- Adding a forge or CI vendor edits no Cargo-workspace file (only `extensions/`).
- Adding a generic capability edits no envd file.
- `exec-*`, envd tests and headless profiles build much smaller graphs.
- The extension API gains maintained first-party users and a CI guard.

**Prohibited:** vendor integration code (D6 class A) in any `omp2` crate; new built-in schemes for vendor concepts; extension-held raw provider tokens.

**Costs accepted:**
- Two contract crates and two `Delegated` adapters.
- A new device schema (`forge/*`, `ci/*`) added to the frozen Python surface, additively.
- A `github@3` → `forge@1`/`ci@1` migration with roster review.
- A parity suite for the GitHub adapter.
- An in-repo `extensions/` tree (owners = repo maintainers) with a wave-1 list.
- A feature matrix to keep green.

**Unchanged:** journal schema and `env.proto` frames. `toolhost/v1` and the Python ABI change only additively.

## Acceptance metrics
- Cold `cargo run --bin omp` build time does not regress; the minimal profile is measurably smaller.
- `omp-exec-local` and `omp-exec-ssh` closures are ≤ 300 crates with no `omp-envd`.
- Adding a T1 capability edits 0 files in `crates/envd/src`.
- Adding a forge or CI vendor edits 0 files under `crates/` (only `extensions/`).
- None of the D6 class A paths exists; recorded exceptions are on the allowlist only while no exit condition holds. A lintx rule rejects new vendor-integration modules outside the class B and C allowlist.
- No new RTT on the tool-call path (P8 W1–W9 unchanged or better).
- An e2e test proves no raw provider token is visible in an extension process.

## Implementation gate
- The owner accepted this record on 2026-11-09.
- Phase 0 must be recorded before Phase 1 starts.
- Each later phase starts only when the previous exit criterion is met.
- ADR 0046 acceptance (2026-11-09) authorizes its items 1, 2, 3, 4 and 5 under this sequencing; items 3 and 5 run under Phase 5b.
- ADR 0040 keeps its own acceptance gate. ADR 0047 was accepted by the owner on 2026-11-11 (see its Decision record); this record amends it but does not accept it.

## Status in omp

**Phase 0 recorded. Phase 1 ENVD-16, ENVD-07, and ENVD-02 landed.** The build-weight baseline is in [ADR 0045](0045-envd-responsibility-boundaries.md) under "Build-weight baseline (ADR 0049 Phase 0)". ENVD-16 moved the `ExecHost` contract into `omp-exec` as traits; envd implements them. ENVD-07 moved native SSH into `omp-ssh`. `omp-exec-ssh` does not depend on `omp-envd`. envd keeps `ssh://` behind `cap-ssh`. The selected-unification closure of `omp-exec-ssh` is 456 crates on this host (458 Linux, 455 Apple resolution), with no `omp-envd` edge. That is above the ≤300 exit. The "≈200 without envd" figure in the evidence table was a lockfile proxy. The 300 budget is unchanged. ENVD-02 added `omp-contract` below `omp-agent`, `omp-envd`, and `omp-driver`. `crates/envd/Cargo.toml` no longer depends on `omp-agent`. Selected-unification normal-edge closures on this Linux host, remeasured after ENVD-02: `omp-app` 1332 (Phase 0 was 1327), `omp-envd` 1031 (Phase 0 was 1144). `cargo tree -p omp-envd -e normal` with selected unification has no `omp-agent` edge. Cold and incremental timings were not re-run. Phase 2's roster portion (D3.4, ADR 0046 item 1) landed: `omp_tools::roster` is the static table, `compose_kernel` selects `SelectedRoster`, and envd iterates it. `crates/roster-probe` is the exit proof (`cargo test -p omp-roster-probe --locked`); that crate's diff does not touch `crates/envd`. ENVD-03 landed: `crates/envd/src/server.rs` is now `crates/envd/src/server/` (dispatch, control factories, devices, diagnostics, and the accept, connection, forward, runtime, session, identity, and error modules). No public API change. ENVD-04 landed: `crates/envd/src/tools.rs` is now `crates/envd/src/tools/` (`bridges`, `hooks`, `registry`, `roster_host`) and `crates/envd/src/mcp/` is grouped into `transport/` and `config/`, with the previous `mcp::` paths re-exported. No public API change and no roster-table change. Phase 3 PR1 (`cap-computer`, ENVD-08 half) gates `omp-desktop`. `omp-envd` features: `cap-computer = ["dep:omp-desktop", "omp-tools/cap-computer"]`, default features still empty. `omp-app` defaults are `local`, `cap-ssh`, and `cap-computer`, forwarding `omp-envd/cap-computer`. The Computer row of `omp_tools::roster::ROSTER`, `EnvironmentInstall::install_computer`, and the declare arm exist only with `cap-computer`. `Family::Computer` and `omp_tools::computer` stay compiled so chat cards keep their contract. Session tool settings still default `computer` off; that map cannot register a row the construction table omitted. Selected-unification proofs on this Linux host use `--locked --config 'resolver.feature-unification="selected"'`. `cargo tree -p omp-envd -i omp-desktop` exits 101 (`package ID specification omp-desktop did not match any packages`). The same tree under the repo's workspace unification still shows `omp-desktop`, because `omp-app`'s default enables the feature. With `--features cap-computer`, the selected tree shows `omp-desktop` under `omp-envd`. `cargo tree -p omp-app -i omp-desktop -e normal` shows `omp-desktop` through `omp-envd` into `omp-app`. `cargo check -p omp-envd` passes without compiling `omp-desktop`. `cargo check -p omp-envd --features cap-computer` passes and compiles `omp-desktop`. `cargo check -p omp-app` passes with the default features. Under that selected unification, `cargo nextest run -p omp-tools --lib` passes 559 tests with the feature off and again with `--features cap-computer`. envd's `only_sandbox_spawning_tools_are_exec_sandboxed` passes both ways. With `--features cap-computer`, the eight `computer` program and read-only approval tests pass. Phase 3 PR2 (`cap-browser`, ENVD-08 half) gates `omp-webview`. `omp-envd` features: `cap-browser = ["dep:omp-webview", "dep:tokio-tungstenite", "omp-tools/cap-browser"]`, default features still empty. `omp-app` defaults add `cap-browser`, forwarding `omp-envd/cap-browser` and `omp-driver/cap-browser`. The Browser row of `omp_tools::roster::ROSTER`, `EnvironmentInstall::install_browser`, `browser_enabled`, and the declare arm exist only with `cap-browser`. `browser_daemon`, `browser_fetch`, and `browser_relay` compile only with that feature, and so do `SV_BROWSER_ENABLED` and the CDP/relay convars. `Family::Browser` and `omp_tools::browser` stay compiled so chat cards keep their contract. A setting cannot register a row the construction table omitted. Driver attaches `BrowserFetchAdapter` only with `cap-browser`. `omp browser-relay` returns "the browser relay is not compiled into this build" when the feature is off. Selected-unification proofs on this Linux host use `--locked --config 'resolver.feature-unification="selected"'`. `cargo tree -p omp-envd -i omp-webview` exits 101 (`package ID specification omp-webview did not match any packages`). With `--features cap-browser`, the selected tree shows `omp-webview` and `tokio-tungstenite` under `omp-envd`. `cargo tree -p omp-app -i omp-webview -e normal` shows `omp-webview` through `omp-envd` into `omp-app`. `cargo check -p omp-envd` passes without compiling `omp-webview`. `cargo check -p omp-envd --features cap-browser,cap-computer` passes. `cargo check -p omp-app` passes with the default features. `cargo check -p omp-app --no-default-features --features local` passes. Under that selected unification, `cargo nextest run -p omp-tools --lib` passes 559 tests with the feature off and again with `--features cap-browser,cap-computer`. envd's sandbox and default-roster declaration tests pass both ways. With the features on, the browser settings tests and all 46 `browser_relay_contract` tests pass. Without `cap-browser`, that test target is not built. Phase 3 PR3 (`cap-media`, ENVD-09 media/TTS; ADR `cap-tts`/media) gates `omp-audio`. `omp-envd` features: `cap-media = ["dep:omp-audio", "omp-tools/cap-media"]`, default features still empty. `omp-app` defaults add `cap-media`, forwarding `omp-envd/cap-media`. The ImageGen and Tts rows of `omp_tools::roster::ROSTER`, `SessionInstall::image_tool`, `speech_tool`, and `ask_vocalizer` exist only with `cap-media`. `media_devices` and `media_tts` compile only with that feature. Ask still registers and does not play audio. `Family::ImageGen` and `Family::Tts` stay compiled so chat cards keep their contract. Those rows have no settings key. `omp-ai` links `omp-audio` only through `speech`, which `realtime` includes; envd enables neither feature, so the selected envd graph has no `omp-audio` edge through `omp-ai`. `local-tts` enables Kokoro in `omp-ai` and does not compile the envd device unless `cap-media` is also on. Selected-unification proofs on this Linux host use `--locked --config 'resolver.feature-unification="selected"'`. `cargo tree -p omp-envd -i omp-audio` exits 101 (`package ID specification omp-audio did not match any packages`). With `--features cap-media`, the selected tree shows `omp-audio` under `omp-envd`. `cargo check -p omp-envd` passes. `cargo check -p omp-envd --features cap-media,cap-browser,cap-computer` passes. `cargo check -p omp-app` passes with the default features. Under that selected unification, `cargo test -p omp-tools --lib` passes 559 tests with the feature off, and envd's sandbox and default-roster registry tests pass asserting the rows are absent. With the feature on, those registry tests and the eight `media_devices` tests pass. Phase 3 is complete. PR4's `just check-minimal-caps` typechecks default `omp-app` and `omp-app --no-default-features --features local` under selected feature unification, then requires `cargo tree -p omp-envd -i` to miss `omp-desktop`, `omp-webview`, `omp-audio`, and `omp-ssh` (exit 101, `did not match any packages`) with `--no-default-features`. `Lint workspace (Linux)` runs that recipe, so both profiles gate on the existing required check. The matrix is below. Optional `cap-security` hygiene remains open and does not block Phase 4. Phase 4 has started. PR1 lands the pure `omp-forge` contract: `RepoRef`, `CommitRef`, `ChangeRequest`, `Issue`, `Check`/`CheckState`, `ForgeChecks`, `required_checks`, `pr://` and `issue://` parsing into a host, owner, repository, and number, the operation vocabulary with mutation flags, and `ForgeHost`. The crate performs no I/O and names no vendor. PR2 lands the pure `omp-ci` contract: `Pipeline`, `Job`, `CiStatus`, `CiProvider`, `Capabilities`, `route(details_url)`, the operation vocabulary with mutation flags, and `CiHost`. The crate performs no I/O and names no vendor. PR3 lands `omp-forge-delegated`, the in-core host router over `omp-forge`: ASCII case-insensitive host lookup, `ForgeHost` forwarding, and approval gates on writes taken from `ForgeOp::mutates`. In-memory hosts prove the router. The crate performs no I/O, names no vendor, and stays out of `omp-envd` and `omp-app`. `github@3` is unchanged. PR4 lands `omp-ci-delegated`, the in-core host router over `omp-ci`: ASCII case-insensitive provider-host lookup, `route` for a details URL, `CiHost` forwarding, approval gates on writes taken from `CiOp::mutates`, and `Capabilities::allows` from the caps stored at registration. In-memory hosts prove the router. The crate performs no I/O, names no vendor, and stays out of `omp-envd` and `omp-app`. `github@3` `run_watch` is unchanged. `forge@1` and `ci@1` landed in PR5. Numbered `pr://` and `issue://` reads go through the forge `Delegated` router (PR6). `gitwatch` reads the checked-out branch's change request through that router (`view_change_request`) and does not spawn `gh`. The rebuildable forge issue/change-request cache is neutralized (`cache/src/forge_cache.rs`; historically `cache/src/github_cache.rs`). The autocomplete module name stays open. The extensions home is in-repo `extensions/` (owner decision 2026-11-10). Dyn `forge/*` (D2.3) is DONE (`docs/adr/0049-forge-dyn-device-schema.md`, envd `ForgeBackend`/`DynForgeAdapter`); GitLab T2 body (D2.8) remains to implement and is not blocked on a separate remote. Execution D6 class A steps 1–3 landed: REAPI profiles are operator data, `buildbuddy-cancel`/`proto-buildbuddy` are gone, and `omp-exec-buildbuddy` left the workspace; cancel is timeout-bounded until DelegatedBackend. Phase 4 re-checked the `codex_app_server` recorded exception on tip `3dba669808`: both exits unmet; the module stays. Phase 4 `cap-forge` and `cap-ci` landed (see below). Phase 5: `extensions/` home + wave-1 forge/ci/github/gitlab + conformance CI / first-cut manifest effect checks, rescue wave 1, host-claim discovery, and ADR 0046 item 4 (UI host arms + UI ports) are DONE; Phase 5 remainder is empty.

**Phase 1 closure update.** The 456 crates above (host resolution; 458 on the Linux target, 455 on the Apple target) is the ENVD-07 measurement: `cargo tree -p omp-exec-ssh --prefix none --locked | sort -u | wc -l` under per-crate `selected` feature unification with default edge kinds (normal, build, dev). That count includes a crate twice when it appears both expanded and as a `(*)` repeat; the same tree holds 339 distinct packages. The Phase 1 closure change makes `omp-proto/tonic`, `omp-core/schemars`, and the new `omp-core/open` feature opt-in and drops flate2's unused miniz backend. Neither closure has an `omp-envd` edge. Measured on a Linux runner with `--config 'resolver.feature-unification="selected"'`, before → after, in the order host / Linux target / Apple target:

| Crate | Edge kinds | `sort -u` lines | Distinct packages |
|---|---|---|---|
| `omp-exec-ssh` | default (normal, build, dev) | 456 → 369 / 458 → 371 / 455 → 368 | 339 → 273 / 339 → 273 / 334 → 268 |
| `omp-exec-ssh` | `-e normal` | 410 → 322 / 410 → 322 / 406 → 318 | 302 → 235 / 302 → 235 / 296 → 229 |
| `omp-exec-local` | default (normal, build, dev) | 287 → 218 / 290 → 221 / 285 → 216 | 228 → 178 / 228 → 178 / 222 → 172 |
| `omp-exec-local` | `-e normal` | 243 → 173 / 243 → 173 / 237 → 167 | 191 → 140 / 191 → 140 / 184 → 133 |

**These numbers hold under per-crate `selected` unification only.** The repo builds with `[resolver] feature-unification = "workspace"` (`.cargo/config.toml:61-62`), and other members still enable `omp-proto/tonic`, `omp-core/schemars`, and `omp-core/open`. Under that setting both closures are the same before and after this change (the resolved features and dependency edges of all 1313 packages are identical apart from the new `open` feature name), so built binaries and `cargo check -p` are unchanged. Distinct packages below the crate's own node in `cargo tree -p <crate> -e <kinds> --target <triple> --locked` (under this setting that command prints every workspace member, so only the crate's own subtree is counted; measured with `cargo tree` on macOS for each target triple), before = after, Linux target / Apple target:

| Crate | Edge kinds | Distinct packages |
|---|---|---|
| `omp-exec-ssh` | `-e normal,build` | 363 / 357 |
| `omp-exec-ssh` | `-e normal` | 308 / 302 |
| `omp-exec-local` | `-e normal,build` | 262 / 255 |
| `omp-exec-local` | `-e normal` | 206 / 199 |

**The Phase 1 exit is not met under the workspace setting:** `omp-exec-ssh` is above 300 there (363 distinct packages with `-e normal,build`, 308 with `-e normal`, Linux target) before and after this change, while `omp-exec-local` is below it (262 and 206). Under `selected` unification `omp-exec-ssh` is below 300 by distinct packages (273 with default edge kinds, 235 with `-e normal`) and above it by the recorded `sort -u` line count (371 with default edge kinds, 322 with `-e normal`, Linux target). The counting method is an open owner decision (ranked options and a recommendation are in the closure PR), so the exit stays recorded as open and the 300 budget is unchanged.

### Phase 3 capability matrix

`omp-app` defaults are `local`, `cap-ssh`, `cap-computer`, `cap-browser`, and `cap-media`. `omp-envd` defaults are empty. A cap that is off is missing from envd's construction table. It is not a runtime toggle. App still links `omp-audio` and `omp-ssh` directly, and `omp-ai`'s `realtime` feature (which app enables unconditionally) includes `speech`, so those crates can remain in the `omp-app` graph when the envd caps are off. The absence proof is the selected `omp-envd` tree.

| Feature | Default `omp` | Edge `omp-envd` drops when off |
|---|---|---|
| `cap-ssh` | on | `omp-ssh` |
| `cap-computer` | on | `omp-desktop` |
| `cap-browser` | on | `omp-webview` (and envd's `tokio-tungstenite` edge) |
| `cap-media` | on | `omp-audio` |
| `cap-forge` | on | `omp-forge`, `omp-forge-delegated` |
| `cap-ci` | on | `omp-ci`, `omp-ci-delegated` |

Phase 4 `cap-forge` and `cap-ci` are DONE. Phase 4 PR1 landed the pure `omp-forge` contract only. Phase 4 PR2 landed the pure `omp-ci` contract only. Phase 4 PR3 landed the `omp-forge-delegated` host router. Phase 4 PR4 landed the `omp-ci-delegated` host router. Phase 4 PR5 wires `forge@1` and `ci@1` through those routers inside `omp-envd`: `GithubForgeAdapter` and `GithubCiAdapter` still call `GithubService`. `cap-forge` / `cap-ci` make `omp-forge` / `omp-ci` optional on `omp-tools` (modules, renderers, and chat cards follow the features) and make `omp-forge`, `omp-forge-delegated`, `omp-ci`, and `omp-ci-delegated` optional on `omp-envd` (default-on in `omp-app`, which also forwards chat/tools). `Family::Forge` / `Family::Ci` stay either way. Selected unification leaves all four packages out of the `omp-envd` graph when the caps are off; `just check-minimal-caps` asserts that with the Phase 3 set. `github@3` is gone. `run_watch`'s Actions poll loop stays inside `GithubService` and is not model-facing; `ci@1` `watch` polls status until terminal and then reads failed-job logs. Numbered `pr://` and `issue://` reads go through the forge `Delegated` router (`GithubForgeAdapter::view_change_request`, `view_issue`, unified diff, and comments). List URLs later moved onto `ForgeHost::search` via `ForgeResolver` (historically `GithubResolver`). `envd/src/github.rs` was deleted after GitLab/GitHub T2; `github_url.rs` was neutralized to `forge_url.rs`. The neutral contract is not stable until that second real host exists. With `cap-forge` off, app omits `ServiceState.forge` and `branch_change_request` returns `Ok(None)` so the status-band chip stays empty; with it on, `gitwatch` reads the checked-out branch's open change request through `CheckoutForge::view_branch` (`view_change_request` on that router) and does not spawn `gh`. The rebuildable forge cache is neutralized (`cache/src/forge_cache.rs`; historically `cache/src/github_cache.rs`). Execution vendor items in `omp-exec-reapi` and the orphan `omp-exec-buildbuddy` crate are removed (steps 1–3); DelegatedBackend remains open. The extensions home decision landed (in-repo `extensions/`); GitLab T2 (D2.8) is next. `cap-security` is optional hygiene and is not part of this exit.

## Amendment (2026-11-10)




Consequences of this amendment:

ctx_search({queries:["","can"], source:"s1wu"}) searches the whole output (4990 B).**Recommended:** keep the 300 budget and decide the method explicitly.

**Owner decision (2026-11-16):** decide counting method first and record both measures in ADR 0049; choose trimming options afterwards.
## Amendment (2026-11-10)

**Owner decision (2026-11-10):** the first-party T2 extensions home may live **in the same git repository** as omp2 (as in early omp2 / can1357 upstream), not a separate GitHub repo. “Outside omp2” means **outside the Cargo workspace** (zero Cargo weight), not a separate remote.

Consequences of this amendment:
- T2 home is this monorepo’s `extensions/` tree. Root `Cargo.toml` keeps `members = ["crates/*"]`; `extensions/` is never a Cargo member and has no `extensions/Cargo.toml`.
- Wheels remain locked and signed via `crates/ext`. Development installs use `path:` / `omp ext link` against trees under `extensions/`.
- GitLab + GitHub T2 (D2.8) read+create via dyn: backends under `extensions/gitlab/` and `extensions/github/`; sole catalog owner `extensions/forge/` host-dispatches by `repo.host`. `gitlab.com` and `github.com` on the Dyn arm. SessionHost bound-client threading for `forge@1` is DONE. Self-hosted Dyn host registration + adapter host-claim discovery via `sv_forge_dyn_hosts` + `GITLAB_HOST` / `GITHUB_HOST` (`ForgeDynHosts`, shared by forge and CI) is DONE. Search leaves + list-URL via `ForgeHost::search` are DONE. Dyn checkout/push (D2.4) is DONE (`CheckoutPlan`/`PushPrep` → core `forge_worktree`). In-core `github.rs` deleted; Class C / `GithubRefs` stay.
- **DONE (2026-11-10):** conformance CI + first-cut manifest effect checks — `scripts/check-extension-conformance.py`, `just check-extensions` / `just test-extensions`, CI job `First-party extension conformance` (informational). Host-claim discovery is DONE. The home location is settled.
- **DONE (rescue wave 1):** eight D5 candidate ports restored under `extensions/` against the frozen `omp.*` API (`extensions/RESCUE.md`). Documented Gaps remain where typed journal / `omp.state` APIs were removed.
- **DONE (ADR 0046 item 4):** chat-host slot/overlay/`dynamic_mount` arms; UI-bound ports `sidebar`, `hover-cards`, `welcome-chrome` restored. Phase 5 remainder is empty.

## References
- ADRs 0024, 0025, 0027, 0028, 0036, 0040 (2026-11-05 amendment), 0045, 0046, 0047 (2026-11-05 amendment), 0050 (accepted 2026-11-11; Phase 2S).
- `docs/research/envd-responsibility-audit.md`; `docs/research/exec-out-of-core.md`; `docs/research/omp-v1-vs-omp2-architecture.md`.
- Deleted ports: `00611047c1^:examples/`.
- First-party extensions home: `extensions/` (scaffold; owner decision 2026-11-10).
