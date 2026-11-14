# Gap 18: generated Go and Python RPC clients from the proto definitions

Status: research only. Nothing here is implemented or authorized.
Date: 2026-11-13 (revised 2026-11-14 after EGM round 1 on ADR 0069: command overlap recounted, Content-Length texts fixed upstream of this note, plan moved to ADR 0069; after round 2, client generation deferred; after round 3, research and deferral only, with the schema-compilation command in section 5)
Baseline: omp2 f4186b783b; upstream c308970263 (pinned checkout).

Evidence keys:

- **OBSERVED** means read in code or docs at the baseline. Citations use `path:line`. Upstream paths carry the `upstream:` prefix.
- **[INFERENCE]** means the author's reasoning. Every size estimate is an inference.
- **UNVERIFIED** means no run or source confirmed it.

No build, test or run was made for this document. No generator was run.

## Question

Upstream ships typed Go, Python and Rust clients for its RPC protocol. Can omp2 generate Go and Python clients from the proto definitions it already owns, and what in omp2's own decisions stands in the way?

Out of scope: a Rust client (omp2 already has one, `omp-rpc`), and clients for ACP, MCP or the collab relay.

## 1. Upstream

- Three SDKs live under `sdk/`: `go`, `python` and `rust`, each an `omp-rpc` package (directory listing of `upstream:sdk`).
- They target one protocol: `omp --mode rpc`, JSON lines over stdio (`upstream:sdk/go/omp-rpc/README.md:3`). The TypeScript side frames each message as one newline-delimited UTF-8 JSON object with a size cap (`upstream:packages/coding-agent/src/modes/rpc/rpc-frame.ts:5`).
- The typed surface is generated, not written. `wire.go` is marked "generated": every frame and shared type, JSON codecs, one parameter struct and one typed method per command (`upstream:sdk/go/omp-rpc/README.md:8-9`; first line `upstream:sdk/go/omp-rpc/wire.go:1`). Regeneration is `bun run gen:rpc` (`upstream:sdk/go/omp-rpc/README.md:15-20`), which runs `bun scripts/gen-rpc/index.ts` (`upstream:package.json:161`, `upstream:packages/coding-agent/package.json:529`).
- The source of truth is a JSON Schema plus a TypeScript DSL under `packages/coding-agent/src/modes/rpc/wire` (`rpc-wire.schema.json`, 132 KB; `rpc-wire.generated.ts`, 53 KB). A conformance test type-checks the schema against the hand-written types (`upstream:packages/coding-agent/test/rpc-wire/conformance.types.ts`).
- Sizes: the generated Go file is 8,565 lines, the Python `_wire.py` 4,395 lines and the Rust `wire.rs` 7,449 lines, counted with `wc -l`. Around them sits hand-written code: client with request correlation and protocol-v2 negotiation, chunk reassembly, host tools and host URI schemes (`upstream:sdk/go/omp-rpc/README.md:10-13`).
- Binding rules the generator fixes: enums are string types and decoding an unknown value fails; closed objects decode strictly; open records keep undeclared keys in an `Extra` map and write them back (`upstream:sdk/go/omp-rpc/README.md:24-29`).
- The Go module is `github.com/can1357/oh-my-pi/sdk/go/omp-rpc`, Go 1.23, standard library only (`upstream:sdk/go/omp-rpc/go.mod:1-3`).

What upstream does **not** have: proto-generated clients. Its protocol is JSON, and its schema is JSON Schema.

## 2. omp2 inventory

### The proto definitions

