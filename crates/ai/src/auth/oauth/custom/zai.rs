use std::{
	fmt::{self, Write as _},
	mem,
	sync::Arc,
};

use futures::{FutureExt as _, future::BoxFuture};
use http::{
	HeaderMap, HeaderValue, Method,
	header::{AUTHORIZATION, CONTENT_TYPE},
};
use omp_catalog::provider::OAuthExchangeKind;
use omp_core::{ExposeSecret as _, SecretString, Str, sf};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;
use zeroize::Zeroizing;

use super::super::{
	OAuthClock, OAuthCustomDispatchError, OAuthCustomDispatcher, OAuthCustomHandler, OAuthEntropy,
	OAuthError, OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse, OAuthProviderCode,
	OAuthTokenSet, SystemEntropySource, callback_code, parse_http_url, provider_error,
	receive_callback_input, start_callback_server,
};
use crate::{
	answer::{AuthEvent, AuthPrompt, AuthPromptKind},
	auth::{LoginDriver, OAuthCustomSpec},
	call::AuthInput,
};

const BUSINESS_LOGIN_PARAMETER: &str = "business_login_url";
const KEY_NAME_PARAMETER: &str = "key_name";
const REDIRECT_PARAMETER: &str = "redirect_uri";
const CALLBACK_PROMPT: &str = "Complete Z.ai login in your browser. If the browser cannot reach \
                               this machine, paste the final redirect URL or authorization code \
                               when prompted.";

pub(super) fn register(
	dispatcher: &mut OAuthCustomDispatcher,
	http: Arc<dyn OAuthHttpClient>,
	_clock: Arc<dyn OAuthClock>,
) -> Result<(), OAuthCustomDispatchError> {
	dispatcher
		.register(Arc::new(ZaiApiKeyHandler::with_entropy(http, Arc::new(SystemEntropySource))))
}

struct ZaiApiKeyHandler {
	http:    Arc<dyn OAuthHttpClient>,
	entropy: Arc<dyn OAuthEntropy>,
}

impl ZaiApiKeyHandler {
	fn with_entropy(http: Arc<dyn OAuthHttpClient>, entropy: Arc<dyn OAuthEntropy>) -> Self {
		Self { http, entropy }
	}

