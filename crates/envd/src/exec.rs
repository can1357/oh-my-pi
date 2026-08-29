//! Environment-daemon process and persistent shell-session host.

use std::{
	collections::{BTreeMap, BTreeSet, HashMap, HashSet},
	env,
	ffi::{OsStr, OsString},
	fs, future,
	io::{self, Read, Write as _},
	net,
	os::fd::{self, AsFd as _, AsRawFd as _},
	path::{Path, PathBuf},
	process::{self, Command, Stdio},
	sync::{
		Arc, Weak,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	thread,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use bytes::{Buf as _, Bytes, BytesMut};
use flume::Receiver;
use futures::future::try_join_all;
use nix::errno::Errno;
use omp_agent::{ApprovalRoute, ApprovalSpec, TicketState};
use omp_core::{Hash32, Str, sf};
use omp_proto::{
	env::{
		v1,
		v1::{
			AttachOutput, CloseSessionResponse, EnvironmentDelta, ExecBackendCapabilities,
			ExecCapabilitiesRequest, ExecControlKind, ExecControlRequest, ExecControlResult,
			ExecFinalCwd, ExecFinalCwdRequest, ExecOutcome, ExecRequest, ExecStarted, ExecStatusMsg,
			ExitEvent, GetProcess, OpenSessionRequest, OpenSessionResponse, OutputAttached,
			OutputChannel, OutputFrame, ProcessCommandAccepted, ProcessInfo, ProcessList,
			ProcessOutput, ProcessSpec, ProcessStarted, ProcessState, PtySpec, ReadyProbe,
			RestartPolicy, RestartProcess, StartProcess, ready_probe,
		},
	},
	inference::v1::{Value as WireValue, ValueMap as WireValueMap, value as wire_value},
	toolhost::v1::{HostFrame, Ping, WorkerFrame, host_frame, worker_frame},
};
use omp_shell_engine::{
	ExecutionParameters, ProcessScope, Shell, ShellValue, ShellVariable, SourceInfo, SpawnObserver,
	env::EnvironmentScope,
	openfiles::{OpenFile, OpenFiles},
	processes::{ProcessSignal, signal_process_group},
	variables::ShellValueUnsetType,
};
use omp_storage::github_cache::GithubCache;
use parking_lot::Mutex;
use prost::Message as _;
use regex::bytes::Regex;
use tokio::{net::TcpStream, runtime, task, time};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::{
	admission,
	admission::GithubMutationTarget,
	exec_sandbox::ExecSandbox,
	exec_settings::{ExecSandboxMode, SandboxSettings},
	process_identity::{IdentityError, ProcessIdentity},
	process_log,
	process_log::{LogChunk, ProcessLog},
	process_store::{
		DaemonLease, LeaseError, ProcessPhase, ProcessRecord, ProcessStore, ProcessStoreSnapshot,
		RestartRecord, StoreError,
	},
};

const CANCEL_GRACE: Duration = Duration::from_millis(250);
const OUTPUT_CHUNK_BYTES: usize = 16 * 1024;
const RESTART_HEALTHY_UPTIME: Duration = Duration::from_secs(30);
const RESTART_MAX_DELAY: Duration = Duration::from_secs(30);
const RESTART_BASE_DELAY: Duration = Duration::from_secs(1);
const RUN_ENVIRONMENT_PROP: &str = "omp/run-environment";
const SANDBOX_DENIED_PATH_PROP: &str = "omp/sandbox-denied-path";
const SANDBOX_DIAGNOSTIC_BYTES: usize = 16 * 1024;
const WRITE_DENIED_DIAGNOSTIC: &[u8] = b"sandbox denied write to ";

/// Content identity of the process environment inherited by new shell sessions.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct WorkspaceEnvironmentDigest(Hash32);

impl WorkspaceEnvironmentDigest {
	/// Returns the SHA-256 digest over sorted environment name/value pairs.
	pub const fn as_bytes(&self) -> &[u8; 32] {
		self.0.as_bytes()
	}
}

/// Errors returned by the environment execution host.
#[derive(Debug, thiserror::Error)]
pub enum ExecError {
	/// The requested session does not exist.
	#[error("exec session was not found")]
	SessionNotFound,
	/// The requested execution does not exist or has already finished.
	#[error("execution was not found")]
	RunNotFound,
	/// Final working-directory metadata is not retained for this execution.
	#[error("execution final working directory was not found")]
	FinalCwdNotFound,
	/// Final working-directory metadata did not match the caller's fence.
	#[error("execution final working-directory revision is stale")]
	StaleFinalCwdRevision,
	/// An exec-session request used an incompatible schema revision.
	#[error("exec-session wire revision does not match the Environment schema")]
	WireRevision,
	/// A requested shell profile is not advertised by this backend.
	#[error("shell profile {profile:?} is not supported by this backend")]
	UnsupportedShellProfile {
		/// Requested profile name.
		profile: Str,
	},
	/// The control operation was outside the declared vocabulary.
	#[error("exec control kind is invalid")]
	InvalidControl,
	/// A command-local environment delta used an invalid wire value.
	#[error("command-local environment delta is invalid")]
	InvalidRunEnvironment,
	/// The requested named process does not exist.
	#[error("named process {0:?} was not found")]
	ProcessNotFound(Str),
	/// A process with this name is already registered.
	#[error("named process {0:?} already exists")]
	ProcessExists(Str),
	/// A named-process request targeted a retired generation.
	#[error(
		"named process {name:?} generation {requested} is stale; current generation is {current}"
	)]
	StaleProcessGeneration {
		/// Stable process name.
		name:      Str,
		/// Generation carried by the request.
		requested: u64,
		/// Current retained generation.
		current:   u64,
	},
	/// A request contained an unsupported signal name.
	#[error("unsupported signal {0:?}")]
	UnsupportedSignal(Str),
	/// A URI could not be used as a local working directory.
	#[error("invalid working-directory URI {0:?}")]
	InvalidCwd(Str),
	/// The shell engine rejected the requested operation.
	#[error("shell execution failed: {0}")]
	Shell(Str),
	/// A named-process readiness probe was invalid or did not pass.
	#[error("process readiness failed: {0}")]
	Readiness(Str),
	/// An operating-system process primitive failed.
	#[error("process I/O failed: {0}")]
	Io(#[from] io::Error),
	/// The target actor has stopped.
	#[error("exec session has closed")]
	SessionClosed,
	/// A named process used an invalid durable name.
	#[error("process name must be 1-48 ASCII letters, digits, dot, underscore, or hyphen")]
	InvalidProcessName,
	/// Detached processes cannot retain a pseudo-terminal.
	#[error("detached processes cannot use a PTY")]
	DetachedPty,
	/// Durable process metadata could not be committed.
	#[error(transparent)]
	ProcessStore(#[from] StoreError),
	/// A durable operating-system identity could not be captured.
	#[error(transparent)]
	ProcessIdentity(#[from] IdentityError),
	/// Another daemon already owns the durable process namespace.
	#[error(transparent)]
	ProcessLease(#[from] LeaseError),
	/// The configured command sandbox could not be compiled.
	#[error("failed to enable sandbox mode {mode}")]
	Sandbox {
		/// Requested user-facing posture.
		mode:   &'static str,
		/// Typed sandbox compiler failure.
		#[source]
		source: omp_sandbox::SandboxError,
	},
}

/// One ordered event emitted by an execution.
#[derive(Clone, Debug)]
pub enum ExecEvent {
	/// The session dequeued this command and entered execution.
	Started {
		/// Opaque execution identifier assigned when the command was queued.
		exec_id: Bytes,
	},
	/// Bytes written by stdout, stderr, or the PTY.
	Output(OutputFrame),
	/// The terminal execution status. No output follows it.
	Exit(ExitEvent),
}

pub(crate) fn sandbox_denied_event_path(event: &ExecEvent) -> Option<Str> {
	let ExecEvent::Exit(event) = event else {
		return None;
	};
	let status = event.status.as_ref()?;
	if status.outcome != ExecOutcome::Denied as i32 {
		return None;
	}
	let path = status
		.props
		.as_ref()?
		.fields
		.get(SANDBOX_DENIED_PATH_PROP)?
		.kind
		.as_ref()
		.and_then(|kind| match kind {
			wire_value::Kind::String(path) => Some(path.as_str()),
			_ => None,
		})?;
	Some(Str::from(path))
}

/// One event emitted by an attached named process.
#[derive(Clone, Debug)]
pub enum ProcessEvent {
	/// Ordered process output.
	Output(ProcessOutput),
	/// A state transition for the process.
	State(ProcessInfo),
}

/// RAII ownership of one command invocation.
///
/// Dropping this value requests TERM-then-KILL teardown of only this command's
/// process groups unless [`ExecHost::detach_exec`] retained the exact run as a
/// named process. The shell session is owned by [`ExecHost`] and survives.
#[must_use]
pub struct ExecRun {
	id:      Bytes,
	events:  Arc<Receiver<ExecEvent>>,
	control: Arc<RunControl>,
}

impl ExecRun {
	/// Returns the opaque wire execution identifier.
	pub fn id(&self) -> &[u8] {
		&self.id
	}

	/// Waits for the next output or terminal event.
	pub async fn next_event(&self) -> Option<ExecEvent> {
		self.events.recv_async().await.ok()
	}

	/// Requests cancellation without dropping the event stream.
	pub fn cancel(&self) {
		self.control.cancel(CANCEL_GRACE);
	}
}

impl Drop for ExecRun {
	fn drop(&mut self) {
		if self
			.control
			.retained
			.lock()
			.as_ref()
			.and_then(Weak::upgrade)
			.is_none()
		{
			self.cancel();
		}
	}
}

/// Snapshot plus future events returned by named-process attachment.
pub struct ProcessAttachment {
	/// Attachment acknowledgement.
	pub attached: OutputAttached,
	/// Buffered output strictly newer than the requested sequence.
	pub backlog:  Vec<ProcessOutput>,
	/// Process state captured atomically with the backlog and subscription.
	pub state:    ProcessInfo,
	/// Future output and state transitions.
	pub events:   Receiver<ProcessEvent>,
}

/// Host for persistent shell sessions and named processes.
#[derive(Clone)]
pub struct ExecHost {
	inner: Arc<HostInner>,
}

struct HostInner {
	next_id:                AtomicU64,
	next_revision:          AtomicU64,
	sessions:               Mutex<HashMap<Bytes, SessionHandle>>,
	runs:                   Mutex<HashMap<Bytes, Weak<RunControl>>>,
	final_cwds:             Mutex<HashMap<Bytes, ExecFinalCwd>>,
	processes:              Mutex<HashMap<Str, Arc<NamedProcess>>>,
	starting:               Mutex<HashSet<Str>>,
	environment:            Mutex<WorkspaceEnvironment>,
	github_cache:           Mutex<Option<Arc<GithubCache>>>,
	devices:                Mutex<Option<Arc<crate::devices_host::DynHost>>>,
	persistence:            Mutex<Option<ProcessPersistence>>,
	next_order:             AtomicU64,
	sandbox:                Mutex<Option<SandboxConfig>>,
	sandbox_approval_route: Mutex<Option<ApprovalRoute>>,
}

struct SandboxConfig {
	settings:       SandboxSettings,
	workspace_root: PathBuf,
	supervised:     Option<Arc<ExecSandbox>>,
	detached:       Option<Arc<ExecSandbox>>,
}

struct ProcessPersistence {
	store:    ProcessStore,
	snapshot: ProcessStoreSnapshot,
	_lease:   DaemonLease,
}

#[derive(Clone)]
struct SessionHandle {
	tx:             flume::Sender<SessionCommand>,
	pty:            Option<PtySpec>,
	command_prefix: Str,
	user_shell:     Option<UserShell>,
	sandbox:        Option<Arc<ExecSandbox>>,
	process_scope:  Arc<SpawnBook>,
}
#[derive(Clone)]
struct UserShell {
	executable: Str,
	args:       Arc<[Str]>,
	login:      bool,
}

struct NamedProcess {
	host:            Weak<HostInner>,
	name:            Str,
	generation:      u64,
	control:         Arc<RunControl>,
	stream:          Mutex<ProcessStreamState>,
	log:             Mutex<ProcessLog>,
	spec:            ProcessSpec,
	ready:           Arc<[ReadyProbe]>,
	identity:        ProcessIdentity,
	started_at:      Instant,
	detached:        bool,
	persist:         bool,
	stopping:        AtomicBool,
	timed_out:       AtomicBool,
	timeout:         Option<Duration>,
	deadline_cancel: CancellationToken,
	private_session: Mutex<Option<Bytes>>,
	restarts:        Mutex<RestartSupervisor>,
}

/// Result of applying graceful shutdown to managed process trees.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ShutdownSummary {
	/// Processes sent through graceful cancellation.
	pub stopped: u32,
	/// Verified detached persistent processes spared.
	pub spared:  u32,
}

struct ProcessStreamState {
	info:        ProcessInfo,
	history:     Vec<ProcessOutput>,
	subscribers: Vec<flume::Sender<ProcessEvent>>,
}

#[must_use]
struct ProcessReservation {
	host: Weak<HostInner>,
	name: Str,
}

/// Generation-fenced restart accounting for one named process.
#[derive(Debug)]
pub struct RestartSupervisor {
	policy:               RestartPolicy,
	configured_delay:     Duration,
	max_restarts:         Option<u32>,
	restart_count:        u32,
	consecutive_failures: u32,
	history:              Vec<RestartRecord>,
}

impl RestartSupervisor {
	fn from_spec(spec: Option<&v1::RestartSpec>) -> Self {
		let policy = spec
			.and_then(|spec| RestartPolicy::try_from(spec.policy).ok())
			.unwrap_or(RestartPolicy::Never);
		Self {
			policy,
			configured_delay: spec.map_or(RESTART_BASE_DELAY, |spec| {
				Duration::from_millis(spec.delay_ms).max(RESTART_BASE_DELAY)
			}),
			max_restarts: spec.and_then(|spec| spec.max_restarts),
			restart_count: 0,
			consecutive_failures: 0,
			history: Vec::new(),
		}
	}

	fn recovered(record: &ProcessRecord, spec: Option<&v1::RestartSpec>) -> Self {
		let mut supervisor = Self::from_spec(spec);
		supervisor.restart_count = record.restart_count;
		supervisor.consecutive_failures = record.consecutive_failures;
		supervisor.history.clone_from(&record.restart_history);
		supervisor
	}

	fn decide(
		&mut self,
		failed: bool,
		uptime: Duration,
		exit_code: Option<i32>,
	) -> Option<Duration> {
		let enabled = matches!(self.policy, RestartPolicy::Always)
			|| matches!(self.policy, RestartPolicy::OnFailure) && failed;
		if !enabled
			|| self
				.max_restarts
				.is_some_and(|max| self.restart_count >= max)
		{
			return None;
		}
		if uptime >= RESTART_HEALTHY_UPTIME {
			self.consecutive_failures = 0;
		} else {
			self.consecutive_failures = self.consecutive_failures.saturating_add(1);
		}
		self.restart_count = self.restart_count.saturating_add(1);
		let exponent = self.consecutive_failures.min(5);
		let delay = self
			.configured_delay
			.saturating_mul(1_u32 << exponent)
			.min(RESTART_MAX_DELAY);
		self.history.push(RestartRecord {
			at_ms: unix_time_ms(),
			exit_code,
			delay_ms: delay.as_millis().try_into().unwrap_or(u64::MAX),
			failure_count: self.consecutive_failures,
		});
		if self.history.len() > 32 {
			self.history.remove(0);
		}
		Some(delay)
	}
}

struct RunControl {
	cancel_tx: flume::Sender<CancelRequest>,
	input:     Mutex<Option<InputSink>>,
	spawns:    Arc<SpawnBook>,
	finished:  AtomicBool,
	retained:  Mutex<Option<Weak<NamedProcess>>>,
	events:    Weak<Receiver<ExecEvent>>,
}

struct CancelRequest {
	grace: Duration,
}
struct WorkspaceEnvironment {
	variables: Arc<[(Str, Str)]>,
	digest:    WorkspaceEnvironmentDigest,
}

enum InputSink {
	Pipe(io::PipeWriter),
	Pty(fs::File),
}

struct SpawnBook {
	groups:  Mutex<Vec<i32>>,
	pids:    Mutex<Vec<i32>>,
	session: Option<Arc<SpawnBook>>,
}

struct SessionCommand {
	host:           Weak<HostInner>,
	exec:           Bytes,
	source:         Str,
	environment:    Option<EnvironmentDelta>,
	timeout:        Option<Duration>,
	pty:            Option<PtySpec>,
	control:        Arc<RunControl>,
	cancel_rx:      Receiver<CancelRequest>,
	events:         flume::Sender<ExecEvent>,
	github_targets: Vec<GithubMutationTarget>,
	sandbox:        Option<Arc<ExecSandbox>>,
	bypass_sandbox: bool,
}

impl Default for ExecHost {
	fn default() -> Self {
		Self::new()
	}
}

impl ExecHost {
	/// Creates an empty execution host. Sessions are opened lazily by callers.
	pub fn new() -> Self {
		Self {
			inner: Arc::new(HostInner {
				next_id:                AtomicU64::new(1),
				next_revision:          AtomicU64::new(1),
				sessions:               Mutex::new(HashMap::new()),
				runs:                   Mutex::new(HashMap::new()),
				final_cwds:             Mutex::new(HashMap::new()),
				processes:              Mutex::new(HashMap::new()),
				starting:               Mutex::new(HashSet::new()),
				environment:            Mutex::new(read_workspace_environment()),
				github_cache:           Mutex::new(None),
				devices:                Mutex::new(None),
				persistence:            Mutex::new(None),
				next_order:             AtomicU64::new(1),
				sandbox:                Mutex::new(None),
				sandbox_approval_route: Mutex::new(None),
			}),
		}
	}

	/// Configures sandbox policy for subsequently opened sessions and detached
	/// processes.
	pub(crate) fn configure_sandbox(&self, settings: &SandboxSettings, workspace_root: &Path) {
		let config = (settings.mode != ExecSandboxMode::Off
			|| !settings.environment_policy_is_default())
		.then(|| SandboxConfig {
			settings:       settings.clone(),
			workspace_root: workspace_root.to_path_buf(),
			supervised:     None,
			detached:       None,
		});
		*self.inner.sandbox.lock() = config;
	}

	pub(crate) fn active_sandbox(&self) -> Result<Option<Arc<ExecSandbox>>, ExecError> {
		self.compiled_sandbox(true)
	}

	fn detached_sandbox(&self) -> Result<Option<Arc<ExecSandbox>>, ExecError> {
		self.compiled_sandbox(false)
	}

	fn compiled_sandbox(&self, supervised: bool) -> Result<Option<Arc<ExecSandbox>>, ExecError> {
		let mut config = self.inner.sandbox.lock();
		let Some(config) = config.as_mut() else {
			return Ok(None);
		};
		if let Some(sandbox) = if supervised {
			config.supervised.as_ref()
		} else {
			config.detached.as_ref()
		} {
			return Ok(Some(Arc::clone(sandbox)));
		}
		let sandbox = ExecSandbox::compile(&config.settings, &config.workspace_root, supervised)
			.map_err(|source| ExecError::Sandbox { mode: config.settings.mode.into(), source })?;
		if supervised {
			config.supervised = sandbox.clone();
		} else {
			config.detached = sandbox.clone();
		}
		Ok(sandbox)
	}

	/// Binds the interactive approval route used for one-shot sandbox bypasses.
	pub(crate) fn bind_sandbox_approval_route(&self, route: Option<ApprovalRoute>) {
		*self.inner.sandbox_approval_route.lock() = route;
	}

	/// Requests approval to rerun one exact command without its sandbox hooks.
	pub(crate) async fn approve_sandbox_bypass(&self, command: &str, denied_path: &str) -> bool {
		let Some(route) = self.inner.sandbox_approval_route.lock().clone() else {
			return false;
		};
		let ticket = route
			.request(
				None,
				vec![ApprovalSpec {
					title:         sf!("Rerun command without sandbox"),
					body:          sf!(
						"The sandbox denied access to {denied_path}. Approve one unsandboxed rerun of \
						 this exact command?\n\n{command}"
					),
					subject:       Str::from(denied_path),
					kind:          sf!("sandbox_bypass"),
					scopes:        vec![sf!("once")],
					default:       Some(false),
					route:         sf!("local"),
					approver:      None,
					timeout_ms:    120_000,
					unreachable:   sf!("fail_closed"),
					require_human: true,
					pattern:       Some(Str::from(command)),
					evidence:      vec![sf!("sandbox denial")],
				}],
				unix_time_ms(),
			)
			.await;
		ticket.state == TicketState::Decided
			&& ticket
				.decision
				.as_ref()
				.is_some_and(|decision| decision.approved && decision.scope == "once")
			&& ticket
				.reasons
				.iter()
				.any(|reason| reason.kind == "sandbox_bypass" && reason.subject == denied_path)
	}

	/// Enables durable named-process metadata and recovers verified detached
	/// generations before accepting new launches.
	///
	/// Exactly one live composition owns durable process metadata per state
	/// directory. When another environment daemon already holds the lease,
	/// this host keeps running with in-memory process state only; recovery
	/// and persistence stay with the lease owner.
	pub fn with_process_store(self, store: ProcessStore) -> Result<Self, ExecError> {
		let daemon = ProcessIdentity::current()?;
		let mut snapshot = store
			.load()?
			.unwrap_or_else(|| ProcessStoreSnapshot::new(daemon.clone()));
		snapshot.daemon = daemon;
		let records = snapshot.processes.clone();
		fs::create_dir_all(store.process_root())?;
		let next_order = records
			.iter()
			.flat_map(|record| [record.started_order, record.recent_order])
			.max()
			.unwrap_or(0)
			.saturating_add(1);
		self.inner.next_order.store(next_order, Ordering::Relaxed);
		let lease = match DaemonLease::acquire(&store.process_root().join("envd.lease")) {
			Ok(lease) => lease,
			Err(LeaseError::AlreadyOwned) => {
				tracing::debug!(
					root = %store.process_root().display(),
					"durable process metadata is owned by another environment daemon; \
					 running with in-memory process state"
				);
				return Ok(self);
			},
			Err(error) => return Err(error.into()),
		};
		store.save(&snapshot)?;
		*self.inner.persistence.lock() = Some(ProcessPersistence { store, snapshot, _lease: lease });
		self.recover_records(records)?;
		Ok(self)
	}

	/// Injects the production GitHub resource cache owned by the Environment.
	pub fn with_github_cache(self, cache: Arc<GithubCache>) -> Self {
		*self.inner.github_cache.lock() = Some(cache);
		self
	}

	/// Installs the live dynamic-device bridge used by subsequently opened
	/// sessions.
	pub fn install_devices(&self, host: Arc<crate::devices_host::DynHost>) {
		*self.inner.devices.lock() = Some(host);
	}

	/// Opens a persistent shell carrying its own cwd and environment state.
	pub async fn open_session(
		&self,
		request: OpenSessionRequest,
	) -> Result<OpenSessionResponse, ExecError> {
		let profile = request.shell_profile.as_ref();
		if let Some(profile) = profile {
			let requested = profile.profile.trim();
			let supported = matches!(requested, "" | "brush" | "user" | "bash" | "zsh" | "fish");
			let external = !matches!(requested, "" | "brush");
			if profile.wire_revision != omp_proto::SCHEMA_REV
				|| !supported
				|| external && profile.executable.trim().is_empty()
			{
				return Err(ExecError::UnsupportedShellProfile {
					profile: Str::from(if requested.is_empty() {
						"brush"
					} else {
						requested
					}),
				});
			}
		}
		let cwd = cwd_from_uri(&request.cwd_uri)?.map_or_else(env::current_dir, Ok)?;
		let sandbox = self.active_sandbox()?;
		let variables = Arc::clone(&self.inner.environment.lock().variables);
		let mut builder = Shell::builder()
			.profile(omp_shell_engine::ProfileLoadBehavior::Skip)
			.rc(omp_shell_engine::RcLoadBehavior::Skip)
			.working_dir(cwd)
			.do_not_inherit_env(true)
			.builtins(omp_shell_engine::builtins::default_builtins());
		if let Some(host) = self.inner.devices.lock().clone() {
			builder = builder.builtin("dyn", crate::devices_host::registration(host));
		}
		for (name, value) in variables.iter() {
			let mut variable = ShellVariable::new(value.to_string());
			variable.export();
			builder = builder.var(name.to_string(), variable);
		}
		let mut shell = builder.build().await.map_err(shell_error)?;
		if let Some(pty) = request.pty.as_ref()
			&& !pty.terminal.is_empty()
		{
			let mut terminal = ShellVariable::new(pty.terminal.clone());
			terminal.export();
			shell
				.set_env_global("TERM", terminal)
				.map_err(shell_error)?;
		}
		if let Some(profile) = profile {
			apply_env_delta(&mut shell, profile.env_delta.as_ref()).map_err(shell_error)?;
		}
		apply_env_delta(&mut shell, request.env_delta.as_ref()).map_err(shell_error)?;

		let command_prefix =
			profile.map_or_else(Str::default, |profile| Str::from(profile.command_prefix.trim()));
		let user_shell = profile.and_then(|profile| {
			(!matches!(profile.profile.trim(), "" | "brush")).then(|| UserShell {
				executable: Str::from(profile.executable.trim()),
				args:       profile
					.args
					.iter()
					.map(|arg| Str::from(arg.as_str()))
					.collect(),
				login:      profile.login,
			})
		});
		let session = self.new_id();
		let lease = self.new_id();
		let (tx, rx) = flume::unbounded();
		let process_scope = Arc::new(SpawnBook {
			groups:  Mutex::new(Vec::new()),
			pids:    Mutex::new(Vec::new()),
			session: None,
		});
		let sessions = Arc::downgrade(&self.inner);
		let session_for_task = session.clone();
		tokio::spawn(async move {
			session_loop(shell, rx).await;
			if let Some(host) = sessions.upgrade() {
				host.sessions.lock().remove(&session_for_task);
			}
		});
		self
			.inner
			.sessions
			.lock()
			.insert(session.clone(), SessionHandle {
				tx,
				pty: request.pty.clone(),
				command_prefix,
				user_shell,
				sandbox,
				process_scope,
			});

		Ok(OpenSessionResponse {
			session,
			lease,
			cwd_uri: request.cwd_uri,
			capabilities: Some(Self::backend_capabilities()),
			props: Default::default(),
		})
	}

	/// Returns the digest of the cached environment inherited by new sessions.
	pub fn workspace_environment_digest(&self) -> WorkspaceEnvironmentDigest {
		self.inner.environment.lock().digest
	}

	/// Explicitly refreshes the environment inherited by subsequently opened
	/// sessions.
	///
	/// Existing sessions retain their own shell state.
	pub fn refresh_workspace_environment(&self) -> WorkspaceEnvironmentDigest {
		let environment = read_workspace_environment();
		let digest = environment.digest;
		*self.inner.environment.lock() = environment;
		digest
	}

	/// Closes a session and all shell-owned background jobs.
	pub fn close_session(&self, session: &[u8]) -> Result<CloseSessionResponse, ExecError> {
		let Some(handle) = self.inner.sessions.lock().remove(session) else {
			return Err(ExecError::SessionNotFound);
		};
		drop(handle);
		Ok(CloseSessionResponse {
			session: Bytes::copy_from_slice(session),
			props:   Default::default(),
		})
	}

	/// Returns whether a persistent session is owned by this Environment.
	pub fn contains_session(&self, session: &[u8]) -> bool {
		self.inner.sessions.lock().contains_key(session)
	}

	/// Returns revisioned capabilities for a live session.
	pub fn capabilities(
		&self,
		request: &ExecCapabilitiesRequest,
	) -> Result<ExecBackendCapabilities, ExecError> {
		if request.wire_revision != omp_proto::SCHEMA_REV {
			return Err(ExecError::WireRevision);
		}
		if !self.contains_session(&request.session) {
			return Err(ExecError::SessionNotFound);
		}
		Ok(Self::backend_capabilities())
	}

	/// Applies one typed control operation to a live execution.
	pub fn control(&self, request: &ExecControlRequest) -> Result<ExecControlResult, ExecError> {
		if request.wire_revision != omp_proto::SCHEMA_REV {
			return Err(ExecError::WireRevision);
		}
		let control = self.run(&request.exec)?;
		if control.finished.load(Ordering::Acquire) {
			return Ok(ExecControlResult { exec: request.exec.clone(), accepted: false });
		}
		match ExecControlKind::try_from(request.control).map_err(|_| ExecError::InvalidControl)? {
			ExecControlKind::Interrupt => control.spawns.signal(ProcessSignal::Interrupt)?,
			ExecControlKind::Terminate => {
				control.cancel(Duration::from_millis(request.grace_ms).min(Duration::from_secs(30)));
			},
			ExecControlKind::Kill => control.spawns.signal(ProcessSignal::Kill)?,
			ExecControlKind::Unspecified => return Err(ExecError::InvalidControl),
		}
		Ok(ExecControlResult { exec: request.exec.clone(), accepted: true })
	}

	/// Reads final working-directory metadata through an exact revision fence.
	pub fn final_cwd(&self, request: &ExecFinalCwdRequest) -> Result<ExecFinalCwd, ExecError> {
		if request.wire_revision != omp_proto::SCHEMA_REV {
			return Err(ExecError::WireRevision);
		}
		let final_cwd = self
			.inner
			.final_cwds
			.lock()
			.get(&request.exec)
			.cloned()
			.ok_or(ExecError::FinalCwdNotFound)?;
		if request.expected_revision != 0 && request.expected_revision != final_cwd.revision {
			return Err(ExecError::StaleFinalCwdRevision);
		}
		Ok(final_cwd)
	}

	fn backend_capabilities() -> ExecBackendCapabilities {
		ExecBackendCapabilities {
			persistent_sessions: true,
			pty:                 true,
			signals:             true,
			resize:              true,
			final_cwd:           true,
			materialization:     true,
			shell_profiles:      ["brush", "user", "bash", "zsh", "fish"]
				.into_iter()
				.map(String::from)
				.collect(),
			wire_revision:       omp_proto::SCHEMA_REV,
		}
	}

	/// Starts a script in a session. A session serializes its scripts.
	pub async fn exec(
		&self,
		request: ExecRequest,
		timeout: Option<Duration>,
	) -> Result<(ExecStarted, ExecRun), ExecError> {
		self.exec_controlled(request, timeout, false).await
	}

	/// Starts one script while bypassing sandbox hooks for only this command.
	pub(crate) async fn exec_without_sandbox(
		&self,
		request: ExecRequest,
		timeout: Option<Duration>,
	) -> Result<(ExecStarted, ExecRun), ExecError> {
		self.exec_controlled(request, timeout, true).await
	}

	async fn exec_controlled(
		&self,
		mut request: ExecRequest,
		timeout: Option<Duration>,
		bypass_sandbox: bool,
	) -> Result<(ExecStarted, ExecRun), ExecError> {
		let session = self
			.inner
			.sessions
			.lock()
			.get(&request.session)
			.cloned()
			.ok_or(ExecError::SessionNotFound)?;
		let source = request
			.source
			.take()
			.ok_or_else(|| ExecError::Shell(sf!("missing script")))?;
		let environment = take_run_environment(&mut request)?;
		let github_targets = admission::bash_ir(
			"bash",
			&serde_json::json!({ "command": source.text.as_str() }),
			Path::new("/"),
			Path::new("/"),
		)
		.map_or_else(Vec::new, |bash| admission::github_mutation_targets(&bash));
		let persistent_cd = simple_cd(&source.text);
		let source = if session.command_prefix.is_empty() {
			Str::from(source.text)
		} else {
			sf!("{} {}", session.command_prefix, source.text)
		};
		let source = session
			.user_shell
			.as_ref()
			.filter(|_| !persistent_cd)
			.map_or(source.clone(), |shell| user_shell_command(shell, &source));
		let exec = self.new_id();
		let (events_tx, events) = flume::unbounded();
		let events = Arc::new(events);
		let (cancel_tx, cancel_rx) = flume::bounded(1);
		let control = Arc::new(RunControl {
			cancel_tx,
			input: Mutex::new(None),
			spawns: Arc::new(SpawnBook {
				groups:  Mutex::new(Vec::new()),
				pids:    Mutex::new(Vec::new()),
				session: Some(session.process_scope.clone()),
			}),
			finished: AtomicBool::new(false),
			retained: Mutex::new(None),
			events: Arc::downgrade(&events),
		});
		let command = SessionCommand {
			host: Arc::downgrade(&self.inner),
			exec: exec.clone(),
			source,
			environment,
			timeout,
			pty: session.pty,
			control: control.clone(),
			cancel_rx,
			events: events_tx,
			github_targets,
			sandbox: session.sandbox,
			bypass_sandbox,
		};
		session
			.tx
			.send(command)
			.map_err(|_| ExecError::SessionClosed)?;
		self
			.inner
			.runs
			.lock()
			.insert(exec.clone(), Arc::downgrade(&control));
		Ok((
			ExecStarted {
				session: request.session,
				exec:    exec.clone(),
				props:   Default::default(),
			},
			ExecRun { id: exec, events, control },
		))
	}

	/// Writes input or closes stdin for a running command.
	pub fn stdin(&self, exec: &[u8], data: Option<&[u8]>) -> Result<(), ExecError> {
		let control = self.run(exec)?;
		write_input(&control, data)
	}

	/// Sends a named signal to all process groups owned by a command.
	pub fn signal(&self, exec: &[u8], signal: &str) -> Result<(), ExecError> {
		let control = self.run(exec)?;
		if control.finished.load(Ordering::Acquire) {
			return Err(ExecError::RunNotFound);
		}
		control.spawns.signal(parse_signal(signal)?)?;
		Ok(())
	}

	/// Changes the terminal window size for a PTY-backed command.
	pub fn resize(&self, exec: &[u8], rows: u32, columns: u32) -> Result<(), ExecError> {
		let control = self.run(exec)?;
		let input = control.input.lock();
		let Some(InputSink::Pty(master)) = input.as_ref() else {
			return Err(ExecError::Io(io::Error::new(
				io::ErrorKind::Unsupported,
				"execution has no PTY",
			)));
		};
		resize_fd(master.as_fd(), rows, columns)?;
		control.spawns.signal(ProcessSignal::WindowChanged)?;
		Ok(())
	}

	/// Cancels a command without closing its session.
	pub fn cancel(&self, exec: &[u8]) -> Result<(), ExecError> {
		self.run(exec)?.cancel(CANCEL_GRACE);
		Ok(())
	}

	/// Starts a persistent named process and waits for every readiness probe.
	pub async fn start_process(&self, request: StartProcess) -> Result<ProcessStarted, ExecError> {
		let timeout = request
			.spec
			.as_ref()
			.and_then(|spec| spec.timeout_ms)
			.filter(|timeout| *timeout != 0)
			.map(Duration::from_millis);
		self.start_process_with_timeout(request, timeout).await
	}

	async fn start_process_with_timeout(
		&self,
		request: StartProcess,
		timeout: Option<Duration>,
	) -> Result<ProcessStarted, ExecError> {
		let name = Str::from(request.name);
		let (_reservation, generation) = self.reserve_process(name.clone())?;
		let ready = request.ready;
		let spec = request
			.spec
			.ok_or_else(|| ExecError::Shell(sf!("missing process spec")))?;
		let timeout = timeout.or_else(|| {
			spec
				.timeout_ms
				.filter(|timeout| *timeout != 0)
				.map(Duration::from_millis)
		});
		if spec.detached && spec.pty.is_some() {
			return Err(ExecError::DetachedPty);
		}
		if spec.detached {
			self
				.launch_detached(name, spec, ready, generation, None, timeout)
				.await
		} else {
			self
				.launch_attached(name, spec, ready, generation, None, timeout)
				.await
		}
	}

	async fn launch_attached(
		&self,
		name: Str,
		spec: ProcessSpec,
		ready: Vec<ReadyProbe>,
		generation: u64,
		recovered: Option<&ProcessRecord>,
		timeout: Option<Duration>,
	) -> Result<ProcessStarted, ExecError> {
		let (prior_end, prior_rotations) = recovered.map_or_else(
			|| {
				self
					.inner
					.processes
					.lock()
					.get(&name)
					.map_or((0, 0), |process| {
						let log = process.log.lock();
						(log.end_offset(), log.rotations())
					})
			},
			|record| (record.log_end_offset, record.log_rotations),
		);
		let log = ProcessLog::create(self.process_dir(&name), prior_end, prior_rotations)?;
		let identity = ProcessIdentity::current()?;
		let opened = self
			.open_session(OpenSessionRequest {
				cwd_uri:       spec.cwd_uri.clone(),
				env_delta:     spec.env_delta.clone(),
				pty:           spec.pty.clone(),
				lease:         None,
				shell_profile: None,
				props:         Default::default(),
			})
			.await?;
		let private_session = opened.session;
		let executed = self
			.exec(
				ExecRequest {
					session: private_session.clone(),
					source:  spec.source.clone(),
					props:   Default::default(),
				},
				timeout,
			)
			.await;
		let (started, run) = match executed {
			Ok(executed) => executed,
			Err(error) => {
				let _ = self.close_session(&private_session);
				return Err(error);
			},
		};
		let supervisor = recovered.map_or_else(
			|| RestartSupervisor::from_spec(spec.restart.as_ref()),
			|record| RestartSupervisor::recovered(record, spec.restart.as_ref()),
		);
		let process = Arc::new(NamedProcess {
			host: Arc::downgrade(&self.inner),
			name: name.clone(),
			generation,
			control: run.control.clone(),
			stream: Mutex::new(ProcessStreamState {
				info:        ProcessInfo {
					name: name.to_string(),
					generation,
					state: if ready.is_empty() {
						ProcessState::Running as i32
					} else {
						ProcessState::Starting as i32
					},
					ready_pending: ready_condition_names(&ready),
					props: spec.props.clone(),
					..ProcessInfo::default()
				},
				history:     Vec::new(),
				subscribers: Vec::new(),
			}),
			log: Mutex::new(log),
			spec: spec.clone(),
			ready: ready.clone().into(),
			identity,
			started_at: Instant::now(),
			detached: false,
			persist: spec.persist,
			stopping: AtomicBool::new(false),
			timed_out: AtomicBool::new(false),
			timeout,
			deadline_cancel: CancellationToken::new(),
			private_session: Mutex::new(Some(private_session)),
			restarts: Mutex::new(supervisor),
		});
		self
			.inner
			.processes
			.lock()
			.insert(name.clone(), process.clone());
		if let Err(error) = self.persist_process(
			&process,
			if ready.is_empty() {
				ProcessPhase::Running
			} else {
				ProcessPhase::WaitingReady
			},
		) {
			self.inner.processes.lock().remove(&name);
			process.control.cancel(CANCEL_GRACE);
			close_private_session(&process);
			return Err(error);
		}
		tokio::spawn(forward_named_process(process.clone(), run, started.exec));
		if let Err(error) = try_join_all(
			ready
				.iter()
				.cloned()
				.map(|probe| wait_ready_probe(process.clone(), probe)),
		)
		.await
		{
			process.stopping.store(true, Ordering::Release);
			process.control.cancel(CANCEL_GRACE);
			close_private_session(&process);
			self.persist_process(&process, ProcessPhase::Failed)?;
			return Err(error);
		}
		if !ready.is_empty() {
			let mut stream = process.stream.lock();
			if process_state_is_terminal(stream.info.state) {
				return Err(ExecError::Readiness(sf!(
					"process exited while readiness probes were running",
				)));
			}
			stream.info.state = ProcessState::Ready as i32;
			stream.info.ready_pending.clear();
			let info = stream.info.clone();
			stream.broadcast(ProcessEvent::State(info));
			drop(stream);
			self.persist_process(&process, ProcessPhase::Running)?;
		}
		let log_offset = process.log.lock().end_offset();
		let endpoint = process.stream.lock().info.endpoint.clone();
		Ok(ProcessStarted {
			name: process.name.to_string(),
			generation,
			identity: None,
			log_offset,
			endpoint,
			props: spec.props.clone(),
		})
	}

	async fn launch_detached(
		&self,
		name: Str,
		mut spec: ProcessSpec,
		ready: Vec<ReadyProbe>,
		generation: u64,
		recovered: Option<&ProcessRecord>,
		timeout: Option<Duration>,
	) -> Result<ProcessStarted, ExecError> {
		spec.persist = true;
		let (prior_end, prior_rotations) = recovered.map_or_else(
			|| {
				self
					.inner
					.processes
					.lock()
					.get(&name)
					.map_or((0, 0), |process| {
						let log = process.log.lock();
						(log.end_offset(), log.rotations())
					})
			},
			|record| (record.log_end_offset, record.log_rotations),
		);
		let log = ProcessLog::create(self.process_dir(&name), prior_end, prior_rotations)?;
		let output = log.child_output()?;
		let stderr = output.try_clone()?;
		let source = spec
			.source
			.as_ref()
			.ok_or_else(|| ExecError::Shell(sf!("missing process script")))?
			.text
			.clone();
		let cwd = cwd_from_uri(&spec.cwd_uri)?.map_or_else(env::current_dir, Ok)?;
		let sandbox = self.detached_sandbox()?;
		let mut command = detached_command(&source, sandbox.as_deref());
		command
			.current_dir(cwd)
			.stdin(Stdio::null())
			.stdout(Stdio::from(output))
			.stderr(Stdio::from(stderr));
		if let Some(sandbox) = sandbox.as_deref() {
			let mut environment = env::vars_os().collect::<Vec<_>>();
			if let Some(delta) = spec.env_delta.as_ref() {
				environment.retain(|(name, _)| {
					!delta.unset.iter().any(|unset| name == OsStr::new(unset))
						&& !delta.set.keys().any(|set| name == OsStr::new(set.as_str()))
				});
				environment.extend(delta.set.iter().map(|(name, value)| {
					(OsString::from(name.as_str()), OsString::from(value.as_str()))
				}));
			}
			command.env_clear().envs(sandbox.resolve_env(environment));
		} else if let Some(delta) = spec.env_delta.as_ref() {
			command.envs(&delta.set);
			for name in &delta.unset {
				command.env_remove(name);
			}
		}
		configure_detached_group(&mut command);
		let mut child = command.spawn()?;
		let pid = child.id();
		let initial_identity = match ProcessIdentity::capture(pid) {
			Ok(identity) => identity,
			Err(error) => {
				let _ = signal_process_group(pid as i32, ProcessSignal::Kill);
				let _ = child.wait();
				return Err(error.into());
			},
		};
		time::sleep(Duration::from_millis(10)).await;
		let identity = match ProcessIdentity::capture(pid) {
			Ok(identity) if identity.start_generation == initial_identity.start_generation => identity,
			Ok(_) => {
				let _ = signal_process_group(pid as i32, ProcessSignal::Kill);
				let _ = child.wait();
				return Err(ExecError::RunNotFound);
			},
			Err(IdentityError::NotFound { .. }) => initial_identity,
			Err(error) => {
				let _ = signal_process_group(pid as i32, ProcessSignal::Kill);
				let _ = child.wait();
				return Err(error.into());
			},
		};
		let (cancel_tx, cancel_rx) = flume::bounded(1);
		let control = Arc::new(RunControl {
			cancel_tx,
			input: Mutex::new(None),
			spawns: Arc::new(SpawnBook {
				groups:  Mutex::new(vec![pid as i32]),
				pids:    Mutex::new(Vec::new()),
				session: None,
			}),
			finished: AtomicBool::new(false),
			retained: Mutex::new(None),
			events: Weak::new(),
		});
		let mut supervisor = RestartSupervisor::from_spec(spec.restart.as_ref());
		if let Some(record) = recovered {
			supervisor = RestartSupervisor::recovered(record, spec.restart.as_ref());
		}
		let process = Arc::new(NamedProcess {
			host: Arc::downgrade(&self.inner),
			name: name.clone(),
			generation,
			control,
			stream: Mutex::new(ProcessStreamState {
				info:        ProcessInfo {
					name: name.to_string(),
					generation,
					state: if ready.is_empty() {
						ProcessState::Running as i32
					} else {
						ProcessState::Starting as i32
					},
					identity: Some(identity.to_wire()),
					ready_pending: ready_condition_names(&ready),
					props: spec.props.clone(),
					..ProcessInfo::default()
				},
				history:     Vec::new(),
				subscribers: Vec::new(),
			}),
			log: Mutex::new(log),
			spec: spec.clone(),
			ready: ready.clone().into(),
			identity: identity.clone(),
			started_at: Instant::now(),
			detached: true,
			persist: true,
			stopping: AtomicBool::new(false),
			timed_out: AtomicBool::new(false),
			timeout,
			deadline_cancel: CancellationToken::new(),
			private_session: Mutex::new(None),
			restarts: Mutex::new(supervisor),
		});
		if let Err(error) = self.persist_process(
			&process,
			if ready.is_empty() {
				ProcessPhase::Running
			} else {
				ProcessPhase::WaitingReady
			},
		) {
			let _ = process.control.spawns.signal(ProcessSignal::Kill);
			let _ = child.wait();
			return Err(error);
		}
		self
			.inner
			.processes
			.lock()
			.insert(name.clone(), process.clone());
		spawn_detached_monitor(process.clone(), Some(child), cancel_rx);
		spawn_process_deadline(process.clone());

		if let Err(error) = try_join_all(
			ready
				.iter()
				.cloned()
				.map(|probe| wait_ready_probe(process.clone(), probe)),
		)
		.await
		{
			process.stopping.store(true, Ordering::Release);
			process.control.cancel(CANCEL_GRACE);
			self.persist_process(&process, ProcessPhase::Failed)?;
			return Err(error);
		}
		if !ready.is_empty() {
			let mut stream = process.stream.lock();
			if process_state_is_terminal(stream.info.state) {
				return Err(ExecError::Readiness(sf!(
					"process exited while readiness probes were running",
				)));
			}
			stream.info.state = ProcessState::Ready as i32;
			stream.info.ready_pending.clear();
			let info = stream.info.clone();
			stream.broadcast(ProcessEvent::State(info));
			drop(stream);
			self.persist_process(&process, ProcessPhase::Running)?;
		}
		let log_offset = process.log.lock().end_offset();
		let endpoint = process.stream.lock().info.endpoint.clone();
		Ok(ProcessStarted {
			name: name.to_string(),
			generation,
			identity: Some(identity.to_wire()),
			log_offset,
			endpoint,
			props: spec.props.clone(),
		})
	}

	fn process_dir(&self, name: &str) -> PathBuf {
		self
			.inner
			.persistence
			.lock()
			.as_ref()
			.map_or_else(
				|| env::temp_dir().join(format!("omp-processes-{}", process::id())),
				|persistence| persistence.store.process_root(),
			)
			.join(name)
	}

	fn persist_process(&self, process: &NamedProcess, phase: ProcessPhase) -> Result<(), ExecError> {
		let process_dir = self.process_dir(&process.name);
		let mut persistence = self.inner.persistence.lock();
		let Some(persistence) = persistence.as_mut() else {
			return Ok(());
		};
		let stream = process.stream.lock();
		let log = process.log.lock();
		let supervisor = process.restarts.lock();
		let existing = persistence
			.snapshot
			.processes
			.iter()
			.find(|record| record.name == process.name && record.generation == process.generation);
		let started_order = existing.map_or_else(
			|| self.inner.next_order.fetch_add(1, Ordering::Relaxed),
			|record| record.started_order,
		);
		let recent_order = if phase.is_terminal() {
			self.inner.next_order.fetch_add(1, Ordering::Relaxed)
		} else {
			existing.map_or(0, |record| record.recent_order)
		};
		let record = ProcessRecord {
			name: process.name.clone(),
			spec_wire: process.spec.encode_to_vec(),
			ready_wire: process
				.ready
				.iter()
				.map(|probe| probe.encode_to_vec())
				.collect(),
			process_dir,
			generation: process.generation,
			identity: process.identity.clone(),
			detached: process.detached,
			persist: process.persist,
			phase,
			log_start_offset: log.start_offset(),
			log_end_offset: log.end_offset(),
			log_rotations: log.rotations(),
			restart_count: supervisor.restart_count,
			consecutive_failures: supervisor.consecutive_failures,
			restart_history: supervisor.history.clone(),
			started_order,
			recent_order,
		};
		drop(supervisor);
		drop(log);
		drop(stream);
		if let Some(slot) = persistence
			.snapshot
			.processes
			.iter_mut()
			.find(|record| record.name == process.name)
		{
			*slot = record;
		} else {
			persistence.snapshot.processes.push(record);
		}
		if let Some(current) = persistence.store.load()? {
			persistence.snapshot.shutdown_acknowledgement = current.shutdown_acknowledgement;
		}
		persistence.store.save(&persistence.snapshot)?;
		Ok(())
	}

	fn recover_records(&self, records: Vec<ProcessRecord>) -> Result<(), ExecError> {
		for record in records {
			if !record.phase.is_active() {
				continue;
			}
			if !record.detached || !record.persist || !record.identity.verify()? {
				self.mark_recovered_terminal(&record, ProcessPhase::Exited)?;
				continue;
			}
			let Ok(spec) = ProcessSpec::decode(record.spec_wire.as_slice()) else {
				self.mark_recovered_terminal(&record, ProcessPhase::Failed)?;
				continue;
			};
			let ready: Vec<_> = record
				.ready_wire
				.iter()
				.filter_map(|wire| ReadyProbe::decode(wire.as_slice()).ok())
				.collect();
			let log = ProcessLog::reopen(
				&record.process_dir,
				record.log_start_offset,
				record.log_end_offset,
				record.log_rotations,
			)?;
			let (cancel_tx, cancel_rx) = flume::bounded(1);
			let control = Arc::new(RunControl {
				cancel_tx,
				input: Mutex::new(None),
				spawns: Arc::new(SpawnBook {
					groups:  Mutex::new(vec![record.identity.pid as i32]),
					pids:    Mutex::new(Vec::new()),
					session: None,
				}),
				finished: AtomicBool::new(false),
				retained: Mutex::new(None),
				events: Weak::new(),
			});
			let state = match record.phase {
				ProcessPhase::WaitingReady | ProcessPhase::Starting => ProcessState::Starting,
				ProcessPhase::Running => ProcessState::Running,
				_ => ProcessState::Exited,
			};
			let process = Arc::new(NamedProcess {
				host: Arc::downgrade(&self.inner),
				name: record.name.clone(),
				generation: record.generation,
				control,
				stream: Mutex::new(ProcessStreamState {
					info:        ProcessInfo {
						name: record.name.to_string(),
						generation: record.generation,
						state: state as i32,
						identity: Some(record.identity.to_wire()),
						log_start_offset: record.log_start_offset,
						log_end_offset: record.log_end_offset,
						restart_count: record.restart_count,
						consecutive_failures: record.consecutive_failures,
						ready_pending: if state == ProcessState::Starting {
							ready_condition_names(&ready)
						} else {
							Vec::new()
						},
						props: spec.props.clone(),
						..ProcessInfo::default()
					},
					history:     Vec::new(),
					subscribers: Vec::new(),
				}),
				log: Mutex::new(log),
				spec: spec.clone(),
				ready: ready.into(),
				identity: record.identity.clone(),
				started_at: Instant::now(),
				detached: true,
				persist: true,
				stopping: AtomicBool::new(false),
				timed_out: AtomicBool::new(false),
				timeout: spec
					.timeout_ms
					.filter(|timeout| *timeout != 0)
					.map(Duration::from_millis),
				deadline_cancel: CancellationToken::new(),
				private_session: Mutex::new(None),
				restarts: Mutex::new(RestartSupervisor::recovered(&record, spec.restart.as_ref())),
			});
			self
				.inner
				.processes
				.lock()
				.insert(record.name.clone(), process.clone());
			spawn_detached_monitor(process.clone(), None, cancel_rx);
			spawn_process_deadline(process.clone());
			if state == ProcessState::Starting {
				tokio::spawn(resume_recovered_readiness(process));
			}
		}
		Ok(())
	}

	fn persisted_record(&self, name: &str) -> Option<ProcessRecord> {
		self
			.inner
			.persistence
			.lock()
			.as_ref()?
			.snapshot
			.processes
			.iter()
			.find(|record| record.name.as_str() == name)
			.cloned()
	}

	fn mark_recovered_terminal(
		&self,
		record: &ProcessRecord,
		phase: ProcessPhase,
	) -> Result<(), ExecError> {
		let mut persistence = self.inner.persistence.lock();
		let Some(persistence) = persistence.as_mut() else {
			return Ok(());
		};
		if let Some(stored) = persistence
			.snapshot
			.processes
			.iter_mut()
			.find(|stored| stored.name == record.name)
		{
			stored.phase = phase;
			stored.recent_order = self.inner.next_order.fetch_add(1, Ordering::Relaxed);
		}
		persistence.store.save(&persistence.snapshot)?;
		Ok(())
	}

	/// Converts an active foreground execution into a retained named process.
	///
	/// The existing process groups, input handles, execution identifier, and
	/// output sequencer are preserved. Dropping the foreground [`ExecRun`] after
	/// this succeeds no longer requests process-tree cancellation.
	pub fn detach_exec(&self, exec: &[u8], name: &str) -> Result<ProcessStarted, ExecError> {
		let name = Str::from(name);
		let (_reservation, generation) = self.reserve_process(name.clone())?;
		let control = self.run(exec)?;
		let events = control.events.upgrade().ok_or(ExecError::RunNotFound)?;
		let mut retained = control.retained.lock();
		if control.finished.load(Ordering::Acquire)
			|| retained.as_ref().and_then(Weak::upgrade).is_some()
		{
			return Err(ExecError::RunNotFound);
		}
		let (prior_end, prior_rotations) =
			self
				.inner
				.processes
				.lock()
				.get(&name)
				.map_or((0, 0), |process| {
					let log = process.log.lock();
					(log.end_offset(), log.rotations())
				});
		let process = Arc::new(NamedProcess {
			host: Arc::downgrade(&self.inner),
			name: name.clone(),
			generation,
			control: control.clone(),
			stream: Mutex::new(ProcessStreamState {
				info:        ProcessInfo {
					name: name.to_string(),
					generation,
					state: ProcessState::Running as i32,
					status: None,
					..ProcessInfo::default()
				},
				history:     Vec::new(),
				subscribers: Vec::new(),
			}),
			log: Mutex::new(ProcessLog::create(self.process_dir(&name), prior_end, prior_rotations)?),
			spec: ProcessSpec::default(),
			ready: Arc::from([]),
			identity: ProcessIdentity::current()?,
			started_at: Instant::now(),
			detached: false,
			persist: false,
			stopping: AtomicBool::new(false),
			timed_out: AtomicBool::new(false),
			timeout: None,
			deadline_cancel: CancellationToken::new(),
			private_session: Mutex::new(None),
			restarts: Mutex::new(RestartSupervisor::from_spec(None)),
		});
		self
			.inner
			.processes
			.lock()
			.insert(name.clone(), process.clone());
		if let Err(error) = self.persist_process(&process, ProcessPhase::Running) {
			self.inner.processes.lock().remove(&name);
			return Err(error);
		}
		*retained = Some(Arc::downgrade(&process));
		drop(retained);
		tokio::spawn(forward_named_process(
			process.clone(),
			ExecRun { id: Bytes::copy_from_slice(exec), events, control },
			Bytes::copy_from_slice(exec),
		));
		Ok(ProcessStarted {
			name: process.name.to_string(),
			generation,
			identity: None,
			log_offset: 0,
			endpoint: None,
			props: Default::default(),
		})
	}

	/// Returns one exact retained process generation.
	pub fn get_process(&self, request: &GetProcess) -> Result<ProcessInfo, ExecError> {
		if request.wire_revision != omp_proto::SCHEMA_REV {
			return Err(ExecError::WireRevision);
		}
		let process = self.named_process(&request.name, request.generation)?;
		let info = process.stream.lock().info.clone();
		Ok(info)
	}

	/// Restarts exactly one retained generation from its authoritative launch
	/// specification and waits for the replacement generation's readiness.
	pub async fn restart_process(
		&self,
		request: RestartProcess,
	) -> Result<ProcessStarted, ExecError> {
		if request.wire_revision != omp_proto::SCHEMA_REV {
			return Err(ExecError::WireRevision);
		}
		let (_reservation, process) =
			self.reserve_process_generation(&request.name, request.generation)?;
		process.stopping.store(true, Ordering::Release);
		let record = self.persisted_record(&process.name);
		let spec = process.spec.clone();
		let ready = process.ready.to_vec();
		let generation = process.generation.saturating_add(1);
		let detached = process.detached;
		let timeout = process.timeout;
		process.control.cancel(CANCEL_GRACE);
		wait_process_finished(&process).await?;
		process.deadline_cancel.cancel();
		close_private_session(&process);
		if detached {
			self
				.launch_detached(
					process.name.clone(),
					spec,
					ready,
					generation,
					record.as_ref(),
					timeout,
				)
				.await
		} else {
			self
				.launch_attached(
					process.name.clone(),
					spec,
					ready,
					generation,
					record.as_ref(),
					timeout,
				)
				.await
		}
	}

	/// Lists active processes oldest-to-newest followed by at most ten newest
	/// terminal records.
	pub fn list_processes(&self) -> ProcessList {
		let snapshot = self
			.inner
			.persistence
			.lock()
			.as_ref()
			.map(|persistence| persistence.snapshot.clone());
		let live = self.inner.processes.lock();
		let mut processes: Vec<ProcessInfo> = if let Some(snapshot) = snapshot.as_ref() {
			snapshot
				.ordered_records()
				.into_iter()
				.map(|record| {
					live.get(&record.name).map_or_else(
						|| process_info_from_record(record),
						|process| process.stream.lock().info.clone(),
					)
				})
				.collect()
		} else {
			live
				.values()
				.map(|process| process.stream.lock().info.clone())
				.collect()
		};
		if snapshot.is_none() {
			processes.sort_unstable_by(|left, right| left.name.cmp(&right.name));
		}
		ProcessList { processes, props: Default::default() }
	}

	/// Attaches to buffered and future named-process output.
	pub fn attach_output(&self, request: &AttachOutput) -> Result<ProcessAttachment, ExecError> {
		let process = self.named_process(&request.name, request.generation)?;
		let (tx, events) = flume::unbounded();
		let mut stream = process.stream.lock();
		let max_bytes = if request.max_bytes == 0 {
			process_log::MAX_LOG_READ_BYTES
		} else {
			request.max_bytes
		};
		let (data, rotated) = process
			.log
			.lock()
			.read_after(request.after_sequence, max_bytes)?;
		let backlog = if data.is_empty() {
			Vec::new()
		} else {
			let log_offset = request.after_sequence.max(stream.info.log_start_offset);
			let sequence = log_offset.saturating_add(data.len() as u64);
			vec![ProcessOutput {
				name: process.name.to_string(),
				generation: process.generation,
				channel: OutputChannel::Stdout as i32,
				data: data.into(),
				sequence,
				log_offset,
				terminal_text: false,
				truncated: rotated,
				props: Default::default(),
			}]
		};
		stream.subscribers.push(tx);
		let state = stream.info.clone();
		drop(stream);
		Ok(ProcessAttachment {
			attached: OutputAttached {
				name: request.name.clone(),
				generation: process.generation,
				log_start_offset: state.log_start_offset,
				log_end_offset: state.log_end_offset,
				rotated,
				terminal_text: request.terminal_text,
				props: Default::default(),
			},
			backlog,
			state,
			events,
		})
	}

	/// Writes input or closes stdin for a named process.
	pub fn send_process_input(
		&self,
		name: &str,
		generation: u64,
		data: Option<&[u8]>,
	) -> Result<ProcessCommandAccepted, ExecError> {
		let process = self.named_process(name, generation)?;
		write_input(&process.control, data)?;
		Ok(ProcessCommandAccepted {
			name: name.to_owned(),
			shutdown_acknowledged: false,
			generation,
			props: Default::default(),
		})
	}

	/// Sends a named signal to every group owned by a named process.
	pub fn signal_process(
		&self,
		name: &str,
		generation: u64,
		signal: &str,
	) -> Result<ProcessCommandAccepted, ExecError> {
		let process = self.named_process(name, generation)?;
		if process.control.finished.load(Ordering::Acquire) {
			return Err(ExecError::RunNotFound);
		}
		process.control.spawns.signal(parse_signal(signal)?)?;
		Ok(ProcessCommandAccepted {
			name: name.to_owned(),
			shutdown_acknowledged: false,
			generation,
			props: Default::default(),
		})
	}

	/// TERM-then-KILLs a named process. Its registration and terminal state
	/// remain available to list and attach calls.
	pub fn stop_process(
		&self,
		name: &str,
		generation: u64,
		grace: Duration,
	) -> Result<ProcessCommandAccepted, ExecError> {
		let process = self.named_process(name, generation)?;
		process.stopping.store(true, Ordering::Release);
		process.control.cancel(grace);
		Ok(ProcessCommandAccepted {
			name: name.to_owned(),
			shutdown_acknowledged: false,
			generation,
			props: Default::default(),
		})
	}

	/// Gracefully stops every managed process except a verified detached,
	/// persistent generation that can be safely re-adopted, then waits for
	/// every stopped group leader to be reaped.
	pub async fn shutdown_managed(&self, grace: Duration) -> ShutdownSummary {
		let processes: Vec<_> = self.inner.processes.lock().values().cloned().collect();
		let mut summary = ShutdownSummary { stopped: 0, spared: 0 };
		let mut stopped = Vec::new();
		for process in processes {
			let verified = process
				.stream
				.lock()
				.info
				.identity
				.as_ref()
				.is_some_and(ProcessIdentity::verify_wire);
			if process.detached && process.persist && verified {
				summary.spared = summary.spared.saturating_add(1);
			} else {
				process.control.cancel(grace);
				summary.stopped = summary.stopped.saturating_add(1);
				stopped.push(process);
			}
		}
		let deadline = Instant::now() + grace + Duration::from_secs(2);
		while stopped
			.iter()
			.any(|process| !process.control.finished.load(Ordering::Acquire))
			&& Instant::now() < deadline
		{
			time::sleep(Duration::from_millis(10)).await;
		}
		summary
	}

	fn named_process(&self, name: &str, generation: u64) -> Result<Arc<NamedProcess>, ExecError> {
		let key = Str::from(name);
		let process = self
			.inner
			.processes
			.lock()
			.get(&key)
			.cloned()
			.ok_or_else(|| ExecError::ProcessNotFound(key.clone()))?;
		if process.generation != generation {
			return Err(ExecError::StaleProcessGeneration {
				name:      key,
				requested: generation,
				current:   process.generation,
			});
		}
		Ok(process)
	}

	fn run(&self, exec: &[u8]) -> Result<Arc<RunControl>, ExecError> {
		self
			.inner
			.runs
			.lock()
			.get(exec)
			.and_then(Weak::upgrade)
			.ok_or(ExecError::RunNotFound)
	}

	fn reserve_process(&self, name: Str) -> Result<(ProcessReservation, u64), ExecError> {
		if name.is_empty()
			|| name.len() > 48
			|| !name
				.as_bytes()
				.iter()
				.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
		{
			return Err(ExecError::InvalidProcessName);
		}
		if !self.inner.starting.lock().insert(name.clone()) {
			return Err(ExecError::ProcessExists(name));
		}
		let generation = if let Some(process) = self.inner.processes.lock().get(&name).cloned() {
			if !process_state_is_terminal(process.stream.lock().info.state) {
				self.inner.starting.lock().remove(&name);
				return Err(ExecError::ProcessExists(name));
			}
			process.generation.saturating_add(1)
		} else {
			1
		};
		Ok((ProcessReservation { host: Arc::downgrade(&self.inner), name }, generation))
	}

	fn reserve_process_generation(
		&self,
		name: &str,
		generation: u64,
	) -> Result<(ProcessReservation, Arc<NamedProcess>), ExecError> {
		let name = Str::from(name);
		if !self.inner.starting.lock().insert(name.clone()) {
			return Err(ExecError::ProcessExists(name));
		}
		let reservation =
			ProcessReservation { host: Arc::downgrade(&self.inner), name: name.clone() };
		let process = self
			.inner
			.processes
			.lock()
			.get(&name)
			.cloned()
			.ok_or_else(|| ExecError::ProcessNotFound(name.clone()))?;
		if process.generation != generation {
			return Err(ExecError::StaleProcessGeneration {
				name,
				requested: generation,
				current: process.generation,
			});
		}
		Ok((reservation, process))
	}

	fn new_id(&self) -> Bytes {
		Bytes::copy_from_slice(
			&self
				.inner
				.next_id
				.fetch_add(1, Ordering::Relaxed)
				.to_be_bytes(),
		)
	}
}

impl Drop for ProcessReservation {
	fn drop(&mut self) {
		if let Some(host) = self.host.upgrade() {
			host.starting.lock().remove(&self.name);
		}
	}
}
impl RunControl {
	fn cancel(&self, grace: Duration) {
		let _ = self.cancel_tx.try_send(CancelRequest { grace });
	}

	fn close_input(&self) {
		self.input.lock().take();
	}
}

impl SpawnObserver for SpawnBook {
	fn on_spawn(&self, pid: i32, pgid: Option<i32>) {
		self.record_spawn(pid, pgid);
		if let Some(session) = self.session.as_ref() {
			session.record_spawn(pid, pgid);
		}
	}
}
impl ProcessScope for SpawnBook {
	fn may_signal(&self, pid: i32) -> bool {
		self.owns_process(pid)
	}

	fn may_observe(&self, pid: i32) -> bool {
		self.owns_process(pid)
	}
}

impl SpawnBook {
	fn record_spawn(&self, pid: i32, pgid: Option<i32>) {
		let mut pids = self.pids.lock();
		if !pids.contains(&pid) {
			pids.push(pid);
		}
		drop(pids);
		let Some(pgid) = pgid else { return };
		let mut groups = self.groups.lock();
		if !groups.contains(&pgid) {
			groups.push(pgid);
		}
	}

	fn owns_process(&self, pid: i32) -> bool {
		if pid == process::id() as i32 {
			return false;
		}
		self.pids.lock().contains(&pid)
			|| self.groups.lock().contains(&pid)
			|| pid
				.checked_neg()
				.is_some_and(|pgid| self.groups.lock().contains(&pgid))
			|| self
				.session
				.as_ref()
				.is_some_and(|session| session.owns_process(pid))
	}

	fn signal(&self, signal: ProcessSignal) -> Result<(), io::Error> {
		for pgid in self.groups.lock().iter().copied() {
			signal_process_group(pgid, signal)?;
		}
		Ok(())
	}

	async fn terminate(&self, grace: Duration) {
		if self.groups.lock().is_empty() {
			return;
		}
		let _ = self.signal(ProcessSignal::Terminate);
		if !grace.is_zero() {
			time::sleep(grace).await;
		}
		let _ = self.signal(ProcessSignal::Kill);
	}
}

async fn session_loop(mut shell: Shell, commands: Receiver<SessionCommand>) {
	use tokio::time::Instant;
	let mut cancellation_deadline = None;
	loop {
		let command = if let Some(deadline) = cancellation_deadline {
			tokio::select! {
				  command = commands.recv_async() => match command {
						 Ok(command) => command,
						 Err(_) => break,
				  },
				  () = time::sleep_until(deadline) => {
						 cancellation_deadline = None;
						 continue;
				  },
			}
		} else {
			match commands.recv_async().await {
				Ok(command) => command,
				Err(_) => break,
			}
		};

		if let Some(deadline) = cancellation_deadline {
			match time::timeout_at(deadline, command.cancel_rx.recv_async()).await {
				Ok(Ok(_) | Err(_)) => {
					finish_session_command(
						&command,
						RunTerminal::Cancelled,
						Duration::ZERO,
						shell.working_dir(),
					);
					cancellation_deadline = Some(Instant::now() + CANCEL_GRACE);
					continue;
				},
				Err(_) => cancellation_deadline = None,
			}
		}
		if run_session_command(&mut shell, command).await {
			cancellation_deadline = Some(Instant::now() + CANCEL_GRACE);
		}
	}
}

async fn run_session_command(shell: &mut Shell, command: SessionCommand) -> bool {
	let started_at = Instant::now();
	match command.cancel_rx.try_recv() {
		Ok(_) | Err(flume::TryRecvError::Disconnected) => {
			finish_session_command(
				&command,
				RunTerminal::Cancelled,
				started_at.elapsed(),
				shell.working_dir(),
			);
			return true;
		},
		Err(flume::TryRecvError::Empty) => {},
	}
	let cancel_rx = command.cancel_rx.clone();
	let sandbox_active = !command.bypass_sandbox
		&& command
			.sandbox
			.as_ref()
			.is_some_and(|sandbox| sandbox.kernel_active());
	let setup = setup_io(
		command.pty.as_ref(),
		command.control.clone(),
		command.exec.clone(),
		command.events.clone(),
		sandbox_active,
	);
	let Ok((mut params, readers, sequencer)) = setup else {
		finish_session_command(
			&command,
			RunTerminal::Failed,
			started_at.elapsed(),
			shell.working_dir(),
		);
		return false;
	};
	let environment_scoped = command.environment.is_some();
	if let Some(environment) = command.environment.as_ref() {
		shell.env_mut().push_scope(EnvironmentScope::Command);
		if apply_run_environment_delta(shell, environment).is_err() {
			let _ = shell.env_mut().pop_scope(EnvironmentScope::Command);
			finish_session_command(
				&command,
				RunTerminal::Failed,
				started_at.elapsed(),
				shell.working_dir(),
			);
			return false;
		}
	}
	let _ = command
		.events
		.send(ExecEvent::Started { exec_id: command.exec.clone() });
	params.process_group_policy = omp_shell_engine::ProcessGroupPolicy::NewProcessGroup;
	params.set_spawn_observer(command.control.spawns.clone());
	params.set_process_scope(command.control.spawns.clone());
	params.set_protect_host_process(true);
	if !command.bypass_sandbox
		&& let Some(sandbox) = command.sandbox.as_ref()
	{
		if sandbox.kernel_active() {
			params.set_path_policy(sandbox.clone());
		}
		params.set_spawn_wrapper(sandbox.clone());
	}
	let source_info = SourceInfo::from("env/v1 exec");
	let result = {
		let timeout = async {
			match command.timeout {
				Some(timeout) => time::sleep(timeout).await,
				None => future::pending().await,
			}
		};
		tokio::pin!(timeout);
		let execution = shell.run_string(command.source.to_string(), &source_info, &params);
		tokio::pin!(execution);
		tokio::select! {
			  result = &mut execution => match result {
					 Ok(result) => (
						 RunTerminal::Exited(i32::from(u8::from(result.exit_code))),
						 None,
					 ),
					 Err(error) => (RunTerminal::Failed, Some(error)),
			  },
			  request = cancel_rx.recv_async() => {
					 let request = request.unwrap_or(CancelRequest { grace: CANCEL_GRACE });
					 command.control.spawns.terminate(request.grace).await;
					 (RunTerminal::Cancelled, None)
			  },
			  () = &mut timeout => {
					 command.control.spawns.terminate(CANCEL_GRACE).await;
					 (RunTerminal::Timeout, None)
			  },
		}
	};
	let (result, shell_error) = result;
	if let Some(error) = shell_error.as_ref()
		&& sandbox_active
	{
		let mut stderr = params.stderr(shell);
		let _ = shell.display_error(&mut stderr, error);
	}
	drop(params);
	command.control.close_input();
	for reader in readers {
		let _ = reader.await;
	}
	let cancelled = result == RunTerminal::Cancelled;
	let result = if environment_scoped
		&& shell
			.env_mut()
			.pop_scope(EnvironmentScope::Command)
			.is_err()
	{
		RunTerminal::Failed
	} else {
		result
	};
	let denial = {
		let sequencer = sequencer.lock();
		classify_sandbox_denial(
			sandbox_active,
			&result,
			shell_error.as_ref(),
			sequencer.sandbox_diagnostic.as_deref().unwrap_or_default(),
		)
	};
	let result = denial.map_or(result, |denial| RunTerminal::Denied {
		exit_code: denial.exit_code,
		path:      denial.path,
	});
	if matches!(&result, RunTerminal::Denied { .. })
		&& let Some(sandbox) = command.sandbox.as_ref()
	{
		sequencer
			.lock()
			.sandbox_note(&command.exec, sandbox.failure_note());
	}
	finish_session_command(&command, result, started_at.elapsed(), shell.working_dir());
	cancelled
}

fn finish_session_command(
	command: &SessionCommand,
	result: RunTerminal,
	elapsed: Duration,
	working_dir: &Path,
) {
	command.control.finished.store(true, Ordering::Release);
	let (final_cwd_uri, final_cwd_revision) = command.host.upgrade().map_or_else(
		|| (String::new(), 0),
		|host| {
			let revision = host.next_revision.fetch_add(1, Ordering::Relaxed);
			let cwd_uri = Url::from_directory_path(working_dir)
				.expect("shell working directory must be an absolute file URI")
				.to_string();
			host
				.final_cwds
				.lock()
				.insert(command.exec.clone(), ExecFinalCwd {
					exec: command.exec.clone(),
					cwd_uri: cwd_uri.clone(),
					revision,
					terminal: true,
				});
			(cwd_uri, revision)
		},
	);
	if result == RunTerminal::Exited(0)
		&& !command.github_targets.is_empty()
		&& let Some(host) = command.host.upgrade()
		&& let Some(cache) = host.github_cache.lock().clone()
	{
		let active_repo = github_repository(working_dir);
		let repos = command
			.github_targets
			.iter()
			.filter_map(|target| target.repo.clone().or_else(|| active_repo.clone()))
			.collect::<BTreeSet<_>>();
		for repo in repos {
			let _ = cache.invalidate_repo(&repo);
		}
	}
	let event = ExecEvent::Exit(ExitEvent {
		exec: command.exec.clone(),
		status: Some(result.status(elapsed)),
		final_cwd_uri,
		final_cwd_revision,
		props: Default::default(),
	});
	let _ = command.events.send(event);
}

#[derive(Clone, Eq, PartialEq)]
enum RunTerminal {
	Exited(i32),
	Failed,
	Timeout,
	Cancelled,
	Denied { exit_code: Option<i32>, path: Str },
}

impl RunTerminal {
	fn status(self, elapsed: Duration) -> ExecStatusMsg {
		let props = match &self {
			Self::Denied { path, .. } => Some(WireValueMap {
				fields: BTreeMap::from([(SANDBOX_DENIED_PATH_PROP.to_owned(), WireValue {
					kind: Some(wire_value::Kind::String(path.to_string())),
				})]),
			}),
			_ => None,
		};
		let (outcome, exit_code, signal, aborted) = match self {
			Self::Exited(code) if code == 0 => (ExecOutcome::Exited, Some(code), "", false),
			Self::Exited(code) => (ExecOutcome::Failed, Some(code), "", false),
			Self::Failed => (ExecOutcome::Failed, None, "", false),
			Self::Timeout => (ExecOutcome::Timeout, None, "SIGKILL", true),
			Self::Cancelled => (ExecOutcome::Cancelled, None, "", true),
			Self::Denied { exit_code, .. } => (ExecOutcome::Denied, exit_code, "", false),
		};
		ExecStatusMsg {
			outcome: outcome as i32,
			exit_code,
			signal: signal.to_owned(),
			wall_clock_ms: elapsed.as_millis().try_into().unwrap_or(u64::MAX),
			spilled_output: None,
			aborted,
			props,
		}
	}
}

struct SandboxDenial {
	exit_code: Option<i32>,
	path:      Str,
}

fn classify_sandbox_denial(
	sandbox_active: bool,
	result: &RunTerminal,
	error: Option<&omp_shell_engine::Error>,
	stderr: &[u8],
) -> Option<SandboxDenial> {
	if !sandbox_active {
		return None;
	}
	if let Some(omp_shell_engine::ErrorKind::WriteDenied(denied)) =
		error.map(omp_shell_engine::Error::kind)
	{
		return Some(SandboxDenial {
			exit_code: None,
			path:      Str::from(denied.path.to_string_lossy().as_ref()),
		});
	}
	let command_failed = match result {
		RunTerminal::Failed => true,
		RunTerminal::Exited(code) => *code != 0,
		_ => false,
	};
	if command_failed && let Some(path) = shell_write_denied_path(stderr) {
		return Some(SandboxDenial {
			exit_code: match result {
				RunTerminal::Exited(code) => Some(*code),
				_ => None,
			},
			path,
		});
	}
	let RunTerminal::Exited(exit_code) = result else {
		return None;
	};
	if *exit_code == 0 {
		return None;
	}
	let marker = sandbox_denial_marker(stderr)?;
	Some(SandboxDenial {
		exit_code: Some(*exit_code),
		path:      sandbox_denied_path(stderr, marker),
	})
}

fn shell_write_denied_path(stderr: &[u8]) -> Option<Str> {
	let marker = stderr
		.windows(WRITE_DENIED_DIAGNOSTIC.len())
		.position(|window| window == WRITE_DENIED_DIAGNOSTIC)?;
	let path_start = marker + WRITE_DENIED_DIAGNOSTIC.len();
	let path_end = stderr[path_start..]
		.iter()
		.position(|byte| *byte == b'\n' || *byte == b'\r')
		.map_or(stderr.len(), |position| path_start + position);
	let path = String::from_utf8_lossy(&stderr[path_start..path_end]);
	let path = path.trim();
	(!path.is_empty()).then(|| Str::from(path))
}

fn sandbox_denial_marker(stderr: &[u8]) -> Option<usize> {
	stderr
		.windows(b"Operation not permitted".len())
		.position(|window| window == b"Operation not permitted")
		.or_else(|| {
			stderr
				.windows(b"EPERM".len())
				.enumerate()
				.find_map(|(position, window)| {
					if window != b"EPERM" {
						return None;
					}
					let before = position
						.checked_sub(1)
						.and_then(|index| stderr.get(index))
						.is_none_or(|byte| !byte.is_ascii_alphanumeric() && *byte != b'_');
					let after = stderr
						.get(position + b"EPERM".len())
						.is_none_or(|byte| !byte.is_ascii_alphanumeric() && *byte != b'_');
					(before && after).then_some(position)
				})
		})
}

fn sandbox_denied_path(stderr: &[u8], marker: usize) -> Str {
	let line_start = stderr[..marker]
		.iter()
		.rposition(|byte| *byte == b'\n' || *byte == b'\r')
		.map_or(0, |position| position + 1);
	let line_end = stderr[marker..]
		.iter()
		.position(|byte| *byte == b'\n' || *byte == b'\r')
		.map_or(stderr.len(), |position| marker + position);
	let line = String::from_utf8_lossy(&stderr[line_start..line_end]);
	let prefix = String::from_utf8_lossy(&stderr[line_start..marker]);
	let prefix = prefix.trim().trim_end_matches(':').trim();
	let candidate = prefix
		.rsplit_once(':')
		.map_or(prefix, |(_, path)| path.trim());
	if candidate.starts_with('/') || candidate.starts_with("./") || candidate.starts_with("../") {
		Str::from(candidate)
	} else {
		Str::from(line.trim())
	}
}

fn write_input(control: &RunControl, data: Option<&[u8]>) -> Result<(), ExecError> {
	if control.finished.load(Ordering::Acquire) {
		return Err(ExecError::RunNotFound);
	}
	let mut input = control.input.lock();
	if let Some(data) = data {
		match input.as_mut().ok_or(ExecError::RunNotFound)? {
			InputSink::Pipe(writer) => writer.write_all(data)?,
			InputSink::Pty(master) => master.write_all(data)?,
		}
	} else {
		input.take();
	}
	Ok(())
}

fn setup_io(
	pty: Option<&PtySpec>,
	control: Arc<RunControl>,
	exec: Bytes,
	events: flume::Sender<ExecEvent>,
	capture_sandbox_diagnostic: bool,
) -> Result<(ExecutionParameters, Vec<task::JoinHandle<()>>, Arc<Mutex<OutputSequencer>>), ExecError>
{
	let mut params = ExecutionParameters::default();
	let sequencer = Arc::new(Mutex::new(OutputSequencer {
		next: 1,
		events,
		at_line_start: true,
		sandbox_diagnostic: capture_sandbox_diagnostic.then(Vec::new),
	}));
	if let Some(pty) = pty {
		let winsize = nix::pty::Winsize {
			ws_row:    clamp_u16(pty.rows),
			ws_col:    clamp_u16(pty.columns),
			ws_xpixel: 0,
			ws_ypixel: 0,
		};
		let opened = nix::pty::openpty(Some(&winsize), None).map_err(errno_io)?;
		#[cfg(target_os = "macos")]
		// SAFETY: fcntl on an owned, open descriptor with no memory arguments.
		unsafe {
			libc::fcntl(fd::AsRawFd::as_raw_fd(&opened.master), 73, 1);
		}
		let master_read = opened.master.as_fd().try_clone_to_owned()?;
		let master_write = fs::File::from(opened.master);
		let slave = fs::File::from(opened.slave);
		params.set_fd(OpenFiles::STDIN_FD, OpenFile::from(slave.try_clone()?));
		params.set_fd(OpenFiles::STDOUT_FD, OpenFile::from(slave.try_clone()?));
		params.set_fd(OpenFiles::STDERR_FD, OpenFile::from(slave));
		*control.input.lock() = Some(InputSink::Pty(master_write));
		let reader =
			spawn_reader(fs::File::from(master_read), OutputChannel::Pty, exec, sequencer.clone());
		Ok((params, vec![reader], sequencer))
	} else {
		let (stdin_read, stdin_write) = io::pipe()?;
		let (stdout_read, stdout_write) = io::pipe()?;
		let (stderr_read, stderr_write) = io::pipe()?;
		#[cfg(target_os = "macos")]
		for fd in [
			fd::AsRawFd::as_raw_fd(&stdin_write),
			fd::AsRawFd::as_raw_fd(&stdout_write),
			fd::AsRawFd::as_raw_fd(&stderr_write),
		] {
			// `F_SETNOSIGPIPE` (73, absent from `libc`): writes into a closed pipe
			// surface as `EPIPE` instead of raising `SIGPIPE`. The in-process shell
			// writes builtin output on host threads; a capped/cancelled reader must
			// never kill the daemon.
			// SAFETY: fcntl on an owned, open descriptor with no memory arguments.
			unsafe {
				libc::fcntl(fd, 73, 1);
			}
		}
		params.set_fd(OpenFiles::STDIN_FD, stdin_read.into());
		params.set_fd(OpenFiles::STDOUT_FD, stdout_write.into());
		params.set_fd(OpenFiles::STDERR_FD, stderr_write.into());
		*control.input.lock() = Some(InputSink::Pipe(stdin_write));
		Ok((
			params,
			vec![
				spawn_reader(stdout_read, OutputChannel::Stdout, exec.clone(), sequencer.clone()),
				spawn_reader(stderr_read, OutputChannel::Stderr, exec, sequencer.clone()),
			],
			sequencer,
		))
	}
}

struct OutputSequencer {
	next:               u64,
	events:             flume::Sender<ExecEvent>,
	at_line_start:      bool,
	sandbox_diagnostic: Option<Vec<u8>>,
}
impl OutputSequencer {
	fn capture_sandbox_diagnostic(&mut self, data: &[u8]) {
		let Some(diagnostic) = self.sandbox_diagnostic.as_mut() else {
			return;
		};
		if shell_write_denied_path(diagnostic).is_some()
			|| sandbox_denial_marker(diagnostic).is_some()
		{
			return;
		}
		diagnostic.extend_from_slice(data);
		if shell_write_denied_path(diagnostic).is_none()
			&& sandbox_denial_marker(diagnostic).is_none()
			&& diagnostic.len() > SANDBOX_DIAGNOSTIC_BYTES
		{
			let discard = diagnostic.len() - SANDBOX_DIAGNOSTIC_BYTES;
			diagnostic.drain(..discard);
		}
	}

	fn sandbox_note(&mut self, exec: &Bytes, note: &str) {
		let mut data = Vec::with_capacity(note.len() + usize::from(!self.at_line_start) + 1);
		if !self.at_line_start {
			data.push(b'\n');
		}
		data.extend_from_slice(note.as_bytes());
		data.push(b'\n');
		let _ = self.events.send(ExecEvent::Output(OutputFrame {
			exec: exec.clone(),
			channel: OutputChannel::Stderr as i32,
			data: Bytes::from(data),
			sequence: self.next,
			..OutputFrame::default()
		}));
		self.next += 1;
	}
}

fn spawn_reader<R: Read + Send + 'static>(
	mut reader: R,
	channel: OutputChannel,
	exec: Bytes,
	sequencer: Arc<Mutex<OutputSequencer>>,
) -> task::JoinHandle<()> {
	task::spawn_blocking(move || {
		let mut buffer = vec![0_u8; OUTPUT_CHUNK_BYTES];
		loop {
			let read = match read_chunk(&mut reader, &mut buffer) {
				Ok(0) | Err(_) => break,
				Ok(read) => read,
			};
			let mut sequencer = sequencer.lock();
			sequencer.at_line_start = buffer[read - 1] == b'\n';
			if matches!(channel, OutputChannel::Stderr | OutputChannel::Pty) {
				sequencer.capture_sandbox_diagnostic(&buffer[..read]);
			}
			let frame = OutputFrame {
				exec:     exec.clone(),
				channel:  channel as i32,
				data:     Bytes::copy_from_slice(&buffer[..read]),
				sequence: sequencer.next,
				props:    Default::default(),
			};
			sequencer.next += 1;
			let event = ExecEvent::Output(frame);
			let _ = sequencer.events.send(event);
		}
	})
}

fn read_chunk(reader: &mut impl Read, buffer: &mut [u8]) -> io::Result<usize> {
	loop {
		match reader.read(buffer) {
			Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
			result => return result,
		}
	}
}

async fn resume_recovered_readiness(process: Arc<NamedProcess>) {
	let probes = process.ready.to_vec();
	let passed = try_join_all(
		probes
			.into_iter()
			.map(|probe| wait_ready_probe(process.clone(), probe)),
	)
	.await
	.is_ok();
	if !passed || process.control.finished.load(Ordering::Acquire) {
		return;
	}
	let mut stream = process.stream.lock();
	if stream.info.state != ProcessState::Starting as i32 {
		return;
	}
	stream.info.state = ProcessState::Ready as i32;
	stream.info.ready_pending.clear();
	let info = stream.info.clone();
	stream.broadcast(ProcessEvent::State(info));
	drop(stream);
	if let Some(host) = process.host.upgrade() {
		let _ = ExecHost { inner: host }.persist_process(&process, ProcessPhase::Running);
	}
}

fn close_private_session(process: &NamedProcess) {
	let Some(session) = process.private_session.lock().take() else {
		return;
	};
	if let Some(host) = process.host.upgrade() {
		host.sessions.lock().remove(&session);
	}
}

fn spawn_process_deadline(process: Arc<NamedProcess>) {
	let Some(timeout) = process.timeout.filter(|timeout| !timeout.is_zero()) else {
		return;
	};
	let cancelled = process.deadline_cancel.clone();
	tokio::spawn(async move {
		tokio::select! {
			() = time::sleep(timeout) => {
				if !process.control.finished.load(Ordering::Acquire) {
					process.timed_out.store(true, Ordering::Release);
					process.control.cancel(CANCEL_GRACE);
				}
			},
			() = cancelled.cancelled() => {},
		}
	});
}

fn spawn_detached_monitor(
	process: Arc<NamedProcess>,
	mut child: Option<process::Child>,
	cancel_rx: Receiver<CancelRequest>,
) {
	let runtime = runtime::Handle::current();
	task::spawn_blocking(move || {
		let mut cancelled = false;
		let exit_code = loop {
			if let Ok(cancel) = cancel_rx.try_recv() {
				cancelled = true;
				let _ = process.control.spawns.signal(ProcessSignal::Terminate);
				thread::sleep(cancel.grace);
				let _ = process.control.spawns.signal(ProcessSignal::Kill);
			}
			let status = if let Some(child) = child.as_mut() {
				child.try_wait().ok().flatten().map(|status| status.code())
			} else if process.identity.verify().unwrap_or(false) {
				None
			} else {
				Some(None)
			};
			let chunk = { process.log.lock().poll_external() };
			if let Ok(Some(chunk)) = chunk {
				route_log_chunk(&process, chunk);
				if let Some(host) = process.host.upgrade() {
					let phase = phase_for_state(process.stream.lock().info.state);
					let _ = ExecHost { inner: host }.persist_process(&process, phase);
				}
			}
			if let Some(code) = status {
				break code;
			}
			thread::sleep(Duration::from_millis(100));
		};
		process.control.finished.store(true, Ordering::Release);
		runtime.spawn(async move {
			let timed_out = process.timed_out.load(Ordering::Acquire);
			settle_named_process(process, exit_code, cancelled && !timed_out, timed_out);
		});
	});
}

fn settle_named_process(
	process: Arc<NamedProcess>,
	exit_code: Option<i32>,
	cancelled: bool,
	timed_out: bool,
) {
	process.deadline_cancel.cancel();
	close_private_session(&process);
	let Some(inner) = process.host.upgrade() else {
		return;
	};
	let host = ExecHost { inner };
	let current = host
		.inner
		.processes
		.lock()
		.get(&process.name)
		.is_some_and(|current| Arc::ptr_eq(current, &process));
	if !current || process_state_is_terminal(process.stream.lock().info.state) {
		return;
	}
	let failed = timed_out || exit_code.is_none_or(|code| code != 0) && !cancelled;
	let uptime = process.started_at.elapsed();
	let restart_delay = if process.stopping.load(Ordering::Acquire) || cancelled {
		None
	} else {
		process.restarts.lock().decide(failed, uptime, exit_code)
	};
	{
		let supervisor = process.restarts.lock();
		let mut stream = process.stream.lock();
		stream.info.restart_count = supervisor.restart_count;
		stream.info.consecutive_failures = supervisor.consecutive_failures;
		stream.info.status = Some(if timed_out {
			RunTerminal::Timeout.status(uptime)
		} else if cancelled {
			RunTerminal::Cancelled.status(uptime)
		} else {
			exit_code
				.map_or(RunTerminal::Failed, RunTerminal::Exited)
				.status(uptime)
		});
		stream.info.state = if timed_out {
			ProcessState::Failed as i32
		} else if cancelled {
			ProcessState::Stopped as i32
		} else if failed {
			ProcessState::Failed as i32
		} else {
			ProcessState::Exited as i32
		};
		stream.info.ready_pending.clear();
		stream.info.endpoint = None;
		let info = stream.info.clone();
		stream.broadcast(ProcessEvent::State(info));
	}
	let phase = if timed_out {
		ProcessPhase::Failed
	} else if cancelled {
		ProcessPhase::Stopped
	} else if failed {
		ProcessPhase::Failed
	} else {
		ProcessPhase::Exited
	};
	let _ = host.persist_process(&process, phase);
	let Some(delay) = restart_delay else {
		return;
	};
	let record = host.persisted_record(&process.name);
	let spec = process.spec.clone();
	let ready = process.ready.to_vec();
	let name = process.name.clone();
	let generation = process.generation.saturating_add(1);
	let detached = process.detached;
	let timeout = process.timeout;
	tokio::spawn(async move {
		time::sleep(delay).await;
		if process.stopping.load(Ordering::Acquire) {
			return;
		}
		let Ok((_reservation, current)) = host.reserve_process_generation(&name, process.generation)
		else {
			return;
		};
		if !Arc::ptr_eq(&current, &process) {
			return;
		}
		if detached {
			let _ = host
				.launch_detached(name, spec, ready, generation, record.as_ref(), timeout)
				.await;
		} else {
			let _ = host
				.launch_attached(name, spec, ready, generation, record.as_ref(), timeout)
				.await;
		}
	});
}

async fn wait_process_finished(process: &NamedProcess) -> Result<(), ExecError> {
	let wait = async {
		while !process.control.finished.load(Ordering::Acquire) {
			time::sleep(Duration::from_millis(25)).await;
		}
	};
	time::timeout(CANCEL_GRACE.saturating_add(Duration::from_secs(5)), wait)
		.await
		.map_err(|_| {
			ExecError::Io(io::Error::new(
				io::ErrorKind::TimedOut,
				"named process did not stop before restart",
			))
		})
}

fn route_log_chunk(process: &NamedProcess, chunk: LogChunk) {
	if chunk.data.is_empty() {
		return;
	}
	let mut stream = process.stream.lock();
	let sequence = chunk.offset.saturating_add(chunk.data.len() as u64);
	let log = process.log.lock();
	stream.info.log_start_offset = log.start_offset();
	stream.info.log_end_offset = log.end_offset();
	let output = ProcessOutput {
		name: process.name.to_string(),
		generation: process.generation,
		channel: OutputChannel::Stdout as i32,
		data: chunk.data.into(),
		sequence,
		log_offset: chunk.offset,
		terminal_text: false,
		truncated: chunk.truncated,
		props: Default::default(),
	};
	stream.history.push(output.clone());
	trim_history(&mut stream.history);
	stream.broadcast(ProcessEvent::Output(output));
}

fn trim_history(history: &mut Vec<ProcessOutput>) {
	let mut bytes = history
		.iter()
		.map(|output| output.data.len())
		.sum::<usize>();
	let mut remove = 0;
	while bytes > process_log::MAX_LOG_READ_BYTES as usize && remove < history.len() {
		bytes = bytes.saturating_sub(history[remove].data.len());
		remove += 1;
	}
	if remove > 0 {
		history.drain(..remove);
	}
}

fn ready_condition_names(ready: &[ReadyProbe]) -> Vec<String> {
	ready
		.iter()
		.filter_map(|probe| match probe.probe.as_ref() {
			Some(ready_probe::Probe::Log(_)) => Some(String::from("log")),
			Some(ready_probe::Probe::Tcp(_)) => Some(String::from("port")),
			Some(ready_probe::Probe::Ping(_)) => Some(String::from("ping")),
			None => None,
		})
		.collect()
}

fn process_info_from_record(record: &ProcessRecord) -> ProcessInfo {
	let props = ProcessSpec::decode(record.spec_wire.as_slice())
		.ok()
		.and_then(|spec| spec.props);
	let state = match record.phase {
		ProcessPhase::Starting | ProcessPhase::WaitingReady => ProcessState::Starting,
		ProcessPhase::Running => ProcessState::Running,
		ProcessPhase::Exited => ProcessState::Exited,
		ProcessPhase::Stopped => ProcessState::Stopped,
		ProcessPhase::Failed => ProcessState::Failed,
	};
	ProcessInfo {
		name: record.name.to_string(),
		generation: record.generation,
		state: state as i32,
		identity: Some(record.identity.to_wire()),
		log_start_offset: record.log_start_offset,
		log_end_offset: record.log_end_offset,
		restart_count: record.restart_count,
		consecutive_failures: record.consecutive_failures,
		props,
		..ProcessInfo::default()
	}
}

fn phase_for_state(state: i32) -> ProcessPhase {
	match ProcessState::try_from(state) {
		Ok(ProcessState::Starting) => ProcessPhase::WaitingReady,
		Ok(ProcessState::Ready | ProcessState::Running) => ProcessPhase::Running,
		Ok(ProcessState::Stopped) => ProcessPhase::Stopped,
		Ok(ProcessState::Exited) => ProcessPhase::Exited,
		_ => ProcessPhase::Failed,
	}
}

#[cfg(all(unix, not(target_os = "android")))]
fn detached_command(source: &str, sandbox: Option<&ExecSandbox>) -> Command {
	let args = [OsStr::new("-lc"), OsStr::new(source)];
	let mut command = sandbox.map_or_else(
		|| Command::new("/bin/sh"),
		|sandbox| sandbox.command(OsStr::new("/bin/sh"), &args),
	);
	if sandbox.is_none() {
		command.args(args);
	}
	command
}
#[cfg(target_os = "android")]
fn detached_command(source: &str, sandbox: Option<&ExecSandbox>) -> Command {
	let args = [OsStr::new("-lc"), OsStr::new(source)];
	let mut command = sandbox
		.map_or_else(|| Command::new("sh"), |sandbox| sandbox.command(OsStr::new("sh"), &args));
	if sandbox.is_none() {
		command.args(args);
	}
	command
}

#[cfg(windows)]
fn detached_command(source: &str, sandbox: Option<&ExecSandbox>) -> Command {
	let args = [OsStr::new("/d"), OsStr::new("/s"), OsStr::new("/c"), OsStr::new(source)];
	let mut command = sandbox.map_or_else(
		|| Command::new("cmd.exe"),
		|sandbox| sandbox.command(OsStr::new("cmd.exe"), &args),
	);
	if sandbox.is_none() {
		command.args(args);
	}
	command
}

#[cfg(unix)]
fn configure_detached_group(command: &mut Command) {
	use std::os::unix::process::CommandExt as _;
	command.process_group(0);
}

#[cfg(windows)]
fn configure_detached_group(command: &mut Command) {
	use std::os::windows::process::CommandExt as _;

	use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};
	command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

fn unix_time_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX)
}

