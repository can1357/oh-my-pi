# Implementation readiness — ADR 0050 S3 plan

Mode: REVIEW (Goldfish / Implementation Readiness).
Persona: `.claude/agents/implementation_readiness.md`.
Standard: Zero-Decision Rule + file boundary / actionable steps / tests
(`.claude/resources/document_standards/implementation-readiness-standard.md`).
Target: `docs/research/adr0050-s3-plan.md` (whole).
Normative: `docs/adr/0050-extension-declared-url-schemes.md` D5 (`:66-76`),
S3 exit (`:115`), Decision record condition 3 (`:164`).

---

## Verdict

**Fail — not implementation-ready until two plan amendments land.** File
allowlist, peel seam, `read_fetch` / judgment split, and test outcomes are
mostly actionable. Coding still requires inventing (1) the exact
capability→`fetch`/`credentials` fold rule and input source, and (2) the
`SchemeClaim` / `LiveScheme` / `HostResources` API field shapes and
`UrlResolver::Host` wiring. Resolve those in the plan; then S3 is codeable.

---

## Standard checklist

| Required element | Present? | Notes |
|---|---|---|
| Target scope & file boundary | **Yes** | Allowlist at `adr0050-s3-plan.md:40-49` |
| Actionable steps per file | **Partial** | Outcomes locked; per-file diffs underspecified |
| Phasing & checkpoints | **Partial** | One slice; S2 baseline assumed |
| Data structures / API signatures | **No** | `HostUriJudgment` variants named; fields/methods not signed |
| Test plan (happy + edge) | **Yes** | Seven bullets at `:51-59` |
| Zero design decisions left | **Fail** | Findings 1–3 |

---

## Findings

### 1. Blocker — Capability → flags: truth table and fold input missing

- **Severity:** Blocker
- **Affected scope:** Locked decision 2 (`adr0050-s3-plan.md:22-22`);
  `crates/envd/src/worker.rs:1478-1525` (`fold_declared_schemes`);
  `crates/envd/src/worker.rs:1066-1087` (manifest snapshot capabilities);
  `crates/driver/src/secrets/mod.rs:47-55` (`credentials.allow`);
  `crates/envd/src/tool_url/scheme_generation.rs:30-56` (`LiveScheme` /
  `SchemeClaim` today: no effect flags).
- **Finding & Guidance:** “`env.net.fetch`, credentials allow” is not an
  executable rule. At FREEZE fold the function only sees
  `generation` / `identity` / FREEZE `payload` (`worker.rs:1487-1490`) and
  only reads `payload["schemes"]`. Implementer must invent:
  - whether `fetch` is `capabilities`/`data_grants` contains `env.net.fetch`;
  - whether `credentials` is non-empty `capability_grants["credentials.allow"]`,
    any `[[credential]]` row, or something else;
  - whether those bits are read from FREEZE payload, `ExtensionManifest` at
    the call site (`worker.rs:1453`, `:1478-1479`), or an extended snapshot;
  - `credentials` without `env.net.fetch` → `Unknown` vs `Fetch { true }` vs
    refuse.
  Pin the amendment text from the dual-review synthesis before coding.

### 2. Blocker — API shapes left to the implementer

- **Severity:** Blocker
- **Affected scope:** Decisions 1, 3 (`adr0050-s3-plan.md:16-24`);
  `crates/envd/src/tools/bridges.rs:426-432` (`HostResources` today:
  `resolve_read` / `resolve_write` only);
  `crates/envd/src/tool_url.rs:454-463` (`UrlResolver::Host` hardcodes
  `Some(FetchEffects { credentials: false })` and ignores the inner
  resolver);
  `crates/envd/src/tool_url/host.rs:52-54` (`HostUriResolver` has no
  `read_fetch` override; `Resolve` default returns `None` at
  `resolver.rs:374-376`);
  `crates/envd/src/tool_url/scheme_generation.rs:109-223` (no `is_live` /
  `judge`).
- **Finding & Guidance:** Plan names `HostUriJudgment` variants and says
  “on `HostResources` (and `SchemeGeneration`)” and “consult generation
  judgment” but does not lock:
  - method signature (e.g. `fn judge(&self, url: &str) -> HostUriJudgment`);
  - `SchemeClaim` / `LiveScheme` fields (`fetch: bool`, `credentials: bool`
    vs stored `Option<FetchEffects>` vs stored judgment);
  - `SchemeGeneration::is_live(&str)` exact API;
  - how `UrlResolver::Host` reaches the broker (`Host(resolver) =>
    resolver.read_fetch(...)` after implementing `read_fetch` on
    `HostUriResolver` that calls `broker.judge`, vs matching on a new field).
  Without this, two correct-looking PRs diverge on public envd API. Amend the
  plan with the signatures in the synthesis.

### 3. Major — Peel helper placement still a choice

- **Severity:** Major
- **Affected scope:** Decision 5 (`adr0050-s3-plan.md:30-30`); allowlist
  `:45-47`; `host.rs:74-84` (rebuilds URL from opaque `parsed.resource`, then
  `select_bytes` with caller selector — `None` for Unknown).
- **Finding & Guidance:** “`HostUriResolver::read` (or shared helper)” and
  optional `read/selector.rs` leave the peel home ambiguous. Correct seam is
  post-`parse_uri`, live-only, inside envd (caller selector stays `None` for
  `Scheme::Unknown`). Do **not** set `accepts_selectors(Unknown) = true`.
  Pin: peel in `host.rs` (optionally extract a private helper in
  `scheme_generation.rs` or `tool_url.rs`); only touch `tools` selector code
  if extracting a pure line-chunk splitter already shared — otherwise drop
  `selector.rs` from the allowlist.

### 4. Major — `read@3` / tools allowlist may be overstated

- **Severity:** Major
- **Affected scope:** `adr0050-s3-plan.md:26-28`, `:47`;
  `crates/tools/src/read.rs:821-825`, `:971`.
- **Finding & Guidance:** Decision 4 says Foreign path must not push
  `Effects::unknown()` through `invocation_effects`. Today Foreign already
  only unions `read_unknown_fetch` → `Option<FetchEffects>`
  (`read.rs:971`). If Host `read_fetch` returns `None` for
  Unknown/Undeclared/Local and `Some(e)` for Fetch, **tools `read.rs` may
  need zero logic changes**. Plan should say “touch `read.rs` only if
  judgment cannot stay behind envd `read_fetch` / HostResources.” Avoid
  speculative edits.

### 5. Nit — Test harness details

- **Severity:** Nit
- **Affected scope:** Tests (`adr0050-s3-plan.md:51-59`);
  `crates/envd/tests/declared_scheme_fold.rs:19-26` (`claim()` helper will
  break when `SchemeClaim` gains fields).
- **Finding & Guidance:** Outcomes are clear. Name the primary crate path
  (`declared_scheme_s3.rs` vs extend fold suite), and that judgment tests call
  `HostResources::judge` / `SchemeGeneration::judge` directly (not
  `Tool::invocation_effects`). Update `claim()` defaults (`fetch: false`,
  `credentials: false` → judgment `Unknown`).

---

## What is already actionable

- Exit matrix matches ADR S3 + D5 condition surfaces (`plan.md:7-12`).
- Drop blanket Host fetch (`tool_url.rs:463`) and fix stale doc (`:438-453`).
- Do not push `Effects::unknown()` into `invocation_effects` (decision 4).
- Selector opacity for undeclared + `mcp://`; live-only peel (decision 5).
- S2 suite must stay green (test 7); non-goals S4/S5/vocab/RPC enablement.