	async fn run(
		&self,
		spec: &OAuthCustomSpec,
		driver: &LoginDriver,
	) -> Result<OAuthTokenSet, OAuthError> {
		let redirect_uri = required_parameter(spec, REDIRECT_PARAMETER)?;
		parse_http_url(redirect_uri)?;
		let business_login_url = required_parameter(spec, BUSINESS_LOGIN_PARAMETER)?;
		let biz_base = business_base(business_login_url)?;
		let key_name = required_parameter(spec, KEY_NAME_PARAMETER)?;

		let state = self.state()?;
		let mut authorize_url = parse_http_url(&spec.authorize_url)?;
		{
			let mut query = authorize_url.query_pairs_mut();
			query
				.append_pair(REDIRECT_PARAMETER, redirect_uri)
				.append_pair("response_type", "code")
				.append_pair("client_id", &spec.client.client_id)
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
				message: sf!(CALLBACK_PROMPT),
				input:   AuthPromptKind::AuthorizationCode,
			}))
			.await?;

		let code = match receive_callback_input(driver, callback_server).await? {
			AuthInput::CallbackUrl(callback) => callback_code(&callback, &state)?,
			AuthInput::AuthorizationCode(input) => manual_code(input, &state)?,
			AuthInput::Cancel => return Err(OAuthError::Cancelled),
			_ => return Err(OAuthError::UnexpectedInput),
		};
		driver.check_cancelled()?;

		let token_body = secret_json(&TokenRequest {
			provider: "zai",
			code: code.expose_secret(),
			redirect_uri,
			state: &state,
		})?;
		let token_response =
			post_json(&*self.http, &spec.client.token_url, HeaderMap::new(), token_body).await?;
		let identity = envelope_data(&token_response.body)?;
		let token_data: TokenData<'_> = decode_raw(identity)?;
		let oauth_access = trimmed(
			token_data
				.zai
				.and_then(|zai| zai.access_token)
				.ok_or(OAuthError::MalformedResponse)?,
		)
		.ok_or(OAuthError::MalformedResponse)?;
		let oauth_access = SecretString::from(oauth_access);
		let identity_response = SecretString::from(identity.get().to_owned());

		let durable_key = self
			.provision_key(business_login_url, &biz_base, key_name, &oauth_access)
			.await?;

		Ok(OAuthTokenSet {
			access_token: durable_key,
			refresh_token: None,
			token_type: sf!("Bearer"),
			expires_in: None,
			identity_response,
			project: None,
		})
	}

	async fn provision_key(
		&self,
		business_login_url: &str,
		biz_base: &str,
		key_name: &str,
		oauth_access: &SecretString,
	) -> Result<SecretString, OAuthError> {
		let login_body = secret_json(&BusinessLoginRequest { token: oauth_access.expose_secret() })?;
		let login_response =
			post_json(&*self.http, business_login_url, HeaderMap::new(), login_body).await?;
		let login_data: BusinessLoginData<'_> = decode_raw(envelope_data(&login_response.body)?)?;
		let biz_token = login_data
			.access_token
			.or(login_data.access_token_camel)
			.and_then(trimmed)
			.ok_or(OAuthError::MalformedResponse)?;
		let biz_token = SecretString::from(biz_token);

		let customer_url = format!("{biz_base}/api/biz/customer/getCustomerInfo");
		let customer_response = get_json(&*self.http, &customer_url, &biz_token).await?;
		let customer: Customer<'_> = decode_raw(envelope_data(&customer_response.body)?)?;
		let organizations = customer
			.organizations
			.ok_or(OAuthError::MalformedResponse)?;
		let organization = organizations
			.iter()
			.find(|organization| organization.is_default == Some(true))
			.or_else(|| organizations.first())
			.ok_or(OAuthError::MalformedResponse)?;
		let organization_id = organization
			.id
			.and_then(trimmed)
			.ok_or(OAuthError::MalformedResponse)?;
		let projects = organization
			.projects
			.as_deref()
			.ok_or(OAuthError::MalformedResponse)?;
		let project = projects
			.iter()
			.find(|project| project.is_default == Some(true))
			.or_else(|| projects.first())
			.ok_or(OAuthError::MalformedResponse)?;
		let project_id = project
			.project_id
			.and_then(trimmed)
			.ok_or(OAuthError::MalformedResponse)?;

		let keys_url = format!(
			"{biz_base}/api/biz/v1/organization/{organization_id}/projects/{project_id}/api_keys"
		);
		let list_response = get_json(&*self.http, &keys_url, &biz_token).await?;
		let list_data = envelope_data(&list_response.body)?;
		let existing_api_key = named_api_key(list_data, key_name)?;

		let api_key = if let Some(api_key) = existing_api_key {
			SecretString::from(api_key)
		} else {
			let create_body = secret_json(&CreateKeyRequest { name: key_name })?;
			let create_response =
				post_json(&*self.http, &keys_url, bearer_headers(&biz_token)?, create_body).await?;
			let created: KeyRecord<'_> = decode_raw(envelope_data(&create_response.body)?)?;
			SecretString::from(
				created
					.api_key
					.and_then(trimmed)
					.ok_or(OAuthError::MalformedResponse)?,
			)
		};

		let api_key_text = api_key.expose_secret();
		let mut copy_url =
			Zeroizing::new(String::with_capacity(keys_url.len() + api_key_text.len() + 7));
		copy_url.push_str(&keys_url);
		copy_url.push_str("/copy/");
		encode_uri_component(api_key_text, &mut copy_url);
		let copy_response = get_json(&*self.http, &copy_url, &biz_token).await?;
		let copied: CopiedKey<'_> = decode_raw(envelope_data(&copy_response.body)?)?;
		let secret_key = copied
			.secret_key
			.and_then(trimmed)
			.ok_or(OAuthError::MalformedResponse)?;

		let mut durable =
			Zeroizing::new(String::with_capacity(api_key_text.len() + secret_key.len() + 1));
		durable.push_str(api_key_text);
		durable.push('.');
		durable.push_str(secret_key);
		Ok(SecretString::from(mem::take(&mut *durable)))
	}

	fn state(&self) -> Result<Str, OAuthError> {
		let mut bytes = Zeroizing::new([0_u8; 16]);
		self.entropy.fill(&mut bytes[..])?;
		let mut state = String::with_capacity(32);
		for byte in bytes.iter() {
			write!(&mut state, "{byte:02x}").map_err(|_| OAuthError::Entropy)?;
		}
		Ok(state.into())
	}
}

