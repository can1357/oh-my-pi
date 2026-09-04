//! Extension-host child spawning over a dedicated CONTROL descriptor.

use std::{
	env, fs, io, mem,
	os::fd,
	path::PathBuf,
	process::Stdio,
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::Duration,
};
#[cfg(target_os = "macos")]
use std::{ffi::CStr, path::Path};

use flume::Receiver;
#[cfg(unix)]
use nix::{sys::signal, unistd::Pid};
use omp_core::Str;
use omp_sandbox::{
	DegradationPolicy, NetworkMode, PreparedSandbox, Runner, SandboxError, SandboxSpec, WriteMode,
};
use pyo3::{
	prelude::*,
	types::{PyList, PyModule},
};
use thiserror::Error;
use tokio::{
	io::{AsyncRead, AsyncReadExt},
	net::UnixStream,
	process::{Child, Command},
	task, time,
};

use super::{
	cancel::{CancellationError, CancellationLadder, CancellationOutcome},
	control::{
		ControlAuthority, ControlAuthoritySnapshot, ControlConnectionIdentity, ControlHandle,
		ControlProtocolError, ControlRuntime, ControlRuntimeError,
	},
};
use crate::worker::HostKey;

/// Hidden argv selector for one extension-host child.
pub const EXT_HOST_ARG: &str = "__omp-ext-host";
/// Environment variable carrying the inherited CONTROL descriptor number.
pub const CONTROL_FD_ENV: &str = "OMP_EXT_CONTROL_FD";
/// Environment variable carrying the extension-scoped DATA socket path.
pub const ENV_SOCKET_ENV: &str = "OMP_EXT_ENV_SOCKET";
/// Environment variable carrying the extension-private Python site tree.
pub const PY_SITE_ENV: &str = "OMP_PY_SITE";
/// Environment variable carrying the verified package snapshot JSON.
pub const PACKAGE_SNAPSHOT_ENV: &str = "OMP_EXT_PACKAGE_SNAPSHOT";
/// Environment variable carrying the admitted declaration manifest JSON.
pub const MANIFEST_SNAPSHOT_ENV: &str = "OMP_EXT_MANIFEST_SNAPSHOT";
/// Environment variable carrying manifest-ordered declaration modules as JSON.
pub const DECLARATION_MODULES_ENV: &str = "OMP_EXT_DECLARATION_MODULES";
/// Environment variable carrying the operator-admitted exact entry file.
pub const ENTRY_PATH_ENV: &str = "OMP_EXT_ENTRY_PATH";

/// One captured child output fragment.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostLog {
	/// Stream which emitted the fragment.
	pub stream: HostLogStream,
	/// Raw output bytes; framing is intentionally not interpreted as CONTROL.
	pub bytes:  Vec<u8>,
}

/// Captured output source.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostLogStream {
	/// Child standard output.
	Stdout,
	/// Child standard error.
	Stderr,
}

/// Spawn inputs authenticated before a child is reached.
#[derive(Clone, Debug)]
pub struct SpawnSpec {
	/// Isolated host identity `(layer, tier, unit)`; the existing `HostKey`
	/// calls the unit `extension`.
	pub key:                 HostKey,
	/// Same-binary executable to re-enter.
	pub executable:          PathBuf,
	/// Per-extension Python site tree.
	pub python_site:         PathBuf,
	/// Exact operator-admitted entry file loaded before symbolic imports.
	pub entry_path:          Option<PathBuf>,
	/// Scoped Environment DATA socket.
	pub env_socket:          PathBuf,
	/// Authoritative extension process working directory.
	pub current_dir:         Option<PathBuf>,
	/// Optional workspace root granted to declared local callback sinks.
	pub workspace_root:      Option<PathBuf>,
	/// Generation assigned to this newly spawned child.
	pub host_generation:     u64,
	/// Session generation shared with the CONTROL parent.
	pub session_generation:  u64,
	/// Verified package ownership snapshot encoded for the Python bootstrap.
	///
	/// `None` identifies an anonymous or development extension and installs an
	/// explicitly empty package snapshot in the child.
	pub package_snapshot:    Option<Str>,
	/// Admitted declaration manifest, never inferred from runtime registration.
	pub manifest_snapshot:   Str,
	/// Entry and declaration modules in deterministic manifest order.
	pub declaration_modules: Box<[Str]>,
}

