//! Open VSX (`open-vsx.org/extension/<namespace>/<name>`): extension metadata
//! from the Open VSX API plus the README file it points at.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, f64_of, fetch, format_number, segment, str_of, strs_of,
	u64_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "open-vsx", open };

const METHOD: &str = "open-vsx";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "open-vsx.org" | "www.open-vsx.org") {
		return None;
	}
	let segments: Vec<&str> = url
		.path()
		.split('/')
		.filter(|segment| !segment.is_empty())
		.collect();
	if segments.first().copied() != Some("extension") || !matches!(segments.len(), 3 | 4) {
		return None;
	}
	let namespace = percent_decode(segments[1]);
	let extension = percent_decode(segments[2]);
	let version = segments.get(3).map(|version| percent_decode(version));
	let base = format!("https://open-vsx.org/api/{}/{}", segment(&namespace), segment(&extension));
	let api = match &version {
		Some(version) => format!("{base}/{}", segment(version)),
		None => base,
	};
	fetch(Fetch::get(api).accept_json(), move |reply, _| {
		let data = reply.json_value()?;
		let readme = data
			.get("files")
			.and_then(|files| str_of(files, "readme"))
			.map(str::to_owned);
		match readme {
			Some(readme) => fetch(Fetch::get(readme), move |reply, _| {
				let text = reply.body_text();
				finish(&data, &namespace, &extension, version.as_deref(), text.as_deref())
			}),
			None => finish(&data, &namespace, &extension, version.as_deref(), None),
		}
	})
}

fn finish(
	data: &Value,
	namespace: &str,
	extension: &str,
	version: Option<&str>,
	readme: Option<&str>,
) -> Option<Action> {
	let display_name = str_of(data, "displayName")
		.or_else(|| str_of(data, "name"))
		.map_or_else(|| format!("{namespace}/{extension}"), str::to_owned);
	let title = display_name.clone();
	let display_namespace = str_of(data, "namespace").unwrap_or(namespace);
	let display_version = str_of(data, "version").or(version).unwrap_or("unknown");
	let mut md = format!("# {display_name}\n\n");
	if let Some(description) = str_of(data, "description") {
		let _ = write!(md, "{description}\n\n");
	}
	let _ = writeln!(md, "**Namespace:** {display_namespace}");
	let _ = writeln!(md, "**Extension:** {}", str_of(data, "name").unwrap_or(extension));
	let _ = write!(md, "**Version:** {display_version}");
	if let Some(license) = str_of(data, "license") {
		let _ = write!(md, " | **License:** {license}");
	}
	md.push('\n');
	if let Some(downloads) = u64_of(data, "downloadCount") {
		let _ = writeln!(md, "**Downloads:** {}", format_number(downloads as f64));
	}
	if let Some(rating) = f64_of(data, "averageRating") {
		let _ = write!(md, "**Rating:** {rating}");
		if let Some(reviews) = u64_of(data, "reviewCount") {
			let _ = write!(md, " ({reviews} reviews)");
		}
		md.push('\n');
	}
	if let Some(repository) = repository(data) {
		let _ = writeln!(md, "**Repository:** {repository}");
	}
	if let Some(homepage) = str_of(data, "homepage") {
		let _ = writeln!(md, "**Homepage:** {homepage}");
	}
	let categories = strs_of(data, "categories");
	if !categories.is_empty() {
		let _ = writeln!(md, "**Categories:** {}", categories.join(", "));
	}
	if let Some(readme) = readme {
		let _ = writeln!(md, "\n---\n\n## README\n\n{readme}");
	}
	Done::new(md, METHOD)
		.title(title)
		.note("Fetched via Open VSX API")
		.finish()
}

/// A repository URL with a `git+` prefix and `.git` suffix removed.
fn repository(data: &Value) -> Option<String> {
	let url = match data.get("repository")? {
		Value::String(text) => text.as_str(),
		value => str_of(value, "url")?,
	};
	let url = url.strip_prefix("git+").unwrap_or(url);
	Some(url.strip_suffix(".git").unwrap_or(url).to_owned())
}

/// Decode `%XX` escapes; invalid escapes pass through.
fn percent_decode(text: &str) -> String {
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
		} else {
			out.push(bytes[index]);
			index += 1;
		}
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

	#[test]
	fn an_extension_page_reads_the_api_and_its_readme() {
		let extension = json!({
			"name": "java", "namespace": "redhat", "version": "1.2.0", "displayName": "Language Support for Java",
			"description": "Java Linting", "downloadCount": 45_600, "averageRating": 4.5, "reviewCount": 12,
			"repository": { "url": "git+https://github.com/redhat-developer/vscode-java.git" },
			"license": "MIT", "categories": ["Programming Languages"], "homepage": "https://example.test/java",
			"files": { "readme": "https://open-vsx.org/api/redhat/java/1.2.0/file/README.md" }
		});
		let mut requests = Vec::new();
		let done = run("https://open-vsx.org/extension/redhat/java", |request| {
			requests.push(request.url.clone());
			if request
				.url
				.starts_with("https://open-vsx.org/api/redhat/java/1.2.0/file/")
			{
				Fetched::text("text/markdown", "# Java\n\nBody")
			} else {
				Fetched::json(&extension)
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://open-vsx.org/api/redhat/java",
			"https://open-vsx.org/api/redhat/java/1.2.0/file/README.md"
		]);
		assert_eq!(
			(done.method, done.title.as_deref()),
			("open-vsx", Some("Language Support for Java"))
		);
		let md = &done.markdown;
		assert!(md.starts_with(
			"# Language Support for Java\n\nJava Linting\n\n**Namespace:** redhat\n**Extension:** \
			 java\n**Version:** 1.2.0 | **License:** MIT\n**Downloads:** 46K\n**Rating:** 4.5 (12 \
			 reviews)\n"
		));
		assert!(md.contains("**Repository:** https://github.com/redhat-developer/vscode-java\n**Homepage:** https://example.test/java\n**Categories:** Programming Languages\n"));
		assert!(md.ends_with("\n---\n\n## README\n\n# Java\n\nBody\n"));
	}

	#[test]
	fn a_pinned_version_and_missing_readme_are_handled() {
		let done = run("https://open-vsx.org/extension/redhat/java/1.2.0/", |request| {
			assert_eq!(request.url, "https://open-vsx.org/api/redhat/java/1.2.0");
			Fetched::json(&json!({ "name": "java", "namespace": "redhat", "version": "1.2.0" }))
		})
		.unwrap();
		let md = &done.markdown;
		assert!(md.starts_with(
			"# java\n\n**Namespace:** redhat\n**Extension:** java\n**Version:** 1.2.0\n"
		));
		assert!(!md.contains("## README"));
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(
			run("https://open-vsx.org/extension/redhat", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(run("https://open-vsx.org/extension/redhat/java", |_| Fetched::status(404)), None);
	}
}
