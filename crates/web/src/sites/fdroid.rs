//! F-Droid (`f-droid.org/packages/<app>`): package metadata from the F-Droid
//! API, with localized name, summary and description.

use std::{fmt::Write as _, sync::LazyLock};

use regex::Regex;
use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, fetch, segment, str_of, u64_of};

/// Registry entry.
pub const SITE: Site = Site { name: "fdroid", open };

const METHOD: &str = "fdroid";

static PACKAGE_PATH: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^/(?:en/)?packages/([^/]+)").unwrap());

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "f-droid.org" | "www.f-droid.org") {
		return None;
	}
	let package = percent_decode(PACKAGE_PATH.captures(url.path())?.get(1)?.as_str());
	if package.is_empty() {
		return None;
	}
	fetch(
		Fetch::get(format!("https://f-droid.org/api/v1/packages/{}", segment(&package)))
			.accept_json(),
		move |reply, _| {
			let data = reply.json_value()?;
			let display_name = localized(data.get("name")).unwrap_or_else(|| package.clone());
			let summary = localized(data.get("summary"));
			let description = localized(data.get("description"));
			let author = author(&data).map(str::to_owned);
			let email = author_email(&data).map(str::to_owned);
			let features = anti_features(&data);

			let mut md = format!("# {display_name}\n\n");
			if let Some(summary) = &summary {
				let _ = write!(md, "{summary}\n\n");
			}
			let _ = write!(md, "**Package:** {package}");
			if let Some(version) = suggested_version(&data) {
				let _ = write!(md, " · **Latest:** {version}");
			}
			if let Some(license) = str_of(&data, "license") {
				let _ = write!(md, " · **License:** {license}");
			}
			md.push('\n');
			if let Some(author) = &author {
				let _ = write!(md, "**Author:** {author}");
				if let Some(email) = &email
					&& email != author
				{
					let _ = write!(md, " <{email}>");
				}
				md.push('\n');
			}
			if let Some(source) = str_of(&data, "sourceCode") {
				let _ = writeln!(md, "**Source Code:** {source}");
			}
			let categories = strs(&data, "categories");
			if !categories.is_empty() {
				let _ = writeln!(md, "**Categories:** {}", categories.join(", "));
			}
			if !features.is_empty() {
				let _ = writeln!(md, "**Anti-Features:** {}", features.join(", "));
			}
			if let Some(description) = &description {
				let _ = write!(md, "\n## Description\n\n{description}\n");
			}

			let packages = arr_of(&data, "packages");
			if !packages.is_empty() {
				md.push_str("\n## Version History\n\n");
				for version in packages.iter().take(10) {
					let label = str_of(version, "versionName").unwrap_or("unknown");
					match u64_of(version, "versionCode").filter(|code| *code > 0) {
						Some(code) => {
							let _ = writeln!(md, "- {label} ({code})");
						},
						None => {
							let _ = writeln!(md, "- {label}");
						},
					}
				}
			}

			Done::new(md, METHOD)
				.title(display_name)
				.note("Fetched via F-Droid API")
				.finish()
		},
	)
}

/// Localized text: `en-US`, then `en_US`, then `en`, then any string value.
fn localized(value: Option<&Value>) -> Option<String> {
	match value? {
		Value::String(text) => Some(text.clone()),
		Value::Object(map) => ["en-US", "en_US", "en"]
			.iter()
			.find_map(|locale| {
				map.get(*locale)
					.and_then(Value::as_str)
					.filter(|text| !text.is_empty())
			})
			.or_else(|| map.values().find_map(|value| value.as_str()))
			.map(str::to_owned),
		_ => None,
	}
}

/// Non-empty strings of the array at `key`, untrimmed.
fn strs<'a>(value: &'a Value, key: &str) -> Vec<&'a str> {
	arr_of(value, key)
		.iter()
		.filter_map(Value::as_str)
		.filter(|text| !text.is_empty())
		.collect()
}

fn author(data: &Value) -> Option<&str> {
	str_of(data, "authorName")
		.or_else(|| {
			data
				.get("author")
				.and_then(Value::as_str)
				.map(str::trim)
				.filter(|name| !name.is_empty())
		})
		.or_else(|| data.get("author").and_then(|author| str_of(author, "name")))
		.or_else(|| str_of(data, "authorEmail"))
}

