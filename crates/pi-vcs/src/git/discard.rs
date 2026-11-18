//! Whether a work-discarding git command would destroy anything, answered
//! before the command is approved.

use std::{
	collections::{BTreeSet, HashSet},
	ffi::OsStr,
	path::{Path, PathBuf},
	time::{Duration, Instant},
};

use gix::bstr::ByteSlice;

use super::{cli, discover_info};
use crate::{
	error::{Error, Result},
	types::{CleanCheck, DiscardCheck, RepositoryPaths, TrackedCheck},
};

/// Whether a work-discarding command run in `dir` would destroy anything.
///
/// That is uncommitted changes to tracked files under the check's pathspecs
/// (`git status --porcelain --untracked-files=no`; with `worktree_only`, only
/// those the work tree holds beyond the index), and with a `source`, the
/// untracked files that are not ignored and that checking the files out of
/// it overwrites; or the untracked files `git clean` with the check's options
/// would delete (`git clean --dry-run`), with pathspecs relative to `dir`, in
/// the repository and work tree the command names in `repository`
/// (`--git-dir`, `--work-tree`), or else the ones git discovers from `dir`.
/// `false` outside a repository. `timeout` bounds the whole check, every git
/// call it makes included: it runs synchronously while a tool call waits for
/// approval.
///
/// The question is asked while the command awaits approval, about a
/// repository the agent may have just rewritten, so git runs through
/// [`cli::InertGit`]: no fsmonitor hook, no filter driver, no fetch from a
/// promisor remote, no inherited `GIT_*` variable. Submodules are not
/// entered. A work-tree change to a file a configured filter driver handles
/// (git-lfs, git-crypt) counts when git sees it without the content (deleted,
/// changed type) or the file's size differs from the size the index recorded
/// for it: git compares the unfiltered content with the filtered blob, which
/// differ for a file that was only touched, and telling a touched file from a
/// same-size edit would mean running the filter.
pub fn discards_work(
	dir: &Path,
	repository: &RepositoryPaths,
	check: &DiscardCheck,
	timeout: Duration,
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
	let deadline = Instant::now() + timeout;
	let git = cli::InertGit::open(dir, &location, remaining(deadline))?;
	match check {
		DiscardCheck::Tracked(tracked) if tracked.merge => {
			loses_staged_changes(&git, dir, tracked, deadline)
		},
		DiscardCheck::Tracked(tracked) => {
			if !tracked.tracked_stashed && loses_tracked_changes(&git, dir, tracked, deadline)? {
				return Ok(true);
			}
			overwrites_untracked_files(&git, dir, tracked, deadline)
		},
		DiscardCheck::Clean(clean) => deletes_untracked_files(&git, dir, clean, deadline),
	}
}

/// What is left of the check's time at `deadline`.
fn remaining(deadline: Instant) -> Duration {
	deadline.saturating_duration_since(Instant::now())
}

/// Runs `args` in `dir` before `deadline` and fails on a non-zero exit.
fn run_checked(
	git: &cli::InertGit,
	dir: &Path,
	args: &[String],
	stdin: &[u8],
	deadline: Instant,
) -> Result<String> {
	let output = git.run(dir, args, stdin, remaining(deadline), cli::OUTPUT_LIMIT_BYTES)?;
	Ok(output.into_checked(args)?.stdout)
}

/// Whether restoring the files `check` names would lose changes to them.
fn loses_tracked_changes(
	git: &cli::InertGit,
	dir: &Path,
	check: &TrackedCheck,
	deadline: Instant,
) -> Result<bool> {
	let status = tracked_status(git, dir, &check.pathspecs, deadline)?;
	if cli::is_truncated(&status) {
		return Ok(true);
	}
	// `XY <path>`: X the index against HEAD, Y the work tree against the
	// index. A rename or copy carries its source path in the next field.
	let mut unsure = Vec::new();
	let mut fields = status.split('\0');
	while let Some(entry) = fields.next() {
		let (Some(&index), Some(&worktree), Some(path)) =
			(entry.as_bytes().first(), entry.as_bytes().get(1), entry.get(3..))
		else {
			continue;
		};
		if matches!(index, b'R' | b'C') {
			fields.next();
		}
		if index != b' ' && !check.worktree_only {
			return Ok(true);
		}
		match worktree {
			b' ' => {},
			b'M' if !git.blanked_filters().is_empty() => unsure.push(path),
			_ => return Ok(true),
		}
	}
	if unsure.is_empty() {
		return Ok(false);
	}
	changed_behind_filters(git, dir, &unsure, deadline)
}

