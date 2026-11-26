//! Discourse topics and individual posts. The topic API identifies the forum
//! and supplies the thread, including raw Markdown on servers that expose it.

use std::{
	borrow::Cow,
	fmt::{self, Write as _},
	sync::LazyLock,
};

use regex::Regex;
use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Fetched, NEGATIVE_PROBE_TTL_SECS, Site, arr_of, fetch,
	html_to_markdown, is_conclusive_probe_status, iso_date, str_of, u64_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "discourse", open };

const MAX_POSTS: usize = 20;
static TOPIC: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^(.*?)/t/(?:[^/]+/)?([0-9]+)(?:\.json)?(?:/|$)").unwrap());
static POST: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^(.*?)/posts/([0-9]+)(?:\.json)?(?:/|$)").unwrap());

fn open(url: &Url, context: &Context) -> Option<Action> {
	if !matches!(url.scheme(), "http" | "https") {
		return None;
	}
	let (captures, is_post) = match TOPIC.captures(url.path()) {
		Some(topic) => (topic, false),
		None => (POST.captures(url.path())?, true),
	};
	let (_, [mount, id]) = captures.extract();
	let mut base = url.origin().ascii_serialization();
	base.push_str(mount.strip_suffix('/').unwrap_or(mount));
	let key = format!("discourse:{base}");
	if context.cache_get(&key).as_deref() == Some("no") {
		return None;
	}
	if is_post {
		fetch(Fetch::get(format!("{base}/posts/{id}.json?include_raw=1")), move |reply, context| {
			let post = api_json(&reply, context, &key)?;
			let id = u64_of(&post, "topic_id").filter(|&id| id != 0)?;
			topic(&base, id, key, Some(post))
		})
	} else {
		topic(&base, id, key, None)
	}
}

fn topic(
	base: &str,
	id: impl fmt::Display,
	key: String,
	requested: Option<Value>,
) -> Option<Action> {
	fetch(Fetch::get(format!("{base}/t/{id}.json?include_raw=1")), move |reply, context| {
		let data = api_json(&reply, context, &key)?;
		let title = str_of(&data, "title").or_else(|| str_of(&data, "fancy_title"))?;
		// Only negatives gate requests. A successful concurrent read can clear
		// one.
		context.cache_put(&key, "yes".to_owned(), u64::MAX);
		Done::new(markdown(&data, title, requested.as_ref()), "discourse-api")
			.title(title)
			.note("Fetched via Discourse API")
			.finish()
	})
}

/// Read even the bodies of conclusive failures: an API error with JSON is
/// not evidence that the forum lacks the API (e.g. a deleted topic).
fn api_json(reply: &Fetched, context: &Context, key: &str) -> Option<Value> {
	if !is_conclusive_probe_status(reply.status) {
		return None;
	}
	let body = reply
		.body
		.strip_prefix(b"\xef\xbb\xbf")
		.unwrap_or(&reply.body);
	match serde_json::from_slice::<Value>(body) {
		Ok(value) if !reply.ok() && !value.is_null() => None,
		Ok(value)
			if !matches!(value, Value::Null | Value::Bool(false))
				&& value.as_f64() != Some(0.0)
				&& value.as_str() != Some("") =>
		{
			Some(value)
		},
		_ => {
			context.cache_put(key, "no".to_owned(), NEGATIVE_PROBE_TTL_SECS);
			None
		},
	}
}

fn markdown(topic: &Value, title: &str, requested: Option<&Value>) -> String {
	let stream = topic
		.get("post_stream")
		.map_or(&[][..], |stream| arr_of(stream, "posts"));
	let requested = requested.filter(|post| !stream.iter().any(|p| p.get("id") == post.get("id")));
	let mut posts = requested
		.into_iter()
		.chain(stream)
		.take(MAX_POSTS)
		.peekable();
	let mut md = format!("# {title}\n\n");

	let mut separator = "";
	for (key, label) in
		[("id", "Topic ID"), ("posts_count", "Posts"), ("views", "Views"), ("like_count", "Likes")]
	{
		if let Some(n) = u64_of(topic, key) {
			let _ = write!(md, "{separator}**{label}:** {n}");
			separator = " | ";
		}
	}
	if !separator.is_empty() {
		md.push('\n');
	}

	let category = topic.get("category");
	let category_name = category
		.and_then(|category| category.get("name"))
		.and_then(Value::as_str)
		.or_else(|| str_of(topic, "category_slug"))
		.filter(|name| !name.is_empty());
	let category_id = category
		.and_then(|category| u64_of(category, "id"))
		.or_else(|| u64_of(topic, "category_id"));
	if category_name.is_some() || category_id.is_some() {
		md.push_str("**Category:**");
		if let Some(name) = category_name {
			let _ = write!(md, " {name}");
		}
		if let Some(id) = category_id {
			let _ = write!(md, " #{id}");
		}
		md.push('\n');
	}
	let mut tags = arr_of(topic, "tags").iter().filter_map(Value::as_str);
	if let Some(first) = tags.next() {
		let _ = write!(md, "**Tags:** {first}");
		for tag in tags {
			let _ = write!(md, ", {tag}");
		}
		md.push('\n');
	}
	let created_by = topic
		.get("details")
		.and_then(|d| d.get("created_by"))
		.and_then(author);
	let created_at = str_of(topic, "created_at");
	if created_by.is_some() || created_at.is_some() {
		let _ = writeln!(
			md,
			"**Created by:** {} - {}",
			named_or_unknown(created_by),
			created_at.and_then(iso_date).unwrap_or_default(),
		);
	}
	md.push('\n');

	let excerpt = str_of(topic, "excerpt").map(|html| html_to_markdown(html, None));
	let mut first_body = if excerpt.is_none() {
		posts.peek().copied().map(post_body)
	} else {
		None
	};
	if let Some(description) = excerpt
		.as_deref()
		.or(first_body.as_deref())
		.filter(|s| !s.is_empty())
	{
		let _ = write!(md, "## Description\n\n{description}\n\n");
	}
	if posts.peek().is_some() {
		md.push_str("## Posts\n\n");
	}
	for post in posts {
		let label = u64_of(post, "post_number")
			.or_else(|| u64_of(post, "id"))
			.unwrap_or(0);
		let author = named_or_unknown(author(post));
		let date = str_of(post, "created_at")
			.and_then(iso_date)
			.unwrap_or_default();
		let likes = u64_of(post, "like_count").unwrap_or(0);
		let _ = write!(md, "### Post {label} - {author} - {date} - Likes: {likes}\n\n");
		let body = first_body.take().unwrap_or_else(|| post_body(post));
		let text = if body.is_empty() {
			"_No content available._"
		} else {
			body.as_ref()
		};
		let _ = write!(md, "{text}\n\n---\n\n");
	}
	md
}

