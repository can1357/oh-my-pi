//! Combined MCP OAuth discovery, authorization, and refresh coordination.

use std::{
	fmt,
	future::Future,
	pin::Pin,
	sync::{Arc, atomic},
	time::{SystemTime, UNIX_EPOCH},
};

use http::HeaderMap;
use omp_ai::{auth::StoreError, id::PrincipalId};
use omp_core::{ExposeSecret as _, SecretString, Str};
use omp_oauth::{
	AuthChallenge, AuthorizationRequest, CallbackBindError, CallbackError, ClientConfiguration,
	ClientRegistrationError, CompleteAuthorizationError, DeviceAuthorizationError,
	DeviceAuthorizationRequest, LoopbackCallback, MetadataError, OAuthHttpClient, SystemEntropy,
	TokenError, TokenGrant, TokenRequest, begin_authorization, begin_device_authorization,
	complete_authorization, discover_authorization_server_metadata,
	discover_protected_resource_metadata, generate_pkce, poll_device_token, refresh_token,
	resolve_client, validate_redirect_pair,
};
use parking_lot::RwLock;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use url::Url;
use zeroize::Zeroizing;

use super::{
	auth_authority::{
		AuthAffinity, CombinedAuthAuthority, McpOAuthStoreError, StoredMcpOAuthCredential,
	},
	config::{McpServerConfig, OauthConfig},
	http::RefreshableHeaders,
};

/// Live Streamable-HTTP header adapter backed by one encrypted renewable
/// credential record.
pub struct AuthorityHeaders {
	flow:               Arc<McpOAuth>,
	state:              Mutex<OAuthCredentialState>,
	headers:            RwLock<HeaderMap>,
	reauthorize_needed: atomic::AtomicBool,
}

impl AuthorityHeaders {
	/// Acquires the current sealed generation and materializes only a sensitive
	/// Authorization header for the HTTP transport.
	pub async fn new(
		flow: Arc<McpOAuth>,
		state: OAuthCredentialState,
	) -> Result<Arc<Self>, OAuthFlowError> {
		let headers = bearer_headers(&state.access_token)?;
		Ok(Arc::new(Self {
			flow,
			state: Mutex::new(state),
			headers: RwLock::new(headers),
			reauthorize_needed: atomic::AtomicBool::new(false),
		}))
	}
}

impl RefreshableHeaders for AuthorityHeaders {
	fn current(&self) -> HeaderMap {
		self.headers.read().clone()
	}

	fn refresh<'a>(
		&'a self,
		cancel: &'a CancellationToken,
	) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
		Box::pin(async move {
			let mut state = tokio::select! {
				biased;
				() = cancel.cancelled() => return false,
				state = self.state.lock() => state,
			};
			if let Err(error) = self.flow.refresh(&mut state, cancel).await {
				if error.class() == OAuthFailureClass::Definitive
					|| matches!(error, OAuthFlowError::NotRefreshable)
				{
					let _ = self.flow.authority.delete_mcp(&state.affinity);
					state.refresh_token.take();
					self
						.reauthorize_needed
						.store(true, atomic::Ordering::Release);
				}
				return false;
			}
			let Ok(headers) = bearer_headers(&state.access_token) else {
				return false;
			};
			*self.headers.write() = headers;
			self
				.reauthorize_needed
				.store(false, atomic::Ordering::Release);
			true
		})
	}

	fn should_reauthorize(&self) -> bool {
		self.reauthorize_needed.load(atomic::Ordering::Acquire)
	}
}

fn bearer_headers(token: &SecretString) -> Result<HeaderMap, OAuthFlowError> {
	let mut material =
		Zeroizing::new(String::with_capacity("Bearer ".len() + token.expose_secret().len()));
	material.push_str("Bearer ");
	material.push_str(token.expose_secret());
	let mut value =
		http::HeaderValue::from_str(&material).map_err(|_| OAuthFlowError::InvalidBearerToken)?;
	value.set_sensitive(true);
	let mut headers = HeaderMap::new();
	headers.insert(http::header::AUTHORIZATION, value);
	Ok(headers)
}

