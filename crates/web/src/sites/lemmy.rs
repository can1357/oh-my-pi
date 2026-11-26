//! Lemmy (`<host>/post/<id>`, `<host>/comment/<id>`): the post and its whole
//! comment tree from the instance's `api/v3` JSON API.
//!
//! The TS handler memoized "does this origin run Lemmy?" in a per-process probe
//! cache; a handler here has no cross-read state, so a host that is not a Lemmy
//! instance is simply declined after the API call fails.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, fetch, i64_of, str_of, u64_of};

/// Registry entry.
pub const SITE: Site = Site { name: "lemmy", open };

const METHOD: &str = "lemmy-api";
const NOTE: &str = "Fetched via Lemmy API";

fn open(url: &Url, _: &Context) -> Option<Action> {
	let path = url.path().strip_prefix('/')?;
	let (kind, rest) = path.split_once('/')?;
	if kind != "post" && kind != "comment" {
		return None;
	}
	let id: u64 = rest
		.chars()
		.take_while(char::is_ascii_digit)
		.collect::<String>()
		.parse()
		.ok()?;
	let origin = url.origin().ascii_serialization();
	if kind == "comment" {
		return fetch(Fetch::get(format!("{origin}/api/v3/comment?id={id}")), move |reply, _| {
			let data = reply.json_value()?;
			let post_id =
				u64_of(data.get("comment_view")?.get("comment")?, "post_id").filter(|id| *id != 0)?;
			post(origin, post_id)
		});
	}
	post(origin, id)
}

fn post(origin: String, post_id: u64) -> Option<Action> {
	fetch(Fetch::get(format!("{origin}/api/v3/post?id={post_id}")), move |reply, _| {
		let post = reply.json_value()?;
		fetch(
			Fetch::get(format!("{origin}/api/v3/comment/list?post_id={post_id}")),
			move |reply, _| {
				if !reply.ok() {
					return None;
				}
				// A non-JSON comment list still yields the post, without comments.
				let comments = reply.json_value().unwrap_or(Value::Null);
				render(&post, &comments)
			},
		)
	})
}

fn render(post_data: &Value, comments_data: &Value) -> Option<Action> {
	let post_view = post_data.get("post_view")?;
	let post = post_view.get("post")?;
	let title = str_of(post, "name")?;
	let community = post_view.get("community")?;
	let creator = post_view.get("creator")?;
	let counts = post_view.get("counts");
	let comments = arr_of(comments_data, "comments");

	let mut md = format!("# {title}\n\n");
	let _ = writeln!(
		md,
		"**Community:** {} · **Author:** {} · **Score:** {} · **Comments:** {}",
		community_label(community),
		author_label(creator),
		counts
			.and_then(|counts| i64_of(counts, "score"))
			.unwrap_or(0),
		counts
			.and_then(|counts| u64_of(counts, "comments"))
			.unwrap_or(comments.len() as u64),
	);
	if let Some(link) = str_of(post, "url") {
		let _ = writeln!(md, "**Link:** {link}");
	}
	md.push('\n');
	if let Some(body) = str_of(post, "body") {
		let _ = write!(md, "---\n\n{body}\n\n");
	}
	if !comments.is_empty() {
		let ids: Vec<u64> = comments
			.iter()
			.filter_map(|view| {
				view
					.get("comment")
					.and_then(|comment| u64_of(comment, "id"))
			})
			.collect();
		let threaded = render_thread(comments, &ids, 0, 0);
		if !threaded.is_empty() {
			let _ = write!(md, "---\n\n## Comments\n\n{threaded}\n");
		}
	}
	Done::new(md, METHOD).title(title).note(NOTE).finish()
}

/// The comment tree under `parent`, two spaces per level.
fn render_thread(comments: &[Value], ids: &[u64], parent: u64, depth: usize) -> String {
	let indent = "  ".repeat(depth);
	let mut out = String::new();
	for view in comments {
		let Some(comment) = view.get("comment") else {
			continue;
		};
		if resolve_parent(comment, ids) != parent {
			continue;
		}
		let author = match view.get("creator") {
			Some(creator) if str_of(creator, "name").is_some() => author_label(creator),
			_ => "unknown".to_owned(),
		};
		let score = view
			.get("counts")
			.and_then(|counts| i64_of(counts, "score"))
			.unwrap_or(0);
		let _ = writeln!(out, "{indent}- **{author}** · {score} points");
		let content = comment
			.get("content")
			.and_then(Value::as_str)
			.unwrap_or_default()
			.trim();
		if !content.is_empty() {
			for line in content.lines() {
				let _ = writeln!(out, "{indent}  {line}");
			}
		}
		let id = u64_of(comment, "id").unwrap_or(u64::MAX);
		out.push_str(&render_thread(comments, ids, id, depth + 1));
		out.push('\n');
	}
	out
}

