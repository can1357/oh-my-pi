//! dev.to (`dev.to`): tag listings, user profiles and articles from the dev.to
//! API, so an article shows its Markdown body rather than the page chrome.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, fetch, format_number, html_to_markdown, iso_date,
	segment, str_of, u64_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "dev.to", open };

const METHOD: &str = "devto";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if url.host_str()? != "dev.to" {
		return None;
	}
	let parts: Vec<&str> = url
		.path_segments()?
		.filter(|part| !part.is_empty())
		.collect();
	match parts.as_slice() {
		["t", tag, ..] => listing_request(
			format!("https://dev.to/api/articles?tag={}&per_page=20", segment(tag)),
			format!("dev.to/t/{tag}"),
			false,
		),
		[username] => listing_request(
			format!("https://dev.to/api/articles?username={}&per_page=20", segment(username)),
			format!("dev.to/{username}"),
			true,
		),
		[username, slug, ..] => {
			let username = (*username).to_owned();
			let slug = (*slug).to_owned();
			fetch(
				Fetch::get(format!(
					"https://dev.to/api/articles/{}/{}",
					segment(&username),
					segment(&slug)
				)),
				move |reply, _| {
					let article = reply.json_value()?;
					let md = article_markdown(&article, &username)?;
					let title = str_of(&article, "title").unwrap_or_default().to_owned();
					Done::new(md, METHOD)
						.title(title)
						.note("Fetched via dev.to API")
						.finish()
				},
			)
		},
		_ => None,
	}
}

fn listing_request(api: String, title: String, profile: bool) -> Option<Action> {
	fetch(Fetch::get(api), move |reply, _| {
		let articles = reply.json_value()?;
		let articles = articles.as_array()?;
		if articles.is_empty() {
			return None;
		}
		let md = listing(&title, articles, profile);
		Done::new(md, METHOD)
			.title(title)
			.note("Fetched via dev.to API")
			.finish()
	})
}

/// Tags of an article, preferring `tag_list` when the API sent it.
fn tags_of(article: &Value) -> Vec<&str> {
	if article.get("tag_list").and_then(Value::as_array).is_some() {
		return arr_of(article, "tag_list")
			.iter()
			.filter_map(Value::as_str)
			.collect();
	}
	arr_of(article, "tags")
		.iter()
		.filter_map(Value::as_str)
		.collect()
}

fn published(article: &Value) -> String {
	str_of(article, "published_at")
		.or_else(|| str_of(article, "published_timestamp"))
		.and_then(iso_date)
		.unwrap_or_default()
		.to_owned()
}

fn reactions(article: &Value) -> u64 {
	u64_of(article, "positive_reactions_count")
		.or_else(|| u64_of(article, "public_reactions_count"))
		.unwrap_or(0)
}

fn read_time(article: &Value) -> Option<u64> {
	u64_of(article, "reading_time_minutes").filter(|minutes| *minutes > 0)
}

/// A listing of articles: `profile` writes the author line instead of the
/// reaction line's leading separator the TS handler trimmed for profiles.
fn listing(title: &str, articles: &[Value], profile: bool) -> String {
	let mut md = format!("# {title}\n\n## Recent Articles ({})\n\n", articles.len());
	for article in articles {
		let _ = writeln!(md, "### {}", str_of(article, "title").unwrap_or("(untitled)"));
		md.push('\n');
		if profile {
			if let Some(minutes) = read_time(article) {
				let _ = write!(md, "{minutes} min read");
			}
		} else {
			let user = article.get("user");
			let name = user
				.and_then(|user| str_of(user, "name"))
				.unwrap_or("Unknown");
			let username = user
				.and_then(|user| str_of(user, "username"))
				.unwrap_or("unknown");
			let _ = write!(md, "by **{name}** (@{username})");
			if let Some(minutes) = read_time(article) {
				let _ = write!(md, " · {minutes} min read");
			}
		}
		if reactions(article) > 0 {
			let _ = write!(md, " · {} reactions", format_number(reactions(article) as f64));
		}
		md.push('\n');
		let _ = writeln!(md, "*{}*", published(article));
		let tags = tags_of(article);
		if !tags.is_empty() {
			let _ = writeln!(
				md,
				"Tags: {}",
				tags
					.iter()
					.map(|tag| format!("#{tag}"))
					.collect::<Vec<_>>()
					.join(", ")
			);
		}
		if let Some(description) = str_of(article, "description") {
			let _ = write!(md, "\n{description}\n");
		}
		md.push_str("\n---\n\n");
	}
	md
}

