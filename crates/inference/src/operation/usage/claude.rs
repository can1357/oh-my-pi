//! Anthropic Claude subscription usage retrieval.

use std::{
	collections::HashSet,
	sync::Arc,
	time::{Duration, Instant, SystemTime},
};

use futures::FutureExt as _;
use http::{
	HeaderMap, HeaderValue, Method,
	header::{ACCEPT, ACCEPT_ENCODING, AUTHORIZATION, CONNECTION, CONTENT_TYPE, USER_AGENT},
};
use omp_core::{ExposeSecret as _, IntoStr, SecretString, Str, parse_rfc3339, sf};
use serde_json::{Map, Value};
use tokio::time;
use url::Url;
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

const PROVIDER: &str = "anthropic";
const DEFAULT_ENDPOINT: &str = "https://api.anthropic.com/api/oauth";
const ANTHROPIC_BETA: &str = "claude-code-20250219,oauth-2025-04-20,\
                              interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,\
                              context-management-2025-06-27,prompt-caching-scope-2026-01-05,\
                              mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,\
                              effort-2025-11-24,extended-cache-ttl-2025-04-11";
const FIVE_HOURS: Duration = Duration::from_hours(5);
const SEVEN_DAYS: Duration = Duration::from_days(7);
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Application-registered Anthropic Claude subscription usage fetcher.
#[derive(Clone)]
pub struct ClaudeUsageFetcher {
	provider: ProviderId,
	http:     Arc<dyn OAuthHttpClient>,
}

impl ClaudeUsageFetcher {
	/// Constructs a fetcher over the application's shared bounded HTTP client.
	pub fn new(http: Arc<dyn OAuthHttpClient>) -> Self {
		Self { provider: ProviderId::from(PROVIDER), http }
	}
}

impl ConsoleUsageFetcher for ClaudeUsageFetcher {
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
			let token = credential.ok_or(UsageFetchError::Protocol)?.expose_secret();
			fetch_claude_usage_until(token, self.http.as_ref(), now, deadline).await
		}
		.boxed()
	}
}

/// Normalizes an Anthropic API or OAuth URL to the Claude OAuth account API.
pub fn normalize_claude_base_url(base_url: Option<&str>) -> Str {
	let Some(trimmed) = base_url.map(str::trim).filter(|value| !value.is_empty()) else {
		return sf!(DEFAULT_ENDPOINT);
	};
	let trimmed = trimmed.trim_end_matches('/');
	if trimmed.to_ascii_lowercase().ends_with("/api/oauth") {
		return Str::new(trimmed);
	}
	let Ok(mut url) = Url::parse(trimmed) else {
		return sf!(DEFAULT_ENDPOINT);
	};
	let mut path = url.path().trim_end_matches('/').to_owned();
	if path == "/" {
		path.clear();
	}
	if path.to_ascii_lowercase().ends_with("/v1") {
		path.truncate(path.len() - 3);
	}
	url.set_query(None);
	url.set_fragment(None);
	let origin = url.origin().ascii_serialization();
	if path.is_empty() {
		sf!("{origin}/api/oauth")
	} else {
		sf!("{origin}{path}/api/oauth")
	}
}

/// Fetches Claude subscription usage with a raw OAuth access token.
pub async fn fetch_claude_usage(
	access_token: &str,
	http: &dyn OAuthHttpClient,
	now: SystemTime,
) -> Result<ConsoleUsageObservation, UsageFetchError> {
	fetch_claude_usage_until(access_token, http, now, None).await
}

