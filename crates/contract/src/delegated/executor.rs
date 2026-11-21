//! The two traits a backend implements.
//!
//! Neither trait takes or returns a credential, an auth path or an
//! environment map. The CLI owns its login; the backend only reports an
//! [`AuthStatus`] it can observe without reading anything secret.

use std::{path::PathBuf, time::Duration};

use omp_core::Hash32;

use super::{
	Capabilities, CliSessionId, CliVersion, DelegatedEvent, DelegatedPolicy, DelegatedPrompt,
	ExecutionMode, ExecutorError, PermissionAnswer, PromptId, TurnId,
};

/// What the CLI says about its own login.
#[derive(
	Clone, Copy, Debug, Eq, Hash, PartialEq, strum::Display, strum::EnumString, strum::IntoStaticStr,
)]
#[strum(serialize_all = "snake_case")]
pub enum AuthStatus {
	/// The CLI is logged in.
	Authenticated,
	/// The CLI is not logged in.
	Required,
	/// The CLI exposes no safe, non-destructive way to tell. Reported as such
	/// instead of guessed.
	Unknown,
}

/// What a backend learns about the installed CLI before any session exists.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProbeReport {
	/// The installed CLI version.
	pub version: CliVersion,
	/// The CLI's login state.
	pub auth:    AuthStatus,
}

/// Whether a session may open when the CLI cannot report its login state.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Eq,
	Hash,
	PartialEq,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[strum(serialize_all = "snake_case")]
pub enum UnknownAuth {
	/// Refuse. The default: unknown is not good enough.
	#[default]
	Refuse,
	/// Proceed and let the CLI report `AuthRequired` on the first turn.
	Proceed,
}

/// Everything needed to open one session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionRequest {
	/// Who owns authentication and the loop. Must match the executor.
	pub mode:         ExecutionMode,
	/// Absolute directory the agent is rooted at.
	pub workdir:      PathBuf,
	/// The policy the session is held to.
	pub policy:       DelegatedPolicy,
	/// A CLI session to resume, or `None` for a fresh one.
	pub resume:       Option<CliSessionId>,
	/// Handling of an `Unknown` login state.
	pub unknown_auth: UnknownAuth,
}

/// What a backend reports about the session it opened.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionInfo {
	/// The CLI's session identity.
	pub session: CliSessionId,
	/// Whether an existing session was resumed.
	pub resumed: bool,
	/// The directory the agent is actually rooted at.
	pub workdir: PathBuf,
	/// The policy the backend actually applies.
	pub policy:  DelegatedPolicy,
}

/// The input that starts a turn: the exact prompt OMP would have used for its
/// own agent run, already rendered. The backend forwards it verbatim; it adds
/// no paraphrase, summary or rewrite.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnInput {
	/// The fully rendered prompt.
	pub prompt: DelegatedPrompt,
}

/// A started turn, with proof of what was sent to the CLI.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnAccepted {
	/// The turn.
	pub turn:      TurnId,
	/// [`DelegatedPrompt::digest_of`] computed over the bytes the backend
	/// actually delivered to the CLI. The host compares it with
	/// [`DelegatedPrompt::digest`].
	pub forwarded: Hash32,
}

/// Time limits of one turn.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TurnLimits {
	/// Total time the agent may work. Time spent waiting for a human to answer
	/// a permission prompt is not counted.
	pub timeout:         Duration,
	/// Longest silence tolerated between two events.
	pub idle:            Duration,
	/// How long a cooperative interrupt may take before the process is killed.
	pub interrupt_grace: Duration,
}

/// A delegated agent backend: knows what it can do and opens sessions.
pub trait DelegatedExecutor: Send + Sync {
	/// The live session type.
	type Session: DelegatedSession;

	/// What this executor declares about itself.
	fn capabilities(&self) -> &Capabilities;

	/// Inspects the installed CLI without starting an agent.
	///
	/// # Errors
	///
	/// [`ExecutorError::ExecutableMissing`] when the CLI is absent.
	fn probe(&self) -> impl Future<Output = Result<ProbeReport, ExecutorError>> + Send + '_;

