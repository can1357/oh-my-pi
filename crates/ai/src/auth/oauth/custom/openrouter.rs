//! `OpenRouter` PKCE authorization, durable key provisioning, and key-paste
//! validation.

use std::{mem, sync::Arc};

use futures::{FutureExt as _, future::BoxFuture};
use http::{
	HeaderMap, HeaderValue, Method,
	header::{AUTHORIZATION, CONTENT_TYPE},
};
use omp_catalog::provider::OAuthExchangeKind;
use omp_core::{ExposeSecret as _, SecretString, Str, base64_url, sf};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use zeroize::Zeroizing;

use super::super::{
	OAuthClock, OAuthCustomDispatchError, OAuthCustomDispatcher, OAuthCustomHandler, OAuthEntropy,
	OAuthError, OAuthHttpClient, OAuthHttpRequest, OAuthTokenSet, SystemEntropySource,
	callback_code, parse_http_url, provider_error, receive_callback_input, start_callback_server,
};
use crate::{
	answer::{AuthEvent, AuthPrompt, AuthPromptKind},
	auth::{LoginDriver, OAuthCustomSpec},
	call::AuthInput,
};

const REDIRECT_PARAMETER: &str = "redirect_uri";
const KEY_INFO_PARAMETER: &str = "key_info_url";
const API_KEY_PREFIX: &str = "sk-or-";
const PKCE_VERIFIER_BYTES: usize = 96;
const CALLBACK_PROMPT: &str = "Authorize OMP in your browser, or paste an existing OpenRouter API \
                               key (sk-or-...). If the browser cannot reach this machine, paste \
                               the final redirect URL or authorization code instead.";

pub(super) fn register(
	dispatcher: &mut OAuthCustomDispatcher,
	http: Arc<dyn OAuthHttpClient>,
	_clock: Arc<dyn OAuthClock>,
) -> Result<(), OAuthCustomDispatchError> {
	dispatcher
		.register(Arc::new(OpenRouterApiKeyHandler { http, entropy: Arc::new(SystemEntropySource) }))
}

struct OpenRouterApiKeyHandler {
	http:    Arc<dyn OAuthHttpClient>,
	entropy: Arc<dyn OAuthEntropy>,
}

impl OAuthCustomHandler for OpenRouterApiKeyHandler {
	fn exchange_kind(&self) -> OAuthExchangeKind {
		OAuthExchangeKind::OpenRouterApiKey
	}

	fn exchange<'a>(
		&'a self,
		spec: &'a OAuthCustomSpec,
		driver: &'a LoginDriver,
	) -> BoxFuture<'a, Result<OAuthTokenSet, OAuthError>> {
		async move {
			let redirect_uri = required_parameter(spec, REDIRECT_PARAMETER)?;
			parse_http_url(redirect_uri)?;
			let key_info_url = required_parameter(spec, KEY_INFO_PARAMETER)?;
			let (verifier, challenge) = generate_pkce(&*self.entropy)?;
			let authorize_url = authorization_url(spec, redirect_uri, challenge.as_str())?;
			let callback_server = start_callback_server(redirect_uri, "").await;
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
					message: sf!(CALLBACK_PROMPT),
					input:   AuthPromptKind::AuthorizationCode,
				}))
				.await?;

			let input = receive_callback_input(driver, callback_server).await?;
			let code = match input {
				AuthInput::CallbackUrl(callback) => callback_code(&callback, "")?,
				AuthInput::AuthorizationCode(input) | AuthInput::ApiKey(input) => {
					authorization_input(input)?
				},
				AuthInput::Cancel => return Err(OAuthError::Cancelled),
				_ => return Err(OAuthError::UnexpectedInput),
			};
			driver.check_cancelled()?;

			if code.expose_secret().starts_with(API_KEY_PREFIX) {
				self.validate_api_key(key_info_url, &code).await?;
				Ok(token_set(code))
			} else {
				self.exchange_code(spec, &code, &verifier).await
			}
		}
		.boxed()
	}
}

