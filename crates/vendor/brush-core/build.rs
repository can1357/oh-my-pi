//! Detects a nightly toolchain: `Command::setsid` (`process_setsid`) is unstable, so
//! stable builds fall back to a `pre_exec(setsid)` closure in `detach_session`.
fn main() {
    println!("cargo::rustc-check-cfg=cfg(brush_nightly_setsid)");
    println!("cargo::rerun-if-changed=build.rs");
    let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let out = std::process::Command::new(rustc).arg("-vV").output();
    let nightly = out
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .is_some_and(|v| v.contains("nightly") || v.contains("-dev"));
    if nightly || std::env::var_os("RUSTC_BOOTSTRAP").is_some() {
        println!("cargo::rustc-cfg=brush_nightly_setsid");
    }
}
