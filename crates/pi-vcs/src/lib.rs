//! In-process version control for the coding agent.
//!
//! Collapses the git and Jujutsu CLI wrappers into one Rust interface:
//! - **git** ([`git::GitRepo`]) runs on gitoxide. The git binary survives only
//!   where an in-process implementation cannot reach parity: credential-bound
//!   network transfers (push/fetch/clone reuse the user's ssh config and
//!   credential helpers) and reftable repositories (no library implementation
//!   of reftable exists yet).
//! - **jj** ([`jj::JjWorkspace`]) runs on jj-lib, which shares the same
//!   gitoxide stack for its git backend. No subprocess at all.
//!
//! Discovery ([`GitRepo::discover`], [`JjWorkspace::discover`], [`detect`]) is
//! a pure filesystem walk, cheap enough to call from synchronous render paths.
//!
//! [`GitRepo::discover`]: git::GitRepo::discover
//! [`JjWorkspace::discover`]: jj::JjWorkspace::discover

pub mod error;
pub mod git;
pub mod jj;
pub mod types;

use std::{
	path::{Path, PathBuf},
	sync::Arc,
};

pub use error::{Error, Result};
pub use types::*;

/// Capability points where the backends genuinely diverge. Everything else
/// on [`Repo`] is implemented by both backends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Feature {
	/// Index-relative diffs ([`DiffOptions::cached`]). Git only.
	StagedDiff,
	/// Two-revision diffs ([`DiffOptions::base`]/[`DiffOptions::head`]). Git
	/// only.
	RevDiff,
}

impl Feature {
	/// Parse the camelCase feature name used across the N-API boundary.
	pub fn parse(name: &str) -> Option<Self> {
		match name {
			"stagedDiff" => Some(Self::StagedDiff),
			"revDiff" => Some(Self::RevDiff),
			_ => None,
		}
	}
}

/// A discovered repository, dispatching portable operations to its backend.
#[derive(Debug, Clone)]
pub enum Repo {
	/// Git owns the directory (including jj-git colocated workspaces).
	Git(Arc<git::GitRepo>),
	/// Jujutsu owns the directory (its root is strictly deeper than any git
	/// checkout).
	Jj(Arc<jj::JjWorkspace>),
}

impl Repo {
	/// Which VCS backs this repository.
	pub const fn kind(&self) -> VcsKind {
		match self {
			Self::Git(_) => VcsKind::Git,
			Self::Jj(_) => VcsKind::Jj,
		}
	}

	/// Checkout or workspace root.
	pub fn root(&self) -> &Path {
		match self {
			Self::Git(repo) => repo.root(),
			Self::Jj(workspace) => workspace.root(),
		}
	}

	/// Primary checkout or default workspace root.
	pub fn primary_root(&self) -> PathBuf {
		match self {
			Self::Git(repo) => repo.primary_root(),
			Self::Jj(workspace) => workspace.primary_root(),
		}
	}

	/// Path of `dir` relative to the checkout or workspace root.
	pub fn prefix_of(&self, dir: &Path) -> Option<String> {
		match self {
			Self::Git(repo) => repo.prefix_of(dir),
			Self::Jj(workspace) => git::relative_prefix(workspace.root(), dir),
		}
	}

	/// Whether this backend implements `feature`.
	pub const fn supports(&self, feature: Feature) -> bool {
		match self {
			Self::Git(_) => true,
			Self::Jj(_) => match feature {
				Feature::StagedDiff | Feature::RevDiff => false,
			},
		}
	}

	/// Human label for the working copy: branch for git, bookmark or change id
	/// for Jujutsu.
	pub fn label(&self) -> Result<Option<String>> {
		match self {
			Self::Git(repo) => repo.current_branch(),
			Self::Jj(workspace) => workspace.working_copy_label(),
		}
	}

	/// Commit id currently checked out by the working copy.
	pub fn head_id(&self) -> Result<Option<String>> {
		match self {
			Self::Git(repo) => repo.head_sha(),
			Self::Jj(workspace) => workspace.head_id(),
		}
	}

	/// Count the current staged, unstaged, and untracked changes.
	pub fn status_summary(&self) -> Result<StatusSummary> {
		match self {
			Self::Git(repo) => repo.status_summary(),
			Self::Jj(workspace) => workspace.status_summary(),
		}
	}

	/// Render current changes in git porcelain-v1 form.
	pub fn status_porcelain(&self, options: &StatusOptions) -> Result<String> {
		match self {
			Self::Git(repo) => repo.status_porcelain(options),
			Self::Jj(workspace) => workspace.status_porcelain(options),
		}
	}

