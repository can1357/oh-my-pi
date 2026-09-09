//! GitHub Copilot credential shaping and plan-endpoint discovery.

use std::{
	borrow::Cow,
	collections::{HashMap, hash_map::DefaultHasher},
	fmt,
	future::Future,
	hash::{Hash, Hasher},
	pin::Pin,
	sync::Arc,
	task::{Context, Poll},
	time::{Duration, Instant},
};

use futures::{
	FutureExt as _,
	future::{BoxFuture, Either, ready},
};
use http::{
	HeaderMap, HeaderValue, Method,
	header::{ACCEPT, AUTHORIZATION, USER_AGENT},
};
use omp_catalog::ProviderId;
use omp_core::{ExposeSecret as _, SecretString, Str, sf};
use parking_lot::Mutex;
use serde::Deserialize;
use tokio::time;
use url::Url;
use zeroize::Zeroizing;

use super::{
	oauth::{OAuthHttpClient, OAuthHttpRequest},
	shape::{ProviderShapeFuture, ShapedCredential},
};

/// User agent sent to GitHub and Copilot endpoints.
pub const COPILOT_USER_AGENT: &str = "opencode/1.3.15";
/// GitHub API version expected by Copilot endpoints.
pub const COPILOT_API_VERSION: &str = "2026-06-01";
/// Default endpoint for personal GitHub Copilot subscriptions.
pub const PERSONAL_GITHUB_COPILOT_BASE_URL: &str = "https://api.githubcopilot.com";
/// Public GitHub hosts that cannot identify an enterprise installation.
pub const PUBLIC_GITHUB_HOSTS: &[&str] = &["api.github.com", "github.com", "www.github.com"];
const COPILOT_USER_URL: &str = "https://api.github.com/copilot_internal/user";
const MAX_PROBE_DURATION: Duration = Duration::from_secs(10);

/// Returns whether `host` is one of GitHub's public hosts.
pub fn is_public_github_host(host: &str) -> bool {
	let normalized = host.trim().to_ascii_lowercase();
	PUBLIC_GITHUB_HOSTS.contains(&normalized.as_str())
}

/// Returns whether `base_url` is exactly the personal Copilot endpoint.
pub fn is_personal_base_url(base_url: &str) -> bool {
	base_url == PERSONAL_GITHUB_COPILOT_BASE_URL
}

/// Normalizes a domain or URL to its hostname.
pub fn normalize_domain(input: &str) -> Option<Str> {
	let trimmed = input.trim();
	if trimmed.is_empty() {
		return None;
	}
	let candidate = if trimmed.contains("://") {
		Cow::Borrowed(trimmed)
	} else {
		Cow::Owned(format!("https://{trimmed}"))
	};
	Url::parse(&candidate)
		.ok()?
		.host_str()
		.filter(|host| !host.is_empty())
		.map(Str::new)
}

/// Normalizes an enterprise GitHub domain, rejecting public GitHub hosts.
pub fn normalize_enterprise_domain(input: &str) -> Option<Str> {
	let trimmed = input.trim();
	if trimmed.is_empty() {
		return None;
	}
	let normalized =
		normalize_domain(trimmed).unwrap_or_else(|| Str::new(trimmed.to_ascii_lowercase()));
	if normalized.is_empty() || is_public_github_host(&normalized) {
		None
	} else {
		Some(normalized)
	}
}

/// Normalizes a secure Copilot API endpoint and removes all trailing slashes.
pub fn normalize_api_endpoint(input: &str) -> Option<Str> {
	let trimmed = input.trim();
	if !trimmed.starts_with("https://") {
		return None;
	}
	let url = Url::parse(trimmed).ok()?;
	if url.scheme() != "https" || url.host_str().is_none_or(str::is_empty) {
		return None;
	}
	Some(Str::new(trimmed.trim_end_matches('/')))
}

/// Resolves the Copilot API base URL for an optional enterprise domain.
pub fn copilot_base_url(enterprise_domain: Option<&str>) -> Str {
	let Some(domain) = enterprise_domain.and_then(normalize_enterprise_domain) else {
		return sf!(PERSONAL_GITHUB_COPILOT_BASE_URL);
	};
	if domain.starts_with("copilot-api.") {
		sf!("https://{domain}")
	} else {
		sf!("https://copilot-api.{domain}")
	}
}

