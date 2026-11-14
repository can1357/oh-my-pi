# Design Critic — ADR 0050 S2 fold plan

Mode: REVIEW (Goldfish).
Target: `docs/research/adr0050-s2-fold-plan.md`.
Standard: `.claude/resources/document_standards/feature-spec-standard.md`.
Persona: `.claude/agents/design_critic.md`.
Cited sources only (no other codebase assumptions beyond those paths).

---

## Verdict

The plan correctly names the S1→S2 gap and the ADR exit bullets, but the
**Chosen shape** is too thin to implement against. Handler crossing into
CONTROL, generation merge vs replace-all `set_host_uri_schemes`, and the
production `HostResources = None` path are asserted, not designed. Standard
compliance fails on Alternatives and Risks.

---

## Findings

### 1. Handler API “additive” shape is unspecified — how `register` gains a read body

- **Severity:** blocker
- **Affected scope:**
  `docs/research/adr0050-s2-fold-plan.md:43-44` (Chosen shape §4);
  `crates/py/python/omp/schemes.py:110-140` (`register` today);
  `docs/adr/0050-extension-declared-url-schemes.md:114` (S2 exit: handler body);
  `crates/py/python/omp_rpc/host_uris.py:53-72` (`HostUri` = scheme + `read` callable);
  `crates/rpc/src/client.rs:339-347` (`HostUriHandler::start`).
- **Finding:** S2 exit requires `read` of a declared scheme to return a
  handler body (`0050:114`). Today `omp.schemes.register` accepts only
  `Declaration | str` and stores process-local metadata
  (`schemes.py:110-140`); there is no callable. Chosen shape §4 says
  “register supplies a read callable that CONTROL can invoke (mirror
  existing host-URI / device CONTROL patterns)” without specifying:
  (a) the Python signature (required vs optional kwarg vs new symbol),
  (b) whether the callable is the HostUri-shaped
  `(url, context) -> str|mapping` (`host_uris.py:49`) or the RPC
  `HostUriHandler::start` shape (`client.rs:339-347`),
  (c) how CONTROL names/frames the invoke,
  (d) writable schemes (`Declaration.writable` / `HostUri.write`) relative
  to a “read callable only” sentence.
  ADR D4 (`0050:62`) requires an **additive** ABI. A required new positional
  callable would break S1 callers; an optional handler leaves the exit test
  impossible for registrations without one. “Mirror CONTROL patterns” is not
  a contract — host-URI dispatch is RPC-client↔daemon
  (`client.rs:1388-1475`), not extension CONTROL.
- **Recommendation:** Specify the exact additive API (e.g. optional
  `handler=` on `register`, or a new `omp.schemes.serve(...)` symbol), the
  CONTROL method name and request/response JSON, and that
  `HostResources::resolve_read` is the sole broker into that invoke. State
  whether writable is in or out of S2. Pin one fixture registration that
  supplies the handler the exit test reads.

### 2. Generation ownership vs replace-all `set_host_uri_schemes`

- **Severity:** blocker
- **Affected scope:**
  `docs/research/adr0050-s2-fold-plan.md:35-38` (Chosen shape §1);
  `docs/adr/0050-extension-declared-url-schemes.md:56-56`, `114`, `149`;
  `crates/rpc/src/client.rs:1387-1443`.
