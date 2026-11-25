//! Path resolution and write authorization for edit targets.
//!
//! Plain paths resolve against the session `cwd`/`home_dir`. Internal URLs
//! (any `scheme://` registered in [`PathPolicy::url_schemes`], or the
//! single-slash `scheme:/` spelling of a [`PathPolicy::url_alias_schemes`]
//! entry) are opaque here: their backing files come from host answers
//! ([`UrlResolution`]) keyed by the canonical `scheme://` URL. Any other
//! URI-shaped target (`scheme:/x` of a non-alias scheme, an unregistered
//! `scheme://x` other than `file://`) is refused the way `write` refuses it,
//! never edited as a working-tree path.

use std::{
	borrow::Cow,
	collections::HashMap,
	ffi::OsString,
	path::{Component, Path, PathBuf, Prefix},
};

use omp_xfs::{FileType, pattern::Glob};
use xutf::{
	Utf8, find_ignore_ascii_case_str, find_iter_ignore_ascii_case, rfind_ignore_ascii_case_str,
};

use crate::{
	engine::{FileOp, Resolved},
	error::{EditError, EditResult},
	scan::{ends_word, is_word, keyword, starts_word},
};

/// Host answer for one internal URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlResolution {
	/// Absolute backing file; `None` → the URL has no local file (the edit
	/// fails with `error` or a generic message).
	pub absolute:      Option<PathBuf>,
	/// Model-facing refusal (read-only scheme, immutable, disabled…); wins
	/// over `absolute`.
	pub error:         Option<String>,
	/// Writable while plan mode is active (the scheme's write scope is the
	/// session sandbox).
	pub plan_writable: bool,
}

/// Session-wide path policy supplied by the host once per tool call.
#[derive(Debug, Clone)]
pub struct PathPolicy {
	pub cwd:                  PathBuf,
	pub home_dir:             PathBuf,
	/// Registered internal URL schemes, lowercase, without `://` (host
	/// router's spec keys).
	pub url_schemes:          Vec<String>,
	/// The [`Self::url_schemes`] whose single-slash `scheme:/x` spelling
	/// aliases `scheme://x` (host spec `singleSlashAlias`).
	pub url_alias_schemes:    Vec<String>,
	/// Plain-path roots that stay writable in plan mode (sandbox directories).
	pub plan_writable_roots:  Vec<PathBuf>,
	pub plan_active:          bool,
	pub block_auto_generated: bool,
}

