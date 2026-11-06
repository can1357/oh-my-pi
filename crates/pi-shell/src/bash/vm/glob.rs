//! Pathname expansion: a port of bash's `glob_filename` and `glob_vector`
//! (lib/glob/glob.c) over [`Fs`](crate::bash::Fs), with `GLOBSORT`,
//! `GLOBIGNORE`, `nullglob` and `failglob` from pathexp.c and subst.c.
//!
//! The port itself is pure: it reads directory listings and `stat`s from a
//! table of answers. A question it has no answer for is noted and treated
//! as a failure, and the run's result is discarded; the walk then asks the
//! file system every noted question (each may answer `Pending`, parking the
//! op) and runs the port again. Every question is asked once per walk, and
//! the number of runs is bounded by the directory depth the pattern
//! reaches. Fs calls here only read, so after a restore the walk simply
//! starts over.

use std::{
	collections::VecDeque,
	task::{Context, Poll},
};

use bstr::{BStr, BString};
use hashbrown::HashMap;

use super::{
	Cx,
	exec::Flow,
	probe::absolute,
	proc::{Live, Probe, ProbeResult, Scratch, Vproc},
	state,
};
use crate::bash::{
	diag::Diag,
	event::WaitKey,
	fs::{FsOp, FsPoll, Stat, StatKind},
	pattern::{
		PatOpts, Pattern,
		glob::{SkipOpts, dirscan, glob_pattern_p, skipname},
	},
	store::OptId,
};

/// What `GLOBSORT` sorts matches by.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SortKey {
	/// Byte order of the names (bash's default and `name`).
	#[default]
	Name,
	/// File size.
	Size,
	/// Modification time.
	Mtime,
	/// Access time.
	Atime,
	/// Status-change time.
	Ctime,
	/// Allocated 512-byte blocks.
	Blocks,
	/// Names that are all digits first, by value; the rest by name.
	Numeric,
	/// Directory order (`nosort`).
	Unsorted,
}

/// The order `GLOBSORT` selects.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GlobSort {
	/// The key.
	pub key:     SortKey,
	/// A leading `-`: descending.
	pub reverse: bool,
}

impl GlobSort {
	/// bash's `setup_globsort` for `GLOBSORT`'s value: an optional `+` or
	/// `-` (descending), then a key name; a bare sign means `name`, and an
	/// unknown key the default ascending name order.
	pub fn parse(value: Option<&[u8]>) -> Self {
		let Some(value) = value.filter(|v| !v.is_empty()) else {
			return Self::default();
		};
		let start = value
			.iter()
			.position(|&c| c != b' ' && c != b'\t')
			.unwrap_or(value.len());
		let value = &value[start..];
		let (reverse, name) = match value.first() {
			Some(b'+') => (false, &value[1..]),
			Some(b'-') => (true, &value[1..]),
			_ => (false, value),
		};
		let key = match name {
			b"" | b"name" => SortKey::Name,
			b"size" => SortKey::Size,
			b"mtime" => SortKey::Mtime,
			b"atime" => SortKey::Atime,
			b"ctime" => SortKey::Ctime,
			b"blocks" => SortKey::Blocks,
			b"numeric" => SortKey::Numeric,
			b"nosort" => SortKey::Unsorted,
			_ => return Self::default(),
		};
		Self { key, reverse }
	}
}

/// Options of one pathname expansion.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GlobOpts {
	/// `shopt -s dotglob` (or a non-empty `GLOBIGNORE`): wildcards match a
	/// leading `.`.
	pub dotglob:  bool,
	/// `shopt -s nocaseglob`.
	pub nocase:   bool,
	/// `shopt -s extglob`.
	pub extglob:  bool,
	/// `shopt -s globstar`: `**` as a whole component matches any depth.
	pub globstar: bool,
	/// `shopt -s globskipdots` (default on): `.` and `..` never match.
	pub skipdots: bool,
	/// The locale is UTF-8: names match by character.
	pub utf8:     bool,
	/// `GLOBSORT`.
	pub sort:     GlobSort,
}

