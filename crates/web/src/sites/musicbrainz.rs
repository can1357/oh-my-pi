//! `MusicBrainz` (`musicbrainz.org`): artists, releases and recordings from the
//! WS/2 API. One request per entity; a release carries its media and tracks.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, fetch, str_of, u64_of};

/// Registry entry.
pub const SITE: Site = Site { name: "musicbrainz", open };

const METHOD: &str = "musicbrainz-api";
/// Tracks listed per medium before eliding.
const MAX_TRACKS: usize = 50;

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "musicbrainz.org" | "www.musicbrainz.org") {
		return None;
	}
	let mut segments = url.path_segments()?.filter(|segment| !segment.is_empty());
	let entity = segments.next()?;
	let mbid = segments.next()?;
	if !matches!(entity, "artist" | "release" | "recording") {
		return None;
	}
	if mbid.len() != 36
		|| !mbid
			.bytes()
			.all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
	{
		return None;
	}
	let entity = entity.to_owned();
	let suffix = match entity.as_str() {
		"artist" => "&inc=url-rels",
		"release" => "&inc=recordings",
		_ => "",
	};
	let api = format!("https://musicbrainz.org/ws/2/{entity}/{mbid}?fmt=json{suffix}");
	fetch(Fetch::get(api).accept_json(), move |reply, _| {
		let data = reply.json_value()?;
		let (title, markdown) = match entity.as_str() {
			"artist" => (str_of(&data, "name").unwrap_or_default().to_owned(), artist_markdown(&data)),
			"release" => {
				(str_of(&data, "title").unwrap_or_default().to_owned(), release_markdown(&data))
			},
			_ => (str_of(&data, "title").unwrap_or_default().to_owned(), recording_markdown(&data)),
		};
		Done::new(markdown, METHOD)
			.title(title)
			.note("Fetched via MusicBrainz API")
			.finish()
	})
}

/// Seconds as `H:MM:SS`, or `M:SS` under an hour.
fn media_duration(total_seconds: u64) -> String {
	let hours = total_seconds / 3600;
	let minutes = total_seconds % 3600 / 60;
	let seconds = total_seconds % 60;
	if hours > 0 {
		format!("{hours}:{minutes:02}:{seconds:02}")
	} else {
		format!("{minutes}:{seconds:02}")
	}
}

/// Milliseconds as a duration, ignoring zero and negative lengths.
fn duration_ms(length_ms: Option<u64>) -> Option<String> {
	let ms = length_ms.filter(|ms| *ms > 0)?;
	Some(media_duration((ms as f64 / 1000.0).round() as u64))
}

/// `begin - end`, `1987 - present`, `? - 1994` or `ended`/`present`.
fn life_span(life: &Value) -> Option<String> {
	let begin = str_of(life, "begin");
	let end = str_of(life, "end");
	match (begin, end) {
		(Some(begin), Some(end)) => Some(format!("{begin} - {end}")),
		(Some(begin), None) => {
			let tail = if life.get("ended").and_then(Value::as_bool) == Some(true) {
				"ended"
			} else {
				"present"
			};
			Some(format!("{begin} - {tail}"))
		},
		(None, Some(end)) => Some(format!("? - {end}")),
		(None, None) => match life.get("ended").and_then(Value::as_bool) {
			Some(true) => Some("ended".to_owned()),
			Some(false) => Some("present".to_owned()),
			None => None,
		},
	}
}

fn artist_credits(credits: &[Value]) -> Option<String> {
	let names: Vec<&str> = credits
		.iter()
		.filter_map(|credit| {
			str_of(credit, "name").or_else(|| credit.get("artist").and_then(|a| str_of(a, "name")))
		})
		.collect();
	(!names.is_empty()).then(|| names.join(", "))
}

fn format_track(track: &Value) -> String {
	let recording = track.get("recording");
	let title = str_of(track, "title")
		.or_else(|| recording.and_then(|r| str_of(r, "title")))
		.unwrap_or("Untitled");
	let number = str_of(track, "number").map(str::to_owned).or_else(|| {
		u64_of(track, "position")
			.filter(|position| *position > 0)
			.map(|position| position.to_string())
	});
	let mut line = match number {
		Some(number) => format!("{number}. {title}"),
		None => format!("- {title}"),
	};
	let length = u64_of(track, "length").or_else(|| recording.and_then(|r| u64_of(r, "length")));
	if let Some(duration) = duration_ms(length) {
		let _ = write!(line, " ({duration})");
	}
	line
}

/// `Disc 1 - CD` when there is more than one medium.
fn medium_label(medium: &Value, include_position: bool) -> Option<String> {
	let mut parts = Vec::new();
	if include_position
		&& let Some(position) = u64_of(medium, "position").filter(|position| *position > 0)
	{
		parts.push(format!("Disc {position}"));
	}
	if let Some(name) = str_of(medium, "format") {
		parts.push(name.to_owned());
	}
	(!parts.is_empty()).then(|| parts.join(" - "))
}

