//! GitHub Copilot quota and premium-request billing retrieval.

use std::{
	sync::Arc,
	time::{Instant, SystemTime},
};

use futures::FutureExt as _;
use http::{
	HeaderMap, HeaderValue, Method,
	header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT},
};
use omp_core::{ExposeSecret as _, SecretString, Str, parse_rfc3339, sf};
use serde::Deserialize;
use serde_json::Value;
use tokio::time;
use url::Url;
use zeroize::Zeroizing;

use crate::{
	answer::{
		UsageAccountMetadata, UsageAmount, UsageQuantity, UsageStatus, UsageUnit, UsageWindow,
		UsageWindowKind,
	},
	auth::{
		OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse as AuthOAuthHttpResponse,
		github_copilot::{COPILOT_USER_AGENT, parse_copilot_api_key},
	},
	catalog::ProviderId,
	operation::usage::{
		ConsoleUsageFetcher, ConsoleUsageObservation, UsageCredentialRequirement, UsageFetchError,
	},
	receipt::UsageSource,
};

const PROVIDER: &str = "github-copilot";
const PUBLIC_GITHUB_API: &str = "https://api.github.com";
const REST_API_VERSION: &str = "2022-11-28";

/// Application-registered GitHub Copilot console usage fetcher.
#[derive(Clone)]
pub struct GithubCopilotUsageFetcher {
	provider: ProviderId,
	http:     Arc<dyn OAuthHttpClient>,
}

impl GithubCopilotUsageFetcher {
	/// Constructs a fetcher over the application's bounded OAuth HTTP client.
	pub fn new(http: Arc<dyn OAuthHttpClient>) -> Self {
		Self { provider: ProviderId::from(PROVIDER), http }
	}
}

impl ConsoleUsageFetcher for GithubCopilotUsageFetcher {
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
			fetch_github_copilot_usage_until(raw, self.http.as_ref(), now, deadline).await
		}
		.boxed()
	}
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
	#[serde(default, rename = "type")]
	type_:          String,
	#[serde(default)]
	access_token:   String,
	#[serde(default)]
	access:         String,
	#[serde(default)]
	refresh_token:  String,
	#[serde(default)]
	refresh:        String,
	#[serde(default)]
	api_key:        String,
	#[serde(default)]
	token:          String,
	enterprise_url: Option<String>,
	account_id:     Option<String>,
	email:          Option<String>,
	metadata:       Option<Value>,
}

struct Credential {
	token:          Zeroizing<String>,
	is_api_key:     bool,
	enterprise_url: Option<Str>,
	account_id:     Option<Str>,
	email:          Option<Str>,
	username:       Option<Str>,
}

fn parse_credential(raw: &str) -> Option<Credential> {
	if !raw.trim_start().starts_with('{') {
		let parsed = parse_copilot_api_key(raw);
		return Some(Credential {
			token:          Zeroizing::new(parsed.access_token.expose_secret().to_owned()),
			is_api_key:     false,
			enterprise_url: parsed.enterprise_url,
			account_id:     None,
			email:          None,
			username:       None,
		});
	}
	let envelope: Envelope = serde_json::from_str(raw).ok()?;
	let is_api_key = envelope.type_.eq_ignore_ascii_case("api_key")
		|| !envelope.api_key.is_empty()
		|| (!envelope.token.is_empty()
			&& envelope.access_token.is_empty()
			&& envelope.access.is_empty()
			&& envelope.refresh_token.is_empty()
			&& envelope.refresh.is_empty());
	let nested_api_key =
		(!envelope.api_key.is_empty()).then(|| parse_copilot_api_key(&envelope.api_key));
	let token = if let Some(nested) = nested_api_key.as_ref() {
		nested.access_token.expose_secret()
	} else if !envelope.refresh_token.is_empty() {
		&envelope.refresh_token
	} else if !envelope.refresh.is_empty() {
		&envelope.refresh
	} else if !envelope.access_token.is_empty() {
		&envelope.access_token
	} else if !envelope.access.is_empty() {
		&envelope.access
	} else {
		&envelope.token
	};
	if token.is_empty() {
		return None;
	}
	let token = Zeroizing::new(token.to_owned());
	let metadata_username = envelope
		.metadata
		.as_ref()
		.and_then(Value::as_object)
		.and_then(|value| value.get("username").or_else(|| value.get("user")))
		.and_then(Value::as_str);
	let username = envelope
		.account_id
		.as_deref()
		.or(metadata_username)
		.filter(|value| !value.trim().is_empty())
		.map(|value| Str::new(value.trim()));
	let enterprise_url = envelope
		.enterprise_url
		.as_deref()
		.filter(|value| !value.trim().is_empty())
		.map(|value| Str::new(value.trim()))
		.or_else(|| nested_api_key.and_then(|nested| nested.enterprise_url));
	Some(Credential {
		token,
		is_api_key,
		enterprise_url,
		account_id: envelope
			.account_id
			.as_deref()
			.filter(|value| !value.trim().is_empty())
			.map(|value| Str::new(value.trim())),
		email: envelope
			.email
			.as_deref()
			.filter(|value| !value.trim().is_empty())
			.map(|value| Str::new(value.trim())),
		username,
	})
}

