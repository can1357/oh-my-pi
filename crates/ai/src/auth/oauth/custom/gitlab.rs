use std::{
	fmt, mem,
	sync::Arc,
	time::{Duration, SystemTime},
};

use futures::{
	FutureExt,
	future::{BoxFuture, Either},
};
use omp_catalog::provider::OAuthExchangeKind;
use omp_core::{ExposeSecret, SecretString, Str, base64_url, sf};
use serde::Deserialize;
use sha2::{Digest as _, Sha256};
use url::Url;
use zeroize::Zeroizing;

use super::super::{
	FormValue, OAuthHttpResponse as SuperOAuthHttpResponse, callback::CallbackServer, callback_code,
	form_request, parse_http_url, provider_error, receive_callback_input, start_callback_server,
};
use crate::{
	answer::{AuthEvent, AuthPrompt, AuthPromptKind},
	auth::{
		LoginDriver, OAuthClock, OAuthCustomDispatchError, OAuthCustomDispatcher, OAuthCustomHandler,
		OAuthCustomSpec, OAuthEntropy, OAuthError, OAuthHttpClient, OAuthRefreshFuture,
		OAuthRefreshSpec, OAuthTokenSet, SystemEntropySource,
	},
	call::AuthInput,
};

const REDIRECT_PARAMETER: &str = "redirect_uri";
const EXPIRY_SAFETY_MARGIN: Duration = Duration::from_mins(5);
const CALLBACK_PROMPT: &str = "Complete GitLab login in your browser. This uses GitLab's official \
                               VS Code OAuth application. If the redirect opens VS Code instead \
                               of returning to OMP, copy the full \
                               vscode://gitlab.gitlab-workflow/authentication?... callback URL \
                               from VS Code/browser and paste it back into OMP.";

struct GitlabExternalRedirectHandler {
	http:  Arc<dyn OAuthHttpClient>,
	clock: Arc<dyn OAuthClock>,
}

impl fmt::Debug for GitlabExternalRedirectHandler {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("GitlabExternalRedirectHandler")
			.field("exchange", &OAuthExchangeKind::ExternalRedirectPkce)
			.field("http", &"[REDACTED]")
			.field("clock", &"[REDACTED]")
			.finish()
	}
}

struct ExternalRedirectPending {
	verifier:        SecretString,
	state:           Str,
	redirect_uri:    Str,
	callback_server: Option<CallbackServer>,
}

impl fmt::Debug for ExternalRedirectPending {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("ExternalRedirectPending")
			.field("verifier", &"[REDACTED]")
			.field("state", &"[REDACTED]")
			.field("redirect_uri", &self.redirect_uri)
			.finish()
	}
}

impl GitlabExternalRedirectHandler {
	async fn begin(
		&self,
		spec: &OAuthCustomSpec,
		driver: &LoginDriver,
	) -> Result<ExternalRedirectPending, OAuthError> {
		let redirect_uri = catalog_redirect_uri(spec)?;
		// Unlike the generic callback listener, this redirect intentionally targets
		// an external application and therefore is not restricted to HTTP(S).
		Url::parse(redirect_uri).map_err(|_| OAuthError::InvalidUrl)?;

		let entropy = SystemEntropySource;
		let mut verifier_bytes = Zeroizing::new([0_u8; 32]);
		let mut state_bytes = Zeroizing::new([0_u8; 24]);
		entropy.fill(&mut verifier_bytes[..])?;
		entropy.fill(&mut state_bytes[..])?;
		let verifier = SecretString::from(base64_url::encode_raw(&verifier_bytes[..]).into_string());
		let state = Str::new(base64_url::encode_raw(&state_bytes[..]).into_string());
		let challenge =
			base64_url::encode_raw(&Sha256::digest(verifier.expose_secret().as_bytes())).into_string();

		let mut authorization_url = parse_http_url(&spec.authorize_url)?;
		{
			let mut query = authorization_url.query_pairs_mut();
			query
				.append_pair("client_id", &spec.client.client_id)
				.append_pair(REDIRECT_PARAMETER, redirect_uri)
				.append_pair("response_type", "code");
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
			for parameter in &spec.parameters {
				if parameter.name != REDIRECT_PARAMETER {
					query.append_pair(&parameter.name, &parameter.value);
				}
			}
		}

		let callback_server = start_callback_server(redirect_uri, &state).await;
		let url = Str::new(authorization_url.as_str());
		if let Some(server) = &callback_server {
			server.arm(url.clone());
		}
		let launch = callback_server.as_ref().map(|server| server.launch_url());
		driver.emit(AuthEvent::OpenUrl { url, launch }).await?;
		driver
			.emit(AuthEvent::Prompt(AuthPrompt {
				id:      sf!("oauth-callback-url"),
				message: sf!(CALLBACK_PROMPT),
				input:   AuthPromptKind::AuthorizationCode,
			}))
			.await?;

		Ok(ExternalRedirectPending {
			verifier,
			state,
			redirect_uri: Str::new(redirect_uri),
			callback_server,
		})
	}

