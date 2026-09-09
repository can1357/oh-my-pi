//! MCP protocol-header precedence and redirect-origin enforcement.

use http::{
	HeaderMap, HeaderName, Method, StatusCode,
	header::{HOST, LOCATION},
};
use url::Url;

const MAX_REDIRECT_HOPS: u8 = 5;
const RESERVED_HEADERS: [&str; 6] =
	["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id", "host"];

/// Validates that user/package configuration cannot inject transport-owned
/// headers.
pub fn validate_configured_headers(headers: &HeaderMap) -> Result<(), HeaderPolicyError> {
	for name in headers.keys() {
		if RESERVED_HEADERS
			.iter()
			.any(|reserved| name.as_str().eq_ignore_ascii_case(reserved))
		{
			return Err(HeaderPolicyError::ReservedHeader { name: name.clone() });
		}
	}
	Ok(())
}

/// Merges configured headers beneath transport-generated headers.
pub fn merge_headers(
	generated: &HeaderMap,
	configured: &HeaderMap,
) -> Result<HeaderMap, HeaderPolicyError> {
	validate_configured_headers(configured)?;
	let mut merged = configured.clone();
	for (name, value) in generated {
		merged.insert(name, value.clone());
	}
	Ok(merged)
}

/// Manual redirect state for one logical MCP HTTP request.
#[derive(Clone, Debug)]
pub struct RedirectPolicy {
	configured_origin: Origin,
	current:           Url,
	hops:              u8,
	origin_locked:     bool,
}

impl RedirectPolicy {
	/// Creates a redirect policy rooted at the configured MCP endpoint.
	pub fn new(url: Url, origin_locked: bool) -> Result<Self, HeaderPolicyError> {
		let configured_origin = Origin::from_url(&url)?;
		Ok(Self { configured_origin, current: url, hops: 0, origin_locked })
	}

	/// Current request URL.
	pub fn url(&self) -> &Url {
		&self.current
	}

	/// Builds this hop's headers, stripping configured and sensitive generated
	/// headers whenever an origin-locked request leaves its configured origin.
	pub fn headers(
		&self,
		generated: &HeaderMap,
		configured: &HeaderMap,
	) -> Result<HeaderMap, HeaderPolicyError> {
		if !self.origin_locked || Origin::from_url(&self.current)? == self.configured_origin {
			return merge_headers(generated, configured);
		}
		let mut stripped = HeaderMap::with_capacity(generated.len());
		for (name, value) in generated {
			if !is_sensitive_header(name) && name.as_str() != HOST.as_str() {
				stripped.append(name.clone(), value.clone());
			}
		}
		Ok(stripped)
	}

	/// Applies one redirect response. Returns `false` for non-redirect status.
	/// POST/DELETE follow only method-preserving 307/308 responses.
	pub fn redirect(
		&mut self,
		method: &Method,
		status: StatusCode,
		location: Option<&str>,
	) -> Result<bool, HeaderPolicyError> {
		if !matches!(
			status,
			StatusCode::MOVED_PERMANENTLY
				| StatusCode::FOUND
				| StatusCode::SEE_OTHER
				| StatusCode::TEMPORARY_REDIRECT
				| StatusCode::PERMANENT_REDIRECT
		) {
			return Ok(false);
		}
		let Some(location) = location else {
			return Ok(false);
		};
		if *method != Method::GET
			&& !matches!(status, StatusCode::TEMPORARY_REDIRECT | StatusCode::PERMANENT_REDIRECT)
		{
			return Err(HeaderPolicyError::MethodChangingRedirect { status: status.as_u16() });
		}
		if self.hops == MAX_REDIRECT_HOPS {
			return Err(HeaderPolicyError::TooManyRedirects);
		}
		let next = self
			.current
			.join(location)
			.map_err(HeaderPolicyError::Url)?;
		if !matches!(next.scheme(), "http" | "https") || next.host_str().is_none() {
			return Err(HeaderPolicyError::UnsupportedRedirectScheme);
		}
		self.current = next;
		self.hops += 1;
		Ok(true)
	}
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Origin {
	scheme: String,
	host:   String,
	port:   Option<u16>,
}
impl Origin {
	fn from_url(url: &Url) -> Result<Self, HeaderPolicyError> {
		let host = url.host_str().ok_or(HeaderPolicyError::MissingOrigin)?;
		Ok(Self {
			scheme: url.scheme().to_owned(),
			host:   host.to_ascii_lowercase(),
			port:   url.port_or_known_default(),
		})
	}
}

/// Returns whether a header can carry credentials and must be redacted or
/// removed when an origin-locked redirect crosses origins.
pub(crate) fn is_sensitive_header(name: &HeaderName) -> bool {
	let folded = name.as_str();
	[
		"authorization",
		"cookie",
		"secret",
		"password",
		"token",
		"credential",
		"api-key",
		"apikey",
		"private-key",
		"signature",
		"mcp-session-id",
		"last-event-id",
	]
	.iter()
	.any(|needle| folded.contains(needle))
}

/// Returns the redirect location as UTF-8 when present.
pub fn redirect_location(headers: &HeaderMap) -> Option<&str> {
	headers.get(LOCATION).and_then(|value| value.to_str().ok())
}

/// MCP HTTP header-policy failure.
#[derive(Debug, thiserror::Error)]
pub enum HeaderPolicyError {
	/// Configuration attempted to inject a transport-owned header.
	#[error("configured MCP header `{name}` is reserved by the transport")]
	ReservedHeader { name: HeaderName },
	/// Configured URL has no HTTP origin.
	#[error("MCP endpoint URL has no origin")]
	MissingOrigin,
	/// Redirect URL is malformed.
	#[error("MCP redirect URL is malformed")]
	Url(#[source] url::ParseError),
	/// Redirect left HTTP(S).
	#[error("MCP redirect URL must use HTTP or HTTPS")]
	UnsupportedRedirectScheme,
	/// Non-GET request attempted a method-changing redirect.
	#[error("MCP HTTP status {status} would change a non-GET request method")]
	MethodChangingRedirect { status: u16 },
	/// Manual redirect budget was exhausted.
	#[error("MCP HTTP redirect exceeded five hops")]
	TooManyRedirects,
}

#[cfg(test)]
mod tests {
	use http::HeaderValue;

