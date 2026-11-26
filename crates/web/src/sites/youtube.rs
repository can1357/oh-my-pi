//! `YouTube` videos: Parallel excerpts when selected, otherwise player metadata
//! and English captions from `YouTube` itself.

use std::{borrow::Cow, fmt::Write as _};

use serde_json::{Value, json};
use url::{Url, form_urlencoded};

use super::{
	Action, Context, Done, Fetch, Fetched, Site, arr_of, fetch, format_number, iso_date, u64_of,
};
use crate::{reader::Response, remote};

/// Registry entry.
pub const SITE: Site = Site { name: "youtube", open };

const PLAYER: &str = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const WATCH: &str = "https://www.youtube.com/watch";
const METHOD: &str = "youtube";
const DESCRIPTION_LIMIT: usize = 1000;

const fn id_byte(byte: u8) -> bool {
	byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
}

fn video_id(url: &Url) -> Option<Cow<'_, str>> {
	let host = url.host_str()?;
	let host = host.strip_prefix("www.").unwrap_or(host);
	let mut path = url.path_segments()?;
	let first = path.next()?;
	if matches!(host, "youtube.com" | "m.youtube.com") {
		if url.path() == "/watch" {
			return url
				.query_pairs()
				.find(|(key, _)| key == "v")
				.map(|(_, id)| id)
				.filter(|id| !id.is_empty());
		}
		if matches!(first, "v" | "embed") {
			let id = path.next()?.get(..11)?;
			return id.bytes().all(id_byte).then_some(Cow::Borrowed(id));
		}
	}
	let id = match (host, first) {
		("youtube.com", "shorts") => path.next()?,
		("youtu.be", _) => first,
		_ => return None,
	};
	(id.len() == 11 && id.bytes().all(id_byte)).then_some(Cow::Borrowed(id))
}

fn open(url: &Url, context: &Context) -> Option<Action> {
	let id = video_id(url)?.into_owned();
	let mut canonical = Url::parse(WATCH).ok()?;
	canonical.query_pairs_mut().append_pair("v", &id);
	if matches!(context.setting("providers.fetch").unwrap_or("auto"), "auto" | "parallel")
		&& let Some(backend) = context.remote(remote::Kind::Parallel)
		&& let Some(request) = remote::parallel_request(
			backend,
			&canonical,
			"Extract the main content of this YouTube video page",
		) {
		let request = Fetch {
			url:       request.url,
			method:    "POST",
			headers:   request.headers,
			body:      request.body,
			max_bytes: request.max_bytes,
		};
		return fetch(request, move |reply, _| {
			let response = Response {
				status:    reply.status,
				url:       reply.url,
				headers:   reply.headers,
				body:      reply.body,
				truncated: reply.truncated,
				error:     None,
			};
			if let Some(content) = remote::parse(remote::Kind::Parallel, &response) {
				return Done::new(content, "parallel")
					.url(canonical)
					.note("Used Parallel extract for YouTube")
					.finish();
			}
			players(id, canonical)
		});
	}
	players(id, canonical)
}

fn player(id: &str, name: &str, version: &str, agent: &str) -> Fetch {
	Fetch::post_json(
		PLAYER,
		&json!({
			"context": { "client": { "clientName": name, "clientVersion": version, "hl": "en" } },
			"videoId": id,
		}),
	)
	.header("User-Agent", agent)
}

fn json_reply(reply: &Fetched) -> Value {
	if reply.truncated || !reply.ok() {
		Value::Null
	} else {
		reply.json_value().unwrap_or_default()
	}
}

fn players(id: String, canonical: Url) -> Option<Action> {
	// The web client supplies the upload date, Android has usable timed-text
	// URLs.
	fetch(player(&id, "WEB", "2.20251120.01.00", "Mozilla/5.0"), move |reply, _| {
		let mut web = json_reply(&reply);
		let android = player(
			&id,
			"ANDROID",
			"20.10.38",
			"com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip",
		);
		let uploaded = web
			.pointer_mut("/microformat/playerMicroformatRenderer/uploadDate")
			.map_or(Value::Null, Value::take);
		let web_details = web.get_mut("videoDetails").map_or(Value::Null, Value::take);
		fetch(android, move |reply, _| {
			let mut android = json_reply(&reply);
			let details = android
				.get("videoDetails")
				.filter(|details| !details.is_null())
				.unwrap_or(&web_details);
			let done = summary(&id, canonical, details, uploaded.as_str().and_then(iso_date))?;
			let tracks = android
				.pointer_mut("/captions/playerCaptionsTracklistRenderer/captionTracks")
				.and_then(|tracks| tracks.as_array_mut().map(std::mem::take))
				.unwrap_or_default();
			captions(done, tracks, false, 0)
		})
	})
}

