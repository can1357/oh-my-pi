//! Vimeo (`vimeo.com`, `player.vimeo.com`): video metadata from the oEmbed API,
//! plus the available progressive qualities from the player config when it
//! answers.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, fetch, segment, str_of, u64_of};

/// Registry entry.
pub const SITE: Site = Site { name: "vimeo", open };

const METHOD: &str = "vimeo";
/// Qualities listed from the player config.
const QUALITIES: usize = 5;

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !url.host_str()?.contains("vimeo.com") {
		return None;
	}
	let id = video_id(url)?;
	let canonical = format!("https://vimeo.com/{id}");
	let oembed = format!("https://vimeo.com/api/oembed.json?url={}", segment(&canonical));
	fetch(Fetch::get(oembed), move |reply, _| {
		let data = reply.json_value()?;
		let mut md = format!("# {}\n\n", str_of(&data, "title").unwrap_or_default());
		let _ = writeln!(
			md,
			"**Author:** [{}]({})",
			str_of(&data, "author_name").unwrap_or_default(),
			str_of(&data, "author_url").unwrap_or_default()
		);
		let _ = writeln!(md, "**Duration:** {}", duration(u64_of(&data, "duration").unwrap_or(0)));
		if let Some(uploaded) = str_of(&data, "upload_date") {
			let _ = writeln!(md, "**Uploaded:** {uploaded}");
		}
		let _ = writeln!(md, "**Video ID:** {id}\n");
		if let Some(description) = str_of(&data, "description") {
			let _ = writeln!(md, "---\n\n## Description\n\n{description}\n");
		}
		let _ = write!(
			md,
			"---\n\n**Thumbnail:** {}\n",
			str_of(&data, "thumbnail_url").unwrap_or_default()
		);

		let config = format!("https://player.vimeo.com/video/{id}/config");
		fetch(Fetch::get(config), move |reply, _| {
			if let Some(config) = reply.json_value() {
				let progressive = config
					.pointer("/request/files/progressive")
					.and_then(Value::as_array)
					.map_or_default(Vec::as_slice);
				if !progressive.is_empty() {
					md.push_str("\n**Available Qualities:**\n");
					for quality in progressive.iter().take(QUALITIES) {
						let _ = writeln!(
							md,
							"- {}: {}x{} @ {}fps",
							str_of(quality, "quality").unwrap_or_default(),
							u64_of(quality, "width").unwrap_or(0),
							u64_of(quality, "height").unwrap_or(0),
							u64_of(quality, "fps").unwrap_or(0)
						);
					}
				}
			}
			Done::new(md, METHOD)
				.note("Fetched via Vimeo oEmbed API")
				.finish()
		})
	})
}

/// The video id of a Vimeo URL: `/video/<id>` on the player host, or the last
/// all-digit path segment on `vimeo.com`.
fn video_id(url: &Url) -> Option<String> {
	if url.host_str()? == "player.vimeo.com" {
		return url
			.path()
			.strip_prefix("/video/")?
			.split('/')
			.next()
			.filter(|id| all_digits(id))
			.map(str::to_owned);
	}
	url.path_segments()?
		.rfind(|part| !part.is_empty())
		.filter(|id| all_digits(id))
		.map(str::to_owned)
}

fn all_digits(text: &str) -> bool {
	!text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// `H:MM:SS` past an hour, else `M:SS`.
fn duration(total: u64) -> String {
	let (hours, minutes, secs) = (total / 3600, total % 3600 / 60, total % 60);
	if hours > 0 {
		format!("{hours}:{minutes:02}:{secs:02}")
	} else {
		format!("{minutes}:{secs:02}")
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::{
		super::{Fetched, testing::run},
		*,
	};

	fn oembed() -> Value {
		json!({
			"title": "Test Video", "author_name": "Alice", "author_url": "https://vimeo.com/alice",
			"description": "A description", "duration": 125,
			"thumbnail_url": "https://i.vimeocdn.com/x.jpg", "upload_date": "2020-01-02 03:04:05", "video_id": 1_084_537
		})
	}

	#[test]
	fn a_video_reads_oembed_and_the_player_config() {
		let mut requests = Vec::new();
		let done = run("https://vimeo.com/1084537", |request| {
			requests.push(request.url.clone());
			if request.url.contains("/api/oembed.json") {
				Fetched::json(&oembed())
			} else {
				Fetched::json(&json!({ "request": { "files": { "progressive": [
					{ "quality": "hd", "width": 1920, "height": 1080, "fps": 30 },
					{ "quality": "sd", "width": 640, "height": 360, "fps": 30 }
				] } } }))
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fvimeo.com%2F1084537",
			"https://player.vimeo.com/video/1084537/config"
		]);
		assert_eq!(done.method, "vimeo");
		assert!(done.markdown.starts_with(
			"# Test Video\n\n**Author:** [Alice](https://vimeo.com/alice)\n**Duration:** 2:05\n**Uploaded:** 2020-01-02 03:04:05\n**Video ID:** 1084537\n\n---\n\n## Description\n\nA description\n\n---\n\n**Thumbnail:** https://i.vimeocdn.com/x.jpg\n\n**Available Qualities:**\n- hd: 1920x1080 @ 30fps\n- sd: 640x360 @ 30fps\n"
		));
	}

	#[test]
	fn the_player_and_profile_shapes_are_its_own() {
		for url in ["https://player.vimeo.com/video/1084537", "https://vimeo.com/staffpicks/1084537"]
		{
			let done = run(url, |request| {
				if request.url.contains("oembed") {
					Fetched::json(&oembed())
				} else {
					Fetched::status(404)
				}
			})
			.unwrap();
			assert_eq!(done.method, "vimeo");
			assert!(!done.markdown.contains("Available Qualities"));
		}
	}

	#[test]
	fn other_urls_and_api_failures_fall_through() {
		assert_eq!(run("https://example.com/1084537", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://vimeo.com/invalid", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://vimeo.com/1084537", |_| Fetched::status(404)), None);
	}
}
