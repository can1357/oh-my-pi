//! ZAI quota retrieval.

use std::{
	sync::Arc,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures::FutureExt as _;
use http::{
	HeaderMap, HeaderValue, Method,
	header::{AUTHORIZATION, CONTENT_TYPE, USER_AGENT},
};
use omp_core::{ExposeSecret as _, SecretString, Str, format_rfc3339, sf};
use serde_json::{Map, Value};
use tokio::time;
use url::Url;

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

const PROVIDER: &str = "zai";
const BASE: &str = "https://api.z.ai";
const TIMEOUT: Duration = Duration::from_secs(10);
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Application-registered ZAI usage fetcher.
#[derive(Clone)]
pub struct ZaiUsageFetcher {
	provider: ProviderId,
	http:     Arc<dyn OAuthHttpClient>,
	base_url: Str,
}

impl ZaiUsageFetcher {
	/// Constructs a fetcher over the shared bounded HTTP client.
	pub fn new(http: Arc<dyn OAuthHttpClient>) -> Self {
		Self::with_base_url(http, BASE)
	}

	fn with_base_url(http: Arc<dyn OAuthHttpClient>, base: &str) -> Self {
		let origin = Url::parse(base.trim())
			.ok()
			.map_or_else(|| BASE.to_owned(), |url| url.origin().ascii_serialization());
		Self { provider: ProviderId::from(PROVIDER), http, base_url: Str::new(origin) }
	}
}

impl ConsoleUsageFetcher for ZaiUsageFetcher {
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
			let (token, account_meta) =
				credential_parts(credential.ok_or(UsageFetchError::Protocol)?.expose_secret())?;
			let quota_url = format!("{}/api/monitor/usage/quota/limit", self.base_url);
			let response = execute(self.http.as_ref(), request(&quota_url, &token)?, deadline).await?;
			if !(200..300).contains(&response.status) {
				return Err(UsageFetchError::Unavailable);
			}
			let (windows, plan) = parse(response.body.expose_secret(), now)?;

			let start = now
				.checked_sub(Duration::from_days(7))
				.unwrap_or(UNIX_EPOCH);
			let range_url = format!(
				"{}/api/monitor/usage/model-usage?startTime={}&endTime={}",
				self.base_url,
				encode_time(start),
				encode_time(now)
			);
			let _ = execute(self.http.as_ref(), request(&range_url, &token)?, deadline).await;

			Ok(ConsoleUsageObservation {
				account_meta,
				plan,
				source_label: Some(sf!("zai-monitor")),
				notes: Box::default(),
				reset_credits: None,
				windows,
			})
		}
		.boxed()
	}
}

