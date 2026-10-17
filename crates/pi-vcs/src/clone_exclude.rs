//! Glob-based exclusion of secret-shaped files from copy-on-write worktree
//! clones.
//!
//! `git worktree add` through the clone-first path (`WorktreeClone::Auto`)
//! duplicates the whole source checkout — including every gitignored file —
//! into the new worktree. Build caches coming along is the documented point;
//! credentials (`.env`, `*.pem`, release-signing configs, …) coming along is
//! a secret-sprawl bug: rotated secrets linger in old worktrees and
//! post-checkout hooks that symlink a shared secret file refuse to overwrite
//! the copied regular file.
//!
//! Copy-on-write backends clone whole directory trees atomically (`clonefile`,
//! reflink), so nested secrets cannot be excluded during the clone itself.
//! Instead, [`prune_clone_excludes`] deletes matching files from the fresh
//! `clone` — cheap on `CoW` filesystems, and the source checkout is untouched.

use std::path::Path;

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use gix::bstr::{BString, ByteSlice};

use crate::{Error, Result};
use crate::types::DEFAULT_CLONE_EXCLUDES;

/// Compiled `worktree.cloneExclude`-style patterns, matched against
/// `/`-separated paths relative to the worktree root.
///
/// A pattern without a `/` matches the file name at any depth, so `.env*`
/// also covers `apps/web/.env.production` and `key.properties` covers
/// `android/key.properties`. A pattern with a `/` matches the whole relative
/// path. Leading slashes are stripped. `*`, `?`, and `[...]` never cross `/`
/// — use `**` for that. This
/// mirrors the recursive normalization in
/// `pi_natives::glob_util::build_glob_pattern` (which pi-vcs cannot depend on
/// without a dependency cycle through the napi crate).
#[derive(Debug, Clone, Default)]
pub(crate) struct CloneExcludeMatcher {
	set: GlobSet,
	empty: bool,
}

impl CloneExcludeMatcher {
	/// Compile `patterns` into a matcher. An empty pattern list matches
	/// nothing (the historical "clone everything" behavior).
	pub(crate) fn new(patterns: &[String]) -> Result<Self> {
		let mut builder = GlobSetBuilder::new();
		for pattern in patterns {
			let normalized = pattern.replace('\\', "/");
			// Leading slashes are stripped: patterns are always anchored at
			// the worktree root already.
			let normalized = normalized.trim_start_matches('/');
			// No path separator: match the basename at any depth.
			let recursive = if normalized.contains('/') || normalized.starts_with("**") {
				normalized.to_owned()
			} else {
				format!("**/{normalized}")
			};
			let glob = GlobBuilder::new(&recursive)
				.literal_separator(true)
				.build()
				.map_err(|err| {
					Error::backend(
						"git worktree add",
						format!("invalid worktree.cloneExclude pattern {pattern:?}: {err}"),
					)
				})?;
			builder.add(glob);
		}
		let set = builder
			.build()
			.map_err(|err| Error::backend("git worktree add", format!("invalid worktree.cloneExclude patterns: {err}")))?;
		Ok(Self { empty: patterns.is_empty(), set })
	}

	/// Resolve `None` to the default secret-shaped excludes, `Some(list)` to
	/// the caller's list (possibly empty).
	pub(crate) fn resolve(patterns: Option<Vec<String>>) -> Result<Self> {
		match patterns {
			Some(list) => Self::new(&list),
			None => Self::new(
				&DEFAULT_CLONE_EXCLUDES.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
			),
		}
	}

	/// Whether the pattern list is empty: the historical "clone everything"
	/// behavior. Callers skip the prune walk entirely in this case.
	pub(crate) const fn is_empty(&self) -> bool {
		self.empty
	}

	/// Whether `relative_path` (a `/`-separated path relative to the
	/// worktree root) is excluded.
	pub(crate) fn is_excluded(&self, relative_path: &str) -> bool {
		!self.empty && self.set.is_match(relative_path)
	}
}

/// Delete files under `root` that match `matcher` and are not tracked in
/// `source_index`.
///
/// The tracked guard is load-bearing: a pattern like `.env*` also matches a
/// *tracked* `.env.example`, and deleting a tracked file from the fresh clone
/// would leave the new worktree's index claiming a file that is not on disk.
/// Ignored and untracked files are never in the index, so they are exactly
/// the secret-sprawl population this removes.
///
/// Symlinks are deleted as links (never followed); a directory that itself
/// matches is removed whole when it holds no tracked files, otherwise the
/// walk descends into it and prunes file-by-file.
pub(crate) fn prune_clone_excludes(
	root: &Path,
	source_index: &gix::index::File,
	matcher: &CloneExcludeMatcher,
) -> Result<()> {
	// An empty pattern list is the historical "clone everything" behavior:
	// nothing can match, so skip the walk entirely.
	if matcher.is_empty() {
		return Ok(());
	}
	let mut stack = vec![root.to_path_buf()];
	while let Some(dir) = stack.pop() {
		let entries = std::fs::read_dir(&dir).map_err(|err| {
			Error::backend("git worktree add", format!("read_dir {}: {err}", dir.display()))
		})?;
		for entry in entries {
			let entry = entry.map_err(|err| {
				Error::backend("git worktree add", format!("dir entry in {}: {err}", dir.display()))
			})?;
			let path = entry.path();
			let relative = path.strip_prefix(root).map_err(|err| {
				Error::backend("git worktree add", format!("strip_prefix {}: {err}", path.display()))
			})?;
			let rel_str = relative.to_string_lossy().replace('\\', "/");
			let file_type = entry.file_type().map_err(|err| {
				Error::backend("git worktree add", format!("file_type {}: {err}", path.display()))
			})?;
			// `DirEntry::file_type` never follows symlinks, so this branch
			// only sees real directories.
			if file_type.is_dir() {
				if matcher.is_excluded(&rel_str) {
					if dir_has_tracked_entries(source_index, &rel_str) {
						// A matched directory can still hold tracked files
						// (e.g. a committed file under a `secrets/**` match):
						// deleting it whole would also delete those tracked
						// files, so prune it file-by-file instead.
						stack.push(path);
					} else {
						std::fs::remove_dir_all(&path).map_err(|err| {
							Error::backend(
								"git worktree add",
								format!("remove_dir_all {}: {err}", path.display()),
							)
						})?;
					}
				} else {
					stack.push(path);
				}
				continue;
			}
			if !matcher.is_excluded(&rel_str) {
				continue;
			}
			let rela_path = BString::from(rel_str.as_str());
			if source_index.entry_by_path(rela_path.as_bstr()).is_some() {
				// Tracked file that happens to match an exclude pattern
				// (e.g. a committed `.env.example`): leave it alone.
				continue;
			}
			std::fs::remove_file(&path).map_err(|err| {
				Error::backend("git worktree add", format!("remove_file {}: {err}", path.display()))
			})?;
		}
	}
	Ok(())
}