async fn fetch_claude_usage_until(
	access_token: &str,
	http: &dyn OAuthHttpClient,
	now: SystemTime,
	deadline: Option<Instant>,
) -> Result<ConsoleUsageObservation, UsageFetchError> {
	if access_token.is_empty() {
		return Err(UsageFetchError::Protocol);
	}
	let base_url = normalize_claude_base_url(None);
	let headers = claude_headers(access_token)?;
	let response = execute(
		http,
		OAuthHttpRequest::new(Method::GET, &format!("{base_url}/usage"), headers.clone(), None)
			.map_err(|_| UsageFetchError::Protocol)?,
		deadline,
	)
	.await?;
	classify_status(response.status)?;
	let payload: Value = serde_json::from_str(response.body.expose_secret())
		.map_err(|_| UsageFetchError::Unavailable)?;
	let root = payload.as_object().ok_or(UsageFetchError::Unavailable)?;
	let windows = parse_windows(root, now);
	if windows.is_empty() {
		return Err(UsageFetchError::Unavailable);
	}

	let (mut account_id, mut email) = extract_usage_identity(root);
	if (account_id.is_none() || email.is_none())
		&& let Some(profile) = fetch_profile(http, &base_url, headers, deadline).await
	{
		let (profile_id, profile_email) = extract_profile_identity(&profile);
		account_id = account_id.or(profile_id);
		email = email.or(profile_email);
	}

	Ok(ConsoleUsageObservation {
		account_meta: UsageAccountMetadata {
			provider_account_id: account_id,
			email,
			..UsageAccountMetadata::default()
		},
		plan: None,
		source_label: Some(sf!("anthropic-oauth")),
		notes: Box::default(),
		reset_credits: None,
		windows,
	})
}

fn claude_headers(access_token: &str) -> Result<HeaderMap, UsageFetchError> {
	let mut headers = HeaderMap::new();
	headers.insert(ACCEPT, HeaderValue::from_static("application/json, text/plain, */*"));
	headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("gzip, compress, deflate, br"));
	headers.insert("anthropic-beta", HeaderValue::from_static(ANTHROPIC_BETA));
	headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
	headers.insert(USER_AGENT, HeaderValue::from_static("claude-cli/2.1.258 (external, cli)"));
	headers.insert(CONNECTION, HeaderValue::from_static("keep-alive"));
	headers.insert(AUTHORIZATION, bearer_header(access_token)?);
	Ok(headers)
}

fn bearer_header(token: &str) -> Result<HeaderValue, UsageFetchError> {
	let mut bytes = Zeroizing::new(Vec::with_capacity(7 + token.len()));
	bytes.extend_from_slice(b"Bearer ");
	bytes.extend_from_slice(token.as_bytes());
	let mut value = HeaderValue::from_bytes(&bytes).map_err(|_| UsageFetchError::Protocol)?;
	value.set_sensitive(true);
	Ok(value)
}

async fn execute(
	http: &dyn OAuthHttpClient,
	request: OAuthHttpRequest,
	deadline: Option<Instant>,
) -> Result<OAuthHttpResponse, UsageFetchError> {
	match deadline {
		Some(deadline) => time::timeout_at(deadline.into(), http.execute(request))
			.await
			.map_err(|_| UsageFetchError::Unavailable)?
			.map_err(|_| UsageFetchError::Unavailable),
		None => http
			.execute(request)
			.await
			.map_err(|_| UsageFetchError::Unavailable),
	}
}

const fn classify_status(status: u16) -> Result<(), UsageFetchError> {
	match status {
		200..=299 => Ok(()),
		401 | 403 => Err(UsageFetchError::AuthRejected),
		404 | 429 | 500..=599 => Err(UsageFetchError::Unavailable),
		_ => Err(UsageFetchError::Unavailable),
	}
}

async fn fetch_profile(
	http: &dyn OAuthHttpClient,
	base_url: &str,
	headers: HeaderMap,
	deadline: Option<Instant>,
) -> Option<Map<String, Value>> {
	let request =
		OAuthHttpRequest::new(Method::GET, &format!("{base_url}/profile"), headers, None).ok()?;
	let response = execute(http, request, deadline).await.ok()?;
	if !(200..300).contains(&response.status) {
		return None;
	}
	serde_json::from_str::<Value>(response.body.expose_secret())
		.ok()?
		.as_object()
		.cloned()
}

