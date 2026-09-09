//! Multi-client document authority over a local Unix socket or standard I/O.
//!
//! Embedding daemons can observe the socket connection gauge to drive idle
//! detection without inspecting document protocol traffic.

#[cfg(all(test, unix))]
use std::fs::Permissions;
#[cfg(unix)]
use std::path::Path;
#[cfg(unix)]
use std::{
	env, ffi, fs,
	fs::{File, OpenOptions},
	os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
};
use std::{io, mem, path::PathBuf, result, time::Duration};

#[cfg(unix)]
use omp_core::Hash32;
use omp_core::Str;
#[cfg(unix)]
use rustix::fs::{FlockOperation, flock};
#[cfg(unix)]
use rustix::{io::Errno, process::geteuid};
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};
#[cfg(unix)]
use tokio::signal::unix::{self, SignalKind};
#[cfg(unix)]
use tokio::task::JoinSet;
#[cfg(unix)]
use tokio::time::sleep;
use tokio::{
	io::{stdin, stdout},
	signal::ctrl_c,
	sync::watch,
	task::JoinError,
	time::timeout,
};
use tokio_util::sync::CancellationToken;

use crate::docserver::{
	Environment, LspProcess, LspProcessError, ServerConfig,
	connection::{ConnectionConfig, ConnectionError, serve_io_until},
	dap_adapter::builtin_adapters,
	dap_config::{discover_native_dap_sources, load_dap_config},
	error, load_lsp_process_configs,
	lsp_supervisor::{NativeLspOptions, NativeLspSupervisor},
};

const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
#[cfg(unix)]
const MAX_SOCKET_CONNECTIONS: usize = 128;
#[cfg(unix)]
const ACCEPT_RETRY_DELAY: Duration = Duration::from_millis(100);

/// The transport on which the document authority accepts connections.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Transport {
	/// Serve one framed connection over standard input and standard output.
	Stdio,
	/// Serve concurrent framed connections over the Unix-domain socket at this
	/// path.
	Socket(PathBuf),
}

/// Options for serving the document authority.
pub struct ServeOptions {
	/// Language-server process configuration files loaded before serving.
	pub lsp_config_paths: Vec<PathBuf>,
	/// Native language-server discovery and startup policy.
	pub lsp:              NativeLspOptions,
	/// User configuration root probed for `lsp.json` and `dap.json` overrides.
	pub user_config_root: Option<PathBuf>,
	/// External shutdown; `None` installs signal handling.
	pub shutdown:         Option<CancellationToken>,
	/// Executable-generation identity advertised in `ServerHello`.
	pub server_build:     Str,
	/// Socket-connection gauge receiving the live accepted-connection count.
	pub connections:      Option<watch::Sender<usize>>,
}

