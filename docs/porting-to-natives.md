# Porting to pi-natives (N-API) — Field Notes

This is a practical guide for moving hot paths into `crates/pi-natives` and wiring them through the generated native package entrypoint. It exists to avoid the same failures happening twice.

## When to port

Port when any of these are true:

- The hot path runs in render loops, tight UI updates, or large batches.
- JS allocations dominate (string churn, regex backtracking, large arrays).
- You already have a JS baseline and can benchmark both versions side by side.
- The work is CPU-bound or blocking I/O that can run on the libuv thread pool.
- The work is async I/O that can run on Tokio's runtime (for example shell execution).

Avoid ports that depend on JS-only state or dynamic imports. N-API exports should be data-in/data-out. Long-running work should go through `task::blocking` (CPU-bound/blocking I/O) or `task::future` (async I/O) with cancellation where the caller needs `timeoutMs` or `AbortSignal`.

## Current package shape

`@pk-nerdsaver-ai/pi-natives` no longer has a `packages/natives/src/<module>` TypeScript wrapper layer. The package root points at generated native artifacts:

- runtime entry/export wrapper: `packages/natives/native/index.js`
- types entry: `packages/natives/native/index.d.ts`
- loader helpers: `packages/natives/native/loader-state.js`
- embedded manifest: `packages/natives/native/embedded-addon.js`

Consumers import directly from `@pk-nerdsaver-ai/pi-natives`. The generated declarations and explicit ESM exports are produced during `bun --cwd=packages/natives run build`.

## Anatomy of a native export

**Rust side:**

- Implementation lives in `crates/pi-natives/src/<module>.rs`.
- If you add a new module, register it in `crates/pi-natives/src/lib.rs`.
- Export with `#[napi]`; snake_case exports are converted to camelCase automatically. Use explicit JS names only for true aliases/non-default names. Use `#[napi(object)]` for object-shaped structs.
- For CPU-bound or blocking work, use `task::blocking(tag, cancel_token, work)`.
- For async work that needs Tokio, use `task::future(env, tag, work)`.
- Pass a `CancelToken` when the API exposes `timeoutMs` or `AbortSignal`, and call `heartbeat()` inside long loops.

**Package/build side:**

- `packages/natives/scripts/build-native.ts` runs napi-rs, installs the `.node` artifact, copies generated `index.d.ts`, and regenerates explicit ESM class/function exports plus enum runtime exports in the checked-in `native/index.js`.
- `packages/natives/native/index.js` is the ESM entrypoint that calls the loader, exposes named exports, and rejects install/compiled `.node` files that do not expose the package-version sentinel.
- `packages/natives/package.json` exposes only the package root (`@pk-nerdsaver-ai/pi-natives`) as the import surface. At publish time the binaries are split out: the core ships the loader only (no `.node`), and each platform's `.node` is published as an optional-dependency leaf package `@pk-nerdsaver-ai/pi-natives-<tag>` (`scripts/ci-release-publish.ts` + `packages/natives/scripts/gen-npm-packages.ts`). This is transparent to importers — you still `import` from `@pk-nerdsaver-ai/pi-natives`.

**Consumer side:**

- Update direct imports/callsites in `packages/coding-agent` or `packages/tui` when the new export replaces a JS implementation.
- Keep higher-level policy in consumers unless it belongs in the native primitive itself.

## Porting checklist

1. **Add the Rust implementation**

- Put the core logic in a plain Rust function.
- If it is a new module, add it to `crates/pi-natives/src/lib.rs`.
- Expose it with `#[napi]` so the default snake_case -> camelCase mapping stays consistent.
- Keep signatures owned and simple: `String`, `Vec<String>`, `Uint8Array`, `Either<JsString, Uint8Array>`, or `#[napi(object)]` structs.
- For CPU-bound or blocking work, use `task::blocking`; for async work, use `task::future`.
- If exposing cancellation, include `timeout_ms: Option<u32>` and `signal: Option<Unknown<'env>>` in options, create `CancelToken::new(...)`, and heartbeat in long loops.

2. **Build generated bindings**

- Run `bun --cwd=packages/natives run build`.
- Confirm the generated `packages/natives/native/index.d.ts` includes the new export with the intended JS name/signature.
- Confirm `packages/natives/native/index.js` has generated explicit ESM exports for the new class/function and enum objects when enum changes are involved.

3. **Update consumers**

- Import the new export directly from `@pk-nerdsaver-ai/pi-natives`.
- Replace only callsites where the native implementation is faster/equivalent and preserves behavior.
- Remove obsolete JS implementation code in the same change when the native path becomes canonical.

