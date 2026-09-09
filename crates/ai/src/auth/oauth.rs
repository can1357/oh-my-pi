//! Generic OAuth PKCE, device, paste, and refresh protocol engines.

mod callback;
mod custom;

use std::{
	fmt,
	future::Future,
	str,
	sync::Arc,
	time::{Duration, SystemTime},
};

use futures::{
	FutureExt,
	future::{BoxFuture, Either, Ready, ready, select},
};
use http::{
	HeaderMap, HeaderValue, Method,
	header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE},
};
use omp_catalog::{
	ProviderId,
	provider::{OAuthExchangeKind, PrincipalResolution},
};
use omp_core::{ExposeSecret, SecretBox, SecretString, Str, base64_url, sf};
use ring::rand::{SecureRandom, SystemRandom};
use serde::Deserialize;
use tokio::time;
use url::Url;
use zeroize::Zeroizing;

use super::{
	lease::{AuthRejection, AuthRejectionKind, CredentialLease, LeaseMeta},
	login::{LoginChannelError, LoginDriver},
	spec::{
		OAuthClientSpec, OAuthCustomSpec, OAuthDeviceSpec, OAuthParameter, OAuthPasteSpec,
		OAuthPkceSpec, OAuthRefreshSpec, PkceCompletion,
	},
	store::{CredentialOrigin, CredentialStore, OAuthCredentialWrite, StoreError},
};
use crate::{
	account::{
		CredentialFreshness, RefreshCoordinator, RefreshError, RefreshOperationError, RefreshOutcome,
		RefreshRequest, RefreshedCredential,
	},
	answer::{AuthEvent, AuthPrompt, AuthPromptKind},
	call::AuthInput,
	codec::{ProviderRefreshHookRequest, ProviderRefreshReason, ProviderResponseHooks},
	id::{AccountId, PrincipalId, ProjectId},
};

const FORM_CONTENT_TYPE: &str = "application/x-www-form-urlencoded";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
const CODEX_AUTH_CLAIM: &str = "https://api.openai.com/auth";
const CODEX_DATA_RESIDENCY_CLAIM: &str = "chatgpt_data_residency";
const CODEX_COMPUTE_RESIDENCY_CLAIM: &str = "chatgpt_compute_residency";

pub use omp_oauth::{
	OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse, OAuthTransportError, SystemOAuthHttpClient,
};

/// Production wall clock and bounded asynchronous sleeper for OAuth polling.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemOAuthClock;

impl OAuthClock for SystemOAuthClock {
	fn now(&self) -> SystemTime {
		SystemTime::now()
	}

	fn sleep(&self, duration: Duration) -> BoxFuture<'_, ()> {
		async move { time::sleep(duration).await }.boxed()
	}
}

/// Injectable clock and bounded sleeping used by device polling.
pub trait OAuthClock: Send + Sync {
	/// Current wall clock used for expiry calculations.
	fn now(&self) -> SystemTime;
	/// Sleeps for one server-bounded polling interval.
	fn sleep(&self, duration: Duration) -> BoxFuture<'_, ()>;
}

/// Injectable cryptographic entropy used by PKCE and state generation.
pub trait OAuthEntropy: Send + Sync {
	/// Fills the destination with cryptographically secure bytes.
	fn fill(&self, destination: &mut [u8]) -> Result<(), OAuthError>;
}

/// Operating-system cryptographic entropy source.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemEntropySource;

impl OAuthEntropy for SystemEntropySource {
	fn fill(&self, destination: &mut [u8]) -> Result<(), OAuthError> {
		SystemRandom::new()
			.fill(destination)
			.map_err(|_| OAuthError::Entropy)
	}
}

/// One typed custom OAuth exchange implementation.
pub trait OAuthCustomHandler: Send + Sync {
	/// Exact catalog engine discriminator handled by this implementation.
	fn exchange_kind(&self) -> OAuthExchangeKind;

	/// Runs the typed exchange over the bounded login channel.
	fn exchange<'a>(
		&'a self,
		spec: &'a OAuthCustomSpec,
		driver: &'a LoginDriver,
	) -> BoxFuture<'a, Result<OAuthTokenSet, OAuthError>>;

	/// Refreshes a token for protocols whose renewal wire shape is custom.
	///
	/// Protocols without renewal answer `RefreshUnsupported` without
	/// allocating; a real refresh boxes one cold network round trip.
	fn refresh<'a>(
		&'a self,
		_spec: &'a OAuthCustomSpec,
		_refresh_token: SecretString,
	) -> OAuthRefreshFuture<'a> {
		Either::Left(ready(Err(OAuthError::RefreshUnsupported)))
	}
}

/// Future returned by [`OAuthCustomHandler::refresh`].
pub type OAuthRefreshFuture<'a> = Either<
	Ready<Result<OAuthTokenSet, OAuthError>>,
	BoxFuture<'a, Result<OAuthTokenSet, OAuthError>>,
>;

/// Registry dispatching custom OAuth strictly by catalog exchange enum.
#[derive(Default)]
pub struct OAuthCustomDispatcher {
	handlers: Vec<Arc<dyn OAuthCustomHandler>>,
}

impl OAuthCustomDispatcher {
	/// Constructs an empty dispatcher.
	pub const fn new() -> Self {
		Self { handlers: Vec::new() }
	}

	/// Constructs the complete built-in custom exchange registry.
	pub fn builtin(
		http: Arc<dyn OAuthHttpClient>,
		clock: Arc<dyn OAuthClock>,
	) -> Result<Self, OAuthCustomDispatchError> {
		let mut dispatcher = Self::new();
		custom::register_all(&mut dispatcher, http, clock)?;
		Ok(dispatcher)
	}

	/// Registers one handler, rejecting duplicate typed discriminators.
	pub fn register(
		&mut self,
		handler: Arc<dyn OAuthCustomHandler>,
	) -> Result<(), OAuthCustomDispatchError> {
		let kind = handler.exchange_kind();
		if self
			.handlers
			.iter()
			.any(|candidate| candidate.exchange_kind() == kind)
		{
			return Err(OAuthCustomDispatchError::Duplicate(kind));
		}
		self.handlers.push(handler);
		Ok(())
	}

	/// Dispatches exactly the catalog-selected exchange or fails planning
	/// safely.
	pub async fn exchange(
		&self,
		spec: &OAuthCustomSpec,
		driver: &LoginDriver,
	) -> Result<OAuthTokenSet, OAuthCustomDispatchError> {
		let handler = self
			.handlers
			.iter()
			.find(|handler| handler.exchange_kind() == spec.exchange)
			.ok_or(OAuthCustomDispatchError::Unavailable(spec.exchange))?;
		handler
			.exchange(spec, driver)
			.await
			.map_err(OAuthCustomDispatchError::Protocol)
	}

	pub(crate) async fn refresh(
		&self,
		spec: &OAuthCustomSpec,
		refresh_token: SecretString,
	) -> Result<OAuthTokenSet, OAuthError> {
		let handler = self
			.handlers
			.iter()
			.find(|handler| handler.exchange_kind() == spec.exchange)
			.ok_or(OAuthError::RefreshUnsupported)?;
		handler.refresh(spec, refresh_token).await
	}
}

impl fmt::Debug for OAuthCustomDispatcher {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("OAuthCustomDispatcher")
			.field(
				"exchange_kinds",
				&self
					.handlers
					.iter()
					.map(|handler| handler.exchange_kind())
					.collect::<Vec<_>>(),
			)
			.finish()
	}
}

/// Typed custom OAuth dispatch failure.
#[derive(Debug, thiserror::Error)]
pub enum OAuthCustomDispatchError {
	/// A handler for the exact catalog exchange was already registered.
	#[error("duplicate custom OAuth exchange handler for {0}")]
	Duplicate(OAuthExchangeKind),
	/// No handler constructs the exact advertised exchange.
	#[error("custom OAuth exchange handler is unavailable for {0}")]
	Unavailable(OAuthExchangeKind),
	/// The selected exchange failed with secret-free protocol evidence.
	#[error(transparent)]
	Protocol(#[from] OAuthError),
}

/// Data-driven OAuth protocol engine.
pub struct OAuthEngine<'a, C: ?Sized, K: ?Sized, R = SystemEntropySource> {
	http:    &'a C,
	clock:   &'a K,
	entropy: R,
}

impl<'a, C, K> OAuthEngine<'a, C, K, SystemEntropySource>
where
	C: ?Sized,
	K: ?Sized,
{
	/// Constructs an engine using operating-system cryptographic entropy.
	pub const fn new(http: &'a C, clock: &'a K) -> Self {
		Self { http, clock, entropy: SystemEntropySource }
	}
}

