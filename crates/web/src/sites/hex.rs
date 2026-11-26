//! Hex.pm (`hex.pm/packages/<name>`): package metadata, download counts and
//! links from the Hex API, then the latest release's requirements.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Fetched, Site, arr_of, fetch, format_number, iso_date, segment,
	str_of, strs_of, u64_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "hex", open };

const METHOD: &str = "hex";
const NOTE: &str = "Fetched via Hex.pm API";
/// Releases listed.
const RELEASES: usize = 10;

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "hex.pm" | "www.hex.pm") {
		return None;
	}
	let name = package_name(url.path())?;
	let packages = format!("https://hex.pm/api/packages/{}", segment(&name));
	fetch(Fetch::get(packages).accept_json(), move |reply, _| {
		let data = reply.json_value()?;
		let version = str_of(&data, "latest_stable_version")
			.or_else(|| str_of(&data, "latest_version"))
			.unwrap_or("unknown")
			.to_owned();
		let head = summary(&name, &data, &version);
		let releases = arr_of(&data, "releases").to_vec();
		if releases.is_empty() {
			return Done::new(head, METHOD).title(name).note(NOTE).finish();
		}
		let latest =
			format!("https://hex.pm/api/packages/{}/releases/{}", segment(&name), segment(&version));
		fetch(Fetch::get(latest).accept_json(), move |reply, _| {
			let mut md = head;
			if let Some(dependencies) = dependencies(&reply, &version) {
				md.push_str(&dependencies);
			}
			md.push_str(&recent(&releases));
			Done::new(md, METHOD).title(name).note(NOTE).finish()
		})
	})
}

