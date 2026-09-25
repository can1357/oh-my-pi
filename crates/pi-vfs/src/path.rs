//! URL-aware lexical path helpers.
//!
//! A virtual path is spelled `scheme://rest` where `scheme` is an RFC 3986
//! scheme of at least two characters (so `C://x` stays a Windows drive path).
//! `scheme://` is the URL root: the first segment after it is an ordinary
//! child (`skill://name` is a directory under `skill://`), `..` never climbs
//! above it, and `/` is the only separator. Host paths behave exactly like
//! the corresponding `std::path` operations.

use std::{
	borrow::Cow,
	ffi::{OsStr, OsString},
	path::{Component, Path, PathBuf},
};

/// Length in bytes of the `scheme://` root of `path`, if it is a URL.
pub(crate) fn url_root_len(path: &Path) -> Option<usize> {
	let bytes = path.as_os_str().as_encoded_bytes();
	let colon = bytes.iter().position(|&b| b == b':')?;
	if colon < 2 || !bytes[0].is_ascii_alphabetic() {
		return None;
	}
	if !bytes[1..colon]
		.iter()
		.all(|&b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
	{
		return None;
	}
	bytes[colon..].starts_with(b"://").then_some(colon + 3)
}

/// The scheme of a URL path (`local` for `local://x`), or `None` for host
/// paths.
pub fn url_scheme(path: &Path) -> Option<&str> {
	let root = url_root_len(path)?;
	std::str::from_utf8(&path.as_os_str().as_encoded_bytes()[..root - 3]).ok()
}

/// Whether `path` is spelled as a `scheme://` URL.
pub fn is_virtual_path(path: &Path) -> bool {
	url_root_len(path).is_some()
}

/// Borrows `path[start..end]` as a path.
///
/// Callers only split at ASCII `/` boundaries or at a URL root, both of which
/// are valid split points for the platform's encoded bytes.
fn subpath(path: &Path, end: usize) -> &Path {
	let bytes = &path.as_os_str().as_encoded_bytes()[..end];
	#[cfg(unix)]
	{
		use std::os::unix::ffi::OsStrExt;
		Path::new(OsStr::from_bytes(bytes))
	}
	#[cfg(not(unix))]
	{
		// SAFETY: `bytes` is a prefix of `path`'s encoded bytes that ends either at
		// the end of the string or immediately before an ASCII '/' (or right after
		// the ASCII `scheme://` root), which the `from_encoded_bytes_unchecked`
		// contract permits as a split point.
		Path::new(unsafe { OsStr::from_encoded_bytes_unchecked(bytes) })
	}
}

fn url_segments(path: &Path, root: usize) -> impl Iterator<Item = &OsStr> {
	let bytes = &path.as_os_str().as_encoded_bytes()[root..];
	bytes
		.split(|&b| b == b'/')
		.filter(|seg| !seg.is_empty())
		.map(|seg| {
			#[cfg(unix)]
			{
				use std::os::unix::ffi::OsStrExt;
				OsStr::from_bytes(seg)
			}
			#[cfg(not(unix))]
			{
				// SAFETY: `seg` is delimited by ASCII '/' bytes (or the string ends) inside
				// `path`'s encoded bytes, a permitted split point.
				unsafe { OsStr::from_encoded_bytes_unchecked(seg) }
			}
		})
}

/// Resolves `path` against the shell working directory `cwd` lexically.
///
/// URL and absolute host paths are returned unchanged; a relative path under
/// a URL working directory is joined with `/`. Nothing touches the process
/// working directory or the filesystem.
pub fn absolute_path(cwd: &Path, path: &Path) -> PathBuf {
	if is_virtual_path(path) || path.is_absolute() {
		return path.to_path_buf();
	}
	join_path(cwd, path)
}

/// Bytes a raw name must not carry literally inside a URL segment: C0
/// controls, space, DEL, and the characters WHATWG URL parsing treats
/// specially (`%` included so decoding is exact).
const fn needs_escape(byte: u8) -> bool {
	byte < 0x20
		|| byte == 0x7f
		|| matches!(
			byte,
			b' '
				| b'"' | b'#'
				| b'%' | b'<'
				| b'>' | b'?'
				| b'[' | b'\\'
				| b']' | b'^'
				| b'`' | b'{'
				| b'|' | b'}'
		)
}

const fn hex_value(byte: u8) -> Option<u8> {
	match byte {
		b'0'..=b'9' => Some(byte - b'0'),
		b'a'..=b'f' => Some(byte - b'a' + 10),
		b'A'..=b'F' => Some(byte - b'A' + 10),
		_ => None,
	}
}

/// `name[start..end]` where both bounds are string ends or sit next to ASCII
/// bytes.
fn subslice(name: &OsStr, start: usize, end: usize) -> &OsStr {
	let bytes = &name.as_encoded_bytes()[start..end];
	#[cfg(unix)]
	{
		use std::os::unix::ffi::OsStrExt;
		OsStr::from_bytes(bytes)
	}
	#[cfg(not(unix))]
	{
		// SAFETY: `start`/`end` are string bounds or positions adjacent to ASCII
		// bytes, which are permitted split points of the platform encoding.
		unsafe { OsStr::from_encoded_bytes_unchecked(bytes) }
	}
}

fn os_from_bytes(bytes: Vec<u8>) -> OsString {
	#[cfg(unix)]
	{
		use std::os::unix::ffi::OsStringExt;
		OsString::from_vec(bytes)
	}
	#[cfg(not(unix))]
	{
		match String::from_utf8(bytes) {
			Ok(text) => text.into(),
			Err(err) => String::from_utf8_lossy(err.as_bytes()).into_owned().into(),
		}
	}
}

/// Percent-encodes a raw name for use as one URL path segment (see
/// [`child_path`]); borrowed when nothing needs escaping.
pub fn encode_segment(name: &OsStr) -> Cow<'_, OsStr> {
	const HEX: &[u8; 16] = b"0123456789ABCDEF";
	let bytes = name.as_encoded_bytes();
	if !bytes.iter().any(|&byte| needs_escape(byte)) {
		return Cow::Borrowed(name);
	}
	let mut out = OsString::with_capacity(bytes.len() + 8);
	let mut start = 0;
	for (i, &byte) in bytes.iter().enumerate() {
		if !needs_escape(byte) {
			continue;
		}
		out.push(subslice(name, start, i));
		let escape = [b'%', HEX[usize::from(byte >> 4)], HEX[usize::from(byte & 0xf)]];
		out.push(std::str::from_utf8(&escape).unwrap_or_default());
		start = i + 1;
	}
	out.push(subslice(name, start, bytes.len()));
	Cow::Owned(out)
}

