//! Git backend: gitoxide-powered repository operations.
//!
//! A git-CLI fallback is reserved for credential-bound network transfers
//! (push/fetch/clone) and reftable repositories, which no in-process
//! implementation can read yet.
//!
//! Repository discovery is a pure filesystem walk (no subprocess, no gix open):
//! it mirrors the battle-tested TypeScript walk it replaces — `.git` pointer
//! files, `commondir` indirection, reftable detection — and is cheap enough for
//! synchronous render paths.

mod cli;
mod diff;
mod mutate;
mod open;
mod patch;
mod read;
use std::{
	path::{Path, PathBuf},
	sync::OnceLock,
};

pub use cli::{COMMAND_TIMEOUT, NETWORK_TIMEOUT, OUTPUT_LIMIT_BYTES, SYNC_TIMEOUT, clone};
pub use mutate::detach_git_dir;
pub use patch::{join_patches, validate_hunk_selections};

use crate::{
	error::{Error, Result},
	types::{GitRepoInfo, LinkedWorktree},
};

/// An opened git repository.
///
/// Construction is filesystem-only; the gitoxide handle is opened lazily on
/// first object/index access and shared across threads.
pub struct GitRepo {
	info:           GitRepoInfo,
	/// Lazily opened gitoxide repository. `None` until an operation needs
	/// object database, index, or config access. Never populated for reftable
	/// repositories (operations route through the CLI fallback instead).
	pub(crate) gix: OnceLock<gix::ThreadSafeRepository>,
}

impl std::fmt::Debug for GitRepo {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("GitRepo")
			.field("info", &self.info)
			.finish_non_exhaustive()
	}
}

impl GitRepo {
	/// Discover the repository containing `dir` by walking toward the root.
	///
	/// A `.git` entry only counts when its resolved git dir contains `HEAD`;
	/// unpopulated `.git` directories are skipped, as `git rev-parse` does.
	/// Returns `Ok(None)` when `dir` is outside any git repository, or when a
	/// `.git` pointer file is unreadable due to permissions (matching the
	/// historical wrapper, which treated that as "not a repo" rather than an
	/// error).
	pub fn discover(dir: &Path) -> Result<Option<Self>> {
		let Some(info) = discover_info(dir)? else {
			return Ok(None);
		};
		Ok(Some(Self { info, gix: OnceLock::new() }))
	}

	/// Like [`GitRepo::discover`], but errors with [`Error::NotARepository`]
	/// when `dir` is outside any repository.
	pub fn require(dir: &Path) -> Result<Self> {
		Self::discover(dir)?.ok_or_else(|| Error::NotARepository { path: dir.to_owned() })
	}

	/// Resolved repository metadata.
	pub const fn info(&self) -> &GitRepoInfo {
		&self.info
	}

	/// Checkout root (may be a linked worktree root).
	pub fn root(&self) -> &Path {
		&self.info.repo_root
	}

	/// Primary checkout root, or the shared common dir for bare-repo worktrees.
	pub fn primary_root(&self) -> PathBuf {
		if self
			.info
			.common_dir
			.file_name()
			.is_some_and(|name| name == ".git")
		{
			return self
				.info
				.common_dir
				.parent()
				.unwrap_or(&self.info.common_dir)
				.to_owned();
		}
		if self.is_linked_worktree() {
			return self.info.common_dir.clone();
		}
		self.info.repo_root.clone()
	}

	/// Linked-worktree metadata, or `None` for the primary checkout.
	pub fn linked_worktree(&self) -> Option<LinkedWorktree> {
		if !self.is_linked_worktree() {
			return None;
		}
		Some(LinkedWorktree {
			root:         self.info.repo_root.clone(),
			primary_root: self.primary_root(),
		})
	}

	/// Whether this checkout is a linked worktree sharing a primary repo's
	/// metadata through a `commondir` pointer file.
	pub fn is_linked_worktree(&self) -> bool {
		self.info.git_dir != self.info.common_dir && self.info.git_dir.join("commondir").is_file()
	}