/// A comment's parent when that parent is in the list, root otherwise.
fn resolve_parent(comment: &Value, ids: &[u64]) -> u64 {
	u64_of(comment, "parent_id")
		.filter(|id| ids.contains(id))
		.unwrap_or(0)
}

/// `!community@host` when the actor id names a host.
fn community_label(community: &Value) -> String {
	let name = str_of(community, "name").unwrap_or("undefined");
	match str_of(community, "actor_id").and_then(actor_host) {
		Some(host) => format!("!{name}@{host}"),
		None => format!("!{name}"),
	}
}

/// `@user@host` when the actor id names a host.
fn author_label(creator: &Value) -> String {
	let name = str_of(creator, "name").unwrap_or("undefined");
	match str_of(creator, "actor_id").and_then(actor_host) {
		Some(host) => format!("@{name}@{host}"),
		None => name.to_owned(),
	}
}

fn actor_host(actor_id: &str) -> Option<String> {
	Url::parse(actor_id).ok()?.host_str().map(str::to_owned)
}

#[cfg(test)]
mod tests {
	use serde_json::{Value, json};

	use super::super::{Fetched, testing::run};

	fn post_data() -> Value {
		json!({ "post_view": {
			"post": { "id": 123, "name": "Hello Lemmy", "body": "Post body", "url": "https://example.test/x" },
			"creator": { "name": "alice", "actor_id": "https://lemmy.ml/u/alice" },
			"community": { "name": "rust", "actor_id": "https://lemmy.ml/c/rust" },
			"counts": { "score": 42, "comments": 2 }
		} })
	}

	fn comments() -> Value {
		json!({ "comments": [
			{
				"comment": { "id": 1, "content": "Top level", "path": "0.1", "parent_id": null, "post_id": 123 },
				"creator": { "name": "alice", "actor_id": "https://lemmy.ml/u/alice" }, "counts": { "score": 5 }
			},
			{
				"comment": { "id": 2, "content": "  A reply  ", "parent_id": 1 },
				"creator": { "name": "bob", "actor_id": "https://other.test/u/bob" }, "counts": { "score": -1 }
			},
			{
				"comment": { "id": 3, "content": "orphan", "parent_id": 99 },
				"creator": null, "counts": {}
			}
		] })
	}

	#[test]
	fn a_post_renders_with_its_threaded_comments() {
		let mut requests = Vec::new();
		let done = run("https://lemmy.ml/post/123", |request| {
			requests.push(request.url.clone());
			if request.url.contains("/comment/list") {
				Fetched::json(&comments())
			} else {
				Fetched::json(&post_data())
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://lemmy.ml/api/v3/post?id=123",
			"https://lemmy.ml/api/v3/comment/list?post_id=123"
		]);
		assert_eq!((done.method, done.title.as_deref()), ("lemmy-api", Some("Hello Lemmy")));
		let md = &done.markdown;
		assert!(md.starts_with("# Hello Lemmy\n\n"));
		assert!(md.contains(
			"**Community:** !rust@lemmy.ml · **Author:** @alice@lemmy.ml · **Score:** 42 · \
			 **Comments:** 2\n"
		));
		assert!(md.contains("**Link:** https://example.test/x\n\n---\n\nPost body\n\n"));
		assert!(md.contains("## Comments\n\n- **@alice@lemmy.ml** · 5 points\n  Top level\n"));
		assert!(md.contains("  - **@bob@other.test** · -1 points\n    A reply\n"));
		assert!(md.contains("- **unknown** · 0 points\n  orphan\n"));
	}

	#[test]
	fn a_comment_url_resolves_the_post_and_a_broken_list_is_tolerated() {
		let mut requests = Vec::new();
		let done = run("https://lemmy.ml/comment/7", |request| {
			requests.push(request.url.clone());
			if request.url.contains("/comment?id=") {
				Fetched::json(&json!({ "comment_view": { "comment": { "id": 7, "post_id": 55 } } }))
			} else if request.url.contains("/comment/list") {
				Fetched::text("text/html", "<html>not the API</html>")
			} else {
				Fetched::json(&post_data())
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://lemmy.ml/api/v3/comment?id=7",
			"https://lemmy.ml/api/v3/post?id=55",
			"https://lemmy.ml/api/v3/comment/list?post_id=55"
		]);
		assert!(done.markdown.contains("# Hello Lemmy"));
		assert!(!done.markdown.contains("## Comments"));
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://lemmy.ml/community/rust", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://lemmy.ml/post/123", |_| Fetched::status(404)), None);
	}
}
