//! Tonic authentication projection over canonical typed auth and usage
//! operations.

use std::{
	collections::{BTreeMap, BTreeSet},
	pin::Pin,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::{self, Duration, Instant},
};

use flume::Receiver;
use futures::{Stream, StreamExt as _};
use omp_ai::{
	Client, Error as InferenceError, ErrorKind, Registry,
	account::AccountPoolEvent,
	answer::{
		AccountState, AccountSummary, AuthAnswer, AuthEvent, AuthSession, UsageQuantity, UsageReport,
		UsageStatus, UsageUnit, UsageWindowKind,
	},
	auth,
	auth::{AuthControlHandle, CredentialControlWrite, OAuthControlImport, ScopedCredentialGrant},
	call::{
		AuthInput, AuthMethod, AuthRequest, CallMeta, LoginRequest, Target, UsageRequest, UsageScope,
	},
	id::{AccountId, LoginSessionId, RequestId},
	receipt::{ExecutionBudget, UsageSource},
	router::Router,
};
use omp_catalog::ProviderId;
use omp_core::{ExposeSecret as _, Hash32, Secret, SecretString, Str};
use omp_proto::omp::{
	auth::v1::{
		self as pb, begin_login_response, credential_event, credential_health, credential_meta,
		usage_report::reset_credits, usage_window,
	},
	inference::v1::usage,
};
use parking_lot::Mutex;
use tonic::{Request, Response, Status};

static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const AUTH_FLOW_TTL: Duration = Duration::from_hours(1);
type AuthEventStream =
	Pin<Box<dyn Stream<Item = Result<pb::CredentialEvent, Status>> + Send + 'static>>;

struct AuthFlow {
	session:    AuthSession,
	expires_at: Instant,
}
struct ActiveFlow(Option<AuthSession>);

impl ActiveFlow {
	const fn new(session: AuthSession) -> Self {
		Self(Some(session))
	}

	const fn session(&self) -> &AuthSession {
		self.0.as_ref().expect("active auth flow")
	}

	fn disarm(mut self) -> AuthSession {
		self.0.take().expect("active auth flow")
	}
}

impl Drop for ActiveFlow {
	fn drop(&mut self) {
		if let Some(session) = &self.0 {
			session.cancel();
		}
	}
}
fn reap_expired_flow(
	flows: &Mutex<BTreeMap<String, AuthFlow>>,
	flow_id: &str,
	now: Instant,
) -> bool {
	let mut flows = flows.lock();
	if flows.get(flow_id).is_none_or(|flow| flow.expires_at > now) {
		return false;
	}
	let flow = flows.remove(flow_id).expect("checked flow exists");
	flow.session.cancel();
	true
}

/// Server-authenticated identity and provider grants for credential reveal.
///
/// This value must be inserted into tonic request extensions by a trusted
/// transport interceptor. Wire metadata and protobuf identity fields never
/// construct it.
#[derive(Clone, Debug)]
pub struct AuthenticatedRevealContext {
	extension:          Str,
	caller_principal:   Str,
	providers:          Arc<BTreeSet<ProviderId>>,
	host_generation:    u64,
	session_generation: u64,
}

impl AuthenticatedRevealContext {
	/// Constructs trusted CONTROL identity and provider scope for one server
	/// session.
	pub fn new(
		extension: impl Into<Str>,
		caller_principal: impl Into<Str>,
		providers: impl IntoIterator<Item = ProviderId>,
		host_generation: u64,
		session_generation: u64,
	) -> Self {
		Self {
			extension: extension.into(),
			caller_principal: caller_principal.into(),
			providers: Arc::new(providers.into_iter().collect()),
			host_generation,
			session_generation,
		}
	}

	fn audited_reveal(
		&self,
		request: &pb::RevealCredentialRequest,
	) -> Result<omp_ai::auth::AuditedCredentialReveal, Status> {
		let provider = ProviderId::from(request.provider.as_str());
		if request.extension != self.extension.as_str()
			|| request.caller_principal != self.caller_principal.as_str()
			|| request.host_generation != self.host_generation
			|| request.session_generation != self.session_generation
			|| !self.providers.contains(&provider)
		{
			tracing::warn!(
				rpc.service = "auth",
				rpc.method = "reveal_credential",
				"credential reveal authorization denied"
			);
			return Err(Status::permission_denied(
				"credential reveal identity or provider scope is not authenticated",
			));
		}
		Ok(omp_ai::auth::AuditedCredentialReveal {
			extension:          self.extension.clone(),
			caller_principal:   self.caller_principal.clone(),
			provider:           provider.into(),
			host_generation:    self.host_generation,
			session_generation: self.session_generation,
			request_id:         request.request_id,
			reason:             request.reason.as_str().into(),
		})
	}
}

/// Extracts only server-inserted CONTROL reveal authority.
fn authenticated_reveal_context<T>(
	request: &Request<T>,
) -> Result<AuthenticatedRevealContext, Status> {
	request
		.extensions()
		.get::<AuthenticatedRevealContext>()
		.cloned()
		.ok_or_else(|| {
			tracing::warn!(
				rpc.service = "auth",
				rpc.method = "reveal_credential",
				"credential reveal missing authenticated context"
			);
			Status::permission_denied(
				"credential reveal requires authenticated CONTROL identity and scope",
			)
		})
}

/// RPC server that retains interactive login channels while a flow is active.
#[derive(Clone)]
pub struct AuthRpc {
	registry: Registry,
	flows:    Arc<Mutex<BTreeMap<String, AuthFlow>>>,
	control:  Option<AuthControlHandle>,
}

impl AuthRpc {
	/// Wraps one immutable comprehensive registry.
	pub fn new(registry: Registry) -> Self {
		Self { registry, flows: Arc::new(Mutex::new(BTreeMap::new())), control: None }
	}

	/// Binds the same live auth manager used by route execution to lifecycle
	/// RPC.
	pub fn with_control(registry: Registry, control: AuthControlHandle) -> Self {
		Self { registry, flows: Arc::new(Mutex::new(BTreeMap::new())), control: Some(control) }
	}

	fn control(&self) -> Result<&AuthControlHandle, Status> {
		self
			.control
			.as_ref()
			.ok_or_else(|| Status::failed_precondition("auth lifecycle owner is not bound"))
	}

