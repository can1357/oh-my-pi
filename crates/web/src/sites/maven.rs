//! Maven Central (`search.maven.org/artifact/...`,
//! `mvnrepository.com/artifact/...`): artifact metadata from the Solr API plus
//! dependency snippets.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, f64_of, fetch, format_number, iso_date, segment,
	str_of, strs_of, u64_of, unix_date,
};

/// Registry entry.
pub const SITE: Site = Site { name: "maven", open };

const METHOD: &str = "maven";
const NOTE: &str = "Fetched via Maven Central API";

fn open(url: &Url, _: &Context) -> Option<Action> {
	let host = url.host_str()?;
	if !matches!(host, "search.maven.org" | "mvnrepository.com" | "www.mvnrepository.com") {
		return None;
	}
	let rest = url.path().strip_prefix("/artifact/")?;
	let mut segments = rest.split('/');
	let group = segments.next().filter(|part| !part.is_empty())?.to_owned();
	let artifact = segments.next().filter(|part| !part.is_empty())?.to_owned();
	let version = segments
		.next()
		.filter(|part| !part.is_empty())
		.map(str::to_owned);
	let query = format!(
		"https://search.maven.org/solrsearch/select?q=g:{}+AND+a:{}&wt=json&rows=1",
		segment(&group),
		segment(&artifact)
	);
	fetch(Fetch::get(query).accept_json(), move |reply, _| {
		let data = reply.json_value()?;
		let response = data.get("response")?;
		if u64_of(response, "numFound").unwrap_or(0) == 0 {
			return None;
		}
		let doc = arr_of(response, "docs").first()?;
		document(doc, &group, &artifact, version.as_deref())
	})
}

fn document(doc: &Value, group: &str, artifact: &str, version: Option<&str>) -> Option<Action> {
	let g = str_of(doc, "g").unwrap_or(group);
	let a = str_of(doc, "a").unwrap_or(artifact);
	let latest = str_of(doc, "latestVersion").unwrap_or_default();
	let display = version.unwrap_or(latest);

	let mut md = format!("# {g}:{a}\n\n");
	let _ = writeln!(md, "**Group ID:** {g}");
	let _ = writeln!(md, "**Artifact ID:** {a}");
	let _ = write!(md, "**Latest Version:** {latest}");
	if let Some(version) = version.filter(|version| *version != latest) {
		let _ = write!(md, " (viewing {version})");
	}
	md.push('\n');
	if let Some(packaging) = str_of(doc, "p") {
		let _ = writeln!(md, "**Packaging:** {packaging}");
	}
	if let Some(versions) = f64_of(doc, "versionCount").filter(|count| *count != 0.0) {
		let _ = writeln!(md, "**Versions:** {}", format_number(versions));
	}
	if let Some(updated) = iso_from_millis(doc.get("timestamp")) {
		let _ = writeln!(md, "**Last Updated:** {updated}");
	}

	let _ = write!(
		md,
		"\n## Maven Dependency\n\n```xml\n<dependency>\n    <groupId>{g}</groupId>\n    \
		 <artifactId>{a}</artifactId>\n    <version>{display}</version>\n</dependency>\n```\n"
	);
	let _ =
		write!(md, "\n## Gradle Dependency\n\n```groovy\nimplementation '{g}:{a}:{display}'\n```\n");
	let _ = write!(
		md,
		"\n## Gradle (Kotlin DSL)\n\n```kotlin\nimplementation(\"{g}:{a}:{display}\")\n```\n"
	);

	let extensions: Vec<&str> = strs_of(doc, "ec")
		.into_iter()
		.filter(|extension| *extension != "-")
		.collect();
	if !extensions.is_empty() {
		md.push_str("\n## Available Extensions\n\n");
		for extension in extensions {
			let _ = writeln!(md, "- {extension}");
		}
	}

	let _ = write!(
		md,
		"\n## Links\n\n- [Maven Central](https://search.maven.org/artifact/{g}/{a}/{display}/jar)\n- [MVN Repository](https://mvnrepository.com/artifact/{g}/{a}/{display})\n"
	);
	Done::new(md, METHOD)
		.title(format!("{g}:{a}"))
		.note(NOTE)
		.finish()
}

