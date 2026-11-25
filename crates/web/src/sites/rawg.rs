//! RAWG (`rawg.io/games/<slug>`): game metadata from the RAWG API.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, fetch, html_to_markdown, segment, str_of};

/// Registry entry.
pub const SITE: Site = Site { name: "rawg", open };

const METHOD: &str = "rawg";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "rawg.io" | "www.rawg.io") {
		return None;
	}
	let mut segments = url.path_segments()?;
	if segments.next()? != "games" {
		return None;
	}
	let slug = segments.next()?.trim().to_owned();
	if slug.is_empty() {
		return None;
	}
	let request = format!("https://api.rawg.io/api/games/{}", segment(&slug));
	fetch(Fetch::get(request).accept_json(), move |reply, _| {
		let game = reply.json_value()?;
		if requires_api_key(&game) {
			return None;
		}
		summary(&slug, &game).finish()
	})
}

/// True when the API answered with a message about a missing API key.
fn requires_api_key(game: &Value) -> bool {
	let detail =
		format!("{} {}", str_of(game, "detail").unwrap_or(""), str_of(game, "error").unwrap_or(""));
	let detail = detail.to_lowercase();
	detail.contains("api key") || detail.contains("key is required") || detail.contains("apikey")
}

fn summary(slug: &str, game: &Value) -> Done {
	let title = str_of(game, "name").unwrap_or(slug);
	let mut md = format!("# {title}\n\n");
	if let Some(released) = str_of(game, "released") {
		let _ = writeln!(md, "**Released:** {released}");
	}
	if let Some(rating) = game.get("rating").and_then(Value::as_f64) {
		let _ = writeln!(md, "**Rating:** {rating:.2} / 5");
	}
	let platforms = collect_names(arr_of(game, "platforms").iter().map(|entry| {
		entry
			.get("platform")
			.and_then(|platform| str_of(platform, "name"))
	}));
	if !platforms.is_empty() {
		let _ = writeln!(md, "**Platforms:** {}", platforms.join(", "));
	}
	let genres = collect_names(
		arr_of(game, "genres")
			.iter()
			.map(|entry| str_of(entry, "name")),
	);
	if !genres.is_empty() {
		let _ = writeln!(md, "**Genres:** {}", genres.join(", "));
	}
	let _ = write!(md, "**RAWG:** https://rawg.io/games/{}\n\n", segment(slug));

	if let Some(description) = description(game) {
		let _ = write!(md, "## Description\n\n{description}\n");
	}

	Done::new(md, METHOD)
		.title(title)
		.note("Fetched via RAWG API")
}

/// Trimmed unique names, in first-seen order.
fn collect_names<'a>(values: impl Iterator<Item = Option<&'a str>>) -> Vec<String> {
	let mut names: Vec<String> = Vec::new();
	for value in values {
		if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty())
			&& !names.iter().any(|name| name == value)
		{
			names.push(value.to_owned());
		}
	}
	names
}

/// Raw description text, or the HTML description as Markdown.
fn description(game: &Value) -> Option<String> {
	if let Some(raw) = str_of(game, "description_raw") {
		return Some(raw.to_owned());
	}
	let rendered = html_to_markdown(str_of(game, "description")?, None);
	let rendered = rendered.trim();
	(!rendered.is_empty()).then(|| rendered.to_owned())
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn a_game_page_reads_the_api() {
		let mut requests = Vec::new();
		let done = run("https://rawg.io/games/grand-theft-auto-v", |request| {
			requests.push(request.url.clone());
			Fetched::json(&json!({
				"name": "Grand Theft Auto V", "released": "2013-09-17", "rating": 4.44,
				"platforms": [{ "platform": { "name": "PC" } }, { "platform": { "name": "PC" } }, { "platform": { "name": "PS4" } }],
				"genres": [{ "name": "Action" }, {}],
				"description": "<p>An <strong>open world</strong> game.</p>"
			}))
		})
		.unwrap();
		assert_eq!(requests, ["https://api.rawg.io/api/games/grand-theft-auto-v"]);
		assert_eq!((done.method, done.title.as_deref()), ("rawg", Some("Grand Theft Auto V")));
		let md = &done.markdown;
		assert!(md.starts_with("# Grand Theft Auto V\n\n**Released:** 2013-09-17\n**Rating:** 4.44 / 5\n**Platforms:** PC, PS4\n**Genres:** Action\n**RAWG:** https://rawg.io/games/grand-theft-auto-v\n\n## Description\n\nAn **open world** game.\n"));
		assert_eq!(done.notes, ["Fetched via RAWG API"]);
	}

	#[test]
	fn raw_description_text_wins_over_html() {
		let done = run("https://www.rawg.io/games/hades", |_| {
			Fetched::json(&json!({
				"name": "Hades", "description_raw": "Defy the god of the dead.",
				"description": "<p>ignored</p>"
			}))
		})
		.unwrap();
		assert!(
			done
				.markdown
				.ends_with("## Description\n\nDefy the god of the dead.\n")
		);
		assert!(!done.markdown.contains("ignored"));
	}

	#[test]
	fn a_key_requirement_and_api_failures_fall_through() {
		assert_eq!(
			run("https://rawg.io/games/hades", |_| {
				Fetched::json(&json!({ "detail": "API key is required" }))
			}),
			None
		);
		assert_eq!(run("https://rawg.io/search?q=hades", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://rawg.io/games/hades", |_| Fetched::status(500)), None);
	}
}
