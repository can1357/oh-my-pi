//! Umans coding-plan usage retrieval.

use std::{
	sync::Arc,
	time::{Duration, Instant, SystemTime},
};

use futures::FutureExt as _;
use http::{HeaderMap, HeaderValue, Method, header::AUTHORIZATION};
use omp_core::{ExposeSecret as _, SecretString, Str, parse_rfc3339, sf};
use serde_json::Value;
use tokio::time;

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

const PROVIDER: &str = "umans";
const DEFAULT_BASE_URL: &str = "https://api.code.umans.ai";
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// Application-registered Umans usage fetcher.
#[derive(Clone)]
pub struct UmansUsageFetcher {
	provider: ProviderId,
	http:     Arc<dyn OAuthHttpClient>,
	base_url: Str,
}
impl UmansUsageFetcher {
	/// Constructs a fetcher over the shared bounded HTTP client.
	pub fn new(http: Arc<dyn OAuthHttpClient>) -> Self {
		Self::with_base_url(http, DEFAULT_BASE_URL)
	}

	fn with_base_url(http: Arc<dyn OAuthHttpClient>, base_url: &str) -> Self {
		Self {
			provider: ProviderId::from(PROVIDER),
			http,
			base_url: Str::new(normalize_base_url(base_url)),
		}
	}
}
impl ConsoleUsageFetcher for UmansUsageFetcher {
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
			let (key, account_meta) =
				parse_credential(credential.ok_or(UsageFetchError::Protocol)?.expose_secret())?;
			let url = format!("{}/v1/usage", self.base_url);
			let response = execute(self.http.as_ref(), request(&url, &key)?, deadline).await?;
			if matches!(response.status, 401 | 403) {
				return Err(UsageFetchError::AuthRejected);
			}
			if !(200..300).contains(&response.status) {
				return Err(UsageFetchError::Unavailable);
			}
			let (plan, notes, windows) = parse_response(response.body.expose_secret(), now)?;
			Ok(ConsoleUsageObservation {
				account_meta,
				plan,
				source_label: Some(sf!("umans-usage")),
				notes,
				reset_credits: None,
				windows,
			})
		}
		.boxed()
	}
}
fn normalize_base_url(value: &str) -> &str {
	let value = value.trim().trim_end_matches('/');
	value
		.strip_suffix("/v1")
		.or_else(|| value.strip_suffix("/V1"))
		.unwrap_or(value)
}
fn parse_credential(raw: &str) -> Result<(String, UsageAccountMetadata), UsageFetchError> {
	if let Ok(value) = serde_json::from_str::<Value>(raw) {
		let key = value
			.get("apiKey")
			.or_else(|| value.get("token"))
			.and_then(Value::as_str)
			.ok_or(UsageFetchError::Protocol)?
			.to_owned();
		let str_field = |name| value.get(name).and_then(Value::as_str).map(Str::new);
		Ok((key, UsageAccountMetadata {
			provider_account_id: str_field("accountId"),
			email: str_field("email"),
			project_id: str_field("projectId"),
			..UsageAccountMetadata::default()
		}))
	} else if raw.is_empty() {
		Err(UsageFetchError::Protocol)
	} else {
		Ok((raw.to_owned(), UsageAccountMetadata::default()))
	}
}
fn request(url: &str, key: &str) -> Result<OAuthHttpRequest, UsageFetchError> {
	let mut headers = HeaderMap::new();
	let mut value =
		HeaderValue::from_str(&format!("Bearer {key}")).map_err(|_| UsageFetchError::Protocol)?;
	value.set_sensitive(true);
	headers.insert(AUTHORIZATION, value);
	OAuthHttpRequest::new(Method::GET, url, headers, None).map_err(|_| UsageFetchError::Protocol)
}
async fn execute(
	http: &dyn OAuthHttpClient,
	request: OAuthHttpRequest,
	deadline: Option<Instant>,
) -> Result<OAuthHttpResponse, UsageFetchError> {
	let timeout = deadline
		.map_or(HTTP_TIMEOUT, |end| end.saturating_duration_since(Instant::now()))
		.min(HTTP_TIMEOUT);
	if timeout.is_zero() {
		return Err(UsageFetchError::Unavailable);
	}
	time::timeout(timeout, http.execute(request))
		.await
		.map_err(|_| UsageFetchError::Unavailable)?
		.map_err(|_| UsageFetchError::Unavailable)
}
type ParsedResponse = (Option<Str>, Box<[Str]>, Vec<UsageWindow>);

