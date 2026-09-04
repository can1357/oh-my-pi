//! Anonymous `PyPI` JSON API renderer.

use std::fmt::Write as _;

use futures::join;
use omp_tool::{Diag, DiagKind};
use serde::Deserialize;
use url::Url;

use super::utils::{format_compact_number, percent_decode_component};
use crate::read::web::types::{HttpClient, HttpRequest, MAX_BYTES, RenderResult, WebError};

#[derive(Debug)]
struct Target {
	package: String,
}

/// Returns whether `url` is a supported `PyPI` project or project-version page.
pub(super) fn matches(url: &Url) -> bool {
	parse_target(url).is_some()
}

/// Renders a `PyPI` project or project version through the public JSON APIs.
pub(super) async fn render<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
) -> Result<Option<RenderResult>, WebError> {
	let Some(target) = parse_target(url) else {
		return Ok(None);
	};

	let package_url = api_url(&target);
	let downloads_url = downloads_url(&target.package);
	let package_request = request(package_url);
	let downloads_request = request(downloads_url);
	let (package_response, downloads_response) =
		join!(client.get(package_request), client.get(downloads_request),);

	let Ok(package_response) = package_response else {
		return Ok(None);
	};
	if !(200..300).contains(&package_response.status) {
		return Ok(None);
	}
	let Ok(package) = serde_json::from_slice::<Package>(package_response.body.as_ref()) else {
		return Ok(None);
	};

	let weekly_downloads = downloads_response
		.ok()
		.filter(|response| (200..300).contains(&response.status))
		.and_then(|response| serde_json::from_slice::<Downloads>(response.body.as_ref()).ok())
		.and_then(|downloads| downloads.data.and_then(|data| data.last_week));

	let mut markdown = format!("# {}\n\n", package.info.name);
	if let Some(summary) = nonempty(package.info.summary.as_deref()) {
		markdown.push_str(summary);
		markdown.push_str("\n\n");
	}

	write!(&mut markdown, "**Latest:** {}", package.info.version)
		.expect("writing to String cannot fail");
	if let Some(license) = nonempty(package.info.license.as_deref()) {
		write!(&mut markdown, " · **License:** {license}").expect("writing to String cannot fail");
	}
	markdown.push('\n');

	if let Some(downloads) = weekly_downloads {
		writeln!(&mut markdown, "**Weekly Downloads:** {}", format_compact_number(downloads))
			.expect("writing to String cannot fail");
	}
	markdown.push('\n');

	if let Some(author) = nonempty(package.info.author.as_deref()) {
		write!(&mut markdown, "**Author:** {author}").expect("writing to String cannot fail");
		if let Some(email) = nonempty(package.info.author_email.as_deref()) {
			write!(&mut markdown, " <{email}>").expect("writing to String cannot fail");
		}
		markdown.push('\n');
	}
	if let Some(python) = nonempty(package.info.requires_python.as_deref()) {
		writeln!(&mut markdown, "**Python:** {python}").expect("writing to String cannot fail");
	}
	if let Some(homepage) = nonempty(package.info.home_page.as_deref()) {
		writeln!(&mut markdown, "**Homepage:** {homepage}").expect("writing to String cannot fail");
	}

	if let Some(project_urls) = package.info.project_urls.filter(|urls| !urls.is_empty()) {
		markdown.push_str("\n**Project URLs:**\n");
		for (label, value) in project_urls {
			if let Some(project_url) = value.as_str() {
				writeln!(&mut markdown, "- {label}: {project_url}")
					.expect("writing to String cannot fail");
			}
		}
	}

	if let Some(keywords) = nonempty(package.info.keywords.as_deref()) {
		writeln!(&mut markdown, "\n**Keywords:** {keywords}").expect("writing to String cannot fail");
	}

	if !package.requires_dist.is_empty() {
		markdown.push_str("\n## Dependencies\n\n");
		for dependency in package.requires_dist {
			writeln!(&mut markdown, "- {dependency}").expect("writing to String cannot fail");
		}
	}

	if let Some(description) = nonempty(package.info.description.as_deref()) {
		markdown.push_str("\n---\n\n## Description\n\n");
		markdown.push_str(description);
		markdown.push('\n');
	}

	let mut rendered = RenderResult::markdown(&markdown, "pypi");
	rendered
		.diags
		.push(Diag::info(DiagKind::Provenance, "Fetched via PyPI JSON API"));
	Ok(Some(rendered))
}

fn parse_target(url: &Url) -> Option<Target> {
	if !matches!(url.host_str(), Some("pypi.org" | "www.pypi.org")) {
		return None;
	}
	let mut segments = url.path_segments()?;
	if segments.next()? != "project" {
		return None;
	}
	let package = percent_decode_component(segments.next()?)?;
	if package.is_empty() {
		return None;
	}
	Some(Target { package })
}

fn api_url(target: &Target) -> String {
	let mut url = Url::parse("https://pypi.org").expect("constant PyPI API origin is valid");
	url.path_segments_mut()
		.expect("HTTP URL accepts path segments")
		.extend(["pypi", target.package.as_str(), "json"]);
	url.into()
}

fn downloads_url(package: &str) -> String {
	let mut url = Url::parse("https://pypistats.org").expect("constant PyPI stats origin is valid");
	url.path_segments_mut()
		.expect("HTTP URL accepts path segments")
		.extend(["api", "packages", package, "recent"]);
	url.into()
}

fn request(url: String) -> HttpRequest {
	HttpRequest::new(url).with_max_bytes(MAX_BYTES)
}
fn nonempty(value: Option<&str>) -> Option<&str> {
	value.filter(|value| !value.is_empty())
}

#[derive(Deserialize)]
struct Package {
	info:          PackageInfo,
	#[serde(default)]
	requires_dist: Vec<String>,
}

#[derive(Deserialize)]
struct PackageInfo {
	name:            String,
	version:         String,
	summary:         Option<String>,
	description:     Option<String>,
	author:          Option<String>,
	author_email:    Option<String>,
	license:         Option<String>,
	home_page:       Option<String>,
	project_urls:    Option<serde_json::Map<String, serde_json::Value>>,
	requires_python: Option<String>,
	keywords:        Option<String>,
}

#[derive(Deserialize)]
struct Downloads {
	data: Option<DownloadData>,
}

#[derive(Deserialize)]
struct DownloadData {
	last_week: Option<u64>,
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_project_and_version_urls() {
		let project =
			parse_target(&Url::parse("https://pypi.org/project/requests/").unwrap()).unwrap();
		assert_eq!(project.package, "requests");

		let version =
			parse_target(&Url::parse("https://www.pypi.org/project/zope.interface/6.1/").unwrap())
				.unwrap();
		assert_eq!(version.package, "zope.interface");
		assert_eq!(api_url(&version), "https://pypi.org/pypi/zope.interface/json");
	}

	#[test]
	fn rejects_non_project_urls() {
		assert!(!matches(&Url::parse("https://pypi.org/").unwrap()));
		assert!(!matches(&Url::parse("https://pypi.org/search/?q=requests").unwrap()));
		assert!(!matches(&Url::parse("https://example.com/project/requests/").unwrap()));
	}
}
