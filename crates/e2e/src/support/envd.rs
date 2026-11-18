#![cfg(unix)]

use std::{
	fs, future, io,
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};

use bytes::BytesMut;
use flume::Receiver;
use omp_driver::discovery::native::AdmittedNativeExtension;
use omp_env::{
	Admitter, BlobDownloadEvent, EnvClient, FramePipe, InProcessEnvTransport, in_process_frames,
};
use omp_envd::{
	ActiveContentInputs, EnvServer, RegistryBridges, exthost::ConvarControlFactory,
	worker::ExtHostConfig,
};
use omp_ext::workspace_trust::WorkspaceTrust;
use omp_proto::{
	SCHEMA_REV,
	blob::v1::GetRequest,
	env::v1::{
		Admission, AdmitInvocation, ClientFrame, ClientHello, ServerFrame, client_frame, server_frame,
	},
	prost::Message,
};
use omp_tool::Registry;
use tokio::{
	io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _, split},
	net::UnixStream,
	process::Command,
	task::JoinHandle,
	time,
};
use tokio_util::sync::CancellationToken;

use super::{
	DEFAULT_TIMEOUT, OwnedProcess, PythonExtension, Scratch, granted::install_admitted,
	install_omp_binary_env, omp_binary, within,
};
use crate::{Context as _, Result, error};

const FRAME_LIMIT: usize = 64 * 1024 * 1024;
const PROCESS_START_TIMEOUT: Duration = Duration::from_secs(15);
/// Grace a closing in-process authority gives its managed processes, matching
/// the interrupt grace the P8 recorder measures cancellation against.

/// Session identity every harness constructor gives its worker-capable host.
const SESSION_ID: &str = "e2e-session";
const SESSION_GENERATION: u64 = 1;

/// Test policy that accepts legitimate invocation admission queries unchanged.
pub struct AllowAdmission;

impl Admitter for AllowAdmission {
	type Future<'client> = future::Ready<Admission>;

	fn admit(&self, query: AdmitInvocation) -> Self::Future<'_> {
		future::ready(Admission {
			invocation_id: query.invocation_id,
			allow: true,
			..Admission::default()
		})
	}
}

/// Worker-capable host configuration, control context and convar authority
/// shared by every harness constructor.
fn open_inputs() -> Result<(ExtHostConfig, Arc<omp_con::Ctx>, Arc<ConvarControlFactory>)> {
	install_omp_binary_env().context("exposing worker-capable host")?;
	let ext_host_config = ExtHostConfig::new(
		omp_binary().context("resolving worker-capable host")?,
		omp_core::Principal::new(omp_core::sf!("e2e-tester"), omp_core::sf!("E2E Tester")),
		omp_core::Str::new_static(SESSION_ID),
		SESSION_GENERATION,
	);
	let con = Arc::new(omp_con::Ctx::new());
	let convars = Arc::new(ConvarControlFactory::new(Arc::clone(&con)));
	Ok((ext_host_config, con, convars))
}

/// Real local environment authority with framed UDS transport and owned
/// worker/process resources.
pub struct EnvHarness {
	client:      EnvClient,
	socket:      PathBuf,
	shutdown:    CancellationToken,
	server_task: Option<JoinHandle<Result<(), omp_envd::EnvdError>>>,
	client_task: Option<JoinHandle<io::Result<()>>>,
	server:      Arc<EnvServer>,
}

impl EnvHarness {
	/// Opens all real local environment resources and completes a framed client
	/// hello.
	pub async fn spawn(scratch: &Scratch, _registry: Registry) -> Result<Self> {
		let (ext_host_config, con, convars) = open_inputs()?;
		let server = EnvServer::open_local(
			scratch.project(),
			scratch.state(),
			Registry::new(),
			ext_host_config,
			&con,
			convars,
			RegistryBridges::default(),
		)
		.await
		.context("opening local environment authority")?;
		Self::serve(scratch, server).await
	}