- **Finding:** ADR D3 requires one generation that is the **union** of RPC
  host schemes and every live extension’s schemes, and prohibits one
  registration from erasing another (`0050:56`, `149`). The existing client
  API is documented and implemented as **replace every** host-owned scheme
  as one generation (`client.rs:1387-1388`, `1440-1442`:
  `mem::replace` of the whole `HostUriRegistry`). Chosen shape §1 says
  “Envd generation authority … published as one generation (union of RPC
  host claims and live extension claims)” but does not say:
  - who increments the generation and who may call `set_host_uri_schemes`,
  - how an RPC host replace merges with live extension claims instead of
    wiping them,
  - whether extension `register` republishes the full union or patches
    in-place,
  - races between concurrent host replace and extension fold,
  - the hard cap `MAX_HOST_URI_SCHEMES` / `MAX_SCHEMES` = 32
    (`scheme.rs:34-38`, `client.rs:1393-1396`) applied to the **union**
    across many extensions + host.
  The plan’s non-goal deferring stub enablement
  (`adr0050-s2-fold-plan.md:22-23`) conflicts with ADR S2 wording that
  folds into “one `set_host_uri_schemes` generation” (`0050:114`) unless
  the plan explicitly adopts an **envd-internal** generation table that
  only *optionally* ingests RPC host claims — and then that deviation must
  be written down.
- **Recommendation:** Name envd as sole merge authority. Define publish
  as “replace the envd-owned map with the computed union,” and redefine
  (or wrap) RPC `set_host_uri_schemes` as “replace the RPC-host *partition*
  of that union,” never the extension partition. Document the 32-scheme
  budget for the union and the refuse when the union would overflow.
  Resolve the non-goal vs ADR “set_host_uri_schemes generation” wording in
  one sentence.

### 3. Builtin refuse locus is split and under-specified for the named exit test

- **Severity:** major
- **Affected scope:**
  `docs/research/adr0050-s2-fold-plan.md:13-15`, `41-42`;
  `docs/adr/0050-extension-declared-url-schemes.md:114`, `180`;
  `crates/ext/src/scheme.rs:13-18`, `109-135` (parser admits builtins);
  `crates/py/python/omp/schemes.py:56-58`, `78-79` (register refuses builtins).
- **Finding:** Exit test `declared_scheme_fold_refuses_builtin_and_unclaimed`
  requires a **manifest claiming `https` or `pr` refused at the fold**
  (`0050:114`, plan `:13-15`). Rust `SchemeName::parse` has no vocabulary
  and will accept those spellings (`scheme.rs:13-18`, `109-135`); S1 py
  `register` already raises `BuiltinSchemeError` (`schemes.py:78-79`).
  Chosen shape §1/§3 say refuse builtins “at fold using vocabulary
  available to envd/py (not `omp-ext`)” and “Gate register on manifest
  claims + builtin refuse,” but do not define **fold**:
  activation snapshot ingest, first `register`, or envd generation
  publish. A manifest that claims `pr` and never calls `register` must
  still fail the named test at fold — that path is not `schemes.py:78`.
  Dual refuse (py register + envd fold) is fine only if the plan states
  which error surfaces when, and that dense `pr://` resolution is
  preserved because builtins never enter the HostUri map
  (`tool_url.rs` dense forge vs unknown fallback — cited via ADR
  Context / plan exit `pr://` still resolves).
- **Recommendation:** Define fold as the envd step that admits claims into
  the generation map; refuse builtins there with a typed error naming the
  scheme. Keep py register refuse as defense in depth. Spell the test’s
  two asserts (builtin claim at fold; unclaimed name at register) as
  separate failure points and owners (envd vs `omp.schemes`).

### 4. Collision semantics: “first owner wins” lacks ordering and refuse payload

- **Severity:** major
- **Affected scope:**
  `docs/research/adr0050-s2-fold-plan.md:41-42`;
  `docs/adr/0050-extension-declared-url-schemes.md:84`, `127-128`;
  `crates/rpc/src/client.rs:1430-1434` (duplicate → hard error, no owner).
- **Finding:** ADR D6: first claim stands; later claim refused; refusal
  **names both extensions** (`0050:84`). Plan §3: “first owner wins on
  collisions; second refuse names both extensions.” Missing:
  - what orders “first” (activation order, manifest id order, wall clock),
  - whether collision is at manifest-claim fold or at handler register,
  - interaction with intra-manifest `Duplicate` already refused in
    `scheme.rs:74-79`, `213-215`,
  - how this differs from RPC client uniqueness which errors without
    naming owners (`client.rs:1430-1434`).
  Without an explicit total order, two extensions activating in one
  generation are non-deterministic and the exit test “second extension
  same spelling refused” (`plan:50`) is flaky.
