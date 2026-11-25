//! `JetBrains` Marketplace (`plugins.jetbrains.com/plugin/<id>`): plugin
//! metadata plus the newest update from the marketplace API.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, f64_of, fetch, format_number, html_to_markdown,
	str_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "jetbrains-marketplace", open };

const METHOD: &str = "jetbrains-marketplace";
const NOTE: &str = "Fetched via JetBrains Marketplace API";
const API: &str = "https://plugins.jetbrains.com/api/plugins";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if url.host_str()? != "plugins.jetbrains.com" {
		return None;
	}
	let rest = url.path().strip_prefix("/plugin/")?;
	let id: String = rest.chars().take_while(char::is_ascii_digit).collect();
	if id.is_empty() {
		return None;
	}
	// `/plugin/<id>`, `/plugin/<id>/...` and `/plugin/<id>-<slug>[/...]`.
	let tail = rest.as_bytes().get(id.len()..).unwrap_or_default();
	let slug_ok = match tail.first().copied() {
		None | Some(b'/') => true,
		Some(b'-') => tail.get(1).is_some_and(|byte| *byte != b'/'),
		Some(_) => false,
	};
	if !slug_ok {
		return None;
	}
	fetch(Fetch::get(format!("{API}/{id}")), move |reply, _| {
		let plugin = reply.json_value()?;
		fetch(Fetch::get(format!("{API}/{id}/updates?size=1")), move |reply, _| {
			let updates = reply.json_value()?;
			build(&plugin, updates.as_array().and_then(|list| list.first()), &id)
		})
	})
}

fn build(plugin: &Value, update: Option<&Value>, id: &str) -> Option<Action> {
	let name = str_of(plugin, "name")?;
	let mut md = format!("# {name}\n\n");

	let description = plugin
		.get("description")
		.and_then(Value::as_str)
		.or_else(|| plugin.get("preview").and_then(Value::as_str))
		.unwrap_or("");
	if !description.is_empty() {
		let _ = write!(md, "{}\n\n", html_to_markdown(description, None).trim());
	}

	let _ = writeln!(md, "**Plugin ID:** {id}");
	if let Some(vendor) = plugin
		.get("vendor")
		.and_then(|vendor| str_of(vendor, "name").or_else(|| str_of(vendor, "publicName")))
	{
		let _ = writeln!(md, "**Vendor:** {vendor}");
	}
	if let Some(downloads) = f64_of(plugin, "downloads") {
		let _ = writeln!(md, "**Downloads:** {}", format_number(downloads));
	}
	let (rating, votes) = rating(plugin);
	if let Some(rating) = rating {
		let _ = write!(md, "**Rating:** {rating:.2}");
		if let Some(votes) = votes {
			let _ = write!(md, " ({} votes)", format_number(votes));
		}
		md.push('\n');
	}
	let tags: Vec<&str> = arr_of(plugin, "tags")
		.iter()
		.filter_map(|tag| str_of(tag, "name"))
		.collect();
	if !tags.is_empty() {
		let _ = writeln!(md, "**Tags:** {}", tags.join(", "));
	}

	if let Some(update) = update {
		md.push_str("\n## Latest Release\n\n");
		if let Some(version) = str_of(update, "version") {
			let _ = writeln!(md, "**Version:** {version}");
		}
		if let Some(channel) = str_of(update, "channel") {
			let _ = writeln!(md, "**Channel:** {channel}");
		}
		if let Some(compatibility) = build_compatibility(update) {
			let _ = writeln!(md, "**Build Compatibility:** {compatibility}");
		}
		if let Some(downloads) = f64_of(update, "downloads") {
			let _ = writeln!(md, "**Release Downloads:** {}", format_number(downloads));
		}
	}

	let mut compatibility: Vec<(String, String)> = update
		.and_then(|update| update.get("compatibleVersions"))
		.and_then(Value::as_object)
		.map_or_default(|versions| {
			versions
				.iter()
				.map(|(product, version)| (product.clone(), value_text(version)))
				.collect()
		});
	compatibility.sort();
	if !compatibility.is_empty() {
		md.push_str("\n## IDE Compatibility\n\n");
		for (product, version) in &compatibility {
			let _ = writeln!(md, "- {product}: {version}");
		}
	}

	Done::new(md, METHOD).title(name).note(NOTE).finish()
}

