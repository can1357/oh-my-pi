//! Supervised child-process transport for persistent Python eval sessions.

use std::{
	collections::{BTreeMap, BTreeSet, HashMap},
	env,
	ffi::{OsStr, OsString},
	fs, future,
	future::Future,
	io::{self, Write as _},
	path::{Path, PathBuf},
	process::{self, Stdio},
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use async_trait::async_trait;
use bytes::Bytes;
use flume::Receiver;
#[cfg(unix)]
use nix::{sys::signal, unistd::Pid};
use omp_core::{CowBytes, Duration as OmpDuration, DurationError, Str, Ulid, encoding::hex, sf};
use omp_tool::BlobRef;
use omp_tools::{
	eval::{
		CellOutcome, CellStatus, CellValue, DisplayOutput, EvalExec, EvalRun, Fault, OutputChannel,
		PythonException, RunCompletion, RunEvent, RunRequest, RuntimeSnapshot, Session, Update,
		idle_timeout::TimeoutHandle, kernel::EmbeddedPython,
	},
	read::image::{self, ImageKind},
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use tokio::{
	io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
	process::{Child, Command},
	runtime,
	sync::Mutex as AsyncMutex,
	task::{self, JoinSet},
	time,
};
use tokio_util::sync::CancellationToken;
#[cfg(windows)]
use windows_sys::Win32::System::Console;

use super::{
	super::blobs::BlobHost,
	PYTHON_PRELUDE,
	bridge::{
		BridgeCapabilities, BridgeHostError, BridgeNamespaceInstaller, BridgeProgressSink,
		ChildBridgeTransport, PreludeStubWire, SessionBridgeHost,
	},
};
use crate::{exec::ExecHost, exec_sandbox::ExecSandbox};

/// Private argv selector used to re-enter `omp` as an eval kernel child.
pub const EVAL_CHILD_ARG: &str = "__omp-eval-child";

const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
const MAX_BRIDGE_PROGRESS_BYTES: usize = 256 * 1024;
const CHILD_TIMEOUT_EXIT: i32 = 124;
const SECRET_MARKERS: &[&str] =
	&["TOKEN", "SECRET", "PASSWORD", "PASSWD", "API_KEY", "PRIVATE_KEY", "CREDENTIAL"];
const OUTPUT_SPILL_THRESHOLD: usize = 128 * 1024;
const MAX_RUNTIME_CWD_BYTES: usize = 16 * 1024;
const MAX_MANAGED_ENV_VALUE_BYTES: usize = 1024 * 1024;
const MAX_MANAGED_ENV_BYTES: usize = 2 * 1024 * 1024;
const MANAGED_ENV_KEYS: [&str; 3] =
	["OMP_ARTIFACTS_DIR", "OMP_EVAL_LOCAL_ROOTS", "OMP_SESSION_FILE"];
#[cfg(target_os = "android")]
const EMBEDDED_INTERPRETER: &str = "embedded:cpython-3.14";
#[cfg(not(target_os = "android"))]
const EMBEDDED_INTERPRETER: &str = "embedded:cpython-3.14t";
const EXTERNAL_RUNNER_SOURCE: &str = include_str!("external_runner.py");

/// Production [`EvalExec`] that owns one killable persistent interpreter child
/// per session.
#[derive(Clone)]
pub struct ProcessEvalExec {
	inner: Arc<ProcessEvalInner>,
}

struct ProcessEvalInner {
	executable:      PathBuf,
	interpreter:     PathBuf,
	exec:            ExecHost,
	host:            Arc<SessionBridgeHost>,
	blobs:           Option<BlobHost>,
	interrupt_grace: OmpDuration,
	sessions:        Mutex<HashMap<Bytes, Arc<ProcessSession>>>,
	next_cell:       AtomicU64,
}

/// Stable supervisor identity for one Python kernel.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct KernelKey {
	/// Tool-owner session namespace.
	pub session:     Bytes,
	/// Interpreter identity selected for this kernel.
	pub interpreter: PathBuf,
}

struct ProcessSession {
	owner:       Str,
	key:         KernelKey,
	child:       AsyncMutex<Option<EvalChild>>,
	run_gate:    Arc<AsyncMutex<()>>,
	needs_reset: AtomicBool,
}

/// Active cell in a process-backed Python session.
pub struct ProcessEvalRun {
	events:          Receiver<Result<RunEvent, Fault>>,
	cancelled:       CancellationToken,
	terminal:        bool,
	effective_reset: bool,
}

impl ProcessEvalExec {
	/// Constructs the production Python executor.
	///
	/// `OMP_PYTHON_INTERPRETER` overrides `configured_interpreter`; when neither
	/// is set, interpreter discovery is deferred until the authoritative
	/// runtime working directory is available.
	pub fn production(
		exec: ExecHost,
		host: Arc<SessionBridgeHost>,
		interrupt_grace: OmpDuration,
		blobs: BlobHost,
		configured_interpreter: Option<PathBuf>,
	) -> Result<Self, io::Error> {
		let executable = resolve_omp_executable()?;
		let requested = env::var_os("OMP_PYTHON_INTERPRETER")
			.or_else(|| configured_interpreter.map(PathBuf::into_os_string));
		let interpreter = match requested {
			Some(requested) => resolve_configured_python(&requested).ok_or_else(|| {
				io::Error::new(
					io::ErrorKind::NotFound,
					format!(
						"configured Python interpreter is not executable: {}",
						requested.to_string_lossy()
					),
				)
			})?,
			None => PathBuf::from(EMBEDDED_INTERPRETER),
		};
		Ok(Self::new_inner(executable, interpreter, exec, host, interrupt_grace, Some(blobs)))
	}

	fn new_inner(
		executable: PathBuf,
		interpreter: PathBuf,
		exec: ExecHost,
		host: Arc<SessionBridgeHost>,
		interrupt_grace: OmpDuration,
		blobs: Option<BlobHost>,
	) -> Self {
		Self {
			inner: Arc::new(ProcessEvalInner {
				executable,
				interpreter,
				exec,
				host,
				blobs,
				interrupt_grace,
				sessions: Mutex::new(HashMap::new()),
				next_cell: AtomicU64::new(1),
			}),
		}
	}
}

impl EvalExec for ProcessEvalExec {
	type Run = ProcessEvalRun;

	fn open_session(&self) -> impl Future<Output = Result<Session, Fault>> + Send + '_ {
		future::ready(Ok(self.create_session("__direct_eval_owner__")))
	}

	fn open_session_for(
		&self,
		owner: &str,
	) -> impl Future<Output = Result<Session, Fault>> + Send + '_ {
		future::ready(Ok(self.create_session(owner)))
	}

	fn runtime_snapshot(&self, owner: &str, session: &Session) -> Result<RuntimeSnapshot, Fault> {
		let owned = self
			.inner
			.sessions
			.lock()
			.get(&session.id)
			.cloned()
			.ok_or_else(|| Fault::SessionLost {
				message: sf!("unknown supervised Python process session"),
			})?;
		if owned.owner != owner {
			return Err(Fault::SessionLost {
				message: sf!("eval session owner does not match the authenticated invocation"),
			});
		}
		self
			.inner
			.host
			.freeze_runtime(owner, &session.id)
			.map_err(|error| Fault::Resource {
				operation: sf!("runtime_snapshot"),
				message:   Str::from(error.to_string()),
			})
	}

	fn run<'a>(
		&'a self,
		session: &'a Session,
		request: RunRequest,
	) -> impl Future<Output = Result<Self::Run, Fault>> + Send + 'a {
		self.start_run(session, request, false)
	}

	fn run_with_mode<'a>(
		&'a self,
		session: &'a Session,
		request: RunRequest,
		disposable: bool,
	) -> impl Future<Output = Result<Self::Run, Fault>> + Send + 'a {
		self.start_run(session, request, disposable)
	}

	fn dispose_session(
		&self,
		session: &Session,
	) -> impl Future<Output = Result<(), Fault>> + Send + '_ {
		let owned = self.inner.sessions.lock().get(&session.id).cloned();
		async move {
			if let Some(owned) = owned {
				self
					.inner
					.host
					.release_runtime(owned.owner.as_str(), &owned.key.session);
				owned.needs_reset.store(true, Ordering::Release);
				if let Some(mut child) = owned.child.lock().await.take() {
					child.terminate().await;
				}
			}
			Ok(())
		}
	}

	fn dispose_all(&self) {
		self.inner.host.clear_runtimes();
		let sessions = self
			.inner
			.sessions
			.lock()
			.values()
			.cloned()
			.collect::<Vec<_>>();
		for owned in sessions {
			owned.needs_reset.store(true, Ordering::Release);
			if let Ok(runtime) = runtime::Handle::try_current() {
				runtime.spawn(async move {
					if let Some(mut child) = owned.child.lock().await.take() {
						child.terminate().await;
					}
				});
			}
		}
	}
}

impl ProcessEvalExec {
	fn create_session(&self, owner: &str) -> Session {
		let id = Bytes::from(format!("py-process-{}", Ulid::generate()));
		let key = KernelKey { session: id.clone(), interpreter: self.inner.interpreter.clone() };
		self.inner.sessions.lock().insert(
			id.clone(),
			Arc::new(ProcessSession {
				owner: Str::new(owner),
				key,
				child: AsyncMutex::new(None),
				run_gate: Arc::new(AsyncMutex::new(())),
				needs_reset: AtomicBool::new(false),
			}),
		);
		Session { id }
	}