/// Decodes `%XX` escapes of one URL path segment exactly once; malformed
/// escapes stay literal.
pub fn decode_segment(segment: &OsStr) -> Cow<'_, OsStr> {
	let bytes = segment.as_encoded_bytes();
	if !bytes.contains(&b'%') {
		return Cow::Borrowed(segment);
	}
	let mut out = Vec::with_capacity(bytes.len());
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'%'
			&& let (Some(high), Some(low)) = (
				bytes.get(i + 1).copied().and_then(hex_value),
				bytes.get(i + 2).copied().and_then(hex_value),
			) {
			out.push((high << 4) | low);
			i += 3;
		} else {
			out.push(bytes[i]);
			i += 1;
		}
	}
	Cow::Owned(os_from_bytes(out))
}

/// Appends an already-spelled segment (or `/`-separated segments) to a URL
/// with exactly one separator.
fn push_url(base: &Path, spelled: &OsStr) -> PathBuf {
	let mut out = OsString::from(base.as_os_str());
	if spelled.is_empty() {
		return out.into();
	}
	if !base.as_os_str().as_encoded_bytes().ends_with(b"/") {
		out.push("/");
	}
	out.push(spelled);
	out.into()
}

fn ends_with_separator(path: &Path) -> bool {
	let bytes = path.as_os_str().as_encoded_bytes();
	bytes
		.last()
		.is_some_and(|&last| last == b'/' || (cfg!(windows) && last == b'\\'))
}

/// URL-aware [`Path::join`].
///
/// A URL, rooted, or prefixed `rel` replaces `base` (as with `Path::join`).
/// Under a URL `base`, each component of the raw relative path becomes one
/// percent-encoded segment ([`encode_segment`]) joined with `/`, so
/// `scheme://` is never collapsed; a trailing separator is kept.
pub fn join_path(base: &Path, rel: &Path) -> PathBuf {
	if is_virtual_path(rel) {
		return rel.to_path_buf();
	}
	if !is_virtual_path(base) {
		return base.join(rel);
	}
	if rel.has_root() || matches!(rel.components().next(), Some(Component::Prefix(_))) {
		return rel.to_path_buf();
	}
	if rel.as_os_str().is_empty() {
		// `Path::join("")` appends a separator; keep that directory spelling.
		let mut out = OsString::from(base.as_os_str());
		if !base.as_os_str().as_encoded_bytes().ends_with(b"/") {
			out.push("/");
		}
		return out.into();
	}
	let mut spelled = OsString::with_capacity(rel.as_os_str().len());
	for component in rel.components() {
		if !spelled.is_empty() {
			spelled.push("/");
		}
		match component {
			Component::Normal(name) => spelled.push(encode_segment(name)),
			other => spelled.push(other.as_os_str()),
		}
	}
	if ends_with_separator(rel) && !spelled.is_empty() {
		spelled.push("/");
	}
	push_url(base, &spelled)
}

