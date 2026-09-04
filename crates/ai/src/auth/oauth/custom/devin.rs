//! Devin CLI browser authorization and JSON token exchange.

use std::{
	mem,
	sync::Arc,
	time::{Duration, SystemTime},
};

use futures::{FutureExt as _, future::BoxFuture};
use http::{
	HeaderMap, HeaderValue, Method,
	header::{ACCEPT, CONTENT_TYPE},
};
use omp_catalog::provider::OAuthExchangeKind;
use omp_core::{ExposeSecret as _, SecretString, Str, base64_url, sf};
use ring::rand::{SecureRandom as _, SystemRandom};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use zeroize::Zeroizing;

use super::super::{
	OAuthClock, OAuthCustomDispatchError, OAuthCustomDispatcher, OAuthCustomHandler, OAuthError,
	OAuthHttpClient, OAuthHttpRequest, OAuthTokenSet, PkcePending, callback_code, parse_http_url,
	provider_error, receive_callback_input, start_callback_server,
};
use crate::{
	answer::{AuthEvent, AuthPrompt, AuthPromptKind},
	auth::{
		login::LoginDriver,
		spec::{OAuthCustomSpec, PkceCompletion},
	},
	call::AuthInput,
};

const JSON_CONTENT_TYPE: &str = "application/json";
const FALLBACK_EXPIRES: Duration = Duration::from_days(365);
const JWT_EXPIRY_SKEW_SECONDS: f64 = 5.0 * 60.0;
const PKCE_VERIFIER_BYTES: usize = 96;

/// Registers Devin's catalog-selected CLI token exchange.
pub(super) fn register(
	dispatcher: &mut OAuthCustomDispatcher,
	http: Arc<dyn OAuthHttpClient>,
	clock: Arc<dyn OAuthClock>,
) -> Result<(), OAuthCustomDispatchError> {
	dispatcher.register(Arc::new(DevinCliTokenHandler { http, clock }))
}

struct DevinCliTokenHandler {
	http:  Arc<dyn OAuthHttpClient>,
	clock: Arc<dyn OAuthClock>,
}

impl OAuthCustomHandler for DevinCliTokenHandler {
	fn exchange_kind(&self) -> OAuthExchangeKind {
		OAuthExchangeKind::DevinCliToken
	}

	fn exchange<'a>(
		&'a self,
		spec: &'a OAuthCustomSpec,
		driver: &'a LoginDriver,
	) -> BoxFuture<'a, Result<OAuthTokenSet, OAuthError>> {
		async move {
			let mut pending = self.begin(spec, driver).await?;
			let input = receive_callback_input(driver, pending.callback_server.take()).await?;
			let (AuthInput::CallbackUrl(callback) | AuthInput::AuthorizationCode(callback)) = input
			else {
				return Err(OAuthError::UnexpectedInput);
			};
			let code = callback_code(&callback, &pending.state)?;
			self.exchange_code(spec, code, pending.verifier).await
		}
		.boxed()
	}
}

impl DevinCliTokenHandler {
	async fn begin(
		&self,
		spec: &OAuthCustomSpec,
		driver: &LoginDriver,
	) -> Result<PkcePending, OAuthError> {
		let redirect_uri = custom_parameter(spec, "redirect_uri")?;
		let prompt = custom_parameter(spec, "prompt")?;
		let state = random_uuid_v4()?;
		let (verifier, challenge) = generate_pkce()?;
		let mut url = parse_http_url(&spec.authorize_url)?;
		{
			let mut query = url.query_pairs_mut();
			query
				.append_pair("redirect_uri", redirect_uri)
				.append_pair("state", &state)
				.append_pair("prompt", prompt)
				.append_pair("code_challenge", &challenge)
				.append_pair("code_challenge_method", "S256");
		}
		let callback_server = start_callback_server(redirect_uri, &state).await;

		let authorization_url = Str::new(url.as_str());
		if let Some(server) = &callback_server {
			server.arm(authorization_url.clone());
		}
		let launch = callback_server.as_ref().map(|server| server.launch_url());
		driver
			.emit(AuthEvent::OpenUrl { url: authorization_url, launch })
			.await?;
		driver
			.emit(AuthEvent::Prompt(AuthPrompt {
				id:      sf!("oauth-callback-url"),
				message: sf!("Paste the complete authorization callback URL"),
				input:   AuthPromptKind::AuthorizationCode,
			}))
			.await?;

		Ok(PkcePending {
			verifier,
			state,
			redirect_uri: Str::new(redirect_uri),
			completion: PkceCompletion::PasteCallbackUrl,
			callback_server,
		})
	}