impl<'a, C, K, R> OAuthEngine<'a, C, K, R>
where
	C: OAuthHttpClient + ?Sized,
	K: OAuthClock + ?Sized,
	R: OAuthEntropy,
{
	/// Constructs an engine with deterministic injectable entropy.
	pub const fn with_entropy(http: &'a C, clock: &'a K, entropy: R) -> Self {
		Self { http, clock, entropy }
	}

	/// Starts a PKCE flow and emits browser/prompt events.
	pub async fn begin_pkce(
		&self,
		spec: &OAuthPkceSpec,
		driver: &LoginDriver,
	) -> Result<PkcePending, OAuthError> {
		let material = omp_oauth::generate_pkce(|bytes| self.entropy.fill(bytes))?;
		let (verifier, challenge, state) = material.into_parts();
		let mut url = parse_http_url(&spec.authorize_url)?;
		{
			let mut query = url.query_pairs_mut();
			query
				.append_pair("response_type", "code")
				.append_pair("client_id", &spec.client.client_id)
				.append_pair("redirect_uri", &spec.redirect_uri)
				.append_pair("code_challenge", challenge.as_str())
				.append_pair("code_challenge_method", "S256")
				.append_pair("state", &state);
			if !spec.client.scopes.is_empty() {
				let scope = spec
					.client
					.scopes
					.iter()
					.map(Str::as_str)
					.collect::<Vec<_>>()
					.join(" ");
				query.append_pair("scope", &scope);
			}
			if let Some(audience) = &spec.client.audience {
				query.append_pair("audience", audience);
			}
			for parameter in &spec.authorize_params {
				query.append_pair(&parameter.name, &parameter.value);
			}
		}
		let callback_server = match spec.completion {
			PkceCompletion::CallbackUrl | PkceCompletion::PasteCallbackUrl => {
				start_callback_server(&spec.redirect_uri, &state).await
			},
			PkceCompletion::PasteCode => None,
		};
		let authorization_url = Str::new(url.as_str());
		if let Some(server) = &callback_server {
			server.arm(authorization_url.clone());
		}
		let launch = callback_server
			.as_ref()
			.map(callback::CallbackServer::launch_url);
		driver
			.emit(AuthEvent::OpenUrl { url: authorization_url, launch })
			.await?;
		let (id, message, input) = match spec.completion {
			PkceCompletion::CallbackUrl if callback_server.is_some() => (
				"oauth-callback",
				"Complete authorization in the opened browser",
				AuthPromptKind::Confirmation,
			),
			PkceCompletion::CallbackUrl => (
				"oauth-callback-url",
				"Paste the complete authorization callback URL",
				AuthPromptKind::AuthorizationCode,
			),
			PkceCompletion::PasteCallbackUrl => (
				"oauth-callback-url",
				"Paste the complete authorization callback URL",
				AuthPromptKind::AuthorizationCode,
			),
			PkceCompletion::PasteCode => {
				("oauth-code", "Paste the authorization code", AuthPromptKind::AuthorizationCode)
			},
		};
		driver
			.emit(AuthEvent::Prompt(AuthPrompt {
				id: Str::new(id),
				message: Str::new(message),
				input,
			}))
			.await?;
		Ok(PkcePending {
			verifier,
			state,
			redirect_uri: spec.redirect_uri.clone(),
			completion: spec.completion,
			callback_server,
		})
	}

	/// Waits for either the loopback redirect or typed manual PKCE input.
	pub async fn receive_pkce_input(
		&self,
		pending: &mut PkcePending,
		driver: &LoginDriver,
	) -> Result<AuthInput, OAuthError> {
		receive_callback_input(driver, pending.callback_server.take()).await
	}

	/// Completes a PKCE exchange from typed login input.
	pub async fn complete_pkce(
		&self,
		spec: &OAuthPkceSpec,
		pending: PkcePending,
		input: AuthInput,
	) -> Result<OAuthTokenSet, OAuthError> {
		let code = match (pending.completion, input) {
			(PkceCompletion::PasteCode, AuthInput::AuthorizationCode(code)) => code,
			(
				PkceCompletion::CallbackUrl | PkceCompletion::PasteCallbackUrl,
				AuthInput::CallbackUrl(callback) | AuthInput::AuthorizationCode(callback),
			) => callback_code(&callback, &pending.state)?,
			(_, AuthInput::Cancel) => return Err(OAuthError::Cancelled),
			_ => return Err(OAuthError::UnexpectedInput),
		};
		let fields = vec![
			("grant_type", FormValue::Public("authorization_code")),
			("client_id", FormValue::Public(&spec.client.client_id)),
			("code", FormValue::Secret(code.expose_secret())),
			("redirect_uri", FormValue::Public(&pending.redirect_uri)),
			("code_verifier", FormValue::Secret(pending.verifier.expose_secret())),
		];
		self.exchange(&spec.client, fields, None).await
	}

	/// Starts device authorization and emits its typed device-code timeline.
	pub async fn begin_device(
		&self,
		spec: &OAuthDeviceSpec,
		driver: &LoginDriver,
	) -> Result<DevicePending, OAuthError> {
		let scope = (!spec.client.scopes.is_empty()).then(|| {
			spec
				.client
				.scopes
				.iter()
				.map(Str::as_str)
				.collect::<Vec<_>>()
				.join(" ")
		});
		let mut fields = Vec::with_capacity(usize::from(scope.is_some()) + 1);
		fields.push(("client_id", FormValue::Public(&spec.client.client_id)));
		if let Some(scope) = &scope {
			fields.push(("scope", FormValue::Public(scope)));
		}
		let response = self
			.http
			.execute(form_request(&spec.device_authorization_url, &fields, &spec.client.token_params)?)
			.await?;
		if !(200..300).contains(&response.status) {
			return Err(provider_error(response.status, &response.body, false));
		}
		let parsed: DeviceAuthorizationResponse = decode(&response.body)?;
		let device_code = parsed.device_code.ok_or(OAuthError::MalformedResponse)?;
		let user_code = parsed.user_code.ok_or(OAuthError::MalformedResponse)?;
		let verification_url = parsed
			.verification_uri
			.or(parsed.verification_url)
			.ok_or(OAuthError::MalformedResponse)?;
		parse_http_url(&verification_url)?;
		driver
			.emit(AuthEvent::ShowDeviceCode {
				code:             SecretString::from(user_code),
				verification_url: verification_url.into(),
			})
			.await?;
		if let Some(complete) = parsed.verification_uri_complete {
			parse_http_url(&complete)?;
			driver
				.emit(AuthEvent::OpenUrl { url: complete.into(), launch: None })
				.await?;
		}
		let interval =
			Duration::from_secs(parsed.interval.unwrap_or(spec.default_interval.as_secs()));
		let interval = interval.max(spec.default_interval).min(spec.max_interval);
		let expires_in = Duration::from_secs(parsed.expires_in.unwrap_or(600));
		let expires_at = self
			.clock
			.now()
			.checked_add(expires_in)
			.ok_or(OAuthError::InvalidExpiry)?;
		Ok(DevicePending {
			device_code: SecretString::from(device_code),
			interval,
			expires_at,
			polls: 0,
		})
	}

	/// Polls a device grant with catalog bounds, server slow-down, and
	/// cancellation.
	pub async fn poll_device(
		&self,
		spec: &OAuthDeviceSpec,
		mut pending: DevicePending,
		driver: &LoginDriver,
	) -> Result<OAuthTokenSet, OAuthError> {
		loop {
			driver.check_cancelled()?;
			match driver.try_receive()? {
				None | Some(AuthInput::DeviceConfirmed) => {},
				Some(_) => return Err(OAuthError::UnexpectedInput),
			}
			let now = self.clock.now();
			if now >= pending.expires_at {
				return Err(OAuthError::PollingExhausted { polls: pending.polls });
			}
			driver.emit(AuthEvent::Waiting).await?;
			let remaining = pending
				.expires_at
				.duration_since(now)
				.map_err(|_| OAuthError::PollingExhausted { polls: pending.polls })?;
			let sleep = self.clock.sleep(pending.interval.min(remaining)).fuse();
			let cancelled = driver.wait_cancelled().fuse();
			futures::pin_mut!(sleep, cancelled);
			if matches!(select(sleep, cancelled).await, Either::Right(_)) {
				return Err(OAuthError::Cancelled);
			}
			driver.check_cancelled()?;
			if self.clock.now() >= pending.expires_at {
				return Err(OAuthError::PollingExhausted { polls: pending.polls });
			}
			pending.polls = pending.polls.saturating_add(1);
			let fields = vec![
				("grant_type", FormValue::Public(DEVICE_GRANT)),
				("device_code", FormValue::Secret(pending.device_code.expose_secret())),
				("client_id", FormValue::Public(&spec.client.client_id)),
			];
			let response = self
				.http
				.execute(form_request(&spec.client.token_url, &fields, &spec.client.token_params)?)
				.await?;
			if (200..300).contains(&response.status) {
				return token_response(response, None);
			}
			match provider_code(&response.body) {
				OAuthProviderCode::AuthorizationPending => {},
				OAuthProviderCode::SlowDown => {
					pending.interval = pending
						.interval
						.saturating_add(Duration::from_secs(5))
						.min(spec.max_interval);
				},
				_ => return Err(provider_error(response.status, &response.body, false)),
			}
		}
	}

	/// Starts a browser-assisted paste flow.
	pub async fn begin_paste(
		&self,
		spec: &OAuthPasteSpec,
		driver: &LoginDriver,
	) -> Result<(), OAuthError> {
		parse_http_url(&spec.authorization_url)?;
		driver
			.emit(AuthEvent::OpenUrl { url: spec.authorization_url.clone(), launch: None })
			.await?;
		driver
			.emit(AuthEvent::Prompt(AuthPrompt {
				id:      sf!("oauth-paste-code"),
				message: spec.prompt.clone(),
				input:   AuthPromptKind::AuthorizationCode,
			}))
			.await?;
		Ok(())
	}

	/// Exchanges a pasted authorization code using standard OAuth form fields.
	pub async fn complete_paste(
		&self,
		spec: &OAuthPasteSpec,
		input: AuthInput,
	) -> Result<OAuthTokenSet, OAuthError> {
		let AuthInput::AuthorizationCode(code) = input else {
			return if matches!(input, AuthInput::Cancel) {
				Err(OAuthError::Cancelled)
			} else {
				Err(OAuthError::UnexpectedInput)
			};
		};
		let fields = vec![
			("grant_type", FormValue::Public("authorization_code")),
			("client_id", FormValue::Public(&spec.client.client_id)),
			("code", FormValue::Secret(code.expose_secret())),
		];
		self.exchange(&spec.client, fields, None).await
	}

	/// Refreshes an access token while preserving refresh-token continuity.
	pub async fn refresh(
		&self,
		client: &OAuthClientSpec,
		refresh_token: SecretString,
	) -> Result<OAuthTokenSet, OAuthError> {
		let (url, parameters) = match &client.refresh {
			OAuthRefreshSpec::Unsupported => return Err(OAuthError::RefreshUnsupported),
			OAuthRefreshSpec::TokenEndpoint => (&client.token_url, client.token_params.as_slice()),
			OAuthRefreshSpec::Endpoint { url, parameters } => (url, parameters.as_slice()),
		};
		let fields = vec![
			("grant_type", FormValue::Public("refresh_token")),
			("client_id", FormValue::Public(&client.client_id)),
			("refresh_token", FormValue::Secret(refresh_token.expose_secret())),
		];
		let response = self
			.http
			.execute(form_request(url, &fields, parameters)?)
			.await?;
		if !(200..300).contains(&response.status) {
			return Err(provider_error(response.status, &response.body, true));
		}
		token_response(response, Some(refresh_token))
	}

	async fn exchange(
		&self,
		client: &OAuthClientSpec,
		fields: Vec<(&str, FormValue<'_>)>,
		fallback_refresh: Option<SecretString>,
	) -> Result<OAuthTokenSet, OAuthError> {
		let response = self
			.http
			.execute(form_request(&client.token_url, &fields, &client.token_params)?)
			.await?;
		if !(200..300).contains(&response.status) {
			return Err(provider_error(response.status, &response.body, fallback_refresh.is_some()));
		}
		token_response(response, fallback_refresh)
	}
}

/// Pending state for one PKCE login; formatting is always redacted.
pub struct PkcePending {
	verifier:        SecretString,
	state:           Str,
	redirect_uri:    Str,
	completion:      PkceCompletion,
	callback_server: Option<callback::CallbackServer>,
}

impl<C, K, R> OAuthEngine<'_, C, K, R>
where
	C: OAuthHttpClient + ?Sized,
	K: OAuthClock + ?Sized,
	R: OAuthEntropy,
{
	/// Persists a successful interactive OAuth result as one opaque credential
	/// bundle.
	pub fn persist_login(
		&self,
		store: &CredentialStore,
		tokens: OAuthTokenSet,
		meta: &LeaseMeta,
		origin: CredentialOrigin,
		issued_at: SystemTime,
	) -> Result<CredentialFreshness, OAuthCredentialManagerError> {
		let expires_at = tokens
			.expires_in()
			.and_then(|duration| issued_at.checked_add(duration));
		let bundle = tokens.into_stored_bundle().encode()?;
		let now_ms = unix_millis(issued_at)?;
		let expires_at_ms = expires_at.map(unix_millis).transpose()?;
		let stored = store.put_oauth_bundle(OAuthCredentialWrite {
			account_id: &meta.account,
			principal_id: &meta.principal,
			bundle: &bundle,
			expires_at_ms,
			origin,
			now_ms,
			expected_generation: None,
		})?;
		Ok(CredentialFreshness {
			generation: stored.generation,
			issued_at: Some(issued_at),
			expires_at,
			observed_at: issued_at,
		})
	}

	/// Loads a persisted OAuth access token as an opaque request lease.
	pub fn lease_persisted(
		&self,
		store: &CredentialStore,
		account: &AccountId<str>,
		now: SystemTime,
	) -> Result<CredentialLease, OAuthCredentialManagerError> {
		let stored = store.load_oauth_bundle(account)?;
		let bundle = StoredOAuthBundle::decode(&stored.bundle)?;
		let expires_at = stored
			.metadata
			.expires_at_ms
			.map(system_time_from_millis)
			.transpose()?;
		if expires_at.is_some_and(|expires_at| expires_at <= now) {
			return Err(OAuthCredentialManagerError::Expired);
		}
		let meta = LeaseMeta {
			account: stored.metadata.account_id,
			principal: stored.metadata.principal_id,
			generation: stored.metadata.generation,
			expires_at,
		};
		Ok(CredentialLease::bearer(meta, bundle.access_token))
	}

	/// Refreshes and fenced-persists one rejected standard OAuth generation
	/// through the shared process/cross-process coordinator.
	pub async fn refresh_persisted(
		&self,
		coordinator: &RefreshCoordinator,
		store: Arc<CredentialStore>,
		client: OAuthClientSpec,
		request: RefreshRequest,
		origin: CredentialOrigin,
	) -> Result<RefreshOutcome, OAuthCredentialManagerError> {
		let engine = self;
		self
			.refresh_persisted_with(
				coordinator,
				store,
				request,
				origin,
				move |refresh_token| async move { engine.refresh(&client, refresh_token).await },
			)
			.await
	}

	/// Refreshes and fenced-persists one rejected custom OAuth generation.
	pub(crate) async fn refresh_custom_persisted(
		&self,
		coordinator: &RefreshCoordinator,
		store: Arc<CredentialStore>,
		custom: Arc<OAuthCustomDispatcher>,
		spec: OAuthCustomSpec,
		request: RefreshRequest,
		origin: CredentialOrigin,
	) -> Result<RefreshOutcome, OAuthCredentialManagerError> {
		self
			.refresh_persisted_with(
				coordinator,
				store,
				request,
				origin,
				move |refresh_token| async move { custom.refresh(&spec, refresh_token).await },
			)
			.await
	}

	/// Refreshes and fenced-persists one rejected generation through an
	/// extension `provider_refresh` callback.
	pub(crate) async fn refresh_extension_persisted(
		&self,
		coordinator: &RefreshCoordinator,
		store: Arc<CredentialStore>,
		hooks: ProviderResponseHooks,
		provider: ProviderId,
		identity: Option<Str>,
		request: RefreshRequest,
		reason: ProviderRefreshReason,
		origin: CredentialOrigin,
	) -> Result<RefreshOutcome, OAuthCredentialManagerError> {
		let account = request.account.clone();
		let principal = request.principal.clone();
		let rejected_generation = request.rejected.generation;
		let requested_at = request.requested_at;
		let expires_at_ms = request.rejected.expires_at.map(unix_millis).transpose()?;
		coordinator
			.refresh(store.clone(), request, move |refresh_lease| {
				let store = store.clone();
				async move {
					let stored = store
						.load_oauth_bundle(&account)
						.map_err(refresh_store_operation)?;
					if stored.metadata.generation != rejected_generation {
						return Err(RefreshOperationError {
							code:    sf!("generation-changed"),
							summary: sf!("credential generation changed before refresh"),
						});
					}
					if stored.metadata.principal_id != principal {
						return Err(RefreshOperationError {
							code:    sf!("principal-changed"),
							summary: sf!("credential principal changed before refresh"),
						});
					}
					let bundle =
						StoredOAuthBundle::decode(&stored.bundle).map_err(refresh_oauth_operation)?;
					let refresh_token = bundle.into_refresh().map_err(refresh_oauth_operation)?;
					let refreshed = hooks
						.provider_refresh(ProviderRefreshHookRequest {
							provider,
							identity,
							refresh_token: refresh_token.clone(),
							expires_at_ms,
							props: serde_json::Map::new(),
							reason,
						})
						.await
						.map_err(|_| RefreshOperationError {
							code:    sf!("provider-refresh-hook"),
							summary: sf!("extension credential refresh failed"),
						})?;
					if !matches!(refreshed.kind.as_str(), "oauth" | "bearer") {
						return Err(RefreshOperationError {
							code:    sf!("provider-refresh-kind"),
							summary: sf!("extension refresh returned an incompatible credential kind"),
						});
					}
					let refresh_token = refreshed.refresh_token.unwrap_or(refresh_token);
					let expires_at = refreshed
						.expires_at_ms
						.map(system_time_from_millis)
						.transpose()
						.map_err(refresh_manager_operation)?;
					let expires_in =
						expires_at.and_then(|expires_at| expires_at.duration_since(requested_at).ok());
					let bundle = StoredOAuthBundle {
						access_token: refreshed.secret,
						refresh_token: Some(refresh_token),
						token_type: sf!("Bearer"),
						expires_in,
					}
					.encode()
					.map_err(refresh_oauth_operation)?;
					let write = OAuthCredentialWrite {
						account_id: &account,
						principal_id: &principal,
						bundle: &bundle,
						expires_at_ms: refreshed.expires_at_ms,
						origin,
						now_ms: unix_millis(requested_at).map_err(refresh_manager_operation)?,
						expected_generation: Some(rejected_generation),
					};
					let metadata = store
						.put_oauth_bundle_under_refresh_lease(write, &refresh_lease, requested_at)
						.map_err(refresh_store_operation)?;
					Ok(RefreshedCredential {
						account:   metadata.account_id,
						principal: metadata.principal_id,
						freshness: CredentialFreshness {
							generation: metadata.generation,
							issued_at: Some(requested_at),
							expires_at,
							observed_at: requested_at,
						},
					})
				}
			})
			.await
			.map_err(|error| OAuthCredentialManagerError::Refresh(Box::new(error)))
	}

	async fn refresh_persisted_with<F, Fut>(
		&self,
		coordinator: &RefreshCoordinator,
		store: Arc<CredentialStore>,
		request: RefreshRequest,
		origin: CredentialOrigin,
		refresh: F,
	) -> Result<RefreshOutcome, OAuthCredentialManagerError>
	where
		F: FnOnce(SecretString) -> Fut + Send,
		Fut: Future<Output = Result<OAuthTokenSet, OAuthError>> + Send,
	{
		let account = request.account.clone();
		let principal = request.principal.clone();
		let rejected_generation = request.rejected.generation;
		let requested_at = request.requested_at;
		coordinator
			.refresh(store.clone(), request, move |refresh_lease| {
				let store = store.clone();
				async move {
					let stored = store
						.load_oauth_bundle(&account)
						.map_err(refresh_store_operation)?;
					if stored.metadata.generation != rejected_generation {
						return Err(RefreshOperationError {
							code:    sf!("generation-changed"),
							summary: sf!("credential generation changed before refresh"),
						});
					}
					if stored.metadata.principal_id != principal {
						return Err(RefreshOperationError {
							code:    sf!("principal-changed"),
							summary: sf!("credential principal changed before refresh"),
						});
					}
					let bundle =
						StoredOAuthBundle::decode(&stored.bundle).map_err(refresh_oauth_operation)?;
					let refresh_token = bundle.into_refresh().map_err(refresh_oauth_operation)?;
					let tokens = refresh(refresh_token)
						.await
						.map_err(refresh_oauth_operation)?;
					let expires_at = tokens
						.expires_in()
						.and_then(|duration| requested_at.checked_add(duration));
					let bundle = tokens
						.into_stored_bundle()
						.encode()
						.map_err(refresh_oauth_operation)?;
					let write = OAuthCredentialWrite {
						account_id: &account,
						principal_id: &principal,
						bundle: &bundle,
						expires_at_ms: expires_at
							.map(unix_millis)
							.transpose()
							.map_err(refresh_manager_operation)?,
						origin,
						now_ms: unix_millis(requested_at).map_err(refresh_manager_operation)?,
						expected_generation: Some(rejected_generation),
					};
					let metadata = store
						.put_oauth_bundle_under_refresh_lease(write, &refresh_lease, requested_at)
						.map_err(refresh_store_operation)?;
					Ok(RefreshedCredential {
						account:   metadata.account_id,
						principal: metadata.principal_id,
						freshness: CredentialFreshness {
							generation: metadata.generation,
							issued_at: Some(requested_at),
							expires_at,
							observed_at: requested_at,
						},
					})
				}
			})
			.await
			.map_err(|error| OAuthCredentialManagerError::Refresh(Box::new(error)))
	}
}

impl fmt::Debug for PkcePending {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("PkcePending")
			.field("verifier", &"[REDACTED]")
			.field("state", &"[REDACTED]")
			.field("redirect_uri", &self.redirect_uri)
			.field("completion", &self.completion)
			.finish()
	}
}