/// Owned parent ends for an extension-host child.
pub struct SpawnedHost {
	/// Authenticated host identity.
	pub key:      HostKey,
	/// Supervised child process group leader.
	pub child:    Child,
	/// Dedicated bidirectional CONTROL transport, never stdio.
	pub control:  UnixStream,
	/// Captured stdout/stderr records.
	pub logs:     Receiver<HostLog>,
	restart_spec: SpawnSpec,
	sandbox:      Option<PreparedSandbox>,
}
/// Live supervised child with its sole CONTROL pump and cancellation state.
pub struct RunningHost {
	/// Authenticated isolated child identity.
	pub key:      HostKey,
	child:        Child,
	control:      ControlHandle,
	logs:         Receiver<HostLog>,
	pump:         task::JoinHandle<Result<(), ControlRuntimeError>>,
	cancellation: CancellationLadder,
	restart_spec: SpawnSpec,
	identity:     ControlConnectionIdentity,
	snapshot:     ControlAuthoritySnapshot,
	sandbox:      Option<PreparedSandbox>,
}

const fn cancellation_stops_child(outcome: &CancellationOutcome) -> bool {
	matches!(outcome, CancellationOutcome::Killed(_) | CancellationOutcome::Disabled(_))
}

/// Failure while driving a live child or its cancellation ladder.
#[derive(Debug, Error)]
pub enum RunningHostError {
	/// CONTROL transport or protocol failure.
	#[error(transparent)]
	Control(#[from] ControlRuntimeError),
	/// Forced process-group cancellation failed.
	#[error(transparent)]
	Cancellation(#[from] CancellationError),
	/// Replacement child spawn failed.
	#[error(transparent)]
	Spawn(#[from] SpawnError),
	/// Child generation counter cannot be advanced safely.
	#[error("extension host generation is exhausted")]
	GenerationExhausted,
}

impl SpawnedHost {
	/// Starts the sole parent reader and installs synchronous Core authority.
	#[tracing::instrument(
		level = "debug",
		name = "extension_host_handshake",
		skip_all,
		fields(
			extension_id = %self.key.extension(),
			host_generation = identity.host_generation,
			session_generation = identity.session_generation,
		)
	)]
	pub async fn start_control(
		self,
		identity: ControlConnectionIdentity,
		authority: Arc<dyn ControlAuthority>,
		snapshot: &ControlAuthoritySnapshot,
	) -> Result<RunningHost, RunningHostError> {
		let Self { key, mut child, control, logs, restart_spec, sandbox } = self;
		let (runtime, handle) =
			ControlRuntime::new(control, key.clone(), identity.clone(), authority);
		let pump = tokio::spawn(runtime.serve());
		if let Err(error) = handle.install_authority_snapshot(snapshot).await {
			pump.abort();
			let _ = child.start_kill();
			let failure_kind = match &error {
				ControlRuntimeError::Io(_) => "io",
				ControlRuntimeError::Json(_) => "json",
				ControlRuntimeError::Protocol(_) => "protocol",
				ControlRuntimeError::Dispatch(_) => "dispatch",
				ControlRuntimeError::Remote(_) => "remote",
			};
			tracing::warn!(
				extension_id = %key.extension(),
				host_generation = identity.host_generation,
				failure_kind,
				"extension host control handshake failed",
			);
			return Err(error.into());
		}
		tracing::info!(
			extension_id = %key.extension(),
			host_generation = identity.host_generation,
			session_generation = identity.session_generation,
			"extension host control handshake completed",
		);
		Ok(RunningHost {
			key,
			child,
			control: handle,
			logs,
			pump,
			cancellation: CancellationLadder::default(),
			restart_spec,
			identity,
			snapshot: snapshot.clone(),
			sandbox,
		})
	}
}

impl RunningHost {
	/// Returns the cloneable host-to-child dispatch handle.
	pub fn control(&self) -> ControlHandle {
		self.control.clone()
	}

