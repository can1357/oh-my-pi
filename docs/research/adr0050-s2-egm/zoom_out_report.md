# Zoom-out review — ADR 0050 S2 fold plan

Mode: REVIEW (Goldfish / Skeptical Architect)
Target: `docs/research/adr0050-s2-fold-plan.md`
Normative sources (only): ADR 0050 D1–D7 + S2 exit + Status in omp + Decision record;
`docs/adr/TASKS.md` § ADR 0050.
Reuse checks: existing `HostUriResolver` / `HostResources` / `set_host_uri_schemes` /
`HostUri` / `omp.schemes` surfaces under `crates/`.

## Verdict

**Pass with conditions.** The plan's exit, non-goals, and sequencing match ADR 0050
S2 and TASKS. The root gap (inert S1 claims → live unknown-scheme fallback) is the
right problem. One major ambiguity remains: whether the "envd generation authority"
is the same generation `set_host_uri_schemes` already replaces, or a parallel table.
Resolve that before implement; do not invent a second registry.

## Context sufficiency

Enough: Exit cites the ADR slice table; Non-goals fence S3–S5 and D5; gaps name the
inert S1 land; Chosen shape states authority, claim carry, register gate, and
handler path. A fresh reader can tell *what* (fold live claims into one generation
served by `HostUriResolver`) and *why* (S1 left manifest and register unlinked).

## Findings

### 1. Major — Name `set_host_uri_schemes` as the publish surface, or explicitly justify an envd-native equivalent

- **Affected scope:** Chosen shape §1 (`adr0050-s2-fold-plan.md:35-38`); contrast
  ADR S2 (`0050-extension-declared-url-schemes.md:114`) and D3
  (`0050-extension-declared-url-schemes.md:52-56`).
- **Simplicity rationale:** ADR S2's normative action is "Fold live claims into one
  `set_host_uri_schemes` generation served by `HostUriResolver`." D3 keeps the host
  bridge as "the generation replace that `set_host_uri_schemes` already performs"
  and says the environment publishes one generation that is the union of RPC-host
  and live extension schemes. The plan instead introduces an "Envd generation
  authority owning scheme → {owner, flags, dispatch}, implementing `HostResources`"
  and never names `set_host_uri_schemes` in Chosen shape. A second scheme table
  beside the existing generation replace is the rejected alternative
  (`0050-extension-declared-url-schemes.md:138`). Reuse is already in tree:
  `HostUriResolver` → `HostResources::resolve_read` + `select_bytes`
  (`crates/envd/src/tool_url/host.rs:40-84`), generation replace
  (`crates/rpc/src/client.rs:1387-1453`), scheme flags on `HostUriScheme`
  (`crates/rpc/src/protocol.rs:490-501`). The plan should say: envd owns the
  **union** that feeds that one generation / one `HostResources` broker — not a
  new vocabulary of `{owner, flags, dispatch}` unless those map 1:1 onto
  `HostUriScheme` + existing dispatch. Non-goal
  `adr0050-s2-fold-plan.md:22-23` (skip enabling RPC-mode stubs) is fine; it must
  not be read as skipping the generation-union publish on the production path.

### 2. Major — Generation size cap for the union is unspecified

- **Affected scope:** Chosen shape §1 union language (`adr0050-s2-fold-plan.md:35-38`);
  ADR evidence (`0050-extension-declared-url-schemes.md:28`) and
  `MAX_HOST_URI_SCHEMES = 32` (`crates/rpc/src/protocol.rs:477`,
  `crates/rpc/src/client.rs:1393-1396`).
- **Simplicity rationale:** Per-extension `MAX_SCHEMES` is 32
  (`crates/py/python/omp/schemes.py:51`; `crates/ext/src/scheme.rs`). A union of
  RPC host + N extensions can exceed the **generation** cap of 32. S2 folds into
  that generation; without a refuse-at-fold rule for "union would exceed 32,"
  implementers either silently drop claims or reopen the protocol limit. One
  sentence in Exit or Chosen shape is enough — do not invent a new quota system.

### 3. Minor — "flags, dispatch" and CONTROL callable are altitude drops relative to ADR wording

- **Affected scope:** Chosen shape §1 and §4 (`adr0050-s2-fold-plan.md:35-38`,
  `:43-44`).
- **Simplicity rationale:** S2 exit needs four observables: read returns handler
  body; second extension refused; `pr://` still resolves; named fold test
  (`0050-extension-declared-url-schemes.md:114`). D4 already defines immutable /
  writable on the manifest claim
  (`0050-extension-declared-url-schemes.md:60-61`); `HostUri` already takes a
  `read` callable (`crates/py/python/omp_rpc/host_uris.py:54-72`). Prefer "reuse
  `HostUriScheme` fields + mirror `HostUri` read dispatch through the existing
  CONTROL/device path" over inventing a new `{flags, dispatch}` product type.
  Specifying that `register` gains a read callable is in-scope for the exit
  (handler body); wiring detail ("CONTROL can invoke") belongs in the PR, not as
  a second architecture.

