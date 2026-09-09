//! Path-embedded selectors and read-target resolution primitives.

use std::{
	borrow::Cow,
	collections::HashMap,
	env, fs, io,
	path::{Path, PathBuf},
};

use omp_core::{IntoStr, Str};

use super::resolver::Scheme;

/// One inclusive, one-based line range in a path selector.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LineRange {
	/// First selected line.
	pub start_line: u64,
	/// Last selected line, or `None` for a range extending to end-of-file.
	pub end_line:   Option<u64>,
}

/// A parsed read selector.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ParsedSelector {
	/// No recognized read selector was present.
	None,
	/// Return the resource verbatim.
	Raw,
	/// Summarize unresolved conflict regions.
	Conflicts,
	/// Rasterize a local SVG or SVGZ resource as a PNG image.
	Image,
	/// Return one or more line ranges, optionally verbatim.
	Lines {
		/// Sorted, merged ranges.
		ranges: Box<[LineRange]>,
		/// Whether numbering and hashline framing are disabled.
		raw:    bool,
	},
}

impl ParsedSelector {
	/// Whether this selector requests verbatim output.
	pub const fn is_raw(&self) -> bool {
		matches!(self, Self::Raw | Self::Lines { raw: true, .. })
	}

	/// Whether this selector contains more than one disjoint line range.
	pub fn is_multi_range(&self) -> bool {
		matches!(self, Self::Lines { ranges, .. } if ranges.len() > 1)
	}

	/// Convert the first range to the offset and optional limit used by paged
	/// readers.
	pub fn offset_limit(&self) -> (Option<u64>, Option<u64>) {
		match self {
			Self::Lines { ranges, .. } => {
				let Some(first) = ranges.first().copied() else {
					return (None, None);
				};
				let limit = first.end_line.map(|end| end - first.start_line + 1);
				(Some(first.start_line), limit)
			},
			_ => (None, None),
		}
	}
}

/// A selector syntax or bounds error suitable for a model-facing tool fault.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{0}")]
pub struct SelectorError(Str);

impl SelectorError {
	/// Constructs a selector error with model-facing text.
	pub fn from_message(message: impl IntoStr) -> Self {
		Self(message.into_str())
	}

	/// Model-facing error text.
	pub fn message(&self) -> &str {
		self.0.as_ref()
	}
}

/// Parse one `N`, `N-M`, `N-`, `N+K`, `N..M`, or `N..` range chunk.
pub fn parse_line_range_chunk(input: &str) -> Result<Option<LineRange>, SelectorError> {
	let input = input
		.strip_prefix('L')
		.or_else(|| input.strip_prefix('l'))
		.unwrap_or(input);
	let digit_end = input.bytes().take_while(u8::is_ascii_digit).count();
	if digit_end == 0 {
		return Ok(None);
	}
	let start = parse_u64(&input[..digit_end])?;
	if start == 0 {
		return Err(SelectorError::from_message(
			"Line selector 0 is invalid; lines are 1-indexed. Use :1.",
		));
	}
	let rest = &input[digit_end..];
	if rest.is_empty() {
		return Ok(Some(LineRange { start_line: start, end_line: None }));
	}
	let (separator, rhs) = if let Some(rhs) = rest.strip_prefix("..") {
		('-', rhs)
	} else if let Some(rhs) = rest.strip_prefix('-') {
		('-', rhs)
	} else if let Some(rhs) = rest.strip_prefix('+') {
		('+', rhs)
	} else {
		return Ok(None);
	};
	let rhs = rhs
		.strip_prefix('L')
		.or_else(|| rhs.strip_prefix('l'))
		.unwrap_or(rhs);
	if rhs.bytes().any(|byte| !byte.is_ascii_digit()) {
		return Ok(None);
	}
	if separator == '-' && rhs.is_empty() {
		return Ok(Some(LineRange { start_line: start, end_line: None }));
	}
	if rhs.is_empty() {
		return Ok(None);
	}
	let value = parse_u64(rhs)?;
	if separator == '+' {
		if value == 0 {
			return Err(SelectorError::from_message(format!(
				"Invalid range {start}+0: count must be >= 1."
			)));
		}
		let end = start.checked_add(value - 1).ok_or_else(|| {
			SelectorError::from_message(format!("Invalid range {start}+{value}: count is too large."))
		})?;
		return Ok(Some(LineRange { start_line: start, end_line: Some(end) }));
	}
	if value < start {
		return Err(SelectorError::from_message(format!(
			"Invalid range {start}-{value}: end must be >= start."
		)));
	}
	Ok(Some(LineRange { start_line: start, end_line: Some(value) }))
}

