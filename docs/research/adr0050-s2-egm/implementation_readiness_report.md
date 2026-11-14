# Implementation readiness — ADR 0050 S2 fold plan

Mode: REVIEW (Goldfish / Implementation Readiness)
Persona: `.claude/agents/implementation_readiness.md`
Standard: `.claude/resources/document_standards/implementation-readiness-standard.md`
Target: `docs/research/adr0050-s2-fold-plan.md` (whole document)
Normative: `docs/adr/0050-extension-declared-url-schemes.md` (D1–D7, S2 exit, Status in omp)
Code (read for grounding only): `crates/py/python/omp/schemes.py`,
`crates/ext/src/scheme.rs`, `crates/envd/src/tool_url.rs`,
`crates/envd/src/tool_url/host.rs`, `crates/rpc/src/client.rs` (`set_host_uri_schemes`),
`crates/py/tests/schemes_contract.rs`, `control_manifest_snapshot` path.

## Verdict

**Fail — not implementation-ready.** Exit criteria and gaps are clear enough to
know *what* must become true, but the plan leaves multiple design choices to the
implementer (Zero-Decision Rule). A competent engineer cannot produce the correct
S2 change on the first attempt without inventing: the `HostResources` type and
file, the `register` read-handler signature, how manifest claims reach the worker,
how envd refuses built-in wire names without an `omp-ext` vocabulary dep, and how
CONTROL invokes the Python handler. Resolve the blockers below in the plan (or a
follow-on fold-plan amendment) before coding.

## Standard checklist

| Required element | Present? | Notes |
|---|---|---|
| Target scope & file boundary | **No** | No repository-relative allowlist of files to create/modify/delete |
| Actionable steps per file | **No** | Chosen shape is four bullets; no logic/API updates per path |
| Phasing & checkpoints | **No** | One slice; no incremental buildable phases inside S2 |
| Data structures / API signatures | **Partial** | Reuses S1 types; new `register` callable and envd authority unspecified |
| Test plan (happy + edge) | **Partial** | Names outcomes; omits crate, fixture paths, harness, assertions |
| Migration / rollback | N/A for S2 | Additive; no schema migration |
| Zero design decisions left | **Fail** | See findings |

## Findings

### 1. Blocker — No file allowlist; implementer must invent the change surface

- **Severity:** Blocker
- **Affected scope:** Entire fold plan (`adr0050-s2-fold-plan.md:25-44`); standard
  "Target Scope & File Boundary".
- **Finding & Guidance:** The plan names crates (`omp-ext`, `omp-py`, envd) and
  symbols (`HostResources`, `install_unknown_fallback`, `omp.schemes.register`) but
  never lists exact paths. From current code, S2 *must* at least touch:

  **Must modify (inferred — plan must confirm):**
  - `crates/py/python/omp/schemes.py` — gate `register` on manifest claims; accept
    read callable; stop being process-local-only
    (`schemes.py:110-140` stores `_declared` under a lock with no host publish).
  - `crates/envd/src/worker.rs` — `control_manifest_snapshot`
    (`worker.rs:1030-1075`) omits `schemes`; worker bootstrap cannot gate register.
  - `crates/py/python/omp/_registry.py` — `configure_manifest` /
    `bootstrap_extension_registry` (`_registry.py:607-620`, `:1835-1855`) have no
    `schemes` parameter.
  - `crates/envd/src/exthost/lifecycle.rs` — `ExtensionManifest`
    (`lifecycle.rs:1005-1029`) has no `schemes` field.
  - `crates/driver/src/discovery/native.rs` — `lower_manifest`
    (`native.rs:512-608`) builds `ExtensionManifest` from
    `DeploymentManifest` and drops `manifest.schemes`
    (`config.rs:1385-1388`).
  - `crates/envd/src/tools/bridges.rs` — first production `HostResources` impl
    (trait at `bridges.rs:426-432`; **zero `impl HostResources` exists in tree**).
  - `crates/envd/src/tool_url/host.rs` / `tool_url.rs` — wire the impl into
    `install_unknown_fallback` (`tool_url.rs:578-583`); today
    `host_resources: Option` is usually `None` (`app/src/cli.rs:3239-3244` passes
    `None`; `driver/src/headless/kernel.rs:2579-2606` defaults
    `host_resources` via `..default()`).
  - `crates/py/python/omp/_host.py` — CONTROL dispatch table
    (`_host.py:1132-1160`) has no `omp.schemes.*` callback for host→worker read.
  - `crates/py/tests/schemes_contract.rs` — extend beyond inert S1 contract.
  - New or extended envd/e2e tests for the named exit test and read/collision/`pr://`
    cases.

  **Likely touch (plan must say yes/no):**
  - `crates/rpc/src/client.rs:1387-1475` / `crates/rpc/src/protocol.rs:476-502` —
    only if the publish surface is literally `set_host_uri_schemes` (ADR S2
    wording at `0050-…md:114` vs plan Chosen shape §1 at
    `adr0050-s2-fold-plan.md:35-38`).
  - `crates/app/src/rpc_mode.rs:2446-2451` — stubbed unsupported; plan non-goal
    says skip unless exit test needs it (`adr0050-s2-fold-plan.md:22-23`).
  - `crates/driver/src/bridges.rs:220-246` — `builtin(..., host_resources)` must
    receive the envd-owned authority instead of `None`.
  - `crates/ext/src/scheme.rs` — already has `SchemeDeclarations::claim`
    (`scheme.rs:238-245`) and `SchemeError::Unclaimed` (`scheme.rs:86-91`); may
    need no change if gating is py/envd-only.

  The plan must emit an explicit allowlist before Phase 5 write enforcement.