/// Pending state for bounded device-code polling; formatting is redacted.
pub struct DevicePending {
	device_code: SecretString,
	interval:    Duration,
	expires_at:  SystemTime,
	polls:       u16,
}

impl fmt::Debug for DevicePending {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("DevicePending")
			.field("device_code", &"[REDACTED]")
			.field("interval", &self.interval)
			.field("expires_at", &self.expires_at)
			.field("polls", &self.polls)
			.finish()
	}
}

/// Secret-bearing OAuth result with no plaintext accessor or serialization.
pub struct OAuthTokenSet {
	access_token:      SecretString,
	refresh_token:     Option<SecretString>,
	token_type:        Str,
	expires_in:        Option<Duration>,
	identity_response: SecretString,
	project:           Option<ProjectId>,
}

impl OAuthTokenSet {
	/// Returns whether the response contains a renewable grant.
	pub const fn is_refreshable(&self) -> bool {
		self.refresh_token.is_some()
	}

	/// Returns the non-secret token type evidence.
	pub fn token_type(&self) -> &str {
		&self.token_type
	}

	/// Returns the relative lifetime reported by the token endpoint.
	pub const fn expires_in(&self) -> Option<Duration> {
		self.expires_in
	}

	/// Borrows non-secret project routing discovered during login.
	pub(crate) fn project(&self) -> Option<&ProjectId<str>> {
		self.project.as_deref()
	}

	/// Attaches non-secret project routing discovered by a custom login flow.
	pub(crate) fn set_project(&mut self, project: ProjectId) {
		self.project = Some(project);
	}

	/// Returns the normalized workspace residency carried by a Codex access
	/// token.
	///
	/// The data-residency claim is authoritative. Compute residency is used
	/// only when data residency is absent or invalid.
	pub fn codex_residency(&self) -> Option<Str> {
		codex_residency(self.access_token.expose_secret())
	}

	/// Resolves the authenticated principal using only the catalog-selected
	/// rule.
	pub async fn resolve_principal<C: OAuthHttpClient>(
		&self,
		resolution: &PrincipalResolution,
		http: &C,
	) -> Result<PrincipalId, OAuthError> {
		let value = match resolution {
			PrincipalResolution::StaticLabel { label } => label.clone(),
			PrincipalResolution::TokenResponseField { pointer } => {
				json_string_at(self.identity_response.expose_secret(), pointer)?
			},
			PrincipalResolution::IdTokenClaim { claim } => {
				let id_token = json_string_at(self.identity_response.expose_secret(), "/id_token")?;
				jwt_claim(&id_token, slice::from_ref(claim))?
			},
			PrincipalResolution::AccessTokenClaims { claims } => {
				jwt_claim(self.access_token.expose_secret(), claims)?
			},
			PrincipalResolution::UserinfoEndpoint { url, field } => {
				let mut headers = HeaderMap::new();
				let mut authorization = Zeroizing::new(String::with_capacity(
					self.token_type.len() + self.access_token.expose_secret().len() + 1,
				));
				authorization.push_str(&self.token_type);
				authorization.push(' ');
				authorization.push_str(self.access_token.expose_secret());
				let mut header = HeaderValue::from_str(&authorization)
					.map_err(|_| OAuthError::PrincipalUnresolved)?;
				header.set_sensitive(true);
				headers.insert(AUTHORIZATION, header);
				let response = http
					.execute(OAuthHttpRequest::new(Method::GET, url, headers, None)?)
					.await?;
				if !(200..300).contains(&response.status) {
					return Err(OAuthError::PrincipalUnresolved);
				}
				json_object_string(response.body.expose_secret(), field)?
			},
		};
		if value.is_empty() {
			return Err(OAuthError::PrincipalUnresolved);
		}
		Ok(PrincipalId::from(value))
	}

