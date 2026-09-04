use std::{
	collections::BTreeMap,
	fmt::Write as _,
	future::Future,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	time::Duration,
};

use async_stream::stream;
use bytes::Bytes;
use futures::{FutureExt, Stream, future::Either, pin_mut};
use omp_core::{CowBytes, Str, sf};
use omp_proto::inference::v1::{
	InvokeInput,
	invoke_input::{self, chunk},
};
use omp_shell_builtins::{ImagePassthrough, image_passthrough_ranges};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, BlobRef, CommitError, Constraint, Diag, Effects, Ev,
	IncomingParams, Interrupt, InterruptWaitError, ParamError, Part, PromptCaps, Rev, Tool,
	ToolSpec, ToolTerminal,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::Instrument as _;

use crate::{
	auto_background::{
		DEFAULT_AUTO_BACKGROUND_THRESHOLD, DetachedJob, ForegroundWait, JobWait,
		managed_job_terminal, next_background_name,
	},
	render::TextProjection,
	shell_intercept,
	shell_intercept::{CompiledRule, Rule},
};

/// Exposes conservative shell segments for admission and interception.
///
/// Each segment retains original spelling and identifies whether it consumes
/// the preceding pipeline stage.
pub fn command_segments(command: &str) -> Vec<omp_shell::parser::FlatShellCommandSegment<'_>> {
	omp_shell::parser::flat_shell_segments(command)
}

/// Complete arguments for `bash@2`.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[schemars(description = "")]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// Shell script to execute.
	#[schemars(length(min = 1), description = "Shell script to execute.")]
	pub command:      Str,
	/// Host-enforced execution timeout in seconds; zero disables the deadline
	/// without changing the foreground auto-background threshold.
	#[schemars(
		default,
		skip_serializing_if = "Option::is_none",
		with = "serde_json::Number",
		range(min = 0.0),
		description = "Host-enforced execution timeout in seconds; zero disables the deadline; \
		               nonzero values do not extend the foreground auto-background threshold."
	)]
	pub timeout:      Option<f64>,
	/// Environment delta scoped to this command; null values unset variables.
	#[serde(default)]
	#[schemars(
		with = "BTreeMap<String, Option<String>>",
		description = "Environment additions and null-valued removals scoped to this command."
	)]
	pub env:          BTreeMap<Str, Option<Str>>,
	/// Command working directory, relative to the workspace when not absolute.
	#[schemars(
		default,
		skip_serializing_if = "Option::is_none",
		with = "String",
		length(min = 1),
		description = "Command working directory, relative to the workspace when not absolute."
	)]
	pub cwd:          Option<Str>,
	/// Allocate a pseudo-terminal for this command.
	#[serde(default)]
	#[schemars(description = "Allocate a pseudo-terminal for this command.")]
	pub pty:          bool,
	/// Run as an asynchronously managed job.
	#[serde(default, rename = "async")]
	#[schemars(description = "Run as an asynchronously managed job.")]
	pub asynchronous: bool,
}
/// Ordered output channel from a shell command.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputChannel {
	/// Standard output.
	Stdout,
	/// Standard error.
	Stderr,
	/// Combined pseudo-terminal output.
	Pty,
}

/// One ordered live output update.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Update {
	/// Output stream carrying the bytes.
	pub channel:  OutputChannel,
	/// Exact output bytes.
	#[serde(with = "cow_bytes")]
	pub data:     CowBytes<'static>,
	/// Host-assigned ordering sequence.
	pub sequence: u64,
	/// Opaque execution identity on the initial live frame.
	#[serde(default)]
	pub exec_id:  Bytes,
	/// Whether this frame announces a newly started execution.
	#[serde(default)]
	pub started:  bool,
	/// Whether the execution owns a pseudo-terminal.
	#[serde(default)]
	pub terminal: bool,
}

/// One retained output frame in the durable transcript.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TranscriptFrame {
	/// Output stream carrying the bytes.
	pub channel:  OutputChannel,
	/// Exact retained output bytes.
	#[serde(with = "cow_bytes")]
	pub data:     CowBytes<'static>,
	/// Host-assigned ordering sequence.
	pub sequence: u64,
}

/// Terminal process disposition reported by the environment owner.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecOutcome {
	/// The script exited normally.
	Exited,
	/// The script failed to launch or execute.
	Failed,
	/// The host-enforced deadline expired.
	Timeout,
	/// The request owner cancelled the command.
	Cancelled,
	/// Execution was denied by policy.
	Denied,
}

/// Complete terminal execution truth from the host.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecStatus {
	/// Stable terminal disposition.
	pub outcome:            ExecOutcome,
	/// Process exit code when one exists.
	pub exit_code:          Option<i32>,
	/// Terminating signal when one exists.
	pub signal:             Option<Str>,
	/// Host-measured elapsed wall time.
	pub wall_clock_ms:      u64,
	/// Host-provided reference to output omitted from the live transcript.
	pub spilled_output:     Option<BlobRef>,
	/// Whether cancellation happened after launch.
	pub aborted:            bool,
	/// Whether the host cannot establish the final effect state.
	pub effects_unknown:    bool,
	/// Harness notices recorded by the environment host and projected as
	/// diagnostic events before settlement.
	#[serde(skip)]
	pub diags:              Vec<Diag>,
	/// Environment URI of the session working directory after this command.
	#[serde(default)]
	pub final_cwd_uri:      Option<Str>,
	/// Revision fencing the returned final working directory.
	#[serde(default)]
	pub final_cwd_revision: u64,
}