### 2. Blocker — `HostResources` authority shape is unspecified

- **Severity:** Blocker
- **Affected scope:** Chosen shape §1 (`adr0050-s2-fold-plan.md:35-38`); gaps §2
  (`:28-29`); code `bridges.rs:426-432`, `host.rs:40-84`, `tool_url.rs:570-583`.
- **Finding & Guidance:** Plan says envd owns "scheme → {owner, flags, dispatch}"
  and implements `HostResources`. Missing decisions the implementer would invent:

  1. **Type name and file** (e.g. `crates/envd/src/tool_url/scheme_generation.rs`
     vs inside `host.rs`).
  2. **Map fields:** map 1:1 onto existing `HostUriScheme`
     (`protocol.rs:490-501`: `scheme`, `description`, `writable`, `immutable`) plus
     owner id + dispatch handle — do not invent a parallel flag vocabulary (see
     also zoom-out finding on `{owner, flags, dispatch}`).
  3. **Publish surface:** ADR S2 / D3 name `set_host_uri_schemes` generation
     replace (`0050-…md:52-56`, `:114`). Plan Chosen shape never names that API
     and invents an "envd generation authority". Decide explicitly:
     - **(A)** In-process `HostResources` that *is* the generation (union table +
       `resolve_read` dispatch); RPC `set_host_uri_schemes` stays unused on the
       chat/envd path for S2 (allowed by non-goal `:22-23`), **or**
     - **(B)** Literally call / mirror `set_host_uri_schemes` semantics into the
       same generation registry the RPC client already mutates
       (`client.rs:1387-1475`).
     Do not leave both readings open — a second scheme table is the rejected
     alternative (`0050-…md:138`).
  4. **Who constructs and injects** the `Arc<dyn HostResources>` into
     `RegistryBridges.host_resources` (`bridges.rs:94-95`) for
     `production_url_resolvers` (`tool_url.rs:570-583`) and for
     `driver`/`app` compositions that today pass `None`.
  5. **`resolve_write`:** trait requires it (`bridges.rs:430-431`). S2 exit is
     read-only. Specify: refuse writes with a fixed error, or honor
     `writable` + handler. Silence = design choice.

### 3. Blocker — `omp.schemes.register` API for the read handler is undefined

- **Severity:** Blocker
- **Affected scope:** Chosen shape §4 (`adr0050-s2-fold-plan.md:43-44`); gap §4
  (`:31`); `schemes.py:110-140`; mirror `HostUri` (`host_uris.py:49-72`).
- **Finding & Guidance:** Current `register(*declarations: Declaration | str)`
  accepts only declarations/spellings and appends to `_declared`
  (`schemes.py:110-140`). Plan says "register supplies a read callable that
  CONTROL can invoke" with no signature. Zero-Decision requires locking:

  ```text
  register(declaration | str, *, read: Callable[[str, SchemeContext], str | Mapping]) -> Declaration
  # OR HostUri-shaped:
  register(scheme, read=..., write=None, description=..., immutable=...)
  ```

  Specify: argument order; whether bare `str` still allowed without `read`
  (must refuse — exit needs handler body); context type (reuse
  `HostUriContext` shape from `host_uris.py:32-46` vs new `SchemeContext`);
  return type; and the CONTROL operation name registered in
  `_host.py` dispatch table (today there is no `omp.schemes.read` —
  `_host.py:1132-1160`). "Mirror existing host-URI / device CONTROL patterns"
  is not actionable without naming the pattern (`NestedCallbackDispatcher::dispatch_host`
  at `dispatch.rs:640-680` vs a new authority factory).

