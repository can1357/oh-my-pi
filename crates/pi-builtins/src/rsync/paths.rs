//! Name hygiene and operator-supplied file opens.
//!
//! - Pure byte-string helpers with upstream's exact semantics: [`clean_fname`]
//!   (`//`, `./`, trailing `/.`, `..` collapse/refusal), [`sanitize_path`]
//!   (chroot-style confinement of a path), [`unsafe_symlink`] (does a link
//!   target climb out of the transfer tree), and the receiver's check of
//!   names arriving in the file list ([`check_received_name`]).
//! - Conversions between name bytes and local names ([`os_bytes`],
//!   [`bytes_os`], [`bytes_path`], [`rel_path`], [`path_bytes`], …). Names are
//!   bytes on the wire and UTF-8 on Windows: a local name that is ill-formed
//!   UTF-16 or a name that is not UTF-8 is a per-file [`bad_name`] error; the
//!   `_lossy` variants replace instead, for values that cannot fail.
//! - The 3.5 "trusted-owner" walk for files the operator names on the command
//!   line (filter/merge files, `--files-from`, `--password-file`,
//!   `--log-file`, batch files): every component is resolved with
//!   `fstatat(AT_SYMLINK_NOFOLLOW)` + `openat(O_NOFOLLOW)` from a held
//!   directory fd, and a symlink is followed only when it is owned by uid 0 or
//!   the effective uid (CVE-2026-53802/53803). `--insecure-links` restores a
//!   plain open. `--confine-root` refuses a walk that lands outside its root.
//!
//! Virtual (non-native) filesystems get the same walk on a best-effort basis:
//! components are inspected with `symlink_metadata`, and the final open goes
//! through `BlockingFs`, so there is no race-freedom guarantee there.
//!
//! Windows has neither `openat` nor POSIX owners: operator files are opened by
//! path after a no-follow metadata check of every component (reparse points
//! are symlinks, and are followed as the operator's own), and
//! `--confine-root` is judged on the canonicalized target. Like the virtual
//! case this leaves a check-to-open window.

#[cfg(unix)]
use std::os::{
	fd::{AsFd, OwnedFd},
	unix::ffi::{OsStrExt, OsStringExt},
};
use std::{
	borrow::Cow,
	error::Error,
	ffi::{OsStr, OsString},
	fmt,
	io,
	path::{Path, PathBuf},
};

use pi_vfs::{BlockingFs, OpenOptions};

#[cfg(unix)]
use crate::rsync::{consts::MAXPATHLEN, ids::effective_uid, tree::sys};
use crate::rsync::exit::{RERR_UNSUPPORTED, RsyncError};

/// `clean_fname` flag: keep `.` elements (and a leading `./`).
pub(crate) const CFN_KEEP_DOT_DIRS: u32 = 1 << 0;
/// `clean_fname` flag: keep a trailing slash.
pub(crate) const CFN_KEEP_TRAILING_SLASH: u32 = 1 << 1;
/// `clean_fname` flag: drop a trailing `.` element after a slash.
pub(crate) const CFN_DROP_TRAILING_DOT_DIR: u32 = 1 << 2;
/// `clean_fname` flag: collapse `..` elements (except leading ones).
pub(crate) const CFN_COLLAPSE_DOT_DOT_DIRS: u32 = 1 << 3;
/// `clean_fname` flag: fail on any `..` element.
pub(crate) const CFN_REFUSE_DOT_DOT_DIRS: u32 = 1 << 4;

/// Upstream's FERROR notice when the trusted-owner walk refuses a symlink.
/// The refusal itself surfaces as an `ELOOP` error for which
/// [`is_untrusted_symlink`] is true; whoever reports the failed open prints
/// this line (plus a newline) first, as upstream does.
pub(crate) const UNTRUSTED_SYMLINK_NOTICE: &str = "refusing to follow a symlink owned by an \
	untrusted user; use --insecure-links locally or \"insecure links = yes\" in a daemon module \
	ONLY if every path component is trusted";

/// Upper bound on symlink expansions in one operator walk (upstream: 40).
#[cfg(unix)]
const OPERATOR_MAX_SYMLINKS: u32 = 40;

// ---------------------------------------------------------------------------
// clean_fname / sanitize_path / unsafe_symlink
// ---------------------------------------------------------------------------

/// clean_fname: collapse "//", "./", trailing "/." (and ".." handling per flags).
///
/// `collapse_dot_dot` selects `CFN_COLLAPSE_DOT_DOT_DIRS`; without it the
/// flags are 0 (the trailing `.` element is kept). See [`clean_fname_flags`]
/// for the full flag set.
pub(crate) fn clean_fname(name: &[u8], collapse_dot_dot: bool) -> Vec<u8> {
	let flags = if collapse_dot_dot { CFN_COLLAPSE_DOT_DOT_DIRS } else { 0 };
	clean_fname_flags(name, flags).unwrap_or_else(|partial| partial)
}

/// clean_fname with upstream's `CFN_*` flags. `Err` carries the buffer as
/// upstream leaves it when `CFN_REFUSE_DOT_DOT_DIRS` trips: partially
/// compacted in place (that is what its diagnostics print).
pub(crate) fn clean_fname_flags(name: &[u8], flags: u32) -> Result<Vec<u8>, Vec<u8>> {
	let mut buf = name.to_vec();
	match clean_in_place(&mut buf, flags) {
		Ok(()) => Ok(buf),
		Err(()) => Err(buf),
	}
}

fn byte_at(buf: &[u8], i: usize) -> u8 {
	buf.get(i).copied().unwrap_or(0)
}

/// `buf[i..]` starts with a `..` element.
fn dot_dot_at(buf: &[u8], i: usize) -> bool {
	byte_at(buf, i) == b'.' && byte_at(buf, i + 1) == b'.' && matches!(byte_at(buf, i + 2), b'/' | 0)
}

