//! Alibaba Token Plan console quota retrieval.

use std::{
	fmt::Write as _,
	sync::Arc,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures::FutureExt as _;
use http::{
	HeaderMap, HeaderValue, Method,
	header::{ACCEPT, CONTENT_TYPE, COOKIE, ORIGIN, REFERER, USER_AGENT},
};
use omp_core::{ExposeSecret as _, SecretString, Str, sf};
use ring::rand::{SecureRandom as _, SystemRandom};
use serde_json::{Value, json};
use tokio::time;
use url::form_urlencoded;

use crate::{
	answer::{
		UsageAccountMetadata, UsageAmount, UsageQuantity, UsageStatus, UsageUnit, UsageWindow,
		UsageWindowKind,
	},
	auth::{
		OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse,
		alibaba_token_plan::parse_alibaba_token_plan_credential,
	},
	catalog::ProviderId,
	operation::usage::{
		ConsoleUsageFetcher, ConsoleUsageObservation, UsageCredentialRequirement, UsageFetchError,
	},
	receipt::UsageSource,
};
const PROVIDER: &str = "alibaba-token-plan";
const USAGE_API: &str = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
                                  AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 \
                                  Safari/537.36";
const ALIBABA_TOKEN_PLAN_CN_BASE_URL: &str =
	"https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const HTTP_STEP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy)]
struct ConsoleConfig {
	origin:              &'static str,
	dashboard_url:       &'static str,
	session_url:         &'static str,
	gateway_action:      &'static str,
	region:              &'static str,
	usage_url:           &'static str,
	domain:              &'static str,
	console_site:        &'static str,
	console:             &'static str,
	xsp_lang:            &'static str,
	protocol:            &'static str,
	product_code:        &'static str,
	fe_url:              Option<&'static str>,
	switch_agent:        Option<u64>,
	switch_user_type:    Option<u64>,
	user_nick_name:      Option<&'static str>,
	user_principal_name: Option<&'static str>,
}

const INTERNATIONAL_CONSOLE: ConsoleConfig = ConsoleConfig {
	origin:              "https://home.qwencloud.com",
	dashboard_url:       "https://home.qwencloud.com/billing/subscription/token-plan-individual",
	session_url:         "https://home.qwencloud.com/tool/user/info.json",
	gateway_action:      "IntlBroadScopeAspnGateway",
	region:              "ap-southeast-1",
	usage_url:           "https://cs-data.qwencloud.com/data/api.json?product=sfm_bailian&action=IntlBroadScopeAspnGateway&api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage",
	domain:              "home.qwencloud.com",
	console_site:        "QWENCLOUD",
	console:             "ONE_CONSOLE",
	xsp_lang:            "en-US",
	protocol:            "V2",
	product_code:        "p_efm",
	fe_url:              None,
	switch_agent:        None,
	switch_user_type:    None,
	user_nick_name:      None,
	user_principal_name: None,
};

const CHINA_CONSOLE: ConsoleConfig = ConsoleConfig {
	origin:              "https://bailian.console.aliyun.com",
	dashboard_url:       "https://bailian.console.aliyun.com/cn-beijing?tab=plan",
	session_url:         "https://bailian.console.aliyun.com/cn-beijing?tab=plan",
	gateway_action:      "BroadScopeAspnGateway",
	region:              "cn-beijing",
	usage_url:           "https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage",
	domain:              "bailian.console.aliyun.com",
	console_site:        "BAILIAN_ALIYUN",
	console:             "ONE_CONSOLE",
	xsp_lang:            "zh-CN",
	protocol:            "V2",
	product_code:        "p_efm",
	fe_url:              Some("https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal"),
	switch_agent:        Some(12608464),
	switch_user_type:    Some(3),
	user_nick_name:      Some(""),
	user_principal_name: Some(""),
};

/// Quota windows and optional console account identity returned by one fetch.
#[derive(Clone, Debug)]
pub struct AlibabaTokenPlanUsage {
	/// Console account identifier reported by the international session
	/// endpoint.
	pub account_id:   Option<Str>,
	/// Console provenance label.
	pub source_label: Str,
	/// Normalized quota windows.
	pub windows:      Vec<UsageWindow>,
}

/// Application-registered Alibaba Token Plan console usage fetcher.
#[derive(Clone)]
pub struct AlibabaTokenPlanUsageFetcher {
	provider: ProviderId,
	http:     Arc<dyn OAuthHttpClient>,
}

impl AlibabaTokenPlanUsageFetcher {
	/// Constructs a fetcher over the application's shared bounded HTTP client.
	pub fn new(http: Arc<dyn OAuthHttpClient>) -> Self {
		Self { provider: ProviderId::from(PROVIDER), http }
	}
}

impl ConsoleUsageFetcher for AlibabaTokenPlanUsageFetcher {
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
			let credential_raw = credential.ok_or(UsageFetchError::Protocol)?.expose_secret();
			let usage =
				fetch_alibaba_token_plan_usage_until(credential_raw, self.http.as_ref(), now, deadline)
					.await
					.ok_or(UsageFetchError::Unavailable)?;
			Ok(ConsoleUsageObservation {
				account_meta:  UsageAccountMetadata {
					provider_account_id: usage.account_id,
					..UsageAccountMetadata::default()
				},
				plan:          None,
				source_label:  Some(usage.source_label),
				notes:         Box::default(),
				reset_credits: None,
				windows:       usage.windows,
			})
		}
		.boxed()
	}
}