	/// Opens the project-mode environment authority the production `envd` runs
	/// for a trusted workspace: it starts the real document daemon on a private
	/// socket with native language-server discovery enabled, so `.lsp.json`
	/// servers in the project are started on first use and serve the `lsp`
	/// tool. An untrusted workspace never loads them (trust slice 4).
	pub async fn spawn_project(scratch: &Scratch) -> Result<Self> {
		let (ext_host_config, con, convars) = open_inputs()?;
		let server = EnvServer::open_project(
			scratch.project(),
			scratch.state(),
			&scratch.socket("docserver.sock"),
			Registry::new(),
			ext_host_config,
			None,
			false,
			None,
			&con,
			convars,
			RegistryBridges {
				content: ActiveContentInputs {
					workspace_trust: WorkspaceTrust::Trusted,
					..ActiveContentInputs::default()
				},
				..RegistryBridges::default()
			},
		)
		.await
		.context("opening project environment authority")?;
		Self::serve(scratch, server).await
	}

	async fn serve(scratch: &Scratch, server: EnvServer) -> Result<Self> {
		let socket = scratch.socket("env.sock");
		let server = Arc::new(server);
		let shutdown = CancellationToken::new();
		let task_server = Arc::clone(&server);
		let task_socket = socket.clone();
		let task_shutdown = shutdown.clone();
		let server_task = tokio::spawn(async move {
			task_server
				.serve_uds(&task_socket, task_shutdown, None)
				.await
		});
		wait_socket(&socket, DEFAULT_TIMEOUT).await?;
		let (client, client_task) = connect_env(&socket).await?;
		within(
			"environment hello",
			DEFAULT_TIMEOUT,
			client.hello(ClientHello {
				client: "omp-e2e".to_owned(),
				schema_rev: SCHEMA_REV,
				..Default::default()
			}),
		)
		.await??;
		Ok(Self {
			client,
			socket,
			shutdown,
			server_task: Some(server_task),
			client_task: Some(client_task),
			server,
		})
	}

	/// Starts the production `envd` process from `executable` attached to an
	/// existing real docserver, which must advertise the daemon's build
	/// ([`super::DocServerTask::spawn_for_daemon`] given this same
	/// `executable`, the canonical [`omp_binary`]).
	///
	/// The child's `HOME` and its user config, data, state and cache roots
	/// live under `scratch`, so the developer's `~/.o2` configuration never
	/// reaches it and the shipped defaults (such as the `workspace-write`
	/// sandbox) apply.
	pub async fn spawn_attached(
		scratch: &Scratch,
		executable: &Path,
		docserver_socket: &Path,
	) -> Result<ProcessEnvHarness> {
		install_omp_binary_env().context("exposing worker-capable host")?;
		let socket = scratch.socket("env-attached.sock");
		let home = scratch.root().join("home");
		for root in ["config", "data", "state", "cache"] {
			fs::create_dir_all(home.join(root)).context("creating isolated daemon home")?;
		}
		let mut command = Command::new(executable);
		command
			.arg("envd")
			.arg("--root")
			.arg(scratch.project())
			.arg("--socket")
			.arg(&socket)
			.arg("--docserver-socket")
			.arg(docserver_socket)
			.arg("--state-dir")
			.arg(scratch.state())
			.env("HOME", &home)
			.env("OMP_CONFIG_DIR", home.join("config"))
			.env("OMP_DATA_DIR", home.join("data"))
			.env("OMP_STATE_DIR", home.join("state"))
			.env("OMP_CACHE_DIR", home.join("cache"));
		let process = OwnedProcess::spawn(command).context("starting attached environment daemon")?;
		wait_socket(&socket, PROCESS_START_TIMEOUT).await?;
		let (client, client_task) = connect_env(&socket).await?;
		hello_env(&client, "omp-e2e-attached", &[]).await?;
		Ok(ProcessEnvHarness {
			client,
			socket,
			client_task: Some(client_task),
			process: Some(process),
		})
	}