/// The in-place compaction: `t` (write) never passes `f` (read), so the
/// buffer can be rewritten as it is scanned, exactly like the C original.
fn clean_in_place(buf: &mut Vec<u8>, flags: u32) -> Result<(), ()> {
	let anchored = byte_at(buf, 0) == b'/';
	let (mut t, mut f) = (0usize, 0usize);
	let mut limit = 0usize;
	if anchored {
		t = 1;
		f = 1;
	} else if flags & CFN_KEEP_DOT_DIRS != 0 && byte_at(buf, 0) == b'.' && byte_at(buf, 1) == b'/'
	{
		t = 2;
		f = 2;
	} else if flags & CFN_REFUSE_DOT_DOT_DIRS != 0 && dot_dot_at(buf, 0) {
		return Err(());
	}
	while f < buf.len() {
		let c = buf[f];
		if c == b'/' {
			f += 1;
			continue;
		}
		if c == b'.' {
			let next = byte_at(buf, f + 1);
			if next == b'/' && flags & CFN_KEEP_DOT_DIRS == 0 {
				f += 2;
				continue;
			}
			if f + 1 == buf.len() && flags & CFN_DROP_TRAILING_DOT_DIR != 0 {
				break;
			}
			if flags & (CFN_COLLAPSE_DOT_DOT_DIRS | CFN_REFUSE_DOT_DOT_DIRS) != 0
				&& dot_dot_at(buf, f)
			{
				if flags & CFN_REFUSE_DOT_DOT_DIRS != 0 {
					return Err(());
				}
				// `s` walks back over the previous element in the output.
				let last = t as isize - 1;
				if last == 0 && anchored {
					f += 2;
					continue;
				}
				let mut s = last;
				while s > limit as isize && buf[(s - 1) as usize] != b'/' {
					s -= 1;
				}
				if s != last && (s <= 0 || buf[(s - 1) as usize] == b'/') {
					t = s.max(0) as usize;
					f += 2;
					continue;
				}
				limit = t + 2;
			}
		}
		// Copy one element, through its trailing slash.
		while f < buf.len() {
			let c = buf[f];
			buf[t] = c;
			t += 1;
			f += 1;
			if c == b'/' {
				break;
			}
		}
	}
	if t > usize::from(anchored) && buf[t - 1] == b'/' && flags & CFN_KEEP_TRAILING_SLASH == 0 {
		t -= 1;
	}
	buf.truncate(t);
	if t == 0 {
		buf.push(b'.');
	}
	Ok(())
}

/// The text after the last `/` of a name (the whole name without a slash; empty after a
/// trailing slash).
pub(crate) fn basename(name: &[u8]) -> &[u8] {
	match memchr::memrchr(b'/', name) {
		Some(at) => &name[at + 1..],
		None => name,
	}
}

/// A name split at its last `/` into the text before it and [`basename`] (directory
/// empty without a slash, and for `/x`).
pub(crate) fn split_name(name: &[u8]) -> (&[u8], &[u8]) {
	match memchr::memrchr(b'/', name) {
		Some(at) => (&name[..at], &name[at + 1..]),
		None => (b"", name),
	}
}

/// Upstream's file-list `strrchr(name, '/')` split: [`split_name`], except that the
/// directory of `/x` is `/` (so it is empty only without a slash).
pub(crate) fn split_name_rooted(name: &[u8]) -> (&[u8], &[u8]) {
	match memchr::memrchr(b'/', name) {
		Some(0) => (&name[..1], &name[1..]),
		Some(at) => (&name[..at], &name[at + 1..]),
		None => (b"", name),
	}
}

/// sanitize_path for received names / daemon-relative paths.
///
/// Makes `name` look as if a chroot had happened: a leading `/` is replaced by
/// `rootdir` (`None` means no replacement, the non-daemon case), `.` elements
/// are dropped (a trailing one too), a trailing slash is kept, and `..`
/// elements are collapsed except for up to `depth` leading ones (none after a
/// leading slash). An empty result becomes `.`.
pub(crate) fn sanitize_path(name: &[u8], rootdir: Option<&[u8]>, depth: usize) -> Vec<u8> {
	sanitize_path_flags(name, rootdir, depth, false)
}

/// [`sanitize_path`] with upstream's `SP_KEEP_DOT_DIRS` (callers pass
/// `relative_paths && SP_KEEP_DOT_DIRS`, the condition upstream evaluates).
pub(crate) fn sanitize_path_flags(
	name: &[u8],
	rootdir: Option<&[u8]>,
	depth: usize,
	keep_dot_dirs: bool,
) -> Vec<u8> {
	let mut depth = depth;
	let mut p = name;
	let mut out = Vec::with_capacity(name.len() + rootdir.map_or(0, <[u8]>::len) + 2);
	if p.first() == Some(&b'/') {
		let root = rootdir.unwrap_or(b"");
		out.extend_from_slice(root);
		if root.len() > 1 {
			out.push(b'/');
		}
		depth = 0;
		p = &p[1..];
	}
	let drop_dot_dirs = !keep_dot_dirs;
	if drop_dot_dirs {
		while p.starts_with(b"./") {
			p = &p[2..];
		}
	}
	let mut start = out.len();
	let mut i = 0;
	while i < p.len() {
		if p[i] == b'/' {
			i += 1;
			continue;
		}
		if drop_dot_dirs && p[i] == b'.' && matches!(byte_at(p, i + 1), b'/' | 0) {
			i += 1;
			continue;
		}
		if dot_dot_at(p, i) {
			if depth == 0 || out.len() != start {
				i += 2;
				if out.len() > start {
					// Back up over the previous element (and its slash).
					let mut s = out.len() - 1;
					while s > start && out[s - 1] != b'/' {
						s -= 1;
					}
					out.truncate(s);
				}
				continue;
			}
			depth -= 1;
			start = out.len() + 3;
		}
		while i < p.len() {
			let c = p[i];
			out.push(c);
			i += 1;
			if c == b'/' {
				break;
			}
		}
	}
	if out.is_empty() {
		out.push(b'.');
	}
	out
}

/// The receiver's check of a name from the sender's file list: any `..`
/// element, or (without `--relative`) a leading `/`, aborts the transfer with
/// RERR_UNSUPPORTED. Returns the name as upstream continues with it: cleaned
/// by `clean_fname(CFN_REFUSE_DOT_DOT_DIRS)`.
pub(crate) fn check_received_name(name: &[u8], relative_paths: bool) -> Result<Vec<u8>, RsyncError> {
	if name.is_empty() {
		return Ok(Vec::new());
	}
	let shown = match clean_fname_flags(name, CFN_REFUSE_DOT_DOT_DIRS) {
		Ok(clean) if relative_paths || clean.first() != Some(&b'/') => return Ok(clean),
		Ok(clean) => clean,
		Err(partial) => partial,
	};
	Err(RsyncError::new(
		RERR_UNSUPPORTED,
		format!("ABORTING due to unsafe pathname from sender: {}", String::from_utf8_lossy(&shown)),
	)
	.at("flist.c", 1079))
}

/// unsafe_symlink: does `target` escape the tree from `link_name`'s directory?
///
/// `link_name` is the symlink's own path (including its name) relative to the
/// top of the applicable source tree. Absolute and empty targets are always
/// unsafe, as is any `..` element other than a leading run, or a trailing
/// `/..`.
pub(crate) fn unsafe_symlink(target: &[u8], link_name: &[u8]) -> bool {
	if target.is_empty() || target[0] == b'/' {
		return true;
	}
	// Only a leading run of "../" may climb; anything later could become
	// unsafe once an earlier component is replaced by a symlink.
	let mut rest = target;
	while rest.starts_with(b"../") {
		rest = &rest[3..];
		while rest.first() == Some(&b'/') {
			rest = &rest[1..];
		}
	}
	if memchr::memmem::find(rest, b"/../").is_some() {
		return true;
	}
	if target.len() > 3 && target.ends_with(b"/..") {
		return true;
	}

	// Depth available below the top: one per directory element of the link's
	// own path; ".." restarts the count, "." is ignored.
	let mut depth: i64 = 0;
	let last = for_each_dir_element(link_name, |element| {
		match element {
			b"." => {},
			b".." => depth = 0,
			_ => depth += 1,
		}
		true
	});
	if last == b".." {
		depth = 0;
	}

	let mut escaped = false;
	let last = for_each_dir_element(target, |element| {
		match element {
			b"." => {},
			b".." => {
				depth -= 1;
				if depth < 0 {
					escaped = true;
					return false;
				}
			},
			_ => depth += 1,
		}
		true
	});
	if escaped {
		return true;
	}
	if last == b".." {
		depth -= 1;
	}
	depth < 0
}

