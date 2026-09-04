//! Shared model-path normalization for workspace tools.

use std::{
	borrow::Cow,
	env,
	path::{Component, Path, PathBuf},
};

use omp_core::Str;
use url::Url;
use xutf::IntoUnicodeNormalized as _;

/// Host path vocabulary used for platform-specific aliases.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostPaths {
	/// POSIX path spelling.
	Posix,
	/// Windows drive, UNC, and extended-length spelling.
	Windows,
}
/// Returns bounded-safe path metadata for tracing without URL credentials,
/// query parameters, or fragments.
pub(crate) fn tracing_path_metadata(input: &str) -> Cow<'_, str> {
	if !input.contains("://") {
		return Cow::Borrowed(input);
	}
	if input.contains([';', ',']) {
		return Cow::Borrowed("<multiple targets>");
	}
	let Ok(mut url) = Url::parse(input) else {
		return Cow::Borrowed("<url>");
	};
	let _ = url.set_username("");
	let _ = url.set_password(None);
	url.set_query(None);
	url.set_fragment(None);
	if url.scheme() != "file" {
		url.set_path("");
	}
	Cow::Owned(url.into())
}

impl HostPaths {
	/// Returns the current host path vocabulary.
	pub const fn current() -> Self {
		if cfg!(windows) {
			Self::Windows
		} else {
			Self::Posix
		}
	}
}

/// Aggregate approval tier for a document mutation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileWriteApproval {
	/// Every target is a read-tier internal resource.
	Read,
	/// At least one target mutates workspace or writable internal state.
	Write,
}

/// Resolves one multi-target write without trusting the first authored path.
///
/// `writable_internal` is supplied by the resource router so schemes such as
/// `vault://` retain write approval while read-only session URLs remain read
/// tier. An empty target set fails closed as write.
pub fn aggregate_file_write_approval<'a>(
	targets: impl IntoIterator<Item = &'a str>,
	writable_internal: impl Fn(&str) -> bool,
) -> FileWriteApproval {
	let mut any = false;
	for target in targets {
		any = true;
		if !is_internal_resource(target) || writable_internal(target) {
			return FileWriteApproval::Write;
		}
	}
	if any {
		FileWriteApproval::Read
	} else {
		FileWriteApproval::Write
	}
}

fn is_internal_resource(target: &str) -> bool {
	let Some((scheme, _)) = target.trim().split_once("://") else {
		return false;
	};
	matches!(
		scheme.to_ascii_lowercase().as_str(),
		"agent"
			| "artifact"
			| "history"
			| "issue"
			| "local"
			| "mcp"
			| "memory"
			| "pr" | "rule"
			| "security"
			| "skill"
			| "vault"
	)
}

/// One model-authored target after the shared lexical recovery pass.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NormalizedTarget {
	/// Exact text supplied by the model, before trimming or repair.
	pub authored:  Str,
	/// Recovered path/URI spelling passed to selector parsing.
	pub canonical: Str,
}

impl NormalizedTarget {
	/// Reports whether recovery changed the authored spelling.
	pub fn recovered(&self) -> bool {
		self.authored != self.canonical
	}

	/// Returns filesystem spellings used only after the canonical spelling is
	/// missing.
	pub fn recovery_candidates(&self) -> Vec<Str> {
		let mut candidates = Vec::new();
		let screenshot = self
			.canonical
			.replace(" AM.", "\u{202f}AM.")
			.replace(" PM.", "\u{202f}PM.");
		if screenshot != self.canonical {
			candidates.push(Str::from(screenshot));
		}
		if self.canonical.contains('\'') {
			candidates.push(Str::from(self.canonical.replace('\'', "\u{2019}")));
		}
		candidates
	}

	/// Returns a model-facing recovery notice when the target changed.
	pub fn recovery_notice(&self) -> Option<Str> {
		self.recovered().then(|| {
			Str::from(format!(
				"Resolved authored target `{}` to canonical target `{}`.",
				self.authored, self.canonical
			))
		})
	}
}

