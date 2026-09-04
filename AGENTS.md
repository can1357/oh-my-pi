# Repository Guidelines

`omp`: pre-release Rust impl of Oh My Pi's coding-agent + inference runtime —
durable agent turns, model routing, project-scoped tools/authorities,
terminal/native presentation, telemetry, embedded free-threaded Python. Rust
rewrite of `pi`: port observable behavior, not TS shape.

## Architecture

- `crates/app`: process startup plus CLI, TUI, ACP, RPC, and print adapters.
  It presents compositions built by `omp-driver`; hidden same-binary child
  dispatch delegates to `omp-envd` entry points and does not make app the host.
- `crates/driver`: headless coding-agent composition — discovery, con context
  and cfg execution, registries, environment wiring, and subagent spawn.
  `compose_kernel` is the production construction boundary. `crates/driver` +
  `crates/app` = the production stack (driver composes, app presents); other
  libraries NEVER build a second production stack.
- `crates/journal`: authoritative `.oms` journal and blob CAS. `crates/dom`:
  materialized session tree and patch stream. `crates/vocab`: shared closed
  DOM/TUI vocabulary. `crates/session`: journal-first session API, fold,
  components, rewind, and pure projections.
- `crates/con`: typed convars, commands, bindings, aliases, and cfg persistence.
  `crates/cache`: unrelated document, GitHub, MCP, secret-key, and statistics
  caches; it does not own session history.
- `crates/ext`: extension configuration, dependency resolution, lockfiles,
  index metadata, and trust domain (`omp-ext`).
- `crates/serve`: gRPC transport projections serving inference, auth, and
  blob services (`omp-serve`).
- `crates/core|proto|rpc|observability`: allocation-aware primitives, wire
  contracts, RPC, and observability.
- `crates/agent`: the `Kernel`, dispatcher, job board, cancellation tree,
  Directors, hooks, extensions, and approvals. A live turn flows app →
  driver `compose_kernel` → `omp-agent` `Kernel` → `omp-session`, which appends
  to `omp-journal` and folds into `omp-dom`; `omp-chat` is an actor over
  `Session::subscribe()` and never owns controller state.
  `crates/catalog`: model/provider data (`data/`) + transports.
  `crates/ai`: typed requests → concrete Tower services, routing,
  recovery middleware → `ChatEvent` streams (`omp-ai`).
- `crates/tool`: revisioned tool contracts; `crates/tools`: implementations.
  `crates/env` (`omp-env`) is the typed environment-protocol client and owns no
  host resources. `crates/envd` (`omp-envd`) is the live project-environment
  host: daemon transport, filesystem/process/document/tool authorities, and
  Python extension-host/worker supervision. Host changes go to `omp-envd`;
  client protocol APIs go to `omp-env`.
  `crates/edit|ast|walker`: multi-paradigm edit engine, syntax, fs discovery.
  `crates/shell|shell-builtins`: in-process Bash parser/runtime, built-ins.
- `crates/tui`+`tui-macros`: retained declarative UI; `crates/chat`: terminal
  and native chat actor/projections; `crates/gui`: native window host.
  None owns agent/provider policy.
- `crates/e2e/tests`: authoritative joined-system proofs P1-P8.
- `PLAN.md`: authoritative plan — locked decisions D1-D8, defect ledger, 8
  parts + checklists.
- `fixtures`, `.plan/quirks`: conformance data, recorded incompatibilities.
  Other `.plan` scratch (research, port, feature-map) NEVER outranks production
  code/tests.
- `.omp/tools`, `scripts`, `crates/*/scripts`: agent tooling, release gen,
  subsystem setup.

Turn flow: `app/src/main.rs` (process bootstrap and hidden `omp-envd` child
entry dispatch) → `omp_app::run` / `app/src/cli.rs` (command and presentation
adapter) → `omp-driver` chat/headless composition (environment, registries,
journal, agent session, and higher-layer host bridges) → `omp-envd`
project-environment host, reached through `omp-env` clients for effects →
`agent/src/loop.rs` (mailbox input/interrupts, `TurnClient`, typed tool batches,
durable `AgentEvent`s) → `omp-ai` (facade + Tower spine; streamed events
→ storage → app adapter) → TUI retained tree → terminal output materialized
once at final renderer.

## Commands

`justfile` = source of truth; use `just`, not raw cargo. `just --list` shows
all recipes.
- One-time before anything linking `omp-py`: `just setup-python`.
- Iterate targeted (`just check-pkg <pkg>`, `just test-pkg <pkg>`); broaden
  (`check`, `test`, `lint`) after the changed contract passes.
- E2E separate + expensive: `just e2e` (or `e2e-build|e2e-core|e2e-p7|e2e-p8|e2e-baseline`).
- `just ci` ≈ CI format+rust jobs locally.

CI (`.github/workflows/ci.yml`): authoritative Cargo-only gate. Format on
Linux; lint/tests/P1-P8/baseline on `macos-15` arm64 (CPython bundle
`aarch64-apple-darwin`-only).

## Conventions

