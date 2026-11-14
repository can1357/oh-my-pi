# 0069. RPC clients: no generated gRPC clients now; the `.proto` sources are the contract, and one documented `protox` command turns them into a descriptor set

Status: Proposed 2026-11-14; machine-reviewed (EGM, 3 rounds), not owner-approved; research and deferral only, no implementation slices
Date: 2026-11-14 (first draft 2026-11-13)
Area: interface

Research: [docs/research/rpc-clients.md](../research/rpc-clients.md) (gap 18 of the upstream gap closure, `docs/research/upstream-gap-closure-brief.md`). This record states a research and deferral decision. It authorizes no implementation. It lists the facts a later client record must settle first. "Machine-reviewed" means three rounds of fresh-context reviewers, with each finding checked against source (see "What the review changed"). No person has approved it. Nothing was built, run or generated for this record.

## Terms

- **OMPv1 / upstream**: the TypeScript implementation at commit `c308970263` (v18.20.0), cited as `upstream:<path>` (read with `git show c308970263:<path>`). **omp2**: this repository. **`registry:`**: the Cargo registry source of a pinned dependency.
- **EGM (Elephant-Goldfish Model)**: the design-review method used for this record. The author drafts; fresh-context ("Goldfish") reviewers see only the document and the files it names.
- **BSR**: the Buf Schema Registry. **WIRE**: the `buf breaking` category that checks tags and types only. **The owner**: the repository owner, who approves ADRs.
- **Daemon**: `omp serve`, the gRPC inference, auth and blob server. **envd**: the project environment daemon. **Session host**: the running `omp chat` process that serves `SessionControl`.
- **P7**: the real-PTY TUI acceptance proof in `crates/e2e/tests/p7_tui.rs`.
- **UNVERIFIED**: not confirmed by source or a run. **[INFERENCE]**: the author's reasoning.

## Context

### Two protocols, not one

- **`omp rpc`, the stdio embedding protocol.**
  - Framing: newline-delimited JSON, one object per line, with protocol-v2 chunk reassembly; 1 MiB per physical line and 64 MiB per reassembled payload (`crates/rpc/src/framing.rs:1-2`, `:15-21`; `crates/app/src/rpc_mode.rs:34`).
  - It is not Content-Length framed. `ContentLengthDecoder` (`crates/rpc/src/framing.rs:159-164`) is unused by `omp rpc`, and commit `0f17146ad` corrected the texts that said otherwise (`crates/rpc/README.md:3`, `:8`; `crates/app/src/cli.rs:1127`).
  - Payloads: serde structs with a `type` discriminator and free-form `serde_json::Value` params (`crates/rpc/src/protocol.rs:1-6`, `:115-125`). There is no schema file.
  - Purpose: it drives an agent session.
- **gRPC, from the `.proto` files.**
  - The daemon serves only on a local endpoint (`crates/app/src/cli.rs:1107-1108`, `:3923-3927`).
  - It serves model access, credentials and blobs, not agent turns.

### What OMPv1 does

- Typed Go, Python and Rust SDKs under `sdk/`, each an `omp-rpc` package, for `omp --mode rpc` over stdio (`upstream:sdk/go/omp-rpc/README.md:3`). The framing and caps are the same as omp2's (`upstream:packages/coding-agent/src/modes/rpc/rpc-frame.ts:5-8`).
- All three are generated from one JSON Schema of 74 commands (`upstream:packages/coding-agent/src/modes/rpc/wire/rpc-wire.schema.json:11`) by `bun run gen:rpc` (`upstream:package.json:161`).
- The Python decoders are lenient (`upstream:sdk/python/omp-rpc/README.md:34-42`):
  - unknown keys are dropped;
  - open records (messages, content blocks, usage, streaming events) check only their discriminator;
  - unmodelled frames arrive as `UnknownNotification`.
- The SDK spawns its own server process in a new session, with the caller's whole environment (`upstream:sdk/python/omp-rpc/src/omp_rpc/client.py:627-642`, `start_new_session=True`, `env={**os.environ, ...}`).
- Upstream has no proto-generated clients. Its SDKs correspond to omp2's `omp rpc`, not to omp2's gRPC.

### What omp2 has