/// Parsed GitHub Copilot credential material.
pub struct ParsedCopilotApiKey {
	/// Access token applied to Copilot API requests.
	pub access_token:   SecretString,
	/// Optional normalized GitHub Enterprise domain.
	pub enterprise_url: Option<Str>,
	/// Optional normalized plan-specific Copilot API endpoint.
	pub api_endpoint:   Option<Str>,
}

impl fmt::Debug for ParsedCopilotApiKey {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("ParsedCopilotApiKey")
			.field("access_token", &"[REDACTED]")
			.field("enterprise_url", &self.enterprise_url)
			.field("api_endpoint", &self.api_endpoint)
			.finish()
	}
}

#[derive(Deserialize)]
#[serde(untagged)]
enum LooseString<'a> {
	String(#[serde(borrow)] Cow<'a, str>),
	Other(serde::de::IgnoredAny),
}

impl LooseString<'_> {
	fn as_str(&self) -> Option<&str> {
		match self {
			Self::String(value) => Some(value),
			Self::Other(_) => None,
		}
	}
}

#[derive(Deserialize)]
struct CopilotEnvelope<'a> {
	#[serde(borrow)]
	token:          LooseString<'a>,
	#[serde(rename = "enterpriseUrl", borrow, default)]
	enterprise_url: Option<LooseString<'a>>,
	#[serde(rename = "apiEndpoint", borrow, default)]
	api_endpoint:   Option<LooseString<'a>>,
}

fn parse_copilot_envelope(raw: &str) -> Option<ParsedCopilotApiKey> {
	if !raw.trim_start().starts_with('{') {
		return None;
	}
	let envelope = serde_json::from_str::<CopilotEnvelope<'_>>(raw).ok()?;
	let token = envelope.token.as_str()?;
	Some(ParsedCopilotApiKey {
		access_token:   SecretString::from(token.to_owned()),
		enterprise_url: envelope
			.enterprise_url
			.as_ref()
			.and_then(LooseString::as_str)
			.and_then(normalize_enterprise_domain),
		api_endpoint:   envelope
			.api_endpoint
			.as_ref()
			.and_then(LooseString::as_str)
			.and_then(normalize_api_endpoint),
	})
}

/// Parses a JSON Copilot credential envelope or preserves a bare token
/// verbatim.
pub fn parse_copilot_api_key(raw: &str) -> ParsedCopilotApiKey {
	parse_copilot_envelope(raw).unwrap_or_else(|| ParsedCopilotApiKey {
		access_token:   SecretString::from(raw.to_owned()),
		enterprise_url: None,
		api_endpoint:   None,
	})
}

#[derive(Deserialize)]
struct CopilotUserResponse<'a> {
	#[serde(borrow)]
	endpoints: CopilotEndpoints<'a>,
}

#[derive(Deserialize)]
struct CopilotEndpoints<'a> {
	#[serde(borrow)]
	api: Cow<'a, str>,
}

/// Probes GitHub for the plan-specific Copilot API endpoint associated with
/// `token`.
pub async fn discover_copilot_api_endpoint(token: &str, http: &dyn OAuthHttpClient) -> Option<Str> {
	let mut headers = HeaderMap::new();
	headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
	headers.insert(USER_AGENT, HeaderValue::from_static(COPILOT_USER_AGENT));
	let mut authorization_bytes = Zeroizing::new(Vec::with_capacity(6 + token.len()));
	authorization_bytes.extend_from_slice(b"token ");
	authorization_bytes.extend_from_slice(token.as_bytes());
	let mut authorization = HeaderValue::from_bytes(&authorization_bytes).ok()?;
	authorization.set_sensitive(true);
	headers.insert(AUTHORIZATION, authorization);
	let request = OAuthHttpRequest::new(Method::GET, COPILOT_USER_URL, headers, None).ok()?;
	let response = http.execute(request).await.ok()?;
	if !(200..300).contains(&response.status) {
		return None;
	}
	let parsed =
		serde_json::from_str::<CopilotUserResponse<'_>>(response.body.expose_secret()).ok()?;
	normalize_api_endpoint(&parsed.endpoints.api)
}

/// Cold boxed future for one bounded Copilot plan-endpoint probe.
///
/// The allocation is quarantined behind this type and is constructed only on
/// a positive need to perform network I/O after a memo-cache miss.
pub struct CopilotProbeFuture<'a>(BoxFuture<'a, Option<ShapedCredential>>);

