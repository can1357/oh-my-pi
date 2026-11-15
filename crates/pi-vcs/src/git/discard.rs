//! Whether a work-discarding git command would destroy anything, answered
//! before the command is approved.

use std::{ffi::OsStr, path::Path, time::Duration};

use super::{cli, discover_info};
use crate::{
	error::Result,
	types::{DiscardCheck, RepositoryPaths},
};

/// Deadline for [`discards_work`]: it runs synchronously while a tool call
/// waits for approval.
const DISCARD_CHECK_TIMEOUT: Duration = Duration::from_secs(3);
/// Bytes retained from the check's output; the answer is only "any entry?".
const DISCARD_CHECK_CAPTURE_LIMIT: usize = 4 * 1024;

/// Whether a work-discarding command run in `dir` would destroy anything.
///
/// That is uncommitted changes to tracked files (`git status --porcelain
/// --untracked-files=no`), or the untracked files `git clean` with the
/// check's options would delete (`git clean --dry-run`, pathspecs relative to
/// `dir`), in the repository and work tree the command names in
/// `repository` (`--git-dir`, `--work-tree`), or else the ones git discovers
/// from `dir`. `false` outside a repository.
///
/// The question is asked while the command awaits approval, about a
/// repository the agent may have just rewritten, so git runs through
/// [`cli::run_sync_inert`]: no fsmonitor hook, no filter driver, no fetch from
/// a promisor remote, no inherited `GIT_*` variable. Submodules are not
/// entered.
pub fn discards_work(
	dir: &Path,
	repository: &RepositoryPaths,
	check: &DiscardCheck,
) -> Result<bool> {
	if repository.git_dir.is_none() && discover_info(dir)?.is_none() {
		return Ok(false);
	}
	let mut location: Vec<(&str, &OsStr)> = Vec::new();
	if let Some(git_dir) = &repository.git_dir {
		location.push(("GIT_DIR", git_dir.as_os_str()));
	}
	if let Some(work_tree) = &repository.work_tree {
		location.push(("GIT_WORK_TREE", work_tree.as_os_str()));
	}
	let mut args: Vec<String> = Vec::new();
	match check {
		DiscardCheck::Tracked => {
			args.extend(
				["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=all"]
					.map(str::to_owned),
			);
		},
		DiscardCheck::Clean(clean) => {
			args.extend(["clean", "--dry-run"].map(str::to_owned));
			if clean.directories {
				args.push("-d".to_owned());
			}
			// A second `-f` also deletes untracked nested repositories, which a
			// single one only skips.
			if clean.nested_repositories {
				args.push("-ff".to_owned());
			}
			if clean.ignored_only {
				args.push("-X".to_owned());
			} else if clean.include_ignored {
				args.push("-x".to_owned());
			}
			for pattern in &clean.excludes {
				args.push("-e".to_owned());
				args.push(pattern.clone());
			}
			args.push("--".to_owned());
			args.extend(clean.pathspecs.iter().cloned());
		},
	}
	let clean = matches!(check, DiscardCheck::Clean(_));
	let limit = if clean {
		cli::OUTPUT_LIMIT_BYTES
	} else {
		DISCARD_CHECK_CAPTURE_LIMIT
	};
	let output = cli::run_sync_inert(dir, &location, &args, DISCARD_CHECK_TIMEOUT, limit)?
		.into_checked(&args)?;
	if !clean {
		return Ok(!output.stdout.trim().is_empty());
	}
	// A dry run also prints what it leaves ("Would skip repository", "Would
	// refuse to remove current working directory"); only "Would remove" lines
	// name a deletion. Messages are in the C locale ([`cli::run_sync_inert`]).
	Ok(cli::is_truncated(&output.stdout)
		|| output
			.stdout
			.lines()
			.any(|line| line.starts_with("Would remove ")))
}

#[cfg(test)]
mod tests {
	use std::{fs, process::Command};

	use super::*;
	use crate::types::CleanCheck;

	type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

