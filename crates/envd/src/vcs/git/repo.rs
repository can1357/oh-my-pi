//! Canonical Git repository discovery backed by `omp-vcs`.

use std::{
	path::{Path, PathBuf},
	sync::Arc,
};

/// Canonical repository paths resolved from a working-directory descendant.
#[derive(Clone, Debug)]
pub struct Repository {
	/// Canonical root of the selected working tree.
	pub worktree_root: PathBuf,
	/// Canonical per-worktree Git administration directory.
	pub git_dir:       PathBuf,
	/// Canonical shared Git administration directory.
	pub common_dir:    PathBuf,
	/// Canonical identity shared by linked worktrees.
	pub primary_root:  PathBuf,
	/// Whether the repository has no working tree.
	pub bare:          bool,
	/// Open in-process repository handle.
	pub handle:        Arc<omp_vcs::git::GitRepo>,
}

/// Repository discovery failures.
#[derive(Debug, thiserror::Error)]
pub enum RepositoryError {
	/// The VCS backend could not inspect the repository.
	#[error("failed to inspect repository")]
	Vcs(#[from] omp_vcs::Error),
}

/// Searches `start` and its ancestors for a Git repository.
pub async fn discover(start: &Path) -> Result<Option<Repository>, RepositoryError> {
	let start = tokio::fs::canonicalize(start)
		.await
		.map_err(omp_vcs::Error::Io)?;
	super::blocking(None, move || omp_vcs::git::GitRepo::discover(&start))
		.await
		.map_err(RepositoryError::Vcs)
		.map(|repo| repo.map(Repository::from_git))
}

impl Repository {
	fn from_git(repo: omp_vcs::git::GitRepo) -> Self {
		let bare = repo.is_bare();
		let info = repo.info().clone();
		let primary_root = repo.primary_root();
		Self {
			worktree_root: info.repo_root,
			git_dir: info.git_dir,
			common_dir: info.common_dir,
			primary_root,
			bare,
			handle: Arc::new(repo),
		}
	}

	/// Builds the facade projection from an already-open repository.
	pub fn from_handle(handle: Arc<omp_vcs::git::GitRepo>) -> Self {
		let bare = handle.is_bare();
		let info = handle.info().clone();
		let primary_root = handle.primary_root();
		Self {
			worktree_root: info.repo_root,
			git_dir: info.git_dir,
			common_dir: info.common_dir,
			primary_root,
			bare,
			handle,
		}
	}
}