fn credential_parts(raw: &str) -> Result<(String, UsageAccountMetadata), UsageFetchError> {
	if let Ok(value) = serde_json::from_str::<Value>(raw) {
		let token = value
			.get("accessToken")
			.or_else(|| value.get("apiKey"))
			.or_else(|| value.get("token"))
			.and_then(Value::as_str)
			.ok_or(UsageFetchError::Protocol)?
			.to_owned();
		let field = |name| value.get(name).and_then(Value::as_str).map(Str::new);
		Ok((token, UsageAccountMetadata {
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

fn request(url: &str, token: &str) -> Result<OAuthHttpRequest, UsageFetchError> {
	let mut headers = HeaderMap::new();
	let mut authorization = HeaderValue::from_str(token).map_err(|_| UsageFetchError::Protocol)?;
	authorization.set_sensitive(true);
	headers.insert(AUTHORIZATION, authorization);
	headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
	headers.insert(
		USER_AGENT,
		HeaderValue::from_str(&format!("omp/{VERSION}")).map_err(|_| UsageFetchError::Protocol)?,
	);
	OAuthHttpRequest::new(Method::GET, url, headers, None).map_err(|_| UsageFetchError::Protocol)
}

async fn execute(
	http: &dyn OAuthHttpClient,
	request: OAuthHttpRequest,
	deadline: Option<Instant>,
) -> Result<OAuthHttpResponse, UsageFetchError> {
	let timeout_duration = deadline
		.map_or(TIMEOUT, |end| end.saturating_duration_since(Instant::now()))
		.min(TIMEOUT);
	if timeout_duration.is_zero() {
		return Err(UsageFetchError::Unavailable);
	}
	time::timeout(timeout_duration, http.execute(request))
		.await
		.map_err(|_| UsageFetchError::Unavailable)?
		.map_err(|_| UsageFetchError::Unavailable)
}

fn encode_time(time: SystemTime) -> String {
	let mut value = format_rfc3339(time);
	value.pop();
	value.replace('T', "%2B").replace(':', "%3A")
}

fn parse(body: &str, now: SystemTime) -> Result<(Vec<UsageWindow>, Option<Str>), UsageFetchError> {
	let payload: Value = serde_json::from_str(body).map_err(|_| UsageFetchError::Unavailable)?;
	if payload.get("success").and_then(Value::as_bool) != Some(true) {
		return Err(UsageFetchError::Unavailable);
	}
	let plan = payload
		.pointer("/data/level")
		.and_then(Value::as_str)
		.filter(|level| !level.trim().is_empty())
		.map(Str::new);
	let rows = payload
		.pointer("/data/limits")
		.and_then(Value::as_array)
		.ok_or(UsageFetchError::Unavailable)?;
	let mut windows = Vec::with_capacity(rows.len());
	for row in rows {
		let row = row.as_object().ok_or(UsageFetchError::Unavailable)?;
		let kind = row
			.get("type")
			.and_then(Value::as_str)
			.ok_or(UsageFetchError::Unavailable)?;
		let (window_id, window_label, duration) = window_descriptor(row);
		let (id, label, scope, unit, dimension) = match kind {
			"TOKENS_LIMIT" => (
				format!("zai:tokens:{window_id}"),
				format!("ZAI {window_label} Token Quota"),
				"shared".to_owned(),
				UsageUnit::Tokens,
				"tokens",
			),
			"TIME_LIMIT" if has_zread_features(row) => (
				format!("zai:features:zread:{window_id}"),
				"ZAI Zread Quota".to_owned(),
				"zread".to_owned(),
				UsageUnit::Requests,
				"requests",
			),
			"TIME_LIMIT" => (
				format!("zai:requests:{window_id}"),
				"ZAI Request Quota".to_owned(),
				"shared".to_owned(),
				UsageUnit::Requests,
				"requests",
			),
			"CREDIT_LIMIT" => (
				format!("zai:credits:{window_id}"),
				format!("ZAI {window_label} Credit Quota"),
				"shared".to_owned(),
				UsageUnit::Credits,
				"credits",
			),
			_ => continue,
		};
		let consumed = row.get("currentValue").and_then(quantity);
		let limit = row.get("usage").and_then(quantity);
		let remaining = row.get("remaining").and_then(quantity);
		let percentage = row
			.get("percentage")
			.and_then(Value::as_f64)
			.filter(|value| value.is_finite() && *value >= 0.0);
		let percentage = if unit == UsageUnit::Credits {
			consumed
				.zip(limit)
				.and_then(|(consumed, limit)| quantity_ratio(consumed, limit))
				.map(|fraction| fraction * 100.0)
				.or(percentage)
		} else {
			percentage
		};
		let status = percentage.map_or(UsageStatus::Unknown, |percentage| {
			if percentage >= 100.0 {
				UsageStatus::Exhausted
			} else if percentage >= 90.0 {
				UsageStatus::Warning
			} else {
				UsageStatus::Ok
			}
		});
		windows.push(UsageWindow {
			id: Str::new(id),
			kind: UsageWindowKind::Quota,
			dimension: sf!(dimension),
			label: Some(Str::new(label)),
			scope: Some(Str::new(scope)),
			amount: UsageAmount { unit, consumed, remaining, limit },
			status: Some(status),
			duration,
			resets_at: row.get("nextResetTime").and_then(timestamp),
			reset_label: None,
			notes: Box::default(),
			source: UsageSource::Provider,
			observed_at: now,
		});
	}
	if windows.is_empty() {
		Err(UsageFetchError::Unavailable)
	} else {
		Ok((windows, plan))
	}
}

fn quantity_ratio(consumed: UsageQuantity, limit: UsageQuantity) -> Option<f64> {
	if limit.units == 0 {
		return None;
	}
	let consumed_scale = 10_f64.powi(i32::from(consumed.decimal_exponent));
	let limit_scale = 10_f64.powi(i32::from(limit.decimal_exponent));
	let ratio = (consumed.units as f64 / consumed_scale) / (limit.units as f64 / limit_scale);
	ratio.is_finite().then_some(ratio)
}

fn window_descriptor(row: &Map<String, Value>) -> (String, String, Option<Duration>) {
	let number = row
		.get("number")
		.and_then(Value::as_u64)
		.filter(|number| *number > 0)
		.unwrap_or(1);
	match row.get("unit").and_then(Value::as_u64).unwrap_or(0) {
		3 => (
			format!("{number}h"),
			format!("{number} Hour{}", if number == 1 { "" } else { "s" }),
			Some(Duration::from_secs(number * 3_600)),
		),
		4 => (
			format!("{number}d"),
			format!("{number} Day{}", if number == 1 { "" } else { "s" }),
			Some(Duration::from_secs(number * 86_400)),
		),
		5 => (
			format!("{number}mo"),
			if number == 1 {
				"Monthly".to_owned()
			} else {
				format!("{number} Months")
			},
			Some(Duration::from_secs(number * 30 * 86_400)),
		),
		6 => ("1w".to_owned(), "Weekly".to_owned(), Some(Duration::from_days(7))),
		unit => (format!("{number}u{unit}"), "Quota".to_owned(), None),
	}
}

fn has_zread_features(row: &Map<String, Value>) -> bool {
	let Some(details) = row.get("usageDetails").and_then(Value::as_array) else {
		return false;
	};
	["search-prime", "web-reader", "zread"]
		.into_iter()
		.all(|name| {
			details
				.iter()
				.any(|value| value.get("modelCode").and_then(Value::as_str) == Some(name))
		})
}

fn timestamp(value: &Value) -> Option<SystemTime> {
	let timestamp = value.as_u64().or_else(|| value.as_str()?.parse().ok())?;
	UNIX_EPOCH.checked_add(Duration::from_millis(if timestamp < 1_000_000_000_000 {
		timestamp * 1_000
	} else {
		timestamp
	}))
}

fn quantity(value: &Value) -> Option<UsageQuantity> {
	let text = match value {
		Value::Number(number) => number.to_string(),
		Value::String(text) => text.clone(),
		_ => return None,
	};
	let (whole, fraction) = text.split_once('.').unwrap_or((&text, ""));
	Some(UsageQuantity::new(
		format!("{whole}{fraction}").parse().ok()?,
		fraction.len().try_into().ok()?,
	))
}

#[cfg(test)]
mod tests {
	use std::{
		collections::VecDeque,
		sync::Arc,
		time::{Duration, UNIX_EPOCH},
	};

	use futures::{FutureExt as _, future::BoxFuture};
	use http::HeaderMap;
	use omp_core::SecretString;
	use parking_lot::Mutex;

	use super::ZaiUsageFetcher;
	use crate::{
		answer::{UsageStatus, UsageUnit},
		auth::{OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse, OAuthTransportError},
		operation::usage::ConsoleUsageFetcher as _,
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
			let (status, body) = self
				.responses
				.lock()
				.pop_front()
				.expect("scripted response");
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

	const BODY: &str = r#"{"success":true,"data":{"limits":[{"type":"TIME_LIMIT","usage":100,"currentValue":0,"percentage":0,"remaining":100,"nextResetTime":1784547608994,"unit":5,"number":1,"usageDetails":[{"modelCode":"search-prime"},{"modelCode":"web-reader"},{"modelCode":"zread"}]},{"type":"TOKENS_LIMIT","percentage":82,"nextResetTime":1782656863894,"unit":3,"number":5},{"type":"TOKENS_LIMIT","percentage":38,"nextResetTime":1783165208993,"unit":6,"number":7}]}}"#;
	const CREDIT_ONLY_BODY: &str = r#"{"success":true,"data":{"level":"pro","limits":[{"type":"CREDIT_LIMIT","usage":12000,"currentValue":11400,"remaining":600,"percentage":11,"nextResetTime":1787804173065,"unit":3,"number":5},{"type":"CREDIT_LIMIT","usage":60000,"currentValue":2254,"remaining":57746,"percentage":3,"nextResetTime":1788223121997,"unit":6,"number":1}]}}"#;
	const MIXED_BODY: &str = r#"{"success":true,"data":{"level":"max","limits":[{"type":"TOKENS_LIMIT","percentage":82,"nextResetTime":1787804173065,"unit":3,"number":5},{"type":"CREDIT_LIMIT","usage":12000,"currentValue":1438,"remaining":10562,"percentage":11,"nextResetTime":1787804173065,"unit":3,"number":5},{"type":"TIME_LIMIT","usage":100,"currentValue":4,"remaining":96,"percentage":4,"nextResetTime":1788223121997,"unit":6,"number":1}]}}"#;

	#[tokio::test]
	async fn auth_headers_two_requests_identity_and_window_projection() {
		let http = Arc::new(Http::new([(200, BODY), (200, "{}")]));
		let fetcher = ZaiUsageFetcher::new(http.clone());
		let credential = SecretString::from(
			r#"{"accessToken":"minted-id.minted-secret","accountId":"acc-1"}"#.to_owned(),
		);
		let now = UNIX_EPOCH + Duration::from_secs(1_784_000_000);
		let report = fetcher
			.fetch(Some(&credential), now, None)
			.await
			.expect("usage report");
		assert_eq!(report.account_meta.provider_account_id.as_deref(), Some("acc-1"));
		assert_eq!(
			report
				.windows
				.iter()
				.map(|window| (
					window.id.as_str(),
					window.scope.as_deref(),
					window.duration.expect("window duration").as_millis(),
				))
				.collect::<Vec<_>>(),
			[
				("zai:features:zread:1mo", Some("zread"), 2_592_000_000),
				("zai:tokens:5h", Some("shared"), 18_000_000),
				("zai:tokens:1w", Some("shared"), 604_800_000),
			]
		);
		assert_eq!(report.windows[0].label.as_deref(), Some("ZAI Zread Quota"));
		assert_eq!(report.windows[1].label.as_deref(), Some("ZAI 5 Hours Token Quota"));
		assert_eq!(report.windows[2].label.as_deref(), Some("ZAI Weekly Token Quota"));
		let requests = http.requests.lock();
		assert_eq!(requests[0].0, "https://api.z.ai/api/monitor/usage/quota/limit");
		assert!(
			requests[1]
				.0
				.contains("/api/monitor/usage/model-usage?startTime=")
		);
		for request in requests.iter() {
			assert_eq!(
				request.1["authorization"].to_str().expect("authorization"),
				"minted-id.minted-secret"
			);
			assert!(request.1["authorization"].is_sensitive());
			assert_eq!(request.1["content-type"], "application/json");
		}
	}

	#[tokio::test]
	async fn api_key_scalar_and_custom_url_origin_are_supported() {
		let http = Arc::new(Http::new([(200, BODY), (200, "{}")]));
		let fetcher =
			ZaiUsageFetcher::with_base_url(http.clone(), "https://proxy.example/api/anthropic");
		let credential = SecretString::from("api-key".to_owned());
		fetcher
			.fetch(Some(&credential), UNIX_EPOCH + Duration::from_secs(1_784_000_000), None)
			.await
			.expect("usage report");
		assert!(
			http.requests.lock()[0]
				.0
				.starts_with("https://proxy.example/api/monitor/")
		);
	}

	#[tokio::test]
	async fn credit_only_response_surfaces_windows_and_plan() {
		let http = Arc::new(Http::new([(200, CREDIT_ONLY_BODY), (200, "{}")]));
		let fetcher = ZaiUsageFetcher::new(http);
		let credential = SecretString::from("api-key".to_owned());
		let report = fetcher
			.fetch(Some(&credential), UNIX_EPOCH + Duration::from_secs(1_784_000_000), None)
			.await
			.expect("credit-only usage report");

		assert_eq!(report.plan.as_deref(), Some("pro"));
		assert_eq!(
			report
				.windows
				.iter()
				.map(|window| window.id.as_str())
				.collect::<Vec<_>>(),
			["zai:credits:5h", "zai:credits:1w"]
		);
		assert!(
			report
				.windows
				.iter()
				.all(|window| window.amount.unit == UsageUnit::Credits)
		);
		assert_eq!(report.windows[0].amount.consumed.expect("consumed").units, 11_400);
		assert_eq!(report.windows[0].amount.limit.expect("limit").units, 12_000);
		assert_eq!(report.windows[0].amount.remaining.expect("remaining").units, 600);
		assert_eq!(report.windows[0].status, Some(UsageStatus::Warning));
		assert_eq!(report.windows[1].label.as_deref(), Some("ZAI Weekly Credit Quota"));
	}

	#[tokio::test]
	async fn mixed_response_preserves_each_meter() {
		let http = Arc::new(Http::new([(200, MIXED_BODY), (200, "{}")]));
		let fetcher = ZaiUsageFetcher::new(http);
		let credential = SecretString::from("api-key".to_owned());
		let report = fetcher
			.fetch(Some(&credential), UNIX_EPOCH + Duration::from_secs(1_784_000_000), None)
			.await
			.expect("mixed usage report");

		assert_eq!(report.plan.as_deref(), Some("max"));
		assert_eq!(
			report
				.windows
				.iter()
				.map(|window| (window.id.as_str(), window.amount.unit))
				.collect::<Vec<_>>(),
			[
				("zai:tokens:5h", UsageUnit::Tokens),
				("zai:credits:5h", UsageUnit::Credits),
				("zai:requests:1w", UsageUnit::Requests),
			]
		);
	}
}
