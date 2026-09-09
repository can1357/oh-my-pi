//! Shared glob-pattern helpers used by both [`crate::glob`] and
//! [`crate::grep`].

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use napi::bindgen_prelude::*;

/// Compiled glob filter with cheap paths for common basename/extension queries.
pub struct CompiledGlob {
	fast_path: GlobFastPath,
	glob_set:  GlobSet,
}

enum GlobFastPath {
	/// Matches any path regardless of depth or name (`**`, `**/*`).
	All,
	/// Matches only root-level paths (no `/`), regardless of name (`*`).
	RootOnly,
	/// Matches by extension at any depth (`**/*.ext`, `**/*.{a,b}`).
	Extension(Vec<String>),
	/// Matches by extension only at the root level (`*.ext`, `*.{a,b}`).
	RootExtension(Vec<String>),
	/// Matches a literal basename at any depth (`**/name`).
	Basename(String),
	/// Matches a literal basename only at the root level (bare `name`).
	RootBasename(String),
	/// Falls back to full glob matching.
	GlobSet,
}

impl CompiledGlob {
	/// Returns true when the normalized relative path matches this glob.
	pub fn is_match(&self, path: &str) -> bool {
		match &self.fast_path {
			GlobFastPath::All => true,
			GlobFastPath::RootOnly => !path.contains('/'),
			GlobFastPath::Extension(exts) => {
				path_extension(path).is_some_and(|ext| exts.iter().any(|candidate| ext == candidate))
			},
			GlobFastPath::RootExtension(exts) => {
				!path.contains('/')
					&& path_extension(path)
						.is_some_and(|ext| exts.iter().any(|candidate| ext == candidate))
			},
			GlobFastPath::Basename(name) => path.rsplit('/').next() == Some(name.as_str()),
			GlobFastPath::RootBasename(name) => path == name.as_str(),
			GlobFastPath::GlobSet => self.glob_set.is_match(path),
		}
	}
}

/// Normalize a raw glob string: fix path separators, optionally prepend `**/`
/// for recursive matching, and close any unclosed `{` alternation groups.
pub fn build_glob_pattern(glob: &str, recursive: bool) -> String {
	let normalized = glob.replace('\\', "/");
	let pattern = if !recursive
		|| normalized.contains('/')
		|| normalized.starts_with("**")
		|| is_exact_brace_union(&normalized)
	{
		normalized
	} else {
		format!("**/{normalized}")
	};
	fix_unclosed_braces(pattern)
}

/// Maximum walk depth (path components) a normalized glob pattern can match,
/// or `usize::MAX` when unbounded.
///
/// Walk-relative globs compile with `literal_separator(true)`, so `*`, `?`,
/// and `[...]` never cross `/` — a pattern with N literal segments can only
/// match entries at most N components deep. Bounding the walk to that depth
/// keeps non-recursive patterns (`*`, `dir/*.json`) from traversing an entire
/// subtree they can never match into (the source of "narrow glob timed out on
/// a populated directory" failures).
///
/// `**` matches any number of components and `{...}` alternations may contain
/// `/`, so both disable the bound.
pub fn walk_depth_bound(pattern: &str) -> usize {
	if pattern.contains("**") || pattern.contains('{') {
		return usize::MAX;
	}
	pattern
		.split('/')
		.filter(|seg| !seg.is_empty())
		.count()
		.max(1)
}

/// Compile a glob pattern string into a [`CompiledGlob`].
///
/// When `recursive` is true, simple patterns (no path separators, no leading
/// `**`) are automatically prefixed with `**/`.
pub fn compile_glob(glob: &str, recursive: bool) -> Result<CompiledGlob> {
	let mut builder = GlobSetBuilder::new();
	let pattern = build_glob_pattern(glob, recursive);
	let parsed = GlobBuilder::new(&pattern)
		.literal_separator(true)
		.build()
		.map_err(|err| Error::from_reason(format!("Invalid glob pattern: {err}")))?;
	builder.add(parsed);
	let glob_set = builder
		.build()
		.map_err(|err| Error::from_reason(format!("Failed to build glob matcher: {err}")))?;
	Ok(CompiledGlob { fast_path: classify_fast_path(&pattern), glob_set })
}