fn caption_url(track: &Value, automatic: bool) -> Option<Url> {
	let is_automatic = track.get("kind").and_then(Value::as_str) == Some("asr");
	let language = track.get("languageCode")?.as_str()?.split('-').next()?;
	if is_automatic != automatic || !language.eq_ignore_ascii_case("en") {
		return None;
	}
	let mut url = Url::parse(track.get("baseUrl")?.as_str()?).ok()?;
	if url.scheme() != "https"
		|| url.host_str() != Some("www.youtube.com")
		|| url.port_or_known_default() != Some(443)
		|| !url.username().is_empty()
		|| url.password().is_some()
		|| url.path() != "/api/timedtext"
	{
		return None;
	}
	// URLSearchParams.set: keep the argument order and remove duplicate fmt
	// values.
	let mut query = form_urlencoded::Serializer::new(String::new());
	let mut found = false;
	for (key, value) in url.query_pairs() {
		if key == "fmt" {
			if !found {
				query.append_pair("fmt", "json3");
				found = true;
			}
		} else {
			query.append_pair(&key, &value);
		}
	}
	if !found {
		query.append_pair("fmt", "json3");
	}
	url.set_query(Some(&query.finish()));
	Some(url)
}

fn summary(id: &str, canonical: Url, details: &Value, uploaded: Option<&str>) -> Option<Done> {
	let text = |key| details.get(key)?.as_str().filter(|value| !value.is_empty());
	let title = text("title")?;
	let mut md = format!("# {title}\n\n");
	if let Some(channel) = text("author") {
		let _ = writeln!(md, "**Channel:** {channel}");
	}
	if let Some(date) = uploaded {
		let _ = writeln!(md, "**Uploaded:** {date}");
	}
	if let Some(total) = u64_of(details, "lengthSeconds").filter(|seconds| *seconds > 0) {
		let (hours, minutes, seconds) = (total / 3600, total % 3600 / 60, total % 60);
		if hours > 0 {
			let _ = writeln!(md, "**Duration:** {hours}:{minutes:02}:{seconds:02}");
		} else {
			let _ = writeln!(md, "**Duration:** {minutes}:{seconds:02}");
		}
	}
	if let Some(views) = u64_of(details, "viewCount").filter(|views| *views > 0) {
		let _ = writeln!(md, "**Views:** {}", format_number(views as f64));
	}
	let _ = write!(md, "**Video ID:** {id}\n\n");
	if let Some(description) = text("shortDescription") {
		md.push_str("---\n\n## Description\n\n");
		let end = description_cut(description);
		md.push_str(&description[..end]);
		if end < description.len() {
			md.push('…');
		}
		md.push_str("\n\n");
	}
	Some(Done::new(md, METHOD).title(title).url(canonical))
}

/// Match the TS UTF-16 limit without splitting a Unicode scalar value.
fn description_cut(text: &str) -> usize {
	if text.len() > DESCRIPTION_LIMIT {
		let mut units = 0;
		for (index, ch) in text.char_indices() {
			units += ch.len_utf16();
			if units > DESCRIPTION_LIMIT {
				return index;
			}
		}
	}
	text.len()
}

fn captions(
	mut done: Done,
	tracks: Vec<Value>,
	mut automatic: bool,
	mut next: usize,
) -> Option<Action> {
	// Try manually authored English tracks in order before automatic ones.
	let url = 'find: loop {
		for track in &tracks[next..] {
			next += 1;
			if let Some(url) = caption_url(track, automatic) {
				break 'find url;
			}
		}
		if automatic {
			done
				.markdown
				.push_str("---\n\n*No transcript available for this video.*\n");
			return done.note("No subtitles/captions available").finish();
		}
		automatic = true;
		next = 0;
	};
	fetch(Fetch::get(url).accept_json(), move |reply, _| {
		let data = json_reply(&reply);
		let text = transcript(&data);
		if text.is_empty() {
			return captions(done, tracks, automatic, next);
		}
		let (source, note) = if automatic {
			("auto-generated", "Using auto-generated captions")
		} else {
			("manual", "Using manual subtitles")
		};
		let _ = writeln!(done.markdown, "---\n\n## Transcript ({source})\n\n{text}");
		done.note(note).finish()
	})
}