/// Cold browser-opening boundary owned by the application shell.
pub trait BrowserLauncher: Send + Sync {
	/// Opens one validated authorization URL.
	fn open<'a>(
		&'a self,
		url: &'a str,
	) -> Pin<Box<dyn Future<Output = Result<(), BrowserError>> + Send + 'a>>;
}

/// Secret-free browser launch failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("OAuth authorization URL could not be opened")]
pub struct BrowserError;

/// Production launcher using the application's platform-safe opener.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemBrowserLauncher;

impl BrowserLauncher for SystemBrowserLauncher {
	fn open<'a>(
		&'a self,
		url: &'a str,
	) -> Pin<Box<dyn Future<Output = Result<(), BrowserError>> + Send + 'a>> {
		Box::pin(async move {
			omp_core::open::open_path(url);
			Ok(())
		})
	}
}

/// Retained OAuth protocol state. Secret fields remain authority-owned and are
/// never serialized into MCP definitions, UI, or journal events.
pub struct OAuthCredentialState {
	/// Opaque affinity used for encrypted persistence.
	pub affinity:       AuthAffinity,
	/// Current access token.
	pub access_token:   SecretString,
	/// Absolute access-token expiration.
	pub expires_at_ms:  Option<u64>,
	/// Token endpoint.
	pub token_endpoint: Str,
	/// Client identity.
	pub client_id:      Str,
	/// Optional confidential client secret.
	pub client_secret:  Option<SecretString>,
	/// RFC 8707 resource indicator.
	pub resource:       Option<Str>,
	/// Refresh material retained when a refresh response omits rotation.
	pub refresh_token:  Option<SecretString>,
	/// Current encrypted-store generation.
	pub generation:     u64,
}

impl fmt::Debug for OAuthCredentialState {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("OAuthCredentialState")
			.field("affinity", &self.affinity)
			.field("access_token", &"[REDACTED]")
			.field("expires_at_ms", &self.expires_at_ms)
			.field("token_endpoint", &"[REDACTED]")
			.field("client_id", &self.client_id)
			.field("client_secret", &self.client_secret.as_ref().map(|_| "[REDACTED]"))
			.field("resource", &self.resource.as_ref().map(|_| "[REDACTED]"))
			.field("refresh_token", &self.refresh_token.as_ref().map(|_| "[REDACTED]"))
			.field("generation", &self.generation)
			.finish()
	}
}

/// Inputs resolved from a mount and its authentication challenge.
pub struct OAuthAttempt<'a> {
	/// OMP profile identity.
	pub profile:      &'a str,
	/// Configured server URL and durable credential affinity.
	pub server_url:   &'a str,
	/// Validated mount configuration.
	pub config:       &'a McpServerConfig,
	/// HTTP rejection discovery evidence.
	pub challenge:    &'a AuthChallenge,
	/// Local HTTP listener URI behind any TLS terminator.
	pub listener_uri: &'a str,
	/// Cancellation for discovery, browser, callback/device polling, and token
	/// exchange.
	pub cancel:       CancellationToken,
}

/// One browser or device authorization instruction safe to present to the
/// local user.
#[derive(Clone, Copy)]
pub struct OAuthPresentation<'a> {
	/// Validated HTTP(S) URL.
	pub url:       &'a str,
	/// One-time device code when the URL cannot carry it.
	pub user_code: Option<&'a str>,
}

impl fmt::Debug for OAuthPresentation<'_> {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("OAuthPresentation")
			.field("url", &"[REDACTED]")
			.field("user_code", &self.user_code.map(|_| "[REDACTED]"))
			.finish()
	}
}

/// Combined OAuth coordinator over the one encrypted credential authority.
pub struct McpOAuth {
	http:      Arc<dyn OAuthHttpClient>,
	authority: Arc<CombinedAuthAuthority>,
	browser:   Arc<dyn BrowserLauncher>,
}

