//! Google Antigravity backend-counter quota retrieval.

use std::{
	collections::BTreeMap,
	sync::Arc,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures::FutureExt as _;
use http::{
	HeaderMap, HeaderValue, Method,
	header::{AUTHORIZATION, CONTENT_TYPE, USER_AGENT},
};
use omp_core::{ExposeSecret as _, SecretString, Str, parse_rfc3339, sf};
use serde::Deserialize;
use serde_json::{Value, json};
use smallvec::SmallVec;
use tokio::time;
use zeroize::Zeroizing;

use crate::{
	answer::{
		UsageAccountMetadata, UsageAmount, UsageQuantity, UsageStatus, UsageUnit, UsageWindow,
		UsageWindowKind,
	},
	auth::{OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse as AuthOAuthHttpResponse},
	catalog::ProviderId,
	codec::google_cca::{
		DEFAULT_ANTIGRAVITY_ARCH, DEFAULT_ANTIGRAVITY_CL, DEFAULT_ANTIGRAVITY_OS,
		DEFAULT_ANTIGRAVITY_VERSION,
	},
	operation::usage::{
		ConsoleUsageFetcher, ConsoleUsageObservation, UsageCredentialRequirement, UsageFetchError,
	},
	receipt::UsageSource,
};

const PROVIDER: &str = "google-antigravity";
const DEFAULT_ENDPOINT: &str = "https://daily-cloudcode-pa.googleapis.com";
const SANDBOX_ENDPOINT: &str = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const FETCH_AVAILABLE_MODELS_PATH: &str = "/v1internal:fetchAvailableModels";
const DAY: Duration = Duration::from_days(1);
const WEEK: Duration = Duration::from_days(7);

/// Maps one Antigravity model identity to its independent backend quota
/// counter.
///
/// The mapping is catalog-authored so newly discovered model families use the
/// same counter policy as credential ranking and status presentation.
pub fn antigravity_counter_for_model(model_id: &str) -> Option<&'static str> {
	let direct = omp_catalog::quota_display_tier(PROVIDER, model_id);
	if direct.is_some() || !model_id.bytes().any(|byte| byte.is_ascii_uppercase()) {
		return direct;
	}
	let normalized = model_id.to_ascii_lowercase();
	omp_catalog::quota_display_tier(PROVIDER, &normalized)
}

/// Selects quota windows for the active Antigravity model family.
///
/// Legacy `default` counters are used only when the mapped backend counter has
/// no limits. An absent or unmodelled identity returns no windows, preventing a
/// family-specific exhaustion observation from becoming a provider-wide block.
pub fn scope_antigravity_windows_for_model<'a>(
	windows: &'a [UsageWindow],
	model_id: Option<&str>,
) -> SmallVec<&'a UsageWindow, 4> {
	let Some(counter) = model_id.and_then(antigravity_counter_for_model) else {
		return SmallVec::new();
	};
	let has_counter = windows
		.iter()
		.any(|window| antigravity_window_counter(window.id.as_str()) == Some(counter));
	let selected = if has_counter { counter } else { "default" };
	windows
		.iter()
		.filter(|window| antigravity_window_counter(window.id.as_str()) == Some(selected))
		.collect()
}

fn antigravity_window_counter(id: &str) -> Option<&str> {
	id.strip_prefix("google-antigravity:")?
		.split_once(':')
		.map(|(counter, _)| counter)
}

/// Application-registered Google Antigravity usage fetcher.
#[derive(Clone)]
pub struct GoogleAntigravityUsageFetcher {
	provider: ProviderId,
	http:     Arc<dyn OAuthHttpClient>,
}