Deps: all in root `[workspace.dependencies]`; members `{ workspace = true }`,
NEVER pin versions. Extra features fine:
`serde = { workspace = true, features = ["rc"] }`. `serde_json` always
`preserve_order` + `raw_value`; `omp_core::slopjson` (broken/partial/streaming
JSON) mirrors that surface.

Env vars `OMP_*`, never `PI_*`; ported code strips upstream (`pi`, `uu`, …)
env vars, context objects, branding — never aliases. Pre-release: rename+move
(don't copy); clean cutovers; compat shims, old names, deprecated aliases
PROHIBITED; update every caller + remove obsolete exports/tests same change.

Unicode/ANSI: `xutf` for ALL Unicode/UTF-8/16/32, grapheme, display-width,
normalization, ANSI/VT ops. `unicode-normalization` banned. NEVER add utility
crates for these (`unicode-*`, `utf8-*`, `unicode-segmentation`,
`unicode-width`, `ansi_*`, `strip-ansi-escapes`); remove redundant deps, don't
wrap.

Hashing: two primitives, both in `omp-core` — benchmarked on Apple Silicon,
don't relitigate. Content/crypto digests → `omp_core::Hash32` (SHA-256 via
`sha2`, hardware `asm` on aarch64; beat blake3 3.3× at 32 B, single-stream at
every size). Discretionary in-memory maps/cache keys/dirty-check fingerprints
→ `omp_core::{FastHashMap, FastHashSet, FastState, fast_hash64}` (foldhash;
beat fxhash/ahash/xxh3/SipHash on ints, short keys, and buffers). NEVER add
hasher crates (`blake3`, `xxhash-*`, `rustc-hash`, `ahash`, `fnv`,
`twox-*`, …) for discretionary hashing; migrate on touch. Exceptions =
externally fixed algorithms only: format/RFC/vendor contracts (git SHA-1,
archive CRCs, PKCE/SigV4/JWT SHA-256, gravatar+identicon MD5, HF manifests,
SSH fingerprints), checksum builtins where the algorithm is the feature,
pi/Bun behavioral compat (secrets wyhash, hashline xxh32 tags, MCP wyhash
name shortening), and the extension registry/trust dual-hash schema
(`b3:`+`sha256:`, Ed25519-signed — blake3 stays until a schema bump).
Durable artifact addresses are `artifact://sha256/<64-hex>`;
`ArtifactDigest` renders `sha256:<hex>`.

Crates: members `crates/*` (virtual workspace, resolver 3); dirs unprefixed
(`crates/demo`); package names `omp-` prefixed (`name = "omp-demo"`). Every
member: real `description` + workspace
`license`/`authors`/`homepage`/`repository`; README (what it is + structural
philosophy); inherits

```toml
[package]
name = "<name>"
version.workspace = true
edition.workspace = true

[lints]
workspace = true
```

Taxonomy: domain prefix after `omp-` (`omp-llm-*`, `omp-shell*`).
**transport** = provider wire protocol ≠ **dialect** = thread rendering to the
LLM; NEVER conflate. Providers = catalog data entries; code only for genuinely
distinct wire behavior; routing stays in ai. `omp-tool` defines
contracts, `omp-tools` implements — never inverted. Public daemon commands and
same-binary child roles are dispatched by app; daemon implementation belongs
in its host crate (`omp-envd` for the project environment), never in app
presentation internals.

Style: pinned nightly (`rust-toolchain.toml`), edition 2024. Lints in root
`[workspace.lints.*]`; `#[allow]` requires `reason`. `cargo fmt` (hard tabs,
3-col, width 100 — `rustfmt.toml`); NEVER hand-format.

Enum↔string: hand-written `match self { … => "…" }` tables (any name —
`name()`, `as_str()`, `label()`, `Display`) PROHIBITED incl. private enums →
derived strum: `IntoStaticStr`/`Display` emit; `EnumString` parse;
`#[strum(serialize_all = "...")]` + per-variant `to_string`/`serialize` for
aliases/irregular names (dotted protobuf paths, multi-word labels —
irregularity ≠ excuse to hand-write); `ascii_case_insensitive` lax input;
`const_into_str` keeps `as_str` `pub const fn`. Custom public parse error:
derive + `map_err`. ONLY escape hatch when strum can't express the shape
(per-arm logic, data variants w/ dynamic strings, one labeled error across
many enums): local `macro_rules!` emitting both directions from one
variant→string table (`vocab!`, `crates/observability/src/semconv.rs`). New bare
match table = reviewer-reject; migrate on touch.

Composition/errors/state:
- `crates/driver` is the reusable DI boundary for registries, concrete Tower
  services, `TurnClient`s, environment sessions, and higher-layer host
  bridges. `crates/app` adapts that composition to commands and presentation;
  it NEVER owns environment-host, extension-host, or Python-worker internals.
  Libraries NEVER build a second production stack.