fn parse_windows(root: &Map<String, Value>, now: SystemTime) -> Vec<UsageWindow> {
	let entries = parse_api_limit_entries(root.get("limits"));
	let mut windows = Vec::with_capacity(5 + entries.len());
	let five_hour = parse_bucket(root.get("five_hour")).or_else(|| {
		entries
			.iter()
			.find(|entry| entry.kind == "session")
			.map(|entry| entry.bucket)
	});
	let seven_day = parse_bucket(root.get("seven_day")).or_else(|| {
		entries
			.iter()
			.find(|entry| entry.kind == "weekly_all")
			.map(|entry| entry.bucket)
	});
	if let Some(window) =
		percent_window("anthropic:5h", "Claude 5 Hour", "shared", FIVE_HOURS, five_hour, now)
	{
		windows.push(window);
	}
	if let Some(window) =
		percent_window("anthropic:7d", "Claude 7 Day", "shared", SEVEN_DAYS, seven_day, now)
	{
		windows.push(window);
	}
	if let Some(window) = percent_window(
		"anthropic:7d:opus",
		"Claude 7 Day (Opus)",
		"opus",
		SEVEN_DAYS,
		parse_bucket(root.get("seven_day_opus")),
		now,
	) {
		windows.push(window);
	}
	if let Some(window) = percent_window(
		"anthropic:7d:sonnet",
		"Claude 7 Day (Sonnet)",
		"sonnet",
		SEVEN_DAYS,
		parse_bucket(root.get("seven_day_sonnet")),
		now,
	) {
		windows.push(window);
	}

	let mut seen = HashSet::new();
	for entry in entries.iter().filter(|entry| entry.kind == "weekly_scoped") {
		let Some(display_name) = entry.display_name.as_deref() else {
			continue;
		};
		let slug = slugify(display_name);
		if slug.is_empty() || !seen.insert(slug.clone()) {
			continue;
		}
		if let Some(window) = percent_window(
			sf!("anthropic:7d:{slug}"),
			sf!("Claude 7 Day ({display_name})"),
			Str::new(slug),
			SEVEN_DAYS,
			Some(entry.bucket),
			now,
		) {
			windows.push(window);
		}
	}
	if let Some(window) = extra_usage_window(root, now) {
		windows.push(window);
	}
	windows
}

#[derive(Clone, Copy)]
struct ParsedBucket {
	utilization: f64,
	resets_at:   Option<SystemTime>,
}

struct ParsedApiLimit {
	kind:         Str,
	bucket:       ParsedBucket,
	display_name: Option<Str>,
}

fn parse_bucket(value: Option<&Value>) -> Option<ParsedBucket> {
	let object = value?.as_object()?;
	let utilization = number(object.get("utilization")?)?;
	let resets_at = object
		.get("resets_at")
		.and_then(Value::as_str)
		.and_then(parse_rfc3339);
	Some(ParsedBucket { utilization, resets_at })
}

fn parse_api_limit_entries(value: Option<&Value>) -> Vec<ParsedApiLimit> {
	let Some(entries) = value.and_then(Value::as_array) else {
		return Vec::new();
	};
	entries
		.iter()
		.filter_map(|value| {
			let object = value.as_object()?;
			let kind = object.get("kind")?.as_str()?.trim();
			let utilization = number(object.get("percent")?)?;
			let resets_at = object
				.get("resets_at")
				.and_then(Value::as_str)
				.and_then(parse_rfc3339);
			let display_name = object
				.get("scope")
				.and_then(Value::as_object)
				.and_then(|scope| scope.get("model"))
				.and_then(Value::as_object)
				.and_then(|model| model.get("display_name"))
				.and_then(Value::as_str)
				.map(str::trim)
				.filter(|value| !value.is_empty())
				.map(Str::new);
			Some(ParsedApiLimit {
				kind: Str::new(kind),
				bucket: ParsedBucket { utilization, resets_at },
				display_name,
			})
		})
		.collect()
}

