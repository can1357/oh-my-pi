//! Git backend: gitoxide-powered repository operations.
//!
//! Git subprocesses are reserved for credential-bound network transfers,
//! reftable repositories, whole-worktree status/untracked walks whose resource
//! failures must stay outside the driving process, and commit signing, which
//! must use the user's configured Git signing program.
//!
//! Repository discovery is a pure filesystem walk (no subprocess, no gix open):
//! it mirrors the battle-tested TypeScript walk it replaces — `.git` pointer
//! files, `commondir` indirection, reftable detection — and is cheap enough for
//! synchronous render paths.

mod cli;
mod diff;
mod filter;
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
		// A common dir that is not literally `.git` is a relocated git dir —
		// a submodule's internal store (`<super>/.git/modules/<name>`) or a
		// `--separate-git-dir` checkout — whether reached directly or through
		// one of its linked worktrees. Prefer its explicit `core.worktree`
		// pointer, the indirection git itself follows. `--separate-git-dir`
		// alone (with no further override) writes no `core.worktree`, so a
		// direct access has no way to recover its own checkout path from the
		// common dir's config, and neither does a linked worktree of it —
		// both resolve to the common dir path itself, matching what `git
		// worktree list` itself reports for that checkout, so they still
		// agree. Bare repositories carry no `core.worktree` either, so their
		// worktrees keep collapsing on the shared common dir the same way.
		if let Some(worktree) = configured_worktree(&self.info.common_dir) {
			return worktree;
		}
		self.info.common_dir.clone()
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
///
/// The walk goes up `dir`'s real path, as git does: a shell reports the
/// directory it reached through a symbolic link (`$PWD`), whose parents as
/// spelled may lie outside the checkout the link leads into, or in another
/// one. The repository found comes back as spelled only when the spelled
/// walk reaches the same checkout root.
pub fn discover_info(dir: &Path) -> Result<Option<GitRepoInfo>> {
	let spelled = std::path::absolute(dir)?;
	let real = match std::fs::canonicalize(&spelled) {
		Ok(real) if real != spelled => real,
		_ => return walk_up(spelled),
	};
	let Some(found) = walk_up(real)? else {
		return Ok(None);
	};
	if let Ok(Some(as_spelled)) = walk_up(spelled)
		&& std::fs::canonicalize(&as_spelled.repo_root).is_ok_and(|root| root == found.repo_root)
	{
		return Ok(Some(as_spelled));
	}
	Ok(Some(found))
}

