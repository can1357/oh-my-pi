//! `MiniMax` coding-plan quota retrieval.

use std::{
	sync::Arc,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures::FutureExt as _;
use http::{HeaderMap, HeaderValue, Method, header::AUTHORIZATION};
use omp_core::{ExposeSecret as _, SecretString, Str, sf};
use serde_json::{Map, Value};
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
const PROVIDER: &str = "minimax-code";
const PROVIDER_CN: &str = "minimax-code-cn";
const BASE: &str = "https://api.minimax.io";
const BASE_CN: &str = "https://api.minimaxi.com";
const TIMEOUT: Duration = Duration::from_secs(10);
const EXHAUSTED: u64 = 2;
const UNLIMITED: u64 = 3;
/// Application-registered `MiniMax` coding-plan usage fetcher.
#[derive(Clone)]
pub struct MiniMaxCodeUsageFetcher {
	provider: ProviderId,
	http:     Arc<dyn OAuthHttpClient>,
	base_url: Str,
}
impl MiniMaxCodeUsageFetcher {
	/// Constructs the international `MiniMax` fetcher.
	pub fn new(http: Arc<dyn OAuthHttpClient>) -> Self {
		Self::with_provider(http, PROVIDER, BASE)
	}

	/// Constructs the mainland-China `MiniMax` fetcher.
	pub fn china(http: Arc<dyn OAuthHttpClient>) -> Self {
		Self::with_provider(http, PROVIDER_CN, BASE_CN)
	}

	fn with_provider(http: Arc<dyn OAuthHttpClient>, provider: &str, base: &str) -> Self {
		Self { provider: ProviderId::from(provider), http, base_url: Str::new(normalize(base)) }
	}
}
impl ConsoleUsageFetcher for MiniMaxCodeUsageFetcher {
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
				credential_parts(credential.ok_or(UsageFetchError::Protocol)?.expose_secret())?;
			let url = format!("{}/v1/token_plan/remains", self.base_url);
			let response = execute(self.http.as_ref(), request(&url, &key)?, deadline).await?;
			if !(200..300).contains(&response.status) {
				return Err(UsageFetchError::Unavailable);
			}
			let windows = parse(response.body.expose_secret(), now)?;
			Ok(ConsoleUsageObservation {
				account_meta,
				plan: None,
				source_label: Some(sf!("minimax-token-plan")),
				notes: Box::default(),
				reset_credits: None,
				windows,
			})
		}
		.boxed()
	}
}
fn normalize(v: &str) -> &str {
	let v = v.trim().trim_end_matches('/');
	v.strip_suffix("/v1").unwrap_or(v)
}
fn credential_parts(raw: &str) -> Result<(String, UsageAccountMetadata), UsageFetchError> {
	if let Ok(v) = serde_json::from_str::<Value>(raw) {
		let key = v
			.get("apiKey")
			.or_else(|| v.get("token"))
			.and_then(Value::as_str)
			.ok_or(UsageFetchError::Protocol)?
			.to_owned();
		let f = |n| v.get(n).and_then(Value::as_str).map(Str::new);
		Ok((key, UsageAccountMetadata {
			provider_account_id: f("accountId"),
			email: f("email"),
			project_id: f("projectId"),
			..UsageAccountMetadata::default()
		}))
	} else if raw.is_empty() {
		Err(UsageFetchError::Protocol)
	} else {
		Ok((raw.to_owned(), UsageAccountMetadata::default()))
	}
}
fn request(url: &str, key: &str) -> Result<OAuthHttpRequest, UsageFetchError> {
	let mut h = HeaderMap::new();
	let mut v =
		HeaderValue::from_str(&format!("Bearer {key}")).map_err(|_| UsageFetchError::Protocol)?;
	v.set_sensitive(true);
	h.insert(AUTHORIZATION, v);
	OAuthHttpRequest::new(Method::GET, url, h, None).map_err(|_| UsageFetchError::Protocol)
}
async fn execute(
	http: &dyn OAuthHttpClient,
	r: OAuthHttpRequest,
	d: Option<Instant>,
) -> Result<OAuthHttpResponse, UsageFetchError> {
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
	if p.pointer("/base_resp/status_code").and_then(uint) != Some(0) {
		return Err(UsageFetchError::Unavailable);
	}
	let buckets = p
		.get("model_remains")
		.and_then(Value::as_array)
		.ok_or(UsageFetchError::Unavailable)?;
	let mut out = Vec::with_capacity(buckets.len() * 2);
	for b in buckets {
		let b = b.as_object().ok_or(UsageFetchError::Unavailable)?;
		let model = b
			.get("model_name")
			.and_then(Value::as_str)
			.ok_or(UsageFetchError::Unavailable)?;
		let interval_status = b.get("current_interval_status").and_then(uint);
		let weekly_status = b.get("current_weekly_status").and_then(uint);
		let interval_total = b
			.get("current_interval_total_count")
			.and_then(uint)
			.unwrap_or(0);
		let weekly_total = b
			.get("current_weekly_total_count")
			.and_then(uint)
			.unwrap_or(0);
		if interval_total == 0
			&& weekly_total == 0
			&& interval_status == Some(UNLIMITED)
			&& weekly_status == Some(UNLIMITED)
		{
			continue;
		}
		let start = b.get("start_time").and_then(timestamp_ms);
		let end = b.get("end_time").and_then(timestamp_ms);
		let duration = end.zip(start).and_then(|(e, s)| e.duration_since(s).ok());
		if let Some(w) = bucket_window(
			model,
			b,
			"current_interval_remaining_percent",
			"current_interval_usage_count",
			interval_total,
			interval_status,
			duration,
			end,
			false,
			now,
		) {
			out.push(w);
		}
		let weekly_end = b.get("weekly_end_time").and_then(timestamp_ms);
		if let Some(w) = bucket_window(
			model,
			b,
			"current_weekly_remaining_percent",
			"current_weekly_usage_count",
			weekly_total,
			weekly_status,
			Some(Duration::from_days(7)),
			weekly_end,
			true,
			now,
		) {
			out.push(w);
		}
	}
	if out.is_empty() {
		Err(UsageFetchError::Unavailable)
	} else {
		Ok(out)
	}
}
fn bucket_window(
	model: &str,
	b: &Map<String, Value>,
	percent_key: &str,
	used_key: &str,
	total: u64,
	state: Option<u64>,
	duration: Option<Duration>,
	resets: Option<SystemTime>,
	weekly: bool,
	now: SystemTime,
) -> Option<UsageWindow> {
	let remaining = if state == Some(EXHAUSTED) {
		UsageQuantity::new(0, 0)
	} else {
		decimal_value(b.get(percent_key)?)?
	};
	let (remaining, limit) = align(remaining, UsageQuantity::new(100, 0))?;
	let consumed =
		UsageQuantity::new(limit.units.checked_sub(remaining.units)?, limit.decimal_exponent);
	let (window_id, window_label) = if weekly {
		("7d".to_owned(), "7 Day".to_owned())
	} else {
		interval(duration?)
	};
	let shared = model == "general";
	let title = capitalize(model);
	let id = format!("{model}:{window_id}");
	let label = format!("{title} {window_label}");
	let notes = if total > 0 {
		vec![sf!("Requests: {}/{}", b.get(used_key).and_then(uint).unwrap_or(0), total)]
			.into_boxed_slice()
	} else {
		Box::default()
	};
	let threshold = consumed.units.saturating_mul(100);
	let status = if consumed.units >= limit.units {
		UsageStatus::Exhausted
	} else if threshold >= limit.units.saturating_mul(90) {
		UsageStatus::Warning
	} else {
		UsageStatus::Ok
	};
	Some(UsageWindow {
		id: Str::new(id),
		kind: UsageWindowKind::Quota,
		dimension: sf!("percent"),
		label: Some(Str::new(label)),
		scope: Some(if shared {
			sf!("shared")
		} else {
			Str::new(model)
		}),
		amount: UsageAmount {
			unit:      UsageUnit::Percent,
			consumed:  Some(consumed),
			remaining: Some(remaining),
			limit:     Some(limit),
		},
		status: Some(status),
		duration,
		resets_at: resets,
		reset_label: None,
		notes,
		source: UsageSource::Provider,
		observed_at: now,
	})
}
fn interval(d: Duration) -> (String, String) {
	let s = d.as_secs();
	if s.is_multiple_of(60 * 60) {
		let h = s / (60 * 60);
		(format!("{h}h"), format!("{h} Hour"))
	} else {
		let m = s / 60;
		if m > 0 {
			(format!("{m}m"), format!("{m} Minute"))
		} else {
			("interval".to_owned(), "Interval".to_owned())
		}
	}
}
fn capitalize(v: &str) -> String {
	let mut chars = v.chars();
	match chars.next() {
		Some(c) => c.to_uppercase().chain(chars).collect(),
		None => String::new(),
	}
}
fn uint(v: &Value) -> Option<u64> {
	v.as_u64().or_else(|| v.as_str()?.parse().ok())
}
fn timestamp_ms(v: &Value) -> Option<SystemTime> {
	let n = uint(v)?;
	UNIX_EPOCH.checked_add(Duration::from_millis(n))
}
fn decimal_value(v: &Value) -> Option<UsageQuantity> {
	match v {
		Value::Number(n) => decimal(&n.to_string()),
		Value::String(s) => decimal(s),
		_ => None,
	}
}
fn decimal(v: &str) -> Option<UsageQuantity> {
	let (whole, fraction) = v.split_once('.').unwrap_or((v, ""));
	let units = format!("{whole}{fraction}").parse().ok()?;
	Some(UsageQuantity::new(units, fraction.len().try_into().ok()?))
}
fn align(a: UsageQuantity, b: UsageQuantity) -> Option<(UsageQuantity, UsageQuantity)> {
	let e = a.decimal_exponent.max(b.decimal_exponent);
	let scale = |q: UsageQuantity| {
		q.units
			.checked_mul(10_u64.pow((e - q.decimal_exponent).into()))
			.map(|u| UsageQuantity::new(u, e))
	};
	Some((scale(a)?, scale(b)?))
}