- **Proto inventory.** 19 files, 15 packages, 6 services, 63 RPCs under `crates/proto/proto/omp/`. ADR 0048's Context counts 18 files and 14 packages (`docs/adr/0048-schema-and-serialization-boundaries.md:12`); `omp.session.v1` was added later (commit `1f249d2fa9`).

| Service | File | RPCs | Shapes | Served by |
|---|---|---|---|---|
| `Gateway` | `crates/proto/proto/omp/gateway/v1/gateway.proto:21-25` | 1 | 1 unary (`Hello`) | daemon |
| `ForwardProxy` | `crates/proto/proto/omp/gateway/v1/gateway.proto:29-34` | 1 | 1 server stream | daemon |
| `Auth` | `crates/proto/proto/omp/auth/v1/auth.proto:38-98` | 21 | 20 unary, 1 server stream | daemon |
| `Blob` | `crates/proto/proto/omp/blob/v1/blob.proto:13-25` | 4 | 2 unary, 1 server stream, 1 client stream | daemon |
| `Inference` | `crates/proto/proto/omp/inference/v1/inference.proto:39-114` | 30 | 23 unary, 5 server stream, 2 bidirectional | daemon |
| `SessionControl` | `crates/proto/proto/omp/session/v1/session.proto:16-38` | 6 | 5 unary, 1 server stream | session host |

- **Served surface.** The daemon registers five services, 57 RPCs (`crates/app/src/daemon.rs:403-408`). The session host serves `SessionControl` on an owner-only socket under the data directory (`crates/app/src/chat_cmd.rs:1342-1345`, `crates/driver/src/session_wire.rs:311-331`). That socket has no `Gateway`.
- **Internal packages.** `buf breaking` ignores `control`, `telemetry`, `ui` and `collab` as same-binary or in-memory (`crates/proto/buf.yaml`). `env` is negotiated by envd with its own `MIN_SCHEMA_REV = 4` (`crates/envd/src/server/mod.rs:258`), not by `Gateway.Hello`.
- **Handshake.** A client sends its schema revision; the server answers with its revision and its minimum (`crates/proto/proto/omp/gateway/v1/gateway.proto:43-63`).
  - A client aborts when the server is older than it (`gateway.proto:9-13`, `:55-56`).
  - A client older than the server's minimum is unsupported.
  - The Rust client applies both rules (`crates/rpc/src/hello.rs:101-119`).
  - `SCHEMA_REV` is 29 (`crates/proto/src/lib.rs:51`); the gateway minimum is 1 (`crates/rpc/src/hello.rs:12`).
- **Capabilities.** A client uses an optional surface only when both peers advertise its id. The listed ids are `inference.turn`, `inference.invoke`, `auth`, `blob.v1`, `search` and `media` (`gateway.proto:15-18`). The daemon advertises `auth`, `inference.native` and `gateway.forward` (`crates/app/src/daemon.rs:380-386`).
- **Transport as served.**
  - TCP exists only as plaintext with a bearer token, through `omp auth-gateway serve --bind` (`crates/app/src/auth_gateway_cmd.rs:33-40`); without a token it is refused (`crates/app/src/daemon.rs:417`).
  - `omp-rpc` has TLS helpers (`crates/rpc/src/tls.rs:9-18`) that no crate outside `crates/rpc` calls.
  - Each daemon message is capped at 64 MiB (`crates/app/src/daemon.rs:55-63`).
- **Build and checks.**
  - `build.rs` compiles every `.proto` with the pure-Rust `protox` 0.9.1, never committing output (`crates/proto/build.rs:1-6`, `:46`; `Cargo.toml:205`).
  - CI pins buf 1.73.0 and runs `buf format`, `buf lint` and `buf breaking` (WIRE) against the PR base (`.github/workflows/ci.yml:178-229`).
- **`protox` ships a CLI.** Behind its `bin` feature (`registry:protox-0.9.1/Cargo.toml:93-97`, `[[bin]]` at `:103-106`), it takes `-I/--include`, `-o/--output` (alias `--descriptor_set_out`), `--include_source_info` and `--include_imports`, and writes a `FileDescriptorSet` (`registry:protox-0.9.1/src/main.rs:8-36`, `:41-53`).

### Command overlap (stdio)