	/// Returns captured stdout/stderr records without mixing them into CONTROL.
	pub const fn logs(&self) -> &Receiver<HostLog> {
		&self.logs
	}

	/// Returns the generation authenticated by this live CONTROL child.
	pub const fn generation(&self) -> u64 {
		self.restart_spec.host_generation
	}

	/// Reports a child or CONTROL-pump exit without consuming its owner.
	pub fn has_exited(&mut self) -> Result<bool, RunningHostError> {
		let child_exited = self.child.try_wait().map_err(SpawnError::Spawn)?.is_some();
		if child_exited {
			self.sandbox.take();
		}
		Ok(self.pump.is_finished() || child_exited)
	}

	/// Returns whether repeated forced cancellation disabled this host.
	pub fn is_disabled(&self) -> bool {
		self.cancellation.disabled(&self.key)
	}

	/// Reaps the current process group and starts its next generation with a
	/// freshly identity-bound CONTROL authority.
	pub async fn restart_with_authority(
		&mut self,
		authority: Arc<dyn ControlAuthority>,
	) -> Result<(), RunningHostError> {
		self.terminate().await;
		let mut spec = self.restart_spec.clone();
		spec.host_generation = spec
			.host_generation
			.checked_add(1)
			.ok_or(RunningHostError::GenerationExhausted)?;
		let mut identity = self.identity.clone();
		identity.host_generation = spec.host_generation;
		let cancellation = mem::take(&mut self.cancellation);
		let spawned = spawn(spec).await?;
		let mut replacement = spawned
			.start_control(identity, authority, &self.snapshot)
			.await?;
		replacement.cancellation = cancellation;
		*self = replacement;
		Ok(())
	}

	/// Terminates and reaps this owned child process group.
	pub async fn shutdown(mut self) {
		self.terminate().await;
	}

	/// Runs all three cancellation stages, killing only this process group when
	/// Python remains live after both courtesy graces.
	///
	/// A forced kill leaves the host stopped. The supervisor must acquire a
	/// freshly generation-bound authority before calling
	/// [`Self::restart_with_authority`].
	pub async fn cancel_dispatch(
		&mut self,
		invocation: &str,
	) -> Result<CancellationOutcome, RunningHostError> {
		let last_frame = self.control.last_frame(invocation).unwrap_or(0);
		self.control.cancel(invocation).await?;
		CancellationLadder::grace_timer().await;
		if !self.control.is_live(invocation) {
			return Ok(self.cancellation.begin());
		}
		CancellationLadder::grace_timer().await;
		if !self.control.is_live(invocation) {
			return Ok(self.cancellation.interrupt_after_grace());
		}
		let outcome =
			self
				.cancellation
				.kill_after_grace(self.key.clone(), &mut self.child, last_frame)?;
		if cancellation_stops_child(&outcome) {
			self.terminate().await;
		}
		Ok(outcome)
	}

	async fn terminate(&mut self) {
		self.pump.abort();
		if let Some(pid) = self.child.id() {
			#[cfg(unix)]
			{
				let group = Pid::from_raw(pid.cast_signed());
				let _ = signal::killpg(group, signal::Signal::SIGTERM);
				time::sleep(Duration::from_millis(150)).await;
				let _ = signal::killpg(group, signal::Signal::SIGKILL);
			}
			#[cfg(windows)]
			{
				let _ = self.child.start_kill();
			}
		}
		let _ = self.child.wait().await;
		self.sandbox.take();
	}