fn percent_window(
	id: impl IntoStr,
	label: impl IntoStr,
	scope: impl IntoStr,
	duration: Duration,
	bucket: Option<ParsedBucket>,
	now: SystemTime,
) -> Option<UsageWindow> {
	let bucket = bucket?;
	let used = bucket.utilization.clamp(0.0, 100.0);
	let consumed = decimal_quantity(used)?;
	let remaining = decimal_quantity(100.0 - used)?;
	Some(UsageWindow {
		id:          id.into_str(),
		kind:        UsageWindowKind::Quota,
		dimension:   sf!("percent"),
		label:       Some(label.into_str()),
		scope:       Some(scope.into_str()),
		amount:      UsageAmount {
			unit:      UsageUnit::Percent,
			consumed:  Some(consumed),
			remaining: Some(remaining),
			limit:     Some(UsageQuantity::new(100, 0)),
		},
		status:      Some(usage_status(used / 100.0)),
		duration:    Some(duration),
		resets_at:   bucket.resets_at,
		reset_label: None,
		notes:       Box::default(),
		source:      UsageSource::Provider,
		observed_at: now,
	})
}

fn extra_usage_window(root: &Map<String, Value>, now: SystemTime) -> Option<UsageWindow> {
	let (used, limit) = match root.get("spend") {
		Some(Value::Null) | None => parse_legacy_extra(root.get("extra_usage")?)?,
		Some(spend) => parse_spend(spend)?,
	};
	let remaining = limit.and_then(|limit| subtract_quantities(limit, used));
	let status = limit.map(|limit| {
		let fraction = quantity_ratio(used, limit).unwrap_or(1.0);
		if fraction >= 1.0 {
			UsageStatus::Exhausted
		} else {
			usage_status(fraction)
		}
	});
	Some(UsageWindow {
		id: sf!("anthropic:extra"),
		kind: UsageWindowKind::Billing,
		dimension: sf!("usd"),
		label: Some(sf!("Claude Extra Usage")),
		scope: Some(sf!("extra")),
		amount: UsageAmount { unit: UsageUnit::Usd, consumed: Some(used), remaining, limit },
		status,
		duration: None,
		resets_at: None,
		reset_label: None,
		notes: Box::default(),
		source: UsageSource::Provider,
		observed_at: now,
	})
}

fn parse_spend(value: &Value) -> Option<(UsageQuantity, Option<UsageQuantity>)> {
	let object = value.as_object()?;
	if object.get("enabled").and_then(Value::as_bool) != Some(true) || !object.contains_key("limit")
	{
		return None;
	}
	let used = parse_money(object.get("used")?, true)?;
	let limit = match object.get("limit")? {
		Value::Null => None,
		value => {
			let value = parse_money(value, true)?;
			if value.units == 0 {
				return None;
			}
			Some(value)
		},
	};
	Some((used, limit))
}

fn parse_legacy_extra(value: &Value) -> Option<(UsageQuantity, Option<UsageQuantity>)> {
	let object = value.as_object()?;
	if object.get("is_enabled").and_then(Value::as_bool) != Some(true)
		|| !object.contains_key("monthly_limit")
	{
		return None;
	}
	let exponent = object.get("decimal_places").map_or(Some(2), integer_u8)?;
	if exponent > 18 || !valid_usd_currency(object.get("currency"), false) {
		return None;
	}
	let used = UsageQuantity::new(safe_u64(object.get("used_credits")?)?, exponent);
	let limit = match object.get("monthly_limit")? {
		Value::Null => None,
		value => {
			let units = safe_u64(value)?;
			if units == 0 {
				return None;
			}
			Some(UsageQuantity::new(units, exponent))
		},
	};
	Some((used, limit))
}