### 4. Minor — Missing non-regression: `omp.urls.schemes` stays built-in-only

- **Affected scope:** Tests (`adr0050-s2-fold-plan.md:46-52`); D4 / Status
  (`0050-extension-declared-url-schemes.md:64`, `:180`); TASKS S1 note
  (`TASKS.md:201`).
- **Simplicity rationale:** Not an S2 exit bullet, but Status and D4 treat
  "declared schemes are a separate listing / `omp.urls.schemes` unchanged" as a
  closed-vocabulary invariant. One line under Tests prevents S2 from accidentally
  growing the frozen table while wiring the fallback.

### 5. Note — Builtin refuse appears twice; fold refuse is the S2-specific one

- **Affected scope:** Chosen shape §1 and §3 (`adr0050-s2-fold-plan.md:38`, `:41`);
  Status gap (`0050-extension-declared-url-schemes.md:180`); S1 py already refuses
  builtins (`crates/py/python/omp/schemes.py:78-79`); TASKS (`TASKS.md:202`).
- **Simplicity rationale:** S1 already refuses built-in wire names at
  `omp.schemes.register`. S2's new obligation is refuse-**at-fold** when a
  **manifest** claims `https`/`pr` (named test), plus gate register on manifest
  claims. Plan covers both; keep the fold refusal as the load-bearing S2 check so
  implementers do not treat S1 register refusal as sufficient.

### 6. Note — Scope fences are correct; do not pull S3/S4/D5 forward

- **Affected scope:** Non-goals (`adr0050-s2-fold-plan.md:17-23`); ADR sequencing
  (`0050-extension-declared-url-schemes.md:119`); Decision record
  (`0050-extension-declared-url-schemes.md:164-167`); TASKS
  (`TASKS.md:203-205`).
- **Simplicity rationale:** S3 (selectors + declaration-based effects), S4
  (reload/quarantine), S5 (listing/conformance) stay out. Collision "first owner
  wins; second names both" is correctly in S2 (also D6's cross-extension rule)
  without importing D6's reload/quarantine lifetime. D5's blanket
  `FetchEffects` fix stays an S3 prerequisite — good YAGNI. Write-handler /
  writable dispatch beyond folding the flag is correctly absent from Exit.

## Match matrix (plan ↔ ADR 0050 S2)

| ADR / TASKS requirement | Plan | Fit |
|---|---|---|
| Fold into one generation served by `HostUriResolver` (S2, D3) | Envd authority + `HostResources`; HostUriResolver implied via gaps | Partial — see finding 1 |
| Gate `register` on manifest claims | Chosen shape §2–§3; gap 3–4 | Match |
| Refuse built-in wire names at fold | Chosen shape §1; Exit named test | Match |
| Read returns handler body | Exit + Chosen shape §4 + Tests | Match |
| Second extension same spelling refused | Exit + Tests; first-wins | Match |
| `pr://` still resolves | Exit + Tests | Match |
| Named test `declared_scheme_fold_refuses_builtin_and_unclaimed` | Exit + Tests | Match |
| No second fallback / no `Scheme` growth (D2, D3, Non-goals) | Non-goals; reuse HostUriResolver path | Match |
| S3/S4/S5 / D5 prerequisite out of slice | Non-goals | Match |
| Generation ≤32 union behavior | — | Missing — finding 2 |
| `omp.urls.schemes` unchanged | — | Soft miss — finding 4 |

## Overscope vs missing (summary)

- **Overscope risk:** A bespoke envd scheme map (`{owner, flags, dispatch}`) and a
  parallel publish path that bypasses the `set_host_uri_schemes` generation
  replace ADR names.
- **Missing:** Explicit alignment to that generation API (or a one-sentence
  owner-visible rationale that envd's union *is* that generation); union size
  refuse; optional `omp.urls.schemes` non-regression test line.
- **Not missing (correctly deferred):** line selectors, effect judgment, reload,
  quarantine, model-facing listing, RPC-mode stub enablement unless the exit
  test needs it.

## Required before implement

1. State in Chosen shape that the envd union **is** the single
   `set_host_uri_schemes`-shaped generation `HostUriResolver` already serves
   (reuse `HostUriScheme` / existing broker), or get an ADR amendment if a
   different publish surface is intentional.
2. Add refuse-at-fold when the union would exceed the existing generation cap
   of 32.
3. Keep S3–S5 fences; do not grow `omp.urls.schemes` or `Scheme`.