- **Recommendation:** Fix an ordering key (e.g. authenticated extension
  identity install order for the generation). Refuse at the same fold
  that publishes the generation. Require the error string/fields to carry
  both extension ids. Add that to the required test list explicitly.

### 5. `HostResources` `None` path makes S2 exit unreachable in production compositions

- **Severity:** blocker
- **Affected scope:**
  `docs/research/adr0050-s2-fold-plan.md:28-29`, `35-38`;
  `crates/envd/src/tools/bridges.rs:95`, `426-431`;
  `crates/envd/src/tool_url/host.rs:41-73`, `66-73`;
  `crates/envd/src/tool_url.rs:578-582` (via plan gap + ADR evidence table);
  `crates/app/src/rpc_mode.rs:2446-2453` (stub).
- **Finding:** Gap inventory correctly notes production often passes
  `None` into `install_unknown_fallback(HostUriResolver)` (`plan:28-29`).
  `HostUriResolver::read` then fails with Unsupported when no broker is
  bound (`host.rs:66-73`). Trait exists (`bridges.rs:426-431`) but the
  plan’s own cited inventory says there is no impl. Chosen shape §1 says
  envd implements `HostResources`, yet never states that **every**
  composition that can load extensions must pass `Some(authority)` into
  `RegistryBridges.host_resources` (`bridges.rs:95`) / 
  `production_url_resolvers`. The RPC-mode composition still answers
  `set_host_uri_schemes` with unsupported (`rpc_mode.rs:2446-2453`); the
  non-goal allows leaving that stubbed “unless required for the exit
  test.” Extension-declared reads do not need the RPC command if envd
  owns the map — but they **do** need a live `HostResources` behind
  `HostUriResolver`. Leaving `None` is a silent failure mode: declared
  scheme parses as `Unknown`, fallback runs, authority missing.
- **Recommendation:** Make “compose installs `Some(envd SchemeAuthority)`
  whenever the unknown fallback is installed” an S2 exit prerequisite,
  independent of enabling RPC `set_host_uri_schemes`. Name the type, where
  it is constructed (envd, not app), and that `bind`/`unbind`
  (`host.rs:18-37`) follow its lifetime. Keep the RPC stub non-goal only
  if the exit test never goes through that command.

### 6. Feature-spec standard: Alternatives and Risks absent from the fold plan

- **Severity:** major
- **Affected scope:**
  `docs/research/adr0050-s2-fold-plan.md` (whole);
  `.claude/resources/document_standards/feature-spec-standard.md:15-27`,
  `37-39`.
- **Finding:** The Alternatives Rule requires rejected designs with
  concrete trade-offs in the specification under review. The fold plan
  proposes a single path (envd authority + carry claims + gate register +
  additive handler) with **no** alternatives table. ADR 0050 has
  alternatives (`0050:131-138`) but those are product-level, not S2
  mechanism choices (envd-owned merge vs client replace-all; CONTROL
  invoke vs in-process py callback; refuse-at-parse in `omp-ext` vs
  refuse-at-fold; always-`Some(HostResources)` vs lazy install). Risks &
  Limits (`feature-spec-standard.md:23-27`) are also missing: generation
  races, 32-scheme union overflow, CONTROL invoke latency/cancellation,
  handler exceptions → `Fault`, and the `None` broker footgun.
  Goals/Non-goals and a sketch of architecture exist; problem statement
  is only by ADR link.
- **Recommendation:** Add a short Alternatives subsection (at least three
  S2 mechanism options with reject reasons) and a Risks & Mitigations
  subsection covering generation merge, union cap, CONTROL failure
  mapping, and `HostResources` installation. One paragraph of problem
  statement restating the S1 inert gap is enough.

### 7. Snapshot carry of `DeploymentManifest.schemes` is named but not contracted