- Library errors: `thiserror`, every variant `#[error("…")]`. Hand-written
  `impl Display`/`impl Error` on errors = reviewer-reject. Errors NEVER pass
  through formatters: string-payload variants (`Variant(Str)`,
  `Variant(String)`, `reason: Str` catch-alls) and stringified inner errors
  (`sf!("…: {error}")`, `format!`, `{error:?}`, `.to_string()`) =
  reviewer-reject — carry the typed inner error via `#[source]`/`#[from]` and
  the identifying facts as named fields; render once, at the app/miette
  boundary. Static-message errors are unit variants with the text in
  `#[error("…")]`, never a `Str` payload. App orchestration:
  `miette`; classify/redact untrusted provider diagnostics before stderr.
- Durable state = append-only transcript journal + blob store; turn state =
  `AgentSnapshot` + journal projection; NEVER a parallel mutable source of
  truth.
- Loops: one `flume` mailbox; priority lifecycle: `tokio::watch`.
  Ownership/cancellation explicit.
- Every public symbol documented (`missing_docs` workspace-warned).

Performance sections below load-bearing + intentionally detailed. NEVER
weaken, summarize away, or bypass in refactors.

### Allocation Discipline (CRITICAL)
Prefer `&T`/`&str`/`&[T]` whenever lifetime permits. Think twice before
`String`/`Vec`. `omp-core` replacements MANDATORY in their target situation,
NOT violations to skip outside it. Test: removes allocations/copies/locking on
a real path? no → default type right; don't churn.
- `Vec<T>` by growth:
  - small (≲12), hot, or short-lived → `smallvec::SmallVec` (inline until
    spill). Cold/long-lived/usually-large → plain Vec (spilled SmallVec =
    worse Vec). Pinned 2.0-alpha (root `Cargo.toml`): two const params, NOT
    1.x array-generic (training-data default; won't compile here):
    ```rust
    SmallVec::<[StateEntry; 8]>::new();  // WRONG — 1.x syntax
    SmallVec::<StateEntry, 8>::new();    // correct — 2.0-alpha syntax
    ```
  - compile-time hard bound → `[T; N]` (`[Option<T>; N]` if slots may be empty).
  - concurrent append-only log, read while written → `omp_core::AppendVec`
    (lock-free appends, stable indices); single-threaded / built before read →
    Vec fine.
  - unbounded, built once, moved once (scratch, collect-and-return, channel
    payloads) → Vec correct.
  - cloned repeatedly (snapshots, per-turn/per-event state, values fanned to
    tasks/channels) → `im::Vector` (Arc-backed structural sharing, O(1)
    clone, cheap mutation of shared copies). Requires `T: Clone`; NOT
    contiguous — consumers needing `&[T]`/`as_slice`/FFI stay on Vec. Only
    pays when the O(1) clone survives to the consumer: small (≲12) vectors of
    cheap-clone items stay SmallVec, and if every consumer flattens back into
    a Vec/SmallVec anyway, the persistent tree is pure overhead — don't
    convert.
- Strings: default `omp_core::Str` (`crates/core/src/str.rs`; NOT smol_str).
  Inline ≤23 bytes; heap `Bytes`-backed: O(1) clone, zero-copy
  slice/split/trim. Build `StrMut`+`freeze()` or `fmts!`; convert `IntoStr`
  (`.to_str()`). Pays for stored/cloned/sliced strings (ids, names, tokens,
  messages). `String` fine as transient build buffer consumed immediately +
  APIs requiring it (`fmt::Write`, FFI, serde sinks). Large/edited text →
  rope (`ropey`).
- Bytes: `omp_core::CowBytes` when shared/sliced/cloned — replaces
  `Cow<'_, [u8]>` (borrowed | `Bytes`-owned; O(1) clone, zero-copy slicing).
  Built once, single consumer → `Vec<u8>` fine.
- Maps/sets keyed by enums/small dense ints → `omp_core::SparseMap`/`SparseSet`
  (bitmap presence + packed values). Clone-heavy maps (state snapshots cloned
  per event/turn, shared caches) → `im::HashMap`/`im::OrdMap` (O(1)
  structural-sharing clone). Plain `HashMap` correct for sparse/unbounded
  keys, strings, no small dense index, and no repeated clones.
- Binary↔text: `omp_core::encoding` (`hex`/`base64`/`base32`), stack
  `ArrayStr<N>` outputs. External encoding crates banned outright — no
  exception.

- `sf!`: literal/expr arms (`sf!("lit")`, `sf!(STATIC)`) = `Str::new_static`,
  free — the formatting arm allocates. Three formatting-arm bans, each
  reviewer-reject:
  1. statically-known text: `sf!("{}", CONST)`, `sf!("{}{}", ESC_A, ESC_B)`,
     enum→string match arms — use the literal/expr arm, `concat!`, a
     precomputed const, or derived strum (`IntoStaticStr`); a `Str`-returning
     fn whose every arm is static returns `&'static str` instead.
  2. `sf!(…)` immediately copied into an existing sink
     (`push_str(&sf!(…))`, `StrMut::new(sf!(…).as_str())`) — `write!` into
     the `StrMut`/`String` directly; one buffer, zero intermediates.
  3. per-frame/per-key/per-line/per-cell paths — format on state change and
     cache, or format into a stack `ArrayStr<N>`; paint re-slices, never
     re-formats. Errors NEVER go through formatters (see errors bullet).
- Branded string ids (`omp_core::string_id!`): bare `Id` (= `Id<Str>`) is the
  owned form for storage — fields, map keys, moves. Explicit `Id<str>` is the
  borrowed query form (`Id::from_ref`, a zero-cost `#[repr(transparent)]`
  cast). Lookup/query fns take `&Id<str>`, NEVER `impl AsRef<Id<str>>`; raw
  string callers pass `Id::from_ref(text)`. An owned `&Id` dereferences to
  `&Id<str>`, so callers holding stored ids pass `&id`. Minting an owned id at
  a query site just to borrow it = reviewer-reject. Same rule for ANY
  newtype-over-string lookup API: a query path allocates nothing. New id
  newtypes MUST use the shared macro, never a local copy.

### Type Size Discipline (CRITICAL)
`clippy::result_large_err|large_enum_variant|large_stack_arrays|large_futures`
= measurement (our type is fat), not a request to add a pointer.
- Boxing to silence a size lint PROHIBITED, reviewer-reject:
  `Err(Box<MyError>)`, `Variant(Box<MyPayload>)`, `Box<SmallVec<..>>`,
  `field: Box<MyStruct>`, box-only wrapper structs,
  `#[allow(clippy::result_large_err, reason = "…")]` — same defect: fat type
  survives, every construction pays an allocation, error path = only heap
  path. Ditto `Box::new([0u8; N])` where a right-sized `Vec`/`BytesMut`
  belongs.
- Fix the type: measure (`size_of`) → find fat field → shrink. Recurring:
  - `SmallVec<T, N>` inline capacity in cold/cloned type (4×`Str` = 136 B):
    cold+cloned → `Arc<[T]>` (16 B, O(1) clone); cold+uniquely owned →
    `Box<[T]>`. Inline capacity = hot/short-lived/usually-small only; never
    declarations, identities, diagnostics.
  - always-contiguous run (physical indexes, sequence ranges) → two-field
    run/range struct, not a collection.
  - identity struct of several `Str`s cloned into maps/messages/errors → one
    `Arc`-backed handle w/ accessors (8 B, O(1) clone, forwarded
    `Eq`/`Ord`/`Hash`).
  - fields derivable from a sibling | duplicated error↔source → delete.
  - error variant carrying a whole aggregate for a `{:?}` → carry only the
    identifying facts it names.
- One exception: foreign fat types (prost message, provider payload,
  unshrinkable foreign struct) MAY box — that ONE field, never our own
  error/enum around it; comment why on the field.
- Pin the win — shrunk type gets a compile-time guard; regression = build
  failure, not a later lint:
  ```rust
  const _: () = assert!(size_of::<Effects>() <= 96, "Effects must stay compact");
  ```

### Async, Iterator & Codegen Discipline (CRITICAL)
House rules, proven in sibling codebase (tetra). Not suggestions.
- Nightly features = the point of the pinned toolchain. Crate MUST gate
  exactly what it uses atop `lib.rs` — and again in every integration
  test/example (separate crates). Canonical trait-plumbing set:
  `impl_trait_in_assoc_type` + `type_alias_impl_trait` (impls infer
  future/iterator types in assoc-type position); `min_specialization`
  (`default fn` fallbacks); `const_eval_select`/`core_intrinsics` codegen
  hints (`core_intrinsics` also needs
  `#![allow(internal_features, reason = "…")]`). NEVER redesign an API around
  a missing stable feature when a nightly gate gives the zero-cost shape.
- Async traits unboxed; MUST NOT allocate per call. Two sanctioned shapes:
  1. callers never name the future → RPITIT:
     `fn run(&mut self) -> impl Future<Output = T> + Send + '_;`
  2. nameable (stored, composed, downstream trait like `tower::Service`) →
     (generic) associated type, impl-inferred:
     ```rust
     pub trait Deliverable<A: ?Sized>: Send + 'static {
        type Result: Send + 'static;
        type Future<'c>: Future<Output = Self::Result> + Send + 'c;
        fn deliver<'c>(self, target: &'c mut A) -> Self::Future<'c>;
     }
     // impl side — concrete type inferred from the async block:
     type Future<'c> = impl Future<Output = Self::Result> + Send + 'c;
     fn deliver<'c>(self, target: &'c mut A) -> Self::Future<'c> {
        async move { /* … */ }
     }
     ```
  `tower::Service`/hyper same rule: `type Future = impl Future<Output = …>;` —
  never `BoxFuture`. Sync answer → `future::Ready<T>`/`future::ready(v)`, not
  an async block, not a box.
- `#[async_trait]`, `BoxFuture`, per-call `Box::pin`: quarantined — ONLY cold
  `dyn` boundaries dominated by real I/O (DNS, remote storage, connection
  establishment); one allocation per network round trip is noise. Per
  message/frame/token/byte → PROHIBITED. Hot-ish `dyn` → box ONCE at
  construction behind an alias
  (`type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;`),
  never per poll/request.
- Enums before `dyn`: one slot, several concrete types → variant per common
  type + single `Boxed(Pin<Box<dyn Trait>>)` fallback; constructor fast-paths,
  boxes only in the `else` arm; common cases dispatch by `match`,
  allocation-free.
- `#[inline]` on small cross-crate hot-path fns; `#[inline(always)]`
  lint-sanctioned when measured.
- Specialize > runtime dispatch: blanket impl (e.g. `Display`-based
  conversion) as `default fn`; concrete fast paths (`&str`, integers)
  override via `min_specialization`. Generic path correct, common path
  allocation- and format-machinery-free, zero branching.
- Iterators lazy, borrowed, unboxed. Return `-> impl Iterator<Item = …> + '_`
  declaring every capability the chain has (`+ Clone`,
  `+ DoubleEndedIterator`, `+ FusedIterator`, `+ ExactSizeIterator`). Yield
  `&T` | O(1)-clone items (`Str`, `Bytes` slices), never fresh allocations.
  NEVER `.collect()` an intermediate `Vec` just to re-iterate — chain adaptors
  end to end, collect only at the final owner, if at all. Nameable iterator
  type (`IntoIterator::IntoIter`, stored field) → TAIT alias, not a written
  adaptor tower, not a box:
  ```rust
  pub type Iter<'s, T: 's> = impl DoubleEndedIterator<Item = &'s T> + FusedIterator + 's;
  impl<'a, T> IntoIterator for &'a Container<T> {
     type Item = &'a T;
     type IntoIter = Iter<'a, T>;
     fn into_iter(self) -> Self::IntoIter { /* plain adaptor chain */ }
  }
  ```
  Containers impl `IntoIterator` for `&T`/`&mut T`/`T` w/ concrete or TAIT
  types. `Box<dyn Iterator>`: same quarantine as `BoxFuture`.
- Tower-style stacks allocate at construction, not per call. Layers compose
  ONCE at build; a request path never assembles middleware.
  `poll_ready` → `call` MUST run on the SAME instance — readiness on one clone
  says nothing about the clone you call; skipping hides backpressure.
  Borrowed-service contract = hand-rolled pin-projected state-machine future,
  not a box: `NotReady { svc: &'c mut S, msg } → Pending(#[pin] S::Future) →
  Done`; `poll` = `ready!(svc.poll_ready(cx))?` then `svc.call(msg)` on that
  same `&mut S`. Pure delegation forwards the inner future verbatim
  (`type Future = <S as Service<Req>>::Future;`) — no wrapper.
  Exception 1 (narrow, documented): type-erasure handle whose readiness gate
  lives INSIDE the erased call MAY `self.clone().oneshot(req)` in an inferred
  future + always-`Ready` `poll_ready` — requires cheap-clone (`Arc`-backed)
  handle + doc comment on `poll_ready` naming where readiness is enforced.
  Never generalize.
  Exception 2 (measured; `async_stream` middleware only): stream-transforming
  layers (retry/rotate/repair) returning a wrapped response stream MAY
  heap-pin one generator per call behind a TAIT alias
  (`Box::pin(async_stream::stream! { … })` inside
  `impl Stream + Send + Unpin`). Fully-inline composition embeds every inner
  layer's state + poll frames in the parent's; a 7-layer stack MEASURED to
  overflow the thread stack at construction (debug builds). Property of the
  current generator impl, not a law — a hand-written pin-projected machine
  avoids the box; preferred for hot layers. Never cite outside
  stream-returning middleware; dyn erasure ≤ once, at the stack's outer
  boundary. Thin wrappers (permit holders, taps) + short-circuits (`Either`,
  one-shot `stream::once`) stay unboxed via pin-projection.
- Scratch buffers: owned once, recycled — two modes, never conflated. Hot
  encode/frame path owns one pre-sized `BytesMut` (`with_capacity` at a
  measured watermark):
  1. true scratch reuse — contents consumed in place before next round:
     `clear()` between rounds; capacity survives; steady state
     allocation-free.
  2. zero-copy transfer — result escapes: `split().freeze()` hands the filled
     prefix (+ its share of the backing allocation) as `Bytes`; unfilled tail
     remains; later rounds `reserve` (amortized realloc). Price of not
     copying — accept knowingly; don't claim capacity survived.
  Derived views (headers, sub-ranges): `slice(..)` on the frozen `Bytes`,
  never a copy. Storage `CowBytes`/`Str`; assembly `BytesMut`.
- Locks: `parking_lot::{Mutex, RwLock}`, never `std::sync`.
  `tokio::sync::Mutex` ONLY when the guard is genuinely held across `.await`.
- Channels: `flume`, never `tokio::sync::mpsc`/`std::sync::mpsc`. Actor loops:
  single flume mailbox; priority signals (resize, shutdown) ride
  `tokio::watch` + `select!`, not a second queue.

### TUI Rendering Doctrine (crates/tui, CRITICAL)
Port exists because pi's `string[]`+ANSI+`render()` contract was per-frame
heap-grooming. Non-negotiable:
- Text parsed ONCE at the boundary: ANSI/VT decomposed (via `xutf`) where
  external text enters (process output, pastes, files); downstream components
  assume ZERO escapes, store none. Sinks get `render(style, text)`; ANSI
  re-emitted exactly once, at final materialization into the stdout buffer.
- Caches own memory: one pooled text buffer + `(Style, Range)` spans;
  re-present = re-slice, not re-parse. Per-frame line buffers (`Vec<Line>`
  fresh each paint) = bug, not style.
- TML degrades like HTML: unknown tag → `CustomElement` (registered renderer
  if any, else children render, layers like `div`). Bad tag MUST NOT fail the
  document into raw-text fallback.
- Props inherit like CSS: `<col fg=blue>hi</col>` colors w/o explicit
  `<text>`; any prop applies where meaningful; well-known props typed +
  non-allocating, arbitrary KV beside. Color fields accept
  `#xxx`|`#xxxxxx`|`rgb(a)`|`hsl(a)`|`lab`/`oklch`|full HTML names|gradients
  as plain `bg`/`fg` values (with angle) — gradients are values, not special
  elements.
- `UiContext` (charset: ascii | unicode | nerdfont; theme) reaches every
  component; hardcoded colors + hand-emitted glyphs banned. Icons from
  `icons.tsv` (generic name + optional specific alias, per-charset, degrading
  inline). Border defaults themed + dim, not `#fff`.
- `dom!`/`layout!` = canonical construction (typed props, loops, `if`/`match`,
  `IntoComponent` for `&str`/`String`/`Str`/`()`/Vec).
  `write!`/`format!`→`String`→reparse = discouraged path.
- Effects are props, not one-offs: shimmer, hover gradient + eased lift,
  streaming reveal (`<text reveal>`), truncate-from-start, tree/checklist,
  clickable scrollbars, non-committed sidebars — example needs it → reusable
  prop/component in core FIRST. Never example-local visual features.
- Examples near-zero boilerplate (`App` host, a `start`, done). Example
  touching kitty image ids, raw escape dispatch, terminal probing, focus
  routing, clipboard internals ⇒ engine missing the primitive — fix engine,
  not example. The editor itself is built from components for recomposition.
- Alt buffer only where required (overlays, welcome scene). Chat/transcripts
  inline + mouse-selectable; quit restores the terminal cleanly (no stray
  mouse-tracking spam).
- Input = one mailbox: decoded `TerminalEvent`s (real input, debug injections,
  resize) through a single async flume mailbox; resize wins via watch +
  `select!`. No polling `read()` loops, no per-example key tables. Keyboard
  input instantly clears mouse-hover; only ever one visible cursor/focus.

### Porting (from pi)
1. Read pi's impl in extreme detail first — incl. `crates/natives`, compat
   shims, support detection, tests. Missed behaviors (editor keys,
   paste/drag-drop, resize-settling, truncation) = user-reported bugs within
   hours.
2. Copy pi's tests; drop TS-shaped compensations (throttles, GC workarounds,
   UTF-16 defenses — "ts is slow, rust isn't"). Port behavior, not shape:
   reimplement where the shape is wrong (mermaid, slopjson, brush parser);
   never wrap what should be native.
