//! Gitignore-format rules and the ignore-file chain walks honour.
//!
//! Semantics follow the `ignore` crate as pi has always driven it:
//!
//! - Each directory may contribute `.ignore`, `.gitignore`, and (when it has a
//!   `.git` entry) `.git/info/exclude`. For each of the three kinds the nearest
//!   directory with a matching rule decides; `.ignore` beats `.gitignore` beats
//!   the exclude file beats git's global excludes file.
//! - A walk may name one more per-directory file ([`Sources::custom`], `fd`'s
//!   `.fdignore`), which beats them all, applies in and out of repositories,
//!   and is read from every ancestor of the walk root.
//! - Exclude files above the nearest repository root (`.git` or `.jj`) are not
//!   consulted; exclude and global rules apply only inside a repository.
//!   `.gitignore` applies everywhere.
//! - Ignore files in ancestors of the walk root, up to the nearest repository
//!   root, apply too, minus any rule that would ignore the walk root itself.
//! - Within one file the last matching rule wins; `dir/` rules match only
//!   directories; `!` rules re-include.
//!
//! [`Rules`] is public for tools that load extra rule files themselves
//! (`rg --ignore-file`, `fd --ignore-file`, `.fdignore`). The chain types are
//! crate-internal: [`crate::walk`] builds one [`Frame`] per directory that
//! has ignore files and asks [`Ignorer::ignored`] about every entry.
//!
//! ```ignore
//! let rules = Rules::parse(b"target/\n*.log\n!keep.log\n");
//! assert_eq!(rules.matched(b"a/b.log", false), Match::Ignore);
//! assert_eq!(rules.matched(b"keep.log", false), Match::Whitelist);
//! ```

use std::{
	borrow::Cow,
	ffi::OsStr,
	io,
	path::{Path, PathBuf},
	sync::Arc,
};

use crate::{
	fs::{Dir, FileType, Fs, Session, Stamp},
	pattern::{Dialect, Glob},
};

/// Outcome of matching a path against rules.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Match {
	/// No rule matched.
	None,
	/// The last matching rule ignores the path.
	Ignore,
	/// The last matching rule is a `!` re-include.
	Whitelist,
}

/// Cap on how much of one ignore file is read.
const MAX_IGNORE_BYTES: u64 = 16 << 20;

/// Glob dialect of gitignore rules: an unclosed `[` is a literal.
const RULE_DIALECT: Dialect = Dialect { allow_unclosed_class: true };

#[derive(Clone, Debug)]
struct Rule {
	glob:      Glob,
	dir_only:  bool,
	whitelist: bool,
}

/// The compiled rules of one gitignore-format file.
///
/// Like the `ignore` crate,
/// parsing strips one leading BOM run, splits on `\n` or `\r\n`, skips
/// comments and invalid rules, and stops at the first line that is not valid
/// UTF-8.
#[derive(Clone, Debug, Default)]
pub struct Rules {
	rules:    Vec<Rule>,
	/// Some rule needs the full path, not just the basename.
	anchored: bool,
}

impl Rules {
	/// Compiles file contents.
	pub fn parse(data: &[u8]) -> Self {
		Self::parse_filtered(data, |_| true)
	}

	/// [`Self::parse`] keeping only lines accepted by `keep`.
	fn parse_filtered(mut data: &[u8], mut keep: impl FnMut(&str) -> bool) -> Self {
		let mut out = Self::default();
		let mut first = true;
		while !data.is_empty() {
			let raw = match memchr::memchr(b'\n', data) {
				Some(i) => {
					let line = &data[..i];
					data = &data[i + 1..];
					line.strip_suffix(b"\r").unwrap_or(line)
				},
				None => std::mem::take(&mut data),
			};
			let Ok(mut line) = std::str::from_utf8(raw) else {
				break;
			};
			if first {
				line = line.trim_start_matches('\u{feff}');
				first = false;
			}
			if !keep(line) {
				continue;
			}
			if let Some(rule) = parse_rule(line) {
				out.anchored |= !rule.glob.basename_only();
				out.rules.push(rule);
			}
		}
		out
	}