	fn git(cwd: &Path, args: &[&str]) -> TestResult {
		let output = Command::new("git").current_dir(cwd).args(args).output()?;
		if !output.status.success() {
			return Err(
				format!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&output.stderr))
					.into(),
			);
		}
		Ok(())
	}

	/// Makes `root` a repository with one committed file, `a.txt`.
	fn init(root: &Path) -> TestResult {
		git(root, &["init", "-q", "-b", "main"])?;
		fs::write(root.join("a.txt"), "one\n")?;
		git(root, &["add", "a.txt"])?;
		git(root, &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init"])
	}

	fn repo() -> std::result::Result<tempfile::TempDir, Box<dyn std::error::Error>> {
		let dir = tempfile::tempdir()?;
		init(dir.path())?;
		Ok(dir)
	}

	fn clean(check: CleanCheck) -> DiscardCheck {
		DiscardCheck::Clean(check)
	}

	/// No `--git-dir` or `--work-tree`: git discovers the repository.
	const DISCOVERED: RepositoryPaths = RepositoryPaths { git_dir: None, work_tree: None };

	#[test]
	fn reports_tracked_changes_and_untracked_files_separately() -> TestResult {
		let dir = repo()?;
		let root = dir.path();
		assert!(!discards_work(root, &DISCOVERED, &DiscardCheck::Tracked)?);
		assert!(!discards_work(root, &DISCOVERED, &clean(CleanCheck::default()))?);

		fs::write(root.join("scratch.txt"), "x\n")?;
		assert!(
			!discards_work(root, &DISCOVERED, &DiscardCheck::Tracked)?,
			"untracked files survive a reset"
		);
		assert!(discards_work(root, &DISCOVERED, &clean(CleanCheck::default()))?);
		let excluded = CleanCheck { excludes: vec!["scratch.txt".to_owned()], ..Default::default() };
		assert!(!discards_work(root, &DISCOVERED, &clean(excluded))?);

		fs::write(root.join("a.txt"), "two\n")?;
		assert!(discards_work(root, &DISCOVERED, &DiscardCheck::Tracked)?);
		Ok(())
	}

	#[test]
	fn clean_pathspecs_resolve_against_the_directory() -> TestResult {
		let dir = repo()?;
		let root = dir.path();
		fs::create_dir(root.join("sub"))?;
		fs::write(root.join("sub").join("keep.txt"), "x\n")?;
		let here = CleanCheck { pathspecs: vec![".".to_owned()], ..Default::default() };
		assert!(discards_work(&root.join("sub"), &DISCOVERED, &clean(here.clone()))?);
		fs::create_dir(root.join("empty-sub"))?;
		assert!(!discards_work(&root.join("empty-sub"), &DISCOVERED, &clean(here))?);
		Ok(())
	}

	#[test]
	fn is_false_outside_a_repository() -> TestResult {
		let dir = tempfile::tempdir()?;
		assert!(!discards_work(dir.path(), &DISCOVERED, &DiscardCheck::Tracked)?);
		Ok(())
	}

	#[test]
	fn clean_lists_nested_repositories_only_when_forced_twice() -> TestResult {
		let dir = repo()?;
		let root = dir.path();
		let nested = root.join("nested");
		fs::create_dir(&nested)?;
		init(&nested)?;
		let once = CleanCheck { directories: true, ..Default::default() };
		assert!(
			!discards_work(root, &DISCOVERED, &clean(once))?,
			"a single -f skips a nested repository"
		);
		let twice = CleanCheck { directories: true, nested_repositories: true, ..Default::default() };
		assert!(discards_work(root, &DISCOVERED, &clean(twice))?);
		Ok(())
	}

	/// The repository's configuration decides what `git status` may run: an
	/// fsmonitor hook on every status, a clean filter on every stat-dirty file.
	/// A driver name containing `=` cannot be blanked with `-c`, which splits
	/// at the first `=`.
	#[cfg(unix)]
	#[test]
	fn runs_no_program_the_repository_configures() -> TestResult {
		use std::os::unix::fs::PermissionsExt;

		let dir = repo()?;
		let root = dir.path();
		let marker = root.join(".git").join("marker");
		let hook = root.join(".git").join("hook.sh");
		fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\ncat\n", marker.display()))?;
		fs::set_permissions(&hook, fs::Permissions::from_mode(0o755))?;
		let hook = hook.to_string_lossy().into_owned();
		fs::write(root.join(".gitattributes"), "a.txt filter=a=b\n")?;
		git(root, &["config", "core.fsmonitor", &hook])?;
		git(root, &["config", "filter.a=b.clean", &hook])?;
		git(root, &["config", "filter.a=b.required", "true"])?;

		// Same size, new mtime: git compares the content, through the clean
		// filter when one is configured.
		let future = std::time::SystemTime::now() + Duration::from_mins(1);
		fs::File::options()
			.write(true)
			.open(root.join("a.txt"))?
			.set_modified(future)?;
		assert!(!discards_work(root, &DISCOVERED, &DiscardCheck::Tracked)?);
		fs::write(root.join("a.txt"), "two\n")?;
		assert!(discards_work(root, &DISCOVERED, &DiscardCheck::Tracked)?);
		assert!(!marker.exists(), "a repository-configured program ran");
		Ok(())
	}

	/// A bare repository with its work tree elsewhere, as for dotfiles
	/// (`git --git-dir=~/.dotfiles --work-tree=~`): the check looks there, not
	/// in the repository of the directory it runs in, and blanks the filter
	/// drivers the named repository configures.
	#[cfg(unix)]
	#[test]
	fn checks_the_repository_and_work_tree_a_command_names() -> TestResult {
		use std::os::unix::fs::PermissionsExt;

		let dir = repo()?;
		let root = dir.path();
		let other = tempfile::tempdir()?;
		let git_dir = other.path().join("dot.git");
		let work_tree = other.path().join("home");
		fs::create_dir(&work_tree)?;
		git(other.path(), &["init", "-q", "--bare", "dot.git"])?;
		let location = [
			format!("--git-dir={}", git_dir.display()),
			format!("--work-tree={}", work_tree.display()),
		];
		let named = |args: &[&str]| {
			let mut all: Vec<&str> = location.iter().map(String::as_str).collect();
			all.extend_from_slice(args);
			git(other.path(), &all)
		};
		fs::write(work_tree.join(".bashrc"), "one\n")?;
		named(&["add", ".bashrc"])?;
		named(&["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init"])?;
		let marker = other.path().join("marker");
		let hook = other.path().join("hook.sh");
		fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\ncat\n", marker.display()))?;
		fs::set_permissions(&hook, fs::Permissions::from_mode(0o755))?;
		let hook = hook.to_string_lossy().into_owned();
		fs::write(work_tree.join(".gitattributes"), ".bashrc filter=x\n")?;
		named(&["config", "filter.x.clean", &hook])?;
		named(&["config", "filter.x.required", "true"])?;

		let repository =
			RepositoryPaths { git_dir: Some(git_dir), work_tree: Some(work_tree.clone()) };
		let future = std::time::SystemTime::now() + Duration::from_mins(1);
		fs::File::options()
			.write(true)
			.open(work_tree.join(".bashrc"))?
			.set_modified(future)?;
		assert!(!discards_work(root, &repository, &DiscardCheck::Tracked)?);
		fs::write(work_tree.join(".bashrc"), "two\n")?;
		assert!(
			!discards_work(root, &DISCOVERED, &DiscardCheck::Tracked)?,
			"the directory's own repository is clean"
		);
		assert!(discards_work(root, &repository, &DiscardCheck::Tracked)?);
		// From a directory in no repository too.
		assert!(discards_work(other.path(), &repository, &DiscardCheck::Tracked)?);
		assert!(!marker.exists(), "a program the named repository configures ran");
		Ok(())
	}

	/// A partial clone fetches a missing object from its promisor remote, and
	/// the fetch runs the upload-pack command the configuration names.
	#[cfg(unix)]
	#[test]
	fn fetches_nothing_from_a_promisor_remote() -> TestResult {
		let dir = repo()?;
		let root = dir.path();
		let marker = root.join(".git").join("marker");
		for (key, value) in [
			("remote.origin.url", "/nowhere".to_owned()),
			("remote.origin.promisor", "true".to_owned()),
			("remote.origin.partialclonefilter", "blob:none".to_owned()),
			("extensions.partialclone", "origin".to_owned()),
			("remote.origin.uploadpack", format!("touch '{}'; false", marker.display())),
		] {
			git(root, &["config", key, &value])?;
		}
		// A HEAD commit the object store lacks: the check fails instead of
		// fetching it.
		fs::write(root.join(".git").join("HEAD"), format!("{}\n", "1".repeat(40)))?;
		assert!(discards_work(root, &DISCOVERED, &DiscardCheck::Tracked).is_err());
		assert!(!marker.exists(), "a repository-configured program ran");
		Ok(())
	}
}
