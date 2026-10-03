fn main() {
  println!("cargo::rustc-check-cfg=cfg(tokio_unstable)");
  // The two WASI targets are indistinguishable at cfg level on current rustc:
  // `rustc --print cfg` emits IDENTICAL sets for wasm32-wasip1 and
  // wasm32-wasip1-threads (same `target_env = "p1"`, and `target_feature =
  // "atomics"` is set for NEITHER -- verified empirically: the two printed
  // cfg sets diff clean). Only wasm32-wasip1-threads has a *shared* linear
  // memory, whose already-handed-out `ArrayBuffer` views survive
  // `memory.grow`, and `create_external_buffer` in
  // `src/bindgen_runtime/js_values/buffer.rs` must tell that apart from the
  // threadless target it otherwise looks identical to. That discrimination
  // therefore comes from the exact cargo TARGET, emitted here as a
  // first-party cfg.
  println!("cargo::rustc-check-cfg=cfg(napi_wasi_threads)");
  if std::env::var("TARGET").as_deref() == Ok("wasm32-wasip1-threads") {
    println!("cargo::rustc-cfg=napi_wasi_threads");
  }
  let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
  let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap();
  if target_os == "windows" && target_env == "gnu" {
    napi_build::setup();
  }
}
