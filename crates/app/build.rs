//! Applies final-link requirements that cannot propagate from `omp-py`'s
//! library build script to `omp-app` binaries, examples, and test executables.
//!
//! When linking against a vendored `CPython` archive containing LLVM LTO
//! bitcode (marked with `needs-lld`, e.g. production release trees), the final
//! link must use `omp-py`'s ld64-to-lld shim. Dev builds link against
//! machine-code archives (freethreaded+debug) and skip the shim. Supported
//! native targets retain and export `CPython`'s global C API so native wheels
//! can resolve code and data symbols when they are loaded.

use std::{
	env, fs,
	path::{Path, PathBuf},
	process::Command,
};

fn main() {
	println!("cargo::rerun-if-env-changed=PYO3_CONFIG_FILE");

	let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
	write_changelog(&manifest);
	let vendor = env::var_os("PYO3_CONFIG_FILE")
		.map(PathBuf::from)
		.and_then(|p| {
			p.canonicalize()
				.ok()
				.or_else(|| manifest.join("../..").join(&p).canonicalize().ok())
		})
		.and_then(|p| p.parent().map(Path::to_path_buf));

	if let Some(vendor_dir) = &vendor {
		// Vendor-tree swaps rewrite PYTHON.json; tracking it covers the
		// appearance of the `needs-lld` marker. The marker itself is tracked
		// only while present — cargo treats a missing `rerun-if-changed` path
		// as always changed, which would relink every omp binary per build.
		let python_manifest = vendor_dir.join("PYTHON.json");
		if python_manifest.is_file() {
			println!("cargo::rerun-if-changed={}", python_manifest.display());
		}
		let marker = vendor_dir.join("needs-lld");
		if marker.is_file() {
			println!("cargo::rerun-if-changed={}", marker.display());
			let shim = manifest.join("../py/scripts/ld64.lld");
			println!("cargo::rerun-if-changed={}", shim.display());
			assert!(
				shim.is_file(),
				"omp's release macOS link requires omp-py's ld64.lld shim at {}; restore \
				 crates/py/scripts/ld64.lld",
				shim.display()
			);
			println!("cargo::rustc-link-arg=--ld-path={}", shim.display());
		}
	}

	// ld64 and ELF linkers spell this flag differently. In particular, passing
	// ld64's spelling to an ELF linker is parsed as `-e xport_dynamic`, which
	// produces a binary with no valid entry point. Other object formats have no
	// compatible flag.
	let target_vendor = env::var("CARGO_CFG_TARGET_VENDOR").unwrap_or_default();
	let target_family = env::var("CARGO_CFG_TARGET_FAMILY").unwrap_or_default();
	let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
	let link_arg = if target_vendor == "apple" {
		Some("-Wl,-export_dynamic")
	} else if target_os != "aix" && target_family.split(',').any(|family| family == "unix") {
		Some("-Wl,--export-dynamic")
	} else {
		None
	};
	if let Some(link_arg) = link_arg {
		println!("cargo::rustc-link-arg={link_arg}");
	}
}
fn write_changelog(manifest: &Path) {
	let workspace = manifest.join("../..");
	// Track only ref paths that exist: a missing `rerun-if-changed` path makes
	// cargo rerun this script (and relink omp) on every build. A tag created
	// on a tree where neither path existed refreshes the changelog on the next
	// ordinary rebuild instead.
	for refs in [workspace.join(".git/packed-refs"), workspace.join(".git/refs/tags")] {
		if refs.exists() {
			println!("cargo::rerun-if-changed={}", refs.display());
		}
	}
	let generated = Command::new("git")
		.arg("-C")
		.arg(&workspace)
		.args([
			"for-each-ref",
			"--sort=-version:refname",
			"--format=## %(refname:short) — %(creatordate:short)%0a%0a%(contents:subject)%0a",
			"refs/tags",
		])
		.output()
		.ok()
		.filter(|output| output.status.success() && !output.stdout.is_empty())
		.map_or_else(
			|| {
				format!(
					"## v{}\n\nCurrent release.\n",
					env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "unknown".to_owned())
				)
				.into_bytes()
			},
			|output| output.stdout,
		);
	let output =
		PathBuf::from(env::var_os("OUT_DIR").expect("Cargo provides OUT_DIR")).join("changelog.md");
	fs::write(output, generated).expect("write embedded changelog");
}