impl fmt::Debug for ZaiApiKeyHandler {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("ZaiApiKeyHandler")
			.field("exchange", &OAuthExchangeKind::ZaiApiKey)
			.field("http", &"[REDACTED]")
			.field("entropy", &"[REDACTED]")
			.finish()
	}
}

impl OAuthCustomHandler for ZaiApiKeyHandler {
	fn exchange_kind(&self) -> OAuthExchangeKind {
		OAuthExchangeKind::ZaiApiKey
	}

	fn exchange<'a>(
		&'a self,
		spec: &'a OAuthCustomSpec,
		driver: &'a LoginDriver,
	) -> BoxFuture<'a, Result<OAuthTokenSet, OAuthError>> {
		async move { self.run(spec, driver).await }.boxed()
	}
}

fn manual_code(input: SecretString, expected_state: &str) -> Result<SecretString, OAuthError> {
	let value = input.expose_secret().trim();
	if value.is_empty() {
		return Err(OAuthError::MalformedCallback);
	}
	if value.starts_with("http://") || value.starts_with("https://") {
		return callback_code(&SecretString::from(value), expected_state);
	}
	Ok(SecretString::from(value))
}

fn required_parameter<'a>(spec: &'a OAuthCustomSpec, name: &str) -> Result<&'a str, OAuthError> {
	let mut values = spec
		.parameters
		.iter()
		.filter(|parameter| parameter.name == name);
	let value = values.next().ok_or(OAuthError::MalformedResponse)?;
	if values.next().is_some() {
		return Err(OAuthError::MalformedResponse);
	}
	trimmed(&value.value).ok_or(OAuthError::MalformedResponse)
}

fn business_base(login_url: &str) -> Result<String, OAuthError> {
	let parsed = parse_http_url(login_url)?;
	let origin = parsed.origin().ascii_serialization();
	if origin == "null" {
		Err(OAuthError::InvalidUrl)
	} else {
		Ok(origin)
	}
}

fn secret_json(value: &impl Serialize) -> Result<SecretString, OAuthError> {
	serde_json::to_string(value)
		.map(SecretString::from)
		.map_err(|_| OAuthError::MalformedResponse)
}

async fn post_json(
	http: &dyn OAuthHttpClient,
	url: &str,
	mut headers: HeaderMap,
	body: SecretString,
) -> Result<OAuthHttpResponse, OAuthError> {
	headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
	headers.insert(http::header::ACCEPT, HeaderValue::from_static("application/json"));
	let response = http
		.execute(OAuthHttpRequest::new(Method::POST, url, headers, Some(body))?)
		.await?;
	if !(200..300).contains(&response.status) {
		return Err(provider_error(response.status, &response.body, false));
	}
	Ok(response)
}