impl PathPolicy {
	/// The internal URL `authored` names: the hashline-header-unwrapped
	/// target (minus one leading `@` mention marker) when it starts with a
	/// registered `scheme://` (case-insensitive), with the single-slash
	/// `scheme:/x` spelling of an alias scheme rewritten to `scheme://x`.
	/// This is the resolution table key and the URL handed to the host.
	pub fn url_target<'a>(&self, authored: &'a str) -> Option<Cow<'a, str>> {
		self.url_key(unwrap_hashline_header_path(authored))
	}

	/// True when `authored` names a registered internal URL scheme.
	pub fn is_internal_url(&self, authored: &str) -> bool {
		self.url_target(authored).is_some()
	}

	/// Resolve an authored target to an absolute path. Internal URLs are
	/// answered from `urls` (host resolutions keyed by
	/// [`Self::url_target`]); anything else is a filesystem path.
	///
	/// # Errors
	/// [`EditError::UnresolvedUrl`] when a URL target has no entry in `urls`;
	/// [`EditError::Apply`] with the host refusal verbatim,
	/// `No local file backs <url>` when the host found no backing file, or
	/// `Unknown URI-like edit target …` for a URI-shaped target that is
	/// neither an internal URL nor a filesystem path.
	pub fn resolve(
		&self,
		authored: &str,
		urls: &HashMap<String, UrlResolution>,
	) -> EditResult<Resolved> {
		let display = unwrap_hashline_header_path(authored).to_owned();
		let absolute = match self.address(&display) {
			Address::Url(url) => {
				let resolution = urls
					.get(url.as_ref())
					.ok_or_else(|| EditError::UnresolvedUrl(url.as_ref().to_owned()))?;
				if let Some(error) = &resolution.error {
					return Err(EditError::apply(error.clone()));
				}
				resolution
					.absolute
					.clone()
					.ok_or_else(|| EditError::apply(format!("No local file backs {url}")))?
			},
			Address::Path => self.resolve_path(&display),
			Address::Refused(message) => return Err(EditError::apply(message)),
		};
		Ok(Resolved { absolute, display })
	}

	/// [`Self::url_target`] for an already-unwrapped display path.
	fn url_key<'a>(&self, display: &'a str) -> Option<Cow<'a, str>> {
		match self.address(display) {
			Address::Url(url) => Some(url),
			Address::Path | Address::Refused(_) => None,
		}
	}

	/// How an already-unwrapped display path is addressed. URI-shaped
	/// targets (`scheme:/…`, optionally behind one `@`) are URLs only for
	/// registered schemes — the single-slash spelling only for alias schemes;
	/// Windows drives (`C:/…`) and `file://` stay filesystem paths; anything
	/// else is refused with `write`'s wording.
	fn address<'a>(&self, display: &'a str) -> Address<'a> {
		let url = display.strip_prefix('@').unwrap_or(display);
		let Some((scheme, rest)) = url.split_once(':') else {
			return Address::Path;
		};
		let Some(path) = rest.strip_prefix('/') else {
			return Address::Path;
		};
		let listed = |schemes: &[String]| {
			schemes
				.iter()
				.any(|known| known.eq_ignore_ascii_case(scheme))
		};
		if listed(&self.url_schemes) {
			if path.starts_with('/') {
				return Address::Url(Cow::Borrowed(url));
			}
			if listed(&self.url_alias_schemes) {
				return Address::Url(Cow::Owned(format!("{scheme}://{path}")));
			}
			let suggestion = format!("{}://{path}", scheme.to_ascii_lowercase());
			return Address::Refused(unknown_uri_target(display, Some(&suggestion)));
		}
		let is_scheme = scheme
			.bytes()
			.next()
			.is_some_and(|first| first.is_ascii_alphabetic())
			&& scheme
				.bytes()
				.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-'));
		let local =
			scheme.len() == 1 || (scheme.eq_ignore_ascii_case("file") && path.starts_with('/'));
		if !is_scheme || local {
			return Address::Path;
		}
		Address::Refused(unknown_uri_target(display, None))
	}

	/// Resolve a filesystem path (never a URL) against `cwd` and `home_dir`,
	/// lexically normalized so the path written is the path plan mode judged.
	fn resolve_path(&self, display: &str) -> PathBuf {
		let expanded = expand_path(display, &self.home_dir);
		if expanded.chars().all(|c| c == '/') {
			return self.cwd.clone();
		}
		lexical_absolute(Path::new(&expanded), &self.cwd)
	}

	/// Enforce plan-mode write restrictions: renames and deletes are refused;
	/// other writes are allowed only for URL targets whose host answer in
	/// `urls` is plan-writable and for plain paths under
	/// [`Self::plan_writable_roots`].
	///
	/// # Errors
	/// [`EditError::Plan`] carrying the model-facing refusal.
	pub fn enforce_write(
		&self,
		display: &str,
		op: FileOp,
		move_to: Option<&str>,
		urls: &HashMap<String, UrlResolution>,
	) -> EditResult<()> {
		if !self.plan_active {
			return Ok(());
		}
		if move_to.is_some() {
			return Err(EditError::Plan("Plan mode: renaming files is not allowed.".into()));
		}
		if op == FileOp::Delete {
			return Err(EditError::Plan("Plan mode: deleting files is not allowed.".into()));
		}
		let display = unwrap_hashline_header_path(display);
		let writable = match self.address(display) {
			Address::Url(url) => urls
				.get(url.as_ref())
				.is_some_and(|resolution| resolution.plan_writable),
			Address::Path => self.in_plan_writable_root(&self.resolve_path(display)),
			Address::Refused(_) => false,
		};
		if writable {
			return Ok(());
		}
		Err(EditError::Plan(
			"Plan mode: the working tree is read-only. Write your plan to a local://<slug>-plan.md \
			 file instead."
				.into(),
		))
	}

	/// True when `absolute` physically lies inside one of
	/// [`Self::plan_writable_roots`]: both sides are compared by
	/// [`physical_path`], so a symlink under a root cannot lead outside it.
	fn in_plan_writable_root(&self, absolute: &Path) -> bool {
		let Some(target) = physical_path(&lexical_absolute(absolute, &self.cwd)) else {
			return false;
		};
		self.plan_writable_roots.iter().any(|root| {
			physical_path(&lexical_absolute(root, &self.cwd))
				.is_some_and(|root| is_within(&target, &root))
		})
	}

	/// Whether hashline tag recovery may rebind a missing `authored` path onto
	/// `recovered`, the one file this session read under the same name and
	/// tag. Only filesystem paths rebind, and only into a plan-writable root
	/// (the session's own sandbox): a working-tree file of that name may be
	/// another checkout's copy, so that case is rejected instead.
	pub fn allow_tag_path_recovery(&self, authored: &str, recovered: &Path) -> bool {
		matches!(self.address(unwrap_hashline_header_path(authored)), Address::Path)
			&& self.in_plan_writable_root(recovered)
	}

	/// Return the model-facing generated-file rejection, when applicable.
	pub fn auto_generated_message(&self, display: &str, head: &[u8]) -> Option<String> {
		if !self.block_auto_generated {
			return None;
		}
		let marker = generated_filename(display).or_else(|| {
			let prefix = String::from_utf8_lossy(&head[..head.len().min(1024)]);
			detect_generated_marker(&prefix, display)
		})?;
		Some(format!(
			"Cannot modify auto-generated file: {display}\n\nThis file appears to be automatically \
			 generated (detected marker: \"{marker}\").\nAuto-generated files should not be edited \
			 directly. Instead:\n1. Find the source file or generator configuration\n2. Make changes \
			 to the source\n3. Regenerate the file"
		))
	}
}

/// How [`PathPolicy::address`] classifies an unwrapped edit target.
enum Address<'a> {
	/// Internal URL, keyed by its canonical `scheme://` spelling.
	Url(Cow<'a, str>),
	/// Filesystem path.
	Path,
	/// URI-shaped but neither: the model-facing refusal.
	Refused(String),
}

/// `write`'s refusal for a URI-shaped target it cannot address, reworded
/// for edit; `suggestion` is the registered `scheme://` spelling.
fn unknown_uri_target(display: &str, suggestion: Option<&str>) -> String {
	let hint = suggestion.map_or_default(|url| format!(" Did you mean '{url}'?"));
	format!(
		"Unknown URI-like edit target '{display}'.{hint} Prefix the path with './' to edit it as a \
		 filesystem path."
	)
}

/// Strip a strict `[path]` / `[path#XXXX]` hashline header wrapper.
///
/// Mirrors the hashline tokenizer: a valid trailing tag lets the path contain
/// `#`; an untagged `#` is a malformed tag and leaves `target` untouched.
pub fn unwrap_hashline_header_path(target: &str) -> &str {
	let trimmed = target.trim_end();
	let Some(inner) = trimmed.strip_circumfix('[', ']') else {
		return target;
	};
	let path = match inner.rsplit_once('#') {
		Some((path, tag)) if tag.len() == 4 && tag.bytes().all(|b| b.is_ascii_hexdigit()) => path,
		Some(_) => return target,
		None => inner,
	};
	if path.is_empty() { target } else { path }
}

