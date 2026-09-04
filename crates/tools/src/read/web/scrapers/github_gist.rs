//! Anonymous GitHub Gist API renderer.

use std::{cmp, fmt::Write};

use omp_tool::{Diag, DiagKind};
use serde::{Deserialize, Deserializer, de};
use serde_json::{Map, Value};
use url::Url;

use super::{
	super::types::{HttpClient, RenderResult, WebError},
	github::api_json,
};

const API_ROOT: &str = "https://api.github.com/gists";

#[derive(Deserialize)]
struct Gist {
	description: Option<String>,
	owner:       Option<Owner>,
	created_at:  String,
	updated_at:  String,
	#[serde(default)]
	comments:    u64,
	files:       GistFiles,
}

#[derive(Deserialize)]
struct Owner {
	login: String,
}

#[derive(Deserialize)]
struct GistFile {
	filename: String,
	language: Option<String>,
	content:  String,
}
#[derive(Deserialize)]
struct GistComment {
	user:       Option<Owner>,
	created_at: String,
	body:       String,
}

struct GistFiles(Vec<GistFile>);

impl GistFiles {
	const fn len(&self) -> usize {
		self.0.len()
	}

	fn values(&self) -> impl Iterator<Item = &GistFile> {
		self.0.iter()
	}
}

impl<'de> Deserialize<'de> for GistFiles {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: Deserializer<'de>,
	{
		// JSON.parse creates an ordinary JavaScript object. Object.values emits
		// canonical array-index keys first in numeric order, then the remaining
		// keys in insertion order.
		let files = Map::<String, Value>::deserialize(deserializer)?;
		let mut files = files
			.into_iter()
			.enumerate()
			.map(|(position, (key, value))| {
				let index = js_array_index(&key);
				GistFile::deserialize(value)
					.map(|file| (position, index, file))
					.map_err(de::Error::custom)
			})
			.collect::<Result<Vec<_>, _>>()?;
		files.sort_by(|left, right| match (left.1, right.1) {
			(Some(left), Some(right)) => left.cmp(&right),
			(Some(_), None) => cmp::Ordering::Less,
			(None, Some(_)) => cmp::Ordering::Greater,
			(None, None) => left.0.cmp(&right.0),
		});
		Ok(Self(files.into_iter().map(|(_, _, file)| file).collect()))
	}
}

fn js_array_index(key: &str) -> Option<u32> {
	let bytes = key.as_bytes();
	if bytes.is_empty() || (bytes.len() > 1 && bytes[0] == b'0') {
		return None;
	}
	let mut value = 0_u32;
	for byte in bytes {
		if !byte.is_ascii_digit() {
			return None;
		}
		value = value
			.checked_mul(10)?
			.checked_add(u32::from(*byte - b'0'))?;
	}
	(value != u32::MAX).then_some(value)
}

/// Returns whether `url` is hosted by GitHub Gist.
pub(super) fn matches(url: &Url) -> bool {
	url.host_str() == Some("gist.github.com")
}

/// Renders a public or secret gist through GitHub's anonymous API.
pub(super) async fn render<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
) -> Result<Option<RenderResult>, WebError> {
	if !matches(url) {
		return Ok(None);
	}
	let Some(gist_id) = gist_id(url) else {
		return Ok(None);
	};

	let Some(gist): Option<Gist> = api_json(client, &format!("{API_ROOT}/{gist_id}")).await? else {
		return Ok(None);
	};

	let owner = gist
		.owner
		.as_ref()
		.map(|owner| owner.login.as_str())
		.filter(|login| !login.is_empty())
		.unwrap_or("anonymous");
	let mut markdown = format!("# Gist by {owner}\n\n");
	if let Some(description) = gist
		.description
		.as_deref()
		.filter(|value| !value.is_empty())
	{
		markdown.push_str(description);
		markdown.push_str("\n\n");
	}
	write!(
		markdown,
		"**Created:** {} · **Updated:** {}\n**Files:** {}\n\n",
		gist.created_at,
		gist.updated_at,
		gist.files.len()
	)
	.expect("writing to a String cannot fail");

	// serde_json's insertion-ordered map preserves the file ordering supplied by
	// GitHub, matching JavaScript's Object.values(gist.files).
	for file in gist.files.values() {
		let language = file.language.as_deref().unwrap_or("").to_lowercase();
		markdown.push_str("---\n\n## ");
		markdown.push_str(&file.filename);
		markdown.push_str("\n\n```");
		markdown.push_str(&language);
		markdown.push('\n');
		markdown.push_str(&file.content);
		markdown.push_str("\n```\n\n");
	}
	if gist.comments > 0
		&& let Some(comments) =
			api_json::<_, Vec<GistComment>>(client, &format!("{API_ROOT}/{gist_id}/comments")).await?
		&& !comments.is_empty()
	{
		write!(markdown, "---\n\n## Comments ({})\n\n", comments.len())
			.expect("writing to a String cannot fail");
		for comment in comments {
			let author = comment
				.user
				.as_ref()
				.map(|user| user.login.as_str())
				.filter(|login| !login.is_empty())
				.unwrap_or("anonymous");
			write!(markdown, "### @{author} · {}\n\n{}\n\n", comment.created_at, comment.body)
				.expect("writing to a String cannot fail");
		}
	}

	let mut result = RenderResult::markdown(&markdown, "github-gist");
	result
		.diags
		.insert(0, Diag::info(DiagKind::Provenance, "Fetched via GitHub API"));
	Ok(Some(result))
}

fn gist_id(url: &Url) -> Option<&str> {
	let candidate = url.path_segments()?.rfind(|part| !part.is_empty())?;
	(!candidate.is_empty() && candidate.bytes().all(|byte| byte.is_ascii_hexdigit()))
		.then_some(candidate)
}