/// The repository holding `current` (an absolute path), up its parents as
/// spelled.
fn walk_up(mut current: PathBuf) -> Result<Option<GitRepoInfo>> {
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
	// Bytes, not a `String`: git does not require a config file to be UTF-8.
	let is_reftable =
		std::fs::read(common_dir.join("config")).is_ok_and(|config| config_has_reftable(&config));
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

/// Resolve a git dir's explicit `core.worktree` override to an absolute
/// path — the mechanism `git submodule` and `git init --separate-git-dir`
/// both use to point a git dir at a work tree that is not its own parent
/// directory. `None` when unset, the ordinary case.
///
/// The key comes from the files git's own repository setup reads for the
/// main worktree: the git dir's `config`, then its `config.worktree` when
/// `extensions.worktreeConfig` is on, which is where `git sparse-checkout
/// init` moves the key. Git follows neither file's `include.path` for this
/// key, so neither does this. The files go through gitoxide's config
/// parser, which opens no repository, so discovery stays a filesystem walk.
fn configured_worktree(git_dir: &Path) -> Option<PathBuf> {
	use gix::bstr::ByteSlice as _;

	let read = |name: &str, source: gix::config::Source| {
		gix::config::File::from_path_no_includes(git_dir.join(name), source).ok()
	};
	let config = read("config", gix::config::Source::Local)?;
	let worktree_config = matches!(config.boolean("extensions.worktreeConfig"), Some(Ok(true)))
		.then(|| read("config.worktree", gix::config::Source::Worktree))
		.flatten();
	let worktree = worktree_config
		.as_ref()
		.and_then(|file| file.string("core.worktree"))
		.or_else(|| config.string("core.worktree"))
		.filter(|worktree| !worktree.is_empty())?;
	// A relative value is relative to the git dir; `join` keeps an absolute one.
	Some(normalize_path(&git_dir.join(worktree.to_path_lossy())))
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
	if relative.is_empty() {
		return Some(String::new());
	}
	let mut prefix = relative
		.to_string_lossy()
		.replace(std::path::MAIN_SEPARATOR, "/");
	prefix.push('/');
	Some(prefix)
}

/// Whether a git config file selects the reftable ref storage:
/// `extensions.refStorage` is `reftable` or a `reftable:` URI, last value
/// wins, as git reads it. The file goes through gitoxide's config parser,
/// which opens no repository: a reftable repository never reaches a gitoxide
/// repository open.
fn config_has_reftable(config: &[u8]) -> bool {
	let Ok(config) = gix::config::File::from_bytes_no_includes(
		config,
		gix::config::file::Metadata::from(gix::config::Source::Local),
		gix::config::file::init::Options { lossy: true, ..Default::default() },
	) else {
		return false;
	};
	config.string("extensions.refStorage").is_some_and(|value| {
		value.eq_ignore_ascii_case(b"reftable")
			|| value
				.get(..b"reftable:".len())
				.is_some_and(|scheme| scheme.eq_ignore_ascii_case(b"reftable:"))
	})
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
		assert!(config_has_reftable(b"[extensions]\n\trefStorage = reftable\n"));
		assert!(config_has_reftable(b"[extensions]\nrefstorage = \"reftable\" ; comment\n"));
		assert!(config_has_reftable(b"[extensions]\n\trefStorage = reftable:/var/refs\n"));
		assert!(!config_has_reftable(b"[extensions]\nrefstorage = files\n"));
		assert!(!config_has_reftable(b"[core]\nrefstorage = reftable\n"));
		assert!(!config_has_reftable(b"[extensions \"x\"]\nrefstorage = reftable\n"));
		assert!(!config_has_reftable(b"[extensions]\n# refstorage = reftable\n"));
	}

	// Each `reftable_detection_matches_git_*` config below is one for which git
	// 2.43's `git config --file <config> --get extensions.refStorage` prints
	// the value the assertion expects.

	#[test]
	fn reftable_detection_matches_git_for_a_key_on_the_header_line() {
		assert!(config_has_reftable(b"[extensions] refStorage = reftable\n"));
	}

	#[test]
	fn reftable_detection_matches_git_after_a_utf8_bom() {
		assert!(config_has_reftable(b"\xef\xbb\xbf[extensions]\n\trefStorage = reftable\n"));
	}

	#[test]
	fn reftable_detection_matches_git_for_a_continued_value() {
		assert!(config_has_reftable(b"[extensions]\n\trefStorage = reft\\\nable\n"));
	}

	#[test]
	fn reftable_detection_matches_git_for_a_value_quoted_in_part() {
		assert!(config_has_reftable(b"[extensions]\n\trefStorage = reft\"able\"\n"));
	}

	#[test]
	fn reftable_detection_matches_git_for_a_config_that_is_not_utf8() {
		assert!(config_has_reftable(
			b"[extensions]\n\trefStorage = reftable\n[user]\n\tname = Ren\xe9\n"
		));
	}

	#[test]
	fn reftable_detection_matches_git_for_a_repeated_key() {
		// Git keeps the last value: `files`.
		assert!(!config_has_reftable(
			b"[extensions]\n\trefStorage = reftable\n\trefStorage = files\n"
		));
	}

	#[test]
	fn discovery_reads_reftable_from_a_config_that_is_not_utf8() {
		let temp = tempfile::tempdir().unwrap();
		let git_dir = temp.path().join(".git");
		fs::create_dir_all(&git_dir).unwrap();
		fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
		fs::write(
			git_dir.join("config"),
			b"[extensions]\n\trefStorage = reftable\n[user]\n\tname = Ren\xe9\n",
		)
		.unwrap();
		let info = discover_info(temp.path()).unwrap().expect("repository");
		assert!(info.is_reftable);
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

	#[cfg(unix)]
	#[test]
	fn discovery_follows_a_symlink_into_a_checkouts_subdirectory() {
		let temp = tempfile::tempdir().unwrap();
		let repo = temp.path().join("monorepo");
		fs::create_dir_all(repo.join("projects/app")).unwrap();
		run_git(&repo, &["init", "-q", "-b", "main"]);
		// `cd ~/app` through `~/app -> ~/monorepo/projects/app`: the shell's
		// `$PWD` keeps the link, whose parents hold no `.git`.
		let link = temp.path().join("app");
		std::os::unix::fs::symlink(repo.join("projects/app"), &link).unwrap();

		let info = discover_info(&link)
			.unwrap()
			.expect("the checkout the link leads into");
		assert_eq!(info.repo_root, fs::canonicalize(&repo).unwrap());
	}

	#[cfg(unix)]
	#[test]
	fn discovery_through_a_symlink_into_another_checkout_finds_that_checkout() {
		let temp = tempfile::tempdir().unwrap();
		let a = temp.path().join("repos/A");
		let b = temp.path().join("repos/B");
		fs::create_dir_all(&a).unwrap();
		fs::create_dir_all(b.join("subdir")).unwrap();
		run_git(&a, &["init", "-q", "-b", "main"]);
		run_git(&b, &["init", "-q", "-b", "main"]);
		// `cd /repos/A/link` through `link -> /repos/B/subdir`: the spelled
		// parents reach A, but the shell works in B, as git sees it.
		let link = a.join("link");
		std::os::unix::fs::symlink(b.join("subdir"), &link).unwrap();

		let info = discover_info(&link)
			.unwrap()
			.expect("the checkout the link leads into");
		assert_eq!(info.repo_root, fs::canonicalize(&b).unwrap());
		let info = discover_info(&a).unwrap().expect("checkout A");
		assert_eq!(
			info.repo_root,
			std::path::absolute(&a).unwrap(),
			"spelled when it is the same checkout"
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

	#[test]
	fn gix_opens_checkouts_whose_directory_name_ends_in_dot_git() {
		let temp = tempfile::tempdir().unwrap();
		let main = temp.path().join("repo.git");
		fs::create_dir_all(&main).unwrap();
		run_git(&main, &["init", "-q", "-b", "main"]);
		run_git(&main, &["config", "user.name", "VCS Test"]);
		run_git(&main, &["config", "user.email", "vcs@example.com"]);
		run_git(&main, &["commit", "-q", "--allow-empty", "-m", "init"]);
		let linked = temp.path().join("linked.git");
		run_git(&main, &["worktree", "add", "-q", linked.to_str().unwrap(), "-b", "wt"]);

		// gix treats a `*.git` path as the metadata directory itself, so the
		// checkout root must never be handed to it in place of the `.git` entry.
		for (root, git_dir) in
			[(&main, main.join(".git")), (&linked, main.join(".git/worktrees/linked.git"))]
		{
			let repo = GitRepo::discover(root).unwrap().expect("checkout");
			for opened in [repo.gix().unwrap(), repo.gix_fresh().unwrap()] {
				assert_eq!(
					fs::canonicalize(opened.git_dir()).unwrap(),
					fs::canonicalize(&git_dir).unwrap()
				);
				assert_eq!(
					fs::canonicalize(opened.workdir().expect("non-bare checkout")).unwrap(),
					fs::canonicalize(root).unwrap()
				);
				opened.head_id().expect("HEAD resolves");
			}
		}
	}

	/// `configured_worktree()` of a submodule-shaped git dir,
	/// `<temp>/super/.git/modules/sub`, whose `config` holds `config` and whose
	/// `config.worktree` holds `worktree_config` when given. The result comes
	/// back relative to `<temp>`, so `../../../x` in a config reads `super/x`.
	fn worktree_from(config: &str, worktree_config: Option<&str>) -> Option<PathBuf> {
		let temp = tempfile::tempdir().unwrap();
		let git_dir = temp.path().join("super/.git/modules/sub");
		fs::create_dir_all(&git_dir).unwrap();
		fs::write(git_dir.join("config"), config).unwrap();
		if let Some(worktree_config) = worktree_config {
			fs::write(git_dir.join("config.worktree"), worktree_config).unwrap();
		}
		let worktree = configured_worktree(&git_dir)?;
		Some(
			worktree
				.strip_prefix(temp.path())
				.map_or_else(|_| worktree.clone(), Path::to_path_buf),
		)
	}

	#[test]
	fn core_worktree_resolves_relative_to_the_git_dir() {
		// Exactly what `git submodule add` writes for a checkout at `super/sub`.
		assert_eq!(
			worktree_from("[core]\n\tbare = false\n\tworktree = ../../../sub\n", None),
			Some(PathBuf::from("super/sub"))
		);
		assert_eq!(worktree_from("[core]\n\tbare = false\n", None), None);
		#[cfg(unix)]
		assert_eq!(
			worktree_from("[core]\n\tworktree = /elsewhere/main\n", None),
			Some(PathBuf::from("/elsewhere/main"))
		);
	}

	#[test]
	fn core_worktree_repeated_key_honors_last_occurrence() {
		// Git itself applies a repeated scalar key in file order, last wins —
		// `git config --get core.worktree` on this exact text returns the
		// second value.
		assert_eq!(
			worktree_from("[core]\n\tworktree = ../../../wrong\n\tworktree = ../../../main\n", None),
			Some(PathBuf::from("super/main"))
		);
	}

	#[test]
	fn core_worktree_ignores_a_core_subsection() {
		// `[core "x"]` is section `core.x`, not `core`.
		assert_eq!(worktree_from("[core \"x\"]\n\tworktree = ../../../main\n", None), None);
	}

	#[test]
	fn core_worktree_recognizes_section_header_with_trailing_hash_comment() {
		// Git accepts a comment after a section header's closing `]` on the
		// same line. A relocated git directory (submodule, `--separate-git-dir`)
		// whose `config` was hand-edited or written with such a comment must
		// still have its `core.worktree` recognized, or the resolver falls back
		// to the common dir and a linked worktree derives a different Mnemopi
		// bank root than direct access to the same checkout.
		assert_eq!(
			worktree_from("[core] # relocated by git-submodule\n\tworktree = ../../../main\n", None),
			Some(PathBuf::from("super/main"))
		);
	}

	#[test]
	fn core_worktree_recognizes_section_header_with_trailing_semicolon_comment() {
		// Same as the `#` case above, but with git's other valid inline-comment
		// marker.
		assert_eq!(
			worktree_from("[core]; relocated by git-submodule\n\tworktree = ../../../main\n", None),
			Some(PathBuf::from("super/main"))
		);
	}

	#[test]
	fn core_worktree_recognizes_a_key_on_the_section_header_line() {
		// A key may follow the header on its own line: git 2.43's `git config
		// --file <config> --get core.worktree` returns the value for this text.
		assert_eq!(
			worktree_from("[core] worktree = ../../../main\n", None),
			Some(PathBuf::from("super/main"))
		);
	}

	#[test]
	fn core_worktree_decodes_quoted_escapes() {
		// A submodule checkout named `sub"quote` produces this literal text
		// (verified against real git 2.43): the quote is escaped, and the
		// backslash preceding it must not survive into the resolved path.
		assert_eq!(
			worktree_from("[core]\n\tworktree = \"../../../sub\\\"quote\"\n", None),
			Some(PathBuf::from(r#"super/sub"quote"#))
		);
	}

	#[test]
	fn core_worktree_decodes_unquoted_escapes() {
		// Git 2.43 writes exactly this unquoted form for a submodule checkout
		// named `sub"quote`: the embedded quote is backslash-escaped without
		// wrapping the whole value in quotes, so escape decoding must not be
		// gated on the value being fully quoted.
		assert_eq!(
			worktree_from("[core]\n\tworktree = ../../../sub\\\"quote\n", None),
			Some(PathBuf::from(r#"super/sub"quote"#))
		);
	}

	#[test]
	fn core_worktree_skips_a_leading_utf8_bom() {
		// Git skips a UTF-8 byte-order mark at the start of a config file, so
		// `git config --file <config> --get core.worktree` returns the value
		// for this text. Without skipping it the first `[core]` header goes
		// unrecognized and `primary_root()` falls back to the common dir.
		assert_eq!(
			worktree_from("\u{feff}[core]\n\tworktree = ../../../main\n", None),
			Some(PathBuf::from("super/main"))
		);
	}

	#[test]
	fn core_worktree_joins_backslash_continued_lines() {
		// A backslash at the end of a line continues the value on the next
		// line, inside or outside quotes. Git 2.43's `git config --file
		// <config> --get core.worktree` returns `../../../main` for both texts;
		// a truncated `../../../ma` would point `primary_root()` at a path that
		// does not exist.
		assert_eq!(
			worktree_from("[core]\n\tworktree = ../../../ma\\\nin\n", None),
			Some(PathBuf::from("super/main"))
		);
		assert_eq!(
			worktree_from("[core]\n\tworktree = \"../../../ma\\\nin\" # note\n", None),
			Some(PathBuf::from("super/main"))
		);
	}

	#[test]
	fn core_worktree_reads_config_worktree_only_under_the_worktree_config_extension() {
		// Git's repository setup reads `config.worktree` after `config` only
		// when `extensions.worktreeConfig` is on: `git --git-dir=<dir>
		// rev-parse --show-toplevel` (git 2.43) reports `b` for the first two
		// layouts and `a` for the third.
		let moved = "[core]\n\tworktree = ../../../b\n";
		assert_eq!(
			worktree_from("[extensions]\n\tworktreeConfig = true\n", Some(moved)),
			Some(PathBuf::from("super/b"))
		);
		assert_eq!(
			worktree_from(
				"[core]\n\tworktree = ../../../a\n[extensions]\n\tworktreeConfig = true\n",
				Some(moved)
			),
			Some(PathBuf::from("super/b"))
		);
		assert_eq!(
			worktree_from("[core]\n\tworktree = ../../../a\n", Some(moved)),
			Some(PathBuf::from("super/a"))
		);
	}

	/// Canonical `primary_root()` of the checkout containing `dir`.
	fn canonical_primary_root(dir: &Path) -> PathBuf {
		let repo = GitRepo::discover(dir).unwrap().expect("checkout");
		fs::canonicalize(repo.primary_root()).unwrap()
	}

	#[test]
	fn primary_root_of_a_submodule_and_its_worktree_survives_sparse_checkout() {
		let temp = tempfile::tempdir().unwrap();
		let source = temp.path().join("source");
		let superproject = temp.path().join("super");
		for repo in [&source, &superproject] {
			fs::create_dir_all(repo).unwrap();
			run_git(repo, &["init", "-q", "-b", "main"]);
			run_git(repo, &["config", "user.name", "VCS Test"]);
			run_git(repo, &["config", "user.email", "vcs@example.com"]);
			run_git(repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
		}
		run_git(&superproject, &[
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"add",
			"-q",
			source.to_str().unwrap(),
			"sub",
		]);
		let submodule = superproject.join("sub");
		let worktree = temp.path().join("sub-wt");
		run_git(&submodule, &["worktree", "add", "-q", "-b", "wt", worktree.to_str().unwrap()]);
		let expected = fs::canonicalize(&submodule).unwrap();
		assert_eq!(canonical_primary_root(&submodule), expected);
		assert_eq!(canonical_primary_root(&worktree), expected);

		// Git 2.36+ moves `core.worktree` into `config.worktree` here and turns
		// on `extensions.worktreeConfig`; the checkout must not resolve to the
		// internal `.git/modules/sub` store afterwards.
		run_git(&submodule, &["sparse-checkout", "init", "--cone"]);
		assert_eq!(canonical_primary_root(&submodule), expected);
		assert_eq!(canonical_primary_root(&worktree), expected);
	}

	#[test]
	fn primary_root_of_a_separate_git_dir_checkout_matches_its_worktree() {
		// `--separate-git-dir` writes no `core.worktree`, so both resolve to
		// the git dir, the root `git worktree list` reports first.
		let temp = tempfile::tempdir().unwrap();
		let checkout = temp.path().join("sep");
		let git_dir = temp.path().join("sep.git");
		run_git(temp.path(), &[
			"init",
			"-q",
			"-b",
			"main",
			&format!("--separate-git-dir={}", git_dir.display()),
			checkout.to_str().unwrap(),
		]);
		run_git(&checkout, &["config", "user.name", "VCS Test"]);
		run_git(&checkout, &["config", "user.email", "vcs@example.com"]);
		run_git(&checkout, &["commit", "-q", "--allow-empty", "-m", "init"]);
		let worktree = temp.path().join("sep-wt");
		run_git(&checkout, &["worktree", "add", "-q", "-b", "wt", worktree.to_str().unwrap()]);
		let expected = fs::canonicalize(&git_dir).unwrap();
		assert_eq!(canonical_primary_root(&checkout), expected);
		assert_eq!(canonical_primary_root(&worktree), expected);
	}
}