fn parse_u64(input: &str) -> Result<u64, SelectorError> {
	input
		.parse()
		.map_err(|_| SelectorError::from_message(format!("Line selector '{input}' is too large.")))
}

/// Parse, sort, and merge a comma-separated list of line ranges.
pub fn parse_line_ranges(input: &str) -> Result<Option<Box<[LineRange]>>, SelectorError> {
	let mut ranges = Vec::new();
	for chunk in input.split(',') {
		let Some(range) = parse_line_range_chunk(chunk)? else {
			return Ok(None);
		};
		ranges.push(range);
	}
	if ranges.is_empty() {
		return Ok(None);
	}
	ranges.sort_unstable_by_key(|range| range.start_line);
	let mut merged: Vec<LineRange> = Vec::with_capacity(ranges.len());
	for current in ranges {
		let Some(last) = merged.last_mut() else {
			merged.push(current);
			continue;
		};
		let Some(last_end) = last.end_line else {
			continue;
		};
		if current.start_line <= last_end.saturating_add(1) {
			match current.end_line {
				None => last.end_line = None,
				Some(end) if end > last_end => last.end_line = Some(end),
				Some(_) => {},
			}
		} else {
			merged.push(current);
		}
	}
	Ok(Some(merged.into_boxed_slice()))
}

/// Extract line ranges from a selector while ignoring raw/conflict display
/// chunks.
pub fn selector_line_ranges(
	selector: Option<&str>,
) -> Result<Option<Box<[LineRange]>>, SelectorError> {
	let Some(selector) = selector else {
		return Ok(None);
	};
	for chunk in selector.split(':') {
		if chunk.eq_ignore_ascii_case("raw") || chunk.eq_ignore_ascii_case("conflicts") {
			continue;
		}
		if let Some(ranges) = parse_line_ranges(chunk)? {
			return Ok(Some(ranges));
		}
	}
	Ok(None)
}

/// Whether a one-based line number falls in any supplied range.
pub fn line_is_in_ranges(line_number: u64, ranges: &[LineRange]) -> bool {
	ranges.iter().any(|range| {
		line_number >= range.start_line && range.end_line.is_none_or(|end| line_number <= end)
	})
}

/// Parse a selector suffix, preserving unrecognized suffixes for archive,
/// SQLite, and URL dispatch.
pub fn parse_selector(input: Option<&str>) -> Result<ParsedSelector, SelectorError> {
	let Some(input) = input.filter(|value| !value.is_empty()) else {
		return Ok(ParsedSelector::None);
	};
	if input.contains(':') {
		let mut chunks = input.split(':');
		let first = chunks.next().unwrap_or_default();
		let second = chunks.next();
		if let Some(second) = second.filter(|_| chunks.next().is_none()) {
			let range = if first.eq_ignore_ascii_case("raw") {
				Some(second)
			} else if second.eq_ignore_ascii_case("raw") {
				Some(first)
			} else {
				None
			};
			if let Some(ranges) = range.map(parse_line_ranges).transpose()?.flatten() {
				return Ok(ParsedSelector::Lines { ranges, raw: true });
			}
		}
		let mut all_read_like = true;
		for chunk in input.split(':') {
			if !selector_chunk_looks_read_like(chunk)? {
				all_read_like = false;
				break;
			}
		}
		if all_read_like {
			return Err(invalid_selector(input));
		}
		return Ok(ParsedSelector::None);
	}
	if input.eq_ignore_ascii_case("raw") {
		return Ok(ParsedSelector::Raw);
	}
	if input.eq_ignore_ascii_case("conflicts") {
		return Ok(ParsedSelector::Conflicts);
	}
	if input.eq_ignore_ascii_case("img") {
		return Ok(ParsedSelector::Image);
	}
	Ok(match parse_line_ranges(input)? {
		Some(ranges) => ParsedSelector::Lines { ranges, raw: false },
		None => ParsedSelector::None,
	})
}

