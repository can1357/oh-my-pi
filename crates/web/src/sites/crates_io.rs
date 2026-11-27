//! crates.io (`crates.io/crates/<name>`): crate metadata and recent versions
//! from the crates.io API, then the README from docs.rs when it has one.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, fetch, format_number, iso_date, segment, str_of,
	strs_of, u64_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "crates.io", open };

const METHOD: &str = "crates.io";
/// Versions listed.
const RECENT_VERSIONS: usize = 5;
/// A README this short is an error stub.
const MIN_README_CHARS: usize = 100;

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "crates.io" | "www.crates.io") {
		return None;
	}
	let mut segments = url.path_segments()?;
	if segments.next()? != "crates" {
		return None;
	}
	let name = segments
		.next()
		.filter(|name| {
			!name.is_empty()
				&& name
					.bytes()
					.all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
		})?
		.to_owned();
	fetch(
		Fetch::get(format!("https://crates.io/api/v1/crates/{name}")).accept_json(),
		move |reply, _| {
			let data = reply.json_value()?;
			let krate = data.get("crate")?;
			let max_version = str_of(krate, "max_version")?.to_owned();
			let mut md = summary(&name, krate, arr_of(&data, "versions"));
			let readme =
				format!("https://docs.rs/crate/{name}/{}/source/README.md", segment(&max_version));
			fetch(Fetch::get(readme), move |reply, _| {
				if let Some(text) = reply.body_text()
					&& text.chars().nth(MIN_README_CHARS).is_some()
					&& reply.content_type() != "text/html"
				{
					let _ = write!(md, "\n---\n\n## README\n\n{text}\n");
				}
				Done::new(md, METHOD)
					.title(name)
					.note("Fetched via crates.io API")
					.finish()
			})
		},
	)
}

fn summary(name: &str, krate: &Value, versions: &[Value]) -> String {
	let mut md = format!("# {}\n\n", str_of(krate, "name").unwrap_or(name));
	if let Some(description) = str_of(krate, "description") {
		let _ = write!(md, "{description}\n\n");
	}

	let latest = versions.first();
	let _ = write!(md, "**Latest:** {}", str_of(krate, "max_version").unwrap_or_default());
	if let Some(license) = latest.and_then(|v| str_of(v, "license")) {
		let _ = write!(md, " · **License:** {license}");
	}
	if let Some(msrv) = latest.and_then(|v| str_of(v, "rust_version")) {
		let _ = write!(md, " · **MSRV:** {msrv}");
	}
	let downloads = |key| format_number(u64_of(krate, key).unwrap_or(0) as f64);
	let _ = write!(
		md,
		"\n**Downloads:** {} total · {} recent\n\n",
		downloads("downloads"),
		downloads("recent_downloads")
	);

	let repository = str_of(krate, "repository");
	if let Some(repository) = repository {
		let _ = writeln!(md, "**Repository:** {repository}");
	}
	if let Some(homepage) = str_of(krate, "homepage").filter(|home| Some(*home) != repository) {
		let _ = writeln!(md, "**Homepage:** {homepage}");
	}
	if let Some(docs) = str_of(krate, "documentation") {
		let _ = writeln!(md, "**Docs:** {docs}");
	}
	let keywords = strs_of(krate, "keywords");
	if !keywords.is_empty() {
		let _ = writeln!(md, "**Keywords:** {}", keywords.join(", "));
	}
	let categories = strs_of(krate, "categories");
	if !categories.is_empty() {
		let _ = writeln!(md, "**Categories:** {}", categories.join(", "));
	}

	if !versions.is_empty() {
		md.push_str("\n## Recent Versions\n\n");
		for version in versions.iter().take(RECENT_VERSIONS) {
			let _ = writeln!(
				md,
				"- **{}** ({}) - {} downloads",
				str_of(version, "num").unwrap_or("?"),
				str_of(version, "created_at")
					.and_then(iso_date)
					.unwrap_or("unknown date"),
				format_number(u64_of(version, "downloads").unwrap_or(0) as f64)
			);
		}
	}
	md
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	fn api() -> serde_json::Value {
		json!({
			"crate": {
				"name": "serde", "description": "A serialization framework", "downloads": 456_789_012,
				"recent_downloads": 12_345, "max_version": "1.0.200",
				"repository": "https://github.com/serde-rs/serde", "homepage": "https://serde.rs",
				"documentation": "https://docs.rs/serde", "keywords": ["serde", "serialization"], "categories": []
			},
			"versions": [
				{ "num": "1.0.200", "downloads": 1_500, "created_at": "2024-04-30T12:00:00Z", "license": "MIT OR Apache-2.0", "rust_version": "1.31" },
				{ "num": "1.0.199", "downloads": 999, "created_at": "2024-04-20T12:00:00Z", "license": null }
			]
		})
	}

	#[test]
	fn a_crate_page_reads_the_api_and_the_readme() {
		let readme = format!(
			"# serde\n\n{}",
			"Serde is a framework for serializing data structures. ".repeat(4)
		);
		let mut requests = Vec::new();
		let done = run("https://crates.io/crates/serde/1.0.199", |request| {
			requests.push(request.url.clone());
			if request.url.starts_with("https://crates.io/api/") {
				Fetched::json(&api())
			} else {
				Fetched::text("text/plain", readme.clone())
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://crates.io/api/v1/crates/serde",
			"https://docs.rs/crate/serde/1.0.200/source/README.md"
		]);
		assert_eq!((done.method, done.title.as_deref()), ("crates.io", Some("serde")));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# serde\n\nA serialization framework\n\n**Latest:** 1.0.200 · **License:** MIT OR \
			 Apache-2.0 · **MSRV:** 1.31\n**Downloads:** 457M total · 12K recent\n\n"
		));
		assert!(md.contains(
			"**Homepage:** https://serde.rs\n**Docs:** https://docs.rs/serde\n**Keywords:** serde, \
			 serialization\n\n## Recent Versions"
		));
		assert!(!md.contains("**Categories:**"));
		assert!(md.contains(
			"- **1.0.200** (2024-04-30) - 1.5K downloads\n- **1.0.199** (2024-04-20) - 999 \
			 downloads\n"
		));
		assert!(md.contains("\n---\n\n## README\n\n# serde\n\nSerde is a framework"));
	}

	#[test]
	fn an_html_or_missing_readme_is_left_out() {
		for readme in [Fetched::text("text/html", "<html>".repeat(40)), Fetched::status(404)] {
			let done = run("https://crates.io/crates/serde", |request| {
				if request.url.contains("/api/") {
					Fetched::json(&api())
				} else {
					readme.clone()
				}
			})
			.unwrap();
			assert!(!done.markdown.contains("## README"));
		}
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://crates.io/search?q=serde", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://crates.io/crates/serde", |_| Fetched::status(404)), None);
	}
}