	async fn run(
		&self,
		spec: &OAuthCustomSpec,
		driver: &LoginDriver,
	) -> Result<OAuthTokenSet, OAuthError> {
		let pending = self.begin(spec, driver).await?;
		let callback_server = pending.callback_server;
		let input = receive_callback_input(driver, callback_server).await?;
		let (AuthInput::CallbackUrl(callback) | AuthInput::AuthorizationCode(callback)) = input
		else {
			return if matches!(input, AuthInput::Cancel) {
				Err(OAuthError::Cancelled)
			} else {
				Err(OAuthError::UnexpectedInput)
			};
		};
		let code = external_callback_code(&callback, &pending.redirect_uri, &pending.state)?;
		let fields = [
			("client_id", FormValue::Public(&spec.client.client_id)),
			("redirect_uri", FormValue::Public(&pending.redirect_uri)),
			("grant_type", FormValue::Public("authorization_code")),
			("code", FormValue::Secret(code.expose_secret())),
			("code_verifier", FormValue::Secret(pending.verifier.expose_secret())),
		];
		let response = self
			.http
			.execute(form_request(&spec.client.token_url, &fields, &spec.client.token_params)?)
			.await?;
		if !(200..300).contains(&response.status) {
			return Err(provider_error(response.status, &response.body, false));
		}
		gitlab_token_response(response, self.clock.now(), None)
	}
}

impl OAuthCustomHandler for GitlabExternalRedirectHandler {
	fn exchange_kind(&self) -> OAuthExchangeKind {
		OAuthExchangeKind::ExternalRedirectPkce
	}

	fn exchange<'a>(
		&'a self,
		spec: &'a OAuthCustomSpec,
		driver: &'a LoginDriver,
	) -> BoxFuture<'a, Result<OAuthTokenSet, OAuthError>> {
		async move { self.run(spec, driver).await }.boxed()
	}

	fn refresh<'a>(
		&'a self,
		spec: &'a OAuthCustomSpec,
		refresh_token: SecretString,
	) -> OAuthRefreshFuture<'a> {
		Either::Right(
			async move {
				let (url, parameters) = match &spec.client.refresh {
					OAuthRefreshSpec::Unsupported => return Err(OAuthError::RefreshUnsupported),
					OAuthRefreshSpec::TokenEndpoint => {
						(spec.client.token_url.as_str(), spec.client.token_params.as_slice())
					},
					OAuthRefreshSpec::Endpoint { url, parameters } => {
						(url.as_str(), parameters.as_slice())
					},
				};
				let redirect_uri = catalog_redirect_uri(spec)?;
				let fields = [
					("grant_type", FormValue::Public("refresh_token")),
					("client_id", FormValue::Public(&spec.client.client_id)),
					("redirect_uri", FormValue::Public(redirect_uri)),
					("refresh_token", FormValue::Secret(refresh_token.expose_secret())),
				];
				let response = self
					.http
					.execute(form_request(url, &fields, parameters)?)
					.await?;
				if !(200..300).contains(&response.status) {
					return Err(provider_error(response.status, &response.body, true));
				}
				gitlab_token_response(response, self.clock.now(), Some(refresh_token))
			}
			.boxed(),
		)
	}
}