	/// Render the selected changes as a git-format patch.
	pub fn diff_text(&self, options: &DiffOptions) -> Result<String> {
		match self {
			Self::Git(repo) => repo.diff_text(options),
			Self::Jj(workspace) => {
				require_jj_diff_options(options)?;
				workspace.diff_text(&options.files, true)
			},
		}
	}

	/// Return changed paths, using destination paths for renames.
	pub fn changed_files(&self, options: &DiffOptions) -> Result<Vec<String>> {
		match self {
			Self::Git(repo) => repo.changed_files(options),
			Self::Jj(workspace) => {
				require_jj_diff_options(options)?;
				workspace.changed_files(&options.files, true)
			},
		}
	}

	/// Return per-file added and removed line counts.
	pub fn numstat(&self, options: &DiffOptions) -> Result<Vec<NumstatEntry>> {
		match self {
			Self::Git(repo) => repo.numstat(options),
			Self::Jj(workspace) => {
				require_jj_diff_options(options)?;
				workspace.numstat(&options.files)
			},
		}
	}

	/// Render every working-copy change since the last commit.
	pub fn uncommitted_diff(&self, files: &[String]) -> Result<String> {
		match self {
			Self::Git(repo) => {
				if repo.head_sha()?.is_none() {
					let unstaged = repo
						.diff_text(&DiffOptions { files: files.to_vec(), ..DiffOptions::default() })?;
					let staged = repo.diff_text(&DiffOptions {
						cached: true,
						files: files.to_vec(),
						..DiffOptions::default()
					})?;
					Ok(git::join_patches(&[unstaged, staged]))
				} else {
					repo.diff_text(&DiffOptions {
						base: Some("HEAD".to_owned()),
						files: files.to_vec(),
						..DiffOptions::default()
					})
				}
			},
			Self::Jj(workspace) => workspace.diff_text(files, true),
		}
	}

	/// Return recent commit subjects, newest first.
	pub fn log_subjects(&self, count: usize) -> Result<Vec<String>> {
		match self {
			Self::Git(repo) => repo.log_subjects(count),
			Self::Jj(workspace) => workspace.log_subjects(count),
		}
	}

	/// Return recent commits in compact one-line form.
	pub fn log_onelines(&self, count: usize) -> Result<Vec<String>> {
		match self {
			Self::Git(repo) => repo.log_onelines(count),
			Self::Jj(workspace) => workspace.log_onelines(count),
		}
	}

	/// Read commit identity, parents, author, date, and full message.
	pub fn commit_details(&self, rev: &str) -> Result<CommitDetails> {
		match self {
			Self::Git(repo) => repo.commit_details(rev),
			Self::Jj(workspace) => workspace.commit_details(rev),
		}
	}

	/// List tracked paths, or untracked paths when `others` is true.
	pub fn ls_files(&self, others: bool, exclude_standard: bool) -> Result<Vec<String>> {
		match self {
			Self::Git(repo) => repo.ls_files(others, exclude_standard),
			Self::Jj(workspace) => workspace.ls_files(others),
		}
	}

	/// Filesystem target whose metadata changes when the repository head moves.
	pub fn watch_target(&self) -> PathBuf {
		match self {
			Self::Git(repo) => repo.head_watch_target(),
			Self::Jj(workspace) => workspace.watch_target(),
		}
	}

	/// Access the git-specific handle when this is a git repository.
	pub const fn as_git(&self) -> Option<&Arc<git::GitRepo>> {
		match self {
			Self::Git(repo) => Some(repo),
			Self::Jj(_) => None,
		}
	}

	/// Access the Jujutsu-specific handle when this is a Jujutsu workspace.
	pub const fn as_jj(&self) -> Option<&Arc<jj::JjWorkspace>> {
		match self {
			Self::Git(_) => None,
			Self::Jj(workspace) => Some(workspace),
		}
	}
}

const fn require_jj_diff_options(options: &DiffOptions) -> Result<()> {
	if options.cached {
		return Err(Error::Unsupported { operation: "stagedDiff", backend: VcsKind::Jj });
	}
	if options.base.is_some() || options.head.is_some() {
		return Err(Error::Unsupported { operation: "revDiff", backend: VcsKind::Jj });
	}
	Ok(())
}

/// Detect which VCS owns `dir`.
///
/// Both lookups walk upward; the deeper root wins because it is the tree the
/// user actually works in.
///
/// Colocated jj-git workspaces (same root) resolve to [`Repo::Git`] — git
/// automation is safe there. Returns `Ok(None)` for directories backed by
/// neither tool.
pub fn detect(dir: &Path) -> Result<Option<Repo>> {
	let jj = jj::JjWorkspace::discover(dir)?;
	let Some(jj) = jj else {
		return Ok(git::GitRepo::discover(dir)?.map(|repo| Repo::Git(Arc::new(repo))));
	};
	match git::GitRepo::discover(dir)? {
		Some(repo) if !is_strict_descendant(jj.root(), repo.root()) => {
			Ok(Some(Repo::Git(Arc::new(repo))))
		},
		_ => Ok(Some(Repo::Jj(Arc::new(jj)))),
	}
}

