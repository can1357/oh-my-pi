//! Flathub (`flathub.org/apps/<id>`): app metadata, description, permissions,
//! screenshots and releases from the Flathub `AppStream` API.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, fetch, format_number, html_to_markdown, segment,
	str_of, unix_date,
};

/// Registry entry.
pub const SITE: Site = Site { name: "flathub", open };

const METHOD: &str = "flathub-appstream";
/// Screenshots listed.
const SCREENSHOTS: usize = 5;
/// Releases listed.
const RELEASES: usize = 5;

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "flathub.org" | "www.flathub.org") {
		return None;
	}
	let app_id = app_id(url.path())?;
	let request = Fetch::get(format!("https://flathub.org/api/v2/appstream/{}", segment(&app_id)))
		.accept_json();
	fetch(request, move |reply, _| {
		let app = reply.json_value()?;
		let (name, markdown) = summary(&app_id, &app);
		Done::new(markdown, METHOD)
			.title(name)
			.note("Fetched via Flathub Appstream API")
			.finish()
	})
}

/// App id of `/apps/<id>` and `/apps/details/<id>`, percent-decoded.
fn app_id(path: &str) -> Option<String> {
	let rest = path
		.strip_prefix("/apps/details/")
		.or_else(|| path.strip_prefix("/apps/"))?;
	let id = rest.strip_suffix('/').unwrap_or(rest);
	if id.is_empty() || id.contains('/') {
		return None;
	}
	decode_component(id)
}

/// Percent-decode a path segment, as `decodeURIComponent` does (`None` on a
/// malformed escape, which the TS handler treated as an unusable URL).
fn decode_component(text: &str) -> Option<String> {
	let bytes = text.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] == b'%' {
			let hex = std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?;
			out.push(u8::from_str_radix(hex, 16).ok()?);
			index += 3;
		} else {
			out.push(bytes[index]);
			index += 1;
		}
	}
	String::from_utf8(out).ok()
}

/// Title and Markdown of an `AppStream` record.
fn summary(app_id: &str, app: &Value) -> (String, String) {
	let name = str_of(app, "name")
		.or_else(|| str_of(app, "id"))
		.unwrap_or(app_id)
		.to_owned();
	let mut md = format!("# {name}\n\n");
	if let Some(summary) = str_of(app, "summary") {
		let _ = write!(md, "{summary}\n\n");
	}

	md.push_str("## Metadata\n\n");
	let _ = writeln!(md, "**App ID:** {}", str_of(app, "id").unwrap_or(app_id));
	if let Some(developer) = str_of(app, "developer_name") {
		let _ = writeln!(md, "**Developer:** {developer}");
	}
	if let Some(installs) = installs(app) {
		let _ = writeln!(md, "**Installs:** {}", format_number(installs));
	}

	let categories = arr_of(app, "categories");
	if !categories.is_empty() {
		md.push_str("\n## Categories\n\n");
		for category in categories {
			if let Some(category) = category.as_str() {
				let _ = writeln!(md, "- {category}");
			}
		}
	}

	if let Some(description) = str_of(app, "description").map(|html| html_to_markdown(html, None)) {
		let description = description.trim();
		if !description.is_empty() {
			let _ = write!(md, "\n## Description\n\n{description}\n");
		}
	}

	let permissions = permissions(app);
	if !permissions.is_empty() {
		md.push_str("\n## Permissions\n\n");
		for permission in &permissions {
			let _ = writeln!(md, "- {permission}");
		}
	}

	let screenshots = arr_of(app, "screenshots");
	if !screenshots.is_empty() {
		md.push_str("\n## Screenshots\n\n");
		for screenshot in screenshots.iter().take(SCREENSHOTS) {
			let Some(source) =
				best_screenshot(arr_of(screenshot, "sizes")).filter(|source| !source.is_empty())
			else {
				continue;
			};
			let _ = write!(md, "- {source}");
			if let Some(caption) = str_of(screenshot, "caption") {
				let _ = write!(md, " - {caption}");
			}
			md.push('\n');
		}
	}

	let releases = arr_of(app, "releases");
	if !releases.is_empty() {
		md.push_str("\n## Releases\n\n");
		for release in releases.iter().take(RELEASES) {
			let _ = write!(md, "- **{}**", str_of(release, "version").unwrap_or("unknown"));
			if let Some(date) = release_date(release) {
				let _ = write!(md, " ({date})");
			}
			if let Some(kind) = str_of(release, "type") {
				let _ = write!(md, " · {kind}");
			}
			if let Some(link) = str_of(release, "url") {
				let _ = write!(md, " · {link}");
			}
			md.push('\n');
			if let Some(description) =
				str_of(release, "description").map(|html| html_to_markdown(html, None))
			{
				let description = one_line(&description);
				if !description.is_empty() {
					let _ = writeln!(md, "  - {description}");
				}
			}
		}
	}

	(name, md)
}