	/// Waits for the sole CONTROL pump to finish.
	#[tracing::instrument(
		level = "debug",
		name = "extension_host_control_drain",
		skip_all,
		fields(
			extension_id = %self.key.extension(),
			host_generation = self.identity.host_generation,
			session_generation = self.identity.session_generation,
		)
	)]
	pub async fn wait_control(mut self) -> Result<(), RunningHostError> {
		let result = match (&mut self.pump).await {
			Ok(result) => result.map_err(Into::into),
			Err(error) => Err(
				ControlRuntimeError::Protocol(ControlProtocolError::new(
					"control_task_failed",
					error.to_string(),
				))
				.into(),
			),
		};
		match &result {
			Ok(()) => tracing::debug!(
				extension_id = %self.key.extension(),
				host_generation = self.identity.host_generation,
				"extension host control reader drained",
			),
			Err(error) => tracing::warn!(
				extension_id = %self.key.extension(),
				host_generation = self.identity.host_generation,
				failure_kind = match error {
					RunningHostError::Control(_) => "control",
					RunningHostError::Cancellation(_) => "cancellation",
					RunningHostError::Spawn(_) => "spawn",
					RunningHostError::GenerationExhausted => "generation_exhausted",
				},
				"extension host control reader failed",
			),
		}
		self.terminate().await;
		result
	}
}