	async fn exchange_code(
		&self,
		spec: &OAuthCustomSpec,
		code: SecretString,
		verifier: SecretString,
	) -> Result<OAuthTokenSet, OAuthError> {
		let encoded = serde_json::to_string(&DevinExchangeBody {
			code:          code.expose_secret(),
			code_verifier: verifier.expose_secret(),
		})
		.map_err(|_| OAuthError::MalformedResponse)?;
		let mut encoded = Zeroizing::new(encoded);
		let body = SecretString::from(mem::take(&mut *encoded));
		let mut headers = HeaderMap::new();
		headers.insert(ACCEPT, HeaderValue::from_static(JSON_CONTENT_TYPE));
		headers.insert(CONTENT_TYPE, HeaderValue::from_static(JSON_CONTENT_TYPE));
		let request =
			OAuthHttpRequest::new(Method::POST, &spec.client.token_url, headers, Some(body))?;
		let response = self.http.execute(request).await?;
		if !(200..300).contains(&response.status) {
			return Err(provider_error(response.status, &response.body, false));
		}

		let parsed: DevinTokenResponse<'_> = serde_json::from_str(response.body.expose_secret())
			.map_err(|_| OAuthError::MalformedResponse)?;
		let token = parsed
			.token
			.filter(|token| !token.is_empty())
			.ok_or(OAuthError::MalformedResponse)?;
		let expires_in = token_lifetime(token, self.clock.now());
		let access_token = SecretString::from(token.to_owned());
		let refresh_token = SecretString::from(token.to_owned());
		Ok(OAuthTokenSet {
			access_token,
			refresh_token: Some(refresh_token),
			token_type: sf!("Bearer"),
			expires_in: Some(expires_in),
			identity_response: response.body,
			project: None,
		})
	}
}

#[derive(Serialize)]
struct DevinExchangeBody<'a> {
	code:          &'a str,
	code_verifier: &'a str,
}

#[derive(Deserialize)]
struct DevinTokenResponse<'a> {
	#[serde(borrow)]
	token: Option<&'a str>,
}

#[derive(Deserialize)]
struct JwtClaims {
	exp: Option<f64>,
}

fn custom_parameter<'a>(spec: &'a OAuthCustomSpec, name: &str) -> Result<&'a str, OAuthError> {
	spec
		.parameters
		.iter()
		.find(|parameter| parameter.name.as_str() == name)
		.map(|parameter| parameter.value.as_str())
		.filter(|value| !value.is_empty())
		.ok_or(OAuthError::MalformedResponse)
}

fn generate_pkce() -> Result<(SecretString, Str), OAuthError> {
	let mut bytes = Zeroizing::new([0_u8; PKCE_VERIFIER_BYTES]);
	SystemRandom::new()
		.fill(&mut bytes[..])
		.map_err(|_| OAuthError::Entropy)?;
	let verifier = SecretString::from(base64_url::encode_raw(&bytes[..]).into_string());
	let challenge = base64_url::encode_raw(&Sha256::digest(verifier.expose_secret().as_bytes()))
		.into_string()
		.into();
	Ok((verifier, challenge))
}

fn random_uuid_v4() -> Result<Str, OAuthError> {
	let mut bytes = Zeroizing::new([0_u8; 16]);
	SystemRandom::new()
		.fill(&mut bytes[..])
		.map_err(|_| OAuthError::Entropy)?;
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	let hex = b"0123456789abcdef";
	let mut output = String::with_capacity(36);
	for (index, byte) in bytes.iter().copied().enumerate() {
		if matches!(index, 4 | 6 | 8 | 10) {
			output.push('-');
		}
		output.push(char::from(hex[usize::from(byte >> 4)]));
		output.push(char::from(hex[usize::from(byte & 0x0f)]));
	}
	Ok(output.into())
}

fn token_lifetime(token: &str, now: SystemTime) -> Duration {
	decode_jwt_expiry(token, now).unwrap_or(FALLBACK_EXPIRES)
}

