//! Generates packaged documentation and applies omp-py's final-link
//! requirements.

use std::{
	env,
	fmt::Write as _,
	fs,
	io::{self, Write as _},
	path::{Path, PathBuf},
};

use flate2::{Compression, write::GzEncoder};

fn main() {
	let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
	generate_docs_manifest(&manifest).expect("generate compressed omp:// documentation manifest");
	println!("cargo::rerun-if-env-changed=PYO3_CONFIG_FILE");

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
		// as always changed, which would rebuild omp-tools (and every
		// dependent) on each invocation.
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
				"omp-tools tests require omp-py's ld64.lld shim at {}; restore \
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

fn generate_docs_manifest(manifest: &Path) -> io::Result<()> {
	let docs_root = manifest.join("../../docs");
	println!("cargo::rerun-if-changed={}", docs_root.display());
	let output_root = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo sets OUT_DIR"));
	let mut paths = Vec::new();
	collect_markdown(&docs_root, &docs_root, &mut paths)?;
	paths.sort();

	let mut generated = String::from(
		"/// Sorted packaged documentation entries: `(relative path, gzip bytes)`.\npub static \
		 PACKAGED_DOCS: &[(&str, &[u8])] = &[\n",
	);
	for (index, relative) in paths.iter().enumerate() {
		let source = docs_root.join(relative);
		let body = fs::read(&source)?;
		let compressed_path = output_root.join(format!("omp-doc-{index}.gz"));
		let mut encoder = GzEncoder::new(Vec::new(), Compression::best());
		encoder.write_all(&body)?;
		fs::write(&compressed_path, encoder.finish()?)?;
		let relative = relative.to_string_lossy().replace('\\', "/");
		let _ = writeln!(
			generated,
			"\t({relative:?}, include_bytes!({compressed:?})),",
			compressed = compressed_path.display().to_string()
		);
	}
	generated.push_str("];\n");
	fs::write(output_root.join("omp_docs.rs"), generated)
}

fn collect_markdown(root: &Path, directory: &Path, output: &mut Vec<PathBuf>) -> io::Result<()> {
	let entries = match fs::read_dir(directory) {
		Ok(entries) => entries,
		Err(error) if error.kind() == io::ErrorKind::NotFound && directory == root => return Ok(()),
		Err(error) => return Err(error),
	};
	for entry in entries {
		let entry = entry?;
		let file_type = entry.file_type()?;
		if file_type.is_symlink() {
			continue;
		}
		if file_type.is_dir() {
			collect_markdown(root, &entry.path(), output)?;
		} else if file_type.is_file() && entry.path().extension().is_some_and(|ext| ext == "md") {
			output.push(
				entry
					.path()
					.strip_prefix(root)
					.expect("entry remains below docs root")
					.to_path_buf(),
			);
		}
	}
	Ok(())
}