/// bash's `unquoted_glob_pattern_p`: whether a field (quoted characters
/// backslash-escaped) needs pathname expansion. A `[` counts only with a
/// later `]` in the same path component.
pub fn has_meta(word: &[u8], extglob: bool) -> bool {
	let mut open = false;
	let mut i = 0;
	while let Some(&c) = word.get(i) {
		i += 1;
		match c {
			b'?' | b'*' => return true,
			b'[' => open = true,
			b']' if open => return true,
			b'/' => open = false,
			b'+' | b'@' | b'!' if extglob && word.get(i) == Some(&b'(') => return true,
			b'\\' => {
				if i == word.len() {
					return false;
				}
				i += 1;
			},
			_ => {},
		}
	}
	false
}

/// bash's `udequote_pathname`: backslashes removed (a final one too).
fn dequote(pat: &[u8]) -> BString {
	let mut out = Vec::with_capacity(pat.len());
	let mut i = 0;
	while i < pat.len() {
		if pat[i] == b'\\' {
			i += 1;
		}
		if let Some(&c) = pat.get(i) {
			out.push(c);
		}
		i += 1;
	}
	BString::from(out)
}

/// A question for the file system.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum Ask {
	/// The names in a directory (`.` and `..` included, as `readdir`).
	List(BString),
	/// `stat` (`follow`) or `lstat` of a path.
	Stat { path: BString, follow: bool },
}

/// The file system's answer.
pub(super) enum Fact {
	/// The names, or `None` if the directory cannot be read.
	List(Option<Vec<BString>>),
	/// The metadata, or `None` if the path does not resolve.
	Stat(Option<Stat>),
}

/// The in-flight state of a walk (transient; restarts after a restore).
pub struct Walk {
	pattern: BString,
	facts:   HashMap<Ask, Fact>,
	/// Questions still to ask, the first one in flight.
	asking:  VecDeque<Ask>,
	/// Names read so far for an in-flight [`Ask::List`].
	names:   Vec<BString>,
}

impl Walk {
	/// A walk over `pattern` (quoted characters backslash-escaped).
	pub fn new(pattern: &[u8]) -> Self {
		Self {
			pattern: pattern.into(),
			facts:   HashMap::new(),
			asking:  VecDeque::new(),
			names:   Vec::new(),
		}
	}

	/// Advance; `Ok(paths)` (in `GLOBSORT` order; empty: no match) when
	/// done, `Err(key)` while an fs call is pending.
	pub fn poll(
		&mut self,
		tcx: &mut Context<'_>,
		cx: &mut Cx<'_>,
		sc: &mut Scratch,
		cwd: &[u8],
		opts: GlobOpts,
	) -> Result<Vec<BString>, WaitKey> {
		loop {
			while let Some(ask) = self.asking.front() {
				let fact = answer(ask, &mut self.names, tcx, cx, sc, cwd)?;
				let ask = self.asking.pop_front().expect("asked");
				self.facts.insert(ask, fact);
			}
			let mut run = Run { facts: &self.facts, missing: Vec::new(), opts };
			let found = run.filename(&self.pattern, if opts.globstar { GLOBSTAR } else { 0 });
			let paths = found.map(|paths| run.sort(paths));
			if run.missing.is_empty() {
				return Ok(paths.unwrap_or_default());
			}
			self.asking.extend(run.missing);
		}
	}
}

