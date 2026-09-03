use std::{mem, sync::Arc, time::Duration};

use futures::{FutureExt, future::BoxFuture};
use http::{
	HeaderMap, HeaderName, HeaderValue, Method,
	header::{AUTHORIZATION, CONTENT_TYPE, USER_AGENT},
};
use omp_catalog::provider::OAuthExchangeKind;
use omp_core::{ExposeSecret, SecretString, Str, base64_url, sf};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use zeroize::{Zeroize, Zeroizing};

use super::super::{
	OAuthClock, OAuthCustomDispatchError, OAuthCustomDispatcher, OAuthCustomHandler, OAuthError,
	OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse, OAuthTokenSet, callback_code,
	parse_http_url, provider_error, receive_callback_input, start_callback_server,
};
use crate::{
	answer::{AuthEvent, AuthPrompt, AuthPromptKind},
	auth::{login::LoginDriver, spec::OAuthCustomSpec},
	call::AuthInput,
};

const BOOTSTRAP_URL_PARAMETER: &str = "bootstrap_url";
const REDIRECT_URI_PARAMETER: &str = "redirect_uri";
const JSON_CONTENT_TYPE: &str = "application/json";
const PROMPT: &str = "Complete login in your browser. If the browser cannot reach this machine, \
                      paste the final redirect URL or authorization code when prompted.";
const ANTHROPIC_BETA: HeaderName = HeaderName::from_static("anthropic-beta");
const OAUTH_BETA: &str = "oauth-2025-04-20";
const REFRESH_USER_AGENT: &str = "anthropic-sdk-typescript/0.94.0 userOAuthProvider";
const BOOTSTRAP_USER_AGENT: &str = "claude-code/2.1.258";

struct AnthropicPkceHandler {
	http: Arc<dyn OAuthHttpClient>,
}

impl OAuthCustomHandler for AnthropicPkceHandler {
	fn exchange_kind(&self) -> OAuthExchangeKind {
		OAuthExchangeKind::AnthropicPkce
	}

	fn exchange<'a>(
		&'a self,
		spec: &'a OAuthCustomSpec,
		driver: &'a LoginDriver,
	) -> BoxFuture<'a, Result<OAuthTokenSet, OAuthError>> {
		async move { exchange(self.http.as_ref(), spec, driver).await }.boxed()
	}

	fn refresh<'a>(
		&'a self,
		spec: &'a OAuthCustomSpec,
		refresh_token: SecretString,
	) -> BoxFuture<'a, Result<OAuthTokenSet, OAuthError>> {
		async move { refresh(self.http.as_ref(), spec, refresh_token).await }.boxed()
	}
}

pub(super) fn register(
	dispatcher: &mut OAuthCustomDispatcher,
	http: Arc<dyn OAuthHttpClient>,
	_clock: Arc<dyn OAuthClock>,
) -> Result<(), OAuthCustomDispatchError> {
	dispatcher.register(Arc::new(AnthropicPkceHandler { http }))
}

