//! Snapcraft (`snapcraft.io/<snap>`, `/install/<snap>`). One request to the
//! Snap Store API carries the snap, its publisher and its channel map.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, fetch, format_number, segment, str_of};

/// Registry entry.
pub const SITE: Site = Site { name: "snapcraft", open };

const METHOD: &str = "snapcraft";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "snapcraft.io" | "www.snapcraft.io") {
		return None;
	}
	let mut segments: Vec<&str> = url.path_segments()?.collect();
	if segments.last() == Some(&"") {
		segments.pop();
	}
	let encoded = match segments.as_slice() {
		[only] => *only,
		["install", name] => *name,
		_ => return None,
	};
	if encoded.is_empty() {
		return None;
	}
	let name = percent_decode(encoded)?;
	let api = format!("https://api.snapcraft.io/v2/snaps/info/{}", segment(&name));
	fetch(
		Fetch::get(api)
			.accept_json()
			.header("Snap-Device-Series", "16"),
		move |reply, _| {
			let data = reply.json_value()?;
			let snap = data
				.get("snap")
				.filter(|snap| !snap.is_null())
				.unwrap_or(&data);
			let title = opt_str(snap, "title")
				.or_else(|| opt_str(snap, "name"))
				.or_else(|| opt_str(&data, "name"))
				.unwrap_or(&name)
				.to_owned();
			let summary = opt_str(snap, "summary").or_else(|| opt_str(&data, "summary"));
			let description = opt_str(snap, "description").or_else(|| opt_str(&data, "description"));
			let publisher = snap
				.get("publisher")
				.filter(|publisher| !publisher.is_null())
				.or_else(|| {
					data
						.get("publisher")
						.filter(|publisher| !publisher.is_null())
				})
				.and_then(format_publisher);
			let channels_map = arr_of(&data, "channel-map");
			let mut version = opt_str(snap, "version")
				.or_else(|| opt_str(&data, "version"))
				.map(str::to_owned);
			if version.as_deref().unwrap_or_default().is_empty() {
				version = pick_version(channels_map).map(str::to_owned);
			}
			let downloads = downloads(snap).or_else(|| downloads(&data));

			let mut md = format!("# {title}\n\n");
			if let Some(summary) = summary {
				let _ = writeln!(md, "{summary}\n");
			}
			let mut info = format!(
				"**Version:** {}",
				version
					.as_deref()
					.filter(|version| !version.is_empty())
					.unwrap_or("unknown")
			);
			if let Some(confinement) =
				opt_str(snap, "confinement").or_else(|| opt_str(&data, "confinement"))
			{
				let _ = write!(info, " · **Confinement:** {confinement}");
			}
			if let Some(base) = opt_str(snap, "base").or_else(|| opt_str(&data, "base")) {
				let _ = write!(info, " · **Base:** {base}");
			}
			let _ = writeln!(md, "{info}");
			if let Some(publisher) = publisher {
				let _ = writeln!(md, "**Publisher:** {publisher}");
			}
			if let Some(downloads) = downloads {
				let _ = writeln!(md, "**Downloads:** {}", format_number(downloads));
			}
			md.push('\n');

			let channels = channel_summaries(channels_map);
			if !channels.is_empty() {
				md.push_str("## Channels\n\n");
				for (name, summary) in &channels {
					let _ = write!(md, "- {name}");
					if let Some(version) = &summary.version {
						let _ = write!(md, ": {version}");
					}
					if !summary.architectures.is_empty() {
						let _ = write!(md, " ({})", summary.architectures.join(", "));
					}
					md.push('\n');
				}
				md.push('\n');
			}

			let text = description.or(summary);
			if let Some(text) = text {
				let _ = writeln!(md, "## Description\n\n{text}");
			}
			Done::new(md, METHOD)
				.title(title)
				.note("Fetched via Snapcraft API")
				.finish()
		},
	)
}

/// A string at `key`, with `null` the only missing value (`??`).
fn opt_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
	value.get(key)?.as_str()
}

fn format_publisher(publisher: &Value) -> Option<String> {
	let display_name = opt_str(publisher, "display-name")
		.or_else(|| opt_str(publisher, "username"))
		.or_else(|| opt_str(publisher, "id"))
		.filter(|name| !name.is_empty())?;
	match opt_str(publisher, "username") {
		Some(username) if username != display_name => Some(format!("{display_name} (@{username})")),
		_ => Some(display_name.to_owned()),
	}
}

/// The channel of one channel-map entry: its `name` when it is a full channel
/// name, otherwise `track/risk` (plus `/branch`).
fn channel_name(channel: &Value) -> Option<String> {
	if let Some(name) = opt_str(channel, "name").filter(|name| name.contains('/')) {
		return Some(name.to_owned());
	}
	if let (Some(track), Some(risk)) = (str_of(channel, "track"), str_of(channel, "risk")) {
		let branch =
			str_of(channel, "branch").map_or_else(String::new, |branch| format!("/{branch}"));
		return Some(format!("{track}/{risk}{branch}"));
	}
	opt_str(channel, "name").map(str::to_owned)
}