/// Fetches Alibaba Token Plan quota windows from the matching regional console.
///
/// Missing cookies, expired sessions, malformed responses, and transport
/// failures fail closed as `None` without exposing credential material.
pub async fn fetch_alibaba_token_plan_usage(
	credential_raw: &str,
	http: &dyn OAuthHttpClient,
	now: SystemTime,
) -> Option<AlibabaTokenPlanUsage> {
	fetch_alibaba_token_plan_usage_until(credential_raw, http, now, None).await
}

pub(crate) async fn fetch_alibaba_token_plan_usage_until(
	credential_raw: &str,
	http: &dyn OAuthHttpClient,
	now: SystemTime,
	deadline: Option<Instant>,
) -> Option<AlibabaTokenPlanUsage> {
	let credential = parse_alibaba_token_plan_credential(credential_raw)?;
	let cookie = credential.cookie.as_ref()?.expose_secret();
	let is_china = credential.base_url.as_deref() == Some(ALIBABA_TOKEN_PLAN_CN_BASE_URL);
	let config = if is_china {
		&CHINA_CONSOLE
	} else {
		&INTERNATIONAL_CONSOLE
	};

	let session = session_request(config, cookie, is_china)?;
	let session = execute_bounded(http, session, deadline).await?;
	if !(200..300).contains(&session.status) {
		return None;
	}
	let (sec_token, account_id) = if is_china {
		(extract_sec_token(session.body.expose_secret())?, None)
	} else {
		international_session(session.body.expose_secret())?
	};

	let gateway = gateway_request(config, cookie, &sec_token, is_china)?;
	let gateway = execute_bounded(http, gateway, deadline).await?;
	if !(200..300).contains(&gateway.status) {
		return None;
	}
	let windows = parse_usage_windows(gateway.body.expose_secret(), now)?;
	let source_label = if is_china {
		sf!("bailian-console")
	} else {
		sf!("qwencloud-console")
	};
	Some(AlibabaTokenPlanUsage { account_id, source_label, windows })
}

fn session_request(
	config: &ConsoleConfig,
	cookie: &str,
	is_china: bool,
) -> Option<OAuthHttpRequest> {
	let mut headers = HeaderMap::new();
	insert_secret_header(&mut headers, COOKIE, cookie)?;
	headers.insert(REFERER, HeaderValue::from_str(&format!("{}/", config.origin)).ok()?);
	headers.insert(USER_AGENT, HeaderValue::from_static(BROWSER_USER_AGENT));
	headers.insert(
		ACCEPT,
		HeaderValue::from_static(if is_china {
			"text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
		} else {
			"application/json, text/plain, */*"
		}),
	);
	OAuthHttpRequest::new(Method::GET, config.session_url, headers, None).ok()
}

