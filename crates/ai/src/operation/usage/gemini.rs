//! Google Gemini CLI Code Assist quota retrieval.

use std::{
	sync::Arc,
	time::{Instant, SystemTime, UNIX_EPOCH},
};

use futures::FutureExt as _;
use http::{
	HeaderMap, HeaderValue, Method,
	header::{AUTHORIZATION, CONTENT_TYPE, USER_AGENT},
};
use omp_core::{ExposeSecret as _, SecretString, Str, parse_rfc3339, sf};
use serde::Deserialize;
use serde_json::{Map, Value};
use tokio::time;
use zeroize::Zeroizing;

use crate::{
	answer::{
		UsageAccountMetadata, UsageAmount, UsageQuantity, UsageStatus, UsageUnit, UsageWindow,
		UsageWindowKind,
	},
	auth::{OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse},
	catalog::ProviderId,
	operation::usage::{
		ConsoleUsageFetcher, ConsoleUsageObservation, UsageCredentialRequirement, UsageFetchError,
	},
	receipt::UsageSource,
};

const PROVIDER: &str = "google-gemini-cli";
const DEFAULT_ENDPOINT: &str = "https://cloudcode-pa.googleapis.com";
const CLIENT_METADATA: &str =
	"ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI";
const GEMINI_USER_AGENT: &str = "GeminiCLI/0.46.0/gemini-3.1-pro-preview (darwin; arm64; terminal)";

/// Application-registered Google Gemini CLI usage fetcher.
#[derive(Clone)]
pub struct GeminiUsageFetcher {
	provider: ProviderId,
	http:     Arc<dyn OAuthHttpClient>,
}
impl GeminiUsageFetcher {
	/// Constructs a Gemini CLI usage fetcher.
	pub fn new(http: Arc<dyn OAuthHttpClient>) -> Self {
		Self { provider: ProviderId::from(PROVIDER), http }
	}
}
impl ConsoleUsageFetcher for GeminiUsageFetcher {
	fn provider(&self) -> &ProviderId<str> {
		&self.provider
	}

	fn credential_requirement(&self) -> UsageCredentialRequirement {
		UsageCredentialRequirement::Required
	}

	fn fetch<'a>(
		&'a self,
		credential: Option<&'a SecretString>,
		now: SystemTime,
		deadline: Option<Instant>,
	) -> futures::future::BoxFuture<'a, Result<ConsoleUsageObservation, UsageFetchError>> {
		async move {
			let raw = credential.ok_or(UsageFetchError::Protocol)?.expose_secret();
			fetch_gemini_usage_until(raw, self.http.as_ref(), now, deadline).await
		}
		.boxed()
	}
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
	#[serde(default, rename = "type")]
	type_:        String,
	#[serde(default)]
	access_token: String,
	#[serde(default)]
	token:        String,
	expires_at:   Option<u64>,
	project_id:   Option<String>,
	account_id:   Option<String>,
	email:        Option<String>,
	base_url:     Option<String>,
	api_endpoint: Option<String>,
}
struct Credential {
	token:      Zeroizing<String>,
	expires_at: Option<u64>,
	project_id: Option<Str>,
	account_id: Option<Str>,
	email:      Option<Str>,
	base_url:   Str,
}
fn parse_credential(raw: &str) -> Option<Credential> {
	if !raw.trim_start().starts_with('{') {
		return Some(Credential {
			token:      Zeroizing::new(raw.to_owned()),
			expires_at: None,
			project_id: None,
			account_id: None,
			email:      None,
			base_url:   sf!(DEFAULT_ENDPOINT),
		});
	}
	let envelope: Envelope = serde_json::from_str(raw).ok()?;
	if envelope.type_.eq_ignore_ascii_case("api_key") {
		return None;
	}
	let token = if envelope.access_token.is_empty() {
		envelope.token
	} else {
		envelope.access_token
	};
	if token.is_empty() {
		return None;
	}
	let base = envelope
		.base_url
		.or(envelope.api_endpoint)
		.unwrap_or_else(|| DEFAULT_ENDPOINT.to_owned());
	Some(Credential {
		token:      Zeroizing::new(token),
		expires_at: envelope.expires_at,
		project_id: envelope
			.project_id
			.filter(|v| !v.trim().is_empty())
			.map(Str::new),
		account_id: envelope
			.account_id
			.filter(|v| !v.trim().is_empty())
			.map(Str::new),
		email:      envelope
			.email
			.filter(|v| !v.trim().is_empty())
			.map(Str::new),
		base_url:   Str::new(base.trim_end_matches('/')),
	})
}

