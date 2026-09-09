//! Perplexity desktop-token borrowing and email one-time-password exchange.

#[cfg(target_os = "macos")]
use std::process::Command;
use std::{
	env,
	ffi::OsStr,
	fmt,
	sync::Arc,
	time::{Duration, SystemTime},
};

use futures::{FutureExt as _, future::BoxFuture};
use http::{
	HeaderMap, HeaderValue, Method,
	header::{CONTENT_TYPE, COOKIE, SET_COOKIE, USER_AGENT},
};
use omp_catalog::provider::OAuthExchangeKind;
use omp_core::{ExposeSecret as _, SecretString, base64_url, sf};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::super::{
	OAuthClock, OAuthCustomDispatchError, OAuthCustomDispatcher, OAuthCustomHandler, OAuthError,
	OAuthHttpClient, OAuthHttpRequest, OAuthTokenSet, provider_error,
};
use crate::{
	answer::{AuthEvent, AuthPrompt, AuthPromptKind},
	auth::{LoginDriver, OAuthCustomSpec},
	call::AuthInput,
};

const API_VERSION: &str = "2.18";
const APP_USER_AGENT: &str = "Perplexity/641 CFNetwork/1568 Darwin/25.2.0";
#[cfg(target_os = "macos")]
const NATIVE_APP_BUNDLE: &str = "ai.perplexity.mac";
const NEVER_EXPIRES_MILLIS: u64 = 8_640_000_000_000_000;
const EXPIRY_SAFETY_MARGIN: Duration = Duration::from_mins(5);

/// Registers Perplexity's catalog-selected email OTP exchange.
pub(super) fn register(
	dispatcher: &mut OAuthCustomDispatcher,
	http: Arc<dyn OAuthHttpClient>,
	clock: Arc<dyn OAuthClock>,
) -> Result<(), OAuthCustomDispatchError> {
	dispatcher.register(Arc::new(PerplexityEmailOtp { http, clock, borrow: borrow_native_token }))
}

struct PerplexityEmailOtp {
	http:   Arc<dyn OAuthHttpClient>,
	clock:  Arc<dyn OAuthClock>,
	borrow: fn() -> Option<SecretString>,
}

impl fmt::Debug for PerplexityEmailOtp {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("PerplexityEmailOtp")
			.field("http", &"[REDACTED]")
			.field("clock", &"[REDACTED]")
			.field("borrow", &"[REDACTED]")
			.finish()
	}
}

impl OAuthCustomHandler for PerplexityEmailOtp {
	fn exchange_kind(&self) -> OAuthExchangeKind {
		OAuthExchangeKind::PerplexityEmailOtp
	}

