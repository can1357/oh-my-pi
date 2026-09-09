//! Environment-owned version-control substrate.

use std::path::{Path, PathBuf};

use omp_core::Str;
use tokio_util::sync::CancellationToken;

use self::git::diff::StatusCounts;

pub mod git;

/// Repository detection state exposed by an environment snapshot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RepositoryAvailability {
	/// A repository was found and inspected successfully.
	Available,
	/// No repository was found at the requested root.
	NotRepository,
	/// A repository was found but its Git backend was unavailable.
	GitUnavailable,
}

/// Backend-neutral repository state captured for environment consumers.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepositorySnapshot {
	/// Repository detection and inspection state.
	pub availability:  RepositoryAvailability,
	/// Canonical root of the selected working tree when available.
	pub worktree_root: Option<PathBuf>,
	/// Canonical identity shared by linked working trees when available.
	pub primary_root:  Option<PathBuf>,
	/// Resolved `HEAD` object identifier when available.
	pub head:          Option<Str>,
	/// Current branch name when `HEAD` is attached.
	pub branch:        Option<Str>,
	/// Current index, worktree, and untracked change counts.
	pub status_counts: StatusCounts,
}

/// Failure to capture a repository snapshot.
#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
	#[error(transparent)]
	/// The VCS backend could not inspect the repository.
	Vcs(#[from] omp_vcs::Error),
}

/// Captures a backend-neutral Git or Jujutsu repository snapshot.
pub async fn snapshot(
	root: &Path,
	cancel: &CancellationToken,
) -> Result<RepositorySnapshot, SnapshotError> {
	let root = std::fs::canonicalize(root).map_err(omp_vcs::Error::Io)?;
	let detected = git::blocking(Some(cancel), move || omp_vcs::detect(&root)).await?;
	let Some(repository) = detected else {
		return Ok(RepositorySnapshot {
			availability:  RepositoryAvailability::NotRepository,
			worktree_root: None,
			primary_root:  None,
			head:          None,
			branch:        None,
			status_counts: StatusCounts::default(),
		});
	};
	let worktree_root = repository.root().to_owned();
	let primary_root = repository.primary_root();
	let bare = repository.as_git().is_some_and(|repo| repo.is_bare());
	let result = git::blocking(Some(cancel), move || {
		Ok((
			repository.head_id()?,
			repository.label()?,
			if bare {
				omp_vcs::StatusSummary::default()
			} else {
				repository.status_summary()?
			},
		))
	})
	.await;
	match result {
		Ok((head, branch, status)) => Ok(RepositorySnapshot {
			availability:  RepositoryAvailability::Available,
			worktree_root: Some(worktree_root),
			primary_root:  Some(primary_root),
			head:          head.map(Str::from),
			branch:        branch.map(Str::from),
			status_counts: StatusCounts {
				staged:    status.staged,
				unstaged:  status.unstaged,
				untracked: status.untracked,
			},
		}),
		Err(
			omp_vcs::Error::Cli { exit_code: 127, .. }
			| omp_vcs::Error::Backend { context: "git spawn", .. },
		) => Ok(RepositorySnapshot {
			availability:  RepositoryAvailability::GitUnavailable,
			worktree_root: Some(worktree_root),
			primary_root:  Some(primary_root),
			head:          None,
			branch:        None,
			status_counts: StatusCounts::default(),
		}),
		Err(error) => Err(error.into()),
	}
}
