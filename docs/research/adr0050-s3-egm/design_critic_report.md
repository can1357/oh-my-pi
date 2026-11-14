# Design Critic — ADR 0050 S3 plan

Mode: REVIEW (Goldfish).
Target: `docs/research/adr0050-s3-plan.md`.
Standard: ADR D5 + S3 exit (`docs/adr/0050-extension-declared-url-schemes.md:66-76`, `:115`, `:164`);
feature-spec vectors (assumptions, risks, alternatives).
Persona: `.claude/agents/design_critic.md`.

---

## Verdict

**Pass with required plan amendments (no architecture rewrite).** Exit bullets and
the subset-safe D5 split (`HostUriJudgment` vs `read@3` envelope) are coherent
against today’s `Option<FetchEffects>` / subset gate. Two gaps must be written
into the plan before coding: the exact capability→flag rule (incl. data source
at FREEZE fold), and an explicit reconciliation of ADR D5’s “exec approval tier”
sentence with Locked decision 4.

---

## Findings

### 1. Capability → `fetch` / `credentials` rule is not a closed design

- **Severity:** Blocker (plan must change before coding)
- **Affected scope:**
  `docs/research/adr0050-s3-plan.md:22-22` (Locked decision 2);
  `docs/adr/0050-extension-declared-url-schemes.md:60-60`, `:74-76` (D4/D5);
  `crates/envd/src/worker.rs:1487-1525` (fold reads FREEZE `schemes` only);
  `crates/envd/src/worker.rs:1066-1087` (snapshot carries `capabilities` string
  list, not `credentials.allow`);
  `crates/driver/src/secrets/mod.rs:47-55` (`credentials.allow` lives in
  `capability_grants`);
  `crates/ext/src/scheme.rs:172-173` (effects ride capabilities, not
  `[[schemes]]`).
- **Finding:** Decision 2 says derive flags from `env.net.fetch` and
  “credentials allow”, then store on `LiveScheme` / `SchemeClaim`, but never
  locks (a) the boolean truth table, (b) whether flags are per-extension and
  copied onto every claim, (c) the FREEZE/fold input that supplies them.
  `fold_declared_schemes` today only walks `payload["schemes"]`
  (`worker.rs:1493-1521`). `credentials.allow` is a structured grant
  (`capability_grants`), not an `env.*` string in `data_grants`. Without a
  closed rule, S3 can ship three incompatible judgments for the same manifest.
- **Recommendation:** Amend Locked decision 2 with the exact text in the
  synthesis below (truth table + fold inputs). Refuse inventing a new
  `[[schemes]]` effect field (ADR D4).

### 2. ADR D5 “exec approval tier” vs Locked decision 4 (subset-safe envelope)

- **Severity:** Blocker (plan must change before coding — prose only)
- **Affected scope:**
  `docs/adr/0050-extension-declared-url-schemes.md:74-76`, `:164`;
  `docs/research/adr0050-s3-plan.md:11-12`, `:16-20`, `:26-28`, `:53`;
  `crates/tools/src/read.rs:821-825`, `:960-972`;
  `crates/agent/src/dispatch.rs:2186-2207`;
  `crates/tool/src/lib.rs:609-626` (`Effects::unknown` = exec ceiling).
- **Finding:** ADR D5 says omit fetch+credentials → `Effects::unknown()` /
  exec tier (`0050:74-76`, `:164`). The plan correctly observes that pushing
  that envelope through `invocation_effects` fails subset against `read@3`’s
  declared max (`adr0050-s3-plan.md:26-28`) and instead asserts
  `HostUriJudgment::Unknown` while the Foreign tool path carries **no fetch**
  (Read-tier local envelope). That is a sound resolution of ADR’s own
  contradiction (“local read” vs “exec tier” at `0050:74`), and of
  `read_fetch: Option<FetchEffects>` not being able to express unknown
  (`0050:76`). It is **not** yet written as an intentional supersession of the
  ADR’s “exec approval tier” clause for the live `read@3` call. Implementers or
  reviewers will “fix” the ADR by injecting `Effects::unknown()` into
  admission and break every omit-case read.
