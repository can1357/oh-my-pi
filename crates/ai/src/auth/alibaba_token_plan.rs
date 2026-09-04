//! Alibaba `QwenCloud` Token Plan credential shaping and interactive login.

use std::{
	collections::BTreeSet,
	fmt,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::{Instant, SystemTime},
};

use futures::{
	FutureExt as _,
	future::{BoxFuture, Either, ready},
};
use http::{HeaderMap, HeaderValue, Method, header::AUTHORIZATION};
use omp_catalog::{AuthSpecId, ProviderId, provider::AuthSpecKind, snapshot::Catalog};
use omp_core::{ExposeSecret as _, SecretBox, SecretString, Str, sf};
use serde::{Deserialize, Serialize};

use super::{
	AuthLoginEngine, CredentialOrigin, CredentialStore, CredentialWrite, KeyError, LoginDriver,
	OAuthHttpClient, OAuthHttpRequest, StoreError, default_login_channels,
	shape::{ProviderShapeFuture, ShapedCredential},
};
use crate::{
	account::{AccountPool, AccountRecord},
	answer::{AccountState, AccountSummary, AuthEvent, AuthPrompt, AuthPromptKind, AuthSession},
	call::{AccountRoutingContext, AuthInput, AuthMethod, LoginRequest},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	id::{AccountId, LoginSessionId, PrincipalId},
	receipt::ExecutionReceipt,
};

/// International `QwenCloud` Token Plan OpenAI-compatible API base URL.
pub const ALIBABA_TOKEN_PLAN_BASE_URL: &str =
	"https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
/// China (Beijing) `QwenCloud` Token Plan OpenAI-compatible API base URL.
pub const ALIBABA_TOKEN_PLAN_CN_BASE_URL: &str =
	"https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";

const PROVIDER: &str = "alibaba-token-plan";
const INTERNATIONAL_AUTH_URL: &str =
	"https://home.qwencloud.com/billing/subscription/token-plan-individual";
const CHINA_AUTH_URL: &str = "https://www.aliyun.com/benefit/scene/tokenplan";
const REGION_PROMPT: &str = "Select QwenCloud Token Plan region: 1=International (default), \
                             2=China (Beijing), 3=Custom — enter 1, 2, or 3";
const CUSTOM_URL_PROMPT: &str = "Enter custom Token Plan base URL";
const API_KEY_PROMPT: &str = "Paste your QwenCloud Token Plan API key";
const INTERNATIONAL_COOKIE_PROMPT: &str =
	"Optional quota reporting: open browser DevTools → Network, reload the Token Plan page, filter \
	 for api.json, and select the cs-data.qwencloud.com/data/api.json request whose api query ends \
	 in /tokenplan/personal/api/v2/usage. Copy Request Headers → Cookie, then paste the complete \
	 name=value; ... value here, or press Enter to skip.";
const CHINA_COOKIE_PROMPT: &str =
	"Optional quota reporting: open browser DevTools → Network, reload the Token Plan page, filter \
	 for api.json, and select the bailian-cs.console.aliyun.com/data/api.json request whose api \
	 query ends in /tokenplan/personal/api/v2/usage. Copy Request Headers → Cookie, then paste the \
	 complete name=value; ... value here, or press Enter to skip.";

static LOGIN_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Parsed Alibaba Token Plan credential material.
#[derive(Clone)]
pub struct AlibabaTokenPlanCredential {
	/// Dedicated Token Plan API key.
	pub token:    SecretString,
	/// Optional console request cookie used only for quota reporting.
	pub cookie:   Option<SecretString>,
	/// Optional region-specific OpenAI-compatible API base URL.
	pub base_url: Option<Str>,
}

impl fmt::Debug for AlibabaTokenPlanCredential {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("AlibabaTokenPlanCredential")
			.field("token", &"[REDACTED]")
			.field("cookie", &self.cookie.as_ref().map(|_| "[REDACTED]"))
			.field("base_url", &self.base_url)
			.finish()
	}
}

#[derive(Deserialize)]
struct CredentialEnvelope<'a> {
	token:    &'a str,
	#[serde(default)]
	cookie:   Option<&'a str>,
	#[serde(rename = "baseUrl", default)]
	base_url: Option<&'a str>,
}