async fn get_json(
	http: &dyn OAuthHttpClient,
	url: &str,
	biz_token: &SecretString,
) -> Result<OAuthHttpResponse, OAuthError> {
	let response = http
		.execute(OAuthHttpRequest::new(Method::GET, url, bearer_headers(biz_token)?, None)?)
		.await?;
	if !(200..300).contains(&response.status) {
		return Err(provider_error(response.status, &response.body, false));
	}
	Ok(response)
}

fn bearer_headers(token: &SecretString) -> Result<HeaderMap, OAuthError> {
	let mut value = Zeroizing::new(String::with_capacity(token.expose_secret().len() + 7));
	value.push_str("Bearer ");
	value.push_str(token.expose_secret());
	let mut authorization =
		HeaderValue::from_str(&value).map_err(|_| OAuthError::MalformedResponse)?;
	authorization.set_sensitive(true);
	let mut headers = HeaderMap::new();
	headers.insert(AUTHORIZATION, authorization);
	headers.insert(http::header::ACCEPT, HeaderValue::from_static("application/json"));
	Ok(headers)
}

fn envelope_data(body: &SecretString) -> Result<&RawValue, OAuthError> {
	let raw: &RawValue =
		serde_json::from_str(body.expose_secret()).map_err(|_| OAuthError::MalformedResponse)?;
	if !raw.get().trim_start().starts_with('{') {
		return Ok(raw);
	}
	let envelope: WireEnvelope<'_> = decode_raw(raw)?;
	if !envelope.code.is_present() && !envelope.success.is_present() {
		return Ok(raw);
	}
	if envelope
		.success
		.raw()
		.is_some_and(|success| success.get() == "false")
		|| envelope.code.raw().is_some_and(|code| !success_code(code))
	{
		return Err(OAuthError::Provider {
			status:    200,
			code:      OAuthProviderCode::Unknown,
			retryable: false,
		});
	}
	Ok(envelope.data.raw().unwrap_or(raw))
}

fn success_code(code: &RawValue) -> bool {
	let value = code.get();
	if value == "null" {
		return true;
	}
	if let Ok(number) = serde_json::from_str::<serde_json::Number>(value) {
		return number
			.as_f64()
			.is_some_and(|number| number == 0.0 || number == 200.0);
	}
	matches!(serde_json::from_str::<&str>(value), Ok("0" | "200"))
}

fn decode_raw<'a, T>(raw: &'a RawValue) -> Result<T, OAuthError>
where
	T: Deserialize<'a>,
{
	serde_json::from_str(raw.get()).map_err(|_| OAuthError::MalformedResponse)
}

fn named_api_key<'a>(raw: &'a RawValue, key_name: &str) -> Result<Option<&'a str>, OAuthError> {
	let records = if raw.get().trim_start().starts_with('[') {
		decode_raw::<Vec<KeyRecord<'a>>>(raw)?
	} else {
		let wrappers: KeyWrappers<'a> = decode_raw(raw)?;
		wrappers
			.list
			.or(wrappers.keys)
			.or(wrappers.api_keys)
			.or(wrappers.records)
			.unwrap_or_default()
	};
	let Some(record) = records
		.into_iter()
		.find(|record| record.name == Some(key_name))
	else {
		return Ok(None);
	};
	record
		.api_key
		.and_then(trimmed)
		.map(Some)
		.ok_or(OAuthError::MalformedResponse)
}

fn encode_uri_component(value: &str, destination: &mut String) {
	const HEX: &[u8; 16] = b"0123456789ABCDEF";
	for byte in value.bytes() {
		if byte.is_ascii_alphanumeric()
			|| matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')')
		{
			destination.push(char::from(byte));
		} else {
			destination.push('%');
			destination.push(char::from(HEX[usize::from(byte >> 4)]));
			destination.push(char::from(HEX[usize::from(byte & 0x0f)]));
		}
	}
}

fn trimmed(value: &str) -> Option<&str> {
	let value = value.trim();
	(!value.is_empty()).then_some(value)
}

#[derive(Default)]
struct PresentRaw<'a>(Option<&'a RawValue>);