fn gateway_request(
	config: &ConsoleConfig,
	cookie: &str,
	sec_token: &str,
	is_china: bool,
) -> Option<OAuthHttpRequest> {
	let cornerstone_param = if is_china {
		json!({
			"feTraceId": random_uuid_v4()?,
			"feURL": config.fe_url?,
			"protocol": config.protocol,
			"console": config.console,
			"productCode": config.product_code,
			"switchAgent": config.switch_agent?,
			"switchUserType": config.switch_user_type?,
			"domain": config.domain,
			"consoleSite": config.console_site,
			"userNickName": config.user_nick_name?,
			"userPrincipalName": config.user_principal_name?,
			"xsp_lang": config.xsp_lang
		})
	} else {
		json!({
			"domain": config.domain,
			"consoleSite": config.console_site,
			"console": config.console,
			"xsp_lang": config.xsp_lang,
			"protocol": config.protocol,
			"productCode": config.product_code
		})
	};
	let params = serde_json::to_string(&json!({
		"Api": USAGE_API,
		"Data": { "cornerstoneParam": cornerstone_param },
		"V": "1.0"
	}))
	.ok()?;
	let body = form_urlencoded::Serializer::new(String::new())
		.append_pair("product", "sfm_bailian")
		.append_pair("action", config.gateway_action)
		.append_pair("region", config.region)
		.append_pair("sec_token", sec_token)
		.append_pair("params", &params)
		.finish();

	let mut headers = HeaderMap::new();
	headers.insert(ACCEPT, HeaderValue::from_static("application/json, text/plain, */*"));
	headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/x-www-form-urlencoded"));
	insert_secret_header(&mut headers, COOKIE, cookie)?;
	headers.insert(ORIGIN, HeaderValue::from_static(config.origin));
	headers.insert(REFERER, HeaderValue::from_static(config.dashboard_url));
	headers.insert(USER_AGENT, HeaderValue::from_static(BROWSER_USER_AGENT));
	headers.insert("x-requested-with", HeaderValue::from_static("XMLHttpRequest"));
	if let Some(csrf) = extract_cookie_value(cookie, "login_aliyunid_csrf")
		.or_else(|| extract_cookie_value(cookie, "csrf"))
	{
		insert_secret_header(&mut headers, "x-xsrf-token", csrf)?;
		insert_secret_header(&mut headers, "x-csrf-token", csrf)?;
	}
	OAuthHttpRequest::new(Method::POST, config.usage_url, headers, Some(SecretString::from(body)))
		.ok()
}

async fn execute_bounded(
	http: &dyn OAuthHttpClient,
	request: OAuthHttpRequest,
	deadline: Option<Instant>,
) -> Option<OAuthHttpResponse> {
	let timeout = deadline
		.map_or(HTTP_STEP_TIMEOUT, |deadline| deadline.saturating_duration_since(Instant::now()))
		.min(HTTP_STEP_TIMEOUT);
	if timeout.is_zero() {
		return None;
	}
	time::timeout(timeout, http.execute(request))
		.await
		.ok()?
		.ok()
}

fn insert_secret_header(
	headers: &mut HeaderMap,
	name: impl http::header::IntoHeaderName,
	value: &str,
) -> Option<()> {
	let mut value = HeaderValue::from_str(value).ok()?;
	value.set_sensitive(true);
	headers.insert(name, value);
	Some(())
}

fn international_session(body: &str) -> Option<(String, Option<Str>)> {
	let payload: Value = serde_json::from_str(body).ok()?;
	let data = payload.get("data")?.as_object()?;
	let sec_token = data.get("secToken")?.as_str()?.to_owned();
	let account_id = ["accountId", "userId", "aliyunId", "loginId"]
		.into_iter()
		.find_map(|key| match data.get(key) {
			Some(Value::String(value)) => Some(Str::new(value.as_str())),
			Some(Value::Number(value)) => Some(Str::new(value.to_string())),
			_ => None,
		});
	Some((sec_token, account_id))
}

fn extract_sec_token(body: &str) -> Option<String> {
	let bytes = body.as_bytes();
	let mut start = 0;
	while let Some(relative) = body.get(start..)?.find("SEC_TOKEN") {
		let token = start + relative;
		let boundary =
			token == 0 || !matches!(bytes[token - 1], b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_');
		let mut cursor = token + "SEC_TOKEN".len();
		if boundary {
			while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
				cursor += 1;
			}
			if bytes.get(cursor) == Some(&b':') {
				cursor += 1;
				while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
					cursor += 1;
				}
				if bytes.get(cursor) == Some(&b'"') {
					cursor += 1;
					let end = bytes.get(cursor..)?.iter().position(|byte| *byte == b'"')? + cursor;
					return Some(body.get(cursor..end)?.to_owned());
				}
			}
		}
		start = token + "SEC_TOKEN".len();
	}
	None
}