fn github_api_base(enterprise_url: Option<&str>) -> Str {
	let Some(value) = enterprise_url
		.map(str::trim)
		.filter(|value| !value.is_empty())
	else {
		return sf!(PUBLIC_GITHUB_API);
	};
	if value.starts_with("http://") || value.starts_with("https://") {
		return Str::new(value.trim_end_matches('/'));
	}
	if value.starts_with("api.") {
		sf!("https://{value}")
	} else {
		sf!("https://api.{value}")
	}
}

/// Fetches GitHub Copilot quota usage from a bare token or serialized
/// credential envelope.
pub async fn fetch_github_copilot_usage(
	raw: &str,
	http: &dyn OAuthHttpClient,
	now: SystemTime,
) -> Result<ConsoleUsageObservation, UsageFetchError> {
	fetch_github_copilot_usage_until(raw, http, now, None).await
}

async fn fetch_github_copilot_usage_until(
	raw: &str,
	http: &dyn OAuthHttpClient,
	now: SystemTime,
	deadline: Option<Instant>,
) -> Result<ConsoleUsageObservation, UsageFetchError> {
	let credential = parse_credential(raw).ok_or(UsageFetchError::Unavailable)?;
	let base = github_api_base(credential.enterprise_url.as_deref());
	let mut account_id = credential.account_id.clone();
	if credential.is_api_key {
		let username = match credential.username.clone() {
			Some(username) => Some(username),
			None => resolve_username(http, &base, &credential.token, deadline).await,
		};
		if account_id.is_none() {
			account_id = username.clone();
		}
		if let Some(username) = username {
			let mut url = Url::parse(&base).map_err(|_| UsageFetchError::Protocol)?;
			url.path_segments_mut()
				.map_err(|()| UsageFetchError::Protocol)?
				.extend(["users", username.as_str()])
				.extend(["settings", "billing", "premium_request", "usage"]);
			let url = String::from(url);
			if let Some(response) =
				execute(http, rest_request(&url, &credential.token)?, deadline).await
				&& (200..300).contains(&response.status)
				&& let Some(windows) = parse_billing(response.body.expose_secret(), now)
			{
				return Ok(observation(account_id, credential.email, None, "github-billing", windows));
			}
		}
	}
	let response = execute(
		http,
		internal_request(&format!("{base}/copilot_internal/user"), &credential.token)?,
		deadline,
	)
	.await
	.ok_or(UsageFetchError::Unavailable)?;
	if response.status == 401 || response.status == 403 {
		return Err(UsageFetchError::AuthRejected);
	}
	if !(200..300).contains(&response.status) {
		return Err(UsageFetchError::Unavailable);
	}
	let (plan, windows) =
		parse_snapshots(response.body.expose_secret(), now).ok_or(UsageFetchError::Unavailable)?;
	if account_id.is_none() && !credential.is_api_key {
		account_id = resolve_username(http, &base, &credential.token, deadline).await;
	}
	Ok(observation(account_id, credential.email, plan, "copilot-internal", windows))
}

fn observation(
	account_id: Option<Str>,
	email: Option<Str>,
	plan: Option<Str>,
	source: &'static str,
	windows: Vec<UsageWindow>,
) -> ConsoleUsageObservation {
	ConsoleUsageObservation {
		account_meta: UsageAccountMetadata {
			provider_account_id: account_id,
			email,
			..UsageAccountMetadata::default()
		},
		plan,
		source_label: Some(sf!(source)),
		notes: Box::default(),
		reset_credits: None,
		windows,
	}
}