- `omp-proto` "owns the workspace's wire-level Protobuf definitions and the Rust bindings generated from them"; the optional `tonic` feature adds gRPC clients and servers (`crates/proto/README.md:3`). Sources are `crates/proto/proto/omp/<package>/v1/*.proto`.
- Inventory, counted with `find` and `grep` on the baseline:
  - 19 files in 15 packages: `auth`, `blob`, `collab`, `control`, `document`, `env`, `gateway`, `identity`, `inference` (five files, one package), `policy`, `session`, `telemetry`, `thread`, `toolhost`, `ui`.
  - 6 gRPC services and 63 RPCs: `Auth` (21 RPCs, 20 unary and 1 server stream), `Blob` (4: 2 unary, 1 server stream, 1 client stream), `Gateway` (1 unary, `Hello`), `ForwardProxy` (1 server stream, `Forward`), `Inference` (30: 23 unary, 5 server stream, 2 bidirectional) and `SessionControl` (6: 5 unary, 1 server stream). Service declarations: `crates/proto/proto/omp/auth/v1/auth.proto:38`, `crates/proto/proto/omp/blob/v1/blob.proto:13`, `crates/proto/proto/omp/gateway/v1/gateway.proto:21`, `crates/proto/proto/omp/gateway/v1/gateway.proto:29`, `crates/proto/proto/omp/inference/v1/inference.proto:39`, `crates/proto/proto/omp/session/v1/session.proto:16`.
  - The other packages (`env`, `toolhost`, `control`, `ui`, `telemetry`, `document`, `collab` and so on) define messages only. `env` and `toolhost` ride a varint-framed stdio protocol, not gRPC (`crates/proto/README.md:10-17`). Their wire is not a client surface.
- Services actually served: the daemon registers five of the six, `Gateway`, `ForwardProxy`, `Inference`, `Blob` and `Auth` (`crates/app/src/daemon.rs:403-408`). `SessionControl` is served separately, by the session host on a Unix socket under the data directory, wrapped in `SessionControlRpc` (`crates/driver/src/session_wire.rs:318`); `omp attach` is its client (`crates/app/src/attach_cmd.rs:33-39`). An earlier draft of this note said it was unserved; that was wrong, because the search used a wrong type name. Its authority model, scopes and socket lifetime were not traced (UNVERIFIED).
- Hello advertises capabilities `auth`, `inference.native` and `gateway.forward` (`crates/app/src/daemon.rs:380-386`). `HelloRequest` carries the client name, its schema revision and capabilities; `HelloResponse` carries the server's revision, its minimum revision, capabilities and version (`crates/proto/proto/omp/gateway/v1/gateway.proto:43-63`). The wire-visible revision is `SCHEMA_REV`, 29 (`crates/proto/src/lib.rs:51`). A client has to perform this handshake itself.
- Transports: an owner-only Unix-domain socket locally, or TCP with a bearer token file; plain TCP without a token is refused (`crates/app/src/daemon.rs:389-391`, `crates/app/src/daemon.rs:416-418`, `crates/app/src/daemon.rs:177`). TLS and optional mutual TLS are implemented in the `omp-rpc` crate (`crates/rpc/src/tls.rs:9-18`), but no crate outside `crates/rpc` calls `server_tls` or `client_tls`, so the daemon serves no TLS. `omp serve` builds only a local endpoint (`crates/app/src/cli.rs:3923-3927`); TCP exists only as plaintext bearer through `omp auth-gateway serve --bind` (`crates/app/src/auth_gateway_cmd.rs:33-40`). Server messages are capped at 64 MiB (`crates/proto/src/bounds.rs:11`, `crates/app/src/daemon.rs:63`), far above the default receive limits of grpc-go and grpcio, so a client must raise its limits. [INFERENCE: those defaults are from general knowledge, not read here.]
- Build and checks: `build.rs` compiles every `.proto` with the pure-Rust `protox` compiler and `tonic-prost-build`; generated Rust goes to `OUT_DIR` and is never committed (`crates/proto/build.rs:1-6`, `crates/proto/README.md:18`). `buf.yaml` sets lint to BASIC and breaking to WIRE, and ignores `control`, `telemetry`, `ui` and `collab` (`crates/proto/buf.yaml`). CI runs `buf format`, `buf lint` and `buf breaking` against the PR base (`.github/workflows/ci.yml:203-229`). ADR 0048's Context describes CI before that ADR's own Decision 4 adopted `buf breaking` (`docs/adr/0048-schema-and-serialization-boundaries.md:29`, `:81`); it is historical context, not a stale claim.
- Package cycle: `omp.thread.v1` imports `omp/inference/v1/common.proto`, and `omp.inference.v1` imports `omp/thread/v1/thread.proto` (`crates/proto/proto/omp/thread/v1/thread.proto:5`, `crates/proto/proto/omp/inference/v1/inference.proto:9`, `crates/proto/proto/omp/inference/v1/media.proto:6`). Buf's `PACKAGE_NO_IMPORT_CYCLE` rule is switched off for exactly this reason (`crates/proto/buf.yaml`). No `go_package` option appears in any of these files (searched: `option` lines in `crates/proto/proto/omp`).

