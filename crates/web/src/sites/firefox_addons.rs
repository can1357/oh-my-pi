//! Firefox Add-ons (`addons.mozilla.org/…/addon/<slug>`): addon metadata from
//! the AMO API, with localized fields and the current version's permissions.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, f64_of, fetch, format_number, html_to_markdown,
	segment, str_of, u64_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "firefox-addons", open };

const METHOD: &str = "firefox-addons";
/// Permissions listed before the remainder is elided.
const PERMISSION_PREVIEW: usize = 40;

fn open(url: &Url, _: &Context) -> Option<Action> {
	if url.host_str()? != "addons.mozilla.org" {
		return None;
	}
	let segments: Vec<&str> = url
		.path_segments()?
		.filter(|segment| !segment.is_empty())
		.collect();
	let addon = segments.iter().position(|segment| *segment == "addon")?;
	let slug = percent_decode(segments.get(addon + 1).copied().unwrap_or_default());
	if slug.is_empty() {
		return None;
	}
	let page = url.as_str().to_owned();
	fetch(
		Fetch::get(format!("https://addons.mozilla.org/api/v5/addons/addon/{}/", segment(&slug)))
			.accept_json(),
		move |reply, _| {
			let data = reply.json_value()?;
			let locale = str_of(&data, "default_locale").unwrap_or("en-US");
			let name = localized(data.get("name"), Some(locale)).unwrap_or_else(|| slug.clone());
			let summary = localized(data.get("summary"), Some(locale));
			let description = localized(data.get("description"), Some(locale))
				.map(|html| html_to_markdown(&html, None))
				.filter(|markdown| !markdown.is_empty());

			let authors: Vec<String> = arr_of(&data, "authors")
				.iter()
				.filter_map(|author| str_of(author, "name"))
				.map(str::to_owned)
				.collect();
			let ratings = data.get("ratings");
			let rating = ratings.and_then(|ratings| f64_of(ratings, "average"));
			let reviews = ratings.and_then(|ratings| u64_of(ratings, "count"));
			let users =
				u64_of(&data, "average_daily_users").or_else(|| u64_of(&data, "weekly_downloads"));
			let current = data.get("current_version");
			let license = current.and_then(|version| version.get("license"));
			let license_name =
				localized(license.and_then(|license| license.get("name")), Some(locale))
					.or_else(|| license.and_then(|license| str_of(license, "slug").map(str::to_owned)));
			let license_url = license.and_then(|license| str_of(license, "url"));
			let homepage = data.get("homepage");
			let homepage = localized(homepage.and_then(|homepage| homepage.get("url")), Some(locale))
				.or_else(|| {
					localized(homepage.and_then(|homepage| homepage.get("outgoing")), Some(locale))
				})
				.filter(|homepage| !homepage.is_empty());
			let categories = categories(data.get("categories"));
			let permissions = permissions(current.and_then(|version| version.get("file")));

			let mut md = format!("# {name}\n\n");
			if let Some(summary) = &summary {
				let _ = write!(md, "{summary}\n\n");
			}
			if !authors.is_empty() {
				let _ = writeln!(
					md,
					"**Author{}:** {}",
					if authors.len() > 1 { "s" } else { "" },
					authors.join(", ")
				);
			}
			if let Some(rating) = rating {
				let _ = write!(md, "**Rating:** {rating:.2}");
				if let Some(reviews) = reviews {
					let _ = write!(md, " ({} reviews)", format_number(reviews as f64));
				}
				md.push('\n');
			}
			if let Some(users) = users {
				let _ = writeln!(md, "**Users:** {}", format_number(users as f64));
			}
			if let Some(version) = current.and_then(|version| str_of(version, "version")) {
				let _ = writeln!(md, "**Version:** {version}");
			}
			if !categories.is_empty() {
				let _ = writeln!(md, "**Categories:** {}", categories.join(", "));
			}
			match (license_name, license_url) {
				(Some(name), Some(url)) => {
					let _ = writeln!(md, "**License:** [{name}]({url})");
				},
				(Some(name), None) => {
					let _ = writeln!(md, "**License:** {name}");
				},
				(None, Some(url)) => {
					let _ = writeln!(md, "**License:** {url}");
				},
				(None, None) => {},
			}
			if let Some(homepage) = &homepage {
				let _ = writeln!(md, "**Homepage:** {homepage}");
			}
			if let Some(description) = &description {
				let _ = write!(md, "\n## Description\n\n{description}\n");
			}
			if !permissions.is_empty() {
				let preview = permissions.len().min(PERMISSION_PREVIEW);
				let _ = write!(md, "\n## Permissions ({})\n\n", permissions.len());
				for permission in &permissions[..preview] {
					let _ = writeln!(md, "- {permission}");
				}
				if permissions.len() > preview {
					let _ = write!(md, "\n[…{} permissions elided…]\n", permissions.len() - preview);
				}
			}

			let final_url = data
				.get("url")
				.and_then(Value::as_str)
				.filter(|url| !url.is_empty())
				.map(str::to_owned)
				.or_else(|| (!reply.url.is_empty()).then(|| reply.url.clone()))
				.unwrap_or(page);
			let mut done = Done::new(md, METHOD)
				.title(name)
				.note("Fetched via Firefox Add-ons API");
			done.url = Some(final_url);
			done.finish()
		},
	)
}