async fn resolve_username(
	http: &dyn OAuthHttpClient,
	base: &str,
	token: &str,
	deadline: Option<Instant>,
) -> Option<Str> {
	let response =
		execute(http, rest_request(&format!("{base}/user"), token).ok()?, deadline).await?;
	if !(200..300).contains(&response.status) {
		return None;
	}
	serde_json::from_str::<Value>(response.body.expose_secret())
		.ok()?
		.get("login")?
		.as_str()
		.filter(|value| !value.is_empty())
		.map(Str::new)
}

fn authorization(scheme: &[u8], token: &str) -> Result<HeaderValue, UsageFetchError> {
	let mut bytes = Zeroizing::new(Vec::with_capacity(scheme.len() + token.len()));
	bytes.extend_from_slice(scheme);
	bytes.extend_from_slice(token.as_bytes());
	let mut value = HeaderValue::from_bytes(&bytes).map_err(|_| UsageFetchError::Protocol)?;
	value.set_sensitive(true);
	Ok(value)
}

fn internal_request(url: &str, token: &str) -> Result<OAuthHttpRequest, UsageFetchError> {
	let mut headers = HeaderMap::new();
	headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
	headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
	headers.insert(USER_AGENT, HeaderValue::from_static(COPILOT_USER_AGENT));
	headers.insert(AUTHORIZATION, authorization(b"token ", token)?);
	OAuthHttpRequest::new(Method::GET, url, headers, None).map_err(|_| UsageFetchError::Protocol)
}