	/// Converts a non-renewable access token into an ephemeral opaque lease.
	///
	/// Interactive logins normally persist through
	/// [`OAuthEngine::persist_login`].
	pub fn into_ephemeral_lease(
		self,
		mut meta: LeaseMeta,
		issued_at: SystemTime,
	) -> Result<CredentialLease, OAuthError> {
		if self.refresh_token.is_some() {
			return Err(OAuthError::RenewableCredentialRequiresPersistence);
		}
		if meta.expires_at.is_none() {
			meta.expires_at = self
				.expires_in
				.and_then(|duration| issued_at.checked_add(duration));
		}
		Ok(CredentialLease::bearer(meta, self.access_token))
	}

	/// Moves an OAuth result into the opaque persistence bundle.
	pub(crate) fn into_stored_bundle(self) -> StoredOAuthBundle {
		StoredOAuthBundle {
			access_token:  self.access_token,
			refresh_token: self.refresh_token,
			token_type:    self.token_type,
			expires_in:    self.expires_in,
		}
	}
}

/// Move-only OAuth material owned inside the auth boundary.
pub(crate) struct StoredOAuthBundle {
	access_token:  SecretString,
	refresh_token: Option<SecretString>,
	token_type:    Str,
	expires_in:    Option<Duration>,
}

impl StoredOAuthBundle {
	/// Encodes the bundle into an opaque zeroizing store payload.
	pub(crate) fn encode(&self) -> Result<SecretBox<Vec<u8>>, OAuthError> {
		let access = self.access_token.expose_secret().as_bytes();
		let refresh = self
			.refresh_token
			.as_ref()
			.map_or(&[][..], |token| token.expose_secret().as_bytes());
		let token_type = self.token_type.as_bytes();
		let mut encoded =
			Zeroizing::new(Vec::with_capacity(24 + access.len() + refresh.len() + token_type.len()));
		encoded.extend_from_slice(b"ORCB1");
		encode_field(&mut encoded, access)?;
		encode_field(&mut encoded, refresh)?;
		encode_field(&mut encoded, token_type)?;
		encoded.extend_from_slice(
			&self
				.expires_in
				.map_or(u64::MAX, |value| value.as_secs())
				.to_be_bytes(),
		);
		Ok(SecretBox::new(Box::new(mem::take(&mut *encoded))))
	}

	/// Decodes an authenticated store payload without exposing token text.
	pub(crate) fn decode(encoded: &SecretBox<Vec<u8>>) -> Result<Self, OAuthError> {
		let mut input = encoded.expose_secret().as_slice();
		if !input.starts_with(b"ORCB1") {
			return Err(OAuthError::MalformedRenewableCredential);
		}
		input = &input[5..];
		let access = Zeroizing::new(decode_field(&mut input)?);
		let refresh = Zeroizing::new(decode_field(&mut input)?);
		let token_type = Zeroizing::new(decode_field(&mut input)?);
		if input.len() != 8 {
			return Err(OAuthError::MalformedRenewableCredential);
		}
		let expires = u64::from_be_bytes(
			input
				.try_into()
				.map_err(|_| OAuthError::MalformedRenewableCredential)?,
		);
		let access = String::from_utf8(access.to_vec())
			.map_err(|_| OAuthError::MalformedRenewableCredential)?;
		let refresh = String::from_utf8(refresh.to_vec())
			.map_err(|_| OAuthError::MalformedRenewableCredential)?;
		let token_type = String::from_utf8(token_type.to_vec())
			.map_err(|_| OAuthError::MalformedRenewableCredential)?;
		if access.is_empty() || token_type.is_empty() {
			return Err(OAuthError::MalformedRenewableCredential);
		}
		Ok(Self {
			access_token:  SecretString::from(access),
			refresh_token: (!refresh.is_empty()).then(|| SecretString::from(refresh)),
			token_type:    token_type.into(),
			expires_in:    (expires != u64::MAX).then(|| Duration::from_secs(expires)),
		})
	}

	pub(crate) fn into_refresh(self) -> Result<SecretString, OAuthError> {
		self.refresh_token.ok_or(OAuthError::RefreshUnsupported)
	}
}
pub(crate) fn encode_imported_bundle(
	access_token: SecretString,
	refresh_token: SecretString,
	expires_in: Duration,
) -> Result<SecretBox<Vec<u8>>, OAuthError> {
	if access_token.expose_secret().is_empty() || refresh_token.expose_secret().is_empty() {
		return Err(OAuthError::MalformedRenewableCredential);
	}
	StoredOAuthBundle {
		access_token,
		refresh_token: Some(refresh_token),
		token_type: sf!("Bearer"),
		expires_in: Some(expires_in),
	}
	.encode()
}

impl fmt::Debug for StoredOAuthBundle {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str("StoredOAuthBundle([REDACTED])")
	}
}

fn encode_field(output: &mut Vec<u8>, value: &[u8]) -> Result<(), OAuthError> {
	let length = u32::try_from(value.len()).map_err(|_| OAuthError::MalformedRenewableCredential)?;
	output.extend_from_slice(&length.to_be_bytes());
	output.extend_from_slice(value);
	Ok(())
}

fn decode_field(input: &mut &[u8]) -> Result<Vec<u8>, OAuthError> {
	let length_bytes: [u8; 4] = input
		.get(..4)
		.ok_or(OAuthError::MalformedRenewableCredential)?
		.try_into()
		.map_err(|_| OAuthError::MalformedRenewableCredential)?;
	let length = usize::try_from(u32::from_be_bytes(length_bytes))
		.map_err(|_| OAuthError::MalformedRenewableCredential)?;
	let value = input
		.get(4..4 + length)
		.ok_or(OAuthError::MalformedRenewableCredential)?;
	*input = &input[4 + length..];
	Ok(value.to_vec())
}

impl fmt::Debug for OAuthTokenSet {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str("OAuthTokenSet([REDACTED])")
	}
}

#[allow(
	missing_docs,
	reason = "strum generates the public string-conversion method in this private module"
)]
mod oauth_provider_code {
	use strum::IntoStaticStr;

	/// Closed, sanitized OAuth provider error vocabulary.
	#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
	#[strum(serialize_all = "snake_case", const_into_str)]
	pub enum OAuthProviderCode {
		/// Device authorization remains pending.
		AuthorizationPending,
		/// Device polling must slow down.
		SlowDown,
		/// Authorization was declined by the resource owner.
		AccessDenied,
		/// Device or authorization grant expired.
		ExpiredToken,
		/// Refresh or authorization grant is invalid/revoked.
		InvalidGrant,
		/// Public client declaration is invalid.
		InvalidClient,
		/// Request shape is invalid.
		InvalidRequest,
		/// Requested scope is invalid.
		InvalidScope,
		/// Provider failed transiently.
		ServerError,
		/// Provider is temporarily unavailable.
		TemporarilyUnavailable,
		/// Provider returned an unknown code; raw text is deliberately discarded.
		Unknown,
	}
}

use std::{mem, slice};

#[doc(inline)]
pub use oauth_provider_code::OAuthProviderCode;
use url::form_urlencoded;

use super::{lease::CredentialError, store::StoredOAuthCredential};

impl OAuthProviderCode {
	/// Stable machine-readable string representation of this error code.
	pub const fn as_str(&self) -> &'static str {
		(*self).into_str()
	}
}

/// OAuth engine failure with typed, secret-free evidence.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum OAuthError {
	/// Catalog endpoint is not a valid absolute HTTP(S) URL.
	#[error("OAuth endpoint URL is invalid")]
	InvalidUrl,
	/// Authorization callback state does not match the pending flow.
	#[error("OAuth authorization state did not match")]
	StateMismatch,
	/// Authorization callback omits a code or has an invalid shape.
	#[error("OAuth authorization callback is malformed")]
	MalformedCallback,
	/// The authorization server returned a trusted denial callback.
	#[error("OAuth authorization was denied")]
	AuthorizationDenied,
	/// A bound callback listener stopped before delivering a result.
	#[error("OAuth callback listener became unavailable")]
	CallbackUnavailable,
	/// Token or device response has an invalid typed shape.
	#[error("OAuth response is malformed")]
	MalformedResponse,
	/// Cloud Code Assist rejected a project discovery or provisioning request.
	#[error("OAuth project provisioning was rejected with HTTP status {status}")]
	ProvisioningRejected {
		/// Exact HTTP status returned by the control plane.
		status: u16,
	},
	/// The authenticated account is explicitly ineligible for the free tier.
	#[error("OAuth account is ineligible for Cloud Code Assist free-tier provisioning")]
	ProvisioningIneligible,
	/// A Cloud Code Assist onboarding operation completed with an error.
	#[error("OAuth project provisioning operation failed with code {code:?}")]
	ProvisioningFailed {
		/// Structured operation error code, when supplied.
		code: Option<i64>,
	},
	/// The single onboarding deadline elapsed.
	#[error("OAuth project provisioning timed out")]
	ProvisioningTimeout,
	/// The account needs an explicit Google Cloud project that neither the
	/// control plane nor the environment supplied.
	#[error("OAuth account requires a Google Cloud project; set OMP_GOOGLE_CLOUD_PROJECT")]
	ProjectRequired,
	/// HTTP transport failed without retaining source text.
	#[error(transparent)]
	Transport(#[from] OAuthTransportError),

	/// Provider returned sanitized protocol evidence.
	#[error("OAuth provider rejected the request")]
	Provider {
		/// HTTP status supplied by the provider.
		status:    u16,
		/// Sanitized provider protocol code.
		code:      OAuthProviderCode,
		/// Whether the provider identified the rejection as retryable.
		retryable: bool,
	},
	/// Refresh grant rejection must reach credential-source rejection policy.
	#[error("OAuth refresh grant was rejected")]
	RefreshRejected(AuthRejection),
	/// Catalog explicitly declares that this flow cannot refresh.
	#[error("OAuth flow does not support refresh")]
	RefreshUnsupported,
	/// Caller supplied input for a different login step.
	#[error("OAuth login received unexpected input")]
	UnexpectedInput,
	/// Login was cancelled.
	#[error("OAuth login was cancelled")]
	Cancelled,
	/// Device polling reached the provider-issued expiry bound.
	#[error("OAuth device code expired")]
	PollingExhausted {
		/// Number of token endpoint polls performed.
		polls: u16,
	},
	/// Cryptographic random generation failed.
	#[error("OAuth cryptographic entropy is unavailable")]
	Entropy,
	/// A token expiry cannot be represented.
	#[error("OAuth token expiry is invalid")]
	InvalidExpiry,
	/// Renewable token was routed to the ephemeral lease path.
	#[error("renewable OAuth credential requires encrypted persistence")]
	RenewableCredentialRequiresPersistence,
	/// Stored OAuth bundle had an invalid internal shape.
	#[error("stored OAuth credential is malformed")]
	MalformedRenewableCredential,
	/// Catalog-selected identity evidence was absent or invalid.
	#[error("OAuth principal identity could not be resolved")]
	PrincipalUnresolved,
	/// Login event/input channel failed.
	#[error(transparent)]
	Login(LoginChannelError),
}

