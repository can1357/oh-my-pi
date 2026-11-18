# Manifest tool declarations cannot register

Status: partly resolved. The Rust lowering is fixed by `fix(driver): lower native tool keys as name@family.rev`: admission parses `name@family.rev`, takes the revision from the key, and refuses any other tool key with `NativeExtensionError::ToolKey`. Still open: the documented `[[tools]]` authoring format, and end-to-end coverage of soft and hard tools through the manifest path on Linux (`crates/e2e/tests/p9_continuation_grants.rs` covers a soft tool on macOS only). The record below was investigated against `origin/omp2` at `8fd17dee2aa3c995142bf5435b121ac237118527` and describes the defect as found.

## Impact and verdict

The documented normalized `omp.toml` tool declaration cannot register through native extension admission. Phase 0 exercised three row shapes and found that none registered. The documented `name@family.rev` form reaches registry freeze, where publication differs from the authenticated manifest. A tool call then fails with `NotFound`. The hidden trusted-module route registered the same Python tools, but is not the manifest route.

**Verdict: Rust native admission lowers the normalized tool key incorrectly.** The authoritative normalized schema and Python agree on `name@family.rev`. The Rust lowering treats the entire key as the name, looks for a separate `family` property, and uses the manifest API level as the tool revision. The API level and tool revision are distinct: the documented example uses `key = "review@rv.2"` and `api = 1` ([deploy schema](../py/14-deploy.md), lines 667-674).

There is a separate authoring-format gap. The overview documents `[[tools]]` with `name`, `family`, and `rev` ([overview](../py/00-overview.md), lines 425-431). `DeploymentManifest` reads `declarations`, not `tools` (`crates/ext/src/config.rs:1354-1382`). Although `ToolManifestEntry` and `lower_tools` exist (`config.rs:1403-1455`), that entry has a `key` field, not the documented `name`, `family`, and `rev` fields. Do not mistake agreement on the normalized schema for working support for the authoring example.

## Contract mismatch

The normalized schema says an executable row has exactly the listed fields, including `id`, `kind`, `module`, `key`, `trigger`, `api`, and `failure`. Its tool identity is `name@family.rev` (`docs/py/14-deploy.md:662-678,709-717`). For example:

```toml
[[declarations]]
id = "review"
kind = "soft"
module = "acme_reviewer.review"
key = "review@rv.2"
trigger = "lazy"
api = 1
failure = "fault"
```

Python enforces that shape. `crates/py/python/omp/_registry.py:2376-2413` requires the common fields and rejects unknown executable fields, including `family`. At `_registry.py:2485-2487,2512-2530` it parses the key:

```python
name, separator, revision = value.rpartition("@")
family, revision_separator, number = revision.rpartition(".")
```

Invalid keys fail with `tool key must have the form 'name@family.rev'`. The Rust path is `crates/driver/src/discovery/native.rs`, not `crates/ext/src/native.rs`. At `native.rs:550-564` it constructs the runtime identity as follows:

```rust
let rev = u16::try_from(row.api.max(1)).ok()?;
Some(ToolDeclarationKey::new(
    if row.key.is_empty() {
        row.id.clone()
    } else {
        row.key.clone()
    },
    row.properties
        .get("family")
        .and_then(serde_json::Value::as_str)
        .map(Str::new)
        .unwrap_or_default(),
    rev,
))
```

Rust therefore constructs the expected identity from `key = "review"`, `family = "rv"`, and `api = 2`. Python rejects the extra `family` field and rejects a bare key. With the documented row, Rust instead constructs a name of `review@rv.2`, an empty family, and revision `1`. [INFERENCE] Those identities cannot equal the Python registry publication for the documented tool. Phase 0 observed the resulting publication mismatch.

## Reproduction

Phase 0 used the production `admit_native_extensions` path and a real local environment host with an in-process env/v1 client. Its instrument is `crates/e2e/tests/phase0_pyext_host.rs` at [commit d63dc9b1c8](https://github.com/blyzer/oh-my-pi/blob/d63dc9b1c8/crates/e2e/tests/phase0_pyext_host.rs), branch `phase0/pyext-host-feasibility`. It creates `src/p0_result_normalize.py` with `@omp.tool("p0_normalize", rev=1)` and an `omp.toml` row with `kind = "soft"`, `module = "p0_result_normalize"`, `trigger = "lazy"`, `api = 1`, and `failure = "fault"`. It admits the extension and invokes the tool over env/v1.

On that evidence branch, run the native-manifest probe with the repository's embedded Python setup in place:

```sh
OMP_STATE_DIR=/private/tmp/p0-state OMP_LOG_STDERR=warn \
  cargo nextest run -p omp-e2e --test phase0_pyext_host --locked --no-capture \
  p0_capability_1_register_via_native_manifest
```

The probe records the refused invocation and returns success; its exit status alone is not an assertion that registration succeeded. Default `key = "p0_normalize@p0_result_normalize.1"` produced `registry publication differs from authenticated manifest` and then `NotFound`. To try the other rows, set `P0_KEY_FORM=name`. That bare key produced `tool key must have the form 'name@family.rev'`. Also setting `P0_MANIFEST_EXTRA='family = "p0_result_normalize"'` produced `unknown executable declaration field` for `declarations[0].family`. Python host stderr was captured through a wrapper in Phase 0 for the two `ManifestError` diagnostics. These results are from the Phase 0 report and its macOS arm64 logs, not a rerun for this record. Phase 0 also forced the manifest host tier to trusted and observed the same failures; tier was not the cause.

## Shipped extensions and coverage

The tracked `omp.toml` files found by `rg --files --hidden -g omp.toml` are under `scripts/qa/fixtures/extensions`. These are production-shaped test fixtures, not evidence of a shipped extension successfully registering (`scripts/qa/README.md:73-76`). For example, `scripts/qa/fixtures/extensions/root/hard-tool/omp.toml:6-13` declares `key = "hello@qaext.1"`, and `scripts/qa/cases/test_py_root.py:262-270` expects a tool round trip. No successful run of that fixture was found or performed in this investigation. No tracked shipped extension with a successful manifest-based tool registration was identified. [INFERENCE] The path may never have worked end to end; the repository census and the Phase 0 failures do not establish its entire history or rule out external extensions.

## Proposed fix (parse and validate applied; the rest open)

Parse and validate the normalized `name@family.rev` key once in Rust admission, preserving its name, family, and revision independently of `api`. Keep Python's rejection of an extra `family` field and preserve authenticated-manifest versus registry comparison. Reconcile the documented `[[tools]]` authoring format with the actual deployment parser and lowering, or document the normalized format as the supported input. Add end-to-end native admission and invocation coverage for soft and hard tools, a tool revision different from its API level, malformed keys, and publication mismatch. Exercise the shipped QA fixture through the actual manifest path. Do not use the trusted-module route as proof of manifest registration.