	fn insert_flow(&self, flow_id: String, session: AuthSession) {
		let expires_at = Instant::now() + AUTH_FLOW_TTL;
		self
			.flows
			.lock()
			.insert(flow_id.clone(), AuthFlow { session, expires_at });
		let flows = Arc::downgrade(&self.flows);
		tokio::spawn(async move {
			tokio::time::sleep(AUTH_FLOW_TTL).await;
			if let Some(flows) = flows.upgrade() {
				reap_expired_flow(&flows, &flow_id, Instant::now());
			}
		});
	}

	fn take_flow(&self, flow_id: &str) -> Result<ActiveFlow, Status> {
		self
			.flows
			.lock()
			.remove(flow_id)
			.map(|flow| ActiveFlow::new(flow.session))
			.ok_or_else(|| Status::not_found("auth flow not found"))
	}

	fn control_account(&self, id: u64) -> Result<AccountId, Status> {
		let matches = self
			.control()?
			.accounts(None)
			.into_iter()
			.filter(|account| wire_account_id(&account.account) == id)
			.map(|account| account.account)
			.collect::<Vec<_>>();
		match matches.as_slice() {
			[account] => Ok(account.clone()),
			[] => Err(Status::not_found("credential not found")),
			_ => Err(Status::failed_precondition("credential id collision")),
		}
	}

	fn control_meta(
		&self,
		account: omp_ai::account::AccountRecord,
	) -> Result<pb::CredentialMeta, Status> {
		let metadata = self
			.control()?
			.metadata(&account.account)
			.map_err(store_status)?
			.ok_or_else(|| Status::not_found("credential not found"))?;
		let kind = match metadata.kind.as_str() {
			"api_key" | "api-key" | "bearer" => credential_meta::Kind::ApiKey,
			"oauth" | "oauth-renewable-v1" => credential_meta::Kind::Oauth,
			"aws" => credential_meta::Kind::Aws,
			_ => credential_meta::Kind::Unspecified,
		};
		let blocks = self
			.control()?
			.blocks(&account.account)
			.into_iter()
			.map(|(scope, until_ms)| pb::Block {
				scope: scope.to_string(),
				provider_key: String::new(),
				until_ms,
			})
			.collect();
		Ok(pb::CredentialMeta {
			id: wire_account_id(&account.account),
			provider: account.provider.as_str().to_owned(),
			kind: kind as i32,
			identity: account.principal.as_str().to_owned(),
			state: if account.enabled {
				credential_meta::State::Active as i32
			} else {
				credential_meta::State::Disabled as i32
			},
			blocks,
			disabled_cause: String::new(),
			expires_at_ms: metadata.expires_at_ms.unwrap_or_default(),
			created_at_ms: metadata.created_at_ms,
			updated_at_ms: metadata.updated_at_ms,
		})
	}

	fn provider_for(&self, requested: Option<&str>) -> Result<ProviderId, Status> {
		if let Some(provider) = requested.filter(|value| !value.is_empty()) {
			return Ok(ProviderId::from(provider));
		}
		self
			.registry
			.catalog()
			.providers()
			.iter()
			.find(|provider| {
				provider
					.management
					.supports(omp_catalog::OperationKind::Auth)
			})
			.map(|provider| provider.id.clone())
			.ok_or_else(|| Status::failed_precondition("no constructed route supports authentication"))
	}

	fn client(&self, provider: ProviderId) -> Client<omp_ai::ProviderService, Router> {
		let sequence = REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		Client::new(
			self.registry.service(),
			Router::new(self.registry.clone(), Duration::from_secs(30)),
			CallMeta {
				id:             RequestId::from(format!("auth-rpc-{sequence}")),
				target:         Target::ProviderService(provider),
				deadline:       None,
				budget:         ExecutionBudget::default(),
				session:        None,
				debug_session:  None,
				response_hooks: Default::default(),
			},
		)
	}

	async fn execute(
		&self,
		provider: ProviderId,
		request: AuthRequest,
	) -> Result<AuthAnswer, Status> {
		self
			.client(provider)
			.execute(request)
			.await
			.map_err(inference_status)
	}

	async fn account_operation(
		&self,
		account: u64,
		refresh: bool,
	) -> Result<pb::CredentialMeta, Status> {
		let account = if self.control.is_some() {
			self.control_account(account)?
		} else {
			AccountId::from(account.to_string())
		};
		let provider = self
			.control
			.as_ref()
			.and_then(|control| {
				control
					.accounts(None)
					.into_iter()
					.find(|record| record.account == account)
					.map(|record| record.provider)
			})
			.map_or_else(|| self.provider_for(None), Ok)?;
		let operation = if refresh {
			AuthRequest::Refresh { account }
		} else {
			AuthRequest::Logout { account }
		};
		match self.execute(provider, operation).await? {
			AuthAnswer::Refreshed(account) => account_meta(account),
			AuthAnswer::LoggedOut(account) => Ok(pb::CredentialMeta {
				id: parse_account_id(&account)?,
				state: credential_meta::State::Disabled as i32,
				..pb::CredentialMeta::default()
			}),
			_ => Err(Status::internal("auth operation returned the wrong typed answer")),
		}
	}

	async fn probe_account(
		&self,
		account: AccountSummary,
		strict: bool,
	) -> Result<pb::CredentialHealth, Status> {
		let credential_id = parse_account_id(&account.account)?;
		let provider = account.provider.clone();
		let started = Instant::now();
		let result = self
			.client(provider.clone())
			.execute(UsageRequest {
				provider:    Some(provider.clone()),
				account:     Some(account.account),
				scope:       UsageScope::All,
				allow_stale: !strict,
			})
			.await;
		Ok(match result {
			Ok(_) => pb::CredentialHealth {
				credential_id,
				provider: provider.as_str().to_owned(),
				healthy: true,
				status_code: Some(200),
				latency_ms: elapsed_ms(started.elapsed()),
				error_class: credential_health::ErrorClass::Unspecified as i32,
			},
			Err(error) => failed_health(credential_id, provider, started.elapsed(), &error),
		})
	}
}

