//! npm (`npmjs.com`): the latest manifest from the registry plus last-week
//! download counts from the downloads API.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, fetch, format_number, segment, str_of, strs_of,
	u64_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "npm", open };

const METHOD: &str = "npm";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "www.npmjs.com" | "npmjs.com") {
		return None;
	}
	let path = url.path();
	if !path.get(..9)?.eq_ignore_ascii_case("/package/") {
		return None;
	}
	let package = package_name(&path[9..])?;
	let latest = format!("https://registry.npmjs.org/{package}/latest");
	fetch(Fetch::get(latest).accept_json(), move |reply, _| {
		let pkg = reply.json_value()?;
		let downloads =
			format!("https://api.npmjs.org/downloads/point/last-week/{}", segment(&package));
		fetch(Fetch::get(downloads).accept_json(), move |reply, _| {
			let weekly = reply
				.json_value()
				.and_then(|data| u64_of(&data, "downloads"));
			let markdown = render(&pkg, &package, weekly);
			let title = str_of(&pkg, "name").unwrap_or(&package).to_owned();
			Done::new(markdown, METHOD)
				.title(title)
				.note("Fetched via npm registry")
				.finish()
		})
	})
}

/// `[scope/]name` from the path after `/package/`, percent-decoded.
fn package_name(rest: &str) -> Option<String> {
	let mut parts = rest.split('/');
	let first = parts.next()?;
	if first.is_empty() {
		return None;
	}
	let name = match first.strip_prefix('@') {
		Some(scope) if !scope.is_empty() => parts
			.next()
			.filter(|part| !part.is_empty())
			.map_or_else(|| first.to_owned(), |part| format!("@{scope}/{part}")),
		_ => first.to_owned(),
	};
	Some(percent_decode(&name))
}

fn render(pkg: &Value, fallback: &str, weekly: Option<u64>) -> String {
	let mut md = format!("# {}\n\n", str_of(pkg, "name").unwrap_or(fallback));
	if let Some(description) = str_of(pkg, "description") {
		let _ = write!(md, "{description}\n\n");
	}
	let _ = write!(md, "**Latest:** {}", str_of(pkg, "version").unwrap_or("unknown"));
	if let Some(license) = license(pkg) {
		let _ = write!(md, " · **License:** {license}");
	}
	md.push('\n');
	if let Some(weekly) = weekly {
		let _ = writeln!(md, "**Weekly Downloads:** {}", format_number(weekly as f64));
	}
	md.push('\n');
	if let Some(homepage) = str_of(pkg, "homepage") {
		let _ = writeln!(md, "**Homepage:** {homepage}");
	}
	if let Some(repository) = repository(pkg) {
		let _ = writeln!(md, "**Repository:** {repository}");
	}
	let keywords = strs_of(pkg, "keywords");
	if !keywords.is_empty() {
		let _ = writeln!(md, "**Keywords:** {}", keywords.join(", "));
	}
	let maintainers: Vec<&str> = arr_of(pkg, "maintainers")
		.iter()
		.filter_map(|m| str_of(m, "name"))
		.collect();
	if !maintainers.is_empty() {
		let _ = writeln!(md, "**Maintainers:** {}", maintainers.join(", "));
	}
	if let Some(dependencies) = pkg
		.get("dependencies")
		.and_then(Value::as_object)
		.filter(|deps| !deps.is_empty())
	{
		md.push_str("\n## Dependencies\n\n");
		for (dependency, version) in dependencies {
			let _ = writeln!(md, "- {dependency}: {}", version.as_str().unwrap_or_default());
		}
	}
	if let Some(readme) = str_of(pkg, "readme") {
		let _ = write!(md, "\n---\n\n## README\n\n{readme}\n");
	}
	md
}

/// A license string, or the `type` of a license object.
fn license(pkg: &Value) -> Option<String> {
	match pkg.get("license")? {
		Value::String(text) => (!text.is_empty()).then(|| text.clone()),
		value => str_of(value, "type").map(str::to_owned),
	}
}

/// A repository URL with npm's `git+` prefix and `.git` suffix removed.
fn repository(pkg: &Value) -> Option<String> {
	let url = match pkg.get("repository")? {
		Value::String(text) => text.as_str(),
		value => str_of(value, "url")?,
	};
	let url = url.strip_prefix("git+").unwrap_or(url);
	Some(url.strip_suffix(".git").unwrap_or(url).to_owned())
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

	use super::super::{Fetched, testing::run};

	#[test]
	fn a_scoped_package_reads_the_registry_and_downloads() {
		let pkg = json!({
			"name": "@scope/name", "version": "1.2.3", "description": "A package",
			"license": { "type": "MIT" }, "homepage": "https://example.test",
			"repository": { "url": "git+https://github.com/scope/name.git" },
			"keywords": ["one", "two"], "maintainers": [{ "name": "Ada" }, { "name": "Bob" }],
			"dependencies": { "left-pad": "^1.3.0" }, "readme": "Hello"
		});
		let mut requests = Vec::new();
		let done = run("https://www.npmjs.com/package/@scope/name", |request| {
			requests.push(request.url.clone());
			if request.url.starts_with("https://registry.npmjs.org/") {
				Fetched::json(&pkg)
			} else {
				Fetched::json(&json!({ "downloads": 12_345 }))
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://registry.npmjs.org/@scope/name/latest",
			"https://api.npmjs.org/downloads/point/last-week/%40scope%2Fname"
		]);
		assert_eq!((done.method, done.title.as_deref()), ("npm", Some("@scope/name")));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# @scope/name\n\nA package\n\n**Latest:** 1.2.3 · **License:** MIT\n**Weekly \
			 Downloads:** 12K\n\n"
		));
		assert!(md.contains(
			"**Repository:** https://github.com/scope/name\n**Keywords:** one, two\n**Maintainers:** \
			 Ada, Bob\n"
		));
		assert!(md.contains("\n## Dependencies\n\n- left-pad: ^1.3.0\n"));
		assert!(md.ends_with("\n---\n\n## README\n\nHello\n"));
	}

	#[test]
	fn a_missing_download_count_is_left_out() {
		let done = run("https://npmjs.com/package/lodash", |request| {
			if request.url.starts_with("https://registry.npmjs.org/") {
				Fetched::json(&json!({ "name": "lodash", "version": "4.17.21", "license": "MIT" }))
			} else {
				Fetched::status(500)
			}
		})
		.unwrap();
		assert_eq!(done.markdown, "# lodash\n\n**Latest:** 4.17.21 · **License:** MIT\n\n");
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://www.npmjs.com/settings", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://www.npmjs.com/package/lodash", |_| Fetched::status(404)), None);
	}
}