fn extract_cookie_value<'a>(cookie: &'a str, name: &str) -> Option<&'a str> {
	cookie.split(';').find_map(|segment| {
		let (candidate, value) = segment.split_once('=')?;
		(candidate.trim() == name)
			.then(|| value.trim())
			.filter(|value| !value.is_empty())
	})
}

fn random_uuid_v4() -> Option<String> {
	let mut bytes = [0_u8; 16];
	SystemRandom::new().fill(&mut bytes).ok()?;
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	let mut output = String::with_capacity(36);
	for (index, byte) in bytes.into_iter().enumerate() {
		if matches!(index, 4 | 6 | 8 | 10) {
			output.push('-');
		}
		write!(&mut output, "{byte:02x}").ok()?;
	}
	Some(output)
}

fn parse_usage_windows(body: &str, now: SystemTime) -> Option<Vec<UsageWindow>> {
	let payload: Value = serde_json::from_str(body).ok()?;
	let payload = payload.as_object()?;
	if payload.get("successResponse") == Some(&Value::Bool(false)) {
		return None;
	}
	let data = payload.get("data")?.as_object()?;
	let data = unwrap_gateway_data(Value::Object(data.clone()))?;
	let mut windows = Vec::with_capacity(2);
	if let Some(window) =
		quota_window("credits:5h", data.get("per5HourPercentage"), data.get("per5HourResetTime"), now)
	{
		windows.push(window);
	}
	if let Some(window) =
		quota_window("credits:7d", data.get("per1WeekPercentage"), data.get("per1WeekResetTime"), now)
	{
		windows.push(window);
	}
	(!windows.is_empty()).then_some(windows)
}

fn unwrap_gateway_data(mut current: Value) -> Option<serde_json::Map<String, Value>> {
	for _ in 0..8 {
		let object = current.as_object()?;
		if let Some(Value::String(data)) = object.get("Data") {
			current = serde_json::from_str(data).ok()?;
			continue;
		}
		if let Some(data) = object
			.get("DataV2")
			.and_then(Value::as_object)
			.and_then(|value| value.get("data"))
			.filter(|value| value.is_object())
		{
			current = data.clone();
			continue;
		}
		if let Some(data) = object.get("data").filter(|value| value.is_object()) {
			current = data.clone();
			continue;
		}
		return Some(object.clone());
	}
	None
}

fn quota_window(
	id: &'static str,
	percentage: Option<&Value>,
	reset: Option<&Value>,
	now: SystemTime,
) -> Option<UsageWindow> {
	let fraction = parse_used_fraction(percentage?)?;
	let consumed = ((fraction * 100.0).round() as u64).min(100);
	let (label, duration) = if id.ends_with("5h") {
		(sf!("5 Hour Credits"), Duration::from_hours(5))
	} else {
		(sf!("7 Day Credits"), Duration::from_days(7))
	};
	Some(UsageWindow {
		id:          sf!(id),
		kind:        UsageWindowKind::Quota,
		dimension:   sf!(id),
		label:       Some(label),
		scope:       Some(sf!("shared")),
		amount:      UsageAmount {
			unit:      UsageUnit::Percent,
			consumed:  Some(UsageQuantity::new(consumed, 0)),
			remaining: Some(UsageQuantity::new(100 - consumed, 0)),
			limit:     Some(UsageQuantity::new(100, 0)),
		},
		status:      Some(if consumed >= 100 {
			UsageStatus::Exhausted
		} else if consumed >= 80 {
			UsageStatus::Warning
		} else {
			UsageStatus::Ok
		}),
		duration:    Some(duration),
		resets_at:   reset.and_then(parse_positive_timestamp),
		reset_label: None,
		notes:       Box::default(),
		source:      UsageSource::Provider,
		observed_at: now,
	})
}

fn parse_used_fraction(value: &Value) -> Option<f64> {
	let parsed = match value {
		Value::Number(value) => value.as_f64()?,
		Value::String(value) => value.parse().ok()?,
		_ => return None,
	};
	if !parsed.is_finite() || parsed < 0.0 {
		return None;
	}
	Some(if parsed > 1.0 { parsed / 100.0 } else { parsed }.min(1.0))
}

