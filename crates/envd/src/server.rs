//! Transport-neutral `env/v1` dispatch and owner-local UDS serving.

use std::{
	collections::{BTreeMap, BTreeSet, HashMap},
	fs, future, io, mem,
	ops::ControlFlow,
	path::{Path, PathBuf},
	pin, process, str, sync,
	sync::{
		Arc, Weak,
		atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
	},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::{Bytes, BytesMut};
use flume::Receiver;
use futures::StreamExt as _;
use omp_agent::{
	ApprovalBook, ApprovalRoute, ApprovalSpec, HookGate, KernelSender, SessionRole, TicketState,
};
use omp_cache::{github_cache::GithubCache, telemetry_cache::TelemetryIndex};
use omp_con::Ctx;
use omp_core::{Hash32, Str, Ulid, sf};
use omp_env::{EnvClient, InProcessEnvTransport, partition::FramePipe};
use omp_journal::blob;
use omp_proto::{
	blob::v1 as blob_pb,
	document::v1::{self as document_pb, commit_transaction_response, document_target},
	env::v1::{
		self as pb, client_frame, data_event, data_request, data_response, document_result,
		exec_session_op, mcp_op, mcp_result, privileged_mutation_intent, send_input, server_frame,
		stdin_frame, workspace_result,
	},
	inference::v1::{Value, ValueMap, value},
	policy::v1 as policy_pb,
	prost::Message as _,
	thread::v1 as thread_pb,
	ui::v1::UiDispatchResult,
};
use omp_tool::{
	Abort, ArgIssue, ArgPath, CallOutcome, Effects, ErasedEv, ErasedOutcome, IncomingParams,
	Interrupt, Registry, RegistryError, ToolRoute, ToolTerminal,
};
use omp_tools::{
	ask::PresenterSlot,
	device::{DeviceInvokeRequest, DeviceInvoker},
	eval::EvalSessionControl,
	read,
	read::{
		resolver::{self as resolver, ResolverTable, ResourceCapability, ResourceCompletion},
		selector::{self, ParsedUri},
	},
	staging::StagedProposalRegistry,
};
use omp_walker::{
	CompiledWalkGlob, DirectoryErrorMode, FileType, FollowLinks, WalkDetail, WalkFilter,
	WalkOptions, WalkOrder, WalkRequest, WalkStatus,
};
use parking_lot::Mutex;
use serde_json::value::RawValue;
use thiserror::Error;
#[cfg(any(unix, windows))]
use tokio::sync::watch;
use tokio::{
	io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _, duplex, split},
	task::{self, JoinError, JoinHandle},
	time::{self, Instant, Sleep},
};
#[cfg(unix)]
use tokio::{
	net::{UnixListener, UnixStream},
	signal::{
		ctrl_c,
		unix::{SignalKind, signal},
	},
	task::JoinSet,
};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::{
	admission::{AdmissionDecision, AdmissionGate, ApprovalPolicy, effects_narrow_or_refuse},
	blobs::{BlobError, BlobHost, BlobId, BlobRead},
	browser_daemon::BrowserSettings,
	docs::{
		AcpDocumentBackend, DapRegistryEvent, DocumentError, DocumentEvents, DocumentHost,
		DocumentLease, LspEvents, LspRegistryEvent,
	},
	eval::{
		BridgeHostError, ParentBindingLease, ParentSessionHost, PreludeInvoker, SessionBridgeHost,
	},
	exec::{ExecError, ExecEvent, ExecHost, ExecRun, ProcessEvent},
	exec_settings::{AcpSettings, SandboxSettings, ShellSettings},
	exthost::{ExtensionManifest, control::CompositeControlAuthority, lifecycle::EscapeCapability},
	github_url::GithubCredentialBridge,
	host_info::HostInfoHost,
	host_settings::HostSettings,
	http_egress::{HttpEgressError, HttpEgressHost},
	journal_runtime::DurableScheduleActor,
	lsp_settings::LspSettings,
	mcp::{
		McpConfigPaths, McpService, McpServiceError, ServiceSubscription, SubscriptionEvent,
		control::McpControl,
		manager::{McpManager, ProductionConnector},
		settings::McpSettings,
	},
	memory,
	memory::{ReflectionBridgeHost, RegisteredMemoryRuntime},
	policy::{
		AuthorityTable, DataAuthority, Grants, PolicyError, QuotaAccount, dap_command_capability,
		lsp_notification_tier, lsp_request_tier, lsp_tier_capability,
	},
	presence::{PresenceError, PresenceLease, PresenceRegistry},
	process_store::{ProcessStore, ShutdownAcknowledgement},
	resource_materializer::{MaterializationError, ResourceMaterializer},
	schedules::{DurableScheduleError, ScheduleDeliveryBackend},
	search_backend::SearchBridgeHost,
	site::{SiteError, SiteMaterializer, record_modules},
	tool_document::{PrivilegedMutationFault, privileged_unlink, privileged_write},
	tool_settings::{ApprovalMode, GithubCacheSettings, ToolSettings},
	tool_shell::{AcpExecBackend, AcpExecSlot},
	tool_url::UrlResolver,
	tools::{
		AgentCheckpointControl, InvocationAcpBackends, InvocationEditRepairContext,
		SessionRegistryBridges, build_environment_declaration_inputs, production_registry,
		session_registry, with_acp_scope, with_edit_repair_scope, with_invocation_scope,
		with_invocation_session_scope, with_output_request_scope,
	},
	vcs::{self, RepositoryAvailability},
	worker::{
		DEFAULT_MAX_FRAME_BYTES, DomainControlSlot, ExtHostCompletion, ExtHostConfig, ExtHostError,
		ExtHostEvent, ExtHostInvocation, ExtHostOutcomeKind, ExtHostSpec, ExtHostSupervisor,
		ExtHostToolCall, ExternalControlAuthorityBinding, ExternalDomainControlBinding,
		ExternalDomainControlFactories, HostKey,
	},
	worker_pool::{
		DEFAULT_MAX_CONCURRENT_SPAWNS, DEFAULT_WORKER_LAYER_CEILING, WorkerKey, WorkerRoute,
		WorkerSupervisor, WorkerUnavailable,
	},
	workspace::{
		WorkspaceError, WorkspaceHost, WorkspaceOperationError, WorkspaceOperations,
		WorkspaceSearchCase, WorkspaceSearchOptions,
	},
	workspace_roots::WorkspaceRootHost,
};
#[cfg(any(unix, windows))]
use crate::docserver::connection::ConnectionConfig;
#[cfg(unix)]
use crate::docserver::daemon;
#[cfg(windows)]
use crate::docserver::windows::OwnerPipeListener;
use crate::{
	EnvdConfig, RegistryBridges, authenticated_runtime_identity,
	exthost::{
		ControlAuthority, ControlAuthorityFactory, ControlCompositionError, ControlQuotaRuntime,
		EnvdControlAuthorities, ExternalControlAuthorities, HostControlAuthorityFactory,
		PersistenceControlAuthorities, PolicyControlAuthorities, PresentationControlAuthorities,
		ProviderControlAuthorities, RegistryAvailabilitySink, RegistryControlAuthorities,
		control::{
			ControlConnectionIdentity, ControlDispatch, ControlEffect, ControlProtocolError,
			ControlRequestContext, FixedControlAuthorityFactory,
		},
		dispatch::{CallbackDispatcher, CallbackDispatcherSlot, UiCallbackDispatch},
		extensions::SealedRegistryEvidence,
	},
	tools::{
		DeviceCatalogObserver, DeviceControlFactory, DeviceInvocationAdmission,
		DynamicDeviceCatalogEntry, HookControlFactory, RegistryControlFactory,
	},
	worker::AgentsControlAuthorityBinding,
};

const MIN_SCHEMA_REV: u32 = 4;
const FRAME_LIMIT: usize = 64 * 1024 * 1024;
const BLOB_CHUNK_BYTES: usize = 64 * 1024;
const DEFAULT_TOOL_DEADLINE: Duration = Duration::from_secs(300);
const PRELUDE_CALL_DEADLINE: Duration = Duration::from_secs(600);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const NATIVE_CANCEL_GRACE: Duration = Duration::from_millis(250);
const INVOCATION_RESPONSE_SEND_GRACE: Duration = Duration::from_millis(250);
const MAX_RESOURCE_URI_BYTES: usize = 8 * 1024;
const MAX_RESOURCE_READ_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESOURCE_LIST_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESOURCE_ENTRIES: usize = 4_096;
const MAX_RESOURCE_COMPLETIONS: usize = 100;
static NEXT_AGENT_CONTROL_BINDING: AtomicU64 = AtomicU64::new(1);
fn unknown_tool_message(name: &str) -> &'static str {
	if name == "eval" {
		"eval is disabled; restart the project daemon with --py-eval (omp envd)"
	} else {
		"tool name and revision are not registered; project daemon settings differ; restart omp envd \
		 after changing tool settings"
	}
}

#[derive(Clone, Debug, Default)]
struct InvocationExecutionPolicy {
	tool:           Str,
	plan:           bool,
	plan_yolo:      bool,
	core_admission: bool,
}

impl InvocationExecutionPolicy {
	fn from_request(request: &pb::InvokeTool) -> Self {
		let props = request.props.as_ref();
		let mode = props
			.and_then(|props| props.fields.get("omp/execution-mode"))
			.and_then(|value| value.kind.as_ref())
			.and_then(|kind| match kind {
				value::Kind::String(value) => Some(value.as_str()),
				_ => None,
			});
		let plan_yolo = props
			.and_then(|props| props.fields.get("omp/plan-yolo"))
			.and_then(|value| value.kind.as_ref())
			.is_some_and(|kind| matches!(kind, value::Kind::Bool(true)));
		let core_admission = props
			.and_then(|props| props.fields.get("omp/core-admission"))
			.and_then(|value| value.kind.as_ref())
			.is_some_and(|kind| matches!(kind, value::Kind::Bool(true)));
		Self {
			tool: Str::from(request.name.as_str()),
			plan: mode == Some("plan"),
			plan_yolo,
			core_admission,
		}
	}

	fn denial(&self, effects: &Effects, raw: &[u8]) -> Option<Str> {
		if !self.plan
			|| !omp_tool::effects_mutate_environment(effects)
			|| self.plan_yolo
			|| plan_exempt_target(&self.tool, raw)
		{
			return None;
		}
		Some(sf!(
			"plan mode denied a mutating tool call at the Environment boundary; write plan and \
			 scratch artifacts under local:// (vault:// and sandbox:// are also exempt), or exit \
			 plan mode before changing the workspace",
		))
	}
}

fn plan_exempt_target(tool: &str, raw: &[u8]) -> bool {
	let Ok(value) = serde_json::from_slice::<serde_json::Value>(raw) else {
		return false;
	};
	let mut targets = Vec::new();
	collect_plan_targets(tool, &value, &mut targets);
	!targets.is_empty() && targets.into_iter().all(exempt_plan_path)
}

fn collect_plan_targets<'a>(tool: &str, value: &'a serde_json::Value, targets: &mut Vec<&'a str>) {
	match value {
		serde_json::Value::Object(fields) => {
			for (key, value) in fields {
				if matches!(key.as_str(), "path" | "target" | "file" | "cwd")
					&& let Some(path) = value.as_str()
				{
					targets.push(path);
				} else if tool == "edit"
					&& key == "input"
					&& let Some(patch) = value.as_str()
				{
					for line in patch.lines() {
						if let Some(header) = line
							.strip_prefix('[')
							.and_then(|line| line.split_once('#'))
							.map(|(path, _)| path)
						{
							targets.push(header);
						}
					}
				} else {
					collect_plan_targets(tool, value, targets);
				}
			}
		},
		serde_json::Value::Array(values) => {
			for value in values {
				collect_plan_targets(tool, value, targets);
			}
		},
		_ => {},
	}
}

fn exempt_plan_path(path: &str) -> bool {
	["local://", "vault://", "sandbox://"]
		.iter()
		.any(|prefix| path.starts_with(prefix))
}

/// Environment-daemon assembly or serving failure.
#[derive(Debug, Error)]
pub enum EnvdError {
	/// A local filesystem, socket, or child-process operation failed.
	#[error(transparent)]
	Io(#[from] io::Error),
	/// The document authority could not be connected or verified.
	#[error("document authority failed: {0}")]
	Document(Str),
	/// The canonical workspace could not be opened.
	#[error("workspace host failed: {0}")]
	Workspace(Str),
	/// The content-addressed blob store could not be opened.
	#[error("blob host failed: {0}")]
	Blob(Str),
	/// The scoped exec materialization store could not be opened.
	#[error(transparent)]
	Materialization(#[from] MaterializationError),
	/// Durable named-process supervision could not be initialized.
	#[error(transparent)]
	Exec(#[from] ExecError),
	/// The non-session durable state authority could not be opened.
	#[error("state authority failed: {0}")]
	State(Str),
	/// The owner's `~/.o2` configuration root could not be resolved.
	#[error("user configuration root could not be resolved")]
	ConfigRoot(#[from] omp_core::dirs::DataDirError),
	/// The embedded Python runtime used by `eval` could not be initialized.
	#[error("eval runtime failed: {0}")]
	Eval(Str),
	/// A Python extension host could not be started or supervised.
	#[error(transparent)]
	ExtensionHost(#[from] ExtHostError),
	/// The durable schedule authority failed or was generation-fenced.
	#[error(transparent)]
	Schedule(#[from] DurableScheduleError),
	/// A native or worker tool declaration could not be registered.
	#[error(transparent)]
	Registry(#[from] RegistryError),
	/// An admitted extension setting could not be installed as a convar.
	#[error(transparent)]
	ExtensionConvar(#[from] crate::exthost::ExtensionConvarError),
	/// A worker advertised a declaration that cannot have a stable registry
	/// identity.
	#[error("invalid worker tool declaration: {0}")]
	WorkerDeclaration(Str),
	/// A worker advertised a malformed or incompatible protocol argument schema.
	#[error("invalid worker tool declaration schema")]
	WorkerProtocolSchema(#[from] omp_tool::ProtocolSchemaError),
	/// The selected edit dialect was not a registered built-in revision.
	#[error("invalid edit dialect: {0}")]
	EditDialect(Str),
	/// Production assembly encountered a second live declaration for one name.
	#[error("duplicate production tool name: {0}")]
	DuplicateToolName(Str),
	/// The environment client could not complete its protocol handshake.
	#[error(transparent)]
	Client(#[from] omp_env::ClientError),
	/// A session host was opened before its owner completed the hello exchange.
	#[error("session host owner has not completed the environment hello handshake")]
	MissingOwnerHello,
	/// Daemon-owned client presence could not be updated.
	#[error(transparent)]
	Presence(#[from] PresenceError),
	/// A spawned environment connection task failed.
	#[error("environment connection task failed: {0}")]
	Task(#[from] JoinError),
	/// The embedded document authority exited before accepting a verified hello.
	#[error("embedded document authority exited before its hello handshake")]
	DocserverExited,
	/// Another process still holds this project's document authority.
	#[error(
		"project document authority for {path:?} is held by another process (holder pid: {holder:?})"
	)]
	DocumentAuthorityHeldBy {
		/// Canonical project path whose authority is held.
		path:   PathBuf,
		/// Best-effort owner process identifier, when available.
		holder: Option<u32>,
	},
}

impl From<DocumentError> for EnvdError {
	fn from(error: DocumentError) -> Self {
		Self::Document(Str::from(error.to_string()))
	}
}

impl From<WorkspaceError> for EnvdError {
	fn from(error: WorkspaceError) -> Self {
		Self::Workspace(Str::from(error.to_string()))
	}
}

impl From<BlobError> for EnvdError {
	fn from(error: BlobError) -> Self {
		Self::Blob(Str::from(error.to_string()))
	}
}

impl From<WorkspaceOperationError> for EnvdError {
	fn from(error: WorkspaceOperationError) -> Self {
		Self::Workspace(Str::from(error.to_string()))
	}
}

/// Identity advertised by every transport served from one environment.
#[derive(Clone, Debug)]
pub struct ServerIdentity {
	/// Canonical document workspace identity.
	pub workspace_id:   Bytes,
	/// Canonical workspace root URI.
	pub root_uri:       Str,
	/// Epoch of the connected document authority.
	pub server_epoch:   Bytes,
	/// Human-readable server build version.
	pub server_version: Str,
	/// Executable-generation identity of the serving environment.
	pub server_build:   Str,
}

/// Per-connection transport and exact DATA grant bounds.
#[derive(Clone)]
pub(crate) struct ConnectionPolicy {
	retire: Option<CancellationToken>,
	grants: Grants,
	host:   Option<HostKey>,
}

impl ConnectionPolicy {
	fn in_process() -> Self {
		Self { retire: None, grants: Grants::all(), host: None }
	}

	/// Grants owner-local lifecycle traffic while retaining DATA phase checks.
	pub(crate) fn external(retire: Option<CancellationToken>) -> Self {
		Self { retire, grants: Grants::all(), host: None }
	}

	/// Restricts an extension-host connection to explicitly granted, reachable
	/// DATA capabilities.
	pub(crate) fn extension<I, S>(host: HostKey, grants: I) -> Self
	where
		I: IntoIterator<Item = S>,
		S: AsRef<str>,
	{
		Self { retire: None, grants: Grants::supported(grants), host: Some(host) }
	}
}

struct AcceptedHello {
	grants:        Grants,
	capabilities:  BTreeSet<Str>,
	props:         Option<ValueMap>,
	approval_mode: Option<ApprovalMode>,
}

fn approval_mode_from_wire(value: i32) -> Result<Option<ApprovalMode>, i32> {
	match pb::ApprovalMode::try_from(value).map_err(|_| value)? {
		pb::ApprovalMode::Unspecified => Ok(None),
		pb::ApprovalMode::AlwaysAsk => Ok(Some(ApprovalMode::AlwaysAsk)),
		pb::ApprovalMode::Write => Ok(Some(ApprovalMode::Write)),
		pb::ApprovalMode::Yolo => Ok(Some(ApprovalMode::Yolo)),
	}
}

/// One extension host's isolated DATA listener identity and grants.
#[derive(Debug)]
#[doc(hidden)]
pub struct ExtensionDataBinding {
	key:               HostKey,
	path:              PathBuf,
	grants:            Grants,
	#[cfg(unix)]
	prepared_listener: Option<std::os::unix::net::UnixListener>,
}

impl ExtensionDataBinding {
	/// Derives the deterministic owner-local socket path and the exact
	/// built-in extension DATA grant set for `key`.
	pub(crate) fn built_in(
		state_dir: &Path,
		key: HostKey,
		session_id: &str,
		session_generation: u64,
	) -> Self {
		Self::scoped(
			state_dir,
			key,
			session_id,
			session_generation,
			Grants::supported([
				"env.doc.read",
				"env.doc.write",
				"env.fs.read",
				"env.fs.write",
				"env.exec",
				"env.process",
				"env.blob",
				"env.search",
				"env.lsp",
				"env.net",
				"env.workspace.snapshot",
				"env.worktree",
			]),
		)
	}

	/// Derives one private endpoint carrying only the manifest-derived grants
	/// admitted for `key`.
	pub fn scoped(
		state_dir: &Path,
		key: HostKey,
		session_id: &str,
		session_generation: u64,
		grants: Grants,
	) -> Self {
		#[cfg(unix)]
		let path = omp_env::project_state::extension_socket(
			state_dir,
			key.layer().as_str(),
			key.tier().as_str(),
			key.extension().as_str(),
			session_id,
			session_generation,
		);
		#[cfg(not(unix))]
		let path = {
			let mut hasher = Hash32::hasher();
			hasher.update(b"omp/extension-data-binding/v1");
			hasher.update((session_id.len() as u64).to_le_bytes());
			hasher.update(session_id.as_bytes());
			hasher.update(session_generation.to_le_bytes());
			for field in key.fields() {
				hasher.update((field.len() as u64).to_le_bytes());
				hasher.update(field.as_bytes());
			}
			PathBuf::from(format!("extension-data-{}", hasher.finalize().to_hex()))
		};
		Self {
			key,
			path,
			grants,
			#[cfg(unix)]
			prepared_listener: None,
		}
	}

	/// Returns the socket path passed only to this binding's child.
	pub fn path(&self) -> &Path {
		&self.path
	}

	/// Materializes the generated socket inode before sandbox policy
	/// compilation.
	///
	/// The real DATA server takes over this listener after the extension host
	/// has been admitted, preserving the inode granted to Linux sandboxes.
	#[cfg(unix)]
	pub fn prepare_endpoint(&mut self) -> io::Result<()> {
		use std::os::unix::fs::PermissionsExt as _;

		let parent = self.path.parent().ok_or_else(|| {
			io::Error::new(io::ErrorKind::InvalidInput, "extension DATA socket has no parent")
		})?;
		ensure_directory(parent)?;
		let listener = std::os::unix::net::UnixListener::bind(&self.path)?;
		fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600))?;
		listener.set_nonblocking(true)?;
		self.prepared_listener = Some(listener);
		Ok(())
	}

	/// Returns the exact grants enforced for this listener.
	pub(crate) const fn grants(&self) -> &Grants {
		&self.grants
	}

	/// Returns the immutable connection policy carried by this listener.
	pub(crate) fn policy(&self) -> ConnectionPolicy {
		ConnectionPolicy::extension(self.key.clone(), self.grants.iter())
	}
}
struct DocumentAuthority {
	shutdown: CancellationToken,
	#[cfg(unix)]
	task:     Option<JoinHandle<daemon::Result>>,
	#[cfg(windows)]
	task:     Option<JoinHandle<Result<(), crate::docserver::windows::WindowsTransportError>>>,
}

#[cfg(unix)]
impl DocumentAuthority {
	async fn finished_result(&mut self) -> Option<Result<daemon::Result, JoinError>> {
		if !self.task.as_ref()?.is_finished() {
			return None;
		}
		Some(
			self
				.task
				.take()
				.expect("finished document authority task")
				.await,
		)
	}
}

impl Drop for DocumentAuthority {
	fn drop(&mut self) {
		self.shutdown.cancel();
	}
}

/// Concrete environment host shared by in-process and UDS connections.
///
/// Executors remain env-side beside these resources. The server never passes a
/// capability/facet trait bundle through a tool signature.
/// Device-router bridge for final, worker-routed invocations.
#[derive(Clone)]
struct WorkerDeviceInvoker {
	hosts: Arc<ExtHostSupervisor>,
	blobs: BlobHost,
}

impl WorkerDeviceInvoker {
	const fn new(hosts: Arc<ExtHostSupervisor>, blobs: BlobHost) -> Self {
		Self { hosts, blobs }
	}
}

fn internal_worker_authorization() -> (Bytes, u64) {
	let token = Bytes::from(Ulid::generate().to_string());
	let authorized_at_ms = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |elapsed| elapsed.as_millis().try_into().unwrap_or(u64::MAX));
	(token, authorized_at_ms)
}

impl DeviceInvoker for WorkerDeviceInvoker {
	async fn invoke(&self, request: DeviceInvokeRequest) -> omp_tool::ErasedStream<'static> {
		let hosts = Arc::clone(&self.hosts);
		let blobs = self.blobs.clone();
		Box::pin(async_stream::stream! {
			let deadline = match request.deadline.to_std() {
				Ok(deadline) => deadline,
				Err(error) => {
					yield Err(RegistryError::VerdictShape(Str::from(error.to_string())));
					return;
				},
			};
			let mut invocation = match hosts.open(ExtHostToolCall {
				invocation_id: request.invocation_id.clone(),
				name: request.name.clone(),
				rev: request.rev.clone(),
				deadline,
			}) {
				Ok(invocation) => invocation,
				Err(error) => {
					yield Err(RegistryError::VerdictShape(Str::from(error.to_string())));
					return;
				},
			};
			let (effect_token, authorized_at_ms) = internal_worker_authorization();
			let committed = omp_proto::env::v1::ArgsCommitted {
				invocation_id: request.invocation_id.to_string(),
				raw: request.args_json,
				effect_token,
				authorized_at_ms,
				effects: Some(invocation.maximum_effect_envelope()),
				..omp_proto::env::v1::ArgsCommitted::default()
			};
			if let Err(error) = invocation.args_committed(committed) {
				yield Err(RegistryError::VerdictShape(Str::from(error.to_string())));
				return;
			}
			while let Ok(event) = invocation.next().await {
				match event {
					ExtHostEvent::Update(update) => yield Ok(ErasedEv::Update(Bytes::from(update.encode_to_vec()))),
					ExtHostEvent::Complete(complete) => match materialize_worker_completion(&blobs, &complete) {
						Ok(verdict) => {
							yield Ok(ErasedEv::Done(ErasedOutcome::Done {
								verdict,
								useless: complete.useless,
							}));
							return;
						},
						Err(error) => {
							yield Err(RegistryError::VerdictShape(error));
							return;
						},
					},
					ExtHostEvent::Aborted(abort) => {
						yield Err(RegistryError::VerdictShape(abort.reason));
						return;
					},
					ExtHostEvent::ProtocolError(_) => {
						yield Err(RegistryError::VerdictShape(sf!(
							"extension-host device protocol rejected final invocation"
						)));
						return;
					},
				}
			}
		})
	}
}

#[derive(Clone)]
struct PreludeBridgeInvoker {
	hosts: Arc<ExtHostSupervisor>,
	blobs: BlobHost,
}

impl PreludeBridgeInvoker {
	const fn new(hosts: Arc<ExtHostSupervisor>, blobs: BlobHost) -> Self {
		Self { hosts, blobs }
	}
}

#[async_trait::async_trait]
impl PreludeInvoker for PreludeBridgeInvoker {
	async fn invoke(
		&self,
		name: &str,
		rev: &str,
		args: serde_json::Value,
	) -> Result<serde_json::Value, BridgeHostError> {
		let invocation_id = Str::from(Ulid::generate().to_string());
		let mut invocation = self
			.hosts
			.open(ExtHostToolCall {
				invocation_id: invocation_id.clone(),
				name:          Str::new(name),
				rev:           Str::new(rev),
				deadline:      PRELUDE_CALL_DEADLINE,
			})
			.map_err(|error| {
				BridgeHostError::message(sf!("failed to open prelude helper invocation: {error}"))
			})?;
		let raw = serde_json::to_vec(&args).map_err(|error| {
			BridgeHostError::message(sf!("failed to encode prelude helper arguments: {error}"))
		})?;
		let (effect_token, authorized_at_ms) = internal_worker_authorization();
		invocation
			.args_committed(pb::ArgsCommitted {
				invocation_id: invocation_id.to_string(),
				raw: Bytes::from(raw),
				effect_token,
				authorized_at_ms,
				..pb::ArgsCommitted::default()
			})
			.map_err(|error| {
				BridgeHostError::message(sf!("failed to commit prelude helper arguments: {error}"))
			})?;
		loop {
			let event = invocation.next().await.map_err(|_| {
				BridgeHostError::message("prelude helper invocation channel closed before completion")
			})?;
			match event {
				ExtHostEvent::Update(_) => {},
				ExtHostEvent::Complete(complete) => {
					let details = materialize_worker_details(&self.blobs, &complete).map_err(|_| {
						BridgeHostError::message(
							"prelude helper result artifact is unavailable or exceeds the bounded \
							 projection",
						)
					})?;
					match complete.kind {
						ExtHostOutcomeKind::Ok => {
							return serde_json::from_slice(&details).map_err(|error| {
								BridgeHostError::message(sf!(
									"prelude helper returned invalid JSON: {error}"
								))
							});
						},
						ExtHostOutcomeKind::ArgsRejected => {
							let issue = complete.args_issue.as_ref().ok_or_else(|| {
								BridgeHostError::message(
									"prelude helper rejected its arguments without an argument issue",
								)
							})?;
							let path = if issue.path.is_empty() {
								sf!("<arguments>")
							} else {
								Str::from(issue.path.join("."))
							};
							return Err(BridgeHostError::message(sf!(
								"prelude helper arguments rejected at {path}: expected {} ({})",
								issue.expected,
								issue.kind
							)));
						},
						ExtHostOutcomeKind::Faulted | ExtHostOutcomeKind::Aborted => {
							let kind = if complete.kind == ExtHostOutcomeKind::Faulted {
								"faulted"
							} else {
								"aborted"
							};
							let detail = match serde_json::from_slice::<serde_json::Value>(&details) {
								Ok(serde_json::Value::String(detail)) => Str::from(detail),
								Ok(_) => Str::from_utf8(&details).map_err(|_| {
									BridgeHostError::message(sf!(
										"prelude helper {kind} with invalid UTF-8 details"
									))
								})?,
								Err(error) => {
									return Err(BridgeHostError::message(sf!(
										"prelude helper {kind} with invalid JSON details: {error}"
									)));
								},
							};
							return Err(BridgeHostError::message(sf!("prelude helper {kind}: {detail}")));
						},
					}
				},
				ExtHostEvent::Aborted(abort) => {
					return Err(BridgeHostError::message(sf!(
						"prelude helper invocation aborted: {}",
						abort.reason
					)));
				},
				ExtHostEvent::ProtocolError(error) => {
					return Err(BridgeHostError::message(sf!(
						"prelude helper protocol error: {}",
						error.message
					)));
				},
			}
		}
	}
}

struct LateDiagnosticsBatcher {
	pending:   parking_lot::Mutex<Vec<omp_session::late_diagnostics::LateDiagnosticsFile>>,
	scheduled: AtomicBool,
	active:    AtomicBool,
	sender:    KernelSender,
}

impl LateDiagnosticsBatcher {
	fn reset(&self) {
		self.pending.lock().clear();
	}

	fn push(self: &Arc<Self>, diagnostics: omp_session::late_diagnostics::LateDiagnostics) {
		if !self.active.load(Ordering::Acquire) {
			return;
		}
		let mut pending = self.pending.lock();
		for file in diagnostics.files {
			if let Some(existing) = pending.iter_mut().find(|known| known.path == file.path) {
				existing.messages.extend(file.messages);
				existing.recount();
			} else {
				pending.push(file);
			}
		}
		drop(pending);
		if !self.scheduled.swap(true, Ordering::AcqRel) {
			let batcher = Arc::clone(self);
			tokio::spawn(async move { batcher.flush().await });
		}
	}

	async fn flush(self: Arc<Self>) {
		loop {
			tokio::time::sleep(Duration::from_millis(25)).await;
			let files = {
				let mut pending = self.pending.lock();
				if !self.active.load(Ordering::Acquire) {
					pending.clear();
					self.scheduled.store(false, Ordering::Release);
					return;
				}
				if pending.is_empty() {
					self.scheduled.store(false, Ordering::Release);
					return;
				}
				mem::take(&mut *pending)
			};
			let _ = self
				.sender
				.send_async(omp_agent::Up::Env(omp_agent::EnvEvent::LateDiagnostics(
					omp_session::late_diagnostics::LateDiagnostics { files },
				)))
				.await;
			let pending = self.pending.lock();
			if pending.is_empty() {
				self.scheduled.store(false, Ordering::Release);
				return;
			}
		}
	}
}

/// Sole-owner lease for Agent CONTROL routes installed in one environment.
#[must_use]
pub struct AgentControlBinding {
	server:      Arc<EnvServer>,
	id:          u64,
	diagnostics: Option<Arc<LateDiagnosticsBatcher>>,
}

impl AgentControlBinding {
	/// Re-derives checkpoint state and drops obsolete deferred diagnostics when
	/// the controller selects another journal with the same authenticated
	/// mailbox.
	pub fn refresh_session(&self, dom: &omp_dom::Dom) {
		if let Some(diagnostics) = &self.diagnostics {
			diagnostics.reset();
		}
		if let Some(environment) = &self.server.environment {
			environment.documents.reset_late_diagnostics(self.id);
		}
		self.server.checkpoint_control.restore_session(self.id, dom);
	}
}

impl Drop for AgentControlBinding {
	fn drop(&mut self) {
		if let Some(diagnostics) = &self.diagnostics {
			diagnostics.active.store(false, Ordering::Release);
		}
		self.server.release_agent_control(self.id);
	}
}

type ProductionResolverTable = ResolverTable<UrlResolver>;

struct ProductionControlBindings {
	factory:   Arc<HostControlAuthorityFactory>,
	resources: Arc<sync::OnceLock<Arc<ProductionResolverTable>>>,
	callbacks: Arc<CallbackDispatcherSlot>,
	registry:  Arc<RegistryControlFactory>,
	hooks:     Arc<HookControlFactory>,
}

struct WeakExtensionCallbackDispatcher {
	supervisor: Weak<ExtHostSupervisor>,
}

#[async_trait::async_trait]
impl CallbackDispatcher for WeakExtensionCallbackDispatcher {
	async fn dispatch(
		&self,
		target: Arc<ControlConnectionIdentity>,
		dispatch: ControlDispatch,
	) -> Result<serde_json::Value, ControlProtocolError> {
		let supervisor = self.supervisor.upgrade().ok_or_else(|| {
			ControlProtocolError::new(
				"CallbackUnavailable",
				"extension callback supervisor is no longer active",
			)
		})?;
		CallbackDispatcher::dispatch(supervisor.as_ref(), target, dispatch).await
	}

	async fn dispatch_ui(
		&self,
		target: Arc<ControlConnectionIdentity>,
		authority: crate::exthost::control::ControlInvocationAuthority,
		dispatch: UiCallbackDispatch,
		timeout: Duration,
	) -> Result<UiDispatchResult, ControlProtocolError> {
		let supervisor = self.supervisor.upgrade().ok_or_else(|| {
			ControlProtocolError::new(
				"CallbackUnavailable",
				"extension callback supervisor is no longer active",
			)
		})?;
		CallbackDispatcher::dispatch_ui(supervisor.as_ref(), target, authority, dispatch, timeout)
			.await
	}
}

#[derive(Clone, Copy)]
enum DeclaredExternalDomain {
	Policy,
	Parameters,
	Workers,
	DirectFilesystem,
	Credentials,
	Prompts,
	Sessions,
	Ui,
	Telemetry,
	Jobs,
	Provider,
	Services,
}

impl DeclaredExternalDomain {
	fn declared(self, manifest: &ExtensionManifest) -> bool {
		let declarations = manifest.static_declarations();
		match self {
			Self::Policy => true,
			Self::Parameters => manifest.declarations.tools().next().is_some(),
			Self::Workers => !declarations.workers.is_empty() || !declarations.placement.is_empty(),
			Self::DirectFilesystem => manifest
				.declarations
				.permits(EscapeCapability::DirectFilesystem),
			Self::Credentials => true,
			Self::Prompts => true,
			Self::Sessions => !declarations.ui.commands.is_empty(),
			Self::Ui => {
				!declarations.ui.commands.is_empty()
					|| !declarations.ui.shortcuts.is_empty()
					|| !declarations.ui.message_renderers.is_empty()
					|| !declarations.ui.completions.is_empty()
			},
			Self::Telemetry => true,
			Self::Jobs => !declarations.ui.verdict_renderers.is_empty(),
			Self::Provider => true,
			Self::Services => {
				manifest.services.provides().next().is_some()
					|| manifest.services.requires().next().is_some()
			},
		}
	}

	const fn name(self) -> &'static str {
		match self {
			Self::Policy => "policy",
			Self::Parameters => "parameters",
			Self::Workers => "workers",
			Self::DirectFilesystem => "direct-filesystem",
			Self::Credentials => "credentials",
			Self::Prompts => "prompts",
			Self::Sessions => "sessions",
			Self::Ui => "ui",
			Self::Telemetry => "telemetry",
			Self::Jobs => "jobs",
			Self::Provider => "provider",
			Self::Services => "services",
		}
	}

	fn factory(
		self,
		factories: &ExternalDomainControlFactories,
	) -> Option<Arc<dyn ControlAuthorityFactory>> {
		match self {
			Self::Policy => factories.policy.clone(),
			Self::Parameters => factories.parameters.clone(),
			Self::Workers => factories.workers.clone(),
			Self::DirectFilesystem => factories.direct_filesystem.clone(),
			Self::Credentials => factories.credentials.clone(),
			Self::Prompts => factories.prompts.clone(),
			Self::Sessions => factories.sessions.clone(),
			Self::Ui => factories.ui.clone(),
			Self::Telemetry => factories.telemetry.clone(),
			Self::Jobs => factories.jobs.clone(),
			Self::Provider => factories.provider.clone(),
			Self::Services => factories.services.clone(),
		}
	}
}

struct ManifestGatedControlFactory {
	domain:    DeclaredExternalDomain,
	manifests: Arc<BTreeMap<(Str, Str, Str), ExtensionManifest>>,
	slot:      Arc<DomainControlSlot>,
}

impl ControlAuthorityFactory for ManifestGatedControlFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		let manifest = self
			.manifests
			.get(&(identity.layer.clone(), identity.tier.clone(), identity.extension.clone()))
			.ok_or_else(|| {
				ControlCompositionError::unavailable(
					self.domain.name(),
					"authenticated extension has no deployment manifest",
				)
			})?;
		if !self.domain.declared(manifest) {
			return Ok(Arc::new(UndeclaredControlAuthority));
		}
		Ok(Arc::new(LateBoundControlAuthority {
			domain: self.domain,
			identity,
			slot: Arc::clone(&self.slot),
			bound: Mutex::new(None),
		}))
	}
}

struct LateBoundControlAuthority {
	domain:   DeclaredExternalDomain,
	identity: Arc<ControlConnectionIdentity>,
	slot:     Arc<DomainControlSlot>,
	bound:    Mutex<Option<(u64, Arc<dyn ControlAuthority>)>>,
}

impl LateBoundControlAuthority {
	fn owner(&self) -> Result<(u64, Arc<dyn ControlAuthority>), ControlProtocolError> {
		let (id, factories) = self.slot.snapshot().ok_or_else(|| {
			ControlProtocolError::new(
				"AccessDenied",
				sf!("no active {} CONTROL lease authorizes this session", self.domain.name()),
			)
		})?;
		if let Some((bound_id, owner)) = self.bound.lock().as_ref() {
			if *bound_id == id {
				return Ok((id, Arc::clone(owner)));
			}
			return Err(ControlProtocolError::new(
				"StaleGeneration",
				"the driver/app CONTROL lease replaced this connection's authority",
			));
		}
		let factory = self.domain.factory(&factories).ok_or_else(|| {
			ControlProtocolError::new(
				"AccessDenied",
				sf!("the active CONTROL lease does not grant {}", self.domain.name()),
			)
		})?;
		let owner = factory.bind(Arc::clone(&self.identity)).map_err(|error| {
			ControlProtocolError::new("AuthorityBindingFailed", Str::from(error.to_string()))
		})?;
		if !self.slot.is_live(id) {
			return Err(ControlProtocolError::new(
				"StaleGeneration",
				"the driver/app CONTROL lease changed while binding",
			));
		}
		*self.bound.lock() = Some((id, Arc::clone(&owner)));
		Ok((id, owner))
	}
}

#[async_trait::async_trait]
impl ControlAuthority for LateBoundControlAuthority {
	fn handles(&self, operation: &str) -> bool {
		if let Some((_, owner)) = self.bound.lock().as_ref() {
			return owner.handles(operation);
		}
		self
			.owner()
			.is_ok_and(|(_, owner)| owner.handles(operation))
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		operation: &str,
		arguments: &serde_json::Map<String, serde_json::Value>,
	) -> Result<(), ControlProtocolError> {
		let (_, owner) = self.owner()?;
		owner.authorize(context, operation, arguments)
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		arguments: serde_json::Map<String, serde_json::Value>,
	) -> Result<serde_json::Value, ControlProtocolError> {
		let (id, owner) = self.owner()?;
		let result = owner.request(context, operation, arguments).await;
		if !self.slot.is_live(id) {
			return Err(ControlProtocolError::new(
				"StaleGeneration",
				"the driver/app CONTROL lease changed during the request",
			));
		}
		result
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		let (id, owner) = self.owner()?;
		let result = owner.effect(context, effect).await;
		if !self.slot.is_live(id) {
			return Err(ControlProtocolError::new(
				"StaleGeneration",
				"the driver/app CONTROL lease changed during the effect",
			));
		}
		result
	}
}

struct CompositeControlFactory {
	owners: Box<[Arc<dyn ControlAuthorityFactory>]>,
}

impl ControlAuthorityFactory for CompositeControlFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		let mut owners = Vec::with_capacity(self.owners.len());
		for owner in &self.owners {
			owners.push(owner.bind(Arc::clone(&identity))?);
		}
		let effects = Arc::new(UndeclaredControlAuthority);
		Ok(Arc::new(CompositeControlAuthority::new(owners, effects)))
	}
}

struct UndeclaredControlAuthority;

#[async_trait::async_trait]
impl ControlAuthority for UndeclaredControlAuthority {
	fn handles(&self, _operation: &str) -> bool {
		false
	}

	fn authorize(
		&self,
		_context: &ControlRequestContext,
		_operation: &str,
		_arguments: &serde_json::Map<String, serde_json::Value>,
	) -> Result<(), ControlProtocolError> {
		Err(ControlProtocolError::new(
			"UndeclaredOperation",
			"the extension manifest does not declare this CONTROL domain",
		))
	}

	async fn request(
		&self,
		_context: ControlRequestContext,
		_operation: Str,
		_arguments: serde_json::Map<String, serde_json::Value>,
	) -> Result<serde_json::Value, ControlProtocolError> {
		Err(ControlProtocolError::new(
			"UndeclaredOperation",
			"the extension manifest does not declare this CONTROL domain",
		))
	}

	async fn effect(
		&self,
		_context: ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		Err(ControlProtocolError::new(
			"UndeclaredOperation",
			"the extension manifest does not declare this CONTROL domain",
		))
	}
}

#[derive(Default)]
struct ProductionDeviceCatalogObserver;

impl DeviceCatalogObserver for ProductionDeviceCatalogObserver {
	fn catalog_changed(&self, epoch: u64, catalog: Arc<[DynamicDeviceCatalogEntry]>) {
		tracing::debug!(epoch, entries = catalog.len(), "dynamic device catalog changed");
	}
}

struct ProductionDeviceInvocationAdmission;

#[async_trait::async_trait]
impl DeviceInvocationAdmission for ProductionDeviceInvocationAdmission {
	async fn admit(
		&self,
		caller: &ControlRequestContext,
		target: &DynamicDeviceCatalogEntry,
		_arguments: &serde_json::Map<String, serde_json::Value>,
	) -> Result<(), ControlProtocolError> {
		if caller.connection.extension == target.claimant
			|| caller.connection.capabilities.contains("devices.invoke")
		{
			Ok(())
		} else {
			Err(ControlProtocolError::new(
				"AccessDenied",
				"cross-extension device invocation requires devices.invoke",
			))
		}
	}
}

struct ProductionEnvdControlFactory {
	state_dir:  PathBuf,
	session_id: Str,
	telemetry:  Arc<TelemetryIndex>,
	intents:    Arc<Mutex<BTreeMap<(Str, Str, Str, Str), serde_json::Value>>>,
	resources:  Arc<sync::OnceLock<Arc<ProductionResolverTable>>>,
}

impl ControlAuthorityFactory for ProductionEnvdControlFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		Ok(Arc::new(ProductionEnvdControlAuthority {
			identity,
			state_dir: self.state_dir.clone(),
			session_id: self.session_id.clone(),
			telemetry: Arc::clone(&self.telemetry),
			intents: Arc::clone(&self.intents),
			resources: Arc::clone(&self.resources),
		}))
	}
}

struct ProductionEnvdControlAuthority {
	identity:   Arc<ControlConnectionIdentity>,
	state_dir:  PathBuf,
	session_id: Str,
	telemetry:  Arc<TelemetryIndex>,
	intents:    Arc<Mutex<BTreeMap<(Str, Str, Str, Str), serde_json::Value>>>,
	resources:  Arc<sync::OnceLock<Arc<ProductionResolverTable>>>,
}

impl ProductionEnvdControlAuthority {
	fn validate(&self, context: &ControlRequestContext) -> Result<(), ControlProtocolError> {
		if same_control_connection(&self.identity, &context.connection) {
			Ok(())
		} else {
			Err(ControlProtocolError::new(
				"StaleGeneration",
				"CONTROL authority belongs to a replaced extension-host connection",
			))
		}
	}
}

#[async_trait::async_trait]
impl ControlAuthority for ProductionEnvdControlAuthority {
	fn handles(&self, operation: &str) -> bool {
		matches!(operation, "omp.state_dir" | "omp.urls.read")
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		_operation: &str,
		_arguments: &serde_json::Map<String, serde_json::Value>,
	) -> Result<(), ControlProtocolError> {
		self.validate(context)
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		_arguments: serde_json::Map<String, serde_json::Value>,
	) -> Result<serde_json::Value, ControlProtocolError> {
		self.validate(&context)?;
		match operation.as_str() {
			"omp.state_dir" => {
				Ok(serde_json::Value::String(self.state_dir.to_string_lossy().into_owned()))
			},
			"omp.urls.read" => {
				let url = _arguments
					.get("url")
					.and_then(serde_json::Value::as_str)
					.filter(|url| !url.is_empty())
					.ok_or_else(|| {
						ControlProtocolError::new("InvalidUrl", "omp.urls.read requires a non-empty url")
					})?;
				let parsed = selector::parse_uri(url)
					.map_err(|error| {
						ControlProtocolError::new("InvalidUrl", Str::from(error.to_string()))
					})?
					.ok_or_else(|| {
						ControlProtocolError::new(
							"InvalidUrl",
							"omp.urls.read requires an absolute typed URL",
						)
					})?;
				let resources = self.resources.get().ok_or_else(|| {
					ControlProtocolError::new(
						"ControlOwnerUnavailable",
						"the Environment URL resolver table is not active",
					)
					.retryable(true)
				})?;
				let read = if parsed.scheme == resolver::Scheme::Unknown {
					resources.read_unknown(url, &parsed.selector).await
				} else {
					resources
						.read_query(parsed.scheme, parsed.resource, parsed.query, &parsed.selector)
						.await
				}
				.ok_or_else(|| {
					ControlProtocolError::new(
						"SchemeNotReadable",
						sf!("no live Environment resolver owns {}", parsed.raw_scheme),
					)
				})?
				.map_err(|error| ControlProtocolError::new("UrlReadFailed", error.message().clone()))?;
				Ok(serde_json::json!({
					"$bytes": omp_core::base64::encode(read.as_ref())
				}))
			},
			operation => Err(ControlProtocolError::new(
				"InvalidOperation",
				sf!("auxiliary CONTROL owner does not handle {operation}"),
			)),
		}
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		self.validate(&context)?;
		match effect {
			ControlEffect::Intent(payload) => {
				let object = payload.as_object().ok_or_else(|| {
					ControlProtocolError::new("InvalidIntent", "provider intent effect is not an object")
				})?;
				let operation = object
					.get("operation")
					.and_then(serde_json::Value::as_str)
					.ok_or_else(|| {
						ControlProtocolError::new("InvalidIntent", "provider intent operation is missing")
					})?;
				let arguments = object
					.get("arguments")
					.and_then(serde_json::Value::as_object)
					.ok_or_else(|| {
						ControlProtocolError::new(
							"InvalidIntent",
							"provider intent arguments are missing",
						)
					})?;
				let key = arguments
					.get("key")
					.and_then(serde_json::Value::as_str)
					.filter(|key| !key.is_empty())
					.ok_or_else(|| {
						ControlProtocolError::new(
							"InvalidIntent",
							"provider intent key must be non-empty",
						)
					})?;
				let owner = (
					self.identity.layer.clone(),
					self.identity.tier.clone(),
					self.identity.extension.clone(),
					Str::from(key),
				);
				match operation {
					"omp.intents.set" => {
						let intents = arguments
							.get("intents")
							.and_then(serde_json::Value::as_array)
							.ok_or_else(|| {
								ControlProtocolError::new(
									"InvalidIntent",
									"provider intent set requires an intents array",
								)
							})?;
						for intent in intents {
							let intent = intent.as_object().ok_or_else(|| {
								ControlProtocolError::new(
									"InvalidIntent",
									"provider intent rows must be objects",
								)
							})?;
							let kind = intent
								.get("kind")
								.and_then(serde_json::Value::as_str)
								.ok_or_else(|| {
									ControlProtocolError::new(
										"InvalidIntent",
										"provider intent kind is missing",
									)
								})?;
							if !matches!(
								kind,
								"strict"
									| "grammar" | "force_call"
									| "service_tier" | "verbosity"
									| "cache_retention"
									| "reasoning" | "safety"
									| "determinism" | "hosted_tool"
							) {
								return Err(ControlProtocolError::new(
									"InvalidIntent",
									sf!("unknown provider intent kind: {kind}"),
								));
							}
							let fallback = intent
								.get("on_unsupported")
								.and_then(serde_json::Value::as_str)
								.ok_or_else(|| {
									ControlProtocolError::new(
										"InvalidIntent",
										"provider intent fallback is missing",
									)
								})?;
							if !matches!(fallback, "unspecified" | "error" | "ignore" | "emulate") {
								return Err(ControlProtocolError::new(
									"InvalidIntent",
									sf!("unknown provider intent fallback: {fallback}"),
								));
							}
							let priority = intent
								.get("priority")
								.and_then(serde_json::Value::as_u64)
								.ok_or_else(|| {
									ControlProtocolError::new(
										"InvalidIntent",
										"provider intent priority must be an unsigned integer",
									)
								})?;
							if priority > u64::from(u32::MAX) {
								return Err(ControlProtocolError::new(
									"InvalidIntent",
									"provider intent priority exceeds u32",
								));
							}
						}
						self
							.intents
							.lock()
							.insert(owner, serde_json::Value::Array(intents.clone()));
						Ok(())
					},
					"omp.intents.clear" => {
						self.intents.lock().remove(&owner);
						Ok(())
					},
					_ => Err(ControlProtocolError::new(
						"InvalidIntent",
						sf!("unsupported provider intent effect: {operation}"),
					)),
				}
			},
			ControlEffect::Log(payload) => {
				tracing::info!(
					extension = %self.identity.extension,
					payload = %payload,
					"extension host log"
				);
				Ok(())
			},
			ControlEffect::Instrument(payload) => {
				let encoded = serde_json::to_vec(&payload).map_err(|error| {
					ControlProtocolError::new(
						"InvalidTelemetry",
						sf!("telemetry event is not JSON encodable: {error}"),
					)
				})?;
				let kind = payload
					.get("kind")
					.and_then(serde_json::Value::as_str)
					.unwrap_or("extension.instrument");
				let occurred_at_ms = SystemTime::now()
					.duration_since(UNIX_EPOCH)
					.map_or(0, |elapsed| elapsed.as_millis().try_into().unwrap_or(u64::MAX));
				self
					.telemetry
					.append(self.session_id.as_str(), kind, occurred_at_ms, &encoded)
					.map_err(|error| {
						ControlProtocolError::new(
							"TelemetryWriteFailed",
							sf!("the Environment telemetry owner rejected the event: {error}"),
						)
					})?;
				Ok(())
			},
			ControlEffect::Ui(_) => Err(ControlProtocolError::new(
				"InvalidEffect",
				"auxiliary CONTROL owner accepts only logs and internal observations",
			)),
		}
	}
}

struct ProductionMcpControlFactory {
	mcp: Arc<McpService>,
}

impl ControlAuthorityFactory for ProductionMcpControlFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		let cancellation = CancellationToken::new();
		let control = self
			.mcp
			.control(Arc::clone(&identity), cancellation.clone())
			.ok_or_else(|| {
				ControlCompositionError::unavailable("mcp", "the Environment MCP manager is not bound")
			})?;
		Ok(Arc::new(ProductionMcpControlAuthority { identity, control, cancellation }))
	}
}

struct ProductionMcpControlAuthority {
	identity:     Arc<ControlConnectionIdentity>,
	control:      McpControl,
	cancellation: CancellationToken,
}

impl Drop for ProductionMcpControlAuthority {
	fn drop(&mut self) {
		self.cancellation.cancel();
	}
}

#[async_trait::async_trait]
impl ControlAuthority for ProductionMcpControlAuthority {
	fn handles(&self, operation: &str) -> bool {
		matches!(
			operation,
			"omp.mcp.mount" | "omp.mcp.unmount" | "omp.mcp.servers" | "omp.mcp.invoke"
		)
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		_operation: &str,
		_arguments: &serde_json::Map<String, serde_json::Value>,
	) -> Result<(), ControlProtocolError> {
		if same_control_connection(&self.identity, &context.connection) {
			Ok(())
		} else {
			Err(ControlProtocolError::new(
				"StaleGeneration",
				"MCP authority belongs to a replaced extension-host connection",
			))
		}
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		arguments: serde_json::Map<String, serde_json::Value>,
	) -> Result<serde_json::Value, ControlProtocolError> {
		self.authorize(&context, operation.as_str(), &arguments)?;
		self
			.control
			.dispatch_with_cancel(
				operation.as_str(),
				serde_json::Value::Object(arguments),
				self.cancellation.child_token(),
			)
			.await
			.map_err(|error| {
				ControlProtocolError::new(
					"McpControlError",
					sf!("the Environment MCP owner rejected the request: {error}"),
				)
			})
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		if same_control_connection(&self.identity, &context.connection) {
			Err(ControlProtocolError::new(
				"InvalidMcpEffect",
				"MCP does not accept fire-and-forget effects",
			))
		} else {
			Err(ControlProtocolError::new(
				"StaleGeneration",
				"MCP authority belongs to a replaced extension-host connection",
			))
		}
	}
}

struct UnboundAgentsControlFactory;

impl ControlAuthorityFactory for UnboundAgentsControlFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		Ok(Arc::new(UnboundAgentsControlAuthority { identity }))
	}
}

struct UnboundAgentsControlAuthority {
	identity: Arc<ControlConnectionIdentity>,
}

#[async_trait::async_trait]
impl ControlAuthority for UnboundAgentsControlAuthority {
	fn handles(&self, operation: &str) -> bool {
		operation.starts_with("omp.agents.")
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		_operation: &str,
		_arguments: &serde_json::Map<String, serde_json::Value>,
	) -> Result<(), ControlProtocolError> {
		if same_control_connection(&self.identity, &context.connection) {
			Err(
				ControlProtocolError::new(
					"AgentsOwnerUnavailable",
					"no installed Agents lease owns this CONTROL connection",
				)
				.retryable(true),
			)
		} else {
			Err(ControlProtocolError::new(
				"StaleGeneration",
				"Agents authority belongs to a replaced extension-host connection",
			))
		}
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		arguments: serde_json::Map<String, serde_json::Value>,
	) -> Result<serde_json::Value, ControlProtocolError> {
		self.authorize(&context, operation.as_str(), &arguments)?;
		Err(
			ControlProtocolError::new(
				"AgentsOwnerUnavailable",
				"no installed Agents lease owns this CONTROL connection",
			)
			.retryable(true),
		)
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		self.authorize(&context, "omp.agents.effect", &serde_json::Map::new())
	}
}

fn same_control_connection(
	expected: &ControlConnectionIdentity,
	actual: &ControlConnectionIdentity,
) -> bool {
	expected.extension == actual.extension
		&& expected.principal == actual.principal
		&& expected.artifact_digest == actual.artifact_digest
		&& expected.layer == actual.layer
		&& expected.tier == actual.tier
		&& expected.trust == actual.trust
		&& expected.host_generation == actual.host_generation
		&& expected.session_generation == actual.session_generation
		&& expected.capabilities == actual.capabilities
}

fn bind_live_session_authority_snapshot(
	config: &mut ExtHostConfig,
	root: &Path,
	authority: Option<&Arc<dyn omp_agent::SessionAuthority>>,
) {
	let Some(authority) = authority else {
		return;
	};
	let Some(endpoint) = authority.lookup(config.session_id.as_str()) else {
		return;
	};
	let mut depth = 0_u32;
	let mut cursor = endpoint.topology.parent_id.clone();
	let mut seen = BTreeSet::new();
	while let Some(parent) = cursor {
		if !seen.insert(parent.clone()) {
			break;
		}
		depth = depth.saturating_add(1);
		if depth == 64 {
			break;
		}
		cursor = authority
			.lookup(parent.as_str())
			.and_then(|parent| parent.topology.parent_id);
	}
	let root = Url::from_file_path(root)
		.map_or_else(|_| String::from("file:///"), |root| root.to_string());
	let started_at_ms = config
		.session_started_at
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX);
	config.bind_session_authority_snapshot(
		serde_json::json!({
			"id": endpoint.id.as_str(),
			"title": (!endpoint.name.is_empty()).then(|| endpoint.name.as_str()),
			"title_source": "system",
			"cwd": root.clone(),
			"project": root,
			"created_ms": started_at_ms,
			"updated_ms": started_at_ms,
			"status": "pending",
			"kind": match endpoint.topology.role {
				SessionRole::Main => "interactive",
				SessionRole::Child => "subagent",
			},
			"parent": endpoint.topology.parent_id.as_deref(),
			"entries": 0,
			"turns": 0,
			"usage": {},
			"cost": {"nanos_usd": 0, "estimated": true},
			"models": [],
			"remote": false,
		}),
		depth,
	);
}

fn register_extension_convars(con: &Ctx, extensions: &[ExtHostSpec]) -> Result<(), EnvdError> {
	for extension in extensions {
		crate::exthost::register_extension_setting_convars(
			con,
			extension.key.extension().as_str(),
			&extension.manifest.setting_schemas,
			&extension.settings,
		)?;
	}
	Ok(())
}

fn production_control_authorities(
	state_dir: &Path,
	session_id: &Str,
	telemetry: &Arc<TelemetryIndex>,
	mcp: &Arc<McpService>,
	extensions: &[ExtHostSpec],
	domain_control: Arc<DomainControlSlot>,
	convars: Arc<dyn ControlAuthorityFactory>,
	quota_runtime: ControlQuotaRuntime,
	extension_tool_call_timeout: Duration,
) -> ProductionControlBindings {
	let resources = Arc::new(sync::OnceLock::new());
	let manifests = Arc::new(
		extensions
			.iter()
			.map(|extension| {
				(
					(
						extension.key.layer().clone(),
						extension.key.tier().clone(),
						extension.key.extension().clone(),
					),
					extension.manifest.clone(),
				)
			})
			.collect::<BTreeMap<_, _>>(),
	);
	let registry_owner = RegistryControlFactory::new(manifests.as_ref().clone());
	let callbacks = CallbackDispatcherSlot::new();
	let devices: Arc<dyn ControlAuthorityFactory> = DeviceControlFactory::new(
		Arc::clone(&registry_owner),
		callbacks.clone(),
		Arc::new(ProductionDeviceCatalogObserver),
		Arc::new(ProductionDeviceInvocationAdmission),
	);
	let extension_settings = extensions
		.iter()
		.map(|extension| {
			(
				(
					extension.key.layer().clone(),
					extension.key.tier().clone(),
					extension.key.extension().clone(),
				),
				extension.settings.clone(),
			)
		})
		.collect();
	let hooks = HookControlFactory::new(
		Arc::clone(&registry_owner),
		callbacks.clone(),
		BTreeMap::new(),
		extension_settings,
		extension_tool_call_timeout,
	);
	hooks.bind_mcp_drop_journal(Arc::clone(telemetry), session_id.clone());
	let hooks_factory: Arc<dyn ControlAuthorityFactory> = hooks.clone();
	let envd: Arc<dyn ControlAuthorityFactory> = Arc::new(ProductionEnvdControlFactory {
		state_dir:  state_dir.to_path_buf(),
		session_id: session_id.clone(),
		telemetry:  Arc::clone(telemetry),
		intents:    Arc::new(Mutex::new(BTreeMap::new())),
		resources:  Arc::clone(&resources),
	});
	let registry = RegistryControlAuthorities::new(devices, hooks_factory);
	let gated = |domain| -> Arc<dyn ControlAuthorityFactory> {
		Arc::new(ManifestGatedControlFactory {
			domain,
			manifests: Arc::clone(&manifests),
			slot: Arc::clone(&domain_control),
		})
	};
	let policy_owner = gated(DeclaredExternalDomain::Policy);
	let parameters = gated(DeclaredExternalDomain::Parameters);
	let workers = gated(DeclaredExternalDomain::Workers);
	let direct_filesystem = gated(DeclaredExternalDomain::DirectFilesystem);
	let credentials = gated(DeclaredExternalDomain::Credentials);
	let prompts = gated(DeclaredExternalDomain::Prompts);
	let sessions = gated(DeclaredExternalDomain::Sessions);
	let ui = gated(DeclaredExternalDomain::Ui);
	let telemetry_owner = gated(DeclaredExternalDomain::Telemetry);
	let jobs = gated(DeclaredExternalDomain::Jobs);
	let provider_owner = gated(DeclaredExternalDomain::Provider);
	let services = gated(DeclaredExternalDomain::Services);
	let auxiliary: Arc<dyn ControlAuthorityFactory> = Arc::new(CompositeControlFactory {
		owners: vec![Arc::clone(&envd), parameters, workers, direct_filesystem, convars]
			.into_boxed_slice(),
	});
	let artifacts: Arc<dyn ControlAuthorityFactory> = Arc::new(
		FixedControlAuthorityFactory::new(Arc::new(UndeclaredControlAuthority)),
	);
	let persistence = PersistenceControlAuthorities::new(sessions, artifacts, credentials);
	let policy = PolicyControlAuthorities::new(policy_owner, prompts);
	let presentation = PresentationControlAuthorities::new(ui, telemetry_owner, jobs);
	let provider = ProviderControlAuthorities::new(provider_owner, services);
	let envd = EnvdControlAuthorities::new(
		registry,
		persistence,
		policy,
		presentation,
		provider,
		auxiliary,
		envd,
	);
	let external = ExternalControlAuthorities::new(
		Arc::new(UnboundAgentsControlFactory),
		Arc::new(ProductionMcpControlFactory { mcp: Arc::clone(mcp) }),
	);
	ProductionControlBindings {
		factory: Arc::new(
			HostControlAuthorityFactory::new(envd, external).with_quota_runtime(quota_runtime),
		),
		resources,
		callbacks,
		registry: registry_owner,
		hooks,
	}
}

/// Owner-local `env/v1` dispatch state serving one project environment.
struct EnvironmentAuthorities {
	documents:           DocumentHost,
	_document_authority: Option<DocumentAuthority>,
	workspace_ops:       WorkspaceOperations,
	lsp_settings:        LspSettings,
	process_store:       ProcessStore,
}

/// Owner-local `env/v1` dispatch state serving one project environment.
pub struct EnvServer {
	identity:                ServerIdentity,
	environment:             Option<EnvironmentAuthorities>,
	tool_settings:           ToolSettings,
	exec:                    ExecHost,
	acp_exec:                AcpExecSlot,
	approvals:               ApprovalAuthoritySlot,
	http_egress:             HttpEgressHost,
	workspace:               WorkspaceHost,
	mcp:                     Arc<McpService>,
	mcp_manager:             Arc<McpManager>,
	host_info:               HostInfoHost,
	workspace_roots:         WorkspaceRootHost,
	resources:               Arc<ResolverTable<UrlResolver>>,
	_memory_runtime:         RegisteredMemoryRuntime,
	blobs:                   BlobHost,
	sites:                   SiteMaterializer,
	materializations:        ResourceMaterializer,
	registry:                Arc<Registry>,
	ask_presenter:           PresenterSlot,
	ext_hosts:               Arc<ExtHostSupervisor>,
	eval_bridge:             Arc<SessionBridgeHost>,
	reflection_bridge:       Arc<ReflectionBridgeHost>,
	eval_control:            EvalSessionControl,
	search_bridge:           Arc<SearchBridgeHost>,
	github_credentials:      Arc<GithubCredentialBridge>,
	usage_fetchers:          omp_ai::operation::usage::UsageFetcherRegistry,
	provider_response_hooks: omp_ai::ProviderResponseHooks,
	admission_gate:          Arc<HookGate>,
	checkpoint_control:      AgentCheckpointControl,
	previews:                StagedProposalRegistry,
	schedules:               DurableScheduleActor,
	workers:                 Arc<WorkerSupervisor>,
	authority:               Arc<AuthorityTable>,
	repository_revision:     AtomicU64,
	presence:                PresenceRegistry,
	state_dir:               PathBuf,
}

fn execution_settings(
	ctx: &Ctx,
) -> (HostSettings, BrowserSettings, ShellSettings, SandboxSettings, AcpSettings) {
	(
		HostSettings::from_con(ctx),
		BrowserSettings::from_con(ctx),
		ShellSettings::from_con(ctx),
		SandboxSettings::from_con(ctx),
		AcpSettings::from_con(ctx),
	)
}

async fn start_memory_runtime(
	settings: &HostSettings,
	data_dir: &Path,
	project_root: &Path,
	session_id: &Str,
) -> Result<RegisteredMemoryRuntime, EnvdError> {
	let snapshot = if settings.memory.backend == omp_memory::MemoryBackend::Off {
		None
	} else {
		let cancel = CancellationToken::new();
		Some(
			vcs::snapshot(project_root, &cancel)
				.await
				.map_err(|error| EnvdError::State(Str::from(error.to_string())))?,
		)
	};
	memory::start(
		settings.memory.backend,
		&settings.mnemopi,
		data_dir,
		session_id.clone(),
		project_root.to_path_buf(),
		snapshot.as_ref(),
	)
	.map_err(|error| EnvdError::State(Str::from(error.to_string())))
}

#[derive(Debug, Error)]
enum PrivilegedDispatchError {
	#[error("{0}")]
	Invalid(&'static str),
	#[error(transparent)]
	Mutation(#[from] PrivilegedMutationFault),
}
#[derive(Clone)]
struct ApprovalAuthority {
	route: ApprovalRoute,
}

#[derive(Clone, Default)]
struct ApprovalAuthoritySlot(Arc<parking_lot::RwLock<Option<ApprovalAuthority>>>);

impl ApprovalAuthoritySlot {
	fn bind(&self, _book: Option<Arc<ApprovalBook>>, route: Option<ApprovalRoute>) {
		*self.0.write() = route.map(|route| ApprovalAuthority { route });
	}

	async fn approve_privileged(
		&self,
		ticket: &[u8],
		invocation_id: &Str,
		target: &str,
		kind: &'static str,
	) -> bool {
		let Some(authority) = self.0.read().clone() else {
			return false;
		};
		let ticket = if ticket.is_empty() {
			authority
				.route
				.request(
					Some(invocation_id.clone()),
					vec![ApprovalSpec {
						title:         sf!("Privileged file mutation"),
						body:          sf!(
							"Approve {kind} after ordinary document mutation was refused by filesystem \
							 permissions."
						),
						subject:       Str::new(target),
						kind:          sf!("privileged_write"),
						scopes:        vec![sf!("once")],
						default:       Some(false),
						route:         sf!("local"),
						approver:      None,
						timeout_ms:    120_000,
						unreachable:   sf!("fail_closed"),
						require_human: true,
						pattern:       None,
						evidence:      vec![sf!("filesystem permission fallback")],
					}],
					now_epoch_ms(),
				)
				.await
		} else {
			let Ok(ticket_id) = str::from_utf8(ticket) else {
				return false;
			};
			let Some(ticket) = authority.route.ticket(ticket_id) else {
				return false;
			};
			ticket
		};
		if ticket.state != TicketState::Decided
			|| ticket.invocation_id.as_ref() != Some(invocation_id)
			|| !ticket
				.decision
				.as_ref()
				.is_some_and(|decision| decision.approved)
			|| !ticket
				.reasons
				.iter()
				.any(|reason| reason.kind == "privileged_write" && reason.subject == target)
		{
			return false;
		}
		let timeout = ticket
			.reasons
			.iter()
			.filter_map(|reason| (reason.timeout_ms != 0).then_some(reason.timeout_ms))
			.min()
			.unwrap_or(120_000);
		now_epoch_ms() <= ticket.created_at_ms.saturating_add(timeout)
	}
}

fn requires_environment_host(body: &client_frame::Body) -> bool {
	matches!(
		body,
		client_frame::Body::Retire(_)
			| client_frame::Body::Shutdown(_)
			| client_frame::Body::EvalReset(_)
			| client_frame::Body::EditRepairAnswer(_)
			| client_frame::Body::AcpBind(_)
			| client_frame::Body::AcpDocumentAnswer(_)
			| client_frame::Body::AcpExecEvent(_)
			| client_frame::Body::RegisterPresence(_)
			| client_frame::Body::ReleasePresence(_)
			| client_frame::Body::OpenSession(_)
			| client_frame::Body::CloseSession(_)
			| client_frame::Body::Exec(_)
			| client_frame::Body::Stdin(_)
			| client_frame::Body::Signal(_)
			| client_frame::Body::Resize(_)
			| client_frame::Body::StartProcess(_)
			| client_frame::Body::GetProcess(_)
			| client_frame::Body::RestartProcess(_)
			| client_frame::Body::HttpRequest(_)
			| client_frame::Body::ListProcesses(_)
			| client_frame::Body::AttachOutput(_)
			| client_frame::Body::SendInput(_)
			| client_frame::Body::SignalProcess(_)
			| client_frame::Body::StopProcess(_)
	)
}

fn now_epoch_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX)
}

fn privileged_presence(value: i32) -> Result<bool, PrivilegedDispatchError> {
	match pb::ExpectedPresence::try_from(value).ok() {
		Some(pb::ExpectedPresence::Present) => Ok(true),
		Some(pb::ExpectedPresence::Missing) => Ok(false),
		_ => Err(PrivilegedDispatchError::Invalid(
			"privileged mutation requires an explicit expected presence",
		)),
	}
}

fn privileged_revision_hash(
	revision: Option<&document_pb::Revision>,
) -> Result<Option<[u8; 32]>, PrivilegedDispatchError> {
	revision
		.map(|revision| {
			revision.content_hash.as_ref().try_into().map_err(|_| {
				PrivilegedDispatchError::Invalid(
					"privileged mutation revision hash must contain 32 bytes",
				)
			})
		})
		.transpose()
}

fn canonical_privileged_target(root: &Path, input: &str) -> Result<(String, PathBuf), String> {
	let uri = Url::parse(input).map_err(|_| "privileged target is not a valid URI".to_owned())?;
	if uri.scheme() != "file" {
		return Err("privileged target must be a canonical file URI".to_owned());
	}
	let target = uri
		.to_file_path()
		.map_err(|()| "privileged target is not a local file URI".to_owned())?;
	let name = target
		.file_name()
		.ok_or_else(|| "privileged target must name a final filesystem entry".to_owned())?;
	let parent = target
		.parent()
		.ok_or_else(|| "privileged target has no parent directory".to_owned())?;
	let parent = fs::canonicalize(parent)
		.map_err(|error| format!("privileged target parent is not canonical: {error}"))?;
	let root = fs::canonicalize(root)
		.map_err(|error| format!("Environment root is not canonical: {error}"))?;
	if parent != root && !parent.starts_with(&root) {
		return Err("privileged target escapes the Environment root".to_owned());
	}
	let target = parent.join(name);
	let canonical_uri = Url::from_file_path(&target)
		.map_err(|()| "privileged target cannot be represented as a file URI".to_owned())?
		.to_string();
	if canonical_uri != uri.as_str() {
		return Err(format!("privileged target is not canonical; expected {canonical_uri}"));
	}
	Ok((canonical_uri, target))
}

fn privileged_dispatch_error(error: PrivilegedDispatchError) -> (pb::ProtocolErrorCode, String) {
	match error {
		PrivilegedDispatchError::Invalid(message) => {
			(pb::ProtocolErrorCode::InvalidArgument, message.to_owned())
		},
		PrivilegedDispatchError::Mutation(PrivilegedMutationFault::StaleRevision) => (
			pb::ProtocolErrorCode::PreconditionFailed,
			"privileged mutation expected state is stale".to_owned(),
		),
		PrivilegedDispatchError::Mutation(PrivilegedMutationFault::OperationNotPermitted {
			source,
		}) => (pb::ProtocolErrorCode::PermissionDenied, format!("EPERM: {source}")),
		PrivilegedDispatchError::Mutation(PrivilegedMutationFault::PermissionDenied { source }) => {
			(pb::ProtocolErrorCode::PermissionDenied, format!("EACCES: {source}"))
		},
		PrivilegedDispatchError::Mutation(PrivilegedMutationFault::ReadOnlyFilesystem { source }) => {
			(pb::ProtocolErrorCode::PermissionDenied, format!("EROFS: {source}"))
		},
		PrivilegedDispatchError::Mutation(PrivilegedMutationFault::Other { source }) => {
			(pb::ProtocolErrorCode::Internal, source.to_string())
		},
	}
}

const fn worker_operation(request: &pb::WorkerOp) -> &'static str {
	use pb::worker_op::Op;

	match request.op.as_ref() {
		Some(Op::Open(_)) => "omp.env.worker.open",
		Some(Op::Close(_)) => "omp.env.worker.close",
		Some(Op::Data(_)) => "omp.env.worker.data",
		Some(Op::Info(_)) => "omp.env.worker.info",
		Some(Op::List(_)) | None => "omp.env.worker.list",
	}
}

fn worker_info(route: &WorkerRoute) -> pb::WorkerInfo {
	pb::WorkerInfo {
		name: route.key.name.to_string(),
		generation: route.generation,
		state: pb::WorkerState::Ready as i32,
		..pb::WorkerInfo::default()
	}
}
fn workspace_update_failure(
	checked_at_ms: u64,
	code: impl Into<String>,
	message: impl Into<String>,
) -> pb::WorkspaceUpdateReport {
	pb::WorkspaceUpdateReport {
		checked: true,
		failure: Some(pb::ExtensionUpdateFailure { code: code.into(), message: message.into() }),
		checked_at_ms,
		..pb::WorkspaceUpdateReport::default()
	}
}
async fn fetch_extension_metadata(url: &str) -> Result<Vec<u8>, ()> {
	const MAX_METADATA_BYTES: usize = 16 * 1024 * 1024;
	let response = reqwest::get(url).await.map_err(|_| ())?;
	if !response.status().is_success() {
		return Err(());
	}
	let bytes = response.bytes().await.map_err(|_| ())?;
	if bytes.len() > MAX_METADATA_BYTES {
		return Err(());
	}
	Ok(bytes.to_vec())
}

fn write_extension_metadata(path: &Path, bytes: &[u8]) -> io::Result<()> {
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)?;
	}
	let temporary = path.with_extension("tmp");
	fs::write(&temporary, bytes)?;
	fs::rename(temporary, path)
}

fn update_refusal_wire(refusal: omp_ext::upgrade::UpdateRefusal) -> pb::ExtensionUpdateRefusal {
	use omp_ext::upgrade::UpdateRefusal;
	match refusal {
		UpdateRefusal::FeatureRemoved => pb::ExtensionUpdateRefusal::FeatureRemoved,
		UpdateRefusal::CapabilityChanged => pb::ExtensionUpdateRefusal::CapabilityChanged,
		UpdateRefusal::Pinned => pb::ExtensionUpdateRefusal::Pinned,
		UpdateRefusal::StaleRevocations => pb::ExtensionUpdateRefusal::StaleRevocations,
		UpdateRefusal::BadSignature => pb::ExtensionUpdateRefusal::BadSignature,
		UpdateRefusal::AttestationMissing => pb::ExtensionUpdateRefusal::Attestation,
		UpdateRefusal::PublisherChanged => pb::ExtensionUpdateRefusal::PublisherChanged,
		UpdateRefusal::Yanked => pb::ExtensionUpdateRefusal::Yanked,
		UpdateRefusal::Revoked => pb::ExtensionUpdateRefusal::Revoked,
		UpdateRefusal::Integrity => pb::ExtensionUpdateRefusal::Integrity,
	}
}

impl EnvServer {
	/// Clones the process lifecycle authority used by daemon-idle policy.
	pub(crate) fn process_host(&self) -> ExecHost {
		self.exec.clone()
	}

	fn new(
		identity: ServerIdentity,
		environment: Option<EnvironmentAuthorities>,
		tool_settings: ToolSettings,
		exec: ExecHost,
		acp_exec: AcpExecSlot,
		workspace: WorkspaceHost,
		mcp: Arc<McpService>,
		mcp_manager: Arc<McpManager>,
		resources: Arc<ResolverTable<UrlResolver>>,
		memory_runtime: RegisteredMemoryRuntime,
		blobs: BlobHost,
		sites: SiteMaterializer,
		materializations: ResourceMaterializer,
		registry: Arc<Registry>,
		ask_presenter: PresenterSlot,
		ext_hosts: Arc<ExtHostSupervisor>,
		eval_bridge: Arc<SessionBridgeHost>,
		reflection_bridge: Arc<ReflectionBridgeHost>,
		eval_control: EvalSessionControl,
		search_bridge: Arc<SearchBridgeHost>,
		github_credentials: Arc<GithubCredentialBridge>,
		usage_fetchers: omp_ai::operation::usage::UsageFetcherRegistry,
		provider_response_hooks: omp_ai::ProviderResponseHooks,
		admission_gate: Arc<HookGate>,
		checkpoint_control: AgentCheckpointControl,
		previews: StagedProposalRegistry,
		schedules: DurableScheduleActor,
		authority: Arc<AuthorityTable>,
		state_dir: &Path,
	) -> Self {
		let host_info = HostInfoHost::new(state_dir);
		let workspace_roots =
			WorkspaceRootHost::new(identity.root_uri.as_str(), identity.workspace_id.clone());
		let presence = PresenceRegistry::new(state_dir, workspace.root());
		Self {
			identity,
			environment,
			tool_settings,
			exec,
			acp_exec,
			approvals: ApprovalAuthoritySlot::default(),
			http_egress: HttpEgressHost::new(),
			workspace,
			mcp,
			mcp_manager,
			host_info,
			workspace_roots,
			resources,
			_memory_runtime: memory_runtime,
			blobs,
			sites,
			materializations,
			registry,
			ask_presenter,
			ext_hosts,
			eval_bridge,
			reflection_bridge,
			eval_control,
			search_bridge,
			github_credentials,
			usage_fetchers,
			provider_response_hooks,
			admission_gate,
			checkpoint_control,
			previews,
			schedules,
			workers: Arc::new(WorkerSupervisor::new(
				DEFAULT_WORKER_LAYER_CEILING,
				DEFAULT_MAX_CONCURRENT_SPAWNS,
			)),
			authority,
			repository_revision: AtomicU64::new(0),
			presence,
			state_dir: state_dir.to_path_buf(),
		}
	}

	/// Opens a complete local environment host rooted at `root`.
	///
	/// The document authority, workspace, blob store, executor, and Python
	/// worker are real environment-owned resources. `state_dir` is kept
	/// separate from the workspace so callers can use an isolated scratch
	/// directory without adding daemon state to the project tree.
	#[tracing::instrument(
		name = "environment_open",
		level = "debug",
		skip_all,
		fields(mode = "local", root = %root.display(), state_dir = %state_dir.display())
	)]
	pub async fn open_local(
		root: &Path,
		state_dir: &Path,
		registry: Registry,
		mut ext_host_config: ExtHostConfig,
		con: &Ctx,
		convars: Arc<dyn ControlAuthorityFactory>,
		bridges: RegistryBridges,
	) -> Result<Self, EnvdError> {
		let workspace = WorkspaceHost::open(root)?;
		let mcp = McpService::open(state_dir.join("mcp-cache.sqlite3"))
			.map_err(|error| EnvdError::State(Str::from(error.to_string())))?;
		mcp.bind_config_paths(
			McpConfigPaths::new(&omp_core::dirs::user_config_root()?, workspace.root())
				.with_agent_plugin_roots(bridges.content.agent_plugin_roots.clone()),
		);
		let lsp_settings = LspSettings::from_con(con);
		let doc_config = crate::docserver::ServerConfig::new(root)
			.map_err(|error| EnvdError::Document(Str::from(error.to_string())))?
			.with_server_build(omp_env::build_id::current());
		let environment = crate::docserver::Environment::new(doc_config)
			.map_err(|error| EnvdError::Document(Str::from(error.to_string())))?;
		let (document_client, document_server) = duplex(64 * 1024);
		tokio::spawn(async move {
			let _ = crate::docserver::connection::serve_connection(
				environment,
				document_server,
				ConnectionConfig::default(),
			)
			.await;
		});
		let documents = DocumentHost::connect(document_client).await?;
		let hello = documents.hello().clone();
		let interrupt_grace = ext_host_config.interrupt_grace;
		let py_eval = ext_host_config.py_eval;
		let session_id = ext_host_config.session_id.clone();
		let authority = Arc::new(AuthorityTable::default());
		ext_host_config.bind_workspace_root(workspace.root());
		ext_host_config.bind_data_authority(Arc::clone(&authority));
		bind_live_session_authority_snapshot(
			&mut ext_host_config,
			workspace.root(),
			bridges.session_authority.as_ref(),
		);
		let github_cache = Arc::new(
			GithubCache::open(
				state_dir.join("github-cache.sqlite3"),
				GithubCacheSettings::from_con(con).policy(),
			)
			.map_err(|error| EnvdError::State(Str::new(error.to_string())))?,
		);
		let blobs = BlobHost::open_managed(state_dir.join("blobs"), state_dir.join("sessions"))?;
		ext_host_config.bind_result_store(blobs.clone());
		let exec = ExecHost::new()
			.with_process_store(ProcessStore::new(state_dir.join("processes").join("meta.json")))?
			.with_github_cache(Arc::clone(&github_cache))
			.with_output_store(blobs.store().clone());
		let telemetry = Arc::new(
			TelemetryIndex::open(&state_dir.join("telemetry"), &state_dir.join("telemetry.sqlite3"))
				.map_err(|error| EnvdError::State(Str::from(error.to_string())))?,
		);
		let local_root =
			crate::tool_url::local::session_local_root(&state_dir.join("sessions"), &session_id);
		let mcp_manager = McpManager::new(
			Arc::clone(&mcp),
			Arc::new(ProductionConnector::new(workspace.root().to_path_buf())),
			Arc::from([hello.root_uri.clone()]),
			local_root,
		);
		mcp.bind_manager(&mcp_manager);
		mcp_manager.bind_runtime_settings(con);
		register_extension_convars(con, &ext_host_config.extensions)?;
		let schedules = DurableScheduleActor::spawn(state_dir)?;
		let control_bindings = production_control_authorities(
			state_dir,
			&session_id,
			&telemetry,
			&mcp,
			&ext_host_config.extensions,
			ext_host_config.domain_control_factories(),
			Arc::clone(&convars),
			ext_host_config.quota_runtime(),
			crate::extension_tool_call_timeout(con),
		);
		mcp_manager.bind_notification_sink(control_bindings.hooks.clone());
		ext_host_config.bind_control_authorities(Arc::clone(&control_bindings.factory));
		ext_host_config.bind_registry_control(Arc::clone(&control_bindings.registry));
		ext_host_config.bind_hook_control(Arc::clone(&control_bindings.hooks));
		let ext_hosts = Arc::new(ExtHostSupervisor::spawn(ext_host_config).await?);
		control_bindings
			.callbacks
			.bind(Arc::new(WeakExtensionCallbackDispatcher {
				supervisor: Arc::downgrade(&ext_hosts),
			}));
		let sites = SiteMaterializer::open(state_dir.join("ext"), blobs.store().clone())
			.map_err(|error| EnvdError::Blob(Str::from(error.to_string())))?;
		let materializations = ResourceMaterializer::open(
			workspace.root(),
			state_dir,
			&crate::tool_url::local::session_local_root(&state_dir.join("sessions"), &session_id),
		)?;
		let (host_settings, browser_settings, shell_settings, sandbox_settings, acp_settings) =
			execution_settings(con);
		exec.configure_sandbox(&sandbox_settings, workspace.root());
		let mcp_settings = McpSettings::from_con(con);
		mcp.start_native_configs(mcp_settings.enable_project_config)
			.await
			.map_err(|error| EnvdError::State(Str::from(error.to_string())))?;
		let workspace_ops = WorkspaceOperations::open(
			workspace.clone(),
			documents.clone(),
			blobs.clone(),
			omp_env::project_state::project_worktree_root(
				state_dir,
				host_settings.worktree.base.as_deref(),
			),
		)?;
		let memory_runtime =
			start_memory_runtime(&host_settings, state_dir, workspace.root(), &session_id).await?;
		let acp_exec = AcpExecSlot::default();
		let (
			registry,
			eval_bridge,
			reflection_bridge,
			eval_control,
			checkpoint_control,
			previews,
			resources,
			search_bridge,
			github_credentials,
			ask_presenter,
		) = production_registry(
			&documents,
			&blobs,
			&exec,
			state_dir,
			con,
			session_id.as_str(),
			Arc::clone(&github_cache),
			&mcp,
			Arc::clone(&mcp_manager),
			&workspace,
			memory_runtime.runtime(),
			&telemetry,
			&hello.root_uri,
			ext_hosts.as_ref(),
			interrupt_grace,
			py_eval,
			&host_settings.tools,
			&browser_settings,
			&shell_settings,
			&sandbox_settings,
			&acp_settings,
			acp_exec.clone(),
			&host_settings.autolearn,
			control_bindings.hooks.admission_gate(),
			WorkerDeviceInvoker::new(Arc::clone(&ext_hosts), blobs.clone()),
			PreludeBridgeInvoker::new(Arc::clone(&ext_hosts), blobs.clone()),
			omp_tool::ToolsPolicy::Auto,
			registry,
			bridges,
		)?;
		checkpoint_control.bind_local_workspace(workspace_ops.clone());
		control_bindings
			.resources
			.set(Arc::clone(&resources))
			.map_err(|_| EnvdError::State(sf!("CONTROL URL resolver owner was already bound")))?;
		ext_hosts.activate_control_hosts().await?;
		let identity = ServerIdentity {
			workspace_id:   hello.workspace_id,
			root_uri:       hello.root_uri,
			server_epoch:   hello.server_epoch,
			server_version: Str::from(env!("CARGO_PKG_VERSION")),
			server_build:   Str::from(omp_env::build_id::current()),
		};
		let usage_fetchers = control_bindings.hooks.usage_fetchers();
		let provider_response_hooks =
			omp_ai::ProviderResponseHooks::new(control_bindings.hooks.clone());
		let admission_gate = control_bindings.hooks.admission_gate();
		Ok(Self::new(
			identity,
			Some(EnvironmentAuthorities {
				documents,
				_document_authority: None,
				workspace_ops,
				lsp_settings,
				process_store: ProcessStore::new(state_dir.join("processes").join("meta.json")),
			}),
			host_settings.tools.clone(),
			exec,
			acp_exec,
			workspace,
			mcp,
			mcp_manager,
			resources,
			memory_runtime,
			blobs,
			sites,
			materializations,
			registry,
			ask_presenter,
			ext_hosts,
			eval_bridge,
			reflection_bridge,
			eval_control,
			search_bridge,
			github_credentials,
			usage_fetchers,
			provider_response_hooks,
			admission_gate,
			checkpoint_control,
			previews,
			schedules,
			authority,
			state_dir,
		))
	}

	/// Opens project resources through the owner-local document authority.
	///
	/// Only the daemon composition (`doc_connections` present) owns durable
	/// process metadata; app compositions keep in-memory process state and
	/// leave detached-process recovery to the daemon. An approval-mode override
	/// affects only this composition's in-memory tool settings.
	#[cfg(any(unix, windows))]
	#[tracing::instrument(
		name = "environment_open",
		level = "debug",
		skip_all,
		fields(
			mode = "project",
			root = %root.display(),
			state_dir = %state_dir.display(),
			daemon = doc_connections.is_some()
		)
	)]
	pub async fn open_project(
		root: &Path,
		state_dir: &Path,
		docserver_socket: &Path,
		registry: Registry,
		mut ext_host_config: ExtHostConfig,
		doc_connections: Option<watch::Sender<usize>>,
		require_document_ownership: bool,
		approval_mode: Option<super::tool_settings::ApprovalMode>,
		con: &Ctx,
		convars: Arc<dyn ControlAuthorityFactory>,
		bridges: RegistryBridges,
	) -> Result<Self, EnvdError> {
		let workspace = WorkspaceHost::open(root)?;
		let root = workspace.root().to_path_buf();
		let mcp = McpService::open(state_dir.join("mcp-cache.sqlite3"))
			.map_err(|error| EnvdError::State(Str::from(error.to_string())))?;
		mcp.bind_config_paths(
			McpConfigPaths::new(&omp_core::dirs::user_config_root()?, workspace.root())
				.with_agent_plugin_roots(bridges.content.agent_plugin_roots.clone()),
		);
		let lsp_settings = LspSettings::from_con(con);
		let document_lsp = crate::docserver::NativeLspOptions {
			enabled: lsp_settings.enabled,
			lazy:    lsp_settings.lazy,
		};
		let document_user_config = Some(document_user_config_root()?);
		let server_build = Str::from(omp_env::build_id::current());
		let (documents, mut document_authority) = connect_or_start_docserver(
			&root,
			docserver_socket,
			doc_connections.clone(),
			require_document_ownership,
			document_lsp.clone(),
			document_user_config.clone(),
			server_build.clone(),
		)
		.await?;
		if !require_document_ownership {
			let retained_authority = Arc::new(tokio::sync::Mutex::new(document_authority.take()));
			let rehost_root = root.clone();
			let rehost_socket = docserver_socket.to_path_buf();
			let rehost_connections = doc_connections.clone();
			let rehost_state_dir = state_dir.to_path_buf();
			documents.install_rehost(Arc::new(move || -> super::docs::RehostFuture {
				let retained_authority = Arc::clone(&retained_authority);
				let root = rehost_root.clone();
				let socket = rehost_socket.clone();
				let connections = rehost_connections.clone();
				let lsp = document_lsp.clone();
				let user_config_root = document_user_config.clone();
				let state_dir = rehost_state_dir.clone();
				let server_build = server_build.clone();
				Box::pin(async move {
					let mut retained = retained_authority.lock().await;
					retained.take();
					match rehost_document_authority(
						&root,
						&state_dir,
						&socket,
						connections,
						lsp,
						user_config_root,
						server_build,
					)
					.await
					{
						Ok(authority) => *retained = authority,
						Err(EnvdError::DocumentAuthorityHeldBy { .. }) => {},
						Err(error) => {
							tracing::debug!(%error, "document authority rehost race did not win");
						},
					}
				})
			}));
		}
		let hello = documents.hello().clone();
		let interrupt_grace = ext_host_config.interrupt_grace;
		let py_eval = ext_host_config.py_eval;
		let session_id = ext_host_config.session_id.clone();
		let authority = Arc::new(AuthorityTable::default());
		ext_host_config.bind_workspace_root(&root);
		ext_host_config.bind_data_authority(Arc::clone(&authority));
		bind_live_session_authority_snapshot(
			&mut ext_host_config,
			&root,
			bridges.session_authority.as_ref(),
		);
		let github_cache = Arc::new(
			GithubCache::open(
				state_dir.join("github-cache.sqlite3"),
				GithubCacheSettings::from_con(con).policy(),
			)
			.map_err(|error| EnvdError::State(Str::new(error.to_string())))?,
		);
		let blobs = BlobHost::open_managed(state_dir.join("blobs"), state_dir.join("sessions"))?;
		ext_host_config.bind_result_store(blobs.clone());
		let exec = if doc_connections.is_some() {
			ExecHost::new()
				.with_process_store(ProcessStore::new(state_dir.join("processes").join("meta.json")))?
		} else {
			ExecHost::new()
		}
		.with_github_cache(Arc::clone(&github_cache))
		.with_output_store(blobs.store().clone());
		let telemetry = Arc::new(
			TelemetryIndex::open(&state_dir.join("telemetry"), &state_dir.join("telemetry.sqlite3"))
				.map_err(|error| EnvdError::State(Str::from(error.to_string())))?,
		);
		let local_root =
			crate::tool_url::local::session_local_root(&state_dir.join("sessions"), &session_id);
		let mcp_manager = McpManager::new(
			Arc::clone(&mcp),
			Arc::new(ProductionConnector::new(workspace.root().to_path_buf())),
			Arc::from([hello.root_uri.clone()]),
			local_root,
		);
		mcp.bind_manager(&mcp_manager);
		mcp_manager.bind_runtime_settings(con);
		register_extension_convars(con, &ext_host_config.extensions)?;
		let schedules = DurableScheduleActor::spawn(state_dir)?;
		let control_bindings = production_control_authorities(
			state_dir,
			&session_id,
			&telemetry,
			&mcp,
			&ext_host_config.extensions,
			ext_host_config.domain_control_factories(),
			Arc::clone(&convars),
			ext_host_config.quota_runtime(),
			crate::extension_tool_call_timeout(con),
		);
		mcp_manager.bind_notification_sink(control_bindings.hooks.clone());
		ext_host_config.bind_control_authorities(Arc::clone(&control_bindings.factory));
		ext_host_config.bind_registry_control(Arc::clone(&control_bindings.registry));
		ext_host_config.bind_hook_control(Arc::clone(&control_bindings.hooks));
		let ext_hosts = Arc::new(ExtHostSupervisor::spawn(ext_host_config).await?);
		control_bindings
			.callbacks
			.bind(Arc::new(WeakExtensionCallbackDispatcher {
				supervisor: Arc::downgrade(&ext_hosts),
			}));
		let sites = SiteMaterializer::open(state_dir.join("ext"), blobs.store().clone())
			.map_err(|error| EnvdError::Blob(Str::from(error.to_string())))?;
		let materializations = ResourceMaterializer::open(
			workspace.root(),
			state_dir,
			&crate::tool_url::local::session_local_root(&state_dir.join("sessions"), &session_id),
		)?;
		let (mut host_settings, browser_settings, shell_settings, sandbox_settings, acp_settings) =
			execution_settings(con);
		exec.configure_sandbox(&sandbox_settings, workspace.root());
		host_settings.tools = host_settings
			.tools
			.with_approval_mode_override(approval_mode);
		let mcp_settings = McpSettings::from_con(con);
		mcp.start_native_configs(mcp_settings.enable_project_config)
			.await
			.map_err(|error| EnvdError::State(Str::from(error.to_string())))?;
		let workspace_ops = WorkspaceOperations::open(
			workspace.clone(),
			documents.clone(),
			blobs.clone(),
			omp_env::project_state::project_worktree_root(
				state_dir,
				host_settings.worktree.base.as_deref(),
			),
		)?;
		let memory_runtime =
			start_memory_runtime(&host_settings, state_dir, workspace.root(), &session_id).await?;
		let acp_exec = AcpExecSlot::default();
		let (
			registry,
			eval_bridge,
			reflection_bridge,
			eval_control,
			checkpoint_control,
			previews,
			resources,
			search_bridge,
			github_credentials,
			ask_presenter,
		) = production_registry(
			&documents,
			&blobs,
			&exec,
			state_dir,
			con,
			session_id.as_str(),
			Arc::clone(&github_cache),
			&mcp,
			Arc::clone(&mcp_manager),
			&workspace,
			memory_runtime.runtime(),
			&telemetry,
			&hello.root_uri,
			ext_hosts.as_ref(),
			interrupt_grace,
			py_eval,
			&host_settings.tools,
			&browser_settings,
			&shell_settings,
			&sandbox_settings,
			&acp_settings,
			acp_exec.clone(),
			&host_settings.autolearn,
			control_bindings.hooks.admission_gate(),
			WorkerDeviceInvoker::new(Arc::clone(&ext_hosts), blobs.clone()),
			PreludeBridgeInvoker::new(Arc::clone(&ext_hosts), blobs.clone()),
			omp_tool::ToolsPolicy::Auto,
			registry,
			bridges,
		)?;
		checkpoint_control.bind_local_workspace(workspace_ops.clone());
		control_bindings
			.resources
			.set(Arc::clone(&resources))
			.map_err(|_| EnvdError::State(sf!("CONTROL URL resolver owner was already bound")))?;
		ext_hosts.activate_control_hosts().await?;
		let identity = ServerIdentity {
			workspace_id:   hello.workspace_id,
			root_uri:       hello.root_uri,
			server_epoch:   hello.server_epoch,
			server_version: Str::from(env!("CARGO_PKG_VERSION")),
			server_build:   Str::from(omp_env::build_id::current()),
		};
		let usage_fetchers = control_bindings.hooks.usage_fetchers();
		let provider_response_hooks =
			omp_ai::ProviderResponseHooks::new(control_bindings.hooks.clone());
		let admission_gate = control_bindings.hooks.admission_gate();
		Ok(Self::new(
			identity,
			Some(EnvironmentAuthorities {
				documents,
				_document_authority: document_authority,
				workspace_ops,
				lsp_settings,
				process_store: ProcessStore::new(state_dir.join("processes").join("meta.json")),
			}),
			host_settings.tools.clone(),
			exec,
			acp_exec,
			workspace,
			mcp,
			mcp_manager,
			resources,
			memory_runtime,
			blobs,
			sites,
			materializations,
			registry,
			ask_presenter,
			ext_hosts,
			eval_bridge,
			reflection_bridge,
			eval_control,
			search_bridge,
			github_credentials,
			usage_fetchers,
			provider_response_hooks,
			admission_gate,
			checkpoint_control,
			previews,
			schedules,
			authority,
			state_dir,
		))
	}

	/// Opens the session-owned half without composing project authorities or
	/// environment tool executors.
	#[tracing::instrument(
		name = "environment_open",
		level = "debug",
		skip_all,
		fields(mode = "session", root = %root.display(), state_dir = %state_dir.display())
	)]
	pub async fn open_session_host(
		root: &Path,
		state_dir: &Path,
		registry: Registry,
		mut ext_host_config: ExtHostConfig,
		approval_mode: Option<super::tool_settings::ApprovalMode>,
		con: &Ctx,
		convars: Arc<dyn ControlAuthorityFactory>,
		bridges: RegistryBridges,
		owner: EnvClient,
	) -> Result<Self, EnvdError> {
		let owner_info = owner.info().ok_or(EnvdError::MissingOwnerHello)?;
		let workspace = WorkspaceHost::open(root)?;
		let root = workspace.root().to_path_buf();
		let py_eval = ext_host_config.py_eval;
		let session_id = ext_host_config.session_id.clone();
		let authority = Arc::new(AuthorityTable::default());
		ext_host_config.bind_workspace_root(&root);
		ext_host_config.bind_data_authority(Arc::clone(&authority));
		bind_live_session_authority_snapshot(
			&mut ext_host_config,
			&root,
			bridges.session_authority.as_ref(),
		);

		let mcp = McpService::open(state_dir.join("mcp-cache.sqlite3"))
			.map_err(|error| EnvdError::State(Str::from(error.to_string())))?;
		mcp.bind_config_paths(
			McpConfigPaths::new(&omp_core::dirs::user_config_root()?, &root)
				.with_agent_plugin_roots(bridges.content.agent_plugin_roots.clone()),
		);
		let github_cache = Arc::new(
			GithubCache::open(
				state_dir.join("github-cache.sqlite3"),
				GithubCacheSettings::from_con(con).policy(),
			)
			.map_err(|error| EnvdError::State(Str::new(error.to_string())))?,
		);
		let blobs = BlobHost::open_managed(state_dir.join("blobs"), state_dir.join("sessions"))?;
		ext_host_config.bind_result_store(blobs.clone());
		let exec = ExecHost::new()
			.with_github_cache(Arc::clone(&github_cache))
			.with_output_store(blobs.store().clone());
		let telemetry = Arc::new(
			TelemetryIndex::open(&state_dir.join("telemetry"), &state_dir.join("telemetry.sqlite3"))
				.map_err(|error| EnvdError::State(Str::from(error.to_string())))?,
		);
		let local_root =
			crate::tool_url::local::session_local_root(&state_dir.join("sessions"), &session_id);
		let mcp_manager = McpManager::new(
			Arc::clone(&mcp),
			Arc::new(ProductionConnector::new(root.clone())),
			Arc::from([Str::from(owner_info.root_uri.clone())]),
			local_root,
		);
		mcp.bind_manager(&mcp_manager);
		mcp_manager.bind_runtime_settings(con);
		let mcp_settings = McpSettings::from_con(con);
		// Native config mounting requires the bound manager: reload resolves
		// through the live transport supervisor.
		mcp.start_native_configs(mcp_settings.enable_project_config)
			.await
			.map_err(|error| EnvdError::State(Str::from(error.to_string())))?;

		register_extension_convars(con, &ext_host_config.extensions)?;
		let schedules = DurableScheduleActor::spawn(state_dir)?;
		let control_bindings = production_control_authorities(
			state_dir,
			&session_id,
			&telemetry,
			&mcp,
			&ext_host_config.extensions,
			ext_host_config.domain_control_factories(),
			Arc::clone(&convars),
			ext_host_config.quota_runtime(),
			crate::extension_tool_call_timeout(con),
		);
		mcp_manager.bind_notification_sink(control_bindings.hooks.clone());
		ext_host_config.bind_control_authorities(Arc::clone(&control_bindings.factory));
		ext_host_config.bind_registry_control(Arc::clone(&control_bindings.registry));
		ext_host_config.bind_hook_control(Arc::clone(&control_bindings.hooks));
		let ext_hosts = Arc::new(ExtHostSupervisor::spawn(ext_host_config).await?);
		control_bindings
			.callbacks
			.bind(Arc::new(WeakExtensionCallbackDispatcher {
				supervisor: Arc::downgrade(&ext_hosts),
			}));

		let sites = SiteMaterializer::open(state_dir.join("ext"), blobs.store().clone())
			.map_err(|error| EnvdError::Blob(Str::from(error.to_string())))?;
		let materializations = ResourceMaterializer::open(
			&root,
			state_dir,
			&crate::tool_url::local::session_local_root(&state_dir.join("sessions"), &session_id),
		)?;
		let (mut host_settings, browser_settings, shell_settings, _sandbox_settings, acp_settings) =
			execution_settings(con);
		host_settings.tools = host_settings
			.tools
			.with_approval_mode_override(approval_mode);
		let memory_runtime =
			start_memory_runtime(&host_settings, state_dir, &root, &session_id).await?;

		let RegistryBridges {
			command_credentials: _,
			dynamic_tools,
			dynamic_tool_factories,
			url_resolvers: _,
			goal_control,
			search,
			edit_model: _,
			edit_repair: _,
			host_resources: _,
			session_authority: _,
			telemetry_upload,
			ask_presenter,
			content,
		} = bridges;
		let declarations = build_environment_declaration_inputs(
			state_dir,
			&root,
			con,
			ext_hosts.as_ref(),
			&host_settings.tools,
			&shell_settings,
			&acp_settings,
			&host_settings.memory,
			&host_settings.autolearn,
			&content,
			omp_tool::ToolsPolicy::Auto,
		)?;
		let session = session_registry(
			registry,
			&blobs,
			&root,
			state_dir,
			&telemetry,
			Arc::clone(&github_cache),
			ext_hosts.as_ref(),
			py_eval,
			con,
			omp_tool::ToolsPolicy::Auto,
			&host_settings.tools,
			&browser_settings,
			&declarations,
			SessionRegistryBridges {
				dynamic_tools,
				dynamic_tool_factories,
				goal_control,
				search,
				telemetry_upload,
				ask_presenter,
			},
		)?;
		session
			.checkpoint_control
			.bind_owner_workspace(owner.clone());

		let resources = Arc::new(ResolverTable::default());
		control_bindings
			.resources
			.set(Arc::clone(&resources))
			.map_err(|_| EnvdError::State(sf!("CONTROL URL resolver owner was already bound")))?;
		ext_hosts.activate_control_hosts().await?;
		let identity = ServerIdentity {
			workspace_id:   owner_info.workspace_id,
			root_uri:       Str::from(owner_info.root_uri),
			server_epoch:   owner_info.server_epoch,
			server_version: Str::from(env!("CARGO_PKG_VERSION")),
			server_build:   Str::from(owner_info.server_build),
		};
		let usage_fetchers = control_bindings.hooks.usage_fetchers();
		let provider_response_hooks =
			omp_ai::ProviderResponseHooks::new(control_bindings.hooks.clone());
		let admission_gate = control_bindings.hooks.admission_gate();
		Ok(Self::new(
			identity,
			None,
			host_settings.tools.clone(),
			exec,
			AcpExecSlot::default(),
			workspace,
			mcp,
			mcp_manager,
			resources,
			memory_runtime,
			blobs,
			sites,
			materializations,
			session.registry,
			session.ask_presenter,
			ext_hosts,
			Arc::new(SessionBridgeHost::new()),
			Arc::new(ReflectionBridgeHost::new()),
			EvalSessionControl::default(),
			session.search_bridge,
			session.github_credentials,
			usage_fetchers,
			provider_response_hooks,
			admission_gate,
			session.checkpoint_control,
			StagedProposalRegistry::new(),
			schedules,
			authority,
			state_dir,
		))
	}

	/// Connects raw frame channels to an owner-only environment socket.
	#[cfg(unix)]
	pub async fn connect_owner_uds_frames(
		path: &Path,
	) -> Result<(FramePipe, JoinHandle<Result<(), EnvdError>>), EnvdError> {
		use std::os::unix::fs::{FileTypeExt as _, MetadataExt as _, PermissionsExt as _};

		let metadata = tokio::fs::symlink_metadata(path).await?;
		if !metadata.file_type().is_socket()
			|| metadata.uid() != nix::unistd::geteuid().as_raw()
			|| metadata.permissions().mode() & 0o077 != 0
		{
			return Err(
				io::Error::new(
					io::ErrorKind::PermissionDenied,
					"environment socket must be owner-only and owned by the current user",
				)
				.into(),
			);
		}
		let stream = UnixStream::connect(path).await?;
		let (outgoing, requests) = flume::bounded(64);
		let (responses, incoming) = flume::bounded(64);
		let task = tokio::spawn(async move {
			let (mut reader, mut writer) = stream.into_split();
			let shutdown = CancellationToken::new();
			let read_shutdown = shutdown.clone();
			let read = async move {
				let mut scratch = BytesMut::new();
				loop {
					let frame = tokio::select! {
						() = read_shutdown.cancelled() => return Ok::<(), io::Error>(()),
						result = read_server_frame(&mut reader, &mut scratch) => result?,
					};
					let Some(frame) = frame else { return Ok(()) };
					if responses.send_async(frame).await.is_err() {
						return Ok(());
					}
				}
			};
			let write = async move {
				let result = async {
					let mut scratch = BytesMut::new();
					while let Ok(frame) = requests.recv_async().await {
						write_client_frame(&mut writer, &frame, &mut scratch).await?;
					}
					Ok::<(), io::Error>(())
				}
				.await;
				shutdown.cancel();
				result
			};
			let (read_result, write_result) = tokio::join!(read, write);
			read_result?;
			write_result?;
			Ok(())
		});
		Ok((FramePipe::new(outgoing, incoming), task))
	}

	/// Connects an `EnvClient` transport to an owner-only environment socket.
	#[cfg(unix)]
	pub async fn connect_owner_uds(
		path: &Path,
	) -> Result<(EnvClient, JoinHandle<Result<(), EnvdError>>), EnvdError> {
		let (frames, task) = Self::connect_owner_uds_frames(path).await?;
		let (outgoing, incoming) = frames.into_parts();
		Ok((EnvClient::from_channels(outgoing, incoming), task))
	}

	/// Enforces persisted RECORD ownership before a trusted extension imports a
	/// module from its materialized site tree.
	pub(crate) fn require_record_owner(
		&self,
		site_key: &str,
		module: impl Into<Str>,
		owner: impl Into<Str>,
	) -> Result<(), SiteError> {
		self.sites.require_record_owner(site_key, module, owner)
	}

	/// Returns the exact registry shared by this server's dispatch paths.
	pub fn registry(&self) -> Arc<Registry> {
		Arc::clone(&self.registry)
	}

	/// Binds the production router for one authenticated extension-host
	/// connection.
	pub fn extension_control_authority(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		self.ext_hosts.control_authority(identity)
	}

	/// Returns the generation-fenced callback transport shared by provider,
	/// regime, presentation, and job backends.
	pub fn extension_callback_dispatcher(&self) -> Arc<dyn CallbackDispatcher> {
		Arc::new(WeakExtensionCallbackDispatcher { supervisor: Arc::downgrade(&self.ext_hosts) })
	}

	/// Returns the eager prompt-contribution provider over live worker actors.
	pub fn extension_prompt_provider(&self) -> Arc<dyn crate::exthost::PromptContributionProvider> {
		let provider: Arc<dyn crate::exthost::PromptContributionProvider> = self.ext_hosts.clone();
		provider
	}

	/// Drains idle extension hosts and starts their hot-reload generations.
	pub async fn reload_extensions(&self) -> Result<Vec<u64>, ExtHostError> {
		self.ext_hosts.reload().await
	}

	/// Respawns only the child owning one linked extension.
	pub async fn reload_extension(&self, extension: &str) -> Result<u64, ExtHostError> {
		self.ext_hosts.reload_extension(extension).await
	}

	/// Stops host groups containing newly revoked extensions while retaining
	/// their static unavailable routes.
	pub async fn quarantine_extensions(&self, extensions: &[Str]) {
		self.ext_hosts.quarantine(extensions).await;
	}

	/// Returns the shared extension and built-in provider usage registry.
	pub fn usage_fetchers(&self) -> omp_ai::operation::usage::UsageFetcherRegistry {
		self.usage_fetchers.clone()
	}

	/// Returns the session-owned provider response hook sink.
	pub fn provider_response_hooks(&self) -> omp_ai::ProviderResponseHooks {
		self.provider_response_hooks.clone()
	}

	/// Returns the live per-session admission hook gate.
	pub fn admission_gate(&self) -> Arc<HookGate> {
		Arc::clone(&self.admission_gate)
	}

	/// Returns the sealed deployment manifest for an exact live CONTROL
	/// connection generation.
	pub fn extension_control_manifest(
		&self,
		identity: &ControlConnectionIdentity,
	) -> Option<ExtensionManifest> {
		self.ext_hosts.control_manifest(identity)
	}

	/// Returns the full frozen runtime provider/regime declaration projection
	/// for an exact authenticated connection generation.
	pub fn extension_registry_evidence(
		&self,
		identity: &ControlConnectionIdentity,
	) -> Option<Arc<SealedRegistryEvidence>> {
		self.ext_hosts.sealed_registry_evidence(identity)
	}

	/// Registers frozen Python Directors and Components with an engine
	/// registrar.
	pub fn register_python_extensions(
		&self,
		registrar: &mut omp_agent::ExtensionRegistrar,
	) -> Result<Vec<crate::exthost::PyComponent>, crate::exthost::PyExtensionError> {
		self.ext_hosts.register_python_extensions(registrar)
	}

	/// Returns every currently sealed exact-generation extension registry.
	pub fn extension_registry_evidences(&self) -> Vec<Arc<SealedRegistryEvidence>> {
		self.ext_hosts.sealed_registry_evidences()
	}

	/// Returns every authenticated extension CONTROL identity.
	pub fn extension_control_identities(&self) -> Vec<Arc<ControlConnectionIdentity>> {
		self.ext_hosts.control_identities()
	}

	/// Returns the session-owned MCP manager for late bridge injection.
	pub(crate) const fn mcp_manager(&self) -> &Arc<McpManager> {
		&self.mcp_manager
	}

	/// Returns the session-owned native MCP configuration authority.
	pub(crate) const fn mcp(&self) -> &Arc<McpService> {
		&self.mcp
	}

	/// Constructs one generation-fenced MCP CONTROL resolver for a host
	/// connection.
	pub(crate) fn mcp_control(
		&self,
		identity: Arc<ControlConnectionIdentity>,
		cancellation: CancellationToken,
	) -> Option<McpControl> {
		self.mcp.control(identity, cancellation)
	}

	/// Replaces the ask presenter for this environment composition.
	pub(crate) fn bind_ask_presenter(&self, presenter: Arc<dyn omp_tools::ask::AskPresenter>) {
		self.ask_presenter.bind(presenter);
	}

	fn environment_authorities(&self) -> Option<&EnvironmentAuthorities> {
		self.environment.as_ref()
	}

	/// Returns the project document authority shared by standalone commands.
	///
	/// Session-only hosts intentionally do not expose this authority; this
	/// compatibility accessor remains until document clients are protocol-only.
	pub(crate) fn documents(&self) -> &DocumentHost {
		&self
			.environment
			.as_ref()
			.expect("session-only environment host has no document authority")
			.documents
	}

	/// Gracefully stops every nonpersistent process owned by this environment.
	///
	/// Durable detached generations remain owned by the process store and are
	/// intentionally spared by the executor's managed-shutdown policy.
	pub(crate) async fn shutdown_managed(&self, grace: Duration) {
		let _ = self.exec.shutdown_managed(grace).await;
		self.ext_hosts.shutdown().await;
	}

	/// Returns the session's sole Off/Mnemopi runtime.
	pub(crate) fn memory_runtime(&self) -> Arc<omp_memory::MemoryRuntime> {
		Arc::clone(self._memory_runtime.runtime())
	}

	/// Binds or clears the session-scoped ACP terminal execution capability.
	pub(crate) fn bind_acp_exec(&self, backend: Option<Arc<dyn AcpExecBackend>>) {
		self.acp_exec.bind(backend);
	}

	/// Binds or clears the session-scoped ACP document authority.
	pub(crate) fn bind_acp_documents(&self, backend: Option<Arc<dyn AcpDocumentBackend>>) {
		self
			.environment
			.as_ref()
			.expect("session-only environment host has no document authority")
			.documents
			.bind_acp_documents(backend);
	}

	/// Binds the live durable approval authority used by Environment fallbacks.
	pub(crate) fn bind_approval_authority(
		&self,
		book: Option<Arc<ApprovalBook>>,
		route: Option<ApprovalRoute>,
	) {
		self.approvals.bind(book, route.clone());
		self.exec.bind_dynamic_approval_route(route.clone());
		self.exec.bind_sandbox_approval_route(route);
	}

	/// Returns the session bridge binding retained by this environment.
	pub(crate) fn eval_bridge(&self) -> Arc<SessionBridgeHost> {
		Arc::clone(&self.eval_bridge)
	}

	/// Binds one durable session principal to its live eval parent authority.
	pub fn bind_eval_sdk_parent(
		&self,
		owner: Str,
		parent: Arc<dyn ParentSessionHost>,
	) -> Result<ParentBindingLease, BridgeHostError> {
		self.eval_bridge.bind_sdk_parent(owner, parent)
	}

	/// Returns the late-bound memory reflection bridge.
	pub(crate) fn reflection_bridge(&self) -> Arc<ReflectionBridgeHost> {
		Arc::clone(&self.reflection_bridge)
	}

	pub(crate) fn eval_control(&self) -> EvalSessionControl {
		self.eval_control.clone()
	}

	/// Returns the late-bound canonical search bridge.
	pub(crate) fn search_bridge(&self) -> Arc<SearchBridgeHost> {
		Arc::clone(&self.search_bridge)
	}

	/// Returns the late-bound GitHub credential projection.
	pub(crate) fn github_credentials(&self) -> Arc<GithubCredentialBridge> {
		Arc::clone(&self.github_credentials)
	}

	/// Returns the session generation fencing CONTROL connections.
	pub(crate) fn session_generation(&self) -> u64 {
		self.ext_hosts.session_generation()
	}

	/// Atomically installs the chat-parent owner of `omp.agents.*`.
	pub(crate) fn bind_agents_control_authority(
		&self,
		factory: Arc<dyn ControlAuthorityFactory>,
	) -> AgentsControlAuthorityBinding {
		self.ext_hosts.bind_agents_control_authority(factory)
	}

	/// Atomically installs and generation-fences the driver/app CONTROL domain
	/// bundle. Dropping the returned lease revokes only this exact binding.
	pub fn bind_domain_control_factories(
		&self,
		mut factories: ExternalDomainControlFactories,
	) -> ExternalDomainControlBinding {
		factories.services = Some(self.ext_hosts.service_control_factory());
		self.ext_hosts.bind_domain_control_factories(factories)
	}

	/// Atomically installs Agents and all driver/app CONTROL owners under one
	/// replacement/revocation lease.
	pub fn bind_external_control_authorities(
		&self,
		agents: Arc<dyn ControlAuthorityFactory>,
		mut domains: ExternalDomainControlFactories,
	) -> ExternalControlAuthorityBinding {
		domains.services = Some(self.ext_hosts.service_control_factory());
		self
			.ext_hosts
			.bind_external_control_authorities(agents, domains)
	}

	/// Binds the active Agent Journal mailbox to checkpoint and staged-preview
	/// CONTROL until the returned lease is dropped.
	pub(crate) fn bind_agent_control(self: &Arc<Self>, sender: KernelSender) -> AgentControlBinding {
		let id = NEXT_AGENT_CONTROL_BINDING.fetch_add(1, Ordering::Relaxed);
		self.checkpoint_control.bind(id, sender.clone());
		let diagnostics = self.environment.as_ref().map(|environment| {
			let diagnostics = Arc::new(LateDiagnosticsBatcher {
				pending:   parking_lot::Mutex::new(Vec::new()),
				scheduled: AtomicBool::new(false),
				active:    AtomicBool::new(true),
				sender:    sender.clone(),
			});
			let sink = Arc::clone(&diagnostics);
			environment
				.documents
				.bind_late_diagnostics(id, Arc::new(move |batch| sink.push(batch)));
			diagnostics
		});
		self
			.previews
			.install_activation_observer(Arc::new(move |pending| {
				let sender = sender.clone();
				Box::pin(async move {
					sender
						.send_async(omp_agent::Up::Env(omp_agent::EnvEvent::StagedPreview {
							proposal_id: pending.id,
							source_tool: pending.source_tool,
						}))
						.await
						.map_err(|_| omp_tools::staging::ProposalActivationError::Rejected)
				})
			}));
		AgentControlBinding { server: Arc::clone(self), id, diagnostics }
	}

	/// Installs the project-lifetime owner for durable scheduled Agent
	/// delivery. The backend is retained by envd independently of any chat UI.
	pub(crate) async fn bind_schedule_delivery(
		&self,
		backend: Arc<dyn ScheduleDeliveryBackend>,
	) -> Result<(), EnvdError> {
		self.schedules.bind_schedule_delivery(backend).await
	}

	fn release_agent_control(&self, id: u64) {
		if let Some(environment) = &self.environment {
			environment.documents.unbind_late_diagnostics(id);
		}
		if self.checkpoint_control.unbind(id) {
			self.previews.remove_activation_observer();
		}
	}

	/// Binds extension device availability to the active Agent turn boundary.
	pub(crate) fn bind_device_availability(&self, mailbox: KernelSender) {
		self
			.ext_hosts
			.bind_availability_sink(Arc::new(RegistryAvailabilitySink::new(
				Arc::clone(&self.registry),
				mailbox,
			)));
	}

	/// Serves the server half returned by [`omp_env::EnvClient::in_process`].
	pub async fn serve_in_process(&self, transport: InProcessEnvTransport) {
		let (requests, responses) = transport.into_parts();
		self
			.serve_frames(requests, responses, ConnectionPolicy::in_process())
			.await;
	}

	/// Serves one already-accepted byte stream with varint protobuf framing.
	pub async fn serve_io<S>(&self, stream: S) -> Result<(), EnvdError>
	where
		S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
	{
		self
			.serve_io_with_policy(stream, ConnectionPolicy::external(None))
			.await
	}

	pub(crate) async fn serve_io_with_policy<S>(
		&self,
		stream: S,
		policy: ConnectionPolicy,
	) -> Result<(), EnvdError>
	where
		S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
	{
		let (mut reader, mut writer) = split(stream);
		let (request_tx, requests) = flume::bounded(64);
		let (responses, response_rx) = flume::bounded(64);
		let retire = policy.retire.clone();
		let dispatch = self.serve_frames(requests, responses, policy);
		let io_shutdown = CancellationToken::new();
		let read_shutdown = io_shutdown.clone();
		let read = async move {
			let mut scratch = BytesMut::new();
			loop {
				let frame = tokio::select! {
					() = read_shutdown.cancelled() => return Ok::<(), io::Error>(()),
					result = read_client_frame(&mut reader, &mut scratch) => result?,
				};
				let Some(frame) = frame else { return Ok(()) };
				if request_tx.send_async(frame).await.is_err() {
					return Ok(());
				}
			}
		};
		let write = async move {
			let result = async {
				let mut scratch = BytesMut::new();
				while let Ok(frame) = response_rx.recv_async().await {
					write_server_frame(&mut writer, &frame, &mut scratch).await?;
					if matches!(frame.body, Some(server_frame::Body::RetireStarted(_)))
						&& let Some(retire) = &retire
					{
						retire.cancel();
					}
				}
				Ok::<(), io::Error>(())
			}
			.await;
			io_shutdown.cancel();
			result
		};
		let (read_result, (), write_result) = tokio::join!(read, dispatch, write);
		read_result?;
		write_result?;
		Ok(())
	}

	/// Binds and serves an owner-only project Unix socket until cancellation.
	///
	/// Retirement unlinks the path immediately and drains accepted
	/// connections; external shutdown aborts them. A stale non-accepting
	/// socket file is replaced; a live listener yields
	/// [`io::ErrorKind::AddrInUse`].
	#[cfg(unix)]
	pub async fn serve_uds(
		self: Arc<Self>,
		path: &Path,
		shutdown: CancellationToken,
		connection_gauge: Option<watch::Sender<usize>>,
	) -> Result<(), EnvdError> {
		self
			.serve_uds_with_policy(path, shutdown, None, connection_gauge, None)
			.await
	}

	/// Binds a Unix socket whose connections are restricted to one extension
	/// host binding.
	#[cfg(unix)]
	pub async fn serve_extension_uds(
		self: Arc<Self>,
		mut binding: ExtensionDataBinding,
		shutdown: CancellationToken,
	) -> Result<(), EnvdError> {
		self
			.authority
			.register_host(binding.key.clone(), binding.grants.clone());
		let policy = binding.policy();
		let listener = binding
			.prepared_listener
			.take()
			.map(UnixListener::from_std)
			.transpose()?;
		let result = self
			.serve_uds_with_policy(&binding.path, shutdown, Some(policy), None, listener)
			.await;
		if let Err(error) = &result {
			tracing::error!(
				path = %binding.path.display(),
				layer = %binding.key.layer(),
				tier = %binding.key.tier(),
				extension = %binding.key.extension(),
				%error,
				"extension DATA socket failed",
			);
		}
		result
	}

	#[cfg(unix)]
	#[tracing::instrument(
		name = "environment_bind",
		level = "debug",
		skip_all,
		fields(path = %path.display(), extension_scoped = connection_policy.is_some())
	)]
	async fn serve_uds_with_policy(
		self: Arc<Self>,
		path: &Path,
		shutdown: CancellationToken,
		connection_policy: Option<ConnectionPolicy>,
		connection_gauge: Option<watch::Sender<usize>>,
		prepared_listener: Option<UnixListener>,
	) -> Result<(), EnvdError> {
		use std::os::unix::fs::{FileTypeExt as _, MetadataExt as _, PermissionsExt as _};

		let parent = path.parent().ok_or_else(|| {
			io::Error::new(io::ErrorKind::InvalidInput, "environment socket has no parent")
		})?;
		ensure_directory(parent)?;
		let (listener, socket_metadata) = if let Some(listener) = prepared_listener {
			let metadata = fs::symlink_metadata(path)?;
			if !metadata.file_type().is_socket() {
				return Err(
					io::Error::new(
						io::ErrorKind::InvalidData,
						"prepared environment path is not a socket",
					)
					.into(),
				);
			}
			(listener, metadata)
		} else {
			match tokio::fs::symlink_metadata(path).await {
				Ok(metadata) if metadata.file_type().is_socket() => {
					if UnixStream::connect(path).await.is_ok() {
						return Err(
							io::Error::new(
								io::ErrorKind::AddrInUse,
								"environment socket is already accepting connections",
							)
							.into(),
						);
					}
					tokio::fs::remove_file(path).await?;
				},
				Ok(_) => {
					return Err(
						io::Error::new(
							io::ErrorKind::AlreadyExists,
							"refusing to replace a non-socket environment path",
						)
						.into(),
					);
				},
				Err(error) if error.kind() == io::ErrorKind::NotFound => {},
				Err(error) => return Err(error.into()),
			}
			// Bind under a staging name, restrict, then publish with an atomic
			// no-replace link. A competing daemon that wins the path race keeps
			// ownership; this listener never overwrites its reachable socket.
			let staging = path.with_extension(format!("staging-{}", process::id()));
			match tokio::fs::symlink_metadata(&staging).await {
				Ok(_) => tokio::fs::remove_file(&staging).await?,
				Err(error) if error.kind() == io::ErrorKind::NotFound => {},
				Err(error) => return Err(error.into()),
			}
			let listener = UnixListener::bind(&staging)?;
			let staging_metadata = fs::symlink_metadata(&staging)?;
			let staging_guard = UnixSocketPathGuard::new(staging.clone(), &staging_metadata);
			tokio::fs::set_permissions(&staging, fs::Permissions::from_mode(0o600)).await?;
			tokio::fs::hard_link(&staging, path).await?;
			drop(staging_guard);
			let metadata = fs::symlink_metadata(path)?;
			(listener, metadata)
		};
		let _socket_path_guard = UnixSocketPathGuard::new(path.to_path_buf(), &socket_metadata);
		let retire = CancellationToken::new();
		let mut listener = Some(listener);
		let mut connections = JoinSet::new();
		let mut abort_connections = false;
		if let Some(gauge) = &connection_gauge {
			gauge.send_replace(0);
		}
		if connection_policy.is_some() {
			tracing::debug!(path = %path.display(), "extension data socket listening");
		} else {
			tracing::info!(path = %path.display(), "environment daemon listening");
		}
		loop {
			if retire.is_cancelled() && listener.is_some() {
				drop(listener.take());
				if let Ok(metadata) = fs::symlink_metadata(path)
					&& metadata.dev() == socket_metadata.dev()
					&& metadata.ino() == socket_metadata.ino()
				{
					let _ = tokio::fs::remove_file(path).await;
				}
				if connections.is_empty() {
					break;
				}
			}
			tokio::select! {
				() = shutdown.cancelled() => {
					abort_connections = true;
					break;
				},
				() = retire.cancelled(), if listener.is_some() => {},
				accepted = async {
					listener.as_ref().expect("guarded listener").accept().await
				}, if listener.is_some() => {
					let (stream, _) = accepted?;
					let server = Arc::clone(&self);
					let policy = connection_policy.clone().unwrap_or_else(|| {
						ConnectionPolicy::external(Some(retire.clone()))
					});
					connections.spawn(async move {
						server.serve_io_with_policy(stream, policy).await
					});
					tracing::debug!(
						path = %path.display(),
						active_connections = connections.len(),
						extension_scoped = connection_policy.is_some(),
						"environment connection accepted",
					);
					if let Some(gauge) = &connection_gauge {
						gauge.send_replace(connections.len());
					}
				},
				completed = connections.join_next(), if !connections.is_empty() => {
					match completed {
						Some(Ok(Ok(()))) | None => {},
						Some(Ok(Err(error))) => {
							tracing::warn!(%error, "environment connection terminated with an error");
						},
						Some(Err(error)) => {
							tracing::error!(%error, "environment connection task failed");
						},
					}
					if let Some(gauge) = &connection_gauge {
						gauge.send_replace(connections.len());
					}
					if listener.is_none() && connections.is_empty() {
						break;
					}
				},
			}
		}
		if listener.take().is_some()
			&& let Ok(metadata) = fs::symlink_metadata(path)
			&& metadata.dev() == socket_metadata.dev()
			&& metadata.ino() == socket_metadata.ino()
		{
			let _ = tokio::fs::remove_file(path).await;
		}
		if abort_connections {
			connections.abort_all();
			while let Some(result) = connections.join_next().await {
				if let Err(error) = result
					&& !error.is_cancelled()
				{
					return Err(error.into());
				}
			}
		}
		Ok(())
	}

	async fn serve_frames(
		&self,
		requests: Receiver<pb::ClientFrame>,
		responses: flume::Sender<pb::ServerFrame>,
		policy: ConnectionPolicy,
	) {
		let first = match time::timeout(HANDSHAKE_TIMEOUT, requests.recv_async()).await {
			Ok(Ok(first)) => first,
			Ok(Err(_)) => return,
			Err(_) => {
				send_error(
					&responses,
					0,
					pb::ProtocolErrorCode::DeadlineExceeded,
					"environment hello handshake timed out",
				)
				.await;
				return;
			},
		};
		let Some(hello) = self.accept_hello(first, &responses, &policy).await else {
			return;
		};
		let (finished_tx, finished) = flume::unbounded();
		let mut connection = ConnectionState::new(
			self.exec.clone(),
			hello,
			&self.tool_settings,
			Arc::clone(&self.authority),
			&policy,
		);
		loop {
			let admission_deadline = connection.next_admission_deadline();
			let next = tokio::select! {
				result = requests.recv_async() => match result {
					Ok(frame) => Some(LoopEvent::Frame(Box::new(frame))),
					Err(_) => None,
				},
				result = finished.recv_async() => match result {
					Ok(done) => Some(LoopEvent::Finished(done)),
					Err(_) => None,
				},
				() = async {
					if let Some(deadline) = admission_deadline {
						time::sleep_until(deadline).await;
					} else {
						future::pending::<()>().await;
					}
				} => Some(LoopEvent::AdmissionDeadline),
			};
			let Some(next) = next else { break };
			match next {
				LoopEvent::Finished(done) => connection.finish(done),
				LoopEvent::AdmissionDeadline => {
					for (request_id, invocation_id, denied) in connection.take_expired_admissions() {
						connection.abandon_admission(request_id, &invocation_id);
						send_policy_denied_verdict(&responses, request_id, &invocation_id, denied).await;
					}
				},
				LoopEvent::Frame(frame) => {
					while let Ok(done) = finished.try_recv() {
						connection.finish(done);
					}
					self
						.dispatch(*frame, &responses, &finished_tx, &mut connection, &policy)
						.await;
				},
			}
		}
		connection.cancel_all(&self.exec);
	}

	async fn accept_hello(
		&self,
		frame: pb::ClientFrame,
		responses: &flume::Sender<pb::ServerFrame>,
		policy: &ConnectionPolicy,
	) -> Option<AcceptedHello> {
		let Some(client_frame::Body::Hello(hello)) = frame.body else {
			tracing::warn!(
				request_id = frame.request_id,
				"environment handshake rejected: first frame was not hello",
			);
			send_error(
				responses,
				frame.request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				"the first client frame must be ClientHello",
			)
			.await;
			return None;
		};
		if frame.request_id != 0 {
			tracing::warn!(
				request_id = frame.request_id,
				"environment handshake rejected: hello used a nonzero request id",
			);
			send_error(
				responses,
				frame.request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				"ClientHello must use request_id 0",
			)
			.await;
			return None;
		}
		if hello.schema_rev < MIN_SCHEMA_REV || hello.schema_rev > omp_proto::SCHEMA_REV {
			tracing::warn!(
				schema_rev = hello.schema_rev,
				min_schema_rev = MIN_SCHEMA_REV,
				max_schema_rev = omp_proto::SCHEMA_REV,
				"environment handshake rejected: unsupported schema revision",
			);
			send_error(
				responses,
				0,
				pb::ProtocolErrorCode::Unsupported,
				&format!(
					"unsupported env schema revision {}; server supports {MIN_SCHEMA_REV}..={}",
					hello.schema_rev,
					omp_proto::SCHEMA_REV
				),
			)
			.await;
			return None;
		}
		let approval_mode = match approval_mode_from_wire(hello.approval_mode) {
			Ok(approval_mode) => approval_mode,
			Err(approval_mode) => {
				tracing::warn!(
					approval_mode = approval_mode,
					"environment handshake rejected: unknown approval mode",
				);
				send_error(
					responses,
					0,
					pb::ProtocolErrorCode::InvalidArgument,
					"ClientHello approval_mode is unknown",
				)
				.await;
				return None;
			},
		};
		let data_capabilities = hello
			.capabilities
			.iter()
			.filter(|capability| capability.as_str() != "edit-repair")
			.cloned()
			.collect::<Vec<_>>();
		let grants = if data_capabilities.is_empty() && policy.host.is_none() {
			policy.grants.clone()
		} else {
			policy.grants.requested(&data_capabilities)
		};
		tracing::debug!(
			schema_rev = hello.schema_rev,
			grants = grants.iter().len(),
			extension_authenticated = policy.host.is_some(),
			authenticated = true,
			"environment handshake accepted",
		);
		responses
			.send_async(server_frame(
				0,
				server_frame::Body::Hello(pb::ServerHello {
					schema_rev:     omp_proto::SCHEMA_REV,
					min_schema_rev: MIN_SCHEMA_REV,
					capabilities:   grants.iter().map(str::to_owned).collect(),
					server_version: self.identity.server_version.to_string(),
					workspace_id:   self.identity.workspace_id.clone(),
					root_uri:       self.identity.root_uri.to_string(),
					server_epoch:   self.identity.server_epoch.clone(),
					server_build:   self.identity.server_build.to_string(),
					props:          Default::default(),
				}),
			))
			.await
			.ok()
			.map(|()| AcceptedHello {
				grants,
				capabilities: hello.capabilities.into_iter().map(Str::from).collect(),
				props: hello.props,
				approval_mode,
			})
	}

	async fn check_workspace_updates(
		&self,
		request: pb::WorkspaceUpdateCheck,
	) -> pb::WorkspaceUpdateReport {
		use omp_ext::{
			Layer,
			config::UpdateMode,
			index::{IndexConfig, SignedIndex},
			lock::{InstalledRecord, LockFile},
			trust::RevocationsFile,
			upgrade::{
				Generation, PinsFile, resolve_candidate_generation, verify_candidate_generation,
			},
		};

		let checked_at_ms = request.now_ms;
		let mode = request.mode.parse::<UpdateMode>();
		if mode == Ok(UpdateMode::Off) {
			return pb::WorkspaceUpdateReport {
				checked: false,
				checked_at_ms,
				..pb::WorkspaceUpdateReport::default()
			};
		}
		if mode.is_err() {
			return workspace_update_failure(
				checked_at_ms,
				"update-policy",
				"workspace update mode is invalid",
			);
		}
		let workspace = self.workspace.root().join(".omp");
		let lock_path = workspace.join("omp.lock");
		if !lock_path.exists() {
			return pb::WorkspaceUpdateReport {
				checked: true,
				checked_at_ms,
				..pb::WorkspaceUpdateReport::default()
			};
		}
		let Some(data_dir) = omp_core::dirs::data_dir(None).ok() else {
			return workspace_update_failure(
				checked_at_ms,
				"storage",
				"client data directory is unavailable",
			);
		};
		let key = match fs::read_to_string(data_dir.join("ext/index.key")) {
			Ok(key) => key,
			Err(_) => {
				return workspace_update_failure(
					checked_at_ms,
					"index-key",
					"signed index key is unavailable",
				);
			},
		};
		let mut index_path = data_dir.join("ext/index.json");
		let mut revocations_path = data_dir.join("ext/revocations.json");
		if let Ok(config) = IndexConfig::read(&data_dir.join("ext/indexes.toml"))
			&& let Some(source) = config.entries.first()
		{
			let metadata_root = self.state_dir.join("ext/update-metadata");
			index_path = metadata_root.join("index.json");
			revocations_path = metadata_root.join("revocations.json");
			let Some((prefix, _)) = source.url.rsplit_once('/') else {
				return workspace_update_failure(
					checked_at_ms,
					"index-url",
					"signed index URL has no metadata directory",
				);
			};
			let revocation_bytes =
				match fetch_extension_metadata(&format!("{prefix}/revocations.json")).await {
					Ok(bytes) => bytes,
					Err(()) => {
						return workspace_update_failure(
							checked_at_ms,
							"network",
							"revocation metadata refresh failed",
						);
					},
				};
			let refreshed_revocations: RevocationsFile =
				match serde_json::from_slice(&revocation_bytes) {
					Ok(value) => value,
					Err(_) => {
						return workspace_update_failure(
							checked_at_ms,
							"revocations",
							"revocation metadata is malformed",
						);
					},
				};
			if let Err(error) = refreshed_revocations.verify(key.trim()) {
				return workspace_update_failure(
					checked_at_ms,
					error.code.to_string(),
					error.detail.as_str(),
				);
			}
			if write_extension_metadata(&revocations_path, &revocation_bytes).is_err() {
				return workspace_update_failure(
					checked_at_ms,
					"storage",
					"revocation metadata could not be persisted",
				);
			}
			let index_bytes = match fetch_extension_metadata(&source.url).await {
				Ok(bytes) => bytes,
				Err(()) => {
					return workspace_update_failure(
						checked_at_ms,
						"network",
						"signed index refresh failed",
					);
				},
			};
			let refreshed_index: SignedIndex = match serde_json::from_slice(&index_bytes) {
				Ok(value) => value,
				Err(_) => {
					return workspace_update_failure(
						checked_at_ms,
						"index",
						"signed index metadata is malformed",
					);
				},
			};
			if let Err(error) = refreshed_index.verify(key.trim()) {
				return workspace_update_failure(
					checked_at_ms,
					error.code.to_string(),
					error.detail.as_str(),
				);
			}
			if write_extension_metadata(&index_path, &index_bytes).is_err() {
				return workspace_update_failure(
					checked_at_ms,
					"storage",
					"signed index could not be persisted",
				);
			}
		}
		let index = match SignedIndex::read(&index_path, key.trim()) {
			Ok(index) => index,
			Err(error) => {
				return workspace_update_failure(
					checked_at_ms,
					error.code.to_string(),
					error.detail.as_str(),
				);
			},
		};
		let revocations = match RevocationsFile::read(&revocations_path).and_then(|value| {
			value.verify(key.trim())?;
			Ok(value)
		}) {
			Ok(revocations) => revocations,
			Err(error) => {
				return workspace_update_failure(
					checked_at_ms,
					error.code.to_string(),
					error.detail.as_str(),
				);
			},
		};
		let current = match LockFile::read(&lock_path, Layer::Workspace).and_then(|lock| {
			Ok(Generation {
				lock,
				installed: InstalledRecord::read(&workspace.join("installed.toml"))?,
			})
		}) {
			Ok(current) => current,
			Err(error) => {
				return workspace_update_failure(
					checked_at_ms,
					error.code.to_string(),
					error.detail.as_str(),
				);
			},
		};
		let target = current
			.lock
			.targets
			.first()
			.map_or("any", omp_core::Str::as_str);
		let candidate = match resolve_candidate_generation(&current, &index, target) {
			Ok(candidate) => candidate,
			Err(error) => {
				return workspace_update_failure(
					checked_at_ms,
					error.code.to_string(),
					error.detail.as_str(),
				);
			},
		};
		let pins = match PinsFile::read(&data_dir.join("ext/pins.toml")) {
			Ok(pins) => pins,
			Err(error) => {
				return workspace_update_failure(
					checked_at_ms,
					error.code.to_string(),
					error.detail.as_str(),
				);
			},
		};
		let now = jiff::Timestamp::now().to_string();
		let freshness = revocations.freshness(&now, false);
		let report = match verify_candidate_generation(
			&current,
			&candidate,
			&index,
			&pins,
			&revocations,
			freshness,
			target,
		) {
			Ok(report) => report,
			Err(error) => {
				return workspace_update_failure(
					checked_at_ms,
					error.code.to_string(),
					error.detail.as_str(),
				);
			},
		};
		if !report.quarantined.is_empty() {
			let quarantine_root = self.state_dir.join("ext");
			let _ = fs::create_dir_all(&quarantine_root);
			let _ = fs::write(
				quarantine_root.join("quarantine.json"),
				serde_json::to_vec_pretty(&report).unwrap_or_default(),
			);
			self.ext_hosts.quarantine(&report.quarantined).await;
		}
		pb::WorkspaceUpdateReport {
			checked: true,
			items: report
				.items
				.into_iter()
				.map(|item| {
					let refusal = item.refusal.map(update_refusal_wire);
					pb::ExtensionUpdateItem {
						id:           item.diff.id.to_string(),
						from_version: item.diff.from_version.to_string(),
						to_version:   item.diff.to_version.to_string(),
						features:     item.diff.features.into_iter().map(String::from).collect(),
						diff:         Some(pb::ExtensionUpdateDiff {
							declaration_digest_from: item.diff.from_declaration_digest.to_string(),
							declaration_digest_to:   item.diff.to_declaration_digest.to_string(),
							capability_digest_from:  item.diff.from_capability_digest.to_string(),
							capability_digest_to:    item.diff.to_capability_digest.to_string(),
							manifest_digest_from:    item.diff.from_manifest_capability_digest.to_string(),
							manifest_digest_to:      item.diff.to_manifest_capability_digest.to_string(),
						}),
						refusal:      refusal.map(|value| value as i32),
					}
				})
				.collect(),
			quarantined: report
				.quarantined
				.into_iter()
				.map(|id| pb::ExtensionUpdateQuarantine {
					id:      id.to_string(),
					refusal: pb::ExtensionUpdateRefusal::Revoked as i32,
					detail:  "startup generation is newly revoked".to_owned(),
				})
				.collect(),
			failure: None,
			checked_at_ms,
		}
	}

	async fn dispatch(
		&self,
		frame: pb::ClientFrame,
		responses: &flume::Sender<pb::ServerFrame>,
		finished: &flume::Sender<Finished>,
		connection: &mut ConnectionState,
		policy: &ConnectionPolicy,
	) {
		let scope = frame.scope.clone();
		let Some(body) = frame.body else {
			send_error(
				responses,
				frame.request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				"client frame body is missing",
			)
			.await;
			return;
		};
		if self.environment_authorities().is_none() && requires_environment_host(&body) {
			send_error(
				responses,
				frame.request_id,
				pb::ProtocolErrorCode::Unsupported,
				"environment authority frame reached a session-only host",
			)
			.await;
			return;
		}
		let worker_scope = connection.host.as_ref().is_some_and(|host| {
			scope.as_ref().is_some_and(|scope| {
				connection
					.authority
					.is_worker_invocation(host, &scope.invocation_id)
			})
		});
		if matches!(&body, client_frame::Body::InvokeTool(_))
			&& (!connection.grants.contains("invocation") || worker_scope)
		{
			send_error(
				responses,
				frame.request_id,
				pb::ProtocolErrorCode::PermissionDenied,
				"connection was not granted invocation dispatch",
			)
			.await;
			return;
		}
		if let client_frame::Body::AcpBind(binding) = body {
			if frame.request_id != 0 {
				send_error(
					responses,
					frame.request_id,
					pb::ProtocolErrorCode::InvalidArgument,
					"ACP bind control frames must use request_id 0",
				)
				.await;
			} else {
				connection.bind_acp(binding);
			}
			return;
		}
		if let client_frame::Body::Cancel(cancel) = body {
			if frame.request_id != 0 {
				send_error(
					responses,
					frame.request_id,
					pb::ProtocolErrorCode::InvalidArgument,
					"cancel control frames must use request_id 0",
				)
				.await;
				return;
			}
			connection
				.cancel(cancel, &self.exec, responses, finished)
				.await;
			return;
		}
		if frame.request_id == 0 {
			send_error(
				responses,
				0,
				pb::ProtocolErrorCode::InvalidArgument,
				"ordinary frames must use a nonzero request_id",
			)
			.await;
			return;
		}
		if let Some((operation, capability)) = frame_data_operation(&body)
			&& !authorize_data_operation(
				connection,
				scope.as_ref(),
				operation,
				capability,
				responses,
				frame.request_id,
			)
			.await
		{
			return;
		}
		if scope.as_ref().is_some_and(|scope| scope.pty_denied) && requests_pty(&body) {
			send_error(
				responses,
				frame.request_id,
				pb::ProtocolErrorCode::PermissionDenied,
				"PTY allocation is denied by the authenticated invocation scope",
			)
			.await;
			return;
		}
		let continuation = matches!(
			&body,
			client_frame::Body::ArgText(_)
				| client_frame::Body::Admission(_)
				| client_frame::Body::EditRepairAnswer(_)
				| client_frame::Body::AcpDocumentAnswer(_)
				| client_frame::Body::AcpExecEvent(_)
				| client_frame::Body::ArgsCommitted(_)
				| client_frame::Body::Interrupt(_)
				| client_frame::Body::Stdin(_)
				| client_frame::Body::Signal(_)
				| client_frame::Body::Resize(_)
				| client_frame::Body::BlobPutChunk(_)
				| client_frame::Body::BlobPutCommit(_)
		);
		if !continuation && connection.requests.contains_key(&frame.request_id) {
			send_error(
				responses,
				frame.request_id,
				pb::ProtocolErrorCode::AlreadyExists,
				"request_id is already open",
			)
			.await;
			return;
		}

		match body {
			client_frame::Body::Hello(_) => {
				send_error(
					responses,
					frame.request_id,
					pb::ProtocolErrorCode::AlreadyExists,
					"the connection hello is already complete",
				)
				.await;
			},
			client_frame::Body::AcpBind(_) => {
				unreachable!("ACP binding handled before ordinary dispatch")
			},
			client_frame::Body::Retire(_) => {
				if policy.retire.is_some() {
					send_body(
						responses,
						frame.request_id,
						server_frame::Body::RetireStarted(pb::RetireStarted::default()),
					)
					.await;
				} else {
					send_error(
						responses,
						frame.request_id,
						pb::ProtocolErrorCode::Unsupported,
						"retire is not available on this transport",
					)
					.await;
				}
			},
			client_frame::Body::EvalReset(_) => {
				self.eval_control.request_reset();
				send_body(
					responses,
					frame.request_id,
					server_frame::Body::EvalReset(pb::EvalResetResponse::default()),
				)
				.await;
			},
			client_frame::Body::Shutdown(request) => {
				let accepted_at_ms = SystemTime::now()
					.duration_since(UNIX_EPOCH)
					.unwrap_or_default()
					.as_millis()
					.try_into()
					.unwrap_or(u64::MAX);
				let grace = Duration::from_millis(request.grace_ms);
				let summary = self.exec.shutdown_managed(grace).await;
				let acknowledgement = ShutdownAcknowledgement {
					accepted_at_ms,
					stopped: summary.stopped,
					spared: summary.spared,
				};
				if self
					.environment
					.as_ref()
					.expect("environment frames are guarded on session-only hosts")
					.process_store
					.record_shutdown(acknowledgement)
					.is_err()
				{
					send_error(
						responses,
						frame.request_id,
						pb::ProtocolErrorCode::Internal,
						"failed to durably record process shutdown acknowledgement",
					)
					.await;
				} else {
					send_body(
						responses,
						frame.request_id,
						server_frame::Body::ShutdownAcknowledged(pb::ShutdownAcknowledged {
							accepted_at_ms,
							props: None,
						}),
					)
					.await;
				}
			},
			client_frame::Body::WorkspaceUpdateCheck(request) => {
				let report = self.check_workspace_updates(request).await;
				send_body(
					responses,
					frame.request_id,
					server_frame::Body::WorkspaceUpdateReport(report),
				)
				.await;
			},
			client_frame::Body::RegisterPresence(request) => {
				if policy.host.is_some() {
					send_error(
						responses,
						frame.request_id,
						pb::ProtocolErrorCode::PermissionDenied,
						"presence registration is unavailable on extension transports",
					)
					.await;
					return;
				}
				if connection.presence.is_some() {
					send_error(
						responses,
						frame.request_id,
						pb::ProtocolErrorCode::AlreadyExists,
						"this connection already owns a presence lease",
					)
					.await;
					return;
				}
				let Ok(client_id) = str::from_utf8(&request.client_id) else {
					send_error(
						responses,
						frame.request_id,
						pb::ProtocolErrorCode::InvalidArgument,
						"presence client_id must be UTF-8",
					)
					.await;
					return;
				};
				if client_id.is_empty() || client_id.len() > 256 {
					send_error(
						responses,
						frame.request_id,
						pb::ProtocolErrorCode::InvalidArgument,
						"presence client_id must contain 1..=256 bytes",
					)
					.await;
					return;
				}
				if request.kind.is_empty() || request.kind.len() > 64 {
					send_error(
						responses,
						frame.request_id,
						pb::ProtocolErrorCode::InvalidArgument,
						"presence kind must contain 1..=64 bytes",
					)
					.await;
					return;
				}
				match self
					.presence
					.register(Str::from(client_id), request.pid, Str::from(request.kind))
				{
					Ok(lease) => {
						let lease_id = Bytes::copy_from_slice(lease.id().as_bytes());
						connection.presence = Some(lease);
						send_body(
							responses,
							frame.request_id,
							server_frame::Body::PresenceRegistered(pb::PresenceRegistered {
								lease_id,
								props: None,
							}),
						)
						.await;
					},
					Err(PresenceError::ClientNotLive { .. }) => {
						send_error(
							responses,
							frame.request_id,
							pb::ProtocolErrorCode::InvalidArgument,
							"presence pid is not a live process",
						)
						.await;
					},
					Err(error) => {
						tracing::warn!(%error, "failed to register client presence");
						send_error(
							responses,
							frame.request_id,
							pb::ProtocolErrorCode::Internal,
							"failed to persist client presence",
						)
						.await;
					},
				}
			},
			client_frame::Body::ReleasePresence(request) => {
				let Some(lease) = connection.presence.as_ref() else {
					send_error(
						responses,
						frame.request_id,
						pb::ProtocolErrorCode::NotFound,
						"this connection has no presence lease",
					)
					.await;
					return;
				};
				if request.lease_id.as_ref() != lease.id().as_bytes() {
					send_error(
						responses,
						frame.request_id,
						pb::ProtocolErrorCode::PermissionDenied,
						"presence lease does not belong to this connection",
					)
					.await;
					return;
				}
				let lease = connection
					.presence
					.take()
					.expect("presence lease checked immediately above");
				match lease.release() {
					Ok(()) => {
						send_body(
							responses,
							frame.request_id,
							server_frame::Body::PresenceReleased(pb::PresenceReleased {
								lease_id: request.lease_id,
								props:    None,
							}),
						)
						.await;
					},
					Err(error) => {
						tracing::warn!(%error, "failed to release client presence");
						send_error(
							responses,
							frame.request_id,
							pb::ProtocolErrorCode::Internal,
							"failed to remove client presence",
						)
						.await;
					},
				}
			},
			client_frame::Body::InvokeTool(request) => {
				self
					.open_invocation(
						frame.request_id,
						request,
						scope.as_ref(),
						responses,
						finished,
						connection,
					)
					.await;
			},
			client_frame::Body::ArgText(request) => {
				let result = connection.invocation_mut(frame.request_id, &request.invocation_id);
				let query = match result {
					Ok(InvocationState::Native { feed, lifecycle, admission, .. })
						if !lifecycle.is_committed() && !lifecycle.is_terminal() =>
					{
						let query = admission.push_fragment(
							&request.fragment,
							self.workspace.root(),
							self.workspace.root(),
						);
						if !admission.requires_external_answer()
							&& feed.arg_text(Str::from(request.fragment)).is_err()
						{
							send_error(
								responses,
								frame.request_id,
								pb::ProtocolErrorCode::Cancelled,
								"invocation input is closed",
							)
							.await;
							None
						} else {
							query
						}
					},
					Ok(InvocationState::Worker {
						invocation: Some(invocation),
						committed,
						admission,
						..
					}) if !*committed => {
						let query = admission.push_fragment(
							&request.fragment,
							self.workspace.root(),
							self.workspace.root(),
						);
						if invocation.streams_args()
							&& !admission.requires_external_answer()
							&& let Err(error) = invocation.arg_text(request)
						{
							send_error(
								responses,
								frame.request_id,
								pb::ProtocolErrorCode::PreconditionFailed,
								&error.to_string(),
							)
							.await;
							None
						} else {
							query
						}
					},
					Ok(_) => {
						send_error(
							responses,
							frame.request_id,
							pb::ProtocolErrorCode::PreconditionFailed,
							"ArgText cannot follow ArgsCommitted",
						)
						.await;
						None
					},
					Err((code, message)) => {
						send_error(responses, frame.request_id, code, message).await;
						None
					},
				};
				if let Some(query) = query {
					send_body(responses, frame.request_id, server_frame::Body::AdmitInvocation(query))
						.await;
				}
			},
			client_frame::Body::Admission(admission) => {
				let result = connection.invocation_mut(frame.request_id, &admission.invocation_id);
				let pending = match result {
					Ok(
						InvocationState::Native { admission: gate, pending_commit, .. }
						| InvocationState::Worker { admission: gate, pending_commit, .. },
					) => {
						if let Err(error) = gate.answer(admission) {
							send_error(
								responses,
								frame.request_id,
								pb::ProtocolErrorCode::PreconditionFailed,
								&error.to_string(),
							)
							.await;
							None
						} else {
							pending_commit.take()
						}
					},
					Err((code, message)) => {
						send_error(responses, frame.request_id, code, message).await;
						None
					},
				};
				if let Some(request) = pending {
					self
						.commit_invocation(frame.request_id, request, responses, finished, connection)
						.await;
				}
			},
			client_frame::Body::EditRepairAnswer(answer) => {
				if let Err((code, message)) = connection.answer_edit_repair(frame.request_id, answer) {
					send_error(responses, frame.request_id, code, message).await;
				}
			},
			client_frame::Body::AcpDocumentAnswer(answer) => {
				if let Err((code, message)) = connection.answer_acp_document(frame.request_id, answer) {
					send_error(responses, frame.request_id, code, message).await;
				}
			},
			client_frame::Body::AcpExecEvent(event) => {
				if let Err((code, message)) = connection.answer_acp_exec(frame.request_id, event) {
					send_error(responses, frame.request_id, code, message).await;
				}
			},
			client_frame::Body::ArgsCommitted(request) => {
				match connection.scope_authenticates(
					frame.request_id,
					&request.invocation_id,
					&request.effect_token,
					scope.as_ref(),
				) {
					Ok(true) => {},
					Ok(false) => {
						send_error(
							responses,
							frame.request_id,
							pb::ProtocolErrorCode::PermissionDenied,
							"invocation scope is not authenticated by the committed effect token",
						)
						.await;
						return;
					},
					Err((code, message)) => {
						send_error(responses, frame.request_id, code, message).await;
						return;
					},
				}
				let denial =
					match connection.plan_denial(frame.request_id, &request.invocation_id, &request.raw)
					{
						Ok(denial) => denial,
						Err((code, message)) => {
							send_error(responses, frame.request_id, code, message).await;
							return;
						},
					};
				if let Some(denial) = denial {
					let invocation_id = Str::from(request.invocation_id.as_str());
					send_invocation_error(
						responses,
						frame.request_id,
						pb::ProtocolErrorCode::PermissionDenied,
						&denial,
					)
					.await;
					connection.abandon_admission(frame.request_id, &invocation_id);
					return;
				}
				let query = match connection.invocation_mut(frame.request_id, &request.invocation_id) {
					Ok(
						InvocationState::Native { admission, .. }
						| InvocationState::Worker { admission, .. },
					) => {
						match admission.finalize(
							&request.raw,
							self.workspace.root(),
							self.workspace.root(),
						) {
							Ok(query) => query,
							Err(error) => {
								send_error(
									responses,
									frame.request_id,
									pb::ProtocolErrorCode::InvalidArgument,
									&error.to_string(),
								)
								.await;
								return;
							},
						}
					},
					Err((code, message)) => {
						send_error(responses, frame.request_id, code, message).await;
						return;
					},
				};
				if let Some(query) = query {
					send_body(responses, frame.request_id, server_frame::Body::AdmitInvocation(query))
						.await;
				}
				self
					.commit_invocation(frame.request_id, request, responses, finished, connection)
					.await;
			},
			client_frame::Body::Interrupt(request) => {
				connection
					.interrupt(frame.request_id, request, responses, finished)
					.await;
			},
			client_frame::Body::OpenSession(request) => {
				if reject_duplicate_open(connection, frame.request_id, responses).await {
					return;
				}
				if let Err(error) = connection.quotas.reserve_exec() {
					send_policy_error(responses, frame.request_id, error).await;
					return;
				}
				match self.exec.open_session(request).await {
					Ok(response) => {
						send_body(
							responses,
							frame.request_id,
							server_frame::Body::SessionOpened(response),
						)
						.await;
					},
					Err(error) => {
						connection.quotas.release_exec();
						send_exec_error(responses, frame.request_id, &error).await;
					},
				}
			},
			client_frame::Body::CloseSession(request) => {
				match self.exec.close_session(&request.session) {
					Ok(response) => {
						connection.quotas.release_exec();
						send_body(
							responses,
							frame.request_id,
							server_frame::Body::SessionClosed(response),
						)
						.await;
					},
					Err(error) => send_exec_error(responses, frame.request_id, &error).await,
				}
			},
			client_frame::Body::Exec(request) => {
				if reject_duplicate_open(connection, frame.request_id, responses).await {
					return;
				}
				if let Err(error) = connection.quotas.reserve_exec() {
					send_policy_error(responses, frame.request_id, error).await;
					return;
				}
				match self.exec.exec(request, None).await {
					Ok((started, run)) => {
						let exec = Bytes::copy_from_slice(run.id());
						let cancel = CancellationToken::new();
						connection
							.requests
							.insert(frame.request_id, RequestState::Exec {
								exec:   exec.clone(),
								cancel: cancel.clone(),
							});
						send_body(responses, frame.request_id, server_frame::Body::ExecStarted(started))
							.await;
						spawn_exec(frame.request_id, run, cancel, responses.clone(), finished.clone());
					},
					Err(error) => {
						connection.quotas.release_exec();
						send_exec_error(responses, frame.request_id, &error).await;
					},
				}
			},
			client_frame::Body::Stdin(request) => {
				if let Some(exec) = connection
					.exec_id(frame.request_id, &request.exec, responses)
					.await
				{
					let data = match request.input {
						Some(stdin_frame::Input::Data(data)) => Some(data),
						Some(stdin_frame::Input::Eof(true)) => None,
						_ => {
							send_error(
								responses,
								frame.request_id,
								pb::ProtocolErrorCode::InvalidArgument,
								"stdin frame has no data or eof marker",
							)
							.await;
							return;
						},
					};
					if let Err(error) = self.exec.stdin(&exec, data.as_deref()) {
						send_exec_error(responses, frame.request_id, &error).await;
					}
				}
			},
			client_frame::Body::Signal(request) => {
				if let Some(exec) = connection
					.exec_id(frame.request_id, &request.exec, responses)
					.await && let Err(error) = self.exec.signal(&exec, &request.signal)
				{
					send_exec_error(responses, frame.request_id, &error).await;
				}
			},
			client_frame::Body::Resize(request) => {
				if let Some(exec) = connection
					.exec_id(frame.request_id, &request.exec, responses)
					.await && let Err(error) = self.exec.resize(&exec, request.rows, request.columns)
				{
					send_exec_error(responses, frame.request_id, &error).await;
				}
			},
			client_frame::Body::StartProcess(request) => {
				if let Err(error) = connection.quotas.charge_process_start() {
					send_policy_error(responses, frame.request_id, error).await;
					return;
				}
				match self.exec.start_process(request).await {
					Ok(response) => {
						send_body(
							responses,
							frame.request_id,
							server_frame::Body::ProcessStarted(response),
						)
						.await;
					},
					Err(error) => send_exec_error(responses, frame.request_id, &error).await,
				}
			},
			client_frame::Body::GetProcess(request) => match self.exec.get_process(&request) {
				Ok(response) => {
					send_body(responses, frame.request_id, server_frame::Body::ProcessInfo(response))
						.await;
				},
				Err(error) => send_exec_error(responses, frame.request_id, &error).await,
			},
			client_frame::Body::RestartProcess(request) => {
				if let Err(error) = connection.quotas.charge_process_start() {
					send_policy_error(responses, frame.request_id, error).await;
					return;
				}
				match self.exec.restart_process(request).await {
					Ok(response) => {
						send_body(
							responses,
							frame.request_id,
							server_frame::Body::ProcessRestarted(response),
						)
						.await;
					},
					Err(error) => send_exec_error(responses, frame.request_id, &error).await,
				}
			},
			client_frame::Body::HttpRequest(request) => {
				match self.http_egress.request(request).await {
					Ok(response) => {
						send_body(
							responses,
							frame.request_id,
							server_frame::Body::HttpResponse(response),
						)
						.await;
					},
					Err(error) => send_http_error(responses, frame.request_id, &error).await,
				}
			},
			client_frame::Body::ListProcesses(_) => {
				send_body(
					responses,
					frame.request_id,
					server_frame::Body::ProcessList(self.exec.list_processes()),
				)
				.await;
			},
			client_frame::Body::AttachOutput(request) => {
				if reject_duplicate_open(connection, frame.request_id, responses).await {
					return;
				}
				if let Err(error) = connection.quotas.reserve_stream() {
					send_policy_error(responses, frame.request_id, error).await;
					return;
				}
				match self.exec.attach_output(&request) {
					Ok(attachment) => {
						let cancel = CancellationToken::new();
						let process_name = Str::from(request.name);
						connection
							.requests
							.insert(frame.request_id, RequestState::ProcessAttach {
								cancel: cancel.clone(),
							});
						send_body(
							responses,
							frame.request_id,
							server_frame::Body::OutputAttached(attachment.attached),
						)
						.await;
						for output in attachment.backlog {
							send_body(
								responses,
								frame.request_id,
								server_frame::Body::ProcessOutput(output),
							)
							.await;
						}
						send_body(
							responses,
							frame.request_id,
							server_frame::Body::ProcessState(pb::ProcessStateEvent {
								process: Some(attachment.state),
								props:   Default::default(),
							}),
						)
						.await;
						spawn_process_attachment(
							frame.request_id,
							process_name,
							attachment.events,
							cancel,
							responses.clone(),
							finished.clone(),
						);
					},
					Err(error) => {
						connection.quotas.release_stream();
						send_exec_error(responses, frame.request_id, &error).await;
					},
				}
			},
			client_frame::Body::SendInput(request) => {
				let data = match request.input {
					Some(send_input::Input::Data(data)) => Some(data),
					Some(send_input::Input::Eof(true)) => None,
					_ => {
						send_error(
							responses,
							frame.request_id,
							pb::ProtocolErrorCode::InvalidArgument,
							"process input has no data or eof marker",
						)
						.await;
						return;
					},
				};
				match self
					.exec
					.send_process_input(&request.name, request.generation, data.as_deref())
				{
					Ok(response) => {
						send_body(
							responses,
							frame.request_id,
							server_frame::Body::ProcessCommandAccepted(response),
						)
						.await;
					},
					Err(error) => send_exec_error(responses, frame.request_id, &error).await,
				}
			},
			client_frame::Body::SignalProcess(request) => {
				match self
					.exec
					.signal_process(&request.name, request.generation, &request.signal)
				{
					Ok(response) => {
						send_body(
							responses,
							frame.request_id,
							server_frame::Body::ProcessCommandAccepted(response),
						)
						.await;
					},
					Err(error) => send_exec_error(responses, frame.request_id, &error).await,
				}
			},
			client_frame::Body::StopProcess(request) => {
				match self.exec.stop_process(
					&request.name,
					request.generation,
					Duration::from_millis(request.grace_ms),
				) {
					Ok(response) => {
						send_body(
							responses,
							frame.request_id,
							server_frame::Body::ProcessCommandAccepted(response),
						)
						.await;
					},
					Err(error) => send_exec_error(responses, frame.request_id, &error).await,
				}
			},
			client_frame::Body::BlobStat(request) => match self.blobs.stat(&request.hash) {
				Ok(response) => {
					send_body(responses, frame.request_id, server_frame::Body::BlobStat(response)).await;
				},
				Err(error) => send_blob_error(responses, frame.request_id, &error).await,
			},
			client_frame::Body::Data(request) => {
				self
					.dispatch_data(
						frame.request_id,
						request,
						scope.as_ref(),
						responses,
						finished,
						connection,
					)
					.await;
			},
			client_frame::Body::BlobGet(request) => {
				if reject_duplicate_open(connection, frame.request_id, responses).await {
					return;
				}
				let delivery = scope.as_ref().and_then(verdict_delivery_provenance);
				if let Err(error) = connection.quotas.reserve_stream() {
					send_policy_error(responses, frame.request_id, error).await;
					return;
				}
				match self.blobs.get_request(&request) {
					Ok(read) => {
						if let Some(delivery) = delivery.as_ref()
							&& let Err(error) = self.blobs.renew_verdict_delivery(
								Some(delivery.session_id.as_str()),
								delivery.invocation_id.as_str(),
								read.id(),
							) {
							connection.quotas.release_stream();
							send_blob_error(responses, frame.request_id, &error).await;
							return;
						}
						let cancel = CancellationToken::new();
						connection
							.requests
							.insert(frame.request_id, RequestState::BlobGet { cancel: cancel.clone() });
						spawn_blob_get(
							frame.request_id,
							read,
							delivery,
							cancel,
							responses.clone(),
							finished.clone(),
							self.blobs.clone(),
						);
					},
					Err(error) => {
						connection.quotas.release_stream();
						send_blob_error(responses, frame.request_id, &error).await;
					},
				}
			},
			client_frame::Body::BlobPutChunk(chunk) => {
				self
					.put_chunk(frame.request_id, chunk, responses, connection)
					.await;
			},
			client_frame::Body::BlobPutCommit(_) => {
				self
					.commit_blob(frame.request_id, responses, connection)
					.await;
			},
			client_frame::Body::BlobDelete(request) => match self.blobs.delete(&request.hash) {
				Ok(response) => {
					send_body(responses, frame.request_id, server_frame::Body::BlobDeleted(response))
						.await;
				},
				Err(error) => send_blob_error(responses, frame.request_id, &error).await,
			},
			client_frame::Body::Cancel(_) => unreachable!("cancel handled before ordinary dispatch"),
		}
	}

	async fn dispatch_data(
		&self,
		request_id: u64,
		request: pb::DataRequest,
		scope: Option<&pb::InvocationScope>,
		responses: &flume::Sender<pb::ServerFrame>,
		finished: &flume::Sender<Finished>,
		connection: &mut ConnectionState,
	) {
		use data_request::Body;

		let environment_only = matches!(
			request.body.as_ref(),
			Some(
				Body::Document(_)
					| Body::Walk(_)
					| Body::Search(_)
					| Body::Workspace(_)
					| Body::Worktree(_)
					| Body::HostInfo(_)
					| Body::WorkspaceRoots(_)
					| Body::RepositorySnapshot(_)
					| Body::ExecSession(_)
					| Body::PrivilegedMutation(_)
					| Body::DapLaunch(_)
					| Body::DapAttach(_)
					| Body::DapAction(_)
					| Body::DetachExec(_)
			)
		);
		if environment_only && self.environment_authorities().is_none() {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::Unsupported,
				"environment data authority is unavailable on a session-only host",
			)
			.await;
			return;
		}

		match request.body {
			Some(Body::Worker(request)) => {
				if !authorize_data_operation(
					connection,
					scope,
					worker_operation(&request),
					"env.worker",
					responses,
					request_id,
				)
				.await
				{
					return;
				}
				self.dispatch_worker(request_id, request, responses).await;
			},
			Some(Body::Document(request)) => {
				self
					.dispatch_document(request_id, request, scope, responses, finished, connection)
					.await;
			},
			Some(Body::Walk(request)) => {
				if !authorize_data_operation(
					connection,
					scope,
					"omp.env.find.walk",
					"env.search",
					responses,
					request_id,
				)
				.await
				{
					return;
				}
				let walk = match workspace_walk_request(&self.workspace, &request) {
					Ok(walk) => walk,
					Err((code, message)) => {
						send_error(responses, request_id, code, &message).await;
						return;
					},
				};
				if let Err(error) = connection.quotas.reserve_stream() {
					send_policy_error(responses, request_id, error).await;
					return;
				}
				let cancel = CancellationToken::new();
				connection
					.requests
					.insert(request_id, RequestState::DataStream { cancel: cancel.clone() });
				spawn_workspace_walk(
					request_id,
					self.workspace.clone(),
					walk,
					cancel,
					responses.clone(),
					finished.clone(),
				);
			},
			Some(Body::Search(request)) => {
				if !authorize_data_operation(
					connection,
					scope,
					"omp.env.find.search",
					"env.search",
					responses,
					request_id,
				)
				.await
				{
					return;
				}
				let Some(wire_walk) = request.walk.as_ref() else {
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::InvalidArgument,
						"search walk request is missing",
					)
					.await;
					return;
				};
				let walk = match workspace_walk_request(&self.workspace, wire_walk) {
					Ok(walk) => walk,
					Err((code, message)) => {
						send_error(responses, request_id, code, &message).await;
						return;
					},
				};
				let pattern = match str::from_utf8(&request.pattern) {
					Ok(pattern) if !pattern.is_empty() => Str::from(pattern),
					_ => {
						send_error(
							responses,
							request_id,
							pb::ProtocolErrorCode::InvalidArgument,
							"search pattern must be nonempty UTF-8",
						)
						.await;
						return;
					},
				};
				let options = WorkspaceSearchOwned {
					pattern,
					case: if request.case_sensitive {
						WorkspaceSearchCase::Sensitive
					} else {
						WorkspaceSearchCase::Insensitive
					},
					limit: request.limit,
				};
				if let Err(error) = connection.quotas.reserve_stream() {
					send_policy_error(responses, request_id, error).await;
					return;
				}
				let cancel = CancellationToken::new();
				connection
					.requests
					.insert(request_id, RequestState::DataStream { cancel: cancel.clone() });
				spawn_workspace_search(
					request_id,
					self.workspace.clone(),
					walk,
					options,
					cancel,
					responses.clone(),
					finished.clone(),
				);
			},
			Some(Body::Workspace(request)) => {
				self
					.dispatch_workspace(request_id, request, scope, responses, connection)
					.await;
			},
			Some(Body::Worktree(request)) => {
				self
					.dispatch_worktree(request_id, request, scope, responses, connection)
					.await;
			},
			Some(Body::HostInfo(request)) => {
				if request.wire_revision != omp_proto::SCHEMA_REV {
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::InvalidArgument,
						"host-info wire revision does not match the Environment schema",
					)
					.await;
					return;
				}
				let info = self.host_info.snapshot(request.max_field_bytes).await;
				send_data_response(responses, request_id, data_response::Body::HostInfo(info)).await;
			},
			Some(Body::WorkspaceRoots(request)) => {
				if request.wire_revision != omp_proto::SCHEMA_REV {
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::InvalidArgument,
						"workspace-root wire revision does not match the Environment schema",
					)
					.await;
					return;
				}
				send_data_response(
					responses,
					request_id,
					data_response::Body::WorkspaceRoots(self.workspace_roots.snapshot()),
				)
				.await;
			},
			Some(Body::Mcp(request)) => {
				if !authorize_data_operation(
					connection,
					scope,
					mcp_operation(&request),
					"env.mcp",
					responses,
					request_id,
				)
				.await
				{
					return;
				}
				self
					.dispatch_mcp(request_id, request, responses, finished, connection)
					.await;
			},
			Some(Body::RepositorySnapshot(request)) => {
				if !authorize_data_operation(
					connection,
					scope,
					"omp.env.find.walk",
					"env.search",
					responses,
					request_id,
				)
				.await
				{
					return;
				}
				self
					.dispatch_repository_snapshot(request_id, request, responses)
					.await;
			},
			Some(Body::ExecSession(request)) => {
				let operation = match request.op.as_ref() {
					Some(exec_session_op::Op::Materialize(_)) => "omp.env.sh.exec",
					Some(exec_session_op::Op::ReleaseMaterialization(_)) => "omp.env.sh.close_session",
					Some(exec_session_op::Op::Control(_) | exec_session_op::Op::Signal(_)) => {
						"omp.env.sh.signal"
					},
					Some(exec_session_op::Op::Stdin(_)) => "omp.env.sh.stdin",
					Some(exec_session_op::Op::Resize(_)) => "omp.env.sh.resize",
					Some(exec_session_op::Op::Capabilities(_))
					| Some(exec_session_op::Op::FinalCwd(_)) => "omp.env.sh.open_session",
					None => {
						send_error(
							responses,
							request_id,
							pb::ProtocolErrorCode::InvalidArgument,
							"exec-session operation is missing",
						)
						.await;
						return;
					},
				};
				if !authorize_data_operation(
					connection, scope, operation, "env.exec", responses, request_id,
				)
				.await
				{
					return;
				}
				self
					.dispatch_exec_session(request_id, request, responses)
					.await;
			},
			Some(Body::PrivilegedMutation(request)) => {
				if !authorize_data_operation(
					connection,
					scope,
					"omp.env.fs.privileged_mutation",
					"env.fs.write",
					responses,
					request_id,
				)
				.await
				{
					return;
				}
				self
					.dispatch_privileged_mutation(request_id, request, scope, responses)
					.await;
			},
			Some(request @ (Body::DapLaunch(_) | Body::DapAttach(_) | Body::DapAction(_))) => {
				self
					.dispatch_dap(request_id, request, scope, responses, finished, connection)
					.await;
			},
			Some(Body::Site(request)) => {
				if !authorize_data_operation(
					connection,
					scope,
					"omp.env.site.materialize",
					"env.site",
					responses,
					request_id,
				)
				.await
				{
					return;
				}
				if connection.host.is_some() {
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::PermissionDenied,
						"site trees and their store are installer-owned and read-only to extensions",
					)
					.await;
					return;
				}
				let module_paths = record_modules(&request.files);
				match self.sites.materialize(request) {
					Ok(materialized) => {
						for module in module_paths {
							if let Err(error) = self.require_record_owner(
								&materialized.site_key,
								module,
								&materialized.site_key,
							) {
								send_error(
									responses,
									request_id,
									pb::ProtocolErrorCode::PermissionDenied,
									&error.to_string(),
								)
								.await;
								return;
							}
						}
						send_data_response(
							responses,
							request_id,
							data_response::Body::Site(materialized),
						)
						.await;
					},
					Err(
						error @ (SiteError::InvalidSiteKey
						| SiteError::InvalidFilePath(_)
						| SiteError::InvalidBlobHash),
					) => {
						send_error(
							responses,
							request_id,
							pb::ProtocolErrorCode::InvalidArgument,
							&error.to_string(),
						)
						.await;
					},
					Err(error @ SiteError::TrustedLoad(_)) => {
						send_error(
							responses,
							request_id,
							pb::ProtocolErrorCode::PermissionDenied,
							&error.to_string(),
						)
						.await;
					},
					Err(error) => {
						send_error(
							responses,
							request_id,
							pb::ProtocolErrorCode::Internal,
							&error.to_string(),
						)
						.await;
					},
				}
			},
			Some(Body::DetachExec(request)) => {
				if !authorize_data_operation(
					connection,
					scope,
					"omp.env.sh.detach",
					"env.exec",
					responses,
					request_id,
				)
				.await
				{
					return;
				}
				match self.exec.detach_exec(&request.exec, &request.name) {
					Ok(response) => {
						send_data_response(
							responses,
							request_id,
							data_response::Body::DetachedExec(response),
						)
						.await;
					},
					Err(error) => send_exec_error(responses, request_id, &error).await,
				}
			},
			Some(Body::Resource(request)) => {
				self
					.dispatch_resource(request_id, request, scope, responses, finished, connection)
					.await;
			},
			None => {
				send_error(
					responses,
					request_id,
					pb::ProtocolErrorCode::InvalidArgument,
					"DATA request body is missing",
				)
				.await;
			},
		}
	}

	async fn dispatch_resource(
		&self,
		request_id: u64,
		request: pb::ResourceOp,
		scope: Option<&pb::InvocationScope>,
		responses: &flume::Sender<pb::ServerFrame>,
		finished: &flume::Sender<Finished>,
		connection: &mut ConnectionState,
	) {
		use pb::resource_op::Op;

		if !authorize_data_operation(
			connection,
			scope,
			"omp.env.docs.read",
			"env.doc.read",
			responses,
			request_id,
		)
		.await
		{
			return;
		}
		let Some(operation) = request.op else {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				"resource operation is missing",
			)
			.await;
			return;
		};
		let wire_revision = match &operation {
			Op::Read(request) => request.wire_revision,
			Op::List(request) => request.wire_revision,
			Op::Path(request) => request.wire_revision,
			Op::Complete(request) => request.wire_revision,
		};
		if wire_revision != omp_proto::SCHEMA_REV {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				"resource wire revision does not match the Environment schema",
			)
			.await;
			return;
		}

		match operation {
			Op::Read(request) => {
				let Some(uri) = parse_mounted_resource_uri(&request.uri, responses, request_id).await
				else {
					return;
				};
				let max_bytes = match resource_bound(
					request.max_bytes,
					MAX_RESOURCE_READ_BYTES,
					"resource read max_bytes",
				) {
					Ok(bound) => bound,
					Err(message) => {
						send_error(
							responses,
							request_id,
							pb::ProtocolErrorCode::InvalidArgument,
							message,
						)
						.await;
						return;
					},
				};
				let Some(result) = self
					.resources
					.read_bounded(uri.scheme, uri.resource, &uri.selector, max_bytes, request.path_only)
					.await
				else {
					send_resource_capability_error(responses, request_id, "read").await;
					return;
				};
				match result {
					Ok(result) => {
						let capability = self
							.resources
							.capability(uri.scheme)
							.expect("mounted resource keeps capability metadata");
						send_resource_result(responses, request_id, pb::ResourceResult {
							uri:                request.uri,
							data:               Bytes::copy_from_slice(&result.data),
							entries:            Vec::new(),
							canonical_path_uri: result
								.canonical_path_uri
								.map_or_else(String::new, |uri| uri.to_string()),
							capability:         Some(resource_capability_wire(capability)),
							truncated:          result.truncated,
						})
						.await;
					},
					Err(fault) => send_resource_fault(responses, request_id, &fault).await,
				}
			},
			Op::List(request) => {
				let Some(uri) = parse_mounted_resource_uri(&request.uri, responses, request_id).await
				else {
					return;
				};
				if !matches!(uri.selector, omp_tools::read::selector::ParsedSelector::None) {
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::InvalidArgument,
						"resource list URI cannot include a read selector",
					)
					.await;
					return;
				}
				let max_entries = match resource_bound(
					u64::from(request.max_entries),
					MAX_RESOURCE_ENTRIES,
					"resource list max_entries",
				) {
					Ok(bound) => bound,
					Err(message) => {
						send_error(
							responses,
							request_id,
							pb::ProtocolErrorCode::InvalidArgument,
							message,
						)
						.await;
						return;
					},
				};
				let max_bytes = match resource_bound(
					request.max_bytes,
					MAX_RESOURCE_LIST_BYTES,
					"resource list max_bytes",
				) {
					Ok(bound) => bound,
					Err(message) => {
						send_error(
							responses,
							request_id,
							pb::ProtocolErrorCode::InvalidArgument,
							message,
						)
						.await;
						return;
					},
				};
				let Some(result) = self
					.resources
					.list(uri.scheme, uri.resource, max_entries, max_bytes)
					.await
				else {
					send_resource_capability_error(responses, request_id, "list").await;
					return;
				};
				match result {
					Ok(result) => {
						let capability = self
							.resources
							.capability(uri.scheme)
							.expect("mounted resource keeps capability metadata");
						send_resource_result(responses, request_id, pb::ResourceResult {
							uri:                request.uri,
							data:               Bytes::new(),
							entries:            result
								.entries
								.into_iter()
								.map(|entry| pb::ResourceEntry {
									uri:       entry.uri.to_string(),
									name:      entry.name.to_string(),
									directory: entry.directory,
									size:      entry.size,
								})
								.collect(),
							canonical_path_uri: String::new(),
							capability:         Some(resource_capability_wire(capability)),
							truncated:          result.truncated,
						})
						.await;
					},
					Err(fault) => send_resource_fault(responses, request_id, &fault).await,
				}
			},
			Op::Path(request) => {
				let Some(uri) = parse_mounted_resource_uri(&request.uri, responses, request_id).await
				else {
					return;
				};
				let Some(result) = self.resources.path(uri.scheme, uri.resource).await else {
					send_resource_capability_error(responses, request_id, "path").await;
					return;
				};
				match result {
					Ok(result) => {
						let capability = self
							.resources
							.capability(uri.scheme)
							.expect("mounted resource keeps capability metadata");
						send_resource_result(responses, request_id, pb::ResourceResult {
							uri:                request.uri,
							data:               Bytes::new(),
							entries:            Vec::new(),
							canonical_path_uri: result
								.canonical_path_uri
								.map_or_else(String::new, |uri| uri.to_string()),
							capability:         Some(resource_capability_wire(capability)),
							truncated:          false,
						})
						.await;
					},
					Err(fault) => send_resource_fault(responses, request_id, &fault).await,
				}
			},
			Op::Complete(request) => {
				let max_results = match resource_bound(
					u64::from(request.max_results),
					MAX_RESOURCE_COMPLETIONS,
					"resource completion max_results",
				) {
					Ok(bound) => bound,
					Err(message) => {
						send_error(
							responses,
							request_id,
							pb::ProtocolErrorCode::InvalidArgument,
							message,
						)
						.await;
						return;
					},
				};
				if request.input.len() > MAX_RESOURCE_URI_BYTES {
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::InvalidArgument,
						"resource completion input exceeds the 8192-byte limit",
					)
					.await;
					return;
				}
				if request.catalog_revision != 0
					&& request.catalog_revision != self.resources.revision()
				{
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::PreconditionFailed,
						"resource completion catalog revision is stale",
					)
					.await;
					return;
				}
				if let Err(error) = connection.quotas.reserve_stream() {
					send_policy_error(responses, request_id, error).await;
					return;
				}
				let cancel = CancellationToken::new();
				connection
					.requests
					.insert(request_id, RequestState::DataStream { cancel: cancel.clone() });
				spawn_resource_completion(
					request_id,
					request.input,
					max_results,
					Arc::clone(&self.resources),
					cancel,
					responses.clone(),
					finished.clone(),
				);
			},
		}
	}

	async fn dispatch_privileged_mutation(
		&self,
		request_id: u64,
		request: pb::PrivilegedMutationIntent,
		scope: Option<&pb::InvocationScope>,
		responses: &flume::Sender<pb::ServerFrame>,
	) {
		if request.wire_revision != omp_proto::SCHEMA_REV {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				"privileged-mutation wire revision does not match the Environment schema",
			)
			.await;
			return;
		}
		let Some(scope) = scope.filter(|scope| scope.invocation_id == request.invocation_id) else {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::PermissionDenied,
				"privileged mutation invocation attribution does not match its Environment scope",
			)
			.await;
			return;
		};
		let attributed = !scope.effect_token.is_empty()
			&& request
				.session
				.as_ref()
				.is_some_and(|session| !session.value.is_empty())
			&& request
				.effect
				.as_ref()
				.is_some_and(|effect| !effect.value.is_empty());
		if !attributed {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::PermissionDenied,
				"privileged mutation requires session, invocation, effect, and approval attribution",
			)
			.await;
			return;
		}
		let Some(mutation) = request.mutation else {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				"privileged mutation omitted its write or unlink intent",
			)
			.await;
			return;
		};
		let target_uri = match &mutation {
			privileged_mutation_intent::Mutation::Write(intent) => {
				intent.canonical_target_uri.as_str()
			},
			privileged_mutation_intent::Mutation::Unlink(intent) => {
				intent.canonical_target_uri.as_str()
			},
		};
		let (canonical_uri, target) =
			match canonical_privileged_target(self.workspace.root(), target_uri) {
				Ok(target) => target,
				Err(message) => {
					send_error(responses, request_id, pb::ProtocolErrorCode::InvalidArgument, &message)
						.await;
					return;
				},
			};
		let kind = match &mutation {
			privileged_mutation_intent::Mutation::Write(_) => "write",
			privileged_mutation_intent::Mutation::Unlink(_) => "unlink",
		};
		if !self
			.approvals
			.approve_privileged(
				&request.approval_ticket,
				&Str::from(request.invocation_id.as_str()),
				&canonical_uri,
				kind,
			)
			.await
		{
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::PermissionDenied,
				"privileged mutation approval ticket is absent, denied, expired, or inauthentic",
			)
			.await;
			return;
		}
		let root = self.workspace.root().to_path_buf();
		let operation = task::spawn_blocking(move || match mutation {
			privileged_mutation_intent::Mutation::Write(intent) => {
				let expected_present = privileged_presence(intent.expected_presence)?;
				let expected = privileged_revision_hash(intent.expected_revision.as_ref())?;
				privileged_write(
					&root,
					&target,
					intent.content,
					expected_present,
					expected.as_ref(),
					intent.mode,
				)
				.map_err(PrivilegedDispatchError::Mutation)?;
				Ok((document_pb::DocumentPresence::Present, None))
			},
			privileged_mutation_intent::Mutation::Unlink(intent) => {
				let expected_present = privileged_presence(intent.expected_presence)?;
				let expected = privileged_revision_hash(intent.expected_revision.as_ref())?;
				privileged_unlink(
					&root,
					&target,
					expected_present,
					expected.as_ref(),
					intent.recursive,
				)
				.map_err(PrivilegedDispatchError::Mutation)?;
				Ok((document_pb::DocumentPresence::Missing, None))
			},
		})
		.await;
		match operation {
			Ok(Ok((presence, committed_revision))) => {
				send_data_response(
					responses,
					request_id,
					data_response::Body::PrivilegedMutation(pb::PrivilegedMutationResult {
						canonical_target_uri: canonical_uri,
						presence: presence as i32,
						committed_revision,
					}),
				)
				.await;
			},
			Ok(Err(error)) => {
				let (code, message) = privileged_dispatch_error(error);
				send_error(responses, request_id, code, &message).await;
			},
			Err(error) => {
				send_error(
					responses,
					request_id,
					pb::ProtocolErrorCode::Internal,
					&format!("privileged mutation worker failed: {error}"),
				)
				.await;
			},
		}
	}

	async fn dispatch_dap(
		&self,
		request_id: u64,
		request: data_request::Body,
		scope: Option<&pb::InvocationScope>,
		responses: &flume::Sender<pb::ServerFrame>,
		finished: &flume::Sender<Finished>,
		connection: &mut ConnectionState,
	) {
		use data_request::Body;

		if self.environment_authorities().is_none() {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::Unsupported,
				"DAP authority is unavailable on a session-only host",
			)
			.await;
			return;
		}

		let (operation, capability) = match &request {
			Body::DapLaunch(_) => ("omp.env.dap.launch", "env.dap.execute"),
			Body::DapAttach(_) => ("omp.env.dap.attach", "env.dap.execute"),
			Body::DapAction(request) => {
				("omp.env.dap.action", dap_command_capability(&request.command))
			},
			_ => unreachable!("DAP dispatch receives only DAP request arms"),
		};
		if !authorize_data_operation(connection, scope, operation, capability, responses, request_id)
			.await
		{
			return;
		}
		if let Err(error) = connection.quotas.reserve_stream() {
			send_policy_error(responses, request_id, error).await;
			return;
		}
		let cancel = CancellationToken::new();
		connection
			.requests
			.insert(request_id, RequestState::DataStream { cancel: cancel.clone() });
		let documents = self.documents().clone();
		let responses = responses.clone();
		let finished = finished.clone();
		tokio::spawn(async move {
			let result = match request {
				Body::DapLaunch(request) => documents
					.dap_launch(request, &cancel)
					.await
					.map(|(response, events)| (data_response::Body::DapSession(response), events)),
				Body::DapAttach(request) => documents
					.dap_attach(request, &cancel)
					.await
					.map(|(response, events)| (data_response::Body::DapSession(response), events)),
				Body::DapAction(request) => documents
					.dap_action(request, &cancel)
					.await
					.map(|(response, events)| (data_response::Body::DapAction(response), events)),
				_ => unreachable!("DAP dispatch receives only DAP request arms"),
			};
			match result {
				Ok((response, events)) => {
					for event in events {
						let body = match event {
							DapRegistryEvent::Output(output) => data_event::Body::DapOutput(output),
							DapRegistryEvent::Event(event) => data_event::Body::DapEvent(event),
						};
						send_body(
							&responses,
							request_id,
							server_frame::Body::DataEvent(pb::DataEvent {
								body: Some(body),
								..pb::DataEvent::default()
							}),
						)
						.await;
					}
					send_data_response(&responses, request_id, response).await;
				},
				Err(error) => send_document_error(&responses, request_id, &error).await,
			}
			let _ = finished
				.send_async(Finished { request_id, invocation_id: None })
				.await;
		});
	}

	async fn dispatch_exec_session(
		&self,
		request_id: u64,
		request: pb::ExecSessionOp,
		responses: &flume::Sender<pb::ServerFrame>,
	) {
		use pb::{exec_session_op::Op, exec_session_result::Result};

		let result = match request.op {
			Some(Op::Materialize(request)) => {
				if request.wire_revision != omp_proto::SCHEMA_REV {
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::InvalidArgument,
						"materialization wire revision does not match the Environment schema",
					)
					.await;
					return;
				}
				if request.session.is_empty() || !self.exec.contains_session(&request.session) {
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::NotFound,
						"materialization exec session was not found",
					)
					.await;
					return;
				}
				match self.materializations.materialize(request).await {
					Ok(lease) => Result::Materialized(lease),
					Err(error) => {
						send_materialization_error(responses, request_id, &error).await;
						return;
					},
				}
			},
			Some(Op::ReleaseMaterialization(request)) => {
				if request.wire_revision != omp_proto::SCHEMA_REV {
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::InvalidArgument,
						"materialization release wire revision does not match the Environment schema",
					)
					.await;
					return;
				}
				match self.materializations.release(request).await {
					Ok(released) => Result::MaterializationReleased(released),
					Err(error) => {
						send_materialization_error(responses, request_id, &error).await;
						return;
					},
				}
			},
			Some(Op::Control(request)) => match self.exec.control(&request) {
				Ok(controlled) => Result::Controlled(controlled),
				Err(error) => {
					send_exec_error(responses, request_id, &error).await;
					return;
				},
			},
			Some(Op::Stdin(request)) => {
				match self
					.exec
					.stdin(&request.exec, match request.input.as_ref() {
						Some(stdin_frame::Input::Data(data)) => Some(data.as_ref()),
						Some(stdin_frame::Input::Eof(_)) => None,
						None => {
							send_error(
								responses,
								request_id,
								pb::ProtocolErrorCode::InvalidArgument,
								"exec stdin operation omitted input",
							)
							.await;
							return;
						},
					}) {
					Ok(()) => Result::Controlled(pb::ExecControlResult {
						exec:     request.exec,
						accepted: true,
					}),
					Err(error) => {
						send_exec_error(responses, request_id, &error).await;
						return;
					},
				}
			},
			Some(Op::Resize(request)) => {
				match self
					.exec
					.resize(&request.exec, request.rows, request.columns)
				{
					Ok(()) => Result::Controlled(pb::ExecControlResult {
						exec:     request.exec,
						accepted: true,
					}),
					Err(error) => {
						send_exec_error(responses, request_id, &error).await;
						return;
					},
				}
			},
			Some(Op::Signal(request)) => match self.exec.signal(&request.exec, &request.signal) {
				Ok(()) => {
					Result::Controlled(pb::ExecControlResult { exec: request.exec, accepted: true })
				},
				Err(error) => {
					send_exec_error(responses, request_id, &error).await;
					return;
				},
			},
			Some(Op::Capabilities(request)) => match self.exec.capabilities(&request) {
				Ok(capabilities) => Result::Capabilities(capabilities),
				Err(error) => {
					send_exec_error(responses, request_id, &error).await;
					return;
				},
			},
			Some(Op::FinalCwd(request)) => match self.exec.final_cwd(&request) {
				Ok(final_cwd) => Result::FinalCwd(final_cwd),
				Err(error) => {
					send_exec_error(responses, request_id, &error).await;
					return;
				},
			},
			None => {
				send_error(
					responses,
					request_id,
					pb::ProtocolErrorCode::InvalidArgument,
					"exec-session operation is missing",
				)
				.await;
				return;
			},
		};
		send_data_response(
			responses,
			request_id,
			data_response::Body::ExecSession(pb::ExecSessionResult { result: Some(result) }),
		)
		.await;
	}

	async fn dispatch_mcp(
		&self,
		request_id: u64,
		request: pb::McpOp,
		responses: &flume::Sender<pb::ServerFrame>,
		finished: &flume::Sender<Finished>,
		connection: &mut ConnectionState,
	) {
		use mcp_op::Op;

		let Some(operation) = request.op else {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				"MCP operation is missing",
			)
			.await;
			return;
		};
		if mcp_wire_revision(&operation) != omp_proto::SCHEMA_REV {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::Unsupported,
				"MCP operation uses an unsupported wire revision",
			)
			.await;
			return;
		}
		if let Op::Status(request) = operation {
			send_data_response(
				responses,
				request_id,
				data_response::Body::Mcp(pb::McpResult {
					result: Some(mcp_result::Result::Status(self.mcp.status(request.name.as_deref()))),
				}),
			)
			.await;
			return;
		}
		if let Err(error) = connection.quotas.reserve_stream() {
			send_policy_error(responses, request_id, error).await;
			return;
		}
		let cancel = CancellationToken::new();
		connection
			.requests
			.insert(request_id, RequestState::DataStream { cancel: cancel.clone() });
		match operation {
			Op::Subscribe(request) => match self
				.mcp
				.subscribe(request.name.as_deref(), request.after_sequence)
			{
				Ok(subscription) => spawn_mcp_subscription(
					request_id,
					subscription,
					cancel,
					responses.clone(),
					finished.clone(),
				),
				Err(error) => {
					connection.requests.remove(&request_id);
					connection.quotas.release_stream();
					send_mcp_error(responses, request_id, &error).await;
				},
			},
			operation => spawn_mcp_request(
				request_id,
				Arc::clone(&self.mcp),
				operation,
				cancel,
				responses.clone(),
				finished.clone(),
			),
		}
	}

	async fn dispatch_repository_snapshot(
		&self,
		request_id: u64,
		request: pb::RepositorySnapshotRequest,
		responses: &flume::Sender<pb::ServerFrame>,
	) {
		if request.wire_revision != omp_proto::SCHEMA_REV {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				"repository snapshot wire revision does not match the Environment schema",
			)
			.await;
			return;
		}
		let requested_root = if request.root_uri.is_empty() {
			self.workspace.root().to_path_buf()
		} else {
			let parsed = match Url::parse(&request.root_uri) {
				Ok(parsed) => parsed,
				Err(_) => {
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::InvalidArgument,
						"repository root is not a valid URI",
					)
					.await;
					return;
				},
			};
			match parsed.to_file_path() {
				Ok(path) => path,
				Err(()) => {
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::InvalidArgument,
						"repository root is not a local file URI",
					)
					.await;
					return;
				},
			}
		};
		let requested_root = match tokio::fs::canonicalize(&requested_root).await {
			Ok(root) if root.starts_with(self.workspace.root()) => root,
			Ok(_) => {
				send_error(
					responses,
					request_id,
					pb::ProtocolErrorCode::PermissionDenied,
					"repository root is outside the Environment workspace grant",
				)
				.await;
				return;
			},
			Err(_) => {
				send_error(
					responses,
					request_id,
					pb::ProtocolErrorCode::InvalidArgument,
					"repository root does not exist",
				)
				.await;
				return;
			},
		};
		let cancel = CancellationToken::new();
		let snapshot = match vcs::snapshot(&requested_root, &cancel).await {
			Ok(snapshot) => snapshot,
			Err(_) => {
				send_error(
					responses,
					request_id,
					pb::ProtocolErrorCode::Internal,
					"repository snapshot could not be captured",
				)
				.await;
				return;
			},
		};
		let availability = match snapshot.availability {
			RepositoryAvailability::Available => pb::RepositoryAvailability::Available,
			RepositoryAvailability::NotRepository => pb::RepositoryAvailability::NotRepository,
			RepositoryAvailability::GitUnavailable => pb::RepositoryAvailability::GitUnavailable,
		};
		let worktree_root_uri = snapshot
			.worktree_root
			.as_deref()
			.and_then(|path| Url::from_directory_path(path).ok())
			.map_or_else(String::new, |url| url.to_string());
		let primary_root_uri = snapshot
			.primary_root
			.as_deref()
			.and_then(|path| Url::from_directory_path(path).ok())
			.map_or_else(String::new, |url| url.to_string());
		self
			.send_repository_snapshot(
				request_id,
				pb::RepositorySnapshot {
					availability: availability as i32,
					worktree_root_uri,
					primary_root_uri,
					head: snapshot
						.head
						.map_or_else(String::new, |head| head.to_string()),
					branch: snapshot
						.branch
						.map_or_else(String::new, |branch| branch.to_string()),
					staged: snapshot.status_counts.staged,
					unstaged: snapshot.status_counts.unstaged,
					untracked: snapshot.status_counts.untracked,
					revision: self.repository_revision.fetch_add(1, Ordering::Relaxed) + 1,
					truncated: false,
				},
				responses,
			)
			.await;
	}

	async fn send_repository_snapshot(
		&self,
		request_id: u64,
		snapshot: pb::RepositorySnapshot,
		responses: &flume::Sender<pb::ServerFrame>,
	) {
		send_data_response(responses, request_id, data_response::Body::RepositorySnapshot(snapshot))
			.await;
	}

	async fn dispatch_worker(
		&self,
		request_id: u64,
		request: pb::WorkerOp,
		responses: &flume::Sender<pb::ServerFrame>,
	) {
		use pb::{worker_op::Op, worker_result::Result as WorkerResult};

		let result = match request.op {
			Some(Op::Open(open)) => {
				let key = WorkerKey {
					extension: sf!("env"),
					name:      Str::from(open.name.as_str()),
					site:      sf!("env"),
				};
				match self.workers.open(key) {
					Ok((route, lease)) => {
						lease.relinquish();
						Ok(WorkerResult::Opened(pb::WorkerOpened {
							name: route.key.name.to_string(),
							generation: route.generation,
							..pb::WorkerOpened::default()
						}))
					},
					Err(WorkerUnavailable::LayerCeiling | WorkerUnavailable::SpawnCeiling) => {
						Err((pb::ProtocolErrorCode::ResourceExhausted, "WorkerUnavailable"))
					},
					Err(WorkerUnavailable::StaleGeneration) => {
						Err((pb::ProtocolErrorCode::InvalidArgument, "stale worker generation"))
					},
				}
			},
			Some(Op::Close(close)) => {
				if self.workers.close(&close.name, close.generation) {
					Ok(WorkerResult::Closed(pb::ProcessCommandAccepted::default()))
				} else {
					Err((pb::ProtocolErrorCode::InvalidArgument, "stale worker generation"))
				}
			},
			Some(Op::Data(data)) => match self.workers.demux(data) {
				Ok(accepted) => Ok(WorkerResult::Data(pb::WorkerData {
					name: accepted.route.key.name.to_string(),
					generation: accepted.route.generation,
					channel: accepted.channel,
					data: Bytes::copy_from_slice(&accepted.data),
					..pb::WorkerData::default()
				})),
				Err(WorkerUnavailable::StaleGeneration) => {
					Err((pb::ProtocolErrorCode::InvalidArgument, "stale worker generation"))
				},
				Err(WorkerUnavailable::LayerCeiling | WorkerUnavailable::SpawnCeiling) => {
					Err((pb::ProtocolErrorCode::ResourceExhausted, "WorkerUnavailable"))
				},
			},
			Some(Op::Info(info)) => match self.workers.route(&info.name) {
				Some(route) => Ok(WorkerResult::Info(worker_info(&route))),
				None => Err((pb::ProtocolErrorCode::InvalidArgument, "unknown worker")),
			},
			Some(Op::List(_)) => Ok(WorkerResult::List(pb::WorkerList {
				workers: self.workers.routes().iter().map(worker_info).collect(),
				..pb::WorkerList::default()
			})),
			None => Err((pb::ProtocolErrorCode::InvalidArgument, "worker operation is missing")),
		};
		match result {
			Ok(result) => {
				send_body(
					responses,
					request_id,
					server_frame::Body::Data(pb::DataResponse {
						body: Some(data_response::Body::Worker(pb::WorkerResult {
							result: Some(result),
							..pb::WorkerResult::default()
						})),
						..pb::DataResponse::default()
					}),
				)
				.await;
			},
			Err((code, message)) => send_error(responses, request_id, code, message).await,
		}
	}

	async fn dispatch_workspace(
		&self,
		request_id: u64,
		request: pb::WorkspaceOp,
		scope: Option<&pb::InvocationScope>,
		responses: &flume::Sender<pb::ServerFrame>,
		connection: &mut ConnectionState,
	) {
		use pb::workspace_op::Op;

		if self.environment_authorities().is_none() {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::Unsupported,
				"workspace authority is unavailable on a session-only host",
			)
			.await;
			return;
		}

		let Some(operation) = request.op else {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				"workspace operation is missing",
			)
			.await;
			return;
		};
		let operation_name = match &operation {
			Op::Snapshot(_) => "omp.env.workspace.snapshot",
			Op::List(_) => "omp.env.workspace.list",
			Op::Restore(_) => "omp.env.workspace.restore",
		};
		if !authorize_data_operation(
			connection,
			scope,
			operation_name,
			"env.workspace.snapshot",
			responses,
			request_id,
		)
		.await
		{
			return;
		}
		let cancel = CancellationToken::new();
		let result = match operation {
			Op::Snapshot(request) => self
				.environment_authorities()
				.expect("workspace operation reached session-only host")
				.workspace_ops
				.snapshot(&request, &cancel)
				.map(workspace_result::Result::Snapshot),
			Op::List(request) => self
				.environment_authorities()
				.expect("workspace operation reached session-only host")
				.workspace_ops
				.list_snapshots(&request)
				.map(workspace_result::Result::List),
			Op::Restore(request) => self
				.environment_authorities()
				.expect("workspace operation reached session-only host")
				.workspace_ops
				.restore(&request, &cancel)
				.await
				.map(workspace_result::Result::Restored),
		};
		match result {
			Ok(result) => {
				send_data_response(
					responses,
					request_id,
					data_response::Body::Workspace(pb::WorkspaceResult {
						result: Some(result),
						props:  Default::default(),
					}),
				)
				.await;
			},
			Err(error) => send_workspace_operation_error(responses, request_id, &error).await,
		}
	}

	async fn dispatch_worktree(
		&self,
		request_id: u64,
		request: pb::WorktreeOp,
		scope: Option<&pb::InvocationScope>,
		responses: &flume::Sender<pb::ServerFrame>,
		connection: &mut ConnectionState,
	) {
		use pb::worktree_op::Op;

		if self.environment_authorities().is_none() {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::Unsupported,
				"worktree authority is unavailable on a session-only host",
			)
			.await;
			return;
		}

		let Some(operation) = request.op else {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				"worktree operation is missing",
			)
			.await;
			return;
		};
		let operation_name = match &operation {
			Op::Create(_) => "omp.env.worktree.create",
			Op::Destroy(_) => "omp.env.worktree.destroy",
			Op::Merge(_) => "omp.env.worktree.merge",
			Op::Current(_) => "omp.env.worktree",
		};
		if let Op::Current(request) = &operation
			&& request.wire_revision != omp_proto::SCHEMA_REV
		{
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::Unsupported,
				"unsupported current-worktree wire revision",
			)
			.await;
			return;
		}
		if !authorize_data_operation(
			connection,
			scope,
			operation_name,
			"env.worktree",
			responses,
			request_id,
		)
		.await
		{
			return;
		}
		let cancel = CancellationToken::new();
		let result = match operation {
			Op::Create(request) => self
				.environment_authorities()
				.expect("workspace operation reached session-only host")
				.workspace_ops
				.create_worktree(&request, &cancel)
				.map(|worktree| pb::WorktreeResult {
					worktree:      Some(worktree),
					conflicts:     Vec::new(),
					artifact_hash: Bytes::new(),
					artifact_size: 0,
					branch:        None,
					current:       None,
					props:         Default::default(),
				}),
			Op::Destroy(request) => self
				.environment_authorities()
				.expect("workspace operation reached session-only host")
				.workspace_ops
				.destroy_worktree(&request, &cancel)
				.map(|worktree| pb::WorktreeResult {
					worktree:      Some(worktree),
					conflicts:     Vec::new(),
					artifact_hash: Bytes::new(),
					artifact_size: 0,
					branch:        None,
					current:       None,
					props:         Default::default(),
				}),
			Op::Merge(request) => self
				.environment_authorities()
				.expect("workspace operation reached session-only host")
				.workspace_ops
				.merge_worktree(&request, &cancel)
				.await
				.map(|merge| pb::WorktreeResult {
					worktree:      Some(merge.worktree),
					conflicts:     merge.conflicts,
					artifact_hash: merge
						.artifact
						.map_or_else(Bytes::new, |artifact| Bytes::copy_from_slice(&artifact.hash)),
					artifact_size: merge.artifact.map_or(0, |artifact| artifact.size),
					branch:        merge.branch.map(|branch| branch.to_string()),
					current:       None,
					props:         Default::default(),
				}),
			Op::Current(_request) => self
				.environment_authorities()
				.expect("workspace operation reached session-only host")
				.workspace_ops
				.current_worktree()
				.map(|primary| pb::WorktreeResult {
					worktree:      None,
					conflicts:     Vec::new(),
					artifact_hash: Bytes::new(),
					artifact_size: 0,
					branch:        None,
					current:       Some(pb::CurrentWorktreeResult {
						primary,
						wire_revision: omp_proto::SCHEMA_REV,
						props: Default::default(),
					}),
					props:         Default::default(),
				}),
		};
		match result {
			Ok(result) => {
				send_data_response(responses, request_id, data_response::Body::Worktree(result)).await;
			},
			Err(error) => send_workspace_operation_error(responses, request_id, &error).await,
		}
	}

	async fn dispatch_document(
		&self,
		request_id: u64,
		request: pb::DocumentOp,
		scope: Option<&pb::InvocationScope>,
		responses: &flume::Sender<pb::ServerFrame>,
		finished: &flume::Sender<Finished>,
		connection: &mut ConnectionState,
	) {
		use pb::document_op::Op;

		if self.environment_authorities().is_none() {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::Unsupported,
				"document authority is unavailable on a session-only host",
			)
			.await;
			return;
		}

		let Some(operation) = request.op else {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				"document operation is missing",
			)
			.await;
			return;
		};
		if !self
			.environment_authorities()
			.expect("LSP operation reached session-only host")
			.lsp_settings
			.enabled
			&& matches!(
				&operation,
				Op::GetLspBindings(_) | Op::LspStatus(_) | Op::LspRequest(_) | Op::LspNotification(_)
			) {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::Unsupported,
				"LSP operations are disabled by the resolved project settings",
			)
			.await;
			return;
		}
		let (operation_name, required) = match &operation {
			Op::Open(_) => ("omp.env.docs.open", "env.doc.read"),
			Op::Close(_) => ("omp.env.docs.close", "env.doc.read"),
			Op::Read(_) => ("omp.env.docs.read", "env.doc.read"),
			Op::Summarize(_) => ("omp.env.docs.summarize", "env.doc.read"),
			Op::CommitTransaction(_) => ("omp.env.docs.commit_transaction", "env.doc.write"),
			Op::Canonicalize(_) => ("omp.env.fs.canonicalize", "env.fs.read"),
			Op::Stat(_) => ("omp.env.fs.stat", "env.fs.read"),
			Op::ListDirectory(_) => ("omp.env.fs.list_directory", "env.fs.read"),
			Op::CreateDirectory(_) => ("omp.env.fs.create_directory", "env.fs.write"),
			Op::Remove(_) => ("omp.env.fs.remove", "env.fs.write"),
			Op::Rename(_) => ("omp.env.fs.rename", "env.fs.write"),
			Op::Copy(_) => ("omp.env.fs.copy", "env.fs.write"),
			Op::ReadLink(_) => ("omp.env.fs.read_link", "env.fs.read"),
			Op::CreateSymlink(_) => ("omp.env.fs.create_symlink", "env.fs.write"),
			Op::CreateHardLink(_) => ("omp.env.fs.create_hard_link", "env.fs.write"),
			Op::SetPermissions(_) => ("omp.env.fs.set_permissions", "env.fs.write"),
			Op::GetLspBindings(_) => ("omp.env.lsp.get_bindings", "env.lsp"),
			Op::LspStatus(_) => ("omp.env.lsp.status", "env.lsp"),
			Op::LspRequest(request) => {
				("omp.env.lsp.request", lsp_tier_capability(lsp_request_tier(&request.method)))
			},
			Op::LspNotification(request) => (
				"omp.env.lsp.notification",
				lsp_tier_capability(lsp_notification_tier(&request.method)),
			),
		};
		if !authorize_data_operation(
			connection,
			scope,
			operation_name,
			required,
			responses,
			request_id,
		)
		.await
		{
			return;
		}

		let cancel = CancellationToken::new();
		let mut opened_events: Option<(DocumentEvents, CancellationToken)> = None;
		let mut lsp_events: Option<(LspEvents, CancellationToken)> = None;
		let result = match operation {
			Op::Open(request) => {
				if let Err(error) = connection.quotas.reserve_document_lease() {
					send_policy_error(responses, request_id, error).await;
					return;
				}
				match self.documents().open_request(request, &cancel).await {
					Ok((mut lease, response)) => {
						if let Some(events) = lease.take_events() {
							if let Err(error) = connection.quotas.reserve_stream() {
								connection.quotas.release_document_lease();
								send_policy_error(responses, request_id, error).await;
								return;
							}
							let stream_cancel = CancellationToken::new();
							connection
								.requests
								.insert(request_id, RequestState::DocumentEvents {
									lease_id: lease.id().clone(),
									cancel:   stream_cancel.clone(),
								});
							opened_events = Some((events, stream_cancel));
						}
						self
							.authority
							.register_lease(lease.id().clone(), connection.connection_owner);
						connection.document_leases.insert(lease.id().clone(), lease);
						Ok(document_result::Result::Opened(response))
					},
					Err(error) => {
						connection.quotas.release_document_lease();
						Err(error)
					},
				}
			},
			Op::Close(request) => {
				if let Err(error) = self
					.authority
					.check_lease(&request.lease_id, connection.connection_owner)
				{
					send_policy_error(responses, request_id, error).await;
					return;
				}
				let lease_id = request.lease_id.clone();
				let Some(mut lease) = connection.document_leases.remove(&request.lease_id) else {
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::NotFound,
						"document lease is not owned by this connection",
					)
					.await;
					return;
				};
				match self
					.documents()
					.close_request(&mut lease, request, &cancel)
					.await
				{
					Ok(response) => {
						let stream_request = connection.requests.iter().find_map(|(request, state)| {
							matches!(
								state,
								RequestState::DocumentEvents { lease_id: owned, .. }
									if owned == &lease_id
							)
							.then_some(*request)
						});
						if let Some(stream_request) = stream_request
							&& let Some(RequestState::DocumentEvents { cancel, .. }) =
								connection.requests.remove(&stream_request)
						{
							cancel.cancel();
							connection.quotas.release_stream();
						}
						self
							.authority
							.release_lease(&lease_id, connection.connection_owner);
						connection.quotas.release_document_lease();
						Ok(document_result::Result::Closed(response))
					},
					Err(error) => {
						connection.document_leases.insert(lease.id().clone(), lease);
						Err(error)
					},
				}
			},
			Op::Read(request) => {
				if let Some(lease_id) = connection_lease_id(request.document.as_ref())
					&& let Err(error) = self
						.authority
						.check_lease(lease_id, connection.connection_owner)
				{
					send_policy_error(responses, request_id, error).await;
					return;
				}
				let Some(lease) = connection_lease(connection, request.document.as_ref()) else {
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::NotFound,
						"document lease is not owned by this connection",
					)
					.await;
					return;
				};
				self
					.documents()
					.read_request(lease, request, &cancel)
					.await
					.map(document_result::Result::Read)
			},
			Op::Summarize(request) => {
				if let Some(lease_id) = connection_lease_id(request.document.as_ref())
					&& let Err(error) = self
						.authority
						.check_lease(lease_id, connection.connection_owner)
				{
					send_policy_error(responses, request_id, error).await;
					return;
				}
				let Some(lease) = connection_lease(connection, request.document.as_ref()) else {
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::NotFound,
						"document lease is not owned by this connection",
					)
					.await;
					return;
				};
				self
					.documents()
					.summarize_request(lease, request, &cancel)
					.await
					.map(document_result::Result::Summarized)
			},
			Op::CommitTransaction(request) => {
				let lease_ids: Vec<Bytes> = request
					.operations
					.iter()
					.filter_map(|operation| connection_lease_id(operation.document.as_ref()).cloned())
					.collect();
				if let Some(error) = lease_ids.iter().find_map(|lease_id| {
					self
						.authority
						.check_lease(lease_id, connection.connection_owner)
						.err()
				}) {
					send_policy_error(responses, request_id, error).await;
					return;
				}
				if lease_ids.len() != request.operations.len()
					|| lease_ids
						.iter()
						.any(|lease_id| !connection.document_leases.contains_key(lease_id))
				{
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::NotFound,
						"transaction contains a document lease not owned by this connection",
					)
					.await;
					return;
				}
				match self
					.documents()
					.commit_transaction_request(request, &cancel)
					.await
				{
					Ok(response) => {
						if let Some(commit_transaction_response::Outcome::Committed(committed)) =
							&response.outcome
						{
							for operation in &committed.operations {
								let Some(lease_id) = lease_ids.get(operation.operation_index as usize)
								else {
									continue;
								};
								if let (Some(lease), Some(head)) =
									(connection.document_leases.get_mut(lease_id), operation.head.clone())
									&& let Err(error) = lease.advance(head)
								{
									return send_document_error(responses, request_id, &error).await;
								}
							}
						}
						Ok(document_result::Result::Transaction(response))
					},
					Err(error) => Err(error),
				}
			},
			Op::Canonicalize(request) => self
				.documents()
				.canonicalize(request, &cancel)
				.await
				.map(document_result::Result::Canonicalized),
			Op::Stat(request) => self
				.documents()
				.stat(request, &cancel)
				.await
				.map(document_result::Result::Stat),
			Op::ListDirectory(request) => self
				.documents()
				.list_directory(request, &cancel)
				.await
				.map(document_result::Result::Directory),
			Op::CreateDirectory(request) => self
				.documents()
				.create_directory(request, &cancel)
				.await
				.map(document_result::Result::DirectoryCreated),
			Op::Remove(request) => self
				.documents()
				.remove(request, &cancel)
				.await
				.map(document_result::Result::Removed),
			Op::Rename(request) => self
				.documents()
				.rename(request, &cancel)
				.await
				.map(document_result::Result::Renamed),
			Op::Copy(request) => self
				.documents()
				.copy(request, &cancel)
				.await
				.map(document_result::Result::Copied),
			Op::ReadLink(request) => self
				.documents()
				.read_link(request, &cancel)
				.await
				.map(document_result::Result::Link),
			Op::CreateSymlink(request) => self
				.documents()
				.create_symlink(request, &cancel)
				.await
				.map(document_result::Result::SymlinkCreated),
			Op::CreateHardLink(request) => self
				.documents()
				.create_hard_link(request, &cancel)
				.await
				.map(document_result::Result::HardLinkCreated),
			Op::SetPermissions(request) => self
				.documents()
				.set_permissions(request, &cancel)
				.await
				.map(document_result::Result::PermissionsSet),
			Op::GetLspBindings(request) => {
				match self.documents().get_lsp_bindings(request, &cancel).await {
					Ok(response) => {
						if let Some(events) = self.documents().take_lsp_events() {
							if let Err(error) = connection.quotas.reserve_stream() {
								send_policy_error(responses, request_id, error).await;
								return;
							}
							let stream_cancel = CancellationToken::new();
							connection
								.requests
								.insert(request_id, RequestState::LspEvents {
									cancel: stream_cancel.clone(),
								});
							lsp_events = Some((events, stream_cancel));
						}
						Ok(document_result::Result::LspBindings(response))
					},
					Err(error) => Err(error),
				}
			},
			Op::LspStatus(request) => self
				.documents()
				.lsp_status(request, &cancel)
				.await
				.map(document_result::Result::LspStatus),
			Op::LspRequest(request) => self
				.documents()
				.lsp_request(request, &cancel)
				.await
				.map(document_result::Result::LspResponse),
			Op::LspNotification(request) => self
				.documents()
				.lsp_notification(request, &cancel)
				.await
				.map(document_result::Result::LspNotified),
		};
		match result {
			Ok(result) => {
				send_data_response(
					responses,
					request_id,
					data_response::Body::Document(pb::DocumentResult {
						result: Some(result),
						props:  Default::default(),
					}),
				)
				.await;
				if let Some((events, cancel)) = opened_events {
					spawn_document_events(
						request_id,
						events,
						cancel,
						responses.clone(),
						finished.clone(),
					);
				}
				if let Some((events, cancel)) = lsp_events {
					spawn_lsp_events(request_id, events, cancel, responses.clone(), finished.clone());
				}
			},
			Err(error) => send_document_error(responses, request_id, &error).await,
		}
	}

	async fn open_invocation(
		&self,
		request_id: u64,
		request: pb::InvokeTool,
		scope: Option<&pb::InvocationScope>,
		responses: &flume::Sender<pb::ServerFrame>,
		finished: &flume::Sender<Finished>,
		connection: &mut ConnectionState,
	) {
		if reject_duplicate_open(connection, request_id, responses).await {
			return;
		}
		if connection.host.is_some() && request.name == "eval" {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::PermissionDenied,
				"eval is denied to extension-host connections",
			)
			.await;
			return;
		}
		let invocation_id = Str::from(request.invocation_id.as_str());
		if invocation_id.is_empty() {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				"invocation_id must not be empty",
			)
			.await;
			return;
		}
		if scope.is_some_and(|scope| scope.invocation_id != invocation_id.as_str()) {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				"invocation scope does not match InvokeTool.invocation_id",
			)
			.await;
			return;
		}
		let principal =
			scope.filter(|scope| !scope.session_id.is_empty() && !scope.agent_id.is_empty());
		if scope.is_some_and(|scope| scope.session_id.is_empty() != scope.agent_id.is_empty()) {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				"session_id and agent_id must both be present or both be absent",
			)
			.await;
			return;
		}
		if let Some(open_request) = connection.invocation_ids.get(&invocation_id).copied() {
			// A terminal invocation only awaits its `Finished` sweep; its id is
			// free for a replacement open (the client observed the terminal
			// verdict before reopening).
			let live = match connection.requests.get(&open_request) {
				None | Some(RequestState::InvocationFinishing) => false,
				Some(RequestState::Invocation(InvocationState::Native { lifecycle, .. })) => {
					!lifecycle.is_terminal()
				},
				Some(_) => true,
			};
			if live {
				send_error(
					responses,
					request_id,
					pb::ProtocolErrorCode::AlreadyExists,
					"invocation_id is already open on this connection",
				)
				.await;
				return;
			}
			connection.invocation_ids.remove(&invocation_id);
		}
		let registry = self.registry();
		let Some((_, revision)) = registry.live_identity(&request.name) else {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::NotFound,
				unknown_tool_message(&request.name),
			)
			.await;
			return;
		};
		if revision.to_string() != request.rev {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::PreconditionFailed,
				"requested tool revision is not live",
			)
			.await;
			return;
		}
		let route = registry
			.route(&request.name)
			.expect("a live registry identity always has an execution route");
		let deadline = if request.deadline_ms == 0 {
			DEFAULT_TOOL_DEADLINE
		} else {
			Duration::from_millis(request.deadline_ms)
		};
		let output_request = match pb::OutputRequest::try_from(request.output_request) {
			Ok(pb::OutputRequest::Complete) => omp_tool::OutputRequest::Complete,
			Ok(pb::OutputRequest::Bounded | pb::OutputRequest::Unspecified) | Err(_) => {
				omp_tool::OutputRequest::Bounded
			},
		};
		let maximum_effects = registry
			.effects(&request.name)
			.expect("a routed tool has a declared effect envelope")
			.clone();
		let execution = InvocationExecutionPolicy::from_request(&request);
		let approval_policy = if execution.core_admission {
			ApprovalPolicy::Prompt
		} else {
			connection
				.tool_settings
				.approval_for(invocation_id.clone(), request.name.as_str(), &maximum_effects)
				.policy
		};
		let cancel = CancellationToken::new();
		if route == ToolRoute::Native {
			let owner = if let Some(principal) = principal {
				Str::from(
					serde_json::to_string(&(&principal.session_id, &principal.agent_id))
						.expect("invocation principal tuple is always serializable"),
				)
			} else if request.name == "eval" {
				send_error(
					responses,
					request_id,
					pb::ProtocolErrorCode::PermissionDenied,
					"eval requires authenticated session_id and agent_id principals",
				)
				.await;
				return;
			} else {
				connection.owner.clone()
			};
			let (feed, params) = IncomingParams::channel_for(Some(owner), Some(invocation_id.clone()));
			let lifecycle = Arc::new(NativeLifecycle::default());
			let name = Str::from(request.name);
			let edit_repair = connection
				.supports_edit_repair()
				.then(|| ConnectionEditRepairRoute {
					request_id,
					invocation_id: invocation_id.clone(),
					responses: responses.clone(),
					next_query: Arc::new(AtomicU64::new(1)),
					pending: Arc::new(Mutex::new(None)),
				});
			let edit_repair_context = InvocationEditRepairContext::new(
				edit_repair.as_ref().map(ConnectionEditRepairRoute::client),
				connection.edit_model(),
			);
			let acp = connection.acp_routes(request_id, &invocation_id, responses);
			let acp_context = acp.context();
			let admission = if execution.core_admission {
				AdmissionGate::with_deferred_policy(
					invocation_id.clone(),
					name.clone(),
					deadline,
					approval_policy,
				)
			} else {
				AdmissionGate::with_policy(
					invocation_id.clone(),
					name.clone(),
					deadline,
					approval_policy,
				)
			};
			connection.requests.insert(
				request_id,
				RequestState::Invocation(InvocationState::Native {
					id: invocation_id.clone(),
					feed: feed.clone(),
					lifecycle: Arc::clone(&lifecycle),
					admission,
					pending_commit: None,
					maximum_effects: maximum_effects.clone(),
					execution: execution.clone(),
					request_scope: scope.map(|scope| scope.pty_denied),
					edit_repair,
					acp,
					cancel: cancel.clone(),
				}),
			);
			connection
				.invocation_ids
				.insert(invocation_id.clone(), request_id);
			send_body(
				responses,
				request_id,
				server_frame::Body::InvocationAccepted(pb::InvokeAccepted {
					invocation_id: invocation_id.to_string(),
					props:         Default::default(),
				}),
			)
			.await;

			spawn_native_invocation(
				request_id,
				invocation_id,
				name,
				scope.is_some_and(|scope| scope.pty_denied),
				principal.map(|principal| Str::from(principal.session_id.as_str())),
				edit_repair_context,
				acp_context,
				feed,
				deadline,
				output_request,
				params,
				Arc::clone(&registry),
				lifecycle,
				cancel,
				self.blobs.clone(),
				responses.clone(),
				finished.clone(),
			)
			.await;
		} else if matches!(route, ToolRoute::Worker { .. }) {
			let Some(owner) = self.worker_owner(&request.name, &request.rev) else {
				send_error(
					responses,
					request_id,
					pb::ProtocolErrorCode::NotFound,
					"tool name and revision are not registered to an extension host",
				)
				.await;
				return;
			};
			let name = Str::from(request.name);
			let invocation = match self.ext_hosts.open(ExtHostToolCall {
				invocation_id: invocation_id.clone(),
				name: name.clone(),
				rev: Str::from(request.rev),
				deadline,
			}) {
				Ok(invocation) => invocation,
				Err(error) => {
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::Internal,
						&error.to_string(),
					)
					.await;
					return;
				},
			};
			let (interrupt, interrupts) = flume::unbounded();
			connection.requests.insert(
				request_id,
				RequestState::Invocation(InvocationState::Worker {
					id: invocation_id.clone(),
					owner,
					invocation: Some(invocation),
					committed: false,
					admission: if execution.core_admission {
						AdmissionGate::with_deferred_policy(
							invocation_id.clone(),
							name,
							deadline,
							approval_policy,
						)
					} else {
						AdmissionGate::with_policy(invocation_id.clone(), name, deadline, approval_policy)
					},
					pending_commit: None,
					maximum_effects,
					execution,
					request_scope: scope.map(|scope| scope.pty_denied),
					retention_session: principal
						.map(|principal| Str::from(principal.session_id.as_str())),
					output_request,
					interrupt,
					interrupts: Some(interrupts),
					cancel,
				}),
			);
			connection
				.invocation_ids
				.insert(invocation_id.clone(), request_id);
			send_body(
				responses,
				request_id,
				server_frame::Body::InvocationAccepted(pb::InvokeAccepted {
					invocation_id: invocation_id.to_string(),
					props:         Default::default(),
				}),
			)
			.await;
		} else {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::NotFound,
				unknown_tool_message(&request.name),
			)
			.await;
		}
	}

	async fn commit_invocation(
		&self,
		request_id: u64,
		mut request: pb::ArgsCommitted,
		responses: &flume::Sender<pb::ServerFrame>,
		finished: &flume::Sender<Finished>,
		connection: &mut ConnectionState,
	) {
		let already_committed = match connection.invocation_mut(request_id, &request.invocation_id) {
			Ok(InvocationState::Native { lifecycle, .. }) => lifecycle.is_committed(),
			Ok(InvocationState::Worker { committed, .. }) => *committed,
			Err((code, message)) => {
				send_error(responses, request_id, code, message).await;
				return;
			},
		};
		if already_committed {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::AlreadyExists,
				"ArgsCommitted was already received",
			)
			.await;
			return;
		}

		match connection.invocation_mut(request_id, &request.invocation_id) {
			Ok(
				InvocationState::Native { admission, pending_commit, .. }
				| InvocationState::Worker { admission, pending_commit, .. },
			) if !admission.is_answered() => {
				if pending_commit.is_some() {
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::AlreadyExists,
						"ArgsCommitted was already received",
					)
					.await;
				} else {
					*pending_commit = Some(request);
				}
				return;
			},
			Ok(_) => {},
			Err((code, message)) => {
				send_error(responses, request_id, code, message).await;
				return;
			},
		}

		let (admission, maximum_effects) =
			match connection.invocation_mut(request_id, &request.invocation_id) {
				Ok(
					InvocationState::Native { admission, maximum_effects, .. }
					| InvocationState::Worker { admission, maximum_effects, .. },
				) => (
					admission
						.decide(self.workspace.root(), self.workspace.root())
						.await,
					maximum_effects.clone(),
				),
				Err((code, message)) => {
					send_error(responses, request_id, code, message).await;
					return;
				},
			};
		request.raw = match admission {
			AdmissionDecision::Allowed { raw, bash } => {
				let _effective_bash = bash;
				raw
			},
			AdmissionDecision::Denied(policy) => {
				let invocation_id = Str::from(request.invocation_id.as_str());
				connection.abandon_admission(request_id, &invocation_id);
				send_policy_denied_verdict(responses, request_id, &invocation_id, policy).await;
				return;
			},
		};
		let narrowed_effects = if let Some(effects) =
			effects_narrow_or_refuse(request.effects.as_ref(), &maximum_effects)
		{
			effects
		} else {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::PermissionDenied,
				"ArgsCommitted effect envelope widens the declared tool authority",
			)
			.await;
			return;
		};
		request.effects = Some((&narrowed_effects).into());
		let result = connection.invocation_mut(request_id, &request.invocation_id);
		match result {
			Ok(InvocationState::Native { feed, lifecycle, .. }) => {
				let Ok(raw) = str::from_utf8(&request.raw) else {
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::InvalidArgument,
						"committed arguments are not UTF-8",
					)
					.await;
					return;
				};
				match lifecycle.commit() {
					Ok(()) => {},
					Err(NativeCommitError::AlreadyCommitted) => {
						send_error(
							responses,
							request_id,
							pb::ProtocolErrorCode::AlreadyExists,
							"ArgsCommitted was already received",
						)
						.await;
						return;
					},
					Err(NativeCommitError::Terminal) => {
						send_error(
							responses,
							request_id,
							pb::ProtocolErrorCode::PreconditionFailed,
							"native invocation is already terminal",
						)
						.await;
						return;
					},
				}
				if feed.args_committed(Str::from(raw)).is_err() {
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::Cancelled,
						"invocation input is closed",
					)
					.await;
				}
			},
			Ok(InvocationState::Worker {
				id,
				owner,
				invocation,
				committed,
				cancel,
				interrupts,
				output_request,
				retention_session,
				..
			}) => {
				if *committed {
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::AlreadyExists,
						"ArgsCommitted was already received",
					)
					.await;
					return;
				}
				if request.effect_token.is_empty() || request.authorized_at_ms == 0 {
					send_policy_error(responses, request_id, PolicyError::InvalidEffectToken).await;
					return;
				}
				let Some(worker) = invocation.as_mut() else {
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::PreconditionFailed,
						"worker invocation was already dispatched",
					)
					.await;
					return;
				};
				if let Err(error) = worker.args_committed(request) {
					self.authority.settle(owner, id);
					send_error(
						responses,
						request_id,
						pb::ProtocolErrorCode::PreconditionFailed,
						&error.to_string(),
					)
					.await;
					return;
				}
				*committed = true;
				let Some(invocation) = invocation.take() else {
					return;
				};
				let Some(interrupts) = interrupts.take() else {
					return;
				};
				spawn_worker_invocation(
					request_id,
					id.clone(),
					invocation,
					cancel.clone(),
					interrupts,
					*output_request,
					retention_session.clone(),
					responses.clone(),
					finished.clone(),
					self.blobs.clone(),
				);
			},
			Err((code, message)) => send_error(responses, request_id, code, message).await,
		}
	}

	fn worker_owner(&self, name: &str, rev: &str) -> Option<HostKey> {
		self
			.ext_hosts
			.registrations()
			.iter()
			.find_map(|registration| {
				let declaration = &registration.declaration;
				(declaration.rev == rev
					&& declaration
						.definition
						.as_ref()
						.is_some_and(|definition| definition.name == name))
				.then(|| registration.owner.clone())
			})
	}

	async fn put_chunk(
		&self,
		request_id: u64,
		chunk: blob_pb::Chunk,
		responses: &flume::Sender<pb::ServerFrame>,
		connection: &mut ConnectionState,
	) {
		if let Err(error) = connection.quotas.charge_blob_bytes(chunk.data.len()) {
			send_policy_error(responses, request_id, error).await;
			return;
		}
		connection
			.requests
			.entry(request_id)
			.or_insert_with(|| RequestState::BlobPut(BlobUpload::default()));
		let Some(RequestState::BlobPut(upload)) = connection.requests.get_mut(&request_id) else {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::AlreadyExists,
				"request_id is already open for another operation",
			)
			.await;
			return;
		};
		if upload.chunks != 0 && (!chunk.hash.is_empty() || chunk.size.is_some()) {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				"blob hash and size metadata are legal only on the first chunk",
			)
			.await;
			return;
		}
		if upload.chunks == 0 {
			upload.expected_hash = (!chunk.hash.is_empty()).then_some(chunk.hash);
			upload.expected_size = chunk.size;
		}
		upload.data.extend_from_slice(&chunk.data);
		upload.chunks += 1;
	}

	async fn commit_blob(
		&self,
		request_id: u64,
		responses: &flume::Sender<pb::ServerFrame>,
		connection: &mut ConnectionState,
	) {
		let upload = match connection.requests.remove(&request_id) {
			Some(RequestState::BlobPut(upload)) => upload,
			Some(other) => {
				connection.requests.insert(request_id, other);
				send_error(
					responses,
					request_id,
					pb::ProtocolErrorCode::AlreadyExists,
					"request_id is already open for another operation",
				)
				.await;
				return;
			},
			None => BlobUpload::default(),
		};
		match self.blobs.put_checked(
			&upload.data,
			upload.expected_hash.as_deref(),
			upload.expected_size,
		) {
			Ok(id) => {
				send_body(
					responses,
					request_id,
					server_frame::Body::BlobPut(blob_pb::PutResponse {
						hash: Bytes::copy_from_slice(&id.hash),
						size: id.size,
					}),
				)
				.await;
			},
			Err(error) => send_blob_error(responses, request_id, &error).await,
		}
	}
}

const EDIT_REPAIR_TIMEOUT: Duration = Duration::from_secs(60);

struct PendingEditRepair {
	generation: u64,
	reply:      flume::Sender<Result<Str, omp_tools::edit::observer::EditRepairError>>,
}

#[derive(Clone)]
struct ConnectionEditRepairRoute {
	request_id:    u64,
	invocation_id: Str,
	responses:     flume::Sender<pb::ServerFrame>,
	next_query:    Arc<AtomicU64>,
	pending:       Arc<Mutex<Option<PendingEditRepair>>>,
}

impl ConnectionEditRepairRoute {
	fn client(&self) -> omp_tools::edit::observer::EditRepairClient {
		let route = self.clone();
		omp_tools::edit::observer::EditRepairClient::from_completion(move |prompt| {
			let route = route.clone();
			async move { route.complete(prompt).await }
		})
	}

	async fn complete(
		&self,
		prompt: omp_tools::edit::observer::EditRepairPrompt,
	) -> Result<Str, omp_tools::edit::observer::EditRepairError> {
		use omp_tools::edit::observer::EditRepairError;

		let (reply, response) = flume::bounded(1);
		let generation = self.next_query.fetch_add(1, Ordering::Relaxed);
		{
			let mut pending = self.pending.lock();
			if pending.is_some() {
				return Err(EditRepairError::Unavailable);
			}
			*pending = Some(PendingEditRepair { generation, reply });
		}
		let query = pb::EditRepairQuery {
			invocation_id: self.invocation_id.to_string(),
			prompt:        Some(pb::EditRepairPrompt {
				language:         prompt.language.to_string(),
				before:           prompt.before.to_string(),
				after:            prompt.after.to_string(),
				previous_attempt: prompt.previous_attempt.map(|attempt| attempt.to_string()),
			}),
		};
		if self
			.responses
			.send_async(server_frame(self.request_id, server_frame::Body::EditRepairQuery(query)))
			.await
			.is_err()
		{
			self.disconnect();
			return Err(EditRepairError::Unavailable);
		}
		let result = match time::timeout(EDIT_REPAIR_TIMEOUT, response.recv_async()).await {
			Ok(Ok(result)) => result,
			Ok(Err(_)) | Err(_) => Err(EditRepairError::Unavailable),
		};
		let mut pending = self.pending.lock();
		if pending
			.as_ref()
			.is_some_and(|pending| pending.generation == generation)
		{
			pending.take();
		}
		result
	}

	fn answer(
		&self,
		answer: pb::EditRepairAnswer,
	) -> Result<(), (pb::ProtocolErrorCode, &'static str)> {
		use omp_tools::edit::observer::EditRepairError;

		if answer.invocation_id != self.invocation_id.as_str() {
			return Err((
				pb::ProtocolErrorCode::InvalidArgument,
				"edit repair answer invocation_id does not match the open request",
			));
		}
		let result = match answer.body {
			Some(pb::edit_repair_answer::Body::Content(content)) => Ok(Str::from(content)),
			Some(pb::edit_repair_answer::Body::Failure(failure)) => {
				match pb::EditRepairFailureCode::try_from(failure.code) {
					Ok(pb::EditRepairFailureCode::Unavailable) => Err(EditRepairError::Unavailable),
					Ok(pb::EditRepairFailureCode::Completion) => {
						Err(EditRepairError::Completion { message: Str::from(failure.message) })
					},
					Ok(pb::EditRepairFailureCode::Unspecified) | Err(_) => {
						return Err((
							pb::ProtocolErrorCode::InvalidArgument,
							"edit repair answer failure code is unknown or unspecified",
						));
					},
				}
			},
			None => {
				return Err((
					pb::ProtocolErrorCode::InvalidArgument,
					"edit repair answer body is missing",
				));
			},
		};
		let Some(pending) = self.pending.lock().take() else {
			return Err((
				pb::ProtocolErrorCode::PreconditionFailed,
				"no edit repair query is pending for this invocation",
			));
		};
		pending.reply.send(result).map_err(|_| {
			(pb::ProtocolErrorCode::PreconditionFailed, "edit repair query is no longer pending")
		})
	}

	fn disconnect(&self) {
		if let Some(pending) = self.pending.lock().take() {
			let _ = pending
				.reply
				.send(Err(omp_tools::edit::observer::EditRepairError::Unavailable));
		}
	}
}

const ACP_QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const ACP_MAX_PENDING: usize = 64;

struct ConnectionAcpDocumentRoute {
	request_id:    u64,
	invocation_id: Str,
	responses:     flume::Sender<pb::ServerFrame>,
	next_query:    Arc<AtomicU64>,
	pending:       Arc<Mutex<HashMap<u64, flume::Sender<miette::Result<Str>>>>>,
}

impl ConnectionAcpDocumentRoute {
	async fn query(&self, path: Str, content: Option<Str>) -> miette::Result<Str> {
		let query_id = self.next_query.fetch_add(1, Ordering::Relaxed);
		let (reply, answer) = flume::bounded(1);
		{
			let mut pending = self.pending.lock();
			if pending.len() >= ACP_MAX_PENDING {
				return Err(miette::miette!("too many pending ACP document queries"));
			}
			pending.insert(query_id, reply);
		}
		let body = if let Some(content) = content {
			server_frame::Body::AcpWriteQuery(pb::AcpWriteQuery {
				query_id,
				invocation_id: self.invocation_id.to_string(),
				path: path.to_string(),
				content: content.to_string(),
			})
		} else {
			server_frame::Body::AcpReadQuery(pb::AcpReadQuery {
				query_id,
				invocation_id: self.invocation_id.to_string(),
				path: path.to_string(),
			})
		};
		if self
			.responses
			.send_async(pb::ServerFrame {
				request_id: self.request_id,
				body: Some(body),
				..pb::ServerFrame::default()
			})
			.await
			.is_err()
		{
			self.pending.lock().remove(&query_id);
			return Err(miette::miette!("ACP document connection disconnected"));
		}
		let result = match time::timeout(ACP_QUERY_TIMEOUT, answer.recv_async()).await {
			Ok(Ok(result)) => result,
			Ok(Err(_)) => Err(miette::miette!("ACP document invocation ended")),
			Err(_) => Err(miette::miette!("ACP document query timed out")),
		};
		self.pending.lock().remove(&query_id);
		result
	}

	fn answer(
		&self,
		answer: pb::AcpDocumentAnswer,
	) -> Result<(), (pb::ProtocolErrorCode, &'static str)> {
		if answer.invocation_id.as_str() != self.invocation_id.as_str() {
			return Err((
				pb::ProtocolErrorCode::InvalidArgument,
				"ACP document answer invocation_id does not match the open request",
			));
		}
		let Some(reply) = self.pending.lock().remove(&answer.query_id) else {
			return Err((
				pb::ProtocolErrorCode::PreconditionFailed,
				"ACP document query is not pending",
			));
		};
		let result = match answer.body {
			Some(pb::acp_document_answer::Body::Content(content)) => Ok(Str::from(content)),
			Some(pb::acp_document_answer::Body::Error(error)) => {
				Err(miette::miette!("ACP document error {}: {}", error.code, error.message))
			},
			None => Err(miette::miette!("ACP document answer body is missing")),
		};
		reply.send(result).map_err(|_| {
			(pb::ProtocolErrorCode::PreconditionFailed, "ACP document query is no longer pending")
		})
	}

	fn disconnect(&self) {
		self.pending.lock().clear();
	}
}

impl AcpDocumentBackend for ConnectionAcpDocumentRoute {
	fn read_text(
		&self,
		absolute_path: Str,
	) -> pin::Pin<Box<dyn future::Future<Output = miette::Result<Str>> + Send + '_>> {
		Box::pin(self.query(absolute_path, None))
	}

	fn write_text(
		&self,
		absolute_path: Str,
		content: Str,
	) -> pin::Pin<Box<dyn future::Future<Output = miette::Result<Str>> + Send + '_>> {
		Box::pin(self.query(absolute_path, Some(content)))
	}
}

struct ConnectionAcpExecRoute {
	request_id:    u64,
	invocation_id: Str,
	responses:     flume::Sender<pb::ServerFrame>,
	next_query:    Arc<AtomicU64>,
	pending: Arc<
		Mutex<
			HashMap<u64, flume::Sender<Result<omp_tools::shell::RunEvent, omp_tools::shell::Fault>>>,
		>,
	>,
}

impl ConnectionAcpExecRoute {
	fn event(&self, event: pb::AcpExecEvent) -> Result<(), (pb::ProtocolErrorCode, &'static str)> {
		if event.invocation_id.as_str() != self.invocation_id.as_str() {
			return Err((
				pb::ProtocolErrorCode::InvalidArgument,
				"ACP exec event invocation_id does not match the open request",
			));
		}
		let mut terminal = matches!(
			&event.body,
			Some(pb::acp_exec_event::Body::Exit(_)) | Some(pb::acp_exec_event::Body::Error(_)) | None
		);
		let sender = self
			.pending
			.lock()
			.get(&event.query_id)
			.cloned()
			.ok_or((pb::ProtocolErrorCode::PreconditionFailed, "ACP exec query is not pending"))?;
		let mapped = match event.body {
			Some(pb::acp_exec_event::Body::Started(started)) => {
				super::tool_shell::map_event(ExecEvent::Started { exec_id: started.exec })
			},
			Some(pb::acp_exec_event::Body::Output(output)) => {
				super::tool_shell::map_event(ExecEvent::Output(output))
			},
			Some(pb::acp_exec_event::Body::Exit(exit)) => {
				super::tool_shell::map_event(ExecEvent::Exit(exit))
			},
			Some(pb::acp_exec_event::Body::Error(error)) => Err(omp_tools::shell::Fault::Resource {
				operation: sf!("run"),
				message:   sf!("ACP exec error {}: {}", error.code, error.message),
			}),
			None => Err(omp_tools::shell::Fault::Resource {
				operation: sf!("run"),
				message:   sf!("ACP exec event body is missing"),
			}),
		};
		terminal |= mapped.is_err();
		if terminal {
			self.pending.lock().remove(&event.query_id);
		}
		sender.send(mapped).map_err(|_| {
			(pb::ProtocolErrorCode::PreconditionFailed, "ACP exec receiver is no longer pending")
		})
	}

	fn disconnect(&self) {
		self.pending.lock().clear();
	}
}

impl AcpExecBackend for ConnectionAcpExecRoute {
	fn run(
		&self,
		request: super::tool_shell::AcpExecRequest,
	) -> pin::Pin<
		Box<
			dyn future::Future<Output = Result<super::tool_shell::AcpExecRun, omp_tools::shell::Fault>>
				+ Send
				+ '_,
		>,
	> {
		Box::pin(async move {
			let query_id = self.next_query.fetch_add(1, Ordering::Relaxed);
			let (events, receiver) = flume::bounded(64);
			{
				let mut pending = self.pending.lock();
				if pending.len() >= ACP_MAX_PENDING {
					return Err(omp_tools::shell::Fault::Resource {
						operation: sf!("run"),
						message:   sf!("too many pending ACP exec queries"),
					});
				}
				pending.insert(query_id, events);
			}
			let query = pb::AcpExecQuery {
				query_id,
				invocation_id: self.invocation_id.to_string(),
				command: request.command.to_string(),
				cwd: request.cwd.map_or_else(String::new, |cwd| cwd.to_string()),
				env: request
					.env
					.into_iter()
					.map(|(name, value)| (name.to_string(), value.to_string()))
					.collect(),
				timeout_ms: request.timeout_ms,
			};
			if self
				.responses
				.send_async(pb::ServerFrame {
					request_id: self.request_id,
					body: Some(server_frame::Body::AcpExecQuery(query)),
					..pb::ServerFrame::default()
				})
				.await
				.is_err()
			{
				self.pending.lock().remove(&query_id);
				return Err(omp_tools::shell::Fault::Resource {
					operation: sf!("run"),
					message:   sf!("ACP exec connection disconnected"),
				});
			}
			let cancel = CancellationToken::new();
			let cancel_wait = cancel.clone();
			let responses = self.responses.clone();
			let invocation_id = self.invocation_id.clone();
			let pending = Arc::clone(&self.pending);
			let request_id = self.request_id;
			tokio::spawn(async move {
				cancel_wait.cancelled().await;
				if pending.lock().remove(&query_id).is_some() {
					let _ = responses
						.send_async(pb::ServerFrame {
							request_id,
							body: Some(server_frame::Body::AcpExecCancel(pb::AcpExecCancel {
								query_id,
								invocation_id: invocation_id.to_string(),
							})),
							..pb::ServerFrame::default()
						})
						.await;
				}
			});
			Ok(super::tool_shell::AcpExecRun { events: receiver, cancel })
		})
	}
}

struct InvocationAcpRoutes {
	documents: Option<Arc<ConnectionAcpDocumentRoute>>,
	exec:      Option<Arc<ConnectionAcpExecRoute>>,
}

impl InvocationAcpRoutes {
	fn disconnect(&self) {
		if let Some(route) = &self.documents {
			route.disconnect();
		}
		if let Some(route) = &self.exec {
			route.disconnect();
		}
	}

	fn context(&self) -> super::tools::InvocationAcpBackends {
		super::tools::InvocationAcpBackends::new(
			self
				.documents
				.as_ref()
				.map(|route| Arc::clone(route) as Arc<dyn AcpDocumentBackend>),
			self
				.exec
				.as_ref()
				.map(|route| Arc::clone(route) as Arc<dyn AcpExecBackend>),
		)
	}
}

struct ConnectionState {
	owner:            Str,
	requests:         HashMap<u64, RequestState>,
	invocation_ids:   HashMap<Str, u64>,
	tool_settings:    ToolSettings,
	exec_host:        ExecHost,
	document_leases:  HashMap<Bytes, DocumentLease>,
	grants:           Grants,
	capabilities:     BTreeSet<Str>,
	hello_props:      Option<ValueMap>,
	acp_documents:    bool,
	acp_exec:         bool,
	host:             Option<HostKey>,
	authority:        Arc<AuthorityTable>,
	connection_owner: u64,
	quotas:           QuotaAccount,
	presence:         Option<PresenceLease>,
}

enum RequestState {
	Invocation(InvocationState),
	InvocationFinishing,
	Exec { exec: Bytes, cancel: CancellationToken },
	ProcessAttach { cancel: CancellationToken },
	BlobPut(BlobUpload),
	BlobGet { cancel: CancellationToken },
	DataStream { cancel: CancellationToken },
	DocumentEvents { lease_id: Bytes, cancel: CancellationToken },
	LspEvents { cancel: CancellationToken },
}

enum InvocationState {
	Native {
		id:              Str,
		feed:            omp_tool::InvocationFeed,
		lifecycle:       Arc<NativeLifecycle>,
		admission:       AdmissionGate,
		pending_commit:  Option<pb::ArgsCommitted>,
		maximum_effects: Effects,
		execution:       InvocationExecutionPolicy,
		request_scope:   Option<bool>,
		edit_repair:     Option<ConnectionEditRepairRoute>,
		acp:             InvocationAcpRoutes,
		cancel:          CancellationToken,
	},
	Worker {
		id:                Str,
		owner:             HostKey,
		invocation:        Option<ExtHostInvocation>,
		committed:         bool,
		admission:         AdmissionGate,
		pending_commit:    Option<pb::ArgsCommitted>,
		maximum_effects:   Effects,
		execution:         InvocationExecutionPolicy,
		request_scope:     Option<bool>,
		retention_session: Option<Str>,
		output_request:    omp_tool::OutputRequest,
		interrupt:         flume::Sender<pb::Interrupt>,
		interrupts:        Option<Receiver<pb::Interrupt>>,
		cancel:            CancellationToken,
	},
}

const NATIVE_COMMITTED: u8 = 1;
const NATIVE_TERMINAL: u8 = 2;

#[derive(Default)]
struct NativeLifecycle {
	state: AtomicU8,
}

enum NativeCommitError {
	AlreadyCommitted,
	Terminal,
}

impl NativeLifecycle {
	fn commit(&self) -> Result<(), NativeCommitError> {
		self
			.state
			.try_update(Ordering::AcqRel, Ordering::Acquire, |state| {
				(state & (NATIVE_COMMITTED | NATIVE_TERMINAL) == 0).then_some(state | NATIVE_COMMITTED)
			})
			.map(|_| ())
			.map_err(|state| {
				if state & NATIVE_COMMITTED != 0 {
					NativeCommitError::AlreadyCommitted
				} else {
					NativeCommitError::Terminal
				}
			})
	}

	fn is_committed(&self) -> bool {
		self.state.load(Ordering::Acquire) & NATIVE_COMMITTED != 0
	}

	fn is_terminal(&self) -> bool {
		self.state.load(Ordering::Acquire) & NATIVE_TERMINAL != 0
	}

	fn claim_terminal(&self) -> bool {
		self
			.state
			.try_update(Ordering::AcqRel, Ordering::Acquire, |state| {
				(state & NATIVE_TERMINAL == 0).then_some(state | NATIVE_TERMINAL)
			})
			.is_ok()
	}

	fn claim_precommit_terminal(&self) -> bool {
		self
			.state
			.compare_exchange(0, NATIVE_TERMINAL, Ordering::AcqRel, Ordering::Acquire)
			.is_ok()
	}
}

#[derive(Default)]
struct BlobUpload {
	data:          BytesMut,
	expected_hash: Option<Bytes>,
	expected_size: Option<u64>,
	chunks:        usize,
}

struct Finished {
	request_id:    u64,
	invocation_id: Option<Str>,
}

enum LoopEvent {
	/// Boxes the foreign generated protobuf frame to keep this local event enum
	/// compact.
	Frame(Box<pb::ClientFrame>),
	Finished(Finished),
	/// The env-owned deadline of at least one pending admission elapsed.
	AdmissionDeadline,
}

impl ConnectionState {
	fn new(
		exec_host: ExecHost,
		hello: AcceptedHello,
		base_settings: &ToolSettings,
		authority: Arc<AuthorityTable>,
		policy: &ConnectionPolicy,
	) -> Self {
		let connection_owner = authority.connection_owner();
		let owner = policy.host.as_ref().map_or_else(
			|| sf!("env-connection-{connection_owner}"),
			|host| {
				let [layer, tier, extension] = host.fields();
				sf!("extension:{layer}:{tier}:{extension}")
			},
		);
		let quotas = QuotaAccount::new(Arc::clone(&authority), policy.host.clone());
		let tool_settings = base_settings
			.clone()
			.with_approval_mode_override(hello.approval_mode);
		Self {
			owner,
			requests: HashMap::new(),
			invocation_ids: HashMap::new(),
			tool_settings,
			exec_host,
			document_leases: HashMap::new(),
			grants: hello.grants,
			capabilities: hello.capabilities,
			hello_props: hello.props,
			acp_documents: false,
			acp_exec: false,
			host: policy.host.clone(),
			authority,
			connection_owner,
			quotas,
			presence: None,
		}
	}

	fn next_admission_deadline(&self) -> Option<Instant> {
		self
			.requests
			.values()
			.filter_map(|state| match state {
				RequestState::Invocation(invocation) => invocation.pending_admission_deadline(),
				_ => None,
			})
			.min()
	}

	fn take_expired_admissions(&mut self) -> Vec<(u64, Str, policy_pb::PolicyDenied)> {
		let now = Instant::now();
		self
			.requests
			.iter_mut()
			.filter_map(|(request_id, state)| match state {
				RequestState::Invocation(invocation) => invocation
					.expire_admission(now)
					.map(|denied| (*request_id, Str::from(invocation.id()), denied)),
				_ => None,
			})
			.collect()
	}

	fn grants(&self, capability: &str) -> bool {
		self.grants.contains(capability)
	}

	fn supports_edit_repair(&self) -> bool {
		self.capabilities.contains("edit-repair")
	}

	fn edit_model(&self) -> Option<Str> {
		self
			.hello_props
			.as_ref()?
			.fields
			.get("edit-model")
			.and_then(|value| match value.kind.as_ref() {
				Some(value::Kind::String(model)) if !model.is_empty() => {
					Some(Str::from(model.as_str()))
				},
				_ => None,
			})
	}

	fn bind_acp(&mut self, binding: pb::AcpBind) {
		self.acp_documents = binding.documents;
		self.acp_exec = binding.exec;
	}

	fn acp_routes(
		&self,
		request_id: u64,
		invocation_id: &Str,
		responses: &flume::Sender<pb::ServerFrame>,
	) -> InvocationAcpRoutes {
		let next_query = Arc::new(AtomicU64::new(1));
		InvocationAcpRoutes {
			documents: self.acp_documents.then(|| {
				Arc::new(ConnectionAcpDocumentRoute {
					request_id,
					invocation_id: invocation_id.clone(),
					responses: responses.clone(),
					next_query: Arc::clone(&next_query),
					pending: Arc::new(Mutex::new(HashMap::new())),
				})
			}),
			exec:      self.acp_exec.then(|| {
				Arc::new(ConnectionAcpExecRoute {
					request_id,
					invocation_id: invocation_id.clone(),
					responses: responses.clone(),
					next_query,
					pending: Arc::new(Mutex::new(HashMap::new())),
				})
			}),
		}
	}

	fn answer_acp_document(
		&self,
		request_id: u64,
		answer: pb::AcpDocumentAnswer,
	) -> Result<(), (pb::ProtocolErrorCode, &'static str)> {
		match self.requests.get(&request_id) {
			Some(RequestState::Invocation(InvocationState::Native { id, acp, .. }))
				if id == answer.invocation_id.as_str() =>
			{
				acp.documents
					.as_ref()
					.ok_or((
						pb::ProtocolErrorCode::PreconditionFailed,
						"this invocation has no ACP document route",
					))?
					.answer(answer)
			},
			Some(RequestState::Invocation(InvocationState::Native { .. })) => Err((
				pb::ProtocolErrorCode::InvalidArgument,
				"ACP document answer invocation_id does not match the open request",
			)),
			Some(RequestState::Invocation(_)) => Err((
				pb::ProtocolErrorCode::PreconditionFailed,
				"ACP document answers are only valid for native invocations",
			)),
			Some(_) => Err((
				pb::ProtocolErrorCode::PreconditionFailed,
				"request_id is not an invocation stream",
			)),
			None => Err((pb::ProtocolErrorCode::NotFound, "invocation is not open")),
		}
	}

	fn answer_acp_exec(
		&self,
		request_id: u64,
		event: pb::AcpExecEvent,
	) -> Result<(), (pb::ProtocolErrorCode, &'static str)> {
		match self.requests.get(&request_id) {
			Some(RequestState::Invocation(InvocationState::Native { id, acp, .. }))
				if id == event.invocation_id.as_str() =>
			{
				acp.exec
					.as_ref()
					.ok_or((
						pb::ProtocolErrorCode::PreconditionFailed,
						"this invocation has no ACP exec route",
					))?
					.event(event)
			},
			Some(RequestState::Invocation(InvocationState::Native { .. })) => Err((
				pb::ProtocolErrorCode::InvalidArgument,
				"ACP exec event invocation_id does not match the open request",
			)),
			Some(RequestState::Invocation(_)) => Err((
				pb::ProtocolErrorCode::PreconditionFailed,
				"ACP exec events are only valid for native invocations",
			)),
			Some(_) => Err((
				pb::ProtocolErrorCode::PreconditionFailed,
				"request_id is not an invocation stream",
			)),
			None => Err((pb::ProtocolErrorCode::NotFound, "invocation is not open")),
		}
	}

	fn answer_edit_repair(
		&self,
		request_id: u64,
		answer: pb::EditRepairAnswer,
	) -> Result<(), (pb::ProtocolErrorCode, &'static str)> {
		match self.requests.get(&request_id) {
			Some(RequestState::Invocation(InvocationState::Native {
				id,
				edit_repair: Some(route),
				..
			})) if id == answer.invocation_id.as_str() => route.answer(answer),
			Some(RequestState::Invocation(InvocationState::Native { id, .. }))
				if id != answer.invocation_id.as_str() =>
			{
				Err((
					pb::ProtocolErrorCode::InvalidArgument,
					"edit repair answer invocation_id does not match the open request",
				))
			},
			Some(RequestState::Invocation(InvocationState::Native { .. })) => Err((
				pb::ProtocolErrorCode::PreconditionFailed,
				"this invocation has no edit repair route",
			)),
			Some(RequestState::Invocation(_)) => Err((
				pb::ProtocolErrorCode::PreconditionFailed,
				"edit repair answers are only valid for native invocations",
			)),
			Some(_) => Err((
				pb::ProtocolErrorCode::PreconditionFailed,
				"request_id is not an invocation stream",
			)),
			None => Err((pb::ProtocolErrorCode::NotFound, "invocation is not open")),
		}
	}

	fn invocation_mut(
		&mut self,
		request_id: u64,
		invocation_id: &str,
	) -> Result<&mut InvocationState, (pb::ProtocolErrorCode, &'static str)> {
		match self.requests.get_mut(&request_id) {
			Some(RequestState::Invocation(state)) if state.id() == invocation_id => Ok(state),
			Some(RequestState::Invocation(_)) => Err((
				pb::ProtocolErrorCode::InvalidArgument,
				"invocation_id does not match the open request",
			)),
			Some(_) => Err((
				pb::ProtocolErrorCode::PreconditionFailed,
				"request_id is not an invocation stream",
			)),
			None => Err((pb::ProtocolErrorCode::NotFound, "invocation is not open")),
		}
	}

	fn scope_authenticates(
		&self,
		request_id: u64,
		invocation_id: &str,
		effect_token: &[u8],
		scope: Option<&pb::InvocationScope>,
	) -> Result<bool, (pb::ProtocolErrorCode, &'static str)> {
		let state = match self.requests.get(&request_id) {
			Some(RequestState::Invocation(state)) if state.id() == invocation_id => state,
			Some(RequestState::Invocation(_)) => {
				return Err((
					pb::ProtocolErrorCode::InvalidArgument,
					"invocation_id does not match the open request",
				));
			},
			Some(_) => {
				return Err((
					pb::ProtocolErrorCode::PreconditionFailed,
					"request_id is not an invocation stream",
				));
			},
			None => return Err((pb::ProtocolErrorCode::NotFound, "invocation is not open")),
		};
		let expected = match state {
			InvocationState::Native { request_scope, .. }
			| InvocationState::Worker { request_scope, .. } => *request_scope,
		};
		Ok(match (expected, scope) {
			(None, None) => true,
			(Some(expected), Some(scope)) => {
				scope.invocation_id == invocation_id
					&& !effect_token.is_empty()
					&& scope.effect_token.as_ref() == effect_token
					&& scope.pty_denied == expected
			},
			(None, Some(_)) | (Some(_), None) => false,
		})
	}

	fn plan_denial(
		&self,
		request_id: u64,
		invocation_id: &str,
		raw: &[u8],
	) -> Result<Option<Str>, (pb::ProtocolErrorCode, &'static str)> {
		match self.requests.get(&request_id) {
			Some(RequestState::Invocation(state)) if state.id() == invocation_id => {
				let (execution, maximum_effects) = match state {
					InvocationState::Native { execution, maximum_effects, .. }
					| InvocationState::Worker { execution, maximum_effects, .. } => (execution, maximum_effects),
				};
				Ok(execution.denial(maximum_effects, raw))
			},
			Some(RequestState::Invocation(_)) => Err((
				pb::ProtocolErrorCode::InvalidArgument,
				"invocation_id does not match the open request",
			)),
			Some(_) => Err((
				pb::ProtocolErrorCode::PreconditionFailed,
				"request_id is not an invocation stream",
			)),
			None => Err((pb::ProtocolErrorCode::NotFound, "invocation is not open")),
		}
	}

	/// Removes a denied pre-authorization invocation before its executor sees
	/// finalized arguments.
	fn abandon_admission(&mut self, request_id: u64, invocation_id: &Str) {
		match self.requests.remove(&request_id) {
			Some(RequestState::Invocation(InvocationState::Native {
				lifecycle,
				edit_repair,
				acp,
				cancel,
				..
			})) => {
				if let Some(route) = edit_repair {
					route.disconnect();
				}
				acp.disconnect();
				lifecycle.claim_precommit_terminal();
				cancel.cancel();
			},
			Some(RequestState::Invocation(InvocationState::Worker { owner, id, cancel, .. })) => {
				cancel.cancel();
				self.authority.settle(&owner, &id);
			},
			_ => {},
		}
		self.invocation_ids.remove(invocation_id);
	}

	async fn exec_id(
		&self,
		request_id: u64,
		expected: &[u8],
		responses: &flume::Sender<pb::ServerFrame>,
	) -> Option<Bytes> {
		match self.requests.get(&request_id) {
			Some(RequestState::Exec { exec, .. }) if exec.as_ref() == expected => Some(exec.clone()),
			Some(RequestState::Exec { .. }) => {
				send_error(
					responses,
					request_id,
					pb::ProtocolErrorCode::InvalidArgument,
					"exec id does not match the open request",
				)
				.await;
				None
			},
			Some(_) => {
				send_error(
					responses,
					request_id,
					pb::ProtocolErrorCode::PreconditionFailed,
					"request_id is not an exec stream",
				)
				.await;
				None
			},
			None => {
				send_error(
					responses,
					request_id,
					pb::ProtocolErrorCode::NotFound,
					"execution is not open",
				)
				.await;
				None
			},
		}
	}

	fn finish(&mut self, done: Finished) {
		match self.requests.remove(&done.request_id) {
			Some(RequestState::Invocation(InvocationState::Native { acp, .. })) => {
				acp.disconnect();
			},
			Some(RequestState::Invocation(InvocationState::Worker { owner, id, .. })) => {
				self.authority.settle(&owner, &id);
			},
			Some(RequestState::Exec { .. }) => self.quotas.release_exec(),
			Some(
				RequestState::ProcessAttach { .. }
				| RequestState::BlobGet { .. }
				| RequestState::DataStream { .. }
				| RequestState::DocumentEvents { .. }
				| RequestState::LspEvents { .. },
			) => self.quotas.release_stream(),
			_ => {},
		}
		if let Some(invocation_id) = done.invocation_id {
			self.invocation_ids.remove(&invocation_id);
		}
	}

	async fn cancel(
		&mut self,
		request: pb::CancelRequest,
		exec_host: &ExecHost,
		responses: &flume::Sender<pb::ServerFrame>,
		finished: &flume::Sender<Finished>,
	) {
		use pb::cancel_request::Target;
		match request.target {
			Some(Target::TargetRequestId(request_id)) => {
				if let Some(RequestState::Exec { exec, .. }) = self.requests.get(&request_id) {
					let _ = exec_host.cancel(exec);
				} else {
					self
						.cancel_request(request_id, exec_host, responses, finished)
						.await;
				}
			},
			Some(Target::InvocationId(invocation_id)) => {
				if let Some(request_id) = self.invocation_ids.get(invocation_id.as_str()).copied() {
					self
						.cancel_request(request_id, exec_host, responses, finished)
						.await;
				}
			},
			Some(Target::Exec(exec_id)) => {
				let _ = exec_host.cancel(&exec_id);
			},
			None => {},
		}
	}

	async fn cancel_request(
		&mut self,
		request_id: u64,
		exec_host: &ExecHost,
		responses: &flume::Sender<pb::ServerFrame>,
		finished: &flume::Sender<Finished>,
	) {
		if let Some(RequestState::Invocation(state)) = self.requests.get_mut(&request_id) {
			let terminal = match state {
				InvocationState::Native { id, feed, lifecycle, edit_repair, acp, cancel, .. } => {
					if let Some(route) = edit_repair {
						route.disconnect();
					}
					acp.disconnect();
					if lifecycle.is_committed() {
						let _ = feed.interrupt(Interrupt {
							class:  sf!("cancel"),
							reason: sf!("invocation cancelled by client"),
						});
						cancel.cancel();
						None
					} else if lifecycle.claim_precommit_terminal() {
						cancel.cancel();
						Some((id.clone(), omp_tool::Abort::Skipped {
							reason: sf!("invocation cancelled before argument commitment"),
						}))
					} else {
						cancel.cancel();
						None
					}
				},
				InvocationState::Worker { id, owner, committed, cancel, .. } => {
					cancel.cancel();
					(!*committed).then(|| {
						self.authority.settle(owner, id);
						(id.clone(), omp_tool::Abort::Skipped {
							reason: sf!("invocation cancelled before argument commitment"),
						})
					})
				},
			};
			if terminal.is_some() {
				self
					.requests
					.insert(request_id, RequestState::InvocationFinishing);
			}
			if let Some((invocation_id, abort)) = terminal {
				send_abort_verdict(responses, request_id, &invocation_id, abort).await;
				let _ = finished
					.send_async(Finished { request_id, invocation_id: Some(invocation_id) })
					.await;
			}
			return;
		}
		if matches!(self.requests.get(&request_id), Some(RequestState::InvocationFinishing)) {
			return;
		}

		let Some(state) = self.requests.remove(&request_id) else {
			return;
		};
		match state {
			RequestState::Invocation(_) => unreachable!("invocations were handled without removal"),
			RequestState::InvocationFinishing => {},
			RequestState::Exec { exec, cancel } => {
				let _ = exec_host.cancel(&exec);
				cancel.cancel();
			},
			RequestState::ProcessAttach { cancel }
			| RequestState::BlobGet { cancel }
			| RequestState::DocumentEvents { cancel, .. }
			| RequestState::LspEvents { cancel } => cancel.cancel(),
			RequestState::DataStream { cancel } => {
				cancel.cancel();
				self.quotas.release_stream();
			},
			RequestState::BlobPut(_) => {},
		}
	}

	async fn interrupt(
		&mut self,
		request_id: u64,
		request: pb::Interrupt,
		responses: &flume::Sender<pb::ServerFrame>,
		finished: &flume::Sender<Finished>,
	) {
		let mut settle = None;
		let result = self.invocation_mut(request_id, &request.invocation_id);
		let terminal = match result {
			Ok(InvocationState::Native { id, feed, lifecycle, edit_repair, acp, cancel, .. }) => {
				if let Some(route) = edit_repair {
					route.disconnect();
				}
				acp.disconnect();
				let reason = Str::from(request.reason);
				let _ = feed.interrupt(Interrupt { class: sf!("immediate"), reason: reason.clone() });
				if lifecycle.is_committed() {
					None
				} else if lifecycle.claim_precommit_terminal() {
					cancel.cancel();
					Some((id.clone(), omp_tool::Abort::Interrupted { reason }))
				} else {
					cancel.cancel();
					None
				}
			},
			Ok(InvocationState::Worker { id, owner, committed, cancel, interrupt, .. }) => {
				let reason = Str::from(request.reason.as_str());
				if *committed {
					let _ = interrupt.send(request);
					None
				} else {
					settle = Some((owner.clone(), id.clone()));
					cancel.cancel();
					Some((id.clone(), omp_tool::Abort::Interrupted { reason }))
				}
			},
			Err((code, message)) => {
				send_error(responses, request_id, code, message).await;
				return;
			},
		};
		if let Some((owner, invocation_id)) = settle {
			self.authority.settle(&owner, &invocation_id);
		}
		if terminal.is_some() {
			self
				.requests
				.insert(request_id, RequestState::InvocationFinishing);
		}
		if let Some((invocation_id, abort)) = terminal {
			send_abort_verdict(responses, request_id, &invocation_id, abort).await;
			let _ = finished
				.send_async(Finished { request_id, invocation_id: Some(invocation_id) })
				.await;
		}
	}

	fn cancel_all(&mut self, exec_host: &ExecHost) {
		for (_, state) in mem::take(&mut self.requests) {
			match state {
				RequestState::Invocation(InvocationState::Native {
					feed,
					lifecycle,
					edit_repair,
					acp,
					cancel,
					..
				}) => {
					if let Some(route) = edit_repair {
						route.disconnect();
					}
					acp.disconnect();
					if lifecycle.is_committed() {
						let _ = feed.interrupt(Interrupt {
							class:  sf!("disconnect"),
							reason: sf!("environment connection closed"),
						});
					}
					lifecycle.claim_terminal();
					cancel.cancel();
				},
				RequestState::Invocation(InvocationState::Worker { owner, id, cancel, .. }) => {
					self.authority.settle(&owner, &id);
					cancel.cancel();
				},
				RequestState::InvocationFinishing => {},
				RequestState::Exec { exec, cancel } => {
					let _ = exec_host.cancel(&exec);
					cancel.cancel();
					self.quotas.release_exec();
				},
				RequestState::ProcessAttach { cancel }
				| RequestState::BlobGet { cancel }
				| RequestState::DataStream { cancel }
				| RequestState::DocumentEvents { cancel, .. }
				| RequestState::LspEvents { cancel } => {
					cancel.cancel();
					self.quotas.release_stream();
				},
				RequestState::BlobPut(_) => {},
			}
		}
		self.invocation_ids.clear();
		for lease_id in self.document_leases.keys() {
			self
				.authority
				.release_lease(lease_id, self.connection_owner);
		}
		self.document_leases.clear();
	}
}

impl Drop for ConnectionState {
	fn drop(&mut self) {
		let exec_host = self.exec_host.clone();
		self.cancel_all(&exec_host);
	}
}

impl InvocationState {
	fn id(&self) -> &str {
		match self {
			Self::Native { id, .. } | Self::Worker { id, .. } => id,
		}
	}

	fn pending_admission_deadline(&self) -> Option<Instant> {
		match self {
			Self::Native { admission, .. } | Self::Worker { admission, .. } => {
				admission.pending_deadline()
			},
		}
	}

	fn expire_admission(&mut self, now: Instant) -> Option<policy_pb::PolicyDenied> {
		match self {
			Self::Native { admission, .. } | Self::Worker { admission, .. } => admission.expire(now),
		}
	}
}

async fn reject_duplicate_open(
	connection: &ConnectionState,
	request_id: u64,
	responses: &flume::Sender<pb::ServerFrame>,
) -> bool {
	if connection.requests.contains_key(&request_id) {
		send_error(
			responses,
			request_id,
			pb::ProtocolErrorCode::AlreadyExists,
			"request_id is already open",
		)
		.await;
		true
	} else {
		false
	}
}

enum NativeForward {
	Continue,
	Terminal,
	Backpressure,
}

async fn spawn_native_invocation(
	request_id: u64,
	invocation_id: Str,
	name: Str,
	pty_denied: bool,
	session_id: Option<Str>,
	edit_repair: InvocationEditRepairContext,
	acp: InvocationAcpBackends,
	feed: omp_tool::InvocationFeed,
	deadline: Duration,
	output_request: omp_tool::OutputRequest,
	params: IncomingParams<'static>,
	registry: Arc<Registry>,
	lifecycle: Arc<NativeLifecycle>,
	cancel: CancellationToken,
	blobs: BlobHost,
	responses: flume::Sender<pb::ServerFrame>,
	finished: flume::Sender<Finished>,
) {
	let (started, start) = flume::bounded(1);
	let retention_session = session_id.clone();
	tokio::spawn(with_invocation_scope(
		pty_denied,
		with_output_request_scope(
			output_request,
			with_invocation_session_scope(
				session_id,
				with_edit_repair_scope(
					edit_repair,
					with_acp_scope(acp, async move {
						let result = registry.invoke(&name, params);
						let _ = started.send(());
						match result {
							Ok(mut stream) => {
								let mut deadline = Box::pin(time::sleep(deadline));
								let mut cancel_grace: Option<pin::Pin<Box<Sleep>>> = None;
								let mut timed_out = false;
								let mut grace_expired = false;
								loop {
									if lifecycle.is_terminal() {
										break;
									}
									if let Some(grace) = cancel_grace.as_mut() {
										tokio::select! {
											biased;
											() = grace.as_mut() => {
												grace_expired = true;
												break;
											},
											event = stream.next() => {
												let reason = if timed_out {
													"native invocation ended without reporting timeout truth"
												} else {
													"native invocation ended without reporting cancellation truth"
												};
												if matches!(
													forward_native_event(
														event,
														true,
														reason,
														request_id,
														&invocation_id,
														retention_session.as_deref(),
														&lifecycle,
														output_request,
														&blobs,
														&responses,
													)
													.await,
													NativeForward::Terminal
												) {
													break;
												}
											},
										}
									} else {
										tokio::select! {
											biased;
											() = deadline.as_mut() => {
												let reason = sf!("native invocation deadline exceeded");
												let _ = feed.interrupt(Interrupt {
													class: sf!("deadline"),
													reason: reason.clone(),
												});
												if lifecycle.is_committed() {
													timed_out = true;
													cancel_grace = Some(Box::pin(time::sleep(
														NATIVE_CANCEL_GRACE,
													)));
												} else if lifecycle.claim_precommit_terminal() {
													send_abort_verdict(
														&responses,
														request_id,
														&invocation_id,
														omp_tool::Abort::Interrupted { reason },
													)
													.await;
													break;
												} else {
													break;
												}
											},
											() = cancel.cancelled() => {
												if lifecycle.is_committed() {
													cancel_grace = Some(Box::pin(time::sleep(
														NATIVE_CANCEL_GRACE,
													)));
												} else {
													break;
												}
											},
											event = stream.next() => {
												match forward_native_event(
													event,
													false,
													"",
													request_id,
													&invocation_id,
													retention_session.as_deref(),
													&lifecycle,
													output_request,
													&blobs,
													&responses,
												)
												.await
												{
													NativeForward::Continue => {},
													NativeForward::Terminal => break,
													NativeForward::Backpressure => {
														let _ = feed.interrupt(Interrupt {
															class: sf!("backpressure"),
															reason: sf!(
																"invocation response consumer stopped reading",
															),
														});
														if lifecycle.is_committed() {
															cancel_grace = Some(Box::pin(time::sleep(
																NATIVE_CANCEL_GRACE,
															)));
														} else {
															lifecycle.claim_terminal();
															break;
														}
													},
												}
											},
										}
									}
								}
								if grace_expired && lifecycle.is_committed() && lifecycle.claim_terminal() {
									drop(stream);
									let reason = if timed_out {
										sf!(
											"native invocation exceeded its deadline and did not stop within \
											 grace",
										)
									} else {
										sf!("native invocation did not stop within cancellation grace")
									};
									send_abort_verdict(
										&responses,
										request_id,
										&invocation_id,
										omp_tool::Abort::EffectsUnknown { reason },
									)
									.await;
								}
							},
							Err(error) => {
								if lifecycle.claim_terminal() {
									let _ = send_invocation_error(
										&responses,
										request_id,
										pb::ProtocolErrorCode::NotFound,
										&error.to_string(),
									)
									.await;
								}
							},
						}
						let _ = finished
							.send_async(Finished { request_id, invocation_id: Some(invocation_id) })
							.await;
					}),
				),
			),
		),
	));
	let _ = start.recv_async().await;
}

const DEFAULT_RESULT_PROJECTION_BYTES: usize = 64 * 1024;
const COMPLETE_RESULT_PROJECTION_BYTES: usize = 8 * 1024 * 1024;

fn utf8_projection_prefix(text: &str, maximum: usize) -> usize {
	let mut end = maximum.min(text.len());
	while end > 0 && !text.is_char_boundary(end) {
		end -= 1;
	}
	end
}

fn valid_blob_media_type(media_type: &str) -> bool {
	if media_type.bytes().any(|byte| byte.is_ascii_control()) {
		return false;
	}
	let essence = media_type.split(';').next().unwrap_or_default().trim();
	let Some((kind, subtype)) = essence.split_once('/') else {
		return false;
	};
	!kind.is_empty()
		&& !subtype.is_empty()
		&& !essence.bytes().any(|byte| byte.is_ascii_whitespace())
}

fn project_wire_parts(
	parts: &mut Vec<thread_pb::Part>,
	request: omp_tool::OutputRequest,
) -> (u64, u64, bool) {
	let limit = match request {
		omp_tool::OutputRequest::Bounded => DEFAULT_RESULT_PROJECTION_BYTES,
		omp_tool::OutputRequest::Complete => COMPLETE_RESULT_PROJECTION_BYTES,
	};
	let mut source_bytes = 0_u64;
	let mut inline_bytes = 0_u64;
	let mut remaining = limit;
	let mut omitted = false;
	parts.retain_mut(|part| {
		let original = part.encoded_len();
		source_bytes = source_bytes.saturating_add(u64::try_from(original).unwrap_or(u64::MAX));
		if original <= remaining {
			remaining -= original;
			inline_bytes = inline_bytes.saturating_add(u64::try_from(original).unwrap_or(u64::MAX));
			return true;
		}
		let text = match part.kind.as_mut() {
			Some(thread_pb::part::Kind::Text(text)) => Some(text),
			Some(thread_pb::part::Kind::Thinking(thinking)) => Some(&mut thinking.text),
			_ => None,
		};
		let Some(text) = text else {
			omitted = true;
			return false;
		};
		let overhead = original.saturating_sub(text.len());
		let keep = utf8_projection_prefix(text, remaining.saturating_sub(overhead));
		text.truncate(keep);
		let projected = part.encoded_len();
		omitted = true;
		if projected == 0 || projected > remaining {
			return false;
		}
		remaining -= projected;
		inline_bytes = inline_bytes.saturating_add(u64::try_from(projected).unwrap_or(u64::MAX));
		true
	});
	(source_bytes, inline_bytes, omitted)
}

fn output_projection(
	request: omp_tool::OutputRequest,
	source_bytes: u64,
	inline_bytes: u64,
	omitted: bool,
	artifact: Option<thread_pb::Blob>,
) -> pb::OutputProjection {
	pb::OutputProjection {
		request: match request {
			omp_tool::OutputRequest::Bounded => pb::OutputRequest::Bounded as i32,
			omp_tool::OutputRequest::Complete => pb::OutputRequest::Complete as i32,
		},
		source_bytes,
		inline_bytes,
		omitted,
		artifact,
	}
}

async fn forward_native_event(
	event: Option<Result<ErasedEv, omp_tool::RegistryError>>,
	cancelling: bool,
	fallback_reason: &str,
	request_id: u64,
	invocation_id: &Str,
	retention_session: Option<&str>,
	lifecycle: &NativeLifecycle,
	output_request: omp_tool::OutputRequest,
	blobs: &BlobHost,
	responses: &flume::Sender<pb::ServerFrame>,
) -> NativeForward {
	match event {
		Some(Ok(ErasedEv::Update(_))) if cancelling => NativeForward::Continue,
		Some(Ok(ErasedEv::Update(_))) if lifecycle.is_terminal() => NativeForward::Terminal,
		Some(Ok(ErasedEv::Update(json))) => {
			if send_invocation_body(
				responses,
				request_id,
				server_frame::Body::Update(pb::Update {
					invocation_id: invocation_id.to_string(),
					json,
					props: Default::default(),
				}),
			)
			.await
			{
				NativeForward::Continue
			} else {
				NativeForward::Backpressure
			}
		},
		Some(Ok(ErasedEv::Done(outcome))) => {
			if lifecycle.claim_terminal() {
				let (json, is_error, useless) = erased_outcome_wire(outcome);
				let details_blob =
					match blobs.put_verdict_bytes(retention_session, invocation_id, &json) {
						Ok(reference) => reference,
						Err(error) => {
							tracing::error!(
								%error,
								invocation_id = %invocation_id,
								"could not retain native verdict before publication"
							);
							let _ = send_invocation_error(
								responses,
								request_id,
								pb::ProtocolErrorCode::Internal,
								"native verdict could not be retained",
							)
							.await;
							return NativeForward::Terminal;
						},
					};
				let source_bytes = u64::try_from(json.len()).unwrap_or(u64::MAX);
				let limit = match output_request {
					omp_tool::OutputRequest::Bounded => DEFAULT_RESULT_PROJECTION_BYTES,
					omp_tool::OutputRequest::Complete => COMPLETE_RESULT_PROJECTION_BYTES,
				};
				let omitted = json.len() > limit;
				let inline = if omitted { Bytes::new() } else { json };
				let inline_bytes = u64::try_from(inline.len()).unwrap_or(u64::MAX);
				let projection = output_projection(
					output_request,
					source_bytes,
					inline_bytes,
					omitted,
					Some(details_blob.clone()),
				);
				send_invocation_terminal_body(
					responses,
					request_id,
					server_frame::Body::Verdict(pb::Verdict {
						invocation_id: invocation_id.to_string(),
						json: inline,
						details_blob: Some(details_blob),
						parts: Vec::new(),
						is_error,
						useless,
						terminate: None,
						projection: Some(projection),
						props: Default::default(),
					}),
				)
				.await;
			}
			NativeForward::Terminal
		},
		Some(Err(error)) if !cancelling => {
			if lifecycle.claim_terminal() {
				let _ = send_invocation_error(
					responses,
					request_id,
					pb::ProtocolErrorCode::Internal,
					&error.to_string(),
				)
				.await;
			}
			NativeForward::Terminal
		},
		None if !cancelling => {
			if lifecycle.claim_terminal() {
				let _ = send_invocation_stream_error(
					responses,
					request_id,
					invocation_id,
					"tool event stream closed without a terminal verdict",
				)
				.await;
			}
			NativeForward::Terminal
		},
		Some(Err(_)) | None => {
			if lifecycle.is_committed() && lifecycle.claim_terminal() {
				send_abort_verdict(
					responses,
					request_id,
					invocation_id,
					omp_tool::Abort::EffectsUnknown { reason: Str::from(fallback_reason) },
				)
				.await;
			}
			NativeForward::Terminal
		},
	}
}

fn spawn_worker_invocation(
	request_id: u64,
	invocation_id: Str,
	mut invocation: ExtHostInvocation,
	cancel: CancellationToken,
	interrupts: Receiver<pb::Interrupt>,
	output_request: omp_tool::OutputRequest,
	retention_session: Option<Str>,
	responses: flume::Sender<pb::ServerFrame>,
	finished: flume::Sender<Finished>,
	blobs: BlobHost,
) {
	tokio::spawn(async move {
		let mut cancel_requested = false;
		loop {
			let event = if cancel_requested {
				invocation.next().await.ok()
			} else {
				tokio::select! {
					biased;
					() = cancel.cancelled() => {
						invocation.cancel("environment invocation cancelled");
						cancel_requested = true;
						continue;
					},
					frame = interrupts.recv_async() => {
						if let Ok(frame) = frame {
							let _ = invocation.interrupt(frame);
						}
						continue;
					},
					event = invocation.next() => event.ok(),
				}
			};
			match event {
				Some(ExtHostEvent::Update(_)) if cancel_requested => {},
				Some(ExtHostEvent::Update(update)) => {
					if !send_invocation_body(
						&responses,
						request_id,
						server_frame::Body::Update(pb::Update {
							invocation_id: invocation_id.to_string(),
							json:          update.json,
							props:         Default::default(),
						}),
					)
					.await
					{
						invocation.cancel("invocation response consumer stopped reading");
						cancel_requested = true;
					}
				},
				Some(ExtHostEvent::ProtocolError(error)) => {
					let _ = send_invocation_error(
						&responses,
						request_id,
						pb::ProtocolErrorCode::Internal,
						&error.message,
					)
					.await;
					break;
				},
				Some(ExtHostEvent::Complete(complete)) => {
					let (json, details_blob, is_error) =
						match projected_worker_completion_json(&blobs, &complete, output_request) {
							Ok(completion) => completion,
							Err(reason) => {
								send_abort_verdict(
									&responses,
									request_id,
									&invocation_id,
									omp_tool::Abort::EffectsUnknown { reason },
								)
								.await;
								break;
							},
						};
					if let Some(details) = details_blob.as_ref() {
						let hash: [u8; 32] = match details.hash.as_ref().try_into() {
							Ok(hash) => hash,
							Err(_) => {
								send_abort_verdict(
									&responses,
									request_id,
									&invocation_id,
									omp_tool::Abort::EffectsUnknown {
										reason: sf!("worker verdict CAS returned an invalid hash"),
									},
								)
								.await;
								break;
							},
						};
						if let Err(error) = blobs.retain_verdict(
							retention_session.as_deref(),
							invocation_id.as_str(),
							BlobId { hash, size: details.size },
						) {
							tracing::error!(
								%error,
								invocation_id = %invocation_id,
								"could not durably retain worker verdict before publication"
							);
							send_abort_verdict(
								&responses,
								request_id,
								&invocation_id,
								omp_tool::Abort::EffectsUnknown {
									reason: sf!("worker verdict could not be retained"),
								},
							)
							.await;
							break;
						}
					}
					let mut retained_media = BTreeSet::new();
					let mut invalid_media = false;
					for blob in complete
						.parts
						.iter()
						.filter_map(|part| match part.kind.as_ref() {
							Some(thread_pb::part::Kind::Blob(blob)) => Some(blob),
							_ => None,
						}) {
						if !valid_blob_media_type(&blob.mime) {
							invalid_media = true;
							break;
						}
						if !blob.inline.is_empty() {
							let size = u64::try_from(blob.inline.len()).unwrap_or(u64::MAX);
							if size != blob.size
								|| (!blob.hash.is_empty()
									&& blob.hash.as_ref() != Hash32::sum(&blob.inline).as_bytes())
							{
								invalid_media = true;
								break;
							}
							continue;
						}
						let Ok(hash) = <[u8; 32]>::try_from(blob.hash.as_ref()) else {
							invalid_media = true;
							break;
						};
						if retained_media.insert((hash, blob.size))
							&& let Err(error) = blobs.retain_verdict_blob(
								retention_session.as_deref(),
								invocation_id.as_str(),
								BlobId { hash, size: blob.size },
							) {
							tracing::error!(
								%error,
								invocation_id = %invocation_id,
								"could not durably retain worker media before publication"
							);
							invalid_media = true;
							break;
						}
					}
					if invalid_media {
						send_abort_verdict(
							&responses,
							request_id,
							&invocation_id,
							omp_tool::Abort::EffectsUnknown {
								reason: sf!("worker verdict media is invalid or unavailable"),
							},
						)
						.await;
						break;
					}
					let mut parts = complete.parts;
					let _ = project_wire_parts(&mut parts, output_request);
					let source_bytes = details_blob.as_ref().map_or_else(
						|| u64::try_from(json.len()).unwrap_or(u64::MAX),
						|details| details.size,
					);
					let inline_bytes = u64::try_from(json.len()).unwrap_or(u64::MAX);
					let projection = output_projection(
						output_request,
						source_bytes,
						inline_bytes,
						inline_bytes != source_bytes,
						details_blob.clone(),
					);
					send_invocation_terminal_body(
						&responses,
						request_id,
						server_frame::Body::Verdict(pb::Verdict {
							invocation_id: invocation_id.to_string(),
							json,
							parts,
							details_blob,
							is_error,
							useless: complete.useless,
							terminate: complete.terminate.then_some(true),
							projection: Some(projection),
							props: Default::default(),
						}),
					)
					.await;
					break;
				},
				Some(ExtHostEvent::Aborted(abort)) => {
					let reason = if cancel_requested {
						sf!("environment invocation cancelled")
					} else {
						abort.reason
					};
					let reason = if abort.effects_unknown {
						omp_tool::Abort::EffectsUnknown { reason }
					} else {
						omp_tool::Abort::Skipped { reason }
					};
					send_abort_verdict(&responses, request_id, &invocation_id, reason).await;
					break;
				},
				None => {
					let reason = if cancel_requested {
						sf!("environment invocation cancelled")
					} else {
						sf!("extension host event stream closed after effects authorization")
					};
					send_abort_verdict(
						&responses,
						request_id,
						&invocation_id,
						omp_tool::Abort::EffectsUnknown { reason },
					)
					.await;
					break;
				},
			}
		}
		let _ = finished
			.send_async(Finished { request_id, invocation_id: Some(invocation_id) })
			.await;
	});
}

async fn send_abort_verdict(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	invocation_id: &Str,
	abort: omp_tool::Abort,
) {
	let verdict = CallOutcome::<serde_json::Value, serde_json::Value>::aborted(abort);
	let Ok(json) = serde_json::to_vec(&verdict) else {
		let _ = send_invocation_stream_error(
			responses,
			request_id,
			invocation_id,
			"failed to serialize invocation abort verdict",
		)
		.await;
		return;
	};
	send_invocation_terminal_body(
		responses,
		request_id,
		server_frame::Body::Verdict(pb::Verdict {
			invocation_id: invocation_id.to_string(),
			json:          Bytes::from(json),
			details_blob:  None,
			parts:         Vec::new(),
			is_error:      true,
			useless:       false,
			terminate:     None,
			projection:    None,
			props:         Default::default(),
		}),
	)
	.await;
}

async fn send_policy_denied_verdict(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	invocation_id: &Str,
	denied: policy_pb::PolicyDenied,
) {
	tracing::warn!(
		request_id,
		invocation_id = %invocation_id,
		code = %denied.code,
		rules = denied.rules.len(),
		"environment admission denied",
	);
	let reason = Str::from(denied.reason);
	let policy = omp_tool::PolicyDenied {
		reason:      reason.clone(),
		code:        (!denied.code.is_empty()).then(|| Str::from(denied.code)),
		decision_id: Str::from(denied.decision_id),
		rules:       Arc::from(
			denied
				.rules
				.into_iter()
				.map(|rule| Str::from(rule.as_str()))
				.collect::<Vec<_>>(),
		),
	};
	let verdict = CallOutcome::<serde_json::Value, serde_json::Value>::policy_denied(
		omp_tool::Abort::Skipped { reason },
		policy,
	);
	let Ok(json) = serde_json::to_vec(&verdict) else {
		let _ = send_invocation_stream_error(
			responses,
			request_id,
			invocation_id,
			"failed to serialize policy denial verdict",
		)
		.await;
		return;
	};
	send_invocation_terminal_body(
		responses,
		request_id,
		server_frame::Body::Verdict(pb::Verdict {
			invocation_id: invocation_id.to_string(),
			json:          Bytes::from(json),
			details_blob:  None,
			parts:         Vec::new(),
			is_error:      true,
			useless:       false,
			terminate:     None,
			projection:    None,
			props:         Default::default(),
		}),
	)
	.await;
}

async fn send_invocation_error(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	code: pb::ProtocolErrorCode,
	message: &str,
) -> bool {
	let body = server_frame::Body::Error(pb::ProtocolError {
		code:    code as i32,
		message: message.to_owned(),
		props:   Default::default(),
	});
	send_invocation_terminal_body(responses, request_id, body).await;
	true
}

async fn send_invocation_stream_error(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	invocation_id: &str,
	message: &str,
) -> bool {
	let body = server_frame::Body::EventStreamError(pb::EventStreamError {
		stream:         pb::EventStreamKind::Invocation as i32,
		failure:        pb::EventStreamFailure::Closed as i32,
		invocation_id:  invocation_id.to_owned(),
		exec:           Bytes::new(),
		process_name:   String::new(),
		skipped_events: 0,
		message:        message.to_owned(),
		props:          Default::default(),
	});
	send_invocation_terminal_body(responses, request_id, body).await;
	true
}

fn spawn_exec(
	request_id: u64,
	run: ExecRun,
	cancel: CancellationToken,
	responses: flume::Sender<pb::ServerFrame>,
	finished: flume::Sender<Finished>,
) {
	tokio::spawn(async move {
		let exec = Bytes::copy_from_slice(run.id());
		let mut terminal = false;
		loop {
			let event = tokio::select! {
				() = cancel.cancelled() => break,
				event = run.next_event() => event,
			};
			match event {
				Some(ExecEvent::Started { .. }) => {},
				Some(ExecEvent::Output(output)) => {
					send_body(&responses, request_id, server_frame::Body::Output(output)).await;
				},
				Some(ExecEvent::Exit(exit)) => {
					terminal = true;
					send_body(&responses, request_id, server_frame::Body::Exit(exit)).await;
					break;
				},
				None => break,
			}
		}
		if !terminal && !cancel.is_cancelled() {
			send_stream_error(
				&responses,
				request_id,
				pb::EventStreamKind::Exec,
				"",
				&exec,
				"",
				"exec event stream closed without ExitEvent",
			)
			.await;
		}
		let _ = finished
			.send_async(Finished { request_id, invocation_id: None })
			.await;
	});
}

fn spawn_process_attachment(
	request_id: u64,
	process_name: Str,
	events: Receiver<ProcessEvent>,
	cancel: CancellationToken,
	responses: flume::Sender<pb::ServerFrame>,
	finished: flume::Sender<Finished>,
) {
	tokio::spawn(async move {
		loop {
			let event = tokio::select! {
				() = cancel.cancelled() => break,
				event = events.recv_async() => event.ok(),
			};
			match event {
				Some(ProcessEvent::Output(output)) => {
					send_body(&responses, request_id, server_frame::Body::ProcessOutput(output)).await;
				},
				Some(ProcessEvent::State(process)) => {
					send_body(
						&responses,
						request_id,
						server_frame::Body::ProcessState(pb::ProcessStateEvent {
							process: Some(process),
							props:   Default::default(),
						}),
					)
					.await;
				},
				None => {
					send_stream_error(
						&responses,
						request_id,
						pb::EventStreamKind::ProcessOutput,
						"",
						&[],
						&process_name,
						"named-process output stream closed",
					)
					.await;
					break;
				},
			}
		}
		let _ = finished
			.send_async(Finished { request_id, invocation_id: None })
			.await;
	});
}

struct WorkspaceSearchOwned {
	pattern: Str,
	case:    WorkspaceSearchCase,
	limit:   Option<u64>,
}

async fn parse_mounted_resource_uri<'a>(
	input: &'a str,
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
) -> Option<ParsedUri<'a>> {
	if input.len() > MAX_RESOURCE_URI_BYTES {
		send_error(
			responses,
			request_id,
			pb::ProtocolErrorCode::InvalidArgument,
			"resource URI exceeds the 8192-byte limit",
		)
		.await;
		return None;
	}
	match selector::parse_uri(input) {
		Ok(Some(uri))
			if !matches!(
				uri.scheme,
				omp_tools::read::resolver::Scheme::Unknown
					| omp_tools::read::resolver::Scheme::File
					| omp_tools::read::resolver::Scheme::Http
			) =>
		{
			Some(uri)
		},
		Ok(Some(_)) => {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::Unsupported,
				"resource URI scheme is not mounted on the internal resource plane",
			)
			.await;
			None
		},
		Ok(None) => {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				"resource URI must use hierarchical scheme:// syntax",
			)
			.await;
			None
		},
		Err(error) => {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				&error.to_string(),
			)
			.await;
			None
		},
	}
}

fn resource_bound(value: u64, ceiling: usize, name: &'static str) -> Result<usize, &'static str> {
	let Ok(value) = usize::try_from(value) else {
		return Err("resource operation bound does not fit this host");
	};
	if value == 0 {
		return Err(match name {
			"resource read max_bytes" => "resource read max_bytes must be nonzero",
			"resource list max_entries" => "resource list max_entries must be nonzero",
			"resource list max_bytes" => "resource list max_bytes must be nonzero",
			"resource completion max_results" => "resource completion max_results must be nonzero",
			_ => "resource operation bound must be nonzero",
		});
	}
	if value > ceiling {
		return Err(match name {
			"resource read max_bytes" => "resource read max_bytes exceeds the 8 MiB ceiling",
			"resource list max_entries" => "resource list max_entries exceeds the 4096-entry ceiling",
			"resource list max_bytes" => "resource list max_bytes exceeds the 2 MiB ceiling",
			"resource completion max_results" => {
				"resource completion max_results exceeds the 100-result ceiling"
			},
			_ => "resource operation bound exceeds its Environment ceiling",
		});
	}
	Ok(value)
}

fn resource_capability_wire(capability: ResourceCapability) -> pb::ResourceCapability {
	pb::ResourceCapability {
		scheme:      capability.scheme.to_owned(),
		read:        capability.read,
		list:        capability.list,
		path:        capability.path,
		complete:    capability.complete,
		device_hash: Bytes::copy_from_slice(&capability.stamp.device_hash),
		revision:    capability.stamp.revision,
	}
}

async fn send_resource_result(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	result: pb::ResourceResult,
) {
	send_data_response(
		responses,
		request_id,
		data_response::Body::Resource(pb::ResourceOpResult { result: Some(result) }),
	)
	.await;
}

async fn send_resource_fault(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	fault: &read::Fault,
) {
	let code = match fault {
		read::Fault::Invalid { .. } => pb::ProtocolErrorCode::InvalidArgument,
		read::Fault::UnknownScheme { .. }
		| read::Fault::SchemeNotReadable { .. }
		| read::Fault::Unsupported { .. } => pb::ProtocolErrorCode::Unsupported,
		read::Fault::Source { .. } => pb::ProtocolErrorCode::NotFound,
		read::Fault::Web { .. } | read::Fault::Blob { .. } => pb::ProtocolErrorCode::Internal,
	};
	send_error(responses, request_id, code, fault.message()).await;
}

async fn send_resource_capability_error(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	operation: &str,
) {
	send_error(
		responses,
		request_id,
		pb::ProtocolErrorCode::Unsupported,
		&format!("mounted resource does not support {operation}"),
	)
	.await;
}

const fn mcp_operation(request: &pb::McpOp) -> &'static str {
	use mcp_op::Op;

	match request.op.as_ref() {
		Some(Op::Status(_)) => "omp.env.mcp.status",
		Some(Op::Subscribe(_)) => "omp.env.mcp.subscribe",
		Some(Op::Reset(_)) => "omp.env.mcp.reset",
		Some(Op::LiveHeader(_)) => "omp.env.mcp.live-header",
		Some(Op::Resource(_)) => "omp.env.mcp.resource",
		Some(Op::Prompt(_)) => "omp.env.mcp.prompt",
		Some(Op::Invoke(_)) => "omp.env.mcp.invoke",
		Some(Op::Config(_)) => "omp.env.mcp.config",
		None => "omp.env.mcp.invalid",
	}
}

const fn mcp_wire_revision(operation: &mcp_op::Op) -> u32 {
	use mcp_op::Op;

	match operation {
		Op::Status(request) => request.wire_revision,
		Op::Subscribe(request) => request.wire_revision,
		Op::Reset(request) => request.wire_revision,
		Op::LiveHeader(request) => request.wire_revision,
		Op::Resource(request) => request.wire_revision,
		Op::Prompt(request) => request.wire_revision,
		Op::Invoke(request) => request.wire_revision,
		Op::Config(request) => request.wire_revision,
	}
}

fn spawn_mcp_request(
	request_id: u64,
	service: Arc<McpService>,
	operation: mcp_op::Op,
	cancel: CancellationToken,
	responses: flume::Sender<pb::ServerFrame>,
	finished: flume::Sender<Finished>,
) {
	tokio::spawn(async move {
		use pb::{mcp_op::Op, mcp_result::Result as McpResult};
		let result = match operation {
			Op::Reset(request) => service
				.reset(request, cancel.clone())
				.await
				.map(McpResult::Reset),
			Op::LiveHeader(request) => service
				.live_header(request, cancel.clone())
				.await
				.map(McpResult::LiveHeader),
			Op::Resource(request) => service
				.resource(request, cancel.clone())
				.await
				.map(McpResult::Resource),
			Op::Prompt(request) => service
				.prompt(request, cancel.clone())
				.await
				.map(McpResult::Prompt),
			Op::Invoke(request) => service
				.invoke(request, cancel.clone())
				.await
				.map(McpResult::Invoke),
			Op::Config(request) => service.config(request).await.map(McpResult::Config),
			Op::Status(_) | Op::Subscribe(_) => Err(McpServiceError::InvalidRequest),
		};
		if !cancel.is_cancelled() {
			match result {
				Ok(result) => {
					send_data_response(
						&responses,
						request_id,
						data_response::Body::Mcp(pb::McpResult { result: Some(result) }),
					)
					.await;
				},
				Err(error) => send_mcp_error(&responses, request_id, &error).await,
			}
		}
		let _ = finished
			.send_async(Finished { request_id, invocation_id: None })
			.await;
	});
}

fn spawn_mcp_subscription(
	request_id: u64,
	subscription: ServiceSubscription,
	cancel: CancellationToken,
	responses: flume::Sender<pb::ServerFrame>,
	finished: flume::Sender<Finished>,
) {
	tokio::spawn(async move {
		loop {
			match subscription.next(&cancel).await {
				Ok(Some(SubscriptionEvent::Notification(notification))) => {
					if !send_data_event_sync(
						&responses,
						request_id,
						data_event::Body::McpNotification(notification),
					) {
						break;
					}
				},
				Ok(Some(SubscriptionEvent::Status(status))) => {
					if !send_data_event_sync(&responses, request_id, data_event::Body::McpStatus(status))
					{
						break;
					}
				},
				Err(McpServiceError::Cancelled) => break,
				Ok(None) | Err(_) => {
					let _ = responses
						.send_async(server_frame(
							request_id,
							server_frame::Body::EventStreamError(pb::EventStreamError {
								stream:         pb::EventStreamKind::McpNotification.into(),
								failure:        pb::EventStreamFailure::Synchronization.into(),
								invocation_id:  String::new(),
								exec:           Bytes::new(),
								process_name:   String::new(),
								skipped_events: 0,
								message:        "MCP notification continuity was lost".to_owned(),
								props:          Default::default(),
							}),
						))
						.await;
					break;
				},
			}
		}
		let _ = finished
			.send_async(Finished { request_id, invocation_id: None })
			.await;
	});
}

async fn send_mcp_error(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	error: &McpServiceError,
) {
	use super::mcp::McpServiceError;
	let code = match error {
		McpServiceError::InvalidRequest => pb::ProtocolErrorCode::InvalidArgument,
		McpServiceError::Config(error) => match error {
			super::mcp::config_store::ConfigStoreError::Io { .. }
			| super::mcp::config_store::ConfigStoreError::NoParent { .. }
			| super::mcp::config_store::ConfigStoreError::LockTimeout { .. } => {
				pb::ProtocolErrorCode::Internal
			},
			super::mcp::config_store::ConfigStoreError::Json { .. }
			| super::mcp::config_store::ConfigStoreError::Validation { .. }
			| super::mcp::config_store::ConfigStoreError::AlreadyExists { .. }
			| super::mcp::config_store::ConfigStoreError::NotFound { .. } => {
				pb::ProtocolErrorCode::InvalidArgument
			},
		},
		McpServiceError::ServerNotFound => pb::ProtocolErrorCode::NotFound,
		McpServiceError::StaleDefinitionEpoch { .. }
		| McpServiceError::StaleGeneration
		| McpServiceError::StaleSequence
		| McpServiceError::LeafReplacement(_) => pb::ProtocolErrorCode::PreconditionFailed,
		McpServiceError::ContinuityLost => pb::ProtocolErrorCode::PreconditionFailed,
		McpServiceError::Cancelled => pb::ProtocolErrorCode::Cancelled,
		McpServiceError::EpochExhausted | McpServiceError::Backend => pb::ProtocolErrorCode::Internal,
	};
	send_error(responses, request_id, code, &error.to_string()).await;
}

fn spawn_resource_completion(
	request_id: u64,
	input: String,
	max_results: usize,
	resources: Arc<ResolverTable<UrlResolver>>,
	cancel: CancellationToken,
	responses: flume::Sender<pb::ServerFrame>,
	finished: flume::Sender<Finished>,
) {
	tokio::spawn(async move {
		use omp_proto::env::v1::{ResourceCapability, ResourceCompletion};
		let result = tokio::select! {
			() = cancel.cancelled() => None,
			result = resource_completions(&resources, &input, max_results) => Some(result),
		};
		if let Some(result) = result {
			match result {
				Ok((completions, truncated)) => {
					let mut emitted = 0u32;
					for (completion, capability) in completions {
						if cancel.is_cancelled() {
							break;
						}
						let event = checked_server_frame(
							request_id,
							server_frame::Body::DataEvent(pb::DataEvent {
								body:  Some(data_event::Body::ResourceCompletion(ResourceCompletion {
									value:       completion.value.to_string(),
									description: completion.description.to_string(),
									capability:  Some(ResourceCapability {
										scheme:      capability.scheme.to_owned(),
										read:        capability.read,
										list:        capability.list,
										path:        capability.path,
										complete:    capability.complete,
										device_hash: Bytes::copy_from_slice(&capability.stamp.device_hash),
										revision:    capability.stamp.revision,
									}),
									score:       completion.score,
								})),
								props: Default::default(),
							}),
						);
						if responses.send_async(event).await.is_err() {
							break;
						}
						emitted = emitted.saturating_add(1);
					}
					if !cancel.is_cancelled() {
						let terminal = checked_server_frame(
							request_id,
							server_frame::Body::DataEvent(pb::DataEvent {
								body:  Some(data_event::Body::ResourceCompletionComplete(
									pb::ResourceCompletionComplete {
										emitted,
										truncated,
										catalog_revision: resources.revision(),
									},
								)),
								props: Default::default(),
							}),
						);
						let _ = responses.send_async(terminal).await;
					}
				},
				Err(message) => {
					let _ = responses
						.send_async(server_frame(
							request_id,
							server_frame::Body::EventStreamError(pb::EventStreamError {
								stream: pb::EventStreamKind::ResourceCompletion.into(),
								failure: pb::EventStreamFailure::Closed.into(),
								invocation_id: String::new(),
								exec: Bytes::new(),
								process_name: String::new(),
								skipped_events: 0,
								message,
								props: Default::default(),
							}),
						))
						.await;
				},
			}
		}
		let _ = finished
			.send_async(Finished { request_id, invocation_id: None })
			.await;
	});
}

async fn resource_completions(
	resources: &ResolverTable<UrlResolver>,
	input: &str,
	max_results: usize,
) -> Result<(Vec<(ResourceCompletion, ResourceCapability)>, bool), String> {
	use omp_tools::read::resolver::fuzzy_score;

	if let Some((raw_scheme, query)) = input.split_once("://") {
		let scheme = resolver::Scheme::parse(raw_scheme);
		if scheme == resolver::Scheme::Unknown {
			return Err(format!("resource completion scheme is not mounted: {raw_scheme}"));
		}
		let capability = resources
			.capability(scheme)
			.filter(|capability| capability.complete)
			.ok_or_else(|| format!("{raw_scheme}:// does not support completion"))?;
		let (matches, truncated) = resources
			.complete(scheme, query, max_results)
			.await
			.ok_or_else(|| format!("{raw_scheme}:// does not support completion"))?
			.map_err(|fault| fault.message().to_string())?;
		return Ok((
			matches
				.into_iter()
				.map(|completion| (completion, capability.clone()))
				.collect(),
			truncated,
		));
	}

	let mut matches = resources
		.capabilities()
		.filter_map(|capability| {
			let score = fuzzy_score(input.trim_end_matches(':'), capability.scheme)?;
			Some((
				ResourceCompletion {
					value: Str::new(format!("{}://", capability.scheme)),
					description: capability.description.clone(),
					score,
				},
				capability,
			))
		})
		.collect::<Vec<_>>();
	matches.sort_unstable_by(|(left, _), (right, _)| {
		right
			.score
			.cmp(&left.score)
			.then_with(|| left.value.cmp(&right.value))
	});
	let truncated = matches.len() > max_results;
	matches.truncate(max_results);
	Ok((matches, truncated))
}

fn spawn_document_events(
	request_id: u64,
	events: DocumentEvents,
	cancel: CancellationToken,
	responses: flume::Sender<pb::ServerFrame>,
	finished: flume::Sender<Finished>,
) {
	tokio::spawn(async move {
		loop {
			let event = tokio::select! {
				() = cancel.cancelled() => break,
				event = events.next_event() => event,
			};
			match event {
				Ok(event) => {
					if responses
						.send_async(server_frame(
							request_id,
							server_frame::Body::DataEvent(pb::DataEvent {
								body:  Some(data_event::Body::Document(event)),
								props: Default::default(),
							}),
						))
						.await
						.is_err()
					{
						break;
					}
				},
				Err(error) => {
					let _ = responses
						.send_async(server_frame(
							request_id,
							server_frame::Body::EventStreamError(pb::EventStreamError {
								stream:         pb::EventStreamKind::Document.into(),
								failure:        error.failure.into(),
								invocation_id:  String::new(),
								exec:           Bytes::new(),
								process_name:   String::new(),
								skipped_events: error.skipped_events,
								message:        error.message.to_string(),
								props:          Default::default(),
							}),
						))
						.await;
					break;
				},
			}
		}
		let _ = finished
			.send_async(Finished { request_id, invocation_id: None })
			.await;
	});
}

fn spawn_lsp_events(
	request_id: u64,
	events: LspEvents,
	cancel: CancellationToken,
	responses: flume::Sender<pb::ServerFrame>,
	finished: flume::Sender<Finished>,
) {
	tokio::spawn(async move {
		loop {
			let event = tokio::select! {
				() = cancel.cancelled() => break,
				event = events.next_event() => event,
			};
			match event {
				Ok(event) => {
					let body = match event {
						LspRegistryEvent::Event(event) => data_event::Body::Lsp(event),
						LspRegistryEvent::Binding(event) => data_event::Body::LspBinding(event),
					};
					if responses
						.send_async(server_frame(
							request_id,
							server_frame::Body::DataEvent(pb::DataEvent {
								body:  Some(body),
								props: Default::default(),
							}),
						))
						.await
						.is_err()
					{
						break;
					}
				},
				Err(error) => {
					let _ = responses
						.send_async(server_frame(
							request_id,
							server_frame::Body::EventStreamError(pb::EventStreamError {
								stream:         pb::EventStreamKind::LspRegistry.into(),
								failure:        error.failure.into(),
								invocation_id:  String::new(),
								exec:           Bytes::new(),
								process_name:   String::new(),
								skipped_events: error.skipped_events,
								message:        error.message.to_string(),
								props:          Default::default(),
							}),
						))
						.await;
					break;
				},
			}
		}
		let _ = finished
			.send_async(Finished { request_id, invocation_id: None })
			.await;
	});
}

fn spawn_workspace_walk(
	request_id: u64,
	workspace: WorkspaceHost,
	request: WalkRequest,
	cancel: CancellationToken,
	responses: flume::Sender<pb::ServerFrame>,
	finished: flume::Sender<Finished>,
) {
	task::spawn_blocking(move || {
		let mut emitted = 0_u64;
		let result = workspace.walk_stream(&request, &cancel, |entry| {
			if cancel.is_cancelled() {
				return ControlFlow::Break(());
			}
			let kind = match entry.file_type {
				FileType::File => document_pb::FileKind::RegularFile,
				FileType::Dir => document_pb::FileKind::Directory,
				FileType::Symlink => document_pb::FileKind::SymbolicLink,
			};
			let event = data_event::Body::WalkEntry(pb::WalkEntry {
				path:     entry.relative_path.to_owned(),
				kind:     kind as i32,
				mtime_ms: entry.mtime,
				size:     entry.size,
				depth:    u64::try_from(entry.depth).unwrap_or(u64::MAX),
				props:    Default::default(),
			});
			if send_data_event_sync(&responses, request_id, event) {
				emitted += 1;
				ControlFlow::Continue(())
			} else {
				ControlFlow::Break(())
			}
		});
		match result {
			Ok(status) if !cancel.is_cancelled() => {
				let _ = send_data_event_sync(
					&responses,
					request_id,
					data_event::Body::WalkComplete(pb::WalkComplete {
						scanned_entries:  emitted,
						filtered_entries: 0,
						limited_entries:  u64::from(status == WalkStatus::Stopped),
						cache_age_ms:     0,
						cached:           false,
						props:            Default::default(),
					}),
				);
			},
			Ok(_) => {},
			Err(error) => {
				send_workspace_stream_error_sync(
					&responses,
					request_id,
					pb::EventStreamKind::Walk,
					&error,
				);
			},
		}
		let _ = finished.send(Finished { request_id, invocation_id: None });
	});
}

fn spawn_workspace_search(
	request_id: u64,
	workspace: WorkspaceHost,
	request: WalkRequest,
	options: WorkspaceSearchOwned,
	cancel: CancellationToken,
	responses: flume::Sender<pb::ServerFrame>,
	finished: flume::Sender<Finished>,
) {
	task::spawn_blocking(move || {
		let borrowed = WorkspaceSearchOptions {
			pattern: options.pattern.as_str(),
			case:    options.case,
			limit:   options.limit,
		};
		let result = workspace.search_stream(&request, &borrowed, &cancel, |matched| {
			if cancel.is_cancelled() {
				return ControlFlow::Break(());
			}
			if send_data_event_sync(
				&responses,
				request_id,
				data_event::Body::SearchMatch(pb::SearchMatchMsg {
					path:        matched.path.to_string(),
					line:        matched.line,
					byte_offset: matched.byte_offset,
					line_bytes:  matched.line_bytes,
					props:       Default::default(),
				}),
			) {
				ControlFlow::Continue(())
			} else {
				ControlFlow::Break(())
			}
		});
		match result {
			Ok(outcome) if !cancel.is_cancelled() => {
				let _ = send_data_event_sync(
					&responses,
					request_id,
					data_event::Body::SearchComplete(pb::SearchComplete {
						files_scanned: outcome.files_scanned,
						matches:       outcome.matches,
						limited:       outcome.limited,
						props:         Default::default(),
					}),
				);
			},
			Ok(_) => {},
			Err(error) => {
				send_workspace_stream_error_sync(
					&responses,
					request_id,
					pb::EventStreamKind::Search,
					&error,
				);
			},
		}
		let _ = finished.send(Finished { request_id, invocation_id: None });
	});
}

fn send_data_event_sync(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	body: data_event::Body,
) -> bool {
	responses
		.send(checked_server_frame(
			request_id,
			server_frame::Body::DataEvent(pb::DataEvent {
				body:  Some(body),
				props: Default::default(),
			}),
		))
		.is_ok()
}

fn send_workspace_stream_error_sync(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	kind: pb::EventStreamKind,
	error: &WorkspaceError,
) {
	let _ = responses.send(checked_server_frame(
		request_id,
		server_frame::Body::EventStreamError(pb::EventStreamError {
			stream:         kind as i32,
			failure:        pb::EventStreamFailure::Closed as i32,
			invocation_id:  String::new(),
			exec:           Bytes::new(),
			process_name:   String::new(),
			skipped_events: 0,
			message:        error.to_string(),
			props:          Default::default(),
		}),
	));
}

#[derive(Clone, Debug)]
struct VerdictDeliveryProvenance {
	session_id:    Str,
	invocation_id: Str,
}

fn verdict_delivery_provenance(scope: &pb::InvocationScope) -> Option<VerdictDeliveryProvenance> {
	(!scope.session_id.is_empty() && !scope.agent_id.is_empty() && !scope.invocation_id.is_empty())
		.then(|| VerdictDeliveryProvenance {
			session_id:    Str::from(scope.session_id.as_str()),
			invocation_id: Str::from(scope.invocation_id.as_str()),
		})
}

fn spawn_blob_get(
	request_id: u64,
	read: BlobRead,
	delivery: Option<VerdictDeliveryProvenance>,
	cancel: CancellationToken,
	responses: flume::Sender<pb::ServerFrame>,
	finished: flume::Sender<Finished>,
	blobs: BlobHost,
) {
	tokio::spawn(async move {
		let id = read.id();
		let range_offset = read.offset();
		let range_length = read.len();
		let mut file = tokio::fs::File::from_std(read.into_file());
		let mut sent = 0_u64;
		let mut complete = true;

		if range_length == 0 {
			let send = responses.send_async(checked_server_frame(
				request_id,
				server_frame::Body::BlobChunk(blob_pb::Chunk {
					data: Bytes::new(),
					hash: Bytes::copy_from_slice(&id.hash),
					size: Some(id.size),
				}),
			));
			tokio::select! {
				() = cancel.cancelled() => {},
				result = send => complete = result.is_ok(),
			}
		}

		let mut buffer = vec![0_u8; BLOB_CHUNK_BYTES].into_boxed_slice();
		while sent < range_length {
			let remaining = range_length - sent;
			let wanted = usize::try_from(remaining.min(BLOB_CHUNK_BYTES as u64))
				.expect("blob chunk bound fits usize");
			let read_result = tokio::select! {
				() = cancel.cancelled() => break,
				result = file.read(&mut buffer[..wanted]) => result,
			};
			let count = match read_result {
				Ok(0) => {
					let error = BlobError::ReadTruncated { expected: range_length, actual: sent };
					send_blob_error(&responses, request_id, &error).await;
					complete = false;
					break;
				},
				Ok(count) => count,
				Err(source) => {
					let error = BlobError::Store(source.into());
					send_blob_error(&responses, request_id, &error).await;
					complete = false;
					break;
				},
			};
			let first = sent == 0;
			let send = responses.send_async(checked_server_frame(
				request_id,
				server_frame::Body::BlobChunk(blob_pb::Chunk {
					data: Bytes::copy_from_slice(&buffer[..count]),
					hash: if first {
						Bytes::copy_from_slice(&id.hash)
					} else {
						Bytes::new()
					},
					size: first.then_some(id.size),
				}),
			));
			tokio::select! {
				() = cancel.cancelled() => break,
				result = send => {
					if result.is_err() {
						complete = false;
						break;
					}
					sent += u64::try_from(count).expect("blob chunk count fits u64");
				},
			}
		}

		if complete && !cancel.is_cancelled() && sent == range_length {
			let completion_delivered = responses
				.send_async(checked_server_frame(
					request_id,
					server_frame::Body::BlobGetComplete(pb::BlobGetComplete {
						hash:       Bytes::copy_from_slice(&id.hash),
						bytes_sent: sent,
						props:      Default::default(),
					}),
				))
				.await
				.is_ok();
			if completion_delivered
				&& range_offset.saturating_add(sent) == id.size
				&& let Some(delivery) = delivery.as_ref()
			{
				match blobs.verdict_downloaded(
					Some(delivery.session_id.as_str()),
					delivery.invocation_id.as_str(),
					id,
				) {
					Ok(_) => {},
					Err(error) => tracing::warn!(
						%error,
						hash = %Hash32::new(id.hash),
						session_id = %delivery.session_id,
						invocation_id = %delivery.invocation_id,
						"could not release completed verdict download lease"
					),
				}
			}
		}
		let _ = finished
			.send_async(Finished { request_id, invocation_id: None })
			.await;
	});
}

fn materialize_worker_outcome(
	blobs: &BlobHost,
	complete: &ExtHostCompletion,
) -> Result<Bytes, Str> {
	let Some(blob) = complete.details_blob.as_ref() else {
		return worker_completion_json(complete).map(|(json, ..)| json);
	};
	if blob.size > u64::try_from(DEFAULT_MAX_FRAME_BYTES).expect("frame bound fits u64") {
		return Err(sf!(
			"dynamic worker result exceeds the bounded inline projection; read its artifact instead"
		));
	}
	let hash: [u8; 32] = blob
		.hash
		.as_ref()
		.try_into()
		.map_err(|_| sf!("worker result blob hash is invalid"))?;
	let bytes = blobs
		.get(BlobId { hash, size: blob.size })
		.map_err(|_| sf!("worker result blob is unavailable"))?;
	if serde_json::from_slice::<CallOutcome<serde_json::Value, serde_json::Value>>(&bytes).is_ok() {
		return Ok(bytes);
	}
	match complete.kind {
		ExtHostOutcomeKind::Ok | ExtHostOutcomeKind::Faulted => {
			worker_verdict_json(bytes, complete.kind == ExtHostOutcomeKind::Faulted)
				.map_err(|_| sf!("worker result blob is invalid"))
		},
		ExtHostOutcomeKind::ArgsRejected | ExtHostOutcomeKind::Aborted => {
			Err(sf!("worker result blob omitted its terminal outcome envelope"))
		},
	}
}

fn materialize_worker_details(
	blobs: &BlobHost,
	complete: &ExtHostCompletion,
) -> Result<Bytes, Str> {
	if complete.details_blob.is_none() {
		return complete
			.details_json
			.clone()
			.ok_or_else(|| sf!("worker completion omitted structured details"));
	}
	let outcome = materialize_worker_outcome(blobs, complete)?;
	let mut outcome = serde_json::from_slice::<serde_json::Value>(&outcome)
		.map_err(|_| sf!("worker result artifact is invalid"))?;
	let value = outcome
		.as_object_mut()
		.and_then(|outcome| outcome.remove("value"))
		.ok_or_else(|| sf!("worker result artifact omitted its value"))?;
	serde_json::to_vec(&value)
		.map(Bytes::from)
		.map_err(|_| sf!("worker result value could not be encoded"))
}

fn materialize_worker_completion(
	blobs: &BlobHost,
	complete: &ExtHostCompletion,
) -> Result<Bytes, Str> {
	materialize_worker_outcome(blobs, complete)
}

fn projected_worker_completion_json(
	blobs: &BlobHost,
	complete: &ExtHostCompletion,
	request: omp_tool::OutputRequest,
) -> Result<(Bytes, Option<thread_pb::Blob>, bool), Str> {
	let (mut json, details_blob, is_error) = worker_completion_json(complete)?;
	let inline_limit = match request {
		omp_tool::OutputRequest::Bounded => DEFAULT_RESULT_PROJECTION_BYTES,
		omp_tool::OutputRequest::Complete => COMPLETE_RESULT_PROJECTION_BYTES,
	};
	if json.is_empty()
		&& details_blob
			.as_ref()
			.is_some_and(|details| details.size <= u64::try_from(inline_limit).unwrap_or(u64::MAX))
	{
		json = materialize_worker_outcome(blobs, complete)?;
	}
	Ok((json, details_blob, is_error))
}

fn worker_completion_json(
	complete: &ExtHostCompletion,
) -> Result<(Bytes, Option<thread_pb::Blob>, bool), Str> {
	let is_error = complete.kind != ExtHostOutcomeKind::Ok;
	if let Some(blob) = &complete.details_blob {
		return Ok((Bytes::new(), Some(blob.clone()), is_error));
	}
	let details = complete
		.details_json
		.clone()
		.ok_or_else(|| sf!("worker completion omitted structured details"))?;
	let json = match complete.kind {
		ExtHostOutcomeKind::Ok | ExtHostOutcomeKind::Faulted => {
			worker_verdict_json(details, is_error).map_err(|error| Str::from(error.to_string()))?
		},
		ExtHostOutcomeKind::ArgsRejected => {
			let issue = complete
				.args_issue
				.as_ref()
				.ok_or_else(|| sf!("worker omitted its argument issue"))?;
			let kind = issue
				.kind
				.parse()
				.map_err(|_| sf!("worker argument issue kind is invalid"))?;
			let issue = ArgIssue {
				path: issue
					.path
					.iter()
					.map(|segment| ArgPath::Key(Str::from(segment.as_str())))
					.collect(),
				expected: Str::from(issue.expected.as_str()),
				kind,
				example: issue.example.as_deref().map(Str::from),
				found: issue.found.as_deref().map(Str::from),
			};
			Bytes::from(
				serde_json::to_vec(&CallOutcome::<serde_json::Value, serde_json::Value>::ArgsRejected(
					issue,
				))
				.map_err(|error| Str::from(error.to_string()))?,
			)
		},
		ExtHostOutcomeKind::Aborted => {
			let abort: Abort =
				serde_json::from_slice(&details).map_err(|error| Str::from(error.to_string()))?;
			Bytes::from(
				serde_json::to_vec(&CallOutcome::<serde_json::Value, serde_json::Value>::aborted(
					abort,
				))
				.map_err(|error| Str::from(error.to_string()))?,
			)
		},
	};
	Ok((json, None, is_error))
}

fn worker_verdict_json(details: Bytes, is_error: bool) -> Result<Bytes, serde_json::Error> {
	let _: &RawValue = serde_json::from_slice(&details)?;
	if serde_json::from_slice::<CallOutcome<serde_json::Value, serde_json::Value>>(&details).is_ok()
	{
		return Ok(details);
	}
	let prefix: &[u8] = if is_error {
		br#"{"kind":"faulted","value":"#
	} else {
		br#"{"kind":"ok","value":"#
	};
	let mut verdict = BytesMut::with_capacity(prefix.len() + details.len() + 1);
	verdict.extend_from_slice(prefix);
	verdict.extend_from_slice(&details);
	verdict.extend_from_slice(b"}");
	Ok(verdict.freeze())
}

fn erased_outcome_wire(outcome: ErasedOutcome) -> (Bytes, bool, bool) {
	match outcome {
		ErasedOutcome::Done { verdict, useless } => {
			let is_error =
				serde_json::from_slice::<CallOutcome<serde_json::Value, serde_json::Value>>(&verdict)
					.map_or(true, |verdict| !matches!(verdict, CallOutcome::Ok(_)));
			(verdict, is_error, useless)
		},
		ErasedOutcome::Detached(job) => {
			let json = serde_json::to_vec(
				&ToolTerminal::<serde_json::Value, serde_json::Value>::Detached(job),
			)
			.map(Bytes::from)
			.unwrap_or_default();
			(json, false, false)
		},
	}
}
async fn send_workspace_operation_error(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	error: &WorkspaceOperationError,
) {
	match error {
		WorkspaceOperationError::Document(error) => {
			send_document_error(responses, request_id, error).await;
		},
		WorkspaceOperationError::Blob(error) => {
			send_blob_error(responses, request_id, error).await;
		},
		WorkspaceOperationError::WorktreeNotFound(_) => {
			send_error(responses, request_id, pb::ProtocolErrorCode::NotFound, &error.to_string())
				.await;
		},
		WorkspaceOperationError::OutsideRoot
		| WorkspaceOperationError::WireRevision
		| WorkspaceOperationError::InvalidGeneration(_)
		| WorkspaceOperationError::IsolationBaselineTooLarge(_)
		| WorkspaceOperationError::InvalidWorktreeName => {
			send_error(
				responses,
				request_id,
				pb::ProtocolErrorCode::InvalidArgument,
				&error.to_string(),
			)
			.await;
		},
		WorkspaceOperationError::Workspace(_)
		| WorkspaceOperationError::Io(_)
		| WorkspaceOperationError::IsolationPreflight(_)
		| WorkspaceOperationError::InvalidSnapshotRecord(_)
		| WorkspaceOperationError::InvalidWorktreeRecord(_) => {
			send_error(responses, request_id, pb::ProtocolErrorCode::Internal, &error.to_string())
				.await;
		},
	}
}
fn workspace_walk_request(
	workspace: &WorkspaceHost,
	request: &pb::WalkRequest,
) -> Result<WalkRequest, (pb::ProtocolErrorCode, String)> {
	let root = if request.root_uri.is_empty() {
		workspace.root().to_path_buf()
	} else {
		Url::parse(&request.root_uri)
			.map_err(|error| {
				(
					pb::ProtocolErrorCode::InvalidArgument,
					format!("walk root is not a valid URI: {error}"),
				)
			})?
			.to_file_path()
			.map_err(|()| {
				(pb::ProtocolErrorCode::InvalidArgument, "walk root is not a local file URI".to_owned())
			})?
	};
	if !request.exclude.is_empty() {
		return Err((
			pb::ProtocolErrorCode::Unsupported,
			"walk exclude globs are not implemented".to_owned(),
		));
	}
	let options = request.options.as_ref();
	let follow_links = match options
		.map(|options| pb::WalkFollowLinks::try_from(options.follow_links))
		.transpose()
		.map_err(|_| {
			(pb::ProtocolErrorCode::InvalidArgument, "walk follow_links value is invalid".to_owned())
		})?
		.unwrap_or(pb::WalkFollowLinks::Never)
	{
		pb::WalkFollowLinks::Unspecified | pb::WalkFollowLinks::Never => FollowLinks::Never,
		pb::WalkFollowLinks::Roots => FollowLinks::Roots,
		pb::WalkFollowLinks::Always => FollowLinks::Always,
	};
	let detail = match options
		.map(|options| pb::WalkDetail::try_from(options.detail))
		.transpose()
		.map_err(|_| {
			(pb::ProtocolErrorCode::InvalidArgument, "walk detail value is invalid".to_owned())
		})?
		.unwrap_or(pb::WalkDetail::Minimal)
	{
		pb::WalkDetail::Unspecified | pb::WalkDetail::Minimal => WalkDetail::Minimal,
		pb::WalkDetail::Full => WalkDetail::Full,
	};
	let order = match options
		.map(|options| pb::WalkOrder::try_from(options.order))
		.transpose()
		.map_err(|_| {
			(pb::ProtocolErrorCode::InvalidArgument, "walk order value is invalid".to_owned())
		})?
		.unwrap_or(pb::WalkOrder::Path)
	{
		pb::WalkOrder::Unspecified | pb::WalkOrder::Path => WalkOrder::Path,
		pb::WalkOrder::Native => WalkOrder::Unordered,
	};
	let directory_errors = match options
		.map(|options| pb::DirectoryErrorMode::try_from(options.directory_errors))
		.transpose()
		.map_err(|_| {
			(
				pb::ProtocolErrorCode::InvalidArgument,
				"walk directory_errors value is invalid".to_owned(),
			)
		})?
		.unwrap_or(pb::DirectoryErrorMode::SkipSkippable)
	{
		pb::DirectoryErrorMode::Unspecified | pb::DirectoryErrorMode::SkipSkippable => {
			DirectoryErrorMode::SkipSkippable
		},
		pb::DirectoryErrorMode::Visit => DirectoryErrorMode::Visit,
	};
	let options = options.cloned().unwrap_or_default();
	let mut walk = WalkRequest::from_options(root, WalkOptions {
		include_hidden: options.include_hidden,
		use_gitignore: options.use_gitignore,
		skip_git: options.skip_git,
		skip_node_modules: options.skip_node_modules,
		follow_links,
		detail,
		order,
		emit_root: options.emit_root,
		min_depth: usize::try_from(options.min_depth).unwrap_or(usize::MAX),
		max_depth: if options.max_depth == 0 {
			usize::MAX
		} else {
			usize::try_from(options.max_depth).unwrap_or(usize::MAX)
		},
		contents_first: options.contents_first,
		directory_errors,
		same_file_system: options.same_file_system,
		cache: options.cache,
	});
	if !request.include.is_empty() {
		let glob = CompiledWalkGlob::new(request.include.iter().cloned()).map_err(|error| {
			(pb::ProtocolErrorCode::InvalidArgument, format!("walk include glob is invalid: {error}"))
		})?;
		walk = walk.filter(WalkFilter::all().glob(glob));
	}
	if let Some(limit) = request.limit {
		walk = walk.limit(usize::try_from(limit).unwrap_or(usize::MAX));
	}
	Ok(walk)
}

async fn send_materialization_error(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	error: &MaterializationError,
) {
	let code = match error {
		MaterializationError::InvalidUri => pb::ProtocolErrorCode::InvalidArgument,
		MaterializationError::NotFound => pb::ProtocolErrorCode::NotFound,
		MaterializationError::UnsupportedScheme => pb::ProtocolErrorCode::Unsupported,
		MaterializationError::OutsideGrant | MaterializationError::SymbolicLink => {
			pb::ProtocolErrorCode::PermissionDenied
		},
		MaterializationError::TooLarge { .. } => pb::ProtocolErrorCode::ResourceExhausted,
		MaterializationError::Io(_) => pb::ProtocolErrorCode::Internal,
	};
	send_error(responses, request_id, code, &error.to_string()).await;
}

async fn send_exec_error(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	error: &ExecError,
) {
	let code = match error {
		ExecError::SessionNotFound
		| ExecError::RunNotFound
		| ExecError::FinalCwdNotFound
		| ExecError::ProcessNotFound(_) => pb::ProtocolErrorCode::NotFound,
		ExecError::ProcessExists(_) => pb::ProtocolErrorCode::AlreadyExists,
		ExecError::StaleProcessGeneration { .. } | ExecError::StaleFinalCwdRevision => {
			pb::ProtocolErrorCode::PreconditionFailed
		},
		ExecError::UnsupportedSignal(_) | ExecError::UnsupportedShellProfile { .. } => {
			pb::ProtocolErrorCode::Unsupported
		},
		ExecError::WireRevision
		| ExecError::InvalidControl
		| ExecError::InvalidProcessName
		| ExecError::DetachedPty => pb::ProtocolErrorCode::InvalidArgument,
		_ => pb::ProtocolErrorCode::Internal,
	};
	send_error(responses, request_id, code, &error.to_string()).await;
}

fn worker_operation_allowed(operation: &str) -> bool {
	operation.starts_with("omp.env.docs.")
		|| operation.starts_with("omp.env.fs.")
		|| operation.starts_with("omp.env.find.")
		|| operation.starts_with("omp.env.http.")
		|| matches!(
			operation,
			"omp.env.blobs.stat"
				| "omp.env.blobs.get"
				| "omp.env.blobs.put"
				| "omp.env.blobs.commit_put"
		)
}

async fn send_blob_error(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	error: &BlobError,
) {
	let code = match error {
		BlobError::InvalidHash
		| BlobError::HashMismatch
		| BlobError::SizeMismatch { .. }
		| BlobError::InvalidRange { .. }
		| BlobError::LengthOverflow => pb::ProtocolErrorCode::InvalidArgument,
		BlobError::Store(blob::Error::NotFound) => pb::ProtocolErrorCode::NotFound,
		BlobError::VerdictPinned => pb::ProtocolErrorCode::PreconditionFailed,
		BlobError::Store(_)
		| BlobError::Remove(_)
		| BlobError::ReadTruncated { .. }
		| BlobError::FinalizeTask(_)
		| BlobError::ArtifactMetadata(_)
		| BlobError::JournalScan { .. }
		| BlobError::UnsupportedJournalResult { .. }
		| BlobError::JournalResult { .. }
		| BlobError::ArtifactClock => pb::ProtocolErrorCode::Internal,
	};
	send_error(responses, request_id, code, &error.to_string()).await;
}

fn connection_lease_id(target: Option<&document_pb::DocumentTarget>) -> Option<&Bytes> {
	let document_target::Target::LeaseId(lease_id) = target?.target.as_ref()? else {
		return None;
	};
	Some(lease_id)
}

fn connection_lease<'a>(
	connection: &'a ConnectionState,
	target: Option<&document_pb::DocumentTarget>,
) -> Option<&'a DocumentLease> {
	let document_target::Target::LeaseId(lease_id) = target?.target.as_ref()? else {
		return None;
	};
	connection.document_leases.get(lease_id)
}

async fn send_document_error(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	error: &DocumentError,
) {
	let code = match error {
		DocumentError::Protocol { code, .. } => {
			match document_pb::ProtocolErrorCode::try_from(*code) {
				Ok(document_pb::ProtocolErrorCode::InvalidArgument) => {
					pb::ProtocolErrorCode::InvalidArgument
				},
				Ok(document_pb::ProtocolErrorCode::NotFound) => pb::ProtocolErrorCode::NotFound,
				Ok(document_pb::ProtocolErrorCode::PermissionDenied) => {
					pb::ProtocolErrorCode::PermissionDenied
				},
				Ok(document_pb::ProtocolErrorCode::Unsupported) => pb::ProtocolErrorCode::Unsupported,
				Ok(document_pb::ProtocolErrorCode::AlreadyExists) => {
					pb::ProtocolErrorCode::AlreadyExists
				},

				Ok(document_pb::ProtocolErrorCode::Cancelled) => pb::ProtocolErrorCode::Cancelled,
				Ok(
					document_pb::ProtocolErrorCode::RevisionExpired
					| document_pb::ProtocolErrorCode::PreconditionFailed
					| document_pb::ProtocolErrorCode::ContentModified,
				) => pb::ProtocolErrorCode::PreconditionFailed,
				_ => pb::ProtocolErrorCode::Internal,
			}
		},
		DocumentError::Cancelled => pb::ProtocolErrorCode::Cancelled,
		DocumentError::Disconnected => pb::ProtocolErrorCode::Internal,
		DocumentError::MalformedResponse(_) => pb::ProtocolErrorCode::InvalidArgument,
		DocumentError::Wire(_) => pb::ProtocolErrorCode::Internal,
	};
	send_error(responses, request_id, code, &error.to_string()).await;
}

async fn send_http_error(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	error: &HttpEgressError,
) {
	let code = match error {
		HttpEgressError::InvalidArgument(_) => pb::ProtocolErrorCode::InvalidArgument,
		HttpEgressError::TimedOut => pb::ProtocolErrorCode::DeadlineExceeded,
		HttpEgressError::ResponseTooLarge => pb::ProtocolErrorCode::ResourceExhausted,
		HttpEgressError::UnsupportedSocksProxy { .. } => pb::ProtocolErrorCode::Internal,
		HttpEgressError::Transport(_) => pb::ProtocolErrorCode::Internal,
	};
	send_error(responses, request_id, code, &error.to_string()).await;
}

fn frame_data_operation(body: &client_frame::Body) -> Option<(&'static str, &'static str)> {
	match body {
		client_frame::Body::OpenSession(_) => Some(("omp.env.sh.open_session", "env.exec")),
		client_frame::Body::CloseSession(_) => Some(("omp.env.sh.close_session", "env.exec")),
		client_frame::Body::Exec(_) => Some(("omp.env.sh.exec", "env.exec")),
		client_frame::Body::Stdin(_) => Some(("omp.env.sh.stdin", "env.exec")),
		client_frame::Body::Signal(_) => Some(("omp.env.sh.signal", "env.exec")),
		client_frame::Body::Resize(_) => Some(("omp.env.sh.resize", "env.exec")),
		client_frame::Body::StartProcess(_) => Some(("omp.env.proc.start", "env.process")),
		client_frame::Body::GetProcess(_) => Some(("omp.env.Process.info", "env.process")),
		client_frame::Body::RestartProcess(_) => Some(("omp.env.Process.restart", "env.process")),
		client_frame::Body::HttpRequest(request) => Some((
			match request.method.as_str() {
				"POST" => "omp.env.http.post",
				"PUT" => "omp.env.http.put",
				_ => "omp.env.http.get",
			},
			"env.net",
		)),
		client_frame::Body::ListProcesses(_) => Some(("omp.env.proc.list", "env.process")),
		client_frame::Body::AttachOutput(_) => Some(("omp.env.proc.attach", "env.process")),
		client_frame::Body::SendInput(_) => Some(("omp.env.proc.send_input", "env.process")),
		client_frame::Body::SignalProcess(_) => Some(("omp.env.proc.signal", "env.process")),
		client_frame::Body::StopProcess(_) => Some(("omp.env.proc.stop", "env.process")),
		client_frame::Body::BlobStat(_) => Some(("omp.env.blobs.stat", "env.blob")),
		client_frame::Body::BlobGet(_) => Some(("omp.env.blobs.get", "env.blob")),
		client_frame::Body::BlobPutChunk(_) => Some(("omp.env.blobs.put", "env.blob")),
		client_frame::Body::BlobPutCommit(_) => Some(("omp.env.blobs.commit_put", "env.blob")),
		client_frame::Body::BlobDelete(_) => Some(("omp.env.blobs.delete", "env.blob")),
		_ => None,
	}
}
fn requests_pty(body: &client_frame::Body) -> bool {
	match body {
		client_frame::Body::OpenSession(request) => request.pty.is_some(),
		client_frame::Body::StartProcess(request) => {
			request.spec.as_ref().is_some_and(|spec| spec.pty.is_some())
		},
		_ => false,
	}
}

async fn authorize_data_operation(
	connection: &ConnectionState,
	scope: Option<&pb::InvocationScope>,
	operation: &'static str,
	capability: &'static str,
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
) -> bool {
	let Some(spec) = omp_tool::operation_spec(operation) else {
		send_error(
			responses,
			request_id,
			pb::ProtocolErrorCode::Unsupported,
			"DATA operation has no canonical OperationSpec",
		)
		.await;
		return false;
	};
	if spec.authority != omp_tool::Authority::Environment {
		send_error(
			responses,
			request_id,
			pb::ProtocolErrorCode::PermissionDenied,
			"DATA operation is not Environment-authoritative",
		)
		.await;
		return false;
	}
	if !connection.grants(capability) {
		send_policy_error(responses, request_id, PolicyError::Denied { capability }).await;
		return false;
	}
	if scope.is_none() {
		if connection.host.is_some() {
			send_policy_error(responses, request_id, PolicyError::EffectsNotAuthorized).await;
			return false;
		}
		return true;
	}
	if !spec
		.minimum_phase
		.has_reached(omp_core::InvocationPhase::EffectsAuthorized)
	{
		send_error(
			responses,
			request_id,
			pb::ProtocolErrorCode::Internal,
			"DATA OperationSpec does not enforce EFFECTS_AUTHORIZED",
		)
		.await;
		return false;
	}
	let Some(scope) = scope else {
		send_policy_error(responses, request_id, PolicyError::EffectsNotAuthorized).await;
		return false;
	};
	let Some(host) = &connection.host else {
		send_policy_error(responses, request_id, PolicyError::EffectsNotAuthorized).await;
		return false;
	};
	let worker_scope = connection
		.authority
		.is_worker_invocation(host, &scope.invocation_id);
	let credentials = DataAuthority {
		invocation_id:      &scope.invocation_id,
		effect_token:       &scope.effect_token,
		host_generation:    scope.host_generation,
		session_generation: scope.session_generation,
	};
	let result = if capability == "env.search" {
		connection
			.authority
			.validate_read(host, connection.connection_owner, credentials)
	} else {
		connection
			.authority
			.validate(host, connection.connection_owner, credentials, capability)
	};
	if let Err(error) = result {
		send_policy_error(responses, request_id, error).await;
		return false;
	}
	if worker_scope && !worker_operation_allowed(operation) {
		send_policy_error(responses, request_id, PolicyError::Denied { capability }).await;
		return false;
	}
	true
}

async fn send_policy_error(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	error: PolicyError,
) {
	if let PolicyError::QuotaExceeded { quota, limit, used } = &error {
		let props = ValueMap {
			fields: BTreeMap::from([
				("quota".to_owned(), Value { kind: Some(value::Kind::String((*quota).to_owned())) }),
				("limit".to_owned(), Value { kind: Some(value::Kind::Int(*limit as i64)) }),
				("used".to_owned(), Value { kind: Some(value::Kind::Int(*used as i64)) }),
			]),
		};
		send_body(
			responses,
			request_id,
			server_frame::Body::Error(pb::ProtocolError {
				code:    pb::ProtocolErrorCode::ResourceExhausted.into(),
				message: format!("QuotaExceeded: quota={quota}"),
				props:   Some(props),
			}),
		)
		.await;
		return;
	}
	let (code, message) = match error {
		PolicyError::EffectsNotAuthorized => (
			pb::ProtocolErrorCode::Uncommitted,
			sf!("omp.EffectsNotAuthorized: invocation has not reached EFFECTS_AUTHORIZED"),
		),
		PolicyError::Denied { capability } => (
			pb::ProtocolErrorCode::PermissionDenied,
			Str::from(format!(
				"Denied: effect envelope does not grant {capability}; escalation is not re-prompted"
			)),
		),
		PolicyError::InvalidEffectToken => (
			pb::ProtocolErrorCode::PermissionDenied,
			sf!("Denied: effect token is absent, mismatched, revoked, or connection-bound",),
		),
		PolicyError::StaleGeneration => (
			pb::ProtocolErrorCode::PreconditionFailed,
			sf!("StaleGeneration: host or session generation is stale"),
		),
		PolicyError::LeaseNotOwned => (
			pb::ProtocolErrorCode::PermissionDenied,
			sf!("Denied: document lease belongs to another connection"),
		),
		PolicyError::EnforcementUnavailable => (
			pb::ProtocolErrorCode::Unsupported,
			sf!("EnforcementUnavailable: sandbox ENFORCE is deferred; refusing instead of degrading",),
		),
		PolicyError::QuotaExceeded { .. } => unreachable!("quota errors returned above"),
	};
	send_error(responses, request_id, code, message.as_str()).await;
}

async fn send_data_response(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	body: data_response::Body,
) {
	send_body(
		responses,
		request_id,
		server_frame::Body::Data(pb::DataResponse { body: Some(body), props: Default::default() }),
	)
	.await;
}

async fn send_stream_error(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	kind: pb::EventStreamKind,
	invocation_id: &str,
	exec: &[u8],
	process_name: &str,
	message: &str,
) {
	send_body(
		responses,
		request_id,
		server_frame::Body::EventStreamError(pb::EventStreamError {
			stream:         kind as i32,
			failure:        pb::EventStreamFailure::Closed as i32,
			invocation_id:  invocation_id.to_owned(),
			exec:           Bytes::copy_from_slice(exec),
			process_name:   process_name.to_owned(),
			skipped_events: 0,
			message:        message.to_owned(),
			props:          Default::default(),
		}),
	)
	.await;
}

async fn send_error(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	code: pb::ProtocolErrorCode,
	message: &str,
) {
	send_body(
		responses,
		request_id,
		server_frame::Body::Error(pb::ProtocolError {
			code:    code as i32,
			message: message.to_owned(),
			props:   Default::default(),
		}),
	)
	.await;
}

async fn send_body(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	body: server_frame::Body,
) {
	let _ = responses
		.send_async(checked_server_frame(request_id, body))
		.await;
}

async fn send_invocation_body(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	body: server_frame::Body,
) -> bool {
	matches!(
		time::timeout(
			INVOCATION_RESPONSE_SEND_GRACE,
			responses.send_async(checked_server_frame(request_id, body)),
		)
		.await,
		Ok(Ok(()))
	)
}

async fn send_invocation_terminal_body(
	responses: &flume::Sender<pb::ServerFrame>,
	request_id: u64,
	body: server_frame::Body,
) {
	let frame = checked_server_frame(request_id, body);
	let retry = frame.clone();
	if time::timeout(INVOCATION_RESPONSE_SEND_GRACE, responses.send_async(frame))
		.await
		.is_err()
	{
		let responses = responses.clone();
		tokio::spawn(async move {
			let _ = responses.send_async(retry).await;
		});
	}
}

fn checked_server_frame(request_id: u64, body: server_frame::Body) -> pb::ServerFrame {
	let mut frame = server_frame(request_id, body);
	if frame.encoded_len() > FRAME_LIMIT {
		frame = server_frame(
			request_id,
			server_frame::Body::Error(pb::ProtocolError {
				code:    pb::ProtocolErrorCode::Internal as i32,
				message: "environment response exceeds the configured frame limit".to_owned(),
				props:   Default::default(),
			}),
		);
	}
	frame
}

fn server_frame(request_id: u64, body: server_frame::Body) -> pb::ServerFrame {
	pb::ServerFrame { request_id, body: Some(body), props: Default::default() }
}

async fn read_server_frame<R>(
	reader: &mut R,
	scratch: &mut BytesMut,
) -> io::Result<Option<pb::ServerFrame>>
where
	R: AsyncRead + Unpin,
{
	let Some(length) = read_length(reader).await? else {
		return Ok(None);
	};
	if length > FRAME_LIMIT {
		return Err(io::Error::new(
			io::ErrorKind::InvalidData,
			"environment frame exceeds the configured limit",
		));
	}
	scratch.clear();
	scratch.resize(length, 0);
	reader.read_exact(scratch).await?;
	pb::ServerFrame::decode(&scratch[..])
		.map(Some)
		.map_err(io::Error::other)
}

async fn write_client_frame<W>(
	writer: &mut W,
	frame: &pb::ClientFrame,
	scratch: &mut BytesMut,
) -> io::Result<()>
where
	W: AsyncWrite + Unpin,
{
	if frame.encoded_len() > FRAME_LIMIT {
		return Err(io::Error::new(
			io::ErrorKind::InvalidData,
			"environment frame exceeds the configured limit",
		));
	}
	scratch.clear();
	frame
		.encode_length_delimited(&mut *scratch)
		.map_err(io::Error::other)?;
	writer.write_all(scratch).await?;
	writer.flush().await
}
async fn read_client_frame<R>(
	reader: &mut R,
	scratch: &mut BytesMut,
) -> io::Result<Option<pb::ClientFrame>>
where
	R: AsyncRead + Unpin,
{
	let Some(length) = read_length(reader).await? else {
		return Ok(None);
	};
	if length > FRAME_LIMIT {
		return Err(io::Error::new(
			io::ErrorKind::InvalidData,
			"environment frame exceeds the configured limit",
		));
	}
	scratch.clear();
	scratch.resize(length, 0);
	reader.read_exact(scratch).await?;
	pb::ClientFrame::decode(&scratch[..])
		.map(Some)
		.map_err(io::Error::other)
}

async fn write_server_frame<W>(
	writer: &mut W,
	frame: &pb::ServerFrame,
	scratch: &mut BytesMut,
) -> io::Result<()>
where
	W: AsyncWrite + Unpin,
{
	if frame.encoded_len() > FRAME_LIMIT {
		return Err(io::Error::new(
			io::ErrorKind::InvalidData,
			"environment frame exceeds the configured limit",
		));
	}
	scratch.clear();
	frame
		.encode_length_delimited(&mut *scratch)
		.map_err(io::Error::other)?;
	writer.write_all(scratch).await?;
	writer.flush().await
}

async fn read_length<R>(reader: &mut R) -> io::Result<Option<usize>>
where
	R: AsyncRead + Unpin,
{
	let mut value = 0_u64;
	for shift in (0..70).step_by(7) {
		let mut byte = [0_u8; 1];
		match reader.read_exact(&mut byte).await {
			Ok(_) => {},
			Err(error) if error.kind() == io::ErrorKind::UnexpectedEof && shift == 0 => {
				return Ok(None);
			},
			Err(error) => return Err(error),
		}
		let part = u64::from(byte[0] & 0x7f);
		if shift == 63 && part > 1 {
			return Err(io::Error::new(
				io::ErrorKind::InvalidData,
				"invalid environment frame length",
			));
		}
		value |= part << shift;
		if byte[0] & 0x80 == 0 {
			return usize::try_from(value).map(Some).map_err(io::Error::other);
		}
	}
	Err(io::Error::new(io::ErrorKind::InvalidData, "invalid environment frame length"))
}

/// Assembles and runs the standalone environment daemon with the production
/// built-in registry.
#[cfg(unix)]
pub async fn run(
	args: EnvdConfig,
	con: Arc<Ctx>,
	bridges: RegistryBridges,
) -> Result<(), EnvdError> {
	run_with_registry(args, Registry::new(), con, bridges).await
}

/// Assembles production dispatch plus caller-provided tool revisions.
#[cfg(unix)]
#[tracing::instrument(
	name = "environment_daemon_run",
	level = "debug",
	skip_all,
	fields(
		root = %args.root.display(),
		idle_timeout_s = args.idle_timeout,
		py_eval = args.py_eval
	)
)]
pub async fn run_with_registry(
	args: EnvdConfig,
	registry: Registry,
	con: Arc<Ctx>,
	bridges: RegistryBridges,
) -> Result<(), EnvdError> {
	let workspace = WorkspaceHost::open(&args.root)?;
	let root = workspace.root().to_path_buf();
	let data_dir = omp_core::dirs::data_dir(None).map_err(io::Error::other)?;
	let interrupt_grace = super::host_settings::SV_INTERRUPT_GRACE.get(&con);
	let state_dir = if let Some(path) = args.state_dir {
		path
	} else {
		omp_env::project_state::directory(&data_dir, &root)?
	};
	ensure_directory(&state_dir)?;
	let socket = args
		.socket
		.unwrap_or_else(|| omp_env::project_state::environment_socket(&state_dir));
	let require_document_ownership = args.docserver_socket.is_none();
	let docserver_socket = if let Some(socket) = args.docserver_socket {
		socket
	} else {
		let socket = omp_env::project_state::document_socket(&state_dir);
		socket
	};
	if require_document_ownership {
		ensure_document_socket_free(&root, &docserver_socket).await?;
	}
	let (principal_authority, session_id, session_generation) = authenticated_runtime_identity()?;
	let mut ext_host_config = ExtHostConfig::current(
		principal_authority.principal().clone(),
		session_id.clone(),
		session_generation,
	)?;
	ext_host_config.interrupt_grace = interrupt_grace;
	ext_host_config.py_eval = args.py_eval;
	let (env_connections, env_connection_rx) = watch::channel(0);
	let (doc_connections, doc_connection_rx) = watch::channel(0);
	let convars = Arc::new(crate::exthost::ConvarControlFactory::new(Arc::clone(&con)));
	let server = Arc::new(
		EnvServer::open_project(
			&root,
			&state_dir,
			&docserver_socket,
			registry,
			ext_host_config,
			Some(doc_connections),
			require_document_ownership,
			None,
			&con,
			convars,
			bridges,
		)
		.await?,
	);
	let process_shutdown = CancellationToken::new();
	let signal_shutdown = process_shutdown.clone();
	let signal_task = tokio::spawn(async move {
		let mut terminate = signal(SignalKind::terminate());
		match terminate.as_mut() {
			Ok(terminate) => {
				tokio::select! {
					_ = ctrl_c() => {},
					_ = terminate.recv() => {},
				}
			},
			Err(_) => {
				let _ = ctrl_c().await;
			},
		}
		signal_shutdown.cancel();
	});
	let listener_shutdown = CancellationToken::new();
	let serve_shutdown = listener_shutdown.clone();
	let serve_socket = socket.clone();
	let serve_server = Arc::clone(&server);
	let mut serve_task = tokio::spawn(async move {
		serve_server
			.serve_uds(&serve_socket, serve_shutdown, Some(env_connections))
			.await
	});
	let idle_timeout = Duration::from_secs(args.idle_timeout);
	let idle_state_dir = state_dir.clone();
	let idle_server_build = Str::from(omp_env::build_id::current());
	let idle_processes = server.process_host();
	let idle = async move {
		wait_idle(
			env_connection_rx,
			doc_connection_rx,
			1,
			idle_timeout,
			idle_state_dir,
			idle_server_build,
			idle_processes,
		)
		.await;
	};
	tokio::pin!(idle);
	let serve_result = async {
		tokio::select! {
			() = process_shutdown.cancelled() => {
				listener_shutdown.cancel();
				serve_task.await??;
			},
			() = &mut idle => {
				listener_shutdown.cancel();
				serve_task.await??;
			},
			result = &mut serve_task => {
				result??;
				tokio::select! {
					() = process_shutdown.cancelled() => {},
					() = &mut idle => {},
				}
			},
		}
		listener_shutdown.cancel();
		Ok::<(), EnvdError>(())
	}
	.await;
	listener_shutdown.cancel();
	let interrupt_grace = interrupt_grace
		.to_std()
		.map_err(|error| EnvdError::State(Str::from(error.to_string())))?;
	server.shutdown_managed(interrupt_grace).await;
	signal_task.abort();
	serve_result
}

#[cfg(unix)]
async fn wait_idle(
	mut env: watch::Receiver<usize>,
	mut docs: watch::Receiver<usize>,
	reserved_docs: usize,
	timeout: Duration,
	state_dir: PathBuf,
	server_build: Str,
	processes: ExecHost,
) {
	const BUILD_CHECK_INTERVAL: Duration = Duration::from_millis(50);

	let mut env_open = true;
	let mut docs_open = true;
	loop {
		while *env.borrow() != 0
			|| *docs.borrow() > reserved_docs
			|| processes.has_live_persistent_processes()
		{
			tokio::select! {
				result = env.changed(), if env_open => env_open = result.is_ok(),
				result = docs.changed(), if docs_open => docs_open = result.is_ok(),
				() = time::sleep(BUILD_CHECK_INTERVAL) => {
					if *env.borrow() == 0
						&& *docs.borrow() <= reserved_docs
						&& crate::launcher_build_is_stale(&state_dir, server_build.as_str())
					{
						return;
					}
				},
			}
		}
		if crate::launcher_build_is_stale(&state_dir, server_build.as_str()) {
			return;
		}
		let idle = async {
			if timeout.is_zero() {
				future::pending::<()>().await;
			} else {
				time::sleep(timeout).await;
			}
		};
		tokio::pin!(idle);
		loop {
			tokio::select! {
				() = &mut idle => return,
				result = env.changed(), if env_open => {
					env_open = result.is_ok();
					if *env.borrow() != 0 || *docs.borrow() > reserved_docs {
						break;
					}
				},
				result = docs.changed(), if docs_open => {
					docs_open = result.is_ok();
					if *env.borrow() != 0 || *docs.borrow() > reserved_docs {
						break;
					}
				},
				() = time::sleep(BUILD_CHECK_INTERVAL) => {
					if crate::launcher_build_is_stale(&state_dir, server_build.as_str()) {
						return;
					}
					if processes.has_live_persistent_processes() {
						break;
					}
				},
			}
		}
	}
}
/// Reports the transport limitation on platforms without a local IPC backend.
#[cfg(not(any(unix, windows)))]
pub async fn run(_args: EnvdConfig, _bridges: RegistryBridges) -> Result<(), EnvdError> {
	Err(
		io::Error::new(io::ErrorKind::Unsupported, "envd requires a Unix-domain socket in Phase 1")
			.into(),
	)
}

/// The user configuration root the document authority probes for `lsp.json`
/// and `dap.json` overrides (`<root>` and `<root>/agent`).
///
/// User configuration lives in `~/.o2` ([`omp_core::dirs::user_config_root`],
/// profile-aware), never under the data directory: a language-server
/// declaration in `~/.o2/lsp.json` must reach the native LSP supervisor.
///
/// # Errors
///
/// Returns [`omp_core::dirs::DataDirError::HomeUnset`] when no home directory
/// is set.
pub fn document_user_config_root() -> Result<PathBuf, omp_core::dirs::DataDirError> {
	omp_core::dirs::user_config_root()
}

#[cfg(any(unix, windows))]
async fn rehost_document_authority(
	root: &Path,
	state_dir: &Path,
	socket: &Path,
	connections: Option<watch::Sender<usize>>,
	lsp: crate::docserver::NativeLspOptions,
	user_config_root: Option<PathBuf>,
	server_build: Str,
) -> Result<Option<DocumentAuthority>, EnvdError> {
	if crate::launcher_build_is_stale(state_dir, server_build.as_str()) {
		tracing::debug!(
			build = %server_build,
			"stale-build environment daemon declined to rehost document authority"
		);
		return Ok(None);
	}
	let (_connection, authority) = connect_or_start_docserver(
		root,
		socket,
		connections,
		false,
		lsp,
		user_config_root,
		server_build.clone(),
	)
	.await?;
	if crate::launcher_build_is_stale(state_dir, server_build.as_str()) {
		drop(authority);
		return Ok(None);
	}
	Ok(authority)
}

#[cfg(unix)]
async fn connect_or_start_docserver(
	root: &Path,
	socket: &Path,
	connections: Option<watch::Sender<usize>>,
	require_ownership: bool,
	lsp: crate::docserver::NativeLspOptions,
	user_config_root: Option<PathBuf>,
	server_build: Str,
) -> Result<(DocumentHost, Option<DocumentAuthority>), EnvdError> {
	const HANDOFF_TIMEOUT: Duration = Duration::from_secs(5);
	const RETRY_STEP: Duration = Duration::from_millis(50);
	const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);

	let handoff_deadline = Instant::now() + HANDOFF_TIMEOUT;
	'connect_or_serve: loop {
		if let Ok(stream) = UnixStream::connect(socket).await {
			if require_ownership {
				return Err(document_authority_held(root));
			}
			match DocumentHost::connect_uds_stream(socket, stream).await {
				Ok(documents) => {
					validate_document_root(root, documents.hello().root_uri.as_str())?;
					if !omp_env::build_id::is_stale(
						server_build.as_str(),
						documents.hello().server_build.as_str(),
					) {
						return Ok((documents, None));
					}
					tracing::warn!(
						socket = %socket.display(),
						owner_build = %documents.hello().server_build,
						launcher_build = %server_build,
						"waiting for stale-build document daemon to drain"
					);
					drop(documents);
				},
				Err(error) if Instant::now() >= handoff_deadline => return Err(error.into()),
				Err(_) => {},
			}
			if Instant::now() >= handoff_deadline {
				return Err(document_authority_held(root));
			}
			time::sleep(RETRY_STEP).await;
			continue;
		}
		if let Some(parent) = socket.parent() {
			fs::create_dir_all(parent)?;
		}

		let shutdown = CancellationToken::new();
		let task_shutdown = shutdown.clone();
		let task_root = root.to_path_buf();
		let task_socket = socket.to_path_buf();
		let task_lsp = lsp.clone();
		let task_user_config_root = user_config_root.clone();
		let task_server_build = server_build.clone();
		let task_connections = connections.clone();
		let task = tokio::spawn(async move {
			crate::docserver::daemon::serve(
				task_root,
				daemon::Transport::Socket(task_socket),
				crate::docserver::daemon::ServeOptions {
					lsp_config_paths: Vec::new(),
					lsp:              task_lsp,
					user_config_root: task_user_config_root,
					shutdown:         Some(task_shutdown),
					server_build:     task_server_build,
					connections:      task_connections,
				},
			)
			.await
		});
		let mut authority = DocumentAuthority { shutdown, task: Some(task) };
		let startup_deadline = Instant::now() + STARTUP_TIMEOUT;
		loop {
			if let Some(result) = authority.finished_result().await {
				match result? {
					Ok(()) => return Err(EnvdError::DocserverExited),
					Err(error) if document_daemon_authority_held(&error) => {
						if Instant::now() >= handoff_deadline {
							return Err(document_authority_held(root));
						}
						time::sleep(RETRY_STEP).await;
						continue 'connect_or_serve;
					},
					Err(error) => return Err(EnvdError::Document(Str::from(error.to_string()))),
				}
			}
			if let Ok(stream) = UnixStream::connect(socket).await {
				match DocumentHost::connect_uds_stream(socket, stream).await {
					Ok(documents) => {
						validate_document_root(root, documents.hello().root_uri.as_str())?;
						if omp_env::build_id::is_stale(
							server_build.as_str(),
							documents.hello().server_build.as_str(),
						) {
							drop(documents);
							drop(authority);
							if Instant::now() >= handoff_deadline {
								return Err(document_authority_held(root));
							}
							time::sleep(RETRY_STEP).await;
							continue 'connect_or_serve;
						}
						return Ok((documents, Some(authority)));
					},
					Err(_) => {},
				}
			}
			if Instant::now() >= startup_deadline {
				return Err(
					io::Error::new(io::ErrorKind::TimedOut, "document-server hello timed out").into(),
				);
			}
			time::sleep(RETRY_STEP).await;
		}
	}
}

#[cfg(unix)]
fn document_daemon_authority_held(error: &daemon::Error) -> bool {
	match error {
		daemon::Error::AcquireAuthorityLock { .. } => true,
		daemon::Error::Document(crate::docserver::Error::Io { source, .. }) => {
			source.kind() == io::ErrorKind::WouldBlock
		},
		_ => false,
	}
}

fn document_authority_held(path: &Path) -> EnvdError {
	EnvdError::DocumentAuthorityHeldBy { path: path.to_path_buf(), holder: None }
}

#[cfg(windows)]
async fn connect_or_start_docserver(
	root: &Path,
	socket: &Path,
	connections: Option<watch::Sender<usize>>,
	require_ownership: bool,
	lsp: crate::docserver::NativeLspOptions,
	user_config_root: Option<PathBuf>,
	server_build: Str,
) -> Result<(DocumentHost, Option<DocumentAuthority>), EnvdError> {
	if let Ok(stream) = crate::docserver::windows::connect_owner_pipe(socket) {
		if require_ownership {
			return Err(document_authority_held(root));
		}
		let documents = DocumentHost::connect_pipe_stream(socket, stream).await?;
		validate_document_root(root, documents.hello().root_uri.as_str())?;
		if omp_env::build_id::is_stale(server_build.as_str(), documents.hello().server_build.as_str())
		{
			return Err(document_authority_held(root));
		}
		return Ok((documents, None));
	}
	let listener = OwnerPipeListener::bind(socket)?;
	let config = crate::docserver::ServerConfig::new(root)
		.map_err(|error| EnvdError::Document(Str::from(error.to_string())))?
		.with_server_build(server_build);
	let environment = crate::docserver::Environment::new(config)
		.map_err(|error| EnvdError::Document(Str::from(error.to_string())))?;
	if lsp.enabled {
		match crate::docserver::NativeLspSupervisor::discover(
			&environment,
			user_config_root.as_deref(),
		) {
			Ok(supervisor) => {
				environment.install_lsp_supervisor(supervisor.clone());
				if !lsp.lazy {
					supervisor.warm_all();
				}
			},
			Err(error) => {
				tracing::warn!(%error, "native LSP discovery failed; continuing without servers");
			},
		}
	}
	let shutdown = CancellationToken::new();
	let task_shutdown = shutdown.clone();
	let task = tokio::spawn(async move {
		crate::docserver::windows::serve_owner_pipe(
			environment,
			listener,
			ConnectionConfig::default(),
			task_shutdown,
			connections,
		)
		.await
	});
	let authority = DocumentAuthority { shutdown, task: Some(task) };
	let stream = crate::docserver::windows::connect_owner_pipe(socket)?;
	let documents = DocumentHost::connect_pipe_stream(socket, stream).await?;
	validate_document_root(root, documents.hello().root_uri.as_str())?;
	Ok((documents, Some(authority)))
}

fn validate_document_root(root: &Path, authority_root_uri: &str) -> Result<(), EnvdError> {
	let authority_root = Url::parse(authority_root_uri)
		.ok()
		.and_then(|uri| uri.to_file_path().ok())
		.and_then(|path| fs::canonicalize(path).ok());
	let expected_root = fs::canonicalize(root)?;
	if authority_root.as_deref() == Some(expected_root.as_path()) {
		Ok(())
	} else {
		Err(EnvdError::Document(sf!("document authority root does not match environment root")))
	}
}

/// Refuses standalone-daemon startup while another process serves the project
/// document authority.
///
/// A daemon must own its document authority: joining a foreign authority as a
/// client would chain daemon lifetimes across builds, keeping a draining
/// generation alive forever through the successor's own connection.
#[cfg(unix)]
async fn ensure_document_socket_free(root: &Path, socket: &Path) -> Result<(), EnvdError> {
	match UnixStream::connect(socket).await {
		Ok(_) => Err(document_authority_held(root)),
		Err(_) => Ok(()),
	}
}

#[cfg(unix)]
struct UnixSocketPathGuard {
	path: PathBuf,
	dev:  u64,
	ino:  u64,
}

#[cfg(unix)]
impl UnixSocketPathGuard {
	fn new(path: PathBuf, metadata: &fs::Metadata) -> Self {
		use std::os::unix::fs::MetadataExt as _;

		Self { path, dev: metadata.dev(), ino: metadata.ino() }
	}
}

#[cfg(unix)]
impl Drop for UnixSocketPathGuard {
	fn drop(&mut self) {
		use std::os::unix::fs::MetadataExt as _;

		if let Ok(metadata) = fs::symlink_metadata(&self.path)
			&& metadata.dev() == self.dev
			&& metadata.ino() == self.ino
		{
			let _ = fs::remove_file(&self.path);
		}
	}
}

#[cfg(unix)]
fn ensure_directory(path: &Path) -> io::Result<()> {
	use std::os::unix::fs::PermissionsExt as _;

	// A pre-existing parent (e.g. `/tmp`) is not ours to re-mode; chmod only
	// directories this call created.
	if fs::metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
		return Ok(());
	}
	fs::create_dir_all(path)?;
	fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}
#[cfg(all(test, unix))]
mod tests {
	use std::{fs, os::unix::fs::PermissionsExt as _, sync::Arc};

	use flume::Receiver;
	use omp_agent::{ApprovalBook, ApprovalDecision, ApprovalRoute, ApprovalScope, ApprovalSource};
	use omp_core::{EnvPath, Principal};
	use omp_env::{EnvClient, ExecEvent as ClientExecEvent};
	use omp_proto::{
		document::v1::{document_target, read_selection},
		env::v1::{self as env_pb, document_op, document_result},
	};
	use tokio::{
		io::{AsyncBufReadExt as _, BufReader, DuplexStream, duplex, split},
		net::{UnixListener, UnixStream},
		sync::watch,
		time,
	};

	use super::*;
	use crate::docserver::{
		Environment, ServerConfig,
		connection::{ConnectionConfig, serve_connection},
	};

	const TEST_DAP_SESSION_ID: [u8; 16] = [0x2a; 16];

	#[tokio::test]
	async fn late_diagnostics_batch_by_path_in_arrival_order() {
		use omp_session::late_diagnostics::{LateDiagnostics, LateDiagnosticsFile};

		let (sender, receiver) = flume::unbounded();
		let batcher = Arc::new(LateDiagnosticsBatcher {
			pending: parking_lot::Mutex::new(Vec::new()),
			scheduled: AtomicBool::new(false),
			active: AtomicBool::new(true),
			sender,
		});
		batcher.push(LateDiagnostics {
			files: vec![LateDiagnosticsFile {
				path:     sf!("src/lib.rs"),
				summary:  sf!("1 warning(s)"),
				errored:  false,
				messages: vec![sf!("src/lib.rs:9:1 [warning] [rustc] unused")],
			}],
		});
		batcher.push(LateDiagnostics {
			files: vec![LateDiagnosticsFile {
				path:     sf!("src/lib.rs"),
				summary:  sf!("1 error(s)"),
				errored:  true,
				messages: vec![sf!("src/lib.rs:2:1 [error] [rustc] broken (E1)")],
			}],
		});
		let event = time::timeout(Duration::from_secs(1), receiver.recv_async())
			.await
			.expect("batch deadline")
			.expect("batch event");
		let omp_agent::Up::Env(omp_agent::EnvEvent::LateDiagnostics(diagnostics)) = event else {
			panic!("expected late diagnostics");
		};
		assert_eq!(diagnostics.files.len(), 1);
		assert_eq!(diagnostics.files[0].summary, "1 error(s), 1 warning(s)");
		assert_eq!(
			diagnostics.files[0]
				.messages
				.iter()
				.map(Str::as_str)
				.collect::<Vec<_>>(),
			["src/lib.rs:9:1 [warning] [rustc] unused", "src/lib.rs:2:1 [error] [rustc] broken (E1)",]
		);
	}

	fn accepted_hello(grants: Grants, approval_mode: Option<ApprovalMode>) -> AcceptedHello {
		AcceptedHello { grants, capabilities: BTreeSet::new(), props: None, approval_mode }
	}

	#[test]
	fn wire_approval_modes_are_typed_and_unknown_values_are_rejected() {
		assert_eq!(approval_mode_from_wire(pb::ApprovalMode::Unspecified as i32), Ok(None));
		assert_eq!(
			approval_mode_from_wire(pb::ApprovalMode::Yolo as i32),
			Ok(Some(ApprovalMode::Yolo))
		);
		assert!(approval_mode_from_wire(i32::MAX).is_err());
	}
	#[test]
	fn unknown_tool_errors_explain_daemon_settings_and_eval_restart() {
		assert_eq!(
			unknown_tool_message("read"),
			"tool name and revision are not registered; project daemon settings differ; restart omp \
			 envd after changing tool settings"
		);
		assert_eq!(
			unknown_tool_message("eval"),
			"eval is disabled; restart the project daemon with --py-eval (omp envd)"
		);
	}
	#[test]
	fn eval_reset_is_environment_only() {
		assert!(requires_environment_host(&client_frame::Body::EvalReset(pb::EvalResetRequest {}),));
	}

	#[test]
	fn blob_io_is_available_on_session_hosts() {
		assert!(!requires_environment_host(&client_frame::Body::BlobStat(
			blob_pb::StatRequest::default(),
		)));
		assert!(!requires_environment_host(&client_frame::Body::BlobGet(
			blob_pb::GetRequest::default(),
		)));
		assert!(!requires_environment_host(&client_frame::Body::BlobPutChunk(
			blob_pb::Chunk::default(),
		)));
		assert!(!requires_environment_host(&client_frame::Body::BlobPutCommit(
			pb::CommitBlobPut::default(),
		)));
		assert!(!requires_environment_host(&client_frame::Body::BlobDelete(
			blob_pb::DeleteRequest::default(),
		)));
	}

	#[tokio::test]
	async fn environment_host_acknowledges_eval_reset() {
		let (requests, responses, _root, _state) = test_connection(&[], false).await;
		requests
			.send_async(pb::ClientFrame {
				request_id: 1,
				body: Some(client_frame::Body::EvalReset(pb::EvalResetRequest {})),
				..pb::ClientFrame::default()
			})
			.await
			.expect("send eval reset");
		assert!(matches!(
			responses
				.recv_async()
				.await
				.expect("eval reset response")
				.body,
			Some(server_frame::Body::EvalReset(pb::EvalResetResponse {}))
		));
	}
	/// Owner-local connections may run eval on this host; extension-host
	/// connections are the one class the eval guard still rejects.
	#[tokio::test]
	async fn host_keyed_connections_cannot_invoke_eval() {
		let (requests, responses, _root, _state) = test_connection(&["invocation"], false).await;
		requests
			.send_async(pb::ClientFrame {
				request_id: 7,
				body: Some(client_frame::Body::InvokeTool(pb::InvokeTool {
					invocation_id: "host-eval-denied".into(),
					name: "eval".into(),
					rev: "1".into(),
					..pb::InvokeTool::default()
				})),
				..pb::ClientFrame::default()
			})
			.await
			.expect("send eval invoke");
		let frame = responses.recv_async().await.expect("eval denial response");
		let Some(server_frame::Body::Error(error)) = frame.body else {
			panic!("host-keyed eval invoke was not denied: {:?}", frame.body);
		};
		assert_eq!(error.code, pb::ProtocolErrorCode::PermissionDenied as i32);
		assert_eq!(error.message, "eval is denied to extension-host connections");
	}

	#[tokio::test]
	async fn edit_repair_route_sends_typed_query_and_accepts_matching_answer() {
		use omp_tools::edit::observer::EditRepairPrompt;

		let (responses, queries) = flume::unbounded();
		let route = ConnectionEditRepairRoute {
			request_id: 41,
			invocation_id: sf!("inv-41"),
			responses,
			next_query: Arc::new(AtomicU64::new(1)),
			pending: Arc::new(Mutex::new(None)),
		};
		let completion = tokio::spawn({
			let route = route.clone();
			async move {
				route
					.complete(EditRepairPrompt {
						language:         sf!("rust"),
						before:           Str::new_static("fn ok() {}"),
						after:            Str::new_static("fn bad( {}"),
						previous_attempt: None,
					})
					.await
			}
		});
		let query = queries.recv_async().await.expect("repair query");
		assert_eq!(query.request_id, 41);
		let Some(server_frame::Body::EditRepairQuery(query)) = query.body else {
			panic!("expected typed edit repair query");
		};
		assert_eq!(query.invocation_id, "inv-41");
		assert_eq!(query.prompt.expect("prompt").language, "rust");
		route
			.answer(pb::EditRepairAnswer {
				invocation_id: "inv-41".to_owned(),
				body:          Some(pb::edit_repair_answer::Body::Content("fn fixed() {}".to_owned())),
			})
			.expect("matching answer");
		assert_eq!(completion.await.expect("completion task"), Ok(Str::new_static("fn fixed() {}")));
		assert!(matches!(
			route.answer(pb::EditRepairAnswer {
				invocation_id: "inv-41".to_owned(),
				body:          Some(pb::edit_repair_answer::Body::Content("duplicate".to_owned())),
			}),
			Err((pb::ProtocolErrorCode::PreconditionFailed, _))
		));
	}

	#[tokio::test]
	async fn edit_repair_route_rejects_cross_invocation_and_disconnects_pending() {
		use omp_tools::edit::observer::{EditRepairError, EditRepairPrompt};

		let (responses, queries) = flume::unbounded();
		let route = ConnectionEditRepairRoute {
			request_id: 9,
			invocation_id: sf!("inv-9"),
			responses,
			next_query: Arc::new(AtomicU64::new(1)),
			pending: Arc::new(Mutex::new(None)),
		};
		let completion = tokio::spawn({
			let route = route.clone();
			async move {
				route
					.complete(EditRepairPrompt {
						language:         sf!("typescript"),
						before:           sf!("const a = 1;"),
						after:            sf!("const a = ;"),
						previous_attempt: None,
					})
					.await
			}
		});
		queries.recv_async().await.expect("repair query");
		assert!(matches!(
			route.answer(pb::EditRepairAnswer {
				invocation_id: "other-invocation".to_owned(),
				body:          Some(pb::edit_repair_answer::Body::Content("crossed".to_owned())),
			}),
			Err((pb::ProtocolErrorCode::InvalidArgument, _))
		));
		route.disconnect();
		assert_eq!(completion.await.expect("completion task"), Err(EditRepairError::Unavailable));
	}

	async fn test_connection(
		capabilities: &[&str],
		with_dap: bool,
	) -> (
		flume::Sender<pb::ClientFrame>,
		Receiver<pb::ServerFrame>,
		tempfile::TempDir,
		tempfile::TempDir,
	) {
		let host = HostKey::new("workspace", "sandboxed", "envd-test");
		test_connection_scoped(capabilities, with_dap, host.clone(), host, true).await
	}

	async fn test_external_connection(
		capabilities: &[&str],
		with_dap: bool,
	) -> (
		flume::Sender<pb::ClientFrame>,
		Receiver<pb::ServerFrame>,
		tempfile::TempDir,
		tempfile::TempDir,
	) {
		let host = HostKey::new("workspace", "sandboxed", "envd-test");
		test_connection_scoped(capabilities, with_dap, host.clone(), host, false).await
	}

	async fn test_connection_scoped(
		capabilities: &[&str],
		with_dap: bool,
		policy_host: HostKey,
		authority_host: HostKey,
		extension_policy: bool,
	) -> (
		flume::Sender<pb::ClientFrame>,
		Receiver<pb::ServerFrame>,
		tempfile::TempDir,
		tempfile::TempDir,
	) {
		let root = tempfile::tempdir().expect("workspace");
		let state = tempfile::tempdir().expect("state");
		let workspace = WorkspaceHost::open(root.path()).expect("workspace host");
		let document_config = ServerConfig::new(root.path())
			.expect("document config")
			.with_server_build("envd-test");
		let document_environment = Environment::new(document_config).expect("document environment");
		if with_dap {
			install_test_dap(&document_environment).await;
		}
		let (document_client, document_server) = duplex(64 * 1024);
		tokio::spawn(async move {
			let _ =
				serve_connection(document_environment, document_server, ConnectionConfig::default())
					.await;
		});
		let documents = DocumentHost::connect(document_client)
			.await
			.expect("document host");
		let hello = documents.hello().clone();
		let exec = ExecHost::new();
		let blobs = BlobHost::open(state.path().join("blobs")).expect("blob host");
		let schedules =
			DurableScheduleActor::spawn(state.path()).expect("durable schedule actor");
		let workspace_ops = WorkspaceOperations::open(
			workspace.clone(),
			documents.clone(),
			blobs.clone(),
			state.path().join("workspace-ops"),
		)
		.expect("workspace operations");
		let ext_hosts = ExtHostSupervisor::spawn(ExtHostConfig::new(
			PathBuf::from("unused"),
			Principal::new(sf!("test-principal"), sf!("Test Principal")),
			sf!("test-session"),
			1,
		))
		.await
		.expect("empty extension supervisor");
		let memory_runtime = start_memory_runtime(
			&HostSettings::default(),
			state.path(),
			workspace.root(),
			&sf!("test-session"),
		)
		.await
		.expect("memory runtime");
		let mcp = McpService::open(state.path().join("mcp-cache.sqlite3")).expect("MCP service");
		let mcp_manager = McpManager::new(
			Arc::clone(&mcp),
			Arc::new(ProductionConnector::new(workspace.root().to_path_buf())),
			Arc::from([hello.root_uri.clone()]),
			state.path().join("mcp-local"),
		);
		mcp.bind_manager(&mcp_manager);
		let server = Arc::new(EnvServer::new(
			ServerIdentity {
				workspace_id:   hello.workspace_id,
				root_uri:       hello.root_uri,
				server_epoch:   hello.server_epoch,
				server_version: sf!("test"),
				server_build:   sf!("envd-test"),
			},
			Some(EnvironmentAuthorities {
				documents,
				_document_authority: None,
				workspace_ops,
				lsp_settings: LspSettings::default(),
				process_store: ProcessStore::new(state.path().join("processes/meta.json")),
			}),
			ToolSettings::default(),
			exec,
			AcpExecSlot::default(),
			workspace.clone(),
			mcp,
			mcp_manager,
			Arc::new(ResolverTable::default()),
			memory_runtime,
			blobs.clone(),
			SiteMaterializer::open(state.path().join("ext"), blobs.store().clone())
				.expect("site materializer"),
			ResourceMaterializer::open(
				workspace.root(),
				state.path(),
				&state.path().join("sessions/test/local"),
			)
			.expect("resource materializer"),
			Arc::new(Registry::new()),
			PresenterSlot::new(Arc::new(omp_tools::ask::HeadlessPresenter)),
			Arc::new(ext_hosts),
			Arc::new(SessionBridgeHost::new()),
			Arc::new(ReflectionBridgeHost::new()),
			EvalSessionControl::default(),
			Arc::new(SearchBridgeHost::new(None)),
			Arc::new(GithubCredentialBridge::new()),
			omp_ai::operation::usage::UsageFetcherRegistry::default(),
			omp_ai::ProviderResponseHooks::default(),
			Arc::new(HookGate::channel().0),
			AgentCheckpointControl::default(),
			StagedProposalRegistry::new(),
			schedules,
			Arc::new(AuthorityTable::default()),
			state.path(),
		));
		let grants = Grants::supported(capabilities.iter().copied());
		server
			.authority
			.register_host(authority_host.clone(), grants.clone());
		server
			.authority
			.open(authority_host.clone(), sf!("test-invocation"));
		server
			.authority
			.authorize(
				&authority_host,
				"test-invocation",
				Bytes::from_static(b"test-effect-token"),
				grants.clone(),
				100,
				1,
				1,
			)
			.expect("authorize test invocation");
		let policy = if extension_policy {
			ConnectionPolicy::extension(policy_host, grants.iter())
		} else {
			ConnectionPolicy::external(None)
		};
		let (requests, request_rx) = flume::bounded(16);
		let (responses, response_rx) = flume::bounded(16);
		tokio::spawn(async move {
			server.serve_frames(request_rx, responses, policy).await;
		});
		requests
			.send_async(pb::ClientFrame {
				request_id: 0,
				body:       Some(client_frame::Body::Hello(pb::ClientHello {
					client:        "envd-test".to_owned(),
					schema_rev:    omp_proto::SCHEMA_REV,
					capabilities:  capabilities
						.iter()
						.map(|capability| (*capability).to_owned())
						.collect(),
					client_id:     Bytes::new(),
					approval_mode: pb::ApprovalMode::Unspecified as i32,
					props:         Default::default(),
				})),
				props:      Default::default(),
				scope:      None,
			})
			.await
			.expect("send hello");
		assert!(matches!(
			response_rx.recv_async().await.expect("server hello").body,
			Some(server_frame::Body::Hello(_))
		));
		(requests, response_rx, root, state)
	}

	async fn install_test_dap(environment: &Environment) {
		let (client, adapter) = duplex(64 * 1024);
		tokio::spawn(fake_dap_adapter(adapter));
		let (reader, writer) = split(client);
		let session = crate::docserver::DapSession::start(
			omp_core::hex::encode_n(&TEST_DAP_SESSION_ID).as_str(),
			"test",
			crate::docserver::DapProtocol::from_streams(reader, writer),
			false,
			serde_json::Map::new(),
			None,
		)
		.await
		.expect("start fake DAP session");
		session.set_wire_grants(true, true, 4096);
		environment.dap_sessions().insert(session);
	}

	async fn fake_dap_adapter(stream: DuplexStream) {
		let (reader, mut writer) = split(stream);
		let mut reader = BufReader::new(reader);
		let mut next_seq = 1_i64;
		loop {
			let mut content_length = None;
			loop {
				let mut line = String::new();
				if reader
					.read_line(&mut line)
					.await
					.ok()
					.filter(|read| *read > 0)
					.is_none()
				{
					return;
				}
				if line == "\r\n" {
					break;
				}
				if let Some(length) = line.strip_prefix("Content-Length: ") {
					content_length = length.trim().parse::<usize>().ok();
				}
			}
			let Some(content_length) = content_length else {
				return;
			};
			let mut body = vec![0; content_length];
			if reader.read_exact(&mut body).await.is_err() {
				return;
			}
			let Ok(request) = serde_json::from_slice::<serde_json::Value>(&body) else {
				return;
			};
			let Some(request_seq) = request.get("seq").and_then(serde_json::Value::as_i64) else {
				continue;
			};
			let Some(command) = request.get("command").and_then(serde_json::Value::as_str) else {
				continue;
			};
			if command == "launch" {
				if write_fake_dap_message(
					&mut writer,
					&serde_json::json!({
						"seq": next_seq,
						"type": "event",
						"event": "initialized",
						"body": {},
					}),
				)
				.await
				.is_err()
				{
					return;
				}
				next_seq += 1;
			}
			if command == "variables" {
				if write_fake_dap_message(
					&mut writer,
					&serde_json::json!({
						"seq": next_seq,
						"type": "event",
						"event": "output",
						"body": {"category": "console", "output": "ready\n"},
					}),
				)
				.await
				.is_err()
				{
					return;
				}
				next_seq += 1;
			}
			let response_body = if command == "variables" {
				serde_json::json!({"variables": [{"name": "answer", "value": "42", "variablesReference": 0}]})
			} else {
				serde_json::json!({})
			};
			if write_fake_dap_message(
				&mut writer,
				&serde_json::json!({
					"seq": next_seq,
					"type": "response",
					"request_seq": request_seq,
					"command": command,
					"success": true,
					"body": response_body,
				}),
			)
			.await
			.is_err()
			{
				return;
			}
			next_seq += 1;
		}
	}

	async fn write_fake_dap_message<W>(writer: &mut W, message: &serde_json::Value) -> io::Result<()>
	where
		W: AsyncWrite + Unpin,
	{
		let body = serde_json::to_vec(message).map_err(io::Error::other)?;
		let header = format!("Content-Length: {}\r\n\r\n", body.len());
		writer.write_all(header.as_bytes()).await?;
		writer.write_all(&body).await?;
		writer.flush().await
	}

	fn data_frame(request_id: u64, body: data_request::Body) -> pb::ClientFrame {
		pb::ClientFrame {
			request_id,
			body: Some(client_frame::Body::Data(pb::DataRequest {
				body:  Some(body),
				props: Default::default(),
			})),
			scope: Some(pb::InvocationScope {
				invocation_id: "test-invocation".to_owned(),
				effect_token: Bytes::from_static(b"test-effect-token"),
				host_generation: 1,
				session_generation: 1,
				..Default::default()
			}),
			props: Default::default(),
		}
	}

	fn stat_data_frame(request_id: u64, root: &Path) -> pb::ClientFrame {
		data_frame(
			request_id,
			data_request::Body::Document(pb::DocumentOp {
				op:    Some(document_op::Op::Stat(document_pb::StatPathRequest {
					uri:             Url::from_file_path(root)
						.expect("workspace URI")
						.to_string(),
					follow_symlinks: document_pb::FollowSymlinks::Yes as i32,
				})),
				props: Default::default(),
			}),
		)
	}

	#[tokio::test]
	async fn extension_socket_is_owner_only_and_removed_on_shutdown() {
		let root = tempfile::tempdir().expect("workspace");
		let state = tempfile::tempdir().expect("state");
		let con = Arc::new(Ctx::new());
		let convars = Arc::new(crate::exthost::ConvarControlFactory::new(Arc::clone(&con)));
		let server = Arc::new(
			EnvServer::open_local(
				root.path(),
				state.path(),
				Registry::new(),
				ExtHostConfig::new(
					PathBuf::from("unused"),
					Principal::new(sf!("test-principal"), sf!("Test Principal")),
					sf!("test-session"),
					1,
				),
				&con,
				convars,
				RegistryBridges::default(),
			)
			.await
			.expect("local environment"),
		);
		let binding = ExtensionDataBinding::scoped(
			state.path(),
			HostKey::new("workspace", "trusted", "socket-mode"),
			"test-session",
			1,
			Grants::supported(["env.fs.read"]),
		);
		let socket = binding.path().to_path_buf();
		let shutdown = CancellationToken::new();
		let task = tokio::spawn(Arc::clone(&server).serve_extension_uds(binding, shutdown.clone()));
		if time::timeout(Duration::from_secs(2), async {
			while !socket.exists() {
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await
		.is_err()
		{
			let serve = time::timeout(Duration::from_secs(1), task).await;
			panic!("extension socket was not published; serve result: {serve:?}");
		}
		let mode = fs::metadata(&socket)
			.expect("extension socket metadata")
			.permissions()
			.mode();
		assert_eq!(mode & 0o777, 0o600);
		let _accepted = UnixStream::connect(&socket)
			.await
			.expect("connect extension socket before teardown");
		task.abort();
		assert!(
			task
				.await
				.expect_err("aborted extension socket task unexpectedly completed")
				.is_cancelled()
		);
		assert!(!socket.exists(), "extension socket survived task teardown");
	}

	#[tokio::test]
	async fn extension_policy_rejects_other_host_authority() {
		let policy_host = HostKey::new("workspace", "trusted", "extension-a");
		let authority_host = HostKey::new("workspace", "trusted", "extension-b");
		let (requests, responses, root, _state) =
			test_connection_scoped(&["env.fs.read"], false, policy_host, authority_host, true).await;
		requests
			.send_async(stat_data_frame(1, root.path()))
			.await
			.expect("send cross-host stat");
		assert!(matches!(
			responses.recv_async().await.expect("cross-host denial").body,
			Some(server_frame::Body::Error(pb::ProtocolError { code, .. }))
				if code == pb::ProtocolErrorCode::Uncommitted as i32
		));
	}

	#[tokio::test]
	async fn extension_policy_denies_ungranted_operation_before_dispatch() {
		let (requests, responses, root, _state) = test_connection(&[], false).await;
		requests
			.send_async(stat_data_frame(1, root.path()))
			.await
			.expect("send ungranted stat");
		assert!(matches!(
			responses.recv_async().await.expect("grant denial").body,
			Some(server_frame::Body::Error(pb::ProtocolError { code, .. }))
				if code == pb::ProtocolErrorCode::PermissionDenied as i32
		));
	}

	#[tokio::test]
	async fn extension_policy_rejects_unscoped_data() {
		let (requests, responses, root, _state) = test_connection(&["env.fs.read"], false).await;
		let body = data_request::Body::Document(pb::DocumentOp {
			op:    Some(document_op::Op::Stat(document_pb::StatPathRequest {
				uri:             Url::from_file_path(root.path())
					.expect("workspace URI")
					.to_string(),
				follow_symlinks: document_pb::FollowSymlinks::Yes as i32,
			})),
			props: Default::default(),
		});
		requests
			.send_async(unscoped_data_frame(1, body))
			.await
			.expect("send unscoped extension stat");
		assert!(matches!(
			responses.recv_async().await.expect("unscoped denial").body,
			Some(server_frame::Body::Error(pb::ProtocolError { code, .. }))
				if code == pb::ProtocolErrorCode::Uncommitted as i32
		));
	}

	#[tokio::test]
	async fn extension_policy_rejects_stale_host_generation() {
		let (requests, responses, root, _state) = test_connection(&["env.fs.read"], false).await;
		let mut frame = stat_data_frame(1, root.path());
		frame.scope.as_mut().expect("DATA scope").host_generation = 2;
		requests
			.send_async(frame)
			.await
			.expect("send stale-generation stat");
		assert!(matches!(
			responses.recv_async().await.expect("stale-generation denial").body,
			Some(server_frame::Body::Error(pb::ProtocolError { code, .. }))
				if code == pb::ProtocolErrorCode::PreconditionFailed as i32
		));
	}

	#[tokio::test]
	async fn concurrent_extensions_cannot_reuse_each_others_endpoint() {
		let root = tempfile::tempdir().expect("workspace");
		let state = tempfile::tempdir().expect("state");
		let con = Arc::new(Ctx::new());
		let convars = Arc::new(crate::exthost::ConvarControlFactory::new(Arc::clone(&con)));
		let server = Arc::new(
			EnvServer::open_local(
				root.path(),
				state.path(),
				Registry::new(),
				ExtHostConfig::new(
					PathBuf::from("unused"),
					Principal::new(sf!("test-principal"), sf!("Test Principal")),
					sf!("test-session"),
					1,
				),
				&con,
				convars,
				RegistryBridges::default(),
			)
			.await
			.expect("local environment"),
		);
		let host_a = HostKey::new("workspace", "trusted", "extension-a");
		let host_b = HostKey::new("workspace", "trusted", "extension-b");
		let grants = Grants::supported(["env.fs.read"]);
		let binding_a = ExtensionDataBinding::scoped(
			state.path(),
			host_a.clone(),
			"test-session",
			1,
			grants.clone(),
		);
		let binding_b = ExtensionDataBinding::scoped(
			state.path(),
			host_b.clone(),
			"test-session",
			1,
			grants.clone(),
		);
		let socket_a = binding_a.path().to_path_buf();
		let socket_b = binding_b.path().to_path_buf();
		assert_ne!(socket_a, socket_b);
		let shutdown = CancellationToken::new();
		let task_a =
			tokio::spawn(Arc::clone(&server).serve_extension_uds(binding_a, shutdown.clone()));
		let task_b =
			tokio::spawn(Arc::clone(&server).serve_extension_uds(binding_b, shutdown.clone()));
		time::timeout(Duration::from_secs(2), async {
			while !socket_a.exists() || !socket_b.exists() {
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await
		.expect("extension sockets were not published");
		for (host, invocation, token) in [
			(&host_a, "invocation-a", Bytes::from_static(b"effect-a")),
			(&host_b, "invocation-b", Bytes::from_static(b"effect-b")),
		] {
			server.authority.open(host.clone(), Str::new(invocation));
			server
				.authority
				.authorize(host, invocation, token, grants.clone(), 100, 1, 1)
				.expect("authorize extension invocation");
		}
		let hello = pb::ClientHello {
			client: "envd-extension-test".to_owned(),
			schema_rev: omp_proto::SCHEMA_REV,
			capabilities: vec!["env.fs.read".to_owned()],
			..Default::default()
		};
		let crossed = omp_env::ExtensionEnvClient::connect_uds(
			&socket_a,
			&hello,
			omp_env::DataScope::new(sf!("invocation-b"), Bytes::from_static(b"effect-b"), 1, 1),
		)
		.await
		.expect("connect B authority to A endpoint");
		let probe = root.path().join("endpoint-probe.txt");
		fs::write(&probe, b"endpoint isolation").expect("write endpoint probe");
		let request = pb::DataRequest {
			body:  Some(data_request::Body::Document(pb::DocumentOp {
				op:    Some(document_op::Op::Stat(document_pb::StatPathRequest {
					uri:             Url::from_file_path(&probe)
						.expect("workspace probe URI")
						.to_string(),
					follow_symlinks: document_pb::FollowSymlinks::Yes as i32,
				})),
				props: Default::default(),
			})),
			props: Default::default(),
		};
		crossed
			.request(request.clone())
			.await
			.expect_err("extension B reused extension A endpoint");
		let own = omp_env::ExtensionEnvClient::connect_uds(
			&socket_b,
			&hello,
			omp_env::DataScope::new(sf!("invocation-b"), Bytes::from_static(b"effect-b"), 1, 1),
		)
		.await
		.expect("connect B authority to B endpoint");
		own.request(request)
			.await
			.expect("extension B uses its own endpoint");
		shutdown.cancel();
		task_a
			.await
			.expect("extension A socket task")
			.expect("extension A socket shutdown");
		task_b
			.await
			.expect("extension B socket task")
			.expect("extension B socket shutdown");
	}

	/// App-authority DATA frame: no invocation scope, so admission rides the
	/// connection grants rather than the worker effect envelope.
	fn unscoped_data_frame(request_id: u64, body: data_request::Body) -> pb::ClientFrame {
		pb::ClientFrame {
			request_id,
			body: Some(client_frame::Body::Data(pb::DataRequest {
				body:  Some(body),
				props: Default::default(),
			})),
			scope: None,
			props: Default::default(),
		}
	}

	#[tokio::test]
	async fn dap_read_action_streams_output_before_revision_fenced_response() {
		let (requests, responses, _root, _state) =
			test_external_connection(&["env.dap.read", "env.dap.execute"], true).await;
		requests
			.send_async(unscoped_data_frame(
				1,
				data_request::Body::DapAction(document_pb::DapActionRequest {
					session:             Some(document_pb::DapSessionRef {
						session_id: Bytes::copy_from_slice(&TEST_DAP_SESSION_ID),
						generation: 1,
						revision:   1,
					}),
					expected_revision:   1,
					required_capability: document_pb::DapCapability::Read as i32,
					command:             "variables".to_owned(),
					arguments_json:      Bytes::from_static(b"{\"variablesReference\":0}"),
					max_response_bytes:  4096,
					timeout_ms:          0,
				}),
			))
			.await
			.expect("send DAP read action");
		let output = responses.recv_async().await.expect("DAP output event");
		assert!(matches!(
			output.body,
			Some(server_frame::Body::DataEvent(pb::DataEvent {
				body: Some(data_event::Body::DapOutput(document_pb::DapOutput {
					sequence: 1,
					ref output,
					..
				})),
				..
			})) if output.as_ref() == b"ready\n"
		));
		let response = responses.recv_async().await.expect("DAP action response");
		let Some(server_frame::Body::Data(pb::DataResponse {
			body: Some(data_response::Body::DapAction(response)),
			..
		})) = response.body
		else {
			panic!("expected DAP action response");
		};
		assert!(response.success);
		assert_eq!(response.session.expect("response session").revision, 2);
		assert!(
			response
				.body_json
				.windows(b"answer".len())
				.any(|window| window == b"answer")
		);
	}

	#[tokio::test]
	async fn dap_mutation_is_denied_by_read_only_grants_before_session_effects() {
		let (requests, responses, _root, _state) = test_connection(&["env.dap.read"], true).await;
		requests
			.send_async(data_frame(
				1,
				data_request::Body::DapAction(document_pb::DapActionRequest {
					session:             Some(document_pb::DapSessionRef {
						session_id: Bytes::copy_from_slice(&TEST_DAP_SESSION_ID),
						generation: 1,
						revision:   1,
					}),
					expected_revision:   1,
					required_capability: document_pb::DapCapability::Execute as i32,
					command:             "continue".to_owned(),
					arguments_json:      Bytes::from_static(b"{}"),
					max_response_bytes:  4096,
					timeout_ms:          0,
				}),
			))
			.await
			.expect("send denied DAP mutation");
		assert!(matches!(
			responses.recv_async().await.expect("DAP denial").body,
			Some(server_frame::Body::Error(pb::ProtocolError { code, .. }))
				if code == pb::ProtocolErrorCode::PermissionDenied as i32
		));
	}

	#[tokio::test]
	async fn repository_snapshot_returns_only_granted_canonical_root_uris() {
		let (requests, responses, root, _state) = test_connection(&["env.search"], false).await;
		let initialized = process::Command::new("git")
			.current_dir(root.path())
			.args(["init", "-b", "main"])
			.output()
			.expect("fixture Git should launch");
		assert!(
			initialized.status.success(),
			"fixture Git init failed: {}",
			String::from_utf8_lossy(&initialized.stderr)
		);
		requests
			.send_async(data_frame(
				1,
				data_request::Body::RepositorySnapshot(pb::RepositorySnapshotRequest {
					root_uri:          Url::from_directory_path(root.path())
						.expect("workspace URI")
						.to_string(),
					max_changed_paths: 16,
					wire_revision:     omp_proto::SCHEMA_REV,
				}),
			))
			.await
			.expect("send repository snapshot");
		let response = responses.recv_async().await.expect("snapshot response");
		let Some(server_frame::Body::Data(pb::DataResponse {
			body: Some(data_response::Body::RepositorySnapshot(snapshot)),
			..
		})) = response.body
		else {
			panic!("expected repository snapshot response");
		};
		assert_eq!(snapshot.availability, pb::RepositoryAvailability::Available as i32);
		assert_eq!(
			Url::parse(&snapshot.worktree_root_uri)
				.expect("worktree URI")
				.to_file_path()
				.expect("worktree file URI"),
			fs::canonicalize(root.path()).expect("canonical workspace")
		);
		assert_eq!(snapshot.worktree_root_uri, snapshot.primary_root_uri);
		assert!(snapshot.revision > 0);

		let outside = tempfile::tempdir().expect("outside root");
		requests
			.send_async(data_frame(
				2,
				data_request::Body::RepositorySnapshot(pb::RepositorySnapshotRequest {
					root_uri:          Url::from_directory_path(outside.path())
						.expect("outside URI")
						.to_string(),
					max_changed_paths: 0,
					wire_revision:     omp_proto::SCHEMA_REV,
				}),
			))
			.await
			.expect("send outside snapshot");
		assert!(matches!(
			responses.recv_async().await.expect("outside response").body,
			Some(server_frame::Body::Error(pb::ProtocolError {
				code,
				..
			})) if code == pb::ProtocolErrorCode::PermissionDenied as i32
		));
	}

	#[tokio::test]
	async fn extension_unpinned_read_works_and_site_write_is_refused_even_with_grant() {
		let (requests, responses, root, _state) =
			test_connection(&["env.doc.read", "env.site"], false).await;
		let path = root.path().join("sample.txt");
		fs::write(&path, b"hello document").expect("write document");
		let uri = Url::from_file_path(&path)
			.expect("document URI")
			.to_string();
		requests
			.send_async(data_frame(
				1,
				data_request::Body::Document(pb::DocumentOp {
					op:    Some(document_op::Op::Open(document_pb::OpenDocumentRequest {
						uri,
						language_id: "text".to_owned(),
					})),
					props: Default::default(),
				}),
			))
			.await
			.expect("send open");
		let opened = responses.recv_async().await.expect("open response");
		let Some(server_frame::Body::Data(pb::DataResponse {
			body:
				Some(data_response::Body::Document(pb::DocumentResult {
					result: Some(document_result::Result::Opened(opened)),
					..
				})),
			..
		})) = opened.body
		else {
			panic!("expected document open response");
		};
		let opened_revision = opened.head.as_ref().and_then(|head| head.revision.clone());
		requests
			.send_async(data_frame(
				2,
				data_request::Body::Document(pb::DocumentOp {
					op:    Some(document_op::Op::Read(document_pb::ReadDocumentRequest {
						document:  Some(document_pb::DocumentTarget {
							target: Some(document_target::Target::LeaseId(opened.lease_id)),
						}),
						revision:  None,
						selection: Some(document_pb::ReadSelection {
							selection: Some(read_selection::Selection::Whole(
								document_pb::WholeDocument::default(),
							)),
						}),
					})),
					props: Default::default(),
				}),
			))
			.await
			.expect("send read");
		let read = responses.recv_async().await.expect("read response");
		let Some(server_frame::Body::Data(pb::DataResponse {
			body:
				Some(data_response::Body::Document(pb::DocumentResult {
					result: Some(document_result::Result::Read(read)),
					..
				})),
			..
		})) = read.body
		else {
			panic!("expected document read response");
		};
		assert_eq!(read.head.as_ref().and_then(|head| head.revision.clone()), opened_revision);
		requests
			.send_async(data_frame(3, data_request::Body::Site(env_pb::MaterializeSite::default())))
			.await
			.expect("send extension site write");
		let denied = responses.recv_async().await.expect("site refusal response");
		assert!(matches!(
			denied.body,
			Some(server_frame::Body::Error(pb::ProtocolError { code, .. }))
				if code == pb::ProtocolErrorCode::PermissionDenied as i32
		));
	}

	#[tokio::test]
	async fn data_walk_and_search_stream_incrementally_to_completion() {
		let (requests, responses, root, _state) =
			test_connection(&["env.walk", "env.search"], false).await;
		fs::write(root.path().join("a.txt"), b"needle\n").expect("write first");
		fs::write(root.path().join("b.txt"), b"other needle\n").expect("write second");
		requests
			.send_async(data_frame(
				10,
				data_request::Body::Walk(pb::WalkRequest {
					root_uri: String::new(),
					options:  None,
					include:  Vec::new(),
					exclude:  Vec::new(),
					limit:    None,
					props:    Default::default(),
				}),
			))
			.await
			.expect("send walk");
		let mut walk_entries = 0;
		loop {
			match responses.recv_async().await.expect("walk event").body {
				Some(server_frame::Body::DataEvent(pb::DataEvent {
					body: Some(data_event::Body::WalkEntry(_)),
					..
				})) => walk_entries += 1,
				Some(server_frame::Body::DataEvent(pb::DataEvent {
					body: Some(data_event::Body::WalkComplete(_)),
					..
				})) => break,
				other => panic!("unexpected walk frame: {other:?}"),
			}
		}
		assert!(walk_entries >= 2);
		requests
			.send_async(data_frame(
				11,
				data_request::Body::Search(pb::SearchRequest {
					walk:           Some(pb::WalkRequest {
						root_uri: String::new(),
						options:  None,
						include:  Vec::new(),
						exclude:  Vec::new(),
						limit:    None,
						props:    Default::default(),
					}),
					pattern:        Bytes::from_static(b"needle"),
					case_sensitive: true,
					limit:          None,
					props:          Default::default(),
				}),
			))
			.await
			.expect("send search");
		let mut matches = 0;
		loop {
			match responses.recv_async().await.expect("search event").body {
				Some(server_frame::Body::DataEvent(pb::DataEvent {
					body: Some(data_event::Body::SearchMatch(_)),
					..
				})) => matches += 1,
				Some(server_frame::Body::DataEvent(pb::DataEvent {
					body: Some(data_event::Body::SearchComplete(_)),
					..
				})) => break,
				other => panic!("unexpected search frame: {other:?}"),
			}
		}
		assert_eq!(matches, 2);
	}

	#[test]
	fn connection_stream_state_and_cleanup_are_isolated() {
		let grants = Grants::supported(["env.search"]);
		let authority = Arc::new(AuthorityTable::default());
		let policy = ConnectionPolicy::in_process();
		let mut first = ConnectionState::new(
			ExecHost::new(),
			accepted_hello(grants.clone(), None),
			&ToolSettings::default(),
			Arc::clone(&authority),
			&policy,
		);
		let second = ConnectionState::new(
			ExecHost::new(),
			accepted_hello(grants, None),
			&ToolSettings::default(),
			authority,
			&policy,
		);
		let cancel = CancellationToken::new();
		first
			.requests
			.insert(41, RequestState::DataStream { cancel: cancel.clone() });
		assert!(!second.requests.contains_key(&41));
		let exec = first.exec_host.clone();
		first.cancel_all(&exec);
		let state = tempfile::tempdir().expect("binding state");
		let first_binding = ExtensionDataBinding::built_in(
			state.path(),
			HostKey::new("workspace", "trusted", "first"),
			"session",
			7,
		);
		let second_binding = ExtensionDataBinding::built_in(
			state.path(),
			HostKey::new("workspace", "trusted", "second"),
			"session",
			7,
		);
		assert_ne!(first_binding.path(), second_binding.path());
		assert!(first_binding.grants().contains("env.doc.read"));
		assert!(first_binding.grants().contains("env.search"));
		assert!(!first_binding.grants().contains("*"));
		assert!(cancel.is_cancelled());
		assert!(first.requests.is_empty());
	}

	#[test]
	fn approval_overrides_are_connection_local() {
		let grants = Grants::all();
		let authority = Arc::new(AuthorityTable::default());
		let policy = ConnectionPolicy::in_process();
		let base = ToolSettings { approval_mode: ApprovalMode::AlwaysAsk, ..ToolSettings::default() };
		let yolo = ConnectionState::new(
			ExecHost::new(),
			accepted_hello(grants.clone(), Some(ApprovalMode::Yolo)),
			&base,
			Arc::clone(&authority),
			&policy,
		);
		let inherited = ConnectionState::new(
			ExecHost::new(),
			accepted_hello(grants, None),
			&base,
			authority,
			&policy,
		);
		let effects = Effects {
			exec: Some(omp_tool::ExecEffects { commands: Arc::from([sf!("*")]), network: true }),
			..Effects::empty()
		};

		assert_eq!(
			yolo
				.tool_settings
				.approval_for("yolo", "bash", &effects)
				.policy,
			crate::admission::ApprovalPolicy::Allow
		);
		assert_eq!(
			inherited
				.tool_settings
				.approval_for("inherited", "bash", &effects)
				.policy,
			crate::admission::ApprovalPolicy::Prompt
		);
		assert_eq!(
			base.approval_for("base", "bash", &effects).policy,
			crate::admission::ApprovalPolicy::Prompt
		);
	}

	#[tokio::test]
	async fn standalone_daemon_refuses_a_served_document_socket() {
		let root = tempfile::tempdir().expect("document workspace");
		let scratch = tempfile::tempdir().expect("scratch socket directory");
		let socket = scratch.path().join("doc.sock");

		assert!(
			ensure_document_socket_free(root.path(), &socket)
				.await
				.is_ok(),
			"absent socket must be free"
		);

		let listener = UnixListener::bind(&socket).expect("bind document socket");
		assert!(
			matches!(
				ensure_document_socket_free(root.path(), &socket).await,
				Err(EnvdError::DocumentAuthorityHeldBy { path, holder: None })
					if path == root.path()
			),
			"live authority must refuse a second daemon"
		);

		// A stale socket file without a listener no longer refuses startup.
		drop(listener);
		time::timeout(Duration::from_secs(1), async {
			loop {
				if ensure_document_socket_free(root.path(), &socket)
					.await
					.is_ok()
				{
					break;
				}
				time::sleep(Duration::from_millis(1)).await;
			}
		})
		.await
		.expect("stale socket file did not become free");
	}

	#[test]
	fn document_authority_must_match_the_canonical_environment_root() {
		let environment = tempfile::tempdir().expect("environment root");
		let foreign = tempfile::tempdir().expect("foreign root");
		let matching = Url::from_directory_path(environment.path())
			.expect("environment file URI")
			.to_string();
		let mismatched = Url::from_directory_path(foreign.path())
			.expect("foreign file URI")
			.to_string();

		assert!(validate_document_root(environment.path(), &matching).is_ok());
		assert!(validate_document_root(environment.path(), &mismatched).is_err());
		assert!(validate_document_root(environment.path(), "memory://foreign").is_err());
	}

	#[tokio::test]
	async fn idle_wait_requires_one_continuous_quiet_window() {
		let state = tempfile::tempdir().expect("daemon state");
		let window = Duration::from_millis(30);
		let (env_tx, env_rx) = watch::channel(1);
		let (docs_tx, docs_rx) = watch::channel(2);
		let busy = tokio::spawn(wait_idle(
			env_rx,
			docs_rx,
			1,
			window,
			state.path().to_path_buf(),
			sf!("same-build"),
			ExecHost::new(),
		));
		time::sleep(Duration::from_millis(5)).await;
		assert!(!busy.is_finished(), "busy environment was considered idle");
		env_tx.send_replace(0);
		time::sleep(Duration::from_millis(5)).await;
		assert!(!busy.is_finished(), "external document client was considered idle");
		docs_tx.send_replace(1);
		time::sleep(Duration::from_millis(15)).await;
		assert!(!busy.is_finished(), "idle wait resolved before its full window");
		time::sleep(Duration::from_millis(20)).await;
		busy.await.expect("idle wait task");

		let (env_tx, env_rx) = watch::channel(0);
		let (_docs_tx, docs_rx) = watch::channel(1);
		let reset = tokio::spawn(wait_idle(
			env_rx,
			docs_rx,
			1,
			window,
			state.path().to_path_buf(),
			sf!("same-build"),
			ExecHost::new(),
		));
		time::sleep(Duration::from_millis(15)).await;
		env_tx.send_replace(1);
		task::yield_now().await;
		env_tx.send_replace(0);
		time::sleep(Duration::from_millis(20)).await;
		assert!(!reset.is_finished(), "activity did not reset the idle window");
		time::sleep(Duration::from_millis(15)).await;
		reset.await.expect("reset idle wait task");

		let processes = ExecHost::new();
		processes
			.start_process(env_pb::StartProcess {
				name: String::from("persistent-idle"),
				spec: Some(env_pb::ProcessSpec {
					source: Some(env_pb::Script {
						text: String::from("sleep 0.2"),
						..Default::default()
					}),
					cwd_uri: Url::from_directory_path(state.path())
						.expect("state directory URI")
						.to_string(),
					persist: true,
					..Default::default()
				}),
				..Default::default()
			})
			.await
			.expect("start persistent process");
		let (_env_tx, env_rx) = watch::channel(0);
		let (_docs_tx, docs_rx) = watch::channel(1);
		let persistent = tokio::spawn(wait_idle(
			env_rx,
			docs_rx,
			1,
			window,
			state.path().to_path_buf(),
			sf!("same-build"),
			processes,
		));
		time::sleep(Duration::from_millis(75)).await;
		assert!(!persistent.is_finished(), "live persistent process did not hold the daemon open");
		time::timeout(Duration::from_secs(1), persistent)
			.await
			.expect("idle window did not begin after the persistent process exited")
			.expect("persistent idle task");
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn spawned_document_authority_reports_discovered_lsp_roster() {
		use std::os::unix::fs::PermissionsExt as _;
		let root = tempfile::tempdir().expect("document workspace");
		let project = root.path().canonicalize().expect("canonical root");
		let server = project.join("fake-lsp.sh");
		std::fs::write(&server, "#!/bin/sh\nexit 0\n").expect("fake server");
		std::fs::set_permissions(&server, std::fs::Permissions::from_mode(0o700))
			.expect("chmod fake server");
		std::fs::write(project.join("foo.marker"), b"").expect("marker");
		std::fs::write(
			project.join(".lsp.json"),
			serde_json::to_vec(&serde_json::json!({
				"servers": {
					"fake": {
						"command": server,
						"args": [],
						"fileTypes": [".foo"],
						"rootMarkers": ["foo.marker"],
					}
				}
			}))
			.expect("encode config"),
		)
		.expect("write config");
		let state = tempfile::tempdir().expect("document socket directory");
		let socket = state.path().join("document.sock");
		let (documents, authority) = connect_or_start_docserver(
			&project,
			&socket,
			None,
			true,
			crate::docserver::NativeLspOptions { enabled: true, lazy: true },
			None,
			sf!("test-build"),
		)
		.await
		.expect("spawn document authority");
		let response = documents
			.lsp_status(
				document_pb::LspStatusRequest { reload: false, start: false },
				&CancellationToken::new(),
			)
			.await
			.expect("lsp status");
		let fake = response
			.servers
			.iter()
			.find(|server| server.name == "fake")
			.expect("discovered declaration in roster");
		assert_eq!(fake.stage, document_pb::LspServerStage::Available as i32);
		assert_eq!(fake.file_types, vec![".foo".to_owned()]);
		drop(documents);
		drop(authority);
	}

	#[tokio::test]
	async fn new_build_attach_waits_for_stale_docserver_authority_to_drain() {
		let root = tempfile::tempdir().expect("document workspace");
		let state = tempfile::tempdir().expect("document socket directory");
		let socket = state.path().join("document.sock");
		let old_config = ServerConfig::new(root.path())
			.expect("old document config")
			.with_server_build("old-build");
		assert_eq!(old_config.server_build().as_str(), "old-build");

		let shutdown = CancellationToken::new();
		let serve_shutdown = shutdown.clone();
		let serve_root = root.path().to_path_buf();
		let serve_socket = socket.clone();
		let old_task = tokio::spawn(async move {
			crate::docserver::daemon::serve(
				serve_root,
				daemon::Transport::Socket(serve_socket),
				crate::docserver::daemon::ServeOptions {
					lsp_config_paths: Vec::new(),
					lsp:              crate::docserver::NativeLspOptions {
						enabled: false,
						lazy:    true,
					},
					user_config_root: None,
					shutdown:         Some(serve_shutdown),
					server_build:     old_config.server_build().clone(),
					connections:      None,
				},
			)
			.await
		});
		time::timeout(Duration::from_secs(2), async {
			loop {
				if let Ok(stream) = UnixStream::connect(&socket).await
					&& DocumentHost::connect_uds_stream(&socket, stream)
						.await
						.is_ok()
				{
					break;
				}
				task::yield_now().await;
			}
		})
		.await
		.expect("stale document authority did not become ready");

		let drain = shutdown.clone();
		tokio::spawn(async move {
			time::sleep(Duration::from_millis(100)).await;
			drain.cancel();
		});
		let started = Instant::now();
		let (documents, authority) = connect_or_start_docserver(
			root.path(),
			&socket,
			None,
			false,
			crate::docserver::NativeLspOptions { enabled: false, lazy: true },
			None,
			sf!("new-build"),
		)
		.await
		.expect("new build takes document authority after stale drain");
		assert!(started.elapsed() < Duration::from_secs(5));
		assert_eq!(documents.hello().server_build.as_str(), "new-build");
		assert!(authority.is_some(), "new build did not claim document authority");

		old_task
			.await
			.expect("stale authority task")
			.expect("stale authority shutdown");
		drop(documents);
		drop(authority);
	}

	#[tokio::test]
	async fn document_authority_collision_retries_until_holder_releases() {
		let root = tempfile::tempdir().expect("document workspace");
		let state = tempfile::tempdir().expect("document socket directory");
		let socket = state.path().join("document.sock");
		let old_config = ServerConfig::new(root.path())
			.expect("old document config")
			.with_server_build("old-build");
		let old_authority = old_config.try_lock_authority().expect("old authority");
		tokio::spawn(async move {
			time::sleep(Duration::from_millis(100)).await;
			drop(old_authority);
		});

		let (documents, authority) = connect_or_start_docserver(
			root.path(),
			&socket,
			None,
			false,
			crate::docserver::NativeLspOptions { enabled: false, lazy: true },
			None,
			sf!("new-build"),
		)
		.await
		.expect("new document authority starts after old lock releases");
		assert_eq!(documents.hello().server_build.as_str(), "new-build");
		assert!(authority.is_some());
		drop(documents);
		drop(authority);
	}

	#[tokio::test]
	async fn stale_daemon_does_not_rehost_after_drain() {
		let root = tempfile::tempdir().expect("document workspace");
		let state = tempfile::tempdir().expect("daemon state");
		crate::atomic_replace(&crate::launcher_build_path(state.path()), "new-build")
			.expect("publish replacement build");

		let old_config = ServerConfig::new(root.path())
			.expect("old document config")
			.with_server_build("old-build");
		let old_authority = old_config.try_lock_authority().expect("old authority");
		let socket = state.path().join("document.sock");
		let rehosted = rehost_document_authority(
			root.path(),
			state.path(),
			&socket,
			None,
			crate::docserver::NativeLspOptions { enabled: false, lazy: true },
			None,
			old_config.server_build().clone(),
		)
		.await
		.expect("stale rehost check");
		assert!(rehosted.is_none(), "stale daemon rehosted document authority");
		assert!(
			UnixStream::connect(&socket).await.is_err(),
			"stale daemon published a document socket"
		);

		let (env_tx, env_rx) = watch::channel(1);
		let (_docs_tx, docs_rx) = watch::channel(1);
		let idle = tokio::spawn(wait_idle(
			env_rx,
			docs_rx,
			1,
			Duration::from_secs(60),
			state.path().to_path_buf(),
			old_config.server_build().clone(),
			ExecHost::new(),
		));
		time::sleep(Duration::from_millis(75)).await;
		assert!(!idle.is_finished(), "stale daemon shut down before its client drained");
		env_tx.send_replace(0);
		time::timeout(Duration::from_secs(1), idle)
			.await
			.expect("stale daemon did not shut down after its last client drained")
			.expect("idle task");

		drop(old_authority);
		let new_config = ServerConfig::new(root.path())
			.expect("new document config")
			.with_server_build("new-build");
		let _new_authority = new_config
			.try_lock_authority()
			.expect("stale daemon rehosted document authority after drain");
	}
	#[cfg(target_os = "macos")]
	#[tokio::test]
	async fn remote_exec_approval_amends_only_the_owner_command() {
		if !omp_sandbox::backend_status(omp_sandbox::Backend::Seatbelt).is_available() {
			return;
		}
		let root = tempfile::tempdir().expect("workspace");
		let state = tempfile::tempdir().expect("state");
		fs::create_dir(root.path().join(".git")).expect("protected carve-out");
		let con = Arc::new(Ctx::new());
		let convars = Arc::new(crate::exthost::ConvarControlFactory::new(Arc::clone(&con)));
		let server = Arc::new(
			EnvServer::open_local(
				root.path(),
				state.path(),
				Registry::new(),
				ExtHostConfig::new(
					PathBuf::from("unused"),
					Principal::new(sf!("test-principal"), sf!("Test Principal")),
					sf!("test-session"),
					1,
				),
				&con,
				convars,
				RegistryBridges::default(),
			)
			.await
			.expect("owner server"),
		);
		server.exec.configure_sandbox(
			&SandboxSettings {
				mode: crate::exec_settings::ExecSandboxMode::WorkspaceWrite,
				..SandboxSettings::default()
			},
			root.path(),
		);
		let book = Arc::new(ApprovalBook::new());
		let (route, inbox) = ApprovalRoute::new(Arc::clone(&book), None);
		server.bind_approval_authority(Some(book), Some(route));
		let (client, transport) = EnvClient::in_process(64);
		let owner = Arc::clone(&server);
		let serving = tokio::spawn(async move { owner.serve_in_process(transport).await });
		client
			.hello(pb::ClientHello {
				client: "remote-scoped-amendment".to_owned(),
				schema_rev: omp_proto::SCHEMA_REV,
				..pb::ClientHello::default()
			})
			.await
			.expect("remote hello");
		let approval = tokio::spawn(async move {
			let request = inbox.recv().await.expect("owner approval");
			let reason = request.ticket.reasons.first().expect("scoped reason");
			assert_eq!(reason.kind, "sandbox_amendment");
			assert!(
				reason
					.pattern
					.as_deref()
					.is_some_and(|command| { command == "echo approved > .git/approved.txt" })
			);
			assert!(reason.subject.ends_with(".git"));
			request
				.respond(ApprovalDecision {
					approved:   true,
					scope:      ApprovalScope::Once,
					source:     ApprovalSource::User,
					decided_by: Some(sf!("test approver")),
					reason:     None,
					audited:    false,
				})
				.expect("approve exact scope");
		});
		let opened = client
			.open_session(
				&EnvPath::new(
					Url::from_directory_path(root.path())
						.expect("workspace URI")
						.to_string(),
				)
				.expect("typed workspace URI"),
				pb::OpenSessionRequest::default(),
			)
			.await
			.expect("remote session");
		let mut approved = client
			.exec(pb::ExecRequest {
				session: opened.session.clone(),
				source: Some(pb::Script {
					text: "echo approved > .git/approved.txt".to_owned(),
					..pb::Script::default()
				}),
				..pb::ExecRequest::default()
			})
			.await
			.expect("normal remote request");
		let mut starts = 0;
		let mut output = Vec::new();
		let status = loop {
			match approved
				.next_event()
				.await
				.expect("remote exec event")
				.expect("remote exec stream")
			{
				ClientExecEvent::Started(_) => starts += 1,
				ClientExecEvent::Output(frame) => output.extend_from_slice(&frame.data),
				ClientExecEvent::Exit(exit) => break exit.status.expect("terminal status"),
			}
		};
		approval.await.expect("owner approver");
		assert_eq!(starts, 1);
		assert_eq!(status.outcome, pb::ExecOutcome::Exited as i32);
		assert_eq!(
			fs::read(root.path().join(".git/approved.txt")).expect("approved write"),
			b"approved\n"
		);
		assert!(!String::from_utf8_lossy(&output).contains("rerun with approved scope"));
		assert!(status.diags.iter().any(|diag| {
			diag
				.text
				.contains("sandbox: rerun with approved scope: write")
		}));

		let mut restored = client
			.exec(pb::ExecRequest {
				session: opened.session,
				source: Some(pb::Script {
					text: "echo blocked > .git/blocked.txt".to_owned(),
					..pb::Script::default()
				}),
				..pb::ExecRequest::default()
			})
			.await
			.expect("second normal remote request");
		let restored = loop {
			match restored
				.next_event()
				.await
				.expect("restored event")
				.expect("restored stream")
			{
				ClientExecEvent::Exit(exit) => break exit.status.expect("restored status"),
				ClientExecEvent::Started(_) | ClientExecEvent::Output(_) => {},
			}
		};
		assert_eq!(restored.outcome, pb::ExecOutcome::Denied as i32);
		assert!(!root.path().join(".git/blocked.txt").exists());
		serving.abort();
	}

	#[test]
	fn plan_guard_denies_workspace_mutation_and_exempts_local_artifacts() {
		let effects = Effects {
			documents: Some(omp_tool::DocEffects {
				read:        true,
				write_globs: Arc::from([sf!("**")]),
			}),
			..Effects::empty()
		};
		let policy = InvocationExecutionPolicy {
			tool:           sf!("write"),
			plan:           true,
			plan_yolo:      false,
			core_admission: false,
		};
		assert!(
			policy
				.denial(&effects, br#"{"path":"src/lib.rs","content":"x"}"#)
				.is_some()
		);
		assert!(
			policy
				.denial(&effects, br#"{"path":"local://PLAN.md","content":"x"}"#)
				.is_none()
		);
		assert!(
			policy
				.denial(&effects, br#"{"path":"vault://plans/x","content":"x"}"#)
				.is_none()
		);
	}

	#[test]
	fn plan_yolo_authorizes_exactly_the_tagged_invocation() {
		let effects = Effects {
			exec: Some(omp_tool::ExecEffects { commands: Arc::from([sf!("*")]), network: false }),
			..Effects::empty()
		};
		let yolo = InvocationExecutionPolicy {
			tool:           sf!("bash"),
			plan:           true,
			plan_yolo:      true,
			core_admission: false,
		};
		let plan = InvocationExecutionPolicy {
			tool:           sf!("bash"),
			plan:           true,
			plan_yolo:      false,
			core_admission: false,
		};
		assert!(yolo.denial(&effects, br#"{"command":"touch x"}"#).is_none());
		assert!(plan.denial(&effects, br#"{"command":"touch x"}"#).is_some());
	}
}
