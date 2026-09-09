//! Production typed inference registry construction and daemon lifecycle.

use std::{
	env, fs, io,
	net::SocketAddr,
	path::{Path, PathBuf},
	str,
	sync::Arc,
	time::Duration,
};

use omp_ai::{
	Client, ProviderService, Registry,
	account::AccountStateStoreError,
	auth::{
		AuthManagerBuildError, CredentialAcquisitionLoginEngineError, FileKeyError, KeyError,
		OAuthLoginEngineError, SecretLoginEngineError, StoreError, oauth::OAuthCustomDispatchError,
	},
	layer::observe::{ExecutionFinished, ExecutionStarted, Observer},
	router::Router,
	session::{ConversationError, ConversationSessionPlanner},
};
use omp_core::{ExposeSecret as _, SecretString, sf};
use omp_journal::blob::{self, BlobStore};
use omp_proto::{
	auth::v1::auth_server::AuthServer,
	blob::v1::blob_server::BlobServer,
	gateway::v1::{forward_proxy_server::ForwardProxyServer, gateway_server::GatewayServer},
	inference::v1::inference_server::InferenceServer,
};
use omp_serve::{auth::AuthRpc, blob::BlobRpc, inference::InferenceRpc};
use parking_lot::RwLock;
use tokio::{
	net::TcpListener,
	sync::watch::{self, Receiver},
	task::{JoinError, JoinHandle},
	time,
};
use tokio_stream::wrappers::TcpListenerStream;
use tonic::{Request, Status, transport, transport::Server};
use zeroize::Zeroizing;

use crate::{endpoint::LocalEndpoint, gateway_rpc::GatewayRpc};

const DATA_DIR_ENV: &str = "OMP_DATA_DIR";
/// Production daemon construction options.
pub struct DaemonConfig {
	data_dir:          Option<PathBuf>,
	endpoint:          LocalEndpoint,
	bearer_token_file: Option<PathBuf>,
}

impl DaemonConfig {
	/// Creates the standard owner-local daemon configuration.
	pub fn local(endpoint: impl Into<LocalEndpoint>) -> Self {
		let data_dir = env::var_os(DATA_DIR_ENV)
			.map(PathBuf::from)
			.or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share/omp")));
		Self { data_dir, endpoint: endpoint.into(), bearer_token_file: None }
	}

	/// Creates a bearer-authenticated TCP daemon configuration.
	pub fn tcp(address: SocketAddr, bearer_token_file: impl Into<PathBuf>) -> Self {
		let mut config = Self::local(LocalEndpoint::tcp(address));
		config.bearer_token_file = Some(bearer_token_file.into());
		config
	}

	/// Overrides the directory containing encrypted credentials and session
	/// state.
	pub fn with_data_dir(mut self, data_dir: PathBuf) -> Self {
		self.data_dir = Some(data_dir);
		self
	}
}

/// Runtime facts available once registry construction succeeds.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DaemonReadiness {
	/// Requested local-socket or TCP endpoint.
	pub endpoint: LocalEndpoint,
	/// Number of catalog routes backed by constructed services.
	pub routes:   usize,
}