impl OpenRouterApiKeyHandler {
	async fn exchange_code(
		&self,
		spec: &OAuthCustomSpec,
		code: &SecretString,
		verifier: &SecretString,
	) -> Result<OAuthTokenSet, OAuthError> {
		let body = secret_json(&KeyExchangeRequest {
			code:                  code.expose_secret(),
			code_verifier:         verifier.expose_secret(),
			code_challenge_method: "S256",
		})?;
		let mut headers = HeaderMap::new();
		headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
		let response = self
			.http
			.execute(OAuthHttpRequest::new(Method::POST, &spec.client.token_url, headers, Some(body))?)
			.await?;
		if !(200..300).contains(&response.status) {
			return Err(provider_error(response.status, &response.body, false));
		}
		let access_token = exchange_key(&response.body)?;
		Ok(token_set(access_token))
	}

	async fn validate_api_key(
		&self,
		key_info_url: &str,
		api_key: &SecretString,
	) -> Result<(), OAuthError> {
		let mut authorization =
			Zeroizing::new(String::with_capacity("Bearer ".len() + api_key.expose_secret().len()));
		authorization.push_str("Bearer ");
		authorization.push_str(api_key.expose_secret());
		let mut value =
			HeaderValue::from_str(&authorization).map_err(|_| OAuthError::UnexpectedInput)?;
		value.set_sensitive(true);
		let mut headers = HeaderMap::new();
		headers.insert(AUTHORIZATION, value);
		let response = self
			.http
			.execute(OAuthHttpRequest::new(Method::GET, key_info_url, headers, None)?)
			.await?;
		if !(200..300).contains(&response.status) {
			return Err(provider_error(response.status, &response.body, false));
		}
		Ok(())
	}
}

fn authorization_url(
	spec: &OAuthCustomSpec,
	redirect_uri: &str,
	challenge: &str,
) -> Result<url::Url, OAuthError> {
	let mut url = parse_http_url(&spec.authorize_url)?;
	{
		let mut query = url.query_pairs_mut();
		query
			.append_pair("callback_url", redirect_uri)
			.append_pair("code_challenge", challenge)
			.append_pair("code_challenge_method", "S256");
	}
	Ok(url)
}

fn generate_pkce(entropy: &dyn OAuthEntropy) -> Result<(SecretString, Str), OAuthError> {
	let mut bytes = Zeroizing::new([0_u8; PKCE_VERIFIER_BYTES]);
	entropy.fill(&mut bytes[..])?;
	let verifier = SecretString::from(base64_url::encode_raw(&bytes[..]).into_string());
	let challenge = base64_url::encode_raw(&Sha256::digest(verifier.expose_secret().as_bytes()))
		.into_string()
		.into();
	Ok((verifier, challenge))
}

fn authorization_input(input: SecretString) -> Result<SecretString, OAuthError> {
	let value = input.expose_secret().trim();
	if value.starts_with("http://") || value.starts_with("https://") {
		return callback_code(&SecretString::from(value), "");
	}
	if value.is_empty() {
		return Err(OAuthError::UnexpectedInput);
	}
	let mut material = Zeroizing::new(value.to_owned());
	Ok(SecretString::from(mem::take(&mut *material)))
}

fn exchange_key(body: &SecretString) -> Result<SecretString, OAuthError> {
	let response: KeyExchangeResponse<'_> =
		serde_json::from_str(body.expose_secret()).map_err(|_| OAuthError::MalformedResponse)?;
	let key = response
		.key
		.map(str::trim)
		.filter(|key| !key.is_empty())
		.ok_or(OAuthError::MalformedResponse)?;
	Ok(SecretString::from(key))
}

fn required_parameter<'a>(spec: &'a OAuthCustomSpec, name: &str) -> Result<&'a str, OAuthError> {
	spec
		.parameters
		.iter()
		.find(|parameter| parameter.name == name)
		.map(|parameter| parameter.value.as_str())
		.filter(|value| !value.is_empty())
		.ok_or(OAuthError::MalformedResponse)
}

