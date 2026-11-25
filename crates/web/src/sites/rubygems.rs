//! `RubyGems` (`rubygems.org/gems/<name>`): gem metadata, download counts and
//! dependency lists from the `RubyGems` API.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, fetch, format_number, segment, str_of, strs_of,
	u64_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "rubygems", open };

const METHOD: &str = "rubygems";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "rubygems.org" | "www.rubygems.org") {
		return None;
	}
	let mut segments = url.path_segments()?;
	if segments.next()? != "gems" {
		return None;
	}
	let name = segments.next().filter(|name| !name.is_empty())?.to_owned();
	let request = format!("https://rubygems.org/api/v1/gems/{}.json", segment(&name));
	fetch(Fetch::get(request).accept_json(), move |reply, _| {
		let gem = reply.json_value()?;
		gem.get("name")?;
		summary(&name, &gem).finish()
	})
}

fn summary(name: &str, gem: &Value) -> Done {
	let mut md = format!("# {}\n\n", str_of(gem, "name").unwrap_or(name));
	if let Some(info) = str_of(gem, "info") {
		let _ = write!(md, "{info}\n\n");
	}

	let _ = write!(md, "**Version:** {}", str_of(gem, "version").unwrap_or("unknown"));
	let licenses = strs_of(gem, "licenses");
	if !licenses.is_empty() {
		let _ = write!(md, " · **License:** {}", licenses.join(", "));
	}
	md.push('\n');

	let _ = write!(
		md,
		"**Total Downloads:** {}",
		format_number(u64_of(gem, "downloads").unwrap_or(0) as f64)
	);
	if let Some(version_downloads) = u64_of(gem, "version_downloads").filter(|count| *count > 0) {
		let _ = write!(md, " · **Version Downloads:** {}", format_number(version_downloads as f64));
	}
	md.push_str("\n\n");

	if let Some(homepage) = str_of(gem, "homepage_uri") {
		let _ = writeln!(md, "**Homepage:** {homepage}");
	}
	if let Some(source) = str_of(gem, "source_code_uri") {
		let _ = writeln!(md, "**Source Code:** {source}");
	}
	if let Some(documentation) = str_of(gem, "documentation_uri") {
		let _ = writeln!(md, "**Documentation:** {documentation}");
	}
	if let Some(authors) = str_of(gem, "authors") {
		let _ = writeln!(md, "**Authors:** {authors}");
	}

	for (key, heading) in [("runtime", "Runtime"), ("development", "Development")] {
		let dependencies = gem
			.get("dependencies")
			.map_or(&[][..], |deps| arr_of(deps, key));
		if dependencies.is_empty() {
			continue;
		}
		let _ = write!(md, "\n## {heading} Dependencies\n\n");
		for dependency in dependencies {
			let _ = writeln!(
				md,
				"- {} {}",
				str_of(dependency, "name").unwrap_or(""),
				str_of(dependency, "requirements").unwrap_or("")
			);
		}
	}

	Done::new(md, METHOD)
		.title(str_of(gem, "name").unwrap_or(name))
		.note("Fetched via RubyGems API")
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	fn api() -> serde_json::Value {
		json!({
			"name": "rails", "version": "7.1.3", "info": "Full-stack web framework.",
			"authors": "David Heinemeier Hansson", "licenses": ["MIT"],
			"homepage_uri": "https://rubyonrails.org", "source_code_uri": "https://github.com/rails/rails",
			"documentation_uri": "https://api.rubyonrails.org", "downloads": 456_789_012, "version_downloads": 12_345,
			"dependencies": {
				"runtime": [{ "name": "activesupport", "requirements": "= 7.1.3" }],
				"development": [{ "name": "rake", "requirements": ">= 12.2" }]
			}
		})
	}

	#[test]
	fn a_gem_page_reads_the_api() {
		let mut requests = Vec::new();
		let done = run("https://rubygems.org/gems/rails", |request| {
			requests.push(request.url.clone());
			Fetched::json(&api())
		})
		.unwrap();
		assert_eq!(requests, ["https://rubygems.org/api/v1/gems/rails.json"]);
		assert_eq!((done.method, done.title.as_deref()), ("rubygems", Some("rails")));
		let md = &done.markdown;
		assert!(md.starts_with(
			"# rails\n\nFull-stack web framework.\n\n**Version:** 7.1.3 · **License:** MIT\n**Total Downloads:** 457M · **Version Downloads:** 12K\n\n**Homepage:** https://rubyonrails.org\n**Source Code:** https://github.com/rails/rails\n**Documentation:** https://api.rubyonrails.org\n**Authors:** David Heinemeier Hansson\n"
		));
		assert!(md.contains("\n## Runtime Dependencies\n\n- activesupport = 7.1.3\n"));
		assert!(md.contains("\n## Development Dependencies\n\n- rake >= 12.2\n"));
		assert_eq!(done.notes, ["Fetched via RubyGems API"]);
	}

	#[test]
	fn a_gem_without_links_or_dependencies_is_still_rendered() {
		let done = run("https://www.rubygems.org/gems/sinatra", |_| {
			Fetched::json(&json!({ "name": "sinatra", "version": "4.0.0", "downloads": 999 }))
		})
		.unwrap();
		assert_eq!(done.markdown, "# sinatra\n\n**Version:** 4.0.0\n**Total Downloads:** 999\n\n");
		assert!(!done.markdown.contains("Dependencies"));
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://rubygems.org/search?q=rails", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://rubygems.org/gems/rails", |_| Fetched::status(404)), None);
	}
}
