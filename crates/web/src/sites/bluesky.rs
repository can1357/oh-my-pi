//! Bluesky (`bsky.app/profile/<handle>[/post/<rkey>]`): profile stats, or a
//! post with its parent and replies, from the public AT Protocol API. A post
//! needs two requests: the handle is resolved to a DID, then the thread is
//! read.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, f64_of, fetch, format_number, segment, str_of,
	u64_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "bluesky", open };

const API: &str = "https://public.api.bsky.app/xrpc";
const METHOD: &str = "bluesky-api";
/// Replies rendered under a post.
const REPLIES: usize = 10;

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "bsky.app" | "www.bsky.app") {
		return None;
	}
	let parts: Vec<&str> = url
		.path()
		.split('/')
		.filter(|part| !part.is_empty())
		.collect();
	if *parts.first()? != "profile" {
		return None;
	}
	let handle = *parts.get(1)?;
	if parts.get(2).copied() == Some("post")
		&& let Some(rkey) = parts.get(3)
	{
		return thread(handle, rkey);
	}
	profile(handle)
}

/// Profile stats from one `getProfile` request.
fn profile(handle: &str) -> Option<Action> {
	fetch(Fetch::get(actor_url(handle)).accept_json(), move |reply, _| {
		let profile = reply.json_value()?;
		let name = str_of(&profile, "displayName")
			.or_else(|| str_of(&profile, "handle"))
			.unwrap_or("Bluesky");
		let mut md = format!("# {name}\n\n");
		let _ = write!(md, "**@{}**\n\n", str_of(&profile, "handle").unwrap_or_default());
		if let Some(description) = str_of(&profile, "description") {
			let _ = write!(md, "{description}\n\n");
		}
		md.push_str("---\n\n");
		let _ = writeln!(md, "- **Followers:** {}", count(&profile, "followersCount"));
		let _ = writeln!(md, "- **Following:** {}", count(&profile, "followsCount"));
		let _ = writeln!(md, "- **Posts:** {}", count(&profile, "postsCount"));
		if let Some(created_at) = str_of(&profile, "createdAt") {
			let _ = writeln!(md, "- **Joined:** {}", long_date(created_at));
		}
		let _ = write!(md, "\n**DID:** `{}`\n", str_of(&profile, "did").unwrap_or_default());
		Done::new(md, METHOD)
			.title(name)
			.note("Fetched via AT Protocol API")
			.finish()
	})
}

/// A post with its parent and first replies; the handle is resolved first.
fn thread(handle: &str, rkey: &str) -> Option<Action> {
	let rkey = rkey.to_owned();
	fetch(Fetch::get(actor_url(handle)).accept_json(), move |reply, _| {
		let did = str_of(&reply.json_value()?, "did")?.to_owned();
		let at_uri = format!("at://{did}/app.bsky.feed.post/{rkey}");
		let url = format!(
			"{API}/app.bsky.feed.getPostThread?uri={}&depth=6&parentHeight=3",
			segment(&at_uri)
		);
		fetch(Fetch::get(url).accept_json(), move |reply, _| {
			let data = reply.json_value()?;
			let thread = data.get("thread")?;
			let post = thread.get("post")?;
			let mut md = String::from("# Bluesky Post\n\n");
			if let Some(parent) = thread.get("parent").and_then(|parent| parent.get("post")) {
				md.push_str("**Replying to:**\n");
				md.push_str(&format_post(parent, true));
				md.push_str("\n---\n\n");
			}
			md.push_str(&format_post(post, false));
			let replies = arr_of(thread, "replies");
			if !replies.is_empty() {
				md.push_str("\n---\n\n## Replies\n\n");
				for reply in replies
					.iter()
					.filter_map(|reply| reply.get("post"))
					.take(REPLIES)
				{
					md.push_str(&format_post(reply, false));
					md.push_str("\n---\n\n");
				}
			}
			Done::new(md, METHOD)
				.title("Bluesky Post")
				.note(format!("AT URI: {at_uri}"))
				.finish()
		})
	})
}

fn actor_url(handle: &str) -> String {
	format!("{API}/app.bsky.actor.getProfile?actor={}", segment(handle))
}

fn count(profile: &Value, key: &str) -> String {
	format_number(f64_of(profile, key).unwrap_or(0.0))
}