/// An execution adjustment recorded in the durable call outcome.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AdjustmentReceipt {
	/// The requested finite deadline was clamped to the execution placement's
	/// bounds.
	TimeoutClamped {
		/// Model-requested deadline.
		requested_ms: u64,
		/// Deadline actually sent to the execution placement.
		effective_ms: u64,
	},
}

/// Durable foreground shell result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Payload {
	/// Stable identity of the environment session used for this run.
	pub session_id:  Bytes,
	/// Host identity of this command execution.
	pub exec_id:     Bytes,
	/// Exact submitted script after a leading `cd &&` was extracted.
	pub command:     Str,
	/// Host-bounded ordered output projected live for this call.
	///
	/// When raw output exceeds the host transport bound, the complete bytes are
	/// retained at [`ExecStatus::spilled_output`] and this transcript is its
	/// bounded inline projection. The tool never applies another text bound.
	pub transcript:  Vec<TranscriptFrame>,
	/// Durable images extracted from terminal graphics passthrough.
	#[serde(default)]
	pub attachments: Vec<BlobRef>,
	/// Execution adjustments retained as journal receipts.
	pub adjustments: Vec<AdjustmentReceipt>,
	/// Terminal host status, preserved without reinterpretation.
	pub status:      ExecStatus,
}

/// Typed shell resource failure.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fault {
	/// The environment resource rejected or lost an operation.
	Resource {
		/// Operation that failed.
		operation: Str,
		/// Resource-owned diagnostic.
		message:   Str,
	},
	/// The authenticated invocation scope forbids pseudo-terminal allocation.
	PtyDenied,
	/// An environment key was not a portable shell identifier.
	InvalidEnvironmentKey {
		/// Rejected key.
		key: Str,
	},
	/// A dispatched command reached a definite unsuccessful terminal status.
	CommandFailed {
		/// Complete output and process status retained for rendering and policy.
		payload: Box<Payload>,
	},
}

impl Fault {
	/// Renders the model-facing failure diagnostic at the presentation boundary.
	pub fn message(&self) -> String {
		match self {
			Self::Resource { operation, message } => format!("shell {operation} failed: {message}"),
			Self::PtyDenied => String::from("shell PTY allocation denied by invocation scope"),
			Self::InvalidEnvironmentKey { key } => {
				format!("invalid shell environment key {key:?}")
			},
			Self::CommandFailed { payload } => format!(
				"bash command failed: status={:?}, exit={:?}, signal={:?}",
				payload.status.outcome, payload.status.exit_code, payload.status.signal
			),
		}
	}
}

/// Module-owned handle for one persistent environment session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Session {
	/// Opaque environment session identifier, preserved byte-for-byte.
	pub id: Bytes,
}

/// Command-scoped session settings.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SessionOptions {
	/// Requested working directory.
	pub cwd: Option<Str>,
	/// Scoped environment delta; absent values unset variables.
	pub env: BTreeMap<Str, Option<Str>>,
	/// Whether a pseudo-terminal is requested.
	pub pty: bool,
}

impl SessionOptions {
	fn is_default(&self) -> bool {
		self.cwd.is_none() && self.env.is_empty() && !self.pty
	}
}

/// Request to run one command in an existing session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunRequest {
	/// Exact script text.
	pub command:     Str,
	/// Environment delta applied only while this command runs.
	pub environment: BTreeMap<Str, Option<Str>>,
	/// Optional server-enforced timeout in milliseconds.
	pub timeout_ms:  Option<u64>,
}

/// Request to create one persistent named process.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DetachRequest {
	/// Stable process name.
	pub name:       Str,
	/// Exact script text.
	pub command:    Str,
	/// Optional server-enforced timeout in milliseconds.
	pub timeout_ms: Option<u64>,
	/// Session settings applied to the detached command.
	pub options:    SessionOptions,
}

/// One event consumed from a foreground environment run.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RunEvent {
	/// The host assigned an execution identity.
	Started {
		/// Stable host execution identity.
		exec_id: Bytes,
	},
	/// Ordered process output.
	Output(Update),
	/// Terminal process status.
	Exit(ExecStatus),
}

enum PendingRun {
	Event(Result<Option<RunEvent>, Fault>),
	Interrupt(Result<Interrupt, InterruptWaitError>),
	Background,
}

/// Request-scoped foreground run whose cancellation leaves its session open.
pub trait ShellRun: Send {
	/// Waits for the next ordered run event.
	fn next_event(&mut self) -> impl Future<Output = Result<Option<RunEvent>, Fault>> + Send + '_;

	/// Requests process-tree cancellation without closing the containing
	/// session.
	fn cancel(&self) -> impl Future<Output = Result<(), Fault>> + Send + '_;

	/// Transfers this in-flight execution to a named process.
	fn detach(&self, name: Str) -> impl Future<Output = Result<DetachedJob, Fault>> + Send + '_;
}

/// Zero-box environment resource boundary used by the native shell executor.
pub trait ShellExec: Clone + Send + Sync + 'static {
	/// Request-scoped run handle retaining the host cancellation guard.
	type Run: ShellRun;

	/// Opens an independent shell session with the given command-scoped
	/// settings.
	fn open_session(
		&self,
		options: SessionOptions,
	) -> impl Future<Output = Result<Session, Fault>> + Send + '_;

	/// Closes an isolated or quarantined session.
	fn close_session<'a>(
		&'a self,
		session: &'a Session,
	) -> impl Future<Output = Result<(), Fault>> + Send + 'a;

	/// Starts a foreground script in the existing session.
	fn run<'a>(
		&'a self,
		session: &'a Session,
		request: RunRequest,
	) -> impl Future<Output = Result<Self::Run, Fault>> + Send + 'a;

	/// Transfers a script to the environment named-process owner.
	fn detach(
		&self,
		request: DetachRequest,
	) -> impl Future<Output = Result<DetachedJob, Fault>> + Send + '_;

	/// Stores one complete shell image attachment in the environment blob
	/// namespace.
	fn store_attachment(
		&self,
		bytes: Bytes,
		media_type: Str,
	) -> impl Future<Output = Result<BlobRef, Fault>> + Send + '_;
}