fn author(user: &Value) -> Option<impl fmt::Display + '_> {
	let name = str_of(user, "name");
	let username = str_of(user, "username");
	(name.is_some() || username.is_some()).then(|| {
		fmt::from_fn(move |f| match (name, username) {
			(Some(name), Some(user)) if name != user => write!(f, "{name} (@{user})"),
			(_, Some(user)) => write!(f, "@{user}"),
			(name, None) => f.write_str(name.unwrap_or_default()),
		})
	})
}

fn named_or_unknown(author: Option<impl fmt::Display>) -> impl fmt::Display {
	fmt::from_fn(move |f| match &author {
		Some(author) => fmt::Display::fmt(author, f),
		None => f.write_str("unknown"),
	})
}

fn post_body(post: &Value) -> Cow<'_, str> {
	if let Some(raw) = str_of(post, "raw") {
		return Cow::Borrowed(raw);
	}
	str_of(post, "cooked").map_or(Cow::Borrowed(""), |html| Cow::Owned(html_to_markdown(html, None)))
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{
		Cache, Fetched,
		testing::{run, run_with},
	};

	#[test]
	fn a_mounted_post_reads_its_topic_and_keeps_a_post_missing_from_the_stream() {
		let post = json!({
			"id": 45, "topic_id": 12, "post_number": 3, "name": "Alice", "username": "alice",
			"raw": "**Raw reply**", "cooked": "<p>Ignored</p>", "created_at": "2026-01-02T00:00:00Z",
		});
		let thread = json!({
			"id": 12, "title": "Topic", "posts_count": 3, "views": 42, "category": {"id": 1, "name": "Help"}, "tags": ["help", "rust"],
			"post_stream": {"posts": [{"id": 20, "post_number": 1, "username": "bob", "cooked": "<p>Original post</p>"}]}
		});
		let mut requests = Vec::new();
		let done = run("https://forum.test/community/posts/45.json", |request| {
			requests.push(request.url.clone());
			if request.url.contains("/posts/") {
				Fetched::json(&post)
			} else {
				Fetched::json(&thread)
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://forum.test/community/posts/45.json?include_raw=1",
			"https://forum.test/community/t/12.json?include_raw=1",
		]);
		assert_eq!(done.method, "discourse-api");
		assert!(
			done
				.markdown
				.contains("**Category:** Help #1\n**Tags:** help, rust")
		);
		assert!(done.markdown.contains(
			"## Description\n\n**Raw reply**\n\n## Posts\n\n### Post 3 - Alice (@alice) - 2026-01-02"
		));
		assert!(done.markdown.contains("Original post") && !done.markdown.contains("Ignored"));
	}

	#[test]
	fn a_non_json_404_prevents_topic_reads_until_ten_minutes_have_elapsed() {
		let cache = Cache::isolated();
		let start = 1_767_225_600_000;
		for (id, elapsed, expected_calls) in [(1, 0, 1), (2, 599_999, 0), (3, 600_000, 1)] {
			let mut calls = 0;
			let done = run_with(
				&format!("https://html-404.test/t/slug/{id}"),
				|setup| {
					setup.cache = cache.clone();
					setup.now_ms = start + elapsed;
				},
				|request| {
					calls += 1;
					assert_eq!(request.url, format!("https://html-404.test/t/{id}.json?include_raw=1"));
					Fetched { status: 404, ..Fetched::text("text/html", "<html>Not found</html>") }
				},
			);
			assert_eq!(done, None);
			assert_eq!(calls, expected_calls);
		}
	}

	#[test]
	fn a_deleted_topic_returning_json_does_not_disable_other_topics() {
		let cache = Cache::isolated();
		let mut calls = 0;
		for id in [1, 2] {
			let done = run_with(
				&format!("https://json-404.test/t/slug/{id}"),
				|setup| setup.cache = cache.clone(),
				|_| {
					calls += 1;
					Fetched { status: 404, ..Fetched::json(&json!({"errors": ["not found"]})) }
				},
			);
			assert_eq!(done, None);
		}
		assert_eq!(calls, 2);
	}

	#[test]
	fn a_topic_list_has_no_individual_thread_to_fetch() {
		assert_eq!(run("https://forum.test/latest", |_| panic!("no fetch expected")), None);
	}
}
