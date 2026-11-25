//! Fail-closed path and ownership checks for continuation-authority grants.

use std::{
	fs, io,
	path::{Path, PathBuf},
};

use thiserror::Error;

#[derive(Debug, Error)]
/// A protected path cannot safely anchor operator control authority.
pub enum ProtectedLocationError {
	/// The protected location itself is a symbolic link.
	#[error("protected location {} is a symlink", path.display())]
	Symlink {
		/// Path that resolved as a symbolic link.
		path: PathBuf,
	},
	/// The path is not owned by the effective user.
	#[error(
		"protected location {} is owned by {owner}, not the effective user {expected}",
		path.display()
	)]
	ForeignOwner {
		/// Location with the unexpected owner.
		path:     PathBuf,
		/// Actual filesystem owner id.
		owner:    u32,
		/// Current effective user id.
		expected: u32,
	},
	/// The protected location is inside a path the exec sandbox can write.
	#[error(
		"protected location {} is inside writable root {}",
		path.display(),
		root.display()
	)]
	InsideWritable {
		/// Protected location that overlaps a writable root.
		path: PathBuf,
		/// Writable root containing the protected location.
		root: PathBuf,
	},
	/// An exec-writable root lies inside the protected location.
	#[error(
		"protected location {} contains writable root {}",
		path.display(),
		root.display()
	)]
	ContainsWritable {
		/// Protected location that contains a writable root.
		path: PathBuf,
		/// Writable root that cannot be excluded safely.
		root: PathBuf,
	},
	/// Filesystem metadata for the protected location could not be inspected.
	#[error("protected location {} could not be inspected", path.display())]
	Inspect {
		/// Path whose metadata could not be inspected.
		path:   PathBuf,
		/// Underlying inspection failure.
		#[source]
		source: io::Error,
	},
	/// This host cannot provide verifiable ownership metadata.
	#[error("protected location ownership cannot be verified on this host")]
	Unverifiable,
	/// A protected directory is writable by its group or by others, so another
	/// account can add or replace the entries that anchor operator authority.
	#[error(
		"protected directory {} is writable by group or others (mode {mode:04o})",
		path.display()
	)]
	GroupOrOtherWritable {
		/// Directory that group or others can write.
		path: PathBuf,
		/// Its permission bits, without the file type.
		mode: u32,
	},
}

/// Computes the workspace, configured, temporary and system temporary write
/// roots.

#[must_use]
pub fn exec_writable_roots(workspace: &Path, configured: &[PathBuf]) -> Vec<PathBuf> {
	let mut roots = Vec::with_capacity(configured.len() + 3);
	push_unique(&mut roots, workspace.to_path_buf());
	for root in configured {
		push_unique(&mut roots, root.clone());
	}
	push_unique(&mut roots, std::env::temp_dir());
	push_unique(&mut roots, PathBuf::from("/tmp"));
	roots
}

/// Refuses protected locations that are symlinked, foreign-owned, or overlap an
/// exec-writable root.

pub fn check_protected_location(
	path: &Path,
	writable_roots: &[PathBuf],
) -> Result<(), ProtectedLocationError> {
	match fs::symlink_metadata(path) {
		Ok(metadata) if metadata.file_type().is_symlink() => {
			return Err(ProtectedLocationError::Symlink { path: path.to_path_buf() });
		},
		Ok(metadata) => ensure_owner(path, &metadata)?,
		Err(source) if source.kind() == io::ErrorKind::NotFound => {},
		Err(source) => {
			return Err(ProtectedLocationError::Inspect { path: path.to_path_buf(), source });
		},
	}
	let locations = checked_spellings(path)?;
	let mut roots = Vec::new();
	for root in writable_roots {
		roots.extend(checked_spellings(root)?);
	}
	for location in &locations {
		for root in &roots {
			if location.starts_with(root) {
				return Err(ProtectedLocationError::InsideWritable {
					path: location.clone(),
					root: root.clone(),
				});
			}
			if root.starts_with(location) && root != location {
				return Err(ProtectedLocationError::ContainsWritable {
					path: location.clone(),
					root: root.clone(),
				});
			}
		}
	}
	Ok(())
}

