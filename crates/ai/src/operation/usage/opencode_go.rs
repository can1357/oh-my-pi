//! `OpenCode` Go quota retrieval.

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
	auth::{OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse as AuthOAuthHttpResponse},
	catalog::ProviderId,
	operation::usage::{
		ConsoleUsageFetcher, ConsoleUsageObservation, UsageCredentialRequirement, UsageFetchError,
	},
	receipt::UsageSource,
};

const PROVIDER: &str = "opencode-go";
const DEFAULT_BASE_URL: &str = "https://opencode.ai/zen/go";
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy)]
struct Descriptor {
	key:      &'static str,
	id:       &'static str,
	label:    &'static str,
	duration: Option<Duration>,
}

const WINDOWS: [Descriptor; 3] = [
	Descriptor {
		key:      "rolling",
		id:       "rolling-5h",
		label:    "5 Hour limit",
		duration: Some(Duration::from_hours(5)),
	},
	Descriptor {
		key:      "weekly",
		id:       "weekly",
		label:    "Weekly limit",
		duration: Some(Duration::from_days(7)),
	},
	Descriptor {
		key:      "monthly",
		id:       "monthly",
		label:    "Monthly limit",
		duration: None,
	},
];

/// Application-registered `OpenCode` Go usage fetcher.
#[derive(Clone)]
pub struct OpenCodeGoUsageFetcher {
	provider: ProviderId,
	http:     Arc<dyn OAuthHttpClient>,
	base_url: Str,
}

