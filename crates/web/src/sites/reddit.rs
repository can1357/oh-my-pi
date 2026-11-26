//! Reddit threads and listings, with Redlib and Arctic Shift fallbacks.

mod redlib;

use std::{borrow::Cow, fmt::Write as _, iter};

use serde_json::Value;
use url::{Url, form_urlencoded};

use super::{
	Action, Context, Done, Fetch, Fetched, Site, arr_of, f64_of, fetch, i64_of, str_of, u64_of,
	unix_date,
};

pub const SITE: Site = Site { name: "reddit", open };

const ORIGIN: &str = "https://www.reddit.com";
const REDLIB: &str = "https://safereddit.com";
const ARCHIVE: &str = "https://arctic-shift.photon-reddit.com/api";
const METHOD: &str = "reddit";
const API_NOTE: &str = "Fetched via Reddit JSON API";
const MIRROR_NOTE: &str = "Fetched via Redlib mirror safereddit.com (Reddit API unavailable)";
const ARCHIVE_NOTE: &str = "Fetched from the Arctic Shift archive (Reddit and Redlib \
                            unavailable): scores and the newest comments may lag, listings are \
                            newest-first";
const ARCHIVE_LISTING_LIMIT: usize = 25;

#[derive(Default)]
struct Target {
	path:      String,
	query:     String,
	post:      Option<String>,
	focus:     Option<String>,
	subreddit: Option<String>,
	user:      Option<String>,
	tab:       Tab,
}

#[derive(Default)]
enum Tab {
	#[default]
	Overview,
	Submitted,
	Comments,
}

impl Target {
	fn from_url(url: &Url) -> Option<Self> {
		let host = url.host_str()?;
		if host != "redd.it" && host != "reddit.com" && !host.ends_with(".reddit.com") {
			return None;
		}
		let parts: Vec<_> = url.path_segments()?.filter(|p| !p.is_empty()).collect();
		let thing_id = |id: &&str| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric());
		if host == "redd.it" {
			let [id] = parts.as_slice() else { return None };
			if !thing_id(id) {
				return None;
			}
			return Some(Self {
				path: format!("/comments/{id}"),
				post: Some((*id).to_owned()),
				..Self::default()
			});
		}
		if parts.iter().any(|part| {
			part.rsplit_once('.').is_some_and(|(_, ext)| {
				["json", "rss", "xml"]
					.iter()
					.any(|raw| ext.eq_ignore_ascii_case(raw))
			})
		}) {
			return None;
		}
		let first = parts.first().copied().unwrap_or_default();
		let is_subreddit = first.eq_ignore_ascii_case("r");
		let is_user = first.eq_ignore_ascii_case("u") || first.eq_ignore_ascii_case("user");
		let owner = usize::from(is_subreddit || is_user) * 2;
		let subreddit = parts.get(1).copied().filter(|_| is_subreddit);
		if parts
			.get(owner)
			.is_some_and(|part| part.eq_ignore_ascii_case("comments"))
			&& let Some(post) = parts.get(owner + 1).copied().filter(thing_id)
		{
			let focus = parts.get(owner + 3).copied().filter(thing_id);
			let mut path = subreddit.map_or_else(String::new, |sub| format!("/r/{sub}"));
			let _ = write!(path, "/comments/{post}");
			if let Some(focus) = focus {
				let _ = write!(path, "/_/{focus}");
			}
			return Some(Self {
				path,
				post: Some(post.to_owned()),
				focus: focus.map(str::to_owned),
				subreddit: subreddit.map(str::to_owned),
				..Self::default()
			});
		}

