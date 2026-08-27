//! Durable project-chat composition.

pub mod agents;
use std::{
	cmp,
	collections::{BTreeMap, BTreeSet},
	env, ffi, fs, io, iter, num,
	path::{Path, PathBuf},
	pin::Pin,
	process,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use flume::Receiver;
use futures::StreamExt as _;
use omp_agent::{
	Agent, AgentKind, AgentNode, AgentSnapshot, AgentState, AgentStatus, AgentTree, Budget,
	ChildKind, CompletionError, CompletionRequest, Journal, MAX_YIELD_SCHEMA_RETRIES, PromptFacts,
	RegistryStatus, SubagentDisposition, SubagentLifecycle, SubagentProgressSnapshot,
	SubagentRunState, SubagentTerminalKind, SubagentTerminalStatus, TurnClient, TurnId, TurnInput,
	TurnOptions, TurnSession as _, UnexpectedStopClassifier, WorkspaceRootInput,
	WorkspaceRootsInput, YieldPayloadValidator, project_journal, resolve_completion,
	scheduler::BudgetReservation,
};
use omp_catalog::{AuthSpecKind, GrammarBits, model::ProvenanceKind, snapshot};
use omp_core::{ExposeSecret as _, Str, sf};
use omp_envd::{
	eval::{
		BridgeHostError, ParentSessionHost,
		spawn::{SpawnRequestV1, SpawnSchemaMode},
	},
	exthost::control::{
		self, ControlAuthority, ControlAuthorityFactory, ControlCompositionError,
		ControlConnectionIdentity, ControlEffect, ControlProtocolError, FixedControlAuthorityFactory,
	},
};
use omp_inference::{
	Client, Registry as InferenceRegistry, ToolDefinition, ToolGrammarSyntax, ToolInputConstraint,
	answer::{AuthAnswer, AuthEvent, AuthPromptKind as InferenceAuthPromptKind, AuthResponse},
	call::{AuthInput, AuthRequest, CallMeta, LoginRequest, Target},
	error::{ErrorDetail, ErrorKind},
	id::RequestId,
	receipt::ExecutionBudget,
	router::Router,
};
use omp_proto::{
	env::v1 as env_pb,
	inference::v1::{
		self as inference_pb, Effort, response_format, tool_def, tool_def::grammar, turn_event,
	},
	thread::{
		v1,
		v1::{Item, Message, Part, Role, Thread, item, part},
	},
};
use omp_sdk::{SessionBlueprint, SessionBuilder, SessionOptions};
use omp_settings::manager::SettingsManagerError;
use omp_storage::{
	atomic,
	blob::{self, BlobStore},
	gc,
	index::{self, IndexedWriteError, NewSession, SessionIndex, SessionKind},
	transcript,
	transcript::{Header, Kind, SessionId},
};
use omp_telemetry::firehose::Firehose;
use omp_tool::{CapsBase, LoweringCaps, ModelClass, Registry};
use parking_lot::Mutex;
use prost::Message as _;
use serde_json::{Value, json, value::RawValue};
use thiserror::Error;
use tokio::{task::JoinHandle, time, time::MissedTickBehavior};
use url::Url;
use xutf::IntoAnsiStripped as _;

pub use crate::subagent::advisor_child::{
	AdvisorBatchOutcome, AdvisorChildError, AdvisorChildSpec,
};
use crate::{
	auth_flow::{AuthPromptKind, ChatAuth, ChatAuthCommand, ChatAuthEvent},
	discovery,
	hub::{self as hub_backend},
	model_controls::{
		ProviderCatalogCursor, ProviderControlBackend, ProviderControlError, ProviderControlRequest,
		ProviderControlResult, ProviderDeclarationDocument, ProviderModelCard, ProviderModelEvent,
		ProviderPrice,
	},
	modes::{RegimeError, RegimeHandle},
	plan::{OverallPlanReference, PlanArtifactStore},
	prompt_prep::PromptSnapshot,
	rulebook,
	security_review::{
		profile,
		result::{ReviewScope, validate_and_retain},
	},
	session_state::SessionResolveError,
	session_title::OnlineTitleCompletion,
	settings::AutoThinkingSettings,
	subagent::{
		advisor_child::{self, AdvisorChildren, AdvisorSpawnContext},
		artifacts,
		output::persist_bounded,
		prewalk::PrewalkGate,
		prompt::{
			ModelFamilyCapabilities, PromptPeer, SubagentPromptInput, compose, peer_from_node, props,
		},
		settings::{LiveTaskSettings, TaskIsolationMerge, TaskIsolationMode, TaskSettings},
		snapshot::{ChildSnapshotOptions, child_snapshot},
		supervisor::{
			ChildReviver, RevivalFuture, SessionSupervisor, SupervisedRuntime, SupervisorError,
		},
		yield_driver,
	},
};

/// Reasoning effort selected for one composed chat session.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display, strum::EnumString)]
#[strum(serialize_all = "kebab-case")]
pub enum ThinkingLevel {
	/// Disable provider reasoning.
	Off,
	/// Request the smallest supported reasoning budget.
	Minimal,
	/// Request low reasoning effort.
	Low,
	/// Request medium reasoning effort.
	Medium,
	/// Request high reasoning effort.
	High,
	/// Request the provider's extreme reasoning effort.
	Extreme,
	/// Alias for the provider's maximum reasoning effort.
	Max,
	/// Request extra-high reasoning effort when supported.
	XHigh,
	/// Select effort from the configured automatic policy.
	Auto,
}

/// Durable owner-local session pin persistence failure.
#[derive(Debug, Error)]
pub enum PinError {
	/// Pin file access failed.
	#[error("session pin I/O failed")]
	Io(#[from] io::Error),
	/// Pin metadata encoding failed.
	#[error("failed to encode session pin metadata")]
	Json(#[from] serde_json::Error),
	/// Atomic pin publication failed.
	#[error("failed to publish session pins")]
	Atomic(#[from] atomic::Error),
}

/// Project-local pinned session identities stored beside session journals.
pub struct PinStore {
	path: PathBuf,
}

impl PinStore {
	/// Opens the pin file belonging to `sessions_dir`.
	pub fn new(sessions_dir: &Path) -> Self {
		Self { path: sessions_dir.join("session-pins.json") }
	}

	/// Loads the complete deterministic pin set.
	pub fn load(&self) -> Result<BTreeSet<Str>, PinError> {
		let bytes = match fs::read(&self.path) {
			Ok(bytes) => bytes,
			Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeSet::new()),
			Err(error) => return Err(error.into()),
		};
		let pins: Vec<Value> = serde_json::from_slice(&bytes).unwrap_or_else(|error| {
			tracing::warn!(
				path = %self.path.display(),
				%error,
				"ignoring corrupt session pin metadata"
			);
			Vec::new()
		});
		Ok(pins
			.into_iter()
			.filter_map(|pin| match pin {
				Value::String(id) => Some(Str::from(id)),
				_ => None,
			})
			.collect())
	}

	/// Toggles one session and atomically persists the complete set.
	pub fn toggle(&self, session: &SessionId) -> Result<bool, PinError> {
		let mut pins = self.load()?;
		let pinned = if pins.remove(session.0.as_str()) {
			false
		} else {
			pins.insert(session.0.clone());
			true
		};
		let bytes = serde_json::to_vec_pretty(&pins)?;
		atomic::commit(&self.path, &bytes, || true)?;
		Ok(pinned)
	}
}

/// One project-local durable session offered by resume selection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResumeChoice {
	/// Stable session identity submitted by the picker.
	pub id:     Str,
	/// Human-readable session name.
	pub label:  Str,
	/// Recency and identity details shown beneath the name.
	pub detail: Str,
	/// Whether the session is pinned above ordinary recency ordering.
	pub pinned: bool,
}

/// Launch-time tool admission selected by a composition layer.
pub struct LaunchToolSelection<'a> {
	/// Explicit tool names, or all discovered tools when absent.
	pub tools:    Option<&'a [Str]>,
	/// Disable every tool.
	pub no_tools: bool,
	/// Disable language-server tools.
	pub no_lsp:   bool,
	/// Disable pseudo-terminal access.
	pub no_pty:   bool,
}

/// Base tool-lowering capabilities shared by durable chat loops.
pub const CHAT_CAPS_BASE: CapsBase = CapsBase {
	maximum_parts:      1,
	maximum_text_bytes: 64 * 1024,
	media:              false,
	model_class:        ModelClass::Standard,
};
const DEFAULT_EVAL_CONCURRENCY_LIMIT: usize = omp_agent::DEFAULT_MAX_CONCURRENCY;

/// Failures while resolving or running one durable project-chat session.
#[derive(Debug, Error)]
pub enum ChatError {
	/// The requested project root could not be canonicalized.
	#[error("could not resolve project root {path}")]
	Project {
		/// Project path supplied by the caller.
		path:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
	/// The canonical project path is not a directory.
	#[error("project root is not a directory: {0}")]
	ProjectNotDirectory(PathBuf),
	/// Project-local state could not be accessed.
	#[error("could not access project state {path}")]
	ProjectState {
		/// State path that failed.
		path:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
	/// The requested resume identity is not a canonical ULID or lowercase UUID.
	#[error("invalid chat session id: {0}")]
	InvalidResume(Str),
	/// The requested durable session does not exist.
	#[error("chat session does not exist: {0}")]
	MissingResume(Str),
	/// The journal header did not match the requested session.
	#[error("chat journal identity does not match session {0}")]
	SessionMismatch(Str),
	/// The journal belongs to a different canonical project root.
	#[error("chat session {session} belongs to a different project")]
	SessionProjectMismatch {
		/// Requested session identity.
		session: Str,
	},
	/// Durable transcript state failed to open, create, or project.
	#[error(transparent)]
	Journal(#[from] omp_agent::JournalError),
	/// Durable compaction blob placement could not be initialized.
	#[error(transparent)]
	Blob(#[from] blob::Error),
	/// Session artifact metadata authority could not be initialized.
	#[error(transparent)]
	Artifact(#[from] gc::Error),
	/// Owner-local session discovery state failed.
	#[error(transparent)]
	SessionResolve(#[from] SessionResolveError),
	/// Owner-local session pin metadata failed.
	#[error(transparent)]
	Pin(#[from] PinError),
	/// Cross-process loop revival failed.
	#[error(transparent)]
	Revival(#[from] omp_agent::RevivalError),
	/// The authoritative write-time sessions index failed.
	#[error(transparent)]
	SessionIndex(#[from] index::Error),
	/// A durable session was requested without an authoritative write-time
	/// index.
	#[error("durable session storage has no authoritative index")]
	MissingSessionIndex,
	/// A durable transcript could not be projected into canonical replay items.
	#[error(transparent)]
	Projection(#[from] omp_agent::ProjectionError),
	/// The project environment authority failed to start or connect.
	#[error(transparent)]
	Environment(#[from] omp_envd::EnvdError),
	/// The in-process turn authority could not be constructed.
	#[error(transparent)]
	TurnClient(#[from] omp_agent::Error),
	/// Typed settings projection failed while composing a session boundary.
	#[error(transparent)]
	Settings(#[from] SettingsManagerError),
	/// A tool schema could not be encoded for the turn protocol.
	#[error("could not encode tool schema")]
	ToolSchema(#[source] serde_json::Error),
	/// A requested tool is absent after native and extension discovery.
	#[error("unknown tool `{name}`; valid tools: {valid:?}")]
	UnknownTool {
		/// Requested normalized name.
		name:  Str,
		/// Fully discovered valid names.
		valid: Vec<Str>,
	},
	/// The live tool registry could not lower its advertised slots.
	#[error(transparent)]
	ToolRegistry(#[from] omp_tool::RegistryError),
	/// Shared SDK session planning failed before loop construction.
	#[error(transparent)]
	SessionBuild(#[from] omp_sdk::SessionBuildError),
	/// Process-global parked-session discovery failed.
	#[error(transparent)]
	AgentRegistry(#[from] omp_agent::RegistryError),
	/// The requested model selector names a catalog route, not a model.
	#[error("`{selector}` is a route id, not a model{hint}")]
	ModelSelectorIsRoute {
		/// Selector supplied by the caller.
		selector: Str,
		/// Preformatted candidate-model hint, or empty.
		hint:     Str,
	},
	/// The requested model selector matches no catalog model or alias.
	#[error("unknown model `{selector}`{suggestions}")]
	UnknownModel {
		/// Selector supplied by the caller.
		selector:    Str,
		/// Preformatted nearest-key hint, or empty.
		suggestions: Str,
	},
	/// The selected model has no route for the requested credential provider.
	#[error("model `{model}` is not served by provider `{provider}`")]
	ModelProviderUnavailable {
		/// Canonical selected model.
		model:    Str,
		/// Provider requested or selected for the invocation credential.
		provider: omp_catalog::ProviderId,
	},
	/// The selected model has no concrete provider route.
	#[error("model `{model}` has no provider route")]
	ModelHasNoProvider {
		/// Canonical selected model.
		model: Str,
	},
	/// The session-scoped eval parent bridge could not be bound.
	#[error("eval session bridge failed: {0}")]
	EvalBridge(Str),
	/// The session-scoped memory reflection bridge could not be bound.
	#[error(transparent)]
	MemoryReflection(#[from] omp_envd::memory::ReflectionBindingError),
	/// Mnemopi prompt snapshot construction failed.
	#[error(transparent)]
	Memory(#[from] omp_memory::Error),
	/// Startup automation mode conflicts with the active execution state.
	#[error(transparent)]
	Mode(#[from] RegimeError),
	/// Regime recovery or durable lifecycle mutation failed.
	#[error(transparent)]
	Regime(#[from] omp_agent::AgentError),
	/// The platform cannot enforce the Phase 3 owner-local environment contract.
	#[error("interactive chat requires Unix owner-local project authorities")]
	UnsupportedPlatform,
}

#[derive(Debug, Error)]
enum ChildInitError {
	#[error(transparent)]
	Blob(#[from] blob::Error),
	#[error(transparent)]
	Journal(#[from] omp_agent::JournalError),
	#[error("child output schema could not be encoded")]
	Schema(#[source] serde_json::Error),
	#[error("child workspace root cannot be represented as a file URI")]
	WorkspaceRoot,
}

/// Open durable chat session and its replayable initial projection.
pub struct Session {
	/// Stable durable session identity.
	pub id:            Str,
	/// Append-only session journal.
	pub journal:       Journal,
	/// Canonical items projected before live execution.
	pub initial_items: Vec<v1::Item>,
}

/// Durable session operation selected by the composition layer.
#[derive(Clone, Copy, Debug)]
pub enum SessionOpen<'a> {
	/// Create a new durable session.
	New,
	/// Resume an existing session.
	Resume(&'a Str),
	/// Resume a session whose canonical project moved.
	ResumeMoved(&'a Str),
	/// Fork an existing session.
	Fork(&'a Str),
	/// Create a process-lifetime ephemeral session.
	Ephemeral,
}

/// Process-owned temporary session directory removed on drop.
pub struct EphemeralSessions {
	path: Option<PathBuf>,
}

impl EphemeralSessions {
	/// Creates an isolated temporary sessions directory.
	pub fn create() -> Result<Self, ChatError> {
		let path = env::temp_dir()
			.join("omp")
			.join("sessions")
			.join(omp_core::Ulid::generate().to_string());
		ensure_state_directory(&path)?;
		Ok(Self { path: Some(path) })
	}

	/// Borrows the temporary sessions directory.
	pub fn path(&self) -> &Path {
		self
			.path
			.as_deref()
			.expect("ephemeral session path remains live")
	}
}

impl Drop for EphemeralSessions {
	fn drop(&mut self) {
		if let Some(path) = self.path.take() {
			let _ = fs::remove_dir_all(path);
		}
	}
}

/// Durable chat resources borrowed by one interactive host.
pub struct ChatScope<'a> {
	/// Embedded model catalog.
	pub catalog:          &'a snapshot::Catalog,
	/// Canonical project root.
	pub root:             &'a Path,
	/// Session journal directory.
	pub sessions_dir:     &'a Path,
	/// Authoritative session index.
	pub session_index:    Arc<SessionIndex>,
	/// Fully composed tool registry.
	pub registry:         Arc<Registry>,
	/// Clone-shared session queue backing the environment's `advise@1` device.
	pub advise_queue:     omp_agent::advisor::AdvisorAdviceQueue,
	/// Whether owner-local session state is persisted.
	pub persist_sessions: bool,
}
/// Background provider-authentication worker used by interactive chat.
pub struct ChatAuthWorker {
	ui:   ChatAuth,
	task: Option<JoinHandle<()>>,
}

impl ChatAuthWorker {
	/// Starts the serialized authentication worker.
	pub fn start(registry: InferenceRegistry) -> Self {
		let (command_tx, command_rx) = flume::unbounded();
		let (event_tx, event_rx) = flume::unbounded();
		let active = Arc::new(AtomicBool::new(false));
		let worker_active = Arc::clone(&active);
		let task = tokio::spawn(async move {
			while let Ok(command) = command_rx.recv_async().await {
				let ChatAuthCommand::Start(provider) = command else {
					continue;
				};
				let reset = AuthActivity(Arc::clone(&worker_active));
				let result = run_chat_login(&registry, provider, &event_tx, &command_rx).await;
				drain_auth_commands(&command_rx);
				drop(reset);
				let event = match result {
					Ok(message) => ChatAuthEvent::Complete(message),
					Err(ChatLoginFailure::CredentialStorageLocked) => {
						ChatAuthEvent::CredentialStorageLocked
					},
					Err(ChatLoginFailure::Message(error)) => ChatAuthEvent::Failed(error),
				};
				let _ = event_tx.send(event);
			}
		});
		Self { ui: ChatAuth::new(command_tx, event_rx, active), task: Some(task) }
	}

	/// Returns the UI-facing handle for the worker.
	pub const fn ui(&self) -> &ChatAuth {
		&self.ui
	}

	/// Stops the background worker and waits for cancellation.
	pub async fn shutdown(mut self) {
		if let Some(task) = self.task.take() {
			task.abort();
			let _ = task.await;
		}
	}
}

impl Drop for ChatAuthWorker {
	fn drop(&mut self) {
		if let Some(task) = &self.task {
			task.abort();
		}
	}
}

#[must_use]
struct AuthActivity(Arc<AtomicBool>);

impl Drop for AuthActivity {
	fn drop(&mut self) {
		self.0.store(false, Ordering::Release);
	}
}

enum ChatLoginFailure {
	CredentialStorageLocked,
	Message(Str),
}

impl From<Str> for ChatLoginFailure {
	fn from(message: Str) -> Self {
		Self::Message(message)
	}
}
fn auth_error_message(error: &omp_inference::Error) -> Str {
	let detail = match error.detail_ref() {
		Some(ErrorDetail::Provider { sanitized_message }) => Some(sanitized_message.as_str()),
		_ => None,
	};
	match (detail, error.status, error.code.as_deref()) {
		(Some(detail), Some(status), Some(code)) => {
			sf!("{error}: {detail} ({status}, {code})")
		},
		(Some(detail), Some(status), None) => sf!("{error}: {detail} ({status})"),
		(Some(detail), None, Some(code)) => sf!("{error}: {detail} ({code})"),
		(Some(detail), None, None) => sf!("{error}: {detail}"),
		(None, ..) => Str::from(error.to_string()),
	}
}
fn chat_login_failure(
	provider: &omp_catalog::ProviderId<str>,
	error: &omp_inference::Error,
) -> ChatLoginFailure {
	if error.kind == ErrorKind::CredentialStorageUnavailable {
		ChatLoginFailure::CredentialStorageLocked
	} else {
		ChatLoginFailure::Message(sf!(
			"Authentication failed for provider `{provider}`. Use `/login {provider}` to try again. \
			 {}",
			auth_error_message(error)
		))
	}
}

async fn run_chat_login(
	registry: &InferenceRegistry,
	provider: Str,
	events: &flume::Sender<ChatAuthEvent>,
	commands: &Receiver<ChatAuthCommand>,
) -> Result<Str, ChatLoginFailure> {
	let provider = omp_catalog::ProviderId::from(provider);
	let planner = Router::new(registry.clone(), Duration::from_secs(30));
	let meta = CallMeta {
		id:       RequestId::from(format!("chat-auth-{}", omp_core::Ulid::generate())),
		target:   Target::ProviderService(provider.clone()),
		deadline: None,
		budget:   ExecutionBudget::default(),
		session:  None,
	};
	let mut client = Client::new(registry.service(), planner, meta);
	let answer = client
		.execute(AuthRequest::Login(LoginRequest { provider: provider.clone(), method: None }))
		.await
		.map_err(|error| chat_login_failure(&provider, &error))?;
	let AuthAnswer::Session(session) = answer else {
		return Err(
			sf!(
				"Provider `{provider}` did not start an interactive login. Use `/login {provider}` to \
				 try again."
			)
			.into(),
		);
	};
	let mut awaiting_prompt = false;
	// Device polling emits `Waiting` every poll tick; the transcript notice is
	// append-only, so forward it once per login.
	let mut waiting_notified = false;
	loop {
		tokio::select! {
			event = session.events.recv_async() => {
				let event = event
					.map_err(|_| {
						sf!(
							"Authentication for provider `{provider}` ended without completing. Use \
							 `/login {provider}` to try again."
						)
					})?
					.map_err(|error| chat_login_failure(&provider, &error))?;
				match event {
					AuthEvent::OpenUrl { url, launch } => {
						// Launch the browser directly (best-effort); the forwarded
						// event keeps the clickable/copyable URL as fallback.
						omp_core::open::open_path(&url);
						events
							.send(ChatAuthEvent::Url { url, launch })
							.map_err(|_| sf!("chat authentication view closed"))?;
					},
					AuthEvent::ShowDeviceCode { code, verification_url } => {
						// pi opens the verification URL for device flows too; the
						// code stays visible in the forwarded event.
						omp_core::open::open_path(&verification_url);
						events
							.send(ChatAuthEvent::DeviceCode {
								code: Str::from(code.expose_secret()),
								url:  verification_url,
							})
							.map_err(|_| sf!("chat authentication view closed"))?;
					},
					AuthEvent::Prompt(prompt) => {
						let kind = match prompt.input {
							InferenceAuthPromptKind::ApiKey => AuthPromptKind::ApiKey,
							InferenceAuthPromptKind::AuthorizationCode => {
								AuthPromptKind::AuthorizationCode
							},
							InferenceAuthPromptKind::SessionToken => AuthPromptKind::SessionToken,
							InferenceAuthPromptKind::PlainText => AuthPromptKind::PlainText,
							InferenceAuthPromptKind::OptionalSecret => AuthPromptKind::OptionalSecret,
							InferenceAuthPromptKind::Confirmation => AuthPromptKind::Confirmation,
						};
						events
							.send(ChatAuthEvent::Prompt { message: prompt.message, kind })
							.map_err(|_| sf!("chat authentication view closed"))?;
						awaiting_prompt = true;
					},
					AuthEvent::Waiting => {
						if waiting_notified {
							continue;
						}
						waiting_notified = true;
						events
							.send(ChatAuthEvent::Notice(sf!(
								"Waiting for `{provider}` authorization…"
							)))
							.map_err(|_| sf!("chat authentication view closed"))?;
					},
					AuthEvent::Complete(account) => {
						return Ok(sf!(
							"Authenticated `{}` for `{}`.",
							account.account,
							account.provider
						));
					},
				}
			},
			command = commands.recv_async() => match command {
				Ok(ChatAuthCommand::Cancel) => {
					send_auth_response(&session, AuthInput::Cancel, &provider).await?;
					return Err(
						sf!("Authentication for provider `{provider}` was cancelled.").into()
					);
				},
				Ok(ChatAuthCommand::Answer(input)) if awaiting_prompt => {
					send_auth_response(&session, input, &provider).await?;
					awaiting_prompt = false;
				},
				Ok(ChatAuthCommand::Answer(_) | ChatAuthCommand::Start(_)) => {},
				Err(_) => {
					return Err(sf!("chat authentication view closed").into());
				},
			},
		}
	}
}

async fn send_auth_response(
	session: &omp_inference::answer::AuthSession,
	input: AuthInput,
	provider: &omp_catalog::ProviderId<str>,
) -> Result<(), Str> {
	session
		.responses
		.send_async(AuthResponse { session: session.id.clone(), input })
		.await
		.map_err(|_| {
			sf!(
				"Authentication provider `{provider}` stopped accepting input. Use `/login \
				 {provider}` to try again."
			)
		})
}

fn drain_auth_commands(commands: &Receiver<ChatAuthCommand>) {
	while commands.try_recv().is_ok() {}
}

#[cfg(test)]
mod auth_worker_tests {
	use omp_inference::{
		error::{ErrorPhase, RetryAction},
		receipt::ExecutionReceipt,
	};

	use super::*;

	#[test]
	fn credential_storage_failure_keeps_typed_ui_signal() {
		let error = omp_inference::Error::new(
			ErrorKind::CredentialStorageUnavailable,
			ErrorPhase::Authentication,
			RetryAction::Never,
			ExecutionReceipt::default(),
		);
		let provider = omp_catalog::ProviderId::from_ref("test-provider");
		assert!(matches!(
			chat_login_failure(provider, &error),
			ChatLoginFailure::CredentialStorageLocked
		));
	}

	#[test]
	fn completed_flow_drops_answers_before_the_next_login() {
		let (commands, receiver) = flume::unbounded();
		commands
			.send(ChatAuthCommand::Answer(AuthInput::DeviceConfirmed))
			.expect("stale prompt answer");
		commands
			.send(ChatAuthCommand::Cancel)
			.expect("stale cancellation");

		drain_auth_commands(&receiver);
		assert!(matches!(receiver.try_recv(), Err(flume::TryRecvError::Empty)));

		commands
			.send(ChatAuthCommand::Start(sf!("next-provider")))
			.expect("next login");
		assert!(matches!(
			receiver.try_recv(),
			Ok(ChatAuthCommand::Start(provider)) if provider == "next-provider"
		));
	}
}
fn discover_chat_agents(
	root: &Path,
	security_enabled: bool,
) -> Arc<BTreeMap<Str, omp_agent::AgentDefinition>> {
	agents::discover(root, security_enabled)
}

#[derive(Clone)]
struct ChatParentContext {
	state:         AgentState,
	session_id:    Str,
	sessions_dir:  PathBuf,
	root:          PathBuf,
	session_index: Arc<SessionIndex>,
	definitions:   Arc<BTreeMap<Str, omp_agent::AgentDefinition>>,
	tree:          Arc<AgentTree>,
	task_settings: LiveTaskSettings,
	regimes:       Option<Arc<RegimeHandle>>,
}
/// Core-backed facts consumed by the retained agent-hub presentation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentHubFacts {
	/// Stable agent identity.
	pub id:                 Str,
	/// Session-local display name.
	pub name:               Str,
	/// Parent identity, absent for the session root.
	pub parent:             Option<Str>,
	/// Tree depth, with the session root at zero.
	pub depth:              u16,
	/// Definition badge shown for delegated agents.
	pub definition:         Option<Str>,
	/// Requested model role or selector.
	pub model:              Option<Str>,
	/// Model which actually served the latest request.
	pub serving_model:      Option<Str>,
	/// Deterministic assignment summary recovered from the journal.
	pub assignment:         Option<Str>,
	/// Bounded terminal or activity preview.
	pub transcript_preview: Option<Str>,
	/// Core roster lifecycle.
	pub status:             AgentStatus,
	/// Retained supervisor lifecycle, when this process owns the child.
	pub lifecycle:          Option<SubagentLifecycle>,
	/// Request/tool/usage/context/model counters retained by core.
	pub progress:           Option<SubagentProgressSnapshot>,
	/// Structured terminal result retained across listener detach and revival.
	pub terminal:           Option<SubagentTerminalStatus>,
	/// Actions allowed by the current lifecycle.
	pub capabilities:       AgentHubCapabilities,
}

/// Lifecycle-derived controls for one retained agent-hub row.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct AgentHubCapabilities {
	/// An active turn may receive an immediate steer.
	pub steer:  bool,
	/// A settled or cold identity may run a follow-up turn.
	pub revive: bool,
	/// A live active generation may be cancelled.
	pub kill:   bool,
}

/// Session-owned parent authority shared with interactive presentation.
pub struct ChatParentHost<C: TurnClient + Clone + Send + 'static> {
	client: C,
	env: omp_env::EnvClient,
	broker: omp_agent::Broker,
	supervisor: Arc<SessionSupervisor<C>>,
	context: Mutex<ChatParentContext>,
	advisor_children: Mutex<AdvisorChildren>,
	revival: Mutex<BTreeMap<Str, flume::Sender<omp_agent::RevivalRequest>>>,
	inboxes: Arc<Mutex<BTreeMap<Str, hub_backend::SharedBrokerInbox>>>,
	controls: Arc<Mutex<BTreeMap<Str, omp_agent::AgentHostControl>>>,
	discovery_model_settings: Mutex<Option<discovery::PromptDiscoverySettings>>,
	auto_thinking: Mutex<AutoThinkingSettings>,
	difficulty_classifier: omp_inference::DifficultyClassifier,
}

struct EvalRunCancelGuard<C: TurnClient + Clone + Send + 'static> {
	supervisor: Arc<SessionSupervisor<C>>,
	id:         Str,
	armed:      bool,
}

impl<C: TurnClient + Clone + Send + 'static> Drop for EvalRunCancelGuard<C> {
	fn drop(&mut self) {
		if !self.armed {
			return;
		}
		let supervisor = Arc::clone(&self.supervisor);
		let id = self.id.clone();
		let _ = supervisor.cancel(id.as_str());
		drop(tokio::spawn(async move {
			let _ = time::timeout(Duration::from_secs(5), async {
				loop {
					let settled = supervisor.state(id.as_str()).is_none_or(|state| {
						matches!(
							state.lifecycle(),
							SubagentLifecycle::Settled | SubagentLifecycle::Parked
						)
					});
					if settled {
						return;
					}
					time::sleep(Duration::from_millis(10)).await;
				}
			})
			.await;
		}));
	}
}
struct ProductionChildReviver<C: TurnClient + Clone + Send + 'static> {
	client:                   C,
	base_env:                 omp_env::EnvClient,
	broker:                   omp_agent::Broker,
	supervisor:               Arc<SessionSupervisor<C>>,
	node:                     Arc<AgentNode>,
	snapshot:                 AgentSnapshot,
	journal_path:             PathBuf,
	project_root:             PathBuf,
	workspace_root:           PathBuf,
	isolated_state:           Option<PathBuf>,
	session_index:            Arc<SessionIndex>,
	parent_session:           SessionId,
	inboxes:                  Arc<Mutex<BTreeMap<Str, hub_backend::SharedBrokerInbox>>>,
	controls:                 Arc<Mutex<BTreeMap<Str, omp_agent::AgentHostControl>>>,
	discovery_model_settings: Option<discovery::PromptDiscoverySettings>,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveredChildGrants {
	enabled_tools: Vec<Str>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveredChildPolicy {
	defer_interrupts: bool,
	retry:            RecoveredRetryPolicy,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveredRetryPolicy {
	max_attempts:       u32,
	initial_backoff_ms: u64,
	max_backoff_ms:     u64,
}

impl<C: TurnClient + Clone + Send + 'static> ChildReviver<C> for ProductionChildReviver<C> {
	fn revive(&self) -> RevivalFuture<C> {
		let client = self.client.clone();
		let base_env = self.base_env.clone();
		let broker = self.broker.clone();
		let supervisor = Arc::clone(&self.supervisor);
		let node = Arc::clone(&self.node);
		let snapshot = self.snapshot.clone();
		let journal_path = self.journal_path.clone();
		let project_root = self.project_root.clone();
		let workspace_root = self.workspace_root.clone();
		let isolated_state = self.isolated_state.clone();
		let session_index = Arc::clone(&self.session_index);
		let parent_session = self.parent_session.clone();
		let inboxes = Arc::clone(&self.inboxes);
		let controls = Arc::clone(&self.controls);
		let discovery_model_settings = self.discovery_model_settings.clone();
		Box::pin(async move {
			let isolated_environment = if let Some(state) = isolated_state {
				Some(
					omp_envd::ProjectEnvironment::isolated(
						&workspace_root,
						&state,
						omp_envd::RegistryBridges::default(),
					)
					.await
					.map_err(|error| {
						tracing::warn!(agent = %node.id, %error, "isolated child revival failed");
						SupervisorError::RevivalFailed { id: node.id.clone() }
					})?,
				)
			} else {
				None
			};
			let child_env = isolated_environment.as_ref().map_or_else(
				|| {
					base_env
						.with_principal(parent_session.0.clone(), node.id.clone())
						.expect("validated revived child identity is a valid Environment principal")
				},
				|environment| {
					environment
						.client()
						.with_principal(parent_session.0.clone(), node.id.clone())
						.expect("validated revived child identity is a valid Environment principal")
				},
			);
			let journal = create_indexed_journal(
				&journal_path,
				&project_root,
				&node.id,
				session_index,
				SessionKind::Subagent,
				Some(&parent_session),
			)
			.map_err(|error| {
				tracing::warn!(agent = %node.id, %error, "child journal revival failed");
				SupervisorError::RevivalFailed { id: node.id.clone() }
			})?;
			let child_content = match discovery_model_settings.as_ref() {
				Some(settings) => {
					let home = env::var_os("HOME")
						.map(PathBuf::from)
						.unwrap_or_else(|| workspace_root.clone());
					discovery::active_prompt_snapshots(&workspace_root, &[], &home, settings).content
				},
				None => discovery::active_content_snapshots(&workspace_root),
			};
			let (ttsr, diagnostics) = rulebook::ttsr_registry(child_content.rules.as_ref());
			for error in diagnostics {
				tracing::warn!(%error, agent = %node.id, "revived subagent TTSR rule was rejected");
			}
			let mut child = Agent::new(
				client,
				child_env.clone(),
				AgentState::new(snapshot),
				journal,
				CHAT_CAPS_BASE,
			);
			controls
				.lock()
				.insert(node.id.clone(), child.host_control());
			child.set_ttsr_registry(ttsr);
			let control_binding = if let Some(environment) = &isolated_environment {
				let binding = environment
					.bind_agent_control(child.control())
					.map_err(|error| {
						tracing::warn!(agent = %node.id, %error, "revived child control bind failed");
						SupervisorError::RevivalFailed { id: node.id.clone() }
					})?;
				environment.bind_device_availability(child.mailbox());
				Some(binding)
			} else {
				None
			};
			let revision = broker
				.registry()
				.record(node.id.as_str())
				.map(|(_, revision)| revision)
				.ok_or_else(|| SupervisorError::RevivalFailed { id: node.id.clone() })?;
			let inbox = broker
				.attach_live(node.id.as_str(), revision, child.mailbox())
				.map_err(|error| {
					tracing::warn!(agent = %node.id, %error, "revived child broker bind failed");
					SupervisorError::RevivalFailed { id: node.id.clone() }
				})?;
			let inbox = hub_backend::share_inbox(inbox);
			inboxes.lock().insert(node.id.clone(), Arc::clone(&inbox));
			let hub = hub_backend::attach_for(
				node.id.clone(),
				Arc::new(hub_backend::ChatHubBackend::new(
					broker,
					inbox,
					Arc::clone(child.jobs()),
					child_env,
					node.id.clone(),
					Str::new(parent_session.0.as_str()),
					None,
					Some(supervisor),
				)),
			);
			let mut runtime = SupervisedRuntime::new(child);
			if let Some(binding) = control_binding {
				runtime.retain(binding);
			}
			runtime.retain(hub);
			if let Some(environment) = isolated_environment {
				runtime.retain(environment);
			}
			Ok(runtime)
		})
	}
}

impl<C: TurnClient + Clone + Send + 'static> ChatParentHost<C> {
	/// Composes the parent authority for one durable session.
	pub fn new(
		client: C,
		env: omp_env::EnvClient,
		state: AgentState,
		session_id: Str,
		sessions_dir: PathBuf,
		root: PathBuf,
		session_index: Arc<SessionIndex>,
		security_enabled: bool,
	) -> Self {
		let tree = Arc::new(AgentTree::new(
			8,
			DEFAULT_EVAL_CONCURRENCY_LIMIT,
			omp_agent::DEFAULT_MAX_ADMISSION_QUEUE,
		));
		Self::new_with_tree(
			client,
			env,
			state,
			session_id,
			sessions_dir,
			root,
			session_index,
			security_enabled,
			tree,
		)
	}

	/// Composes the parent authority over a caller-owned primary agent tree.
	///
	/// Headless compositions use this constructor so the primary loop and its
	/// persistent advisor children share one authoritative roster.
	pub fn new_with_tree(
		client: C,
		env: omp_env::EnvClient,
		state: AgentState,
		session_id: Str,
		sessions_dir: PathBuf,
		root: PathBuf,
		session_index: Arc<SessionIndex>,
		security_enabled: bool,
		tree: Arc<AgentTree>,
	) -> Self {
		let definitions = discover_chat_agents(&root, security_enabled);
		let env = env
			.with_principal(session_id.clone(), session_id.clone())
			.expect("validated durable session identity is a valid Environment principal");
		if let Err(error) =
			artifacts::reserve_historical_stems(tree.as_ref(), &sessions_dir.join("eval-agents"))
		{
			tracing::warn!(error = %error, "could not reserve historical subagent artifact names");
		}
		let supervisor = Arc::new(SessionSupervisor::new(Arc::clone(&tree)));
		Self {
			client,
			env,
			broker: omp_agent::Broker::new(Str::from(root.to_string_lossy().as_ref())),
			supervisor,
			context: Mutex::new(ChatParentContext {
				state,
				session_id,
				sessions_dir,
				root,
				session_index,
				definitions,
				task_settings: LiveTaskSettings::new(
					Arc::new(TaskSettings::default()),
					Arc::clone(&tree),
				),
				regimes: None,
				tree,
			}),
			advisor_children: Mutex::new(AdvisorChildren::default()),
			revival: Mutex::new(BTreeMap::new()),
			inboxes: Arc::new(Mutex::new(BTreeMap::new())),
			controls: Arc::new(Mutex::new(BTreeMap::new())),
			discovery_model_settings: Mutex::new(None),
			auto_thinking: Mutex::new(AutoThinkingSettings::default()),
			difficulty_classifier: omp_inference::DifficultyClassifier::new(),
		}
	}

	/// Installs the complete settings and invocation policy frozen for child
	/// prompt/content discovery.
	pub fn set_prompt_discovery_settings(&self, settings: discovery::PromptDiscoverySettings) {
		*self.discovery_model_settings.lock() = Some(settings);
	}

	/// Installs the immutable automatic-thinking policy used to classify each
	/// ordinary user turn before inference dispatch.
	pub fn set_auto_thinking_settings(&self, settings: AutoThinkingSettings) {
		*self.auto_thinking.lock() = settings;
	}

	/// Binds the main agent inbox used by the hub presentation.
	pub fn bind_inbox(&self, owner: Str, inbox: hub_backend::SharedBrokerInbox) {
		self.inboxes.lock().insert(owner, inbox);
	}

	fn inbox(&self, owner: &str) -> Option<hub_backend::SharedBrokerInbox> {
		self.inboxes.lock().get(owner).cloned()
	}

	/// Binds the live main or child loop lifecycle owner.
	pub fn bind_host_control(&self, owner: Str, control: omp_agent::AgentHostControl) {
		self.controls.lock().insert(owner, control);
	}

	fn host_control(&self, owner: &str) -> Option<omp_agent::AgentHostControl> {
		self.controls.lock().get(owner).cloned()
	}

	/// Applies a reloaded task projection to admission and later child
	/// snapshots.
	pub fn apply_task_settings(&self, settings: Arc<TaskSettings>) {
		self.supervisor.apply_settings(Arc::clone(&settings));
		self.context.lock().task_settings.apply(settings);
	}

	/// Binds regime authority used by child composition.
	pub fn bind_regimes(&self, regimes: Arc<RegimeHandle>) {
		self.context.lock().regimes = Some(regimes);
	}

	fn approved_plan_reference(&self) -> Option<OverallPlanReference> {
		let context = self.context.lock();
		let state = context.regimes.as_ref()?.plan()?;
		if state.enabled {
			return None;
		}
		let store = PlanArtifactStore::new(
			context
				.sessions_dir
				.join(context.session_id.as_str())
				.join("local"),
		);
		let artifact = store.resolve(None, state.artifact.as_str()).ok()?;
		OverallPlanReference::resolve(&state, &artifact).ok()
	}

	/// Binds the main agent job board into child supervision.
	pub fn bind_parent_jobs(&self, jobs: Arc<omp_agent::JobBoard>) {
		self.supervisor.bind_parent_jobs(jobs);
	}

	/// Replaces the live parent state after a session switch.
	pub fn update(&self, state: AgentState, session_id: Str) {
		let mut context = self.context.lock();
		context.state = state;
		context.session_id = session_id;
	}

	/// Shares the append-only subagent roster with the interactive UI bridge.
	pub fn tree(&self) -> Arc<AgentTree> {
		Arc::clone(&self.context.lock().tree)
	}

	/// Returns the session message broker.
	pub fn broker(&self) -> omp_agent::Broker {
		self.broker.clone()
	}

	/// Returns the session child supervisor for hub attachment.
	pub fn supervisor(&self) -> Arc<SessionSupervisor<C>> {
		Arc::clone(&self.supervisor)
	}

	/// Returns the live delivery adapter for the Environment-owned durable
	/// scheduler. The adapter owns no clocks or persistence.
	pub fn schedule_delivery_backend(
		self: &Arc<Self>,
	) -> Arc<dyn omp_envd::schedules::ScheduleDeliveryBackend>
	where
		C: Sync,
	{
		Arc::new(ChatScheduleDelivery { parent: Arc::clone(self) })
	}

	/// Returns the current durable session identity.
	pub fn session_id(&self) -> Str {
		self.context.lock().session_id.clone()
	}

	/// Composes one persistent advisor child without starting an inference turn.
	pub async fn spawn_advisor(&self, spec: AdvisorChildSpec) -> Result<Str, AdvisorChildError> {
		let context = self.context.lock().clone();
		advisor_child::spawn(
			AdvisorSpawnContext {
				client:        self.client.clone(),
				env:           self.env.clone(),
				broker:        self.broker.clone(),
				supervisor:    Arc::clone(&self.supervisor),
				state:         context.state,
				session_id:    context.session_id,
				sessions_dir:  context.sessions_dir,
				root:          context.root,
				session_index: context.session_index,
				tree:          context.tree,
			},
			&self.advisor_children,
			spec,
		)
		.await
	}

	/// Prompts one persistent advisor once per delta chunk in one serialized
	/// run.
	pub async fn run_advisor_batch(
		&self,
		advisor_id: &str,
		chunks: Vec<Str>,
		turn_id: TurnId,
	) -> Result<AdvisorBatchOutcome, AdvisorChildError> {
		advisor_child::run_batch(
			&self.broker,
			self.supervisor.as_ref(),
			&self.advisor_children,
			advisor_id,
			chunks,
			turn_id,
		)
		.await
	}

	/// Tears down all persistent advisor children before a primary session
	/// switch.
	pub async fn clear_advisors(&self) -> Result<(), AdvisorChildError> {
		advisor_child::clear(&self.broker, self.supervisor.as_ref(), &self.advisor_children).await
	}

	pub(crate) fn task_settings(&self) -> Arc<TaskSettings> {
		self.context.lock().task_settings.snapshot()
	}

	pub(crate) fn job_board(&self) -> Option<Arc<omp_agent::JobBoard>> {
		self.supervisor.parent_jobs()
	}

	pub(crate) fn child_registry_status(&self, id: &str) -> Option<RegistryStatus> {
		self
			.broker
			.registry()
			.record(id)
			.map(|(record, _)| record.status)
	}

	/// Projects typed retained facts without granting the UI execution
	/// authority.
	pub fn agent_hub_facts(&self, session: &str) -> Vec<AgentHubFacts> {
		let tree = Arc::clone(&self.context.lock().tree);
		tree
			.roster()
			.filter(|node| node.session == session)
			.map(|node| {
				let record = self
					.broker
					.registry()
					.record(node.id.as_str())
					.map(|(record, _)| record);
				let state = self.supervisor.state(node.id.as_str());
				let lifecycle = state.as_ref().map(|state| state.lifecycle());
				let terminal = state
					.as_ref()
					.and_then(|state| state.terminal())
					.or_else(|| {
						record
							.as_ref()
							.and_then(|record| record.history.terminal.clone())
					});
				let is_child = node.kind == AgentKind::Subagent;
				let capabilities = AgentHubCapabilities {
					steer:  is_child
						&& matches!(
							lifecycle,
							Some(
								SubagentLifecycle::Starting
									| SubagentLifecycle::Running
									| SubagentLifecycle::Waiting
							)
						),
					revive: is_child
						&& matches!(
							lifecycle,
							Some(SubagentLifecycle::Parked | SubagentLifecycle::Settled)
						),
					kill:   is_child
						&& matches!(
							lifecycle,
							Some(
								SubagentLifecycle::Starting
									| SubagentLifecycle::Running
									| SubagentLifecycle::Waiting
							)
						),
				};
				AgentHubFacts {
					id: node.id.clone(),
					name: node.name.clone(),
					parent: node.parent.clone(),
					depth: node.depth,
					definition: record
						.as_ref()
						.and_then(|record| record.definition.clone())
						.or_else(|| node.definition.clone()),
					model: record.as_ref().and_then(|record| record.model.clone()),
					serving_model: state
						.as_ref()
						.and_then(|state| state.progress().serving_model)
						.or_else(|| {
							record
								.as_ref()
								.and_then(|record| record.serving_model.clone())
						}),
					assignment: record.as_ref().and_then(|record| record.task.clone()),
					transcript_preview: terminal
						.clone()
						.and_then(|terminal| {
							terminal
								.disposition
								.preview
								.or_else(|| (!terminal.summary.is_empty()).then_some(terminal.summary))
						})
						.or_else(|| {
							let activity = node.activity();
							(!activity.is_empty()).then_some(activity)
						}),
					status: node.status(),
					lifecycle,
					progress: state.as_ref().map(|state| state.progress()),
					terminal,
					capabilities,
				}
			})
			.collect()
	}

	/// Cancels one live child agent by identity.
	pub fn cancel_child(&self, id: &str) {
		let _ = self.supervisor.cancel(id);
	}

	fn ensure_revival_transport(&self, id: &Str) {
		if self.revival.lock().contains_key(id) {
			return;
		}
		let (sender, receiver) = flume::unbounded::<omp_agent::RevivalRequest>();
		self.revival.lock().insert(id.clone(), sender);
		let child_id = id.clone();
		let supervisor = Arc::clone(&self.supervisor);
		let broker = self.broker.clone();
		drop(tokio::spawn(async move {
			while let Ok(request) = receiver.recv_async().await {
				if request.recipient != child_id {
					continue;
				}
				let result = supervisor
					.run(
						child_id.as_str(),
						vec![omp_agent::peer_item(&request.message)],
						TurnId::new(format!("agent-revival-{}", omp_core::Ulid::generate())),
					)
					.await;
				let _ = broker.set_idle(child_id.as_str(), true);
				if let Some(terminal) = supervisor
					.state(child_id.as_str())
					.and_then(|state| state.terminal())
				{
					let _ = broker.registry().set_terminal(child_id.as_str(), terminal);
				}
				if let Err(error) = result {
					tracing::warn!(agent = %child_id, %error, "cold-revived child turn failed");
				}
			}
		}));
	}

	fn bind_parked_transport(&self, record: omp_agent::AgentRecord) {
		let sender = self.revival.lock().get(&record.id).cloned();
		let Some(sender) = sender else {
			return;
		};
		self.broker.unregister(record.id.as_str());
		if let Err(error) = self.broker.register_parked(record.clone(), sender) {
			tracing::warn!(agent = %record.id, %error, "parked child revival bind failed");
		}
	}

	/// Recovers parked children discoverable from durable registry state.
	pub async fn recover_parked_children(&self) {
		let context = self.context.lock().clone();
		let directory = context.sessions_dir.join("eval-agents");
		if !directory.is_dir() {
			return;
		}
		let root_file = context
			.sessions_dir
			.join(format!("{}.jsonl", context.session_id));
		self
			.broker
			.registry()
			.restore_transcripts_once(&root_file, &directory);
		let blob_root = context
			.sessions_dir
			.parent()
			.unwrap_or(context.sessions_dir.as_path());
		let blob_store = match BlobStore::open(blob_root) {
			Ok(store) => store,
			Err(error) => {
				tracing::warn!(%error, "durable child blob store could not be opened");
				return;
			},
		};
		for record in self.broker.registry().roster(false) {
			if record.kind != AgentKind::Subagent
				|| record.parent.as_deref() != Some(context.session_id.as_str())
				|| self.supervisor.state(record.id.as_str()).is_some()
			{
				continue;
			}
			if let Err(error) = self
				.recover_parked_child(&context, &blob_store, record.clone())
				.await
			{
				tracing::warn!(agent = %record.id, %error, "durable child was not recovered");
			}
		}
	}

	async fn recover_parked_child(
		&self,
		context: &ChatParentContext,
		blob_store: &BlobStore,
		record: omp_agent::AgentRecord,
	) -> Result<(), SupervisorError> {
		let journal_path = record
			.transcript
			.clone()
			.ok_or_else(|| SupervisorError::RevivalFailed { id: record.id.clone() })?;
		let journal = Journal::open(&journal_path).map_err(|error| {
			tracing::warn!(agent = %record.id, %error, "recovered child journal open failed");
			SupervisorError::RevivalFailed { id: record.id.clone() }
		})?;
		let log = journal.load().map_err(|error| {
			tracing::warn!(agent = %record.id, %error, "recovered child journal read failed");
			SupervisorError::RevivalFailed { id: record.id.clone() }
		})?;
		let revival = (0..log.log().len() as u64)
			.filter_map(|index| log.log().get(index))
			.find_map(|entry| match entry {
				transcript::Entry::Ok(event) => match &event.kind {
					Kind::Init { revival: Some(revival), .. } => Some(revival.clone()),
					_ => None,
				},
				_ => None,
			})
			.ok_or_else(|| SupervisorError::RevivalFailed { id: record.id.clone() })?;
		let definition = context
			.definitions
			.iter()
			.find(|(name, _)| {
				name
					.as_str()
					.eq_ignore_ascii_case(revival.definition.as_str())
			})
			.map(|(_, definition)| definition.clone())
			.ok_or_else(|| SupervisorError::RevivalFailed { id: record.id.clone() })?;
		let workspace_root = Url::parse(revival.workspace.root_uri.as_str())
			.ok()
			.and_then(|url| url.to_file_path().ok())
			.ok_or_else(|| SupervisorError::RevivalFailed { id: record.id.clone() })?;
		let mut snapshot = context.state.snapshot().as_ref().clone();
		snapshot
			.props
			.set(omp_agent::prompt_keys::CWD, workspace_root.to_string_lossy().into_owned());
		snapshot.turn.params.model = revival.model_role.to_string();
		let grants = blob_store
			.get(&revival.grant_snapshot_ref)
			.ok()
			.and_then(|bytes| serde_json::from_slice::<RecoveredChildGrants>(&bytes).ok())
			.ok_or_else(|| SupervisorError::RevivalFailed { id: record.id.clone() })?;
		snapshot.enabled_tools = grants.enabled_tools.into();
		let tools = blob_store
			.get(&revival.tool_snapshot_ref)
			.ok()
			.and_then(|bytes| inference_pb::ChatParams::decode(bytes).ok())
			.ok_or_else(|| SupervisorError::RevivalFailed { id: record.id.clone() })?;
		snapshot.turn.params.tools = tools.tools;
		let policy = blob_store
			.get(&revival.policy_snapshot_ref)
			.ok()
			.and_then(|bytes| serde_json::from_slice::<RecoveredChildPolicy>(&bytes).ok())
			.ok_or_else(|| SupervisorError::RevivalFailed { id: record.id.clone() })?;
		snapshot.defer_interrupts = policy.defer_interrupts;
		let max_attempts = num::NonZeroU32::new(policy.retry.max_attempts)
			.ok_or_else(|| SupervisorError::RevivalFailed { id: record.id.clone() })?;
		snapshot.retry = omp_agent::RetryPolicy::new(
			max_attempts,
			Duration::from_millis(policy.retry.initial_backoff_ms),
			Duration::from_millis(policy.retry.max_backoff_ms),
		)
		.map_err(|_| SupervisorError::RevivalFailed { id: record.id.clone() })?;
		if let Some(schema_ref) = revival.schema_ref.as_ref() {
			let schema = blob_store
				.get(schema_ref)
				.map_err(|_| SupervisorError::RevivalFailed { id: record.id.clone() })?;
			snapshot.turn.params.response_format = Some(inference_pb::ResponseFormat {
				kind:           Some(response_format::Kind::JsonSchema(response_format::JsonSchema {
					name:        "subagent_output".to_owned(),
					schema_json: schema.to_vec().into(),
					strict:      Some(true),
				})),
				on_unsupported: inference_pb::Fallback::Error as i32,
			});
		}
		let parent = revival.parent_id.clone();
		let node = context
			.tree
			.register_child(
				record.id.clone(),
				Some(revival.display_name.as_str()),
				&definition,
				parent,
				record.session.clone(),
				Budget::default(),
			)
			.map_err(SupervisorError::Admission)?;
		node.set_status(AgentStatus::Settled);
		let isolated_state = revival.workspace.isolation_id.as_ref().map(|_| {
			context
				.sessions_dir
				.join("eval-agents")
				.join(format!("{}-env", record.id))
		});
		let reviver: Arc<dyn ChildReviver<C>> = Arc::new(ProductionChildReviver {
			client: self.client.clone(),
			base_env: self.env.clone(),
			broker: self.broker.clone(),
			supervisor: Arc::clone(&self.supervisor),
			node: Arc::clone(&node),
			snapshot,
			journal_path,
			project_root: context.root.clone(),
			workspace_root,
			isolated_state,
			session_index: Arc::clone(&context.session_index),
			parent_session: SessionId(record.session.clone()),
			inboxes: Arc::clone(&self.inboxes),
			controls: Arc::clone(&self.controls),
			discovery_model_settings: self.discovery_model_settings.lock().clone(),
		});
		self.supervisor.register_parked(node, reviver)?;
		self.ensure_revival_transport(&record.id);
		self.bind_parked_transport(record);
		Ok(())
	}

	pub(crate) async fn release_child(&self, id: &str) {
		let _ = self.supervisor.cancel(id);
		let settled = time::timeout(Duration::from_secs(5), async {
			loop {
				let Some(state) = self.supervisor.state(id) else {
					return false;
				};
				if state.lifecycle() == SubagentLifecycle::Settled {
					return true;
				}
				time::sleep(Duration::from_millis(25)).await;
			}
		})
		.await
		.unwrap_or(false);
		if !settled || self.supervisor.park_stopped(id).await.is_err() {
			return;
		}
		if let Some((record, _)) = self.broker.registry().record(id) {
			self.bind_parked_transport(record);
		}
	}

	pub(crate) async fn park_expired_children(&self, ttl: Duration) {
		for lease in self
			.broker
			.registry()
			.park_expired(omp_agent::broker_now_ms(), ttl)
		{
			let id = lease.record.id.clone();
			if self.supervisor.park(id.as_str()).await.is_ok() {
				self.bind_parked_transport(lease.record);
			} else {
				let _ = self.broker.registry().set_status(
					id.as_str(),
					Some(lease.revision),
					RegistryStatus::Idle,
				);
			}
		}
	}

	/// Starts the session-owned idle loop parking scheduler.
	///
	/// The broker registry is the idle-time authority. Each lease carries the
	/// exact generation revision that `bind_parked_transport` preserves while
	/// the supervisor releases the live loop resources.
	pub fn start_idle_parking(self: &Arc<Self>) {
		let parent = Arc::downgrade(self);
		drop(tokio::spawn(async move {
			let mut tick = time::interval(Duration::from_secs(1));
			tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
			loop {
				tick.tick().await;
				let Some(parent) = parent.upgrade() else {
					return;
				};
				let ttl_ms = parent.task_settings().agent_idle_ttl_ms;
				if ttl_ms != 0 {
					parent
						.park_expired_children(Duration::from_millis(ttl_ms))
						.await;
				}
			}
		}));
	}

	async fn run_eval_agent(
		&self,
		id: &str,
		items: Vec<Item>,
		turn_id: TurnId,
	) -> Result<omp_agent::AgentRunSummary, BridgeHostError> {
		let mut budget = self.context.lock().state.subscribe();
		let _ = self.broker.set_idle(id, false);
		let before = self
			.supervisor
			.state(id)
			.map(|state| (state.generation(), state.progress().output_tokens));
		let run = self.supervisor.run(id, items, turn_id);
		let mut cancellation = EvalRunCancelGuard {
			supervisor: Arc::clone(&self.supervisor),
			id:         Str::new(id),
			armed:      true,
		};
		tokio::pin!(run);
		loop {
			tokio::select! {
				result = &mut run => {
					cancellation.armed = false;
										let _ = self.broker.set_idle(id, true);
					if let Some(terminal) = self
						.supervisor
						.state(id)
						.and_then(|state| state.terminal())
					{
						let _ = self.broker.registry().set_terminal(id, terminal);
					}
					let output_tokens = self.supervisor.state(id).map_or(0, |state| {
						let after = state.progress().output_tokens;
						before.map_or(after, |(generation, output)| {
							if state.generation() == generation {
								after.saturating_sub(output)
							} else {
								after
							}
						})
					});
					self.context.lock().state.update(|snapshot| {
						if let Some(remaining) = snapshot
							.turn
							.params
							.task_budget
							.as_mut()
							.and_then(|budget| budget.remaining_tokens.as_mut())
						{
							*remaining = remaining.saturating_sub(output_tokens);
						}
					});
					return result.map_err(|error| {
						omp_envd::eval::BridgeHostError::message(error.to_string())
					});
				},
				changed = budget.changed() => {
					if changed.is_err() {
						continue;
					}
					let exhausted = budget
						.borrow_and_update()
						.turn
						.params
						.task_budget
						.is_some_and(|budget| budget.remaining_tokens == Some(0));
					if exhausted {
						let _ = self.supervisor.cancel(id);
					}
				},
			}
		}
	}

	async fn validate_agent_summary(
		&self,
		id: &str,
		schema: Option<Value>,
		strict: bool,
		mut summary: omp_agent::AgentRunSummary,
	) -> Result<(String, Option<Value>, Option<Value>), BridgeHostError> {
		let Some(schema) = schema else {
			let text = summary
				.outcome
				.as_ref()
				.map_or_else(|| "(interrupted)".to_owned(), bridge_outcome_text);
			return Ok((text, None, None));
		};
		let mut validator = YieldPayloadValidator::new(Some(schema), strict);
		let mut retries = 0_u8;
		loop {
			let text = summary
				.outcome
				.as_ref()
				.map_or_else(|| "(interrupted)".to_owned(), bridge_outcome_text);
			match summary.yield_payload(&mut validator) {
				Ok(Some(payload)) => {
					if let Some(error) = payload.error {
						return Ok((text, None, Some(json!({ "status": "failed", "error": error }))));
					}
					if let Some(data) = payload.data {
						let schema_status = payload.schema_overridden.then(|| {
							json!({
								"status": "invalid",
								"mode": "permissive",
								"salvaged": true,
								"warning": crate::subagent::yield_driver::WARNING_SCHEMA_OVERRIDDEN,
							})
						});
						return Ok((text, Some(data), schema_status));
					}
				},
				Ok(None) => {},
				Err(error) if retries >= MAX_YIELD_SCHEMA_RETRIES => {
					let warning = matches!(&error, omp_agent::YieldPayloadError::MissingData)
						.then_some(yield_driver::WARNING_NULL_YIELD);
					return Ok((
						text,
						None,
						Some(json!({
							"status": "invalid",
							"mode": if strict { "strict" } else { "permissive" },
							"error": error.to_string(),
							"warning": warning,
						})),
					));
				},
				Err(_) => {},
			}
			if retries >= MAX_YIELD_SCHEMA_RETRIES {
				return Ok((
					text,
					None,
					Some(json!({
						"status": "unavailable",
						"mode": if strict { "strict" } else { "permissive" },
						"error": "child did not submit a terminal structured yield",
						"warning": crate::subagent::yield_driver::WARNING_MISSING_YIELD,
					})),
				));
			}
			retries = retries.saturating_add(1);
			summary = self
				.run_eval_agent(
					id,
					vec![bridge_message(
						Role::User,
						"Your terminal yield did not satisfy the requested JSON Schema. Submit the \
						 complete corrected object as result.data now.",
					)],
					TurnId::new(format!("eval-agent-schema-retry-{}", omp_core::Ulid::generate())),
				)
				.await?;
		}
	}
}

fn bridge_message(role: Role, text: &str) -> Item {
	Item {
		seq:           0,
		created_at_ms: now_ms(),
		kind:          Some(item::Kind::Message(Message {
			role:  i32::from(role),
			parts: vec![Part { kind: Some(omp_proto::thread::v1::part::Kind::Text(text.to_owned())) }],
		})),
		props:         None,
	}
}
fn deterministic_isolation_recovery(
	worktree: &str,
	artifact: Option<&str>,
	branch: Option<&str>,
	conflicts: &[env_pb::WorkspaceConflict],
) -> Str {
	use std::fmt::Write as _;

	let mut summary =
		String::from("Isolated workspace disposition conflicted; changes remain recoverable");
	if let Some(artifact) = artifact {
		let _ = write!(summary, " from patch {artifact}");
	}
	if let Some(branch) = branch {
		let _ = write!(summary, " from branch {branch}");
	}
	if artifact.is_none() && branch.is_none() {
		let _ = write!(summary, " from workspace {worktree}");
	}
	summary.push_str(". Conflicts:");
	for conflict in conflicts.iter().take(8) {
		let reason = env_pb::ConflictReason::try_from(conflict.reason)
			.unwrap_or(env_pb::ConflictReason::Unspecified);
		let _ = write!(summary, " {} ({})", conflict.path, reason.as_str_name());
	}
	if conflicts.len() > 8 {
		let _ = write!(summary, " and {} more", conflicts.len() - 8);
	}
	summary.push('.');
	Str::from(summary)
}

fn deterministic_task_summary(prompt: &str) -> Str {
	const MAX_CHARS: usize = 160;

	let mut summary = String::with_capacity(prompt.len().min(MAX_CHARS));
	let mut chars = 0_usize;
	for word in prompt.split_whitespace() {
		let word_chars = word.chars().count();
		let separator = if summary.is_empty() { 0 } else { 1 };
		if chars.saturating_add(separator).saturating_add(word_chars) > MAX_CHARS {
			break;
		}
		if separator != 0 {
			summary.push(' ');
		}
		summary.push_str(word);
		chars = chars.saturating_add(separator).saturating_add(word_chars);
	}
	Str::from(summary)
}

/// Host-owned `omp.agents.*` CONTROL authority for one durable chat session.
///
/// Every declared agents operation delegates to the session's live tree,
/// mailbox, journal owner, scheduler journal, or Environment workspace owner.
pub struct AgentsControlAuthority<C: TurnClient + Clone + Send + 'static> {
	expected_session_id: Str,
	parent:              Arc<ChatParentHost<C>>,
}
struct ChatScheduleDelivery<C: TurnClient + Clone + Send + 'static> {
	parent: Arc<ChatParentHost<C>>,
}

impl<C: TurnClient + Clone + Send + 'static> AgentsControlAuthority<C> {
	/// Pins a CONTROL authority to the parent's current durable session
	/// generation.
	pub fn new(parent: Arc<ChatParentHost<C>>) -> Self {
		let expected_session_id = parent.session_id();
		Self { expected_session_id, parent }
	}

	/// Returns the app/driver agents-domain factory required by envd CONTROL
	/// composition.
	pub fn factory(parent: Arc<ChatParentHost<C>>) -> Arc<dyn ControlAuthorityFactory> {
		Arc::new(FixedControlAuthorityFactory::new(Arc::new(Self::new(parent))))
	}

	fn ensure_current(&self) -> Result<(), ControlProtocolError> {
		if self.parent.session_id() == self.expected_session_id {
			Ok(())
		} else {
			Err(
				ControlProtocolError::new(
					"StaleGeneration",
					"the agents authority belongs to a replaced chat session",
				)
				.with_details(json!({"session_id": self.expected_session_id})),
			)
		}
	}

	fn caller(context: &control::ControlRequestContext) -> Result<Str, ControlProtocolError> {
		context
			.invocation
			.as_ref()
			.map(|invocation| invocation.session.clone())
			.ok_or_else(|| {
				ControlProtocolError::new(
					"PhaseConflict",
					"agent operation requires a session invocation",
				)
			})
	}

	fn split_run_id(run_id: &str) -> Result<(&str, u64), ControlProtocolError> {
		let (id, generation) = run_id.rsplit_once('#').ok_or_else(|| {
			ControlProtocolError::new("AgentGone", "invalid or stale subagent run handle")
				.with_details(json!({"ref": run_id, "status": "aborted", "transcript_url": ""}))
		})?;
		let generation = generation.parse::<u64>().map_err(|_| {
			ControlProtocolError::new("AgentGone", "invalid or stale subagent run handle")
				.with_details(json!({"ref": run_id, "status": "aborted", "transcript_url": ""}))
		})?;
		Ok((id, generation))
	}

	fn owned_state(
		&self,
		context: &control::ControlRequestContext,
		run_id: &str,
	) -> Result<(Str, Arc<SubagentRunState>), ControlProtocolError> {
		let caller = Self::caller(context)?;
		let (id, generation) = Self::split_run_id(run_id)?;
		let node = self.parent.tree().node(id).ok_or_else(|| {
			ControlProtocolError::new("AgentGone", "subagent run was not found").with_details(json!({
				"ref": run_id,
				"status": "aborted",
				"transcript_url": format!("history://{id}"),
			}))
		})?;
		if node.parent.as_deref() != Some(caller.as_str()) {
			return Err(
				ControlProtocolError::new("AgentGone", "subagent run is not owned by this caller")
					.with_details(json!({
						"ref": run_id,
						"status": "aborted",
						"transcript_url": format!("history://{id}"),
					})),
			);
		}
		let state = self
			.parent
			.supervisor
			.state_at_generation(id, generation)
			.map_err(|error| match error {
				SupervisorError::StaleGeneration { expected, current, .. } => {
					ControlProtocolError::new(
						"StaleGeneration",
						format!(
							"subagent generation {expected} is stale; current generation is {current}"
						),
					)
					.with_details(json!({
						"ref": run_id,
						"expected_generation": expected,
						"current_generation": current,
					}))
				},
				error => {
					ControlProtocolError::new("AgentGone", error.to_string()).with_details(json!({
						"ref": run_id,
						"status": "aborted",
						"transcript_url": format!("history://{id}"),
					}))
				},
			})?;
		Ok((Str::from(id), state))
	}

	fn run_status(state: &SubagentRunState) -> &'static str {
		match state.lifecycle() {
			SubagentLifecycle::Created | SubagentLifecycle::Starting => "pending",
			SubagentLifecycle::Running => "running",
			SubagentLifecycle::Waiting | SubagentLifecycle::Parked => "settled",
			SubagentLifecycle::Settled => match state.terminal().map(|terminal| terminal.kind) {
				Some(SubagentTerminalKind::Succeeded) => "completed",
				Some(SubagentTerminalKind::Cancelled) => "cancelled",
				Some(SubagentTerminalKind::RuntimeLimit) => "exhausted",
				Some(SubagentTerminalKind::SchemaInvalid | SubagentTerminalKind::Failed) | None => {
					"failed"
				},
			},
		}
	}

	fn result_json(&self, id: &str, state: &SubagentRunState) -> Option<Value> {
		let terminal = state.terminal()?;
		let metadata = self.parent.supervisor.metadata(id)?;
		let application = match self.parent.supervisor.result(id) {
			Some(result) => result,
			None if terminal.kind == SubagentTerminalKind::Succeeded => return None,
			None => Value::Null,
		};
		let name = metadata.get("name").and_then(Value::as_str).unwrap_or(id);
		let progress = state.progress();
		let direct = self.parent.tree().statistics(id, false).unwrap_or_default();
		let subtree = self
			.parent
			.supervisor
			.subtree_progress(id)
			.unwrap_or_else(|| progress.clone());
		let turns = state
			.events()
			.filter(|event| {
				matches!(
					event.event,
					omp_agent::SubagentRunEventKind::Lifecycle(SubagentLifecycle::Running)
				)
			})
			.count();
		let data = application.get("data").cloned().unwrap_or(Value::Null);
		let serving_model = application
			.get("servingModel")
			.or_else(|| application.get("serving_model"))
			.and_then(Value::as_str)
			.map(Str::new)
			.or(progress.serving_model);
		let requested_model = metadata
			.get("spec")
			.and_then(|spec| spec.get("model"))
			.and_then(Value::as_str);
		let model_fallback = application
			.get("modelFallback")
			.or_else(|| application.get("model_fallback"))
			.and_then(Value::as_bool)
			.unwrap_or_else(|| {
				requested_model.is_some_and(|requested| {
					serving_model
						.as_deref()
						.is_some_and(|serving| serving != requested)
				})
			});
		let mut warnings = application
			.get("warnings")
			.and_then(Value::as_array)
			.cloned()
			.unwrap_or_default();
		if terminal.disposition.truncated {
			warnings.push(Value::String(
				"caller-visible output was truncated; use output_url for the full artifact".to_owned(),
			));
		}
		if let Some(schema) = application.get("schema").filter(|schema| !schema.is_null()) {
			warnings.push(Value::String(format!("structured output validation reported {schema}")));
		}
		let worktree = application
			.get("details")
			.and_then(Value::as_object)
			.filter(|details| details.get("isolated").and_then(Value::as_bool) == Some(true))
			.map(|details| {
				let outcome = details.get("disposition").and_then(Value::as_object);
				let merge = metadata
					.get("spec")
					.and_then(|spec| spec.get("merge"))
					.and_then(Value::as_str)
					.unwrap_or("none");
				json!({
					"path": details
						.get("root")
						.or_else(|| details.get("worktree"))
						.and_then(Value::as_str)
						.unwrap_or_default(),
					"merge": merge,
					"applied": merge == "patch"
						&& outcome
							.and_then(|outcome| outcome.get("status"))
							.and_then(Value::as_str) == Some("ready"),
					"branch": outcome
						.and_then(|outcome| outcome.get("branch"))
						.cloned()
						.unwrap_or(Value::Null),
					"patch_url": outcome
						.and_then(|outcome| outcome.get("artifact"))
						.cloned()
						.unwrap_or(Value::Null),
					"conflicts": outcome
						.and_then(|outcome| outcome.get("conflicts"))
						.and_then(Value::as_array)
						.map(|conflicts| Value::Array(
							conflicts
								.iter()
								.filter_map(|conflict| conflict.get("path").cloned())
								.collect()
						))
						.unwrap_or_else(|| Value::Array(Vec::new())),
				})
			})
			.unwrap_or(Value::Null);
		let cancellation_reason = self.parent.supervisor.cancellation_reason(id);
		let fault_reason =
			cancellation_reason.unwrap_or_else(|| Str::from(terminal.kind.to_string()));
		Some(json!({
			"run_id": format!("{id}#{}", state.generation().0),
			"session_id": self.parent.session_id(),
			"name": name,
			"status": Self::run_status(state),
			"text": application
				.get("text")
				.and_then(Value::as_str)
				.map(Str::new)
				.or(terminal.disposition.preview)
				.unwrap_or(terminal.summary),
			"data": data,
			"fault": if terminal.kind == SubagentTerminalKind::Succeeded {
				Value::Null
			} else {
				json!({
					"reason": fault_reason,
				})
			},
			"usage": {
				"input_tokens": progress.input_tokens,
				"cached_input_tokens": direct.usage.cache_read_tokens,
				"output_tokens": progress.output_tokens,
				"reasoning_tokens": direct.usage.reasoning_tokens.unwrap_or_default(),
				"cache_write_tokens": direct.usage.cache_write_tokens,
				"requests": progress.requests,
				"cost_usd": progress.cost_micros as f64 / 1_000_000.0,
				"wall_ms": 0,
			},
			"subtree_usage": {
				"input_tokens": subtree.input_tokens,
				"cached_input_tokens": 0,
				"output_tokens": subtree.output_tokens,
				"reasoning_tokens": 0,
				"cache_write_tokens": 0,
				"requests": subtree.requests,
				"cost_usd": subtree.cost_micros as f64 / 1_000_000.0,
				"wall_ms": 0,
			},
			"turns": turns,
			"model": serving_model.unwrap_or_default(),
			"model_fallback": model_fallback,
			"warnings": warnings,
			"output_url": format!("agent://{id}"),
			"transcript_url": format!("history://{id}"),
			"worktree": worktree,
		}))
	}

	fn unavailable(operation: &str, owner: &'static str) -> ControlProtocolError {
		ControlProtocolError::new(
			"AgentsError",
			format!("{operation} has no bound authoritative {owner}"),
		)
		.with_details(json!({"operation": operation, "owner": owner}))
	}

	fn roster(&self, arguments: &serde_json::Map<String, Value>, peers_only: bool) -> Value {
		let include_parked = arguments
			.get("include_parked")
			.and_then(Value::as_bool)
			.unwrap_or(true);
		let kind_filter = arguments.get("kind").and_then(Value::as_str);
		let status_filter = arguments.get("status").and_then(Value::as_str);
		let project_scope =
			peers_only && arguments.get("scope").and_then(Value::as_str) == Some("project");
		Value::Array(
			self
				.parent
				.broker
				.registry()
				.roster(!peers_only)
				.into_iter()
				.filter(|record| project_scope || record.session == self.expected_session_id)
				.filter(|record| include_parked || record.status != RegistryStatus::Parked)
				.filter_map(|record| {
					let kind = match record.kind {
						AgentKind::Main => "main",
						AgentKind::Subagent => "sub",
						AgentKind::Advisor if peers_only => return None,
						AgentKind::Advisor => "advisor",
					};
					let status = record.status.to_string();
					if kind_filter.is_some_and(|filter| filter != kind)
						|| status_filter.is_some_and(|filter| filter != status)
					{
						return None;
					}
					Some(json!({
						"id": record.id,
						"name": record.name,
						"kind": kind,
						"status": status,
						"agent": record.definition.unwrap_or_default(),
						"parent": record.parent,
						"depth": record.depth,
						"activity": record.activity,
						"last_activity_ms": record.last_activity_ms,
						"usage": {
							"input_tokens": record.history.input_tokens,
							"cached_input_tokens": 0,
							"output_tokens": record.history.output_tokens,
							"reasoning_tokens": 0,
							"cache_write_tokens": 0,
							"requests": record.history.requests,
							"cost_usd": record.history.usd_micros as f64 / 1_000_000.0,
							"wall_ms": record.history.duration_ms,
						},
						"output_url": format!("agent://{}", record.id),
						"transcript_url": format!("history://{}", record.id),
					}))
				})
				.collect(),
		)
	}

	fn capability(context: &control::ControlRequestContext, capability: &str) -> bool {
		context
			.connection
			.capabilities
			.iter()
			.any(|granted| granted == capability)
	}

	fn require_capability(
		context: &control::ControlRequestContext,
		capability: &str,
	) -> Result<(), ControlProtocolError> {
		if Self::capability(context, capability) {
			Ok(())
		} else {
			Err(
				ControlProtocolError::new(
					"permission_denied",
					format!("omp.agents operation requires manifest capability {capability}"),
				)
				.with_details(json!({"capability": capability})),
			)
		}
	}

	fn require_effects_authorized(
		context: &control::ControlRequestContext,
	) -> Result<(), ControlProtocolError> {
		let Some(invocation) = context.invocation.as_ref() else {
			return Err(ControlProtocolError::new(
				"effects_not_authorized",
				"operation requires an active effects-authorized invocation",
			));
		};
		if invocation
			.phase
			.allows_operation(omp_core::InvocationPhase::EffectsAuthorized)
		{
			Ok(())
		} else {
			Err(
				ControlProtocolError::new(
					"effects_not_authorized",
					"invocation has not reached EFFECTS_AUTHORIZED",
				)
				.with_details(json!({"phase": <&'static str>::from(invocation.phase)})),
			)
		}
	}

	fn delivery_mode(
		arguments: &serde_json::Map<String, Value>,
	) -> Result<omp_agent::DeliveryMode, ControlProtocolError> {
		match arguments
			.get("mode")
			.and_then(Value::as_str)
			.unwrap_or("aside")
		{
			"aside" => Ok(omp_agent::DeliveryMode::Aside),
			"steer" => Ok(omp_agent::DeliveryMode::Steer),
			"next_turn" => Ok(omp_agent::DeliveryMode::NextTurn),
			mode => Err(ControlProtocolError::new(
				"ValueError",
				format!("unknown agent delivery mode {mode:?}"),
			)),
		}
	}

	fn receipt(receipt: omp_agent::Receipt) -> &'static str {
		match receipt {
			omp_agent::Receipt::Injected => "delivered",
			omp_agent::Receipt::Woken => "woken",
			omp_agent::Receipt::Revived => "revived",
			omp_agent::Receipt::Failed => "failed",
		}
	}

	fn preflight_spec(&self, spec: &Value) -> Result<(), ControlProtocolError> {
		let spec = spec.as_object().ok_or_else(|| {
			ControlProtocolError::new("SpawnDenied", "subagent spec must be an object")
		})?;
		if !spec
			.get("task")
			.and_then(Value::as_str)
			.is_some_and(|task| !task.trim().is_empty())
		{
			return Err(
				ControlProtocolError::new("SpawnDenied", "subagent task must be non-empty")
					.with_details(json!({"reason": "empty task", "field": "task"})),
			);
		}
		let agent = spec.get("agent").and_then(Value::as_str).unwrap_or("task");
		let context = self.parent.context.lock();
		let definition = context
			.definitions
			.iter()
			.find(|(name, _)| name.as_str().eq_ignore_ascii_case(agent))
			.map(|(_, definition)| definition);
		if definition.is_none() {
			return Err(
				ControlProtocolError::new(
					"SpawnDenied",
					format!("agent type {agent:?} is not available in this session"),
				)
				.with_details(json!({"reason": "unknown agent", "field": "agent"})),
			);
		}
		if context
			.task_settings
			.snapshot()
			.disabled_agents
			.iter()
			.any(|name| name.as_str().eq_ignore_ascii_case(agent))
		{
			return Err(
				ControlProtocolError::new(
					"SpawnDenied",
					"requested agent is disabled by live task settings",
				)
				.with_details(json!({"reason": "disabled agent", "field": "agent"})),
			);
		}
		if context
			.state
			.snapshot()
			.turn
			.params
			.task_budget
			.is_some_and(|budget| budget.remaining_tokens == Some(0))
		{
			return Err(
				ControlProtocolError::new("SpawnDenied", "hard turn token budget is exhausted")
					.with_details(json!({"reason": "budget exhausted", "field": "budget"})),
			);
		}
		for (field, unsupported) in [
			(
				"system_prompt",
				spec
					.get("system_prompt")
					.is_some_and(|value| !value.is_null()),
			),
			("model", spec.get("model").is_some_and(|value| !value.is_null())),
			(
				"on_model_unavailable",
				spec
					.get("on_model_unavailable")
					.and_then(Value::as_str)
					.is_some_and(|value| value != "fail"),
			),
			(
				"allowed_devices",
				spec
					.get("allowed_devices")
					.is_some_and(|value| !value.is_null()),
			),
			(
				"disallowed_devices",
				spec
					.get("disallowed_devices")
					.and_then(Value::as_array)
					.is_some_and(|values| !values.is_empty()),
			),
			(
				"isolation",
				spec
					.get("isolation")
					.and_then(Value::as_str)
					.is_some_and(|value| value != "clean"),
			),
			("cwd", spec.get("cwd").is_some_and(|value| !value.is_null())),
			(
				"env_vars",
				spec
					.get("env_vars")
					.and_then(Value::as_object)
					.is_some_and(|values| !values.is_empty()),
			),
			("deadline", spec.get("deadline").is_some_and(|value| !value.is_null())),
			(
				"request_budget",
				spec
					.get("request_budget")
					.is_some_and(|value| !value.is_null()),
			),
			("budget", spec.get("budget").is_some_and(|value| !value.is_null())),
			(
				"labels",
				spec
					.get("labels")
					.and_then(Value::as_object)
					.is_some_and(|values| !values.is_empty()),
			),
		] {
			if unsupported {
				return Err(
					ControlProtocolError::new(
						"SpawnDenied",
						format!(
							"subagent field {field:?} is not supported by the active child authority"
						),
					)
					.with_details(json!({"reason": "unsupported by child authority", "field": field})),
				);
			}
		}
		Ok(())
	}

	async fn spawn_one(
		&self,
		context: &control::ControlRequestContext,
		spec: Value,
	) -> Result<Value, ControlProtocolError> {
		let caller = Self::caller(context)?;
		self.spawn_one_for(caller, None, spec).await
	}

	async fn spawn_one_for(
		&self,
		caller: Str,
		stable_id: Option<Str>,
		spec: Value,
	) -> Result<Value, ControlProtocolError> {
		self.preflight_spec(&spec)?;
		let spec_object = spec.as_object().ok_or_else(|| {
			ControlProtocolError::new("SpawnDenied", "subagent spec must be an object")
				.with_details(json!({"reason": "invalid subagent spec", "field": "spec"}))
		})?;
		let task = spec_object
			.get("task")
			.and_then(Value::as_str)
			.unwrap_or_default();
		if task.trim().is_empty() {
			return Err(
				ControlProtocolError::new("SpawnDenied", "subagent task must be non-empty")
					.with_details(json!({"reason": "empty task", "field": "task"})),
			);
		}
		let parent_node = self.parent.tree().node(caller.as_str()).ok_or_else(|| {
			ControlProtocolError::new("AgentGone", "spawning agent is no longer registered")
				.with_details(json!({
					"ref": caller,
					"status": "aborted",
					"transcript_url": format!("history://{caller}"),
				}))
		})?;
		let parent_max_depth = self
			.parent
			.supervisor
			.metadata(caller.as_str())
			.and_then(|metadata| metadata.get("effective_max_depth").and_then(Value::as_u64))
			.and_then(|depth| u16::try_from(depth).ok())
			.unwrap_or_else(|| self.parent.supervisor.limits().max_depth);
		if parent_node.depth >= parent_max_depth {
			return Err(
				ControlProtocolError::new(
					"DepthExceeded",
					"spawning agent reached its effective depth ceiling",
				)
				.with_details(json!({
					"depth": parent_node.depth,
					"max_depth": parent_max_depth,
				})),
			);
		}
		let requested_depth = spec_object
			.get("max_depth")
			.and_then(Value::as_u64)
			.and_then(|depth| u16::try_from(depth).ok())
			.ok_or_else(|| {
				ControlProtocolError::new(
					"SpawnDenied",
					"subagent max_depth must be a non-negative 16-bit integer",
				)
				.with_details(json!({"reason": "invalid depth", "field": "max_depth"}))
			})?;
		let id = stable_id.unwrap_or_else(|| Str::from(omp_core::Ulid::generate().to_string()));
		let mut bridge = serde_json::Map::new();
		bridge.insert("prompt".to_owned(), Value::String(task.to_owned()));
		bridge.insert("stableId".to_owned(), Value::String(id.to_string()));
		bridge.insert("_parentId".to_owned(), Value::String(caller.to_string()));
		for (source, target) in [
			("name", "name"),
			("agent", "agent"),
			("output_schema", "outputSchema"),
			("schema_mode", "schemaMode"),
		] {
			if let Some(value) = spec_object.get(source) {
				bridge.insert(target.to_owned(), value.clone());
			}
		}
		if let Some(thinking) = spec_object.get("thinking").and_then(Value::as_str) {
			let effort = match thinking {
				"off" => "minimal",
				"lo" => "low",
				"med" => "medium",
				"hi" => "high",
				_ => {
					return Err(
						ControlProtocolError::new("SpawnDenied", "subagent thinking level is invalid")
							.with_details(
								json!({"reason": "invalid thinking level", "field": "thinking"}),
							),
					);
				},
			};
			bridge.insert("effort".to_owned(), Value::String(effort.to_owned()));
		}
		let worktree = spec_object
			.get("worktree")
			.and_then(Value::as_bool)
			.unwrap_or(false);
		bridge.insert("isolated".to_owned(), Value::Bool(worktree));
		match spec_object
			.get("merge")
			.and_then(Value::as_str)
			.unwrap_or("none")
		{
			"patch" => {
				bridge.insert("apply".to_owned(), Value::Bool(true));
			},
			"branch" => {
				bridge.insert("merge".to_owned(), Value::Bool(true));
			},
			_ => {},
		}
		let parent = Arc::clone(&self.parent);
		let child_id = id.clone();
		let result_id = child_id.clone();
		let mut task = tokio::spawn(async move {
			let result = ParentSessionHost::agent(
				parent.as_ref(),
				Value::Object(bridge),
				&omp_envd::eval::NoopBridgeProgress,
			)
			.await;
			if let Ok(value) = &result {
				let _ = parent
					.supervisor
					.set_result(result_id.as_str(), value.clone());
			}
			result
		});
		let admitted = loop {
			if let Some(state) = self.parent.supervisor.state(child_id.as_str()) {
				break state;
			}
			tokio::select! {
				result = &mut task => {
					let detail = result
						.map_err(|error| error.to_string())
						.and_then(|result| result.map_err(|error| error.to_string()))
						.err()
						.unwrap_or_else(|| "child ended before admission".to_owned());
					return Err(omp_envd::exthost::control::ControlProtocolError::new(
						"SpawnDenied",
						detail.clone(),
					)
					.with_details(json!({"reason": detail, "field": null})));
				},
				() = tokio::time::sleep(Duration::from_millis(2)) => {},
			}
		};
		drop(task);
		let generation = admitted.generation().0;
		let node = self.parent.tree().node(id.as_str()).ok_or_else(|| {
			ControlProtocolError::new(
				"SpawnDenied",
				"child admission omitted its authoritative tree node",
			)
		})?;
		let handle = json!({
			"run_id": format!("{id}#{generation}"),
			"session_id": self.parent.session_id(),
			"name": node.name,
			"agent": spec_object.get("agent").and_then(Value::as_str).unwrap_or("task"),
			"depth": node.depth,
			"effective_max_depth": self.parent.supervisor.limits().max_depth.min(
				node.depth.saturating_add(requested_depth)
			),
			"spec": spec,
			"worktree_path": null,
			"output_url": format!("agent://{id}"),
			"transcript_url": format!("history://{id}"),
		});
		self
			.parent
			.supervisor
			.set_metadata(id.as_str(), handle.clone())
			.map_err(|error| ControlProtocolError::new("SpawnDenied", error.to_string()))?;
		Ok(handle)
	}

	async fn completion(
		&self,
		arguments: serde_json::Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		let mut bridge = arguments.clone();
		if bridge.get("schema").is_some_and(Value::is_null) {
			bridge.remove("schema");
		}
		let role = bridge
			.remove("role")
			.and_then(|value| value.as_str().map(str::to_owned))
			.unwrap_or_else(|| "smol".to_owned());
		bridge.insert("model".to_owned(), Value::String(role));
		bridge.remove("scope");
		bridge.remove("deadline_ms");
		bridge.remove("labels");
		let deadline_ms = arguments
			.get("deadline_ms")
			.and_then(Value::as_u64)
			.unwrap_or(10_000);
		if deadline_ms == 0 {
			return Err(
				ControlProtocolError::new(
					"CompletionFailed",
					"unbounded completion deadlines require an explicit host grant",
				)
				.with_details(json!({
					"reason": "unbounded deadline is not granted",
					"raw": null,
					"usage": {},
				})),
			);
		}
		let started = Instant::now();
		let request = ParentSessionHost::completion(
			self.parent.as_ref(),
			Value::Object(bridge),
			&omp_envd::eval::NoopBridgeProgress,
		);
		match time::timeout(Duration::from_millis(deadline_ms), request).await {
			Ok(Ok(value)) => Ok(value),
			Ok(Err(error)) if arguments.contains_key("default") => Ok(json!({
				"text": "",
				"choice": arguments.get("default").filter(|value| value.is_string()),
				"data": arguments.get("default"),
				"usage": {
					"input_tokens": 0,
					"cached_input_tokens": 0,
					"output_tokens": 0,
					"reasoning_tokens": 0,
					"cache_write_tokens": 0,
					"requests": 1,
					"cost_usd": 0.0,
					"wall_ms": started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
				},
				"model": "",
				"fell_back": true,
				"fault": {"reason": "provider", "detail": error.to_string()},
			})),
			Ok(Err(error)) => Err(
				ControlProtocolError::new("CompletionFailed", error.to_string()).with_details(json!({
					"reason": error.to_string(),
					"raw": null,
					"usage": {
						"input_tokens": 0,
						"cached_input_tokens": 0,
						"output_tokens": 0,
						"reasoning_tokens": 0,
						"cache_write_tokens": 0,
						"requests": 0,
						"cost_usd": 0.0,
						"wall_ms": 0,
					},
				})),
			),
			Err(_) if arguments.contains_key("default") => Ok(json!({
				"text": "",
				"choice": arguments.get("default"),
				"data": arguments.get("default"),
				"usage": {
					"input_tokens": 0,
					"cached_input_tokens": 0,
					"output_tokens": 0,
					"reasoning_tokens": 0,
					"cache_write_tokens": 0,
					"requests": 0,
					"cost_usd": 0.0,
					"wall_ms": deadline_ms,
				},
				"model": "",
				"fell_back": true,
				"fault": {"reason": "deadline"},
			})),
			Err(_) => Err(
				ControlProtocolError::new("CompletionFailed", "completion deadline exceeded")
					.retryable(true)
					.with_details(json!({
						"reason": "deadline",
						"raw": null,
						"usage": {
							"input_tokens": 0,
							"cached_input_tokens": 0,
							"output_tokens": 0,
							"reasoning_tokens": 0,
							"cache_write_tokens": 0,
							"requests": 0,
							"cost_usd": 0.0,
							"wall_ms": deadline_ms,
						},
					})),
			),
		}
	}

	fn route_message(
		&self,
		context: &control::ControlRequestContext,
		arguments: &serde_json::Map<String, Value>,
		to: Str,
	) -> Result<(Str, smallvec::SmallVec<omp_agent::DeliveryReceipt, 4>), ControlProtocolError> {
		let invocation = context.invocation.as_ref().ok_or_else(|| {
			ControlProtocolError::new("PhaseConflict", "agent messaging requires a session invocation")
		})?;
		let id = Str::from(omp_core::Ulid::generate().to_string());
		let deliveries = self
			.parent
			.broker
			.route(omp_agent::PeerMessage {
				id: id.clone(),
				from: invocation.session.clone(),
				to,
				text: Str::from(
					arguments
						.get("text")
						.and_then(Value::as_str)
						.unwrap_or_default(),
				),
				mode: Self::delivery_mode(arguments)?,
				reply_to: arguments
					.get("reply_to")
					.and_then(Value::as_str)
					.map(Str::from),
				sent_ms: now_ms(),
				session_id: invocation.session.clone(),
				expects_reply: arguments
					.get("await_reply")
					.and_then(Value::as_bool)
					.unwrap_or(false),
			})
			.map_err(|error| ControlProtocolError::new("AgentsMessagingFailed", error.to_string()))?;
		Ok((id, deliveries))
	}

	fn message_json(message: omp_agent::PeerMessage) -> Value {
		json!({
			"id": message.id,
			"from": message.from,
			"to": message.to,
			"text": message.text,
			"mode": message.mode.to_string(),
			"reply_to": message.reply_to,
			"sent_ms": message.sent_ms,
			"session_id": message.session_id,
		})
	}

	fn snapshot_json(snapshot: env_pb::WorkspaceSnapshot) -> Value {
		json!({
			"id": snapshot.snapshot_id,
			"generation": snapshot.generation,
			"label": snapshot.label,
			"created_ms": snapshot.created_ms,
			"root": snapshot.root_uri,
			"parent": snapshot.parent_snapshot_id,
			"tree_hash": snapshot.tree_hash,
			"entry_count": snapshot.entry_count,
			"bytes": snapshot.bytes,
			"partial": snapshot.partial,
		})
	}

	fn restore_json(restored: env_pb::WorkspaceRestored) -> Value {
		json!({
			"from_generation": restored.from_generation,
			"to_generation": restored.to_generation,
			"written": restored.written,
			"deleted": restored.deleted,
			"unchanged": restored.unchanged,
			"conflicts": restored.conflicts.into_iter().map(|conflict| {
				let reason = env_pb::ConflictReason::try_from(conflict.reason)
					.unwrap_or(env_pb::ConflictReason::Unspecified);
				json!({
					"path": conflict.path,
					"reason": match reason {
						env_pb::ConflictReason::OpenLease => "open_lease",
						env_pb::ConflictReason::OutsideRoot => "outside_root",
						env_pb::ConflictReason::Permission => "permission",
						_ => "modified_after_snapshot",
					},
					"lease_holder": conflict.lease_holder,
				})
			}).collect::<Vec<_>>(),
			"undo_snapshot_id": restored.undo_snapshot_id,
			"dry_run": restored.dry_run,
		})
	}

	async fn host_request(
		&self,
		context: &control::ControlRequestContext,
		operation: &str,
		mut arguments: serde_json::Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		let caller = Self::caller(context)?;
		arguments
			.insert("_owner".to_owned(), Value::String(context.connection.extension.to_string()));
		let control = self.parent.host_control(caller.as_str()).ok_or_else(|| {
			ControlProtocolError::new("AgentsError", "calling agent loop is no longer live")
		})?;
		control
			.request(operation, arguments)
			.await
			.map_err(|error| ControlProtocolError::new("AgentsError", error.to_string()))
	}
}

#[async_trait]
impl<C: TurnClient + Clone + Send + Sync + 'static> omp_envd::schedules::ScheduleDeliveryBackend
	for ChatScheduleDelivery<C>
{
	async fn settled_since_ms(
		&self,
		row: &omp_envd::schedules::ScheduleRow,
	) -> Result<Option<u64>, Str> {
		Ok(self
			.parent
			.broker
			.registry()
			.record(row.owner.as_str())
			.filter(|(record, _)| {
				matches!(record.status, RegistryStatus::Idle | RegistryStatus::Parked)
			})
			.map(|(record, _)| record.last_activity_ms))
	}

	async fn estimate(
		&self,
		request: &omp_envd::schedules::ScheduleDeliveryRequest,
	) -> Result<BudgetReservation, Str> {
		if request
			.schedule
			.delivery
			.get("kind")
			.and_then(Value::as_str)
			!= Some("spawn")
		{
			return Ok(BudgetReservation::default());
		}
		let soft_budget = u64::from(self.parent.task_settings().soft_request_budget);
		let requests = if soft_budget == 0 {
			u64::MAX
		} else {
			soft_budget.saturating_mul(3).saturating_add(1) / 2 + 5
		};
		let cost_micros = if request
			.schedule
			.budget
			.get("max_usd_per_firing")
			.is_some_and(|value| !value.is_null())
			|| request
				.schedule
				.budget
				.get("max_usd_per_window")
				.is_some_and(|value| !value.is_null())
		{
			u64::MAX
		} else {
			0
		};
		Ok(BudgetReservation { cost_micros, requests })
	}

	async fn deliver(
		&self,
		request: omp_envd::schedules::ScheduleDeliveryRequest,
	) -> Result<omp_envd::schedules::ScheduleDeliveryReceipt, Str> {
		let kind = request
			.schedule
			.delivery
			.get("kind")
			.and_then(Value::as_str)
			.ok_or_else(|| sf!("schedule delivery kind is missing"))?;
		match kind {
			"inject" => {
				let prompt = request
					.schedule
					.delivery
					.get("prompt")
					.and_then(Value::as_str)
					.ok_or_else(|| sf!("schedule inject prompt is missing"))?;
				let mode = match request
					.schedule
					.delivery
					.get("mode")
					.and_then(Value::as_str)
					.unwrap_or("aside")
				{
					"aside" => omp_agent::DeliveryMode::Aside,
					"steer" => omp_agent::DeliveryMode::Steer,
					"next_turn" => omp_agent::DeliveryMode::NextTurn,
					mode => return Err(sf!("invalid schedule delivery mode {mode:?}")),
				};
				let deliveries = self
					.parent
					.broker
					.route(omp_agent::PeerMessage {
						id: request.idempotency_key,
						from: request.schedule.owner.clone(),
						to: request.schedule.owner,
						text: Str::new(prompt),
						mode,
						reply_to: None,
						sent_ms: now_ms(),
						session_id: self.parent.session_id(),
						expects_reply: false,
					})
					.map_err(|error| Str::from(error.to_string()))?;
				let receipt =
					deliveries
						.first()
						.map_or("buffered", |delivery| match delivery.outcome {
							omp_agent::Receipt::Injected => "delivered",
							omp_agent::Receipt::Woken => "woken",
							omp_agent::Receipt::Revived => "revived",
							omp_agent::Receipt::Failed => "buffered",
						});
				Ok(omp_envd::schedules::ScheduleDeliveryReceipt {
					receipt:     Str::new(receipt),
					run_id:      None,
					cost_micros: 0,
					requests:    0,
				})
			},
			"spawn" => {
				let stable_id = sf!("schedule-{}-{}", request.schedule.id, request.at_ms);
				if let Some(metadata) = self.parent.supervisor.resolved_metadata(stable_id.as_str()) {
					return Ok(omp_envd::schedules::ScheduleDeliveryReceipt {
						receipt:     sf!("delivered"),
						run_id:      metadata.get("run_id").and_then(Value::as_str).map(Str::new),
						cost_micros: 0,
						requests:    0,
					});
				}
				let spec = request
					.schedule
					.delivery
					.get("spec")
					.cloned()
					.ok_or_else(|| sf!("schedule spawn spec is missing"))?;
				let authority = AgentsControlAuthority::new(Arc::clone(&self.parent));
				let handle = authority
					.spawn_one_for(request.schedule.owner, Some(stable_id), spec)
					.await
					.map_err(|error| Str::from(error.to_string()))?;
				Ok(omp_envd::schedules::ScheduleDeliveryReceipt {
					receipt:     sf!("delivered"),
					run_id:      handle.get("run_id").and_then(Value::as_str).map(Str::new),
					cost_micros: 0,
					requests:    0,
				})
			},
			kind => Err(sf!("unknown schedule delivery kind {kind:?}")),
		}
	}
}

#[async_trait]
impl<C: TurnClient + Clone + Send + 'static> ControlAuthority for AgentsControlAuthority<C> {
	fn handles(&self, operation: &str) -> bool {
		matches!(
			operation,
			"omp.agents.completion"
				| "omp.agents.continuations"
				| "omp.agents.set_continuation_policy"
				| "omp.agents.loop_signal"
				| "omp.agents.spawn"
				| "omp.agents.spawn_all"
				| "omp.agents.status"
				| "omp.agents.progress"
				| "omp.agents.steer"
				| "omp.agents.cancel"
				| "omp.agents.wait"
				| "omp.agents.result"
				| "omp.agents.release"
				| "omp.agents.get"
				| "omp.agents.revive"
				| "omp.agents.limits"
				| "omp.agents.list"
				| "omp.agents.send"
				| "omp.agents.broadcast"
				| "omp.agents.inbox"
				| "omp.agents.wait_for"
				| "omp.agents.peers"
				| "omp.agents.inject"
				| "omp.agents.rewind_targets"
				| "omp.agents.rewind"
				| "omp.agents.snapshot"
				| "omp.agents.snapshots"
				| "omp.agents.restore"
		)
	}

	fn authorize(
		&self,
		context: &control::ControlRequestContext,
		operation: &str,
		arguments: &serde_json::Map<String, Value>,
	) -> Result<(), ControlProtocolError> {
		self.ensure_current()?;
		match operation {
			"omp.agents.completion" => {
				Self::require_capability(context, "inference:completion")?;
				let invocation = context.invocation.as_ref().ok_or_else(|| {
					ControlProtocolError::new(
						"PhaseConflict",
						"completion requires an active authorized invocation",
					)
				})?;
				let turn_start = invocation.event.as_deref() == Some("turn_start");
				if turn_start
					|| invocation
						.phase
						.allows_operation(omp_core::InvocationPhase::Admission)
				{
					Ok(())
				} else {
					Err(
						ControlProtocolError::new(
							"PhaseConflict",
							"completion is not legal in the current invocation phase",
						)
						.with_details(json!({"phase": <&'static str>::from(invocation.phase)})),
					)
				}
			},
			"omp.agents.spawn" | "omp.agents.spawn_all" => {
				Self::require_capability(context, "subagents")?;
				Self::require_effects_authorized(context)
			},
			"omp.agents.broadcast"
				if arguments.get("scope").and_then(Value::as_str) == Some("project") =>
			{
				Self::require_capability(context, "messaging:project")
			},
			"omp.agents.peers"
				if arguments.get("scope").and_then(Value::as_str) == Some("project") =>
			{
				Self::require_capability(context, "messaging:project")
			},
			"omp.agents.send"
				if arguments
					.get("to")
					.and_then(Value::as_str)
					.is_some_and(|to| to == "project:all" || to.starts_with("session:")) =>
			{
				Self::require_capability(context, "messaging:project")
			},
			_ => Ok(()),
		}
	}

	async fn request(
		&self,
		context: control::ControlRequestContext,
		operation: Str,
		arguments: serde_json::Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		self.ensure_current()?;
		match operation.as_str() {
			"omp.agents.completion" => self.completion(arguments).await,
			"omp.agents.continuations"
			| "omp.agents.set_continuation_policy"
			| "omp.agents.loop_signal"
			| "omp.agents.rewind_targets" => {
				self
					.host_request(&context, operation.as_str(), arguments)
					.await
			},
			"omp.agents.rewind" => {
				let scope = arguments
					.get("scope")
					.and_then(Value::as_str)
					.unwrap_or("thread")
					.to_owned();
				let dry_run = arguments
					.get("dry_run")
					.and_then(Value::as_bool)
					.unwrap_or(false);
				if scope == "thread" {
					return self
						.host_request(&context, operation.as_str(), arguments)
						.await;
				}
				let snapshot_id = arguments
					.get("snapshot_id")
					.and_then(Value::as_str)
					.ok_or_else(|| {
						ControlProtocolError::new(
							"SnapshotUnsupported",
							"workspace rewind requires snapshot_id",
						)
					})?
					.to_owned();
				let restore_request = |dry_run| env_pb::RestoreWorkspace {
					snapshot_id: snapshot_id.clone(),
					dry_run,
					scope: "workspace".to_owned(),
					paths: Vec::new(),
					expected_generation: 0,
					wire_revision: omp_proto::SCHEMA_REV,
					props: Default::default(),
				};
				let workspace_preflight = self
					.parent
					.env
					.restore_workspace(restore_request(true))
					.await
					.map_err(|error| {
						ControlProtocolError::new("SnapshotUnsupported", error.to_string())
					})?;
				let mut thread_preflight = if scope == "both" {
					let mut preflight = arguments.clone();
					preflight.insert("dry_run".to_owned(), Value::Bool(true));
					self
						.host_request(&context, operation.as_str(), preflight)
						.await?
				} else {
					json!({
						"head": arguments.get("to").and_then(Value::as_u64).unwrap_or(0),
						"dropped_items": 0,
						"scope": scope,
						"restore": null,
						"dry_run": true,
					})
				};
				if dry_run || !workspace_preflight.conflicts.is_empty() {
					if let Some(object) = thread_preflight.as_object_mut() {
						object.insert("scope".to_owned(), Value::String(scope));
						object.insert("restore".to_owned(), Self::restore_json(workspace_preflight));
						object.insert("dry_run".to_owned(), Value::Bool(true));
					}
					return Ok(thread_preflight);
				}
				let restored = self
					.parent
					.env
					.restore_workspace(restore_request(false))
					.await
					.map_err(|error| {
						ControlProtocolError::new("SnapshotUnsupported", error.to_string())
					})?;
				let undo = restored.undo_snapshot_id.clone();
				let mut thread = if scope == "both" {
					match self
						.host_request(&context, operation.as_str(), arguments)
						.await
					{
						Ok(thread) => thread,
						Err(error) => {
							let _ = self
								.parent
								.env
								.restore_workspace(env_pb::RestoreWorkspace {
									snapshot_id:         undo,
									dry_run:             false,
									scope:               "workspace".to_owned(),
									paths:               Vec::new(),
									expected_generation: 0,
									wire_revision:       omp_proto::SCHEMA_REV,
									props:               Default::default(),
								})
								.await;
							return Err(error);
						},
					}
				} else {
					json!({
						"head": arguments.get("to").and_then(Value::as_u64).unwrap_or(0),
						"dropped_items": 0,
						"scope": scope,
						"restore": null,
						"dry_run": false,
					})
				};
				if let Some(object) = thread.as_object_mut() {
					object.insert("scope".to_owned(), Value::String(scope));
					object.insert("restore".to_owned(), Self::restore_json(restored));
					object.insert("dry_run".to_owned(), Value::Bool(false));
				}
				Ok(thread)
			},
			"omp.agents.spawn" => {
				let spec = arguments.get("spec").cloned().ok_or_else(|| {
					ControlProtocolError::new("SpawnDenied", "subagent spec is required")
				})?;
				self.spawn_one(&context, spec).await
			},
			"omp.agents.spawn_all" => {
				let specs = arguments
					.get("specs")
					.and_then(Value::as_array)
					.ok_or_else(|| {
						ControlProtocolError::new("SpawnDenied", "subagent specs are required")
					})?;
				if specs.is_empty() {
					return Ok(Value::Array(Vec::new()));
				}
				let mut names = BTreeSet::new();
				for spec in specs {
					if !spec
						.get("task")
						.and_then(Value::as_str)
						.is_some_and(|task| !task.trim().is_empty())
					{
						return Err(ControlProtocolError::new(
							"SpawnDenied",
							"every subagent spec requires a non-empty task",
						));
					}
					self.preflight_spec(spec)?;
					if let Some(name) = spec.get("name").and_then(Value::as_str)
						&& !names.insert(name.to_ascii_lowercase())
					{
						return Err(
							ControlProtocolError::new(
								"SpawnDenied",
								"subagent names must be unique within a batch",
							)
							.with_details(json!({"reason": "duplicate name", "field": "name"})),
						);
					}
				}
				let mut handles = Vec::with_capacity(specs.len());
				for spec in specs {
					match self.spawn_one(&context, spec.clone()).await {
						Ok(handle) => handles.push(handle),
						Err(error) => {
							for handle in &handles {
								if let Some(run_id) = handle.get("run_id").and_then(Value::as_str)
									&& let Ok((id, _)) = Self::split_run_id(run_id)
								{
									let _ = self.parent.supervisor.teardown(id).await;
									self.parent.broker.unregister(id);
								}
							}
							return Err(error);
						},
					}
				}
				Ok(Value::Array(handles))
			},
			operation @ ("omp.agents.status"
			| "omp.agents.progress"
			| "omp.agents.steer"
			| "omp.agents.cancel"
			| "omp.agents.wait"
			| "omp.agents.result"
			| "omp.agents.release") => {
				let run_id = arguments
					.get("run_id")
					.and_then(Value::as_str)
					.ok_or_else(|| {
						ControlProtocolError::new("UnknownRun", "subagent run handle is required")
					})?;
				let (id, state) = self.owned_state(&context, run_id)?;
				match operation {
					"omp.agents.status" => Ok(Value::String(Self::run_status(&state).to_owned())),
					"omp.agents.progress" => {
						let progress = state.progress();
						let turns = state
							.events()
							.filter(|event| {
								matches!(
									event.event,
									omp_agent::SubagentRunEventKind::Lifecycle(SubagentLifecycle::Running)
								)
							})
							.count();
						let last_activity_ms = self
							.parent
							.broker
							.registry()
							.record(id.as_str())
							.map_or(0, |(record, _)| record.last_activity_ms);
						Ok(json!({
							"status": Self::run_status(&state),
							"turns": turns,
							"requests": progress.requests,
							"tool_calls": progress.tool_calls,
							"context_tokens": progress.context_tokens,
							"context_window": progress.context_tokens,
							"usage": {
								"input_tokens": progress.input_tokens,
								"cached_input_tokens": 0,
								"output_tokens": progress.output_tokens,
								"reasoning_tokens": 0,
								"cache_write_tokens": 0,
								"requests": progress.requests,
								"cost_usd": progress.cost_micros as f64 / 1_000_000.0,
								"wall_ms": 0,
							},
							"activity": progress.activity,
							"model": progress.serving_model.unwrap_or_default(),
							"last_activity_ms": last_activity_ms,
						}))
					},
					"omp.agents.steer" => {
						let (_, deliveries) = self.route_message(&context, &arguments, id.clone())?;
						Ok(Value::String(
							deliveries
								.first()
								.map_or("failed", |delivery| Self::receipt(delivery.outcome))
								.to_owned(),
						))
					},
					"omp.agents.cancel" => {
						let (_, generation) = Self::split_run_id(run_id)?;
						let reason = arguments
							.get("reason")
							.and_then(Value::as_str)
							.filter(|reason| !reason.trim().is_empty())
							.unwrap_or("cancelled by extension");
						let grace = Duration::from_millis(
							arguments
								.get("grace_ms")
								.and_then(Value::as_u64)
								.unwrap_or(500),
						);
						self
							.parent
							.supervisor
							.cancel_with_grace(id.as_str(), generation, Str::new(reason), grace)
							.await
							.map_err(|error| {
								ControlProtocolError::new("AgentGone", error.to_string()).with_details(
									json!({
										"ref": run_id,
										"status": Self::run_status(&state),
										"transcript_url": format!("history://{id}"),
									}),
								)
							})?;
						Ok(Value::Null)
					},
					"omp.agents.result" => {
						Ok(self.result_json(id.as_str(), &state).unwrap_or(Value::Null))
					},
					"omp.agents.wait" => {
						let timeout = arguments.get("timeout_ms").and_then(Value::as_u64);
						let wait = async {
							loop {
								if let Some(result) = self.result_json(id.as_str(), &state) {
									break result;
								}
								time::sleep(Duration::from_millis(10)).await;
							}
						};
						if let Some(timeout) = timeout {
							time::timeout(Duration::from_millis(timeout), wait)
								.await
								.map_err(|_| {
									ControlProtocolError::new(
										"TimeoutError",
										"subagent wait deadline exceeded",
									)
								})
						} else {
							Ok(wait.await)
						}
					},
					"omp.agents.release" => {
						let (_, generation) = Self::split_run_id(run_id)?;
						self
							.parent
							.supervisor
							.release_at_generation(id.as_str(), generation)
							.await
							.map_err(|error| {
								ControlProtocolError::new("AgentGone", error.to_string()).with_details(
									json!({
										"ref": run_id,
										"status": Self::run_status(&state),
										"transcript_url": format!("history://{id}"),
									}),
								)
							})?;
						Ok(Value::Null)
					},
					_ => unreachable!(),
				}
			},
			operation @ ("omp.agents.get" | "omp.agents.revive") => {
				let caller = Self::caller(&context)?;
				let reference = arguments
					.get("ref")
					.and_then(Value::as_str)
					.filter(|reference| !reference.is_empty())
					.ok_or_else(|| {
						ControlProtocolError::new("AgentGone", "subagent reference is required")
							.with_details(json!({
								"ref": "",
								"status": "aborted",
								"transcript_url": "",
							}))
					})?;
				let id = self.parent.supervisor.resolve(reference).ok_or_else(|| {
					ControlProtocolError::new("AgentGone", "subagent was not found").with_details(
						json!({
							"ref": reference,
							"status": "aborted",
							"transcript_url": format!(
								"history://{}",
								reference.strip_prefix("agent://").unwrap_or(reference)
							),
						}),
					)
				})?;
				let node = self.parent.tree().node(id.as_str()).ok_or_else(|| {
					ControlProtocolError::new(
						"AgentGone",
						"subagent roster identity is no longer retained",
					)
				})?;
				if node.parent.as_deref() != Some(caller.as_str()) {
					return Err(
						ControlProtocolError::new("AgentGone", "subagent is not owned by this caller")
							.with_details(json!({
								"ref": reference,
								"status": "aborted",
								"transcript_url": format!("history://{id}"),
							})),
					);
				}
				if operation == "omp.agents.revive" {
					self
						.parent
						.supervisor
						.revive(id.as_str())
						.await
						.map_err(|error| {
							ControlProtocolError::new("AgentGone", error.to_string()).with_details(json!({
								"ref": reference,
								"status": "aborted",
								"transcript_url": format!("history://{id}"),
							}))
						})?;
				}
				let mut handle = self
					.parent
					.supervisor
					.resolved_metadata(id.as_str())
					.ok_or_else(|| {
						ControlProtocolError::new(
							"AgentGone",
							"subagent handle metadata is no longer retained",
						)
						.with_details(json!({
							"ref": reference,
							"status": "aborted",
							"transcript_url": format!("history://{id}"),
						}))
					})?;
				if let Some(handle) = handle.as_object_mut() {
					handle.insert(
						"session_id".to_owned(),
						Value::String(self.parent.session_id().to_string()),
					);
				}
				Ok(handle)
			},
			"omp.agents.limits" => {
				let caller = Self::caller(&context)?;
				let tree = self.parent.tree();
				let depth = tree.node(caller.as_str()).map_or(0, |node| node.depth);
				let limits = self.parent.supervisor.limits();
				let max_depth = self
					.parent
					.supervisor
					.metadata(caller.as_str())
					.and_then(|metadata| metadata.get("effective_max_depth").and_then(Value::as_u64))
					.and_then(|depth| u16::try_from(depth).ok())
					.unwrap_or(limits.max_depth);
				let running = limits.active;
				let queued = limits.queued;
				let max_concurrency = limits.max_concurrency;
				let continuations = self
					.host_request(&context, "omp.agents.continuations", serde_json::Map::new())
					.await?;
				let continuation_cap = continuations
					.get("cap")
					.and_then(Value::as_u64)
					.unwrap_or(0);
				let continuations_used = continuations
					.get("total")
					.and_then(Value::as_u64)
					.unwrap_or(0);
				let concurrency_available =
					max_concurrency == 0 || running < max_concurrency || queued < limits.max_queue;
				Ok(json!({
					"max_depth": max_depth,
					"depth": depth,
					"max_concurrency": max_concurrency,
					"running": running,
					"queued": queued,
					"continuation_cap": continuation_cap,
					"continuations_used": continuations_used,
					"spawn_allowed": depth < max_depth && concurrency_available,
				}))
			},
			"omp.agents.list" => Ok(self.roster(&arguments, false)),
			"omp.agents.peers" => Ok(self.roster(&arguments, true)),
			"omp.agents.send" => {
				let to = arguments
					.get("to")
					.and_then(Value::as_str)
					.map(Str::from)
					.ok_or_else(|| {
						ControlProtocolError::new("ValueError", "agent message recipient is required")
					})?;
				let await_reply = arguments
					.get("await_reply")
					.and_then(Value::as_bool)
					.unwrap_or(false);
				let caller = Self::caller(&context)?;
				let (message_id, deliveries) = self.route_message(&context, &arguments, to)?;
				if await_reply {
					let recipient = deliveries
						.first()
						.map(|delivery| delivery.to.clone())
						.ok_or_else(|| {
							ControlProtocolError::new("AgentsMessagingFailed", "message had no recipient")
						})?;
					let inbox = self.parent.inbox(caller.as_str()).ok_or_else(|| {
						ControlProtocolError::new(
							"AgentsMessagingFailed",
							"calling agent mailbox is no longer live",
						)
					})?;
					let timeout = arguments
						.get("timeout_ms")
						.and_then(Value::as_u64)
						.map(Duration::from_millis);
					let reply = inbox
						.lock()
						.await
						.wait_for_timeout(Some(recipient.as_str()), Some(message_id.as_str()), timeout)
						.await
						.map_err(|error| {
							ControlProtocolError::new("AgentsMessagingFailed", error.to_string())
						})?;
					return Ok(reply.map_or(Value::Null, Self::message_json));
				}
				Ok(Value::String(
					deliveries
						.first()
						.map_or("failed", |delivery| Self::receipt(delivery.outcome))
						.to_owned(),
				))
			},
			"omp.agents.broadcast" => {
				let target = if arguments.get("scope").and_then(Value::as_str) == Some("project") {
					sf!("project:all")
				} else {
					sf!("all")
				};
				let (_, deliveries) = self.route_message(&context, &arguments, target)?;
				Ok(Value::Object(
					deliveries
						.into_iter()
						.map(|delivery| {
							(
								delivery.to.to_string(),
								Value::String(Self::receipt(delivery.outcome).to_owned()),
							)
						})
						.collect(),
				))
			},
			"omp.agents.inject" => {
				let invocation = context.invocation.as_ref().ok_or_else(|| {
					ControlProtocolError::new(
						"PhaseConflict",
						"agent injection requires a session invocation",
					)
				})?;
				let mut routed = arguments.clone();
				if let Some(prompt) = routed.remove("prompt") {
					routed.insert("text".to_owned(), prompt);
				}
				let (_, deliveries) =
					self.route_message(&context, &routed, invocation.session.clone())?;
				Ok(Value::String(
					deliveries
						.first()
						.map_or("failed", |delivery| Self::receipt(delivery.outcome))
						.to_owned(),
				))
			},
			"omp.agents.inbox" => {
				let caller = Self::caller(&context)?;
				let inbox = self.parent.inbox(caller.as_str()).ok_or_else(|| {
					ControlProtocolError::new(
						"AgentsMessagingFailed",
						"calling agent mailbox is no longer live",
					)
				})?;
				let peek = arguments
					.get("peek")
					.and_then(Value::as_bool)
					.unwrap_or(false);
				let limit = arguments
					.get("limit")
					.and_then(Value::as_u64)
					.and_then(|limit| usize::try_from(limit).ok());
				let mut messages = inbox.lock().await.inbox(peek);
				if let Some(limit) = limit {
					messages.truncate(limit);
				}
				Ok(Value::Array(messages.into_iter().map(Self::message_json).collect()))
			},
			"omp.agents.wait_for" => {
				let caller = Self::caller(&context)?;
				let inbox = self.parent.inbox(caller.as_str()).ok_or_else(|| {
					ControlProtocolError::new(
						"AgentsMessagingFailed",
						"calling agent mailbox is no longer live",
					)
				})?;
				let timeout = arguments
					.get("timeout_ms")
					.and_then(Value::as_u64)
					.map(Duration::from_millis);
				let message = inbox
					.lock()
					.await
					.wait_for_timeout(
						arguments.get("sender").and_then(Value::as_str),
						arguments.get("reply_to").and_then(Value::as_str),
						timeout,
					)
					.await
					.map_err(|error| {
						ControlProtocolError::new("AgentsMessagingFailed", error.to_string())
					})?;
				Ok(message.map_or(Value::Null, Self::message_json))
			},
			"omp.agents.snapshot" => {
				let paths = arguments
					.get("paths")
					.and_then(Value::as_array)
					.into_iter()
					.flatten()
					.filter_map(Value::as_str)
					.map(str::to_owned)
					.collect();
				let snapshot = self
					.parent
					.env
					.snapshot_workspace(env_pb::SnapshotWorkspace {
						scope: "workspace".to_owned(),
						paths,
						label: arguments
							.get("label")
							.and_then(Value::as_str)
							.map(str::to_owned),
						expected_generation: 0,
						wire_revision: omp_proto::SCHEMA_REV,
						props: Default::default(),
					})
					.await
					.map_err(|error| {
						ControlProtocolError::new("SnapshotUnsupported", error.to_string())
					})?;
				Ok(Self::snapshot_json(snapshot))
			},
			"omp.agents.snapshots" => {
				let list = self
					.parent
					.env
					.list_workspace_snapshots(env_pb::ListWorkspaceSnapshots {
						limit:         arguments
							.get("limit")
							.and_then(Value::as_u64)
							.unwrap_or(50)
							.min(u64::from(u32::MAX)) as u32,
						wire_revision: omp_proto::SCHEMA_REV,
						props:         Default::default(),
					})
					.await
					.map_err(|error| {
						ControlProtocolError::new("SnapshotUnsupported", error.to_string())
					})?;
				Ok(Value::Array(
					list
						.snapshots
						.into_iter()
						.map(Self::snapshot_json)
						.collect(),
				))
			},
			"omp.agents.restore" => {
				let snapshot_id = arguments
					.get("snapshot_id")
					.and_then(Value::as_str)
					.unwrap_or_default();
				let paths = arguments
					.get("paths")
					.and_then(Value::as_array)
					.into_iter()
					.flatten()
					.filter_map(Value::as_str)
					.map(str::to_owned)
					.collect();
				let restored = self
					.parent
					.env
					.restore_workspace(env_pb::RestoreWorkspace {
						snapshot_id: snapshot_id.to_owned(),
						dry_run: arguments
							.get("dry_run")
							.and_then(Value::as_bool)
							.unwrap_or(false),
						scope: "workspace".to_owned(),
						paths,
						expected_generation: 0,
						wire_revision: omp_proto::SCHEMA_REV,
						props: Default::default(),
					})
					.await
					.map_err(|error| {
						ControlProtocolError::new("SnapshotUnsupported", error.to_string())
					})?;
				Ok(Self::restore_json(restored))
			},
			operation => Err(Self::unavailable(operation, "Core agent-tree service")),
		}
	}

	async fn effect(
		&self,
		_context: control::ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		self.ensure_current()?;
		Err(ControlProtocolError::new(
			"unsupported_effect",
			"agents authority does not own CONTROL effects",
		))
	}
}

fn append_production_child_init(
	journal: &mut Journal,
	blob_store: &BlobStore,
	node: &omp_agent::AgentNode,
	definition: &omp_agent::AgentDefinition,
	snapshot: &AgentSnapshot,
	system_prompt: &str,
	output_schema: Option<&Value>,
	model_role: &str,
	child_root: &Path,
	isolation_id: Option<Str>,
) -> Result<(), ChildInitError> {
	let system_prompt = blob_store.put(system_prompt.as_bytes())?;
	let retry = snapshot.retry;
	let policy = serde_json::to_vec(&json!({
		"deferInterrupts": snapshot.defer_interrupts,
		"retry": {
			"maxAttempts": retry.max_attempts().get(),
			"initialBackoffMs": retry.initial_backoff().as_millis(),
			"maxBackoffMs": retry.max_backoff().as_millis(),
		},
	}))
	.map_err(ChildInitError::Schema)?;
	let policy_snapshot_ref = blob_store.put(&policy)?;
	let grants = serde_json::to_vec(&json!({
		"enabledTools": snapshot.enabled_tools.as_ref(),
	}))
	.map_err(ChildInitError::Schema)?;
	let grant_snapshot_ref = blob_store.put(&grants)?;
	let tools = inference_pb::ChatParams {
		tools: snapshot.turn.params.tools.clone(),
		..inference_pb::ChatParams::default()
	}
	.encode_to_vec();
	let tool_snapshot_ref = blob_store.put(&tools)?;
	let schema = output_schema
		.map(serde_json::to_string)
		.transpose()
		.map_err(ChildInitError::Schema)?;
	let schema_ref = schema
		.as_deref()
		.map(str::as_bytes)
		.map(|bytes| blob_store.put(bytes))
		.transpose()?;
	let output_schema = schema
		.map(RawValue::from_string)
		.transpose()
		.map_err(ChildInitError::Schema)?;
	let root_uri = Url::from_file_path(child_root)
		.map_err(|()| ChildInitError::WorkspaceRoot)?
		.to_string();
	let revival = omp_storage::transcript::ChildSessionInit {
		display_name: node.name.clone(),
		parent_id: node.parent.clone().unwrap_or_default(),
		definition: definition.name.clone(),
		depth: node.depth,
		prompt_ref: system_prompt,
		schema_ref,
		policy_snapshot_ref,
		grant_snapshot_ref,
		tool_snapshot_ref,
		model_role: Str::new(model_role),
		workspace: omp_storage::transcript::ChildWorkspaceIdentity {
			root_uri: Str::new(root_uri),
			isolation_id,
			revision: None,
		},
		serving_model: None,
	};
	journal.append_child_init(
		now_ms(),
		system_prompt,
		snapshot.enabled_tools.iter().cloned().collect(),
		output_schema,
		revival,
	)?;
	Ok(())
}

fn bridge_outcome_text(outcome: &inference_pb::Outcome) -> String {
	let mut text = String::new();
	for item in &outcome.output {
		if let Some(item::Kind::Message(message)) = &item.kind {
			for part in &message.parts {
				if let Some(part::Kind::Text(value)) = &part.kind {
					text.push_str(value);
				}
			}
		}
	}
	text
}
fn suppress_eval_spawn_guidance(params: &mut inference_pb::ChatParams) {
	let mut snapshot = omp_tools::eval::TaskDescriptionSnapshot::standard();
	snapshot.agents = &[];
	let description = omp_tools::eval::task_description(snapshot);
	if let Some(tool) = params.tools.iter_mut().find(|tool| tool.name == "eval") {
		tool.description = description.to_string();
	}
}

fn completion_usage(outcome: &inference_pb::Outcome, wall: Duration) -> Value {
	let usage = outcome.usage.as_ref();
	json!({
		"input_tokens": usage.map_or(0, |usage| usage.input_tokens),
		"cached_input_tokens": usage.map_or(0, |usage| usage.cache_read_tokens),
		"output_tokens": usage.map_or(0, |usage| usage.output_tokens),
		"reasoning_tokens": usage.map_or(0, |usage| usage.reasoning_tokens.unwrap_or_default()),
		"cache_write_tokens": usage.map_or(0, |usage| usage.cache_write_tokens),
		"requests": 1,
		"cost_usd": outcome.cost.as_ref().map_or(0.0, |cost| cost.nanos_usd as f64 / 1_000_000_000.0),
		"wall_ms": wall.as_millis().min(u128::from(u64::MAX)) as u64,
	})
}

fn retain_security_review_result(
	definition: &omp_agent::AgentDefinition,
	data: Option<&Value>,
	root: &Path,
	blobs: &BlobStore,
	id: &str,
) -> Result<Option<(Value, Str, Str)>, BridgeHostError> {
	if definition.name != profile::PROFILE_ID {
		return Ok(None);
	}
	let Some(data) = data else {
		return Ok(None);
	};
	let scope = ReviewScope::resolve(root, None)
		.map_err(|error| BridgeHostError::message(error.to_string()))?;
	let validated = validate_and_retain(data.clone(), &scope, sf!("agent://{}", id), blobs)
		.map_err(|error| BridgeHostError::message(error.to_string()))?;
	let data = serde_json::to_value(validated.output)
		.map_err(|error| BridgeHostError::message(error.to_string()))?;
	Ok(Some((data, validated.report, validated.artifact_uri)))
}

impl<C: TurnClient + Clone + Send + 'static> ChatParentHost<C> {
	async fn complete_auxiliary_model(
		&self,
		model: &str,
		system_prompt: &str,
		input: &str,
	) -> Result<Option<Str>, Str> {
		let context = self.context.lock().clone();
		let mut params = context.state.snapshot().turn.params.clone();
		params.tools.clear();
		params.tool_choice = None;
		params.response_format = None;
		params.model = model.to_owned();
		let options = TurnOptions {
			context_id: None,
			params,
			executor: None,
			props: None,
			provider_reset: false,
			stream_watchdog: omp_agent::StreamWatchdog::default(),
		};
		let items =
			vec![bridge_message(Role::System, system_prompt), bridge_message(Role::User, input)];
		let mut turn = self
			.client
			.turn(
				TurnId::new(format!("auxiliary-{}", omp_core::Ulid::generate())),
				TurnInput::Full(Thread { items }),
				&options,
			)
			.await
			.map_err(|error| Str::from(error.to_string()))?;
		let mut events = turn.events();
		while let Some(event) = events.next().await {
			let event = event.map_err(|error| Str::from(error.to_string()))?;
			match event.event {
				Some(turn_event::Event::Outcome(outcome)) => {
					return Ok(Some(Str::from(bridge_outcome_text(&outcome))));
				},
				Some(turn_event::Event::Error(error)) => return Err(Str::from(error.detail)),
				_ => {},
			}
		}
		Ok(None)
	}

	async fn complete_auxiliary_text(
		&self,
		role: &str,
		system_prompt: &str,
		input: &str,
	) -> Result<Option<Str>, Str> {
		self
			.complete_auxiliary_model(&format!("@{role}"), system_prompt, input)
			.await
	}

	async fn classify_turn_difficulty(&self, input: &str) -> Effort {
		let settings = *self.auto_thinking.lock();
		let auto = settings.for_turn();
		let selector = self
			.discovery_model_settings
			.lock()
			.as_ref()
			.map(|settings| settings.model.auto_thinking_selector.clone())
			.unwrap_or_else(|| sf!("@tiny"));
		let decision = match settings.backend {
			omp_inference::DifficultyBackend::Online => {
				let classified = self
					.difficulty_classifier
					.classify_online(input, auto, |request| {
						let selector = selector.clone();
						async move {
							self
								.complete_auxiliary_model(
									selector.as_str(),
									request.instruction.as_str(),
									request.input.as_str(),
								)
								.await
								.and_then(|answer| {
									answer.ok_or_else(|| Str::new_static("classifier-empty-output"))
								})
								.map_err(|message| {
									omp_inference::OnlineDifficultyError::new(message, false)
								})
						}
					});
				match time::timeout(Duration::from_secs(4), classified).await {
					Ok(decision) => decision,
					Err(_) => self.difficulty_classifier.fallback(
						input,
						omp_inference::DifficultyBackend::Online,
						auto,
					),
				}
			},
			omp_inference::DifficultyBackend::Local => self.difficulty_classifier.fallback(
				input,
				omp_inference::DifficultyBackend::Local,
				auto,
			),
		};
		decision.level.effort()
	}
}

impl<C: TurnClient + Clone + Send + Sync + 'static> omp_agent::TurnDifficultyClassifier
	for ChatParentHost<C>
{
	fn classify<'a>(
		&'a self,
		user_text: &'a str,
	) -> Pin<Box<dyn Future<Output = Effort> + Send + 'a>> {
		Box::pin(self.classify_turn_difficulty(user_text))
	}
}

impl<C: TurnClient + Clone + Send + 'static> OnlineTitleCompletion for ChatParentHost<C> {
	fn complete_title<'a>(
		&'a self,
		roles: &'static [&'static str],
		system_prompt: &'a str,
		input: &'a str,
	) -> Pin<Box<dyn Future<Output = Result<Option<Str>, Str>> + Send + 'a>> {
		let role = roles.first().copied().unwrap_or("tiny");
		Box::pin(self.complete_auxiliary_text(role, system_prompt, input))
	}
}

impl<C: TurnClient + Clone + Send + 'static> UnexpectedStopClassifier for ChatParentHost<C> {
	fn should_continue<'a>(
		&'a self,
		text: &'a str,
	) -> Pin<Box<dyn Future<Output = Result<bool, Str>> + Send + 'a>> {
		const PROMPT: &str = "Classify whether the assistant stopped while promising or starting \
		                      unfinished work. Return exactly CONTINUE when another turn is needed, \
		                      otherwise return exactly STOP.";
		Box::pin(async move {
			Ok(self
				.complete_auxiliary_text("tiny", PROMPT, text)
				.await?
				.is_some_and(|answer| answer.trim().eq_ignore_ascii_case("CONTINUE")))
		})
	}
}
/// Starts the typed edit auto-repair consumer on the smol role.
pub fn spawn_edit_repair_service<C>(
	parent: Arc<ChatParentHost<C>>,
	requests: flume::Receiver<omp_tools::edit::observer::EditRepairRequest>,
) -> JoinHandle<()>
where
	C: TurnClient + Clone + Send + 'static,
{
	tokio::spawn(async move {
		while let Ok(request) = requests.recv_async().await {
			let input = request.prompt.render();
			let result = parent
				.complete_auxiliary_text(
					"smol",
					"Follow the repair request exactly and return code only.",
					input.as_str(),
				)
				.await
				.map_err(|message| omp_tools::edit::observer::EditRepairError::Completion { message })
				.and_then(|answer| {
					answer.ok_or_else(|| omp_tools::edit::observer::EditRepairError::Completion {
						message: sf!("edit repair model returned no source"),
					})
				});
			let _ = request.reply.send_async(result).await;
		}
	})
}

#[async_trait]
impl<C: TurnClient + Clone + Send + 'static> ParentSessionHost for ChatParentHost<C> {
	fn eval_session_config(&self) -> Result<omp_envd::eval::EvalSessionConfig, BridgeHostError> {
		let context = self.context.lock();
		let session_root = context.sessions_dir.join(context.session_id.as_str());
		Ok(omp_envd::eval::EvalSessionConfig {
			cwd:              context.root.clone(),
			local_roots_json: Some(Str::from(
				json!({ "local": session_root.join("local").to_string_lossy() }).to_string(),
			)),
			artifacts_dir:    Some(Str::from(session_root.to_string_lossy().as_ref())),
			session_file:     Some(Str::from(
				context
					.sessions_dir
					.join(format!("{}.jsonl", context.session_id))
					.to_string_lossy()
					.as_ref(),
			)),
		})
	}

	async fn completion(
		&self,
		args: Value,
		_progress: &dyn omp_envd::eval::BridgeProgressSink,
	) -> Result<Value, BridgeHostError> {
		use omp_proto::thread::v1::blob;
		let started = Instant::now();
		let choices = args.get("choices").and_then(Value::as_array).map_or_else(
			smallvec::SmallVec::new,
			|values| {
				values
					.iter()
					.filter_map(Value::as_str)
					.map(Str::from)
					.collect()
			},
		);
		let completion = CompletionRequest {
			choices,
			default: args.get("default").and_then(Value::as_str).map(Str::from),
			max_usd_micros: None,
		};
		let prompt = args
			.get("prompt")
			.ok_or_else(|| BridgeHostError::message("completion prompt is required"))?;
		let user_parts = if let Some(text) = prompt.as_str() {
			vec![Part { kind: Some(omp_proto::thread::v1::part::Kind::Text(text.to_owned())) }]
		} else {
			let rows = prompt.as_array().ok_or_else(|| {
				BridgeHostError::message("completion prompt must be text or typed media parts")
			})?;
			let mut parts = Vec::with_capacity(rows.len());
			for row in rows {
				match row.get("kind").and_then(Value::as_str) {
					Some("text") => parts.push(Part {
						kind: Some(part::Kind::Text(
							row.get("text")
								.and_then(Value::as_str)
								.unwrap_or_default()
								.to_owned(),
						)),
					}),
					Some("blob") => {
						let blob = row.get("blob").and_then(Value::as_object).ok_or_else(|| {
							BridgeHostError::message("completion blob part omitted its blob reference")
						})?;
						let hash = blob
							.get("hash")
							.and_then(Value::as_str)
							.ok_or_else(|| {
								BridgeHostError::message("completion blob reference omitted its hash")
							})
							.and_then(|hash| {
								omp_core::hex::decode(hash)
									.into_vec()
									.map_err(|error| BridgeHostError::message(error.to_string()))
							})?;
						parts.push(Part {
							kind: Some(part::Kind::Blob(v1::Blob {
								hash:   hash.into(),
								mime:   String::new(),
								size:   blob.get("size").and_then(Value::as_u64).unwrap_or(0),
								inline: Default::default(),
								detail: blob::Detail::Auto as i32,
							})),
						});
						if let Some(alt) = row.get("alt").and_then(Value::as_str)
							&& !alt.is_empty()
						{
							parts.push(Part { kind: Some(part::Kind::Text(alt.to_owned())) });
						}
					},
					_ => {
						return Err(BridgeHostError::message(
							"completion prompt contains an unknown typed part",
						));
					},
				}
			}
			parts
		};
		let context = self.context.lock().clone();
		let snapshot = context.state.snapshot();
		let mut params = snapshot.turn.params.clone();
		params.tools.clear();
		params.tool_choice = None;
		params.model = match args
			.get("model")
			.and_then(Value::as_str)
			.unwrap_or("default")
		{
			"default" => params.model,
			model @ ("smol" | "slow") => format!("@{model}"),
			other => {
				return Err(BridgeHostError::message(format!(
					"unsupported completion model tier: {other}"
				)));
			},
		};
		if let Some(schema) = args.get("schema") {
			let schema_json = serde_json::to_vec(schema)
				.map_err(|error| BridgeHostError::message(error.to_string()))?;
			params.response_format = Some(inference_pb::ResponseFormat {
				kind:           Some(response_format::Kind::JsonSchema(response_format::JsonSchema {
					name:        "eval_completion".to_owned(),
					schema_json: schema_json.into(),
					strict:      Some(true),
				})),
				on_unsupported: inference_pb::Fallback::Error as i32,
			});
		}
		if let Some(max_output_tokens) = args.get("max_output_tokens").and_then(Value::as_u64) {
			params.sampling.get_or_insert_default().max_output_tokens = Some(max_output_tokens);
		}
		let mut items = Vec::new();
		if let Some(system) = args.get("system").and_then(Value::as_str) {
			items.push(bridge_message(Role::System, system));
		}
		items.push(Item {
			seq:           0,
			created_at_ms: now_ms(),
			kind:          Some(item::Kind::Message(Message {
				role:  i32::from(Role::User),
				parts: user_parts,
			})),
			props:         None,
		});
		let options = TurnOptions {
			context_id: None,
			params,
			executor: None,
			props: None,
			provider_reset: false,
			stream_watchdog: omp_agent::StreamWatchdog::default(),
		};
		let mut turn = self
			.client
			.turn(
				TurnId::new(format!("eval-completion-{}", omp_core::Ulid::generate())),
				TurnInput::Full(Thread { items }),
				&options,
			)
			.await
			.map_err(|error| BridgeHostError::message(error.to_string()))?;
		let mut events = turn.events();
		while let Some(event) = events.next().await {
			let event = event.map_err(|error| BridgeHostError::message(error.to_string()))?;
			match event.event {
				Some(turn_event::Event::Outcome(outcome)) => {
					let spent = outcome.usage.as_ref().map_or(0, |usage| {
						usage
							.output_tokens
							.saturating_add(usage.reasoning_tokens.unwrap_or_default())
					});
					self.context.lock().state.update(|snapshot| {
						if let Some(remaining) = snapshot
							.turn
							.params
							.task_budget
							.as_mut()
							.and_then(|budget| budget.remaining_tokens.as_mut())
						{
							*remaining = remaining.saturating_sub(spent);
						}
					});
					let text = Str::from(bridge_outcome_text(&outcome));
					let data = args
						.get("schema")
						.and_then(|_| serde_json::from_str::<Value>(text.as_str()).ok());
					let usage = completion_usage(&outcome, started.elapsed());
					let model = outcome.model.clone();
					let completion = resolve_completion(&completion, Ok(text))
						.map_err(|error| BridgeHostError::message(error.to_string()))?;
					return Ok(json!({
						"text": completion.text,
						"choice": completion.choice,
						"data": data,
						"usage": usage,
						"model": model,
						"fell_back": completion.fell_back,
						"fault": completion.fell_back.then(|| json!({"reason": "no_choice"})),
					}));
				},
				Some(turn_event::Event::Error(error)) => {
					let detail = error.detail;
					let completion = resolve_completion(
						&completion,
						Err(CompletionError::Provider(Str::from(&detail))),
					)
					.map_err(|error| BridgeHostError::message(error.to_string()))?;
					return Ok(json!({
						"text": completion.text,
						"choice": completion.choice,
						"data": null,
						"usage": {
							"input_tokens": 0,
							"cached_input_tokens": 0,
							"output_tokens": 0,
							"reasoning_tokens": 0,
							"cache_write_tokens": 0,
							"requests": 1,
							"cost_usd": 0.0,
							"wall_ms": started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
						},
						"model": "",
						"fell_back": completion.fell_back,
						"fault": {"reason": "provider", "detail": detail},
					}));
				},
				_ => {},
			}
		}
		Err(BridgeHostError::message("completion turn ended without an outcome"))
	}

	async fn agent(
		&self,
		args: Value,
		progress: &dyn omp_envd::eval::BridgeProgressSink,
	) -> Result<Value, BridgeHostError> {
		let mut request = SpawnRequestV1::from_bridge_args(&args)
			.map_err(|error| BridgeHostError::message(error.to_string()))?;
		if let Some(plan) = self.approved_plan_reference() {
			request.prompt = sf!(
				"{}\n\nApproved overall plan: {}. Read and follow only this approved plan reference; \
				 do not consume drafts.",
				request.prompt,
				plan.artifact
			);
		}
		let prompt = request.prompt.as_str();
		let kind = request.agent.as_str();
		let context = self.context.lock().clone();
		let task_settings = context.task_settings.snapshot();
		let definition = context
			.definitions
			.iter()
			.find(|(name, _)| name.as_str().eq_ignore_ascii_case(kind))
			.map(|(_, definition)| definition.clone())
			.ok_or_else(|| {
				BridgeHostError::message(format!(
					"agent type '{kind}' is not available in this session"
				))
			})?;
		if task_settings
			.disabled_agents
			.iter()
			.any(|name| name.as_str().eq_ignore_ascii_case(definition.name.as_str()))
		{
			return Err(BridgeHostError::message("requested agent is disabled by live task settings"));
		}
		let session_schema = context
			.state
			.snapshot()
			.turn
			.params
			.response_format
			.as_ref()
			.and_then(|format| format.kind.as_ref())
			.and_then(|kind| match kind {
				response_format::Kind::JsonSchema(schema) => {
					serde_json::from_slice(&schema.schema_json).ok()
				},
				response_format::Kind::Grammar(_) => None,
			});
		let schema_resolution = omp_agent::resolve_output_schema(
			request.output_schema.as_ref(),
			definition.output_schema.as_ref(),
			session_schema.as_ref(),
		);
		request.output_schema = schema_resolution.schema;
		if definition.name == profile::PROFILE_ID {
			if !profile::is_canonical(&definition) {
				return Err(BridgeHostError::message(
					"security reviewer profile authority was widened",
				));
			}
			if request.isolation.requested || request.isolation.apply || request.isolation.merge {
				return Err(BridgeHostError::message(
					"local security reviews use the current workspace",
				));
			}
			request.output_schema = definition.output_schema.clone();
			request.schema_mode = SpawnSchemaMode::Strict;
			request.enable_lsp = true;
		}
		let explicit_patch = request.isolation.apply;
		let explicit_branch = request.isolation.merge;
		let isolated =
			request.isolation.requested || task_settings.isolation.mode != TaskIsolationMode::None;
		let auto_apply =
			isolated && !explicit_patch && !explicit_branch && task_settings.isolation.apply;
		let apply = explicit_patch
			|| (auto_apply && task_settings.isolation.merge == TaskIsolationMerge::Patch);
		let merge = explicit_branch
			|| (auto_apply && task_settings.isolation.merge == TaskIsolationMerge::Branch);
		let id = request
			.stable_id
			.clone()
			.unwrap_or_else(|| Str::from(omp_core::Ulid::generate().to_string()));
		let mut display_name = request
			.name
			.clone()
			.or_else(|| context.tree.node(id.as_str()).map(|node| node.name.clone()))
			.unwrap_or_else(|| id.clone());
		let security_follow_up = context
			.tree
			.node(id.as_str())
			.and_then(|node| node.definition.clone())
			.is_some_and(|name| name == profile::PROFILE_ID);
		if security_follow_up && definition.name != profile::PROFILE_ID {
			return Err(BridgeHostError::message(
				"security reviewer follow-up must retain its canonical profile",
			));
		}
		progress.progress(json!({
			"op": "agent",
			"id": id,
			"name": display_name,
			"agent": kind,
			"status": "running",
		}))?;
		if self.supervisor.state(&id).is_some() {
			if request.isolation.requested || explicit_patch || explicit_branch {
				return Err(BridgeHostError::message(
					"follow-up turns retain their existing workspace disposition",
				));
			}
			let summary = self
				.run_eval_agent(
					id.as_str(),
					vec![bridge_message(Role::User, prompt)],
					TurnId::new(format!("eval-agent-followup-{}", omp_core::Ulid::generate())),
				)
				.await?;
			let (mut text, mut data, schema_status) = self
				.validate_agent_summary(
					id.as_str(),
					request.output_schema.clone(),
					matches!(request.schema_mode, omp_envd::eval::spawn::SpawnSchemaMode::Strict),
					summary,
				)
				.await?;
			let blob_root = context
				.sessions_dir
				.parent()
				.unwrap_or(context.sessions_dir.as_path());
			let blob_store = BlobStore::open(blob_root)
				.map_err(|error| BridgeHostError::message(error.to_string()))?;
			let mut security_artifact = None;
			if let Some((validated, report, artifact)) = retain_security_review_result(
				&definition,
				data.as_ref(),
				&context.root,
				&blob_store,
				id.as_str(),
			)? {
				data = Some(validated);
				text = report.to_string();
				security_artifact = Some(artifact);
			}
			let artifact_dir = context.sessions_dir.join(context.session_id.as_str());
			let artifact = artifact_dir.join(format!("{id}.md"));
			let bounded = persist_bounded(&artifact, sf!("agent://{}", id), &text, None, false)
				.map_err(|error| BridgeHostError::message(error.to_string()))?;
			let visible_text = bounded.preview.unwrap_or_default();
			progress.progress(json!({
				"op": "agent",
				"id": id,
				"name": display_name,
				"agent": kind,
				"status": if schema_status.is_some() && data.is_none() { "failed" } else { "completed" },
			}))?;
			return Ok(json!({
							"text": visible_text,
							"data": data,
							"schema": schema_status,
							"handle": format!("agent://{id}"),
							"details": {
								"id": id,
								"name": display_name,
								"agent": kind,
								"followUp": true,
								"output": format!("agent://{id}"),
												"artifact": security_artifact,
			},
						}));
		}
		if context
			.state
			.snapshot()
			.turn
			.params
			.task_budget
			.is_some_and(|budget| budget.remaining_tokens == Some(0))
		{
			return Err(BridgeHostError::message(
				"hard turn token budget is exhausted; subagent spawn refused",
			));
		}
		let directory = context.sessions_dir.join("eval-agents");
		let (worktree_id, child_root, isolated_state, isolated_environment) = if isolated {
			let created = self
				.env
				.create_worktree(env_pb::CreateWorktree {
					name: id.to_string(),
					owner_pid: process::id(),
					..Default::default()
				})
				.await
				.map_err(|error| BridgeHostError::message(error.to_string()))?;
			let worktree = created.worktree.ok_or_else(|| {
				BridgeHostError::message("Environment omitted the created worktree identity")
			})?;
			let root_url = Url::parse(&worktree.root_uri)
				.map_err(|error| BridgeHostError::message(error.to_string()))?;
			let root = root_url.to_file_path().map_err(|()| {
				BridgeHostError::message("Environment returned a non-file worktree root")
			})?;
			let child_state = context
				.sessions_dir
				.join("eval-agents")
				.join(format!("{id}-env"));
			let environment = omp_envd::ProjectEnvironment::isolated(
				&root,
				&child_state,
				omp_envd::RegistryBridges::default(),
			)
			.await
			.map_err(|error| BridgeHostError::message(error.to_string()))?;
			(Some(Str::from(worktree.id)), root, Some(child_state), Some(environment))
		} else {
			(None, context.root.clone(), None, None)
		};
		let child_budget = context
			.state
			.snapshot()
			.turn
			.params
			.task_budget
			.and_then(|budget| budget.remaining_tokens)
			.map_or_else(Budget::default, |remaining| Budget {
				max_output_tokens: Some(remaining),
				..Budget::default()
			});
		let parent_id = context
			.tree
			.node(
				args
					.get("_parentId")
					.and_then(Value::as_str)
					.unwrap_or(context.session_id.as_str()),
			)
			.or_else(|| context.tree.node(context.session_id.as_str()))
			.map(|parent| parent.id.clone())
			.ok_or_else(|| {
				BridgeHostError::message("parent agent is not registered for subagent admission")
			})?;
		let node = context
			.tree
			.register_child(
				id.clone(),
				request.name.as_deref(),
				&definition,
				parent_id,
				context.session_id.clone(),
				child_budget,
			)
			.map_err(|error| BridgeHostError::message(error.to_string()))?;
		display_name = node.name.clone();
		fs::create_dir_all(&directory)
			.map_err(|error| BridgeHostError::message(error.to_string()))?;
		let parent = SessionId(context.session_id.clone());
		let journal_path = directory.join(format!("{id}.jsonl"));
		let mut journal = create_indexed_journal(
			&journal_path,
			&context.root,
			&id,
			Arc::clone(&context.session_index),
			SessionKind::Subagent,
			Some(&parent),
		)
		.map_err(|error| BridgeHostError::message(error.to_string()))?;
		let parent_snapshot = context.state.snapshot();
		let selected_model = definition.effective_model(&task_settings.agent_model_overrides);
		let inherited_pattern = parent_snapshot.turn.params.model.as_str();
		let prewalk = PrewalkGate::resolve(&definition, &task_settings);
		let inference_role = sf!("subagent:{}", id);
		let security_task_settings = (definition.name == profile::PROFILE_ID).then(|| {
			let mut settings = task_settings.as_ref().clone();
			settings.enable_lsp = true;
			settings
		});
		let child_settings = security_task_settings
			.as_ref()
			.unwrap_or(task_settings.as_ref());

		let mut child_snapshot = child_snapshot(parent_snapshot.as_ref(), ChildSnapshotOptions {
			definition: &definition,
			settings: child_settings,
			cwd: &child_root,
			selected_model,
			inference_role: Some(inference_role.as_str()),
			inherited_pattern: Some(inherited_pattern),
			caller_effort: request.effort,
			model_ceiling: None,
			plan_mode: false,
			enable_lsp: request.enable_lsp,
			prewalk_gate: prewalk.armed(),
		});
		let child_can_spawn = child_settings.max_recursion_depth == -1
			|| i32::from(node.depth) < i32::from(child_settings.max_recursion_depth);
		if !child_can_spawn {
			suppress_eval_spawn_guidance(&mut child_snapshot.turn.params);
		}
		let child_env = isolated_environment.as_ref().map_or_else(
			|| {
				self
					.env
					.with_principal(context.session_id.clone(), id.clone())
					.expect("validated child identity is a valid Environment principal")
			},
			|environment| {
				environment
					.client()
					.with_principal(context.session_id.clone(), id.clone())
					.expect("validated child identity is a valid Environment principal")
			},
		);
		let child_content = match self.discovery_model_settings.lock().as_ref() {
			Some(settings) => {
				let home = env::var_os("HOME")
					.map(PathBuf::from)
					.unwrap_or_else(|| child_root.clone());
				discovery::active_prompt_snapshots(&child_root, &[], &home, settings).content
			},
			None => discovery::active_content_snapshots(&child_root),
		};
		let (child_ttsr, child_ttsr_diagnostics) =
			rulebook::ttsr_registry(child_content.rules.as_ref());
		for error in child_ttsr_diagnostics {
			tracing::warn!(%error, agent = %id, "subagent TTSR rule condition was rejected");
		}
		let peer_values = context
			.tree
			.roster()
			.map(|node| peer_from_node(node))
			.collect::<Vec<_>>();
		let peers = peer_values
			.iter()
			.map(|(name, role, status, activity)| PromptPeer {
				name:     name.as_str(),
				role:     role.as_str(),
				status:   status.as_str(),
				activity: activity.as_str(),
			})
			.collect::<Vec<_>>();
		let model = selected_model.unwrap_or(inherited_pattern);
		let codex_style = {
			let model = model.to_ascii_lowercase();
			model.contains("codex") || model.contains("gpt-5")
		};
		let prompt_input = SubagentPromptInput {
			definition:        &definition,
			shared_context:    None,
			plan_path:         None,
			plan_content:      None,
			workspace_root:    &child_root,
			output_schema:     request.output_schema.as_ref(),
			self_name:         node.name.as_str(),
			self_role:         definition.name.as_str(),
			irc_enabled:       child_can_spawn,
			roster_generation: context.tree.roster_generation(),
			peers:             &peers,
			capabilities:      ModelFamilyCapabilities {
				codex_style,
				parallel_tool_calls: true,
				structured_yield: request.output_schema.is_some(),
			},
			plan_mode:         false,
			eager:             task_settings.eager,
		};
		child_snapshot.props = props(&prompt_input, &parent_snapshot.props);
		let system_prompt = compose(prompt_input, &parent_snapshot.props);
		let blob_root = context
			.sessions_dir
			.parent()
			.unwrap_or(context.sessions_dir.as_path());
		let blob_store =
			BlobStore::open(blob_root).map_err(|error| BridgeHostError::message(error.to_string()))?;
		append_production_child_init(
			&mut journal,
			&blob_store,
			node.as_ref(),
			&definition,
			&child_snapshot,
			system_prompt.as_str(),
			request.output_schema.as_ref(),
			model,
			&child_root,
			worktree_id.clone(),
		)
		.map_err(|error| BridgeHostError::message(error.to_string()))?;
		let mut child = Agent::new(
			self.client.clone(),
			child_env.clone(),
			AgentState::new(child_snapshot.clone()),
			journal,
			CHAT_CAPS_BASE,
		);
		self.bind_host_control(id.clone(), child.host_control());
		child.set_ttsr_registry(child_ttsr);
		let control_binding = if let Some(environment) = &isolated_environment {
			let binding = environment
				.bind_agent_control(child.control())
				.map_err(|error| BridgeHostError::message(error.to_string()))?;
			environment.bind_device_availability(child.mailbox());
			Some(binding)
		} else {
			None
		};
		let inbox = self
			.broker
			.register(&node, child.mailbox())
			.map_err(|error| BridgeHostError::message(error.to_string()))?;
		let inbox = hub_backend::share_inbox(inbox);
		self.bind_inbox(id.clone(), Arc::clone(&inbox));
		let _ = self.broker.registry().set_history(
			id.as_str(),
			Some(journal_path.clone()),
			Some(Str::from(model)),
			Some(deterministic_task_summary(prompt)),
			omp_agent::AgentHistory::default(),
		);
		let hub = hub_backend::attach_for(
			id.clone(),
			Arc::new(hub_backend::ChatHubBackend::new(
				self.broker.clone(),
				inbox,
				Arc::clone(child.jobs()),
				child_env.clone(),
				id.clone(),
				context.session_id.clone(),
				None,
				Some(self.supervisor.clone()),
			)),
		);
		let mut runtime = SupervisedRuntime::new(child);
		if let Some(binding) = control_binding {
			runtime.retain(binding);
		}
		runtime.retain(hub);
		if let Some(environment) = isolated_environment {
			runtime.retain(environment);
		}
		let reviver: Arc<dyn ChildReviver<C>> = Arc::new(ProductionChildReviver {
			client: self.client.clone(),
			base_env: self.env.clone(),
			broker: self.broker.clone(),
			supervisor: Arc::clone(&self.supervisor),
			node: Arc::clone(&node),
			snapshot: child_snapshot,
			journal_path,
			project_root: context.root.clone(),
			workspace_root: child_root.clone(),
			isolated_state,
			session_index: Arc::clone(&context.session_index),
			parent_session: parent,
			inboxes: Arc::clone(&self.inboxes),
			controls: Arc::clone(&self.controls),
			discovery_model_settings: self.discovery_model_settings.lock().clone(),
		});
		self
			.supervisor
			.register(Arc::clone(&node), runtime, Some(reviver))
			.map_err(|error| BridgeHostError::message(error.to_string()))?;
		self.ensure_revival_transport(&id);
		let summary = self
			.run_eval_agent(
				id.as_str(),
				vec![
					bridge_message(Role::System, system_prompt.as_str()),
					bridge_message(Role::User, prompt),
				],
				TurnId::new(format!("eval-agent-{}", omp_core::Ulid::generate())),
			)
			.await?;
		let (mut text, mut data, schema_status) = self
			.validate_agent_summary(
				id.as_str(),
				request.output_schema.clone(),
				matches!(request.schema_mode, omp_envd::eval::spawn::SpawnSchemaMode::Strict),
				summary,
			)
			.await?;
		let mut security_artifact = None;
		if let Some((validated, report, artifact)) = retain_security_review_result(
			&definition,
			data.as_ref(),
			&child_root,
			&blob_store,
			id.as_str(),
		)? {
			data = Some(validated);
			text = report.to_string();
			security_artifact = Some(artifact);
		}
		let mut disposition = None;
		let mut disposition_conflict = None;
		if let Some(worktree_id) = worktree_id.as_ref()
			&& (apply || merge)
		{
			let mode = if apply {
				env_pb::MergeMode::Patch
			} else {
				env_pb::MergeMode::Branch
			};
			let merged = self
				.env
				.merge_worktree(env_pb::MergeWorktree {
					id: worktree_id.to_string(),
					mode: mode as i32,
					..Default::default()
				})
				.await
				.map_err(|error| BridgeHostError::message(error.to_string()))?;
			let mut conflicts = merged.conflicts;
			conflicts.sort_by(|left, right| {
				left
					.path
					.cmp(&right.path)
					.then_with(|| left.reason.cmp(&right.reason))
					.then_with(|| left.detail.cmp(&right.detail))
			});
			let artifact_hash = (!merged.artifact_hash.is_empty())
				.then(|| omp_core::hex::encode(&merged.artifact_hash).into_string());
			let artifact_uri = artifact_hash
				.as_deref()
				.map(|hash| sf!("artifact://sha256/{}", hash));
			let conflict_count = conflicts.len();
			let conflict_facts = conflicts
				.iter()
				.take(32)
				.map(|conflict| {
					json!({
						"path": conflict.path.as_str(),
						"reason": env_pb::ConflictReason::try_from(conflict.reason)
							.unwrap_or(env_pb::ConflictReason::Unspecified)
							.as_str_name(),
						"detail": conflict.detail.as_deref(),
					})
				})
				.collect::<Vec<_>>();
			disposition = Some(json!({
				"mode": if apply { "patch" } else { "branch" },
				"status": if conflict_count == 0 { "ready" } else { "conflict" },
				"artifact": artifact_uri.as_deref(),
				"artifactHash": artifact_hash.as_deref(),
				"artifactSize": merged.artifact_size,
				"branch": merged.branch.as_deref(),
				"conflictCount": conflict_count,
				"conflicts": conflict_facts,
				"conflictsTruncated": conflict_count > 32,
			}));
			if conflict_count != 0 {
				let recovery = deterministic_isolation_recovery(
					id.as_str(),
					artifact_uri.as_deref(),
					merged.branch.as_deref(),
					&conflicts,
				);
				text.push_str("\n\n");
				text.push_str(recovery.as_str());
				disposition_conflict = Some((recovery, artifact_uri, merged.branch));
			}
		}
		let artifact_dir = context.sessions_dir.join(context.session_id.as_str());
		let artifact = artifact_dir.join(format!("{id}.md"));
		let bounded =
			persist_bounded(&artifact, sf!("agent://{}", id), &text, worktree_id.clone(), false)
				.map_err(|error| BridgeHostError::message(error.to_string()))?;
		let visible_text = bounded.preview.unwrap_or_default();
		let disposition_failed = disposition_conflict.is_some();
		if let Some((summary, artifact_uri, branch)) = disposition_conflict {
			if let Some((record, _)) = self.broker.registry().record(id.as_str()) {
				let mut history = record.history;
				history.output_path = Some(artifact.clone());
				history.branch = branch.map(Str::from);
				let _ = self.broker.registry().set_history(
					id.as_str(),
					record.transcript,
					record.model,
					record.task,
					history,
				);
			}
			let _ = self
				.broker
				.registry()
				.set_terminal(id.as_str(), SubagentTerminalStatus {
					kind:        SubagentTerminalKind::Failed,
					summary:     summary.clone(),
					disposition: SubagentDisposition {
						artifact_uri,
						preview: Some(summary),
						truncated: false,
						workspace: worktree_id.clone(),
					},
				});
		}
		progress.progress(json!({
			"op": "agent",
			"id": id,
			"name": display_name,
			"agent": kind,
			"status": if schema_status.is_some() && data.is_none() || disposition_failed {
				"failed"
			} else {
				"completed"
			},
		}))?;
		Ok(json!({
					"text": visible_text,
					"data": data,
					"schema": schema_status,
					"handle": format!("agent://{id}"),
					"details": {
						"id": id,
						"name": display_name,
						"agent": kind,
						"blocking": definition.blocking,
						"isolated": isolated,
						"worktree": worktree_id,
						"root": isolated.then(|| child_root.to_string_lossy().into_owned()),
						"disposition": disposition,
						"output": format!("agent://{id}"),
									"artifact": security_artifact,
		},
				}))
	}

	async fn concurrency(&self, _args: Value) -> Result<Value, BridgeHostError> {
		let context = self.context.lock();
		Ok(json!({ "limit": context.tree.max_concurrency() }))
	}

	async fn budget(&self, _args: Value) -> Result<Value, BridgeHostError> {
		let context = self.context.lock();
		let budget = context.state.snapshot().turn.params.task_budget;
		let Some(budget) = budget else {
			return Ok(json!({ "total": null, "spent": 0, "hard": false }));
		};
		let remaining = budget.remaining_tokens.unwrap_or(budget.total_tokens);
		Ok(json!({
			"total": budget.total_tokens,
			"spent": budget.total_tokens.saturating_sub(remaining),
			"hard": budget.remaining_tokens.is_some(),
		}))
	}
}

/// Application seam which owns mutable provider declarations and typed media
/// request settlement while exposing its current immutable inference registry.
#[async_trait]
pub trait ProviderApplicationOwner: Send + Sync + 'static {
	/// Loads the current registry generation after any catalog swap.
	fn registry(&self) -> InferenceRegistry;

	/// Atomically compiles and publishes one caller-owned declaration.
	async fn replace_provider(
		&self,
		identity: &ControlConnectionIdentity,
		declaration: ProviderDeclarationDocument,
	) -> Result<(), ProviderControlError>;

	/// Retracts one caller-owned declaration and publishes a new generation.
	async fn retract_provider(
		&self,
		identity: &ControlConnectionIdentity,
		provider: &str,
	) -> Result<(), ProviderControlError>;

	/// Routes a typed request through the application inference/data facade.
	async fn provider_request(
		&self,
		identity: &ControlConnectionIdentity,
		request: ProviderControlRequest,
	) -> Result<ProviderControlResult, ProviderControlError>;
}

/// Provider CONTROL backend over the application's live inference owner.
pub struct ChatProviderControlBackend {
	owner: Arc<dyn ProviderApplicationOwner>,
}

impl ChatProviderControlBackend {
	/// Binds the one application provider owner.
	pub fn new(owner: Arc<dyn ProviderApplicationOwner>) -> Self {
		Self { owner }
	}

	fn cursor(registry: &InferenceRegistry) -> ProviderCatalogCursor {
		ProviderCatalogCursor {
			epoch:      registry.catalog_revision().as_str().as_bytes().into(),
			generation: registry.generation(),
		}
	}

	fn provider_for_model<'a>(
		catalog: &'a snapshot::Catalog,
		model: &omp_catalog::ModelSpec,
	) -> Option<&'a omp_catalog::ProviderDef> {
		catalog.providers().iter().find(|provider| {
			model
				.routes
				.iter()
				.any(|route| provider.routes.iter().any(|candidate| candidate == route))
		})
	}

	fn model_card(
		catalog: &snapshot::Catalog,
		model: &omp_catalog::ModelSpec,
		provider: &omp_catalog::ProviderDef,
	) -> ProviderModelCard {
		use omp_catalog::capability::{Availability, ModalityBits};
		let mut facets = Vec::new();
		if model.capabilities.chat.is_some() {
			facets.push(Str::new_static("chat"));
		}
		if model.capabilities.embeddings.is_some() {
			facets.push(Str::new_static("embed"));
		}
		if model.capabilities.image.is_some() {
			facets.push(Str::new_static("image_gen"));
		}
		if model.capabilities.video.is_some() {
			facets.push(Str::new_static("video_gen"));
		}
		if model.capabilities.speech.is_some() {
			facets.push(Str::new_static("speak"));
		}
		if model.capabilities.transcription.is_some() {
			facets.push(Str::new_static("transcribe"));
		}
		if model.capabilities.realtime.is_some() {
			facets.push(Str::new_static("realtime"));
		}
		if model.capabilities.search.is_some() {
			facets.push(Str::new_static("search"));
		}
		let inputs = model
			.capabilities
			.chat
			.as_ref()
			.and_then(|chat| chat.input_modalities.constraints())
			.map_or_else(Vec::new, |modalities| {
				[
					(ModalityBits::TEXT, "text"),
					(ModalityBits::IMAGE, "image"),
					(ModalityBits::AUDIO, "audio"),
					(ModalityBits::VIDEO, "video"),
					(ModalityBits::DOCUMENT, "document"),
				]
				.into_iter()
				.filter_map(|(bit, name)| modalities.contains(bit).then_some(Str::new_static(name)))
				.collect()
			});
		let mut outputs = Vec::new();
		if model.capabilities.chat.is_some() {
			outputs.push(Str::new_static("text"));
		}
		if model.capabilities.image.is_some() {
			outputs.push(Str::new_static("image"));
		}
		if model.capabilities.video.is_some() {
			outputs.push(Str::new_static("video"));
		}
		if model.capabilities.speech.is_some() {
			outputs.push(Str::new_static("audio"));
		}
		let supports_tools = model
			.capabilities
			.chat
			.as_ref()
			.and_then(|chat| matches!(chat.tools, Availability::Unsupported).then_some(false));
		let source = model
			.provenance
			.sources
			.last()
			.map_or(1, |source| match source.kind {
				ProvenanceKind::Bundled => 1,
				ProvenanceKind::Discovered => 2,
				ProvenanceKind::Configured => 3,
			});
		let efforts = model
			.thinking
			.as_ref()
			.and_then(|policy| catalog.thinking_policy(policy))
			.map_or_else(Vec::new, |policy| {
				policy
					.efforts
					.iter()
					.map(|effort| Str::from(effort.to_string()))
					.collect()
			});
		ProviderModelCard {
			id: model.key.as_str().into(),
			provider: provider.id.as_str().into(),
			model: model.key.as_str().into(),
			name: model.display_name.clone(),
			family: Some(model.class.as_str().into()),
			facets: facets.into_boxed_slice(),
			inputs: inputs.into_boxed_slice(),
			outputs: outputs.into_boxed_slice(),
			reasoning: model.thinking.is_some(),
			efforts: efforts.into_boxed_slice(),
			context_window: model.limits.context_window,
			max_output_tokens: model.limits.maximum_output_tokens,
			pricing: model
				.pricing
				.components
				.iter()
				.map(|price| ProviderPrice {
					unit:      price.unit.to_string().into(),
					nanos_usd: price.nanos_usd,
				})
				.collect(),
			availability: model.availability.to_string().into(),
			source,
			blocked_until_ms: model.provenance.blocked_until_ms,
			deprecated: model.provenance.deprecated,
			updated_at_ms: model.provenance.updated_at_ms,
			supports_tools,
			props: serde_json::Map::new(),
		}
	}
}

#[async_trait]
impl ProviderControlBackend for ChatProviderControlBackend {
	async fn models(
		&self,
		provider: Option<&str>,
	) -> Result<Vec<ProviderModelCard>, ProviderControlError> {
		let registry = self.owner.registry();
		let catalog = registry.catalog();
		if provider.is_some_and(|provider| {
			!catalog
				.providers()
				.iter()
				.any(|candidate| candidate.id.as_str() == provider)
		}) {
			return Err(ProviderControlError::NotFound);
		}
		Ok(catalog
			.models()
			.iter()
			.filter_map(|model| {
				let owner = Self::provider_for_model(catalog, model)?;
				if provider.is_none_or(|provider| provider == owner.id.as_str()) {
					Some(Self::model_card(catalog, model, owner))
				} else {
					None
				}
			})
			.collect())
	}

	async fn watch_models(
		&self,
		since: Option<ProviderCatalogCursor>,
	) -> Result<Vec<ProviderModelEvent>, ProviderControlError> {
		let registry = self.owner.registry();
		let cursor = Self::cursor(&registry);
		if since.as_ref() == Some(&cursor) {
			return Ok(Vec::new());
		}
		let mut events =
			vec![crate::model_controls::ProviderModelEvent::Reset { cursor: cursor.clone() }];
		events.extend(
			self
				.models(None)
				.await?
				.into_iter()
				.map(|card| ProviderModelEvent::Upsert { cursor: cursor.clone(), card }),
		);
		Ok(events)
	}

	async fn is_authenticated(&self, provider: &str) -> Result<bool, ProviderControlError> {
		let registry = self.owner.registry();
		let provider_id = omp_catalog::ProviderId::from(provider);
		let Some(provider_definition) = registry.catalog().provider(&provider_id) else {
			return Err(ProviderControlError::NotFound);
		};
		if provider_definition.auth.iter().all(|auth| {
			registry
				.catalog()
				.auth_spec(auth)
				.is_some_and(|spec| spec.kind == AuthSpecKind::None)
		}) {
			return Ok(true);
		}
		let planner = Router::new(registry.clone(), Duration::from_secs(30));
		let meta = CallMeta {
			id:       RequestId::from(format!("provider-control-{}", omp_core::Ulid::generate())),
			target:   Target::ProviderService(provider_id.clone()),
			deadline: None,
			budget:   ExecutionBudget::default(),
			session:  None,
		};
		let mut client = Client::new(registry.service(), planner, meta);
		match client
			.execute(AuthRequest::ListAccounts { provider: Some(provider_id) })
			.await
			.map_err(|error| ProviderControlError::Request(auth_error_message(&error)))?
		{
			AuthAnswer::Accounts(accounts) => Ok(!accounts.is_empty()),
			_ => Err(ProviderControlError::Request(sf!(
				"authentication owner returned an unexpected answer"
			))),
		}
	}

	async fn replace(
		&self,
		identity: &ControlConnectionIdentity,
		declaration: ProviderDeclarationDocument,
	) -> Result<(), ProviderControlError> {
		self.owner.replace_provider(identity, declaration).await
	}

	async fn retract(
		&self,
		identity: &ControlConnectionIdentity,
		provider: &str,
	) -> Result<(), ProviderControlError> {
		self.owner.retract_provider(identity, provider).await
	}

	async fn request(
		&self,
		identity: &ControlConnectionIdentity,
		request: ProviderControlRequest,
	) -> Result<ProviderControlResult, ProviderControlError> {
		self.owner.provider_request(identity, request).await
	}
}

/// One authoritative regime activation projected from the live agent owner.
#[derive(Clone, Debug)]
pub struct RegimeControlEntry {
	/// Stable activation identity.
	pub id:        Str,
	/// Frozen regime declaration identity.
	pub regime:    Str,
	/// Extension owning the declaration.
	pub extension: Str,
	/// Current activation status.
	pub status:    RegimeControlStatus,
}

/// Public status of one regime activation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RegimeControlStatus {
	/// The activation currently owns every declared resource.
	Active,
	/// The activation is waiting in a durable FIFO resource queue.
	Queued,
}

impl RegimeControlStatus {
	fn as_str(self) -> &'static str {
		match self {
			Self::Active => "active",
			Self::Queued => "queued",
		}
	}
}

/// Extension regime declaration and callback resolver.
///
/// The resolver constructs the generation-fenced callback handler from the
/// sealed declaration table; it never accepts child-supplied executable code.
pub trait RegimeControlResolver: Send + Sync + 'static {
	/// Resolves a declaration owned by the authenticated extension.
	fn resolve(
		&self,
		identity: &ControlConnectionIdentity,
		regime: &str,
		state: Option<&str>,
	) -> Result<(Arc<omp_agent::RegimeSpec>, Box<dyn omp_agent::Regime>), ControlProtocolError>;

	/// Returns the owning extension for a frozen declaration.
	fn owner(&self, regime: &str) -> Option<Str>;
}

/// Regime backend delegating every mutation and projection to the sole live
/// agent loop.
pub struct AgentRegimeControlBackend {
	control:  omp_agent::ControlSender,
	resolver: Arc<dyn RegimeControlResolver>,
}

impl AgentRegimeControlBackend {
	/// Binds the live agent owner and sealed extension declaration resolver.
	pub fn new(control: omp_agent::ControlSender, resolver: Arc<dyn RegimeControlResolver>) -> Self {
		Self { control, resolver }
	}

	async fn entries(
		&self,
		extension: Option<&str>,
	) -> Result<Vec<RegimeControlEntry>, ControlProtocolError> {
		let entries = self.control.active_regimes().await.map_err(|_| {
			ControlProtocolError::new(
				"RegimeOwnerError",
				"live agent owner rejected regime projection",
			)
		})?;
		let mut projected = Vec::new();
		for entry in entries {
			let Some(owner) = self.resolver.owner(entry.spec_id.as_str()) else {
				continue;
			};
			if extension.is_some_and(|extension| extension != owner.as_str()) {
				continue;
			}
			projected.push(RegimeControlEntry {
				id:        entry.activation,
				regime:    entry.spec_id,
				extension: owner,
				status:    if matches!(entry.status, omp_agent::RegimeStatus::Queued) {
					RegimeControlStatus::Queued
				} else {
					RegimeControlStatus::Active
				},
			});
		}
		Ok(projected)
	}
}

/// Factory for connection-scoped `omp.regimes.*` ownership.
pub struct RegimeControlAuthorityFactory {
	backend: Arc<AgentRegimeControlBackend>,
}

impl RegimeControlAuthorityFactory {
	/// Creates a factory over the one live session regime owner.
	pub fn new(backend: Arc<AgentRegimeControlBackend>) -> Self {
		Self { backend }
	}
}

struct RegimeControlAuthority {
	identity: Arc<ControlConnectionIdentity>,
	backend:  Arc<AgentRegimeControlBackend>,
}

impl ControlAuthorityFactory for RegimeControlAuthorityFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		Ok(Arc::new(RegimeControlAuthority { identity, backend: Arc::clone(&self.backend) }))
	}
}

impl RegimeControlAuthority {
	fn validate(
		&self,
		context: &control::ControlRequestContext,
	) -> Result<(), ControlProtocolError> {
		if Arc::ptr_eq(&context.connection, &self.identity) {
			Ok(())
		} else {
			Err(ControlProtocolError::new(
				"StaleGeneration",
				"regime CONTROL authority belongs to a replaced connection",
			))
		}
	}

	fn entry(entry: RegimeControlEntry) -> Value {
		json!({
			"id": entry.id.as_str(),
			"regime": entry.regime.as_str(),
			"extension": entry.extension.as_str(),
			"status": entry.status.as_str(),
		})
	}
}

#[async_trait]
impl ControlAuthority for RegimeControlAuthority {
	fn handles(&self, operation: &str) -> bool {
		matches!(operation, "omp.regimes.start" | "omp.regimes.active" | "omp.regimes.stop")
	}

	fn authorize(
		&self,
		context: &control::ControlRequestContext,
		operation: &str,
		arguments: &serde_json::Map<String, Value>,
	) -> Result<(), ControlProtocolError> {
		self.validate(context)?;
		if context
			.invocation
			.as_ref()
			.is_some_and(|invocation| invocation.lifecycle != omp_core::LifecyclePhase::Active)
		{
			return Err(ControlProtocolError::new(
				"PhaseError",
				"regime operations require an active extension lifecycle",
			));
		}
		if operation == "omp.regimes.active" {
			let target = arguments
				.get("extension")
				.and_then(Value::as_str)
				.unwrap_or(self.identity.extension.as_str());
			control::authorize_regime_read(
				self.identity.extension.as_str(),
				target,
				&self.identity.capabilities,
			)
			.map_err(|_| {
				ControlProtocolError::new(
					"CapabilityError",
					"cross-extension regime reads require regimes.read",
				)
			})?;
		}
		Ok(())
	}

	async fn request(
		&self,
		context: control::ControlRequestContext,
		operation: Str,
		arguments: serde_json::Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		self.validate(&context)?;
		match operation.as_str() {
			"omp.regimes.start" => {
				let regime = arguments
					.get("regime")
					.and_then(Value::as_str)
					.filter(|regime| !regime.is_empty())
					.ok_or_else(|| {
						ControlProtocolError::new("InvalidRegime", "regime identity is required")
					})?;
				let state = arguments.get("state").and_then(Value::as_str);
				let queue = arguments
					.get("queue")
					.and_then(Value::as_bool)
					.unwrap_or(false);
				let (spec, handler) = self
					.backend
					.resolver
					.resolve(&self.identity, regime, state)?;
				let receipt = self
					.backend
					.control
					.start_regime(spec, handler, omp_agent::StartOptions { now_ms: now_ms(), queue })
					.await
					.map_err(|_| {
						ControlProtocolError::new(
							"RegimeStartError",
							"live agent owner rejected regime start",
						)
					})?;
				let entry = self
					.backend
					.entries(Some(self.identity.extension.as_str()))
					.await?
					.into_iter()
					.find(|entry| entry.id == receipt.activation)
					.ok_or_else(|| {
						ControlProtocolError::new(
							"RegimeOwnerError",
							"accepted regime is absent from the live agent owner",
						)
					})?;
				Ok(Self::entry(entry))
			},
			"omp.regimes.active" => {
				let extension = arguments
					.get("extension")
					.and_then(Value::as_str)
					.unwrap_or(self.identity.extension.as_str());
				Ok(Value::Array(
					self
						.backend
						.entries(Some(extension))
						.await?
						.into_iter()
						.map(Self::entry)
						.collect(),
				))
			},
			"omp.regimes.stop" => {
				let activation = arguments
					.get("activation_id")
					.and_then(Value::as_str)
					.filter(|activation| !activation.is_empty())
					.ok_or_else(|| {
						ControlProtocolError::new("InvalidRegime", "activation identity is required")
					})?;
				let owned = self
					.backend
					.entries(Some(self.identity.extension.as_str()))
					.await?
					.into_iter()
					.any(|entry| entry.id.as_str() == activation);
				if !owned {
					return Err(ControlProtocolError::new(
						"AuthorizationError",
						"activation is not owned by the calling extension",
					));
				}
				Ok(Value::Bool(
					self
						.backend
						.control
						.stop_regime(Str::from(activation))
						.await
						.map_err(|_| {
							ControlProtocolError::new(
								"RegimeStopError",
								"live agent owner rejected regime stop",
							)
						})?,
				))
			},
			_ => Err(ControlProtocolError::new(
				"UnknownOperation",
				"regime authority does not own this operation",
			)),
		}
	}

	async fn effect(
		&self,
		context: control::ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		self.validate(&context)?;
		Err(ControlProtocolError::new(
			"UnsupportedEffect",
			"regime mutations are correlated CONTROL operations",
		))
	}
}

/// Resolves the catalog streaming watchdog for one model's primary route.
///
/// Absent providers, routes, or policies leave both bounds unset, which
/// disables the loop's stream watchdog entirely.
pub(crate) fn model_stream_watchdog(
	catalog: &snapshot::Catalog,
	model: &str,
) -> omp_agent::StreamWatchdog {
	let watchdog = catalog
		.model(omp_catalog::ModelKey::from_ref(model))
		.or_else(|| catalog.resolve_alias(model))
		.and_then(|spec| spec.routes.first())
		.and_then(|route| catalog.route(route))
		.and_then(|route| catalog.provider(&route.provider))
		.and_then(|provider| catalog.wire_policy(&provider.wire_policy))
		.and_then(|policy| policy.streaming.watchdog);
	watchdog.map_or_else(omp_agent::StreamWatchdog::default, |watchdog| omp_agent::StreamWatchdog {
		first_event_ms: watchdog.first_event_ms,
		idle_ms:        watchdog.idle_ms,
	})
}

/// Resolves the selected model's total context window.
pub fn model_context_window(catalog: &snapshot::Catalog, model: &str) -> Option<u64> {
	catalog
		.model(omp_catalog::ModelKey::from_ref(model))
		.or_else(|| catalog.resolve_alias(model))
		.and_then(|spec| spec.limits.context_window)
}

/// Resolves input-usable context after reserving the model's maximum output.
pub fn model_usable_context_window(catalog: &snapshot::Catalog, model: &str) -> Option<u64> {
	catalog
		.model(omp_catalog::ModelKey::from_ref(model))
		.or_else(|| catalog.resolve_alias(model))
		.and_then(|spec| {
			spec.limits.context_window.map(|context| {
				context.saturating_sub(spec.limits.maximum_output_tokens.unwrap_or_default())
			})
		})
}

/// Returns whether the catalog proves the model cannot accept declared tools.
///
/// Unknown or missing capability evidence keeps tools advertised; only
/// explicit `Unsupported` evidence (e.g. Apple's on-device model) strips them.
pub(crate) fn model_rejects_tools(catalog: &snapshot::Catalog, model: &str) -> bool {
	catalog
		.model(omp_catalog::ModelKey::from_ref(model))
		.or_else(|| catalog.resolve_alias(model))
		.and_then(|spec| spec.capabilities.chat.as_ref())
		.is_some_and(|chat| chat.tools.is_unsupported())
}

/// Resolves the interrupted-reasoning continuity dialect from typed catalog
/// policy.
pub fn interrupted_reasoning_dialect(
	catalog: &snapshot::Catalog,
	model: &str,
) -> omp_agent::InterruptedReasoningDialect {
	let anthropic = catalog
		.model(omp_catalog::ModelKey::from_ref(model))
		.or_else(|| catalog.resolve_alias(model))
		.and_then(|model| catalog.wire_policy(&model.wire_policy))
		.is_some_and(|policy| {
			policy.reasoning.wire_format == Some(omp_catalog::ReasoningWireFormat::Anthropic)
		});
	if anthropic {
		omp_agent::InterruptedReasoningDialect::Anthropic
	} else {
		omp_agent::InterruptedReasoningDialect::Other
	}
}

/// Reports whether a model selector resolves to an available catalog model.
pub fn model_selector_is_selectable(catalog: &snapshot::Catalog, selector: &str) -> bool {
	if selector.starts_with('@') {
		return true;
	}
	catalog
		.model(omp_catalog::ModelKey::from_ref(selector))
		.or_else(|| catalog.resolve_alias(selector))
		.is_some_and(|model| {
			model.availability != omp_catalog::ModelAvailability::Disabled
				&& model
					.routes
					.iter()
					.any(|route| catalog.route(route).is_some())
		})
}

/// Chooses the catalog's deterministic fallback model selector.
pub fn fallback_model_selector(catalog: &snapshot::Catalog) -> Option<Str> {
	let mru = BTreeMap::new();
	omp_catalog::find_smol(catalog.models(), catalog.routes(), &mru)
		.or_else(|| omp_catalog::pick_default(catalog.models(), catalog.routes(), &mru))
		.map(|selected| Str::from(selected.model.as_str()))
}

/// Canonicalizes a `--model` selector to its exact catalog key.
///
/// Exact keys pass through; declared catalog aliases resolve to their target
/// key; role selectors (`@…`) defer to downstream resolution. A route id or
/// unknown selector fails fast instead of surfacing as a mid-turn
/// `TargetNotFound`.
pub fn resolve_model_selector(
	catalog: &snapshot::Catalog,
	selector: &str,
) -> Result<Str, ChatError> {
	if selector.starts_with('@')
		|| catalog
			.model(omp_catalog::ModelKey::from_ref(selector))
			.is_some()
	{
		return Ok(selector.into());
	}
	if let Some(spec) = catalog.resolve_alias(selector) {
		return Ok(spec.key.as_str().into());
	}
	if let Some(route) = catalog.route(omp_catalog::RouteId::from_ref(selector)) {
		// Models bound to this exact route, else every model the provider serves.
		let mut candidates: Vec<&str> = catalog
			.models()
			.iter()
			.filter(|spec| spec.routes.contains(&route.id))
			.map(|spec| spec.key.as_str())
			.collect();
		if candidates.is_empty() {
			candidates = catalog
				.models()
				.iter()
				.filter(|spec| {
					spec.routes.iter().any(|id| {
						catalog
							.route(id)
							.is_some_and(|def| def.provider == route.provider)
					})
				})
				.map(|spec| spec.key.as_str())
				.collect();
		}
		let hint = match candidates.as_slice() {
			[] => Default::default(),
			[only] => sf!("; use `--model {only}`"),
			many => sf!(
				"; provider `{}` serves: {}{}",
				route.provider,
				many[..many.len().min(4)].join(", "),
				if many.len() > 4 { ", …" } else { "" },
			),
		};
		return Err(ChatError::ModelSelectorIsRoute { selector: selector.into(), hint });
	}
	let needle = selector
		.rsplit('/')
		.next()
		.unwrap_or(selector)
		.to_ascii_lowercase();
	let mut near = catalog
		.models()
		.iter()
		.filter(|spec| !needle.is_empty() && spec.key.as_str().to_ascii_lowercase().contains(&needle))
		.map(|spec| spec.key.as_str())
		.take(4)
		.peekable();
	let suggestions = if near.peek().is_some() {
		sf!("; closest: {}", near.collect::<Vec<_>>().join(", "))
	} else {
		Default::default()
	};
	Err(ChatError::UnknownModel { selector: selector.into(), suggestions })
}
/// Selects the exact provider domain receiving an invocation credential.
pub fn resolve_model_provider(
	catalog: &snapshot::Catalog,
	model: &str,
	requested: Option<&str>,
) -> Result<omp_catalog::ProviderId, ChatError> {
	let spec = catalog
		.model(omp_catalog::ModelKey::from_ref(model))
		.ok_or_else(|| ChatError::UnknownModel {
			selector:    model.into(),
			suggestions: Str::empty(),
		})?;
	if let Some(requested) = requested {
		let provider = omp_catalog::ProviderId::from(requested);
		if spec.routes.iter().any(|route| {
			catalog
				.route(route)
				.is_some_and(|route| route.provider == provider)
		}) {
			return Ok(provider);
		}
		return Err(ChatError::ModelProviderUnavailable { model: model.into(), provider });
	}
	spec
		.routes
		.iter()
		.filter_map(|route| catalog.route(route))
		.next()
		.map(|route| route.provider.clone())
		.ok_or_else(|| ChatError::ModelHasNoProvider { model: model.into() })
}

/// Canonicalizes and validates a project directory.
pub fn canonical_project(path: &Path) -> Result<PathBuf, ChatError> {
	let root = fs::canonicalize(path)
		.map_err(|source| ChatError::Project { path: path.to_owned(), source })?;
	if !root.is_dir() {
		return Err(ChatError::ProjectNotDirectory(root));
	}
	Ok(root)
}

/// Opens, resumes, forks, or creates one chat session journal.
pub fn open_session(
	root: &Path,
	sessions_dir: &Path,
	open: SessionOpen<'_>,
	registry: &Registry,
	session_index: Option<Arc<SessionIndex>>,
) -> Result<Session, ChatError> {
	let source = match open {
		SessionOpen::Resume(id) | SessionOpen::ResumeMoved(id) | SessionOpen::Fork(id) => {
			Some(strict_session_id(id)?)
		},
		SessionOpen::New | SessionOpen::Ephemeral => None,
	};
	let id = if matches!(open, SessionOpen::Resume(_) | SessionOpen::ResumeMoved(_)) {
		source.clone().expect("resume has a validated source")
	} else {
		Str::from(omp_core::Ulid::generate().to_string())
	};
	let path = sessions_dir.join(format!("{}.jsonl", id.as_str()));
	let journal = match open {
		SessionOpen::Resume(_) | SessionOpen::ResumeMoved(_) => {
			validate_session_file(&path).map_err(|source_error| {
				if source_error.kind() == io::ErrorKind::NotFound {
					ChatError::MissingResume(id.clone())
				} else {
					ChatError::ProjectState { path: path.clone(), source: source_error }
				}
			})?;
			let mut journal = Journal::open(&path)?;
			let view = journal.load()?;
			if view.log().header().id.0 != id {
				return Err(ChatError::SessionMismatch(id));
			}
			let recorded_root = view.log().header().cwd.clone();
			drop(view);
			let current_root = journal.workspace_roots(&recorded_root)?;
			if current_root.primary() != root && !matches!(open, SessionOpen::ResumeMoved(_)) {
				return Err(ChatError::SessionProjectMismatch { session: id });
			}
			let index = session_index.ok_or(ChatError::MissingSessionIndex)?;
			journal.attach_session_index(index, SessionId(id.clone()));
			if current_root.primary() != root {
				journal.move_workspace_root(now_ms(), root.to_owned())?;
			}
			journal
		},
		SessionOpen::Fork(_) => {
			let source_id = source.as_ref().expect("fork has a validated source");
			let source_path = sessions_dir.join(format!("{}.jsonl", source_id.as_str()));
			validate_session_file(&source_path).map_err(|source_error| {
				if source_error.kind() == io::ErrorKind::NotFound {
					ChatError::MissingResume(source_id.clone())
				} else {
					ChatError::ProjectState { path: source_path.clone(), source: source_error }
				}
			})?;
			let index = session_index.ok_or(ChatError::MissingSessionIndex)?;
			create_indexed_fork(&source_path, &path, root, &id, source_id, index)?
		},
		SessionOpen::New => create_indexed_journal(
			&path,
			root,
			&id,
			session_index.ok_or(ChatError::MissingSessionIndex)?,
			SessionKind::Interactive,
			None,
		)?,
		SessionOpen::Ephemeral => Journal::create(&path, &Header {
			v:       4,
			id:      SessionId(id.clone()),
			created: now_ms(),
			cwd:     root.to_owned(),
		})?,
	};
	let view = journal.load()?;
	let initial_items = project_journal(&view, registry, &CHAT_CAPS_BASE)?.items;
	drop(view);
	Ok(Session { id, journal, initial_items })
}

pub(crate) fn create_indexed_journal(
	path: &Path,
	root: &Path,
	id: &Str,
	session_index: Arc<SessionIndex>,
	kind: SessionKind,
	parent: Option<&SessionId>,
) -> Result<Journal, ChatError> {
	let session_id = SessionId(id.clone());
	let created_ms = now_ms();
	let root_text = root.to_string_lossy();
	let request = NewSession {
		id: &session_id,
		cwd: root_text.as_ref(),
		project: root_text.as_ref(),
		created_ms,
		kind,
		parent,
		remote: false,
	};
	let result = session_index.create_session(&request, || {
		let journal = Journal::create(path, &Header {
			v:       4,
			id:      session_id.clone(),
			created: created_ms,
			cwd:     root.to_owned(),
		})?;
		let watermark = journal.byte_watermark()?;
		Ok::<_, omp_agent::JournalError>((journal, watermark))
	});
	let mut journal = match result {
		Ok(journal) => journal,
		Err(IndexedWriteError::Journal(error)) => return Err(error.into()),
		Err(
			IndexedWriteError::IndexBeforeJournal(error)
			| IndexedWriteError::IndexAfterJournal { source: error, .. },
		) => {
			return Err(ChatError::SessionIndex(error));
		},
	};
	journal.attach_session_index(session_index, session_id);
	Ok(journal)
}

#[allow(
	dead_code,
	reason = "staged for the planned /handoff + auto-handoff rescue tier \
	          (.plan/feature-map/FEATURES.md \"handoff child sessions\"); no HandoffCommit \
	          producer exists yet — omp currently compacts in place"
)]
pub(crate) fn create_indexed_handoff(
	parent: &Journal,
	path: &Path,
	root: &Path,
	commit: omp_agent::handoff::HandoffCommit,
	tokens_before: u64,
	tokens_after: Option<u64>,
	session_index: Arc<SessionIndex>,
	save_to_disk: bool,
) -> Result<Option<Journal>, ChatError> {
	if !save_to_disk {
		return Ok(None);
	}
	let child_id = SessionId(commit.child_session_id.clone());
	let parent_id = SessionId(commit.request.parent_session_id.clone());
	let created_ms = now_ms();
	let root_text = root.to_string_lossy();
	let request = NewSession {
		id: &child_id,
		cwd: root_text.as_ref(),
		project: root_text.as_ref(),
		created_ms,
		kind: SessionKind::Interactive,
		parent: Some(&parent_id),
		remote: false,
	};
	let header = Header {
		v:       4,
		id:      child_id.clone(),
		created: created_ms,
		cwd:     root.to_owned(),
	};
	let checkpoint = commit.request.parent_checkpoint;
	let compact = commit.compact(tokens_before, tokens_after);
	let result = session_index.create_session(&request, || {
		let journal = parent.create_handoff_child(path, &header, created_ms, checkpoint, compact)?;
		let watermark = journal.byte_watermark()?;
		Ok::<_, omp_agent::JournalError>((journal, watermark))
	});
	let mut journal = match result {
		Ok(journal) => journal,
		Err(IndexedWriteError::Journal(error)) => return Err(error.into()),
		Err(
			IndexedWriteError::IndexBeforeJournal(error)
			| IndexedWriteError::IndexAfterJournal { source: error, .. },
		) => return Err(ChatError::SessionIndex(error)),
	};
	journal.attach_session_index(session_index, child_id);
	Ok(Some(journal))
}