	/// Reads (at most 16 MiB of) and compiles the file at `path` through `fs`.
	pub async fn read(fs: &pi_vfs::Fs, path: &Path) -> io::Result<Self> {
		const CHUNK: usize = 64 << 10;
		let file = fs.open(path).await?;
		let mut data = Vec::new();
		while (data.len() as u64) < MAX_IGNORE_BYTES {
			let len = data.len();
			let room = usize::try_from(MAX_IGNORE_BYTES - len as u64).map_or(CHUNK, |r| r.min(CHUNK));
			data.resize(len + room, 0);
			let read = file.read_async(&mut data[len..]).await;
			data.truncate(len + read.as_ref().copied().unwrap_or(0));
			if read? == 0 {
				break;
			}
		}
		Ok(Self::parse(&data))
	}

	/// No rule survived parsing.
	pub const fn is_empty(&self) -> bool {
		self.rules.is_empty()
	}

	/// Decision of the last rule matching `path`, which is relative to the
	/// rule file's directory, `/`-separated.
	pub fn matched(&self, path: &[u8], is_dir: bool) -> Match {
		let base = memchr::memrchr(b'/', path).map_or(path, |i| &path[i + 1..]);
		for rule in self.rules.iter().rev() {
			if rule.dir_only && !is_dir {
				continue;
			}
			if rule.glob.is_match_base(path, base) {
				return if rule.whitelist {
					Match::Whitelist
				} else {
					Match::Ignore
				};
			}
		}
		Match::None
	}

	/// [`Self::matched`] for a filesystem `path` below `base`, the directory
	/// the rules are relative to; a path outside `base` is matched whole.
	pub fn matched_below(&self, base: &Path, path: &Path, is_dir: bool) -> Match {
		let rel = path
			.strip_prefix(base)
			.unwrap_or(path)
			.as_os_str()
			.as_encoded_bytes();
		if cfg!(windows) && rel.contains(&b'\\') {
			let slashed: Vec<u8> = rel
				.iter()
				.map(|&byte| if byte == b'\\' { b'/' } else { byte })
				.collect();
			return self.matched(&slashed, is_dir);
		}
		self.matched(rel, is_dir)
	}

	/// Like [`Self::matched`], then each ancestor of `path` as a directory,
	/// nearest first; the first decision wins (`ignore`'s
	/// `matched_path_or_any_parents`).
	pub fn matched_path_or_parents(&self, mut path: &[u8], is_dir: bool) -> Match {
		let mut is_dir = is_dir;
		loop {
			let m = self.matched(path, is_dir);
			if m != Match::None || path.is_empty() {
				return m;
			}
			path = &path[..memchr::memrchr(b'/', path).unwrap_or(0)];
			is_dir = true;
		}
	}
}

/// Ports `GitignoreBuilder::add_line`; `None` for comments, blank lines, and
/// invalid globs.
fn parse_rule(line: &str) -> Option<Rule> {
	if line.starts_with('#') {
		return None;
	}
	let mut line = if line.ends_with("\\ ") {
		line
	} else {
		line.trim_end()
	};
	if line.is_empty() {
		return None;
	}
	let mut whitelist = false;
	let mut absolute = false;
	if line.starts_with("\\!") || line.starts_with("\\#") {
		line = &line[1..];
	} else {
		if let Some(rest) = line.strip_prefix('!') {
			whitelist = true;
			line = rest;
		}
		if let Some(rest) = line.strip_prefix('/') {
			line = rest;
			absolute = true;
		}
	}
	let mut dir_only = false;
	if let Some(rest) = line.strip_suffix('/') {
		dir_only = true;
		line = rest.strip_suffix('\\').unwrap_or(rest);
	}
	let mut actual = if !absolute && !line.contains('/') && !line.starts_with("**/") && line != "**"
	{
		Cow::Owned(format!("**/{line}"))
	} else {
		Cow::Borrowed(line)
	};
	if actual.ends_with("/**") {
		actual.to_mut().push_str("/*");
	}
	let glob = Glob::with_dialect(&actual, RULE_DIALECT).ok()?;
	Some(Rule { glob, dir_only, whitelist })
}

/// Which ignore files a walk honours.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Sources {
	/// `.ignore`, `.gitignore`, `.git/info/exclude`, and git's global
	/// excludes file.
	pub(crate) vcs:     bool,
	/// A per-directory file above all of those (`fd`'s `.fdignore`).
	pub(crate) custom:  Option<&'static str>,
	/// Read the ignore files of the root's ancestors.
	pub(crate) parents: bool,
}

