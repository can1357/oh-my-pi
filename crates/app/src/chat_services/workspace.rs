//! `/dirs`, `/add-dir`, `/move`, `/wt`: the session's working directory and
//! worktrees over the project checkout.

use std::{
	fs,
	path::{Path, PathBuf},
	process::Command,
};

use omp_chat::overlays::services::{ServiceError, ServiceResult, WorktreeInfo};
use omp_core::{Str, sf};

use super::ServiceState;

/// The directory the session currently belongs to: the launch project
/// until `/move` or `/wt` relocated the journal into another project's
/// session bucket, after which the process working directory follows.
pub(super) fn project_dir(state: &ServiceState) -> ServiceResult<PathBuf> {
	let journal = state.live_journal.read().clone();
	if journal.parent() == Some(state.sessions_dir.as_path()) {
		return Ok(state.project.clone());
	}
	std::env::current_dir().map_err(ServiceError::failed)
}

/// Validates `branch`, creates it from `HEAD` in a new linked worktree under
/// the configured base (`sv_worktree_base` or `<data>/worktrees`), and carries
/// uncommitted changes from the source checkout over.
pub(super) fn create_worktree(state: &ServiceState, branch: &str) -> ServiceResult<WorktreeInfo> {
	create_worktree_at(&project_dir(state)?, &worktree_base(state), branch)
}

/// [`create_worktree`] over explicit paths: the checkout containing `cwd`
/// and the directory new worktrees are created under.
fn create_worktree_at(cwd: &Path, base: &Path, branch: &str) -> ServiceResult<WorktreeInfo> {
	let root = git(cwd, &["rev-parse", "--show-toplevel"])
		.map_err(|_| ServiceError::Failed(sf!("Not inside a git repository: {}", cwd.display())))?;
	let root = PathBuf::from(root.trim());
	validate_branch(branch)?;
	if git(&root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok() {
		return Err(ServiceError::Failed(sf!(
			"Branch '{branch}' already exists; pick another name."
		)));
	}
	fs::create_dir_all(base).map_err(ServiceError::failed)?;
	let slug = branch
		.chars()
		.map(|c| {
			if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
				c
			} else {
				'-'
			}
		})
		.collect::<String>();
	let stem = format!("{slug}-{}", hash_path(&root));
	let mut path = base.join(&stem);
	let mut suffix = 2;
	while path.exists() {
		path = base.join(format!("{stem}-{suffix}"));
		suffix += 1;
	}
	// A stash object captures tracked changes without touching the source
	// checkout; untracked files are copied after the checkout exists.
	let stash = git(&root, &["stash", "create"])
		.ok()
		.map(|sha| sha.trim().to_owned());
	git(&root, &["worktree", "add", "-b", branch, &path.to_string_lossy(), "HEAD"])
		.map_err(|error| ServiceError::Failed(sf!("git worktree add failed: {error}")))?;
	if let Some(stash) = stash.filter(|sha| !sha.is_empty())
		&& let Err(error) = git(&path, &["stash", "apply", "--index", &stash])
	{
		// Index replay can fail on a pure working-tree stash; the plain apply
		// still carries the edits.
		tracing::debug!(%error, "stash apply --index failed; retrying without --index");
		git(&path, &["stash", "apply", &stash])
			.map_err(|error| ServiceError::Failed(sf!("carrying changes over failed: {error}")))?;
	}
	if let Ok(untracked) = git(&root, &["ls-files", "--others", "--exclude-standard", "-z"]) {
		for rel in untracked.split('\0').filter(|rel| !rel.is_empty()) {
			let from = root.join(rel);
			let to = path.join(rel);
			if let Some(parent) = to.parent() {
				let _ = fs::create_dir_all(parent);
			}
			let _ = fs::copy(&from, &to);
		}
	}
	let path = fs::canonicalize(&path).unwrap_or(path);
	Ok(WorktreeInfo { path, branch: Str::new(branch) })
}

/// Branch names exclude whitespace and `~^:?*[\\]`, leading `-`, trailing
/// `/`, and `..`.
fn validate_branch(branch: &str) -> ServiceResult<()> {
	let bad = branch.is_empty()
		|| branch
			.chars()
			.any(|c| c.is_whitespace() || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
		|| branch.starts_with('-')
		|| branch.ends_with('/')
		|| branch.contains("..");
	if bad {
		return Err(ServiceError::Failed(sf!("Invalid branch name: {branch}")));
	}
	Ok(())
}

/// `sv_worktree_base`, else `<data>/worktrees`.
fn worktree_base(state: &ServiceState) -> PathBuf {
	let configured = omp_envd::host_settings::SV_WORKTREE_BASE.get(&state.con);
	if configured.is_empty() {
		state.data_dir.join("worktrees")
	} else {
		PathBuf::from(configured.as_str())
	}
}

/// Short stable hash of the primary checkout.
fn hash_path(path: &Path) -> String {
	let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
	for byte in path.to_string_lossy().bytes() {
		hash ^= u64::from(byte);
		hash = hash.wrapping_mul(0x0100_0000_01b3);
	}
	format!("{:08x}", hash & 0xffff_ffff)
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
	let output = Command::new("git")
		.args(args)
		.current_dir(cwd)
		.output()
		.map_err(|error| error.to_string())?;
	if output.status.success() {
		Ok(String::from_utf8_lossy(&output.stdout).into_owned())
	} else {
		Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn branch_names_follow_pi_rules() {
		assert!(validate_branch("wt/20260903-101010").is_ok());
		assert!(validate_branch("feature/x.y_z").is_ok());
		assert!(validate_branch("").is_err());
		assert!(validate_branch("-lead").is_err());
		assert!(validate_branch("trail/").is_err());
		assert!(validate_branch("a..b").is_err());
		assert!(validate_branch("has space").is_err());
		assert!(validate_branch("star*").is_err());
	}

	#[test]
	fn worktree_carries_uncommitted_changes() {
		let temp = tempfile::tempdir().expect("tempdir");
		let root = temp.path().join("repo");
		fs::create_dir_all(&root).unwrap();
		let run = |args: &[&str]| git(&root, args).expect(args[0]);
		run(&["init", "-q", "-b", "main"]);
		run(&["config", "user.email", "t@example.com"]);
		run(&["config", "user.name", "t"]);
		fs::write(root.join("a.txt"), "one\n").unwrap();
		run(&["add", "a.txt"]);
		run(&["commit", "-q", "-m", "init"]);
		fs::write(root.join("a.txt"), "two\n").unwrap();
		fs::write(root.join("new.txt"), "untracked\n").unwrap();
		let base = temp.path().join("wts");
		let worktree = create_worktree_at(&root, &base, "wt/test").expect("worktree");
		assert_eq!(worktree.branch, "wt/test");
		assert!(worktree.path.starts_with(fs::canonicalize(&base).unwrap()));
		assert_eq!(fs::read_to_string(worktree.path.join("a.txt")).unwrap(), "two\n");
		assert_eq!(fs::read_to_string(worktree.path.join("new.txt")).unwrap(), "untracked\n");
		assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "two\n", "source untouched");
		let head = git(&worktree.path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
		assert_eq!(head.trim(), "wt/test");
		assert!(create_worktree_at(&root, &base, "wt/test").is_err(), "existing branch is rejected");
	}
}
