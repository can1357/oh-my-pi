//! Git backend: gitoxide-powered repository operations.
//!
//! A git-CLI fallback is reserved for credential-bound network transfers
//! (push/fetch/clone) and reftable repositories, which no in-process
//! implementation can read yet.
//!
//! Repository discovery is a pure filesystem walk (no subprocess, no gix open):
//! it handles `.git` pointer files, `commondir` indirection, and reftable
//! detection, and is cheap enough for synchronous render paths.

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
/// Initialize a git repository with a worktree at `path`.
///
/// The destination directory is created when it does not exist.
pub fn init(path: &Path) -> Result<GitRepo> {
	gix::init(path).map_err(|err| Error::backend("git init", err))?;
	GitRepo::require(path)
}

/// Initialize a bare git repository at `path`.
///
/// The destination directory is created when it does not exist.
pub fn init_bare(path: &Path) -> Result<GitRepo> {
	gix::init_bare(path).map_err(|err| Error::backend("git init --bare", err))?;
	GitRepo::require(path)
}

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

	/// Whether this repository has no worktree.
	pub fn is_bare(&self) -> bool {
		self.info.repo_root == self.info.git_dir
	}

	/// Path of `dir` relative to the checkout root with a trailing slash —
	/// `git rev-parse --show-prefix` equivalent. Empty for the root itself;
	/// `None` when `dir` is outside the checkout.
	pub fn prefix_of(&self, dir: &Path) -> Option<String> {
		relative_prefix(&self.info.repo_root, dir)
	}
}
/// Discover repository metadata for `dir` without opening gitoxide.
pub fn discover_info(dir: &Path) -> Result<Option<GitRepoInfo>> {
	let mut current = std::path::absolute(dir)?;
	loop {
		if let Some(info) = resolve_bare_info(&current)? {
			return Ok(Some(info));
		}
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
fn resolve_bare_info(path: &Path) -> std::io::Result<Option<GitRepoInfo>> {
	if entry_type(path) != Some(EntryType::Directory)
		|| !path.join("HEAD").is_file()
		|| !path.join("objects").is_dir()
		|| !path.join("refs").is_dir()
		|| !path.join("config").is_file()
	{
		return Ok(None);
	}
	let config = std::fs::read_to_string(path.join("config"))?;
	let is_bare = match config_core_bare(&config) {
		Some(is_bare) => is_bare,
		None => !is_worktree_git_dir(path),
	};
	if !is_bare {
		return Ok(None);
	}
	Ok(Some(GitRepoInfo {
		repo_root:      path.to_owned(),
		git_entry_path: path.to_owned(),
		git_dir:        path.to_owned(),
		common_dir:     path.to_owned(),
		head_path:      path.join("HEAD"),
		is_reftable:    config_has_reftable(&config),
	}))
}

fn is_worktree_git_dir(path: &Path) -> bool {
	path.file_name().is_some_and(|name| name == ".git")
		&& path
			.parent()
			.is_some_and(|parent| parent.join(".git") == path)
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
fn config_core_bare(content: &str) -> Option<bool> {
	let mut in_core = false;
	for line in content.lines() {
		let line = strip_config_comment(line).trim();
		if let Some(section) = line
			.strip_prefix('[')
			.and_then(|rest| rest.strip_suffix(']'))
		{
			in_core = section.trim().eq_ignore_ascii_case("core");
			continue;
		}
		if !in_core {
			continue;
		}
		let (key, value) = line.split_once('=').unwrap_or((line, "true"));
		if !key.trim().eq_ignore_ascii_case("bare") {
			continue;
		}
		let value = value.trim().trim_matches('"');
		return match value.to_ascii_lowercase().as_str() {
			"true" | "yes" | "on" | "1" => Some(true),
			"false" | "no" | "off" | "0" => Some(false),
			_ => None,
		};
	}
	None
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
	use crate::PushOptions;
	fn run_git(root: &Path, args: &[&str]) -> String {
		let output = Command::new("git")
			.current_dir(root)
			.args(args)
			.output()
			.unwrap();
		assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
		String::from_utf8(output.stdout).unwrap()
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
	fn init_round_trips_through_discovery() {
		let temp = tempfile::tempdir().unwrap();
		let root = temp.path().join("worktree");
		let repo = init(&root).unwrap();
		assert_eq!(repo.root(), root);
		assert!(!repo.is_bare());
		assert!(root.join(".git").is_dir());

		let discovered = GitRepo::discover(&root).unwrap().unwrap();
		assert_eq!(discovered.info(), repo.info());
		assert!(!discovered.is_bare());
	}

	#[test]
	fn init_bare_round_trips_through_discovery() {
		let temp = tempfile::tempdir().unwrap();
		let root = temp.path().join("cache.git");
		let repo = init_bare(&root).unwrap();
		assert_eq!(repo.root(), root);
		assert!(repo.is_bare());

		let discovered = GitRepo::discover(&root).unwrap().unwrap();
		assert!(discovered.is_bare());
		assert_eq!(discovered.info().repo_root, root);
		assert_eq!(discovered.info().git_dir, root);
		assert_eq!(discovered.info().common_dir, root);
		assert_eq!(discovered.info().head_path, root.join("HEAD"));
	}

	#[tokio::test]
	async fn bare_repo_fetches_and_pushes_local_refs() {
		let temp = tempfile::tempdir().unwrap();
		let source_root = temp.path().join("source");
		init(&source_root).unwrap();
		run_git(&source_root, &["config", "user.name", "VCS Test"]);
		run_git(&source_root, &["config", "user.email", "vcs@example.com"]);
		fs::write(source_root.join("tracked.txt"), "tracked\n").unwrap();
		run_git(&source_root, &["add", "tracked.txt"]);
		run_git(&source_root, &["commit", "-qm", "initial"]);
		run_git(&source_root, &["branch", "-M", "main"]);
		let source_sha = run_git(&source_root, &["rev-parse", "HEAD"])
			.trim()
			.to_owned();

		let cache_root = temp.path().join("cache.git");
		let cache = init_bare(&cache_root).unwrap();
		cache
			.remote_add("origin", source_root.to_str().unwrap())
			.unwrap();
		cache
			.fetch("origin", "refs/heads/main", "refs/remotes/origin/main", None, None)
			.await
			.unwrap();
		assert_eq!(cache.resolve_ref("refs/remotes/origin/main").unwrap(), Some(source_sha.clone()));

		let sink_root = temp.path().join("sink.git");
		let sink = init_bare(&sink_root).unwrap();
		cache
			.remote_add("sink", sink_root.to_str().unwrap())
			.unwrap();
		cache
			.push(
				&PushOptions {
					remote:           Some("sink".to_owned()),
					refspec:          Some("refs/remotes/origin/main:refs/heads/main".to_owned()),
					force_with_lease: None,
				},
				None,
			)
			.await
			.unwrap();
		assert_eq!(sink.resolve_ref("refs/heads/main").unwrap(), Some(source_sha));
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
}