impl From<omp_oauth::OAuthRequestError> for OAuthError {
	fn from(_: omp_oauth::OAuthRequestError) -> Self {
		Self::InvalidUrl
	}
}

impl From<LoginChannelError> for OAuthError {
	fn from(error: LoginChannelError) -> Self {
		match error {
			LoginChannelError::Cancelled => Self::Cancelled,
			error => Self::Login(error),
		}
	}
}
/// Converts a stored opaque OAuth bundle into a lease without exposing its
/// encoding or token material to the store-backed credential source.
pub(crate) fn lease_stored_bundle(
	stored: StoredOAuthCredential,
	valid_after: SystemTime,
) -> Result<CredentialLease, CredentialError> {
	let bundle =
		StoredOAuthBundle::decode(&stored.bundle).map_err(|_| CredentialError::SourceFailure)?;
	let expires_at = stored
		.metadata
		.expires_at_ms
		.map(system_time_from_millis)
		.transpose()
		.map_err(|_| CredentialError::SourceFailure)?;
	if expires_at.is_some_and(|expires_at| expires_at <= valid_after) {
		return Err(CredentialError::Expired);
	}
	let meta = LeaseMeta {
		account: stored.metadata.account_id,
		principal: stored.metadata.principal_id,
		generation: stored.metadata.generation,
		expires_at,
	};
	Ok(CredentialLease::bearer(meta, bundle.access_token))
}

/// OAuth persistence/refresh failure with secret-free evidence.
#[derive(Debug, thiserror::Error)]
pub enum OAuthCredentialManagerError {
	/// OAuth protocol or bundle processing failed.
	#[error(transparent)]
	OAuth(Box<OAuthError>),
	/// Encrypted credential store failed.
	#[error(transparent)]
	Store(Box<StoreError>),
	/// Shared refresh coordination failed.
	#[error(transparent)]
	Refresh(Box<RefreshError>),
	/// Persisted access token is expired and requires coordinated refresh.
	#[error("persisted OAuth access token is expired")]
	Expired,
	/// Wall-clock timestamp cannot be represented as Unix milliseconds.
	#[error("OAuth credential timestamp is invalid")]
	InvalidTime,
}

impl From<OAuthError> for OAuthCredentialManagerError {
	fn from(error: OAuthError) -> Self {
		Self::OAuth(Box::new(error))
	}
}

impl From<StoreError> for OAuthCredentialManagerError {
	fn from(error: StoreError) -> Self {
		Self::Store(Box::new(error))
	}
}

fn unix_millis(time: SystemTime) -> Result<u64, OAuthCredentialManagerError> {
	let millis = time
		.duration_since(SystemTime::UNIX_EPOCH)
		.map_err(|_| OAuthCredentialManagerError::InvalidTime)?
		.as_millis();
	u64::try_from(millis).map_err(|_| OAuthCredentialManagerError::InvalidTime)
}

fn system_time_from_millis(millis: u64) -> Result<SystemTime, OAuthCredentialManagerError> {
	SystemTime::UNIX_EPOCH
		.checked_add(Duration::from_millis(millis))
		.ok_or(OAuthCredentialManagerError::InvalidTime)
}

fn refresh_store_operation(_: StoreError) -> RefreshOperationError {
	RefreshOperationError {
		code:    sf!("credential-store"),
		summary: sf!("encrypted credential persistence failed"),
	}
}

fn refresh_oauth_operation(error: OAuthError) -> RefreshOperationError {
	let code = match error {
		OAuthError::RefreshRejected(_) => "refresh-rejected",
		OAuthError::Cancelled => "cancelled",
		OAuthError::Transport(_) => "transport",
		_ => "oauth-protocol",
	};
	RefreshOperationError {
		code:    Str::new(code),
		summary: sf!("OAuth credential refresh failed"),
	}
}

fn refresh_manager_operation(_: OAuthCredentialManagerError) -> RefreshOperationError {
	RefreshOperationError {
		code:    sf!("credential-time"),
		summary: sf!("OAuth credential timestamp is invalid"),
	}
}

#[derive(Deserialize)]
struct DeviceAuthorizationResponse {
	device_code:               Option<String>,
	user_code:                 Option<String>,
	verification_uri:          Option<String>,
	verification_url:          Option<String>,
	verification_uri_complete: Option<String>,
	expires_in:                Option<u64>,
	interval:                  Option<u64>,
}

#[derive(Deserialize)]
struct TokenResponse {
	access_token:  Option<String>,
	refresh_token: Option<String>,
	token_type:    Option<String>,
	expires_in:    Option<u64>,
	error:         Option<String>,
}

fn token_response(
	response: OAuthHttpResponse,
	fallback_refresh: Option<SecretString>,
) -> Result<OAuthTokenSet, OAuthError> {
	let parsed: TokenResponse = decode(&response.body)?;
	if parsed.error.is_some() {
		return Err(provider_error(response.status, &response.body, fallback_refresh.is_some()));
	}
	let access_token = parsed
		.access_token
		.filter(|value| !value.is_empty())
		.ok_or(OAuthError::MalformedResponse)?;
	Ok(OAuthTokenSet {
		access_token:      SecretString::from(access_token),
		refresh_token:     parsed
			.refresh_token
			.map(SecretString::from)
			.or(fallback_refresh),
		token_type:        parsed
			.token_type
			.unwrap_or_else(|| "Bearer".to_owned())
			.into(),
		expires_in:        parsed.expires_in.map(Duration::from_secs),
		identity_response: response.body,
		project:           None,
	})
}

fn json_string_at(document: &str, pointer: &str) -> Result<Str, OAuthError> {
	if !pointer.starts_with('/') {
		return Err(OAuthError::PrincipalUnresolved);
	}
	let value: serde_json::Value =
		serde_json::from_str(document).map_err(|_| OAuthError::PrincipalUnresolved)?;
	value
		.pointer(pointer)
		.and_then(serde_json::Value::as_str)
		.filter(|value| !value.is_empty())
		.map(Str::new)
		.ok_or(OAuthError::PrincipalUnresolved)
}

fn json_object_string(document: &str, field: &str) -> Result<Str, OAuthError> {
	if field.is_empty() {
		return Err(OAuthError::PrincipalUnresolved);
	}
	let value: serde_json::Value =
		serde_json::from_str(document).map_err(|_| OAuthError::PrincipalUnresolved)?;
	value
		.as_object()
		.and_then(|object| object.get(field))
		.and_then(serde_json::Value::as_str)
		.filter(|value| !value.is_empty())
		.map(Str::new)
		.ok_or(OAuthError::PrincipalUnresolved)
}

fn jwt_claim(token: &str, claims: &[Str]) -> Result<Str, OAuthError> {
	let payload = token
		.split('.')
		.nth(1)
		.ok_or(OAuthError::PrincipalUnresolved)?;
	let decoded = Zeroizing::new(
		base64_url::decode_raw(payload.as_bytes())
			.into_vec()
			.map_err(|_| OAuthError::PrincipalUnresolved)?,
	);
	let document = str::from_utf8(&decoded).map_err(|_| OAuthError::PrincipalUnresolved)?;
	for claim in claims {
		let value = if claim.starts_with('/') {
			json_string_at(document, claim)
		} else {
			json_object_string(document, claim)
		};
		if let Ok(value) = value {
			return Ok(value);
		}
	}
	Err(OAuthError::PrincipalUnresolved)
}
fn codex_residency(token: &str) -> Option<Str> {
	let mut segments = token.split('.');
	segments.next()?;
	let payload = segments.next()?;
	segments.next()?;
	if segments.next().is_some() {
		return None;
	}
	let decoded = Zeroizing::new(base64_url::decode_raw(payload.as_bytes()).into_vec().ok()?);
	let document: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
	let auth = document.get(CODEX_AUTH_CLAIM)?.as_object()?;
	[CODEX_DATA_RESIDENCY_CLAIM, CODEX_COMPUTE_RESIDENCY_CLAIM]
		.into_iter()
		.filter_map(|claim| auth.get(claim)?.as_str())
		.map(str::trim)
		.find(|residency| !residency.is_empty())
		.map(Str::new)
}

fn provider_error(status: u16, body: &SecretString, refresh: bool) -> OAuthError {
	let code = provider_code(body);
	let retryable = matches!(status, 408 | 425 | 429 | 500..=599)
		|| matches!(code, OAuthProviderCode::ServerError | OAuthProviderCode::TemporarilyUnavailable);
	if refresh
		&& matches!(
			code,
			OAuthProviderCode::InvalidGrant
				| OAuthProviderCode::InvalidClient
				| OAuthProviderCode::AccessDenied
		) {
		return OAuthError::RefreshRejected(AuthRejection {
			kind:        AuthRejectionKind::RefreshRejected,
			status:      Some(status),
			code:        Some(sf!(code.as_str())),
			refreshable: false,
		});
	}
	OAuthError::Provider { status, code, retryable }
}

fn provider_code(body: &SecretString) -> OAuthProviderCode {
	let Ok(parsed) = serde_json::from_str::<TokenResponse>(body.expose_secret()) else {
		return OAuthProviderCode::Unknown;
	};
	match parsed.error.as_deref() {
		Some("authorization_pending") => OAuthProviderCode::AuthorizationPending,
		Some("slow_down") => OAuthProviderCode::SlowDown,
		Some("access_denied" | "authorization_declined") => OAuthProviderCode::AccessDenied,
		Some("expired_token") => OAuthProviderCode::ExpiredToken,
		Some("invalid_grant" | "bad_verification_code") => OAuthProviderCode::InvalidGrant,
		Some("invalid_client") => OAuthProviderCode::InvalidClient,
		Some("invalid_request") => OAuthProviderCode::InvalidRequest,
		Some("invalid_scope") => OAuthProviderCode::InvalidScope,
		Some("server_error") => OAuthProviderCode::ServerError,
		Some("temporarily_unavailable") => OAuthProviderCode::TemporarilyUnavailable,
		_ => OAuthProviderCode::Unknown,
	}
}

async fn start_callback_server(
	redirect_uri: &str,
	expected_state: &str,
) -> Option<callback::CallbackServer> {
	callback::CallbackServer::bind(redirect_uri, expected_state)
		.await
		.ok()
		.flatten()
}

async fn receive_callback_input(
	driver: &LoginDriver,
	server: Option<callback::CallbackServer>,
) -> Result<AuthInput, OAuthError> {
	callback::receive_callback(driver, server).await
}