3. Generalize while porting: themed, charset-aware, prop-driven engine
   primitives, not one-example checkmarks.
4. Match pi where good (editor UX, telemetry, statusline semantics, alt-buffer
   resize handling); exceed where weak (renderer contract, error taxonomy,
   providers-as-data).
5. Close pi's gaps (missing builtins, slash-arg completion, …) while in the
   area.

### Locked Deviations from pi (owner decisions — NEVER port back)
"pi does X" is NEVER an argument for any item below. Each was decided
explicitly; regressing to pi shape = defect, not parity. Full audit ledger:
`.plan/parity-regression-audit.md`.
- Extensions/eval: embedded free-threaded CPython only — no JS/TS plugin
  runtime, no multi-language eval; stdlib frozen in-binary.
- Shell: in-process bash parser/interpreter + builtin coreutils; NEVER shell
  out to `/bin/bash` or resolve via `$PATH`. Session shell owns pgids,
  signal escalation (TERM → grace → KILL), persistent cwd/exports,
  process-tree cleanup.
- File edits go through the envd document authority (versioned CAS + fuzzy
  3-way rebase, typed conflict ranges) — never pi's direct disk read/write.
- Tools: minimal fixed wire roster; optional capabilities/MCP ride `dyn`
  builtin devices — NEVER pi's discoverable `loadMode`/dynamic schema
  mutation (prompt-cache invalidation). Versioned identities (`name@rev`);
  single-stream lifecycle (ArgFeed → speculative preview → commit → typed
  verdict), never pi's renderCall/execute/renderResult callbacks; renderers
  consume `IncomingParams` live during streaming, not after settle.
  Charitable arg decoding + faithful raw journaling. Central spill gate +
  `artifact://` addressing — no tool-local string truncation. Every tool
  schema carries the `i` intent param.