	/// Opens an independent framed connection and completes its hello.
	pub async fn connect_client(&self, name: &str) -> Result<FramedEnvConnection> {
		FramedEnvConnection::connect(&self.socket, name).await
	}

	/// Returns the hello-complete environment client.
	pub const fn client(&self) -> &EnvClient {
		&self.client
	}

	/// Returns a clone of the hello-complete environment client.
	pub fn client_clone(&self) -> EnvClient {
		self.client.clone()
	}

	/// Returns the final production registry assembled beside environment
	/// resources.
	pub fn registry(&self) -> Arc<Registry> {
		self.server.registry()
	}

	/// Returns the owner-local environment socket.
	pub fn socket(&self) -> &Path {
		&self.socket
	}

	/// Gracefully stops the authority and removes its endpoint.
	pub async fn shutdown(mut self) -> Result<()> {
		self.stop().await
	}

	async fn stop(&mut self) -> Result<()> {
		self.shutdown.cancel();
		if let Some(task) = self.server_task.take() {
			within("environment shutdown", DEFAULT_TIMEOUT, task)
				.await??
				.context("environment server stopped with an error")?;
		}
		if let Some(task) = self.client_task.take() {
			task.abort();
			let _ = task.await;
		}
		remove_socket(&self.socket)?;
		Ok(())
	}
}

impl Drop for EnvHarness {
	fn drop(&mut self) {
		self.shutdown.cancel();
		if let Some(task) = self.server_task.take() {
			task.abort();
		}
		if let Some(task) = self.client_task.take() {
			task.abort();
		}
		let _ = remove_socket(&self.socket);
	}
}

/// Roots an in-process authority runs on, owned for the authority's lifetime.
enum InProcessRoots {
	Scratch(Scratch),
	Rooted { project: PathBuf, _state: tempfile::TempDir },
}

/// Which [`EnvServer::open_*`] constructor builds the in-process authority.
enum OpenKind {
	Local,
	Project { docserver_socket: PathBuf },
	SessionHost { owner: EnvClient },
}

