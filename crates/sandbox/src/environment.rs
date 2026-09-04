use std::{
	borrow::Cow,
	ffi::{OsStr, OsString},
	fmt,
	path::Path,
};

use globset::{GlobBuilder, GlobMatcher};
use omp_core::Str;

use crate::SandboxError;

/// Source environment used before allow and deny filtering.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum EnvironmentSource {
	/// Inherit the caller's environment at preparation time.
	#[default]
	Inherit,
	/// Inherit only platform-core environment names.
	Core,
	/// Use exactly these `NAME=VALUE` entries, including an explicitly empty
	/// list.
	Exact(Vec<OsString>),
}

/// Ordered environment source and name filters for a sandboxed process.
#[derive(Clone, Default)]
pub struct EnvironmentPolicy {
	source:    EnvironmentSource,
	allow:     Vec<EnvironmentPattern>,
	deny:      Vec<EnvironmentPattern>,
	overrides: Vec<(OsString, OsString)>,
}

impl EnvironmentPolicy {
	/// Creates a policy that inherits the caller's complete environment.
	#[must_use]
	pub const fn inherit() -> Self {
		Self {
			source:    EnvironmentSource::Inherit,
			allow:     Vec::new(),
			deny:      Vec::new(),
			overrides: Vec::new(),
		}
	}

	/// Creates a policy from exact `NAME=VALUE` entries.
	#[must_use]
	pub const fn exact(entries: Vec<OsString>) -> Self {
		Self {
			source:    EnvironmentSource::Exact(entries),
			allow:     Vec::new(),
			deny:      Vec::new(),
			overrides: Vec::new(),
		}
	}

	/// Returns the source evaluated before filtering.
	#[must_use]
	pub const fn source(&self) -> &EnvironmentSource {
		&self.source
	}

	/// Iterates over allow patterns in deterministic order.
	pub fn allow_patterns(&self) -> impl ExactSizeIterator<Item = &str> {
		self.allow.iter().map(|pattern| pattern.text.as_str())
	}

	/// Iterates over deny patterns in deterministic order.
	pub fn deny_patterns(&self) -> impl ExactSizeIterator<Item = &str> {
		self.deny.iter().map(|pattern| pattern.text.as_str())
	}

	pub(crate) fn overrides(&self) -> &[(OsString, OsString)] {
		&self.overrides
	}

	pub(crate) fn set_source(&mut self, source: EnvironmentSource) {
		self.source = source;
	}

	pub(crate) fn add_allow(&mut self, pattern: impl AsRef<str>) -> Result<(), SandboxError> {
		insert_pattern(&mut self.allow, pattern.as_ref())
	}

	pub(crate) fn add_deny(&mut self, pattern: impl AsRef<str>) -> Result<(), SandboxError> {
		insert_pattern(&mut self.deny, pattern.as_ref())
	}

	pub(crate) fn set_override(&mut self, key: &str, value: &str) {
		let key = OsString::from(key);
		let value = OsString::from(value);
		match self
			.overrides
			.binary_search_by(|(existing, _)| existing.cmp(&key))
		{
			Ok(index) => self.overrides[index].1 = value,
			Err(index) => self.overrides.insert(index, (key, value)),
		}
	}

	pub(crate) const fn scrubs(&self) -> bool {
		!matches!(self.source, EnvironmentSource::Inherit)
			|| !self.allow.is_empty()
			|| !self.deny.is_empty()
			|| !self.overrides.is_empty()
	}

	pub(crate) fn allows(&self, name: &str) -> bool {
		let name = OsStr::new(name);
		if self.overrides.iter().any(|(key, _)| key == name) {
			return true;
		}
		self.source_allows(name)
			&& (self.allow.is_empty() || matches_any(name, &self.allow))
			&& !matches_any(name, &self.deny)
	}

	pub(crate) fn resolve_env<I, K, V>(&self, environment: I) -> Vec<(OsString, OsString)>
	where
		I: IntoIterator<Item = (K, V)>,
		K: Into<OsString>,
		V: Into<OsString>,
	{
		let mut resolved: Vec<(OsString, OsString)> = match &self.source {
			EnvironmentSource::Inherit | EnvironmentSource::Core => environment
				.into_iter()
				.map(|(key, value)| (key.into(), value.into()))
				.filter(|(key, _)| self.source_allows(key))
				.collect(),
			EnvironmentSource::Exact(entries) => {
				entries.iter().map(|entry| split_entry(entry)).collect()
			},
		};
		resolved.retain(|(key, _)| {
			(self.allow.is_empty() || matches_any(key, &self.allow))
				&& !matches_any(key, &self.deny)
				&& !self
					.overrides
					.iter()
					.any(|(override_key, _)| override_key == key)
		});
		resolved.extend(self.overrides.iter().cloned());
		resolved
	}

	pub(crate) fn resolve(&self) -> Option<Vec<OsString>> {
		if !self.scrubs() {
			return None;
		}
		Some(
			self
				.resolve_env(std::env::vars_os())
				.into_iter()
				.map(|(mut name, value)| {
					name.push("=");
					name.push(value);
					name
				})
				.collect(),
		)
	}