- Inference: providers-as-data (catalog/KDL); model-name conditionals
  (`model_id.contains(…)`) and hardcoded model counts/metadata in `.rs` =
  reviewer-reject (lintx-enforced). Typed serde/prost wire structs — no
  `json!`/untyped `Value` traversal. Forced tool calls are caller intents
  with an escalation ladder (soft prompt first; native flags only when
  cache-free). Provider stream frames decode to canonical semantic events,
  never forwarded literally. No vendor server-side tools (lock-in).
- Prompts: scribe compiled templates with banded named slots
  (Frozen/Stable/Dynamic/Volatile); volatile facts (date, cwd, mounts) NEVER
  in a stable prefix; one structured notices channel, not pi's seven ad-hoc
  XML tag formats.
- Control plane: stacked regimes + campaign arbiter (`omp.Decision`,
  `docs/py/15-regimes.md`); the agent loop is a generic hook surface —
  hardcoded per-feature outcome tracking (TTSR-style) prohibited.
- Runtime: tokio + rayon only (custom executor crates prohibited); local
  audio/ML via candle, never C/C++ binding graphs (whisper-rs, llama-cpp).
- Feature graphs earn their weight: a crate enabling a feature whose code it
  never imports (e.g. app → `omp-inference/realtime` → WebRTC/DTLS/
  Opus) is a defect; cold `cargo run --bin omp` build time is a gate. No
  dual-committed catalog formats, no leftover port fixtures, no lockfiles
  nothing reads.

