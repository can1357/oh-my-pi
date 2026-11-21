//! Jujutsu backend: jj-lib-powered workspace operations. No subprocess at all.
//!
//! Workspace discovery is a pure filesystem walk (`.jj/repo` presence,
//! including the file indirection non-default workspaces use), cheap enough
//! for synchronous render paths. jj-lib loading happens lazily inside
//! operations.

mod ops;

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// An opened Jujutsu workspace.
#[derive(Debug)]
pub struct JjWorkspace {
	root:     PathBuf,
	repo_dir: PathBuf,
}

impl JjWorkspace {
	/// Discover the workspace containing `dir` by walking toward the root.
	/// Returns `Ok(None)` when `dir` is not inside a Jujutsu workspace.
	pub fn discover(dir: &Path) -> Result<Option<Self>> {
		let start = std::path::absolute(dir)?;
		let mut current = start.as_path();
		loop {
			if let Some(repo_dir) = resolve_repo_dir(current) {
				return Ok(Some(Self { root: current.to_owned(), repo_dir }));
			}
			match current.parent() {
				Some(parent) => current = parent,
				None => return Ok(None),
			}
		}
	}

	/// Like [`JjWorkspace::discover`], but errors with [`Error::NotARepository`]
	/// when `dir` is outside any workspace.
	pub fn require(dir: &Path) -> Result<Self> {
		Self::discover(dir)?.ok_or_else(|| Error::NotARepository { path: dir.to_owned() })
	}

	/// Workspace root: the directory containing `.jj`.
	pub fn root(&self) -> &Path {
		&self.root
	}

	/// Default workspace root shared by every workspace in this repository.
	pub fn primary_root(&self) -> PathBuf {
		self
			.repo_dir
			.parent()
			.and_then(Path::parent)
			.map_or_else(|| self.root.clone(), Path::to_owned)
	}

	/// Shared repo directory backing this workspace, resolved through the
	/// `.jj/repo` file indirection used by non-default workspaces.
	pub fn repo_dir(&self) -> &Path {
		&self.repo_dir
	}

	/// Path of the shared workspace store directory.
	pub fn store_dir(&self) -> PathBuf {
		self.repo_dir.join("store")
	}

	/// Directory whose entries change whenever the repository operation head
	/// moves.
	pub fn watch_target(&self) -> PathBuf {
		self.repo_dir.join("op_heads").join("heads")
	}
}

/// Resolve the `.jj/repo` directory for `root`, or `None` when `root` is not
/// a workspace. jj marks a workspace via `.jj/repo`: a directory in the
/// default workspace, or a FILE (created by `jj workspace add`) whose contents
/// are a path — relative to `.jj` — to the default workspace's repo dir.
fn resolve_repo_dir(root: &Path) -> Option<PathBuf> {
	let jj_dir = root.join(".jj");
	let repo_path = jj_dir.join("repo");
	let meta = std::fs::metadata(&repo_path).ok()?;
	if meta.is_dir() {
		return Some(repo_path);
	}
	if !meta.is_file() {
		return None;
	}
	let target = std::fs::read_to_string(&repo_path).ok()?;
	let target = target.trim();
	if target.is_empty() {
		return None;
	}
	Some(crate::git::normalize_path(&jj_dir.join(target)))
}
