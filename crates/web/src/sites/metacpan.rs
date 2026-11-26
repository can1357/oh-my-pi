//! `MetaCPAN` (`metacpan.org/pod/Module`, `metacpan.org/release/Distribution`):
//! module and release metadata from the fastapi.metacpan.org API.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, fetch, i64_of, str_of, strs_of, unix_date,
};

/// Registry entry.
pub const SITE: Site = Site { name: "metacpan", open };

const METHOD: &str = "metacpan";
const NOTE: &str = "Fetched via MetaCPAN API";
const API: &str = "https://fastapi.metacpan.org/v1";
/// Dependency lines listed before the rest are elided.
const DEPENDENCIES: usize = 20;

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "metacpan.org" | "www.metacpan.org") {
		return None;
	}
	let path = url.path();
	if let Some(rest) = path.strip_prefix("/pod/") {
		let name = rest.split('/').next().filter(|name| !name.is_empty())?;
		return module(decode(name));
	}
	if let Some(rest) = path.strip_prefix("/release/") {
		let mut segments = rest.split('/');
		let first = segments.next().filter(|name| !name.is_empty())?;
		let distribution = match segments.next() {
			Some(second) if !second.is_empty() => decode(second),
			Some(_) => return None,
			None => decode(first),
		};
		return release(distribution);
	}
	None
}

fn module(name: String) -> Option<Action> {
	fetch(Fetch::get(format!("{API}/module/{name}")), move |reply, _| {
		let module = reply.json_value()?;
		let distribution = str_of(&module, "distribution")
			.unwrap_or("undefined")
			.to_owned();
		fetch(Fetch::get(format!("{API}/release/{distribution}")), move |reply, _| {
			let release = reply.json_value();
			let title = str_of(&module, "name").unwrap_or("undefined").to_owned();
			Done::new(module_markdown(&module, release.as_ref()), METHOD)
				.title(title)
				.note(NOTE)
				.finish()
		})
	})
}

fn release(distribution: String) -> Option<Action> {
	fetch(Fetch::get(format!("{API}/release/{distribution}")), move |reply, _| {
		let release = reply.json_value()?;
		let title = str_of(&release, "distribution")
			.unwrap_or(distribution.as_str())
			.to_owned();
		Done::new(release_markdown(&release), METHOD)
			.title(title)
			.note(NOTE)
			.finish()
	})
}

fn module_markdown(module: &Value, release: Option<&Value>) -> String {
	let name = str_of(module, "name").unwrap_or("undefined");
	let mut md = format!("# {name}\n\n");
	if let Some(abstract_) = str_of(module, "abstract") {
		let _ = write!(md, "{abstract_}\n\n");
	}
	let author = str_of(module, "author").unwrap_or("undefined");
	let _ = writeln!(
		md,
		"**Version:** {} · **Distribution:** {} · **Author:** [{author}](https://metacpan.org/author/{author})",
		str_of(module, "version").unwrap_or("undefined"),
		str_of(module, "distribution").unwrap_or("undefined"),
	);
	if let Some(release) = release {
		if let Some(licenses) = license_line(release) {
			let _ = writeln!(md, "{licenses}");
		}
		md.push_str(&resource_lines(release));
		md.push_str(&dependency_section(release));
	}
	let _ = write!(md, "\n## Installation\n\n```bash\ncpanm {name}\n```\n");
	md
}

fn release_markdown(release: &Value) -> String {
	let distribution = str_of(release, "distribution").unwrap_or("undefined");
	let mut md = format!("# {distribution}\n\n");
	if let Some(abstract_) = str_of(release, "abstract") {
		let _ = write!(md, "{abstract_}\n\n");
	}
	let author = str_of(release, "author").unwrap_or("undefined");
	let _ = writeln!(
		md,
		"**Version:** {} · **Author:** [{author}](https://metacpan.org/author/{author})",
		str_of(release, "version").unwrap_or("undefined"),
	);
	if let Some(licenses) = license_line(release) {
		let _ = writeln!(md, "{licenses}");
	}
	if let Some(mtime) = release
		.get("stat")
		.and_then(|stat| i64_of(stat, "mtime"))
		.filter(|mtime| *mtime != 0)
	{
		let _ = writeln!(md, "**Released:** {}", unix_date(mtime));
	}
	md.push_str(&resource_lines(release));
	md.push_str(&dependency_section(release));
	let _ = write!(md, "\n## Installation\n\n```bash\ncpanm {distribution}\n```\n");
	md
}

fn license_line(release: &Value) -> Option<String> {
	let licenses = strs_of(release, "license");
	(!licenses.is_empty()).then(|| format!("**License:** {}", licenses.join(", ")))
}

/// Repository, homepage and issue-tracker lines of a release.
fn resource_lines(release: &Value) -> String {
	let mut md = String::new();
	let Some(resources) = release
		.get("metadata")
		.and_then(|metadata| metadata.get("resources"))
	else {
		return md;
	};
	if let Some(repository) = resources
		.get("repository")
		.and_then(|repository| str_of(repository, "web").or_else(|| str_of(repository, "url")))
	{
		let _ = writeln!(md, "**Repository:** {repository}");
	}
	if let Some(homepage) = str_of(resources, "homepage") {
		let _ = writeln!(md, "**Homepage:** {homepage}");
	}
	if let Some(issues) = resources
		.get("bugtracker")
		.and_then(|tracker| str_of(tracker, "web"))
	{
		let _ = writeln!(md, "**Issues:** {issues}");
	}
	md
}

