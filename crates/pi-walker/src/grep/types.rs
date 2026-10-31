//! pi's file-type table for grep's `type` option.

use std::borrow::Cow;

/// A resolved `type` filter.
#[derive(Clone, Debug)]
pub enum TypeFilter {
	/// A table entry: extensions and exact file names.
	Known { exts: &'static [&'static str], names: &'static [&'static str] },
	/// Anything else: one extension or exact file name.
	Custom(String),
}

impl TypeFilter {
	/// Resolves a `type` value (trimmed, leading `.` dropped, lowercased);
	/// `None` for an empty one.
	pub fn new(value: &str) -> Option<Self> {
		let value = value.trim().trim_start_matches('.');
		if value.is_empty() {
			return None;
		}
		let value = value.to_lowercase();
		let (exts, names): (&'static [&'static str], &'static [&'static str]) = match value.as_str() {
			"js" | "javascript" => (&["js", "jsx", "mjs", "cjs"], &[]),
			"ts" | "typescript" => (&["ts", "tsx", "mts", "cts"], &[]),
			"json" => (&["json", "jsonc", "json5"], &[]),
			"yaml" | "yml" => (&["yaml", "yml"], &[]),
			"toml" => (&["toml"], &[]),
			"md" | "markdown" => (&["md", "markdown", "mdx"], &[]),
			"py" | "python" => (&["py", "pyi"], &[]),
			"rs" | "rust" => (&["rs"], &[]),
			"go" => (&["go"], &[]),
			"java" => (&["java"], &[]),
			"kt" | "kotlin" => (&["kt", "kts"], &[]),
			"c" => (&["c", "h"], &[]),
			"cpp" | "cxx" => (&["cpp", "cc", "cxx", "hpp", "hxx", "hh"], &[]),
			"cs" | "csharp" => (&["cs", "csx"], &[]),
			"php" => (&["php", "phtml"], &[]),
			"rb" | "ruby" => (&["rb", "rake", "gemspec"], &[]),
			"sh" | "bash" => (&["sh", "bash", "zsh"], &[]),
			"zsh" => (&["zsh"], &[]),
			"fish" => (&["fish"], &[]),
			"html" => (&["html", "htm"], &[]),
			"css" => (&["css"], &[]),
			"scss" => (&["scss"], &[]),
			"sass" => (&["sass"], &[]),
			"less" => (&["less"], &[]),
			"xml" => (&["xml"], &[]),
			"docker" | "dockerfile" => (&[], &["dockerfile"]),
			"make" | "makefile" => (&[], &["makefile"]),
			_ => return Some(Self::Custom(value)),
		};
		Some(Self::Known { exts, names })
	}

	/// Whether a file named `name` (raw bytes) has this type: its name
	/// equals a listed name, or its extension (after the last `.`) a listed
	/// extension, ASCII case-insensitively.
	pub fn matches(&self, name: &[u8]) -> bool {
		let name = match std::str::from_utf8(name) {
			Ok(name) => Cow::Borrowed(name),
			Err(_) => String::from_utf8_lossy(name),
		};
		let ext = name.rsplit_once('.').map_or("", |(_, ext)| ext);
		match self {
			Self::Known { exts, names } => {
				names.iter().any(|n| name.eq_ignore_ascii_case(n))
					|| (!ext.is_empty() && exts.iter().any(|e| ext.eq_ignore_ascii_case(e)))
			},
			Self::Custom(custom) => {
				name.eq_ignore_ascii_case(custom)
					|| (!ext.is_empty() && ext.eq_ignore_ascii_case(custom))
			},
		}
	}
}

#[cfg(test)]
mod tests {
	use super::TypeFilter;

	#[test]
	fn known_types_match_extensions_and_names() {
		let ts = TypeFilter::new("TypeScript").expect("filter");
		assert!(ts.matches(b"a.tsx"));
		assert!(ts.matches(b"b.MTS"));
		assert!(!ts.matches(b"c.js"));
		let docker = TypeFilter::new("docker").expect("filter");
		assert!(docker.matches(b"Dockerfile"));
		assert!(!docker.matches(b"Dockerfile.dev"));
	}

	#[test]
	fn unknown_types_are_one_extension_or_name() {
		let custom = TypeFilter::new(" .Vue ").expect("filter");
		assert!(custom.matches(b"App.vue"));
		assert!(custom.matches(b"vue"));
		assert!(!custom.matches(b"App.vuex"));
		assert!(!custom.matches(b"App.ts"));
		assert!(TypeFilter::new("  ").is_none());
	}
}