impl Sources {
	/// The sources a walk with `opts` honours; `None` when it honours none.
	pub(crate) const fn of(opts: &crate::walk::Options) -> Option<Self> {
		if !opts.gitignore && opts.ignore_file.is_none() {
			return None;
		}
		Some(Self {
			vcs:     opts.gitignore,
			custom:  opts.ignore_file,
			parents: !opts.skip_parent_ignores,
		})
	}
}

/// Which ignore-relevant names a directory listing contains.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Names(u8);

const HAS_CUSTOM: u8 = 1;
const HAS_DOT_IGNORE: u8 = 2;
const HAS_GITIGNORE: u8 = 4;
const HAS_GIT_DIR: u8 = 8;
const HAS_REPO_MARKER: u8 = 16;

/// Per-directory ignore sources after the custom one (index 0), in
/// precedence order.
const SOURCES: [&str; 4] = ["", ".ignore", ".gitignore", ".git/info/exclude"];

/// Index of `.git/info/exclude`, which applies only inside a repository.
const EXCLUDE: usize = 3;

/// Listing names that make each source worth reading: the file itself, or a
/// `.git` entry for the exclude file.
const SOURCE_FLAGS: [u8; 4] = [HAS_CUSTOM, HAS_DOT_IGNORE, HAS_GITIGNORE, HAS_GIT_DIR];

impl Names {
	/// Notes `name` (a listed entry of type `file_type`) if it is `custom`,
	/// `.ignore`, `.gitignore`, `.git`, or `.jj`.
	pub(crate) fn record(&mut self, name: &[u8], file_type: FileType, custom: Option<&str>) {
		if file_type != FileType::Dir && custom.is_some_and(|custom| custom.as_bytes() == name) {
			self.0 |= HAS_CUSTOM;
		}
		if name.len() < 3 || name[0] != b'.' {
			return;
		}
		match name {
			b".ignore" if file_type != FileType::Dir => self.0 |= HAS_DOT_IGNORE,
			b".gitignore" if file_type != FileType::Dir => self.0 |= HAS_GITIGNORE,
			b".git" => self.0 |= HAS_GIT_DIR | HAS_REPO_MARKER,
			b".jj" => self.0 |= HAS_REPO_MARKER,
			_ => {},
		}
	}

	/// The listing has none of those names.
	pub(crate) const fn is_empty(self) -> bool {
		self.0 == 0
	}

	const fn has(self, flag: u8) -> bool {
		self.0 & flag != 0
	}
}

/// One directory's compiled ignore sources (the custom file, `.ignore`,
/// `.gitignore`, `.git/info/exclude`) and, for the listing cache, the stamps
/// they were read at (default when absent).
#[derive(Clone, Debug, Default)]
pub(crate) struct DirIgnores {
	pub(crate) files:  [Option<Arc<Rules>>; 4],
	pub(crate) stamps: [Stamp; 4],
}

/// Reads up to [`MAX_IGNORE_BYTES`] of an opened file into `buf`.
async fn read_opened(
	opened: io::Result<(crate::fs::File, crate::fs::FileInfo)>,
	buf: &mut Vec<u8>,
) -> io::Result<Stamp> {
	let (mut file, info) = opened?;
	file.read_into(buf, MAX_IGNORE_BYTES).await?;
	Ok(info.stamp)
}

/// Compiled rules, or `None` when no rule survives.
fn non_empty(rules: Rules) -> Option<Arc<Rules>> {
	(!rules.is_empty()).then(|| Arc::new(rules))
}

/// Opens `.git/info/exclude` below `dir`.
async fn open_exclude(
	session: &mut Session,
	dir: &Dir,
) -> io::Result<(crate::fs::File, crate::fs::FileInfo)> {
	let git = session.open_child(dir, b".git").await?;
	let info = session.open_child(&git, b"info").await?;
	session.open_file_at(&info, b"exclude").await
}

impl DirIgnores {
	/// Reads the `sources` that `names` calls for, relative to the open `dir`;
	/// `stamped` also records their stamps.
	pub(crate) async fn load(
		session: &mut Session,
		dir: &Dir,
		names: Names,
		sources: Sources,
		stamped: bool,
	) -> Self {
		let mut out = Self::default();
		let mut buf = Vec::new();
		for (k, name) in Self::source_names(names, sources) {
			let opened = if k == EXCLUDE {
				open_exclude(session, dir).await
			} else {
				session.open_file_at(dir, name.as_bytes()).await
			};
			let Ok(stamp) = read_opened(opened, &mut buf).await else {
				continue;
			};
			if stamped {
				out.stamps[k] = stamp;
			}
			out.files[k] = non_empty(Rules::parse(&buf));
		}
		out
	}