#[tonic::async_trait]
impl pb::auth_server::Auth for AuthRpc {
	type WatchCredentialsStream = AuthEventStream;

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "auth", rpc.method = "list_credentials")
	)]
	async fn list_credentials(
		&self,
		request: Request<pb::ListCredentialsRequest>,
	) -> Result<Response<pb::ListCredentialsResponse>, Status> {
		let request = request.into_inner();
		if let Some(control) = &self.control {
			let requested =
				(!request.provider.is_empty()).then(|| ProviderId::from(request.provider.as_str()));
			let credentials = control
				.accounts(requested.as_deref())
				.into_iter()
				.map(|account| self.control_meta(account))
				.collect::<Result<Vec<_>, _>>()?;
			return Ok(Response::new(pb::ListCredentialsResponse { credentials, cursor: None }));
		}
		let provider = self.provider_for(Some(&request.provider))?;
		let answer = self
			.execute(provider.clone(), AuthRequest::ListAccounts { provider: Some(provider) })
			.await?;
		let AuthAnswer::Accounts(accounts) = answer else {
			return Err(Status::internal("auth list returned the wrong typed answer"));
		};
		let credentials = accounts
			.into_iter()
			.map(account_meta)
			.collect::<Result<Vec<_>, _>>()?;
		Ok(Response::new(pb::ListCredentialsResponse { credentials, cursor: None }))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "auth", rpc.method = "watch_credentials")
	)]
	async fn watch_credentials(
		&self,
		_request: Request<pb::WatchCredentialsRequest>,
	) -> Result<Response<Self::WatchCredentialsStream>, Status> {
		let mut changes = self.control()?.subscribe();
		let rpc = self.clone();
		let stream = async_stream::stream! {
			yield Ok(pb::CredentialEvent {
				cursor: None,
				event:  Some(credential_event::Event::Reset(pb::credential_event::Reset {})),
			});
			loop {
				match changes.recv().await {
					Ok(AccountPoolEvent::Upserted(account)) => {
						match rpc.control_meta(account) {
							Ok(metadata) => yield Ok(pb::CredentialEvent {
								cursor: None,
								event: Some(credential_event::Event::Upserted(metadata)),
							}),
							Err(status) if status.code() == tonic::Code::NotFound => continue,
							Err(status) => {
								yield Err(status);
								break;
							},
						}
					},
					Ok(AccountPoolEvent::Deleted(account)) => {
						yield Ok(pb::CredentialEvent {
							cursor: None,
							event: Some(credential_event::Event::DeletedId(wire_account_id(
								&account,
							))),
						});
					},
					Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
						yield Ok(pb::CredentialEvent {
							cursor: None,
							event: Some(credential_event::Event::Reset(
								pb::credential_event::Reset {},
							)),
						});
					},
					Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
				}
			}
		};
		Ok(Response::new(Box::pin(stream)))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "auth", rpc.method = "begin_login")
	)]
	async fn begin_login(
		&self,
		request: Request<pb::BeginLoginRequest>,
	) -> Result<Response<pb::BeginLoginResponse>, Status> {
		let provider = self.provider_for(Some(&request.into_inner().provider))?;
		let answer = self
			.execute(provider.clone(), AuthRequest::Login(LoginRequest { provider, method: None }))
			.await?;
		let AuthAnswer::Session(session) = answer else {
			return Err(Status::internal("auth login returned the wrong typed answer"));
		};
		let flow = ActiveFlow::new(session);
		let flow_id = flow.session().id.as_str().to_owned();
		let event = flow
			.session()
			.events
			.recv_async()
			.await
			.map_err(|_| Status::unavailable("auth flow ended before its first step"))?
			.map_err(inference_status)?;
		let step = login_step(event)?;
		self.insert_flow(flow_id.clone(), flow.disarm());
		Ok(Response::new(pb::BeginLoginResponse { flow_id, step: Some(step) }))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "auth", rpc.method = "submit_code")
	)]
	async fn submit_code(
		&self,
		request: Request<pb::SubmitCodeRequest>,
	) -> Result<Response<pb::CredentialMeta>, Status> {
		let request = request.into_inner();
		let flow = self.take_flow(&request.flow_id)?;
		let session = LoginSessionId::from(request.flow_id.as_str());
		flow
			.session()
			.responses
			.send_async(omp_ai::answer::AuthResponse {
				session,
				input: AuthInput::AuthorizationCode(SecretString::from(request.code)),
			})
			.await
			.map_err(|_| Status::unavailable("auth flow no longer accepts input"))?;
		Ok(Response::new(account_meta(await_account(flow.session().events.clone()).await?)?))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "auth", rpc.method = "wait_login")
	)]
	async fn wait_login(
		&self,
		request: Request<pb::WaitLoginRequest>,
	) -> Result<Response<pb::CredentialMeta>, Status> {
		let flow_id = request.into_inner().flow_id;
		let flow = self.take_flow(&flow_id)?;
		Ok(Response::new(account_meta(await_account(flow.session().events.clone()).await?)?))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "auth", rpc.method = "put_api_key")
	)]
	async fn put_api_key(
		&self,
		request: Request<pb::PutApiKeyRequest>,
	) -> Result<Response<pb::CredentialMeta>, Status> {
		let request = request.into_inner();
		let provider = self.provider_for(Some(&request.provider))?;
		let answer = self
			.execute(
				provider.clone(),
				AuthRequest::Login(LoginRequest { provider, method: Some(AuthMethod::ApiKey) }),
			)
			.await?;
		let AuthAnswer::Session(session) = answer else {
			return Err(Status::internal("API-key login returned the wrong typed answer"));
		};
		session
			.responses
			.send_async(omp_ai::answer::AuthResponse {
				session: session.id.clone(),
				input:   AuthInput::ApiKey(SecretString::from(request.api_key)),
			})
			.await
			.map_err(|_| Status::unavailable("API-key login no longer accepts input"))?;
		let summary = await_account(session.events).await?;
		if self.control.is_some() {
			let record = self
				.control()?
				.accounts(Some(&summary.provider))
				.into_iter()
				.find(|record| record.account == summary.account)
				.ok_or_else(|| Status::internal("stored API-key credential is missing"))?;
			return Ok(Response::new(self.control_meta(record)?));
		}
		Ok(Response::new(account_meta(summary)?))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "auth", rpc.method = "refresh_credential")
	)]
	async fn refresh_credential(
		&self,
		request: Request<pb::RefreshCredentialRequest>,
	) -> Result<Response<pb::CredentialMeta>, Status> {
		if self.control.is_some() {
			let account = self.control_account(request.get_ref().id)?;
			self
				.control()?
				.refresh(account.clone())
				.await
				.map_err(inference_status)?;
			let record = self
				.control()?
				.accounts(None)
				.into_iter()
				.find(|record| record.account == account)
				.ok_or_else(|| Status::not_found("credential not found"))?;
			return Ok(Response::new(self.control_meta(record)?));
		}
		Ok(Response::new(
			self
				.account_operation(request.into_inner().id, true)
				.await?,
		))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "auth", rpc.method = "delete_credential")
	)]
	async fn delete_credential(
		&self,
		request: Request<pb::DeleteCredentialRequest>,
	) -> Result<Response<pb::DeleteCredentialResponse>, Status> {
		if self.control.is_some() {
			let account = self.control_account(request.get_ref().id)?;
			self
				.control()?
				.delete(account)
				.await
				.map_err(inference_status)?;
			return Ok(Response::new(pb::DeleteCredentialResponse {}));
		}
		self
			.account_operation(request.into_inner().id, false)
			.await?;
		Ok(Response::new(pb::DeleteCredentialResponse {}))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "auth", rpc.method = "reveal_credential")
	)]
	async fn reveal_credential(
		&self,
		request: Request<pb::RevealCredentialRequest>,
	) -> Result<Response<pb::RevealCredentialResponse>, Status> {
		let authority = authenticated_reveal_context(&request)?;
		let request = request.into_inner();
		let audit = authority.audited_reveal(&request)?;
		let account = self.control_account(request.id)?;
		let record = self
			.control()?
			.accounts(None)
			.into_iter()
			.find(|record| record.account == account)
			.ok_or_else(|| Status::not_found("credential not found"))?;
		if record.provider.as_str() != request.provider {
			tracing::warn!(
				rpc.service = "auth",
				rpc.method = "reveal_credential",
				"credential reveal provider authorization denied"
			);
			return Err(Status::permission_denied(
				"credential does not belong to the authorized provider",
			));
		}
		let secret = self
			.control()?
			.reveal(&account, &audit, |secret| secret.expose(|bytes| bytes.to_vec()))
			.map_err(store_status)?;
		Ok(Response::new(pb::RevealCredentialResponse { secret: secret.into() }))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "auth", rpc.method = "get_usage")
	)]
	async fn get_usage(
		&self,
		request: Request<pb::GetUsageRequest>,
	) -> Result<Response<pb::GetUsageResponse>, Status> {
		let request = request.into_inner();
		let requested_provider =
			(!request.provider.is_empty()).then(|| ProviderId::from(request.provider.as_str()));
		let requested_account = (request.credential_id != 0)
			.then(|| self.control_account(request.credential_id))
			.transpose()?;
		let manager = self.registry.usage_manager().ok_or_else(|| {
			Status::failed_precondition(
				"provider usage backend is not constructed; start the production daemon with usage \
				 support",
			)
		})?;
		let records = self
			.control()?
			.accounts(requested_provider.as_deref())
			.into_iter()
			.filter(|record| {
				requested_account
					.as_ref()
					.is_none_or(|id| &record.account == id)
			})
			.collect::<Vec<_>>();
		if requested_account.is_some() && records.is_empty() {
			return Err(Status::not_found("credential not found for the requested provider"));
		}
		let mut reports = Vec::with_capacity(records.len());
		for record in records {
			let route = record.routes.iter().next().ok_or_else(|| {
				Status::failed_precondition("credential has no constructed route for usage queries")
			})?;
			let report = manager
				.execute(
					&record.provider,
					route,
					&UsageRequest {
						provider:    Some(record.provider.clone()),
						account:     Some(record.account),
						scope:       UsageScope::All,
						allow_stale: !request.refresh,
					},
					Instant::now().checked_add(Duration::from_secs(30)),
				)
				.await
				.map_err(|error| {
					Status::failed_precondition(format!(
						"provider usage query failed for {}: {error}; verify its console usage backend \
						 and credential configuration",
						record.provider
					))
				})?;
			reports.push(usage_report(report));
		}
		Ok(Response::new(pb::GetUsageResponse { reports }))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "auth", rpc.method = "put_aws_credential")
	)]
	async fn put_aws_credential(
		&self,
		request: Request<pb::PutAwsCredentialRequest>,
	) -> Result<Response<pb::CredentialMeta>, Status> {
		let request = request.into_inner();
		let provider = ProviderId::from(request.provider.as_str());
		let principal = omp_ai::PrincipalId::from(request.identity.as_str());
		let mut material = Vec::with_capacity(
			request.access_key_id.len()
				+ request.secret_access_key.len()
				+ request.session_token.len()
				+ 16,
		);
		for field in [request.access_key_id, request.secret_access_key, request.session_token] {
			material.extend_from_slice(&(field.len() as u64).to_le_bytes());
			material.extend_from_slice(&field);
		}
		let (_, account) = self
			.control()?
			.store(CredentialControlWrite {
				provider,
				principal,
				identity: Some(request.identity.into()),
				kind: "aws".into(),
				secret: Secret::new(material),
				expires_at_ms: None,
			})
			.map_err(store_status)?;
		Ok(Response::new(self.control_meta(account)?))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "auth", rpc.method = "import_o_auth")
	)]
	async fn import_o_auth(
		&self,
		request: Request<pb::ImportOAuthRequest>,
	) -> Result<Response<pb::CredentialMeta>, Status> {
		let request = request.into_inner();
		if request.provider.is_empty() {
			return Err(Status::invalid_argument("provider is required"));
		}
		if request.refresh_token.is_empty() {
			return Err(Status::invalid_argument("refresh_token is required"));
		}
		let provider = ProviderId::from(request.provider.as_str());
		let identity = (!request.identity.is_empty()).then(|| request.identity.into());
		let principal =
			omp_ai::PrincipalId::from(identity.as_ref().map_or(provider.as_str(), Str::as_str));
		let (_, account) = self
			.control()?
			.import_oauth(OAuthControlImport {
				provider,
				principal,
				identity,
				access_token: (!request.access_token.is_empty())
					.then(|| SecretString::from(request.access_token)),
				refresh_token: SecretString::from(request.refresh_token),
				expires_at_ms: (request.expires_at_ms != 0).then_some(request.expires_at_ms),
			})
			.map_err(store_status)?;
		Ok(Response::new(self.control_meta(account)?))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "auth", rpc.method = "disable_credential")
	)]
	async fn disable_credential(
		&self,
		request: Request<pb::DisableCredentialRequest>,
	) -> Result<Response<pb::CredentialMeta>, Status> {
		let request = request.into_inner();
		let account = self.control_account(request.id)?;
		let record = self
			.control()?
			.set_enabled(&account, false, Some(request.cause.as_str()))
			.map_err(store_status)?;
		let mut metadata = self.control_meta(record)?;
		metadata.disabled_cause = request.cause;
		Ok(Response::new(metadata))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "auth", rpc.method = "enable_credential")
	)]
	async fn enable_credential(
		&self,
		request: Request<pb::EnableCredentialRequest>,
	) -> Result<Response<pb::CredentialMeta>, Status> {
		let account = self.control_account(request.into_inner().id)?;
		let record = self
			.control()?
			.set_enabled(&account, true, None)
			.map_err(store_status)?;
		Ok(Response::new(self.control_meta(record)?))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "auth", rpc.method = "report_block")
	)]
	async fn report_block(
		&self,
		request: Request<pb::ReportBlockRequest>,
	) -> Result<Response<pb::CredentialMeta>, Status> {
		let request = request.into_inner();
		let account = self.control_account(request.id)?;
		let block = request
			.block
			.ok_or_else(|| Status::invalid_argument("credential block is missing"))?;
		let until = time::UNIX_EPOCH
			.checked_add(Duration::from_millis(block.until_ms))
			.ok_or_else(|| Status::invalid_argument("credential block time is invalid"))?;
		self
			.control()?
			.report_block(&account, block.scope, until)
			.map_err(store_status)?;
		let record = self
			.control()?
			.accounts(None)
			.into_iter()
			.find(|record| record.account == account)
			.ok_or_else(|| Status::not_found("credential not found"))?;
		Ok(Response::new(self.control_meta(record)?))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "auth", rpc.method = "clear_blocks")
	)]
	async fn clear_blocks(
		&self,
		request: Request<pb::ClearBlocksRequest>,
	) -> Result<Response<pb::CredentialMeta>, Status> {
		let request = request.into_inner();
		if request.id == 0 {
			return Err(Status::invalid_argument("credential id is required"));
		}
		if request.scopes.iter().any(String::is_empty) {
			return Err(Status::invalid_argument("block scopes must not be empty"));
		}
		let account = self.control_account(request.id)?;
		let scopes = request
			.scopes
			.into_iter()
			.map(Str::from)
			.collect::<Vec<_>>();
		self
			.control()?
			.clear_blocks(&account, &scopes)
			.map_err(store_status)?;
		let record = self
			.control()?
			.accounts(None)
			.into_iter()
			.find(|record| record.account == account)
			.ok_or_else(|| Status::not_found("credential not found"))?;
		Ok(Response::new(self.control_meta(record)?))
	}

	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "auth", rpc.method = "mark_usage_stale")
	)]
	async fn mark_usage_stale(
		&self,
		request: Request<pb::MarkUsageStaleRequest>,
	) -> Result<Response<pb::MarkUsageStaleResponse>, Status> {
		let request = request.into_inner();
		if request.provider.is_empty() && request.credential_id == 0 {
			return Err(Status::invalid_argument("provider or credential id is required"));
		}
		let provider =
			(!request.provider.is_empty()).then(|| ProviderId::from(request.provider.as_str()));
		let account = (request.credential_id != 0)
			.then(|| self.control_account(request.credential_id))
			.transpose()?;
		if let (Some(provider), Some(account)) = (&provider, &account)
			&& !self
				.control()?
				.accounts(Some(provider))
				.iter()
				.any(|record| &record.account == account)
		{
			return Err(Status::invalid_argument(
				"credential does not belong to the requested provider",
			));
		}
		self
			.control()?
			.invalidate_usage(provider.as_deref(), account.as_deref())
			.map_err(store_status)?;
		Ok(Response::new(pb::MarkUsageStaleResponse {}))
	}

	async fn get_usage_history(
		&self,
		request: Request<pb::GetUsageHistoryRequest>,
	) -> Result<Response<pb::GetUsageHistoryResponse>, Status> {
		let request = request.into_inner();
		if request.credential_id == 0 {
			return Err(Status::invalid_argument("credential id is required"));
		}
		if request.until_ms != 0 && request.since_ms > request.until_ms {
			return Err(Status::invalid_argument("usage history time range is invalid"));
		}
		Err(Status::failed_precondition(
			"durable usage history queries are not backed by the current account-state store; use \
			 GetUsage for the latest report",
		))
	}

	async fn get_client_usage(
		&self,
		_request: Request<pb::GetClientUsageRequest>,
	) -> Result<Response<pb::GetClientUsageResponse>, Status> {
		Err(Status::failed_precondition(
			"per-client usage history was retired with the transcript-v4 index",
		))
	}

	async fn probe_credentials(
		&self,
		request: Request<pb::ProbeCredentialsRequest>,
	) -> Result<Response<pb::ProbeCredentialsResponse>, Status> {
		let request = request.into_inner();
		let requested =
			(!request.provider.is_empty()).then(|| ProviderId::from(request.provider.as_str()));
		let provider = self.provider_for(requested.as_ref().map(ProviderId::as_str))?;
		let answer = self
			.execute(provider, AuthRequest::ListAccounts { provider: requested })
			.await?;
		let AuthAnswer::Accounts(accounts) = answer else {
			return Err(Status::internal("auth probe list returned the wrong typed answer"));
		};
		let strict = request.strict;
		let credentials = futures::stream::iter(accounts.into_iter().map(|account| {
			let rpc = self.clone();
			async move { rpc.probe_account(account, strict).await }
		}))
		.buffered(4)
		.collect::<Vec<_>>()
		.await
		.into_iter()
		.collect::<Result<Vec<_>, _>>()?;
		Ok(Response::new(pb::ProbeCredentialsResponse { credentials }))
	}

	async fn mint_scoped_token(
		&self,
		request: Request<pb::MintScopedTokenRequest>,
	) -> Result<Response<pb::ScopedToken>, Status> {
		let request = request.into_inner();
		if request.provider.is_empty() {
			return Err(Status::invalid_argument("provider is required"));
		}
		if request.facet.is_empty() {
			return Err(Status::invalid_argument("facet is required"));
		}
		if request.session_id.is_empty() {
			return Err(Status::invalid_argument("session id is required"));
		}
		let provider = ProviderId::from(request.provider.as_str());
		let account = self
			.control()?
			.accounts(Some(&provider))
			.into_iter()
			.find(|record| record.enabled)
			.ok_or_else(|| {
				Status::failed_precondition(
					"no active credential is available for the requested provider",
				)
			})?;
		let now_ms: u64 = time::SystemTime::now()
			.duration_since(time::UNIX_EPOCH)
			.map_err(|_| Status::internal("system clock is before the Unix epoch"))?
			.as_millis()
			.try_into()
			.map_err(|_| Status::internal("system clock is outside the supported range"))?;
		let requested_expiry = now_ms.saturating_add(300_000);
		let expires_at_ms = self
			.control()?
			.metadata(&account.account)
			.map_err(store_status)?
			.and_then(|metadata| metadata.expires_at_ms)
			.map_or(requested_expiry, |credential_expiry| requested_expiry.min(credential_expiry));
		if expires_at_ms <= now_ms {
			return Err(Status::failed_precondition("credential is already expired"));
		}
		let request_key = format!("{}\0{}\0{}", request.provider, request.facet, request.session_id);
		let scoped = self
			.control()?
			.mint_scoped_token_replay(&account.account, &ScopedCredentialGrant {
				extension: "auth-rpc".into(),
				caller_principal: request.session_id.as_str().into(),
				provider: request.provider.into(),
				facet: request.facet.into(),
				host_generation: 0,
				session_generation: digest_u64(request.session_id.as_bytes()),
				request_id: digest_u64(request_key.as_bytes()),
				expires_at_ms,
			})
			.map_err(store_status)?;
		Ok(Response::new(pb::ScopedToken {
			token:         scoped.token.expose_secret().to_owned(),
			expires_at_ms: scoped.expires_at_ms,
		}))
	}
}