	/// Whether refs live in the reftable format. Operations on such repos fall
	/// back to the git CLI for ref access.
	pub const fn is_reftable(&self) -> bool {
		self.info.is_reftable
	}

	/// Path of `dir` relative to the checkout root with a trailing slash —
	/// `git rev-parse --show-prefix` equivalent. Empty for the root itself;
	/// `None` when `dir` is outside the checkout.
	pub fn prefix_of(&self, dir: &Path) -> Option<String> {
		relative_prefix(&self.info.repo_root, dir)
	}
}

/// Pin the worktree index mtime to reproduce same-tick snapshot races in tests.
#[cfg(test)]
pub(crate) fn pin_index_mtime(repo: &GitRepo) {
	let pinned = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
	std::fs::File::options()
		.write(true)
		.open(repo.info().git_dir.join("index"))
		.expect("open index")
		.set_modified(pinned)
		.expect("pin index mtime");
}
/// Discover repository metadata for `dir` without opening gitoxide.
pub fn discover_info(dir: &Path) -> Result<Option<GitRepoInfo>> {
	let mut current = std::path::absolute(dir)?;
	loop {
		let git_entry = current.join(".git");
		if let Some(entry) = entry_type(&git_entry) {
			match resolve_info(&current, &git_entry, entry) {
				Ok(Some(info)) => return Ok(Some(info)),
				Ok(None) => {},
				Err(err)
					if entry == EntryType::File
						&& err.kind() == std::io::ErrorKind::PermissionDenied =>
				{
					return Ok(None);
				},
				Err(err) => return Err(err.into()),
			}
		}
		if !current.pop() {
			return Ok(None);
		}
	}
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EntryType {
	Directory,
	File,
}

fn entry_type(path: &Path) -> Option<EntryType> {
	let meta = std::fs::metadata(path).ok()?;
	if meta.is_dir() {
		Some(EntryType::Directory)
	} else if meta.is_file() {
		Some(EntryType::File)
	} else {
		None
	}
}

fn resolve_info(
	repo_root: &Path,
	git_entry: &Path,
	entry: EntryType,
) -> std::io::Result<Option<GitRepoInfo>> {
	let git_dir = match entry {
		EntryType::Directory => git_entry.to_owned(),
		EntryType::File => {
			let content = std::fs::read_to_string(git_entry)?;
			let Some(target) = parse_gitdir_pointer(&content) else {
				return Ok(None);
			};
			let resolved = normalize_path(&git_entry.parent().unwrap_or(repo_root).join(target));
			if entry_type(&resolved) != Some(EntryType::Directory) {
				return Ok(None);
			}
			resolved
		},
	};
	// Match git's `is_git_directory()`: a `.git` directory (or gitfile target)
	// without `HEAD` was never populated by git — typically an empty `.git`
	// planted as a walk fence or left behind by a wiped store — so it is not a
	// repository. Returning `None` keeps the walk moving toward the root, as
	// `git rev-parse` does, instead of adopting the entry and failing later
	// with a raw ENOENT on the first `HEAD` read. Checking the resolved dir
	// keeps linked worktrees and submodules valid: their `HEAD` lives there.
	if !git_dir.join("HEAD").is_file() {
		return Ok(None);
	}
	let common_dir = resolve_common_dir(&git_dir);
	let is_reftable =
		read_optional(&common_dir.join("config")).is_some_and(|config| config_has_reftable(&config));
	Ok(Some(GitRepoInfo {
		repo_root: repo_root.to_owned(),
		git_entry_path: git_entry.to_owned(),
		head_path: git_dir.join("HEAD"),
		git_dir,
		common_dir,
		is_reftable,
	}))
}

/// Parse the `gitdir: <path>` pointer written into linked-worktree `.git`
/// files.
fn parse_gitdir_pointer(content: &str) -> Option<&str> {
	let rest = content.trim().strip_prefix("gitdir:")?;
	let target = rest.trim();
	(!target.is_empty()).then_some(target)
}

fn resolve_common_dir(git_dir: &Path) -> PathBuf {
	match read_optional(&git_dir.join("commondir")) {
		Some(content) => {
			let relative = content.trim();
			if relative.is_empty() {
				git_dir.to_owned()
			} else {
				normalize_path(&git_dir.join(relative))
			}
		},
		None => git_dir.to_owned(),
	}
}

fn read_optional(path: &Path) -> Option<String> {
	std::fs::read_to_string(path).ok()
}

/// Lexically normalize `.`/`..` segments without touching the filesystem, so
/// relative `gitdir`/`commondir` pointers resolve the same way git does.
pub(crate) fn normalize_path(path: &Path) -> PathBuf {
	let mut out = PathBuf::new();
	for component in path.components() {
		match component {
			std::path::Component::CurDir => {},
			std::path::Component::ParentDir => {
				if !out.pop() {
					out.push(component);
				}
			},
			other => out.push(other),
		}
	}
	out
}
/// Return `dir` relative to `root` with a trailing slash.
pub(crate) fn relative_prefix(root: &Path, dir: &Path) -> Option<String> {
	let absolute = std::path::absolute(dir).ok()?;
	let relative = absolute.strip_prefix(root).ok()?;
	if relative.as_os_str().is_empty() {
		return Some(String::new());
	}
	let mut prefix = relative
		.to_string_lossy()
		.replace(std::path::MAIN_SEPARATOR, "/");
	prefix.push('/');
	Some(prefix)
}

/// Whether a git config file selects the reftable ref storage.
///
/// Minimal INI scan of `[extensions] refstorage`, honoring quoted values and
/// `;`/`#` comments outside quotes — enough to classify a repo without a full
/// config parser (reftable repos never reach gitoxide, so its parser is not
/// available for them by construction).
fn config_has_reftable(content: &str) -> bool {
	let mut in_extensions = false;
	for line in content.lines() {
		let line = strip_config_comment(line);
		let line = line.trim();
		if let Some(section) = line
			.strip_prefix('[')
			.and_then(|rest| rest.strip_suffix(']'))
		{
			in_extensions = section.trim().eq_ignore_ascii_case("extensions");
			continue;
		}
		if !in_extensions {
			continue;
		}
		let Some((key, value)) = line.split_once('=') else {
			continue;
		};
		if !key.trim().eq_ignore_ascii_case("refstorage") {
			continue;
		}
		let mut value = value.trim();
		if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
			value = value[1..value.len() - 1].trim();
		}
		let value = value.to_ascii_lowercase();
		if value == "reftable" || value.starts_with("reftable:") {
			return true;
		}
	}
	false
}

