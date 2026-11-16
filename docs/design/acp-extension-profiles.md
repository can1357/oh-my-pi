# ACP extension profiles: vendor agent CLIs as extension data

Status: proposed (design only; this change is docs-only)
Date: 2026-11-11
Pinned HEAD: `5b0cd838c9c34c2542d7023d17a87a1d93dcdf09` (`5b0cd838c9`, branch `omp2`)
Amends: [ADR 0043](../adr/0043-native-cli-integration.md#amendment-2026-11-11)
Related: [ADR 0049](../adr/0049-tiered-integration-architecture.md), [ADR 0047](../adr/0047-agent-build-execution-model.md), [ADR 0040](../adr/0040-remote-build-and-test-execution.md), [ADR 0046](../adr/0046-recover-v1-extensibility-without-centralization.md)

This document specifies how the launch profiles of third-party agent CLIs (Devin, DeepSeek Harness, Grok, and the ones that follow) leave OMP2 core and become data that extensions supply. It is written to be implementable without further design questions. The open questions in §7 each carry a recommended answer and go to the council.

**Summary.** At the pinned HEAD the Devin, dsh and Grok launch profiles are Rust code in `crates/driver/src/delegated_acp.rs`, a crate the owner's vendor-name prohibition covers, and ADR 0043's statement that these profiles are data is not true of that code (§0.2). The proposal: a launch profile becomes a signed static content row of a new kind, `delegated-agents`, that an extension ships as a small TOML file (§1). Core keeps the generic ACP executor, the environment floor, the policy ceiling and an operator-approval gate, and builds executors from those rows (§2). With no extension installed nothing is registered, exactly as today (§2.4). The Agent SDK, MCP and A2A reach the same envelope through ACP shims in v1 (§3). Devin, dsh and Grok become manifest-only extensions with parity tests (§4). Ten small PRs, each with named proofs, end with the Rust profiles deleted and a lint that keeps vendor strings out of core (§5). Existing convars keep their names (§6).

## How to read this document

- `path:line` names a line, or an `a-b` range, of `path` at the pinned HEAD above. Each was read with `git show 5b0cd838c9:<path>`. The working tree is not evidence: other work was in flight in it while this was written.
- `UNVERIFIED(Un)` marks a claim that could not be verified here. Every tag has a row in [Appendix B](#appendix-b-unverified-ledger).
- `[scan]` marks a count or a no-hit result produced by the repository-wide commands in Appendix A.4 and A.5.
- `[design]` marks a statement that proposes something absent at the pinned HEAD.
- Paths such as `extensions/acp-devin/`, a `tools/lintx/` rule, or a new `crates/…` module are proposals unless a citation says otherwise.
- "The brief" is the task statement this design answers: an owner direction plus claims about the current code. §0.2 checks each claim.
- Scope of this change: it adds this file and appends one amendment to ADR 0043. It changes no code, script, test, extension or index, and it does not update `STATUS.md` or `TASKS.md`, which move with code (`docs/adr/README.md:40-42`).

## 0. Context and verified current state

### 0.1 Rules this design must satisfy

| # | Rule and source | Consequence for this design |
|---|---|---|
| R1 | Vendor names are prohibited in every core crate, `omp-driver` included (`docs/adr/0047-agent-build-execution-model.md:129-131`). | [design] `crates/driver/src/delegated_acp.rs` is a violation, and the check in §5.2 covers `omp-driver`. |
| R2 | Vendor integration is a T2 extension, while generic protocols and the `Delegated` adapters stay in T1 (`docs/adr/0049-tiered-integration-architecture.md:47-48`). | [design] Core keeps the generic ACP client; each CLI becomes extension data. |
| R3 | One recorded exception: `envd/src/codex_app_server/*` stays, with two exit conditions (`docs/adr/0043-native-cli-integration.md:163-168`). | [design] The check's allowlist keeps that module, and Q2 decides its driver glue. |
| R4 | The executable and its arguments come only from an operator-controlled table, never from project configuration (`docs/adr/0043-native-cli-integration.md:137-138`); there is deliberately no `operator-supplied argument list` (`crates/driver/src/delegated_host.rs:12-14`). | [design] Client-layer extensions only, operator-originated approval, no operator or project arguments (§1.4). **Reframed, not kept as written:** arguments become operator-approved, digest-pinned extension data, and the rationale of the `operator-supplied argument list` comment is not preserved (§1.7, OPEN OWNER QUESTION Q18). |
| R5 | OMP spawns the vendor's process, never installs bridges, and computes and pins its own digest for a downloaded binary (`docs/adr/0043-native-cli-integration.md:139-141`). | [design] The executable digest is recorded by core at approval, never claimed by a manifest (§1.5). |
| R6 | OMP never reads, copies or forwards another application's tokens and never drives a login flow; an unauthenticated agent is `AuthRequired` (`docs/adr/0043-native-cli-integration.md:129-131`). | [design] The auth fields are passive signals only; there is no probe or login command (§1.3). |
| R7 | Each profile declares only the policies it can enforce, everything else is `PolicyUnmappable`, and each profile needs proof before it is enabled (`docs/adr/0043-native-cli-integration.md:134-136`). | [design] `[policy]` admits the one policy ACP can represent today, with evidence references (§1.3). Core does not enforce the proof: `[evidence]` is informational, so this rule becomes a review and distribution matter (§1.7, Q18). |
| R8 | The client advertises no `terminal` capability and no file-system capability at first (`docs/adr/0043-native-cli-integration.md:132-133`); the handshake sends an empty `ClientCapabilities` (`crates/envd/src/acp_client/delegated_session.rs:173`). | [design] A profile cannot request client capabilities in v1. |
| R9 | Per-tool knowledge is not compiled into the binary, even as data; an extension content row or a user file delivers it (`docs/research/format-registry-options.md:444-446`). That passage states the rule for cleanse definitions; applying it to launch profiles is this design's extension of it. | [design] No built-in profile table in core, not even a Rust-side TOML table. |

### 0.2 The brief's claims against the pinned HEAD

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | `dsh_profile` is at about L151. | CONFIRMED | `crates/driver/src/delegated_acp.rs:151` holds `fn dsh_profile`. |
| 2 | `devin_profile` is at about L175. | CONFIRMED | `crates/driver/src/delegated_acp.rs:175` holds `fn devin_profile`. |
| 3 | The Grok registration is at about L80-136. | CORRECTED to L79-86 and L121-138 | The Grok convar is `SV_DELEGATED_GROK_PROGRAM` at `crates/driver/src/delegated_acp.rs:79-86`. The registration is `crates/driver/src/delegated_acp.rs:121-138`: eight arguments at L126-135 and `.with_id(GROK_ID)` at L136, with no `AcpProfile` and no custom environment. |
| 4 | ADR 0043 says the CLI launch profiles are data. | CONFIRMED as a claim, contradicted by the code | ADR 0043 says the profiles are already data (`docs/adr/0043-native-cli-integration.md:162`). The code says the module `fixes all of that in code` (`crates/driver/src/delegated_acp.rs:3-8`). An earlier audit records the profiles as `Not data-only` (`docs/audits/pr-deferred-adr-audit-2026-10-21.md:293`). |
| 5 | Generic ACP clients stay core: `crates/envd/src/acp_client/*` and `crates/app/src/acp_client.rs`. | PARTLY CORRECTED | The first is OMP acting as an ACP client of a vendor agent (`omp-envd` ACP v1 client, `crates/envd/src/acp_client/mod.rs:1-4`). The second is OMP acting as the ACP agent an editor talks to (`ADR 0037`, `crates/app/src/acp_client.rs:1-10`) and launches nothing. The generic client names vendors only in comments and tests, and the app file has no hits [scan]. |
| 6 | There is no extension-supplied launch-profile surface. | CONFIRMED | The declaration kind table has no kind for delegated agents (`dap-adapters`, `docs/py/14-deploy.md:776-782`). The Rust dispatch ends in `unknown static declaration kind` (`crates/ext/src/config.rs:2213-2215`). The Python API has no delegated, executor-id or ACP name [scan]. |
| 7 | There is no Agent SDK bridge contract. | CONFIRMED | The Agent SDK appears only in documents, 7 files in all [scan]. ADR 0043 names its bridge (`claude-agent-acp`, `docs/adr/0043-native-cli-integration.md:124`) and a research note says the SDK runs the vendor binary (`runs the Claude Code binary`, `docs/research/native-cli-integration.md:35`). It also appears in one system-prompt string (`Claude Agent SDK`, `crates/ai/src/codec/anthropic.rs:83`). No bridge code exists [scan]. |
| 8 | There is no A2A client. | CONFIRMED | No text file under `crates`, `extensions`, `docs`, `scripts` or `.github` matches `a2a` as a word; the only match is a binary tarball [scan]. |
| 9 | The MCP extension surface is unverified. | VERIFIED | `omp.mcp` declares MCP server mounts that become devices (`Model Context Protocol`, `crates/py/python/omp/mcp.py:1-6`; `async def mount`, `crates/py/python/omp/mcp.py:545`). Core owns an `Environment-scoped MCP authority` (`crates/envd/src/mcp/mod.rs:1-5`). Its transports are `stdio`, `http` and `legacy_sse` (`crates/envd/src/mcp/transport/mod.rs:8-14`). Nothing implements `DelegatedExecutor` over MCP: the implementors are `AcpExecutor` (`crates/envd/src/acp_client/executor.rs:145`), `CodexExecutor` (`crates/envd/src/codex_app_server/executor.rs:117`) and a mock (`crates/contract/src/delegated/mock.rs:202`). |
| 10 | Extensions live in the monorepo `extensions/` tree. | CONFIRMED | `extensions/README.md:3-4` names it the first-party Tier-2 home (`ADR 0049 D5`). |

### 0.3 What a launch profile is today

| Concern | Today | Evidence |
|---|---|---|
| Enablement | An operator names a program in a per-CLI convar. Empty means not enabled, and nothing is registered, spawned or probed until then. | `crates/driver/src/delegated_acp.rs:10-11`. `fn enabled` reads the convar (`crates/driver/src/delegated_acp.rs:143-145`). |
| Executable | The convar value is a path or a name on `$PATH` (`crates/driver/src/delegated_acp.rs:70-73`), handed to `Command::new` with no other discovery (`crates/envd/src/acp_client/executor.rs:177`). | As cited. |
| Arguments | Fixed in Rust, and an operator cannot add any. dsh uses `["--profile", "acp"]` (`crates/driver/src/delegated_acp.rs:108`). Devin uses `["acp"]` (`crates/driver/src/delegated_acp.rs:116`). Grok uses eight arguments (`crates/driver/src/delegated_acp.rs:126-135`). | As cited. |
| Environment | `ChildEnv` starts from a fixed ambient allowlist (`AMBIENT_NAMES`) and always drops secret-looking names (`SECRET_MARKERS`), both in `crates/envd/src/child_env.rs:19-45`. dsh adds `DSH_HOME` and sets `DSH_PERMISSION_MODE` last (`crates/driver/src/delegated_acp.rs:167-171`). Devin and Grok use the default `ChildEnv::ambient()` (`crates/envd/src/acp_client/executor.rs:72`). | As cited. |
| Session setup | `AcpProfile` has three fields: a session mode, ordered config options and an optional login notice (`crates/envd/src/acp_client/delegated_session.rs:51-59`). They are sent as `session/set_mode` and `session/set_config_option` right after the session opens (`crates/envd/src/acp_client/delegated_session.rs:210-258`). | As cited. |
| Policy | One policy only: `ACP_POLICY` (`crates/envd/src/acp_client/policy.rs:21`). A different request is `PolicyUnmappable` (`crates/envd/src/acp_client/delegated_session.rs:154-160`), and so is an agent that refuses the mode (`crates/envd/src/acp_client/delegated_session.rs:230-238`). | As cited. |
| Login signal | A typed vendor notice is declared by `LoginNotice` (`crates/envd/src/acp_client/delegated_session.rs:35-43`). The notification branch sets `login_required` (`crates/envd/src/acp_client/delegated_session.rs:330-341`). One generic error signature is `MISSING_LOGIN_CODE` (`crates/envd/src/acp_client/wire.rs:59-61`). `probe()` reports `AuthStatus::Unknown` because there is no credential-free probe (`crates/envd/src/acp_client/executor.rs:152-154`). | As cited. |
| Capability claims | One fixed feature set for every ACP executor (`capabilities_for`, `crates/envd/src/acp_client/executor.rs:121-135`). | As cited. |
| Digest pinning | None for executables. The only digest in this code is the prompt digest (`DelegatedPrompt::digest_of`, `crates/envd/src/acp_client/delegated_session.rs:536`) [scan]. | As cited. |
| Convars | Five ACP convars: `SV_DELEGATED_DSH_PROGRAM` (`crates/driver/src/delegated_acp.rs:47`), `SV_DELEGATED_DSH_ROUTE` (`crates/driver/src/delegated_acp.rs:56`), `SV_DELEGATED_DSH_MODEL` (`crates/driver/src/delegated_acp.rs:64`), `SV_DELEGATED_DEVIN_PROGRAM` (`crates/driver/src/delegated_acp.rs:73`), `SV_DELEGATED_GROK_PROGRAM` (`crates/driver/src/delegated_acp.rs:82`). Codex has `SV_DELEGATED_CODEX_PROGRAM` (`crates/driver/src/delegated_host.rs:73`). | As cited. |
| Host and registry | `ExecutorRegistry` is built by `from_ctx`, which seeds Codex and then extends with the enabled ACP executors (`crates/driver/src/delegated_host.rs:139-148`). `ExecutorKind` is a closed enum (`crates/driver/src/delegated_host.rs:16-22`). | As cited. |
| Not installed | An id the registry does not hold is `UnknownExecutor` (`crates/driver/src/delegated_host.rs:174`, returned at `crates/driver/src/delegated_host.rs:356`). | As cited. |

### 0.4 Vendor strings in core crates

A case-insensitive whole-word scan of the pinned HEAD for `devin|dsh|grok|codex|claude|gemini|opencode|antigravity|agy` over `crates/` finds 2712 hit lines in 309 files [scan]. Every hit is classified; the method and the full tables are in Appendix A.5.

| Class | Lines | Meaning |
|---|---|---|
| API-PROVIDER | 1383 | Model ids, provider catalogs and codecs, usage and account labels [scan] |
| FALSE-POSITIVE / DOC | 676 | Comments and Markdown [scan] |
| FALSE-POSITIVE / TEST | 339 | Tests and fixtures [scan] |
| FALSE-POSITIVE / FORMAT-COMPAT | 192 | Readers of vendor on-disk formats: Claude plugins and hooks, session import, OpenCode MCP config [scan] |
| FALSE-POSITIVE / UI | 31 | Labels and palette entries [scan] |
| FALSE-POSITIVE / IDENT | 3 | Local variable names [scan] |
| VENDOR-CLI | 88 | Launches, configures or speaks to a vendor CLI process [scan] |

Only 8 files carry VENDOR-CLI lines [scan]:

| File | Lines | Verdict |
|---|---|---|
| `crates/driver/src/delegated_acp.rs` | 35 | VIOLATION: ACP launch profiles written as Rust [scan] |
| `crates/driver/src/delegated_host.rs` | 15 | ALLOW, expiring: Codex exception glue (Q2) [scan] |
| `crates/envd/src/codex_app_server/executor.rs` | 10 | ALLOW: owner exception [scan] |
| `crates/envd/src/codex_app_server/policy.rs` | 8 | ALLOW: owner exception [scan] |
| `crates/envd/src/codex_app_server/session.rs` | 8 | ALLOW: owner exception [scan] |
| `crates/envd/src/codex_app_server/tests.rs` | 8 | ALLOW: owner exception [scan] |
| `crates/envd/src/codex_app_server/wire.rs` | 3 | ALLOW: owner exception [scan] |
| `crates/envd/src/codex_app_server/mod.rs` | 1 | ALLOW: owner exception [scan] |

- The generic ACP client is clean in code: `crates/envd/src/acp_client` names vendors only in comments (14) and tests (18), 32 hits in 5 files, and `crates/app/src/acp_client.rs` has none [scan].
- No core code spawns a vendor binary by literal name. The one spawn-style hit with a vendor literal is a test fixture (`AcpExecutor::new("agent", ["acp"])`, `crates/envd/src/acp_client/tests.rs:661`) [scan].
- Vendor-derived knowledge hides in generic code under neutral names, where a name scan cannot find it. `MISSING_LOGIN_CODE` and `MISSING_LOGIN_DATA` (`crates/envd/src/acp_client/wire.rs:59-61`) match Grok's signed-out reply (`no auth method id provided`, `docs/research/acp-handshakes/README.md:77`). `AgentStoppedParams` is the shape of Devin's notice (`crates/envd/src/acp_client/wire.rs:533-541`). The manifest's `[auth]` tables (§1.3) move the signature values into data; the notice shape stays in core as the documented contract of `[auth.login_notice]`.
- Format-compatibility readers (192 lines) are not launch wiring and are outside this design; Q4 asks whether the vendor rule should ever cover them [scan].

### 0.5 Constraints from the current host

- The delegated-run host has no production caller at the pinned HEAD: `ExecutorRegistry` (`crates/driver/src/delegated_host.rs:131-148`) and `run_delegated_turn` are referenced only inside their own file and in documents [scan], UNVERIFIED(U1).
- `ExecutorKind` is a closed enum whose ACP variant holds an `AcpExecutor` (`crates/driver/src/delegated_host.rs:98-102`). [design] Extension profiles therefore produce `AcpExecutor` values and need no new variant.
- Registration order is asserted as `[DSH_ID, DEVIN_ID, GROK_ID]` (`crates/driver/src/delegated_acp.rs:209-219`). [design] Extension-sourced executors need a defined order (§2.3).
- The Codex program convar defaults to `Str::new_static("codex")` while every ACP convar defaults to empty (`crates/driver/src/delegated_host.rs:74`).
- `AcpExecutor` has private fields (`crates/envd/src/acp_client/executor.rs:43-49`). [design] A parity test needs a read-only view of program, arguments, environment and profile.

## 1. Launch-profile manifest

### 1.1 Decision and rationale

[design] A launch profile is a **static content row** of a new kind, `delegated-agents`. The row sits in the extension's `omp.toml` beside the existing static content kinds `agents`, `lsp-servers` and `dap-adapters`, and points at one TOML file inside the extension's distribution. Core reads that file; the extension never needs to run, provided the new kind is admitted as a static trigger (the P1 lifecycle change below).

Why this vehicle:

- The existing content kinds already declare external programs and agents as signed static data that never boots Python (`dap-adapters`, `docs/py/14-deploy.md:776-782`), with the exact row shape `kind`, `path`, `metadata` (`docs/py/14-deploy.md:728-745`).
- The row's bytes are covered by the wheel's `RECORD` (`docs/py/14-deploy.md:701`), so a profile is part of the signed artifact. Provenance and `trust` are never manifest claims (`docs/py/00-overview.md:468`).
- Static rows are admitted `before Python starts` (`crates/envd/src/exthost/lifecycle.rs:1000-1003`). The registry is built without starting any child, so a profile cannot sit behind a Python import.
- **Correction after review: the trigger mapping must change too.** The lifecycle code maps a row with an empty `trigger` to `ActivationTrigger::Static` only for a closed list of kinds (`credential`, `secret`, `placement`, `skills`, `rules`, `context-files`, `prompts`, `themes`, `agents`, `lsp-servers`, `dap-adapters`); every other kind falls to `_ => ActivationTrigger::FirstReach` (`crates/envd/src/exthost/lifecycle.rs:1088-1096`). Read as written, a `delegated-agents` row with no explicit trigger would therefore be a first-reach row, and an extension carrying only that row could still be activated and run. The claim that such an extension never runs holds only after P1 adds `"delegated-agents"` to that static list, or after the row is required to say `trigger = "static"` (the explicit `"static"` arm at the same site). Which of the two is used is part of P1, and the P1 admission/trigger test in §5.2 proves it.
- The parser change is small but touches more than three places. The core sites are: a content-kind list entry beside `"dap-adapters"` (`crates/ext/src/config.rs:1925-1935`). A dispatch arm goes beside `dap_adapters.push(row.clone())` (`crates/ext/src/config.rs:2210-2212`). One field joins `lsp_servers` and `dap_adapters` in `StaticDeclarations` (`crates/ext/src/config.rs:2096-2099`). The review found further sites that carry the same per-kind list, and each one must either gain the new kind or be explicitly left out: the iterator `StaticDeclarations::rows()` that chains every per-kind vector (`crates/ext/src/config.rs:2279`, with the `dap_adapters` chain at the end); the parse pass that copies `parsed.dap_adapters` into a local vector and assigns it back (`crates/ext/src/config.rs:2179` and `crates/ext/src/config.rs:2236`); the marketplace lowering list of `agents`, `lsp-servers` and `dap-adapters` (`crates/ext/src/marketplace.rs:182-186`); the extension CLI's materialization of marketplace plugins, which writes `.lsp.json` and `.dap.json` (`crates/app/src/ext_cli/service.rs:682`); and the trigger mapping in the lifecycle code named above (`crates/envd/src/exthost/lifecycle.rs:1088-1096`). v1 delivers the kind only through an extension's own `omp.toml`, so the marketplace and CLI-materialization sites are recorded here and may be left out of v1 if the owner prefers; `rows()` and the parse pass cannot be left out, because a row missing from `rows()` is silently never seen.
- **Tier framing, an amendment of ADR 0049's T1 surface.** ADR 0049 puts vendor-neutral generic contracts, the `Delegated` adapters and generic protocols in T1 and all vendor integrations in T2 (`docs/adr/0049-tiered-integration-architecture.md:47-48`). A new core manifest kind, `delegated-agents`, with its parser and loader, is a new vendor-neutral contract in core. It is therefore an addition to the T1 surface that ADR 0049 did not list, and it should be recorded as an amendment of ADR 0049, not slipped in as a parser detail. Whether it passes the T1 admission test (names no vendor, and needs one of the listed reasons, `docs/adr/0049-tiered-integration-architecture.md:47`) is an owner question, folded into Q14.
- A research note already prescribes this delivery for per-tool definitions: a static content kind beside `lsp-servers` and `dap-adapters`, projected like `skills` rows (`docs/research/format-registry-options.md:439`; `skills`, `crates/driver/src/discovery/native.rs:85-95`).

Alternatives considered:

| Alternative | Why not |
|---|---|
| A. An executable kind, for example `kind = "delegated-agent"` with a `module`. | Learning a launch line would need a Python import, but the registry is built before any child exists (`crates/envd/src/exthost/lifecycle.rs:1000-1003`). Executable kinds also carry `trigger` and `failure` semantics that make no sense for data (`docs/py/14-deploy.md:715-717`). |
| B. A new top-level `[[delegated_agents]]` table in `omp.toml`. | It bypasses the `path` and `RECORD` coverage that content rows give (`docs/py/14-deploy.md:701`) and adds a second place for wheel-owned static data. [design] |
| C. A Python registration API. | The Python API has no delegated, executor-id or ACP concept [scan], and runtime registration is never authoritative (`crates/envd/src/exthost/lifecycle.rs:1002-1003`). |
| D. An operator-only user file. | It complements this design (`docs/research/format-registry-options.md:439`) but is not a first-party extension path. Tracked as Q13. |

### 1.2 The manifest row and the profile file

[design] The extension declares the row in `omp.toml`. The shape follows the forge manifest (`extensions/forge/omp.toml:1-31`) and the content-row example (`docs/py/14-deploy.md:683-688`):

```toml
id = "omp.acp-example"
name = "Example ACP profile"
version = "0.1.0"
omp_api = 1
description = "Launch profile for the example agent (data only)"
entry = "omp_acp_example"
capabilities = []

[[declarations]]
kind = "delegated-agents"
path = "omp_acp_example/profiles/example.toml"
metadata = { format = "toml", schema = "omp.delegated-agent/1" }

[requires]
python = ">=3.14"
```

The `capabilities` list is empty and that is valid: the key is required (`_REQUIRED_MANIFEST_KEYS`, `scripts/check-extension-conformance.py:155-161`), and `Empty means` the extension can declare and hook only (`docs/py/00-overview.md:460`). The extension runs nothing; core launches the program after an operator approval (§1.5). [design] No new capability token is needed.

The profile file the row points at uses schema `omp.delegated-agent/1`. This example is illustrative, with every key present; the real profiles are in §4:

```toml
schema = "omp.delegated-agent/1"
id = "example"
display_name = "Example Agent"
transport = "acp-stdio"

[executable]
names = ["example-agent"]
args = ["acp"]
expect_sha256 = []

[env]
inherit = ["EXAMPLE_HOME"]
set = { EXAMPLE_PERMISSION_MODE = "read-only" }

[[params]]
name = "route"
description = "Model route, applied only together with model"
default = ""

[[params]]
name = "model"
description = "Model name on the route"
default = ""

[session]
mode = "ask"

[[session.config_options]]
id = "model"
when_all = ["route", "model"]
value_json_array = ["$route", "$model"]

[auth.login_notice]
method = "vendor.example/agent_stopped"
cause = "auth_required"

[[auth.error_signatures]]
code = -32000
data_contains = "no auth method id provided"

[policy]
enforces = "strictest"
on_unmappable = "refuse"

[capability_claims]
features = ["interrupt", "permissions", "streaming_text", "tool_events", "working_directory_inheritance", "resume"]

[evidence]
transcripts = ["docs/research/acp-handshakes/devin-ask-mode.md"]
caveats = ["The sandbox of this agent fails open when it cannot be applied."]
```

### 1.3 Field reference

Each row says what the field does, what core maps it to, and whether it reuses existing machinery or is new.

| Field | Rule | Maps to | Reuse or new |
|---|---|---|---|
| `schema` | Required, `omp.delegated-agent/1`. An unknown value skips the profile (`E-DELEGATED-SCHEMA`). Unknown keys are rejected, as in the minimizer's schema (`docs/research/format-registry-options.md:437`). | The loader (§2.2). | New; the closed-schema pattern is reused. |
| `id` | Required, `^[a-z][a-z0-9-]{0,31}$`. It becomes the executor id (`codex-app-server` is the existing example, `crates/contract/src/delegated/id.rs:4`), must be unique across installed profiles, and `codex-app-server` is reserved. | `ExecutorId`. | New. |
| `display_name` | Required. Shown in approval and doctor output. | UI only. | New. |
| `transport` | Required. v1 accepts `acp-stdio` only; `mcp-stdio`, `mcp-http`, `a2a-http` and `sdk-shim` are reserved (§3). Another value skips the profile (`E-DELEGATED-TRANSPORT`). | In v1 an `AcpExecutor` (`crates/envd/src/acp_client/executor.rs:43-49`). | New. |
| `[executable].names` | Required, at least one. The names the extension expects the program to have. Hints only: it never enables anything (`crates/driver/src/delegated_acp.rs:10-11`). | Doctor and enable hints. | New. |
| `[executable].args` | Required, may be empty. The exact argument vector after the program. Order is significant: `--no-leader` is an option of `grok agent`, and placed after `stdio` it exits with code 2 (`docs/research/acp-handshakes/README.md:84-85`). No templating, at most 512 bytes per argument, no NUL. | `fn new` (`crates/envd/src/acp_client/executor.rs:58-74`). | New. |
| `[executable].expect_sha256` | Optional list of hex SHA-256 digests. It can only narrow: the resolved program must match one entry. Trust comes from the operator's approval, never from this list. | Checked at approval and at open. | New. |
| `[env].inherit` | Names added from OMP's environment through `with_inherited_from` (`crates/envd/src/child_env.rs:111-123`), pattern `^[A-Z][A-Z0-9_]*$`. `with_inherited_from` copies exactly the names it is given and applies no secret filter (`crates/envd/src/child_env.rs:111-123`), so the checks below are new loader checks. Core refuses secret-looking names (the `SECRET_MARKERS` list, `crates/envd/src/child_env.rs:19-22`) with no override: v1 has no way for a profile or an approval to list one, because that would let an extension forward a token and would weaken ADR 0043's rule that OMP never forwards another application's tokens (`docs/adr/0043-native-cli-integration.md:129-131`). Core also refuses every name starting `OMP_`, which OMP reserves for its own plumbing (`OMP_EXT_ENV_SOCKET` is passed to extension hosts, `docs/py/14-deploy.md:2441`). | `ChildEnv`, as the container only. | The container and `SECRET_MARKERS` list are reused. Both refusals are new, and `inherit` handling is new work, not reuse. |
| `[env].set` | Explicit values applied last, so an inherited value cannot weaken them (`The preset is set last`, `crates/driver/src/delegated_acp.rs:164-166`; `with_set`, `crates/envd/src/child_env.rs:125-130`). | `ChildEnv`. | Reused. |
| `[[params]]` | Optional. `name` (`^[a-z][a-z0-9_]{0,31}$`, and `program` is reserved because `sv_delegated_<id>_program` is the enable convar), `description`, `default` (a string, empty by default). Operator-supplied values, never secret and never credentials (R6). Each becomes a dynamic convar `sv_delegated_<id>_<name>` (§2.6). | `register_dynamic_var` (`crates/con/src/ctx.rs:597`). | The mechanism is reused; the naming is new. |
| `[session].mode` | Optional string sent as `session/set_mode` after the session opens. A refusal ends the open with `PolicyUnmappable` (`crates/envd/src/acp_client/delegated_session.rs:210-241`). | `session_mode` (`crates/envd/src/acp_client/delegated_session.rs:54`). | Reused. |
| `[[session.config_options]]` | Ordered. `id` plus exactly one of `value` (a literal) or `value_json_array` (elements literal or `$param`). `when_all` names params that must all be non-empty or the option is skipped. Sent in order as `session/set_config_option` (`crates/envd/src/acp_client/delegated_session.rs:242-258`). | `config_options` (`crates/envd/src/acp_client/delegated_session.rs:56`). | Reused; the two value forms and `when_all` are new and reproduce `dsh_profile` exactly (§4.3). |
| `[auth.login_notice]` | Optional `method` and `cause`. | `LoginNotice` (`crates/envd/src/acp_client/delegated_session.rs:38-43`). | Reused. |
| `[[auth.error_signatures]]` | Optional. An integer `code` and a `data_contains` string: a JSON-RPC error with that code whose data text contains the string means the login is missing. It replaces the Grok-derived constants in generic code (`MISSING_LOGIN_DATA`, `crates/envd/src/acp_client/wire.rs:59-72`) once Grok ships as an extension (§5, P8). Whether `-32000` is ACP's own authentication-required code is UNVERIFIED(U2). | A generalized `is_missing_login`. | New. |
| no `probe_command` | Not supported. OMP never drives a login flow (`AuthRequired`, `docs/adr/0043-native-cli-integration.md:129-131`) and has no credential-free probe (`AuthStatus::Unknown`, `crates/envd/src/acp_client/executor.rs:152-154`). | None. | Excluded by R6. |
| `[policy].enforces` | Required. v1 accepts `strictest` only, the one policy ACP can represent (`ACP_POLICY`, `crates/envd/src/acp_client/policy.rs:21-33`). | `ACP_POLICY`. | New field over an existing rule. |
| `[policy].on_unmappable` | Required. v1 accepts `refuse` only: any other requested policy is `PolicyUnmappable` (`crates/envd/src/acp_client/delegated_session.rs:154-160`). A `[policy.map]` table is reserved for the day a profile can enforce more, UNVERIFIED(U8). | None. | New. |
| `[capability_claims].features` | Optional list of `Feature` names in `snake_case` (`crates/contract/src/delegated/capability.rs:30-50`). The default is the executor's full set, and a profile can only remove features (`capabilities_for`, `crates/envd/src/acp_client/executor.rs:121-135`). | `Capabilities`. | New field over an existing set. |
| `[evidence].transcripts` | Paths to recorded handshake transcripts that justify the policy claim (`recorded handshake transcript`, `docs/adr/0043-native-cli-integration.md:142-144`). Informational: core cannot verify enforcement, UNVERIFIED(U8). Shown at approval. | UI only. | New. |
| `[evidence].caveats` | Strings shown at approval, such as Grok's fail-open sandbox (`crates/driver/src/delegated_acp.rs:21-32`). | UI only. | New. |

### 1.4 Core-owned floors

[design] The loader and the executor enforce these for every profile, and no manifest field can lower them.

| Floor | Rule | Existing mechanism or new work |
|---|---|---|
| Layer | Only client-layer extensions contribute rows. A workspace-layer row is refused (`E-DELEGATED-LAYER`). | The two layers are distinct (`class Layer`, `crates/py/python/omp/__init__.py:295-299`). A workspace extension never obtains a grant, because grants come from the operator and never from a file in the workspace (`docs/py/14-deploy.md:374`). The loader check is new. |
| Approval | A row is inert until an operator approval matches its digest (§1.5). | A new record in the existing grants store (`crates/ext/README.md:18-22`). |
| Environment | The base is the ambient subset, secret-looking names are dropped, `OMP_` names are never inherited, and `[env].set` is applied last. | Existing: `ambient()` (`crates/envd/src/child_env.rs:87`) and `with_set` (`crates/envd/src/child_env.rs:125-130`). New: the `OMP_` rule and the secret refusal for `[env].inherit`, because `with_inherited_from` does not filter (`crates/envd/src/child_env.rs:111-123`). |
| Policy ceiling | Only one policy is representable; any other request is refused. | `ACP_POLICY` (`crates/envd/src/acp_client/policy.rs:21-33`) and `PolicyUnmappable` (`crates/envd/src/acp_client/delegated_session.rs:154-160`). |
| Client capabilities | The handshake sends no client capabilities and no MCP servers, whatever the profile says. | `ClientCapabilities` (`crates/envd/src/acp_client/delegated_session.rs:173`) and `mcp_servers` (`crates/envd/src/acp_client/delegated_session.rs:202`). |
| Arguments | They come from the manifest only. There is no operator or project argument list. The manifest belongs to any installed client-layer extension, and the only gate is the operator's digest approval (§1.5). | The existing rule is `operator-supplied argument list` (`crates/driver/src/delegated_host.rs:12-14`). **Its rationale is not preserved:** that comment keeps an operator from adding a flag that weakens the agent's own sandbox or approval settings, and here an extension author can ship such a flag; core cannot tell. §1.7 states the reframing and the residual risk, and Q18 asks the owner. |
| Claims | Capability claims can only narrow. | `capabilities_for` (`crates/envd/src/acp_client/executor.rs:121-135`). |
| Convars | Archive-only, with no `PROJECT` flag, for dynamic convars too. | `flags: archive` (`crates/driver/src/delegated_acp.rs:3-8`). The test `a_project_cfg_cannot_enable_a_cli_or_change_its_route` must also run against dynamic convars (`crates/driver/src/delegated_acp.rs:222-237`). |
| Credentials | A profile never carries a credential and the executor never reads one. | `It never carries a credential` (`crates/envd/src/acp_client/delegated_session.rs:47-49`). `never reads configuration or credentials` (`crates/envd/src/acp_client/executor.rs:3-11`). |

### 1.5 Executable discovery, approval and digest pinning

A profile moves through four states. Only the last one registers an executor.

1. **Declared.** An installed client-layer extension supplies the row. Nothing runs.
2. **Named.** The operator sets `sv_delegated_<id>_program` to a path or a name. This is today's only enable switch (`crates/driver/src/delegated_acp.rs:10-11`) and stays the only one. The `names` list never enables anything.
3. **Approved.** An approval record exists for this exact profile and this exact program.
4. **Registered.** The executor is built and registered. The executable is spawned when a session opens or a probe runs (`fn probe`, `fn open`, `crates/envd/src/acp_client/executor.rs:155-198`).

[design] The approval key is a SHA-256 digest over the domain tag `omp.delegated-profile.v1` and: the extension id and version, the profile id, the resolved absolute program path, the SHA-256 of the program's bytes, `args`, `[env]`, `[session]`, `[auth]`, `[policy]`, `[capability_claims]` and the `[[params]]` names. Any edit to any of them asks again. The precedent is the plugin-command approval, whose key covers the command, arguments, environment and the contents of every plugin-root file the launch names, so a script edited in place asks again (`crates/ext/README.md:59-69`). Its digest domain is a constant (`DIGEST_DOMAIN`, `crates/ext/src/plugin_command.rs:68`), its store is `CommandApprovals` (`crates/ext/src/plugin_command.rs:577`), and it is queried with `approves` (`crates/ext/src/plugin_command.rs:599`).

- Only the operator writes an approval. Grants originate from the operator and never from a file inside the workspace (`docs/py/14-deploy.md:374`), and every write to the grants file is a locked read-modify-write (`crates/ext/README.md:18-22`).
- Core computes the executable digest when the operator approves, and recomputes it each time a session opens. This is ADR 0043's rule that OMP pins its own digest (`docs/adr/0043-native-cli-integration.md:139-141`). A mismatch refuses the open with `E-DELEGATED-APPROVAL`.
- `expect_sha256` is an extra restriction and never a source of trust.
- A gap between hashing the program and spawning it remains. Spawning by the digested path narrows it but does not close it, UNVERIFIED(U9).
- Which command prompts the operator for the approval is not designed here, UNVERIFIED(U11).

### 1.6 Versioning and failure isolation

- `schema` carries a major version. A profile with an unknown schema is skipped with `E-DELEGATED-SCHEMA`, and keys are closed.
- A bad profile removes that profile only. Other profiles and the extension's other surfaces still load, as an ADMIT rejection removes only the offending extension (`docs/py/00-overview.md:215`). Error codes follow the existing `E-DECL-KIND` style (`docs/py/14-deploy.md:712`).
- Whether a new content kind needs an `omp_api` level change is open: content rows have no `api` field (`docs/py/14-deploy.md:719-721`), UNVERIFIED(U5).
- Whether a content-only extension still needs `python = ">=3.14"` in `[requires]`, which every existing manifest carries (`extensions/forge/omp.toml:30-31`), is open, UNVERIFIED(U12).

### 1.7 Trust model: what changes, what stays, and the residual risk

[design] ADR 0043 says the executable and its arguments come only from an operator-controlled table, never from project configuration (`docs/adr/0043-native-cli-integration.md:137-138`). This design does not keep that rule as written. It reframes it:

- **Before:** the argument vector is Rust code in core, so the operator-controlled table names only the program (`crates/driver/src/delegated_host.rs:12-14`).
- **Proposed:** the argument vector, the inherited environment names and the session settings are **operator-approved, digest-pinned extension data**. An installed client-layer extension supplies them, and they take effect only after an operator approval that covers their digest (§1.5). The program is still named only by the operator (`sv_delegated_<id>_program`).
- **What still holds:** project and workspace configuration cannot supply or change any of it (`E-DELEGATED-LAYER`, `flags: archive` with no project flag); core never forwards tokens or drives a login; the policy ceiling and the capability floors in §1.4.
- **What no longer holds in core:** nothing in core keeps an extension author from shipping an argument that weakens the CLI's own sandbox or approval settings, which is the case the `delegated_host.rs` comment guards against. The `[evidence]` block is informational (U8), so ADR 0043's rule that each profile needs proof before it is enabled (`docs/adr/0043-native-cli-integration.md:134-136`) is **not enforced by core**. It becomes a review and distribution matter plus the operator reading the approval screen.
- **Residual risk, stated plainly:** an operator who approves a profile from a careless or hostile client-layer extension can launch the approved binary with arguments that turn off its own protections, and core will not notice. The digest approval proves which bytes were approved, not that those bytes are safe.

This is an OPEN OWNER QUESTION (Q18). The design does not decide it.

## 2. Core loading and the none-installed case

### 2.1 Data flow

```text
extension wheel (rows and files covered by RECORD)
  omp.toml   [[declarations]] kind = "delegated-agents"   path = ".../profiles/<id>.toml"
      |  admitted before Python starts (ExtensionManifest)
      v
crates/ext/src/config.rs        StaticDeclarations.delegated_agents                       (P1)
      |  path kept inside the extension root, as skills rows are
      v
crates/ext (pure data)          DelegatedProfileSpec: parse, validate, unknown keys denied (P1)
      |
      v
crates/driver/src/delegated_profiles.rs
                                DelegatedProfileSet::load: layer gate, id uniqueness,
                                dynamic convars, approval gate                             (P3a, P3b, P4)
      |
      v
crates/driver/src/delegated_acp.rs      enabled_executors(ctx, &profiles) -> Vec<AcpExecutor>
      |
      v
crates/driver/src/delegated_host.rs     ExecutorRegistry::from_ctx: Codex plus the ACP executors
```

### 2.2 Loader contract

[design] The loader is a new module, `crates/driver/src/delegated_profiles.rs`, over a pure data type that lives in `omp-ext` beside `StaticDeclarations`, so the driver and the lint share one definition.

- Input: the `delegated-agents` rows of every admitted client-layer extension, in manifest order. A row is resolved as `skills` rows are: join the path to the extension's site, canonicalize it, and require the result to stay inside the extension root (`crates/driver/src/discovery/native.rs:78-95`).
- Parse: serde with unknown keys denied, `schema` checked, and the §1.3 rules validated. The result is the pure value `DelegatedProfileSpec`.
- Output: `DelegatedProfileSet { specs, diagnostics }`. Each diagnostic carries a code from §2.5 and the extension id.
- Build: `enabled_executors` takes the set as a parameter. For each spec, in the order of §2.3, it skips a profile whose convar is empty or whose approval is missing, and otherwise builds the same chain the dsh branch builds today: `AcpExecutor::new`, `with_id`, `with_profile` and `with_env` (`crates/driver/src/delegated_acp.rs:104-113`).
- Profile conversion: `spec.acp_profile(ctx)` is a pure function from the spec and the param values to an `AcpProfile`. For the dsh route and model it must return what `fn dsh_profile` returns (`crates/driver/src/delegated_acp.rs:151-162`).
- Environment conversion: `spec.child_env(parent)` applies §1.4 and is a pure function of the spec and the parent environment, like `fn dsh_env` (`crates/driver/src/delegated_acp.rs:167-171`).
- Read-only view: `AcpExecutor` gains an accessor for program, arguments, environment and profile, because the fields are private today (`crates/envd/src/acp_client/executor.rs:43-49`).

### 2.3 Dual-source rules while the built-ins exist (P3a to P7)

1. An approved extension profile with the same id as a built-in shadows it. An unapproved one is ignored and the built-in keeps working, so installing an extension changes nothing until the operator approves it. Each extension PR can then be tested against its own parity test without removing the Rust code.
2. Static convars win. `register_dynamic_var` returns `Duplicate` for a name that already exists (`crates/con/src/ctx.rs:601-603`), so the loader registers a dynamic convar only when `ctx.find` does not know the name (`ctx.find`, `crates/con/src/builtins.rs:47`).
3. Built-ins keep their order `[DSH_ID, DEVIN_ID, GROK_ID]` (`crates/driver/src/delegated_acp.rs:209-219`). Extension-sourced executors are ordered by extension id, then profile id. The parity test asserts the set of ids and not their order (Q11).
4. The parity test builds the built-in executor and the manifest-derived executor from the same convar values and compares program, arguments, environment, session mode, config options and login notice field by field.

### 2.4 None installed

| Situation | Behavior | Evidence |
|---|---|---|
| No `delegated-agents` row is installed. | `enabled_executors` returns an empty list, as today. | `nothing_is_enabled_until_the_operator_names_a_program` (`crates/driver/src/delegated_acp.rs:204-206`). |
| The registry is then built. | It holds the Codex executor only. | `ExecutorKind::Codex` (`crates/driver/src/delegated_host.rs:141`). |
| A caller asks for an id the registry does not hold. | `DelegatedHostError::UnknownExecutor { id }`, as today. [design] The error gains an optional hint built from operator data only: the id asked for, or a `sv_delegated_<id>_program` the operator already set. Core never names a vendor: "no delegated profile `<id>` is installed; install an extension that provides it". | `UnknownExecutor` (`crates/driver/src/delegated_host.rs:174`, `crates/driver/src/delegated_host.rs:356`). |
| A row is installed and the program convar is empty. | Not registered. | `Every program convar defaults to empty` (`crates/driver/src/delegated_acp.rs:10-11`). |
| A row is installed, the convar is set, and no approval matches. | Not registered. [design] The diagnostic `E-DELEGATED-APPROVAL` names the digest to approve. | §1.5. |
| The extension is disabled or removed. | [design] Its rows leave the set on the next load and the registry shrinks. Sessions that are already open keep their executor. | §2.2. |

### 2.5 Failure modes

[design] The codes follow the existing style (`E-DECL-KIND`, `docs/py/14-deploy.md:712`; `E-REPLACE-SCOPE`, `docs/py/14-deploy.md:2568`). Each failure is journaled and affects that profile only.

| Code | Cause | Effect |
|---|---|---|
| `E-DELEGATED-SCHEMA` | Unknown schema, unknown key or invalid value. | The profile is skipped. |
| `E-DELEGATED-PATH` | The row path leaves the extension root or the file is missing. | The profile is skipped. |
| `E-DELEGATED-DUP-ID` | Two installed profiles claim one id, the id is reserved, a param is named `program`, or two full convar names are equal after hyphen folding (§2.6). | Every claimant is skipped and the diagnostic names each extension. There is no silent winner. |
| `E-DELEGATED-LAYER` | The row comes from a workspace-layer extension. | The profile is skipped. |
| `E-DELEGATED-TRANSPORT` | A transport other than `acp-stdio` in v1. | The profile is skipped. |
| `E-DELEGATED-ENV` | An `OMP_` name in `inherit`, or any secret-looking name. There is no override, and the approval cannot list one. | The profile is skipped at load. |
| `E-DELEGATED-APPROVAL` | No approval, or the program or profile digest changed. | The executor is not registered. |

### 2.6 Dynamic convars

- [design] Names are `sv_delegated_<id>_program` for the executable and `sv_delegated_<id>_<param>` for each param, with hyphens in the id written as underscores. **Collision rule:** folding makes distinct inputs equal. The id `foo-bar` with a param `x` gives `sv_delegated_foo_bar_x`, and the id `foo` with a param `bar_x` gives the same name. The loader therefore computes every full convar name after folding, across all installed profiles and the built-ins, and any equal pair removes both profiles with `E-DELEGATED-DUP-ID`. The param name `program` is reserved so that no param can take over `sv_delegated_<id>_program`. Flags are `flags: archive` with no project flag, and the default is the empty string, as today (`crates/driver/src/delegated_acp.rs:70-86`).
- The mechanism exists: `DynamicVarSpec` carries a name, description, type, flags, default and metadata (`crates/con/src/ctx.rs:209-222`), and `register_dynamic_var` installs it (`crates/con/src/ctx.rs:597-618`).
- Extension settings already use it, installed before the child starts (`setting_schemas`, `crates/envd/src/exthost/lifecycle.rs:1022-1024`; `register_extension_setting_convars`, `crates/envd/src/exthost/extensions.rs:121-126`). They are named `ext::<extension>::<key>` (`crates/envd/src/exthost/extensions.rs:118-120`), which cannot produce the existing `sv_delegated_*` names, so this design adds a naming rule over the same mechanism.
- Registration must happen before configuration runs, so archive lines that name these convars parse. An unknown name is a hard error (`ConError::Unknown`, `crates/con/src/builtins.rs:47`). Whether configuration loading can tolerate unknown `sv_delegated_*` lines while profiles register later is open, UNVERIFIED(U6). §6 gives the migration rules.

### 2.7 Reachability

No production code builds the registry at the pinned HEAD, UNVERIFIED(U1), so a profile that loads correctly is exercised only by tests today. [design] P1 to P7 are therefore behavior-preserving by construction, and deleting the Rust profiles (P8) changes no user-visible behavior until a production caller exists. Q12 asks who owns that wiring.

## 3. MCP-server-as-agent, A2A and Agent SDK bridge

### 3.1 What exists and what does not

- MCP as tools exists. `omp.mcp` declares server mounts whose tools become devices (`Model Context Protocol`, `crates/py/python/omp/mcp.py:1-6`). It offers `class Stdio`, `class Http` and `class Sse` transports (`crates/py/python/omp/mcp.py:133`, `crates/py/python/omp/mcp.py:158`, `crates/py/python/omp/mcp.py:183`). Core runs one `Environment-scoped MCP authority` behind it (`crates/envd/src/mcp/mod.rs:1-5`) over a `Common cancellation-aware MCP transport contract` (`crates/envd/src/mcp/transport/mod.rs:1-4`).
- A mounted MCP server is a set of tools the model calls. It is not a `DelegatedExecutor`: the only implementors are ACP, Codex and a mock (§0.2, row 9), so an MCP agent gets no journaled turn events, no policy mapping and no resume.
- A2A has no code and no document [scan].
- The Agent SDK has prose only. ADR 0043 reaches Claude Code through ACP by a bridge that wraps the Agent SDK and needs Node 22 (`claude-agent-acp`, `docs/adr/0043-native-cli-integration.md:124`). It keeps an Agent SDK extension on free-threaded Python as a deferred alternative (`Claude Agent SDK extension`, `docs/adr/0043-native-cli-integration.md:154-155`). A research note records that the SDK specifies a control stream with interrupt and permission messages (`control_request`, `docs/research/native-cli-feasibility.md:31`). The profile for that route is not built.
- OMP never installs a bridge: a missing bridge is reported as unavailable (`docs/adr/0043-native-cli-integration.md:139-140`).

### 3.2 Decision: one envelope, one executor type in v1

[design] The Agent SDK, MCP-server-as-agent and A2A all reach core as **ACP over stdio through a shim**: an executable that the profile points at, which speaks ACP to OMP and the other protocol to the agent. The profile envelope of §1 is the same for all three, and v1 implements one executor type, `AcpExecutor`.

Reasons:

- No new core transport code. `transport = "acp-stdio"` is the only value v1 accepts (§1.3).
- Policy, permissions, journaling and teardown are identical for every route because the ACP client implements `omp_agent::delegated::DelegatedExecutor` once (`docs/adr/0043-native-cli-integration.md:113-115`).
- The Claude route is already specified this way (`docs/adr/0043-native-cli-integration.md:124`).
- Nothing is foreclosed. MCP and the generic protocols are T1 (`docs/adr/0049-tiered-integration-architecture.md:47`), so a native MCP or A2A executor can later live in core without vendor names. Q5 gives the criteria.

### 3.3 The base contract an ACP shim must meet

[design] A shim is any executable that satisfies the following. The left column is what OMP does today, so a shim can rely on it.

| OMP does | A shim must |
|---|---|
| Sends `initialize` with `PROTOCOL_VERSION`, client name `omp` and empty client capabilities (`crates/envd/src/acp_client/delegated_session.rs:165-179`). | Answer `initialize` without requiring any client capability, and advertise `loadSession` only if it can resume. |
| Requires an absolute working directory (`WorkdirNotAbsolute`, `crates/envd/src/acp_client/delegated_session.rs:147-152`). Sends `session/new` with an empty MCP server list (`crates/envd/src/acp_client/delegated_session.rs:202`). | Accept an absolute `cwd` and an empty `mcpServers` array. A shim may require `mcpServers`, as dsh does (`docs/research/acp-handshakes/README.md:91`), because OMP always sends it. |
| Resumes with `session/load` only when the agent advertised `loadSession`, and otherwise fails the resume (`crates/envd/src/acp_client/delegated_session.rs:184-198`). | Report resume support truthfully. |
| Applies the profile's session mode and config options after the session opens (`crates/envd/src/acp_client/delegated_session.rs:210-258`). | Accept `session/set_mode` and `session/set_config_option`, and refuse a mode it cannot honor, which ends the open with `PolicyUnmappable`. |
| Routes agent `session/request_permission` requests to its permission handler (`on_permission`, `crates/envd/src/acp_client/delegated_session.rs:342-359`). The params shape is `RequestPermissionParams` (`crates/envd/src/acp_client/wire.rs:545-552`). | Raise permission requests for every action the policy forbids, even when the wrapped agent `auto-allows` it (`docs/adr/0043-native-cli-integration.md:134-136`). |
| Sends no `authentication step` (`docs/research/acp-handshakes/README.md:99-100`). An unauthenticated agent is `AuthRequired` (`docs/adr/0043-native-cli-integration.md:129-131`). | Signal a missing login with a typed notice or an error signature that the profile declares in `[auth]`, and never ask OMP to drive a login. |
| Refuses every other agent request with `method not supported by this client` (`crates/envd/src/acp_client/delegated_session.rs:360-367`). | Not depend on any client method other than permission requests: no file-system and no terminal calls. |
| Treats `STRICTEST` as the only policy (`crates/envd/src/acp_client/policy.rs:21-33`). | Be the enforcement boundary for the wrapped agent: map read-only, no network and always-ask onto the agent's own settings, and ship a recorded transcript that shows it (§4.5). |

### 3.4 Per-protocol mapping

| Protocol | What the shim maps | Status |
|---|---|---|
| Agent SDK | ACP session onto an Agent SDK session. The existing Node wrapper is the route ADR 0043 names (`claude-agent-acp`, `docs/adr/0043-native-cli-integration.md:124`). A Python SDK extension is the deferred alternative (`Claude Agent SDK extension`, `docs/adr/0043-native-cli-integration.md:154-155`). Vendor terms restrict third-party use of the vendor login (`must not offer claude.ai login`, `docs/research/native-cli-integration.md:35`). ADR 0043 records the owner's acceptance of the residual risk for the ACP route, and the `no-credential-extraction rule stays absolute` (`docs/adr/0043-native-cli-integration.md:146-149`). | The first profile to add after §4. The SDK's own API is UNVERIFIED(U3). |
| MCP server as agent | One ACP session onto one MCP client session, a prompt onto a call of the server's agent tool, streaming onto progress notifications, cancel onto the cancellation notification, and permission requests onto elicitation. | The mapping rests on MCP specification details that are UNVERIFIED(U4). |
| A2A | One ACP session onto an A2A task, streaming onto the task's event stream, and cancel onto task cancellation. | The mapping rests on A2A specification details that are UNVERIFIED(U14). |

The credential rule applies to every row. A shim uses only credentials the operator gave it directly, and never reads, copies or forwards another application's tokens (`docs/adr/0043-native-cli-integration.md:129-131`).

### 3.5 What each protocol shares with §1

All of §1 is shared: executable, arguments, environment, policy, capability claims, auth signals and evidence. Only a native executor would add a transport-specific table. [design] The names `mcp-stdio`, `mcp-http` and `a2a-http` are reserved for `transport`, each with a reserved `[transport.<kind>]` table that gets its own closed schema when a native executor is built. v1 rejects them with `E-DELEGATED-TRANSPORT`.

### 3.6 When to build a native transport instead of a shim

[design] Build a native executor in core only when all three hold: two or more shipped profiles use the protocol; the extra process measurably costs latency or memory; and the client can be written without vendor names. Otherwise keep the shim. Q5 asks the council to confirm the criteria.

## 4. acp-devin, acp-dsh, acp-grok manifests plus the Rust surface they need

### 4.1 Layout

[design] Each extension mirrors the forge package (`extensions/forge/omp.toml:1-31`; its tree holds `omp.toml`, `pyproject.toml`, `src/omp_forge_ext/` and `tests/` [scan]). The profile is data; the entry module is empty and never imported.

```text
extensions/acp-devin/
  omp.toml
  pyproject.toml
  src/omp_acp_devin/__init__.py
  src/omp_acp_devin/profiles/devin.toml
  tests/test_profile.py
```

The conformance script already gates every extension manifest for its required keys and capability tokens, and runs each package's `tests/` with `unittest discover` (`scripts/check-extension-conformance.py:10-24`). A new package is therefore covered by the `check-extensions` recipe with no script change (`justfile:263-268`).

### 4.2 The three `omp.toml` files

```toml
id = "omp.acp-devin"
name = "Devin ACP profile"
version = "0.1.0"
omp_api = 1
description = "Launch profile for the Devin ACP agent (data only)"
entry = "omp_acp_devin"
capabilities = []

[[declarations]]
kind = "delegated-agents"
path = "omp_acp_devin/profiles/devin.toml"
metadata = { format = "toml", schema = "omp.delegated-agent/1" }

[requires]
python = ">=3.14"
```

```toml
id = "omp.acp-dsh"
name = "DeepSeek Harness ACP profile"
version = "0.1.0"
omp_api = 1
description = "Launch profile for the DeepSeek Harness ACP agent (data only)"
entry = "omp_acp_dsh"
capabilities = []

[[declarations]]
kind = "delegated-agents"
path = "omp_acp_dsh/profiles/dsh.toml"
metadata = { format = "toml", schema = "omp.delegated-agent/1" }

[requires]
python = ">=3.14"
```

```toml
id = "omp.acp-grok"
name = "Grok ACP profile"
version = "0.1.0"
omp_api = 1
description = "Launch profile for the Grok ACP agent (data only)"
entry = "omp_acp_grok"
capabilities = []

[[declarations]]
kind = "delegated-agents"
path = "omp_acp_grok/profiles/grok.toml"
metadata = { format = "toml", schema = "omp.delegated-agent/1" }

[requires]
python = ">=3.14"
```

### 4.3 The three profile files

Each file below reproduces what the Rust code does today. The `# span:` lines name the Rust lines each literal comes from, and every literal appears in those lines.

**Devin.** `args`, the session mode and the login notice come from `enabled_executors`, `devin_profile` and the two constants:

```toml
schema = "omp.delegated-agent/1"
id = "devin"
display_name = "Devin"
transport = "acp-stdio"

[executable]
# span: crates/driver/src/delegated_acp.rs:70-76,114-120
names = ["devin"]
args = ["acp"]

[session]
# span: crates/driver/src/delegated_acp.rs:175-184
mode = "ask"

[auth.login_notice]
# span: crates/driver/src/delegated_acp.rs:95-98
method = "_cognition.ai/agent_stopped"
cause = "auth_required"

[policy]
enforces = "strictest"
on_unmappable = "refuse"

[evidence]
transcripts = ["docs/research/acp-handshakes/devin-ask-mode.md", "docs/research/acp-handshakes/devin-no-credential.md"]
```

**DeepSeek Harness.** The environment and the model option need the two data forms that §1.3 adds: `[[params]]` and `value_json_array` with `when_all`.

```toml
schema = "omp.delegated-agent/1"
id = "dsh"
display_name = "DeepSeek Harness"
transport = "acp-stdio"

[executable]
# span: crates/driver/src/delegated_acp.rs:47-50,104-113
names = ["dsh"]
args = ["--profile", "acp"]

[env]
# span: crates/driver/src/delegated_acp.rs:164-171
inherit = ["DSH_HOME"]
set = { DSH_PERMISSION_MODE = "read-only" }

[[params]]
name = "route"
description = "dsh model route, such as deepseek-account. Applied only when model is set too."
default = ""

[[params]]
name = "model"
description = "dsh model name on the route, such as deepseek-flash."
default = ""

[[session.config_options]]
# span: crates/driver/src/delegated_acp.rs:151-162
id = "model"
when_all = ["route", "model"]
value_json_array = ["$route", "$model"]

[policy]
enforces = "strictest"
on_unmappable = "refuse"

[evidence]
transcripts = ["docs/research/acp-handshakes/dsh-read-only.md", "docs/research/acp-handshakes/dsh-account-route.md", "docs/research/acp-handshakes/dsh-no-credential.md"]
```

**Grok.** The registration has no profile and no custom environment. The signed-out signature is declared here from P7 and leaves generic code in P8:

```toml
schema = "omp.delegated-agent/1"
id = "grok"
display_name = "Grok"
transport = "acp-stdio"

[executable]
# span: crates/driver/src/delegated_acp.rs:79-86,121-138
names = ["grok"]
args = ["--no-auto-update", "--sandbox", "read-only", "--permission-mode", "default", "agent", "--no-leader", "stdio"]

[[auth.error_signatures]]
# span: crates/envd/src/acp_client/wire.rs:59-61
code = -32000
data_contains = "no auth method id provided"

[policy]
enforces = "strictest"
on_unmappable = "refuse"

[evidence]
transcripts = ["docs/research/acp-handshakes/grok-signed-in.md", "docs/research/acp-handshakes/grok-no-credential.md"]
caveats = ["The built-in sandbox profile warns and continues without enforcement when it fails to apply.", "The read-only profile leaves /tmp, /var/tmp and ~/.grok writable."]
```

Each package ships a test of the same kind, run by the conformance script. The sketch below is the Devin one:

```python
import tomllib
import unittest
from pathlib import Path

PROFILE = Path(__file__).resolve().parents[1] / "src" / "omp_acp_devin" / "profiles" / "devin.toml"


class DevinProfileTest(unittest.TestCase):
    def setUp(self):
        self.profile = tomllib.loads(PROFILE.read_text(encoding="utf-8"))

    def test_schema_and_id(self):
        self.assertEqual(self.profile["schema"], "omp.delegated-agent/1")
        self.assertEqual(self.profile["id"], "devin")

    def test_launch_line_matches_the_recorded_run(self):
        self.assertEqual(self.profile["executable"]["args"], ["acp"])
        self.assertEqual(self.profile["session"]["mode"], "ask")
```

### 4.4 Losslessness ledger

Every behavior of the three Rust profiles, and where it goes. Nothing needs a Python hook (Q9).

| Rust behavior | Evidence | Goes to | Lossless |
|---|---|---|---|
| Executor ids `DSH_ID`, `DEVIN_ID`, `GROK_ID`. | `crates/driver/src/delegated_acp.rs:89-93` | `id` | Yes |
| dsh starts with `["--profile", "acp"]`. | `crates/driver/src/delegated_acp.rs:108` | `[executable].args` | Yes |
| dsh environment: ambient set, `DSH_HOME` inherited, `DSH_PERMISSION_MODE` set last, and the parent cannot loosen it or leak a key. | `crates/driver/src/delegated_acp.rs:167-171`, test `crates/driver/src/delegated_acp.rs:255-273` | `[env]` | Yes. The parity test replays the same parent environment. |
| dsh sends the model as one compact JSON pair, only when both halves are set. | Produced by `fn dsh_profile` (`crates/driver/src/delegated_acp.rs:151-162`). Tested by `dsh_model_is_sent_as_one_compact_json_pair_only_when_both_halves_are_set` (`crates/driver/src/delegated_acp.rs:240-252`). | `[[params]]`, `when_all`, `value_json_array` | Yes, if the evaluator emits the same compact text as `serde_json::to_string`, which is `["deepseek-account","deepseek-flash"]` in the test (`crates/driver/src/delegated_acp.rs:244`). |
| dsh has no login notice, so a missing credential stays an internal error. | `crates/driver/src/delegated_acp.rs:147-150` | No `[auth]` table | Yes |
| Devin asks for the `ask` mode. | `crates/driver/src/delegated_acp.rs:175-178` | `[session].mode` | Yes |
| Devin names its login notice. | `crates/driver/src/delegated_acp.rs:95-98` | `[auth.login_notice]` | Yes |
| Grok starts with eight arguments, and `--no-leader` must come before `stdio`. | `crates/driver/src/delegated_acp.rs:126-135`, `docs/research/acp-handshakes/README.md:84-85` | `[executable].args` | Yes, order preserved |
| Grok has no profile and no custom environment. | `crates/driver/src/delegated_acp.rs:121-138` | No `[session]`, `[env]` or `[auth.login_notice]` | Yes |
| Grok's signed-out reply is recognized by constants in generic code. | `crates/envd/src/acp_client/wire.rs:59-72` | `[[auth.error_signatures]]` | Yes after P8; P7 adds the field and the constants stay until P8 |
| A login notice is decoded into one `cause`. | `AgentStoppedParams` (`crates/envd/src/acp_client/wire.rs:533-541`) | Stays in core as the contract of `[auth.login_notice]` | Yes: the values move and the shape stays |
| Grok's sandbox caveats live in the module comment. | `crates/driver/src/delegated_acp.rs:21-32` | `[evidence].caveats` | Yes |
| All three run under the one ACP policy. | `ACP_POLICY` (`crates/envd/src/acp_client/policy.rs:21`) | `[policy].enforces` | Yes, made explicit |
| All three advertise the same features. | `capabilities_for` (`crates/envd/src/acp_client/executor.rs:121-135`) | The default of `[capability_claims]` | Yes |
| Registration order is `[DSH_ID, DEVIN_ID, GROK_ID]`. | `crates/driver/src/delegated_acp.rs:209-219` | Not data: a loader rule | No (Q11) |
| An empty program convar means not enabled, and the convars are archive-only with no project flag. | `crates/driver/src/delegated_acp.rs:3-11` | Not data: core rules (§1.4, §2.6) | No, by design |

### 4.5 What the Rust side must expose

[design] Everything the extensions need is listed here, with the file that changes and the PR that does it (§5).

| Surface | Where | PR |
|---|---|---|
| Parse the row kind and the profile file into `DelegatedProfileSpec`. | In `omp-ext`: the kind list beside `"dap-adapters"` (`crates/ext/src/config.rs:1925-1935`). The dispatch arm beside `dap_adapters.push(row.clone())` (`crates/ext/src/config.rs:2210-2212`). The field beside `lsp_servers` (`crates/ext/src/config.rs:2096-2099`). The same field in `StaticDeclarations::rows()` (`crates/ext/src/config.rs:2279`) and in the parse-pass re-assignment (`crates/ext/src/config.rs:2179`, `crates/ext/src/config.rs:2236`). The static-trigger entry in the lifecycle mapping (`crates/envd/src/exthost/lifecycle.rs:1088-1096`). The marketplace lowering list (`crates/ext/src/marketplace.rs:182-186`) and the CLI materialization (`crates/app/src/ext_cli/service.rs:682`) are decided in P1 and may be out of scope for v1. A new `crates/ext/src/delegated_agent.rs` holds the spec. | P1 |
| Project rows to contained file paths. | `crates/driver/src/discovery/native.rs`, in the way `skills` rows are projected (`crates/driver/src/discovery/native.rs:85-95`). | P1, P3a |
| Environment floor: refuse `OMP_` names and every secret-looking `inherit` name, with no override. | In `omp-envd`, beside `is_secret_name` (`crates/envd/src/child_env.rs:47-52`). | P3b |
| Profile set, loader and diagnostics. | A new `crates/driver/src/delegated_profiles.rs`. | P3a |
| Build executors from specs. | `enabled_executors` (`crates/driver/src/delegated_acp.rs:102-140`). | P3a |
| Read-only executor view for parity tests. | An accessor over the private fields of `AcpExecutor` (`crates/envd/src/acp_client/executor.rs:43-49`). | P3b |
| Unknown-executor hint. | `UnknownExecutor` (`crates/driver/src/delegated_host.rs:174`, `crates/driver/src/delegated_host.rs:356`). | P3b |
| Dynamic convars. | The loader calls `register_dynamic_var` (`crates/con/src/ctx.rs:597-618`). `omp-con` does not change. | P3a |
| Operator approval keyed by digest. | A new module in `omp-ext` over the grants file, following `CommandApprovals` (`crates/ext/src/plugin_command.rs:577-599`). | P4 |
| Error signatures replace the Grok constants. | `AcpProfile` gains a field (`crates/envd/src/acp_client/delegated_session.rs:51-59`) and `is_missing_login` reads it (`crates/envd/src/acp_client/wire.rs:69-72`). | P7, P8 |
| The vendor-string lint. | A new `tools/lintx/src/lints/vendor_cli.rs`, registered beside `ModelGate` (`tools/lintx/src/lints/mod.rs:14-24`). | P2 |

### 4.6 Evidence each profile starts with

ADR 0043 requires a profile to have proof before it is enabled (`docs/adr/0043-native-cli-integration.md:134-136`). The proofs already exist because these profiles are being moved, not changed.

| CLI | Recorded transcripts at the pinned HEAD | What ADR 0043 records |
|---|---|---|
| Devin | `devin-ask-mode.md`, `devin-accept-edits-mode.md`, `devin-no-credential.md` | `session/set_mode ask` declines the write itself and cancel ends `cancelled` (`docs/adr/0043-native-cli-integration.md:121`). |
| dsh | `dsh-read-only.md`, `dsh-account-route.md`, `dsh-no-credential.md` | Shell write denied and the permission request denied under `DSH_PERMISSION_MODE=read-only` (`docs/adr/0043-native-cli-integration.md:120`). |
| Grok | `grok-signed-in.md`, `grok-no-credential.md` | Local gate runs, with the redacted transcript not yet published (`docs/adr/0043-native-cli-integration.md:122`). |

The eight transcripts and a README sit in `docs/research/acp-handshakes/` [scan]. The vendor behaviors they record, such as Grok's sandbox that `fails open` (`crates/driver/src/delegated_acp.rs:21-32`) and the placement of `--no-leader` (`docs/research/acp-handshakes/README.md:84-85`), are recordings and vendor statements, not guarantees. The README lists what was unverified when it was written (`Not verified`, `docs/research/acp-handshakes/README.md:112-121`), UNVERIFIED(U10).

## 5. PR sequence with named proofs and the conformance check

### 5.1 Ground rules and how proofs run

- [design] Each PR is about 400 changed lines or fewer, can be reverted on its own, and preserves behavior until P8.
- The repo's commands are the proof entry points. `justfile` is the source of truth (`AGENTS.md:77`). Iterate with `just check-pkg <pkg>` and `just test-pkg <pkg>` (`AGENTS.md:80-81`), offload with `just remote-test-pkg <pkg>` (`AGENTS.md:90-92`), and broaden with `remote-heavy` (`justfile:154-157`). Extension conformance is `check-extensions` (`justfile:263-268`) and the lint engine's own tests are `lintx-test` (`justfile:114`).
- The test names below are proposals. Whether these recipes cover every proposed test target is UNVERIFIED(U13).
- A PR that moves code updates ADR 0043's `Status in omp` section, `STATUS.md` and `TASKS.md` in the same change (`Status in omp`, `docs/adr/README.md:40-42`).

### 5.2 The ten PRs (P3 is two parts, P3a and P3b)

| PR | Change | Named proofs | Behavior change |
|---|---|---|---|
| P1 | Schema and parsing. Add the `delegated-agents` kind and `DelegatedProfileSpec` to `omp-ext` (§4.5). | `just test-pkg omp-ext`: `delegated_agents_row_requires_path`, `delegated_agents_row_rejects_escaping_path`, `delegated_profile_parses_the_three_reference_profiles` (the §4.3 files as fixtures), `delegated_profile_rejects_unknown_key`, `delegated_profile_rejects_unknown_schema_and_transport`, `unknown_static_kind_is_still_rejected`, `value_json_array_matches_serde_json_compact_output`, and the floor tests `delegated_profile_rejects_an_argument_over_512_bytes_or_with_nul`, `delegated_profile_rejects_policy_other_than_strictest_refuse` and `delegated_profile_claims_name_only_known_features`. The admission and trigger tests: `delegated_agents_field_is_listed_by_static_declarations_rows` in `omp-ext`, and `delegated_agents_row_gets_a_static_trigger` plus `extension_with_only_a_delegated_agents_row_starts_no_child` in `just test-pkg omp-envd` (`crates/envd/src/exthost/lifecycle.rs:1088-1096`). The second proves the correction in §1.1: without it the row would be a first-reach row. | None: no consumer. |
| P2 | The conformance lint in report mode (§5.3), with the initial baseline. | `just lintx-test`: `vendor_cli_flags_a_seeded_string_literal`, `vendor_cli_ignores_comments_and_test_code`, `vendor_cli_expired_allow_entry_fails`, `vendor_cli_stale_allow_entry_fails`, `vendor_cli_baseline_equals_the_recorded_scan`. `just lintx crates` prints the table of Appendix A.5. | None: report mode exits 0. |
| P3a | Loader with dual-source rules (§2.2 to §2.3, §2.5 and §2.6), build executors from specs, and dynamic convars. Split from the original P3 so each part fits the 400-line rule of §5.1. | `just test-pkg omp-driver` runs `none_installed_equals_today`, `extension_profile_shadows_builtin_with_same_id`, `static_convar_wins_over_dynamic_registration`, `dynamic_convars_are_archive_only_and_project_denied`, `duplicate_id_skips_both`, `hyphen_folded_convar_names_that_collide_skip_both` and `param_named_program_is_refused`. The existing tests `nothing_is_enabled_until_the_operator_names_a_program` and `a_project_cfg_cannot_enable_a_cli_or_change_its_route` stay green unchanged (`crates/driver/src/delegated_acp.rs:204-237`). | None without an installed profile. |
| P3b | The floors that sit beside the loader (split from the original P3 for the 400-line rule): the workspace-layer refusal, the read-only executor view, the `OMP_` and secret refusal for `[env].inherit`, the narrow-only claim check and the unknown-executor hint. | `just test-pkg omp-driver` and `just test-pkg omp-envd` run `workspace_layer_row_is_refused`, `omp_prefixed_inherit_is_refused`, `secret_looking_inherit_is_refused_and_no_approval_can_list_it` (secret refusal), `capability_claims_can_only_narrow_the_executor_set` (claims-narrow) and `unknown_executor_hint_names_no_vendor`. | None without an installed profile. |
| P4 | Operator approval keyed by digest (§1.5), and the loader gate. | `just test-pkg omp-ext`: `approval_key_changes_when_any_profile_field_changes` (table-driven over §1.5), `approval_key_changes_when_program_bytes_change`, `approval_requires_operator_origin` (it needs a writer: until the approval command exists, a test-only writer that stands in for the operator drives the store, and the production writer is whichever PR resolves Q16), `unapproved_profile_is_not_registered_and_names_the_digest`, `stale_approval_after_edit_is_refused`. | Only for extension-sourced profiles. |
| P5 | `extensions/acp-devin` and its parity test. | `check-extensions` (one more manifest, `crates/driver/tests/delegated_profile_parity.rs`: `devin_manifest_executor_equals_builtin`), and the package's `DevinProfileTest` (§4.3). | None by construction: the parity test shows the extension-built executor equals the built-in one (§2.3 rule 4). |
| P6 | `extensions/acp-dsh`. | `dsh_manifest_executor_equals_builtin_for_neither_route_only_model_only_and_both`, `dsh_environment_cannot_be_loosened_by_the_parent_for_the_manifest_profile` and `check-extensions`. The second reruns `dsh_environment_cannot_be_loosened_by_the_parent` (`crates/driver/src/delegated_acp.rs:255-273`) on the manifest-derived environment. | None |
| P7 | `extensions/acp-grok`, and `error_signatures` on `AcpProfile` beside the existing constants. | `grok_manifest_executor_equals_builtin`, `declared_error_signature_marks_login_required`, `check-extensions`. | None: the generic constants stay (`crates/envd/src/acp_client/wire.rs:59-72`). |
| P8 | **Gated on Q12 and Q16.** P8 does not start until the owner has answered Q12 (who wires the registry into production, U1) and Q16 (which command writes the approval, U11), and the approval command and a production registry caller exist or are explicitly accepted as missing. P8 makes the approval mandatory, and without a writer for it and a caller of the registry no operator could enable anything. Delete the Rust profiles: `dsh_profile`, `devin_profile`, `dsh_env`, the Grok registration, the ids, the constants, the five static convars and the Grok constants in generic code. The six tests at `crates/driver/src/delegated_acp.rs:204-285` become loader tests on a neutral fixture profile. The lint flips to deny mode. | `just lintx crates` passes in deny mode with no `violation` entry left, `none_installed_equals_today`, `dynamic_convars_are_archive_only_and_project_denied`, and the parity tests are deleted with the code they compared. | One new operator step per profile, the approval (§1.5), for users who installed the extensions. §6.4 covers users who did not. |
| P9 | Convar migration messages and documentation (§6), and the ADR 0043 status updates. | `legacy_convar_line_without_profile_warns_once_and_names_no_vendor` | Warnings only |
| P10 | The first non-migrated profile, the Agent SDK shim route (§3.4), which needs its own recorded transcript before enabling (`docs/adr/0043-native-cli-integration.md:142-144`). | The recorded transcript and `check-extensions`. CI observes only the second and the transcript file's presence and schema (a fixture test reads the committed transcript and checks that it contains the five required exchanges, `docs/adr/0043-native-cli-integration.md:142-144`). That the transcript was recorded against a real binary in an isolated home is a **manual** proof, attested in the PR description. | New capability, off until approved |

### 5.3 The conformance check: no vendor strings in core outside an allowlist

**Vehicle.** [design] A new rule family in `lintx`, the repo's lint engine, which parses each `.rs` file with `ra_ap_syntax` and runs syntax-level rules clippy cannot express (`ra_ap_syntax`, `tools/lintx/README.md:3-5`). It runs as the `lintx` recipe (`justfile:93-94`). Each family is one module implementing `Lint` (`Lint`, `tools/lintx/README.md:15-17`). The closest precedent is the model-name family, which also forbids names in code and ignores tests (`model-gate`, `tools/lintx/src/lints/model_name.rs:1-20`). It is registered in `all` beside `ModelGate` (`tools/lintx/src/lints/mod.rs:14-24`). Two facts limit that precedent: its scope directory `crates/inference/src` (`SCOPED_DIRS`, `tools/lintx/src/lints/model_name.rs:39-41`) is absent at the pinned HEAD [scan], and the file has no inline tests [scan], UNVERIFIED(U7). A script is the fallback (Q3).

**What it matches.** [design] Identifiers and string literals in non-test `.rs` files, with test code out of scope in the way lintx already defines it (`#[cfg(test)]`, `tests.rs`, `tests/`, `tools/lintx/README.md:61-63`). Each is split into words at non-alphanumeric characters and at lower-to-upper case boundaries. A finding is a word equal, ignoring case, to a denylisted token. Comments are not matched: 676 of the 2712 hits are comments and Markdown [scan], and a vendor name in a comment is not wiring.

**Data.** [design] `tools/lintx/baselines/vendor-cli.toml`, following the committed-baseline pattern of the error-formatting ratchet (`baselines/error-formatting.toml`, `tools/lintx/README.md:68-70`). The token list is the same list the §0.4 scan uses, including `agy`. It holds the denylist and the allowlist. **The format is not the existing one:** `baselines/error-formatting.toml` is a per-crate count ratchet (`core = 1`, `envd = 51`, lowered by `just lintx-ratchet-update`, which refuses to raise a count), while this file is a list of per-glob entries, each with a category, an ADR link and a reason, and has no count. The `lintx-ratchet-update` recipe therefore does not apply to it, and the rule that an entry can only be removed or narrowed is checked by review in v1 unless P2 adds a test for it. An inline escape `// lintx-allow: vendor-cli <reason>` follows the existing one (`lintx-allow`, `tools/lintx/README.md:64-66`).

```toml
tokens = ["devin", "dsh", "grok", "codex", "claude", "gemini", "opencode", "antigravity", "agy"]

[[allow]]
glob = "crates/driver/src/delegated_acp.rs"
category = "violation"
adr = "docs/adr/0043-native-cli-integration.md"
reason = "ACP launch profiles written as Rust"
expires = "2027-03-31"
removed_by = "P8"

[[allow]]
glob = "crates/envd/src/codex_app_server/**"
category = "exception"
adr = "docs/adr/0043-native-cli-integration.md"
reason = "Recorded exception, owner ruling 2026-11-09"
exit = "ADR 0043 Exit 1 or Exit 2"

[[allow]]
glob = "crates/driver/src/delegated_host.rs"
category = "exception"
adr = "docs/adr/0043-native-cli-integration.md"
reason = "Glue for the Codex exception (Q2)"
exit = "with the exception"

[[allow]]
glob = "crates/ai/**"
category = "provider-data"
reason = "Provider codecs and model ids name providers, not CLIs"

[[allow]]
glob = "crates/catalog/**"
category = "provider-data"
reason = "Model and provider catalog data"
```

**Categories.** [design] `violation` must reach zero. `exception` is an owner-recorded exception with an exit condition. `provider-data` is scoped out by glob. The remaining categories are listed per file and each entry needs a reason: `provider-id` (a provider or model id outside the two provider crates), `format-compat` (a reader of a vendor on-disk format, Q4), `ui-label` and `ident`.

**Initial baseline, from the scan.** [scan] Outside `crates/ai` and `crates/catalog`, which hold 729 code lines in 61 `.rs` files, the code lines (comments and tests excluded) number 488 in 73 `.rs` files:

| Category | Files | Where |
|---|---|---|
| `violation` and `exception` | 8 | `crates/driver/src/delegated_acp.rs`, `crates/driver/src/delegated_host.rs` and the six files of `crates/envd/src/codex_app_server` [scan] |
| `provider-id` | 40 | app 8, chat 8, driver 6, observability 4, tui 4, envd 3, agent 2, ext 1, journal 1, session 1, snapcompact 1, tools 1 [scan] |
| `format-compat` | 24 | app 9, ext 4, chat 3, driver 3, envd 3, observability 1, tools 1 [scan] |
| `ui-label` | 11 | chat 8, tui 3 [scan] |
| `ident` | 1 | envd 1 [scan] |

Eleven files carry more than one class [scan]. The baseline is generated once from the scan and reviewed once by the owner. After that an addition needs an ADR link, and an entry can only be removed or narrowed.

**Expiry is machine-checkable.** [design] `expires` is an ISO date (`YYYY-MM-DD`) that the rule compares with the current date, and `removed_by` is a label for readers only (the PR that deletes the code). A date is not what removes the entry, though: an entry whose glob matches no file with a finding is **stale** and fails in deny mode, so P8, which deletes the Rust profiles, must delete the `violation` entry in the same change. Both conditions are checked by the rule's own tests (`vendor_cli_expired_allow_entry_fails`, `vendor_cli_stale_allow_entry_fails`). A label such as `expires = "P8"` is not machine-checkable, because the lint cannot evaluate a PR name. The date is a proposal for the owner.

**Modes.** [design] P2 ships report mode: it prints findings grouped by category and exits 0. P8 flips to deny mode: a finding fails in a file with no entry, in a `violation` entry, in an entry past `expires`, or in a stale entry.

**Fixtures that prove it fails.** [design] Inline source fixtures in the rule's own tests: a seeded `const DEVIN_ID: &str = "devin";` in an unlisted path fails in deny mode; the same line in a `#[cfg(test)]` module and in a comment passes; an entry past `expires` fails; a stale entry fails; and a test asserts that the generated baseline equals the recorded scan (P2's `vendor_cli_baseline_equals_the_recorded_scan`).

**Limits.** [design] The lint reads Rust only, so Cargo feature names, KDL catalogs and Python enums are out of its reach; they hold provider ids and a feature name in the scan [scan]. It also cannot see vendor-derived knowledge under neutral names. `MISSING_LOGIN_DATA` (`crates/envd/src/acp_client/wire.rs:59-61`) is replaced by a profile-declared signature in P8 (§4.4). The `AgentStoppedParams` shape (`crates/envd/src/acp_client/wire.rs:533-541`) stays in core as the documented contract of `[auth.login_notice]`, because a notice must carry a `cause`. A reviewer checks both by hand until then.

### 5.4 Ordering and rollback

- P1 precedes P3a, and P3a precedes P3b. P2 is independent and can land first. P4 precedes any extension PR whose profile is meant to run, because an unapproved profile is inert.
- P5 to P7 are independent of each other. None changes the lint baseline, because the `violation` entry stays until P8.
- P8 is the one-way door. It merges only after P5 to P7 are on the default branch, and only after Q12 and Q16 are answered and their pieces exist (the approval command and a production registry caller). Reverting it restores the Rust profiles, the constants and the lint entry together.

## 6. Convar migration

### 6.1 Inventory

| Convar | Defined today | After P8 |
|---|---|---|
| `sv_delegated_dsh_program` | `SV_DELEGATED_DSH_PROGRAM`, default empty, archive (`crates/driver/src/delegated_acp.rs:47-50`). | Registered at profile load for id `dsh`. |
| `sv_delegated_dsh_route` | `SV_DELEGATED_DSH_ROUTE` (`crates/driver/src/delegated_acp.rs:56-59`). | Registered from the `route` param. |
| `sv_delegated_dsh_model` | `SV_DELEGATED_DSH_MODEL` (`crates/driver/src/delegated_acp.rs:64-67`). | Registered from the `model` param. |
| `sv_delegated_devin_program` | `SV_DELEGATED_DEVIN_PROGRAM` (`crates/driver/src/delegated_acp.rs:73-76`). | Registered at profile load for id `devin`. |
| `sv_delegated_grok_program` | `SV_DELEGATED_GROK_PROGRAM` (`crates/driver/src/delegated_acp.rs:82-85`). | Registered at profile load for id `grok`. |
| `sv_delegated_codex_program` | `SV_DELEGATED_CODEX_PROGRAM`, default `codex` (`crates/driver/src/delegated_host.rs:73-76`). | Unchanged: it belongs to the Codex exception. |

### 6.2 Rules

- [design] Names do not change. Each is `sv_delegated_<id>_program` or `sv_delegated_<id>_<param>`, and the first-party extensions keep the ids `devin`, `dsh` and `grok`, so every name in §6.1 keeps working.
- Meaning does not change: empty is not enabled, the convar is archive-only with no project flag, and a project cfg cannot set it. The existing test must pass for dynamic convars (`a_project_cfg_cannot_enable_a_cli_or_change_its_route`, `crates/driver/src/delegated_acp.rs:222-237`).
- Types and defaults do not change: strings with an empty default (`crates/driver/src/delegated_acp.rs:70-86`).
- The Codex convar is not touched. Its default stays `codex` (`crates/driver/src/delegated_host.rs:74`).

### 6.3 Step by step

1. P3a can register dynamic convars but skips any name that already exists (§2.3 rule 2), so nothing changes.
2. P5 to P7 ship an extension. Installing one changes nothing until the operator approves it, and an approved profile builds the same executor as the built-in (§2.3 rules 1 and 4). The static convar still wins (§2.3 rule 2).
3. P8 deletes the static definitions. The loader has registered dynamic convars since P3a, from static rows it can read before any child starts, and it does so before configuration runs (§2.6), so a line whose profile is installed parses. Only a line whose id has no installed profile can be unknown, and §6.4 covers it. If configuration cannot be ordered after registration, unknown lines are kept aside and re-applied after registration for every profile, UNVERIFIED(U6).
4. P9 adds the migration messages of §6.4.

### 6.4 Legacy lines with no profile installed

After P8, an archive line such as `sv_delegated_devin_program /opt/devin` (`crates/driver/src/delegated_acp.rs:211-215`) names a convar that no profile registered. An unknown name is a hard error (`ConError::Unknown`, `crates/con/src/builtins.rs:47`). [design] This case is only for a line whose id has no installed profile, because §2.6 registers an installed profile's convars before configuration runs. Configuration loading should keep unknown `sv_delegated_*` lines aside, re-apply them once profiles register, and warn once for each line that still has no profile. The warning names the id and no vendor: "`sv_delegated_<id>_program` is set but no delegated profile `<id>` is installed; install an extension that provides it". Whether configuration loading can do this is UNVERIFIED(U6); the fallback is a hard error with the same text.

### 6.5 What an operator sees

| Operator state | Before P8 | After P8, extension installed | After P8, no extension |
|---|---|---|---|
| Archive line naming a program (`sv_delegated_devin_program`, `crates/driver/src/delegated_acp.rs:213`). | The executor registers. | The executor registers after one approval (§1.5). | One warning, nothing registered (§6.4). |
| dsh with route and model set (`sv_delegated_dsh_route`, `crates/driver/src/delegated_acp.rs:56`). | The model option is sent. | The same option is sent (§4.4). | One warning per line. |
| A project cfg sets a program (`ProjectVarDenied`, `crates/driver/src/delegated_acp.rs:234`). | Denied. | Denied. | Not applicable. |
| Nothing set (`nothing_is_enabled_until_the_operator_names_a_program`, `crates/driver/src/delegated_acp.rs:204`). | Nothing registers. | Nothing registers. | Nothing registers. |
| Codex (`SV_DELEGATED_CODEX_PROGRAM`, `crates/driver/src/delegated_host.rs:73`). | Default `codex`. | Unchanged. | Unchanged. |

## 7. Open questions

Each question carries a recommended answer. They go to the council.


**Ratification status (2026-11-16):** the council's unanimous answers on Q1, Q3, Q4, Q6–Q9, Q13 and Q18, plus cross-cutting VO and RO2, remain council recommendations only; the owner ratification checkbox was not selected. They are not owner decisions.

### Q1. Vehicle for the launch-profile manifest

Options: a static content kind beside `agents`, `lsp-servers` and `dap-adapters`; an executable declaration kind with a Python module; or a new top-level table in `omp.toml` (§1.1).

**Recommended:** the static content kind `delegated-agents`. It never boots Python and is covered by the wheel's `RECORD` (`docs/py/14-deploy.md:701`). It needs two arms in the parser (`dap_adapters.push`, `crates/ext/src/config.rs:2210-2212`) plus the other sites listed in §1.1, including the lifecycle trigger mapping (`crates/envd/src/exthost/lifecycle.rs:1088-1096`), which would otherwise give an unknown kind a first-reach trigger.

### Q2. Does the Codex exception cover its driver glue?

ADR 0043 names `envd/src/codex_app_server/*` (`docs/adr/0043-native-cli-integration.md:163`). The vendor-name prohibition names `omp-driver` (`docs/adr/0047-agent-build-execution-model.md:131`). The driver holds the Codex convar, its default program and the executor wiring in `crates/driver/src/delegated_host.rs`, 15 lines [scan].

**Recommended:** yes, as an expiring `exception` entry tied to the same exit conditions (`docs/adr/0043-native-cli-integration.md:166-168`). When either exit is evaluated, move the glue behind a neutral registration function inside the exception module so the driver carries no vendor name.


**Owner decision (2026-11-16, as corrected):** the exception record must state the convar default, the unconditional `ExecutorRegistry::from_ctx` Codex registration, and that removing the exception requires a code change to the unconditional registry initialization. Tie expiry to the existing ADR 0043 exit conditions; reaching an exit alone does not remove always-on code.

### Q3. Vehicle for the conformance check

Options: a lintx rule family, a Python script with data files, or both.

**Recommended:** a lintx rule for Rust files (§5.3), because the engine already has per-family modules, an inline escape and a committed-baseline pattern (`lintx-allow`, `tools/lintx/README.md:64-66`). Do not add a script for v1. Decide separately whether to repair or retire the dormant model-name rule, whose scope directory is absent, UNVERIFIED(U7).

### Q4. Do format-compatibility readers fall under the vendor rule?

Claude plugin and hook readers, session import and the OpenCode MCP config reader name vendors in 192 lines [scan]. They read vendor files and launch nothing.

**Recommended:** no, not in this design. Keep them in the baseline as `format-compat` with a reason each. Let the owner decide separately whether any should be extracted under the T2 definition (`T2 First-party extensions`, `docs/adr/0049-tiered-integration-architecture.md:48`).

### Q5. Native MCP and A2A executors, or shims?

Criteria are in §3.6. A related question is where shims live: Python shims can ship inside an extension wheel, while Node and `.par` bridges are never installed by OMP (`docs/adr/0043-native-cli-integration.md:139-140`).

**Recommended:** shims first, with the three criteria of §3.6 deciding any native executor. Python shims may ship in the wheel. Node and `.par` bridges stay operator-installed, and a missing one is reported as unavailable.


**Owner decision (2026-11-16, as corrected):** keep shims first. Before any native MCP or A2A executor is selected for §3.6 criterion 2, define a measurable benchmark threshold and harness; “measurably costs” without either is not an acceptance criterion.

### Q6. Approval key: reuse the plugin-command domain or add one?

The plugin-command key digests plugin-root file contents under the domain `omp.plugin-command.v2` (`crates/ext/README.md:59-69`).

**Recommended:** a new domain, `omp.delegated-profile.v1`, in the same grants file through a new module. Do not overload the plugin-command key, whose inputs differ.

### Q7. May an operator add arguments?

This question is only about a second, operator-side argument list. The larger question, whether arguments may come from extension data at all, is Q18.

**Recommended:** no. There is deliberately no operator-supplied argument list (`crates/driver/src/delegated_host.rs:12-14`). An operator who needs another launch line installs another profile.

### Q8. May a workspace-layer extension supply a profile?

**Recommended:** no. The executable and its arguments never come from project configuration (`docs/adr/0043-native-cli-integration.md:137-138`), and a workspace extension cannot obtain a grant (`docs/py/14-deploy.md:374`).

### Q9. Does v1 need a Python escape hatch for profiles that are not data?

**Recommended:** no. The ledger in §4.4 shows every behavior of the three profiles fits data or is a core rule. Add a hook only when a real profile fails that ledger.

### Q10. May a profile enable itself by searching `$PATH`?

**Recommended:** no. The explicit convar stays the only enable switch (`crates/driver/src/delegated_acp.rs:10-11`). `[executable].names` only feeds doctor and enable hints.


**Owner decision (2026-11-16):** resolve a bare program name once at approval; hash that file and always start exactly it; re-hash before each start. Existing setups work after one re-approval.

### Q11. Registration order of extension-sourced executors

The built-ins register in the fixed order `[DSH_ID, DEVIN_ID, GROK_ID]` (`crates/driver/src/delegated_acp.rs:209-219`).

**Recommended:** order by extension id, then profile id, and replace the fixed-order assertion with a deterministic-order test that asserts the set of ids. Nothing in this code depends on the order beyond that test.


**Owner decision (2026-11-16, as corrected):** use set-plus-uniqueness assertions, not a fixed vector. The display-caller audit found only a test reading executors in order; preserve deterministic registration and require callers to sort when display order matters.

### Q12. Who wires the registry into production, and does P8 wait?

No production code builds the registry at the pinned HEAD, UNVERIFIED(U1).

**Recommended:** track the wiring as a separate ADR 0043 task. P1 to P7 do not depend on it. **P8 waits for it** and for Q16: P8 makes the approval mandatory (§1.5), and with no production caller of the registry and no approval command nothing could be enabled. P9's messages also need the host, so P9 waits too.


**Owner decision (2026-11-16, as corrected):** U1 is false: `ExecutorRegistry::from_ctx` already exists and is called by `crates/driver/src/adw/production.rs:274`. P1–P7 preserve behavior for this caller. Track the changed registration behavior separately; P8 still waits on approval (Q16) and the Q18 gate.

### Q13. Add an operator-only user file for profiles?

**Recommended:** not in v1. If operators later need private profiles without packaging an extension, reuse the same schema and the same approval gate, as the research note suggests for per-tool definitions (`docs/research/format-registry-options.md:439`).

### Q14. Does a new content kind need an `omp_api` change, do content-only extensions need Python, and is the kind an ADR 0049 T1 amendment?

Content rows have no `api` field (`docs/py/14-deploy.md:719-721`), UNVERIFIED(U5), and every existing manifest requires Python 3.14 (`extensions/forge/omp.toml:30-31`), UNVERIFIED(U12).

**Recommended:** no `omp_api` bump if the host's kind vocabulary is not versioned by API level; if it is, bump it in P1 and say so in the manifest docs. Let a content-only extension omit `[requires].python` when its `entry` is never imported.

The kind is also a new core manifest kind, so it extends the T1 surface of ADR 0049 (§1.1). **Recommended:** record it as an amendment of ADR 0049 (a vendor-neutral contract, `delegated-agents`, in T1) alongside this design's ADR 0043 amendment, and let the owner confirm that it meets the T1 admission test.


**Owner decision (2026-11-16):** `delegated-agents` is host manifest vocabulary in `crates/ext`; vendor profile rows stay in T2 extensions; bump `omp_api`.

### Q15. The gap between hashing the program and spawning it

**Recommended:** hash the canonical path at approval, re-hash immediately before spawn, and spawn by that same path. Accept the narrowed window for v1: it needs an attacker who can replace the program file in between, UNVERIFIED(U9).


**Owner decision (2026-11-16):** resolve a bare program name once at approval; hash that file and always start exactly it; re-hash before each start. Existing setups work after one re-approval.

### Q16. Which command prompts for the approval?

**Recommended:** a subcommand of the existing extension CLI that prints every input of the digest and asks once, with no network access. The surface is not designed here, UNVERIFIED(U11). **P8 is gated on this question** (§5.2): P4's `approval_requires_operator_origin` test uses a test-only writer, and no production writer exists until this is answered.


**Owner decision (2026-11-16, as corrected):** the approval command is a subcommand of the existing `omp ext` CLI (not a separate `omp-ext` command). It prints and approves the complete digest input once, with no network access, and must not add or edit profile data or otherwise grant capabilities.

### Q17. How do archive configs survive the migration?

See §6.4.

**Recommended:** keep unknown `sv_delegated_*` lines aside and re-apply them after profiles register, warning once for lines that still have no profile, UNVERIFIED(U6).


**Owner decision (2026-11-16):** hold skipped `sv_delegated_*` lines, re-apply them after profiles register, and start a program only if its approval digest still matches. The behavior change is "skipped, then re-applied", not "hard error to warning".

### Q18. OPEN OWNER QUESTION: may operator-approved extension data replace the operator-controlled table for arguments?

ADR 0043 requires the executable and its arguments to come only from an operator-controlled table (`docs/adr/0043-native-cli-integration.md:137-138`), and the code comment says why: an operator cannot add a flag that weakens the agent's sandbox (`crates/driver/src/delegated_host.rs:12-14`). This design moves the argument vector, the inherited environment names and the session settings into extension data that is gated only by a digest approval (§1.7). Core does not verify the `[evidence]` block (U8), so ADR 0043's proof-before-enable rule (`docs/adr/0043-native-cli-integration.md:134-136`) is not enforced by core.

The owner must decide whether that reframing is acceptable. The design does not decide it.

**Recommended answer (not a decision):** accept it, with three conditions. (1) The approval screen prints the full argument vector, the environment names and every `[evidence].caveats` string, and asks once, with no default. (2) In v1 only first-party extensions in the monorepo `extensions/` tree supply rows (`ADR 0049 D5`), and `check-extensions` requires a recorded transcript fixture for each one; whether core can recognize a first-party extension at load time is UNVERIFIED(U15). (3) The residual risk in §1.7 is written into ADR 0043. If the owner declines, the fallback is to keep the argument vectors in Rust, which keeps vendor strings in core and so contradicts the owner's direction, or to ship profiles only as operator-supplied files (Q13).

## Appendix A. Evidence ledger

All locations are at the pinned HEAD `5b0cd838c9`. Rows repeat or extend facts cited above and add no new evidence.

### A.1 Core profile facts

Brief line references are marked CONFIRMED or CORRECTED.

| Symbol and location | What it does |
|---|---|
| `fn dsh_profile` (`crates/driver/src/delegated_acp.rs:151`) | Builds dsh's `AcpProfile`: a `model` option holding a compact JSON pair, only when route and model are both set. Brief reference about L151: CONFIRMED. |
| `fn devin_profile` (`crates/driver/src/delegated_acp.rs:175`) | Builds Devin's `AcpProfile`: `ask` mode and a login notice. Brief reference about L175: CONFIRMED. |
| Grok registration (`.with_id(GROK_ID)`, `crates/driver/src/delegated_acp.rs:121-138`) | Eight fixed arguments and an id, with no profile and no environment. Brief reference about L80-136: CORRECTED to the convar at L79-86 and the registration at L121-138. |
| `fn dsh_env` (`crates/driver/src/delegated_acp.rs:167`) | Ambient environment, `DSH_HOME` inherited, `DSH_PERMISSION_MODE` set last. |
| `pub fn enabled_executors` (`crates/driver/src/delegated_acp.rs:102`) | Builds the operator-enabled ACP executors in the fixed order dsh, Devin, Grok. |
| `fn enabled` (`crates/driver/src/delegated_acp.rs:143`) | Turns a program convar into an optional program; empty is none. |
| `SV_DELEGATED_DSH_PROGRAM` (`crates/driver/src/delegated_acp.rs:47`). `SV_DELEGATED_DSH_ROUTE` (`crates/driver/src/delegated_acp.rs:56`). `SV_DELEGATED_DSH_MODEL` (`crates/driver/src/delegated_acp.rs:64`). `SV_DELEGATED_DEVIN_PROGRAM` (`crates/driver/src/delegated_acp.rs:73`). `SV_DELEGATED_GROK_PROGRAM` (`crates/driver/src/delegated_acp.rs:82`). | The five ACP convars; each is a string, empty by default, archive-only. |
| `DSH_ID` (`crates/driver/src/delegated_acp.rs:89`). `DEVIN_ID` (`crates/driver/src/delegated_acp.rs:91`). `GROK_ID` (`crates/driver/src/delegated_acp.rs:93`). | The three executor ids. |
| `DEVIN_STOPPED_METHOD` (`crates/driver/src/delegated_acp.rs:96`). `DEVIN_AUTH_CAUSE` (`crates/driver/src/delegated_acp.rs:98`). | Devin's login notice method and cause. |
| `nothing_is_enabled_until_the_operator_names_a_program` (`crates/driver/src/delegated_acp.rs:204`). `each_enabled_cli_registers_under_its_own_id_in_a_fixed_order` (`crates/driver/src/delegated_acp.rs:209`). `a_project_cfg_cannot_enable_a_cli_or_change_its_route` (`crates/driver/src/delegated_acp.rs:222`). | Tests that pin enablement, order and project-cfg denial. |
| `dsh_model_is_sent_as_one_compact_json_pair_only_when_both_halves_are_set` (`crates/driver/src/delegated_acp.rs:240`). `dsh_environment_cannot_be_loosened_by_the_parent` (`crates/driver/src/delegated_acp.rs:255`). `devin_asks_to_decline_tools_and_names_its_login_notice` (`crates/driver/src/delegated_acp.rs:276`). | Tests that pin dsh's model option and environment, and Devin's mode and notice. |
| `SV_DELEGATED_CODEX_PROGRAM` (`crates/driver/src/delegated_host.rs:73`). `pub struct ExecutorProfile` (`crates/driver/src/delegated_host.rs:81`). `pub fn codex_profile` (`crates/driver/src/delegated_host.rs:88`). | The Codex convar and its profile. |
| `Codex(CodexExecutor)` (`crates/driver/src/delegated_host.rs:101`). `pub struct ExecutorRegistry` (`crates/driver/src/delegated_host.rs:131`). `pub fn from_ctx` (`crates/driver/src/delegated_host.rs:139`). `pub fn get` (`crates/driver/src/delegated_host.rs:154`). | The closed executor enum, the registry and its lookup. |
| `UnknownExecutor` (`crates/driver/src/delegated_host.rs:174`). `UnknownExecutor` (`crates/driver/src/delegated_host.rs:356`). | The error type and its use for an id the registry lacks. |
| `pub struct AcpExecutor` (`crates/envd/src/acp_client/executor.rs:43`). `pub fn with_profile` (`crates/envd/src/acp_client/executor.rs:87`). `pub fn with_env` (`crates/envd/src/acp_client/executor.rs:96`). `pub fn with_id` (`crates/envd/src/acp_client/executor.rs:104`). | The generic ACP executor and its three setters. |
| `fn capabilities_for` (`crates/envd/src/acp_client/executor.rs:122`). `async fn probe` (`crates/envd/src/acp_client/executor.rs:155`). `async fn open` (`crates/envd/src/acp_client/executor.rs:173`). | The fixed feature set, the zero-argument probe, and the spawn at open. |
| `pub struct LoginNotice` (`crates/envd/src/acp_client/delegated_session.rs:38`). `pub struct AcpProfile` (`crates/envd/src/acp_client/delegated_session.rs:51`). `pub struct AcpSessionConfig` (`crates/envd/src/acp_client/delegated_session.rs:63`). | The profile types the manifest maps onto. |
| `request.policy != ACP_POLICY` (`crates/envd/src/acp_client/delegated_session.rs:155`). `ClientCapabilities` (`crates/envd/src/acp_client/delegated_session.rs:173`). `mcp_servers` (`crates/envd/src/acp_client/delegated_session.rs:202`). | The policy check and the empty client capabilities and MCP list. |
| `session/set_mode` (`crates/envd/src/acp_client/delegated_session.rs:213`). `PolicyUnmappable` (`crates/envd/src/acp_client/delegated_session.rs:234`). `session/set_config_option` (`crates/envd/src/acp_client/delegated_session.rs:244`). | The profile's session setup and the refused-mode error. |
| `login_required` (`crates/envd/src/acp_client/delegated_session.rs:339`). `AuthRequired` (`crates/envd/src/acp_client/delegated_session.rs:612`). | The login flag set by the typed notice and its failure mapping. |
| `MISSING_LOGIN_CODE` (`crates/envd/src/acp_client/wire.rs:59`). `MISSING_LOGIN_DATA` (`crates/envd/src/acp_client/wire.rs:61`). `fn is_missing_login` (`crates/envd/src/acp_client/wire.rs:69`). | The generic signed-out signature, which matches Grok's reply. |
| `SetModeParams` (`crates/envd/src/acp_client/wire.rs:514`). `SetConfigOptionParams` (`crates/envd/src/acp_client/wire.rs:524`). `AgentStoppedParams` (`crates/envd/src/acp_client/wire.rs:537`). `RequestPermissionParams` (`crates/envd/src/acp_client/wire.rs:548`). | The wire shapes for session setup, Devin's notice and permission requests. |
| `ACP_POLICY` (`crates/envd/src/acp_client/policy.rs:21`). `fn supported_policies` (`crates/envd/src/acp_client/policy.rs:24`). `fn is_supported` (`crates/envd/src/acp_client/policy.rs:29`). | The one representable policy. |
| `SECRET_MARKERS` (`crates/envd/src/child_env.rs:21`). `AMBIENT_NAMES` (`crates/envd/src/child_env.rs:25`). `fn is_secret_name` (`crates/envd/src/child_env.rs:49`). `pub struct ChildEnv` (`crates/envd/src/child_env.rs:74`). | The environment allowlist and secret rule. |
| `pub fn ambient` (`crates/envd/src/child_env.rs:87`). `pub fn with_inherited_from` (`crates/envd/src/child_env.rs:111`). `pub fn with_set` (`crates/envd/src/child_env.rs:127`). `pub fn apply` (`crates/envd/src/child_env.rs:147`). | The environment builder and its application to a command. |
| `pub enum Feature` (`crates/contract/src/delegated/capability.rs:32`). `pub struct Capabilities` (`crates/contract/src/delegated/capability.rs:143`). | The seven features and the capability record. |
| `pub enum ExecutorError` (`crates/contract/src/delegated/error.rs:95`). `PolicyUnmappable` (`crates/contract/src/delegated/error.rs:137`). `PolicyUnmappable` (`crates/contract/src/delegated/drive.rs:165`). | The error enum and the generic policy refusal. |
| `pub trait DelegatedExecutor` (`crates/contract/src/delegated/executor.rs:123`). `pub enum AuthStatus` (`crates/contract/src/delegated/executor.rs:21`). `pub struct DelegatedPolicy` (`crates/contract/src/delegated/policy.rs:61`). `STRICTEST` (`crates/contract/src/delegated/policy.rs:72`). | The executor trait, auth status and the policy record. |
| `ExecutorId::new_static("codex-app-server")` (`crates/envd/src/codex_app_server/executor.rs:88`). `impl DelegatedExecutor for CodexExecutor` (`crates/envd/src/codex_app_server/executor.rs:117`). | The Codex executor under its recorded exception. |

### A.2 Every `sv_delegated_` hit at the pinned HEAD

The search was `git grep -n sv_delegated_ 5b0cd838c9`: 24 hits in 6 files, the same 6 files when ignored files are included [scan].

| Hit | Kind |
|---|---|
| `sv_delegated_dsh_program` (`crates/driver/src/delegated_acp.rs:47`) | Definition |
| `sv_delegated_dsh_model` (`crates/driver/src/delegated_acp.rs:55`) | Doc comment |
| `sv_delegated_dsh_route` (`crates/driver/src/delegated_acp.rs:56`) | Definition |
| `sv_delegated_dsh_model` (`crates/driver/src/delegated_acp.rs:64`) | Definition |
| `sv_delegated_devin_program` (`crates/driver/src/delegated_acp.rs:73`) | Definition |
| `sv_delegated_grok_program` (`crates/driver/src/delegated_acp.rs:82`) | Definition |
| `sv_delegated_grok_program` (`crates/driver/src/delegated_acp.rs:211`) | Test |
| `sv_delegated_devin_program` (`crates/driver/src/delegated_acp.rs:213`) | Test |
| `sv_delegated_dsh_program` (`crates/driver/src/delegated_acp.rs:216`) | Test |
| `sv_delegated_dsh_program` (`crates/driver/src/delegated_acp.rs:225`) | Test |
| `sv_delegated_dsh_route` (`crates/driver/src/delegated_acp.rs:226`) | Test |
| `sv_delegated_dsh_model` (`crates/driver/src/delegated_acp.rs:227`) | Test |
| `sv_delegated_devin_program` (`crates/driver/src/delegated_acp.rs:228`) | Test |
| `sv_delegated_grok_program` (`crates/driver/src/delegated_acp.rs:229`) | Test |
| `sv_delegated_codex_program` (`crates/driver/src/delegated_host.rs:73`) | Definition |
| `sv_delegated_codex_program` (`crates/driver/src/delegated_host.rs:588`) | Test |
| `sv_delegated_codex_program` (`crates/driver/src/delegated_host.rs:595`) | Test |
| `sv_delegated_dsh_program` (`docs/adr/0043-native-cli-integration.md:120`) | ADR table row |
| `sv_delegated_devin_program` (`docs/adr/0043-native-cli-integration.md:121`) | ADR table row |
| `sv_delegated_grok_program` (`docs/adr/0043-native-cli-integration.md:122`) | ADR table row |
| `sv_delegated_<cli>_program` (`docs/adr/0043-native-cli-integration.md:162`) | The claim that profiles are data |
| `sv_delegated_<cli>_program` (`docs/adr/0049-tiered-integration-architecture.md:133`) | ADR 0049 classification |
| `sv_delegated_<cli>_program` (`docs/adr/STATUS.md:55`) | Status table |
| `sv_delegated_codex_program` (`docs/adr/TASKS.md:179`) | Codex exit check |

### A.3 Reuse against new, for the manifest and the extension machinery

| Element and location | Verdict |
|---|---|
| Top-level keys `id`, `name`, `version`, `omp_api`, `description`, `entry`, `capabilities` and `requires` (`docs/py/00-overview.md:454-466`). | Reuse unchanged. |
| Keys `tools`, `hooks`, `services`, `workers` and `settings` (`docs/py/00-overview.md:461-465`). | Not used by a profile. |
| Row fields `trigger`, `api` and `failure` (`docs/py/14-deploy.md:709-717`); content rows have none of them (`docs/py/14-deploy.md:719-721`). | Executable-row fields stay unused. |
| Content-row shape `kind`, `path`, `metadata` (`docs/py/14-deploy.md:728-745`); `metadata` is preserved verbatim (`docs/py/14-deploy.md:702-704`). | Reuse; `metadata.schema` carries the profile schema name. |
| Content-kind list (`"dap-adapters"`, `crates/ext/src/config.rs:1925-1935`). | Extend with `delegated-agents`. |
| Kind dispatch (`dap_adapters.push(row.clone())`, `crates/ext/src/config.rs:2210-2212`). | Extend by one arm. |
| `StaticDeclarations` fields (`lsp_servers`, `crates/ext/src/config.rs:2096-2099`). | Extend by one field. |
| Closed capability vocabulary (`class Capability`, `crates/py/python/omp/__init__.py:275-292`). | Reuse with an empty list. |
| Required manifest keys (`_REQUIRED_MANIFEST_KEYS`, `scripts/check-extension-conformance.py:155-161`). | Reuse, no script change. |
| Per-package unit-test discovery (`unittest discover`, `scripts/check-extension-conformance.py:10-24`). | Reuse for the profile tests. |
| Extension settings as dynamic convars (`ext::<extension>::<key>`, `crates/envd/src/exthost/extensions.rs:118-120`). | The mechanism is reused; the naming is new. |
| Dynamic convar registration (`register_dynamic_var`, `crates/con/src/ctx.rs:597`). | Reuse. |
| Digest-keyed approval (`CommandApprovals`, `crates/ext/src/plugin_command.rs:577`; `DIGEST_DOMAIN`, `crates/ext/src/plugin_command.rs:68`). | The pattern is reused; the domain is new. |
| Row path projection (`skills`, `crates/driver/src/discovery/native.rs:85-95`). | Reuse for contained paths. |
| Package layout (`entry`, `extensions/forge/omp.toml:1-31`). | Reuse. |
| `omp.mcp` mounts (`async def mount`, `crates/py/python/omp/mcp.py:545`). | Unchanged in v1. |
| A Python API for delegated agents. | None exists [scan]; none is added. |

### A.4 Searches and their results

The commands, in the order of the rows that follow, were run against the pinned commit:

```sh
H=5b0cd838c9
git grep -n -i -w -E 'delegated|executorid|acp' $H -- crates/py/python/omp
git grep -n -i -E 'sha256|digest|checksum|pinned' $H -- crates/driver/src/delegated_acp.rs crates/driver/src/delegated_host.rs crates/envd/src/acp_client crates/envd/src/child_env.rs
git grep -n -i -I -w a2a $H -- crates extensions docs scripts .github
git grep -n -i -I -E 'agent[-_ ]?sdk|claude[-_]agent' $H -- crates extensions docs scripts .github
git grep -n -E 'run_delegated_turn|ExecutorRegistry' $H
git grep -n 'impl .*DelegatedExecutor for' $H -- crates
git ls-tree --name-only $H crates/inference
git ls-tree --name-only $H docs/
git ls-tree --name-only $H docs/research/acp-handshakes/
git grep -n -i -E '(Command::new|which|find_program|ChildTree::spawn|AcpExecutor::new|CodexExecutor::new)\(.*"(claude|codex|devin|dsh|grok|gemini|opencode|antigravity|agy)["/. -]' $H -- crates
git grep -n -E '"(DSH|GROK|CLAUDE|CODEX|GEMINI|DEVIN|OPENCODE|ANTIGRAVITY)_[A-Z0-9_]+"' $H -- crates
git grep -n -E '_cognition\.ai|app-server|agent_stopped' $H -- 'crates/*.rs'
```

| Search | Result |
|---|---|
| 1. The Python extension API for delegated, executor-id or ACP words. | No lines [scan]. |
| 2. Digest, checksum or pin in the profile code. | 7 lines [scan], all the prompt digest and its tests, for example `DelegatedPrompt::digest_of` (`crates/envd/src/acp_client/delegated_session.rs:536`). |
| 3. A2A as a word, text files only. | No lines [scan]. With binary files included there is 1 file, a tarball. |
| 4. Agent SDK. | 21 lines in 7 files [scan]. A system-prompt string (`Claude Agent SDK`, `crates/ai/src/codec/anthropic.rs:83`). ADR 0040 (`omp-claude-bridge`, `docs/adr/0040-remote-build-and-test-execution.md:39`). ADR 0043 (`claude-agent-acp`, `docs/adr/0043-native-cli-integration.md:124`). An audit row (`claude-agent-acp`, `docs/audits/pr-deferred-adr-audit-2026-10-21.md:121`). A parked note (`claude-agent-acp`, `docs/parked/2026-10-10-native-cli-integration-next-steps.md:48`). Two research notes (`control_request`, `docs/research/native-cli-feasibility.md:31`) and (`runs the Claude Code binary`, `docs/research/native-cli-integration.md:35`). |
| 5. Users of `ExecutorRegistry` and `run_delegated_turn` outside their file. | Only documents and generated indexes [scan]: `ExecutorRegistry` (`docs/audits/pr-deferred-adr-audit-2026-10-21.md:117`), `ExecutorRegistry` (`docs/knowledge-base/by-crate/driver.jsonl:54`) and `run_delegated_turn` (`docs/knowledge-base/by-crate/driver.jsonl:56`). |
| 6. Implementors of `DelegatedExecutor`. | 5 lines [scan]: `crates/contract/src/delegated/mock.rs:202`, `crates/envd/src/acp_client/executor.rs:145`, `crates/envd/src/codex_app_server/executor.rs:117` and two test types. |
| 7. `crates/inference` at the pinned commit. | No entries [scan]. |
| 8. `docs/` at the pinned commit. | `adr`, `architecture`, `audits`, `knowledge-base`, `parked`, `py`, `pyx`, `research` and two files; no `design` [scan]. |
| 9. `docs/research/acp-handshakes/`. | A README and 8 transcripts [scan]. |
| 10. A spawn of a vendor literal. | 1 line [scan]: `AcpExecutor::new("agent", ["acp"])` (`crates/envd/src/acp_client/tests.rs:661`), a test fixture. |
| 11. Vendor environment-variable literals. | 15 lines in 7 files [scan]: `DSH_PERMISSION_MODE` (`crates/driver/src/delegated_acp.rs:170`) is one of 6 lines in that file, and the other 6 files hold Claude- and OpenCode-format compatibility code. |
| 12. Vendor protocol-method and adapter literals. | 26 lines in 13 files [scan]: `_cognition.ai/agent_stopped` (`crates/driver/src/delegated_acp.rs:96`), 14 lines in the six files of the Codex app-server module, and comments and tests of generic code. |

### A.5 The vendor-string scan

**Method.** [scan] `git grep -n -I -i -w -E 'devin|dsh|grok|codex|claude|gemini|opencode|antigravity|agy' 5b0cd838c9 -- crates` returns 2712 hit lines in 309 files. Each line gets one class by the first rule that matches: files of the three vendor-CLI areas; test paths; comment and Markdown lines; the two provider crates; 24 files reviewed by hand, none of which launches a vendor CLI (A.4, rows 10 to 12); a vendor on-disk-format pattern; a model-or-provider-id pattern; the UI crates. No hit is left unclassified.

| Crate | API-PROVIDER | DOC | TEST | FORMAT-COMPAT | UI | IDENT | VENDOR-CLI | Total |
|---|---|---|---|---|---|---|---|---|
| catalog | 696 | 171 | 65 | 0 | 0 | 0 | 0 | 932 [scan] |
| ai | 505 | 186 | 26 | 0 | 0 | 0 | 0 | 717 [scan] |
| driver | 12 | 50 | 137 | 50 | 0 | 0 | 50 | 299 [scan] |
| envd | 38 | 55 | 19 | 30 | 0 | 3 | 38 | 183 [scan] |
| app | 34 | 38 | 25 | 65 | 0 | 0 | 0 | 162 [scan] |
| ext | 1 | 86 | 6 | 29 | 0 | 0 | 0 | 122 [scan] |
| chat | 52 | 29 | 8 | 11 | 15 | 0 | 0 | 115 [scan] |
| tui | 17 | 22 | 13 | 1 | 16 | 0 | 0 | 69 [scan] |
| 13 other crates | 28 | 39 | 40 | 6 | 0 | 0 | 0 | 113 [scan] |
| Total | 1383 | 676 | 339 | 192 | 31 | 3 | 88 | 2712 [scan] |

The three areas the brief names:

| Area | Result |
|---|---|
| `crates/envd/src/acp_client/` | 32 hits in 5 files, none of them code: `delegated_session.rs` 1 comment, `executor.rs` 3 comments, `session.rs` 1 comment, `wire.rs` 9 comments, `tests.rs` 18 test lines [scan]. |
| `crates/app/src/acp_client.rs` | 0 hits [scan]. |
| `crates/envd/src/codex_app_server/` | 38 hits in 6 files, all vendor-CLI: `executor.rs` 10, `policy.rs` 8, `session.rs` 8, `tests.rs` 8, `wire.rs` 3, `mod.rs` 1 [scan]. |

### A.6 Initial allowlist and violation list

[scan] Violation list: `crates/driver/src/delegated_acp.rs`, 35 lines, which the extension PRs remove (§5.2, P8). Allowlist, as `exception` entries: the six files of `crates/envd/src/codex_app_server`, 38 lines, and `crates/driver/src/delegated_host.rs`, 15 lines, whose status Q2 asks the council to confirm. Provider-data scope: `crates/ai` and `crates/catalog`, 1649 hit lines of which 729 are code lines in 61 `.rs` files. The remaining per-file categories are in §5.3.

[scan] Vendor names that appear only in comments and tests of generic code, and so are not findings under a code-only rule: 14 comment lines and 18 test lines in `crates/envd/src/acp_client`, and one comment in `crates/contract/src/delegated/id.rs` (`codex-app-server`, `crates/contract/src/delegated/id.rs:4`).

## Appendix B. UNVERIFIED ledger

Every `UNVERIFIED(Un)` tag in this document has exactly one row here.

| Id | Claim | Why it is unverified | How to verify |
|---|---|---|---|
| U1 | No production code builds `ExecutorRegistry` or calls `run_delegated_turn`. | A search of the pinned commit found only the defining file, documents and generated indexes (A.4, search 5). Wiring outside the searched tree cannot be excluded. | Run the app with a profile enabled and trace the host, or search the callers across the repository history. |
| U2 | `-32000` is ACP's own authentication-required code. | It is an external protocol fact. The repo records only Grok's reply (`Authentication required`, `docs/research/acp-handshakes/README.md:77`). | Read the ACP specification at the version the client sends. |
| U3 | The Agent SDK API details that the shim mapping relies on. | It is an external package whose version may have changed by 2026-11. | Read the pinned versions and record them in the profile's `[evidence]`. |
| U4 | The MCP details for agent-style use: progress, cancellation and elicitation. | An external specification. | Read the specification version the MCP client targets. |
| U5 | Whether a new content kind needs an `omp_api` level change. | Content rows carry no `api` field and the documents do not say how kinds are versioned. | Read the host's admission code and test an older host with the new kind. |
| U6 | Whether configuration loading can keep unknown `sv_delegated_*` lines aside. | Only the hard error is observed (`ConError::Unknown`, `crates/con/src/builtins.rs:47`). | Read the archive-load path in `omp-con` and the driver's configuration loading. |
| U7 | That lintx can host the rule, and its test conventions. | The model-name rule is dormant because its scope directory is absent, and it has no inline tests. The engine's other lints were not read. | Read the engine's lint trait and ratchet, and prototype the rule in P2. |
| U8 | That any ACP CLI can enforce more than the strictest policy, and that core can verify a profile's enforcement claim. | ADR 0043 lists this as open (`DelegatedPolicy`, `docs/adr/0043-native-cli-integration.md:152-154`), and core observes only the handshake. | A recorded transcript for each candidate policy. |
| U9 | How large the gap is between hashing the program and spawning it. | The spawn path read here does not bind the digest to the spawned file. | Design review in P4. |
| U10 | The vendor behaviors in the recordings: Grok's fail-open sandbox, `--no-leader` placement and Devin's `ask` mode blocking writes. | They are recordings and vendor statements, and the README lists what it did not verify. | Re-record against the installed binaries. |
| U11 | Which command prompts the operator for an approval. | The extension CLI's approval surface for plugin commands was not read. | Read the extension CLI and the plugin-command approval flow. |
| U12 | Whether a content-only extension needs `[requires].python`. | Every existing manifest has it. | Admit a content-only manifest without it. |
| U13 | That the repo's recipes cover every proposed test target. | The named tests do not exist yet. | Check each target against the recipes when its PR is written. |
| U14 | The A2A specification details that the shim mapping relies on (task, event stream, cancellation). | It is an external specification that may have changed by 2026-11. It was first filed under U3 together with the Agent SDK, which is a different source. | Read the pinned A2A version and record it in the profile's `[evidence]`. |
| U15 | Whether core can tell a first-party extension from a third-party one at load time. | Provenance and trust are never manifest claims (`docs/py/00-overview.md:468`), and no loader check for it was read here. | Read the install and admission code path before Q18's condition (2) is adopted. |