		let mut target =
			Self { query: url.query().unwrap_or_default().to_owned(), ..Self::default() };
		let last = parts.get(2).copied();
		if parts.len() <= 3 {
			if let Some(sub) = subreddit
				&& last.is_none_or(|sort| {
					["hot", "new", "top", "rising", "controversial", "best"]
						.iter()
						.any(|s| sort.eq_ignore_ascii_case(s))
				}) {
				target.subreddit = Some(sub.to_owned());
			}
			if is_user && let Some(name) = parts.get(1) {
				let tab = match last {
					None => Some(Tab::Overview),
					Some(tab) if tab.eq_ignore_ascii_case("overview") => Some(Tab::Overview),
					Some(tab) if tab.eq_ignore_ascii_case("submitted") => Some(Tab::Submitted),
					Some(tab) if tab.eq_ignore_ascii_case("comments") => Some(Tab::Comments),
					_ => None,
				};
				if let Some(tab) = tab {
					target.tab = tab;
					target.user = Some((*name).to_owned());
					target.path = path(iter::once("user").chain(parts[1..].iter().copied()));
					return Some(target);
				}
			}
		}
		target.path = path(parts);
		Some(target)
	}

	fn listing_title(&self) -> String {
		if let Some(sub) = &self.subreddit {
			format!("r/{sub}")
		} else if let Some(user) = &self.user {
			format!("u/{user}")
		} else {
			format!(
				"reddit.com{}",
				if self.path.is_empty() {
					"/"
				} else {
					&self.path
				}
			)
		}
	}
}

fn path<'a>(parts: impl IntoIterator<Item = &'a str>) -> String {
	let mut path = String::new();
	for part in parts {
		path.push('/');
		path.push_str(part);
	}
	path
}

fn open(url: &Url, _: &Context) -> Option<Action> {
	let target = Target::from_url(url)?;
	let mut query = form_urlencoded::Serializer::new(String::new());
	let mut raw_json = false;
	for (key, value) in form_urlencoded::parse(target.query.as_bytes()) {
		if key == "raw_json" {
			if !raw_json {
				query.append_pair("raw_json", "1");
				raw_json = true;
			}
		} else {
			query.append_pair(&key, &value);
		}
	}
	if !raw_json {
		query.append_pair("raw_json", "1");
	}
	let request =
		Fetch::get(format!("{ORIGIN}{}/.json?{}", target.path, query.finish())).accept_json();
	fetch(request, move |reply, _| {
		if let Some(done) = reply.json_value().and_then(|data| api_page(&data, &target)) {
			return done.note(API_NOTE).finish();
		}
		mirror(target)
	})
}

fn mirror(target: Target) -> Option<Action> {
	let path = if target.path.is_empty() {
		"/"
	} else {
		&target.path
	};
	let mut url = format!("{REDLIB}{path}");
	if !target.query.is_empty() {
		url.push('?');
		url.push_str(&target.query);
	}
	fetch(Fetch::get(url), move |reply, _| {
		if let Some(done) = reply
			.body_text()
			.and_then(|html| redlib::page(&html, &target))
		{
			return done.note(MIRROR_NOTE).finish();
		}
		archive(target)
	})
}

fn archive(target: Target) -> Option<Action> {
	if let Some(post) = &target.post {
		return fetch(archive_get(&format!("posts/ids?ids={post}")), move |reply, _| {
			let data = reply.json_value()?;
			let post = arr_of(&data, "data").first()?;
			let post = Post::from_json(post)?;
			let mut md = thread_intro(&post);
			let title = post.title.into_owned();
			let id = target.post.as_deref()?;
			let mut query = format!("comments/tree?link_id={id}&limit=500");
			if let Some(focus) = &target.focus {
				let _ = write!(query, "&parent_id=t1_{focus}");
			}
			fetch(archive_get(&query), move |reply, _| {
				if let Some(data) = reply.json_value() {
					write_thread_comments(&mut md, &Comments::from_json(arr_of(&data, "data")), &target);
				}
				Done::new(md, METHOD)
					.title(title)
					.note(ARCHIVE_NOTE)
					.finish()
			})
		});
	}
	if let Some(sub) = &target.subreddit {
		return fetch(archive_search("posts", "subreddit", sub), move |reply, _| {
			let data = reply.json_value()?;
			listing(
				&target,
				arr_of(&data, "data")
					.iter()
					.filter_map(|p| Entry::from_json("t3", p)),
			)?
			.note(ARCHIVE_NOTE)
			.finish()
		});
	}
	let author = target.user.as_deref()?;
	if matches!(target.tab, Tab::Comments) {
		return fetch(archive_search("comments", "author", author), move |reply, _| {
			archive_user(&target, None, Some(reply))
		});
	}
	fetch(archive_search("posts", "author", author), move |posts, _| {
		if matches!(target.tab, Tab::Submitted) {
			return archive_user(&target, Some(posts), None);
		}
		fetch(archive_search("comments", "author", target.user.as_deref()?), move |comments, _| {
			archive_user(&target, Some(posts), Some(comments))
		})
	})
}