/// Refuses a protected directory that its group or others can write. Either
/// can add, remove or replace entries there, so the grant store or an
/// extension under the user root would not stay the operator's alone.
///
/// A missing path passes: nothing there can be written yet, and the caller
/// creates it private. A symlink is refused as by [`check_protected_location`].
/// Only Unix mode bits are inspected; other hosts have none, so the check is a
/// no-op there (their ownership check already fails closed).
///
/// # Errors
///
/// [`ProtectedLocationError::GroupOrOtherWritable`] for a directory whose
/// group or other write bit is set, [`ProtectedLocationError::Symlink`] for a
/// link, and [`ProtectedLocationError::Inspect`] when its metadata cannot be
/// read.
pub fn check_not_group_or_other_writable(path: &Path) -> Result<(), ProtectedLocationError> {
	match fs::symlink_metadata(path) {
		Ok(metadata) if metadata.file_type().is_symlink() => {
			Err(ProtectedLocationError::Symlink { path: path.to_path_buf() })
		},
		Ok(metadata) => ensure_not_group_or_other_writable(path, &metadata),
		Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(()),
		Err(source) => Err(ProtectedLocationError::Inspect { path: path.to_path_buf(), source }),
	}
}
/// Returns a canonical spelling even when the protected path does not exist.
/// Existing ancestors are resolved first, so symlinked parents cannot leave a
/// lexical alias that bypasses the sandbox deny.
pub fn canonical_protected_location(path: &Path) -> io::Result<PathBuf> {
	omp_envd::exec_settings::canonical_protected_location(path)
}

fn checked_spellings(path: &Path) -> Result<Vec<PathBuf>, ProtectedLocationError> {
	let absolute = std::path::absolute(path)
		.map_err(|source| ProtectedLocationError::Inspect { path: path.to_path_buf(), source })?;
	let canonical = canonical_protected_location(path)
		.map_err(|source| ProtectedLocationError::Inspect { path: path.to_path_buf(), source })?;
	let mut found = Vec::with_capacity(2);
	push_unique(&mut found, absolute);
	push_unique(&mut found, canonical);
	Ok(found)
}

fn push_unique(paths: &mut Vec<PathBuf>, path: PathBuf) {
	if !paths.contains(&path) {
		paths.push(path);
	}
}

fn ensure_not_group_or_other_writable(
	path: &Path,
	metadata: &fs::Metadata,
) -> Result<(), ProtectedLocationError> {
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt as _;

		// Group write is 0o020 and other write is 0o002; the sticky bit does not
		// make a shared directory private, so it does not excuse either.
		let mode = metadata.permissions().mode() & 0o7777;
		if metadata.is_dir() && mode & 0o022 != 0 {
			return Err(ProtectedLocationError::GroupOrOtherWritable {
				path: path.to_path_buf(),
				mode,
			});
		}
		Ok(())
	}
	#[cfg(not(unix))]
	{
		let _ = (path, metadata);
		Ok(())
	}
}

fn ensure_owner(path: &Path, metadata: &fs::Metadata) -> Result<(), ProtectedLocationError> {
	#[cfg(unix)]
	{
		use std::os::unix::fs::MetadataExt as _;

		let expected = effective_uid();
		let owner = metadata.uid();
		if owner != expected {
			return Err(ProtectedLocationError::ForeignOwner {
				path: path.to_path_buf(),
				owner,
				expected,
			});
		}
		Ok(())
	}
	#[cfg(not(unix))]
	{
		let _ = (path, metadata);
		Err(ProtectedLocationError::Unverifiable)
	}
}