/// `git status` of the tracked files `pathspecs` select (all of them when
/// empty): NUL-separated `XY path` entries.
fn tracked_status(
	git: &cli::InertGit,
	dir: &Path,
	pathspecs: &[String],
	deadline: Instant,
) -> Result<String> {
	let mut args: Vec<String> =
		["status", "--porcelain", "-z", "--untracked-files=no", "--ignore-submodules=all", "--"]
			.map(str::to_owned)
			.to_vec();
	args.extend(pathspecs.iter().cloned());
	run_checked(git, dir, &args, &[], deadline)
}

/// Whether `git reset --merge` would lose a staged change. Git refuses, and
/// loses nothing, while a path has a staged change and a work-tree
/// modification it would keep (`MM`, `AM`, `RM`, `MT`); otherwise it reverts
/// the staged changes, which are then gone. That includes a staged path
/// deleted in the work tree (`MD`, `AD`) and an unmerged one (`UU`, `AA`,
/// `DU`, ...), whose conflict resolution in the work tree it overwrites.
fn loses_staged_changes(
	git: &cli::InertGit,
	dir: &Path,
	check: &TrackedCheck,
	deadline: Instant,
) -> Result<bool> {
	let status = tracked_status(git, dir, &check.pathspecs, deadline)?;
	if cli::is_truncated(&status) {
		return Ok(true);
	}
	let mut staged = false;
	let mut fields = status.split('\0');
	while let Some(entry) = fields.next() {
		let (Some(&index), Some(&worktree)) = (entry.as_bytes().first(), entry.as_bytes().get(1))
		else {
			continue;
		};
		if matches!(index, b'R' | b'C') {
			fields.next();
		}
		// No unmerged entry (`UU`, `AA`, `DU`, ...) has `M` or `T` in its second
		// column.
		if index != b' ' && matches!(worktree, b'M' | b'T') {
			return Ok(false);
		}
		staged |= index != b' ';
	}
	Ok(staged)
}

/// Whether any of `paths` (relative to the top of the work tree), which git
/// saw modified in the work tree with every filter driver blanked, really
/// changed: no blanked driver filters it, or its size differs from the size
/// the index recorded. A path a blanked driver filters was compared
/// unfiltered against its filtered blob, so it shows modified whenever its
/// stat data changed. An index that cannot be read counts as a change.
fn changed_behind_filters(
	git: &cli::InertGit,
	dir: &Path,
	paths: &[&str],
	deadline: Instant,
) -> Result<bool> {
	let args: Vec<String> =
		["rev-parse", "--show-toplevel", "--git-path", "index", "--show-object-format"]
			.map(str::to_owned)
			.to_vec();
	let location = run_checked(git, dir, &args, &[], deadline)?;
	let mut lines = location.lines();
	let (Some(top), Some(index_path), Some(object_format)) =
		(lines.next(), lines.next(), lines.next())
	else {
		return Err(Error::backend("git rev-parse", "missing the work tree or index location"));
	};
	let top = PathBuf::from(top);

	let args: Vec<String> = ["check-attr", "-z", "--stdin", "filter"]
		.map(str::to_owned)
		.to_vec();
	let mut stdin = Vec::new();
	for path in paths {
		stdin.extend_from_slice(path.as_bytes());
		stdin.push(0);
	}
	let attributes = run_checked(git, &top, &args, &stdin, deadline)?;
	// `<path>\0filter\0<value>\0` for each path.
	let mut fields = attributes.split('\0');
	let mut filtered = Vec::with_capacity(paths.len());
	while let (Some(path), Some(_), Some(value)) = (fields.next(), fields.next(), fields.next()) {
		if !git.blanked_filters().contains(value) {
			return Ok(true);
		}
		filtered.push(path);
	}
	if filtered.len() < paths.len() {
		return Ok(true);
	}

	// `--git-path` is relative to the directory rev-parse ran in.
	let index = object_format
		.parse::<gix::hash::Kind>()
		.ok()
		.and_then(|kind| {
			gix::index::File::at(dir.join(index_path), kind, true, Default::default()).ok()
		});
	let Some(index) = index else {
		return Ok(true);
	};
	Ok(filtered.iter().any(|path| {
		// The index keeps the low 32 bits of the size.
		let recorded = index
			.entry_by_path(path.as_bytes().as_bstr())
			.map(|entry| entry.stat.size);
		let actual = std::fs::symlink_metadata(top.join(path)).map(|meta| meta.len() as u32);
		recorded.is_none() || recorded != actual.ok()
	}))
}