- **Severity:** minor
- **Affected scope:**
  `docs/research/adr0050-s2-fold-plan.md:30-31`, `39-40`;
  `crates/ext/src/scheme.rs:189-245` (`SchemeDeclarations` / `claim`);
  `crates/py/python/omp/schemes.py:14`, `110-140`.
- **Finding:** Gap #3 and Chosen shape §2 say claims must reach the worker
  snapshot / `ExtensionManifest` so `register` can `claim`. The plan does
  not name the snapshot field, serialization, or the Python accessor that
  `register` consults. `SchemeDeclarations::claim`
  (`scheme.rs:238-245`) already encodes unclaimed refuse — reuse vs
  reimplement in py is undecided. Docstring still says registrations are
  inert until S2 (`schemes.py:11-14`).
- **Recommendation:** Name the snapshot field and the single gate call
  (`claim` or equivalent) inside `register` before storing the handler.

### 8. Exit tests omit union / HostResources / generation-merge cases

- **Severity:** minor
- **Affected scope:** `docs/research/adr0050-s2-fold-plan.md:47-52`;
  `docs/adr/0050-extension-declared-url-schemes.md:114`.
- **Finding:** Listed tests cover the ADR exit bullets but not: empty
  broker (`None`) regression, RPC-host scheme coexisting with an
  extension scheme (union), or generation republish after a second
  extension registers. Without those, Chosen shape §1 can ship untested.
- **Recommendation:** Add at least: (1) `Some(authority)` installed in the
  composition under test; (2) two live schemes from different owners both
  readable; (3) optional — RPC partition update does not drop the
  extension scheme (if RPC path stays stubbed, document skip).

### 9. Note — S1 py builtin refuse already overlaps S2 fold refuse

- **Severity:** note
- **Affected scope:**
  `crates/py/python/omp/schemes.py:78-79`;
  `docs/adr/0050-extension-declared-url-schemes.md:180`.
- **Finding:** Not a defect: defense in depth is useful. The ADR gap text
  (`0050:180`) focuses on fold because the Rust manifest still admits
  builtins. Implementers should not remove the py check when adding fold
  refuse.

### 10. Note — `HostUriResolver` already applies `select_bytes`; S3 must not be pulled in

- **Severity:** note
- **Affected scope:**
  `crates/envd/src/tool_url/host.rs:83-84`;
  `docs/research/adr0050-s2-fold-plan.md:19`;
  `docs/adr/0050-extension-declared-url-schemes.md:68-70`.
- **Finding:** Host reads already run `select_bytes` after
  `resolve_read`. S2 non-goal correctly defers declaration-based selector
  grammar / effect judgment to S3. Do not expand S2 into D5 work.

---

## Stress-test summary (requested loci)

| Locus | Result |
|---|---|
| Handler API additive shape | **Fail** — callable + CONTROL path unspecified; ABI risk |
| Generation ownership | **Fail** — union vs replace-all unresolved; 32-cap silent |
| Builtin refuse locus | **Weak** — “fold” undefined; py vs envd split |
| Collision semantics | **Weak** — no ordering key; refuse payload underspecified |
| `HostResources` `None` path | **Fail** — exit needs `Some`; plan does not mandate install |

---

## Standard compliance checklist

| Requirement | Status |
|---|---|
| Problem statement | Weak (ADR cite only) |
| Goals & non-goals | Present (`plan:9-23`) |
| Proposed architecture | Thin bullets (`plan:35-44`) — insufficient for #1–#5 |
| Alternatives considered | **Missing** (blocker for the standard) |
| Risks & mitigations | **Missing** |

---

## Required plan edits before implement

1. Specify additive handler + CONTROL invoke contract (Finding 1).
2. Specify envd-owned union generation and how RPC replace merges (Finding 2).
3. Mandate `Some(HostResources)` on compositions that install the unknown fallback (Finding 5).
4. Define fold + collision order + both-extension refuse (Findings 3–4).
5. Add Alternatives and Risks sections (Finding 6).
