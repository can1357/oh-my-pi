//! Crates.io crate metadata renderer.

use std::fmt::Write as _;

use omp_core::USER_AGENT;
use omp_tool::{Diag, DiagKind};
use serde::Deserialize;
use url::Url;

use super::utils::{format_compact_number, percent_decode_component};
use crate::read::web::types::{HttpClient, HttpRequest, RenderResult, WebError};

const API_BASE: &str = "https://crates.io/api/v1/crates";
const DOCS_BASE: &str = "https://docs.rs/crate";

#[derive(Deserialize)]
struct ApiResponse {
	#[serde(rename = "crate")]
	metadata: CrateMetadata,
	versions: Option<Vec<Version>>,
}

#[derive(Deserialize)]
struct CrateMetadata {
	name:             String,
	description:      Option<String>,
	downloads:        u64,
	recent_downloads: u64,
	max_version:      String,
	repository:       Option<String>,
	homepage:         Option<String>,
	documentation:    Option<String>,
	categories:       Option<Vec<String>>,
	keywords:         Option<Vec<String>>,
}

#[derive(Deserialize)]
struct Version {
	num:        String,
	downloads:  u64,
	created_at: String,
	license:    Option<String>,
	#[serde(rename = "rust_version")]
	msrv:       Option<String>,
}

/// Returns whether the URL names a crate page on crates.io.
pub(super) fn matches(url: &Url) -> bool {
	crate_name(url).is_some()
}

/// Renders crates.io metadata, recent releases, and an available docs.rs
/// README.
pub(super) async fn render<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
) -> Result<Option<RenderResult>, WebError> {
	let Some(crate_name) = crate_name(url) else {
		return Ok(None);
	};
	let Ok(response) = client
		.get(
			HttpRequest::new(format!("{API_BASE}/{crate_name}")).with_header("User-Agent", USER_AGENT),
		)
		.await
	else {
		return Ok(None);
	};
	if !response.is_success() {
		return Ok(None);
	}
	let Ok(data) = serde_json::from_slice::<ApiResponse>(&response.body) else {
		return Ok(None);
	};

	let latest = data
		.versions
		.as_deref()
		.and_then(|versions| versions.first());
	let metadata = &data.metadata;
	let mut markdown = String::new();
	write!(markdown, "# {}\n\n", metadata.name).expect("writing markdown to a string");
	if let Some(description) = metadata
		.description
		.as_deref()
		.filter(|value| !value.is_empty())
	{
		markdown.push_str(description);
		markdown.push_str("\n\n");
	}

	write!(markdown, "**Latest:** {}", metadata.max_version).expect("writing markdown to a string");
	if let Some(license) = latest
		.and_then(|version| version.license.as_deref())
		.filter(|value| !value.is_empty())
	{
		write!(markdown, " · **License:** {license}").expect("writing markdown to a string");
	}
	if let Some(msrv) = latest
		.and_then(|version| version.msrv.as_deref())
		.filter(|value| !value.is_empty())
	{
		write!(markdown, " · **MSRV:** {msrv}").expect("writing markdown to a string");
	}
	markdown.push('\n');
	write!(
		markdown,
		"**Downloads:** {} total · {} recent\n\n",
		format_compact_number(metadata.downloads),
		format_compact_number(metadata.recent_downloads)
	)
	.expect("writing markdown to a string");

	if let Some(repository) = metadata
		.repository
		.as_deref()
		.filter(|value| !value.is_empty())
	{
		writeln!(markdown, "**Repository:** {repository}").expect("writing markdown to a string");
	}
	if let Some(homepage) = metadata
		.homepage
		.as_deref()
		.filter(|value| !value.is_empty())
		.filter(|homepage| Some(*homepage) != metadata.repository.as_deref())
	{
		writeln!(markdown, "**Homepage:** {homepage}").expect("writing markdown to a string");
	}
	if let Some(documentation) = metadata
		.documentation
		.as_deref()
		.filter(|value| !value.is_empty())
	{
		writeln!(markdown, "**Docs:** {documentation}").expect("writing markdown to a string");
	}
	if let Some(keywords) = metadata
		.keywords
		.as_ref()
		.filter(|values| !values.is_empty())
	{
		writeln!(markdown, "**Keywords:** {}", keywords.join(", "))
			.expect("writing markdown to a string");
	}
	if let Some(categories) = metadata
		.categories
		.as_ref()
		.filter(|values| !values.is_empty())
	{
		writeln!(markdown, "**Categories:** {}", categories.join(", "))
			.expect("writing markdown to a string");
	}

	if let Some(versions) = data
		.versions
		.as_ref()
		.filter(|versions| !versions.is_empty())
	{
		markdown.push_str("\n## Recent Versions\n\n");
		for version in versions.iter().take(5) {
			writeln!(
				markdown,
				"- **{}** ({}) - {} downloads",
				version.num,
				iso_date(&version.created_at),
				format_compact_number(version.downloads)
			)
			.expect("writing markdown to a string");
		}
	}

	let readme_url = format!("{DOCS_BASE}/{crate_name}/{}/source/README.md", metadata.max_version);
	if let Ok(readme_response) = client.get(HttpRequest::new(readme_url)).await
		&& readme_response.is_success()
	{
		let readme = readme_response.text();
		if readme.encode_utf16().count() > 100 && !looks_like_html(&readme) {
			markdown.push_str("\n---\n\n## README\n\n");
			markdown.push_str(&readme);
			markdown.push('\n');
		}
	}

	let mut rendered = RenderResult::markdown(&markdown, "crates.io");
	rendered
		.diags
		.push(Diag::info(DiagKind::Provenance, "Fetched via crates.io API"));
	Ok(Some(rendered))
}

fn crate_name(url: &Url) -> Option<String> {
	let host = url.host_str()?;
	if host != "crates.io" && host != "www.crates.io" {
		return None;
	}
	let mut segments = url.path_segments()?;
	if segments.next()? != "crates" {
		return None;
	}
	let name = percent_decode_component(segments.next()?)?;
	(!name.is_empty()).then_some(name)
}

fn iso_date(value: &str) -> &str {
	value.split_once('T').map_or(value, |(date, _)| date)
}

fn looks_like_html(content: &str) -> bool {
	let leading: String = content
		.trim()
		.chars()
		.take(10)
		.flat_map(char::to_lowercase)
		.collect();
	leading.starts_with("<!doctype")
		|| leading.starts_with("<html")
		|| leading.starts_with("<head")
		|| leading.starts_with("<body")
}