/// Path of the directory entry named `name` (raw) inside `dir`: host
/// directories use [`Path::join`]; URL directories append one
/// percent-encoded segment. [`crate::DirEntry::file_name`] keeps the raw name.
pub fn child_path(dir: &Path, name: &OsStr) -> PathBuf {
	if is_virtual_path(dir) {
		push_url(dir, &encode_segment(name))
	} else {
		dir.join(name)
	}
}

/// URL-aware [`Path::parent`].
///
/// `parent_path("local://out") == Some("local://")`,
/// `parent_path("skill://a/b") == Some("skill://a")`, and the URL root
/// `local://` has no parent.
pub fn parent_path(path: &Path) -> Option<&Path> {
	let Some(root) = url_root_len(path) else {
		return path.parent();
	};
	let bytes = path.as_os_str().as_encoded_bytes();
	let mut end = bytes.len();
	while end > root && bytes[end - 1] == b'/' {
		end -= 1;
	}
	if end == root {
		return None;
	}
	let Some(slash) = bytes[root..end].iter().rposition(|&b| b == b'/') else {
		return Some(subpath(path, root));
	};
	let mut parent_end = root + slash;
	while parent_end > root && bytes[parent_end - 1] == b'/' {
		parent_end -= 1;
	}
	Some(subpath(path, parent_end))
}

/// URL-aware [`Path::file_name`]: the raw (percent-decoded) last segment,
/// or `None` for a URL root or a trailing `..`. Host paths are borrowed
/// unchanged.
pub fn file_name(path: &Path) -> Option<Cow<'_, OsStr>> {
	let Some(root) = url_root_len(path) else {
		return path.file_name().map(Cow::Borrowed);
	};
	match url_segments(path, root).last() {
		Some(name) if name != ".." => Some(decode_segment(name)),
		_ => None,
	}
}

/// URL-aware [`Path::with_file_name`]; under a URL the raw `name` is
/// percent-encoded as one segment.
pub fn with_file_name(path: &Path, name: impl AsRef<OsStr>) -> PathBuf {
	let name = name.as_ref();
	if url_root_len(path).is_none() {
		return path.with_file_name(name);
	}
	push_url(parent_path(path).unwrap_or(path), &encode_segment(name))
}

/// Lexical spelling of `path` relative to the directory `base`, or `None`
/// when their roots differ.
///
/// Matches `uucore::fs::make_path_relative_to` (byte-identical for host
/// paths): shared leading components are dropped, each remaining `base`
/// component becomes `..`, and equal paths give `.`. Roots differ for
/// different `scheme://` roots, a URL against a host path, or host paths with
/// different prefixes/roots. URL segments keep their encoded spelling.
pub fn relative_path(path: &Path, base: &Path) -> Option<PathBuf> {
	match (url_root_len(path), url_root_len(base)) {
		(None, None) => {
			fn root(path: &Path) -> Vec<Component<'_>> {
				path
					.components()
					.take_while(|c| matches!(c, Component::Prefix(_) | Component::RootDir))
					.collect()
			}
			if root(path) != root(base) {
				return None;
			}
			let common = path
				.components()
				.zip(base.components())
				.take_while(|(a, b)| a == b)
				.count();
			let mut parts: Vec<&OsStr> = base
				.components()
				.skip(common)
				.map(|_| Component::ParentDir.as_os_str())
				.chain(path.components().skip(common).map(Component::as_os_str))
				.collect();
			if parts.is_empty() {
				parts.push(Component::CurDir.as_os_str());
			}
			Some(parts.iter().collect())
		},
		(Some(path_root), Some(base_root)) => {
			let bytes = |p: &Path, root: usize| p.as_os_str().as_encoded_bytes()[..root].to_vec();
			if bytes(path, path_root) != bytes(base, base_root) {
				return None;
			}
			let path_segments: Vec<&OsStr> = url_segments(path, path_root).collect();
			let base_segments: Vec<&OsStr> = url_segments(base, base_root).collect();
			let common = path_segments
				.iter()
				.zip(&base_segments)
				.take_while(|(a, b)| a == b)
				.count();
			let mut out = OsString::new();
			let parts = base_segments[common..]
				.iter()
				.map(|_| OsStr::new(".."))
				.chain(path_segments[common..].iter().copied());
			for part in parts {
				if !out.is_empty() {
					out.push("/");
				}
				out.push(part);
			}
			if out.is_empty() {
				out.push(".");
			}
			Some(out.into())
		},
		_ => None,
	}
}