#[derive(Serialize)]
struct SerializableEnvelope<'a> {
	token:    &'a str,
	#[serde(skip_serializing_if = "Option::is_none")]
	cookie:   Option<&'a str>,
	#[serde(rename = "baseUrl", skip_serializing_if = "Option::is_none")]
	base_url: Option<&'a str>,
}

/// Parses either a bare Token Plan API key or its JSON credential envelope.
pub fn parse_alibaba_token_plan_credential(raw: &str) -> Option<AlibabaTokenPlanCredential> {
	let raw = raw.trim();
	if raw.is_empty() {
		return None;
	}
	if !raw.starts_with('{') {
		return valid_token(raw).then(|| AlibabaTokenPlanCredential {
			token:    SecretString::from(raw.to_owned()),
			cookie:   None,
			base_url: None,
		});
	}
	let envelope: CredentialEnvelope<'_> = serde_json::from_str(raw).ok()?;
	let token = envelope.token.trim();
	if !valid_token(token) {
		return None;
	}
	Some(AlibabaTokenPlanCredential {
		token:    SecretString::from(token.to_owned()),
		cookie:   nonempty_secret(envelope.cookie),
		base_url: nonempty(envelope.base_url),
	})
}

/// Serializes Token Plan material, using a bare key when no metadata is needed.
pub fn serialize_alibaba_token_plan_credential(
	token: &str,
	cookie: Option<&str>,
	base_url: Option<&str>,
) -> SecretString {
	let cookie = cookie.map(str::trim).filter(|value| !value.is_empty());
	let base_url = base_url.map(str::trim).filter(|value| !value.is_empty());
	if cookie.is_none() && base_url.is_none() {
		return SecretString::from(token.to_owned());
	}
	SecretString::from(
		serde_json::to_string(&SerializableEnvelope { token, cookie, base_url })
			.expect("credential envelope serialization is infallible"),
	)
}

fn nonempty_secret(value: Option<&str>) -> Option<SecretString> {
	value
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(|value| SecretString::from(value.to_owned()))
}

fn nonempty(value: Option<&str>) -> Option<Str> {
	value
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(Str::new)
}

fn valid_token(token: &str) -> bool {
	let Some(body) = token.strip_prefix("sk-") else {
		return false;
	};
	let unpadded = body.trim_end_matches('=');
	let padding = body.len().saturating_sub(unpadded.len());
	!unpadded.is_empty()
		&& padding <= 2
		&& unpadded.bytes().all(|byte| {
			byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'+' | b'/' | b'-')
		})
}

/// Credential shaper that keeps console cookies out of provider requests.
#[derive(Clone, Debug)]
pub struct AlibabaTokenPlanShaper {
	provider: ProviderId,
}

impl AlibabaTokenPlanShaper {
	/// Constructs the Alibaba Token Plan credential shaper.
	pub fn new() -> Self {
		Self { provider: ProviderId::from(PROVIDER) }
	}

	/// Provider whose credentials this shaper rewrites.
	pub fn provider(&self) -> &ProviderId<str> {
		&self.provider
	}

	/// Removes an Alibaba credential envelope before provider authentication.
	pub fn shape<'a>(
		&'a self,
		raw: &'a SecretString,
		route_base_url: &'a str,
		_deadline: Option<Instant>,
	) -> ProviderShapeFuture<'a> {
		let exposed = raw.expose_secret();
		let shaped = if exposed.trim().starts_with('{') {
			parse_alibaba_token_plan_credential(exposed).map(
				|AlibabaTokenPlanCredential { token, base_url, .. }| ShapedCredential {
					secret:            Some(token),
					endpoint_override: base_url.filter(|base_url| base_url.as_str() != route_base_url),
				},
			)
		} else {
			None
		};
		Either::Left(ready(shaped))
	}
}

impl Default for AlibabaTokenPlanShaper {
	fn default() -> Self {
		Self::new()
	}
}

