//! Lobste.rs: a story with its comment tree, and the front, newest and tag
//! listings, from the site's JSON API.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, fetch, i64_of, iso_date, str_of, strs_of, u64_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "lobsters", open };

const METHOD: &str = "lobsters";
const NOTE: &str = "Fetched via Lobste.rs JSON API";
/// Stories in a listing.
const LISTING_SIZE: usize = 20;
/// Comment nesting rendered.
const MAX_DEPTH: u64 = 5;

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !url.host_str()?.contains("lobste.rs") {
		return None;
	}
	let path = url.path();
	if let Some(rest) = path.strip_prefix("/s/") {
		let short_id = rest.split('/').next().filter(|id| !id.is_empty())?;
		return fetch(Fetch::get(format!("https://lobste.rs/s/{short_id}.json")), move |reply, _| {
			let story = reply.json_value()?;
			story_page(&story)
		});
	}
	let (json_url, title) = if path == "/" {
		("https://lobste.rs/hottest.json".to_owned(), "Lobste.rs Front Page".to_owned())
	} else if path == "/newest" {
		("https://lobste.rs/newest.json".to_owned(), "Lobste.rs Newest".to_owned())
	} else {
		let tag_path = path.strip_prefix("/t/")?;
		let tag = tag_path.split('/').next().filter(|tag| !tag.is_empty())?;
		(format!("https://lobste.rs/t/{tag}.json"), format!("Lobste.rs Tag: {tag}"))
	};
	fetch(Fetch::get(json_url), move |reply, _| {
		let stories = reply.json_value()?;
		let stories = stories.as_array()?;
		let mut md = format!("# {title}\n\n");
		for story in stories.iter().take(LISTING_SIZE) {
			let _ = write!(
				md,
				"- **{}** ({} pts, {} comments)\n  by {}",
				str_of(story, "title").unwrap_or_default(),
				i64_of(story, "score").unwrap_or(0),
				u64_of(story, "comment_count").unwrap_or(0),
				str_of(story, "submitter_user").unwrap_or_default(),
			);
			let tags = strs_of(story, "tags");
			if !tags.is_empty() {
				let _ = write!(md, " · [{}]", tags.join(", "));
			}
			md.push('\n');
			if let Some(link) = str_of(story, "url") {
				let _ = writeln!(md, "  {link}");
			}
			let _ =
				writeln!(md, "  https://lobste.rs/s/{}", str_of(story, "short_id").unwrap_or_default());
			md.push('\n');
		}
		Done::new(md, METHOD).title(title).note(NOTE).finish()
	})
}

fn story_page(story: &Value) -> Option<Action> {
	let title = str_of(story, "title").unwrap_or_default();
	let mut md = format!("# {title}\n\n");
	let _ = write!(
		md,
		"**{}** · {} points · {} comments",
		str_of(story, "submitter_user").unwrap_or_default(),
		i64_of(story, "score").unwrap_or(0),
		u64_of(story, "comment_count").unwrap_or(0),
	);
	let tags = strs_of(story, "tags");
	if !tags.is_empty() {
		let _ = write!(md, " · [{}]", tags.join(", "));
	}
	md.push('\n');
	let _ = writeln!(
		md,
		"*{}*\n",
		str_of(story, "created_at")
			.and_then(iso_date)
			.unwrap_or_default()
	);

	if let Some(description) = str_of(story, "description") {
		let _ = write!(md, "---\n\n{description}\n\n");
	} else if let Some(link) = str_of(story, "url") {
		let _ = writeln!(md, "**Link:** {link}\n");
	}
	let comments = arr_of(story, "comments");
	if !comments.is_empty() {
		md.push_str("---\n\n## Comments\n\n");
		render_comments(comments, &mut md);
	}

	Done::new(md, METHOD).title(title).note(NOTE).finish()
}

