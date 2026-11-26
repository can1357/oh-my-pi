//! Hackage (`hackage.haskell.org/package/<name>`): the package's latest version
//! from the JSON version map, then its metadata from the latest `.cabal` file.

use std::{cmp::Ordering, fmt::Write as _};

use url::Url;

use super::{Action, Context, Done, Fetch, Site, fetch, segment};

/// Registry entry.
pub const SITE: Site = Site { name: "hackage", open };

const METHOD: &str = "hackage";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if url.host_str()? != "hackage.haskell.org" {
		return None;
	}
	let package_id = package_id(url.path())?;
	let versions = format!("https://hackage.haskell.org/package/{}.json", segment(&package_id));
	fetch(Fetch::get(versions).accept_json(), move |reply, _| {
		let versions = reply.json_value()?;
		let latest = versions
			.as_object()?
			.keys()
			.max_by(|a, b| compare_versions(a, b))?
			.to_owned();
		let cabal = format!(
			"https://hackage.haskell.org/package/{}-{}/{}.cabal",
			segment(&package_id),
			segment(&latest),
			segment(&package_id)
		);
		fetch(Fetch::get(cabal).header("Accept", "text/plain"), move |reply, _| {
			let cabal = Cabal::parse(&reply.body_text()?);
			let title =
				non_empty(cabal.name.as_deref()).map_or_else(|| package_id.clone(), str::to_owned);
			Done::new(cabal.markdown(&package_id, &latest), METHOD)
				.title(title)
				.note("Fetched via Hackage API")
				.finish()
		})
	})
}

/// Package id of `/package/<name>`, percent-decoded.
fn package_id(path: &str) -> Option<String> {
	let rest = path.strip_prefix("/package/")?;
	let id = rest.split('/').next()?;
	if id.is_empty() {
		return None;
	}
	decode_component(id)
}

/// Percent-decode a path segment, as `decodeURIComponent` does (`None` on a
/// malformed escape, which the TS handler treated as an unusable URL).
fn decode_component(text: &str) -> Option<String> {
	let bytes = text.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] == b'%' {
			let hex = std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?;
			out.push(u8::from_str_radix(hex, 16).ok()?);
			index += 3;
		} else {
			out.push(bytes[index]);
			index += 1;
		}
	}
	String::from_utf8(out).ok()
}

/// Metadata read from a `.cabal` file.
struct Cabal {
	name:        Option<String>,
	version:     Option<String>,
	synopsis:    Option<String>,
	description: Option<String>,
	license:     Option<String>,
	author:      Option<String>,
	maintainer:  Option<String>,
	homepage:    Option<String>,
	bug_reports: Option<String>,
	category:    Option<String>,
	stability:   Option<String>,
}

impl Cabal {
	fn parse(content: &str) -> Self {
		Self {
			name:        field(content, "name"),
			version:     field(content, "version"),
			synopsis:    field(content, "synopsis"),
			description: description(content),
			license:     field(content, "license"),
			author:      field(content, "author"),
			maintainer:  field(content, "maintainer"),
			homepage:    field(content, "homepage"),
			bug_reports: field(content, "bug-reports"),
			category:    field(content, "category"),
			stability:   field(content, "stability"),
		}
	}

	/// Markdown of the record, `package_id`/`latest` standing in for absent
	/// fields.
	fn markdown(&self, package_id: &str, latest: &str) -> String {
		let mut md = format!("# {}\n\n", non_empty(self.name.as_deref()).unwrap_or(package_id));
		if let Some(synopsis) = non_empty(self.synopsis.as_deref()) {
			let _ = write!(md, "{synopsis}\n\n");
		}
		let _ = write!(md, "**Version:** {}", non_empty(self.version.as_deref()).unwrap_or(latest));
		if let Some(license) = non_empty(self.license.as_deref()) {
			let _ = write!(md, " · **License:** {license}");
		}
		md.push('\n');

		let lines = [
			("Author", &self.author),
			("Maintainer", &self.maintainer),
			("Category", &self.category),
			("Stability", &self.stability),
			("Homepage", &self.homepage),
			("Bug Reports", &self.bug_reports),
		];
		for (label, value) in lines {
			if let Some(value) = non_empty(value.as_deref()) {
				let _ = writeln!(md, "**{label}:** {value}");
			}
		}
		if let Some(description) = non_empty(self.description.as_deref()) {
			let _ = write!(md, "\n## Description\n\n{description}\n");
		}
		md
	}
}