fn author_email(data: &Value) -> Option<&str> {
	str_of(data, "authorEmail").or_else(|| {
		data
			.get("author")
			.and_then(|author| str_of(author, "email"))
	})
}

/// Anti-features of the app and of every listed version, first-seen order.
fn anti_features(data: &Value) -> Vec<String> {
	let mut out: Vec<String> = Vec::new();
	let mut add = |value: &Value| {
		for feature in arr_of(value, "antiFeatures")
			.iter()
			.filter_map(Value::as_str)
		{
			if !out.iter().any(|existing| existing == feature) {
				out.push(feature.to_owned());
			}
		}
	};
	add(data);
	for package in arr_of(data, "packages") {
		add(package);
	}
	out
}

fn suggested_version(data: &Value) -> Option<&str> {
	if let Some(name) = str_of(data, "suggestedVersionName") {
		return Some(name);
	}
	if let Some(code) = u64_of(data, "suggestedVersionCode").filter(|code| *code > 0) {
		let version = arr_of(data, "packages")
			.iter()
			.find(|package| u64_of(package, "versionCode") == Some(code));
		if let Some(name) = version.and_then(|version| str_of(version, "versionName")) {
			return Some(name);
		}
	}
	arr_of(data, "packages")
		.first()
		.and_then(|package| str_of(package, "versionName"))
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
	fn a_package_page_reads_the_localized_metadata() {
		let data = json!({
			"packageName": "org.fdroid.fdroid", "license": "GPL-3.0-or-later",
			"name": { "en-US": "F-Droid", "de": "F-Droid DE" },
			"summary": { "en-US": "An app store" },
			"description": { "en-US": "Install and update apps." },
			"author": { "name": "The F-Droid Team", "email": "team@f-droid.org" },
			"sourceCode": "https://gitlab.com/fdroid/fdroidclient",
			"categories": ["System"], "antiFeatures": ["NonFreeNet"],
			"suggestedVersionCode": 10_200_000,
			"packages": [
				{ "versionName": "1.2", "versionCode": 10_200_000, "antiFeatures": ["Tracking"] },
				{ "versionName": "1.1", "versionCode": 10_100_000 }
			]
		});
		let mut requests = Vec::new();
		let done = run("https://f-droid.org/en/packages/org.fdroid.fdroid/", |request| {
			requests.push(request.url.clone());
			Fetched::json(&data)
		})
		.unwrap();
		assert_eq!(requests, ["https://f-droid.org/api/v1/packages/org.fdroid.fdroid"]);
		assert_eq!((done.method, done.title.as_deref()), ("fdroid", Some("F-Droid")));
		let md = &done.markdown;
		assert!(md.starts_with("# F-Droid\n\nAn app store\n\n**Package:** org.fdroid.fdroid · **Latest:** 1.2 · **License:** GPL-3.0-or-later\n**Author:** The F-Droid Team <team@f-droid.org>\n**Source Code:** https://gitlab.com/fdroid/fdroidclient\n**Categories:** System\n**Anti-Features:** NonFreeNet, Tracking\n\n## Description\n\nInstall and update apps.\n\n## Version History\n\n- 1.2 (10200000)\n- 1.1 (10100000)\n"));
	}

	#[test]
	fn a_plain_package_name_falls_back_to_its_path() {
		let data = json!({ "packages": [{ "versionName": "0.1", "versionCode": 1 }] });
		let done =
			run("https://www.f-droid.org/packages/com.example%20app", |_| Fetched::json(&data))
				.unwrap();
		assert_eq!(done.title.as_deref(), Some("com.example app"));
		assert!(done.markdown.starts_with(
			"# com.example app\n\n**Package:** com.example app · **Latest:** 0.1\n\n## Version \
			 History\n\n- 0.1 (1)\n"
		));
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://f-droid.org/", |_| panic!("no fetch expected")), None);
		assert_eq!(
			run("https://example.test/packages/org.example", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(run("https://f-droid.org/packages/org.example", |_| Fetched::status(503)), None);
	}
}
