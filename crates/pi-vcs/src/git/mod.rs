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

/// Resolve a git dir's explicit `core.worktree` override to an absolute
/// path — the mechanism `git submodule` and `git init --separate-git-dir`
/// both use to point a git dir at a work tree that is not its own parent
/// directory. `None` when unset, the ordinary case. Read textually: the
/// discovery paths this serves must stay gix-free.
fn configured_worktree(git_dir: &Path) -> Option<PathBuf> {
	let content = read_optional(&git_dir.join("config"))?;
	let worktree = parse_core_worktree(&content)?;
	let path = Path::new(&worktree);
	if path.is_absolute() {
		Some(normalize_path(path))
	} else {
		Some(normalize_path(&git_dir.join(path)))
	}
}

/// Parse `core.worktree` out of git-config text. Sections and keys compare
/// case-insensitively; subsections (`[core "x"]`) never match; git's
/// backslash escapes decode regardless of whether the value is quoted, and
/// an unquoted `#`/`;` starts a trailing comment. Scans the whole file and
/// keeps the last assignment seen — git's own precedence for a repeated
/// scalar key — rather than stopping at the first match.
fn parse_core_worktree(content: &str) -> Option<String> {
	let mut in_core = false;
	let mut worktree = None;
	for raw in content.lines() {
		let line = raw.trim();
		if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
			continue;
		}
		if let Some(section) = line.strip_prefix('[') {
			in_core = section
				.strip_suffix(']')
				.is_some_and(|name| name.trim().eq_ignore_ascii_case("core"));
			continue;
		}
		if !in_core {
			continue;
		}
		let Some((key, value)) = line.split_once('=') else {
			continue;
		};
		if !key.trim().eq_ignore_ascii_case("worktree") {
			continue;
		}
		let value = decode_config_value(value.trim());
		worktree = if value.is_empty() { None } else { Some(value) };
	}
	worktree
}

/// Decode a `core.worktree` value per git's config value grammar: a double
/// quote toggles a verbatim region that may contain leading/trailing
/// whitespace and `#`/`;` literally, and — inside or outside quotes — a
/// backslash escapes the following character: `\"` and `\\` for the quote
/// and backslash themselves, `\n`/`\t`/`\b` for the named control
/// characters, and any other `\x` drops the backslash and keeps `x`
/// literally, matching git's own parser. Git 2.43 writes a submodule's
/// `core.worktree` unquoted with the quote character backslash-escaped
/// (`worktree = ../../../sub\"quote`) whenever the path only needs that one
/// escape, so escape decoding cannot be gated on the value being quoted.
/// An unescaped `#`/`;` outside quotes starts a trailing comment; unquoted
/// trailing whitespace before it (or before end of value) is trimmed, same
/// as git, while whitespace inside quotes is kept.
fn decode_config_value(value: &str) -> String {
	let mut out = String::with_capacity(value.len());
	let mut chars = value.chars();
	let mut quoted = false;
	let mut trim_from: Option<usize> = None;
	while let Some(ch) = chars.next() {
		match ch {
			'"' => {
				quoted = !quoted;
				trim_from = None;
			},
			'\\' => {
				trim_from = None;
				match chars.next() {
					Some('n') => out.push('\n'),
					Some('t') => out.push('\t'),
					Some('b') => out.push('\u{8}'),
					Some(escaped) => out.push(escaped),
					None => {},
				}
			},
			'#' | ';' if !quoted => break,
			ch if !quoted && ch.is_whitespace() => {
				trim_from.get_or_insert(out.len());
				out.push(ch);
			},
			ch => {
				trim_from = None;
				out.push(ch);
			},
		}
	}
	if let Some(index) = trim_from {
		out.truncate(index);
	}
	out
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
	use super::*;

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
	fn core_worktree_repeated_key_honors_last_occurrence() {
		// Git itself applies a repeated scalar key in file order, last wins —
		// `git config --get core.worktree` on this exact text returns `/main`.
		assert_eq!(
			parse_core_worktree("[core]\n\tworktree = /wrong\n\tworktree = /main\n"),
			Some("/main".to_owned())
		);
	}

	#[test]
	fn core_worktree_decodes_quoted_escapes() {
		// A submodule checkout named `sub"quote` produces this literal text
		// (verified against real git 2.43): the quote is escaped, and the
		// backslash preceding it must not survive into the resolved path.
		assert_eq!(
			parse_core_worktree("[core]\n\tworktree = \"../../../sub\\\"quote\"\n"),
			Some(r#"../../../sub"quote"#.to_owned())
		);
	}

	#[test]
	fn core_worktree_decodes_unquoted_escapes() {
		// Git 2.43 writes exactly this unquoted form for a submodule checkout
		// named `sub"quote`: the embedded quote is backslash-escaped without
		// wrapping the whole value in quotes, so escape decoding must not be
		// gated on the value being fully quoted.
		assert_eq!(
			parse_core_worktree("[core]\n\tworktree = ../../../sub\\\"quote\n"),
			Some(r#"../../../sub"quote"#.to_owned())
		);
	}
}
