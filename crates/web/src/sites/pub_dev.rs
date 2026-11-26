//! pub.dev (`pub.dev/packages/<name>`): package metadata, metrics, SDK
//! constraints and dependencies from the pub.dev API, then the rendered README
//! from the package's version page. Subpages (changelog, versions, example) are
//! left to the generic reader.

use std::fmt::Write as _;

use regex::Regex;
use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Fetched, Site, f64_of, fetch, format_number, html_to_markdown,
	segment, str_of, u64_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "pub.dev", open };

const METHOD: &str = "pub.dev";
/// Dependencies listed before eliding the rest.
const MAX_DEPENDENCIES: usize = 20;
/// A README this short is an error stub.
const MIN_README_CHARS: usize = 100;

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "pub.dev" | "www.pub.dev") {
		return None;
	}
	let rest = url.path().strip_prefix("/packages/")?;
	let path = rest.strip_suffix('/').unwrap_or(rest);
	if path.is_empty() || path.contains('/') {
		return None;
	}
	let name = decode(path);
	if name.is_empty() {
		return None;
	}
	fetch(
		Fetch::get(format!("https://pub.dev/api/packages/{}", segment(&name))).accept_json(),
		move |reply, _| {
			let data = reply.json_value()?;
			let latest = data.get("latest")?;
			let pubspec = latest.get("pubspec")?;
			let version = str_of(latest, "version").unwrap_or_default().to_owned();
			let title = str_of(&data, "name").unwrap_or(name.as_str()).to_owned();
			let mut md = summary(&data, pubspec, &version);
			let readme_url = format!(
				"https://pub.dev/packages/{}/versions/{}/readme",
				segment(&name),
				segment(&version)
			);
			fetch(Fetch::get(readme_url), move |reply, _| {
				if let Some(readme) = readme_markdown(&reply) {
					let _ = write!(md, "## README\n\n{readme}\n");
				}
				Done::new(md, METHOD)
					.title(title)
					.note("Fetched via pub.dev API")
					.finish()
			})
		},
	)
}

fn summary(data: &Value, pubspec: &Value, version: &str) -> String {
	let mut md = format!("# {}\n\n", str_of(data, "name").unwrap_or_default());
	if let Some(description) = str_of(pubspec, "description") {
		let _ = write!(md, "{description}\n\n");
	}

	let _ = write!(md, "**Latest:** {version}");
	if let Some(publisher) = str_of(data, "publisherId") {
		let _ = write!(md, " · **Publisher:** {publisher}");
	}
	md.push('\n');

	if let Some(score) = data
		.get("metrics")
		.and_then(|metrics| metrics.get("score"))
		.filter(|score| !score.is_null())
	{
		if let Some(likes) = u64_of(score, "likeCount") {
			let _ = write!(md, "**Likes:** {}", format_number(likes as f64));
		}
		if let (Some(points), Some(maximum)) =
			(u64_of(score, "grantedPoints"), u64_of(score, "maxPoints"))
		{
			let _ = write!(md, " · **Pub Points:** {points}/{maximum}");
		}
		if let Some(popularity) = f64_of(score, "popularityScore") {
			let _ = write!(md, " · **Popularity:** {}%", (popularity * 100.0).round() as i64);
		}
		md.push('\n');
	}
	md.push('\n');

	if let Some(homepage) = str_of(pubspec, "homepage") {
		let _ = writeln!(md, "**Homepage:** {homepage}");
	}
	if let Some(repository) = str_of(pubspec, "repository") {
		let _ = writeln!(md, "**Repository:** {repository}");
	}
	if let Some(documentation) = str_of(pubspec, "documentation") {
		let _ = writeln!(md, "**Documentation:** {documentation}");
	}
	if let Some(environment) = pubspec.get("environment").and_then(Value::as_object)
		&& !environment.is_empty()
	{
		let constraints: Vec<String> = environment
			.iter()
			.map(|(key, value)| format!("{key}: {}", scalar(value)))
			.collect();
		let _ = writeln!(md, "**SDK:** {}", constraints.join(", "));
	}
	md.push('\n');

	if let Some(dependencies) = pubspec
		.get("dependencies")
		.and_then(Value::as_object)
		.filter(|map| !map.is_empty())
	{
		let _ = writeln!(md, "## Dependencies ({})", dependencies.len());
		md.push('\n');
		for (dependency, constraint) in dependencies.iter().take(MAX_DEPENDENCIES) {
			let text = match constraint {
				Value::String(text) => text.as_str(),
				Value::Null | Value::Object(_) | Value::Array(_) => "complex",
				_ => "",
			};
			let _ = write!(md, "- {dependency}");
			if !text.is_empty() {
				let _ = write!(md, ": {text}");
			}
			md.push('\n');
		}
		if dependencies.len() > MAX_DEPENDENCIES {
			let _ =
				write!(md, "\n[…{} dependencies elided…]\n", dependencies.len() - MAX_DEPENDENCIES);
		}
		md.push('\n');
	}
	md
}