/// The first stable version, else the first version of the channel map.
fn pick_version(entries: &[Value]) -> Option<&str> {
	let stable = entries
		.iter()
		.find(|entry| {
			entry
				.get("channel")
				.and_then(|channel| str_of(channel, "risk"))
				== Some("stable")
		})
		.and_then(|entry| str_of(entry, "version"));
	stable.or_else(|| entries.iter().find_map(|entry| str_of(entry, "version")))
}

fn downloads(value: &Value) -> Option<f64> {
	["downloads", "download"]
		.iter()
		.find_map(|key| value.get(key).and_then(Value::as_f64))
}

/// The channels of a channel map, sorted by name, each with the first version
/// and every architecture seen.
#[derive(Default)]
struct ChannelSummary {
	version:       Option<String>,
	architectures: Vec<String>,
}

fn channel_summaries(entries: &[Value]) -> Vec<(String, ChannelSummary)> {
	let mut channels: Vec<(String, ChannelSummary)> = Vec::new();
	for entry in entries {
		let Some(name) = entry.get("channel").and_then(channel_name) else {
			continue;
		};
		let index = if let Some(index) = channels.iter().position(|(existing, _)| *existing == name) {
			index
		} else {
			channels.push((name, ChannelSummary::default()));
			channels.len() - 1
		};
		let summary = &mut channels[index].1;
		if summary.version.is_none() {
			summary.version = str_of(entry, "version").map(str::to_owned);
		}
		if let Some(architecture) = entry
			.get("channel")
			.and_then(|channel| str_of(channel, "architecture"))
			&& !summary
				.architectures
				.iter()
				.any(|seen| seen == architecture)
		{
			summary.architectures.push(architecture.to_owned());
		}
	}
	channels.sort_by(|(left, _), (right, _)| left.cmp(right));
	channels
}

/// Percent-decode a path segment (`decodeURIComponent`); `None` on a malformed
/// escape.
fn percent_decode(text: &str) -> Option<String> {
	let bytes = text.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] == b'%' {
			let hex = bytes.get(index + 1..index + 3)?;
			out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
			index += 3;
		} else {
			out.push(bytes[index]);
			index += 1;
		}
	}
	Some(String::from_utf8_lossy(&out).into_owned())
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn a_snap_page_lists_its_channels_sorted_by_name() {
		let data = json!({
			"name": "hello-world", "title": "Hello World", "summary": "A hello world snap",
			"publisher": { "display-name": "Canonical", "username": "canonical" },
			"confinement": "strict", "base": "core22",
			"channel-map": [
				{ "channel": { "track": "latest", "risk": "stable", "architecture": "amd64" }, "version": "1.0.2" },
				{ "channel": { "track": "latest", "risk": "stable", "architecture": "arm64" }, "version": "1.0.2" },
				{ "channel": { "name": "latest/edge", "architecture": "amd64" }, "version": "1.0.3" }
			]
		});
		let mut requests = Vec::new();
		let done = run("https://snapcraft.io/install/hello-world", |request| {
			requests.push(request.url.clone());
			Fetched::json(&data)
		})
		.unwrap();
		assert_eq!(requests, ["https://api.snapcraft.io/v2/snaps/info/hello-world"]);
		assert_eq!((done.method, done.title.as_deref()), ("snapcraft", Some("Hello World")));
		let md = &done.markdown;
		assert!(md.starts_with("# Hello World\n\nA hello world snap\n\n"));
		assert!(md.contains(
			"**Version:** 1.0.2 · **Confinement:** strict · **Base:** core22\n**Publisher:** \
			 Canonical (@canonical)\n\n"
		));
		assert!(md.contains(
			"## Channels\n\n- latest/edge: 1.0.3 (amd64)\n- latest/stable: 1.0.2 (amd64, arm64)\n\n"
		));
		assert!(md.ends_with("## Description\n\nA hello world snap\n"));
		assert_eq!(done.notes, ["Fetched via Snapcraft API"]);
	}

	#[test]
	fn a_nested_snap_takes_its_version_from_the_channel_map() {
		let done = run("https://snapcraft.io/install/hello%20world", |request| {
			assert_eq!(request.url, "https://api.snapcraft.io/v2/snaps/info/hello%20world");
			assert!(
				request
					.headers
					.iter()
					.any(|(name, value)| name == "Snap-Device-Series" && value == "16")
			);
			Fetched::json(&json!({
				"snap": { "name": "hello", "downloads": 1234 },
				"channel-map": [{ "channel": { "track": "latest", "risk": "beta" }, "version": "2.0" }]
			}))
		})
		.unwrap();
		assert_eq!(done.title.as_deref(), Some("hello"));
		assert!(
			done
				.markdown
				.starts_with("# hello\n\n**Version:** 2.0\n**Downloads:** 1.2K\n\n")
		);
		assert!(
			done
				.markdown
				.contains("## Channels\n\n- latest/beta: 2.0\n\n")
		);
		assert!(!done.markdown.contains("## Description"));
	}

	#[test]
	fn other_paths_and_api_failures_fall_through() {
		for url in ["https://snapcraft.io/", "https://snapcraft.io/a/b", "https://example.test/hello"]
		{
			assert_eq!(run(url, |_| panic!("no fetch expected")), None, "{url}");
		}
		assert_eq!(run("https://snapcraft.io/install/hello-world", |_| Fetched::status(404)), None);
	}
}
