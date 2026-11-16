# 0043. Native provider CLIs are delegated agent executors, not direct model transports

Status: proposed
Date: 2026-10-10
Area: inference/agents

## Decision proposed

OMP² should integrate official provider CLIs through an explicit delegated-execution boundary. It must not treat every CLI as a raw model provider and must not extract another application's OAuth credentials.

Initial candidate: OpenAI Codex app-server over local stdio or Unix socket. Codex's official JSON-RPC lifecycle and streamed notifications are strong enough for a first adapter. The other CLIs are reached through one ACP client with per-CLI launch profiles (see "Amendment 2026-10-20"), not one adapter each. Every profile stays disabled until a real handshake transcript has been recorded against its binary.

## Boundaries

- Direct API providers continue through `omp-ai` and OMP-managed auth.
- Native CLI execution is CLI-managed auth and CLI-managed agent execution.
- OMP owns process lifecycle, cancellation, timeout, working-directory policy, receipts and normalized events.
- The official CLI owns its provider authentication and internal agent loop.
- No token/key extraction from Keychain, credential files or private caches.
- No generic human-output parser when a structured interface is unavailable.

## Required first slice

1. Trace existing `omp-driver` job/process/executor abstractions.
2. Add a narrow Codex app-server adapter over stdio/Unix socket.
3. Implement initialize, thread start/resume, turn start, streamed event normalization, interrupt and process cleanup.
4. Map approvals and tool events without broadening OMP policy.
5. Add mock JSON-RPC server tests; real authenticated tests remain opt-in.

## Non-goals

- No automatic direct-API/CLI fallback.
- No CLI profile is enabled without a recorded handshake against its real binary (amended 2026-10-20; this replaces "No Claude/Gemini/Antigravity/Grok/Devin implementation without verified official contracts").
- No credential migration or extraction.

## Status in omp

Date: 2026-10-13. Branch `feat/native-cli-codex-adapter`.

Policy: delegating a whole agent loop to an official CLI is permitted (owner
decision, 2026-10-13). The delegated executor receives the exact prompt OMP
would have used for its own agent run — the same rendered system prompt,
instructions and user turn, with the same banded slots — and adds no paraphrase
or rewrite. Permissions fail closed, credentials are never extracted, and the
execution mode is explicit.

Landed:

- CLI-1, `docs/research/native-cli-seams.md`: the seam inventory and reuse
  boundary, with every claim tagged by evidence level.
- Common contract part of CLI-3, `omp_agent::delegated`: capability
  discovery, the normalized event model, the approval mapping, explicit
  execution mode, the exact-prompt type with a verified digest, typed errors,
  and `delegated::mock` with `crates/agent/tests/delegated.rs`.
- Shared process-group teardown, `omp-envd` `child_tree`, used by the MCP stdio
  transport and the Codex adapter.
- CLI-2, the Codex app-server adapter, `omp_envd::codex_app_server`
  (`CodexExecutor`, `CodexSession`; see the crate README): typed JSON-RPC wire
  structs for `initialize`, `thread/start|resume`, `thread/inject_items`,
  `turn/start|interrupt`, lifecycle/delta/item/usage/error notifications and the
  command, file-change and permission approvals; a capped, cancel-safe line
  reader; a non-blocking writer; request/response correlation; exact policy
  mapping with the applied policy reported back; prompt delivery with a digest
  of the bytes written; approvals narrowed to single-use; crash, hang,
  interrupt, kill-the-tree and drop handling on `child_tree`. Tests use an
  in-process mock JSON-RPC peer over in-memory pipes.

Not landed:

- The ACP client and its launch profiles for DeepSeek Harness, Devin, Grok, Antigravity and Claude Code (see the amendment below); Gemini is dropped.
- A production `PermissionResolver` over `ApprovalRoute::request_cancellable`.
- The driver conversion from `ApprovalMode`, `ExecSandboxMode`,
  `SandboxNetworkMode` and `WorkspaceTrust` to `DelegatedPolicy`, and the
  executor's registration in the driver or app (nothing constructs
  `CodexExecutor` yet).
- Wiring a rendered prompt from `CanonicalPromptSource` into a turn.
- A job kind for external agents, a session-to-job token chain, and a receipt
  shape for CLI session ids.
- Opt-in real-CLI tests (CLI-7) and user-facing documentation and
  configuration (CLI-8). No test in this change starts a real `codex`.

Known limits and open questions (feasibility items U2-U5 are still not
answered by a live server; the mock peer encodes the documented/generated
shapes, not observed behavior):

- Login is reported `Unknown`: no probe that avoids credential state exists.
- Codex has no system-prompt field on `turn/start`; system sections are
  injected with `thread/inject_items` as developer messages. A prompt that
  is not system-sections-then-user-sections is rejected as `PromptRewritten`.
