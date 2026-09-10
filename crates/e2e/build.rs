//! Applies omp-py's final-link requirements to the executable acceptance host.

use std::{
	env,
	path::{Path, PathBuf},
};

fn main() {
	println!("cargo::rerun-if-env-changed=PYO3_CONFIG_FILE");

	let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
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
		// as always changed, which would relink the e2e host per build.
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
				"omp-e2e's release macOS link requires omp-py's ld64.lld shim at {}; restore \
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