/// Truncate a config line at the first `;`/`#` outside double quotes.
fn strip_config_comment(line: &str) -> &str {
	let mut in_quotes = false;
	for (index, ch) in line.char_indices() {
		match ch {
			'"' => in_quotes = !in_quotes,
			';' | '#' if !in_quotes => return &line[..index],
			_ => {},
		}
	}
	line
}

#[cfg(test)]
mod tests {
	use std::{fs, process::Command};

	use super::*;

	fn run_git(root: &Path, args: &[&str]) {
		let output = Command::new("git")
			.current_dir(root)
			.args(args)
			.output()
			.unwrap();
		assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
	}

	#[test]
	fn reftable_detection_honors_quotes_and_comments() {
		assert!(config_has_reftable("[extensions]\n\trefStorage = reftable\n"));
		assert!(config_has_reftable("[extensions]\nrefstorage = \"reftable\" ; comment\n"));
		assert!(!config_has_reftable("[extensions]\nrefstorage = files\n"));
		assert!(!config_has_reftable("[core]\nrefstorage = reftable\n"));
		assert!(!config_has_reftable("[extensions]\n# refstorage = reftable\n"));
	}

	#[test]
	fn gitdir_pointer_parsing() {
		assert_eq!(
			parse_gitdir_pointer("gitdir: /a/b/.git/worktrees/x\n"),
			Some("/a/b/.git/worktrees/x")
		);
		assert_eq!(parse_gitdir_pointer("gitdir:../relative"), Some("../relative"));
		assert_eq!(parse_gitdir_pointer("not a pointer"), None);
		assert_eq!(parse_gitdir_pointer("gitdir:   "), None);
	}

