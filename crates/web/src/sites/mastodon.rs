//! Mastodon statuses and profiles via their instance's public API. The generic
//! `/@user` path does not identify the platform, so probe the instance first.

use std::fmt::{self, Write as _};

use jiff::{Timestamp, tz::TimeZone};
use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, NEGATIVE_PROBE_TTL_SECS, Site, arr_of, f64_of, fetch,
	format_number, html_to_markdown, is_conclusive_probe_status, segment, str_of, u64_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "mastodon", open };

const RECENT_POSTS: usize = 5;

enum Target {
	Status(String),
	Profile(String),
}

fn open(url: &Url, context: &Context) -> Option<Action> {
	if !matches!(url.scheme(), "http" | "https") {
		return None;
	}
	let path = url.path().strip_prefix("/@")?;
	let (name, status) = match path.split_once('/') {
		Some((name, id)) if !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) => {
			(name, Some(id))
		},
		None => (path, None),
		_ => return None,
	};
	if name.is_empty() {
		return None;
	}
	let key = format!("mastodon:{}", url.origin().ascii_serialization());
	let cached = context.cache_get(&key);
	if cached.as_deref() == Some("no") {
		return None;
	}
	let instance = url.host_str()?.to_owned();
	let target = match status {
		Some(id) => Target::Status(format!("https://{instance}/api/v1/statuses/{id}")),
		None => Target::Profile(format!(
			"https://{instance}/api/v1/accounts/lookup?acct={}",
			segment(name),
		)),
	};
	if cached.as_deref() == Some("yes") {
		return read(instance, target);
	}
	fetch(
		Fetch::get(format!("https://{instance}/api/v1/instance")).accept_json(),
		move |reply, context| {
			let verdict = if reply.ok() {
				reply.json_value().is_some_and(|data| {
					["uri", "domain", "title"]
						.into_iter()
						.filter_map(|key| data.get(key))
						.any(|field| match field {
							Value::Null => false,
							Value::Bool(b) => *b,
							Value::Number(n) => n.as_f64() != Some(0.0),
							Value::String(s) => !s.is_empty(),
							_ => true,
						})
				})
			} else if is_conclusive_probe_status(reply.status) {
				false
			} else {
				return None;
			};
			if verdict {
				context.cache_put(&key, "yes".to_owned(), u64::MAX);
				read(instance, target)
			} else {
				context.cache_put(&key, "no".to_owned(), NEGATIVE_PROBE_TTL_SECS);
				None
			}
		},
	)
}

fn read(instance: String, target: Target) -> Option<Action> {
	match target {
		Target::Status(url) => status(instance, url),
		Target::Profile(url) => profile(instance, url),
	}
}

fn status(instance: String, url: String) -> Option<Action> {
	fetch(Fetch::get(url).accept_json(), move |reply, _| {
		let status = reply.json_value()?;
		let name = display_name(status.get("account")?)?;
		let title = format!("Post by {name}");
		let mut md = String::new();
		if let Some(boosted) = status.get("reblog").filter(|value| !value.is_null()) {
			let _ = write!(md, "🔁 **{name}** boosted:\n\n");
			write_status(&mut md, boosted)?;
		} else {
			let _ = write!(md, "# {title}\n\n");
			write_status(&mut md, &status)?;
		}
		mastodon_done(md, &instance, &status).title(title).finish()
	})
}