/// Normalizes one model-authored path before any selector parsing.
///
/// The pass is deliberately lexical: it never stats the target and therefore
/// behaves identically for reads, writes, and edits. Filesystem owners remain
/// responsible for canonical containment and symlink policy.
pub fn normalize_target(input: &str, home: Option<&Path>, host: HostPaths) -> NormalizedTarget {
	let authored = Str::new(input);
	let mut path = trim_outer_quotes(input.trim());
	path = strip_stray_prefix(path);

	let mut normalized = normalize_spaces_and_quotes(path);
	if let Some(without_at) = normalized.strip_prefix('@')
		&& at_prefix_is_shorthand(without_at)
	{
		normalized = without_at.to_owned();
	}
	normalized = strip_extended_windows_prefix(&normalized);
	normalized = strip_file_url(&normalized).unwrap_or(normalized);
	normalized = shell_unescape(&normalized);
	normalized = normalized.into_nfc();
	normalized = expand_home(&normalized, home);
	if host == HostPaths::Windows {
		normalized = windows_drive_alias(&normalized).unwrap_or(normalized);
	}
	NormalizedTarget { authored, canonical: Str::from(normalized) }
}

fn trim_outer_quotes(input: &str) -> &str {
	let Some(first) = input.chars().next() else {
		return input;
	};
	let Some(last) = input.chars().next_back() else {
		return input;
	};
	let paired = matches!(
		(first, last),
		('"', '"') | ('\'', '\'') | ('\u{2018}' | '\u{2019}', '\u{2019}') | ('\u{201c}', '\u{201d}')
	);
	if paired && input.len() > first.len_utf8() + last.len_utf8() {
		&input[first.len_utf8()..input.len() - last.len_utf8()]
	} else {
		input
	}
}

fn strip_stray_prefix(input: &str) -> &str {
	let Some(rest) = input.strip_prefix(':') else {
		return input;
	};
	let path_like = rest.starts_with(['/', '\\', '~'])
		|| rest.starts_with("./")
		|| rest.starts_with("../")
		|| rest.starts_with(".\\")
		|| rest.starts_with("..\\")
		|| is_windows_drive(rest);
	if path_like { rest } else { input }
}

fn normalize_spaces_and_quotes(input: &str) -> String {
	let mut output = String::with_capacity(input.len());
	for character in input.chars() {
		match character {
			'\u{00a0}' | '\u{2000}'..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}' => {
				output.push(' ');
			},
			'\u{2018}' | '\u{2019}' => output.push('\''),
			'\u{201c}' | '\u{201d}' => output.push('"'),
			_ => output.push(character),
		}
	}
	output
}

fn at_prefix_is_shorthand(input: &str) -> bool {
	input.starts_with('/')
		|| input.starts_with('\\')
		|| input == "~"
		|| input.starts_with("~/")
		|| input.starts_with("~\\")
		|| is_windows_drive(input)
		|| [
			"agent://",
			"artifact://",
			"history://",
			"skill://",
			"rule://",
			"security://",
			"local:",
			"mcp://",
		]
		.iter()
		.any(|prefix| input.starts_with(prefix))
}