/// One post, quoted (parent, indented) or shown in full with its embeds, date
/// and stats.
fn format_post(post: &Value, quote: bool) -> String {
	let author = post.get("author");
	let name = author
		.and_then(|author| str_of(author, "displayName").or_else(|| str_of(author, "handle")))
		.unwrap_or_default();
	let handle = author
		.and_then(|author| str_of(author, "handle"))
		.unwrap_or_default();
	let record = post.get("record");
	let date = record
		.and_then(|record| str_of(record, "createdAt"))
		.map_or_else(String::new, concise_date);
	let text = record
		.and_then(|record| str_of(record, "text"))
		.unwrap_or_default();

	let mut md = String::new();
	if quote {
		let _ = write!(md, "> **{name}** (@{handle}) - {date}\n>\n");
		md.push_str(
			&text
				.lines()
				.map(|line| format!("> {line}"))
				.collect::<Vec<_>>()
				.join("\n"),
		);
		md.push('\n');
	} else {
		let _ = write!(md, "**{name}** (@{handle})\n*{date}*\n\n{text}\n");
	}

	if let Some(embed) = post.get("embed") {
		let kind = str_of(embed, "$type");
		if kind == Some("app.bsky.embed.external#view") {
			if let Some(external) = embed.get("external") {
				let uri = str_of(external, "uri").unwrap_or_default();
				let _ = write!(md, "\n📎 [{}]({uri})", str_of(external, "title").unwrap_or(uri));
				if let Some(description) = str_of(external, "description") {
					let _ = write!(md, "\n*{description}*");
				}
				md.push('\n');
			}
		} else if kind == Some("app.bsky.embed.images#view") {
			if let Some(images) = embed.get("images").and_then(Value::as_array) {
				let _ = write!(md, "\n🖼️ {} image(s)", images.len());
				for image in images {
					if let Some(alt) = str_of(image, "alt") {
						let _ = write!(md, "\n- Alt: \"{alt}\"");
					}
				}
				md.push('\n');
			}
		} else if matches!(
			kind,
			Some("app.bsky.embed.record#view" | "app.bsky.embed.recordWithMedia#view")
		) && let Some(record) = embed.get("record")
		{
			let quoted_text = record.get("value").and_then(|value| str_of(value, "text"));
			if let (Some(quoted_text), Some(author)) = (quoted_text, record.get("author")) {
				let handle = str_of(author, "handle");
				let name = str_of(author, "displayName").or(handle).unwrap_or_default();
				let handle = handle.unwrap_or_default();
				let _ = write!(md, "\n**Quoted post:**\n> **{name}** (@{handle})\n");
				md.push_str(
					&quoted_text
						.lines()
						.map(|line| format!("> {line}"))
						.collect::<Vec<_>>()
						.join("\n"),
				);
				md.push('\n');
			}
		}
	}

	if !quote {
		let stats =
			[("likeCount", "❤️"), ("repostCount", "🔁"), ("replyCount", "💬"), ("quoteCount", "📝")]
				.iter()
				.filter_map(|(key, emoji)| {
					let count = u64_of(post, key).filter(|count| *count > 0)?;
					Some(format!("{emoji} {}", format_number(count as f64)))
				})
				.collect::<Vec<_>>();
		if !stats.is_empty() {
			let _ = write!(md, "\n{}\n", stats.join(" • "));
		}
	}
	md
}