async fn await_account(
	events: Receiver<Result<AuthEvent, omp_ai::Error>>,
) -> Result<AccountSummary, Status> {
	while let Ok(event) = events.recv_async().await {
		if let AuthEvent::Complete(account) = event.map_err(inference_status)? {
			return Ok(account);
		}
	}
	Err(Status::unavailable("auth flow ended without account completion"))
}

fn login_step(event: AuthEvent) -> Result<begin_login_response::Step, Status> {
	match event {
		AuthEvent::OpenUrl { url, launch } => {
			Ok(begin_login_response::Step::Browse(begin_login_response::Browse {
				url:        url.as_str().to_owned(),
				launch_url: launch.map(|url| url.as_str().to_owned()),
			}))
		},
		AuthEvent::ShowDeviceCode { code, verification_url } => {
			Ok(begin_login_response::Step::Device(begin_login_response::DeviceCode {
				user_code:  omp_core::ExposeSecret::expose_secret(&code).to_owned(),
				verify_url: verification_url.as_str().to_owned(),
			}))
		},
		AuthEvent::Prompt(prompt) => Err(Status::failed_precondition(format!(
			"auth flow requires {} input via the typed prompt channel",
			prompt.message
		))),
		AuthEvent::Waiting => Err(Status::failed_precondition(
			"auth flow is waiting without a client-visible login step",
		)),
		AuthEvent::Complete(_) => {
			Err(Status::failed_precondition("auth flow completed before returning a login step"))
		},
	}
}