/// Release date from a Unix-seconds `timestamp` field.
fn release_date(release: &Value) -> Option<String> {
	let seconds = match release.get("timestamp")? {
		Value::Number(number) => number.as_f64().filter(|secs| *secs != 0.0),
		Value::String(text) if !text.is_empty() => text.trim().parse().ok(),
		_ => return None,
	}?;
	Some(unix_date(seconds as i64))
}

/// Install count, from `installs` or the first `metadata` key naming installs.
fn installs(app: &Value) -> Option<f64> {
	if let Some(installs) = parse_number(app.get("installs")) {
		return Some(installs);
	}
	let metadata = app.get("metadata")?.as_object()?;
	metadata
		.iter()
		.filter(|(key, _)| key.to_lowercase().contains("install"))
		.find_map(|(_, value)| parse_number(Some(value)))
}

/// Permission list, deduplicated: `permissions` plus `metadata` permission
/// keys.
fn permissions(app: &Value) -> Vec<String> {
	let mut out: Vec<String> = Vec::new();
	for value in string_list(app.get("permissions")) {
		if !out.contains(&value) {
			out.push(value);
		}
	}
	let Some(metadata) = app.get("metadata").and_then(Value::as_object) else {
		return out;
	};
	for (key, value) in metadata {
		if !key.to_lowercase().contains("permission") {
			continue;
		}
		let list = string_list(Some(value));
		if !list.is_empty() {
			for value in list {
				if !out.contains(&value) {
					out.push(value);
				}
			}
			continue;
		}
		let scalar = match value {
			Value::String(text) => text.clone(),
			Value::Number(number) => number.to_string(),
			Value::Bool(flag) => flag.to_string(),
			_ => continue,
		};
		let entry = format!("{key}: {scalar}");
		if !out.contains(&entry) {
			out.push(entry);
		}
	}
	out
}

/// Strings of an array value, or of a `,`/`;`/newline-separated string value.
fn string_list(value: Option<&Value>) -> Vec<String> {
	match value {
		Some(Value::Array(items)) => items
			.iter()
			.filter_map(Value::as_str)
			.filter(|item| !item.trim().is_empty())
			.map(str::to_owned)
			.collect(),
		Some(Value::String(text)) => text
			.split([',', ';', '\n'])
			.map(str::trim)
			.filter(|item| !item.is_empty())
			.map(str::to_owned)
			.collect(),
		_ => Vec::new(),
	}
}

/// Number of a JSON value the way `parseNumber` reads it: digits of a string
/// are kept, anything else is not a count.
fn parse_number(value: Option<&Value>) -> Option<f64> {
	match value? {
		Value::Number(number) => number.as_f64().filter(|number| number.is_finite()),
		Value::String(text) => {
			let cleaned: String = text
				.chars()
				.filter(|ch| ch.is_ascii_digit() || *ch == '.')
				.collect();
			if cleaned.is_empty() {
				return None;
			}
			cleaned
				.parse::<f64>()
				.ok()
				.filter(|number| number.is_finite())
		},
		_ => None,
	}
}

/// Largest screenshot of a sizes array.
fn best_screenshot(sizes: &[Value]) -> Option<String> {
	let first = sizes.first()?;
	let mut best = first;
	let mut best_area = screenshot_area(first);
	for size in sizes {
		let area = screenshot_area(size);
		if area > best_area {
			best = size;
			best_area = area;
		}
	}
	best
		.get("src")
		.and_then(Value::as_str)
		.or_else(|| first.get("src").and_then(Value::as_str))
		.map(str::to_owned)
}