fn archive_get(path: &str) -> Fetch {
	Fetch::get(format!("{ARCHIVE}/{path}")).accept_json()
}

fn archive_search(kind: &str, filter: &str, value: &str) -> Fetch {
	let mut query = form_urlencoded::Serializer::new(String::new());
	query.append_pair(filter, value).append_pair("sort", "desc");
	archive_get(&format!("{kind}/search?{}&limit={ARCHIVE_LISTING_LIMIT}", query.finish()))
}

fn archive_user(
	target: &Target,
	posts: Option<Fetched>,
	comments: Option<Fetched>,
) -> Option<Action> {
	let posts = posts
		.and_then(|reply| reply.json_value())
		.unwrap_or_default();
	let comments = comments
		.and_then(|reply| reply.json_value())
		.unwrap_or_default();
	let mut entries: Vec<_> = arr_of(&posts, "data")
		.iter()
		.map(|v| ("t3", v))
		.chain(arr_of(&comments, "data").iter().map(|v| ("t1", v)))
		.map(|(kind, value)| (kind, value, f64_of(value, "created_utc").unwrap_or(0.0)))
		.collect();
	entries.sort_by(|a, b| b.2.total_cmp(&a.2));
	listing(
		target,
		entries
			.into_iter()
			.take(ARCHIVE_LISTING_LIMIT)
			.filter_map(|(kind, data, _)| Entry::from_json(kind, data)),
	)?
	.note(ARCHIVE_NOTE)
	.finish()
}

fn api_page(data: &Value, target: &Target) -> Option<Done> {
	if let Some(listings) = data.as_array() {
		let post = json_children(listings.first()?).first()?.get("data")?;
		let replies = listings.get(1).map_or(&[][..], json_children);
		Some(thread(Post::from_json(post)?, Comments::from_json(replies), target))
	} else {
		listing(
			target,
			json_children(data)
				.iter()
				.filter_map(|thing| Entry::from_json(str_of(thing, "kind")?, thing.get("data")?)),
		)
	}
}

fn json_children(data: &Value) -> &[Value] {
	data
		.get("data")
		.map_or(&[], |data| arr_of(data, "children"))
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
	value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn absolute(href: &str) -> Cow<'_, str> {
	if href.starts_with('/') {
		Cow::Owned(format!("{ORIGIN}{href}"))
	} else {
		Cow::Borrowed(href)
	}
}

fn date(value: &Value) -> String {
	f64_of(value, "created_utc")
		.filter(|s| s.abs() <= 8.64e12)
		.map_or_default(|s| unix_date(s.floor() as i64))
}

#[derive(Default)]
struct Post<'a> {
	title:     Cow<'a, str>,
	author:    Cow<'a, str>,
	subreddit: Cow<'a, str>,
	permalink: Cow<'a, str>,
	body:      Cow<'a, str>,
	score:     Option<i64>,
	comments:  Option<i64>,
	date:      String,
	link:      &'a str,
	flair:     Cow<'a, str>,
}

impl<'a> Post<'a> {
	fn from_json(data: &'a Value) -> Option<Self> {
		let title = text(data, "title");
		if title.is_empty() {
			return None;
		}
		let permalink = absolute(text(data, "permalink"));
		let url = text(data, "url");
		let link = if data.get("is_self").and_then(Value::as_bool) == Some(false)
			&& url != permalink.as_ref()
		{
			url
		} else {
			""
		};
		Some(Self {
			title: title.into(),
			author: data
				.get("author")
				.and_then(Value::as_str)
				.unwrap_or("[deleted]")
				.into(),
			subreddit: text(data, "subreddit").into(),
			permalink,
			body: text(data, "selftext").into(),
			score: i64_of(data, "score"),
			comments: i64_of(data, "num_comments"),
			date: date(data),
			link,
			flair: text(data, "link_flair_text").into(),
		})
	}
}