fn selector_chunk_looks_read_like(input: &str) -> Result<bool, SelectorError> {
	if input.eq_ignore_ascii_case("raw") || input.eq_ignore_ascii_case("conflicts") {
		return Ok(true);
	}
	if input.eq_ignore_ascii_case("img") {
		return Ok(true);
	}
	if parse_line_ranges(input)?.is_some() {
		return Ok(true);
	}
	let Some(rest) = input.strip_prefix('-') else {
		return Ok(false);
	};
	let digit_end = rest.bytes().take_while(u8::is_ascii_digit).count();
	if digit_end == 0 {
		return Ok(false);
	}
	let tail = &rest[digit_end..];
	if tail.is_empty() {
		return Ok(true);
	}
	let Some(rhs) = tail.strip_prefix('-').or_else(|| tail.strip_prefix('+')) else {
		return Ok(false);
	};
	Ok(!rhs.is_empty() && rhs.bytes().all(|byte| byte.is_ascii_digit()))
}

fn invalid_selector(input: &str) -> SelectorError {
	SelectorError::from_message(format!(
		"Invalid selector ':{input}'. Use :N, :N-M, :N+K, :N- (open-ended), a comma-separated list \
		 of ranges, :raw, :img for SVG rendering, or a range combined with raw (e.g. :raw:50-100)."
	))
}

/// Borrowed result of separating a path from a recognized trailing selector.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SplitPath<'a> {
	/// Resource path without the selector.
	pub path:     &'a str,
	/// Selector text without its leading colon.
	pub selector: Option<&'a str>,
}

/// Peel a strict filesystem-path selector from the end of `raw_path`.
pub fn split_path_and_selector(raw_path: &str) -> SplitPath<'_> {
	let Some(colon) = raw_path.rfind(':').filter(|colon| *colon > 0) else {
		return SplitPath { path: raw_path, selector: None };
	};
	let candidate = &raw_path[colon + 1..];
	if !is_simple_selector(candidate) {
		return SplitPath { path: raw_path, selector: None };
	}
	let mut path = &raw_path[..colon];
	let mut selector = candidate;
	if let Some(inner_colon) = path.rfind(':').filter(|colon| *colon > 0) {
		let inner = &path[inner_colon + 1..];
		let compound = (inner.eq_ignore_ascii_case("raw") && is_range_list(candidate))
			|| (is_range_list(inner) && candidate.eq_ignore_ascii_case("raw"));
		if compound {
			path = &path[..inner_colon];
			selector = &raw_path[inner_colon + 1..];
		}
	}
	SplitPath { path, selector: Some(selector) }
}

fn is_simple_selector(input: &str) -> bool {
	input.eq_ignore_ascii_case("raw")
		|| input.eq_ignore_ascii_case("conflicts")
		|| input.eq_ignore_ascii_case("img")
		|| is_range_list(input)
}

fn is_range_list(input: &str) -> bool {
	!input.is_empty() && input.split(',').all(is_range_chunk_syntax)
}

fn is_range_chunk_syntax(input: &str) -> bool {
	let input = input
		.strip_prefix('L')
		.or_else(|| input.strip_prefix('l'))
		.unwrap_or(input);
	let digit_end = input.bytes().take_while(u8::is_ascii_digit).count();
	if digit_end == 0 {
		return false;
	}
	let rest = &input[digit_end..];
	if rest.is_empty() || rest == "-" || rest == ".." {
		return true;
	}
	let Some(rhs) = rest
		.strip_prefix('-')
		.or_else(|| rest.strip_prefix('+'))
		.or_else(|| rest.strip_prefix(".."))
	else {
		return false;
	};
	let rhs = rhs
		.strip_prefix('L')
		.or_else(|| rhs.strip_prefix('l'))
		.unwrap_or(rhs);
	!rhs.is_empty() && rhs.bytes().all(|byte| byte.is_ascii_digit())
}