### Working Style
- Orchestrate in parallel: one agent per crate/util/provider/category; `sonic`
  for mechanical moves/renames (`sd`/bash bulk renames, never hand edits);
  scouts only for genuinely unknown files. Sequential one-agent-at-a-time =
  failure mode.
- Finish the whole ask: no scaffolds, no "rest is trivial", no half-ports.
  Done = compiles, wired, exercised.
- Verify by running: TUI changes get real-PTY proof (Testing & QA) before
  claiming done — every input path, resize, quit-cleanup.
- NEVER revert/`git checkout` user edits; user edits/renames in flight —
  adapt to the tree as is.

## Key Files
`Cargo.toml`: members, shared deps, lints, release profile.
`rust-toolchain.toml`/`rustfmt.toml`/`clippy.toml`/`rust-analyzer.toml`:
compiler + enforced style/concurrency policy. `.cargo/config.toml`: vendored
`PYO3_CONFIG_FILE`, required before Cargo resolves `pyo3`. `justfile`: all
commands (sync w/ CI + crate READMEs). `crates/proto/proto` + `build.rs`:
protobuf sources, pure-Rust codegen. `crates/tui/README.md` + `icons.tsv`: TUI
architecture, debug protocol, charset-aware icons. `crates/e2e/README.md`:
harness contract. `crates/py/README.md` + `build.rs`: embedded Python linkage,
generated inputs.