fn account_meta(account: AccountSummary) -> Result<pb::CredentialMeta, Status> {
	Ok(pb::CredentialMeta {
		id:             parse_account_id(&account.account)?,
		provider:       account.provider.as_str().to_owned(),
		kind:           credential_meta::Kind::Unspecified as i32,
		identity:       account
			.principal
			.map_or_else(String::new, |value| value.as_str().to_owned()),
		state:          match account.state {
			AccountState::Active => 1,
			AccountState::RefreshRequired => 2,
			AccountState::Disabled | AccountState::LoggedOut => 4,
		},
		blocks:         Vec::new(),
		disabled_cause: String::new(),
		expires_at_ms:  0,
		created_at_ms:  0,
		updated_at_ms:  0,
	})
}

fn parse_account_id(account: &AccountId<str>) -> Result<u64, Status> {
	Ok(wire_account_id(account))
}

fn store_status(error: auth::StoreError) -> Status {
	match error {
		auth::StoreError::NotFound => Status::not_found(error.to_string()),
		auth::StoreError::GenerationConflict | auth::StoreError::RevealAuditConflict => {
			Status::aborted(error.to_string())
		},
		auth::StoreError::InvalidRevealAudit => {
			tracing::warn!(
				rpc.service = "auth",
				rpc.method = "reveal_credential",
				"credential reveal audit rejected"
			);
			Status::permission_denied(error.to_string())
		},
		auth::StoreError::InvalidScopedGrant => Status::invalid_argument(error.to_string()),
		_ => Status::internal(error.to_string()),
	}
}