impl<'a> PresentRaw<'a> {
	const fn is_present(&self) -> bool {
		self.0.is_some()
	}

	const fn raw(&self) -> Option<&'a RawValue> {
		self.0
	}
}

impl<'de: 'a, 'a> Deserialize<'de> for PresentRaw<'a> {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: Deserializer<'de>,
	{
		<&'de RawValue>::deserialize(deserializer).map(|raw| Self(Some(raw)))
	}
}

#[derive(Deserialize)]
struct WireEnvelope<'a> {
	#[serde(borrow, default)]
	code:    PresentRaw<'a>,
	#[serde(borrow, default)]
	success: PresentRaw<'a>,
	#[serde(borrow, default)]
	data:    PresentRaw<'a>,
}

#[derive(Serialize)]
struct TokenRequest<'a> {
	provider:     &'static str,
	code:         &'a str,
	redirect_uri: &'a str,
	state:        &'a str,
}

#[derive(Deserialize)]
struct TokenData<'a> {
	#[serde(borrow)]
	zai: Option<ZaiToken<'a>>,
}

#[derive(Deserialize)]
struct ZaiToken<'a> {
	access_token: Option<&'a str>,
}

#[derive(Serialize)]
struct BusinessLoginRequest<'a> {
	token: &'a str,
}

#[derive(Deserialize)]
struct BusinessLoginData<'a> {
	access_token:       Option<&'a str>,
	#[serde(rename = "accessToken")]
	access_token_camel: Option<&'a str>,
}

#[derive(Deserialize)]
struct Customer<'a> {
	#[serde(borrow)]
	organizations: Option<Vec<Organization<'a>>>,
}

#[derive(Deserialize)]
struct Organization<'a> {
	#[serde(rename = "organizationId")]
	id:         Option<&'a str>,
	#[serde(rename = "isDefault")]
	is_default: Option<bool>,
	#[serde(borrow)]
	projects:   Option<Vec<Project<'a>>>,
}

#[derive(Deserialize)]
struct Project<'a> {
	#[serde(rename = "projectId")]
	project_id: Option<&'a str>,
	#[serde(rename = "isDefault")]
	is_default: Option<bool>,
}

#[derive(Serialize)]
struct CreateKeyRequest<'a> {
	name: &'a str,
}

#[derive(Deserialize)]
struct KeyWrappers<'a> {
	#[serde(borrow)]
	list:     Option<Vec<KeyRecord<'a>>>,
	#[serde(borrow)]
	keys:     Option<Vec<KeyRecord<'a>>>,
	#[serde(borrow, rename = "apiKeys")]
	api_keys: Option<Vec<KeyRecord<'a>>>,
	#[serde(borrow)]
	records:  Option<Vec<KeyRecord<'a>>>,
}

#[derive(Deserialize)]
struct KeyRecord<'a> {
	name:    Option<&'a str>,
	#[serde(rename = "apiKey")]
	api_key: Option<&'a str>,
}

#[derive(Deserialize)]
struct CopiedKey<'a> {
	#[serde(rename = "secretKey")]
	secret_key: Option<&'a str>,
}

#[cfg(test)]
mod tests {
	use std::{collections::VecDeque, sync::Arc};

	use http::header::{ACCEPT, HeaderName};
	use parking_lot::Mutex;

	use super::*;
	use crate::{
		answer::{AuthEvent, AuthResponse},
		auth::{
			CredentialSourceSpec, HeaderPlacement, OAuthClientSpec, OAuthRefreshSpec,
			OAuthTransportError, default_login_channels,
		},
		id::LoginSessionId,
	};

	const STATE: &str = "000102030405060708090a0b0c0d0e0f";
	const REDIRECT: &str = "http://localhost:54548/callback";

	struct FixedEntropy;