## Runtime/Tooling
- Rust pinned `nightly-2026-08-08` (+ `rustfmt`, `clippy`, `rust-analyzer`);
  NEVER redesign nightly-dependent APIs around stable.
- Cargo for Rust; Bun for JS/TS (never Node/npm/pnpm/yarn); `uv` for Python
  (never pip).
- Tests run under `cargo nextest run` (config: `.config/nextest.toml`), never
  bare `cargo test`. nextest does NOT run doctests, so every recipe pairs it
  with `cargo test --doc`; omp has doctests in 25+ modules (`crates/core`,
  `crates/shell`, `omp_core::slopjson`). Adding a nextest call without the
  doctest half silently drops that coverage. Prefer `just test` /
  `just test-pkg <crate>`, which already run both.
- Protobuf: `protox`; no system `protoc`.
- Workspace env vars `OMP_*` only: `OMP_TUI_DEBUG`, `OMP_TTY`, `OMP_PY_SITE`.
- User configuration lives in `~/.o2` (owner decision; `OMP_CONFIG_DIR` overrides): `config.cfg`,
  agent assets, cfg scripts. Single source: `omp_core::dirs::config_dir` (`CONFIG_DIR_NAME = ".o2"`,
  pinned by test). NEVER put config under the data dir, `~/.omp`, or XDG config; cfg files load
  leniently (`Ctx::exec_configs`) so a stale line from an older build never blocks startup.
  `PYO3_CONFIG_FILE` = required upstream pyo3 exception.
- Release profile deliberate (`opt-level = 2`, thin LTO, 1 codegen unit,
  stripped, unwind panics); change only w/ measured evidence.

### Embedded Python (omp-py)
- `crates/py`: statically links CPython 3.14t (free-threaded), boots
  in-process: `Engine::builder().init()` → `engine.attach(|py| ...)`. Native
  modules: `pyo3::append_to_inittab!` before `init`. `omp-demo` bin ships from
  the same crate. Requires `just setup-python`
  (`crates/py/scripts/fetch-python.sh`) once → gitignored `vendor/python`
  (python-build-standalone archive + derived build inputs).
- Frozen pure-Python packages (e.g. cloudpickle): pinned
  `crates/py/requirements.txt`; fetch script resolves via `uv` → gitignored
  `vendor/python/bundled/` (skipped while stamp matches manifest) +
  regenerates tracked `crates/py/THIRD-PARTY-NOTICES.txt`
  (= `omp_py::THIRD_PARTY_LICENSES`) — rerun after manifest edits, commit the
  notices. Build script only validates stamp + packs; native wheels rejected
  at fetch — those go into site-packages.