fn catalog_redirect_uri(spec: &OAuthCustomSpec) -> Result<&str, OAuthError> {
	let mut redirect_uri = None;
	for parameter in &spec.parameters {
		if parameter.name == REDIRECT_PARAMETER
			&& redirect_uri.replace(parameter.value.as_str()).is_some()
		{
			return Err(OAuthError::InvalidUrl);
		}
	}
	redirect_uri
		.filter(|redirect_uri| !redirect_uri.is_empty())
		.ok_or(OAuthError::InvalidUrl)
}

fn external_callback_code(
	callback: &SecretString,
	redirect_uri: &str,
	expected_state: &str,
) -> Result<SecretString, OAuthError> {
	let suffix = callback
		.expose_secret()
		.strip_prefix(redirect_uri)
		.filter(|suffix| suffix.starts_with('?'))
		.ok_or(OAuthError::MalformedCallback)?;
	// Reuse the hardened state/code parser without forcing the real external
	// callback through its HTTP-only endpoint guard. The temporary URL and all
	// decoded callback material remain secret containers or zeroizing storage.
	let mut compatible =
		Zeroizing::new(String::with_capacity("https://oauth-callback.invalid/".len() + suffix.len()));
	compatible.push_str("https://oauth-callback.invalid/");
	compatible.push_str(suffix);
	let compatible = SecretString::from(mem::take(&mut *compatible));
	callback_code(&compatible, expected_state)
}

#[derive(Deserialize)]
struct GitlabTokenResponse {
	access_token:  Option<String>,
	refresh_token: Option<String>,
	expires_in:    Option<u64>,
	created_at:    Option<u64>,
}

fn gitlab_token_response(
	response: SuperOAuthHttpResponse,
	now: SystemTime,
	fallback_refresh: Option<SecretString>,
) -> Result<OAuthTokenSet, OAuthError> {
	let parsed: GitlabTokenResponse = serde_json::from_str(response.body.expose_secret())
		.map_err(|_| OAuthError::MalformedResponse)?;
	let access_token = SecretString::from(
		parsed
			.access_token
			.filter(|value| !value.is_empty())
			.ok_or(OAuthError::MalformedResponse)?,
	);
	let refresh_token = parsed
		.refresh_token
		.filter(|value| !value.is_empty())
		.map(SecretString::from)
		.or(fallback_refresh)
		.ok_or(OAuthError::MalformedResponse)?;
	let lifetime = Duration::from_secs(parsed.expires_in.ok_or(OAuthError::MalformedResponse)?);
	let created_at = match parsed.created_at {
		Some(seconds) => SystemTime::UNIX_EPOCH
			.checked_add(Duration::from_secs(seconds))
			.ok_or(OAuthError::InvalidExpiry)?,
		None => now,
	};
	let expires_at = created_at
		.checked_add(lifetime)
		.and_then(|expires_at| expires_at.checked_sub(EXPIRY_SAFETY_MARGIN))
		.ok_or(OAuthError::InvalidExpiry)?;
	let expires_in = expires_at
		.duration_since(now)
		.map_err(|_| OAuthError::InvalidExpiry)?;

	Ok(OAuthTokenSet {
		access_token,
		refresh_token: Some(refresh_token),
		token_type: sf!("Bearer"),
		expires_in: Some(expires_in),
		identity_response: response.body,
		project: None,
	})
}