/// Localized text: `default`, then `en-US`/`en_US`/`en`, then any string value.
fn localized(value: Option<&Value>, default: Option<&str>) -> Option<String> {
	match value? {
		Value::String(text) => Some(text.clone()),
		Value::Object(map) => {
			if let Some(default) = default
				&& let Some(text) = map
					.get(default)
					.and_then(Value::as_str)
					.filter(|text| !text.is_empty())
			{
				return Some(text.to_owned());
			}
			["en-US", "en_US", "en"]
				.iter()
				.find_map(|locale| {
					map.get(*locale)
						.and_then(Value::as_str)
						.filter(|text| !text.is_empty())
				})
				.or_else(|| map.values().find_map(|value| value.as_str()))
				.map(str::to_owned)
		},
		_ => None,
	}
}

/// Categories, either a plain array or an object of arrays (deduplicated).
fn categories(value: Option<&Value>) -> Vec<String> {
	match value {
		Some(Value::Array(items)) => items
			.iter()
			.filter_map(Value::as_str)
			.filter(|item| !item.is_empty())
			.map(str::to_owned)
			.collect(),
		Some(Value::Object(lists)) => {
			let mut out: Vec<String> = Vec::new();
			for list in lists.values() {
				for item in list.as_array().map_or(&[][..], Vec::as_slice) {
					if let Some(item) = item.as_str().filter(|item| !item.is_empty())
						&& !out.iter().any(|existing| existing == item)
					{
						out.push(item.to_owned());
					}
				}
			}
			out
		},
		_ => Vec::new(),
	}
}

/// Permissions of the current version's file, first-seen order.
fn permissions(file: Option<&Value>) -> Vec<String> {
	let Some(file) = file else {
		return Vec::new();
	};
	let mut out: Vec<String> = Vec::new();
	for key in
		["permissions", "host_permissions", "optional_permissions", "optional_host_permissions"]
	{
		for permission in arr_of(file, key)
			.iter()
			.filter_map(Value::as_str)
			.filter(|permission| !permission.is_empty())
		{
			if !out.iter().any(|existing| existing == permission) {
				out.push(permission.to_owned());
			}
		}
	}
	out
}

/// Decode `%XX` escapes (the URL path arrives percent-encoded).
fn percent_decode(text: &str) -> String {
	let bytes = text.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'%'
			&& i + 2 < bytes.len()
			&& let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2]))
		{
			out.push(high << 4 | low);
			i += 3;
			continue;
		}
		out.push(bytes[i]);
		i += 1;
	}
	String::from_utf8_lossy(&out).into_owned()
}

fn hex(byte: u8) -> Option<u8> {
	(byte as char).to_digit(16).map(|digit| digit as u8)
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn an_addon_page_reads_localized_metadata_and_permissions() {
		let addon = json!({
			"name": { "en-US": "uBlock Origin" }, "summary": { "en-US": "An efficient content blocker." },
			"description": { "en-US": "<p>A content blocker.</p>" }, "default_locale": "en-US",
			"authors": [{ "name": "Raymond Hill" }, { "name": " Nik Rolls " }, { "name": null }],
			"average_daily_users": 7_000_000, "weekly_downloads": 1,
			"ratings": { "average": 4.5, "count": 1234 },
			"categories": { "extension": ["Privacy & Security", "Productivity", "Privacy & Security"] },
			"homepage": { "url": { "en-US": "https://github.com/gorhill/uBlock" } },
			"url": "https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/",
			"current_version": {
				"version": "1.57.2",
				"license": { "name": { "en-US": "GPL-3.0" }, "slug": "GPL-3.0", "url": "https://example.test/gpl" },
				"file": {
					"permissions": ["storage", "<all_urls>", "storage"],
					"host_permissions": ["<all_urls>"],
					"optional_permissions": ["tabs", "alarms"],
					"optional_host_permissions": ["webRequest"]
				}
			}
		});
		let mut requests = Vec::new();
		let done = run("https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/", |request| {
			requests.push(request.url.clone());
			Fetched::json(&addon)
		})
		.unwrap();
		assert_eq!(requests, ["https://addons.mozilla.org/api/v5/addons/addon/ublock-origin/"]);
		assert_eq!((done.method, done.title.as_deref()), ("firefox-addons", Some("uBlock Origin")));
		assert_eq!(
			done.url.as_deref(),
			Some("https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/")
		);
		let md = &done.markdown;
		assert!(md.starts_with("# uBlock Origin\n\nAn efficient content blocker.\n\n**Authors:** Raymond Hill, Nik Rolls\n**Rating:** 4.50 (1.2K reviews)\n**Users:** 7M\n**Version:** 1.57.2\n**Categories:** Privacy & Security, Productivity\n**License:** [GPL-3.0](https://example.test/gpl)\n**Homepage:** https://github.com/gorhill/uBlock\n\n## Description\n\nA content blocker.\n\n## Permissions (5)\n\n- storage\n- <all_urls>\n- tabs\n- alarms\n- webRequest\n"));
	}

	#[test]
	fn more_than_forty_permissions_are_elided() {
		let permissions: Vec<String> = (0..41).map(|index| format!("permission{index}")).collect();
		let addon = json!({
			"name": { "en-US": "Many" }, "categories": ["Other"],
			"current_version": { "version": "1.0", "file": { "permissions": permissions } }
		});
		let done = run("https://addons.mozilla.org/addon/many", |_| Fetched::json(&addon)).unwrap();
		let md = &done.markdown;
		assert!(md.contains("## Permissions (41)\n\n- permission0\n"));
		assert!(md.contains("- permission39\n"));
		assert!(!md.contains("- permission40\n"));
		assert!(md.contains("[…1 permissions elided…]"));
		assert!(md.contains("**Categories:** Other\n"));
		assert!(!md.contains("**License:**"));
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://addons.mozilla.org/firefox/", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://example.test/addon/many", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://addons.mozilla.org/addon/many", |_| Fetched::status(404)), None);
	}
}
