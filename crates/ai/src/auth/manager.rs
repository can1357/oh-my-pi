//! Direct authentication-operation manager shared by every registry route.

use std::{
	collections::{BTreeMap, BTreeSet},
	fmt,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::{self, SystemTime, UNIX_EPOCH},
};

use flume::Sender;
use futures::future::{BoxFuture, Either, FutureExt as _};
use http::HeaderValue;
use omp_catalog::{
	AuthSpecId, Catalog, ProviderId,
	provider::{AuthSpecKind, OAuthExchangeKind, OAuthFlowSpec},
};
use omp_core::{ExposeSecret as _, Secret, SecretBox, SecretString, Str, sf};
use parking_lot::Mutex;
use zeroize::Zeroizing;

use super::{
	AuditedCredentialReveal, AuthRejection, AuthSpec, CredentialBroker, CredentialError,
	CredentialFuture, CredentialLease, CredentialMetadata, CredentialNeed, CredentialOrigin,
	CredentialSource, CredentialStore, CredentialWrite, KeyError, LeaseMeta, LoginChannelError,
	OAuthClientSpec, OAuthClock, OAuthCredentialImport, OAuthCredentialManagerError,
	OAuthCustomDispatchError, OAuthCustomDispatcher, OAuthCustomSpec, OAuthEngine, OAuthError,
	OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse, OAuthParameter, OAuthTransportError,
	PROVIDER_NAME_PARAMETER, ScopedCredentialGrant, ScopedCredentialToken, StoreError,
	credential_ready, default_login_channels,
};
use crate::{
	account::{
		AccountPool, AccountPoolEvent, AccountRecord, CredentialFreshness, RateWindowId,
		RefreshCoordinator, RefreshRequest,
	},
	answer::{
		AccountState, AccountSummary, AuthAnswer, AuthEvent, AuthPrompt, AuthPromptKind,
		AuthResponse, AuthSession,
	},
	call::{AccountRoutingContext, AuthInput, AuthMethod, AuthRequest, LoginRequest},
	codec::{CredentialDisabledObservation, ProviderRefreshReason, ProviderResponseHooks},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	id::{AccountId, LoginSessionId, PrincipalId, RegionId},
	receipt::ExecutionReceipt,
	session::CredentialAffinityDigest,
};

/// One-way credential ingress owned by an authenticated CONTROL authority.
pub struct CredentialControlWrite {
	/// Provider namespace already admitted by the extension grant.
	pub provider:      ProviderId,
	/// Stable authenticated principal for the stored account.
	pub principal:     PrincipalId,
	/// Optional non-secret provider identity used for account rotation.
	pub identity:      Option<Str>,
	/// Credential shape retained with the encrypted envelope.
	pub kind:          Str,
	/// Secret bytes crossing only the explicit ingress boundary.
	pub secret:        Secret,
	/// Optional absolute expiration.
	pub expires_at_ms: Option<u64>,
}

/// Renewable OAuth ingress owned by an authenticated CONTROL authority.
pub struct OAuthControlImport {
	/// Provider namespace already admitted by the extension grant.
	pub provider:      ProviderId,
	/// Stable authenticated principal for the stored account.
	pub principal:     PrincipalId,
	/// Optional non-secret provider identity used for account rotation.
	pub identity:      Option<Str>,
	/// Current access token, absent when immediate refresh is required.
	pub access_token:  Option<SecretString>,
	/// Renewable refresh token.
	pub refresh_token: SecretString,
	/// Optional absolute access-token expiration.
	pub expires_at_ms: Option<u64>,
}

/// Narrow control-plane handle over the live authentication manager.
///
/// It retains the same encrypted store and durable account pool as inference;
/// no credential or lifecycle state is projected into a second owner.
#[derive(Clone)]
pub struct AuthControlHandle {
	manager: AuthManager,
}

impl AuthControlHandle {
	/// Subscribes to future secret-free mutations of the canonical account pool.
	pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<AccountPoolEvent> {
		self.manager.accounts.subscribe()
	}

	/// Lists live secret-free account records in deterministic order.
	pub fn accounts(&self, provider: Option<&ProviderId<str>>) -> Vec<AccountRecord> {
		self
			.manager
			.accounts
			.accounts()
			.into_iter()
			.filter(|record| provider.is_none_or(|provider| provider == &record.provider))
			.collect()
	}

	/// Returns encrypted-store metadata without materializing secret bytes.
	pub fn metadata(
		&self,
		account: &AccountId<str>,
	) -> Result<Option<CredentialMetadata>, StoreError> {
		self.manager.store.metadata(account)
	}

	/// Atomically persists one scalar credential and updates the shared pool.
	pub fn store(
		&self,
		write: CredentialControlWrite,
	) -> Result<(CredentialMetadata, AccountRecord), StoreError> {
		let identity = write
			.identity
			.unwrap_or_else(|| Str::from(write.principal.as_str()));
		let account = AccountId::from(format!("{}:{identity}", write.provider));
		let now_ms = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map_err(|_| StoreError::InvalidTime)?
			.as_millis()
			.try_into()
			.map_err(|_| StoreError::InvalidTime)?;
		let secret = write
			.secret
			.expose(|bytes| SecretBox::new(Box::new(bytes.to_vec())));
		let metadata = self.manager.store.put(CredentialWrite {
			account_id: &account,
			principal_id: &write.principal,
			kind: write.kind.as_str(),
			secret: &secret,
			expires_at_ms: write.expires_at_ms,
			origin: CredentialOrigin::Persistent,
			now_ms,
			expected_generation: self
				.manager
				.store
				.metadata(&account)?
				.map(|row| row.generation),
		})?;
		let record =
			self.account_record(account, write.principal, write.provider, metadata.generation);
		self
			.manager
			.accounts
			.upsert(record.clone())
			.map_err(|_| StoreError::AccountState)?;
		Ok((metadata, record))
	}

	/// Imports renewable OAuth material into the canonical opaque bundle.
	pub fn import_oauth(
		&self,
		import: OAuthControlImport,
	) -> Result<(CredentialMetadata, AccountRecord), StoreError> {
		let identity = import
			.identity
			.unwrap_or_else(|| Str::from(import.principal.as_str()));
		let account = AccountId::from(format!("{}:{identity}", import.provider));
		let imported_at = SystemTime::now();
		let expires_at = match import.expires_at_ms {
			Some(millis) => UNIX_EPOCH
				.checked_add(time::Duration::from_millis(millis))
				.ok_or(StoreError::InvalidTime)?,
			None => imported_at,
		};
		let metadata = self
			.manager
			.store
			.import_oauth_bundle(OAuthCredentialImport {
				account_id: account.clone(),
				principal_id: import.principal.clone(),
				access_token: import
					.access_token
					.unwrap_or_else(|| SecretString::from("")),
				refresh_token: import.refresh_token,
				expires_at,
				imported_at,
				origin: CredentialOrigin::Persistent,
			})?;
		let record =
			self.account_record(account, import.principal, import.provider, metadata.generation);
		self
			.manager
			.accounts
			.upsert(record.clone())
			.map_err(|_| StoreError::AccountState)?;
		Ok((metadata, record))
	}

	/// Enables or disables an account in the one durable account pool.
	pub fn set_enabled(
		&self,
		account: &AccountId<str>,
		enabled: bool,
		cause: Option<&str>,
	) -> Result<AccountRecord, StoreError> {
		if !self
			.manager
			.accounts
			.set_enabled(account, enabled)
			.map_err(|_| StoreError::AccountState)?
		{
			return Err(StoreError::NotFound);
		}
		let record = self
			.manager
			.accounts
			.account(account)
			.ok_or(StoreError::NotFound)?;
		if !enabled {
			let hooks = self.manager.provider_hooks.lock().clone();
			if hooks.credential_disabled_subscribed() {
				hooks.observe_credential_disabled(CredentialDisabledObservation {
					provider: record.provider.clone(),
					account:  Some(record.account.clone()),
					cause:    Str::new(cause.unwrap_or("disabled")),
				});
			}
		}
		Ok(record)
	}

	/// Durably records one client-observed rate block.
	pub fn report_block(
		&self,
		account: &AccountId<str>,
		scope: impl Into<Str>,
		until: SystemTime,
	) -> Result<(), StoreError> {
		if self.manager.accounts.account(account).is_none() {
			return Err(StoreError::NotFound);
		}
		self
			.manager
			.accounts
			.record_rate_429(
				account.to_owned(),
				RateWindowId::new(scope),
				Some(until),
				SystemTime::now(),
			)
			.map_err(|_| StoreError::AccountState)
	}

	/// Returns live durable block metadata without exposing credentials.
	pub fn blocks(&self, account: &AccountId<str>) -> Vec<(Str, u64)> {
		let now = SystemTime::now();
		let rate = self.manager.accounts.rate_state(account);
		rate
			.windows()
			.filter_map(|(scope, window)| {
				let until = window
					.retry_at
					.map(|sample| sample.value)
					.into_iter()
					.chain(window.reset_at.map(|sample| sample.value))
					.filter(|until| *until > now)
					.max()?;
				let millis = until
					.duration_since(UNIX_EPOCH)
					.ok()?
					.as_millis()
					.try_into()
					.ok()?;
				Some((Str::from(scope.as_str()), millis))
			})
			.collect()
	}

	/// Clears selected durable block scopes, or every scope when empty.
	pub fn clear_blocks(&self, account: &AccountId<str>, scopes: &[Str]) -> Result<(), StoreError> {
		if self.manager.accounts.account(account).is_none() {
			return Err(StoreError::NotFound);
		}
		self
			.manager
			.accounts
			.clear_rate(account, scopes)
			.map_err(|_| StoreError::AccountState)
	}

	/// Invalidates cached provider usage observations.
	pub fn invalidate_usage(
		&self,
		provider: Option<&ProviderId<str>>,
		account: Option<&AccountId<str>>,
	) -> Result<(), StoreError> {
		self
			.manager
			.accounts
			.invalidate_usage(provider, account)
			.map_err(|_| StoreError::AccountState)
	}

	/// Mints one idempotent scoped token from the credential store's durable
	/// grant ledger.
	pub fn mint_scoped_token(
		&self,
		account: &AccountId<str>,
		grant: &ScopedCredentialGrant,
	) -> Result<ScopedCredentialToken, StoreError> {
		self.manager.store.mint_scoped_token(account, grant)
	}

	/// Mints or replays a scoped token while preserving the expiration recorded
	/// by the first RPC attempt.
	pub fn mint_scoped_token_replay(
		&self,
		account: &AccountId<str>,
		grant: &ScopedCredentialGrant,
	) -> Result<ScopedCredentialToken, StoreError> {
		self.manager.store.mint_scoped_token_replay(account, grant)
	}