	fn exchange<'a>(
		&'a self,
		spec: &'a OAuthCustomSpec,
		driver: &'a LoginDriver,
	) -> BoxFuture<'a, Result<OAuthTokenSet, OAuthError>> {
		async move {
			if env::var_os("OMP_AUTH_NO_BORROW").as_deref() != Some(OsStr::new("1"))
				&& let Some(token) = (self.borrow)()
			{
				return token_set(token, None, self.clock.now());
			}

			let email = prompt_email(driver).await?;
			driver.check_cancelled()?;
			let csrf_url = spec
				.parameters
				.iter()
				.find(|parameter| parameter.name == "csrf_url")
				.map(|parameter| parameter.value.as_ref())
				.ok_or(OAuthError::MalformedResponse)?;
			let mut cookies = CookieJar::default();

			let csrf_response = self
				.http
				.execute(OAuthHttpRequest::new(
					Method::GET,
					csrf_url,
					request_headers(false, &cookies)?,
					None,
				)?)
				.await?;
			cookies.remember(&csrf_response.headers);
			if !(200..300).contains(&csrf_response.status) {
				return Err(provider_error(csrf_response.status, &csrf_response.body, false));
			}
			let csrf: CsrfResponse = serde_json::from_str(csrf_response.body.expose_secret())
				.map_err(|_| OAuthError::MalformedResponse)?;
			let csrf = SecretString::from(
				csrf
					.csrf_token
					.filter(|value| !value.is_empty())
					.ok_or(OAuthError::MalformedResponse)?,
			);

			let send_body = secret_json(&SendCodeRequest {
				email:      email.expose_secret(),
				csrf_token: csrf.expose_secret(),
			})?;
			let send_response = self
				.http
				.execute(OAuthHttpRequest::new(
					Method::POST,
					&spec.authorize_url,
					request_headers(true, &cookies)?,
					Some(send_body),
				)?)
				.await?;
			cookies.remember(&send_response.headers);
			if !(200..300).contains(&send_response.status) {
				return Err(provider_error(send_response.status, &send_response.body, false));
			}

			let otp = prompt_otp(driver).await?;
			driver.check_cancelled()?;
			let verify_body = secret_json(&VerifyCodeRequest {
				email:      email.expose_secret(),
				otp:        otp.expose_secret(),
				csrf_token: csrf.expose_secret(),
			})?;
			let verify_response = self
				.http
				.execute(OAuthHttpRequest::new(
					Method::POST,
					&spec.client.token_url,
					request_headers(true, &cookies)?,
					Some(verify_body),
				)?)
				.await?;
			cookies.remember(&verify_response.headers);
			let verify: VerifyResponse = serde_json::from_str(verify_response.body.expose_secret())
				.map_err(|_| OAuthError::MalformedResponse)?;
			if !(200..300).contains(&verify_response.status) {
				return Err(provider_error(verify_response.status, &verify_response.body, false));
			}
			// Explicit rejection markers invalidate an otherwise 2xx body, and an
			// OTP challenge may mint the login token as `challenge_token` instead
			// of `token`; accept either, preferring the challenge variant.
			if verify.error_code.is_some()
				|| verify
					.status
					.as_deref()
					.is_some_and(|status| status != "success")
			{
				return Err(OAuthError::MalformedResponse);
			}
			let token = SecretString::from(
				verify
					.challenge_token
					.filter(|value| !value.is_empty())
					.or_else(|| verify.token.filter(|value| !value.is_empty()))
					.ok_or(OAuthError::MalformedResponse)?,
			);
			token_set(token, Some(&email), self.clock.now())
		}
		.boxed()
	}
}

async fn prompt_email(driver: &LoginDriver) -> Result<SecretString, OAuthError> {
	driver
		.emit(AuthEvent::Prompt(AuthPrompt {
			id:      sf!("perplexity-email"),
			message: sf!("Enter your Perplexity email address"),
			input:   AuthPromptKind::PlainText,
		}))
		.await?;
	let input = driver.receive().await?;
	let AuthInput::PlainText(email) = input else {
		return if matches!(input, AuthInput::Cancel) {
			Err(OAuthError::Cancelled)
		} else {
			Err(OAuthError::UnexpectedInput)
		};
	};
	let email = SecretString::from(email.trim().as_str());
	if email.expose_secret().is_empty() {
		Err(OAuthError::MalformedResponse)
	} else {
		Ok(email)
	}
}

async fn prompt_otp(driver: &LoginDriver) -> Result<SecretString, OAuthError> {
	driver
		.emit(AuthEvent::Prompt(AuthPrompt {
			id:      sf!("perplexity-otp"),
			message: sf!("Enter the code sent to your email"),
			input:   AuthPromptKind::AuthorizationCode,
		}))
		.await?;
	let input = driver.receive().await?;
	let AuthInput::AuthorizationCode(otp) = input else {
		return if matches!(input, AuthInput::Cancel) {
			Err(OAuthError::Cancelled)
		} else {
			Err(OAuthError::UnexpectedInput)
		};
	};
	let otp = SecretString::from(otp.expose_secret().trim().to_owned());
	if otp.expose_secret().is_empty() {
		Err(OAuthError::MalformedResponse)
	} else {
		Ok(otp)
	}
}

fn request_headers(json: bool, cookies: &CookieJar) -> Result<HeaderMap, OAuthError> {
	let mut headers = HeaderMap::new();
	headers.insert(USER_AGENT, HeaderValue::from_static(APP_USER_AGENT));
	headers.insert("x-app-apiversion", HeaderValue::from_static(API_VERSION));
	if json {
		headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
	}
	if let Some(mut cookie) = cookies.header_value()? {
		cookie.set_sensitive(true);
		headers.insert(COOKIE, cookie);
	}
	Ok(headers)
}