/// Calls `visit` with every element that is followed by a slash (runs of
/// slashes count once), stopping early when it returns false; returns the
/// final element (the text after the last slash).
fn for_each_dir_element<'a>(path: &'a [u8], mut visit: impl FnMut(&'a [u8]) -> bool) -> &'a [u8] {
	let mut pos = 0;
	while let Some(offset) = memchr::memchr(b'/', &path[pos..]) {
		let slash = pos + offset;
		if !visit(&path[pos..slash]) {
			return b"";
		}
		let mut end = slash;
		while path.get(end + 1) == Some(&b'/') {
			end += 1;
		}
		pos = end + 1;
	}
	&path[pos..]
}

// ---------------------------------------------------------------------------
// --confine-root
// ---------------------------------------------------------------------------

/// `p` names an fd-pin namespace (`/dev/fd`, `/dev/std{in,out,err}`,
/// `/proc/{self,<pid>}/fd`): returns the part after the pin directory (empty
/// for the directory itself, else starting with `/`).
fn fd_pin_tail(p: &[u8]) -> Option<&[u8]> {
	if let Some(s) = p.strip_prefix(b"/dev/") {
		if let Some(s) = s.strip_prefix(b"fd") {
			return (s.is_empty() || s[0] == b'/').then_some(s);
		}
		return match s {
			b"stdin" => Some(b"/0"),
			b"stdout" => Some(b"/1"),
			b"stderr" => Some(b"/2"),
			_ => None,
		};
	}
	let s = p.strip_prefix(b"/proc/")?;
	let s = if s.starts_with(b"self/") {
		&s[4..]
	} else {
		let digits = s.iter().take_while(|b| b.is_ascii_digit()).count();
		if digits == 0 || s.get(digits) != Some(&b'/') {
			return None;
		}
		&s[digits..]
	};
	let s = s.strip_prefix(b"/fd")?;
	(s.is_empty() || s[0] == b'/').then_some(s)
}

/// An exact pin entry such as `/dev/fd/7` or `/proc/self/fd/7`.
fn is_exact_fd_pin(p: &[u8]) -> bool {
	match fd_pin_tail(p).and_then(|tail| tail.strip_prefix(b"/")) {
		Some(digits) => !digits.is_empty() && digits.iter().all(u8::is_ascii_digit),
		None => false,
	}
}

/// The error for a name with no byte or no local spelling (only on Windows: ill-formed
/// UTF-16 or invalid UTF-8).
pub(crate) fn bad_name() -> io::Error {
	io::Error::new(io::ErrorKind::InvalidData, "file name is not valid UTF-8")
}

/// The bytes of a local name; ill-formed UTF-16 on Windows is [`bad_name`].
pub(crate) fn os_bytes(value: &OsStr) -> io::Result<&[u8]> {
	crate::host::os_bytes(value).ok_or_else(bad_name)
}

/// Name bytes as a local name; invalid UTF-8 on Windows is [`bad_name`].
pub(crate) fn bytes_os(bytes: &[u8]) -> io::Result<&OsStr> {
	#[cfg(unix)]
	return Ok(OsStr::from_bytes(bytes));
	#[cfg(not(unix))]
	return std::str::from_utf8(bytes).map(OsStr::new).map_err(|_| bad_name());
}

/// A whole name as a path, spelled as given (absolute stays absolute); invalid UTF-8 on
/// Windows is [`bad_name`].
pub(crate) fn bytes_path(bytes: &[u8]) -> io::Result<&Path> {
	bytes_os(bytes).map(Path::new)
}

/// Name bytes as a local name, replacing invalid UTF-8 on Windows.
pub(crate) fn bytes_os_lossy(bytes: &[u8]) -> Cow<'_, OsStr> {
	#[cfg(unix)]
	return Cow::Borrowed(OsStr::from_bytes(bytes));
	#[cfg(not(unix))]
	return match String::from_utf8_lossy(bytes) {
		Cow::Borrowed(text) => Cow::Borrowed(OsStr::new(text)),
		Cow::Owned(text) => Cow::Owned(OsString::from(text)),
	};
}

/// [`bytes_os_lossy`] taking ownership of the bytes.
pub(crate) fn vec_os_lossy(bytes: Vec<u8>) -> OsString {
	#[cfg(unix)]
	return OsString::from_vec(bytes);
	#[cfg(not(unix))]
	return OsString::from(String::from_utf8_lossy_owned(bytes));
}

/// The elements of a `/`-separated name, without empty and `.` elements.
fn name_elements(name: &[u8]) -> impl Iterator<Item = &[u8]> {
	name.split(|&b| b == b'/').filter(|el| !el.is_empty() && *el != b".")
}

/// Appends the elements of a `/`-separated name to `path` one by one (`Path::push`);
/// invalid UTF-8 on Windows is [`bad_name`].
pub(crate) fn push_rel(path: &mut PathBuf, name: &[u8]) -> io::Result<()> {
	for el in name_elements(name) {
		path.push(bytes_os(el)?);
	}
	Ok(())
}

/// A received name as a relative local path (`.` for the root), built element by
/// element; invalid UTF-8 on Windows is [`bad_name`].
pub(crate) fn rel_path(name: &[u8]) -> io::Result<PathBuf> {
	let mut path = PathBuf::new();
	push_rel(&mut path, name)?;
	if path.is_empty() {
		path.push(".");
	}
	Ok(path)
}

/// A received name as a relative local path (empty for the root), built element by
/// element and replacing invalid UTF-8 on Windows.
pub(crate) fn rel_path_lossy(name: &[u8]) -> PathBuf {
	let mut path = PathBuf::new();
	for el in name_elements(name) {
		path.push(bytes_os_lossy(el));
	}
	path
}

/// The bytes of a local path with `/` separators (`\` also separates on
/// Windows); ill-formed UTF-16 is replaced, which can only make a
/// confinement check fail.
pub(crate) fn path_bytes(path: &Path) -> Cow<'_, [u8]> {
	let mut bytes = crate::host::os_bytes_lossy(path.as_os_str());
	if cfg!(windows) && bytes.contains(&b'\\') {
		forward_slashes(bytes.to_mut());
	}
	bytes
}

/// Rewrites the `\` separators of a local Windows name to `/` (a no-op elsewhere).
pub(crate) fn forward_slashes(bytes: &mut [u8]) {
	if cfg!(windows) {
		for b in bytes.iter_mut().filter(|b| **b == b'\\') {
			*b = b'/';
		}
	}
}