	/// Paths (relative to the directory) of the `sources` that `names` calls
	/// for, with their indices, in precedence order; also for cache
	/// revalidation by stat.
	pub(crate) fn source_names(
		names: Names,
		sources: Sources,
	) -> impl Iterator<Item = (usize, &'static str)> {
		(0..SOURCES.len()).filter_map(move |k| {
			let name = if k == 0 {
				sources.custom?
			} else if sources.vcs {
				SOURCES[k]
			} else {
				return None;
			};
			names.has(SOURCE_FLAGS[k]).then_some((k, name))
		})
	}

	/// The frame for a directory at walk-relative `base` whose listing
	/// contained `names`; `parent` unchanged when `names` is empty.
	pub(crate) fn frame(
		&self,
		parent: Option<&Arc<Frame>>,
		names: Names,
		base: &[u8],
	) -> Option<Arc<Frame>> {
		if names.is_empty() {
			return parent.cloned();
		}
		Some(Arc::new(Frame::new(
			parent.cloned(),
			self.files.clone(),
			names.has(HAS_REPO_MARKER),
			base.into(),
			Box::default(),
		)))
	}
}

/// One directory's link in the chain of applicable ignore files; immutable
/// and shared by every descendant.
#[derive(Debug)]
pub(crate) struct Frame {
	parent:             Option<Arc<Self>>,
	/// The custom file, `.ignore`, `.gitignore`, `.git/info/exclude`.
	files:              [Option<Arc<Rules>>; 4],
	/// The frame directory relative to the walk root (empty for the root).
	base:               Box<[u8]>,
	/// For frames above the root: the walk root relative to the frame
	/// directory (decoded raw names).
	up:                 Box<[u8]>,
	/// The directory is a repository root.
	has_git:            bool,
	chain_has_matchers: bool,
	any_git:            bool,
}

impl Drop for Frame {
	/// Unlinks uniquely owned ancestors iteratively so dropping a deep chain
	/// cannot overflow the stack.
	fn drop(&mut self) {
		let mut next = self.parent.take();
		while let Some(parent) = next {
			next = match Arc::try_unwrap(parent) {
				Ok(mut frame) => frame.parent.take(),
				Err(_) => None,
			};
		}
	}
}

impl Frame {
	fn new(
		parent: Option<Arc<Self>>,
		files: [Option<Arc<Rules>>; 4],
		has_git: bool,
		base: Box<[u8]>,
		up: Box<[u8]>,
	) -> Self {
		let own = files.iter().any(Option::is_some);
		let (parent_matchers, parent_git) = parent
			.as_ref()
			.map_or((false, false), |p| (p.chain_has_matchers, p.any_git));
		Self {
			parent,
			files,
			base,
			up,
			has_git,
			chain_has_matchers: own || parent_matchers,
			any_git: has_git || parent_git,
		}
	}

	/// `rel` relative to this frame's directory. Basename-only rule files get
	/// `rel` unchanged since only its last component matters.
	fn rel_path<'a>(&'a self, rules: &Rules, rel: &'a [u8], scratch: &'a mut Vec<u8>) -> &'a [u8] {
		if !rules.anchored {
			return rel;
		}
		if !self.up.is_empty() {
			scratch.clear();
			scratch.extend_from_slice(&self.up);
			scratch.push(b'/');
			scratch.extend_from_slice(rel);
			return scratch;
		}
		if self.base.is_empty() {
			rel
		} else {
			&rel[self.base.len() + 1..]
		}
	}
}

/// Evaluates ignore chains for one walk: the global excludes file and the
/// paths it is matched against.
#[derive(Debug)]
pub(crate) struct Ignorer {
	sources: Sources,
	global:  Option<Rules>,
	/// Root of the global matcher (the process cwd), match spelling.
	cwd:     Vec<u8>,
	/// The walk root, match spelling.
	root:    Vec<u8>,
}