impl<'a> CopilotProbeFuture<'a> {
	const fn new(future: BoxFuture<'a, Option<ShapedCredential>>) -> Self {
		Self(future)
	}
}

impl Future for CopilotProbeFuture<'_> {
	type Output = Option<ShapedCredential>;

	fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
		self.0.as_mut().poll(context)
	}
}

/// GitHub Copilot credential shaper with positive plan-endpoint memoization.
pub struct GithubCopilotShaper {
	provider:  ProviderId,
	http:      Arc<dyn OAuthHttpClient>,
	endpoints: Mutex<HashMap<u64, Str>>,
}

impl GithubCopilotShaper {
	/// Constructs a shaper using the supplied bounded OAuth HTTP transport.
	pub fn new(http: Arc<dyn OAuthHttpClient>) -> Self {
		Self {
			provider: ProviderId::from("github-copilot"),
			http,
			endpoints: Mutex::new(HashMap::new()),
		}
	}

	/// Provider whose credentials this shaper rewrites.
	pub fn provider(&self) -> &ProviderId<str> {
		&self.provider
	}

	/// Unwraps Copilot envelopes and resolves plan-specific API endpoints.
	///
	/// Synchronous and memoized paths return a ready future. Only an actual
	/// endpoint probe allocates a boxed future.
	pub fn shape<'a>(
		&'a self,
		raw: &'a SecretString,
		route_base_url: &'a str,
		deadline: Option<Instant>,
	) -> ProviderShapeFuture<'a> {
		if let Some(parsed) = parse_copilot_envelope(raw.expose_secret()) {
			let ParsedCopilotApiKey { access_token, enterprise_url, api_endpoint } = parsed;
			let endpoint_override = if route_base_url.contains("githubcopilot.com") {
				api_endpoint.or_else(|| {
					enterprise_url
						.as_deref()
						.map(|domain| copilot_base_url(Some(domain)))
				})
			} else {
				None
			};
			if endpoint_override.is_some() || !is_personal_base_url(route_base_url) {
				return Either::Left(ready(Some(ShapedCredential {
					secret: Some(access_token),
					endpoint_override,
				})));
			}
			let hash = token_hash(access_token.expose_secret());
			let endpoint = self.endpoints.lock().get(&hash).cloned();
			if let Some(endpoint) = endpoint {
				return Either::Left(ready(Some(ShapedCredential {
					secret:            Some(access_token),
					endpoint_override: Some(endpoint),
				})));
			}
			let remaining = probe_duration(deadline);
			return Either::Right(CopilotProbeFuture::new(
				async move {
					let discovered = time::timeout(
						remaining,
						discover_copilot_api_endpoint(access_token.expose_secret(), self.http.as_ref()),
					)
					.await
					.ok()
					.flatten();
					if let Some(endpoint) = &discovered {
						self.endpoints.lock().insert(hash, endpoint.clone());
					}
					Some(ShapedCredential {
						secret:            Some(access_token),
						endpoint_override: discovered,
					})
				}
				.boxed(),
			));
		}

		if !is_personal_base_url(route_base_url) {
			return Either::Left(ready(None));
		}
		let token = raw.expose_secret();
		let hash = token_hash(token);
		let endpoint = self.endpoints.lock().get(&hash).cloned();
		if let Some(endpoint) = endpoint {
			return Either::Left(ready(Some(ShapedCredential {
				secret:            None,
				endpoint_override: Some(endpoint),
			})));
		}
		let remaining = probe_duration(deadline);
		Either::Right(CopilotProbeFuture::new(
			async move {
				let discovered =
					time::timeout(remaining, discover_copilot_api_endpoint(token, self.http.as_ref()))
						.await
						.ok()
						.flatten();
				if let Some(endpoint) = &discovered {
					self.endpoints.lock().insert(hash, endpoint.clone());
				}
				discovered.map(|endpoint| ShapedCredential {
					secret:            None,
					endpoint_override: Some(endpoint),
				})
			}
			.boxed(),
		))
	}
}

fn token_hash(token: &str) -> u64 {
	let mut hasher = DefaultHasher::new();
	token.as_bytes().hash(&mut hasher);
	hasher.finish()
}