fn article_markdown(article: &Value, username: &str) -> Option<String> {
	let title = str_of(article, "title")?;
	let user = article.get("user");
	let author = user
		.and_then(|user| str_of(user, "name"))
		.unwrap_or("Unknown");
	let handle = user
		.and_then(|user| str_of(user, "username"))
		.unwrap_or(username);
	let tags = tags_of(article);

	let mut md = format!("# {title}\n\n");
	let _ = writeln!(md, "**Author:** {author} (@{handle})");
	let _ = writeln!(md, "**Published:** {}", published(article));
	if let Some(minutes) = read_time(article) {
		let _ = writeln!(md, "**Reading time:** {minutes} min");
	}
	if reactions(article) > 0 {
		let _ = writeln!(md, "**Reactions:** {}", format_number(reactions(article) as f64));
	}
	if let Some(comments) = u64_of(article, "comments_count").filter(|comments| *comments > 0) {
		let _ = writeln!(md, "**Comments:** {}", format_number(comments as f64));
	}
	if !tags.is_empty() {
		let _ = writeln!(
			md,
			"**Tags:** {}",
			tags
				.iter()
				.map(|tag| format!("#{tag}"))
				.collect::<Vec<_>>()
				.join(", ")
		);
	}
	md.push_str("\n---\n\n");

	let body = article
		.get("body_markdown")
		.and_then(Value::as_str)
		.filter(|body| !body.is_empty())
		.map(str::to_owned)
		.or_else(|| {
			article
				.get("body_html")
				.and_then(Value::as_str)
				.filter(|body| !body.is_empty())
				.map(|html| html_to_markdown(html, None))
		});
	if let Some(body) = body {
		md.push_str(&body);
	}
	Some(md)
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn a_tag_page_lists_the_newest_articles() {
		let articles = json!([
			{
				"title": "Rust in 2026", "description": "A look ahead.",
				"tag_list": ["rust", "webdev"], "reading_time_minutes": 5,
				"positive_reactions_count": 1234, "published_at": "2026-01-02T03:04:05Z",
				"user": { "name": "Ana", "username": "ana" }
			},
			{ "title": "Old post", "tags": ["rust"], "published_timestamp": "2025-02-03T00:00:00Z" }
		]);
		let mut requests = Vec::new();
		let done = run("https://dev.to/t/rust/top/week", |request| {
			requests.push(request.url.clone());
			Fetched::json(&articles)
		})
		.unwrap();
		assert_eq!(requests, ["https://dev.to/api/articles?tag=rust&per_page=20"]);
		assert_eq!((done.method, done.title.as_deref()), ("devto", Some("dev.to/t/rust")));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# dev.to/t/rust\n\n## Recent Articles (2)\n\n### Rust in 2026\n\nby **Ana** (@ana) · 5 \
			 min read · 1.2K reactions\n*2026-01-02*\nTags: #rust, #webdev\n\nA look ahead.\n\n---\n"
		));
		assert!(
			md.contains("### Old post\n\nby **Unknown** (@unknown)\n*2025-02-03*\nTags: #rust\n")
		);
	}

	#[test]
	fn a_user_profile_drops_the_author_line() {
		let done = run("https://dev.to/ben", |_| {
			Fetched::json(&json!([{ "title": "Hello", "reading_time_minutes": 3, "positive_reactions_count": 0, "published_at": "2024-05-06T00:00:00Z", "tag_list": [] }]))
		})
		.unwrap();
		assert!(done.markdown.starts_with(
			"# dev.to/ben\n\n## Recent Articles (1)\n\n### Hello\n\n3 min read\n*2024-05-06*\n"
		));
		assert!(!done.markdown.contains("by **"));
	}

	#[test]
	fn an_article_prefers_its_markdown_body() {
		let article = json!({
			"title": "Async Rust", "tag_list": ["rust"], "reading_time_minutes": 7,
			"public_reactions_count": 42, "comments_count": 3, "published_at": "2024-06-07T00:00:00Z",
			"user": { "name": "Ben", "username": "ben" },
			"body_markdown": "# Body\n\nText.", "body_html": "<p>ignored</p>"
		});
		let mut requests = Vec::new();
		let done = run("https://dev.to/ben/async-rust-1abc", |request| {
			requests.push(request.url.clone());
			Fetched::json(&article)
		})
		.unwrap();
		assert_eq!(requests, ["https://dev.to/api/articles/ben/async-rust-1abc"]);
		let md = &done.markdown;
		assert!(md.starts_with(
			"# Async Rust\n\n**Author:** Ben (@ben)\n**Published:** 2024-06-07\n**Reading time:** 7 \
			 min\n**Reactions:** 42\n**Comments:** 3\n**Tags:** #rust\n\n---\n\n# Body\n\nText."
		));
		assert!(!md.contains("ignored"));
	}

	#[test]
	fn other_hosts_and_api_failures_fall_through() {
		assert_eq!(run("https://example.test/ben", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://dev.to/t/rust", |_| Fetched::json(&json!([]))), None);
		assert_eq!(run("https://dev.to/ben/post", |_| Fetched::status(404)), None);
	}
}