/// Typed Alibaba Token Plan interactive-login failure.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AlibabaTokenPlanLoginError {
	/// Option 3 was selected without a custom URL.
	#[error("Custom URL is required for option 3")]
	CustomUrlRequired,
	/// A required dedicated API key was omitted.
	#[error("QwenCloud Token Plan API key is required")]
	ApiKeyRequired,
	/// An input used the wrong login response form.
	#[error("invalid Alibaba Token Plan login response")]
	InvalidResponse,
	/// The API-key validation request could not be constructed or sent.
	#[error("QwenCloud Token Plan API key validation failed")]
	ValidationTransport,
	/// The provider rejected the dedicated API key.
	#[error("QwenCloud Token Plan API key validation failed with HTTP {0}")]
	ValidationStatus(u16),
	/// The optional console Cookie header was malformed.
	#[error(
		"Invalid QwenCloud Cookie header. Copy the complete Cookie request header from the {host} \
		 usage request, not a single cookie value."
	)]
	InvalidCookie {
		/// Console host whose usage request supplies the cookie.
		host: &'static str,
	},
	/// The configured OS credential facility cannot encrypt persistent state.
	#[error("Alibaba Token Plan credential storage is unavailable")]
	CredentialStorageUnavailable,
	/// Persistent credential or account state could not be updated.
	#[error("Alibaba Token Plan credential storage failed")]
	Store,
	/// The requested provider or authentication spec does not match this engine.
	#[error("Alibaba Token Plan authentication is unavailable")]
	Unavailable,
}

/// Interactive login engine for Alibaba `QwenCloud` Token Plan credentials.
#[derive(Clone)]
pub struct AlibabaTokenPlanLoginEngine {
	catalog:  Arc<Catalog>,
	store:    Arc<CredentialStore>,
	accounts: AccountPool,
	http:     Arc<dyn OAuthHttpClient>,
	provider: ProviderId,
}

impl AlibabaTokenPlanLoginEngine {
	/// Constructs a persistent provider-scoped Token Plan login engine.
	pub fn new(
		catalog: Arc<Catalog>,
		store: Arc<CredentialStore>,
		accounts: AccountPool,
		http: Arc<dyn OAuthHttpClient>,
	) -> Self {
		Self { catalog, store, accounts, http, provider: ProviderId::from(PROVIDER) }
	}
}

impl AuthLoginEngine for AlibabaTokenPlanLoginEngine {
	fn method(&self) -> AuthMethod {
		AuthMethod::ApiKey
	}

	fn supports(&self, provider: &ProviderId<str>) -> bool {
		provider == &self.provider
	}

	fn begin(
		&self,
		request: LoginRequest,
		spec: AuthSpecId,
	) -> BoxFuture<'_, Result<AuthSession, Error>> {
		let catalog = Arc::clone(&self.catalog);
		let store = Arc::clone(&self.store);
		let accounts = self.accounts.clone();
		let http = Arc::clone(&self.http);
		let expected_provider = self.provider.clone();
		async move {
			if request.provider != expected_provider
				|| catalog
					.auth_spec(&spec)
					.is_none_or(|auth| auth.kind != AuthSpecKind::Bearer)
			{
				return Err(login_error(AlibabaTokenPlanLoginError::Unavailable));
			}
			let provider = catalog
				.provider(&request.provider)
				.ok_or_else(|| login_error(AlibabaTokenPlanLoginError::Unavailable))?;
			let routes = provider.routes.iter().cloned().collect();
			let provider_id = request.provider;
			let id = LoginSessionId::from(format!(
				"alibaba-token-plan-{}",
				LOGIN_SEQUENCE.fetch_add(1, Ordering::Relaxed)
			));
			let (session, driver, _) = default_login_channels(id);
			tokio::spawn(async move {
				let result = run_login(driver, provider_id, routes, store, accounts, http).await;
				if let Err(error) = result {
					let _ = error.0.emit_error(login_error(error.1)).await;
				}
			});
			Ok(session)
		}
		.boxed()
	}
}

async fn run_login(
	driver: LoginDriver,
	provider_id: ProviderId,
	routes: BTreeSet<omp_catalog::RouteId>,
	store: Arc<CredentialStore>,
	accounts: AccountPool,
	http: Arc<dyn OAuthHttpClient>,
) -> Result<(), (LoginDriver, AlibabaTokenPlanLoginError)> {
	match run_login_inner(&driver, provider_id, routes, store, accounts, http).await {
		Ok(()) => Ok(()),
		Err(error) => Err((driver, error)),
	}
}