fn parse_response(body: &str, now: SystemTime) -> Result<ParsedResponse, UsageFetchError> {
	let payload: Value = serde_json::from_str(body).map_err(|_| UsageFetchError::Unavailable)?;
	let plan = payload
		.pointer("/plan/display_name")
		.and_then(Value::as_str)
		.map(Str::new);
	let low = payload
		.pointer("/usage/priority/low")
		.and_then(Value::as_bool)
		== Some(true);
	let notes = if low {
		vec![sf!("Requests deprioritized after a rate-limit burst.")].into_boxed_slice()
	} else {
		Box::default()
	};
	let mut windows = Vec::with_capacity(3);
	// The 5h window is rolling (FIFO: each request ages out five hours after it
	// fired), but the payload still reports an absolute `resets_at` for the
	// current window epoch — surface it as an incremental countdown ("tick")
	// rather than a hard reset.
	let resets_at = payload
		.pointer("/window/resets_at")
		.and_then(Value::as_str)
		.and_then(parse_rfc3339);
	let request_limit = number(payload.pointer("/limits/requests/limit"));
	let hard_cap = number(payload.pointer("/limits/requests/hard_cap"));
	let raw_used = number(payload.pointer("/usage/requests_in_window"));
	let raw_remaining = number(payload.pointer("/usage/remaining_requests"));
	let weighted_used = number(payload.pointer("/usage/weighted_in_window"));
	let weighted_remaining = number(payload.pointer("/usage/weighted_remaining_requests"));
	if let (Some(used), Some(limit)) = (weighted_used.or(raw_used), request_limit) {
		let duration =
			number(payload.pointer("/limits/requests/window_seconds")).unwrap_or(5 * 60 * 60);
		let split = weighted_used.is_some() && hard_cap.is_some();
		windows.push(window(
			if split {
				"umans:requests:soft"
			} else {
				"umans:requests"
			},
			"requests",
			if split {
				"Requests (soft cap)"
			} else {
				"Requests (rolling 5h)"
			},
			Some("shared"),
			used,
			if weighted_used.is_some() {
				weighted_remaining
			} else {
				raw_remaining
			},
			limit,
			Some(Duration::from_secs(duration)),
			resets_at,
			now,
			!split,
		));
		if let (Some(raw_used), Some(hard_cap)) = (raw_used, hard_cap)
			&& weighted_used.is_some()
		{
			windows.push(window(
				"umans:requests:hard",
				"requests",
				"Requests (burst ceiling)",
				Some("shared"),
				raw_used,
				None,
				hard_cap,
				Some(Duration::from_secs(duration)),
				resets_at,
				now,
				true,
			));
		}
	}
	if let (Some(used), Some(limit)) = (
		number(payload.pointer("/usage/concurrent_sessions")),
		number(payload.pointer("/limits/concurrency/limit")),
	) {
		windows.push(window(
			"umans:concurrency",
			"concurrency",
			"Concurrency",
			Some("concurrency"),
			used,
			None,
			limit,
			None,
			None,
			now,
			true,
		));
	}
	if windows.is_empty() {
		Err(UsageFetchError::Unavailable)
	} else {
		Ok((plan, notes, windows))
	}
}
fn number(value: Option<&Value>) -> Option<u64> {
	value.and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
}
fn window(
	id: &'static str,
	dimension: &'static str,
	label: &'static str,
	scope: Option<&'static str>,
	used: u64,
	remaining: Option<u64>,
	limit: u64,
	duration: Option<Duration>,
	resets_at: Option<SystemTime>,
	now: SystemTime,
	allow_exhausted: bool,
) -> UsageWindow {
	let status = if limit == 0 {
		UsageStatus::Unknown
	} else if allow_exhausted && used >= limit {
		UsageStatus::Exhausted
	} else if used.saturating_mul(10) >= limit.saturating_mul(9) {
		UsageStatus::Warning
	} else {
		UsageStatus::Ok
	};
	UsageWindow {
		id: sf!(id),
		kind: UsageWindowKind::RateLimit,
		dimension: sf!(dimension),
		label: Some(sf!(label)),
		scope: scope.map(Str::new_static),
		amount: UsageAmount {
			unit:      UsageUnit::Requests,
			consumed:  Some(UsageQuantity::new(used, 0)),
			remaining: remaining.map(|v| UsageQuantity::new(v, 0)),
			limit:     Some(UsageQuantity::new(limit, 0)),
		},
		status: Some(status),
		duration,
		resets_at,
		reset_label: resets_at.is_some().then(|| sf!("tick")),
		notes: Box::default(),
		source: UsageSource::Provider,
		observed_at: now,
	}
}

#[cfg(test)]
mod tests {
	use std::{collections::VecDeque, sync::Arc, time::SystemTime};

	use futures::{FutureExt as _, future::BoxFuture};
	use http::HeaderMap;
	use omp_core::{SecretString, parse_rfc3339};
	use parking_lot::Mutex;