	/// Forces refresh through the manager's existing single-flight engine.
	pub async fn refresh(&self, account: AccountId) -> Result<CredentialMetadata, Error> {
		self
			.manager
			.execute(AuthRequest::Refresh { account: account.clone() })
			.await?;
		self
			.manager
			.store
			.metadata(&account)
			.map_err(|_| auth_store_failure())?
			.ok_or_else(auth_not_found)
	}

	/// Deletes encrypted material and removes the shared live account.
	pub async fn delete(&self, account: AccountId) -> Result<(), Error> {
		self
			.manager
			.execute(AuthRequest::Logout { account })
			.await
			.map(|_| ())
	}

	/// Exposes a temporary secret only after the encrypted store commits audit.
	pub fn reveal<R>(
		&self,
		account: &AccountId<str>,
		audit: &AuditedCredentialReveal,
		use_secret: impl FnOnce(&Secret) -> R,
	) -> Result<R, StoreError> {
		self
			.manager
			.store
			.with_audited_secret(account, audit, use_secret)
	}

	fn account_record(
		&self,
		account: AccountId,
		principal: PrincipalId,
		provider: ProviderId,
		generation: u64,
	) -> AccountRecord {
		let routes = self
			.manager
			.catalog
			.routes()
			.iter()
			.filter(|route| route.provider == provider)
			.map(|route| route.id.clone())
			.collect();
		AccountRecord {
			account,
			principal,
			provider,
			routes,
			enabled: true,
			credential_generation: generation,
			routing: AccountRoutingContext::default(),
		}
	}
}

/// Inference-owned keyed resolver for journal-safe credential affinity.
///
/// The key is retained only in process-owned credential state. Journals receive
/// the resulting digest, never account ids, principals, or key bytes.
#[derive(Clone)]
pub struct CredentialAffinityResolver {
	key: Zeroizing<[u8; 32]>,
}

impl fmt::Debug for CredentialAffinityResolver {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("CredentialAffinityResolver")
			.field("key", &"[REDACTED]")
			.finish()
	}
}

/// Failure restoring one opaque affinity against the live credential catalog.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum CredentialAffinityError {
	/// No live account has the persisted affinity.
	#[error("credential affinity no longer matches an available account")]
	NotFound,
	/// More than one live account matched, so selecting either would be unsafe.
	#[error("credential affinity matched multiple accounts")]
	Ambiguous,
}

impl CredentialAffinityResolver {
	/// Creates a resolver from credential-authority-owned random bytes.
	pub fn new(key: [u8; 32]) -> Self {
		Self { key: Zeroizing::new(key) }
	}

	/// Computes opaque affinity for one inference-owned account record.
	pub fn digest(&self, account: &AccountRecord) -> CredentialAffinityDigest {
		CredentialAffinityDigest::derive(
			&self.key,
			&account.provider,
			&account.account,
			&account.principal,
		)
	}

	/// Restores exactly one live account from opaque journal evidence.
	pub fn resolve(
		&self,
		pool: &AccountPool,
		provider: &omp_catalog::ProviderId<str>,
		affinity: &CredentialAffinityDigest,
	) -> Result<AccountRecord, CredentialAffinityError> {
		let mut matched = pool
			.accounts()
			.into_iter()
			.filter(|account| &account.provider == provider && self.digest(account) == *affinity);
		let account = matched.next().ok_or(CredentialAffinityError::NotFound)?;
		if matched.next().is_some() {
			return Err(CredentialAffinityError::Ambiguous);
		}
		Ok(account)
	}
}
/// One constructed engine for a typed public login method.
pub trait AuthLoginEngine: Send + Sync {
	/// Public login method implemented by this engine.
	fn method(&self) -> AuthMethod;
	/// Returns whether this engine supports the provider.
	///
	/// Provider-scoped engines must be registered before generic engines for
	/// the same method because dispatch selects the first supporting engine.
	fn supports(&self, provider: &omp_catalog::ProviderId<str>) -> bool;

	/// Begins the exact catalog-selected authentication specification.
	fn begin(
		&self,
		request: LoginRequest,
		spec: AuthSpecId,
	) -> BoxFuture<'_, Result<AuthSession, Error>>;
}

/// Constructed credential refresher used by direct authentication operations.
pub trait AuthRefreshEngine: Send + Sync {
	/// Refreshes one exact account and returns its secret-free state.
	fn refresh(&self, account: AccountId) -> BoxFuture<'_, Result<AccountSummary, Error>>;
	/// Binds the session extension hook sink used by automatic refreshes.
	fn bind_provider_hooks(&self, _hooks: ProviderResponseHooks) {}
}

/// Construction failure for a static secret login engine.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("secret login engine supports only API-key or session-token methods")]
pub struct SecretLoginEngineError;

/// Concrete bounded login engine for caller-labeled API keys and session
/// tokens.
#[derive(Clone)]
pub struct SecretLoginEngine {
	method:          AuthMethod,
	principal_label: Str,
	catalog:         Arc<Catalog>,
	store:           Arc<CredentialStore>,
	accounts:        AccountPool,
}

impl SecretLoginEngine {
	/// Constructs a persistent secret login engine with an explicit non-secret
	/// principal label.
	pub fn new(
		method: AuthMethod,
		principal_label: Str,
		catalog: Arc<Catalog>,
		store: Arc<CredentialStore>,
		accounts: AccountPool,
	) -> Result<Self, SecretLoginEngineError> {
		if !matches!(method, AuthMethod::ApiKey | AuthMethod::SessionToken)
			|| principal_label.is_empty()
		{
			return Err(SecretLoginEngineError);
		}
		Ok(Self { method, principal_label, catalog, store, accounts })
	}
}

impl AuthLoginEngine for SecretLoginEngine {
	fn method(&self) -> AuthMethod {
		self.method
	}

	fn supports(&self, _provider: &omp_catalog::ProviderId<str>) -> bool {
		true
	}

	fn begin(
		&self,
		request: LoginRequest,
		spec: AuthSpecId,
	) -> BoxFuture<'_, Result<AuthSession, Error>> {
		let catalog = Arc::clone(&self.catalog);
		let store = Arc::clone(&self.store);
		let accounts = self.accounts.clone();
		let principal_label = self.principal_label.clone();
		let method = self.method;
		async move {
			let auth = catalog.auth_spec(&spec).ok_or_else(auth_not_found)?;
			let credential_kind = match (method, auth.kind) {
				(AuthMethod::ApiKey, AuthSpecKind::ApiKey) => "api-key",
				(AuthMethod::ApiKey, AuthSpecKind::Bearer | AuthSpecKind::OptionalBearer) => "bearer",
				(AuthMethod::SessionToken, AuthSpecKind::OmpSession) => "session-token",
				_ => return Err(auth_unavailable()),
			};
			let provider = catalog
				.provider(&request.provider)
				.ok_or_else(auth_not_found)?;
			let session_id = next_login_session_id();
			let (session, driver, _) = default_login_channels(session_id);
			let provider_id = request.provider;
			let routes = provider.routes.iter().cloned().collect();
			tokio::spawn(async move {
				let result = async {
					let prompt_message = match method {
						AuthMethod::ApiKey => "Enter the API key",
						_ => "Enter the session token",
					};
					let prompt = AuthPrompt {
						id:      sf!(<&'static str>::from(method)),
						message: sf!(prompt_message),
						input:   match method {
							AuthMethod::ApiKey => AuthPromptKind::ApiKey,
							_ => AuthPromptKind::SessionToken,
						},
					};
					driver
						.emit(AuthEvent::Prompt(prompt))
						.await
						.map_err(login_channel_error)?;
					let input = driver.receive().await.map_err(login_channel_error)?;
					let ((AuthMethod::ApiKey, AuthInput::ApiKey(secret))
					| (AuthMethod::SessionToken, AuthInput::SessionToken(secret))) = (method, input)
					else {
						return Err(auth_invalid_request());
					};
					let principal = PrincipalId::from(principal_label.clone());
					let account = AccountId::from(format!("{provider_id}:{principal_label}"));
					let bytes = SecretBox::new(Box::new(secret.expose_secret().as_bytes().to_vec()));
					let metadata = store
						.put(CredentialWrite {
							account_id:          &account,
							principal_id:        &principal,
							kind:                credential_kind,
							secret:              &bytes,
							expires_at_ms:       None,
							origin:              CredentialOrigin::Persistent,
							now_ms:              unix_millis(SystemTime::now())?,
							expected_generation: None,
						})
						.map_err(auth_store_error)?;
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
						.map_err(|_| auth_store_failure())?;
					let summary = AccountSummary {
						account,
						provider: provider_id,
						principal: Some(principal),
						label: Some(principal_label),
						state: AccountState::Active,
					};
					driver
						.emit(AuthEvent::Complete(summary))
						.await
						.map_err(login_channel_error)
				}
				.await;
				if let Err(error) = result {
					let _ = driver.emit_error(error).await;
				}
			});
			Ok(session)
		}
		.boxed()
	}
}

/// Construction failure for a non-interactive credential acquisition engine.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("credential acquisition engine supports only ADC or AWS-chain methods")]
pub struct CredentialAcquisitionLoginEngineError;

/// Concrete login adapter for application-default and AWS credential chains.
#[derive(Clone)]
pub struct CredentialAcquisitionLoginEngine {
	method:          AuthMethod,
	principal_label: Str,
	catalog:         Arc<Catalog>,
	broker:          CredentialBroker,
	accounts:        AccountPool,
}

impl CredentialAcquisitionLoginEngine {
	/// Constructs one catalog-driven non-interactive acquisition adapter.
	pub fn new(
		method: AuthMethod,
		principal_label: Str,
		catalog: Arc<Catalog>,
		broker: CredentialBroker,
		accounts: AccountPool,
	) -> Result<Self, CredentialAcquisitionLoginEngineError> {
		if !matches!(method, AuthMethod::ApplicationDefault | AuthMethod::AwsCredentialChain)
			|| principal_label.is_empty()
		{
			return Err(CredentialAcquisitionLoginEngineError);
		}
		Ok(Self { method, principal_label, catalog, broker, accounts })
	}
}

impl AuthLoginEngine for CredentialAcquisitionLoginEngine {
	fn method(&self) -> AuthMethod {
		self.method
	}

	fn supports(&self, _provider: &omp_catalog::ProviderId<str>) -> bool {
		true
	}