### 4. Blocker — Manifest claims never reach the worker snapshot

- **Severity:** Blocker
- **Affected scope:** Chosen shape §2 (`adr0050-s2-fold-plan.md:39-40`); gap §3
  (`:30`); `control_manifest_snapshot` (`worker.rs:1030-1075`);
  `ExtensionManifest` (`lifecycle.rs:1005-1029`); `lower_manifest`
  (`native.rs:588-598`); `bootstrap_extension_registry`
  (`_registry.py:1835-1855`).
- **Finding & Guidance:** `DeploymentManifest.schemes` exists
  (`config.rs:1385-1388`) and `SchemeDeclarations::claim` can gate spellings
  (`scheme.rs:238-245`). The activation path drops them:

  1. `lower_manifest` does not copy `manifest.schemes` into
     `ExtensionManifest`.
  2. `ExtensionManifest` has no schemes field.
  3. `control_manifest_snapshot` JSON keys are
     `extension`, `tools`, `hooks`, `capabilities`, `services`, `requires`,
     `trust_runtime_declarations`, optional `declarations` — **no `schemes`**
     (`worker.rs:1055-1072`).
  4. Python `configure_manifest` / `bootstrap_extension_registry` never install
     claimed schemes (`_registry.py:1844-1855`).
  5. `omp.schemes.register` therefore cannot "gate on the loaded manifest's
     claims" (`0050-…md:114`) — there is no claims set in the worker.

  Plan must specify the JSON snapshot field shape (array of
  `{name, description?, immutable, writable}` matching
  `SchemeDeclaration` at `scheme.rs:175-187`), which Rust structs gain the
  field, and the Python API that exposes claims to `register` (e.g.
  `configure_manifest(schemes=...)` stored on the registry).

### 5. Blocker — Built-in refuse-at-fold location and vocabulary source unspecified

- **Severity:** Blocker
- **Affected scope:** Exit named test (`adr0050-s2-fold-plan.md:13-15`, `:48`);
  ADR Status / S2 (`0050-…md:114`, `:180`); Chosen shape §1
  (`adr0050-s2-fold-plan.md:37-38`); S1 split
  (`scheme.rs:16-18`, `schemes.py:56-58`).
- **Finding & Guidance:** ADR requires: a manifest claiming `https` or `pr` is
  refused **at the fold**, and registering an unclaimed name is refused
  (`0050-…md:114`, `:180`). Today:

  - `crates/ext` **cannot** refuse built-ins (no vocab dep; documented at
    `scheme.rs:16-18`). A manifest with `[[schemes]] name = "https"` parses.
  - `omp.schemes` **does** refuse built-ins via packed
    `_omp_url_vocab` (`schemes.py:56-79`) — but only if `register` /
    `Declaration` runs; inert S1 never folds.
  - Envd has **no** packed `url-vocab.json` consumer today.

  Plan says refuse "using vocabulary available to envd/py (not `omp-ext`)" but
  does not say: refuse in Python `register` only; refuse in envd when publishing
  the generation (how does envd load wire names?); or both. The named test
  `declared_scheme_fold_refuses_builtin_and_unclaimed` needs a home crate and a
  definition of "fold" (manifest admit vs `register` vs generation publish).
  Without that, implementers will disagree on whether a claim of `https` that
  never calls `register` is already a failure.

### 6. Blocker — Collision / first-owner semantics lack error contract and publish timing

- **Severity:** Blocker
- **Affected scope:** Chosen shape §3 (`adr0050-s2-fold-plan.md:41-42`); ADR D6
  (`0050-…md:84`); Exit (`adr0050-s2-fold-plan.md:11`).
- **Finding & Guidance:** "First owner wins; second refuse names both extensions"
  leaves open: exception type/name in Python and/or Rust; message format; whether
  collision is detected at `register` time or at generation republish; whether
  RPC-host claims outrank extensions or share one namespace; what happens when
  the union would exceed `MAX_HOST_URI_SCHEMES` / `MAX_SCHEMES` = 32
  (`protocol.rs:477`, `scheme.rs:38`, `schemes.py:51`). Lock the refuse rule and
  the generation-cap overflow behavior in the plan.