/// Bounds enforced by the execution placement for finite shell deadlines.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TimeoutBounds {
	/// Default deadline when the request omits `timeout_ms`.
	pub default_ms: u64,
	/// Minimum finite deadline accepted by the placement.
	pub floor_ms:   u64,
	/// Maximum finite deadline accepted by the placement.
	pub ceiling_ms: u64,
}

impl Default for TimeoutBounds {
	fn default() -> Self {
		Self { default_ms: 300_000, floor_ms: 1_000, ceiling_ms: 3_600_000 }
	}
}

/// Immutable live-composition facts projected into the `bash@2` prompt.
#[derive(Clone, Debug)]
pub struct ShellPromptSnapshot {
	/// Active sibling tools which can replace common shell intents.
	pub sibling_tools:       Arc<[Str]>,
	/// Environment operating-system platform.
	pub platform:            Str,
	/// Whether a command wrapper prefix is configured.
	pub command_prefix:      bool,
	/// Whether embedded shell builtins are enabled.
	pub embedded_builtins:   bool,
	/// Whether the `dyn` dynamic-device builtin is installed.
	pub devices:             bool,
	/// Whether shell-intent interception is enabled.
	pub interceptor_enabled: bool,
	/// Ordered configured interception rules.
	pub interceptor_rules:   Arc<[Rule]>,
	/// Whether capability-gated ACP routing is allowed.
	pub acp_routing:         bool,
}

impl ShellPromptSnapshot {
	fn description(&self) -> Str {
		let mut description = String::from(
			"Execute a shell script in a persistent session, or allocate an asynchronous managed \
			 job. Eligible long-running calls may auto-background at the configured foreground \
			 threshold and deliver later. `timeout: 0` disables the command deadline; otherwise \
			 `timeout` is measured in seconds and does not extend foreground waiting.",
		);
		let _ = write!(
			description,
			" Environment platform: {}; the shell is an in-process bash interpreter with builtin \
			 coreutils.",
			self.platform,
		);
		if self.sibling_tools.is_empty() {
			description.push_str(" No dedicated sibling tools are active.");
		} else {
			description.push_str(" Active sibling tools: ");
			for (index, tool) in self.sibling_tools.iter().enumerate() {
				if index != 0 {
					description.push_str(", ");
				}
				description.push_str(tool);
			}
			description.push('.');
		}
		let _ = write!(
			description,
			" Command prefix: {}; embedded builtins: {}; intent interceptor: {}; ACP routing: {}.",
			if self.command_prefix {
				"configured"
			} else {
				"none"
			},
			if self.embedded_builtins {
				"enabled"
			} else {
				"disabled"
			},
			if self.interceptor_enabled {
				"enabled"
			} else {
				"disabled"
			},
			if self.acp_routing {
				"enabled"
			} else {
				"disabled"
			},
		);
		if self.devices {
			description
				.push_str(" Dynamic devices: `dyn` builtin (list `dyn`; docs `dyn <device> --help`).");
		}
		Str::from(description)
	}
}

/// Builds the host-free `bash@2` declaration from immutable prompt facts.
pub fn spec(snapshot: &ShellPromptSnapshot) -> ToolSpec {
	spec_described(snapshot.description())
}

fn spec_described(description: Str) -> ToolSpec {
	ToolSpec {
		name: sf!("bash"),
		rev: Rev { family: Str::default(), n: 2 },
		description,
		schema: omp_tool::schema::<Params>(),
		constraint: Constraint::Schema {
			priority:       100,
			on_unsupported: omp_tool::Fallback::Unspecified,
		},
		// The shell string is not an approval capability. The environment host
		// admits exact filesystem, spawn, and network effects as interpretation
		// reaches those boundaries.
		effects: Effects::empty(),
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("shell.rs"),
		)
		.into(),
	}
}

/// Generic `bash@2` implementation retaining one lazy persistent session.
pub struct ShellTool<E: ShellExec> {
	exec: E,
	session: Mutex<Option<Session>>,
	persistent_run_active: AtomicBool,
	next_background_name: AtomicU64,
	timeout_bounds: TimeoutBounds,
	auto_background_enabled: bool,
	auto_background_threshold: Duration,
	interceptor_enabled: bool,
	interceptor_rules: Arc<[CompiledRule]>,
	sibling_tools: Arc<[Str]>,
	spec: ToolSpec,
}

/// Constructs the native `bash@2` executor over an environment resource.
pub fn shell<E: ShellExec>(exec: E) -> ShellTool<E> {
	shell_with_spec(
		exec,
		spec_described(sf!(
			"Execute a shell script in a persistent session, or allocate an asynchronous managed \
			 job. Eligible long-running calls may auto-background at the configured foreground \
			 threshold and deliver later. `timeout: 0` disables the command deadline; otherwise \
			 `timeout` is measured in seconds and does not extend foreground waiting.",
		)),
	)
}