Upstream's 74 command names, compared by name with the string patterns of omp2's top-level request `match` (`crates/app/src/rpc_mode.rs:1944-2911`). That match's first arm is `session_startup`, which answers `session_already_started` there (`:1945-1951`); the actor handles a startup frame before the loop (`:156-170`). Field shapes were not compared (UNVERIFIED).

- **47 shared.**
- **27 upstream-only.** Queue editing, slow mode, `goal`, ask dialog, cache warming, subagent cancel and steer, live voice and dictation, session lease, `fork`, `navigate_tree`, branch-summary abort, labels, logout, word prediction, and `btw` (full list in the research note).
- **11 names on the omp2 side that are not upstream commands.**
  - Three are upstream inbound frames: `extension_ui_response`, `host_tool_update`, `host_tool_result` (`RpcInbound`, `upstream:.../rpc-wire.schema.json:5941`).
  - One is `session_startup`.
  - Seven are omp2-only verbs: `approve`, `cancel`, `interrupt`, `pause`, `resume`, `quit`, `shutdown`.

No JSON command is a gRPC RPC. The only gRPC overlap with agent driving is `SessionControl.Submit`. Four of its seven `ControlCommand` verbs are documented as rpc-mode equivalents (`crates/proto/proto/omp/session/v1/session.proto:172-188`).

### Who would use a client

The brief's gap 18 asks for "Generated RPC clients (Go, Python) from the existing proto definitions". Neither the brief nor the research note names a consumer. The parity part of the gap is upstream's stdio SDKs, which correspond to `omp rpc`, not to gRPC.

### Rules that bind

- **ADR 0048 is accepted** (`docs/adr/0048-schema-and-serialization-boundaries.md:4`).
  - Decision 2: git-versioned schemas and no registry. "Every producer and consumer compiles from this workspace" (`:62`). The revisit trigger: "independently released external SDKs consume these `.proto` files (then consider the BSR)" (`:65-67`).
  - Decision 3: Buf is for checks; `buf generate`, BSR remote plugins and generated SDKs are rejected (`:70-77`).
  - Decision 4: WIRE is chosen because no generated code leaves the workspace (`:111-112`).
  - Generated code is never committed (`:12`).
- **Protobuf means `protox`; there is no system `protoc`** (`AGENTS.md:656`).
- **Additive only.** No existing proto, service, Hello response, convar, command or CLI name changes.
- **A gap ADR records; it does not edit other ADRs.**

## Decision

**D1. No generated gRPC client, plugin host, bundle tool or stdio probe is built under this record.** The rounds-1 and 2 slices were removed in round 3 (see "What the review changed"):
- the bundle crate;
- the probe harness;
- the Go and Python clients;
- the conformance suite;
- the plugin host.

**D2. ADR 0048 is respected, not reopened.** This record releases no SDK and no artefact, so ADR 0048 Decision 2's revisit trigger does not fire. A later record that releases generated clients fires it as written, and waits for the owner's answer. This record does not amend ADR 0048.

**D3. The contract is the `.proto` sources in git; the research note documents how to compile them.** The research note's section "Generating from the schema" gives the command. It is one `protox` invocation (the `bin` feature of the workspace's pinned 0.9.1) with `--include_imports` and `--include_source_info`, writing a self-contained descriptor set. `buf build` with the CI-pinned buf works too. Anyone can generate from that descriptor set with their own tools.

Generating is not a supported client path. The project makes no compatibility promise beyond what the daemon enforces at run time:
- the Hello revision rules;
- `buf breaking` at WIRE level, which allows renames that break generated code (ADR 0048 `:111-112`);
- among the packages, only `gateway`, `auth`, `blob`, `inference` and their imports are served by the daemon; `control`, `telemetry`, `ui` and `collab` are internal, and `env` and `session` are negotiated elsewhere.

**D4. Generated gRPC clients are deferred until a consumer is named.** A later record takes them up. It must settle the preconditions below and O1 first.

## Deferred: preconditions for a later gRPC client record

