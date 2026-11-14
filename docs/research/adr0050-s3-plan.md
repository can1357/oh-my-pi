# ADR 0050 S3 — selectors + D5 effect judgment

Base: assume S2 (`cursor/adr0050-s2-scheme-fold-40d3` / #628) merged after local green.
omp2 tip may lag; this branch stacks on S2.

## Exit

- `widget://id:2-3` returns those lines from core (declared live scheme).
- `custom://pending:raw` undeclared keeps `pending:raw` in the resource.
- `mcp://` stays selector-opaque.
- D5: Host judgment no longer blankets every host URI as `FetchEffects { credentials: false }`.
- Regression: declared scheme omitting fetch+credentials → judged `Effects::unknown()` at the Host judgment API; undeclared foreign scheme never inherits a declared scheme’s judgment.

## Locked decisions

1. **`HostUriJudgment`** on `HostResources` (and `SchemeGeneration`):
   - `Undeclared` — unknown spelling not in the generation
   - `Local` — reserved if needed; not the omit case
   - `Fetch(FetchEffects)` — declared + extension has fetch capability (+ optional credentials)
   - `Unknown` — declared scheme whose fold carried no fetch and no credentials (expresses `Effects::unknown()` for the D5 regression)

2. **Capability source (ADR D4):** at FREEZE fold, set per-extension flags (copied onto each `SchemeClaim`/`LiveScheme`): `fetch` = ExtensionManifest / data_grants or FREEZE-visible capabilities contains `env.net.fetch`; `credentials` = static `capability_grants["credentials.allow"]` is a non-empty provider list (else false). Mapping: `(!fetch && !credentials)` → `HostUriJudgment::Unknown`; `fetch` → `Fetch(FetchEffects { credentials })`; credentials without fetch → `Unknown` (never `Fetch`). Pass flags into `fold_declared_schemes` from the ExtHost call site / manifest — do not invent `[[schemes]]` effect fields. Extend FREEZE/snapshot inputs only if `credentials.allow` is not already reachable at that call site.

3. **`UrlResolver::Host::read_fetch`:** `HostUriResolver::read_fetch` consults `broker.judge`; return `Some(FetchEffects)` only for `Fetch(...)`; `None` otherwise. Fix stale doc at `tool_url.rs:438-453`.

4. **`read@3` admission (D5):** ADR’s `Effects::unknown()` / exec approval tier for omit-fetch+creds is satisfied only at `HostResources::judge` → `HostUriJudgment::Unknown` (facts for the D5 regression). Live `read@3` Foreign admission must remain subset-safe: `invocation_effects` carries no fetch for `Unknown`/`Undeclared`/`Local` and must not inject `Effects::unknown()`. Map:
   - `Fetch(e)` → include fetch effects `e`
   - `Unknown` / `Undeclared` / `Local` → no fetch on the Foreign path

API pin: `HostResources::judge(&self, url: &str) -> HostUriJudgment`; `SchemeGeneration::is_live(scheme: &str) -> bool`; `SchemeClaim`/`LiveScheme` gain `fetch: bool`, `credentials: bool`; peel live-only post-parse in `host.rs`; `Scheme::accepts_selectors(Unknown|Mcp)` stays false.

5. **Selectors:** peel shared line grammar only when `SchemeGeneration::is_live(scheme)`. Peel in `HostUriResolver::read` (or shared helper): handler sees URL without `:2-3`; `select_bytes` applies lines. Undeclared Unknown and `mcp://` unchanged (opaque).

6. **Undeclared host URIs:** after S3 they are `Undeclared` / no Fetch from Host arm — intentional admission UX change from today’s blanket Fetch.

## Non-goals

- S4 reload/quarantine, S5 listing
- Growing `Scheme` / `url-vocab.json`
- RPC `set_host_uri_schemes` enablement

## File allowlist

- `crates/envd/src/tool_url/scheme_generation.rs`
- `crates/envd/src/tool_url/host.rs`
- `crates/envd/src/tool_url.rs`
- `crates/envd/src/tools/bridges.rs` (`HostResources`)
- `crates/envd/src/worker.rs` (fold capabilities → flags)
- `crates/tools/src/read.rs` / `read/resolver.rs` / `read/selector.rs` as needed for Foreign judgment + peel helper
- `crates/envd/tests/declared_scheme_fold.rs` and/or new `declared_scheme_s3.rs`
- `docs/adr/0050-…`, `TASKS.md`, `STATUS.md`

## Tests

1. Declared omit fetch+creds → `judge` / Host judgment is `Unknown` (maps to `Effects::unknown()` facts).
2. Undeclared never gets a declared scheme’s Fetch/Local/Unknown judgment as if it were declared.
3. `widget://id:2-3` line select.
4. `custom://pending:raw` opaque.
5. `mcp://…:N` opaque.
6. Host `read_fetch` no longer always `Some(credentials: false)`.
7. S2 exit suite still green.