fn create_indexed_fork(
	source_path: &Path,
	child_path: &Path,
	root: &Path,
	child_id: &Str,
	source_id: &Str,
	session_index: Arc<SessionIndex>,
) -> Result<Journal, ChatError> {
	let source = Journal::open(source_path)?;
	let source_view = source.load()?;
	if source_view.log().header().id.0 != *source_id {
		return Err(ChatError::SessionMismatch(source_id.clone()));
	}
	let recorded_root = source_view.log().header().cwd.clone();
	drop(source_view);
	if source.workspace_roots(&recorded_root)?.primary() != root {
		return Err(ChatError::SessionProjectMismatch { session: source_id.clone() });
	}
	let session_id = SessionId(child_id.clone());
	let parent_id = SessionId(source_id.clone());
	let created_ms = now_ms();
	let root_text = root.to_string_lossy();
	let request = NewSession {
		id: &session_id,
		cwd: root_text.as_ref(),
		project: root_text.as_ref(),
		created_ms,
		kind: SessionKind::Interactive,
		parent: Some(&parent_id),
		remote: false,
	};
	let result = session_index.create_session(&request, || {
		let journal = source.create_child(
			child_path,
			&Header {
				v:       4,
				id:      session_id.clone(),
				created: created_ms,
				cwd:     root.to_owned(),
			},
			created_ms,
			ChildKind::Fork,
		)?;
		let watermark = journal.byte_watermark()?;
		Ok::<_, omp_agent::JournalError>((journal, watermark))
	});
	let mut journal = match result {
		Ok(journal) => journal,
		Err(IndexedWriteError::Journal(error)) => return Err(error.into()),
		Err(
			IndexedWriteError::IndexBeforeJournal(error)
			| IndexedWriteError::IndexAfterJournal { source: error, .. },
		) => return Err(ChatError::SessionIndex(error)),
	};
	journal.attach_session_index(session_index, session_id);
	Ok(journal)
}