	use super::UmansUsageFetcher;
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
		fn new(items: impl IntoIterator<Item = (u16, &'static str)>) -> Self {
			Self {
				responses: Arc::new(Mutex::new(items.into_iter().collect())),
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
			let (status, body) = self.responses.lock().pop_front().unwrap();
			async move {
				Ok(OAuthHttpResponse {
					status,
					headers: HeaderMap::new(),
					body: SecretString::from(body.to_owned()),
				})
			}
			.boxed()
		}
	}
	const BODY: &str = r#"{"plan":{"display_name":"Code Pro"},"limits":{"requests":{"limit":200,"window_seconds":18000},"concurrency":{"limit":4}},"usage":{"requests_in_window":48,"remaining_requests":152,"concurrent_sessions":1,"priority":{"low":true}}}"#;
	#[tokio::test]
	async fn request_windows_notes_and_identity_match_contract() {
		let http = Arc::new(Http::new([(200, BODY)]));
		let fetcher = UmansUsageFetcher::new(http.clone());
		let key = SecretString::from(
			r#"{"apiKey":"sk-test","accountId":"acct-42","email":"dev@example.com"}"#.to_owned(),
		);
		let report = fetcher
			.fetch(Some(&key), SystemTime::now(), None)
			.await
			.unwrap();
		assert_eq!(report.plan.as_deref(), Some("Code Pro"));
		assert_eq!(report.account_meta.provider_account_id.as_deref(), Some("acct-42"));
		assert_eq!(report.account_meta.email.as_deref(), Some("dev@example.com"));
		assert_eq!(report.notes[0], "Requests deprioritized after a rate-limit burst.");
		assert_eq!(report.windows[0].resets_at, None);
		assert_eq!(report.windows[0].reset_label, None);
		assert_eq!(report.windows.len(), 2);
		assert_eq!(report.windows[0].amount.consumed.unwrap().units, 48);
		assert_eq!(report.windows[0].amount.remaining.unwrap().units, 152);
		assert_eq!(report.windows[0].duration.unwrap().as_secs(), 18000);
		assert_eq!(report.windows[0].status, Some(UsageStatus::Ok));
		assert_eq!(report.windows[1].amount.limit.unwrap().units, 4);
		let requests = http.requests.lock();
		assert_eq!(requests[0].0, "https://api.code.umans.ai/v1/usage");
		assert_eq!(requests[0].1["authorization"].to_str().unwrap(), "Bearer sk-test");
		assert!(requests[0].1["authorization"].is_sensitive());
	}
	#[tokio::test]
	async fn weighted_requests_drive_soft_cap_and_raw_requests_drive_burst_ceiling() {
		let http = Arc::new(Http::new([
			(
				200,
				r#"{"limits":{"requests":{"limit":500,"hard_cap":1000,"window_seconds":18000}},"window":{"resets_at":"2026-08-06T21:52:21.202174+00:00"},"usage":{"requests_in_window":838,"remaining_requests":0,"weighted_in_window":207,"weighted_remaining_requests":293}}"#,
			),
			(
				200,
				r#"{"limits":{"requests":{"limit":500,"hard_cap":1000,"window_seconds":18000}},"usage":{"requests_in_window":500,"remaining_requests":0,"weighted_in_window":500,"weighted_remaining_requests":0}}"#,
			),
		]));
		let fetcher = UmansUsageFetcher::new(http);
		let key = SecretString::from("k".to_owned());

		let headroom = fetcher
			.fetch(Some(&key), SystemTime::now(), None)
			.await
			.unwrap();
		let soft = headroom
			.windows
			.iter()
			.find(|window| window.id == "umans:requests:soft")
			.expect("weighted soft-cap window");
		assert_eq!(soft.amount.consumed.unwrap().units, 207);
		assert_eq!(soft.amount.remaining.unwrap().units, 293);
		assert_eq!(soft.status, Some(UsageStatus::Ok));
		// The rolling 5h window still exposes its absolute `resets_at` as an
		// incremental countdown for the status line.
		assert_eq!(soft.resets_at, parse_rfc3339("2026-08-06T21:52:21.202174+00:00"));
		assert_eq!(soft.reset_label.as_deref(), Some("tick"));
		let hard = headroom
			.windows
			.iter()
			.find(|window| window.id == "umans:requests:hard")
			.expect("raw burst-ceiling window");
		assert_eq!(hard.amount.consumed.unwrap().units, 838);
		assert_eq!(hard.amount.limit.unwrap().units, 1_000);
		assert_eq!(hard.status, Some(UsageStatus::Ok));
		assert_eq!(hard.resets_at, parse_rfc3339("2026-08-06T21:52:21.202174+00:00"));
		assert!(
			headroom
				.windows
				.iter()
				.all(|window| window.status != Some(UsageStatus::Exhausted))
		);

		let soft_cap = fetcher
			.fetch(Some(&key), SystemTime::now(), None)
			.await
			.unwrap();
		assert_eq!(
			soft_cap
				.windows
				.iter()
				.find(|window| window.id == "umans:requests:soft")
				.expect("weighted soft-cap window")
				.status,
			Some(UsageStatus::Warning)
		);
		assert!(
			soft_cap
				.windows
				.iter()
				.all(|window| window.status != Some(UsageStatus::Exhausted))
		);
	}
	#[tokio::test]
	async fn collapses_to_single_weighted_row_that_can_exhaust_without_burst_ceiling() {
		// Weighted counters present but `hard_cap` absent: without a burst
		// ceiling there is no hard row to defer exhaustion to, so the weighted
		// effective-request budget is the operative ceiling — the single row
		// must be able to report exhausted or a spent account could never
		// trigger the usage-aware fallback.
		let http = Arc::new(Http::new([
			(
				200,
				r#"{"limits":{"requests":{"limit":200,"window_seconds":18000}},"usage":{"requests_in_window":400,"remaining_requests":0,"weighted_in_window":200,"weighted_remaining_requests":0}}"#,
			),
			(
				200,
				r#"{"limits":{"requests":{"limit":200,"window_seconds":18000}},"usage":{"requests_in_window":300,"remaining_requests":0,"weighted_in_window":100,"weighted_remaining_requests":100}}"#,
			),
		]));
		let fetcher = UmansUsageFetcher::new(http);
		let key = SecretString::from("k".to_owned());

		let spent = fetcher
			.fetch(Some(&key), SystemTime::now(), None)
			.await
			.unwrap();
		// No soft/hard split without a reported burst ceiling.
		assert_eq!(spent.windows.len(), 1);
		let requests = &spent.windows[0];
		assert_eq!(requests.id, "umans:requests");
		// Weighted effective requests stay authoritative: raw 400 overshoots the
		// 200 limit, but it is the weighted 200/200 that reports exhausted.
		assert_eq!(requests.amount.consumed.unwrap().units, 200);
		assert_eq!(requests.amount.limit.unwrap().units, 200);
		assert_eq!(requests.status, Some(UsageStatus::Exhausted));

		// Same #7858 shape (raw usage over the soft limit, weighted headroom
		// remaining) but with no `hard_cap`: the weighted counter must still
		// decide, so raw burst traffic cannot fabricate an exhausted state even
		// when there is no hard row to buffer it.
		let headroom = fetcher
			.fetch(Some(&key), SystemTime::now(), None)
			.await
			.unwrap();
		let requests = &headroom.windows[0];
		assert_eq!(requests.id, "umans:requests");
		assert_eq!(requests.amount.consumed.unwrap().units, 100);
		assert_eq!(requests.amount.remaining.unwrap().units, 100);
		assert_eq!(requests.status, Some(UsageStatus::Ok));
		assert!(
			headroom
				.windows
				.iter()
				.all(|window| window.status != Some(UsageStatus::Exhausted))
		);
	}
	#[tokio::test]
	async fn normalizes_all_custom_base_url_forms() {
		for (base, expected) in [
			("https://custom.umans.example", "https://custom.umans.example/v1/usage"),
			("https://api.code.umans.ai/v1", "https://api.code.umans.ai/v1/usage"),
			("https://gateway.example/team/umans/v1", "https://gateway.example/team/umans/v1/usage"),
		] {
			let http = Arc::new(Http::new([(200, BODY)]));
			let fetcher = UmansUsageFetcher::with_base_url(http.clone(), base);
			let key = SecretString::from("k".to_owned());
			fetcher
				.fetch(Some(&key), SystemTime::now(), None)
				.await
				.unwrap();
			assert_eq!(http.requests.lock()[0].0, expected);
		}
	}
	#[tokio::test]
	async fn auth_and_transient_failures_are_distinct() {
		for status in [401, 403] {
			let fetcher = UmansUsageFetcher::new(Arc::new(Http::new([(status, "")])));
			let key = SecretString::from("k".to_owned());
			assert_eq!(
				fetcher
					.fetch(Some(&key), SystemTime::now(), None)
					.await
					.unwrap_err(),
				UsageFetchError::AuthRejected
			);
		}
		let fetcher = UmansUsageFetcher::new(Arc::new(Http::new([(500, "")])));
		let key = SecretString::from("k".to_owned());
		assert_eq!(
			fetcher
				.fetch(Some(&key), SystemTime::now(), None)
				.await
				.unwrap_err(),
			UsageFetchError::Unavailable
		);
	}
}