/// Whether checking the files `check` names out of its `source` would
/// overwrite an untracked file that is not ignored (git overwrites ignored
/// files even without `--force`): one the source tracks, one where it tracks
/// a directory, or one under a path it tracks as a file or a submodule. Only
/// tree objects are read, so a partial clone needs no blob it lacks.
fn overwrites_untracked_files(
	git: &cli::InertGit,
	dir: &Path,
	check: &TrackedCheck,
	deadline: Instant,
) -> Result<bool> {
	let Some(source) = &check.source else {
		return Ok(false);
	};
	let mut args: Vec<String> =
		["ls-files", "-z", "--others", "--exclude-standard", "--full-name", "--"]
			.map(str::to_owned)
			.to_vec();
	if check.pathspecs.is_empty() {
		// A checkout without pathspecs covers the whole work tree, wherever
		// it runs.
		args.push(":/".to_owned());
	} else {
		args.extend(check.pathspecs.iter().cloned());
	}
	let listed = run_checked(git, dir, &args, &[], deadline)?;
	if cli::is_truncated(&listed) {
		return Ok(true);
	}
	// An untracked nested repository is listed as its directory, with a
	// trailing slash.
	let untracked: Vec<&str> = listed
		.split('\0')
		.filter(|path| !path.is_empty())
		.map(|path| path.trim_end_matches('/'))
		.collect();
	if untracked.is_empty() {
		return Ok(false);
	}
	for tree in source_trees(git, dir, source, deadline)? {
		let args: Vec<String> = ["ls-tree", "-r", "-z", "--name-only", "--full-tree", tree.as_str()]
			.map(str::to_owned)
			.to_vec();
		let listing = run_checked(git, dir, &args, &[], deadline)?;
		if cli::is_truncated(&listing) {
			return Ok(true);
		}
		let tracked: BTreeSet<&str> = listing
			.split('\0')
			.filter(|path| !path.is_empty())
			.collect();
		if untracked.iter().any(|path| is_in_the_way(path, &tracked)) {
			return Ok(true);
		}
	}
	Ok(false)
}

/// Whether a checkout of a tree that tracks the files `tracked` writes over
/// `path`: it tracks `path`, a file under it, or a file at a directory above
/// it.
fn is_in_the_way(path: &str, tracked: &BTreeSet<&str>) -> bool {
	let below = format!("{path}/");
	tracked.contains(path)
		|| tracked
			.range::<&str, _>(below.as_str()..)
			.next()
			.is_some_and(|next| next.starts_with(&below))
		|| path
			.match_indices('/')
			.any(|(at, _)| tracked.contains(&path[..at]))
}