async fn wait_ready_probe(process: Arc<NamedProcess>, probe: ReadyProbe) -> Result<(), ExecError> {
	let timeout = Duration::from_millis(probe.timeout_ms);
	match probe.probe {
		Some(ready_probe::Probe::Log(log)) => {
			let pattern = Regex::new(&log.pattern)
				.map_err(|error| ExecError::Readiness(Str::from(error.to_string())))?;
			let (backlog, events) = readiness_events(&process);
			let wait = async {
				let mut output = Vec::new();
				for frame in backlog {
					output.extend_from_slice(&frame.data);
					trim_readiness_window(&mut output);
				}
				if let Some(matched) = pattern.find(&output) {
					record_ready_match(&process, &output[matched.start()..matched.end()]);
					return Ok(());
				}
				while let Ok(event) = events.recv_async().await {
					match event {
						ProcessEvent::Output(frame) => {
							output.extend_from_slice(&frame.data);
							trim_readiness_window(&mut output);
							if let Some(matched) = pattern.find(&output) {
								record_ready_match(&process, &output[matched.start()..matched.end()]);
								return Ok(());
							}
						},
						ProcessEvent::State(info) if process_state_is_terminal(info.state) => {
							return Err(ExecError::Readiness(sf!(
								"process exited before its log probe passed",
							)));
						},
						_ => {},
					}
				}
				Err(ExecError::Readiness(sf!("process output closed before its log probe passed",)))
			};
			time::timeout(timeout, wait)
				.await
				.map_err(|_| ExecError::Readiness(sf!("log probe timed out")))?
		},
		Some(ready_probe::Probe::Tcp(tcp)) => {
			let port = u16::try_from(tcp.port)
				.map_err(|_| ExecError::Readiness(sf!("TCP probe port is out of range")))?;
			let wait = async {
				loop {
					if process.control.finished.load(Ordering::Acquire) {
						return Err(ExecError::Readiness(sf!(
							"process exited before its TCP probe passed",
						)));
					}
					if TcpStream::connect((tcp.host.as_str(), port)).await.is_ok() {
						record_tcp_ready(&process, &tcp.host, tcp.port);
						return Ok(());
					}
					time::sleep(Duration::from_millis(50)).await;
				}
			};
			time::timeout(timeout, wait)
				.await
				.map_err(|_| ExecError::Readiness(sf!("TCP probe timed out")))?
		},
		Some(ready_probe::Probe::Ping(ping)) => {
			let (_, events) = readiness_events(&process);
			let encoded = HostFrame {
				request_id: 0,
				body:       Some(host_frame::Body::Ping(Ping { nonce: ping.nonce, props: None })),
				props:      None,
			}
			.encode_length_delimited_to_vec();
			write_input(&process.control, Some(&encoded))?;
			let wait = async {
				let mut output = BytesMut::new();
				while let Ok(event) = events.recv_async().await {
					match event {
						ProcessEvent::Output(frame) if frame.channel != OutputChannel::Stderr as i32 => {
							output.extend_from_slice(&frame.data);
							while let Some(worker) = take_worker_frame(&mut output)? {
								if matches!(
									  &worker.body,
									  Some(worker_frame::Body::Pong(pong)) if pong.nonce == ping.nonce
								) {
									clear_ready_pending(&process, "ping");
									return Ok(());
								}
							}
						},
						ProcessEvent::State(info) if process_state_is_terminal(info.state) => {
							return Err(ExecError::Readiness(sf!(
								"process exited before its Ping probe passed",
							)));
						},
						_ => {},
					}
				}
				Err(ExecError::Readiness(sf!("process output closed before its Ping probe passed",)))
			};
			time::timeout(timeout, wait)
				.await
				.map_err(|_| ExecError::Readiness(sf!("Ping probe timed out")))?
		},
		None => Err(ExecError::Readiness(sf!("readiness probe has no kind"))),
	}
}