/// A production daemon startup or lifecycle failure.
#[derive(Debug, thiserror::Error)]
pub enum DaemonError {
	/// Neither an explicit data directory nor `OMP_DATA_DIR`/`HOME` was
	/// available.
	#[error("daemon data directory is unavailable; set OMP_DATA_DIR or HOME")]
	MissingDataDirectory,
	/// Durable state directory could not be prepared.
	#[error("could not prepare daemon state directory")]
	PrepareState(#[source] io::Error),
	/// The checked-in catalog snapshot is invalid.
	#[error("embedded catalog snapshot is invalid")]
	Catalog(#[source] &'static omp_catalog::snapshot::SnapshotError),
	/// Registry construction or route service failed.
	#[error(transparent)]
	Inference(#[from] Box<omp_ai::Error>),
	/// Encrypted credential state could not be opened.
	#[error(transparent)]
	CredentialStore(#[from] StoreError),
	/// Credential encryption key provisioning failed.
	#[error(transparent)]
	CredentialKey(#[from] KeyError),
	/// Owner-only credential key file provisioning failed.
	#[error(transparent)]
	CredentialKeyFile(#[from] FileKeyError),
	/// Durable account state could not be opened.
	#[error(transparent)]
	AccountState(#[from] AccountStateStoreError),
	/// A static secret login engine was configured with an unsupported method.
	#[error(transparent)]
	SecretLogin(#[from] SecretLoginEngineError),
	/// A credential acquisition engine was configured with an unsupported
	/// method.
	#[error(transparent)]
	CredentialAcquisitionLogin(#[from] CredentialAcquisitionLoginEngineError),
	/// An OAuth login engine was configured with an unsupported method.
	#[error(transparent)]
	OAuthLogin(#[from] OAuthLoginEngineError),
	/// A built-in custom OAuth exchange handler could not be registered.
	#[error(transparent)]
	OAuthCustom(#[from] OAuthCustomDispatchError),
	/// Refresh coordination policy was invalid.
	#[error(transparent)]
	RefreshPolicy(#[from] omp_ai::account::RefreshPolicyError),
	/// The catalog advertised an authentication method without a concrete
	/// engine.
	#[error(transparent)]
	AuthManager(#[from] AuthManagerBuildError),
	/// Durable conversation state could not be opened.
	#[error(transparent)]
	Conversation(#[from] ConversationError),
	/// Content-addressed blob state could not be opened.
	#[error(transparent)]
	BlobStore(#[from] blob::Error),
	/// Owner-local RPC listener could not bind.
	#[error("could not bind owner-local RPC endpoint")]
	RpcListen(#[source] omp_rpc::Error),
	/// TCP RPC listener could not bind.
	#[error("could not bind TCP gateway endpoint")]
	TcpListen(#[source] io::Error),
	/// A TCP listener was configured without bearer authentication.
	#[error("TCP gateway endpoints require bearer authentication")]
	UnauthenticatedTcp,
	/// The gateway bearer token could not be loaded.
	#[error("could not load gateway bearer token")]
	GatewayToken(#[source] io::Error),
	/// The gateway bearer token file contained no token.
	#[error("gateway bearer token file is empty")]
	EmptyGatewayToken,
	/// Tonic RPC serving failed.
	#[error("inference RPC server failed")]
	RpcServe(#[source] transport::Error),
	/// The daemon RPC task failed to join.
	#[error("inference RPC task failed")]
	RpcTask(#[source] JoinError),
	/// The RPC server exited before a shutdown request.
	#[error("inference RPC server stopped unexpectedly")]
	RpcStopped,
	/// Signal handling failed.
	#[error("shutdown signal handling failed")]
	Signal(#[source] io::Error),
	/// Driver-owned production registry composition failed.
	#[error(transparent)]
	Registry(#[from] omp_driver::registry::RegistryError),
}

impl From<omp_ai::Error> for DaemonError {
	fn from(error: omp_ai::Error) -> Self {
		Self::Inference(Box::new(error))
	}
}

#[derive(Clone, Copy)]
struct TracingObservation;

impl Observer for TracingObservation {
	fn started(&self, event: ExecutionStarted) {
		tracing::debug!(execution = ?event, "inference execution started");
	}

	fn finished(&self, event: ExecutionFinished) {
		tracing::debug!(execution = ?event, "inference execution finished");
	}
}

#[derive(Clone)]
struct BearerAuth {
	token: Arc<RwLock<SecretString>>,
}

impl BearerAuth {
	fn authorize(&mut self, request: Request<()>) -> Result<Request<()>, Status> {
		let supplied = request
			.metadata()
			.get("authorization")
			.and_then(|value| value.to_str().ok())
			.and_then(|value| value.strip_prefix("Bearer "));
		let token = self.token.read();
		let valid = supplied.is_some_and(|supplied| {
			omp_core::ct_eq(supplied.as_bytes(), token.expose_secret().as_bytes())
		});
		if valid {
			Ok(request)
		} else {
			tracing::warn!("gateway authentication denied");
			Err(Status::unauthenticated("valid gateway bearer token required"))
		}
	}
}

fn bearer_interceptor(
	mut auth: BearerAuth,
) -> impl FnMut(Request<()>) -> Result<Request<()>, Status> + Clone {
	move |request| auth.authorize(request)
}

fn load_gateway_token(path: &Path) -> Result<SecretString, DaemonError> {
	let bytes = Zeroizing::new(fs::read(path).map_err(DaemonError::GatewayToken)?);
	parse_gateway_token(&bytes).ok_or(DaemonError::EmptyGatewayToken)
}

fn parse_gateway_token(bytes: &[u8]) -> Option<SecretString> {
	let value = str::from_utf8(bytes).ok()?.trim();
	(!value.is_empty()).then(|| SecretString::from(value.to_owned()))
}

async fn watch_gateway_token(
	path: PathBuf,
	token: Arc<RwLock<SecretString>>,
	mut shutdown: Receiver<bool>,
) {
	let mut interval = time::interval(Duration::from_millis(250));
	loop {
		tokio::select! {
			_ = interval.tick() => {
				if let Ok(bytes) = tokio::fs::read(&path).await {
					let bytes = Zeroizing::new(bytes);
					if let Some(next) = parse_gateway_token(&bytes)
						&& next.expose_secret() != token.read().expose_secret()
					{
						*token.write() = next;
						tracing::debug!("gateway bearer token reloaded");
					}
				}
			},
			changed = shutdown.changed() => {
				if changed.is_err() || *shutdown.borrow() {
					return;
				}
			},
		}
	}
}

/// Running comprehensive inference registry.
pub struct DaemonHandle {
	readiness:  DaemonReadiness,
	registry:   Registry,
	shutdown:   watch::Sender<bool>,
	rpc_task:   JoinHandle<Result<(), transport::Error>>,
	token_task: Option<JoinHandle<()>>,
}

impl DaemonHandle {
	/// Loads the immutable catalog and constructs every built-in route service
	/// with an empty shared tool registry.
	pub async fn start(config: DaemonConfig) -> Result<Self, DaemonError> {
		Self::start_with_tool_registry(config, Arc::new(omp_tool::Registry::new())).await
	}

	/// Starts inference with the same revision registry used by environment
	/// dispatch in a composed application.
	pub async fn start_with_tool_registry(
		config: DaemonConfig,
		tool_registry: Arc<omp_tool::Registry>,
	) -> Result<Self, DaemonError> {
		let data_dir = config
			.data_dir
			.clone()
			.ok_or(DaemonError::MissingDataDirectory)?;
		fs::create_dir_all(&data_dir).map_err(DaemonError::PrepareState)?;
		let omp_driver::registry::ProductionInference {
			registry, rpc: inference, auth_control, ..
		} = omp_driver::registry::production_inference(&data_dir, tool_registry, None).await?;
		Self::start_rpc(config, data_dir, registry, inference, Some(auth_control)).await
	}

	/// Starts the production RPC service set around a deterministic test
	/// registry while retaining the gateway's real context and replay authority.
	#[doc(hidden)]
	pub async fn start_for_test(
		config: DaemonConfig,
		registry: Registry,
		sessions: ConversationSessionPlanner,
		tool_registry: Arc<omp_tool::Registry>,
		live_responses: flume::Sender<omp_ai::event::WorkflowResponse>,
	) -> Result<Self, DaemonError> {
		let data_dir = config
			.data_dir
			.clone()
			.ok_or(DaemonError::MissingDataDirectory)?;
		fs::create_dir_all(&data_dir).map_err(DaemonError::PrepareState)?;
		let inference =
			InferenceRpc::new_for_test(registry.clone(), sessions, tool_registry, live_responses);
		Self::start_rpc(config, data_dir, registry, inference, None).await
	}

	async fn start_rpc(
		config: DaemonConfig,
		data_dir: PathBuf,
		registry: Registry,
		inference: InferenceRpc,
		auth_control: Option<omp_ai::auth::AuthControlHandle>,
	) -> Result<Self, DaemonError> {
		let routes = registry
			.catalog()
			.routes()
			.iter()
			.filter(|route| registry.contains_service(&route.id))
			.count();
		let endpoint = config.endpoint;
		let bearer_token_file = config.bearer_token_file;
		let (shutdown, mut rpc_shutdown) = watch::channel(false);
		let blobs = Arc::new(BlobStore::open(&data_dir)?);
		let auth_rpc = auth_control.map_or_else(
			|| AuthRpc::new(registry.clone()),
			|control| AuthRpc::with_control(registry.clone(), control),
		);
		let hello = || {
			omp_rpc::HelloService::new(env!("CARGO_PKG_VERSION"), vec![
				sf!("auth"),
				sf!("inference.native"),
				sf!("gateway.forward"),
			])
		};
		let (rpc_task, token_task) = match &endpoint {
			LocalEndpoint::Local(path) => {
				let incoming = omp_rpc::uds::listen(path)
					.await
					.map_err(DaemonError::RpcListen)?;
				let inference_service = InferenceServer::new(inference.clone());
				let gateway = GatewayServer::new(hello());
				let forward = ForwardProxyServer::new(GatewayRpc::new(inference.clone()));
				let auth = AuthServer::new(auth_rpc.clone());
				let blobs = BlobServer::new(BlobRpc::new(blobs.clone()));
				let task = tokio::spawn(async move {
					Server::builder()
						.add_service(gateway)
						.add_service(forward)
						.add_service(inference_service)
						.add_service(blobs)
						.add_service(auth)
						.serve_with_incoming_shutdown(incoming, async move {
							while !*rpc_shutdown.borrow() && rpc_shutdown.changed().await.is_ok() {}
						})
						.await
				});
				(task, None)
			},
			LocalEndpoint::Tcp(address) => {
				let path = bearer_token_file.ok_or(DaemonError::UnauthenticatedTcp)?;
				let listener = TcpListener::bind(address)
					.await
					.map_err(DaemonError::TcpListen)?;
				let incoming = TcpListenerStream::new(listener);
				{
					let auth_state =
						BearerAuth { token: Arc::new(RwLock::new(load_gateway_token(&path)?)) };
					let token_shutdown = rpc_shutdown.clone();
					let token_task =
						tokio::spawn(watch_gateway_token(path, auth_state.token.clone(), token_shutdown));
					let inference_service = InferenceServer::with_interceptor(
						inference.clone(),
						bearer_interceptor(auth_state.clone()),
					);
					let gateway =
						GatewayServer::with_interceptor(hello(), bearer_interceptor(auth_state.clone()));
					let forward = ForwardProxyServer::with_interceptor(
						GatewayRpc::new(inference.clone()),
						bearer_interceptor(auth_state.clone()),
					);
					let auth = AuthServer::with_interceptor(
						auth_rpc.clone(),
						bearer_interceptor(auth_state.clone()),
					);
					let blobs = BlobServer::with_interceptor(
						BlobRpc::new(blobs.clone()),
						bearer_interceptor(auth_state),
					);
					let task = tokio::spawn(async move {
						Server::builder()
							.add_service(gateway)
							.add_service(forward)
							.add_service(inference_service)
							.add_service(blobs)
							.add_service(auth)
							.serve_with_incoming_shutdown(incoming, async move {
								while !*rpc_shutdown.borrow() && rpc_shutdown.changed().await.is_ok() {}
							})
							.await
					});
					(task, Some(token_task))
				}
			},
		};
		tracing::info!(endpoint = %endpoint, routes, "daemon listening");
		Ok(Self {
			readiness: DaemonReadiness { endpoint, routes },
			registry,
			shutdown,
			rpc_task,
			token_task,
		})
	}

	/// Returns registry readiness facts.
	pub const fn readiness(&self) -> &DaemonReadiness {
		&self.readiness
	}

	/// Returns a clone-cheap comprehensive operation service.
	pub fn service(&self) -> ProviderService {
		self.registry.service_with_observer(TracingObservation)
	}

	/// Creates a typed client using caller-provided call metadata.
	pub fn client(&self, meta: omp_ai::CallMeta) -> Client<ProviderService, Router> {
		Client::new(self.service(), Router::new(self.registry.clone(), Duration::from_secs(30)), meta)
	}

	/// Waits for process shutdown, cleans up daemon-owned tasks, then preserves
	/// the identity of the signal that requested shutdown.
	pub async fn wait(mut self) -> Result<(), DaemonError> {
		let signal = tokio::select! {
			signal = shutdown_signal() => signal.map_err(DaemonError::Signal)?,
			result = &mut self.rpc_task => {
				result.map_err(DaemonError::RpcTask)?.map_err(DaemonError::RpcServe)?;
				return Err(DaemonError::RpcStopped);
			},
		};
		self.finish_shutdown().await?;
		signal.finish().map_err(DaemonError::Signal)
	}

	/// Initiates graceful shutdown.
	pub async fn shutdown(self) -> Result<(), DaemonError> {
		self.finish_shutdown().await
	}

	async fn finish_shutdown(mut self) -> Result<(), DaemonError> {
		let _ = self.shutdown.send(true);
		(&mut self.rpc_task)
			.await
			.map_err(DaemonError::RpcTask)?
			.map_err(DaemonError::RpcServe)?;
		if let Some(task) = self.token_task.take() {
			task.await.map_err(DaemonError::RpcTask)?;
		}
		#[cfg(unix)]
		if let LocalEndpoint::Local(path) = &self.readiness.endpoint {
			match tokio::fs::remove_file(path).await {
				Ok(()) => {},
				Err(error) if error.kind() == io::ErrorKind::NotFound => {},
				Err(error) => return Err(DaemonError::PrepareState(error)),
			}
		}

		tracing::info!(endpoint = %self.readiness.endpoint, "daemon stopped");
		Ok(())
	}
}
#[cfg(test)]
mod gateway_bearer_tests {
	use std::sync::Arc;

	use omp_core::SecretString;
	use tonic::{Code, Request, metadata::MetadataValue};

	use super::{BearerAuth, RwLock};

	fn request(token: &str) -> Request<()> {
		let mut request = Request::new(());
		request
			.metadata_mut()
			.insert("authorization", MetadataValue::try_from(token).expect("metadata"));
		request
	}

	#[test]
	fn bearer_auth_rejects_bad_tokens_and_observes_rotation() {
		let token = Arc::new(RwLock::new(SecretString::from("first-token")));
		let mut auth = BearerAuth { token: token.clone() };
		let error = auth
			.authorize(request("Bearer wrong-token"))
			.expect_err("bad bearer must fail");
		assert_eq!(error.code(), Code::Unauthenticated);
		auth
			.authorize(request("Bearer first-token"))
			.expect("current bearer");

		*token.write() = SecretString::from("rotated-token");
		assert!(
			auth.authorize(request("Bearer first-token")).is_err(),
			"rotated-out bearer must stop authorizing",
		);
		auth
			.authorize(request("Bearer rotated-token"))
			.expect("rotated bearer");
	}
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ShutdownSignal {
	Interrupt,
	#[cfg(unix)]
	Terminate,
	#[cfg(unix)]
	Hangup,
}

impl ShutdownSignal {
	#[cfg(unix)]
	const fn number(self) -> i32 {
		match self {
			Self::Interrupt => libc::SIGINT,
			Self::Terminate => libc::SIGTERM,
			Self::Hangup => libc::SIGHUP,
		}
	}

	#[cfg(unix)]
	fn finish(self) -> Result<(), io::Error> {
		let number = self.number();
		// Safety: restoring the default disposition before re-raising is the
		// only way to retain both graceful cleanup and the original signal
		// identity after Tokio's process-wide signal handler observed it.
		unsafe {
			libc::signal(number, libc::SIG_DFL);
			if libc::raise(number) != 0 {
				return Err(io::Error::last_os_error());
			}
		}
		Err(io::Error::other("shutdown signal did not terminate the process"))
	}

	#[cfg(windows)]
	const fn finish(self) -> Result<(), io::Error> {
		Ok(())
	}
}

#[cfg(unix)]
async fn shutdown_signal() -> Result<ShutdownSignal, io::Error> {
	use tokio::signal::unix::{SignalKind, signal};

	let mut interrupt = signal(SignalKind::interrupt())?;
	let mut terminate = signal(SignalKind::terminate())?;
	let mut hangup = signal(SignalKind::hangup())?;
	tokio::select! {
		_ = interrupt.recv() => Ok(ShutdownSignal::Interrupt),
		_ = terminate.recv() => Ok(ShutdownSignal::Terminate),
		_ = hangup.recv() => Ok(ShutdownSignal::Hangup),
	}
}

#[cfg(windows)]
async fn shutdown_signal() -> Result<ShutdownSignal, io::Error> {
	use tokio::signal::ctrl_c;
	ctrl_c().await?;
	Ok(ShutdownSignal::Interrupt)
}

#[cfg(all(test, unix))]
mod shutdown_tests {
	use super::ShutdownSignal;

	#[test]
	fn shutdown_signals_retain_conventional_identity() {
		assert_eq!(ShutdownSignal::Interrupt.number(), libc::SIGINT);
		assert_eq!(ShutdownSignal::Terminate.number(), libc::SIGTERM);
		assert_eq!(ShutdownSignal::Hangup.number(), libc::SIGHUP);
		assert_eq!(128 + ShutdownSignal::Interrupt.number(), 130);
		assert_eq!(128 + ShutdownSignal::Terminate.number(), 143);
		assert_eq!(128 + ShutdownSignal::Hangup.number(), 129);
	}
}