fn write_status(md: &mut String, status: &Value) -> Option<()> {
	let account = status.get("account")?;
	let acct = str_of(account, "acct")?;
	let content = status.get("content")?.as_str()?;
	let bot = if flag(account, "bot") { " 🤖" } else { "" };
	let _ = write!(md, "**@{acct}**{bot} · {}", date(status));
	if let Some(visibility) =
		str_of(status, "visibility").filter(|&visibility| visibility != "public")
	{
		let _ = write!(md, " · {visibility}");
	}
	md.push_str("\n\n");
	if let Some(spoiler) = str_of(status, "spoiler_text") {
		let _ = write!(md, "> ⚠️ **CW:** {spoiler}\n\n");
	}
	let _ = write!(md, "{}\n\n", html_to_markdown(content, None));

	if let Some(poll) = status.get("poll").filter(|poll| poll.is_object()) {
		let total = count(poll, "votes_count");
		md.push_str("**Poll:**\n");
		for option in arr_of(poll, "options") {
			let votes = count(option, "votes_count");
			let title = str_of(option, "title").unwrap_or_default();
			if total == 0 {
				let _ = writeln!(md, "- {title} (0%, {votes} votes)");
			} else {
				let percent = votes as f64 / total as f64 * 100.0;
				let _ = writeln!(md, "- {title} ({percent:.1}%, {votes} votes)");
			}
		}
		let closed = if flag(poll, "expired") {
			" (closed)"
		} else {
			""
		};
		let _ = write!(md, "Total: {total} votes{closed}\n\n");
	}
	let attachments = status.get("media_attachments")?.as_array()?;
	if !attachments.is_empty() {
		md.push_str("**Attachments:**\n");
		for media in attachments {
			let kind = str_of(media, "type").unwrap_or_default();
			let url = str_of(media, "url").unwrap_or_default();
			let _ = write!(md, "- [{kind}]({url})");
			if let Some(description) = str_of(media, "description") {
				let _ = write!(md, " - {description}");
			}
			md.push('\n');
		}
		md.push('\n');
	}
	let _ = writeln!(
		md,
		"---\n💬 {} replies · 🔁 {} boosts · ⭐ {} favorites",
		compact(status, "replies_count"),
		compact(status, "reblogs_count"),
		compact(status, "favourites_count"),
	);
	Some(())
}

fn profile(instance: String, url: String) -> Option<Action> {
	fetch(Fetch::get(url).accept_json(), move |reply, _| {
		let account = reply.json_value()?;
		let id = segment(str_of(&account, "id")?);
		let title = display_name(&account)?;
		let mut done =
			mastodon_done(account_markdown(&account, title)?, &instance, &account).title(title);
		let recent = format!(
				"https://{instance}/api/v1/accounts/{id}/statuses?limit={RECENT_POSTS}&exclude_replies=true"
			);
		fetch(Fetch::get(recent).accept_json(), move |reply, _| {
			if let Some(data) = reply.json_value()
				&& let Some(posts) = data.as_array().filter(|posts| !posts.is_empty())
			{
				done.markdown.push_str("\n---\n\n## Recent Posts\n\n");
				for status in posts.iter().take(RECENT_POSTS) {
					let content = html_to_markdown(status.get("content")?.as_str()?, None);
					let _ = write!(
						done.markdown,
						"### {}\n\n{content}\n\n💬 {} · 🔁 {} · ⭐ {}\n\n",
						date(status),
						count(status, "replies_count"),
						count(status, "reblogs_count"),
						count(status, "favourites_count"),
					);
				}
			}
			done.finish()
		})
	})
}

fn account_markdown(account: &Value, name: &str) -> Option<String> {
	let acct = str_of(account, "acct")?;
	let bot = if flag(account, "bot") {
		" 🤖 Bot"
	} else {
		""
	};
	let mut md = format!("# {name}\n\n**@{acct}**{bot}\n\n");
	if let Some(note) = str_of(account, "note") {
		let bio = html_to_markdown(note, None);
		if !bio.is_empty() && Some(bio.as_str()) != str_of(account, "display_name") {
			let _ = write!(md, "{bio}\n\n");
		}
	}
	let _ = write!(
		md,
		"**Followers:** {} · **Following:** {} · **Posts:** {}\n\n**Joined:** {}\n**Profile:** {}\n",
		compact(account, "followers_count"),
		compact(account, "following_count"),
		compact(account, "statuses_count"),
		date(account),
		str_of(account, "url").unwrap_or_default(),
	);
	let fields = arr_of(account, "fields");
	if !fields.is_empty() {
		md.push_str("\n**Profile Fields:**\n");
		for field in fields {
			let name = str_of(field, "name").unwrap_or_default();
			let value = html_to_markdown(field.get("value")?.as_str()?, None);
			let _ = writeln!(md, "- **{name}:** {value}");
		}
	}
	Some(md)
}