fn parse_money(value: &Value, currency_required: bool) -> Option<UsageQuantity> {
	let object = value.as_object()?;
	if !valid_usd_currency(object.get("currency"), currency_required) {
		return None;
	}
	let exponent = integer_u8(object.get("exponent")?)?;
	if exponent > 18 {
		return None;
	}
	Some(UsageQuantity::new(safe_u64(object.get("amount_minor")?)?, exponent))
}

fn valid_usd_currency(value: Option<&Value>, required: bool) -> bool {
	match value {
		None => !required,
		Some(Value::String(value)) => value.eq_ignore_ascii_case("usd"),
		_ => false,
	}
}

fn safe_u64(value: &Value) -> Option<u64> {
	value.as_u64().filter(|value| *value <= MAX_SAFE_INTEGER)
}

fn integer_u8(value: &Value) -> Option<u8> {
	value.as_u64()?.try_into().ok()
}

fn subtract_quantities(limit: UsageQuantity, used: UsageQuantity) -> Option<UsageQuantity> {
	let exponent = limit.decimal_exponent.max(used.decimal_exponent);
	let limit_units = u128::from(limit.units)
		.checked_mul(10_u128.checked_pow(u32::from(exponent - limit.decimal_exponent))?)?;
	let used_units = u128::from(used.units)
		.checked_mul(10_u128.checked_pow(u32::from(exponent - used.decimal_exponent))?)?;
	quantity_from_u128(limit_units.saturating_sub(used_units), exponent)
}

fn quantity_from_u128(mut units: u128, mut exponent: u8) -> Option<UsageQuantity> {
	while units > u128::from(u64::MAX) && exponent > 0 && units.is_multiple_of(10) {
		units /= 10;
		exponent -= 1;
	}
	Some(UsageQuantity::new(units.try_into().ok()?, exponent))
}

fn quantity_ratio(used: UsageQuantity, limit: UsageQuantity) -> Option<f64> {
	if limit.units == 0 {
		return None;
	}
	let numerator = used.units as f64 * 10_f64.powi(i32::from(limit.decimal_exponent));
	let denominator = limit.units as f64 * 10_f64.powi(i32::from(used.decimal_exponent));
	let ratio = numerator / denominator;
	ratio.is_finite().then_some(ratio)
}

fn number(value: &Value) -> Option<f64> {
	match value {
		Value::Number(value) => value.as_f64().filter(|value| value.is_finite()),
		Value::String(value) => value.parse::<f64>().ok().filter(|value| value.is_finite()),
		_ => None,
	}
}

fn decimal_quantity(value: f64) -> Option<UsageQuantity> {
	if !value.is_finite() || value < 0.0 {
		return None;
	}
	let rendered = format!("{value:.9}");
	let rendered = rendered.trim_end_matches('0').trim_end_matches('.');
	let (whole, fraction) = rendered.split_once('.').unwrap_or((rendered, ""));
	let units = format!("{whole}{fraction}").parse().ok()?;
	Some(UsageQuantity::new(units, fraction.len().try_into().ok()?))
}

fn usage_status(fraction: f64) -> UsageStatus {
	if fraction >= 1.0 {
		UsageStatus::Exhausted
	} else if fraction >= 0.9 {
		UsageStatus::Warning
	} else {
		UsageStatus::Ok
	}
}

fn slugify(value: &str) -> String {
	let mut slug = String::with_capacity(value.len());
	let mut separator = false;
	for character in value.trim().chars().flat_map(char::to_lowercase) {
		if character.is_ascii_alphanumeric() {
			if separator && !slug.is_empty() {
				slug.push('-');
			}
			slug.push(character);
			separator = false;
		} else {
			separator = true;
		}
	}
	slug
}

fn extract_usage_identity(root: &Map<String, Value>) -> (Option<Str>, Option<Str>) {
	let account_id = first_string(root, &["account_id", "accountId", "user_id", "userId"])
		.or_else(|| nested_string(root, "account", &["uuid", "id"]))
		.or_else(|| nested_string(root, "user", &["uuid", "id"]));
	let email = first_string(root, &["email", "user_email", "userEmail"])
		.or_else(|| nested_string(root, "account", &["email"]))
		.or_else(|| nested_string(root, "user", &["email"]));
	(account_id, email)
}