#[derive(Default)]
struct CookieJar {
	values: Vec<(String, SecretString)>,
}

impl fmt::Debug for CookieJar {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("CookieJar")
			.field("count", &self.values.len())
			.field("values", &"[REDACTED]")
			.finish()
	}
}

impl CookieJar {
	fn remember(&mut self, headers: &HeaderMap) {
		for header in headers.get_all(SET_COOKIE) {
			let Ok(header) = header.to_str() else {
				continue;
			};
			let (pair, attributes) = header.split_once(';').unwrap_or((header, ""));
			let Some((name, value)) = pair.split_once('=') else {
				continue;
			};
			let name = name.trim();
			if name.is_empty() {
				continue;
			}
			let expired = attributes.split(';').any(|attribute| {
				let Some((attribute, value)) = attribute.trim().split_once('=') else {
					return false;
				};
				attribute.eq_ignore_ascii_case("max-age")
					&& value
						.trim()
						.parse::<i64>()
						.is_ok_and(|seconds| seconds <= 0)
			});
			if let Some(index) = self
				.values
				.iter()
				.position(|(candidate, _)| candidate == name)
			{
				if expired {
					self.values.remove(index);
				} else {
					self.values[index].1 = SecretString::from(value.trim().to_owned());
				}
			} else if !expired {
				self
					.values
					.push((name.to_owned(), SecretString::from(value.trim().to_owned())));
			}
		}
	}

	fn header_value(&self) -> Result<Option<HeaderValue>, OAuthError> {
		if self.values.is_empty() {
			return Ok(None);
		}
		let mut header = Zeroizing::new(String::new());
		for (index, (name, value)) in self.values.iter().enumerate() {
			if index != 0 {
				header.push_str("; ");
			}
			header.push_str(name);
			header.push('=');
			header.push_str(value.expose_secret());
		}
		HeaderValue::from_str(&header)
			.map(Some)
			.map_err(|_| OAuthError::MalformedResponse)
	}
}

#[derive(Deserialize)]
struct CsrfResponse {
	#[serde(rename = "csrfToken")]
	csrf_token: Option<String>,
}

#[derive(Serialize)]
struct SendCodeRequest<'a> {
	email:      &'a str,
	#[serde(rename = "csrfToken")]
	csrf_token: &'a str,
}

#[derive(Serialize)]
struct VerifyCodeRequest<'a> {
	email:      &'a str,
	otp:        &'a str,
	#[serde(rename = "csrfToken")]
	csrf_token: &'a str,
}

#[derive(Deserialize)]
struct VerifyResponse {
	token:           Option<String>,
	/// OTP challenge variant of the login token; preferred when present.
	challenge_token: Option<String>,
	status:          Option<String>,
	error_code:      Option<String>,
}

#[derive(Serialize)]
struct IdentityResponse<'a> {
	principal: &'a str,
}

fn secret_json(value: &impl Serialize) -> Result<SecretString, OAuthError> {
	serde_json::to_string(value)
		.map(SecretString::from)
		.map_err(|_| OAuthError::MalformedResponse)
}

fn token_set(
	token: SecretString,
	email: Option<&SecretString>,
	now: SystemTime,
) -> Result<OAuthTokenSet, OAuthError> {
	let claims = jwt_claims(token.expose_secret());
	let expires_in = jwt_expiry_from_claims(claims.as_ref(), now);
	let principal = match email {
		Some(email) => email.expose_secret(),
		None => claims
			.as_ref()
			.and_then(|claims| claims.email.as_ref().or(claims.sub.as_ref()))
			.map_or("perplexity", |principal| principal.expose_secret()),
	};
	let identity_response = secret_json(&IdentityResponse { principal })?;
	let refresh_token = SecretString::from(token.expose_secret().to_owned());
	Ok(OAuthTokenSet {
		access_token: token,
		refresh_token: Some(refresh_token),
		token_type: sf!("Bearer"),
		expires_in: Some(expires_in),
		identity_response,
		project: None,
	})
}

#[cfg(test)]
fn jwt_expiry(token: &str, now: SystemTime) -> Duration {
	let claims = jwt_claims(token);
	jwt_expiry_from_claims(claims.as_ref(), now)
}