/// The trees a checkout of `source` takes the files from: the one `source`
/// names, or else, as `git switch` and `git checkout` guess a new branch from
/// a remote-tracking branch of that name, the trees of those (git refuses
/// when several remotes have one, unless configured to pick one of them).
fn source_trees(
	git: &cli::InertGit,
	dir: &Path,
	source: &str,
	deadline: Instant,
) -> Result<Vec<String>> {
	// `cat-file` reads the name from its input, where it cannot be taken for
	// an option; a name with a line break in it would be two names there.
	if !source.contains('\n') {
		let args: Vec<String> = ["cat-file", "--batch-check=%(objectname)"]
			.map(str::to_owned)
			.to_vec();
		let query = format!("{source}^{{tree}}\n");
		let output = run_checked(git, dir, &args, query.as_bytes(), deadline)?;
		// A name that resolves to no tree comes back as `<name> missing`.
		let tree = output.trim_end_matches('\n');
		if !tree.is_empty() && tree.bytes().all(|byte| byte.is_ascii_hexdigit()) {
			return Ok(vec![tree.to_owned()]);
		}
	}
	// `%(tree)` for a commit, `%(*tree)` for an annotated tag.
	let args = [
		"for-each-ref".to_owned(),
		"--format=%(tree)%(*tree)".to_owned(),
		format!("refs/remotes/*/{source}"),
	];
	let output = run_checked(git, dir, &args, &[], deadline)?;
	Ok(output
		.lines()
		.filter(|tree| !tree.is_empty())
		.map(str::to_owned)
		.collect())
}

/// The arguments of the `git clean` dry run `check` describes.
fn clean_preview_args(check: &CleanCheck) -> Vec<String> {
	let mut args: Vec<String> = ["clean", "--dry-run"].map(str::to_owned).to_vec();
	if check.directories {
		args.push("-d".to_owned());
	}
	// A second `-f` also deletes untracked nested repositories, which a
	// single one only skips.
	if check.nested_repositories {
		args.push("-ff".to_owned());
	}
	if check.ignored_only {
		args.push("-X".to_owned());
	} else if check.include_ignored {
		args.push("-x".to_owned());
	}
	for pattern in &check.excludes {
		args.push("-e".to_owned());
		args.push(pattern.clone());
	}
	args.push("--".to_owned());
	args.extend(check.pathspecs.iter().cloned());
	args
}

/// Whether the `git clean` `check` describes would delete anything.
fn deletes_untracked_files(
	git: &cli::InertGit,
	dir: &Path,
	check: &CleanCheck,
	deadline: Instant,
) -> Result<bool> {
	let output = run_checked(git, dir, &clean_preview_args(check), &[], deadline)?;
	if cli::is_truncated(&output) {
		return Ok(true);
	}
	// A dry run also prints what it leaves ("Would skip repository", "Would
	// refuse to remove current working directory"); only "Would remove" lines
	// name a deletion. Messages are in the C locale ([`cli::InertGit`]).
	let listed: Vec<&str> = output
		.lines()
		.filter_map(|line| line.strip_prefix("Would remove "))
		.collect();
	if listed.is_empty() || !check.untracked_stashed {
		return Ok(!listed.is_empty());
	}
	// A `git stash -u` before the command saved the untracked files that the
	// plain preview lists, so only what the preview lists beyond them is left.
	let plain = CleanCheck {
		directories: check.directories,
		pathspecs: check.pathspecs.clone(),
		..CleanCheck::default()
	};
	let plain_output = run_checked(git, dir, &clean_preview_args(&plain), &[], deadline)?;
	if cli::is_truncated(&plain_output) {
		return Ok(true);
	}
	let saved: HashSet<&str> = plain_output
		.lines()
		.filter_map(|line| line.strip_prefix("Would remove "))
		.collect();
	// Both previews name an untracked directory with nothing kept in it as one
	// `dir/` line, so an `-e` that keeps a file in it makes this preview list
	// the directory's other files where the plain one lists the directory: a
	// path is saved when the plain preview lists it or a directory above it.
	let is_saved = |path: &str| {
		saved.contains(path)
			|| path
				.match_indices('/')
				.any(|(at, _)| at + 1 < path.len() && saved.contains(&path[..=at]))
	};
	Ok(listed.iter().any(|path| !is_saved(path)))
}

