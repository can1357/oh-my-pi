use std::{
	env,
	ffi::OsString,
	fmt::Write as _,
	fs,
	path::{Path, PathBuf},
	process::Command,
};

fn main() {
	napi_build::setup();
	build_oauth_callback_helper();
	generate_minimizer_builtin_filters();
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

	let result = Command::new("/usr/bin/xcrun")
		.current_dir(&manifest_dir)
		.args([
			"clang",
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

fn generate_minimizer_builtin_filters() {
	let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set");
	let defs_dir = Path::new(&manifest_dir)
		.join("src")
		.join("shell")
		.join("minimizer")
		.join("defs");
	let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR should be set"));
	let output_path = out_dir.join("builtin_filters.toml");

	println!("cargo:rerun-if-changed={}", defs_dir.display());

	let mut concatenated =
		String::from("# Auto-generated by build.rs -- do not edit.\nschema_version = 1\n\n");

	let mut entries: Vec<PathBuf> = Vec::new();
	if let Ok(read_dir) = fs::read_dir(&defs_dir) {
		for entry in read_dir.flatten() {
			let path = entry.path();
			if path.extension().and_then(|e| e.to_str()) == Some("toml") {
				entries.push(path);
			}
		}
	}
	entries.sort();

	for path in entries {
		println!("cargo:rerun-if-changed={}", path.display());
		match fs::read_to_string(&path) {
			Ok(body) => {
				let filename = path
					.file_name()
					.and_then(|n| n.to_str())
					.unwrap_or("unknown");
				writeln!(concatenated, "# --- {filename} ---").expect("write to String");
				for line in body.lines() {
					let trimmed = line.trim_start();
					if trimmed.starts_with("schema_version") {
						continue;
					}
					concatenated.push_str(line);
					concatenated.push('\n');
				}
				concatenated.push('\n');
			},
			Err(e) => panic!("failed to read filter definition {}: {e}", path.display()),
		}
	}

	fs::write(&output_path, concatenated)
		.unwrap_or_else(|e| panic!("failed to write {}: {e}", output_path.display()));
}