- Approval policy `write` and network `scoped` have no exact Codex equivalent
  and are `PolicyUnmappable`.
- Whether the policy in `ThreadStartResponse` is the post-merge effective one
  (U4) is unverified; the adapter trusts it only as far as comparing it with
  the request.

Verification of the delegated-executor contract branch (2026-10-14):

- `cargo check -p omp-agent --lib` passed on that branch.
- Its `cargo clippy -p omp-agent --lib` and contract tests were not completed
  in that environment; the tests still require an observed run before the
  contract can be considered verified.
- Review covered cancellation, fail-closed permission mapping, prompt digest,
  and normalized events. Review is not a substitute for the contract tests.
- The contract branch adds no CLI adapter; the Codex adapter listed above was
  merged separately from `feat/native-cli-codex-adapter`.

## Amendment 2026-10-20: one ACP client with launch profiles

Owner decision. Four of the CLIs expose or have a published bridge for the Agent Client Protocol
(ACP, JSON-RPC over stdio), so OMP builds **one ACP client in `omp-envd`** and gives each CLI a
**launch profile** (executable, arguments, environment, session mode and options, its typed login signal,
the policies it can really
enforce). The client implements `omp_agent::delegated::DelegatedExecutor`, so OMP's permission,
prompt-identity, journaling and teardown rules are identical for every route. This replaces CLI-5
and CLI-6 as separate adapters. It does not replace the delegated boundary or the Codex adapter.

| CLI | Route | Evidence | State |
|---|---|---|---|
| Codex | native app-server adapter (`omp_envd::codex_app_server`) | schema generated by the installed binary | landed |
| DeepSeek Harness (`dsh`) | ACP, `dsh --profile acp` | recorded: shell write denied and the permission request denied under `DSH_PERMISSION_MODE=read-only`; cancel mid-turn ends `cancelled` | built (`omp_driver::delegated_acp`), operator opt-in through `sv_delegated_dsh_program`; a live turn through omp was blocked by an empty DeepSeek account balance |
| Devin | ACP, `devin acp` | recorded: `session/set_mode ask` declines the write itself; cancel ends `cancelled`; signed-out Devin sends a typed `agent_stopped` notice before a bare `-32000` | built, operator opt-in through `sv_delegated_devin_program`; one live turn through omp completed with no write |
| Grok | ACP, `grok --no-auto-update --sandbox read-only --permission-mode default agent --no-leader stdio` | local gate runs (redacted transcript not yet published): the write is blocked outside `/tmp`, `/var/tmp` and `~/.grok`, and a permission request is raised and denied; `--deny` rules did not block it, so they are not used | built, operator opt-in through `sv_delegated_grok_program`. Vendor docs say a built-in sandbox profile that fails to apply continues unsandboxed and that child-network blocking is Linux-only; neither is verified. A live turn through omp was blocked by an upstream rate limit |
| Antigravity | ACP, Google's `agy_acp_server.par` (ACP registry `antigravity-acp` 1.4.1) | registry entry only; the `agy` CLI itself has no ACP flag | profile not built |
| Claude Code | ACP through `@agentclientprotocol/claude-agent-acp`, which wraps the Agent SDK; needs Node 22 | registry and README only | profile not built |
| Gemini CLI | none | Google stopped serving it for individual, AI Pro and AI Ultra accounts on 2026-06-18; Antigravity replaces it | dropped |

Rules for the ACP route:

- OMP spawns the vendor's ACP process and leaves authentication to it. It never reads, copies or
  forwards another application's tokens, and it never drives a login flow; an unauthenticated agent
  is `AuthRequired`.
- The client advertises no `fs` and no `terminal` capability at first, so the agent uses its own
  tools. Serving those through the document authority is a separate, deferred task.
- ACP has no sandbox parameter. Each profile declares only the policies it can enforce and everything
  else is `PolicyUnmappable`. A tool the policy forbids must not run even if the agent auto-allows it;
  each profile needs that proof before it is enabled.
- The executable and its arguments come only from an operator-controlled table, never from project
  configuration.