#[cfg(test)]
mod tests {
	use std::{collections::VecDeque, sync::Arc, time::SystemTime};

	use futures::{FutureExt as _, future::BoxFuture};
	use http::HeaderMap;
	use omp_core::SecretString;
	use parking_lot::Mutex;

	use super::MiniMaxCodeUsageFetcher;
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
	const BODY: &str = r#"{"model_remains":[{"model_name":"general","start_time":1785009600000,"end_time":1785024000000,"current_interval_total_count":0,"current_interval_usage_count":0,"current_interval_remaining_percent":90,"current_interval_status":1,"weekly_end_time":1785110400000,"current_weekly_total_count":0,"current_weekly_usage_count":0,"current_weekly_remaining_percent":78,"current_weekly_status":1},{"model_name":"video","start_time":1784937600000,"end_time":1785024000000,"current_interval_total_count":3,"current_interval_usage_count":1,"current_interval_remaining_percent":100,"current_interval_status":1,"weekly_end_time":1785110400000,"current_weekly_total_count":21,"current_weekly_usage_count":1,"current_weekly_remaining_percent":100,"current_weekly_status":1}],"base_resp":{"status_code":0}}"#;
	#[tokio::test]
	async fn maps_shared_and_model_buckets_with_exact_windows() {
		let h = Arc::new(Http::new([(200, BODY)]));
		let f = MiniMaxCodeUsageFetcher::new(h.clone());
		let k = SecretString::from("sk-cp-test".to_owned());
		let r = f.fetch(Some(&k), SystemTime::now(), None).await.unwrap();
		assert_eq!(
			r.windows
				.iter()
				.map(|w| (w.id.as_str(), w.scope.as_deref()))
				.collect::<Vec<_>>(),
			[
				("general:4h", Some("shared")),
				("general:7d", Some("shared")),
				("video:24h", Some("video")),
				("video:7d", Some("video"))
			]
		);
		assert_eq!(r.windows[0].amount.consumed.unwrap(), crate::answer::UsageQuantity::new(10, 0));
		assert_eq!(r.windows[1].amount.consumed.unwrap(), crate::answer::UsageQuantity::new(22, 0));
		assert_eq!(r.windows[2].notes[0], "Requests: 1/3");
		assert_eq!(r.windows[3].notes[0], "Requests: 1/21");
		assert_eq!(h.requests.lock()[0].0, "https://api.minimax.io/v1/token_plan/remains");
		assert_eq!(h.requests.lock()[0].1["authorization"].to_str().unwrap(), "Bearer sk-cp-test");
	}
	#[tokio::test]
	async fn region_and_base_routing_are_exact() {
		for (base, expected) in [
			("https://proxy.example", "https://proxy.example/v1/token_plan/remains"),
			("https://proxy.example/", "https://proxy.example/v1/token_plan/remains"),
			("https://proxy.example/v1/", "https://proxy.example/v1/token_plan/remains"),
		] {
			let h = Arc::new(Http::new([(200, BODY)]));
			let f = MiniMaxCodeUsageFetcher::with_provider(h.clone(), "minimax-code", base);
			let k = SecretString::from("k".to_owned());
			f.fetch(Some(&k), SystemTime::now(), None).await.unwrap();
			assert_eq!(h.requests.lock()[0].0, expected);
		}
		let f = MiniMaxCodeUsageFetcher::china(Arc::new(Http::default()));
		assert_eq!(f.provider().as_str(), "minimax-code-cn");
	}
	#[tokio::test]
	async fn rejects_envelope_empty_and_unavailable_models_but_keeps_disagreement() {
		for body in [
			r#"{"model_remains":[],"base_resp":{"status_code":0}}"#,
			r#"{"model_remains":[]}"#,
			r#"{"base_resp":{"status_code":1004}}"#,
			r#"{"model_remains":[{"model_name":"general","current_interval_total_count":0,"weekly_start_time":0,"current_weekly_total_count":0,"current_interval_status":3,"current_weekly_status":3}],"base_resp":{"status_code":0}}"#,
		] {
			let f = MiniMaxCodeUsageFetcher::new(Arc::new(Http::new([(200, body)])));
			let k = SecretString::from("k".to_owned());
			assert_eq!(
				f.fetch(Some(&k), SystemTime::now(), None)
					.await
					.unwrap_err(),
				UsageFetchError::Unavailable
			);
		}
		let body = r#"{"model_remains":[{"model_name":"general","start_time":1785009600000,"end_time":1785024000000,"current_interval_remaining_percent":0,"current_interval_status":2,"current_interval_total_count":0,"current_weekly_status":3,"current_weekly_total_count":0}],"base_resp":{"status_code":0}}"#;
		let f = MiniMaxCodeUsageFetcher::new(Arc::new(Http::new([(200, body)])));
		let k = SecretString::from("k".to_owned());
		let r = f.fetch(Some(&k), SystemTime::now(), None).await.unwrap();
		assert_eq!(r.windows.len(), 1);
		assert_eq!(r.windows[0].status, Some(UsageStatus::Exhausted));
	}
}