	fn begin(
		&self,
		request: LoginRequest,
		spec: AuthSpecId,
	) -> BoxFuture<'_, Result<AuthSession, Error>> {
		let catalog = Arc::clone(&self.catalog);
		let broker = self.broker.clone();
		let accounts = self.accounts.clone();
		let label = self.principal_label.clone();
		let method = self.method;
		async move {
			let auth = catalog.auth_spec(&spec).ok_or_else(auth_not_found)?;
			let expected = match method {
				AuthMethod::ApplicationDefault => AuthSpecKind::GcpAdc,
				AuthMethod::AwsCredentialChain => AuthSpecKind::AwsSigv4,
				_ => return Err(auth_unavailable()),
			};
			if auth.kind != expected {
				return Err(auth_unavailable());
			}
			let provider = catalog
				.provider(&request.provider)
				.ok_or_else(auth_not_found)?;
			let provider_id = request.provider;
			let routes = provider.routes.iter().cloned().collect();
			let principal = PrincipalId::from(label.clone());
			let account = AccountId::from(format!("{provider_id}:{label}"));
			let (session, driver, _) = default_login_channels(next_login_session_id());
			tokio::spawn(async move {
				let result = async {
					let lease = broker
						.lease(CredentialNeed {
							spec,
							account: Some(account.clone()),
							principal: Some(principal.clone()),
							valid_after: SystemTime::now(),
						})
						.await
						.map_err(credential_error)?;
					accounts
						.upsert(AccountRecord {
							account: account.clone(),
							principal: principal.clone(),
							provider: provider_id.clone(),
							routes,
							enabled: true,
							credential_generation: lease.meta().generation,
							routing: AccountRoutingContext::default(),
						})
						.map_err(|_| auth_store_failure())?;
					driver
						.emit(AuthEvent::Complete(AccountSummary {
							account,
							provider: provider_id,
							principal: Some(principal),
							label: Some(label),
							state: AccountState::Active,
						}))
						.await
						.map_err(login_channel_error)
				}
				.await;
				if let Err(error) = result {
					let _ = driver.emit_error(error).await;
				}
			});
			Ok(session)
		}
		.boxed()
	}
}

/// Per-login OAuth transport that binds every standard request to session
/// cancellation.
#[derive(Clone)]
struct LoginOAuthHttpClient<C> {
	inner:        Arc<C>,
	cancellation: super::LoginCancellation,
}

impl<C: OAuthHttpClient> OAuthHttpClient for LoginOAuthHttpClient<C> {
	fn execute(
		&self,
		request: OAuthHttpRequest,
	) -> BoxFuture<'_, Result<OAuthHttpResponse, OAuthTransportError>> {
		self
			.inner
			.execute(request.with_cancellation(self.cancellation.transport_token()))
	}
}

/// Construction failure for a concrete OAuth login adapter.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("OAuth login engine supports only PKCE/paste or device methods")]
pub struct OAuthLoginEngineError;

/// Owned OAuth login adapter over the catalog protocol engine.
pub struct OAuthLoginEngine<C, K> {
	method:   AuthMethod,
	catalog:  Arc<Catalog>,
	store:    Arc<CredentialStore>,
	accounts: AccountPool,
	http:     Arc<C>,
	clock:    Arc<K>,
	custom:   Arc<OAuthCustomDispatcher>,
}

impl<C, K> OAuthLoginEngine<C, K> {
	/// Constructs one method-specific owned OAuth login adapter.
	pub fn new(
		method: AuthMethod,
		catalog: Arc<Catalog>,
		store: Arc<CredentialStore>,
		accounts: AccountPool,
		http: Arc<C>,
		clock: Arc<K>,
		custom: Arc<OAuthCustomDispatcher>,
	) -> Result<Self, OAuthLoginEngineError> {
		if !matches!(method, AuthMethod::OAuthPkce | AuthMethod::OAuthDevice) {
			return Err(OAuthLoginEngineError);
		}
		Ok(Self { method, catalog, store, accounts, http, clock, custom })
	}
}

impl<C, K> AuthLoginEngine for OAuthLoginEngine<C, K>
where
	C: OAuthHttpClient + 'static,
	K: OAuthClock + 'static,
{
	fn method(&self) -> AuthMethod {
		self.method
	}

	fn supports(&self, _provider: &omp_catalog::ProviderId<str>) -> bool {
		true
	}

	fn begin(
		&self,
		request: LoginRequest,
		spec_id: AuthSpecId,
	) -> BoxFuture<'_, Result<AuthSession, Error>> {
		let catalog = Arc::clone(&self.catalog);
		let store = Arc::clone(&self.store);
		let accounts = self.accounts.clone();
		let http = Arc::clone(&self.http);
		let clock = Arc::clone(&self.clock);
		let custom = Arc::clone(&self.custom);
		let method = self.method;
		async move {
			let auth = catalog.auth_spec(&spec_id).ok_or_else(auth_not_found)?;
			let oauth_id = auth.oauth.as_ref().ok_or_else(auth_unavailable)?;
			let oauth = catalog.oauth_spec(oauth_id).ok_or_else(auth_unavailable)?;
			let resolution = oauth
				.principal_resolution
				.clone()
				.ok_or_else(principal_unresolved)?;
			let mut runtime =
				AuthSpec::from_catalog(auth, Some(oauth), None).map_err(|_| auth_unavailable())?;
			let provider = catalog
				.provider(&request.provider)
				.ok_or_else(auth_not_found)?;
			if let AuthSpec::OAuthCustom(spec) = &mut runtime
				&& spec.exchange == OAuthExchangeKind::ApiKeyPaste
			{
				// The API-key paste prompt addresses the user by provider: the
				// shared OpenCode console mints keys for both Zen and Go, so the
				// prompt must name the selected provider rather than a generic
				// (or wrong) one. Gated to the paste exchange because other custom
				// handlers forward catalog parameters onto wire URLs.
				spec.parameters.push(OAuthParameter {
					name:  sf!(PROVIDER_NAME_PARAMETER),
					value: provider.name.clone(),
				});
			}
			let routes = provider.routes.iter().cloned().collect();
			let provider_id = request.provider;
			let session_id = next_login_session_id();
			let (session, driver, cancellation) = default_login_channels(session_id);
			tokio::spawn(async move {
				let result = {
					let flow = async {
						let request_http = LoginOAuthHttpClient {
							inner:        Arc::clone(&http),
							cancellation: cancellation.clone(),
						};
						let engine = OAuthEngine::new(&request_http, clock.as_ref());
						let tokens = match runtime {
							AuthSpec::OAuthPkce(spec) if method == AuthMethod::OAuthPkce => {
								let mut pending = engine
									.begin_pkce(&spec, &driver)
									.await
									.map_err(oauth_error)?;
								let input = engine
									.receive_pkce_input(&mut pending, &driver)
									.await
									.map_err(oauth_error)?;
								engine
									.complete_pkce(&spec, pending, input)
									.await
									.map_err(oauth_error)?
							},
							AuthSpec::OAuthPaste(spec) if method == AuthMethod::OAuthPkce => {
								engine
									.begin_paste(&spec, &driver)
									.await
									.map_err(oauth_error)?;
								let input = driver.receive().await.map_err(login_channel_error)?;
								engine
									.complete_paste(&spec, input)
									.await
									.map_err(oauth_error)?
							},
							AuthSpec::OAuthDevice(spec) if method == AuthMethod::OAuthDevice => {
								let pending = engine
									.begin_device(&spec, &driver)
									.await
									.map_err(oauth_error)?;
								engine
									.poll_device(&spec, pending, &driver)
									.await
									.map_err(oauth_error)?
							},
							AuthSpec::OAuthCustom(spec) => custom
								.exchange(&spec, &driver)
								.await
								.map_err(oauth_custom_error)?,
							_ => return Err(auth_unavailable()),
						};
						let principal = tokens
							.resolve_principal(&resolution, &request_http)
							.await
							.map_err(oauth_error)?;
						let residency = tokens.codex_residency().map(RegionId::new);
						let project = tokens.project().map(ToOwned::to_owned);
						let account = AccountId::from(format!("{provider_id}:{principal}"));
						let issued_at = clock.now();
						let meta = LeaseMeta {
							account:    account.clone(),
							principal:  principal.clone(),
							generation: 0,
							expires_at: None,
						};
						let freshness = engine
							.persist_login(&store, tokens, &meta, CredentialOrigin::Persistent, issued_at)
							.map_err(oauth_manager_error)?;
						accounts
							.upsert(AccountRecord {
								account: account.clone(),
								principal: principal.clone(),
								provider: provider_id.clone(),
								routes,
								enabled: true,
								credential_generation: freshness.generation,
								routing: AccountRoutingContext {
									project,
									region: residency,
									..AccountRoutingContext::default()
								},
							})
							.map_err(|_| auth_store_failure())?;
						let summary = AccountSummary {
							account,
							provider: provider_id,
							principal: Some(principal.clone()),
							label: Some(Str::new(principal.as_str())),
							state: AccountState::Active,
						};
						driver
							.emit(AuthEvent::Complete(summary))
							.await
							.map_err(login_channel_error)
					};
					tokio::pin!(flow);
					tokio::select! {
						biased;
						() = cancellation.cancelled() => Err(oauth_error(OAuthError::Cancelled)),
						result = &mut flow => result,
					}
				};
				if let Err(error) = result {
					let _ = driver.emit_error(error).await;
				}
			});
			Ok(session)
		}
		.boxed()
	}
}

enum OAuthRefreshRuntime {
	Standard(OAuthClientSpec),
	Custom(OAuthCustomSpec),
}

/// Credential source that refreshes renewable stored credentials during
/// ordinary acquisition.
///
/// Expiry is evaluated with a 60-second pre-expiry skew. Refresh uses the
/// installed refresh engine's in-process and persistent single-flight
/// coordinator, then acquisition is replayed exactly once.
#[derive(Clone)]
pub struct RefreshingCredentialSource {
	stored:  Arc<dyn CredentialSource>,
	refresh: Arc<dyn AuthRefreshEngine>,
	skew:    time::Duration,
}

impl RefreshingCredentialSource {
	/// Wraps a stored credential source with routine OAuth refresh.
	pub fn new(stored: Arc<dyn CredentialSource>, refresh: Arc<dyn AuthRefreshEngine>) -> Self {
		Self { stored, refresh, skew: time::Duration::from_secs(60) }
	}

	#[cfg(test)]
	fn with_skew(
		stored: Arc<dyn CredentialSource>,
		refresh: Arc<dyn AuthRefreshEngine>,
		skew: time::Duration,
	) -> Self {
		Self { stored, refresh, skew }
	}

