# Porting Hot Paths to `pi-natives`

This is the contributor path for moving a measured JS/TS hot path into `crates/pi-natives` and exposing it through `@oh-my-pi/pi-natives`.

## Decide whether to port

Port when native code removes demonstrated CPU, blocking-I/O, allocation, or platform-integration cost and the boundary can stay data-oriented. Keep JS when the work depends heavily on JS object identity, dynamic imports, callbacks into application state, or native conversion cost erases the gain.

Start with a behavior-compatible JS baseline and representative inputs. A native export that exists but is slower or behaviorally different is not a successful port.

## Current package and build split

The package has no `packages/natives/src/<module>` wrapper layer. Its entrypoints are:

- eager root: `native/index.js` with generated `native/index.d.ts`;
- lazy desktop wrapper: `native/desktop.js` / `desktop.d.ts`;
- lazy clipboard wrapper: `native/clipboard.js` / `clipboard.d.ts`.

Two commands serve different purposes:

- `bun --cwd=packages/natives run build:bindings` runs napi-rs for the host, installs a local variant addon and generated declarations, and regenerates explicit ESM/enum exports. Use this when the Rust public type surface changes.
- `bun --cwd=packages/natives run build` invokes `scripts/bazel-natives.ts host --dest native`. The host target builds through the local cargo/napi-rs backend by default (`OMP_NATIVE_BUILD_BACKEND=bazel` opts into bazel) but does not regenerate declarations.

Release builds use Bazel targets and publish `.node` files in platform leaf packages. The core publish rewrite removes addons and injects lockstep optional dependencies generated from `LEAF_TARGETS` in `gen-npm-packages.ts`.

## Design the N-API boundary

1. Put implementation in the owning `crates/pi-natives/src/<module>.rs`; register new modules in `lib.rs`.
2. Keep the computation in a plain Rust function where practical, then expose a thin `#[napi]` boundary.
3. Prefer owned N-API-compatible values: `String`, vectors, typed arrays, and `#[napi(object)]` option/result structs. Avoid borrowed public inputs whose lifetime cannot cross N-API work.
4. Let napi-rs apply the default snake_case-to-camelCase name unless a deliberate public name requires `js_name`.
5. Preserve the JS contract: null/undefined distinctions, ordering, error versus result semantics, callback timing, and sync versus Promise behavior.

### Work scheduling and cancellation

- Use `task::blocking(tag, cancel_token, work)` for CPU-heavy or blocking work. It returns an `AsyncTask`, profiles the work, and catches panics before they cross the async-work FFI boundary.
- Use `task::future(env, tag, future)` for Tokio async I/O. It returns a `PromiseRaw` through `Env::spawn_future`.
- When the public options expose `timeoutMs` or `AbortSignal`, build `task::CancelToken::new(timeout_ms, signal)` and call `heartbeat()` at meaningful intervals in blocking loops. Cancellation is cooperative; a token that is never checked does not stop work.
- Do not create runtimes or worker pools in module initialization. The JS loader performs the optional `__ompInstallTokioRuntime` post-load step after the dynamic-loader lock is released.

Match an existing export with the same scheduling/error shape rather than introducing a second convention.

## End-to-end checklist

### 1. Implement and expose

- Add the Rust logic and focused Rust tests for pure invariants when needed.
- Add the `#[napi]` item and object/enum types.
- Register a new module in `crates/pi-natives/src/lib.rs`.
- If the port uses another first-party crate, add the dependency to `crates/pi-natives/Cargo.toml` and its build-system inputs as required by the native build.

### 2. Regenerate and inspect the binding

Run:

```bash
bun --cwd=packages/natives run build:bindings
```

Then verify:

- `native/index.d.ts` contains the intended JS name, exact input/result types, callback shape, and sync/Promise return;
- the marked generated block in `native/index.js` contains the class/function export;
- changed enums have both declarations and literal runtime objects.

