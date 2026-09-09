//! `SuperGrok` OAuth billing and quota retrieval.

use std::{
	collections::HashSet,
	sync::Arc,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures::FutureExt as _;
use http::{
	HeaderMap, HeaderValue, Method,
	header::{ACCEPT, AUTHORIZATION},
};
use omp_core::{ExposeSecret as _, SecretString, Str, base64_url, parse_rfc3339, sf};
use serde::Deserialize;
use serde_json::Value;
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

const PROVIDER: &str = "xai-oauth";
const XAI_OAUTH_USERINFO_URL: &str = "https://auth.x.ai/oauth2/userinfo";
const XAI_CLI_BILLING_BASE_URL: &str = "https://cli-chat-proxy.grok.com";
const XAI_CLI_BILLING_PATH: &str = "/v1/billing";
const XAI_CLI_BILLING_FORMAT: &str = "credits";
/// Milliseconds in one hour.
pub const HOUR_MS: u64 = 60 * 60 * 1000;
/// Milliseconds in one day.
pub const DAY_MS: u64 = 24 * HOUR_MS;
/// Milliseconds in one week.
pub const WEEK_MS: u64 = 7 * DAY_MS;

/// Application-registered xAI OAuth usage fetcher.
#[derive(Clone)]
pub struct XaiOauthUsageFetcher {
	provider: ProviderId,
	http:     Arc<dyn OAuthHttpClient>,
}
impl XaiOauthUsageFetcher {
	/// Constructs an xAI OAuth usage fetcher.
	pub fn new(http: Arc<dyn OAuthHttpClient>) -> Self {
		Self { provider: ProviderId::from(PROVIDER), http }
	}
}
impl ConsoleUsageFetcher for XaiOauthUsageFetcher {
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
			fetch_xai_oauth_usage_until(raw, self.http.as_ref(), now, deadline).await
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
	account_id:   Option<String>,
	email:        Option<String>,
}
struct Credential {
	token:      Zeroizing<String>,
	expires_at: Option<u64>,
	account_id: Option<Str>,
	email:      Option<Str>,
}
fn parse_credential(raw: &str) -> Option<Credential> {
	if !raw.trim_start().starts_with('{') {
		return Some(Credential {
			token:      Zeroizing::new(raw.to_owned()),
			expires_at: None,
			account_id: None,
			email:      None,
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
	Some(Credential {
		token:      Zeroizing::new(token),
		expires_at: envelope.expires_at,
		account_id: envelope
			.account_id
			.filter(|v| !v.trim().is_empty())
			.map(Str::new),
		email:      envelope
			.email
			.filter(|v| !v.trim().is_empty())
			.map(|v| Str::new(v.to_ascii_lowercase())),
	})
}

/// Fetches `SuperGrok` billing usage from an OAuth access token or envelope.
pub async fn fetch_xai_oauth_usage(
	raw: &str,
	http: &dyn OAuthHttpClient,
	now: SystemTime,
) -> Result<ConsoleUsageObservation, UsageFetchError> {
	fetch_xai_oauth_usage_until(raw, http, now, None).await
}
async fn fetch_xai_oauth_usage_until(
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
	let mut account_id = credential
		.account_id
		.or_else(|| jwt_subject(&credential.token));
	let mut email = credential.email;
	if email.is_none()
		&& let Some(response) = execute(http, userinfo_request(&credential.token)?, deadline)
			.await
			.filter(|r| (200..300).contains(&r.status))
	{
		let root: Value = serde_json::from_str(response.body.expose_secret()).unwrap_or(Value::Null);
		email = root
			.get("email")
			.and_then(Value::as_str)
			.map(|v| Str::new(v.to_ascii_lowercase()));
		if account_id.is_none() {
			account_id = root.get("sub").and_then(Value::as_str).map(Str::new);
		}
	}
	let credits_url =
		format!("{XAI_CLI_BILLING_BASE_URL}{XAI_CLI_BILLING_PATH}?format={XAI_CLI_BILLING_FORMAT}");
	let credits = execute(http, billing_request(&credits_url, &credential.token)?, deadline)
		.await
		.ok_or(UsageFetchError::Unavailable)?;
	if !(200..300).contains(&credits.status) {
		return Err(UsageFetchError::Unavailable);
	}
	let credits_root: Value = serde_json::from_str(credits.body.expose_secret())
		.map_err(|_| UsageFetchError::Unavailable)?;
	let config = credits_root.get("config").unwrap_or(&Value::Null);
	let weekly = parse_weekly(config, account_id.as_deref(), now);
	let unified = config.get("isUnifiedBillingUser").and_then(Value::as_bool) == Some(true);
	let need_monthly = weekly.is_none() || unified;
	let monthly_result = if need_monthly {
		let url = format!("{XAI_CLI_BILLING_BASE_URL}{XAI_CLI_BILLING_PATH}");
		match execute(http, billing_request(&url, &credential.token)?, deadline).await {
			Some(response) if (200..300).contains(&response.status) => {
				serde_json::from_str::<Value>(response.body.expose_secret())
					.ok()
					.map(|root| {
						let config = root.get("config").cloned().unwrap_or(Value::Null);
						let no_monthly = config
							.get("monthlyLimit")
							.and_then(|v| v.get("val"))
							.and_then(Value::as_f64)
							== Some(0.0);
						(parse_monthly(&config, account_id.as_deref(), now), no_monthly)
					})
			},
			_ => None,
		}
	} else {
		None
	};
	let inferred = weekly.as_ref().is_some_and(|weekly| weekly.inferred);
	let mut windows = if inferred && unified {
		match monthly_result {
			Some((Some(monthly), _)) => monthly.windows,
			Some((None, true)) => weekly.map_or_else(Vec::new, |v| v.windows),
			_ => return Err(UsageFetchError::Unavailable),
		}
	} else {
		let mut windows = weekly.map_or_else(Vec::new, |v| v.windows);
		if let Some((Some(monthly), _)) = monthly_result {
			windows.extend(monthly.windows);
		}
		windows
	};
	let mut ids = HashSet::new();
	windows.retain(|window| ids.insert(window.id.clone()));
	if windows.is_empty() {
		return Err(UsageFetchError::Unavailable);
	}
	Ok(ConsoleUsageObservation {
		account_meta: UsageAccountMetadata {
			provider_account_id: account_id,
			email,
			..UsageAccountMetadata::default()
		},
		plan: None,
		source_label: Some(sf!("cli-chat-proxy.grok.com/v1/billing")),
		notes: Box::default(),
		reset_credits: None,
		windows,
	})
}

fn jwt_subject(token: &str) -> Option<Str> {
	let payload = token.split('.').nth(1)?;
	let decoded = Zeroizing::new(
		base64_url::decode_raw(payload.trim_end_matches('=').as_bytes())
			.into_vec()
			.ok()?,
	);
	serde_json::from_slice::<Value>(&decoded)
		.ok()?
		.get("sub")?
		.as_str()
		.map(Str::new)
}
fn auth_header(token: &str) -> Result<HeaderValue, UsageFetchError> {
	let mut bytes = Zeroizing::new(Vec::with_capacity(7 + token.len()));
	bytes.extend_from_slice(b"Bearer ");
	bytes.extend_from_slice(token.as_bytes());
	let mut value = HeaderValue::from_bytes(&bytes).map_err(|_| UsageFetchError::Protocol)?;
	value.set_sensitive(true);
	Ok(value)
}
fn userinfo_request(token: &str) -> Result<OAuthHttpRequest, UsageFetchError> {
	let mut headers = HeaderMap::new();
	headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
	headers.insert(AUTHORIZATION, auth_header(token)?);
	OAuthHttpRequest::new(Method::GET, XAI_OAUTH_USERINFO_URL, headers, None)
		.map_err(|_| UsageFetchError::Protocol)
}
fn billing_request(url: &str, token: &str) -> Result<OAuthHttpRequest, UsageFetchError> {
	let mut headers = HeaderMap::new();
	headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
	headers.insert(AUTHORIZATION, auth_header(token)?);
	headers.insert("x-xai-token-auth", HeaderValue::from_static("xai-grok-cli"));
	OAuthHttpRequest::new(Method::GET, url, headers, None).map_err(|_| UsageFetchError::Protocol)
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
fn q(value: f64) -> Option<UsageQuantity> {
	if !value.is_finite() || value < 0.0 {
		return None;
	}
	let units = (value * 1000.0).round();
	(units <= u64::MAX as f64).then(|| UsageQuantity::new(units as u64, 3))
}
fn status_percent(used: f64) -> UsageStatus {
	if used >= 100.0 {
		UsageStatus::Exhausted
	} else if used >= 90.0 {
		UsageStatus::Warning
	} else {
		UsageStatus::Ok
	}
}
fn percent_window(
	id: Str,
	label: Str,
	used: f64,
	duration: Option<Duration>,
	resets_at: Option<SystemTime>,
	scope: Option<Str>,
	now: SystemTime,
) -> UsageWindow {
	let used = used.clamp(0.0, 100.0);
	UsageWindow {
		id,
		kind: UsageWindowKind::Quota,
		dimension: sf!("credits"),
		label: Some(label),
		scope,
		amount: UsageAmount {
			unit:      UsageUnit::Percent,
			consumed:  q(used),
			remaining: q(100.0 - used),
			limit:     q(100.0),
		},
		status: Some(status_percent(used)),
		duration,
		resets_at,
		reset_label: None,
		notes: Box::default(),
		source: UsageSource::Provider,
		observed_at: now,
	}
}
fn unknown_window(
	id: &'static str,
	label: &'static str,
	used: f64,
	limit: f64,
	now: SystemTime,
) -> UsageWindow {
	let ratio = used / limit;
	UsageWindow {
		id:          sf!(id),
		kind:        UsageWindowKind::Billing,
		dimension:   sf!("on-demand"),
		label:       Some(sf!(label)),
		scope:       Some(sf!("shared")),
		amount:      UsageAmount {
			unit:      UsageUnit::Unknown,
			consumed:  q(used),
			remaining: q((limit - used).max(0.0)),
			limit:     q(limit),
		},
		status:      Some(if ratio >= 1.0 {
			UsageStatus::Exhausted
		} else if ratio >= 0.9 {
			UsageStatus::Warning
		} else {
			UsageStatus::Ok
		}),
		duration:    None,
		resets_at:   None,
		reset_label: None,
		notes:       Box::default(),
		source:      UsageSource::Provider,
		observed_at: now,
	}
}
fn parse_time(value: Option<&Value>) -> Option<SystemTime> {
	value?.as_str().and_then(parse_rfc3339)
}
struct Parsed {
	windows:  Vec<UsageWindow>,
	inferred: bool,
}
fn on_demand(config: &Value, now: SystemTime) -> Option<UsageWindow> {
	let cap = config.get("onDemandCap")?.get("val")?.as_f64()?;
	let used = config.get("onDemandUsed")?.get("val")?.as_f64()?;
	(cap > 0.0).then(|| unknown_window("xai-oauth:on-demand", "On-demand", used, cap, now))
}
fn parse_weekly(config: &Value, account: Option<&str>, now: SystemTime) -> Option<Parsed> {
	let period = config.get("currentPeriod")?;
	if !period
		.get("type")?
		.as_str()?
		.to_ascii_uppercase()
		.contains("WEEK")
	{
		return None;
	}
	let start = parse_time(period.get("start"))?;
	let end = parse_time(period.get("end"))?;
	if end <= start {
		return None;
	}
	let (percent, inferred) = match config.get("creditUsagePercent").and_then(Value::as_f64) {
		Some(value) => (value, false),
		None if end > now => (0.0, true),
		None => return None,
	};
	let scope = Some(sf!("shared{}", account.map_or_else(String::new, |v| format!(":{v}"))));
	let mut windows = vec![percent_window(
		sf!("xai-oauth:credits:1w"),
		sf!("SuperGrok Weekly Credits"),
		percent,
		Some(Duration::from_days(7)),
		Some(end),
		scope.clone(),
		now,
	)];
	if let Some(products) = config.get("productUsage").and_then(Value::as_array) {
		for product in products {
			let Some(name) = product.get("product").and_then(Value::as_str) else {
				continue;
			};
			let Some(used) = product.get("usagePercent").and_then(Value::as_f64) else {
				continue;
			};
			let slug = name
				.trim()
				.to_ascii_lowercase()
				.chars()
				.map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
				.collect::<String>()
				.split('-')
				.filter(|v| !v.is_empty())
				.collect::<Vec<_>>()
				.join("-");
			if slug.is_empty() {
				continue;
			}
			let label = match name {
				"GrokBuild" => sf!("Grok Build (Weekly)"),
				"Api" => sf!("API (Weekly)"),
				_ => sf!("{name} (Weekly)"),
			};
			windows.push(percent_window(
				sf!("xai-oauth:product:{slug}:1w"),
				label,
				used,
				Some(Duration::from_days(7)),
				Some(end),
				scope.clone(),
				now,
			));
		}
	}
	if let Some(window) = on_demand(config, now) {
		windows.push(window);
	}
	Some(Parsed { windows, inferred })
}
fn parse_monthly(config: &Value, account: Option<&str>, now: SystemTime) -> Option<Parsed> {
	let start = parse_time(config.get("billingPeriodStart"))?;
	let end = parse_time(config.get("billingPeriodEnd"))?;
	let duration = end.duration_since(start).ok()?;
	let limit = config.get("monthlyLimit")?.get("val")?.as_f64()?;
	if limit <= 0.0 {
		return None;
	}
	let used = config.get("used")?.get("val")?.as_f64()?;
	let scope = Some(sf!("shared{}", account.map_or_else(String::new, |v| format!(":{v}"))));
	let mut windows = vec![UsageWindow {
		id: sf!("xai-oauth:included:1mo"),
		kind: UsageWindowKind::Quota,
		dimension: sf!("included"),
		label: Some(sf!("SuperGrok Monthly Included")),
		scope,
		amount: UsageAmount {
			unit:      UsageUnit::Unknown,
			consumed:  q(used),
			remaining: q((limit - used).max(0.0)),
			limit:     q(limit),
		},
		status: Some(if used >= limit {
			UsageStatus::Exhausted
		} else if used / limit >= 0.9 {
			UsageStatus::Warning
		} else {
			UsageStatus::Ok
		}),
		duration: Some(duration),
		resets_at: Some(end),
		reset_label: None,
		notes: Box::default(),
		source: UsageSource::Provider,
		observed_at: now,
	}];
	if let Some(window) = on_demand(config, now) {
		windows.push(window);
	}
	Some(Parsed { windows, inferred: false })
}

#[cfg(test)]
mod tests {
	use std::{
		collections::VecDeque,
		sync::Arc,
		time::{Duration, SystemTime},
	};

	use futures::{FutureExt as _, future::BoxFuture};
	use http::HeaderMap;
	use omp_core::SecretString;
	use parking_lot::Mutex;

	use super::fetch_xai_oauth_usage;
	use crate::auth::{OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse, OAuthTransportError};
	#[derive(Clone)]
	struct Req {
		url:     String,
		headers: HeaderMap,
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
			let (_, url, headers, _) = request.into_parts();
			self
				.requests
				.lock()
				.push(Req { url: url.to_string(), headers });
			let response = self.responses.lock().pop_front().expect("response");
			async move { Ok(response) }.boxed()
		}
	}
	#[tokio::test]
	async fn stored_email_suppresses_userinfo_and_non_unified_uses_one_probe() {
		let http = Http::new([(
			200,
			r#"{"config":{"creditUsagePercent":18,"currentPeriod":{"start":"2026-08-01T00:00:00Z","end":"2026-08-08T00:00:00Z","type":"USAGE_PERIOD_TYPE_WEEKLY"},"productUsage":[{"product":"GrokBuild","usagePercent":16}]}}"#,
		)]);
		let raw = r#"{"accessToken":"secret","email":"me@example.com"}"#;
		let report = fetch_xai_oauth_usage(
			raw,
			&http,
			SystemTime::UNIX_EPOCH + Duration::from_secs(1_786_000_000),
		)
		.await
		.expect("report");
		assert_eq!(report.windows[1].id.as_str(), "xai-oauth:product:grokbuild:1w");
		let requests = http.requests.lock();
		assert_eq!(requests.len(), 1);
		assert!(requests[0].url.ends_with("?format=credits"));
		assert_eq!(requests[0].headers["authorization"], "Bearer secret");
		assert_eq!(requests[0].headers["x-xai-token-auth"], "xai-grok-cli");
	}
	#[tokio::test]
	async fn unified_account_uses_monthly_probe() {
		let http = Http::new([
			(
				200,
				r#"{"config":{"isUnifiedBillingUser":true,"creditUsagePercent":null,"currentPeriod":{"start":"2026-08-01T00:00:00Z","end":"2099-08-08T00:00:00Z","type":"WEEKLY"}}}"#,
			),
			(
				200,
				r#"{"config":{"billingPeriodStart":"2026-08-01T00:00:00Z","billingPeriodEnd":"2026-09-01T00:00:00Z","monthlyLimit":{"val":15000},"used":{"val":3500}}}"#,
			),
		]);
		let raw = r#"{"accessToken":"secret","email":"me@example.com"}"#;
		let report = fetch_xai_oauth_usage(raw, &http, SystemTime::UNIX_EPOCH)
			.await
			.expect("report");
		assert_eq!(report.windows[0].id.as_str(), "xai-oauth:included:1mo");
		assert_eq!(http.requests.lock().len(), 2);
	}
	#[tokio::test]
	async fn expired_token_and_forbidden_are_unavailable() {
		let empty = Http::default();
		let raw = r#"{"accessToken":"secret","expiresAt":1}"#;
		assert_eq!(
			fetch_xai_oauth_usage(raw, &empty, SystemTime::UNIX_EPOCH + Duration::from_secs(1))
				.await
				.expect_err("expired"),
			crate::operation::usage::UsageFetchError::Unavailable
		);
		assert!(empty.requests.lock().is_empty());
		let http = Http::new([(403, "{}")]);
		let raw = r#"{"accessToken":"secret","email":"stored@example.com"}"#;
		assert_eq!(
			fetch_xai_oauth_usage(raw, &http, SystemTime::UNIX_EPOCH)
				.await
				.expect_err("unavailable"),
			crate::operation::usage::UsageFetchError::Unavailable
		);
	}
}