impl McpOAuth {
	/// Creates an Environment-owned OAuth coordinator.
	pub fn new(
		http: Arc<dyn OAuthHttpClient>,
		authority: Arc<CombinedAuthAuthority>,
		browser: Arc<dyn BrowserLauncher>,
	) -> Self {
		Self { http, authority, browser }
	}

	/// Creates live authorization headers for a previously persisted OAuth
	/// grant. A missing lease is intentionally returned to the caller so an
	/// unauthenticated probe can discover the server's challenge.
	pub async fn authority_headers(
		self: &Arc<Self>,
		profile: &str,
		config: &McpServerConfig,
	) -> Result<Arc<dyn RefreshableHeaders>, OAuthFlowError> {
		let server_url = config
			.url
			.as_deref()
			.ok_or(OAuthFlowError::MissingAuthorizationServer)?;
		let affinity =
			CombinedAuthAuthority::mcp_affinity(profile, server_url, PrincipalId::from(profile));
		let state = self.load_state(affinity)?;
		Ok(AuthorityHeaders::new(Arc::clone(self), state).await?)
	}

	fn load_state(&self, affinity: AuthAffinity) -> Result<OAuthCredentialState, OAuthFlowError> {
		let persisted = self
			.authority
			.load_mcp_oauth(&affinity)?
			.ok_or(OAuthFlowError::CredentialUnavailable)?;
		Ok(OAuthCredentialState {
			affinity,
			access_token: persisted.access_token,
			expires_at_ms: persisted.expires_at_ms,
			token_endpoint: persisted.token_endpoint,
			client_id: persisted.client_id,
			client_secret: persisted.client_secret,
			resource: persisted.resource,
			refresh_token: persisted.refresh_token,
			generation: persisted.generation,
		})
	}

	/// Runs discovery, explicit-client/DCR selection, browser authorization,
	/// callback validation, token exchange, and atomic encrypted grant rotation.
	pub async fn authorize(
		&self,
		attempt: OAuthAttempt<'_>,
	) -> Result<OAuthCredentialState, OAuthFlowError> {
		self.authorize_presented(attempt, None).await
	}