/// Like [`compile_glob`], but accepts an `Option<&str>` — returns `Ok(None)`
/// when the input is `None`, empty, or whitespace-only.
pub fn try_compile_glob(glob: Option<&str>, recursive: bool) -> Result<Option<CompiledGlob>> {
	let Some(glob) = glob.map(str::trim).filter(|v| !v.is_empty()) else {
		return Ok(None);
	};
	compile_glob(glob, recursive).map(Some)
}

fn classify_fast_path(pattern: &str) -> GlobFastPath {
	if matches!(pattern, "**" | "**/*") {
		return GlobFastPath::All;
	}
	if pattern == "*" {
		return GlobFastPath::RootOnly;
	}
	if let Some(ext) = pattern.strip_prefix("**/*.") {
		if is_literal_component(ext) {
			return GlobFastPath::Extension(vec![ext.to_string()]);
		}
	} else if let Some(ext) = pattern.strip_prefix("*.")
		&& is_literal_component(ext)
	{
		return GlobFastPath::RootExtension(vec![ext.to_string()]);
	}
	if let Some(inner) = pattern
		.strip_prefix("**/*.{")
		.and_then(|value| value.strip_suffix('}'))
	{
		if let Some(extensions) = literal_csv(inner) {
			return GlobFastPath::Extension(extensions);
		}
	} else if let Some(inner) = pattern
		.strip_prefix("*.{")
		.and_then(|value| value.strip_suffix('}'))
		&& let Some(extensions) = literal_csv(inner)
	{
		return GlobFastPath::RootExtension(extensions);
	}
	if let Some(name) = pattern.strip_prefix("**/") {
		if is_literal_path(name) {
			return GlobFastPath::Basename(name.to_string());
		}
	} else if is_literal_path(pattern) {
		return GlobFastPath::RootBasename(pattern.to_string());
	}
	GlobFastPath::GlobSet
}

fn literal_csv(inner: &str) -> Option<Vec<String>> {
	let extensions: Vec<String> = inner
		.split(',')
		.filter(|value| !value.is_empty() && is_literal_component(value))
		.map(ToOwned::to_owned)
		.collect();
	if extensions.is_empty() || extensions.len() != inner.split(',').count() {
		None
	} else {
		Some(extensions)
	}
}

fn path_extension(path: &str) -> Option<&str> {
	let base = path.rsplit('/').next().unwrap_or(path);
	let (_, ext) = base.rsplit_once('.')?;
	if ext.is_empty() { None } else { Some(ext) }
}

fn is_literal_component(value: &str) -> bool {
	!value.is_empty()
		&& !value
			.chars()
			.any(|ch| matches!(ch, '*' | '?' | '[' | ']' | '{' | '}' | '/' | '\\'))
}

/// True when `value` is a literal single path component: non-empty, no glob
/// metacharacters, and no path separator, so a "basename" fast path is safe
/// to apply regardless of how many directory levels precede it.
fn is_literal_path(value: &str) -> bool {
	!value.is_empty()
		&& !value
			.chars()
			.any(|ch| matches!(ch, '*' | '?' | '[' | ']' | '{' | '}' | '\\' | '/'))
}

/// Close unclosed `{` alternation groups in a glob pattern.
///
/// LLMs occasionally produce patterns like `*.{ts,js` without the closing `}`.
/// Rather than failing, we append the missing braces.
fn fix_unclosed_braces(pattern: String) -> String {
	let opens = pattern.chars().filter(|&c| c == '{').count();
	let closes = pattern.chars().filter(|&c| c == '}').count();
	if opens > closes {
		let mut fixed = pattern;
		for _ in 0..(opens - closes) {
			fixed.push('}');
		}
		fixed
	} else {
		pattern
	}
}

