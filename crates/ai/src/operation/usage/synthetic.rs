//! Synthetic quota retrieval.

use std::{
	sync::Arc,
	time::{Duration, Instant, SystemTime},
};

use futures::FutureExt as _;
use http::{
	HeaderMap, HeaderValue, Method,
	header::{AUTHORIZATION, CONTENT_TYPE},
};
use omp_core::{ExposeSecret as _, SecretString, Str, parse_rfc3339, sf};
use serde_json::Value;
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
const PROVIDER: &str = "synthetic";
const QUOTAS_URL: &str = "https://api.synthetic.new/v2/quotas";
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// Application-registered Synthetic usage fetcher.
#[derive(Clone)]
pub struct SyntheticUsageFetcher {
	provider: ProviderId,
	http:     Arc<dyn OAuthHttpClient>,
}
impl SyntheticUsageFetcher {
	/// Constructs a fetcher over the shared bounded HTTP client.
	pub fn new(http: Arc<dyn OAuthHttpClient>) -> Self {
		Self { provider: ProviderId::from(PROVIDER), http }
	}
}
impl ConsoleUsageFetcher for SyntheticUsageFetcher {
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
			let (key, account_meta) = parse_credential(raw)?;
			let response = execute(self.http.as_ref(), request(&key)?, deadline).await?;
			if !(200..300).contains(&response.status) {
				return Err(UsageFetchError::Unavailable);
			}
			let windows = parse_windows(response.body.expose_secret(), now)?;
			Ok(ConsoleUsageObservation {
				account_meta,
				plan: None,
				source_label: Some(sf!("synthetic-quotas")),
				notes: Box::default(),
				reset_credits: None,
				windows,
			})
		}
		.boxed()
	}
}
fn parse_credential(raw: &str) -> Result<(String, UsageAccountMetadata), UsageFetchError> {
	if let Ok(v) = serde_json::from_str::<Value>(raw) {
		let key = v
			.get("apiKey")
			.or_else(|| v.get("token"))
			.and_then(Value::as_str)
			.ok_or(UsageFetchError::Protocol)?
			.to_owned();
		let field = |n| v.get(n).and_then(Value::as_str).map(Str::new);
		Ok((key, UsageAccountMetadata {
			provider_account_id: field("accountId"),
			email: field("email"),
			project_id: field("projectId"),
			..UsageAccountMetadata::default()
		}))
	} else if raw.is_empty() {
		Err(UsageFetchError::Protocol)
	} else {
		Ok((raw.to_owned(), UsageAccountMetadata::default()))
	}
}
fn request(key: &str) -> Result<OAuthHttpRequest, UsageFetchError> {
	let mut h = HeaderMap::new();
	let mut a =
		HeaderValue::from_str(&format!("Bearer {key}")).map_err(|_| UsageFetchError::Protocol)?;
	a.set_sensitive(true);
	h.insert(AUTHORIZATION, a);
	h.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
	OAuthHttpRequest::new(Method::GET, QUOTAS_URL, h, None).map_err(|_| UsageFetchError::Protocol)
}
async fn execute(
	http: &dyn OAuthHttpClient,
	request: OAuthHttpRequest,
	deadline: Option<Instant>,
) -> Result<AuthOAuthHttpResponse, UsageFetchError> {
	let timeout = deadline
		.map_or(HTTP_TIMEOUT, |e| e.saturating_duration_since(Instant::now()))
		.min(HTTP_TIMEOUT);
	if timeout.is_zero() {
		return Err(UsageFetchError::Unavailable);
	}
	time::timeout(timeout, http.execute(request))
		.await
		.map_err(|_| UsageFetchError::Unavailable)?
		.map_err(|_| UsageFetchError::Unavailable)
}
fn parse_windows(body: &str, now: SystemTime) -> Result<Vec<UsageWindow>, UsageFetchError> {
	let p: Value = serde_json::from_str(body).map_err(|_| UsageFetchError::Unavailable)?;
	let mut out = Vec::with_capacity(2);
	if let Some(r) = p.get("rollingFiveHourLimit").and_then(Value::as_object)
		&& let (Some(max), Some(remaining)) = (uint(r.get("max")), uint(r.get("remaining")))
	{
		let used = max.saturating_sub(remaining);
		let status = if r.get("limited").and_then(Value::as_bool) == Some(true) {
			UsageStatus::Exhausted
		} else {
			status(used, max, 90)
		};
		out.push(UsageWindow {
			id:          sf!("synthetic:requests:5h"),
			kind:        UsageWindowKind::RateLimit,
			dimension:   sf!("requests"),
			label:       Some(sf!("Synthetic Requests")),
			scope:       Some(sf!("shared")),
			amount:      UsageAmount {
				unit:      UsageUnit::Requests,
				consumed:  Some(UsageQuantity::new(used, 0)),
				remaining: Some(UsageQuantity::new(remaining, 0)),
				limit:     Some(UsageQuantity::new(max, 0)),
			},
			status:      Some(status),
			duration:    Some(Duration::from_hours(5)),
			resets_at:   r
				.get("nextTickAt")
				.and_then(Value::as_str)
				.and_then(parse_rfc3339),
			reset_label: Some(sf!("tick")),
			notes:       Box::default(),
			source:      UsageSource::Provider,
			observed_at: now,
		});
	}
	if let Some(w) = p.get("weeklyTokenLimit").and_then(Value::as_object) {
		let max = w
			.get("maxCredits")
			.and_then(Value::as_str)
			.and_then(dollars);
		let remaining = w
			.get("remainingCredits")
			.and_then(Value::as_str)
			.and_then(dollars);
		let percent_remaining = w
			.get("percentRemaining")
			.and_then(Value::as_f64)
			.filter(|v| v.is_finite() && (0.0..=100.0).contains(v));
		if let Some(percent_remaining) = percent_remaining {
			let consumed_percent = 100.0 - percent_remaining;
			let consumed = max.and_then(|q| multiply_decimal(q, consumed_percent / 100.0));
			let _ = w
				.get("nextRegenCredits")
				.and_then(Value::as_str)
				.and_then(dollars);
			out.push(UsageWindow {
				id:          sf!("synthetic:usd:7d"),
				kind:        UsageWindowKind::Quota,
				dimension:   sf!("credits"),
				label:       Some(sf!("Synthetic Credits")),
				scope:       Some(sf!("shared")),
				amount:      UsageAmount { unit: UsageUnit::Usd, consumed, remaining, limit: max },
				status:      Some(if consumed_percent >= 100.0 {
					UsageStatus::Exhausted
				} else if consumed_percent >= 90.0 {
					UsageStatus::Warning
				} else {
					UsageStatus::Ok
				}),
				duration:    Some(Duration::from_days(7)),
				resets_at:   w
					.get("nextRegenAt")
					.and_then(Value::as_str)
					.and_then(parse_rfc3339),
				reset_label: Some(sf!("regen")),
				notes:       Box::default(),
				source:      UsageSource::Provider,
				observed_at: now,
			});
		}
	}
	if out.is_empty() {
		Err(UsageFetchError::Unavailable)
	} else {
		Ok(out)
	}
}
fn uint(v: Option<&Value>) -> Option<u64> {
	v.and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
}
const fn status(used: u64, limit: u64, warning: u64) -> UsageStatus {
	if limit == 0 {
		UsageStatus::Unknown
	} else if used >= limit {
		UsageStatus::Exhausted
	} else if used.saturating_mul(100) >= limit.saturating_mul(warning) {
		UsageStatus::Warning
	} else {
		UsageStatus::Ok
	}
}
fn dollars(v: &str) -> Option<UsageQuantity> {
	decimal(v.strip_prefix('$').unwrap_or(v))
}
fn decimal(v: &str) -> Option<UsageQuantity> {
	let (whole, fraction) = v.split_once('.').unwrap_or((v, ""));
	let units = format!("{whole}{fraction}").parse().ok()?;
	Some(UsageQuantity::new(units, fraction.len().try_into().ok()?))
}
fn quantity_f64(q: UsageQuantity) -> f64 {
	q.units as f64 / 10_u64.pow(q.decimal_exponent.into()) as f64
}
fn multiply_decimal(q: UsageQuantity, multiplier: f64) -> Option<UsageQuantity> {
	decimal(
		format!("{:.6}", quantity_f64(q) * multiplier)
			.trim_end_matches('0')
			.trim_end_matches('.'),
	)
}