	/// Runs authorization while presenting the complete browser URL before the
	/// platform opener is invoked.
	pub async fn authorize_presented(
		&self,
		attempt: OAuthAttempt<'_>,
		present: Option<&(dyn for<'a> Fn(OAuthPresentation<'a>) + Send + Sync)>,
	) -> Result<OAuthCredentialState, OAuthFlowError> {
		if attempt.challenge.kind != omp_oauth::ChallengeKind::OAuth {
			return Err(OAuthFlowError::UnsupportedChallenge);
		}
		let protected = match cancellable(
			&attempt.cancel,
			discover_protected_resource_metadata(
				self.http.as_ref(),
				attempt.server_url,
				attempt.challenge.resource_metadata.as_deref(),
			),
		)
		.await
		{
			Ok(metadata) => Some(metadata),
			Err(OAuthFlowError::Cancelled) => return Err(OAuthFlowError::Cancelled),
			Err(_) => None,
		};
		let issuer = attempt.challenge.auth_server.as_deref().or_else(|| {
			protected
				.as_ref()
				.and_then(|metadata| metadata.authorization_servers.first().map(Str::as_str))
		});
		let discovered = if let Some(issuer) = issuer {
			Some(
				cancellable(
					&attempt.cancel,
					discover_authorization_server_metadata(self.http.as_ref(), issuer),
				)
				.await?,
			)
		} else if attempt.challenge.authorization_endpoint.is_some()
			&& attempt.challenge.token_endpoint.is_some()
		{
			None
		} else {
			return Err(OAuthFlowError::MissingAuthorizationServer);
		};
		let authorization_endpoint = attempt
			.challenge
			.authorization_endpoint
			.clone()
			.or_else(|| {
				discovered
					.as_ref()
					.and_then(|metadata| metadata.authorization_endpoint.clone())
			});
		let token_endpoint = attempt
			.challenge
			.token_endpoint
			.clone()
			.or_else(|| {
				discovered
					.as_ref()
					.map(|metadata| metadata.token_endpoint.clone())
			})
			.ok_or(OAuthFlowError::MissingAuthorizationServer)?;
		let device_endpoint = discovered
			.as_ref()
			.and_then(|metadata| metadata.device_authorization_endpoint.as_deref());
		let registration_endpoint =
			attempt
				.challenge
				.registration_endpoint
				.as_deref()
				.or_else(|| {
					discovered
						.as_ref()
						.and_then(|metadata| metadata.registration_endpoint.as_deref())
				});
		let overrides = attempt.config.oauth.as_ref();
		let configured_auth = attempt.config.auth.as_ref();
		let listener_uri = callback_listener_uri(attempt.listener_uri, overrides)?;
		let redirect_uri = overrides
			.and_then(|oauth| oauth.redirect_uri.as_deref())
			.unwrap_or(listener_uri.as_str());
		validate_redirect_pair(redirect_uri, listener_uri.as_str())?;
		let explicit_client = overrides
			.and_then(|oauth| oauth.client_id.as_deref())
			.or_else(|| configured_auth.and_then(|auth| auth.client_id.as_deref()))
			.or(attempt.challenge.client_id.as_deref());
		let redirect_uris = [redirect_uri];
		let client = cancellable(
			&attempt.cancel,
			resolve_client(self.http.as_ref(), ClientConfiguration {
				client_id: explicit_client,
				client_secret: None,
				registration_endpoint,
				redirect_uris: &redirect_uris,
				client_name: "OMP MCP client",
			}),
		)
		.await?;
		let scopes = preferred_authorization_scopes(
			protected
				.as_ref()
				.map_or(&[][..], |metadata| metadata.scopes.as_ref()),
			attempt.challenge.scopes.as_ref(),
			discovered
				.as_ref()
				.map_or(&[][..], |metadata| metadata.scopes_supported.as_ref()),
		);
		let resource = configured_auth
			.and_then(|auth| auth.resource.as_deref())
			.or(attempt.challenge.resource.as_deref());
		let Some(authorization_endpoint) = authorization_endpoint else {
			let Some(device_endpoint) = device_endpoint else {
				return Err(OAuthFlowError::MissingAuthorizationServer);
			};
			return self
				.authorize_device(
					&attempt,
					device_endpoint,
					token_endpoint,
					client.client_id,
					client.client_secret,
					&scopes,
					resource,
					present,
				)
				.await;
		};
		let pkce = generate_pkce(|bytes| SystemEntropy.fill(bytes))?;
		let pending = begin_authorization(
			AuthorizationRequest {
				authorization_endpoint: authorization_endpoint.as_str(),
				client_id: client.client_id.as_str(),
				redirect_uri,
				scopes: &scopes,
				resource,
				prompt: overrides.and_then(|oauth| oauth.prompt.as_deref()),
			},
			pkce,
		)?;
		let callback = cancellable(
			&attempt.cancel,
			LoopbackCallback::bind(listener_uri.as_str(), pending.pkce.state()),
		)
		.await;
		let grant = match callback {
			Ok(callback) => {
				if let Some(present) = present {
					present(OAuthPresentation {
						url:       pending.browser_url.as_str(),
						user_code: None,
					});
				}
				match cancellable(&attempt.cancel, self.browser.open(pending.browser_url.as_str()))
					.await
				{
					Ok(()) => {},
					Err(OAuthFlowError::Browser(_)) if present.is_some() => {
						// The validated URL has already reached the actor; a missing
						// platform opener does not invalidate a manual browser flow.
					},
					Err(error @ OAuthFlowError::Browser(_)) => {
						let Some(device_endpoint) = device_endpoint else {
							return Err(error);
						};
						return self
							.authorize_device(
								&attempt,
								device_endpoint,
								token_endpoint,
								client.client_id,
								client.client_secret,
								&scopes,
								resource,
								present,
							)
							.await;
					},
					Err(error) => return Err(error),
				}
				let callback_grant = match callback.receive(&attempt.cancel).await {
					Ok(grant) => grant,
					Err(error @ CallbackError::TimedOut) => {
						let Some(device_endpoint) = device_endpoint else {
							return Err(error.into());
						};
						return self
							.authorize_device(
								&attempt,
								device_endpoint,
								token_endpoint,
								client.client_id,
								client.client_secret,
								&scopes,
								resource,
								present,
							)
							.await;
					},
					Err(error) => return Err(error.into()),
				};
				cancellable(
					&attempt.cancel,
					complete_authorization(
						self.http.as_ref(),
						token_endpoint.as_str(),
						client.client_id.as_str(),
						client.client_secret.as_ref(),
						&attempt.cancel,
						pending,
						callback_grant.code,
						callback_grant.state.as_str(),
					),
				)
				.await?
			},
			Err(error @ OAuthFlowError::CallbackBind(_)) => {
				let Some(device_endpoint) = device_endpoint else {
					return Err(error);
				};
				return self
					.authorize_device(
						&attempt,
						device_endpoint,
						token_endpoint,
						client.client_id,
						client.client_secret,
						&scopes,
						resource,
						present,
					)
					.await;
			},
			Err(error) => return Err(error),
		};
		let affinity = CombinedAuthAuthority::mcp_affinity(
			attempt.profile,
			attempt.server_url,
			PrincipalId::from(attempt.profile),
		);
		self.persist_grant(
			affinity,
			token_endpoint,
			client.client_id,
			client.client_secret,
			resource.map(Str::from),
			grant,
			None,
		)
	}

	async fn authorize_device(
		&self,
		attempt: &OAuthAttempt<'_>,
		device_endpoint: &str,
		token_endpoint: Str,
		client_id: Str,
		client_secret: Option<SecretString>,
		scopes: &[Str],
		resource: Option<&str>,
		present: Option<&(dyn for<'a> Fn(OAuthPresentation<'a>) + Send + Sync)>,
	) -> Result<OAuthCredentialState, OAuthFlowError> {
		let pending = begin_device_authorization(
			self.http.as_ref(),
			&DeviceAuthorizationRequest {
				endpoint: device_endpoint,
				client_id: client_id.as_str(),
				client_secret: client_secret.as_ref(),
				scopes,
				resource,
			},
			&attempt.cancel,
		)
		.await?;
		if present.is_none() && !pending.user_code_embedded() {
			return Err(DeviceAuthorizationError::PresentationUnavailable.into());
		}
		if let Some(present) = present {
			present(OAuthPresentation {
				url:       pending.browser_url(),
				user_code: Some(pending.user_code()),
			});
		}
		match cancellable(&attempt.cancel, self.browser.open(pending.browser_url())).await {
			Ok(()) => {},
			Err(OAuthFlowError::Browser(_)) if present.is_some() => {
				// The actor has both the URL and one-time code, so manual
				// completion remains possible without a platform opener.
			},
			Err(error) => return Err(error),
		}
		let grant = poll_device_token(
			self.http.as_ref(),
			&TokenRequest {
				endpoint: token_endpoint.as_str(),
				client_id: Some(client_id.as_str()),
				client_secret: client_secret.as_ref(),
				resource,
				cancellation: Some(&attempt.cancel),
			},
			pending,
			&attempt.cancel,
		)
		.await?;
		let affinity = CombinedAuthAuthority::mcp_affinity(
			attempt.profile,
			attempt.server_url,
			PrincipalId::from(attempt.profile),
		);
		self.persist_grant(
			affinity,
			token_endpoint,
			client_id,
			client_secret,
			resource.map(Str::from),
			grant,
			None,
		)
	}

	/// Refreshes an access token, preserving the previous refresh token when the
	/// token endpoint omits rotation, and updates the encrypted-store
	/// generation.
	pub async fn refresh(
		&self,
		state: &mut OAuthCredentialState,
		cancel: &CancellationToken,
	) -> Result<(), OAuthFlowError> {
		let refresh = state
			.refresh_token
			.as_ref()
			.cloned()
			.ok_or(OAuthFlowError::NotRefreshable)?;
		let grant = cancellable(
			cancel,
			refresh_token(
				self.http.as_ref(),
				&TokenRequest {
					endpoint:      state.token_endpoint.as_str(),
					client_id:     Some(state.client_id.as_str()),
					client_secret: state.client_secret.as_ref(),
					resource:      state.resource.as_deref(),
					cancellation:  Some(cancel),
				},
				refresh,
			),
		)
		.await?;
		let replacement = match self.persist_grant(
			state.affinity.clone(),
			state.token_endpoint.clone(),
			state.client_id.clone(),
			state.client_secret.clone(),
			state.resource.clone(),
			grant,
			Some(state.generation),
		) {
			Ok(replacement) => replacement,
			Err(OAuthFlowError::Store(McpOAuthStoreError::Store(StoreError::GenerationConflict))) => {
				self.load_state(state.affinity.clone())?
			},
			Err(error) => return Err(error),
		};
		*state = replacement;
		Ok(())
	}

	fn persist_grant(
		&self,
		affinity: AuthAffinity,
		token_endpoint: Str,
		client_id: Str,
		client_secret: Option<SecretString>,
		resource: Option<Str>,
		grant: TokenGrant,
		expected_generation: Option<u64>,
	) -> Result<OAuthCredentialState, OAuthFlowError> {
		let expires_in = grant.expires_in();
		let (access, refresh_token, token_type, _) = grant.into_parts();
		if !token_type.eq_ignore_ascii_case("bearer") {
			return Err(OAuthFlowError::UnsupportedTokenType);
		}
		let now_ms = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap_or_default()
			.as_millis() as u64;
		let expires_at_ms =
			expires_in.map(|duration| now_ms.saturating_add(duration.as_millis() as u64));
		let mut state = OAuthCredentialState {
			affinity,
			access_token: access,
			expires_at_ms,
			token_endpoint,
			client_id,
			client_secret,
			resource,
			refresh_token,
			generation: 0,
		};
		state.generation = self.authority.persist_mcp_oauth(
			&state.affinity,
			&StoredMcpOAuthCredential {
				access_token:   state.access_token.clone(),
				refresh_token:  state.refresh_token.clone(),
				token_endpoint: state.token_endpoint.clone(),
				client_id:      state.client_id.clone(),
				client_secret:  state.client_secret.clone(),
				resource:       state.resource.clone(),
				expires_at_ms:  state.expires_at_ms,
				generation:     0,
			},
			now_ms,
			expected_generation,
		)?;
		Ok(state)
	}
}