const MONTHS_SHORT: [&str; 12] =
	["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG: [&str; 12] = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/// `Month D, YYYY, HH:MM AM/PM` (UTC) of an ISO-8601 timestamp.
fn concise_date(text: &str) -> String {
	let Some((year, month, day, hour, minute)) = parts(text) else {
		return String::new();
	};
	let meridiem = if hour < 12 { "AM" } else { "PM" };
	let hour = if hour % 12 == 0 { 12 } else { hour % 12 };
	let month = MONTHS_SHORT[(month - 1) as usize];
	format!("{month} {day}, {year}, {hour:02}:{minute:02} {meridiem}")
}

/// `Month D, YYYY` of an ISO-8601 timestamp.
fn long_date(text: &str) -> String {
	let Some((year, month, day, ..)) = parts(text) else {
		return String::new();
	};
	let month = MONTHS_LONG[(month - 1) as usize];
	format!("{month} {day}, {year}")
}

/// `(year, month, day, hour, minute)` of an ISO-8601 timestamp.
fn parts(text: &str) -> Option<(i64, i64, i64, i64, i64)> {
	if text.len() < 16 {
		return None;
	}
	let number = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
	let year = number(0, 4)?;
	let month = number(5, 7).filter(|month| (1..=12).contains(month))?;
	let day = number(8, 10)?;
	let hour = number(11, 13)?;
	let minute = number(14, 16)?;
	Some((year, month, day, hour, minute))
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	fn profile() -> serde_json::Value {
		json!({
			"did": "did:plc:z72i7hdynmk6r22z27h6tvur", "handle": "bsky.app", "displayName": "Bluesky",
			"description": "The social network for the open web.", "followersCount": 1_234_567,
			"followsCount": 42, "postsCount": 3456, "createdAt": "2023-03-01T20:30:00.000Z"
		})
	}

	fn thread() -> serde_json::Value {
		json!({ "thread": {
			"$type": "app.bsky.feed.defs#threadViewPost",
			"post": {
				"uri": "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3k", "cid": "bafy",
				"author": { "did": "did:plc:z72i7hdynmk6r22z27h6tvur", "handle": "bsky.app", "displayName": "Bluesky" },
				"record": { "text": "Hello world\nSecond line", "createdAt": "2026-11-25T15:04:05.000Z" },
				"likeCount": 1500, "repostCount": 12, "replyCount": 0, "quoteCount": 3,
				"embed": {
					"$type": "app.bsky.embed.external#view",
					"external": { "uri": "https://bsky.social", "title": "Bluesky", "description": "The app" }
				}
			},
			"parent": { "post": {
				"author": { "handle": "alice.test", "displayName": "Alice" },
				"record": { "text": "Original post", "createdAt": "2026-11-25T14:00:00.000Z" }
			} },
			"replies": [
				{ "post": { "author": { "handle": "bob.test" }, "record": { "text": "Nice", "createdAt": "2026-11-25T15:10:00.000Z" } } },
				{ "$type": "app.bsky.feed.defs#notFoundPost" }
			]
		} })
	}

	#[test]
	fn a_profile_reads_one_get_profile_request() {
		let mut requests = Vec::new();
		let done = run("https://bsky.app/profile/bsky.app", |request| {
			requests.push(request.url.clone());
			Fetched::json(&profile())
		})
		.unwrap();
		assert_eq!(requests, [
			"https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=bsky.app"
		]);
		assert_eq!((done.method, done.title.as_deref()), ("bluesky-api", Some("Bluesky")));
		assert_eq!(done.notes, ["Fetched via AT Protocol API"]);
		assert!(done.markdown.starts_with(
			"# Bluesky\n\n**@bsky.app**\n\nThe social network for the open web.\n\n---\n\n- \
			 **Followers:** 1.2M\n- **Following:** 42\n- **Posts:** 3.5K\n- **Joined:** March 1, \
			 2023\n\n**DID:** `did:plc:z72i7hdynmk6r22z27h6tvur`\n"
		));
	}

	#[test]
	fn a_post_resolves_the_handle_then_reads_the_thread() {
		let mut requests = Vec::new();
		let done = run("https://bsky.app/profile/bsky.app/post/3k", |request| {
			requests.push(request.url.clone());
			if request.url.contains("getProfile") {
				Fetched::json(&profile())
			} else {
				Fetched::json(&thread())
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=bsky.app",
			"https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=at%3A%2F%2Fdid%3Aplc%3Az72i7hdynmk6r22z27h6tvur%2Fapp.bsky.feed.post%2F3k&depth=6&parentHeight=3"
		]);
		assert_eq!((done.method, done.title.as_deref()), ("bluesky-api", Some("Bluesky Post")));
		assert_eq!(done.notes, [
			"AT URI: at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3k"
		]);
		let md = &done.markdown;
		assert!(md.starts_with(
			"# Bluesky Post\n\n**Replying to:**\n> **Alice** (@alice.test) - Nov 25, 2026, 02:00 \
			 PM\n>\n> Original post\n\n---\n\n"
		));
		assert!(md.contains("**Bluesky** (@bsky.app)\n*Nov 25, 2026, 03:04 PM*\n\nHello world\nSecond line\n\n📎 [Bluesky](https://bsky.social)\n*The app*\n\n❤️ 1.5K • 🔁 12 • 📝 3\n"));
		assert!(
			md.contains("## Replies\n\n**bob.test** (@bob.test)\n*Nov 25, 2026, 03:10 PM*\n\nNice\n")
		);
		assert!(!md.contains("notFoundPost"));
		assert!(!md.contains("💬"));
	}

	#[test]
	fn a_quoted_post_renders_inside_a_post() {
		let quoted = json!({ "thread": { "post": {
			"author": { "handle": "bsky.app" }, "record": { "text": "Look", "createdAt": "2026-11-25T15:04:05Z" },
			"embed": { "$type": "app.bsky.embed.recordWithMedia#view", "record": {
				"author": { "handle": "carol.test", "displayName": "Carol" },
				"value": { "text": "Quoted\nbody" } } }
		} } });
		let done = run("https://bsky.app/profile/bsky.app/post/3k", |request| {
			if request.url.contains("getProfile") {
				Fetched::json(&profile())
			} else {
				Fetched::json(&quoted)
			}
		})
		.unwrap();
		assert!(done.markdown.contains(
			"**bsky.app** (@bsky.app)\n*Nov 25, 2026, 03:04 PM*\n\nLook\n\n**Quoted post:**\n> \
			 **Carol** (@carol.test)\n> Quoted\n> body\n"
		));
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://bsky.app/about", |_| panic!("no fetch expected")), None);
		assert_eq!(
			run("https://example.test/profile/bsky.app", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(run("https://bsky.app/profile/bsky.app", |_| Fetched::status(500)), None);
		assert_eq!(
			run("https://bsky.app/profile/bsky.app/post/3k", |request| {
				if request.url.contains("getProfile") {
					Fetched::json(&profile())
				} else {
					Fetched::status(404)
				}
			}),
			None
		);
	}
}