fn callback_code(
	callback: &SecretString,
	expected_state: &str,
) -> Result<SecretString, OAuthError> {
	let callback = callback.expose_secret();
	if !(callback.starts_with("http://") || callback.starts_with("https://")) {
		return Err(OAuthError::MalformedCallback);
	}
	let query = callback
		.split_once('?')
		.map(|(_, query)| query.split('#').next().unwrap_or_default())
		.ok_or(OAuthError::MalformedCallback)?;
	let mut state_seen = false;
	let mut code = None;
	for field in query.split('&').filter(|field| !field.is_empty()) {
		let (name, value) = field.split_once('=').unwrap_or((field, ""));
		let name = decode_form_component(name)?;
		if name.as_str() == "state" {
			if state_seen {
				return Err(OAuthError::MalformedCallback);
			}
			state_seen = true;
			let state = decode_form_component(value)?;
			if state.as_str() != expected_state {
				return Err(OAuthError::StateMismatch);
			}
		} else if name.as_str() == "code" {
			if code.is_some() {
				return Err(OAuthError::MalformedCallback);
			}
			let mut decoded = decode_form_component(value)?;
			if decoded.is_empty() {
				return Err(OAuthError::MalformedCallback);
			}
			code = Some(SecretString::from(mem::take(&mut *decoded)));
		}
	}
	if !state_seen && !expected_state.is_empty() {
		return Err(OAuthError::MalformedCallback);
	}
	code.ok_or(OAuthError::MalformedCallback)
}

fn decode_form_component(value: &str) -> Result<Zeroizing<String>, OAuthError> {
	let bytes = value.as_bytes();
	let mut decoded = Zeroizing::new(Vec::with_capacity(bytes.len()));
	let mut index = 0;
	while index < bytes.len() {
		match bytes[index] {
			b'+' => {
				decoded.push(b' ');
				index += 1;
			},
			b'%' if index + 2 < bytes.len() => {
				let high = hex_nibble(bytes[index + 1]).ok_or(OAuthError::MalformedCallback)?;
				let low = hex_nibble(bytes[index + 2]).ok_or(OAuthError::MalformedCallback)?;
				decoded.push((high << 4) | low);
				index += 3;
			},
			b'%' => return Err(OAuthError::MalformedCallback),
			byte => {
				decoded.push(byte);
				index += 1;
			},
		}
	}
	let decoded =
		String::from_utf8(mem::take(&mut *decoded)).map_err(|_| OAuthError::MalformedCallback)?;
	Ok(Zeroizing::new(decoded))
}

const fn hex_nibble(byte: u8) -> Option<u8> {
	match byte {
		b'0'..=b'9' => Some(byte - b'0'),
		b'a'..=b'f' => Some(byte - b'a' + 10),
		b'A'..=b'F' => Some(byte - b'A' + 10),
		_ => None,
	}
}