fn parse_positive_timestamp(value: &Value) -> Option<SystemTime> {
	let milliseconds = match value {
		Value::Number(value) => value.as_f64()?,
		Value::String(value) => value.parse().ok()?,
		_ => return None,
	};
	if !milliseconds.is_finite() || milliseconds <= 0.0 || milliseconds > u64::MAX as f64 {
		return None;
	}
	UNIX_EPOCH.checked_add(Duration::from_millis(milliseconds as u64))
}

#[cfg(test)]
mod tests {
	use std::{
		collections::{BTreeMap, VecDeque},
		sync::Arc,
		time::{Duration, SystemTime, UNIX_EPOCH},
	};

	use futures::{FutureExt as _, future::BoxFuture};
	use http::{HeaderMap, Method};
	use omp_core::{ExposeSecret as _, SecretString};
	use parking_lot::Mutex;

	use super::{CHINA_CONSOLE, INTERNATIONAL_CONSOLE, fetch_alibaba_token_plan_usage};
	use crate::auth::{OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse, OAuthTransportError};

	#[derive(Clone)]
	struct RecordedRequest {
		method:  Method,
		url:     String,
		headers: HeaderMap,
		body:    Option<String>,
	}

	#[derive(Clone, Default)]
	struct ScriptedHttp {
		responses: Arc<Mutex<VecDeque<OAuthHttpResponse>>>,
		requests:  Arc<Mutex<Vec<RecordedRequest>>>,
	}

