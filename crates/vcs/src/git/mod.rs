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
	fs,
	io::{self, Read, Write},
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

/// Largest `HEAD` (or other one-line pointer file) read from a git dir: a
/// symbolic ref, an object id or a path.
pub(crate) const HEAD_LIMIT: u64 = 64 << 10;

/// A git-dir file name no other call or process picks:
/// `.omp-<tag>-<pid>-<time>-<n>`.
pub(crate) fn unique_file_name(tag: &str) -> String {
	use std::sync::atomic::{AtomicU64, Ordering};
	static NEXT: AtomicU64 = AtomicU64::new(0);
	let n = NEXT.fetch_add(1, Ordering::Relaxed);
	let tick = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map_or(0, |elapsed| elapsed.as_nanos());
	format!(".omp-{tag}-{}-{tick}-{n}", std::process::id())
}

/// Read a file inside a git dir, where sandboxed code can plant entries.
/// A symlink (Windows: a symlink or junction, any name-surrogate reparse
/// point) at `path` fails instead of being followed, as does anything but a
/// regular file (a FIFO opens without blocking, then fails) and content over
/// `limit` bytes. Windows reads any other reparse point (dedup, cloud
/// placeholder) through a second, normal handle on the same file. With
/// `single_link`, a file with other hard links fails too (Unix), so a
/// hardlinked host file cannot pose as one the host wrote.
pub(crate) fn read_git_file(path: &Path, limit: u64, single_link: bool) -> io::Result<Vec<u8>> {
	let (file, len) = open_git_file(path, limit, single_link)?;
	let mut bytes = Vec::with_capacity(usize::try_from(len).unwrap_or(0));
	// The file may still grow after the size check.
	file.take(limit.saturating_add(1)).read_to_end(&mut bytes)?;
	if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > limit {
		return Err(io::Error::new(io::ErrorKind::InvalidData, "is too large"));
	}
	Ok(bytes)
}

/// Open a file inside a git dir with [`read_git_file`]'s checks, for a caller
/// that reads it incrementally: the open file and its length at the check
/// (at most `limit`; the file may still grow, so bound reads by `limit`).
pub(crate) fn open_git_file(
	path: &Path,
	limit: u64,
	single_link: bool,
) -> io::Result<(fs::File, u64)> {
	let rejected = |reason: &str| io::Error::new(io::ErrorKind::InvalidData, reason.to_owned());
	let mut options = fs::OpenOptions::new();
	options.read(true);
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt;
		options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
	}
	#[cfg(windows)]
	{
		use std::os::windows::fs::OpenOptionsExt;
		options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
	}
	let file = options.open(path)?;
	// The reparse-point handle of a dedup file or cloud placeholder reads the
	// stub, not the data; those are read through a handle opened normally.
	#[cfg(windows)]
	let file = match reparse_tag(&file)? {
		None => file,
		Some(tag) if is_name_surrogate(tag) => return Err(rejected("is a link")),
		Some(_) => reopen_same_file(&file, path)?,
	};
	let metadata = file.metadata()?;
	if !metadata.is_file() {
		return Err(rejected("is not a regular file"));
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::MetadataExt;
		if single_link && metadata.nlink() != 1 {
			return Err(rejected("has other hard links"));
		}
	}
	#[cfg(not(unix))]
	let _ = single_link;
	if metadata.len() > limit {
		return Err(rejected("is too large"));
	}
	Ok((file, metadata.len()))
}

/// The reparse tag of the entry `file` was opened on (with
/// `FILE_FLAG_OPEN_REPARSE_POINT`), `None` when it is no reparse point.
#[cfg(windows)]
fn reparse_tag(file: &fs::File) -> io::Result<Option<u32>> {
	use std::os::windows::io::AsRawHandle;

	use windows_sys::Win32::Storage::FileSystem::{
		FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FileAttributeTagInfo,
		GetFileInformationByHandleEx,
	};
	let mut info = FILE_ATTRIBUTE_TAG_INFO { FileAttributes: 0, ReparseTag: 0 };
	// SAFETY: the handle is open for the duration of the call and `info` is a
	// writable `FILE_ATTRIBUTE_TAG_INFO` of the size passed.
	let ok = unsafe {
		GetFileInformationByHandleEx(
			file.as_raw_handle(),
			FileAttributeTagInfo,
			(&raw mut info).cast(),
			size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
		)
	};
	if ok == 0 {
		return Err(io::Error::last_os_error());
	}
	Ok((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0).then_some(info.ReparseTag))
}

