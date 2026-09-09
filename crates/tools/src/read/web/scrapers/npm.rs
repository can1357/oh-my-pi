//! npm package metadata renderer backed by the public registry APIs.

use std::vec;

use omp_core::Str;
use omp_tool::{Diag, DiagKind};
use serde::{Deserialize, Deserializer, de};
use serde_json::{Map, Value};
use url::Url;

use super::{
	super::types::{HttpClient, HttpRequest, RenderResult, WebError},
	utils::{encode_uri_component, format_compact_number, percent_decode_component},
};

const REGISTRY: &str = "https://registry.npmjs.org";
const DOWNLOADS: &str = "https://api.npmjs.org/downloads/point/last-week";

struct Target {
	package: Str,
}

/// Returns whether `url` is an npm package page supported by this renderer.
pub(super) fn matches(url: &Url) -> bool {
	parse(url).is_some()
}

/// Renders an npm package page from registry metadata and weekly download data.
pub(super) async fn render<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
) -> Result<Option<RenderResult>, WebError> {
	let Some(target) = parse(url) else {
		return Ok(None);
	};

	let package_url = format!("{REGISTRY}/{}/latest", target.package);
	let downloads_url = format!("{DOWNLOADS}/{}", encode_uri_component(&target.package));
	let (package_response, downloads_response) = futures::join!(
		client.get(HttpRequest::new(package_url)),
		client.get(HttpRequest::new(downloads_url)),
	);
	let Ok(package_response) = package_response else {
		return Ok(None);
	};
	if !package_response.is_success() {
		return Ok(None);
	}

	let package: Package = match serde_json::from_slice(package_response.body.as_ref()) {
		Ok(package) => package,
		Err(_) => return Ok(None),
	};
	let weekly_downloads = downloads_response
		.ok()
		.filter(|response| response.is_success())
		.and_then(|response| serde_json::from_slice::<DownloadCount>(response.body.as_ref()).ok())
		.and_then(|data| data.downloads);

	let mut markdown = format!("# {}\n\n", package.name);
	if let Some(description) = package.description.filter(|value| !value.is_empty()) {
		markdown.push_str(&description);
		markdown.push_str("\n\n");
	}

	markdown.push_str("**Latest:** ");
	markdown.push_str(
		package
			.version
			.as_deref()
			.filter(|version| !version.is_empty())
			.unwrap_or("unknown"),
	);
	if let Some(license) = package.license.as_ref().and_then(License::display) {
		markdown.push_str(" · **License:** ");
		markdown.push_str(license);
	}
	markdown.push('\n');
	if let Some(downloads) = weekly_downloads {
		markdown.push_str("**Weekly Downloads:** ");
		markdown.push_str(&format_compact_number(downloads));
		markdown.push('\n');
	}
	markdown.push('\n');

	if let Some(homepage) = package.homepage.filter(|value| !value.is_empty()) {
		markdown.push_str("**Homepage:** ");
		markdown.push_str(&homepage);
		markdown.push('\n');
	}
	if let Some(repository) = package
		.repository
		.as_ref()
		.and_then(Repository::url)
		.filter(|value| !value.is_empty())
	{
		let repository = repository.strip_prefix("git+").unwrap_or(repository);
		let repository = repository.strip_suffix(".git").unwrap_or(repository);
		markdown.push_str("**Repository:** ");
		markdown.push_str(repository);
		markdown.push('\n');
	}
	if let Some(keywords) = package.keywords.filter(|values| !values.is_empty()) {
		markdown.push_str("**Keywords:** ");
		append_joined(&mut markdown, keywords.iter().map(String::as_str));
		markdown.push('\n');
	}
	if let Some(maintainers) = package.maintainers.filter(|values| !values.is_empty()) {
		markdown.push_str("**Maintainers:** ");
		append_joined(
			&mut markdown,
			maintainers
				.iter()
				.map(|maintainer| maintainer.name.as_str()),
		);
		markdown.push('\n');
	}

	if let Some(dependencies) = package.dependencies.filter(|values| !values.is_empty()) {
		markdown.push_str("\n## Dependencies\n\n");
		for (dependency, version) in dependencies {
			markdown.push_str("- ");
			markdown.push_str(&dependency);
			markdown.push_str(": ");
			markdown.push_str(&version);
			markdown.push('\n');
		}
	}

	if let Some(readme) = package.readme.filter(|value| !value.is_empty()) {
		markdown.push_str("\n---\n\n## README\n\n");
		markdown.push_str(&readme);
		markdown.push('\n');
	}

	let mut result = RenderResult::markdown(&markdown, "npm");
	result
		.diags
		.push(Diag::info(DiagKind::Provenance, "Fetched via npm registry"));
	Ok(Some(result))
}