fn trim_readiness_window(output: &mut Vec<u8>) {
	const WINDOW: usize = 64 * 1024;
	if output.len() > WINDOW {
		output.drain(..output.len() - WINDOW);
	}
}

fn record_ready_match(process: &NamedProcess, matched: &[u8]) {
	let matched = &matched[..matched.len().min(500)];
	let mut stream = process.stream.lock();
	stream.info.ready_match = String::from_utf8_lossy(matched).into_owned();
	stream.info.ready_pending.retain(|pending| pending != "log");
	let info = stream.info.clone();
	stream.broadcast(ProcessEvent::State(info));
}

fn clear_ready_pending(process: &NamedProcess, condition: &str) {
	let mut stream = process.stream.lock();
	stream
		.info
		.ready_pending
		.retain(|pending| pending != condition);
	let info = stream.info.clone();
	stream.broadcast(ProcessEvent::State(info));
}

fn record_tcp_ready(process: &NamedProcess, host: &str, port: u32) {
	let loopback = host.eq_ignore_ascii_case("localhost")
		|| host
			.parse::<net::IpAddr>()
			.is_ok_and(|address| address.is_loopback());
	let endpoint = loopback.then(|| {
		let authority = if host.contains(':') && !host.starts_with('[') {
			format!("[{host}]:{port}")
		} else {
			format!("{host}:{port}")
		};
		format!("tcp://{authority}")
	});
	let mut stream = process.stream.lock();
	if endpoint.is_some() {
		stream.info.endpoint = endpoint;
	}
	stream
		.info
		.ready_pending
		.retain(|pending| pending != "port");
	let info = stream.info.clone();
	stream.broadcast(ProcessEvent::State(info));
}

