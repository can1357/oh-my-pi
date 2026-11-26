//! W3C specifications (`www.w3.org/TR/…`): specification metadata and the
//! latest version from the W3C API, plus the editor list when the API links
//! one.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, fetch, html_to_markdown, segment, str_of};

/// Registry entry.
pub const SITE: Site = Site { name: "w3c", open };

const API: &str = "https://api.w3.org/specifications";
const METHOD: &str = "w3c-api";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "www.w3.org" | "w3.org") {
		return None;
	}
	let shortname = shortname(url.path())?;
	let spec_url = format!("{API}/{}", segment(&shortname));
	let latest_url = format!("{spec_url}/versions/latest");
	fetch(Fetch::get(spec_url).accept_json(), move |reply, _| {
		let spec = reply.json_value()?;
		fetch(Fetch::get(latest_url).accept_json(), move |reply, _| {
			let latest = reply.json_value()?;
			let title = str_of(&spec, "title").map(str::to_owned);
			let name = str_of(&spec, "shortname").unwrap_or(&shortname).to_owned();
			let description = str_of(&spec, "description").or_else(|| str_of(&spec, "abstract"));
			let abstract_md = description
				.map(|description| html_to_markdown(description, None).trim().to_owned())
				.filter(|abstract_md| !abstract_md.is_empty());
			let latest_version = str_of(&latest, "uri")
				.or_else(|| str_of(&latest, "shortlink"))
				.or_else(|| str_of(&spec, "shortlink"))
				.map(str::to_owned);
			let status = str_of(&latest, "status").map(str::to_owned);
			let history = link(&spec, "version-history").map(str::to_owned);
			let editors_url = link(&latest, "editors").map(str::to_owned);

			let finish = move |editors: Vec<String>| {
				let md = render(
					&name,
					title.as_deref(),
					abstract_md.as_deref(),
					status.as_deref(),
					&editors,
					latest_version.as_deref(),
					history.as_deref(),
				);
				let mut done = Done::new(md, METHOD).note("Fetched via W3C API");
				done.url = latest_version;
				Some(Action::Done(done))
			};
			// `finish` moves its captures; both arms are exclusive.
			match editors_url {
				Some(editors_url) => fetch(Fetch::get(editors_url), move |reply, _| {
					finish(editors(reply.json_value().as_ref()))
				}),
				None => finish(Vec::new()),
			}
		})
	})
}

/// The `href` a `_links/<key>` entry points at.
fn link<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
	payload.get("_links")?.get(key)?.get("href")?.as_str()
}

/// Editor names from an editors payload.
fn editors(payload: Option<&Value>) -> Vec<String> {
	let Some(links) = payload.and_then(|payload| payload.get("_links")) else {
		return Vec::new();
	};
	arr_of(links, "editors")
		.iter()
		.filter_map(|entry| str_of(entry, "title"))
		.map(str::to_owned)
		.collect()
}

/// The specification shortname of a `/TR/…` path.
fn shortname(path: &str) -> Option<String> {
	let segments = path
		.trim_end_matches('/')
		.split('/')
		.filter(|segment| !segment.is_empty())
		.collect::<Vec<_>>();
	if segments.len() < 2 || segments[0] != "TR" {
		return None;
	}
	if segments.len() == 2 {
		return (!is_year(segments[1])).then(|| decode(segments[1]));
	}
	if !is_year(segments[1]) {
		return None;
	}
	// `WORD-<shortname>-YYYYMMDD`, e.g. `PR-webdriver2-20240928`.
	let version = segments[2];
	let word = version
		.chars()
		.take_while(char::is_ascii_alphabetic)
		.count();
	if word == 0 || version.as_bytes().get(word) != Some(&b'-') {
		return None;
	}
	let rest = &version[word + 1..];
	let (middle, tail) = rest.split_at(rest.len().checked_sub(9)?);
	if middle.is_empty()
		|| !tail.starts_with('-')
		|| !tail[1..].bytes().all(|byte| byte.is_ascii_digit())
	{
		return None;
	}
	Some(decode(middle))
}

fn is_year(segment: &str) -> bool {
	segment.len() == 4 && segment.bytes().all(|byte| byte.is_ascii_digit())
}

/// `WD`/`CR`/`PR`/`REC` with the API's own wording as the label.
fn status_code(status: &str) -> Option<&'static str> {
	let lower = status.to_lowercase();
	if lower.contains("working draft") {
		return Some("WD");
	}
	if lower.contains("candidate recommendation") {
		return Some("CR");
	}
	if lower.contains("proposed recommendation") {
		return Some("PR");
	}
	if lower.contains("recommendation") {
		return Some("REC");
	}
	None
}

