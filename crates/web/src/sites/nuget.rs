//! `NuGet` (`nuget.org`): the registration index for a package, the requested
//! or latest catalog entry, and total downloads from the search API.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, fetch, format_number, iso_date, segment, str_of,
	strs_of, u64_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "nuget", open };

const METHOD: &str = "nuget";
const REGISTRATION: &str = "https://api.nuget.org/v3/registration5-gz-semver2";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "www.nuget.org" | "nuget.org") {
		return None;
	}
	let path = url.path();
	if !path.get(..10)?.eq_ignore_ascii_case("/packages/") {
		return None;
	}
	let mut parts = path[10..].split('/');
	let package = percent_decode(parts.next()?);
	if package.is_empty() {
		return None;
	}
	let requested = parts
		.next()
		.filter(|version| !version.is_empty())
		.map(percent_decode);
	let index = format!("{REGISTRATION}/{}/index.json", package.to_lowercase());
	fetch(Fetch::get(index).accept_json(), move |reply, _| {
		let index = reply.json_value()?;
		let pages = arr_of(&index, "items").to_vec();
		if pages.is_empty() {
			return None;
		}
		walk(pages, Vec::new(), requested, package)
	})
}

/// Resolve registration pages in order, fetching those whose items are remote.
fn walk(
	pages: Vec<Value>,
	mut slots: Vec<Option<Vec<Value>>>,
	requested: Option<String>,
	package: String,
) -> Option<Action> {
	let Some(page) = pages.first().cloned() else {
		return finish(slots, requested, package);
	};
	let rest = pages[1..].to_vec();
	if let Some(items) = entries(&page) {
		slots.push(Some(items));
		return walk(rest, slots, requested, package);
	}
	if let Some(id) = str_of(&page, "@id").map(str::to_owned) {
		fetch(Fetch::get(id).accept_json(), move |reply, _| {
			slots.push(reply.json_value().as_ref().and_then(entries));
			walk(rest, slots, requested, package)
		})
	} else {
		slots.push(None);
		walk(rest, slots, requested, package)
	}
}

fn entries(page: &Value) -> Option<Vec<Value>> {
	page.get("items").and_then(Value::as_array).cloned()
}

/// Pick the requested or latest catalog entry, then fetch total downloads.
fn finish(
	slots: Vec<Option<Vec<Value>>>,
	requested: Option<String>,
	package: String,
) -> Option<Action> {
	let latest = slots
		.last()?
		.as_ref()
		.filter(|items| !items.is_empty())?
		.clone();
	let target = requested
		.as_deref()
		.and_then(|version| find_version(&slots, version))
		.or_else(|| {
			latest
				.last()
				.and_then(|item| item.get("catalogEntry").cloned())
		})?;
	let query = format!(
		"https://api.nuget.org/v3/query?q=packageid:{}&prerelease=true&take=1",
		segment(&package)
	);
	fetch(Fetch::get(query).accept_json(), move |reply, _| {
		let downloads = reply.json_value().and_then(|data| {
			arr_of(&data, "data")
				.first()
				.and_then(|entry| u64_of(entry, "totalDownloads"))
		});
		let markdown = render(&target, &latest, downloads);
		Done::new(markdown, METHOD)
			.title(str_of(&target, "id").unwrap_or_default())
			.note("Fetched via NuGet API")
			.finish()
	})
}

fn find_version(slots: &[Option<Vec<Value>>], version: &str) -> Option<Value> {
	slots.iter().flatten().flatten().find_map(|item| {
		let entry = item.get("catalogEntry")?;
		let candidate = str_of(entry, "version")?;
		candidate
			.eq_ignore_ascii_case(version)
			.then(|| entry.clone())
	})
}

fn render(entry: &Value, latest: &[Value], downloads: Option<u64>) -> String {
	let mut md = format!("# {}\n\n", str_of(entry, "id").unwrap_or_default());
	if let Some(description) = str_of(entry, "description") {
		let _ = write!(md, "{description}\n\n");
	}
	let _ = write!(md, "**Version:** {}", str_of(entry, "version").unwrap_or("?"));
	if let Some(license) = str_of(entry, "licenseExpression") {
		let _ = write!(md, " · **License:** {license}");
	} else if let Some(url) = str_of(entry, "licenseUrl") {
		let _ = write!(md, " · **License:** [View]({url})");
	}
	md.push('\n');
	if let Some(total) = downloads {
		let _ = writeln!(md, "**Total Downloads:** {}", format_number(total as f64));
	}
	if let Some(authors) = str_of(entry, "authors") {
		let _ = writeln!(md, "**Authors:** {authors}");
	}
	if let Some(project) = str_of(entry, "projectUrl") {
		let _ = writeln!(md, "**Project URL:** {project}");
	}
	let tags = strs_of(entry, "tags");
	if !tags.is_empty() {
		let _ = writeln!(md, "**Tags:** {}", tags.join(", "));
	}
	if let Some(published) = str_of(entry, "published").and_then(iso_date) {
		let _ = writeln!(md, "**Published:** {published}");
	}

	let groups = arr_of(entry, "dependencyGroups");
	if groups
		.iter()
		.any(|group| !arr_of(group, "dependencies").is_empty())
	{
		md.push_str("\n## Dependencies\n\n");
		for group in groups {
			let dependencies = arr_of(group, "dependencies");
			if dependencies.is_empty() {
				continue;
			}
			let _ =
				write!(md, "### {}\n\n", str_of(group, "targetFramework").unwrap_or("All Frameworks"));
			for dependency in dependencies {
				let _ = writeln!(
					md,
					"- {} ({})",
					str_of(dependency, "id").unwrap_or_default(),
					str_of(dependency, "range").unwrap_or_default()
				);
			}
			md.push('\n');
		}
	}

	if latest.len() > 1 {
		md.push_str("## Recent Versions\n\n");
		for item in latest.iter().rev().take(5) {
			let entry = item.get("catalogEntry");
			let version = entry
				.and_then(|entry| str_of(entry, "version"))
				.unwrap_or("?");
			let published = entry
				.and_then(|entry| str_of(entry, "published"))
				.and_then(iso_date)
				.unwrap_or("unknown");
			let _ = writeln!(md, "- **{version}** ({published})");
		}
	}
	md
}