### The `omp rpc` embedding protocol is not proto

- `omp rpc` is the stdio embedding protocol. Its types are serde structs that "intentionally leave application-owned model, message, and event payloads as `serde_json::Value`" (`crates/rpc/src/protocol.rs:1-6`). There is no JSON Schema for it: `JsonSchema` appears zero times in `protocol.rs`. The Rust client is the `client` module of `omp-rpc` (`crates/rpc/README.md:7`).
- **The framing is the same as upstream's.** The stdio mode decodes newline-delimited JSON with protocol-v2 chunk reassembly (`JsonLineDecoder`, `RpcFrameDecoder`), with a 1 MiB cap per physical line and 64 MiB per reassembled payload (`crates/app/src/rpc_mode.rs:34`, `crates/rpc/src/framing.rs:1-2`, `crates/rpc/src/framing.rs:13-21`). `rpc_mode.rs` imports the JSON-line decoder, not the `ContentLengthDecoder` defined in the same module (`crates/rpc/src/framing.rs:159-164`), which `omp rpc` does not use. The crate README and the CLI help used to say "Content-Length"; commit `0f17146ad` corrected both (`crates/rpc/README.md:3`, `crates/rpc/README.md:8`, `crates/app/src/cli.rs:1127`). An earlier draft of this note said the framing differed; that was wrong.
- **Command overlap (recounted 2026-11-14).** Upstream's schema lists 74 commands (`name` fields of `x-rpc.commands`, `upstream:packages/coding-agent/src/modes/rpc/wire/rpc-wire.schema.json:11`). The string patterns of the top-level request `match` in `crates/app/src/rpc_mode.rs:1944-2905`, including alternation arms, plus `session_startup` (answered before that match, `crates/app/src/rpc_mode.rs:156-170`) give 47 shared names and 27 upstream-only ones (for example `fork`, `goal`, `btw`, `live_start`, `dictation_start`, `navigate_tree`, `logout`; full list in ADR 0069). omp2's match also handles 11 names that are not upstream commands. Three are upstream inbound frames, not commands: `extension_ui_response`, `host_tool_update`, `host_tool_result` (`RpcInbound`, `rpc-wire.schema.json:5941`). One is `session_startup`. Seven are omp2-only verbs: `approve`, `cancel`, `interrupt`, `pause`, `resume`, `quit`, `shutdown`. The first count (45, 29, 7) missed alternation arms. Field shapes were not compared (UNVERIFIED). Upstream's SDKs may therefore work against omp2 for the shared commands.
- **No JSON command is a gRPC RPC.** The daemon's 57 RPCs are inference, credential and blob operations. The only overlap with the agent-driving commands is `SessionControl.Submit`, whose seven verbs mirror rpc-mode verbs (`crates/proto/proto/omp/session/v1/session.proto:173-188`). Its socket registers no `Gateway` (`crates/driver/src/session_wire.rs:311-331`).
- **Upstream's SDK suites test fakes.** The Python suite runs a Python fake server (`upstream:sdk/python/omp-rpc/tests/test_client.py:1142-1149`), and the Go unit tests use an in-memory fake (`upstream:sdk/go/omp-rpc/fake_test.go:21-26`). The Go smoke tests run upstream's Bun CLI with a `PI_*` variable (`upstream:sdk/go/omp-rpc/smoke_test.go:71-73`). A probe against omp2 therefore needs its own harness.

### Locked decisions

- ADR 0048 keeps Buf to format, lint and breaking. "`buf generate`, the BSR, Bazel proto rules and BuildBuddy caching for proto generation are all rejected" (`docs/adr/0048-schema-and-serialization-boundaries.md:27`). Hybrid D, Buf for checks and Cargo for codegen, is "what OMP² does today" (`docs/research/protocols-schemas-serialization.md:263`). That reasoning concerns the Rust build, but its wording would be read against `buf generate` for Go and Python too.
- Generated code is never committed, and there is no system `protoc` (`docs/adr/0048-schema-and-serialization-boundaries.md:12`).
- Hard constraint: no new language runtimes. A Go or Python client is a separate artifact for outside users, not a runtime inside omp, but a Go toolchain in CI is still new to this repository. The owner should say whether that counts.
- A repository search for a `go.mod` found only a fixture (`fixtures/sarif/sources/golangci/go.mod`). There is no Go code in the workspace today.