/// Comments, one `###` block per comment, nested by `indent_level`.
fn render_comments(comments: &[Value], out: &mut String) {
	for comment in comments {
		let level = u64_of(comment, "indent_level").unwrap_or(0);
		if level >= MAX_DEPTH {
			continue;
		}
		let indent = "  ".repeat(level as usize);
		let _ = write!(
			out,
			"{indent}### {} · {} points\n\n",
			str_of(comment, "commenting_user").unwrap_or_default(),
			i64_of(comment, "score").unwrap_or(0),
		);
		let text = comment
			.get("comment")
			.and_then(Value::as_str)
			.unwrap_or_default();
		for line in text.split('\n') {
			let _ = writeln!(out, "{indent}{line}");
		}
		out.push('\n');
		let children = arr_of(comment, "comments");
		if !children.is_empty() {
			render_comments(children, out);
		}
		let _ = write!(out, "{indent}---\n\n");
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn a_story_renders_with_nested_comments() {
		let mut requests = Vec::new();
		let done = run("https://lobste.rs/s/abc123", |request| {
			requests.push(request.url.clone());
			Fetched::json(&json!({
				"short_id": "abc123", "title": "A Story", "url": "https://example.test/a",
				"submitter_user": "alice", "score": 10, "comment_count": 2,
				"created_at": "2024-01-02T03:04:05.000Z", "tags": ["programming", "rust"],
				"comments": [
					{ "short_id": "c1", "comment": "First\nsecond", "commenting_user": "bob", "score": 3,
					  "created_at": "2024-01-02T04:00:00Z", "indent_level": 0,
					  "comments": [{ "short_id": "c2", "comment": "reply", "commenting_user": "carol", "score": 1,
										  "created_at": "2024-01-02T05:00:00Z", "indent_level": 1 }] },
					{ "short_id": "c9", "comment": "too deep", "commenting_user": "dave", "score": 0,
					  "created_at": "2024-01-02T06:00:00Z", "indent_level": 5 }
				]
			}))
		})
		.unwrap();
		assert_eq!(requests, ["https://lobste.rs/s/abc123.json"]);
		assert_eq!((done.method, done.title.as_deref()), ("lobsters", Some("A Story")));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# A Story\n\n**alice** · 10 points · 2 comments · [programming, rust]\n*2024-01-02*\n\n"
		));
		assert!(md.contains("**Link:** https://example.test/a\n\n---\n\n## Comments\n\n"));
		assert!(md.contains("### bob · 3 points\n\nFirst\nsecond\n\n"));
		assert!(md.contains("  ### carol · 1 points\n\n  reply\n\n  ---\n\n"));
		assert!(md.contains("---\n\n"));
		assert!(!md.contains("too deep"));
	}

	#[test]
	fn listings_use_the_front_newest_and_tag_feeds() {
		let front = run("https://lobste.rs/", |request| {
			assert_eq!(request.url, "https://lobste.rs/hottest.json");
			Fetched::json(&json!([
				{ "short_id": "a1", "title": "First", "url": "https://example.test/1", "submitter_user": "alice",
				  "score": 5, "comment_count": 2, "created_at": "2024-01-02T00:00:00Z", "tags": [] },
				{ "short_id": "a2", "title": "Second", "submitter_user": "bob", "score": 1, "comment_count": 0,
				  "created_at": "2024-01-02T00:00:00Z", "tags": ["rust"] }
			]))
		})
		.unwrap();
		assert_eq!(front.title.as_deref(), Some("Lobste.rs Front Page"));
		assert_eq!(
			front.markdown,
			"# Lobste.rs Front Page\n\n\
			 - **First** (5 pts, 2 comments)\n  by alice\n  https://example.test/1\n  https://lobste.rs/s/a1\n\n\
			 - **Second** (1 pts, 0 comments)\n  by bob · [rust]\n  https://lobste.rs/s/a2\n\n"
		);

		let tag = run("https://lobste.rs/t/programming", |request| {
			assert_eq!(request.url, "https://lobste.rs/t/programming.json");
			Fetched::json(&json!([]))
		})
		.unwrap();
		assert_eq!(tag.title.as_deref(), Some("Lobste.rs Tag: programming"));
		assert_eq!(tag.markdown, "# Lobste.rs Tag: programming\n\n");
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://lobste.rs/invalid", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://example.test/s/abc", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://lobste.rs/", |_| Fetched::status(500)), None);
	}
}