- pyo3 via `PYO3_CONFIG_FILE` in `.cargo/config.toml` (default
  `vendor/python/pyo3-config.txt`, fast dev links). Release links
  `vendor/python-release` (`just build-release`); its pgo+lto pbs variant =
  LLVM-22 LTO bitcode, auto-routes through Homebrew LLD 22
  (`brew install lld`, via `crates/py/scripts/ld64.lld`; `needs-lld` marker).
  Enforced loudly by omp-py's build script:
  1. `PYO3_CONFIG_FILE` MUST point at `vendor/python/pyo3-config.txt` before
     cargo runs (repo `.cargo/config.toml` covers members; external crates set
     their own `[env]`/environment) — else pyo3 silently links a host Python.
  2. Consumer bin crates replicate final-link flags `--ld-path=<shim>` +
     `-Wl,-export_dynamic` in their own build script; working examples:
     `crates/app/build.rs`, `crates/e2e/build.rs`.
- Stdlib embedded as marshalled bytecode, served from memory; only real search
  path `$OMP_PY_SITE` (default `~/.local/share/omp-py/site-packages`). End
  users install wheels w/ any free-threaded 3.14 interpreter, no checkout:
  ```sh
  uv python install 3.14t
  uv pip install --python "$(uv python find 3.14t)" \
      --target "${OMP_PY_SITE:-$HOME/.local/share/omp-py/site-packages}" numpy
  ```

### TUI Debugging (`tui` tool, `OMP_TUI_DEBUG`, `OMP_TTY`)
Prefer `.omp/tools/tui.ts`: runs an example/bin on a Bun-native PTY (real
controlling terminal — SIGWINCH resizes + immediate-mode hosts behave as
production); screenshots (`text`, emulator `screen` for any app, pixel `shot`
PNGs from an in-process rasterizer), component trees (`tree`), widget values,
key/mouse/paste injection (each echoing the resulting screen), resizes, raw
byte-stream stats as one session-based tool. Structured ops ride hook 1; hook 2 for external harnesses w/o their own
PTY:
- `OMP_TUI_DEBUG=<unix-socket-path>`: `Terminal::enter` starts a server thread
  on the socket, line-delimited JSON ops (`text`, `tree`, `values`, `keys`,
  `event`, `mouse`, `resize`, `quit`, ...) — see "Debug a running app",
  `crates/tui/README.md`. Wire speaks `TerminalEvent`: injected input rides
  the same mailbox as decoded terminal bytes; `text`/`info` answer from the
  last paint on every host; `frame`/`tree`/`values` = mailbox queries only
  `App` hosts answer (server times out elsewhere); `quit` injects `C-c`.
- `OMP_TTY=<pty-slave-path>`: reroutes ALL terminal I/O (input, rendered
  frames, capability probes, terminal identity) to that device; hold the
  master side to script the UI + capture the exact byte stream a terminal
  would see. stdout untouched.

```python
import fcntl, os, pty, struct, subprocess, termios
master, slave = pty.openpty()
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
proc = subprocess.Popen(
    ["target/debug/examples/gallery"],
    env=dict(os.environ, OMP_TTY=os.ttyname(slave), TERM="xterm-256color"),
)
os.read(master, 65536)          # frames + control sequences
os.write(master, b"\x1b[C")     # keys (write escape sequences)
os.write(master, b"\x03")       # Ctrl-C quits the examples
```

Caveats: set winsize via `TIOCSWINSZ` before spawn (`SIGWINCH` only reaches
the controlling terminal; live resizes don't propagate). Capability probe
waits for replies — answer DA1 (`\x1b[?62c`) or let it time out. Feed the
master stream to a VT emulator (e.g. `pyte`) for screen assertions.

## Testing & QA
- Unit tests colocated in `src` where private behavior matters; public
  contracts + cross-module → `crates/*/tests`.
- `insta` snapshots: shell parser/tokenizer. `proptest`: encoding, zero-copy
  slicing, transcript replay, round-trip invariants. Review snapshots; NEVER
  accept blindly.
- Test at the owning seam: `crates/envd` for environment-host, extension-host,
  and Python-worker behavior; `crates/env` for client/protocol behavior;
  `crates/driver` for headless/session composition; `crates/app` for CLI,
  presentation, and protocol adapters. Prefer these seams over mocks of
  production authority.
- `crates/e2e/tests/p1_doc_race.rs`…`p8_baselines.rs`: authoritative for
  concurrency, cancellation, detached jobs, schema isolation, prefix
  stability, crash/replay, real-PTY lifecycle, recorded perf. Bounded waits +
  RAII-owned processes; preserve both.
- P8 = non-gating recorder (metric math/schema, p95 frame time, token-loop
  throughput). NEVER turn noisy host measurements into an unreviewed hard
  gate.
- TUI changes MUST be exercised on a real PTY via `.omp/tools/tui.ts` (or the
  hooks above): input, resize, clean quit restoration.
- No numeric coverage target. Coverage = changed observable behavior defended:
  branch edges, precedence, state transitions, malformed input, cancellation,
  recovery. Narrow test → affected crate → relevant E2E proof.