/// Whether any tracked index entry lives under `dir_rel` (a `/`-separated
/// path relative to the worktree root), or is the directory itself. Index
/// paths are `/`-separated too, so testing a trailing-`/` prefix is exact:
/// looking under `secrets` never matches a sibling like `secrets-old`.
///
/// The exact-path check matters for gitlinks: an unpopulated submodule's
/// index entry is the directory path itself (no descendant entries), and
/// deleting that directory would leave the index claiming an entry that is
/// not on disk.
fn dir_has_tracked_entries(source_index: &gix::index::File, dir_rel: &str) -> bool {
	// A gitlink (e.g. an uninitialized submodule at a matched path) is
	// tracked by an exact index entry at the directory path.
	if source_index.entry_by_path(dir_rel.as_bytes().as_bstr()).is_some() {
		return true;
	}
	let mut prefix: Vec<u8> = dir_rel.as_bytes().to_vec();
	prefix.push(b'/');
	source_index
		.entries()
		.iter()
		.any(|entry| entry.path(source_index).starts_with(prefix.as_slice()))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn matcher(patterns: &[&str]) -> CloneExcludeMatcher {
		CloneExcludeMatcher::new(
			&patterns.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
		)
		.expect("valid patterns")
	}

	/// Basename patterns match at any depth; the issue's secret files are the
	/// contract.
	#[test]
	fn basename_patterns_match_nested_secrets() {
		let m = matcher(&[".env*", "*.pem", "key.properties"]);
		// Contract: the issue's secret files are excluded wherever they live.
		for excluded in [
			".env",
			".env.local",
			".envrc",
			"apps/web/.env.production",
			"apps/api/.env.staging",
			"deploy/cert.pem",
			"android/key.properties",
		] {
			assert!(m.is_excluded(excluded), "{excluded} should be excluded");
		}
		// Contract: build caches and files the patterns don't name are left
		// alone. (Note `.env*` intentionally also matches `.envrc` — the
		// default is broad on purpose; narrow it via worktree.cloneExclude.)
		for kept in ["node_modules/react/index.js", "target/debug/app", "src/main.rs", "README.md"] {
			assert!(!m.is_excluded(kept), "{kept} should be kept");
		}
	}

	/// Patterns containing `/` match the whole relative path, not the
	/// basename.
	#[test]
	fn slash_patterns_match_full_relative_path() {
		let m = matcher(&["config/*.pem", "secrets/**"]);
		assert!(m.is_excluded("config/deploy.pem"));
		assert!(m.is_excluded("secrets/old/key.pem"));
		assert!(!m.is_excluded("other/deploy.pem"));
		assert!(!m.is_excluded("config/nested/deploy.pem"));
	}

	/// `*` never crosses `/` with `literal_separator`; `**` does. A leading
	/// `/` is stripped, so it behaves like the bare basename pattern.
	#[test]
	fn star_does_not_cross_separator() {
		let m = matcher(&["*.pem"]);
		assert!(m.is_excluded("a/b/c.pem"));
		assert!(m.is_excluded("c.pem"));
		let m2 = matcher(&["/*.pem"]);
		assert!(m2.is_excluded("c.pem"));
		assert!(m2.is_excluded("a/c.pem"));
	}

	/// An empty pattern list excludes nothing: the historical behavior.
	#[test]
	fn empty_patterns_match_nothing() {
		let m = matcher(&[]);
		assert!(!m.is_excluded(".env"));
		assert!(!m.is_excluded("a/.env"));
	}

	/// Invalid globs surface a backend error naming the pattern, not a panic.
	#[test]
	fn invalid_pattern_is_an_error() {
		let err = CloneExcludeMatcher::new(&["[unclosed".to_string()]).expect_err("must fail");
		assert!(err.to_string().contains("[unclosed"), "{err}");
	}

	/// The shipped defaults exclude the issue's secret shapes and keep caches.
	#[test]
	fn default_excludes_cover_issue_secrets() {
		let m = CloneExcludeMatcher::resolve(None).expect("defaults compile");
		for excluded in [".env", "apps/web/.env.production", "k.p12", "app.keystore", "id.mobileprovision"] {
			assert!(m.is_excluded(excluded), "{excluded} should be excluded");
		}
		for kept in ["node_modules/a.js", "target/x", ".gitignore"] {
			assert!(!m.is_excluded(kept), "{kept} should be kept");
		}
	}
}