async fn run_login_inner(
	driver: &LoginDriver,
	provider_id: ProviderId,
	routes: BTreeSet<omp_catalog::RouteId>,
	store: Arc<CredentialStore>,
	accounts: AccountPool,
	http: Arc<dyn OAuthHttpClient>,
) -> Result<(), AlibabaTokenPlanLoginError> {
	emit_prompt(driver, "region", REGION_PROMPT, AuthPromptKind::PlainText).await?;
	let region = receive_text(driver, AuthPromptKind::PlainText).await?;
	let (base_url, auth_url) = match region.trim() {
		"2" => (sf!(ALIBABA_TOKEN_PLAN_CN_BASE_URL), CHINA_AUTH_URL),
		"3" => {
			emit_prompt(driver, "custom-url", CUSTOM_URL_PROMPT, AuthPromptKind::PlainText).await?;
			let custom = receive_text(driver, AuthPromptKind::PlainText).await?;
			let custom = custom.trim().trim_end_matches('/');
			if custom.is_empty() {
				return Err(AlibabaTokenPlanLoginError::CustomUrlRequired);
			}
			(Str::new(custom), INTERNATIONAL_AUTH_URL)
		},
		_ => (sf!(ALIBABA_TOKEN_PLAN_BASE_URL), INTERNATIONAL_AUTH_URL),
	};
	driver
		.emit(AuthEvent::OpenUrl { url: Str::new(auth_url), launch: None })
		.await
		.map_err(|_| AlibabaTokenPlanLoginError::InvalidResponse)?;
	emit_prompt(driver, "api-key", API_KEY_PROMPT, AuthPromptKind::ApiKey).await?;
	let token = receive_text(driver, AuthPromptKind::ApiKey).await?;
	let token = token.trim();
	if token.is_empty() {
		return Err(AlibabaTokenPlanLoginError::ApiKeyRequired);
	}
	validate_token(http.as_ref(), base_url.as_str(), token).await?;

	let china = base_url.as_str() == ALIBABA_TOKEN_PLAN_CN_BASE_URL;
	let cookie_host = if china {
		"bailian-cs.console.aliyun.com"
	} else {
		"cs-data.qwencloud.com"
	};
	emit_prompt(
		driver,
		"cookie",
		if china {
			CHINA_COOKIE_PROMPT
		} else {
			INTERNATIONAL_COOKIE_PROMPT
		},
		AuthPromptKind::OptionalSecret,
	)
	.await?;
	let cookie_input = receive_text(driver, AuthPromptKind::OptionalSecret).await?;
	let cookie = strip_cookie_prefix(cookie_input.trim()).trim();
	if !cookie.is_empty() && !valid_cookie(cookie) {
		return Err(AlibabaTokenPlanLoginError::InvalidCookie { host: cookie_host });
	}
	let base_url_override =
		(base_url.as_str() != ALIBABA_TOKEN_PLAN_BASE_URL).then_some(base_url.as_str());
	let serialized = serialize_alibaba_token_plan_credential(
		token,
		(!cookie.is_empty()).then_some(cookie),
		base_url_override,
	);
	let principal = PrincipalId::from(PROVIDER);
	let account = AccountId::from(format!("{provider_id}:{PROVIDER}"));
	let bytes = SecretBox::new(Box::new(serialized.expose_secret().as_bytes().to_vec()));
	let metadata = store
		.put(CredentialWrite {
			account_id:          &account,
			principal_id:        &principal,
			kind:                "bearer",
			secret:              &bytes,
			expires_at_ms:       None,
			origin:              CredentialOrigin::Persistent,
			now_ms:              unix_millis(SystemTime::now())?,
			expected_generation: None,
		})
		.map_err(credential_store_error)?;
	accounts
		.upsert(AccountRecord {
			account: account.clone(),
			principal: principal.clone(),
			provider: provider_id.clone(),
			routes,
			enabled: true,
			credential_generation: metadata.generation,
			routing: AccountRoutingContext::default(),
		})
		.map_err(|_| AlibabaTokenPlanLoginError::Store)?;
	driver
		.emit(AuthEvent::Complete(AccountSummary {
			account,
			provider: provider_id,
			principal: Some(principal),
			label: Some(sf!(PROVIDER)),
			state: AccountState::Active,
		}))
		.await
		.map_err(|_| AlibabaTokenPlanLoginError::InvalidResponse)
}