/// Whether `b` separates local path elements (`/`; on Windows also `\`).
pub(crate) fn is_separator(b: u8) -> bool {
	b == b'/' || (cfg!(windows) && b == b'\\')
}

/// A path spelled absolutely (`/x`; on Windows also `\x` and `C:…`).
pub(crate) fn is_absolute_bytes(bytes: &[u8]) -> bool {
	match bytes {
		[first, ..] if is_separator(*first) => true,
		[drive, b':', ..] if cfg!(windows) && drive.is_ascii_alphabetic() => true,
		_ => false,
	}
}

/// Upstream `full_fname`: `name` quoted the way diagnostics show it, a relative name
/// prefixed with `dir`, the directory it is relative to.
pub(crate) fn full_fname(dir: &Path, name: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(name.len() + 2);
	out.push(b'"');
	if !is_absolute_bytes(name) {
		let dir = path_bytes(dir);
		out.extend_from_slice(&dir);
		if dir.last() != Some(&b'/') {
			out.push(b'/');
		}
	}
	out.extend_from_slice(name);
	out.push(b'"');
	out
}

/// The errno-equivalent of "a symlink was refused" (`ELOOP`; on Windows
/// `ERROR_CANT_RESOLVE_FILENAME`, its closest analogue).
#[cfg(unix)]
pub(crate) const LOOP_ERRNO: i32 = libc::ELOOP;
/// See the unix definition.
#[cfg(windows)]
pub(crate) const LOOP_ERRNO: i32 = 1921;

/// A raw "refused symlink" error.
pub(crate) fn loop_error() -> io::Error {
	io::Error::from_raw_os_error(LOOP_ERRNO)
}

fn trim_root(root: &[u8]) -> &[u8] {
	let mut root = root;
	while root.len() > 1 && root.ends_with(b"/") {
		root = &root[..root.len() - 1];
	}
	root
}

/// Whether the absolute path `abspath` is outside `root` (upstream's
/// enforcing refusal). `final_target` distinguishes a completed target from an
/// ancestor crossed while descending towards the root.
fn outside_confinement(abspath: &[u8], root: &[u8], final_target: bool) -> bool {
	let root = trim_root(root);
	if root.len() <= 1 {
		return false;
	}
	let mut owned: Option<Vec<u8>> = None;
	if let Some(tail) = fd_pin_tail(abspath) {
		if tail.is_empty() {
			return false;
		}
		if is_exact_fd_pin(abspath) {
			match read_pin(abspath) {
				Some(target) if target.first() == Some(&b'/') => owned = Some(target),
				_ => return true,
			}
		}
	}
	let abspath = owned.as_deref().unwrap_or(abspath);
	if abspath.starts_with(root) && matches!(abspath.get(root.len()), None | Some(b'/')) {
		return false;
	}
	let len = abspath.len();
	if len == 0 || (len < root.len() && root.starts_with(abspath) && root[len] == b'/') {
		return final_target;
	}
	true
}

/// The target of an fd-pin magic link.
#[cfg(unix)]
fn read_pin(pin: &[u8]) -> Option<Vec<u8>> {
	let target = std::fs::read_link(Path::new(OsStr::from_bytes(pin))).ok()?;
	Some(target.into_os_string().into_vec())
}

/// No fd pins outside unix.
#[cfg(not(unix))]
fn read_pin(_pin: &[u8]) -> Option<Vec<u8>> {
	None
}

/// --confine-root check for an operator/peer-supplied path.
///
/// `path` must be absolute (relative paths are judged as spelled). True when
/// it equals `confine` or lies below it; a root of `/` confines nothing. An fd
/// pin (`/dev/fd/N`, `/proc/self/fd/N`) is judged by the target it points at.
/// On Windows `\` and `/` are equivalent and comparison is byte-exact.
pub(crate) fn within_confine(path: &Path, confine: &Path) -> bool {
	!outside_confinement(&path_bytes(path), &path_bytes(confine), true)
}

// ---------------------------------------------------------------------------
// The trusted-owner walk
// ---------------------------------------------------------------------------

/// The error payload of a symlink refused by the trusted-owner walk. Its
/// `io::Error` has ELOOP's kind; [`os_errno`] maps it back to `ELOOP`.
#[derive(Debug)]
pub(crate) struct UntrustedSymlink {
	errno: io::Error,
}

impl fmt::Display for UntrustedSymlink {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(&crate::host::strip_errno(&self.errno))
	}
}

impl Error for UntrustedSymlink {
	fn source(&self) -> Option<&(dyn Error + 'static)> {
		Some(&self.errno)
	}
}

fn untrusted_symlink() -> io::Error {
	let errno = loop_error();
	io::Error::new(errno.kind(), UntrustedSymlink { errno })
}

/// Whether `err` is the trusted-owner walk refusing a symlink (callers print
/// [`UNTRUSTED_SYMLINK_NOTICE`] before their own diagnostic).
pub(crate) fn is_untrusted_symlink(err: &io::Error) -> bool {
	err.get_ref().is_some_and(|inner| inner.is::<UntrustedSymlink>())
}

/// The errno behind `err`: its raw OS error, or `ELOOP` for an untrusted
/// symlink refusal.
#[cfg(unix)]
pub(crate) fn os_errno(err: &io::Error) -> Option<i32> {
	err.raw_os_error()
		.or_else(|| is_untrusted_symlink(err).then_some(LOOP_ERRNO))
}

/// Policy of one trusted-owner walk.
#[cfg(unix)]
pub(crate) struct OwnerWalk<'a> {
	/// `--confine-root`, when the open must stay inside it.
	pub confine: Option<&'a Path>,
	/// Whether a symlink owned by this uid may be followed.
	pub trusted: &'a dyn Fn(u32) -> bool,
}

/// The default trust rule: uid 0 or the effective uid.
#[cfg(unix)]
pub(crate) fn trusted_owner(uid: u32) -> bool {
	uid == 0 || effective_uid() == Some(uid)
}

/// Windows has no POSIX owners: reparse points are the operator's own.
#[cfg(not(unix))]
pub(crate) fn trusted_owner(_uid: u32) -> bool {
	true
}

/// Advances the tracked absolute path by one resolved element.
#[cfg(unix)]
fn abspath_step(abspath: &mut Vec<u8>, comp: &[u8]) -> io::Result<()> {
	match comp {
		b"." => {},
		b".." => match memchr::memrchr(b'/', abspath) {
			Some(slash) => abspath.truncate(slash),
			None => abspath.clear(),
		},
		_ => {
			if abspath.last() != Some(&b'/') {
				abspath.push(b'/');
			}
			if abspath.len() + comp.len() >= MAXPATHLEN {
				return Err(sys::errno(libc::ENAMETOOLONG));
			}
			abspath.extend_from_slice(comp);
		},
	}
	Ok(())
}