fn shell_with_spec<E: ShellExec>(exec: E, spec: ToolSpec) -> ShellTool<E> {
	ShellTool {
		exec,
		session: Mutex::new(None),
		persistent_run_active: AtomicBool::new(false),
		next_background_name: AtomicU64::new(1),
		timeout_bounds: TimeoutBounds::default(),
		auto_background_enabled: true,
		auto_background_threshold: DEFAULT_AUTO_BACKGROUND_THRESHOLD,
		interceptor_enabled: false,
		interceptor_rules: Arc::default(),
		sibling_tools: Arc::default(),
		spec,
	}
}
/// Constructs `bash@2` from immutable live registry, capability, and settings
/// facts.
pub fn shell_with_snapshot_and_timeout_bounds<E: ShellExec>(
	exec: E,
	timeout_bounds: TimeoutBounds,
	snapshot: &ShellPromptSnapshot,
) -> ShellTool<E> {
	let mut tool = shell_with_spec(exec, spec(snapshot)).with_timeout_bounds(timeout_bounds);
	tool.interceptor_enabled = snapshot.interceptor_enabled;
	tool.interceptor_rules =
		shell_intercept::compile(&snapshot.interceptor_rules, &snapshot.sibling_tools).into();
	tool.sibling_tools = Arc::clone(&snapshot.sibling_tools);
	tool
}

/// Constructs the shell executor with execution-placement timeout bounds.
pub fn shell_with_timeout_bounds<E: ShellExec>(
	exec: E,
	timeout_bounds: TimeoutBounds,
) -> ShellTool<E> {
	shell(exec).with_timeout_bounds(timeout_bounds)
}

impl<E: ShellExec> ShellTool<E> {
	/// Overrides the finite timeout bounds supplied by the execution placement.
	pub const fn with_timeout_bounds(mut self, timeout_bounds: TimeoutBounds) -> Self {
		self.timeout_bounds = timeout_bounds;
		self
	}

	/// Applies automatic foreground detachment policy from the owning settings
	/// snapshot.
	pub const fn with_auto_background(mut self, enabled: bool, threshold: Duration) -> Self {
		self.auto_background_enabled = enabled;
		self.auto_background_threshold = threshold;
		self
	}

	async fn persistent_session(&self) -> Result<Session, Fault> {
		let mut session = self.session.lock().await;
		if let Some(session) = session.as_ref() {
			return Ok(session.clone());
		}
		let opened = self.exec.open_session(SessionOptions::default()).await?;
		*session = Some(opened.clone());
		Ok(opened)
	}

	async fn finish_session(&self, session: &Session, persistent: bool, quarantine: bool) {
		if persistent {
			if quarantine {
				let discarded = {
					let mut pooled = self.session.lock().await;
					pooled.take()
				};
				if let Some(discarded) = discarded {
					let _ = self.exec.close_session(&discarded).await;
				}
			}
			self.persistent_run_active.store(false, Ordering::Release);
		} else {
			let _ = self.exec.close_session(session).await;
		}
	}

	fn timeout(&self, requested: Option<f64>) -> (Option<u64>, Vec<AdjustmentReceipt>) {
		let Some(requested_seconds) = requested else {
			return (Some(self.timeout_bounds.default_ms), Vec::new());
		};
		if requested_seconds == 0.0 {
			return (None, Vec::new());
		}
		let requested_ms = (requested_seconds * 1_000.0).ceil() as u64;
		let floor = self.timeout_bounds.floor_ms;
		let ceiling = self.timeout_bounds.ceiling_ms.max(floor);
		let effective = requested_ms.clamp(floor, ceiling);
		let adjustments = (effective != requested_ms)
			.then_some(AdjustmentReceipt::TimeoutClamped { requested_ms, effective_ms: effective })
			.into_iter()
			.collect();
		(Some(effective), adjustments)
	}
}

