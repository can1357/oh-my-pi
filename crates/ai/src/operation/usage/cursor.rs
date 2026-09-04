//! Cursor request and personal-spend usage retrieval.

use std::{
	sync::Arc,
	time::{Duration, Instant, SystemTime},
};

use futures::FutureExt as _;
use http::{
	HeaderMap, HeaderValue, Method,
	header::{ACCEPT, AUTHORIZATION, COOKIE},
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

const PROVIDER: &str = "cursor";
const DEFAULT_CURSOR_BASE_URL: &str = "https://api2.cursor.sh";
const CURSOR_WEB_BASE_URL: &str = "https://cursor.com";

/// Application-registered Cursor usage fetcher.
#[derive(Clone)]
pub struct CursorUsageFetcher {
	provider: ProviderId,
	http:     Arc<dyn OAuthHttpClient>,
}
impl CursorUsageFetcher {
	/// Constructs a Cursor usage fetcher.
	pub fn new(http: Arc<dyn OAuthHttpClient>) -> Self {
		Self { provider: ProviderId::from(PROVIDER), http }
	}
}
impl ConsoleUsageFetcher for CursorUsageFetcher {
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
			fetch_cursor_usage_until(raw, self.http.as_ref(), now, deadline).await
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
	api_key:      String,
	#[serde(default)]
	token:        String,
	api_endpoint: Option<String>,
	base_url:     Option<String>,
	email:        Option<String>,
	account_id:   Option<String>,
	project_id:   Option<String>,
}
struct Credential {
	token:      Zeroizing<String>,
	is_oauth:   bool,
	base_url:   Str,
	email:      Option<Str>,
	account_id: Option<Str>,
	project_id: Option<Str>,
}
fn parse_credential(raw: &str) -> Option<Credential> {
	if !raw.trim_start().starts_with('{') {
		return Some(Credential {
			token:      Zeroizing::new(raw.to_owned()),
			is_oauth:   true,
			base_url:   sf!(DEFAULT_CURSOR_BASE_URL),
			email:      None,
			account_id: None,
			project_id: None,
		});
	}
	let envelope: Envelope = serde_json::from_str(raw).ok()?;
	let is_oauth = !envelope.type_.eq_ignore_ascii_case("api_key") && envelope.api_key.is_empty();
	let token = if is_oauth {
		if envelope.access_token.is_empty() {
			envelope.token
		} else {
			envelope.access_token
		}
	} else {
		envelope.api_key
	};
	if token.is_empty() {
		return None;
	}
	let base = envelope
		.base_url
		.or(envelope.api_endpoint)
		.unwrap_or_else(|| DEFAULT_CURSOR_BASE_URL.to_owned());
	Some(Credential {
		token: Zeroizing::new(token),
		is_oauth,
		base_url: Str::new(base.trim_end_matches('/')),
		email: envelope
			.email
			.filter(|v| !v.trim().is_empty())
			.map(Str::new),
		account_id: envelope
			.account_id
			.filter(|v| !v.trim().is_empty())
			.map(Str::new),
		project_id: envelope
			.project_id
			.filter(|v| !v.trim().is_empty())
			.map(Str::new),
	})
}

/// Fetches Cursor usage from a bare access token or credential envelope.
pub async fn fetch_cursor_usage(
	raw: &str,
	http: &dyn OAuthHttpClient,
	now: SystemTime,
) -> Result<ConsoleUsageObservation, UsageFetchError> {
	fetch_cursor_usage_until(raw, http, now, None).await
}
async fn fetch_cursor_usage_until(
	raw: &str,
	http: &dyn OAuthHttpClient,
	now: SystemTime,
	deadline: Option<Instant>,
) -> Result<ConsoleUsageObservation, UsageFetchError> {
	let credential = parse_credential(raw).ok_or(UsageFetchError::Unavailable)?;
	let legacy_request =
		bearer_request(&format!("{}/auth/usage", credential.base_url), &credential.token)?;
	let user_id = credential
		.is_oauth
		.then(|| extract_cursor_access_token_user_id(&credential.token))
		.flatten();
	let personal = credential.base_url.as_str() == DEFAULT_CURSOR_BASE_URL && user_id.is_some();
	let cookie = user_id
		.as_deref()
		.map(|user_id| cursor_cookie(user_id, &credential.token));
	let summary_request = personal
		.then(|| {
			cookie_request(&format!("{CURSOR_WEB_BASE_URL}/api/usage-summary"), cookie.as_deref()?)
		})
		.flatten();
	let profile_request = personal
		.then(|| cookie_request(&format!("{CURSOR_WEB_BASE_URL}/api/auth/me"), cookie.as_deref()?))
		.flatten();
	let (legacy_response, summary_response, profile_response) = futures::join!(
		execute(http, Some(legacy_request), deadline),
		execute(http, summary_request, deadline),
		execute(http, profile_request, deadline)
	);
	let mut windows = Vec::new();
	if let Some(response) = legacy_response.filter(|response| (200..300).contains(&response.status))
		&& let Some(mut parsed) = parse_cursor_usage(response.body.expose_secret(), now)
	{
		windows.append(&mut parsed);
	}
	if let Some(response) = summary_response.filter(|response| (200..300).contains(&response.status))
		&& let Some(mut parsed) = parse_cursor_individual_usage(response.body.expose_secret(), now)
	{
		windows.append(&mut parsed);
	}
	if windows.is_empty() {
		return Err(UsageFetchError::Unavailable);
	}
	let profile_email = profile_response
		.filter(|response| (200..300).contains(&response.status))
		.and_then(|response| parse_profile_email(response.body.expose_secret(), user_id.as_deref()));
	Ok(ConsoleUsageObservation {
		account_meta: UsageAccountMetadata {
			provider_account_id: credential.account_id.or(user_id),
			email: profile_email.or(credential.email),
			project_id: credential.project_id,
			..UsageAccountMetadata::default()
		},
		plan: None,
		source_label: Some(sf!("cursor-usage")),
		notes: Box::default(),
		reset_credits: None,
		windows,
	})
}

fn extract_cursor_access_token_user_id(token: &str) -> Option<Str> {
	let payload = token.split('.').nth(1)?;
	let decoded = Zeroizing::new(
		base64_url::decode_raw(payload.trim_end_matches('=').as_bytes())
			.into_vec()
			.ok()?,
	);
	let root: Value = serde_json::from_slice(&decoded).ok()?;
	let sub = root.get("sub")?.as_str()?;
	sub.rsplit('|')
		.next()
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(Str::new)
}
fn cursor_cookie(user_id: &str, token: &str) -> Zeroizing<String> {
	let raw = Zeroizing::new(format!("{user_id}::{token}"));
	Zeroizing::new(format!(
		"WorkosCursorSessionToken={}",
		url::form_urlencoded::byte_serialize(raw.as_bytes()).collect::<String>()
	))
}
fn secret_header(prefix: &[u8], value: &str) -> Result<HeaderValue, UsageFetchError> {
	let mut bytes = Zeroizing::new(Vec::with_capacity(prefix.len() + value.len()));
	bytes.extend_from_slice(prefix);
	bytes.extend_from_slice(value.as_bytes());
	let mut header = HeaderValue::from_bytes(&bytes).map_err(|_| UsageFetchError::Protocol)?;
	header.set_sensitive(true);
	Ok(header)
}
fn bearer_request(url: &str, token: &str) -> Result<OAuthHttpRequest, UsageFetchError> {
	let mut headers = HeaderMap::new();
	headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
	headers.insert(AUTHORIZATION, secret_header(b"Bearer ", token)?);
	OAuthHttpRequest::new(Method::GET, url, headers, None).map_err(|_| UsageFetchError::Protocol)
}
fn cookie_request(url: &str, cookie: &str) -> Option<OAuthHttpRequest> {
	let mut headers = HeaderMap::new();
	headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
	headers.insert(COOKIE, secret_header(b"", cookie).ok()?);
	OAuthHttpRequest::new(Method::GET, url, headers, None).ok()
}
async fn execute(
	http: &dyn OAuthHttpClient,
	request: Option<OAuthHttpRequest>,
	deadline: Option<Instant>,
) -> Option<OAuthHttpResponse> {
	let request = request?;
	match deadline {
		Some(deadline) => time::timeout_at(deadline.into(), http.execute(request))
			.await
			.ok()?
			.ok(),
		None => http.execute(request).await.ok(),
	}
}

fn q(value: f64, exponent: u8) -> Option<UsageQuantity> {
	if !value.is_finite() || value < 0.0 {
		return None;
	}
	let multiplier = 10_u64.checked_pow(u32::from(exponent))? as f64;
	let units = (value * multiplier).round();
	(units <= u64::MAX as f64).then(|| UsageQuantity::new(units as u64, exponent))
}
fn status(used: Option<f64>, limit: Option<f64>) -> UsageStatus {
	match used
		.zip(limit)
		.filter(|(_, limit)| *limit > 0.0)
		.map(|(used, limit)| used / limit)
	{
		Some(value) if value >= 1.0 => UsageStatus::Exhausted,
		Some(value) if value >= 0.9 => UsageStatus::Warning,
		Some(_) => UsageStatus::Ok,
		None => UsageStatus::Unknown,
	}
}
fn window(
	id: Str,
	label: Str,
	unit: UsageUnit,
	used: Option<f64>,
	remaining: Option<f64>,
	limit: Option<f64>,
	resets_at: Option<SystemTime>,
	now: SystemTime,
) -> UsageWindow {
	let exponent = match unit {
		UsageUnit::Usd => 2,
		UsageUnit::Percent => 3,
		_ => 0,
	};
	UsageWindow {
		id,
		kind: UsageWindowKind::Quota,
		dimension: Str::new(match unit {
			UsageUnit::Usd => "usd",
			UsageUnit::Percent => "percent",
			UsageUnit::Credits => "credits",
			_ => "requests",
		}),
		label: Some(label),
		scope: None,
		amount: UsageAmount {
			unit,
			consumed: used.and_then(|v| q(v, exponent)),
			remaining: remaining.and_then(|v| q(v, exponent)),
			limit: limit.and_then(|v| q(v, exponent)),
		},
		status: Some(status(used, limit)),
		duration: None,
		resets_at,
		reset_label: None,
		notes: Box::default(),
		source: UsageSource::Provider,
		observed_at: now,
	}
}

fn numeric(record: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<f64> {
	keys
		.iter()
		.find_map(|key| record.get(*key).and_then(Value::as_f64))
}
fn derive_resets_at(root: &serde_json::Map<String, Value>) -> Option<SystemTime> {
	for key in ["billingCycleEnd", "endOfMonth", "resetsAt", "nextReset"] {
		if let Some(parsed) = root.get(key).and_then(parse_timestamp) {
			return Some(parsed);
		}
	}
	for key in ["startOfMonth", "billingCycleStart", "startOfBillingCycle"] {
		if let Some(next) = root
			.get(key)
			.and_then(Value::as_str)
			.and_then(next_utc_month)
		{
			return Some(next);
		}
	}
	None
}
fn parse_timestamp(value: &Value) -> Option<SystemTime> {
	if let Some(text) = value.as_str() {
		return parse_rfc3339(text).or_else(|| text.parse::<u64>().ok().and_then(epoch));
	}
	value.as_u64().and_then(epoch)
}
fn epoch(value: u64) -> Option<SystemTime> {
	let millis = if value < 100_000_000_000 {
		value.checked_mul(1000)?
	} else {
		value
	};
	SystemTime::UNIX_EPOCH.checked_add(Duration::from_millis(millis))
}
fn next_utc_month(start: &str) -> Option<SystemTime> {
	let date = start.get(..10)?;
	let year: u32 = date.get(..4)?.parse().ok()?;
	let month: u32 = date.get(5..7)?.parse().ok()?;
	let (year, month) = if month == 12 {
		(year + 1, 1)
	} else {
		(year, month + 1)
	};
	parse_rfc3339(&format!("{year:04}-{month:02}-01T00:00:00Z"))
}

fn parse_cursor_usage(body: &str, now: SystemTime) -> Option<Vec<UsageWindow>> {
	let root: Value = serde_json::from_str(body).ok()?;
	let object = root.as_object()?;
	let resets_at = derive_resets_at(object);
	let mut windows = Vec::new();
	for (key, value) in object {
		let Some(record) = value.as_object() else {
			continue;
		};
		let used = numeric(record, &["numRequests", "used", "amountUsed", "usdUsed"]);
		let limit = numeric(record, &["maxRequestUsage", "limit", "amountLimit", "usdLimit"]);
		if used.is_none() && limit.is_none() {
			continue;
		}
		let usd = key == "planUsage"
			|| ["usd", "billing", "stripe"]
				.iter()
				.any(|part| key.to_ascii_lowercase().contains(part));
		let unit = if usd {
			UsageUnit::Usd
		} else {
			UsageUnit::Requests
		};
		let remaining = limit.zip(used).map(|(limit, used)| (limit - used).max(0.0));
		windows.push(window(
			sf!("cursor:{}:{}", if usd { "usd" } else { "requests" }, key.trim().to_ascii_lowercase()),
			sf!("{key} {}", if usd { "spend" } else { "requests" }),
			unit,
			used,
			remaining,
			limit,
			resets_at,
			now,
		));
	}
	(!windows.is_empty()).then_some(windows)
}
fn cents_bucket(value: &Value) -> Option<(Option<f64>, Option<f64>, Option<f64>)> {
	let bucket = value.as_object()?;
	if bucket.get("enabled").and_then(Value::as_bool) == Some(false) {
		return None;
	}
	let mut used = bucket.get("used").and_then(Value::as_f64).unwrap_or(0.0);
	let limit = bucket.get("limit").and_then(Value::as_f64);
	let remaining = bucket.get("remaining").and_then(Value::as_f64);
	if used == 0.0
		&& let (Some(limit), Some(remaining)) = (limit, remaining)
		&& remaining < limit
	{
		used = limit - remaining;
	}
	Some((Some(used / 100.0), remaining.map(|v| v / 100.0), limit.map(|v| v / 100.0)))
}
fn parse_cursor_individual_usage(body: &str, now: SystemTime) -> Option<Vec<UsageWindow>> {
	let root: Value = serde_json::from_str(body).ok()?;
	let individual = root.get("individualUsage")?.as_object()?;
	let mut windows = Vec::new();
	let overall = individual.get("overall").and_then(cents_bucket);
	if let Some((used, remaining, limit)) = overall {
		windows.push(window(
			sf!("cursor:usd:individual-overall"),
			sf!("Personal Usage"),
			UsageUnit::Usd,
			used,
			remaining,
			limit,
			None,
			now,
		));
	} else if let Some(plan) = individual.get("plan").and_then(Value::as_object) {
		let limit = plan.get("limit").and_then(Value::as_f64).map(|v| v / 100.0);
		if let Some(percent) = plan.get("autoPercentUsed").and_then(Value::as_f64) {
			windows.push(window(
				sf!("cursor:usd:individual-auto"),
				sf!("Cursor Models"),
				UsageUnit::Percent,
				Some(percent),
				Some((100.0 - percent).max(0.0)),
				Some(100.0),
				None,
				now,
			));
		}
		if let Some(percent) = plan.get("apiPercentUsed").and_then(Value::as_f64) {
			let used = limit.map_or(percent, |limit| limit * percent / 100.0);
			windows.push(window(
				sf!("cursor:usd:individual-api"),
				sf!("Other Models"),
				UsageUnit::Usd,
				Some(used),
				limit.map(|v| (v - used).max(0.0)),
				limit,
				None,
				now,
			));
		}
		if windows.is_empty() {
			if let Some(percent) = plan.get("totalPercentUsed").and_then(Value::as_f64) {
				windows.push(window(
					sf!("cursor:usd:individual-plan"),
					sf!("Personal Usage"),
					UsageUnit::Percent,
					Some(percent),
					Some((100.0 - percent).max(0.0)),
					Some(100.0),
					None,
					now,
				));
			} else if let Some((used, remaining, limit)) = cents_bucket(&Value::Object(plan.clone())) {
				windows.push(window(
					sf!("cursor:usd:individual-plan"),
					sf!("Personal Usage"),
					UsageUnit::Usd,
					used,
					remaining,
					limit,
					None,
					now,
				));
			}
		}
	}
	if let Some((used, remaining, limit)) = individual
		.get("onDemand")
		.and_then(cents_bucket)
		.filter(|(_, _, limit)| limit.is_some_and(|v| v > 0.0))
	{
		windows.push(window(
			sf!("cursor:usd:individual-ondemand"),
			sf!("On-Demand Usage"),
			UsageUnit::Usd,
			used,
			remaining,
			limit,
			None,
			now,
		));
	}
	(!windows.is_empty()).then_some(windows)
}
fn parse_profile_email(body: &str, expected_sub: Option<&str>) -> Option<Str> {
	let root: Value = serde_json::from_str(body).ok()?;
	if root.get("sub")?.as_str()? != expected_sub? {
		return None;
	}
	let email = root.get("email")?.as_str()?.trim();
	(!email.is_empty()).then(|| Str::new(email.to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
	use std::{collections::VecDeque, sync::Arc, time::SystemTime};

	use futures::{FutureExt as _, future::BoxFuture};
	use http::HeaderMap;
	use omp_core::{SecretString, base64_url};
	use parking_lot::Mutex;

	use super::fetch_cursor_usage;
	use crate::auth::{OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse, OAuthTransportError};
	#[derive(Clone)]
	struct Req {
		url:     String,
		headers: HeaderMap,
	}
	#[derive(Clone)]
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
	fn jwt() -> String {
		let payload = base64_url::encode_raw(br#"{"sub":"workos|user_123"}"#).into_string();
		format!("x.{payload}.y")
	}
	#[tokio::test]
	async fn cookie_flow_merges_legacy_and_personal_and_validates_profile() {
		let http = Http::new([
			(
				200,
				r#"{"gpt-4":{"numRequests":9,"maxRequestUsage":10},"startOfMonth":"2026-08-01T00:00:00Z"}"#,
			),
			(
				200,
				r#"{"individualUsage":{"overall":{"enabled":true,"used":9000,"remaining":1000,"limit":10000},"plan":{"autoPercentUsed":40},"onDemand":{"enabled":true,"used":500,"limit":2000,"remaining":1500}}}"#,
			),
			(200, r#"{"sub":"user_123","email":"USER@EXAMPLE.COM"}"#),
		]);
		let report = fetch_cursor_usage(&jwt(), &http, SystemTime::UNIX_EPOCH)
			.await
			.expect("report");
		assert_eq!(report.windows.len(), 3);
		assert_eq!(report.windows[1].amount.consumed.map(|q| q.units), Some(9000));
		assert_eq!(report.account_meta.email.as_deref(), Some("user@example.com"));
		let requests = http.requests.lock();
		let web = requests
			.iter()
			.find(|r| r.url.ends_with("usage-summary"))
			.expect("summary");
		assert!(web.headers.get("authorization").is_none());
		assert!(
			web.headers["cookie"]
				.to_str()
				.expect("cookie")
				.starts_with("WorkosCursorSessionToken=user_123%3A%3A")
		);
	}
	#[tokio::test]
	async fn custom_proxy_only_sends_auth_usage_without_cookie() {
		let http = Http::new([(200, r#"{"planUsage":{"usdUsed":95,"usdLimit":100}}"#)]);
		let raw = format!(r#"{{"accessToken":"{}","baseUrl":"https://proxy.test/"}}"#, jwt());
		let report = fetch_cursor_usage(&raw, &http, SystemTime::UNIX_EPOCH)
			.await
			.expect("report");
		assert_eq!(report.windows[0].status, Some(crate::answer::UsageStatus::Warning));
		let requests = http.requests.lock();
		assert_eq!(requests.len(), 1);
		assert_eq!(requests[0].url, "https://proxy.test/auth/usage");
		assert!(requests[0].headers.get("cookie").is_none());
	}
	#[tokio::test]
	async fn disabled_overall_uses_plan_and_preserves_on_demand() {
		let http = Http::new([
			(500, "{}"),
			(
				200,
				r#"{"individualUsage":{"overall":{"enabled":false},"plan":{"autoPercentUsed":25,"apiPercentUsed":50,"limit":10000},"onDemand":{"enabled":true,"used":100,"limit":1000}}}"#,
			),
			(200, r#"{"sub":"other","email":"wrong@example.com"}"#),
		]);
		let report = fetch_cursor_usage(&jwt(), &http, SystemTime::UNIX_EPOCH)
			.await
			.expect("partial report");
		assert_eq!(
			report
				.windows
				.iter()
				.map(|w| w.id.as_str())
				.collect::<Vec<_>>(),
			vec![
				"cursor:usd:individual-auto",
				"cursor:usd:individual-api",
				"cursor:usd:individual-ondemand"
			]
		);
		assert!(report.account_meta.email.is_none());
	}
}