### Gap table

| Item | Upstream | omp2 | Gap |
|---|---|---|---|
| Typed Go client | generated from JSON Schema | none | new |
| Typed Python client | generated from JSON Schema | none | new |
| Machine-readable schema | JSON Schema + DSL | `.proto` for gRPC; none for `omp rpc` | gRPC side exists |
| Handshake and version check | protocol v2 negotiation | `Gateway.Hello` with `schema_rev` and `min_schema_rev` | client must implement |
| Compatibility check in CI | schema conformance test | `buf breaking` (WIRE) | exists |
| Generation tool | `bun run gen:rpc` | none for non-Rust; ADR 0048 rejects `buf generate` | needs a ruling |
| Go packaging | module in the repo | package cycle thread/inference; no `go_package` | design needed |
| Services to expose | the whole stdio surface | 6 services: 5 on the daemon, `SessionControl` on the session host | choose scope |

## 3. Class

**Class d (propose)** for proto-generated gRPC clients. omp2 has proto definitions and a served gRPC surface, which is a good generation source, but no generator, no Go code and a locked ADR against `buf generate`. For the stdio `omp rpc` protocol there is a second, cheaper path that may be **class c**: upstream's MIT SDKs speak newline-delimited JSON, and omp2 uses the same framing and shares 47 of 74 command names, so they may work with little change. That needs a compatibility probe first (option 7).

Verdict (revised 2026-11-14 after EGM round 3): do not generate gRPC clients under this gap, and build nothing.
- No consumer is named, and publishing clients needs owner rulings on existing server behaviour (Hello capabilities, TLS, the revision model; ADR 0069 "Deferred").
- The `.proto` sources in git are the contract, and one documented `protox` command (section 5) turns them into a descriptor set; a bundle tool adds nothing to that.
- A probe of upstream's SDKs against `omp rpc` is left to the owner as a measurement (ADR 0069 O4). Adopting those SDKs as supported clients would make upstream's schema a compatibility input for omp2.

## 4. Options

1. **Do nothing.** Anyone can run `protoc`, `buf` or `grpcurl` on `crates/proto/proto`. Cost: zero. Fit: honest, but nobody can find the contract or its version.
2. **Publish the proto sources and a descriptor set as a release artifact** ("protos as the contract"). Cost: 1 to 2 days. Fit: good. It needs no new generator; the `protox` compiler the build already uses can emit a `FileDescriptorSet`. Consumers generate for any language with their own tools.
3. **Generate Python and Go with `buf generate` or `protoc` plugins in a release job, publishing wheels and a Go module, never committing generated code.** Cost: 2 to 3 weeks for both. Fit: good for users, but it needs an ADR 0048 amendment and a Go toolchain in CI.
4. **Check generated clients into the repository.** Rejected: generated code is never committed (`docs/adr/0048-schema-and-serialization-boundaries.md:12`).
5. **Port upstream's JSON-schema generator to `omp rpc`.** Cost: very high. It first needs a schema for a protocol whose payloads are free-form `Value`. Fit: poor. Superseded for the common case by option 7.
6. **Generate clients for the stdio protocol from Rust types** with `schemars`. Cost: high, and the open payloads stay untyped. Fit: poor.
7. **Reuse upstream's SDKs for `omp rpc`.** Take the Go, Python and Rust `omp-rpc` packages (MIT) and run them against omp2's stdio mode, fixing the differences. Cost: a probe of 1 to 2 days, then an unknown amount of adaptation for the 27 upstream-only commands and the 7 omp2-only verbs, whose wire shapes differ or are missing. Fit: good if the probe passes, because the framing is shared and the typed surface already exists. Risks: the generated `wire.go` and `_wire.py` encode upstream's schema, so omp2 changes need a regenerated or hand-patched wire file, and the generator is a Bun script (`upstream:package.json:161`), a runtime omp2 does not use.