impl<E: ShellExec> Tool for ShellTool<E> {
	type Fault = Fault;
	type Params = Params;
	type Payload = Payload;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
		let span = tracing::debug_span!(
			"shell_execution",
			cwd = tracing::field::Empty,
			asynchronous = tracing::field::Empty,
			pty = tracing::field::Empty,
		);
		stream! {
			let args = match params.whole::<Params>().await {
				Ok(args) => args,
				Err(error) => {
					yield param_event(error);
					return;
				},
			};
			if self.interceptor_enabled
				&& let Some(guidance) = crate::shell_intercept::analyze_configured(
					&args.command,
					&self.interceptor_rules,
				)
				.or_else(|| crate::shell_intercept::analyze(&args.command, &self.sibling_tools))
			{
				tracing::warn!(parent: &span, "shell command denied by tool interception");
				yield Ev::Args(ArgIssue {
					path: Vec::new(),
					expected: guidance.message,
					kind: ArgIssueKind::Malformed,
					example: None,
					found: Some(args.command),
				});
				return;
			}
			if let Err(error) = params.committed().await {
				yield commit_event(error);
				return;
			}
			if let Some(interrupt) = params.take_interrupt() {
				yield Ev::Aborted(Abort::Skipped { reason: interrupt.reason });
				return;
			}
			if let Some(Ok(interrupt)) = params.next_interrupt().now_or_never() {
				yield Ev::Aborted(Abort::Skipped { reason: interrupt.reason });
				return;
			}
			if let Some(key) = args.env.keys().find(|key| !valid_env_key(key)).cloned() {
				yield Ev::Done(ToolTerminal::Done {
					result: Err(Fault::InvalidEnvironmentKey { key }),
					useless: false,
				});
				return;
			}

			let (command, extracted_cwd) = if args.cwd.is_none() {
				extract_leading_cd(&args.command)
			} else {
				(args.command.clone(), None)
			};
			let cwd = args.cwd.or(extracted_cwd);
			let terminal = args.pty;
			span.record("cwd", tracing::field::display(cwd.as_deref().unwrap_or(".")));
			span.record("asynchronous", args.asynchronous);
			span.record("pty", terminal);
			let environment = args.env;
			let (timeout_ms, adjustments) = self.timeout(args.timeout);

			if args.asynchronous {
				let name = next_background_name("bash", &self.next_background_name);
				let options = SessionOptions {
					cwd,
					env: environment,
					pty: terminal,
				};
				let work = self.exec.detach(DetachRequest {
					name,
					command,
					timeout_ms,
					options,
				}).instrument(span.clone()).fuse();
				let interrupt = params.next_interrupt().fuse();
				pin_mut!(work, interrupt);
				match futures::future::select(interrupt, work).await {
					Either::Left((interrupt, _)) => {
						let reason = interrupt_reason(interrupt, "invocation owner disappeared during async setup");
						yield Ev::Aborted(Abort::EffectsUnknown { reason });
					},
					Either::Right((Ok(job), _)) => {
						yield Ev::Done(detached_terminal(
							job,
							"explicit async request",
							&[],
						));
					},
					Either::Right((Err(fault), _)) => {
						yield Ev::Done(ToolTerminal::Done { result: Err(fault), useless: false });
					},
				}
				return;
			}

			let options = SessionOptions { cwd, env: BTreeMap::new(), pty: terminal };
			let persistent = options.is_default()
				&& self
					.persistent_run_active
					.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
					.is_ok();
			let session = if persistent {
				self.persistent_session().instrument(span.clone()).await
			} else {
				self.exec.open_session(options).instrument(span.clone()).await
			};
			let session = match session {
				Ok(session) => session,
				Err(fault) => {
					if persistent {
						self.persistent_run_active.store(false, Ordering::Release);
					}
					yield Ev::Done(ToolTerminal::Done { result: Err(fault), useless: false });
					return;
				},
			};
			let session_id = session.id.clone();
			let mut run = match self.exec.run(&session, RunRequest {
				command: command.clone(),
				environment,
				timeout_ms,
			}).instrument(span.clone()).await {
				Ok(run) => run,
				Err(fault) => {
					self.finish_session(&session, persistent, true).await;
					yield Ev::Done(ToolTerminal::Done { result: Err(fault), useless: false });
					return;
				},
			};
			let foreground_wait = ForegroundWait::new(
				self.auto_background_threshold,
				timeout_ms.map(Duration::from_millis),
			);
			let mut auto_background = self.auto_background_enabled && !terminal;

			let mut exec_id = Bytes::new();
			let mut started = false;
			let mut transcript = Vec::new();
			let mut cancellation_reason: Option<Str> = None;
			loop {
				let event = if cancellation_reason.is_some() {
					run.next_event().await
				} else {
					let pending = if auto_background {
						match foreground_wait
							.race(run.next_event(), params.next_interrupt())
							.await
						{
							JobWait::Settled(event) => PendingRun::Event(event),
							JobWait::Interrupted(interrupt) => PendingRun::Interrupt(interrupt),
							JobWait::Background => PendingRun::Background,
						}
					} else {
						let next = run.next_event().fuse();
						let interrupt = params.next_interrupt().fuse();
						pin_mut!(next, interrupt);
						futures::select_biased! {
							event = next => PendingRun::Event(event),
							interrupt = interrupt => PendingRun::Interrupt(interrupt),
						}
					};
					match pending {
						PendingRun::Background => {
							let name =
								next_background_name("bash", &self.next_background_name);
							if let Ok(job) = run.detach(name).await {
								self.finish_session(&session, persistent, true).await;
								yield Ev::Done(detached_terminal(
									job,
									"automatic foreground threshold elapsed",
									&transcript,
								));
								return;
							}
							auto_background = false;
							continue;
						},
						PendingRun::Event(event) => event,
						PendingRun::Interrupt(interrupt) => {
							let interrupt = match interrupt {
								Ok(interrupt) => interrupt,
								Err(InterruptWaitError::Closed) => Interrupt {
									class: sf!("closed"),
									reason: sf!("invocation owner disappeared"),
								},
								Err(InterruptWaitError::Protocol(reason)) => Interrupt {
									class: sf!("protocol"),
									reason,
								},
							};
							if interrupt.class == Interrupt::STEERING {
								let name =
									next_background_name("bash", &self.next_background_name);
								if let Ok(job) = run.detach(name).await {
									let reason = sf!("steering interrupt: {}", interrupt.reason);
									self.finish_session(&session, persistent, true).await;
									yield Ev::Done(detached_terminal(job, &reason, &transcript));
									return;
								}
							}
							let reason = interrupt.reason;
							if run.cancel().await.is_err() {
								tracing::warn!(
									parent: &span,
									"shell cancellation failed; effect state is unknown",
								);
								self.finish_session(&session, persistent, true).await;
								yield Ev::Aborted(Abort::EffectsUnknown { reason });
								return;
							}
							cancellation_reason = Some(reason);
							continue;
						},
					}
				};

				match event {
					Ok(Some(RunEvent::Started { exec_id: id })) => {
						exec_id = id;
						started = true;
						yield Ev::Update(Update {
							channel: if terminal {
								OutputChannel::Pty
							} else {
								OutputChannel::Stdout
							},
							data: CowBytes::owned(Bytes::new()),
							sequence: 0,
							exec_id: exec_id.clone(),
							started: true,
							terminal,
						});
					},
					Ok(Some(RunEvent::Output(update))) => {
						transcript.push(TranscriptFrame {
							channel: update.channel,
							data: update.data.clone(),
							sequence: update.sequence,
						});
						yield Ev::Update(update);
					},
					Ok(Some(RunEvent::Exit(status)))
						if !started
							&& status.outcome == ExecOutcome::Cancelled
							&& !status.effects_unknown
							&& cancellation_reason.is_some() =>
					{
						for diag in status.diags.iter().cloned() {
							yield Ev::Diag(diag);
						}
						self.finish_session(&session, persistent, true).await;
						yield Ev::Aborted(Abort::Skipped {
							reason: cancellation_reason.take().expect("guarded by is_some"),
						});
						return;
					},
					Ok(Some(RunEvent::Exit(status))) => {
						for diag in status.diags.iter().cloned() {
							yield Ev::Diag(diag);
						}
						let quarantine = status.aborted
							|| matches!(status.outcome, ExecOutcome::Timeout | ExecOutcome::Cancelled)
							|| status.effects_unknown;
						self.finish_session(&session, persistent, quarantine).await;
						if status.outcome == ExecOutcome::Cancelled {
							yield Ev::Aborted(if status.effects_unknown {
								Abort::EffectsUnknown {
									reason: sf!("bash command was cancelled; effect state is unknown"),
								}
							} else {
								Abort::Interrupted { reason: sf!("bash command was cancelled") }
							});
							return;
						}
						let successful = status.outcome == ExecOutcome::Exited
							&& status.exit_code == Some(0)
							&& status.signal.is_none()
							&& !status.aborted
							&& !status.effects_unknown;
						let images = extract_transcript_images(&mut transcript);
						let mut attachments = Vec::with_capacity(images.len());
						for image in images {
							match self.exec.store_attachment(image.bytes, image.mime).await {
								Ok(blob) => attachments.push(blob),
								Err(fault) => {
									yield Ev::Done(ToolTerminal::Done {
										result: Err(fault),
										useless: false,
									});
									return;
								},
							}
						}
						let payload = Payload {
							session_id,
							exec_id,
							command,
							transcript,
							attachments,
							adjustments,
							status,
						};
						yield Ev::Done(ToolTerminal::Done {
							result: if successful {
								Ok(payload)
							} else {
								Err(Fault::CommandFailed { payload: Box::new(payload) })
							},
							useless: false,
						});
						return;
					},
					Ok(None) => {
						tracing::warn!(
							parent: &span,
							"shell event stream ended before terminal status",
						);
						self.finish_session(&session, persistent, true).await;
						yield Ev::Aborted(Abort::EffectsUnknown {
							reason: cancellation_reason.unwrap_or_else(|| sf!("exec event stream ended before terminal status")),
						});
						return;
					},
					Err(fault) => {
						tracing::warn!(parent: &span, "shell event stream failed");
						self.finish_session(&session, persistent, true).await;
						yield Ev::Aborted(Abort::EffectsUnknown { reason: Str::new(fault.message()) });
						return;
					},
				}
			}
		}
	}

	fn prompt(&self, view: Result<&Payload, &Fault>, caps: &PromptCaps) -> Vec<Part> {
		let attachments = match view {
			Ok(payload) => payload.attachments.as_slice(),
			Err(Fault::CommandFailed { payload }) => payload.attachments.as_slice(),
			Err(_) => &[],
		};
		let Some(mut projection) = TextProjection::new(*caps) else {
			return attachment_parts(attachments, caps.media, usize::from(caps.maximum_parts));
		};
		match view {
			Ok(payload) => {
				let status = format!(
					"[status={:?}; exit={:?}; signal={:?}; {}ms]\n",
					payload.status.outcome,
					payload.status.exit_code,
					payload.status.signal,
					payload.status.wall_clock_ms,
				);
				if projection.push(&status) {
					for adjustment in &payload.adjustments {
						let AdjustmentReceipt::TimeoutClamped { requested_ms, effective_ms } = adjustment;
						if !projection.push(&format!(
							"[timeout adjusted from {requested_ms}ms to {effective_ms}ms]\n"
						)) {
							break;
						}
					}
					push_transcript(&mut projection, &payload.transcript);
					push_spilled_output(&mut projection, payload.status.spilled_output.as_ref());
					if !caps.media {
						push_attachment_fallbacks(&mut projection, attachments);
					}
				}
			},
			Err(Fault::CommandFailed { payload }) => {
				let status = format!(
					"bash command failed: status={:?}, exit={:?}, signal={:?}\n",
					payload.status.outcome, payload.status.exit_code, payload.status.signal,
				);
				if projection.push(&status) {
					push_transcript(&mut projection, &payload.transcript);
					push_spilled_output(&mut projection, payload.status.spilled_output.as_ref());
					if !caps.media {
						push_attachment_fallbacks(&mut projection, attachments);
					}
				}
			},
			Err(fault) => {
				projection.push(&fault.message());
			},
		}
		let mut parts = projection.finish();
		if caps.media {
			let remaining = usize::from(caps.maximum_parts).saturating_sub(parts.len());
			parts.extend(attachment_parts(attachments, true, remaining));
		}
		parts
	}

	fn invoke_input(&self, update: &Update, invocation_id: &str) -> Option<InvokeInput> {
		let channel = match update.channel {
			OutputChannel::Stdout | OutputChannel::Pty => chunk::Channel::Stdout,
			OutputChannel::Stderr => chunk::Channel::Stderr,
		};
		Some(InvokeInput {
			invocation_id: invocation_id.to_owned(),
			payload:       Some(invoke_input::Payload::Chunk(invoke_input::Chunk {
				channel: channel as i32,
				data:    update.data.clone().into_bytes(),
			})),
		})
	}
}