async fn emit_prompt(
	driver: &LoginDriver,
	id: &'static str,
	message: &'static str,
	input: AuthPromptKind,
) -> Result<(), AlibabaTokenPlanLoginError> {
	driver
		.emit(AuthEvent::Prompt(AuthPrompt { id: Str::new(id), message: Str::new(message), input }))
		.await
		.map_err(|_| AlibabaTokenPlanLoginError::InvalidResponse)
}

async fn receive_text(
	driver: &LoginDriver,
	expected: AuthPromptKind,
) -> Result<String, AlibabaTokenPlanLoginError> {
	match (
		expected,
		driver
			.receive()
			.await
			.map_err(|_| AlibabaTokenPlanLoginError::InvalidResponse)?,
	) {
		(AuthPromptKind::ApiKey, AuthInput::ApiKey(value))
		| (AuthPromptKind::OptionalSecret, AuthInput::OptionalSecret(value)) => {
			Ok(value.expose_secret().to_owned())
		},
		(AuthPromptKind::PlainText, AuthInput::PlainText(value)) => Ok(value.to_string()),
		_ => Err(AlibabaTokenPlanLoginError::InvalidResponse),
	}
}

async fn validate_token(
	http: &dyn OAuthHttpClient,
	base_url: &str,
	token: &str,
) -> Result<(), AlibabaTokenPlanLoginError> {
	let mut headers = HeaderMap::new();
	let mut authorization = HeaderValue::from_str(&format!("Bearer {token}"))
		.map_err(|_| AlibabaTokenPlanLoginError::ValidationTransport)?;
	authorization.set_sensitive(true);
	headers.insert(AUTHORIZATION, authorization);
	let request = OAuthHttpRequest::new(Method::GET, &format!("{base_url}/models"), headers, None)
		.map_err(|_| AlibabaTokenPlanLoginError::ValidationTransport)?;
	let response = http
		.execute(request)
		.await
		.map_err(|_| AlibabaTokenPlanLoginError::ValidationTransport)?;
	if !(200..300).contains(&response.status) {
		return Err(AlibabaTokenPlanLoginError::ValidationStatus(response.status));
	}
	Ok(())
}

fn strip_cookie_prefix(cookie: &str) -> &str {
	if cookie
		.get(..7)
		.is_some_and(|prefix| prefix.eq_ignore_ascii_case("cookie:"))
	{
		cookie[7..].trim_start()
	} else {
		cookie
	}
}

fn valid_cookie(cookie: &str) -> bool {
	cookie.split(';').any(|segment| {
		let Some(separator) = segment.find('=') else {
			return false;
		};
		separator > 0
			&& !segment[..separator].trim().is_empty()
			&& !segment[separator + 1..].trim().is_empty()
	})
}

fn unix_millis(now: SystemTime) -> Result<u64, AlibabaTokenPlanLoginError> {
	now.duration_since(SystemTime::UNIX_EPOCH)
		.map_err(|_| AlibabaTokenPlanLoginError::Store)?
		.as_millis()
		.try_into()
		.map_err(|_| AlibabaTokenPlanLoginError::Store)
}

fn credential_store_error(error: StoreError) -> AlibabaTokenPlanLoginError {
	if matches!(error, StoreError::Key(KeyError::Unavailable | KeyError::OsCredential)) {
		AlibabaTokenPlanLoginError::CredentialStorageUnavailable
	} else {
		AlibabaTokenPlanLoginError::Store
	}
}