/// Pixel area of a size entry; 0 for unreadable dimensions.
fn screenshot_area(size: &Value) -> f64 {
	let width = number(size.get("width"));
	let height = number(size.get("height"));
	if width.is_finite() && height.is_finite() {
		width * height
	} else {
		0.0
	}
}

/// JavaScript `Number(value)`: `NaN` when the value has no numeric reading.
fn number(value: Option<&Value>) -> f64 {
	match value {
		None | Some(Value::Null) => 0.0,
		Some(Value::Bool(flag)) => {
			if *flag {
				1.0
			} else {
				0.0
			}
		},
		Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
		Some(Value::String(text)) => text.trim().parse().unwrap_or(f64::NAN),
		Some(Value::Array(_) | Value::Object(_)) => f64::NAN,
	}
}

/// Replace newline runs with a space and trim.
fn one_line(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	let mut newline = false;
	for ch in text.chars() {
		if ch == '\n' {
			newline = true;
			continue;
		}
		if newline {
			out.push(' ');
			newline = false;
		}
		out.push(ch);
	}
	out.trim().to_owned()
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::{
		super::{Fetched, testing::run},
		*,
	};

	fn app() -> Value {
		json!({
			"id": "org.mozilla.firefox", "name": "Firefox", "summary": "Fast, private browser",
			"developer_name": "Mozilla", "installs": 3_400_000,
			"categories": ["Network", "WebBrowser"],
			"description": "<p>Firefox is a browser.</p>",
			"permissions": ["network", "shares"],
			"metadata": { "permissions": "device", "other": "x" },
			"screenshots": [
				{ "caption": "Browsing", "sizes": [
					{ "src": "https://dl.flathub.org/small.png", "width": "752", "height": "423" },
					{ "src": "https://dl.flathub.org/big.png", "width": "1248", "height": "702" }
				] },
				{ "sizes": [] }
			],
			"releases": [
				{ "version": "128.0", "timestamp": "1722902400", "type": "stable", "url": "https://mozilla.org/x",
				  "description": "<p>Faster\n\nthan before</p>" },
				{ "timestamp": "" }
			]
		})
	}

	#[test]
	fn an_app_page_renders_the_appstream_record() {
		let done = run("https://flathub.org/apps/details/org.mozilla.firefox", |request| {
			assert_eq!(request.url, "https://flathub.org/api/v2/appstream/org.mozilla.firefox");
			assert_eq!(request.method, "GET");
			Fetched::json(&app())
		})
		.unwrap();
		assert_eq!((done.method, done.title.as_deref()), ("flathub-appstream", Some("Firefox")));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# Firefox\n\nFast, private browser\n\n## Metadata\n\n**App ID:** org.mozilla.firefox\n"
		));
		assert!(md.contains("**Developer:** Mozilla\n**Installs:** 3.4M\n"));
		assert!(md.contains("\n## Categories\n\n- Network\n- WebBrowser\n"));
		assert!(md.contains("\n## Description\n\nFirefox is a browser.\n"));
		assert!(md.contains("\n## Permissions\n\n- network\n- shares\n- device\n"));
		assert!(md.contains("\n## Screenshots\n\n- https://dl.flathub.org/big.png - Browsing\n"));
		assert!(md.contains(
			"\n## Releases\n\n- **128.0** (2024-08-06) · stable · https://mozilla.org/x\n  - Faster \
			 than before\n- **unknown**\n"
		));
		assert_eq!(done.notes, ["Fetched via Flathub Appstream API"]);
	}

	#[test]
	fn metadata_installs_are_read_when_installs_is_absent() {
		let done = run("https://www.flathub.org/apps/org.mozilla.firefox", |_| {
			Fetched::json(&json!({ "name": "Firefox", "metadata": { "installs_total": "1,234" } }))
		})
		.unwrap();
		assert!(done.markdown.contains("**Installs:** 1.2K\n"));
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://flathub.org/", |_| panic!("no fetch expected")), None);
		assert_eq!(
			run("https://flathub.org/apps/details/a/b", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(
			run("https://example.test/apps/org.mozilla.firefox", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(
			run("https://flathub.org/apps/org.mozilla.firefox", |_| Fetched::status(404)),
			None
		);
	}
}