fn parse(url: &Url) -> Option<Target> {
	if !matches!(url.host_str()?, "www.npmjs.com" | "npmjs.com") {
		return None;
	}

	let remainder = url.path().strip_prefix("/package/")?;
	let first_raw = remainder
		.split_once('/')
		.map_or(remainder, |(first, _)| first);
	if first_raw.is_empty() {
		return None;
	}
	let mut package = percent_decode_component(first_raw)?;

	// The scoped-package fallback operates on the still-encoded pathname, so
	// a literal leading `@` is significant here.
	if package.starts_with('@')
		&& remainder.starts_with('@')
		&& let Some((scope, after_scope)) = remainder.split_once('/')
		&& !scope.is_empty()
	{
		let name = after_scope
			.split_once('/')
			.map_or(after_scope, |(name, _)| name);
		if !name.is_empty() {
			package = percent_decode_component(&format!("{scope}/{name}"))?;
		}
	}

	Some(Target { package: package.into() })
}

fn append_joined<'a>(output: &mut String, values: impl IntoIterator<Item = &'a str>) {
	let mut values = values.into_iter();
	if let Some(first) = values.next() {
		output.push_str(first);
		for value in values {
			output.push_str(", ");
			output.push_str(value);
		}
	}
}

struct Dependencies(Vec<(String, String)>);

impl Dependencies {
	const fn is_empty(&self) -> bool {
		self.0.is_empty()
	}
}

impl IntoIterator for Dependencies {
	type IntoIter = vec::IntoIter<Self::Item>;
	type Item = (String, String);

	fn into_iter(self) -> Self::IntoIter {
		self.0.into_iter()
	}
}

impl<'de> Deserialize<'de> for Dependencies {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: Deserializer<'de>,
	{
		// `serde_json::Map` is specialized to `Value`. Deserialize through that
		// representation so its preserve_order backing retains registry order,
		// then validate every dependency version as a string.
		let values = Map::<String, Value>::deserialize(deserializer)?;
		let entries = values
			.into_iter()
			.map(|(name, value)| {
				String::deserialize(value)
					.map(|version| (name, version))
					.map_err(de::Error::custom)
			})
			.collect::<Result<_, _>>()?;
		Ok(Self(entries))
	}
}

#[derive(Deserialize)]
struct Package {
	name:         String,
	version:      Option<String>,
	description:  Option<String>,
	license:      Option<License>,
	homepage:     Option<String>,
	repository:   Option<Repository>,
	keywords:     Option<Vec<String>>,
	maintainers:  Option<Vec<Maintainer>>,
	dependencies: Option<Dependencies>,
	readme:       Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum License {
	Text(String),
	Object { r#type: Option<String> },
}

impl License {
	fn display(&self) -> Option<&str> {
		match self {
			Self::Text(value) => (!value.is_empty()).then_some(value.as_str()),
			Self::Object { r#type: Some(value) } => Some(value.as_str()),
			Self::Object { r#type: None } => Some("[object Object]"),
		}
	}
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Repository {
	Text(String),
	Object { url: Option<String> },
}

impl Repository {
	fn url(&self) -> Option<&str> {
		match self {
			Self::Text(url) => Some(url),
			Self::Object { url } => url.as_deref(),
		}
	}
}

#[derive(Deserialize)]
struct Maintainer {
	name: String,
}

#[derive(Deserialize)]
struct DownloadCount {
	downloads: Option<u64>,
}
