//! Remote reader backends (Jina Reader, Firecrawl, Parallel): services that
//! fetch a URL from their own servers.
//!
//! A wall refusing this host may let them in. This module builds their requests
//! and parses their replies; the reader decides when to use them.

use serde_json::{Value, json};
use url::Url;

use crate::{
	reader::{Purpose, Request, Response, Retry},
	strategy::{self, header},
	wall,
};

const JINA_DEFAULT_BASE: &str = "https://r.jina.ai";
const FIRECRAWL_DEFAULT_BASE: &str = "https://api.firecrawl.dev/v2";
const PARALLEL_DEFAULT_BASE: &str = "https://api.parallel.ai";
const PARALLEL_BETA_HEADER: &str = "search-extract-2025-10-10";
/// Jina answers this much at most; a larger reply is cut and rejected.
const JINA_MAX_BYTES: usize = 2 * 1024 * 1024;
/// API replies carrying a whole page as JSON.
const API_MAX_BYTES: usize = 8 * 1024 * 1024;
const JINA_MARKDOWN_MARKER: &str = "Markdown Content:";
/// A remote rendering this short holds no content.
const MIN_CONTENT_CHARS: usize = 100;

/// A remote reader service.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
	/// Jina Reader (`r.jina.ai`); works without a key when the caller allows
	/// keyless use.
	Jina,
	/// Firecrawl `/scrape`; needs a key.
	Firecrawl,
	/// Parallel `/v1beta/extract`; needs a key.
	Parallel,
}

impl Kind {
	/// Parse a backend name (`jina`, `firecrawl`, `parallel`).
	pub fn parse(name: &str) -> Option<Self> {
		match name {
			"jina" => Some(Self::Jina),
			"firecrawl" => Some(Self::Firecrawl),
			"parallel" => Some(Self::Parallel),
			_ => None,
		}
	}

	/// Stable name, also the page strategy of a reply it supplied.
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Jina => "jina",
			Self::Firecrawl => "firecrawl",
			Self::Parallel => "parallel",
		}
	}
}

/// One configured remote reader.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backend {
	/// Which service.
	pub kind:     Kind,
	/// API key; Firecrawl and Parallel are skipped without one.
	pub api_key:  Option<String>,
	/// Self-hosted or proxy base URL replacing the service default.
	pub base_url: Option<String>,
}

fn base<'a>(backend: &'a Backend, default: &'a str) -> &'a str {
	backend
		.base_url
		.as_deref()
		.map(str::trim)
		.filter(|s| !s.is_empty())
		.unwrap_or(default)
		.trim_end_matches('/')
}

/// Firecrawl's `/scrape` endpoint under `base`: a configured base keeps an
/// explicit `/v1` or `/v2` suffix and otherwise gets `/v2`.
fn firecrawl_endpoint(backend: &Backend) -> Option<String> {
	let configured = backend
		.base_url
		.as_deref()
		.map(str::trim)
		.filter(|s| !s.is_empty());
	let Some(configured) = configured else {
		return Some(format!("{FIRECRAWL_DEFAULT_BASE}/scrape"));
	};
	let mut url = Url::parse(configured).ok()?;
	if !matches!(url.scheme(), "http" | "https")
		|| !url.username().is_empty()
		|| url.password().is_some()
	{
		return None;
	}
	url.set_query(None);
	url.set_fragment(None);
	let mut path = url.path().trim_end_matches('/').to_owned();
	let versioned = path.len() >= 3 && {
		let tail = path[path.len() - 3..].to_ascii_lowercase();
		tail == "/v1" || tail == "/v2"
	};
	if !versioned {
		path.push_str("/v2");
	}
	path.push_str("/scrape");
	url.set_path(&path);
	Some(url.into())
}

fn json_request(
	url: String,
	headers: Vec<(String, String)>,
	body: &Value,
	retry: Retry,
) -> Request {
	let mut all = vec![
		("Accept".to_owned(), "application/json".to_owned()),
		("Content-Type".to_owned(), "application/json".to_owned()),
	];
	all.extend(headers);
	Request {
		url,
		method: "POST".to_owned(),
		headers: all,
		body: Some(body.to_string().into_bytes()),
		max_bytes: API_MAX_BYTES,
		purpose: Purpose::Remote,
		retry,
	}
}

fn plain_target(target: &Url) -> bool {
	matches!(target.scheme(), "http" | "https")
		&& target.username().is_empty()
		&& target.password().is_none()
}