fn jwt_expiry_from_claims(claims: Option<&JwtClaims>, now: SystemTime) -> Duration {
	let since_epoch = now
		.duration_since(SystemTime::UNIX_EPOCH)
		.unwrap_or(Duration::ZERO);
	claims
		.and_then(|claims| claims.exp)
		.and_then(jwt_absolute_expiry)
		.unwrap_or_else(|| Duration::from_millis(NEVER_EXPIRES_MILLIS))
		.saturating_sub(since_epoch)
}

fn jwt_absolute_expiry(exp: f64) -> Option<Duration> {
	if !exp.is_finite() {
		return None;
	}
	if exp <= 0.0 {
		return Some(Duration::ZERO);
	}
	Some(
		Duration::try_from_secs_f64(exp)
			.ok()?
			.checked_sub(EXPIRY_SAFETY_MARGIN)
			.unwrap_or(Duration::ZERO),
	)
}

fn jwt_claims(token: &str) -> Option<JwtClaims> {
	let mut parts = token.split('.');
	let _header = parts.next()?;
	let payload = parts.next()?;
	let _signature = parts.next()?;
	if parts.next().is_some() {
		return None;
	}
	let decoded = Zeroizing::new(
		base64_url::decode_raw(payload.trim_end_matches('=').as_bytes())
			.into_vec()
			.ok()?,
	);
	let raw: RawJwtClaims = serde_json::from_slice(&decoded).ok()?;
	Some(JwtClaims {
		exp:   raw.exp,
		email: raw
			.email
			.filter(|value| !value.is_empty())
			.map(SecretString::from),
		sub:   raw
			.sub
			.filter(|value| !value.is_empty())
			.map(SecretString::from),
	})
}

struct JwtClaims {
	exp:   Option<f64>,
	email: Option<SecretString>,
	sub:   Option<SecretString>,
}

#[derive(Deserialize)]
struct RawJwtClaims {
	exp:   Option<f64>,
	email: Option<String>,
	sub:   Option<String>,
}

fn borrow_native_token() -> Option<SecretString> {
	#[cfg(not(target_os = "macos"))]
	{
		None
	}
	#[cfg(target_os = "macos")]
	{
		use std::{mem, str};
		let mut output = Command::new("defaults")
			.args(["read", NATIVE_APP_BUNDLE, "authToken"])
			.output()
			.ok()?;
		let stdout = Zeroizing::new(mem::take(&mut output.stdout));
		if !output.status.success() {
			return None;
		}
		let token = str::from_utf8(&stdout).ok()?.trim();
		if token.is_empty() || token == "(null)" {
			return None;
		}
		Some(SecretString::from(token.to_owned()))
	}
}

#[cfg(test)]
mod tests {
	use std::{collections::VecDeque, sync::Arc};

	use http::header::SET_COOKIE;
	use parking_lot::Mutex;

	use super::*;
	use crate::{
		answer::{AuthResponse, AuthSession},
		auth::{
			CredentialSourceSpec, OAuthClientSpec as AuthOAuthClientSpec, OAuthHttpResponse,
			OAuthRefreshSpec, OAuthTransportError, login::default_login_channels,
			spec::HeaderPlacement,
		},
		id::LoginSessionId,
	};

	struct FixedClock(SystemTime);

	impl OAuthClock for FixedClock {
		fn now(&self) -> SystemTime {
			self.0
		}