fn decode_jwt_expiry(token: &str, now: SystemTime) -> Option<Duration> {
	let payload = token
		.split('.')
		.nth(1)
		.filter(|payload| !payload.is_empty())?;
	let decoded = Zeroizing::new(base64_url::decode_raw(payload.as_bytes()).into_vec().ok()?);
	let claims: JwtClaims = serde_json::from_slice(&decoded).ok()?;
	let exp = claims.exp.filter(|exp| exp.is_finite())?;
	let now = now
		.duration_since(SystemTime::UNIX_EPOCH)
		.ok()?
		.as_secs_f64();
	let seconds = exp - JWT_EXPIRY_SKEW_SECONDS - now;
	if seconds <= 0.0 {
		return Some(Duration::ZERO);
	}
	if seconds > u64::MAX as f64 {
		return None;
	}
	let whole = seconds.trunc() as u64;
	let nanos = (seconds.fract() * 1_000_000_000.0) as u32;
	Some(Duration::new(whole, nanos))
}

#[cfg(test)]
mod tests {
	use std::{fmt, sync::Arc};

	use http::header::{ACCEPT, CONTENT_TYPE};
	use parking_lot::Mutex;
	use serde_json::Value;
	use url::Url;

	use super::{
		super::super::{OAuthHttpResponse, OAuthTransportError},
		*,
	};
	use crate::{
		answer::{AuthEvent, AuthResponse, AuthSession as AnswerAuthSession},
		auth::{
			CredentialSourceSpec, HeaderPlacement, OAuthClientSpec, OAuthParameter, OAuthRefreshSpec,
			login::default_login_channels,
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
		body:    SecretString,
	}

	impl fmt::Debug for RecordedRequest {
		fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
			formatter.write_str("RecordedRequest([REDACTED])")
		}
	}

	struct ScriptedHttp {
		response: Mutex<Option<OAuthHttpResponse>>,
		request:  Mutex<Option<RecordedRequest>>,
	}

	impl ScriptedHttp {
		fn responding(status: u16, body: String) -> Self {
			Self {
				response: Mutex::new(Some(OAuthHttpResponse {
					status,
					headers: HeaderMap::new(),
					body: SecretString::from(body),
				})),
				request:  Mutex::new(None),
			}
		}
	}