fn key(backend: &Backend) -> Option<&str> {
	backend
		.api_key
		.as_deref()
		.map(str::trim)
		.filter(|s| !s.is_empty())
}

/// The request asking `backend` to read `target`, or `None` when the backend
/// lacks a key it needs or the target is not a plain http(s) URL.
pub fn request(backend: &Backend, target: &Url) -> Option<Request> {
	match backend.kind {
		Kind::Jina if plain_target(target) => {
			let mut headers = vec![
				("Accept".to_owned(), "text/markdown".to_owned()),
				("X-No-Cache".to_owned(), "true".to_owned()),
			];
			if let Some(key) = key(backend) {
				headers.push(("Authorization".to_owned(), format!("Bearer {key}")));
			}
			Some(Request {
				url: format!("{}/{target}", base(backend, JINA_DEFAULT_BASE)),
				method: "GET".to_owned(),
				headers,
				body: None,
				max_bytes: JINA_MAX_BYTES,
				purpose: Purpose::Remote,
				retry: Retry::None,
			})
		},
		Kind::Firecrawl if plain_target(target) => Some(json_request(
			firecrawl_endpoint(backend)?,
			vec![("Authorization".to_owned(), format!("Bearer {}", key(backend)?))],
			&json!({ "url": target.as_str(), "formats": ["markdown"] }),
			// Firecrawl marks 408, 429 and 5xx retryable; one quick retry before
			// the next reader.
			Retry::Transient,
		)),
		Kind::Parallel => parallel_request(backend, target, "Extract the main content"),
		_ => None,
	}
}

/// Ask Parallel for excerpts matching a site-specific extraction objective.
pub fn parallel_request(backend: &Backend, target: &Url, objective: &str) -> Option<Request> {
	if backend.kind != Kind::Parallel || !plain_target(target) {
		return None;
	}
	let key = key(backend)?;
	Some(json_request(
		format!("{}/v1beta/extract", base(backend, PARALLEL_DEFAULT_BASE)),
		vec![
			("x-api-key".to_owned(), key.to_owned()),
			("parallel-beta".to_owned(), PARALLEL_BETA_HEADER.to_owned()),
		],
		&json!({
			"urls": [target.as_str()],
			"objective": objective,
			"excerpts": true,
			"full_content": false,
		}),
		Retry::None,
	))
}

/// Markdown from a backend's reply, or `None` when it failed, holds an error
/// or block page, or is too short to be the page.
pub fn parse(kind: Kind, response: &Response) -> Option<String> {
	if !(200..300).contains(&response.status) || response.truncated {
		return None;
	}
	// A reply declared over the cap is refused even when the transport read less
	// of it.
	let declared =
		header(&response.headers, "content-length").and_then(|v| v.trim().parse::<usize>().ok());
	if kind == Kind::Jina && declared.is_some_and(|length| length > JINA_MAX_BYTES) {
		return None;
	}
	let text =
		crate::decode::decode(&response.body, header(&response.headers, "content-type"), false);
	let content = match kind {
		Kind::Jina => jina(&text)?,
		Kind::Firecrawl => firecrawl(&serde_json::from_str(&text).ok()?)?,
		Kind::Parallel => parallel(&serde_json::from_str(&text).ok()?)?,
	};
	let content = content.trim();
	if !strategy::longer_than(content, MIN_CONTENT_CHARS) || wall::is_block_page(content) {
		return None;
	}
	Some(content.to_owned())
}

/// Jina's reply after its `Markdown Content:` marker, unless its header warns
/// that the target answered with an error page.
fn jina(body: &str) -> Option<String> {
	let start = body.find(JINA_MARKDOWN_MARKER)?;
	if body[..start]
		.lines()
		.any(|line| line.starts_with("Warning: Target URL returned error"))
	{
		return None;
	}
	let content = body[start + JINA_MARKDOWN_MARKER.len()..].trim();
	if content.starts_with("Loading...") || content.starts_with("Please enable JavaScript") {
		return None;
	}
	Some(content.to_owned())
}

/// Firecrawl's `data.markdown`, unless the scrape failed or the target answered
/// with an error status.
fn firecrawl(payload: &Value) -> Option<String> {
	if payload.get("success").and_then(Value::as_bool) == Some(false) {
		return None;
	}
	let data = payload.get("data")?;
	let status = data.pointer("/metadata/statusCode").and_then(Value::as_u64);
	if status.is_some_and(|status| status >= 400) {
		return None;
	}
	data
		.get("markdown")
		.and_then(Value::as_str)
		.map(str::to_owned)
}