	async fn start_run(
		&self,
		session: &Session,
		mut request: RunRequest,
		disposable: bool,
	) -> Result<ProcessEvalRun, Fault> {
		let owned = {
			let sessions = self.inner.sessions.lock();
			sessions.get(&session.id).cloned()
		}
		.ok_or_else(|| Fault::SessionLost {
			message: sf!("unknown supervised Python process session"),
		})?;
		let gate = Arc::clone(&owned.run_gate).lock_owned().await;
		let sandbox = self
			.inner
			.exec
			.active_sandbox()
			.map_err(|error| Fault::Resource {
				operation: sf!("open_session"),
				message:   Str::from(error.to_string()),
			})?;
		// The gate covers child replacement as well as execution, so callers
		// queued on the same session coalesce around the first fresh child.
		let forced_reset = owned.needs_reset.swap(false, Ordering::AcqRel);
		request.reset |= forced_reset || disposable;
		let effective_reset = request.reset;
		let number = self.inner.next_cell.fetch_add(1, Ordering::Relaxed);
		let cell_id = Bytes::from(format!(
			"{}:cell-{number}",
			String::from_utf8_lossy(owned.key.session.as_ref())
		));
		let (events_tx, events) = flume::unbounded();
		let cancelled = CancellationToken::new();
		let task_cancelled = cancelled.clone();
		let executable = self.inner.executable.clone();
		let interpreter = if owned.key.interpreter == Path::new(EMBEDDED_INTERPRETER) {
			request
				.runtime
				.cwd
				.as_deref()
				.and_then(|cwd| discover_external_python(cwd, None))
				.unwrap_or_else(|| owned.key.interpreter.clone())
		} else {
			owned.key.interpreter.clone()
		};
		let host = Arc::clone(&self.inner.host);
		let blobs = self.inner.blobs.clone();
		let interrupt_grace = self.inner.interrupt_grace;
		tokio::spawn(async move {
			let _gate = gate;
			if task_cancelled.is_cancelled() {
				owned.needs_reset.store(true, Ordering::Release);
				return;
			}
			let mut child_slot = owned.child.lock().await;
			if child_slot.as_mut().is_some_and(|child| !child.is_alive()) {
				child_slot.take();
				request.reset = false;
			}
			if request.reset
				&& let Some(mut stale) = child_slot.take()
			{
				stale.terminate().await;
			}
			let mut retry_cancelled = None;
			loop {
				if child_slot.is_none() {
					match EvalChild::spawn(
						&executable,
						&interpreter,
						&owned.key.session,
						request
							.runtime
							.cwd
							.as_deref()
							.unwrap_or_else(|| Path::new(".")),
						Arc::clone(&host),
						interrupt_grace,
						sandbox.clone(),
					)
					.await
					{
						Ok(child) => *child_slot = Some(child),
						Err(error) => {
							owned.needs_reset.store(true, Ordering::Release);
							if task_cancelled.is_cancelled()
								&& let Some(completion) = retry_cancelled.take()
							{
								let _ = events_tx.send(Ok(RunEvent::Completed(completion)));
							} else {
								let _ = events_tx.send(Err(resource_fault("open_session", error)));
							}
							return;
						},
					}
				}
				if request.reset {
					request.reset = false;
				}
				if task_cancelled.is_cancelled()
					&& let Some(completion) = retry_cancelled.take()
				{
					if disposable && let Some(mut child) = child_slot.take() {
						child.terminate().await;
					}
					let _ = events_tx.send(Ok(RunEvent::Completed(completion)));
					return;
				}
				let child = child_slot.as_mut().expect("eval child initialized above");
				match child
					.run_cell(
						cell_id.clone(),
						request.clone(),
						task_cancelled.clone(),
						&events_tx,
						owned.owner.as_str(),
						&owned.key.session,
						Arc::clone(&host),
						&owned.needs_reset,
						blobs.clone(),
						retry_cancelled.is_none(),
					)
					.await
				{
					RunCellDisposition::Keep if !disposable => return,
					RunCellDisposition::RetryDeadCancellation(completion) => {
						child.terminate().await;
						*child_slot = None;
						retry_cancelled = Some(completion);
						if task_cancelled.is_cancelled() {
							owned.needs_reset.store(true, Ordering::Release);
							let _ = events_tx.send(Ok(RunEvent::Completed(
								retry_cancelled
									.take()
									.expect("dead-kernel cancellation recorded above"),
							)));
							return;
						}
					},
					RunCellDisposition::Keep | RunCellDisposition::Drop => {
						child.terminate().await;
						*child_slot = None;
						owned.needs_reset.store(!disposable, Ordering::Release);
						return;
					},
				}
			}
		});
		Ok(ProcessEvalRun { events, cancelled, terminal: false, effective_reset })
	}
}

impl EvalRun for ProcessEvalRun {
	async fn next_event(&mut self) -> Result<Option<RunEvent>, Fault> {
		match self.events.recv_async().await {
			Ok(Ok(event)) => {
				if matches!(event, RunEvent::Completed(_)) {
					self.terminal = true;
				}
				Ok(Some(event))
			},
			Ok(Err(error)) => {
				self.terminal = true;
				Err(error)
			},
			Err(_) => Ok(None),
		}
	}

	fn cancel(&self) -> impl Future<Output = Result<(), Fault>> + Send + '_ {
		self.cancelled.cancel();
		future::ready(Ok(()))
	}

	fn reset(&self) -> bool {
		self.effective_reset
	}
}

enum BridgeTaskEvent {
	Progress { request_id: u64, event: Value },
	Response { request_id: u64, value: Option<Value>, error: Option<Str> },
}

enum ParentLoopEvent {
	Frame(Result<Option<ChildFrame>, ProcessError>),
	Bridge(Option<BridgeTaskEvent>),
	BridgeTaskJoined,
	Cancel,
	InterruptGraceExpired,
	Timeout,
}

struct ProgressChannel {
	request_id: u64,
	events:     flume::Sender<BridgeTaskEvent>,
}
async fn cancel_bridge_tasks(tasks: &mut JoinSet<()>) {
	tasks.abort_all();
	while tasks.join_next().await.is_some() {}
}

impl BridgeProgressSink for ProgressChannel {
	fn progress(&self, event: Value) -> Result<(), BridgeHostError> {
		self
			.events
			.send(BridgeTaskEvent::Progress { request_id: self.request_id, event })
			.map_err(|_| BridgeHostError::message("eval bridge progress receiver was dropped"))
	}
}

struct OutputSpill {
	host:        Option<BlobHost>,
	buffered:    Vec<u8>,
	stage:       Option<omp_storage::blob::BlobStage>,
	total_lines: usize,
	total_bytes: usize,
}

impl OutputSpill {
	fn new(host: Option<BlobHost>) -> Self {
		Self {
			host,
			buffered: Vec::with_capacity(OUTPUT_SPILL_THRESHOLD.min(64 * 1024)),
			stage: None,
			total_lines: 0,
			total_bytes: 0,
		}
	}

	fn push(&mut self, data: &[u8]) -> Result<(), ProcessError> {
		self.total_bytes = self.total_bytes.saturating_add(data.len());
		self.total_lines = self
			.total_lines
			.saturating_add(bytecount::count(data, b'\n'));
		if let Some(stage) = self.stage.as_mut() {
			stage
				.write_all(data)
				.map_err(|error| ProcessError::Spill(Str::from(error.to_string())))?;
			return Ok(());
		}
		if self.buffered.len().saturating_add(data.len()) <= OUTPUT_SPILL_THRESHOLD {
			self.buffered.extend_from_slice(data);
			return Ok(());
		}
		let Some(host) = self.host.as_ref() else {
			self.buffered.clear();
			return Ok(());
		};
		let mut stage = host
			.begin_spill()
			.map_err(|error| ProcessError::Spill(Str::from(error.to_string())))?;
		stage
			.write_all(&self.buffered)
			.and_then(|()| stage.write_all(data))
			.map_err(|error| ProcessError::Spill(Str::from(error.to_string())))?;
		self.buffered.clear();
		self.stage = Some(stage);
		Ok(())
	}

	async fn finish(self) -> Result<Option<BlobRef>, ProcessError> {
		let Some(stage) = self.stage else {
			return Ok(None);
		};
		let reference = task::spawn_blocking(move || stage.finish())
			.await
			.map_err(|error| ProcessError::Spill(Str::from(error.to_string())))?
			.map_err(|error| ProcessError::Spill(Str::from(error.to_string())))?;
		let hash = reference.hash.to_hex();
		Ok(Some(BlobRef {
			hash:       Str::from(hash.as_str()),
			media_type: sf!("text/plain; charset=utf-8"),
			byte_len:   reference.size,
		}))
	}
}

type ProtocolInput = Box<dyn AsyncRead + Unpin + Send>;
type ProtocolOutput = Box<dyn AsyncWrite + Unpin + Send>;

struct EvalChild {
	child:           Child,
	stdin:           ProtocolOutput,
	stdout:          BufReader<ProtocolInput>,
	token:           Str,
	next_run:        AtomicU64,
	process_group:   Option<u32>,
	interrupt_grace: Duration,
}

enum RunCellDisposition {
	Keep,
	Drop,
	RetryDeadCancellation(RunCompletion),
}

const fn should_retry_dead_kernel_cancellation(
	outcome: CellOutcome,
	caller_cancelled: bool,
	kernel_alive: bool,
	retry_available: bool,
) -> bool {
	matches!(outcome, CellOutcome::Cancelled)
		&& !caller_cancelled
		&& !kernel_alive
		&& retry_available
}