/// Result of probing whether an exact literal path exists.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiteralPathProbe {
	/// The exact entry exists, including a dangling symlink.
	Exists,
	/// The exact entry definitively does not exist.
	Missing,
	/// An access or transient error makes existence ambiguous.
	Unknown,
}

/// Probe an exact path with symlink metadata so dangling symlinks count as
/// existing.
pub fn probe_literal_path(raw_path: &str, cwd: &Path) -> LiteralPathProbe {
	let expanded = expand_tilde(raw_path, None);
	let resolved = if expanded.is_absolute() {
		expanded
	} else {
		cwd.join(expanded)
	};
	match fs::symlink_metadata(resolved) {
		Ok(_) => LiteralPathProbe::Exists,
		Err(error)
			if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) =>
		{
			LiteralPathProbe::Missing
		},
		Err(_) => LiteralPathProbe::Unknown,
	}
}

/// Split a selector only when the exact literal path is definitively missing.
pub fn split_path_and_selector_preferring_literal(
	raw_path: &str,
	mut probe: impl FnMut(&str) -> LiteralPathProbe,
) -> SplitPath<'_> {
	let strict = split_path_and_selector(raw_path);
	if strict.selector.is_none() || probe(raw_path) == LiteralPathProbe::Missing {
		strict
	} else {
		SplitPath { path: raw_path, selector: None }
	}
}

/// Expand a leading tilde using `home`, or the process home directory when
/// omitted.
pub fn expand_tilde(path: &str, home: Option<&Path>) -> PathBuf {
	if !path.starts_with('~') {
		return PathBuf::from(path);
	}
	let home = home.map(Path::to_path_buf).or_else(home_dir);
	let Some(mut home) = home else {
		return PathBuf::from(path);
	};
	if path == "~" {
		return home;
	}
	let tail = path
		.strip_prefix("~/")
		.or_else(|| path.strip_prefix("~\\"))
		.unwrap_or_else(|| &path[1..]);
	home.push(tail);
	home
}

fn home_dir() -> Option<PathBuf> {
	env::var_os("HOME")
		.or_else(|| env::var_os("USERPROFILE"))
		.map(PathBuf::from)
}

/// Split documented semicolon- or comma-delimited targets after trimming
/// whitespace and outer double quotes.
///
/// Callers must first prefer an exact literal path and confirm every split
/// member is addressable. This deliberately keeps commas in range selectors
/// from becoming target separators.
pub fn split_delimited_targets(input: &str) -> Vec<Str> {
	input
		.split([';', ','])
		.map(normalize_path_input)
		.filter(|part| !part.is_empty())
		.map(Str::new)
		.collect()
}

/// Split semicolon-delimited targets for tools whose path grammar reserves
/// commas for another purpose.
pub fn split_semicolon_targets(input: &str) -> Vec<Str> {
	input
		.split(';')
		.map(normalize_path_input)
		.filter(|part| !part.is_empty())
		.map(Str::new)
		.collect()
}

/// Parse a JSON-encoded path array, preserving ordinary path strings that do
/// not begin with an array delimiter.
pub fn parse_json_path_array(input: &str) -> Result<Option<Vec<Str>>, SelectorError> {
	let input = input.trim();
	if !input.starts_with('[') {
		return Ok(None);
	}
	let paths: Vec<String> = serde_json::from_str(input)
		.map_err(|error| SelectorError::from_message(format!("Invalid JSON path array: {error}")))?;
	if paths.is_empty() {
		return Err(SelectorError::from_message("JSON path array must not be empty."));
	}
	let paths = paths
		.into_iter()
		.map(|path| Str::new(normalize_path_input(&path)))
		.collect::<Vec<_>>();
	if paths.iter().any(|path| path.is_empty()) {
		return Err(SelectorError::from_message("JSON path arrays must not contain empty paths."));
	}
	Ok(Some(paths))
}

/// Split documented delimited targets unless the entire input is an existing
/// or ambiguous literal path.
pub fn split_delimited_targets_preferring_literal(
	input: &str,
	mut probe: impl FnMut(&str) -> LiteralPathProbe,
) -> Vec<Str> {
	if !input.contains([';', ',']) || probe(input) != LiteralPathProbe::Missing {
		return vec![Str::new(normalize_path_input(input))];
	}
	split_delimited_targets(input)
}

