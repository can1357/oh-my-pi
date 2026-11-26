//! VS Code Marketplace (`marketplace.visualstudio.com/items?itemName=…`):
//! extension metadata from the gallery `extensionquery` API.

use std::{collections::HashMap, fmt::Write as _};

use serde_json::{Value, json};
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, fetch, format_number, str_of};

/// Registry entry.
pub const SITE: Site = Site { name: "vscode-marketplace", open };

const API: &str = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";
const METHOD: &str = "vscode-marketplace";
const ACCEPT: &str = "application/json;api-version=7.2-preview.1";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(
		url.host_str()?,
		"marketplace.visualstudio.com" | "www.marketplace.visualstudio.com"
	) {
		return None;
	}
	if !url.path().starts_with("/items") {
		return None;
	}
	// A second decode mirrors the TS handler's `decodeURIComponent` over the
	// already-decoded query value.
	let item = url
		.query_pairs()
		.find(|(key, _)| key.as_ref() == "itemName")?
		.1;
	let item = decode(&item);
	if !item.contains('.') {
		return None;
	}

	let payload = json!({
		"filters": [{ "criteria": [{ "filterType": 7, "value": item }] }],
		"flags": 950
	});
	let request = {
		let mut request = Fetch::post_json(API, &payload);
		request.headers.retain(|(name, _)| name != "Accept");
		request.header("Accept", ACCEPT)
	};
	fetch(request, move |reply, _| {
		let data = reply.json_value()?;
		let extension = data.pointer("/results/0/extensions/0")?;

		let (publisher_from_url, extension_from_url) = item.split_once('.')?;
		let publisher = extension.get("publisher");
		let publisher_name = publisher
			.and_then(|publisher| opt_str(publisher, "publisherName"))
			.unwrap_or(publisher_from_url);
		let extension_name = opt_str(extension, "extensionName").unwrap_or(extension_from_url);
		let display_name = opt_str(extension, "displayName").unwrap_or(extension_name);
		let description = opt_str(extension, "shortDescription")
			.or_else(|| opt_str(extension, "description"))
			.filter(|text| !text.is_empty());
		let publisher_display = publisher.and_then(|publisher| opt_str(publisher, "displayName"));
		let publisher_label = match publisher_display {
			Some(display) if !display.is_empty() && display != publisher_name => {
				format!("{display} ({publisher_name})")
			},
			Some(display) => display.to_owned(),
			None => publisher_name.to_owned(),
		};

		let versions = arr_of(extension, "versions");
		let version = versions
			.first()
			.and_then(|version| str_of(version, "version"));
		let stats = statistics(extension);
		let installs = stats
			.get("install")
			.or_else(|| stats.get("installs"))
			.copied();
		let rating =
			format_rating(stats.get("averagerating").copied(), stats.get("ratingcount").copied());
		let repo = versions
			.first()
			.map(|version| arr_of(version, "properties"))
			.and_then(repo_link)
			.or_else(|| repo_link(arr_of(extension, "properties")));

		let mut md = format!("# {display_name}\n\n");
		if let Some(description) = description {
			let _ = writeln!(md, "{description}\n");
		}
		let _ = writeln!(md, "**Identifier:** {publisher_name}.{extension_name}");
		if !publisher_label.is_empty() {
			let _ = writeln!(md, "**Publisher:** {publisher_label}");
		}
		if let Some(version) = version {
			let _ = writeln!(md, "**Version:** {version}");
		}
		if let Some(installs) = installs {
			let _ = writeln!(md, "**Installs:** {}", format_number(installs));
		}
		if let Some(rating) = rating {
			let _ = writeln!(md, "**Rating:** {rating}");
		}
		let categories = arr_of(extension, "categories")
			.iter()
			.filter_map(Value::as_str)
			.collect::<Vec<_>>();
		if !categories.is_empty() {
			let _ = writeln!(md, "**Categories:** {}", categories.join(", "));
		}
		let tags = arr_of(extension, "tags")
			.iter()
			.filter_map(Value::as_str)
			.collect::<Vec<_>>();
		if !tags.is_empty() {
			let _ = writeln!(md, "**Tags:** {}", tags.join(", "));
		}
		if let Some(repo) = repo {
			let _ = writeln!(md, "**Repository:** {repo}");
		}
		Done::new(md, METHOD)
			.note("Fetched via VS Code Marketplace API")
			.finish()
	})
}

/// A string field, present even when empty (the TS handler tests nullishness).
fn opt_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
	value.get(key)?.as_str()
}

/// `statisticName` (trimmed, lowercased) to numeric value.
fn statistics(extension: &Value) -> HashMap<String, f64> {
	arr_of(extension, "statistics")
		.iter()
		.filter_map(|stat| {
			let name = stat.get("statisticName")?.as_str()?.trim().to_lowercase();
			let value = stat.get("value")?.as_f64()?;
			(!name.is_empty()).then_some((name, value))
		})
		.collect()
}