/// Markdown of the `markdown-body` div in a pub.dev README page, when it is
/// long enough to be real content.
fn readme_markdown(reply: &Fetched) -> Option<String> {
	let html = reply.body_text()?;
	let expression =
		Regex::new(r#"(?is)<div[^>]*class="[^"]*markdown-body[^"]*"[^>]*>(.*?)</div>"#).ok()?;
	let body = expression.captures(&html)?.get(1)?.as_str();
	let readme = html_to_markdown(body, None);
	let readme = readme.trim();
	(readme.chars().nth(MIN_README_CHARS).is_some()).then(|| readme.to_owned())
}

/// The string value of an environment constraint, or its JSON text for
/// non-strings.
fn scalar(value: &Value) -> String {
	value
		.as_str()
		.map_or_else(|| value.to_string(), str::to_owned)
}

/// Percent-decode a URL path segment.
fn decode(text: &str) -> String {
	let bytes = text.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] == b'%'
			&& index + 2 < bytes.len()
			&& let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2]))
		{
			out.push(high << 4 | low);
			index += 3;
			continue;
		}
		out.push(bytes[index]);
		index += 1;
	}
	String::from_utf8_lossy(&out).into_owned()
}

const fn hex(byte: u8) -> Option<u8> {
	match byte {
		b'0'..=b'9' => Some(byte - b'0'),
		b'a'..=b'f' => Some(byte - b'a' + 10),
		b'A'..=b'F' => Some(byte - b'A' + 10),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	fn api() -> serde_json::Value {
		json!({
			"name": "http",
			"latest": {
				"version": "1.2.0",
				"pubspec": {
					"description": "A composable HTTP client.",
					"homepage": "https://github.com/dart-lang/http",
					"repository": "https://github.com/dart-lang/http",
					"environment": { "sdk": ">=3.0.0 <4.0.0" },
					"dependencies": { "async": "^2.11.0", "meta": "^1.9.0" },
					"dev_dependencies": { "test": "^1.24.0" }
				}
			},
			"publisherId": "dart.dev",
			"metrics": { "score": { "likeCount": 3_400, "grantedPoints": 120, "maxPoints": 130, "popularityScore": 0.987 } }
		})
	}

	#[test]
	fn a_package_page_reads_the_api_and_the_readme() {
		let readme = format!(
			"<div class=\"markdown-body\"><h1>http</h1><p>{}</p></div>",
			"Real README prose. ".repeat(8)
		);
		let mut requests = Vec::new();
		let done = run("https://pub.dev/packages/http", |request| {
			requests.push(request.url.clone());
			if request.url.starts_with("https://pub.dev/api/") {
				Fetched::json(&api())
			} else {
				Fetched::text("text/html", readme.clone())
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://pub.dev/api/packages/http",
			"https://pub.dev/packages/http/versions/1.2.0/readme"
		]);
		assert_eq!(done.method, "pub.dev");
		assert_eq!(done.title.as_deref(), Some("http"));
		assert_eq!(done.notes, ["Fetched via pub.dev API"]);
		let md = &done.markdown;
		assert!(md.starts_with(
			"# http\n\nA composable HTTP client.\n\n**Latest:** 1.2.0 · **Publisher:** dart.dev\n\
			 **Likes:** 3.4K · **Pub Points:** 120/130 · **Popularity:** 99%\n\n\
			 **Homepage:** https://github.com/dart-lang/http\n**Repository:** https://github.com/dart-lang/http\n\
			 **SDK:** sdk: >=3.0.0 <4.0.0\n\n## Dependencies (2)\n\n- async: ^2.11.0\n- meta: ^1.9.0\n\n"
		));
		assert!(md.contains("## README\n\n"));
		assert!(md.contains("# http"));
		assert!(md.contains("Real README prose."));
	}

	#[test]
	fn an_absent_score_is_skipped_and_subpages_decline() {
		let done = run("https://www.pub.dev/packages/http/", |_| {
			Fetched::json(&json!({ "name": "http", "latest": { "version": "1.2.0", "pubspec": { "dependencies": { "async": "^2.11.0" } } } }))
		})
		.unwrap();
		assert!(done.markdown.starts_with(
			"# http\n\n**Latest:** 1.2.0\n\n\n## Dependencies (1)\n\n- async: ^2.11.0\n\n"
		));
		assert!(!done.markdown.contains("**Likes:**"));

		assert_eq!(
			run("https://pub.dev/packages/http/changelog", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(run("https://example.com/packages/http", |_| panic!("no fetch expected")), None);
	}

	#[test]
	fn api_failures_fall_through() {
		assert_eq!(run("https://pub.dev/packages/http", |_| Fetched::status(500)), None);
	}

	#[test]
	fn a_short_or_missing_readme_is_left_out() {
		let done = run("https://pub.dev/packages/http", |request| {
			if request.url.starts_with("https://pub.dev/api/") {
				Fetched::json(&api())
			} else {
				Fetched::text("text/html", "<div class=\"markdown-body\"><p>Hi.</p></div>")
			}
		})
		.unwrap();
		assert!(!done.markdown.contains("## README"));
	}
}