#[derive(Default)]
struct Comments<'a> {
	visible: Vec<Comment<'a>>,
	hidden:  u64,
}

impl<'a> Comments<'a> {
	fn from_json(things: &'a [Value]) -> Self {
		let mut comments = Self::default();
		for item in things {
			let Some(data) = item.get("data") else {
				continue;
			};
			match str_of(item, "kind") {
				Some("t1") => comments.visible.push(Comment::from_json(data, true)),
				Some("more") => {
					let count = u64_of(data, "count")
						.filter(|n| *n > 0)
						.unwrap_or_else(|| arr_of(data, "children").len() as u64);
					comments.hidden = comments.hidden.saturating_add(count);
				},
				_ => {},
			}
		}
		comments
	}
}

struct Comment<'a> {
	author:  Cow<'a, str>,
	body:    Cow<'a, str>,
	score:   Option<i64>,
	date:    String,
	is_op:   bool,
	replies: Comments<'a>,
}

impl<'a> Comment<'a> {
	fn from_json(value: &'a Value, with_replies: bool) -> Self {
		Self {
			author:  value
				.get("author")
				.and_then(Value::as_str)
				.unwrap_or("[deleted]")
				.into(),
			body:    text(value, "body").into(),
			score:   i64_of(value, "score"),
			date:    date(value),
			is_op:   value.get("is_submitter").and_then(Value::as_bool) == Some(true),
			replies: if with_replies {
				value
					.get("replies")
					.map_or_else(Comments::default, |replies| {
						Comments::from_json(json_children(replies))
					})
			} else {
				Comments::default()
			},
		}
	}
}

#[derive(Default)]
struct ThreadLink<'a> {
	title:     Cow<'a, str>,
	subreddit: Cow<'a, str>,
	permalink: Cow<'a, str>,
}

enum Entry<'a> {
	Post(Post<'a>),
	Comment(Comment<'a>, ThreadLink<'a>),
}

impl<'a> Entry<'a> {
	fn from_json(kind: &str, value: &'a Value) -> Option<Self> {
		match kind {
			"t3" => Post::from_json(value).map(Self::Post),
			"t1" => Some(Self::Comment(Comment::from_json(value, false), ThreadLink {
				title:     text(value, "link_title").into(),
				subreddit: text(value, "subreddit").into(),
				permalink: absolute(text(value, "permalink")),
			})),
			_ => None,
		}
	}
}

fn thread(post: Post<'_>, comments: Comments<'_>, target: &Target) -> Done {
	let mut md = thread_intro(&post);
	write_thread_comments(&mut md, &comments, target);
	Done::new(md, METHOD).title(post.title.into_owned())
}

fn thread_intro(post: &Post<'_>) -> String {
	let mut md = format!("# {}\n\n", post.title);
	if !post.subreddit.is_empty() {
		let _ = write!(md, "**r/{}** · ", post.subreddit);
	}
	let _ = write!(md, "u/{}", post.author);
	post_meta(&mut md, post);
	md.push_str("\n\n");
	if !post.link.is_empty() {
		let _ = write!(md, "**Link:** {}\n\n", post.link);
	}
	if !post.body.trim().is_empty() {
		let _ = write!(md, "---\n\n{}\n\n", post.body.trim());
	}
	md
}

fn write_thread_comments(md: &mut String, comments: &Comments<'_>, target: &Target) {
	if comments.visible.is_empty() && comments.hidden == 0 {
		return;
	}
	let heading = if target.focus.is_some() {
		"Comment thread"
	} else {
		"Comments"
	};
	let _ = write!(md, "---\n\n## {heading}\n\n");
	write_comments(md, comments, 0, "comment");
}