fn strip_extended_windows_prefix(input: &str) -> String {
	if let Some(rest) = input
		.strip_prefix(r"\\?\UNC\")
		.or_else(|| input.strip_prefix(r"\\.\UNC\"))
	{
		format!(r"\\{rest}")
	} else if let Some(rest) = input
		.strip_prefix(r"\\?\")
		.or_else(|| input.strip_prefix(r"\\.\"))
	{
		rest.to_owned()
	} else {
		input.to_owned()
	}
}

fn strip_file_url(input: &str) -> Option<String> {
	if !input
		.get(..7)
		.is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://"))
	{
		return None;
	}
	let parsed = Url::parse(input).ok()?;
	if parsed.scheme() != "file" {
		return None;
	}
	if let Ok(path) = parsed.to_file_path() {
		return Some(path.to_string_lossy().into_owned());
	}
	let mut path = percent_decode_path(parsed.path())?;
	if path.starts_with('/') && path.get(1..).is_some_and(is_windows_drive) {
		path.remove(0);
	}
	if let Some(host) = parsed
		.host_str()
		.filter(|host| !host.eq_ignore_ascii_case("localhost"))
	{
		return Some(format!(r"\\{host}{}", path.replace('/', r"\")));
	}
	Some(path)
}

fn percent_decode_path(input: &str) -> Option<String> {
	let mut output = Vec::with_capacity(input.len());
	let bytes = input.as_bytes();
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] == b'%' {
			let encoded = bytes.get(index + 1..index + 3)?;
			let high = hex_digit(encoded[0])?;
			let low = hex_digit(encoded[1])?;
			output.push((high << 4) | low);
			index += 3;
		} else {
			output.push(bytes[index]);
			index += 1;
		}
	}
	String::from_utf8(output).ok()
}

const fn hex_digit(byte: u8) -> Option<u8> {
	match byte {
		b'0'..=b'9' => Some(byte - b'0'),
		b'a'..=b'f' => Some(byte - b'a' + 10),
		b'A'..=b'F' => Some(byte - b'A' + 10),
		_ => None,
	}
}

fn shell_unescape(input: &str) -> String {
	if !input.contains('\\') || !input.contains('/') {
		return input.to_owned();
	}
	let mut output = String::with_capacity(input.len());
	let mut characters = input.chars().peekable();
	while let Some(character) = characters.next() {
		if character == '\\'
			&& characters.peek().is_some_and(|next| {
				matches!(next, ' ' | '\t' | '"' | '\'' | '(' | ')' | '{' | '}' | '[' | ']')
			}) {
			output.push(characters.next().expect("peeked escaped character"));
		} else {
			output.push(character);
		}
	}
	output
}

fn expand_home(input: &str, home: Option<&Path>) -> String {
	if !input.starts_with('~') {
		return input.to_owned();
	}
	let home = home
		.map(Path::to_path_buf)
		.or_else(|| env::var_os("HOME").map(PathBuf::from))
		.or_else(|| env::var_os("USERPROFILE").map(PathBuf::from));
	let Some(mut home) = home else {
		return input.to_owned();
	};
	if input != "~" {
		let tail = input
			.strip_prefix("~/")
			.or_else(|| input.strip_prefix("~\\"))
			.unwrap_or(&input[1..]);
		home.push(tail);
	}
	home.to_string_lossy().into_owned()
}

fn windows_drive_alias(input: &str) -> Option<String> {
	let normalized = input.replace('\\', "/");
	let parts = normalized.split('/').collect::<Vec<_>>();
	let (drive, tail) = match parts.as_slice() {
		["", drive, tail @ ..] if one_drive_letter(drive) => (*drive, tail),
		["", mnt, drive, tail @ ..] if mnt.eq_ignore_ascii_case("mnt") && one_drive_letter(drive) => {
			(*drive, tail)
		},
		_ => return None,
	};
	let mut output = String::with_capacity(input.len() + 1);
	output.push(drive.as_bytes()[0].to_ascii_uppercase().into());
	output.push_str(r":\");
	output.push_str(
		&tail
			.iter()
			.filter(|part| !part.is_empty())
			.copied()
			.collect::<Vec<_>>()
			.join(r"\"),
	);
	Some(output)
}

const fn one_drive_letter(input: &str) -> bool {
	input.len() == 1 && input.as_bytes()[0].is_ascii_alphabetic()
}

const fn is_windows_drive(input: &str) -> bool {
	input.len() >= 2 && input.as_bytes()[0].is_ascii_alphabetic() && input.as_bytes()[1] == b':'
}

/// A colon selector split from its path without mistaking Windows drive syntax.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PathSelector {
	/// Path spelling with the selector suffix removed.
	pub path:     Str,
	/// Trailing selector expression when present.
	pub selector: Option<Str>,
}
/// Splits a trailing colon selector while retaining `C:` and `C:\...` drives.
pub fn split_colon_selector(input: &str) -> PathSelector {
	let drive_end = usize::from(
		input.len() >= 2 && input.as_bytes()[0].is_ascii_alphabetic() && input.as_bytes()[1] == b':',
	) * 2;
	let selector = input[drive_end..]
		.find(':')
		.map(|index| drive_end + index)
		.filter(|index| !input[index + 1..].is_empty());
	match selector {
		Some(index) => PathSelector {
			path:     Str::new(&input[..index]),
			selector: Some(Str::new(&input[index + 1..])),
		},
		None => PathSelector { path: Str::new(input), selector: None },
	}
}
/// Resolves a model-facing workspace path without permitting traversal outside
/// `root`.
pub fn confined(root: &Path, input: &str) -> Result<PathBuf, PathError> {
	let candidate = Path::new(input);
	if candidate.is_absolute() {
		return Err(PathError::Absolute);
	}
	let mut resolved = PathBuf::from(root);
	for component in candidate.components() {
		match component {
			Component::Normal(part) => resolved.push(part),
			Component::CurDir => {},
			Component::ParentDir => {
				if resolved == root {
					return Err(PathError::Escape);
				}
				resolved.pop();
			},
			Component::RootDir | Component::Prefix(_) => return Err(PathError::Absolute),
		}
	}
	Ok(resolved)
}
/// Path normalization rejection.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum PathError {
	/// An absolute input cannot be confined to the workspace root.
	#[error("absolute paths are outside the workspace")]
	Absolute,
	/// Parent traversal would escape the workspace root.
	#[error("path escapes the workspace")]
	Escape,
}

#[cfg(test)]
mod tests {
	use omp_core::sf;

	use super::*;
	#[test]
	fn preserves_windows_drive_while_splitting_selector() {
		assert_eq!(split_colon_selector("C:\\repo\\a.rs:4-8"), PathSelector {
			path:     sf!("C:\\repo\\a.rs"),
			selector: Some(sf!("4-8")),
		});
	}
	#[test]
	fn aggregates_every_write_target_and_preserves_writable_internal_tier() {
		assert_eq!(
			aggregate_file_write_approval(["local://notes", "src/config.rs"], |_| false),
			FileWriteApproval::Write
		);
		assert_eq!(
			aggregate_file_write_approval(["local://notes", "artifact://result"], |_| false),
			FileWriteApproval::Read
		);
		assert_eq!(
			aggregate_file_write_approval(["vault://notes/item"], |path| path.starts_with("vault://")),
			FileWriteApproval::Write
		);
	}
	#[test]
	fn normalizes_path_table() {
		let home = Path::new("/Users/test");
		let cases = [
			("\u{201c}~/My\u{00a0}File.txt\u{201d}", "/Users/test/My File.txt", HostPaths::Posix),
			(":/tmp/a", "/tmp/a", HostPaths::Posix),
			("@~/a", "/Users/test/a", HostPaths::Posix),
			("@history://Worker", "history://Worker", HostPaths::Posix),
			("file:///tmp/a%20b", "/tmp/a b", HostPaths::Posix),
			("/tmp/escaped\\ name.txt", "/tmp/escaped name.txt", HostPaths::Posix),
			("/mnt/c/Users/me/a", r"C:\Users\me\a", HostPaths::Windows),
			("/d/repo", r"D:\repo", HostPaths::Windows),
			(r"\\?\C:\repo\a", r"C:\repo\a", HostPaths::Windows),
			(r"\\?\UNC\server\share\a", r"\\server\share\a", HostPaths::Windows),
			("Cafe\u{301}.txt", "Café.txt", HostPaths::Posix),
		];
		for (authored, expected, host) in cases {
			assert_eq!(
				normalize_target(authored, Some(home), host).canonical,
				Str::new(expected),
				"{authored}"
			);
		}
	}

	#[test]
	fn offers_macos_screenshot_and_curly_quote_recoveries() {
		let target =
			normalize_target("/tmp/Capture d'ecran at 9.41.00 AM.png", None, HostPaths::Posix);
		assert_eq!(target.recovery_candidates(), vec![
			Str::new("/tmp/Capture d'ecran at 9.41.00\u{202f}AM.png"),
			Str::new("/tmp/Capture d\u{2019}ecran at 9.41.00 AM.png"),
		]);
	}

	#[test]
	fn preserves_uri_and_drive_selector_disambiguation_after_normalization() {
		let uri = normalize_target("artifact://abc:2-4", None, HostPaths::Posix);
		assert_eq!(uri.canonical, Str::new("artifact://abc:2-4"));
		let drive = normalize_target(r"C:\repo\a.rs:4-8", None, HostPaths::Windows);
		assert_eq!(split_colon_selector(&drive.canonical), PathSelector {
			path:     sf!(r"C:\repo\a.rs"),
			selector: Some(sf!("4-8")),
		});
	}

	#[test]
	fn confines_relative_paths() {
		let root = Path::new("/workspace");
		assert_eq!(
			confined(root, "src/../Cargo.toml").unwrap(),
			PathBuf::from("/workspace/Cargo.toml")
		);
		assert_eq!(confined(root, "../secret"), Err(PathError::Escape));
	}
}