/// Host-child bound and spawn failures.
#[derive(Debug, Error)]
pub enum SpawnError {
	/// The session already reached its admitted child bound.
	#[error("omp.MAX_HOST_CHILDREN ({limit}) is exhausted")]
	ChildLimit {
		/// Configured session bound.
		limit: usize,
	},
	/// Creating or configuring the CONTROL socket failed.
	#[error("CONTROL descriptor setup failed: {0}")]
	Control(#[from] io::Error),
	/// The embedded Python extension-host runtime failed to boot.
	#[error("extension host Python runtime failed: {0}")]
	Python(String),
	/// Native sandbox installation failed for a sandboxed host.
	#[error(transparent)]
	Sandbox(#[from] SandboxError),
	/// The host trust tier does not have an explicit launch policy.
	#[error("unsupported extension host trust tier: {0}")]
	UnsupportedTier(Str),
	/// The child process could not be spawned.
	#[error("extension host spawn failed: {0}")]
	Spawn(io::Error),
}

/// Session-local lazy child admission bound.
#[derive(Clone, Debug)]
pub struct HostChildLimit {
	limit: usize,
	live:  Arc<AtomicUsize>,
}

impl HostChildLimit {
	/// Creates a lazy-spawn admission bound.
	pub fn new(limit: usize) -> Self {
		Self { limit, live: Arc::new(AtomicUsize::new(0)) }
	}

	/// Starts a child only after its declared surface is reached.
	///
	/// The returned permit is released when [`Self::release`] is called after
	/// the process is reaped.
	pub async fn spawn_on_reach(&self, spec: SpawnSpec) -> Result<SpawnedHost, SpawnError> {
		let previous = self.live.fetch_add(1, Ordering::AcqRel);
		if previous >= self.limit {
			self.live.fetch_sub(1, Ordering::AcqRel);
			tracing::warn!(
				extension_id = %spec.key.extension(),
				host_generation = spec.host_generation,
				limit = self.limit,
				"extension host admission denied by child limit",
			);
			return Err(SpawnError::ChildLimit { limit: self.limit });
		}
		match spawn(spec).await {
			Ok(host) => Ok(host),
			Err(error) => {
				self.live.fetch_sub(1, Ordering::AcqRel);
				Err(error)
			},
		}
	}

	/// Releases one reaped child slot.
	pub fn release(&self) {
		self.live.fetch_sub(1, Ordering::AcqRel);
	}
}

/// Adds the exact non-system image directories already loaded by this same
/// binary.
#[cfg(target_os = "macos")]
fn allow_loaded_runtime_images(
	sandbox: &mut SandboxSpec,
	executable: &Path,
) -> Result<(), SandboxError> {
	unsafe extern "C" {
		fn _dyld_image_count() -> u32;
		fn _dyld_get_image_name(image_index: u32) -> *const std::ffi::c_char;
	}

	let executable = fs::canonicalize(executable)
		.map_err(|source| SandboxError::Canonicalize { path: executable.to_path_buf(), source })?;
	let image_count = unsafe { _dyld_image_count() };
	for index in 0..image_count {
		let name = unsafe { _dyld_get_image_name(index) };
		if name.is_null() {
			continue;
		}
		let Ok(name) = unsafe { CStr::from_ptr(name) }.to_str() else {
			continue;
		};
		let image = Path::new(name);
		if !image.is_absolute() || image.starts_with("/System") || image.starts_with("/usr/lib") {
			continue;
		}
		let Ok(canonical) = fs::canonicalize(image) else {
			continue;
		};
		if canonical == executable {
			continue;
		}
		if let Some(parent) = image.parent() {
			sandbox.allow_read(parent)?;
		}
		if let Some(parent) = canonical.parent() {
			sandbox.allow_read(parent)?;
		}
		// Package managers load through symlink farms (`/opt/homebrew/opt/<pkg>`
		// → `../Cellar/<pkg>/<version>`); the child resolves install names via
		// the LINK path, which never appears in this process's canonical image
		// list. Grant the whole world-readable prefix instead of chasing links.
		for prefix in ["/opt/homebrew", "/usr/local/Cellar", "/usr/local/opt", "/opt/local"] {
			if (image.starts_with(prefix) || canonical.starts_with(prefix))
				&& fs::symlink_metadata(prefix).is_ok()
			{
				sandbox.allow_read(Path::new(prefix))?;
			}
		}
	}
	Ok(())
}

#[cfg(not(target_os = "macos"))]
fn allow_loaded_runtime_images(
	_sandbox: &mut SandboxSpec,
	_executable: &std::path::Path,
) -> Result<(), SandboxError> {
	Ok(())
}

/// Spawns one isolated extension host with CONTROL on descriptor three.
#[tracing::instrument(
	level = "debug",
	name = "extension_host_spawn",
	skip_all,
	fields(
		extension_id = %spec.key.extension(),
		host_generation = spec.host_generation,
		session_generation = spec.session_generation,
		trust_tier = %spec.key.tier(),
	)
)]
pub async fn spawn(spec: SpawnSpec) -> Result<SpawnedHost, SpawnError> {
	let restart_spec = spec.clone();
	let (parent, child_control) = UnixStream::pair()?;
	let fd = fd::AsRawFd::as_raw_fd(&child_control);
	let env_socket = if spec.key.tier().as_str() == "sandboxed" {
		fs::canonicalize(&spec.env_socket)
			.map_err(|source| SandboxError::Canonicalize { path: spec.env_socket.clone(), source })?
	} else {
		spec.env_socket.clone()
	};
	let sandbox_launch = match spec.key.tier().as_str() {
		"sandboxed" => {
			let mut sandbox = SandboxSpec::new(spec.executable.as_os_str());
			sandbox.arg(EXT_HOST_ARG);
			sandbox.allow_read(&spec.executable)?;
			allow_loaded_runtime_images(&mut sandbox, &spec.executable)?;
			sandbox.allow_read(&spec.python_site)?;
			if let Some(entry_path) = &spec.entry_path {
				sandbox.allow_read(entry_path)?;
			}
			sandbox.set_write(WriteMode::Scoped);
			sandbox.allow_write(&env_socket)?;
			if let Some(root) = &spec.workspace_root {
				sandbox.allow_read(root)?;
				sandbox.allow_write(root)?;
			}
			sandbox.allow_unix_socket(&env_socket)?;
			sandbox.set_network(NetworkMode::Disabled);
			sandbox.set_degradation(DegradationPolicy::Reject);
			Some({
				let runner = Runner::native_command()?;
				let plan = runner.compile(&sandbox)?;
				runner.prepare(plan, &sandbox)?
			})
		},
		"trusted" => None,
		tier => return Err(SpawnError::UnsupportedTier(Str::from(tier))),
	};
	let mut command = if let Some(launch) = &sandbox_launch {
		Command::from(launch.command()?)
	} else {
		let mut command = Command::new(&spec.executable);
		command.arg(EXT_HOST_ARG);
		command
	};
	command
		.env(CONTROL_FD_ENV, "3")
		.env(PY_SITE_ENV, &spec.python_site)
		.env(ENV_SOCKET_ENV, &env_socket)
		.env("OMP_EXT_LAYER", spec.key.layer().as_str())
		.env("OMP_EXT_TIER", spec.key.tier().as_str())
		.env("OMP_EXT_HOST_GENERATION", spec.host_generation.to_string())
		.env("OMP_EXT_SESSION_GENERATION", spec.session_generation.to_string())
		.env(MANIFEST_SNAPSHOT_ENV, spec.manifest_snapshot.as_str())
		.env(
			DECLARATION_MODULES_ENV,
			serde_json::to_string(
				&spec
					.declaration_modules
					.iter()
					.map(Str::as_str)
					.collect::<Vec<_>>(),
			)
			.map_err(|error| SpawnError::Python(error.to_string()))?,
		)
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.kill_on_drop(true);
	if let Some(entry_path) = &spec.entry_path {
		command.env(ENTRY_PATH_ENV, entry_path);
	} else {
		command.env_remove(ENTRY_PATH_ENV);
	}
	if let Some(root) = &spec.current_dir {
		command.current_dir(root);
	}
	if let Some(snapshot) = &spec.package_snapshot {
		command.env(PACKAGE_SNAPSHOT_ENV, snapshot.as_str());
	} else {
		command.env_remove(PACKAGE_SNAPSHOT_ENV);
	}
	#[cfg(unix)]
	{
		// The child owns a fresh process group. Its CONTROL peer is duplicated
		// onto a stable descriptor; stdio remains ordinary captured logging.
		unsafe {
			command.pre_exec(move || {
				if nix::libc::setpgid(0, 0) == -1 {
					return Err(io::Error::last_os_error());
				}
				if nix::libc::dup2(fd, 3) == -1 {
					return Err(io::Error::last_os_error());
				}
				let flags = nix::libc::fcntl(3, nix::libc::F_GETFD);
				if flags == -1
					|| nix::libc::fcntl(3, nix::libc::F_SETFD, flags & !nix::libc::FD_CLOEXEC) == -1
				{
					return Err(io::Error::last_os_error());
				}
				// The socketpair end was registered with tokio in the parent and
				// carries O_NONBLOCK on its file description; the child's codec
				// reads synchronously and must see a blocking descriptor.
				let status = nix::libc::fcntl(3, nix::libc::F_GETFL);
				if status == -1
					|| nix::libc::fcntl(3, nix::libc::F_SETFL, status & !nix::libc::O_NONBLOCK) == -1
				{
					return Err(io::Error::last_os_error());
				}
				Ok(())
			});
		}
	}
	let mut child = command.spawn().map_err(SpawnError::Spawn)?;
	drop(child_control);
	let (logs_tx, logs) = flume::unbounded();
	let extension_id = spec.key.extension().clone();
	let host_generation = spec.host_generation;
	if let Some(stdout) = child.stdout.take() {
		capture(
			stdout,
			HostLogStream::Stdout,
			logs_tx.clone(),
			extension_id.clone(),
			host_generation,
		);
	}
	if let Some(stderr) = child.stderr.take() {
		capture(stderr, HostLogStream::Stderr, logs_tx, extension_id, host_generation);
	}
	tracing::info!(
		extension_id = %spec.key.extension(),
		host_generation = spec.host_generation,
		session_generation = spec.session_generation,
		process_id = ?child.id(),
		"extension host spawned",
	);
	Ok(SpawnedHost {
		key: spec.key,
		child,
		control: parent,
		logs,
		restart_spec,
		sandbox: sandbox_launch,
	})
}