fn readiness_events(process: &NamedProcess) -> (Vec<ProcessOutput>, Receiver<ProcessEvent>) {
	let (sender, receiver) = flume::unbounded();
	let mut stream = process.stream.lock();
	let backlog = stream.history.clone();
	stream.subscribers.push(sender);
	(backlog, receiver)
}

fn process_state_is_terminal(state: i32) -> bool {
	matches!(
		ProcessState::try_from(state),
		Ok(ProcessState::Exited | ProcessState::Stopped | ProcessState::Failed)
	)
}

fn take_worker_frame(buffer: &mut BytesMut) -> Result<Option<WorkerFrame>, ExecError> {
	let mut length = 0_u64;
	let mut prefix = None;
	for (index, byte) in buffer.iter().copied().take(10).enumerate() {
		if index == 9 && byte > 1 {
			return Err(ExecError::Readiness(sf!("Ping probe received an invalid frame length",)));
		}
		length |= u64::from(byte & 0x7f) << (index * 7);
		if byte & 0x80 == 0 {
			prefix = Some(index + 1);
			break;
		}
	}
	let Some(prefix) = prefix else {
		if buffer.len() >= 10 {
			return Err(ExecError::Readiness(sf!("Ping probe received an invalid frame length",)));
		}
		return Ok(None);
	};
	let length = usize::try_from(length)
		.map_err(|_| ExecError::Readiness(sf!("Ping probe frame is too large")))?;
	let total = prefix
		.checked_add(length)
		.ok_or_else(|| ExecError::Readiness(sf!("Ping probe frame length overflow")))?;
	if buffer.len() < total {
		return Ok(None);
	}
	let mut framed = buffer.split_to(total);
	framed.advance(prefix);
	WorkerFrame::decode(framed)
		.map(Some)
		.map_err(|error| ExecError::Readiness(Str::from(error.to_string())))
}