fn detached_terminal(
	job: DetachedJob,
	reason: &str,
	transcript: &[TranscriptFrame],
) -> ToolTerminal<Payload, Fault> {
	const PREVIEW_BYTES: usize = 2 * 1024;
	let mut description = String::from("named process settlement; detached because ");
	description.push_str(reason);
	let mut remaining = PREVIEW_BYTES;
	let mut preview = String::new();
	for frame in transcript {
		if remaining == 0 {
			break;
		}
		let bytes = frame.data.as_ref();
		let retained = bytes.len().min(remaining);
		preview.push_str(&String::from_utf8_lossy(&bytes[..retained]));
		remaining -= retained;
	}
	if !preview.trim().is_empty() {
		description.push_str("; pre-detach preview: ");
		description.push_str(preview.trim());
		if remaining == 0 {
			description.push_str(" [preview truncated]");
		}
	}
	managed_job_terminal(job, omp_tool::JobKind::Shell, Str::new(description))
}

fn interrupt_reason(
	interrupt: Result<Interrupt, InterruptWaitError>,
	closed_reason: &'static str,
) -> Str {
	match interrupt {
		Ok(interrupt) => interrupt.reason,
		Err(InterruptWaitError::Closed) => Str::new(closed_reason),
		Err(InterruptWaitError::Protocol(reason)) => reason,
	}
}