fn normalize_path_input(input: &str) -> &str {
	let trimmed = input.trim();
	if trimmed.len() > 1 && trimmed.starts_with('"') && trimmed.ends_with('"') {
		&trimmed[1..trimmed.len() - 1]
	} else {
		trimmed
	}
}

/// Percent-encode literal URI/member delimiters so they cannot be parsed as
/// selectors or queries.
pub fn percent_encode_member_delimiters(input: &str) -> Cow<'_, str> {
	if !input.bytes().any(|byte| matches!(byte, b':' | b'?' | b'#')) {
		return Cow::Borrowed(input);
	}
	let mut encoded = String::with_capacity(input.len() + 6);
	for character in input.chars() {
		match character {
			':' => encoded.push_str("%3A"),
			'?' => encoded.push_str("%3F"),
			'#' => encoded.push_str("%23"),
			_ => encoded.push(character),
		}
	}
	Cow::Owned(encoded)
}

/// A pure parse of one absolute URI.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParsedUri<'a> {
	/// Built-in scheme, or [`Scheme::Unknown`] for a valid unrecognized scheme.
	pub scheme:        Scheme,
	/// Caller spelling before `://`, with case preserved.
	pub raw_scheme:    &'a str,
	/// Authority before the first slash, with case and any port preserved.
	pub authority:     &'a str,
	/// Slash-prefixed hierarchical path, or an empty string.
	pub path:          &'a str,
	/// Address payload after `://`, excluding query and selector syntax.
	pub resource:      &'a str,
	/// Query text without the leading `?`.
	pub query:         Option<&'a str>,
	/// Parsed trailing selector.
	pub selector:      ParsedSelector,
	/// Original selector text without its leading colon.
	pub selector_text: Option<&'a str>,
}

/// Purely parses an absolute URI and its trailing read selector.
///
/// `Ok(None)` means `input` has no syntactically valid URI scheme. No path,
/// network, or registry I/O occurs.
pub fn parse_uri(input: &str) -> Result<Option<ParsedUri<'_>>, SelectorError> {
	let Some(separator) = input.find("://") else {
		return Ok(None);
	};
	let raw_scheme = &input[..separator];
	if !valid_uri_scheme(raw_scheme) {
		return Ok(None);
	}
	let scheme = Scheme::parse(raw_scheme);
	let split = split_uri_selector(input, raw_scheme, scheme);
	let resource_start = raw_scheme.len() + 3;
	let address = &split.path[resource_start..];
	let (resource, query) = if scheme == Scheme::Mcp {
		(address, None)
	} else {
		(
			address
				.split_once('?')
				.map_or(address, |(resource, _)| resource),
			input
				.split_once('?')
				.map(|(_, query)| query.split_once('#').map_or(query, |(query, _)| query)),
		)
	};
	if (scheme != Scheme::Mcp && input.contains('#'))
		|| (resource.is_empty() && matches!(scheme, Scheme::File | Scheme::Http | Scheme::Unknown))
		|| resource
			.bytes()
			.any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
		|| query.is_some_and(|query| {
			query
				.bytes()
				.any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control() || byte == b'#')
		}) {
		return Err(SelectorError::from_message(format!(
			"Invalid URL '{input}': path and query must contain no whitespace or fragment; an empty \
			 resource is allowed only for a built-in internal scheme root."
		)));
	}
	let (authority, path) = resource
		.split_once('/')
		.map_or((resource, ""), |(authority, _)| (authority, &resource[authority.len()..]));
	let selector = parse_selector(split.selector)?;
	Ok(Some(ParsedUri {
		scheme,
		raw_scheme,
		authority,
		path,
		resource,
		query,
		selector,
		selector_text: split.selector,
	}))
}

fn valid_uri_scheme(scheme: &str) -> bool {
	let mut bytes = scheme.bytes();
	matches!(bytes.next(), Some(byte) if byte.is_ascii_alphabetic())
		&& bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-'))
}

