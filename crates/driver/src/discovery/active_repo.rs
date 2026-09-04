//! Nested active repository detection.
//!
//! When the session cwd sits outside any git repository but holds exactly
//! one direct-child git repository, that child is the active project and the
//! `active-repo.md` system prompt names it. Two or more child repositories,
//! or a cwd already inside a repository, yield nothing.

use std::{
	fs,
	path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

/// The single direct-child repository beneath a non-repository cwd.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ActiveRepository {
	/// Repository root relative to the cwd (its directory name), the value
	/// `active-repo.md` renders as `active_repository.relative_root`.
	pub relative_root: PathBuf,
}

/// Resolves the active repository for `cwd`.
///
/// Returns `None` when `cwd` (or any ancestor) carries a `.git` marker, when
/// it holds no direct-child repository, or when it holds more than one.
/// Unreadable directories count as empty rather than failing composition.
#[must_use]
pub fn resolve(cwd: &Path) -> Option<ActiveRepository> {
	if cwd.ancestors().any(|dir| dir.join(".git").exists()) {
		return None;
	}
	let mut names: Vec<_> = fs::read_dir(cwd)
		.and_then(|entries| {
			entries
				.map(|entry| entry.map(|entry| entry.file_name()))
				.collect()
		})
		.unwrap_or_default();
	names.sort_unstable();
	let mut found = None;
	for name in names {
		let child = cwd.join(&name);
		if !is_directory(&child) || !has_git_marker(&child) {
			continue;
		}
		if found.is_some() {
			return None;
		}
		found = Some(ActiveRepository { relative_root: PathBuf::from(name) });
	}
	found
}

/// Directories and symlinks resolving to directories; broken links are
/// skipped.
fn is_directory(path: &Path) -> bool {
	fs::metadata(path).is_ok_and(|metadata| metadata.is_dir())
}

/// A `.git` directory or gitfile (worktrees and submodules) marks a repository.
fn has_git_marker(path: &Path) -> bool {
	fs::metadata(path.join(".git")).is_ok_and(|metadata| metadata.is_dir() || metadata.is_file())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn repo(root: &Path, name: &str) -> PathBuf {
		let path = root.join(name);
		fs::create_dir_all(path.join(".git")).expect("child repository");
		path
	}

	#[test]
	fn exactly_one_direct_child_repository_is_active() {
		let tree = tempfile::tempdir().expect("tempdir");
		let cwd = tree.path().join("work");
		fs::create_dir_all(cwd.join("notes")).expect("plain child");
		fs::write(cwd.join("README"), "").expect("plain file");
		repo(&cwd, "omp");
		assert_eq!(resolve(&cwd), Some(ActiveRepository { relative_root: PathBuf::from("omp") }));
	}

	#[test]
	fn gitfile_marks_a_repository() {
		let tree = tempfile::tempdir().expect("tempdir");
		let cwd = tree.path().join("work");
		fs::create_dir_all(cwd.join("worktree")).expect("child");
		fs::write(cwd.join("worktree/.git"), "gitdir: ../elsewhere\n").expect("gitfile");
		assert_eq!(
			resolve(&cwd),
			Some(ActiveRepository { relative_root: PathBuf::from("worktree") })
		);
	}

	#[test]
	fn two_child_repositories_are_ambiguous() {
		let tree = tempfile::tempdir().expect("tempdir");
		let cwd = tree.path().join("work");
		repo(&cwd, "a");
		repo(&cwd, "b");
		assert_eq!(resolve(&cwd), None);
	}

	#[test]
	fn cwd_inside_a_repository_has_no_active_child() {
		let tree = tempfile::tempdir().expect("tempdir");
		let root = repo(tree.path(), "outer");
		let cwd = root.join("work");
		repo(&cwd, "inner");
		assert_eq!(resolve(&cwd), None);
		assert_eq!(resolve(&root), None);
	}

	#[test]
	fn missing_or_empty_cwd_is_none() {
		let tree = tempfile::tempdir().expect("tempdir");
		assert_eq!(resolve(tree.path()), None);
		assert_eq!(resolve(&tree.path().join("absent")), None);
	}
}