/// Lists project-local resumable sessions with durable pins ahead of recency.
pub fn resume_choices(
	sessions_dir: &Path,
	root: &Path,
	current_id: Option<&Str>,
) -> Result<Vec<ResumeChoice>, ChatError> {
	let pins = PinStore::new(sessions_dir).load()?;
	let entries = fs::read_dir(sessions_dir)
		.map_err(|source| ChatError::ProjectState { path: sessions_dir.to_owned(), source })?;
	let mut choices = Vec::new();
	for entry in entries {
		let Ok(entry) = entry else {
			continue;
		};
		let path = entry.path();
		if path.extension().and_then(ffi::OsStr::to_str) != Some("jsonl")
			|| validate_session_file(&path).is_err()
		{
			continue;
		}
		let Some(stem) = path.file_stem().and_then(ffi::OsStr::to_str) else {
			continue;
		};
		let id = Str::from(stem);
		if strict_session_id(&id).is_err() {
			continue;
		}
		let Some(metadata) = session_metadata(&path) else {
			continue;
		};
		if metadata.header.id.0 != id || metadata.header.cwd != root {
			continue;
		}
		// A journal holding only its header carries nothing to resume: sessions
		// are created eagerly on disk, so a launch-then-quit leaves an empty
		// shell that would resume to a blank conversation. Never advertise it
		// (pi issue #8860: only advertise resume for actually-persisted work).
		if !metadata.has_entries {
			continue;
		}
		let modified = entry
			.metadata()
			.and_then(|metadata| metadata.modified())
			.unwrap_or(UNIX_EPOCH);
		let age = relative_time(modified);
		let label = metadata.label.unwrap_or_else(|| sf!("Untitled session"));
		let detail = if current_id.is_some_and(|current| current == &id) {
			sf!("current · {age} · {id}")
		} else {
			sf!("{age} · {id}")
		};
		let pinned = pins.contains(&id);
		choices.push((!pinned, cmp::Reverse(modified), ResumeChoice { id, label, detail, pinned }));
	}
	choices.sort_by_key(|(unpinned, modified, _)| (*unpinned, *modified));
	Ok(choices.into_iter().map(|(_, _, choice)| choice).collect())
}