impl Ignorer {
	/// Loads, for `sources`, git's global excludes file (located like the
	/// `ignore` crate: `core.excludesFile` from `$GIT_CONFIG_GLOBAL`,
	/// `~/.gitconfig`, `$XDG_CONFIG_HOME/git/config`, `$GIT_CONFIG_SYSTEM` or
	/// `/etc/gitconfig`, falling back to `$XDG_CONFIG_HOME/git/ignore`) and
	/// the frames of `root`'s ancestors ([`ancestor_frames`]), everything read
	/// through `session` on `fs`. `root` is absolute in `fs`'s spelling.
	/// Returns the ignorer and the root's inherited frame.
	pub(crate) async fn new(
		session: &mut Session,
		_fs: &Fs,
		root: &Path,
		sources: Sources,
	) -> (Self, Option<Arc<Frame>>) {
		let mut buf = Vec::new();
		let cwd = std::env::current_dir().map_or_default(|cwd| match_spelling(&cwd).into_owned());
		let root_spelling = match_spelling(root).into_owned();
		let global = if sources.vcs {
			global_excludes(session, &mut buf).await
		} else {
			None
		};
		let ignorer = Self { sources, global, cwd, root: root_spelling };
		(ignorer, ancestor_frames(session, root, sources, &mut buf).await)
	}

	/// The ignore files this walk honours.
	pub(crate) const fn sources(&self) -> Sources {
		self.sources
	}

	/// Whether the entry at walk-relative `rel` is ignored by the chain
	/// ending at `frame`. `scratch` is per-worker.
	pub(crate) fn ignored(
		&self,
		frame: Option<&Frame>,
		rel: &[u8],
		is_dir: bool,
		scratch: &mut Vec<u8>,
	) -> bool {
		let Some(frame) = frame else { return false };
		let global = self.global.as_ref().filter(|_| frame.any_git);
		if !frame.chain_has_matchers && global.is_none() {
			return false;
		}
		let mut found = [Match::None; 4];
		let mut saw_git = false;
		let mut f = Some(frame);
		while let Some(cur) = f.filter(|f| f.chain_has_matchers) {
			for (k, slot) in found.iter_mut().enumerate() {
				if *slot != Match::None || (k == EXCLUDE && (!frame.any_git || saw_git)) {
					continue;
				}
				if let Some(rules) = &cur.files[k] {
					*slot = rules.matched(cur.rel_path(rules, rel, scratch), is_dir);
				}
			}
			saw_git |= cur.has_git;
			f = cur.parent.as_deref();
		}
		if let Some(m) = found.into_iter().find(|m| *m != Match::None) {
			return m == Match::Ignore;
		}
		global.is_some_and(|rules| {
			rules.matched(self.global_path(rules, rel, scratch), is_dir) == Match::Ignore
		})
	}

	/// Mirrors how the `ignore` crate strips the global matcher's root (the
	/// process working directory) from absolute candidate paths.
	fn global_path<'a>(&self, rules: &Rules, rel: &'a [u8], scratch: &'a mut Vec<u8>) -> &'a [u8] {
		if !rules.anchored {
			return rel;
		}
		scratch.clear();
		scratch.extend_from_slice(&self.root);
		if !scratch.ends_with(b"/") {
			scratch.push(b'/');
		}
		scratch.extend_from_slice(rel);
		let cwd = self.cwd.strip_suffix(b"/").unwrap_or(self.cwd.as_slice());
		let skip = match scratch.strip_prefix(cwd) {
			Some(rest) if !cwd.is_empty() && rest.first().is_none_or(|&b| b == b'/') => {
				cwd.len() + usize::from(!rest.is_empty())
			},
			_ => 0,
		};
		&scratch[skip..]
	}
}

/// Git's global excludes file, compiled; `None` when there is none or it
/// holds no rule.
async fn global_excludes(session: &mut Session, buf: &mut Vec<u8>) -> Option<Rules> {
	let GitConfigs { configs, home, fallback } = git_configs();
	let mut excludes = None;
	for config in configs.into_iter().flatten() {
		let opened = session.open_file(&config).await;
		if read_opened(opened, buf).await.is_ok()
			&& let Some(path) = parse_excludes_file(buf, home.as_deref())
		{
			excludes = Some(path);
			break;
		}
	}
	let opened = session.open_file(&excludes.or(fallback)?).await;
	read_opened(opened, buf).await.ok()?;
	Some(Rules::parse(buf)).filter(|rules| !rules.is_empty())
}

