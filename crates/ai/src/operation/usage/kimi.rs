//! Kimi Code quota retrieval.

use std::{
	env::{self, consts},
	fmt::Write as _,
	sync::Arc,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures::FutureExt as _;
use http::{
	HeaderMap, HeaderValue, Method,
	header::{AUTHORIZATION, HeaderName, USER_AGENT},
};
use omp_core::{ExposeSecret as _, SecretString, Str, parse_rfc3339, sf};
use ring::rand::{SecureRandom as _, SystemRandom};
use serde_json::{Map, Value};
use tokio::time;

use crate::{
	answer::{
		UsageAccountMetadata, UsageAmount, UsageQuantity, UsageStatus, UsageUnit, UsageWindow,
		UsageWindowKind,
	},
	auth::{OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse as AuthOAuthHttpResponse},
	catalog::ProviderId,
	operation::usage::{
		ConsoleUsageFetcher, ConsoleUsageObservation, UsageCredentialRequirement, UsageFetchError,
	},
	receipt::UsageSource,
};
const PROVIDER: &str = "kimi-code";
const BASE: &str = "https://api.kimi.com/coding/v1";
const TIMEOUT: Duration = Duration::from_secs(10);
const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Application-registered Kimi Code usage fetcher.
#[derive(Clone)]
pub struct KimiUsageFetcher {
	provider:  ProviderId,
	http:      Arc<dyn OAuthHttpClient>,
	base_url:  Str,
	device_id: Str,
}
impl KimiUsageFetcher {
	/// Constructs a fetcher over the shared bounded HTTP client.
	pub fn new(http: Arc<dyn OAuthHttpClient>) -> Self {
		Self::with_base_url(http, BASE)
	}

	fn with_base_url(http: Arc<dyn OAuthHttpClient>, base: &str) -> Self {
		Self {
			provider: ProviderId::from(PROVIDER),
			http,
			base_url: Str::new(base.trim().trim_end_matches('/')),
			device_id: Str::new(device_id()),
		}
	}
}
impl ConsoleUsageFetcher for KimiUsageFetcher {
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
			let (token, account_meta, expires) =
				credential_parts(credential.ok_or(UsageFetchError::Protocol)?.expose_secret())?;
			if expires.is_some_and(|e| e <= now) {
				return Err(UsageFetchError::Unavailable);
			}
			let url = format!("{}/usages", self.base_url);
			let response =
				execute(self.http.as_ref(), request(&url, &token, &self.device_id)?, deadline).await?;
			if !(200..300).contains(&response.status) {
				return Err(UsageFetchError::Unavailable);
			}
			let windows = parse(response.body.expose_secret(), now)?;
			Ok(ConsoleUsageObservation {
				account_meta,
				plan: None,
				source_label: Some(sf!("kimi-code")),
				notes: Box::default(),
				reset_credits: None,
				windows,
			})
		}
		.boxed()
	}
}
fn credential_parts(
	raw: &str,
) -> Result<(String, UsageAccountMetadata, Option<SystemTime>), UsageFetchError> {
	if let Ok(v) = serde_json::from_str::<Value>(raw) {
		let token = v
			.get("accessToken")
			.or_else(|| v.get("token"))
			.and_then(Value::as_str)
			.ok_or(UsageFetchError::Protocol)?
			.to_owned();
		let f = |n| v.get(n).and_then(Value::as_str).map(Str::new);
		let expires = v
			.get("expiresAt")
			.and_then(|v| v.as_u64())
			.and_then(|ms| UNIX_EPOCH.checked_add(Duration::from_millis(ms)));
		Ok((
			token,
			UsageAccountMetadata {
				provider_account_id: f("accountId"),
				email: f("email"),
				project_id: f("projectId"),
				..UsageAccountMetadata::default()
			},
			expires,
		))
	} else if raw.is_empty() {
		Err(UsageFetchError::Protocol)
	} else {
		Ok((raw.to_owned(), UsageAccountMetadata::default(), None))
	}
}
fn request(url: &str, token: &str, device_id: &str) -> Result<OAuthHttpRequest, UsageFetchError> {
	let mut h = HeaderMap::new();
	h.insert(
		USER_AGENT,
		HeaderValue::from_str(&format!("KimiCLI/{VERSION}"))
			.map_err(|_| UsageFetchError::Protocol)?,
	);
	for (n, v) in [
		("x-msh-platform", "kimi_cli".to_owned()),
		("x-msh-version", VERSION.to_owned()),
		(
			"x-msh-device-name",
			sanitize(&env::var("HOSTNAME").unwrap_or_else(|_| "unknown".to_owned())),
		),
		("x-msh-device-model", device_model().to_owned()),
		("x-msh-os-version", sanitize(consts::OS)),
		("x-msh-device-id", device_id.to_owned()),
	] {
		h.insert(
			HeaderName::from_static(n),
			HeaderValue::from_str(&v).map_err(|_| UsageFetchError::Protocol)?,
		);
	}
	let mut a =
		HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| UsageFetchError::Protocol)?;
	a.set_sensitive(true);
	h.insert(AUTHORIZATION, a);
	OAuthHttpRequest::new(Method::GET, url, h, None).map_err(|_| UsageFetchError::Protocol)
}
fn sanitize(v: &str) -> String {
	v.chars()
		.filter(|c| matches!(*c, ' '..='~'))
		.collect::<String>()
		.trim()
		.to_owned()
}
const fn device_model() -> &'static str {
	if cfg!(target_os = "macos") {
		"macOS"
	} else if cfg!(target_os = "windows") {
		"Windows"
	} else if cfg!(target_os = "linux") {
		"Linux"
	} else {
		"unknown"
	}
}
fn device_id() -> String {
	let mut bytes = [0u8; 16];
	if SystemRandom::new().fill(&mut bytes).is_err() {
		return "00000000000000000000000000000000".to_owned();
	}
	let mut out = String::with_capacity(32);
	for b in bytes {
		let _ = write!(&mut out, "{b:02x}");
	}
	out
}
async fn execute(
	http: &dyn OAuthHttpClient,
	r: OAuthHttpRequest,
	d: Option<Instant>,
) -> Result<AuthOAuthHttpResponse, UsageFetchError> {
	let t = d
		.map_or(TIMEOUT, |e| e.saturating_duration_since(Instant::now()))
		.min(TIMEOUT);
	if t.is_zero() {
		return Err(UsageFetchError::Unavailable);
	}
	time::timeout(t, http.execute(r))
		.await
		.map_err(|_| UsageFetchError::Unavailable)?
		.map_err(|_| UsageFetchError::Unavailable)
}
fn parse(body: &str, now: SystemTime) -> Result<Vec<UsageWindow>, UsageFetchError> {
	let p: Value = serde_json::from_str(body).map_err(|_| UsageFetchError::Unavailable)?;
	let p = p.as_object().ok_or(UsageFetchError::Unavailable)?;
	let mut out = Vec::new();
	if let Some(summary) = p.get("usage").and_then(Value::as_object)
		&& let Some(w) =
			row(summary, "kimi-code:0", Some(("7d", "Total quota", Duration::from_days(7))), now)
	{
		out.push(w);
	}
	if let Some(rows) = p.get("limits").and_then(Value::as_array) {
		for row_value in rows {
			let row_obj = row_value.as_object().ok_or(UsageFetchError::Unavailable)?;
			let detail = row_obj
				.get("detail")
				.and_then(Value::as_object)
				.unwrap_or(row_obj);
			let window_obj = row_obj.get("window").and_then(Value::as_object);
			let duration = window_obj.and_then(duration);
			let id = duration.map_or_else(|| "default".to_owned(), canonical_id);
			let label = row_obj
				.get("name")
				.and_then(Value::as_str)
				.map(str::to_owned)
				.or_else(|| window_obj.and_then(duration_label))
				.unwrap_or_else(|| id.clone());
			let Some(mut w) = row(
				detail,
				&format!("kimi-code:{}", out.len()),
				duration.map(|d| (id.as_str(), label.as_str(), d)),
				now,
			) else {
				continue;
			};
			if let Some(explicit) = window_obj.and_then(|window| reset_time(window, now)) {
				w.resets_at = Some(explicit);
			}
			out.push(w);
		}
	}
	if out.is_empty() {
		Err(UsageFetchError::Unavailable)
	} else {
		Ok(out)
	}
}
fn row(
	data: &Map<String, Value>,
	id: &str,
	window: Option<(&str, &str, Duration)>,
	now: SystemTime,
) -> Option<UsageWindow> {
	let limit = data.get("limit").and_then(quantity);
	let remaining = data.get("remaining").and_then(quantity);
	let consumed = data
		.get("used")
		.and_then(quantity)
		.or_else(|| subtract(limit?, remaining?));
	if consumed.is_none() && limit.is_none() {
		return None;
	}
	let remaining = remaining.or_else(|| subtract(limit?, consumed?));
	let (l, r) = limit
		.zip(consumed)
		.unwrap_or((UsageQuantity::new(0, 0), UsageQuantity::new(0, 0)));
	let status = if limit.is_none() || l.units == 0 {
		UsageStatus::Unknown
	} else {
		let (l, u) = align(l, r)?;
		if u.units >= l.units {
			UsageStatus::Exhausted
		} else if u.units.saturating_mul(10) >= l.units.saturating_mul(9) {
			UsageStatus::Warning
		} else {
			UsageStatus::Ok
		}
	};
	let (window_id, label, duration) = window.unwrap_or_else(|| {
		("default", data.get("name").and_then(Value::as_str).unwrap_or("Quota"), Duration::ZERO)
	});
	Some(UsageWindow {
		id:          Str::new(id),
		kind:        UsageWindowKind::Quota,
		dimension:   sf!("quota"),
		label:       Some(Str::new(label)),
		scope:       Some(Str::new(window_id)),
		amount:      UsageAmount { unit: UsageUnit::Unknown, consumed, remaining, limit },
		status:      Some(status),
		duration:    (!duration.is_zero()).then_some(duration),
		resets_at:   reset_time(data, now),
		reset_label: None,
		notes:       Box::default(),
		source:      UsageSource::Provider,
		observed_at: now,
	})
}
fn duration(w: &Map<String, Value>) -> Option<Duration> {
	let n = w.get("duration").and_then(Value::as_u64)?;
	let unit = w
		.get("timeUnit")
		.and_then(Value::as_str)?
		.to_ascii_uppercase();
	let seconds = if unit.contains("MINUTE") {
		n * 60
	} else if unit.contains("HOUR") {
		n * 3600
	} else if unit.contains("DAY") {
		n * 86400
	} else if unit.contains("SECOND") {
		n
	} else {
		return None;
	};
	Some(Duration::from_secs(seconds))
}
fn duration_label(w: &Map<String, Value>) -> Option<String> {
	let n = w.get("duration")?.as_u64()?;
	let u = w.get("timeUnit")?.as_str()?.to_ascii_uppercase();
	Some(if u.contains("MINUTE") && n >= 60 && n.is_multiple_of(60) {
		format!("{}h limit", n / 60)
	} else if u.contains("MINUTE") {
		format!("{n}m limit")
	} else if u.contains("HOUR") {
		format!("{n}h limit")
	} else if u.contains("DAY") {
		format!("{n}d limit")
	} else {
		format!("{n}s limit")
	})
}
fn canonical_id(d: Duration) -> String {
	let s = d.as_secs();
	if s.is_multiple_of(86400) {
		format!("{}d", s / 86400)
	} else if s.is_multiple_of(3600) {
		format!("{}h", s / 3600)
	} else {
		format!("{}m", (s + 30) / 60)
	}
}
fn reset_time(m: &Map<String, Value>, now: SystemTime) -> Option<SystemTime> {
	for key in ["reset_at", "resetAt", "reset_time", "resetTime"] {
		if let Some(value) = m.get(key) {
			if let Some(text) = value.as_str() {
				if let Some(parsed) = parse_rfc3339(text) {
					return Some(parsed);
				}
				if let Ok(timestamp) = text.parse::<u64>() {
					return epoch(timestamp);
				}
			}
			if let Some(timestamp) = value.as_u64() {
				return epoch(timestamp);
			}
		}
	}
	for key in ["reset_in", "resetIn", "ttl", "window"] {
		if let Some(seconds) = m.get(key).and_then(Value::as_u64) {
			return now.checked_add(Duration::from_secs(seconds));
		}
	}
	None
}
fn epoch(n: u64) -> Option<SystemTime> {
	UNIX_EPOCH.checked_add(Duration::from_millis(if n < 1_000_000_000_000 { n * 1000 } else { n }))
}
fn quantity(v: &Value) -> Option<UsageQuantity> {
	let s = match v {
		Value::String(s) => s.clone(),
		Value::Number(n) => n.to_string(),
		_ => return None,
	};
	let (a, b) = s.split_once('.').unwrap_or((&s, ""));
	Some(UsageQuantity::new(format!("{a}{b}").parse().ok()?, b.len().try_into().ok()?))
}
fn align(a: UsageQuantity, b: UsageQuantity) -> Option<(UsageQuantity, UsageQuantity)> {
	let e = a.decimal_exponent.max(b.decimal_exponent);
	let f = |q: UsageQuantity| {
		q.units
			.checked_mul(10_u64.pow((e - q.decimal_exponent).into()))
			.map(|u| UsageQuantity::new(u, e))
	};
	Some((f(a)?, f(b)?))
}
fn subtract(a: UsageQuantity, b: UsageQuantity) -> Option<UsageQuantity> {
	let (a, b) = align(a, b)?;
	Some(UsageQuantity::new(a.units.checked_sub(b.units)?, a.decimal_exponent))
}