fn artist_markdown(artist: &Value) -> String {
	let mut md = format!("# {}\n\n", str_of(artist, "name").unwrap_or_default());
	let mut meta = Vec::new();
	if let Some(kind) = str_of(artist, "type") {
		meta.push(format!("**Type**: {kind}"));
	}
	if let Some(country) = str_of(artist, "country") {
		meta.push(format!("**Country**: {country}"));
	}
	if let Some(life) = artist.get("life-span").and_then(life_span) {
		meta.push(format!("**Life Span**: {life}"));
	}
	if !meta.is_empty() {
		let _ = writeln!(md, "{}", meta.join("\n"));
	}
	md
}

fn release_markdown(release: &Value) -> String {
	let mut md = format!("# {}\n\n", str_of(release, "title").unwrap_or_default());
	let media = arr_of(release, "media");
	let total = u64_of(release, "track-count").unwrap_or_else(|| {
		media
			.iter()
			.map(|medium| {
				u64_of(medium, "track-count").unwrap_or_else(|| arr_of(medium, "tracks").len() as u64)
			})
			.sum()
	});
	if total > 0 {
		let _ = write!(md, "**Tracks**: {total}\n\n");
	}
	if !media.is_empty() {
		md.push_str("## Tracks\n\n");
		let include_position = media.len() > 1;
		for medium in media {
			if let Some(label) = medium_label(medium, include_position) {
				let _ = write!(md, "### {label}\n\n");
			}
			let tracks = arr_of(medium, "tracks");
			if tracks.is_empty() {
				if let Some(count) = u64_of(medium, "track-count").filter(|count| *count > 0) {
					let _ = write!(md, "- {count} tracks (details unavailable)\n\n");
				}
			} else {
				let lines: Vec<String> = tracks.iter().take(MAX_TRACKS).map(format_track).collect();
				let _ = write!(md, "{}\n\n", lines.join("\n"));
				if tracks.len() > MAX_TRACKS {
					let _ = write!(md, "_Showing first {MAX_TRACKS} of {} tracks._\n\n", tracks.len());
				}
			}
		}
	}
	md
}

fn recording_markdown(recording: &Value) -> String {
	let mut md = format!("# {}\n\n", str_of(recording, "title").unwrap_or_default());
	let mut meta = Vec::new();
	if let Some(artists) = artist_credits(arr_of(recording, "artist-credit")) {
		meta.push(format!("**Artists**: {artists}"));
	}
	if let Some(length) = duration_ms(u64_of(recording, "length")) {
		meta.push(format!("**Length**: {length}"));
	}
	if !meta.is_empty() {
		let _ = writeln!(md, "{}", meta.join("\n"));
	}
	md
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::{
		super::{Fetched, testing::run},
		*,
	};

	#[test]
	fn an_artist_page_reads_the_api() {
		let artist = json!({
			"id": "5b11f4ce-a62d-471e-81fc-a69a8278c7da", "name": "Nirvana", "type": "Group", "country": "US",
			"life-span": { "begin": "1987", "end": "1994", "ended": true }
		});
		let mut requests = Vec::new();
		let done =
			run("https://musicbrainz.org/artist/5b11f4ce-a62d-471e-81fc-a69a8278c7da", |request| {
				requests.push(request.url.clone());
				Fetched::json(&artist)
			})
			.unwrap();
		assert_eq!(
			requests,
			["https://musicbrainz.org/ws/2/artist/5b11f4ce-a62d-471e-81fc-a69a8278c7da?fmt=json&inc=url-rels"]
		);
		assert_eq!((done.method, done.title.as_deref()), ("musicbrainz-api", Some("Nirvana")));
		assert_eq!(
			done.markdown,
			"# Nirvana\n\n**Type**: Group\n**Country**: US\n**Life Span**: 1987 - 1994\n"
		);
		assert_eq!(done.notes, ["Fetched via MusicBrainz API"]);
	}

	#[test]
	fn a_release_lists_media_tracks_and_elides_the_overflow() {
		let tracks: Vec<Value> = (1..=51)
			.map(
				|n| json!({ "number": n.to_string(), "title": format!("Track {n}"), "length": 60_000 }),
			)
			.collect();
		let release = json!({
			"id": "1", "title": "Nevermind",
			"media": [
				{ "position": 1, "format": "CD", "track-count": 51, "tracks": tracks },
				{ "position": 2, "format": "CD", "track-count": 3 }
			]
		});
		let done =
			run("https://musicbrainz.org/release/11111111-1111-1111-1111-111111111111", |_| {
				Fetched::json(&release)
			})
			.unwrap();
		let md = &done.markdown;
		assert!(md.starts_with(
			"# Nevermind\n\n**Tracks**: 54\n\n## Tracks\n\n### Disc 1 - CD\n\n1. Track 1 (1:00)\n"
		));
		assert!(md.contains("50. Track 50 (1:00)\n\n_Showing first 50 of 51 tracks._\n\n"));
		assert!(md.contains("### Disc 2 - CD\n\n- 3 tracks (details unavailable)"));
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://musicbrainz.org/tag/rock", |_| panic!("no fetch expected")), None);
		assert_eq!(
			run("https://musicbrainz.org/artist/not-an-mbid", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(
			run("https://musicbrainz.org/artist/5b11f4ce-a62d-471e-81fc-a69a8278c7da", |_| {
				Fetched::status(503)
			}),
			None
		);
	}
}
