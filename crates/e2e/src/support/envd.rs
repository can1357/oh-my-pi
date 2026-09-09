#![cfg(unix)]

use std::{
	fs, future, io,
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};

use bytes::BytesMut;
use flume::Receiver;
use omp_env::{Admitter, BlobDownloadEvent, EnvClient};
use omp_envd::{EnvServer, RegistryBridges, worker::ExtHostConfig};
use omp_proto::{
	SCHEMA_REV,
	blob::v1::GetRequest,
	env::v1::{Admission, AdmitInvocation, ClientFrame, ClientHello, ServerFrame},
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

use super::{DEFAULT_TIMEOUT, OwnedProcess, Scratch, install_omp_binary_env, omp_binary, within};
use crate::{Context as _, Result, error};

const FRAME_LIMIT: usize = 64 * 1024 * 1024;
const PROCESS_START_TIMEOUT: Duration = Duration::from_secs(15);

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
		install_omp_binary_env().context("exposing worker-capable host")?;
		let socket = scratch.socket("env.sock");
		let ext_host_config = ExtHostConfig::new(
			omp_binary().context("resolving worker-capable host")?,
			omp_core::Principal::new(omp_core::sf!("e2e-tester"), omp_core::sf!("E2E Tester")),
			omp_core::sf!("e2e-session"),
			1,
		);
		let con = Arc::new(omp_con::Ctx::new());
		let convars = Arc::new(omp_envd::exthost::ConvarControlFactory::new(Arc::clone(&con)));
		let server = Arc::new(
			EnvServer::open_local(
				scratch.project(),
				scratch.state(),
				Registry::new(),
				ext_host_config,
				&con,
				convars,
				RegistryBridges::default(),
			)
			.await
			.context("opening local environment authority")?,
		);
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

	/// Starts the production `envd` process attached to an existing real
	/// docserver.
	pub async fn spawn_attached(
		scratch: &Scratch,
		docserver_socket: &Path,
	) -> Result<ProcessEnvHarness> {
		install_omp_binary_env().context("exposing worker-capable host")?;
		let socket = scratch.socket("env-attached.sock");
		let mut command = Command::new(omp_binary().context("resolving worker-capable host")?);
		command
			.arg("envd")
			.arg("--root")
			.arg(scratch.project())
			.arg("--socket")
			.arg(&socket)
			.arg("--docserver-socket")
			.arg(docserver_socket)
			.arg("--state-dir")
			.arg(scratch.state());
		let process = OwnedProcess::spawn(command).context("starting attached environment daemon")?;
		wait_socket(&socket, PROCESS_START_TIMEOUT).await?;
		let (client, client_task) = connect_env(&socket).await?;
		hello_env(&client, "omp-e2e-attached").await?;
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

	/// Opens an independent framed connection and completes its hello.
	pub async fn connect_client(&self, name: &str) -> Result<FramedEnvConnection> {
		FramedEnvConnection::connect(&self.socket, name).await
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
		let (client, task) = connect_env(socket).await?;
		hello_env(&client, name).await?;
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

async fn hello_env(client: &EnvClient, name: &str) -> Result<()> {
	within(
		"environment hello",
		DEFAULT_TIMEOUT,
		client.hello(ClientHello {
			client: name.to_owned(),
			schema_rev: SCHEMA_REV,
			..Default::default()
		}),
	)
	.await??;
	Ok(())
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
				None => return Err(error(format!("blob stream closed before completion"))),
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