fn secret_json(value: &impl Serialize) -> Result<SecretString, OAuthError> {
	let encoded = serde_json::to_string(value).map_err(|_| OAuthError::MalformedResponse)?;
	let mut encoded = Zeroizing::new(encoded);
	Ok(SecretString::from(mem::take(&mut *encoded)))
}

fn token_set(access_token: SecretString) -> OAuthTokenSet {
	OAuthTokenSet {
		access_token,
		refresh_token: None,
		token_type: sf!("Bearer"),
		expires_in: None,
		identity_response: SecretString::from("{}".to_owned()),
		project: None,
	}
}

#[derive(Serialize)]
struct KeyExchangeRequest<'a> {
	code:                  &'a str,
	code_verifier:         &'a str,
	code_challenge_method: &'static str,
}

#[derive(Deserialize)]
struct KeyExchangeResponse<'a> {
	#[serde(borrow)]
	key: Option<&'a str>,
}

#[cfg(test)]
mod tests {
	use std::{fmt, sync::Arc};

	use http::header::{AUTHORIZATION, CONTENT_TYPE};
	use parking_lot::Mutex;
	use serde_json::Value;

	use super::{
		super::super::{OAuthHttpResponse, OAuthTransportError},
		*,
	};
	use crate::auth::{
		CredentialSourceSpec, HeaderPlacement, OAuthClientSpec, OAuthParameter, OAuthRefreshSpec,
	};

	struct RecordedRequest {
		method:  Method,
		url:     String,
		headers: HeaderMap,
		body:    Option<SecretString>,
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
		fn responding(status: u16, body: &str) -> Self {
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
			*self.request.lock() =
				Some(RecordedRequest { method, url: url.to_string(), headers, body });
			let response = self.response.lock().take().expect("scripted response");
			async move { Ok(response) }.boxed()
		}
	}

	fn spec() -> OAuthCustomSpec {
		OAuthCustomSpec {
			client:        OAuthClientSpec {
				sources:      vec![CredentialSourceSpec::Interactive],
				client_id:    "".into(),
				refresh:      OAuthRefreshSpec::Unsupported,
				token_url:    "https://openrouter.ai/api/v1/auth/keys".into(),
				scopes:       Vec::new(),
				audience:     None,
				token_params: Vec::new(),
				placement:    HeaderPlacement::bearer().into(),
			},
			authorize_url: "https://openrouter.ai/auth".into(),
			exchange:      OAuthExchangeKind::OpenRouterApiKey,
			parameters:    vec![
				OAuthParameter {
					name:  REDIRECT_PARAMETER.into(),
					value: "http://localhost:54549/callback".into(),
				},
				OAuthParameter {
					name:  KEY_INFO_PARAMETER.into(),
					value: "https://openrouter.ai/api/v1/auth/key".into(),
				},
			],
			polling:       None,
		}
	}

	fn handler(http: Arc<ScriptedHttp>) -> OpenRouterApiKeyHandler {
		OpenRouterApiKeyHandler { http, entropy: Arc::new(SystemEntropySource) }
	}

	struct FixedEntropy;

	impl OAuthEntropy for FixedEntropy {
		fn fill(&self, destination: &mut [u8]) -> Result<(), OAuthError> {
			for (index, byte) in destination.iter_mut().enumerate() {
				*byte = u8::try_from(index).expect("test entropy fits u8");
			}
			Ok(())
		}
	}

	#[test]
	fn authorize_url_uses_stateless_s256_pkce_and_loopback_callback() {
		let (verifier, challenge) = generate_pkce(&FixedEntropy).expect("PKCE");
		let url = authorization_url(&spec(), "http://localhost:54549/callback", challenge.as_str())
			.expect("authorization URL");
		assert_eq!(url.as_str().split_once('?').expect("query").0, "https://openrouter.ai/auth");
		assert_eq!(
			url.query_pairs()
				.find(|(name, _)| name == "callback_url")
				.expect("callback URL")
				.1,
			"http://localhost:54549/callback"
		);
		assert_eq!(
			url.query_pairs()
				.find(|(name, _)| name == "code_challenge_method")
				.expect("challenge method")
				.1,
			"S256"
		);
		assert!(!url.query_pairs().any(|(name, _)| name == "state"));
		let expected =
			base64_url::encode_raw(&Sha256::digest(verifier.expose_secret().as_bytes())).into_string();
		assert_eq!(
			url.query_pairs()
				.find(|(name, _)| name == "code_challenge")
				.expect("challenge")
				.1,
			expected
		);
		assert_eq!(challenge.as_str(), expected);
	}