/// Snapshot key that stays the same before and after the path is created.
///
/// The deepest existing ancestor is canonicalized (symlinks resolved, Windows
/// verbatim prefix stripped) and the missing tail re-appended.
///
/// Falls back to `realpath`, parent realpath plus basename, or the input
/// unchanged only when a missing tail component is a dangling symlink or
/// otherwise unresolvable entry, whose destination cannot be judged; that
/// case keeps the previous behavior.
pub fn canonical_key(absolute: &Path) -> PathBuf {
	// Existing paths and paths under a missing parent both go through
	// `physical_path`: it canonicalizes the deepest existing ancestor and
	// re-appends the missing tail, so a key computed before the write matches
	// the one computed after it.
	if let Some(real) = physical_path(absolute) {
		return real;
	}
	// `physical_path` returns `None` only when a missing tail component is a
	// dangling symlink (or otherwise unresolvable entry), so the destination
	// cannot be judged. Keep the old fallback unchanged.
	let resolved = std::fs::canonicalize(absolute)
		.or_else(|_| {
			let parent = absolute.parent().ok_or(std::io::ErrorKind::NotFound)?;
			let name = absolute.file_name().ok_or(std::io::ErrorKind::NotFound)?;
			std::fs::canonicalize(parent).map(|parent| parent.join(name))
		})
		.unwrap_or_else(|_| absolute.to_path_buf());
	strip_windows_verbatim_path(resolved)
}

/// Where `path` (lexically absolute and normalized) physically lands: its
/// deepest existing ancestor canonicalized (symlinks resolved, verbatim
/// prefix stripped) with the missing tail re-appended. `None` when a missing
/// tail component is a dangling symlink (or otherwise unresolvable entry),
/// whose destination cannot be judged.
fn physical_path(path: &Path) -> Option<PathBuf> {
	let mut existing = path;
	let mut tail = Vec::new();
	loop {
		if let Ok(real) = std::fs::canonicalize(existing) {
			let mut real = strip_windows_verbatim_path(real);
			real.extend(tail.iter().rev());
			return Some(real);
		}
		if std::fs::symlink_metadata(existing).is_ok() {
			return None;
		}
		tail.push(existing.file_name()?);
		existing = existing.parent()?;
	}
}

fn expand_path(value: &str, home: &Path) -> String {
	// Native Windows paths are preserved, but the TypeScript-only WSL and
	// `normalizeWindowsDriveAliasPath` environment probes are intentionally
	// omitted.
	let mut value = value.to_owned();
	if value.starts_with(':') {
		let rest = &value[1..];
		if rest.starts_with('/')
			|| rest.starts_with('\\')
			|| rest.starts_with('~')
			|| rest.starts_with("./")
			|| rest.starts_with("../")
			|| is_windows_drive(rest)
		{
			value.remove(0);
		}
	}
	if value.starts_with('@') {
		let rest = &value[1..];
		if rest.starts_with('/')
			|| rest.starts_with('\\')
			|| rest == "~"
			|| rest.starts_with("~/")
			|| is_windows_drive(rest)
		{
			value.remove(0);
		}
	}
	value = value
		.chars()
		.map(|c| {
			if matches!(c, '\u{00a0}' | '\u{2000}'..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}')
			{
				' '
			} else {
				c
			}
		})
		.collect();
	if value
		.get(..7)
		.is_some_and(|s| s.eq_ignore_ascii_case("file://"))
	{
		value = percent_decode(value.get(7..).unwrap_or_default()).unwrap_or(value);
	}
	let stripped = strip_windows_verbatim(&value);
	if stripped.len() != value.len() {
		value = stripped.into_owned();
	}
	if value == "~" {
		return home.to_string_lossy().into_owned();
	}
	if let Some(rest) = value
		.strip_prefix("~/")
		.or_else(|| value.strip_prefix("~\\"))
	{
		return home.join(rest).to_string_lossy().into_owned();
	}
	if let Some(rest) = value.strip_prefix('~') {
		return home.join(rest).to_string_lossy().into_owned();
	}
	value
}

fn is_windows_drive(value: &str) -> bool {
	value
		.as_bytes()
		.first()
		.is_some_and(u8::is_ascii_alphabetic)
		&& value.as_bytes().get(1) == Some(&b':')
}

/// Drop a Windows verbatim prefix that has a plain spelling:
/// `\\?\C:\…` → `C:\…`, `\\?\UNC\server\share…` → `\\server\share…`.
/// Other verbatim forms (`\\?\GLOBALROOT\…`, `\\?\Volume{…}\…`) have none
/// and are unchanged.
fn strip_windows_verbatim(value: &str) -> Cow<'_, str> {
	let Some(rest) = value.strip_prefix(r"\\?\") else {
		return Cow::Borrowed(value);
	};
	if rest
		.get(..4)
		.is_some_and(|unc| unc.eq_ignore_ascii_case(r"UNC\"))
	{
		return Cow::Owned(format!(r"\\{}", &rest[4..]));
	}
	if is_windows_drive(rest) && rest.as_bytes().get(2) == Some(&b'\\') {
		return Cow::Borrowed(rest);
	}
	Cow::Borrowed(value)
}

/// [`strip_windows_verbatim`] for a path, rebuilt from its components (never
/// round-tripped through lossy UTF-8). Only Windows paths carry prefixes.
fn strip_windows_verbatim_path(path: PathBuf) -> PathBuf {
	let mut components = path.components();
	let Some(Component::Prefix(prefix)) = components.next() else {
		return path;
	};
	let rooted = components.clone().next() == Some(Component::RootDir);
	let Some(plain) = plain_prefix(prefix.kind(), rooted) else {
		return path;
	};
	let mut plain = PathBuf::from(plain);
	plain.extend(components);
	plain
}

/// The plain spelling of a verbatim path prefix that has one (the forms
/// `dunce` strips): a rooted `\\?\C:` → `C:`, `\\?\UNC\server\share` →
/// `\\server\share`. `None` for every other prefix.
fn plain_prefix(prefix: Prefix<'_>, rooted: bool) -> Option<OsString> {
	match prefix {
		Prefix::VerbatimDisk(letter) if rooted => Some(format!("{}:", char::from(letter)).into()),
		Prefix::VerbatimUNC(server, share) => {
			let mut unc = OsString::from(r"\\");
			unc.push(server);
			unc.push(r"\");
			unc.push(share);
			Some(unc)
		},
		_ => None,
	}
}

fn percent_decode(value: &str) -> Result<String, String> {
	let bytes = value.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'%' {
			if i + 2 >= bytes.len() {
				return Err("Invalid URL encoding".into());
			}
			let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|_| "Invalid URL encoding")?;
			out.push(u8::from_str_radix(hex, 16).map_err(|_| "Invalid URL encoding")?);
			i += 3;
		} else {
			out.push(bytes[i]);
			i += 1;
		}
	}
	String::from_utf8(out).map_err(|_| "Invalid URL encoding".into())
}