/// Parallel's first result: its non-empty excerpts, else its full content.
fn parallel(payload: &Value) -> Option<String> {
	let first = payload
		.get("results")?
		.as_array()?
		.iter()
		.find(|item| item.get("url").and_then(Value::as_str).is_some())?;
	let excerpts = first
		.get("excerpts")
		.and_then(Value::as_array)
		.map_or_default(|items| {
			items
				.iter()
				.filter_map(Value::as_str)
				.filter(|s| !s.trim().is_empty())
				.collect::<Vec<_>>()
				.join("\n\n")
		});
	if !excerpts.trim().is_empty() {
		return Some(excerpts);
	}
	first
		.get("full_content")
		.and_then(Value::as_str)
		.map(str::to_owned)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn backend(kind: Kind, key: Option<&str>, base: Option<&str>) -> Backend {
		Backend { kind, api_key: key.map(str::to_owned), base_url: base.map(str::to_owned) }
	}

	fn reply(body: &str) -> Response {
		Response { status: 200, body: body.as_bytes().to_vec(), ..Response::default() }
	}

	const PROSE: &str = "Neural networks are not just another classifier; they change how software \
	                     is written. Neural networks are not just another classifier.";

	#[test]
	fn requests() {
		let target = Url::parse("https://x.test/post").unwrap();
		let jina = request(&backend(Kind::Jina, None, None), &target).unwrap();
		assert_eq!(jina.url, "https://r.jina.ai/https://x.test/post");
		assert!(header(&jina.headers, "authorization").is_none());
		assert!(request(&backend(Kind::Firecrawl, None, None), &target).is_none());
		let firecrawl =
			request(&backend(Kind::Firecrawl, Some("k"), Some("http://fc.local/")), &target).unwrap();
		assert_eq!(firecrawl.url, "http://fc.local/v2/scrape");
		let pinned =
			request(&backend(Kind::Firecrawl, Some("k"), Some("http://fc.local/V1?x=1")), &target)
				.unwrap();
		assert_eq!(pinned.url, "http://fc.local/V1/scrape");
		let parallel = request(&backend(Kind::Parallel, Some("k"), None), &target).unwrap();
		assert_eq!(parallel.url, "https://api.parallel.ai/v1beta/extract");
		assert_eq!(header(&parallel.headers, "x-api-key"), Some("k"));
		let body: Value = serde_json::from_slice(parallel.body.as_deref().unwrap()).unwrap();
		assert_eq!(body["urls"][0], "https://x.test/post");
		assert!(
			request(&backend(Kind::Jina, None, None), &Url::parse("https://u:p@x.test/").unwrap())
				.is_none()
		);
	}

	#[test]
	fn replies() {
		let page = format!("Title: Post\n\nMarkdown Content:\n# Post\n\n{PROSE}");
		assert!(
			parse(Kind::Jina, &reply(&page))
				.unwrap()
				.starts_with("# Post")
		);
		let mut oversized = reply(&page);
		oversized
			.headers
			.push(("Content-Length".to_owned(), (JINA_MAX_BYTES + 1).to_string()));
		assert_eq!(parse(Kind::Jina, &oversized), None);
		let failed =
			format!("Warning: Target URL returned error 403: Forbidden\n\nMarkdown Content:\n{PROSE}");
		assert_eq!(parse(Kind::Jina, &reply(&failed)), None);
		let blocked = "Markdown Content:\nYou've been blocked by network security.\n\nTo continue, \
		               log in to your account or use your developer token";
		assert_eq!(parse(Kind::Jina, &reply(blocked)), None);

		let scrape = json!({ "success": true, "data": { "markdown": PROSE, "metadata": { "statusCode": 200 } } });
		assert_eq!(parse(Kind::Firecrawl, &reply(&scrape.to_string())).as_deref(), Some(PROSE));
		let error = json!({ "success": true, "data": { "markdown": PROSE, "metadata": { "statusCode": 404 } } });
		assert_eq!(parse(Kind::Firecrawl, &reply(&error.to_string())), None);

		let extract = json!({ "results": [{ "url": "https://x.test/post", "excerpts": ["", PROSE], "full_content": "x" }] });
		assert_eq!(parse(Kind::Parallel, &reply(&extract.to_string())).as_deref(), Some(PROSE));
	}
}