/// Resolves `.` and `..` lexically without consulting the filesystem.
///
/// URL roots are preserved and never climbed above; host paths keep their
/// prefix/root, and `..` at a host root stays at the root. Leading `..` of a
/// relative path are kept. An empty result is `.`.
pub fn normalize_lexically(path: &Path) -> PathBuf {
	if let Some(root) = url_root_len(path) {
		let mut segments: Vec<&OsStr> = Vec::new();
		for seg in url_segments(path, root) {
			match seg.as_encoded_bytes() {
				b"." => {},
				b".." => {
					segments.pop();
				},
				_ => segments.push(seg),
			}
		}
		let mut out = OsString::from(subpath(path, root).as_os_str());
		for (i, seg) in segments.iter().enumerate() {
			if i > 0 {
				out.push("/");
			}
			out.push(seg);
		}
		return out.into();
	}

	let mut out = PathBuf::new();
	let mut normal_depth = 0usize;
	for component in path.components() {
		match component {
			Component::Prefix(_) | Component::RootDir => out.push(component.as_os_str()),
			Component::CurDir => {},
			Component::ParentDir => {
				if normal_depth > 0 {
					out.pop();
					normal_depth -= 1;
				} else if !out.has_root() {
					out.push("..");
				}
			},
			Component::Normal(name) => {
				out.push(name);
				normal_depth += 1;
			},
		}
	}
	if out.as_os_str().is_empty() {
		out.push(".");
	}
	out
}

/// One lexical step of a path, with URL and host roots unified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Part {
	/// `/`, `C:\`, or `scheme://`; resets the path being built.
	Root(PathBuf),
	Cur,
	Parent,
	Normal(OsString),
}

/// Splits a path into [`Part`]s, treating `scheme://` as a root.
pub(crate) fn parts(path: &Path) -> Vec<Part> {
	let mut out = Vec::new();
	if let Some(root) = url_root_len(path) {
		out.push(Part::Root(subpath(path, root).to_path_buf()));
		for seg in url_segments(path, root) {
			out.push(match seg.as_encoded_bytes() {
				b"." => Part::Cur,
				b".." => Part::Parent,
				_ => Part::Normal(seg.to_os_string()),
			});
		}
		return out;
	}
	let mut root: Option<PathBuf> = None;
	for component in path.components() {
		match component {
			Component::Prefix(_) | Component::RootDir => {
				root
					.get_or_insert_with(PathBuf::new)
					.push(component.as_os_str());
				continue;
			},
			_ => {},
		}
		if let Some(root) = root.take() {
			out.push(Part::Root(root));
		}
		out.push(match component {
			Component::CurDir => Part::Cur,
			Component::ParentDir => Part::Parent,
			Component::Normal(name) => Part::Normal(name.to_os_string()),
			Component::Prefix(_) | Component::RootDir => continue,
		});
	}
	if let Some(root) = root {
		out.push(Part::Root(root));
	}
	out
}

/// A path under construction from [`Part`]s; `..` never pops its root.
#[derive(Debug, Default)]
pub(crate) struct PathBuilder {
	root:     Option<PathBuf>,
	url:      bool,
	segments: Vec<OsString>,
}

impl PathBuilder {
	pub(crate) fn set_root(&mut self, root: PathBuf) {
		self.url = is_virtual_path(&root);
		self.root = Some(root);
		self.segments.clear();
	}

	pub(crate) fn push(&mut self, segment: OsString) {
		self.segments.push(segment);
	}

	pub(crate) fn pop(&mut self) {
		self.segments.pop();
	}

	pub(crate) fn to_path(&self) -> PathBuf {
		if self.url {
			let mut out = self
				.root
				.clone()
				.map(PathBuf::into_os_string)
				.unwrap_or_default();
			for (i, seg) in self.segments.iter().enumerate() {
				if i > 0 {
					out.push("/");
				}
				out.push(seg);
			}
			return out.into();
		}
		let mut out = self.root.clone().unwrap_or_default();
		for seg in &self.segments {
			out.push(seg);
		}
		out
	}
}