	impl ScriptedHttp {
		fn with_responses(bodies: impl IntoIterator<Item = (u16, &'static str)>) -> Self {
			let responses = bodies
				.into_iter()
				.map(|(status, body)| OAuthHttpResponse {
					status,
					headers: HeaderMap::new(),
					body: SecretString::from(body.to_owned()),
				})
				.collect();
			Self {
				responses: Arc::new(Mutex::new(responses)),
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
			self.requests.lock().push(RecordedRequest {
				method,
				url: url.to_string(),
				headers,
				body: body.map(|body| body.expose_secret().to_owned()),
			});
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

	fn form(body: &str) -> BTreeMap<String, String> {
		url::form_urlencoded::parse(body.as_bytes())
			.into_owned()
			.collect()
	}

	#[tokio::test]
	async fn international_console_fetches_both_quota_windows_with_csrf() {
		let http = ScriptedHttp::with_responses([
			(200, r#"{"data":{"secToken":"intl-sec-token","accountId":12345}}"#),
			(
				200,
				r#"{"data":{"per5HourPercentage":0.42,"per5HourResetTime":1700000100000,"per1WeekPercentage":"65","per1WeekResetTime":1700000200000}}"#,
			),
		]);
		let raw = r#"{"token":"sk-sp-test","cookie":"login_aliyunid_csrf=csrf-value; session=abc"}"#;
		let usage = fetch_alibaba_token_plan_usage(raw, &http, now())
			.await
			.expect("usage");
		assert_eq!(usage.account_id.as_deref(), Some("12345"));
		assert_eq!(usage.source_label.as_str(), "qwencloud-console");
		assert_eq!(usage.windows.len(), 2);
		assert_eq!(usage.windows[0].id.as_str(), "credits:5h");
		assert_eq!(usage.windows[0].amount.consumed.map(|value| value.units), Some(42));
		assert_eq!(usage.windows[1].id.as_str(), "credits:7d");
		assert_eq!(usage.windows[1].amount.consumed.map(|value| value.units), Some(65));

		let requests = http.requests.lock();
		assert_eq!(requests[0].method, Method::GET);
		assert_eq!(requests[0].url, INTERNATIONAL_CONSOLE.session_url);
		assert_eq!(requests[0].headers["cookie"], "login_aliyunid_csrf=csrf-value; session=abc");
		assert_eq!(requests[1].method, Method::POST);
		assert_eq!(requests[1].url, INTERNATIONAL_CONSOLE.usage_url);
		assert_eq!(requests[1].headers["x-xsrf-token"], "csrf-value");
		assert_eq!(requests[1].headers["x-csrf-token"], "csrf-value");
		let form = form(requests[1].body.as_deref().expect("form body"));
		assert_eq!(form["action"], "IntlBroadScopeAspnGateway");
		assert_eq!(form["region"], "ap-southeast-1");
		assert_eq!(form["sec_token"], "intl-sec-token");
	}

	#[tokio::test]
	async fn china_console_extracts_html_token_and_unwraps_data_v2() {
		let http = ScriptedHttp::with_responses([
			(200, r#"<script>window.ALIYUN_CONSOLE_CONFIG = { SEC_TOKEN: "cn-sec-token" };</script>"#),
			(
				200,
				r#"{"data":{"DataV2":{"data":{"data":{"per1WeekPercentage":0.7913113,"per1WeekResetTime":1700000200000}}}}}"#,
			),
		]);
		let raw = r#"{"token":"sk-sp-cn","cookie":"csrf=cn-csrf; session=abc","baseUrl":"https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"}"#;
		let usage = fetch_alibaba_token_plan_usage(raw, &http, now())
			.await
			.expect("usage");
		assert_eq!(usage.source_label.as_str(), "bailian-console");
		assert_eq!(usage.windows.len(), 1);
		assert_eq!(usage.windows[0].id.as_str(), "credits:7d");
		assert_eq!(usage.windows[0].amount.consumed.map(|value| value.units), Some(79));

		let requests = http.requests.lock();
		assert_eq!(requests[0].url, CHINA_CONSOLE.session_url);
		assert_eq!(requests[1].url, CHINA_CONSOLE.usage_url);
		let form = form(requests[1].body.as_deref().expect("form body"));
		assert_eq!(form["action"], "BroadScopeAspnGateway");
		assert_eq!(form["region"], "cn-beijing");
		assert_eq!(form["sec_token"], "cn-sec-token");
		let params: serde_json::Value = serde_json::from_str(&form["params"]).expect("params json");
		let cornerstone = &params["Data"]["cornerstoneParam"];
		assert!(
			cornerstone["feTraceId"]
				.as_str()
				.is_some_and(|value| value.len() == 36)
		);
		assert_eq!(cornerstone["xsp_lang"], "zh-CN");
	}

	#[tokio::test]
	async fn cookie_less_credential_makes_no_http_calls() {
		let http = ScriptedHttp::default();
		assert!(
			fetch_alibaba_token_plan_usage("sk-sp-test", &http, now())
				.await
				.is_none()
		);
		assert!(http.requests.lock().is_empty());
	}

	#[tokio::test]
	async fn unsuccessful_gateway_response_fails_closed() {
		let http = ScriptedHttp::with_responses([
			(200, r#"{"data":{"secToken":"intl-sec-token"}}"#),
			(200, r#"{"successResponse":false,"data":{}}"#),
		]);
		let raw = r#"{"token":"sk-sp-test","cookie":"session=abc"}"#;
		assert!(
			fetch_alibaba_token_plan_usage(raw, &http, now())
				.await
				.is_none()
		);
	}

	#[tokio::test]
	async fn missing_china_sec_token_fails_closed() {
		let http = ScriptedHttp::with_responses([(200, "<html>ConsoleNeedLogin</html>")]);
		let raw = r#"{"token":"sk-sp-cn","cookie":"session=abc","baseUrl":"https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"}"#;
		assert!(
			fetch_alibaba_token_plan_usage(raw, &http, now())
				.await
				.is_none()
		);
		assert_eq!(http.requests.lock().len(), 1);
	}

	#[tokio::test]
	async fn percentages_above_one_are_percent_values_and_negative_values_are_skipped() {
		let http = ScriptedHttp::with_responses([
			(200, r#"{"data":{"secToken":"intl-sec-token"}}"#),
			(200, r#"{"data":{"per5HourPercentage":-1,"per1WeekPercentage":"65"}}"#),
		]);
		let raw = r#"{"token":"sk-sp-test","cookie":"session=abc"}"#;
		let usage = fetch_alibaba_token_plan_usage(raw, &http, now())
			.await
			.expect("usage");
		assert_eq!(usage.windows.len(), 1);
		assert_eq!(usage.windows[0].id.as_str(), "credits:7d");
		assert_eq!(usage.windows[0].amount.consumed.map(|value| value.units), Some(65));
	}
}