fn rest_request(url: &str, token: &str) -> Result<OAuthHttpRequest, UsageFetchError> {
	let mut headers = HeaderMap::new();
	headers.insert(ACCEPT, HeaderValue::from_static("application/vnd.github+json"));
	headers.insert("x-github-api-version", HeaderValue::from_static(REST_API_VERSION));
	headers.insert(AUTHORIZATION, authorization(b"Bearer ", token)?);
	OAuthHttpRequest::new(Method::GET, url, headers, None).map_err(|_| UsageFetchError::Protocol)
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

fn quantity(value: f64) -> Option<UsageQuantity> {
	if !value.is_finite() || value < 0.0 {
		return None;
	}
	if value.fract() == 0.0 && value <= u64::MAX as f64 {
		return Some(UsageQuantity::new(value as u64, 0));
	}
	let rounded = (value * 1000.0).round();
	(rounded <= u64::MAX as f64).then(|| UsageQuantity::new(rounded as u64, 3))
}

fn request_window(
	id: Str,
	label: Str,
	used: Option<f64>,
	remaining: Option<f64>,
	limit: Option<f64>,
	resets_at: Option<SystemTime>,
	now: SystemTime,
	notes: Box<[Str]>,
) -> UsageWindow {
	let status = match (remaining, limit) {
		(Some(remaining), Some(limit)) if limit > 0.0 && remaining <= 0.0 => UsageStatus::Exhausted,
		(Some(remaining), Some(limit)) if limit > 0.0 && remaining / limit <= 0.1 => {
			UsageStatus::Warning
		},
		_ => UsageStatus::Ok,
	};
	UsageWindow {
		id,
		kind: UsageWindowKind::Quota,
		dimension: sf!("requests"),
		label: Some(label),
		scope: Some(sf!("shared")),
		amount: UsageAmount {
			unit:      UsageUnit::Requests,
			consumed:  used.and_then(quantity),
			remaining: remaining.and_then(quantity),
			limit:     limit.and_then(quantity),
		},
		status: Some(status),
		duration: None,
		resets_at,
		reset_label: None,
		notes,
		source: UsageSource::Provider,
		observed_at: now,
	}
}

fn parse_snapshots(body: &str, now: SystemTime) -> Option<(Option<Str>, Vec<UsageWindow>)> {
	let root: Value = serde_json::from_str(body).ok()?;
	let snapshots = root.get("quota_snapshots")?.as_object()?;
	let resets_at = root
		.get("quota_reset_date")
		.and_then(Value::as_str)
		.and_then(parse_rfc3339);
	let mut windows = Vec::with_capacity(3);
	for (key, id, label) in [
		("premium_interactions", "copilot:premium", "Premium Requests"),
		("chat", "copilot:chat", "Chat Requests"),
		("completions", "copilot:completions", "Completions"),
	] {
		let Some(detail) = snapshots.get(key).and_then(Value::as_object) else {
			continue;
		};
		let unlimited = detail.get("unlimited").and_then(Value::as_bool)?;
		let _ = detail.get("percent_remaining").and_then(Value::as_f64)?;
		if unlimited && key != "premium_interactions" {
			continue;
		}
		let entitlement = detail.get("entitlement").and_then(Value::as_f64)?;
		let remaining = detail.get("remaining").and_then(Value::as_f64)?;
		let overage = detail
			.get("overage_count")
			.and_then(Value::as_f64)
			.unwrap_or(0.0);
		let mut notes = Vec::new();
		if unlimited {
			notes.push(sf!("Unlimited"));
		}
		if overage > 0.0 {
			notes.push(sf!("Overage requests: {}", overage as u64));
		}
		let (used, remaining, limit) = if unlimited {
			(None, None, None)
		} else {
			let used = (entitlement - remaining).max(0.0);
			(Some(used), Some((entitlement - used).max(0.0)), Some(entitlement))
		};
		windows.push(request_window(
			sf!(id),
			sf!(label),
			used,
			remaining,
			limit,
			resets_at,
			now,
			notes.into_boxed_slice(),
		));
	}
	(!windows.is_empty()).then(|| {
		(
			root
				.get("copilot_plan")
				.and_then(Value::as_str)
				.map(Str::new),
			windows,
		)
	})
}

fn parse_billing(body: &str, now: SystemTime) -> Option<Vec<UsageWindow>> {
	let root: Value = serde_json::from_str(body).ok()?;
	let items = root.get("usageItems")?.as_array()?;
	let period = root.get("timePeriod").and_then(Value::as_object);
	let label = match (
		period.and_then(|p| p.get("year")).and_then(Value::as_u64),
		period.and_then(|p| p.get("month")).and_then(Value::as_u64),
	) {
		(Some(year), Some(month)) => sf!("{year:04}-{month:02}"),
		(Some(year), None) => Str::new(year.to_string()),
		_ => sf!("Billing period"),
	};
	let premium: Vec<&Value> = items
		.iter()
		.filter(|item| {
			item
				.get("sku")
				.and_then(Value::as_str)
				.is_some_and(|sku| sku == "Copilot Premium Request" || sku.contains("Premium"))
		})
		.collect();
	if premium.is_empty() {
		return None;
	}
	let used: f64 = premium
		.iter()
		.filter_map(|item| item.get("grossQuantity").and_then(Value::as_f64))
		.sum();
	let total_limit: f64 = premium
		.iter()
		.filter_map(|item| item.get("limit").and_then(Value::as_f64))
		.sum();
	let limit = (total_limit > 0.0).then_some(total_limit);
	let mut windows = Vec::with_capacity(1 + premium.len());
	let mut premium_window = request_window(
		sf!("copilot:premium"),
		sf!("Premium Requests"),
		Some(used),
		limit.map(|value| (value - used).max(0.0)),
		limit,
		None,
		now,
		Box::new([label.clone()]),
	);
	premium_window.kind = UsageWindowKind::Billing;
	windows.push(premium_window);
	for item in premium {
		let Some(model) = item.get("model").and_then(Value::as_str).filter(|_| {
			item
				.get("grossQuantity")
				.and_then(Value::as_f64)
				.is_some_and(|value| value > 0.0)
		}) else {
			continue;
		};
		let used = item.get("grossQuantity").and_then(Value::as_f64);
		let limit = item.get("limit").and_then(Value::as_f64);
		let mut model_window = request_window(
			sf!("copilot:model:{model}"),
			sf!("Model {model}"),
			used,
			limit.zip(used).map(|(limit, used)| (limit - used).max(0.0)),
			limit,
			None,
			now,
			Box::new([label.clone()]),
		);
		model_window.kind = UsageWindowKind::Billing;
		windows.push(model_window);
	}
	Some(windows)
}

#[cfg(test)]
mod tests {
	use std::{collections::VecDeque, sync::Arc, time::SystemTime};

	use futures::{FutureExt as _, future::BoxFuture};
	use http::HeaderMap;
	use omp_core::SecretString;
	use parking_lot::Mutex;

	use super::{fetch_github_copilot_usage, github_api_base};
	use crate::auth::{OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse, OAuthTransportError};
	#[derive(Clone)]
	struct Recorded {
		url:     String,
		headers: HeaderMap,
	}
	#[derive(Clone, Default)]
	struct Scripted {
		responses: Arc<Mutex<VecDeque<OAuthHttpResponse>>>,
		requests:  Arc<Mutex<Vec<Recorded>>>,
	}
	impl Scripted {
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
	impl OAuthHttpClient for Scripted {
		fn execute(
			&self,
			request: OAuthHttpRequest,
		) -> BoxFuture<'_, Result<OAuthHttpResponse, OAuthTransportError>> {
			let (_, url, headers, _) = request.into_parts();
			self
				.requests
				.lock()
				.push(Recorded { url: url.to_string(), headers });
			let response = self.responses.lock().pop_front().expect("response");
			async move { Ok(response) }.boxed()
		}
	}
	#[test]
	fn enterprise_hosts_are_normalized() {
		assert_eq!(github_api_base(Some("corp.ghe.com")).as_str(), "https://api.corp.ghe.com");
		assert_eq!(github_api_base(Some("https://api.corp.test/")).as_str(), "https://api.corp.test");
	}
	#[tokio::test]
	async fn internal_probe_uses_token_auth_and_projects_snapshots() {
		let http = Scripted::new([
			(
				200,
				r#"{"copilot_plan":"individual","quota_reset_date":"2026-09-01T00:00:00Z","quota_snapshots":{"premium_interactions":{"entitlement":50,"remaining":42,"percent_remaining":84,"unlimited":false},"chat":{"entitlement":0,"remaining":0,"percent_remaining":100,"unlimited":true},"completions":{"entitlement":0,"remaining":0,"percent_remaining":100,"unlimited":true}}}"#,
			),
			(200, r#"{"login":"octocat"}"#),
		]);
		let report = fetch_github_copilot_usage("ghu_secret", &http, SystemTime::UNIX_EPOCH)
			.await
			.expect("report");
		assert_eq!(report.plan.as_deref(), Some("individual"));
		assert_eq!(report.windows.len(), 1);
		assert_eq!(report.windows[0].amount.consumed, Some(crate::answer::UsageQuantity::new(8, 0)));
		let requests = http.requests.lock();
		assert_eq!(requests[0].url, "https://api.github.com/copilot_internal/user");
		assert_eq!(requests[0].headers["authorization"], "token ghu_secret");
		assert_eq!(requests[0].headers["user-agent"], "opencode/1.3.15");
	}
	#[tokio::test]
	async fn api_key_resolves_username_and_returns_billing_models() {
		let http = Scripted::new([
			(200, r#"{"login":"octo cat"}"#),
			(
				200,
				r#"{"timePeriod":{"year":2026,"month":8},"usageItems":[{"sku":"Copilot Premium Request","model":"gpt-5.4","grossQuantity":15,"limit":50}]}"#,
			),
		]);
		let raw = r#"{"type":"api_key","apiKey":"secret"}"#;
		let report = fetch_github_copilot_usage(raw, &http, SystemTime::UNIX_EPOCH)
			.await
			.expect("report");
		assert_eq!(report.windows.len(), 2);
		let requests = http.requests.lock();
		assert!(requests[1].url.contains("octo%20cat"));
		assert_eq!(requests[0].headers["authorization"], "Bearer secret");
		assert_eq!(requests[0].headers["x-github-api-version"], "2022-11-28");
	}
	#[tokio::test]
	async fn billing_failure_falls_back_and_auth_rejection_is_typed() {
		let http = Scripted::new([(403, "{}"), (401, "{}")]);
		let raw = r#"{"type":"api_key","apiKey":"secret","accountId":"octocat"}"#;
		let error = fetch_github_copilot_usage(raw, &http, SystemTime::UNIX_EPOCH)
			.await
			.expect_err("auth rejection");
		assert_eq!(error, crate::operation::usage::UsageFetchError::AuthRejected);
		assert_eq!(http.requests.lock().len(), 2);
	}
}