async fn forward_named_process(process: Arc<NamedProcess>, run: ExecRun, _exec: Bytes) {
	while let Some(event) = run.next_event().await {
		match event {
			ExecEvent::Exit(exit) => {
				let status = exit.status.as_ref();
				let exit_code = status.and_then(|status| status.exit_code);
				let cancelled =
					status.is_some_and(|status| status.outcome == ExecOutcome::Cancelled as i32);
				let timed_out =
					status.is_some_and(|status| status.outcome == ExecOutcome::Timeout as i32);
				settle_named_process(process, exit_code, cancelled, timed_out);
				break;
			},
			event => route_named_event(&process, event),
		}
	}
}

fn route_named_event(process: &NamedProcess, event: ExecEvent) {
	match event {
		ExecEvent::Started { .. } => {},
		ExecEvent::Output(output) => {
			let terminal_text = output.channel == OutputChannel::Pty as i32;
			let log_offset = match process.log.lock().append(&output.data) {
				Ok(offset) => offset,
				Err(_) => return,
			};
			let mut stream = process.stream.lock();
			let log = process.log.lock();
			stream.info.log_start_offset = log.start_offset();
			stream.info.log_end_offset = log.end_offset();
			drop(log);
			let output = ProcessOutput {
				name: process.name.to_string(),
				generation: process.generation,
				channel: output.channel,
				sequence: log_offset.saturating_add(output.data.len() as u64),
				data: output.data,
				log_offset,
				terminal_text,
				truncated: false,
				props: Default::default(),
			};
			stream.history.push(output.clone());
			trim_history(&mut stream.history);
			stream.broadcast(ProcessEvent::Output(output));
			drop(stream);
			if let Some(host) = process.host.upgrade() {
				let host = ExecHost { inner: host };
				let phase = phase_for_state(process.stream.lock().info.state);
				let _ = host.persist_process(process, phase);
			}
		},
		ExecEvent::Exit(exit) => {
			let mut stream = process.stream.lock();
			stream.info.status = exit.status;
			stream.info.state = match stream.info.status.as_ref().map(|status| status.outcome) {
				Some(value) if value == ExecOutcome::Exited as i32 => ProcessState::Exited as i32,
				Some(value) if value == ExecOutcome::Cancelled as i32 => ProcessState::Stopped as i32,
				_ => ProcessState::Failed as i32,
			};
			let info = stream.info.clone();
			drop(process.control.input.lock());
			stream.broadcast(ProcessEvent::State(info));
			let phase = phase_for_state(stream.info.state);
			drop(stream);
			if let Some(host) = process.host.upgrade() {
				let _ = ExecHost { inner: host }.persist_process(process, phase);
			}
		},
	}
}