	fn source_allows(&self, name: &OsStr) -> bool {
		match &self.source {
			EnvironmentSource::Inherit => true,
			EnvironmentSource::Core => is_core_environment_name(name),
			EnvironmentSource::Exact(entries) => entries.iter().any(|entry| &*env_name(entry) == name),
		}
	}
}

impl fmt::Debug for EnvironmentPolicy {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("EnvironmentPolicy")
			.field("source", &self.source)
			.field(
				"allow",
				&self
					.allow
					.iter()
					.map(|pattern| &pattern.text)
					.collect::<Vec<_>>(),
			)
			.field(
				"deny",
				&self
					.deny
					.iter()
					.map(|pattern| &pattern.text)
					.collect::<Vec<_>>(),
			)
			.field("overrides", &self.overrides)
			.finish()
	}
}

#[derive(Clone)]
struct EnvironmentPattern {
	text:    Str,
	matcher: GlobMatcher,
}

fn insert_pattern(
	patterns: &mut Vec<EnvironmentPattern>,
	pattern: &str,
) -> Result<(), SandboxError> {
	validate_env_pattern(pattern)?;
	let text = Str::from(pattern);
	let matcher = GlobBuilder::new(pattern)
		.case_insensitive(true)
		.build()
		.expect("validated environment pattern")
		.compile_matcher();
	match patterns.binary_search_by(|existing| existing.text.cmp(&text)) {
		Ok(_) => {},
		Err(index) => patterns.insert(index, EnvironmentPattern { text, matcher }),
	}
	Ok(())
}

/// Validates one case-insensitive environment-name glob.
pub fn validate_env_pattern(pattern: &str) -> Result<(), SandboxError> {
	if pattern.trim().is_empty() {
		return Err(SandboxError::EmptyEnvironmentPattern);
	}
	let text = Str::from(pattern);
	GlobBuilder::new(pattern)
		.case_insensitive(true)
		.build()
		.map(|_| ())
		.map_err(|source| SandboxError::InvalidEnvironmentPattern { pattern: text, source })
}

/// Returns platform-core environment names and patterns.
#[must_use]
pub const fn core_environment_names() -> &'static [&'static str] {
	&["HOME", "PATH", "USER", "SHELL", "LOGNAME", "TERM", "TMPDIR", "LANG", "LC_*"]
}

fn is_core_environment_name(name: &OsStr) -> bool {
	let name = name.to_string_lossy();
	core_environment_names()
		.iter()
		.copied()
		.any(|pattern| match pattern.strip_suffix('*') {
			Some(prefix) => name
				.get(..prefix.len())
				.is_some_and(|candidate| candidate.eq_ignore_ascii_case(prefix)),
			None => name.eq_ignore_ascii_case(pattern),
		})
}

fn matches_any(name: &OsStr, patterns: &[EnvironmentPattern]) -> bool {
	patterns
		.iter()
		.any(|pattern| pattern.matcher.is_match(Path::new(name)))
}

fn env_name(entry: &OsStr) -> Cow<'_, OsStr> {
	#[cfg(unix)]
	{
		use std::os::unix::ffi::OsStrExt as _;

		let bytes = entry.as_bytes();
		let end = bytes
			.iter()
			.position(|byte| *byte == b'=')
			.unwrap_or(bytes.len());
		Cow::Borrowed(OsStr::from_bytes(&bytes[..end]))
	}
	#[cfg(not(unix))]
	{
		let text = entry.to_string_lossy();
		let end = text.find('=').unwrap_or(text.len());
		Cow::Owned(OsString::from(&text[..end]))
	}
}

pub fn split_entry(entry: &OsStr) -> (OsString, OsString) {
	#[cfg(unix)]
	{
		use std::os::unix::ffi::{OsStrExt as _, OsStringExt as _};

		let bytes = entry.as_bytes();
		let split = bytes
			.iter()
			.position(|byte| *byte == b'=')
			.unwrap_or(bytes.len());
		let name = OsString::from_vec(bytes[..split].to_vec());
		let value = if split == bytes.len() {
			OsString::new()
		} else {
			OsString::from_vec(bytes[split + 1..].to_vec())
		};
		(name, value)
	}
	#[cfg(windows)]
	{
		use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};

		let wide = entry.encode_wide().collect::<Vec<_>>();
		let split = wide
			.iter()
			.position(|unit| *unit == b'=' as u16)
			.unwrap_or(wide.len());
		let name = OsString::from_wide(&wide[..split]);
		let value = if split == wide.len() {
			OsString::new()
		} else {
			OsString::from_wide(&wide[split + 1..])
		};
		return (name, value);
	}
	#[cfg(not(any(unix, windows)))]
	{
		let text = entry.to_string_lossy();
		let (name, value) = text.split_once('=').unwrap_or((&text, ""));
		(OsString::from(name), OsString::from(value))
	}
}