fn write_comments(md: &mut String, comments: &Comments<'_>, width: usize, hidden_label: &str) {
	for comment in &comments.visible {
		let _ = write!(
			md,
			"{:width$}- **u/{}**{}",
			"",
			comment.author,
			if comment.is_op { " (OP)" } else { "" }
		);
		comment_meta(md, comment);
		md.push('\n');
		indent(md, &comment.body, width + 2);
		md.push('\n');
		write_comments(md, &comment.replies, width + 2, "reply");
	}
	if comments.hidden > 0 {
		let noun = match (comments.hidden == 1, hidden_label) {
			(true, noun) => noun,
			(false, "reply") => "replies",
			(false, _) => "comments",
		};
		let _ = writeln!(md, "{:width$}- *… {} more {noun}*", "", comments.hidden);
	}
}

fn listing<'a>(target: &Target, mut entries: impl Iterator<Item = Entry<'a>>) -> Option<Done> {
	let first = entries.next()?;
	let title = target.listing_title();
	let mut md = format!("# {title}\n\n");
	for (index, entry) in iter::once(first).chain(entries).enumerate() {
		if index > 0 {
			md.push('\n');
		}
		match entry {
			Entry::Post(post) => {
				let _ = write!(md, "- **{}**", post.title);
				if !post.subreddit.is_empty() {
					let _ = write!(md, " · r/{}", post.subreddit);
				}
				let _ = write!(md, " · u/{}", post.author);
				post_meta(&mut md, &post);
				let _ = write!(md, "\n  {}\n", post.permalink);
			},
			Entry::Comment(comment, link) => {
				let _ = write!(md, "- Comment by **u/{}**", comment.author);
				if !link.title.is_empty() {
					let _ = write!(md, " on \"{}\"", link.title);
				}
				if !link.subreddit.is_empty() {
					let _ = write!(md, " · r/{}", link.subreddit);
				}
				comment_meta(&mut md, &comment);
				md.push('\n');
				if !link.permalink.is_empty() {
					let _ = writeln!(md, "  {}", link.permalink);
				}
				indent(&mut md, &comment.body, 2);
			},
		}
	}
	Some(Done::new(md, METHOD).title(title))
}

fn count(md: &mut String, value: Option<i64>, name: &str) {
	if let Some(n) = value {
		let _ = write!(md, " · {n} {name}{}", if n == 1 { "" } else { "s" });
	}
}

fn post_meta(md: &mut String, post: &Post<'_>) {
	count(md, post.score, "point");
	count(md, post.comments, "comment");
	if !post.date.is_empty() {
		let _ = write!(md, " · {}", post.date);
	}
	if !post.flair.is_empty() {
		let _ = write!(md, " · [{}]", post.flair);
	}
}

fn comment_meta(md: &mut String, comment: &Comment<'_>) {
	count(md, comment.score, "point");
	if !comment.date.is_empty() {
		let _ = write!(md, " · {}", comment.date);
	}
}