		fn sleep(&self, _: Duration) -> BoxFuture<'_, ()> {
			async {}.boxed()
		}
	}

	struct RecordedRequest {
		method:  Method,
		url:     String,
		headers: HeaderMap,
		body:    Option<SecretString>,
	}

	struct ScriptedHttp {
		responses: Mutex<VecDeque<OAuthHttpResponse>>,
		requests:  Mutex<Vec<RecordedRequest>>,
	}

	impl OAuthHttpClient for ScriptedHttp {
		fn execute(
			&self,
			request: OAuthHttpRequest,
		) -> BoxFuture<'_, Result<OAuthHttpResponse, OAuthTransportError>> {
			let (method, url, headers, body) = request.into_parts();
			self
				.requests
				.lock()
				.push(RecordedRequest { method, url: url.to_string(), headers, body });
			let response = self
				.responses
				.lock()
				.pop_front()
				.expect("scripted response");
			async move { Ok(response) }.boxed()
		}
	}

	fn response(status: u16, body: &str, cookies: &[&str]) -> OAuthHttpResponse {
		let mut headers = HeaderMap::new();
		for cookie in cookies {
			headers.append(SET_COOKIE, HeaderValue::from_str(cookie).expect("cookie"));
		}
		OAuthHttpResponse { status, headers, body: SecretString::from(body.to_owned()) }
	}

	fn spec() -> OAuthCustomSpec {
		OAuthCustomSpec {
			client:        AuthOAuthClientSpec {
				sources:      vec![CredentialSourceSpec::Interactive],
				client_id:    "perplexity".into(),
				refresh:      OAuthRefreshSpec::TokenEndpoint,
				token_url:    "https://www.perplexity.test/api/auth/signin-otp".into(),
				scopes:       Vec::new(),
				audience:     None,
				token_params: Vec::new(),
				placement:    HeaderPlacement::bearer().into(),
			},
			authorize_url: "https://www.perplexity.test/api/auth/signin-email".into(),
			exchange:      OAuthExchangeKind::PerplexityEmailOtp,
			parameters:    vec![crate::auth::OAuthParameter {
				name:  "csrf_url".into(),
				value: "https://www.perplexity.test/api/auth/csrf".into(),
			}],
			polling:       None,
		}
	}

	fn no_borrow() -> Option<SecretString> {
		None
	}

	fn handler(http: Arc<ScriptedHttp>, now: SystemTime) -> PerplexityEmailOtp {
		PerplexityEmailOtp { http, clock: Arc::new(FixedClock(now)), borrow: no_borrow }
	}

	async fn next_prompt(session: &AuthSession) -> AuthPrompt {
		let event = session
			.events
			.recv_async()
			.await
			.expect("event")
			.expect("successful event");
		let AuthEvent::Prompt(prompt) = event else {
			panic!("expected prompt")
		};
		prompt
	}

	async fn respond(session: &AuthSession, input: AuthInput) {
		session
			.responses
			.send_async(AuthResponse { session: session.id.clone(), input })
			.await
			.expect("response");
	}

	#[tokio::test]
	async fn email_otp_preserves_prompt_order_headers_cookies_expiry_and_identity() {
		let exp = 4_000_u64;
		let payload = base64_url::encode_raw(format!(r#"{{"exp":{exp}}}"#).as_bytes()).into_string();
		let jwt = format!("header.{payload}.signature");
		let http = Arc::new(ScriptedHttp {
			responses: Mutex::new(VecDeque::from([
				response(200, r#"{"csrfToken":"csrf-secret"}"#, &["csrf-cookie=first; Path=/"]),
				response(200, "{}", &["session-cookie=second; Path=/"]),
				response(200, &format!(r#"{{"token":"{jwt}"}}"#), &[]),
			])),
			requests:  Mutex::new(Vec::new()),
		});
		let handler = handler(http.clone(), SystemTime::UNIX_EPOCH + Duration::from_secs(1_000));
		let (session, driver, _) = default_login_channels(LoginSessionId::from("perplexity"));
		let interaction = async {
			let email = next_prompt(&session).await;
			assert_eq!(email.id, "perplexity-email");
			assert_eq!(email.message, "Enter your Perplexity email address");
			assert_eq!(email.input, AuthPromptKind::PlainText);
			respond(&session, AuthInput::PlainText("  user@example.com  ".into())).await;
			let otp = next_prompt(&session).await;
			assert_eq!(otp.id, "perplexity-otp");
			assert_eq!(otp.input, AuthPromptKind::AuthorizationCode);
			respond(&session, AuthInput::AuthorizationCode(SecretString::from(" 123456 ".to_owned())))
				.await;
		};
		let spec = spec();
		let (tokens, ()) = futures::join!(handler.exchange(&spec, &driver), interaction);
		let tokens = tokens.expect("tokens");
		assert!(tokens.is_refreshable());
		assert_eq!(tokens.expires_in(), Some(Duration::from_secs(exp - 300 - 1_000)));
		assert_eq!(tokens.identity_response.expose_secret(), r#"{"principal":"user@example.com"}"#);
		let debug = format!("{handler:?} {tokens:?}");
		assert!(!debug.contains("user@example.com"));
		assert!(!debug.contains(&jwt));

		let requests = http.requests.lock();
		assert_eq!(requests.len(), 3);
		assert_eq!(requests[0].method, Method::GET);
		assert_eq!(requests[0].url, "https://www.perplexity.test/api/auth/csrf");
		assert!(requests[0].headers.get(COOKIE).is_none());
		assert_eq!(requests[1].method, Method::POST);
		assert_eq!(requests[1].headers[USER_AGENT], APP_USER_AGENT);
		assert_eq!(requests[1].headers["x-app-apiversion"], API_VERSION);
		assert_eq!(requests[1].headers[CONTENT_TYPE], "application/json");
		assert_eq!(requests[1].headers[COOKIE], "csrf-cookie=first");
		assert_eq!(requests[2].headers[COOKIE], "csrf-cookie=first; session-cookie=second");
		assert_eq!(
			requests[1]
				.body
				.as_ref()
				.expect("send body")
				.expose_secret(),
			r#"{"email":"user@example.com","csrfToken":"csrf-secret"}"#,
		);
		assert_eq!(
			requests[2]
				.body
				.as_ref()
				.expect("verify body")
				.expose_secret(),
			r#"{"email":"user@example.com","otp":"123456","csrfToken":"csrf-secret"}"#,
		);
	}

	#[tokio::test]
	async fn challenge_token_and_rejection_markers_drive_verify_acceptance() {
		for (body, accepted) in [
			// OTP challenge variant of the login token is accepted.
			(r#"{"challenge_token":"header.e30.signature","status":"success"}"#, true),
			// Plain token responses keep working, with or without a status.
			(r#"{"token":"header.e30.signature"}"#, true),
			// Empty challenge token falls back to the plain token.
			(r#"{"challenge_token":"","token":"header.e30.signature"}"#, true),
			// Explicit rejection markers invalidate an otherwise 2xx body.
			(r#"{"token":"header.e30.signature","status":"failed"}"#, false),
			(r#"{"token":"header.e30.signature","error_code":"otp_expired"}"#, false),
			// A body with neither token form is malformed.
			(r#"{"status":"success"}"#, false),
		] {
			let http = Arc::new(ScriptedHttp {
				responses: Mutex::new(VecDeque::from([
					response(200, r#"{"csrfToken":"csrf"}"#, &[]),
					response(200, "{}", &[]),
					response(200, body, &[]),
				])),
				requests:  Mutex::new(Vec::new()),
			});
			let handler = handler(http, SystemTime::UNIX_EPOCH);
			let (session, driver, _) =
				default_login_channels(LoginSessionId::from(format!("challenge-{accepted}-{body}")));
			let interaction = async {
				let _ = next_prompt(&session).await;
				respond(&session, AuthInput::PlainText("user@example.com".into())).await;
				let _ = next_prompt(&session).await;
				respond(
					&session,
					AuthInput::AuthorizationCode(SecretString::from("123456".to_owned())),
				)
				.await;
			};
			let spec = spec();
			let (result, ()) = futures::join!(handler.exchange(&spec, &driver), interaction);
			if accepted {
				let tokens = result.unwrap_or_else(|error| panic!("{body}: {error:?}"));
				assert_eq!(tokens.access_token.expose_secret(), "header.e30.signature");
			} else {
				assert!(
					matches!(result, Err(OAuthError::MalformedResponse)),
					"{body}: expected typed rejection"
				);
			}
		}
	}

	#[tokio::test]
	async fn otp_rejection_is_typed_and_does_not_expose_provider_text() {
		let http = Arc::new(ScriptedHttp {
			responses: Mutex::new(VecDeque::from([
				response(200, r#"{"csrfToken":"csrf"}"#, &[]),
				response(200, "{}", &[]),
				response(401, r#"{"error_code":"bad_otp","text":"provider-secret-reason"}"#, &[]),
			])),
			requests:  Mutex::new(Vec::new()),
		});
		let handler = handler(http, SystemTime::UNIX_EPOCH);
		let (session, driver, _) = default_login_channels(LoginSessionId::from("otp-error"));
		let interaction = async {
			let _ = next_prompt(&session).await;
			respond(&session, AuthInput::PlainText("user@example.com".into())).await;
			let _ = next_prompt(&session).await;
			respond(&session, AuthInput::AuthorizationCode(SecretString::from("wrong".to_owned())))
				.await;
		};
		let spec = spec();
		let (error, ()) = futures::join!(handler.exchange(&spec, &driver), interaction);
		let error = error.expect_err("OTP rejection");
		assert!(matches!(error, OAuthError::Provider { status: 401, .. }));
		assert!(!format!("{error:?} {error}").contains("provider-secret-reason"));
	}

	#[tokio::test]
	async fn empty_otp_is_rejected_before_token_exchange() {
		let http = Arc::new(ScriptedHttp {
			responses: Mutex::new(VecDeque::from([
				response(200, r#"{"csrfToken":"csrf"}"#, &[]),
				response(200, "{}", &[]),
			])),
			requests:  Mutex::new(Vec::new()),
		});
		let handler = handler(http.clone(), SystemTime::UNIX_EPOCH);
		let (session, driver, _) = default_login_channels(LoginSessionId::from("empty-otp"));
		let interaction = async {
			let _ = next_prompt(&session).await;
			respond(&session, AuthInput::PlainText("user@example.com".into())).await;
			let _ = next_prompt(&session).await;
			respond(&session, AuthInput::AuthorizationCode(SecretString::from("   ".to_owned())))
				.await;
		};
		let spec = spec();
		let (error, ()) = futures::join!(handler.exchange(&spec, &driver), interaction);
		assert!(matches!(error, Err(OAuthError::MalformedResponse)));
		assert_eq!(http.requests.lock().len(), 2);
	}

	#[tokio::test]
	async fn cancellation_at_email_prompt_stops_before_http() {
		let http = Arc::new(ScriptedHttp {
			responses: Mutex::new(VecDeque::new()),
			requests:  Mutex::new(Vec::new()),
		});
		let handler = handler(http.clone(), SystemTime::UNIX_EPOCH);
		let (session, driver, _) = default_login_channels(LoginSessionId::from("cancel"));
		let interaction = async {
			let _ = next_prompt(&session).await;
			respond(&session, AuthInput::Cancel).await;
		};
		let spec = spec();
		let (error, ()) = futures::join!(handler.exchange(&spec, &driver), interaction);
		assert!(matches!(error, Err(OAuthError::Cancelled)));
		assert!(http.requests.lock().is_empty());
	}

	#[test]
	fn borrowed_jwt_principal_prefers_email_then_sub_then_static_fallback() {
		fn jwt(payload: &str) -> SecretString {
			let payload = base64_url::encode_raw(payload.as_bytes()).into_string();
			SecretString::from(format!("header.{payload}.signature"))
		}

		let email = token_set(
			jwt(r#"{"email":"borrowed@example.com","sub":"subject"}"#),
			None,
			SystemTime::UNIX_EPOCH,
		)
		.expect("email claims");
		assert_eq!(
			email.identity_response.expose_secret(),
			r#"{"principal":"borrowed@example.com"}"#
		);

		let subject = token_set(jwt(r#"{"sub":"subject"}"#), None, SystemTime::UNIX_EPOCH)
			.expect("subject claim");
		assert_eq!(subject.identity_response.expose_secret(), r#"{"principal":"subject"}"#);

		let fallback = token_set(jwt("{}"), None, SystemTime::UNIX_EPOCH).expect("fallback");
		assert_eq!(fallback.identity_response.expose_secret(), r#"{"principal":"perplexity"}"#);
		let debug = format!("{email:?} {subject:?} {fallback:?}");
		assert!(!debug.contains("borrowed@example.com"));
		assert!(!debug.contains("subject"));
	}

	#[test]
	fn malformed_or_exp_less_jwt_uses_far_future_fallback() {
		let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
		let expected = Duration::from_millis(NEVER_EXPIRES_MILLIS).saturating_sub(
			now.duration_since(SystemTime::UNIX_EPOCH)
				.expect("after epoch"),
		);
		assert_eq!(jwt_expiry("not-a-jwt", now), expected);
		let payload = base64_url::encode_raw(br"{}").into_string();
		assert_eq!(jwt_expiry(&format!("header.{payload}.signature"), now), expected);
	}
}
