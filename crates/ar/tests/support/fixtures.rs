//! Access to the validated fixture bundle shared with the TypeScript suite.
//!
//! The bundle is `tests/fixtures/ar.tar.gz`, produced and cross-validated by
//! the archive suite; reading it through [`Archive`] dogfoods the
//! tar.gz path on every suite run.

use std::{path::Path, sync::OnceLock};

use omp_ar::{Archive, Files};

static BUNDLE: OnceLock<Files> = OnceLock::new();

/// Returns one fixture's bytes from the shared bundle by member name.
pub fn fixture_bytes(name: &str) -> Vec<u8> {
	let files = BUNDLE.get_or_init(|| {
		let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ar.tar.gz");
		Archive::open(path)
			.expect("fixture bundle opens")
			.read_all()
			.expect("fixture bundle reads")
	});
	files
		.get(name)
		.unwrap_or_else(|| panic!("missing fixture {name}"))
		.clone()
}
