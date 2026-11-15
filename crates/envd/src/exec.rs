//! Environment-daemon process and persistent shell-session host.

use std::{
	collections::{BTreeMap, BTreeSet, HashMap, HashSet},
	env,
	ffi::{OsStr, OsString},
	fs, future,
	io::{self, Read, Write as _},
	mem, net,
	os::fd::{self, AsFd as _, AsRawFd as _},
	path::{Path, PathBuf},
	process::{self, Command, Stdio},
	sync::{
		Arc, OnceLock, Weak,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	thread,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use bytes::{Buf as _, Bytes, BytesMut};
use flume::Receiver;
use futures::future::try_join_all;
use nix::errno::Errno;
use omp_cache::forge_cache::ForgeCache;
use omp_contract::{ApprovalRoute, ApprovalScope, ApprovalSpec, TicketState};
use omp_core::{Hash32, Str, sf};
use omp_exec::{ExecError, ExecEvent, IdentityError, LeaseError};
use omp_journal::blob::{BlobStage, BlobStore};
use omp_proto::{
	bounds::{FRAME_MAX_BYTES, FrameBoundsError, validate_worker_frame},
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
	thread::v1::Blob as WireBlob,
	toolhost::v1::{HostFrame, Ping, WorkerFrame, host_frame, worker_frame},
};
use omp_shell::{
	ExecutionParameters, PathAccess, ProcessScope, Shell, ShellValue, ShellVariable, SourceInfo,
	SpawnObserver, SpawnWrapper,
	env::EnvironmentScope,
	openfiles::{OpenFile, OpenFiles},
	processes::{ProcessSignal, signal_process_group},
	variables::ShellValueUnsetType,
};
use parking_lot::Mutex;
use prost::Message as _;
use regex::bytes::Regex;
use tokio::{net::TcpStream, runtime, task, time};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::{
	admission,
	admission::GithubMutationTarget,
	approval_relay::{EnvApprover, OwnedApprovals, RouteBinding},
	devices_host::{CommandDevices, CommandIssuer, IssuerCell},
	exec_network_diag::{
		CommandEnd, NetworkAnnouncements, NetworkInForce, NetworkMarkerScan, NetworkSign,
		find_marker, network_diag,
	},
	exec_sandbox,
	exec_sandbox::{ApprovedPathScope, ExecSandbox, SandboxConsumer, SandboxDenialFact},
	exec_settings::{ExecSandboxMode, NetworkConfinement, SandboxSettings},
	process_identity::ProcessIdentity,
	process_log,
	process_log::{LogChunk, ProcessLog},
	process_store::{
		DaemonLease, ProcessPhase, ProcessRecord, ProcessStore, ProcessStoreSnapshot, RestartRecord,
	},
	reflection_relay::OwnedReflection,
	sandbox_proxy::{BrokerDenial, EgressGrants},
};
use crate::fault;

const CANCEL_GRACE: Duration = Duration::from_millis(250);
const OUTPUT_CHUNK_BYTES: usize = 16 * 1024;
const OUTPUT_EVENT_CAPACITY: usize = 8;
const LIVE_OUTPUT_BYTES: usize = 64 * 1024;
const LIVE_OUTPUT_FRAMES: usize = 64;
const COMPLETE_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const COMPLETE_OUTPUT_FRAMES: usize = COMPLETE_OUTPUT_BYTES / OUTPUT_CHUNK_BYTES;
const RESTART_HEALTHY_UPTIME: Duration = Duration::from_secs(30);
const RESTART_MAX_DELAY: Duration = Duration::from_secs(30);
const RESTART_BASE_DELAY: Duration = Duration::from_secs(1);
const RUN_ENVIRONMENT_PROP: &str = "omp/run-environment";
const SANDBOX_DENIED_PATH_PROP: &str = "omp/sandbox-denied-path";
const SANDBOX_DIAGNOSTIC_BYTES: usize = 16 * 1024;
const PATH_DENIED_DIAGNOSTIC: &[u8] = b"sandbox denied ";
const SANDBOX_PROXY_ENV: [&str; 6] =
	["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];

/// Content identity of the process environment inherited by new shell sessions.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct WorkspaceEnvironmentDigest(Hash32);

impl WorkspaceEnvironmentDigest {
	/// Returns the SHA-256 digest over sorted environment name/value pairs.
	pub const fn as_bytes(&self) -> &[u8; 32] {
		self.0.as_bytes()
	}
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

impl omp_exec::ExecRun for ExecRun {
	fn id(&self) -> &[u8] {
		&self.id
	}

	fn next_event(&self) -> impl std::future::Future<Output = Option<ExecEvent>> + Send {
		async move { self.events.recv_async().await.ok() }
	}

	fn cancel(&self) {
		self.control.cancel(CANCEL_GRACE);
	}
}

impl omp_exec::ExecHost for ExecHost {
	type Run = ExecRun;

	fn open_session(
		&self,
		request: OpenSessionRequest,
	) -> impl std::future::Future<Output = Result<OpenSessionResponse, ExecError>> + Send {
		self.drive_open_session(request)
	}

	fn exec(
		&self,
		request: ExecRequest,
		timeout: Option<Duration>,
	) -> impl std::future::Future<Output = Result<(ExecStarted, ExecRun), ExecError>> + Send {
		self.drive_exec(request, timeout)
	}

	fn close_session(&self, session: &[u8]) -> Result<CloseSessionResponse, ExecError> {
		self.drive_close_session(session)
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
	forge_cache:            Mutex<Option<Arc<ForgeCache>>>,
	devices:                Mutex<Option<Arc<crate::devices_host::DynHost>>>,
	output_store:           Mutex<Option<BlobStore>>,
	persistence:            Mutex<Option<ProcessPersistence>>,
	next_order:             AtomicU64,
	sandbox:                Mutex<Option<SandboxConfig>>,
	/// The in-process approval route and the network grants its session
	/// approved through it.
	sandbox_approval_route: Mutex<Option<RouteBinding>>,
}

struct SandboxConfig {
	settings:       SandboxSettings,
	workspace_root: PathBuf,
	/// What constructing `settings` yields on this host, probed on first use.
	state:          OnceLock<admission::SandboxState>,
}

struct ProcessPersistence {
	store:    ProcessStore,
	snapshot: ProcessStoreSnapshot,
	_lease:   DaemonLease,
}

#[derive(Clone)]
struct SessionHandle {
	tx:                flume::Sender<SessionCommand>,
	pty:               Option<PtySpec>,
	command_prefix:    Str,
	sandbox:           Option<Arc<ExecSandbox>>,
	process_scope:     Arc<SpawnBook>,
	sandbox_announced: Arc<AtomicBool>,
	/// The network diags already shown in this session.
	network_announced: Arc<NetworkAnnouncements>,
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
	restart_pending: AtomicBool,
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
	cancel_tx:        flume::Sender<CancelRequest>,
	input:            Mutex<Option<InputSink>>,
	spawns:           Arc<SpawnBook>,
	finished:         AtomicBool,
	retained:         Mutex<Option<Weak<NamedProcess>>>,
	events:           Weak<Receiver<ExecEvent>>,
	cancel_requested: AtomicBool,
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

#[derive(Clone)]
struct SessionCommand {
	host: Weak<HostInner>,
	exec: Bytes,
	source: Str,
	environment: Option<EnvironmentDelta>,
	timeout: Option<Duration>,
	pty: Option<PtySpec>,
	control: Arc<RunControl>,
	cancel_rx: Receiver<CancelRequest>,
	events: flume::Sender<ExecEvent>,
	output: Arc<Mutex<OutputCapture>>,
	github_targets: Vec<GithubMutationTarget>,
	sandbox: Option<Arc<ExecSandbox>>,
	sandbox_announced: Arc<AtomicBool>,
	network_announced: Arc<NetworkAnnouncements>,
	diags: Arc<Mutex<Vec<omp_tool::Diag>>>,
	sequence: Arc<AtomicU64>,
	/// The amended reruns this command may still take.
	reruns: AmendmentReruns,
	sandbox_environment_update: bool,
	/// The authenticated session owner of the connection that issued the
	/// command.
	owner: Option<Str>,
	/// The relay of the connection that issued the command, which answers
	/// its sandbox amendment and its `dyn` admissions; an approved rerun
	/// keeps it.
	approvals: Option<OwnedApprovals>,
	/// The reflection relay of the connection that issued the command, on
	/// whose session a `dyn reflect` it runs synthesizes.
	reflection: Option<OwnedReflection>,
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
				forge_cache:            Mutex::new(None),
				devices:                Mutex::new(None),
				output_store:           Mutex::new(None),
				persistence:            Mutex::new(None),
				next_order:             AtomicU64::new(1),
				sandbox:                Mutex::new(None),
				sandbox_approval_route: Mutex::new(None),
			}),
		}
	}

	/// Inherent `open_session`, named so the [`omp_exec::ExecHost`] impl cannot
	/// recurse into itself.
	fn drive_open_session(
		&self,
		request: OpenSessionRequest,
	) -> impl std::future::Future<Output = Result<OpenSessionResponse, ExecError>> + Send + '_ {
		self.open_session(request)
	}

	/// Inherent `exec`, named so the [`omp_exec::ExecHost`] impl cannot recurse
	/// into itself.
	fn drive_exec(
		&self,
		request: ExecRequest,
		timeout: Option<Duration>,
	) -> impl std::future::Future<Output = Result<(ExecStarted, ExecRun), ExecError>> + Send + '_ {
		self.exec(request, timeout)
	}

	/// Inherent `close_session`, named so the [`omp_exec::ExecHost`] impl cannot
	/// recurse into itself.
	fn drive_close_session(&self, session: &[u8]) -> Result<CloseSessionResponse, ExecError> {
		self.close_session(session)
	}

	/// Configures sandbox policy for subsequently opened sessions and detached
	/// processes.
	pub(crate) fn configure_sandbox(&self, settings: &SandboxSettings, workspace_root: &Path) {
		let config = (settings.mode != ExecSandboxMode::Off
			|| settings.network_confinement() != NetworkConfinement::Unconfined
			|| !settings.allow_unix_sockets.is_empty()
			|| settings.read_mode != crate::exec_settings::ReadMode::Host
			|| !settings.readable_roots.is_empty()
			|| !settings.read_deny.is_empty()
			|| !settings.read_deny_globs.is_empty()
			|| !settings.environment_policy_is_default())
		.then(|| SandboxConfig {
			settings:       settings.clone(),
			workspace_root: workspace_root.to_path_buf(),
			state:          OnceLock::new(),
		});
		*self.inner.sandbox.lock() = config;
	}

	/// Reports whether a constructed sandbox confines commands of this host.
	pub(crate) fn sandbox_state(&self) -> admission::SandboxState {
		let config = self.inner.sandbox.lock();
		config
			.as_ref()
			.map_or(admission::SandboxState::Off, |config| {
				*config
					.state
					.get_or_init(|| exec_sandbox::probe(&config.settings, &config.workspace_root))
			})
	}

	/// Compiles the sandbox for one shell session, whose commands can use the
	/// scoped egress broker.
	pub(crate) fn active_sandbox(&self) -> Result<Option<Arc<ExecSandbox>>, ExecError> {
		self.compiled_sandbox(true, SandboxConsumer::Session)
	}

	/// Compiles the sandbox for one supervised child, such as an eval worker,
	/// that never holds a broker capability: a scoped network is disabled.
	pub(crate) fn child_sandbox(&self) -> Result<Option<Arc<ExecSandbox>>, ExecError> {
		self.compiled_sandbox(true, SandboxConsumer::Child)
	}

	fn detached_sandbox(&self) -> Result<Option<Arc<ExecSandbox>>, ExecError> {
		self.compiled_sandbox(false, SandboxConsumer::Child)
	}

	fn compiled_sandbox(
		&self,
		supervised: bool,
		consumer: SandboxConsumer,
	) -> Result<Option<Arc<ExecSandbox>>, ExecError> {
		let (settings, workspace_root) = {
			let config = self.inner.sandbox.lock();
			let Some(config) = config.as_ref() else {
				return Ok(None);
			};
			(config.settings.clone(), config.workspace_root.clone())
		};
		match ExecSandbox::compile(&settings, &workspace_root, supervised, consumer) {
			Ok(sandbox) => Ok(sandbox),
			// The shipped default sandbox on a platform that cannot confine
			// commands still runs them, but only under approval: the sandbox
			// state resolves a defaulted `yolo` to `write` and the shell to the
			// `exec` tier. A sandbox the user asked for stays a hard error.
			Err(source)
				if !settings.explicit
					&& crate::exec_sandbox::runs_unsandboxed(
						crate::exec_sandbox::classify_unavailable(&source),
					) =>
			{
				tracing::warn!(%source, "sandbox unavailable; commands run unsandboxed under approval");
				Ok(None)
			},
			Err(source) => Err(ExecError::Sandbox { mode: settings.mode.into(), source }),
		}
	}

	/// Binds the interactive approval route used for sandbox amendments of
	/// commands that carry no connection relay.
	///
	/// Only an in-process composition (embedded or isolated), whose kernel
	/// shares this host's process, binds it. A project daemon serves sessions
	/// in other processes and leaves it unbound: there each command prompts
	/// the connection that issued it (see [`Self::amendment_approver`]).
	///
	/// The route is an approval binding: the network endpoints its session
	/// approves for the session are kept with it. Binding again starts an empty
	/// set and clears the previous route's grants, so no grant outlives the
	/// authority, and the journal, that issued it.
	pub(crate) fn bind_sandbox_approval_route(&self, route: Option<ApprovalRoute>) {
		let previous =
			mem::replace(&mut *self.inner.sandbox_approval_route.lock(), route.map(RouteBinding::new));
		if let Some(previous) = previous {
			previous.grants().clear();
		}
	}

	/// Drops the network endpoints the bound route's session approved for the
	/// session: its conversation was rewound or switched to another session,
	/// so the journal it now serves may not hold them. The approval desk
	/// answers later prompts from the grants that journal holds, which refills
	/// the set one refused attempt at a time.
	pub(crate) fn revoke_route_grants(&self) {
		if let Some(binding) = self.inner.sandbox_approval_route.lock().as_ref() {
			binding.grants().clear();
		}
	}

	/// Who decides a command's sandbox amendment: the relay of the connection
	/// that issued the command, else the in-process route bound on this host.
	/// It is also the approval binding whose session grants the command's
	/// attempts carry.
	///
	/// A relay whose connection closed never falls back to the host route, so
	/// a command that outlives its connection fails closed instead of
	/// prompting another session.
	fn amendment_approver(&self, relay: Option<&OwnedApprovals>) -> Option<EnvApprover> {
		match relay {
			Some(relay) => Some(EnvApprover::Relay(relay.clone())),
			None => self
				.inner
				.sandbox_approval_route
				.lock()
				.clone()
				.map(EnvApprover::Route),
		}
	}

	/// The session egress grants of the approval binding that issued a
	/// command: its connection relay's, else the bound route's.
	fn egress_grants(&self, relay: Option<&OwnedApprovals>) -> Option<EgressGrants> {
		match relay {
			Some(relay) => Some(relay.grants().clone()),
			None => self
				.inner
				.sandbox_approval_route
				.lock()
				.as_ref()
				.map(|binding| binding.grants().clone()),
		}
	}

	/// Forwards the invocation-scoped approval route to installed dynamic
	/// devices so nested `dyn` calls admit their own exact effects.
	pub(crate) fn bind_dynamic_approval_route(&self, route: Option<ApprovalRoute>) {
		if let Some(host) = self.inner.devices.lock().as_ref() {
			host.bind_approval_route(route);
		}
	}

	/// Asks the command's approver to amend the sandbox for one denied fact,
	/// and returns the lifetime it granted, or `None` when it was refused or
	/// nobody can be asked.
	///
	/// A network fact offers `once` and `session`; a path fact offers only
	/// `once`. A decision is honoured only in a scope its requirement offered,
	/// whoever made it (a human, or the approval desk replaying a journaled
	/// session grant). An approved `session` answer admits the endpoint for
	/// every later attempt of the deciding approver's binding.
	async fn approve_sandbox_amendment(
		&self,
		relay: Option<&OwnedApprovals>,
		command: &str,
		fact: &SandboxDenialFact,
		scope: &str,
	) -> Option<AmendmentGrant> {
		let approver = self.amendment_approver(relay)?;
		let fact_label = sandbox_fact_label(fact);
		let scope = Str::from(scope);
		let (offered, prompt) = match fact {
			SandboxDenialFact::Network { .. } => (
				vec![sf!("once"), sf!("session")],
				sf!(
					"The sandbox denied {fact_label}. Allow it for this command once, or for the rest \
					 of this session?\n\n{command}"
				),
			),
			_ => (
				vec![sf!("once")],
				sf!(
					"The sandbox denied {fact_label}. Approve {scope} for this exact command one \
					 time?\n\n{command}"
				),
			),
		};
		let ticket = approver
			.request(
				None,
				vec![ApprovalSpec {
					title:         sf!("Approve scoped sandbox amendment"),
					body:          prompt,
					subject:       scope.clone(),
					kind:          sf!("sandbox_amendment"),
					scopes:        offered,
					default:       Some(false),
					route:         sf!("local"),
					approver:      None,
					timeout_ms:    120_000,
					unreachable:   sf!("fail_closed"),
					require_human: true,
					pattern:       Some(Str::from(command)),
					evidence:      vec![fact_label, scope.clone()],
				}],
				unix_time_ms(),
			)
			.await;
		let decision = ticket
			.decision
			.as_ref()
			.filter(|decision| ticket.state == TicketState::Decided && decision.approved)?;
		let honoured = ticket.reasons.iter().any(|reason| {
			reason.kind == "sandbox_amendment"
				&& reason.subject == scope
				&& reason.offers(&decision.scope)
		});
		if !honoured {
			return None;
		}
		match (&decision.scope, fact) {
			(ApprovalScope::Once, _) => Some(AmendmentGrant::Once),
			(ApprovalScope::Session, SandboxDenialFact::Network { host, port }) => {
				approver.grants().insert(host, *port);
				Some(AmendmentGrant::Session)
			},
			_ => None,
		}
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
	pub fn with_forge_cache(self, cache: Arc<ForgeCache>) -> Self {
		*self.inner.forge_cache.lock() = Some(cache);
		self
	}

	/// Binds the content-addressed store that retains complete oversized
	/// execution output before the live event stream is projected.
	pub fn with_output_store(self, store: BlobStore) -> Self {
		*self.inner.output_store.lock() = Some(store);
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
			// ADR 0028: the in-process interpreter is the only shell; external
			// shells never run a session script.
			let supported = matches!(requested, "" | "brush");
			if profile.wire_revision != omp_proto::SCHEMA_REV || !supported {
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
		let variables = sandbox.as_ref().map_or_else(
			|| {
				variables
					.iter()
					.map(|(name, value)| (OsString::from(name.as_str()), OsString::from(value.as_str())))
					.collect()
			},
			|sandbox| {
				sandbox.resolve_env(variables.iter().map(|(name, value)| {
					(OsString::from(name.as_str()), OsString::from(value.as_str()))
				}))
			},
		);
		let mut builder = Shell::builder()
			.profile(omp_shell::ProfileLoadBehavior::Skip)
			.rc(omp_shell::RcLoadBehavior::Skip)
			.working_dir(cwd)
			.do_not_inherit_env(true)
			.builtins(omp_shell::builtins::default_builtins())
			.builtins(
				omp_shell_builtins::utility_builtins()
					.into_iter()
					.map(|(name, registration)| (name.to_owned(), registration)),
			)
			.builtins(
				omp_shell_builtins::process_builtins()
					.into_iter()
					.map(|(name, registration)| (name.to_owned(), registration)),
			);
		// The shell's `dyn` answers to the connection that issued the command
		// the shell is running, which the session loop records here.
		let issuer = IssuerCell::default();
		if let Some(host) = self.inner.devices.lock().clone() {
			builder = builder.builtin(
				"dyn",
				omp_shell_builtins::dyn_builtin(Arc::new(CommandDevices::new(host, issuer.clone()))),
			);
		}
		for (name, value) in &variables {
			let Some(name) = name.to_str() else { continue };
			let Some(value) = value.to_str() else {
				continue;
			};
			let mut variable = ShellVariable::new(value);
			variable.export();
			builder = builder.var(name, variable);
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
		if let Some(sandbox) = sandbox.as_ref() {
			apply_sandbox_environment(&mut shell, sandbox.as_ref(), EnvironmentScope::Global)
				.map_err(shell_error)?;
		}

		let command_prefix =
			profile.map_or_else(Str::default, |profile| Str::from(profile.command_prefix.trim()));
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
			session_loop(shell, rx, issuer).await;
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
				sandbox,
				process_scope,
				sandbox_announced: Arc::new(AtomicBool::new(false)),
				network_announced: Arc::new(NetworkAnnouncements::default()),
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
			// Builtins have no child group, so the cancel channel is their termination path.
			ExecControlKind::Kill => {
				control.cancel(Duration::ZERO);
				control.spawns.signal(ProcessSignal::Kill)?;
			},
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
			shell_profiles:      vec![String::from("brush")],
			wire_revision:       omp_proto::SCHEMA_REV,
		}
	}

	/// Starts a script in a session. A session serializes its scripts.
	///
	/// The command carries no connection relay: a sandbox amendment it needs
	/// prompts through the in-process route bound on this host, if any.
	pub async fn exec(
		&self,
		request: ExecRequest,
		timeout: Option<Duration>,
	) -> Result<(ExecStarted, ExecRun), ExecError> {
		self
			.exec_controlled(request, timeout, CommandIssuer::default())
			.await
	}

	/// Starts a script for the connection whose owner and relays are carried
	/// through nested `dyn` calls: a sandbox amendment or admission prompts
	/// that connection, `dyn reflect` synthesizes on its session, and eval
	/// state remains scoped to that session.
	pub(crate) async fn exec_relayed(
		&self,
		request: ExecRequest,
		timeout: Option<Duration>,
		owner: Option<Str>,
		approvals: Option<OwnedApprovals>,
		reflection: Option<OwnedReflection>,
	) -> Result<(ExecStarted, ExecRun), ExecError> {
		self
			.exec_controlled(request, timeout, CommandIssuer { owner, approvals, reflection })
			.await
	}

	async fn exec_controlled(
		&self,
		mut request: ExecRequest,
		timeout: Option<Duration>,
		issuer: CommandIssuer,
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
		let source = if session.command_prefix.is_empty() {
			Str::from(source.text)
		} else {
			sf!("{} {}", session.command_prefix, source.text)
		};
		let exec = self.new_id();
		// A bounded host-owned channel backpressures the pipe readers before
		// untrusted output can accumulate in memory. OutputCapture separately
		// streams the complete byte sequence to the artifact store.
		let (events_tx, events) = flume::bounded(OUTPUT_EVENT_CAPACITY);
		let events = Arc::new(events);
		let output_request = match v1::OutputRequest::try_from(request.output_request) {
			Ok(v1::OutputRequest::Complete) => omp_tool::OutputRequest::Complete,
			Ok(v1::OutputRequest::Bounded | v1::OutputRequest::Unspecified) | Err(_) => {
				omp_tool::OutputRequest::Bounded
			},
		};
		let output = Arc::new(Mutex::new(OutputCapture::new_with_request(
			self.inner.output_store.lock().as_ref(),
			output_request,
		)?));
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
			cancel_requested: AtomicBool::new(false),
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
			output,
			github_targets,
			sandbox: session.sandbox,
			sandbox_announced: session.sandbox_announced,
			network_announced: session.network_announced,
			diags: Arc::new(Mutex::new(Vec::new())),
			sequence: Arc::new(AtomicU64::new(1)),
			reruns: AmendmentReruns::Fresh,
			sandbox_environment_update: false,
			owner: issuer.owner,
			approvals: issuer.approvals,
			reflection: issuer.reflection,
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
		// A named process (StartProcess, async bash, restart generations)
		// outlives any one request, so it carries no connection relay: on a
		// project daemon its sandbox amendments fail closed, and only an
		// in-process composition's host route can prompt for them.
		let executed = self
			.exec_controlled(
				ExecRequest {
					session:        private_session.clone(),
					source:         spec.source.clone(),
					output_request: v1::OutputRequest::Bounded as i32,
					props:          Default::default(),
				},
				timeout,
				CommandIssuer::default(),
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
					spec: Some(spec.clone()),
					ready: ready.clone(),
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
			restart_pending: AtomicBool::new(false),
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
			if !process_state_is_terminal(stream.info.state) {
				stream.info.state = ProcessState::Ready as i32;
				stream.info.ready_pending.clear();
				let info = stream.info.clone();
				stream.broadcast(ProcessEvent::State(info));
				drop(stream);
				self.persist_process(&process, ProcessPhase::Running)?;
			}
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
		let mut command = detached_command(&source, sandbox.as_deref())?;
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
			cancel_requested: AtomicBool::new(false),
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
					spec: Some(spec.clone()),
					ready: ready.clone(),
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
			restart_pending: AtomicBool::new(false),
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
			if !process_state_is_terminal(stream.info.state) {
				stream.info.state = ProcessState::Ready as i32;
				stream.info.ready_pending.clear();
				let info = stream.info.clone();
				stream.broadcast(ProcessEvent::State(info));
				drop(stream);
				self.persist_process(&process, ProcessPhase::Running)?;
			}
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
			status_wire: stream
				.info
				.status
				.as_ref()
				.map_or_else(Vec::new, |status| status.encode_to_vec()),
			process_dir,
			generation: process.generation,
			identity: process.identity.clone(),
			detached: process.detached,
			persist: process.persist,
			phase,
			log_start_offset: log.start_offset(),
			log_end_offset: log.end_offset(),
			log_rotations: log.rotations(),
			restart_pending: process.restart_pending.load(Ordering::Acquire),
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

	fn clear_restart_pending(&self, process: &Arc<NamedProcess>) {
		process.restart_pending.store(false, Ordering::Release);
		let current = self
			.inner
			.processes
			.lock()
			.get(&process.name)
			.is_some_and(|current| Arc::ptr_eq(current, process));
		if current {
			let phase = phase_for_state(process.stream.lock().info.state);
			let _ = self.persist_process(process, phase);
		}
	}

	fn recover_records(&self, records: Vec<ProcessRecord>) -> Result<(), ExecError> {
		for record in records {
			if record.restart_pending {
				self.recover_pending_restart(record);
				continue;
			}
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
				cancel_requested: AtomicBool::new(false),
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
						spec: Some(spec.clone()),
						ready: ready.clone(),
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
				restart_pending: AtomicBool::new(false),
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

	fn recover_pending_restart(&self, record: ProcessRecord) {
		let Ok(spec) = ProcessSpec::decode(record.spec_wire.as_slice()) else {
			let _ = self.mark_recovered_terminal(&record, ProcessPhase::Failed);
			return;
		};
		let ready = record
			.ready_wire
			.iter()
			.filter_map(|wire| ReadyProbe::decode(wire.as_slice()).ok())
			.collect::<Vec<_>>();
		let timeout = spec
			.timeout_ms
			.filter(|timeout| *timeout != 0)
			.map(Duration::from_millis);
		let due_ms = record
			.restart_history
			.last()
			.map_or(0, |restart| restart.at_ms.saturating_add(restart.delay_ms));
		let delay = Duration::from_millis(due_ms.saturating_sub(unix_time_ms()));
		if !self.inner.starting.lock().insert(record.name.clone()) {
			let _ = self.mark_recovered_terminal(&record, ProcessPhase::Failed);
			return;
		}
		let reservation =
			ProcessReservation { host: Arc::downgrade(&self.inner), name: record.name.clone() };
		let Ok(runtime) = runtime::Handle::try_current() else {
			let _ = self.mark_recovered_terminal(&record, ProcessPhase::Failed);
			return;
		};
		let host = self.clone();
		runtime.spawn(async move {
			let _reservation = reservation;
			time::sleep(delay).await;
			let name = record.name.clone();
			let generation = record.generation.saturating_add(1);
			let launched = if record.detached {
				host
					.launch_detached(name, spec, ready, generation, Some(&record), timeout)
					.await
			} else {
				host
					.launch_attached(name, spec, ready, generation, Some(&record), timeout)
					.await
			};
			if launched.is_err() {
				let _ = host.mark_recovered_terminal(&record, ProcessPhase::Failed);
			}
		});
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
			stored.restart_pending = false;
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
					spec: Some(ProcessSpec::default()),
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
			restart_pending: AtomicBool::new(false),
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

	/// Returns whether a live named process requires this daemon to remain
	/// available after its last client disconnects.
	pub(crate) fn has_live_persistent_processes(&self) -> bool {
		self.inner.processes.lock().values().any(|process| {
			process.persist
				&& (!process_state_is_terminal(process.stream.lock().info.state)
					|| process.restart_pending.load(Ordering::Acquire)
						&& !process.stopping.load(Ordering::Acquire))
		}) || self
			.inner
			.persistence
			.lock()
			.as_ref()
			.is_some_and(|persistence| {
				persistence
					.snapshot
					.processes
					.iter()
					.any(|record| record.persist && record.restart_pending)
			})
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
			.ok_or_else(|| ExecError::ProcessNotFound { name: key.clone() })?;
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
			return Err(ExecError::ProcessExists { name });
		}
		let retained_generation = self
			.persisted_record(&name)
			.map_or(0, |record| record.generation);
		let generation = if let Some(process) = self.inner.processes.lock().get(&name).cloned() {
			if !process_state_is_terminal(process.stream.lock().info.state) {
				self.inner.starting.lock().remove(&name);
				return Err(ExecError::ProcessExists { name });
			}
			process
				.generation
				.max(retained_generation)
				.saturating_add(1)
		} else {
			retained_generation.saturating_add(1)
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
			return Err(ExecError::ProcessExists { name });
		}
		let reservation =
			ProcessReservation { host: Arc::downgrade(&self.inner), name: name.clone() };
		let process = self
			.inner
			.processes
			.lock()
			.get(&name)
			.cloned()
			.ok_or_else(|| ExecError::ProcessNotFound { name: name.clone() })?;
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
		self.cancel_requested.store(true, Ordering::Release);
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

async fn session_loop(mut shell: Shell, commands: Receiver<SessionCommand>, issuer: IssuerCell) {
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
					)
					.await;
					cancellation_deadline = Some(Instant::now() + CANCEL_GRACE);
					continue;
				},
				Err(_) => cancellation_deadline = None,
			}
		}
		if run_session_command(&mut shell, command, &issuer).await {
			cancellation_deadline = Some(Instant::now() + CANCEL_GRACE);
		}
	}
}

async fn run_session_command(
	shell: &mut Shell,
	command: SessionCommand,
	issuer: &IssuerCell,
) -> bool {
	let started_at = Instant::now();
	match command.cancel_rx.try_recv() {
		Ok(_) | Err(flume::TryRecvError::Disconnected) => {
			finish_session_command(
				&command,
				RunTerminal::Cancelled,
				started_at.elapsed(),
				shell.working_dir(),
			)
			.await;
			return true;
		},
		Err(flume::TryRecvError::Empty) => {},
	}
	let cancel_rx = command.cancel_rx.clone();
	let sandbox_active = command.sandbox.is_some();
	let network = command.sandbox.as_deref().and_then(NetworkInForce::of);
	let setup = setup_io(
		command.pty.as_ref(),
		command.control.clone(),
		command.exec.clone(),
		command.events.clone(),
		command.output.clone(),
		command.sequence.clone(),
		sandbox_active,
		network.is_some(),
	);
	let Ok((mut params, readers, sequencer)) = setup else {
		finish_session_command(
			&command,
			RunTerminal::Failed,
			started_at.elapsed(),
			shell.working_dir(),
		)
		.await;
		return false;
	};
	if let Some(sandbox) = command.sandbox.as_ref()
		&& !command.sandbox_announced.swap(true, Ordering::AcqRel)
	{
		command
			.diags
			.lock()
			.push(omp_tool::Diag::info(omp_tool::DiagKind::Sandbox, sandbox.session_note().clone()));
	}
	// The broker admits the endpoints the command's approval binding approved
	// for the session, live, for this attempt only.
	let grants = command
		.host
		.upgrade()
		.and_then(|inner| ExecHost { inner }.egress_grants(command.approvals.as_ref()));
	let attempt = command
		.sandbox
		.as_ref()
		.map(|sandbox| sandbox.begin_attempt(grants.as_ref()));
	let environment_scoped =
		command.environment.is_some() || command.sandbox_environment_update || attempt.is_some();
	if environment_scoped {
		shell.env_mut().push_scope(EnvironmentScope::Command);
		if command
			.environment
			.as_ref()
			.is_some_and(|environment| apply_run_environment_delta(shell, environment).is_err())
			|| command.sandbox.as_ref().is_some_and(|_| {
				(if command.environment.is_some() {
					apply_sandbox_environment(
						shell,
						attempt.as_deref().expect("sandbox attempt exists"),
						EnvironmentScope::Command,
					)
				} else {
					apply_amended_proxy_environment(
						shell,
						attempt.as_deref().expect("sandbox attempt exists"),
						EnvironmentScope::Command,
					)
				})
				.is_err()
			}) {
			let _ = shell.env_mut().pop_scope(EnvironmentScope::Command);
			finish_session_command(
				&command,
				RunTerminal::Failed,
				started_at.elapsed(),
				shell.working_dir(),
			)
			.await;
			return false;
		}
	}
	let _ = command
		.events
		.send(ExecEvent::Started { exec_id: command.exec.clone() });
	params.process_group_policy = omp_shell::ProcessGroupPolicy::NewProcessGroup;
	params.set_spawn_observer(command.control.spawns.clone());
	params.set_process_scope(command.control.spawns.clone());
	params.set_protect_host_process(true);
	if let Some(attempt) = attempt.as_ref() {
		params.set_path_policy(attempt.clone());
		params.set_spawn_wrapper(attempt.clone());
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
		// Every `dyn` call of this attempt answers to the command's issuer.
		let _issued = issuer.enter(CommandIssuer {
			owner:      command.owner.clone(),
			approvals:  command.approvals.clone(),
			reflection: command.reflection.clone(),
		});
		let execution = crate::devices_host::scope_exec_diags(
			Arc::clone(&command.diags),
			shell.run_string(command.source.to_string(), &source_info, &params),
		);
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
	let facts = attempt
		.as_ref()
		.map(|attempt| attempt.take_facts())
		.unwrap_or_default();
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
	let (denial, network_marker) = {
		let sequencer = sequencer.lock();
		let denial = classify_sandbox_denial(
			sandbox_active,
			facts.denial,
			&result,
			shell_error.as_ref(),
			sequencer.sandbox_diagnostic.as_deref().unwrap_or_default(),
		);
		let marker = sequencer
			.network_scan
			.as_ref()
			.is_some_and(NetworkMarkerScan::found);
		(denial, marker)
	};
	let network_trouble = network.map(|network| NetworkTrouble {
		network,
		refusal: facts.refusal,
		sign: NetworkSign::of(network_marker, facts.network_locator),
	});
	if let Some(denial) = denial {
		if let Some(sandbox) = command.sandbox.as_deref()
			&& let Some(host) = command.host.upgrade()
		{
			let host = ExecHost { inner: host };
			let bound = sandbox.network_reruns();
			// Approved for the session by the command's binding after this
			// attempt was refused: a concurrent command asked first.
			let covered = match &denial.fact {
				SandboxDenialFact::Network { host: name, port } => host
					.egress_grants(command.approvals.as_ref())
					.is_some_and(|grants| grants.covers(name, *port)),
				_ => false,
			};
			if command.reruns.admits(&denial.fact, covered, bound)
				&& let Some(amendment) = approved_amendment(sandbox, &denial.fact)
			{
				let scope = amendment.scope_label();
				let granted = if covered {
					Some(AmendmentGrant::Session)
				} else {
					// `select!` owns the prompt future and drops it as soon as one
					// arm wins. A cancelled command therefore withdraws its relayed
					// query (the guard inside the prompt future writes it straight
					// to the connection) before its exit enters the event stream,
					// so the connection sees the withdrawal first. Only a full
					// response channel defers the withdrawal to a task; the client
					// matches it by request and query id, so it still closes the
					// prompt. Keep the future inside `select!`: the window is too
					// narrow for a test to force, so a future pinned outside it
					// would regress silently.
					let granted = tokio::select! {
						granted = host.approve_sandbox_amendment(
							command.approvals.as_ref(),
							&command.source,
							&denial.fact,
							&scope,
						) => Some(granted),
						_ = command.cancel_rx.recv_async() => None,
					};
					let Some(granted) = granted else {
						finish_session_command(
							&command,
							RunTerminal::Cancelled,
							started_at.elapsed(),
							shell.working_dir(),
						)
						.await;
						return true;
					};
					granted
				};
				match granted {
					// The endpoint passes the session's own broker from now on, so
					// the command reruns under the same sandbox.
					Some(AmendmentGrant::Session) => {
						let reruns = command.reruns.after_session();
						command.diags.lock().push(omp_tool::Diag::info(
							omp_tool::DiagKind::Sandbox,
							sf!(
								"sandbox: {scope} approved for this session; rerun {} of at most {bound}",
								reruns.taken()
							),
						));
						let mut rerun = command.clone();
						rerun.reruns = reruns;
						return Box::pin(run_session_command(shell, rerun, issuer)).await;
					},
					Some(AmendmentGrant::Once) => {
						let network_amendment =
							matches!(&amendment, ApprovedSandboxAmendment::Network(_));
						let amended = match &amendment {
							ApprovedSandboxAmendment::Path(scope) => sandbox.amended_scope(scope),
							ApprovedSandboxAmendment::Network(fact) => sandbox.amended_network(fact),
						};
						if let Ok(Some(sandbox)) = amended {
							command.diags.lock().push(omp_tool::Diag::info(
								omp_tool::DiagKind::Sandbox,
								sf!("sandbox: rerun with approved scope: {scope}"),
							));
							let mut rerun = command.clone();
							rerun.sandbox = Some(sandbox);
							rerun.reruns = AmendmentReruns::Spent;
							rerun.sandbox_environment_update = network_amendment;
							return Box::pin(run_session_command(shell, rerun, issuer)).await;
						}
					},
					None => {},
				}
			}
		}
		push_network_diag(&command, network_trouble, CommandEnd::Failed);
		finish_session_command(
			&command,
			RunTerminal::Denied { exit_code: denial.exit_code, fact: denial.fact },
			started_at.elapsed(),
			shell.working_dir(),
		)
		.await;
		return cancelled;
	}
	push_network_diag(&command, network_trouble, result.command_end());
	finish_session_command(&command, result, started_at.elapsed(), shell.working_dir()).await;
	cancelled
}

/// What one sandboxed command met on the network, for its final diag.
struct NetworkTrouble {
	network: NetworkInForce,
	refusal: Option<BrokerDenial>,
	sign:    Option<NetworkSign>,
}

/// Adds the network diag for a command's final run. An approved rerun reports
/// its own, so a command that reruns never reports its first attempt's.
fn push_network_diag(command: &SessionCommand, trouble: Option<NetworkTrouble>, end: CommandEnd) {
	let Some(trouble) = trouble else {
		return;
	};
	let prompt = trouble.refusal.is_some()
		&& command.host.upgrade().is_some_and(|inner| {
			ExecHost { inner }
				.amendment_approver(command.approvals.as_ref())
				.is_some_and(|approver| approver.is_reachable())
		});
	if let Some(diag) = network_diag(
		trouble.network,
		trouble.refusal.as_ref(),
		trouble.sign,
		end,
		prompt,
		&command.network_announced,
	) {
		command.diags.lock().push(diag);
	}
}

async fn finish_session_command(
	command: &SessionCommand,
	mut result: RunTerminal,
	elapsed: Duration,
	working_dir: &Path,
) {
	if command.control.cancel_requested.load(Ordering::Acquire)
		&& !matches!(result, RunTerminal::Timeout)
	{
		result = RunTerminal::Cancelled;
	}
	command.control.finished.store(true, Ordering::Release);
	let finished = command.output.lock().finish_with_projection();
	let (spilled_output, projection) = match finished {
		Ok((spilled, projection)) => {
			let spilled = spilled.as_ref().map(wire_blob);
			let store = command
				.host
				.upgrade()
				.and_then(|host| host.output_store.lock().clone());
			match (&result, store) {
				(RunTerminal::Exited(exit_code), Some(store))
					if is_single_cargo_command(&command.source) =>
				{
					let (source, exit_code) = (command.source.clone(), *exit_code);
					let fallback = projection.clone();
					let mut projection = projection;
					// The blob read and the filter are blocking work; keep them off the runtime
					// thread.
					let minimized = task::spawn_blocking(move || {
						let original = minimize_cargo_output(&source, exit_code, &mut projection, &store);
						(original, projection)
					})
					.await;
					match minimized {
						Ok((Some(original), projection)) => (Some(original), Some(projection)),
						Ok((None, projection)) => (spilled, Some(projection)),
						Err(_) => (spilled, Some(fallback)),
					}
				},
				_ => (spilled, Some(projection)),
			}
		},
		Err(_) => {
			result = RunTerminal::Failed;
			(None, None)
		},
	};
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
		&& let Some(cache) = host.forge_cache.lock().clone()
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
	let mut status = result.status_with_projection(elapsed, spilled_output, projection);
	status.diags = command.diags.lock().iter().map(wire_diag).collect();
	let event = ExecEvent::Exit(Box::new(ExitEvent {
		exec: command.exec.clone(),
		status: Some(status),
		final_cwd_uri,
		final_cwd_revision,
		props: Default::default(),
	}));
	// `send_async`, never `send`: the host queue is bounded, and an output
	// burst that fills it leaves the blocking send parking the runtime thread
	// that the only consumer needs in order to drain. On a current-thread
	// runtime that is an outright deadlock, and on a multi-thread one it wedges
	// a worker and stalls the session actor.
	let _ = command.events.send_async(event).await;
}

/// Whether `command` is one plain `cargo` invocation, the only shape envd
/// minimizes.
fn is_single_cargo_command(command: &str) -> bool {
	matches!(omp_minimizer::plan::analyze(command), omp_minimizer::plan::CommandPlan::Single { .. })
		&& omp_minimizer::detect::detect(command).is_some_and(|identity| identity.program == "cargo")
}

fn minimize_cargo_output(
	command: &str,
	exit_code: i32,
	projection: &mut v1::OutputProjection,
	store: &BlobStore,
) -> Option<WireBlob> {
	// Defense in depth: the caller already gates on a single cargo command, and
	// the engine's `only` set refuses every other program if that gate drifts.
	let config = omp_minimizer::MinimizerConfig {
		enabled: true,
		only: std::iter::once(String::from("cargo")).collect(),
		..Default::default()
	};
	let artifact = projection.artifact.as_ref()?;
	if artifact.size > u64::from(config.max_capture_bytes) {
		return None;
	}
	let hash: [u8; 32] = artifact.hash.as_ref().try_into().ok()?;
	let captured = store
		.get(&omp_journal::blob::BlobRef { hash: Hash32::new(hash), size: artifact.size })
		.ok()?;
	let original = std::str::from_utf8(&captured).ok()?;
	let minimized = omp_minimizer::apply(command, original, exit_code, &config);
	if !minimized.changed || minimized.filter != "cargo" {
		return None;
	}
	projection.model_text = Some(minimized.text.into_owned());
	Some(artifact.clone())
}

#[derive(Clone, Eq, PartialEq)]
enum RunTerminal {
	Exited(i32),
	Failed,
	Timeout,
	Cancelled,
	Denied { exit_code: Option<i32>, fact: SandboxDenialFact },
}

fn wire_blob(reference: &omp_journal::blob::BlobRef) -> WireBlob {
	WireBlob {
		hash:   Bytes::copy_from_slice(reference.hash.as_bytes()),
		mime:   String::from("application/octet-stream"),
		size:   reference.size,
		inline: Bytes::new(),
		detail: Default::default(),
	}
}

pub(crate) fn wire_diag(diag: &omp_tool::Diag) -> v1::ToolDiag {
	let severity = match diag.severity {
		omp_tool::Severity::Info => v1::ToolDiagSeverity::Info,
		omp_tool::Severity::Warn => v1::ToolDiagSeverity::Warn,
		omp_tool::Severity::Error => v1::ToolDiagSeverity::Error,
	};
	let omitted = diag.omitted.map(|omitted| v1::ToolDiagOmitted {
		count: omitted.count,
		unit:  match omitted.unit {
			omp_tool::Unit::Lines => v1::ToolDiagUnit::Lines,
			omp_tool::Unit::Rows => v1::ToolDiagUnit::Rows,
			omp_tool::Unit::Entries => v1::ToolDiagUnit::Entries,
			omp_tool::Unit::Files => v1::ToolDiagUnit::Files,
			omp_tool::Unit::Bytes => v1::ToolDiagUnit::Bytes,
			omp_tool::Unit::Chars => v1::ToolDiagUnit::Chars,
			omp_tool::Unit::Items => v1::ToolDiagUnit::Items,
		} as i32,
	});
	v1::ToolDiag {
		severity: severity as i32,
		kind: diag.kind.to_string(),
		text: diag.text.to_string(),
		continuation: diag.continuation.as_ref().map(ToString::to_string),
		artifact: diag.artifact.as_ref().map(ToString::to_string),
		omitted,
	}
}

impl RunTerminal {
	const fn command_end(&self) -> CommandEnd {
		match self {
			Self::Exited(0) => CommandEnd::Succeeded,
			Self::Cancelled => CommandEnd::Cancelled,
			Self::Exited(_) | Self::Failed | Self::Timeout | Self::Denied { .. } => CommandEnd::Failed,
		}
	}

	fn status(self, elapsed: Duration, spilled_output: Option<WireBlob>) -> ExecStatusMsg {
		self.status_with_projection(elapsed, spilled_output, None)
	}

	fn status_with_projection(
		self,
		elapsed: Duration,
		spilled_output: Option<WireBlob>,
		projection: Option<v1::OutputProjection>,
	) -> ExecStatusMsg {
		let props = match &self {
			Self::Denied { fact, .. } => Some(WireValueMap {
				fields: BTreeMap::from([(SANDBOX_DENIED_PATH_PROP.to_owned(), WireValue {
					kind: Some(wire_value::Kind::String(sandbox_fact_label(fact).to_string())),
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
			spilled_output,
			aborted,
			projection,
			diags: Vec::new(),
			props,
		}
	}
}

struct SandboxDenial {
	exit_code: Option<i32>,
	fact:      SandboxDenialFact,
}
fn sandbox_fact_label(fact: &SandboxDenialFact) -> Str {
	match fact {
		SandboxDenialFact::ReadPath(path) => sf!("read {}", path.display()),
		SandboxDenialFact::WritePath(path) => sf!("write {}", path.display()),
		SandboxDenialFact::Network { host, port } => sf!("network {host}:{port}"),
		SandboxDenialFact::Unknown => sf!("unknown sandbox denial"),
	}
}

enum ApprovedSandboxAmendment {
	Path(ApprovedPathScope),
	Network(SandboxDenialFact),
}

impl ApprovedSandboxAmendment {
	fn scope_label(&self) -> Str {
		match self {
			Self::Path(scope) => scope.label(),
			Self::Network(fact) => sandbox_fact_label(fact),
		}
	}
}

/// The lifetime an approved sandbox amendment was granted.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AmendmentGrant {
	/// One rerun with the sandbox amended by exactly the denied fact; a
	/// further denial is final.
	Once,
	/// A network endpoint, admitted for every later attempt of the approval
	/// binding that granted it; the command reruns under its own sandbox.
	Session,
}

/// The amended reruns one command may still take (ADR 0028).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AmendmentReruns {
	/// Nothing was amended yet: the first denial of any amendable fact may be
	/// asked about.
	Fresh,
	/// This many reruns followed endpoints approved for the session. A further
	/// denial may be asked about only when it names a network endpoint the
	/// command's binding has not approved, while fewer reruns than the bound
	/// (`sv_sandbox_network_session_reruns`) were taken.
	SessionNetwork(u32),
	/// A once approval reran the command: a further denial is final.
	Spent,
}

impl AmendmentReruns {
	/// Whether a denial of `fact` may still be amended. `covered` says whether
	/// the command's binding already approved the network fact for the
	/// session; `bound` is the session rerun budget.
	const fn admits(self, fact: &SandboxDenialFact, covered: bool, bound: u32) -> bool {
		match self {
			Self::Fresh => true,
			Self::SessionNetwork(taken) => {
				taken < bound && matches!(fact, SandboxDenialFact::Network { .. }) && !covered
			},
			Self::Spent => false,
		}
	}

	/// The budget after one more rerun on an endpoint approved for the
	/// session.
	const fn after_session(self) -> Self {
		match self {
			Self::Fresh => Self::SessionNetwork(1),
			Self::SessionNetwork(taken) => Self::SessionNetwork(taken.saturating_add(1)),
			Self::Spent => Self::Spent,
		}
	}

	/// Reruns taken on endpoints approved for the session.
	const fn taken(self) -> u32 {
		match self {
			Self::SessionNetwork(taken) => taken,
			Self::Fresh | Self::Spent => 0,
		}
	}
}

fn approved_amendment(
	sandbox: &ExecSandbox,
	fact: &SandboxDenialFact,
) -> Option<ApprovedSandboxAmendment> {
	match fact {
		SandboxDenialFact::ReadPath(_) | SandboxDenialFact::WritePath(_) => sandbox
			.freeze_amendment(fact)
			.map(ApprovedSandboxAmendment::Path),
		SandboxDenialFact::Network { host, port } => {
			Some(ApprovedSandboxAmendment::Network(SandboxDenialFact::Network {
				host: host.clone(),
				port: *port,
			}))
		},
		SandboxDenialFact::Unknown => None,
	}
}

fn classify_sandbox_denial(
	sandbox_active: bool,
	broker_denial: Option<SandboxDenialFact>,
	result: &RunTerminal,
	error: Option<&omp_shell::Error>,
	stderr: &[u8],
) -> Option<SandboxDenial> {
	if !sandbox_active {
		return None;
	}
	if let Some(omp_shell::ErrorKind::PathDenied(denied)) = error.map(omp_shell::Error::kind) {
		return Some(SandboxDenial {
			exit_code: None,
			fact:      match denied.access {
				PathAccess::Read => SandboxDenialFact::ReadPath(denied.path.clone()),
				_ => SandboxDenialFact::WritePath(denied.path.clone()),
			},
		});
	}
	let command_failed = matches!(result, RunTerminal::Failed)
		|| matches!(result, RunTerminal::Exited(code) if *code != 0);
	if command_failed && let Some(fact) = broker_denial {
		return Some(SandboxDenial {
			exit_code: match result {
				RunTerminal::Exited(code) => Some(*code),
				_ => None,
			},
			fact,
		});
	}
	let RunTerminal::Exited(exit_code) = result else {
		return None;
	};
	(*exit_code != 0 && sandbox_denial_marker(stderr).is_some()).then_some(SandboxDenial {
		exit_code: Some(*exit_code),
		fact:      SandboxDenialFact::Unknown,
	})
}

fn shell_path_denied_path(stderr: &[u8]) -> Option<Str> {
	let marker = stderr
		.windows(PATH_DENIED_DIAGNOSTIC.len())
		.position(|window| window == PATH_DENIED_DIAGNOSTIC)?;
	let path_start = marker + PATH_DENIED_DIAGNOSTIC.len();
	let path_end = stderr[path_start..]
		.iter()
		.position(|byte| *byte == b'\n' || *byte == b'\r')
		.map_or(stderr.len(), |position| path_start + position);
	let path = String::from_utf8_lossy(&stderr[path_start..path_end]);
	let path = path.trim();
	let path = path.rsplit_once(" to ").map_or(path, |(_, path)| path);
	(!path.is_empty()).then(|| Str::from(path))
}
fn sandbox_denial_marker(stderr: &[u8]) -> Option<usize> {
	const PHRASES: &[&[u8]] = &[
		b"sandbox denied",
		b"x-omp-policy-blocked:",
		b"operation not permitted",
		b"permission denied",
		b"read-only file system",
	];
	const ERRNOS: &[&[u8]] = &[b"eperm", b"eacces", b"erofs"];
	find_marker(stderr, None, true, PHRASES, ERRNOS)
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
	output: Arc<Mutex<OutputCapture>>,
	sequence: Arc<AtomicU64>,
	capture_sandbox_diagnostic: bool,
	scan_network_markers: bool,
) -> Result<(ExecutionParameters, Vec<task::JoinHandle<()>>, Arc<Mutex<OutputSequencer>>), ExecError>
{
	let mut params = ExecutionParameters::default();
	let sequencer = Arc::new(Mutex::new(OutputSequencer {
		next: sequence.load(Ordering::Acquire),
		sequence,
		events,
		output,
		sandbox_diagnostic: capture_sandbox_diagnostic.then(Vec::new),
		network_scan: scan_network_markers.then(NetworkMarkerScan::new),
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

struct OutputCapture {
	stage:             Option<BlobStage>,
	request:           omp_tool::OutputRequest,
	inline_limit:      usize,
	frame_limit:       usize,
	source_bytes:      u64,
	projected_bytes:   usize,
	projected_frames:  usize,
	projection_closed: bool,
	spilled:           bool,
	error:             Option<io::Error>,
}

impl OutputCapture {
	fn new_with_request(
		store: Option<&BlobStore>,
		request: omp_tool::OutputRequest,
	) -> Result<Self, ExecError> {
		let (inline_limit, frame_limit) = match request {
			omp_tool::OutputRequest::Bounded => (LIVE_OUTPUT_BYTES, LIVE_OUTPUT_FRAMES),
			omp_tool::OutputRequest::Complete => (COMPLETE_OUTPUT_BYTES, COMPLETE_OUTPUT_FRAMES),
		};
		Ok(Self {
			stage: store.map(BlobStore::begin_put).transpose()?,
			request,
			inline_limit,
			frame_limit,
			source_bytes: 0,
			projected_bytes: 0,
			projected_frames: 0,
			projection_closed: false,
			spilled: false,
			error: None,
		})
	}

	fn project(&mut self, data: &[u8]) -> Option<Bytes> {
		self.source_bytes = self
			.source_bytes
			.saturating_add(u64::try_from(data.len()).unwrap_or(u64::MAX));
		if let Some(stage) = self.stage.as_mut()
			&& let Err(error) = stage.write_all(data)
		{
			self.error = Some(error);
		}
		if self.projection_closed {
			self.spilled = true;
			return None;
		}
		let remaining = self.inline_limit.saturating_sub(self.projected_bytes);
		let projected = if self.projected_frames < self.frame_limit {
			remaining.min(data.len())
		} else {
			0
		};
		self.projected_bytes += projected;
		self.projected_frames += usize::from(projected != 0);
		self.spilled |= projected < data.len();
		(projected != 0).then(|| Bytes::copy_from_slice(&data[..projected]))
	}

	fn close_projection(&mut self) {
		self.projection_closed = true;
		self.spilled = true;
	}

	fn finish_with_projection(
		&mut self,
	) -> Result<(Option<omp_journal::blob::BlobRef>, v1::OutputProjection), omp_journal::blob::Error>
	{
		if let Some(error) = self.error.take() {
			self.stage.take();
			return Err(error.into());
		}
		let artifact = self.stage.take().map(BlobStage::finish).transpose()?;
		let projection = v1::OutputProjection {
			request:      match self.request {
				omp_tool::OutputRequest::Bounded => v1::OutputRequest::Bounded as i32,
				omp_tool::OutputRequest::Complete => v1::OutputRequest::Complete as i32,
			},
			source_bytes: self.source_bytes,
			inline_bytes: u64::try_from(self.projected_bytes).unwrap_or(u64::MAX),
			omitted:      self.spilled,
			artifact:     artifact.as_ref().map(wire_blob),
			model_text:   None,
		};
		Ok((self.spilled.then_some(artifact).flatten(), projection))
	}
}

struct OutputSequencer {
	next:               u64,
	sequence:           Arc<AtomicU64>,
	events:             flume::Sender<ExecEvent>,
	output:             Arc<Mutex<OutputCapture>>,
	sandbox_diagnostic: Option<Vec<u8>>,
	/// Present while the sandbox confines the network: looks for network
	/// failures in each chunk as it arrives, independently of the capture
	/// above, which stops growing at a denial marker.
	network_scan:       Option<NetworkMarkerScan>,
}
impl OutputSequencer {
	fn capture_sandbox_diagnostic(&mut self, data: &[u8]) {
		if let Some(scan) = self.network_scan.as_mut() {
			scan.feed(data);
		}
		let Some(diagnostic) = self.sandbox_diagnostic.as_mut() else {
			return;
		};
		if shell_path_denied_path(diagnostic).is_some() || sandbox_denial_marker(diagnostic).is_some()
		{
			return;
		}
		diagnostic.extend_from_slice(data);
		if shell_path_denied_path(diagnostic).is_none()
			&& sandbox_denial_marker(diagnostic).is_none()
			&& diagnostic.len() > SANDBOX_DIAGNOSTIC_BYTES
		{
			let discard = diagnostic.len() - SANDBOX_DIAGNOSTIC_BYTES;
			diagnostic.drain(..discard);
		}
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
			if matches!(channel, OutputChannel::Stderr | OutputChannel::Pty) {
				sequencer.capture_sandbox_diagnostic(&buffer[..read]);
			}
			let projected = sequencer.output.lock().project(&buffer[..read]);
			let sequence = sequencer.next;
			sequencer.next += 1;
			sequencer.sequence.store(sequencer.next, Ordering::Release);
			if let Some(data) = projected {
				let event = ExecEvent::Output(OutputFrame {
					exec: exec.clone(),
					channel: channel as i32,
					data,
					sequence,
					props: Default::default(),
				});
				if sequencer.events.try_send(event).is_err() {
					sequencer.output.lock().close_projection();
				}
			}
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
			settle_named_process(
				process.clone(),
				exit_code,
				(cancelled || process.control.cancel_requested.load(Ordering::Acquire)) && !timed_out,
				timed_out,
			);
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
			RunTerminal::Timeout.status(uptime, None)
		} else if cancelled {
			RunTerminal::Cancelled.status(uptime, None)
		} else {
			exit_code
				.map_or(RunTerminal::Failed, RunTerminal::Exited)
				.status(uptime, None)
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
	process
		.restart_pending
		.store(restart_delay.is_some(), Ordering::Release);
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
			host.clear_restart_pending(&process);
			return;
		}
		let Ok((_reservation, current)) = host.reserve_process_generation(&name, process.generation)
		else {
			host.clear_restart_pending(&process);
			return;
		};
		if !Arc::ptr_eq(&current, &process) {
			host.clear_restart_pending(&process);
			return;
		}
		let launched = if detached {
			host
				.launch_detached(name, spec, ready, generation, record.as_ref(), timeout)
				.await
		} else {
			host
				.launch_attached(name, spec, ready, generation, record.as_ref(), timeout)
				.await
		};
		if launched.is_err() {
			host.clear_restart_pending(&process);
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
	let spec = ProcessSpec::decode(record.spec_wire.as_slice()).ok();
	let props = spec.as_ref().and_then(|spec| spec.props.clone());
	let status = ExecStatusMsg::decode(record.status_wire.as_slice()).ok();
	let ready = record
		.ready_wire
		.iter()
		.filter_map(|wire| ReadyProbe::decode(wire.as_slice()).ok())
		.collect();
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
		status,
		identity: Some(record.identity.to_wire()),
		log_start_offset: record.log_start_offset,
		log_end_offset: record.log_end_offset,
		restart_count: record.restart_count,
		consecutive_failures: record.consecutive_failures,
		spec,
		ready,
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

/// Detached scripts re-enter this executable as a hidden in-process shell
/// child (ADR 0028): never `/bin/sh`, never `cmd.exe`.
fn detached_command(source: &str, sandbox: Option<&ExecSandbox>) -> Result<Command, ExecError> {
	let executable = env::current_exe()?;
	let args = crate::shell_child::child_args(source);
	let args = [args[0].as_os_str(), args[1].as_os_str()];
	let mut command = sandbox.map_or_else(
		|| Command::new(&executable),
		|sandbox| sandbox.command(executable.as_os_str(), &args),
	);
	if sandbox.is_none() {
		command.args(args);
	}
	Ok(command)
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
			let pattern =
				Regex::new(&log.pattern).map_err(|error| ExecError::Readiness(fault(error)))?;
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
	// Reject an oversized declaration before waiting for it: otherwise a
	// process declaring a huge length makes the caller buffer its output
	// without bound while this returns `None`.
	if length > FRAME_MAX_BYTES {
		return Err(ExecError::ProbeFrame {
			source: FrameBoundsError::FrameTooLarge { actual: length, limit: FRAME_MAX_BYTES },
		});
	}
	let total = prefix
		.checked_add(length)
		.ok_or_else(|| ExecError::Readiness(sf!("Ping probe frame length overflow")))?;
	if buffer.len() < total {
		return Ok(None);
	}
	let mut framed = buffer.split_to(total);
	framed.advance(prefix);
	validate_worker_frame(&framed).map_err(|source| ExecError::ProbeFrame { source })?;
	WorkerFrame::decode(framed)
		.map(Some)
		.map_err(|source| ExecError::ProbeDecode { source })
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

fn apply_sandbox_environment(
	shell: &mut Shell,
	sandbox: &impl SpawnWrapper,
	scope: EnvironmentScope,
) -> Result<(), omp_shell::Error> {
	let inherited = shell
		.env()
		.iter_exported()
		.map(|(name, variable)| {
			(OsString::from(name), OsString::from(variable.value().to_cow_str(shell).as_ref()))
		})
		.collect::<Vec<_>>();
	let mut resolved = inherited.clone();
	sandbox.resolve_env(&mut resolved);
	let mut effective = resolved.into_iter().collect::<HashMap<_, _>>();
	for (name, value) in inherited {
		let replacement = effective.remove(&name);
		let Some(name) = name.to_str() else { continue };
		match replacement {
			Some(replacement) if replacement == value => {},
			Some(replacement) => {
				let Some(value) = replacement.to_str() else {
					continue;
				};
				let mut variable = ShellVariable::new(value);
				variable.export();
				shell.env_mut().add(name, variable, scope)?;
			},
			None => {
				let mut unset = ShellVariable::new(ShellValue::Unset(ShellValueUnsetType::Untyped));
				unset.export();
				shell.env_mut().add(name, unset, scope)?;
			},
		}
	}
	for (name, value) in effective {
		let Some(name) = name.to_str() else { continue };
		let Some(value) = value.to_str() else {
			continue;
		};
		let mut variable = ShellVariable::new(value);
		variable.export();
		shell.env_mut().add(name, variable, scope)?;
	}
	Ok(())
}

fn apply_amended_proxy_environment(
	shell: &mut Shell,
	sandbox: &impl SpawnWrapper,
	scope: EnvironmentScope,
) -> Result<(), omp_shell::Error> {
	let inherited = shell
		.env()
		.iter_exported()
		.map(|(name, variable)| {
			(OsString::from(name), OsString::from(variable.value().to_cow_str(shell).as_ref()))
		})
		.collect::<Vec<_>>();
	let mut resolved = inherited.clone();
	sandbox.resolve_env(&mut resolved);
	for (name, value) in resolved {
		let Some(name_text) = name.to_str() else {
			continue;
		};
		if !SANDBOX_PROXY_ENV.contains(&name_text)
			|| inherited
				.iter()
				.any(|(current_name, current_value)| current_name == &name && current_value == &value)
		{
			continue;
		}
		let Some(value) = value.to_str() else {
			continue;
		};
		let mut variable = ShellVariable::new(value);
		variable.export();
		shell.env_mut().add(name_text, variable, scope)?;
	}
	Ok(())
}

fn apply_run_environment_delta(
	shell: &mut Shell,
	delta: &EnvironmentDelta,
) -> Result<(), omp_shell::Error> {
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
) -> Result<(), omp_shell::Error> {
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

fn cwd_from_uri(uri: &str) -> Result<Option<PathBuf>, ExecError> {
	if uri.is_empty() {
		return Ok(None);
	}
	if !uri.contains("://") {
		return Ok(Some(PathBuf::from(uri)));
	}
	let parsed = Url::parse(uri).map_err(|_| ExecError::InvalidCwd { uri: Str::from(uri) })?;
	parsed
		.to_file_path()
		.map(Some)
		.map_err(|()| ExecError::InvalidCwd { uri: Str::from(uri) })
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
		_ => Err(ExecError::UnsupportedSignal { signal: Str::from(name) }),
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

fn shell_error(error: omp_shell::Error) -> ExecError {
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
		let write_error: omp_shell::Error = omp_shell::PathDenied {
			path:   denied_path.clone(),
			access: omp_shell::PathAccess::Write,
		}
		.into();
		let denial =
			classify_sandbox_denial(true, None, &RunTerminal::Failed, Some(&write_error), b"")
				.expect("typed write denial");
		assert_eq!(denial.fact, SandboxDenialFact::WritePath(denied_path));
		assert_eq!(denial.exit_code, None);

		let denial = classify_sandbox_denial(
			true,
			None,
			&RunTerminal::Exited(2),
			None,
			b"env/v1 exec: sandbox denied write to /private/handled\n",
		)
		.expect("shell-handled typed write denial");
		assert_eq!(denial.fact, SandboxDenialFact::Unknown);
		assert_eq!(denial.exit_code, Some(2));

		let denial = classify_sandbox_denial(
			true,
			None,
			&RunTerminal::Exited(1),
			None,
			b"touch: /private/blocked: Operation not permitted\n",
		)
		.expect("EPERM-shaped stderr");
		assert_eq!(denial.fact, SandboxDenialFact::Unknown);

		let denial = classify_sandbox_denial(
			true,
			None,
			&RunTerminal::Exited(1),
			None,
			b"X-Omp-Policy-Blocked: api.example.test:8443\r\n",
		)
		.expect("scoped proxy denial");
		assert_eq!(denial.fact, SandboxDenialFact::Unknown);

		let denial = classify_sandbox_denial(
			true,
			Some(SandboxDenialFact::Network { host: sf!("api.example.test"), port: 8443 }),
			&RunTerminal::Exited(1),
			None,
			b"",
		)
		.expect("attempt-scoped broker denial");
		assert_eq!(denial.fact, SandboxDenialFact::Network {
			host: sf!("api.example.test"),
			port: 8443,
		});

		assert!(
			classify_sandbox_denial(
				false,
				None,
				&RunTerminal::Exited(1),
				None,
				b"touch: /private/blocked: Operation not permitted",
			)
			.is_none()
		);
		assert!(
			classify_sandbox_denial(true, None, &RunTerminal::Exited(0), None, b"EPERM",).is_none()
		);
		assert!(
			classify_sandbox_denial(true, None, &RunTerminal::Exited(1), None, b"permission denied",)
				.is_some()
		);
		for diagnostic in [
			b"EACCES".as_slice(),
			b"Permission denied".as_slice(),
			b"EROFS".as_slice(),
			b"Read-only file system".as_slice(),
		] {
			assert!(
				classify_sandbox_denial(true, None, &RunTerminal::Exited(1), None, diagnostic)
					.is_some(),
				"missing denial classification for {diagnostic:?}"
			);
		}
		assert!(
			classify_sandbox_denial(true, None, &RunTerminal::Exited(1), None, b"NOT_EPERMISSION",)
				.is_none()
		);
	}

	/// A broker refusal the user cannot amend never becomes a denial: an
	/// allowlisted name that does not resolve leaves the command `Failed` with
	/// its own exit status, while a policy refusal stays the amendable fact.
	/// The stderr fed to the classifier carries the broker's whole response
	/// head, as `curl -v` prints it, so the fail-closed answer must not carry
	/// the policy marker header. Runs on every host: the broker serves an
	/// environment-only wrapper.
	#[test]
	fn fail_closed_broker_refusals_stay_ordinary_failures() {
		let workspace = tempfile::tempdir().expect("workspace");
		let settings = SandboxSettings {
			allow_domains: vec![Str::new_static("unresolvable.invalid")],
			..SandboxSettings::default()
		};
		let sandbox = ExecSandbox::with_test_broker(&settings, workspace.path());
		let verbose = |head: &str| {
			let mut stderr = String::from("* Establish HTTP proxy tunnel\n");
			for line in head.lines().filter(|line| !line.is_empty()) {
				stderr.push_str("< ");
				stderr.push_str(line);
				stderr.push('\n');
			}
			stderr
		};

		let attempt = sandbox.begin_attempt(None);
		let head = attempt.connect_through_broker("unresolvable.invalid", 443);
		assert!(head.starts_with("HTTP/1.1 502"), "{head}");
		assert!(head.contains("X-Omp-Broker-Refused: unresolved\r\n"), "{head}");
		let facts = attempt.take_facts();
		assert_eq!(facts.denial, None);
		assert_eq!(
			facts.refusal.as_ref().map(|refusal| refusal.cause),
			Some(crate::sandbox_proxy::BrokerRefusal::Unresolved)
		);
		let mut stderr = verbose(&head);
		stderr.push_str("curl: (56) CONNECT tunnel failed, response 502\n");
		let result = RunTerminal::Exited(56);
		assert!(
			classify_sandbox_denial(true, facts.denial, &result, None, stderr.as_bytes()).is_none(),
			"{stderr}"
		);
		let status = result.status(Duration::ZERO, None);
		assert_eq!(status.outcome, ExecOutcome::Failed as i32);
		assert_eq!(status.exit_code, Some(56));
		assert!(status.props.is_none(), "no denied-path label");

		let attempt = sandbox.begin_attempt(None);
		let head = attempt.connect_through_broker("blocked.example", 443);
		assert!(head.starts_with("HTTP/1.1 403"), "{head}");
		assert!(head.contains("X-Omp-Policy-Blocked: blocked.example:443\r\n"), "{head}");
		let facts = attempt.take_facts();
		let fact = SandboxDenialFact::Network { host: sf!("blocked.example"), port: 443 };
		assert_eq!(facts.denial.as_ref(), Some(&fact));
		let denial = classify_sandbox_denial(
			true,
			facts.denial,
			&RunTerminal::Exited(56),
			None,
			verbose(&head).as_bytes(),
		)
		.expect("policy refusal is a denial");
		assert_eq!(denial.fact, fact);
	}

	/// The network scan runs beside the denial capture without changing it:
	/// a resolver failure followed by `Permission denied` still classifies as
	/// an `Unknown` denial, and the network marker is still seen.
	#[test]
	fn network_markers_leave_denial_classification_unchanged() {
		let (events, _receiver) = flume::unbounded();
		let mut sequencer = OutputSequencer {
			next: 1,
			sequence: Arc::new(AtomicU64::new(1)),
			events,
			output: Arc::new(Mutex::new(
				OutputCapture::new_with_request(None, omp_tool::OutputRequest::Bounded)
					.expect("output capture"),
			)),
			sandbox_diagnostic: Some(Vec::new()),
			network_scan: Some(NetworkMarkerScan::new()),
		};
		sequencer.capture_sandbox_diagnostic(b"curl: (6) Could not resolve ");
		sequencer.capture_sandbox_diagnostic(b"host: example.com\n");
		sequencer.capture_sandbox_diagnostic(b"touch: /private/blocked: Permission denied\n");
		let diagnostic = sequencer.sandbox_diagnostic.as_deref().unwrap_or_default();
		let denial = classify_sandbox_denial(true, None, &RunTerminal::Exited(1), None, diagnostic)
			.expect("the denial marker still classifies");
		assert_eq!(denial.fact, SandboxDenialFact::Unknown);
		assert!(
			sequencer
				.network_scan
				.as_ref()
				.is_some_and(NetworkMarkerScan::found)
		);
		assert_eq!(
			diagnostic,
			b"curl: (6) Could not resolve host: example.com\ntouch: /private/blocked: Permission \
			  denied\n"
		);
	}

	fn decision(
		scope: ApprovalScope,
		source: omp_contract::ApprovalSource,
	) -> omp_contract::ApprovalDecision {
		omp_contract::ApprovalDecision {
			approved: true,
			scope,
			source,
			decided_by: Some(sf!("test approver")),
			reason: None,
			audited: false,
		}
	}

	/// Asks `host` to amend one fact through its bound route, answers the
	/// prompt with `answer`, and returns the filed requirement and the grant.
	async fn amend_through_route(
		host: &ExecHost,
		inbox: &omp_contract::ApprovalInbox,
		command: &str,
		fact: &SandboxDenialFact,
		scope: &str,
		answer: omp_contract::ApprovalDecision,
	) -> (ApprovalSpec, Option<AmendmentGrant>) {
		let approval = host.approve_sandbox_amendment(None, command, fact, scope);
		tokio::pin!(approval);
		let request = tokio::select! {
			request = inbox.recv() => request.expect("amendment request"),
			granted = &mut approval => panic!("approval settled before a decision: {granted:?}"),
		};
		let reason = request
			.ticket
			.reasons
			.first()
			.cloned()
			.expect("approval reason");
		request.respond(answer).expect("approval response");
		(reason, approval.await)
	}

	#[tokio::test]
	async fn jit_approval_names_only_the_detected_capability_and_exact_command() {
		let host = ExecHost::new();
		let (route, inbox) = ApprovalRoute::new(Arc::new(omp_contract::ApprovalBook::new()), None);
		host.bind_sandbox_approval_route(Some(route));
		let command = "printf ready; touch /private/blocked";
		let fact = SandboxDenialFact::WritePath(PathBuf::from("/private/blocked"));
		let (reason, granted) = amend_through_route(
			&host,
			&inbox,
			command,
			&fact,
			"/private",
			decision(ApprovalScope::Once, omp_contract::ApprovalSource::User),
		)
		.await;
		assert_eq!(reason.kind, "sandbox_amendment");
		assert_eq!(reason.subject, "/private");
		assert_eq!(reason.pattern.as_deref(), Some(command));
		assert_eq!(reason.evidence, [sf!("write /private/blocked"), sf!("/private")],);
		assert_eq!(granted, Some(AmendmentGrant::Once));

		let command = "curl https://api.example.test/data";
		let fact = SandboxDenialFact::Network { host: sf!("api.example.test"), port: 443 };
		let (reason, granted) = amend_through_route(
			&host,
			&inbox,
			command,
			&fact,
			"network api.example.test:443",
			decision(ApprovalScope::Once, omp_contract::ApprovalSource::User),
		)
		.await;
		assert_eq!(reason.subject, "network api.example.test:443");
		assert_eq!(reason.pattern.as_deref(), Some(command));
		assert_eq!(reason.evidence, [
			sf!("network api.example.test:443"),
			sf!("network api.example.test:443"),
		],);
		assert_eq!(granted, Some(AmendmentGrant::Once));
	}

	/// A network amendment offers `once` and `session`; a path amendment
	/// offers only `once`. A decision is honoured only in a scope its prompt
	/// offered, whether a human made it or the desk replayed a journaled
	/// session grant (source `config`). Only an approved `session` answer on a
	/// network fact extends the binding's grants.
	#[tokio::test]
	async fn network_amendments_offer_the_session_and_paths_stay_once() {
		use omp_contract::ApprovalSource;
		let host = ExecHost::new();
		let (route, inbox) = ApprovalRoute::new(Arc::new(omp_contract::ApprovalBook::new()), None);
		host.bind_sandbox_approval_route(Some(route));
		let grants = host.egress_grants(None).expect("the bound route's grants");
		let network = SandboxDenialFact::Network { host: sf!("pypi.org"), port: 443 };
		let path = SandboxDenialFact::WritePath(PathBuf::from("/private/blocked"));

		let (reason, granted) = amend_through_route(
			&host,
			&inbox,
			"pip install x",
			&network,
			"network pypi.org:443",
			decision(ApprovalScope::Session, ApprovalSource::User),
		)
		.await;
		assert_eq!(reason.scopes, [sf!("once"), sf!("session")]);
		assert_eq!(reason.kind, "sandbox_amendment");
		assert_eq!(reason.subject, "network pypi.org:443");
		assert_eq!(reason.pattern.as_deref(), Some("pip install x"));
		assert!(reason.body.contains("for the rest of this session"), "{}", reason.body);
		assert_eq!(granted, Some(AmendmentGrant::Session));
		assert!(grants.covers("pypi.org", 443), "a session answer extends the binding's grants");

		let replayed = SandboxDenialFact::Network { host: sf!("files.pythonhosted.org"), port: 443 };
		let (_, granted) = amend_through_route(
			&host,
			&inbox,
			"pip install x",
			&replayed,
			"network files.pythonhosted.org:443",
			decision(ApprovalScope::Session, ApprovalSource::Config),
		)
		.await;
		assert_eq!(granted, Some(AmendmentGrant::Session), "a desk replay is honoured");
		assert!(grants.covers("files.pythonhosted.org", 443));

		let once = SandboxDenialFact::Network { host: sf!("once.example"), port: 443 };
		let (_, granted) = amend_through_route(
			&host,
			&inbox,
			"curl https://once.example",
			&once,
			"network once.example:443",
			decision(ApprovalScope::Once, ApprovalSource::User),
		)
		.await;
		assert_eq!(granted, Some(AmendmentGrant::Once));
		assert!(!grants.covers("once.example", 443), "a once answer grants nothing beyond its rerun");

		let (reason, granted) = amend_through_route(
			&host,
			&inbox,
			"touch /private/blocked",
			&path,
			"write /private",
			decision(ApprovalScope::Session, ApprovalSource::User),
		)
		.await;
		assert_eq!(reason.scopes, [sf!("once")]);
		assert_eq!(granted, None, "a path amendment never honours a scope it did not offer");
		let (_, granted) = amend_through_route(
			&host,
			&inbox,
			"touch /private/blocked",
			&path,
			"write /private",
			decision(ApprovalScope::Once, ApprovalSource::User),
		)
		.await;
		assert_eq!(granted, Some(AmendmentGrant::Once));

		for scope in
			[ApprovalScope::Persist, ApprovalScope::Turn, ApprovalScope::Custom(sf!("lease"))]
		{
			let (_, granted) = amend_through_route(
				&host,
				&inbox,
				"curl https://other.example",
				&SandboxDenialFact::Network { host: sf!("other.example"), port: 443 },
				"network other.example:443",
				decision(scope.clone(), ApprovalSource::User),
			)
			.await;
			assert_eq!(granted, None, "{scope:?} was never offered");
		}
		assert!(!grants.covers("other.example", 443));
	}

	/// The rerun budget: a fresh command may be amended for any fact, a
	/// session-approved endpoint lets the command ask again only about a new
	/// network endpoint its binding has not approved, while fewer reruns than
	/// the bound were taken, and a once approval ends the chain.
	#[test]
	fn amendment_reruns_admit_only_new_session_network_endpoints() {
		let network = SandboxDenialFact::Network { host: sf!("pypi.org"), port: 443 };
		let path = SandboxDenialFact::WritePath(PathBuf::from("/private/blocked"));
		let unknown = SandboxDenialFact::Unknown;
		let fresh = AmendmentReruns::Fresh;
		assert!(fresh.admits(&path, false, 4));
		assert!(fresh.admits(&network, false, 4));
		assert!(fresh.admits(&network, true, 4), "a concurrent grant reruns a fresh command");

		let chained = fresh.after_session();
		assert_eq!(chained, AmendmentReruns::SessionNetwork(1));
		assert_eq!(chained.taken(), 1);
		assert!(chained.admits(&network, false, 4));
		assert!(!chained.admits(&network, true, 4), "only an endpoint not yet approved");
		assert!(!chained.admits(&path, false, 4), "a session chain amends no path");
		assert!(!chained.admits(&unknown, false, 4));
		assert!(!chained.admits(&network, false, 1), "a bound of one reruns like once");

		let mut budget = fresh;
		for _ in 0..4 {
			budget = budget.after_session();
		}
		assert_eq!(budget, AmendmentReruns::SessionNetwork(4));
		assert!(!budget.admits(&network, false, 4), "the budget is spent");
		assert!(budget.admits(&network, false, 5));

		assert!(!AmendmentReruns::Spent.admits(&network, false, 4));
		assert!(!AmendmentReruns::Spent.admits(&path, false, 4));
		assert_eq!(AmendmentReruns::Spent.after_session(), AmendmentReruns::Spent);
	}

	/// Rebinding the in-process route starts an empty grant set and clears
	/// the previous one, so a command still holding it loses the grants too.
	/// Revoking clears the bound route's grants and keeps the route.
	#[test]
	fn rebinding_or_revoking_the_route_clears_its_egress_grants() {
		let host = ExecHost::new();
		assert!(host.egress_grants(None).is_none(), "no route, no binding");
		let (route, _inbox) = ApprovalRoute::new(Arc::new(omp_contract::ApprovalBook::new()), None);
		host.bind_sandbox_approval_route(Some(route.clone()));
		let first = host.egress_grants(None).expect("bound grants");
		first.insert("pypi.org", 443);
		assert!(
			host
				.egress_grants(None)
				.is_some_and(|grants| grants.covers("pypi.org", 443))
		);

		host.revoke_route_grants();
		assert!(!first.covers("pypi.org", 443), "a rewind revokes the route's grants");
		assert!(host.amendment_approver(None).is_some(), "revoking keeps the route");

		first.insert("pypi.org", 443);
		host.bind_sandbox_approval_route(Some(route));
		assert!(!first.covers("pypi.org", 443), "the previous binding's grants are cleared");
		let second = host.egress_grants(None).expect("rebound grants");
		assert!(!second.covers("pypi.org", 443), "a new binding starts empty");
		second.insert("pypi.org", 443);
		host.bind_sandbox_approval_route(None);
		assert!(!second.covers("pypi.org", 443));
		assert!(host.egress_grants(None).is_none());
	}

	/// A command's connection relay decides its amendment ahead of the host
	/// route, and once that connection closed the command fails closed
	/// instead of prompting through the host route. A session answer on the
	/// relay extends that connection's grants, never the host route's.
	#[tokio::test]
	async fn a_command_relay_outranks_the_host_route_and_never_falls_back() {
		use v1::server_frame::Body;

		let host = ExecHost::new();
		let (route, inbox) = ApprovalRoute::new(Arc::new(omp_contract::ApprovalBook::new()), None);
		host.bind_sandbox_approval_route(Some(route));
		let (responses, frames) = flume::bounded(4);
		let approvals = crate::approval_relay::ConnectionApprovals::new(responses);
		let relay = approvals.owned(9);
		let command = "touch .git/relayed";
		let fact = SandboxDenialFact::WritePath(PathBuf::from("/workspace/.git/relayed"));
		let approval =
			host.approve_sandbox_amendment(Some(&relay), command, &fact, "/workspace/.git");
		tokio::pin!(approval);
		let query = tokio::select! {
			frame = frames.recv_async() => frame.expect("relayed query"),
			granted = &mut approval => panic!("relayed approval settled early: {granted:?}"),
		};
		assert_eq!(query.request_id, 9);
		let Some(Body::ApprovalQuery(query)) = query.body else {
			panic!("the relay sent no approval query: {:?}", query.body);
		};
		assert_eq!(query.invocation_id, None);
		assert_eq!(query.reasons[0].kind, "sandbox_amendment");
		assert_eq!(query.reasons[0].subject, "/workspace/.git");
		assert_eq!(query.reasons[0].scopes, ["once"]);
		approvals.answer(9, v1::ApprovalAnswer {
			query_id: query.query_id,
			decision: Some(v1::ApprovalDecision {
				approved: true,
				scope: "once".to_owned(),
				source: "user".to_owned(),
				..v1::ApprovalDecision::default()
			}),
		});
		assert_eq!(approval.await, Some(AmendmentGrant::Once));
		assert!(inbox.try_recv().is_err(), "the host route was asked although a relay exists");

		let network = SandboxDenialFact::Network { host: sf!("pypi.org"), port: 443 };
		let approval = host.approve_sandbox_amendment(
			Some(&relay),
			"pip install x",
			&network,
			"network pypi.org:443",
		);
		tokio::pin!(approval);
		let query = tokio::select! {
			frame = frames.recv_async() => frame.expect("relayed network query"),
			granted = &mut approval => panic!("relayed approval settled early: {granted:?}"),
		};
		let Some(Body::ApprovalQuery(query)) = query.body else {
			panic!("the relay sent no approval query: {:?}", query.body);
		};
		assert_eq!(query.reasons[0].scopes, ["once", "session"]);
		approvals.answer(9, v1::ApprovalAnswer {
			query_id: query.query_id,
			decision: Some(v1::ApprovalDecision {
				approved: true,
				scope: "session".to_owned(),
				source: "user".to_owned(),
				..v1::ApprovalDecision::default()
			}),
		});
		assert_eq!(approval.await, Some(AmendmentGrant::Session));
		assert!(relay.grants().covers("pypi.org", 443), "the connection holds the grant");
		assert!(
			host
				.egress_grants(None)
				.is_some_and(|grants| !grants.covers("pypi.org", 443)),
			"the host route never inherits a connection's grant"
		);
		assert!(
			host
				.egress_grants(Some(&approvals.owned(10)))
				.is_some_and(|grants| grants.covers("pypi.org", 443)),
			"every command of the connection carries its grants"
		);

		approvals.disconnect();
		assert!(!relay.grants().covers("pypi.org", 443), "a closed connection keeps no grant");
		assert_eq!(
			host
				.approve_sandbox_amendment(Some(&relay), command, &fact, "/workspace/.git")
				.await,
			None
		);
		assert!(inbox.try_recv().is_err(), "a closed relay fell back to the host route");
	}

	#[test]
	fn terminal_receipts_distinguish_exit_failure_timeout_and_cancellation() {
		let success = RunTerminal::Exited(0).status(Duration::from_millis(1), None);
		assert_eq!(success.outcome, ExecOutcome::Exited as i32);
		assert_eq!(success.exit_code, Some(0));
		assert!(success.signal.is_empty());
		assert!(!success.aborted);

		let failure = RunTerminal::Exited(17).status(Duration::from_millis(2), None);
		assert_eq!(failure.outcome, ExecOutcome::Failed as i32);
		assert_eq!(failure.exit_code, Some(17));
		assert!(failure.signal.is_empty());
		assert!(!failure.aborted);

		let timeout = RunTerminal::Timeout.status(Duration::from_millis(3), None);
		assert_eq!(timeout.outcome, ExecOutcome::Timeout as i32);
		assert_eq!(timeout.exit_code, None);
		assert_eq!(timeout.signal, "SIGKILL");
		assert!(timeout.aborted);

		let cancelled = RunTerminal::Cancelled.status(Duration::from_millis(4), None);
		assert_eq!(cancelled.outcome, ExecOutcome::Cancelled as i32);
		assert_eq!(cancelled.exit_code, None);
		assert_eq!(cancelled.signal, "");
		assert!(cancelled.aborted);

		let denied = RunTerminal::Denied {
			exit_code: Some(1),
			fact:      SandboxDenialFact::WritePath(PathBuf::from("/private/blocked")),
		}
		.status(Duration::from_millis(5), None);
		assert_eq!(denied.outcome, ExecOutcome::Denied as i32);
		assert_eq!(denied.exit_code, Some(1));
		assert_eq!(
			denied
				.props
				.as_ref()
				.and_then(|props| props.fields.get(SANDBOX_DENIED_PATH_PROP))
				.and_then(|value| value.kind.as_ref()),
			Some(&wire_value::Kind::String(String::from("write /private/blocked")))
		);
	}

	#[tokio::test]
	async fn typed_kill_cancels_in_process_builtin() {
		let root = tempfile::tempdir().expect("workspace creates");
		let host = ExecHost::default();
		let session = host
			.open_session(OpenSessionRequest {
				cwd_uri: Url::from_directory_path(root.path())
					.expect("root URI")
					.to_string(),
				..OpenSessionRequest::default()
			})
			.await
			.expect("session opens")
			.session;
		let (started, run) = host
			.exec(script_request(&session, "sleep 30"), None)
			.await
			.expect("builtin starts");
		let exec = match run.next_event().await {
			Some(ExecEvent::Started { exec_id }) => exec_id,
			other => panic!("expected started event, got {other:?}"),
		};
		assert_eq!(started.exec, exec);

		let result = host
			.control(&ExecControlRequest {
				exec,
				control: ExecControlKind::Kill as i32,
				grace_ms: 0,
				wire_revision: omp_proto::SCHEMA_REV,
				..ExecControlRequest::default()
			})
			.expect("typed kill is accepted");
		{
			assert!(result.accepted);
			let (_, external_run) = host
				.exec(script_request(&session, "/bin/sleep 30"), None)
				.await
				.expect("external command starts");
			let external_exec = match external_run.next_event().await {
				Some(ExecEvent::Started { exec_id }) => exec_id,
				other => panic!("expected external started event, got {other:?}"),
			};
			let external_control = host
				.control(&ExecControlRequest {
					exec: external_exec,
					control: ExecControlKind::Kill as i32,
					grace_ms: 0,
					wire_revision: omp_proto::SCHEMA_REV,
					..ExecControlRequest::default()
				})
				.expect("external typed kill is accepted");
			assert!(external_control.accepted);
			let external_exit = time::timeout(Duration::from_secs(1), async {
				loop {
					match external_run.next_event().await {
						Some(ExecEvent::Exit(event)) => break event,
						Some(ExecEvent::Output(_) | ExecEvent::Started { .. }) => {},
						None => panic!("external exec stream closed before exit"),
					}
				}
			})
			.await
			.expect("external typed kill reaches terminal");
			assert_eq!(
				external_exit.status.expect("external exit status").outcome,
				ExecOutcome::Cancelled as i32
			);
		}

		let exit = time::timeout(Duration::from_secs(1), async {
			loop {
				match run.next_event().await {
					Some(ExecEvent::Exit(event)) => break event,
					Some(ExecEvent::Output(_)) | Some(ExecEvent::Started { .. }) => {},
					None => panic!("exec stream closed before exit"),
				}
			}
		})
		.await
		.expect("typed kill reaches a builtin within one second");
		assert_eq!(exit.status.expect("exit status").outcome, ExecOutcome::Cancelled as i32);
		host.close_session(&session).expect("session closes");
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
	async fn run_failure(
		host: &ExecHost,
		request: ExecRequest,
	) -> (i32, Option<i32>, Vec<u8>, Vec<v1::ToolDiag>) {
		let (_, run) = host.exec(request, None).await.expect("exec starts");
		let mut output = Vec::new();
		loop {
			match run.next_event().await {
				Some(ExecEvent::Output(frame)) => output.extend_from_slice(&frame.data),
				Some(ExecEvent::Exit(event)) => {
					let status = event.status.expect("exit status");
					return (status.outcome, status.exit_code, output, status.diags);
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

		// Software lane: the same redirection into the carve-out is denied.
		let (outcome, exit, output, diags) =
			run_failure(&host, script_request(session, "echo no > .git/blocked.txt")).await;
		assert_eq!(outcome, ExecOutcome::Denied as i32);
		assert_ne!(exit, Some(0));
		let output = String::from_utf8_lossy(&output);
		assert!(output.contains("sandbox denied write"));
		assert!(output.contains(".git/blocked.txt"));
		assert!(!output.contains("sandbox: backend="));
		assert_eq!(diags.len(), 1);
		assert_eq!(diags[0].kind, "sandbox");
		assert!(diags[0].text.contains("sandbox: backend="));
		assert!(!workspace.join(".git/blocked.txt").exists());

		// The one-time session note must not change ordinary command behavior.
		assert_eq!(
			run_exit_code(&host, script_request(session, "echo ok > allowed.txt")).await,
			Some(0)
		);
		assert_eq!(fs::read(workspace.join("allowed.txt")).unwrap(), b"ok\n");
		assert_eq!(
			run_exit_code(&host, script_request(session, "[ -z \"${MY_TOKEN+x}\" ]")).await,
			Some(0)
		);

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

		// Environment policy applies before shell expansion and child launch.
		assert_eq!(
			run_output(&host, script_request(session, "printf '%s' \"$MY_TOKEN\"")).await,
			b""
		);
		assert_ne!(
			run_exit_code(&host, script_request(session, "/usr/bin/printenv MY_TOKEN")).await,
			Some(0)
		);
		host.close_session(&opened.session).expect("session closes");
	}

	/// Live Seatbelt proof that the default workspace-write sandbox runs a
	/// program reached through a Homebrew-shaped PATH link, and from a cwd that
	/// crosses a keg link, without asking for an amendment: no approval route
	/// is bound, so a refused read would end the command as `Denied`.
	#[cfg(target_os = "macos")]
	#[tokio::test]
	async fn sandboxed_session_runs_programs_reached_through_symlinks() {
		if !omp_sandbox::backend_status(omp_sandbox::Backend::Seatbelt).is_available() {
			return;
		}
		let root = tempfile::tempdir().unwrap();
		let workspace = root.path().canonicalize().unwrap();
		let tools = tempfile::tempdir().unwrap();
		let prefix = crate::exec_sandbox::homebrew_shaped_prefix(tools.path());
		let host = ExecHost::new();
		host.configure_sandbox(&crate::exec_settings::SandboxSettings::default(), &workspace);
		let opened = host
			.open_session(OpenSessionRequest {
				cwd_uri: Url::from_directory_path(&workspace).unwrap().to_string(),
				env_delta: Some(EnvironmentDelta {
					set: BTreeMap::from([(
						String::from("PATH"),
						format!("{}:/usr/bin:/bin", prefix.join("bin").display()),
					)]),
					..EnvironmentDelta::default()
				}),
				..OpenSessionRequest::default()
			})
			.await
			.expect("sandboxed session opens");
		let session = &opened.session;
		let (outcome, exit, output, diags) =
			run_failure(&host, script_request(session, "tool ok")).await;
		assert_eq!(outcome, ExecOutcome::Exited as i32, "{}", String::from_utf8_lossy(&output));
		assert_eq!(exit, Some(0));
		assert_eq!(output, b"ok\n");
		assert_eq!(diags.len(), 1);
		assert!(diags[0].text.contains("backend=seatbelt"), "{}", diags[0].text);
		let linked_cwd = format!("cd {}/opt/tool/bin && echo * && ./tool linked", prefix.display());
		assert_eq!(run_output(&host, script_request(session, &linked_cwd)).await, b"tool\nlinked\n");
		host.close_session(session).expect("session closes");
	}

	/// Live Seatbelt proof that network trouble under the default scoped
	/// network reaches the model as `sandbox` diags, offline: the broker
	/// refuses a host outside the allowlist before resolving it, and a
	/// `.invalid` name never resolves. No approval route is bound, so a failed
	/// refusal ends `Denied` and the remedy offers no prompt. A refusal is
	/// explained in full once; a repeat adds one line on failure and nothing
	/// on success. An allowed name that does not resolve stays `Failed` even
	/// when curl prints the broker's response headers.
	#[cfg(target_os = "macos")]
	#[tokio::test]
	async fn scoped_network_trouble_reaches_the_model_as_sandbox_diags() {
		if !omp_sandbox::backend_status(omp_sandbox::Backend::Seatbelt).is_available() {
			return;
		}
		let root = tempfile::tempdir().unwrap();
		let workspace = root.path().canonicalize().unwrap();
		let host = ExecHost::new();
		host.configure_sandbox(
			&crate::exec_settings::SandboxSettings {
				allow_domains: vec![Str::new_static("unresolvable.invalid")],
				..crate::exec_settings::SandboxSettings::default()
			},
			&workspace,
		);
		let opened = host
			.open_session(OpenSessionRequest {
				cwd_uri: Url::from_directory_path(&workspace).unwrap().to_string(),
				..OpenSessionRequest::default()
			})
			.await
			.expect("sandboxed session opens");
		let session = &opened.session;
		let texts = |diags: &[v1::ToolDiag]| {
			diags
				.iter()
				.map(|diag| format!("{}/{}: {}", diag.kind, diag.severity, diag.text))
				.collect::<Vec<_>>()
		};

		// Plain HTTP through the broker: curl without `-f` exits 0 on its 403,
		// and the refusal is still reported, as information.
		let (outcome, exit, output, diags) = run_failure(
			&host,
			script_request(session, "/usr/bin/curl -sS -o /dev/null http://blocked.invalid/"),
		)
		.await;
		assert_eq!(outcome, ExecOutcome::Exited as i32, "{}", String::from_utf8_lossy(&output));
		assert_eq!(exit, Some(0));
		assert_eq!(diags.len(), 2, "{:?}", texts(&diags));
		assert!(diags[0].text.contains("sandbox: backend=seatbelt"), "{:?}", texts(&diags));
		assert_eq!(diags[1].kind, "sandbox");
		assert_eq!(diags[1].severity, v1::ToolDiagSeverity::Info as i32);
		assert!(diags[1].text.contains("blocked.invalid:80"), "{:?}", texts(&diags));
		assert!(diags[1].text.contains("sv_sandbox_network_mode scoped"));
		assert!(diags[1].text.contains("no approval prompt"));

		// The same refusal failing the command ends it `Denied`, with one line.
		let (outcome, _, output, diags) = run_failure(
			&host,
			script_request(session, "/usr/bin/curl -sSf -o /dev/null http://blocked.invalid/"),
		)
		.await;
		assert_eq!(outcome, ExecOutcome::Denied as i32, "{}", String::from_utf8_lossy(&output));
		assert_eq!(diags.len(), 1, "{:?}", texts(&diags));
		assert_eq!(diags[0].severity, v1::ToolDiagSeverity::Warn as i32);
		assert!(
			diags[0]
				.text
				.contains("blocked.invalid:80 failed at the egress broker again")
		);
		assert!(!diags[0].text.contains("sv_sandbox_allow_domains"), "{:?}", texts(&diags));

		// Succeeding on it again adds nothing.
		let (outcome, exit, output, diags) = run_failure(
			&host,
			script_request(session, "/usr/bin/curl -sS -o /dev/null http://blocked.invalid/"),
		)
		.await;
		assert_eq!(outcome, ExecOutcome::Exited as i32, "{}", String::from_utf8_lossy(&output));
		assert_eq!(exit, Some(0));
		assert!(diags.is_empty(), "{:?}", texts(&diags));

		// An allowed name that does not resolve: curl prints the broker's
		// response headers, and the command still ends `Failed`, not `Denied`.
		let (outcome, exit, output, diags) = run_failure(
			&host,
			script_request(session, "/usr/bin/curl -sSfv -o /dev/null http://unresolvable.invalid/"),
		)
		.await;
		let printed = String::from_utf8_lossy(&output);
		assert_eq!(outcome, ExecOutcome::Failed as i32, "{printed}");
		assert_eq!(exit, Some(22), "{printed}");
		assert!(printed.contains("X-Omp-Broker-Refused: unresolved"), "{printed}");
		assert!(
			!printed
				.to_ascii_lowercase()
				.contains("x-omp-policy-blocked"),
			"{printed}"
		);
		assert_eq!(diags.len(), 1, "{:?}", texts(&diags));
		assert_eq!(diags[0].severity, v1::ToolDiagSeverity::Warn as i32);
		assert!(
			diags[0]
				.text
				.contains("could not resolve unresolvable.invalid:80"),
			"{:?}",
			texts(&diags)
		);

		// A client that ignores the proxy environment gets the generic text,
		// once per session.
		let nc = "/usr/bin/nc -z -G 2 blocked.invalid 80";
		let (outcome, _, output, diags) = run_failure(&host, script_request(session, nc)).await;
		assert_eq!(outcome, ExecOutcome::Failed as i32, "{}", String::from_utf8_lossy(&output));
		assert_eq!(diags.len(), 1, "{:?}", texts(&diags));
		assert_eq!(diags[0].severity, v1::ToolDiagSeverity::Warn as i32);
		assert!(diags[0].text.contains("HTTP_PROXY"), "{:?}", texts(&diags));
		let (outcome, _, _, diags) = run_failure(&host, script_request(session, nc)).await;
		assert_eq!(outcome, ExecOutcome::Failed as i32);
		assert!(diags.is_empty(), "{:?}", texts(&diags));
		host.close_session(session).expect("session closes");
	}

	fn diag_texts(diags: &[v1::ToolDiag]) -> Vec<String> {
		diags
			.iter()
			.map(|diag| format!("{}/{}: {}", diag.kind, diag.severity, diag.text))
			.collect()
	}

	/// The network diags among `diags`: every generic or locator text names
	/// `sv_sandbox_network_mode`, while the session note and other diags do
	/// not.
	fn network_diags(diags: &[v1::ToolDiag]) -> Vec<String> {
		diags
			.iter()
			.filter(|diag| diag.text.contains("sv_sandbox_network_mode"))
			.map(|diag| format!("{}/{}: {}", diag.kind, diag.severity, diag.text))
			.collect()
	}

	/// Opens an unsandboxed session and gives it `sandbox`, which commands
	/// issued from then on run under.
	async fn session_under(host: &ExecHost, root: &Path, sandbox: Arc<ExecSandbox>) -> Bytes {
		let opened = host
			.open_session(OpenSessionRequest {
				cwd_uri: Url::from_directory_path(root)
					.expect("root URI")
					.to_string(),
				..OpenSessionRequest::default()
			})
			.await
			.expect("session opens");
		host
			.inner
			.sessions
			.lock()
			.get_mut(&opened.session)
			.expect("open session")
			.sandbox = Some(sandbox);
		opened.session
	}

	/// ADR 0028 (2026-10-08, disabled-network diag): a session with no network
	/// has no broker to record a refused fetch, and a quiet client (`curl -s`)
	/// prints no marker, so a failed command that launched a program with a
	/// network URL among its arguments gets the mode's locator text, once per
	/// session. A success (a pipeline whose last stage succeeds included), a
	/// failure without a URL, a URL that is only text, a builtin given one, a
	/// program that cannot run, one the session's file policy hides (a read
	/// denial, `exec` included) and a `scoped` session report nothing.
	/// Runs on every unix host: the sandbox is an environment-only wrapper that
	/// reports a disabled network, and `/usr/bin/false` stands in for a client
	/// failing quietly on a host it cannot reach.
	#[cfg(unix)]
	#[tokio::test]
	async fn silent_network_failures_without_a_network_get_one_sandbox_diag() {
		use std::os::unix::fs::PermissionsExt as _;

		let root = tempfile::tempdir().expect("workspace");
		let hidden = root.path().join("hidden");
		std::fs::create_dir(&hidden).expect("hidden root");
		let hidden_client = hidden.join("fetch");
		std::fs::write(&hidden_client, "#!/bin/sh\nexit 1\n").expect("hidden client");
		std::fs::set_permissions(&hidden_client, std::fs::Permissions::from_mode(0o755))
			.expect("hidden client is executable");
		let host = ExecHost::new();
		let disabled = crate::exec_settings::SandboxSettings {
			network_mode: crate::exec_settings::SandboxNetworkMode::Disabled,
			read_deny: vec![Str::from(hidden.to_string_lossy().as_ref())],
			..crate::exec_settings::SandboxSettings::default()
		};
		let session = session_under(
			&host,
			root.path(),
			ExecSandbox::with_test_disabled_network(&disabled, root.path()),
		)
		.await;
		let run = |text: &str| run_failure(&host, script_request(&session, text));

		// A success given a URL reports nothing beyond the session note.
		let (outcome, exit, output, diags) = run("/usr/bin/true -sI https://example.invalid").await;
		assert_eq!(outcome, ExecOutcome::Exited as i32, "{}", String::from_utf8_lossy(&output));
		assert_eq!(exit, Some(0));
		assert_eq!(diags.len(), 1, "{:?}", diag_texts(&diags));
		assert!(diags[0].text.contains("network=disabled"), "{:?}", diag_texts(&diags));
		// Failures without a launched URL report nothing.
		for script in [
			"/usr/bin/false",
			"/usr/bin/false 'see https://example.invalid' --url=https://example.invalid",
			"false https://example.invalid",
		] {
			let (outcome, exit, _, diags) = run(script).await;
			assert_eq!(outcome, ExecOutcome::Failed as i32, "{script}");
			assert_eq!(exit, Some(1), "{script}");
			assert!(diags.is_empty(), "{script}: {:?}", diag_texts(&diags));
		}
		// A program that cannot run never reached the network: a missing one
		// (127), an `exec` of a bare name no `PATH` directory holds (127) and a
		// script without its exec bit (126) fail with no network diag. Only the
		// exit and the absent diag are this rule's; how the failure is
		// classified is not.
		std::fs::write(root.path().join("fetch.sh"), "#!/bin/sh\nexit 1\n").expect("script");
		for (script, code) in [
			("/nonexistent/wget -q https://example.invalid", 127),
			("exec omp-no-such-client -q https://example.invalid", 127),
			("./fetch.sh -q https://example.invalid", 126),
		] {
			let (outcome, exit, output, diags) = run(script).await;
			assert_ne!(
				outcome,
				ExecOutcome::Exited as i32,
				"{script}: {}",
				String::from_utf8_lossy(&output)
			);
			assert_eq!(exit, Some(code), "{script}");
			assert!(network_diags(&diags).is_empty(), "{script}: {:?}", diag_texts(&diags));
		}
		// Nor does a program the session's file policy hides. The shell reads
		// every program it launches through that policy first, `exec` included,
		// so the launch ends in a read denial before anything runs. The
		// environment-only wrapper enforces nothing, so only that check keeps
		// the client from running here.
		for script in [
			format!("exec {} -q https://example.invalid", hidden_client.display()),
			format!("{} -q https://example.invalid", hidden_client.display()),
		] {
			let (outcome, exit, output, diags) = run(&script).await;
			let output = String::from_utf8_lossy(&output);
			assert_eq!(outcome, ExecOutcome::Denied as i32, "{script}: {output}");
			assert_ne!(exit, Some(0), "{script}");
			assert!(output.contains("sandbox denied read"), "{script}: {output}");
			assert!(network_diags(&diags).is_empty(), "{script}: {:?}", diag_texts(&diags));
		}
		// A pipeline whose last stage succeeds ends `Succeeded`, so a quiet
		// client that failed before it reports nothing (ADR 0028, 2026-10-08
		// amendment, point 4).
		let (outcome, exit, _, diags) =
			run("/usr/bin/false -s https://example.invalid | /bin/cat").await;
		assert_eq!(outcome, ExecOutcome::Exited as i32);
		assert_eq!(exit, Some(0));
		assert!(diags.is_empty(), "{:?}", diag_texts(&diags));

		// A quiet failure after launching a program with a URL, expanded from a
		// variable, is explained once.
		let quiet = "url=https://example.invalid; /usr/bin/false -sI --max-time 20 \"$url\"";
		let (outcome, exit, output, diags) = run(quiet).await;
		assert_eq!(outcome, ExecOutcome::Failed as i32);
		assert_eq!(exit, Some(1));
		assert!(output.is_empty(), "{}", String::from_utf8_lossy(&output));
		assert_eq!(diags.len(), 1, "{:?}", diag_texts(&diags));
		assert_eq!(diags[0].kind, "sandbox");
		assert_eq!(diags[0].severity, v1::ToolDiagSeverity::Warn as i32);
		assert!(
			diags[0]
				.text
				.starts_with("sandbox: the command failed after running a program given a network URL"),
			"{:?}",
			diag_texts(&diags)
		);
		assert!(
			diags[0]
				.text
				.contains("sv_sandbox_network_mode is disabled"),
			"{:?}",
			diag_texts(&diags)
		);
		for script in [quiet, "/usr/bin/false https://other.invalid/"] {
			let (outcome, _, _, diags) = run(script).await;
			assert_eq!(outcome, ExecOutcome::Failed as i32, "{script}");
			assert!(diags.is_empty(), "once per session: {script}: {:?}", diag_texts(&diags));
		}
		host.close_session(&session).expect("session closes");

		// Under `scoped` the broker is the signal: the same quiet failure adds
		// nothing beyond the session note.
		let session = session_under(
			&host,
			root.path(),
			ExecSandbox::with_test_broker(
				&crate::exec_settings::SandboxSettings::default(),
				root.path(),
			),
		)
		.await;
		let (outcome, _, _, diags) =
			run_failure(&host, script_request(&session, "/usr/bin/false -sI https://example.invalid"))
				.await;
		assert_eq!(outcome, ExecOutcome::Failed as i32);
		assert_eq!(diags.len(), 1, "{:?}", diag_texts(&diags));
		assert!(diags[0].text.contains("network=scoped"), "{:?}", diag_texts(&diags));
		host.close_session(&session).expect("session closes");
	}

	/// Live Seatbelt proof of the observed case: under
	/// `sv_sandbox_network_mode disabled`, `curl -sI` fails without a word (no
	/// DNS, exit 6), and the session still tells the model why, once, while a
	/// program that does not exist, which `sandbox-exec` fails to exec after
	/// its own spawn succeeded, gets nothing. Offline: `.invalid` names never
	/// resolve.
	#[cfg(target_os = "macos")]
	#[tokio::test]
	async fn quiet_clients_under_a_disabled_network_reach_the_model_as_a_sandbox_diag() {
		if !omp_sandbox::backend_status(omp_sandbox::Backend::Seatbelt).is_available() {
			return;
		}
		let root = tempfile::tempdir().unwrap();
		let workspace = root.path().canonicalize().unwrap();
		let host = ExecHost::new();
		host.configure_sandbox(
			&crate::exec_settings::SandboxSettings {
				network_mode: crate::exec_settings::SandboxNetworkMode::Disabled,
				..crate::exec_settings::SandboxSettings::default()
			},
			&workspace,
		);
		let opened = host
			.open_session(OpenSessionRequest {
				cwd_uri: Url::from_directory_path(&workspace).unwrap().to_string(),
				..OpenSessionRequest::default()
			})
			.await
			.expect("sandboxed session opens");
		let session = &opened.session;
		// A program that does not exist never reached the network. The
		// launcher's own spawn succeeds and only its exec of the program fails,
		// so the session note is all this failure gets.
		let missing = "/nonexistent/curl -sI --max-time 20 https://example.invalid";
		let (outcome, exit, output, diags) =
			run_failure(&host, script_request(session, missing)).await;
		assert_eq!(outcome, ExecOutcome::Failed as i32, "{}", String::from_utf8_lossy(&output));
		assert_ne!(exit, Some(0));
		assert_eq!(diags.len(), 1, "{:?}", diag_texts(&diags));
		assert!(diags[0].text.contains("backend=seatbelt"), "{:?}", diag_texts(&diags));
		assert!(diags[0].text.contains("network=disabled"), "{:?}", diag_texts(&diags));

		let curl = "/usr/bin/curl -sI --max-time 20 https://example.invalid";
		let (outcome, exit, output, diags) = run_failure(&host, script_request(session, curl)).await;
		assert_eq!(outcome, ExecOutcome::Failed as i32, "{}", String::from_utf8_lossy(&output));
		assert_eq!(exit, Some(6));
		assert!(output.is_empty(), "{}", String::from_utf8_lossy(&output));
		assert_eq!(diags.len(), 1, "{:?}", diag_texts(&diags));
		assert_eq!(diags[0].kind, "sandbox");
		assert_eq!(diags[0].severity, v1::ToolDiagSeverity::Warn as i32);
		assert!(diags[0].text.contains("network URL"), "{:?}", diag_texts(&diags));
		assert!(
			diags[0]
				.text
				.contains("sv_sandbox_network_mode is disabled"),
			"{:?}",
			diag_texts(&diags)
		);
		let (outcome, _, _, diags) = run_failure(&host, script_request(session, curl)).await;
		assert_eq!(outcome, ExecOutcome::Failed as i32);
		assert!(diags.is_empty(), "{:?}", diag_texts(&diags));
		host.close_session(session).expect("session closes");
	}

	/// Live Seatbelt: `read_deny` roots deny both `file-read*` and
	/// `process-exec*`, so the kernel refuses both reads and native execution
	/// behind them. The shell never launches one, and even a non-shell launcher
	/// (such as `xargs` or `env`) cannot exec the hidden binary. The same
	/// binary outside the root runs. The binary is this test executable, hard
	/// linked beside itself (one volume, no copy) and asked only to list tests.
	#[cfg(target_os = "macos")]
	#[tokio::test]
	async fn native_programs_behind_read_deny_never_run_under_seatbelt() {
		if !omp_sandbox::backend_status(omp_sandbox::Backend::Seatbelt).is_available() {
			return;
		}
		let test_binary = std::env::current_exe().expect("the test binary runs");
		let root = tempfile::tempdir_in(
			test_binary
				.parent()
				.expect("the test binary has a directory"),
		)
		.expect("workspace beside the test binary");
		let workspace = root.path().canonicalize().unwrap();
		let hidden = workspace.join("hidden");
		std::fs::create_dir(&hidden).expect("hidden root");
		let hidden_client = hidden.join("client");
		let admitted_client = workspace.join("client");
		for link in [&hidden_client, &admitted_client] {
			std::fs::hard_link(&test_binary, link).expect("native client");
		}
		let host = ExecHost::new();
		host.configure_sandbox(
			&crate::exec_settings::SandboxSettings {
				network_mode: crate::exec_settings::SandboxNetworkMode::Disabled,
				read_deny: vec![Str::from(hidden.to_string_lossy().as_ref())],
				..crate::exec_settings::SandboxSettings::default()
			},
			&workspace,
		);
		let opened = host
			.open_session(OpenSessionRequest {
				cwd_uri: Url::from_directory_path(&workspace).unwrap().to_string(),
				..OpenSessionRequest::default()
			})
			.await
			.expect("sandboxed session opens");
		let session = &opened.session;

		let admitted = format!("exec {} --list https://example.invalid", admitted_client.display());
		let (outcome, exit, output, _) = run_failure(&host, script_request(session, &admitted)).await;
		assert_eq!(outcome, ExecOutcome::Exited as i32, "{}", String::from_utf8_lossy(&output));
		assert_eq!(exit, Some(0));
		for script in [
			format!("exec {} --list https://example.invalid", hidden_client.display()),
			format!("{} --list https://example.invalid", hidden_client.display()),
		] {
			let (outcome, exit, output, diags) =
				run_failure(&host, script_request(session, &script)).await;
			let output = String::from_utf8_lossy(&output);
			assert_eq!(outcome, ExecOutcome::Denied as i32, "{script}: {output}");
			assert_ne!(exit, Some(0), "{script}");
			assert!(output.contains("sandbox denied read"), "{script}: {output}");
			assert!(network_diags(&diags).is_empty(), "{script}: {:?}", diag_texts(&diags));
		}
		host.close_session(session).expect("session closes");
	}

	/// Runs in-process builtins on a file behind `read_deny` and on its
	/// admitted twin: each read of the hidden file ends `Denied` with the
	/// shell's read denial and none of its bytes, and the twin reads. The
	/// builtins run inside this process, so no kernel backend stands between
	/// them and the file; only the session's path policy refuses them.
	#[cfg(unix)]
	async fn builtin_reads_behind_read_deny_end_denied(host: &ExecHost, session: &Bytes) {
		for script in
			["cat secret/key", "head -n 1 secret/key", "grep omp secret/key", "wc -c secret/key"]
		{
			let (outcome, exit, output, _) = run_failure(host, script_request(session, script)).await;
			let output = String::from_utf8_lossy(&output);
			assert_eq!(outcome, ExecOutcome::Denied as i32, "{script}: {output}");
			assert_ne!(exit, Some(0), "{script}");
			assert!(output.contains("sandbox denied read"), "{script}: {output}");
			assert!(!output.contains("omp-secret-marker"), "{script}: {output}");
		}
		assert_eq!(
			run_output(host, script_request(session, "cat public/key")).await,
			b"omp-secret-marker\n"
		);
	}

	/// A workspace holding `secret/key` (the `read_deny` root) and an identical
	/// admitted `public/key`.
	#[cfg(unix)]
	fn read_deny_workspace() -> (tempfile::TempDir, PathBuf) {
		let root = tempfile::tempdir().expect("workspace");
		let workspace = root.path().canonicalize().expect("canonical workspace");
		for dir in ["secret", "public"] {
			fs::create_dir(workspace.join(dir)).expect("directory");
			fs::write(workspace.join(dir).join("key"), "omp-secret-marker\n").expect("key");
		}
		(root, workspace)
	}

	/// `cat <read_deny root>/file` in an exec session under the default
	/// `workspace-write` sandbox ends `Denied`. Live Seatbelt.
	#[cfg(target_os = "macos")]
	#[tokio::test]
	async fn builtin_reads_behind_read_deny_end_denied_under_workspace_write() {
		use crate::exec_settings::{ExecSandboxMode, SandboxSettings};

		if !omp_sandbox::backend_status(omp_sandbox::Backend::Seatbelt).is_available() {
			return;
		}
		let (_root, workspace) = read_deny_workspace();
		let host = ExecHost::new();
		host.configure_sandbox(
			&SandboxSettings {
				mode: ExecSandboxMode::WorkspaceWrite,
				read_deny: vec![Str::from(workspace.join("secret").to_string_lossy().as_ref())],
				..SandboxSettings::default()
			},
			&workspace,
		);
		let opened = host
			.open_session(OpenSessionRequest {
				cwd_uri: Url::from_directory_path(&workspace).unwrap().to_string(),
				..OpenSessionRequest::default()
			})
			.await
			.expect("sandboxed session opens");
		builtin_reads_behind_read_deny_end_denied(&host, &opened.session).await;
		host.close_session(&opened.session).expect("session closes");
	}

	/// The same refusal with only the in-shell file policy installed (mode
	/// `off` plus a `read_deny` root), so it runs on every unix host.
	#[cfg(unix)]
	#[tokio::test]
	async fn builtin_reads_behind_read_deny_end_denied_without_a_kernel_backend() {
		let (_root, workspace) = read_deny_workspace();
		let host = ExecHost::new();
		host.configure_sandbox(&environment_only_read_deny(&workspace.join("secret")), &workspace);
		let opened = host
			.open_session(OpenSessionRequest {
				cwd_uri: Url::from_directory_path(&workspace).unwrap().to_string(),
				..OpenSessionRequest::default()
			})
			.await
			.expect("sandboxed session opens");
		assert!(
			host.inner.sessions.lock()[&opened.session]
				.sandbox
				.is_some(),
			"the in-shell file policy is installed"
		);
		builtin_reads_behind_read_deny_end_denied(&host, &opened.session).await;
		// A missing file is no denial.
		let (outcome, exit, output, _) =
			run_failure(&host, script_request(&opened.session, "cat public/absent")).await;
		let output = String::from_utf8_lossy(&output);
		assert_eq!(outcome, ExecOutcome::Failed as i32, "{output}");
		assert_eq!(exit, Some(1));
		assert!(output.contains("No such file or directory"), "{output}");
		host.close_session(&opened.session).expect("session closes");
	}

	/// ADR 0028: a detached script never reaches `/bin/sh`; it re-enters this
	/// executable as the hidden in-process shell child.
	#[test]
	fn detached_scripts_reenter_the_in_process_shell() {
		let command = detached_command("echo hi; sleep 1", None).expect("command builds");
		assert_eq!(command.get_program(), env::current_exe().unwrap().as_os_str());
		let args = command.get_args().collect::<Vec<_>>();
		assert_eq!(args, [
			OsStr::new(crate::shell_child::SHELL_CHILD_ARG),
			OsStr::new("echo hi; sleep 1")
		]);
	}

	/// ADR 0028: configured host shell executables and `-c` arguments are not
	/// session profiles.
	#[tokio::test]
	async fn host_shell_profiles_are_rejected_before_session_start() {
		let host = ExecHost::new();
		let error = host
			.open_session(OpenSessionRequest {
				shell_profile: Some(v1::ShellProfileInput {
					profile: String::from("bash"),
					executable: String::from("/bin/bash"),
					args: vec![String::from("-c")],
					wire_revision: omp_proto::SCHEMA_REV,
					..Default::default()
				}),
				..OpenSessionRequest::default()
			})
			.await
			.expect_err("configured host shells are unsupported");
		assert!(matches!(
			error,
			ExecError::UnsupportedShellProfile { profile } if profile == "bash"
		));
	}

	/// ADR 0028: production shells own coreutils and process utilities in
	/// process, even when `$PATH` is empty.
	#[tokio::test]
	async fn production_session_owns_coreutils_and_process_builtins() {
		let host = ExecHost::new();
		let opened = host
			.open_session(OpenSessionRequest {
				env_delta: Some(EnvironmentDelta {
					set: BTreeMap::from([(String::from("PATH"), String::new())]),
					..EnvironmentDelta::default()
				}),
				..OpenSessionRequest::default()
			})
			.await
			.expect("session opens");
		let session = &opened.session;
		let output = run_output(
			&host,
			script_request(session, "printf 'b\\na\\nb\\n' | sort | uniq -c | wc -l"),
		)
		.await;
		assert_eq!(String::from_utf8_lossy(&output).trim(), "2");
		for name in ["sort", "uniq", "wc", "seq", "cut", "sed", "sleep", "pgrep", "ps", "timeout"] {
			let output = run_output(&host, script_request(session, &format!("type -t {name}"))).await;
			assert_eq!(String::from_utf8_lossy(&output).trim(), "builtin", "{name} is a builtin");
		}
		host.close_session(&opened.session).expect("session closes");
	}

	#[test]
	fn tiny_output_frames_are_count_bounded_and_spilled_whole() {
		let root = tempfile::tempdir().expect("temporary artifact root");
		let store = BlobStore::open(root.path().join("artifacts")).expect("artifact store");
		let mut capture =
			OutputCapture::new_with_request(Some(&store), omp_tool::OutputRequest::Bounded)
				.expect("output capture");
		let mut projected = Vec::new();
		for _ in 0..(LIVE_OUTPUT_FRAMES + 17) {
			if let Some(frame) = capture.project(b"x") {
				projected.extend_from_slice(&frame);
			}
		}
		assert_eq!(projected, vec![b'x'; LIVE_OUTPUT_FRAMES]);
		let reference = capture
			.finish_with_projection()
			.expect("capture finalizes")
			.0
			.expect("frame overflow spills");
		let expected = vec![b'x'; LIVE_OUTPUT_FRAMES + 17];
		assert_eq!(
			store
				.get(&reference)
				.expect("complete output artifact")
				.as_ref(),
			expected.as_slice(),
		);
	}

	#[test]
	fn single_cargo_command_gate_accepts_only_plain_cargo() {
		assert!(is_single_cargo_command("cargo build"));
		assert!(is_single_cargo_command("cargo nextest run -p omp-envd"));
		assert!(is_single_cargo_command("cargo test --doc -p omp-minimizer"));
		assert!(!is_single_cargo_command("cargo build | cat"));
		assert!(!is_single_cargo_command("cargo build && true"));
		assert!(!is_single_cargo_command("cat Cargo.toml"));
		assert!(!is_single_cargo_command("just test-pkg omp-envd"));
	}

	#[test]
	fn minimize_cargo_output_rewrites_model_text_and_returns_original_blob() {
		let root = tempfile::tempdir().expect("temporary artifact root");
		let store = BlobStore::open(root.path().join("artifacts")).expect("artifact store");
		let original = format!(
			"{}    Finished `dev` profile in 0.10s\n",
			"   Compiling example v0.1.0\n".repeat(80)
		);
		let reference = store.put(original.as_bytes()).expect("store cargo capture");
		let mut projection = v1::OutputProjection {
			request:      v1::OutputRequest::Bounded as i32,
			source_bytes: reference.size,
			inline_bytes: reference.size,
			omitted:      false,
			artifact:     Some(wire_blob(&reference)),
			model_text:   None,
		};

		let spilled = minimize_cargo_output("cargo build", 0, &mut projection, &store)
			.expect("cargo build minimizes");
		assert_eq!(spilled.hash.as_ref(), reference.hash.as_bytes());
		assert_eq!(spilled.size, reference.size);
		let model_text = projection.model_text.expect("minimized model_text");
		assert!(!model_text.contains("Compiling example"));
		assert!(model_text.len() * 4 < original.len());
		assert_eq!(store.get(&reference).expect("original remains").as_ref(), original.as_bytes());

		let mut passthrough = v1::OutputProjection {
			request:      v1::OutputRequest::Bounded as i32,
			source_bytes: reference.size,
			inline_bytes: reference.size,
			omitted:      false,
			artifact:     Some(wire_blob(&reference)),
			model_text:   None,
		};
		assert!(
			minimize_cargo_output("cargo build | cat", 0, &mut passthrough, &store).is_none(),
			"piped cargo must not rewrite the projection"
		);
		assert!(passthrough.model_text.is_none());
	}

	#[tokio::test]
	async fn fast_output_is_host_bounded_and_complete_in_the_spill_artifact() {
		let root = tempfile::tempdir().expect("temporary artifact root");
		let store = BlobStore::open(root.path().join("artifacts")).expect("artifact store");
		let host = ExecHost::new().with_output_store(store.clone());
		let opened = host
			.open_session(OpenSessionRequest::default())
			.await
			.expect("session opens");
		let (_, run) = host
			.exec(script_request(&opened.session, "seq 1 20000"), None)
			.await
			.expect("fast command starts");

		time::sleep(Duration::from_millis(50)).await;
		assert!(
			run.events.len() <= OUTPUT_EVENT_CAPACITY,
			"the host queue must remain bounded before a consumer drains it"
		);

		let mut projected = Vec::new();
		let status = loop {
			match run.next_event().await {
				Some(ExecEvent::Output(frame)) => projected.extend_from_slice(&frame.data),
				Some(ExecEvent::Exit(event)) => break event.status.expect("terminal status"),
				Some(ExecEvent::Started { .. }) => {},
				None => panic!("exec event stream closed before exit"),
			}
		};
		let expected = (1..=20_000)
			.map(|number| format!("{number}\n"))
			.collect::<String>();
		assert!(projected.len() <= LIVE_OUTPUT_BYTES);
		assert_eq!(projected, expected.as_bytes()[..projected.len()]);
		let spill = status.spilled_output.expect("oversized output spills");
		let hash: [u8; 32] = spill.hash.as_ref().try_into().expect("SHA-256 digest");
		let complete = store
			.get(&omp_journal::blob::BlobRef { hash: Hash32::new(hash), size: spill.size })
			.expect("complete output artifact");
		assert_eq!(complete.as_ref(), expected.as_bytes());
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

	/// `sv_sandbox_mode off` set by the user with the network mode left at its
	/// `scoped` default runs commands with no sandbox at all, so it works on
	/// hosts with no native backend (Linux without bwrap, Windows).
	#[tokio::test]
	async fn explicit_off_with_the_default_network_runs_commands_unsandboxed() {
		let root = tempfile::tempdir().expect("workspace");
		let host = ExecHost::new();
		host.configure_sandbox(
			&crate::exec_settings::SandboxSettings {
				mode: crate::exec_settings::ExecSandboxMode::Off,
				explicit: true,
				..Default::default()
			},
			root.path(),
		);
		assert_eq!(host.sandbox_state(), admission::SandboxState::Off);
		let opened = host
			.open_session(OpenSessionRequest {
				cwd_uri: Url::from_directory_path(root.path())
					.expect("workspace URI")
					.to_string(),
				..OpenSessionRequest::default()
			})
			.await
			.expect("unsandboxed session opens");
		assert!(
			host.inner.sessions.lock()[&opened.session]
				.sandbox
				.is_none(),
			"no wrapper and no broker"
		);
		let (outcome, exit, output, diags) =
			run_failure(&host, script_request(&opened.session, "printf ok")).await;
		assert_eq!(outcome, ExecOutcome::Exited as i32);
		assert_eq!(exit, Some(0));
		assert_eq!(output, b"ok");
		assert!(diags.is_empty(), "no sandbox note: {diags:?}");
		host.close_session(&opened.session).expect("session closes");
	}

	#[tokio::test]
	async fn sandboxed_session_preserves_ordinary_environment_mutations() {
		let root = tempfile::tempdir().expect("workspace");
		let host = ExecHost::new();
		host.configure_sandbox(
			&crate::exec_settings::SandboxSettings {
				mode: crate::exec_settings::ExecSandboxMode::Off,
				env_set: BTreeMap::from([(
					Str::new_static("OMP_SANDBOX_POLICY"),
					Str::new_static("1"),
				)]),
				..Default::default()
			},
			root.path(),
		);
		let opened = host
			.open_session(OpenSessionRequest {
				cwd_uri: Url::from_directory_path(root.path())
					.expect("workspace URI")
					.to_string(),
				env_delta: Some(EnvironmentDelta {
					set: BTreeMap::from([(String::from("OMP_SANDBOX_POLICY"), String::from("user"))]),
					..EnvironmentDelta::default()
				}),
				..OpenSessionRequest::default()
			})
			.await
			.expect("sandboxed session");
		let first =
			run_output(&host, script_request(&opened.session, "printf '%s' \"$OMP_SANDBOX_POLICY\""))
				.await;
		assert!(first.ends_with(b"1"));
		assert_eq!(
			run_output(&host, script_request(&opened.session, "export PATH=/persistent")).await,
			b"",
		);
		assert_eq!(
			run_output(&host, script_request(&opened.session, "printf '%s' \"$PATH\"")).await,
			b"/persistent",
		);
		host.close_session(&opened.session).expect("session closes");
	}

	/// Mode `off` plus a `read_deny` root installs the in-shell file policy with
	/// no kernel backend, so these proofs run on every unix host. The network
	/// mode stays at its `scoped` default, which does not sandbox mode `off`.
	#[cfg(unix)]
	fn environment_only_read_deny(denied: &Path) -> crate::exec_settings::SandboxSettings {
		crate::exec_settings::SandboxSettings {
			mode: crate::exec_settings::ExecSandboxMode::Off,
			read_deny: vec![Str::from(denied.to_string_lossy().as_ref())],
			..Default::default()
		}
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn environment_only_sandbox_execs_globs_and_redirects_through_symlinks() {
		let root = tempfile::tempdir().expect("root");
		let prefix = crate::exec_sandbox::homebrew_shaped_prefix(root.path());
		let secret = root.path().join("secret");
		fs::create_dir(&secret).expect("secret root");
		fs::write(secret.join("key"), "omp-secret-marker\n").expect("secret file");
		std::os::unix::fs::symlink(secret.join("key"), prefix.join("to-secret"))
			.expect("link into read_deny");
		let host = ExecHost::new();
		host.configure_sandbox(&environment_only_read_deny(&secret), root.path());
		let opened = host
			.open_session(OpenSessionRequest {
				cwd_uri: Url::from_directory_path(root.path())
					.expect("root URI")
					.to_string(),
				..OpenSessionRequest::default()
			})
			.await
			.expect("sandboxed session opens");
		let session = &opened.session;
		assert!(
			host.inner.sessions.lock()[session].sandbox.is_some(),
			"the in-shell file policy is installed"
		);
		let prefix = prefix.display();
		// Exec lane: the program path as found, then through a PATH lookup.
		assert_eq!(
			run_output(&host, script_request(session, &format!("{prefix}/bin/tool exec"))).await,
			b"exec\n"
		);
		assert_eq!(
			run_output(
				&host,
				script_request(session, &format!("export PATH={prefix}/bin:/usr/bin:/bin; tool path"))
			)
			.await,
			b"path\n"
		);
		// Glob lane: expansion walks through the linked keg directory.
		assert_eq!(
			run_output(&host, script_request(session, &format!("echo {prefix}/opt/tool/bin/*"))).await,
			format!("{prefix}/opt/tool/bin/tool\n").as_bytes()
		);
		// Redirect lane: an in-shell read through a link.
		assert_eq!(
			run_output(
				&host,
				script_request(
					session,
					&format!("read -r line < {prefix}/bin/tool; printf '%s\\n' \"$line\"")
				)
			)
			.await,
			b"#!/bin/sh\n"
		);
		// A link into `read_deny` is still refused.
		let (outcome, exit, output, _) =
			run_failure(&host, script_request(session, &format!("read -r line < {prefix}/to-secret")))
				.await;
		assert_eq!(outcome, ExecOutcome::Denied as i32);
		assert_ne!(exit, Some(0));
		let output = String::from_utf8_lossy(&output);
		assert!(output.contains("sandbox denied read"), "{output}");
		assert!(!output.contains("omp-secret-marker"), "{output}");
		host.close_session(session).expect("session closes");
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn environment_only_sandbox_runs_from_a_cwd_reached_through_a_symlink() {
		let root = tempfile::tempdir().expect("root");
		let prefix = crate::exec_sandbox::homebrew_shaped_prefix(root.path());
		let host = ExecHost::new();
		host.configure_sandbox(&environment_only_read_deny(&root.path().join("secret")), root.path());
		// `opt/tool` links to the keg, so the session cwd itself crosses a link.
		let cwd = prefix.join("opt/tool/bin");
		let opened = host
			.open_session(OpenSessionRequest {
				cwd_uri: Url::from_directory_path(&cwd).expect("cwd URI").to_string(),
				..OpenSessionRequest::default()
			})
			.await
			.expect("sandboxed session opens");
		let session = &opened.session;
		assert!(
			host.inner.sessions.lock()[session].sandbox.is_some(),
			"the in-shell file policy is installed"
		);
		// Glob expansion checks the cwd itself before listing it.
		assert_eq!(run_output(&host, script_request(session, "echo *")).await, b"tool\n");
		assert_eq!(run_output(&host, script_request(session, "./tool linked")).await, b"linked\n");
		host.close_session(session).expect("session closes");
	}

	/// `link/../name` reaches the link target's sibling, as the kernel walks it;
	/// the redirect and glob lanes judge and read that same path, so a link into
	/// a `read_deny` root cannot be stepped out of with `..`.
	#[cfg(unix)]
	#[tokio::test]
	async fn environment_only_sandbox_judges_parent_components_after_a_link() {
		use std::os::unix::fs::symlink;

		let root = tempfile::tempdir().expect("root");
		let secret = root.path().join("secret");
		fs::create_dir_all(secret.join("sub")).expect("secret root");
		fs::write(secret.join("key"), "omp-secret-marker\n").expect("secret file");
		let public = root.path().join("public");
		fs::create_dir_all(public.join("dir")).expect("public dir");
		fs::write(public.join("sibling"), "physical\n").expect("physical sibling");
		// What the `..`-collapsed spellings below would name instead.
		fs::write(root.path().join("key"), "lexical\n").expect("lexical key");
		fs::write(root.path().join("sibling"), "lexical\n").expect("lexical sibling");
		symlink(secret.join("sub"), root.path().join("into-secret")).expect("directory link");
		symlink(secret.join("missing"), root.path().join("dangling")).expect("dangling link");
		symlink(public.join("dir"), root.path().join("into-public")).expect("public link");
		let host = ExecHost::new();
		host.configure_sandbox(&environment_only_read_deny(&secret), root.path());
		let opened = host
			.open_session(OpenSessionRequest {
				cwd_uri: Url::from_directory_path(root.path())
					.expect("root URI")
					.to_string(),
				..OpenSessionRequest::default()
			})
			.await
			.expect("sandboxed session opens");
		let session = &opened.session;
		for script in [
			"read -r line < into-secret/../key",
			"read -r line < dangling/../key",
			"echo into-secret/../*",
		] {
			let (outcome, exit, output, _) = run_failure(&host, script_request(session, script)).await;
			let output = String::from_utf8_lossy(&output);
			assert_eq!(outcome, ExecOutcome::Denied as i32, "{script}: {output}");
			assert_ne!(exit, Some(0), "{script}");
			assert!(output.contains("sandbox denied read"), "{script}: {output}");
			assert!(!output.contains("omp-secret-marker"), "{script}: {output}");
			assert!(!output.contains("lexical"), "{script}: {output}");
		}
		// Through a public link the same spelling reads and lists the target's
		// directory, not the link's.
		assert_eq!(
			run_output(
				&host,
				script_request(
					session,
					"read -r line < into-public/../sibling; printf '%s\\n' \"$line\""
				)
			)
			.await,
			b"physical\n"
		);
		assert_eq!(
			run_output(&host, script_request(session, "echo into-public/../s*")).await,
			b"into-public/../sibling\n"
		);
		host.close_session(session).expect("session closes");
	}

	#[tokio::test]
	async fn concurrent_sessions_own_distinct_sandbox_denial_slots() {
		use omp_shell::PathPolicy as _;

		let root = tempfile::tempdir().expect("workspace");
		let host = ExecHost::new();
		host.configure_sandbox(
			&crate::exec_settings::SandboxSettings {
				mode: crate::exec_settings::ExecSandboxMode::Off,
				env_set: BTreeMap::from([(
					Str::new_static("OMP_SANDBOX_POLICY"),
					Str::new_static("1"),
				)]),
				write_deny: vec![Str::from(root.path().to_string_lossy().as_ref())],
				..Default::default()
			},
			root.path(),
		);
		let request = || OpenSessionRequest {
			cwd_uri: Url::from_directory_path(root.path())
				.expect("workspace URI")
				.to_string(),
			..OpenSessionRequest::default()
		};
		let (first, second) =
			tokio::join!(host.open_session(request()), host.open_session(request()));
		let first = first.expect("first session");
		let second = second.expect("second session");
		let (first_sandbox, second_sandbox) = {
			let sessions = host.inner.sessions.lock();
			(
				sessions[&first.session]
					.sandbox
					.clone()
					.expect("first sandbox"),
				sessions[&second.session]
					.sandbox
					.clone()
					.expect("second sandbox"),
			)
		};
		assert!(!Arc::ptr_eq(&first_sandbox, &second_sandbox));
		let first_attempt = first_sandbox.begin_attempt(None);
		let second_attempt = second_sandbox.begin_attempt(None);
		let first_path = root.path().join("first-denied");
		let second_path = root.path().join("second-denied");
		assert!(first_attempt.check_write(&first_path).is_err());
		assert!(second_attempt.check_write(&second_path).is_err());
		let canonical = fs::canonicalize(root.path()).expect("canonical root");
		assert_eq!(
			first_attempt.take_facts().denial,
			Some(SandboxDenialFact::WritePath(canonical.join("first-denied"))),
		);
		assert_eq!(
			second_attempt.take_facts().denial,
			Some(SandboxDenialFact::WritePath(canonical.join("second-denied"))),
		);
		host
			.close_session(&first.session)
			.expect("first session closes");
		host
			.close_session(&second.session)
			.expect("second session closes");
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
		assert_eq!(capabilities.shell_profiles, [String::from("brush")]);

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
	async fn observed_readiness_survives_a_fast_process_exit() {
		let root = tempfile::tempdir().unwrap();
		let host = ExecHost::new();
		let mut request = process_request("fast-ready-exit", root.path(), "printf READY");
		request.ready.push(ReadyProbe {
			probe:      Some(ready_probe::Probe::Log(v1::ReadyLog {
				pattern: String::from("READY"),
				props:   None,
			})),
			timeout_ms: 1_000,
			props:      None,
		});
		let started = host
			.start_process(request)
			.await
			.expect("observed readiness must complete start");
		let info = wait_for_terminal(&host, &started.name, started.generation).await;
		assert_eq!(info.ready_match, "READY");
	}

	#[tokio::test]
	async fn recovered_terminal_name_reuse_preserves_the_generation_fence() {
		let root = tempfile::tempdir().unwrap();
		let store = ProcessStore::new(root.path().join("processes").join("meta.json"));
		let identity = ProcessIdentity::current().unwrap();
		let mut snapshot = ProcessStoreSnapshot::new(identity.clone());
		snapshot.processes.push(ProcessRecord {
			name: Str::new_static("recovered-reuse"),
			spec_wire: Vec::new(),
			ready_wire: Vec::new(),
			status_wire: Vec::new(),
			process_dir: root.path().join("processes").join("recovered-reuse"),
			generation: 41,
			identity,
			detached: false,
			persist: false,
			phase: ProcessPhase::Running,
			log_start_offset: 0,
			log_end_offset: 0,
			log_rotations: 0,
			restart_pending: false,
			restart_count: 0,
			consecutive_failures: 0,
			restart_history: Vec::new(),
			started_order: 1,
			recent_order: 0,
		});
		store.save(&snapshot).unwrap();

		let host = ExecHost::new().with_process_store(store).unwrap();
		let started = host
			.start_process(process_request("recovered-reuse", root.path(), "printf replacement"))
			.await
			.unwrap();
		assert_eq!(started.generation, 42);
		wait_for_terminal(&host, &started.name, started.generation).await;
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

	/// Prefixes an encoded frame with its varint length, the way a worker
	/// writes it to stdout.
	fn length_delimited(frame: &[u8]) -> BytesMut {
		let mut out = BytesMut::new();
		let mut length = frame.len() as u64;
		loop {
			let byte = (length & 0x7f) as u8;
			length >>= 7;
			if length == 0 {
				out.extend_from_slice(&[byte]);
				break;
			}
			out.extend_from_slice(&[byte | 0x80]);
		}
		out.extend_from_slice(frame);
		out
	}

	#[test]
	fn probe_reply_frame_is_preflighted_before_decode() {
		use omp_proto::toolhost::v1::Pong;

		// A well-formed Pong decodes.
		let pong = WorkerFrame {
			request_id: 0,
			body:       Some(worker_frame::Body::Pong(Pong { nonce: 7, props: None })),
			props:      None,
		}
		.encode_to_vec();
		let mut buffer = length_delimited(&pong);
		let frame = take_worker_frame(&mut buffer)
			.expect("a valid reply is accepted")
			.expect("complete frame");
		assert!(matches!(frame.body, Some(worker_frame::Body::Pong(Pong { nonce: 7, .. }))));

		// Field 7 declares 127 bytes but only 3 follow: the preflight names the
		// truncation before `prost` sees the bytes.
		let mut malformed = BytesMut::new();
		malformed.extend_from_slice(&[0x05, 0x3a, 0x7f, 0x00, 0x00, 0x00]);
		assert!(matches!(
			take_worker_frame(&mut malformed),
			Err(ExecError::ProbeFrame { source: FrameBoundsError::Truncated { .. } })
		));

		// A varint length above the protocol frame limit is refused as soon as
		// the prefix is read, without waiting for (and buffering) the body.
		let mut oversized = BytesMut::new();
		let mut length = (FRAME_MAX_BYTES as u64) + 1;
		while length >= 0x80 {
			oversized.extend_from_slice(&[(length & 0x7f) as u8 | 0x80]);
			length >>= 7;
		}
		oversized.extend_from_slice(&[length as u8]);
		assert!(matches!(
			take_worker_frame(&mut oversized),
			Err(ExecError::ProbeFrame {
				source: FrameBoundsError::FrameTooLarge { limit: FRAME_MAX_BYTES, .. },
			})
		));
	}
}