impl ProcessStreamState {
	fn broadcast(&mut self, event: ProcessEvent) {
		self
			.subscribers
			.retain(|subscriber| subscriber.send(event.clone()).is_ok());
	}
}

pub(crate) fn set_run_environment(request: &mut ExecRequest, delta: EnvironmentDelta) {
	if delta.set.is_empty() && delta.unset.is_empty() {
		return;
	}
	let mut fields = delta
		.set
		.into_iter()
		.map(|(name, value)| (name, WireValue { kind: Some(wire_value::Kind::String(value)) }))
		.collect::<BTreeMap<_, _>>();
	fields.extend(
		delta
			.unset
			.into_iter()
			.map(|name| (name, WireValue { kind: Some(wire_value::Kind::Null(true)) })),
	);
	request
		.props
		.get_or_insert_default()
		.fields
		.insert(String::from(RUN_ENVIRONMENT_PROP), WireValue {
			kind: Some(wire_value::Kind::Map(WireValueMap { fields })),
		});
}

fn take_run_environment(request: &mut ExecRequest) -> Result<Option<EnvironmentDelta>, ExecError> {
	let Some(value) = request
		.props
		.as_mut()
		.and_then(|props| props.fields.remove(RUN_ENVIRONMENT_PROP))
	else {
		return Ok(None);
	};
	let Some(wire_value::Kind::Map(values)) = value.kind else {
		return Err(ExecError::InvalidRunEnvironment);
	};
	let mut set = BTreeMap::new();
	let mut unset = Vec::new();
	for (name, value) in values.fields {
		match value.kind {
			Some(wire_value::Kind::String(value)) => {
				set.insert(name, value);
			},
			Some(wire_value::Kind::Null(_)) => unset.push(name),
			_ => return Err(ExecError::InvalidRunEnvironment),
		}
	}
	Ok(Some(EnvironmentDelta { set, unset, props: None }))
}