### 7. Major — No ordered implementation steps / phases

- **Severity:** Major
- **Affected scope:** Whole plan; standard "Phasing & Checkpoints" and
  "Actionable Steps".
- **Finding & Guidance:** Chosen shape is unordered architecture. Required
  ordered steps (proposal the plan must adopt or replace — not optional once
  blockers 1–6 are fixed):

  1. Carry `DeploymentManifest.schemes` → `ExtensionManifest` →
     `control_manifest_snapshot` → `configure_manifest` (buildable; no behavior
     change yet; unit-test snapshot JSON includes `schemes`).
  2. Gate `omp.schemes.register` on snapshot claims + keep built-in refuse;
     still no resolver bind; extend `schemes_contract.rs`.
  3. Add envd `HostResources` generation authority; inject into
     `RegistryBridges` / `production_url_resolvers`; empty generation = current
     "unavailable" behavior for undeclared unknowns.
  4. On successful `register` (with read handler), claim into the generation;
     CONTROL path invokes handler; `read` / `omp.urls.read` of
     `widget://…` returns body through `HostUriResolver` + `select_bytes`
     (`host.rs:78-84`).
  5. Collision + built-in-at-fold tests; prove `pr://` still hits dense forge
     resolver (`tool_url.rs` forge register path, not unknown fallback).
  6. Run `just test-pkg omp-ext`, `just test-pkg omp-py`, owning envd package
     tests, and any new exit-named test.

  Each step must leave the tree building and the prior S1 contracts green.

### 8. Major — Test locations and harnesses are underspecified

- **Severity:** Major
- **Affected scope:** Tests section (`adr0050-s2-fold-plan.md:46-52`); Exit
  (`:10-15`).
- **Finding & Guidance:** Required outcomes are named; homes are not. Specify:

  | Case | Proposed home (confirm in plan) |
  |---|---|
  | `declared_scheme_fold_refuses_builtin_and_unclaimed` | `crates/py/tests/schemes_contract.rs` and/or new `crates/envd/tests/…` if fold is envd-side |
  | `widget://` read returns handler body | envd integration with fixture extension (mirror `crates/envd/tests/manifest_control_declarations.rs` / e2e `pyext` patterns) |
  | Second extension same spelling refused | same harness; two ExtHostSpecs |
  | `pr://` still dense forge | envd/tools test with `cap-forge` or existing forge URL test; assert **not** `HostUriResolver` |
  | S1 non-regression | `just test-pkg omp-ext`, `just test-pkg omp-py` (already stated) |

  Also specify fixture layout (minimal `omp.toml` / `[[schemes]] name = "widget"`,
  entry module calling `omp.schemes.register(..., read=...)`), and exact
  assertions (body bytes, error type containing both extension ids, built-in
  `BuiltinSchemeError` vs new fold error).

### 9. Major — Production wiring still passes `None` for `host_resources`; plan understates the inject sites

- **Severity:** Major
- **Affected scope:** Gap §2 (`adr0050-s2-fold-plan.md:28-29`);
  `cli.rs:3239-3244`; `kernel.rs:2579-2606`; `bridges.rs:220-246`;
  `session.rs:899` (one path discards `host_resources: _` when building
  `SessionRegistryBridges`, while `production_registry` keeps it —
  `registry.rs:1676-1747`).
- **Finding & Guidance:** Installing a `HostResources` impl is insufficient
  unless every composition that builds the production URL table receives it.
  Plan must list inject call sites: `omp_driver::bridges::builtin`,
  `compose_kernel` / headless bridges, `Command::Envd`, and confirm whether
  `open_session_host`'s `session_registry` path needs `host_resources` plumbed
  through `SessionRegistryBridges` (today it does not —
  `registry.rs:1477-1486`, `session.rs:899`).

### 10. Nit — Handler path "additive" vs process-local `_declared`

- **Severity:** Nit
- **Affected scope:** `schemes.py:59-60`, `:110-140`; Chosen shape §4.
- **Finding & Guidance:** Process-local `_declared` can remain as a mirror of
  successful claims, but S2 must define the publish side effect (envd generation
  update) and what happens across reload (out of scope for S2 per non-goals
  `:19`, but register must not assume process-global singleton survives host
  restart without stating it). One sentence avoids a footgun.

