//! Hacker News (`news.ycombinator.com`). An item comes with its comment tree
//! from the Algolia HN API in one request; the front, newest and best listings
//! take their story ids from the Firebase API and the stories from one Algolia
//! batch query.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, fetch, html_to_markdown, i64_of, str_of, u64_of,
	unix_datetime,
};

/// Registry entry.
pub const SITE: Site = Site { name: "hackernews", open };

const FIREBASE: &str = "https://hacker-news.firebaseio.com/v0";
const ALGOLIA: &str = "https://hn.algolia.com/api/v1";
const METHOD: &str = "hackernews";
/// Stories in a listing.
const LISTING_SIZE: usize = 20;
/// Top-level comments rendered under an item.
const TOP_COMMENTS: usize = 20;
/// Replies rendered under each top-level comment.
const REPLIES: usize = 10;

fn open(url: &Url, _: &Context) -> Option<Action> {
	if url.host_str()? != "news.ycombinator.com" {
		return None;
	}
	match url.path() {
		"/item" => {
			let id: u64 = url
				.query_pairs()
				.find(|(key, _)| key == "id")?
				.1
				.parse()
				.ok()?;
			fetch(Fetch::get(format!("{ALGOLIA}/items/{id}")).accept_json(), move |reply, _| {
				let item = reply.json_value()?;
				let (title, markdown) = story(&item)?;
				Done::new(markdown, METHOD)
					.title(title)
					.note(format!("Fetched HN item {id} with top-level comments (depth 2)"))
					.finish()
			})
		},
		"/" | "/news" => listing(
			"topstories",
			"Hacker News - Top Stories",
			"Fetched top 20 stories from HN front page",
		),
		"/newest" => listing("newstories", "Hacker News - New Stories", "Fetched top 20 new stories"),
		"/best" => {
			listing("beststories", "Hacker News - Best Stories", "Fetched top 20 best stories")
		},
		_ => None,
	}
}

/// A comment that still has an author and a body (deleted and dead ones lose
/// both).
fn visible(comment: &Value) -> bool {
	str_of(comment, "author").is_some() && str_of(comment, "text").is_some()
}

fn count_comments(item: &Value) -> usize {
	arr_of(item, "children")
		.iter()
		.map(|child| usize::from(visible(child)) + count_comments(child))
		.sum()
}

fn time(item: &Value) -> String {
	i64_of(item, "created_at_i").map_or_else(|| "unknown time".to_owned(), unix_datetime)
}

/// Title and Markdown of an item with two levels of comments.
fn story(item: &Value) -> Option<(String, String)> {
	let author = str_of(item, "author")?;
	let title = str_of(item, "title").map_or_else(|| format!("Comment by {author}"), str::to_owned);
	let mut out = format!("# {title}\n\n");
	if let Some(link) = str_of(item, "url") {
		let _ = write!(out, "**URL:** {link}\n\n");
	}
	let points = u64_of(item, "points").unwrap_or(0);
	let _ = write!(out, "**Posted by:** {author} | **Score:** {points} | **Time:** {}", time(item));
	let total = count_comments(item);
	if total > 0 {
		let _ = write!(out, " | **Comments:** {total}");
	}
	out.push_str("\n\n");
	if let Some(text) = str_of(item, "text") {
		out.push_str(&html_to_markdown(text, None));
		out.push_str("\n\n");
	}

	let mut comments = arr_of(item, "children")
		.iter()
		.filter(|c| visible(c))
		.take(TOP_COMMENTS)
		.peekable();
	if comments.peek().is_some() {
		out.push_str("---\n\n## Comments\n\n");
	}
	for comment in comments {
		write_comment(&mut out, comment, "");
		for reply in arr_of(comment, "children")
			.iter()
			.filter(|c| visible(c))
			.take(REPLIES)
		{
			write_comment(&mut out, reply, "  ");
		}
	}
	Some((title, out))
}

fn write_comment(out: &mut String, comment: &Value, indent: &str) {
	let author = str_of(comment, "author").unwrap_or("[deleted]");
	let _ = writeln!(out, "{indent}**{author}** ({})", time(comment));
	let text = str_of(comment, "text").map_or_default(|html| html_to_markdown(html, None));
	for line in text.lines() {
		let _ = writeln!(out, "{indent}{line}");
	}
	out.push('\n');
}