/// Fetches Gemini CLI Code Assist quota from an OAuth credential.
pub async fn fetch_gemini_usage(
	raw: &str,
	http: &dyn OAuthHttpClient,
	now: SystemTime,
) -> Result<ConsoleUsageObservation, UsageFetchError> {
	fetch_gemini_usage_until(raw, http, now, None).await
}
async fn fetch_gemini_usage_until(
	raw: &str,
	http: &dyn OAuthHttpClient,
	now: SystemTime,
	deadline: Option<Instant>,
) -> Result<ConsoleUsageObservation, UsageFetchError> {
	let credential = parse_credential(raw).ok_or(UsageFetchError::Unavailable)?;
	let now_ms = now
		.duration_since(UNIX_EPOCH)
		.ok()
		.and_then(|v| u64::try_from(v.as_millis()).ok())
		.unwrap_or(0);
	if credential
		.expires_at
		.is_some_and(|expires| expires <= now_ms)
	{
		return Err(UsageFetchError::Unavailable);
	}
	let load_body = load_body(credential.project_id.as_deref());
	let load = execute(
		http,
		post_request(
			&format!("{}/v1internal:loadCodeAssist", credential.base_url),
			&credential.token,
			load_body,
		)?,
		deadline,
	)
	.await
	.ok_or(UsageFetchError::Unavailable)?;
	if !(200..300).contains(&load.status) {
		return Err(UsageFetchError::Unavailable);
	}
	let load: Value =
		serde_json::from_str(load.body.expose_secret()).map_err(|_| UsageFetchError::Unavailable)?;
	let project_id = credential.project_id.or_else(|| project_id(&load));
	let quota_body = quota_body(project_id.as_deref());
	let quota = execute(
		http,
		post_request(
			&format!("{}/v1internal:retrieveUserQuota", credential.base_url),
			&credential.token,
			quota_body,
		)?,
		deadline,
	)
	.await
	.ok_or(UsageFetchError::Unavailable)?;
	if !(200..300).contains(&quota.status) {
		return Err(UsageFetchError::Unavailable);
	}
	let windows = parse_quota(
		quota.body.expose_secret(),
		credential.account_id.as_deref(),
		project_id.as_deref(),
		now,
	)
	.ok_or(UsageFetchError::Unavailable)?;
	let plan = load
		.get("currentTier")
		.and_then(Value::as_object)
		.and_then(|tier| tier.get("name").or_else(|| tier.get("id")))
		.and_then(Value::as_str)
		.map(Str::new);
	Ok(ConsoleUsageObservation {
		account_meta: UsageAccountMetadata {
			provider_account_id: credential.account_id,
			email: credential.email,
			project_id,
			..UsageAccountMetadata::default()
		},
		plan,
		source_label: Some(sf!("cloudcode-pa")),
		notes: Box::default(),
		reset_credits: None,
		windows,
	})
}
fn load_body(project: Option<&str>) -> SecretString {
	let mut root = Map::new();
	if let Some(project) = project {
		root.insert("cloudaicompanionProject".to_owned(), Value::String(project.to_owned()));
	}
	root.insert("metadata".to_owned(),serde_json::json!({"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}));
	SecretString::from(serde_json::to_string(&root).expect("static Gemini load body"))
}
fn quota_body(project: Option<&str>) -> SecretString {
	let mut root = Map::new();
	if let Some(project) = project {
		root.insert("project".to_owned(), Value::String(project.to_owned()));
	}
	SecretString::from(serde_json::to_string(&root).expect("static Gemini quota body"))
}
fn auth(token: &str) -> Result<HeaderValue, UsageFetchError> {
	let mut bytes = Zeroizing::new(Vec::with_capacity(7 + token.len()));
	bytes.extend_from_slice(b"Bearer ");
	bytes.extend_from_slice(token.as_bytes());
	let mut value = HeaderValue::from_bytes(&bytes).map_err(|_| UsageFetchError::Protocol)?;
	value.set_sensitive(true);
	Ok(value)
}
fn post_request(
	url: &str,
	token: &str,
	body: SecretString,
) -> Result<OAuthHttpRequest, UsageFetchError> {
	let mut headers = HeaderMap::new();
	headers.insert(AUTHORIZATION, auth(token)?);
	headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
	headers.insert(USER_AGENT, HeaderValue::from_static(GEMINI_USER_AGENT));
	headers.insert("client-metadata", HeaderValue::from_static(CLIENT_METADATA));
	OAuthHttpRequest::new(Method::POST, url, headers, Some(body))
		.map_err(|_| UsageFetchError::Protocol)
}
async fn execute(
	http: &dyn OAuthHttpClient,
	request: OAuthHttpRequest,
	deadline: Option<Instant>,
) -> Option<OAuthHttpResponse> {
	match deadline {
		Some(deadline) => time::timeout_at(deadline.into(), http.execute(request))
			.await
			.ok()?
			.ok(),
		None => http.execute(request).await.ok(),
	}
}
fn project_id(load: &Value) -> Option<Str> {
	match load.get("cloudaicompanionProject")? {
		Value::String(value) => Some(Str::new(value.as_str())),
		Value::Object(value) => value.get("id").and_then(Value::as_str).map(Str::new),
		_ => None,
	}
}
fn q(value: f64) -> UsageQuantity {
	UsageQuantity::new((value.clamp(0.0, 100.0) * 10.0).round() as u64, 1)
}
fn parse_quota(
	body: &str,
	account: Option<&str>,
	project: Option<&str>,
	now: SystemTime,
) -> Option<Vec<UsageWindow>> {
	let root: Value = serde_json::from_str(body).ok()?;
	let buckets = root.get("buckets")?.as_array()?;
	let mut windows = Vec::with_capacity(buckets.len());
	for (index, bucket) in buckets.iter().enumerate() {
		let Some(bucket) = bucket.as_object() else {
			continue;
		};
		let remaining = bucket
			.get("remainingFraction")
			.and_then(Value::as_f64)?
			.clamp(0.0, 1.0);
		let used = (1.0 - remaining).clamp(0.0, 1.0);
		let model = bucket.get("modelId").and_then(Value::as_str);
		let tier = model.and_then(|model| omp_catalog::quota_display_tier(PROVIDER, model));
		let resets_at = bucket
			.get("resetTime")
			.and_then(Value::as_str)
			.and_then(parse_rfc3339);
		let window_id = resets_at
			.and_then(|reset| reset.duration_since(UNIX_EPOCH).ok())
			.map_or_else(|| "quota".to_owned(), |duration| format!("reset-{}", duration.as_millis()));
		let id =
			model.map_or_else(|| format!("unknown:{index}"), |model| format!("{model}:{window_id}"));
		let label = model.map_or_else(|| sf!("Gemini quota"), |model| sf!("Gemini {model}"));
		let scope = sf!(
			"account={};project={};model={};tier={};window={window_id}",
			account.unwrap_or(""),
			project.unwrap_or(""),
			model.unwrap_or(""),
			tier.unwrap_or("")
		);
		windows.push(UsageWindow {
			id: Str::new(id),
			kind: UsageWindowKind::Quota,
			dimension: sf!("quota"),
			label: Some(label),
			scope: Some(scope),
			amount: UsageAmount {
				unit:      UsageUnit::Percent,
				consumed:  Some(q(used * 100.0)),
				remaining: Some(q(remaining * 100.0)),
				limit:     Some(q(100.0)),
			},
			status: Some(if remaining <= 0.0 {
				UsageStatus::Exhausted
			} else if remaining <= 0.1 {
				UsageStatus::Warning
			} else {
				UsageStatus::Ok
			}),
			duration: None,
			resets_at,
			reset_label: None,
			notes: Box::default(),
			source: UsageSource::Provider,
			observed_at: now,
		});
	}
	(!windows.is_empty()).then_some(windows)
}

#[cfg(test)]
mod tests {
	use std::{
		collections::VecDeque,
		sync::Arc,
		time::{Duration, SystemTime},
	};

	use futures::{FutureExt as _, future::BoxFuture};
	use http::{HeaderMap, Method};
	use omp_core::{ExposeSecret as _, SecretString};
	use parking_lot::Mutex;

	use super::fetch_gemini_usage;
	use crate::auth::{OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse, OAuthTransportError};
	#[derive(Clone)]
	struct Req {
		method:  Method,
		url:     String,
		headers: HeaderMap,
		body:    String,
	}
	#[derive(Clone, Default)]
	struct Http {
		responses: Arc<Mutex<VecDeque<OAuthHttpResponse>>>,
		requests:  Arc<Mutex<Vec<Req>>>,
	}
	impl Http {
		fn new(items: impl IntoIterator<Item = (u16, &'static str)>) -> Self {
			Self {
				responses: Arc::new(Mutex::new(
					items
						.into_iter()
						.map(|(status, body)| OAuthHttpResponse {
							status,
							headers: HeaderMap::new(),
							body: SecretString::from(body.to_owned()),
						})
						.collect(),
				)),
				requests:  Arc::new(Mutex::new(Vec::new())),
			}
		}
	}
	impl OAuthHttpClient for Http {
		fn execute(
			&self,
			request: OAuthHttpRequest,
		) -> BoxFuture<'_, Result<OAuthHttpResponse, OAuthTransportError>> {
			let (method, url, headers, body) = request.into_parts();
			self.requests.lock().push(Req {
				method,
				url: url.to_string(),
				headers,
				body: body.expect("body").expose_secret().to_owned(),
			});
			let response = self.responses.lock().pop_front().expect("response");
			async move { Ok(response) }.boxed()
		}
	}
	#[tokio::test]
	async fn resolves_project_and_maps_model_tiers() {
		let http = Http::new([
			(
				200,
				r#"{"cloudaicompanionProject":"projects/resolved","currentTier":{"id":"standard-tier","name":"Standard Tier"}}"#,
			),
			(
				200,
				r#"{"buckets":[{"modelId":"gemini-3-flash-preview","remainingFraction":0.75,"resetTime":"2026-08-15T00:00:00Z"},{"modelId":"gemini-2.5-flash","remainingFraction":1},{"modelId":"gemini-3.1-pro","remainingFraction":0.5}]}"#,
			),
		]);
		let report = fetch_gemini_usage("access-secret", &http, SystemTime::UNIX_EPOCH)
			.await
			.expect("report");
		assert_eq!(report.plan.as_deref(), Some("Standard Tier"));
		assert_eq!(report.account_meta.project_id.as_deref(), Some("projects/resolved"));
		assert!(
			report.windows[0]
				.scope
				.as_deref()
				.expect("scope")
				.contains("tier=3-Flash")
		);
		assert!(
			report.windows[1]
				.scope
				.as_deref()
				.expect("scope")
				.contains("tier=Flash")
		);
		assert!(
			report.windows[2]
				.scope
				.as_deref()
				.expect("scope")
				.contains("tier=Pro")
		);
		let requests = http.requests.lock();
		assert_eq!(requests[0].method, Method::POST);
		assert!(requests[0].url.ends_with("v1internal:loadCodeAssist"));
		assert_eq!(
			requests[0].headers["client-metadata"],
			"ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI"
		);
		assert_eq!(
			requests[0].headers["user-agent"],
			"GeminiCLI/0.46.0/gemini-3.1-pro-preview (darwin; arm64; terminal)"
		);
		assert_eq!(requests[1].body, r#"{"project":"projects/resolved"}"#);
	}
	#[tokio::test]
	async fn credential_project_is_sent_to_both_requests() {
		let http = Http::new([
			(200, r#"{"currentTier":{"id":"paid"}}"#),
			(200, r#"{"buckets":[{"modelId":"gemini-2.5-pro","remainingFraction":0.1}]}"#),
		]);
		let raw = r#"{"accessToken":"secret","projectId":"projects/stored"}"#;
		fetch_gemini_usage(raw, &http, SystemTime::UNIX_EPOCH)
			.await
			.expect("report");
		let requests = http.requests.lock();
		assert!(
			requests[0]
				.body
				.contains(r#""cloudaicompanionProject":"projects/stored""#)
		);
		assert_eq!(requests[1].body, r#"{"project":"projects/stored"}"#);
	}
	#[tokio::test]
	async fn expired_and_non_success_responses_are_unavailable() {
		let empty = Http::default();
		let raw = r#"{"accessToken":"secret","expiresAt":1}"#;
		assert!(
			fetch_gemini_usage(raw, &empty, SystemTime::UNIX_EPOCH + Duration::from_secs(1))
				.await
				.is_err()
		);
		assert!(empty.requests.lock().is_empty());
		let http = Http::new([(500, "{}")]);
		assert!(
			fetch_gemini_usage("secret", &http, SystemTime::UNIX_EPOCH)
				.await
				.is_err()
		);
		assert_eq!(http.requests.lock().len(), 1);
	}
}