/// Streamed session-journal probe results consumed by the resume picker.
struct SessionMetadata {
	/// Parsed first-line journal header.
	header:      Header,
	/// Best display label: latest title, else the first user prompt.
	label:       Option<Str>,
	/// Whether any decodable journal entry follows the header. Journals are
	/// created eagerly with a lone header line, so this distinguishes sessions
	/// with persisted conversation from empty shells.
	has_entries: bool,
}

fn session_metadata(path: &Path) -> Option<SessionMetadata> {
	let reader = transcript::Reader::open(path).ok()?;
	let log = reader.log();
	let header = log.header().clone();
	let mut title = None;
	let mut first_message = None;
	for index in 0..u64::try_from(log.len()).ok()? {
		let Some(transcript::Entry::Ok(event)) = log.get(index) else {
			continue;
		};
		match &event.kind {
			Kind::Title { title: value, .. } => title = sanitize_session_label(value),
			Kind::Msg(transcript::Msg::User { content, .. }) if first_message.is_none() => {
				first_message = content.iter().find_map(|block| match block {
					transcript::UserBlock::Text { text } => sanitize_session_label(text),
					transcript::UserBlock::Image { .. } => None,
				});
			},
			Kind::TurnInput(record) if first_message.is_none() => {
				first_message = session_item_label(&record.item);
			},
			Kind::Item(record) if first_message.is_none() => {
				first_message = session_item_label(&record.item);
			},
			_ => {},
		}
	}
	Some(SessionMetadata { header, label: title.or(first_message), has_entries: !log.is_empty() })
}