/// Split selectors from URLs whose resource grammar permits them.
pub fn split_internal_uri_selector(raw_path: &str) -> SplitPath<'_> {
	let Some(separator) = raw_path.find("://") else {
		return SplitPath { path: raw_path, selector: None };
	};
	let raw_scheme = &raw_path[..separator];
	if !valid_uri_scheme(raw_scheme) {
		return SplitPath { path: raw_path, selector: None };
	}
	split_uri_selector(raw_path, raw_scheme, Scheme::parse(raw_scheme))
}

fn split_uri_selector<'a>(raw_path: &'a str, raw_scheme: &str, scheme: Scheme) -> SplitPath<'a> {
	if !scheme.accepts_selectors() {
		return SplitPath { path: raw_path, selector: None };
	}
	let scheme_end = raw_scheme.len() + 3;
	let query_start = raw_path[scheme_end..]
		.find(['?', '#'])
		.map_or(raw_path.len(), |offset| scheme_end + offset);
	let hierarchical = &raw_path[scheme_end..query_start];
	if scheme == Scheme::Ssh && !hierarchical.contains('/') {
		return SplitPath { path: raw_path, selector: None };
	}
	let mut path_end = query_start;
	let mut first_selector_start = None;
	while let Some(colon) = raw_path[..path_end]
		.rfind(':')
		.filter(|colon| *colon >= scheme_end)
	{
		if !internal_selector_chunk(&raw_path[colon + 1..path_end]) {
			break;
		}
		first_selector_start = Some(colon + 1);
		path_end = colon;
	}
	match first_selector_start {
		Some(start) if query_start == raw_path.len() => {
			SplitPath { path: &raw_path[..path_end], selector: Some(&raw_path[start..]) }
		},
		Some(start) => SplitPath {
			path:     &raw_path[..path_end],
			selector: Some(&raw_path[start..query_start]),
		},
		None => SplitPath { path: raw_path, selector: None },
	}
}

fn internal_selector_chunk(input: &str) -> bool {
	is_simple_selector(input) || selector_chunk_looks_read_like(input).unwrap_or(true)
}

/// A unique suffix resolution candidate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SuffixMatch {
	/// Absolute filesystem path selected for the read.
	pub absolute_path: PathBuf,
	/// Workspace-relative path shown to the model.
	pub display_path:  Str,
}

/// Select the sole candidate whose complete trailing path matches the authored
/// missing path.
pub fn unique_suffix_match<'a>(
	raw_path: &str,
	cwd: &Path,
	candidates: impl IntoIterator<Item = &'a Path>,
) -> Option<SuffixMatch> {
	let normalized = normalize_suffix(raw_path)?;
	let mut found: Option<SuffixMatch> = None;
	for candidate in candidates {
		let display = candidate.strip_prefix(cwd).unwrap_or(candidate);
		let candidate_normalized = display.to_string_lossy().replace('\\', "/");
		if candidate_normalized != normalized
			&& !candidate_normalized.ends_with(&format!("/{normalized}"))
		{
			continue;
		}
		let next = SuffixMatch {
			absolute_path: if candidate.is_absolute() {
				candidate.to_path_buf()
			} else {
				cwd.join(candidate)
			},
			display_path:  Str::new(candidate_normalized),
		};
		if found
			.as_ref()
			.is_some_and(|prior| prior.absolute_path != next.absolute_path)
		{
			return None;
		}
		found = Some(next);
	}
	found
}

fn normalize_suffix(raw_path: &str) -> Option<String> {
	let normalized = raw_path
		.replace('\\', "/")
		.trim_start_matches("./")
		.trim_end_matches('/')
		.to_owned();
	(!normalized.is_empty()).then_some(normalized)
}

/// Per-execution memo for suffix lookups; `None` records a confirmed miss or
/// ambiguity.
#[derive(Debug, Default)]
pub struct SuffixMatchCache(HashMap<Str, Option<SuffixMatch>>);

impl SuffixMatchCache {
	/// Return a cached lookup when this authored path has already been scanned.
	pub fn get(&self, raw_path: &str) -> Option<&Option<SuffixMatch>> {
		self.0.get(raw_path)
	}

	/// Record and return a suffix lookup result.
	pub fn insert(&mut self, raw_path: impl Into<Str>, result: Option<SuffixMatch>) {
		self.0.insert(raw_path.into(), result);
	}
}