fn lexical_absolute(path: &Path, cwd: &Path) -> PathBuf {
	if path.is_absolute() {
		lexical_normalize(path)
	} else {
		lexical_normalize(&cwd.join(path))
	}
}

fn lexical_normalize(path: &Path) -> PathBuf {
	let mut out = PathBuf::new();
	for component in path.components() {
		match component {
			Component::CurDir => {},
			Component::ParentDir => {
				out.pop();
			},
			other => out.push(other.as_os_str()),
		}
	}
	out
}

fn is_within(path: &Path, root: &Path) -> bool {
	path == root || path.starts_with(root)
}

/// Trailing-suffix matcher for a missing authored path: the host walks
/// `cwd` and recovers the path only when exactly one file or directory
/// matches.
#[derive(Debug, Clone)]
pub struct RecoveryGlob(Glob);

impl RecoveryGlob {
	/// Matcher for `**/<authored>` with metacharacters taken literally;
	/// `None` when `authored` names nothing (empty, `./`, `/`).
	pub fn new(authored: &str) -> Option<Self> {
		let normalized = authored.replace('\\', "/");
		let normalized = normalized
			.strip_prefix("./")
			.unwrap_or(&normalized)
			.trim_end_matches('/');
		if normalized.is_empty() {
			return None;
		}
		let escaped = escape_glob_metachars(normalized);
		Glob::new(&format!("**/{escaped}")).ok().map(Self)
	}

	/// Whether the walk entry at `path` (cwd-relative, `/`-separated, final
	/// component `name`) is a candidate recovery.
	pub fn matches(&self, path: &[u8], name: &[u8], file_type: FileType) -> bool {
		matches!(file_type, FileType::File | FileType::Dir) && self.0.is_match_base(path, name)
	}
}

fn escape_glob_metachars(value: &str) -> String {
	let mut out = String::with_capacity(value.len());
	for c in value.chars() {
		if matches!(c, '*' | '?' | '[' | '{') {
			out.push('[');
			out.push(c);
			out.push(']');
		} else {
			out.push(c);
		}
	}
	out
}

/// Basenames that only generators produce; these block without inspecting
/// content. Ambiguous names such as `generated.go`, hand-written `*.mock.ts`
/// and `PocketBase` `*.pb.js` hooks are left to the content marker check
/// instead.
fn generated_filename(display: &str) -> Option<String> {
	let name = display.rsplit(['/', '\\']).next()?;
	let generated = name.starts_with("zz_generated.")
		|| name.ends_with("_pb2.py")
		|| name.ends_with("_pb2_grpc.py")
		|| name.ends_with(".swagger.json")
		|| name.rsplit_once('.').is_some_and(|(stem, ext)| {
			let marker = stem.rsplit_once('.').map(|(_, marker)| marker);
			matches!(
				(marker, ext),
				(Some("pb"), "go" | "cc" | "h" | "c") | (Some("gen"), "go" | "ts" | "js" | "py")
			)
		});
	generated.then(|| name.to_owned())
}

fn detect_generated_marker(content: &str, display: &str) -> Option<String> {
	let styles = comment_styles(display);
	if styles.is_empty() {
		return None;
	}
	let header = leading_comment_text(content.strip_prefix('\u{feff}').unwrap_or(content), &styles);
	generated_marker(&header)
}

/// Tools whose "generated by" banner is trusted, longest spelling of each
/// first; `protoc` also covers its `protoc-gen-*` plugins.
const TOOLS: [&str; 19] = [
	"protoc",
	"sqlc",
	"buf",
	"swagger-codegen",
	"swagger",
	"openapi-generator",
	"openapi",
	"grpc-gateway",
	"mockery",
	"stringer",
	"easyjson",
	"deepcopy-gen",
	"defaulter-gen",
	"conversion-gen",
	"client-gen",
	"lister-gen",
	"informer-gen",
	"kysely-codegen",
	"napi-rs",
];

/// Strips `words` off the front of `s`, whitespace between them.
fn phrase<'a>(mut s: &'a str, words: &[&str]) -> Option<&'a str> {
	for (index, word) in words.iter().enumerate() {
		if index > 0 {
			let rest = s.trim_start();
			if rest.len() == s.len() {
				return None;
			}
			s = rest;
		}
		s = keyword(s, word)?;
	}
	Some(s)
}

/// Offsets where `word` starts a word in `text`, ignoring ASCII case.
fn word_starts<'a>(text: &'a str, word: &'a str) -> impl Iterator<Item = usize> + 'a {
	find_iter_ignore_ascii_case::<Utf8>(text.as_bytes(), word.as_bytes())
		.filter(|&at| starts_word(&text[..at]))
}

/// The first match of `words` (then `tail`) that starts a word; `tail`
/// returns what follows the match.
fn search<'a>(
	text: &'a str,
	words: &'a [&'a str],
	tail: impl Fn(&'a str) -> Option<&'a str>,
) -> Option<&'a str> {
	word_starts(text, words[0]).find_map(|at| {
		let rest = tail(phrase(&text[at..], words)?)?;
		Some(&text[at..text.len() - rest.len()])
	})
}