#[cfg(test)]
mod tests {
	use std::{collections::VecDeque, sync::Arc, time::SystemTime};

	use futures::{FutureExt as _, future::BoxFuture};
	use http::HeaderMap;
	use omp_core::SecretString;
	use parking_lot::Mutex;

	use super::KimiUsageFetcher;
	use crate::{
		auth::{OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse, OAuthTransportError},
		operation::usage::ConsoleUsageFetcher as _,
	};
	#[derive(Clone, Default)]
	struct Http {
		responses: Arc<Mutex<VecDeque<&'static str>>>,
		requests:  Arc<Mutex<Vec<(String, HeaderMap)>>>,
	}
	impl Http {
		fn new(body: &'static str) -> Self {
			Self { responses: Arc::new(Mutex::new([body].into())), requests: Arc::default() }
		}
	}
	impl OAuthHttpClient for Http {
		fn execute(
			&self,
			request: OAuthHttpRequest,
		) -> BoxFuture<'_, Result<OAuthHttpResponse, OAuthTransportError>> {
			let (_, url, headers, body) = request.into_parts();
			assert!(body.is_none());
			self.requests.lock().push((url.to_string(), headers));
			let response_body = self.responses.lock().pop_front().unwrap();
			async move {
				Ok(OAuthHttpResponse {
					status:  200,
					headers: HeaderMap::new(),
					body:    SecretString::from(response_body.to_owned()),
				})
			}
			.boxed()
		}
	}
	#[tokio::test]
	async fn reset_fallback_headers_and_canonical_windows() {
		let body = r#"{"usage":{"limit":"100","used":"28","remaining":"72","resetTime":"2026-07-21T07:43:35.355947Z"},"limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},"detail":{"limit":"100","remaining":"100","resetTime":"2026-07-18T05:43:35.355947Z"}},{"window":{"duration":7,"timeUnit":"TIME_UNIT_DAY"},"detail":{"limit":"100","remaining":"50"}},{"window":{"duration":90,"timeUnit":"TIME_UNIT_MINUTE"},"detail":{"limit":"100","remaining":"50"}}]}"#;
		let client = Arc::new(Http::new(body));
		let fetcher = KimiUsageFetcher::new(client.clone());
		let credentials =
			SecretString::from(r#"{"accessToken":"token","accountId":"acc-1"}"#.to_owned());
		let report = fetcher
			.fetch(Some(&credentials), SystemTime::now(), None)
			.await
			.unwrap();
		assert_eq!(report.account_meta.provider_account_id.as_deref(), Some("acc-1"));
		assert_eq!(
			report
				.windows
				.iter()
				.map(|window| window.scope.as_deref())
				.collect::<Vec<_>>(),
			[Some("7d"), Some("5h"), Some("7d"), Some("90m")]
		);
		assert_eq!(report.windows[1].duration.unwrap().as_secs(), 18000);
		assert_eq!(
			report.windows[1].resets_at,
			omp_core::parse_rfc3339("2026-07-18T05:43:35.355947Z")
		);
		let requests = client.requests.lock();
		assert_eq!(requests[0].0, "https://api.kimi.com/coding/v1/usages");
		assert_eq!(requests[0].1["authorization"].to_str().unwrap(), "Bearer token");
		for name in [
			"user-agent",
			"x-msh-platform",
			"x-msh-version",
			"x-msh-device-name",
			"x-msh-device-model",
			"x-msh-os-version",
			"x-msh-device-id",
		] {
			assert!(requests[0].1.contains_key(name), "missing {name}");
		}
		assert_eq!(requests[0].1["x-msh-device-id"].as_bytes().len(), 32);
	}
	#[tokio::test]
	async fn explicit_window_reset_is_authoritative() {
		let body = r#"{"limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE","resetTime":"2026-07-18T06:00:00.000Z"},"detail":{"limit":"100","remaining":"40","resetTime":"2026-07-18T05:43:35.355947Z"}}]}"#;
		let fetcher = KimiUsageFetcher::new(Arc::new(Http::new(body)));
		let credentials = SecretString::from("token".to_owned());
		let report = fetcher
			.fetch(Some(&credentials), SystemTime::now(), None)
			.await
			.unwrap();
		assert_eq!(report.windows[0].resets_at, omp_core::parse_rfc3339("2026-07-18T06:00:00.000Z"));
	}
}