fn apply_run_environment_delta(
	shell: &mut Shell,
	delta: &EnvironmentDelta,
) -> Result<(), omp_shell_engine::Error> {
	for name in &delta.unset {
		let mut variable = ShellVariable::new(ShellValue::Unset(ShellValueUnsetType::Untyped));
		variable.export();
		shell
			.env_mut()
			.add(name.clone(), variable, EnvironmentScope::Command)?;
	}
	for (name, value) in &delta.set {
		let mut variable = ShellVariable::new(value.clone());
		variable.export();
		shell
			.env_mut()
			.add(name.clone(), variable, EnvironmentScope::Command)?;
	}
	Ok(())
}

fn apply_env_delta(
	shell: &mut Shell,
	delta: Option<&EnvironmentDelta>,
) -> Result<(), omp_shell_engine::Error> {
	let Some(delta) = delta else { return Ok(()) };
	for name in &delta.unset {
		shell.env_mut().unset(name)?;
	}
	for (name, value) in &delta.set {
		let mut variable = ShellVariable::new(value.clone());
		variable.export();
		shell.set_env_global(name, variable)?;
	}
	Ok(())
}

fn read_workspace_environment() -> WorkspaceEnvironment {
	let mut variables: Vec<_> = env::vars_os()
		.filter_map(|(name, value)| {
			Some((Str::from(name.into_string().ok()?), Str::from(value.into_string().ok()?)))
		})
		.collect();
	variables.sort_unstable_by(|left, right| left.0.cmp(&right.0));
	let mut hasher = Hash32::hasher();
	for (name, value) in &variables {
		let name = name.as_bytes();
		let value = value.as_bytes();
		hasher.update((name.len() as u64).to_be_bytes());
		hasher.update(name);
		hasher.update((value.len() as u64).to_be_bytes());
		hasher.update(value);
	}
	WorkspaceEnvironment {
		variables: variables.into(),
		digest:    WorkspaceEnvironmentDigest(hasher.finalize()),
	}
}

fn github_repository(cwd: &Path) -> Option<Str> {
	if let Ok(repo) = env::var("GH_REPO")
		&& let Some(repo) = github_repo_from_remote(&repo)
	{
		return Some(repo);
	}
	for ancestor in cwd.ancestors() {
		let config = ancestor.join(".git/config");
		let Ok(contents) = fs::read_to_string(config) else {
			continue;
		};
		let mut origin = false;
		for line in contents.lines() {
			let line = line.trim();
			if line.starts_with('[') {
				origin = line == r#"[remote "origin"]"#;
				continue;
			}
			if origin
				&& let Some(remote) = line
					.strip_prefix("url")
					.and_then(|line| line.trim_start().strip_prefix('='))
				&& let Some(repo) = github_repo_from_remote(remote.trim())
			{
				return Some(repo);
			}
		}
	}
	None
}

fn github_repo_from_remote(remote: &str) -> Option<Str> {
	let path = remote
		.strip_prefix("git@github.com:")
		.or_else(|| remote.strip_prefix("https://github.com/"))
		.or_else(|| remote.strip_prefix("http://github.com/"))
		.or_else(|| remote.strip_prefix("ssh://git@github.com/"))?
		.trim_end_matches('/')
		.trim_end_matches(".git");
	let mut parts = path.split('/');
	let owner = parts.next()?;
	let repo = parts.next()?;
	if parts.next().is_some()
		|| owner.is_empty()
		|| repo.is_empty()
		|| !owner
			.bytes()
			.chain(repo.bytes())
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
	{
		return None;
	}
	Some(sf!("{owner}/{repo}"))
}

fn simple_cd(command: &str) -> bool {
	let command = command.trim();
	command.strip_prefix("cd").is_some_and(|rest| {
		rest.starts_with(char::is_whitespace)
			&& !rest
				.chars()
				.any(|character| matches!(character, '\n' | ';' | '&' | '|' | '<' | '>'))
	})
}

fn user_shell_command(shell: &UserShell, command: &str) -> Str {
	let mut rendered = String::new();
	push_shell_word(&mut rendered, &shell.executable);
	for argument in shell.args.iter() {
		rendered.push(' ');
		push_shell_word(&mut rendered, argument);
	}
	if shell.login {
		rendered.push_str(" -l");
	}
	rendered.push_str(" -c ");
	push_shell_word(&mut rendered, command);
	Str::new(rendered)
}

fn push_shell_word(output: &mut String, word: &str) {
	output.push('\'');
	for part in word.split('\'') {
		if !output.ends_with('\'') {
			output.push_str("'\\''");
		}
		output.push_str(part);
	}
	output.push('\'');
}

fn cwd_from_uri(uri: &str) -> Result<Option<PathBuf>, ExecError> {
	if uri.is_empty() {
		return Ok(None);
	}
	if !uri.contains("://") {
		return Ok(Some(PathBuf::from(uri)));
	}
	let parsed = Url::parse(uri).map_err(|_| ExecError::InvalidCwd(Str::from(uri)))?;
	parsed
		.to_file_path()
		.map(Some)
		.map_err(|()| ExecError::InvalidCwd(Str::from(uri)))
}

fn parse_signal(name: &str) -> Result<ProcessSignal, ExecError> {
	let normalized = name.to_ascii_uppercase();
	let normalized = normalized.strip_prefix("SIG").unwrap_or(&normalized);
	match normalized {
		"HUP" => Ok(ProcessSignal::Hangup),
		"INT" => Ok(ProcessSignal::Interrupt),
		"QUIT" => Ok(ProcessSignal::Quit),
		"TERM" => Ok(ProcessSignal::Terminate),
		"KILL" => Ok(ProcessSignal::Kill),
		"USR1" => Ok(ProcessSignal::User1),
		"USR2" => Ok(ProcessSignal::User2),
		"CONT" => Ok(ProcessSignal::Continue),
		"STOP" => Ok(ProcessSignal::Stop),
		"WINCH" => Ok(ProcessSignal::WindowChanged),
		_ => Err(ExecError::UnsupportedSignal(Str::from(name))),
	}
}

fn resize_fd(fd: fd::BorrowedFd<'_>, rows: u32, columns: u32) -> Result<(), ExecError> {
	let winsize = libc::winsize {
		ws_row:    clamp_u16(rows),
		ws_col:    clamp_u16(columns),
		ws_xpixel: 0,
		ws_ypixel: 0,
	};
	// SAFETY: fd is a live PTY master and the pointer references a valid winsize.
	let result = unsafe { libc::ioctl(fd.as_raw_fd(), libc::TIOCSWINSZ, &winsize) };
	if result == -1 {
		return Err(ExecError::Io(io::Error::last_os_error()));
	}
	Ok(())
}

fn clamp_u16(value: u32) -> u16 {
	value.min(u32::from(u16::MAX)) as u16
}

fn shell_error(error: omp_shell_engine::Error) -> ExecError {
	ExecError::Shell(Str::from(error.to_string()))
}

