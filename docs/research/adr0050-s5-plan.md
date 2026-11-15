# ADR 0050 S5 — listing + joined conformance

Base: stacked on S4 (`cursor/adr0050-s4-reload-quarantine-40d3`).

## Exit

- Model-facing listing of declared schemes, without roster or schema change.
- `omp.urls.schemes` stays the built-in table only.
- Joined conformance covers install, read, selector, reload, quarantine, and a
  stable built-in route.

## Locked decisions

1. **Listing surface:** additive `omp.schemes.live()` (async) returns live
   declared schemes from envd `SchemeGeneration::snapshot` via CONTROL
   `omp.schemes.live`. Separate from process-local `omp.schemes.declared()`.
2. **No growth:** no new tool, no roster family, no `Scheme` enum growth, no
   `url-vocab.json` change.
3. **CONTROL routing:** `ControlDomain::Auxiliary` admits `omp.schemes.*`
   child→parent ops; `ProductionEnvdControlAuthority` handles
   `omp.schemes.live` and serializes the generation snapshot. Host→child
   `omp.schemes.read` remains the callback path (unchanged).
4. **Joined conformance:** `crates/envd/tests/declared_scheme_s5.rs` walks
   install → read → selector → reload → quarantine → builtin, and asserts
   listing via `SchemeGeneration` plus Python `live()` against a mock CONTROL
   backend; `omp.urls.schemes` unchanged.

## Non-goals

- Growing built-in vocabulary or latched roster.
- Enabling RPC `set_host_uri_schemes` on chat compositions.
- Declared-scheme writes.

## File allowlist

- `crates/envd/src/tool_url/scheme_generation.rs` (`listing_payload`)
- `crates/envd/src/server/control_factories.rs` / `session.rs` (wire generation)
- `crates/envd/src/exthost/control.rs` (Auxiliary admits `omp.schemes.*`)
- `crates/py/python/omp/schemes.py` (`LiveDeclaration`, `live`)
- `crates/envd/tests/declared_scheme_s5.rs`
- `crates/py/tests/schemes_contract.rs` (additive live assertions)
- `docs/adr/0050-…`, `TASKS.md`, `STATUS.md`, `docs/py/09-journal.md`
