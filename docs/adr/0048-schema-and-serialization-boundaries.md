# 0048. Schema and serialization boundaries: keep the formats, check wire compatibility, harden durable decode

Status: accepted 2026-10-28; implementation gate open
Date: 2026-10-11
Area: runtime/interface

Research: `docs/research/protocols-schemas-serialization.md`

## Context

OMP² owns 18 proto3 files in 14 `omp.*.v1` packages (`crates/proto/proto/omp/**`). `crates/proto/build.rs` compiles them with protox + tonic-prost-build into `OUT_DIR`. Generated code is never committed, and there is no system `protoc` (`AGENTS.md:616`).

Alongside them:

- 21 third-party schemas, pinned by SHA-256 or manifest, are compiled separately by `crates/ai/build.rs`.
- No REAPI or googleapis protos are vendored yet. ADR 0040 PR 1b plans them.

The current layering by use:

| Use | Format |
|---|---|
| Process and network boundaries | Protobuf |
| Durable `.oms` journal | SSE frames carrying single-line JSON |
| Private local stores | postcard |
| External standards (ACP, MCP, LSP/DAP, TSP, `omp rpc`) | JSON / JSON-RPC |
| Collab relay | Hand-mapped JSON |

CI (`.github/workflows/ci.yml:112-138`, job `protobuf`) runs pinned buf 1.73.0 `format` and `lint` (BASIC). It does not run `buf breaking`.

Compatibility is negotiated at runtime:

- `omp_proto::SCHEMA_REV = 27` (`crates/proto/src/lib.rs:51`) is one global counter.
- envd Hello accepts `MIN_SCHEMA_REV = 4..=27`, and every other env operation requires `wire_revision == SCHEMA_REV` (`envd/server.rs:186,4052`; `envd/exec.rs:839`).
- The gateway accepts `MIN_SCHEMA_REV = 1` (`rpc/src/hello.rs:12,101-118`).
- The document protocol negotiates `2.2` against a deliberately build-stable docserver (`docserver/connection.rs:46-48`; `env/project_state.rs:124-125`).
- Durable `processes/meta.json` stores `env.v1` protobuf bytes that a successor envd decodes (`envd/exec.rs:1469-1478,1543`).

The schemas state their evolution rules: skip unknown fields, never reuse numbers, reserve removed fields (`env.proto:17-23`, `toolhost.proto:17-23`). Nothing enforces them, and prost silently drops unknown fields.

The durable formats audit found four concrete decode risks. All of them are in decode logic, not in the formats.

## Decision

### 1. Boundaries and formats are preserved

No serialization or IDL migration.

- Protobuf, built by protox + prost/tonic in `build.rs`, stays the process and network contract.
- The journal stays SSE+JSON:
  - replay depends on decoded meaning and deterministic handle minting, not on bytes;
  - torn-tail recovery is a proven property of the format;
  - payloads are already `RawValue` JSON;
  - prost's dropping of unknown fields would make GC re-encoding lossy.
- postcard stays for private local stores.
- JSON-RPC stays where external standards require it.
- Collab JSON stays as it is.

Transport and RPC remain separate layers. No new transport is introduced (consistent with ADR 0044).

### 2. No schema registry

Git-versioned schemas are enough. Every producer and consumer compiles from this workspace, compatibility is negotiated in-band, and there is no broker stream carrying schema ids.

Revisit when either happens:

- independently released external SDKs consume these `.proto` files (then consider the BSR); or
- a broker event bus appears (then Apicurio or Karapace).

### 3. Buf is for checks only

Keep `buf format` and `buf lint`, and add `buf breaking` (decision 4). Reject:

- `buf generate`: it is not incremental and duplicates `build.rs`;
- BSR remote plugins and generated SDKs;
- `buf.lock`: there are no deps;
- `bufbuild/buf-action`: the pinned, checksummed binary is already reproducible.

The Buf cache stores only dependency modules. It is not a build action cache.

### 4. `buf breaking` is adopted now

It is scoped to the packages whose two ends can run different builds:

- `env`, `identity`, `policy`;
- `document`;
- `gateway`, `auth`, `blob`;
- `inference`, `thread`;
- `toolhost`, for its `HostFrame{Ping}`/`WorkerFrame{Pong}` contract with user-supplied `ReadyPing` processes.

It ignores:

- `control`, `telemetry` and `ui`: same-binary toolhost envelopes;
- `collab`: the protobuf types are in-memory only, and the wire is hand-mapped JSON.