/// Whether the reparse `tag` marks a symlink, junction or other name
/// surrogate (`IsReparseTagNameSurrogate`), one that points at another entry.
#[cfg(windows)]
const fn is_name_surrogate(tag: u32) -> bool {
	tag & 0x2000_0000 != 0
}

/// Open `path` again without `FILE_FLAG_OPEN_REPARSE_POINT`, so reads return
/// the file's data, and fail unless that handle is the same file as
/// `reparse` (volume serial and file index): an entry swapped in between
/// is not read.
#[cfg(windows)]
fn reopen_same_file(reparse: &fs::File, path: &Path) -> io::Result<fs::File> {
	let file = fs::File::open(path)?;
	if file_identity(&file)? != file_identity(reparse)? {
		return Err(io::Error::new(io::ErrorKind::InvalidData, "changed while opened"));
	}
	Ok(file)
}

/// The volume serial number and file index of the file behind `file`.
#[cfg(windows)]
fn file_identity(file: &fs::File) -> io::Result<(u32, u32, u32)> {
	use std::os::windows::io::AsRawHandle;

	use windows_sys::Win32::Storage::FileSystem::{
		BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
	};
	// SAFETY: all-zero bytes are a valid `BY_HANDLE_FILE_INFORMATION`, a
	// plain C struct of integers.
	let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
	// SAFETY: the handle is open for the duration of the call and `info` is
	// a writable `BY_HANDLE_FILE_INFORMATION`.
	if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &raw mut info) } == 0 {
		return Err(io::Error::last_os_error());
	}
	Ok((info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow))
}

/// [`read_git_file`] without a size or link-count limit, `None` when the file
/// is missing.
pub(crate) fn read_optional_file(path: &Path) -> Result<Option<Vec<u8>>> {
	match read_git_file(path, u64::MAX, false) {
		Ok(bytes) => Ok(Some(bytes)),
		Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
		Err(err) => Err(err.into()),
	}
}

/// Replace the file at `path`, inside a git dir where sandboxed code can plant
/// entries, with `bytes`: they go to a fresh `create_new` file renamed over
/// `path`. The rename swaps out whatever entry sits there, so a planted
/// symlink or hard link is replaced, never written through. A regular file
/// being replaced passes its permission bits on, as git's lockfile commit
/// does. The temporary file is removed on failure.
pub(crate) fn replace_git_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
	let name = path
		.file_name()
		.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
	let temp = path.with_file_name(unique_file_name(&name.to_string_lossy()));
	let mut file = fs::OpenOptions::new()
		.write(true)
		.create_new(true)
		.open(&temp)?;
	let written = file
		.write_all(bytes)
		.and_then(|()| keep_permissions(&file, path));
	// Closed before the rename and the cleanup: Windows blocks both on an
	// open handle.
	drop(file);
	let replaced = written.and_then(|()| fs::rename(&temp, path));
	if replaced.is_err() {
		let _ = fs::remove_file(&temp);
	}
	replaced
}

/// Give `file` the permission bits of the regular file at `path`, the one it
/// replaces (git's `chmod(lock, st_mode & 07777)`); anything else at `path`
/// leaves the default mode.
#[cfg(unix)]
fn keep_permissions(file: &fs::File, path: &Path) -> io::Result<()> {
	use std::os::unix::fs::PermissionsExt;
	match fs::symlink_metadata(path) {
		Ok(old) if old.is_file() => {
			file.set_permissions(fs::Permissions::from_mode(old.permissions().mode() & 0o7777))
		},
		_ => Ok(()),
	}
}