fn session_item_label(value: &Item) -> Option<Str> {
	let Some(item::Kind::Message(message)) = &value.kind else {
		return None;
	};
	if !matches!(Role::try_from(message.role), Ok(Role::User)) {
		return None;
	}
	message.parts.iter().find_map(|part| match &part.kind {
		Some(part::Kind::Text(text)) => sanitize_session_label(text),
		_ => None,
	})
}

fn sanitize_session_label(value: &str) -> Option<Str> {
	let mut clean = value.to_owned().into_ansi_stripped();
	if let Some(end) = clean.find(['\r', '\n']) {
		clean.truncate(end);
	}
	clean.retain(|character| !character.is_control());
	let clean = Str::from(clean).trim();
	(!clean.is_empty()).then_some(clean)
}

fn relative_time(modified: SystemTime) -> Str {
	let seconds = SystemTime::now()
		.duration_since(modified)
		.unwrap_or_default()
		.as_secs();
	match seconds {
		0..60 => sf!("just now"),
		60..3_600 => sf!("{}m ago", seconds / 60),
		3_600..86_400 => sf!("{}h ago", seconds / 3_600),
		86_400..604_800 => sf!("{}d ago", seconds / 86_400),
		_ => sf!("{}w ago", seconds / 604_800),
	}
}

