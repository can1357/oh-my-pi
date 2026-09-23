use std::{env, ffi::OsString, path::PathBuf, process::Command};

fn main() {
	napi_build::setup();
	build_oauth_callback_helper();
}

fn build_oauth_callback_helper() {
	let target_os = env::var("CARGO_CFG_TARGET_OS").expect("CARGO_CFG_TARGET_OS should be set");
	if target_os == "macos" {
		build_darwin_oauth_callback_helper();
	} else {
		build_oauth_callback_relay(&target_os);
	}
}

fn build_oauth_callback_relay(target_os: &str) {
	let manifest_dir =
		PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set"));
	let relay_source = manifest_dir.join("src/oauth_callback/relay.rs");
	let publication_source = manifest_dir.join("src/oauth_callback/publication.rs");
	let target = env::var("TARGET").expect("TARGET should be set");
	let rustc = env::var_os("RUSTC").unwrap_or_else(|| OsString::from("rustc"));
	let mut output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR should be set"))
		.join("omp-oauth-callback-relay");
	if target_os == "windows" {
		output.set_extension("exe");
	}

	println!("cargo:rerun-if-changed={}", relay_source.display());
	println!("cargo:rerun-if-changed={}", publication_source.display());
	println!("cargo:rerun-if-env-changed=RUSTC_LINKER");
	let target_linker_variable =
		format!("CARGO_TARGET_{}_LINKER", target.replace(['-', '.'], "_").to_ascii_uppercase());
	println!("cargo:rerun-if-env-changed={target_linker_variable}");

	let mut command = Command::new(rustc);
	command
		.current_dir(&manifest_dir)
		.arg("--crate-name")
		.arg("omp_oauth_callback_relay")
		.arg("--crate-type=bin")
		.arg("--edition=2024")
		.arg("--target")
		.arg(&target)
		.arg("-Copt-level=z")
		.arg("-Ccodegen-units=1")
		.arg("-Cpanic=abort")
		.arg("-Cstrip=symbols")
		.arg(&relay_source)
		.arg("-o")
		.arg(&output);

	if let Some(encoded_flags) = env::var_os("CARGO_ENCODED_RUSTFLAGS") {
		for flag in encoded_flags
			.to_string_lossy()
			.split('\u{1f}')
			.filter(|flag| !flag.is_empty())
		{
			command.arg(flag);
		}
	}
	if let Some(linker) = target_linker(&target) {
		let mut linker_argument = OsString::from("linker=");
		linker_argument.push(linker);
		command.arg("-C").arg(linker_argument);
	}
	if target_os == "windows" {
		command.arg("-Ctarget-feature=+crt-static");
	}

	let result = command
		.output()
		.unwrap_or_else(|error| panic!("failed to invoke rustc for OAuth callback relay: {error}"));
	assert!(
		result.status.success(),
		"failed to build OAuth callback relay for {target} ({}):\nstdout:\n{}\nstderr:\n{}",
		result.status,
		String::from_utf8_lossy(&result.stdout),
		String::from_utf8_lossy(&result.stderr)
	);
	println!("cargo:rustc-env=OMP_OAUTH_RELAY_BINARY={}", output.display());
}

#[path = "src/oauth_callback/darwin_compiler.rs"]
mod darwin_compiler;

fn build_darwin_oauth_callback_helper() {
	let manifest_dir =
		PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set"));
	let source = manifest_dir.join("src/oauth_callback/darwin-helper.m");
	let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR should be set"))
		.join("omp-oauth-callback-darwin-helper");
	let architecture = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
		Ok("aarch64") => "arm64",
		Ok("x86_64") => "x86_64",
		Ok(architecture) => panic!("unsupported macOS OAuth helper architecture: {architecture}"),
		Err(error) => panic!("CARGO_CFG_TARGET_ARCH should be set: {error}"),
	};
	println!("cargo:rerun-if-changed={}", source.display());
	println!("cargo:rerun-if-env-changed=CC");
	println!("cargo:rerun-if-env-changed=SDKROOT");

	let mut command = darwin_compiler::darwin_compiler_command(env::var_os("CC").as_deref());
	command.current_dir(&manifest_dir);
	if let Some(sdk_root) = darwin_compiler::darwin_sdk_root(env::var_os("SDKROOT").as_deref()) {
		command.arg("-isysroot").arg(sdk_root);
	}
	let result = command
		.args([
			"-x",
			"objective-c",
			"-fobjc-arc",
			"-fblocks",
			"-fno-ident",
			"-Os",
			"-mmacosx-version-min=12.0",
			"-arch",
			architecture,
			"-framework",
			"AppKit",
			"-Wl,-dead_strip",
			"-Wl,-adhoc_codesign",
		])
		.arg(&source)
		.arg("-o")
		.arg(&output)
		.output()
		.unwrap_or_else(|error| panic!("failed to invoke clang for OAuth callback helper: {error}"));
	assert!(
		result.status.success(),
		"failed to build macOS OAuth callback helper ({}):\nstdout:\n{}\nstderr:\n{}",
		result.status,
		String::from_utf8_lossy(&result.stdout),
		String::from_utf8_lossy(&result.stderr)
	);
	println!("cargo:rustc-env=OMP_OAUTH_DARWIN_HELPER={}", output.display());
}

fn target_linker(target: &str) -> Option<OsString> {
	let target_key = target.replace(['-', '.'], "_").to_ascii_uppercase();
	env::var_os(format!("CARGO_TARGET_{target_key}_LINKER")).or_else(|| env::var_os("RUSTC_LINKER"))
}