fn valid_env_key(key: &str) -> bool {
	let mut bytes = key.bytes();
	matches!(bytes.next(), Some(b'_' | b'a'..=b'z' | b'A'..=b'Z'))
		&& bytes.all(|byte| matches!(byte, b'_' | b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9'))
}

fn extract_leading_cd(command: &Str) -> (Str, Option<Str>) {
	let bytes = command.as_bytes();
	if !bytes.starts_with(b"cd") || bytes.get(2).is_none_or(|byte| !byte.is_ascii_whitespace()) {
		return (command.clone(), None);
	}
	let mut cursor = skip_space(bytes, 2);
	let Some((mut cwd, after_cwd)) = shell_word(bytes, cursor) else {
		return (command.clone(), None);
	};
	cursor = after_cwd;
	if cwd == "--" {
		cursor = skip_space(bytes, cursor);
		let Some((path, after_path)) = shell_word(bytes, cursor) else {
			return (command.clone(), None);
		};
		cwd = path;
		cursor = after_path;
	}
	cursor = skip_space(bytes, cursor);
	if cwd.contains(['$', '`', '(']) {
		return (command.clone(), None);
	}
	if bytes.get(cursor..cursor.saturating_add(2)) != Some(b"&&") {
		return (command.clone(), None);
	}
	cursor = skip_space(bytes, cursor + 2);
	if cursor == bytes.len() {
		return (command.clone(), None);
	}
	(Str::new(String::from_utf8_lossy(&bytes[cursor..])), Some(Str::new(cwd)))
}

fn skip_space(bytes: &[u8], mut cursor: usize) -> usize {
	while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
		cursor += 1;
	}
	cursor
}

fn shell_word(bytes: &[u8], start: usize) -> Option<(String, usize)> {
	let quote = *bytes.get(start)?;
	if quote == b'\'' || quote == b'"' {
		let mut cursor = start + 1;
		let mut word = Vec::new();
		while let Some(&byte) = bytes.get(cursor) {
			cursor += 1;
			if byte == quote {
				return Some((String::from_utf8_lossy(&word).into_owned(), cursor));
			}
			if byte == b'\\' && quote == b'"' {
				if let Some(&escaped) = bytes.get(cursor) {
					word.push(escaped);
					cursor += 1;
				}
			} else {
				word.push(byte);
			}
		}
		return None;
	}
	let mut cursor = start;
	while let Some(&byte) = bytes.get(cursor) {
		if byte.is_ascii_whitespace() || byte == b'&' {
			break;
		}
		cursor += 1;
	}
	(cursor != start).then(|| (String::from_utf8_lossy(&bytes[start..cursor]).into_owned(), cursor))
}

fn extract_transcript_images(transcript: &mut [TranscriptFrame]) -> Vec<ImagePassthrough> {
	let mut images = Vec::new();
	for channel in [OutputChannel::Stdout, OutputChannel::Stderr, OutputChannel::Pty] {
		let byte_len = transcript
			.iter()
			.filter(|frame| frame.channel == channel)
			.map(|frame| frame.data.len())
			.sum();
		let mut joined = Vec::with_capacity(byte_len);
		for frame in transcript.iter().filter(|frame| frame.channel == channel) {
			joined.extend_from_slice(frame.data.as_ref());
		}
		let (found, ranges) = image_passthrough_ranges(&joined);
		if ranges.is_empty() {
			continue;
		}
		images.extend(found);
		let mut channel_offset = 0;
		for frame in transcript
			.iter_mut()
			.filter(|frame| frame.channel == channel)
		{
			let frame_start = channel_offset;
			let frame_end = frame_start + frame.data.len();
			channel_offset = frame_end;
			let mut cleaned = Vec::with_capacity(frame.data.len());
			let mut retained_from = frame_start;
			for range in &ranges {
				let removed_start = range.start.max(frame_start).min(frame_end);
				let removed_end = range.end.max(frame_start).min(frame_end);
				if removed_start < removed_end {
					cleaned.extend_from_slice(&joined[retained_from..removed_start]);
					retained_from = removed_end;
				}
			}
			cleaned.extend_from_slice(&joined[retained_from..frame_end]);
			frame.data = CowBytes::owned(Bytes::from(cleaned));
		}
	}
	images
}

fn attachment_parts(attachments: &[BlobRef], media: bool, limit: usize) -> Vec<Part> {
	if !media {
		return Vec::new();
	}
	attachments
		.iter()
		.take(limit)
		.map(|blob| Part::Blob {
			blob: blob.clone(),
			alt:  Some(sf!(
				"Image attachment from shell output ({}, {} bytes).",
				blob.media_type,
				blob.byte_len
			)),
		})
		.collect()
}

fn push_attachment_fallbacks(projection: &mut TextProjection, attachments: &[BlobRef]) {
	for blob in attachments {
		if !projection.push(&format!(
			"[image attachment: {}, {} bytes, artifact://sha256/{}]\n",
			blob.media_type, blob.byte_len, blob.hash
		)) {
			break;
		}
	}
}

fn push_spilled_output(projection: &mut TextProjection, spilled: Option<&BlobRef>) {
	if let Some(spilled) = spilled {
		let _ = projection.push(&format!(
			"[full output: artifact://sha256/{}; {} bytes]\n",
			spilled.hash, spilled.byte_len
		));
	}
}

fn push_transcript(projection: &mut TextProjection, transcript: &[TranscriptFrame]) {
	for frame in transcript {
		if !projection.push(&String::from_utf8_lossy(frame.data.as_ref())) {
			break;
		}
	}
}

fn param_event<U, P>(error: ParamError) -> Ev<U, P, Fault> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Skipped { reason: interrupt.reason })
		},
		ParamError::Protocol(reason) => Ev::Args(protocol_issue(reason)),
	}
}

