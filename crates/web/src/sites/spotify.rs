//! Spotify tracks, albums, playlists, shows and episodes. Fetch oEmbed for
//! basic metadata, then enrich it with Open Graph metadata from the page.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, fetch, segment, str_of};
use crate::dom::{self, Node};

pub const SITE: Site = Site { name: "spotify", open };

fn open(url: &Url, _: &Context) -> Option<Action> {
	if url.host_str()? != "open.spotify.com" {
		return None;
	}
	let path = url.path();
	let kind = [
		("/episode/", "podcast-episode"),
		("/show/", "podcast-show"),
		("/track/", "track"),
		("/album/", "album"),
		("/playlist/", "playlist"),
	]
	.into_iter()
	.find_map(|(part, kind)| path.contains(part).then_some(kind))?;
	let url = url.to_string();
	let api = format!("https://open.spotify.com/oembed?url={}", segment(&url));
	fetch(Fetch::get(api).accept_json(), move |reply, _| {
		let embed = reply.json_value().filter(Value::is_object)?;
		fetch(Fetch::get(url.clone()), move |reply, _| {
			let (nodes, note) = if let Some(html) = reply.body_text() {
				match dom::parse(&html) {
					Ok(nodes) => (nodes, "Parsed Open Graph metadata from page HTML".to_owned()),
					Err(err) => (Vec::new(), format!("Failed to parse page HTML: {err}")),
				}
			} else {
				let note = if reply.status == 0 {
					"Page fetch returned status error".to_owned()
				} else {
					format!("Page fetch returned status {}", reply.status)
				};
				(Vec::new(), note)
			};
			let og = OpenGraph::from_nodes(&nodes);
			let title = og
				.title
				.or_else(|| str_of(&embed, "title"))
				.unwrap_or("Unknown");
			render(kind, title, &url, &embed, &og)
				.note("Retrieved metadata via Spotify oEmbed API")
				.note(note)
				.finish()
		})
	})
}

#[derive(Default)]
struct OpenGraph<'a> {
	title:        Option<&'a str>,
	description:  Option<&'a str>,
	image:        Option<&'a str>,
	duration:     Option<&'a str>,
	album:        Option<&'a str>,
	musician:     Option<&'a str>,
	artist:       Option<&'a str>,
	release_date: Option<&'a str>,
}

impl<'a> OpenGraph<'a> {
	fn from_nodes(nodes: &'a [Node]) -> Self {
		let mut graph = Self::default();
		for node in nodes {
			let Node::Tag(tag) = node else { continue };
			if tag.name() != "meta" {
				continue;
			}
			let field = match tag.attr("property").or_else(|| tag.attr("name")) {
				Some("og:title") => &mut graph.title,
				Some("og:description") => &mut graph.description,
				Some("og:image") => &mut graph.image,
				Some("music:duration") => &mut graph.duration,
				Some("music:album") => &mut graph.album,
				Some("music:musician") => &mut graph.musician,
				Some("music:release_date") => &mut graph.release_date,
				Some("twitter:audio:artist_name") => &mut graph.artist,
				_ => continue,
			};
			if let Some(content) = tag.attr("content") {
				*field = Some(content).filter(|s| !s.is_empty());
			}
		}
		graph
	}
}