/// Detect a "pure" Jujutsu workspace — one where git-mutating automation has
/// no safe target because jj is the nearest (or only) VCS ancestor.
///
/// Colocated
/// workspaces and git checkouts nested under a jj tree return `false`.
pub fn is_pure_jj(dir: &Path) -> Result<bool> {
	Ok(matches!(detect(dir)?, Some(Repo::Jj(_))))
}

/// Whether `child` is a strict descendant of `ancestor` (equal paths are not).
/// Both must be absolute; the comparison is lexical.
fn is_strict_descendant(child: &Path, ancestor: &Path) -> bool {
	child != ancestor && child.starts_with(ancestor)
}
#[cfg(test)]
mod tests {
	use std::{fs, path::Path, process::Command};

	use super::*;

	fn run_git(root: &Path, args: &[&str]) -> String {
		let output = Command::new("git")
			.current_dir(root)
			.args(args)
			.output()
			.unwrap();
		assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
		String::from_utf8(output.stdout).unwrap()
	}

	fn init_git(root: &Path) {
		run_git(root, &["init", "-q"]);
		run_git(root, &["config", "user.name", "VCS Test"]);
		run_git(root, &["config", "user.email", "vcs@example.com"]);
	}

	#[test]
	fn repo_reports_backend_capabilities() {
		let git_dir = tempfile::tempdir().unwrap();
		init_git(git_dir.path());
		let git = detect(git_dir.path()).unwrap().unwrap();
		assert!(git.supports(Feature::StagedDiff));
		assert!(git.supports(Feature::RevDiff));

		let jj_dir = tempfile::tempdir().unwrap();
		fs::create_dir_all(jj_dir.path().join(".jj/repo")).unwrap();
		let jj = detect(jj_dir.path()).unwrap().unwrap();
		assert!(!jj.supports(Feature::StagedDiff));
		assert!(!jj.supports(Feature::RevDiff));
	}

	#[test]
	fn jj_rejects_git_only_diff_options() {
		let temp = tempfile::tempdir().unwrap();
		fs::create_dir_all(temp.path().join(".jj/repo")).unwrap();
		let repo = detect(temp.path()).unwrap().unwrap();

		let staged = repo
			.diff_text(&DiffOptions { cached: true, ..DiffOptions::default() })
			.unwrap_err();
		assert_eq!(staged.kind(), "Unsupported");
		assert!(matches!(staged, Error::Unsupported {
			operation: "stagedDiff",
			backend:   VcsKind::Jj,
		}));

		let revision = repo
			.diff_text(&DiffOptions { base: Some("main".to_owned()), ..DiffOptions::default() })
			.unwrap_err();
		assert_eq!(revision.kind(), "Unsupported");
		assert!(matches!(revision, Error::Unsupported {
			operation: "revDiff",
			backend:   VcsKind::Jj,
		}));
	}

	#[test]
	fn git_uncommitted_diff_matches_head_with_staged_and_unstaged_changes() {
		let temp = tempfile::tempdir().unwrap();
		init_git(temp.path());
		fs::write(temp.path().join("tracked.txt"), "base\n").unwrap();
		run_git(temp.path(), &["add", "tracked.txt"]);
		run_git(temp.path(), &["commit", "-q", "-m", "base"]);

		fs::write(temp.path().join("tracked.txt"), "base\nunstaged\n").unwrap();
		fs::write(temp.path().join("staged.txt"), "staged\n").unwrap();
		run_git(temp.path(), &["add", "staged.txt"]);

		let expected = run_git(temp.path(), &["diff", "HEAD"]);
		let actual = detect(temp.path())
			.unwrap()
			.unwrap()
			.uncommitted_diff(&[])
			.unwrap();
		assert_eq!(actual, expected);
	}

	#[test]
	fn git_uncommitted_diff_matches_both_unborn_head_comparisons() {
		let temp = tempfile::tempdir().unwrap();
		init_git(temp.path());
		fs::write(temp.path().join("new.txt"), "staged\n").unwrap();
		run_git(temp.path(), &["add", "new.txt"]);
		fs::write(temp.path().join("new.txt"), "staged\nunstaged\n").unwrap();

		let expected = git::join_patches(&[
			run_git(temp.path(), &["diff"]),
			run_git(temp.path(), &["diff", "--cached"]),
		]);
		let actual = detect(temp.path())
			.unwrap()
			.unwrap()
			.uncommitted_diff(&[])
			.unwrap();
		assert_eq!(actual, expected);
	}
}
