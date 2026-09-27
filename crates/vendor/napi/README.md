# napi (vendored)

Vendored copy of [napi-rs](https://github.com/napi-rs/napi-rs)' `napi` crate
3.13.0, the crates.io release. The workspace `Cargo.toml` routes the registry
dependency here through `[patch.crates-io]`. MIT licensed; see `LICENSE`.

## Local changes

- `src/bindgen_runtime/module_register.rs`, `src/error.rs`: release a
  superseded env's per-thread handles when a new env registers on the same OS
  thread before the old one was torn down. The exact diff against the release
  is `patches/0001-release-superseded-env-handles.patch`.

  napi-rs keeps three per-thread slots keyed by the registering env: the class
  constructor references (`REGISTERED_CLASSES`, refcount 1), the custom-GC
  threadsafe function (`CURRENT_CUSTOM_GC_HANDLE`), and the cached
  `Reflect`/`Reflect.getOwnPropertyDescriptor` pair (`REFLECT_INTRINSICS`).
  Each assumes one env per OS thread, so a re-registration overwrites the
  previous entry on the premise that its env is already gone. `bun test
  --isolate` (implied by `--parallel`) breaks that premise: every test file
  gets a fresh global object and `napi_env` on the same worker thread, and the
  previous env is never torn down. The overwritten strong references then pin
  every earlier file's realm, global object and entire module graph, for the
  life of the worker. In `packages/coding-agent` that is ~15 MB of JS heap per
  test file, so a `bun test --parallel=8` worker grows to ~6 GB.

  The patch adds a per-thread `LIVE_ENV` slot that an env-cleanup hook clears
  at teardown. A registration that still finds a different env there has
  proof that env is alive, and `release_superseded_env` deletes its
  constructor references, marks its custom-GC handle aborted and releases the
  threadsafe function, and deletes its cached `Reflect` holder, all through
  that still-valid env. Under Node an env on a thread is always torn down
  (clearing the slot) before another registers, so the new path never runs.
- `Cargo.toml`: `publish = false`. The crates.io `Cargo.lock`,
  `Cargo.toml.orig`, `README.md` and VCS metadata are dropped; `BUILD.bazel`
  and `rustfmt.toml` are workspace wiring.

Everything else is byte-identical to the 3.13.0 release.

## Updating

Copy the new release's `src/`, `build.rs`, `Cargo.toml` and `CHANGELOG.md`
over this directory, then from here run
`patch -p1 < patches/0001-release-superseded-env-handles.patch` (drop the patch
if upstream fixed the per-env leak) and regenerate it against the new release.
Restore `publish = false` and sync `crate_features` in `BUILD.bazel` with
`cargo tree -p pi-natives -i napi -e normal -f '{p} [{f}]'`.