	use super::*;

	#[test]
	fn generated_headers_win_and_reserved_config_is_rejected() {
		let generated = HeaderMap::from_iter([(
			HeaderName::from_static("authorization"),
			HeaderValue::from_static("Bearer live"),
		)]);
		let configured = HeaderMap::from_iter([(
			HeaderName::from_static("authorization"),
			HeaderValue::from_static("Bearer stale"),
		)]);
		assert_eq!(
			merge_headers(&generated, &configured).expect("merge")["authorization"],
			"Bearer live"
		);
		let reserved = HeaderMap::from_iter([(
			HeaderName::from_static("mcp-protocol-version"),
			HeaderValue::from_static("old"),
		)]);
		assert!(matches!(
			merge_headers(&generated, &reserved),
			Err(HeaderPolicyError::ReservedHeader { .. })
		));
	}

	#[test]
	fn cross_origin_strips_credentials_and_post_follows_only_307_308() {
		let mut policy = RedirectPolicy::new(Url::parse("https://one.test/mcp").expect("url"), true)
			.expect("policy");
		assert!(matches!(
			policy.redirect(&Method::POST, StatusCode::FOUND, Some("https://two.test/mcp")),
			Err(HeaderPolicyError::MethodChangingRedirect { .. })
		));
		assert!(
			policy
				.redirect(&Method::POST, StatusCode::TEMPORARY_REDIRECT, Some("https://two.test/mcp"))
				.expect("redirect")
		);
		let generated = HeaderMap::from_iter([
			(HeaderName::from_static("authorization"), HeaderValue::from_static("secret")),
			(HeaderName::from_static("x-api-key"), HeaderValue::from_static("secret")),
			(HeaderName::from_static("mcp-session-id"), HeaderValue::from_static("session-secret")),
		]);
		let configured = HeaderMap::from_iter([(
			HeaderName::from_static("x-package-secret"),
			HeaderValue::from_static("secret"),
		)]);
		let headers = policy.headers(&generated, &configured).expect("headers");
		assert!(!headers.contains_key("authorization"));
		assert!(!headers.contains_key("x-api-key"));
		assert!(!headers.contains_key("mcp-session-id"));
		assert!(!headers.contains_key("x-package-secret"));
	}

	#[test]
	fn redirect_budget_is_exactly_five_hops() {
		let mut policy =
			RedirectPolicy::new(Url::parse("https://one.test/0").expect("url"), true).expect("policy");
		for index in 1..=5 {
			assert!(
				policy
					.redirect(&Method::GET, StatusCode::FOUND, Some(&format!("/{index}")))
					.expect("redirect")
			);
		}
		assert!(matches!(
			policy.redirect(&Method::GET, StatusCode::FOUND, Some("/6")),
			Err(HeaderPolicyError::TooManyRedirects)
		));
	}
}