`gen-enums.ts` derives exports by reading top-level `export declare class`, `export declare function`, and enum declarations. An item absent from the declarations will not become a named root ESM export.

### 3. Add a lazy entrypoint only when justified

The root eagerly loads the addon. If a worker must import without paying that startup cost, follow the desktop/clipboard pattern:

- a small JS wrapper calls `loadNative()` inside the exported function;
- a matching `.d.ts` imports/re-exports root types;
- `package.json#exports` supplies both `types` and `import` paths.

Do not add a wrapper merely to rename a generated root export.

### 4. Migrate consumers cleanly

- Import the generated root symbol or intentional lazy subpath from `@oh-my-pi/pi-natives`.
- Compare results and errors against the JS baseline on boundary cases.
- Switch every intended caller and remove the obsolete implementation in the same change.
- Keep user-facing policy and rendering in the consumer when the native primitive does not own it.

### 5. Benchmark representative work

Place a durable benchmark with the owning package (`packages/natives/bench`, `packages/tui/bench`, `packages/coding-agent/bench`, or another existing package bench directory). Run JS and native implementations in the same process on identical prepared input. Separate setup/conversion from the timed operation when callers can reuse that setup.

```ts
const ITERATIONS = 2_000;

function bench(name: string, fn: () => void): number {
  const start = Bun.nanoseconds();
  for (let i = 0; i < ITERATIONS; i++) fn();
  const elapsedMs = (Bun.nanoseconds() - start) / 1e6;
  console.log(
    `${name}: ${elapsedMs.toFixed(2)}ms (${(elapsedMs / ITERATIONS).toFixed(6)}ms/op)`,
  );
  return elapsedMs;
}

bench("feature/js", () => jsImpl(sample));
bench("feature/native", () => nativeImpl(sample));
```

For Promise-returning operations, use an async benchmark loop and await every call; do not time promise creation alone.

### 6. Verify the loaded artifact

Run the narrow scenario against the addon you just built. When diagnosing a candidate mismatch, inspect the candidate path reported by the loader:

```bash
bun -e 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); const mod = require(process.argv[1]); console.log(Object.keys(mod).sort())' -- /path/to/pi_natives.<tag>[-variant].node
```

Confirm the export and the package-version sentinel are present. Do not add optional consumer checks for a required export to conceal an artifact mismatch.

## Common failures

### Stale variant or cache wins

x64 candidate order is modern → baseline → unsuffixed for a modern host, and baseline → unsuffixed for a baseline host. Compiled and staged Windows loads can also win from `<getNativesDir()>/<version>` before package paths.

Remove only the stale local artifacts/cache identified by loader diagnostics, then rebuild. The loader best-effort deletes cache directories from valid older releases after a successful load, but it intentionally preserves the current-version directory.

### Declarations changed but shipping addon did not

`build:bindings` owns declaration generation; `build` owns the Bazel host artifact. CI/release targets own cross-platform artifacts. Verify both generated source control outputs and the actual binary used by the scenario.

### Same-version incomplete addon

The sentinel proves release version, not the complete export set. A locally produced same-version binary can pass loading while missing a newly generated member. Inspect `Object.keys` on the actual candidate and rebuild it; do not weaken the caller.

### Runtime enum missing

napi-rs enum declarations alone do not supply the root's literal runtime object. Run `build:bindings` and verify the generated block. If `gen-enums.ts` cannot parse the declaration shape, fix the generator rather than hand-editing its marked block.

### Wrong sync/async assumption

Use `native/index.d.ts` as authority. For example, `renderSnapcompactPng` returns `Promise<string>`, while `snapcompactSupportedChars` is synchronous. A port that changes call style requires an intentional consumer migration.

## Completion criteria

A port is complete only when the generated declaration and ESM export match the Rust API, the intended consumers use it, obsolete JS code is gone, a focused real invocation succeeds against the built addon, and representative comparison shows acceptable behavior and performance.
