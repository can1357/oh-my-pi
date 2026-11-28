# napi (vendored)

Vendored copy of [napi-rs](https://github.com/napi-rs/napi-rs)' `napi` crate
3.16.3, the crates.io release. The workspace `Cargo.toml` routes the registry
dependency here through `[patch.crates-io]`. MIT licensed; see `LICENSE`.

## Local changes

- `src/bindgen_runtime/env_registration.rs`,
  `src/bindgen_runtime/module_register.rs`: release a superseded env's
  registration record when a new env registers on the same OS thread before
  the old one was torn down. The exact diff against the release is
  `patches/0001-release-superseded-env-handles.patch`.

  napi-rs keeps one per-thread registration record per env
  (`ENV_REGISTRATIONS`), holding strong references into that env: the class
  constructors, the custom-GC threadsafe function and its sentinel, the cached
  `Reflect`/`Reflect.getOwnPropertyDescriptor` holder, and the `AsyncTask`
  promise functions. A record is only dropped by its env's cleanup hook, on the
  premise that a host never retires a realm on a reused thread without tearing
  its env down. `bun test --isolate` (implied by `--parallel`) breaks that
  premise: every test file gets a fresh global object and `napi_env` on the
  same worker thread, and the previous env is never torn down (still so in Bun
  1.4.3, which also skips the teardown at the end of a run). The records' strong
  references then pin every earlier file's realm, global object and entire
  module graph, for the life of the worker. In `packages/coding-agent` that is
  ~15 MB of JS heap per test file, so a `bun test --parallel=8` worker grows to
  ~6 GB. Upstream documents this as the host's problem (`env_registration.rs`
  module docs), so the patch is still needed.

  The patch adds `release_superseded_envs`, called at the start of
  `napi_register_module_v1`. A record of a different env that is still listed
  proves that env is alive, so it is taken out of the list, the env is marked
  torn down, and every reference it holds is deleted through that still-valid
  env (the custom-GC sentinel's strong reference too, since its finalizer would
  never run). Records of the registering env itself are kept. Under Node an env
  on a thread is always torn down (removing its record) before another
  registers, so the new path finds nothing there.
- `src/bindgen_runtime/mod.rs`, `src/bindgen_runtime/js_values/arraybuffer.rs`:
  `set_external_release_hook` registers a callback that the external
  `Buffer`/typed-array GC finalizers run after freeing the Rust allocation.
  The exact diff is `patches/0002-external-release-hook.patch`. `omp-natives`
  uses it to trim freed heap pages after the JS GC releases a native result
  (`crates/natives/src/memory.rs`); without a registered hook the
  finalizers behave as upstream.
- `src/bindgen_runtime/js_values/task.rs`: pass `ptr::null_mut()` as the
  `result` argument to `napi_wrap` when wrapping an `AbortSignal`. The exact
  diff is `patches/0003-abort-signal-wrap-reference.patch`. Passing
  `&mut signal_ref` allocated an owned weak `napi_ref` for each new
  `AbortSignal` that nothing deleted, leaking native memory on every call that
  passes a fresh signal; passing null lets the runtime delete its own reference
  after `async_task_abort_controller_finalize` runs. Drop the patch when the
  vendored napi-rs release passes a null `result` there.
- `Cargo.toml`: `publish = false`, `rust-version` inherited from the
  workspace (upstream's 1.88 would cap cargo's MSRV-aware resolution of every
  workspace dependency at 1.88), and a `[lints.clippy]` block that keeps the
  workspace's lint config off upstream code. `CHANGELOG.md`: the vendor
  import entries under `[Unreleased]`. The crates.io `Cargo.lock`,
  `Cargo.toml.orig`, `README.md` and VCS metadata are dropped; `BUILD.bazel`
  and `rustfmt.toml` are workspace wiring.

Everything else is byte-identical to the 3.16.3 release.

## Updating

Copy the new release's `src/`, `build.rs`, `Cargo.toml` and `CHANGELOG.md`
over this directory, then from here run
`patch -p1 < patches/0001-release-superseded-env-handles.patch`,
`patch -p1 < patches/0002-external-release-hook.patch`, and
`patch -p1 < patches/0003-abort-signal-wrap-reference.patch` (drop a patch if
upstream covers it) and regenerate them against the new release.
Restore the `Cargo.toml` and `CHANGELOG.md` edits above, bump `version` in
`BUILD.bazel` and sync its `crate_features` with
`cargo tree -p omp-natives -i napi -e normal -f '{p} [{f}]'`, then run
`cargo update -p napi -p napi-derive` and `bun scripts/gen-bazel-lock.ts`.
