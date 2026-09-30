# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial vendor import of napi-rs 3.13.0

## [3.13.0](https://github.com/napi-rs/napi-rs/compare/napi-v3.12.7...napi-v3.13.0) - 2026-09-22

### Added

- *(async-runtime)* offer the MultiThread flavor on wasm32-wasip1-threads ([#3541](https://github.com/napi-rs/napi-rs/pull/3541))

### Fixed

- *(napi)* validate native payload provenance for External and instance data ([#3540](https://github.com/napi-rs/napi-rs/pull/3540))

## [3.12.7](https://github.com/napi-rs/napi-rs/compare/napi-v3.12.6...napi-v3.12.7) - 2026-09-20

### Fixed

- *(napi)* guard AsyncTask completion against env teardown ([#3536](https://github.com/napi-rs/napi-rs/pull/3536))

## [3.12.6](https://github.com/napi-rs/napi-rs/compare/napi-v3.12.5...napi-v3.12.6) - 2026-09-16

### Fixed

- *(cli)* drain outstanding async work before disposing a WASI binding ([#3528](https://github.com/napi-rs/napi-rs/pull/3528))

## [3.12.5](https://github.com/napi-rs/napi-rs/compare/napi-v3.12.4...napi-v3.12.5) - 2026-09-15

### Fixed

- fatal_exception noop in optimized builds ([#3509](https://github.com/napi-rs/napi-rs/pull/3509))

## [3.12.4](https://github.com/napi-rs/napi-rs/compare/napi-v3.12.3...napi-v3.12.4) - 2026-09-11

### Fixed

- *(napi)* return errors from the serde deserializer for unexpected JS value shapes ([#3507](https://github.com/napi-rs/napi-rs/pull/3507))
- *(napi)* validate wrapped payload provenance in Object::unwrap/remove_wrapped ([#3506](https://github.com/napi-rs/napi-rs/pull/3506))
- *(napi)* point from_external slices at the engine-owned copy after finalize reclaims the source ([#3503](https://github.com/napi-rs/napi-rs/pull/3503))

## [3.12.3](https://github.com/napi-rs/napi-rs/compare/napi-v3.12.2...napi-v3.12.3) - 2026-09-10

### Security

- `BufferSlice::from_data`, `BufferSlice::copy_from` and `BufferSlice::from_external` built their `Deref`/`DerefMut` slice over the `napi_value` handle instead of the buffer's bytes (OOB read into V8's handle scope, attacker-length OOB write). Fixed as part of [#3489](https://github.com/napi-rs/napi-rs/pull/3489). See [GHSA-3hv5-cch8-c72w](https://github.com/napi-rs/napi-rs/security/advisories/GHSA-3hv5-cch8-c72w).

### Fixed

- CurrentThread waker-stack deadlocks and threadless-wasm Buffer detachment ([#3489](https://github.com/napi-rs/napi-rs/pull/3489))
- *(napi)* catch panics in closure trampolines instead of aborting ([#3473](https://github.com/napi-rs/napi-rs/pull/3473))

### Other

- *(napi)* keep anyhow error cause when converting ([#3477](https://github.com/napi-rs/napi-rs/pull/3477))
- *(napi)* outline threadsafe callback dispatch ([#3465](https://github.com/napi-rs/napi-rs/pull/3465))
- *(napi)* outline class instance construction ([#3464](https://github.com/napi-rs/napi-rs/pull/3464))

## [3.12.2](https://github.com/napi-rs/napi-rs/compare/napi-v3.12.1...napi-v3.12.2) - 2026-08-21

### Fixed

- *(napi)* memory safety in PromiseRaw callbacks and AbortSignal conversion ([#3458](https://github.com/napi-rs/napi-rs/pull/3458))

## [3.12.1](https://github.com/napi-rs/napi-rs/compare/napi-v3.12.0...napi-v3.12.1) - 2026-08-10

### Fixed

- *(napi)* stop unloading addons with live native code, preserve non-Error rejections, and add the wasm teardown barrier ([#3423](https://github.com/napi-rs/napi-rs/pull/3423))
- *(wasi)* avoid randomness during module registration ([#3447](https://github.com/napi-rs/napi-rs/pull/3447))

## [3.12.0](https://github.com/napi-rs/napi-rs/compare/napi-v3.11.0...napi-v3.12.0) - 2026-07-28

### Added

- *(cli)* support non-threaded WASI targets ([#3353](https://github.com/napi-rs/napi-rs/pull/3353))

## [3.11.0](https://github.com/napi-rs/napi-rs/compare/napi-v3.10.5...napi-v3.11.0) - 2026-07-21

### Added

- unforgeable `#[napi]` class identity via Node object type tags ([#3405](https://github.com/napi-rs/napi-rs/pull/3405))
- *(napi)* add pluggable async runtime backend ([#3352](https://github.com/napi-rs/napi-rs/pull/3352))

### Fixed

- *(napi)* release JsDeferred tsfn on null-env teardown drain (#3404 follow-up) ([#3408](https://github.com/napi-rs/napi-rs/pull/3408))
- *(napi)* guard JsDeferred against env teardown ([#3404](https://github.com/napi-rs/napi-rs/pull/3404))
- *(napi)* register the async runtime env cleanup hook per registration ([#3400](https://github.com/napi-rs/napi-rs/pull/3400))

### Other

- *(napi)* share tracing callsite ([#3409](https://github.com/napi-rs/napi-rs/pull/3409))

## [3.10.5](https://github.com/napi-rs/napi-rs/compare/napi-v3.10.4...napi-v3.10.5) - 2026-07-13

### Fixed

- *(napi)* release FunctionRef off the JS thread via the custom-GC TSFN ([#3394](https://github.com/napi-rs/napi-rs/pull/3394))

## [3.10.4](https://github.com/napi-rs/napi-rs/compare/napi-v3.10.3...napi-v3.10.4) - 2026-07-12

### Fixed

- *(cli)* align build and project configuration ([#3387](https://github.com/napi-rs/napi-rs/pull/3387))

### Other

- *(readme)* point sponsors image at napi.rs/sponsors.svg ([#3379](https://github.com/napi-rs/napi-rs/pull/3379))

## [3.10.3](https://github.com/napi-rs/napi-rs/compare/napi-v3.10.2...napi-v3.10.3) - 2026-07-04

### Fixed

- *(napi)* preserve the JS error object when cloning an Error off-thread ([#3375](https://github.com/napi-rs/napi-rs/pull/3375))

## [3.10.2](https://github.com/napi-rs/napi-rs/compare/napi-v3.10.1...napi-v3.10.2) - 2026-07-03

### Fixed

- *(napi)* keep message and cause when cloning a JS-exception Error off-thread ([#3373](https://github.com/napi-rs/napi-rs/pull/3373))

## [3.10.1](https://github.com/napi-rs/napi-rs/compare/napi-v3.10.0...napi-v3.10.1) - 2026-07-03

### Fixed

- *(napi)* release Error's exception reference via the custom GC when dropped off-thread. ([#3370](https://github.com/napi-rs/napi-rs/pull/3370))
- *(napi)* stop ref exception object in ThreadsafeFunction sync-throw path on wasm targets ([#3369](https://github.com/napi-rs/napi-rs/pull/3369))

### Other

- *(napi)* share class accessor trampolines ([#3364](https://github.com/napi-rs/napi-rs/pull/3364))
- optimize object field raw property access ([#3365](https://github.com/napi-rs/napi-rs/pull/3365))

## [3.10.0](https://github.com/napi-rs/napi-rs/compare/napi-v3.9.4...napi-v3.10.0) - 2026-07-01

### Added

- *(napi)* implement `To`/`FromNapiValue` for `OsString`, `OsStr`, `Path` and `PathBuf` ([#3339](https://github.com/napi-rs/napi-rs/pull/3339))

### Fixed

- *(napi)* route custom-GC Buffer/TypedArray cross-thread drops through the owning isolate ([#3357](https://github.com/napi-rs/napi-rs/pull/3357)) ([#3360](https://github.com/napi-rs/napi-rs/pull/3360))

## [3.9.4](https://github.com/napi-rs/napi-rs/compare/napi-v3.9.3...napi-v3.9.4) - 2026-06-24

### Other

- *(napi-derive)* outline #[napi(object)] field-error decoration ([#3338](https://github.com/napi-rs/napi-rs/pull/3338))

## [3.9.3](https://github.com/napi-rs/napi-rs/compare/napi-v3.9.2...napi-v3.9.3) - 2026-06-18

### Fixed

- *(napi)* sync referred flag when creating a weak ThreadsafeFunction ([#3337](https://github.com/napi-rs/napi-rs/pull/3337))

### Other

- *(napi)* outline non-generic core of ThreadsafeFunction::create ([#3334](https://github.com/napi-rs/napi-rs/pull/3334))

## [3.9.2](https://github.com/napi-rs/napi-rs/compare/napi-v3.9.1...napi-v3.9.2) - 2026-06-14

### Fixed

- *(napi)* ReadableStream Reader loses chunks and aborts on errored streams ([#3328](https://github.com/napi-rs/napi-rs/pull/3328))

## [3.9.1](https://github.com/napi-rs/napi-rs/compare/napi-v3.9.0...napi-v3.9.1) - 2026-06-10

### Fixed

- *(napi)* unify Reference finalize callbacks on Arc (Rc/Arc type confusion) ([#3313](https://github.com/napi-rs/napi-rs/pull/3313))
- *(napi)* zero-copy external strings, fix WASI double-free ([#3308](https://github.com/napi-rs/napi-rs/pull/3308))
- *(napi)* experimental node_api_create_object_with_properties ([#3304](https://github.com/napi-rs/napi-rs/pull/3304))

## [3.9.0](https://github.com/napi-rs/napi-rs/compare/napi-v3.8.6...napi-v3.9.0) - 2026-05-13

### Added

- *(napi)* add `ThreadsafeFunction::call_async_catch` to handle errors in callback functions ([#3291](https://github.com/napi-rs/napi-rs/pull/3291))

### Fixed

- *(deps)* update rust crate ctor to v1 ([#3276](https://github.com/napi-rs/napi-rs/pull/3276))
- *(deps)* update rust crate ctor to 0.13.0 ([#3275](https://github.com/napi-rs/napi-rs/pull/3275))
- *(deps)* update rust crate ctor to 0.12.0 ([#3271](https://github.com/napi-rs/napi-rs/pull/3271))

## [3.8.6](https://github.com/napi-rs/napi-rs/compare/napi-v3.8.5...napi-v3.8.6) - 2026-04-28

### Fixed

- *(deps)* update rust crate ctor to 0.11.0 ([#3270](https://github.com/napi-rs/napi-rs/pull/3270))
- *(napi)* Convert #[ctor] calls to declarative form to remove all features ([#3257](https://github.com/napi-rs/napi-rs/pull/3257))

### Other

- *(napi)* skip duplicate validation ([#3268](https://github.com/napi-rs/napi-rs/pull/3268))
- *(napi)* clarify unsafe function invariants ([#3267](https://github.com/napi-rs/napi-rs/pull/3267))

## [3.8.5](https://github.com/napi-rs/napi-rs/compare/napi-v3.8.4...napi-v3.8.5) - 2026-04-15

### Fixed

- *(napi)* preserve generator class methods ([#3231](https://github.com/napi-rs/napi-rs/pull/3231))
- *(deps)* update rust crate ctor to v0.10.0 ([#3224](https://github.com/napi-rs/napi-rs/pull/3224))
- *(deps)* disable ctor priority feature ([#3209](https://github.com/napi-rs/napi-rs/pull/3209))
- *(deps)* update rust crate ctor to v0.9.1 ([#3204](https://github.com/napi-rs/napi-rs/pull/3204))
- *(napi)* handle ThreadsafeFunction callback errors gracefully during shutdown ([#3188](https://github.com/napi-rs/napi-rs/pull/3188))
- *(napi)* populate Error::cause from ThreadsafeFunction callee-handled callbacks ([#3162](https://github.com/napi-rs/napi-rs/pull/3162))
- correct typo in Either error message ("non" → "none") ([#3183](https://github.com/napi-rs/napi-rs/pull/3183))

## [3.8.4](https://github.com/napi-rs/napi-rs/compare/napi-v3.8.3...napi-v3.8.4) - 2026-03-28

### Fixed

- *(deps)* update rust crate ctor to v0.8.0 ([#3170](https://github.com/napi-rs/napi-rs/pull/3170))
- *(deps)* update rust crate ctor to v0.7.0 ([#3169](https://github.com/napi-rs/napi-rs/pull/3169))
- *(napi)* check for null error_message in ExtendedErrorInfo::try_from ([#3158](https://github.com/napi-rs/napi-rs/pull/3158))
- *(napi)* skip nullish error causes when converting from Unknown ([#3143](https://github.com/napi-rs/napi-rs/pull/3143))

## [3.8.3](https://github.com/napi-rs/napi-rs/compare/napi-v3.8.2...napi-v3.8.3) - 2026-02-14

### Fixed

- *(napi)* prevent async iterator use-after-free during GC ([#3120](https://github.com/napi-rs/napi-rs/pull/3120))

### Other

- replace `BufferRef` mention with `BufferSlice` ([#3112](https://github.com/napi-rs/napi-rs/pull/3112))

## [3.8.2](https://github.com/napi-rs/napi-rs/compare/napi-v3.8.1...napi-v3.8.2) - 2026-01-08

### Fixed

- *(napi)* memory leak in async fn ([#3089](https://github.com/napi-rs/napi-rs/pull/3089))
- *(napi)* implement TypeName for ArrayBuffer ([#3087](https://github.com/napi-rs/napi-rs/pull/3087))

## [3.8.1](https://github.com/napi-rs/napi-rs/compare/napi-v3.8.0...napi-v3.8.1) - 2025-12-30

### Fixed

- *(napi)* wasi debug compile error ([#3081](https://github.com/napi-rs/napi-rs/pull/3081))

## [3.8.0](https://github.com/napi-rs/napi-rs/compare/napi-v3.7.1...napi-v3.8.0) - 2025-12-30

### Added

- *(napi)* support any object types in Stream([#2854](https://github.com/napi-rs/napi-rs/pull/2854))
- *(napi-derive)* add #[napi(async_iterator)] macro attribute ([#3072](https://github.com/napi-rs/napi-rs/pull/3072))

### Fixed

- *(napi)* validate status before copying data in env arraybuffer fallback ([#3077](https://github.com/napi-rs/napi-rs/pull/3077))
- *(napi)* validate status before copying in remaining TypedArray fallback paths ([#3076](https://github.com/napi-rs/napi-rs/pull/3076))
- *(napi)* validate status before copying in TypedArray owned ToNapiValue fallback ([#3080](https://github.com/napi-rs/napi-rs/pull/3080))
- *(napi)* validate status before copying in ArrayBuffer ToNapiValue fallback ([#3079](https://github.com/napi-rs/napi-rs/pull/3079))
- *(napi)* skip debug buffer tracking on wasm targets ([#3078](https://github.com/napi-rs/napi-rs/pull/3078))

## [3.7.1](https://github.com/napi-rs/napi-rs/compare/napi-v3.7.0...napi-v3.7.1) - 2025-12-19

### Other

- clippy fix for Rust 1.92.0 ([#3058](https://github.com/napi-rs/napi-rs/pull/3058))

## [3.7.0](https://github.com/napi-rs/napi-rs/compare/napi-v3.6.1...napi-v3.7.0) - 2025-12-09

### Added

- *(napi)* provide unsafe as_mut on ArrayBuffer ([#3055](https://github.com/napi-rs/napi-rs/pull/3055))
- *(napi)* support Promise.resolve/reject ([#3053](https://github.com/napi-rs/napi-rs/pull/3053))

## [3.6.1](https://github.com/napi-rs/napi-rs/compare/napi-v3.6.0...napi-v3.6.1) - 2025-12-02

### Other

- updated the following local packages: napi-sys

## [3.6.0](https://github.com/napi-rs/napi-rs/compare/napi-v3.5.2...napi-v3.6.0) - 2025-12-02

### Added

- *(napi-derive)* add tracing feature for debug logging NAPI function calls ([#3041](https://github.com/napi-rs/napi-rs/pull/3041))
- *(napi)* add node_api_create_object_with_properties support for enum creation ([#2990](https://github.com/napi-rs/napi-rs/pull/2990))

### Fixed

- *(napi)* bigInt comparison ([#3039](https://github.com/napi-rs/napi-rs/pull/3039))
- *(napi)* shutdown runtime at env cleanup on windows ([#3026](https://github.com/napi-rs/napi-rs/pull/3026))

### Other

- *(napi)* add back pub NODE_VERSION_* ([#3046](https://github.com/napi-rs/napi-rs/pull/3046))
- *(sys)* add back non dyn-symbols behavior ([#3045](https://github.com/napi-rs/napi-rs/pull/3045))
- *(napi)* add Eq and PartialEq trait to BigInt ([#3033](https://github.com/napi-rs/napi-rs/pull/3033))
- update MSRV in README.md ([#3023](https://github.com/napi-rs/napi-rs/pull/3023))

## [3.5.2](https://github.com/napi-rs/napi-rs/compare/napi-v3.5.1...napi-v3.5.2) - 2025-11-10

### Other

- updated the following local packages: napi-build

## [3.5.1](https://github.com/napi-rs/napi-rs/compare/napi-v3.5.0...napi-v3.5.1) - 2025-11-07

### Fixed

- *(napi)* TypedArraySlice creation ([#3004](https://github.com/napi-rs/napi-rs/pull/3004))

### Other

- *(napi)* Promise and ThreadsafeFunction::call_async don't require tokio ([#2998](https://github.com/napi-rs/napi-rs/pull/2998))

## [3.5.0](https://github.com/napi-rs/napi-rs/compare/napi-v3.4.0...napi-v3.5.0) - 2025-11-06

### Added

- *(sys)* use libloading to load napi symbols at runtime on all platform ([#2996](https://github.com/napi-rs/napi-rs/pull/2996))

### Fixed

- *(napi)* memory leak in PromiseRaw cleanup callback ([#2995](https://github.com/napi-rs/napi-rs/pull/2995))

### Other

- *(napi)* mark tsfn data as pub and split SendableResolver to indent file ([#2992](https://github.com/napi-rs/napi-rs/pull/2992))
- *(napi)* mark SendableResolver and PromiseRaw as pub ([#2981](https://github.com/napi-rs/napi-rs/pull/2981))
- add sponsors

## [3.4.0](https://github.com/napi-rs/napi-rs/compare/napi-v3.3.0...napi-v3.4.0) - 2025-10-24

### Added

- *(napi)* add on_abort for AbortSignal ([#2942](https://github.com/napi-rs/napi-rs/pull/2942))
- *(cli)* add support for loongarch64-unknown-linux-gnu ([#2887](https://github.com/napi-rs/napi-rs/pull/2887))

### Fixed

- *(napi)* stop ref error object in wasm targets ([#2975](https://github.com/napi-rs/napi-rs/pull/2975))
- *(deps)* update rust crate ctor to v0.6.0 ([#2951](https://github.com/napi-rs/napi-rs/pull/2951))
- *(napi)* cleanup memory issues ([#2949](https://github.com/napi-rs/napi-rs/pull/2949))
- *(napi)* node_api_create_external_string_utf16 on wasm ([#2912](https://github.com/napi-rs/napi-rs/pull/2912))

### Other

- *(napi)* bump rust-version ([#2966](https://github.com/napi-rs/napi-rs/pull/2966))

## [3.3.0](https://github.com/napi-rs/napi-rs/compare/napi-v3.2.4...napi-v3.3.0) - 2025-09-08

### Added

- *(napi)* implement from_static on JsStringLatin1 and JsStringUtf16 ([#2908](https://github.com/napi-rs/napi-rs/pull/2908))
- *(napi)* support external JsStringLatin1 and JsStringUtf16 ([#2898](https://github.com/napi-rs/napi-rs/pull/2898))

### Fixed

- *(napi)* JsStringUtf8 memory leak ([#2911](https://github.com/napi-rs/napi-rs/pull/2911))

### Other

- *(cli)* show NAPI options on new command ([#2892](https://github.com/napi-rs/napi-rs/pull/2892))

## [3.2.4](https://github.com/napi-rs/napi-rs/compare/napi-v3.2.3...napi-v3.2.4) - 2025-08-16

### Other

- *(napi)* extends the Set types interoperability ([#2875](https://github.com/napi-rs/napi-rs/pull/2875))

## [3.2.3](https://github.com/napi-rs/napi-rs/compare/napi-v3.2.2...napi-v3.2.3) - 2025-08-13

### Fixed

- *(napi)* link issue on cargo test --features noop ([#2872](https://github.com/napi-rs/napi-rs/pull/2872))
- *(deps)* update rust crate ctor to v0.5.0 ([#2865](https://github.com/napi-rs/napi-rs/pull/2865))

## [3.2.2](https://github.com/napi-rs/napi-rs/compare/napi-v3.2.1...napi-v3.2.2) - 2025-08-08

### Fixed

- *(napi)* no need to cleanup thread_local stuff ([#2851](https://github.com/napi-rs/napi-rs/pull/2851))

## [3.2.1](https://github.com/napi-rs/napi-rs/compare/napi-v3.2.0...napi-v3.2.1) - 2025-08-08

### Fixed

- *(napi)* ensure tokio runtime is initialized for dlopen ([#2850](https://github.com/napi-rs/napi-rs/pull/2850))
- *(napi)* handle the return_if_invalid for Array param ([#2846](https://github.com/napi-rs/napi-rs/pull/2846))

## [3.2.0](https://github.com/napi-rs/napi-rs/compare/napi-v3.1.6...napi-v3.2.0) - 2025-08-07

### Added

- *(napi)* add ScopeGenerator trait ([#2831](https://github.com/napi-rs/napi-rs/pull/2831))
- make generator an iterator ([#2784](https://github.com/napi-rs/napi-rs/pull/2784))
- *(napi)* add `Error.cause` support to `napi::Error` ([#2829](https://github.com/napi-rs/napi-rs/pull/2829))

### Fixed

- *(napi)* user_defined_rt can only be used once ([#2841](https://github.com/napi-rs/napi-rs/pull/2841))

## [3.1.6](https://github.com/napi-rs/napi-rs/compare/napi-v3.1.5...napi-v3.1.6) - 2025-08-01

### Fixed

- *(napi)* async task finally is not called ([#2824](https://github.com/napi-rs/napi-rs/pull/2824))

## [3.1.5](https://github.com/napi-rs/napi-rs/compare/napi-v3.1.4...napi-v3.1.5) - 2025-07-31

### Fixed

- *(napi)* relax the lifetime restriction in PromiseRaw callbacks ([#2819](https://github.com/napi-rs/napi-rs/pull/2819))

## [3.1.4](https://github.com/napi-rs/napi-rs/compare/napi-v3.1.3...napi-v3.1.4) - 2025-07-30

### Fixed

- *(napi)* the generic trait rectiction of Env::spawn should be ScopedTask ([#2817](https://github.com/napi-rs/napi-rs/pull/2817))

## [3.1.3](https://github.com/napi-rs/napi-rs/compare/napi-v3.1.2...napi-v3.1.3) - 2025-07-24

### Other

- *(napi)* optimize HashMap allocation in FromNapiValue implementation for HashMap ([#2796](https://github.com/napi-rs/napi-rs/pull/2796))

## [3.1.2](https://github.com/napi-rs/napi-rs/compare/napi-v3.1.1...napi-v3.1.2) - 2025-07-22

### Other

- *(napi)* use Vec with_capacity in FromNapiValue ([#2793](https://github.com/napi-rs/napi-rs/pull/2793))

## [3.1.1](https://github.com/napi-rs/napi-rs/compare/napi-v3.1.0...napi-v3.1.1) - 2025-07-21

### Other

- Revert "fix(napi): callback should be Fn rather than FnOnce" ([#2791](https://github.com/napi-rs/napi-rs/pull/2791))

## [3.1.0](https://github.com/napi-rs/napi-rs/compare/napi-v3.0.0...napi-v3.1.0) - 2025-07-21

### Added

- *(napi)* provide ScopedTask to resolve JsValue with lifetime ([#2786](https://github.com/napi-rs/napi-rs/pull/2786))

### Other

- *(napi)* add UnwindSafe and RefUnwindSafe back to AbortSignal and AsyncWorkPromise ([#2789](https://github.com/napi-rs/napi-rs/pull/2789))
- pin release-plz action