/// Spelling of an absolute path as gitignore matching sees it: URL segments
/// percent-decoded to raw names, Windows separators as `/`.
fn match_spelling(path: &Path) -> Cow<'_, [u8]> {
	let bytes = path.as_os_str().as_encoded_bytes();
	if let Some(scheme) = pi_vfs::url_scheme(path) {
		if !bytes.contains(&b'%') {
			return Cow::Borrowed(bytes);
		}
		let start = scheme.len() + 3;
		let mut out = bytes[..start].to_vec();
		for (i, segment) in bytes[start..].split(|&b| b == b'/').enumerate() {
			if i > 0 {
				out.push(b'/');
			}
			// SAFETY: `segment` lies between ASCII `/` bytes (or the ASCII
			// `scheme://` prefix and the end) of `path`'s encoded bytes, which are
			// valid `OsStr` split points.
			let segment = unsafe { OsStr::from_encoded_bytes_unchecked(segment) };
			out.extend_from_slice(pi_vfs::decode_segment(segment).as_encoded_bytes());
		}
		return Cow::Owned(out);
	}
	if cfg!(windows) && bytes.contains(&b'\\') {
		return Cow::Owned(
			bytes
				.iter()
				.map(|&b| if b == b'\\' { b'/' } else { b })
				.collect(),
		);
	}
	Cow::Borrowed(bytes)
}

/// Frames for `root`'s ancestors, outermost first, minus rules that would
/// ignore `root`: the custom file of every ancestor, and the version-control
/// sources of the ancestors up to the nearest repository root (none when no
/// ancestor is one). `None` without `sources.parents` or any such file.
async fn ancestor_frames(
	session: &mut Session,
	root: &Path,
	sources: Sources,
	buf: &mut Vec<u8>,
) -> Option<Arc<Frame>> {
	async fn exists(session: &mut Session, dir: &Path, name: &str) -> bool {
		session
			.stat(&pi_vfs::child_path(dir, OsStr::new(name)), true)
			.await
			.is_ok()
	}
	if !sources.parents {
		return None;
	}
	// (ancestor, root relative to it).
	let mut ancestors: Vec<(&Path, Vec<u8>)> = Vec::new();
	let mut up: Vec<u8> = Vec::new();
	let mut repo = None;
	let mut cur = root;
	while let Some(parent) = pi_vfs::parent_path(cur) {
		let Some(name) = pi_vfs::file_name(cur) else {
			break;
		};
		let mut next = name.as_encoded_bytes().to_vec();
		if !up.is_empty() {
			next.push(b'/');
			next.extend_from_slice(&up);
		}
		up = next;
		ancestors.push((parent, up.clone()));
		if sources.vcs
			&& repo.is_none()
			&& (exists(session, parent, ".git").await || exists(session, parent, ".jj").await)
		{
			repo = Some(ancestors.len() - 1);
			// Only the custom file applies above the repository.
			if sources.custom.is_none() {
				break;
			}
		}
		cur = parent;
	}
	let mut frame: Option<Arc<Frame>> = None;
	for (i, (dir, up)) in ancestors.iter().enumerate().rev() {
		let has_git = repo == Some(i);
		let vcs = repo.is_some_and(|repo| i <= repo);
		let mut files: [Option<Arc<Rules>>; 4] = Default::default();
		if let Some(custom) = sources.custom {
			files[0] = load_ancestor(session, dir, custom, up, buf).await;
		}
		for k in 1..SOURCES.len() {
			if vcs && (k != EXCLUDE || has_git) {
				files[k] = load_ancestor(session, dir, SOURCES[k], up, buf).await;
			}
		}
		if has_git || files.iter().any(Option::is_some) {
			let up = up.as_slice().into();
			frame = Some(Arc::new(Frame::new(frame, files, has_git, Box::default(), up)));
		}
	}
	frame
}

/// Reads and compiles the rule file `rel` of ancestor `dir` (see
/// [`ancestor_rules`]).
async fn load_ancestor(
	session: &mut Session,
	dir: &Path,
	rel: &str,
	up: &[u8],
	buf: &mut Vec<u8>,
) -> Option<Arc<Rules>> {
	let path = pi_vfs::join_path(dir, Path::new(rel));
	let opened = session.open_file(&path).await;
	read_opened(opened, buf).await.ok()?;
	ancestor_rules(buf, up)
}