fn commit_event<U, P>(error: CommitError) -> Ev<U, P, Fault> {
	match error {
		CommitError::Aborted => Ev::Aborted(Abort::InputDropped),
		CommitError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Skipped { reason: interrupt.reason })
		},
		CommitError::Protocol(reason) => Ev::Args(protocol_issue(reason)),
	}
}

fn protocol_issue(reason: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one complete bash@2 argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  Some(sf!(r#"{{"command":"printf hello"}}"#)),
		found:    Some(reason),
	}
}

mod cow_bytes {
	use omp_core::CowBytes;
	use serde::{Deserialize, Deserializer, Serialize, Serializer};

	pub(super) fn serialize<S: Serializer>(
		value: &CowBytes<'static>,
		serializer: S,
	) -> Result<S::Ok, S::Error> {
		value.serialize(serializer)
	}

	pub(super) fn deserialize<'de, D: Deserializer<'de>>(
		deserializer: D,
	) -> Result<CowBytes<'static>, D::Error> {
		Vec::<u8>::deserialize(deserializer).map(CowBytes::from)
	}
}
#[cfg(test)]
mod tests {
	use super::*;

	fn prompt_snapshot(devices: bool) -> ShellPromptSnapshot {
		ShellPromptSnapshot {
			sibling_tools: Arc::default(),
			platform: Str::new("linux"),
			command_prefix: false,
			embedded_builtins: true,
			devices,
			interceptor_enabled: false,
			interceptor_rules: Arc::default(),
			acp_routing: false,
		}
	}

	#[test]
	fn leading_cd_extraction_preserves_shell_expansions() {
		for command in
			[r#"cd "$HOME" && pwd"#, "cd `pwd` && printf done", r#"cd "$(pwd)" && printf done"#]
		{
			assert_eq!(extract_leading_cd(&Str::new(command)), (Str::new(command), None));
		}
	}

	#[test]
	fn leading_cd_extraction_accepts_only_static_targets() {
		assert_eq!(
			extract_leading_cd(&sf!(r#"cd "/tmp/a b" && pwd"#)),
			(sf!("pwd"), Some(sf!("/tmp/a b")))
		);
	}

	#[test]
	fn shell_description_mentions_dyn_only_when_devices_are_installed() {
		let enabled = prompt_snapshot(true).description();
		assert!(
			enabled
				.ends_with(" Dynamic devices: `dyn` builtin (list `dyn`; docs `dyn <device> --help`).")
		);
		assert!(enabled.contains("`dyn`"));

		let disabled = prompt_snapshot(false).description();
		assert!(!disabled.contains("`dyn`"));
	}

	#[test]
	fn bash_declares_no_whole_script_capability() {
		assert!(spec(&prompt_snapshot(false)).effects.is_empty());
	}

	#[test]
	fn default_timeout_bounds_cover_one_through_3600_seconds() {
		let bounds = TimeoutBounds::default();
		assert_eq!(bounds.default_ms, 300_000);
		assert_eq!(bounds.floor_ms, 1_000);
		assert_eq!(bounds.ceiling_ms, 3_600_000);
	}

	#[test]
	fn params_schema_stays_strict_and_allocates_async_jobs_internally() {
		use omp_ai::recovery::tools::{
			ToolAssemblyLimits, schema_within_strict_subset, validate_schema,
		};
		let schema_bytes = omp_tool::schema::<Params>();
		let schema: serde_json::Value =
			serde_json::from_slice(&schema_bytes).expect("generated schema is JSON");
		// Out-of-subset keywords would make strict recovery validation reject
		// every shell call at runtime (the aborted-turn regression behind
		// `tool.assembly-rejected`).
		assert!(
			schema_within_strict_subset(&schema, ToolAssemblyLimits::default()),
			"shell schema left the strict validation subset: {schema}"
		);
		let limits = ToolAssemblyLimits::default();
		let valid = [
			serde_json::json!({"i": "Running shell command", "command": "echo hi"}),
			serde_json::json!({"i": "Running shell command", "command": "echo hi", "async": false}),
			serde_json::json!({"i": "Starting background process", "command": "sleep 5", "async": true}),
			serde_json::json!({"i": "Running build", "command": "make", "timeout": 0}),
		];
		for arguments in valid {
			assert!(
				validate_schema(&schema, &arguments, true, limits).is_ok(),
				"expected valid shell call rejected: {arguments}"
			);
		}
		assert!(
			validate_schema(
				&schema,
				&serde_json::json!({"i": "Starting background process", "command": "sleep 5", "async": true, "name": "caller-owned"}),
				true,
				limits,
			)
			.is_err(),
			"caller-authored process names belong to hub start, not bash async"
		);
	}
}
