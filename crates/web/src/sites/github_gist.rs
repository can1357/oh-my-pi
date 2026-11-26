//! GitHub Gists (`gist.github.com/<user>/<id>`): gist metadata and every file's
//! contents from one GitHub API request.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, fetch, str_of};

/// Registry entry.
pub const SITE: Site = Site { name: "github-gist", open };

const METHOD: &str = "github-gist";
const ACCEPT: &str = "application/vnd.github.v3+json";

fn open(url: &Url, context: &Context) -> Option<Action> {
	if url.host_str()? != "gist.github.com" {
		return None;
	}
	let gist_id = url.path_segments()?.rfind(|part| !part.is_empty())?;
	if gist_id.is_empty() || !gist_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
		return None;
	}
	let gist_id = gist_id.to_owned();
	let request = Fetch::get(format!("https://api.github.com/gists/{gist_id}"))
		.header("Accept", ACCEPT)
		.bearer(context.credential("github"));
	fetch(request, move |reply, _| {
		let gist = reply.json_value()?;
		let (title, markdown) = summary(&gist)?;
		Done::new(markdown, METHOD)
			.title(title)
			.note("Fetched via GitHub API")
			.finish()
	})
}

/// Title and Markdown of a gist record.
fn summary(gist: &Value) -> Option<(String, String)> {
	let files = gist.get("files")?.as_object()?;
	let owner = gist
		.get("owner")
		.and_then(|owner| str_of(owner, "login"))
		.unwrap_or("anonymous");
	let title = format!("Gist by {owner}");
	let mut md = format!("# {title}\n\n");
	if let Some(description) = gist
		.get("description")
		.and_then(Value::as_str)
		.filter(|text| !text.is_empty())
	{
		let _ = write!(md, "{description}\n\n");
	}
	let _ = writeln!(
		md,
		"**Created:** {} · **Updated:** {}",
		text(gist, "created_at"),
		text(gist, "updated_at")
	);
	let _ = writeln!(md, "**Files:** {}\n", files.len());
	for file in files.values() {
		let language = text(file, "language").to_lowercase();
		let _ = write!(
			md,
			"---\n\n## {}\n\n```{language}\n{}\n```\n\n",
			text(file, "filename"),
			text(file, "content")
		);
	}
	Some((title, md))
}

/// String at `key` (`""` when absent, as the TS handler interpolated fields).
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
	value.get(key).and_then(Value::as_str).unwrap_or("")
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::{
		super::{Fetched, testing::run},
		*,
	};

	fn gist() -> Value {
		json!({
			"description": "A demo gist",
			"owner": { "login": "gaearon" },
			"created_at": "2016-11-03T19:47:57Z",
			"updated_at": "2016-11-03T19:50:00Z",
			"html_url": "https://gist.github.com/gaearon/edf814aeee85062bc9b9830aeaf27b88",
			"files": {
				"a.js": { "filename": "a.js", "language": "JavaScript", "size": 5, "content": "let a" },
				"README.md": { "filename": "README.md", "language": "Markdown", "size": 1, "content": "#" }
			}
		})
	}

	#[test]
	fn a_gist_renders_every_file_from_one_api_request() {
		let mut requests = Vec::new();
		let done =
			run("https://gist.github.com/gaearon/edf814aeee85062bc9b9830aeaf27b88", |request| {
				requests.push(request.url.clone());
				Fetched::json(&gist())
			})
			.unwrap();
		assert_eq!(requests, ["https://api.github.com/gists/edf814aeee85062bc9b9830aeaf27b88"]);
		assert_eq!((done.method, done.title.as_deref()), ("github-gist", Some("Gist by gaearon")));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# Gist by gaearon\n\nA demo gist\n\n**Created:** 2016-11-03T19:47:57Z · **Updated:** \
			 2016-11-03T19:50:00Z\n**Files:** 2\n\n"
		));
		assert!(md.contains("---\n\n## a.js\n\n```javascript\nlet a\n```\n\n"));
		assert!(md.contains("---\n\n## README.md\n\n```markdown\n#\n```\n\n"));
		assert_eq!(done.notes, ["Fetched via GitHub API"]);
	}

	#[test]
	fn a_short_url_without_owner_still_reads_the_gist() {
		let done = run("https://gist.github.com/edf814aeee85062bc9b9830aeaf27b88", |_| {
			Fetched::json(&json!({
				"owner": null,
				"created_at": null,
				"updated_at": null,
				"files": { "x": { "filename": "x", "content": "" } }
			}))
		})
		.unwrap();
		assert_eq!(done.title.as_deref(), Some("Gist by anonymous"));
		assert!(
			done
				.markdown
				.contains("**Created:**  · **Updated:** \n**Files:** 1\n")
		);
		assert!(done.markdown.ends_with("---\n\n## x\n\n```\n\n```\n\n"));
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://gist.github.com/", |_| panic!("no fetch expected")), None);
		assert_eq!(
			run("https://gist.github.com/invalid-gist-id!", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(run("https://github.com/gaearon", |_| panic!("no fetch expected")), None);
		assert_eq!(
			run("https://gist.github.com/edf814aeee85062bc9b9830aeaf27b88", |_| Fetched::status(404)),
			None
		);
	}
}
