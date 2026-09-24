//! Path resolution and write authorization for edit targets.
//!
//! Plain paths resolve against the session `cwd`/`home_dir`. Internal URLs
//! (any `scheme://` registered in [`PathPolicy::url_schemes`]) are opaque
//! here: their backing files come from host answers ([`UrlResolution`])
//! keyed by the authored URL.

use std::{
	collections::HashMap,
	path::{Component, Path, PathBuf},
	time::{Duration, Instant},
};

use regex::Regex;

use crate::{
	engine::{FileOp, Resolved},
	error::{EditError, EditResult},
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
	/// Plain-path roots that stay writable in plan mode (sandbox directories).
	pub plan_writable_roots:  Vec<PathBuf>,
	pub plan_active:          bool,
	pub block_auto_generated: bool,
}

impl PathPolicy {
	/// The internal URL `authored` names: the hashline-header-unwrapped
	/// target (minus one leading `@` mention marker) when it starts with a
	/// registered `scheme://` (case-insensitive). This is the resolution
	/// table key and the URL handed to the host.
	pub fn url_target<'a>(&self, authored: &'a str) -> Option<&'a str> {
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
	/// [`EditError::Apply`] with the host refusal verbatim, or
	/// `No local file backs <url>` when the host found no backing file.
	pub fn resolve(
		&self,
		authored: &str,
		urls: &HashMap<String, UrlResolution>,
	) -> EditResult<Resolved> {
		let display = unwrap_hashline_header_path(authored).to_owned();
		let absolute = match self.url_key(&display) {
			Some(url) => {
				let resolution = urls
					.get(url)
					.ok_or_else(|| EditError::UnresolvedUrl(url.to_owned()))?;
				if let Some(error) = &resolution.error {
					return Err(EditError::apply(error.clone()));
				}
				resolution
					.absolute
					.clone()
					.ok_or_else(|| EditError::apply(format!("No local file backs {url}")))?
			},
			None => self.resolve_path(&display),
		};
		Ok(Resolved { absolute, display })
	}

	/// [`Self::url_target`] for an already-unwrapped display path.
	fn url_key<'a>(&self, display: &'a str) -> Option<&'a str> {
		let url = display.strip_prefix('@').unwrap_or(display);
		let (scheme, _) = url.split_once("://")?;
		self
			.url_schemes
			.iter()
			.any(|known| known.eq_ignore_ascii_case(scheme))
			.then_some(url)
	}

	/// Resolve a filesystem path (never a URL) against `cwd` and `home_dir`.
	fn resolve_path(&self, display: &str) -> PathBuf {
		let expanded = expand_path(display, &self.home_dir);
		if expanded.chars().all(|c| c == '/') {
			return self.cwd.clone();
		}
		let path = PathBuf::from(strip_windows_verbatim(&expanded));
		if path.is_absolute() {
			path
		} else {
			lexical_normalize(&self.cwd.join(path))
		}
	}

	/// Locate a missing authored path by unique trailing-suffix match under
	/// `cwd`.
	pub fn recover_missing(&self, authored: &str) -> Option<Resolved> {
		let normalized = authored.replace('\\', "/");
		let normalized = normalized
			.strip_prefix("./")
			.unwrap_or(&normalized)
			.trim_end_matches('/');
		if normalized.is_empty() {
			return None;
		}
		let escaped = escape_glob_metachars(normalized);
		let glob = pi_walker::CompiledWalkGlob::new([format!("**/{escaped}")]).ok()?;
		let started = Instant::now();
		let request = pi_walker::WalkRequest::new(&self.cwd)
			.hidden(true)
			.gitignore(true)
			.skip_git(true)
			.skip_node_modules(false)
			.emit_root(false)
			.cache(false)
			.limit(2)
			.filter(pi_walker::WalkFilter::all().glob(glob));
		let result = request
			.collect_with_heartbeat(|| {
				if started.elapsed() >= Duration::from_secs(5) {
					Err("workspace suffix search timed out")
				} else {
					Ok(())
				}
			})
			.ok()?;
		if result.entries.len() != 1 {
			return None;
		}
		let display = result.entries.into_iter().next()?.path;
		Some(Resolved { absolute: self.cwd.join(&display), display })
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
		let writable = match self.url_key(display) {
			Some(url) => urls
				.get(url)
				.is_some_and(|resolution| resolution.plan_writable),
			None => self.in_plan_writable_root(&self.resolve_path(display)),
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

	/// True when `absolute` lies inside one of [`Self::plan_writable_roots`],
	/// lexically or after resolving symlinks in the root or the parent.
	pub fn in_plan_writable_root(&self, absolute: &Path) -> bool {
		let absolute = lexical_absolute(absolute, &self.cwd);
		self
			.plan_writable_roots
			.iter()
			.any(|root| within_root(&absolute, &lexical_absolute(root, &self.cwd)))
	}

	/// Whether hashline tag recovery may rebind `authored` onto `recovered`.
	/// URL targets never rebind.
	pub fn allow_tag_path_recovery(&self, authored: &str, recovered: &Path) -> bool {
		if self.is_internal_url(authored) {
			return false;
		}
		let recovered = lexical_absolute(recovered, &self.cwd);
		is_within(&recovered, &lexical_absolute(&self.cwd, &self.cwd))
			|| self.in_plan_writable_root(&recovered)
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

/// Strip a strict `[path]` / `[path#XXXX]` hashline header wrapper.
pub fn unwrap_hashline_header_path(target: &str) -> &str {
	let trimmed = target.trim_end();
	let Some(inner) = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')) else {
		return target;
	};
	let path = if let Some((path, tag)) = inner.rsplit_once('#') {
		if tag.len() == 4 && tag.bytes().all(|b| b.is_ascii_hexdigit()) {
			path
		} else {
			return target;
		}
	} else {
		inner
	};
	if path.is_empty() || path.contains('#') {
		target
	} else {
		path
	}
}

/// Snapshot key: realpath, parent realpath plus basename, or input.
pub fn canonical_key(absolute: &Path) -> PathBuf {
	let resolved = std::fs::canonicalize(absolute)
		.or_else(|_| {
			let parent = absolute.parent().ok_or(std::io::ErrorKind::NotFound)?;
			let name = absolute.file_name().ok_or(std::io::ErrorKind::NotFound)?;
			std::fs::canonicalize(parent).map(|parent| parent.join(name))
		})
		.unwrap_or_else(|_| absolute.to_path_buf());
	strip_windows_verbatim_path(resolved)
}

/// `absolute` (lexically absolute) lies inside `root` (lexically absolute),
/// directly or once symlinks in `root` or in `absolute`'s parent resolve.
fn within_root(absolute: &Path, root: &Path) -> bool {
	if is_within(absolute, root) {
		return true;
	}
	let Ok(real_root) = std::fs::canonicalize(root) else {
		return false;
	};
	if is_within(absolute, &real_root) {
		return true;
	}
	let Some(parent) = absolute.parent() else {
		return false;
	};
	let Some(name) = absolute.file_name() else {
		return false;
	};
	std::fs::canonicalize(parent)
		.is_ok_and(|real_parent| is_within(&real_parent.join(name), &real_root))
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
	if value.starts_with(r"\\?\") {
		value.drain(..4);
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

fn strip_windows_verbatim(value: &str) -> &str {
	value.strip_prefix(r"\\?\").unwrap_or(value)
}

fn strip_windows_verbatim_path(path: PathBuf) -> PathBuf {
	PathBuf::from(strip_windows_verbatim(&path.to_string_lossy()))
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

fn generated_filename(display: &str) -> Option<String> {
	let name = display.replace('\\', "/").rsplit('/').next()?.to_owned();
	let patterns = [
		r"^zz_generated\.",
		r"\.pb\.(go|cc|h|c|js|ts)$",
		r"_pb2\.py$",
		r"_pb2_grpc\.py$",
		r"\.gen\.(go|ts|js|py)$",
		r"^generated\.(go|ts|js|py)$",
		r"\.swagger\.json$",
		r"\.mock\.(go|ts)$",
		r"\.mocks?\.(go|ts|js)$",
	];
	patterns
		.iter()
		.any(|p| Regex::new(p).expect("static regex").is_match(&name))
		.then_some(name)
}

fn detect_generated_marker(content: &str, display: &str) -> Option<String> {
	let styles = comment_styles(display);
	if styles.is_empty() {
		return None;
	}
	let header = leading_comment_text(content.strip_prefix('\u{feff}').unwrap_or(content), &styles);
	let known = r"(?:protoc(?:-gen-[\w-]+)?|sqlc|buf|swagger(?:-codegen)?|openapi(?:-generator)?|grpc-gateway|mockery|stringer|easyjson|deepcopy-gen|defaulter-gen|conversion-gen|client-gen|lister-gen|informer-gen|kysely-codegen|napi-rs)";
	for pattern in [
		r"(?i)@generated\b".to_owned(),
		r"(?i)\bcode\s+generated\s+by\s+[a-z0-9_.-]+".to_owned(),
		r"(?i)\bthis\s+file\s+was\s+automatically\s+generated\b".to_owned(),
		format!(r"(?i)\bgenerated\s+by\s+{known}\b"),
	] {
		if let Some(found) = Regex::new(&pattern).expect("static regex").find(&header) {
			return Some(found.as_str().to_owned());
		}
	}
	None
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
		assert_eq!(unwrap_hashline_header_path("[a#b#1234]"), "[a#b#1234]");
	}

	#[test]
	fn resolves_plain_expanded_and_internal_paths() {
		let tmp = tempfile::tempdir().unwrap();
		let p = policy(tmp.path());
		let urls = HashMap::new();
		assert_eq!(p.resolve("/", &urls).unwrap().absolute, tmp.path());
		assert_eq!(p.resolve("@~/x", &urls).unwrap().absolute, tmp.path().join("home/x"));
		assert_eq!(p.resolve(":./x", &urls).unwrap().absolute, tmp.path().join("./x"));
		assert_eq!(
			p.resolve("file:///tmp/a%20b", &urls).unwrap().absolute,
			PathBuf::from("/tmp/a b")
		);
		// Unregistered schemes and the single-slash spelling are plain paths.
		assert_eq!(p.resolve("other://x", &urls).unwrap().absolute, tmp.path().join("other:/x"));
		assert_eq!(p.resolve("sbx:/x", &urls).unwrap().absolute, tmp.path().join("sbx:/x"));
		assert!(matches!(
			p.resolve("[@SBX://x.md#AB12]", &urls),
			Err(EditError::UnresolvedUrl(url)) if url == "SBX://x.md"
		));
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

	#[test]
	fn recovers_one_suffix_but_not_ambiguous_suffixes() {
		let tmp = tempfile::tempdir().unwrap();
		let p = policy(tmp.path());
		std::fs::create_dir_all(tmp.path().join("deep/src")).unwrap();
		std::fs::write(tmp.path().join("deep/src/a.ts"), "").unwrap();
		assert_eq!(p.recover_missing("src/a.ts").unwrap().display, "deep/src/a.ts");
		std::fs::create_dir_all(tmp.path().join("other/src")).unwrap();
		std::fs::write(tmp.path().join("other/src/a.ts"), "").unwrap();
		assert!(p.recover_missing("src/a.ts").is_none());
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

	#[test]
	fn canonicalizes_existing_parent() {
		let tmp = tempfile::tempdir().unwrap();
		let missing = tmp.path().join("missing.txt");
		assert_eq!(
			canonical_key(&missing),
			std::fs::canonicalize(tmp.path())
				.unwrap()
				.join("missing.txt")
		);
	}
}