fn form_request(
	url: &str,
	fields: &[(&str, FormValue<'_>)],
	extra: &[OAuthParameter],
) -> Result<OAuthHttpRequest, OAuthError> {
	let url = parse_http_url(url)?;
	let mut serializer = form_urlencoded::Serializer::new(String::new());
	for (name, value) in fields {
		serializer.append_pair(name, value.expose());
	}
	for parameter in extra {
		serializer.append_pair(&parameter.name, &parameter.value);
	}
	let body = SecretString::from(serializer.finish());
	let mut headers = HeaderMap::new();
	headers.insert(CONTENT_TYPE, HeaderValue::from_static(FORM_CONTENT_TYPE));
	headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
	OAuthHttpRequest::new(Method::POST, url.as_str(), headers, Some(body)).map_err(Into::into)
}

enum FormValue<'a> {
	Public(&'a str),
	Secret(&'a str),
}

impl FormValue<'_> {
	const fn expose(&self) -> &str {
		match self {
			Self::Public(value) | Self::Secret(value) => value,
		}
	}
}

fn parse_http_url(value: &str) -> Result<Url, OAuthError> {
	let parsed = Url::parse(value).map_err(|_| OAuthError::InvalidUrl)?;
	if matches!(parsed.scheme(), "http" | "https") && parsed.has_host() {
		Ok(parsed)
	} else {
		Err(OAuthError::InvalidUrl)
	}
}

fn decode<T: for<'de> Deserialize<'de>>(body: &SecretString) -> Result<T, OAuthError> {
	serde_json::from_str(body.expose_secret()).map_err(|_| OAuthError::MalformedResponse)
}

#[cfg(test)]
mod tests {
	use std::{collections::VecDeque, net, net::TcpListener, sync::Arc};

	use futures::FutureExt;
	use parking_lot::Mutex;
	use tempfile::tempdir;
	use tokio::{
		io::{AsyncReadExt as _, AsyncWriteExt as _},
		net::TcpStream,
	};

	use super::*;
	use crate::{
		account::{CredentialFreshness, RefreshCoordinator, RefreshPolicy, RefreshRequest},
		answer::{AuthPrompt, AuthResponse, AuthSession as AnswerAuthSession},
		auth::{
			CredentialOrigin, CredentialSourceSpec, CredentialStore, HeadlessKeySource, KeyId,
			OAuthRefreshSpec, login::default_login_channels, spec::HeaderPlacement,
		},
		id::{LoginSessionId, PrincipalId},
	};

	#[test]
	fn provider_codes_keep_wire_spelling() {
		assert_eq!(OAuthProviderCode::AuthorizationPending.as_str(), "authorization_pending");
		assert_eq!(OAuthProviderCode::TemporarilyUnavailable.as_str(), "temporarily_unavailable");
	}
	#[test]
	fn codex_residency_claim_prefers_data_then_falls_back_to_compute() {
		let token = |claims: &str| {
			let payload =
				base64_url::encode_raw(format!(r#"{{"{CODEX_AUTH_CLAIM}":{claims}}}"#).as_bytes())
					.into_string();
			format!("header.{payload}.signature")
		};
		assert_eq!(
			codex_residency(&token(
				r#"{"chatgpt_data_residency":" eu ","chatgpt_compute_residency":"us"}"#,
			))
			.as_deref(),
			Some("eu"),
		);
		assert_eq!(
			codex_residency(&token(
				r#"{"chatgpt_data_residency":" ","chatgpt_compute_residency":" us "}"#,
			))
			.as_deref(),
			Some("us"),
		);
		assert_eq!(
			codex_residency(&token(
				r#"{"chatgpt_data_residency":42,"chatgpt_compute_residency":"eu"}"#,
			))
			.as_deref(),
			Some("eu"),
		);
		assert_eq!(codex_residency(&token(r#"{"chatgpt_data_residency":42}"#)), None,);
		assert_eq!(codex_residency(&token(r"{}")), None);
		assert_eq!(
			codex_residency(&format!("{}.extra", token(r#"{"chatgpt_data_residency":"us"}"#))),
			None,
		);
		assert_eq!(codex_residency("opaque-access-token"), None);
	}

	struct FixedEntropy;
	impl OAuthEntropy for FixedEntropy {
		fn fill(&self, destination: &mut [u8]) -> Result<(), OAuthError> {
			for (index, byte) in destination.iter_mut().enumerate() {
				*byte = index as u8;
			}
			Ok(())
		}
	}

	struct TestClock(SystemTime);
	impl OAuthClock for TestClock {
		fn now(&self) -> SystemTime {
			self.0
		}

		fn sleep(&self, _: Duration) -> BoxFuture<'_, ()> {
			async {}.boxed()
		}
	}
	struct AdvancingClock(Mutex<SystemTime>);
	impl OAuthClock for AdvancingClock {
		fn now(&self) -> SystemTime {
			*self.0.lock()
		}

		fn sleep(&self, duration: Duration) -> BoxFuture<'_, ()> {
			let mut now = self.0.lock();
			*now = now.checked_add(duration).expect("representable test time");
			async {}.boxed()
		}
	}

	struct TestHttp(Mutex<VecDeque<OAuthHttpResponse>>);
	impl OAuthHttpClient for TestHttp {
		fn execute(
			&self,
			_: OAuthHttpRequest,
		) -> BoxFuture<'_, Result<OAuthHttpResponse, OAuthTransportError>> {
			async move { Ok(self.0.lock().pop_front().expect("fixture response")) }.boxed()
		}
	}
	struct RecordingHttp {
		response: Mutex<Option<OAuthHttpResponse>>,
		body:     Mutex<Option<String>>,
	}

	impl OAuthHttpClient for RecordingHttp {
		fn execute(
			&self,
			request: OAuthHttpRequest,
		) -> BoxFuture<'_, Result<OAuthHttpResponse, OAuthTransportError>> {
			let (_, _, _, body) = request.into_parts();
			*self.body.lock() = body.map(|body| body.expose_secret().to_owned());
			let response = self.response.lock().take().expect("fixture response");
			async move { Ok(response) }.boxed()
		}
	}

	fn client() -> OAuthClientSpec {
		OAuthClientSpec {
			sources:      vec![CredentialSourceSpec::Interactive],
			client_id:    "client".into(),
			refresh:      OAuthRefreshSpec::TokenEndpoint,
			token_url:    "https://auth.example/token".into(),
			scopes:       vec!["openid".into(), "profile".into()],
			audience:     None,
			token_params: Vec::new(),
			placement:    HeaderPlacement::bearer().into(),
		}
	}

	fn available_redirect_uri() -> (u16, Str) {
		let listener = TcpListener::bind((net::Ipv4Addr::LOCALHOST, 0)).expect("reserve port");
		let port = listener.local_addr().expect("local address").port();
		drop(listener);
		(port, sf!("http://127.0.0.1:{port}/callback"))
	}

	async fn raw_callback(port: u16, target: &str) -> String {
		let mut stream = TcpStream::connect((net::Ipv4Addr::LOCALHOST, port))
			.await
			.expect("connect callback");
		let request =
			format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
		stream
			.write_all(request.as_bytes())
			.await
			.expect("write callback");
		let mut response = Vec::new();
		stream
			.read_to_end(&mut response)
			.await
			.expect("read callback response");
		String::from_utf8(response).expect("UTF-8 callback response")
	}

	fn token_http() -> TestHttp {
		TestHttp(Mutex::new(VecDeque::from([OAuthHttpResponse {
			status:  200,
			headers: HeaderMap::new(),
			body:    SecretString::from(
				r#"{"access_token":"access","refresh_token":"refresh","expires_in":3600}"#.to_owned(),
			),
		}])))
	}

	async fn pkce_timeline(session: &AnswerAuthSession) -> (Url, AuthPrompt) {
		let AuthEvent::OpenUrl { url, .. } = session
			.events
			.recv_async()
			.await
			.expect("URL event")
			.expect("valid URL event")
		else {
			panic!("expected authorization URL");
		};
		let AuthEvent::Prompt(prompt) = session
			.events
			.recv_async()
			.await
			.expect("prompt event")
			.expect("valid prompt event")
		else {
			panic!("expected authorization prompt");
		};
		(Url::parse(&url).expect("authorization URL"), prompt)
	}

	fn callback_spec(redirect_uri: Str, completion: PkceCompletion) -> OAuthPkceSpec {
		OAuthPkceSpec {
			client: client(),
			authorize_url: "https://auth.example/authorize".into(),
			redirect_uri,
			completion,
			authorize_params: Vec::new(),
		}
	}

	#[tokio::test]
	async fn device_authorization_sends_declared_scopes() {
		let http = RecordingHttp {
			response: Mutex::new(Some(OAuthHttpResponse {
				status:  200,
				headers: HeaderMap::new(),
				body:    SecretString::from(
					r#"{"device_code":"device","user_code":"CODE","verification_uri":"https://auth.example/verify","expires_in":600}"#.to_owned(),
				),
			})),
			body:     Mutex::new(None),
		};
		let clock = TestClock(SystemTime::UNIX_EPOCH);
		let engine = OAuthEngine::with_entropy(&http, &clock, FixedEntropy);
		let (_session, driver, _) = default_login_channels(LoginSessionId::from("device-scopes"));
		let spec = OAuthDeviceSpec {
			client:                   client(),
			device_authorization_url: "https://auth.example/device".into(),
			default_interval:         Duration::from_secs(1),
			max_interval:             Duration::from_secs(5),
		};
		engine
			.begin_device(&spec, &driver)
			.await
			.expect("device authorization");
		assert_eq!(http.body.lock().as_deref(), Some("client_id=client&scope=openid+profile"));
	}

	#[tokio::test]
	async fn pkce_timeline_validates_callback_state_and_redacts_pending_state() {
		let http = TestHttp(Mutex::new(VecDeque::from([OAuthHttpResponse {
			status:  200,
			headers: HeaderMap::new(),
			body:    SecretString::from(
				r#"{"access_token":"access","refresh_token":"refresh","expires_in":3600}"#.to_owned(),
			),
		}])));
		let clock = TestClock(SystemTime::UNIX_EPOCH);
		let engine = OAuthEngine::with_entropy(&http, &clock, FixedEntropy);
		let spec = OAuthPkceSpec {
			client:           client(),
			authorize_url:    "https://auth.example/authorize".into(),
			redirect_uri:     "http://127.0.0.1:1455/callback".into(),
			completion:       PkceCompletion::PasteCallbackUrl,
			authorize_params: Vec::new(),
		};
		let (session, driver, _) = default_login_channels(LoginSessionId::from("login"));
		let pending = engine.begin_pkce(&spec, &driver).await.expect("begin");
		let first = session
			.events
			.recv_async()
			.await
			.expect("event")
			.expect("ok");
		let AuthEvent::OpenUrl { url, .. } = first else {
			panic!("open URL")
		};
		let state = Url::parse(&url)
			.expect("url")
			.query_pairs()
			.find(|(name, _)| name == "state")
			.expect("state")
			.1
			.into_owned();
		assert!(!format!("{pending:?}").contains(&state));
		let callback = format!("http://127.0.0.1:1455/callback?code=code&state={state}");
		let tokens = engine
			.complete_pkce(&spec, pending, AuthInput::CallbackUrl(SecretString::from(callback)))
			.await
			.expect("tokens");
		assert!(tokens.is_refreshable());
		assert!(!format!("{tokens:?}").contains("access"));
	}

	#[tokio::test]
	async fn loopback_callback_completes_pkce_without_manual_input() {
		let (port, redirect_uri) = available_redirect_uri();
		let http = token_http();
		let clock = TestClock(SystemTime::UNIX_EPOCH);
		let engine = OAuthEngine::with_entropy(&http, &clock, FixedEntropy);
		let spec = callback_spec(redirect_uri, PkceCompletion::CallbackUrl);
		let (session, driver, _) = default_login_channels(LoginSessionId::from("loopback-callback"));
		let mut pending = engine.begin_pkce(&spec, &driver).await.expect("begin");
		let (authorization_url, prompt) = pkce_timeline(&session).await;
		assert_eq!(prompt.input, AuthPromptKind::Confirmation);
		let state = authorization_url
			.query_pairs()
			.find(|(name, _)| name == "state")
			.expect("state")
			.1
			.into_owned();
		let target = format!("/callback?code=browser-code&state={state}");
		let receive = engine.receive_pkce_input(&mut pending, &driver);
		let browser = raw_callback(port, &target);
		let (input, response) = futures::join!(receive, browser);
		assert!(response.starts_with("HTTP/1.1 200 OK"));
		assert!(response.contains("Authentication Successful"));
		assert!(response.contains("message.textContent = \"You have successfully logged in.\";"));
		assert!(response.contains("window.close();"));
		assert!(response.contains("closeButton.remove();"));
		assert!(response.contains("Please close this tab manually."));
		assert!(response.contains("}, 300);"));
		let tokens = engine
			.complete_pkce(&spec, pending, input.expect("browser input"))
			.await
			.expect("token exchange");
		assert!(tokens.is_refreshable());
	}

	#[tokio::test]
	async fn wrong_callback_state_is_rejected_without_stopping_listener() {
		let (port, redirect_uri) = available_redirect_uri();
		let http = token_http();
		let clock = TestClock(SystemTime::UNIX_EPOCH);
		let engine = OAuthEngine::with_entropy(&http, &clock, FixedEntropy);
		let spec = callback_spec(redirect_uri, PkceCompletion::CallbackUrl);
		let (session, driver, _) = default_login_channels(LoginSessionId::from("loopback-state"));
		let mut pending = engine.begin_pkce(&spec, &driver).await.expect("begin");
		let (authorization_url, _) = pkce_timeline(&session).await;
		let state = authorization_url
			.query_pairs()
			.find(|(name, _)| name == "state")
			.expect("state")
			.1
			.into_owned();
		let receive = engine.receive_pkce_input(&mut pending, &driver);
		let browser = async {
			let rejected = raw_callback(port, "/callback?code=forged&state=wrong").await;
			assert!(rejected.starts_with("HTTP/1.1 500 Internal Server Error"));
			assert!(rejected.contains("State mismatch - possible CSRF attack"));
			raw_callback(port, &format!("/callback?code=valid&state={state}")).await
		};
		let (input, accepted) = futures::join!(receive, browser);
		assert!(accepted.starts_with("HTTP/1.1 200 OK"));
		engine
			.complete_pkce(&spec, pending, input.expect("valid callback"))
			.await
			.expect("token exchange");
	}

	#[tokio::test]
	async fn trusted_error_callback_stops_with_typed_denial() {
		let (port, redirect_uri) = available_redirect_uri();
		let http = token_http();
		let clock = TestClock(SystemTime::UNIX_EPOCH);
		let engine = OAuthEngine::with_entropy(&http, &clock, FixedEntropy);
		let spec = callback_spec(redirect_uri, PkceCompletion::CallbackUrl);
		let (session, driver, _) = default_login_channels(LoginSessionId::from("loopback-denied"));
		let mut pending = engine.begin_pkce(&spec, &driver).await.expect("begin");
		let (authorization_url, _) = pkce_timeline(&session).await;
		let state = authorization_url
			.query_pairs()
			.find(|(name, _)| name == "state")
			.expect("state")
			.1
			.into_owned();
		let target =
			format!("/callback?error=access_denied&error_description=User+denied&state={state}");
		let receive = engine.receive_pkce_input(&mut pending, &driver);
		let browser = raw_callback(port, &target);
		let (result, response) = futures::join!(receive, browser);
		assert_eq!(result.expect_err("authorization denial"), OAuthError::AuthorizationDenied);
		assert!(response.starts_with("HTTP/1.1 500 Internal Server Error"));
		assert!(response.contains("Authorization failed: User denied"));
	}

	#[tokio::test]
	async fn callback_bind_conflict_degrades_to_paste_prompt() {
		let listener = TcpListener::bind((net::Ipv4Addr::LOCALHOST, 0)).expect("occupy port");
		let port = listener.local_addr().expect("local address").port();
		let redirect_uri = sf!("http://127.0.0.1:{port}/callback");
		let http = token_http();
		let clock = TestClock(SystemTime::UNIX_EPOCH);
		let engine = OAuthEngine::with_entropy(&http, &clock, FixedEntropy);
		let spec = callback_spec(redirect_uri.clone(), PkceCompletion::CallbackUrl);
		let (session, driver, _) = default_login_channels(LoginSessionId::from("loopback-conflict"));
		let mut pending = engine.begin_pkce(&spec, &driver).await.expect("begin");
		let (authorization_url, prompt) = pkce_timeline(&session).await;
		assert_eq!(prompt.id, "oauth-callback-url");
		assert_eq!(prompt.input, AuthPromptKind::AuthorizationCode);
		let state = authorization_url
			.query_pairs()
			.find(|(name, _)| name == "state")
			.expect("state")
			.1
			.into_owned();
		session
			.responses
			.send_async(AuthResponse {
				session: session.id.clone(),
				input:   AuthInput::AuthorizationCode(SecretString::from(format!(
					"{redirect_uri}?code=pasted&state={state}"
				))),
			})
			.await
			.expect("manual callback");
		let input = engine
			.receive_pkce_input(&mut pending, &driver)
			.await
			.expect("paste input");
		drop(listener);
		engine
			.complete_pkce(&spec, pending, input)
			.await
			.expect("token exchange");
	}

	#[tokio::test]
	async fn manual_paste_wins_while_callback_server_is_waiting() {
		let (_port, redirect_uri) = available_redirect_uri();
		let http = token_http();
		let clock = TestClock(SystemTime::UNIX_EPOCH);
		let engine = OAuthEngine::with_entropy(&http, &clock, FixedEntropy);
		let spec = callback_spec(redirect_uri.clone(), PkceCompletion::CallbackUrl);
		let (session, driver, _) = default_login_channels(LoginSessionId::from("loopback-manual"));
		let mut pending = engine.begin_pkce(&spec, &driver).await.expect("begin");
		let (authorization_url, prompt) = pkce_timeline(&session).await;
		assert_eq!(prompt.input, AuthPromptKind::Confirmation);
		let state = authorization_url
			.query_pairs()
			.find(|(name, _)| name == "state")
			.expect("state")
			.1
			.into_owned();
		session
			.responses
			.send_async(AuthResponse {
				session: session.id.clone(),
				input:   AuthInput::AuthorizationCode(SecretString::from(format!(
					"{redirect_uri}?code=manual&state={state}"
				))),
			})
			.await
			.expect("manual callback");
		let input = engine
			.receive_pkce_input(&mut pending, &driver)
			.await
			.expect("manual input");
		engine
			.complete_pkce(&spec, pending, input)
			.await
			.expect("token exchange");
	}

	#[tokio::test]
	async fn refresh_rejection_returns_typed_evidence_without_provider_text() {
		let http = TestHttp(Mutex::new(VecDeque::from([OAuthHttpResponse {
			status:  400,
			headers: HeaderMap::new(),
			body:    SecretString::from(
				r#"{"error":"invalid_grant","error_description":"leaked-secret"}"#.to_owned(),
			),
		}])));
		let clock = TestClock(SystemTime::UNIX_EPOCH);
		let engine = OAuthEngine::with_entropy(&http, &clock, FixedEntropy);
		let error = engine
			.refresh(&client(), SecretString::from("refresh-secret".to_owned()))
			.await
			.expect_err("rejected");
		let OAuthError::RefreshRejected(evidence) = error else {
			panic!("evidence")
		};
		assert_eq!(evidence.code.as_deref(), Some("invalid_grant"));
		assert!(!format!("{evidence:?}").contains("leaked-secret"));
	}
	#[tokio::test]
	async fn custom_oauth_dispatch_is_typed_and_fails_closed_when_unregistered() {
		let spec = OAuthCustomSpec {
			client:        client(),
			authorize_url: "https://auth.example/custom".into(),
			exchange:      OAuthExchangeKind::ApiKeyPaste,
			parameters:    Vec::new(),
			polling:       None,
		};
		let (_, driver, _) = default_login_channels(LoginSessionId::from("custom"));
		let error = OAuthCustomDispatcher::new()
			.exchange(&spec, &driver)
			.await
			.expect_err("missing handler");
		assert!(matches!(
			error,
			OAuthCustomDispatchError::Unavailable(OAuthExchangeKind::ApiKeyPaste)
		));
	}

	#[test]
	fn stored_bundle_round_trips_opaque_bytes_and_redacts_debug() {
		let access = "access-secret-marker";
		let refresh = "refresh-secret-marker";
		let tokens = OAuthTokenSet {
			access_token:      SecretString::from(access.to_owned()),
			refresh_token:     Some(SecretString::from(refresh.to_owned())),
			token_type:        "Bearer".into(),
			expires_in:        Some(Duration::from_secs(3600)),
			identity_response: SecretString::from("{}".to_owned()),
			project:           None,
		};
		let bundle = tokens.into_stored_bundle();
		let encoded = bundle.encode().expect("encode");
		assert!(!format!("{bundle:?} {encoded:?}").contains(access));
		assert!(!format!("{bundle:?} {encoded:?}").contains(refresh));
		let decoded = StoredOAuthBundle::decode(&encoded).expect("decode");
		let debug = format!("{decoded:?}");
		assert!(!debug.contains(access));
		assert!(!debug.contains(refresh));
	}
	#[test]
	fn stored_bundle_preserves_nonrenewable_access_tokens() {
		let tokens = OAuthTokenSet {
			access_token:      SecretString::from("access".to_owned()),
			refresh_token:     None,
			token_type:        "Bearer".into(),
			expires_in:        None,
			identity_response: SecretString::from("{}".to_owned()),
			project:           None,
		};
		let encoded = tokens.into_stored_bundle().encode().expect("encode");
		let decoded = StoredOAuthBundle::decode(&encoded).expect("decode");
		assert!(matches!(decoded.into_refresh(), Err(OAuthError::RefreshUnsupported)));
	}

	#[test]
	fn renewable_token_cannot_enter_ephemeral_lease_path() {
		let tokens = OAuthTokenSet {
			access_token:      SecretString::from("access".to_owned()),
			refresh_token:     Some(SecretString::from("refresh".to_owned())),
			token_type:        "Bearer".into(),
			expires_in:        None,
			identity_response: SecretString::from("{}".to_owned()),
			project:           None,
		};
		let meta = LeaseMeta {
			account:    AccountId::from("account"),
			principal:  PrincipalId::from("principal"),
			generation: 0,
			expires_at: None,
		};
		assert!(matches!(
			tokens.into_ephemeral_lease(meta, SystemTime::UNIX_EPOCH),
			Err(OAuthError::RenewableCredentialRequiresPersistence)
		));
	}

	#[test]
	fn access_only_login_persists_and_leases() {
		let directory = tempdir().expect("temporary directory");
		let keys = Arc::new(HeadlessKeySource::new(KeyId::new("oauth-access-only-key"), [0x7b; 32]));
		let store = CredentialStore::open(directory.path().join("credentials.sqlite"), keys)
			.expect("credential store");
		let issued_at = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
		let meta = LeaseMeta {
			account:    AccountId::from("access-only-account"),
			principal:  PrincipalId::from("access-only-principal"),
			generation: 0,
			expires_at: None,
		};
		let tokens = OAuthTokenSet {
			access_token:      SecretString::from("access-only-marker".to_owned()),
			refresh_token:     None,
			token_type:        "Bearer".into(),
			expires_in:        None,
			identity_response: SecretString::from("{}".to_owned()),
			project:           None,
		};
		let http = TestHttp(Mutex::new(VecDeque::new()));
		let clock = TestClock(issued_at);
		let engine = OAuthEngine::with_entropy(&http, &clock, FixedEntropy);

		let freshness = engine
			.persist_login(&store, tokens, &meta, CredentialOrigin::Persistent, issued_at)
			.expect("persist access-only login");
		assert_eq!(freshness.generation, 1);
		engine
			.lease_persisted(&store, &meta.account, issued_at)
			.expect("lease access-only login");
	}

	#[tokio::test]
	async fn persisted_login_refreshes_once_and_increments_generation() {
		let directory = tempdir().expect("temporary directory");
		let keys = Arc::new(HeadlessKeySource::new(KeyId::new("oauth-test-key"), [0x5a; 32]));
		let store = Arc::new(
			CredentialStore::open(directory.path().join("credentials.sqlite"), keys)
				.expect("credential store"),
		);
		let issued_at = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
		let meta = LeaseMeta {
			account:    AccountId::from("renewable-account"),
			principal:  PrincipalId::from("renewable-principal"),
			generation: 0,
			expires_at: None,
		};
		let initial = OAuthTokenSet {
			access_token:      SecretString::from("old-access-marker".to_owned()),
			refresh_token:     Some(SecretString::from("refresh-marker".to_owned())),
			token_type:        "Bearer".into(),
			expires_in:        Some(Duration::from_secs(1)),
			identity_response: SecretString::from("{}".to_owned()),
			project:           None,
		};
		let http = TestHttp(Mutex::new(VecDeque::from([OAuthHttpResponse {
			status: 200,
			headers: HeaderMap::new(),
			body: SecretString::from(
				r#"{"access_token":"new-access-marker","refresh_token":"new-refresh-marker","expires_in":3600}"#
					.to_owned(),
			),
		}])));
		let clock = TestClock(issued_at);
		let engine = OAuthEngine::with_entropy(&http, &clock, FixedEntropy);
		let freshness = engine
			.persist_login(&store, initial, &meta, CredentialOrigin::Persistent, issued_at)
			.expect("persist login");
		assert_eq!(freshness.generation, 1);
		assert!(matches!(
			engine.lease_persisted(&store, &meta.account, issued_at + Duration::from_secs(2)),
			Err(OAuthCredentialManagerError::Expired)
		));
		let coordinator = RefreshCoordinator::new("oauth-test-owner", RefreshPolicy::default())
			.expect("coordinator");
		let requested_at = issued_at + Duration::from_secs(2);
		let outcome = engine
			.refresh_persisted(
				&coordinator,
				store.clone(),
				client(),
				RefreshRequest {
					account: meta.account.clone(),
					principal: meta.principal.clone(),
					rejected: CredentialFreshness {
						generation:  1,
						issued_at:   Some(issued_at),
						expires_at:  freshness.expires_at,
						observed_at: requested_at,
					},
					requested_at,
				},
				CredentialOrigin::Persistent,
			)
			.await
			.expect("refresh");
		assert_eq!(outcome.result.freshness.generation, 2);
		let lease = engine
			.lease_persisted(&store, &meta.account, requested_at)
			.expect("renewed lease");
		let debug = format!("{lease:?} {outcome:?} {store:?}");
		for marker in ["refresh-marker", "new-refresh-marker", "new-access-marker"] {
			assert!(!debug.contains(marker));
		}
	}

	#[tokio::test]
	async fn principal_resolution_uses_only_catalog_selected_evidence() {
		let claim = "https://api.example/account";
		let claims = format!(
			r#"{{"{claim}":"claim-principal","https://api.openai.com/auth":{{"chatgpt_account_id":"nested-principal"}}}}"#
		);
		let payload = base64_url::encode_raw(claims.as_bytes()).into_string();
		let identity = format!(
			r#"{{"profile":{{"id":"response-principal"}},"id_token":"e30.{payload}.signature"}}"#,
		);
		let access_payload = base64_url::encode_raw(br#"{"sub":"access-principal"}"#).into_string();
		let tokens = OAuthTokenSet {
			access_token:      SecretString::from(format!("e30.{access_payload}.signature")),
			refresh_token:     Some(SecretString::from("refresh-secret".to_owned())),
			token_type:        "Bearer".into(),
			expires_in:        Some(Duration::from_secs(3600)),
			identity_response: SecretString::from(identity),
			project:           None,
		};
		let http = TestHttp(Mutex::new(VecDeque::from([OAuthHttpResponse {
			status:  200,
			headers: HeaderMap::new(),
			body:    SecretString::from(r#"{"subject":"userinfo-principal"}"#.to_owned()),
		}])));
		assert_eq!(
			tokens
				.resolve_principal(
					&PrincipalResolution::TokenResponseField { pointer: "/profile/id".into() },
					&http,
				)
				.await
				.expect("token response principal")
				.as_str(),
			"response-principal",
		);
		assert_eq!(
			tokens
				.resolve_principal(&PrincipalResolution::IdTokenClaim { claim: claim.into() }, &http,)
				.await
				.expect("ID token principal")
				.as_str(),
			"claim-principal",
		);
		assert_eq!(
			tokens
				.resolve_principal(
					&PrincipalResolution::IdTokenClaim {
						claim: "/https:~1~1api.openai.com~1auth/chatgpt_account_id".into(),
					},
					&http,
				)
				.await
				.expect("nested ID token principal")
				.as_str(),
			"nested-principal",
		);
		assert_eq!(
			tokens
				.resolve_principal(
					&PrincipalResolution::AccessTokenClaims {
						claims: Box::new(["user_id".into(), "sub".into()]),
					},
					&http,
				)
				.await
				.expect("access token principal")
				.as_str(),
			"access-principal",
		);
		assert_eq!(
			tokens
				.resolve_principal(
					&PrincipalResolution::StaticLabel { label: "configured-principal".into() },
					&http,
				)
				.await
				.expect("static principal")
				.as_str(),
			"configured-principal",
		);
		assert_eq!(
			tokens
				.resolve_principal(
					&PrincipalResolution::UserinfoEndpoint {
						url:   "https://auth.example/userinfo".into(),
						field: "subject".into(),
					},
					&http,
				)
				.await
				.expect("userinfo principal")
				.as_str(),
			"userinfo-principal",
		);
		assert!(!format!("{tokens:?}").contains("access-secret"));
	}

	#[tokio::test]
	async fn device_code_expiry_clamps_sleep_and_is_authoritative_without_poll_cap() {
		let http = TestHttp(Mutex::new(VecDeque::new()));
		let clock = AdvancingClock(Mutex::new(SystemTime::UNIX_EPOCH));
		let engine = OAuthEngine::with_entropy(&http, &clock, FixedEntropy);
		let (_events, driver, _cancellation) =
			default_login_channels(LoginSessionId::from("device-expiry"));
		let spec = OAuthDeviceSpec {
			client:                   client(),
			device_authorization_url: "https://auth.example/device".into(),
			default_interval:         Duration::from_secs(5),
			max_interval:             Duration::from_secs(10),
		};
		let pending = DevicePending {
			device_code: SecretString::from("device-secret"),
			interval:    Duration::from_secs(5),
			expires_at:  SystemTime::UNIX_EPOCH + Duration::from_secs(3),
			polls:       0,
		};
		assert!(matches!(
			engine.poll_device(&spec, pending, &driver).await,
			Err(OAuthError::PollingExhausted { polls: 0 })
		));
		assert_eq!(clock.now(), SystemTime::UNIX_EPOCH + Duration::from_secs(3));
	}

	#[tokio::test]
	async fn cancelled_device_poll_never_sends_a_request() {
		let http = TestHttp(Mutex::new(VecDeque::new()));
		let clock = TestClock(SystemTime::UNIX_EPOCH);
		let engine = OAuthEngine::with_entropy(&http, &clock, FixedEntropy);
		let (_, driver, cancellation) = default_login_channels(LoginSessionId::from("device"));
		cancellation.cancel();
		let spec = OAuthDeviceSpec {
			client:                   client(),
			device_authorization_url: "https://auth.example/device".into(),
			default_interval:         Duration::from_secs(1),
			max_interval:             Duration::from_secs(5),
		};
		let pending = DevicePending {
			device_code: SecretString::from("device-secret".to_owned()),
			interval:    Duration::from_secs(1),
			expires_at:  SystemTime::UNIX_EPOCH + Duration::from_secs(30),
			polls:       0,
		};
		assert!(matches!(
			engine.poll_device(&spec, pending, &driver).await,
			Err(OAuthError::Cancelled)
		));
	}
}