/// A listing: story ids from Firebase, then the stories in one Algolia query,
/// written in the listing's order.
fn listing(list: &'static str, title: &'static str, note: &'static str) -> Option<Action> {
	fetch(Fetch::get(format!("{FIREBASE}/{list}.json")).accept_json(), move |reply, _| {
		let ids: Vec<u64> = reply
			.json_value()?
			.as_array()?
			.iter()
			.filter_map(Value::as_u64)
			.take(LISTING_SIZE)
			.collect();
		if ids.is_empty() {
			return None;
		}
		let tags = ids
			.iter()
			.map(|id| format!("story_{id}"))
			.collect::<Vec<_>>()
			.join(",");
		let query = format!("{ALGOLIA}/search?tags=({tags})&hitsPerPage={}", ids.len());
		fetch(Fetch::get(query).accept_json(), move |reply, _| {
			let data = reply.json_value()?;
			let hits = arr_of(&data, "hits");
			let mut out = format!("# {title}\n\n");
			let mut rank = 0;
			for id in &ids {
				let Some(hit) = hits.iter().find(|hit| u64_of(hit, "objectID") == Some(*id)) else {
					continue;
				};
				rank += 1;
				let _ = writeln!(out, "{rank}. **{}**", str_of(hit, "title").unwrap_or("(untitled)"));
				if let Some(link) = str_of(hit, "url") {
					let _ = writeln!(out, "   {link}");
				}
				let _ = write!(
					out,
					"   {} points by {} | {}",
					u64_of(hit, "points").unwrap_or(0),
					str_of(hit, "author").unwrap_or("[deleted]"),
					time(hit)
				);
				if let Some(comments) = u64_of(hit, "num_comments").filter(|n| *n > 0) {
					let _ = write!(out, " | {comments} comments");
				}
				let _ = write!(out, "\n   https://news.ycombinator.com/item?id={id}\n\n");
			}
			if rank == 0 {
				return None;
			}
			Done::new(out, METHOD).title(title).note(note).finish()
		})
	})
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn an_item_renders_with_two_levels_of_comments_in_one_request() {
		let tree = json!({
			"id": 1, "type": "story", "author": "pg", "title": "Y Combinator", "url": "http://ycombinator.com",
			"points": 57, "created_at_i": 1_160_418_111, "text": null,
			"children": [
				{ "author": "sama", "created_at_i": 1_160_419_000, "text": "<p>First comment</p><p>Second paragraph</p>",
				  "children": [
					{ "author": "pg", "created_at_i": 1_160_420_000, "text": "A reply",
					  "children": [{ "author": "deep", "text": "Too deep to show", "children": [] }] }
				  ] },
				{ "author": null, "text": null, "children": [] }
			]
		});
		let mut requests = Vec::new();
		let done = run("https://news.ycombinator.com/item?id=1", |request| {
			requests.push(request.url.clone());
			Fetched::json(&tree)
		})
		.unwrap();
		assert_eq!(requests, ["https://hn.algolia.com/api/v1/items/1"]);
		assert_eq!(done.method, "hackernews");
		assert_eq!(done.title.as_deref(), Some("Y Combinator"));
		let md = &done.markdown;
		assert!(md.starts_with("# Y Combinator\n\n**URL:** http://ycombinator.com\n\n"));
		assert!(md.contains(
			"**Posted by:** pg | **Score:** 57 | **Time:** 2006-10-09 18:21 UTC | **Comments:** 3"
		));
		assert!(md.contains("## Comments\n\n**sama** (2006-10-09 18:36 UTC)\nFirst comment"));
		assert!(md.contains("Second paragraph"));
		assert!(md.contains("  **pg** (") && md.contains("  A reply"));
		assert!(!md.contains("Too deep to show"));
	}

	#[test]
	fn a_listing_keeps_the_firebase_order() {
		let done = run("https://news.ycombinator.com/best", |request| {
			if request.url.ends_with("/beststories.json") {
				return Fetched::json(&json!([3, 1, 2]));
			}
			assert_eq!(
				request.url,
				"https://hn.algolia.com/api/v1/search?tags=(story_3,story_1,story_2)&hitsPerPage=3"
			);
			Fetched::json(&json!({ "hits": [
				{ "objectID": "1", "title": "First", "author": "a", "points": 10, "num_comments": 0, "created_at_i": 0 },
				{ "objectID": "3", "title": "Third", "url": "https://x.test/3", "author": "c", "points": 30, "num_comments": 4, "created_at_i": 0 }
			] }))
		})
		.unwrap();
		assert!(done.markdown.starts_with(
			"# Hacker News - Best Stories\n\n1. **Third**\n   https://x.test/3\n   30 points by c | 1970-01-01 00:00 UTC | 4 comments\n   https://news.ycombinator.com/item?id=3\n\n2. **First**\n"
		));
		assert_eq!(done.notes, ["Fetched top 20 best stories"]);
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(
			run("https://news.ycombinator.com/user?id=pg", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(run("https://news.ycombinator.com/item?id=1", |_| Fetched::status(503)), None);
	}
}