1. **Capabilities.** The daemon does not advertise `blob.v1`, `inference.turn` or `inference.invoke` (`crates/app/src/daemon.rs:380-386` vs `gateway.proto:15-18`). A client that follows the contract cannot use `Blob`. Fixing that changes an existing Hello response (O2).
2. **Transport.** There is no TLS server, and `omp serve` has no TCP. The only TCP endpoint is plaintext bearer, and it exposes all of `Auth`, including `RevealCredential` and `MintScopedToken` (`crates/proto/proto/omp/auth/v1/auth.proto:75`, `:98`).
3. **Compatibility checks.** WIRE allows renames that break published generated code (`crates/proto/buf.yaml`, breaking comment; ADR 0048 `:111-112`).
4. **Release identity.** `SCHEMA_REV` is one manual, global counter (`crates/proto/src/lib.rs:45-51`). Rev 28 to 29 changed only `env.proto` (commit `24ea21e8db`); adding `omp.session.v1` bumped nothing (commit `1f249d2fa9`).
5. **Size limits.**
   - tonic refuses one oversized message with `OUT_OF_RANGE` (`registry:tonic-0.14.6/src/codec/decode.rs:192-195`).
   - The cumulative `Blob.Put` limit answers `RESOURCE_EXHAUSTED` (`crates/serve/src/blob.rs:13-14`, `:142-147`).
   - No credential-free RPC sends a client a message over 4 MiB.
6. **Reference handshake.** The Rust handshake's revision override is private (`crates/rpc/src/hello.rs:85-90`). Its minimum check uses the crate constant (`:109`).
7. **Coverage.** The streaming and bidirectional RPCs need a scripted provider, which today is only the test-only `DaemonHandle::start_for_test` (`crates/app/src/daemon.rs:327`).
8. **Go generation.** No file sets `go_package`. The `thread` and `inference` packages import each other (`crates/proto/proto/omp/thread/v1/thread.proto:5`, `inference/v1/inference.proto:9`), so they must share one Go package (UNVERIFIED).
9. **Distribution and API.**
   - A Go module is fetched from VCS tags or the module proxy, which conflicts with "generated code is never committed" (ADR 0048 `:12`).
   - Each hand-written client layer's public API becomes a compatibility promise.
   - No artefact name may rest on `SCHEMA_REV` alone (item 4).

## Rejected options