/// Ask the file system `ask`; `Err` while the call is pending (its future or
/// listing waits in `sc.live`, the names read so far in `names`).
pub(super) fn answer(
	ask: &Ask,
	names: &mut Vec<BString>,
	tcx: &mut Context<'_>,
	cx: &mut Cx<'_>,
	sc: &mut Scratch,
	cwd: &[u8],
) -> Result<Fact, WaitKey> {
	match ask {
		Ask::Stat { path, follow } => {
			let abs = absolute(cwd, path);
			let polled = match &mut sc.live {
				Live::Stat(f) => f.poll(tcx),
				_ => match cx.host.fs().stat(BStr::new(&abs), *follow) {
					FsPoll::Ready(r) => Poll::Ready(r),
					FsPoll::Pending(mut f) => {
						let r = f.poll(tcx);
						if r.is_pending() {
							sc.live = Live::Stat(f);
						}
						r
					},
				},
			};
			let Poll::Ready(r) = polled else {
				return Err(WaitKey::Fs { op: FsOp::Stat, path: abs });
			};
			sc.live = Live::None;
			Ok(Fact::Stat(r.ok()))
		},
		Ask::List(dir) => {
			let abs = absolute(cwd, dir);
			let pending = || WaitKey::Fs { op: FsOp::ReadDir, path: abs.clone() };
			loop {
				match &mut sc.live {
					Live::Dir(it) => match it.poll_next(tcx) {
						Poll::Ready(Some(Ok(e))) => names.push(e.name),
						// A failed entry ends the listing, as `readdir` does.
						Poll::Ready(Some(Err(_)) | None) => break,
						Poll::Pending => return Err(pending()),
					},
					Live::OpenDir(f) => match f.poll(tcx) {
						Poll::Ready(Ok(it)) => sc.live = Live::Dir(it),
						Poll::Ready(Err(_)) => {
							sc.live = Live::None;
							return Ok(Fact::List(None));
						},
						Poll::Pending => return Err(pending()),
					},
					_ => match cx.host.fs().read_dir(BStr::new(&abs)) {
						FsPoll::Ready(Ok(it)) => {
							names.clear();
							sc.live = Live::Dir(it);
						},
						FsPoll::Ready(Err(_)) => return Ok(Fact::List(None)),
						FsPoll::Pending(f) => {
							names.clear();
							sc.live = Live::OpenDir(f);
						},
					},
				}
			}
			sc.live = Live::None;
			// `readdir` lists `.` and `..`; the `Fs` listing does not.
			let mut list = Vec::with_capacity(names.len() + 2);
			list.extend([BString::from("."), BString::from("..")]);
			list.extend(
				names
					.drain(..)
					.filter(|n| !matches!(n.as_slice(), b"." | b"..")),
			);
			Ok(Fact::List(Some(list)))
		},
	}
}

// glob.c's `GX_*` flags the shell uses.
/// `GX_ALLDIRS`: every name below the directory (`**`).
const ALLDIRS: u32 = 0x010;
/// `GX_NULLDIR`: no directory precedes the pattern.
const NULLDIR: u32 = 0x100;
/// `GX_ADDCURDIR`: the directory itself is a match too.
const ADDCURDIR: u32 = 0x200;
/// `GX_GLOBSTAR`: `globstar` is on.
const GLOBSTAR: u32 = 0x400;

/// What `glob_testdir` found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DirTest {
	Dir,
	/// A symbolic link (only when not following links).
	Symlink,
	Other,
}

/// One run of the port over the answers known so far.
struct Run<'a> {
	facts:   &'a HashMap<Ask, Fact>,
	/// Questions the run needed but had no answer for.
	missing: Vec<Ask>,
	opts:    GlobOpts,
}

/// `glob_dir_to_array`: `dir` prefixed to every name (a directory
/// separator added unless `dir` ends in one; an empty name gives the
/// directory with that separator).
fn dir_to_array(dir: &[u8], names: Vec<BString>) -> Vec<BString> {
	if dir.is_empty() {
		return names;
	}
	let slash = !dir.ends_with(b"/");
	names
		.into_iter()
		.map(|name| {
			let mut p = BString::from(dir);
			if slash {
				p.push(b'/');
			}
			p.extend_from_slice(&name);
			p
		})
		.collect()
}

/// `sh_makepath(dir, name, MP_RMDOT [| MP_IGNDOT])`: an empty directory is
/// `.`; with `igndot`, a directory of `.` adds nothing.
fn makepath(dir: &[u8], name: &[u8], igndot: bool) -> BString {
	let dir: &[u8] = if dir.is_empty() {
		b"."
	} else if igndot && matches!(dir, b"." | b"./") {
		b""
	} else {
		dir
	};
	let mut p = BString::from(dir);
	if !p.is_empty() && !p.ends_with(b"/") {
		p.push(b'/');
	}
	p.extend_from_slice(name);
	p
}

/// `dir` starts with a `**` component.
const fn starstar_at(d: &[u8]) -> bool {
	matches!(d, [b'*', b'*', b'/', ..] | [b'*', b'*'])
}