/// `## Dependencies` section: up to 20 runtime requirements, perl itself
/// excluded.
fn dependency_section(release: &Value) -> String {
	let dependencies: Vec<&Value> = arr_of(release, "dependency")
		.iter()
		.filter(|dependency| {
			str_of(dependency, "phase") == Some("runtime")
				&& str_of(dependency, "relationship") == Some("requires")
				&& str_of(dependency, "module") != Some("perl")
		})
		.collect();
	if dependencies.is_empty() {
		return String::new();
	}
	let mut md = String::from("\n## Dependencies\n\n");
	for dependency in dependencies.iter().take(DEPENDENCIES) {
		let _ = write!(md, "- **{}**", str_of(dependency, "module").unwrap_or_default());
		if let Some(version) = str_of(dependency, "version").filter(|version| *version != "0") {
			let _ = write!(md, " >= {version}");
		}
		md.push('\n');
	}
	if dependencies.len() > DEPENDENCIES {
		let _ = write!(md, "\n[…{} dependencies elided…]\n", dependencies.len() - DEPENDENCIES);
	}
	md
}

/// Percent-decode a path segment, as `decodeURIComponent` does.
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
	use serde_json::{Value, json};

	use super::super::{Fetched, testing::run};

	fn module_data() -> Value {
		json!({
			"name": "Moose", "version": "2.2207", "abstract": "A postmodern object system", "author": "ETHER",
			"distribution": "Moose", "release": "Moose-2.2207", "path": "lib/Moose.pm"
		})
	}

	fn release_data() -> Value {
		json!({
			"name": "Moose", "version": "2.2207", "abstract": "A postmodern object system", "author": "ETHER",
			"distribution": "Moose", "license": ["perl_5"], "stat": { "mtime": 1_704_067_200 },
			"dependency": [
				{ "module": "perl", "version": "5.008", "phase": "runtime", "relationship": "requires" },
				{ "module": "Carp", "version": "1.0", "phase": "runtime", "relationship": "requires" },
				{ "module": "Test::More", "version": "0.88", "phase": "test", "relationship": "requires" }
			],
			"metadata": { "resources": {
				"repository": { "url": "https://github.com/example/Moose" },
				"homepage": "https://metacpan.org/release/Moose",
				"bugtracker": { "web": "https://github.com/example/Moose/issues" }
			} }
		})
	}

	#[test]
	fn a_module_page_adds_release_details_and_dependencies() {
		let mut requests = Vec::new();
		let done = run("https://metacpan.org/pod/Moose", |request| {
			requests.push(request.url.clone());
			if request.url.ends_with("/release/Moose") {
				Fetched::json(&release_data())
			} else {
				Fetched::json(&module_data())
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://fastapi.metacpan.org/v1/module/Moose",
			"https://fastapi.metacpan.org/v1/release/Moose"
		]);
		assert_eq!((done.method, done.title.as_deref()), ("metacpan", Some("Moose")));
		let md = &done.markdown;
		assert!(md.starts_with("# Moose\n\nA postmodern object system\n\n"));
		assert!(md.contains("**Version:** 2.2207 · **Distribution:** Moose · **Author:** [ETHER](https://metacpan.org/author/ETHER)\n"));
		assert!(md.contains("**License:** perl_5\n**Repository:** https://github.com/example/Moose\n**Homepage:** https://metacpan.org/release/Moose\n**Issues:** https://github.com/example/Moose/issues\n"));
		assert!(md.contains("\n## Dependencies\n\n- **Carp** >= 1.0\n\n## Installation\n"));
		assert!(md.ends_with("```bash\ncpanm Moose\n```\n"));
		assert!(!md.contains("Test::More"));
		assert_eq!(done.notes, ["Fetched via MetaCPAN API"]);
	}

	#[test]
	fn release_urls_work_with_and_without_an_author() {
		for url in ["https://metacpan.org/release/Moose", "https://metacpan.org/release/ETHER/Moose"]
		{
			let mut requests = Vec::new();
			let done = run(url, |request| {
				requests.push(request.url.clone());
				Fetched::json(&release_data())
			})
			.unwrap();
			assert_eq!(requests, ["https://fastapi.metacpan.org/v1/release/Moose"]);
			assert_eq!(done.title.as_deref(), Some("Moose"));
			assert!(
				done
					.markdown
					.starts_with("# Moose\n\nA postmodern object system\n\n")
			);
			assert!(done.markdown.contains(
				"**Version:** 2.2207 · **Author:** [ETHER](https://metacpan.org/author/ETHER)\n"
			));
			assert!(done.markdown.contains("**Released:** 2024-01-01\n"));
			assert!(done.markdown.ends_with("```bash\ncpanm Moose\n```\n"));
		}
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://metacpan.org/about", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://metacpan.org/release/", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://metacpan.org/pod/Moose", |_| Fetched::status(404)), None);
	}
}