/// `code generated … do not edit`, both on one line.
fn do_not_edit(rest: &str) -> Option<&str> {
	if !ends_word(rest) {
		return None;
	}
	let line = rest.split('\n').next().unwrap_or(rest);
	// Use the last valid ending whose `do` begins on this line.
	let mut limit = line.len();
	while let Some(at) = rfind_ignore_ascii_case_str(&line[..limit], "do") {
		if starts_word(&line[..at])
			&& let Some(after) = phrase(&rest[at..], &["do", "not", "edit"])
			&& ends_word(after)
		{
			return Some(after);
		}
		limit = at;
	}
	None
}

/// A trusted tool name after `generated by`.
fn tool(rest: &str) -> Option<&str> {
	let name = rest.trim_start();
	if name.len() == rest.len() {
		return None;
	}
	TOOLS.iter().find_map(|tool| {
		let after = keyword(name, tool)?;
		// `protoc-gen-<plugin>`: the plugin name may not end in a dash.
		if *tool == "protoc"
			&& let Some(plugin) = keyword(after, "-gen-")
		{
			let len = plugin
				.find(|c| !(is_word(c) || c == '-'))
				.unwrap_or(plugin.len());
			let len = plugin[..len].trim_end_matches('-').len();
			if len > 0 {
				return Some(&plugin[len..]);
			}
		}
		ends_word(after).then_some(after)
	})
}

/// Finds the highest-priority generated-code marker in leading comments.
fn generated_marker(header: &str) -> Option<String> {
	// Every marker contains this word; most headers do not.
	find_ignore_ascii_case_str(header, "generated")?;
	let at_generated = find_iter_ignore_ascii_case::<Utf8>(header.as_bytes(), b"@generated")
		.find(|&at| ends_word(&header[at + "@generated".len()..]))
		.map(|at| &header[at..at + "@generated".len()]);
	at_generated
		.or_else(|| {
			search(header, &["code", "generated", "by"], |rest| {
				let name = rest.trim_start();
				let len = name
					.bytes()
					.take_while(|byte| {
						byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')
					})
					.count();
				(name.len() < rest.len() && len > 0).then(|| &name[len..])
			})
		})
		.or_else(|| search(header, &["code", "generated"], do_not_edit))
		.or_else(|| {
			search(header, &["this", "file", "was", "automatically", "generated"], |rest| {
				ends_word(rest).then_some(rest)
			})
		})
		.or_else(|| search(header, &["generated", "by"], tool))
		.map(str::to_owned)
}

fn comment_styles(display: &str) -> Vec<&'static str> {
	let name = display
		.replace('\\', "/")
		.rsplit('/')
		.next()
		.unwrap_or("")
		.to_ascii_lowercase();
	if matches!(name.as_str(), "dockerfile" | "makefile" | "justfile") {
		return vec!["hash"];
	}
	let ext = Path::new(&name)
		.extension()
		.and_then(|x| x.to_str())
		.unwrap_or("");
	if [
		"c", "cc", "cpp", "cs", "dart", "go", "h", "hpp", "java", "js", "jsx", "kt", "kts", "mjs",
		"cjs", "php", "rs", "scala", "swift", "ts", "tsx",
	]
	.contains(&ext)
	{
		vec!["slash"]
	} else if [
		"py", "rb", "sh", "bash", "zsh", "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "pl",
		"r",
	]
	.contains(&ext)
	{
		vec!["hash"]
	} else if ext == "sql" {
		vec!["sql"]
	} else if ["html", "htm", "xml", "svg", "xhtml"].contains(&ext) {
		vec!["html"]
	} else {
		vec![]
	}
}