fn extract_profile_identity(root: &Map<String, Value>) -> (Option<Str>, Option<Str>) {
	let account_id =
		first_string(root, &["uuid"]).or_else(|| nested_string(root, "account", &["uuid"]));
	let email =
		first_string(root, &["email"]).or_else(|| nested_string(root, "account", &["email"]));
	(account_id, email)
}

fn first_string(root: &Map<String, Value>, keys: &[&str]) -> Option<Str> {
	keys.iter().find_map(|key| {
		root
			.get(*key)
			.and_then(Value::as_str)
			.map(str::trim)
			.filter(|value| !value.is_empty())
			.map(Str::new)
	})
}

fn nested_string(root: &Map<String, Value>, key: &str, nested_keys: &[&str]) -> Option<Str> {
	root
		.get(key)
		.and_then(Value::as_object)
		.and_then(|nested| first_string(nested, nested_keys))
}

#[cfg(test)]
mod tests {
	use std::{
		collections::VecDeque,
		sync::Arc,
		time::{Duration, SystemTime, UNIX_EPOCH},
	};

	use futures::{FutureExt as _, future::BoxFuture};
	use http::{HeaderMap, Method};
	use omp_core::SecretString;
	use parking_lot::Mutex;

	use super::{ANTHROPIC_BETA, fetch_claude_usage, normalize_claude_base_url};
	use crate::{
		answer::UsageStatus as AnswerUsageStatus,
		auth::{OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse, OAuthTransportError},
		operation::usage::UsageFetchError,
	};

	#[derive(Clone)]
	struct RecordedRequest {
		method:  Method,
		url:     String,
		headers: HeaderMap,
	}

	#[derive(Clone, Default)]
	struct ScriptedHttp {
		responses: Arc<Mutex<VecDeque<OAuthHttpResponse>>>,
		requests:  Arc<Mutex<Vec<RecordedRequest>>>,
	}

	impl ScriptedHttp {
		fn new<S: Into<String>>(items: impl IntoIterator<Item = (u16, S)>) -> Self {
			Self {
				responses: Arc::new(Mutex::new(
					items
						.into_iter()
						.map(|(status, body)| OAuthHttpResponse {
							status,
							headers: HeaderMap::new(),
							body: SecretString::from(body.into()),
						})
						.collect(),
				)),
				requests:  Arc::new(Mutex::new(Vec::new())),
			}
		}
	}