fn capture<R>(
	stream: R,
	source: HostLogStream,
	logs: flume::Sender<HostLog>,
	extension_id: Str,
	host_generation: u64,
) where
	R: AsyncRead + Unpin + Send + 'static,
{
	tokio::spawn(async move {
		let mut stream = stream;
		let mut bytes = [0_u8; 4096];
		loop {
			let read = match stream.read(&mut bytes).await {
				Ok(read) => read,
				Err(error) => {
					tracing::warn!(
						%extension_id,
						host_generation,
						stream = ?source,
						%error,
						"extension host output reader failed",
					);
					return;
				},
			};
			if read == 0 {
				tracing::debug!(
					%extension_id,
					host_generation,
					stream = ?source,
					"extension host output reader drained",
				);
				return;
			}
			if logs
				.send_async(HostLog { stream: source, bytes: bytes[..read].to_vec() })
				.await
				.is_err()
			{
				tracing::debug!(
					%extension_id,
					host_generation,
					stream = ?source,
					"extension host output drain receiver closed",
				);
				return;
			}
		}
	});
}

/// Runs the hidden extension-host child entry.
///
/// The Python runtime owns the protocol loop after this function establishes
/// that CONTROL is an inherited descriptor rather than standard input.
pub fn run_ext_host_entry() -> Result<(), SpawnError> {
	let fd = env::var(CONTROL_FD_ENV)
		.ok()
		.and_then(|value| value.parse::<i32>().ok())
		.filter(|fd| *fd >= 0)
		.ok_or_else(|| {
			SpawnError::Control(io::Error::new(
				io::ErrorKind::InvalidInput,
				"missing OMP_EXT_CONTROL_FD",
			))
		})?;
	#[cfg(unix)]
	unsafe {
		if nix::libc::fcntl(fd, nix::libc::F_GETFD) == -1 {
			return Err(SpawnError::Control(io::Error::last_os_error()));
		}
	}
	let engine = omp_py::Engine::builder()
		.init()
		.map_err(|error| SpawnError::Python(error.to_string()))?;
	install_package_snapshot(&engine)?;
	engine
		.attach(|py| -> PyResult<()> {
			let module = PyModule::import(py, "omp._host")?;
			let host = module.getattr("bootstrap")?.call0()?;
			host.call_method0("run_forever")?;
			Ok(())
		})
		.map_err(|error| SpawnError::Python(error.to_string()))
}