impl EvalChild {
	#[tracing::instrument(
		level = "debug",
		name = "eval_child_spawn",
		skip_all,
		fields(external = interpreter != Path::new(EMBEDDED_INTERPRETER))
	)]
	async fn spawn(
		executable: &Path,
		interpreter: &Path,
		session_id: &Bytes,
		cwd: &Path,
		host: Arc<SessionBridgeHost>,
		interrupt_grace: OmpDuration,
		sandbox: Option<Arc<ExecSandbox>>,
	) -> Result<Self, ProcessError> {
		let interrupt_grace_std = interrupt_grace.to_std()?;
		let capabilities = host.capabilities()?.allowed_names();
		let prelude = host.prelude_stubs();
		let token = Str::from(Ulid::generate().to_string());
		let parent_pid = process::id();
		// Both worker forms keep their authenticated protocol on inherited pipes.
		// The external runner duplicates these descriptors before redirecting user
		// stdout/stderr, so confinement needs no loopback or Unix-socket exception.
		let command_for = |program: &Path| {
			sandbox.as_deref().map_or_else(
				|| Command::new(program),
				|sandbox| sandbox.tokio_command(program.as_os_str()),
			)
		};
		let (mut command, external_runner) = if interpreter == Path::new(EMBEDDED_INTERPRETER) {
			let mut command = command_for(executable);
			command.arg(EVAL_CHILD_ARG);
			(command, None)
		} else {
			let runner = stage_external_runner()?;
			let mut command = command_for(interpreter);
			command.arg("-u").arg(&runner);
			(command, Some(runner))
		};
		let environment = sanitized_spawn_env();
		let environment = if let Some(sandbox) = sandbox.as_deref() {
			sandbox.resolve_env(environment)
		} else {
			environment
		};
		command
			.current_dir(cwd)
			.env_clear()
			.envs(environment)
			.env("PYTHONUNBUFFERED", "1")
			.env("PYTHONIOENCODING", "utf-8")
			.env("MPLBACKEND", "Agg")
			.env("OMP_EVAL_SESSION", String::from_utf8_lossy(session_id.as_ref()).as_ref())
			.stderr(Stdio::inherit())
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.kill_on_drop(true);
		#[cfg(unix)]
		{
			use std::os::unix::process::CommandExt;
			command.as_std_mut().process_group(0);
		}
		#[cfg(windows)]
		{
			use windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP;
			command.creation_flags(CREATE_NEW_PROCESS_GROUP);
		}
		let mut child = match command.spawn() {
			Ok(child) => child,
			Err(error) => {
				tracing::warn!(%error, "eval child spawn failed");
				return Err(error.into());
			},
		};
		let process_group = child.id();
		let stdin = child
			.stdin
			.take()
			.ok_or_else(|| ProcessError::Protocol(sf!("eval child stdin unavailable")))?;
		let stdout = child
			.stdout
			.take()
			.ok_or_else(|| ProcessError::Protocol(sf!("eval child stdout unavailable")))?;
		let (stdin, stdout) =
			(Box::new(stdin) as ProtocolOutput, BufReader::new(Box::new(stdout) as ProtocolInput));
		let mut process = Self {
			child,
			stdin,
			stdout,
			token: token.clone(),
			next_run: AtomicU64::new(1),
			process_group,
			interrupt_grace: interrupt_grace_std,
		};
		write_frame(&mut process.stdin, &ParentFrame::Init {
			token,
			session_id: session_id.clone(),
			parent_pid,
			capabilities,
			prelude,
			python_prelude: Str::from(PYTHON_PRELUDE),
			interrupt_grace: Str::from(interrupt_grace.to_string()),
		})
		.await
		.map_err(|error| {
			tracing::warn!(%error, "eval child handshake failed");
			error
		})?;
		// Cold start covers exec plus embedded-interpreter boot; tolerate load
		// spikes that the per-frame runtime deadlines must not.
		let ready = time::timeout(Duration::from_secs(30), read_frame(&mut process.stdout)).await;
		if let Some(runner) = external_runner {
			let _ = fs::remove_file(runner);
		}
		let result = match ready {
			Ok(Ok(Some(ChildFrame::Ready))) => Ok(process),
			Ok(Ok(Some(ChildFrame::Fatal { message }))) => Err(ProcessError::Protocol(message)),
			Ok(Ok(Some(_))) => {
				Err(ProcessError::Protocol(sf!("eval child did not send Ready as its first frame",)))
			},
			Ok(Ok(None)) => Err(ProcessError::Exited),
			Ok(Err(error)) => Err(error),
			Err(_) => Err(ProcessError::Protocol(sf!("eval child startup timed out"))),
		};
		if let Err(error) = &result {
			tracing::warn!(%error, "eval child handshake failed");
		}
		result
	}

	#[tracing::instrument(
		level = "debug",
		name = "eval_child_roundtrip",
		skip_all,
		fields(run_id = tracing::field::Empty)
	)]
	async fn run_cell(
		&mut self,
		cell_id: Bytes,
		request: RunRequest,
		cancelled: CancellationToken,
		events: &flume::Sender<Result<RunEvent, Fault>>,
		owner: &str,
		session: &Bytes,
		host: Arc<SessionBridgeHost>,
		needs_reset: &AtomicBool,
		blobs: Option<BlobHost>,
		retry_dead_cancellation: bool,
	) -> RunCellDisposition {
		let run_id = self.next_run.fetch_add(1, Ordering::Relaxed);
		tracing::Span::current().record("run_id", run_id);
		let started = Instant::now();
		let timeout = TimeoutHandle::new(request.timeout);
		let Ok(timeout_ns) = request
			.timeout
			.map(|duration| u64::try_from(duration.as_nanos()))
			.transpose()
		else {
			let _ = events
				.send(Err(resource_fault("run", ProcessError::Duration(DurationError::Overflow))));
			return RunCellDisposition::Drop;
		};
		if let Err(error) = write_frame(&mut self.stdin, &ParentFrame::Run {
			run_id,
			cell_id: cell_id.clone(),
			code: request.code,
			timeout_ns,
			reset: request.reset,
			runtime: request.runtime,
		})
		.await
		{
			needs_reset.store(true, Ordering::Release);
			let _ = events.send(Err(session_lost(error)));
			return RunCellDisposition::Drop;
		}

		let mut result = None;
		let mut display_outputs = Vec::new();
		let mut exception = None;
		let mut spill = OutputSpill::new(blobs.clone());
		let mut wire_sequence = 0_u64;
		let (bridge_events_tx, bridge_events_rx) = flume::unbounded();
		let mut bridge_tasks = JoinSet::new();
		let mut pending_bridge = BTreeSet::new();
		let mut caller_cancelled = false;
		let mut interrupt_deadline = None;
		loop {
			let event = tokio::select! {
				() = cancelled.cancelled(), if !caller_cancelled => ParentLoopEvent::Cancel,
				() = async {
					match interrupt_deadline {
						Some(deadline) => time::sleep_until(deadline).await,
						None => future::pending().await,
					}
				} => ParentLoopEvent::InterruptGraceExpired,
				() = timeout.expired(), if !caller_cancelled => ParentLoopEvent::Timeout,
				event = bridge_events_rx.recv_async(), if !pending_bridge.is_empty() => {
					ParentLoopEvent::Bridge(event.ok())
				},
				_ = bridge_tasks.join_next(), if !bridge_tasks.is_empty() => {
					ParentLoopEvent::BridgeTaskJoined
				},
				frame = read_frame(&mut self.stdout) => ParentLoopEvent::Frame(frame),
			};
			let frame = match event {
				ParentLoopEvent::Cancel => {
					caller_cancelled = true;
					timeout.dispose();
					let _ = write_frame(&mut self.stdin, &ParentFrame::Cancel { run_id }).await;
					bridge_tasks.abort_all();
					self.interrupt();
					task::yield_now().await;
					for request_id in &pending_bridge {
						let _ = write_frame(&mut self.stdin, &ParentFrame::BridgeResponse {
							request_id: *request_id,
							value:      None,
							error:      Some(sf!("eval cell cancelled")),
						})
						.await;
					}
					pending_bridge.clear();
					interrupt_deadline = Some(time::Instant::now() + self.interrupt_grace);
					continue;
				},
				ParentLoopEvent::InterruptGraceExpired => {
					needs_reset.store(true, Ordering::Release);
					cancel_bridge_tasks(&mut bridge_tasks).await;
					let _ =
						events.send(Ok(RunEvent::Completed(cancelled_completion(elapsed_ms(started)))));
					return RunCellDisposition::Drop;
				},
				ParentLoopEvent::Timeout => {
					needs_reset.store(true, Ordering::Release);
					self.interrupt();
					cancel_bridge_tasks(&mut bridge_tasks).await;
					time::sleep(self.interrupt_grace).await;
					let _ =
						events.send(Ok(RunEvent::Completed(timeout_completion(elapsed_ms(started)))));
					return RunCellDisposition::Drop;
				},
				ParentLoopEvent::Bridge(Some(BridgeTaskEvent::Progress { request_id, event })) => {
					if serde_json::to_vec(&event)
						.is_ok_and(|encoded| encoded.len() <= MAX_BRIDGE_PROGRESS_BYTES)
						&& write_frame(&mut self.stdin, &ParentFrame::BridgeProgress {
							run_id,
							request_id,
							event,
						})
						.await
						.is_err()
					{
						needs_reset.store(true, Ordering::Release);
						cancel_bridge_tasks(&mut bridge_tasks).await;
						return RunCellDisposition::Drop;
					}
					continue;
				},
				ParentLoopEvent::Bridge(Some(BridgeTaskEvent::Response {
					request_id,
					value,
					error,
				})) => {
					pending_bridge.remove(&request_id);
					if write_frame(&mut self.stdin, &ParentFrame::BridgeResponse {
						request_id,
						value,
						error,
					})
					.await
					.is_err()
					{
						needs_reset.store(true, Ordering::Release);
						cancel_bridge_tasks(&mut bridge_tasks).await;
						let _ = events.send(Err(Fault::SessionLost {
							message: sf!("Python eval child exited during a host bridge response",),
						}));
						return RunCellDisposition::Drop;
					}
					continue;
				},
				ParentLoopEvent::Bridge(None) | ParentLoopEvent::BridgeTaskJoined => continue,
				ParentLoopEvent::Frame(frame) => frame,
			};
			let frame = match frame {
				Ok(Some(frame)) => frame,
				Ok(None) | Err(ProcessError::Exited) => {
					needs_reset.store(true, Ordering::Release);
					if self
						.child
						.try_wait()
						.ok()
						.flatten()
						.and_then(|status| status.code())
						== Some(CHILD_TIMEOUT_EXIT)
					{
						let _ =
							events.send(Ok(RunEvent::Completed(timeout_completion(elapsed_ms(started)))));
					} else {
						let _ = events.send(Err(Fault::SessionLost {
							message: sf!("Python eval child exited during the active cell"),
						}));
					}
					return RunCellDisposition::Drop;
				},
				Err(error) => {
					needs_reset.store(true, Ordering::Release);
					let _ = events.send(Err(session_lost(error)));
					return RunCellDisposition::Drop;
				},
			};
			match frame {
				ChildFrame::Started { run_id: actual, cell_id: actual_cell }
					if actual == run_id && actual_cell == cell_id =>
				{
					let _ = events.send(Ok(RunEvent::Started { cell_id: actual_cell }));
				},
				ChildFrame::Stdout { run_id: actual, mut update }
				| ChildFrame::Stderr { run_id: actual, mut update }
					if actual == run_id =>
				{
					if let Err(error) = spill.push(update.data.as_ref()) {
						let _ = events.send(Err(resource_fault("spill_output", error)));
						return RunCellDisposition::Drop;
					}
					update.sequence = wire_sequence;
					wire_sequence = wire_sequence.saturating_add(1);
					let _ = events.send(Ok(RunEvent::Output(update)));
				},
				ChildFrame::Display { run_id: actual, output } if actual == run_id => {
					upsert_display_output(
						&mut display_outputs,
						normalize_display_output(output, blobs.as_ref()),
					);
				},
				ChildFrame::Result { run_id: actual, value } if actual == run_id => {
					result = Some(value);
				},
				ChildFrame::Error { run_id: actual, value } if actual == run_id => {
					exception = Some(value);
				},
				ChildFrame::Done {
					run_id: actual,
					mut status,
					truncated,
					spilled_output,
					total_lines,
					total_bytes,
				} if actual == run_id => {
					timeout.dispose();
					cancel_bridge_tasks(&mut bridge_tasks).await;
					status.exception = exception;
					let spill_total_lines = spill.total_lines;
					let spill_total_bytes = spill.total_bytes;
					let spilled = match spill.finish().await {
						Ok(value) => value,
						Err(error) => {
							let _ = events.send(Err(resource_fault("spill_output", error)));
							return RunCellDisposition::Drop;
						},
					};
					let completion = RunCompletion {
						status,
						result,
						display_outputs,
						truncated: truncated || spilled.is_some(),
						spilled_output: spilled.or(spilled_output),
						total_lines: total_lines.max(spill_total_lines),
						total_bytes: total_bytes.max(spill_total_bytes),
					};
					if matches!(completion.status.outcome, CellOutcome::Cancelled) {
						let kernel_alive = self.is_alive();
						if should_retry_dead_kernel_cancellation(
							completion.status.outcome,
							cancelled.is_cancelled(),
							kernel_alive,
							retry_dead_cancellation,
						) {
							return RunCellDisposition::RetryDeadCancellation(completion);
						}
						let _ = events.send(Ok(RunEvent::Completed(completion)));
						return if kernel_alive {
							RunCellDisposition::Keep
						} else {
							RunCellDisposition::Drop
						};
					}
					let _ = events.send(Ok(RunEvent::Completed(completion)));
					return RunCellDisposition::Keep;
				},
				ChildFrame::BridgeCall { run_id: actual, request_id, token, name, args }
					if actual == run_id && token == self.token =>
				{
					let capability_error = match host.capabilities() {
						Ok(value) if value.allows(name.as_str()) => None,
						Ok(_) => Some(Str::from(format!("bridge capability denied: {name}"))),
						Err(error) => Some(Str::from(error.to_string())),
					};
					if let Some(error) = capability_error {
						if write_frame(&mut self.stdin, &ParentFrame::BridgeResponse {
							request_id,
							value: None,
							error: Some(error),
						})
						.await
						.is_err()
						{
							needs_reset.store(true, Ordering::Release);
							cancel_bridge_tasks(&mut bridge_tasks).await;
							return RunCellDisposition::Drop;
						}
						continue;
					}
					pending_bridge.insert(request_id);
					let task_host = Arc::clone(&host);
					let task_timeout = timeout.clone();
					let task_owner = Str::new(owner);
					let task_session = session.clone();
					let task_events = bridge_events_tx.clone();
					bridge_tasks.spawn(async move {
						let progress = ProgressChannel { request_id, events: task_events.clone() };
						let response = task_timeout
							.host_wait(task_host.call_for(
								task_owner.as_str(),
								&task_session,
								name.as_str(),
								args,
								&progress,
							))
							.await;
						let (value, error) = match response {
							Ok(value) => (Some(value), None),
							Err(error) => (None, Some(Str::from(error.to_string()))),
						};
						let _ = task_events.send(BridgeTaskEvent::Response { request_id, value, error });
					});
				},
				ChildFrame::Fatal { message } => {
					needs_reset.store(true, Ordering::Release);
					let _ = events.send(Err(Fault::SessionLost { message }));
				},
				_ => {
					needs_reset.store(true, Ordering::Release);
					let _ = events.send(Err(Fault::SessionLost {
						message: sf!("Python eval child sent an invalid or out-of-order frame",),
					}));

					return RunCellDisposition::Drop;
				},
			}
		}
	}

	fn is_alive(&mut self) -> bool {
		self.child.try_wait().is_ok_and(|status| status.is_none())
	}

	fn interrupt(&self) {
		#[cfg(unix)]
		if let Some(pid) = self.process_group {
			let _ = signal::killpg(Pid::from_raw(pid.cast_signed()), signal::Signal::SIGINT);
		}
		#[cfg(windows)]
		if let Some(pid) = self.process_group {
			unsafe {
				let _ = Console::GenerateConsoleCtrlEvent(Console::CTRL_BREAK_EVENT, pid);
			}
		}
	}

	async fn terminate(&mut self) {
		let _ = write_frame(&mut self.stdin, &ParentFrame::Exit).await;
		if time::timeout(self.interrupt_grace, self.child.wait())
			.await
			.is_ok_and(|status| status.is_ok())
		{
			self.process_group.take();
			return;
		}
		let pid = self.process_group.take();
		#[cfg(unix)]
		if let Some(pid) = pid {
			let _ = signal::killpg(Pid::from_raw(pid.cast_signed()), signal::Signal::SIGTERM);
		}
		#[cfg(windows)]
		if pid.is_some() {
			let _ = self.child.start_kill();
		}
		if time::timeout(self.interrupt_grace, self.child.wait())
			.await
			.is_ok_and(|status| status.is_ok())
		{
			return;
		}
		#[cfg(unix)]
		if let Some(pid) = pid {
			let _ = signal::killpg(Pid::from_raw(pid.cast_signed()), signal::Signal::SIGKILL);
		}
		#[cfg(windows)]
		{
			let _ = self.child.start_kill();
		}
		let _ = self.child.wait().await;
	}
}
impl Drop for EvalChild {
	fn drop(&mut self) {
		let pid = self.process_group;
		#[cfg(unix)]
		if let Some(pid) = pid {
			let _ = signal::killpg(Pid::from_raw(pid.cast_signed()), signal::Signal::SIGKILL);
		}
		#[cfg(windows)]
		{
			let _ = self.child.start_kill();
		}
	}
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ParentFrame {
	Init {
		token:           Str,
		session_id:      Bytes,
		parent_pid:      u32,
		capabilities:    Vec<Str>,
		prelude:         Vec<PreludeStubWire>,
		python_prelude:  Str,
		interrupt_grace: Str,
	},
	Run {
		run_id:     u64,
		cell_id:    Bytes,
		code:       Str,
		timeout_ns: Option<u64>,
		reset:      bool,
		runtime:    RuntimeSnapshot,
	},
	Cancel {
		run_id: u64,
	},
	BridgeProgress {
		run_id:     u64,
		request_id: u64,
		event:      Value,
	},
	BridgeResponse {
		request_id: u64,
		value:      Option<Value>,
		error:      Option<Str>,
	},
	Exit,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ChildFrame {
	Ready,
	Started {
		run_id:  u64,
		cell_id: Bytes,
	},
	Stdout {
		run_id: u64,
		update: Update,
	},
	Stderr {
		run_id: u64,
		update: Update,
	},
	Display {
		run_id: u64,
		output: DisplayOutput,
	},
	Result {
		run_id: u64,
		value:  CellValue,
	},
	Error {
		run_id: u64,
		value:  PythonException,
	},
	Done {
		run_id:         u64,
		status:         CellStatus,
		truncated:      bool,
		spilled_output: Option<BlobRef>,
		total_lines:    usize,
		total_bytes:    usize,
	},
	BridgeCall {
		run_id:     u64,
		request_id: u64,
		token:      Str,
		name:       Str,
		args:       Value,
	},
	Fatal {
		message: Str,
	},
}

enum ChildBridgeEvent {
	Progress(Value),
	Response(Result<Value, Str>),
}

struct ChildBridgeHost {
	token:         Str,
	capabilities:  BridgeCapabilities,
	outgoing:      flume::Sender<ChildFrame>,
	pending:       Mutex<BTreeMap<u64, flume::Sender<ChildBridgeEvent>>>,
	next_request:  AtomicU64,
	active_run:    AtomicU64,
	cancelled_run: AtomicU64,
}

impl ChildBridgeHost {
	fn progress(&self, request_id: u64, event: Value) {
		if let Some(pending) = self.pending.lock().get(&request_id) {
			let _ = pending.send(ChildBridgeEvent::Progress(event));
		}
	}

	fn resolve(&self, request_id: u64, result: Result<Value, Str>) {
		let pending = self.pending.lock().remove(&request_id);
		if let Some(pending) = pending {
			let _ = pending.send(ChildBridgeEvent::Response(result));
		}
	}
}

#[async_trait]
impl ChildBridgeTransport for ChildBridgeHost {
	fn capabilities(&self) -> BridgeCapabilities {
		self.capabilities.clone()
	}

	async fn call(
		&self,
		name: &str,
		args: Value,
		progress: &dyn BridgeProgressSink,
	) -> Result<Value, BridgeHostError> {
		if !self.capabilities.allows(name) {
			return Err(BridgeHostError::message(format!("bridge capability denied: {name}")));
		}
		let request_id = self.next_request.fetch_add(1, Ordering::Relaxed);
		let run_id = self.active_run.load(Ordering::Acquire);
		if run_id != 0 && self.cancelled_run.load(Ordering::Acquire) == run_id {
			return Err(BridgeHostError::message("eval cell cancelled"));
		}
		let (sender, receiver) = flume::unbounded();
		self.pending.lock().insert(request_id, sender);
		if self
			.outgoing
			.send(ChildFrame::BridgeCall {
				run_id,
				request_id,
				token: self.token.clone(),
				name: Str::from(name),
				args,
			})
			.is_err()
		{
			self.pending.lock().remove(&request_id);
			return Err(BridgeHostError::message("eval parent bridge disconnected"));
		}
		loop {
			match receiver.recv_async().await {
				Ok(ChildBridgeEvent::Progress(event)) => progress.progress(event)?,
				Ok(ChildBridgeEvent::Response(result)) => {
					return result.map_err(BridgeHostError::message);
				},
				Err(_) => {
					return Err(BridgeHostError::message("eval parent bridge response was dropped"));
				},
			}
		}
	}
}

#[cfg(unix)]
type ProtocolCapture = Option<(fs::File, fs::File)>;
#[cfg(not(unix))]
type ProtocolCapture = ();

struct ShieldedProtocol {
	input:   ProtocolInput,
	output:  ProtocolOutput,
	capture: ProtocolCapture,
}
#[cfg(unix)]
fn shield_protocol_fds() -> io::Result<ShieldedProtocol> {
	use std::os::fd::{AsRawFd, FromRawFd};

	fn duplicate(fd: libc::c_int) -> io::Result<libc::c_int> {
		// SAFETY: `dup` only borrows the valid process fd and returns a new fd.
		let duplicate = unsafe { libc::dup(fd) };
		if duplicate < 0 {
			return Err(io::Error::last_os_error());
		}
		// Protocol duplicates must never leak into subprocesses spawned by cells.
		// SAFETY: the duplicate is owned here and `F_SETFD` does not access memory.
		if unsafe { libc::fcntl(duplicate, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
			// SAFETY: the duplicate is owned here.
			unsafe { libc::close(duplicate) };
			return Err(io::Error::last_os_error());
		}
		Ok(duplicate)
	}

	fn pipe() -> io::Result<[libc::c_int; 2]> {
		let mut descriptors = [-1; 2];
		// SAFETY: `descriptors` points to two writable integers.
		if unsafe { libc::pipe(descriptors.as_mut_ptr()) } < 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(descriptors)
	}

	let protocol_in = duplicate(libc::STDIN_FILENO)?;
	let protocol_out = duplicate(libc::STDOUT_FILENO)?;
	let stdout_pipe = pipe()?;
	let stderr_pipe = pipe()?;
	let null = fs::File::open("/dev/null")?;
	// Preserve private protocol duplicates, then make fd 0 inert and route all
	// native/user child output into capture drains. This prevents `input()` and
	// `os.write(1, ...)` from consuming or spoofing protocol frames.
	// SAFETY: every source and destination is a valid open descriptor.
	let redirected = unsafe {
		libc::dup2(null.as_raw_fd(), libc::STDIN_FILENO) >= 0
			&& libc::dup2(stdout_pipe[1], libc::STDOUT_FILENO) >= 0
			&& libc::dup2(stderr_pipe[1], libc::STDERR_FILENO) >= 0
	};
	// SAFETY: the duplicated write ends are no longer needed after `dup2`.
	unsafe {
		libc::close(stdout_pipe[1]);
		libc::close(stderr_pipe[1]);
	}
	if !redirected {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: every raw fd is uniquely owned after the operations above.
	let input = unsafe { fs::File::from_raw_fd(protocol_in) };
	// SAFETY: see above.
	let output = unsafe { fs::File::from_raw_fd(protocol_out) };
	// SAFETY: see above.
	let stdout_capture = unsafe { fs::File::from_raw_fd(stdout_pipe[0]) };
	// SAFETY: see above.
	let stderr_capture = unsafe { fs::File::from_raw_fd(stderr_pipe[0]) };
	for capture in [&stdout_capture, &stderr_capture] {
		// SAFETY: `capture` owns a valid descriptor and these operations only
		// update its file-status flags.
		let flags = unsafe { libc::fcntl(capture.as_raw_fd(), libc::F_GETFL) };
		if flags < 0
			|| unsafe { libc::fcntl(capture.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
		{
			return Err(io::Error::last_os_error());
		}
	}
	Ok(ShieldedProtocol {
		input:   Box::new(tokio::fs::File::from_std(input)),
		output:  Box::new(tokio::fs::File::from_std(output)),
		capture: Some((stdout_capture, stderr_capture)),
	})
}

#[cfg(not(unix))]
fn shield_protocol_fds() -> io::Result<ShieldedProtocol> {
	use tokio::io;
	Ok(ShieldedProtocol {
		input:   Box::new(io::stdin()),
		output:  Box::new(io::stdout()),
		capture: (),
	})
}

#[derive(Default)]
struct CaptureBarrier {
	commands: Vec<flume::Sender<flume::Sender<()>>>,
}

impl CaptureBarrier {
	async fn drain(&self) {
		for commands in &self.commands {
			let (acknowledge, acknowledged) = flume::bounded(1);
			if commands.send(acknowledge).is_ok() {
				let _ = acknowledged.recv_async().await;
			}
		}
	}
}

#[cfg(unix)]
fn start_fd_capture(
	capture: ProtocolCapture,
	host: &Arc<ChildBridgeHost>,
) -> io::Result<CaptureBarrier> {
	use std::io::Read as _;

	let Some((stdout, stderr)) = capture else {
		return Ok(CaptureBarrier::default());
	};
	let mut commands = Vec::with_capacity(2);
	for (mut reader, channel) in [(stdout, OutputChannel::Stdout), (stderr, OutputChannel::Stderr)] {
		let host = Arc::clone(host);
		let (command_tx, command_rx) = flume::unbounded::<flume::Sender<()>>();
		commands.push(command_tx);
		thread::Builder::new()
			.name(format!("omp-eval-fd-{channel:?}"))
			.spawn(move || {
				let mut buffer = [0_u8; 16 * 1024];
				loop {
					match reader.read(&mut buffer) {
						Ok(0) => break,
						Ok(read) => {
							let run_id = host.active_run.load(Ordering::Acquire);
							if run_id == 0 {
								continue;
							}
							let update = Update {
								channel,
								data: CowBytes::from(buffer[..read].to_vec()),
								sequence: 0,
							};
							let frame = match channel {
								OutputChannel::Stdout => ChildFrame::Stdout { run_id, update },
								OutputChannel::Stderr => ChildFrame::Stderr { run_id, update },
							};
							if host.outgoing.send(frame).is_err() {
								break;
							}
						},
						Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
							while let Ok(acknowledge) = command_rx.try_recv() {
								let _ = acknowledge.send(());
							}
							thread::sleep(Duration::from_millis(1));
						},
						Err(_) => break,
					}
				}
			})?;
	}
	Ok(CaptureBarrier { commands })
}

#[cfg(not(unix))]
fn start_fd_capture(
	_capture: ProtocolCapture,
	_host: &Arc<ChildBridgeHost>,
) -> io::Result<CaptureBarrier> {
	Ok(CaptureBarrier::default())
}

/// Validates the parent identity before the embedded interpreter starts.
fn validate_parent_identity(parent_pid: u32) -> Result<(), ProcessError> {
	if parent_pid <= 1 {
		return Err(ProcessError::InvalidParentIdentity);
	}
	#[cfg(unix)]
	{
		// SAFETY: getppid has no preconditions and does not access memory.
		let actual = unsafe { libc::getppid() };
		if actual <= 1 || u32::try_from(actual).ok() != Some(parent_pid) {
			return Err(ProcessError::InvalidParentIdentity);
		}
	}
	Ok(())
}

/// Starts a process-local watchdog. Protocol EOF is the pipe half of this
/// contract; POSIX additionally detects reparenting while an active cell keeps
/// the protocol reader alive.
fn start_parent_watchdog(parent_pid: u32) -> io::Result<()> {
	#[cfg(unix)]
	{
		thread::Builder::new()
			.name("omp-eval-parent-watchdog".to_owned())
			.spawn(move || {
				loop {
					thread::sleep(Duration::from_millis(100));
					// SAFETY: getppid has no preconditions and does not access memory.
					let actual = unsafe { libc::getppid() };
					if actual <= 1 || u32::try_from(actual).ok() != Some(parent_pid) {
						terminate_orphaned_process_group();
					}
				}
			})?;
	}
	#[cfg(not(unix))]
	let _ = parent_pid;
	Ok(())
}

fn terminate_orphaned_process_group() {
	#[cfg(unix)]
	{
		// The eval child is its own process-group leader. Killing the entire
		// group prevents user-spawned descendants from surviving host loss.
		// SAFETY: getpgrp has no preconditions; kill addresses that process group.
		let group = unsafe { libc::getpgrp() };
		let process = unsafe { libc::getpid() };
		if group > 1 && group == process {
			unsafe {
				libc::kill(-group, libc::SIGKILL);
			}
		} else {
			process::exit(0);
		}
	}
	#[cfg(not(unix))]
	process::exit(0);
}

fn validate_runtime_snapshot(snapshot: RuntimeSnapshot) -> Result<RuntimeSnapshot, ProcessError> {
	let cwd = snapshot
		.cwd
		.as_deref()
		.ok_or(ProcessError::MissingRuntimeCwd)?;
	if !cwd.is_absolute()
		|| cwd.as_os_str().as_encoded_bytes().is_empty()
		|| cwd.as_os_str().as_encoded_bytes().len() > MAX_RUNTIME_CWD_BYTES
	{
		return Err(ProcessError::InvalidRuntimeCwd);
	}
	if snapshot.managed_env.len() != MANAGED_ENV_KEYS.len()
		|| MANAGED_ENV_KEYS
			.iter()
			.any(|key| !snapshot.managed_env.contains_key(*key))
	{
		return Err(ProcessError::InvalidManagedEnvironment);
	}
	let mut total = 0usize;
	for (key, value) in &snapshot.managed_env {
		if !MANAGED_ENV_KEYS.contains(&key.as_str()) {
			return Err(ProcessError::InvalidManagedEnvironment);
		}
		total = total.saturating_add(key.len());
		if let Some(value) = value {
			if value.len() > MAX_MANAGED_ENV_VALUE_BYTES || value.as_bytes().contains(&0) {
				return Err(ProcessError::InvalidManagedEnvironment);
			}
			total = total.saturating_add(value.len());
		}
	}
	if total > MAX_MANAGED_ENV_BYTES {
		return Err(ProcessError::InvalidManagedEnvironment);
	}
	Ok(snapshot)
}

/// Runs the hidden eval child entry before ordinary CLI or telemetry startup.
#[tracing::instrument(level = "debug", name = "eval_child_entry", skip_all)]
pub async fn run_eval_child_entry() -> Result<(), ProcessError> {
	let ShieldedProtocol { input, mut output, capture } = shield_protocol_fds()?;
	let mut stdin = BufReader::new(input);
	let (token, parent_pid, capabilities, prelude, interrupt_grace) =
		match read_frame::<_, ParentFrame>(&mut stdin).await? {
			Some(ParentFrame::Init {
				token,
				session_id: _,
				parent_pid,
				capabilities,
				prelude,
				python_prelude: _,
				interrupt_grace,
			}) => (token, parent_pid, capabilities, prelude, interrupt_grace.parse::<OmpDuration>()?),
			Some(_) => {
				return Err(ProcessError::Protocol(sf!("Init must be the first eval child frame",)));
			},
			None => return Ok(()),
		};
	validate_parent_identity(parent_pid)?;
	start_parent_watchdog(parent_pid)?;
	let (outgoing, outgoing_rx) = flume::unbounded();
	let child_host = Arc::new(ChildBridgeHost {
		token,
		capabilities: BridgeCapabilities::from_allowed_names(capabilities),
		outgoing,
		pending: Mutex::new(BTreeMap::new()),
		next_request: AtomicU64::new(1),
		active_run: AtomicU64::new(0),
		cancelled_run: AtomicU64::new(0),
	});
	let capture_barrier = Arc::new(start_fd_capture(capture, &child_host)?);
	let writer = tokio::spawn(async move {
		while let Ok(frame) = outgoing_rx.recv_async().await {
			write_frame(&mut output, &frame).await?;
		}
		Ok::<(), ProcessError>(())
	});
	let runtime = runtime::Handle::current();
	let transport: Arc<dyn ChildBridgeTransport> = child_host.clone();
	let installer = Arc::new(BridgeNamespaceInstaller::new_child(transport, runtime, prelude));
	let engine = omp_py::Engine::builder()
		.init()
		.map(Arc::new)
		.map_err(|error| ProcessError::Python(Str::from(error.to_string())))?;
	let eval = EmbeddedPython::with_installer(engine, installer, interrupt_grace)?;
	let session = eval.open_session().await.map_err(ProcessError::Eval)?;
	child_host
		.outgoing
		.send(ChildFrame::Ready)
		.map_err(|_| ProcessError::Exited)?;
	let active = Arc::new(AtomicBool::new(false));
	loop {
		match read_frame::<_, ParentFrame>(&mut stdin).await? {
			Some(ParentFrame::Run { run_id, cell_id, code, timeout_ns, reset, runtime }) => {
				if active.swap(true, Ordering::AcqRel) {
					child_host
						.outgoing
						.send(ChildFrame::Fatal {
							message: sf!("eval child received overlapping Run frames"),
						})
						.map_err(|_| ProcessError::Exited)?;
					continue;
				}
				child_host.active_run.store(run_id, Ordering::Release);
				child_host.cancelled_run.store(0, Ordering::Release);
				let runtime = validate_runtime_snapshot(runtime)?;
				let mut run = match eval
					.run(&session, RunRequest {
						code,
						timeout: timeout_ns.map(Duration::from_nanos),
						reset,
						runtime,
					})
					.await
				{
					Ok(run) => run,
					Err(error) => {
						active.store(false, Ordering::Release);
						child_host.active_run.store(0, Ordering::Release);
						child_host
							.outgoing
							.send(ChildFrame::Fatal { message: Str::from(format!("{error:?}")) })
							.map_err(|_| ProcessError::Exited)?;
						continue;
					},
				};
				let outgoing = child_host.outgoing.clone();
				let active_flag = Arc::clone(&active);
				let run_route = Arc::clone(&child_host);
				let capture_barrier = Arc::clone(&capture_barrier);
				tokio::spawn(async move {
					loop {
						match run.next_event().await {
							Ok(Some(RunEvent::Started { .. })) => {
								let _ =
									outgoing.send(ChildFrame::Started { run_id, cell_id: cell_id.clone() });
							},
							Ok(Some(RunEvent::Output(update))) => {
								let frame = match update.channel {
									OutputChannel::Stdout => ChildFrame::Stdout { run_id, update },
									OutputChannel::Stderr => ChildFrame::Stderr { run_id, update },
								};
								let _ = outgoing.send(frame);
							},
							Ok(Some(RunEvent::Completed(completion))) => {
								capture_barrier.drain().await;
								run_route.active_run.store(0, Ordering::Release);
								active_flag.store(false, Ordering::Release);
								let RunCompletion {
									mut status,
									result,
									display_outputs,
									truncated,
									spilled_output,
									total_lines,
									total_bytes,
								} = completion;
								for output in display_outputs {
									let _ = outgoing.send(ChildFrame::Display { run_id, output });
								}
								if let Some(value) = result {
									let _ = outgoing.send(ChildFrame::Result { run_id, value });
								}
								if let Some(value) = status.exception.take() {
									let _ = outgoing.send(ChildFrame::Error { run_id, value });
								}
								let _ = outgoing.send(ChildFrame::Done {
									run_id,
									status,
									truncated,
									spilled_output,
									total_lines,
									total_bytes,
								});
								break;
							},
							Ok(None) => {
								run_route.active_run.store(0, Ordering::Release);
								active_flag.store(false, Ordering::Release);
								let _ = outgoing.send(ChildFrame::Fatal {
									message: sf!("embedded eval stream ended without completion",),
								});
								break;
							},
							Err(error) => {
								run_route.active_run.store(0, Ordering::Release);
								active_flag.store(false, Ordering::Release);
								let _ = outgoing
									.send(ChildFrame::Fatal { message: Str::from(format!("{error:?}")) });
								break;
							},
						}
					}
				});
			},
			Some(ParentFrame::Cancel { run_id })
				if run_id == child_host.active_run.load(Ordering::Acquire) =>
			{
				child_host.cancelled_run.store(run_id, Ordering::Release);
			},
			Some(ParentFrame::Cancel { .. }) => {
				return Err(ProcessError::Protocol(sf!("stale eval cell cancellation frame")));
			},
			Some(ParentFrame::BridgeProgress { run_id, request_id, event })
				if run_id == child_host.active_run.load(Ordering::Acquire) =>
			{
				child_host.progress(request_id, event);
			},
			Some(ParentFrame::BridgeProgress { .. }) => {
				return Err(ProcessError::Protocol(sf!("stale eval bridge progress frame")));
			},
			Some(ParentFrame::BridgeResponse { request_id, value, error }) => {
				let result = match (value, error) {
					(Some(value), None) => Ok(value),
					(None, Some(error)) => Err(error),
					_ => Err(sf!("malformed eval parent bridge response")),
				};
				child_host.resolve(request_id, result);
			},
			Some(ParentFrame::Init { .. }) => {
				return Err(ProcessError::Protocol(sf!("duplicate eval child Init frame")));
			},
			Some(ParentFrame::Exit) => break,
			None => {
				terminate_orphaned_process_group();
				break;
			},
		}
	}
	writer.abort();
	let _ = writer.await;
	Ok(())
}

/// Eval child startup, framing, bridge, or embedded-runtime failure.
#[derive(Debug, thiserror::Error)]
pub enum ProcessError {
	/// Standard-I/O transport failed.
	#[error("eval child I/O failed: {0}")]
	Io(#[from] io::Error),
	/// A frame exceeded the fixed transport bound.
	#[error("eval child frame exceeded the {MAX_FRAME_BYTES}-byte limit")]
	FrameTooLarge,
	/// A bounded frame did not contain valid protocol JSON.
	#[error("eval child sent an invalid frame: {0}")]
	Json(#[from] serde_json::Error),
	/// Parent and child violated the expected protocol sequence.
	#[error("eval child protocol violation: {0}")]
	Protocol(Str),
	/// Init did not name the process that actually owns the child.
	#[error("eval child parent identity is invalid")]
	InvalidParentIdentity,
	/// A run omitted its authoritative working directory.
	#[error("eval child runtime snapshot omitted its working directory")]
	MissingRuntimeCwd,
	/// A run supplied a non-absolute or oversized working directory.
	#[error("eval child runtime working directory is invalid")]
	InvalidRuntimeCwd,
	/// A run supplied missing, unknown, oversized, or malformed managed values.
	#[error("eval child managed environment snapshot is invalid")]
	InvalidManagedEnvironment,
	/// The child could not initialize embedded Python.
	#[error("eval child embedded Python failed: {0}")]
	Python(Str),
	/// A configured or serialized duration was not representable.
	#[error("eval child duration failed: {0}")]
	Duration(#[from] DurationError),
	/// The child's embedded eval kernel rejected an operation.
	#[error("eval child kernel failed: {0:?}")]
	Eval(Fault),
	/// Durable oversized-output staging failed.
	#[error("eval child output spill failed: {0}")]
	Spill(Str),
	/// The child closed its protocol stream.
	#[error("eval child exited")]
	Exited,
	/// The authenticated host bridge rejected startup or dispatch.
	#[error(transparent)]
	Bridge(#[from] BridgeHostError),
}

async fn write_frame<W: AsyncWrite + Unpin + Send, T: Serialize + Sync>(
	writer: &mut W,
	frame: &T,
) -> Result<(), ProcessError> {
	let encoded = serde_json::to_vec(frame)?;
	if encoded.is_empty() || encoded.len() > MAX_FRAME_BYTES {
		return Err(ProcessError::FrameTooLarge);
	}
	write_encoded_frame(writer, &encoded).await
}

async fn write_encoded_frame<W: AsyncWrite + Unpin + Send>(
	writer: &mut W,
	encoded: &[u8],
) -> Result<(), ProcessError> {
	writer.write_all(encoded).await?;
	writer.write_all(b"\n").await?;
	writer.flush().await?;
	Ok(())
}
fn sanitized_spawn_env() -> Vec<(OsString, OsString)> {
	env::vars_os()
		.filter(|(name, _)| spawn_env_allowed(name))
		.collect()
}
fn stage_external_runner() -> io::Result<PathBuf> {
	let path = env::temp_dir().join(format!("omp-eval-runner-{}.py", Ulid::generate()));
	let mut file = fs::OpenOptions::new()
		.write(true)
		.create_new(true)
		.open(&path)?;
	if let Err(error) = file.write_all(EXTERNAL_RUNNER_SOURCE.as_bytes()) {
		let _ = fs::remove_file(&path);
		return Err(error);
	}
	Ok(path)
}

fn spawn_env_allowed(name: &OsStr) -> bool {
	let upper = name.to_string_lossy().to_ascii_uppercase();
	let secret = SECRET_MARKERS.iter().any(|marker| upper.contains(marker));
	!secret
		&& (matches!(
			upper.as_str(),
			"PATH"
				| "HOME" | "USER"
				| "LOGNAME"
				| "SHELL"
				| "TMPDIR"
				| "TEMP" | "TMP"
				| "LANG" | "TERM"
				| "COLORTERM"
				| "NO_COLOR"
				| "SYSTEMROOT"
				| "WINDIR"
				| "COMSPEC"
				| "PATHEXT"
				| "USERPROFILE"
				| "APPDATA"
				| "LOCALAPPDATA"
		) || upper.starts_with("LC_")
			|| upper.starts_with("OMP_EVAL_")
			|| upper.starts_with("OMP_PY_"))
}

fn resolve_configured_python(command: &OsStr) -> Option<PathBuf> {
	let candidate = expand_home(PathBuf::from(command));
	if candidate.is_file() {
		return Some(candidate);
	}
	if candidate.components().count() != 1 {
		return None;
	}
	env::var_os("PATH").and_then(|path| {
		env::split_paths(&path)
			.map(|directory| directory.join(command))
			.find(|candidate| candidate.is_file())
	})
}

/// Discovers an external Python executable for a runtime working directory.
///
/// Explicit configuration wins, followed by active environments, project
/// virtual environments, pyenv, and finally `PATH`.
pub fn discover_external_python(cwd: &Path, explicit: Option<&OsStr>) -> Option<PathBuf> {
	let executable = if cfg!(windows) {
		"python.exe"
	} else {
		"python"
	};
	let mut candidates = Vec::new();
	if let Some(explicit) = explicit {
		if let Some(candidate) = resolve_configured_python(explicit) {
			return Some(candidate);
		}
	}
	for name in ["VIRTUAL_ENV", "CONDA_PREFIX", "UV_PROJECT_ENVIRONMENT"] {
		if let Some(root) = env::var_os(name) {
			candidates.push(interpreter_below(Path::new(&root), executable));
		}
	}
	candidates.push(interpreter_below(&cwd.join(".venv"), executable));
	candidates.push(interpreter_below(&cwd.join("venv"), executable));
	if let (Some(root), Some(version)) = (env::var_os("PYENV_ROOT"), env::var_os("PYENV_VERSION")) {
		candidates
			.push(interpreter_below(&PathBuf::from(root).join("versions").join(version), executable));
	}
	if let Some(path) = env::var_os("PATH") {
		candidates.extend(env::split_paths(&path).flat_map(|directory| {
			["python3", executable]
				.into_iter()
				.map(move |name| directory.join(format!("{name}{}", env::consts::EXE_SUFFIX)))
		}));
	}
	candidates.into_iter().find(|candidate| candidate.is_file())
}

fn interpreter_below(root: &Path, executable: &str) -> PathBuf {
	if cfg!(windows) {
		root.join("Scripts").join(executable)
	} else {
		root.join("bin").join(executable)
	}
}

fn expand_home(path: PathBuf) -> PathBuf {
	let Some(text) = path.to_str() else {
		return path;
	};
	if text == "~" {
		return env::var_os("HOME").map(PathBuf::from).unwrap_or(path);
	}
	let Some(rest) = text.strip_prefix("~/") else {
		return path;
	};
	env::var_os("HOME")
		.map(|home| PathBuf::from(home).join(rest))
		.unwrap_or(path)
}

async fn read_frame<R: AsyncBufRead + Unpin + Send, T: DeserializeOwned>(
	reader: &mut R,
) -> Result<Option<T>, ProcessError> {
	let mut encoded = Vec::new();
	loop {
		let available = reader.fill_buf().await?;
		if available.is_empty() {
			if encoded.is_empty() {
				return Ok(None);
			}
			return Err(ProcessError::Protocol(sf!("unterminated NDJSON frame")));
		}
		let newline = available.iter().position(|byte| *byte == b'\n');
		let take = newline.map_or(available.len(), |index| index + 1);
		if encoded.len().saturating_add(take) > MAX_FRAME_BYTES.saturating_add(1) {
			return Err(ProcessError::FrameTooLarge);
		}
		if let Some(index) = newline {
			encoded.extend_from_slice(&available[..index]);
			reader.consume(take);
			break;
		}
		encoded.extend_from_slice(&available[..take]);
		reader.consume(take);
	}
	if encoded.last() == Some(&b'\r') {
		encoded.pop();
	}
	if encoded.is_empty() {
		return Err(ProcessError::Protocol(sf!("empty NDJSON frame")));
	}
	serde_json::from_slice(&encoded)
		.map(Some)
		.map_err(ProcessError::from)
}

fn resolve_omp_executable() -> io::Result<PathBuf> {
	if let Some(path) = env::var_os("CARGO_BIN_EXE_omp") {
		let path = PathBuf::from(path);
		if path.is_file() {
			return Ok(path);
		}
	}
	let current = env::current_exe()?;
	if current.file_stem().is_some_and(|name| name == "omp") {
		return Ok(current);
	}
	let mut directory = current
		.parent()
		.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "current executable has no parent"))?;
	if directory.file_name().is_some_and(|name| name == "deps") {
		directory = directory.parent().ok_or_else(|| {
			io::Error::new(io::ErrorKind::NotFound, "target deps directory has no parent")
		})?;
	}
	let sibling = directory.join(format!("omp{}", env::consts::EXE_SUFFIX));
	if sibling.is_file() {
		return Ok(sibling);
	}
	Err(io::Error::new(
		io::ErrorKind::NotFound,
		format!(
			"real omp executable not found (set CARGO_BIN_EXE_omp or build {})",
			sibling.display()
		),
	))
}

fn status_event_key(event: &Value) -> Option<Str> {
	let object = event.as_object()?;
	let op = object.get("op")?.as_str()?;
	if let Some(key) = object.get("key").and_then(Value::as_str) {
		return Some(sf!("{op}:{key}"));
	}
	match op {
		"agent" => object
			.get("id")
			.and_then(Value::as_str)
			.map(|id| sf!("agent:{id}")),
		"phase" => Some(sf!("phase")),
		"log" => object
			.get("message")
			.and_then(Value::as_str)
			.map(|message| sf!("log:{message}")),
		_ => None,
	}
}

fn upsert_display_output(outputs: &mut Vec<DisplayOutput>, output: DisplayOutput) {
	let DisplayOutput::Status { event } = &output else {
		outputs.push(output);
		return;
	};
	let Some(key) = status_event_key(event) else {
		outputs.push(output);
		return;
	};
	if let Some(index) = outputs.iter().position(|existing| {
		matches!(existing, DisplayOutput::Status { event } if status_event_key(event).as_ref() == Some(&key))
	}) {
		outputs[index] = output;
	} else {
		outputs.push(output);
	}
}

fn normalize_display_output(output: DisplayOutput, blobs: Option<&BlobHost>) -> DisplayOutput {
	let DisplayOutput::ImageData { data, mime_type } = output else {
		return output;
	};
	let reject = |reason: &'static str| DisplayOutput::Status {
		event: serde_json::json!({ "op": "display", "error": reason }),
	};
	let Some(expected_kind) = (match mime_type.as_str() {
		"image/png" => Some(ImageKind::Png),
		"image/jpeg" => Some(ImageKind::Jpeg),
		_ => None,
	}) else {
		return reject("unsupported eval image media type");
	};
	let bytes = Bytes::copy_from_slice(data.as_ref());
	if !image::sniff_metadata(&bytes).is_some_and(|metadata| metadata.kind == expected_kind) {
		return reject("malformed eval image payload");
	}
	let processed = match image::process_image(bytes) {
		Ok(Some(processed)) => processed,
		Ok(None) => return reject("malformed eval image payload"),
		Err(_) => return reject("eval image payload exceeds the image limit"),
	};
	let Some(host) = blobs else {
		return reject("eval image storage is unavailable");
	};
	let id = match host.put(&processed.data) {
		Ok(id) => id,
		Err(_) => return reject("eval image persistence failed"),
	};
	DisplayOutput::Image {
		blob:        BlobRef {
			hash:       Str::from(hex::encode_n(&id.hash).as_str()),
			media_type: processed.media_type.clone(),
			byte_len:   id.size,
		},
		mime_type:   processed.media_type,
		description: processed.description,
	}
}

fn elapsed_ms(started: Instant) -> u64 {
	u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

const fn cancelled_completion(duration_ms: u64) -> RunCompletion {
	RunCompletion {
		status:          CellStatus {
			outcome: CellOutcome::Cancelled,
			exit_code: None,
			duration_ms,
			exception: Some(PythonException {
				name:      sf!("KeyboardInterrupt"),
				message:   sf!("OMP eval cell interrupted"),
				traceback: Vec::new(),
			}),
		},
		result:          None,
		display_outputs: Vec::new(),
		truncated:       false,
		spilled_output:  None,
		total_lines:     0,
		total_bytes:     0,
	}
}

const fn timeout_completion(duration_ms: u64) -> RunCompletion {
	RunCompletion {
		status:          CellStatus {
			outcome: CellOutcome::Timeout,
			exit_code: Some(1),
			duration_ms,
			exception: Some(PythonException {
				name:      sf!("TimeoutError"),
				message:   sf!("OMP eval cell timed out"),
				traceback: Vec::new(),
			}),
		},
		result:          None,
		display_outputs: Vec::new(),
		truncated:       false,
		spilled_output:  None,
		total_lines:     0,
		total_bytes:     0,
	}
}

fn resource_fault(operation: &'static str, error: ProcessError) -> Fault {
	Fault::Resource { operation: sf!(operation), message: Str::from(error.to_string()) }
}

fn session_lost(error: ProcessError) -> Fault {
	Fault::SessionLost { message: Str::from(error.to_string()) }
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn spawn_environment_is_allowlisted_and_rejects_secret_names() {
		assert!(spawn_env_allowed(OsStr::new("PATH")));
		assert!(spawn_env_allowed(OsStr::new("LC_ALL")));
		assert!(spawn_env_allowed(OsStr::new("OMP_EVAL_MODE")));
		assert!(!spawn_env_allowed(OsStr::new("AWS_SECRET_ACCESS_KEY")));
		assert!(!spawn_env_allowed(OsStr::new("OMP_EVAL_TOKEN")));
		assert!(!spawn_env_allowed(OsStr::new("RANDOM_AMBIENT_VALUE")));
	}
	#[test]
	fn project_virtualenv_interpreter_wins_over_path_fallback() {
		let scratch = tempfile::tempdir().expect("interpreter scratch");
		let interpreter = interpreter_below(
			&scratch.path().join(".venv"),
			if cfg!(windows) {
				"python.exe"
			} else {
				"python"
			},
		);
		fs::create_dir_all(interpreter.parent().expect("interpreter parent"))
			.expect("create virtualenv layout");
		fs::write(&interpreter, b"python").expect("create interpreter marker");
		assert_eq!(discover_external_python(scratch.path(), None), Some(interpreter));
	}

	#[tokio::test]
	async fn selected_interpreter_executes_the_external_protocol_runner() {
		use omp_tool::Registry;

		let cwd = env::current_dir().expect("current directory");
		let interpreter = discover_external_python(&cwd, None).expect("test host provides Python");
		let host = Arc::new(SessionBridgeHost::new());
		host
			.bind_registry(Arc::new(Registry::new()))
			.expect("bind empty bridge registry");
		let session = Bytes::from_static(b"external-runner");
		let mut child = EvalChild::spawn(
			Path::new("unused-for-external-python"),
			&interpreter,
			&session,
			&cwd,
			Arc::clone(&host),
			"1s".parse().expect("interrupt grace"),
			None,
		)
		.await
		.expect("launch selected interpreter");
		let (events, received) = flume::unbounded();
		let reset = AtomicBool::new(false);
		let disposition = child
			.run_cell(
				Bytes::from_static(b"external-runner:cell-1"),
				RunRequest {
					code:    sf!("import sys\nsys.executable"),
					timeout: None,
					reset:   false,
					runtime: runtime_snapshot(cwd),
				},
				CancellationToken::new(),
				&events,
				"owner",
				&session,
				host,
				&reset,
				None,
				true,
			)
			.await;
		assert!(matches!(disposition, RunCellDisposition::Keep));
		let completion = received
			.try_iter()
			.find_map(|event| match event.expect("successful run event") {
				RunEvent::Completed(completion) => Some(completion),
				_ => None,
			})
			.expect("terminal completion");
		let actual = completion
			.result
			.and_then(|value| value.json)
			.and_then(|value| value.as_str().map(PathBuf::from))
			.expect("sys.executable result");
		assert_eq!(
			actual
				.canonicalize()
				.expect("canonical executed interpreter"),
			interpreter
				.canonicalize()
				.expect("canonical selected interpreter"),
		);
		child.terminate().await;
	}
	struct OverlapParent {
		cwd:       PathBuf,
		barrier:   tokio::sync::Barrier,
		in_flight: AtomicU64,
		maximum:   AtomicU64,
	}

	#[async_trait]
	impl crate::eval::bridge::ParentSessionHost for OverlapParent {
		fn eval_session_config(
			&self,
		) -> Result<crate::eval::bridge::EvalSessionConfig, BridgeHostError> {
			Ok(crate::eval::bridge::EvalSessionConfig {
				cwd:              self.cwd.clone(),
				local_roots_json: None,
				artifacts_dir:    None,
				session_file:     None,
			})
		}

		async fn completion(
			&self,
			_args: Value,
			_progress: &dyn BridgeProgressSink,
		) -> Result<Value, BridgeHostError> {
			Err(BridgeHostError::message("completion is not used by this test"))
		}

		async fn agent(
			&self,
			_args: Value,
			_progress: &dyn BridgeProgressSink,
		) -> Result<Value, BridgeHostError> {
			let active = self.in_flight.fetch_add(1, Ordering::AcqRel) + 1;
			self.maximum.fetch_max(active, Ordering::AcqRel);
			self.barrier.wait().await;
			self.in_flight.fetch_sub(1, Ordering::AcqRel);
			Ok(serde_json::json!({"text":"done"}))
		}

		async fn concurrency(&self, _args: Value) -> Result<Value, BridgeHostError> {
			Ok(serde_json::json!({"limit":2}))
		}

		async fn budget(&self, _args: Value) -> Result<Value, BridgeHostError> {
			Err(BridgeHostError::message("budget is not used by this test"))
		}
	}

	#[tokio::test]
	async fn process_bridge_dispatches_calls_concurrently_and_serializes_responses() {
		use omp_tool::Registry;

		let cwd = env::current_dir().expect("current directory");
		let interpreter = discover_external_python(&cwd, None).expect("test host provides Python");
		let host = Arc::new(SessionBridgeHost::new());
		host
			.bind_registry(Arc::new(Registry::new()))
			.expect("bind empty bridge registry");
		let parent = Arc::new(OverlapParent {
			cwd:       cwd.clone(),
			barrier:   tokio::sync::Barrier::new(2),
			in_flight: AtomicU64::new(0),
			maximum:   AtomicU64::new(0),
		});
		let _binding = host
			.bind_sdk_parent(sf!("session"), parent.clone())
			.expect("bind parent");
		let owner = r#"["session","agent"]"#;
		let session = Bytes::from_static(b"parallel-external-runner");
		host
			.freeze_runtime(owner, &session)
			.expect("freeze runtime");
		let mut child = EvalChild::spawn(
			Path::new("unused-for-external-python"),
			&interpreter,
			&session,
			&cwd,
			Arc::clone(&host),
			"1s".parse().expect("interrupt grace"),
			None,
		)
		.await
		.expect("launch selected interpreter");
		let (events, received) = flume::unbounded();
		let reset = AtomicBool::new(false);
		let disposition = child
			.run_cell(
				Bytes::from_static(b"parallel-external-runner:cell-1"),
				RunRequest {
					code:    sf!("parallel([lambda: agent('first'), lambda: agent('second')])"),
					timeout: Some(Duration::from_secs(3)),
					reset:   false,
					runtime: runtime_snapshot(cwd),
				},
				CancellationToken::new(),
				&events,
				owner,
				&session,
				host,
				&reset,
				None,
				true,
			)
			.await;
		assert!(matches!(disposition, RunCellDisposition::Keep));
		assert_eq!(parent.maximum.load(Ordering::Acquire), 2);
		assert!(received.try_iter().any(|event| {
			matches!(
				event,
				Ok(RunEvent::Completed(RunCompletion {
					status: CellStatus { outcome: CellOutcome::Complete, .. },
					..
				}))
			)
		}));
		child.terminate().await;
	}

	fn runtime_snapshot(cwd: PathBuf) -> RuntimeSnapshot {
		RuntimeSnapshot {
			cwd:         Some(cwd),
			managed_env: MANAGED_ENV_KEYS
				.into_iter()
				.map(|key| (Str::new(key), None))
				.collect(),
		}
	}

	#[test]
	fn runtime_snapshot_validation_requires_scoped_cwd_and_exact_managed_keys() {
		let cwd = env::current_dir().expect("current directory");
		assert!(validate_runtime_snapshot(runtime_snapshot(cwd.clone())).is_ok());

		let mut missing = runtime_snapshot(cwd.clone());
		missing.managed_env.remove("OMP_SESSION_FILE");
		assert!(matches!(
			validate_runtime_snapshot(missing),
			Err(ProcessError::InvalidManagedEnvironment)
		));

		let mut unknown = runtime_snapshot(cwd);
		unknown
			.managed_env
			.insert(sf!("OMP_UNKNOWN"), Some(sf!("value")));
		assert!(matches!(
			validate_runtime_snapshot(unknown),
			Err(ProcessError::InvalidManagedEnvironment)
		));

		assert!(matches!(
			validate_runtime_snapshot(RuntimeSnapshot::default()),
			Err(ProcessError::MissingRuntimeCwd)
		));
	}

	#[cfg(unix)]
	fn process_exists(pid: u32) -> bool {
		let pid = i32::try_from(pid).expect("test PID fits pid_t");
		// SAFETY: signal zero performs existence/permission checking only.
		unsafe { libc::kill(pid, 0) == 0 }
	}

	#[cfg(unix)]
	#[test]
	#[ignore = "subprocess helper launched by \
	            parent_death_watchdog_terminates_kernel_and_descendants"]
	fn parent_watchdog_subprocess_helper() {
		let parent_pid = env::var("OMP_EVAL_TEST_PARENT_PID")
			.expect("helper parent PID")
			.parse::<u32>()
			.expect("numeric helper parent PID");
		let state = PathBuf::from(env::var_os("OMP_EVAL_TEST_STATE").expect("helper state"));
		// SAFETY: the helper has no descendants yet and moves itself into a new
		// process group whose id is its own pid.
		assert_eq!(unsafe { libc::setpgid(0, 0) }, 0);
		let descendant = process::Command::new("/bin/sleep")
			.arg("60")
			.spawn()
			.expect("spawn descendant");
		fs::write(state, format!("{}\n{}\n", process::id(), descendant.id()))
			.expect("publish helper identities");
		start_parent_watchdog(parent_pid).expect("start parent watchdog");
		loop {
			thread::sleep(Duration::from_secs(60));
		}
	}

	#[cfg(unix)]
	#[test]
	#[ignore = "subprocess helper launched by \
	            parent_death_watchdog_terminates_kernel_and_descendants"]
	fn parent_watchdog_intermediate_helper() {
		let state = PathBuf::from(env::var_os("OMP_EVAL_TEST_STATE").expect("helper state"));
		let executable = env::current_exe().expect("test executable");
		let mut helper = process::Command::new(executable)
			.args(["--ignored", "parent_watchdog_subprocess_helper"])
			.env("OMP_EVAL_TEST_PARENT_PID", process::id().to_string())
			.env("OMP_EVAL_TEST_STATE", &state)
			.spawn()
			.expect("spawn watchdog helper");
		let deadline = Instant::now() + Duration::from_secs(5);
		while !state.is_file() && Instant::now() < deadline {
			thread::sleep(Duration::from_millis(10));
		}
		if !state.is_file() {
			let _ = helper.kill();
			panic!("watchdog helper did not publish readiness");
		}
		drop(helper);
	}

	#[cfg(unix)]
	#[test]
	fn parent_death_watchdog_terminates_kernel_and_descendants() {
		let scratch = tempfile::tempdir().expect("watchdog scratch");
		let state = scratch.path().join("identities");
		let status = process::Command::new(env::current_exe().expect("test executable"))
			.args(["--ignored", "parent_watchdog_intermediate_helper"])
			.env("OMP_EVAL_TEST_STATE", &state)
			.status()
			.expect("run intermediate parent");
		assert!(status.success(), "intermediate parent must publish a live child");
		let identities = fs::read_to_string(&state).expect("read helper identities");
		let mut identities = identities
			.lines()
			.map(|line| line.parse::<u32>().expect("numeric helper identity"));
		let kernel = identities.next().expect("kernel identity");
		let descendant = identities.next().expect("descendant identity");
		let deadline = Instant::now() + Duration::from_secs(5);
		while (process_exists(kernel) || process_exists(descendant)) && Instant::now() < deadline {
			thread::sleep(Duration::from_millis(10));
		}
		if process_exists(kernel) {
			// SAFETY: the PID was created by this test and is only cleaned up
			// after the watchdog contract failed.
			unsafe { libc::kill(i32::try_from(kernel).unwrap_or(i32::MAX), libc::SIGKILL) };
		}
		if process_exists(descendant) {
			unsafe { libc::kill(i32::try_from(descendant).unwrap_or(i32::MAX), libc::SIGKILL) };
		}
		assert!(!process_exists(kernel), "orphaned eval kernel survived its parent");
		assert!(!process_exists(descendant), "orphaned eval descendant survived its parent");
	}

	#[cfg(unix)]
	#[test]
	fn parent_identity_matches_the_actual_protocol_pipe_owner() {
		// SAFETY: getppid has no preconditions and does not access memory.
		let parent = unsafe { libc::getppid() };
		let parent = u32::try_from(parent).expect("parent PID is positive");
		validate_parent_identity(parent).expect("actual parent validates");
		assert!(matches!(
			validate_parent_identity(parent.saturating_add(1)),
			Err(ProcessError::InvalidParentIdentity)
		));
	}

	#[test]
	fn dead_kernel_cancellation_retries_only_without_caller_abort_and_only_once() {
		assert!(should_retry_dead_kernel_cancellation(CellOutcome::Cancelled, false, false, true,));
		for (outcome, caller_cancelled, kernel_alive, retry_available) in [
			(CellOutcome::Complete, false, false, true),
			(CellOutcome::Cancelled, true, false, true),
			(CellOutcome::Cancelled, false, true, true),
			(CellOutcome::Cancelled, false, false, false),
		] {
			assert!(!should_retry_dead_kernel_cancellation(
				outcome,
				caller_cancelled,
				kernel_alive,
				retry_available,
			));
		}
	}

	#[test]
	fn status_updates_replace_stable_phase_and_log_keys() {
		let mut outputs = Vec::new();
		for event in [
			serde_json::json!({"op":"phase","title":"first"}),
			serde_json::json!({"op":"phase","title":"second"}),
			serde_json::json!({"op":"log","message":"same","progress":1}),
			serde_json::json!({"op":"log","message":"same","progress":2}),
		] {
			upsert_display_output(&mut outputs, DisplayOutput::Status { event });
		}
		assert_eq!(outputs.len(), 2);
		assert!(matches!(
			&outputs[0],
			DisplayOutput::Status { event } if event["title"] == "second"
		));
		assert!(matches!(
			&outputs[1],
			DisplayOutput::Status { event } if event["progress"] == 2
		));
	}

	#[test]
	fn malformed_image_becomes_status_without_dropping_other_output() {
		let output = normalize_display_output(
			DisplayOutput::ImageData {
				data:      CowBytes::from(b"not a png".to_vec()),
				mime_type: sf!("image/png"),
			},
			None,
		);
		assert!(matches!(
			output,
			DisplayOutput::Status { event } if event["op"] == "display"
		));
	}

	#[tokio::test]
	async fn protocol_is_bounded_ndjson() {
		let (mut writer, reader) = {
			use tokio::io;
			io::duplex(256)
		};
		write_frame(&mut writer, &ParentFrame::Exit)
			.await
			.expect("frame writes");
		drop(writer);
		let mut reader = BufReader::new(reader);
		assert!(matches!(
			read_frame::<_, ParentFrame>(&mut reader)
				.await
				.expect("frame reads"),
			Some(ParentFrame::Exit)
		));
		assert!(
			read_frame::<_, ParentFrame>(&mut reader)
				.await
				.expect("EOF reads")
				.is_none()
		);
	}

	#[tokio::test]
	async fn protocol_rejects_empty_and_unterminated_frames() {
		for bytes in [b"\n".as_slice(), b"{\"kind\":\"exit\"}".as_slice()] {
			let mut reader = BufReader::new(bytes);
			assert!(read_frame::<_, ParentFrame>(&mut reader).await.is_err());
		}
	}
}
