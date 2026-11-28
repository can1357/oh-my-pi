//! `PyPI` (`pypi.org/project/<name>`): package metadata from the `PyPI` JSON
//! API and the weekly download count from pypistats.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, fetch, format_number, str_of, strs_of, u64_of};

/// Registry entry.
pub const SITE: Site = Site { name: "pypi", open };

const METHOD: &str = "pypi";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "pypi.org" | "www.pypi.org") {
		return None;
	}
	let mut segments = url.path_segments()?;
	if segments.next()? != "project" {
		return None;
	}
	let name = segments.next().filter(|name| !name.is_empty())?.to_owned();
	// The TS handler inserts the decoded name verbatim, so no encoding here.
	fetch(Fetch::get(format!("https://pypi.org/pypi/{name}/json")).accept_json(), move |reply, _| {
		let data = reply.json_value()?;
		fetch(
			Fetch::get(format!("https://pypistats.org/api/packages/{name}/recent")).accept_json(),
			move |reply, _| {
				let weekly = reply
					.json_value()
					.and_then(|stats| u64_of(stats.get("data")?, "last_week"));
				summary(&name, &data, data.get("info")?, weekly).finish()
			},
		)
	})
}

fn summary(name: &str, data: &Value, info: &Value, weekly: Option<u64>) -> Done {
	let mut md = format!("# {}\n\n", str_of(info, "name").unwrap_or(name));
	if let Some(summary) = str_of(info, "summary") {
		let _ = write!(md, "{summary}\n\n");
	}

	let _ = write!(md, "**Latest:** {}", str_of(info, "version").unwrap_or("unknown"));
	if let Some(license) = str_of(info, "license") {
		let _ = write!(md, " · **License:** {license}");
	}
	md.push('\n');
	if let Some(weekly) = weekly {
		let _ = writeln!(md, "**Weekly Downloads:** {}", format_number(weekly as f64));
	}
	md.push('\n');

	if let Some(author) = str_of(info, "author") {
		let _ = write!(md, "**Author:** {author}");
		if let Some(email) = str_of(info, "author_email") {
			let _ = write!(md, " <{email}>");
		}
		md.push('\n');
	}
	if let Some(python) = str_of(info, "requires_python") {
		let _ = writeln!(md, "**Python:** {python}");
	}
	if let Some(homepage) = str_of(info, "home_page") {
		let _ = writeln!(md, "**Homepage:** {homepage}");
	}
	if let Some(urls) = info
		.get("project_urls")
		.and_then(Value::as_object)
		.filter(|urls| !urls.is_empty())
	{
		md.push_str("\n**Project URLs:**\n");
		for (label, url) in urls {
			if let Some(url) = url.as_str() {
				let _ = writeln!(md, "- {label}: {url}");
			}
		}
	}
	if let Some(keywords) = str_of(info, "keywords") {
		let _ = write!(md, "\n**Keywords:** {keywords}\n");
	}

	// The TS handler reads `requires_dist` off the response root.
	let dependencies = strs_of(data, "requires_dist");
	if !dependencies.is_empty() {
		md.push_str("\n## Dependencies\n\n");
		for dependency in dependencies {
			let _ = writeln!(md, "- {dependency}");
		}
	}

	if let Some(description) = str_of(info, "description") {
		let _ = write!(md, "\n---\n\n## Description\n\n{description}\n");
	}

	Done::new(md, METHOD)
		.title(str_of(info, "name").unwrap_or(name))
		.note("Fetched via PyPI JSON API")
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	fn api() -> serde_json::Value {
		json!({
			"info": {
				"name": "requests", "version": "2.32.0", "summary": "Python HTTP for Humans.",
				"description": "Requests is an elegant HTTP library.\n", "author": "Kenneth Reitz",
				"author_email": "me@kennethreitz.org", "license": "Apache-2.0",
				"home_page": "https://requests.readthedocs.io", "requires_python": ">=3.8",
				"project_urls": { "Source": "https://github.com/psf/requests" }, "keywords": "http,client"
			},
			"requires_dist": ["urllib3>=1.21.1", "certifi>=2017.4.17"]
		})
	}

	#[test]
	fn a_project_page_reads_both_apis() {
		let mut requests = Vec::new();
		let done = run("https://pypi.org/project/requests/2.32.0/", |request| {
			requests.push(request.url.clone());
			if request.url.starts_with("https://pypistats.org/") {
				Fetched::json(&json!({ "data": { "last_week": 12_345_678 } }))
			} else {
				Fetched::json(&api())
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://pypi.org/pypi/requests/json",
			"https://pypistats.org/api/packages/requests/recent"
		]);
		assert_eq!((done.method, done.title.as_deref()), ("pypi", Some("requests")));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# requests\n\nPython HTTP for Humans.\n\n**Latest:** 2.32.0 · **License:** Apache-2.0\n**Weekly Downloads:** 12M\n\n**Author:** Kenneth Reitz <me@kennethreitz.org>\n**Python:** >=3.8\n**Homepage:** https://requests.readthedocs.io\n"
		));
		assert!(md.contains("\n**Project URLs:**\n- Source: https://github.com/psf/requests\n"));
		assert!(md.contains("\n**Keywords:** http,client\n"));
		assert!(md.contains("\n## Dependencies\n\n- urllib3>=1.21.1\n- certifi>=2017.4.17\n"));
		assert!(md.contains("\n---\n\n## Description\n\nRequests is an elegant HTTP library.\n"));
		assert_eq!(done.notes, ["Fetched via PyPI JSON API"]);
	}

	#[test]
	fn missing_download_stats_are_left_out() {
		let done = run("https://www.pypi.org/project/requests/", |request| {
			if request.url.starts_with("https://pypistats.org/") {
				Fetched::status(503)
			} else {
				Fetched::json(&json!({ "info": { "name": "requests", "version": "2.32.0" } }))
			}
		})
		.unwrap();
		assert_eq!(done.markdown, "# requests\n\n**Latest:** 2.32.0\n\n");
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://pypi.org/search?q=requests", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://pypi.org/project/requests/", |_| Fetched::status(404)), None);
	}
}
