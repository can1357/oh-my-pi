//! Path resolution and write authorization for edit targets.

use std::{
	path::{Component, Path, PathBuf},
	time::{Duration, Instant},
};

use regex::Regex;

use crate::{
	engine::{FileOp, Resolved},
	error::{EditError, EditResult},
};

const VAULT_DISABLED_MESSAGE: &str = "vault:// is disabled. Enable it by setting `vault.enabled = \
                                      true` (Settings → Tools → Obsidian Vault).";
const VAULT_ROOT_MISSING_MESSAGE: &str = "vault:// path resolution requires a cached vault root; \
                                          read vault:// first or use the write tool";
const INTERNAL_PREFIXES: [&str; 9] = [
	"agent://",
	"artifact://",
	"skill://",
	"rule://",
	"security://",
	"local://",
	"mcp://",
	"ssh://",
	"vault://",
];

/// Session-wide path policy supplied by the host once per tool call.
#[derive(Debug, Clone)]
pub struct PathPolicy {
	pub cwd:                  PathBuf,
	pub home_dir:             PathBuf,
	/// Root of the `local://` artifact sandbox.
	pub local_sandbox_root:   Option<PathBuf>,
	/// Cached `vault://` roots keyed by vault name (`_` = the active vault).
	pub vault_roots:          Option<Vec<(String, PathBuf)>>,
	pub plan_active:          bool,
	pub block_auto_generated: bool,
}

impl PathPolicy {
	/// Resolve an authored target to an absolute path.
	pub fn resolve(&self, authored: &str) -> EditResult<Resolved> {
		let display = unwrap_hashline_header_path(authored).to_owned();
		let normalized = normalize_local_scheme(&display);
		let absolute = if let Some(rest) = normalized.strip_prefix("local://") {
			let root = self
				.local_sandbox_root
				.as_ref()
				.ok_or_else(|| EditError::apply("local:// is unavailable in this session"))?;
			let (host, path) = split_url_authority(rest)?;
			let relative = if host.is_empty() {
				path
			} else if path.is_empty() {
				host
			} else {
				format!("{host}/{path}")
			};
			resolve_relative_under_root(root, &relative, "local:// URL escapes local root")?
		} else if let Some(rest) = normalized.strip_prefix("vault://") {
			self.resolve_vault(rest)?
		} else {
			for prefix in INTERNAL_PREFIXES {
				if normalized.starts_with(prefix) {
					return Err(EditError::apply(format!(
						"Path \"{display}\" uses internal scheme \"{prefix}\" and must be resolved \
						 through the proper protocol handler, not as a filesystem path."
					)));
				}
			}
			let expanded = expand_path(&normalized, &self.home_dir);
			if expanded.chars().all(|c| c == '/') {
				self.cwd.clone()
			} else {
				let path = PathBuf::from(strip_windows_verbatim(&expanded));
				if path.is_absolute() {
					path
				} else {
					lexical_normalize(&self.cwd.join(path))
				}
			}
		};
		Ok(Resolved { absolute, display })
	}