	#[test]
	fn callback_without_state_and_manual_inputs_are_parsed() {
		let callback =
			SecretString::from("http://localhost:54549/callback?code=auth%2Dcode".to_owned());
		assert_eq!(
			authorization_input(callback)
				.expect("stateless callback")
				.expose_secret(),
			"auth-code"
		);
		assert_eq!(
			authorization_input(SecretString::from("  sk-or-v1-pasted\n".to_owned()))
				.expect("pasted key")
				.expose_secret(),
			"sk-or-v1-pasted"
		);
		assert_eq!(
			authorization_input(SecretString::from("raw-code".to_owned()))
				.expect("raw code")
				.expose_secret(),
			"raw-code"
		);
	}

	#[tokio::test]
	async fn exchanges_code_for_provisioned_key_with_pkce_verifier() {
		let http = Arc::new(ScriptedHttp::responding(200, r#"{"key":"sk-or-v1-minted"}"#));
		let handler = handler(Arc::clone(&http));
		let tokens = handler
			.exchange_code(
				&spec(),
				&SecretString::from("auth-code".to_owned()),
				&SecretString::from("pkce-verifier".to_owned()),
			)
			.await
			.expect("key exchange");
		assert_eq!(tokens.access_token.expose_secret(), "sk-or-v1-minted");
		assert_eq!(tokens.expires_in(), None);

		let request = http.request.lock();
		let request = request.as_ref().expect("request");
		assert_eq!(request.method, Method::POST);
		assert_eq!(request.url, "https://openrouter.ai/api/v1/auth/keys");
		assert_eq!(
			request.headers.get(CONTENT_TYPE),
			Some(&HeaderValue::from_static("application/json"))
		);
		let body: Value = serde_json::from_str(request.body.as_ref().expect("body").expose_secret())
			.expect("JSON body");
		assert_eq!(body["code"], "auth-code");
		assert_eq!(body["code_verifier"], "pkce-verifier");
		assert_eq!(body["code_challenge_method"], "S256");
	}

	#[tokio::test]
	async fn validates_pasted_key_against_private_key_info_endpoint() {
		let http = Arc::new(ScriptedHttp::responding(200, r#"{"data":{}}"#));
		let handler = handler(Arc::clone(&http));
		handler
			.validate_api_key(
				"https://openrouter.ai/api/v1/auth/key",
				&SecretString::from("sk-or-v1-pasted".to_owned()),
			)
			.await
			.expect("key validation");

		let request = http.request.lock();
		let request = request.as_ref().expect("request");
		assert_eq!(request.method, Method::GET);
		assert_eq!(request.url, "https://openrouter.ai/api/v1/auth/key");
		assert!(request.body.is_none());
		assert_eq!(
			request
				.headers
				.get(AUTHORIZATION)
				.expect("authorization")
				.to_str()
				.expect("header"),
			"Bearer sk-or-v1-pasted"
		);
	}

	#[test]
	fn exchange_response_requires_non_empty_key() {
		for body in [r"{}", r#"{"key":""}"#, r#"{"key":"  "}"#] {
			assert_eq!(
				exchange_key(&SecretString::from(body.to_owned())).expect_err("missing key"),
				OAuthError::MalformedResponse
			);
		}
	}
	#[tokio::test]
	async fn rejected_pasted_key_surfaces_validation_status() {
		let http = Arc::new(ScriptedHttp::responding(401, "unauthorized"));
		let error = handler(http)
			.validate_api_key(
				"https://openrouter.ai/api/v1/auth/key",
				&SecretString::from("sk-or-v1-revoked".to_owned()),
			)
			.await
			.expect_err("revoked key");
		assert!(matches!(error, OAuthError::Provider { status: 401, .. }));
	}
}