`crates/proto/buf.yaml`:

```yaml
breaking:
  use:
    - WIRE
  ignore:
    - proto/omp/control
    - proto/omp/telemetry
    - proto/omp/ui
    - proto/omp/collab
```

Category choice:

- `WIRE` matches the repository's written rules: field deletion only when the number is reserved, stable types and tags.
- `FILE` and `PACKAGE` are rejected because no generated code leaves the workspace, so `rustc` already catches source breaks.
- `WIRE_JSON` is rejected because the serde JSON on generated types is Rust-native, not proto3 JSON.
- No `except:` entries. Add one only for an observed false positive, with its reason written in the file.

CI: two steps added to the existing `protobuf` job, on `pull_request` only:

```sh
git fetch --no-tags --depth=1 origin "+refs/heads/${BASE_REF}:refs/remotes/origin/${BASE_REF}"
git archive "refs/remotes/origin/${BASE_REF}" crates/proto | tar -x -C "$RUNNER_TEMP/proto-base"
buf breaking crates/proto --against "$RUNNER_TEMP/proto-base/crates/proto"
```

Here `BASE_REF` is `${{ github.base_ref }}`. Locally, add `just proto-breaking` running:

```sh
buf breaking crates/proto --against '.git#branch=omp2,subdir=crates/proto'
```

Keep it out of `remote-heavy`.

The check is pairwise against the PR base. It does **not** cover:

- the gateway's rev-1 promise;
- the env Hello range;
- `SCHEMA_REV` bumps;
- the journal, collab JSON or postcard.

Deferred items:

- a CI rule tying `.proto` diffs to `SCHEMA_REV` bumps: it false-positives on comment edits, and owner policy is needed;
- old-build ↔ new-build handshake tests: once the gateway is deployed separately and `chat --gateway` runs Hello.

### 5. Bazel and BuildBuddy for proto generation are rejected

Keep cargo + `build.rs` + protox.

- `rules_rust_prost` needs `protoc`. `rules_proto` is deprecated. `rules_buf` is beta and does not generate code.
- ADR 0040 rejects a Bazel workspace.
- BuildBuddy remote caching applies to proto generation only as part of ADR 0040's coarse whole-command actions.
- Splitting `omp-proto` per package is deferred until the generation benchmark's decision rule fires.

### 6. REAPI follows ADR 0040 PR 1b unchanged

- Vendor REAPI v2, `semver` and googleapis `bytestream`/`longrunning`/`rpc`/`api` (and, behind a feature, the BuildBuddy cancel protos) under `crates/exec-reapi/proto/`.
- Pin the upstream commit and checksum.
- Compile them with protox + tonic-prost-build like `crates/proto/build.rs`.
- Keep them out of `crates/proto/buf.yaml` lint and breaking: they are third-party.
- Target REAPI 2.0–2.3 semantics.
- Probe cancellation through `CancelOperation`: map `UNIMPLEMENTED` to `Unsupported`, then fall back to the vendor profile or `Action.timeout`.
- `bazel-remote-apis` 0.30 (same prost/tonic major) is the fallback. `reapi` 0.3 is rejected (tonic 0.12).
- Implementation stays deferred with ADR 0040 slice 1.

### 7. Durable-format hardening backlog

These are implementation items, not CI, and none changes a format.

| Item | Change | Evidence |
|---|---|---|
| B1 | Make `ToolResult::Wire` tolerate unknown fields and keep the outcome/fault exactly-one check; or require `tool.result@2` for any field addition and test fold-path structs for it | `journal/src/data.rs:571-580`; `session/src/fold.rs:359-360` |
| B2 | Replace the whole-journal `UnknownKind` failure (and the silent index skip) with a typed "written by a newer revision" error that is still fail-closed; validate or delete the unread `Genesis.version` | `journal/src/kind.rs`; `driver/src/sessions.rs:336-339`; `session/src/session.rs:229-230` |
| B3 | Cap or stream `Journal::open`/`scan`; fail unterminated frames at `DATA_HARD_CAP` | `journal/src/lib.rs`; `journal/src/sse.rs:15` |
| B4 | Call `bounds::validate_host_frame`/`validate_worker_frame` before prost decode on ext-host/worker paths, or delete them | `proto/src/bounds.rs:172-182`; `envd/src/worker.rs:77` |
| B5 | Check in a golden `.oms` fixture corpus with a replay test | `session/tests/golden_journals.rs:250-258`; `fixtures/journal/*.oms` |
| B6 | Version the postcard conversation DB (`user_version` or MAGIC+`SCHEMA_VERSION`) | `ai/src/session/store.rs:329-345`; `catalog/src/snapshot.rs:30-33` |
| B7 | Set tonic `max_decoding/encoding_message_size` explicitly | `app/src/daemon.rs:346-358` |
| B8 | Delete dead `cache::backend` | `cache/src/backend.rs:195` |
| B9 | Fix drift: `limits.py` `SCHEMA_REV = 7`, `processes.md` `WorkerProcess::spawn`, the `build.rs:38-41` comment; file issues for missing `WorkerHello` validation and for `chat --gateway` skipping Hello | research §12.4 |