#[cfg(test)]
mod tests {
	use omp_core::sf;

	use super::*;
	#[test]
	fn parses_and_merges_ranges() {
		let parsed = parse_selector(Some("9-10,5+4,20-")).unwrap();
		assert_eq!(parsed, ParsedSelector::Lines {
			ranges: Box::from([LineRange { start_line: 5, end_line: Some(10) }, LineRange {
				start_line: 20,
				end_line:   None,
			},]),
			raw:    false,
		});
	}

	#[test]
	fn accepts_raw_compounds_and_rejects_selector_like_compounds() {
		assert!(matches!(parse_selector(Some("raw:50-100")).unwrap(), ParsedSelector::Lines {
			raw: true,
			..
		}));
		assert_eq!(
			parse_selector(Some("raw:conflicts"))
				.unwrap_err()
				.to_string(),
			"Invalid selector ':raw:conflicts'. Use :N, :N-M, :N+K, :N- (open-ended), a \
			 comma-separated list of ranges, :raw, :img for SVG rendering, or a range combined with \
			 raw (e.g. :raw:50-100)."
		);
		assert_eq!(parse_selector(Some("table:key")).unwrap(), ParsedSelector::None);
	}

	#[test]
	fn literal_path_probe_can_override_selector_splitting() {
		let strict = split_path_and_selector("foo:1");
		assert_eq!(strict, SplitPath { path: "foo", selector: Some("1") });
		let literal =
			split_path_and_selector_preferring_literal("foo:1", |_| LiteralPathProbe::Exists);
		assert_eq!(literal, SplitPath { path: "foo:1", selector: None });
	}

	#[test]
	fn parses_known_and_unknown_uri_schemes_without_io() {
		let http = parse_uri("https://example.com/page:5-7").unwrap().unwrap();
		assert_eq!(http.scheme, Scheme::Http);
		assert_eq!(http.resource, "example.com/page");
		assert!(matches!(http.selector, ParsedSelector::Lines { .. }));

		let unknown = parse_uri("custom://pending:raw").unwrap().unwrap();
		assert_eq!(unknown.scheme, Scheme::Unknown);
		assert_eq!(unknown.resource, "pending:raw");
		assert_eq!(unknown.selector, ParsedSelector::None);

		let mcp = parse_uri("mcp://server/resource:50").unwrap().unwrap();
		assert_eq!(mcp.scheme, Scheme::Mcp);
		assert_eq!(mcp.resource, "server/resource:50");
		assert_eq!(mcp.selector, ParsedSelector::None);

		let conflict = parse_uri("conflict://17/ours:raw").unwrap().unwrap();
		assert_eq!(conflict.scheme, Scheme::Conflict);
		assert_eq!(conflict.resource, "17/ours");
		assert_eq!(conflict.selector, ParsedSelector::Raw);
		let history = parse_uri("history://").unwrap().unwrap();
		assert_eq!(history.scheme, Scheme::History);
		assert_eq!(history.resource, "");
	}

	#[test]
	fn separates_authority_path_query_and_selector_without_treating_ports_as_ranges() {
		let cases = [
			(
				"ssh://alice@example.com:2222/tmp/file:5-7",
				"alice@example.com:2222",
				"/tmp/file",
				None,
				Some("5-7"),
			),
			(
				"agent://Review/output?q=.result.items[0]",
				"Review",
				"/output",
				Some("q=.result.items[0]"),
				None,
			),
			(
				"agent://Review/output:raw?q=.result",
				"Review",
				"/output",
				Some("q=.result"),
				Some("raw"),
			),
			("artifact://17:1-20", "17", "", None, Some("1-20")),
			("skill://plugin:name/file", "plugin:name", "/file", None, None),
		];
		for (input, authority, path, query, selector) in cases {
			let parsed = parse_uri(input).unwrap().unwrap();
			assert_eq!(parsed.authority, authority, "{input}");
			assert_eq!(parsed.path, path, "{input}");
			assert_eq!(parsed.query, query, "{input}");
			assert_eq!(parsed.selector_text, selector, "{input}");
		}
	}