#[cfg(unix)]
fn effective_uid() -> u32 {
	// SAFETY: `geteuid` has no preconditions and cannot fail.
	unsafe { libc::geteuid() }
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::*;

	#[test]
	fn writable_root_inside_protected_location_fails_closed() {
		let tree = tempfile::tempdir().expect("tree");
		let protected = tree.path().join("store");
		let writable = protected.join("scratch");
		fs::create_dir_all(&writable).expect("writable child");

		assert!(matches!(
			check_protected_location(&protected, &[writable]),
			Err(ProtectedLocationError::ContainsWritable { .. })
		));
	}

	#[test]
	fn store_inside_workspace_fails_closed() {
		let tree = tempfile::tempdir().expect("tree");
		let workspace = tree.path().join("workspace");
		let store = workspace.join(".o2/ext");
		fs::create_dir_all(&store).expect("store");

		assert!(matches!(
			check_protected_location(&store, &[workspace]),
			Err(ProtectedLocationError::InsideWritable { .. })
		));
	}

	#[test]
	fn extension_root_inside_writable_root_fails_closed() {
		let tree = tempfile::tempdir().expect("tree");
		let workspace = tree.path().join("workspace");
		let writable = tree.path().join("extra-write");
		let extension_root = writable.join("agent/extensions");
		fs::create_dir_all(&extension_root).expect("extension root");

		assert!(matches!(
			check_protected_location(&extension_root, &[workspace, writable]),
			Err(ProtectedLocationError::InsideWritable { .. })
		));
	}

	#[cfg(unix)]
	#[test]
	fn symlinked_store_fails_closed() {
		use std::os::unix::fs::symlink;

		let tree = tempfile::tempdir().expect("tree");
		let target = tree.path().join("target");
		let store = tree.path().join("store");
		fs::create_dir(&target).expect("target");
		symlink(&target, &store).expect("store symlink");

		assert!(matches!(
			check_protected_location(&store, &[]),
			Err(ProtectedLocationError::Symlink { .. })
		));
	}

	#[cfg(unix)]
	#[test]
	fn symlinked_extension_root_fails_closed() {
		use std::os::unix::fs::symlink;

		let tree = tempfile::tempdir().expect("tree");
		let target = tree.path().join("target");
		let extension_root = tree.path().join("extensions");
		fs::create_dir(&target).expect("target");
		symlink(&target, &extension_root).expect("extension-root symlink");

		assert!(matches!(
			check_protected_location(&extension_root, &[]),
			Err(ProtectedLocationError::Symlink { .. })
		));
	}

	#[cfg(unix)]
	fn directory_with_mode(parent: &Path, name: &str, mode: u32) -> PathBuf {
		use std::os::unix::fs::PermissionsExt as _;

		let directory = parent.join(name);
		fs::create_dir(&directory).expect("directory");
		fs::set_permissions(&directory, fs::Permissions::from_mode(mode)).expect("set mode");
		directory
	}

	#[cfg(unix)]
	#[test]
	fn group_or_other_writable_directory_fails_closed() {
		let tree = tempfile::tempdir().expect("tree");
		for (name, mode) in [("group", 0o770), ("other", 0o707), ("both", 0o777), ("sticky", 0o1777)]
		{
			let directory = directory_with_mode(tree.path(), name, mode);
			assert!(
				matches!(
					check_not_group_or_other_writable(&directory),
					Err(ProtectedLocationError::GroupOrOtherWritable { mode: found, .. }) if found == mode
				),
				"{name}: mode {mode:o} must be refused"
			);
		}
	}

	#[cfg(unix)]
	#[test]
	fn private_directory_passes_the_mode_check() {
		let tree = tempfile::tempdir().expect("tree");
		// Readable or searchable by group and others is fine; only write matters.
		for (name, mode) in [("owner", 0o700), ("shared-read", 0o755), ("group-read", 0o750)] {
			let directory = directory_with_mode(tree.path(), name, mode);
			check_not_group_or_other_writable(&directory)
				.unwrap_or_else(|error| panic!("{name}: mode {mode:o} must pass: {error}"));
		}
		check_not_group_or_other_writable(&tree.path().join("missing"))
			.expect("a missing directory has nothing to write");
	}

	#[cfg(unix)]
	#[test]
	fn symlinked_directory_fails_the_mode_check() {
		let tree = tempfile::tempdir().expect("tree");
		let target = directory_with_mode(tree.path(), "target", 0o700);
		let link = tree.path().join("link");
		std::os::unix::fs::symlink(&target, &link).expect("symlink");

		assert!(matches!(
			check_not_group_or_other_writable(&link),
			Err(ProtectedLocationError::Symlink { .. })
		));
	}
	#[cfg(unix)]
	#[test]
	fn missing_protected_path_resolves_symlinked_ancestor_for_containment() {
		use std::os::unix::fs::symlink;

		let tree = tempfile::tempdir().expect("tree");
		let writable = tree.path().join("writable");
		let alias = tree.path().join("alias");
		fs::create_dir(&writable).expect("writable root");
		symlink(&writable, &alias).expect("ancestor symlink");
		let protected = alias.join("missing-store");

		assert!(matches!(
			check_protected_location(&protected, std::slice::from_ref(&writable)),
			Err(ProtectedLocationError::InsideWritable { .. })
		));
	}

	#[cfg(unix)]
	#[test]
	fn foreign_owned_store_fails_closed() {
		use std::{ffi::CString, os::unix::ffi::OsStrExt as _};

		let tree = tempfile::tempdir().expect("tree");
		let location = if effective_uid() == 0 {
			// Root can hand a fresh directory to another user.
			let store = tree.path().join("store");
			fs::create_dir(&store).expect("store");
			let c_path = CString::new(store.as_os_str().as_bytes()).expect("path has no nul");
			// SAFETY: c_path is NUL-terminated and the ids are plain integers.
			if unsafe { libc::chown(c_path.as_ptr(), 1, u32::MAX) } != 0 {
				eprintln!("skip: cannot create a foreign-owned fixture on this host");
				return;
			}
			store
		} else {
			// Without root no directory can be handed to another user, but `/usr` is a
			// real, symlink-free directory that root owns on every unix host.
			PathBuf::from("/usr")
		};

		assert!(matches!(
			check_protected_location(&location, &[]),
			Err(ProtectedLocationError::ForeignOwner { .. })
		));
	}
}