/// Validates and canonicalizes a durable session identity.
pub fn strict_session_id(id: &Str) -> Result<Str, ChatError> {
	if let Ok(parsed) = id.as_str().parse::<omp_core::Ulid>()
		&& parsed.to_string() == id.as_str()
	{
		return Ok(id.clone());
	}
	let bytes = id.as_bytes();
	let canonical_uuid = bytes.len() == 36
		&& bytes.iter().enumerate().all(|(index, byte)| {
			if matches!(index, 8 | 13 | 18 | 23) {
				*byte == b'-'
			} else {
				byte.is_ascii_digit() || matches!(*byte, b'a'..=b'f')
			}
		});
	if canonical_uuid {
		Ok(id.clone())
	} else {
		Err(ChatError::InvalidResume(id.clone()))
	}
}

/// Resolves the shared SDK blueprint over the production registry and durable
/// journal identity used by chat and print construction.
pub fn session_blueprint(
	model: &str,
	catalog: &snapshot::Catalog,
	root: &Path,
	additional_roots: &[PathBuf],
	session_id: &Str,
	registry: Arc<Registry>,
) -> Result<SessionBlueprint, ChatError> {
	let mut options = SessionOptions::new(root);
	options.additional_roots = additional_roots
		.iter()
		.map(|path| {
			fs::canonicalize(path).map_err(|source| ChatError::Project { path: path.clone(), source })
		})
		.collect::<Result<Vec<_>, _>>()?
		.into_boxed_slice();
	options.identity.id = Some(session_id.clone());
	options.model_selectors = Box::new([Str::new(model)]);
	let mut workspace = PromptFacts::new(root, Arc::from([]));
	let mut roots = Vec::with_capacity(options.additional_roots.len() + 1);
	for (index, path) in iter::once(&options.cwd)
		.chain(options.additional_roots.iter())
		.enumerate()
	{
		let uri = Url::from_directory_path(path).map_err(|()| {
			ChatError::SessionBuild(omp_sdk::SessionBuildError::InvalidRoot { path: path.clone() })
		})?;
		let grant = if index == 0 {
			sf!("primary")
		} else {
			sf!("root-{index}")
		};
		roots.push(WorkspaceRootInput::new(
			Str::new(uri.as_str()),
			bytes::Bytes::copy_from_slice(grant.as_bytes()),
		));
	}
	workspace.roots =
		WorkspaceRootsInput { revision: 0, primary: roots.first().cloned(), roots: roots.into() };
	SessionBuilder::new(options, registry)
		.firehose(Arc::new(Firehose::new()))
		.build(catalog, &workspace)
		.map_err(Into::into)
}