fn indent(md: &mut String, body: &str, width: usize) {
	for line in body.trim().split_terminator('\n') {
		if line.is_empty() {
			md.push('\n');
		} else {
			let _ = writeln!(md, "{:width$}{line}", "");
		}
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::{super::testing::run, *};

	fn post() -> Value {
		json!({"title": "Borrow checker tips", "author": "ferris", "subreddit": "rust", "score": 42,
			"num_comments": 3, "created_utc": 1_773_915_404, "selftext": "Share your tricks.", "link_flair_text": "Discussion"})
	}

	fn comments() -> Value {
		json!([
			{"kind": "t1", "data": {"author": "alice", "body": "Clone less.", "score": 7, "created_utc": 1_773_977_226,
				"replies": {"data": {"children": [
					{"kind": "t1", "data": {"author": "ferris", "body": "Agreed.", "score": 1, "is_submitter": true}},
					{"kind": "more", "data": {"count": 4}}
				]}}}},
			{"kind": "more", "data": {"count": 13}}
		])
	}

	#[test]
	fn a_short_link_renders_nested_and_collapsed_comments_from_the_json_api() {
		let done = run("https://redd.it/abc123?ignored=1", |request| {
			assert_eq!(request.url, "https://www.reddit.com/comments/abc123/.json?raw_json=1");
			Fetched::json(&json!([
				{"data": {"children": [{"kind": "t3", "data": post()}]}},
				{"data": {"children": comments()}}
			]))
		})
		.unwrap();
		assert_eq!(done.method, "reddit");
		assert_eq!(done.notes, [API_NOTE]);
		assert!(
			done
				.markdown
				.contains("**r/rust** · u/ferris · 42 points · 3 comments · 2026-03-19 · [Discussion]")
		);
		assert!(
			done
				.markdown
				.contains("- **u/alice** · 7 points · 2026-03-20\n  Clone less.")
		);
		assert!(
			done
				.markdown
				.contains("  - **u/ferris** (OP) · 1 point\n    Agreed.")
		);
		assert!(
			done
				.markdown
				.contains("  - *… 4 more replies*\n- *… 13 more comments*")
		);
	}

	#[test]
	fn a_blocked_focused_thread_can_use_the_mirror_then_the_archive() {
		let url = "https://old.reddit.com/r/rust/comments/abc123/borrow_checker_tips/def456/";
		let mirror = r#"<div class="post highlighted">
			<div class="post_header"><a class="post_subreddit">r/rust</a><a class="post_author">u/ferris</a>
			<span class="created" title="Mar 19 2026, 10:16:44 UTC">Mar 19 '26</span></div>
			<h1 class="post_title"><a class="post_flair">Discussion</a> Borrow checker tips</h1>
			<a id="post_url" href="https://blog.example/borrowck">Blog</a>
			<div class="post_body"><div class="md"><p>Share your <strong>tricks</strong>.</p></div></div>
			<div class="post_score" title="42">42</div></div>
			<div class="thread"><div class="comment"><details class="comment_right" open>
			<summary class="comment_data"><a class="comment_author op">u/ferris</a></summary>
			<div class="comment_body"><div class="md"><p>Agreed.</p></div></div></details></div></div>"#;
		for archive in [false, true] {
			let done = run(url, |request| match request.url.as_str() {
				"https://www.reddit.com/r/rust/comments/abc123/_/def456/.json?raw_json=1" => Fetched::status(403),
				"https://safereddit.com/r/rust/comments/abc123/_/def456" => {
					Fetched::text("text/html", if archive { "<title>Blocked</title>" } else { mirror })
				},
				"https://arctic-shift.photon-reddit.com/api/posts/ids?ids=abc123" if archive => Fetched::json(&json!({"data": [post()]})),
				"https://arctic-shift.photon-reddit.com/api/comments/tree?link_id=abc123&limit=500&parent_id=t1_def456" if archive => {
					Fetched::json(&json!({"data": comments()}))
				},
				other => panic!("unexpected {other}"),
			})
			.unwrap();
			assert!(done.markdown.contains("## Comment thread"));
			if archive {
				assert_eq!(done.notes, [ARCHIVE_NOTE]);
				assert!(done.markdown.contains("Clone less."));
			} else {
				assert_eq!(done.notes, [MIRROR_NOTE]);
				assert!(
					done
						.markdown
						.contains("**r/rust** · u/ferris · 42 points · 2026-03-19 · [Discussion]")
				);
				assert!(done.markdown.contains(
					"**Link:** https://blog.example/borrowck\n\n---\n\nShare your **tricks**."
				));
				assert!(done.markdown.contains("- **u/ferris** (OP)\n  Agreed."));
			}
		}
	}

	#[test]
	fn feeds_and_exhausted_fallbacks_leave_the_page_to_the_reader() {
		assert_eq!(run("https://www.reddit.com/r/rust/.rss", |_| panic!("no fetch expected")), None);
		assert_eq!(
			run("https://www.reddit.com/r/rust/new?t=day&raw_json=0", |request| {
				assert!(matches!(request.url.as_str(),
				"https://www.reddit.com/r/rust/new/.json?t=day&raw_json=1" |
				"https://safereddit.com/r/rust/new?t=day&raw_json=0" |
				"https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=rust&sort=desc&limit=25"
			));
				Fetched::status(503)
			}),
			None
		);
	}
}
