# ADR 0050 S2 — fold plan (amended after EGM)

omp2 pin: `origin/omp2` at the base of this branch.
ADR: [0050](../adr/0050-extension-declared-url-schemes.md). TASKS: ADR 0050 S2 OPEN.
EGM reports: [adr0050-s2-egm/](adr0050-s2-egm/).

## What the review changed

| Finding | Source confirmed | Change |
| --- | --- | --- |
| Plan never named `set_host_uri_schemes` vs parallel table | ADR D3 `:52-56`, S2 `:114`; zoom-out / design critic | Adopt **Option A**: envd-owned in-process generation that *is* the unknown-scheme broker (`HostResources`). Semantics mirror `set_host_uri_schemes` (replace published map). RPC host partition deferred; S2 does not enable the stubbed RPC composition. Documented as intentional S2 scope, not a second resolver table. |
| Handler API unspecified | `schemes.py:110-140`; `host_uris.py:53-72` | Additive: `register(..., *, read=None)`. Optional for ABI; exit fixture supplies `read`. CONTROL method `omp.schemes.read` invokes it. Writable out of S2 (`resolve_write` refuses). |
| Claims never reach worker | `worker.rs` snapshot; `ExtensionManifest`; `lower_manifest` | Carry `schemes` through `lower_manifest` → `ExtensionManifest` → snapshot → `configure_manifest` / registry gate. |
| Builtin refuse locus | ADR `:180`; py already refuses | Fold refuse in envd when publishing claims (has vocab via tools/py packing). Named test covers fold + unclaimed register. Keep py builtin refuse. |
| `HostResources = None` | `cli.rs` / kernel defaults | Construct and inject `SchemeGeneration` (name below) on production bridges used by URL resolvers. |
| Cap 32 on union | `MAX_SCHEMES` / `MAX_HOST_URI_SCHEMES` | Refuse publish when union would exceed 32; error names the cap. |
| Zero-decision / file allowlist | impl-readiness | Allowlist and signatures below. |

## Exit (normative)

- `read` of a declared scheme returns the handler body.
- Second extension claim on same spelling refused (names both owners).
- Built-in `pr://` still resolves via dense forge arm.
- Named test `declared_scheme_fold_refuses_builtin_and_unclaimed`.

## Non-goals

- S3 selectors / D5 effect judgment.
- S4 reload / quarantine.
- S5 listing / conformance.
- Enabling RPC-mode `set_host_uri_schemes` on stubbed compositions.
- Writable declared schemes.

## Chosen shape (decided)

### Generation (Option A)

- New type `SchemeGeneration` in `crates/envd/src/tool_url/scheme_generation.rs`.
- Implements `HostResources`.
- Fields per scheme: `scheme`, `description`, `writable`, `immutable`, `owner: Str` (extension id or `"rpc-host"`), plus an internal dispatch key for CONTROL read.
- Publish = replace the whole envd-owned map (same replace semantics as `set_host_uri_schemes`).
- Injected as `RegistryBridges.host_resources` / `production_url_resolvers` input.
- `resolve_write` → fixed typed/string error `"declared scheme writes are not enabled"` (S2).
- Undeclared unknown schemes: keep today's unavailable / no-handler behaviour.

### Python API (additive)

```python
def register(*declarations: Declaration | str, read: Callable | None = None) -> None:
    """Gate on manifest claims + builtin refuse; publish into envd generation.
    `read(url: str) -> str | bytes | mapping` required for the scheme to serve bodies.
    """
```

- Unclaimed name → refuse (`Unclaimed` / `SchemeError`).
- Builtin wire name → refuse (existing).
- Duplicate across extensions → refuse naming both.
- `omp.schemes.serve` is **not** added (one additive surface).

### CONTROL

- `omp.schemes.read` `{scheme, url}` → invoke registered `read` on the owning extension host.
- Fold/publish CONTROL (or host bridge) updates `SchemeGeneration` when register succeeds.

### Manifest carry

- `DeploymentManifest.schemes` → `lower_manifest` copies into `ExtensionManifest.schemes`.
- `control_manifest_snapshot` includes schemes JSON.
- Worker `configure_manifest` stores claimed set for `register` gating.

## File allowlist

**Modify**

- `crates/envd/src/tool_url/scheme_generation.rs` (**create**)
- `crates/envd/src/tool_url/mod.rs` (or `tool_url.rs` module wiring)
- `crates/envd/src/tool_url/host.rs` (bind generation)
- `crates/envd/src/tools/bridges.rs` (if injection helpers live here)
- `crates/driver/src/bridges.rs` / headless kernel / `app` composition sites that pass `host_resources: None` for production URL resolvers (minimal set that serves `read`)
- `crates/envd/src/exthost/lifecycle.rs` (`ExtensionManifest.schemes`)
- `crates/driver/src/discovery/native.rs` (`lower_manifest`)
- `crates/envd/src/worker.rs` (`control_manifest_snapshot`)
- `crates/py/python/omp/_registry.py` / `_host.py` (configure + CONTROL)
- `crates/py/python/omp/schemes.py` (gate + `read=` + publish)
- `crates/py/tests/schemes_contract.rs` (keep S1; add fold cases or point to envd test)
- New: `crates/envd/tests/declared_scheme_fold.rs` (or colocated) with
  `declared_scheme_fold_refuses_builtin_and_unclaimed`, read body, collision, `pr://` intact

**Do not modify**

- `crates/tools/url-vocab.json`, `Scheme` enum, latched roster
- S3 effect judgment at `tool_url.rs` host fetch
- Reload / quarantine paths (S4)

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Literally route every fold through RPC `set_host_uri_schemes` on chat compositions | Stubbed unsupported (`rpc_mode.rs`); would expand S2 into RPC composition work |
| Second resolver table beside `HostUriResolver` | Rejected by ADR alternatives |
| Required positional handler on `register` | Breaks S1 additive ABI |
| New `omp.schemes.serve` | Extra symbol; one additive `read=` kwarg is enough |

## Risks

- CONTROL round-trip latency for every unknown-scheme read (accepted for S2).
- 32-scheme union cap across all live extensions.
- Incomplete injection leaves `HostResources=None` on some compositions — tests must cover the production path that serves `read`.

## Implementation order

1. Manifest carry (`ExtensionManifest` → snapshot → configure).
2. `SchemeGeneration` + inject into URL resolvers; empty map.
3. Gate `register` on claims + builtins; publish into generation (metadata).
4. `read=` + CONTROL `omp.schemes.read` + `resolve_read`.
5. Exit tests (named refuse, widget body, collision, `pr://`).
6. Update ADR Status in omp + TASKS S2 → DONE; STATUS.md row.

## Tests

| Test | Location |
| --- | --- |
| `declared_scheme_fold_refuses_builtin_and_unclaimed` | `crates/envd/tests/…` |
| declared scheme read returns body | same or `omp-py` |
| second owner collision | same |
| `pr://` dense path unchanged | same / existing forge tests |
| S1 inert contract still green | `just test-pkg omp-py` / `omp-ext` |