/// Decode `%XX` escapes; invalid escapes pass through.
fn percent_decode(text: &str) -> String {
	let bytes = text.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] == b'%'
			&& index + 2 < bytes.len()
			&& let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2]))
		{
			out.push(high << 4 | low);
			index += 3;
		} else {
			out.push(bytes[index]);
			index += 1;
		}
	}
	String::from_utf8_lossy(&out).into_owned()
}

const fn hex(byte: u8) -> Option<u8> {
	match byte {
		b'0'..=b'9' => Some(byte - b'0'),
		b'a'..=b'f' => Some(byte - b'a' + 10),
		b'A'..=b'F' => Some(byte - b'A' + 10),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::{
		super::{Fetched, testing::run},
		*,
	};

	fn index_with(items: Value) -> Value {
		json!({ "items": [{ "items": items }] })
	}

	#[test]
	fn a_package_reads_the_registration_index_and_download_search() {
		let items = json!([
			{ "catalogEntry": { "id": "Newtonsoft.Json", "version": "12.0.1", "published": "2018-03-01T00:00:00Z",
				"dependencyGroups": [{ "targetFramework": ".NETStandard2.0",
					"dependencies": [{ "id": "System.Text.Json", "range": "4.7.0" }] }] } },
			{ "catalogEntry": { "id": "Newtonsoft.Json", "version": "13.0.3", "authors": "James Newton-King",
				"description": "Json.NET is a popular high-performance JSON framework for .NET",
				"licenseExpression": "MIT", "projectUrl": "https://www.newtonsoft.com/json",
				"tags": ["json"], "published": "2023-03-08T00:00:00Z" } }
		]);
		let mut requests = Vec::new();
		let done = run("https://www.nuget.org/packages/Newtonsoft.Json", |request| {
			requests.push(request.url.clone());
			if request.url.ends_with("/index.json") {
				Fetched::json(&index_with(items.clone()))
			} else {
				Fetched::json(&json!({ "data": [{ "totalDownloads": 3_400_000_000u64 }] }))
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://api.nuget.org/v3/registration5-gz-semver2/newtonsoft.json/index.json",
			"https://api.nuget.org/v3/query?q=packageid:Newtonsoft.Json&prerelease=true&take=1"
		]);
		assert_eq!((done.method, done.title.as_deref()), ("nuget", Some("Newtonsoft.Json")));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# Newtonsoft.Json\n\nJson.NET is a popular high-performance JSON framework for \
			 .NET\n\n**Version:** 13.0.3 · **License:** MIT\n**Total Downloads:** 3.4B\n"
		));
		assert!(md.contains("**Authors:** James Newton-King\n**Project URL:** https://www.newtonsoft.com/json\n**Tags:** json\n**Published:** 2023-03-08\n"));
		assert!(
			md.contains(
				"## Recent Versions\n\n- **13.0.3** (2023-03-08)\n- **12.0.1** (2018-03-01)\n"
			)
		);
	}

	#[test]
	fn a_remote_page_is_fetched_and_a_requested_version_is_selected() {
		let page = json!({ "items": [
			{ "catalogEntry": { "id": "Example", "version": "1.0.0", "published": "2020-01-01T00:00:00Z" } },
			{ "catalogEntry": { "id": "Example", "version": "1.1.0", "published": "2021-01-01T00:00:00Z" } }
		] });
		let mut requests = Vec::new();
		let done = run("https://www.nuget.org/packages/Example/1.0.0", |request| {
			requests.push(request.url.clone());
			if request.url.ends_with("/index.json") {
				Fetched::json(&json!({ "items": [{ "@id": "https://api.nuget.org/v3/registration5-gz-semver2/example/page/1.json" }] }))
			} else if request.url.contains("/page/") {
				Fetched::json(&page)
			} else {
				Fetched::json(&json!({ "data": [] }))
			}
		})
		.unwrap();
		assert_eq!(
			requests[1],
			"https://api.nuget.org/v3/registration5-gz-semver2/example/page/1.json"
		);
		assert!(
			done
				.markdown
				.starts_with("# Example\n\n**Version:** 1.0.0\n")
		);
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(
			run("https://www.nuget.org/profiles/example", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(run("https://www.nuget.org/packages/Example", |_| Fetched::status(404)), None);
		assert_eq!(
			run("https://www.nuget.org/packages/Example", |_| {
				Fetched::json(&json!({ "items": [{ "items": [] }] }))
			}),
			None
		);
	}
}