fn probe_duration(deadline: Option<Instant>) -> Duration {
	deadline
		.map_or(MAX_PROBE_DURATION, |deadline| deadline.saturating_duration_since(Instant::now()))
		.min(MAX_PROBE_DURATION)
}

#[cfg(test)]
mod tests {
	use std::sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	};

	use futures::future::{BoxFuture, Either};
	use http::HeaderMap;
	use omp_core::SecretString;
	use parking_lot::Mutex;

	use super::*;
	use crate::auth::{OAuthHttpResponse, OAuthTransportError};

	struct FakeHttpClient {
		calls:    AtomicUsize,
		requests: Mutex<Vec<(Method, String, HeaderMap)>>,
		result:   Result<(u16, &'static str), OAuthTransportError>,
	}

	impl FakeHttpClient {
		fn response(body: &'static str) -> Arc<Self> {
			Arc::new(Self {
				calls:    AtomicUsize::new(0),
				requests: Mutex::new(Vec::new()),
				result:   Ok((200, body)),
			})
		}

		fn failure() -> Arc<Self> {
			Arc::new(Self {
				calls:    AtomicUsize::new(0),
				requests: Mutex::new(Vec::new()),
				result:   Err(OAuthTransportError),
			})
		}
	}

	impl OAuthHttpClient for FakeHttpClient {
		fn execute(
			&self,
			request: OAuthHttpRequest,
		) -> BoxFuture<'_, Result<OAuthHttpResponse, OAuthTransportError>> {
			self.calls.fetch_add(1, Ordering::SeqCst);
			let (method, url, headers, _) = request.into_parts();
			self
				.requests
				.lock()
				.push((method, url.to_string(), headers));
			let result = self
				.result
				.as_ref()
				.map(|(status, body)| OAuthHttpResponse {
					status:  *status,
					headers: HeaderMap::new(),
					body:    SecretString::from((*body).to_owned()),
				})
				.map_err(|_| OAuthTransportError);
			async move { result }.boxed()
		}
	}

	#[tokio::test]
	async fn bare_token_probes_personal_plan_endpoint() {
		let http = FakeHttpClient::response(
			r#"{"endpoints":{"api":"https://api.business.githubcopilot.com"}}"#,
		);
		let shaper = GithubCopilotShaper::new(http.clone());
		let token = SecretString::from("ghu_token".to_owned());
		let future = shaper.shape(&token, PERSONAL_GITHUB_COPILOT_BASE_URL, None);
		assert!(matches!(&future, Either::Right(_)));
		let shaped = future.await.expect("discovered endpoint");
		assert!(shaped.secret.is_none());
		assert_eq!(
			shaped.endpoint_override.as_deref(),
			Some("https://api.business.githubcopilot.com")
		);
		{
			let requests = http.requests.lock();
			assert_eq!(requests.len(), 1);
			assert_eq!(requests[0].0, Method::GET);
			assert_eq!(requests[0].1, COPILOT_USER_URL);
			assert_eq!(requests[0].2[AUTHORIZATION], "token ghu_token");
			assert_eq!(requests[0].2[USER_AGENT], COPILOT_USER_AGENT);
			assert_eq!(requests[0].2[ACCEPT], "application/json");
			assert!(requests[0].2[AUTHORIZATION].is_sensitive());
		}
		let future = shaper.shape(&token, PERSONAL_GITHUB_COPILOT_BASE_URL, None);
		assert!(matches!(&future, Either::Left(_)));
		let memoized = future.await.expect("memoized endpoint");
		assert!(memoized.secret.is_none());
		assert_eq!(
			memoized.endpoint_override.as_deref(),
			Some("https://api.business.githubcopilot.com")
		);
		assert_eq!(http.calls.load(Ordering::SeqCst), 1);
	}

	#[tokio::test]
	async fn probe_failure_preserves_bare_token_and_retries_next_acquisition() {
		let http = FakeHttpClient::failure();
		let shaper = GithubCopilotShaper::new(http.clone());
		let raw = SecretString::from("raw".to_owned());
		let shaped = shaper
			.shape(&raw, PERSONAL_GITHUB_COPILOT_BASE_URL, None)
			.await;
		assert!(shaped.is_none());
		let retried = shaper
			.shape(&raw, PERSONAL_GITHUB_COPILOT_BASE_URL, None)
			.await;
		assert!(retried.is_none());
		assert_eq!(http.calls.load(Ordering::SeqCst), 2);
	}

	#[tokio::test]
	async fn envelope_api_endpoint_skips_probe() {
		let http = FakeHttpClient::failure();
		let shaper = GithubCopilotShaper::new(http.clone());
		let raw = SecretString::from(
			r#"{"token":"inner","apiEndpoint":"https://api.business.githubcopilot.com///"}"#
				.to_owned(),
		);
		let shaped = shaper
			.shape(&raw, PERSONAL_GITHUB_COPILOT_BASE_URL, None)
			.await
			.expect("envelope rewrite");
		assert_eq!(shaped.secret.as_ref().expect("inner token").expose_secret(), "inner",);
		assert_eq!(
			shaped.endpoint_override.as_deref(),
			Some("https://api.business.githubcopilot.com")
		);
		assert_eq!(http.calls.load(Ordering::SeqCst), 0);
	}

	#[tokio::test]
	async fn enterprise_envelope_skips_probe() {
		let http = FakeHttpClient::failure();
		let shaper = GithubCopilotShaper::new(http.clone());
		let raw =
			SecretString::from(r#"{"token":"inner","enterpriseUrl":"ghe.example.com"}"#.to_owned());
		let shaped = shaper
			.shape(&raw, PERSONAL_GITHUB_COPILOT_BASE_URL, None)
			.await
			.expect("enterprise envelope");
		assert_eq!(shaped.endpoint_override.as_deref(), Some("https://copilot-api.ghe.example.com"));
		assert_eq!(http.calls.load(Ordering::SeqCst), 0);
	}

	#[tokio::test]
	async fn bare_token_on_custom_route_skips_probe() {
		let http = FakeHttpClient::failure();
		let shaper = GithubCopilotShaper::new(http.clone());
		let shaped = shaper
			.shape(&SecretString::from("raw".to_owned()), "https://copilot.internal.example", None)
			.await;
		assert!(shaped.is_none());
		assert_eq!(http.calls.load(Ordering::SeqCst), 0);
	}

	#[test]
	fn normalization_matches_copilot_wire_rules() {
		assert_eq!(
			normalize_api_endpoint(" https://api.example.com/// ").as_deref(),
			Some("https://api.example.com")
		);
		assert_eq!(normalize_api_endpoint("http://api.example.com"), None);
		assert_eq!(normalize_enterprise_domain("https://www.github.com/path"), None);
		assert_eq!(
			normalize_domain("https://GHE.Example.com/some/path").as_deref(),
			Some("ghe.example.com")
		);
		assert!(is_public_github_host(" API.GITHUB.COM "));
		assert!(is_personal_base_url(PERSONAL_GITHUB_COPILOT_BASE_URL));
		assert!(!is_personal_base_url("https://api.githubcopilot.com/"));
		assert_eq!(normalize_domain("  "), None);
	}

	#[test]
	fn parses_envelopes_and_preserves_non_envelopes() {
		let parsed = parse_copilot_api_key(
			r#"{"token":"inner","enterpriseUrl":"https://GHE.Example.com/path","apiEndpoint":"https://copilot.example.com//"}"#,
		);
		assert_eq!(parsed.access_token.expose_secret(), "inner");
		assert_eq!(parsed.enterprise_url.as_deref(), Some("ghe.example.com"));
		assert_eq!(parsed.api_endpoint.as_deref(), Some("https://copilot.example.com"));
		let bare = parse_copilot_api_key(r#"{"token":7}"#);
		assert_eq!(bare.access_token.expose_secret(), r#"{"token":7}"#);
		assert_eq!(bare.enterprise_url, None);
		assert_eq!(bare.api_endpoint, None);
		let debug = format!("{parsed:?}");
		assert!(!debug.contains("inner"));
		assert!(debug.contains("[REDACTED]"));
	}

	#[test]
	fn resolves_personal_and_enterprise_base_urls() {
		assert_eq!(copilot_base_url(None), PERSONAL_GITHUB_COPILOT_BASE_URL);
		assert_eq!(copilot_base_url(Some("ghe.example.com")), "https://copilot-api.ghe.example.com");
		assert_eq!(
			copilot_base_url(Some("copilot-api.ghe.example.com")),
			"https://copilot-api.ghe.example.com"
		);
	}
}