async fn cancellable<T, E>(
	cancel: &CancellationToken,
	operation: impl Future<Output = Result<T, E>>,
) -> Result<T, OAuthFlowError>
where
	E: Into<OAuthFlowError>,
{
	tokio::pin!(operation);
	tokio::select! {
		biased;
		() = cancel.cancelled() => Err(OAuthFlowError::Cancelled),
		result = &mut operation => result.map_err(Into::into),
	}
}

/// Whether a failed grant should be cleared or retained for retry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OAuthFailureClass {
	/// Authorization or refresh was conclusively rejected.
	Definitive,
	/// Network, cancellation, browser, or storage failure may succeed later.
	Transient,
}

fn callback_listener_uri(
	default_uri: &str,
	overrides: Option<&OauthConfig>,
) -> Result<Str, OAuthFlowError> {
	let mut url = Url::parse(default_uri).map_err(|_| OAuthFlowError::InvalidCallbackConfig)?;
	if let Some(port) = overrides.and_then(|oauth| oauth.callback_port) {
		url.set_port(Some(port))
			.map_err(|()| OAuthFlowError::InvalidCallbackConfig)?;
	}
	if let Some(path) = overrides.and_then(|oauth| oauth.callback_path.as_deref()) {
		let path = if path.starts_with('/') {
			path.to_owned()
		} else {
			format!("/{path}")
		};
		url.set_path(&path);
	}
	Ok(Str::from(url.as_str()))
}