	impl OAuthHttpClient for ScriptedHttp {
		fn execute(
			&self,
			request: OAuthHttpRequest,
		) -> BoxFuture<'_, Result<OAuthHttpResponse, OAuthTransportError>> {
			let (method, url, headers, body) = request.into_parts();
			assert!(body.is_none());
			self
				.requests
				.lock()
				.push(RecordedRequest { method, url: url.to_string(), headers });
			let response = self
				.responses
				.lock()
				.pop_front()
				.expect("scripted response");
			async move { Ok(response) }.boxed()
		}
	}

	fn now() -> SystemTime {
		UNIX_EPOCH + Duration::from_secs(1_700_000_000)
	}

	#[test]
	fn base_urls_are_normalized_to_oauth_api() {
		assert_eq!(normalize_claude_base_url(None).as_str(), "https://api.anthropic.com/api/oauth");
		assert_eq!(
			normalize_claude_base_url(Some("https://example.test/v1/")).as_str(),
			"https://example.test/api/oauth"
		);
		assert_eq!(
			normalize_claude_base_url(Some("https://example.test/custom/api/oauth/")).as_str(),
			"https://example.test/custom/api/oauth"
		);
	}

	#[tokio::test]
	async fn sends_exact_fingerprint_and_backfills_profile_identity() {
		let http = ScriptedHttp::new([
			(200, r#"{"five_hour":{"utilization":42}}"#),
			(200, r#"{"uuid":"account-1","email":"User@Example.com"}"#),
		]);
		let report = fetch_claude_usage("oauth-secret", &http, now())
			.await
			.expect("usage");
		assert_eq!(report.account_meta.provider_account_id.as_deref(), Some("account-1"));
		assert_eq!(report.account_meta.email.as_deref(), Some("User@Example.com"));
		assert_eq!(report.windows[0].resets_at, None);
		let requests = http.requests.lock();
		assert_eq!(requests.len(), 2);
		assert_eq!(requests[0].method, Method::GET);
		assert_eq!(requests[0].url, "https://api.anthropic.com/api/oauth/usage");
		assert_eq!(requests[1].url, "https://api.anthropic.com/api/oauth/profile");
		assert_eq!(requests[0].headers["authorization"], "Bearer oauth-secret");
		assert_eq!(requests[0].headers["user-agent"], "claude-cli/2.1.258 (external, cli)");
		assert_eq!(requests[0].headers["anthropic-beta"], ANTHROPIC_BETA);
	}

	#[tokio::test]
	async fn organization_response_header_is_not_account_identity() {
		let mut headers = HeaderMap::new();
		headers.insert("anthropic-organization-id", "org_header".parse().expect("header value"));
		let http = ScriptedHttp::default();
		http.responses.lock().push_back(OAuthHttpResponse {
			status: 200,
			headers,
			body: SecretString::from(
				r#"{"account_id":"credential-account","email":"u@example.com","five_hour":{"utilization":1}}"#
					.to_owned(),
			),
		});
		let report = fetch_claude_usage("token", &http, now())
			.await
			.expect("usage");
		assert_eq!(report.account_meta.provider_account_id.as_deref(), Some("credential-account"));
		assert_eq!(report.account_meta.organization_id, None);
	}

	#[tokio::test]
	async fn surfaces_inactive_scoped_and_fallback_unified_limits() {
		let http = ScriptedHttp::new([(
			200,
			r#"{
			"account_id":"account-1","email":"u@example.com",
			"limits":[
				{"kind":"session","percent":16,"resets_at":"2026-08-15T00:00:00Z"},
				{"kind":"weekly_all","percent":18},
				{"kind":"weekly_scoped","percent":5,"is_active":false,"scope":{"model":{"display_name":"Fable"}}},
				{"kind":"weekly_scoped","percent":99,"scope":{"model":{"display_name":"Fable"}}}
			]
		}"#,
		)]);
		let report = fetch_claude_usage("token", &http, now())
			.await
			.expect("usage");
		assert_eq!(http.requests.lock().len(), 1);
		assert_eq!(report.windows.len(), 3);
		assert_eq!(report.windows[0].id.as_str(), "anthropic:5h");
		assert_eq!(report.windows[1].id.as_str(), "anthropic:7d");
		assert_eq!(report.windows[2].id.as_str(), "anthropic:7d:fable");
		assert_eq!(report.windows[2].scope.as_deref(), Some("fable"));
		assert_eq!(report.windows[2].amount.consumed.map(|value| value.units), Some(5));
	}

	#[tokio::test]
	async fn current_spend_preserves_minor_units_thresholds_and_precedence() {
		for (used, expected) in [
			(0, AnswerUsageStatus::Ok),
			(45_000, AnswerUsageStatus::Warning),
			(50_000, AnswerUsageStatus::Exhausted),
			(62_500, AnswerUsageStatus::Exhausted),
		] {
			let body = format!(
				r#"{{"account_id":"a","email":"e","spend":{{"enabled":true,"used":{{"amount_minor":{used},"currency":"usd","exponent":2}},"limit":{{"amount_minor":50000,"currency":"USD","exponent":2}}}},"extra_usage":{{"is_enabled":true,"used_credits":9900,"monthly_limit":10000}}}}"#
			);
			let http = ScriptedHttp::new([(200, body)]);
			let report = fetch_claude_usage("token", &http, now())
				.await
				.expect("usage");
			let extra = &report.windows[0];
			assert_eq!(extra.id.as_str(), "anthropic:extra");
			assert_eq!(extra.amount.consumed, Some(crate::answer::UsageQuantity::new(used, 2)));
			assert_eq!(extra.amount.limit, Some(crate::answer::UsageQuantity::new(50_000, 2)));
			assert_eq!(extra.status, Some(expected));
		}
	}

	#[tokio::test]
	async fn handles_uncapped_spend_legacy_fallback_and_disabled_authority() {
		let uncapped = ScriptedHttp::new([(
			200,
			r#"{"account_id":"a","email":"e","spend":{"enabled":true,"used":{"amount_minor":12345,"currency":"USD","exponent":3},"limit":null}}"#,
		)]);
		let report = fetch_claude_usage("token", &uncapped, now())
			.await
			.expect("usage");
		assert_eq!(
			report.windows[0].amount.consumed,
			Some(crate::answer::UsageQuantity::new(12_345, 3))
		);
		assert_eq!(report.windows[0].amount.limit, None);
		assert_eq!(report.windows[0].status, None);

		let legacy = ScriptedHttp::new([(
			200,
			r#"{"account_id":"a","email":"e","extra_usage":{"is_enabled":true,"used_credits":1234,"monthly_limit":10000,"decimal_places":2}}"#,
		)]);
		let report = fetch_claude_usage("token", &legacy, now())
			.await
			.expect("legacy usage");
		assert_eq!(
			report.windows[0].amount.consumed,
			Some(crate::answer::UsageQuantity::new(1_234, 2))
		);

		let disabled = ScriptedHttp::new([(
			200,
			r#"{"account_id":"a","email":"e","spend":{"enabled":false},"extra_usage":{"is_enabled":true,"used_credits":1234,"monthly_limit":10000}}"#,
		)]);
		assert_eq!(
			fetch_claude_usage("token", &disabled, now())
				.await
				.expect_err("disabled spend is authoritative"),
			UsageFetchError::Unavailable
		);
	}

	#[tokio::test]
	async fn rejects_malformed_spend_without_legacy_fallback() {
		for spend in [
			r#"{"enabled":true,"used":{"amount_minor":1,"currency":"EUR","exponent":2},"limit":null}"#,
			r#"{"enabled":true,"used":{"amount_minor":1.5,"currency":"USD","exponent":2},"limit":null}"#,
			r#"{"enabled":true,"used":{"amount_minor":1,"currency":"USD","exponent":2},"limit":{"amount_minor":0,"currency":"USD","exponent":2}}"#,
		] {
			let body = format!(
				r#"{{"account_id":"a","email":"e","spend":{spend},"extra_usage":{{"is_enabled":true,"used_credits":1,"monthly_limit":2}}}}"#
			);
			let http = ScriptedHttp::new([(200, body)]);
			assert_eq!(
				fetch_claude_usage("token", &http, now())
					.await
					.expect_err("malformed spend"),
				UsageFetchError::Unavailable
			);
		}
	}

	#[tokio::test]
	async fn terminal_statuses_are_typed_and_never_retried() {
		for (status, expected) in [
			(401, UsageFetchError::AuthRejected),
			(403, UsageFetchError::AuthRejected),
			(404, UsageFetchError::Unavailable),
			(429, UsageFetchError::Unavailable),
			(503, UsageFetchError::Unavailable),
		] {
			let http = ScriptedHttp::new([(status, "{}")]);
			assert_eq!(
				fetch_claude_usage("token", &http, now())
					.await
					.expect_err("terminal status"),
				expected
			);
			assert_eq!(http.requests.lock().len(), 1);
		}
	}
}