	fn apply_skew(&self, need: &mut CredentialNeed) {
		let now = SystemTime::now();
		let refresh_after = now.checked_add(self.skew).unwrap_or(now);
		if need.valid_after < refresh_after {
			need.valid_after = refresh_after;
		}
	}
}

impl fmt::Debug for RefreshingCredentialSource {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("RefreshingCredentialSource")
			.field("skew", &self.skew)
			.finish_non_exhaustive()
	}
}

impl RefreshingCredentialSource {
	/// Refreshes `account` through the engine, then leases the new
	/// generation once. This is the only path that performs I/O.
	fn refresh_then_lease(
		&self,
		account: AccountId,
		need: CredentialNeed,
	) -> CredentialFuture<'_, Result<CredentialLease, CredentialError>> {
		let stored = Arc::clone(&self.stored);
		let refresh = Arc::clone(&self.refresh);
		Either::Right(
			async move {
				refresh
					.refresh(account)
					.await
					.map_err(|_| CredentialError::SourceFailure)?;
				stored.lease(need).await
			}
			.boxed(),
		)
	}
}

impl CredentialSource for RefreshingCredentialSource {
	/// A stored lease that is still fresh is answered without allocating;
	/// only an expired generation boxes the refresh round trip.
	fn lease(
		&self,
		mut need: CredentialNeed,
	) -> CredentialFuture<'_, Result<CredentialLease, CredentialError>> {
		self.apply_skew(&mut need);
		let Some(account) = need.account.clone() else {
			return credential_ready(Err(CredentialError::Unavailable));
		};
		match self.stored.lease(need.clone()) {
			Either::Left(ready) => match ready.into_inner() {
				Err(CredentialError::Expired) => self.refresh_then_lease(account, need),
				result => credential_ready(result),
			},
			Either::Right(pending) => {
				let stored = Arc::clone(&self.stored);
				let refresh = Arc::clone(&self.refresh);
				Either::Right(
					async move {
						match pending.await {
							Err(CredentialError::Expired) => {
								refresh
									.refresh(account)
									.await
									.map_err(|_| CredentialError::SourceFailure)?;
								stored.lease(need).await
							},
							result => result,
						}
					}
					.boxed(),
				)
			},
		}
	}

	fn refresh_lease(
		&self,
		mut need: CredentialNeed,
	) -> CredentialFuture<'_, Result<CredentialLease, CredentialError>> {
		self.apply_skew(&mut need);
		let Some(account) = need.account.clone() else {
			return credential_ready(Err(CredentialError::Unavailable));
		};
		self.refresh_then_lease(account, need)
	}

	fn reject<'a>(
		&'a self,
		lease: &'a CredentialLease,
		evidence: AuthRejection,
	) -> CredentialFuture<'a, Result<(), CredentialError>> {
		self.stored.reject(lease, evidence)
	}
}

/// Owned refresh adapter for encrypted OAuth credentials.
pub struct StoredOAuthRefreshEngine<C, K> {
	catalog:     Arc<Catalog>,
	store:       Arc<CredentialStore>,
	accounts:    AccountPool,
	http:        Arc<C>,
	clock:       Arc<K>,
	custom:      Arc<OAuthCustomDispatcher>,
	coordinator: Arc<RefreshCoordinator>,
	hooks:       Arc<Mutex<ProviderResponseHooks>>,
}

impl<C, K> StoredOAuthRefreshEngine<C, K> {
	/// Constructs an OAuth refresh adapter over one shared coordinator.
	pub fn new(
		catalog: Arc<Catalog>,
		store: Arc<CredentialStore>,
		accounts: AccountPool,
		http: Arc<C>,
		clock: Arc<K>,
		custom: Arc<OAuthCustomDispatcher>,
		coordinator: Arc<RefreshCoordinator>,
	) -> Self {
		Self {
			catalog,
			store,
			accounts,
			http,
			clock,
			custom,
			coordinator,
			hooks: Arc::new(Mutex::new(ProviderResponseHooks::default())),
		}
	}
}

impl<C, K> AuthRefreshEngine for StoredOAuthRefreshEngine<C, K>
where
	C: OAuthHttpClient + 'static,
	K: OAuthClock + 'static,
{
	fn refresh(&self, account: AccountId) -> BoxFuture<'_, Result<AccountSummary, Error>> {
		let catalog = Arc::clone(&self.catalog);
		let store = Arc::clone(&self.store);
		let accounts = self.accounts.clone();
		let http = Arc::clone(&self.http);
		let clock = Arc::clone(&self.clock);
		let custom = Arc::clone(&self.custom);
		let coordinator = Arc::clone(&self.coordinator);
		let hooks = self.hooks.lock().clone();
		async move {
			let record = accounts.account(&account).ok_or_else(auth_not_found)?;
			let provider = catalog
				.provider(&record.provider)
				.ok_or_else(auth_not_found)?;
			if hooks.provider_refresh_subscribed(&record.provider) {
				let metadata = store
					.metadata(&account)
					.map_err(|_| auth_store_failure())?
					.ok_or_else(auth_not_found)?;
				if metadata.principal_id != record.principal {
					return Err(auth_store_failure());
				}
				let requested_at = clock.now();
				let expires_at = metadata
					.expires_at_ms
					.map(system_time_from_millis)
					.transpose()?;
				let request = RefreshRequest {
					account: account.clone(),
					principal: record.principal.clone(),
					rejected: CredentialFreshness {
						generation: metadata.generation,
						issued_at: Some(system_time_from_millis(metadata.updated_at_ms)?),
						expires_at,
						observed_at: requested_at,
					},
					requested_at,
				};
				let outcome = match OAuthEngine::new(http.as_ref(), clock.as_ref())
					.refresh_extension_persisted(
						&coordinator,
						Arc::clone(&store),
						hooks.clone(),
						record.provider.clone(),
						Some(Str::from(record.principal.as_str())),
						request,
						ProviderRefreshReason::Expiring,
						CredentialOrigin::Persistent,
					)
					.await
				{
					Ok(outcome) => outcome,
					Err(error) => {
						let _ = accounts.set_enabled(&account, false);
						if hooks.credential_disabled_subscribed() {
							hooks.observe_credential_disabled(CredentialDisabledObservation {
								provider: record.provider.clone(),
								account:  Some(account.clone()),
								cause:    sf!("provider_refresh"),
							});
						}
						return Err(oauth_manager_error(error));
					},
				};
				if !accounts
					.update_credential_generation(
						&account,
						&record.principal,
						outcome.result.freshness.generation,
					)
					.map_err(|_| auth_store_failure())?
				{
					return Err(auth_store_failure());
				}
				return Ok(AccountSummary {
					account,
					provider: record.provider,
					principal: Some(record.principal),
					label: None,
					state: AccountState::Active,
				});
			}
			let mut runtime = None;
			for id in &provider.auth {
				let auth = catalog.auth_spec(id).ok_or_else(auth_not_found)?;
				if auth.kind != AuthSpecKind::Oauth {
					continue;
				}
				let oauth_id = auth.oauth.as_ref().ok_or_else(auth_unavailable)?;
				let oauth = catalog.oauth_spec(oauth_id).ok_or_else(auth_unavailable)?;
				let candidate =
					AuthSpec::from_catalog(auth, Some(oauth), None).map_err(|_| auth_unavailable())?;
				runtime = match candidate {
					AuthSpec::OAuthCustom(spec) => Some(OAuthRefreshRuntime::Custom(spec)),
					candidate => oauth_client(&candidate).map(OAuthRefreshRuntime::Standard),
				};
				if runtime.is_some() {
					break;
				}
			}
			let runtime = runtime.ok_or_else(auth_unavailable)?;
			let metadata = store
				.metadata(&account)
				.map_err(|_| auth_store_failure())?
				.ok_or_else(auth_not_found)?;
			if metadata.principal_id != record.principal {
				return Err(auth_store_failure());
			}
			let requested_at = clock.now();
			let expires_at = metadata
				.expires_at_ms
				.map(system_time_from_millis)
				.transpose()?;
			let engine = OAuthEngine::new(http.as_ref(), clock.as_ref());
			let request = RefreshRequest {
				account: account.clone(),
				principal: record.principal.clone(),
				rejected: CredentialFreshness {
					generation: metadata.generation,
					issued_at: Some(system_time_from_millis(metadata.updated_at_ms)?),
					expires_at,
					observed_at: requested_at,
				},
				requested_at,
			};
			let outcome = match runtime {
				OAuthRefreshRuntime::Standard(client) => {
					engine
						.refresh_persisted(
							&coordinator,
							Arc::clone(&store),
							client,
							request,
							CredentialOrigin::Persistent,
						)
						.await
				},
				OAuthRefreshRuntime::Custom(spec) => {
					engine
						.refresh_custom_persisted(
							&coordinator,
							Arc::clone(&store),
							custom,
							spec,
							request,
							CredentialOrigin::Persistent,
						)
						.await
				},
			}
			.map_err(oauth_manager_error)?;
			if !accounts
				.update_credential_generation(
					&account,
					&record.principal,
					outcome.result.freshness.generation,
				)
				.map_err(|_| auth_store_failure())?
			{
				return Err(auth_store_failure());
			}
			Ok(AccountSummary {
				account,
				provider: record.provider,
				principal: Some(record.principal),
				label: None,
				state: AccountState::Active,
			})
		}
		.boxed()
	}

	fn bind_provider_hooks(&self, hooks: ProviderResponseHooks) {
		*self.hooks.lock() = hooks;
	}
}

/// Typed failure constructing a complete direct authentication service.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AuthManagerBuildError {
	/// The catalog advertises a login method with no constructed engine.
	#[error("catalog authentication method has no constructed login engine")]
	MissingLoginEngine(AuthMethod),
	/// A provider references an authentication specification absent from the
	/// catalog.
	#[error("provider references an unknown authentication specification")]
	UnknownAuthSpec(AuthSpecId),
}

/// Opaque Codex OAuth generation leased for one realtime live connection.
///
/// The bearer remains private to inference. Callers can only request a
/// sensitive `Authorization` header and inspect non-secret account identity.
#[derive(Clone)]
pub struct CodexLiveCredential {
	lease:      CredentialLease,
	account_id: Option<Str>,
}

impl CodexLiveCredential {
	/// Builds the sensitive bearer header consumed by Codex signaling and
	/// sideband handshakes.
	pub fn authorization_header(&self) -> Result<HeaderValue, CodexLiveCredentialError> {
		let token = self
			.lease
			.scalar_secret()
			.ok_or(CodexLiveCredentialError::WrongCredentialKind)?;
		let mut bearer =
			Zeroizing::new(String::with_capacity("Bearer ".len() + token.expose_secret().len()));
		bearer.push_str("Bearer ");
		bearer.push_str(token.expose_secret());
		let mut value = HeaderValue::from_str(&bearer)
			.map_err(|source| CodexLiveCredentialError::InvalidAuthorization { source })?;
		value.set_sensitive(true);
		Ok(value)
	}

