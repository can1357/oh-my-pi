// Keep `napi-build` referenced so Cargo preserves `wasi-heap-sync` feature unification
// without emitting an `unused_dependencies` warning.
extern crate napi_build as _;

fn main() {
  println!("cargo::rustc-check-cfg=cfg(tokio_unstable)");
  println!("cargo::rustc-check-cfg=cfg(omp_linked_natives)");
  println!("cargo::rerun-if-env-changed=OMP_LINKED_NATIVES");
  if std::env::var("OMP_LINKED_NATIVES").as_deref() == Ok("1") {
    println!("cargo::rustc-cfg=omp_linked_natives");
  }
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
  // Set by the user (`--cfg napi_wasi_no_heap_sync` in the target rustflags), never here: it
  // leaves out `src/wasi_heap_sync.rs`, and napi-build leaves out the matching `--wrap` link
  // arguments.
  println!("cargo::rustc-check-cfg=cfg(napi_wasi_no_heap_sync)");
  if std::env::var("TARGET").as_deref() == Ok("wasm32-wasip1-threads") {
    println!("cargo::rustc-cfg=napi_wasi_threads");
  }
  let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
  let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap();
  if target_os == "windows" && target_env == "gnu" {
    // Inline the windows-gnu libnode lookup instead of calling `napi_build::setup()`
    // so `napi` does not emit typedef `rerun-if-env-changed` directives.
    setup_windows_gnu();
  }
}

fn setup_windows_gnu() {
  if let Some(libnode_dir) = search_libnode_path() {
    let node_lib_path = libnode_dir.join("libnode.dll");
    if node_lib_path.exists() {
      println!("cargo::rustc-link-search=native={}", libnode_dir.display());
      println!("cargo::rustc-link-lib=node");
    } else {
      panic!("libnode.dll not found in {}", libnode_dir.display());
    }
  } else {
    panic!("libnode.dll not found in any search path");
  }
}

fn search_libnode_path() -> Option<std::path::PathBuf> {
  if let Some(path) = std::env::var_os("LIBNODE_PATH") {
    let libnode_dir = std::path::PathBuf::from(path);
    if libnode_dir.exists() {
      return Some(libnode_dir);
    }
  }

  if let Some(paths) = std::env::var_os("LIBPATH") {
    for path in std::env::split_paths(&paths) {
      if path.join("libnode.dll").exists() {
        return Some(path);
      }
    }
  }

  if let Some(paths) = std::env::var_os("PATH") {
    for path in std::env::split_paths(&paths) {
      if path.join("libnode.dll").exists() {
        return Some(path);
      }
    }
  }

  None
}