pub(crate) fn protocol_tool_definition(
	tool: ToolDefinition,
) -> Result<inference_pb::ToolDef, ChatError> {
	let input = match tool.input {
		ToolInputConstraint::JsonSchema { parameters, strict } => {
			let schema_json =
				serde_json::to_vec(parameters.as_value()).map_err(ChatError::ToolSchema)?;
			tool_def::Input::JsonSchema(tool_def::JsonSchema {
				schema_json: schema_json.into(),
				strict:      Some(strict),
			})
		},
		ToolInputConstraint::Grammar { grammar, fallback } => {
			let syntax = match grammar.syntax {
				ToolGrammarSyntax::Lark => grammar::Syntax::Lark,
				ToolGrammarSyntax::Regex => grammar::Syntax::Regex,
				ToolGrammarSyntax::Ebnf => grammar::Syntax::Ebnf,
			};
			let fallback_schema_json =
				serde_json::to_vec(fallback.as_value()).map_err(ChatError::ToolSchema)?;
			tool_def::Input::Grammar(tool_def::Grammar {
				syntax:               syntax as i32,
				definition:           grammar.definition.to_string(),
				fallback_schema_json: fallback_schema_json.into(),
			})
		},
	};
	Ok(inference_pb::ToolDef {
		name:        tool.name.to_string(),
		description: tool
			.description
			.map_or_else(String::new, |value| value.to_string()),
		input:       Some(input),
	})
}

/// Projects a configured session blueprint into initial mutable agent state.
///
/// `external_thinking_override` is invocation-scoped: `Some(true)` replaces
/// provider reasoning with the hidden `think` tool, while `Some(false)` keeps
/// it disabled regardless of model capability evidence.
pub fn agent_snapshot(
	blueprint: &SessionBlueprint,
	catalog: &snapshot::Catalog,
	external_thinking_override: Option<bool>,
) -> Result<AgentSnapshot, ChatError> {
	let model = blueprint
		.model_plan()
		.candidates()
		.first()
		.map(|candidate| candidate.selector.as_str())
		.ok_or(omp_sdk::SessionBuildError::NoDefaultModel)?;
	let registry = blueprint.registry();
	let external_thinking = catalog
		.model(omp_catalog::ModelKey::from_ref(model))
		.or_else(|| catalog.resolve_alias(model))
		.map_or(external_thinking_override.unwrap_or(false), |model| {
			omp_agent::external_thinking_for_model(&model.capabilities, external_thinking_override)
		});
	let lowering_caps = LoweringCaps {
		// Advertise the richest constraint form; sessions span routes with
		// differing capability, so codecs lower grammar tools to their
		// fallback schema per transport and recovery accepts both wire forms.
		strict_schema:  true,
		grammar:        GrammarBits::ALL,
		maximum_tools:  None,
		maximum_strict: None,
	};
	let mut advertised = if model_rejects_tools(catalog, model) {
		Vec::new()
	} else {
		registry.advertise(lowering_caps)?
	};
	if external_thinking {
		let mut selected = advertised
			.iter()
			.map(|tool| tool.identity.name.clone())
			.collect::<Vec<_>>();
		selected.push(Str::new_static("think"));
		advertised = registry.advertise_selected(lowering_caps, &selected)?;
	}
	let mut enabled_tools = Vec::with_capacity(advertised.len());
	let mut tools = Vec::with_capacity(advertised.len());
	for tool in advertised {
		enabled_tools.push(tool.identity.name.clone());
		tools.push(protocol_tool_definition(tool.definition)?);
	}
	let session_id = blueprint
		.options()
		.identity
		.id
		.as_ref()
		.expect("SessionBuilder always assigns a session id");
	let turn = TurnOptions {
		context_id: Some(session_id.clone()),
		params: inference_pb::ChatParams {
			model: model.to_owned(),
			tools,
			thinking: external_thinking.then(|| inference_pb::Reasoning {
				effort: Effort::Off as i32,
				..inference_pb::Reasoning::default()
			}),
			..inference_pb::ChatParams::default()
		},
		stream_watchdog: model_stream_watchdog(catalog, model),
		..TurnOptions::default()
	};
	let prepared = PromptSnapshot::freeze(
		blueprint.prompt_facts().clone(),
		registry,
		Some(&enabled_tools),
		Arc::from([]),
		Default::default(),
		Default::default(),
		Default::default(),
		Arc::from([]),
		Arc::from([]),
		Arc::from([]),
	);
	let mut snapshot = AgentSnapshot::new(turn, prepared.props(), Arc::clone(registry));
	snapshot.reasoning_dialect = interrupted_reasoning_dialect(catalog, model);
	snapshot.enabled_tools = enabled_tools.into();
	Ok(snapshot)
}

/// Applies launch-time tool filtering and returns the corresponding environment
/// grant.
///
/// An external-thinking snapshot retains its hidden `think` tool even when
/// ordinary launch filters exclude other tools.
pub fn apply_launch_tool_selection(
	snapshot: &mut AgentSnapshot,
	selection: LaunchToolSelection<'_>,
	registry: &Registry,
) -> Result<omp_env::InvocationGrant, ChatError> {
	let known = registry
		.prompt_projection(None)
		.entries()
		.map(|entry| entry.name.clone())
		.collect::<BTreeSet<_>>();
	let requested = selection
		.tools
		.map(|tools| tools.iter().cloned().collect::<BTreeSet<_>>());
	let external_thinking = snapshot.enabled_tools.iter().any(|name| name == "think");
	if let Some(requested) = &requested
		&& let Some(unknown) = requested.iter().find(|name| !known.contains(*name))
	{
		return Err(ChatError::UnknownTool {
			name:  unknown.clone(),
			valid: known.into_iter().collect(),
		});
	}
	let allowed = |name: &str| {
		if external_thinking && name == "think" {
			return true;
		}
		if selection.no_tools {
			return false;
		}
		if selection.no_lsp && (name.contains("lsp") || matches!(name, "diagnostics" | "format")) {
			return false;
		}
		requested
			.as_ref()
			.is_none_or(|requested| requested.contains(name))
	};
	snapshot
		.turn
		.params
		.tools
		.retain(|tool| allowed(&tool.name));
	snapshot.enabled_tools = snapshot
		.enabled_tools
		.iter()
		.filter(|name| allowed(name))
		.cloned()
		.collect();
	let grant = omp_env::InvocationGrant::unrestricted();
	Ok(if selection.no_pty {
		grant.deny_pty()
	} else {
		grant
	})
}

/// Resolves one CLI reasoning selection against automatic-thinking policy.
pub fn thinking_effort(level: ThinkingLevel, auto: AutoThinkingSettings) -> Effort {
	match level {
		ThinkingLevel::Off => Effort::Off,
		ThinkingLevel::Minimal => Effort::Minimal,
		ThinkingLevel::Low => Effort::Low,
		ThinkingLevel::Medium => Effort::Medium,
		ThinkingLevel::High => Effort::High,
		ThinkingLevel::Extreme | ThinkingLevel::Max => Effort::Max,
		ThinkingLevel::XHigh => Effort::Xhigh,
		ThinkingLevel::Auto => auto
			.for_turn()
			.provisional
			.provisional(auto.ceiling)
			.effort(),
	}
}

/// Returns current Unix time in milliseconds.
pub fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX)
}

/// Creates a private state directory and maps filesystem failures.
pub fn ensure_state_directory(path: &Path) -> Result<(), ChatError> {
	fs::create_dir_all(path)
		.map_err(|source| ChatError::ProjectState { path: path.to_owned(), source })
}