async fn exchange(
	http: &dyn OAuthHttpClient,
	spec: &OAuthCustomSpec,
	driver: &LoginDriver,
) -> Result<OAuthTokenSet, OAuthError> {
	let redirect_uri = spec
		.parameters
		.iter()
		.find(|parameter| parameter.name == REDIRECT_URI_PARAMETER)
		.map(|parameter| parameter.value.as_str())
		.filter(|value| !value.is_empty())
		.ok_or(OAuthError::InvalidUrl)?;
	parse_http_url(redirect_uri)?;

	let mut verifier_bytes = Zeroizing::new([0_u8; 32]);
	let mut state_bytes = Zeroizing::new([0_u8; 24]);
	let random = SystemRandom::new();
	random
		.fill(&mut verifier_bytes[..])
		.map_err(|_| OAuthError::Entropy)?;
	random
		.fill(&mut state_bytes[..])
		.map_err(|_| OAuthError::Entropy)?;
	let verifier = SecretString::from(base64_url::encode_raw(&verifier_bytes[..]).into_string());
	let state = Str::new(base64_url::encode_raw(&state_bytes[..]).into_string());
	let challenge =
		base64_url::encode_raw(&Sha256::digest(verifier.expose_secret().as_bytes())).into_string();

	let mut authorize_url = parse_http_url(&spec.authorize_url)?;
	{
		let mut query = authorize_url.query_pairs_mut();
		for parameter in spec.parameters.iter().filter(|parameter| {
			parameter.name != REDIRECT_URI_PARAMETER && parameter.name != BOOTSTRAP_URL_PARAMETER
		}) {
			query.append_pair(&parameter.name, &parameter.value);
		}
		query
			.append_pair("client_id", &spec.client.client_id)
			.append_pair("response_type", "code")
			.append_pair("redirect_uri", redirect_uri);
		if !spec.client.scopes.is_empty() {
			let scopes = spec
				.client
				.scopes
				.iter()
				.map(Str::as_str)
				.collect::<Vec<_>>()
				.join(" ");
			query.append_pair("scope", &scopes);
		}
		query
			.append_pair("code_challenge", &challenge)
			.append_pair("code_challenge_method", "S256")
			.append_pair("state", &state);
	}
	let callback_server = start_callback_server(redirect_uri, &state).await;
	let authorization_url = Str::new(authorize_url.as_str());
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
			message: sf!(PROMPT),
			input:   AuthPromptKind::AuthorizationCode,
		}))
		.await?;

	let code = match receive_callback_input(driver, callback_server).await? {
		AuthInput::CallbackUrl(callback) => callback_code(&callback, &state)?,
		AuthInput::AuthorizationCode(code) => authorization_code(code, &state)?,
		AuthInput::Cancel => return Err(OAuthError::Cancelled),
		_ => return Err(OAuthError::UnexpectedInput),
	};
	let request = post_json(
		&spec.client.token_url,
		&TokenRequest {
			grant_type: "authorization_code",
			client_id: &spec.client.client_id,
			code: code.expose_secret(),
			state: &state,
			redirect_uri,
			code_verifier: verifier.expose_secret(),
		},
		HeaderMap::new(),
	)?;
	let response = http.execute(request).await?;
	if !(200..300).contains(&response.status) {
		return Err(provider_error(response.status, &response.body, false));
	}
	let mut tokens = token_response(response, None, true)?;
	if !has_inline_email(&tokens.identity_response)
		&& let Ok(Some(identity)) = bootstrap_identity(http, spec, &tokens.access_token).await
	{
		tokens.identity_response = identity;
	}
	Ok(tokens)
}

async fn refresh(
	http: &dyn OAuthHttpClient,
	spec: &OAuthCustomSpec,
	refresh_token: SecretString,
) -> Result<OAuthTokenSet, OAuthError> {
	let mut headers = HeaderMap::new();
	headers.insert(ANTHROPIC_BETA, HeaderValue::from_static(OAUTH_BETA));
	headers.insert(USER_AGENT, HeaderValue::from_static(REFRESH_USER_AGENT));
	let request = post_json(
		&spec.client.token_url,
		&RefreshTokenRequest {
			grant_type:    "refresh_token",
			client_id:     &spec.client.client_id,
			refresh_token: refresh_token.expose_secret(),
		},
		headers,
	)?;
	let response = http.execute(request).await?;
	if !(200..300).contains(&response.status) {
		return Err(provider_error(response.status, &response.body, true));
	}
	token_response(response, Some(refresh_token), false)
}

fn post_json<T: Serialize + ?Sized>(
	url: &str,
	value: &T,
	mut headers: HeaderMap,
) -> Result<OAuthHttpRequest, OAuthError> {
	headers.insert(CONTENT_TYPE, HeaderValue::from_static(JSON_CONTENT_TYPE));
	let mut body =
		Zeroizing::new(serde_json::to_string(value).map_err(|_| OAuthError::MalformedResponse)?);
	OAuthHttpRequest::new(
		Method::POST,
		parse_http_url(url)?.as_str(),
		headers,
		Some(SecretString::from(mem::take(&mut *body))),
	)
	.map_err(Into::into)
}

fn token_response(
	response: OAuthHttpResponse,
	fallback_refresh: Option<SecretString>,
	require_refresh: bool,
) -> Result<OAuthTokenSet, OAuthError> {
	let parsed = Zeroizing::new(
		serde_json::from_str::<AnthropicTokenResponse>(response.body.expose_secret())
			.map_err(|_| OAuthError::MalformedResponse)?,
	);
	if parsed.error.is_some() {
		return Err(provider_error(response.status, &response.body, fallback_refresh.is_some()));
	}
	let access_token = required(parsed.access_token.as_deref())?;
	let refresh_token = parsed
		.refresh_token
		.as_deref()
		.filter(|value| !value.is_empty())
		.map(|value| SecretString::from(value.to_owned()))
		.or(fallback_refresh);
	if require_refresh && refresh_token.is_none() {
		return Err(OAuthError::MalformedResponse);
	}
	let expires_in = parsed.expires_in.ok_or(OAuthError::MalformedResponse)?;
	Ok(OAuthTokenSet {
		access_token: SecretString::from(access_token.to_owned()),
		refresh_token,
		token_type: sf!("Bearer"),
		expires_in: Some(Duration::from_secs(expires_in.saturating_sub(5 * 60))),
		identity_response: response.body,
		project: None,
	})
}