impl<'a> Run<'a> {
	fn ask(&mut self, ask: Ask) -> Option<&'a Fact> {
		let fact = self.facts.get(&ask);
		if fact.is_none() && !self.missing.contains(&ask) {
			self.missing.push(ask);
		}
		fact
	}

	fn list(&mut self, dir: &[u8]) -> Option<&'a [BString]> {
		match self.ask(Ask::List(dir.into())) {
			Some(Fact::List(names)) => names.as_deref(),
			_ => None,
		}
	}

	fn stat(&mut self, path: &[u8], follow: bool) -> Option<Stat> {
		// `stat("")` fails (ENOENT); the cwd-relative path would not.
		if path.is_empty() {
			return None;
		}
		match self.ask(Ask::Stat { path: path.into(), follow }) {
			Some(Fact::Stat(st)) => *st,
			_ => None,
		}
	}

	/// `glob_testdir`; `lstat` does not follow a final symbolic link.
	fn testdir(&mut self, dir: &[u8], lstat: bool) -> DirTest {
		match self.stat(dir, !lstat).map(|st| st.kind) {
			Some(StatKind::Dir) => DirTest::Dir,
			Some(StatKind::Symlink) => DirTest::Symlink,
			_ => DirTest::Other,
		}
	}

	/// `glob_vector`: the names in `dir` that `pat` (one component)
	/// matches, in bash's list order; `None` when `dir` cannot be read.
	fn vector(&mut self, pat: &[u8], dir: &[u8], flags: u32) -> Option<Vec<BString>> {
		if pat.is_empty() {
			return (self.testdir(dir, false) == DirTest::Dir).then(|| vec![BString::default()]);
		}
		if !glob_pattern_p(pat) {
			if self.testdir(dir, false) != DirTest::Dir {
				return None;
			}
			let name = dequote(pat);
			let mut path = BString::from(dir);
			path.push(b'/');
			path.extend_from_slice(&name);
			return Some(if self.stat(&path, false).is_some() {
				vec![name]
			} else {
				Vec::new()
			});
		}
		let names = self.list(dir)?;
		let o = self.opts;
		let pattern =
			Pattern::compile(pat, PatOpts::shell(o.extglob, o.nocase, o.utf8).in_pathname(o.dotglob));
		let skip = SkipOpts { dotglob: o.dotglob, skipdots: o.skipdots };
		// bash prepends every match to its list.
		let mut out = VecDeque::new();
		for name in names {
			if skipname(pat, name, skip) {
				continue;
			}
			if flags & ALLDIRS != 0 {
				let sub = makepath(dir, name, flags & NULLDIR != 0);
				if self.testdir(&sub, true) == DirTest::Dir
					&& let Some(below) = self.vector(pat, &sub, flags & !ADDCURDIR)
				{
					for path in below {
						out.push_front(path);
					}
				}
				out.push_front(sub);
			} else if pattern.matches(name) {
				out.push_front(name.clone());
			}
		}
		if flags & (ALLDIRS | ADDCURDIR) == ALLDIRS | ADDCURDIR {
			out.push_front(if flags & NULLDIR != 0 {
				BString::default()
			} else {
				dir.into()
			});
		}
		Some(out.into())
	}

	/// `glob_filename`: the paths `pathname` matches; `None` is bash's
	/// `glob_error_return` (a directory part that does not exist).
	fn filename(&mut self, pathname: &[u8], flags: u32) -> Option<Vec<BString>> {
		let slash = if self.opts.extglob && pathname.contains(&b'/') {
			dirscan(pathname)
		} else {
			pathname.iter().rposition(|&c| c == b'/')
		};
		let (dirname, filename): (&[u8], &[u8]) = match slash {
			Some(i) => (&pathname[..=i], &pathname[i + 1..]),
			None => (b"", pathname),
		};
		if dirname.is_empty() || !glob_pattern_p(dirname) {
			return self.only_filename(dirname, filename, flags);
		}
		// The directory part has a pattern: glob it first.
		let mut d = dirname;
		let mut dflags = flags;
		let mut all_starstar = false;
		if flags & GLOBSTAR != 0 && starstar_at(d) {
			// Collapse leading `**/**/…` to the last `**/`.
			let (mut last, mut at) = (0, 0);
			while starstar_at(&d[at..]) {
				last = at;
				if d.len() <= at + 2 {
					break;
				}
				at += 3;
				while d.get(at) == Some(&b'/') {
					at += 1;
				}
				if at >= d.len() {
					break;
				}
			}
			all_starstar = at >= d.len();
			d = &d[last..];
			dflags |= ALLDIRS | ADDCURDIR;
		}
		let mut dlen = d.len();
		let mut last_starstar = false;
		if flags & GLOBSTAR != 0 && !all_starstar {
			// Collapse a trailing `/**/**/` to one `/**/`.
			let (mut dl, mut prev) = (dlen, dlen);
			while dl >= 4 && &d[dl - 4..dl] == b"/**/" {
				prev = dl;
				dl -= 3;
			}
			last_starstar = dl != dlen;
			dlen = prev;
		}
		if last_starstar && dlen > 4 && filename == b"**" {
			dlen -= 3;
		}
		let d = if d[dlen - 1] == b'/' {
			&d[..dlen - 1]
		} else {
			&d[..dlen]
		};
		let directories = self.filename(d, dflags)?;
		if directories.is_empty() {
			return None;
		}
		if all_starstar && filename == b"**" {
			return self.only_filename(b"", filename, flags);
		}
		let starstar = flags & GLOBSTAR != 0 && filename == b"**";
		let mut result = Vec::new();
		for dname in &directories {
			let mut dflags = flags & !(ALLDIRS | ADDCURDIR);
			if starstar {
				dflags |= ALLDIRS | ADDCURDIR;
			}
			// A null directory before a non-null name is the current one.
			let dn: &[u8] = if dname.is_empty() && !filename.is_empty() {
				dflags |= NULLDIR;
				&b"."[..]
			} else {
				dname.as_slice()
			};
			let found = if all_starstar
				&& dflags & NULLDIR == 0
				&& self.testdir(dn, true) == DirTest::Symlink
				&& self.testdir(dn, false) == DirTest::Dir
			{
				// A symbolic link to a directory: the link itself, but no
				// descent through it.
				filename.is_empty().then(|| vec![BString::default()])
			} else {
				self.vector(filename, dn, dflags)
			};
			let Some(mut found) = found else {
				continue;
			};
			let mut done = false;
			let paths = if dflags & ALLDIRS != 0
				&& filename.starts_with(b"**")
				&& matches!(filename.get(2), None | Some(b'/'))
			{
				// `**` already put the directory in front of each name. With
				// no directory before it, the whole tree has been listed
				// from here: drop the placeholders and stop.
				if dflags & NULLDIR != 0
					&& flags & NULLDIR == 0
					&& found.first().is_some_and(|p| p.is_empty())
				{
					let n = found.iter().take_while(|p| p.is_empty()).count();
					found.drain(..n);
					done = true;
				}
				found
			} else {
				dir_to_array(dname, found)
			};
			result.extend(paths);
			if done {
				break;
			}
		}
		Some(result)
	}

	/// `glob_filename` once the directory part has no pattern.
	fn only_filename(
		&mut self,
		dirname: &[u8],
		filename: &[u8],
		flags: u32,
	) -> Option<Vec<BString>> {
		if filename.is_empty() {
			return Some(vec![dirname.into()]);
		}
		let dir = dequote(dirname);
		let mut dflags = flags;
		if dirname.is_empty() {
			dflags |= NULLDIR;
		}
		if flags & GLOBSTAR != 0 && filename == b"**" {
			dflags |= ALLDIRS | ADDCURDIR;
			if dirname.is_empty() && flags & ALLDIRS == 0 {
				dflags &= !ADDCURDIR;
			}
		}
		let at: &[u8] = if dirname.is_empty() { b"." } else { &dir };
		let found = self.vector(filename, at, dflags)?;
		Some(dir_to_array(if dflags & ALLDIRS != 0 { b"" } else { &dir }, found))
	}

	/// `sh_sortglob`: `paths` in `GLOBSORT` order.
	fn sort(&mut self, mut paths: Vec<BString>) -> Vec<BString> {
		let GlobSort { key, reverse } = self.opts.sort;
		let by_name = |a: &BString, b: &BString| if reverse { b.cmp(a) } else { a.cmp(b) };
		match key {
			SortKey::Unsorted => paths,
			SortKey::Name => {
				paths.sort_by(by_name);
				paths
			},
			SortKey::Numeric => {
				let num = |p: &BString| -> Option<i64> {
					p.iter().all(u8::is_ascii_digit).then(|| {
						p.iter()
							.fold(0i64, |n, &d| n.saturating_mul(10).saturating_add(i64::from(d - b'0')))
					})
				};
				paths.sort_by(|a, b| match (num(a), num(b)) {
					(Some(x), Some(y)) => {
						if reverse {
							y.cmp(&x)
						} else {
							x.cmp(&y)
						}
					},
					(None, None) => by_name(a, b),
					(Some(_), None) => {
						if reverse {
							core::cmp::Ordering::Greater
						} else {
							core::cmp::Ordering::Less
						}
					},
					(None, Some(_)) => {
						if reverse {
							core::cmp::Ordering::Less
						} else {
							core::cmp::Ordering::Greater
						}
					},
				});
				paths
			},
			SortKey::Size | SortKey::Mtime | SortKey::Atime | SortKey::Ctime | SortKey::Blocks => {
				// A path that does not stat sorts as -1, as bash's
				// `glob_nullstat`.
				let mut keyed: Vec<(i128, BString)> = paths
					.into_iter()
					.map(|p| {
						let st = self.stat(&p, true);
						let k = st.map_or(-1, |st| match key {
							SortKey::Size => i128::from(st.size),
							SortKey::Mtime => i128::from(st.mtime_ns),
							SortKey::Atime => i128::from(st.atime_ns),
							SortKey::Ctime => i128::from(st.ctime_ns),
							_ => i128::from(st.blocks),
						});
						(k, p)
					})
					.collect();
				keyed.sort_by(|(ka, a), (kb, b)| {
					let by_key = if reverse { kb.cmp(ka) } else { ka.cmp(kb) };
					by_key.then_with(|| by_name(a, b))
				});
				keyed.into_iter().map(|(_, p)| p).collect()
			},
		}
	}
}