fn render(kind: &str, title: &str, url: &str, embed: &Value, og: &OpenGraph<'_>) -> Done {
	let mut out = format!("# {title}\n\n**Type**: {kind}\n");
	if let Some(description) = og.description {
		let _ = writeln!(out, "\n**Description**: {description}");
	}
	if matches!(kind, "track" | "podcast-episode") {
		if let Some(artist) = og.artist.or(og.musician) {
			let _ = writeln!(out, "\n**Artist**: {artist}");
		}
		if let Some(album) = og.album {
			let _ = writeln!(out, "\n**Album**: {album}");
		}
		if let Some(total) = og.duration.and_then(|s| s.trim().parse::<u64>().ok()) {
			let (hours, minutes, seconds) = (total / 3600, total / 60 % 60, total % 60);
			if hours > 0 {
				let _ = writeln!(out, "\n**Duration**: {hours}:{minutes:02}:{seconds:02}");
			} else {
				let _ = writeln!(out, "\n**Duration**: {minutes}:{seconds:02}");
			}
		}
	}
	if kind == "album"
		&& let Some(date) = og.release_date
	{
		let _ = writeln!(out, "\n**Release Date**: {date}");
	}
	out.push_str("\n---\n");
	let limitation = match kind {
		"playlist" => Some("Playlist details (tracks, creator, follower count)"),
		"album" => Some("Track listing and detailed album information"),
		"podcast-show" => Some("Episode listing and detailed show information"),
		_ => None,
	};
	if let Some(limitation) = limitation {
		let _ = writeln!(
			out,
			"\n**Note**: {limitation} require authentication. Only basic metadata is available \
			 without Spotify API credentials."
		);
	}
	let _ = writeln!(out, "\n**URL**: {url}");
	if let Some(thumbnail) = str_of(embed, "thumbnail_url") {
		let _ = writeln!(out, "\n**Thumbnail**: {thumbnail}");
	} else if let Some(image) = og.image {
		let _ = writeln!(out, "\n**Image**: {image}");
	}
	Done::new(out, "spotify").title(title)
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn a_localized_track_combines_oembed_and_open_graph_metadata() {
		let url = "https://open.spotify.com/intl-de/track/trackId?si=abc";
		let mut requests = 0;
		let done = run(url, |request| {
			requests += 1;
			match requests {
				1 => {
					assert_eq!(request.url, "https://open.spotify.com/oembed?url=https%3A%2F%2Fopen.spotify.com%2Fintl-de%2Ftrack%2FtrackId%3Fsi%3Dabc");
					Fetched::json(&json!({"title": "Embed Title", "thumbnail_url": "https://cdn.example/cover.jpg"}))
				},
				2 => {
					assert_eq!(request.url, url);
					Fetched::text("text/html", r#"
						<meta property="og:title" content="Open &amp; Graph Title">
						<meta property="og:description" content="About this track.">
						<meta property="music:musician" content="Backup">
						<meta name="twitter:audio:artist_name" content="Artist">
						<meta property="music:album" content="Album">
						<meta property="music:duration" content="3671">
						<meta property="og:image" content="https://cdn.example/og.jpg">
					"#)
				},
				_ => panic!("only two requests expected"),
			}
		})
		.unwrap();
		assert_eq!((done.method, done.title.as_deref()), ("spotify", Some("Open & Graph Title")));
		assert!(done.markdown.contains(
			"**Type**: track\n\n**Description**: About this track.\n\n**Artist**: \
			 Artist\n\n**Album**: Album\n\n**Duration**: 1:01:11\n"
		));
		assert!(
			done
				.markdown
				.ends_with("**Thumbnail**: https://cdn.example/cover.jpg\n")
		);
	}

	#[test]
	fn the_other_spotify_shapes_keep_their_type_and_authentication_note() {
		for (path, kind, note) in [
			("episode", "podcast-episode", None),
			("show", "podcast-show", Some("Episode listing and detailed show information")),
			("album", "album", Some("Track listing and detailed album information")),
			("playlist", "playlist", Some("Playlist details (tracks, creator, follower count)")),
		] {
			let url = format!("https://open.spotify.com/{path}/id");
			let done = run(&url, |request| {
				if request.url == url {
					Fetched::text(
						"text/html",
						r#"<meta property="music:release_date" content="2024-08-13">"#,
					)
				} else {
					Fetched::json(&json!({"title": "Embed Title"}))
				}
			})
			.unwrap();
			assert_eq!(done.title.as_deref(), Some("Embed Title"));
			assert!(done.markdown.contains(&format!("**Type**: {kind}\n")));
			assert_eq!(done.markdown.contains("**Release Date**: 2024-08-13"), path == "album");
			assert_eq!(done.markdown.contains("require authentication"), note.is_some());
			if let Some(note) = note {
				assert!(done.markdown.contains(note));
			}
		}
	}

	#[test]
	fn unrelated_urls_and_a_failed_oembed_request_fall_through() {
		for url in
			["https://example.com/open.spotify.com/track/id", "https://open.spotify.com/artist/id"]
		{
			assert_eq!(run(url, |_| panic!("no fetch expected")), None);
		}
		assert_eq!(
			run("https://open.spotify.com/track/id", |request| {
				assert!(request.url.starts_with("https://open.spotify.com/oembed?"));
				Fetched::status(404)
			}),
			None
		);
	}
}