/// Rating value and vote count, whether the API nests the rating or not.
fn rating(plugin: &Value) -> (Option<f64>, Option<f64>) {
	let count = f64_of(plugin, "ratingCount");
	match plugin.get("rating") {
		Some(Value::Number(number)) => (number.as_f64(), count),
		Some(rating @ Value::Object(_)) => (
			["rating", "value", "score"]
				.iter()
				.find_map(|key| f64_of(rating, key)),
			["votes", "totalVotes", "count"]
				.iter()
				.find_map(|key| f64_of(rating, key))
				.or(count),
		),
		_ => (None, count),
	}
}

fn build_compatibility(update: &Value) -> Option<String> {
	if let Some(since_until) = str_of(update, "sinceUntil") {
		return Some(since_until.to_owned());
	}
	match (str_of(update, "since"), str_of(update, "until")) {
		(Some(since), Some(until)) => Some(format!("{since} - {until}")),
		(Some(since), None) => Some(format!("{since}+")),
		_ => None,
	}
}

fn value_text(value: &Value) -> String {
	match value {
		Value::String(text) => text.clone(),
		other => other.to_string(),
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn a_plugin_page_reads_metadata_and_the_latest_update() {
		let mut requests = Vec::new();
		let done = run("https://plugins.jetbrains.com/plugin/12345-rust", |request| {
			requests.push(request.url.clone());
			if request.url.ends_with("/updates?size=1") {
				Fetched::json(&json!([{
					"version": "2.0.1", "channel": "Stable", "sinceUntil": "223-241", "downloads": 5_000,
					"compatibleVersions": { "IU": "2023.1", "IC": "2023.1" }
				}]))
			} else {
				Fetched::json(&json!({
					"id": 12_345, "name": "Rust", "description": "A fantastic plugin", "preview": "ignored",
					"vendor": { "name": "JetBrains s.r.o.", "publicName": "JetBrains" }, "downloads": 1_200_000,
					"rating": { "rating": 4.5, "votes": 1_200 }, "tags": [{ "name": "rust" }, { "name": "ide" }]
				}))
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://plugins.jetbrains.com/api/plugins/12345",
			"https://plugins.jetbrains.com/api/plugins/12345/updates?size=1"
		]);
		assert_eq!((done.method, done.title.as_deref()), ("jetbrains-marketplace", Some("Rust")));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# Rust\n\nA fantastic plugin\n\n**Plugin ID:** 12345\n**Vendor:** JetBrains s.r.o.\n"
		));
		assert!(
			md.contains("**Downloads:** 1.2M\n**Rating:** 4.50 (1.2K votes)\n**Tags:** rust, ide\n")
		);
		assert!(md.contains("\n## Latest Release\n\n**Version:** 2.0.1\n**Channel:** Stable\n"));
		assert!(md.contains("**Build Compatibility:** 223-241\n**Release Downloads:** 5K\n"));
		assert!(md.ends_with("\n## IDE Compatibility\n\n- IC: 2023.1\n- IU: 2023.1\n"));
		assert_eq!(done.notes, ["Fetched via JetBrains Marketplace API"]);
	}

	#[test]
	fn a_numeric_rating_and_a_since_only_update_still_render() {
		let done = run("https://plugins.jetbrains.com/plugin/7", |request| {
			if request.url.ends_with("/updates?size=1") {
				Fetched::json(&json!([{ "version": "1.0", "since": "223" }]))
			} else {
				Fetched::json(
					&json!({ "name": "Minimal", "preview": "Preview text", "rating": 4, "ratingCount": 10 }),
				)
			}
		})
		.unwrap();
		assert_eq!(done.title.as_deref(), Some("Minimal"));
		assert!(done.markdown.starts_with(
			"# Minimal\n\nPreview text\n\n**Plugin ID:** 7\n**Rating:** 4.00 (10 votes)\n"
		));
		assert!(done.markdown.contains("**Build Compatibility:** 223+"));
		assert!(!done.markdown.contains("**Downloads:**"));
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://plugins.jetbrains.com/about", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://plugins.jetbrains.com/plugin/12345", |_| Fetched::status(503)), None);
	}
}