## Missing APIs (summary)

| API / type | Status | Decision needed |
|---|---|---|
| `HostResources` production impl | Missing entirely | Name, file, fields, inject sites, `resolve_write` policy |
| Generation publish / union | Concept only | In-process authority vs `set_host_uri_schemes` |
| `omp.schemes.register(..., read=)` | Missing | Signature, context type, CONTROL op name |
| Manifest `schemes` in worker snapshot | Missing | JSON shape + Rust/Python carry path |
| Claim gate in Python registry | Missing | `configure_manifest(schemes=…)` or equivalent |
| Fold refuse for built-in wire names | Partial (py register only) | Where "fold" runs; envd vocab source |
| Collision error naming both owners | Missing | Type + message contract |
| Union > 32 schemes | Unspecified | Refuse rule |

## Concrete files to touch (minimum allowlist draft)

Use this as the plan's allowlist once blockers are resolved; strike any path the
amended plan rejects.

- `crates/ext/src/scheme.rs` — only if claim helpers need export tweaks
- `crates/envd/src/exthost/lifecycle.rs` — `ExtensionManifest` + constructors
- `crates/driver/src/discovery/native.rs` — carry schemes in `lower_manifest`
- `crates/envd/src/worker.rs` — `control_manifest_snapshot`
- `crates/py/python/omp/_registry.py` — `configure_manifest` / bootstrap
- `crates/py/python/omp/schemes.py` — claim gate + read handler + publish hook
- `crates/py/python/omp/_host.py` — CONTROL dispatch for scheme read
- `crates/envd/src/tools/bridges.rs` and/or new `crates/envd/src/tool_url/scheme_authority.rs`
- `crates/envd/src/tool_url/host.rs` / `tool_url.rs` — bind authority
- `crates/envd/src/tools/roster_host.rs` / `registry.rs` / `server/session.rs` — plumb `host_resources` where dropped
- `crates/driver/src/bridges.rs`, `crates/driver/src/headless/kernel.rs`, `crates/app/src/cli.rs` — inject authority
- `crates/py/tests/schemes_contract.rs` — S1 + claim-gate + fold refuse
- New: `crates/envd/tests/<declared_scheme_fold…>.rs` (or e2e fixture) for read / collision / `pr://`

Do **not** modify unless plan explicitly requires: `crates/tools/url-vocab.json`,
`Scheme` enum, `crates/app/src/rpc_mode.rs` stub (non-goal), S3 selector/effects
paths (`tool_url.rs:453` D5 — deferred).

## Ordered implementation steps (once plan is amended)

1. Snapshot carry (Rust → JSON → Python configure) + unit tests.
2. Gate `register` on claims; keep built-in refuse; still inert to resolver.
3. Implement and inject `HostResources` generation (empty OK).
4. Bind read handler via CONTROL; publish claims into generation on register.
5. Exit tests: named fold refuse, `widget://` body, second-extension refuse,
   `pr://` dense path.
6. Package tests: `just test-pkg omp-ext`, `just test-pkg omp-py`, envd-focused
   tests for the new harness.

## Blockers (must clear before implement)

1. Explicit file allowlist.
2. `HostResources` type/file + inject sites + `resolve_write` policy.
3. Choose publish surface (A in-process generation vs B `set_host_uri_schemes`)
   without a second table.
4. Exact `register` + CONTROL read API.
5. Manifest schemes carry into worker snapshot + Python configure.
6. Definition of "fold" for built-in refuse + test home.
7. Collision and generation-cap error contracts.
8. Test harness paths and fixture contents.

## Intentionally out of scope (plan OK)

- S3 line selectors and declaration-based effect judgment (D5 prerequisite)
  (`adr0050-s2-fold-plan.md:18-19`; `tool_url.rs:450-462` blanket
  `FetchEffects` stays for S2).
- S4 reload / quarantine rebind.
- S5 model-facing listing / conformance suite.
- Enabling RPC-mode `set_host_uri_schemes` stub unless exit test requires it.

## Residual risks after amendment

- First-ever `HostResources` impl may expose latent bugs in
  `HostUriResolver` when broker is `Some` (path previously always failed open
  with "unavailable" at `host.rs:71-73`).
- `session_registry` vs `production_registry` dual paths can leave one composition
  without the authority if inject sites are incomplete.
- CONTROL callback latency/cancellation for scheme reads needs the same
  deadlines policy as device callbacks; unspecified timeout is a footgun.