fn has_inline_email(body: &SecretString) -> bool {
	let Ok(parsed) = serde_json::from_str::<AnthropicTokenResponse>(body.expose_secret()) else {
		return false;
	};
	let parsed = Zeroizing::new(parsed);
	parsed
		.account
		.as_ref()
		.and_then(|account| account.email_address.as_deref())
		.is_some_and(|email| !email.is_empty())
}

async fn bootstrap_identity(
	http: &dyn OAuthHttpClient,
	spec: &OAuthCustomSpec,
	access_token: &SecretString,
) -> Result<Option<SecretString>, OAuthError> {
	let Some(url) = spec
		.parameters
		.iter()
		.find(|parameter| parameter.name == BOOTSTRAP_URL_PARAMETER)
		.map(|parameter| parameter.value.as_str())
		.filter(|url| !url.is_empty())
	else {
		return Ok(None);
	};
	let mut bearer =
		Zeroizing::new(String::with_capacity("Bearer ".len() + access_token.expose_secret().len()));
	bearer.push_str("Bearer ");
	bearer.push_str(access_token.expose_secret());
	let mut headers = HeaderMap::new();
	headers.insert(
		AUTHORIZATION,
		HeaderValue::from_bytes(bearer.as_bytes()).map_err(|_| OAuthError::MalformedResponse)?,
	);
	headers.insert(ANTHROPIC_BETA, HeaderValue::from_static(OAUTH_BETA));
	headers.insert(USER_AGENT, HeaderValue::from_static(BOOTSTRAP_USER_AGENT));
	let response = http
		.execute(OAuthHttpRequest::new(Method::GET, url, headers, None)?)
		.await?;
	if !(200..300).contains(&response.status) {
		return Err(provider_error(response.status, &response.body, false));
	}
	let parsed = Zeroizing::new(
		serde_json::from_str::<BootstrapResponse>(response.body.expose_secret())
			.map_err(|_| OAuthError::MalformedResponse)?,
	);
	let account = parsed
		.oauth_account
		.as_ref()
		.ok_or(OAuthError::MalformedResponse)?;
	let email = required(account.account_email.as_deref())?;
	let mut identity = Zeroizing::new(
		serde_json::to_string(&BootstrapIdentity {
			account: BootstrapIdentityAccount {
				uuid:          account.account_uuid.as_deref(),
				email_address: email,
			},
		})
		.map_err(|_| OAuthError::MalformedResponse)?,
	);
	Ok(Some(SecretString::from(mem::take(&mut *identity))))
}

fn authorization_code(
	code: SecretString,
	expected_state: &str,
) -> Result<SecretString, OAuthError> {
	let value = code.expose_secret();
	if value.starts_with("http://") || value.starts_with("https://") {
		return callback_code(&code, expected_state);
	}
	let (code, fragment_state) = value
		.split_once('#')
		.map_or((value, None), |(code, state)| (code, Some(state)));
	if code.is_empty() {
		return Err(OAuthError::MalformedCallback);
	}
	if fragment_state.is_some_and(|state| !state.is_empty() && state != expected_state) {
		return Err(OAuthError::StateMismatch);
	}
	let mut code = Zeroizing::new(code.to_owned());
	Ok(SecretString::from(mem::take(&mut *code)))
}

fn required(value: Option<&str>) -> Result<&str, OAuthError> {
	value
		.filter(|value| !value.is_empty())
		.ok_or(OAuthError::MalformedResponse)
}

#[derive(Serialize)]
struct TokenRequest<'a> {
	grant_type:    &'static str,
	client_id:     &'a str,
	code:          &'a str,
	state:         &'a str,
	redirect_uri:  &'a str,
	code_verifier: &'a str,
}

#[derive(Serialize)]
struct RefreshTokenRequest<'a> {
	grant_type:    &'static str,
	client_id:     &'a str,
	refresh_token: &'a str,
}

#[derive(Deserialize, Zeroize)]
struct AnthropicTokenResponse {
	access_token:  Option<String>,
	refresh_token: Option<String>,
	expires_in:    Option<u64>,
	account:       Option<AnthropicAccount>,
	error:         Option<String>,
}