	fn resolve_vault(&self, rest: &str) -> EditResult<PathBuf> {
		let roots = self
			.vault_roots
			.as_ref()
			.ok_or_else(|| EditError::apply(VAULT_DISABLED_MESSAGE))?;
		let (host, relative) = split_url_authority(rest)?;
		let key = if host.is_empty() || host == "_" {
			"_"
		} else {
			host.as_str()
		};
		let root = roots
			.iter()
			.find(|(name, _)| name == key)
			.map(|(_, root)| root)
			.ok_or_else(|| EditError::apply(VAULT_ROOT_MISSING_MESSAGE))?;
		let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
		resolve_relative_under_root(&root, &relative, "vault:// URL escapes vault root")
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

	/// Enforce plan-mode write restrictions.
	pub fn enforce_write(&self, display: &str, op: FileOp, move_to: Option<&str>) -> EditResult<()> {
		if !self.plan_active {
			return Ok(());
		}
		if move_to.is_some() {
			return Err(EditError::Plan("Plan mode: renaming files is not allowed.".into()));
		}
		if op == FileOp::Delete {
			return Err(EditError::Plan("Plan mode: deleting files is not allowed.".into()));
		}
		if self
			.resolve(display)
			.is_ok_and(|resolved| self.targets_local_sandbox(&resolved.absolute))
		{
			return Ok(());
		}
		Err(EditError::Plan(
			"Plan mode: the working tree is read-only. Write your plan to a local://<slug>-plan.md \
			 file instead."
				.into(),
		))
	}

	/// True when `absolute` lies inside the `local://` sandbox.
	pub fn targets_local_sandbox(&self, absolute: &Path) -> bool {
		let Some(root) = &self.local_sandbox_root else {
			return false;
		};
		let absolute = lexical_absolute(absolute, &self.cwd);
		let root = lexical_absolute(root, &self.cwd);
		if is_within(&absolute, &root) {
			return true;
		}
		let Ok(real_root) = std::fs::canonicalize(&root) else {
			return false;
		};
		if is_within(&absolute, &real_root) {
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

	/// Whether hashline tag recovery may rebind onto `recovered`.
	pub fn allow_tag_path_recovery(&self, authored: &str, recovered: &Path) -> bool {
		if is_internal_url(authored) {
			return false;
		}
		let recovered = lexical_absolute(recovered, &self.cwd);
		is_within(&recovered, &lexical_absolute(&self.cwd, &self.cwd))
			|| self.targets_local_sandbox(&recovered)
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

/// True when `authored` names an internal URL scheme.
pub fn is_internal_url(authored: &str) -> bool {
	let normalized =
		normalize_local_scheme(&expand_path(&normalize_local_scheme(authored), Path::new("")));
	INTERNAL_PREFIXES
		.iter()
		.any(|prefix| normalized.starts_with(prefix))
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

fn normalize_local_scheme(value: &str) -> String {
	if let Some(rest) = value.strip_prefix("local:/")
		&& !rest.starts_with('/')
	{
		return format!("local://{rest}");
	}
	value.to_owned()
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
			|| INTERNAL_PREFIXES.iter().any(|p| rest.starts_with(p))
			|| rest.starts_with("local:")
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

fn split_url_authority(rest: &str) -> EditResult<(String, String)> {
	let rest = rest
		.split(['?', '#'])
		.next()
		.unwrap_or(rest)
		.replace('\\', "/");
	let (host, path) = rest.split_once('/').unwrap_or((&rest, ""));
	let host = percent_decode(host).map_err(EditError::apply)?;
	let path = percent_decode(path).map_err(EditError::apply)?;
	Ok((host, path))
}

fn resolve_relative_under_root(
	root: &Path,
	relative: &str,
	escape_message: &str,
) -> EditResult<PathBuf> {
	if relative.split(['/', '\\']).any(|part| part == "..") {
		return Err(EditError::apply(escape_message));
	}
	let root = lexical_absolute(root, Path::new("/"));
	let target = lexical_normalize(&root.join(relative));
	if !is_within(&target, &root) {
		return Err(EditError::apply(escape_message));
	}
	Ok(target)
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
		r"\.openapi\.json$",
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

	fn policy(root: &Path) -> PathPolicy {
		PathPolicy {
			cwd:                  root.to_owned(),
			home_dir:             root.join("home"),
			local_sandbox_root:   Some(root.join("local")),
			vault_roots:          Some(vec![
				("_".into(), root.join("vault")),
				("notes".into(), root.join("named")),
			]),
			plan_active:          false,
			block_auto_generated: true,
		}
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
		assert_eq!(p.resolve("/").unwrap().absolute, tmp.path());
		assert_eq!(p.resolve("@~/x").unwrap().absolute, tmp.path().join("home/x"));
		assert_eq!(p.resolve(":./x").unwrap().absolute, tmp.path().join("./x"));
		assert_eq!(p.resolve("file:///tmp/a%20b").unwrap().absolute, PathBuf::from("/tmp/a b"));
		assert!(
			p.resolve("agent://x")
				.unwrap_err()
				.to_string()
				.contains("uses internal scheme \"agent://\"")
		);
	}

	#[test]
	fn resolves_local_and_vault_roots_and_rejects_escape() {
		let tmp = tempfile::tempdir().unwrap();
		let p = policy(tmp.path());
		assert_eq!(
			p.resolve("local://plans/a.md").unwrap().absolute,
			tmp.path().join("local/plans/a.md")
		);
		assert!(p.resolve("local://../x").is_err());
		assert_eq!(p.resolve("vault://_/a.md").unwrap().absolute, tmp.path().join("vault/a.md"));
		assert_eq!(p.resolve("vault://notes/a.md").unwrap().absolute, tmp.path().join("named/a.md"));
	}

	#[test]
	fn plan_mode_allows_only_sandbox_updates() {
		let tmp = tempfile::tempdir().unwrap();
		std::fs::create_dir(tmp.path().join("local")).unwrap();
		let mut p = policy(tmp.path());
		p.plan_active = true;
		assert!(
			p.enforce_write("local://plan.md", FileOp::Update, None)
				.is_ok()
		);
		assert_eq!(
			p.enforce_write("a", FileOp::Delete, None)
				.unwrap_err()
				.to_string(),
			"Plan mode: deleting files is not allowed."
		);
		assert_eq!(
			p.enforce_write("a", FileOp::Update, Some("b"))
				.unwrap_err()
				.to_string(),
			"Plan mode: renaming files is not allowed."
		);
		assert!(
			p.enforce_write("a", FileOp::Update, None)
				.unwrap_err()
				.to_string()
				.contains("working tree is read-only")
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