	#[test]
	fn keeps_opaque_payload_only_inside_explicit_mcp_wrapper() {
		assert!(parse_uri("urn:example:document").unwrap().is_none());
		let parsed = parse_uri("mcp://urn:example:document?view=full#part")
			.unwrap()
			.unwrap();
		assert_eq!(parsed.scheme, Scheme::Mcp);
		assert_eq!(parsed.resource, "urn:example:document?view=full#part");
		assert_eq!(parsed.query, None);
		assert_eq!(parsed.selector, ParsedSelector::None);
	}

	#[test]
	fn encodes_only_member_delimiters_without_damaging_unicode() {
		assert_eq!(percent_encode_member_delimiters("café:a?b#c"), "café%3Aa%3Fb%23c");
	}

	#[test]
	fn suffix_selection_requires_uniqueness() {
		let cwd = Path::new("/workspace");
		let one = [Path::new("/workspace/src/foo.rs")];
		let matched = unique_suffix_match("src/foo.rs", cwd, one).unwrap();
		assert_eq!(&*matched.display_path, "src/foo.rs");
		let ambiguous = [Path::new("/workspace/a/src/foo.rs"), Path::new("/workspace/b/src/foo.rs")];
		assert!(unique_suffix_match("src/foo.rs", cwd, ambiguous).is_none());
	}
	#[test]
	fn documented_selectors_parse_and_split_round_trip() {
		let cases = [
			("1", ParsedSelector::Lines {
				ranges: Box::from([LineRange { start_line: 1, end_line: None }]),
				raw:    false,
			}),
			("5-16", ParsedSelector::Lines {
				ranges: Box::from([LineRange { start_line: 5, end_line: Some(16) }]),
				raw:    false,
			}),
			("960+14", ParsedSelector::Lines {
				ranges: Box::from([LineRange { start_line: 960, end_line: Some(973) }]),
				raw:    false,
			}),
			("5-", ParsedSelector::Lines {
				ranges: Box::from([LineRange { start_line: 5, end_line: None }]),
				raw:    false,
			}),
			("5..16", ParsedSelector::Lines {
				ranges: Box::from([LineRange { start_line: 5, end_line: Some(16) }]),
				raw:    false,
			}),
			("5-16,960-973", ParsedSelector::Lines {
				ranges: Box::from([LineRange { start_line: 5, end_line: Some(16) }, LineRange {
					start_line: 960,
					end_line:   Some(973),
				}]),
				raw:    false,
			}),
			("raw", ParsedSelector::Raw),
			("conflicts", ParsedSelector::Conflicts),
			("img", ParsedSelector::Image),
			("raw:5-16", ParsedSelector::Lines {
				ranges: Box::from([LineRange { start_line: 5, end_line: Some(16) }]),
				raw:    true,
			}),
			("5-16:raw", ParsedSelector::Lines {
				ranges: Box::from([LineRange { start_line: 5, end_line: Some(16) }]),
				raw:    true,
			}),
		];
		for (suffix, expected) in cases {
			assert_eq!(parse_selector(Some(suffix)).unwrap(), expected, ":{suffix}");
			let input = format!("src/lib.rs:{suffix}");
			let split = split_path_and_selector(&input);
			assert_eq!(split.path, "src/lib.rs", ":{suffix}");
			assert_eq!(split.selector, Some(suffix), ":{suffix}");
			assert_eq!(format!("{}:{}", split.path, split.selector.unwrap()), input);
		}
	}

	#[test]
	fn parses_json_and_delimited_target_lists_without_losing_literals() {
		assert_eq!(
			parse_json_path_array(r#"["src/a.rs", "src/b.rs:5-16"]"#).unwrap(),
			Some(vec![sf!("src/a.rs"), sf!("src/b.rs:5-16")])
		);
		assert_eq!(split_delimited_targets("src/a.rs; src/b.rs, \"src/c.rs\""), vec![
			sf!("src/a.rs"),
			sf!("src/b.rs"),
			sf!("src/c.rs"),
		]);
		assert_eq!(
			split_delimited_targets_preferring_literal("report,final.txt", |_| {
				LiteralPathProbe::Exists
			}),
			vec![sf!("report,final.txt")]
		);
	}
}