4. **Add benchmarks**

- Put benchmarks next to the owning package (`packages/tui/bench`, `packages/natives/bench`, or `packages/coding-agent/bench`).
- Include a JS baseline and native version in the same run.
- Use `Bun.nanoseconds()` and a fixed iteration count.
- Keep benchmark inputs realistic for the hot path.

5. **Run focused verification**

- Build the native package.
- Run the benchmark.
- Run the narrow tests or scenario covering the changed export/callsites.

## Pain points and how to avoid them

### 1) Stale platform/variant artifacts

The loader probes platform-tagged artifacts in deterministic order. For x64, selected variant candidates are tried before the unsuffixed default fallback:

- `modern`: `pi_natives.<tag>-modern.node`, then `...-baseline.node`, then `pi_natives.<tag>.node`.
- `baseline`: `pi_natives.<tag>-baseline.node`, then `pi_natives.<tag>.node`.

Non-x64 uses `pi_natives.<tag>.node`.

Compiled binaries also probe `<getNativesDir()>/<version>/...` and a legacy user-data directory before package/executable locations. Windows `node_modules` installs stage leaf/core addons into the same versioned directory before probing. If any earlier candidate is stale, a new export may appear missing unless the version sentinel rejects it first.

**Fix:** remove stale candidate/cache files and rebuild.

```bash
rm packages/natives/native/pi_natives.<platform>-<arch>.node
rm packages/natives/native/pi_natives.<platform>-<arch>-modern.node
rm packages/natives/native/pi_natives.<platform>-<arch>-baseline.node
bun --cwd=packages/natives run build
```

For compiled binaries or Windows staging, delete the versioned addon cache shown in the loader error (normally under `~/.ompk/natives/<version>` unless `$XDG_DATA_HOME/omp` is used).

### 2) Generated types do not match loaded binary

This can happen when `native/index.d.ts` was regenerated but the `.node` file being loaded is stale, same-version incomplete, or from a different platform/variant. Different-version install/compiled binaries should be rejected by the version sentinel during loading.

Verify the loaded export set from the actual candidate path reported by the loader:

```bash
bun -e 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); const mod = require(process.argv[2]); console.log(Object.keys(mod).sort())' -- /path/from/loader/error/pi_natives.<tag>[-variant].node
```

Fix the build/candidate mismatch. Do not paper over it with optional consumer checks if the export is required.

### 3) Rust signature mismatch

Keep N-API signatures simple and owned. Avoid borrowed references like `&str` in public exports. If you need structured data, use `#[napi(object)]` structs. If you need callbacks, use napi-rs `ThreadsafeFunction` and keep callback error/value behavior explicit.

### 4) Enum runtime exports and ESM named exports

napi-rs declarations alone are not enough for JS callers that import named symbols or use enum objects at runtime. `scripts/gen-enums.ts` reads `native/index.d.ts`, writes explicit `export const ... = nativeBindings...` entries for public classes/functions, and emits enum objects in `native/index.js`. If you add or change a native export, verify both `native/index.d.ts` and the generated export block in `native/index.js`.

### 5) Benchmarking mistakes

- Do not compare different inputs or allocations.
- Keep JS and native using identical input arrays.
- Run both in the same benchmark file to avoid skew.
- Include enough iterations to smooth startup noise, but keep inputs realistic.

## Benchmark template

```ts
const ITERATIONS = 2000;

function bench(name: string, fn: () => void): number {
  const start = Bun.nanoseconds();
  for (let i = 0; i < ITERATIONS; i++) fn();
  const elapsed = (Bun.nanoseconds() - start) / 1e6;
  console.log(
    `${name}: ${elapsed.toFixed(2)}ms total (${(elapsed / ITERATIONS).toFixed(6)}ms/op)`,
  );
  return elapsed;
}

bench("feature/js", () => {
  jsImpl(sample);
});

bench("feature/native", () => {
  nativeImpl(sample);
});
```

## Verification checklist

- Generated `native/index.d.ts` includes the new export and intended TS signature.
- `native/index.js` includes the generated named export; enum objects are present when the change adds/changes enums.
- The loaded `.node` file's `Object.keys(require(candidate))` includes the new export and the package-version sentinel.
- Bench numbers are recorded in the PR/notes.
- Call sites are updated only if native is faster/equal and behavior-compatible.
- Obsolete JS code is removed when the native implementation becomes canonical.

## Rule of thumb

- If native is slower, do not switch callsites. Keep or remove the export based on whether it has a near-term owner.
- If native is faster and behavior-compatible, switch callsites and keep a benchmark to catch regressions.