/// The Markdown body.
fn render(
	name: &str,
	title: Option<&str>,
	abstract_md: Option<&str>,
	status: Option<&str>,
	editors: &[String],
	latest_version: Option<&str>,
	history: Option<&str>,
) -> String {
	let mut md = format!("# {}\n\n", title.unwrap_or(name));
	if let Some(abstract_md) = abstract_md {
		let _ = writeln!(md, "## Abstract\n\n{abstract_md}\n");
	}
	md.push_str("## Metadata\n\n");
	let _ = writeln!(md, "**Shortname:** {name}");
	if let Some(status) = status {
		match status_code(status) {
			Some(code) => {
				let _ = writeln!(md, "**Status:** {code} ({status})");
			},
			None => {
				let _ = writeln!(md, "**Status:** {status}");
			},
		}
	}
	if !editors.is_empty() {
		let _ = writeln!(md, "**Editors:** {}", editors.join(", "));
	}
	if let Some(latest_version) = latest_version {
		let _ = writeln!(md, "**Latest Version:** {latest_version}");
	}
	if let Some(history) = history {
		let _ = writeln!(md, "**History:** {history}");
	}
	md
}

/// Percent-decode a URL component (UTF-8, `%XX`).
fn decode(text: &str) -> String {
	let bytes = text.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'%'
			&& i + 2 < bytes.len()
			&& let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2]))
		{
			out.push(high << 4 | low);
			i += 3;
			continue;
		}
		out.push(bytes[i]);
		i += 1;
	}
	String::from_utf8_lossy(&out).into_owned()
}

fn hex(byte: u8) -> Option<u8> {
	(byte as char)
		.to_digit(16)
		.and_then(|digit| u8::try_from(digit).ok())
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn a_versioned_tr_url_reads_spec_latest_and_editors() {
		let mut requests = Vec::new();
		let done = run("https://www.w3.org/TR/2024/PR-webdriver2-20240928/", |request| {
			requests.push(request.url.clone());
			match request.url.as_str() {
				"https://api.w3.org/specifications/webdriver2" => Fetched::json(&json!({
					"title": "WebDriver", "shortname": "webdriver2",
					"description": "<p>WebDriver is a remote control interface.</p>",
					"shortlink": "https://www.w3.org/TR/webdriver2/",
					"_links": { "version-history": { "href": "https://api.w3.org/specifications/webdriver2/versions" } }
				})),
				"https://api.w3.org/specifications/webdriver2/versions/latest" => Fetched::json(&json!({
					"uri": "https://www.w3.org/TR/webdriver2/", "status": "Candidate Recommendation",
					"_links": { "editors": { "href": "https://api.w3.org/specifications/webdriver2/versions/latest/editors" } }
				})),
				_ => Fetched::json(&json!({ "_links": { "editors": [{ "title": "Simon Stewart" }, { "title": "David Burns" }] } })),
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://api.w3.org/specifications/webdriver2",
			"https://api.w3.org/specifications/webdriver2/versions/latest",
			"https://api.w3.org/specifications/webdriver2/versions/latest/editors"
		]);
		assert_eq!(done.method, "w3c-api");
		assert_eq!(done.url.as_deref(), Some("https://www.w3.org/TR/webdriver2/"));
		assert_eq!(done.notes, ["Fetched via W3C API"]);
		assert!(
			done
				.markdown
				.starts_with("# WebDriver\n\n## Abstract\n\nWebDriver is a remote control interface."),
			"{}",
			done.markdown
		);
		assert!(
			done.markdown.ends_with("## Metadata\n\n**Shortname:** webdriver2\n**Status:** CR (Candidate Recommendation)\n**Editors:** Simon Stewart, David Burns\n**Latest Version:** https://www.w3.org/TR/webdriver2/\n**History:** https://api.w3.org/specifications/webdriver2/versions\n"),
			"{}",
			done.markdown
		);
	}

	#[test]
	fn a_bare_shortname_and_an_editorless_spec_are_its_own() {
		let done = run("https://w3.org/TR/dpub-aam/", |request| {
			if request.url.ends_with("/versions/latest") {
				return Fetched::json(&json!({ "status": "Working Draft" }));
			}
			Fetched::json(&json!({ "title": "DPub AAM" }))
		})
		.unwrap();
		assert_eq!(
			done.markdown,
			"# DPub AAM\n\n## Metadata\n\n**Shortname:** dpub-aam\n**Status:** WD (Working Draft)\n"
		);
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://www.w3.org/TR/", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://example.com/TR/dpub-aam", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://www.w3.org/TR/dpub-aam/", |_| Fetched::status(404)), None);
	}
}