fn leading_comment_text(content: &str, styles: &[&str]) -> String {
	let mut result = Vec::new();
	let mut started = false;
	let mut slash_block = false;
	let mut html_block = false;
	for (index, line) in content.lines().take(40).enumerate() {
		let line = line.trim();
		if index == 0 && line.starts_with("#!") {
			continue;
		}
		if slash_block {
			result.push(line);
			slash_block = !line.contains("*/");
			continue;
		}
		if html_block {
			result.push(line);
			html_block = !line.contains("-->");
			continue;
		}
		if line.is_empty() {
			if started {
				result.push("");
			}
			continue;
		}
		let accepted = (styles.contains(&"slash") && line.starts_with("//"))
			|| (styles.contains(&"hash") && line.starts_with('#'))
			|| (styles.contains(&"sql") && line.starts_with("--"))
			|| (styles.contains(&"html") && line.starts_with("<!--"));
		if !(accepted || (styles.contains(&"slash") && line.starts_with("/*"))) {
			break;
		}
		started = true;
		result.push(line);
		if styles.contains(&"slash") && line.starts_with("/*") {
			slash_block = !line.contains("*/");
		}
		if styles.contains(&"html") && line.starts_with("<!--") {
			html_block = !line.contains("-->");
		}
	}
	result.join("\n")
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::files::{FileCache, FileSource};

	fn policy(root: &Path) -> PathPolicy {
		PathPolicy {
			cwd:                  root.to_owned(),
			home_dir:             root.join("home"),
			url_schemes:          vec!["sbx".into(), "ro".into()],
			url_alias_schemes:    vec!["sbx".into()],
			plan_writable_roots:  vec![root.join("sandbox")],
			plan_active:          false,
			block_auto_generated: true,
		}
	}

	fn answer(absolute: Option<PathBuf>, error: Option<&str>, plan_writable: bool) -> UrlResolution {
		UrlResolution { absolute, error: error.map(str::to_owned), plan_writable }
	}

	#[test]
	fn unwraps_only_strict_hashline_headers() {
		assert_eq!(unwrap_hashline_header_path("[src/a.ts#Ab12]  \n"), "src/a.ts");
		assert_eq!(unwrap_hashline_header_path("[src/a.ts]"), "src/a.ts");
		assert_eq!(unwrap_hashline_header_path("[src/a.ts#bad]"), "[src/a.ts#bad]");
		assert_eq!(unwrap_hashline_header_path("[conf##host.a#1234]"), "conf##host.a");
		assert_eq!(unwrap_hashline_header_path("[conf##host.a]"), "[conf##host.a]");
	}

	#[test]
	fn resolves_plain_expanded_and_internal_paths() {
		let tmp = tempfile::tempdir().unwrap();
		let p = policy(tmp.path());
		let urls = HashMap::new();
		assert_eq!(p.resolve("/", &urls).unwrap().absolute, tmp.path());
		assert_eq!(p.resolve("@~/x", &urls).unwrap().absolute, tmp.path().join("home/x"));
		assert_eq!(p.resolve(":./x", &urls).unwrap().absolute, tmp.path().join("./x"));
		// The file URL's `/tmp/...` path maps to a POSIX root; on Windows it
		// resolves onto the current drive instead (`C:\tmp\...`).
		#[cfg(unix)]
		assert_eq!(
			p.resolve("file:///tmp/a%20b", &urls).unwrap().absolute,
			PathBuf::from("/tmp/a b")
		);
		// Scheme-colon names without a slash, Windows drives, and `./`-prefixed
		// URI-shaped names are plain paths.
		assert_eq!(p.resolve("sbx:x", &urls).unwrap().absolute, tmp.path().join("sbx:x"));
		assert_eq!(p.resolve("./other://x", &urls).unwrap().absolute, tmp.path().join("other:/x"));
		assert!(p.resolve("C:/x", &urls).is_ok());
		assert!(matches!(
			p.resolve("[@SBX://x.md#AB12]", &urls),
			Err(EditError::UnresolvedUrl(url)) if url == "SBX://x.md"
		));
	}

	#[test]
	fn uri_shaped_targets_are_host_urls_or_refused_never_working_tree_paths() {
		let tmp = tempfile::tempdir().unwrap();
		let p = policy(tmp.path());
		let urls = HashMap::new();
		// Alias scheme: `sbx:/../x` reaches the host (which refuses traversal)
		// instead of lexically collapsing to `<cwd>/x`.
		assert!(matches!(
			p.resolve("[sbx:/../src/main.rs#AB12]", &urls),
			Err(EditError::UnresolvedUrl(url)) if url == "sbx://../src/main.rs"
		));
		// Registered scheme without the alias, and an unregistered scheme:
		// refused like `write` refuses them.
		for (authored, suggestion) in [("ro:/a.md", Some("'ro://a.md'")), ("bogus://a.md", None)] {
			let Err(EditError::Apply(message)) = p.resolve(authored, &urls) else {
				panic!("{authored} must be refused");
			};
			assert!(message.contains(&format!("'{authored}'")), "{message}");
			if let Some(suggestion) = suggestion {
				assert!(message.contains(suggestion), "{message}");
			}
			assert!(p.url_target(authored).is_none(), "{authored}");
		}
	}

	#[test]
	fn strips_windows_verbatim_prefixes() {
		assert_eq!(strip_windows_verbatim(r"\\?\C:\work\a.rs"), r"C:\work\a.rs");
		assert_eq!(strip_windows_verbatim(r"\\?\UNC\server\share\a.rs"), r"\\server\share\a.rs");
		assert_eq!(strip_windows_verbatim(r"\\?\unc\server\share"), r"\\server\share");
		assert_eq!(strip_windows_verbatim(r"\\server\share"), r"\\server\share");
		assert_eq!(expand_path(r"\\?\UNC\server\share\a.rs", Path::new("")), r"\\server\share\a.rs");
		// Verbatim forms without a plain spelling keep their prefix: stripped,
		// they would become relative paths naming a different file.
		for kept in [
			r"\\?\GLOBALROOT\Device\HarddiskVolume1\a.rs",
			r"\\?\Volume{0b1c2d3e-0000-0000-0000-100000000000}\a.rs",
			r"\\?\C:",
		] {
			assert_eq!(strip_windows_verbatim(kept), kept);
		}
	}

	#[test]
	fn plain_prefix_rebuilds_only_disk_and_unc_verbatim_prefixes() {
		use std::ffi::OsStr;
		assert_eq!(plain_prefix(Prefix::VerbatimDisk(b'C'), true), Some("C:".into()));
		assert_eq!(
			plain_prefix(Prefix::VerbatimUNC(OsStr::new("server"), OsStr::new("share")), true),
			Some(r"\\server\share".into())
		);
		assert_eq!(plain_prefix(Prefix::VerbatimDisk(b'C'), false), None);
		for kept in [
			Prefix::Verbatim(OsStr::new("GLOBALROOT")),
			Prefix::Verbatim(OsStr::new("Volume{0b1c2d3e-0000-0000-0000-100000000000}")),
			Prefix::Disk(b'C'),
			Prefix::UNC(OsStr::new("server"), OsStr::new("share")),
		] {
			assert_eq!(plain_prefix(kept, true), None);
		}
	}

	#[cfg(unix)]
	#[test]
	fn plan_mode_judges_where_the_write_physically_lands() {
		let tmp = tempfile::tempdir().unwrap();
		let sandbox = tmp.path().join("sandbox");
		let outside = tmp.path().join("outside");
		std::fs::create_dir_all(&sandbox).unwrap();
		std::fs::create_dir_all(&outside).unwrap();
		std::os::unix::fs::symlink(&outside, sandbox.join("link")).unwrap();
		std::os::unix::fs::symlink(outside.join("victim.txt"), sandbox.join("dangling")).unwrap();
		let mut p = policy(tmp.path());
		p.plan_active = true;
		let urls = HashMap::new();
		let refused = |target: PathBuf| {
			p.enforce_write(target.to_str().unwrap(), FileOp::Create, None, &urls)
				.is_err()
		};
		assert!(refused(sandbox.join("link/escape.txt")));
		assert!(refused(sandbox.join("link/new-dir/escape.txt")));
		assert!(refused(sandbox.join("dangling")));
		assert!(!refused(sandbox.join("nested/new/plan.md")));
		// `link/..` is lexical: it names `sandbox/plan.md`, and that is the
		// path the writer receives.
		let dotted = sandbox.join("link/../plan.md");
		assert!(!refused(dotted.clone()));
		assert_eq!(
			p.resolve(dotted.to_str().unwrap(), &urls).unwrap().absolute,
			sandbox.join("plan.md")
		);
	}

	#[test]
	fn url_targets_miss_until_provided_then_use_the_host_answer() {
		let tmp = tempfile::tempdir().unwrap();
		let mut files = FileCache::new(policy(tmp.path()));
		let err = files.resolve("[sbx://plan.md#AB12]", true).unwrap_err();
		assert_eq!(err.to_string(), "Internal URL not resolved yet: sbx://plan.md");
		assert!(files.resolve("sbx://plan.md", false).is_err());
		assert!(files.resolve("ro://a.md", false).is_err());
		assert_eq!(files.take_unresolved(), ["sbx://plan.md", "ro://a.md"]);
		assert!(files.take_unresolved().is_empty());

		let backing = tmp.path().join("elsewhere/plan.md");
		files.provide("sbx://plan.md".into(), answer(Some(backing.clone()), None, true));
		let resolved = files.resolve("[sbx://plan.md#AB12]", true).unwrap();
		assert_eq!(resolved.absolute, backing);
		assert_eq!(resolved.display, "sbx://plan.md");

		files.provide(
			"ro://a.md".into(),
			answer(Some(tmp.path().join("a.md")), Some("ro://a.md is read-only"), false),
		);
		assert_eq!(
			files.resolve("ro://a.md", false).unwrap_err().to_string(),
			"ro://a.md is read-only"
		);
		files.provide("ro://gone.md".into(), answer(None, None, false));
		assert_eq!(
			files
				.resolve("ro://gone.md", false)
				.unwrap_err()
				.to_string(),
			"No local file backs ro://gone.md"
		);
		assert!(files.take_unresolved().is_empty());
	}

	#[test]
	fn plan_mode_allows_only_plan_writable_targets() {
		let tmp = tempfile::tempdir().unwrap();
		let mut p = policy(tmp.path());
		p.plan_active = true;
		let urls = HashMap::from([
			("sbx://plan.md".to_owned(), answer(Some(tmp.path().join("x/plan.md")), None, true)),
			("ro://a.md".to_owned(), answer(Some(tmp.path().join("sandbox/a.md")), None, false)),
		]);
		let sandboxed = tmp.path().join("sandbox/plan.md");
		assert!(
			p.enforce_write("sbx://plan.md", FileOp::Update, None, &urls)
				.is_ok()
		);
		assert!(
			p.enforce_write(sandboxed.to_str().unwrap(), FileOp::Create, None, &urls)
				.is_ok()
		);
		for refused in ["ro://a.md", "sbx://other.md", "a"] {
			assert!(
				p.enforce_write(refused, FileOp::Update, None, &urls)
					.unwrap_err()
					.to_string()
					.contains("working tree is read-only"),
				"{refused}"
			);
		}
		assert_eq!(
			p.enforce_write("sbx://plan.md", FileOp::Delete, None, &urls)
				.unwrap_err()
				.to_string(),
			"Plan mode: deleting files is not allowed."
		);
		assert_eq!(
			p.enforce_write(sandboxed.to_str().unwrap(), FileOp::Update, Some("b"), &urls)
				.unwrap_err()
				.to_string(),
			"Plan mode: renaming files is not allowed."
		);
	}

	fn recovery_matches(authored: &str, path: &str, file_type: FileType) -> bool {
		let name = path.rsplit('/').next().unwrap();
		RecoveryGlob::new(authored)
			.unwrap()
			.matches(path.as_bytes(), name.as_bytes(), file_type)
	}

	#[test]
	fn recovery_glob_matches_whole_trailing_components() {
		assert!(recovery_matches("src/a.ts", "deep/src/a.ts", FileType::File));
		assert!(recovery_matches("./src/a.ts", "src/a.ts", FileType::File));
		assert!(recovery_matches("src\\a.ts", "deep/src/a.ts", FileType::File));
		assert!(recovery_matches("deep/src/", "x/deep/src", FileType::Dir));
		assert!(!recovery_matches("src/a.ts", "deep/mysrc/a.ts", FileType::File));
		assert!(!recovery_matches("src/a.ts", "deep/src/a.ts.bak", FileType::File));
		assert!(!recovery_matches("src/a.ts", "deep/src/a.ts", FileType::Symlink));
	}

	#[test]
	fn recovery_glob_takes_metacharacters_literally() {
		assert!(recovery_matches("src/[id].ts", "app/src/[id].ts", FileType::File));
		assert!(!recovery_matches("src/[id].ts", "app/src/i.ts", FileType::File));
		assert!(recovery_matches("a*b?.ts", "x/a*b?.ts", FileType::File));
		assert!(!recovery_matches("a*b.ts", "x/aXXb.ts", FileType::File));
	}

	#[test]
	fn recovery_glob_refuses_empty_targets() {
		for authored in ["", "./", "/", "\\"] {
			assert!(RecoveryGlob::new(authored).is_none(), "{authored:?}");
		}
	}

	#[test]
	fn hand_written_mock_and_pocketbase_hook_names_need_a_marker() {
		let tmp = tempfile::tempdir().unwrap();
		let p = policy(tmp.path());
		for name in ["pb_hooks/main.pb.js", "api.pb.ts", "client.mock.ts", "store.mocks.js"] {
			assert!(
				p.auto_generated_message(name, b"export const x = 1;\n")
					.is_none(),
				"{name}"
			);
		}
		assert!(
			p.auto_generated_message("api.pb.js", b"// @generated by protoc-gen-js\n")
				.is_some()
		);
	}

	#[test]
	fn detects_generated_names_and_leading_comments_only() {
		let tmp = tempfile::tempdir().unwrap();
		let p = policy(tmp.path());
		assert!(
			p.auto_generated_message("foo.pb.go", b"")
				.unwrap()
				.contains("detected marker: \"foo.pb.go\"")
		);
		assert!(
			p.auto_generated_message(
				"foo.go",
				b"// Code generated by protoc. DO NOT EDIT.\npackage foo"
			)
			.unwrap()
			.contains("Code generated by protoc")
		);
		assert!(
			p.auto_generated_message("foo.go", b"package foo\n// @generated")
				.is_none()
		);
		assert!(
			p.auto_generated_message("guard.txt", b"// @generated")
				.is_none()
		);
	}

	#[test]
	fn ambiguous_generated_basename_requires_content_marker() {
		let tmp = tempfile::tempdir().unwrap();
		let p = policy(tmp.path());
		assert!(
			p.auto_generated_message(
				"internal/services/organizations/generated.go",
				b"package organizations\n\nfunc Build() {}\n"
			)
			.is_none()
		);
		assert!(p.auto_generated_message("generated.ts", b"").is_none());
		assert!(
			p.auto_generated_message(
				"internal/services/organizations/generated.go",
				b"// Code generated by x. DO NOT EDIT.\n\npackage organizations\n"
			)
			.unwrap()
			.contains("Code generated by x")
		);
		assert!(
			p.auto_generated_message(
				"generated.go",
				b"// Code generated from schema.graphql; DO NOT EDIT.\n\npackage api\n"
			)
			.is_some()
		);
		assert!(
			p.auto_generated_message("zz_generated.deepcopy.go", b"package v1\n")
				.unwrap()
				.contains("detected marker: \"zz_generated.deepcopy.go\"")
		);
	}

	#[cfg(unix)]
	#[test]
	fn refuses_fifo_reads_without_blocking() {
		let tmp = tempfile::tempdir().unwrap();
		let fifo = tmp.path().join("pipe");
		assert!(
			std::process::Command::new("mkfifo")
				.arg(&fifo)
				.status()
				.unwrap()
				.success()
		);
		let mut files = FileCache::new(policy(tmp.path()));
		let (sender, receiver) = std::sync::mpsc::channel();
		std::thread::spawn(move || {
			let _ = sender.send(
				files
					.read("pipe")
					.map(|_| ())
					.map_err(|error| error.to_string()),
			);
		});
		// A regression blocks the reader in open(2) forever; an O_RDWR open never
		// blocks and counts as a writer, so it releases that reader before the
		// test fails.
		let result = receiver
			.recv_timeout(std::time::Duration::from_secs(5))
			.unwrap_or_else(|_| {
				let _writer = std::fs::OpenOptions::new()
					.read(true)
					.write(true)
					.open(&fifo);
				panic!("reading a FIFO blocked instead of being refused")
			});
		let error = result.unwrap_err();
		assert!(error.contains("it is a FIFO"), "unexpected error: {error}");
	}

	#[test]
	fn permits_hand_authored_openapi_json() {
		let tmp = tempfile::tempdir().unwrap();
		let p = policy(tmp.path());
		assert!(
			p.auto_generated_message(
				"api.openapi.json",
				br#"{"openapi":"3.1.0","info":{"title":"Demo","version":"v1"}}"#
			)
			.is_none()
		);
	}

	// POSIX paths have no prefix component, so `\\?\C:\…` is an ordinary
	// relative path there and the strip is correctly a no-op.
	#[cfg(windows)]
	#[test]
	fn strips_verbatim_prefix_from_windows_paths() {
		assert_eq!(
			strip_windows_verbatim_path(PathBuf::from(r"\\?\C:\proj\a.ts")),
			PathBuf::from(r"C:\proj\a.ts")
		);
		assert_eq!(
			strip_windows_verbatim_path(PathBuf::from(r"C:\proj\a.ts")),
			PathBuf::from(r"C:\proj\a.ts")
		);
	}

	#[test]
	fn canonicalizes_existing_parent() {
		let tmp = tempfile::tempdir().unwrap();
		let missing = tmp.path().join("missing.txt");
		// canonical_key strips the `\\?\` verbatim prefix std canonicalize
		// yields on Windows; apply the same cleaning to the expectation.
		assert_eq!(
			canonical_key(&missing),
			strip_windows_verbatim_path(
				std::fs::canonicalize(tmp.path())
					.unwrap()
					.join("missing.txt")
			)
		);
	}

	// Windows symlink creation needs special privileges, so the stability
	// regression is covered on Unix where temp paths commonly cross symlinks.
	#[cfg(unix)]
	#[test]
	fn canonical_key_is_stable_before_and_after_creation() {
		let tmp = tempfile::tempdir().unwrap();
		let real = tmp.path().join("real");
		std::fs::create_dir(&real).unwrap();
		let link = tmp.path().join("link");
		std::os::unix::fs::symlink(&real, &link).unwrap();

		// Neither `a` nor `b` exists yet and the parent chain crosses a
		// symlink, so macOS and Linux both expose the old instability.
		let target = link.join("a/b/new.txt");
		let before = canonical_key(&target);
		std::fs::create_dir_all(target.parent().unwrap()).unwrap();
		std::fs::write(&target, "x").unwrap();
		let after = canonical_key(&target);

		assert_eq!(before, after, "canonical_key must stay stable for one path");
	}

	#[test]
	fn canonical_key_matches_canonicalize_for_existing_path() {
		let tmp = tempfile::tempdir().unwrap();
		let file = tmp.path().join("exists.txt");
		std::fs::write(&file, "x").unwrap();

		// An existing path must equal `strip_verbatim(canonicalize(p))`
		// exactly, proving the `physical_path` reuse left the common case
		// unchanged.
		assert_eq!(
			canonical_key(&file),
			strip_windows_verbatim_path(std::fs::canonicalize(&file).unwrap())
		);
	}
}