/// `4.5 (1.2K ratings)`, `4.5`, or `1.2K ratings`.
fn format_rating(average: Option<f64>, count: Option<f64>) -> Option<String> {
	let average = average.map(|average| {
		let mut formatted = format!("{average:.2}");
		if formatted.contains('.') {
			while formatted.ends_with('0') {
				formatted.pop();
			}
			if formatted.ends_with('.') {
				formatted.pop();
			}
		}
		formatted
	});
	match (average, count) {
		(Some(average), Some(count)) => Some(format!("{average} ({} ratings)", format_number(count))),
		(Some(average), None) => Some(average),
		(None, Some(count)) => Some(format!("{} ratings", format_number(count))),
		(None, None) => None,
	}
}

/// The first `http` property that names a source repository.
fn repo_link(props: &[Value]) -> Option<&str> {
	let pairs = props
		.iter()
		.filter_map(|prop| {
			let key = prop.get("key")?.as_str()?.trim();
			let value = prop.get("value")?.as_str()?.trim();
			(!key.is_empty() && value.starts_with("http")).then_some((key, value))
		})
		.collect::<Vec<_>>();
	for (key, value) in pairs.iter().copied() {
		let lower = key.to_lowercase();
		if lower.contains("links.source") || lower.contains("repository") {
			return Some(value);
		}
	}
	for (key, value) in pairs.iter().copied() {
		let lower = key.to_lowercase();
		if lower == "source" || lower.ends_with(".source") {
			return Some(value);
		}
	}
	None
}

/// Percent-decode a URL component (UTF-8, `%XX`).
fn decode(text: &str) -> String {
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
	(byte as char)
		.to_digit(16)
		.and_then(|digit| u8::try_from(digit).ok())
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::{
		super::{Fetched, testing::run},
		*,
	};

	fn gallery() -> Value {
		json!({ "results": [{ "extensions": [{
			"extensionName": "python", "displayName": "Python", "shortDescription": "IntelliSense, linting and debugging",
			"publisher": { "publisherName": "ms-python", "displayName": "Microsoft" },
			"versions": [{ "version": "2024.1.0", "properties": [
				{ "key": "Microsoft.VisualStudio.Services.Links.Source", "value": "https://github.com/microsoft/vscode-python" }
			] }],
			"statistics": [
				{ "statisticName": "install", "value": 123_456_789 },
				{ "statisticName": "averagerating", "value": 4.5 },
				{ "statisticName": "ratingCount", "value": 1_234 }
			],
			"categories": ["Programming Languages"], "tags": ["python", "python3"]
		}] }] })
	}

	#[test]
	fn an_item_queries_the_gallery_api() {
		let mut seen = None;
		let done =
			run("https://marketplace.visualstudio.com/items?itemName=ms-python.python", |request| {
				seen = Some(request.clone());
				Fetched::json(&gallery())
			})
			.unwrap();
		let request = seen.unwrap();
		assert_eq!(request.method, "POST");
		assert_eq!(request.url, API);
		let body: Value = serde_json::from_slice(request.body.as_deref().unwrap()).unwrap();
		assert_eq!(
			body.pointer("/filters/0/criteria/0").unwrap(),
			&json!({ "filterType": 7, "value": "ms-python.python" })
		);
		let accept = request
			.headers
			.iter()
			.find(|header| header.0 == "Accept")
			.unwrap();
		assert_eq!(accept.1, ACCEPT);

		assert_eq!(done.method, "vscode-marketplace");
		assert!(done.markdown.starts_with(
			"# Python\n\nIntelliSense, linting and debugging\n\n**Identifier:** ms-python.python\n**Publisher:** Microsoft (ms-python)\n**Version:** 2024.1.0\n**Installs:** 123M\n**Rating:** 4.5 (1.2K ratings)\n**Categories:** Programming Languages\n**Tags:** python, python3\n**Repository:** https://github.com/microsoft/vscode-python\n"
		));
	}

	#[test]
	fn other_urls_and_api_failures_fall_through() {
		for url in [
			"https://marketplace.visualstudio.com/items?itemName=python",
			"https://marketplace.visualstudio.com/search?itemName=ms-python.python",
			"https://example.com/items?itemName=ms-python.python",
		] {
			assert_eq!(run(url, |_| panic!("no fetch expected")), None);
		}
		assert_eq!(
			run("https://marketplace.visualstudio.com/items?itemName=ms-python.python", |_| {
				Fetched::json(&json!({ "results": [] }))
			}),
			None
		);
		assert_eq!(
			run("https://marketplace.visualstudio.com/items?itemName=ms-python.python", |_| {
				Fetched::status(500)
			}),
			None
		);
	}
}