	/// Starts the CLI and opens a session under `request`.
	///
	/// The backend must apply `request.policy` itself and report what it
	/// applied in [`SessionInfo::policy`]; the host verifies the two match.
	///
	/// # Errors
	///
	/// Any [`ExecutorError`] raised while starting the process.
	fn open<'a>(
		&'a self,
		request: &'a SessionRequest,
	) -> impl Future<Output = Result<(Self::Session, SessionInfo), ExecutorError>> + Send + 'a;
}

/// One live delegated session, owning one CLI process tree.
///
/// Dropping a session MUST kill the whole process tree and reap it. The host
/// calls [`DelegatedSession::terminate`] on every orderly end, but `Drop` is
/// the guarantee when it cannot.
pub trait DelegatedSession: Send {
	/// Starts a turn by delivering `input.prompt` verbatim, and returns the
	/// turn identity with the digest of the bytes delivered.
	///
	/// # Errors
	///
	/// Any [`ExecutorError`]; the host ends the session on all of them.
	fn start_turn<'a>(
		&'a mut self,
		input: &'a TurnInput,
	) -> impl Future<Output = Result<TurnAccepted, ExecutorError>> + Send + 'a;

	/// Waits for the next normalized event.
	///
	/// MUST be cancel-safe: the host races it against timeouts and
	/// cancellation and drops it mid-wait. A process that dies must surface as
	/// [`ExecutorError::Crashed`], never as a silent end of stream.
	///
	/// # Errors
	///
	/// [`ExecutorError::MalformedStream`], [`ExecutorError::Crashed`], or any
	/// other failure of the stream.
	fn next_event(
		&mut self,
	) -> impl Future<Output = Result<DelegatedEvent, ExecutorError>> + Send + '_;

	/// Answers a pending permission prompt.
	///
	/// # Errors
	///
	/// Any [`ExecutorError`].
	fn answer<'a>(
		&'a mut self,
		prompt: &'a PromptId,
		answer: PermissionAnswer,
	) -> impl Future<Output = Result<(), ExecutorError>> + Send + 'a;

	/// Asks the running turn to stop cooperatively. Only called when the
	/// executor advertised [`Feature::Interrupt`](super::Feature::Interrupt).
	///
	/// # Errors
	///
	/// Any [`ExecutorError`].
	fn interrupt(&mut self) -> impl Future<Output = Result<(), ExecutorError>> + Send + '_;

	/// Terminates the process tree and reaps it: interrupt, bounded grace,
	/// then kill, idempotently.
	///
	/// # Errors
	///
	/// [`ExecutorError::TeardownFailed`] when the tree could not be reaped.
	fn terminate(&mut self) -> impl Future<Output = Result<(), ExecutorError>> + Send + '_;
}

/// Unified executor contract covering native OMP2 and delegated executors.
///
/// ADR 0052 D5: native OMP2 is an executor behind the same interface as
/// delegated executors, so a workflow can move a phase between native and
/// delegated without edits. The trait covers Subagent and Execution JobKind
/// shapes only — Tool and Process stay in the job board since they are
/// single-turn.
pub trait Executor: Send + Sync {
	/// What this executor declares about itself.
	fn capabilities(&self) -> &Capabilities;

	/// Executes a work assignment and returns evidence (not a verdict).
	///
	/// The executor reports evidence; ADW alone decides acceptance from
	/// evidence, gates, and an independent verdict (ADR 0053 D1).
	fn execute(
		&self,
		assignment: WorkAssignment,
	) -> impl Future<Output = Result<WorkOutcome, ExecutorError>> + Send;

	/// Cancels an in-flight turn.
	fn cancel(&self, turn: TurnId) -> impl Future<Output = Result<(), ExecutorError>> + Send;
}

/// A work item to be executed by an [`Executor`].
#[derive(Clone, Debug)]
pub struct WorkAssignment {
	/// The prompt or command to execute.
	pub prompt:  DelegatedPrompt,
	/// Maximum time for this assignment.
	pub timeout: Duration,
}

/// The outcome of executing a [`WorkAssignment`].
#[derive(Clone, Debug)]
pub enum WorkOutcome {
	/// The work completed with evidence.
	Accepted {
		/// The answer or output produced.
		answer: omp_core::Str,
	},
	/// The work was rejected.
	Rejected {
		/// Feedback explaining the rejection.
		feedback: omp_core::Str,
	},
	/// The work was cancelled.
	Cancelled,
}