/// Whether option `o` is on for `vp` (a store failure reads as off and is
/// recorded; the next scheduler turn abandons the scripts).
fn option_on(k: &mut super::Kernel, cx: &mut Cx<'_>, vp: &Vproc, o: OptId) -> bool {
	state::option(&mut k.root, cx.store, vp, o).unwrap_or_else(|e| {
		k.fail(e);
		false
	})
}

/// A shell variable's value, if set (a store failure reads as unset and is
/// recorded).
fn var_value(k: &mut super::Kernel, cx: &mut Cx<'_>, vp: &Vproc, name: &[u8]) -> Option<BString> {
	let value = state::lookup(&k.root, cx.store, vp, name)
		.map(|var| var.and_then(|v| v.as_scalar()).map(BString::from));
	value.unwrap_or_else(|e| {
		k.fail(e);
		None
	})
}

/// bash's `split_ignorespec`: `GLOBIGNORE` split at the colons that are
/// not inside a bracket expression or an extglob group, nor escaped.
fn ignore_patterns(value: &[u8]) -> Vec<&[u8]> {
	let mut out = Vec::new();
	let (mut start, mut i, mut depth) = (0, 0, 0usize);
	while i < value.len() {
		match value[i] {
			b'\\' => i += 1,
			b'[' => {
				// Skip a bracket expression that closes.
				let mut j = i + 1;
				if matches!(value.get(j), Some(b'!' | b'^')) {
					j += 1;
				}
				if value.get(j) == Some(&b']') {
					j += 1;
				}
				if let Some(end) = value[j.min(value.len())..].iter().position(|&c| c == b']') {
					i = j + end;
				}
			},
			b'(' if i > 0 && matches!(value[i - 1], b'?' | b'*' | b'+' | b'@' | b'!') => depth += 1,
			b')' if depth > 0 => depth -= 1,
			b':' if depth == 0 => {
				out.push(&value[start..i]);
				start = i + 1;
			},
			_ => {},
		}
		i += 1;
	}
	if start < value.len() {
		out.push(&value[start..]);
	}
	out
}