/// Opens an operator-supplied `path`, refusing to traverse any symlink (an
/// ancestor or the leaf) whose owner `walk.trusted` rejects; trusted symlinks
/// are followed by splicing their target into the remaining path (absolute
/// targets restart at `/`). `flags`/`mode` are `openat` flags for the final
/// element (`O_NOFOLLOW` and `O_CLOEXEC` are always added); a path that ends
/// at a directory needs `O_DIRECTORY` in `flags`, else `EISDIR`.
#[cfg(unix)]
pub(crate) fn owner_walk_open(
	path: &[u8],
	flags: libc::c_int,
	mode: u32,
	walk: &OwnerWalk<'_>,
) -> io::Result<OwnedFd> {
	if path.is_empty() {
		return Err(sys::errno(libc::EINVAL));
	}
	let confine = walk.confine.map(|root| root.as_os_str().as_bytes());
	let outside = |abspath: &[u8], final_target: bool| {
		confine.is_some_and(|root| outside_confinement(abspath, root, final_target))
	};

	let mut abspath = Vec::new();
	if confine.is_some() {
		// A relative walk starts at the physical cwd; without it nothing can be
		// measured against the root, so refuse.
		abspath = std::env::current_dir()?.into_os_string().into_vec();
	}
	let mut anchored = !abspath.is_empty();
	let mut pin_transit = confine.is_some() && fd_pin_tail(path).is_some();
	if path.len() >= MAXPATHLEN * 2 {
		return Err(sys::errno(libc::ENAMETOOLONG));
	}
	let mut remaining = path.to_vec();
	let mut dir: Option<OwnedFd> = None;
	if remaining[0] == b'/' {
		dir = Some(sys::open_root_dir()?);
		abspath.clear();
		anchored = true;
		strip_leading_slashes(&mut remaining);
	}
	let mut loops = OPERATOR_MAX_SYMLINKS;

	while !remaining.is_empty() {
		let slash = memchr::memchr(b'/', &remaining);
		let comp_len = slash.unwrap_or(remaining.len());
		if comp_len == 0 {
			return Err(sys::errno(libc::EINVAL));
		}
		if comp_len >= MAXPATHLEN {
			return Err(sys::errno(libc::ENAMETOOLONG));
		}
		let comp = remaining[..comp_len].to_vec();
		let is_last = slash.is_none();
		let name = sys::cstr(&comp)?;
		let at = dir.as_ref().map(AsFd::as_fd);

		let st = match sys::fstatat(at, &name, true) {
			Ok(st) => st,
			Err(err) => {
				if is_last
					&& err.raw_os_error() == Some(libc::ENOENT)
					&& flags & libc::O_CREAT != 0
				{
					abspath_step(&mut abspath, &comp)?;
					if !pin_transit && outside(&abspath, true) {
						return Err(sys::errno(libc::ELOOP));
					}
					return sys::openat(at, &name, flags | libc::O_NOFOLLOW, mode);
				}
				return Err(err);
			},
		};

		if sys::is_lnk(&st) {
			// In a user namespace the /proc/self, /dev/fd and /dev/std*
			// symlinks may report the overflow uid; allow exactly those.
			let namespace_pin = anchored
				&& ((abspath == b"/proc" && comp == b"self")
					|| (abspath == b"/dev"
						&& matches!(&comp[..], b"fd" | b"stdin" | b"stdout" | b"stderr")));
			if !namespace_pin && !(walk.trusted)(sys::st_uid(&st)) {
				return Err(untrusted_symlink());
			}
			if loops == 0 {
				return Err(sys::errno(libc::ELOOP));
			}
			loops -= 1;
			let target = sys::readlinkat(at, &name)?;

			// Kernel pseudo-objects behind /proc/self/fd/N or /dev/fd/N
			// (pipes, sockets, anonymous inodes) cannot be walked into.
			let in_fd_dir = anchored && fd_pin_tail(&abspath).is_some_and(<[u8]>::is_empty);
			if in_fd_dir
				&& (target.starts_with(b"pipe:[")
					|| target.starts_with(b"socket:[")
					|| target.starts_with(b"anon_inode:"))
			{
				if !is_last {
					return Err(sys::errno(libc::ENOTDIR));
				}
				if confine.is_some() {
					return Err(sys::errno(libc::ENOENT));
				}
				let fd = sys::openat(at, &name, flags & !libc::O_NOFOLLOW, mode)?;
				let st = sys::fstat(fd.as_fd())?;
				if sys::is_reg(&st) || sys::is_dir(&st) {
					return Err(sys::errno(libc::ELOOP));
				}
				return Ok(fd);
			}

			let mut rebuilt = target;
			if let Some(slash) = slash {
				rebuilt.extend_from_slice(&remaining[slash..]);
			}
			if rebuilt.len() >= MAXPATHLEN * 2 {
				return Err(sys::errno(libc::ENAMETOOLONG));
			}
			if rebuilt.first() == Some(&b'/') {
				dir = Some(sys::open_root_dir()?);
				abspath.clear();
				anchored = true;
				pin_transit = pin_transit && fd_pin_tail(&rebuilt).is_some();
				strip_leading_slashes(&mut rebuilt);
			}
			remaining = rebuilt;
			continue;
		}

		abspath_step(&mut abspath, &comp)?;
		if is_last {
			if !pin_transit && outside(&abspath, true) {
				return Err(sys::errno(libc::ELOOP));
			}
			return sys::openat(at, &name, flags | libc::O_NOFOLLOW, mode);
		}
		if !sys::is_dir(&st) {
			return Err(sys::errno(libc::ENOTDIR));
		}
		if !pin_transit && outside(&abspath, false) {
			return Err(sys::errno(libc::ELOOP));
		}
		let next = sys::openat(at, &name, sys::TRAVERSE | libc::O_NOFOLLOW, 0)?;
		dir = Some(next);
		let rest = slash.map_or(remaining.len(), |slash| slash);
		remaining.drain(..rest);
		strip_leading_slashes(&mut remaining);
	}

	// The whole path resolved to a directory.
	if flags & libc::O_DIRECTORY == 0 {
		return Err(sys::errno(libc::EISDIR));
	}
	if !pin_transit && outside(&abspath, true) {
		return Err(sys::errno(libc::ELOOP));
	}
	sys::openat(dir.as_ref().map(AsFd::as_fd), c".", flags | libc::O_NOFOLLOW, mode)
}

#[cfg(unix)]
fn strip_leading_slashes(buf: &mut Vec<u8>) {
	let n = buf.iter().take_while(|&&b| b == b'/').count();
	buf.drain(..n);
}

/// Options for an operator-supplied file open beyond the pinned defaults.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct OperatorOpts<'a> {
	/// `--insecure-links`: plain path open.
	pub insecure: bool,
	/// `--confine-root` when it applies to this file (merge files and
	/// `--files-from` entries; not `--log-file` or batch files).
	pub confine: Option<&'a Path>,
}

/// Operator-supplied file opens with the 3.5 trusted-owner walk (filter files, --files-from, password file, batch read).
pub(crate) fn open_operator_file(
	fs: &BlockingFs,
	path: &Path,
	insecure: bool,
) -> io::Result<pi_vfs::File> {
	open_operator_file_with(fs, path, &OperatorOpts { insecure, confine: None })
}