- **Recommendation:** Keep Locked decision 4. Add the explicit D5 admission
  amendment text in the synthesis so the Host judgment API is the sole place
  the omit case is named `Unknown` / `Effects::unknown()` **facts**, while
  tool admission stays subset-safe.

### 3. Selector peel must not flip `Scheme::Unknown::accepts_selectors`

- **Severity:** Major
- **Affected scope:**
  `docs/research/adr0050-s3-plan.md:30-30`, `:45-47`;
  `docs/adr/0050-extension-declared-url-schemes.md:32`, `:68-70`, `:115`;
  `crates/tools/src/read/selector.rs:679-680`;
  `crates/tools/src/read/resolver.rs:238-240`;
  `crates/envd/src/tool_url/host.rs:52-84`.
- **Finding:** Exit requires declared live schemes to peel line grammar while
  undeclared `Unknown` and `mcp://` stay opaque. Today opacity is
  `accepts_selectors == false` for `Unknown`/`Mcp` (`resolver.rs:238-240`).
  Peeling inside `HostUriResolver` when `SchemeGeneration::is_live` is the
  right seam. Touching `accepts_selectors` or unconditional `parse_uri` peel
  would fail `custom://pending:raw` / `mcp://…:N`. Allowlisting
  `read/selector.rs` without a “do not change Unknown opacity” guard invites
  that mistake.
- **Recommendation:** Pin peel to post-parse, live-only, shared line grammar
  (same chunks built-ins use, including `:raw` modifiers if that is the shared
  grammar). State explicitly: `Scheme::accepts_selectors` for `Unknown`/`Mcp`
  stays false.

### 4. Feature-spec hygiene: no Alternatives / Risks

- **Severity:** Major (standard compliance; not an architecture defect)
- **Affected scope:** `docs/research/adr0050-s3-plan.md` (whole); feature-spec
  Alternatives Rule + Risks & Limits.
- **Finding:** The plan locks a shape but does not record rejected alternatives
  (e.g. flipping `accepts_selectors`; stuffing unknown into
  `invocation_effects`; per-scheme effect fields) or operational risks
  (undeclared Host URIs dropping today’s blanket
  `FetchEffects { credentials: false }` — decision 6 at `:32-32`).
- **Recommendation:** Short Alternatives + Risks bullets; decision 6 already
  names the undeclared UX change — promote it to an accepted risk.

### 5. Reserved `Local` variant without consumers

- **Severity:** Nit
- **Affected scope:** `docs/research/adr0050-s3-plan.md:18-20`.
- **Finding:** `HostUriJudgment::Local` is “reserved if needed; not the omit
  case.” Harmless if S3 never constructs it; otherwise it is dead API surface.
- **Recommendation:** Either omit `Local` from S3 or state “never constructed
  in S3; tests must not assert it.”

---

## Standard compliance (D5 / S3 exit)

| Requirement | Plan coverage |
|---|---|
| Declared line-selector split in core (`0050:68-68`, `:115`) | Yes — decision 5, tests 3 |
| Undeclared + `mcp://` opaque (`0050:70-70`, `:115`) | Yes — decisions 5–6, tests 4–5 |
| Drop blanket Host `FetchEffects { credentials: false }` (`0050:76`) | Yes — exit D5, decision 3, test 6 |
| Omit fetch+creds judged unknown; undeclared ≠ declared (`0050:76`, `:164`) | Partial — judgment API yes; live admission reinterpreted (finding 2) |
| Fix stale `tool_url.rs` Host doc (`0050:76`) | Yes — decision 3 |
| Capability-sourced effects, no new scheme fields (`0050:60`) | Intent yes; rule underspecified (finding 1) |