fn mastodon_done(md: String, instance: &str, data: &Value) -> Done {
	let done = Done::new(md, "mastodon").note(format!("Fetched via Mastodon API ({instance})"));
	match str_of(data, "url") {
		Some(url) => done.url(url),
		None => done,
	}
}

fn display_name(account: &Value) -> Option<&str> {
	str_of(account, "display_name").or_else(|| str_of(account, "username"))
}

fn date(data: &Value) -> impl fmt::Display + '_ {
	fmt::from_fn(move |f| {
		if let Some(stamp) = str_of(data, "created_at").and_then(|s| s.parse::<Timestamp>().ok()) {
			// The reader has no local time zone; keep the API's dates in UTC.
			write!(
				f,
				"{}",
				stamp
					.to_zoned(TimeZone::UTC)
					.strftime("%b %-d, %Y, %I:%M %p")
			)
		} else {
			f.write_str("Invalid Date")
		}
	})
}

fn flag(data: &Value, key: &str) -> bool {
	data.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn count(data: &Value, key: &str) -> u64 {
	u64_of(data, key).unwrap_or(0)
}

fn compact(data: &Value, key: &str) -> String {
	format_number(f64_of(data, key).unwrap_or(0.0))
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{
		Cache, Fetched,
		testing::{run, run_with},
	};

	const START: u64 = 1_767_225_600_000;

	#[test]
	fn a_boost_renders_the_original_poll_and_media_but_keeps_the_boost_url() {
		let cache = Cache::isolated();
		let status = json!({
			"url": "https://other.test/@alice/1", "account": {"username": "alice", "acct": "alice"},
			"reblog": {
				"account": {"display_name": "Bob", "acct": "bob@other.test", "bot": true},
				"created_at": "2026-01-02T13:04:00Z", "visibility": "unlisted", "spoiler_text": "Spoiler",
				"content": "<p>Original content</p>", "replies_count": 2, "reblogs_count": 1300, "favourites_count": 4,
				"poll": {"votes_count": 4, "expired": true, "options": [{"title": "Yes", "votes_count": 1}]},
				"media_attachments": [{"type": "image", "url": "https://other.test/image.png", "description": "A chart"}]
			}
		});
		let done = run_with(
			"https://social.test/@alice/1",
			|setup| {
				setup.cache = cache.clone();
				setup.now_ms = START;
			},
			|request| {
				assert_eq!(request.headers, [("Accept".to_owned(), "application/json".to_owned())]);
				match request.url.as_str() {
					"https://social.test/api/v1/instance" => {
						Fetched::json(&json!({"uri": "social.test"}))
					},
					"https://social.test/api/v1/statuses/1" => Fetched::json(&status),
					other => panic!("unexpected URL: {other}"),
				}
			},
		)
		.unwrap();
		assert_eq!(done.method, "mastodon");
		assert_eq!(done.url.as_deref(), Some("https://other.test/@alice/1"));
		assert!(done.markdown.starts_with(
			"🔁 **alice** boosted:\n\n**@bob@other.test** 🤖 · Jan 2, 2026, 01:04 PM · unlisted"
		));
		assert!(
			done
				.markdown
				.contains("> ⚠️ **CW:** Spoiler\n\nOriginal content")
		);
		assert!(
			done
				.markdown
				.contains("Yes (25.0%, 1 votes)\nTotal: 4 votes (closed)")
		);
		assert!(
			done
				.markdown
				.contains("[image](https://other.test/image.png) - A chart")
		);
		assert!(
			done
				.markdown
				.contains("💬 2 replies · 🔁 1.3K boosts · ⭐ 4 favorites")
		);

		let mut fetched = false;
		assert_eq!(
			run_with(
				"https://social.test/@bob/2",
				|setup| {
					setup.cache = cache.clone();
					setup.now_ms = START + 86_400_000;
				},
				|request| {
					assert_eq!(request.url, "https://social.test/api/v1/statuses/2");
					fetched = true;
					Fetched::status(404)
				},
			),
			None
		);
		assert!(fetched, "a positive instance verdict must outlast negative TTLs");
	}

	#[test]
	fn a_profile_looks_up_the_remote_handle_and_shows_recent_posts_when_available() {
		let account = json!({
			"id": "100", "username": "alice", "acct": "alice@remote.test", "display_name": "Alice",
			"note": "<p>Personal bio</p>", "followers_count": 14000, "following_count": 3, "statuses_count": 40,
			"created_at": "2026-01-02T00:00:00Z", "url": "https://remote.test/@alice",
			"fields": [{"name": "Pronouns", "value": "<p>she/her</p>"}]
		});
		let recent = Fetched::json(&json!([{
			"created_at": "2026-01-03T00:00:00Z", "content": "<p>Recent activity</p>",
			"replies_count": 2, "reblogs_count": 3, "favourites_count": 4,
		}]));
		for (statuses, section_expected) in [(recent, true), (Fetched::status(503), false)] {
			let done =
				run("https://social.test/@alice@remote.test", |request| match request.url.as_str() {
					"https://social.test/api/v1/instance" => Fetched::json(&json!({"title": "Social"})),
					"https://social.test/api/v1/accounts/lookup?acct=alice%40remote.test" => {
						Fetched::json(&account)
					},
					"https://social.test/api/v1/accounts/100/statuses?limit=5&exclude_replies=true" => {
						statuses.clone()
					},
					other => panic!("unexpected URL: {other}"),
				})
				.unwrap();
			assert_eq!(done.url.as_deref(), Some("https://remote.test/@alice"));
			assert!(
				done
					.markdown
					.contains("**@alice@remote.test**\n\nPersonal bio")
			);
			assert!(
				done
					.markdown
					.contains("**Followers:** 14K · **Following:** 3 · **Posts:** 40")
			);
			assert!(done.markdown.contains("- **Pronouns:** she/her"));
			assert_eq!(done.markdown.contains("## Recent Posts"), section_expected);
			if section_expected {
				assert!(
					done
						.markdown
						.contains("Recent activity\n\n💬 2 · 🔁 3 · ⭐ 4")
				);
			}
		}
	}

	#[test]
	fn a_negative_instance_probe_is_retried_at_the_ten_minute_boundary() {
		let cache = Cache::isolated();
		for (id, elapsed, expected_calls) in [(1, 0, 1), (2, 599_999, 0), (3, 600_000, 1)] {
			let mut calls = 0;
			let done = run_with(
				&format!("https://no-instance.test/@alice/{id}"),
				|setup| {
					setup.cache = cache.clone();
					setup.now_ms = START + elapsed;
				},
				|request| {
					calls += 1;
					assert_eq!(request.url, "https://no-instance.test/api/v1/instance");
					Fetched::status(404)
				},
			);
			assert_eq!(done, None);
			assert_eq!(calls, expected_calls);
		}
	}

	#[test]
	fn a_server_error_does_not_memoize_a_negative_instance_verdict() {
		let cache = Cache::isolated();
		let mut calls = 0;
		for now in [START, START + 1] {
			let done = run_with(
				"https://unavailable.test/@alice/1",
				|setup| {
					setup.cache = cache.clone();
					setup.now_ms = now;
				},
				|request| {
					assert_eq!(request.url, "https://unavailable.test/api/v1/instance");
					calls += 1;
					Fetched::status(503)
				},
			);
			assert_eq!(done, None);
		}
		assert_eq!(calls, 2);
	}

	#[test]
	fn a_status_path_requires_a_numeric_id() {
		assert_eq!(
			run("https://social.test/@alice/not-a-status", |_| panic!("no fetch expected")),
			None
		);
	}
}