#[derive(Deserialize, Zeroize)]
struct AnthropicAccount {
	email_address: Option<String>,
}

#[derive(Deserialize, Zeroize)]
struct BootstrapResponse {
	oauth_account: Option<BootstrapAccount>,
}

#[derive(Deserialize, Zeroize)]
struct BootstrapAccount {
	account_uuid:  Option<String>,
	account_email: Option<String>,
}

#[derive(Serialize)]
struct BootstrapIdentity<'a> {
	account: BootstrapIdentityAccount<'a>,
}

#[derive(Serialize)]
struct BootstrapIdentityAccount<'a> {
	uuid:          Option<&'a str>,
	email_address: &'a str,
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use futures::FutureExt;
	use http::header::ACCEPT;
	use omp_catalog::provider::PrincipalResolution;
	use parking_lot::Mutex;
	use serde_json::Value;
	use url::Url;

	use super::{
		super::super::{OAuthHttpResponse, OAuthTransportError},
		*,
	};
	use crate::{
		answer::{AuthEvent, AuthResponse},
		auth::{
			CredentialSourceSpec, OAuthClientSpec, OAuthParameter, OAuthRefreshSpec,
			login::default_login_channels, spec::HeaderPlacement,
		},
		id::LoginSessionId,
	};

	#[derive(Default)]
	struct RecordedRequest {
		method:  Option<Method>,
		url:     Option<String>,
		headers: Option<HeaderMap>,
		body:    Option<String>,
	}

	struct ScriptedHttp {
		response: Mutex<Option<OAuthHttpResponse>>,
		request:  Mutex<RecordedRequest>,
	}

	impl OAuthHttpClient for ScriptedHttp {
		fn execute(
			&self,
			request: OAuthHttpRequest,
		) -> BoxFuture<'_, Result<OAuthHttpResponse, OAuthTransportError>> {
			let (method, url, headers, body) = request.into_parts();
			*self.request.lock() = RecordedRequest {
				method:  Some(method),
				url:     Some(url.to_string()),
				headers: Some(headers),
				body:    body.map(|body| body.expose_secret().to_owned()),
			};
			let response = self.response.lock().take().expect("scripted response");
			async move { Ok(response) }.boxed()
		}
	}

	fn spec() -> OAuthCustomSpec {
		OAuthCustomSpec {
			client:        OAuthClientSpec {
				sources:      vec![CredentialSourceSpec::Interactive],
				client_id:    "anthropic-client".into(),
				refresh:      OAuthRefreshSpec::Unsupported,
				token_url:    "https://api.anthropic.test/v1/oauth/token".into(),
				scopes:       vec!["user:profile".into(), "user:inference".into()],
				audience:     None,
				token_params: Vec::new(),
				placement:    HeaderPlacement::bearer().into(),
			},
			authorize_url: "https://claude.test/oauth/authorize".into(),
			exchange:      OAuthExchangeKind::AnthropicPkce,
			parameters:    vec![
				OAuthParameter { name: "code".into(), value: "true".into() },
				OAuthParameter {
					name:  "redirect_uri".into(),
					value: "http://localhost:54545/callback".into(),
				},
			],
			polling:       None,
		}
	}

	fn response(body: &str) -> OAuthHttpResponse {
		OAuthHttpResponse {
			status:  200,
			headers: HeaderMap::new(),
			body:    SecretString::from(body.to_owned()),
		}
	}

	#[tokio::test]
	async fn exchange_uses_exact_anthropic_json_and_preserves_inline_identity() {
		let http = Arc::new(ScriptedHttp {
			response: Mutex::new(Some(response(
				r#"{"access_token":"access","refresh_token":"refresh","expires_in":3600,"account":{"uuid":"account-id","email_address":"user@example.com"},"organization":{"uuid":"org-id","name":"Org"}}"#,
			))),
			request:  Mutex::new(RecordedRequest::default()),
		});
		let (session, driver, _) = default_login_channels(LoginSessionId::from("anthropic"));
		let handler = AnthropicPkceHandler { http: http.clone() };
		let spec = spec();
		let exchange = handler.exchange(&spec, &driver);
		let respond = async {
			let AuthEvent::OpenUrl { url, .. } = session.events.recv_async().await.unwrap().unwrap()
			else {
				panic!("expected authorization URL")
			};
			let url = Url::parse(&url).unwrap();
			let query = url.query_pairs().collect::<Vec<_>>();
			assert_eq!(query[0], ("code".into(), "true".into()));
			assert!(
				query
					.iter()
					.any(|pair| pair == &("scope".into(), "user:profile user:inference".into()))
			);
			let state = query
				.iter()
				.find(|(name, _)| name == "state")
				.unwrap()
				.1
				.clone()
				.into_owned();
			let challenge = query
				.iter()
				.find(|(name, _)| name == "code_challenge")
				.unwrap()
				.1
				.clone()
				.into_owned();
			let AuthEvent::Prompt(prompt) = session.events.recv_async().await.unwrap().unwrap() else {
				panic!("expected callback prompt")
			};
			assert_eq!(prompt.message, PROMPT);
			let callback = format!("http://localhost:54545/callback?code=auth-code&state={state}");
			session
				.responses
				.send_async(AuthResponse {
					session: session.id.clone(),
					input:   AuthInput::AuthorizationCode(SecretString::from(callback)),
				})
				.await
				.unwrap();
			(state, challenge)
		};
		let (tokens, (state, challenge)) = futures::join!(exchange, respond);
		let tokens = tokens.expect("token exchange");
		assert!(tokens.is_refreshable());
		assert_eq!(tokens.token_type(), "Bearer");
		assert_eq!(tokens.expires_in(), Some(Duration::from_hours(1) - Duration::from_mins(5)));
		let principal = tokens
			.resolve_principal(
				&PrincipalResolution::TokenResponseField { pointer: "/account/email_address".into() },
				http.as_ref(),
			)
			.await
			.expect("inline email principal");
		assert_eq!(principal.as_str(), "user@example.com");

		let request = http.request.lock();
		assert_eq!(request.method, Some(Method::POST));
		assert_eq!(request.url.as_deref(), Some("https://api.anthropic.test/v1/oauth/token"));
		let headers = request.headers.as_ref().unwrap();
		assert_eq!(headers.get(CONTENT_TYPE).unwrap(), JSON_CONTENT_TYPE);
		assert!(headers.get(ACCEPT).is_none());
		let body = request.body.as_deref().unwrap();
		let json: Value = serde_json::from_str(body).unwrap();
		let verifier = json["code_verifier"].as_str().unwrap();
		assert_eq!(
			base64_url::encode_raw(&Sha256::digest(verifier.as_bytes())).into_string(),
			challenge
		);
		assert_eq!(
			body,
			format!(
				r#"{{"grant_type":"authorization_code","client_id":"anthropic-client","code":"auth-code","state":"{state}","redirect_uri":"http://localhost:54545/callback","code_verifier":"{verifier}"}}"#
			)
		);
	}

	#[test]
	fn pasted_code_fragment_must_carry_the_pending_state() {
		assert!(matches!(
			authorization_code(SecretString::from("code#wrong".to_owned()), "expected"),
			Err(OAuthError::StateMismatch)
		));
		let code = authorization_code(SecretString::from("code#expected".to_owned()), "expected")
			.expect("matching state");
		assert_eq!(code.expose_secret(), "code");
	}

	#[tokio::test]
	async fn malformed_token_envelopes_are_rejected() {
		for body in [
			r#"{"refresh_token":"refresh","expires_in":3600}"#,
			r#"{"access_token":"access","expires_in":3600}"#,
			r#"{"access_token":"access","refresh_token":"refresh"}"#,
			r#"{"access_token":"","refresh_token":"refresh","expires_in":3600}"#,
			"not-json",
		] {
			let http = ScriptedHttp {
				response: Mutex::new(Some(response(body))),
				request:  Mutex::new(RecordedRequest::default()),
			};
			let (session, driver, _) = default_login_channels(LoginSessionId::from("malformed"));
			let spec = spec();
			let run = exchange(&http, &spec, &driver);
			let respond = async {
				let AuthEvent::OpenUrl { url, .. } =
					session.events.recv_async().await.unwrap().unwrap()
				else {
					panic!("authorization URL")
				};
				let state = Url::parse(&url)
					.unwrap()
					.query_pairs()
					.find(|(name, _)| name == "state")
					.unwrap()
					.1
					.into_owned();
				let _ = session.events.recv_async().await.unwrap().unwrap();
				session
					.responses
					.send_async(AuthResponse {
						session: session.id.clone(),
						input:   AuthInput::AuthorizationCode(SecretString::from(format!(
							"http://localhost:54545/callback?code=code&state={state}"
						))),
					})
					.await
					.unwrap();
			};
			let (result, ()) = futures::join!(run, respond);
			assert_eq!(result.expect_err("malformed response"), OAuthError::MalformedResponse);
		}
	}
}