fn login_error(error: AlibabaTokenPlanLoginError) -> Error {
	let message = Str::new(error.to_string());
	Error::new(
		match error {
			AlibabaTokenPlanLoginError::ValidationStatus(_)
			| AlibabaTokenPlanLoginError::ValidationTransport
			| AlibabaTokenPlanLoginError::ApiKeyRequired => ErrorKind::Authentication,
			AlibabaTokenPlanLoginError::CredentialStorageUnavailable => {
				ErrorKind::CredentialStorageUnavailable
			},
			AlibabaTokenPlanLoginError::Store => ErrorKind::InternalInvariant,
			_ => ErrorKind::InvalidRequest,
		},
		ErrorPhase::Authentication,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.code(message.clone())
	.detail(ErrorDetail::provider(message))
}

#[cfg(test)]
mod tests {
	use std::{env, fs, path::PathBuf, time::Duration};

	use futures::future::Either;
	use omp_core::SecretString;
	use parking_lot::Mutex;
	use tokio::time;

	use super::{
		super::{
			CredentialNeed, CredentialSource, HeadlessKeySource, KeyId, OAuthHttpResponse,
			OAuthTransportError, StoredCredentialSource,
		},
		*,
	};
	use crate::answer::AuthResponse;

	#[test]
	fn unavailable_credential_key_has_distinct_login_error() {
		assert_eq!(
			credential_store_error(StoreError::Key(KeyError::Unavailable)),
			AlibabaTokenPlanLoginError::CredentialStorageUnavailable
		);
	}

	#[test]
	fn parse_rejects_malformed_json_and_non_token_material() {
		assert!(parse_alibaba_token_plan_credential("{oops").is_none());
		assert!(parse_alibaba_token_plan_credential(r#"{"token":"ordinary"}"#).is_none());
		assert!(parse_alibaba_token_plan_credential("ordinary").is_none());
		assert!(parse_alibaba_token_plan_credential("sk-a===").is_none());
	}

	#[test]
	fn serialization_round_trips_and_preserves_wire_field_names() {
		let serialized = serialize_alibaba_token_plan_credential(
			"sk-sp-test",
			Some("sid=value"),
			Some(ALIBABA_TOKEN_PLAN_CN_BASE_URL),
		);
		assert_eq!(
			serialized.expose_secret(),
			format!(
				r#"{{"token":"sk-sp-test","cookie":"sid=value","baseUrl":"{ALIBABA_TOKEN_PLAN_CN_BASE_URL}"}}"#
			)
		);
		let parsed =
			parse_alibaba_token_plan_credential(serialized.expose_secret()).expect("credential");
		assert_eq!(parsed.token.expose_secret(), "sk-sp-test");
		assert_eq!(parsed.cookie.as_ref().map(|secret| secret.expose_secret()), Some("sid=value"));
		assert_eq!(parsed.base_url.as_deref(), Some(ALIBABA_TOKEN_PLAN_CN_BASE_URL));
		let debug = format!("{parsed:?}");
		assert!(!debug.contains("sk-sp-test"));
		assert!(!debug.contains("sid=value"));
		assert!(debug.contains("[REDACTED]"));
		assert_eq!(
			serialize_alibaba_token_plan_credential("sk-sp-test", None, None).expose_secret(),
			"sk-sp-test"
		);
	}

	#[tokio::test]
	async fn shaper_removes_cookie_and_ignores_default_endpoint() {
		let raw = serialize_alibaba_token_plan_credential(
			"sk-sp-test",
			Some("sid=value"),
			Some(ALIBABA_TOKEN_PLAN_BASE_URL),
		);
		let shaper = AlibabaTokenPlanShaper::new();
		let future = shaper.shape(&raw, ALIBABA_TOKEN_PLAN_BASE_URL, None);
		assert!(matches!(&future, Either::Left(_)));
		let shaped = future.await.expect("envelope rewrite");
		assert_eq!(
			shaped
				.secret
				.as_ref()
				.expect("replacement token")
				.expose_secret(),
			"sk-sp-test",
		);
		assert_eq!(shaped.endpoint_override, None);
		let bare = SecretString::from("sk-sp-test".to_owned());
		let future = shaper.shape(&bare, ALIBABA_TOKEN_PLAN_BASE_URL, None);
		assert!(matches!(&future, Either::Left(_)));
		assert!(future.await.is_none());
	}

	#[test]
	fn cookie_validation_accepts_headers_and_rejects_single_values() {
		assert_eq!(strip_cookie_prefix("Cookie: sid=value; other=two"), "sid=value; other=two");
		assert!(valid_cookie("sid=value"));
		assert!(!valid_cookie("not-a-pair"));
	}

	struct FixtureHttp {
		requests: Mutex<Vec<(String, String)>>,
	}

	impl OAuthHttpClient for FixtureHttp {
		fn execute(
			&self,
			request: OAuthHttpRequest,
		) -> BoxFuture<'_, Result<OAuthHttpResponse, OAuthTransportError>> {
			let (method, url, headers, _) = request.into_parts();
			assert_eq!(method, Method::GET);
			let authorization = headers
				.get(AUTHORIZATION)
				.and_then(|value| value.to_str().ok())
				.unwrap_or_default()
				.to_owned();
			self.requests.lock().push((url.to_string(), authorization));
			async {
				Ok(OAuthHttpResponse {
					status:  200,
					headers: HeaderMap::new(),
					body:    SecretString::from(String::new()),
				})
			}
			.boxed()
		}
	}

	async fn next_event(session: &AuthSession) -> AuthEvent {
		time::timeout(Duration::from_secs(1), session.events.recv_async())
			.await
			.expect("login event timeout")
			.expect("login event channel")
			.expect("successful login event")
	}

	async fn respond(session: &AuthSession, input: AuthInput) {
		session
			.responses
			.send_async(AuthResponse { session: session.id.clone(), input })
			.await
			.expect("login response");
	}

	fn test_store(label: &str) -> (Arc<CredentialStore>, PathBuf) {
		let suffix = SystemTime::now()
			.duration_since(SystemTime::UNIX_EPOCH)
			.expect("current timestamp")
			.as_nanos();
		let path = env::temp_dir()
			.join(format!("omp-alibaba-token-plan-{label}-{}-{suffix}.sqlite", std::process::id()));
		let store = CredentialStore::open(
			&path,
			Arc::new(HeadlessKeySource::new(KeyId::new(format!("alibaba-{label}")), [7; 32])),
		)
		.expect("test credential store");
		(Arc::new(store), path)
	}

	async fn drive_successful_login(
		label: &str,
		region: &str,
		custom_url: Option<&str>,
		cookie: &str,
	) -> (String, Vec<(String, String)>, String, String, PathBuf) {
		let (store, path) = test_store(label);
		let http = Arc::new(FixtureHttp { requests: Mutex::new(Vec::new()) });
		let (session, driver, _) =
			default_login_channels(LoginSessionId::from(format!("test-{label}")));
		let task_store = Arc::clone(&store);
		let task_http: Arc<dyn OAuthHttpClient> = http.clone();
		let task = tokio::spawn(async move {
			run_login_inner(
				&driver,
				ProviderId::from(PROVIDER),
				BTreeSet::new(),
				task_store,
				AccountPool::new(),
				task_http,
			)
			.await
		});
		let AuthEvent::Prompt(prompt) = next_event(&session).await else {
			panic!("region prompt");
		};
		assert_eq!(prompt.message, REGION_PROMPT);
		assert_eq!(prompt.input, AuthPromptKind::PlainText);
		respond(&session, AuthInput::PlainText(Str::new(region))).await;
		if let Some(custom_url) = custom_url {
			let AuthEvent::Prompt(prompt) = next_event(&session).await else {
				panic!("custom URL prompt");
			};
			assert_eq!(prompt.message, CUSTOM_URL_PROMPT);
			assert_eq!(prompt.input, AuthPromptKind::PlainText);
			respond(&session, AuthInput::PlainText(Str::new(custom_url))).await;
		}
		let AuthEvent::OpenUrl { url: open_url, launch: None } = next_event(&session).await else {
			panic!("authorization URL");
		};
		let AuthEvent::Prompt(prompt) = next_event(&session).await else {
			panic!("API key prompt");
		};
		assert_eq!(prompt.message, API_KEY_PROMPT);
		respond(&session, AuthInput::ApiKey(SecretString::from("sk-sp-test".to_owned()))).await;
		let AuthEvent::Prompt(cookie_prompt) = next_event(&session).await else {
			panic!("cookie prompt");
		};
		assert_eq!(cookie_prompt.input, AuthPromptKind::OptionalSecret);
		respond(&session, AuthInput::OptionalSecret(SecretString::from(cookie.to_owned()))).await;
		assert!(matches!(next_event(&session).await, AuthEvent::Complete(_)));
		task.await.expect("login task").expect("successful login");
		let source = StoredCredentialSource::new(Arc::clone(&store));
		let lease = CredentialSource::lease(&source, CredentialNeed {
			spec:        AuthSpecId::from("test"),
			account:     Some(AccountId::from(format!("{PROVIDER}:{PROVIDER}"))),
			principal:   None,
			valid_after: SystemTime::UNIX_EPOCH,
		})
		.await
		.expect("stored credential lease");
		assert_eq!(lease.kind(), super::super::CredentialKind::Bearer);
		let stored = lease
			.scalar_secret()
			.expect("scalar credential")
			.expose_secret()
			.to_owned();
		let requests = http.requests.lock().clone();
		(open_url.to_string(), requests, cookie_prompt.message.to_string(), stored, path)
	}

	#[tokio::test]
	async fn international_login_validates_and_stores_bare_token() {
		let (open_url, requests, cookie_prompt, stored, path) =
			drive_successful_login("international", "1", None, "").await;
		assert_eq!(open_url, INTERNATIONAL_AUTH_URL);
		assert_eq!(requests, vec![(
			format!("{ALIBABA_TOKEN_PLAN_BASE_URL}/models"),
			"Bearer sk-sp-test".to_owned()
		)]);
		assert!(cookie_prompt.contains("cs-data.qwencloud.com/data/api.json"));
		assert_eq!(stored, "sk-sp-test");
		let _ = fs::remove_file(path);
	}

	#[tokio::test]
	async fn china_login_uses_china_validation_and_envelope() {
		let (_, requests, cookie_prompt, stored, path) =
			drive_successful_login("china", "2", None, "").await;
		assert_eq!(
			requests[0],
			(format!("{ALIBABA_TOKEN_PLAN_CN_BASE_URL}/models"), "Bearer sk-sp-test".to_owned())
		);
		assert!(cookie_prompt.contains("bailian-cs.console.aliyun.com/data/api.json"));
		assert_eq!(
			stored,
			format!(r#"{{"token":"sk-sp-test","baseUrl":"{ALIBABA_TOKEN_PLAN_CN_BASE_URL}"}}"#)
		);
		let _ = fs::remove_file(path);
	}

	#[tokio::test]
	async fn custom_region_strips_trailing_slashes() {
		let (_, requests, _, stored, path) =
			drive_successful_login("custom", "3", Some("https://custom.example/v1///"), "").await;
		assert_eq!(requests[0].0, "https://custom.example/v1/models");
		assert_eq!(stored, r#"{"token":"sk-sp-test","baseUrl":"https://custom.example/v1"}"#);
		let _ = fs::remove_file(path);
	}

	#[tokio::test]
	async fn malformed_cookie_reports_exact_host_message() {
		let (store, path) = test_store("bad-cookie");
		let http: Arc<dyn OAuthHttpClient> =
			Arc::new(FixtureHttp { requests: Mutex::new(Vec::new()) });
		let (session, driver, _) = default_login_channels(LoginSessionId::from("test-bad-cookie"));
		let task = tokio::spawn(async move {
			run_login_inner(
				&driver,
				ProviderId::from(PROVIDER),
				BTreeSet::new(),
				store,
				AccountPool::new(),
				http,
			)
			.await
		});
		assert!(matches!(next_event(&session).await, AuthEvent::Prompt(_)));
		respond(&session, AuthInput::PlainText(sf!("2"))).await;
		assert!(matches!(next_event(&session).await, AuthEvent::OpenUrl { launch: None, .. }));
		assert!(matches!(next_event(&session).await, AuthEvent::Prompt(_)));
		respond(&session, AuthInput::ApiKey(SecretString::from("sk-sp-test".to_owned()))).await;
		assert!(matches!(next_event(&session).await, AuthEvent::Prompt(_)));
		respond(&session, AuthInput::OptionalSecret(SecretString::from("not-a-pair".to_owned())))
			.await;
		let error = task.await.expect("login task").expect_err("invalid cookie");
		assert_eq!(
			error.to_string(),
			"Invalid QwenCloud Cookie header. Copy the complete Cookie request header from the \
			 bailian-cs.console.aliyun.com usage request, not a single cookie value."
		);
		let _ = fs::remove_file(path);
	}
}