#[cfg(test)]
mod tests {
	use std::{fs, process::Command};

	use super::*;
	use crate::types::{CleanCheck, TrackedCheck};

	type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

	/// [`super::discards_work`] with the three seconds an approval check gives
	/// it.
	fn discards_work(
		dir: &Path,
		repository: &RepositoryPaths,
		check: &DiscardCheck,
	) -> Result<bool> {
		super::discards_work(dir, repository, check, Duration::from_secs(3))
	}

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
	/// Every uncommitted change to a tracked file, as `git reset --hard` loses.
	const HARD_RESET: DiscardCheck = DiscardCheck::Tracked(TrackedCheck {
		worktree_only:   false,
		pathspecs:       Vec::new(),
		merge:           false,
		source:          None,
		tracked_stashed: false,
	});

	/// Sets `path`'s modification time a minute ahead without changing its
	/// content: git has to compare the content to tell whether it changed.
	fn touch(path: &Path) -> TestResult {
		let future = std::time::SystemTime::now() + Duration::from_mins(1);
		fs::File::options()
			.write(true)
			.open(path)?
			.set_modified(future)?;
		Ok(())
	}

	#[test]
	fn reports_tracked_changes_and_untracked_files_separately() -> TestResult {
		let dir = repo()?;
		let root = dir.path();
		assert!(!discards_work(root, &DISCOVERED, &HARD_RESET)?);
		assert!(!discards_work(root, &DISCOVERED, &clean(CleanCheck::default()))?);

		fs::write(root.join("scratch.txt"), "x\n")?;
		assert!(!discards_work(root, &DISCOVERED, &HARD_RESET)?, "untracked files survive a reset");
		assert!(discards_work(root, &DISCOVERED, &clean(CleanCheck::default()))?);
		let excluded = CleanCheck { excludes: vec!["scratch.txt".to_owned()], ..Default::default() };
		assert!(!discards_work(root, &DISCOVERED, &clean(excluded))?);

		fs::write(root.join("a.txt"), "two\n")?;
		assert!(discards_work(root, &DISCOVERED, &HARD_RESET)?);
		Ok(())
	}

	/// `git checkout .` and `git restore .` restore the files under the
	/// directory from the index: changes elsewhere, and staged ones, survive.
	#[test]
	fn counts_only_the_changes_the_restore_overwrites() -> TestResult {
		let dir = repo()?;
		let root = dir.path();
		fs::create_dir(root.join("docs"))?;
		fs::create_dir(root.join("src"))?;
		fs::write(root.join("docs").join("d.md"), "d\n")?;
		fs::write(root.join("src").join("s.ts"), "s\n")?;
		git(root, &["add", "docs", "src"])?;
		git(root, &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "two"])?;
		let from_index = |pathspec: &str| {
			DiscardCheck::Tracked(TrackedCheck {
				worktree_only: true,
				pathspecs: vec![pathspec.to_owned()],
				..TrackedCheck::default()
			})
		};

		fs::write(root.join("src").join("s.ts"), "changed\n")?;
		let docs = root.join("docs");
		assert!(!discards_work(&docs, &DISCOVERED, &from_index("."))?, "src/ is not under docs/");
		assert!(discards_work(&docs, &DISCOVERED, &from_index(":/"))?);
		assert!(discards_work(&docs, &DISCOVERED, &HARD_RESET)?);
		assert!(discards_work(root, &DISCOVERED, &from_index("."))?);