	/// Provider-issued `ChatGPT` account identity recovered from the OAuth JWT.
	#[must_use]
	pub const fn account_id(&self) -> Option<&Str> {
		self.account_id.as_ref()
	}
}

impl fmt::Debug for CodexLiveCredential {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("CodexLiveCredential")
			.field("account", &self.lease.meta().account)
			.field("generation", &self.lease.meta().generation)
			.field("account_id", &self.account_id)
			.field("authorization", &"[REDACTED]")
			.finish()
	}
}

/// Failure to lease or represent the shared Codex OAuth generation.
#[derive(Debug, thiserror::Error)]
pub enum CodexLiveCredentialError {
	/// The compiled Codex provider is absent.
	#[error("the openai-codex provider is unavailable")]
	ProviderUnavailable,
	/// The compiled provider has no authentication specification.
	#[error("the openai-codex provider has no authentication specification")]
	AuthSpecUnavailable,
	/// No enabled Codex account is available.
	#[error("no enabled Codex OAuth account is available")]
	AccountUnavailable,
	/// Credential acquisition failed.
	#[error(transparent)]
	Credential {
		/// Typed credential source failure.
		#[from]
		source: CredentialError,
	},
	/// The selected credential was not a bearer generation.
	#[error("the selected Codex credential is not an OAuth bearer")]
	WrongCredentialKind,
	/// Bearer bytes could not be represented as an HTTP header.
	#[error("the Codex OAuth bearer is not a valid HTTP authorization value")]
	InvalidAuthorization {
		/// Typed HTTP header source.
		#[source]
		source: http::header::InvalidHeaderValue,
	},
}

/// Direct, route-independent authentication and account-management service.
#[derive(Clone)]
struct AuthSessionControl {
	responses:    Sender<AuthResponse>,
	cancellation: super::LoginCancellation,
}

/// Direct, route-independent authentication and account-management service.
///
/// Login engine selection is derived exclusively from typed catalog records.
/// Secret inputs move through bounded session channels and are never retained
/// by the manager. List, refresh, and logout bypass model routing and wire
/// codecs.
#[derive(Clone)]
pub struct AuthManager {
	catalog:        Arc<Catalog>,
	store:          Arc<CredentialStore>,
	broker:         CredentialBroker,
	accounts:       AccountPool,
	affinity:       Option<CredentialAffinityResolver>,
	login:          Arc<BTreeMap<AuthMethodKey, Vec<Arc<dyn AuthLoginEngine>>>>,
	refresh:        Arc<dyn AuthRefreshEngine>,
	sessions:       Arc<Mutex<BTreeMap<LoginSessionId, AuthSessionControl>>>,
	provider_hooks: Arc<Mutex<ProviderResponseHooks>>,
}

impl AuthManager {
	/// Constructs a complete manager, preserving registration order among
	/// engines for the same public method.
	pub fn new(
		catalog: Arc<Catalog>,
		store: Arc<CredentialStore>,
		broker: CredentialBroker,
		accounts: AccountPool,
		login_engines: Vec<Arc<dyn AuthLoginEngine>>,
		refresh: Arc<dyn AuthRefreshEngine>,
	) -> Result<Self, AuthManagerBuildError> {
		let mut login: BTreeMap<AuthMethodKey, Vec<Arc<dyn AuthLoginEngine>>> = BTreeMap::new();
		for engine in login_engines {
			login
				.entry(AuthMethodKey::from(engine.method()))
				.or_default()
				.push(engine);
		}
		let required = required_login_methods(&catalog)?;
		for method in required {
			if !login.contains_key(&method) {
				return Err(AuthManagerBuildError::MissingLoginEngine(method.into()));
			}
		}
		Ok(Self {
			catalog,
			store,
			broker,
			accounts,
			affinity: None,
			login: Arc::new(login),
			refresh,
			sessions: Arc::new(Mutex::new(BTreeMap::new())),
			provider_hooks: Arc::new(Mutex::new(ProviderResponseHooks::default())),
		})
	}

	/// Returns a narrow clone-cheap handle for authenticated lifecycle CONTROL.
	pub fn control_handle(&self) -> AuthControlHandle {
		AuthControlHandle { manager: self.clone() }
	}

	/// Binds the session-owned provider hook sink to credential lifecycle
	/// events.
	pub fn bind_provider_hooks(&self, hooks: ProviderResponseHooks) {
		*self.provider_hooks.lock() = hooks.clone();
		self.refresh.bind_provider_hooks(hooks);
	}

	/// Installs the credential-authority-owned opaque affinity resolver.
	pub fn with_affinity_resolver(mut self, resolver: CredentialAffinityResolver) -> Self {
		self.affinity = Some(resolver);
		self
	}

	/// Resolves a restored journal digest to one exact live account.
	///
	/// # Errors
	/// Returns `NotFound` when no resolver was installed or no live account
	/// matches, and `Ambiguous` when identity evidence is not unique.
	pub fn resolve_affinity(
		&self,
		provider: &omp_catalog::ProviderId<str>,
		affinity: &CredentialAffinityDigest,
	) -> Result<AccountRecord, CredentialAffinityError> {
		self
			.affinity
			.as_ref()
			.ok_or(CredentialAffinityError::NotFound)?
			.resolve(&self.accounts, provider, affinity)
	}

	/// Executes one route-independent authentication operation.
	pub async fn execute(&self, request: AuthRequest) -> Result<AuthAnswer, Error> {
		match request {
			AuthRequest::Login(request) => self.login(request).await,
			AuthRequest::Submit { session, input } => {
				let control = self
					.sessions
					.lock()
					.get(&session)
					.cloned()
					.ok_or_else(auth_not_found)?;
				if matches!(input, crate::call::AuthInput::Cancel) {
					control.cancellation.cancel();
					self.sessions.lock().remove(&session);
					return Ok(AuthAnswer::Submitted(session));
				}
				if control
					.responses
					.send_async(AuthResponse { session: session.clone(), input })
					.await
					.is_err()
				{
					self.sessions.lock().remove(&session);
					return Err(auth_not_found());
				}
				Ok(AuthAnswer::Submitted(session))
			},
			AuthRequest::ListAccounts { provider } => {
				let accounts = self
					.accounts
					.accounts()
					.into_iter()
					.filter(|record| {
						provider
							.as_ref()
							.is_none_or(|provider| provider == &record.provider)
					})
					.map(|record| AccountSummary {
						account:   record.account,
						provider:  record.provider,
						principal: Some(record.principal),
						label:     None,
						state:     if record.enabled {
							AccountState::Active
						} else {
							AccountState::Disabled
						},
					})
					.collect();
				Ok(AuthAnswer::Accounts(accounts))
			},
			AuthRequest::Refresh { account } => self
				.refresh
				.refresh(account)
				.await
				.map(AuthAnswer::Refreshed),
			AuthRequest::Logout { account } => {
				let stored = self
					.store
					.delete(&account)
					.map_err(|_| auth_store_failure())?;
				let pooled = self.accounts.remove(&account).is_some();
				if !stored && !pooled {
					return Err(auth_not_found());
				}
				Ok(AuthAnswer::LoggedOut(account))
			},
		}
	}

	/// Returns the shared catalog-aware credential source used by route
	/// execution.
	pub const fn credential_broker(&self) -> &CredentialBroker {
		&self.broker
	}

	/// Leases the same renewable Codex OAuth generation used by normal
	/// inference routes for one realtime live connection.
	pub async fn lease_codex_live(&self) -> Result<CodexLiveCredential, CodexLiveCredentialError> {
		self.codex_live_credential(None).await
	}

	/// Forces the exact renewable source behind `rejected` to issue a fresh
	/// generation for a retried live signaling request.
	pub async fn refresh_codex_live(
		&self,
		rejected: &CodexLiveCredential,
	) -> Result<CodexLiveCredential, CodexLiveCredentialError> {
		self.codex_live_credential(Some(&rejected.lease)).await
	}

	async fn codex_live_credential(
		&self,
		rejected: Option<&CredentialLease>,
	) -> Result<CodexLiveCredential, CodexLiveCredentialError> {
		let provider_id = ProviderId::from("openai-codex");
		let provider = self
			.catalog
			.provider(&provider_id)
			.ok_or(CodexLiveCredentialError::ProviderUnavailable)?;
		let spec = provider
			.auth
			.first()
			.cloned()
			.ok_or(CodexLiveCredentialError::AuthSpecUnavailable)?;
		let account = self
			.accounts
			.accounts()
			.into_iter()
			.find(|record| record.enabled && record.provider == provider_id)
			.ok_or(CodexLiveCredentialError::AccountUnavailable)?;
		let need = CredentialNeed {
			spec,
			account: Some(account.account),
			principal: Some(account.principal),
			valid_after: SystemTime::now() + time::Duration::from_secs(30),
		};
		let lease = if let Some(rejected) = rejected {
			self.broker.refresh_lease(rejected, need).await?
		} else {
			self.broker.lease(need).await?
		};
		if lease.kind() != super::CredentialKind::Bearer {
			return Err(CodexLiveCredentialError::WrongCredentialKind);
		}
		let token = lease
			.scalar_secret()
			.ok_or(CodexLiveCredentialError::WrongCredentialKind)?;
		let (account_id, _) =
			crate::operation::usage::openai_codex::parse_codex_jwt_identity(token.expose_secret());
		Ok(CodexLiveCredential { lease, account_id })
	}

	/// Rejects one live OAuth generation through the canonical refresh and
	/// account-rotation authority.
	pub async fn reject_codex_live(
		&self,
		credential: &CodexLiveCredential,
		status: u16,
	) -> Result<(), CredentialError> {
		self
			.broker
			.reject(&credential.lease, AuthRejection {
				kind:        if status == 401 {
					super::AuthRejectionKind::Invalid
				} else {
					super::AuthRejectionKind::Unauthorized
				},
				status:      Some(status),
				code:        None,
				refreshable: status == 401,
			})
			.await
	}

