//! Guard: every committed snapshot file must be named for THIS crate.
//!
//! `insta` derives a snapshot's filename from the crate name, so a crate
//! rename silently orphans every `.snap` on disk: the assertion looks for a
//! file that is not there, reports only a `+new` side with nothing to diff
//! against, and writes a `.snap.new` beside the original. Nothing fails at
//! compile time and nothing in review flags it — the files are still tracked,
//! still valid, and completely unreachable.
//!
//! This test turns that silence into a failure. It reads the snapshot
//! directories directly rather than asserting anything, so it fails for the
//! whole suite at once with a message that names the cause.

#[cfg(test)]
mod tests {
	use std::{fs, path::Path};

	/// Prefix `insta` derives for this crate, computed the way `insta` does it:
	/// the crate segment of `module_path!()` followed by `__`.
	///
	/// Deliberately NOT a literal. A literal would have to be updated in the
	/// same rename that orphans the snapshots, which is exactly the edit this
	/// test exists to catch being forgotten — spelling it out would let the
	/// guard pass while every snapshot goes unreachable again.
	fn expected_prefix() -> String {
		let crate_name = module_path!()
			.split("::")
			.next()
			.expect("module_path! always starts with the crate name");
		format!("{crate_name}__")
	}

	fn snapshot_dirs() -> Vec<std::path::PathBuf> {
		let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
		let mut found = Vec::new();
		let mut stack = vec![root];
		while let Some(dir) = stack.pop() {
			let Ok(entries) = fs::read_dir(&dir) else {
				continue;
			};
			for entry in entries.flatten() {
				let path = entry.path();
				if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
					continue;
				}
				if path.file_name().is_some_and(|name| name == "snapshots") {
					found.push(path);
				} else {
					stack.push(path);
				}
			}
		}
		found
	}

	#[test]
	fn every_snapshot_is_named_for_the_current_crate() {
		let expected_prefix = expected_prefix();
		let mut orphans = Vec::new();
		let mut total = 0usize;
		for dir in snapshot_dirs() {
			let Ok(entries) = fs::read_dir(&dir) else {
				continue;
			};
			for entry in entries.flatten() {
				let name = entry.file_name().to_string_lossy().into_owned();
				if !name.ends_with(".snap") {
					continue;
				}
				total += 1;
				if !name.starts_with(&expected_prefix) {
					orphans.push(name);
				}
			}
		}

		assert!(total > 0, "no snapshots found — the discovery walk is wrong, not the snapshots");

		orphans.sort();
		let sample: Vec<_> = orphans.iter().take(3).cloned().collect();
		assert!(
			orphans.is_empty(),
			"{} of {total} snapshots are not named `{expected_prefix}…` and are therefore \
			 unreachable by insta.\n\nThis is what a crate rename looks like: the files are still \
			 tracked and still valid, but insta derives the filename from the CURRENT crate name and \
			 will never find them. Each affected assertion reports a `+new` side with no `-old` to \
			 diff against and writes a `.snap.new`.\n\nDo NOT run `cargo insta accept` — that \
			 discards whatever the tracked originals asserted. Prove the bodies match, then `git \
			 mv`.\n\nFirst offenders: {sample:?}",
			orphans.len()
		);
	}
}
