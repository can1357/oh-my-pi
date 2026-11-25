//! Packagist (`packagist.org/packages/<vendor>/<name>`): package metadata and
//! the latest stable version from the Packagist JSON API.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, f64_of, fetch, format_number, str_of, strs_of,
	u64_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "packagist", open };

const METHOD: &str = "packagist";
/// Dev branches that never count as a stable release.
const DEV_BRANCHES: [&str; 2] = ["dev-master", "dev-main"];

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "packagist.org" | "www.packagist.org") {
		return None;
	}
	let mut segments = url.path_segments()?;
	if segments.next()? != "packages" {
		return None;
	}
	let vendor = decode(segments.next()?);
	let package = decode(segments.next()?);
	if vendor.is_empty() || package.is_empty() {
		return None;
	}
	fetch(
		Fetch::get(format!("https://packagist.org/packages/{vendor}/{package}.json")).accept_json(),
		move |reply, _| {
			let data = reply.json_value()?;
			let pkg = data.get("package")?;
			let title = str_of(pkg, "name").unwrap_or(package.as_str()).to_owned();
			Done::new(markdown(pkg), METHOD)
				.title(title)
				.note("Fetched via Packagist API")
				.finish()
		},
	)
}

fn markdown(pkg: &Value) -> String {
	let versions = pkg.get("versions").and_then(Value::as_object);
	let (key, latest) = latest_version(versions);

	let mut md = format!("# {}\n\n", str_of(pkg, "name").unwrap_or_default());
	if let Some(description) = str_of(pkg, "description") {
		let _ = write!(md, "{description}\n\n");
	}

	let _ = write!(md, "**Latest:** {}", if key.is_empty() { "unknown" } else { &key });
	if let Some(license) = latest
		.map(|version| strs_of(version, "license"))
		.filter(|list| !list.is_empty())
	{
		let _ = write!(md, " · **License:** {}", license.join(", "));
	}
	if let Some(kind) = str_of(pkg, "type") {
		let _ = write!(md, " · **Type:** {kind}");
	}
	md.push('\n');

	if let Some(downloads) = pkg.get("downloads") {
		let _ = writeln!(
			md,
			"**Downloads:** {} total · {}/month",
			format_number(f64_of(downloads, "total").unwrap_or(0.0)),
			format_number(f64_of(downloads, "monthly").unwrap_or(0.0))
		);
	}
	if let Some(favers) = u64_of(pkg, "favers").filter(|favers| *favers > 0) {
		let _ = writeln!(md, "**Stars:** {}", format_number(favers as f64));
	}
	md.push('\n');

	if let Some(version) = latest {
		let authors: Vec<String> = arr_of(version, "authors").iter().map(author_line).collect();
		if !authors.is_empty() {
			let _ = writeln!(md, "**Authors:** {}", authors.join(", "));
		}
	}
	let maintainers = named(pkg, "maintainers");
	if !maintainers.is_empty() {
		let _ = writeln!(md, "**Maintainers:** {}", maintainers.join(", "));
	}

	if let Some(homepage) = latest.and_then(|version| str_of(version, "homepage")) {
		let _ = writeln!(md, "**Homepage:** {homepage}");
	}
	if let Some(repository) = str_of(pkg, "repository") {
		let _ = writeln!(md, "**Repository:** {repository}");
	} else if let Some(source) = latest
		.and_then(|version| version.get("source"))
		.and_then(|source| str_of(source, "url"))
	{
		let _ = writeln!(md, "**Repository:** {}", source.strip_suffix(".git").unwrap_or(source));
	}

	let stars = u64_of(pkg, "github_stars").unwrap_or(0);
	let forks = u64_of(pkg, "github_forks").unwrap_or(0);
	if stars > 0 || forks > 0 {
		let mut stats: Vec<String> = Vec::new();
		if stars > 0 {
			stats.push(format!("{} stars", format_number(stars as f64)));
		}
		if forks > 0 {
			stats.push(format!("{} forks", format_number(forks as f64)));
		}
		if let Some(issues) = u64_of(pkg, "github_open_issues").filter(|issues| *issues > 0) {
			stats.push(format!("{issues} open issues"));
		}
		let _ = writeln!(md, "**GitHub:** {}", stats.join(" · "));
	}

	if let Some(version) = latest {
		requirements(&mut md, version, "require", "\n## Requirements\n\n");
		requirements(&mut md, version, "require-dev", "\n## Dev Requirements\n\n");
	}
	md
}

/// The latest stable version entry, falling back to a dev branch. The returned
/// key is the one the TS handler reported (the object key, or the `version`
/// field for the fallback).
fn latest_version(versions: Option<&serde_json::Map<String, Value>>) -> (String, Option<&Value>) {
	let Some(versions) = versions else {
		return (String::new(), None);
	};
	let mut latest: Option<(&String, &Value)> = None;
	for (key, version) in versions {
		if is_dev(key) {
			continue;
		}
		let newer =
			match (str_of(version, "time"), latest.and_then(|(_, latest)| str_of(latest, "time"))) {
				(Some(time), Some(latest_time)) => time > latest_time,
				_ => latest.is_none(),
			};
		if newer {
			latest = Some((key, version));
		}
	}
	if let Some((key, version)) = latest {
		return (key.clone(), Some(version));
	}
	for key in DEV_BRANCHES {
		if let Some(version) = versions.get(key) {
			return (str_of(version, "version").unwrap_or_default().to_owned(), Some(version));
		}
	}
	match versions.iter().next() {
		Some((_, version)) => {
			(str_of(version, "version").unwrap_or_default().to_owned(), Some(version))
		},
		None => (String::new(), None),
	}
}