| Option | Why not |
|---|---|
| Generate Go and Python gRPC clients now | No named consumer; they do not close the parity gap; publishing them needs the owner rulings in Deferred. |
| A schema bundle tool crate (round 2's S1) | No named consumer either. The sources are already public in git, and `protox`'s own CLI writes the same descriptor set with one command (D3). |
| A committed stdio SDK probe harness (round 2's S0) | It needs a scripted daemon that is test-only, a seeded journal, a trust grant and envd lifetime control. Upstream's SDK also spawns processes outside any Rust owner. The result could not change the adoption choice alone (O4). |
| A `protox`-hosted plugin host, or `buf generate`, for Go | Only a deferred client needs it; `buf generate` is rejected by ADR 0048 Decision 3 (`:74`). |
| `protoc`, or a generator that embeds it | `AGENTS.md:656`. |
| Port upstream's JSON-Schema generator to `omp rpc` | It first needs a schema for free-form `Value` params; very high cost (O5). |
| Add `go_package` to the `.proto` files | It changes shared sources for a deferred need. |

## Slices

None. This record is research and deferral only, and it authorizes no implementation. If a consumer is named and the owner answers O1-O3, a new record defines the slices with acceptance tests: unit tests, crate integration tests, an e2e proof in `crates/e2e` where behaviour is user-visible, and a golden journal where a journal kind changes.

## Upstream origin and license

Nothing is ported, copied or run. Upstream's `LICENSE` is MIT, copyright Mario Zechner, Can Bölük and Stencil Labs, Inc. (`upstream:LICENSE:1-5`); its Python SDK has its own MIT file (`upstream:sdk/python/omp-rpc/LICENSE:1-3`). `protox` is MIT or Apache-2.0 (`registry:protox-0.9.1/Cargo.toml:42`) and is already a dependency. No NOTICE change.

## Consequences

- Nothing in the build, CI or runtime changes.
- Outside users can compile the schema with one documented command, with no project compatibility promise beyond the run-time Hello rules and WIRE checks.
- The gap stays partly open: Go and Python gRPC clients are deferred, and their preconditions are recorded.
- ADR 0048, the daemon's Hello response and the served transports stay as they are.

## Open questions for the owner

- **O1. Scope of gap 18.** Is deferring generated gRPC clients until a named consumer exists acceptable? A later client record fires ADR 0048 Decision 2's trigger (`:65-67`) and needs the owner's answer to it. Recommendation: yes, defer.
- **O2. Hello capabilities.** Should the daemon advertise `blob.v1` and the inference ids that `gateway.proto:15-18` lists, or should the contract text change? This is an existing-server change, so this record does not decide it. Recommendation: decide it before any client record.
- **O3. `SessionControl` and Hello.** The session host's socket has no `Gateway` (`crates/driver/src/session_wire.rs:311-331`), but `session.proto:11-12` says negotiation uses it. Should it be registered there? Recommendation: decide it with O2.
- **O4. Stdio SDK probe, an owner-run measurement.** Does the owner want to know how far upstream's Python SDK works against `omp rpc` (47 shared names)? The result could only support a statement such as "works for the shared commands, unsupported". Adopting upstream's SDKs as supported clients would make upstream's `rpc-wire.schema.json` a compatibility input for omp2, and would leave omp2's seven own verbs untyped. Recommendation: do not adopt them as supported clients; run the probe only if that statement is wanted. Known prerequisites for a run, verified in source:
  - **A scripted daemon.** Today that is only the test-only `DaemonHandle::start_for_test` (`crates/app/src/daemon.rs:327`), wrapped per proof in P7 and P6.
  - **`--envd-idle-timeout`.** The hidden flag "used by isolated acceptance harnesses" (`crates/app/src/cli.rs:1995-1997`; P7 passes `2`). Without it, each `omp rpc` leaves an envd running until its default idle exit.
  - **A seeded journal.** `--session` reopens an existing ULID session strictly (`crates/app/src/cli.rs:1872-1874`); P7 seeds one with `Session::create` (`crates/e2e/tests/p7_tui.rs:912-915`, `:1065-1066`).
  - **A trust grant.** An untrusted workspace clamps explicit Yolo approval to Write (`crates/driver/src/delegated_policy.rs:14-18`). P7 persists a grant (`crates/e2e/tests/p7_tui.rs:1057-1059`). The SDK's first frame is `negotiate_protocol`, so the stdio `session_startup` trust route is not available.

  Known limits of the result:
  - the SDK's decoders are lenient (`upstream:sdk/python/omp-rpc/README.md:34-42`), so a passing command does not mean the field shapes match;
  - the SDK spawns `omp rpc` in its own session with the caller's environment (`client.py:627-642`);
  - a start-up failure would fail every command at once;
  - `bash` under Yolo and `login` have host side effects.

  A run should record its raw output, the omp2 commit and the SDK pin in the research note.
- **O5. A schema for `omp rpc`.** The only route to first-party typed stdio clients is for omp2 to own a schema for `omp rpc`. That was rejected here as very high cost while the params are free-form `Value`. Should it be planned? Recommendation: not now. The Rust `omp-rpc` client (`crates/rpc/README.md:7`) stays the typed client.

## What the review changed

Reviewer texts for each round are kept outside the repository by the orchestrating session. Each entry below states the finding in enough detail to stand alone.

### Round 1 (recorded in STATUS.md row 0069)

- **BSR revisit trigger in ADR 0048 Decision 2.** Confirmed (`docs/adr/0048-schema-and-serialization-boundaries.md:65-67`). The record stopped amending 0048 and quotes the trigger (now D2, O1).
- **`protox`, not `protoc`.** Confirmed (`AGENTS.md:656`). Every `protoc` option was removed; D3's command uses `protox`.
- **S0 needs its own harness.** Confirmed: upstream's suites run fakes (`upstream:sdk/python/omp-rpc/tests/test_client.py:1142-1149`, `upstream:sdk/go/omp-rpc/fake_test.go:21-26`, `upstream:sdk/go/omp-rpc/smoke_test.go:71-73`). A harness was designed in round 1; round 3 removed it (O4).
- **Command overlap recount.** Confirmed, and the old count was wrong. Recounted to 47, 27 and 11 from `rpc-wire.schema.json:11` and `crates/app/src/rpc_mode.rs:1944-2911`, with a per-service RPC table.
- **Server-older-than-client test missing.** Confirmed (`gateway.proto:55-56`, `crates/rpc/src/hello.rs:101-108`). Scenarios were added in round 1. They are deferred with the clients; the rules are in Context.

### Round 2 (blockers 2, majors 19, minors 15)

Resolution: the record was cut to a bundle crate (S1) and a probe (S0), and the clients were deferred.

- **B1, the `MIN_SCHEMA_REV` cycle.** Confirmed (`crates/rpc/src/hello.rs:12`, `crates/rpc/Cargo.toml:16`). The bundle moved to a standalone crate; round 3 then removed it.
- **B2, Hello capabilities.** Confirmed (`gateway.proto:15-18` vs `crates/app/src/daemon.rs:380-386`). Now Deferred item 1 and O2.
- **M1-M3, M10, M16, size and conformance.** Confirmed against `crates/serve/src/blob.rs:13`, `:142-147`, tonic `codec/decode.rs:192-195` and `hello.rs:85-90`. Deferred items 5-7.
- **M4, transport.** Confirmed (`cli.rs:3923-3927`, `auth_gateway_cmd.rs:33-40`). Context corrected; Deferred item 2.
- **M5 and M6, the `cap-*` feature.** Confirmed (`justfile:72`, `:283`; `docs/adr/0049-tiered-integration-architecture.md:47`). The feature was removed.
- **M7, M8, M9, M13, M14, compatibility, identity, distribution and Go.** Confirmed (`crates/proto/buf.yaml`; `lib.rs:45-51`; commits `24ea21e8db` and `1f249d2fa9`). Deferred items 3, 4, 8 and 9.
- **M11 and M12, probe criteria and reaching the pin.** Confirmed (`p7_tui.rs:234-250`; the pin is not an ancestor of omp2). The probe was specified; round 3 removed it.
- **M15, bundle format.** Confirmed. The format was specified; round 3 removed the bundle.
- **M17, no consumer.** Confirmed. Accepted as the resolution.
- **M18, plugin host.** Confirmed. Removed.
- **M19, opt-in jobs go stale.** Confirmed (`crates/app/tests/stock_sdk/` is in no recipe or workflow). Now moot: nothing is added.
- **Minors.**
  - m10 (4 of 7 verbs are documented), m11 (the session host is `omp chat`), m12 (ADR 0048:29 is Context, not stale; the old O8 was withdrawn) and m15 (citation drift) were applied.
  - m6 (embed the descriptor set) was rejected: it would change `omp-proto`'s surface.
  - m14's STATUS.md part was rejected: the orchestrator owns that file.
  - The rest were moot after the cuts.

### Round 3, final (blockers 2, majors 14, minors 22)

Final-round rule: a blocker closes only through a factual correction that changes no reviewed decision, or through removing scope. Both blockers were closed by removing scope.

| ID | Verified | Change, or why moot or rejected |
|---|---|---|
| B1: S1 builds a bundle with no consumer; D4's promise needs only a command | Yes: the research note's "Question" names no consumer. `protox` CLI behind `bin` (`registry:protox-0.9.1/Cargo.toml:93-97`, `:103-106`; `src/main.rs:8-36`). | **Scope removed.** S1 is dropped, and D3 points at one documented `protox` command (flags verified) or `buf build`. |
| B2: S0's harness is unspecified, and the SDK's processes cannot be RAII-owned | Yes: `upstream:.../client.py:627-642` (`start_new_session=True`, inherited env); `--envd-idle-timeout` at `crates/app/src/cli.rs:1995-1997`, missing from the old launch line | **Scope removed.** S0 is now an owner-run measurement in O4, with its prerequisites and limits; no harness is specified. |
| M1: is the bundle a published contract? | Yes: ADR 0048 `:62`, `:111-112` | Bundle gone. D3 states that self-generation is not a supported client path and is promised nothing beyond the Hello rules and WIRE. |
| M2: internal packages presented as the contract | Yes: `crates/proto/buf.yaml` ignore list; `crates/envd/src/server/mod.rs:258` | D3 names which packages the daemon serves and which are internal or negotiated elsewhere. |
| M3: `r<SCHEMA_REV>` names two bundles | Yes: commit `1f249d2fa9` | Moot (scope removed). Kept as a rule in Deferred item 9. |
| M4: a crate for one field | Yes | Moot (scope removed). |
| M5: probe prerequisites missing | Yes: `p7_tui.rs:1053-1066`, `:912-915`; `cli.rs:1872-1874`; `delegated_policy.rs:14-18` | Listed as prerequisites in O4. |
| M6: no scripted-daemon support API | Yes: `p7_tui.rs:153-216`, `:234-250` | Moot (scope removed). O4 says a scripted daemon is test-only today. |
| M7: permanent code for a one-shot measurement | Yes: `p6_crash_resume.rs:194` duplicates the wrapper | Moot (scope removed). |
| M8: a hard-coded "missing" test penalises progress | Yes | Moot (scope removed). |
| M9: adoption ties omp2 to upstream's schema | Yes: the SDKs are generated from upstream's `rpc-wire.schema.json` (`upstream:package.json:161`) | O4 now says adoption would make upstream's schema a compatibility input and leave the 7 omp2 verbs untyped, and recommends against adopting the SDKs as supported clients. O5 asks about owning a schema. |
| M10: weak `pass` oracle | Yes: `upstream:sdk/python/omp-rpc/README.md:34-42` | Stated as a limit in O4. |
| M11: no command-to-method mapping | Yes: `_wire.py` has no method for `set_host_tools` | Moot (scope removed). |
| M12: no turn completion rule | Yes: `client.py:1083-1095` | Moot (scope removed). |
| M13: S1 library surface | n/a | Moot (scope removed). |
| M14: manifest shapes | n/a | Moot (scope removed). |
| m1: wire claim extended to Go | Yes: the Go and Python READMEs differ | The claim is removed; O4 speaks of the Python SDK only. |
| m2, m3, m7, m8, m10, m15-m19, m21 | n/a | Moot (scope removed). |
| m4: raw output and pins not kept | Yes | O4: a run records raw output, the omp2 commit and the SDK pin. |
| m5: host side effects | Yes: `p7_tui.rs:1081-1084` | Stated as a limit in O4. |
| m6: STATUS.md row stale | Yes: `docs/adr/STATUS.md:81` | **Rejected here**: the driver brief bars editing STATUS.md. A replacement row is proposed to the orchestrator. |
| m9: altitude | Partly | Context trimmed to what D1-D4 and the preconditions use; byte-level facts stay only as Deferred items. The review ledger stays, because the brief requires each finding to be listed. |
| m11: `session_startup` is also the first match arm | Yes: `crates/app/src/rpc_mode.rs:1945-1951` | Context corrected. |
| m12: undefined terms | Yes | "Terms" section added. |
| m13: round ids point to texts not in the record | Yes | A note at the top of this section says where the reviewer texts are kept, and each entry restates its finding. |
| m14: research-note questions do not map to O1-O5 | Yes: `docs/research/rpc-clients.md` "Open questions" | The research note's open questions now point to O1-O5. |
| m20: "uv resolves dependencies" overstated | Yes: `upstream:sdk/python/omp-rpc/pyproject.toml:1-10` (only a build backend) | Moot. O4 no longer specifies the install. |
| m22: a start-up failure fails every command | Yes: `client.py:655-689` | Stated as a limit in O4. |

No blocker remains open. Machine-reviewed (EGM, 3 rounds), not owner-approved.

## Status in omp

**Status: Not started**, by decision: nothing is to be implemented under this record. Reusable when a consumer appears:
- the proto sources and `buf.yaml`;
- `protox` and its CLI;
- `Gateway.Hello` and its Rust client;
- `DaemonHandle::start_for_test`;
- the Deferred list.

## References

- [docs/research/rpc-clients.md](../research/rpc-clients.md), with the "Generating from the schema" command; `docs/research/protocols-schemas-serialization.md`.
- ADR 0048 (Decisions 2, 3, 4); ADR 0035 (errors; no code here); `docs/adr/0049-tiered-integration-architecture.md` (no feature added); ADR 0070 (the same research-and-deferral form). ADRs 0006, 0024 and 0036 were checked: there is no sandbox, roster or extension-runtime change.
- Code: `crates/proto`, `crates/rpc/src/hello.rs`, `crates/rpc/src/framing.rs`, `crates/app/src/daemon.rs`, `crates/app/src/rpc_mode.rs`, `crates/driver/src/session_wire.rs`.