fn wire_account_id(account: &AccountId<str>) -> u64 {
	if let Ok(id) = account.as_str().parse() {
		return id;
	}
	let mut hash = 0xcbf2_9ce4_8422_2325_u64;
	for byte in b"omp/auth/control-id/v1"
		.iter()
		.chain(account.as_str().as_bytes())
	{
		hash ^= u64::from(*byte);
		hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
	}
	hash
}

fn digest_u64(value: &[u8]) -> u64 {
	let digest = Hash32::sum(value);
	let mut prefix = [0_u8; 8];
	prefix.copy_from_slice(&digest.as_bytes()[..8]);
	u64::from_le_bytes(prefix) & i64::MAX as u64
}

fn usage_report(report: UsageReport) -> pb::UsageReport {
	let fetched_at_ms = report
		.windows
		.iter()
		.map(|window| usage_time_ms(window.observed_at))
		.max()
		.unwrap_or_default();
	pb::UsageReport {
		credential_id: report.account.as_str().parse().unwrap_or(0),
		provider: report.provider.as_str().to_owned(),
		plan: report
			.plan
			.map_or_else(String::new, |value| value.as_str().to_owned()),
		account: report.account.as_str().to_owned(),
		principal: report
			.principal
			.map_or_else(String::new, |value| value.as_str().to_owned()),
		account_metadata: Some(pb::usage_report::AccountMetadata {
			provider_account_id: report
				.account_meta
				.provider_account_id
				.map(|value| value.as_str().to_owned()),
			email:               report
				.account_meta
				.email
				.map(|value| value.as_str().to_owned()),
			project_id:          report
				.account_meta
				.project_id
				.map(|value| value.as_str().to_owned()),
			organization_id:     report
				.account_meta
				.organization_id
				.map(|value| value.as_str().to_owned()),
			organization_name:   report
				.account_meta
				.organization_name
				.map(|value| value.as_str().to_owned()),
		}),
		source_label: report.source_label.map(|value| value.as_str().to_owned()),
		notes: report
			.notes
			.into_vec()
			.into_iter()
			.map(|value| value.as_str().to_owned())
			.collect(),
		reset_credits: report
			.reset_credits
			.map(|reset| pb::usage_report::ResetCredits {
				available: reset.available,
				credits:   reset
					.credits
					.into_vec()
					.into_iter()
					.map(|credit| reset_credits::Credit {
						granted_at_ms: credit.granted_at.map(usage_time_ms),
						expires_at_ms: credit.expires_at.map(usage_time_ms),
						status:        credit.status.map(|value| value.as_str().to_owned()),
					})
					.collect(),
			}),
		windows: report
			.windows
			.into_iter()
			.map(|window| {
				let used_percent = match (window.amount.consumed, window.amount.limit) {
					(Some(used), Some(limit)) if limit.units != 0 => {
						(usage_quantity_f64(used) / usage_quantity_f64(limit)) * 100.0
					},
					(Some(used), None) if window.amount.unit == UsageUnit::Percent => {
						usage_quantity_f64(used)
					},
					_ => 0.0,
				};
				pb::UsageWindow {
					label: window
						.label
						.as_ref()
						.unwrap_or(&window.dimension)
						.as_str()
						.to_owned(),
					used_percent,
					resets_at_ms: window.resets_at.map_or(0, usage_time_ms),
					id: window.id.as_str().to_owned(),
					kind: match window.kind {
						UsageWindowKind::RateLimit => usage_window::Kind::RateLimit,
						UsageWindowKind::Quota => usage_window::Kind::Quota,
						UsageWindowKind::Billing => usage_window::Kind::Billing,
						UsageWindowKind::Balance => usage_window::Kind::Balance,
					} as i32,
					dimension: window.dimension.as_str().to_owned(),
					consumed: window.amount.consumed.map(|value| value.units),
					remaining: window.amount.remaining.map(|value| value.units),
					limit: window.amount.limit.map(|value| value.units),
					unit: match window.amount.unit {
						UsageUnit::Percent => usage_window::Unit::Percent,
						UsageUnit::Tokens => usage_window::Unit::Tokens,
						UsageUnit::Requests => usage_window::Unit::Requests,
						UsageUnit::Credits => usage_window::Unit::Credits,
						UsageUnit::Usd => usage_window::Unit::Usd,
						UsageUnit::Minutes => usage_window::Unit::Minutes,
						UsageUnit::Bytes => usage_window::Unit::Bytes,
						UsageUnit::Unknown => usage_window::Unit::Unknown,
					} as i32,
					consumed_decimal_exponent: window
						.amount
						.consumed
						.map_or(0, |value| u32::from(value.decimal_exponent)),
					remaining_decimal_exponent: window
						.amount
						.remaining
						.map_or(0, |value| u32::from(value.decimal_exponent)),
					limit_decimal_exponent: window
						.amount
						.limit
						.map_or(0, |value| u32::from(value.decimal_exponent)),
					scope: window.scope.map(|value| value.as_str().to_owned()),
					duration_ms: window
						.duration
						.map(|value| value.as_millis().try_into().unwrap_or(u64::MAX)),
					reset_label: window.reset_label.map(|value| value.as_str().to_owned()),
					status: window.status.map(|status| match status {
						UsageStatus::Ok => usage_window::Status::Ok,
						UsageStatus::Warning => usage_window::Status::Warning,
						UsageStatus::Exhausted => usage_window::Status::Exhausted,
						UsageStatus::Unknown => usage_window::Status::Unknown,
					} as i32),
					notes: window
						.notes
						.into_vec()
						.into_iter()
						.map(|value| value.as_str().to_owned())
						.collect(),
					observed_at_ms: usage_time_ms(window.observed_at),
					accuracy: match window.source {
						UsageSource::Provider | UsageSource::Measured => usage::Accuracy::Exact,
						UsageSource::Estimated => usage::Accuracy::Estimated,
						UsageSource::Mixed => usage::Accuracy::Mixed,
						UsageSource::Unknown => usage::Accuracy::Unspecified,
					} as i32,
				}
			})
			.collect(),
		fetched_at_ms,
		detail: None,
	}
}