/// Whether a version key is a dev branch.
fn is_dev(key: &str) -> bool {
	DEV_BRANCHES.contains(&key) || key.contains("-dev")
}

/// `name <email>` for one author entry.
fn author_line(entry: &Value) -> String {
	let name = str_of(entry, "name").unwrap_or_default();
	match str_of(entry, "email") {
		Some(email) => format!("{name} <{email}>"),
		None => name.to_owned(),
	}
}

/// Non-empty `name` fields of the array of objects at `key`.
fn named<'a>(value: &'a Value, key: &str) -> Vec<&'a str> {
	arr_of(value, key)
		.iter()
		.filter_map(|entry| str_of(entry, "name"))
		.collect()
}

/// A `require`/`require-dev` list under `heading`, when non-empty.
fn requirements(md: &mut String, version: &Value, key: &str, heading: &str) {
	let Some(require) = version
		.get(key)
		.and_then(Value::as_object)
		.filter(|map| !map.is_empty())
	else {
		return;
	};
	md.push_str(heading);
	for (dependency, constraint) in require {
		let _ = writeln!(md, "- {dependency}: {}", scalar(constraint));
	}
}

/// The string value of a constraint, or its JSON text for non-strings.
fn scalar(value: &Value) -> String {
	value
		.as_str()
		.map_or_else(|| value.to_string(), str::to_owned)
}

/// Percent-decode a URL path segment.
fn decode(text: &str) -> String {
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
			continue;
		}
		out.push(bytes[index]);
		index += 1;
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

	use super::super::{Fetched, testing::run};

	fn api() -> serde_json::Value {
		json!({
			"package": {
				"name": "laravel/framework",
				"description": "The Laravel framework.",
				"type": "library",
				"repository": "https://github.com/laravel/framework",
				"github_stars": 78_000,
				"github_forks": 24_000,
				"github_open_issues": 700,
				"favers": 20_000,
				"downloads": { "total": 1_200_000_000, "monthly": 12_300_000, "daily": 500_000 },
				"maintainers": [{ "name": "Taylor Otwell" }],
				"versions": {
					"v11.0.0": {
						"version": "v11.0.0",
						"time": "2024-06-01T00:00:00+00:00",
						"license": ["MIT"],
						"homepage": "https://laravel.com",
						"authors": [{ "name": "Taylor Otwell", "email": "taylor@laravel.com" }],
						"require": { "php": "^8.2" },
						"require-dev": { "phpunit/phpunit": "^10.0" }
					},
					"v10.0.0": {
						"version": "v10.0.0",
						"time": "2024-01-01T00:00:00+00:00",
						"license": ["MIT"]
					}
				}
			}
		})
	}

	#[test]
	fn a_package_page_picks_the_newest_stable_version() {
		let done = run("https://packagist.org/packages/laravel/framework", |request| {
			assert_eq!(request.url, "https://packagist.org/packages/laravel/framework.json");
			Fetched::json(&api())
		})
		.unwrap();
		assert_eq!(done.method, "packagist");
		assert_eq!(done.title.as_deref(), Some("laravel/framework"));
		assert_eq!(done.notes, ["Fetched via Packagist API"]);
		let md = &done.markdown;
		assert!(md.starts_with(
			"# laravel/framework\n\nThe Laravel framework.\n\n\
			 **Latest:** v11.0.0 · **License:** MIT · **Type:** library\n\
			 **Downloads:** 1.2B total · 12M/month\n**Stars:** 20K\n\n\
			 **Authors:** Taylor Otwell <taylor@laravel.com>\n**Maintainers:** Taylor Otwell\n\
			 **Homepage:** https://laravel.com\n**Repository:** https://github.com/laravel/framework\n\
			 **GitHub:** 78K stars · 24K forks · 700 open issues\n"
		));
		assert!(md.ends_with(
			"\n## Requirements\n\n- php: ^8.2\n\n## Dev Requirements\n\n- phpunit/phpunit: ^10.0\n"
		));
	}

	#[test]
	fn a_dev_only_package_falls_back_to_its_branch() {
		let done = run("https://www.packagist.org/packages/acme/dev-only", |_| {
			Fetched::json(&json!({
				"package": {
					"name": "acme/dev-only",
					"versions": { "dev-master": { "version": "dev-master", "source": { "url": "https://github.com/acme/dev-only.git" } } }
				}
			}))
		})
		.unwrap();
		assert_eq!(done.markdown, "# acme/dev-only\n\n**Latest:** dev-master\n\n**Repository:** https://github.com/acme/dev-only\n");
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(
			run("https://packagist.org/search/?q=laravel", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(
			run("https://example.com/packages/laravel/framework", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(
			run("https://packagist.org/packages/laravel/framework", |_| Fetched::status(404)),
			None
		);
	}
}