/// MCP OAuth flow failure with secret-free diagnostics.
#[derive(Debug, thiserror::Error)]
pub enum OAuthFlowError {
	/// Challenge requires an API key or unknown mechanism rather than OAuth.
	#[error("MCP authentication challenge is not OAuth")]
	UnsupportedChallenge,
	/// Callback port/path overrides were invalid.
	#[error("MCP OAuth callback configuration is invalid")]
	InvalidCallbackConfig,
	/// Discovery did not identify an authorization server.
	#[error("MCP OAuth challenge did not identify an authorization server")]
	MissingAuthorizationServer,
	/// Grant has no refresh token.
	#[error("MCP OAuth grant is not refreshable")]
	NotRefreshable,
	/// Token endpoint returned a non-bearer token.
	#[error("MCP OAuth token type is unsupported")]
	UnsupportedTokenType,
	/// Persisted grant did not contain a usable access token.
	#[error("MCP OAuth bearer token is invalid")]
	InvalidBearerToken,
	/// No persisted renewable grant exists for this mount.
	#[error("MCP OAuth credential is unavailable")]
	CredentialUnavailable,
	/// Caller cancelled discovery, presentation, or exchange.
	#[error("MCP OAuth authorization was cancelled")]
	Cancelled,
	/// RFC 8628 device fallback failed.
	#[error(transparent)]
	Device(#[from] DeviceAuthorizationError),
	/// Metadata discovery failed.
	#[error(transparent)]
	Metadata(#[from] MetadataError),
	/// Client selection or DCR failed.
	#[error(transparent)]
	Registration(#[from] ClientRegistrationError),
	/// PKCE entropy was unavailable.
	#[error(transparent)]
	Entropy(#[from] omp_oauth::EntropyError),
	/// Authorization request was invalid.
	#[error(transparent)]
	Authorization(#[from] omp_oauth::AuthorizationError),
	/// Callback could not bind or redirect validation failed.
	#[error(transparent)]
	CallbackBind(#[from] CallbackBindError),
	/// Callback did not complete.
	#[error(transparent)]
	Callback(#[from] CallbackError),
	/// Authorization exchange failed.
	#[error(transparent)]
	Complete(#[from] CompleteAuthorizationError),
	/// Refresh failed.
	#[error(transparent)]
	Token(#[from] TokenError),
	/// Browser could not open.
	#[error(transparent)]
	Browser(#[from] BrowserError),
	/// Complete encrypted OAuth record persistence failed.
	#[error(transparent)]
	Store(#[from] McpOAuthStoreError),
}
fn preferred_authorization_scopes(
	protected: &[Str],
	challenge: &[Str],
	authorization_server: &[Str],
) -> Vec<Str> {
	// Resource and RFC 6750 challenge scopes describe this grant; the
	// authorization-server list is only a broad fallback catalogue.
	let source = if !protected.is_empty() {
		protected
	} else if !challenge.is_empty() {
		challenge
	} else {
		authorization_server
	};
	let mut scopes = source.to_vec();
	scopes.sort_unstable();
	scopes.dedup();
	scopes
}

impl OAuthFlowError {
	/// Classifies whether retained refresh material remains eligible for retry.
	pub fn class(&self) -> OAuthFailureClass {
		match self {
			Self::Token(error)
			| Self::Complete(CompleteAuthorizationError::Token(error))
			| Self::Device(DeviceAuthorizationError::Token(error)) => token_failure_class(error),
			Self::Registration(ClientRegistrationError::Rejected { status })
			| Self::Device(DeviceAuthorizationError::Rejected { status }) => http_rejection_class(*status),
			Self::UnsupportedChallenge
			| Self::InvalidCallbackConfig
			| Self::MissingAuthorizationServer
			| Self::NotRefreshable
			| Self::UnsupportedTokenType
			| Self::InvalidBearerToken
			| Self::CredentialUnavailable
			| Self::Device(DeviceAuthorizationError::Malformed)
			| Self::Device(DeviceAuthorizationError::InvalidVerificationUrl)
			| Self::Device(DeviceAuthorizationError::Denied)
			| Self::Device(DeviceAuthorizationError::Expired)
			| Self::Device(DeviceAuthorizationError::Provider)
			| Self::Registration(ClientRegistrationError::Malformed)
			| Self::Registration(ClientRegistrationError::RegistrationUnavailable)
			| Self::Registration(ClientRegistrationError::InvalidRedirect)
			| Self::Authorization(_)
			| Self::CallbackBind(_)
			| Self::Complete(CompleteAuthorizationError::StateMismatch) => OAuthFailureClass::Definitive,
			Self::Cancelled
			| Self::Metadata(_)
			| Self::Device(DeviceAuthorizationError::Request(_))
			| Self::Device(DeviceAuthorizationError::Transport(_))
			| Self::Device(DeviceAuthorizationError::Cancelled)
			| Self::Device(DeviceAuthorizationError::PresentationUnavailable)
			| Self::Device(DeviceAuthorizationError::Unavailable)
			| Self::Registration(_)
			| Self::Entropy(_)
			| Self::Callback(_)
			| Self::Browser(_)
			| Self::Store(_) => OAuthFailureClass::Transient,
		}
	}
}

fn token_failure_class(error: &TokenError) -> OAuthFailureClass {
	match error {
		TokenError::Request(_) | TokenError::Transport(_) => OAuthFailureClass::Transient,
		TokenError::Rejected { status } => http_rejection_class(*status),
		TokenError::Provider { code }
			if matches!(
				code.as_str(),
				"temporarily_unavailable" | "server_error" | "authorization_pending" | "slow_down"
			) =>
		{
			OAuthFailureClass::Transient
		},
		TokenError::Provider { .. } | TokenError::Malformed => OAuthFailureClass::Definitive,
	}
}

const fn http_rejection_class(status: u16) -> OAuthFailureClass {
	if status == 408 || status == 429 || status >= 500 {
		OAuthFailureClass::Transient
	} else {
		OAuthFailureClass::Definitive
	}
}
#[cfg(test)]
mod tests {
	use omp_core::Str;

	use super::{OAuthFailureClass, OAuthFlowError, TokenError, preferred_authorization_scopes};

	#[test]
	fn refresh_outages_retain_credentials_but_invalid_grants_do_not() {
		assert_eq!(
			OAuthFlowError::Token(TokenError::Rejected { status: 503 }).class(),
			OAuthFailureClass::Transient
		);
		assert_eq!(
			OAuthFlowError::Token(TokenError::Provider { code: Str::from("invalid_grant") }).class(),
			OAuthFailureClass::Definitive
		);
	}

	#[test]
	fn protected_and_challenge_scopes_precede_authorization_server_catalogue() {
		let protected = [Str::from("offline_access"), Str::from("genie")];
		let challenge = [Str::from("challenge.read")];
		let catalogue =
			[Str::from("email"), Str::from("openid"), Str::from("profile"), Str::from("workspace")];

		assert_eq!(preferred_authorization_scopes(&protected, &challenge, &catalogue), vec![
			Str::from("genie"),
			Str::from("offline_access")
		],);
		assert_eq!(preferred_authorization_scopes(&[], &challenge, &catalogue), vec![Str::from(
			"challenge.read"
		)],);
		assert_eq!(preferred_authorization_scopes(&[], &[], &catalogue), vec![
			Str::from("email"),
			Str::from("openid"),
			Str::from("profile"),
			Str::from("workspace"),
		],);
	}
}