fn usage_time_ms(time: time::SystemTime) -> u64 {
	time
		.duration_since(time::UNIX_EPOCH)
		.map_or(0, |duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
}

fn usage_quantity_f64(quantity: UsageQuantity) -> f64 {
	quantity.units as f64 / 10_f64.powi(i32::from(quantity.decimal_exponent))
}
fn failed_health(
	credential_id: u64,
	provider: ProviderId,
	elapsed: Duration,
	error: &InferenceError,
) -> pb::CredentialHealth {
	pb::CredentialHealth {
		credential_id,
		provider: provider.as_str().to_owned(),
		healthy: false,
		status_code: error.status.map(u32::from),
		latency_ms: elapsed_ms(elapsed),
		error_class: error_class(error) as i32,
	}
}

fn elapsed_ms(elapsed: Duration) -> u64 {
	elapsed.as_millis().try_into().unwrap_or(u64::MAX)
}

const fn error_class(error: &InferenceError) -> credential_health::ErrorClass {
	match error.status {
		Some(401) => return credential_health::ErrorClass::Authentication,
		Some(403) => return credential_health::ErrorClass::Authorization,
		Some(408) => return credential_health::ErrorClass::Timeout,
		Some(429) => return credential_health::ErrorClass::RateLimited,
		Some(500..=599) => return credential_health::ErrorClass::Upstream,
		_ => {},
	}
	match error.kind {
		ErrorKind::Authentication
		| ErrorKind::CredentialStorageUnavailable
		| ErrorKind::AccountDisabled => credential_health::ErrorClass::Authentication,
		ErrorKind::Authorization | ErrorKind::PaymentRequired => {
			credential_health::ErrorClass::Authorization
		},
		ErrorKind::RateLimited => credential_health::ErrorClass::RateLimited,
		ErrorKind::QuotaExhausted | ErrorKind::BudgetExhausted => {
			credential_health::ErrorClass::Quota
		},
		ErrorKind::Dns
		| ErrorKind::Tls
		| ErrorKind::Connectivity
		| ErrorKind::Protocol
		| ErrorKind::StreamCorruption => credential_health::ErrorClass::Connectivity,
		ErrorKind::Cancelled | ErrorKind::DeadlineExceeded => credential_health::ErrorClass::Timeout,
		ErrorKind::InvalidRequest
		| ErrorKind::PayloadRejected
		| ErrorKind::TargetNotFound
		| ErrorKind::CapabilityUnknown
		| ErrorKind::CodecMismatch
		| ErrorKind::CapabilityMismatch
		| ErrorKind::NativeRequestRejected => credential_health::ErrorClass::InvalidRequest,
		ErrorKind::RouteUnavailable
		| ErrorKind::StalePlan
		| ErrorKind::ReplayRequired
		| ErrorKind::StagingRequired
		| ErrorKind::ProviderContractMismatch
		| ErrorKind::ContextOverflow
		| ErrorKind::ContentFilter
		| ErrorKind::SafetyRefusal
		| ErrorKind::MalformedModelOutput
		| ErrorKind::StructuredOutputFailure
		| ErrorKind::ToolNonCompliance
		| ErrorKind::RepeatedReasoning
		| ErrorKind::RepeatedToolCall
		| ErrorKind::EmptyCompletion
		| ErrorKind::EmptyOutput
		| ErrorKind::SessionExpired
		| ErrorKind::SessionConflict
		| ErrorKind::LocalModelUnavailable
		| ErrorKind::ResourceExhausted => credential_health::ErrorClass::Upstream,
		ErrorKind::PolicyBufferExceeded | ErrorKind::InternalInvariant => {
			credential_health::ErrorClass::Internal
		},
	}
}
fn inference_status(error: omp_ai::Error) -> Status {
	Status::failed_precondition(error.to_string())
}
#[cfg(test)]
mod tests {
	use omp_ai::{
		Error, ErrorKind,
		error::{ErrorPhase, RetryAction},
		receipt::ExecutionReceipt,
	};

	use super::{
		AuthFlow, AuthenticatedRevealContext, authenticated_reveal_context, credential_health,
		error_class, pb, reap_expired_flow,
	};

	#[test]
	fn reveal_rpc_rejects_requests_without_server_authenticated_context() {
		let request = tonic::Request::new(pb::RevealCredentialRequest::default());
		assert_eq!(
			authenticated_reveal_context(&request)
				.expect_err("wire claims cannot authenticate credential reveal")
				.code(),
			tonic::Code::PermissionDenied,
		);
	}

	#[test]
	fn reveal_rpc_uses_only_server_authenticated_identity_and_scope() {
		let authority = AuthenticatedRevealContext::new(
			"fixture.extension",
			"principal",
			[omp_catalog::ProviderId::from("openai")],
			11,
			13,
		);
		let request = pb::RevealCredentialRequest {
			id:                 7,
			provider:           "openai".to_owned(),
			extension:          "fixture.extension".to_owned(),
			caller_principal:   "principal".to_owned(),
			host_generation:    11,
			session_generation: 13,
			request_id:         17,
			reason:             "extension_control_reveal".to_owned(),
		};
		let audit = authority
			.audited_reveal(&request)
			.expect("matching authenticated reveal");
		assert_eq!(audit.extension.as_str(), "fixture.extension");
		assert_eq!(audit.caller_principal.as_str(), "principal");
		assert_eq!(audit.provider.as_str(), "openai");
		assert_eq!(audit.host_generation, 11);
		assert_eq!(audit.session_generation, 13);

		let forged = pb::RevealCredentialRequest { caller_principal: "forged".to_owned(), ..request };
		assert_eq!(
			authority
				.audited_reveal(&forged)
				.expect_err("caller-asserted identity must not authorize reveal")
				.code(),
			tonic::Code::PermissionDenied
		);
	}

	#[test]
	fn expired_auth_flow_is_removed_and_cancelled() {
		let (session, driver, _) =
			omp_ai::auth::default_login_channels(omp_ai::LoginSessionId::from("expired-flow"));
		let flows = parking_lot::Mutex::new(std::collections::BTreeMap::from([(
			"expired-flow".to_owned(),
			AuthFlow { session, expires_at: std::time::Instant::now() },
		)]));
		assert!(reap_expired_flow(&flows, "expired-flow", std::time::Instant::now(),));
		assert!(driver.cancellation().is_cancelled());
		assert!(flows.lock().is_empty());
	}

	#[test]
	fn credential_probe_failures_keep_typed_http_health() {
		let error = Error::new(
			ErrorKind::Connectivity,
			ErrorPhase::Connecting,
			RetryAction::Never,
			ExecutionReceipt::default(),
		)
		.status(Some(401));
		assert_eq!(error_class(&error), credential_health::ErrorClass::Authentication,);
	}
}