/// Compiles an ancestor's rule file, dropping rules that would ignore the
/// walk root at `up` (relative to the ancestor).
fn ancestor_rules(data: &[u8], up: &[u8]) -> Option<Arc<Rules>> {
	let rules = Rules::parse(data);
	if rules.matched_path_or_parents(up, true) != Match::Ignore {
		return non_empty(rules);
	}
	non_empty(Rules::parse_filtered(data, |line| {
		parse_rule(line).is_none_or(|rule| {
			let single = Rules { anchored: !rule.glob.basename_only(), rules: vec![rule] };
			single.matched_path_or_parents(up, true) != Match::Ignore
		})
	}))
}

/// Where git looks for `core.excludesFile`.
struct GitConfigs {
	/// Config files in precedence order (first `excludesFile` wins).
	configs:  [Option<PathBuf>; 4],
	/// The home directory `~` expands to.
	home:     Option<PathBuf>,
	/// The excludes file when no config names one.
	fallback: Option<PathBuf>,
}

/// Git's config files (`$GIT_CONFIG_GLOBAL`, `~/.gitconfig`,
/// `$XDG_CONFIG_HOME/git/config`, `$GIT_CONFIG_SYSTEM` or `/etc/gitconfig`)
/// and the `$XDG_CONFIG_HOME/git/ignore` fallback.
fn git_configs() -> GitConfigs {
	let env_path = |name: &str| {
		std::env::var_os(name)
			.filter(|v| !v.is_empty())
			.map(PathBuf::from)
	};
	#[allow(deprecated, reason = "matches the ignore crate's home directory lookup")]
	let home = std::env::home_dir();
	let config_home =
		env_path("XDG_CONFIG_HOME").or_else(|| home.as_ref().map(|h| h.join(".config")));
	let configs = [
		env_path("GIT_CONFIG_GLOBAL"),
		home.as_ref().map(|h| h.join(".gitconfig")),
		config_home.as_ref().map(|d| d.join("git/config")),
		Some(env_path("GIT_CONFIG_SYSTEM").unwrap_or_else(|| PathBuf::from("/etc/gitconfig"))),
	];
	GitConfigs { configs, home, fallback: config_home.map(|d| d.join("git/ignore")) }
}

/// Extracts `core.excludesFile` from raw git config contents: byte-for-byte
/// the `ignore` crate's lazy
/// `(?im-u)^\s*excludesfile\s*=\s*"?\s*(\S+?)\s*"?\s*$` (first match wins),
/// then every `~` replaced with the home directory.
fn parse_excludes_file(data: &[u8], home: Option<&Path>) -> Option<PathBuf> {
	const KEY: &[u8] = b"excludesfile";
	let is_space = |b: u8| matches!(b, b'\t' | b'\n' | 0x0b | 0x0c | b'\r' | b' ');
	let skip_space = |mut i: usize| {
		while data.get(i).is_some_and(|&b| is_space(b)) {
			i += 1;
		}
		i
	};
	let ends_line = |i: usize| {
		let end = skip_space(i);
		end == data.len() || data[i..end].contains(&b'\n')
	};
	let tail_matches = |i: usize| {
		let quote = skip_space(i);
		ends_line(i) || (data.get(quote) == Some(&b'"') && ends_line(quote + 1))
	};
	let capture_at = |start: usize| {
		let mut end = start;
		while data.get(end).is_some_and(|&b| !is_space(b)) {
			end += 1;
			if tail_matches(end) {
				return Some(&data[start..end]);
			}
		}
		None
	};
	let mut line_starts = std::iter::once(0).chain(memchr::memchr_iter(b'\n', data).map(|i| i + 1));
	let value = line_starts.find_map(|start| {
		let key_start = skip_space(start);
		let key = data.get(key_start..key_start + KEY.len())?;
		if !key.eq_ignore_ascii_case(KEY) {
			return None;
		}
		let equals = skip_space(key_start + KEY.len());
		if data.get(equals) != Some(&b'=') {
			return None;
		}
		let value_start = skip_space(equals + 1);
		(data.get(value_start) == Some(&b'"'))
			.then(|| capture_at(skip_space(value_start + 1)))
			.flatten()
			.or_else(|| capture_at(value_start))
	})?;
	let value = std::str::from_utf8(value).ok()?;
	Some(PathBuf::from(match home {
		Some(home) => value.replace('~', &home.to_string_lossy()),
		None => value.to_owned(),
	}))
}

#[cfg(test)]
mod tests;