impl GoogleAntigravityUsageFetcher {
	/// Constructs an Antigravity usage fetcher.
	pub fn new(http: Arc<dyn OAuthHttpClient>) -> Self {
		Self { provider: ProviderId::from(PROVIDER), http }
	}
}
impl ConsoleUsageFetcher for GoogleAntigravityUsageFetcher {
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
			fetch_google_antigravity_usage_until(raw, self.http.as_ref(), now, deadline).await
		}
		.boxed()
	}
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
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
	project_id: Str,
	account_id: Option<Str>,
	email:      Option<Str>,
	base_url:   Str,
}
fn parse_credential(raw: &str) -> Option<Credential> {
	if !raw.trim_start().starts_with('{') {
		return None;
	}
	let envelope: Envelope = serde_json::from_str(raw).ok()?;
	let token = if envelope.access_token.is_empty() {
		envelope.token
	} else {
		envelope.access_token
	};
	let project = envelope.project_id?.trim().to_owned();
	if token.is_empty() || project.is_empty() {
		return None;
	}
	let base = envelope
		.base_url
		.or(envelope.api_endpoint)
		.unwrap_or_else(|| DEFAULT_ENDPOINT.to_owned());
	Some(Credential {
		token:      Zeroizing::new(token),
		expires_at: envelope.expires_at,
		project_id: Str::new(project),
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

/// Fetches Antigravity model quota counters from a credential envelope.
pub async fn fetch_google_antigravity_usage(
	raw: &str,
	http: &dyn OAuthHttpClient,
	now: SystemTime,
) -> Result<ConsoleUsageObservation, UsageFetchError> {
	fetch_google_antigravity_usage_until(raw, http, now, None).await
}
async fn fetch_google_antigravity_usage_until(
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
	let response = execute(
		http,
		request(&credential.base_url, &credential.token, &credential.project_id)?,
		deadline,
	)
	.await
	.ok_or(UsageFetchError::Unavailable)?;
	let response = if [429, 500, 502, 503, 504].contains(&response.status)
		&& credential.base_url.as_str() != SANDBOX_ENDPOINT
	{
		execute(http, request(SANDBOX_ENDPOINT, &credential.token, &credential.project_id)?, deadline)
			.await
			.ok_or(UsageFetchError::Unavailable)?
	} else {
		response
	};
	if !(200..300).contains(&response.status) {
		return Err(UsageFetchError::Unavailable);
	}
	let (plan, windows) = parse_response(
		response.body.expose_secret(),
		credential.account_id.as_deref(),
		&credential.project_id,
		now,
	)
	.ok_or(UsageFetchError::Unavailable)?;
	Ok(ConsoleUsageObservation {
		account_meta: UsageAccountMetadata {
			provider_account_id: credential.account_id,
			email: credential.email,
			project_id: Some(credential.project_id),
			..UsageAccountMetadata::default()
		},
		plan,
		source_label: Some(sf!("daily-cloudcode-pa")),
		notes: Box::default(),
		reset_credits: None,
		windows,
	})
}
fn auth(token: &str) -> Result<HeaderValue, UsageFetchError> {
	let mut bytes = Zeroizing::new(Vec::with_capacity(7 + token.len()));
	bytes.extend_from_slice(b"Bearer ");
	bytes.extend_from_slice(token.as_bytes());
	let mut value = HeaderValue::from_bytes(&bytes).map_err(|_| UsageFetchError::Protocol)?;
	value.set_sensitive(true);
	Ok(value)
}
fn user_agent() -> HeaderValue {
	HeaderValue::from_str(&format!(
		"antigravity/hub/{DEFAULT_ANTIGRAVITY_VERSION} (aidev_client; \
		 os_type={DEFAULT_ANTIGRAVITY_OS}; arch={DEFAULT_ANTIGRAVITY_ARCH}; \
		 cl={DEFAULT_ANTIGRAVITY_CL})"
	))
	.expect("static Antigravity user agent")
}
fn request(base: &str, token: &str, project: &str) -> Result<OAuthHttpRequest, UsageFetchError> {
	let mut headers = HeaderMap::new();
	headers.insert(AUTHORIZATION, auth(token)?);
	headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
	headers.insert(USER_AGENT, user_agent());
	let body =
		serde_json::to_string(&json!({"project":project})).map_err(|_| UsageFetchError::Protocol)?;
	OAuthHttpRequest::new(
		Method::POST,
		&format!("{base}{FETCH_AVAILABLE_MODELS_PATH}"),
		headers,
		Some(SecretString::from(body)),
	)
	.map_err(|_| UsageFetchError::Protocol)
}
async fn execute(
	http: &dyn OAuthHttpClient,
	request: OAuthHttpRequest,
	deadline: Option<Instant>,
) -> Option<AuthOAuthHttpResponse> {
	match deadline {
		Some(deadline) => time::timeout_at(deadline.into(), http.execute(request))
			.await
			.ok()?
			.ok(),
		None => http.execute(request).await.ok(),
	}
}

#[derive(Clone)]
struct Candidate {
	counter:      Str,
	tier:         Str,
	window_id:    &'static str,
	duration:     Duration,
	remaining:    f64,
	has_fraction: bool,
	resets_at:    Option<SystemTime>,
}
fn counter(model: &serde_json::Map<String, Value>) -> (&'static str, &'static str) {
	let text = format!(
		"{} {}",
		model
			.get("modelProvider")
			.and_then(Value::as_str)
			.unwrap_or(""),
		model
			.get("apiProvider")
			.and_then(Value::as_str)
			.unwrap_or("")
	)
	.to_ascii_uppercase();
	if text.contains("ANTHROPIC") {
		("anthropic", "Anthropic")
	} else if text.contains("GOOGLE") || text.contains("GEMINI") {
		("google", "Google")
	} else if text.contains("OPENAI") {
		("openai", "OpenAI")
	} else {
		("default", "")
	}
}
fn collect_infos(
	model: &serde_json::Map<String, Value>,
) -> Vec<(&serde_json::Map<String, Value>, Option<&str>)> {
	let mut out = Vec::new();
	for key in [
		"quotaInfo",
		"quotaInfos",
		"dailyQuotaInfo",
		"dailyQuotaInfos",
		"weeklyQuotaInfo",
		"weeklyQuotaInfos",
		"quotaInfoByTier",
		"quotaInfoByWindow",
		"quotaInfosByWindow",
	] {
		let Some(value) = model.get(key) else {
			continue;
		};
		collect_value(value, Some(key), &mut out);
	}
	out
}
fn collect_value<'a>(
	value: &'a Value,
	hint: Option<&'a str>,
	out: &mut Vec<(&'a serde_json::Map<String, Value>, Option<&'a str>)>,
) {
	match value {
		Value::Object(object)
			if object.contains_key("remainingFraction") || object.contains_key("resetTime") =>
		{
			out.push((object, hint));
		},
		Value::Object(object) => {
			for (key, value) in object {
				collect_value(value, Some(key), out);
			}
		},
		Value::Array(items) => {
			for value in items {
				collect_value(value, hint, out);
			}
		},
		_ => {},
	}
}
fn classify(
	info: &serde_json::Map<String, Value>,
	hint: Option<&str>,
	resets_at: Option<SystemTime>,
	now: SystemTime,
) -> (&'static str, Duration) {
	let text = info
		.get("windowId")
		.or_else(|| info.get("windowLabel"))
		.and_then(Value::as_str)
		.or(hint)
		.unwrap_or("")
		.to_ascii_lowercase();
	if text.contains("week")
		|| text.contains("7d")
		|| text.contains("7-day")
		|| text.contains("7_day")
	{
		("weekly", WEEK)
	} else if text.contains("day") || text.contains("daily") || text.contains("24h") {
		("daily", DAY)
	} else if resets_at
		.and_then(|reset| reset.duration_since(now).ok())
		.is_some_and(|duration| duration > DAY)
	{
		("weekly", WEEK)
	} else {
		("daily", DAY)
	}
}
fn tier(info: &serde_json::Map<String, Value>, hint: Option<&str>) -> String {
	if let Some(tier) = info.get("tier").and_then(Value::as_str) {
		return tier.to_ascii_lowercase();
	}
	let hint = hint.unwrap_or("default").to_ascii_lowercase();
	if ["quota", "window", "daily", "weekly", "day", "week", "7d"]
		.iter()
		.any(|part| hint.contains(part))
	{
		"default".to_owned()
	} else {
		hint
	}
}
fn q(value: f64) -> UsageQuantity {
	UsageQuantity::new((value.clamp(0.0, 100.0) * 1000.0).round() as u64, 3)
}
fn parse_response(
	body: &str,
	account: Option<&str>,
	project: &str,
	now: SystemTime,
) -> Option<(Option<Str>, Vec<UsageWindow>)> {
	let root: Value = serde_json::from_str(body).ok()?;
	let models = root.get("models")?.as_object()?;
	let mut merged: BTreeMap<String, Candidate> = BTreeMap::new();
	for model in models.values().filter_map(Value::as_object) {
		let (counter_key, counter_name) = counter(model);
		for (info, hint) in collect_infos(model) {
			let resets_at = info
				.get("resetTime")
				.and_then(Value::as_str)
				.and_then(parse_rfc3339);
			let fraction = info.get("remainingFraction").and_then(Value::as_f64);
			let has_fraction = fraction.is_some();
			let remaining = fraction
				.unwrap_or_else(|| if resets_at.is_some() { 0.0 } else { 1.0 })
				.clamp(0.0, 1.0);
			let tier = tier(info, hint);
			let (window_id, duration) = classify(info, hint, resets_at, now);
			let key = format!("{counter_key}|{tier}|{window_id}");
			let candidate = Candidate {
				counter: Str::new(if counter_name.is_empty() {
					counter_key
				} else {
					counter_name
				}),
				tier: Str::new(tier),
				window_id,
				duration,
				remaining,
				has_fraction,
				resets_at,
			};
			merged
				.entry(key)
				.and_modify(|existing| {
					if (!existing.has_fraction && candidate.has_fraction)
						|| (existing.has_fraction == candidate.has_fraction
							&& candidate.remaining < existing.remaining)
					{
						existing.remaining = candidate.remaining;
						existing.has_fraction = candidate.has_fraction;
					}
					if existing.resets_at.is_none() {
						existing.resets_at = candidate.resets_at;
					}
				})
				.or_insert(candidate);
		}
	}
	let plan = merged.values().next().map(|value| value.tier.clone());
	let mut windows = merged
		.into_values()
		.map(|candidate| {
			let counter_key = candidate.counter.to_ascii_lowercase();
			let used = (1.0 - candidate.remaining) * 100.0;
			let label = if candidate.counter == "default" {
				sf!("Usage")
			} else {
				sf!("Usage ({})", candidate.counter)
			};
			let scope = sf!(
				"counter={counter_key};tier={};project={project};account={};window={}",
				candidate.tier,
				account.unwrap_or(""),
				candidate.window_id
			);
			UsageWindow {
				id:          sf!(
					"google-antigravity:{counter_key}:{}:{}",
					candidate.tier,
					candidate.window_id
				),
				kind:        UsageWindowKind::Quota,
				dimension:   sf!("quota"),
				label:       Some(label),
				scope:       Some(scope),
				amount:      UsageAmount {
					unit:      UsageUnit::Percent,
					consumed:  Some(q(used)),
					remaining: Some(q(candidate.remaining * 100.0)),
					limit:     Some(q(100.0)),
				},
				status:      Some(if candidate.remaining <= 0.0 {
					UsageStatus::Exhausted
				} else if candidate.remaining <= 0.1 {
					UsageStatus::Warning
				} else {
					UsageStatus::Ok
				}),
				duration:    Some(candidate.duration),
				resets_at:   candidate.resets_at,
				reset_label: None,
				notes:       Box::default(),
				source:      UsageSource::Provider,
				observed_at: now,
			}
		})
		.collect::<Vec<_>>();
	windows.sort_by_key(|window| window.amount.remaining.map_or(u64::MAX, |q| q.units));
	(!windows.is_empty()).then_some((plan, windows))
}

#[cfg(test)]
mod tests {
	use std::{collections::VecDeque, sync::Arc, time::SystemTime};

	use futures::{FutureExt as _, future::BoxFuture};
	use http::{HeaderMap, Method};
	use omp_core::{ExposeSecret as _, SecretString, sf};
	use parking_lot::Mutex;

	use super::{
		antigravity_counter_for_model, fetch_google_antigravity_usage,
		scope_antigravity_windows_for_model,
	};
	use crate::auth::{OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse, OAuthTransportError};
	#[derive(Clone)]
	struct Req {
		method:  Method,
		url:     String,
		headers: HeaderMap,
		body:    Option<String>,
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
				body: body.map(|v| v.expose_secret().to_owned()),
			});
			let response = self.responses.lock().pop_front().expect("response");
			async move { Ok(response) }.boxed()
		}
	}
	#[tokio::test]
	async fn merges_counters_tiers_and_windows_with_lowest_headroom() {
		let mappings = [
			("gpt-oss-120b", Some("openai")),
			("openai/gpt-oss-120b", Some("openai")),
			("tab_flash_lite_preview", Some("google")),
			("tab_jump_flash_lite_preview", Some("google")),
			("unmodelled", None),
		];
		for (model, expected) in mappings {
			let actual = antigravity_counter_for_model(model);
			assert_eq!(actual, expected, "model={model}, actual={actual:?}");
		}

		let http = Http::new([(
			200,
			r#"{"models":{"gemini-a":{"modelProvider":"MODEL_PROVIDER_GOOGLE","quotaInfo":{"remainingFraction":0.8,"resetTime":"2026-08-15T00:00:00Z","tier":"Default","windowId":"WINDOW_DAILY"}},"gemini-b":{"apiProvider":"API_PROVIDER_GOOGLE_GEMINI","quotaInfo":{"remainingFraction":0.2,"tier":"default","windowId":"WINDOW_DAILY"},"weeklyQuotaInfo":{"remainingFraction":0.7,"windowId":"WINDOW_7_DAY","tier":"DEFAULT"}},"claude":{"modelProvider":"MODEL_PROVIDER_ANTHROPIC","quotaInfo":{"resetTime":"2026-08-15T00:00:00Z","tier":"default","windowId":"WINDOW_DAILY"}}}}"#,
		)]);
		let raw = r#"{"accessToken":"secret","projectId":"project-1"}"#;
		let report = fetch_google_antigravity_usage(raw, &http, SystemTime::UNIX_EPOCH)
			.await
			.expect("report");
		assert_eq!(report.windows.len(), 3);
		let claude = scope_antigravity_windows_for_model(&report.windows, Some("claude-opus-4-6"));
		let claude_ids = claude
			.iter()
			.map(|window| window.id.as_str())
			.collect::<Vec<_>>();
		assert_eq!(
			claude_ids,
			["google-antigravity:anthropic:default:daily"],
			"scoped claude windows={claude_ids:?}"
		);
		let mut legacy = report.windows[0].clone();
		legacy.id = sf!("google-antigravity:default:default:daily");
		let legacy = [legacy];
		let fallback = scope_antigravity_windows_for_model(&legacy, Some("claude-opus-4-6"));
		assert_eq!(
			fallback.len(),
			1,
			"legacy fallback windows={:?}",
			fallback
				.iter()
				.map(|window| window.id.as_str())
				.collect::<Vec<_>>()
		);
		let unmodelled = scope_antigravity_windows_for_model(&report.windows, Some("unknown"));
		assert!(
			unmodelled.is_empty(),
			"unmodelled lookup selected={:?}",
			unmodelled
				.iter()
				.map(|window| window.id.as_str())
				.collect::<Vec<_>>()
		);
		assert_eq!(report.windows[0].id.as_str(), "google-antigravity:anthropic:default:daily");
		assert_eq!(report.windows[0].status, Some(crate::answer::UsageStatus::Exhausted));
		assert!(
			report
				.windows
				.iter()
				.any(|w| w.id.as_str() == "google-antigravity:google:default:weekly")
		);
		let requests = http.requests.lock();
		assert_eq!(requests[0].method, Method::POST);
		assert!(
			requests[0]
				.url
				.ends_with("/v1internal:fetchAvailableModels")
		);
		assert_eq!(requests[0].headers["authorization"], "Bearer secret");
		assert_eq!(requests[0].body.as_deref(), Some(r#"{"project":"project-1"}"#));
	}
	#[tokio::test]
	async fn transient_primary_failure_uses_sandbox() {
		let http = Http::new([
			(503, "{}"),
			(
				200,
				r#"{"models":{"gemini":{"modelProvider":"MODEL_PROVIDER_GOOGLE","quotaInfo":{"remainingFraction":1,"windowId":"WINDOW_DAILY"}}}}"#,
			),
		]);
		let raw = r#"{"accessToken":"secret","projectId":"p"}"#;
		fetch_google_antigravity_usage(raw, &http, SystemTime::UNIX_EPOCH)
			.await
			.expect("report");
		assert!(
			http.requests.lock()[1]
				.url
				.starts_with("https://daily-cloudcode-pa.sandbox.googleapis.com")
		);
	}
	#[tokio::test]
	async fn missing_project_or_expired_token_makes_no_request() {
		let http = Http::default();
		assert!(
			fetch_google_antigravity_usage(
				r#"{"accessToken":"secret"}"#,
				&http,
				SystemTime::UNIX_EPOCH
			)
			.await
			.is_err()
		);
		assert!(
			fetch_google_antigravity_usage(
				r#"{"accessToken":"secret","projectId":"p","expiresAt":1}"#,
				&http,
				SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1)
			)
			.await
			.is_err()
		);
		assert!(http.requests.lock().is_empty());
	}
}