	#[test]
	fn discovery_ignores_an_empty_dot_git_directory() {
		let temp = tempfile::tempdir().unwrap();
		let fence = temp.path().join("fence");
		fs::create_dir_all(fence.join(".git")).unwrap();
		let project = fence.join("project");
		fs::create_dir_all(&project).unwrap();

		// `git rev-parse` walks past a `.git` directory without `HEAD`; with no
		// repository above the temp dir, discovery must come up empty instead of
		// adopting the fence and failing later on the missing `HEAD`.
		let found = discover_info(&project).unwrap();
		assert!(found.is_none(), "unpopulated `.git` reported as a repository: {found:?}");
	}

	#[test]
	fn discovery_walks_past_an_empty_dot_git_to_the_enclosing_repository() {
		let temp = tempfile::tempdir().unwrap();
		run_git(temp.path(), &["init", "-q", "-b", "main"]);
		let fence = temp.path().join("fence");
		fs::create_dir_all(fence.join(".git")).unwrap();
		let project = fence.join("project");
		fs::create_dir_all(&project).unwrap();

		let info = discover_info(&project)
			.unwrap()
			.expect("enclosing repository");
		assert_eq!(info.repo_root, std::path::absolute(temp.path()).unwrap());
		assert_eq!(info.git_dir, info.repo_root.join(".git"));
	}

	#[test]
	fn discovery_ignores_a_gitfile_whose_target_has_no_head() {
		let temp = tempfile::tempdir().unwrap();
		let fence = temp.path().join("fence");
		let project = fence.join("project");
		fs::create_dir_all(&project).unwrap();
		fs::create_dir_all(fence.join("store")).unwrap();
		fs::write(fence.join(".git"), "gitdir: store\n").unwrap();

		let found = discover_info(&project).unwrap();
		assert!(
			found.is_none(),
			"gitfile to an unpopulated directory reported as a repository: {found:?}"
		);
	}

	#[test]
	fn discovery_accepts_a_fresh_repository_with_an_unborn_head() {
		let temp = tempfile::tempdir().unwrap();
		run_git(temp.path(), &["init", "-q", "-b", "main"]);
		let nested = temp.path().join("src");
		fs::create_dir_all(&nested).unwrap();

		let info = discover_info(&nested).unwrap().expect("primary checkout");
		let root = std::path::absolute(temp.path()).unwrap();
		assert_eq!(info.repo_root, root);
		assert_eq!(info.git_dir, root.join(".git"));
		assert_eq!(info.common_dir, info.git_dir);
		assert!(info.head_path.is_file());
		assert!(
			!GitRepo::discover(&nested)
				.unwrap()
				.unwrap()
				.is_linked_worktree()
		);
	}

	#[test]
	fn discovery_accepts_a_linked_worktree_gitfile() {
		let temp = tempfile::tempdir().unwrap();
		let main = temp.path().join("main");
		fs::create_dir_all(&main).unwrap();
		run_git(&main, &["init", "-q", "-b", "main"]);
		run_git(&main, &["config", "user.name", "VCS Test"]);
		run_git(&main, &["config", "user.email", "vcs@example.com"]);
		run_git(&main, &["commit", "-q", "--allow-empty", "-m", "init"]);
		let linked = temp.path().join("linked");
		run_git(&main, &["worktree", "add", "-q", linked.to_str().unwrap(), "-b", "wt"]);
		assert!(linked.join(".git").is_file(), "linked worktree `.git` is a gitfile");

		let info = discover_info(&linked).unwrap().expect("linked worktree");
		assert_eq!(info.repo_root, std::path::absolute(&linked).unwrap());
		assert!(info.head_path.is_file());
		assert_ne!(info.git_dir, info.common_dir);
		assert!(
			GitRepo::discover(&linked)
				.unwrap()
				.unwrap()
				.is_linked_worktree()
		);
	}
}