#[derive(Clone, Copy)]
enum Registered<'a> {
	Fixture(&'a PythonExtension),
	Admitted(&'a AdmittedNativeExtension),
}

/// Owner resources [`OpenKind::SessionHost`] keeps alive for the harness
/// lifetime.
struct SessionOwner {
	_server:     Arc<EnvServer>,
	_connection: InProcessConnection,
}

/// In-process environment authority used by the P8 recorder.
///
/// It serves `EnvClient::in_process` channels, so no process, socket or frame
/// codec sits between a client and the production host.
pub struct InProcessEnvHarness {
	primary:   InProcessConnection,
	data_task: Option<JoinHandle<()>>,
	shutdown:  CancellationToken,
	server:    Arc<EnvServer>,
	roots:     InProcessRoots,
	_owner:    Option<SessionOwner>,
}

/// One hello-complete client connection to an [`InProcessEnvHarness`].
pub struct InProcessConnection {
	client:   EnvClient,
	_serving: InProcessServing,
}

/// The serving task behind one in-process connection; dropping it closes the
/// connection.
pub struct InProcessServing {
	task: JoinHandle<()>,
}

impl InProcessServing {
	fn start(server: &Arc<EnvServer>, transport: InProcessEnvTransport) -> Self {
		let server = Arc::clone(server);
		Self { task: tokio::spawn(async move { server.serve_in_process(transport).await }) }
	}

	async fn stop(&mut self) {
		self.task.abort();
		let _ = (&mut self.task).await;
	}
}

impl Drop for InProcessServing {
	fn drop(&mut self) {
		self.task.abort();
	}
}

impl InProcessConnection {
	async fn open(server: &Arc<EnvServer>, name: &str) -> Result<Self> {
		let (client, transport) = EnvClient::in_process(64);
		client.set_admitter(AllowAdmission);
		let serving = InProcessServing::start(server, transport);
		hello_env(&client, name, &[]).await?;
		Ok(Self { client, _serving: serving })
	}

	/// Returns the hello-complete environment client.
	pub const fn client(&self) -> &EnvClient {
		&self.client
	}
}

impl InProcessEnvHarness {
	/// Opens the local authority over `scratch`.
	pub async fn spawn(scratch: Scratch) -> Result<Self> {
		let (project, state) = (scratch.project().to_path_buf(), scratch.state().to_path_buf());
		Self::open(project, state, InProcessRoots::Scratch(scratch), OpenKind::Local, None, None)
			.await
	}

	/// Opens the local authority over `scratch` with `extension` registered
	/// behind its CONTROL extension host (the P9 registration pattern).
	pub async fn spawn_with_extension(
		scratch: Scratch,
		extension: &PythonExtension,
	) -> Result<Self> {
		let (project, state) = (scratch.project().to_path_buf(), scratch.state().to_path_buf());
		Self::open(
			project,
			state,
			InProcessRoots::Scratch(scratch),
			OpenKind::Local,
			Some(Registered::Fixture(extension)),
			None,
		)
		.await
	}

	/// Opens the local authority over `scratch` with `extension`, one the
	/// production driver admitted from a user extension root, registered behind
	/// its CONTROL extension host.
	pub async fn spawn_with_admitted_extension(
		scratch: Scratch,
		extension: &AdmittedNativeExtension,
	) -> Result<Self> {
		let (project, state) = (scratch.project().to_path_buf(), scratch.state().to_path_buf());
		Self::open(
			project,
			state,
			InProcessRoots::Scratch(scratch),
			OpenKind::Local,
			Some(Registered::Admitted(extension)),
			None,
		)
		.await
	}

	/// Opens the project-mode authority over `scratch` with `extension`
	/// registered behind its CONTROL extension host.
	///
	/// Proves `AgentSettledHost::attach` on [`EnvServer::open_project`]: the
	/// same red/green property as [`Self::spawn_with_extension`] for
	/// `open_local`.
	pub async fn spawn_project_with_extension(
		scratch: Scratch,
		extension: &PythonExtension,
	) -> Result<Self> {
		let docserver_socket = scratch.socket("docserver.sock");
		let (project, state) = (scratch.project().to_path_buf(), scratch.state().to_path_buf());
		Self::open(
			project,
			state,
			InProcessRoots::Scratch(scratch),
			OpenKind::Project { docserver_socket },
			Some(Registered::Fixture(extension)),
			None,
		)
		.await
	}

	/// Opens a session-host authority over `scratch` with `extension`
	/// registered behind its CONTROL extension host.
	///
	/// Spawns a hello-complete local owner first (required by
	/// [`EnvServer::open_session_host`]), then opens the session host against
	/// that owner. Proves `AgentSettledHost::attach` on `open_session_host`.
	pub async fn spawn_session_host_with_extension(
		scratch: Scratch,
		extension: &PythonExtension,
	) -> Result<Self> {
		let owner_state = scratch.root().join("owner-state");
		fs::create_dir_all(&owner_state).context("creating session-host owner state")?;
		let (owner_config, owner_con, owner_convars) = open_inputs()?;
		// Owner needs no extension; it only supplies ServerHello for the peer.
		let owner_server = Arc::new(
			EnvServer::open_local(
				scratch.project(),
				&owner_state,
				Registry::new(),
				owner_config,
				&owner_con,
				owner_convars,
				RegistryBridges::default(),
			)
			.await
			.context("opening session-host owner authority")?,
		);
		let owner_connection =
			InProcessConnection::open(&owner_server, "omp-e2e-session-owner").await?;
		let owner = owner_connection.client().clone();
		let (project, state) = (scratch.project().to_path_buf(), scratch.state().to_path_buf());
		Self::open(
			project,
			state,
			InProcessRoots::Scratch(scratch),
			OpenKind::SessionHost { owner },
			Some(Registered::Fixture(extension)),
			Some(SessionOwner { _server: owner_server, _connection: owner_connection }),
		)
		.await
	}

	/// Opens a local authority rooted at an existing directory, such as an
	/// isolated worktree, with a private state directory.
	pub async fn spawn_at(project: &Path) -> Result<Self> {
		let state = tempfile::Builder::new()
			.prefix("omp-e2e-state-")
			.tempdir()
			.context("creating embedded environment state")?;
		let state_path = state.path().to_path_buf();
		let roots = InProcessRoots::Rooted { project: project.to_path_buf(), _state: state };
		Self::open(project.to_path_buf(), state_path, roots, OpenKind::Local, None, None).await
	}

	async fn open(
		project: PathBuf,
		state: PathBuf,
		roots: InProcessRoots,
		kind: OpenKind,
		extension: Option<Registered<'_>>,
		owner: Option<SessionOwner>,
	) -> Result<Self> {
		let (mut ext_host_config, con, convars) = open_inputs()?;
		let binding = match extension {
			Some(Registered::Fixture(extension)) => {
				let install = extension.install(&project, &state, SESSION_ID, SESSION_GENERATION)?;
				ext_host_config.extensions.push(install.spec);
				Some(install.binding)
			},
			Some(Registered::Admitted(extension)) => {
				let install = install_admitted(extension, &state, SESSION_ID, SESSION_GENERATION)?;
				ext_host_config.extensions.push(install.spec);
				Some(install.binding)
			},
			None => None,
		};
		let trusted = RegistryBridges {
			content: ActiveContentInputs {
				workspace_trust: WorkspaceTrust::Trusted,
				..ActiveContentInputs::default()
			},
			..RegistryBridges::default()
		};
		let server = Arc::new(match kind {
			OpenKind::Local => EnvServer::open_local(
				&project,
				&state,
				Registry::new(),
				ext_host_config,
				&con,
				convars,
				RegistryBridges::default(),
			)
			.await
			.context("opening embedded environment authority")?,
			OpenKind::Project { docserver_socket } => EnvServer::open_project(
				&project,
				&state,
				&docserver_socket,
				Registry::new(),
				ext_host_config,
				None,
				false,
				None,
				&con,
				convars,
				trusted,
			)
			.await
			.context("opening project environment authority")?,
			OpenKind::SessionHost { owner } => EnvServer::open_session_host(
				&project,
				&state,
				Registry::new(),
				ext_host_config,
				None,
				&con,
				convars,
				trusted,
				owner,
			)
			.await
			.context("opening session-host environment authority")?,
		});
		if let Some(Registered::Fixture(extension)) = extension {
			extension.verify(&server)?;
		}
		let shutdown = CancellationToken::new();
		let cleanup = shutdown.clone().drop_guard();
		let data_task = binding.map(|binding| {
			let data_server = Arc::clone(&server);
			let data_shutdown = shutdown.clone();
			tokio::spawn(async move {
				let _ = data_server
					.serve_extension_uds(binding, data_shutdown)
					.await;
			})
		});
		let primary = InProcessConnection::open(&server, "omp-e2e-embedded").await?;
		cleanup.disarm();
		Ok(Self { primary, data_task, shutdown, server, roots, _owner: owner })
	}

	/// Opens another hello-complete connection to the same authority.
	pub async fn connect_client(&self, name: &str) -> Result<InProcessConnection> {
		InProcessConnection::open(&self.server, name).await
	}

	/// Opens raw frame channels to the same authority and serves them, for a
	/// caller that performs the hello itself, such as a partition router.
	pub fn connect_frames(&self) -> (FramePipe, InProcessServing) {
		let (pipe, transport) = in_process_frames(64);
		(pipe, InProcessServing::start(&self.server, transport))
	}

	/// Returns the hello-complete environment client.
	pub const fn client(&self) -> &EnvClient {
		self.primary.client()
	}

	/// Returns the environment authority, for its hook gate.
	pub fn server(&self) -> &Arc<EnvServer> {
		&self.server
	}

	/// Returns the project root used by the authority.
	pub fn project(&self) -> &Path {
		match &self.roots {
			InProcessRoots::Scratch(scratch) => scratch.project(),
			InProcessRoots::Rooted { project, .. } => project,
		}
	}

	/// Stops serving and waits until every serving task has released the
	/// authority.
	pub async fn shutdown(mut self) {
		self.shutdown.cancel();
		self.primary._serving.stop().await;
		if let Some(task) = self.data_task.take() {
			task.abort();
			let _ = task.await;
		}
	}
}

impl Drop for InProcessEnvHarness {
	fn drop(&mut self) {
		self.shutdown.cancel();
		if let Some(task) = self.data_task.take() {
			task.abort();
		}
	}
}

/// Production environment-daemon child attached to a caller-owned document
/// authority.
pub struct ProcessEnvHarness {
	client:      EnvClient,
	socket:      PathBuf,
	client_task: Option<JoinHandle<io::Result<()>>>,
	process:     Option<OwnedProcess>,
}

impl ProcessEnvHarness {
	/// Returns the hello-complete environment client.
	pub const fn client(&self) -> &EnvClient {
		&self.client
	}

	/// Returns a clone of the hello-complete environment client.
	pub fn client_clone(&self) -> EnvClient {
		self.client.clone()
	}

	/// Returns the environment endpoint.
	pub fn socket(&self) -> &Path {
		&self.socket
	}

	/// Returns the daemon child's process identifier while it runs.
	pub fn pid(&self) -> Option<u32> {
		self.process.as_ref().and_then(OwnedProcess::id)
	}

	/// Opens an independent framed connection and completes its hello.
	pub async fn connect_client(&self, name: &str) -> Result<FramedEnvConnection> {
		FramedEnvConnection::connect(&self.socket, name).await
	}

	/// Opens an independent framed connection whose hello advertises
	/// `capabilities`, such as [`omp_env::APPROVAL_RELAY_CAPABILITY`].
	pub async fn connect_client_with_capabilities(
		&self,
		name: &str,
		capabilities: &[&str],
	) -> Result<FramedEnvConnection> {
		FramedEnvConnection::connect_with_capabilities(&self.socket, name, capabilities).await
	}

	/// Opens an independent raw-frame connection whose hello advertises
	/// `capabilities`.
	pub async fn connect_raw(&self, name: &str, capabilities: &[&str]) -> Result<RawEnvConnection> {
		RawEnvConnection::connect(&self.socket, name, capabilities).await
	}

	/// Terminates the daemon process tree and removes the endpoint.
	pub async fn shutdown(mut self) -> Result<()> {
		if let Some(task) = self.client_task.take() {
			task.abort();
			let _ = task.await;
		}
		if let Some(process) = self.process.take() {
			process.terminate(Duration::from_millis(500)).await?;
		}
		remove_socket(&self.socket)?;
		Ok(())
	}
}

impl Drop for ProcessEnvHarness {
	fn drop(&mut self) {
		if let Some(task) = self.client_task.take() {
			task.abort();
		}
		drop(self.process.take());
		let _ = remove_socket(&self.socket);
	}
}

/// One independently correlated framed environment connection.
pub struct FramedEnvConnection {
	client: EnvClient,
	task:   Option<JoinHandle<io::Result<()>>>,
}

impl FramedEnvConnection {
	/// Connects to `socket`, starts the frame bridge, and completes hello.
	pub async fn connect(socket: &Path, name: &str) -> Result<Self> {
		Self::connect_with_capabilities(socket, name, &[]).await
	}

	/// Connects to `socket`, starts the frame bridge, and completes a hello
	/// that advertises `capabilities`.
	pub async fn connect_with_capabilities(
		socket: &Path,
		name: &str,
		capabilities: &[&str],
	) -> Result<Self> {
		let (client, task) = connect_env(socket).await?;
		hello_env(&client, name, capabilities).await?;
		Ok(Self { client, task: Some(task) })
	}

	/// Returns the decoded environment client.
	pub const fn client(&self) -> &EnvClient {
		&self.client
	}

	/// Returns a clone sharing this connection's correlation router.
	pub fn client_clone(&self) -> EnvClient {
		self.client.clone()
	}
}

impl Drop for FramedEnvConnection {
	fn drop(&mut self) {
		if let Some(task) = self.task.take() {
			task.abort();
		}
	}
}

/// One framed environment connection that speaks raw frames.
///
/// A proof sends through it what a well-behaved client never would (a forged
/// answer) and observes every frame the daemon sends it. Dropping it closes
/// the connection.
pub struct RawEnvConnection {
	requests:  flume::Sender<ClientFrame>,
	responses: Receiver<ServerFrame>,
	task:      Option<JoinHandle<io::Result<()>>>,
}

impl RawEnvConnection {
	/// Connects to `socket`, starts the frame bridge, and completes a hello
	/// that advertises `capabilities`.
	pub async fn connect(socket: &Path, name: &str, capabilities: &[&str]) -> Result<Self> {
		let stream =
			within("environment socket connection", DEFAULT_TIMEOUT, UnixStream::connect(socket))
				.await??;
		let (requests, outgoing) = flume::bounded(64);
		let (incoming, responses) = flume::bounded(64);
		let task = tokio::spawn(bridge_frames(stream, outgoing, incoming));
		let connection = Self { requests, responses, task: Some(task) };
		connection
			.send(0, client_frame::Body::Hello(client_hello(name, capabilities)))
			.await?;
		let frame = connection.next(DEFAULT_TIMEOUT).await?;
		if !matches!(frame.body, Some(server_frame::Body::Hello(_))) {
			return Err(error(format!("environment hello was answered with {frame:?}")));
		}
		Ok(connection)
	}

	/// Sends one frame on `request_id`.
	pub async fn send(&self, request_id: u64, body: client_frame::Body) -> Result<()> {
		self
			.requests
			.send_async(ClientFrame { request_id, body: Some(body), ..ClientFrame::default() })
			.await
			.map_err(|_| error("environment connection closed before a send"))
	}

	/// Receives the next frame the daemon sent this connection, waiting at
	/// most `limit`.
	pub async fn next(&self, limit: Duration) -> Result<ServerFrame> {
		within("environment frame", limit, self.responses.recv_async())
			.await?
			.map_err(|_| error("environment connection closed before a frame"))
	}
}

impl Drop for RawEnvConnection {
	fn drop(&mut self) {
		if let Some(task) = self.task.take() {
			task.abort();
		}
	}
}

/// Opens a decoded [`EnvClient`] over the production varint/protobuf byte
/// framing.
pub async fn connect_env(path: &Path) -> Result<(EnvClient, JoinHandle<io::Result<()>>)> {
	let stream =
		within("environment socket connection", DEFAULT_TIMEOUT, UnixStream::connect(path)).await??;
	let (outgoing, requests) = flume::bounded(64);
	let (responses, incoming) = flume::bounded(64);
	let client = EnvClient::from_channels(outgoing, incoming);
	client.set_admitter(AllowAdmission);
	let task = tokio::spawn(bridge_frames(stream, requests, responses));
	Ok((client, task))
}

async fn hello_env(client: &EnvClient, name: &str, capabilities: &[&str]) -> Result<()> {
	within("environment hello", DEFAULT_TIMEOUT, client.hello(client_hello(name, capabilities)))
		.await??;
	Ok(())
}

fn client_hello(name: &str, capabilities: &[&str]) -> ClientHello {
	ClientHello {
		client: name.to_owned(),
		schema_rev: SCHEMA_REV,
		capabilities: capabilities
			.iter()
			.map(|capability| (*capability).to_owned())
			.collect(),
		..Default::default()
	}
}

/// Downloads one complete blob through the real environment blob plane.
pub async fn read_blob(
	client: &EnvClient,
	request: GetRequest,
	limit: Duration,
) -> Result<Vec<u8>> {
	let mut download = within("blob get open", limit, client.blob_get(request)).await??;
	within("blob download", limit, async {
		let mut bytes = Vec::new();
		loop {
			match download.next_event().await? {
				Some(BlobDownloadEvent::Chunk(chunk)) => bytes.extend_from_slice(&chunk.data),
				Some(BlobDownloadEvent::Complete(_)) => return Ok(bytes),
				None => return Err(error("blob stream closed before completion".to_string())),
			}
		}
	})
	.await?
}

async fn wait_socket(path: &Path, limit: Duration) -> Result<()> {
	within("environment socket readiness", limit, async {
		loop {
			match UnixStream::connect(path).await {
				Ok(stream) => {
					drop(stream);
					return Ok(());
				},
				Err(error)
					if error.kind() == io::ErrorKind::NotFound
						|| error.kind() == io::ErrorKind::ConnectionRefused =>
				{
					time::sleep(Duration::from_millis(10)).await;
				},
				Err(error) => return Err(error),
			}
		}
	})
	.await??;
	Ok(())
}

async fn bridge_frames<S>(
	stream: S,
	requests: Receiver<ClientFrame>,
	responses: flume::Sender<ServerFrame>,
) -> io::Result<()>
where
	S: AsyncRead + AsyncWrite + Unpin,
{
	let (mut reader, mut writer) = split(stream);
	let write = async {
		let mut bytes = BytesMut::new();
		while let Ok(frame) = requests.recv_async().await {
			bytes.clear();
			frame
				.encode_length_delimited(&mut bytes)
				.map_err(io::Error::other)?;
			writer.write_all(&bytes).await?;
			writer.flush().await?;
		}
		Ok(())
	};
	let read = async {
		let mut payload = BytesMut::new();
		while let Some(length) = read_length(&mut reader).await? {
			if length > FRAME_LIMIT {
				return Err(io::Error::new(
					io::ErrorKind::InvalidData,
					"environment frame exceeds limit",
				));
			}
			payload.resize(length, 0);
			reader.read_exact(&mut payload).await?;
			let frame = ServerFrame::decode(&payload[..]).map_err(io::Error::other)?;
			if responses.send_async(frame).await.is_err() {
				return Ok(());
			}
		}
		Ok(())
	};
	tokio::select! {
		result = write => result,
		result = read => result,
	}
}

async fn read_length<R: AsyncRead + Unpin>(reader: &mut R) -> io::Result<Option<usize>> {
	let mut value = 0_u64;
	for shift in (0..70).step_by(7) {
		let byte = match reader.read_u8().await {
			Ok(byte) => byte,
			Err(error) if error.kind() == io::ErrorKind::UnexpectedEof && shift == 0 => {
				return Ok(None);
			},
			Err(error) => return Err(error),
		};
		value |= u64::from(byte & 0x7f) << shift;
		if byte & 0x80 == 0 {
			return usize::try_from(value).map(Some).map_err(|_| {
				io::Error::new(io::ErrorKind::InvalidData, "environment frame length overflows usize")
			});
		}
	}
	Err(io::Error::new(io::ErrorKind::InvalidData, "environment frame length varint is invalid"))
}

fn remove_socket(path: &Path) -> io::Result<()> {
	match fs::remove_file(path) {
		Ok(()) => Ok(()),
		Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
		Err(error) => Err(error),
	}
}