- Bridges (Node, Google's `.par`) are never installed by OMP. A missing bridge is reported as
  unavailable. OMP computes and pins its own digest for a downloaded binary; the Google registry
  entry publishes none.
- The capability gate becomes a recorded handshake transcript per binary (`initialize`,
  `session/new`, one prompt, `session/cancel`, a denied permission) in an isolated home, not the absence
  of any implementation.

Terms of use. Google's FAQ and Anthropic's terms restrict wrapping their CLIs or reusing their login.
The owner accepts the residual risk for the ACP route, on the basis that Google and Anthropic publish
ACP surfaces themselves and that OMP only spawns the vendor's process. This is an owner decision, not a
reading of the terms by this record; OMP's no-credential-extraction rule stays absolute.

Still open: the Claude bridge's licence is `proprietary` in the registry and Apache-2.0 on npm;
whether `agy_acp_server.par` needs a system Python and how it authenticates; whether any profile can
enforce a non-trivial `DelegatedPolicy` (`omp-sandbox` wrapping an arbitrary agent child is
unverified); and a Claude Agent SDK extension on the embedded free-threaded Python 3.14t, kept as a
deferred alternative to the Node bridge.

Task graph: the Kata epic `nkas` (tasks `haza` through `0vgw`).

## Amendment 2026-11-09: placement under ADR 0049

[ADR 0049](0049-tiered-integration-architecture.md) D6 classifies this record's code:
- `envd/src/acp_client/*`, `app/src/acp_client.rs` and `driver/src/delegated_acp.rs` speak the generic ACP protocol, and their CLI launch profiles are already data (`sv_delegated_<cli>_program`). They stay in core as T1.
- **Owner ruling (2026-11-09): `envd/src/codex_app_server/*` stays, as a recorded exception to the vendor rule.**
  - It speaks Codex's own agent-session protocol, not an OpenAI-compatible model API (that API is served by the class B codecs), so adapting it would make nothing generic.
  - An extension would not deliver the same value. It needs a new delegated-executor surface and adds one IPC hop per streamed event. It saves almost no build weight, because spawn, kill, approval mapping and policy stay in core either way.
  - **Exit 1:** a maintained Codex ACP route that loses nothing on the gaps above (system prompt on `turn/start`, approval and network policy mapping). The module is then deleted and Codex becomes an ACP launch profile.
  - **Exit 2:** a delegated-executor extension contract is built for another reason. The module then moves behind it.
  - The exits are checked at ADR 0049 Phase 4.
  - **Phase 4 check (tip `3dba669808`):** both exits fail; the module stays. Exit 1: `delegated_acp.rs` has no Codex profile (only dsh / Devin / Grok); gaps still hold — system text via `thread/inject_items` (`codex_app_server/session.rs`), not a `turn/start` system-prompt field (`wire.rs` `TurnStartParams`); approval `write` and network `scoped` stay `PolicyUnmappable` (`policy.rs` / `session.rs`). Exit 2: no delegated-executor extension contract exists yet (`DelegatedBackend` and the extensions repository remain open). Do not add a fake Codex ACP profile that would regress the gaps.
- This ruling decides placement only. This record's own acceptance is still open.

## Amendment (2026-11-11)

**Owner direction (2026-11-11):** native vendor CLIs are not wired into core, except the recorded exception `envd/src/codex_app_server/*`. Every other vendor CLI route is an extension over ACP, the Agent SDK, MCP or A2A. The design that follows from it is [docs/design/acp-extension-profiles.md](../design/acp-extension-profiles.md); this amendment records the direction and what it changes in this record. Line numbers below are at `5b0cd838c9`.

**Codex exception (2026-11-16):** the owner's decision on what the exception record must state is recorded under Q2 of [the ACP design](../design/acp-extension-profiles.md).

Consequences of this amendment:
- The 2026-11-09 amendment says the CLI launch profiles are already data (`sv_delegated_<cli>_program`, line 162 above). The code does not agree. The dsh, Devin and Grok profiles are Rust: `fn dsh_profile` (`crates/driver/src/delegated_acp.rs:151`), `fn devin_profile` (`crates/driver/src/delegated_acp.rs:175`) and an inline Grok registration (`.with_id(GROK_ID)`, `crates/driver/src/delegated_acp.rs:121-138`). Only the program path is a convar (`sv_delegated_dsh_program`, `crates/driver/src/delegated_acp.rs:47`). Read "profiles are data" as the target and not as the state.
- The target: a launch profile is a signed static `delegated-agents` content row that an extension ships beside `agents`, `lsp-servers` and `dap-adapters` (design §1). Core keeps the generic ACP client, the environment floor, the single policy ACP can represent and an operator-approval gate (design §1.4 and §1.5). With no extension installed nothing registers, as today (design §2.4).
- Most rules of the ACP route in this record are kept: project configuration cannot supply or change a profile; OMP never drives a login flow or forwards another application's tokens (design §1.4 refuses secret-looking and `OMP_` environment names with no override); each profile declares only the policies it can enforce (lines 129-136 above).
- **Two rules are reframed, not kept as written.** (1) The rule that the executable and its arguments come only from an operator-controlled table (lines 137-138 above) becomes: the operator names the program, and the argument vector, environment names and session settings are operator-approved, digest-pinned extension data from an installed client-layer extension. The rationale in `crates/driver/src/delegated_host.rs:12-14`, that an operator cannot add a flag that weakens the agent's sandbox, is not preserved, because an extension author can ship such a flag and core cannot tell. (2) The rule that each profile needs proof before it is enabled (lines 134-136 above) is no longer enforced by core: the design's `[evidence]` block is informational. The residual risk is that an operator can approve a careless or hostile extension's profile and core will not notice. This is an open owner question (design §1.7 and Q18), with a recommended answer that the owner has not accepted.
- A new core manifest kind, `delegated-agents`, is a new vendor-neutral contract in core. It extends the T1 surface of ADR 0049 (`docs/adr/0049-tiered-integration-architecture.md:47-48`) and should be recorded as an amendment of that record. Whether it passes the T1 admission test is an owner question (design Q14).
- The Agent SDK, MCP-server-as-agent and A2A routes reach core as ACP through shims in v1 (design §3). No native MCP or A2A executor is built until the criteria in design §3.6 hold.
- The file `crates/app/src/acp_client.rs` is the editor-facing ACP agent of ADR 0037 and launches no vendor CLI (`ADR 0037`, `crates/app/src/acp_client.rs:1-10`). The 2026-11-09 amendment groups it with `envd/src/acp_client/*` and `driver/src/delegated_acp.rs` as generic ACP code; only those two concern vendor CLIs.
- The `codex_app_server` exception and its two exits stand (lines 163-168 above). Whether its driver glue in `crates/driver/src/delegated_host.rs` is covered is an open question (design Q2).
- Not implemented. The design is a proposal. Its open questions (design §7) go to the council, and this record's own acceptance is still open.

## Amendment (2026-11-12): coverage of the requested vendors, A2A, and a gate on Q18

Owner request, 2026-11-12: a generic ACP client and server with specific profiles only where a vendor needs them (Grok, Antigravity, DeepSeek, Codex, Claude, Cursor, Devin and others), the same for A2A, and extension points for all of it. Most of this is already decided in this record and in `docs/design/acp-extension-profiles.md` (PR #591). Nothing below re-decides it.

| Vendor | Route and status |
|---|---|
| DeepSeek Harness, Devin, Grok | ACP launch profiles; design §4 moves them from Rust code to extension manifests (`acp-dsh`, `acp-devin`, `acp-grok`). Not yet migrated. |
| Antigravity | ACP through Google's `agy_acp_server.par` (registry `antigravity-acp`); listed in this record's profile set (line 70), profile row not in the design's §4 manifests. |
| Claude Code | ACP through the `claude-agent-acp` bridge (Node), or an Agent SDK shim (design §3.1). Profile row not in §4. |
| Codex | Recorded exception: `envd/src/codex_app_server/*` stays, with the two exits above. |
| Cursor | Not named in this record or the design. A Cursor ACP agent is reported by the owner's research; unverified here. A profile needs a recorded handshake first (rule at line 33). |
| A2A, MCP-server-as-agent, Agent SDK | Shims that reach core as ACP over stdio in v1 (design §3.2); a native executor only when the §3.6 criteria are met. The profile `transport` field reserves `a2a-http`. |
| ACP server (OMP as the agent) | An ACP controller surface exists in `crates/app` (proofs in `crates/app/tests/acp_spine.rs`). This record makes no new decision about it. |

**Gate on design Q18 (extension data supplying the argument vector).** Three fresh-context reviewers (EGM personas; see ADR 0053's evidence section) advised deferring acceptance. The design's three conditions are not controls on their own: one depends on a human reading an approval screen, one (first-party only) cannot be enforced because core cannot tell a first-party extension from another, one is documentation. Before Q18 is accepted, core needs these checks, none of which exist today: an enforcement canary at first open (a forbidden write must be denied); an environment allowlist, not a name denylist; a digest covering every file the launch names and the `[evidence]` block; refusal of an interpreter as the program (a Node bridge with `-e` is arbitrary code); and sanitized text on the approval screen. The executor spawns the child with the user's privileges and no OMP sandbox around it (`crates/envd/src/acp_client/executor.rs`, reviewer-cited, not re-read), and a vendor sandbox may fail open (Grok, `crates/driver/src/delegated_acp.rs:21-32`). The decision stays with the owner.


**Ratification status (2026-11-16):** Q18 was one of the unanimous council recommendations. The owner ratification checkbox was left unticked, so this remains a council recommendation and an open gate, not an owner decision.

Where executors are chosen and wired into real work: ADR 0052. Where a delegated agent's work is judged: ADR 0053.