fn validate_session_file(path: &Path) -> io::Result<()> {
	if fs::metadata(path)?.is_file() {
		Ok(())
	} else {
		Err(io::Error::new(io::ErrorKind::InvalidData, "session journal is not a regular file"))
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::{
		collections::VecDeque,
		fs::{self, OpenOptions},
		future,
		io::Write as _,
	};

	use futures::Stream;
	use omp_agent::{InvokeFrame, TurnSession};
	use omp_env::EnvClient;
	use omp_proto::thread::v1::{Item, Message, Part};
	use omp_storage::transcript::{Event, ItemRecord, TitleSource, Writer};

	use super::*;

	#[test]
	fn auto_thinking_installs_a_clamped_provisional_effort() {
		let auto = AutoThinkingSettings {
			provisional: omp_inference::Difficulty::Max,
			ceiling: omp_inference::Difficulty::Max,
			..AutoThinkingSettings::default()
		};
		assert_eq!(thinking_effort(ThinkingLevel::Auto, auto), Effort::High);
		assert_eq!(thinking_effort(ThinkingLevel::XHigh, auto), Effort::Xhigh,);
	}

	#[test]
	fn model_selector_resolution_covers_keys_aliases_routes_and_unknowns() {
		let catalog = snapshot::Catalog::try_embedded().expect("embedded catalog");
		let model = catalog.models().first().expect("catalog model");
		assert_eq!(
			resolve_model_selector(catalog, model.key.as_str())
				.expect("exact key resolves")
				.as_str(),
			model.key.as_str(),
		);
		assert_eq!(
			resolve_model_selector(catalog, "@smol")
				.expect("role selector passes through")
				.as_str(),
			"@smol",
		);

		let (unique_route, unique_model) = catalog
			.routes()
			.iter()
			.find_map(|route| {
				let models = catalog
					.models()
					.iter()
					.filter(|model| model.routes.contains(&route.id))
					.collect::<Vec<_>>();
				(models.len() == 1).then(|| (route, models[0]))
			})
			.expect("catalog has a uniquely served route");
		let unique = resolve_model_selector(catalog, unique_route.id.as_str()).unwrap_err();
		let ChatError::ModelSelectorIsRoute { hint, .. } = &unique else {
			panic!("expected route error, got {unique}");
		};
		assert_eq!(hint.as_str(), format!("; use `--model {}`", unique_model.key));

		let shared_route = catalog
			.routes()
			.iter()
			.find(|route| {
				catalog
					.models()
					.iter()
					.filter(|model| model.routes.contains(&route.id))
					.count() > 1
			})
			.expect("catalog has a shared route");
		let shared = resolve_model_selector(catalog, shared_route.id.as_str()).unwrap_err();
		let ChatError::ModelSelectorIsRoute { hint, .. } = &shared else {
			panic!("expected route error, got {shared}");
		};
		assert!(hint.starts_with("; provider `"), "shared route hint lists candidates: {hint}");

		let unknown = resolve_model_selector(catalog, "__unknown__/__missing__").unwrap_err();
		assert!(matches!(unknown, ChatError::UnknownModel { .. }));
	}

	/// Port of pi PR #8833: a provider-qualified selector must resolve within
	/// its named provider or fail closed — it must never shadow onto an
	/// aggregator's verbatim flat id (e.g. `anthropic/claude-fable-5` re-binding
	/// to `openrouter/anthropic/claude-fable-5`), which would silently bill the
	/// aggregator instead of failing a misconfigured provider.
	#[test]
	fn provider_qualified_selectors_never_shadow_onto_aggregator_flat_ids() {
		let catalog = snapshot::Catalog::try_embedded().expect("embedded catalog");

		// Explicit precedence pair: the same flat id exists both as a canonical
		// provider key and verbatim under the aggregator.
		let native = omp_catalog::ModelKey::from_ref("anthropic/claude-fable-5");
		let shadowed = omp_catalog::ModelKey::from_ref("openrouter/anthropic/claude-fable-5");
		assert!(catalog.model(native).is_some(), "fixture key missing from catalog");
		assert!(catalog.model(shadowed).is_some(), "fixture aggregator key missing from catalog");
		assert_eq!(
			resolve_model_selector(catalog, "anthropic/claude-fable-5")
				.expect("canonical provider key resolves")
				.as_str(),
			"anthropic/claude-fable-5",
			"the named provider wins over the aggregator's flat id",
		);
		assert_eq!(
			resolve_model_selector(catalog, "openrouter/anthropic/claude-fable-5")
				.expect("explicit aggregator selection resolves")
				.as_str(),
			"openrouter/anthropic/claude-fable-5",
			"an explicit aggregator prefix still selects the aggregator",
		);

		// Matrix over every aggregator-hosted flat id whose named provider is a
		// real catalog provider: the bare flat id either resolves within that
		// provider or fails closed; it never re-binds to the aggregator copy.
		// `resolve_model_selector` can only produce a model through these two
		// exact lookups (key, then declared alias) before failing closed, so the
		// matrix checks them directly instead of paying the unknown-selector
		// suggestion scan a thousand times over.
		let mut flat_ids = BTreeSet::new();
		for spec in catalog.models() {
			let Some((_aggregator, flat_id)) = spec.key.as_str().split_once('/') else {
				continue;
			};
			let Some((named_provider, _)) = flat_id.split_once('/') else {
				continue;
			};
			if catalog
				.provider(omp_catalog::ProviderId::from_ref(named_provider))
				.is_some()
			{
				flat_ids.insert((flat_id, named_provider));
			}
		}
		assert!(!flat_ids.is_empty(), "the catalog carries aggregator flat ids to check");
		for (flat_id, named_provider) in flat_ids {
			let resolved = catalog
				.model(omp_catalog::ModelKey::from_ref(flat_id))
				.or_else(|| catalog.resolve_alias(flat_id));
			if let Some(spec) = resolved {
				assert!(
					spec
						.key
						.as_str()
						.strip_prefix(named_provider)
						.is_some_and(|rest| rest.starts_with('/')),
					"`{flat_id}` must stay locked to `{named_provider}`, resolved `{}`",
					spec.key.as_str(),
				);
			}
		}
	}

	#[derive(Clone)]
	struct ScriptedParentClient {
		scripts: Arc<Mutex<VecDeque<Vec<inference_pb::TurnEvent>>>>,
		inputs:  Arc<Mutex<Vec<TurnInput>>>,
		options: Arc<Mutex<Vec<TurnOptions>>>,
	}

	struct ScriptedParentSession {
		events: VecDeque<Result<inference_pb::TurnEvent, omp_agent::Error>>,
	}

	impl TurnSession for ScriptedParentSession {
		fn events(
			&mut self,
		) -> impl Stream<Item = Result<inference_pb::TurnEvent, omp_agent::Error>> + Send + Unpin + '_
		{
			// Survive stream re-acquisition: yield each remaining scripted
			// event exactly once across repeated `events()` calls.
			futures::stream::poll_fn(|_| std::task::Poll::Ready(self.events.pop_front()))
		}

		fn submit(
			&mut self,
			_frame: InvokeFrame,
		) -> impl Future<Output = Result<(), omp_agent::Error>> + Send + '_ {
			future::ready(Ok(()))
		}
	}

	impl TurnClient for ScriptedParentClient {
		type Session<'client> = ScriptedParentSession;

		fn turn<'client>(
			&'client self,
			_turn_id: TurnId,
			input: TurnInput,
			options: &'client TurnOptions,
		) -> impl Future<Output = Result<Self::Session<'client>, omp_agent::Error>> + Send + 'client
		{
			self.inputs.lock().push(input);
			self.options.lock().push(options.clone());
			let script = self
				.scripts
				.lock()
				.pop_front()
				.expect("one scripted parent turn");
			future::ready(Ok(ScriptedParentSession {
				events: script.into_iter().map(Ok).collect::<VecDeque<_>>(),
			}))
		}
	}

	fn outcome_script(outcome: inference_pb::Outcome) -> Vec<inference_pb::TurnEvent> {
		vec![inference_pb::TurnEvent { event: Some(turn_event::Event::Outcome(outcome)) }]
	}

	fn parent_outcome(text: &str) -> inference_pb::Outcome {
		let mut output = bridge_message(Role::Assistant, text);
		output.seq = 1;
		inference_pb::Outcome {
			output: vec![output],
			stop: inference_pb::StopReason::StopEndTurn as i32,
			usage: Some(inference_pb::Usage::default()),
			cost: Some(inference_pb::Cost::default()),
			provider: "test".to_owned(),
			model: "scripted".to_owned(),
			..inference_pb::Outcome::default()
		}
	}

	fn write_session(sessions_dir: &Path, root: &Path, prompt: &str, title: Option<&str>) -> Str {
		let id = Str::from(omp_core::Ulid::generate().to_string());
		let path = sessions_dir.join(format!("{id}.jsonl"));
		let mut writer = Writer::create(&path, &Header {
			v:       4,
			id:      SessionId(id.clone()),
			created: 1,
			cwd:     root.to_owned(),
		})
		.expect("create transcript");
		writer
			.append(&Event {
				ts:   2,
				kind: Kind::Item(ItemRecord {
					item:        Item {
						seq:           0,
						created_at_ms: 2,
						kind:          Some(item::Kind::Message(Message {
							role:  i32::from(Role::User),
							parts: vec![Part { kind: Some(part::Kind::Text(prompt.to_owned())) }],
						})),
						props:         None,
					},
					turn_id:     None,
					prompt_hash: None,
				}),
			})
			.expect("append prompt");
		if let Some(title) = title {
			writer
				.append(&Event {
					ts:   3,
					kind: Kind::Title { title: Str::from(title), source: TitleSource::User },
				})
				.expect("append title");
		}
		drop(writer);
		id
	}

	#[test]
	fn chat_login_failure_names_provider_command_and_sanitized_detail() {
		use omp_inference::{
			error::{Error, ErrorKind, ErrorPhase, RetryAction},
			receipt::ExecutionReceipt,
		};

		let provider = omp_catalog::ProviderId::from_ref("kimi-code");
		let error = Error::new(
			ErrorKind::Authentication,
			ErrorPhase::Authentication,
			RetryAction::Never,
			ExecutionReceipt::default(),
		)
		.status(Some(401))
		.code(sf!("invalid_grant"))
		.detail(ErrorDetail::provider(sf!("device authorization expired")));
		let ChatLoginFailure::Message(message) = chat_login_failure(provider, &error) else {
			panic!("an authentication error is a plain login failure message");
		};
		assert!(message.contains("provider `kimi-code`"));
		assert!(message.contains("`/login kimi-code`"));
		assert!(message.contains("device authorization expired"));
		assert!(message.contains("401"));
		assert!(message.contains("invalid_grant"));
	}

	#[test]
	fn project_state_is_external_and_accepts_standard_permissions() {
		use std::os::unix::fs::PermissionsExt as _;

		let scratch = tempfile::tempdir().expect("scratch directory");
		let root = scratch.path().join("project");
		let metadata_dir = root.join(".omp");
		fs::create_dir_all(&metadata_dir).expect("project metadata");
		fs::set_permissions(&metadata_dir, fs::Permissions::from_mode(0o755))
			.expect("standard project metadata permissions");

		let state_dir = omp_env::project_state::directory(&scratch.path().join("data"), &root)
			.expect("project state path");
		let sessions_dir = state_dir.join("sessions");
		ensure_state_directory(&sessions_dir).expect("project state");
		fs::set_permissions(&state_dir, fs::Permissions::from_mode(0o755))
			.expect("standard project state permissions");
		fs::set_permissions(&sessions_dir, fs::Permissions::from_mode(0o755))
			.expect("standard session directory permissions");
		ensure_state_directory(&state_dir).expect("existing project state directory");
		ensure_state_directory(&sessions_dir).expect("existing session directory");

		assert!(!state_dir.starts_with(&root));
		assert_eq!(
			fs::metadata(&metadata_dir)
				.expect("project metadata")
				.permissions()
				.mode() & 0o777,
			0o755
		);
		assert_eq!(
			fs::metadata(&state_dir)
				.expect("project state")
				.permissions()
				.mode() & 0o777,
			0o755
		);

		let id = write_session(&sessions_dir, &root, "resume me", None);
		let path = sessions_dir.join(format!("{id}.jsonl"));
		fs::set_permissions(&path, fs::Permissions::from_mode(0o644))
			.expect("standard journal permissions");
		let session = open_session(
			&root,
			&sessions_dir,
			SessionOpen::Resume(&id),
			&Registry::new(),
			Some(Arc::new(
				SessionIndex::open(state_dir.join("sessions.sqlite3")).expect("session index"),
			)),
		)
		.expect("resume session");
		assert_eq!(session.id, id);
		assert_eq!(
			fs::metadata(path)
				.expect("session journal")
				.permissions()
				.mode() & 0o777,
			0o644
		);
	}

	#[test]
	fn resume_choices_use_titles_then_prompts_and_strip_terminal_controls() {
		let scratch = tempfile::tempdir().expect("scratch directory");
		let root = scratch.path().join("project");
		let sessions_dir = root.join("sessions");
		fs::create_dir_all(&sessions_dir).expect("session directory");
		let prompt_id = write_session(&sessions_dir, &root, "  first prompt\nignored", None);
		let titled_id = write_session(
			&sessions_dir,
			&root,
			"unused prompt",
			Some("\u{1b}[31mRenamed\u{1b}[0m\nignored"),
		);

		let choices = resume_choices(&sessions_dir, &root, Some(&titled_id)).expect("list sessions");
		assert_eq!(choices.len(), 2);
		let prompt = choices
			.iter()
			.find(|choice| choice.id == prompt_id)
			.expect("prompt-named session");
		assert_eq!(prompt.label, "first prompt");
		let titled = choices
			.iter()
			.find(|choice| choice.id == titled_id)
			.expect("title-named session");
		assert_eq!(titled.label, "Renamed");
		assert!(titled.detail.starts_with("current · "));
		let pinned = SessionId(prompt_id.clone());
		assert!(
			PinStore::new(&sessions_dir)
				.toggle(&pinned)
				.expect("pin prompt session")
		);
		let ordered =
			resume_choices(&sessions_dir, &root, Some(&titled_id)).expect("ordered sessions");
		assert_eq!(ordered[0].id, prompt_id);
		assert!(ordered[0].pinned);
		assert!(!ordered[1].pinned);
	}

	#[test]
	fn session_metadata_streams_past_torn_records_and_keeps_latest_title() {
		let scratch = tempfile::tempdir().expect("scratch directory");
		let root = scratch.path().join("project");
		let sessions_dir = root.join("sessions");
		fs::create_dir_all(&sessions_dir).expect("session directory");
		let id = write_session(&sessions_dir, &root, "first prompt", Some("Early title"));
		let path = sessions_dir.join(format!("{id}.jsonl"));

		// A malformed mid-file record, a later title, and a torn trailing append
		// must not stop the streamed probe or lose title updates behind them.
		let mut fixture = Vec::new();
		fixture.extend_from_slice(b"{not json}\n");
		omp_storage::transcript::write_line(
			&Event {
				ts:   4,
				kind: Kind::Title { title: sf!("Recovered title"), source: TitleSource::User },
			},
			&mut fixture,
		)
		.expect("title line encodes");
		fixture.extend_from_slice(b"\n{\"ts\":5,\"k\":\"title\",\"title\":\"torn");
		let mut file = OpenOptions::new()
			.append(true)
			.open(&path)
			.expect("append fixture");
		file.write_all(&fixture).expect("append torn records");
		drop(file);

		let metadata = session_metadata(&path).expect("probe survives torn records");
		assert_eq!(metadata.header.id.0, id);
		assert_eq!(metadata.label.expect("latest title wins").as_str(), "Recovered title");
		assert!(metadata.has_entries, "real entries behind torn records still count");
	}

	/// Port of pi issue #8860: never advertise resuming a session that has no
	/// persisted conversation. Journals are created eagerly with a lone header
	/// line, so a launch-then-quit leaves an empty shell on disk; the resume
	/// picker must skip it until an actual journal entry lands.
	#[test]
	fn resume_choices_skip_header_only_sessions() {
		let scratch = tempfile::tempdir().expect("scratch directory");
		let root = scratch.path().join("project");
		let sessions_dir = root.join("sessions");
		fs::create_dir_all(&sessions_dir).expect("session directory");

		// An eagerly created, immediately abandoned session: header only.
		let empty_id = Str::from(omp_core::Ulid::generate().to_string());
		let empty_path = sessions_dir.join(format!("{empty_id}.jsonl"));
		drop(
			Writer::create(&empty_path, &Header {
				v:       4,
				id:      SessionId(empty_id.clone()),
				created: 1,
				cwd:     root.clone(),
			})
			.expect("create header-only transcript"),
		);
		let probe = session_metadata(&empty_path).expect("header-only journal still probes");
		assert!(!probe.has_entries, "a lone header carries no entries");

		// A session with persisted conversation is still advertised.
		let real_id = write_session(&sessions_dir, &root, "kept prompt", None);

		let choices = resume_choices(&sessions_dir, &root, None).expect("list sessions");
		assert_eq!(choices.len(), 1, "header-only session must not be advertised");
		assert_eq!(choices[0].id, real_id);

		// The current session is not exempt: an empty current session resumes
		// to nothing and must not be offered either.
		let current = resume_choices(&sessions_dir, &root, Some(&empty_id)).expect("list sessions");
		assert!(current.iter().all(|choice| choice.id != empty_id));
	}

	#[test]
	fn session_metadata_rejects_files_without_a_valid_header() {
		let scratch = tempfile::tempdir().expect("scratch directory");
		let empty = scratch.path().join("empty.jsonl");
		fs::write(&empty, b"").expect("empty fixture");
		assert!(session_metadata(&empty).is_none());

		let garbage = scratch.path().join("garbage.jsonl");
		fs::write(&garbage, b"{not a header}\n{\"ts\":1,\"k\":\"reset\"}\n")
			.expect("garbage fixture");
		assert!(session_metadata(&garbage).is_none());
	}

	#[test]
	fn resume_repairs_torn_trailing_append() {
		let scratch = tempfile::tempdir().expect("scratch directory");
		let root = scratch.path().join("project");
		let sessions_dir = root.join("sessions");
		fs::create_dir_all(&sessions_dir).expect("session directory");
		let id = write_session(&sessions_dir, &root, "resume me", None);
		let path = sessions_dir.join(format!("{id}.jsonl"));
		let mut file = OpenOptions::new()
			.append(true)
			.open(&path)
			.expect("append torn fragment");
		file
			.write_all(br#"{"ts":9,"k":"title","title":"tor"#)
			.expect("write torn fragment");
		drop(file);

		let session = open_session(
			&root,
			&sessions_dir,
			SessionOpen::Resume(&id),
			&Registry::new(),
			Some(Arc::new(
				SessionIndex::open(scratch.path().join("sessions.sqlite3")).expect("session index"),
			)),
		)
		.expect("torn session resumes");
		assert_eq!(session.id, id);
		let log = session.journal.load().expect("repaired journal loads");
		assert_eq!(log.log().len(), 1, "the torn fragment is truncated, intact events remain");
	}

	#[tokio::test]
	async fn session_bound_parent_runs_live_completion_and_agent_turns() {
		let scratch = tempfile::tempdir().expect("chat parent scratch");
		let root = scratch.path().join("project");
		let sessions_dir = root.join("sessions");
		fs::create_dir_all(&sessions_dir).expect("session directory");
		let inputs = Arc::new(Mutex::new(Vec::new()));
		let options = Arc::new(Mutex::new(Vec::new()));
		let client = ScriptedParentClient {
			scripts: Arc::new(Mutex::new(VecDeque::from([
				outcome_script(parent_outcome("completion answer")),
				outcome_script(parent_outcome("agent answer")),
				outcome_script(parent_outcome("follow-up answer")),
			]))),
			inputs:  Arc::clone(&inputs),
			options: Arc::clone(&options),
		};
		let registry = Arc::new(Registry::new());
		let mut snapshot = AgentSnapshot::new(
			TurnOptions::default(),
			PromptFacts::new(&root, Arc::from([]))
				.props()
				.expect("test prompt facts"),
			registry,
		);
		snapshot.enabled_tools = Arc::from([sf!("eval")]);
		let state = AgentState::new(snapshot);
		let (env, _transport) = EnvClient::in_process(1);
		let host = ChatParentHost::new(
			client,
			env,
			state,
			sf!("parent-session"),
			sessions_dir,
			root,
			Arc::new(
				SessionIndex::open(scratch.path().join("sessions.sqlite3")).expect("session index"),
			),
			false,
		);
		host
			.tree()
			.register(
				sf!("parent-session"),
				sf!("Main"),
				AgentKind::Main,
				None,
				sf!("parent-session"),
				Budget::default(),
			)
			.expect("root registration");

		let completion = ParentSessionHost::completion(
			&host,
			json!({"prompt":"complete this","model":"default"}),
			&omp_envd::eval::NoopBridgeProgress,
		)
		.await
		.expect("live completion call");
		assert_eq!(completion["text"], "completion answer");

		let concurrency = ParentSessionHost::concurrency(&host, json!({}))
			.await
			.expect("concurrency bridge call");
		assert_eq!(concurrency, json!({ "limit": DEFAULT_EVAL_CONCURRENCY_LIMIT }));

		let agent = time::timeout(
			Duration::from_secs(1),
			ParentSessionHost::agent(
				&host,
				json!({"prompt":"delegate this","agent":"task"}),
				&omp_envd::eval::NoopBridgeProgress,
			),
		)
		.await
		.expect("child agent must not deadlock on the occupied parent eval kernel")
		.expect("live agent call");
		assert_eq!(agent["text"], "agent answer");
		assert_eq!(agent["details"]["agent"], "task");
		let stable_id = agent["details"]["id"]
			.as_str()
			.filter(|id| !id.is_empty())
			.expect("agent bridge did not return its durable child id");
		let follow_up = ParentSessionHost::agent(
			&host,
			json!({"prompt":"follow up","agent":"task","stableId":stable_id}),
			&omp_envd::eval::NoopBridgeProgress,
		)
		.await
		.expect("retained child follow-up");
		assert_eq!(follow_up["text"], "follow-up answer");
		assert_eq!(follow_up["details"]["id"], stable_id);
		assert_eq!(follow_up["details"]["followUp"], true);

		let options = options.lock();
		assert_eq!(options.len(), 3);
		assert!(
			options[1]
				.params
				.tools
				.iter()
				.all(|tool| tool.name != "eval"),
			"child agent must not advertise the parent's occupied eval kernel"
		);
		drop(options);
		let inputs = inputs.lock();
		assert_eq!(inputs.len(), 3);
		assert!(matches!(&inputs[0], TurnInput::Full(thread)
			if bridge_outcome_text(&inference_pb::Outcome {
				output: thread.items.clone(),
				..inference_pb::Outcome::default()
			}) == "complete this"
		));
		assert!(matches!(&inputs[1], TurnInput::Full(thread)
			if thread.items.iter().any(|item| matches!(
				&item.kind,
				Some(item::Kind::Message(message))
					if message.role == i32::from(Role::User)
						&& message.parts.iter().any(|part| matches!(
							&part.kind,
							Some(part::Kind::Text(text)) if text == "delegate this"
						))
			))
		));
		assert!(matches!(&inputs[2], TurnInput::Full(thread)
			if thread.items.iter().any(|item| matches!(
				&item.kind,
				Some(item::Kind::Message(message))
					if message.role == i32::from(Role::User)
						&& message.parts.iter().any(|part| matches!(
							&part.kind,
							Some(part::Kind::Text(text)) if text == "follow up"
						))
			))
		));
	}
	#[tokio::test]
	async fn advisor_child_runs_scripted_batch_and_queues_advice() {
		let scratch = tempfile::tempdir().expect("advisor scratch");
		let root = scratch.path().join("project");
		let sessions_dir = root.join("sessions");
		fs::create_dir_all(&sessions_dir).expect("session directory");
		let advise_call = inference_pb::Outcome {
			output: vec![Item {
				seq:           3,
				created_at_ms: 1,
				kind:          Some(item::Kind::ToolCall(omp_proto::thread::v1::ToolCall {
					id: "advise-1".to_owned(),
					name: "advise".to_owned(),
					args_json:
						br#"{"note":"verify the failing build before merging","severity":"concern"}"#
							.to_vec()
							.into(),
					..Default::default()
				})),
				props:         Some(inference_pb::ValueMap {
					fields: BTreeMap::from([(
						omp_tool::TOOL_REV_PROP.to_owned(),
						inference_pb::Value {
							kind: Some(inference_pb::value::Kind::String("1".to_owned())),
						},
					)]),
				}),
			}],
			stop: inference_pb::StopReason::StopToolUse as i32,
			usage: Some(inference_pb::Usage::default()),
			cost: Some(inference_pb::Cost::default()),
			revision: Some(omp_proto::thread::v1::Revision { head: 3, token: vec![4; 32].into() }),
			provider: "test".to_owned(),
			model: "scripted".to_owned(),
			..inference_pb::Outcome::default()
		};
		let advise_script = vec![
			inference_pb::TurnEvent {
				event: Some(turn_event::Event::PartStart(inference_pb::PartStart {
					index:        0,
					kind:         inference_pb::part_start::Kind::ToolCall as i32,
					tool_call_id: "advise-1".to_owned(),
					tool_name:    "advise".to_owned(),
				})),
			},
			inference_pb::TurnEvent {
				event: Some(turn_event::Event::PartDelta(inference_pb::PartDelta {
					index: 0,
					chunk: br#"{"note":"verify the failing build before merging","severity":"concern"}"#
						.to_vec()
						.into(),
				})),
			},
			inference_pb::TurnEvent {
				event: Some(turn_event::Event::PartEnd(inference_pb::PartEnd {
					index:     0,
					signature: Default::default(),
				})),
			},
			inference_pb::TurnEvent { event: Some(turn_event::Event::Outcome(advise_call)) },
		];
		let mut final_outcome = parent_outcome("advisor reviewed the update");
		final_outcome.output[0].seq = 5;
		final_outcome.revision =
			Some(omp_proto::thread::v1::Revision { head: 5, token: vec![5; 32].into() });
		let inputs = Arc::new(Mutex::new(Vec::new()));
		let client = ScriptedParentClient {
			scripts: Arc::new(Mutex::new(VecDeque::from([
				advise_script,
				outcome_script(final_outcome),
			]))),
			inputs:  Arc::clone(&inputs),
			options: Arc::new(Mutex::new(Vec::new())),
		};
		let queue = omp_agent::advisor::AdvisorAdviceQueue::default();
		let mut advisor_registry = Registry::new();
		advisor_registry
			.register(
				omp_agent::advisor::advise_tool(queue.clone()),
				omp_tool::Presentation::Hidden,
				omp_tool::Claims {
					precedence: omp_tool::Precedence::CORE,
					claimant:   sf!("omp/advisor"),
					replaces:   None,
				},
			)
			.expect("register advise device");
		let registry = Arc::new(advisor_registry);
		let snapshot = AgentSnapshot::new(
			TurnOptions::default(),
			PromptFacts::new(&root, Arc::from([]))
				.props()
				.expect("test prompt facts"),
			registry,
		);
		let state = AgentState::new(snapshot);
		let (env, transport) = EnvClient::in_process(1);
		// Serve the advise invocation protocol the way envd's device host
		// would: acknowledge InvokeTool, submit committed args to the shared
		// session queue, and answer with a terminal verdict.
		let (env_requests, env_responses) = transport.into_parts();
		let served_queue = queue.clone();
		let invoked_tool = Arc::new(Mutex::new(None::<String>));
		let invoked_record = Arc::clone(&invoked_tool);
		tokio::spawn(async move {
			use omp_env::frame::{self, client_frame, server_frame};
			let mut invoke_request = None;
			while let Ok(env_frame) = env_requests.recv_async().await {
				match env_frame.body {
					Some(client_frame::Body::InvokeTool(invoke)) => {
						*invoked_record.lock() = Some(invoke.name.clone());
						invoke_request = Some(env_frame.request_id);
					},
					Some(client_frame::Body::ArgsCommitted(committed)) => {
						let params: Value =
							serde_json::from_slice(&committed.raw).expect("committed advise args");
						let note = params["note"].as_str().unwrap_or_default();
						let severity = match params["severity"].as_str() {
							Some("blocker") => omp_agent::advisor::AdviceSeverity::Blocker,
							Some("concern") => omp_agent::advisor::AdviceSeverity::Concern,
							_ => omp_agent::advisor::AdviceSeverity::Nit,
						};
						let admission = served_queue.submit(note, severity);
						let Some(request_id) = invoke_request else {
							continue;
						};
						let _ = env_responses
							.send_async(frame::ServerFrame {
								request_id,
								body: Some(server_frame::Body::Verdict(frame::Verdict {
									invocation_id: committed.invocation_id.clone(),
									json: format!(
										"{{\"kind\":\"ok\",\"value\":{{\"admission\":\"{admission}\"}}}}"
									)
									.into_bytes()
									.into(),
									parts: vec![omp_proto::thread::v1::Part {
										kind: Some(part::Kind::Text("Recorded.".to_owned())),
									}],
									..Default::default()
								})),
								..Default::default()
							})
							.await;
					},
					_ => {},
				}
			}
		});
		let host = ChatParentHost::new(
			client,
			env,
			state,
			sf!("parent-session"),
			sessions_dir,
			root,
			Arc::new(
				SessionIndex::open(scratch.path().join("sessions.sqlite3")).expect("session index"),
			),
			false,
		);
		host
			.tree()
			.register(
				sf!("parent-session"),
				sf!("Main"),
				AgentKind::Main,
				None,
				sf!("parent-session"),
				Budget::default(),
			)
			.expect("root registration");

		let child_id = host
			.spawn_advisor(AdvisorChildSpec {
				id:            sf!("default"),
				display_name:  sf!("Advisor"),
				model:         sf!("test/scripted"),
				tools:         Vec::new(),
				system_prompt: sf!("You observe another agent's session."),
			})
			.await
			.expect("spawn advisor child");
		let outcome = time::timeout(
			Duration::from_secs(10),
			host.run_advisor_batch(
				child_id.as_str(),
				vec![sf!("### Session update\n\nThe primary agent edited build.rs")],
				TurnId::new("advisor-batch-1"),
			),
		)
		.await
		.expect("advisor batch must not hang")
		.expect("advisor batch");
		assert_eq!(outcome.final_text, "advisor reviewed the update");
		assert_eq!(invoked_tool.lock().as_deref(), Some("advise"));
		let queued = queue.drain_ready();
		assert_eq!(queued.len(), 1);
		assert_eq!(queued[0].note, "verify the failing build before merging");
		assert_eq!(queued[0].severity, omp_agent::advisor::AdviceSeverity::Concern);
	}
}
#[cfg(test)]
mod protocol_tests {
	use omp_inference::ToolGrammar;

	use super::*;

	#[test]
	fn native_edit_lark_grammar_is_lossless_in_turn_protocol() {
		const EDIT_GRAMMAR: &str =
			"start: begin_patch op+ end_patch\ncontent_line: /[^§«»\\n][^\\n]*/ LF";
		let tool = ToolDefinition {
			name:        sf!("edit"),
			description: Some(sf!("Sparse edit")),
			input:       ToolInputConstraint::Grammar {
				grammar:  ToolGrammar {
					syntax:     ToolGrammarSyntax::Lark,
					definition: Str::new_static(EDIT_GRAMMAR),
				},
				fallback: omp_inference::OpaqueJson::new(serde_json::json!({"type": "object"})),
			},
		};

		let projected = protocol_tool_definition(tool).expect("edit grammar projects");
		let Some(tool_def::Input::Grammar(grammar)) = projected.input else {
			panic!("edit must remain a native grammar tool");
		};
		assert_eq!(grammar.syntax, grammar::Syntax::Lark as i32);
		assert_eq!(grammar.definition, EDIT_GRAMMAR);
		assert_eq!(grammar.fallback_schema_json.as_ref(), br#"{"type":"object"}"#);
	}
}