/// [`open_operator_file`] with `--confine-root` enforcement.
pub(crate) fn open_operator_file_with(
	fs: &BlockingFs,
	path: &Path,
	opts: &OperatorOpts<'_>,
) -> io::Result<pi_vfs::File> {
	operator_open(fs, path, OpenKind::Read, opts)
}

/// How an operator file is opened.
#[derive(Clone, Copy)]
enum OpenKind {
	Read,
	Create { append: bool, mode: u32 },
}

impl OpenKind {
	fn options(self) -> OpenOptions {
		let mut options = OpenOptions::new();
		match self {
			Self::Read => {
				options.read(true);
			},
			Self::Create { append, mode } => {
				options.write(true).create(true).mode(mode);
				if append {
					options.append(true);
				} else {
					options.truncate(true);
				}
			},
		}
		options
	}

	#[cfg(unix)]
	fn flags(self) -> (libc::c_int, u32) {
		match self {
			Self::Read => (libc::O_RDONLY, 0),
			Self::Create { append, mode } => {
				let tail = if append { libc::O_APPEND } else { libc::O_TRUNC };
				(libc::O_WRONLY | libc::O_CREAT | tail, mode)
			},
		}
	}
}

/// Operator-supplied output files (--log-file, --write-batch).
///
/// `append` opens like `--log-file` (`O_WRONLY|O_APPEND|O_CREAT`, mode 0644);
/// otherwise like `--write-batch` (`O_WRONLY|O_CREAT|O_TRUNC`, mode 0600).
pub(crate) fn create_operator_file(
	fs: &BlockingFs,
	path: &Path,
	append: bool,
	insecure: bool,
) -> io::Result<pi_vfs::File> {
	let mode = if append { 0o644 } else { 0o600 };
	create_operator_file_with(fs, path, append, mode, &OperatorOpts { insecure, confine: None })
}

/// [`create_operator_file`] with an explicit creation mode (the batch `.sh`
/// file is 0700) and `--confine-root`.
pub(crate) fn create_operator_file_with(
	fs: &BlockingFs,
	path: &Path,
	append: bool,
	mode: u32,
	opts: &OperatorOpts<'_>,
) -> io::Result<pi_vfs::File> {
	operator_open(fs, path, OpenKind::Create { append, mode }, opts)
}

/// Whether an opened `--read-batch` input may feed the protocol: a regular
/// file or a FIFO (process substitution). Upstream otherwise prints
/// "Batch file %s is neither a regular file nor a FIFO" and exits RERR_FILEIO.
pub(crate) fn batch_input_ok(file: &pi_vfs::File) -> io::Result<bool> {
	let kind = file.metadata()?.file_type();
	Ok(kind.is_file() || kind.is_fifo())
}

fn operator_open(
	fs: &BlockingFs,
	path: &Path,
	kind: OpenKind,
	opts: &OperatorOpts<'_>,
) -> io::Result<pi_vfs::File> {
	if opts.insecure {
		return fs.open_with(path, &kind.options());
	}
	#[cfg(unix)]
	if fs.is_native_local(path) {
		let (flags, mode) = kind.flags();
		let walk = OwnerWalk { confine: opts.confine, trusted: &trusted_owner };
		let fd = owner_walk_open(path.as_os_str().as_bytes(), flags, mode, &walk)?;
		return Ok(pi_vfs::File::from(std::fs::File::from(fd)));
	}
	// Path-based: provider paths everywhere, and native paths on Windows.
	// Mounted descriptors (`omp-descriptor://N`) are neither and open as-is.
	if fs.is_native_local(path) || pi_vfs::is_virtual_path(path) {
		virtual_owner_walk(fs, path, &trusted_owner)?;
		if let Some(confine) = opts.confine {
			check_confined(fs, path, confine, matches!(kind, OpenKind::Create { .. }))?;
		}
	}
	fs.open_with(path, &kind.options())
}

/// `--confine-root` for path-based opens: the canonical target (or, for a
/// file about to be created, its canonical parent) must lie inside `confine`.
fn check_confined(fs: &BlockingFs, path: &Path, confine: &Path, create: bool) -> io::Result<()> {
	let resolved = match fs.canonicalize(path) {
		Ok(resolved) => resolved,
		Err(err) if create && err.kind() == io::ErrorKind::NotFound => {
			let parent = pi_vfs::parent_path(path).ok_or(err)?;
			let name = pi_vfs::file_name(path).ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
			fs.canonicalize(parent)?.join::<&OsStr>(name.as_ref())
		},
		Err(err) => return Err(err),
	};
	let root = fs.canonicalize(confine).unwrap_or_else(|_| confine.to_path_buf());
	within_confine(&resolved, &root).ok_or_else(loop_error)
}

/// Best-effort walk for path-based opens: every existing prefix of `path`
/// that is a symlink (a reparse point on Windows) must have a trusted (or
/// unknown) owner. The final open resolves the path again, so this cannot
/// exclude races.
pub(crate) fn virtual_owner_walk(fs: &BlockingFs, path: &Path, trusted: &dyn Fn(u32) -> bool) -> io::Result<()> {
	let mut prefixes: Vec<PathBuf> = Vec::new();
	let mut current = Some(path);
	while let Some(p) = current {
		prefixes.push(p.to_path_buf());
		current = pi_vfs::parent_path(p).filter(|parent| parent.as_os_str().len() < p.as_os_str().len());
	}
	for prefix in prefixes.iter().rev() {
		match fs.symlink_metadata(prefix) {
			Ok(meta) if meta.is_symlink() => {
				if meta.uid().is_some_and(|uid| !trusted(uid)) {
					return Err(untrusted_symlink());
				}
			},
			// Missing or unreachable prefixes (a provider root, a mount)
			// have nothing to check; the open reports real failures.
			Ok(_) | Err(_) => {},
		}
	}
	Ok(())
}