	async fn login(&self, request: LoginRequest) -> Result<AuthAnswer, Error> {
		let provider = self
			.catalog
			.provider(&request.provider)
			.ok_or_else(auth_not_found)?;
		let (spec, method) = select_auth_spec(&self.catalog, &provider.auth, request.method)?
			.ok_or_else(auth_not_found)?;
		let hooks = self.provider_hooks.lock().clone();
		if hooks.provider_login_subscribed(&request.provider) {
			let credential = hooks
				.provider_login(crate::codec::ProviderLoginHookRequest {
					provider: request.provider.clone(),
					method,
				})
				.await
				.map_err(|_| auth_unavailable())?;
			let identity = credential
				.identity
				.clone()
				.unwrap_or_else(|| sf!("extension"));
			let principal = PrincipalId::from(identity.as_str());
			let summary = if credential.kind.as_str() == "oauth" {
				let refresh_token = credential.refresh_token.ok_or_else(auth_unavailable)?;
				let (_, record) = self
					.control_handle()
					.import_oauth(OAuthControlImport {
						provider: request.provider.clone(),
						principal,
						identity: credential.identity,
						access_token: Some(credential.secret),
						refresh_token,
						expires_at_ms: credential.expires_at_ms,
					})
					.map_err(auth_store_error)?;
				AccountSummary {
					account:   record.account,
					provider:  record.provider,
					principal: Some(record.principal),
					label:     None,
					state:     AccountState::Active,
				}
			} else {
				let secret = credential.secret.expose_secret().as_bytes().to_vec();
				let (_, record) = self
					.control_handle()
					.store(CredentialControlWrite {
						provider: request.provider.clone(),
						principal,
						identity: credential.identity,
						kind: credential.kind,
						secret: Secret::from(secret),
						expires_at_ms: credential.expires_at_ms,
					})
					.map_err(auth_store_error)?;
				AccountSummary {
					account:   record.account,
					provider:  record.provider,
					principal: Some(record.principal),
					label:     None,
					state:     AccountState::Active,
				}
			};
			return Ok(AuthAnswer::Refreshed(summary));
		}
		let engines = self
			.login
			.get(&AuthMethodKey::from(method))
			.ok_or_else(auth_unavailable)?;
		let engine = select_login_engine(engines, &request.provider).ok_or_else(auth_unavailable)?;
		let session = engine.begin(request, spec).await?;
		self
			.sessions
			.lock()
			.insert(session.id.clone(), AuthSessionControl {
				responses:    session.responses.clone(),
				cancellation: session.cancellation.clone(),
			});
		let sessions = Arc::downgrade(&self.sessions);
		let session_id = session.id.clone();
		tokio::spawn(async move {
			tokio::time::sleep(LOGIN_SESSION_TTL).await;
			if let Some(sessions) = sessions.upgrade()
				&& let Some(control) = sessions.lock().remove(&session_id)
			{
				control.cancellation.cancel();
			}
		});
		Ok(AuthAnswer::Session(session))
	}
}

impl fmt::Debug for AuthManager {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("AuthManager")
			.field("login_engines", &self.login.keys())
			.field("active_sessions", &self.sessions.lock().len())
			.field("credential_broker", &self.broker)
			.finish_non_exhaustive()
	}
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum AuthMethodKey {
	ApiKey,
	OAuthPkce,
	OAuthDevice,
	ApplicationDefault,
	AwsCredentialChain,
	SessionToken,
}

impl From<AuthMethod> for AuthMethodKey {
	fn from(method: AuthMethod) -> Self {
		match method {
			AuthMethod::ApiKey => Self::ApiKey,
			AuthMethod::OAuthPkce => Self::OAuthPkce,
			AuthMethod::OAuthDevice => Self::OAuthDevice,
			AuthMethod::ApplicationDefault => Self::ApplicationDefault,
			AuthMethod::AwsCredentialChain => Self::AwsCredentialChain,
			AuthMethod::SessionToken => Self::SessionToken,
		}
	}
}

fn select_auth_spec(
	catalog: &Catalog,
	auth: &[AuthSpecId],
	requested: Option<AuthMethod>,
) -> Result<Option<(AuthSpecId, AuthMethod)>, Error> {
	let mut fallback = None;
	for id in auth {
		let spec = catalog.auth_spec(id).ok_or_else(auth_not_found)?;
		let method = auth_method(catalog, spec)?;
		if let Some(requested) = requested {
			if requested == method {
				return Ok(Some((id.to_owned(), method)));
			}
		} else {
			fallback.get_or_insert_with(|| (id.to_owned(), method));
			if matches!(method, AuthMethod::OAuthPkce | AuthMethod::OAuthDevice) {
				return Ok(Some((id.to_owned(), method)));
			}
		}
	}
	Ok(fallback)
}

impl From<AuthMethodKey> for AuthMethod {
	fn from(method: AuthMethodKey) -> Self {
		match method {
			AuthMethodKey::ApiKey => Self::ApiKey,
			AuthMethodKey::OAuthPkce => Self::OAuthPkce,
			AuthMethodKey::OAuthDevice => Self::OAuthDevice,
			AuthMethodKey::ApplicationDefault => Self::ApplicationDefault,
			AuthMethodKey::AwsCredentialChain => Self::AwsCredentialChain,
			AuthMethodKey::SessionToken => Self::SessionToken,
		}
	}
}

fn required_login_methods(
	catalog: &Catalog,
) -> Result<BTreeSet<AuthMethodKey>, AuthManagerBuildError> {
	let mut required = BTreeSet::new();
	for provider in catalog.providers() {
		for id in &provider.auth {
			let spec = catalog
				.auth_spec(id)
				.ok_or_else(|| AuthManagerBuildError::UnknownAuthSpec(id.clone()))?;
			if spec.kind == AuthSpecKind::None {
				continue;
			}
			if spec.kind == AuthSpecKind::Basic {
				// RFC 7617 pairs are leased from declared environment names; no
				// interactive login engine exists or is required.
				continue;
			}
			required.insert(AuthMethodKey::from(
				auth_method(catalog, spec)
					.map_err(|_| AuthManagerBuildError::UnknownAuthSpec(id.clone()))?,
			));
		}
	}
	Ok(required)
}
fn select_login_engine<'a>(
	engines: &'a [Arc<dyn AuthLoginEngine>],
	provider: &omp_catalog::ProviderId<str>,
) -> Option<&'a Arc<dyn AuthLoginEngine>> {
	engines.iter().find(|engine| engine.supports(provider))
}

fn auth_method(
	catalog: &Catalog,
	spec: &omp_catalog::provider::AuthSpec,
) -> Result<AuthMethod, Error> {
	match spec.kind {
		AuthSpecKind::None => Err(auth_unavailable()),
		AuthSpecKind::ApiKey | AuthSpecKind::Bearer | AuthSpecKind::OptionalBearer => {
			Ok(AuthMethod::ApiKey)
		},
		AuthSpecKind::Basic => Err(auth_unavailable()),
		AuthSpecKind::AzureAd | AuthSpecKind::GithubApp => Ok(AuthMethod::SessionToken),
		AuthSpecKind::GcpAdc => Ok(AuthMethod::ApplicationDefault),
		AuthSpecKind::AwsSigv4 => Ok(AuthMethod::AwsCredentialChain),
		AuthSpecKind::OmpSession => Ok(AuthMethod::SessionToken),
		AuthSpecKind::Oauth => {
			let id = spec.oauth.as_ref().ok_or_else(auth_unavailable)?;
			let oauth = catalog.oauth_spec(id).ok_or_else(auth_unavailable)?;
			Ok(match &oauth.flow {
				OAuthFlowSpec::DeviceCode { .. } => AuthMethod::OAuthDevice,
				OAuthFlowSpec::Pkce { .. } | OAuthFlowSpec::Paste { .. } => AuthMethod::OAuthPkce,
				OAuthFlowSpec::Custom { polling: Some(_), .. } => AuthMethod::OAuthDevice,
				OAuthFlowSpec::Custom { polling: None, .. } => AuthMethod::OAuthPkce,
			})
		},
	}
}