/// bash's `glob_name_is_acceptable`: `.` and `..` (as the last component)
/// never are, nor a path an ignore pattern matches.
fn acceptable(path: &[u8], ignore: &[Pattern]) -> bool {
	let last = match path.iter().rposition(|&c| c == b'/') {
		Some(i) if i + 1 < path.len() => &path[i + 1..],
		_ => path,
	};
	!matches!(last, b"." | b"..") && !ignore.iter().any(|p| p.matches(path))
}

/// Replace the fields recorded in `globs` (`(index, pattern)`, ascending)
/// by their matches, through `Glob` probes cached in the top frame's
/// scratch. A pattern without matches stays as written, is removed under
/// `nullglob`, and under `failglob` reports `no match` and discards the
/// command. `Err` also parks the op while an fs call is pending.
pub fn expand_globs(
	k: &mut super::Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	items: &mut Vec<BString>,
	globs: &[(u32, BString)],
	line: u32,
) -> Result<(), Flow> {
	expand_globs_with(k, vp, cx, items, globs, line, |w| w.as_slice(), |_, path| path)
}

/// [`expand_globs`] over the elements of a compound assignment `(…)`: a
/// matched element becomes one unkeyed element per path.
pub fn expand_compound_globs(
	k: &mut super::Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	elems: &mut Vec<super::expand::CompoundElem>,
	globs: &[(u32, BString)],
	line: u32,
) -> Result<(), Flow> {
	expand_globs_with(
		k,
		vp,
		cx,
		elems,
		globs,
		line,
		|e| e.value.as_slice(),
		|e, path| super::expand::CompoundElem { key: None, append: e.append, value: path },
	)
}