Deferred:

- GC dropping unknown SSE lines;
- process-store byte encoding and version policy;
- workspace-record fsync;
- the `transcript_v4_json` rename.

## Alternatives considered

- **Migrate the journal to Protobuf, Avro or postcard:** rejected. There is no measured problem, prost drops unknown fields, Avro needs a second schema authority, and torn-tail recovery would need a new proof.
- **Zero-copy formats (FlatBuffers, Cap'n Proto, rkyv):** rejected without measurement. rkyv cannot evolve schemas, and FlatBuffers has an OOB advisory history.
- **A schema registry:** rejected (decision 2).
- **`buf breaking` with `FILE` or `WIRE_JSON`:** rejected (decision 4).
- **No breaking check:** rejected. The ends of the cross-build protobuf boundaries can differ, and prost misdecodes silently.
- **`buf generate` or Bazel codegen:** rejected (decisions 3 and 5).
- **Protobuf Editions:** rejected for now, because prost does not support them.

## Consequences

- A PR that reuses or retypes a field number in a scoped package, or deletes a field without reserving its number, fails CI. Additive changes pass.
- The `protobuf` job gains one shallow fetch and one `buf breaking` run. Cost is UNVERIFIED and expected to be small, because buf is already installed.
- Owner-reviewed churn in `control`, `telemetry`, `ui` and `collab` is not blocked.
- Durable formats are unchanged. B1–B9 reduce whole-session open failures, unbounded reads and dead code.

## Required evidence before acceptance

- **PASSED:** the local `buf breaking crates/proto --against '.git#branch=omp2,subdir=crates/proto'` proof. `just proto-breaking` exits 0 on `omp2` at `e93fc4b962`.
- **DECIDED:** `toolhost` remains in the Buf breaking scope for the WorkerFrame/ReadyPing contract.
- **DECIDED:** B1 uses lenient unknown-field decoding. Implemented as a hand-written `Deserialize for ToolResult` at `journal/src/data.rs:574-579`, with no `deny_unknown_fields` on its `Wire` struct and the exactly-one-of `outcome`/`fault` check keeping the payload fail-closed. The revision-bump alternative is not viable under the current revision gate: `Kind::is_known` at `journal/src/kind.rs:131-132` accepts only `rev == 1`, so a `tool.result@2` is refused as an unknown kind by every reader today. Choosing it later would require implementing and verifying revision-2 support across readers first.

## Implementation gate

The owner accepted this ADR on 2026-10-28. The implementation gate is open for the approved B1-B9 changes, subject to their individual tests and the remaining evidence below:

- the `buf.yaml` `breaking:` section, the two CI steps and `just proto-breaking` may land as one change;
- B1–B9 land as separate changes, each with tests.

Benchmarks in the research document stay plans (UNVERIFIED) and do not gate CI.

## Status in omp

**Status: Partially implemented.** The owner accepted the format-preservation decision, and the Buf check plus every hardening item except B9 is implemented. B9 Variant 1 is selected but its daemon-context authority verification remains open.

- **Done:** Buf breaking configuration and CI, B1, B2, B3, B4, B5, B6, B7, and B8.
- **Done:** B5 replay checks that the discovered fixture names equal the registered `corpus()` names, then folds each journal and compares it with its recorded snapshot (`crates/session/tests/golden_journals.rs:golden_journals_open_and_fold_to_their_recorded_snapshots`).
- **Open:** B9 fixes the Python schema revision drift, but
  `docs/architecture/processes.md` still contains the stale
  `WorkerProcess::spawn` description and issue filing for WorkerHello and
  gateway Hello is not established.
- **Open verification:** B9 daemon-context authority verification.