impl OpenCodeGoUsageFetcher {
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

impl ConsoleUsageFetcher for OpenCodeGoUsageFetcher {
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
			let key = credential.ok_or(UsageFetchError::Protocol)?.expose_secret();
			let url = format!("{}/v1/usage", self.base_url);
			let response = execute(self.http.as_ref(), request(&url, key)?, deadline).await?;
			if matches!(response.status, 401 | 403) {
				return Err(UsageFetchError::AuthRejected);
			}
			if !(200..300).contains(&response.status) {
				return Err(UsageFetchError::Unavailable);
			}
			let windows = parse_windows(response.body.expose_secret(), now)?;
			Ok(ConsoleUsageObservation {
				account_meta: UsageAccountMetadata::default(),
				plan: None,
				source_label: Some(sf!("opencode-go")),
				notes: Box::default(),
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

fn request(url: &str, key: &str) -> Result<OAuthHttpRequest, UsageFetchError> {
	let mut headers = HeaderMap::new();
	let mut authorization =
		HeaderValue::from_str(&format!("Bearer {key}")).map_err(|_| UsageFetchError::Protocol)?;
	authorization.set_sensitive(true);
	headers.insert(AUTHORIZATION, authorization);
	OAuthHttpRequest::new(Method::GET, url, headers, None).map_err(|_| UsageFetchError::Protocol)
}

async fn execute(
	http: &dyn OAuthHttpClient,
	request: OAuthHttpRequest,
	deadline: Option<Instant>,
) -> Result<AuthOAuthHttpResponse, UsageFetchError> {
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

fn parse_windows(body: &str, now: SystemTime) -> Result<Vec<UsageWindow>, UsageFetchError> {
	let payload: Value = serde_json::from_str(body).map_err(|_| UsageFetchError::Unavailable)?;
	let usage = payload
		.get("usage")
		.and_then(Value::as_object)
		.ok_or(UsageFetchError::Unavailable)?;
	WINDOWS
		.iter()
		.map(|descriptor| {
			let row = usage
				.get(descriptor.key)
				.and_then(Value::as_object)
				.ok_or(UsageFetchError::Unavailable)?;
			let percent = row
				.get("percent")
				.and_then(Value::as_f64)
				.filter(|value| value.is_finite() && (0.0..=100.0).contains(value))
				.ok_or(UsageFetchError::Unavailable)?;
			let state = row
				.get("status")
				.and_then(Value::as_str)
				.filter(|value| matches!(*value, "ok" | "rate-limited"))
				.ok_or(UsageFetchError::Unavailable)?;
			let resets_at = row
				.get("resetsAt")
				.and_then(Value::as_str)
				.and_then(parse_rfc3339)
				.ok_or(UsageFetchError::Unavailable)?;
			let consumed = decimal_quantity(percent).ok_or(UsageFetchError::Unavailable)?;
			let remaining = decimal_quantity(100.0 - percent).ok_or(UsageFetchError::Unavailable)?;
			let status = if state == "rate-limited" || percent >= 100.0 {
				UsageStatus::Exhausted
			} else if percent >= 80.0 {
				UsageStatus::Warning
			} else {
				UsageStatus::Ok
			};
			Ok(UsageWindow {
				id:          sf!(descriptor.id),
				kind:        UsageWindowKind::Quota,
				dimension:   sf!("percent"),
				label:       Some(sf!(descriptor.label)),
				scope:       Some(sf!("shared")),
				amount:      UsageAmount {
					unit:      UsageUnit::Percent,
					consumed:  Some(consumed),
					remaining: Some(remaining),
					limit:     Some(UsageQuantity::new(100, 0)),
				},
				status:      Some(status),
				duration:    descriptor.duration,
				resets_at:   Some(resets_at),
				reset_label: None,
				notes:       Box::default(),
				source:      UsageSource::Provider,
				observed_at: now,
			})
		})
		.collect()
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

#[cfg(test)]
mod tests {
	use std::{
		collections::VecDeque,
		sync::Arc,
		time::{Duration, SystemTime, UNIX_EPOCH},
	};

	use futures::{FutureExt as _, future::BoxFuture};
	use http::HeaderMap;
	use omp_core::SecretString;
	use parking_lot::Mutex;

	use super::OpenCodeGoUsageFetcher;
	use crate::{
		auth::{OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse, OAuthTransportError},
		operation::usage::{ConsoleUsageFetcher as _, UsageFetchError},
	};

	#[derive(Clone, Default)]
	struct Http {
		responses: Arc<Mutex<VecDeque<(u16, &'static str)>>>,
		requests:  Arc<Mutex<Vec<(String, HeaderMap)>>>,
	}
	impl Http {
		fn new(responses: impl IntoIterator<Item = (u16, &'static str)>) -> Self {
			Self {
				responses: Arc::new(Mutex::new(responses.into_iter().collect())),
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
			let (status, body) = self.responses.lock().pop_front().expect("response");
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
	fn now() -> SystemTime {
		UNIX_EPOCH + Duration::from_secs(1_700_000_000)
	}
	const BODY: &str = r#"{"usage":{"rolling":{"status":"ok","percent":85,"resetsAt":"2026-08-12T15:09:04.847Z"},"weekly":{"status":"ok","percent":8,"resetsAt":"2026-08-17T00:00:00.847Z"},"monthly":{"status":"rate-limited","percent":100,"resetsAt":"2026-08-19T00:31:53.847Z"}}}"#;

	#[tokio::test]
	async fn sends_expected_request_and_projects_all_windows() {
		let http = Arc::new(Http::new([(200, BODY)]));
		let fetcher = OpenCodeGoUsageFetcher::new(http.clone());
		let key = SecretString::from("sk-test".to_owned());
		let report = fetcher.fetch(Some(&key), now(), None).await.expect("usage");
		assert_eq!(
			report
				.windows
				.iter()
				.map(|w| (w.id.as_str(), w.scope.as_deref(), w.amount.consumed.unwrap().units))
				.collect::<Vec<_>>(),
			[
				("rolling-5h", Some("shared"), 85),
				("weekly", Some("shared"), 8),
				("monthly", Some("shared"), 100)
			]
		);
		assert_eq!(report.windows[0].status, Some(crate::answer::UsageStatus::Warning));
		assert_eq!(report.windows[2].status, Some(crate::answer::UsageStatus::Exhausted));
		assert_eq!(report.windows[0].duration, Some(Duration::from_secs(18_000)));
		assert_eq!(report.windows[2].duration, None);
		let requests = http.requests.lock();
		assert_eq!(requests[0].0, "https://opencode.ai/zen/go/v1/usage");
		assert_eq!(requests[0].1["authorization"].to_str().unwrap(), "Bearer sk-test");
		assert!(requests[0].1["authorization"].is_sensitive());
	}
	#[tokio::test]
	async fn normalizes_base_urls_and_maps_failures() {
		for base in ["https://opencode.ai/zen/go", "https://opencode.ai/zen/go/v1"] {
			let http = Arc::new(Http::new([(200, BODY)]));
			let fetcher = OpenCodeGoUsageFetcher::with_base_url(http.clone(), base);
			let key = SecretString::from("k".to_owned());
			fetcher.fetch(Some(&key), now(), None).await.unwrap();
			assert_eq!(http.requests.lock()[0].0, "https://opencode.ai/zen/go/v1/usage");
		}
		for status in [401, 403] {
			let http =
				Arc::new(Http::new([(status, r#"{"error":{"message":"subscription required"}}"#)]));
			let fetcher = OpenCodeGoUsageFetcher::new(http);
			let key = SecretString::from("k".to_owned());
			assert_eq!(
				fetcher.fetch(Some(&key), now(), None).await.unwrap_err(),
				UsageFetchError::AuthRejected
			);
		}
		let http = Arc::new(Http::new([(500, "")]));
		let fetcher = OpenCodeGoUsageFetcher::new(http);
		let key = SecretString::from("k".to_owned());
		assert_eq!(
			fetcher.fetch(Some(&key), now(), None).await.unwrap_err(),
			UsageFetchError::Unavailable
		);
	}
	#[tokio::test]
	async fn rejects_every_partial_or_malformed_payload() {
		for body in [
			r#"{"usage":{}}"#,
			r#"{"usage":{"rolling":{"status":"unknown","percent":12,"resetsAt":"2026-08-12T15:09:04.847Z"}}}"#,
			r#"{"usage":{"rolling":{"status":"ok","percent":101,"resetsAt":"not-a-timestamp"}}}"#,
			"{}",
		] {
			let http = Arc::new(Http::new([(200, body)]));
			let fetcher = OpenCodeGoUsageFetcher::new(http);
			let key = SecretString::from("k".to_owned());
			assert_eq!(
				fetcher.fetch(Some(&key), now(), None).await.unwrap_err(),
				UsageFetchError::Unavailable
			);
		}
	}
}