/// Package name of `/packages/<name>`, percent-decoded.
fn package_name(path: &str) -> Option<String> {
	let rest = path.strip_prefix("/packages/")?;
	let name = rest.split('/').next()?;
	if name.is_empty() {
		return None;
	}
	decode_component(name)
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

/// Header Markdown of the package record.
fn summary(fallback: &str, data: &Value, version: &str) -> String {
	let mut md = format!("# {}\n\n", str_of(data, "name").unwrap_or(fallback));
	let meta = data.get("meta");
	if let Some(description) = meta.and_then(|meta| str_of(meta, "description")) {
		let _ = write!(md, "{description}\n\n");
	}

	let _ = write!(md, "**Latest:** {version}");
	let licenses = meta.map_or_else(Vec::new, |meta| strs_of(meta, "licenses"));
	if !licenses.is_empty() {
		let _ = write!(md, " · **License:** {}", licenses.join(", "));
	}
	md.push('\n');

	let downloads = data.get("downloads");
	if let Some(all) = downloads
		.and_then(|downloads| u64_of(downloads, "all"))
		.filter(|all| *all > 0)
	{
		let _ = write!(md, "**Total Downloads:** {}", format_number(all as f64));
		if let Some(week) = downloads
			.and_then(|downloads| u64_of(downloads, "week"))
			.filter(|week| *week > 0)
		{
			let _ = write!(md, " · **This Week:** {}", format_number(week as f64));
		}
		md.push('\n');
	}
	md.push('\n');

	let links = meta
		.and_then(|meta| meta.get("links"))
		.and_then(Value::as_object);
	if let Some(links) = links.filter(|links| !links.is_empty()) {
		md.push_str("## Links\n\n");
		for (key, value) in links {
			let _ = writeln!(md, "- **{key}:** {}", value.as_str().unwrap_or_default());
		}
		md.push('\n');
	}
	md
}

/// Requirements section of the latest release, when the API returns them.
fn dependencies(reply: &Fetched, version: &str) -> Option<String> {
	let data = reply.json_value()?;
	let requirements = data.get("requirements")?.as_object()?;
	if requirements.is_empty() {
		return None;
	}
	let mut md = format!("## Dependencies ({version})\n\n");
	for (name, info) in requirements {
		let requirement = info
			.get("requirement")
			.and_then(Value::as_str)
			.unwrap_or_default();
		let optional = if info
			.get("optional")
			.and_then(Value::as_bool)
			.unwrap_or(false)
		{
			" (optional)"
		} else {
			""
		};
		let _ = writeln!(md, "- {name}: {requirement}{optional}");
	}
	md.push('\n');
	Some(md)
}

/// Recent releases of the package record.
fn recent(releases: &[Value]) -> String {
	let mut md = String::from("## Recent Releases\n\n");
	for release in releases.iter().take(RELEASES) {
		let date = str_of(release, "inserted_at")
			.and_then(iso_date)
			.unwrap_or_default();
		let _ = writeln!(md, "- **{}** ({date})", str_of(release, "version").unwrap_or_default());
	}
	md
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::{super::testing::run, *};

	fn package() -> Value {
		json!({
			"name": "phoenix",
			"meta": {
				"description": "Peace of mind from prototype to production",
				"licenses": ["MIT"],
				"links": { "GitHub": "https://github.com/phoenixframework/phoenix", "Docs": "https://hexdocs.pm/phoenix" }
			},
			"downloads": { "all": 456_789_012, "week": 12_345, "day": 1 },
			"latest_version": "1.7.14",
			"latest_stable_version": "1.7.14",
			"releases": [
				{ "version": "1.7.14", "inserted_at": "2024-05-01T00:00:00Z" },
				{ "version": "1.7.13", "inserted_at": "2024-04-01T00:00:00Z" }
			]
		})
	}

	#[test]
	fn a_package_page_renders_metadata_requirements_and_releases() {
		let mut requests = Vec::new();
		let done = run("https://hex.pm/packages/phoenix", |request| {
			requests.push(request.url.clone());
			if request.url.ends_with("/phoenix") {
				Fetched::json(&package())
			} else {
				Fetched::json(&json!({
					"requirements": {
						"plug": { "app": "plug", "optional": false, "requirement": "~> 1.14" },
						"telemetry": { "app": "telemetry", "optional": true, "requirement": "~> 1.0" }
					}
				}))
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://hex.pm/api/packages/phoenix",
			"https://hex.pm/api/packages/phoenix/releases/1.7.14"
		]);
		assert_eq!((done.method, done.title.as_deref()), ("hex", Some("phoenix")));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# phoenix\n\nPeace of mind from prototype to production\n\n**Latest:** 1.7.14 · \
			 **License:** MIT\n"
		));
		assert!(md.contains("**Total Downloads:** 457M · **This Week:** 12K\n\n"));
		assert!(md.contains("## Links\n\n- **GitHub:** https://github.com/phoenixframework/phoenix\n- **Docs:** https://hexdocs.pm/phoenix\n\n"));
		assert!(md.contains(
			"## Dependencies (1.7.14)\n\n- plug: ~> 1.14\n- telemetry: ~> 1.0 (optional)\n\n"
		));
		assert!(
			md.contains(
				"## Recent Releases\n\n- **1.7.14** (2024-05-01)\n- **1.7.13** (2024-04-01)\n"
			)
		);
		assert_eq!(done.notes, ["Fetched via Hex.pm API"]);
	}

	#[test]
	fn a_package_without_releases_takes_one_request_and_a_failed_lookup_lists_releases() {
		let done = run("https://hex.pm/packages/phoenix", |request| {
			assert_eq!(request.url, "https://hex.pm/api/packages/phoenix");
			Fetched::json(&json!({ "name": "phoenix" }))
		})
		.unwrap();
		assert!(
			done
				.markdown
				.starts_with("# phoenix\n\n**Latest:** unknown\n\n")
		);

		let done = run("https://www.hex.pm/packages/phoenix", |request| {
			if request.url.ends_with("/phoenix") {
				Fetched::json(&package())
			} else {
				Fetched::status(500)
			}
		})
		.unwrap();
		assert!(!done.markdown.contains("## Dependencies"));
		assert!(
			done
				.markdown
				.contains("## Recent Releases\n\n- **1.7.14** (2024-05-01)\n")
		);
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://hex.pm/", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://hex.pm/invalid", |_| panic!("no fetch expected")), None);
		assert_eq!(
			run("https://example.test/packages/phoenix", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(run("https://hex.pm/packages/phoenix", |_| Fetched::status(404)), None);
	}
}