/// An error that prevents the document authority from starting or serving its
/// transport.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
	/// The document Environment could not be configured.
	#[error(transparent)]
	Document(#[from] error::Error),
	/// A standard-I/O connection failed.
	#[error(transparent)]
	Connection(#[from] ConnectionError),
	/// An operating-system operation failed.
	#[error(transparent)]
	Io(#[from] io::Error),
	/// A configured language-server process failed to start or stop.
	#[error(transparent)]
	LspProcess(#[from] LspProcessError),
	/// Document actors did not stop within the shutdown deadline.
	#[error("document actors did not stop within the shutdown deadline")]
	ShutdownDeadlineExceeded,

	/// Cannot open an authority lock file.
	#[error("cannot open authority lock {path:?}: {source}")]
	OpenAuthorityLock {
		/// Path to the lock file.
		path:   PathBuf,
		/// Underlying I/O error.
		#[source]
		source: io::Error,
	},

	/// Cannot set permissions on an authority lock file.
	#[error("cannot secure authority lock {path:?}: {source}")]
	SecureAuthorityLock {
		/// Path to the lock file.
		path:   PathBuf,
		/// Underlying I/O error.
		#[source]
		source: io::Error,
	},

	/// An authority lock is unavailable because another instance is running.
	#[cfg(unix)]
	#[error("another {kind} authority is already running or lock {path:?} is unavailable: {source}")]
	AcquireAuthorityLock {
		/// Kind of authority lock (e.g., "socket").
		kind:   &'static str,
		/// Path to the lock file.
		path:   PathBuf,
		/// Underlying file locking error.
		#[source]
		source: Errno,
	},

	/// Cannot set permissions on the lock directory.
	#[error("cannot secure lock directory {directory:?}: {source}")]
	SecureLockDirectory {
		/// Path to the lock directory.
		directory: PathBuf,
		/// Underlying I/O error.
		#[source]
		source:    io::Error,
	},

	/// Cannot create the lock directory.
	#[error("cannot create lock directory {directory:?}: {source}")]
	CreateLockDirectory {
		/// Path to the lock directory.
		directory: PathBuf,
		/// Underlying I/O error.
		#[source]
		source:    io::Error,
	},

	/// Cannot stat or inspect the lock directory.
	#[error("cannot inspect lock directory {directory:?}: {source}")]
	InspectLockDirectory {
		/// Path to the lock directory.
		directory: PathBuf,
		/// Underlying I/O error.
		#[source]
		source:    io::Error,
	},

	/// The lock directory has invalid ownership or permissions.
	#[error("lock directory {directory:?} must be an owner-only directory owned by uid {user_id}")]
	InvalidLockDirectoryPermissions {
		/// Path to the lock directory.
		directory: PathBuf,
		/// Effective user ID.
		user_id:   u32,
	},

	/// The requested Unix socket path lacks a file name component.
	#[error("socket path {path:?} has no file name")]
	SocketPathMissingFileName {
		/// Path to the socket.
		path: PathBuf,
	},

	/// Refusing to replace an existing non-socket file at the socket path.
	#[error("refusing to replace non-socket path {path:?}")]
	ReplaceNonSocketPath {
		/// Path to the existing non-socket entry.
		path: PathBuf,
	},

	/// Another document authority is actively listening on the socket.
	#[error("another document authority is listening on {path:?}")]
	SocketInUse {
		/// Active socket path.
		path: PathBuf,
	},

	/// Failed to probe whether an existing socket is active.
	#[error("cannot determine whether socket {path:?} is active: {source}")]
	ProbeActiveSocket {
		/// Socket path being probed.
		path:   PathBuf,
		/// Underlying I/O error.
		#[source]
		source: io::Error,
	},

	/// Environment root URI cannot be converted to a local file path.
	#[error("Environment root is not a local file URI")]
	NonFileUriRoot,

	/// The socket path is inside the writable Environment root.
	#[error("socket path {path:?} must be outside the writable Environment root {root:?}")]
	SocketInsideEnvironmentRoot {
		/// Requested socket path.
		path: PathBuf,
		/// Environment root path.
		root: PathBuf,
	},
	/// Unix-domain sockets were requested on a platform that does not support
	/// them.
	#[error("Unix-domain sockets are unsupported on this platform; use standard I/O")]
	UnsupportedSocket,
}

/// The result of a document-authority operation.
pub type Result<T = ()> = result::Result<T, Error>;

/// Serves the document authority rooted at `root` on `transport`.
///
/// Every LSP configuration path is parsed before authority is acquired. All
/// declared processes complete initialization and registry installation before
/// the client transport starts accepting requests. On Unix, socket endpoints
/// are protected by a separate instance lock and created sockets are
/// owner-only. When no external shutdown token is supplied, `SIGINT` or
/// `SIGTERM` starts graceful connection, LSP, and actor shutdown.
#[tracing::instrument(level = "debug", skip_all, fields(root = %root.display()))]
pub async fn serve(root: PathBuf, transport: Transport, options: ServeOptions) -> Result {
	run_with_shutdown(root, transport, options).await
}

async fn run_with_shutdown(root: PathBuf, transport: Transport, options: ServeOptions) -> Result {
	let process_configs = load_lsp_process_configs(&options.lsp_config_paths)?;
	let config = ServerConfig::new(root)?.with_server_build(options.server_build);
	let authority_lock = config.try_lock_authority()?;
	let environment = Environment::new(config)?;
	if options.lsp.enabled {
		match NativeLspSupervisor::discover(&environment, options.user_config_root.as_deref()) {
			Ok(supervisor) => {
				environment.install_lsp_supervisor(supervisor.clone());
				if !options.lsp.lazy {
					supervisor.warm_all();
				}
			},
			Err(error) => {
				tracing::warn!(%error, "native LSP discovery failed; continuing without servers");
			},
		}
	}
	install_dap_overrides(&environment, options.user_config_root.as_deref());
	let mut processes = Vec::with_capacity(process_configs.len());
	for process_config in process_configs {
		match LspProcess::start(process_config, &environment, CancellationToken::new()).await {
			Ok(process) => processes.push(process),
			Err(error) => {
				let _ = stop_lsp_processes(&mut processes).await;
				let _ = timeout(SHUTDOWN_GRACE, environment.shutdown()).await;
				return Err(error.into());
			},
		}
	}
	tracing::info!(lsp_processes = processes.len(), "document server initialized");
	let serve_result = match (transport, options.shutdown) {
		(Transport::Stdio, None) => serve_stdio(environment.clone()).await,
		(Transport::Stdio, Some(shutdown)) => serve_stdio_until(environment.clone(), shutdown).await,
		(Transport::Socket(path), None) => {
			serve_socket(environment.clone(), path, options.connections).await
		},
		(Transport::Socket(path), Some(shutdown)) => {
			serve_socket_until(environment.clone(), path, shutdown, options.connections).await
		},
	};
	let process_result = stop_lsp_processes(&mut processes).await;
	if timeout(SHUTDOWN_GRACE, environment.shutdown())
		.await
		.is_err()
	{
		// Keep the directory handle locked until process exit: returning a
		// reusable authority while an actor may still persist would permit a
		// split brain.
		mem::forget(authority_lock);
		return Err(Error::ShutdownDeadlineExceeded);
	}
	tracing::info!("document server stopped");
	serve_result?;
	process_result
}

/// Overlays discovered user/project DAP adapter declarations onto the
/// builtin registry; discovery failures never block the authority.
fn install_dap_overrides(environment: &Environment, user_config_root: Option<&Path>) {
	let root = match environment.root_uri().to_file_path() {
		Ok(root) => root,
		Err(()) => return,
	};
	let sources = match discover_native_dap_sources(user_config_root, &root) {
		Ok(sources) => sources,
		Err(error) => {
			tracing::warn!(%error, "native DAP discovery failed; continuing with builtins");
			return;
		},
	};
	if sources.is_empty() {
		return;
	}
	let adapters = match load_dap_config(builtin_adapters(), &sources) {
		Ok(adapters) => adapters,
		Err(error) => {
			tracing::warn!(%error, "native DAP configuration failed; continuing with builtins");
			return;
		},
	};
	for resolved in adapters.values() {
		match resolved.to_spec() {
			Ok(spec) => {
				if environment.dap_adapters().replace(spec.clone()).is_err() {
					let _ = environment.dap_adapters().install(spec);
				}
			},
			Err(error) => tracing::warn!(%error, "skipping invalid DAP adapter declaration"),
		}
	}
}

async fn stop_lsp_processes(processes: &mut Vec<LspProcess>) -> Result {
	let mut first_error = None;
	while let Some(process) = processes.pop() {
		if let Err(error) = process.shutdown().await
			&& first_error.is_none()
		{
			first_error = Some(Error::LspProcess(error));
		}
	}
	first_error.map_or(Ok(()), Err)
}

#[cfg(unix)]
struct InstanceLock {
	_file: File,
}

#[cfg(unix)]
impl InstanceLock {
	fn acquire(kind: &'static str, identity: &Path) -> Result<Self> {
		let directory = lock_directory()?;
		let encoded = Hash32::sum(identity.as_os_str().as_encoded_bytes()).to_hex();
		let path = directory.join(format!("{kind}-{encoded}.lock"));
		let file = OpenOptions::new()
			.read(true)
			.write(true)
			.create(true)
			.truncate(false)
			.open(&path)
			.map_err(|source| Error::OpenAuthorityLock { path: path.clone(), source })?;
		fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
			.map_err(|source| Error::SecureAuthorityLock { path: path.clone(), source })?;
		flock(&file, FlockOperation::NonBlockingLockExclusive)
			.map_err(|source| Error::AcquireAuthorityLock { kind, path: path.clone(), source })?;
		Ok(Self { _file: file })
	}
}

#[cfg(unix)]
fn lock_directory() -> Result<PathBuf> {
	let user_id = rustix::process::geteuid().as_raw();
	let directory = match env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from) {
		Some(runtime) if runtime.is_absolute() => runtime.join("omp-envd-docserver"),
		_ => env::temp_dir().join(format!("omp-envd-docserver-{user_id}")),
	};
	match fs::create_dir(&directory) {
		Ok(()) => fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
			.map_err(|source| Error::SecureLockDirectory { directory: directory.clone(), source })?,
		Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
		Err(source) => {
			return Err(Error::CreateLockDirectory { directory, source });
		},
	}
	let metadata = fs::symlink_metadata(&directory)
		.map_err(|source| Error::InspectLockDirectory { directory: directory.clone(), source })?;
	if !metadata.is_dir() || metadata.uid() != user_id || metadata.mode() & 0o077 != 0 {
		return Err(Error::InvalidLockDirectoryPermissions { directory, user_id });
	}
	Ok(directory)
}

async fn serve_stdio(environment: Environment) -> Result {
	let shutdown = CancellationToken::new();
	let signal_shutdown = shutdown.clone();
	let signal = tokio::spawn(async move {
		let _ = shutdown_signal().await;
		signal_shutdown.cancel();
	});
	let result = serve_stdio_until(environment, shutdown).await;
	signal.abort();
	result
}

async fn serve_stdio_until(environment: Environment, shutdown: CancellationToken) -> Result {
	serve_io_until(environment.session(), stdin(), stdout(), ConnectionConfig::default(), shutdown)
		.await
		.map_err(Into::into)
}

#[cfg(unix)]
async fn bind_socket(path: PathBuf) -> Result<(UnixListener, SocketCleanup)> {
	let name = path
		.file_name()
		.map(ffi::OsStr::to_owned)
		.ok_or_else(|| Error::SocketPathMissingFileName { path: path.clone() })?;
	let parent = path
		.parent()
		.filter(|parent| !parent.as_os_str().is_empty())
		.unwrap_or_else(|| Path::new("."));
	let canonical_parent = fs::canonicalize(parent)?;
	let path = canonical_parent.join(name);
	let identity = path.clone();
	let lock = InstanceLock::acquire("socket", &identity)?;
	match fs::symlink_metadata(&path) {
		Ok(metadata) if !metadata.file_type().is_socket() => {
			return Err(Error::ReplaceNonSocketPath { path });
		},
		Ok(_) => match UnixStream::connect(&path).await {
			Ok(_) => {
				return Err(Error::SocketInUse { path });
			},
			Err(error)
				if matches!(
					error.kind(),
					io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
				) =>
			{
				fs::remove_file(&path)?;
			},
			Err(error) => {
				return Err(Error::ProbeActiveSocket { path, source: error });
			},
		},
		Err(error) if error.kind() == io::ErrorKind::NotFound => {},
		Err(error) => return Err(error.into()),
	}
	let listener = UnixListener::bind(&path)?;
	fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
	let metadata = fs::symlink_metadata(&path)?;
	let cleanup = SocketCleanup { path, dev: metadata.dev(), ino: metadata.ino(), _lock: lock };
	tracing::info!(path = %cleanup.path.display(), "document server socket listening");
	Ok((listener, cleanup))
}

#[cfg(unix)]
fn validate_socket_location(path: &Path, root: &Path) -> Result {
	let parent = path
		.parent()
		.filter(|parent| !parent.as_os_str().is_empty())
		.unwrap_or_else(|| Path::new("."));
	let canonical_parent = fs::canonicalize(parent)?;
	if canonical_parent.starts_with(root) {
		Err(Error::SocketInsideEnvironmentRoot { path: path.to_owned(), root: root.to_owned() })
	} else {
		Ok(())
	}
}

#[cfg(unix)]
async fn serve_socket(
	environment: Environment,
	path: PathBuf,
	connections: Option<watch::Sender<usize>>,
) -> Result {
	let shutdown = CancellationToken::new();
	let signal_shutdown = shutdown.clone();
	let signal = tokio::spawn(async move {
		let _ = shutdown_signal().await;
		signal_shutdown.cancel();
	});
	let result = serve_socket_until(environment, path, shutdown, connections).await;
	signal.abort();
	result
}

#[cfg(unix)]
async fn serve_socket_until(
	environment: Environment,
	path: PathBuf,
	shutdown: CancellationToken,
	connection_gauge: Option<watch::Sender<usize>>,
) -> Result {
	let root = environment
		.root_uri()
		.to_file_path()
		.map_err(|()| Error::NonFileUriRoot)?;
	validate_socket_location(&path, &root)?;
	let (listener, socket) = bind_socket(path).await?;
	let mut connections = JoinSet::new();
	publish_connection_count(connection_gauge.as_ref(), 0);

	loop {
		tokio::select! {
			() = shutdown.cancelled() => {
				break;
			},
			accepted = listener.accept(), if connections.len() < MAX_SOCKET_CONNECTIONS => {
				let (stream, _) = match accepted {
					Ok(connection) => connection,
					Err(error) => {
						tracing::warn!(%error, "socket accept failed; retrying");
						sleep(ACCEPT_RETRY_DELAY).await;
						continue;
					},
				};
				match stream.peer_cred() {
					Ok(credentials) if credentials.uid() == geteuid().as_raw() => {},
					Ok(credentials) => {
						tracing::warn!(
							peer_uid = credentials.uid(),
							"rejected socket peer owned by another user"
						);
						continue;
					},
					Err(error) => {
						tracing::warn!(%error, "cannot authenticate socket peer");
						continue;
					},
				}
				let session = environment.session();
				let connection_shutdown = shutdown.clone();
				connections.spawn(async move {
					// `into_split` (one Arc per connection, at setup) is required:
					// `serve_io_until` moves the writer half into its own task.
					let (reader, writer) = stream.into_split();
					serve_io_until(
						session,
						reader,
						writer,
						ConnectionConfig::default(),
						connection_shutdown,
					)
					.await
				});
				publish_connection_count(connection_gauge.as_ref(), connections.len());
			},
			completed = connections.join_next(), if !connections.is_empty() => {
				if let Some(completed) = completed {
					report_connection(completed);
					publish_connection_count(connection_gauge.as_ref(), connections.len());
				}
			},
		}
	}

	drop(listener);
	let drain = async {
		while let Some(completed) = connections.join_next().await {
			report_connection(completed);
			publish_connection_count(connection_gauge.as_ref(), connections.len());
		}
	};
	if timeout(SHUTDOWN_GRACE, drain).await.is_err() {
		connections.shutdown().await;
		publish_connection_count(connection_gauge.as_ref(), 0);
	}
	drop(socket);
	Ok(())
}

#[cfg(not(unix))]
async fn serve_socket(
	_environment: Environment,
	_path: PathBuf,
	_connections: Option<watch::Sender<usize>>,
) -> Result {
	Err(Error::UnsupportedSocket)
}

#[cfg(not(unix))]
async fn serve_socket_until(
	_environment: Environment,
	_path: PathBuf,
	_shutdown: CancellationToken,
	_connections: Option<watch::Sender<usize>>,
) -> Result {
	Err(Error::UnsupportedSocket)
}

#[cfg(unix)]
fn publish_connection_count(gauge: Option<&watch::Sender<usize>>, count: usize) {
	if let Some(gauge) = gauge {
		gauge.send_replace(count);
	}
}

fn report_connection(result: result::Result<result::Result<(), ConnectionError>, JoinError>) {
	match result {
		Ok(Ok(())) => {},
		Ok(Err(error)) => {
			tracing::warn!(%error, "document server connection failed");
		},
		Err(error) if error.is_cancelled() => {},
		Err(error) => {
			tracing::error!(%error, "document server connection task crashed");
		},
	}
}

async fn shutdown_signal() -> io::Result<()> {
	#[cfg(unix)]
	{
		let mut terminate = unix::signal(SignalKind::terminate())?;
		tokio::select! {
			result = ctrl_c() => result,
			_ = terminate.recv() => Ok(()),
		}
	}
	#[cfg(not(unix))]
	{
		ctrl_c().await
	}
}

#[cfg(unix)]
#[must_use]
struct SocketCleanup {
	path:  PathBuf,
	dev:   u64,
	ino:   u64,
	_lock: InstanceLock,
}

#[cfg(unix)]
impl Drop for SocketCleanup {
	fn drop(&mut self) {
		let Ok(metadata) = fs::symlink_metadata(&self.path) else {
			return;
		};
		if metadata.file_type().is_socket()
			&& metadata.dev() == self.dev
			&& metadata.ino() == self.ino
		{
			let _ = fs::remove_file(&self.path);
		}
	}
}

#[cfg(all(test, unix))]
mod tests {
	use bytes::{Bytes, BytesMut};
	use omp_core::sf;
	use omp_proto::document::v1::{self as proto, client_frame, server_frame};
	use tempfile::TempDir;
	use tokio::{
		sync::{watch, watch::Receiver},
		time::Instant,
	};

	use super::*;
	use crate::docserver::{
		connection::{PROTOCOL_MAJOR, PROTOCOL_MINOR},
		wire::{FrameConfig, read_server_frame, write_client_frame},
	};

	#[test]
	fn authority_lock_is_exclusive_and_released_on_drop() {
		let root = TempDir::new().expect("temporary directory");
		let identity = root.path().join("workspace");
		let first = InstanceLock::acquire("test-workspace", &identity).expect("first lock");
		assert!(
			InstanceLock::acquire("test-workspace", &identity).is_err(),
			"a second authority must be rejected"
		);
		drop(first);
		InstanceLock::acquire("test-workspace", &identity).expect("released lock is reusable");
	}

	#[test]
	fn workspace_authority_lock_is_exclusive_and_released_on_drop() {
		let root = TempDir::new().expect("temporary directory");
		let first_config = ServerConfig::new(root.path()).expect("first server config");
		let second_config = ServerConfig::new(root.path()).expect("second server config");
		let first = first_config
			.try_lock_authority()
			.expect("first workspace authority");
		assert!(
			second_config.try_lock_authority().is_err(),
			"a second workspace authority must be rejected"
		);
		drop(first);
		let _reacquired_authority = second_config
			.try_lock_authority()
			.expect("released workspace authority is reusable");
	}

	#[tokio::test]
	async fn socket_binding_replaces_stale_socket_but_not_live_listener() {
		let root = TempDir::new().expect("temporary directory");
		fs::set_permissions(root.path(), Permissions::from_mode(0o700))
			.expect("secure socket parent");
		let path = root.path().join("document.sock");
		let stale = UnixListener::bind(&path).expect("stale listener");
		drop(stale);

		let (listener, cleanup) = bind_socket(path.clone())
			.await
			.expect("replace stale socket");
		assert_eq!(
			std::fs::metadata(&path)
				.expect("socket metadata")
				.permissions()
				.mode() & 0o777,
			0o600
		);
		drop(listener);
		drop(cleanup);
		assert!(!path.exists());

		let live = UnixListener::bind(&path).expect("live listener");
		assert!(bind_socket(path.clone()).await.is_err(), "a live listener must never be displaced");
		drop(live);
		fs::remove_file(path).expect("remove live test socket");
	}

	#[tokio::test]
	async fn socket_cleanup_preserves_a_replacement_entry() {
		let root = TempDir::new().expect("temporary directory");
		fs::set_permissions(root.path(), Permissions::from_mode(0o700))
			.expect("secure socket parent");
		let path = root.path().join("document.sock");
		let (listener, cleanup) = bind_socket(path.clone()).await.expect("bind socket");
		drop(listener);
		fs::remove_file(&path).expect("remove original socket");
		fs::write(&path, b"replacement").expect("write replacement");

		drop(cleanup);
		assert_eq!(std::fs::read(path).expect("replacement remains"), b"replacement");
	}

	#[tokio::test]
	async fn socket_binding_accepts_standard_parent_permissions() {
		let root = TempDir::new().expect("temporary directory");
		let shared = root.path().join("shared");
		fs::create_dir(&shared).expect("create shared directory");
		fs::set_permissions(&shared, Permissions::from_mode(0o755))
			.expect("set standard parent permissions");
		let path = shared.join("document.sock");

		let (listener, cleanup) = bind_socket(path.clone()).await.expect("bind socket");
		assert_eq!(
			std::fs::metadata(&path)
				.expect("socket metadata")
				.permissions()
				.mode() & 0o777,
			0o600
		);
		drop(listener);
		drop(cleanup);
		assert!(!path.exists());
	}

	#[tokio::test]
	async fn serve_until_cancellation_removes_socket() {
		let scratch = TempDir::new().expect("temporary directory");
		let project = scratch.path().join("project");
		let runtime = scratch.path().join("runtime");
		fs::create_dir(&project).expect("project directory");
		fs::create_dir(&runtime).expect("runtime directory");
		let socket = runtime.join("document.sock");
		let shutdown = CancellationToken::new();
		let task_shutdown = shutdown.clone();
		let task_project = project.clone();
		let task_socket = socket.clone();
		let task = tokio::spawn(async move {
			serve(task_project, Transport::Socket(task_socket), ServeOptions {
				lsp_config_paths: Vec::new(),
				lsp:              NativeLspOptions { enabled: false, ..NativeLspOptions::default() },
				user_config_root: None,
				shutdown:         Some(task_shutdown),
				server_build:     Str::default(),
				connections:      None,
			})
			.await
		});
		let deadline = Instant::now() + Duration::from_secs(5);
		loop {
			if UnixStream::connect(&socket).await.is_ok() {
				break;
			}
			assert!(Instant::now() < deadline, "document socket did not start");
			sleep(Duration::from_millis(10)).await;
		}

		shutdown.cancel();
		timeout(Duration::from_secs(5), task)
			.await
			.expect("document authority stopped")
			.expect("document authority task")
			.expect("document authority result");
		assert!(!socket.exists(), "document socket must be removed after shutdown");
	}

	#[tokio::test]
	async fn socket_hello_advertises_configured_server_build() {
		let scratch = TempDir::new().expect("temporary directory");
		let project = scratch.path().join("project");
		let runtime = scratch.path().join("runtime");
		fs::create_dir(&project).expect("project directory");
		fs::create_dir(&runtime).expect("runtime directory");
		let socket = runtime.join("document.sock");
		let shutdown = CancellationToken::new();
		let (connection_tx, mut connection_rx) = watch::channel(usize::MAX);
		let task = tokio::spawn(serve(project, Transport::Socket(socket.clone()), ServeOptions {
			lsp_config_paths: Vec::new(),
			lsp:              NativeLspOptions { enabled: false, ..NativeLspOptions::default() },
			user_config_root: None,
			shutdown:         Some(shutdown.clone()),
			server_build:     sf!("test-build"),
			connections:      Some(connection_tx),
		}));
		wait_for_connection_count(&mut connection_rx, 0).await;

		let mut stream = UnixStream::connect(&socket)
			.await
			.expect("connect document socket");
		let mut scratch = BytesMut::new();
		write_client_frame(
			&mut stream,
			&proto::ClientFrame {
				request_id: 0,
				body:       Some(client_frame::Body::Hello(proto::ClientHello {
					protocol_major: PROTOCOL_MAJOR,
					protocol_minor: PROTOCOL_MINOR,
					client_id:      Bytes::from_static(b"daemon-test"),
				})),
			},
			FrameConfig::default(),
			&mut scratch,
		)
		.await
		.expect("write client hello");
		let response = read_server_frame(&mut stream, FrameConfig::default(), &mut scratch)
			.await
			.expect("read server hello")
			.expect("server hello frame");
		let Some(server_frame::Body::Hello(hello)) = response.body else {
			panic!("expected server hello");
		};
		assert_eq!(hello.server_build, "test-build");

		drop(stream);
		shutdown.cancel();
		timeout(Duration::from_secs(5), task)
			.await
			.expect("document authority stopped")
			.expect("document authority task")
			.expect("document authority result");
	}

	#[tokio::test]
	async fn socket_connection_gauge_tracks_connect_and_disconnect() {
		let scratch = TempDir::new().expect("temporary directory");
		let project = scratch.path().join("project");
		let runtime = scratch.path().join("runtime");
		fs::create_dir(&project).expect("project directory");
		fs::create_dir(&runtime).expect("runtime directory");
		let socket = runtime.join("document.sock");
		let shutdown = CancellationToken::new();
		let (connection_tx, mut connection_rx) = watch::channel(usize::MAX);
		let task = tokio::spawn(serve(project, Transport::Socket(socket.clone()), ServeOptions {
			lsp_config_paths: Vec::new(),
			lsp:              NativeLspOptions { enabled: false, ..NativeLspOptions::default() },
			user_config_root: None,
			shutdown:         Some(shutdown.clone()),
			server_build:     Str::default(),
			connections:      Some(connection_tx),
		}));
		wait_for_connection_count(&mut connection_rx, 0).await;

		let stream = UnixStream::connect(&socket)
			.await
			.expect("connect document socket");
		wait_for_connection_count(&mut connection_rx, 1).await;
		drop(stream);
		wait_for_connection_count(&mut connection_rx, 0).await;

		shutdown.cancel();
		timeout(Duration::from_secs(5), task)
			.await
			.expect("document authority stopped")
			.expect("document authority task")
			.expect("document authority result");
	}

	async fn wait_for_connection_count(receiver: &mut Receiver<usize>, expected: usize) {
		timeout(Duration::from_secs(5), async {
			loop {
				let current = *receiver.borrow_and_update();
				if current == expected {
					break;
				}
				receiver.changed().await.expect("connection gauge sender");
			}
		})
		.await
		.expect("connection gauge update");
	}

	#[test]
	fn socket_location_rejects_workspace_paths() {
		let scratch = TempDir::new().expect("temporary directory");
		let project = scratch.path().join("project");
		let metadata = project.join(".omp");
		let runtime = scratch.path().join("runtime");
		fs::create_dir_all(&metadata).expect("project metadata directory");
		fs::create_dir(&runtime).expect("runtime directory");
		let project = fs::canonicalize(project).expect("canonical project");

		let error = validate_socket_location(&metadata.join("document.sock"), &project)
			.expect_err("workspace socket must be rejected");
		assert!(matches!(error, Error::SocketInsideEnvironmentRoot { .. }));
		validate_socket_location(&runtime.join("document.sock"), &project)
			.expect("external runtime socket");
	}
}