	impl OAuthHttpClient for ScriptedHttp {
		fn execute(
			&self,
			request: OAuthHttpRequest,
		) -> BoxFuture<'_, Result<OAuthHttpResponse, OAuthTransportError>> {
			let (method, url, headers, body) = request.into_parts();
			*self.request.lock() = Some(RecordedRequest {
				method,
				url: url.to_string(),
				headers,
				body: body.expect("JSON request body"),
			});
			let response = self.response.lock().take().expect("scripted response");
			async move { Ok(response) }.boxed()
		}
	}

	fn spec() -> OAuthCustomSpec {
		OAuthCustomSpec {
			client:        OAuthClientSpec {
				sources:      vec![CredentialSourceSpec::Interactive],
				client_id:    "".into(),
				refresh:      OAuthRefreshSpec::TokenEndpoint,
				token_url:    "https://api.devin.example/auth/cli/token".into(),
				scopes:       Vec::new(),
				audience:     None,
				token_params: Vec::new(),
				placement:    HeaderPlacement::bearer().into(),
			},
			authorize_url: "https://app.devin.example/auth/cli/continue".into(),
			exchange:      OAuthExchangeKind::DevinCliToken,
			parameters:    vec![
				OAuthParameter { name: "prompt".into(), value: "select_account".into() },
				OAuthParameter {
					name:  "redirect_uri".into(),
					value: "http://127.0.0.1:59653/callback".into(),
				},
			],
			polling:       None,
		}
	}

	fn handler(http: Arc<ScriptedHttp>, now: SystemTime) -> DevinCliTokenHandler {
		DevinCliTokenHandler { http, clock: Arc::new(FixedClock(now)) }
	}

	async fn answer_callback(session: &AnswerAuthSession) -> (String, String) {
		let AuthEvent::OpenUrl { url, .. } = session
			.events
			.recv_async()
			.await
			.expect("URL event")
			.expect("successful URL event")
		else {
			panic!("expected URL event");
		};
		let parsed = Url::parse(&url).expect("authorization URL");
		let state = parsed
			.query_pairs()
			.find(|(name, _)| name == "state")
			.expect("state")
			.1
			.into_owned();
		let AuthEvent::Prompt(prompt) = session
			.events
			.recv_async()
			.await
			.expect("prompt event")
			.expect("successful prompt event")
		else {
			panic!("expected prompt event");
		};
		assert_eq!(prompt.id.as_str(), "oauth-callback-url");
		assert_eq!(prompt.input, AuthPromptKind::AuthorizationCode);
		let callback =
			format!("http://127.0.0.1:59653/callback?code=authorization-code&state={state}");
		session
			.responses
			.send_async(AuthResponse {
				session: session.id.clone(),
				input:   AuthInput::AuthorizationCode(SecretString::from(callback)),
			})
			.await
			.expect("callback response");
		(url.to_string(), state)
	}

	#[tokio::test]
	async fn auth_url_json_exchange_expiry_identity_and_redaction_match_devin_wire() {
		let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
		let payload = base64_url::encode_raw(br#"{"exp":5000}"#).into_string();
		let token = format!("header.{payload}.signature");
		let identity = serde_json::json!({ "token": token.clone() }).to_string();
		let http = Arc::new(ScriptedHttp::responding(200, identity.clone()));
		let handler = handler(Arc::clone(&http), now);
		let spec = spec();
		let (session, driver, _) = default_login_channels(LoginSessionId::from("devin-success"));
		let exchange = handler.exchange(&spec, &driver);
		let responder = answer_callback(&session);
		let (result, (authorization_url, state)) = futures::join!(exchange, responder);
		let tokens = result.expect("Devin tokens");

		let parsed = Url::parse(&authorization_url).expect("authorization URL");
		let pairs = parsed
			.query_pairs()
			.map(|(name, value)| (name.into_owned(), value.into_owned()))
			.collect::<Vec<_>>();
		assert_eq!(parsed.path(), "/auth/cli/continue");
		assert_eq!(
			pairs[0],
			("redirect_uri".to_owned(), "http://127.0.0.1:59653/callback".to_owned())
		);
		assert_eq!(pairs[1], ("state".to_owned(), state.clone()));
		assert_eq!(pairs[2], ("prompt".to_owned(), "select_account".to_owned()));
		assert_eq!(pairs[4], ("code_challenge_method".to_owned(), "S256".to_owned()));
		assert_eq!(state.len(), 36);
		assert_eq!(&state[14..15], "4");
		assert_eq!(tokens.expires_in(), Some(Duration::from_secs(3_700)));
		assert!(tokens.is_refreshable());
		assert_eq!(tokens.identity_response.expose_secret(), &identity);
		assert!(!format!("{tokens:?}").contains(&token));
		let bundle = tokens.into_stored_bundle();
		assert_eq!(bundle.access_token.expose_secret(), &token);
		assert_eq!(
			bundle
				.refresh_token
				.as_ref()
				.map(|value| value.expose_secret()),
			Some(token.as_str()),
		);

		let request = http.request.lock();
		let request = request.as_ref().expect("recorded request");
		assert_eq!(request.method, Method::POST);
		assert_eq!(request.url, "https://api.devin.example/auth/cli/token");
		assert_eq!(request.headers.len(), 2);
		assert_eq!(request.headers.get(ACCEPT), Some(&HeaderValue::from_static("application/json")));
		assert_eq!(
			request.headers.get(CONTENT_TYPE),
			Some(&HeaderValue::from_static("application/json"))
		);
		let body: Value = serde_json::from_str(request.body.expose_secret()).expect("request JSON");
		assert_eq!(body.get("code").and_then(Value::as_str), Some("authorization-code"));
		let verifier = body
			.get("code_verifier")
			.and_then(Value::as_str)
			.expect("verifier");
		assert_eq!(verifier.len(), 128);
		let expected_challenge =
			base64_url::encode_raw(&Sha256::digest(verifier.as_bytes())).into_string();
		assert_eq!(pairs[3], ("code_challenge".to_owned(), expected_challenge));
	}

	#[tokio::test]
	async fn callback_state_mismatch_fails_before_token_exchange() {
		let http = Arc::new(ScriptedHttp::responding(200, r#"{"token":"unused"}"#.to_owned()));
		let handler = handler(Arc::clone(&http), SystemTime::UNIX_EPOCH);
		let spec = spec();
		let (session, driver, _) = default_login_channels(LoginSessionId::from("devin-state"));
		let exchange = handler.exchange(&spec, &driver);
		let responder = async {
			let _ = session
				.events
				.recv_async()
				.await
				.expect("URL")
				.expect("URL event");
			let _ = session
				.events
				.recv_async()
				.await
				.expect("prompt")
				.expect("prompt event");
			session
				.responses
				.send_async(AuthResponse {
					session: session.id.clone(),
					input:   AuthInput::AuthorizationCode(SecretString::from(
						"http://127.0.0.1:59653/callback?code=secret-code&state=wrong".to_owned(),
					)),
				})
				.await
				.expect("callback response");
		};
		let (result, ()) = futures::join!(exchange, responder);
		assert_eq!(result.expect_err("state mismatch"), OAuthError::StateMismatch);
		assert!(http.request.lock().is_none());
	}

	#[tokio::test]
	async fn empty_token_is_rejected_and_non_jwt_uses_fallback_expiry() {
		assert_eq!(token_lifetime("opaque-token", SystemTime::UNIX_EPOCH), FALLBACK_EXPIRES);
		let http = Arc::new(ScriptedHttp::responding(200, r#"{"token":""}"#.to_owned()));
		let handler = handler(Arc::clone(&http), SystemTime::UNIX_EPOCH);
		let spec = spec();
		let (session, driver, _) = default_login_channels(LoginSessionId::from("devin-empty"));
		let (result, _) = futures::join!(handler.exchange(&spec, &driver), answer_callback(&session));
		assert_eq!(result.expect_err("empty token"), OAuthError::MalformedResponse);
	}

	#[tokio::test]
	async fn cancellation_stops_before_private_exchange() {
		let http = Arc::new(ScriptedHttp::responding(200, r#"{"token":"unused"}"#.to_owned()));
		let handler = handler(Arc::clone(&http), SystemTime::UNIX_EPOCH);
		let spec = spec();
		let (session, driver, _) = default_login_channels(LoginSessionId::from("devin-cancel"));
		session
			.responses
			.send(AuthResponse { session: session.id.clone(), input: AuthInput::Cancel })
			.expect("cancel response");
		let error = handler
			.exchange(&spec, &driver)
			.await
			.expect_err("cancelled");
		assert_eq!(error, OAuthError::Cancelled);
		assert!(http.request.lock().is_none());
	}

	#[tokio::test]
	async fn provider_response_text_is_never_retained_in_errors() {
		let secret = "provider-secret-error-text";
		let http = Arc::new(ScriptedHttp::responding(500, secret.to_owned()));
		let handler = handler(http, SystemTime::UNIX_EPOCH);
		let spec = spec();
		let (session, driver, _) = default_login_channels(LoginSessionId::from("devin-error"));
		let (result, _) = futures::join!(handler.exchange(&spec, &driver), answer_callback(&session));
		let error = result.expect_err("provider rejection");
		assert!(matches!(error, OAuthError::Provider { status: 500, .. }));
		assert!(!format!("{error:?} {error}").contains(secret));
	}

	#[tokio::test]
	async fn pending_pkce_debug_redacts_state_and_verifier() {
		let http = Arc::new(ScriptedHttp::responding(200, r#"{"token":"unused"}"#.to_owned()));
		let handler = handler(http, SystemTime::UNIX_EPOCH);
		let spec = spec();
		let (session, driver, _) = default_login_channels(LoginSessionId::from("devin-redaction"));
		let pending = handler.begin(&spec, &driver).await.expect("pending flow");
		let AuthEvent::OpenUrl { url, .. } = session
			.events
			.recv_async()
			.await
			.expect("URL")
			.expect("URL event")
		else {
			panic!("expected URL event");
		};
		let state = Url::parse(&url)
			.expect("authorization URL")
			.query_pairs()
			.find(|(name, _)| name == "state")
			.expect("state")
			.1
			.into_owned();
		let debug = format!("{pending:?}");
		assert!(!debug.contains(&state));
		assert!(!debug.contains(pending.verifier.expose_secret()));
		assert!(debug.contains("[REDACTED]"));
	}
}