Choice: option 1, made findable. The sources in git stay the contract, and section 5 documents how to compile them. Option 2's release artifact, option 3's clients and option 7 are all deferred until a consumer exists; option 7's probe is an owner-run measurement (ADR 0069 O4). [INFERENCE]

Revisions on 2026-11-14:
- After EGM round 1: option 3 originally said "`buf generate` or `protoc` plugins". Neither fits. ADR 0048 Decision 3 rejects `buf generate` (`docs/adr/0048-schema-and-serialization-boundaries.md:74`), and the repository has no system `protoc` (`AGENTS.md:656`).
- After EGM round 2: option 3 was deferred (ADR 0069 D4).
- After EGM round 3: the bundle tool (option 2) and the committed probe harness (option 7) were dropped as well (ADR 0069 D1, D3).

## 5. Generating from the schema

This is not a supported client path. The only compatibility promises are the run-time `Gateway.Hello` revision rules and WIRE-level `buf breaking` (ADR 0069 D3).

`protox` 0.9.1, the compiler `crates/proto/build.rs` uses, ships a CLI behind its `bin` feature (`registry:protox-0.9.1/Cargo.toml:93-97`, `[[bin]]` at `:103-106`). Its flags are `-I/--include`, `-o/--output` (alias `--descriptor_set_out`), `--include_source_info` and `--include_imports` (`registry:protox-0.9.1/src/main.rs:8-36`). From the repository root:

```sh
cargo install protox@0.9.1 --locked --features bin
cd crates/proto/proto
protox -I . --include_imports --include_source_info \
  -o ../../../target/omp.binpb $(find omp -name '*.proto' | sort)
```

The output is a self-contained `FileDescriptorSet`, which any language's protobuf tooling can generate from. Alternatively, `buf build crates/proto -o target/omp.binpb` uses the buf version pinned in CI, 1.73.0 (`.github/workflows/ci.yml:178-201`). Neither command was run for this note (UNVERIFIED).

The daemon serves `gateway`, `auth`, `blob` and `inference` (with their imports). Of the other packages:
- `control`, `telemetry`, `ui` and `collab` are internal (`crates/proto/buf.yaml` breaking ignores);
- `env` is negotiated by envd;
- `session` is served by the `omp chat` session host, with no `Hello`.

## 6. Plan

None. ADR 0069 is a research and deferral record with no slices. Earlier revisions planned slices that were dropped in review:
- round 1: an ADR 0048 amendment, then a bundle, Python and Go clients, a plugin host and a conformance suite;
- round 2: a bundle crate (S1) and a probe harness (S0).

The facts those reviews found are kept as ADR 0069 "Deferred: preconditions". The Content-Length text the first draft's slice 0 mentioned was fixed by commit `0f17146ad`.

## 7. Open questions

The owner questions are ADR 0069 O1-O5. This note's earlier list maps onto them as follows:
- ADR 0048 trigger → O1;
- Go toolchain, the thread/inference cycle, the compatibility promise, large messages → ADR 0069 "Deferred" items 3-9, for a later client record;
- `SessionControl` scope → O3;
- a typed stdio client → O4 (probe) and O5 (owning a schema).

There is no conflict with ADR 0036, 0024 or 0006.

## 8. Upstream origin and license

Option 7 would reuse upstream's SDKs for the stdio protocol if the compatibility probe passes. Otherwise nothing from them is reused. Useful ideas either way, the useful ones are the binding rules (strict enums, an `Extra` map for open records, strict closed objects) and the split between a generated wire file and a hand-written client (`upstream:sdk/go/omp-rpc/README.md:22-29`). Upstream's `LICENSE` is MIT, with copyright lines for Mario Zechner, Can Bölük and Stencil Labs, Inc. (`upstream:LICENSE:1-5`); the Python SDK carries its own MIT file (`upstream:sdk/python/omp-rpc/LICENSE:1-3`).

Generator tools (buf, protoc-gen-go, grpc-go, grpcio-tools) are separate projects with their own licences. None was checked in this checkout (UNVERIFIED), and `deny.toml` covers only Rust crates, so a licence review would be a manual step.