/// Opens the operator-named directory `path` for traversal through the
/// trusted-owner walk (`--insecure-links`: a plain follow). Used for transfer
/// roots the operator named (3.5.0 BEHAVIOR CHANGES).
#[cfg(unix)]
pub(crate) fn open_operator_dir(
	path: &Path,
	insecure: bool,
	confine: Option<&Path>,
	trusted: &dyn Fn(u32) -> bool,
) -> io::Result<OwnedFd> {
	let bytes = trim_root(path.as_os_str().as_bytes());
	if insecure {
		return sys::openat(None, &sys::cstr(bytes)?, sys::TRAVERSE, 0);
	}
	let walk = OwnerWalk { confine, trusted };
	owner_walk_open(bytes, sys::TRAVERSE, 0, &walk)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn clean(name: &str, flags: u32) -> String {
		match clean_fname_flags(name.as_bytes(), flags) {
			Ok(v) => String::from_utf8(v).unwrap(),
			Err(v) => format!("ERR:{}", String::from_utf8(v).unwrap()),
		}
	}

	#[test]
	fn clean_fname_collapses_dot_dot_like_upstream() {
		for (input, want) in [
			("a/b/../c", "a/c"),
			("/x/y/../z", "/x/z"),
			("a/../b", "b"),
			("p/q/r/../../s", "p/s"),
			("d/e/..", "d"),
			("../x", "../x"),
			("a/../../x", "../x"),
			("/../x", "/x"),
			("a/b/../../..", ".."),
		] {
			assert_eq!(clean(input, CFN_COLLAPSE_DOT_DOT_DIRS), want, "{input}");
		}
	}

	#[test]
	fn clean_fname_basic_compaction() {
		for (input, flags, want) in [
			("a//b/./c/", 0, "a/b/c"),
			("./a", 0, "a"),
			("", 0, "."),
			("/", 0, "/"),
			("//a//", 0, "/a"),
			("a/.", 0, "a/."),
			("a/.", CFN_DROP_TRAILING_DOT_DIR, "a"),
			("a/b/", CFN_KEEP_TRAILING_SLASH, "a/b/"),
			("./a/./b", CFN_KEEP_DOT_DIRS, "./a/./b"),
			("a/../b", 0, "a/../b"),
			(".", 0, "."),
			("./", 0, "."),
		] {
			assert_eq!(clean(input, flags), want, "{input} {flags}");
		}
		assert_eq!(clean_fname(b"x//y/../z/", true), b"x/z");
		assert_eq!(clean_fname(b"x//y/../z/", false), b"x/y/../z");
	}

	#[test]
	fn clean_fname_refuse_reports_partially_compacted_buffer() {
		assert_eq!(clean("a/b", CFN_REFUSE_DOT_DOT_DIRS), "a/b");
		assert_eq!(clean("..", CFN_REFUSE_DOT_DOT_DIRS), "ERR:..");
		assert_eq!(clean("./a/../x", CFN_REFUSE_DOT_DOT_DIRS), "ERR:a/a/../x");
		assert_eq!(clean("a/..", CFN_REFUSE_DOT_DOT_DIRS), "ERR:a/..");
		// "..." and "..x" are ordinary names.
		assert_eq!(clean("a/.../..x", CFN_REFUSE_DOT_DOT_DIRS), "a/.../..x");
	}

	#[test]
	fn sanitize_path_table() {
		for (input, root, depth, want) in [
			("../../a/b", None, 0, "a/b"),
			("/etc/passwd", Some(&b""[..]), 0, "etc/passwd"),
			("/etc/passwd", Some(&b"/mod"[..]), 0, "/mod/etc/passwd"),
			("/etc/passwd", Some(&b"/"[..]), 0, "/etc/passwd"),
			("a/../../b", None, 0, "b"),
			("a/./b/", None, 0, "a/b/"),
			("a/.", None, 0, "a/"),
			("..", None, 1, ".."),
			("../../x", None, 1, "../x"),
			("../x/../../y", None, 1, "../y"),
			("./././", None, 0, "."),
			("", None, 0, "."),
			("/../x", Some(&b"/r"[..]), 3, "/r/x"),
		] {
			let got = sanitize_path(input.as_bytes(), root, depth);
			assert_eq!(String::from_utf8(got).unwrap(), want, "{input} {root:?} {depth}");
		}
		assert_eq!(sanitize_path_flags(b"./a/./b", None, 0, true), b"./a/./b");
	}

	#[test]
	fn received_names() {
		assert_eq!(check_received_name(b"a/b/c", false).unwrap(), b"a/b/c");
		assert_eq!(check_received_name(b"", false).unwrap(), b"");
		assert!(check_received_name(b"a/...b", false).is_ok());
		for bad in [&b"../x"[..], b"a/../b", b"a/..", b"/etc/passwd", b"a/./../b"] {
			let err = check_received_name(bad, false).unwrap_err();
			assert_eq!(err.code, RERR_UNSUPPORTED);
			assert_eq!(err.site, Some(("flist.c", 1079)));
		}
		let err = check_received_name(b"./a/../x", false).unwrap_err();
		assert_eq!(
			err.message.as_deref(),
			Some("ABORTING due to unsafe pathname from sender: a/a/../x")
		);
		assert_eq!(check_received_name(b"/abs//x/./y", true).unwrap(), b"/abs/x/y");
		assert!(check_received_name(b"/abs/../y", true).is_err());
	}

	#[test]
	fn unsafe_symlink_matches_upstream_table() {
		let pwd = "/home/user/work";
		let abs_src = format!("{pwd}/from/safe");
		let cases: &[(&str, &str, bool)] = &[
			("file", "from", false),
			("dir/file", "from", false),
			("dir/./file", "from", false),
			("dir/.", "from", false),
			("dir/", "from", false),
			("/etc/passwd", "from", true),
			("//../etc/passwd", "from", true),
			("//./etc/passwd", "from", true),
			("./foo", "from", false),
			("../foo", "from", true),
			("./../foo", "from", true),
			(".//../foo", "from", true),
			("./../foo", "from/..", true),
			("../dest", "from/dir", false),
			("../../dest", "from//dir", true),
			("..//../dest", "from/dir", true),
			("..", "from/file", false),
			("../..", "from/file", true),
			("..//..", "from//file", true),
			("dir/..", "from", true),
			("dir/../..", "from", true),
			("dir/..//..", "from", true),
			("", "from", true),
			("../../unsafe/unsafefile", "from/safe", true),
			("..//../unsafe/unsafefile", "from/safe", true),
			("../files/file1", "from/safe", false),
			("../../unsafe/unsafefile", "safe", true),
			("../files/file1", "safe", true),
			("../../unsafe/unsafefile", &abs_src, false),
			("../files/file1", &abs_src, false),
		];
		for &(target, src, want) in cases {
			assert_eq!(unsafe_symlink(target.as_bytes(), src.as_bytes()), want, "{target} {src}");
		}
	}

	#[test]
	fn confinement() {
		let root = Path::new("/srv/data");
		assert!(within_confine(Path::new("/srv/data"), root));
		assert!(within_confine(Path::new("/srv/data/x/y"), root));
		assert!(within_confine(Path::new("/srv/data/x"), Path::new("/srv/data/")));
		assert!(!within_confine(Path::new("/srv/database"), root));
		assert!(!within_confine(Path::new("/srv"), root));
		assert!(!within_confine(Path::new("/etc/passwd"), root));
		assert!(within_confine(Path::new("/anything"), Path::new("/")));
		assert!(within_confine(Path::new("/dev/fd"), root));
		assert!(!within_confine(Path::new("/dev/fd/notanumber"), root));
		assert_eq!(fd_pin_tail(b"/dev/stdin"), Some(&b"/0"[..]));
		assert_eq!(fd_pin_tail(b"/dev/stdinx"), None);
		assert_eq!(fd_pin_tail(b"/proc/self/fd/3"), Some(&b"/3"[..]));
		assert_eq!(fd_pin_tail(b"/proc/123/fd"), Some(&b""[..]));
		assert_eq!(fd_pin_tail(b"/proc/abc/fd"), None);
		assert!(is_exact_fd_pin(b"/dev/fd/12"));
		assert!(!is_exact_fd_pin(b"/dev/fd/12/x"));
		assert!(!is_exact_fd_pin(b"/dev/fd/"));
	}

	#[cfg(windows)]
	#[test]
	fn confinement_accepts_either_separator_on_windows() {
		let root = Path::new(r"C:\data\jail");
		assert!(within_confine(Path::new(r"C:\data\jail\x\y"), root));
		assert!(within_confine(Path::new("C:/data/jail/x"), root));
		assert!(!within_confine(Path::new(r"C:\data\jailbreak"), root));
		assert!(!within_confine(Path::new(r"C:\data"), root));
		assert_eq!(&*path_bytes(Path::new(r"a\b/c")), b"a/b/c");
	}

	#[cfg(unix)]
	mod walk {
	use std::{fs, os::unix::fs::symlink};

	use super::*;

	fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let real = fs::canonicalize(dir.path()).unwrap();
		(dir, real)
	}

	fn walk_bytes(path: &Path, trusted: &dyn Fn(u32) -> bool, flags: libc::c_int) -> io::Result<OwnedFd> {
		let walk = OwnerWalk { confine: None, trusted };
		owner_walk_open(path.as_os_str().as_bytes(), flags, 0o600, &walk)
	}

	#[test]
	fn operator_walk_follows_own_symlinks_and_refuses_untrusted_ones() {
		let (_guard, base) = canonical_tempdir();
		fs::create_dir(base.join("real")).unwrap();
		fs::write(base.join("real/rules"), b"- *.o\n").unwrap();
		symlink("real", base.join("link")).unwrap();
		symlink("rules", base.join("real/leaf")).unwrap();

		// Our own symlinks (parent and leaf) are followed.
		let fd = walk_bytes(&base.join("link/leaf"), &trusted_owner, libc::O_RDONLY).unwrap();
		let text = std::io::read_to_string(std::fs::File::from(fd)).unwrap();
		assert_eq!(text, "- *.o\n");

		// A walk that trusts only root rejects our symlinks: parent component…
		let only_root = |uid: u32| uid == 0;
		let err = walk_bytes(&base.join("link/rules"), &only_root, libc::O_RDONLY).unwrap_err();
		assert!(is_untrusted_symlink(&err));
		assert_eq!(os_errno(&err), Some(libc::ELOOP));
		// …and leaf.
		let err = walk_bytes(&base.join("real/leaf"), &only_root, libc::O_RDONLY).unwrap_err();
		assert!(is_untrusted_symlink(&err));
		// Real directories still work under the strict rule.
		assert!(walk_bytes(&base.join("real/rules"), &only_root, libc::O_RDONLY).is_ok());
	}

	#[test]
	fn operator_walk_creates_and_refuses_untrusted_parent_for_writes() {
		let (_guard, base) = canonical_tempdir();
		fs::create_dir(base.join("logs")).unwrap();
		fs::create_dir(base.join("victim")).unwrap();
		symlink("victim", base.join("planted")).unwrap();
		let only_root = |uid: u32| uid == 0;
		let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_APPEND;
		walk_bytes(&base.join("logs/new.log"), &only_root, flags).unwrap();
		assert!(base.join("logs/new.log").exists());
		let err = walk_bytes(&base.join("planted/evil.log"), &only_root, flags).unwrap_err();
		assert!(is_untrusted_symlink(&err));
		assert!(!base.join("victim/evil.log").exists());
	}

	#[test]
	fn operator_walk_errors() {
		let (_guard, base) = canonical_tempdir();
		fs::write(base.join("file"), b"x").unwrap();
		let err = walk_bytes(&base.join("file/x"), &trusted_owner, libc::O_RDONLY).unwrap_err();
		assert_eq!(err.raw_os_error(), Some(libc::ENOTDIR));
		// A directory leaf opens like upstream's openat(); a path that ends in
		// a slash resolves to a directory and needs O_DIRECTORY.
		assert!(walk_bytes(&base, &trusted_owner, libc::O_RDONLY).is_ok());
		let mut slashed = base.clone().into_os_string();
		slashed.push("/");
		let err = walk_bytes(Path::new(&slashed), &trusted_owner, libc::O_RDONLY).unwrap_err();
		assert_eq!(err.raw_os_error(), Some(libc::EISDIR));
		assert!(
			walk_bytes(Path::new(&slashed), &trusted_owner, libc::O_RDONLY | libc::O_DIRECTORY)
				.is_ok()
		);
		let err = walk_bytes(&base.join("missing"), &trusted_owner, libc::O_RDONLY).unwrap_err();
		assert_eq!(err.raw_os_error(), Some(libc::ENOENT));
		symlink("loop", base.join("loop")).unwrap();
		let err = walk_bytes(&base.join("loop"), &trusted_owner, libc::O_RDONLY).unwrap_err();
		assert_eq!(err.raw_os_error(), Some(libc::ELOOP));
	}

	#[test]
	fn operator_walk_confine_root() {
		let (_guard, base) = canonical_tempdir();
		fs::create_dir(base.join("jail")).unwrap();
		fs::write(base.join("secret"), b"s").unwrap();
		fs::write(base.join("jail/ok"), b"o").unwrap();
		symlink("../secret", base.join("jail/escape")).unwrap();
		let jail = base.join("jail");
		let walk = OwnerWalk { confine: Some(&jail), trusted: &trusted_owner };
		let open = |p: &Path| owner_walk_open(p.as_os_str().as_bytes(), libc::O_RDONLY, 0, &walk);
		assert!(open(&jail.join("ok")).is_ok());
		let err = open(&jail.join("escape")).unwrap_err();
		assert_eq!(err.raw_os_error(), Some(libc::ELOOP));
		let err = open(&base.join("secret")).unwrap_err();
		assert_eq!(err.raw_os_error(), Some(libc::ELOOP));
	}

	#[test]
	fn operator_file_helpers_round_trip() {
		let (_guard, base) = canonical_tempdir();
		let vfs = BlockingFs::native();
		let log = base.join("run.log");
		{
			let mut file = create_operator_file(&vfs, &log, true, false).unwrap();
			std::io::Write::write_all(&mut file, b"one\n").unwrap();
		}
		{
			let mut file = create_operator_file(&vfs, &log, true, false).unwrap();
			std::io::Write::write_all(&mut file, b"two\n").unwrap();
		}
		let file = open_operator_file(&vfs, &log, false).unwrap();
		assert!(batch_input_ok(&file).unwrap());
		assert_eq!(fs::read(&log).unwrap(), b"one\ntwo\n");
		let batch = base.join("batch");
		{
			let mut file = create_operator_file(&vfs, &batch, false, false).unwrap();
			std::io::Write::write_all(&mut file, b"long contents").unwrap();
		}
		{
			let mut file = create_operator_file(&vfs, &batch, false, false).unwrap();
			std::io::Write::write_all(&mut file, b"short").unwrap();
		}
		assert_eq!(fs::read(&batch).unwrap(), b"short");
		let dir = open_operator_file(&vfs, &base, false).unwrap();
		assert!(!batch_input_ok(&dir).unwrap());
	}
	}
}