fn is_exact_brace_union(pattern: &str) -> bool {
	if !(pattern.starts_with('{') && pattern.ends_with('}')) {
		return false;
	}
	let inner = &pattern[1..pattern.len() - 1];
	!inner.is_empty()
		&& !inner
			.chars()
			.any(|ch| matches!(ch, '*' | '?' | '[' | ']' | '{' | '}'))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn simple_pattern_gets_recursive_prefix() {
		assert_eq!(build_glob_pattern("*.ts", true), "**/*.ts");
	}

	#[test]
	fn pattern_with_path_stays_as_is() {
		assert_eq!(build_glob_pattern("src/*.ts", true), "src/*.ts");
	}

	#[test]
	fn already_recursive_pattern_unchanged() {
		assert_eq!(build_glob_pattern("**/*.rs", true), "**/*.rs");
	}

	#[test]
	fn non_recursive_keeps_simple_pattern() {
		assert_eq!(build_glob_pattern("*.ts", false), "*.ts");
	}

	#[test]
	fn walk_depth_bound_counts_segments_for_bounded_patterns() {
		assert_eq!(walk_depth_bound("*"), 1);
		assert_eq!(walk_depth_bound("*.json"), 1);
		assert_eq!(walk_depth_bound("dir/*.ts"), 2);
		assert_eq!(walk_depth_bound("a/*/c.txt"), 3);
	}

	#[test]
	fn walk_depth_bound_unbounded_for_recursive_and_brace_patterns() {
		assert_eq!(walk_depth_bound("**/*"), usize::MAX);
		assert_eq!(walk_depth_bound("src/**/*.ts"), usize::MAX);
		// `{}` groups may contain `/`, so segment counting is unsound for them.
		assert_eq!(walk_depth_bound("{a/b,c}/d.txt"), usize::MAX);
	}

	#[test]
	fn compiled_non_recursive_extension_glob_matches_only_root_files() {
		let glob = compile_glob("*.rs", false).expect("compile non-recursive extension glob");

		assert!(glob.is_match("lib.rs"));
		assert!(!glob.is_match("src/lib.rs"));
		assert!(!glob.is_match("lib.ts"));
	}

	#[test]
	fn compiled_recursive_extension_glob_matches_nested_files_after_normalization() {
		let glob = compile_glob("*.rs", true).expect("compile recursive extension glob");

		assert!(glob.is_match("lib.rs"));
		assert!(glob.is_match("src/lib.rs"));
		assert!(glob.is_match("src/nested/lib.rs"));
		assert!(!glob.is_match("src/lib.ts"));
	}

	#[test]
	fn backslashes_normalized() {
		assert_eq!(build_glob_pattern("src\\**\\*.ts", true), "src/**/*.ts");
	}

	#[test]
	fn unclosed_brace_gets_closed() {
		assert_eq!(build_glob_pattern("*.{ts,tsx,js", true), "**/*.{ts,tsx,js}");
	}

	#[test]
	fn deeply_unclosed_braces_all_closed() {
		assert_eq!(build_glob_pattern("{a,{b,c}", true), "**/{a,{b,c}}");
	}

	#[test]
	fn balanced_braces_unchanged() {
		assert_eq!(build_glob_pattern("*.{ts,js}", true), "**/*.{ts,js}");
	}

	#[test]
	fn compile_glob_accepts_valid_pattern() {
		assert!(compile_glob("*.ts", true).is_ok());
	}

	#[test]
	fn compile_glob_fixes_unclosed_brace() {
		assert!(compile_glob("*.{ts,tsx,js", true).is_ok());
	}

	#[test]
	fn exact_brace_union_stays_non_recursive() {
		assert_eq!(build_glob_pattern("{alpha.txt,beta.txt}", true), "{alpha.txt,beta.txt}");
	}

	#[test]
	fn glob_brace_union_still_gets_recursive_prefix() {
		assert_eq!(build_glob_pattern("{*.ts,*.tsx}", true), "**/{*.ts,*.tsx}");
	}
}