		git(root, &["add", "src/s.ts"])?;
		assert!(
			!discards_work(root, &DISCOVERED, &from_index("."))?,
			"the index keeps a staged change"
		);
		let from_head = DiscardCheck::Tracked(TrackedCheck {
			pathspecs: vec![".".to_owned()],
			..TrackedCheck::default()
		});
		assert!(discards_work(root, &DISCOVERED, &from_head)?);
		assert!(!discards_work(&docs, &DISCOVERED, &from_head)?);
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
		assert!(!discards_work(dir.path(), &DISCOVERED, &HARD_RESET)?);
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

		// Same content, new mtime: git compares the content, through the clean
		// filter when one is configured.
		touch(&root.join("a.txt"))?;
		assert!(!discards_work(root, &DISCOVERED, &HARD_RESET)?);
		fs::write(root.join("a.txt"), "changed\n")?;
		assert!(discards_work(root, &DISCOVERED, &HARD_RESET)?);
		assert!(!marker.exists(), "a repository-configured program ran");
		Ok(())
	}

	/// `git reset --hard <commit>` and `git checkout -f <branch>` overwrite
	/// the untracked files the commit tracks, those where it tracks a
	/// directory, and those under a path it tracks as a file; ignored files
	/// count for none, as git overwrites them without `--force`. A branch
	/// name only a remote has is looked up there, as `git switch` guesses it.
	#[test]
	fn a_checkout_of_another_commit_overwrites_the_untracked_files_it_tracks() -> TestResult {
		let identity = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
		let dir = repo()?;
		let root = dir.path();
		git(root, &["checkout", "-qb", "other"])?;
		fs::create_dir(root.join("d"))?;
		fs::write(root.join("notes.txt"), "theirs\n")?;
		fs::write(root.join("d").join("f"), "theirs\n")?;
		fs::write(root.join("e"), "theirs\n")?;
		git(root, &["add", "notes.txt", "d", "e"])?;
		git(root, &[&identity[..], &["commit", "-qm", "other"]].concat())?;
		git(root, &["checkout", "-q", "main"])?;
		git(root, &["update-ref", "refs/remotes/origin/remote-only", "other"])?;
		let checkout = |source: &str, tracked_stashed: bool| {
			DiscardCheck::Tracked(TrackedCheck {
				source: Some(source.to_owned()),
				tracked_stashed,
				..TrackedCheck::default()
			})
		};
		let clear = |root: &Path| -> TestResult {
			for path in ["notes.txt", "d", "e"] {
				let path = root.join(path);
				if path.is_dir() {
					fs::remove_dir_all(path)?;
				} else if path.exists() {
					fs::remove_file(path)?;
				}
			}
			Ok(())
		};

		fs::write(root.join("notes.txt"), "mine\n")?;
		assert!(!discards_work(root, &DISCOVERED, &HARD_RESET)?, "HEAD tracks no notes.txt");
		assert!(discards_work(root, &DISCOVERED, &checkout("other", false))?);
		assert!(discards_work(root, &DISCOVERED, &checkout("remote-only", false))?);
		assert!(discards_work(root, &DISCOVERED, &checkout("other", true))?, "a stash leaves it");
		assert!(!discards_work(root, &DISCOVERED, &checkout("main", false))?);
		assert!(!discards_work(root, &DISCOVERED, &checkout("no-such-branch", false))?);
		fs::create_dir_all(root.join(".git").join("info"))?;
		fs::write(root.join(".git").join("info").join("exclude"), "notes.txt\n")?;
		assert!(!discards_work(root, &DISCOVERED, &checkout("other", false))?, "ignored");
		fs::remove_file(root.join(".git").join("info").join("exclude"))?;
		clear(root)?;

		// A file where it tracks a directory, a directory where it tracks a file.
		fs::write(root.join("d"), "mine\n")?;
		assert!(discards_work(root, &DISCOVERED, &checkout("other", false))?);
		clear(root)?;
		fs::create_dir(root.join("e"))?;
		fs::write(root.join("e").join("x"), "mine\n")?;
		assert!(discards_work(root, &DISCOVERED, &checkout("other", false))?);
		clear(root)?;

		// A tracked change counts unless a stash saved it.
		fs::write(root.join("a.txt"), "changed\n")?;
		assert!(discards_work(root, &DISCOVERED, &checkout("other", false))?);
		assert!(!discards_work(root, &DISCOVERED, &checkout("other", true))?);
		Ok(())
	}

	/// With its clean filter blanked, a file whose filter transforms the
	/// content (git-lfs stores a pointer, git-crypt ciphertext) differs from
	/// its blob even when only touched: it counts as changed only when its size
	/// differs from the size the index recorded. A file no configured driver
	/// filters still counts for any change.
	#[cfg(unix)]
	#[test]
	fn a_touched_file_behind_a_transforming_filter_is_unchanged() -> TestResult {
		let dir = repo()?;
		let root = dir.path();
		git(root, &["config", "filter.up.clean", "tr a-z A-Z"])?;
		git(root, &["config", "filter.up.smudge", "tr A-Z a-z"])?;
		git(root, &["config", "filter.up.required", "true"])?;
		fs::write(root.join(".gitattributes"), "*.dat filter=up\n")?;
		fs::write(root.join("b.dat"), "hello\n")?;
		git(root, &["add", ".gitattributes", "b.dat"])?;
		git(root, &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "dat"])?;

		touch(&root.join("b.dat"))?;
		assert!(!discards_work(root, &DISCOVERED, &HARD_RESET)?, "a touched file is unchanged");
		fs::write(root.join("a.txt"), "two\n")?;
		assert!(discards_work(root, &DISCOVERED, &HARD_RESET)?, "a.txt has no filter");
		git(root, &["checkout", "--", "a.txt"])?;
		assert!(!discards_work(root, &DISCOVERED, &HARD_RESET)?);
		fs::write(root.join("b.dat"), "hello, world\n")?;
		assert!(discards_work(root, &DISCOVERED, &HARD_RESET)?);
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
		touch(&work_tree.join(".bashrc"))?;
		assert!(!discards_work(root, &repository, &HARD_RESET)?);
		fs::write(work_tree.join(".bashrc"), "changed\n")?;
		assert!(
			!discards_work(root, &DISCOVERED, &HARD_RESET)?,
			"the directory's own repository is clean"
		);
		assert!(discards_work(root, &repository, &HARD_RESET)?);
		// From a directory in no repository too.
		assert!(discards_work(other.path(), &repository, &HARD_RESET)?);
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
		assert!(discards_work(root, &DISCOVERED, &HARD_RESET).is_err());
		assert!(!marker.exists(), "a repository-configured program ran");
		Ok(())
	}

	/// `git reset --merge` reverts the staged changes, and refuses while a path
	/// has changes both staged and in the work tree, losing nothing. Unstaged
	/// changes alone survive it.
	#[test]
	fn reset_merge_counts_only_the_staged_changes() -> TestResult {
		let dir = repo()?;
		let root = dir.path();
		let merge = DiscardCheck::Tracked(TrackedCheck { merge: true, ..TrackedCheck::default() });
		fs::write(root.join("a.txt"), "two\n")?;
		assert!(!discards_work(root, &DISCOVERED, &merge)?, "an unstaged change survives");
		git(root, &["add", "a.txt"])?;
		assert!(discards_work(root, &DISCOVERED, &merge)?, "a staged change is reverted");
		fs::write(root.join("a.txt"), "three\n")?;
		assert!(
			!discards_work(root, &DISCOVERED, &merge)?,
			"a path changed both ways makes git refuse"
		);
		Ok(())
	}

	/// Git refuses only for a path whose work-tree change it would keep, so
	/// `git reset --merge` overwrites the resolution of an unmerged path (`UU`)
	/// and restores a staged path deleted from the work tree (`MD`).
	#[test]
	fn reset_merge_loses_a_conflict_resolution_and_a_deleted_staged_path() -> TestResult {
		let merge = DiscardCheck::Tracked(TrackedCheck { merge: true, ..TrackedCheck::default() });
		let identity = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
		let dir = repo()?;
		let root = dir.path();
		git(root, &["checkout", "-qb", "side"])?;
		fs::write(root.join("a.txt"), "side\n")?;
		git(root, &[&identity[..], &["commit", "-qam", "side"]].concat())?;
		git(root, &["checkout", "-q", "main"])?;
		fs::write(root.join("a.txt"), "main\n")?;
		git(root, &[&identity[..], &["commit", "-qam", "main"]].concat())?;
		let merged = Command::new("git")
			.current_dir(root)
			.args(identity)
			.args(["merge", "-q", "side"])
			.output()?;
		assert!(!merged.status.success(), "the merge stops on a conflict");
		fs::write(root.join("a.txt"), "resolved\n")?;
		assert!(discards_work(root, &DISCOVERED, &merge)?, "the resolution is overwritten");

		let dir = repo()?;
		let root = dir.path();
		fs::write(root.join("a.txt"), "two\n")?;
		git(root, &["add", "a.txt"])?;
		fs::remove_file(root.join("a.txt"))?;
		assert!(discards_work(root, &DISCOVERED, &merge)?, "the staged change is reverted");
		Ok(())
	}

	/// After a `git stash -u` the untracked files are gone, so a `git clean -x`
	/// deletes only the ignored files left, and an `-e` pattern still protects
	/// the ignored files it names.
	#[test]
	fn stashed_untracked_files_leave_only_the_ignored_ones() -> TestResult {
		let dir = repo()?;
		let root = dir.path();
		fs::write(root.join(".gitignore"), "*.log\ncache/\n")?;
		git(root, &["add", ".gitignore"])?;
		git(root, &[
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@example.com",
			"commit",
			"-qm",
			"ignore",
		])?;
		fs::write(root.join("scratch.txt"), "x\n")?;
		fs::write(root.join("build.log"), "x\n")?;
		let stashed = |excludes: &[&str]| {
			clean(CleanCheck {
				directories: true,
				include_ignored: true,
				excludes: excludes
					.iter()
					.map(|pattern| (*pattern).to_owned())
					.collect(),
				untracked_stashed: true,
				..CleanCheck::default()
			})
		};
		// The stash keeps scratch.txt, and build.log is ignored but excluded.
		assert!(!discards_work(root, &DISCOVERED, &stashed(&["*.log"]))?);
		// Without the exclude, build.log goes.
		assert!(discards_work(root, &DISCOVERED, &stashed(&[]))?);
		// An ignored directory the exclude does not name goes.
		fs::create_dir(root.join("cache"))?;
		fs::write(root.join("cache").join("c.bin"), "x\n")?;
		assert!(discards_work(root, &DISCOVERED, &stashed(&["*.log"]))?);
		Ok(())
	}

	/// The plain preview names an untracked directory as one `dir/` line, while
	/// an `-e` that keeps a file in it makes the `-x` preview list its other
	/// files one by one: the stash holds those too. An ignored file in it is
	/// not stashed.
	#[test]
	fn a_stashed_untracked_directory_keeps_the_files_in_it() -> TestResult {
		let dir = repo()?;
		let root = dir.path();
		fs::write(root.join(".gitignore"), "*.log\n")?;
		git(root, &["add", ".gitignore"])?;
		git(root, &[
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@example.com",
			"commit",
			"-qm",
			"ignore",
		])?;
		fs::create_dir(root.join("d"))?;
		fs::write(root.join("d").join("a.txt"), "x\n")?;
		fs::write(root.join("d").join("b.keep"), "x\n")?;
		let stashed = clean(CleanCheck {
			directories: true,
			include_ignored: true,
			excludes: vec!["*.keep".to_owned()],
			untracked_stashed: true,
			..CleanCheck::default()
		});
		assert!(!discards_work(root, &DISCOVERED, &stashed)?);
		fs::write(root.join("d").join("c.log"), "x\n")?;
		assert!(discards_work(root, &DISCOVERED, &stashed)?);
		Ok(())
	}
}