fn auth_not_found() -> Error {
	Error::new(
		ErrorKind::TargetNotFound,
		ErrorPhase::Authentication,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
}

fn auth_unavailable() -> Error {
	Error::new(
		ErrorKind::Authentication,
		ErrorPhase::Authentication,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
}

fn auth_store_failure() -> Error {
	Error::new(
		ErrorKind::InternalInvariant,
		ErrorPhase::Authentication,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
}

fn auth_store_error(error: StoreError) -> Error {
	if matches!(error, StoreError::Key(KeyError::Unavailable | KeyError::OsCredential)) {
		Error::new(
			ErrorKind::CredentialStorageUnavailable,
			ErrorPhase::Authentication,
			RetryAction::Never,
			ExecutionReceipt::default(),
		)
	} else {
		auth_store_failure()
	}
}

static LOGIN_SESSION_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const LOGIN_SESSION_TTL: time::Duration = time::Duration::from_hours(1);

fn next_login_session_id() -> LoginSessionId {
	let sequence = LOGIN_SESSION_SEQUENCE.fetch_add(1, Ordering::Relaxed);
	LoginSessionId::from(format!("auth-{sequence}"))
}

fn unix_millis(time: SystemTime) -> Result<u64, Error> {
	let millis = time
		.duration_since(UNIX_EPOCH)
		.map_err(|_| auth_store_failure())?
		.as_millis();
	u64::try_from(millis).map_err(|_| auth_store_failure())
}

fn login_channel_error(error: LoginChannelError) -> Error {
	match error {
		LoginChannelError::Cancelled => Error::new(
			ErrorKind::Cancelled,
			ErrorPhase::Authentication,
			RetryAction::Never,
			ExecutionReceipt::default(),
		),
		_ => auth_unavailable(),
	}
}

fn auth_invalid_request() -> Error {
	Error::new(
		ErrorKind::InvalidRequest,
		ErrorPhase::Authentication,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
}

fn oauth_client(spec: &AuthSpec) -> Option<OAuthClientSpec> {
	match spec {
		AuthSpec::OAuthPkce(spec) => Some(spec.client.clone()),
		AuthSpec::OAuthDevice(spec) => Some(spec.client.clone()),
		AuthSpec::OAuthPaste(spec) => Some(spec.client.clone()),
		AuthSpec::OAuthCustom(spec) => Some(spec.client.clone()),
		_ => None,
	}
}

fn system_time_from_millis(millis: u64) -> Result<SystemTime, Error> {
	UNIX_EPOCH
		.checked_add(time::Duration::from_millis(millis))
		.ok_or_else(auth_store_failure)
}

fn principal_unresolved() -> Error {
	Error::new(
		ErrorKind::Authentication,
		ErrorPhase::Authentication,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
}

fn oauth_error(error: OAuthError) -> Error {
	let detail = ErrorDetail::provider(Str::new(error.to_string()));
	match error {
		OAuthError::Cancelled => Error::new(
			ErrorKind::Cancelled,
			ErrorPhase::Authentication,
			RetryAction::Never,
			ExecutionReceipt::default(),
		),
		OAuthError::PrincipalUnresolved => principal_unresolved().detail(detail),
		OAuthError::Provider { status, code, .. } => auth_unavailable()
			.status(Some(status))
			.code(Str::new(code.as_str()))
			.detail(detail),
		OAuthError::ProvisioningRejected { status } => {
			auth_unavailable().status(Some(status)).detail(detail)
		},
		_ => auth_unavailable().detail(detail),
	}
}

fn oauth_custom_error(error: OAuthCustomDispatchError) -> Error {
	match error {
		OAuthCustomDispatchError::Protocol(error) => oauth_error(error),
		OAuthCustomDispatchError::Duplicate(_) | OAuthCustomDispatchError::Unavailable(_) => {
			auth_unavailable()
		},
	}
}

fn oauth_manager_error(error: OAuthCredentialManagerError) -> Error {
	match error {
		OAuthCredentialManagerError::OAuth(error) => oauth_error(*error),
		OAuthCredentialManagerError::Refresh(_) => auth_unavailable(),
		OAuthCredentialManagerError::Expired => Error::new(
			ErrorKind::Authentication,
			ErrorPhase::Authentication,
			RetryAction::RefreshCredential,
			ExecutionReceipt::default(),
		),
		OAuthCredentialManagerError::Store(error) => auth_store_error(*error),
		OAuthCredentialManagerError::InvalidTime => auth_store_failure(),
	}
}

fn credential_error(error: CredentialError) -> Error {
	match error {
		CredentialError::Cancelled => Error::new(
			ErrorKind::Cancelled,
			ErrorPhase::Authentication,
			RetryAction::Never,
			ExecutionReceipt::default(),
		),
		CredentialError::Expired => Error::new(
			ErrorKind::Authentication,
			ErrorPhase::Authentication,
			RetryAction::RefreshCredential,
			ExecutionReceipt::default(),
		),
		CredentialError::Unavailable
		| CredentialError::StaleGeneration
		| CredentialError::InvalidSource
		| CredentialError::SourceFailure => auth_unavailable(),
	}
}
#[cfg(test)]
mod tests {
	use std::{
		collections::{BTreeSet, VecDeque},
		env, fs,
		sync::{
			Arc,
			atomic::{AtomicUsize, Ordering},
		},
		time::{Duration, SystemTime, UNIX_EPOCH},
	};

	use futures::future::{BoxFuture, FutureExt as _};
	use http::HeaderMap;
	use omp_catalog::{ProviderId, provider::AuthSpecKind, snapshot::Catalog};
	use omp_core::{ExposeSecret as _, SecretString};
	use parking_lot::Mutex;
	use tokio::time;

	use super::{
		AuthLoginEngine, AuthRefreshEngine, CredentialAffinityError, CredentialAffinityResolver,
		OAuthLoginEngine, RefreshingCredentialSource, StoredOAuthRefreshEngine, auth_method,
		auth_store_error, select_auth_spec, select_login_engine,
	};
	use crate::{
		account::{AccountPool, AccountRecord, RefreshCoordinator, RefreshPolicy},
		answer::{AccountState, AccountSummary, AuthEvent, AuthResponse as AnswerAuthResponse},
		auth::{
			AlibabaTokenPlanLoginEngine, AuthRejection, CredentialError, CredentialFuture,
			CredentialLease, CredentialNeed, CredentialSource, CredentialStore, HeadlessKeySource,
			KeyError, KeyId, LeaseMeta, OAuthClock, OAuthCustomDispatcher, OAuthHttpClient,
			OAuthHttpRequest, OAuthHttpResponse, OAuthTransportError, SecretLoginEngine, StoreError,
			credential_ready,
		},
		call::{AccountRoutingContext, AuthInput, AuthMethod, LoginRequest},
		error::{Error, ErrorKind},
		id::{AccountId, PrincipalId},
	};

	#[test]
	fn credential_affinity_restores_without_persisting_identity() {
		let pool = AccountPool::new();
		let provider = ProviderId::from("provider");
		let account = AccountRecord {
			account:               AccountId::from("raw-account-uuid"),
			principal:             PrincipalId::from("person@example.test"),
			provider:              provider.clone(),
			routes:                BTreeSet::new(),
			enabled:               true,
			credential_generation: 1,
			routing:               AccountRoutingContext::default(),
		};
		pool.upsert(account.clone()).expect("register account");
		let resolver = CredentialAffinityResolver::new([7; 32]);
		let digest = resolver.digest(&account);
		assert!(!digest.as_str().contains(account.account.as_str()));
		assert!(!digest.as_str().contains(account.principal.as_str()));
		assert_eq!(resolver.resolve(&pool, &provider, &digest).unwrap(), account);
		assert_eq!(
			CredentialAffinityResolver::new([8; 32]).resolve(&pool, &provider, &digest),
			Err(CredentialAffinityError::NotFound)
		);
	}

	#[test]
	fn unavailable_credential_key_has_distinct_error_kind() {
		let error = auth_store_error(StoreError::Key(KeyError::Unavailable));
		assert_eq!(error.kind, ErrorKind::CredentialStorageUnavailable);
	}

	struct ExpiringThenFresh {
		calls: AtomicUsize,
	}

	impl CredentialSource for ExpiringThenFresh {
		fn lease(
			&self,
			need: CredentialNeed,
		) -> CredentialFuture<'_, Result<CredentialLease, CredentialError>> {
			let call = self.calls.fetch_add(1, Ordering::SeqCst);
			if call == 0 {
				return credential_ready(Err(CredentialError::Expired));
			}
			credential_ready(Ok(CredentialLease::bearer(
				LeaseMeta {
					account:    need.account.expect("account"),
					principal:  need.principal.expect("principal"),
					generation: 2,
					expires_at: need.valid_after.checked_add(Duration::from_secs(3600)),
				},
				SecretString::from("refreshed"),
			)))
		}

		fn reject<'a>(
			&'a self,
			_: &'a CredentialLease,
			_: AuthRejection,
		) -> CredentialFuture<'a, Result<(), CredentialError>> {
			credential_ready(Ok(()))
		}
	}

	struct SuccessfulRefresh {
		calls: AtomicUsize,
	}

	impl AuthRefreshEngine for SuccessfulRefresh {
		fn refresh(&self, account: AccountId) -> BoxFuture<'_, Result<AccountSummary, Error>> {
			self.calls.fetch_add(1, Ordering::SeqCst);
			async move {
				Ok(AccountSummary {
					account,
					provider: ProviderId::from("provider"),
					principal: Some(PrincipalId::from("principal")),
					label: None,
					state: AccountState::Active,
				})
			}
			.boxed()
		}
	}

	#[tokio::test]
	async fn forced_refresh_runs_before_leasing_and_never_reuses_rejected_generation() {
		let stored = Arc::new(ExpiringThenFresh { calls: AtomicUsize::new(1) });
		let refresh = Arc::new(SuccessfulRefresh { calls: AtomicUsize::new(0) });
		let source =
			RefreshingCredentialSource::with_skew(stored.clone(), refresh.clone(), Duration::ZERO);
		let lease = source
			.refresh_lease(CredentialNeed {
				spec:        omp_catalog::AuthSpecId::new("oauth"),
				account:     Some(AccountId::from("account")),
				principal:   Some(PrincipalId::from("principal")),
				valid_after: SystemTime::now(),
			})
			.await
			.expect("forced refreshed lease");
		assert_eq!(lease.meta().generation, 2);
		assert_eq!(stored.calls.load(Ordering::SeqCst), 2);
		assert_eq!(refresh.calls.load(Ordering::SeqCst), 1);
	}

	#[tokio::test]
	async fn routine_acquisition_refreshes_and_replays_expired_oauth_once() {
		let stored = Arc::new(ExpiringThenFresh { calls: AtomicUsize::new(0) });
		let refresh = Arc::new(SuccessfulRefresh { calls: AtomicUsize::new(0) });
		let source =
			RefreshingCredentialSource::with_skew(stored.clone(), refresh.clone(), Duration::ZERO);
		let lease = source
			.lease(CredentialNeed {
				spec:        omp_catalog::AuthSpecId::new("oauth"),
				account:     Some(AccountId::from("account")),
				principal:   Some(PrincipalId::from("principal")),
				valid_after: SystemTime::now(),
			})
			.await
			.expect("refreshed lease");
		assert_eq!(lease.meta().generation, 2);
		assert_eq!(stored.calls.load(Ordering::SeqCst), 2);
		assert_eq!(refresh.calls.load(Ordering::SeqCst), 1);
	}

	struct ImmediateClock(SystemTime);

	impl OAuthClock for ImmediateClock {
		fn now(&self) -> SystemTime {
			self.0
		}

		fn sleep(&self, _duration: Duration) -> BoxFuture<'_, ()> {
			async {}.boxed()
		}
	}

	#[test]
	fn embedded_copilot_bearer_then_device_prefers_interactive_login() {
		let catalog = Catalog::embedded();
		let provider = catalog
			.provider(ProviderId::from_ref("github-copilot"))
			.expect("GitHub Copilot provider");
		let spec_for = |method| {
			provider
				.auth
				.iter()
				.find(|id| {
					catalog.auth_spec(id).is_some_and(|spec| {
						auth_method(catalog, spec).is_ok_and(|actual| actual == method)
					})
				})
				.cloned()
				.expect("Copilot auth method")
		};
		let bearer = spec_for(AuthMethod::ApiKey);
		let device = spec_for(AuthMethod::OAuthDevice);
		let auth = [bearer.clone(), device.clone()];

		let default = select_auth_spec(catalog, &auth, None)
			.expect("valid Copilot auth specs")
			.expect("default Copilot auth spec");
		assert_eq!(default, (device, AuthMethod::OAuthDevice));

		let api_key = select_auth_spec(catalog, &auth, Some(AuthMethod::ApiKey))
			.expect("valid Copilot auth specs")
			.expect("Copilot bearer auth spec");
		assert_eq!(api_key, (bearer, AuthMethod::ApiKey));
	}

	#[test]
	fn plain_bearer_auth_is_an_api_key_login_method() {
		let catalog = Catalog::embedded();
		let provider = catalog
			.provider(ProviderId::from_ref("alibaba-token-plan"))
			.expect("Alibaba Token Plan provider");
		let spec = catalog
			.auth_spec(provider.auth.first().expect("Alibaba auth spec id"))
			.expect("Alibaba auth spec");
		assert_eq!(spec.kind, AuthSpecKind::Bearer);
		assert_eq!(auth_method(catalog, spec).expect("login method"), AuthMethod::ApiKey);
	}

	#[test]
	fn alibaba_scoped_api_key_engine_precedes_generic_engine() {
		let catalog = Arc::new(Catalog::embedded().clone());
		let provider = ProviderId::from("alibaba-token-plan");
		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("current timestamp")
			.as_nanos();
		let path = env::temp_dir()
			.join(format!("omp-alibaba-dispatch-{}-{suffix}.sqlite", std::process::id()));
		let store = Arc::new(
			CredentialStore::open(
				&path,
				Arc::new(HeadlessKeySource::new(KeyId::new("alibaba-dispatch"), [8; 32])),
			)
			.expect("credential store"),
		);
		let http: Arc<dyn OAuthHttpClient> = Arc::new(FixtureHttp {
			responses: Mutex::new(VecDeque::new()),
			requests:  Mutex::new(Vec::new()),
		});
		let scoped: Arc<dyn AuthLoginEngine> = Arc::new(AlibabaTokenPlanLoginEngine::new(
			Arc::clone(&catalog),
			Arc::clone(&store),
			AccountPool::new(),
			http,
		));
		let generic: Arc<dyn AuthLoginEngine> = Arc::new(
			SecretLoginEngine::new(
				AuthMethod::ApiKey,
				"generic".into(),
				catalog,
				store,
				AccountPool::new(),
			)
			.expect("generic API-key engine"),
		);
		let engines = vec![Arc::clone(&scoped), generic];
		let selected = select_login_engine(&engines, &provider).expect("supporting engine");
		assert!(Arc::ptr_eq(selected, &scoped));
		drop(engines);
		drop(scoped);
		let _ = fs::remove_file(path);
	}

	struct FixtureHttp {
		responses: Mutex<VecDeque<OAuthHttpResponse>>,
		requests:  Mutex<Vec<(String, String)>>,
	}

	impl OAuthHttpClient for FixtureHttp {
		fn execute(
			&self,
			request: OAuthHttpRequest,
		) -> BoxFuture<'_, Result<OAuthHttpResponse, OAuthTransportError>> {
			let (_, url, _, body) = request.into_parts();
			self.requests.lock().push((
				url.to_string(),
				body.map_or_else(String::new, |body| body.expose_secret().to_owned()),
			));
			let response = self.responses.lock().pop_front().expect("fixture response");
			async move { Ok(response) }.boxed()
		}
	}

	#[tokio::test]
	async fn embedded_kimi_login_starts_and_resolves_its_principal() {
		let catalog = Arc::new(Catalog::embedded().clone());
		let provider = ProviderId::from("kimi-code");
		let auth = catalog
			.provider(&provider)
			.and_then(|provider| provider.auth.first())
			.cloned()
			.expect("Kimi OAuth auth spec");
		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap()
			.as_nanos();
		let store_path =
			env::temp_dir().join(format!("omp-kimi-login-{}-{suffix}.sqlite", std::process::id()));
		let store = Arc::new(
			CredentialStore::open(
				&store_path,
				Arc::new(HeadlessKeySource::new(KeyId::new("kimi-login-test"), [9; 32])),
			)
			.unwrap(),
		);
		let http = Arc::new(FixtureHttp {
			responses: Mutex::new(VecDeque::from([
				OAuthHttpResponse {
					status:  200,
					headers: HeaderMap::new(),
					body:    SecretString::from(
						r#"{"device_code":"device","user_code":"ABCD-EFGH","verification_uri":"https://www.kimi.com/code/authorize_device","verification_uri_complete":"https://www.kimi.com/code/authorize_device?user_code=ABCD-EFGH","expires_in":1800,"interval":5}"#
							.to_owned(),
					),
				},
				OAuthHttpResponse {
					status:  200,
					headers: HeaderMap::new(),
					body:    SecretString::from(
						r#"{"access_token":"header.eyJ1c2VyX2lkIjoia2ltaS11c2VyLTQyIiwic3ViIjoiZmFsbGJhY2sifQ.signature","refresh_token":"refresh","token_type":"Bearer","expires_in":3600}"#
							.to_owned(),
					),
				},
				OAuthHttpResponse {
					status:  200,
					headers: HeaderMap::new(),
					body:    SecretString::from(
						r#"{"access_token":"header.eyJ1c2VyX2lkIjoia2ltaS11c2VyLTQyIiwic3ViIjoiZmFsbGJhY2sifQ.signature","refresh_token":"refresh-2","token_type":"Bearer","expires_in":3600}"#
							.to_owned(),
					),
				},
			])),
			requests:  Mutex::new(Vec::new()),
		});
		let accounts = AccountPool::new();
		let custom = Arc::new(OAuthCustomDispatcher::new());
		let clock = Arc::new(ImmediateClock(SystemTime::UNIX_EPOCH));
		let engine = OAuthLoginEngine::new(
			AuthMethod::OAuthDevice,
			Arc::clone(&catalog),
			Arc::clone(&store),
			accounts.clone(),
			Arc::clone(&http),
			Arc::clone(&clock),
			Arc::clone(&custom),
		)
		.unwrap();
		let session = engine
			.begin(LoginRequest { provider, method: None }, auth)
			.await
			.unwrap();
		let mut saw_code = false;
		let completed = loop {
			let event = time::timeout(Duration::from_secs(1), session.events.recv_async())
				.await
				.expect("Kimi login event")
				.expect("Kimi login event channel")
				.expect("successful Kimi login event");
			match event {
				AuthEvent::ShowDeviceCode { code, verification_url } => {
					assert_eq!(code.expose_secret(), "ABCD-EFGH");
					assert_eq!(verification_url, "https://www.kimi.com/code/authorize_device");
					saw_code = true;
				},
				AuthEvent::Complete(account) => {
					assert_eq!(account.account.as_str(), "kimi-code:kimi-user-42");
					assert_eq!(
						account
							.principal
							.as_ref()
							.map(|principal| principal.as_str()),
						Some("kimi-user-42")
					);
					break account;
				},
				AuthEvent::OpenUrl { .. } | AuthEvent::Waiting => {},
				AuthEvent::Prompt(_) => panic!("Kimi device flow must not request private input"),
			}
		};
		let refreshed = StoredOAuthRefreshEngine::new(
			catalog,
			store,
			accounts,
			http.clone(),
			clock,
			custom,
			Arc::new(
				RefreshCoordinator::new("kimi-refresh-test", RefreshPolicy::default())
					.expect("refresh coordinator"),
			),
		)
		.refresh(completed.account.clone())
		.await
		.expect("Kimi refresh");
		assert_eq!(refreshed.account, completed.account);
		assert_eq!(refreshed.principal, completed.principal);
		assert!(saw_code);
		let requests = http.requests.lock();
		assert_eq!(requests.len(), 3);
		assert_eq!(requests[0].0, "https://auth.kimi.com/api/oauth/device_authorization");
		assert!(
			requests[0]
				.1
				.contains("client_id=17e5f671-d194-4dfb-9706-5516cb48c098")
		);
		assert!(!requests[0].1.contains("scope="));
		assert!(
			requests[1]
				.1
				.contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code")
		);
		assert!(requests[1].1.contains("device_code=device"));
		assert!(requests[2].1.contains("grant_type=refresh_token"));
		assert!(requests[2].1.contains("refresh_token=refresh"));
		drop(requests);
		drop(session);
		drop(engine);
		let _ = fs::remove_file(store_path);
	}

	#[tokio::test]
	async fn embedded_opencode_go_login_prompt_names_the_selected_provider() {
		let catalog = Arc::new(Catalog::embedded().clone());
		let provider = ProviderId::from("opencode-go");
		// opencode-go and opencode-zen share one console (opencode.ai/auth), so
		// the paste prompt must name the selected provider: choose the custom
		// api-key-paste OAuth spec, not the plain bearer spec.
		let auth = catalog
			.provider(&provider)
			.expect("OpenCode Go provider")
			.auth
			.iter()
			.find(|id| {
				catalog.auth_spec(id).is_some_and(|spec| {
					auth_method(&catalog, spec).is_ok_and(|method| method == AuthMethod::OAuthPkce)
				})
			})
			.cloned()
			.expect("OpenCode Go paste auth spec");
		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap()
			.as_nanos();
		let store_path =
			env::temp_dir().join(format!("omp-opencode-login-{}-{suffix}.sqlite", std::process::id()));
		let store = Arc::new(
			CredentialStore::open(
				&store_path,
				Arc::new(HeadlessKeySource::new(KeyId::new("opencode-login-test"), [7; 32])),
			)
			.unwrap(),
		);
		let http = Arc::new(FixtureHttp {
			responses: Mutex::new(VecDeque::new()),
			requests:  Mutex::new(Vec::new()),
		});
		let clock = Arc::new(ImmediateClock(SystemTime::UNIX_EPOCH));
		let custom = Arc::new(
			OAuthCustomDispatcher::builtin(http.clone(), clock.clone())
				.expect("builtin custom dispatcher"),
		);
		let engine = OAuthLoginEngine::new(
			AuthMethod::OAuthPkce,
			catalog,
			store,
			AccountPool::new(),
			http,
			clock,
			custom,
		)
		.unwrap();
		let session = engine
			.begin(LoginRequest { provider, method: None }, auth)
			.await
			.unwrap();
		let mut saw_prompt = false;
		loop {
			let event = time::timeout(Duration::from_secs(1), session.events.recv_async())
				.await
				.expect("OpenCode login event")
				.expect("OpenCode login event channel")
				.expect("successful OpenCode login event");
			match event {
				AuthEvent::OpenUrl { url, launch } => {
					assert_eq!(url, "https://opencode.ai/auth");
					assert_eq!(launch, None);
				},
				AuthEvent::Prompt(prompt) => {
					assert_eq!(prompt.message, "Paste your Opencode Go API key");
					saw_prompt = true;
					session
						.responses
						.send_async(AnswerAuthResponse {
							session: session.id.clone(),
							input:   AuthInput::ApiKey(SecretString::from("sk-opencode".to_owned())),
						})
						.await
						.expect("API key response");
				},
				AuthEvent::Complete(account) => {
					assert_eq!(account.account.as_str(), "opencode-go:opencode");
					break;
				},
				AuthEvent::Waiting | AuthEvent::ShowDeviceCode { .. } => {},
			}
		}
		assert!(saw_prompt);
		drop(session);
		drop(engine);
		let _ = fs::remove_file(store_path);
	}
}