fn errno_io(error: Errno) -> ExecError {
	ExecError::Io(io::Error::from_raw_os_error(error as i32))
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn spawn_book_scopes_process_authority_to_observed_children() {
		let book = SpawnBook {
			groups:  Mutex::new(Vec::new()),
			pids:    Mutex::new(Vec::new()),
			session: None,
		};
		book.on_spawn(41_001, Some(41_000));
		assert!(book.may_signal(41_001));
		assert!(book.may_observe(41_000));
		assert!(book.may_signal(-41_000));
		assert!(!book.may_observe(41_002));
		assert!(!book.may_signal(process::id() as i32));
		let session = Arc::new(SpawnBook {
			groups:  Mutex::new(Vec::new()),
			pids:    Mutex::new(Vec::new()),
			session: None,
		});
		session.on_spawn(42_001, Some(42_000));
		let next_run = SpawnBook {
			groups:  Mutex::new(Vec::new()),
			pids:    Mutex::new(Vec::new()),
			session: Some(session),
		};
		assert!(next_run.may_observe(42_001));
	}

	#[test]
	fn sandbox_denial_classification_is_typed_and_conservative() {
		let denied_path = PathBuf::from("/private/blocked");
		let write_error: omp_shell_engine::Error =
			omp_shell_engine::WriteDenied { path: denied_path.clone() }.into();
		let denial = classify_sandbox_denial(true, &RunTerminal::Failed, Some(&write_error), b"")
			.expect("typed write denial");
		assert_eq!(denial.path, Str::from(denied_path.to_string_lossy().as_ref()));
		assert_eq!(denial.exit_code, None);

		let denial = classify_sandbox_denial(
			true,
			&RunTerminal::Exited(2),
			None,
			b"env/v1 exec: sandbox denied write to /private/handled\n",
		)
		.expect("shell-handled typed write denial");
		assert_eq!(denial.path, "/private/handled");
		assert_eq!(denial.exit_code, Some(2));

		let denial = classify_sandbox_denial(
			true,
			&RunTerminal::Exited(1),
			None,
			b"touch: /private/blocked: Operation not permitted\n",
		)
		.expect("EPERM-shaped stderr");
		assert_eq!(denial.path, "/private/blocked");
		assert_eq!(denial.exit_code, Some(1));

		assert!(
			classify_sandbox_denial(
				false,
				&RunTerminal::Exited(1),
				None,
				b"touch: /private/blocked: Operation not permitted",
			)
			.is_none()
		);
		assert!(classify_sandbox_denial(true, &RunTerminal::Exited(0), None, b"EPERM",).is_none());
		assert!(
			classify_sandbox_denial(true, &RunTerminal::Exited(1), None, b"permission denied",)
				.is_none()
		);
		assert!(
			classify_sandbox_denial(true, &RunTerminal::Exited(1), None, b"NOT_EPERMISSION",)
				.is_none()
		);
	}

	#[test]
	fn terminal_receipts_distinguish_exit_failure_timeout_and_cancellation() {
		let success = RunTerminal::Exited(0).status(Duration::from_millis(1));
		assert_eq!(success.outcome, ExecOutcome::Exited as i32);
		assert_eq!(success.exit_code, Some(0));
		assert!(success.signal.is_empty());
		assert!(!success.aborted);

		let failure = RunTerminal::Exited(17).status(Duration::from_millis(2));
		assert_eq!(failure.outcome, ExecOutcome::Failed as i32);
		assert_eq!(failure.exit_code, Some(17));
		assert!(failure.signal.is_empty());
		assert!(!failure.aborted);

		let timeout = RunTerminal::Timeout.status(Duration::from_millis(3));
		assert_eq!(timeout.outcome, ExecOutcome::Timeout as i32);
		assert_eq!(timeout.exit_code, None);
		assert_eq!(timeout.signal, "SIGKILL");
		assert!(timeout.aborted);

		let cancelled = RunTerminal::Cancelled.status(Duration::from_millis(4));
		assert_eq!(cancelled.outcome, ExecOutcome::Cancelled as i32);
		assert_eq!(cancelled.exit_code, None);
		assert_eq!(cancelled.signal, "");
		assert!(cancelled.aborted);

		let denied = RunTerminal::Denied { exit_code: Some(1), path: sf!("/private/blocked") }
			.status(Duration::from_millis(5));
		assert_eq!(denied.outcome, ExecOutcome::Denied as i32);
		assert_eq!(denied.exit_code, Some(1));
		assert_eq!(
			denied
				.props
				.as_ref()
				.and_then(|props| props.fields.get(SANDBOX_DENIED_PATH_PROP))
				.and_then(|value| value.kind.as_ref()),
			Some(&wire_value::Kind::String(String::from("/private/blocked")))
		);
	}

	async fn run_output(host: &ExecHost, request: ExecRequest) -> Vec<u8> {
		let (_, run) = host.exec(request, None).await.expect("exec starts");
		let mut output = Vec::new();
		loop {
			match run.next_event().await {
				Some(ExecEvent::Output(frame)) => output.extend_from_slice(&frame.data),
				Some(ExecEvent::Exit(event)) => {
					let status = event.status.expect("exit status");
					assert_eq!(status.outcome, ExecOutcome::Exited as i32);
					assert_eq!(status.exit_code, Some(0));
					return output;
				},
				Some(ExecEvent::Started { .. }) => {},
				None => panic!("exec event stream closed before exit"),
			}
		}
	}
	async fn run_exit_code(host: &ExecHost, request: ExecRequest) -> Option<i32> {
		let (_, run) = host.exec(request, None).await.expect("exec starts");
		loop {
			match run.next_event().await {
				Some(ExecEvent::Output(_) | ExecEvent::Started { .. }) => {},
				Some(ExecEvent::Exit(event)) => return event.status.expect("exit status").exit_code,
				None => panic!("exec event stream closed before exit"),
			}
		}
	}
	async fn run_failure(host: &ExecHost, request: ExecRequest) -> (i32, Option<i32>, Vec<u8>) {
		let (_, run) = host.exec(request, None).await.expect("exec starts");
		let mut output = Vec::new();
		loop {
			match run.next_event().await {
				Some(ExecEvent::Output(frame)) => output.extend_from_slice(&frame.data),
				Some(ExecEvent::Exit(event)) => {
					let status = event.status.expect("exit status");
					return (status.outcome, status.exit_code, output);
				},
				Some(ExecEvent::Started { .. }) => {},
				None => panic!("exec event stream closed before exit"),
			}
		}
	}

	fn script_request(session: &Bytes, text: &str) -> ExecRequest {
		ExecRequest {
			session: session.clone(),
			source: Some(v1::Script { text: text.to_owned(), ..Default::default() }),
			..Default::default()
		}
	}

	/// Live proof for both enforcement lanes: the Seatbelt launcher confines
	/// external commands while the in-process write policy covers redirections,
	/// with the `.git` carve-out denied and secret-shaped names filtered from
	/// child environments.
	#[cfg(target_os = "macos")]
	#[tokio::test]
	async fn sandboxed_session_enforces_kernel_and_software_write_lanes() {
		if !omp_sandbox::backend_status(omp_sandbox::Backend::Seatbelt).is_available() {
			return;
		}
		let root = tempfile::tempdir().unwrap();
		let workspace = root.path().canonicalize().unwrap();
		fs::create_dir(workspace.join(".git")).unwrap();
		let host = ExecHost::new();
		host.configure_sandbox(
			&crate::exec_settings::SandboxSettings {
				mode: crate::exec_settings::ExecSandboxMode::WorkspaceWrite,
				..Default::default()
			},
			&workspace,
		);
		let opened = host
			.open_session(OpenSessionRequest {
				cwd_uri: Url::from_directory_path(&workspace).unwrap().to_string(),
				env_delta: Some(EnvironmentDelta {
					set: BTreeMap::from([(String::from("MY_TOKEN"), String::from("secret"))]),
					..EnvironmentDelta::default()
				}),
				..OpenSessionRequest::default()
			})
			.await
			.expect("sandboxed session opens");
		let session = &opened.session;

		// Software lane: an in-process redirection persists inside the workspace.
		assert_eq!(
			run_exit_code(&host, script_request(session, "echo ok > allowed.txt")).await,
			Some(0)
		);
		assert_eq!(fs::read(workspace.join("allowed.txt")).unwrap(), b"ok\n");
		// Software lane: the same redirection into the carve-out is denied.
		let (outcome, exit, output) =
			run_failure(&host, script_request(session, "echo no > .git/blocked.txt")).await;
		assert_eq!(outcome, ExecOutcome::Denied as i32);
		assert_ne!(exit, Some(0));
		let output = String::from_utf8_lossy(&output);
		assert!(output.contains("sandbox denied write"));
		assert!(output.contains(".git/blocked.txt"));
		assert!(output.contains("sandbox: mode=workspace-write"));
		assert!(output.contains("network=off"));
		assert_eq!(
			output
				.matches("Seatbelt write scopes are path based")
				.count(),
			1
		);
		assert!(!workspace.join(".git/blocked.txt").exists());

		let (_, bypass) = host
			.exec_without_sandbox(script_request(session, "echo approved > .git/approved.txt"), None)
			.await
			.expect("one-shot bypass starts");
		loop {
			match bypass.next_event().await {
				Some(ExecEvent::Output(_) | ExecEvent::Started { .. }) => {},
				Some(ExecEvent::Exit(event)) => {
					let status = event.status.expect("bypass status");
					assert_eq!(status.outcome, ExecOutcome::Exited as i32);
					assert_eq!(status.exit_code, Some(0));
					break;
				},
				None => panic!("bypass event stream closed before exit"),
			}
		}
		assert_eq!(fs::read(workspace.join(".git/approved.txt")).unwrap(), b"approved\n");

		// The next ordinary command is sandboxed again.
		let (outcome, ..) =
			run_failure(&host, script_request(session, "echo no > .git/blocked-again.txt")).await;
		assert_eq!(outcome, ExecOutcome::Denied as i32);
		assert!(!workspace.join(".git/blocked-again.txt").exists());
		// A dangling redirect still resolves through its symlink into `.git`.
		std::os::unix::fs::symlink(".git/new", workspace.join("redirect")).unwrap();
		assert_ne!(
			run_exit_code(&host, script_request(session, "echo no > redirect/blocked.txt")).await,
			Some(0)
		);
		assert!(!workspace.join(".git/new/blocked.txt").exists());
		// `/dev/null` remains the one globally writable device sink.
		assert_eq!(
			run_exit_code(&host, script_request(session, "echo ok > /dev/null")).await,
			Some(0)
		);

		// Kernel lane: an external binary writes inside the workspace.
		assert_eq!(
			run_exit_code(&host, script_request(session, "/usr/bin/touch external.txt")).await,
			Some(0)
		);
		assert!(workspace.join("external.txt").exists());
		// Kernel lane: the Seatbelt profile denies the carve-out for externals.
		assert_ne!(
			run_exit_code(&host, script_request(session, "/usr/bin/touch .git/external.txt")).await,
			Some(0)
		);
		assert!(!workspace.join(".git/external.txt").exists());

		// Secret-shaped names stay visible in-shell but never reach children.
		assert_eq!(
			run_output(&host, script_request(session, "printf '%s' \"$MY_TOKEN\"")).await,
			b"secret"
		);
		assert_ne!(
			run_exit_code(&host, script_request(session, "/usr/bin/printenv MY_TOKEN")).await,
			Some(0)
		);
		host.close_session(&opened.session).expect("session closes");
	}

	struct InterruptedReader {
		interrupts: usize,
		bytes:      &'static [u8],
	}

	impl Read for InterruptedReader {
		fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
			if self.interrupts > 0 {
				self.interrupts -= 1;
				return Err(io::Error::from(io::ErrorKind::Interrupted));
			}
			let length = self.bytes.len().min(buffer.len());
			buffer[..length].copy_from_slice(&self.bytes[..length]);
			self.bytes = &self.bytes[length..];
			Ok(length)
		}
	}

	#[tokio::test]
	async fn command_environment_add_and_unset_do_not_leak_to_the_next_run() {
		let host = ExecHost::new();
		let opened = host
			.open_session(OpenSessionRequest {
				env_delta: Some(EnvironmentDelta {
					set: BTreeMap::from([(String::from("OMP_RUN_UNSET"), String::from("baseline"))]),
					..EnvironmentDelta::default()
				}),
				..OpenSessionRequest::default()
			})
			.await
			.expect("session opens");

		let mut first = ExecRequest {
			session: opened.session.clone(),
			source: Some(v1::Script {
				text: String::from("printf '%s|%s' \"$OMP_RUN_ADD\" \"${OMP_RUN_UNSET-unset}\""),
				..Default::default()
			}),
			..Default::default()
		};
		set_run_environment(&mut first, EnvironmentDelta {
			set:   BTreeMap::from([(String::from("OMP_RUN_ADD"), String::from("command"))]),
			unset: vec![String::from("OMP_RUN_UNSET")],
			props: None,
		});
		assert_eq!(run_output(&host, first).await, b"command|unset");

		let second = ExecRequest {
			session: opened.session.clone(),
			source: Some(v1::Script {
				text: String::from("printf '%s|%s' \"${OMP_RUN_ADD-unset}\" \"$OMP_RUN_UNSET\""),
				..Default::default()
			}),
			..Default::default()
		};
		assert_eq!(run_output(&host, second).await, b"unset|baseline");
		host.close_session(&opened.session).expect("session closes");
	}

	#[tokio::test]
	async fn exec_session_reports_capabilities_and_revision_fenced_final_cwd() {
		let root = tempfile::tempdir().unwrap();
		let nested = root.path().join("nested");
		fs::create_dir(&nested).unwrap();
		let host = ExecHost::new();
		let opened = host
			.open_session(OpenSessionRequest {
				cwd_uri: Url::from_directory_path(root.path()).unwrap().to_string(),
				shell_profile: Some(v1::ShellProfileInput {
					profile: String::from("brush"),
					wire_revision: omp_proto::SCHEMA_REV,
					..Default::default()
				}),
				..Default::default()
			})
			.await
			.unwrap();
		let capabilities = host
			.capabilities(&ExecCapabilitiesRequest {
				session:       opened.session.clone(),
				wire_revision: omp_proto::SCHEMA_REV,
			})
			.unwrap();
		assert!(capabilities.final_cwd);
		assert!(capabilities.materialization);
		assert_eq!(capabilities.shell_profiles, [
			String::from("brush"),
			String::from("user"),
			String::from("bash"),
			String::from("zsh"),
			String::from("fish")
		]);

		let (started, run) = host
			.exec(
				ExecRequest {
					session: opened.session,
					source: Some(v1::Script { text: String::from("cd nested"), ..Default::default() }),
					..Default::default()
				},
				None,
			)
			.await
			.unwrap();
		loop {
			match run.next_event().await {
				Some(ExecEvent::Exit(_)) => break,
				Some(_) => {},
				None => panic!("exec event stream closed before exit"),
			}
		}
		let final_cwd = host
			.final_cwd(&ExecFinalCwdRequest {
				exec:              started.exec.clone(),
				expected_revision: 0,
				wire_revision:     omp_proto::SCHEMA_REV,
			})
			.unwrap();
		assert!(final_cwd.terminal);
		assert_eq!(
			Url::parse(&final_cwd.cwd_uri)
				.unwrap()
				.to_file_path()
				.unwrap(),
			nested,
		);
		assert!(matches!(
			host.final_cwd(&ExecFinalCwdRequest {
				exec:              started.exec,
				expected_revision: final_cwd.revision + 1,
				wire_revision:     omp_proto::SCHEMA_REV,
			}),
			Err(ExecError::StaleFinalCwdRevision),
		));
	}

	async fn wait_for_terminal(host: &ExecHost, name: &str, generation: u64) -> ProcessInfo {
		time::timeout(Duration::from_secs(5), async {
			loop {
				let info = host
					.get_process(&GetProcess {
						name: name.to_owned(),
						generation,
						wire_revision: omp_proto::SCHEMA_REV,
						props: Default::default(),
					})
					.unwrap();
				if process_state_is_terminal(info.state) {
					return info;
				}
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await
		.expect("named process should settle")
	}

	fn process_request(name: &str, root: &Path, source: &str) -> StartProcess {
		StartProcess {
			name: name.to_owned(),
			spec: Some(ProcessSpec {
				source: Some(v1::Script { text: source.to_owned(), ..Default::default() }),
				cwd_uri: Url::from_directory_path(root).unwrap().to_string(),
				restart: Some(v1::RestartSpec {
					policy: RestartPolicy::Never as i32,
					..Default::default()
				}),
				..Default::default()
			}),
			..Default::default()
		}
	}

	#[tokio::test]
	async fn terminal_name_reuse_advances_generation_and_closes_private_sessions() {
		let root = tempfile::tempdir().unwrap();
		let host = ExecHost::new();
		let first = host
			.start_process(process_request("reuse-lifecycle", root.path(), "printf first"))
			.await
			.unwrap();
		wait_for_terminal(&host, &first.name, first.generation).await;
		assert!(host.inner.sessions.lock().is_empty());

		let second = host
			.start_process(process_request("reuse-lifecycle", root.path(), "printf second"))
			.await
			.unwrap();
		assert_eq!(second.generation, first.generation + 1);
		wait_for_terminal(&host, &second.name, second.generation).await;
		assert!(host.inner.sessions.lock().is_empty());
	}

	#[tokio::test]
	async fn named_process_timeout_settles_failed_and_releases_its_deadline_and_session() {
		let root = tempfile::tempdir().unwrap();
		let host = ExecHost::new();
		let started = host
			.start_process_with_timeout(
				process_request("deadline-lifecycle", root.path(), "sleep 30"),
				Some(Duration::from_millis(25)),
			)
			.await
			.unwrap();
		let info = wait_for_terminal(&host, &started.name, started.generation).await;
		assert_eq!(info.state, ProcessState::Failed as i32);
		assert_eq!(
			info.status.as_ref().map(|status| status.outcome),
			Some(ExecOutcome::Timeout as i32),
		);
		let process = host
			.inner
			.processes
			.lock()
			.get(started.name.as_str())
			.cloned()
			.unwrap();
		assert!(process.deadline_cancel.is_cancelled());
		assert!(process.private_session.lock().is_none());
		assert!(host.inner.sessions.lock().is_empty());
	}

	#[tokio::test]
	async fn foreground_detach_transfers_remaining_output_to_named_log() {
		let root = tempfile::tempdir().unwrap();
		let host = ExecHost::new();
		let opened = host
			.open_session(OpenSessionRequest {
				cwd_uri: Url::from_directory_path(root.path()).unwrap().to_string(),
				..Default::default()
			})
			.await
			.unwrap();
		let (started, run) = host
			.exec(
				ExecRequest {
					session: opened.session.clone(),
					source: Some(v1::Script {
						text: String::from("printf before; sleep 0.1; printf after"),
						..Default::default()
					}),
					..Default::default()
				},
				None,
			)
			.await
			.unwrap();
		loop {
			match run.next_event().await {
				Some(ExecEvent::Output(output)) if output.data.as_ref() == b"before" => break,
				Some(_) => {},
				None => panic!("foreground event stream closed before detachment"),
			}
		}
		let detached = host.detach_exec(&started.exec, "detach-output").unwrap();
		drop(run);
		wait_for_terminal(&host, &detached.name, detached.generation).await;
		let attachment = host
			.attach_output(&AttachOutput {
				name: detached.name,
				generation: detached.generation,
				max_bytes: 1024,
				..Default::default()
			})
			.unwrap();
		let output = attachment
			.backlog
			.iter()
			.flat_map(|frame| frame.data.iter().copied())
			.collect::<Vec<_>>();
		assert_eq!(output, b"after");
		host.close_session(&opened.session).unwrap();
	}

	#[test]
	fn second_host_on_a_leased_store_degrades_to_in_memory_state() {
		let directory = tempfile::tempdir().unwrap();
		let meta = directory.path().join("processes").join("meta.json");
		let owner = ExecHost::new()
			.with_process_store(ProcessStore::new(meta.clone()))
			.unwrap();
		assert!(owner.inner.persistence.lock().is_some());
		let peer = ExecHost::new()
			.with_process_store(ProcessStore::new(meta.clone()))
			.unwrap();
		assert!(peer.inner.persistence.lock().is_none());
		drop(owner);
		let successor = ExecHost::new()
			.with_process_store(ProcessStore::new(meta))
			.unwrap();
		assert!(successor.inner.persistence.lock().is_some());
	}

	#[test]
	fn reader_retries_unbounded_interrupted_reads_before_collecting_output() {
		let mut reader = InterruptedReader { interrupts: 32, bytes: b"complete" };
		let mut output = [0_u8; 16];
		let read = read_chunk(&mut reader, &mut output).expect("interrupted reads should retry");
		assert_eq!(&output[..read], b"complete");
	}
}