pub(super) fn register(
	dispatcher: &mut OAuthCustomDispatcher,
	http: Arc<dyn OAuthHttpClient>,
	clock: Arc<dyn OAuthClock>,
) -> Result<(), OAuthCustomDispatchError> {
	dispatcher.register(Arc::new(GitlabExternalRedirectHandler { http, clock }))
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use futures::FutureExt;
	use http::{HeaderMap, Method, header::CONTENT_TYPE};
	use omp_catalog::provider::PrincipalResolution;
	use omp_core::ExposeSecret;
	use parking_lot::Mutex;

	use super::*;
	use crate::{
		answer::{AuthResponse, AuthSession},
		auth::{
			HeaderPlacement, KeyPlacement, OAuthClientSpec, OAuthHttpRequest, OAuthHttpResponse,
			OAuthParameter, OAuthRefreshSpec, OAuthTransportError, default_login_channels,
		},
		id::LoginSessionId,
	};

	const REDIRECT_URI: &str = "vscode://gitlab.gitlab-workflow/authentication";

	struct RecordedRequest {
		method:  Method,
		url:     Url,
		headers: HeaderMap,
		body:    Option<SecretString>,
	}

	struct ScriptedHttp {
		response: Mutex<Option<OAuthHttpResponse>>,
		requests: Mutex<Vec<RecordedRequest>>,
	}

	impl ScriptedHttp {
		fn successful() -> Self {
			Self {
				response: Mutex::new(Some(OAuthHttpResponse {
					status:  200,
					headers: HeaderMap::new(),
					body:    SecretString::from(
						r#"{"access_token":"access-secret","refresh_token":"refresh-secret","expires_in":3600,"created_at":1000,"identity":"gitlab-user"}"#.to_owned(),
					),
				})),
				requests: Mutex::new(Vec::new()),
			}
		}
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
				.push(RecordedRequest { method, url, headers, body });
			let response = self
				.response
				.lock()
				.take()
				.expect("scripted token response");
			async move { Ok(response) }.boxed()
		}
	}

	struct FixedClock;

	impl OAuthClock for FixedClock {
		fn now(&self) -> SystemTime {
			SystemTime::UNIX_EPOCH + Duration::from_secs(1000)
		}

		fn sleep(&self, _duration: Duration) -> BoxFuture<'_, ()> {
			async {}.boxed()
		}
	}

	fn spec() -> OAuthCustomSpec {
		OAuthCustomSpec {
			client:        OAuthClientSpec {
				sources:      Vec::new(),
				client_id:    "catalog-client".into(),
				refresh:      OAuthRefreshSpec::TokenEndpoint,
				token_url:    "https://gitlab.example/oauth/token".into(),
				scopes:       vec!["api".into()],
				audience:     None,
				token_params: vec![OAuthParameter {
					name:  "public_hint".into(),
					value: "hint value".into(),
				}],
				placement:    KeyPlacement::Header(HeaderPlacement::bearer()),
			},
			authorize_url: "https://gitlab.example/oauth/authorize".into(),
			exchange:      OAuthExchangeKind::ExternalRedirectPkce,
			parameters:    vec![OAuthParameter {
				name:  REDIRECT_PARAMETER.into(),
				value: REDIRECT_URI.into(),
			}],
			polling:       None,
		}
	}

	async fn authorization_timeline(session: &AuthSession) -> (Url, String) {
		let AuthEvent::OpenUrl { url, .. } = session
			.events
			.recv_async()
			.await
			.expect("authorization URL")
			.expect("authorization event")
		else {
			panic!("authorization URL expected")
		};
		let AuthEvent::Prompt(prompt) = session
			.events
			.recv_async()
			.await
			.expect("callback prompt")
			.expect("prompt event")
		else {
			panic!("callback prompt expected")
		};
		assert_eq!(prompt.id, "oauth-callback-url");
		assert_eq!(prompt.input, AuthPromptKind::AuthorizationCode);
		assert!(prompt.message.contains(REDIRECT_URI));
		let url = Url::parse(&url).expect("authorization URL parses");
		let state = url
			.query_pairs()
			.find(|(name, _)| name == "state")
			.expect("state parameter")
			.1
			.into_owned();
		(url, state)
	}

	#[tokio::test]
	async fn external_vscode_callback_exchanges_exact_pkce_form_and_is_refreshable() {
		let http = Arc::new(ScriptedHttp::successful());
		let mut dispatcher = OAuthCustomDispatcher::new();
		register(&mut dispatcher, http.clone(), Arc::new(FixedClock)).expect("register");
		let spec = spec();
		let (session, driver, _) =
			default_login_channels(LoginSessionId::from("gitlab-external-success"));

		let exchange = dispatcher.exchange(&spec, &driver);
		let interaction = async {
			let (authorization_url, state) = authorization_timeline(&session).await;
			let callback = format!("{REDIRECT_URI}?code=code%2Fwith%2Bsymbols&state={state}");
			session
				.responses
				.send_async(AuthResponse {
					session: session.id.clone(),
					input:   AuthInput::AuthorizationCode(SecretString::from(callback)),
				})
				.await
				.expect("callback response");
			authorization_url
		};
		let (tokens, authorization_url) = tokio::join!(exchange, interaction);
		let tokens = tokens.expect("token exchange");

		let authorization: Vec<_> = authorization_url.query_pairs().into_owned().collect();
		assert_eq!(authorization[0], ("client_id".to_owned(), "catalog-client".to_owned()));
		assert_eq!(authorization[1], ("redirect_uri".to_owned(), REDIRECT_URI.to_owned()));
		assert_eq!(authorization[2], ("response_type".to_owned(), "code".to_owned()));
		assert!(authorization.contains(&("scope".to_owned(), "api".to_owned())));
		assert!(authorization.contains(&("code_challenge_method".to_owned(), "S256".to_owned())));

		{
			let requests = http.requests.lock();
			assert_eq!(requests.len(), 1);
			let request = &requests[0];
			assert_eq!(request.method, Method::POST);
			assert_eq!(request.url.as_str(), "https://gitlab.example/oauth/token");
			assert_eq!(
				request.headers.get(CONTENT_TYPE).expect("content type"),
				"application/x-www-form-urlencoded"
			);
			let body = request.body.as_ref().expect("form body").expose_secret();
			let form: Vec<_> = url::form_urlencoded::parse(body.as_bytes())
				.into_owned()
				.collect();
			assert_eq!(form[0], ("client_id".to_owned(), "catalog-client".to_owned()));
			assert_eq!(form[1], ("redirect_uri".to_owned(), REDIRECT_URI.to_owned()));
			assert_eq!(form[2], ("grant_type".to_owned(), "authorization_code".to_owned()));
			assert_eq!(form[3], ("code".to_owned(), "code/with+symbols".to_owned()));
			assert_eq!(form[5], ("public_hint".to_owned(), "hint value".to_owned()));
			let verifier = &form[4].1;
			let expected_challenge =
				base64_url::encode_raw(&Sha256::digest(verifier.as_bytes())).into_string();
			assert!(authorization.contains(&("code_challenge".to_owned(), expected_challenge)));
		}

		assert!(tokens.is_refreshable());
		assert_eq!(tokens.token_type(), "Bearer");
		assert_eq!(tokens.expires_in(), Some(Duration::from_mins(55)));
		let principal = tokens
			.resolve_principal(
				&PrincipalResolution::TokenResponseField { pointer: "/identity".into() },
				http.as_ref(),
			)
			.await
			.expect("identity response retained");
		assert_eq!(principal.as_str(), "gitlab-user");
		let debug = format!("{tokens:?}");
		assert!(!debug.contains("access-secret"));
		assert!(!debug.contains("refresh-secret"));
	}

	#[tokio::test]
	async fn mismatched_external_callback_state_fails_before_http() {
		let http = Arc::new(ScriptedHttp::successful());
		let mut dispatcher = OAuthCustomDispatcher::new();
		register(&mut dispatcher, http.clone(), Arc::new(FixedClock)).expect("register");
		let spec = spec();
		let (session, driver, _) =
			default_login_channels(LoginSessionId::from("gitlab-external-state"));

		let exchange = dispatcher.exchange(&spec, &driver);
		let interaction = async {
			let (_authorization_url, _state) = authorization_timeline(&session).await;
			session
				.responses
				.send_async(AuthResponse {
					session: session.id.clone(),
					input:   AuthInput::AuthorizationCode(SecretString::from(format!(
						"{REDIRECT_URI}?code=secret-code-marker&state=wrong-state"
					))),
				})
				.await
				.expect("callback response");
		};
		let (result, ()) = tokio::join!(exchange, interaction);
		assert!(matches!(
			&result,
			Err(OAuthCustomDispatchError::Protocol(OAuthError::StateMismatch))
		));
		assert!(http.requests.lock().is_empty());
		let error = result.expect_err("state mismatch");
		let rendered = format!("{error} {error:?}");
		assert!(!rendered.contains("secret-code-marker"));
	}
}