	impl OAuthEntropy for FixedEntropy {
		fn fill(&self, destination: &mut [u8]) -> Result<(), OAuthError> {
			for (index, byte) in destination.iter_mut().enumerate() {
				*byte = u8::try_from(index).expect("test entropy index");
			}
			Ok(())
		}
	}

	#[derive(Eq, PartialEq)]
	struct RecordedRequest {
		method:        Method,
		url:           String,
		authorization: Option<String>,
		content_type:  Option<String>,
		accept:        Option<String>,
		body:          Option<String>,
	}

	impl fmt::Debug for RecordedRequest {
		fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
			formatter.write_str("RecordedRequest([REDACTED])")
		}
	}

	struct ScriptedHttp {
		responses: Mutex<VecDeque<OAuthHttpResponse>>,
		requests:  Mutex<Vec<RecordedRequest>>,
	}

	impl ScriptedHttp {
		fn new(responses: impl IntoIterator<Item = OAuthHttpResponse>) -> Self {
			Self {
				responses: Mutex::new(responses.into_iter().collect()),
				requests:  Mutex::new(Vec::new()),
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
				authorization: header(&headers, AUTHORIZATION),
				content_type: header(&headers, CONTENT_TYPE),
				accept: header(&headers, ACCEPT),
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

	fn header(headers: &HeaderMap, name: HeaderName) -> Option<String> {
		headers
			.get(name)
			.and_then(|value| value.to_str().ok())
			.map(str::to_owned)
	}

	fn response(status: u16, body: &str) -> OAuthHttpResponse {
		OAuthHttpResponse { status, headers: HeaderMap::new(), body: SecretString::from(body) }
	}

	fn spec() -> OAuthCustomSpec {
		OAuthCustomSpec {
			client:        OAuthClientSpec {
				sources:      vec![CredentialSourceSpec::Interactive],
				client_id:    "catalog-client".into(),
				refresh:      OAuthRefreshSpec::Unsupported,
				token_url:    "https://token.example/oauth/token".into(),
				scopes:       Vec::new(),
				audience:     None,
				token_params: Vec::new(),
				placement:    HeaderPlacement::bearer().into(),
			},
			authorize_url: "https://chat.example/oauth/authorize".into(),
			exchange:      OAuthExchangeKind::ZaiApiKey,
			parameters:    vec![
				crate::auth::OAuthParameter {
					name:  BUSINESS_LOGIN_PARAMETER.into(),
					value: "https://biz.example/api/auth/z/login".into(),
				},
				crate::auth::OAuthParameter {
					name:  KEY_NAME_PARAMETER.into(),
					value: "catalog-key".into(),
				},
				crate::auth::OAuthParameter {
					name:  REDIRECT_PARAMETER.into(),
					value: REDIRECT.into(),
				},
			],
			polling:       None,
		}
	}

	async fn exchange(
		http: Arc<ScriptedHttp>,
	) -> (Result<OAuthTokenSet, OAuthError>, Vec<RecordedRequest>, Vec<AuthEvent>) {
		let handler = ZaiApiKeyHandler::with_entropy(http.clone(), Arc::new(FixedEntropy));
		let (session, driver, _) = default_login_channels(LoginSessionId::from("zai-test"));
		session
			.responses
			.send(AuthResponse {
				session: session.id.clone(),
				input:   AuthInput::AuthorizationCode(SecretString::from(format!(
					"{REDIRECT}?code=auth-code&state={STATE}"
				))),
			})
			.expect("callback response");
		let result = handler.run(&spec(), &driver).await;
		let events = session.events.try_iter().map(Result::unwrap).collect();
		let requests = mem::take(&mut *http.requests.lock());
		(result, requests, events)
	}
	#[test]
	fn manual_input_accepts_trimmed_code_or_stateful_redirect() {
		let raw = manual_code(SecretString::from("  raw-code  "), STATE).expect("raw code");
		assert_eq!(raw.expose_secret(), "raw-code");
		let callback = manual_code(
			SecretString::from(format!("  {REDIRECT}?code=url-code&state={STATE}  ")),
			STATE,
		)
		.expect("callback URL");
		assert_eq!(callback.expose_secret(), "url-code");
		assert_eq!(
			manual_code(SecretString::from(format!("{REDIRECT}?code=url-code&state=wrong")), STATE,)
				.expect_err("mismatched state"),
			OAuthError::StateMismatch,
		);
	}

	fn common_prefix() -> Vec<OAuthHttpResponse> {
		vec![
			response(
				200,
				r#"{"code":0,"data":{"zai":{"access_token":"oauth-secret"},"user":{"email":"person@example.com","id":42}}}"#,
			),
			response(200, r#"{"code":200,"success":true,"data":{"access_token":"biz-secret"}}"#),
			response(
				200,
				r#"{"success":true,"data":{"organizations":[{"organizationId":"other-org","isDefault":false,"projects":[{"projectId":"other-project","isDefault":true}]},{"organizationId":"default-org","isDefault":true,"projects":[{"projectId":"fallback-project","isDefault":false},{"projectId":"default-project","isDefault":true}]}]}}"#,
			),
		]
	}

	#[tokio::test]
	async fn existing_key_flow_matches_upstream_wire_sequence() {
		let mut responses = common_prefix();
		responses.extend([
			response(
				200,
				r#"{"code":"200","data":{"list":[{"name":"catalog-key","apiKey":"api/id"}]}}"#,
			),
			response(200, r#"{"code":200,"data":{"secretKey":"durable-secret"}}"#),
		]);
		let http = Arc::new(ScriptedHttp::new(responses));
		let (tokens, requests, events) = exchange(http).await;
		let tokens = tokens.expect("existing key exchange");

		assert_eq!(tokens.access_token.expose_secret(), "api/id.durable-secret");
		assert!(!tokens.is_refreshable());
		assert_eq!(tokens.token_type(), "Bearer");
		assert_eq!(tokens.expires_in(), None);
		assert_eq!(
			tokens.identity_response.expose_secret(),
			r#"{"zai":{"access_token":"oauth-secret"},"user":{"email":"person@example.com","id":42}}"#,
		);
		assert!(matches!(&events[..], [AuthEvent::OpenUrl { .. }, AuthEvent::Prompt(_)]));
		let AuthEvent::OpenUrl { url, .. } = &events[0] else {
			unreachable!()
		};
		assert_eq!(
			url.as_str(),
			format!("https://chat.example/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A54548%2Fcallback&response_type=code&client_id=catalog-client&state={STATE}"),
		);
		assert_eq!(requests, vec![
			recorded(Method::POST, "https://token.example/oauth/token", None, Some(r#"{"provider":"zai","code":"auth-code","redirect_uri":"http://localhost:54548/callback","state":"000102030405060708090a0b0c0d0e0f"}"#)),
			recorded(Method::POST, "https://biz.example/api/auth/z/login", None, Some(r#"{"token":"oauth-secret"}"#)),
			recorded(Method::GET, "https://biz.example/api/biz/customer/getCustomerInfo", Some("Bearer biz-secret"), None),
			recorded(Method::GET, "https://biz.example/api/biz/v1/organization/default-org/projects/default-project/api_keys", Some("Bearer biz-secret"), None),
			recorded(Method::GET, "https://biz.example/api/biz/v1/organization/default-org/projects/default-project/api_keys/copy/api%2Fid", Some("Bearer biz-secret"), None),
		]);
		let debug = format!("{tokens:?}");
		for secret in ["oauth-secret", "biz-secret", "api/id", "durable-secret"] {
			assert!(!debug.contains(secret));
		}
	}

	#[tokio::test]
	async fn absent_key_is_created_with_catalog_name_then_copied() {
		let mut responses = common_prefix();
		responses.extend([
			response(200, r#"{"code":0,"data":{"records":[]}}"#),
			response(200, r#"{"success":true,"data":{"name":"catalog-key","apiKey":"created-key"}}"#),
			response(200, r#"{"secretKey":"created-secret"}"#),
		]);
		let http = Arc::new(ScriptedHttp::new(responses));
		let (tokens, requests, _) = exchange(http).await;
		assert_eq!(
			tokens.expect("created key").access_token.expose_secret(),
			"created-key.created-secret"
		);
		assert_eq!(requests[4], recorded(
			Method::POST,
			"https://biz.example/api/biz/v1/organization/default-org/projects/default-project/api_keys",
			Some("Bearer biz-secret"),
			Some(r#"{"name":"catalog-key"}"#),
		));
		assert_eq!(requests[5].url, "https://biz.example/api/biz/v1/organization/default-org/projects/default-project/api_keys/copy/created-key");
	}

	#[tokio::test]
	async fn missing_organization_project_api_key_or_secret_fails_closed() {
		let scenarios = [
			vec![
				common_prefix()[0].body.expose_secret().to_owned(),
				common_prefix()[1].body.expose_secret().to_owned(),
				r#"{"code":200,"data":{"organizations":[]}}"#.to_owned(),
			],
			vec![
				common_prefix()[0].body.expose_secret().to_owned(),
				common_prefix()[1].body.expose_secret().to_owned(),
				r#"{"code":200,"data":{"organizations":[{"organizationId":"org","projects":[]}]}}"#
					.to_owned(),
			],
			vec![
				common_prefix()[0].body.expose_secret().to_owned(),
				common_prefix()[1].body.expose_secret().to_owned(),
				common_prefix()[2].body.expose_secret().to_owned(),
				r#"[{"name":"catalog-key"}]"#.to_owned(),
			],
			vec![
				common_prefix()[0].body.expose_secret().to_owned(),
				common_prefix()[1].body.expose_secret().to_owned(),
				common_prefix()[2].body.expose_secret().to_owned(),
				r#"{"data":[]}"#.to_owned(),
				r#"{"data":{"name":"catalog-key"}}"#.to_owned(),
			],
			vec![
				common_prefix()[0].body.expose_secret().to_owned(),
				common_prefix()[1].body.expose_secret().to_owned(),
				common_prefix()[2].body.expose_secret().to_owned(),
				r#"[{"name":"catalog-key","apiKey":"api-key"}]"#.to_owned(),
				r#"{"code":200,"data":{}}"#.to_owned(),
			],
		];
		for bodies in scenarios {
			let http = Arc::new(ScriptedHttp::new(bodies.iter().map(|body| response(200, body))));
			let (result, ..) = exchange(http).await;
			assert_eq!(result.expect_err("missing field must fail"), OAuthError::MalformedResponse);
		}
	}

	#[tokio::test]
	async fn envelope_and_http_failures_discard_provider_source_text() {
		for failure in [
			response(
				200,
				r#"{"code":500,"success":false,"msg":"oauth-secret biz-secret api-secret"}"#,
			),
			response(
				401,
				r#"{"error":"invalid_grant","error_description":"oauth-secret biz-secret api-secret"}"#,
			),
		] {
			let http = Arc::new(ScriptedHttp::new([failure]));
			let (result, ..) = exchange(http).await;
			let error = result.expect_err("provider failure");
			let rendered = format!("{error:?} {error}");
			for secret in ["oauth-secret", "biz-secret", "api-secret"] {
				assert!(!rendered.contains(secret));
			}
			assert!(matches!(error, OAuthError::Provider { .. }));
		}
	}

	fn recorded(
		method: Method,
		url: &str,
		authorization: Option<&str>,
		body: Option<&str>,
	) -> RecordedRequest {
		RecordedRequest {
			method,
			url: url.to_owned(),
			authorization: authorization.map(str::to_owned),
			content_type: body.map(|_| "application/json".to_owned()),
			accept: Some("application/json".to_owned()),
			body: body.map(str::to_owned),
		}
	}
}