/// Installs the private site tree and parent-verified snapshot before any
/// extension module imports.
fn install_package_snapshot(engine: &omp_py::Engine) -> Result<(), SpawnError> {
	let snapshot = env::var(PACKAGE_SNAPSHOT_ENV).unwrap_or_else(|_| {
		String::from(r#"{"distributions":[],"modules":{},"own":null,"tree":null}"#)
	});
	engine
		.attach(|py| -> PyResult<()> {
			if let Ok(site) = env::var(PY_SITE_ENV) {
				let sys = PyModule::import(py, "sys")?;
				let value = sys.getattr("path")?;
				let path = value.cast::<PyList>()?;
				path.insert(0, site)?;
			}
			let packages = PyModule::import(py, "omp.packages")?;
			packages.call_method1("_install_snapshot_json", (snapshot,))?;
			Ok(())
		})
		.map_err(|error| SpawnError::Python(error.to_string()))
}
#[cfg(test)]
mod tests {
	use super::*;
	use crate::exthost::cancel::{CancelStage, CancellationJournal};

	#[test]
	fn forced_cancellation_stops_before_authorized_restart() {
		assert!(!cancellation_stops_child(&CancellationOutcome::DispatchCancel));
		assert!(!cancellation_stops_child(&CancellationOutcome::InterruptThread));
		let journal = CancellationJournal {
			extension:  HostKey::new("project", "trusted", "fixture"),
			last_frame: 7,
			stage:      CancelStage::ProcessGroupKill,
		};
		assert!(cancellation_stops_child(&CancellationOutcome::Killed(journal.clone())));
		assert!(cancellation_stops_child(&CancellationOutcome::Disabled(journal)));
	}

	#[tokio::test]
	async fn unknown_trust_tier_never_falls_back_to_raw_spawn() {
		let result = spawn(SpawnSpec {
			key:                 HostKey::new("workspace", "unknown", "fixture"),
			executable:          PathBuf::from("/definitely/not/an/executable"),
			python_site:         PathBuf::from("/definitely/not/a/site"),
			entry_path:          None,
			env_socket:          PathBuf::from("/definitely/not/a/socket"),
			current_dir:         None,
			workspace_root:      None,
			host_generation:     1,
			session_generation:  1,
			package_snapshot:    None,
			manifest_snapshot:   Str::new_static("{}"),
			declaration_modules: Box::new([]),
		})
		.await;
		assert!(matches!(result, Err(SpawnError::UnsupportedTier(tier)) if tier == "unknown"));
	}
}