/// The value of `name:` at the start of a line, whitespace after the colon
/// skipped (a bare `name:` takes the following line's content, as the TS
/// regex's `\s*` did).
fn field(content: &str, name: &str) -> Option<String> {
	let lower = content.to_ascii_lowercase();
	let mut offset = 0;
	while let Some(found) = lower[offset..].find(name) {
		let start = offset + found;
		let at_line_start = start == 0 || content.as_bytes()[start - 1] == b'\n';
		let after = content.get(start + name.len()..)?;
		if at_line_start && let Some(rest) = after.strip_prefix(':') {
			let line = rest
				.trim_start()
				.split(['\n', '\r'])
				.next()
				.unwrap_or_default();
			return Some(line.trim().to_owned());
		}
		offset = start + name.len();
	}
	None
}

/// The `description:` field with its two-space-indented continuation lines.
fn description(content: &str) -> Option<String> {
	let lines: Vec<&str> = content.split('\n').collect();
	let start = lines
		.iter()
		.position(|line| line.to_ascii_lowercase().starts_with("description:"))?;
	let mut chunks = vec![lines[start].get("description:".len()..)?.trim().to_owned()];
	for line in &lines[start + 1..] {
		if !line.starts_with("  ") {
			break;
		}
		chunks.push(line.trim().to_owned());
	}
	let text = chunks.join("\n");
	let text = text.trim();
	(!text.is_empty()).then(|| text.to_owned())
}

/// A non-empty trimmed string.
fn non_empty(value: Option<&str>) -> Option<&str> {
	value.map(str::trim).filter(|value| !value.is_empty())
}

/// SemVer-2.0-aware version order (the TS `compareVersions`).
fn compare_versions(a: &str, b: &str) -> Ordering {
	let (core_a, pre_a) = version_parts(a);
	let (core_b, pre_b) = version_parts(b);
	compare_core(&core_a, &core_b)
		.then_with(|| compare_prerelease(pre_a.as_deref(), pre_b.as_deref()))
}

/// Dot-separated core segments and optional prerelease segments.
fn version_parts(version: &str) -> (Vec<&str>, Option<Vec<&str>>) {
	let trimmed = version.trim();
	let stripped = trimmed.strip_prefix(['v', 'V']).unwrap_or(trimmed);
	let build = stripped.split('+').next().unwrap_or(stripped);
	match build.split_once('-') {
		Some((core, prerelease)) => {
			(core.split('.').collect(), Some(prerelease.split('.').collect()))
		},
		None => (build.split('.').collect(), None),
	}
}

/// Compare dot-separated numeric segments; missing or malformed ones count as
/// 0.
fn compare_core(a: &[&str], b: &[&str]) -> Ordering {
	for index in 0..a.len().max(b.len()) {
		let order = compare_digits(digits(a.get(index).copied()), digits(b.get(index).copied()));
		if order != Ordering::Equal {
			return order;
		}
	}
	Ordering::Equal
}

/// SemVer-2.0 prerelease order; a plain release sorts after one.
fn compare_prerelease(a: Option<&[&str]>, b: Option<&[&str]>) -> Ordering {
	match (a, b) {
		(None, None) => Ordering::Equal,
		(None, Some(_)) => Ordering::Greater,
		(Some(_), None) => Ordering::Less,
		(Some(a), Some(b)) => {
			for index in 0..a.len().max(b.len()) {
				let order = match (a.get(index), b.get(index)) {
					(Some(left), Some(right)) => match (is_digits(left), is_digits(right)) {
						(true, true) => compare_digits(left, right),
						(false, false) => left.cmp(right),
						(true, false) => Ordering::Less,
						(false, true) => Ordering::Greater,
					},
					(None, Some(_)) => return Ordering::Less,
					(Some(_), None) => return Ordering::Greater,
					(None, None) => Ordering::Equal,
				};
				if order != Ordering::Equal {
					return order;
				}
			}
			Ordering::Equal
		},
	}
}

/// A segment that is all digits, or `"0"`.
fn digits(segment: Option<&str>) -> &str {
	segment.filter(|segment| is_digits(segment)).unwrap_or("0")
}

fn is_digits(segment: &str) -> bool {
	!segment.is_empty() && segment.bytes().all(|byte| byte.is_ascii_digit())
}