#[cfg(test)]
mod tests {
	use std::{collections::VecDeque, sync::Arc, time::SystemTime};

	use futures::{FutureExt as _, future::BoxFuture};
	use http::HeaderMap;
	use omp_core::SecretString;
	use parking_lot::Mutex;

	use super::SyntheticUsageFetcher;
	use crate::{
		answer::UsageStatus,
		auth::{OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse, OAuthTransportError},
		operation::usage::{ConsoleUsageFetcher as _, UsageFetchError},
	};
	#[derive(Clone, Default)]
	struct Http {
		responses: Arc<Mutex<VecDeque<(u16, &'static str)>>>,
		requests:  Arc<Mutex<Vec<(String, HeaderMap)>>>,
	}
	impl Http {
		fn new(r: impl IntoIterator<Item = (u16, &'static str)>) -> Self {
			Self {
				responses: Arc::new(Mutex::new(r.into_iter().collect())),
				requests:  Arc::default(),
			}
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
			let (status, response_body) = self.responses.lock().pop_front().unwrap();
			async move {
				Ok(OAuthHttpResponse {
					status,
					headers: HeaderMap::new(),
					body: SecretString::from(response_body.to_owned()),
				})
			}
			.boxed()
		}
	}
	const BODY: &str = r#"{"subscription":{"limit":500},"rollingFiveHourLimit":{"nextTickAt":"2026-07-10T06:46:05.000Z","tickPercent":0.05,"remaining":500,"max":500,"limited":false},"weeklyTokenLimit":{"nextRegenAt":"2026-07-10T08:17:04.000Z","percentRemaining":7.615,"maxCredits":"$24.00","remainingCredits":"$1.82","nextRegenCredits":"$0.48"}}"#;
	#[tokio::test]
	async fn exact_two_windows_and_wire_request() {
		let http = Arc::new(Http::new([(200, BODY)]));
		let f = SyntheticUsageFetcher::new(http.clone());
		let k = SecretString::from("sk-test".to_owned());
		let r = f.fetch(Some(&k), SystemTime::now(), None).await.unwrap();
		assert_eq!(r.windows.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), [
			"synthetic:requests:5h",
			"synthetic:usd:7d"
		]);
		assert_eq!(r.windows[0].amount.consumed.unwrap().units, 0);
		assert_eq!(r.windows[0].status, Some(UsageStatus::Ok));
		assert!(r.windows[0].notes.is_empty());
		assert_eq!(r.windows[0].reset_label.as_deref(), Some("tick"));
		assert_eq!(r.windows[1].amount.limit.unwrap(), crate::answer::UsageQuantity::new(2400, 2));
		assert_eq!(r.windows[1].amount.remaining.unwrap(), crate::answer::UsageQuantity::new(182, 2));
		assert_eq!(r.windows[1].status, Some(UsageStatus::Warning));
		assert!(r.windows[1].notes.is_empty());
		assert_eq!(r.windows[1].reset_label.as_deref(), Some("regen"));
		let q = http.requests.lock();
		assert_eq!(q[0].0, "https://api.synthetic.new/v2/quotas");
		assert_eq!(q[0].1["authorization"].to_str().unwrap(), "Bearer sk-test");
		assert!(q[0].1["authorization"].is_sensitive());
	}
	#[tokio::test]
	async fn rejects_non_quota_and_http_failures_and_honors_limited() {
		for (body, error) in [
			(r#"{"subscription":{}}"#, UsageFetchError::Unavailable),
			("{}", UsageFetchError::Unavailable),
			("not json", UsageFetchError::Unavailable),
		] {
			let f = SyntheticUsageFetcher::new(Arc::new(Http::new([(200, body)])));
			let k = SecretString::from("k".to_owned());
			assert_eq!(
				f.fetch(Some(&k), SystemTime::now(), None)
					.await
					.unwrap_err(),
				error
			);
		}
		let body = r#"{"rollingFiveHourLimit":{"remaining":0,"max":500,"limited":true}}"#;
		let f = SyntheticUsageFetcher::new(Arc::new(Http::new([(200, body)])));
		let k = SecretString::from("k".to_owned());
		assert_eq!(
			f.fetch(Some(&k), SystemTime::now(), None)
				.await
				.unwrap()
				.windows[0]
				.status,
			Some(UsageStatus::Exhausted)
		);
		let f = SyntheticUsageFetcher::new(Arc::new(Http::new([(401, "")])));
		assert_eq!(
			f.fetch(Some(&k), SystemTime::now(), None)
				.await
				.unwrap_err(),
			UsageFetchError::Unavailable
		);
	}
}