fn transcript(data: &Value) -> String {
	let mut out = String::new();
	let mut previous = String::new();
	let mut line = String::new();
	for event in arr_of(data, "events") {
		line.clear();
		let mut space = false;
		let segments = arr_of(event, "segs")
			.iter()
			.filter_map(|seg| seg.get("utf8")?.as_str());
		for ch in segments.flat_map(str::chars) {
			// ECMAScript `\s` includes BOM but not NEL.
			if (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{feff}' {
				space = !line.is_empty();
			} else {
				if space {
					line.push(' ');
					space = false;
				}
				line.push(ch);
			}
		}
		if !line.is_empty() && line != previous {
			if !out.is_empty() {
				out.push(' ');
			}
			out.push_str(&line);
			std::mem::swap(&mut line, &mut previous);
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::{
		super::testing::{Setup, run, run_with},
		*,
	};

	const ID: &str = "abcdefghijk";
	const VIDEO: &str = "https://www.youtube.com/watch?v=abcdefghijk";
	const PARALLEL: &str = "https://parallel.test/v1beta/extract";

	fn configure_parallel(setup: &mut Setup, preference: &str) {
		setup.remote.push(remote::Backend {
			kind:     remote::Kind::Parallel,
			api_key:  Some("parallel-token".into()),
			base_url: Some("https://parallel.test".into()),
		});
		setup
			.settings
			.push(("providers.fetch".into(), preference.into()));
	}

	#[test]
	fn parallel_extracts_the_canonical_video_first_without_calling_the_players() {
		let first = "This is a readable excerpt from the video page, including an explanation of \
		             the topic and the author's perspective.";
		let mut count = 0;
		let done = run_with("https://youtu.be/abcdefghijk?t=4", |s| configure_parallel(s, "parallel"), |request| {
			count += 1;
			assert_eq!((request.method, request.url.as_str()), ("POST", PARALLEL));
			assert!(request.headers.iter().any(|(k, v)| k == "x-api-key" && v == "parallel-token"));
			let body: Value = serde_json::from_slice(request.body.as_deref().unwrap()).unwrap();
			assert_eq!(body, json!({ "urls": [VIDEO], "objective": "Extract the main content of this YouTube video page", "excerpts": true, "full_content": false }));
			Fetched::json(&json!({ "results": [{ "url": VIDEO, "excerpts": [first, "Another paragraph."], "full_content": "Not preferred." }] }))
		}).unwrap();
		assert_eq!(count, 1);
		assert_eq!(done.method, "parallel");
		assert_eq!(done.url.as_deref(), Some(VIDEO));
		assert_eq!(done.markdown, format!("{first}\n\nAnother paragraph."));
		assert_eq!(done.notes, ["Used Parallel extract for YouTube"]);
	}

	fn assert_player(request: &Fetch, name: &str, version: &str, agent: &str) {
		assert_eq!((request.method, request.url.as_str()), ("POST", PLAYER));
		assert!(
			request
				.headers
				.iter()
				.any(|(k, v)| k == "User-Agent" && v == agent)
		);
		let body: Value = serde_json::from_slice(request.body.as_deref().unwrap()).unwrap();
		assert_eq!(
			body,
			json!({ "context": { "client": { "clientName": name, "clientVersion": version, "hl": "en" } }, "videoId": ID })
		);
	}

	#[test]
	fn short_parallel_content_falls_back_to_player_metadata_and_manual_english_captions() {
		let mut step = 0;
		let done = run_with("https://m.youtube.com/watch?v=abcdefghijk&list=playlist", |s| configure_parallel(s, "auto"), |request| {
			step += 1;
			match step {
				1 => {
					assert_eq!(request.url, PARALLEL);
					Fetched::json(&json!({ "results": [{ "url": VIDEO, "excerpts": ["Too short."] }] }))
				},
				2 => {
					assert_player(request, "WEB", "2.20251120.01.00", "Mozilla/5.0");
					Fetched::json(&json!({
						"videoDetails": { "title": "Fallback title" },
						"microformat": { "playerMicroformatRenderer": { "uploadDate": "2025-11-20T10:44:23Z" } },
					}))
				},
				3 => {
					assert_player(request, "ANDROID", "20.10.38", "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip");
					Fetched::json(&json!({
						"videoDetails": {
							"title": "Example video", "author": "Example channel", "lengthSeconds": "3665",
							"viewCount": "1400", "shortDescription": "A short description.",
						},
						"captions": { "playerCaptionsTracklistRenderer": { "captionTracks": [
							{ "languageCode": "EN", "kind": "asr", "baseUrl": "https://www.youtube.com/api/timedtext?track=asr" },
							{ "languageCode": "en", "baseUrl": "https://example.test/api/timedtext?track=wrong-host" },
							{ "languageCode": "en", "baseUrl": "https://www.youtube.com:444/api/timedtext?track=wrong-port" },
							{ "languageCode": "en", "baseUrl": "https://www.youtube.com/api/timedtext?track=empty" },
							{ "languageCode": "fr", "baseUrl": "https://www.youtube.com/api/timedtext?track=fr" },
							{ "languageCode": "en-GB", "baseUrl": "https://www.youtube.com/api/timedtext?fmt=srv3&track=manual&fmt=vtt" },
						] } },
					}))
				},
				4 => {
					assert_eq!(request.url, "https://www.youtube.com/api/timedtext?track=empty&fmt=json3");
					Fetched::status(404)
				},
				5 => {
					assert_eq!((request.method, request.url.as_str()), ("GET", "https://www.youtube.com/api/timedtext?fmt=json3&track=manual"));
					Fetched::json(&json!({ "events": [
						{ "segs": [{ "utf8": "  Wel" }, { "utf8": "come   back!\n" }] },
						{ "segs": [{ "utf8": "Welcome back!" }] },
						{},
						{ "segs": [{ "utf8": "This is the video." }] },
					] }))
				},
				_ => panic!("unexpected fetch to {}", request.url),
			}
		}).unwrap();
		assert_eq!(step, 5);
		assert_eq!(done.method, "youtube");
		assert_eq!(done.url.as_deref(), Some(VIDEO));
		assert_eq!(done.notes, ["Using manual subtitles"]);
		assert_eq!(
			done.markdown,
			"# Example video\n\n**Channel:** Example channel\n**Uploaded:** \
			 2025-11-20\n**Duration:** 1:01:05\n**Views:** 1.4K\n**Video ID:** \
			 abcdefghijk\n\n---\n\n## Description\n\nA short description.\n\n---\n\n## Transcript \
			 (manual)\n\nWelcome back! This is the video.\n"
		);
	}

	#[test]
	fn local_preference_skips_parallel_and_keeps_web_metadata_when_android_fails() {
		let mut count = 0;
		let done = run_with(
			"https://www.youtube.com/shorts/abcdefghijk",
			|s| configure_parallel(s, "local"),
			|request| {
				count += 1;
				assert_eq!(request.url, PLAYER);
				if count == 1 {
					return Fetched::json(&json!({ "videoDetails": { "title": "WEB title" } }));
				}
				Fetched::status(503)
			},
		)
		.unwrap();
		assert_eq!(count, 2);
		assert_eq!(done.notes, ["No subtitles/captions available"]);
		assert_eq!(
			done.markdown,
			"# WEB title\n\n**Video ID:** abcdefghijk\n\n---\n\n*No transcript available for this \
			 video.*\n"
		);
	}

	#[test]
	fn nonvideo_urls_and_unavailable_players_decline() {
		// Other handlers may probe `/@name`; only the YouTube handler must
		// decline it.
		let channel = Url::parse("https://www.youtube.com/@channel").unwrap();
		assert!((SITE.open)(&channel, &Context::default()).is_none());
		assert_eq!(run("https://youtu.be/not-a-video-id", |_| panic!("no player fetch")), None);
		assert_eq!(run(VIDEO, |_| Fetched::status(503)), None);
	}
}