/// Exact integer comparison of digit strings.
fn compare_digits(a: &str, b: &str) -> Ordering {
	let a = trimmed_zeros(a);
	let b = trimmed_zeros(b);
	a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

fn trimmed_zeros(digits: &str) -> &str {
	let trimmed = digits.trim_start_matches('0');
	if trimmed.is_empty() { "0" } else { trimmed }
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::{
		super::{Fetched, testing::run},
		*,
	};

	const CABAL: &str = "name:           aeson\nversion:        2.2.3.0\nsynopsis:       Fast JSON parsing\
	                     \ndescription:    A JSON parsing and encoding library.\n                \
	                     Designed for performance.\nlicense:        BSD3\n\
	                     author:         Bryan O'Sullivan <bos@example.com>\nmaintainer:     \
	                     adam@example.com\ncategory:       Text, Web\nstability:      experimental\n\
	                     homepage:       https://github.com/haskell/aeson\nbug-reports:    \
	                     https://github.com/haskell/aeson/issues\n";

	#[test]
	fn a_package_page_reads_versions_then_the_cabal_file() {
		let mut requests = Vec::new();
		let done = run("https://hackage.haskell.org/package/aeson", |request| {
			requests.push(request.url.clone());
			if std::path::Path::new(&request.url)
				.extension()
				.is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
			{
				Fetched::json(&json!({ "0.6.0.0": "normal", "2.2.3.0": "normal", "0.7.0.0": "normal" }))
			} else {
				Fetched::text("text/plain", CABAL)
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://hackage.haskell.org/package/aeson.json",
			"https://hackage.haskell.org/package/aeson-2.2.3.0/aeson.cabal"
		]);
		assert_eq!((done.method, done.title.as_deref()), ("hackage", Some("aeson")));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# aeson\n\nFast JSON parsing\n\n**Version:** 2.2.3.0 · **License:** BSD3\n"
		));
		assert!(md.contains(
			"**Author:** Bryan O'Sullivan <bos@example.com>\n**Maintainer:** adam@example.com\n"
		));
		assert!(md.contains("**Category:** Text, Web\n**Stability:** experimental\n"));
		assert!(md.contains("**Homepage:** https://github.com/haskell/aeson\n**Bug Reports:** https://github.com/haskell/aeson/issues\n"));
		assert!(md.contains(
			"\n## Description\n\nA JSON parsing and encoding library.\nDesigned for performance.\n"
		));
		assert_eq!(done.notes, ["Fetched via Hackage API"]);
	}

	#[test]
	fn a_bare_field_value_comes_from_the_next_line_and_versions_are_ordered() {
		let mut requests = Vec::new();
		let done = run("https://hackage.haskell.org/package/aeson", |request| {
			requests.push(request.url.clone());
			if std::path::Path::new(&request.url)
				.extension()
				.is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
			{
				Fetched::json(
					&json!({ "1.0.0": "normal", "1.0.0-beta": "normal", "v1.0.0.1": "normal" }),
				)
			} else {
				Fetched::text("text/plain", "name:\n  aeson\nversion: 1.0.0\n")
			}
		})
		.unwrap();
		assert_eq!(requests[1], "https://hackage.haskell.org/package/aeson-v1.0.0.1/aeson.cabal");
		assert!(done.markdown.starts_with("# aeson\n\n**Version:** 1.0.0\n"));
		assert_eq!(compare_versions("1.0.0-beta", "1.0.0"), Ordering::Less);
		assert_eq!(compare_versions("1.0.0", "1.0.0.0"), Ordering::Equal);
		assert_eq!(compare_versions("v1.0.0.1", "1.0.0"), Ordering::Greater);
		assert_eq!(compare_versions("1.2", "1.10"), Ordering::Less);
	}

	#[test]
	fn other_pages_and_failed_requests_fall_through() {
		assert_eq!(run("https://hackage.haskell.org/", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://example.test/package/aeson", |_| panic!("no fetch expected")), None);
		let no_versions =
			run("https://hackage.haskell.org/package/aeson", |_| Fetched::json(&json!({})));
		assert_eq!(no_versions, None);
		assert_eq!(run("https://hackage.haskell.org/package/aeson", |_| Fetched::status(404)), None);
		let no_cabal = run("https://hackage.haskell.org/package/aeson", |request| {
			if std::path::Path::new(&request.url)
				.extension()
				.is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
			{
				Fetched::json(&json!({ "1.0.0": "normal" }))
			} else {
				Fetched::status(404)
			}
		});
		assert_eq!(no_cabal, None);
	}
}