#[cfg(not(unix))]
#[expect(clippy::unnecessary_wraps, reason = "matches the Unix signature")]
const fn keep_permissions(_file: &fs::File, _path: &Path) -> io::Result<()> {
	Ok(())
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
		if let Some(section) = line.strip_circumfix('[', ']') {
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
		if let Some(inner) = value.strip_circumfix('"', '"') {
			value = inner.trim();
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

	#[cfg(unix)]
	#[test]
	fn read_git_file_rejects_what_contained_code_can_plant() {
		let dir = tempfile::tempdir().unwrap();
		let file = dir.path().join("file");
		fs::write(&file, "12345").unwrap();
		let invalid =
			|result: io::Result<Vec<u8>>| result.unwrap_err().kind() == io::ErrorKind::InvalidData;

		assert_eq!(read_git_file(&file, 5, true).unwrap(), b"12345");
		assert!(invalid(read_git_file(&file, 4, true)), "over the limit");

		let link = dir.path().join("link");
		std::os::unix::fs::symlink(&file, &link).unwrap();
		assert!(read_git_file(&link, 100, false).is_err(), "symlink followed");

		let hard = dir.path().join("hard");
		fs::hard_link(&file, &hard).unwrap();
		assert!(invalid(read_git_file(&file, 100, true)), "hard link accepted");
		assert_eq!(read_git_file(&file, 100, false).unwrap(), b"12345");

		assert!(invalid(read_git_file(dir.path(), 100, false)), "directory");
		let fifo = dir.path().join("fifo");
		let status = Command::new("mkfifo").arg(&fifo).status().unwrap();
		assert!(status.success());
		// Without a writer, a blocking open would never return.
		assert!(invalid(read_git_file(&fifo, 100, false)), "fifo");
	}

	#[cfg(unix)]
	#[test]
	fn replace_git_file_removes_its_temporary_file_on_failure() {
		let dir = tempfile::tempdir().unwrap();
		let busy = dir.path().join("busy");
		fs::create_dir(&busy).unwrap();
		fs::write(busy.join("inner"), "x").unwrap();

		assert!(replace_git_file(&busy, b"new").is_err());

		let names: Vec<_> = fs::read_dir(dir.path())
			.unwrap()
			.map(|entry| entry.unwrap().file_name())
			.collect();
		assert_eq!(names, ["busy"]);
	}

	/// A replaced regular file keeps its permission bits, as under git; a
	/// replaced link passes nothing on, its target's mode included.
	#[cfg(unix)]
	#[test]
	fn replace_git_file_keeps_the_mode_of_a_replaced_regular_file() {
		use std::os::unix::fs::PermissionsExt;
		let mode = |path: &Path| fs::symlink_metadata(path).unwrap().permissions().mode() & 0o7777;
		let dir = tempfile::tempdir().unwrap();
		let fresh = dir.path().join("fresh");
		replace_git_file(&fresh, b"fresh").unwrap();
		let default_mode = mode(&fresh);
		let private = 0o600;
		assert_ne!(default_mode, private, "the umask must leave room to tell them apart");

		let file = dir.path().join("config");
		fs::write(&file, "old").unwrap();
		fs::set_permissions(&file, fs::Permissions::from_mode(private)).unwrap();
		replace_git_file(&file, b"new").unwrap();
		assert_eq!(mode(&file), private);
		assert_eq!(fs::read(&file).unwrap(), b"new");

		let target = dir.path().join("target");
		fs::write(&target, "target").unwrap();
		fs::set_permissions(&target, fs::Permissions::from_mode(private)).unwrap();
		let link = dir.path().join("link");
		std::os::unix::fs::symlink(&target, &link).unwrap();
		replace_git_file(&link, b"new").unwrap();
		assert!(fs::symlink_metadata(&link).unwrap().is_file());
		assert_eq!(mode(&link), default_mode);
		assert_eq!(fs::read(&target).unwrap(), b"target");
	}
}