/// `YYYY-MM-DD` of a millisecond timestamp, `None` when absent or zero.
fn iso_from_millis(value: Option<&Value>) -> Option<String> {
	match value? {
		Value::Number(number) => number
			.as_i64()
			.filter(|millis| *millis != 0)
			.map(|millis| unix_date(millis / 1000)),
		Value::String(text) => {
			let text = text.trim();
			iso_date(text).map(str::to_owned).or_else(|| {
				text
					.parse::<i64>()
					.ok()
					.filter(|millis| *millis != 0)
					.map(|millis| unix_date(millis / 1000))
			})
		},
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use serde_json::{Value, json};

	use super::super::{Fetched, testing::run};

	fn search() -> Value {
		json!({ "response": { "numFound": 1, "docs": [{
			"id": "org.apache.commons:commons-lang3:3.12.0", "g": "org.apache.commons", "a": "commons-lang3",
			"latestVersion": "3.12.0", "p": "jar", "timestamp": 1_704_067_200_000_i64, "versionCount": 22,
			"ec": ["-sources.jar", "-javadoc.jar", "-"]
		}] } })
	}

	#[test]
	fn an_artifact_renders_with_dependency_snippets() {
		let mut requests = Vec::new();
		let done =
			run("https://search.maven.org/artifact/org.apache.commons/commons-lang3", |request| {
				requests.push(request.url.clone());
				Fetched::json(&search())
			})
			.unwrap();
		assert_eq!(requests, [
			"https://search.maven.org/solrsearch/select?q=g:org.apache.commons+AND+a:commons-lang3&wt=json&rows=1"
		]);
		assert_eq!(
			(done.method, done.title.as_deref()),
			("maven", Some("org.apache.commons:commons-lang3"))
		);
		let md = &done.markdown;
		assert!(md.starts_with(
			"# org.apache.commons:commons-lang3\n\n**Group ID:** org.apache.commons\n**Artifact \
			 ID:** commons-lang3\n**Latest Version:** 3.12.0\n**Packaging:** jar\n**Versions:** \
			 22\n**Last Updated:** 2024-01-01\n"
		));
		assert!(md.contains(
			"## Maven Dependency\n\n```xml\n<dependency>\n    \
			 <groupId>org.apache.commons</groupId>\n    <artifactId>commons-lang3</artifactId>\n    \
			 <version>3.12.0</version>\n</dependency>\n```\n"
		));
		assert!(md.contains(
			"## Gradle Dependency\n\n```groovy\nimplementation \
			 'org.apache.commons:commons-lang3:3.12.0'\n```\n"
		));
		assert!(md.contains(
			"## Gradle (Kotlin \
			 DSL)\n\n```kotlin\nimplementation(\"org.apache.commons:commons-lang3:3.12.0\")\n```\n"
		));
		assert!(md.contains("## Available Extensions\n\n- -sources.jar\n- -javadoc.jar\n"));
		assert!(md.ends_with("## Links\n\n- [Maven Central](https://search.maven.org/artifact/org.apache.commons/commons-lang3/3.12.0/jar)\n- [MVN Repository](https://mvnrepository.com/artifact/org.apache.commons/commons-lang3/3.12.0)\n"));
		assert_eq!(done.notes, ["Fetched via Maven Central API"]);
	}

	#[test]
	fn a_viewed_version_is_flagged_but_the_latest_version_is_displayed() {
		let done =
			run("https://mvnrepository.com/artifact/org.apache.commons/commons-lang3/3.11.0", |_| {
				Fetched::json(&search())
			})
			.unwrap();
		assert!(
			done
				.markdown
				.contains("**Latest Version:** 3.12.0 (viewing 3.11.0)\n")
		);
		assert!(done.markdown.contains("<version>3.11.0</version>"));
	}

	#[test]
	fn other_pages_and_failed_lookups_fall_through() {
		assert_eq!(run("https://search.maven.org/", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://example.test/artifact/a/b", |_| panic!("no fetch expected")), None);
		assert_eq!(
			run("https://search.maven.org/artifact/org.apache.commons/commons-lang3", |_| {
				Fetched::json(&json!({ "response": { "numFound": 0, "docs": [] } }))
			}),
			None
		);
	}
}
