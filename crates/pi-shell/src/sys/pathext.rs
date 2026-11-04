//! Windows `PATHEXT`: which files count as executable, and how a bare name
//! resolves to `name.exe` & co..
//!
//! The logic is platform-neutral so it is tested everywhere; only
//! [`Pathext::from_env`] reads the process environment.

use std::{
	ffi::OsStr,
	path::{Path, PathBuf},
};

/// Executable extensions, lowercased, each with its leading dot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pathext {
	exts: Vec<String>,
}

impl Pathext {
	/// Extensions used when `PATHEXT` is unset or empty.
	pub const FALLBACK: [&'static str; 4] = [".com", ".exe", ".bat", ".cmd"];

	/// Parse a `PATHEXT` value (`;`-separated, leading dot optional,
	/// case-insensitive); `None` or an empty list falls back to
	/// [`Pathext::FALLBACK`].
	pub fn parse(value: Option<&OsStr>) -> Self {
		let exts: Vec<String> = value.map_or_default(|v| {
			v.to_string_lossy()
				.split(';')
				.map(str::trim)
				.filter(|e| !e.is_empty())
				.map(|e| {
					let e = e.to_ascii_lowercase();
					if e.starts_with('.') {
						e
					} else {
						format!(".{e}")
					}
				})
				.collect()
		});
		if exts.is_empty() {
			return Self { exts: Self::FALLBACK.iter().map(|e| (*e).to_owned()).collect() };
		}
		Self { exts }
	}

	/// From the process's `PATHEXT`.
	pub fn from_env() -> Self {
		Self::parse(std::env::var_os("PATHEXT").as_deref())
	}

	/// Whether `path` has an executable extension (no filesystem access).
	pub fn has_executable_extension(&self, path: &Path) -> bool {
		path
			.extension()
			.is_some_and(|ext| self.exts.iter().any(|e| ext.eq_ignore_ascii_case(&e[1..])))
	}

	/// Whether `path` is an existing file with an executable extension.
	pub fn is_executable(&self, path: &Path) -> bool {
		self.has_executable_extension(path) && path.is_file()
	}

	/// `path` itself when it is executable, else the first `path` + extension
	/// that exists as a file.
	pub fn resolve(&self, path: PathBuf) -> Option<PathBuf> {
		if self.is_executable(&path) {
			return Some(path);
		}
		self.exts.iter().find_map(|ext| {
			let mut name = path.as_os_str().to_owned();
			name.push(ext);
			let candidate = PathBuf::from(name);
			candidate.is_file().then_some(candidate)
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parsing_normalizes_dots_case_and_blanks() {
		let p = Pathext::parse(Some(OsStr::new(" .EXE;cmd;; .Py ")));
		assert_eq!(p.exts, [".exe", ".cmd", ".py"]);
		assert_eq!(Pathext::parse(Some(OsStr::new(";;"))).exts, Pathext::FALLBACK);
		assert_eq!(Pathext::parse(None).exts, Pathext::FALLBACK);
	}

	#[test]
	fn extension_match_is_case_insensitive() {
		let p = Pathext::parse(None);
		assert!(p.has_executable_extension(Path::new("tool.EXE")));
		assert!(!p.has_executable_extension(Path::new("tool.txt")));
		assert!(!p.has_executable_extension(Path::new("tool")));
	}

	#[test]
	fn resolve_appends_extensions_in_order() {
		let dir = std::env::temp_dir().join(format!("obash-pathext-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		std::fs::write(dir.join("t.cmd"), b"").unwrap();
		std::fs::write(dir.join("t.bat"), b"").unwrap();
		let p = Pathext::parse(None);
		assert_eq!(
			p.resolve(dir.join("t")),
			Some(dir.join("t.bat")),
			".bat precedes .cmd in the fallback list"
		);
		assert_eq!(p.resolve(dir.join("missing")), None);
		std::fs::remove_dir_all(&dir).unwrap();
	}
}