/// [`expand_globs`] for any item list: `word` is an item's text, `from_path`
/// the item a match of it becomes.
#[expect(
	clippy::too_many_arguments,
	reason = "the two shared entry points pass everything through"
)]
fn expand_globs_with<T>(
	k: &mut super::Kernel,
	vp: &mut Vproc,
	cx: &mut Cx<'_>,
	items: &mut Vec<T>,
	globs: &[(u32, BString)],
	line: u32,
	word: impl Fn(&T) -> &[u8],
	from_path: impl Fn(&T, BString) -> T,
) -> Result<(), Flow> {
	if globs.is_empty() {
		return Ok(());
	}
	let ignore_text = var_value(k, cx, vp, b"GLOBIGNORE").unwrap_or_default();
	let ignore_src = ignore_patterns(&ignore_text);
	let sort_var = var_value(k, cx, vp, b"GLOBSORT");
	let opts = GlobOpts {
		// A non-empty `GLOBIGNORE` turns on `dotglob` (bash's
		// `setup_glob_ignore`).
		dotglob:  option_on(k, cx, vp, OptId::Dotglob) || !ignore_src.is_empty(),
		nocase:   option_on(k, cx, vp, OptId::Nocaseglob),
		extglob:  option_on(k, cx, vp, OptId::Extglob),
		globstar: option_on(k, cx, vp, OptId::Globstar),
		skipdots: option_on(k, cx, vp, OptId::Globskipdots),
		utf8:     super::locale::is_utf8(k, cx.store, vp),
		sort:     GlobSort::parse(sort_var.as_ref().map(|v| v.as_slice())),
	};
	let nullglob = option_on(k, cx, vp, OptId::Nullglob);
	let failglob = option_on(k, cx, vp, OptId::Failglob);
	let ignore: Vec<Pattern> = ignore_src
		.iter()
		.map(|p| Pattern::compile(p, PatOpts::globignore(opts.extglob, opts.nocase, opts.utf8)))
		.collect();
	let mut sc = vp
		.frames
		.last_mut()
		.and_then(|f| f.scratch.take())
		.unwrap_or_default();
	let mut results = Vec::with_capacity(globs.len());
	for (_, pattern) in globs {
		let probe = Probe::Glob { pattern: pattern.clone(), opts };
		let answer = match super::probe::cached(&sc, &probe) {
			Some(r) => r.clone(),
			None => match super::probe::perform(k, cx, vp, &mut sc, &probe) {
				Ok(r) => r,
				Err(key) => {
					vp.frames.last_mut().expect("frame").scratch = Some(sc);
					return Err(Flow::Block(key));
				},
			},
		};
		results.push(answer);
	}
	vp.frames.last_mut().expect("frame").scratch = Some(sc);
	let mut found = Vec::with_capacity(results.len());
	for ((i, _), answer) in globs.iter().zip(results) {
		let ProbeResult::Paths(mut paths) = answer else {
			continue;
		};
		if !ignore.is_empty() {
			paths.retain(|p| acceptable(p, &ignore));
		}
		let i = *i as usize;
		if paths.is_empty()
			&& failglob
			&& let Some(item) = items.get(i)
		{
			k.diag(cx, vp, line, Diag::NoMatch { pattern: BString::from(word(item)) });
			return Err(Flow::Discard(1));
		}
		found.push((i, paths));
	}
	for (i, paths) in found.into_iter().rev() {
		if i >= items.len() {
			continue;
		}
		if paths.is_empty() {
			if nullglob {
				items.remove(i);
			}
			continue;
		}
		let matched: Vec<T> = paths.into_iter().map(|p| from_path(&items[i], p)).collect();
		items.splice(i..=i, matched);
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn meta_detection_matches_unquoted_glob_pattern_p() {
		assert!(has_meta(b"*.c", false));
		assert!(!has_meta(b"\\*.c", false));
		assert!(has_meta(b"a[bc]", false));
		assert!(!has_meta(b"[", false), "`[` alone (the test builtin) is literal");
		assert!(has_meta(b"a[]", false), "bash tries `a[]` as a pattern");
		assert!(!has_meta(b"a[/]", false), "a `/` ends the bracket");
		assert!(!has_meta(b"@(a|b)", false));
		assert!(has_meta(b"@(a|b)", true));
		assert!(!has_meta(b"tmp\\/a", false));
	}

	#[test]
	fn globsort_values_follow_setup_globsort() {
		let p = |v: &str| GlobSort::parse(Some(v.as_bytes()));
		assert_eq!(GlobSort::parse(None), GlobSort::default());
		assert_eq!(p(""), GlobSort::default());
		assert_eq!(p("-name"), GlobSort { key: SortKey::Name, reverse: true });
		assert_eq!(p("-"), GlobSort { key: SortKey::Name, reverse: true });
		assert_eq!(p("+mtime"), GlobSort { key: SortKey::Mtime, reverse: false });
		assert_eq!(p("-nonsense"), GlobSort::default(), "unknown keys ignore the sign");
		assert_eq!(p(" nosort"), GlobSort { key: SortKey::Unsorted, reverse: false });
	}

	#[test]
	fn globignore_splits_outside_brackets_and_groups() {
		assert_eq!(ignore_patterns(b".*:*c:?"), [&b".*"[..], b"*c", b"?"]);
		assert_eq!(ignore_patterns(b"[:]x:@(a:b)"), [&b"[:]x"[..], b"@(a:b)"]);
		assert_eq!(ignore_patterns(b""), Vec::<&[u8]>::new());
		let pats = [Pattern::compile(b"*c", PatOpts::globignore(false, false, false))];
		assert!(!acceptable(b"abc", &pats));
		assert!(acceptable(b"abd", &pats));
		assert!(!acceptable(b"dir/..", &[]));
	}

	#[test]
	fn paths_join_like_bash() {
		assert_eq!(makepath(b".", b"a", true), "a");
		assert_eq!(makepath(b".", b"a", false), "./a");
		assert_eq!(makepath(b"", b"a", false), "./a");
		assert_eq!(makepath(b"x/", b"a", false), "x/a");
		assert_eq!(dir_to_array(b"d", vec!["a".into(), "".into()]), ["d/a", "d/"]);
		assert_eq!(dequote(b"t\\mp\\"), "tmp");
	}
}
